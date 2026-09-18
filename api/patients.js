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
const { supabaseRequest } = require('./_supabase');
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

// Directly edits an existing patient record by id -- unlike
// findOrCreatePatient (which matches/creates by phone), this is a plain
// edit: staff fixing a typo'd name, a wrong phone number, or adding an
// email after the fact. If the phone number is changed to one that
// already belongs to a different patient, that's rejected rather than
// silently merging two patients' histories together.
async function updatePatient(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { id } = body || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A valid patient id is required.' });
    return;
  }

  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) {
      res.status(400).json({ ok: false, error: 'Name cannot be empty.' });
      return;
    }
    patch.name = name.slice(0, 150);
  }
  if (body.phone !== undefined) {
    const normalizedPhone = normalizePhone(body.phone);
    if (!normalizedPhone) {
      res.status(400).json({ ok: false, error: 'A valid phone number is required.' });
      return;
    }
    patch.phone = normalizedPhone;
  }
  if (body.email !== undefined) {
    patch.email = String(body.email).trim().slice(0, 150) || null;
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: 'Provide at least one field to update.' });
    return;
  }
  patch.updated_at = new Date().toISOString();

  try {
    // If the phone is changing, make sure it doesn't collide with a
    // different existing patient -- that would silently merge two
    // people's records together under one row, which is never right;
    // reassigning specific intake/order records between patients is a
    // separate, explicit action (see api/reassign-record.js).
    if (patch.phone) {
      const collisionResp = await supabaseRequest(
        `patients?phone=eq.${encodeURIComponent(patch.phone)}&id=neq.${encodeURIComponent(id)}&limit=1`,
        { method: 'GET' }
      );
      if (collisionResp.ok) {
        const collisions = await collisionResp.json();
        if (collisions.length > 0) {
          res.status(409).json({ ok: false, error: 'That phone number already belongs to a different patient.' });
          return;
        }
      }
    }

    const resp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase patient update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not update this patient.' });
      return;
    }

    const [updated] = await resp.json();
    res.status(200).json({ ok: true, patient: updated });
  } catch (err) {
    console.error('Unexpected error updating patient:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!requireAuth(req, res)) return;

  if (req.method === 'POST') return createPatient(req, res);
  if (req.method === 'PATCH') return updatePatient(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
