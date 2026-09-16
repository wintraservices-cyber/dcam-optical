-- Run this in Supabase's SQL Editor (Project -> SQL Editor -> New query).
--
-- This extends the original orders-only schema to add a patients table,
-- so intake submissions and orders both link to the same patient record
-- over time, matched by phone number. If you already ran the original
-- schema (orders table only), running this file again is safe -- it uses
-- "if not exists" guards throughout, and the ALTER statement near the
-- bottom only adds the new column if it's missing.

-- ---------------------------------------------------------------------
-- Patients: one row per unique phone number. Name/email are "latest
-- known" values -- updated whenever a newer intake or order comes in
-- with the same phone but different name/email (e.g. a typo fixed, or
-- a nickname vs. full name).
-- ---------------------------------------------------------------------
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name text not null,
  email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists patients_phone_idx on patients (phone);
create index if not exists patients_name_idx on patients (name);

alter table patients enable row level security;

-- ---------------------------------------------------------------------
-- Intake submissions: what the public intake form saves, now that it
-- persists to the database (previously it only sent an email). Linked
-- to a patient record via patient_id.
-- ---------------------------------------------------------------------
create table if not exists intake_submissions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id),

  fname text not null,
  lname text not null,
  phone text not null,
  email text,

  patient_type text,
  reason text,
  pref_date text,
  pref_time text,
  notes text,

  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),

  created_at timestamptz not null default now()
);

create index if not exists intake_patient_id_idx on intake_submissions (patient_id);

-- Adds payment_status to an intake_submissions table that already existed
-- from before payment tracking was added. No-op if already present.
alter table intake_submissions add column if not exists payment_status text not null default 'unpaid';

alter table intake_submissions enable row level security;

-- ---------------------------------------------------------------------
-- Orders: unchanged from the original schema, plus a patient_id link.
-- ---------------------------------------------------------------------
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null,
  order_type text not null default 'rx' check (order_type in ('rx', 'non_rx')),
  rx_subtype text check (rx_subtype in ('CMRX', 'L/O', 'F/O')),
  patient_name text not null,
  tel_no text,
  order_date text,
  due_date text,
  tray_no text,

  rx_r_sph text, rx_r_cyl text, rx_r_axis text, rx_r_prism text, rx_r_base text,
  rx_l_sph text, rx_l_cyl text, rx_l_axis text, rx_l_prism text, rx_l_base text,
  lens_material text,

  add_r text, add_l text,
  seg_ht_r text, seg_ht_l text,
  lens_type text,
  pd_mode text,
  pd_r text, pd_l text,

  item_name text,
  item_qty text,
  item_unit_price text,
  item_line_total text,

  frame text,
  special_instructions text,

  amount text,
  deposit text,
  balance text,

  status text not null default 'ordered' check (status in ('ordered', 'ready', 'claimed')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'paid')),
  taken_by text,

  created_at timestamptz not null default now()
);

-- Adds payment_status to an orders table that already existed from
-- before payment tracking was added. No-op if already present.
alter table orders add column if not exists payment_status text not null default 'unpaid';

-- Adds order_type/item_* columns to an orders table that already existed
-- from before Non-Rx order support was added. No-op if already present.
alter table orders add column if not exists order_type text not null default 'rx';
alter table orders add column if not exists rx_subtype text;
alter table orders add column if not exists item_name text;
alter table orders add column if not exists item_qty text;
alter table orders add column if not exists item_unit_price text;
alter table orders add column if not exists item_line_total text;

-- Adds patient_id to an orders table that already existed from before
-- this patients-linking feature was added. No-op if the column is
-- already there (e.g. on a fresh install where the create table above
-- already included it).
alter table orders add column if not exists patient_id uuid references patients(id);

create index if not exists orders_order_no_idx on orders (order_no);
create index if not exists orders_patient_name_idx on orders (patient_name);
create index if not exists orders_patient_id_idx on orders (patient_id);

alter table orders enable row level security;

-- Row Level Security is enabled on all three tables but with no
-- policies defined. All access goes through serverless functions using
-- the Supabase service role key, which bypasses RLS by design. This
-- just ensures the anon/public API key -- if ever exposed by mistake --
-- can't read or write these tables directly.
