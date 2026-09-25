// Vercel Serverless Function: /api/intake-payment
// Staff-only. Updates the payment_status of a single intake_submissions
// row (e.g. marking a check-up visit fee as paid). Separate from
// /api/orders.js since intake submissions and orders are different
// tables -- this keeps each endpoint focused on one table.

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

function isValidPaymentStatus(status) {
  return ['unpaid', 'paid'].includes(status);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'PATCH') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (!requireAuth(req, res)) return;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { id, payment_status } = body || {};

  if (!id || !isValidPaymentStatus(payment_status)) {
    res.status(400).json({ ok: false, error: 'A valid intake id and payment_status are required.' });
    return;
  }

  try {
    const resp = await supabaseRequest(`intake_submissions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ payment_status }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase intake payment update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not update payment status.' });
      return;
    }

    const [updated] = await resp.json();
    res.status(200).json({ ok: true, intake: updated });
  } catch (err) {
    console.error('Unexpected error updating intake payment status:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
};
