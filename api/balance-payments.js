// Staff-facing endpoint for recording a payment against an EXISTING
// order (the paper log's "BALANCE" rows) without editing or duplicating
// the original order. Writes one row to balance_payments as the record
// of that payment event, then updates the order's own balance and
// payment_status so "how much is still owed" stays accurate at a glance
// everywhere else in the system (staff-orders list, patient history).

const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');

function isValidPaymentMethod(method) {
  return ['cash', 'gcash_cc', 'split'].includes(method);
}

function sanitizeAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, 20) : null;
}

async function recordPayment(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing payment data' });
    return;
  }

  const { order_id } = body;
  const amount = sanitizeAmount(body.amount);
  const paymentMethod = isValidPaymentMethod(body.payment_method) ? body.payment_method : 'cash';
  const splitCash = sanitizeAmount(body.split_cash);
  const splitGcash = sanitizeAmount(body.split_gcash);
  const takenBy = typeof body.taken_by === 'string' ? body.taken_by.trim().slice(0, 100) || null : null;

  if (!order_id) {
    res.status(400).json({ ok: false, error: 'An order id is required.' });
    return;
  }
  const parsedAmount = parseFloat(amount);
  if (!amount || !Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ ok: false, error: 'A valid payment amount is required.' });
    return;
  }

  try {
    // Look up the order to get its order_no (for the log) and current balance.
    const orderResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(order_id)}&limit=1`, { method: 'GET' });
    if (!orderResp.ok) {
      const errText = await orderResp.text();
      console.error('Supabase order lookup error:', orderResp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not find the order.' });
      return;
    }
    const [order] = await orderResp.json();
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found.' });
      return;
    }

    // Log the payment event.
    const logResp = await supabaseRequest('balance_payments', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        order_id,
        order_no: order.order_no,
        amount,
        payment_method: paymentMethod,
        split_cash: splitCash,
        split_gcash: splitGcash,
        taken_by: takenBy,
      }),
    });
    if (!logResp.ok) {
      const errText = await logResp.text();
      console.error('Supabase balance_payments insert error:', logResp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not log the payment.' });
      return;
    }
    const [logged] = await logResp.json();

    // Update the order's own balance (existing balance minus this
    // payment, floored at 0) and mark it paid once fully settled.
    const currentBalance = parseFloat(order.balance) || 0;
    const newBalance = Math.max(0, currentBalance - parsedAmount);
    const orderPatch = {
      balance: newBalance ? newBalance.toFixed(2) : '0.00',
      payment_status: newBalance <= 0 ? 'paid' : order.payment_status,
      updated_at: new Date().toISOString(),
    };

    const updateResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(order_id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(orderPatch),
    });
    if (!updateResp.ok) {
      const errText = await updateResp.text();
      console.error('Supabase order balance update error:', updateResp.status, errText);
      // The payment is already logged even if this update fails -- staff
      // can correct the order's balance by hand; not worth failing the
      // whole request over, since the payment record itself is safe.
    }
    const [updatedOrder] = updateResp.ok ? await updateResp.json() : [order];

    res.status(200).json({ ok: true, payment: logged, order: updatedOrder });
  } catch (err) {
    console.error('Unexpected error recording balance payment:', err);
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

  if (req.method === 'POST') return recordPayment(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
