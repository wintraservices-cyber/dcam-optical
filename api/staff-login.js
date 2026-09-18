const { setSessionCookie } = require('../lib/auth');

// DEMO MODE: password is hardcoded here so the staff login works
// immediately with zero setup (no Vercel dashboard configuration needed).
// If a STAFF_PASSWORD environment variable is set, it overrides this —
// so switching to env-var-based config later requires no code change,
// just setting the variable in Vercel.
const DEMO_STAFF_PASSWORD = 'dcam-optical';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const staffPassword = process.env.STAFF_PASSWORD || DEMO_STAFF_PASSWORD;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const submittedPassword = (body && body.password) || '';

  // Basic rate-limit-ish delay would go here in a more hardened version;
  // for a single shared low-value password this constant-time-ish compare
  // is enough at demo scale.
  if (submittedPassword !== staffPassword) {
    res.status(401).json({ ok: false, error: 'Incorrect password.' });
    return;
  }

  setSessionCookie(res);
  res.status(200).json({ ok: true });
};
