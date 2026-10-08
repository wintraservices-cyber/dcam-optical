// Read-only Google Analytics (GA4) numbers for the Settings > Dashboard tab.
//
// Uses a Google service account that only has "Viewer" on the property, and
// the GA4 Data API over plain HTTPS (no extra packages). Two environment
// variables in Vercel switch it on:
//   GA4_PROPERTY_ID            e.g. 558122620
//   GA4_SERVICE_ACCOUNT_JSON   the full contents of the service account's JSON key
// With either missing the dashboard simply shows "not connected". The key is
// never sent to the browser.

const crypto = require('crypto');

let cached = { token: null, exp: 0 };

function credentials() {
  const raw = process.env.GA4_SERVICE_ACCOUNT_JSON;
  const id = String(process.env.GA4_PROPERTY_ID || '').replace(/\D/g, '');
  if (!raw || !id) return null;
  try {
    const key = JSON.parse(raw);
    if (!key.client_email || !key.private_key) return null;
    return { email: key.client_email, privateKey: String(key.private_key).replace(/\\n/g, '\n'), propertyId: id };
  } catch (e) {
    return null;
  }
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

async function accessToken(cred) {
  if (cached.token && Date.now() < cached.exp - 60000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claim = b64url({
    iss: cred.email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(cred.privateKey).toString('base64url');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new Error('GA4 sign-in failed: ' + (data.error_description || data.error || resp.status));
  cached = { token: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000 };
  return cached.token;
}

async function runReport(cred, token, body) {
  const resp = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${cred.propertyId}:runReport`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error('GA4 report failed: ' + ((data.error && data.error.message) || resp.status));
  return data;
}

const rows = (data) => (data.rows || []).map(r => ({
  dims: (r.dimensionValues || []).map(d => d.value),
  vals: (r.metricValues || []).map(m => Number(m.value) || 0),
}));

const KEY_EVENTS = ['start_intake', 'chat_open', 'track_order_check', 'click_phone', 'click_directions', 'click_email'];

// from / to: YYYY-MM-DD or null (= everything since the property started).
// prev: { from, to } or null.
async function analyticsSummary(from, to, prev) {
  const cred = credentials();
  if (!cred) return { configured: false };
  const token = await accessToken(cred);
  const start = from || '2020-01-01';
  const end = to || 'today';
  const ranges = [{ startDate: start, endDate: end, name: 'cur' }];
  if (prev) ranges.push({ startDate: prev.from, endDate: prev.to, name: 'prev' });
  const rep = (b) => runReport(cred, token, b);
  const [totals, daily, channels, devices, pages, events, regions] = await Promise.all([
    rep({ dateRanges: ranges, metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }] }),
    rep({ dateRanges: [ranges[0]], dimensions: [{ name: 'date' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ dimension: { dimensionName: 'date' } }], limit: 400 }),
    rep({ dateRanges: [ranges[0]], dimensions: [{ name: 'sessionDefaultChannelGroup' }], metrics: [{ name: 'sessions' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 8 }),
    rep({ dateRanges: [ranges[0]], dimensions: [{ name: 'deviceCategory' }], metrics: [{ name: 'activeUsers' }], limit: 5 }),
    rep({ dateRanges: [ranges[0]], dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }], limit: 6 }),
    rep({ dateRanges: [ranges[0]], dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }], dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: KEY_EVENTS } } }, limit: 20 }),
    rep({ dateRanges: [ranges[0]], dimensions: [{ name: 'region' }], metrics: [{ name: 'activeUsers' }], orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }], limit: 5 }),
  ]);
  // With two date ranges GA4 adds a dateRange dimension to each row (last dim).
  const t = { cur: [0, 0, 0, 0], prev: null };
  rows(totals).forEach(r => { const which = r.dims[r.dims.length - 1] === 'prev' ? 'prev' : 'cur'; t[which] = r.vals; });
  const ev = {};
  rows(events).forEach(r => { ev[r.dims[0]] = r.vals[0]; });
  return {
    configured: true,
    users: { cur: t.cur[0], prev: prev ? (t.prev ? t.prev[0] : 0) : null },
    new_users: { cur: t.cur[1], prev: prev ? (t.prev ? t.prev[1] : 0) : null },
    sessions: t.cur[2],
    views: { cur: t.cur[3], prev: prev ? (t.prev ? t.prev[3] : 0) : null },
    daily: rows(daily).map(r => ({ day: r.dims[0].replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), users: r.vals[0] })),
    channels: rows(channels).map(r => ({ name: r.dims[0], sessions: r.vals[0] })),
    devices: rows(devices).map(r => ({ name: r.dims[0], users: r.vals[0] })),
    pages: rows(pages).map(r => ({ path: r.dims[0], views: r.vals[0] })),
    regions: rows(regions).map(r => ({ name: r.dims[0], users: r.vals[0] })),
    events: KEY_EVENTS.reduce((o, k) => { o[k] = ev[k] || 0; return o; }, {}),
  };
}

module.exports = { analyticsSummary };
