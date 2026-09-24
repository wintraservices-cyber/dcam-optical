// App-wide settings: a small key/value store (app_settings table) for
// things staff should be able to change without a code deploy -- Rx
// dropdown ranges, business name/address/contact/hours. One row per
// key; value is arbitrary JSON so a key can hold a structured object.
//
// GET with no key returns everything as { key: value, ... } (easiest
// shape for the order form and settings page to consume directly).
// GET with ?key=X returns just that key's value.
// PATCH { key, value } upserts one key.

const { requireAuth, requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const ALLOWED_KEYS = ['rx_ranges', 'business_info', 'phone_validation'];

async function getSettings(req, res) {
  const { key } = req.query || {};

  try {
    const path = key
      ? `app_settings?key=eq.${encodeURIComponent(key)}&limit=1`
      : 'app_settings?select=key,value';
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase app_settings read error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load settings.' });
      return;
    }
    const rows = await resp.json();

    if (key) {
      res.status(200).json({ ok: true, value: rows[0] ? rows[0].value : null });
      return;
    }

    const settings = {};
    rows.forEach(row => { settings[row.key] = row.value; });
    res.status(200).json({ ok: true, settings });
  } catch (err) {
    console.error('Unexpected error reading settings:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function putSetting(req, res, sessionUser) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  const { key, value } = body || {};

  if (!ALLOWED_KEYS.includes(key)) {
    res.status(400).json({ ok: false, error: `key must be one of: ${ALLOWED_KEYS.join(', ')}` });
    return;
  }
  if (value === undefined) {
    res.status(400).json({ ok: false, error: 'value is required.' });
    return;
  }

  try {
    // Upsert via PostgREST: POST with Prefer: resolution=merge-duplicates
    // against the primary key (key), which updates the row if it exists.
    const resp = await supabaseRequest('app_settings?on_conflict=key', {
      method: 'POST',
      headers: {
        Prefer: 'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({
        key,
        value,
        updated_at: new Date().toISOString(),
        updated_by: sessionUser.username || null,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase app_settings write error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save this setting.' });
      return;
    }

    const [saved] = await resp.json();
    res.status(200).json({ ok: true, setting: saved });
  } catch (err) {
    console.error('Unexpected error saving setting:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    // Any logged-in staff member can read settings -- the order form
    // needs the Rx ranges regardless of who's using it.
    if (!requireAuth(req, res)) return;
    return getSettings(req, res);
  }

  if (req.method === 'PATCH') {
    // Changing settings (Rx ranges, business info) is admin-only.
    const sessionUser = requireAdmin(req, res);
    if (!sessionUser) return;
    return putSetting(req, res, sessionUser);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
