// Read-only Facebook Page + Instagram numbers for Settings > Website >
// Website insights (the "Social media" section).
//
// Uses Meta's Graph API over plain HTTPS (no extra packages). Environment
// variables in Vercel (Production):
//   META_PAGE_ID            the Facebook Page's numeric ID
//   META_PAGE_ACCESS_TOKEN  a long-lived Page access token (ideally from a
//                           Business Manager system user, so it never expires)
//                           with pages_read_engagement, read_insights and, for
//                           Instagram, instagram_basic + instagram_manage_insights
//   META_IG_USER_ID         optional; found automatically from the Page's
//                           linked Instagram professional account
//   META_APP_SECRET         optional but recommended; signs every call
//                           (appsecret_proof) so a leaked token alone is less useful
//   META_GRAPH_VERSION      optional; defaults to v26.0
// With the Page ID or token missing the section simply shows "not connected".
// The token is never sent to the browser. Nothing here writes to Meta.
//
// Metric names follow Meta's Nov 2025 Page changes (page_impressions ->
// page_media_view, page_fans -> page_follows) and the Apr 2025 Instagram
// change (impressions -> views). Each metric is asked for on its own when a
// combined request fails, so one renamed metric only blanks one number.

const crypto = require('crypto');

const VERSION = () => (/^v\d+\.\d+$/.test(process.env.META_GRAPH_VERSION || '') ? process.env.META_GRAPH_VERSION : 'v26.0');
const DAY = 86400;

function config() {
  const pageId = String(process.env.META_PAGE_ID || '').replace(/\D/g, '');
  const token = String(process.env.META_PAGE_ACCESS_TOKEN || '').trim();
  if (!pageId || !token) return null;
  const igId = String(process.env.META_IG_USER_ID || '').replace(/\D/g, '') || null;
  const secret = String(process.env.META_APP_SECRET || '').trim();
  const proof = secret ? crypto.createHmac('sha256', secret).update(token).digest('hex') : null;
  return { pageId, token, igId, proof };
}

class MetaError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function graph(cfg, path, params) {
  const qs = new URLSearchParams({ ...(params || {}), access_token: cfg.token });
  if (cfg.proof) qs.set('appsecret_proof', cfg.proof);
  const resp = await fetch(`https://graph.facebook.com/${VERSION()}/${path}?${qs}`, { method: 'GET' });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const e = data.error || {};
    throw new MetaError(e.message || ('Meta API ' + resp.status), e.code);
  }
  return data;
}

// Manila calendar days -> unix seconds. until is exclusive (next midnight).
const manilaMidnight = (iso) => Math.floor(Date.parse(iso + 'T00:00:00+08:00') / 1000);
const manilaToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
function shift(iso, days) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Split [since, until) into windows of at most maxDays (Meta's per-call limits:
// about 93 days for Page insights, 30 days for Instagram account insights).
function windows(since, until, maxDays) {
  const out = [];
  for (let s = since; s < until; s += maxDays * DAY) out.push([s, Math.min(until, s + maxDays * DAY)]);
  return out;
}

const dayOf = (endTime) => {
  // Daily values carry end_time = the next day's start (Pacific time); the
  // day they describe is the one before it.
  const t = Date.parse(endTime);
  return Number.isFinite(t) ? new Date(t - 12 * 3600000).toISOString().slice(0, 10) : null;
};

// ----- Facebook Page -----

const FB_METRICS = ['page_media_view', 'page_post_engagements', 'page_daily_follows_unique'];

async function pageMetric(cfg, metric, since, until) {
  let total = 0;
  const daily = {};
  for (const [s, u] of windows(since, until, 90)) {
    const data = await graph(cfg, `${cfg.pageId}/insights`, { metric, period: 'day', since: String(s), until: String(u) });
    const series = (data.data || [])[0];
    (series && series.values || []).forEach(v => {
      const n = typeof v.value === 'number' ? v.value : 0;
      total += n;
      const d = dayOf(v.end_time);
      if (d) daily[d] = (daily[d] || 0) + n;
    });
  }
  return { total, daily };
}

async function facebookBlock(cfg, since, until, prev) {
  const out = { name: null, link: null, followers: null, metrics: {}, previous: {}, daily: null, posts: [], unavailable: [] };
  try {
    const p = await graph(cfg, cfg.pageId, { fields: 'name,link,followers_count' });
    out.name = p.name || null; out.link = p.link || null;
    out.followers = typeof p.followers_count === 'number' ? p.followers_count : null;
  } catch (e) {
    if (e.code === 190) throw e;
    try { const p = await graph(cfg, cfg.pageId, { fields: 'name,link' }); out.name = p.name || null; out.link = p.link || null; } catch (e2) { /* keep going */ }
  }
  await Promise.all(FB_METRICS.map(async m => {
    try {
      const cur = await pageMetric(cfg, m, since, until);
      out.metrics[m] = cur.total;
      if (m === 'page_media_view') out.daily = cur.daily;
      if (prev) out.previous[m] = (await pageMetric(cfg, m, prev[0], prev[1])).total;
    } catch (e) {
      if (e.code === 190) throw e;
      out.metrics[m] = null;
      out.unavailable.push(m);
    }
  }));
  try {
    const posts = await graph(cfg, `${cfg.pageId}/posts`, {
      fields: 'message,created_time,permalink_url,full_picture,shares,reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0)',
      limit: '5',
    });
    out.posts = (posts.data || []).map(x => ({
      text: String(x.message || '').slice(0, 160),
      at: x.created_time || null,
      url: safeUrl(x.permalink_url),
      image: safeUrl(x.full_picture),
      reactions: (x.reactions && x.reactions.summary && x.reactions.summary.total_count) || 0,
      comments: (x.comments && x.comments.summary && x.comments.summary.total_count) || 0,
      shares: (x.shares && x.shares.count) || 0,
    }));
  } catch (e) {
    if (e.code === 190) throw e;
    out.unavailable.push('posts');
  }
  return out;
}

// ----- Instagram (professional account linked to the Page) -----

const IG_METRICS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'profile_links_taps'];

async function igTotals(cfg, igId, since, until, metrics) {
  const totals = {};
  const wins = windows(since, until, 30);
  for (const [s, u] of wins) {
    const data = await graph(cfg, `${igId}/insights`, { metric: metrics.join(','), period: 'day', metric_type: 'total_value', since: String(s), until: String(u) });
    (data.data || []).forEach(m => {
      const v = m.total_value && typeof m.total_value.value === 'number' ? m.total_value.value : 0;
      totals[m.name] = (totals[m.name] || 0) + v;
    });
  }
  return { totals, windows: wins.length };
}

// Ask for every metric at once; if Meta rejects the batch (one renamed or
// unsupported metric fails the whole call), fall back to one at a time.
async function igTotalsTolerant(cfg, igId, since, until) {
  try {
    const r = await igTotals(cfg, igId, since, until, IG_METRICS);
    return { ...r, unavailable: IG_METRICS.filter(m => !(m in r.totals)) };
  } catch (e) {
    if (e.code === 190) throw e;
    const totals = {}; const unavailable = []; let wins = 1;
    for (const m of IG_METRICS) {
      try { const r = await igTotals(cfg, igId, since, until, [m]); totals[m] = r.totals[m] || 0; wins = r.windows; }
      catch (e2) { if (e2.code === 190) throw e2; unavailable.push(m); }
    }
    return { totals, windows: wins, unavailable };
  }
}

async function igDailyReach(cfg, igId, since, until) {
  const daily = {};
  for (const [s, u] of windows(since, until, 30)) {
    const data = await graph(cfg, `${igId}/insights`, { metric: 'reach', period: 'day', metric_type: 'time_series', since: String(s), until: String(u) });
    const series = (data.data || [])[0];
    (series && series.values || []).forEach(v => { const d = dayOf(v.end_time); if (d) daily[d] = (daily[d] || 0) + (Number(v.value) || 0); });
  }
  return daily;
}

async function instagramBlock(cfg, since, until, prev) {
  let igId = cfg.igId;
  if (!igId) {
    try {
      const p = await graph(cfg, cfg.pageId, { fields: 'instagram_business_account{id}' });
      igId = p.instagram_business_account && p.instagram_business_account.id;
    } catch (e) { if (e.code === 190) throw e; }
  }
  if (!igId) return { linked: false };
  const out = { linked: true, username: null, followers: null, posts_total: null, metrics: {}, previous: {}, approx: false, daily: null, posts: [], unavailable: [] };
  try {
    const u = await graph(cfg, igId, { fields: 'username,followers_count,media_count' });
    out.username = u.username || null;
    out.followers = typeof u.followers_count === 'number' ? u.followers_count : null;
    out.posts_total = typeof u.media_count === 'number' ? u.media_count : null;
  } catch (e) {
    if (e.code === 190) throw e;
    out.unavailable.push('profile');
  }
  const cur = await igTotalsTolerant(cfg, igId, since, until);
  IG_METRICS.forEach(m => { out.metrics[m] = cur.unavailable.includes(m) ? null : (cur.totals[m] || 0); });
  out.unavailable.push(...cur.unavailable);
  // Reach and accounts engaged count each person once per window; adding up
  // several 30-day windows can count the same person twice.
  out.approx = cur.windows > 1;
  if (prev) {
    try { const old = await igTotalsTolerant(cfg, igId, prev[0], prev[1]); IG_METRICS.forEach(m => { out.previous[m] = old.unavailable.includes(m) ? null : (old.totals[m] || 0); }); }
    catch (e) { if (e.code === 190) throw e; }
  }
  try { out.daily = await igDailyReach(cfg, igId, since, until); } catch (e) { if (e.code === 190) throw e; }
  try {
    const media = await graph(cfg, `${igId}/media`, { fields: 'caption,media_type,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url', limit: '5' });
    out.posts = (media.data || []).map(x => ({
      text: String(x.caption || '').slice(0, 160),
      at: x.timestamp || null,
      url: safeUrl(x.permalink),
      image: safeUrl(x.media_type === 'VIDEO' ? x.thumbnail_url : x.media_url),
      likes: x.like_count || 0,
      comments: x.comments_count || 0,
    }));
  } catch (e) {
    if (e.code === 190) throw e;
    out.unavailable.push('posts');
  }
  return out;
}

function safeUrl(u) {
  return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;
}

// Results are kept for 10 minutes per period so reopening the tab doesn't
// spend Meta API calls (Meta rate-limits per Page).
const cache = new Map();

// from / to: YYYY-MM-DD (Manila) or null. Meta keeps about two years of
// insights and needs a bounded range, so an open range means "last 28 days".
async function socialSummary(from, to, prevRange) {
  const cfg = config();
  if (!cfg) return { configured: false };
  const today = manilaToday();
  let f = from, t = to, defaulted = false;
  if (!f || !t) { t = today; f = shift(today, -27); defaulted = true; }
  if (t > today) t = today;
  const key = [f, t, prevRange ? prevRange.from : '', defaulted].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.value;

  const since = manilaMidnight(f);
  const until = Math.min(manilaMidnight(shift(t, 1)), Math.floor(Date.now() / 1000));
  const prev = !defaulted && prevRange ? [manilaMidnight(prevRange.from), manilaMidnight(shift(prevRange.to, 1))] : null;
  let value;
  try {
    const [facebook, instagram] = await Promise.all([
      facebookBlock(cfg, since, until, prev),
      instagramBlock(cfg, since, until, prev).catch(e => { if (e.code === 190) throw e; return { linked: true, error: 'Instagram did not answer: ' + e.message }; }),
    ]);
    value = { configured: true, range: { from: f, to: t, defaulted }, facebook, instagram };
  } catch (e) {
    value = {
      configured: true,
      error: e.code === 190
        ? 'The Meta access token has expired or was revoked. Create a new Page token and update META_PAGE_ACCESS_TOKEN in Vercel.'
        : 'Meta did not answer: ' + e.message,
    };
  }
  if (!value.error) cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { socialSummary, graph, config, windows, dayOf, manilaMidnight, manilaToday, shift, _test: { windows, dayOf, config } };
