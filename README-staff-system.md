# Staff Login + Orders Database — Setup

This adds a shared staff login and a real database for saved orders, on top
of the printable order form.

## What's new

```
your-repo/
  order-form.html       (updated — now saves to DB, requires login)
  staff-login.html      (new — password gate)
  staff-orders.html     (new — search/list saved orders)
  supabase-schema.sql   (new — run once in Supabase)
  api/
    _auth.js            (shared session-cookie helper)
    _supabase.js         (shared Supabase REST helper)
    staff-login.js       (POST — checks password, sets session cookie)
    staff-logout.js      (POST — clears session cookie)
    auth-check.js        (GET — is the current session valid?)
    orders.js            (GET/POST/PATCH — list, create, update orders)
```

## 1. Create a Supabase project (free tier)

1. Go to https://supabase.com and sign up / create a new project.
2. Once it's provisioned, go to **Project Settings → API**. You'll need:
   - **Project URL** (e.g. `https://xxxxx.supabase.co`)
   - **service_role key** (under "Project API keys" — NOT the `anon` key;
     the service role key bypasses row-level security, which is what lets
     our serverless functions read/write freely while the table itself
     stays locked down from public access)

   ⚠️ The service role key is powerful — never put it in front-end code or
   commit it to a public repo. It only goes into Vercel's environment
   variables (server-side only).

## 2. Create the `orders` table

1. In Supabase: **SQL Editor → New query**.
2. Paste the contents of `supabase-schema.sql` (included in this repo) and
   run it. This creates the `orders` table with all the Rx/order fields and
   enables row-level security with no public policies (so only the service
   role key — used server-side — can touch it).

## 3. Login setup — demo mode (no environment variables needed)

For quick demo purposes, the staff login password is **hardcoded directly
in `api/staff-login.js`**, set to:

```
dcam-optical
```

This means staff login works immediately after deploying, with zero
Vercel dashboard configuration. No environment variables required for
this part.

**When you're ready to move past demo mode:** set a `STAFF_PASSWORD`
environment variable in Vercel (Project Settings → Environment
Variables) to something less guessable — it automatically overrides the
hardcoded value, no code changes needed. The same applies to
`STAFF_SESSION_SECRET` (used to sign session cookies), which also has a
hardcoded demo fallback in `lib/auth.js`.

## 3b. Environment variables (only needed for email + database)

**Project Settings → Environment Variables**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase service role key |

Apply to all environments, then **redeploy**.

## 4. How staff use it

1. Go to `yoursite.vercel.app/staff-login.html`
2. Enter the password: `dcam-optical`
3. Redirects to `staff-orders.html` — a searchable list of all saved orders,
   filterable by status (Ordered / Ready / Claimed)
4. Click **New order** to open `order-form.html` — fill in the Rx grid,
   frame, amounts, etc.
5. **Save order** writes it to the database. **Print order + stub** still
   works exactly as before, independent of saving.
6. Back on the orders list, staff can update an order's status from a
   dropdown right in the table (e.g. mark "Ready" once lenses arrive, then
   "Claimed" when the patient picks up).

The session lasts 12 hours, then requires logging in again.

## What this does NOT do (yet)

- **Password is hardcoded in the source code, not a secret.** Anyone who
  can view the deployed source (or this repo, if it's public) can read
  the staff password directly. This is fine for a demo behind a private
  repo, but is not real access control — before this handles actual
  patient data, move the password to a `STAFF_PASSWORD` environment
  variable (see section 3 above) so it isn't sitting in version control.
- **No automatic sync between the printed slip and the saved record if
  someone edits after printing.** Print and Save are two independent
  actions on the same filled-in form.

> The two bullets above about a single shared password and no
> edit-existing-order flow are no longer accurate as of the individual
> staff accounts, Settings page, and full order-editing features — see
> "Payment audit trail" below for how staff identity is now tracked.

## Payment audit trail

Every staff account has its own login (Settings → Staff Accounts,
admin-only), and that identity is what the system trusts for "who did
this" — never a free-text field staff type in themselves.

- **`taken_by`** (the "By:" field on the printed order slip, and the
  field on `balance_payments`) is always set server-side from the
  logged-in session. It's read-only in the order form UI and ignored if
  a client sends a different value.
- **`orders.created_by`** / **`orders.updated_by`** record who created
  the order and who last changed it (status, payment status, or a full
  edit), also from the session.
- **`order_audit_log`** table has one row per create / status change /
  payment-status change / full edit / balance payment, each with a
  before → after diff of whatever fields actually changed (see
  `lib/audit.js`).
- Opening an existing order in `order-form.html?id=...` shows a
  collapsible "Payment & edit history" panel above the slip — the full
  timeline of edits and payments for that order, in one place, so a
  correction made after the fact is visible rather than silently
  overwriting the original entry.

These are natural next steps once the basic login + database loop is
running smoothly in practice.

## Coming Soon / Maintenance page

Settings → **Website** has a switch that puts the public home page behind a teaser page (`/coming-soon`), either **Coming soon** or **Maintenance**. It saves as soon as it's flipped; visitors switch over within ~30 seconds (Vercel edge cache).

- Stored in `app_settings` under `site_mode` — no schema change needed.
- `index.html` loads `site-gate.js` first; it asks `GET /api/settings?view=site_mode` (public, no login) and redirects to `/coming-soon` when the switch is on. If the check fails, the page just shows.
- Staff pages, staff login and `intake.html` are never gated.
- **Preview PIN:** the teaser's "View site" button checks the PIN via `POST /api/settings?action=site_preview`. The PIN is hashed with scrypt (same as staff passwords) and never returned to any browser; wrong attempts are slowed down. A correct PIN sets a flag in that browser so it sees the real site, with an "Exit preview" pill.
- **Facebook link:** set it in the same card; the teaser's Facebook icon stays inactive until it's filled in.
- `/coming-soon?view=1` shows the teaser even when the site is live; `?mode=maintenance` previews the maintenance wording.
