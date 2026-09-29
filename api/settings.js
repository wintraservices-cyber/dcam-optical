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
const { normalizeAiAccess } = require('../lib/ai-access');
const { usageReport } = require('../lib/ai-usage');
const { normalizeKnowledge, listUnanswered, setUnansweredStatus } = require('../lib/ai-knowledge');
const { normalizeSiteMode, redactSiteMode, publicSiteMode, checkPreviewPin, SiteModeError } = require('../lib/site-mode');

const ALLOWED_KEYS = ['rx_ranges', 'business_info', 'phone_validation', 'ai_access', 'ai_knowledge', 'site_mode'];

async function readSetting(key) {
  const resp = await supabaseRequest(`app_settings?key=eq.${encodeURIComponent(key)}&limit=1`, { method: 'GET' });
  if (!resp.ok) throw new Error(`app_settings read ${resp.status}`);
  const rows = await resp.json();
  return rows[0] ? rows[0].value : null;
}

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
      const value = rows[0] ? rows[0].value : null;
      res.status(200).json({ ok: true, value: key === 'site_mode' ? redactSiteMode(value) : value });
      return;
    }

    const settings = {};
    rows.forEach(row => { settings[row.key] = row.value; });
    if (settings.site_mode) settings.site_mode = redactSiteMode(settings.site_mode);
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

  // AI access toggles are always stored in their full, normalized shape
  // (unknown fields dropped, missing ones filled with safe defaults), so
  // the assistant never has to guess what a partial value meant.
  let storedValue;
  try {
    storedValue = key === 'ai_access' ? normalizeAiAccess(value)
      : key === 'ai_knowledge' ? normalizeKnowledge(value)
      : key === 'site_mode' ? normalizeSiteMode(value, await readSetting('site_mode'))
      : value;
  } catch (err) {
    if (err instanceof SiteModeError) {
      res.status(400).json({ ok: false, error: err.message });
      return;
    }
    console.error('Could not prepare setting:', err.message);
    res.status(502).json({ ok: false, error: 'Could not save this setting.' });
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
        value: storedValue,
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
    if (saved && saved.key === 'site_mode') saved.value = redactSiteMode(saved.value);
    res.status(200).json({ ok: true, setting: saved });
  } catch (err) {
    console.error('Unexpected error saving setting:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function getAiUsage(req, res) {
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  const from = isDate(req.query.from) ? req.query.from : today;
  const to = isDate(req.query.to) ? req.query.to : today;
  if (from > to) {
    res.status(400).json({ ok: false, error: 'The start date is after the end date.' });
    return;
  }
  try {
    const report = await usageReport(from, to);
    res.status(200).json({ ok: true, ...report });
  } catch (err) {
    console.error('AI usage report error:', err.message);
    res.status(502).json({ ok: false, error: 'Could not load AI usage. Has the latest supabase-schema.sql been run?' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET' && req.query && req.query.view === 'site_mode') {
    // Public: is the website live, or showing Coming Soon / Maintenance?
    // No login needed (the home page asks on every visit), so it only
    // returns public fields and is cached at the edge for a few seconds.
    try {
      const value = await readSetting('site_mode');
      // Browsers always re-ask; Vercel's edge may reuse the answer briefly.
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Vercel-CDN-Cache-Control', 'max-age=15, stale-while-revalidate=30');
      res.status(200).json({ ok: true, ...publicSiteMode(value) });
    } catch (err) {
      console.error('site_mode read error:', err.message);
      res.status(200).json({ ok: true, mode: 'live', message: '', facebook_url: '', pin_set: false });
    }
    return;
  }

  if (req.method === 'POST' && req.query && req.query.action === 'site_preview') {
    // Public: check the preview PIN from the Coming Soon page.
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    try {
      const value = await readSetting('site_mode');
      if (!value || !value.pin_hash) {
        res.status(400).json({ ok: false, error: 'No preview PIN has been set yet.' });
        return;
      }
      if (checkPreviewPin(value, body && body.pin)) {
        res.status(200).json({ ok: true });
        return;
      }
      // Slow down guessing.
      await new Promise(r => setTimeout(r, 900));
      res.status(401).json({ ok: false, error: 'That PIN is not right.' });
    } catch (err) {
      console.error('site_preview error:', err.message);
      res.status(502).json({ ok: false, error: 'Could not check the PIN right now.' });
    }
    return;
  }

  if (req.method === 'GET' && req.query && req.query.view === 'ai_unanswered') {
    // Questions the assistants couldn't answer -- admin only.
    if (!requireAdmin(req, res)) return;
    try {
      const rows = await listUnanswered(req.query.status || 'open');
      res.status(200).json({ ok: true, questions: rows });
    } catch (err) {
      console.error('ai_unanswered list error:', err.message);
      res.status(502).json({ ok: false, error: 'Could not load questions. Has the latest supabase-schema.sql been run?' });
    }
    return;
  }

  if (req.method === 'POST' && req.query && req.query.action === 'ai_unanswered') {
    // Mark a question resolved / dismissed / open again -- admin only.
    const sessionUser = requireAdmin(req, res);
    if (!sessionUser) return;
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    try {
      await setUnansweredStatus(body && body.id, body && body.status, sessionUser.username);
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: 'Could not update that question.' });
    }
    return;
  }

  if (req.method === 'GET' && req.query && req.query.view === 'ai_usage') {
    // AI usage + estimated cost -- admin only.
    if (!requireAdmin(req, res)) return;
    return getAiUsage(req, res);
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
