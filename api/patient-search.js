// Vercel Serverless Function: /api/patient-search
// Staff-only. Given a partial name or phone number, returns matching
// patients (name, phone, email) for autocomplete on the order form.
// Deliberately lightweight -- returns at most a handful of matches,
// no full history (that's what /api/patient-history.js is for once a
// specific patient is selected).

const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!requireAuth(req, res)) return;

  const { q } = req.query || {};
  const term = (q || '').trim();

  if (!term || term.length < 2) {
    res.status(200).json({ ok: true, patients: [] });
    return;
  }

  try {
    const encoded = encodeURIComponent(`%${term}%`);
    const resp = await supabaseRequest(
      `patients?or=(name.ilike.${encoded},phone.ilike.${encoded})&order=name.asc&limit=8`,
      { method: 'GET' }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase patient search error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not search patients.' });
      return;
    }

    const patients = await resp.json();
    res.status(200).json({ ok: true, patients });
  } catch (err) {
    console.error('Unexpected error searching patients:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
};
