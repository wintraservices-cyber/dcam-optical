// Minimal shared-password session auth.
//
// Not per-user accounts — a single shared staff password, matching what was
// agreed for v1. On success, sets a signed-ish session token (HMAC of a
// secret + expiry) as an HTTP-only cookie. Every protected API route calls
// requireAuth(req) to verify that cookie before doing anything else.
//
// This is intentionally simple. If DCAM later wants individual staff logins,
// this is the piece to swap out — everything else (orders API, DB schema)
// stays the same.

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'dcam_staff_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// DEMO MODE: hardcoded fallback so sessions work with zero Vercel setup.
// If a STAFF_SESSION_SECRET environment variable is set, it overrides this.
// This secret only signs session cookies — it's not something staff type
// in, so there's little downside to it living in code for a demo.
const DEMO_SESSION_SECRET = 'dcam-optical-demo-session-secret-v1';

function getSecret() {
  return process.env.STAFF_SESSION_SECRET || DEMO_SESSION_SECRET;
}

function sign(payload) {
  const secret = getSecret();
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function createSessionToken() {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `${expiresAt}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return false;

  const expectedSignature = sign(payload);
  const validSig =
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  if (!validSig) return false;

  const expiresAt = parseInt(payload, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  return true;
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  });
  return out;
}

// Returns true if the request carries a valid session cookie.
function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  return verifySessionToken(token);
}

// Call at the top of any protected API route. Sends a 401 and returns false
// if the caller isn't authenticated; returns true if they are.
function requireAuth(req, res) {
  if (!isAuthenticated(req)) {
    res.status(401).json({ ok: false, error: 'Not authenticated. Please log in.' });
    return false;
  }
  return true;
}

function setSessionCookie(res) {
  const token = createSessionToken();
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
  );
}

function clearSessionCookie(res) {
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
}

module.exports = {
  requireAuth,
  isAuthenticated,
  setSessionCookie,
  clearSessionCookie,
};
