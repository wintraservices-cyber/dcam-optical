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

-- Adds updated_at to an orders table that already existed from before
-- order editing was added. The full-edit and status/payment-status
-- update handlers in api/orders.js have always written to this column,
-- but it was never actually defined in the create table above -- this
-- went unnoticed until PostgREST started rejecting the write outright
-- (PGRST204: "Could not find the 'updated_at' column of 'orders' in
-- the schema cache"). No-op if already present.
alter table orders add column if not exists updated_at timestamptz;

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

-- ---------------------------------------------------------------------
-- Individual staff accounts, replacing the single shared password.
-- Passwords are stored as scrypt hashes (salt + hash, both hex), never
-- in plaintext. `active` lets an account be revoked without deleting
-- it (preserves any audit trail tied to that user's id). `role` is
-- either 'admin' (can manage staff accounts, business info, and Rx
-- ranges via Settings) or 'staff' (everyday order/patient/catalog work,
-- no access to Settings).
-- ---------------------------------------------------------------------
create table if not exists staff_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text,
  password_hash text not null,
  password_salt text not null,
  role text not null default 'staff' check (role in ('admin', 'staff')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_login_at timestamptz
);

create index if not exists staff_users_username_idx on staff_users (lower(username));

alter table staff_users enable row level security;

-- ---------------------------------------------------------------------
-- App-wide settings: a small key/value store for things staff should be
-- able to change from within the app itself (Rx dropdown ranges,
-- business name/address/contact/hours, etc.) without a code deploy.
-- One row per key; `value` holds JSON so a single key can carry a
-- structured value (e.g. an Rx range's start/end/step together).
-- ---------------------------------------------------------------------
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table app_settings enable row level security;

-- Fixes a gap where the orders.rx_subtype check constraint never
-- included 'CL' (Contacts) after that sub-type was added to the order
-- form -- without this, saving a contacts order fails at the database
-- level even though the app already validates 'CL' correctly. Finds
-- whatever check constraint currently covers rx_subtype (by name may
-- vary) and replaces it, rather than assuming a specific name.
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'orders'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%rx_subtype%';

  if constraint_name is not null then
    execute format('alter table orders drop constraint %I', constraint_name);
  end if;

  alter table orders add constraint orders_rx_subtype_check check (rx_subtype in ('CMRX', 'L/O', 'F/O', 'CL'));
end $$;

-- ---------------------------------------------------------------------
-- Payment audit trail.
--
-- Two problems with the paper-log replacement so far: (1) "taken_by" on
-- both orders and balance_payments was a free-text field the staff
-- member typed in themselves (or left blank) -- not tied to who was
-- actually logged in, so it can't be trusted as a record of who
-- collected a payment; (2) editing an order (full_edit) or changing its
-- status/payment_status overwrites the row in place with no trace of
-- what it looked like before, so a correction after the fact is
-- indistinguishable from the original entry.
--
-- Fix for (1) is server-side, in api/orders.js and
-- api/balance-payments.js -- taken_by/created_by/updated_by are now
-- always set from the authenticated session, never from client input.
-- This table is the fix for (2): one row per order create/status
-- change/payment edit/full edit, capturing who did it, when, and a
-- before/after snapshot of whatever fields changed.
-- ---------------------------------------------------------------------
create table if not exists order_audit_log (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  order_no text not null,
  action text not null check (action in ('created', 'status_change', 'payment_status_change', 'full_edit', 'balance_payment')),
  changed_by text not null,
  changes jsonb,
  created_at timestamptz not null default now()
);

create index if not exists order_audit_log_order_id_idx on order_audit_log (order_id);
create index if not exists order_audit_log_created_at_idx on order_audit_log (created_at);

alter table order_audit_log enable row level security;

-- Who created/last edited an order, taken from the authenticated
-- session rather than free text. created_by is set once at insert;
-- updated_by is overwritten on every full edit or status change.
alter table orders add column if not exists created_by text;
alter table orders add column if not exists updated_by text;

-- ---------------------------------------------------------------------
-- Adds a "Partial" payment status alongside Unpaid/Paid -- staff need
-- to record that some money has come in against an order (a deposit,
-- one balance payment of several) without it counting as either fully
-- unpaid or fully paid. Uses the same find-and-replace pattern as the
-- rx_subtype fix above, since the constraint's name may vary.
-- ---------------------------------------------------------------------
do $$
declare
  constraint_name text;
begin
  select con.conname into constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'orders'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%payment_status%';

  if constraint_name is not null then
    execute format('alter table orders drop constraint %I', constraint_name);
  end if;

  alter table orders add constraint orders_payment_status_check check (payment_status in ('unpaid', 'partial', 'paid'));
end $$;

-- ---------------------------------------------------------------------
-- AI usage + cost log. One row per assistant reply (website chat or
-- staff assistant), written by lib/ai-usage.js with the token counts the
-- Claude API reported and an estimated USD cost at the time of the call.
-- Read in Settings -> AI assistant -> Usage & cost.
-- ---------------------------------------------------------------------
create table if not exists ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  channel text not null check (channel in ('website', 'staff')),
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  api_calls integer not null default 1,
  tool_calls integer not null default 0,
  cost_usd numeric(12,6) not null default 0,
  username text,
  role text
);

create index if not exists ai_usage_log_created_idx on ai_usage_log (created_at);

-- Test-mode replies (free sample answers, no AI call) are logged with
-- test = true and $0 cost, and excluded from the usage/cost totals.
alter table ai_usage_log add column if not exists test boolean not null default false;

alter table ai_usage_log enable row level security;

-- Daily totals per channel (real AI usage only -- Test-mode rows are
-- excluded), by Manila calendar day. Both dates optional
-- (null = open-ended), so (null, null) gives all-time. Aggregating in SQL
-- avoids Supabase's 1,000-row API cap on large logs.
create or replace function ai_usage_daily(p_from date default null, p_to date default null)
returns table (
  day date,
  channel text,
  messages bigint,
  api_calls bigint,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric
)
language sql
stable
as $$
  select
    (created_at at time zone 'Asia/Manila')::date as day,
    channel,
    count(*) as messages,
    coalesce(sum(api_calls), 0) as api_calls,
    coalesce(sum(input_tokens), 0) as input_tokens,
    coalesce(sum(output_tokens), 0) as output_tokens,
    coalesce(sum(cost_usd), 0) as cost_usd
  from ai_usage_log
  where not test
    and (p_from is null or (created_at at time zone 'Asia/Manila')::date >= p_from)
    and (p_to is null or (created_at at time zone 'Asia/Manila')::date <= p_to)
  group by 1, 2
  order by 1 desc, 2;
$$;

-- ---------------------------------------------------------------------
-- Questions the AI assistants couldn't answer from the clinic's info.
-- Only written when Settings -> AI assistant -> "Log questions it
-- couldn't answer" is on (off by default). Phone numbers and emails are
-- stripped before saving; repeats bump times_asked; rows not asked again
-- for 90 days are deleted automatically by lib/ai-knowledge.js.
-- ---------------------------------------------------------------------
create table if not exists ai_unanswered (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_asked_at timestamptz not null default now(),
  channel text not null check (channel in ('website', 'staff')),
  question text not null,
  question_norm text not null,
  times_asked integer not null default 1,
  asked_by text,
  asked_by_role text,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by text,
  resolved_at timestamptz
);

create index if not exists ai_unanswered_open_idx on ai_unanswered (status, channel, question_norm);
create index if not exists ai_unanswered_last_idx on ai_unanswered (last_asked_at);

alter table ai_unanswered enable row level security;

-- ---------------------------------------------------------------------
-- Customer order-status lookups ("are my glasses ready?"): one row per
-- attempt, used to block guessing (5 failed tries per visitor per 15
-- min, 8 per order number per hour). Stores only hashed IP / order
-- number, never the numbers themselves. Rows older than a day are
-- cleared automatically by lib/order-status.js.
-- ---------------------------------------------------------------------
create table if not exists order_lookup_attempts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ip_hash text not null,
  order_hash text not null,
  success boolean not null default false
);

create index if not exists order_lookup_attempts_ip_idx on order_lookup_attempts (ip_hash, created_at);
create index if not exists order_lookup_attempts_order_idx on order_lookup_attempts (order_hash, created_at);

alter table order_lookup_attempts enable row level security;

-- ---------------------------------------------------------------------
-- Business expenses (petty cash, payroll advances, supplies, etc.).
-- Logged by admin by default; whether ordinary staff can also log
-- entries is controlled by the app_settings 'expense_access' key
-- ({staff_enabled: true|false}), checked in api/expenses.js -- not
-- enforced here, since Postgres has no notion of the app's staff/admin
-- roles. `type` and `details` are free text (e.g. "PR" / "Doc Kathy",
-- "PAYMENT" / "Checkbook - 2 booklets") rather than a fixed enum, since
-- the clinic's own categories may not be known in advance; the API
-- still returns distinct past `type` values so the entry form can
-- offer them as autocomplete suggestions.
-- ---------------------------------------------------------------------
create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  expense_date date not null,
  type text not null,
  details text,
  amount numeric(12,2) not null check (amount > 0),
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists expenses_date_idx on expenses (expense_date desc);

alter table expenses enable row level security;

-- ---------------------------------------------------------------------
-- Cash/check withdrawals (payroll, owner draws, etc.) -- admin-only,
-- unlike expenses which staff can optionally be given access to. Source
-- is a fixed Cash/Check choice (not free text like expenses' `type`)
-- because the amount is always attributed to exactly one of the Cash or
-- Checking columns on the withdrawals list, and a fixed pair of sources
-- keeps that split unambiguous.
-- ---------------------------------------------------------------------
create table if not exists withdrawals (
  id uuid primary key default gen_random_uuid(),
  withdrawal_date date not null,
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  source text not null check (source in ('cash', 'check')),
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists withdrawals_date_idx on withdrawals (withdrawal_date desc);

alter table withdrawals enable row level security;

-- ---------------------------------------------------------------------
-- Soft delete for orders and patients. Any logged-in staff member can
-- soft-delete (sets deleted_at/deleted_by, row stays in place); only an
-- admin can restore (clears both columns) or permanently delete (a real
-- DELETE) from the Trash tab on Settings. Every other read path in the
-- app (order lists, patient lookup, reports, the staff AI assistant,
-- balance payments, intake linking, order-number suggestions) filters
-- deleted_at is null so a soft-deleted row disappears everywhere except
-- Trash, without needing a schema change anywhere else.
-- ---------------------------------------------------------------------
alter table orders add column if not exists deleted_at timestamptz;
alter table orders add column if not exists deleted_by text;
create index if not exists orders_deleted_at_idx on orders (deleted_at);

alter table patients add column if not exists deleted_at timestamptz;
alter table patients add column if not exists deleted_by text;
create index if not exists patients_deleted_at_idx on patients (deleted_at);


-- ---------------------------------------------------------------------
-- Intake status for the staff/admin Dashboard's "new intakes" queue.
-- Every intake starts 'new' (needs a look) and any logged-in staff
-- member can mark it 'contacted' once they've called the patient and
-- either booked them in or resolved the inquiry some other way. This is
-- deliberately manual and separate from whether an order exists yet --
-- an intake can be marked contacted without an order (patient
-- rescheduled, didn't qualify, etc.), and the dashboard cross-references
-- orders separately just as a hint, not as the dismiss mechanism.
-- ---------------------------------------------------------------------
alter table intake_submissions add column if not exists status text not null default 'new' check (status in ('new', 'contacted'));
create index if not exists intake_status_idx on intake_submissions (status);

-- ---------------------------------------------------------------------
-- Daily Cash Reconciliation (CashFlow). One row per calendar day,
-- tracking cash/Gcash/checking balances the way the client's manual
-- spreadsheet does: beginning balances for the day, that day's activity,
-- and ending balances -- which become the NEXT day's beginning balances.
--
-- The very first row ever created has no prior day to carry from, so its
-- beginning_* fields are entered once by an admin (the "seed"); every
-- day after that has its beginning_* fields copied automatically from
-- the previous day's ending_* fields when that previous day is closed.
--
-- closed_at is the concurrency guard that makes this safe: a day with
-- closed_at = null is still a draft (its activity fields are computed
-- live from orders/expenses/withdrawals on every read, not stored) and
-- can be closed at most once. Once closed_at is set, every field on
-- that row is a frozen snapshot -- it is never recomputed again, even if
-- someone edits an old order afterward, exactly like a spreadsheet tab
-- nobody reopens. This is what keeps one bad edit from silently
-- cascading through every day since.
-- ---------------------------------------------------------------------
create table if not exists cash_positions (
  id uuid primary key default gen_random_uuid(),
  position_date date not null unique,

  beginning_cash numeric not null default 0,
  beginning_gcash numeric not null default 0,
  beginning_checking numeric not null default 0,
  beginning_outstanding numeric not null default 0,

  -- Stored only once closed -- see comment above.
  cash_sales numeric not null default 0,
  gcash_sales numeric not null default 0,
  total_expenses numeric not null default 0,
  total_withdrawals_cash numeric not null default 0,
  total_withdrawals_checking numeric not null default 0,
  outstanding_created numeric not null default 0,
  outstanding_collected numeric not null default 0,

  ending_cash numeric not null default 0,
  ending_gcash numeric not null default 0,
  ending_checking numeric not null default 0,
  ending_outstanding numeric not null default 0,

  closed_at timestamptz,
  closed_by text,

  created_at timestamptz not null default now()
);

create index if not exists cash_positions_date_idx on cash_positions (position_date desc);

alter table cash_positions enable row level security;

-- ---------------------------------------------------------------------
-- Staff account profile details: email and phone, so an account can be
-- reached for things like a "reset your password" email or an SMS
-- notification later on. Both are optional and unique-if-set -- two
-- staff accounts sharing one phone/email would make a future
-- notification or reset flow ambiguous about which account it's for.
-- Safe to re-run: "if not exists" on the columns, and the two indexes
-- only enforce uniqueness among non-null values (a partial unique
-- index), so any number of accounts can still leave these blank.
-- ---------------------------------------------------------------------
alter table staff_users add column if not exists email text;
alter table staff_users add column if not exists phone text;

create unique index if not exists staff_users_email_idx on staff_users (lower(email)) where email is not null;
create unique index if not exists staff_users_phone_idx on staff_users (phone) where phone is not null;

-- ---------------------------------------------------------------------
-- Expense payment source (Cash / Check / Gcash), matching how
-- withdrawals already track a tender. Defaults every existing and
-- future row to 'cash' -- that was the only real option before this
-- column existed, so backfilling it as 'cash' keeps old expenses
-- accurate rather than leaving them blank. Cash Position (see
-- computeDayActivity in api/expenses.js) now splits an expense's amount
-- out of the matching tender (cash/checking/gcash) instead of always
-- assuming cash.
-- ---------------------------------------------------------------------
alter table expenses add column if not exists source text not null default 'cash' check (source in ('cash', 'check', 'gcash'));
