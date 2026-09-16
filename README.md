# DCAM Optical — Full Site Bundle

Everything needed to deploy the complete DCAM Optical demo: public site,
patient intake form, and the staff-only order/claim system with login and
database.

## What's in this bundle

```
index.html            Public site (hero, services, AI chat demo, frame quiz, booking)
intake.html           Public patient intake form (pre-visit basics only)
staff-login.html      Staff password gate
staff-orders.html     Staff order list — search, filter, update status
order-form.html       Staff order/claim form (Rx grid, saves to database)
api/
  intake.js           Emails intake form submissions to the practice
  staff-login.js       Checks staff password, sets session cookie
  staff-logout.js      Clears session cookie
  auth-check.js        Checks whether a request has a valid staff session
  orders.js             Create/list/update saved orders (Supabase)
  _auth.js              Shared session-cookie logic (not a route itself)
  _supabase.js           Shared Supabase REST helper (not a route itself)
supabase-schema.sql   Run once in Supabase to create the orders table
vercel.json           Minimal Vercel config
README-intake-api.md      Setup for the intake email notification
README-staff-system.md    Setup for staff login + orders database
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
   | `SUPABASE_URL` | Your Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-side only) |
   | `STAFF_PASSWORD` | Shared password staff use to log in |
   | `STAFF_SESSION_SECRET` | Random string to sign session cookies |

5. **Redeploy.** Vercel picks up everything under `/api` automatically as
   serverless functions.
6. **Test the full loop:**
   - Visit the public site, submit the intake form, confirm the email
     arrives.
   - Visit `/staff-login.html`, log in, create a test order, confirm it
     shows up in `/staff-orders.html` and the status dropdown works.

## What's still manual / not yet built

- **No per-staff accounts** — one shared password for all staff, by
  design, for this stage.
- **No edit-existing-order flow** — only new-order-save and status-change
  are wired up.
- **No real booking/calendar sync** — the public intake form emails staff;
  someone still confirms manually.
- **AI chat demo** on the public site only works inside Claude.ai's own
  viewer, not on the live Vercel deployment (it depends on a
  Claude-app-specific capability with no server-side equivalent here yet).

Each of these is a reasonable next increment once the current pieces are
in daily use and any real gaps become clear.
