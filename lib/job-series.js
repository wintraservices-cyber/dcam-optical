// Job code series: how Rx and Non-Rx job order numbers are built and counted.
// Stored in app_settings under "job_series" and edited by an admin in
// Settings > Rx ranges > Job code series. A number is
//     <prefix> [YYYY-] [MM-] <counter>
// e.g. Rx "2026-2768" (defaults), Non-Rx "2026-10-0004" (defaults), or with a
// prefix "RX-2026-0012". The counter restarts yearly, monthly or never.
// A missing or partial setting falls back to the defaults below, which
// reproduce the numbering used before this was configurable.
//
// The number is only a suggestion on the order form (an admin, or staff when
// the "change job number" permission is on, can type their own) and nothing
// reserves it.

const { supabaseRequest } = require('./supabase');

const TYPES = ['rx', 'non_rx'];
const DEFAULTS = {
  rx:     { prefix: '', include_year: true, include_month: false, digits: 4, reset: 'yearly',  start: 1 },
  non_rx: { prefix: '', include_year: true, include_month: true,  digits: 4, reset: 'monthly', start: 1 },
};

class JobSeriesError extends Error {}

function cleanInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeOne(src, def) {
  const s = src && typeof src === 'object' ? src : {};
  const out = {
    prefix: typeof s.prefix === 'string' ? s.prefix.replace(/[^A-Za-z0-9-]/g, '').toUpperCase().slice(0, 5) : def.prefix,
    include_year: typeof s.include_year === 'boolean' ? s.include_year : def.include_year,
    include_month: typeof s.include_month === 'boolean' ? s.include_month : def.include_month,
    digits: cleanInt(s.digits, 3, 6, def.digits),
    reset: ['yearly', 'monthly', 'never'].includes(s.reset) ? s.reset : def.reset,
    start: cleanInt(s.start, 1, 999999, def.start),
  };
  // A restart period needs that date part in the number to tell periods apart.
  if (out.reset === 'monthly') { out.include_year = true; out.include_month = true; }
  if (out.reset === 'yearly') out.include_year = true;
  if (out.include_month) out.include_year = true; // a month alone is ambiguous
  return out;
}

function normalizeJobSeries(value) {
  const src = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const t of TYPES) out[t] = normalizeOne(src[t], DEFAULTS[t]);
  const sig = (c) => `${c.prefix}|${c.include_year}|${c.include_month}`;
  if (sig(out.rx) === sig(out.non_rx)) {
    throw new JobSeriesError('Rx and Non-Rx need different codes so their numbers cannot clash. Change the prefix, or the year/month parts, of one of them.');
  }
  return out;
}

async function getJobSeries() {
  try {
    const resp = await supabaseRequest('app_settings?key=eq.job_series&limit=1', { method: 'GET' });
    if (!resp.ok) return normalizeJobSeries(null);
    const rows = await resp.json();
    return normalizeJobSeries(rows[0] ? rows[0].value : null);
  } catch (e) {
    // Includes a saved value that would clash: fall back to the defaults.
    return normalizeJobSeries(null);
  }
}

// Today's Manila (UTC+8) year and month.
function manilaYearMonth(now) {
  const d = new Date((now ? now.getTime() : Date.now()) + 8 * 3600 * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

function regexFor(cfg) {
  const esc = cfg.prefix.replace(/[^A-Za-z0-9]/g, '\\$&');
  return new RegExp(`^${esc}${cfg.include_year ? '(\\d{4})-' : ''}${cfg.include_month ? '(\\d{2})-' : ''}(\\d+)$`, 'i');
}

// -> { year, month, counter } or null when the number is not in this series.
function parseNumber(orderNo, cfg) {
  const m = String(orderNo || '').trim().match(regexFor(cfg));
  if (!m) return null;
  let i = 1;
  const year = cfg.include_year ? parseInt(m[i++], 10) : null;
  const month = cfg.include_month ? parseInt(m[i++], 10) : null;
  return { year, month, counter: parseInt(m[i], 10) };
}

function formatNumber(cfg, year, month, counter) {
  return cfg.prefix
    + (cfg.include_year ? `${year}-` : '')
    + (cfg.include_month ? `${String(month).padStart(2, '0')}-` : '')
    + String(counter).padStart(cfg.digits, '0');
}

function inPeriod(p, cfg, year, month) {
  if (cfg.reset === 'never') return true;
  if (p.year !== year) return false;
  if (cfg.reset === 'monthly') return p.month === month;
  return true;
}

// Pure: given the order numbers on file, the last order in the series and
// the next number to hand out.
function evaluate(cfg, rows, now) {
  const { year, month } = manilaYearMonth(now);
  let last = null, lastKey = null, maxInPeriod = 0;
  for (const r of rows || []) {
    const p = parseNumber(r.order_no, cfg);
    if (!p) continue;
    const key = [p.year || 0, p.month || 0, p.counter];
    if (!lastKey || key[0] > lastKey[0] || (key[0] === lastKey[0] && (key[1] > lastKey[1] || (key[1] === lastKey[1] && key[2] > lastKey[2])))) {
      lastKey = key; last = r;
    }
    if (inPeriod(p, cfg, year, month) && p.counter > maxInPeriod) maxInPeriod = p.counter;
  }
  const nextCounter = Math.max(maxInPeriod + 1, cfg.start);
  return { last, next: formatNumber(cfg, year, month, nextCounter) };
}

async function loadRows(cfg, now) {
  const { year } = manilaYearMonth(now);
  // Narrow the query to this series; the exact match is done in JS.
  const like = cfg.prefix + (cfg.include_year && cfg.reset !== 'never' ? `${year}-` : '') + '%';
  const resp = await supabaseRequest(
    `orders?select=order_no,patient_name,created_at,order_date&deleted_at=is.null&order_no=ilike.${encodeURIComponent(like)}&order=order_no.desc&limit=1000`,
    { method: 'GET' }
  );
  if (!resp.ok) throw new Error(`orders read ${resp.status}`);
  return resp.json();
}

// Both series, for the Settings card. A year-reset series that has not
// issued a number yet this year still shows its last order from earlier.
async function describeSeries(config, now) {
  const out = {};
  for (const t of TYPES) {
    const cfg = config[t];
    let rows = await loadRows(cfg, now);
    let ev = evaluate(cfg, rows, now);
    if (!ev.last && cfg.include_year && cfg.reset !== 'never') {
      // nothing this year: look at the whole series for "last order"
      const resp = await supabaseRequest(
        `orders?select=order_no,patient_name,created_at,order_date&deleted_at=is.null&order_no=ilike.${encodeURIComponent(cfg.prefix + '%')}&order=order_no.desc&limit=1000`,
        { method: 'GET' }
      );
      if (resp.ok) ev = { ...evaluate(cfg, await resp.json(), now), next: ev.next };
    }
    out[t] = {
      next: ev.next,
      last: ev.last ? { order_no: ev.last.order_no, patient_name: ev.last.patient_name || '', created_at: ev.last.created_at, order_date: ev.last.order_date || '' } : null,
    };
  }
  return out;
}

// The next number for one type, or null if it cannot be worked out.
async function nextNumber(orderType, now) {
  if (!TYPES.includes(orderType)) return null;
  const config = await getJobSeries();
  const cfg = config[orderType];
  const rows = await loadRows(cfg, now);
  return evaluate(cfg, rows, now).next;
}

module.exports = { TYPES, DEFAULTS, JobSeriesError, normalizeJobSeries, getJobSeries, parseNumber, formatNumber, evaluate, describeSeries, nextNumber, manilaYearMonth };
