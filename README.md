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
  staff-login.js            Checks staff password, sets session cookie
  staff-logout.js           Clears session cookie
  auth-check.js             Checks whether a request has a valid staff session
  orders.js                  Create/list/update saved orders, linked to a patient (Supabase)
  patient-history.js          Looks up a patient by phone, returns their full history
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
     `/staff-orders.html` and the status dropdown works.
   - Visit `/staff-patient-lookup.html`, search that phone number, confirm
     both the intake submission and the order appear together under one
     patient record.

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

