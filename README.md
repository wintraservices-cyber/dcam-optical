# DCAM Optical — Full Site Bundle

Everything needed to deploy the complete DCAM Optical demo: public site,
patient intake form, and the staff-only order/claim system with login and
database.

## What's in this bundle

```
index.html                 Public site (hero, services, AI chat demo, frame quiz, booking)
intake.html                Public patient intake form (pre-visit basics only)
staff-login.html           Staff password gate
staff-orders.html          Staff order list — search, filter, update status
staff-patient-lookup.html  Staff patient search — phone lookup, full intake + order history
order-form.html            Staff order/claim form (Rx grid, saves to database, linked to patient)
api/
  intake.js                Saves intake submissions to the database and emails the practice
  intake-payment.js         Updates an intake submission's payment status (Paid/Unpaid)
  staff-login.js            Checks staff password, sets session cookie
  staff-logout.js           Clears session cookie
  auth-check.js             Checks whether a request has a valid staff session
  orders.js                  Create/list/update saved orders (status + payment), linked to a patient
  patient-history.js          Looks up a patient by phone, returns their full history
  patient-search.js            Autocomplete search — matches patients by name or phone
  next-order-number.js          Suggests the next order number based on existing orders
  _auth.js                     Shared session-cookie logic (not a route itself)
  _supabase.js                  Shared Supabase REST helper (not a route itself)
  _patients.js                   Shared patient find-or-create-by-phone logic (not a route itself)
supabase-schema.sql        Run once in Supabase — creates patients, intake_submissions, orders tables
vercel.json                Minimal Vercel config
README-intake-api.md           Setup for the intake email notification
README-staff-system.md         Setup for staff login + orders database
```

## How the pieces connect

**Public visitor flow:**
`index.html` → clicks "Start intake form" → `intake.html` → submits →
`api/intake.js` emails the front desk. No login needed, no clinical data
collected — just scheduling basics.

**Staff flow:**
`staff-login.html` → enters shared password → `api/staff-login.js` sets a
session cookie → redirected to `staff-orders.html` (list/search past
orders) → clicks "New order" → `order-form.html` → fills in the Rx grid →
"Save order" → `api/orders.js` writes to Supabase → back on
`staff-orders.html`, the new order appears, searchable by name or order
number, with a status dropdown (Ordered / Ready / Claimed).

The staff pages are **not linked from the public site's navigation** —
they're only reachable if you know the URL directly (e.g.
`yoursite.vercel.app/staff-login.html`). That's intentional for now; if you
want them fully hidden from search engines too, add a `robots.txt`
disallowing `/staff-*` — happy to add that if useful.

## Full deployment checklist

1. **Push this bundle to your GitHub repo** (replacing existing files).
2. **Create a Supabase project** (free tier) — see `README-staff-system.md`
   for exact steps. Run `supabase-schema.sql` in Supabase's SQL editor.
3. **Create a Resend account** (free tier) — see `README-intake-api.md` for
   exact steps, to enable the intake form's email notifications.
4. **Add environment variables in Vercel** (Project Settings → Environment
   Variables):

   | Variable | Purpose |
   |---|---|
   | `RESEND_API_KEY` | Sends intake form email notifications |
   | `NOTIFY_EMAIL_TO` | Practice inbox that receives intake submissions |
   | `NOTIFY_EMAIL_FROM` | Verified sending address |
   | `SUPABASE_URL` | Your Supabase project URL — **now required for both the intake form and the staff order system**, since intake submissions save to the database too |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |

   `STAFF_PASSWORD` and `STAFF_SESSION_SECRET` are **not required** —
   staff login currently uses a hardcoded demo password (`dcam-optical`),
   set directly in `api/staff-login.js`. See "Demo mode" in
   `README-staff-system.md` for how to move this to an environment
   variable later.

5. **Redeploy.** Vercel picks up everything under `/api` automatically as
   serverless functions.
6. **Test the full loop:**
   - Visit the public site, submit the intake form with a real-looking
     phone number, confirm the email arrives.
   - Visit `/staff-login.html`, log in with `dcam-optical`, create a test
     order **using the same phone number**, confirm it shows up in
     `/staff-orders.html` and both the status and payment dropdowns work.
   - Visit `/staff-patient-lookup.html`, search that phone number, confirm
     both the intake submission and the order appear together under one
     patient record, and that flipping either one's payment dropdown
     there also sticks (refresh and check it held).

## What's still manual / not yet built

- **No per-staff accounts** — one shared password for all staff, by
  design, for this stage.
- **No edit-existing-order flow** — only new-order-save and status-change
  are wired up.
- **No real booking/calendar sync** — the public intake form now saves to
  the database and emails staff; someone still confirms manually.
- **AI chat demo** on the public site only works inside Claude.ai's own
  viewer, not on the live Vercel deployment (it depends on a
  Claude-app-specific capability with no server-side equivalent here yet).

## Rx vs. Non-Rx orders

`order-form.html` has a toggle at the top — **Rx Order** / **Non-Rx
Order** — since not every optical sale involves a prescription (plano
sunglasses, reading glasses off a rack, frame-only sales, repairs).

- **Rx Order** (default): the full Rx grid (SPH/CYL/AXIS/etc.), lens
  material, Add/Seg Ht/PD — unchanged from the original job-order form.
- **Non-Rx Order**: replaces the Rx grid with item name, quantity, unit
  price, and an auto-calculated line total (which also flows into the
  shared Amount field). No prescription fields shown or required.

Both share the same order number, patient name, date, frame, and
amount/deposit/balance fields, and both save to the same `orders` table
with an `order_type` column (`rx` or `non_rx`) so the orders list and
patient lookup can distinguish them — shown as a small "Rx" / "Non-Rx" tag
next to the order number.

### Rx job sub-type (CMRX / L/O / F/O)

When **Rx Order** is selected, a second row appears at the top of the Rx
section — **Rx job type** — with three choices:

- **CMRX** (Complete Rx) — a full new job: new frame + new lenses. This is
  the default.
- **L/O** (Lenses Only) — existing frame, new lenses ground and fit.
- **F/O** (Frame Only) — new frame, no new lenses.

This is saved as `rx_subtype` alongside `order_type` (`null` for Non-Rx
orders, since the distinction doesn't apply there), and shows in place of
the generic "Rx" tag in the orders list and patient lookup — so staff can
tell at a glance whether a given Rx order was a full job, a lens-only
redo, or a frame-only sale.

## Patient name & order number lookup

The order form no longer relies purely on manual typing for two fields:

- **Patient's name**: as staff type (2+ characters), it queries existing
  patients by name or phone via `api/patient-search.js` and shows a
  dropdown of matches. Picking one auto-fills both Name and Tel. no. from
  that patient's record — arrow keys + Enter work, as does mouse click.
  If nothing matches, staff just keep typing a new name as before;
  nothing blocks manual entry.
- **Job Order #**: format is **`YEAR-TYPE-NNNN`** — `2025-RX-0001` for Rx
  orders, `2025-NRX-0001` for Non-Rx orders. **Rx and Non-Rx each have
  their own independent counter**, both resetting to `0001` at the start
  of each new year. On page load (and whenever the Rx/Non-Rx toggle is
  switched), `api/next-order-number.js` looks at the highest existing
  counter **for the current year and selected type only** and pre-fills
  the next one — e.g. if the last Rx order this year was `2025-RX-0944`,
  it suggests `2025-RX-0945`, regardless of how many Non-Rx orders exist
  in between. Switching the toggle re-fetches the right sequence's next
  number (unless staff have already typed a custom value, which is always
  respected and never overwritten). This is a **suggestion only** —
  nothing is reserved or locked.

Both fail silently and safely if their endpoint is unreachable (e.g.
Supabase misconfigured) — the form still works exactly as a plain manual
entry form in that case, just without the assist.

## Payment status (Paid / Unpaid)

Both intake submissions and orders now carry their own `payment_status`
(`unpaid` or `paid`, defaulting to `unpaid`) — tracked independently,
since a patient's check-up visit fee and their eyewear order are
genuinely separate charges that may be settled at different times.

This is **staff bookkeeping only** — no online payment is collected or
processed anywhere in this system. It exists so staff can mark something
as paid in-office (cash, card terminal, GCash, whatever they actually use)
and have that reflected across the tools they already use:

- **`order-form.html`** — a Paid/Unpaid toggle sits under the Balance
  field, defaulting to Unpaid on a new order.
- **`staff-orders.html`** — a "Payment" column with an inline dropdown,
  right next to the existing Ordered/Ready/Claimed status dropdown.
  Updating it calls `api/orders.js` (PATCH), which now accepts `status`,
  `payment_status`, or both in the same request.
- **`staff-patient-lookup.html`** — both intake requests and orders each
  show their own Paid/Unpaid dropdown, updatable right from that view.
  Intake payment updates go through the new `api/intake-payment.js`
  endpoint (a separate table from orders, so a separate small endpoint).

If DCAM later wants real online payment collection (card, GCash, etc.),
that's a materially different feature — it involves a payment gateway
integration and PCI-adjacent compliance considerations that this
staff-only status flag deliberately does not take on.

## Patient linking (intake + orders + history)

Intake submissions and staff orders are now linked to a shared `patients`
record, matched by **phone number** — the same phone number used on an
intake form and later on an order will resolve to the same patient, so
staff can look up a person's full history in one place.

- `supabase-schema.sql` now creates three tables: `patients`,
  `intake_submissions`, and `orders` (the latter two both reference
  `patients` via `patient_id`).
- `api/_patients.js` is the shared matching logic — both `api/intake.js`
  and `api/orders.js` call it on save.
- `api/patient-history.js` returns a patient's full intake + order history
  given a phone number.
- `staff-patient-lookup.html` is the staff page for this — search a phone
  number, see everything that patient has ever submitted or ordered.

**Matching is phone-only, normalized loosely** (strips spaces/dashes/
parens, keeps digits and a leading `+`). It is not full E.164 validation —
if the same person is entered with genuinely different phone numbers
(e.g. a new SIM), they'll show up as two separate patient records. There's
no manual "merge patients" tool yet; that's a reasonable next addition if
duplicate records become a real problem in practice.

If you already deployed the orders-only schema before this update, running
the new `supabase-schema.sql` again is safe — it only adds what's missing
(new tables, and a `patient_id` column added to the existing `orders`
table via `alter table ... add column if not exists`).

