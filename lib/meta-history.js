// Daily history of the Facebook Page and Instagram numbers (social_daily
// table), so Website insights can show "All time", follower growth and
// posts published even after Meta's own window has passed. Meta has no
// follower history at all for Instagram, so a day not saved is lost.
//
// runSnapshot() is called once a day by a Vercel cron job (vercel.json,
// GET /api/settings?action=social_snapshot with "Authorization: Bearer
// CRON_SECRET") and on demand by an admin ("Save now" in Website
// insights). Each run:
//   1. records today's follower counts and post totals,
//   2. re-saves the last 3 days (Meta revises recent numbers),
//   3. backfills one older chunk (Facebook 90 days, Instagram 30 days)
//      until Meta has nothing older or two years are covered.
// Read-only towards Meta. One row per day per platform.

const { supabaseRequest } = require('./supabase');
const { graph, config, windows, dayOf, manilaMidnight, manilaToday, shift } = require('./meta-insights');

const DAY = 86400;
const MAX_BACK_DAYS = 730;
const FB_CHUNK = 90;
const IG_CHUNK = 30;
const COLS = ['followers', 'posts_total', 'posts_published', 'views', 'reach', 'engagements', 'new_follows', 'accounts_engaged', 'link_taps'];

// ---- Meta reads ----

// Page insight metric -> { 'YYYY-MM-DD': value } for [since, until).
async function pageDaily(cfg, metric, since, until) {
  const out = {};
  for (const [s, u] of windows(since, until, 90)) {
    const data = await graph(cfg, `${cfg.pageId}/insights`, { metric, period: 'day', since: String(s), until: String(u) });
    const series = (data.data || [])[0];
    (series && series.values || []).forEach(v => { const d = dayOf(v.end_time); if (d && typeof v.value === 'number') out[d] = v.value; });
  }
  return out;
}

// Lists posts (Facebook) or media (Instagram) and counts them per Manila day.
async function postsByDay(cfg, path, timeField) {
  const perDay = {};
  let total = 0, after = null, capped = false;
  for (let page = 0; page < 20; page++) {
    const params = { fields: timeField, limit: '100' };
    if (after) params.after = after;
    const data = await graph(cfg, path, params);
    (data.data || []).forEach(x => {
      total++;
      const t = Date.parse(x[timeField]);
      if (Number.isFinite(t)) { const d = new Date(t + 8 * 3600000).toISOString().slice(0, 10); perDay[d] = (perDay[d] || 0) + 1; }
    });
    after = data.paging && data.paging.next && data.paging.cursors && data.paging.cursors.after;
    if (!after) break;
    if (page === 19) capped = true;
  }
  return { perDay, total, capped };
}

async function igUserId(cfg) {
  if (cfg.igId) return cfg.igId;
  const p = await graph(cfg, cfg.pageId, { fields: 'instagram_business_account{id}' });
  return (p.instagram_business_account && p.instagram_business_account.id) || null;
}

const IG_METRICS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'profile_links_taps'];

// Which Instagram metrics Meta accepts right now (asked once per run).
async function igSupported(cfg, igId, since) {
  const params = (m) => ({ metric: m, period: 'day', metric_type: 'total_value', since: String(since), until: String(since + DAY) });
  try { await graph(cfg, `${igId}/insights`, params(IG_METRICS.join(','))); return IG_METRICS; }
  catch (e) {
    if (e.code === 190) throw e;
    const ok = [];
    for (const m of IG_METRICS) { try { await graph(cfg, `${igId}/insights`, params(m)); ok.push(m); } catch (e2) { if (e2.code === 190) throw e2; } }
    return ok;
  }
}

// One total_value call per day (that is how Meta reports these). Days run 5 at a time.
async function igDaily(cfg, igId, days, metrics) {
  const out = {};
  if (!metrics.length) return out;
  for (let i = 0; i < days.length; i += 5) {
    await Promise.all(days.slice(i, i + 5).map(async day => {
      const since = manilaMidnight(day);
      const data = await graph(cfg, `${igId}/insights`, { metric: metrics.join(','), period: 'day', metric_type: 'total_value', since: String(since), until: String(since + DAY) });
      const row = {};
      (data.data || []).forEach(m => { row[m.name] = m.total_value && typeof m.total_value.value === 'number' ? m.total_value.value : 0; });
      out[day] = row;
    }));
  }
  return out;
}

const dayList = (from, to) => { const out = []; for (let d = from; d <= to; d = shift(d, 1)) out.push(d); return out; };

// ---- Database ----

// Upsert rows; rows are grouped by which columns they carry so a missing
// value (e.g. no follower count for an old day) never overwrites a saved one.
async function saveRows(rows) {
  const groups = {};
  rows.forEach(r => {
    const clean = { day: r.day, platform: r.platform, updated_at: new Date().toISOString() };
    COLS.forEach(c => { if (r[c] != null && Number.isFinite(Number(r[c]))) clean[c] = Math.round(Number(r[c])); });
    const key = Object.keys(clean).sort().join(',');
    (groups[key] = groups[key] || []).push(clean);
  });
  let saved = 0;
  for (const g of Object.values(groups)) {
    const resp = await supabaseRequest('social_daily?on_conflict=day,platform', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(g),
    });
    if (!resp.ok) {
      const text = await resp.text();
      if (/social_daily/.test(text) && /(does not exist|42P01|PGRST205)/.test(text)) throw Object.assign(new Error('The social_daily table does not exist yet. Run the latest supabase-schema.sql in Supabase.'), { migration: true });
      throw new Error('social_daily save ' + resp.status + ': ' + text.slice(0, 200));
    }
    saved += g.length;
  }
  return saved;
}

async function readState() {
  const resp = await supabaseRequest('app_settings?key=eq.social_backfill&limit=1', { method: 'GET' });
  if (!resp.ok) return {};
  const rows = await resp.json();
  return (rows[0] && rows[0].value) || {};
}

async function writeState(state) {
  await supabaseRequest('app_settings?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ key: 'social_backfill', value: state, updated_at: new Date().toISOString(), updated_by: 'social snapshot' }),
  });
}

// ---- The daily run ----

async function runSnapshot() {
  const cfg = config();
  if (!cfg) return { ok: false, error: 'Facebook / Instagram is not connected (META_PAGE_ID and META_PAGE_ACCESS_TOKEN in Vercel).' };
  const today = manilaToday();
  // Counts taken in the small hours belong to the day that just ended.
  const snapDay = new Date(Date.now() + 8 * 3600000 - 2 * 3600000).toISOString().slice(0, 10);
  const recentFrom = shift(today, -3);
  const state = await readState();
  const report = { ok: true, saved: 0, facebook: {}, instagram: {} };
  const rows = [];

  // Facebook
  try {
    const fbState = state.facebook || {};
    const ranges = [[recentFrom, today]];
    if (!fbState.done) {
      const end = fbState.earliest ? shift(fbState.earliest, -1) : shift(recentFrom, -1);
      const start = shift(end, -(FB_CHUNK - 1));
      if (start >= shift(today, -MAX_BACK_DAYS)) ranges.push([start, end]);
      else fbState.done = true;
    }
    const posts = await postsByDay(cfg, `${cfg.pageId}/posts`, 'created_time');
    let backfillEmpty = true;
    for (const [from, to] of ranges) {
      const since = manilaMidnight(from), until = Math.min(manilaMidnight(shift(to, 1)), Math.floor(Date.now() / 1000));
      const metric = async (m) => { try { return await pageDaily(cfg, m, since, until); } catch (e) { if (e.code === 190) throw e; return {}; } };
      const [views, eng, follows, total] = await Promise.all(['page_media_view', 'page_post_engagements', 'page_daily_follows_unique', 'page_follows'].map(metric));
      dayList(from, to).forEach(day => {
        // Meta's daily follower total only for finished days; today's count comes from the snapshot below.
        const r = { day, platform: 'facebook', views: views[day], engagements: eng[day], new_follows: follows[day], followers: day < snapDay ? total[day] : null, posts_published: posts.perDay[day] || 0 };
        const any = !!(views[day] || eng[day] || follows[day] || total[day] || posts.perDay[day]);
        if (from !== recentFrom) {
          if (!any) return; // before the Page existed: nothing to keep
          backfillEmpty = false;
        }
        rows.push(r);
      });
      if (from !== recentFrom) {
        fbState.earliest = from;
        if (backfillEmpty) fbState.done = true;
      }
    }
    const p = await graph(cfg, cfg.pageId, { fields: 'followers_count' }).catch(e => { if (e.code === 190) throw e; return {}; });
    rows.push({ day: snapDay, platform: 'facebook', followers: p.followers_count, posts_total: posts.capped ? null : posts.total });
    state.facebook = fbState;
    report.facebook = { followers: p.followers_count ?? null, backfilled_to: fbState.earliest || null, backfill_done: !!fbState.done };
  } catch (e) {
    if (e.code === 190) return { ok: false, error: 'The Meta access token has expired or was revoked. Create a new Page token and update META_PAGE_ACCESS_TOKEN in Vercel.' };
    report.facebook = { error: e.message };
  }

  // Instagram
  try {
    const igId = await igUserId(cfg);
    if (!igId) report.instagram = { linked: false };
    else {
      const igState = state.instagram || {};
      let days = dayList(recentFrom, shift(today, -1));
      let backfill = [];
      if (!igState.done) {
        const end = igState.earliest ? shift(igState.earliest, -1) : shift(recentFrom, -1);
        const start = shift(end, -(IG_CHUNK - 1));
        if (start >= shift(today, -MAX_BACK_DAYS)) backfill = dayList(start, end);
        else igState.done = true;
      }
      const metrics = await igSupported(cfg, igId, manilaMidnight(shift(today, -1)));
      const [recent, older, posts, u] = await Promise.all([
        igDaily(cfg, igId, days, metrics),
        igDaily(cfg, igId, backfill, metrics).catch(e => { if (e.code === 190) throw e; return {}; }),
        postsByDay(cfg, `${igId}/media`, 'timestamp'),
        graph(cfg, igId, { fields: 'followers_count,media_count' }),
      ]);
      const all = { ...older, ...recent };
      let backfillEmpty = true;
      [...backfill, ...days].forEach(day => {
        const m = all[day] || {};
        if (backfill.includes(day)) {
          if (!(Object.values(m).some(v => v) || posts.perDay[day])) return; // nothing that day
          backfillEmpty = false;
        }
        rows.push({ day, platform: 'instagram', views: m.views, reach: m.reach, engagements: m.total_interactions, accounts_engaged: m.accounts_engaged, link_taps: m.profile_links_taps, posts_published: posts.perDay[day] || 0 });
      });
      if (backfill.length) { igState.earliest = backfill[0]; if (backfillEmpty) igState.done = true; }
      rows.push({ day: snapDay, platform: 'instagram', followers: u.followers_count, posts_total: u.media_count });
      state.instagram = igState;
      report.instagram = { followers: u.followers_count ?? null, backfilled_to: igState.earliest || null, backfill_done: !!igState.done, metrics };
    }
  } catch (e) {
    if (e.code === 190) return { ok: false, error: 'The Meta access token has expired or was revoked. Create a new Page token and update META_PAGE_ACCESS_TOKEN in Vercel.' };
    report.instagram = { error: e.message };
  }

  report.saved = await saveRows(rows);
  await writeState(state);
  report.day = snapDay;
  return report;
}

// Saved days for a period (or everything when from/to are null).
async function readHistory(from, to) {
  let path = 'social_daily?select=day,platform,' + COLS.join(',') + '&order=day.asc&limit=5000';
  if (from) path += '&day=gte.' + from;
  if (to) path += '&day=lte.' + to;
  const resp = await supabaseRequest(path, { method: 'GET' });
  if (!resp.ok) return null; // table not created yet: history simply unavailable
  return resp.json();
}

module.exports = { runSnapshot, readHistory, COLS };
