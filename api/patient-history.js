// Vercel Serverless Function: /api/patient-history
// Staff-only. Given a phone number, returns the linked patient record
// plus their full intake submission history and order history --
// letting staff see "what has this person done before" in one place.

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { normalizePhone } = require('../lib/patients');

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

  const { phone } = req.query || {};
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
};
