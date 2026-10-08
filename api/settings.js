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
const { usageReport, usageDaily, summarize } = require('../lib/ai-usage');
const { analyticsSummary } = require('../lib/ga4');
const { normalizeKnowledge, loadKnowledge, entriesFor, listUnanswered, setUnansweredStatus } = require('../lib/ai-knowledge');
const { normalizeSiteMode, redactSiteMode, publicSiteMode, checkPreviewPin, SiteModeError } = require('../lib/site-mode');
const { buildTeam, adminTeam, publicTeam, decodePhoto, TeamError } = require('../lib/team');
const { normalizeHomepage, TEXT_FIELDS } = require('../lib/homepage');
const { PERMISSIONS, normalizePermissions, getPermissions } = require('../lib/staff-permissions');

const ALLOWED_KEYS = ['rx_ranges', 'business_info', 'phone_validation', 'print_prefs', 'ai_access', 'ai_knowledge', 'site_mode', 'optometrists', 'homepage', 'project_status', 'staff_permissions'];

async function readSetting(key) {
  const resp = await supabaseRequest(`app_settings?key=eq.${encodeURIComponent(key)}&limit=1`, { method: 'GET' });
  if (!resp.ok) throw new Error(`app_settings read ${resp.status}`);
  const rows = await resp.json();
  return rows[0] ? rows[0].value : null;
}

async function writeSetting(key, value, username) {
  const resp = await supabaseRequest('app_settings?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString(), updated_by: username || null }),
  });
  if (!resp.ok) throw new Error(`app_settings write ${resp.status}: ${await resp.text()}`);
}

async function getSettings(req, res) {
  const { key } = req.query || {};

  try {
    const path = key
      ? `app_settings?key=eq.${encodeURIComponent(key)}&limit=1`
      // Optometrist photos are large and only needed on the home page.
      : 'app_settings?select=key,value&key=neq.optometrist_photos';
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
      res.status(200).json({ ok: true, value: key === 'site_mode' ? redactSiteMode(value) : key === 'optometrists' ? adminTeam(value) : key === 'homepage' ? normalizeHomepage(value) : value });
      return;
    }

    const settings = {};
    rows.forEach(row => { settings[row.key] = row.value; });
    if (settings.site_mode) settings.site_mode = redactSiteMode(settings.site_mode);
    // Always send the homepage settings in full (defaults = the page's
    // original content) so the editor shows what the site shows today.
    settings.homepage = normalizeHomepage(settings.homepage);
    // Field list for the Page text editor (labels + original wording).
    settings.homepage_text_fields = TEXT_FIELDS;
    if (settings.optometrists) settings.optometrists = adminTeam(settings.optometrists);
    delete settings.optometrist_photos;
    res.status(200).json({ ok: true, settings });
  } catch (err) {
    console.error('Unexpected error reading settings:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Splits the optometrists list into its small record + the photos record,
// writes the photos, and returns the small record for putSetting to save.
async function saveTeamPhotos(value, sessionUser) {
  const [prevMeta, prevPhotos] = await Promise.all([readSetting('optometrists'), readSetting('optometrist_photos')]);
  const { meta, photos } = buildTeam(value, prevMeta, prevPhotos);
  await writeSetting('optometrist_photos', photos, sessionUser.username);
  return meta;
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
      : key === 'homepage' ? normalizeHomepage(value)
      : key === 'staff_permissions' ? normalizePermissions(value)
      : key === 'optometrists' ? await saveTeamPhotos(value, sessionUser)
      : value;
  } catch (err) {
    if (err instanceof SiteModeError || err instanceof TeamError) {
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
    if (saved && saved.key === 'optometrists') saved.value = adminTeam(saved.value);
    res.status(200).json({ ok: true, setting: saved });
  } catch (err) {
    console.error('Unexpected error saving setting:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}


// ---------------------------------------------------------------------
// Website dashboard (Settings > Dashboard) -- admin only. One page that
// pulls the numbers the system already has: intake forms submitted, AI
// usage and spend, and the questions the AI could not answer. Each is
// compared with the previous period of the same length. Visitor numbers
// live in Google Analytics, not here.
// ---------------------------------------------------------------------
async function countRows(table, field, from, to, extra) {
  let path = `${table}?select=id${extra || ''}`;
  if (from) path += `&${field}=gte.${encodeURIComponent(from + 'T00:00:00+08:00')}`;
  if (to) path += `&${field}=lte.${encodeURIComponent(to + 'T23:59:59.999+08:00')}`;
  const resp = await supabaseRequest(path, { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } });
  if (!resp.ok) throw new Error(`count ${table} ${resp.status}`);
  const total = parseInt((resp.headers.get('content-range') || '').split('/')[1], 10);
  return Number.isFinite(total) ? total : 0;
}

function shiftDate(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function getDashboard(req, res) {
  const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const from = isDate(req.query.from) ? req.query.from : null;
  const to = isDate(req.query.to) ? req.query.to : null;
  if (from && to && from > to) { res.status(400).json({ ok: false, error: 'The start date is after the end date.' }); return; }
  // Previous period of the same length, only when both ends are known.
  let prev = null;
  if (from && to) {
    const len = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    prev = { from: shiftDate(from, -len), to: shiftDate(from, -1) };
  }
  const out = { ok: true, range: { from, to }, previous: prev };
  const safe = async (key, fn) => { try { out[key] = await fn(); } catch (e) { console.error('dashboard ' + key + ':', e.message); out[key] = null; } };
  // Per-day activity for the trend chart (only for a bounded period).
  const spanDays = from && to ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1 : 0;
  const wantDaily = spanDays > 0 && spanDays <= 93;
  const dayOf = iso => new Date(new Date(iso).getTime() + 8 * 3600000).toISOString().slice(0, 10);
  await Promise.all([
    safe('daily', async () => {
      if (!wantDaily) return null;
      const map = {};
      for (let i = 0; i < spanDays; i++) map[shiftDate(from, i)] = { day: shiftDate(from, i), intake: 0, ai: 0 };
      const resp = await supabaseRequest(`intake_submissions?select=created_at&created_at=gte.${encodeURIComponent(from + 'T00:00:00+08:00')}&created_at=lte.${encodeURIComponent(to + 'T23:59:59.999+08:00')}&limit=5000`, { method: 'GET' });
      if (resp.ok) (await resp.json()).forEach(r => { if (!r.created_at) return; const d = map[dayOf(r.created_at)]; if (d) d.intake++; });
      (await usageDaily(from, to)).forEach(r => { const d = map[r.day]; if (d) d.ai += Number(r.messages) || 0; });
      return Object.values(map);
    }),
    safe('intake', async () => ({
      count: await countRows('intake_submissions', 'created_at', from, to),
      previous: prev ? await countRows('intake_submissions', 'created_at', prev.from, prev.to) : null,
    })),
    safe('ai', async () => {
      const cur = summarize(await usageDaily(from, to));
      const old = prev ? summarize(await usageDaily(prev.from, prev.to)) : null;
      return { current: cur, previous: old };
    }),
    safe('analytics', async () => {
      try { return await analyticsSummary(from, to, prev); }
      catch (e) { console.error('dashboard analytics:', e.message); return { configured: true, error: 'Google Analytics did not answer. Check that the service account is a Viewer on the property.' }; }
    }),
    safe('order_checks', async () => {
      const sum = async (f, t2) => {
        let path = 'order_check_daily?select=checks,found&limit=1000';
        if (f) path += `&day=gte.${f}`;
        if (t2) path += `&day=lte.${t2}`;
        const resp = await supabaseRequest(path, { method: 'GET' });
        if (!resp.ok) throw new Error('order_check_daily ' + resp.status);
        const rows = await resp.json();
        return rows.reduce((a, r) => ({ checks: a.checks + (r.checks || 0), found: a.found + (r.found || 0) }), { checks: 0, found: 0 });
      };
      const cur = await sum(from, to);
      return { ...cur, previous: prev ? (await sum(prev.from, prev.to)).checks : null };
    }),
    safe('unanswered', async () => {
      const resp = await supabaseRequest('ai_unanswered?select=question,times_asked,channel&status=eq.open&order=times_asked.desc,last_asked_at.desc&limit=6', { method: 'GET' });
      if (!resp.ok) throw new Error('unanswered ' + resp.status);
      const total = await countRows('ai_unanswered', 'created_at', null, null, '&status=eq.open');
      return { top: await resp.json(), open_total: total };
    }),
  ]);
  res.status(200).json(out);
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

// ---------------------------------------------------------------------
// AEO snippet generator -- admin-only, view=aeo_snippet.
//
// This site is plain static HTML with no build step and no server-side
// rendering (Vercel Hobby, already at the 12-function cap), so the FAQ
// text, hours/address, and JSON-LD that answer engines (ChatGPT,
// Perplexity, Google AI Overviews) read have to live as real text
// baked into index.html -- not fetched client-side after page load,
// which a non-JS crawler never sees resolve.
//
// Rather than that static text silently drifting out of sync with
// Settings, this route assembles it fresh from the CURRENT Business
// info + Clinic knowledge (the same source the chat assistant uses)
// and returns ready-to-paste HTML. Whenever hours, address, or an FAQ
// answer changes in Settings, re-run this and paste the two blocks
// into index.html in place of the old ones (marked with HTML comments
// there so they're easy to find).
function escapeHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildAeoSnippet(biz, knowledge) {
  const b = biz || {};
  const faqEntries = entriesFor(knowledge, 'website');

  // ---- Visible FAQ section (static HTML, crawlable without JS) ----
  const faqItemsHtml = faqEntries.map(e => (
    `  <div class="faq-item">\n` +
    `    <h3>${escapeHtml(e.title)}</h3>\n` +
    `    <p>${escapeHtml(e.answer)}</p>\n` +
    `  </div>`
  )).join('\n');
  const faqSectionHtml =
    `<!-- AEO:FAQ:START -- generated from Settings > AI assistant > Clinic knowledge. Re-run "Copy AEO snippet" after editing hours/FAQs and paste over this block. -->\n` +
    `<section class="faq-static" id="faq" aria-label="Frequently asked questions">\n` +
    `${faqItemsHtml || '  <!-- no website-audience clinic knowledge entries yet -->'}\n` +
    `</section>\n` +
    `<!-- AEO:FAQ:END -->`;

  // ---- FAQPage JSON-LD (mirrors the visible text above exactly) ----
  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqEntries.map(e => ({
      '@type': 'Question',
      name: e.title,
      acceptedAnswer: { '@type': 'Answer', text: e.answer },
    })),
  };

  // ---- Enriched business schema (Optician + LocalBusiness fields) ----
  const bizJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Optician',
    name: b.name || 'DCAM Optical',
    alternateName: 'Limuaco Optical',
    description: 'Family-friendly optical shop offering eye exams, prescription glasses and contact lenses. Formerly Limuaco Optical.',
    image: '/assets/landing-options/display-case.jpg',
    address: {
      '@type': 'PostalAddress',
      streetAddress: b.branch || 'LGF, Ever Gotesco Commonwealth, Commonwealth Avenue',
      addressLocality: 'Quezon City',
      addressRegion: 'Metro Manila',
      addressCountry: 'PH',
    },
  };
  if (b.tel) bizJsonLd.telephone = b.tel;
  else if (b.mobile) bizJsonLd.telephone = b.mobile;
  if (b.hours) {
    // Free-text hours (e.g. "Mon - Sat . 10:00 AM - 9:00 PM") can't be
    // reliably parsed into schema.org's structured day/time format
    // without the admin picking days and times explicitly in Settings,
    // so it's passed through as-is via openingHours (a valid, looser
    // fallback) rather than guessed at.
    bizJsonLd.openingHours = b.hours;
  }

  const schemaHtml =
    `<!-- AEO:SCHEMA:START -- generated from Settings > Business info + Clinic knowledge. Re-run "Copy AEO snippet" after changes and paste over both script tags below. -->\n` +
    `<script type="application/ld+json">\n${JSON.stringify(bizJsonLd, null, 2)}\n</script>\n` +
    `<script type="application/ld+json">\n${JSON.stringify(faqJsonLd, null, 2)}\n</script>\n` +
    `<!-- AEO:SCHEMA:END -->`;

  return { schemaHtml, faqSectionHtml, faqCount: faqEntries.length, hasHours: !!b.hours, hasAddress: !!b.branch };
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

  if (req.method === 'GET' && req.query && req.query.view === 'public_info') {
    // Public: the contact details the home page shows (hours, phone,
    // address...), straight from Settings > Business info, plus the
    // Facebook link from Settings > Website. Only these fields go out.
    const PUBLIC_FIELDS = ['name', 'branch', 'tel', 'mobile', 'email', 'hours', 'address'];
    try {
      const [biz, site, aiAccess, homepage] = await Promise.all([readSetting('business_info'), readSetting('site_mode'), readSetting('ai_access'), readSetting('homepage')]);
      const info = {};
      PUBLIC_FIELDS.forEach(f => {
        const v = biz && typeof biz[f] === 'string' ? biz[f].trim() : '';
        if (v) info[f] = v.slice(0, 400);
      });
      if (site && site.facebook_url) info.facebook_url = site.facebook_url;
      // Custom display name for the public chat widget (Settings > AI
      // assistant > Website assistant). Falls back to the default label
      // client-side if this is blank/unset.
      const assistantName = aiAccess && aiAccess.public && typeof aiAccess.public.name === 'string' ? aiAccess.public.name.trim() : '';
      if (assistantName) info.assistant_name = assistantName.slice(0, 60);
      // Homepage section switches + FAQ (Settings > Website > Homepage).
      info.homepage = normalizeHomepage(homepage);
      // The homepage "Are my glasses ready?" box only works when the
      // website chat and Order status lookup are both on.
      const access = normalizeAiAccess(aiAccess);
      info.order_tracking = !!(access.enabled && access.public.enabled && access.public.order_status);
      res.setHeader('Cache-Control', 'no-cache');
      // Shortened from max-age=60 so a freshly-saved Assistant name (or
      // any other public_info field) shows up on the public site within
      // a few seconds of saving instead of up to a minute later.
      res.setHeader('Vercel-CDN-Cache-Control', 'max-age=5, stale-while-revalidate=30');
      res.status(200).json({ ok: true, info });
    } catch (err) {
      console.error('public_info read error:', err.message);
      res.status(200).json({ ok: true, info: {} });
    }
    return;
  }

  // Staff permissions (what a non-admin may do with orders), readable by
  // any logged-in user so the order form and Orders list can lock themselves.
  if (req.method === 'GET' && req.query && req.query.view === 'permissions') {
    const sessionUser = requireAuth(req, res);
    if (!sessionUser) return;
    const permissions = await getPermissions();
    const labels = {};
    for (const k of Object.keys(PERMISSIONS)) labels[k] = { label: PERMISSIONS[k].label, hint: PERMISSIONS[k].hint };
    res.status(200).json({ ok: true, role: sessionUser.role, permissions, labels });
    return;
  }

  if (req.method === 'GET' && req.query && req.query.view === 'team') {
    // Public: the optometrists shown on the home page.
    try {
      const team = publicTeam(await readSetting('optometrists'));
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Vercel-CDN-Cache-Control', 'max-age=60, stale-while-revalidate=300');
      res.status(200).json({ ok: true, team });
    } catch (err) {
      console.error('team read error:', err.message);
      res.status(200).json({ ok: true, team: [] });
    }
    return;
  }

  if (req.method === 'GET' && req.query && req.query.view === 'team_photo') {
    // Public: one optometrist photo. The URL carries a hash of the image
    // (v=...), so it can be cached for a long time.
    try {
      const id = String(req.query.id || '');
      const meta = await readSetting('optometrists');
      const entry = ((meta && meta.entries) || []).find(e => e.id === id && e.active !== false);
      const photos = entry ? await readSetting('optometrist_photos') : null;
      const img = photos && decodePhoto(photos[id]);
      if (!img) { res.status(404).json({ ok: false, error: 'Photo not found.' }); return; }
      res.setHeader('Content-Type', img.type);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).end(img.buf);
    } catch (err) {
      console.error('team_photo error:', err.message);
      res.status(502).json({ ok: false, error: 'Could not load photo.' });
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

  if (req.method === 'GET' && req.query && req.query.view === 'dashboard') {
    if (!requireAdmin(req, res)) return;
    return getDashboard(req, res);
  }

  if (req.method === 'GET' && req.query && req.query.view === 'ai_usage') {
    // AI usage + estimated cost -- admin only.
    if (!requireAdmin(req, res)) return;
    return getAiUsage(req, res);
  }

  if (req.method === 'GET' && req.query && req.query.view === 'aeo_snippet') {
    // Admin only -- generates the static FAQ + JSON-LD HTML to paste into
    // index.html so hours/FAQ text stays crawlable and in sync with
    // Settings. See buildAeoSnippet() above for why this can't just be
    // rendered live.
    if (!requireAdmin(req, res)) return;
    try {
      const [biz, knowledge] = await Promise.all([readSetting('business_info'), loadKnowledge()]);
      const snippet = buildAeoSnippet(biz, knowledge);
      res.status(200).json({ ok: true, ...snippet });
    } catch (err) {
      console.error('aeo_snippet error:', err.message);
      res.status(502).json({ ok: false, error: 'Could not build the AEO snippet right now.' });
    }
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
