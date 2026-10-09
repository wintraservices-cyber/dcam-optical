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
   | `ANTHROPIC_API_KEY` | Powers the public "Ask us anything" assistant (`api/chat.js`). Without it the chat politely says it isn't switched on yet. |
   | `ANTHROPIC_MODEL` | Optional. Defaults to `claude-haiku-4-5-20251001` (fast, low cost). |

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
- **Non-Rx Order**: replaces the Rx grid with a **repeatable item
  list** — one order can hold multiple products (e.g. nosepads + lens
  solution + a chain), each with its own name, quantity, unit price, and
  auto-calculated line total. An "+ Add item" button adds more rows, each
  with a remove (×) button; at least one row always stays on screen. A
  running "Order total (items)" sums every row and mirrors into the
  shared Amount field (still editable/overridable). No prescription
  fields shown or required.

Multi-item orders are stored in their own `order_items` table (one row
per item, linked to the parent order), rather than crammed into columns
on the `orders` table — see "Multi-item orders" below for the schema and
API details.

**Layout also changes with the toggle.** Rx orders keep the original
two-column slip: a job order on the left, a matching claim stub on the
right (with the "not claimed within 60 days" forfeiture notice) — this
makes sense for a fabrication job the patient picks up later. Non-Rx
orders drop the claim stub entirely and collapse to a **single full-width
receipt-style layout**, since a straightforward retail sale (nosepads,
lens solution, sunglasses off the rack) has nothing to "claim" — the
patient takes it home immediately. The shared Amount/Deposit/Balance and
Payment status fields live on the order side now (not inside the claim
stub), so they're present and identical in both layouts.

Both order types share the same order number, patient name, date, frame,
and amount/deposit/balance fields, and both save to the same `orders`
table with an `order_type` column (`rx` or `non_rx`) so the orders list
and patient lookup can distinguish them — shown as a small "Rx" / "Non-Rx" tag
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
- **Job Order #**: Rx and Non-Rx use **different formats with different
  reset periods**:
  - **Rx**: `YYYY-NNNN` (e.g. `2025-0001`) — counter resets **yearly**.
  - **Non-Rx**: `YYYY-MM-NNNN` (e.g. `2025-01-0001`) — counter resets
    **monthly**. February's Non-Rx orders start back at `2025-02-0001`
    regardless of how high January's counter reached.

  The two counters are fully independent of each other — Rx orders never
  affect the Non-Rx sequence and vice versa, and the formats are
  distinguishable by structure alone (no letter prefix needed: Non-Rx
  always has the extra `-MM-` segment Rx doesn't).

  On page load (and whenever the Rx/Non-Rx toggle is switched),
  `api/next-order-number.js` looks at the highest existing counter for
  the current period (year for Rx, year+month for Non-Rx) and pre-fills
  the next one. Switching the toggle re-fetches the right sequence's next
  number (unless staff have already typed a custom value, which is
  always respected and never overwritten). This is a **suggestion
  only** — nothing is reserved or locked.

Both fail silently and safely if their endpoint is unreachable (e.g.
Supabase misconfigured) — the form still works exactly as a plain manual
entry form in that case, just without the assist.

## Multi-item orders (order_items table)

Non-Rx orders can hold more than one line item under a single order
number — like a receipt with several products. This is stored as a
separate `order_items` table rather than extra columns on `orders`:

```sql
order_items
  id            uuid (primary key)
  order_id      uuid (references orders.id, on delete cascade)
  item_name     text
  item_qty      text
  item_unit_price   text
  item_line_total   text
  sort_order    integer   -- preserves the order rows were entered in
  created_at    timestamptz
```

- **Saving**: `api/orders.js`'s `createOrder` accepts an `items` array in
  the request body. It saves the parent order first, then inserts all
  item rows in one batch, linked by the new order's id. If the item
  insert fails after the order already saved, the order save still
  succeeds (the error is logged server-side) — losing line items is
  recoverable, losing the whole order isn't.
- **Reading**: both `api/orders.js`'s `listOrders` and
  `api/patient-history.js` embed `order_items(*)` directly in their
  Supabase queries (PostgREST resource-embedding via the `order_id`
  foreign key), so items come back in the same call — no extra
  round-trips per order.
- **Backward compatibility**: the original single-item columns
  (`item_name`, `item_qty`, `item_unit_price`, `item_line_total`) still
  exist directly on `orders` and are populated from the *first* item for
  anything that only reads those columns. Orders saved before this
  feature existed still display correctly — the staff views fall back to
  those columns when `order_items` is empty.
- **Display**: `staff-orders.html` shows a compact summary ("Nosepads +2
  more") in the orders list; `staff-patient-lookup.html` shows the full
  comma-separated item list in a patient's order history.

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
- `lib/patients-helper.js` is the shared matching logic — both `api/intake.js`
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



## AI front-desk assistant (`api/chat.js`)

The homepage chat now calls our own serverless endpoint instead of the
Claude-app-only capability, so it works for anyone visiting the live site.

- **Grounded in live data.** The server builds the assistant's instructions
  from `app_settings.business_info` (name, branch, address, hours, phones,
  email, social — edited in Staff → Settings) and active, in-stock
  `catalog_items` (sale price only; base/cost price is never sent). Cached
  for 5 minutes, so Settings edits show up in the chat within that window.
- **Instructions stay server-side.** The browser only sends the conversation;
  it can't change what the assistant is told to do.
- **Safety rules.** No diagnosis; possibly urgent symptoms get "seek care now"
  first; no invented prices/phone numbers/plans; stays on eye-care topics;
  steers personal/medical details to the intake form.
- **Booking hand-off.** When booking is the right next step the assistant
  emits `[[BOOK]]`, which the page turns into a "Book an exam →" button
  linking to `intake.html`.
- **Guardrails on cost.** Last 12 messages kept, 1,000 chars per message,
  450 output tokens, ~30 messages per 10 minutes per IP (best effort).
- **Function count:** this is the 12th file in `/api` — exactly the Vercel
  Hobby limit. Any future endpoint must be merged into an existing file.
  The staff assistant below lives in this same file for that reason.

## Staff assistant + AI access controls

- **Where:** a chat bubble (bottom-right) on every staff page, loaded by
  `staff-assistant.js`. Hidden automatically when switched off, when the
  user's role has no areas enabled, or when not logged in. Hidden when
  printing.
- **Endpoint:** `/api/chat?mode=staff` — requires a staff login. `GET`
  returns what this user may use; `POST` answers a question.
- **Read-only by design.** The model can only call fixed lookup tools in
  `lib/staff-ai.js` (orders, balances, stock, sales, patients). It never
  writes queries and there is no tool that changes data.
- **Settings → AI assistant (admin only)** controls everything, stored as
  `app_settings.ai_access` (normalized in `lib/ai-access.js`):
  - Website chat on/off, and whether it may mention in-stock items.
  - Staff assistant on/off.
  - Per area, per role (Admin / Staff): Orders, Balances & payments,
    Inventory / stock, Sales & revenue, Patient records, How-to help.
  - Defaults: everything on except Sales for Staff, and Patient records
    off for both roles.
- **Enforced server-side, twice:** the model is only offered tools for
  enabled areas, and every tool re-checks its area before querying.
  Turning off Balances also strips deposit/balance/payment status from
  order lookups. Base (cost) price is only ever returned to admins.
- **Changes apply on the next message** — read fresh each time.
- **Privacy:** only the records a lookup returns are sent to Anthropic.
  If Patient records is enabled, cover AI-assisted processing in the
  clinic's privacy notice.
- Each staff question is logged in Vercel's function logs as
  `staff-ai: <username> (<role>) lookups=[...]` (question text is not logged).

## AI master switch + usage & cost log

- **All AI features** (top of Settings → AI assistant) is a kill switch that
  saves instantly. Off = website chat and staff assistant both stop, no API
  calls, no cost. Stored as `ai_access.enabled`.
- **Usage log:** every AI reply writes a row to `ai_usage_log` (channel,
  model, input/output tokens, API calls, lookups, estimated USD cost,
  and the staff username for staff questions). Question text is not stored.
- **Cost** is estimated from token counts using the price table in
  `lib/ai-usage.js`, frozen at the time of each call. The Anthropic Console
  billing page remains the official figure. If you change `ANTHROPIC_MODEL`,
  check its price is listed there.
- **Settings → AI assistant → Usage & cost (admin only):** pick Today /
  Yesterday / Last 7 days / This month / Last month / custom range to see
  estimated cost, replies and tokens, split by website vs staff, a
  per-day table, and all-time totals. Served by
  `GET /api/settings?view=ai_usage&from=YYYY-MM-DD&to=YYYY-MM-DD`, which
  sums in SQL via `ai_usage_daily()` (Manila calendar days).
  A **By AI service** table splits the same period by model (Claude vs
  Gemini: replies, tokens, estimated cost, cost per reply) via
  `ai_usage_by_model()`; until that SQL function is added the card shows
  a one-line "run the schema" note instead. Costs are estimates from list
  prices -- the Anthropic Console and Google Cloud Billing / AI Studio
  are the official figures.
- **Setup:** run the new block at the bottom of `supabase-schema.sql`
  (safe to re-run).

## Customer chat bubble (`site-assistant.js`)

- Floating "Ask us" bubble (bottom-right) on the public pages
  (`index.html`, `intake.html`). Add it to any new public page with
  `<script src="site-assistant.js" defer></script>`.
- On the homepage it also drives the inline "Ask us anything" panel —
  one shared conversation shown in both places.
- Checks `GET /api/chat` on load: if Website chat (or All AI features) is
  off in Settings, the bubble isn't shown and the homepage chat section
  and its nav links are hidden.
- Any element with `data-open-chat` opens the bubble.

## AI Test mode (free)

- **Turn on:** Settings → AI assistant → **Test mode** (saves instantly),
  or set `AI_TEST_MODE=1` in Vercel to force it on.
- **No Anthropic calls, no cost, no API key needed.**
- **Website chat:** keyword-matched sample answers built from your real
  Business info and in-stock catalog, including the "Book an exam" button
  and the urgent-symptom reply. Supports common English/Tagalog words.
- **Staff assistant:** routes simple keyword questions ("orders ready for
  claim", "who has a balance?", "low stock frames", "sales this week",
  "patient Juan", "how do I log a payment?") to the same read-only
  lookups the AI uses, and still follows the per-role switches.
- Both chats show a **Test mode** label while it's on.
- Test replies are logged in `ai_usage_log` with `test = true` and $0 cost;
  the Usage & cost card shows them as a separate count, not in the totals.
- Replies are literal and simple: they test the plumbing (bubble, toggles,
  lookups, logging), not the AI's understanding. Turn Test mode off and add
  `ANTHROPIC_API_KEY` for real answers.
- Code: `lib/ai-test-mode.js`.

## Clinic knowledge + questions it couldn't answer

**Clinic knowledge** (Settings → AI assistant → Clinic knowledge, admin only)
- Question/answer entries (HMOs accepted, exam prices, promos, warranty…)
  stored as `app_settings.ai_knowledge`. Each entry is for Website + staff,
  Website only, or Staff only, and can be paused without deleting it.
- Active entries are added to the assistant's instructions on every
  message, so edits apply immediately (no retraining). Test mode answers
  from them too, so you can try entries for free.
- Capped at 60 entries / 12,000 characters (about 3,000 tokens, roughly
  $0.003 extra per reply at most); the card shows current size and cost.

**Questions it couldn't answer** (same tab, admin only)
- Switch "Log questions it couldn't answer" — off by default (`ai_access.log_unanswered`).
- When on, the AI adds a hidden `[[UNANSWERED]]` marker if your info didn't
  cover a clinic question; the server strips it before anyone sees the reply
  and saves the question to `ai_unanswered`. In Test mode, questions no rule
  or entry matched are saved.
- Phone numbers and emails are removed first; repeats increase "Asked N×";
  rows not asked again for 90 days are deleted automatically.
- "Add answer" turns a question into a knowledge entry and marks it
  answered; "Dismiss" hides it. API: `GET /api/settings?view=ai_unanswered`
  and `POST /api/settings?action=ai_unanswered` (admin only).
- Code: `lib/ai-knowledge.js`. Setup: run the new `ai_unanswered` block at
  the bottom of `supabase-schema.sql`.

## Customer order status ("Are my glasses ready?")

- **Switch:** Settings → AI assistant → Website assistant → **Order status
  lookup** (off by default), plus **Include remaining balance** (off).
- **How customers use it:** type naturally in the chat ("ready na ba order
  2026-0012? last 4 ko 4567") or tap **Check my order** in the chat bubble.
- **Proof of ownership:** job order number from the claim stub **and** the
  last 4 digits of the phone number on the order. Orders are never looked up
  by name. Tolerates "#", spaces and missing dashes (20260012 → 2026-0012).
- **Returns only:** being prepared / ready for pick-up / claimed, the due
  date, and (if allowed) the remaining balance. Never names, Rx, items or
  phone numbers. A wrong match never says which part was wrong.
- **Anti-guessing:** 5 failed tries per visitor per 15 min and 8 per order
  number per hour, stored hashed in `order_lookup_attempts` (cleared daily).
- **Cost:** the Check my order form uses no AI. Typed questions use the AI
  with a `check_order_status` tool (one extra short AI call when a lookup
  happens). Test mode handles both for free.
- Code: `lib/order-status.js`; routes in `api/chat.js`
  (`POST /api/chat?mode=order`). Setup: run the new
  `order_lookup_attempts` block at the bottom of `supabase-schema.sql`.

## Homepage settings (Settings → Website → Homepage, admin only)

- **Section switches:** What we do, Our story, FAQ, Find your frame, and the
  "Are my glasses ready?" order check. A hidden section's nav/footer/button
  links are hidden too. The order check also stays hidden whenever Order
  status lookup (AI assistant tab) is off, and the booking form then uses the
  full width.
- **FAQ editor:** up to 12 questions, add / edit / reorder / delete, "Restore
  original FAQ". Removing every question hides the FAQ section.
- **Placeholders** filled from Business info when the page loads:
  `{name} {branch} {address} {hours} {mobile} {tel} {email}` — so hours and
  address are only typed once. Blank values are tidied out.
- Stored as `app_settings.homepage` (normalized in `lib/homepage.js`; missing
  values default to the page's original content). Sent to the site through
  `GET /api/settings?view=public_info` (`info.homepage`, `info.order_tracking`).
- Still managed elsewhere: Optometrists, Visit the shop and Facebook link
  (Business info); the chat (AI assistant); whole-site Coming Soon page
  (Website). No SQL needed.

### Page text (Settings → Website → Homepage → Page text)

- 33 labelled text blocks in 6 collapsible groups: Hero, What we do, Our
  story, Booking & order check, Find your frame, Privacy & AI notice.
- Each block maps to an element marked `data-text="<key>"` in `index.html`;
  the field list and original wording live in `lib/homepage.js`
  (`TEXT_FIELDS`). Only changed fields are stored (`homepage.text`), so
  "Restore original" / an empty box falls back to the shipped wording.
- Text only (inserted with textContent). The story paragraphs also accept
  `**bold**`; everything else is escaped, so HTML/scripts can't be injected.
- To make another block editable: add `data-text="new_key"` to the element
  and a matching entry in `TEXT_FIELDS` with its exact current wording.

## AI service: Claude or Gemini (Settings → AI assistant → AI service)

Each assistant (website chat, staff assistant) can use **Claude** (Anthropic)
or **Gemini** (Google). Same instructions, Business info, Clinic knowledge,
order check and staff lookups either way — only the model changes.

**Keys (Vercel → Settings → Environment Variables, then redeploy):**

| Variable | Use |
|---|---|
| `ANTHROPIC_API_KEY` | Claude |
| `VERTEX_API_KEY` | Gemini via **Google Cloud** (Vertex AI / "Gemini Enterprise Agent Platform"). Billed to Google Cloud, so the **$300 free trial credit applies**; Google Cloud terms — prompts not used for training. **Recommended.** |
| `GEMINI_API_KEY` | Gemini via Google AI Studio. Free tier exists but Google may use free-tier prompts to improve its products; the $300 trial can't pay for AI Studio (accounts opened after Mar 2026). Used only if `VERTEX_API_KEY` isn't set. |
| `GEMINI_MODEL` | Optional; overrides the model chosen in Settings (default `gemini-3.8-flash`). |

**Google Cloud trial setup (≈10 min):**
1. Create a Google Cloud account/project at console.cloud.google.com and
   start the free trial (adds the $300 credit; needs a card for identity).
2. Enable the Vertex AI ("Gemini Enterprise Agent Platform") API for the project.
3. Create an API key for it (APIs & Services → Credentials, or the express-mode
   "Get API key" page) and restrict it to that API.
4. Add it in Vercel as `VERTEX_API_KEY`, redeploy, then pick Gemini in
   Settings → AI assistant → AI service. The status chip should read
   "Gemini · connected via Google Cloud".
5. Set a budget alert in Google Cloud Billing so the trial can't run over.

**Backup:** "Use the other service as a backup" (on by default) answers with
the other provider if the chosen one errors or has no key. Usage & cost logs
each reply under the model that actually answered (Gemini prices added to
`lib/ai-usage.js`; estimates, Google's billing page is the official figure).

Code: `lib/ai-gemini.js` (translates the Claude-style messages/tools to Gemini
and back, streaming + function calling, keeps Gemini 3 thought signatures);
provider routing in `api/chat.js`; setting `ai_access.provider`.
