// Combines staff-login, staff-logout, auth-check, and a staff member's
// own profile (view/edit their own display name, email, phone, and
// password) into one function to stay under Vercel's Hobby-plan
// serverless function count limit. Routed by HTTP method, and by a
// `?action=` query param:
//   GET                              -> auth-check (who's logged in, if anyone)
//   GET  ?action=me                  -> this staff member's own profile
//   POST ?action=login               -> staff-login (default if action omitted)
//   POST ?action=logout              -> staff-logout
//   POST ?action=update_profile      -> edit own display_name/email/phone
//   POST ?action=change_password     -> change own password (current password required)
//
// The last three are "edit MYSELF only" -- unlike api/staff-users.js
// (admin managing other people's accounts), every write here is scoped
// to the session's own userId, so a staff member can never touch
// another account through this endpoint, and no admin check is needed
// since everyone (staff or admin) manages their own profile the same way.

const { setSessionCookie, clearSessionCookie, getSessionUser, requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { verifyPassword, hashPassword } = require('../lib/password');
const { sanitizeEmail, sanitizePhone, isUniqueViolation } = require('../lib/staff-profile-validate');

const DEMO_STAFF_PASSWORD = 'dcam-optical';
const MAX_BIO_CHARS = 500;
// Keeps avatar_data_url (and the Supabase row carrying it) small -- this
// is a profile picture stored as a base64 data: URL directly in the
// database (no Storage bucket set up for this project), not a full
// image host, so a generous-but-bounded cap matters. ~180KB of base64
// text decodes to roughly 130KB of actual image bytes.
const MAX_AVATAR_CHARS = 180000;

async function handleAuthCheck(req, res) {
  const sessionUser = getSessionUser(req);
  if (!sessionUser) {
    res.status(200).json({ ok: true, authenticated: false, role: null, username: null, display_name: null });
    return;
  }

  // The session cookie only carries username/role (as of login time --
  // see lib/auth.js), not display_name, so a quick lookup fills it in
  // for pages that greet the person by name (e.g. the Dashboard).
  // Best-effort: if this lookup fails for any reason, still report
  // "authenticated" with username as a fallback display name rather
  // than failing the whole auth check over a cosmetic field.
  let displayName = null;
  if (sessionUser.userId !== 'bootstrap') {
    try {
      const resp = await supabaseRequest(
        `staff_users?id=eq.${encodeURIComponent(sessionUser.userId)}&select=display_name`,
        { method: 'GET' }
      );
      if (resp.ok) {
        const [user] = await resp.json();
        displayName = (user && user.display_name) || null;
      }
    } catch (e) { /* non-fatal -- falls back to username */ }
  }

  res.status(200).json({
    ok: true,
    authenticated: true,
    role: sessionUser.role,
    username: sessionUser.username,
    display_name: displayName,
  });
}

// The bootstrap login (see handleLogin below) sets a session with
// userId 'bootstrap' -- there's no real staff_users row behind it, so
// profile/password actions have nothing to read or update. This should
// be rare in practice (bootstrap mode only exists until the first real
// account is created), but every handler below checks for it first and
// returns a clear message rather than a confusing lookup failure.
function isBootstrapSession(sessionUser) {
  return sessionUser && sessionUser.userId === 'bootstrap';
}

async function handleMe(req, res) {
  const sessionUser = requireAuth(req, res, { allowTech: true });
  if (!sessionUser) return;
  if (isBootstrapSession(sessionUser)) {
    res.status(200).json({ ok: true, user: { username: sessionUser.username, role: sessionUser.role, display_name: null, email: null, phone: null, bio: null, avatar_data_url: null, bootstrap: true } });
    return;
  }
  try {
    let resp = await supabaseRequest(
      `staff_users?id=eq.${encodeURIComponent(sessionUser.userId)}&select=username,display_name,email,phone,bio,avatar_data_url,role`,
      { method: 'GET' }
    );
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase own-profile fetch error:', resp.status, errText);
      // bio/avatar_data_url were added in a later migration than
      // email/phone -- if that migration hasn't been run against this
      // database yet, Postgres reports the columns as missing (42703)
      // and the select above fails entirely. Rather than breaking the
      // whole profile page (and, as a knock-on effect, the password
      // form below it, which only renders after a successful profile
      // load) until someone runs the migration, retry without those
      // two columns so the rest of the page still works.
      if (errText.includes('42703')) {
        resp = await supabaseRequest(
          `staff_users?id=eq.${encodeURIComponent(sessionUser.userId)}&select=username,display_name,email,phone,role`,
          { method: 'GET' }
        );
      }
      if (!resp.ok) {
        res.status(502).json({ ok: false, error: 'Could not load your profile.' });
        return;
      }
    }
    const [user] = await resp.json();
    if (!user) {
      res.status(404).json({ ok: false, error: 'Your account could not be found.' });
      return;
    }
    // Ensure these keys are always present in the response shape even
    // when the fallback query above couldn't select them, so the
    // front-end doesn't need to special-case a missing field.
    if (user.bio === undefined) user.bio = null;
    if (user.avatar_data_url === undefined) user.avatar_data_url = null;
    res.status(200).json({ ok: true, user });
  } catch (err) {
    console.error('Unexpected error loading own profile:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function handleUpdateProfile(req, res) {
  const sessionUser = requireAuth(req, res, { allowTech: true });
  if (!sessionUser) return;
  if (isBootstrapSession(sessionUser)) {
    res.status(400).json({ ok: false, error: 'Create a real staff account first (Settings > Staff accounts) -- the bootstrap login has no profile to edit.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing profile data' });
    return;
  }

  const patch = {};
  if (body.display_name !== undefined) {
    patch.display_name = String(body.display_name).trim().slice(0, 100) || null;
  }
  if (body.email !== undefined) {
    const email = sanitizeEmail(body.email);
    if (!email.ok) {
      res.status(400).json({ ok: false, error: 'Enter a valid email address, or leave it blank.' });
      return;
    }
    patch.email = email.value;
  }
  if (body.phone !== undefined) {
    const phone = sanitizePhone(body.phone);
    if (!phone.ok) {
      res.status(400).json({ ok: false, error: 'Enter a valid phone number, or leave it blank.' });
      return;
    }
    patch.phone = phone.value;
  }
  if (body.bio !== undefined) {
    const bio = String(body.bio).trim();
    if (bio.length > MAX_BIO_CHARS) {
      res.status(400).json({ ok: false, error: `Bio must be ${MAX_BIO_CHARS} characters or fewer.` });
      return;
    }
    patch.bio = bio || null;
  }
  if (body.avatar_data_url !== undefined) {
    const avatar = body.avatar_data_url === null ? '' : String(body.avatar_data_url).trim();
    if (avatar) {
      if (avatar.length > MAX_AVATAR_CHARS) {
        res.status(400).json({ ok: false, error: 'That picture is too large -- please use a smaller image.' });
        return;
      }
      // svg+xml is accepted alongside the uploaded-photo formats below so
      // the staff-profile preset avatars (plain inline-SVG shapes,
      // base64-encoded client-side in staff-profile.html) can actually be
      // saved -- they aren't a user-supplied upload, just one of a fixed
      // set of safe shapes this app itself generates.
      if (!/^data:image\/(png|jpe?g|webp|gif|svg\+xml);base64,/.test(avatar)) {
        res.status(400).json({ ok: false, error: 'Please choose a PNG, JPG, WEBP, or GIF image.' });
        return;
      }
    }
    patch.avatar_data_url = avatar || null;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: 'Provide at least one field to update.' });
    return;
  }
  patch.updated_at = new Date().toISOString();

  try {
    const resp = await supabaseRequest(`staff_users?id=eq.${encodeURIComponent(sessionUser.userId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase own-profile update error:', resp.status, errText);
      if (isUniqueViolation(errText)) {
        const field = errText.includes('staff_users_email_idx') ? 'That email is' : 'That phone number is';
        res.status(409).json({ ok: false, error: `${field} already used by another account.` });
        return;
      }
      // bio/avatar_data_url are a later migration than email/phone -- if
      // it hasn't been run against this database yet, the columns don't
      // exist and Postgres reports 42703 ("column does not exist").
      if (errText.includes('42703') && (patch.bio !== undefined || patch.avatar_data_url !== undefined)) {
        res.status(502).json({ ok: false, error: 'Bio and picture aren\'t enabled on the database yet -- a database migration needs to be run in Supabase first (see supabase-schema.sql).' });
        return;
      }
      res.status(502).json({ ok: false, error: 'Could not save your profile.' });
      return;
    }
    const [updated] = await resp.json();
    const { password_hash, password_salt, ...safeUser } = updated || {};
    res.status(200).json({ ok: true, user: safeUser });
  } catch (err) {
    console.error('Unexpected error updating own profile:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function handleChangePassword(req, res) {
  const sessionUser = requireAuth(req, res, { allowTech: true });
  if (!sessionUser) return;
  if (isBootstrapSession(sessionUser)) {
    res.status(400).json({ ok: false, error: 'Create a real staff account first (Settings > Staff accounts) -- the bootstrap login has no password of its own to change.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const currentPassword = (body && body.current_password) || '';
  const newPassword = (body && body.new_password) || '';

  if (!currentPassword) {
    res.status(400).json({ ok: false, error: 'Enter your current password.' });
    return;
  }
  if (newPassword.length < 6) {
    res.status(400).json({ ok: false, error: 'New password must be at least 6 characters.' });
    return;
  }

  try {
    const userResp = await supabaseRequest(
      `staff_users?id=eq.${encodeURIComponent(sessionUser.userId)}&select=id,password_hash,password_salt`,
      { method: 'GET' }
    );
    if (!userResp.ok) {
      res.status(502).json({ ok: false, error: 'Could not verify your current password.' });
      return;
    }
    const [user] = await userResp.json();
    if (!user || !verifyPassword(currentPassword, user.password_hash, user.password_salt)) {
      res.status(401).json({ ok: false, error: 'Your current password is incorrect.' });
      return;
    }

    const { hash, salt } = hashPassword(newPassword);
    const resp = await supabaseRequest(`staff_users?id=eq.${encodeURIComponent(sessionUser.userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ password_hash: hash, password_salt: salt, updated_at: new Date().toISOString() }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase own-password change error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not change your password.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error changing own password:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
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

    res.status(200).json({ ok: true, role: user.role });
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

  if (req.method === 'GET') {
    const action = (req.query && req.query.action) || 'check';
    if (action === 'me') return handleMe(req, res);
    return handleAuthCheck(req, res);
  }

  if (req.method === 'POST') {
    const action = (req.query && req.query.action) || 'login';
    if (action === 'logout') return handleLogout(req, res);
    if (action === 'update_profile') return handleUpdateProfile(req, res);
    if (action === 'change_password') return handleChangePassword(req, res);
    return handleLogin(req, res);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
