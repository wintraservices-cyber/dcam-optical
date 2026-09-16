const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');

// Field allow-list + length caps, same defensive pattern as the intake API.
const FIELD_LIMITS = {
  order_no: 20,
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
  pd_r: 15, pd_l: 15,
  frame: 150,
  special_instructions: 500,
  amount: 20,
  deposit: 20,
  balance: 20,
  status: 20,
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
  record.created_at = new Date().toISOString();

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
  const { id, status } = body || {};

  if (!id || !isValidStatus(status)) {
    res.status(400).json({ ok: false, error: 'A valid order id and status are required.' });
    return;
  }

  try {
    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status }),
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
