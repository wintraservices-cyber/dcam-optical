// Staff-facing endpoint for recording a payment against an EXISTING
// order (the paper log's "BALANCE" rows) without editing or duplicating
// the original order. Writes one row to balance_payments as the record
// of that payment event, then updates the order's own balance and
// payment_status so "how much is still owed" stays accurate at a glance
// everywhere else in the system (staff-orders list, patient history).

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { logOrderAudit } = require('../lib/audit');
const { getPermissions, can, deny } = require('../lib/staff-permissions');

function isValidPaymentMethod(method) {
  return ['cash', 'gcash_cc', 'split'].includes(method);
}

function sanitizeAmount(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed.slice(0, 20) : null;
}

async function recordPayment(req, res, session) {
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

  const perms = await getPermissions();
  if (!can(session, perms, 'log_payments')) {
    return deny(res, 'Only an admin can log payments.');
  }

  const { order_id } = body;
  const amount = sanitizeAmount(body.amount);
  const paymentMethod = isValidPaymentMethod(body.payment_method) ? body.payment_method : 'cash';
  const splitCash = sanitizeAmount(body.split_cash);
  const splitGcash = sanitizeAmount(body.split_gcash);
  // Who collected this payment is always the logged-in staff member
  // submitting the request, never a client-supplied value -- this is
  // the actual audit-trail fix: "taken_by" used to be free text (or
  // blank) typed by whoever was at the keyboard, which can't be trusted
  // as a record of who really collected the money.
  const takenBy = session.username;

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
    const orderResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(order_id)}&deleted_at=is.null&limit=1`, { method: 'GET' });
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

    // Computed up front (before logging) so the log row can carry the
    // resulting balance alongside the payment itself -- this is what
    // lets the Orders/Sales reports show an accurate "Balance" on this
    // payment's own report row (dated today) without having to replay
    // every payment an order ever had, which would also go wrong if the
    // order's amount was later hand-edited.
    const currentBalance = parseFloat(order.balance) || 0;
    const newBalance = Math.max(0, currentBalance - parsedAmount);
    const balanceAfter = newBalance ? newBalance.toFixed(2) : '0.00';

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
        balance_after: balanceAfter,
      }),
    });
    if (!logResp.ok) {
      const errText = await logResp.text();
      console.error('Supabase balance_payments insert error:', logResp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not log the payment.' });
      return;
    }
    const [logged] = await logResp.json();

    // Update the order's own balance and payment_status: fully settled
    // once the balance hits 0, otherwise "partial" once any payment has
    // been logged against it (rather than leaving it stuck on "unpaid"
    // even though money has come in).
    const orderPatch = {
      balance: balanceAfter,
      payment_status: newBalance <= 0 ? 'paid' : 'partial',
      updated_at: new Date().toISOString(),
    };

    const updateResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(order_id)}&deleted_at=is.null`, {
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

    logOrderAudit({
      orderId: order_id,
      orderNo: order.order_no,
      action: 'balance_payment',
      changedBy: session.username,
      changes: { amount, payment_method: paymentMethod, split_cash: splitCash, split_gcash: splitGcash },
    });

    res.status(200).json({ ok: true, payment: logged, order: updatedOrder });
  } catch (err) {
    console.error('Unexpected error recording balance payment:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

function money(n) { return (Math.round((Number(n) || 0) * 100) / 100); }

// Recomputes an order's balance (and each later payment's balance_after)
// from scratch: Amount - Deposit - payments, in the order they were taken.
// Called after a payment is edited or voided so nothing downstream goes
// stale. Falls back to a delta on the stored balance when the order has no
// usable Amount.
async function recomputeOrder(orderId, order, fallbackDelta) {
  const payResp = await supabaseRequest(`balance_payments?order_id=eq.${encodeURIComponent(orderId)}&order=created_at.asc&select=id,amount,balance_after`, { method: 'GET' });
  const pays = payResp.ok ? await payResp.json() : [];
  const amt = parseFloat(order.amount);
  const dep = parseFloat(order.deposit) || 0;
  let running;
  if (Number.isFinite(amt)) {
    running = Math.max(amt - dep, 0);
    for (const p of pays) {
      running = Math.max(0, money(running - (parseFloat(p.amount) || 0)));
      const after = running.toFixed(2);
      if (p.balance_after !== after) {
        await supabaseRequest(`balance_payments?id=eq.${encodeURIComponent(p.id)}`, { method: 'PATCH', body: JSON.stringify({ balance_after: after }) });
      }
    }
  } else {
    running = Math.max(0, money((parseFloat(order.balance) || 0) + (fallbackDelta || 0)));
  }
  const paymentStatus = running <= 0 && (Number.isFinite(amt) ? amt > 0 : true)
    ? 'paid'
    : ((Number.isFinite(amt) && running >= amt) ? 'unpaid' : 'partial');
  const patch = { balance: running.toFixed(2), payment_status: paymentStatus, updated_at: new Date().toISOString() };
  const upd = await supabaseRequest(`orders?id=eq.${encodeURIComponent(orderId)}&deleted_at=is.null`, {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch),
  });
  const rows = upd.ok ? await upd.json() : [];
  return { order: rows[0] || { ...order, ...patch }, ok: upd.ok };
}

// PATCH = correct a logged payment (method / amount / split parts).
// DELETE = void it (the row is removed; the audit trail keeps what it was).
// Admin-only unless the "Edit or void a logged payment" permission is on.
async function correctPayment(req, res, session, isVoid) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body && typeof body === 'object' ? body : {};
  const id = (req.query && req.query.id) || body.id;

  const perms = await getPermissions();
  if (!can(session, perms, 'edit_payments')) {
    return deny(res, 'Only an admin can correct or void a logged payment.');
  }
  if (!id) {
    res.status(400).json({ ok: false, error: 'A payment id is required.' });
    return;
  }

  try {
    const payResp = await supabaseRequest(`balance_payments?id=eq.${encodeURIComponent(id)}&limit=1`, { method: 'GET' });
    if (!payResp.ok) { res.status(502).json({ ok: false, error: 'Could not find the payment.' }); return; }
    const [payment] = await payResp.json();
    if (!payment) { res.status(404).json({ ok: false, error: 'Payment not found.' }); return; }

    const orderResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(payment.order_id)}&deleted_at=is.null&limit=1`, { method: 'GET' });
    const [order] = orderResp.ok ? await orderResp.json() : [];
    if (!order) { res.status(404).json({ ok: false, error: 'The order for this payment was not found.' }); return; }

    const before = {
      amount: payment.amount, payment_method: payment.payment_method,
      split_cash: payment.split_cash, split_gcash: payment.split_gcash,
    };
    let changes;

    if (isVoid) {
      const del = await supabaseRequest(`balance_payments?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!del.ok) {
        console.error('balance_payments delete error:', del.status, await del.text());
        res.status(502).json({ ok: false, error: 'Could not void the payment.' });
        return;
      }
      changes = { correction: 'voided', payment_id: id, ...before, taken_by: payment.taken_by || null };
    } else {
      const amount = body.amount === undefined ? payment.amount : sanitizeAmount(body.amount);
      const parsed = parseFloat(amount);
      if (!amount || !Number.isFinite(parsed) || parsed <= 0) {
        res.status(400).json({ ok: false, error: 'A valid payment amount is required.' });
        return;
      }
      const method = body.payment_method === undefined ? payment.payment_method : body.payment_method;
      if (!isValidPaymentMethod(method)) {
        res.status(400).json({ ok: false, error: 'Choose Cash, GCash/CC or Split.' });
        return;
      }
      let splitCash = null, splitGcash = null;
      if (method === 'split') {
        splitCash = sanitizeAmount(body.split_cash === undefined ? payment.split_cash : body.split_cash);
        splitGcash = sanitizeAmount(body.split_gcash === undefined ? payment.split_gcash : body.split_gcash);
        const c = parseFloat(splitCash), g = parseFloat(splitGcash);
        if (!Number.isFinite(c) || !Number.isFinite(g)) {
          res.status(400).json({ ok: false, error: 'Enter both the cash and the GCash/CC amounts for a split payment.' });
          return;
        }
        if (Math.abs(c + g - parsed) > 0.005) {
          res.status(400).json({ ok: false, error: `Cash + GCash/CC (${money(c + g).toFixed(2)}) must equal the payment amount (${money(parsed).toFixed(2)}).` });
          return;
        }
      }
      const patch = { amount, payment_method: method, split_cash: splitCash, split_gcash: splitGcash };
      const upd = await supabaseRequest(`balance_payments?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (!upd.ok) {
        console.error('balance_payments patch error:', upd.status, await upd.text());
        res.status(502).json({ ok: false, error: 'Could not save the correction.' });
        return;
      }
      changes = { correction: 'edited', payment_id: id, ...patch, before };
    }

    const delta = isVoid ? (parseFloat(before.amount) || 0) : (parseFloat(before.amount) || 0) - (parseFloat(changes.amount) || 0);
    const result = await recomputeOrder(payment.order_id, order, delta);

    logOrderAudit({
      orderId: payment.order_id,
      orderNo: order.order_no,
      action: 'balance_payment',
      changedBy: session.username,
      changes,
    });

    res.status(200).json({ ok: true, order: result.order });
  } catch (err) {
    console.error('Unexpected error correcting balance payment:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const session = requireAuth(req, res);
  if (!session) return;

  if (req.method === 'POST') return recordPayment(req, res, session);
  if (req.method === 'PATCH') return correctPayment(req, res, session, false);
  if (req.method === 'DELETE') return correctPayment(req, res, session, true);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
