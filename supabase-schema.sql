-- Run this in Supabase's SQL Editor (Project -> SQL Editor -> New query)
-- to create the orders table used by /api/orders.js.

create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  order_no text not null,
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
  pd_r text, pd_l text,

  frame text,
  special_instructions text,

  amount text,
  deposit text,
  balance text,

  status text not null default 'ordered' check (status in ('ordered', 'ready', 'claimed')),
  taken_by text,

  created_at timestamptz not null default now()
);

-- Speeds up the search-by-order-number-or-name query in /api/orders.js.
create index if not exists orders_order_no_idx on orders (order_no);
create index if not exists orders_patient_name_idx on orders (patient_name);

-- Row Level Security: enabled but with no policies, since all access goes
-- through the serverless function using the service role key (which bypasses
-- RLS by design). This just makes sure the anon/public API key — if ever
-- exposed by mistake — can't read or write this table directly.
alter table orders enable row level security;
