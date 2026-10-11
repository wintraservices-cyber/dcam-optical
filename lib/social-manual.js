// Hand-entered Facebook / Instagram numbers for Website insights, for when
// the Meta connection (token in Vercel) is not set up yet. They are saved in
// the same social_daily table the daily Meta save uses, one row per day per
// platform, so the existing totals and charts read them with no extra code.
// Tip shown to staff: type a month's totals from Meta Business Suite against
// the last day of that month; the period filter then adds them up correctly.

const { supabaseRequest } = require('./supabase');

const PLATFORMS = ['facebook', 'instagram'];
const NUM_FIELDS = ['followers', 'posts_published', 'views', 'reach', 'engagements', 'new_follows', 'link_taps'];
const MAX = 1000000000;

function cleanEntry(raw) {
  const e = raw && typeof raw === 'object' ? raw : {};
  const platform = String(e.platform || '').toLowerCase();
  if (!PLATFORMS.includes(platform)) return { error: 'Choose Facebook or Instagram.' };
  const day = String(e.day || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day + 'T00:00:00Z'))) return { error: 'Enter a valid date.' };
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
  if (day > tomorrow) return { error: 'The date is in the future.' };
  const row = { day, platform };
  let any = false;
  for (const f of NUM_FIELDS) {
    const v = e[f];
    if (v === undefined || v === null || String(v).trim() === '') continue;
    const n = Number(String(v).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < 0 || n > MAX) return { error: 'Numbers must be zero or more (no letters).' };
    row[f] = Math.round(n);
    any = true;
  }
  if (!any) return { error: 'Enter at least one number.' };
  row.updated_at = new Date().toISOString();
  return { row };
}

function tableMissing(text) {
  return /social_daily/.test(text) && /(does not exist|42P01|PGRST205)/.test(text);
}

async function saveEntry(raw) {
  const { row, error } = cleanEntry(raw);
  if (error) return { ok: false, status: 400, error };
  const resp = await supabaseRequest('social_daily?on_conflict=day,platform', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
  if (!resp.ok) {
    const text = await resp.text();
    if (tableMissing(text)) return { ok: false, status: 503, error: 'The social_daily table does not exist yet. Run the latest supabase-schema.sql in Supabase.' };
    console.error('social manual save ' + resp.status + ': ' + text.slice(0, 200));
    return { ok: false, status: 502, error: 'Could not save these numbers right now.' };
  }
  return { ok: true };
}

async function deleteEntry(day, platform) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) || !PLATFORMS.includes(String(platform || ''))) return { ok: false, status: 400, error: 'Unknown entry.' };
  const resp = await supabaseRequest('social_daily?day=eq.' + day + '&platform=eq.' + platform, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (!resp.ok) return { ok: false, status: 502, error: 'Could not remove that entry.' };
  return { ok: true };
}

async function recentEntries(limit) {
  const cols = ['day', 'platform'].concat(NUM_FIELDS).join(',');
  const resp = await supabaseRequest('social_daily?select=' + cols + '&order=day.desc,platform.asc&limit=' + (limit || 40), { method: 'GET' });
  if (!resp.ok) return null;
  return resp.json();
}

module.exports = { saveEntry, deleteEntry, recentEntries, cleanEntry, PLATFORMS };
