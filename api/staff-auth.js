// Combines staff-login, staff-logout, and auth-check into one function
// to stay under Vercel's Hobby-plan serverless function count limit.
// Routed by HTTP method, and for POST, by a `?action=` query param:
//   GET                      -> auth-check (who's logged in, if anyone)
//   POST ?action=login       -> staff-login (default if action omitted)
//   POST ?action=logout      -> staff-logout

const { setSessionCookie, clearSessionCookie, getSessionUser } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { verifyPassword } = require('../lib/password');

const DEMO_STAFF_PASSWORD = 'dcam-optical';

async function handleAuthCheck(req, res) {
  const sessionUser = getSessionUser(req);
  res.status(200).json({
    ok: true,
    authenticated: !!sessionUser,
    role: sessionUser ? sessionUser.role : null,
    username: sessionUser ? sessionUser.username : null,
  });
}

async function handleLogin(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const username = ((body && body.username) || '').trim();
  const password = (body && body.password) || '';

  if (!password) {
    res.status(400).json({ ok: false, error: 'Password is required.' });
    return;
  }

  try {
    // Check how many staff accounts exist -- determines whether the
    // legacy bootstrap password path is still available.
    const countResp = await supabaseRequest('staff_users?select=id&limit=1', { method: 'GET' });
    const existingUsers = countResp.ok ? await countResp.json() : [];

    if (existingUsers.length === 0) {
      // Bootstrap mode: no real accounts yet. Username is ignored; only
      // the shared password matters, same as the old scheme.
      const bootstrapPassword = process.env.STAFF_PASSWORD || DEMO_STAFF_PASSWORD;
      if (password !== bootstrapPassword) {
        res.status(401).json({ ok: false, error: 'Incorrect password.' });
        return;
      }
      setSessionCookie(res, { id: 'bootstrap', username: 'admin', role: 'admin' });
      res.status(200).json({ ok: true, bootstrap: true });
      return;
    }

    if (!username) {
      res.status(400).json({ ok: false, error: 'Username is required.' });
      return;
    }

    const userResp = await supabaseRequest(
      `staff_users?username=eq.${encodeURIComponent(username)}&limit=1`,
      { method: 'GET' }
    );
    if (!userResp.ok) {
      const errText = await userResp.text();
      console.error('Supabase staff_users lookup error:', userResp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not check your credentials.' });
      return;
    }
    const [user] = await userResp.json();

    // Same error for "no such user" and "wrong password" -- don't leak
    // which usernames exist.
    if (!user || !user.active || !verifyPassword(password, user.password_hash, user.password_salt)) {
      res.status(401).json({ ok: false, error: 'Incorrect username or password.' });
      return;
    }

    setSessionCookie(res, { id: user.id, username: user.username, role: user.role });

    // Best-effort last-login stamp; don't fail the login over this.
    try {
      await supabaseRequest(`staff_users?id=eq.${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_login_at: new Date().toISOString() }),
      });
    } catch (e) { /* non-fatal */ }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error during staff login:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function handleLogout(req, res) {
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') return handleAuthCheck(req, res);

  if (req.method === 'POST') {
    const action = (req.query && req.query.action) || 'login';
    if (action === 'logout') return handleLogout(req, res);
    return handleLogin(req, res);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
