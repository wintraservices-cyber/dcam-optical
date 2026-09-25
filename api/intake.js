// Vercel Serverless Function: /api/intake
// Receives patient intake form submissions, saves them to the database
// (linked to a patient record by phone number), and emails a notification
// to the practice.
//
// Setup required (see README-intake-api.md and README-staff-system.md):
//   1. Create a free Resend account: https://resend.com
//   2. Verify a sending domain (or use their shared onboarding domain for testing)
//   3. Create a Supabase project and run supabase-schema.sql
//   4. In Vercel: Project Settings -> Environment Variables, add:
//        RESEND_API_KEY            = your Resend API key
//        NOTIFY_EMAIL_TO           = the practice inbox that should receive submissions
//        NOTIFY_EMAIL_FROM         = a verified "from" address (e.g. intake@yourdomain.com)
//        SUPABASE_URL              = your Supabase project URL
//        SUPABASE_SERVICE_ROLE_KEY = your Supabase service role key
//   5. Redeploy after adding env vars.

const { supabaseRequest } = require('../lib/supabase');
const { findOrCreatePatient, validatePhoneForSave } = require('../lib/patients-helper');

const RESEND_API_URL = 'https://api.resend.com/emails';

// Basic field allow-list + length caps: keeps payload bounded and predictable,
// and avoids accidentally forwarding fields we never intended to collect
// (defense in depth against a modified/malicious client-side request).
const FIELD_LIMITS = {
  fname: 100,
  lname: 100,
  phone: 40,
  email: 150,
  patientType: 20,
  reason: 60,
  prefDate: 20,
  prefTime: 20,
  notes: 1000,
};

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isValidEmail(email) {
  // Simple, deliberately permissive check -- real validation happens when the
  // practice actually replies. We just want to reject obvious garbage.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const REASON_LABELS = {
  comprehensive: 'Comprehensive eye exam',
  checkup: 'Check up',
  contacts: 'Contact lens fitting',
  frames: 'Frame styling / new glasses',
  urgent: 'Urgent concern',
  unsure: 'Not sure — help me figure it out',
};

const TIME_LABELS = {
  morning: 'Morning',
  afternoon: 'Afternoon',
  evening: 'Evening',
  '': 'No preference',
};

module.exports = async (req, res) => {
  // CORS: allow calls from the site itself. Adjust origin if the site is
  // served from a different domain than this function.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const { RESEND_API_KEY, NOTIFY_EMAIL_TO, NOTIFY_EMAIL_FROM, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

  const emailConfigured = RESEND_API_KEY && NOTIFY_EMAIL_TO && NOTIFY_EMAIL_FROM;
  const dbConfigured = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY;

  if (!emailConfigured && !dbConfigured) {
    console.error('Missing required environment variables for /api/intake (neither email nor database configured)');
    res.status(500).json({
      ok: false,
      error: 'Server is not configured yet. Missing email and database environment variables.',
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing form data' });
    return;
  }

  const data = {};
  for (const [key, maxLen] of Object.entries(FIELD_LIMITS)) {
    data[key] = sanitize(body[key], maxLen);
  }

  // Required-field check mirrors the client-side `required` attributes —
  // never trust the client alone.
  const missing = [];
  if (!data.fname) missing.push('First name');
  if (!data.lname) missing.push('Last name');
  if (!data.phone) missing.push('Phone number');
  if (!data.email) missing.push('Email');
  if (!data.reason) missing.push('Reason for visit');
  if (!body.consentData) missing.push('Data consent');
  if (!body.consentContact) missing.push('Contact consent');

  if (!isValidEmail(data.email)) {
    missing.push('Valid email address');
  }

  // Phone format enforcement, per the phone_validation setting an admin
  // can toggle in Settings: 'ph_only' (default) requires a Philippine
  // mobile number; 'international' accepts any number that's at least
  // plausible-looking, so patients giving a foreign number (OFW family,
  // tourists, etc.) aren't rejected outright. Same shared check used by
  // staff-facing patient/order creation and editing.
  const phoneCheck = await validatePhoneForSave(data.phone);
  if (!phoneCheck.valid) {
    missing.push(phoneCheck.message);
  }

  if (missing.length > 0) {
    res.status(400).json({
      ok: false,
      error: `Missing or invalid: ${missing.join(', ')}`,
    });
    return;
  }

  const reasonLabel = REASON_LABELS[data.reason] || data.reason;
  const timeLabel = TIME_LABELS[data.prefTime] || data.prefTime;
  const patientTypeLabel = data.patientType === 'returning' ? 'Returning patient' : 'New patient';

  const submittedAt = new Date().toISOString();

  // ---- Save to database (patient + intake_submissions), if configured ----
  let dbSaveError = null;
  if (dbConfigured) {
    try {
      const patient = await findOrCreatePatient({
        phone: data.phone,
        name: `${data.fname} ${data.lname}`.trim(),
        email: data.email,
      });

      const intakeResp = await supabaseRequest('intake_submissions', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          patient_id: patient ? patient.id : null,
          fname: data.fname,
          lname: data.lname,
          phone: data.phone,
          email: data.email,
          patient_type: data.patientType || 'new',
          reason: data.reason,
          pref_date: data.prefDate || null,
          pref_time: data.prefTime || null,
          notes: data.notes || null,
        }),
      });

      if (!intakeResp.ok) {
        const errText = await intakeResp.text();
        console.error('Supabase intake_submissions insert error:', intakeResp.status, errText);
        dbSaveError = 'Could not save intake record to the database.';
      }
    } catch (err) {
      console.error('Unexpected error saving intake to database:', err);
      dbSaveError = err.message || 'Unexpected database error.';
    }
  }

  // ---- Send email notification, if configured ----
  let emailSendError = null;
  if (emailConfigured) {
    const htmlBody = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 560px; margin: 0 auto; color: #383334;">
        <h2 style="font-size: 18px; margin-bottom: 4px;">New patient intake — ${escapeHtml(data.fname)} ${escapeHtml(data.lname)}</h2>
        <p style="color: #777; font-size: 13px; margin-top: 0;">Submitted ${submittedAt}</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px;">
          <tr><td style="padding:6px 0; color:#777; width:160px;">Name</td><td style="padding:6px 0;">${escapeHtml(data.fname)} ${escapeHtml(data.lname)}</td></tr>
          <tr><td style="padding:6px 0; color:#777;">Phone</td><td style="padding:6px 0;">${escapeHtml(data.phone)}</td></tr>
          <tr><td style="padding:6px 0; color:#777;">Email</td><td style="padding:6px 0;">${escapeHtml(data.email)}</td></tr>
          <tr><td style="padding:6px 0; color:#777;">Patient type</td><td style="padding:6px 0;">${escapeHtml(patientTypeLabel)}</td></tr>
          <tr><td style="padding:6px 0; color:#777;">Reason for visit</td><td style="padding:6px 0;">${escapeHtml(reasonLabel)}</td></tr>
          <tr><td style="padding:6px 0; color:#777;">Preferred date</td><td style="padding:6px 0;">${escapeHtml(data.prefDate) || '—'}</td></tr>
          <tr><td style="padding:6px 0; color:#777;">Preferred time</td><td style="padding:6px 0;">${escapeHtml(timeLabel)}</td></tr>
          <tr><td style="padding:6px 0; color:#777; vertical-align:top;">Notes</td><td style="padding:6px 0;">${data.notes ? escapeHtml(data.notes) : '—'}</td></tr>
        </table>
        <p style="margin-top: 20px; font-size: 12px; color: #999;">Both consent checkboxes were confirmed at submission.</p>
      </div>
    `;

    try {
      const emailResp = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: NOTIFY_EMAIL_FROM,
          to: [NOTIFY_EMAIL_TO],
          reply_to: data.email,
          subject: `New intake: ${data.fname} ${data.lname} — ${reasonLabel}`,
          html: htmlBody,
        }),
      });

      if (!emailResp.ok) {
        const errText = await emailResp.text();
        console.error('Resend API error:', emailResp.status, errText);
        emailSendError = 'Could not send notification email.';
      }
    } catch (err) {
      console.error('Unexpected error sending intake notification:', err);
      emailSendError = err.message || 'Unexpected email error.';
    }
  }

  // Overall success: at least one of database-save or email-send worked.
  // If both were configured and both failed, that's a real failure. If
  // only one was configured and it failed, that's also a real failure.
  // If one succeeded even though the other failed, we still tell the
  // caller ok:true (the submission wasn't lost) but log the partial
  // failure server-side for follow-up.
  const dbOk = !dbConfigured || !dbSaveError;
  const emailOk = !emailConfigured || !emailSendError;

  if (!dbOk && !emailOk) {
    res.status(502).json({ ok: false, error: 'Could not save or send the intake submission.' });
    return;
  }

  if (dbSaveError || emailSendError) {
    console.error('Intake submission partially failed:', { dbSaveError, emailSendError });
  }

  res.status(200).json({ ok: true });
};
