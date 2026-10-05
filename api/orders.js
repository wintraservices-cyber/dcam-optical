const { requireAuth, requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');
const { findOrCreatePatient } = require('../lib/patients-helper');
const { logOrderAudit, diffFields } = require('../lib/audit');

// Soft delete: any logged-in staff member can delete (sets deleted_at/
// deleted_by rather than removing the row); only an admin can restore or
// permanently delete, from the Trash tab on Settings. Every list/lookup
// path below filters deleted_at=is.null so a soft-deleted order
// disappears everywhere except Trash.
const NOT_DELETED = '&deleted_at=is.null';

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
  return ['unpaid', 'partial', 'paid'].includes(status);
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

async function createOrder(req, res, session) {
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

  // "Who took this order" is always the authenticated staff member who
  // is actually submitting it -- never whatever the client sent, since
  // a free-text/client-supplied value can't be trusted as an audit
  // record of who was really at the keyboard.
  record.taken_by = session.username;
  record.created_by = session.username;

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

    logOrderAudit({
      orderId: saved.id,
      orderNo: saved.order_no,
      action: 'created',
      changedBy: session.username,
    });

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

async function updateOrderFull(req, res, session) {
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
  record.updated_by = session.username;
  // taken_by reflects who is on record for this order's payment, not a
  // free-text field editors can overwrite -- never trust client input
  // for it; leave the original value in place on an edit.
  delete record.taken_by;

  // If the patient's name or phone changed, re-link to the correct
  // patient record (matched/created by phone) the same way createOrder
  // does, so an edited order doesn't stay pointed at a stale patient_id.
  if (body.patient_name !== undefined || body.tel_no !== undefined) {
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
    // Fetch the pre-edit row so the audit log can record an actual
    // before/after diff, not just "something changed."
    let beforeRow = null;
    try {
      const beforeResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}&limit=1`, { method: 'GET' });
      if (beforeResp.ok) {
        const [row] = await beforeResp.json();
        beforeRow = row || null;
      }
    } catch (beforeErr) {
      console.error('Could not load pre-edit order for audit diff:', beforeErr);
    }

    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}${NOT_DELETED}`, {
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
      res.status(404).json({ ok: false, error: 'Order not found (it may have been deleted).' });
      return;
    }

    const changes = diffFields(beforeRow, record);
    if (Object.keys(changes).length > 0) {
      logOrderAudit({
        orderId: saved.id,
        orderNo: saved.order_no,
        action: 'full_edit',
        changedBy: session.username,
        changes,
      });
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

const ORDER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function listOrders(req, res) {
  const { q, status, id, from, to, order_type } = req.query || {};

  // order_items(*) embeds each order's line items in the same query,
  // using PostgREST's resource-embedding (a join via the order_items.order_id
  // foreign key) -- avoids a separate round-trip per order.
  // balance_payments(*) embeds that order's full payment history too --
  // small lists, and it's what lets the UI show *why* an order outside
  // the selected date range is appearing (see the date-range filter
  // below): a payment logged within the range, not the order's own date.
  let path = `orders?select=*,order_items(*),balance_payments(created_at,amount,payment_method)&order=created_at.desc&limit=100${NOT_DELETED}`;

  // Fetching a single order by id -- used to load an existing order
  // into the order form for editing. Takes priority over q/status
  // since it identifies exactly one row. Excludes soft-deleted orders --
  // a deleted order is only viewable/actionable from the Trash tab, not
  // editable via the normal order form.
  if (id && typeof id === 'string') {
    path = `orders?select=*,order_items(*),balance_payments(amount)&id=eq.${encodeURIComponent(id)}${NOT_DELETED}&limit=1`;
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

  // Rx / Non-Rx filter on the orders list -- same eq. pattern as status.
  if (order_type && isValidOrderType(order_type)) {
    path += `&order_type=eq.${encodeURIComponent(order_type)}`;
  }

  if (q && typeof q === 'string' && q.trim()) {
    // Search across order number and patient name — PostgREST "or" filter.
    const term = encodeURIComponent(`%${q.trim()}%`);
    path += `&or=(order_no.ilike.${term},patient_name.ilike.${term})`;
  }

  // Filter by the order's own (nominal) date -- not created_at -- so a
  // backdated order shows up under the day staff actually meant, same
  // fix as the orders report. Both bounds are inclusive and optional.
  //
  // On top of that: a date range also pulls in any order that ISN'T in
  // that range by its own date, but had a balance payment collected
  // within it -- otherwise a balance paid today against an order placed
  // days ago never showed up under "Today" here at all, even though
  // it's exactly the kind of thing staff filtering to "today" want to
  // see (the order's own order_date column is untouched either way --
  // this only widens which orders the list considers, same fix made to
  // the Orders/Sales reports on 2026-10-02).
  const validFrom = from && typeof from === 'string' && ORDER_DATE_RE.test(from) ? from : null;
  const validTo = to && typeof to === 'string' && ORDER_DATE_RE.test(to) ? to : null;

  if (validFrom || validTo) {
    const dateConds = [];
    if (validFrom) dateConds.push(`order_date.gte.${encodeURIComponent(validFrom)}`);
    if (validTo) dateConds.push(`order_date.lte.${encodeURIComponent(validTo)}`);

    let paidInRangeIds = [];
    try {
      let payPath = 'balance_payments?select=order_id&limit=5000';
      if (validFrom) payPath += `&created_at=gte.${encodeURIComponent(validFrom)}T00:00:00`;
      if (validTo) payPath += `&created_at=lte.${encodeURIComponent(validTo)}T23:59:59`;
      const payResp = await supabaseRequest(payPath, { method: 'GET' });
      if (payResp.ok) {
        const payRows = await payResp.json();
        paidInRangeIds = [...new Set(payRows.map(r => r.order_id).filter(Boolean))];
      } else {
        console.error('Could not check for in-range balance payments:', payResp.status, await payResp.text());
      }
    } catch (payErr) {
      console.error('Could not check for in-range balance payments:', payErr);
    }

    if (paidInRangeIds.length > 0) {
      const idList = paidInRangeIds.map(oid => encodeURIComponent(oid)).join(',');
      path += `&or=(and(${dateConds.join(',')}),id.in.(${idList}))`;
    } else {
      dateConds.forEach(cond => { path += `&${cond}`; });
    }
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

async function updateOrderStatus(req, res, session) {
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
  patch.updated_at = new Date().toISOString();
  patch.updated_by = session.username;

  try {
    let beforeRow = null;
    try {
      const beforeResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}&limit=1`, { method: 'GET' });
      if (beforeResp.ok) {
        const [row] = await beforeResp.json();
        beforeRow = row || null;
      }
    } catch (beforeErr) {
      console.error('Could not load pre-edit order for audit diff:', beforeErr);
    }

    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}${NOT_DELETED}`, {
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

    const changes = diffFields(beforeRow, patch);
    if (Object.keys(changes).length > 0) {
      logOrderAudit({
        orderId: id,
        orderNo: updated ? updated.order_no : (beforeRow ? beforeRow.order_no : ''),
        action: statusProvided && paymentStatusProvided
          ? 'status_change'
          : (statusProvided ? 'status_change' : 'payment_status_change'),
        changedBy: session.username,
        changes,
      });
    }

    res.status(200).json({ ok: true, order: updated });
  } catch (err) {
    console.error('Unexpected error updating order:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Returns this order's full audit trail: edit/status-change history from
// order_audit_log plus its balance_payments, merged into one
// chronological list so staff can see everything that happened to an
// order -- who created it, who changed it, who collected each payment,
// and when -- in one place.
async function getOrderAudit(req, res) {
  const { id } = req.query || {};
  try {
    // order_audit_log alone is the full timeline -- every balance
    // payment already writes a 'balance_payment' row here (see
    // balance-payments.js), so also fetching the balance_payments
    // table directly would double up every payment in the list. That
    // used to happen; fixed by treating order_audit_log as the single
    // source of truth for this view.
    const logResp = await supabaseRequest(`order_audit_log?order_id=eq.${encodeURIComponent(id)}&order=created_at.asc`, { method: 'GET' });

    if (!logResp.ok) {
      console.error('Audit trail fetch error:', logResp.status);
      res.status(502).json({ ok: false, error: 'Could not load the audit trail.' });
      return;
    }

    const timeline = (await logResp.json()).map(row => ({
      type: 'audit',
      action: row.action,
      changed_by: row.changed_by,
      changes: row.changes,
      created_at: row.created_at,
    }));

    res.status(200).json({ ok: true, timeline });
  } catch (err) {
    console.error('Unexpected error loading order audit trail:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// ---- Next order number suggestion ----
// Rx and Non-Rx orders use DIFFERENT formats and DIFFERENT reset periods:
//   Rx      : YYYY-NNNN        (e.g. "2025-0001")       -- resets YEARLY
//   Non-Rx  : YYYY-MM-NNNN     (e.g. "2025-01-0001")    -- resets MONTHLY
// Each type's counter is independent of the other. Purely a suggestion --
// the order form field stays editable, and nothing here reserves or locks
// the number. Folded in from its own /api/next-order-number route to stay
// under Vercel Hobby's 12-serverless-function limit -- it's small,
// order-specific, and only ever called from the order form.
const RX_ORDER_NO_RE = /^(\d{4})-(\d{4,})$/;
const NON_RX_ORDER_NO_RE = /^(\d{4})-(\d{2})-(\d{4,})$/;

function suggestNextRx(existingOrderNos, currentYear) {
  let maxCounter = 0;
  let widestPadding = 4;
  for (const orderNo of existingOrderNos) {
    const trimmed = (orderNo || '').trim();
    const match = trimmed.match(RX_ORDER_NO_RE);
    if (!match) continue;
    const [, year, counterStr] = match;
    if (year !== String(currentYear)) continue;
    const counterValue = parseInt(counterStr, 10);
    if (counterValue > maxCounter) {
      maxCounter = counterValue;
      widestPadding = counterStr.length;
    }
  }
  const next = maxCounter + 1;
  return `${currentYear}-${String(next).padStart(widestPadding, '0')}`;
}

function suggestNextNonRx(existingOrderNos, currentYear, currentMonth) {
  let maxCounter = 0;
  let widestPadding = 4;
  const monthStr = String(currentMonth).padStart(2, '0');
  for (const orderNo of existingOrderNos) {
    const trimmed = (orderNo || '').trim();
    const match = trimmed.match(NON_RX_ORDER_NO_RE);
    if (!match) continue;
    const [, year, month, counterStr] = match;
    if (year !== String(currentYear) || month !== monthStr) continue;
    const counterValue = parseInt(counterStr, 10);
    if (counterValue > maxCounter) {
      maxCounter = counterValue;
      widestPadding = counterStr.length;
    }
  }
  const next = maxCounter + 1;
  return `${currentYear}-${monthStr}-${String(next).padStart(widestPadding, '0')}`;
}

async function nextOrderNumber(req, res) {
  const { order_type } = req.query || {};
  if (order_type !== 'rx' && order_type !== 'non_rx') {
    res.status(400).json({ ok: false, error: 'order_type must be "rx" or "non_rx".' });
    return;
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  try {
    let prefix;
    if (order_type === 'rx') {
      prefix = encodeURIComponent(`${currentYear}-%`);
    } else {
      const monthStr = String(currentMonth).padStart(2, '0');
      prefix = encodeURIComponent(`${currentYear}-${monthStr}-%`);
    }

    const resp = await supabaseRequest(
      `orders?select=order_no&order_no=ilike.${prefix}&order=order_no.desc&limit=500`,
      { method: 'GET' }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase next-order-number error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not determine next order number.' });
      return;
    }

    const rows = await resp.json();
    const orderNos = rows.map(r => r.order_no);

    const suggestion = order_type === 'rx'
      ? suggestNextRx(orderNos, currentYear)
      : suggestNextNonRx(orderNos, currentYear, currentMonth);

    res.status(200).json({ ok: true, suggestion });
  } catch (err) {
    console.error('Unexpected error suggesting next order number:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// ---------------------------------------------------------------------
// Soft delete / Trash. Any logged-in staff member can soft-delete an
// order (DELETE ?id=X); only an admin can list the trash, restore, or
// permanently delete, from the Trash tab on Settings.
// ---------------------------------------------------------------------

async function softDeleteOrder(req, res, session) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'An order id is required.' });
    return;
  }
  try {
    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}${NOT_DELETED}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ deleted_at: new Date().toISOString(), deleted_by: session.username }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase order soft-delete error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not delete this order.' });
      return;
    }
    const [deleted] = await resp.json();
    if (!deleted) {
      res.status(404).json({ ok: false, error: 'Order not found (it may already be deleted).' });
      return;
    }
    res.status(200).json({ ok: true, order: deleted });
  } catch (err) {
    console.error('Unexpected error soft-deleting order:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Admin only, from here down.

async function listDeletedOrders(req, res) {
  try {
    const path = 'orders?select=*,order_items(*)&deleted_at=not.is.null&order=deleted_at.desc&limit=500';
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase deleted-orders list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load the trash.' });
      return;
    }
    const orders = await resp.json();
    res.status(200).json({ ok: true, orders });
  } catch (err) {
    console.error('Unexpected error listing deleted orders:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function restoreOrder(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'An order id is required.' });
    return;
  }
  try {
    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}&deleted_at=not.is.null`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ deleted_at: null, deleted_by: null }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase order restore error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not restore this order.' });
      return;
    }
    const [restored] = await resp.json();
    if (!restored) {
      res.status(404).json({ ok: false, error: 'Deleted order not found.' });
      return;
    }
    res.status(200).json({ ok: true, order: restored });
  } catch (err) {
    console.error('Unexpected error restoring order:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Permanent delete -- only reachable for a row already in the trash
// (deleted_at not null), so this can never be used to skip the soft
// delete step. Also removes the order's line items first since they
// have a foreign key on order_id with no cascade configured.
async function purgeOrder(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'An order id is required.' });
    return;
  }
  try {
    const checkResp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}&deleted_at=not.is.null&limit=1`, { method: 'GET' });
    if (!checkResp.ok) {
      res.status(502).json({ ok: false, error: 'Could not verify this order.' });
      return;
    }
    const [existing] = await checkResp.json();
    if (!existing) {
      res.status(404).json({ ok: false, error: 'This order is not in the trash.' });
      return;
    }

    await supabaseRequest(`order_items?order_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });

    const resp = await supabaseRequest(`orders?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase order purge error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not permanently delete this order.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error purging order:', err);
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

  if (req.method === 'POST') return createOrder(req, res, session);
  if (req.method === 'GET') {
    // ?next_order_number=1&order_type=X suggests the next order number
    // (was its own /api/next-order-number route -- folded in here to
    // save a serverless function slot; see nextOrderNumber() above).
    if (req.query && req.query.next_order_number === '1') {
      return nextOrderNumber(req, res);
    }
    // ?id=X&audit=1 fetches this order's audit trail (edits + status
    // changes) instead of the order itself -- used by the order
    // detail/history views to show a "who changed what, when" log.
    if (req.query && req.query.audit === '1' && req.query.id) {
      return getOrderAudit(req, res);
    }
    // ?trash=1 lists soft-deleted orders -- admin only, for the Trash
    // tab on Settings.
    if (req.query && req.query.trash === '1') {
      if (!requireAdmin(req, res)) return;
      return listDeletedOrders(req, res);
    }
    return listOrders(req, res);
  }
  if (req.method === 'PATCH') {
    // ?action=restore brings a soft-deleted order back -- admin only.
    if (req.query && req.query.action === 'restore') {
      if (!requireAdmin(req, res)) return;
      return restoreOrder(req, res);
    }
    // Distinguish the full order-form edit from the lightweight
    // status/payment-only quick-edit used by the staff-orders list's
    // inline dropdowns -- same route, explicit flag decides which
    // handler runs, so neither one has to guess from field presence.
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    if (body && body.full_edit === true) return updateOrderFull(req, res, session);
    return updateOrderStatus(req, res, session);
  }
  if (req.method === 'DELETE') {
    // ?purge=1 permanently deletes an already-soft-deleted order --
    // admin only. Plain DELETE (no purge flag) is the everyday soft
    // delete, available to any logged-in staff member.
    if (req.query && req.query.purge === '1') {
      if (!requireAdmin(req, res)) return;
      return purgeOrder(req, res);
    }
    return softDeleteOrder(req, res, session);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
