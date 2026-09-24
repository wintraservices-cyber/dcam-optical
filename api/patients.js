// Combines patients, patient-history, patient-search, and
// reassign-record into one function to stay under Vercel's Hobby-plan
// serverless function count limit. Routed by HTTP method plus query
// params:
//   GET  ?phone=X          -> patient-history (full record + intakes + orders)
//   GET  ?q=X (or no q)    -> patient-search (search by name/phone, or list all)
//   POST (no action)       -> create a new patient
//   POST ?action=reassign  -> reassign-record (move an intake/order to a different patient)
//   PATCH                  -> update an existing patient's info

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { findOrCreatePatient, normalizePhone } = require('../lib/patients-helper');

// ---- GET: patient-history (by phone) ----
async function getPatientHistory(req, res, phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    res.status(400).json({ ok: false, error: 'A phone number is required.' });
    return;
  }

  try {
    const patientResp = await supabaseRequest(
      `patients?phone=eq.${encodeURIComponent(normalizedPhone)}&limit=1`,
      { method: 'GET' }
    );
    if (!patientResp.ok) {
      const errText = await patientResp.text();
      console.error('Supabase patient lookup error:', patientResp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not look up patient.' });
      return;
    }
    const patients = await patientResp.json();

    if (patients.length === 0) {
      res.status(200).json({ ok: true, patient: null, intakes: [], orders: [] });
      return;
    }

    const patient = patients[0];

    const [intakeResp, ordersResp] = await Promise.all([
      supabaseRequest(
        `intake_submissions?patient_id=eq.${encodeURIComponent(patient.id)}&order=created_at.desc`,
        { method: 'GET' }
      ),
      supabaseRequest(
        `orders?select=*,order_items(*)&patient_id=eq.${encodeURIComponent(patient.id)}&order=created_at.desc`,
        { method: 'GET' }
      ),
    ]);

    const intakes = intakeResp.ok ? await intakeResp.json() : [];
    const orders = ordersResp.ok ? await ordersResp.json() : [];

    if (!intakeResp.ok) {
      console.error('Supabase intake history error:', intakeResp.status, await intakeResp.text());
    }
    if (!ordersResp.ok) {
      console.error('Supabase order history error:', ordersResp.status, await ordersResp.text());
    }

    res.status(200).json({ ok: true, patient, intakes, orders });
  } catch (err) {
    console.error('Unexpected error fetching patient history:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// ---- GET: patient-search (by name/phone, or list all if no query) ----
async function searchPatients(req, res, q) {
  const term = (q || '').trim();

  // No query at all -- staff browsing the patient list from
  // staff-patient-lookup.html rather than typing a search. Return
  // everyone, most recently active first, capped at a reasonable page
  // size. This path isn't used by the order-form autocomplete, which
  // always passes a real query string.
  if (!term) {
    try {
      const resp = await supabaseRequest(
        `patients?order=updated_at.desc.nullslast,created_at.desc&limit=200`,
        { method: 'GET' }
      );
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('Supabase patient list error:', resp.status, errText);
        res.status(502).json({ ok: false, error: 'Could not load patients.' });
        return;
      }
      const patients = await resp.json();
      res.status(200).json({ ok: true, patients });
    } catch (err) {
      console.error('Unexpected error listing patients:', err);
      res.status(500).json({ ok: false, error: 'Unexpected server error.' });
    }
    return;
  }

  if (term.length < 2) {
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
}

// ---- POST: create a new patient ----
async function createPatient(req, res, body) {
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

// ---- POST ?action=reassign: move an intake/order to a different patient ----
function isValidRecordType(type) {
  return ['intake', 'order'].includes(type);
}

async function reassignRecord(req, res, body) {
  const { record_type, record_id, new_patient_id } = body || {};

  if (!isValidRecordType(record_type)) {
    res.status(400).json({ ok: false, error: 'record_type must be "intake" or "order".' });
    return;
  }
  if (!record_id || !new_patient_id) {
    res.status(400).json({ ok: false, error: 'record_id and new_patient_id are required.' });
    return;
  }

  const table = record_type === 'intake' ? 'intake_submissions' : 'orders';

  try {
    const patientResp = await supabaseRequest(
      `patients?id=eq.${encodeURIComponent(new_patient_id)}&limit=1`,
      { method: 'GET' }
    );
    if (!patientResp.ok) {
      res.status(502).json({ ok: false, error: 'Could not verify the destination patient.' });
      return;
    }
    const [destPatient] = await patientResp.json();
    if (!destPatient) {
      res.status(404).json({ ok: false, error: 'Destination patient not found.' });
      return;
    }

    const patch = { patient_id: new_patient_id };
    if (record_type === 'order' && destPatient.name) {
      patch.patient_name = destPatient.name;
    }

    const resp = await supabaseRequest(`${table}?id=eq.${encodeURIComponent(record_id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase reassign error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not reassign this record.' });
      return;
    }

    const [updated] = await resp.json();
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Record not found.' });
      return;
    }

    res.status(200).json({ ok: true, record: updated, patient: destPatient });
  } catch (err) {
    console.error('Unexpected error reassigning record:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// ---- PATCH: edit an existing patient's info ----
async function updatePatient(req, res, body) {
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!requireAuth(req, res)) return;

  if (req.method === 'GET') {
    const { phone, q } = req.query || {};
    if (phone) return getPatientHistory(req, res, phone);
    return searchPatients(req, res, q);
  }

  if (req.method === 'POST' || req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        return;
      }
    }

    if (req.method === 'PATCH') return updatePatient(req, res, body);

    const action = (req.query && req.query.action) || 'create';
    if (action === 'reassign') return reassignRecord(req, res, body);
    return createPatient(req, res, body);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
