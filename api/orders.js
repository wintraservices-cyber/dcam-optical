const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');
const { findOrCreatePatient } = require('./_patients');

// Field allow-list + length caps, same defensive pattern as the intake API.
const FIELD_LIMITS = {
  order_no: 20,
  order_type: 10,
  rx_subtype: 10,
  patient_name: 150,
  tel_no: 40,
  order_date: 20,
  due_date: 60,
  tray_no: 20,
  rx_r_sph: 15, rx_r_cyl: 15, rx_r_axis: 15, rx_r_prism: 15, rx_r_base: 15,
  rx_l_sph: 15, rx_l_cyl: 15, rx_l_axis: 15, rx_l_prism: 15, rx_l_base: 15,
  lens_material: 20,
  add_r: 15, add_l: 15,
  seg_ht_r: 15, seg_ht_l: 15,
  lens_type: 60,
  pd_mode: 10,
  pd_r: 15, pd_l: 15,
  item_name: 200,
  item_qty: 10,
  item_unit_price: 20,
  item_line_total: 20,
  frame: 150,
  special_instructions: 500,
  amount: 20,
  deposit: 20,
  balance: 20,
  status: 20,
  payment_status: 10,
  taken_by: 100,
};

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function isValidStatus(status) {
  return ['ordered', 'ready', 'claimed'].includes(status);
}

function isValidPaymentStatus(status) {
  return ['unpaid', 'paid'].includes(status);
}

function isValidOrderType(type) {
  return ['rx', 'non_rx'].includes(type);
}

function isValidRxSubtype(subtype) {
  return ['CMRX', 'L/O', 'F/O'].includes(subtype);
}

async function createOrder(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing order data' });
    return;
  }

  const record = {};
  for (const [key, maxLen] of Object.entries(FIELD_LIMITS)) {
    record[key] = sanitize(body[key], maxLen);
  }

  if (!record.order_no || !record.patient_name) {
    res.status(400).json({ ok: false, error: 'Order number and patient name are required.' });
    return;
  }

  record.status = isValidStatus(record.status) ? record.status : 'ordered';
  record.payment_status = isValidPaymentStatus(record.payment_status) ? record.payment_status : 'unpaid';
  record.order_type = isValidOrderType(record.order_type) ? record.order_type : 'rx';
  record.rx_subtype = record.order_type === 'rx'
    ? (isValidRxSubtype(record.rx_subtype) ? record.rx_subtype : 'CMRX')
    : null;
  record.created_at = new Date().toISOString();

  // Link this order to a patient record, matched by phone number. If no
  // phone was entered, the order still saves -- it just isn't linked to
  // a patient history (patient_id stays null).
  try {
    const patient = await findOrCreatePatient({
      phone: record.tel_no,
      name: record.patient_name,
      email: null,
    });
    record.patient_id = patient ? patient.id : null;
  } catch (err) {
    console.error('Patient linking failed, saving order without a link:', err);
    record.patient_id = null;
  }

  try {
    const resp = await supabaseRequest('orders', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(record),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase insert error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save the order.' });
      return;
    }

    const [saved] = await resp.json();
    res.status(200).json({ ok: true, order: saved });
  } catch (err) {
    console.error('Unexpected error creating order:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function listOrders(req, res) {
  const { q, status } = req.query || {};

  let path = 'orders?order=created_at.desc&limit=100';

  if (status && isValidStatus(status)) {
    path += `&status=eq.${encodeURIComponent(status)}`;
  }

  if (q && typeof q === 'string' && q.trim()) {
    // Search across order number and patient name — PostgREST "or" filter.
    const term = encodeURIComponent(`%${q.trim()}%`);
    path += `&or=(order_no.ilike.${term},patient_name.ilike.${term})`;
  }

  try {
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load orders.' });
      return;
    }
    const orders = await resp.json();
    res.status(200).json({ ok: true, orders });
  } catch (err) {
    console.error('Unexpected error listing orders:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function updateOrderStatus(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { id, status, payment_status } = body || {};

  if (!id) {
    res.status(400).json({ ok: false, error: 'A valid order id is required.' });
    return;
  }

  const statusProvided = status !== undefined;
  const paymentStatusProvided = payment_status !== undefined;

  if (!statusProvided && !paymentStatusProvided) {
    res.status(400).json({ ok: false, error: 'Provide a status or payment_status to update.' });
    return;
  }
  if (statusProvided && !isValidStatus(status)) {
    res.status(400).json({ ok: false, error: 'Invalid status value.' });
    return;
  }
  if (paymentStatusProvided && !isValidPaymentStatus(payment_status)) {
    res.status(400).json({ ok: false, error: 'Invalid payment_status value.' });
    return;
  }

  const patch = {};
  if (statusProvided) patch.status = status;
  if (paymentStatusProvided) patch.payment_status = payment_status;

  try {
    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not update the order.' });
      return;
    }

    const [updated] = await resp.json();
    res.status(200).json({ ok: true, order: updated });
  } catch (err) {
    console.error('Unexpected error updating order:', err);
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

  if (req.method === 'POST') return createOrder(req, res);
  if (req.method === 'GET') return listOrders(req, res);
  if (req.method === 'PATCH') return updateOrderStatus(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
