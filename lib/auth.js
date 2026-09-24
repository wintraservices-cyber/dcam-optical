// Per-user staff session auth with role-based access (admin vs staff),
// replacing the old single-shared-password scheme. On successful login,
// sets a signed session cookie carrying the staff user's id, username,
// and role -- so every protected route can know WHO is acting and
// WHETHER they're allowed to do admin-only things (manage staff
// accounts, business info, Rx ranges) versus everyday staff work
// (orders, patients, catalog, intake).
//
// All existing call sites use `if (!requireAuth(req, res)) return;`,
// which still works unchanged since null and false are both falsy.

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'dcam_staff_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// This secret only signs session cookies -- it's not something staff
// type in. If a STAFF_SESSION_SECRET environment variable is set, it
// overrides this fallback.
const DEMO_SESSION_SECRET = 'dcam-optical-demo-session-secret-v1';

function getSecret() {
  return process.env.STAFF_SESSION_SECRET || DEMO_SESSION_SECRET;
}

function sign(payload) {
  const secret = getSecret();
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// payload shape: "<expiresAt>.<userId>.<username-base64url>.<role>"
function createSessionToken(user) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const usernameB64 = Buffer.from(user.username, 'utf8').toString('base64url');
  const role = user.role === 'admin' ? 'admin' : 'staff';
  const payload = `${expiresAt}.${user.id}.${usernameB64}.${role}`;
  const signature = sign(payload);
  return `${payload}.${signature}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [expiresAtStr, userId, usernameB64, role, signature] = parts;
  const payload = `${expiresAtStr}.${userId}.${usernameB64}.${role}`;

  const expectedSignature = sign(payload);
  const sigBuf = Buffer.from(signature || '', 'hex');
  const expectedBuf = Buffer.from(expectedSignature, 'hex');
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  const expiresAt = parseInt(expiresAtStr, 10);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return null;
  if (!userId) return null;

  let username = '';
  try { username = Buffer.from(usernameB64, 'base64url').toString('utf8'); } catch (e) { /* leave blank */ }

  return { userId, username, role: role === 'admin' ? 'admin' : 'staff' };
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

// Returns { userId, username, role } if the request carries a valid
// session cookie, or null otherwise.
function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE_NAME];
  return verifySessionToken(token);
}

function isAuthenticated(req) {
  return !!getSessionUser(req);
}

// Call at the top of any protected API route. Sends a 401 and returns
// null if the caller isn't authenticated; returns { userId, username,
// role } if they are.
function requireAuth(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.status(401).json({ ok: false, error: 'Not authenticated. Please log in.' });
    return null;
  }
  return sessionUser;
}

// Call at the top of any admin-only route (staff account management,
// business info, Rx ranges). Sends 401 if not logged in at all, 403 if
// logged in but not an admin. Returns null in either failure case, or
// the session user on success -- same falsy-check pattern as requireAuth.
function requireAdmin(req, res) {
  const sessionUser = requireAuth(req, res);
  if (!sessionUser) return null;
  if (sessionUser.role !== 'admin') {
    res.status(403).json({ ok: false, error: 'This requires an admin account.' });
    return null;
  }
  return sessionUser;
}

function setSessionCookie(res, user) {
  const token = createSessionToken(user);
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
  requireAdmin,
  isAuthenticated,
  getSessionUser,
  setSessionCookie,
  clearSessionCookie,
};
