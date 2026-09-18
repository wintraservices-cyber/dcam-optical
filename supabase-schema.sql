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

-- ---------------------------------------------------------------------
-- Order items: multiple line items per Non-Rx order (e.g. nosepads +
-- lens solution + a chain, all on one order number/receipt). The four
-- item_* columns on the orders table above remain for backward
-- compatibility with single-item orders saved before this table
-- existed; new Non-Rx orders with more than one item store their rows
-- here instead, keyed by order_id.
-- ---------------------------------------------------------------------
create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,

  item_name text not null,
  item_qty text,
  item_unit_price text,
  item_line_total text,

  sort_order integer not null default 0,

  created_at timestamptz not null default now()
);

create index if not exists order_items_order_id_idx on order_items (order_id);

alter table order_items enable row level security;

-- Row Level Security is enabled on all four tables but with no
-- policies defined. All access goes through serverless functions using
-- the Supabase service role key, which bypasses RLS by design. This
-- just ensures the anon/public API key -- if ever exposed by mistake --
-- can't read or write these tables directly.


-- ---------------------------------------------------------------------
-- Catalog items: staff-managed list of lenses and frames, each with its
-- own code, name, and price. Powers the dropdowns on the order form
-- (frame + lens type) so staff pick from a maintained list instead of
-- typing free text, and the price can auto-fill into the order.
-- Fully staff-editable via the staff-catalog.html admin page.
-- ---------------------------------------------------------------------
create table if not exists catalog_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('lens', 'frame')),
  code text,
  name text not null,
  price text,
  notes text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists catalog_items_category_idx on catalog_items (category);
create index if not exists catalog_items_active_idx on catalog_items (active);

alter table catalog_items enable row level security;

-- ---------------------------------------------------------------------
-- Catalog inventory fields: brand name, description, base cost, and
-- quantity on hand. `name` remains the display/search label (what
-- shows in the order-form datalist); `brand` and `description` are
-- additional structured fields for the catalog admin screen.
-- `base_price` is the item's standalone list price; the order form's
-- existing `price` field is kept as the auto-fill "sale price" default
-- but can be overridden per sale, matching how sale price already
-- differs from catalog price in practice.
-- `qty` decrements automatically when a catalog-linked item is sold
-- on an order (see order_items.catalog_item_id below) -- no separate
-- sales log; the order itself is the record of the sale (job number,
-- date, and sale price already live on the order/order_items rows).
-- ---------------------------------------------------------------------
alter table catalog_items add column if not exists brand text;
alter table catalog_items add column if not exists description text;
alter table catalog_items add column if not exists base_price text;
alter table catalog_items add column if not exists qty integer not null default 0;

-- Links a sold line item back to the catalog entry it came from, so
-- stock can be decremented on sale. Nullable -- free-text items typed
-- without picking a catalog match simply have no link, same as before
-- this feature existed.
alter table order_items add column if not exists catalog_item_id uuid references catalog_items(id);

-- Atomic stock decrement, called via PostgREST RPC when a catalog-linked
-- item is sold on an order. Doing this as a single SQL statement avoids
-- a read-then-write race if two staff sell the last units of the same
-- item at nearly the same time. Floors at 0 rather than going negative
-- -- a sale that outpaces recorded stock still saves; it just won't
-- show a negative quantity on the catalog screen.
create or replace function decrement_catalog_stock(item_id uuid, sold_qty integer)
returns void as $$
begin
  update catalog_items
  set qty = greatest(0, qty - sold_qty), updated_at = now()
  where id = item_id;
end;
$$ language plpgsql;

-- Payment method tracking: how an order's payment was collected, and,
-- for split payments, how much came in via each method. Mirrors the
-- staff's existing paper log (Payment Method / Cash In / Gcash-CC /
-- Split Cash / Split Gcash columns) rather than introducing new
-- concepts -- 'cash' and 'gcash_cc' are whole-amount methods, 'split'
-- means both split_cash and split_gcash apply and (together) should
-- equal that payment's amount.
alter table orders add column if not exists payment_method text default 'cash' check (payment_method in ('cash', 'gcash_cc', 'split'));
alter table orders add column if not exists split_cash text;
alter table orders add column if not exists split_gcash text;

-- ---------------------------------------------------------------------
-- Balance payments: logging a payment against an EXISTING job number
-- (e.g. staff's paper-log "BALANCE" rows) without editing/duplicating
-- the original order. Each row here is one payment event; the order's
-- own balance/payment_status are still the source of truth for "how
-- much is owed right now" and get updated when a balance payment is
-- recorded (see api/balance-payments.js).
-- ---------------------------------------------------------------------
create table if not exists balance_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  order_no text not null,
  amount text not null,
  payment_method text not null default 'cash' check (payment_method in ('cash', 'gcash_cc', 'split')),
  split_cash text,
  split_gcash text,
  taken_by text,
  created_at timestamptz not null default now()
);

create index if not exists balance_payments_order_id_idx on balance_payments (order_id);

alter table balance_payments enable row level security;
