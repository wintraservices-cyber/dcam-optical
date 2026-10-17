// Facebook Messenger + Instagram DM plumbing for the Ask Anita assistant.
// The AI part lives in api/chat.js (mode=meta) so Messenger and Instagram
// reuse exactly the same prompt, Clinic knowledge, order check, spending
// limit and Claude/Gemini switch as the website chat.
//
// Webhook URL to give Meta:  https://dcamoptical.com/api/meta-webhook
// (a rewrite in vercel.json to /api/chat?mode=meta; /api is at the Vercel
// Hobby limit of 12 functions, so this is not a separate function).
//
// Environment variables in Vercel (Production):
//   META_PAGE_ACCESS_TOKEN  system-user token from Business settings (never
//                           expires; swapped for the Page's own token
//                           automatically) or a Page token, with
//                           pages_messaging (+ instagram_manage_messages
//                           for Instagram). Shared with lib/meta-insights.js.
//   META_APP_SECRET         REQUIRED here: every webhook call is checked
//                           against Meta's X-Hub-Signature-256 with it.
//   META_VERIFY_TOKEN       any long random text; typed into Meta's webhook
//                           setup screen so Meta can confirm the URL.
//   META_APP_ID             the Meta app's ID; lets us tell our own replies
//                           apart from a person replying in the inbox.
//   META_PAGE_ID / META_IG_USER_ID / META_GRAPH_VERSION  as in meta-insights.js
//
// Nothing about the conversation is stored on DCAM's side. Earlier messages
// are read back from Meta when needed (Conversations API). The only thing
// saved is per-person state in meta_chat_state, keyed by a one-way hash of
// the Messenger/Instagram ID: when the bot must stay quiet because a person
// asked for staff or a staff member replied.

const crypto = require('crypto');
const { supabaseRequest } = require('./supabase');

const VERSION = () => (/^v\d+\.\d+$/.test(process.env.META_GRAPH_VERSION || '') ? process.env.META_GRAPH_VERSION : 'v26.0');
const QUIET_HOURS = 12;
const MAX_REPLY_CHARS = { messenger: 1900, instagram: 950 };

function metaConfig() {
  const token = String(process.env.META_PAGE_ACCESS_TOKEN || '').trim();
  const secret = String(process.env.META_APP_SECRET || '').trim();
  return {
    token,
    secret,
    verifyToken: String(process.env.META_VERIFY_TOKEN || '').trim(),
    appId: String(process.env.META_APP_ID || '').replace(/\D/g, ''),
    pageId: String(process.env.META_PAGE_ID || '').replace(/\D/g, ''),
    igId: String(process.env.META_IG_USER_ID || '').replace(/\D/g, ''),
    proof: token && secret ? crypto.createHmac('sha256', secret).update(token).digest('hex') : null,
  };
}

// What Settings can show (never the values themselves).
function setupStatus() {
  const c = metaConfig();
  return {
    page_token: !!c.token,
    app_secret: !!c.secret,
    verify_token: !!c.verifyToken,
    app_id: !!c.appId,
    page_id: !!c.pageId,
    ready: !!(c.token && c.secret && c.verifyToken),
  };
}

// ---- Webhook verification (GET) ---------------------------------------
// Meta calls GET <webhook>?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
// The /api/meta-webhook rewrite may hand the function only the rewrite's own
// query (mode=meta), so the hub.* values are also read from the raw URL and
// the forwarded-URL headers. A refusal logs WHY (never the token itself).
function hubParams(req) {
  const out = {};
  const take = (src) => {
    if (!src) return;
    ['hub.mode', 'hub.verify_token', 'hub.challenge'].forEach(k => {
      const v = typeof src.get === 'function' ? src.get(k) : src[k];
      if (out[k] == null && v != null && v !== '') out[k] = Array.isArray(v) ? String(v[0]) : String(v);
    });
  };
  take(req && req.query);
  const urls = [req && req.url, req && req.headers && (req.headers['x-forwarded-uri'] || req.headers['x-original-url'] || req.headers['x-vercel-original-url'] || req.headers['x-matched-path'])];
  urls.forEach(u => {
    if (!u || typeof u !== 'string' || u.indexOf('hub.') === -1) return;
    try { take(new URL(u, 'https://x.invalid').searchParams); } catch (e) { /* ignore */ }
  });
  return out;
}

function verifyChallenge(reqOrQuery) {
  const isReq = reqOrQuery && (reqOrQuery.headers || reqOrQuery.url);
  const q = isReq ? hubParams(reqOrQuery) : (reqOrQuery || {});
  const c = metaConfig();
  const given = String(q['hub.verify_token'] || '').trim();
  if (q['hub.mode'] === 'subscribe' && c.verifyToken && given === c.verifyToken) {
    return { status: 200, body: String(q['hub.challenge'] || '') };
  }
  const why = !q['hub.mode'] ? 'no hub.mode in the request (query not reaching the function)'
    : q['hub.mode'] !== 'subscribe' ? 'hub.mode is not subscribe'
    : !c.verifyToken ? 'META_VERIFY_TOKEN is not set in this deployment (add it in Vercel and redeploy)'
    : !given ? 'no hub.verify_token in the request'
    : `verify token does not match META_VERIFY_TOKEN (lengths ${given.length} vs ${c.verifyToken.length})`;
  console.warn('meta-webhook: verification refused --', why);
  return { status: 403, body: 'Forbidden' };
}

// ---- Signature check (POST) -------------------------------------------
// Meta signs the exact bytes it sent. Read them from the request stream if
// it hasn't been consumed yet; otherwise rebuild them from the parsed body
// the way Meta encodes JSON (non-ASCII as \uXXXX, "/" as "\/").
async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (req.readableEnded || req.complete) return '';
  return new Promise((resolve) => {
    const chunks = [];
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', finish);
    req.on('error', finish);
    setTimeout(finish, 1500);
  });
}

function metaJson(obj) {
  return JSON.stringify(obj)
    .replace(/\//g, '\\/')
    .replace(/[\u007f-￿]/g, (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

function signatureOk(raw, header, secret) {
  if (!secret || !header || !raw) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const a = Buffer.from(String(header));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Returns the parsed payload when the signature matches, else null.
async function readSignedPayload(req) {
  const { secret } = metaConfig();
  const header = req.headers['x-hub-signature-256'];
  const raw = await readRawBody(req);
  if (raw && signatureOk(raw, header, secret)) {
    try { return JSON.parse(raw); } catch (e) { return null; }
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (body && typeof body === 'object' && signatureOk(metaJson(body), header, secret)) return body;
  return null;
}

// ---- Events ------------------------------------------------------------
// Flattens a webhook payload into the events we act on:
//   { kind: 'message', platform, userId, mid, text, hasAttachment }
//   { kind: 'echo',    platform, userId, mid, text, appId }
function parseEvents(payload) {
  const out = [];
  if (!payload || !Array.isArray(payload.entry)) return out;
  const platform = payload.object === 'instagram' ? 'instagram' : payload.object === 'page' ? 'messenger' : null;
  if (!platform) return out;
  for (const entry of payload.entry) {
    for (const ev of entry.messaging || []) {
      const m = ev.message;
      if (m && m.is_echo) {
        out.push({
          kind: 'echo', platform,
          userId: String((ev.recipient && ev.recipient.id) || ''),
          mid: m.mid || '', text: typeof m.text === 'string' ? m.text : '',
          appId: m.app_id ? String(m.app_id) : '',
        });
      } else if (m && !m.is_deleted) {
        const quick = m.quick_reply && m.quick_reply.payload;
        out.push({
          kind: 'message', platform,
          userId: String((ev.sender && ev.sender.id) || ''),
          mid: m.mid || '',
          text: String(typeof m.text === 'string' ? m.text : (quick || '')).trim(),
          hasAttachment: Array.isArray(m.attachments) && m.attachments.length > 0,
        });
      } else if (ev.postback) {
        out.push({
          kind: 'message', platform,
          userId: String((ev.sender && ev.sender.id) || ''),
          mid: ev.postback.mid || '',
          text: String(ev.postback.title || ev.postback.payload || '').trim(),
          hasAttachment: false,
        });
      }
    }
  }
  return out.filter(e => e.userId);
}

// Meta retries deliveries it thinks failed; skip message IDs seen recently.
const seen = new Map();
function alreadySeen(mid) {
  if (!mid) return false;
  const now = Date.now();
  if (seen.size > 2000) { for (const [k, t] of seen) if (now - t > 3600000) seen.delete(k); }
  if (seen.has(mid)) return true;
  seen.set(mid, now);
  return false;
}

// ---- Graph API ----------------------------------------------------------
// META_PAGE_ACCESS_TOKEN is usually a Business settings system-user token,
// not the Page's own token. Sending ("me/messages") and reading
// conversations need the Page token, so ask Meta for it once with the
// system-user token (cached for an hour) -- the same swap the social
// insights use. If the token already is a Page token, or the swap fails,
// the token is used as given. Calls go to the Page by ID, never "me", so
// they act as the Page whichever kind of token is set.
const pageTokens = new Map(); // sha1(env token) -> { token, at }
const sha1 = (v) => crypto.createHash('sha1').update(v).digest('hex');
const proofFor = (secret, token) => (secret && token ? crypto.createHmac('sha256', secret).update(token).digest('hex') : null);

async function rawGraph(token, secret, path, { method = 'GET', params, body } = {}) {
  const qs = new URLSearchParams({ ...(params || {}), access_token: token });
  const proof = proofFor(secret, token);
  if (proof) qs.set('appsecret_proof', proof);
  const resp = await fetch(`https://graph.facebook.com/${VERSION()}/${path}?${qs}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.error) {
    const e = data.error || {};
    const err = new Error(`Meta ${resp.status}: ${(e.message || 'request failed').slice(0, 200)}`);
    err.code = e.code;
    throw err;
  }
  return data;
}

async function pageToken(c, { fresh = false } = {}) {
  if (!c.token || !c.pageId) return c.token;
  const k = sha1(c.token);
  const hit = pageTokens.get(k);
  if (!fresh && hit && Date.now() - hit.at < 3600000) return hit.token;
  try {
    const d = await rawGraph(c.token, c.secret, c.pageId, { params: { fields: 'access_token' } });
    if (d && typeof d.access_token === 'string' && d.access_token) {
      pageTokens.set(k, { token: d.access_token, at: Date.now() });
      return d.access_token;
    }
  } catch (e) { /* use the token as given */ }
  return c.token;
}

// The Page's node for messaging calls ("me" only if no Page ID is set).
const pageNode = () => metaConfig().pageId || 'me';

async function graph(path, opts = {}) {
  const c = metaConfig();
  const token = await pageToken(c);
  try {
    return await rawGraph(token, c.secret, path, opts);
  } catch (e) {
    // A Page token cached before the system-user token was changed: swap again once.
    if (e.code === 190 && token !== c.token) {
      pageTokens.delete(sha1(c.token));
      return rawGraph(await pageToken(c, { fresh: true }), c.secret, path, opts);
    }
    throw e;
  }
}

function splitForPlatform(text, platform) {
  const max = MAX_REPLY_CHARS[platform] || 950;
  const t = String(text || '').trim();
  if (t.length <= max) return [t];
  const parts = [];
  let rest = t;
  while (rest.length > max && parts.length < 2) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = rest.lastIndexOf('. ', max) + 1;
    if (cut < max * 0.5) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  parts.push(rest.slice(0, max));
  return parts.filter(Boolean);
}

async function sendText(platform, userId, text) {
  const ids = [];
  for (const part of splitForPlatform(text, platform)) {
    const r = await graph(`${pageNode()}/messages`, {
      method: 'POST',
      body: { recipient: { id: userId }, messaging_type: 'RESPONSE', message: { text: part } },
    });
    if (r && r.message_id) ids.push(r.message_id);
  }
  return ids;
}

async function typing(platform, userId) {
  if (platform !== 'messenger') return;
  try {
    await graph(`${pageNode()}/messages`, { method: 'POST', body: { recipient: { id: userId }, sender_action: 'typing_on' } });
  } catch (e) { /* cosmetic only */ }
}

// Recent messages in this conversation, oldest first, as chat turns:
// the customer is "user", the business (bot or staff) is "assistant".
// Read from Meta so nothing is stored here. Empty on any error.
async function recentHistory(platform, userId, limit = 10) {
  try {
    const data = await graph(`${pageNode()}/conversations`, {
      params: {
        platform,
        user_id: userId,
        fields: `messages.limit(${limit}){message,from,created_time}`,
      },
    });
    const conv = data && data.data && data.data[0];
    const msgs = (conv && conv.messages && conv.messages.data) || [];
    return msgs
      .slice()
      .reverse()
      .filter(m => typeof m.message === 'string' && m.message.trim())
      .map(m => ({
        role: m.from && String(m.from.id) === userId ? 'user' : 'assistant',
        content: m.message.trim(),
      }));
  } catch (e) {
    console.error('meta: could not read conversation history', e.message);
    return [];
  }
}

// ---- Per-person state (quiet after a handover) ---------------------------
function userKey(platform, userId) {
  const secret = process.env.STAFF_SESSION_SECRET || 'dcam-optical-demo-session-secret-v1';
  return crypto.createHmac('sha256', secret).update(platform + ':' + userId).digest('hex').slice(0, 40);
}
const textHash = (t) => crypto.createHash('sha256').update(String(t || '').trim()).digest('hex').slice(0, 24);

async function getState(platform, userId) {
  try {
    const resp = await supabaseRequest(
      `meta_chat_state?user_key=eq.${userKey(platform, userId)}&select=quiet_until,last_bot_hash,last_bot_at&limit=1`,
      { method: 'GET' }
    );
    if (!resp.ok) return {};
    const rows = await resp.json();
    return rows[0] || {};
  } catch (e) {
    return {};
  }
}

async function setState(platform, userId, fields) {
  try {
    await supabaseRequest('meta_chat_state?on_conflict=user_key', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ user_key: userKey(platform, userId), platform, updated_at: new Date().toISOString(), ...fields }),
    });
  } catch (e) {
    console.error('meta: could not save state', e.message);
  }
}

function isQuiet(state) {
  return !!(state && state.quiet_until && Date.parse(state.quiet_until) > Date.now());
}

async function goQuiet(platform, userId, hours = QUIET_HOURS) {
  await setState(platform, userId, { quiet_until: new Date(Date.now() + hours * 3600000).toISOString() });
}

// Called before the bot sends, so the echo of its own message isn't
// mistaken for a staff reply.
// Long replies go out in parts, so every part's hash is kept.
async function noteBotReply(platform, userId, text) {
  const hashes = splitForPlatform(text, platform).map(textHash).join(',');
  await setState(platform, userId, { last_bot_hash: hashes, last_bot_at: new Date().toISOString() });
}

// An echo is a message the Page/account sent. If it wasn't the bot, a
// person replied from the inbox (Meta Business Suite, GoHighLevel, the
// phone app), so the bot stays quiet in that conversation for a while.
async function handleEcho(ev) {
  const c = metaConfig();
  if (c.appId && ev.appId && ev.appId === c.appId) return 'own';
  const state = await getState(ev.platform, ev.userId);
  const recent = state.last_bot_at && Date.now() - Date.parse(state.last_bot_at) < 5 * 60000;
  if (recent && ev.text && String(state.last_bot_hash || '').split(',').includes(textHash(ev.text))) return 'own';
  await goQuiet(ev.platform, ev.userId);
  return 'staff';
}

const HANDOVER = /\b(staff|human|person|agent|representative|real person|tao|kausap|makausap|talk to (a |the )?(staff|person|human|team|someone))\b/i;
function wantsPerson(text) {
  return HANDOVER.test(String(text || '')) && String(text).length < 120;
}

module.exports = {
  metaConfig, setupStatus, verifyChallenge, readSignedPayload, parseEvents, alreadySeen,
  sendText, typing, recentHistory, getState, isQuiet, goQuiet, noteBotReply, handleEcho, wantsPerson,
  splitForPlatform, metaJson, signatureOk, QUIET_HOURS,
};
