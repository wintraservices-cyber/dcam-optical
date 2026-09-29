// Combines patients, patient-history, patient-search, and
// reassign-record into one function to stay under Vercel's Hobby-plan
// serverless function count limit. Routed by HTTP method plus query
// params:
//   GET  ?phone=X          -> patient-history (full record + intakes + orders)
//   GET  ?q=X (or no q)    -> patient-search (search by name/phone, or list all)
//   GET  ?trash=1          -> deleted patients (admin only, for Trash tab)
//   POST (no action)       -> create a new patient
//   POST ?action=reassign  -> reassign-record (move an intake/order to a different patient)
//   PATCH                  -> update an existing patient's info
//   PATCH ?action=restore  -> bring a soft-deleted patient back (admin only)
//   DELETE ?id=X           -> soft delete (any logged-in staff)
//   DELETE ?id=X&purge=1   -> permanently delete (admin only, trash only)

const { requireAuth, requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { findOrCreatePatient, normalizePhone, validatePhoneForSave } = require('../lib/patients-helper');

// Soft delete: filters every read path below so a soft-deleted patient
// disappears from search/lookup/history without a schema change
// anywhere else. See the matching note in api/orders.js.
const NOT_DELETED = '&deleted_at=is.null';

// ---- GET: patient-history (by phone) ----
async function getPatientHistory(req, res, phone) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    res.status(400).json({ ok: false, error: 'A phone number is required.' });
    return;
  }

  try {
    const patientResp = await supabaseRequest(
      `patients?phone=eq.${encodeURIComponent(normalizedPhone)}${NOT_DELETED}&limit=1`,
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
        `orders?select=*,order_items(*)&patient_id=eq.${encodeURIComponent(patient.id)}${NOT_DELETED}&order=created_at.desc`,
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
        `patients?order=updated_at.desc.nullslast,created_at.desc&limit=200${NOT_DELETED}`,
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
      `patients?or=(name.ilike.${encoded},phone.ilike.${encoded})&order=name.asc&limit=8${NOT_DELETED}`,
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
  const phoneCheck = await validatePhoneForSave(phone);
  if (!phoneCheck.valid) {
    res.status(400).json({ ok: false, error: phoneCheck.message });
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
      `patients?id=eq.${encodeURIComponent(new_patient_id)}${NOT_DELETED}&limit=1`,
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
    const phoneCheck = await validatePhoneForSave(body.phone);
    if (!phoneCheck.valid) {
      res.status(400).json({ ok: false, error: phoneCheck.message });
      return;
    }
    patch.phone = phoneCheck.normalizedPhone;
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

    const resp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(id)}${NOT_DELETED}`, {
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

// ---------------------------------------------------------------------
// Soft delete / Trash. Any logged-in staff member can soft-delete a
// patient (DELETE ?id=X); only an admin can list the trash, restore, or
// permanently delete, from the Trash tab on Settings.
// ---------------------------------------------------------------------

async function softDeletePatient(req, res, session) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A patient id is required.' });
    return;
  }
  try {
    const resp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(id)}${NOT_DELETED}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: session.username }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase patient soft-delete error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not delete this patient.' });
      return;
    }
    const [deleted] = await resp.json();
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Patient not found (they may already be deleted).' });
      return;
    }
    res.status(200).json({ ok: true, patient: deleted });
  } catch (err) {
    console.error('Unexpected error soft-deleting patient:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Admin only, from here down.

async function listDeletedPatients(req, res) {
  try {
    const resp = await supabaseRequest('patients?deleted_at=not.is.null&order=deleted_at.desc&limit=500', { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase deleted-patients list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load the trash.' });
      return;
    }
    const patients = await resp.json();
    res.status(200).json({ ok: true, patients });
  } catch (err) {
    console.error('Unexpected error listing deleted patients:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function restorePatient(req, res, body) {
  const { id } = body || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A patient id is required.' });
    return;
  }
  try {
    const resp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(id)}&deleted_at=not.is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ deleted_at: null, deleted_by: null }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase patient restore error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not restore this patient.' });
      return;
    }
    const [restored] = await resp.json();
    if (!restored) {
      res.status(404).json({ ok: false, error: 'Deleted patient not found.' });
      return;
    }
    res.status(200).json({ ok: true, patient: restored });
  } catch (err) {
    console.error('Unexpected error restoring patient:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Permanent delete -- only reachable for a row already in the trash. A
// patient with any linked orders or intakes is left alone rather than
// force-deleted, since orders.patient_id / intake_submissions.patient_id
// both reference patients(id) with no cascade -- reassign or delete
// those records first, same as the app already requires for reassigning
// a record between patients.
async function purgePatient(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A patient id is required.' });
    return;
  }
  try {
    const checkResp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(id)}&deleted_at=not.is.null&limit=1`, { method: 'GET' });
    if (!checkResp.ok) {
      res.status(502).json({ ok: false, error: 'Could not verify this patient.' });
      return;
    }
    const [existing] = await checkResp.json();
    if (!existing) {
      res.status(404).json({ ok: false, error: 'This patient is not in the trash.' });
      return;
    }

    const [ordersResp, intakesResp] = await Promise.all([
      supabaseRequest(`orders?patient_id=eq.${encodeURIComponent(id)}&select=id&limit=1`, { method: 'GET' }),
      supabaseRequest(`intake_submissions?patient_id=eq.${encodeURIComponent(id)}&select=id&limit=1`, { method: 'GET' }),
    ]);
    const hasOrders = ordersResp.ok && (await ordersResp.json()).length > 0;
    const hasIntakes = intakesResp.ok && (await intakesResp.json()).length > 0;
    if (hasOrders || hasIntakes) {
      res.status(409).json({
        ok: false,
        error: 'This patient still has orders or intake records linked to them. Reassign or delete those first before permanently deleting the patient.',
      });
      return;
    }

    const resp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase patient purge error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not permanently delete this patient.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error purging patient:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'GET') {
    const { phone, q, trash } = req.query || {};
    // ?trash=1 lists soft-deleted patients -- admin only, for the Trash
    // tab on Settings.
    if (trash === '1') {
      if (!requireAdmin(req, res)) return;
      return listDeletedPatients(req, res);
    }
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

    if (req.method === 'PATCH') {
      // ?action=restore brings a soft-deleted patient back -- admin only.
      if (req.query && req.query.action === 'restore') {
        if (!requireAdmin(req, res)) return;
        return restorePatient(req, res, body);
      }
      return updatePatient(req, res, body);
    }

    const action = (req.query && req.query.action) || 'create';
    if (action === 'reassign') return reassignRecord(req, res, body);
    return createPatient(req, res, body);
  }

  if (req.method === 'DELETE') {
    // ?purge=1 permanently deletes an already-soft-deleted patient --
    // admin only. Plain DELETE (no purge flag) is the everyday soft
    // delete, available to any logged-in staff member.
    if (req.query && req.query.purge === '1') {
      if (!requireAdmin(req, res)) return;
      return purgePatient(req, res);
    }
    return softDeletePatient(req, res, session);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
