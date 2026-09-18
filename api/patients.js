// Staff-facing "add a new patient" endpoint. Reuses the same
// findOrCreatePatient() logic the intake and orders APIs already use,
// so a manually-added patient behaves identically to one created as a
// side effect of an intake submission or an order -- same phone-match
// rules, same fields, same table.
//
// This does NOT duplicate patients: if the phone number already exists,
// it returns/updates the existing record rather than creating a second
// one, same as every other path into the patients table.

const { requireAuth } = require('./_auth');
const { findOrCreatePatient, normalizePhone } = require('./_patients');

async function createPatient(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing patient data' });
    return;
  }

  const name = (body.name || '').trim();
  const phone = (body.phone || '').trim();
  const email = (body.email || '').trim();

  if (!name) {
    res.status(400).json({ ok: false, error: 'Name is required.' });
    return;
  }
  if (!normalizePhone(phone)) {
    res.status(400).json({ ok: false, error: 'A valid phone number is required.' });
    return;
  }

  try {
    const patient = await findOrCreatePatient({ phone, name, email });
    res.status(200).json({ ok: true, patient });
  } catch (err) {
    console.error('Unexpected error creating patient:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!requireAuth(req, res)) return;

  if (req.method === 'POST') return createPatient(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
