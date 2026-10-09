// Staff account management -- create new logins, list existing ones,
// deactivate/reactivate, and reset a password. Admin-only: managing who
// can log in, and at what privilege level, is exactly the kind of
// action that shouldn't be available to every staff member.
//
// Password hashes and salts are never returned to the client -- list
// and get responses strip them out.

const { requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { hashPassword } = require('../lib/password');
const { sanitizeUsername, sanitizeEmail, sanitizePhone, isUniqueViolation } = require('../lib/staff-profile-validate');

function stripSecrets(user) {
  if (!user) return user;
  const { password_hash, password_salt, ...rest } = user;
  return rest;
}

async function listUsers(req, res) {
  try {
    const resp = await supabaseRequest('staff_users?select=*&order=created_at.asc', { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase staff_users list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load staff accounts.' });
      return;
    }
    const users = await resp.json();
    res.status(200).json({ ok: true, users: users.map(stripSecrets) });
  } catch (err) {
    console.error('Unexpected error listing staff users:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function createUser(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  const username = sanitizeUsername(body && body.username);
  const password = (body && body.password) || '';
  const displayName = (body && body.display_name || '').trim().slice(0, 100) || null;
  const role = body && ['admin', 'tech'].includes(body.role) ? body.role : 'staff';
  const email = sanitizeEmail(body && body.email || '');
  const phone = sanitizePhone(body && body.phone || '');

  if (!username) {
    res.status(400).json({ ok: false, error: 'Username must be 2-40 characters: letters, numbers, dots, underscores, or hyphens.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
    return;
  }
  if (!email.ok) {
    res.status(400).json({ ok: false, error: 'Enter a valid email address, or leave it blank.' });
    return;
  }
  if (!phone.ok) {
    res.status(400).json({ ok: false, error: 'Enter a valid phone number, or leave it blank.' });
    return;
  }

  try {
    const existingResp = await supabaseRequest(
      `staff_users?username=eq.${encodeURIComponent(username)}&limit=1`,
      { method: 'GET' }
    );
    if (existingResp.ok) {
      const existing = await existingResp.json();
      if (existing.length > 0) {
        res.status(409).json({ ok: false, error: 'That username is already taken.' });
        return;
      }
    }

    const { hash, salt } = hashPassword(password);
    const resp = await supabaseRequest('staff_users', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        username,
        display_name: displayName,
        role,
        email: email.value,
        phone: phone.value,
        password_hash: hash,
        password_salt: salt,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase staff_users insert error:', resp.status, errText);
      if (isUniqueViolation(errText)) {
        res.status(409).json({ ok: false, error: 'That email or phone number is already used by another account.' });
        return;
      }
      res.status(502).json({ ok: false, error: 'Could not create this account.' });
      return;
    }

    const [created] = await resp.json();
    res.status(200).json({ ok: true, user: stripSecrets(created) });
  } catch (err) {
    console.error('Unexpected error creating staff user:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function updateUser(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { id } = body || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A valid user id is required.' });
    return;
  }

  const patch = {};
  if (body.active !== undefined) patch.active = !!body.active;
  if (body.role !== undefined) {
    if (!['admin', 'staff', 'tech'].includes(body.role)) {
      res.status(400).json({ ok: false, error: 'role must be "admin", "staff" or "tech".' });
      return;
    }
    patch.role = body.role;
  }
  if (body.display_name !== undefined) {
    patch.display_name = String(body.display_name).trim().slice(0, 100) || null;
  }
  if (body.username !== undefined) {
    const newUsername = sanitizeUsername(body.username);
    if (!newUsername) {
      res.status(400).json({ ok: false, error: 'Username must be 2-40 characters: letters, numbers, dots, underscores, or hyphens.' });
      return;
    }
    patch.username = newUsername;
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
  if (body.new_password) {
    if (String(body.new_password).length < 6) {
      res.status(400).json({ ok: false, error: 'Password must be at least 6 characters.' });
      return;
    }
    const { hash, salt } = hashPassword(String(body.new_password));
    patch.password_hash = hash;
    patch.password_salt = salt;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: 'Provide at least one field to update.' });
    return;
  }
  patch.updated_at = new Date().toISOString();

  try {
    const resp = await supabaseRequest(`staff_users?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase staff_users update error:', resp.status, errText);
      if (isUniqueViolation(errText)) {
        let field = 'That value is';
        if (errText.includes('staff_users_username_idx') || errText.includes('staff_users_username_key')) field = 'That username is';
        else if (errText.includes('staff_users_email_idx')) field = 'That email is';
        else if (errText.includes('staff_users_phone_idx')) field = 'That phone number is';
        res.status(409).json({ ok: false, error: `${field} already used by another account.` });
        return;
      }
      res.status(502).json({ ok: false, error: 'Could not update this account.' });
      return;
    }

    const [updated] = await resp.json();
    res.status(200).json({ ok: true, user: stripSecrets(updated) });
  } catch (err) {
    console.error('Unexpected error updating staff user:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!requireAdmin(req, res)) return;

  if (req.method === 'GET') return listUsers(req, res);
  if (req.method === 'POST') return createUser(req, res);
  if (req.method === 'PATCH') return updateUser(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
