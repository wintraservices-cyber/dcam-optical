# Patient Intake Form — Email Notification Setup

The intake form now POSTs to a Vercel serverless function at `/api/intake`,
which sends an email notification via [Resend](https://resend.com) when
someone submits it.

## 1. File placement

Make sure your repo looks like this:

```
your-repo/
  index.html
  intake.html
  api/
    intake.js
  vercel.json   (optional, already present)
```

Vercel automatically turns anything under `/api` into a serverless function —
no extra config needed for this to work, as long as `api/intake.js` is in the
repo root's `api/` folder.

## 2. Create a Resend account (free tier is enough to start)

1. Go to https://resend.com and sign up.
2. Under **API Keys**, create a new key. Copy it — you'll only see it once.
3. Under **Domains**, add and verify a sending domain you control
   (e.g. `dcamoptical.com`), following their DNS instructions (a couple of
   TXT/CNAME records).
   - While testing, you can skip domain verification and send from
     `onboarding@resend.dev` — but production email should use your own
     verified domain so it doesn't land in spam and looks legitimate.

## 3. Add environment variables in Vercel

In your Vercel project: **Settings → Environment Variables**, add:

| Name | Value | Example |
|---|---|---|
| `RESEND_API_KEY` | Your Resend API key | `re_123abc...` |
| `NOTIFY_EMAIL_TO` | Where submissions should land | `frontdesk@dcamoptical.com` |
| `NOTIFY_EMAIL_FROM` | A verified sender address | `intake@dcamoptical.com` |

Apply them to all environments (Production, Preview, Development) unless you
want different behavior per environment.

**Redeploy after adding these** — environment variables only take effect on
the next build/deploy, not retroactively.

## 4. Test it

1. Visit your deployed `intake.html` page.
2. Fill out the form and submit.
3. Check the inbox set in `NOTIFY_EMAIL_TO` — you should get an email within
   a few seconds, with the patient's name in the subject line and a full
   summary in the body. Replying to that email will reply straight to the
   patient (the function sets `reply_to` to their submitted address).

If it fails, check **Vercel → your project → Deployments → [latest] →
Functions → intake** for the error log — the function logs the exact reason
(missing env vars, Resend API error, etc.) rather than failing silently.

## What this does NOT do

- **No database.** Submissions aren't stored anywhere except as an email.
  If you want a searchable record (not just an inbox), the next step is
  adding a database write (e.g. Supabase, Airtable, or a Google Sheet via
  API) alongside the email send.
- **No real booking/calendar integration.** This notifies staff; a person
  still has to manually confirm and add it to the schedule.
- **No SMS confirmation to the patient.** The form promises "we'll confirm
  by phone or text" — that confirmation still happens manually, by staff,
  after reading the email.

These are all reasonable next steps once this basic pipeline is working and
DCAM has decided on a longer-term practice management system.
