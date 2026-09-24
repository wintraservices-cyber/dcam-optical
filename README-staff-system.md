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
- **One shared password, not individual accounts.** Anyone with the
  password can see and edit all orders; there's no per-staff audit trail
  (no record of *which* staff member created or edited a given order,
  beyond the free-text "By:" field they type in themselves).
- **No edit-existing-order flow yet.** The form saves new orders; editing a
  previously saved order (beyond changing its status) isn't wired up. That's
  a reasonable next addition once this is in daily use and you know what
  edits actually come up.
- **No automatic sync between the printed slip and the saved record if
  someone edits after printing.** Print and Save are two independent
  actions on the same filled-in form.

These are natural next steps once the basic login + database loop is
running smoothly in practice.
