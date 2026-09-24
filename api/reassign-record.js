// Staff-facing endpoint for moving a single intake submission or order
// to a DIFFERENT patient -- e.g. something was logged under the wrong
// person and needs to be reattached to the right one. This changes
// exactly one row's patient_id; it never touches the patient records
// themselves or merges anyone's history together.

const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');

function isValidRecordType(type) {
  return ['intake', 'order'].includes(type);
}

async function reassign(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
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
    // Confirm the destination patient actually exists before pointing
    // a record at it -- a typo'd or stale id would otherwise silently
    // orphan the record instead of failing loudly.
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
    // Keep the record's own name/phone snapshot in sync with the
    // patient it now belongs to, so it reads correctly in lists and
    // exports that show those fields directly off the record.
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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (!requireAuth(req, res)) return;

  if (req.method === 'POST') return reassign(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
