const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { findOrCreatePatient, validatePhoneForSave } = require('../lib/patients-helper');

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
  payment_method: 10,
  split_cash: 20,
  split_gcash: 20,
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

function isValidPaymentMethod(method) {
  return ['cash', 'gcash_cc', 'split'].includes(method);
}

function isValidOrderType(type) {
  return ['rx', 'non_rx'].includes(type);
}

function isValidRxSubtype(subtype) {
  return ['CMRX', 'L/O', 'F/O', 'CL'].includes(subtype);
}

const ITEM_FIELD_LIMITS = {
  item_name: 200,
  item_qty: 10,
  item_unit_price: 20,
  item_line_total: 20,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return [];
  return rawItems
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const cleaned = {};
      for (const [key, maxLen] of Object.entries(ITEM_FIELD_LIMITS)) {
        cleaned[key] = sanitize(item[key], maxLen);
      }
      // Optional link back to the catalog item this line was sold from,
      // so stock can be decremented. Only accepted if it's actually a
      // UUID -- a free-text item typed without picking a catalog match
      // has no id at all, which is the normal, unlinked case.
      cleaned.catalog_item_id =
        typeof item.catalog_item_id === 'string' && UUID_RE.test(item.catalog_item_id)
          ? item.catalog_item_id
          : null;
      cleaned.sort_order = index;
      return cleaned;
    })
    .filter(item => item && item.item_name); // drop empty rows (no name entered)
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
  record.payment_method = isValidPaymentMethod(record.payment_method) ? record.payment_method : 'cash';
  record.order_type = isValidOrderType(record.order_type) ? record.order_type : 'rx';
  record.rx_subtype = record.order_type === 'rx'
    ? (isValidRxSubtype(record.rx_subtype) ? record.rx_subtype : 'CMRX')
    : null;
  record.created_at = new Date().toISOString();

  // Phone format enforcement -- only when a phone was actually entered.
  // Orders can still be saved with no phone at all (matches the existing
  // design: a staff-entered order isn't required to link to a patient),
  // but if staff DID type something, it should be a real, correctly
  // formatted number rather than a typo that silently fails to link.
  if (record.tel_no) {
    const phoneCheck = await validatePhoneForSave(record.tel_no);
    if (!phoneCheck.valid) {
      res.status(400).json({ ok: false, error: phoneCheck.message });
      return;
    }
  }

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

  const items = sanitizeItems(body.items);

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

    // Write multi-item rows (Non-Rx orders with more than one product)
    // as a second insert, linked to the order that just saved. If this
    // fails, the order itself is already saved -- we log the error but
    // still return success for the order, since losing line items is
    // recoverable (staff can be told to re-add them) while losing the
    // whole order is not.
    if (items.length > 0 && saved && saved.id) {
      const itemRows = items.map(item => ({ ...item, order_id: saved.id }));
      try {
        const itemsResp = await supabaseRequest('order_items', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(itemRows),
        });
        if (!itemsResp.ok) {
          const errText = await itemsResp.text();
          console.error('Supabase order_items insert error:', itemsResp.status, errText);
        } else {
          saved.items = await itemsResp.json();

          // Decrement stock for any line items sold from the catalog.
          // Best-effort: a failure here doesn't undo the order or the
          // line item, since the sale itself already happened -- staff
          // can correct the catalog quantity by hand if this logs an
          // error, same recoverable-vs-not-recoverable tradeoff as the
          // order_items insert above.
          for (const item of itemRows) {
            if (!item.catalog_item_id) continue;
            const soldQty = parseInt(item.item_qty, 10);
            if (!Number.isFinite(soldQty) || soldQty <= 0) continue;
            try {
              const decResp = await supabaseRequest('rpc/decrement_catalog_stock', {
                method: 'POST',
                body: JSON.stringify({ item_id: item.catalog_item_id, sold_qty: soldQty }),
              });
              if (!decResp.ok) {
                console.error('Stock decrement failed:', decResp.status, await decResp.text());
              }
            } catch (decErr) {
              console.error('Unexpected error decrementing stock:', decErr);
            }
          }
        }
      } catch (itemsErr) {
        console.error('Unexpected error saving order items:', itemsErr);
      }
    }

    res.status(200).json({ ok: true, order: saved });
  } catch (err) {
    console.error('Unexpected error creating order:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function updateOrderFull(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object' || !body.id) {
    res.status(400).json({ ok: false, error: 'An order id is required.' });
    return;
  }
  const { id } = body;

  const record = {};
  for (const [key, maxLen] of Object.entries(FIELD_LIMITS)) {
    if (body[key] !== undefined) record[key] = sanitize(body[key], maxLen);
  }

  if (body.order_no !== undefined && !record.order_no) {
    res.status(400).json({ ok: false, error: 'Order number cannot be empty.' });
    return;
  }
  if (body.patient_name !== undefined && !record.patient_name) {
    res.status(400).json({ ok: false, error: 'Patient name cannot be empty.' });
    return;
  }

  if (record.status !== undefined) record.status = isValidStatus(record.status) ? record.status : undefined;
  if (record.payment_status !== undefined) record.payment_status = isValidPaymentStatus(record.payment_status) ? record.payment_status : undefined;
  if (record.payment_method !== undefined) record.payment_method = isValidPaymentMethod(record.payment_method) ? record.payment_method : undefined;
  if (record.order_type !== undefined) {
    record.order_type = isValidOrderType(record.order_type) ? record.order_type : undefined;
  }
  if (body.order_type === 'rx' || (record.order_type === undefined && body.rx_subtype !== undefined)) {
    record.rx_subtype = isValidRxSubtype(record.rx_subtype) ? record.rx_subtype : 'CMRX';
  } else if (body.order_type === 'non_rx') {
    record.rx_subtype = null;
  }
  record.updated_at = new Date().toISOString();

  // If the patient's name or phone changed, re-link to the correct
  // patient record (matched/created by phone) the same way createOrder
  // does, so an edited order doesn't stay pointed at a stale patient_id.
  if (body.patient_name !== undefined || body.tel_no !== undefined) {
    if (record.tel_no) {
      const phoneCheck = await validatePhoneForSave(record.tel_no);
      if (!phoneCheck.valid) {
        res.status(400).json({ ok: false, error: phoneCheck.message });
        return;
      }
    }
    try {
      const patient = await findOrCreatePatient({
        phone: record.tel_no,
        name: record.patient_name,
        email: null,
      });
      record.patient_id = patient ? patient.id : null;
    } catch (err) {
      console.error('Patient re-linking failed during order edit:', err);
    }
  }

  try {
    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(record),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase order edit error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save changes to this order.' });
      return;
    }

    const [saved] = await resp.json();
    if (!saved) {
      res.status(404).json({ ok: false, error: 'Order not found.' });
      return;
    }

    // Replace line items wholesale if an items array was sent -- delete
    // the existing rows and insert the new set, rather than trying to
    // diff/match individual rows against what's already there. Simple
    // and correct; the tradeoff is that item ids change on every edit,
    // which is fine since nothing else references order_items by id.
    //
    // Deliberately NOT touching catalog stock here: stock was already
    // decremented once when the order was first created. Editing
    // quantities afterward is a correction, not a new sale, and getting
    // delta math wrong (old qty vs new qty, swapped catalog items) risks
    // corrupting inventory counts more than it helps. Staff can adjust
    // catalog quantity by hand in Settings/Catalog if an edit changes
    // what was actually sold.
    if (Array.isArray(body.items)) {
      const items = sanitizeItems(body.items);
      try {
        const delResp = await supabaseRequest(`order_items?order_id=eq.${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (!delResp.ok) {
          console.error('Could not clear existing order items during edit:', delResp.status, await delResp.text());
        } else if (items.length > 0) {
          const itemRows = items.map(item => ({ ...item, order_id: id }));
          const insResp = await supabaseRequest('order_items', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(itemRows),
          });
          if (!insResp.ok) {
            console.error('Could not save new order items during edit:', insResp.status, await insResp.text());
          } else {
            saved.items = await insResp.json();
          }
        } else {
          saved.items = [];
        }
      } catch (itemsErr) {
        console.error('Unexpected error replacing order items during edit:', itemsErr);
      }
    }

    res.status(200).json({ ok: true, order: saved });
  } catch (err) {
    console.error('Unexpected error editing order:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function listOrders(req, res) {
  const { q, status, id } = req.query || {};

  // order_items(*) embeds each order's line items in the same query,
  // using PostgREST's resource-embedding (a join via the order_items.order_id
  // foreign key) -- avoids a separate round-trip per order.
  let path = 'orders?select=*,order_items(*)&order=created_at.desc&limit=100';

  // Fetching a single order by id -- used to load an existing order
  // into the order form for editing. Takes priority over q/status
  // since it identifies exactly one row.
  if (id && typeof id === 'string') {
    path = `orders?select=*,order_items(*)&id=eq.${encodeURIComponent(id)}&limit=1`;
    try {
      const resp = await supabaseRequest(path, { method: 'GET' });
      if (!resp.ok) {
        const errText = await resp.text();
        console.error('Supabase order lookup error:', resp.status, errText);
        res.status(502).json({ ok: false, error: 'Could not load this order.' });
        return;
      }
      const [order] = await resp.json();
      if (!order) {
        res.status(404).json({ ok: false, error: 'Order not found.' });
        return;
      }
      res.status(200).json({ ok: true, order });
    } catch (err) {
      console.error('Unexpected error loading order:', err);
      res.status(500).json({ ok: false, error: 'Unexpected server error.' });
    }
    return;
  }

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
  if (req.method === 'PATCH') {
    // Distinguish the full order-form edit from the lightweight
    // status/payment-only quick-edit used by the staff-orders list's
    // inline dropdowns -- same route, explicit flag decides which
    // handler runs, so neither one has to guess from field presence.
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    if (body && body.full_edit === true) return updateOrderFull(req, res);
    return updateOrderStatus(req, res);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
