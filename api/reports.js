// Staff-facing reports, exported as CSV. Four report types, chosen via
// ?type=:
//   orders    -> every order, one row per order (Rx + Non-Rx combined)
//   sales     -> revenue summary: orders + balance payments within a
//                date range, with running totals by payment method
//   patients  -> the full patient list
//   inventory -> current catalog stock levels
//
// Date filtering (orders, sales) via ?from=YYYY-MM-DD&to=YYYY-MM-DD,
// both optional -- omitting both returns everything.
//
// Available to any logged-in staff member, same access level as the
// orders list, patient lookup, and catalog already have.

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  // Quote any field containing a comma, quote, or newline; double up
  // internal quotes per standard CSV escaping.
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows, columns) {
  const header = columns.map(c => csvEscape(c.label)).join(',');
  const lines = rows.map(row =>
    columns.map(c => csvEscape(typeof c.value === 'function' ? c.value(row) : row[c.value])).join(',')
  );
  return [header, ...lines].join('\r\n');
}

function sendCsv(res, filename, csvContent) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // BOM so Excel opens UTF-8 (₱ sign, etc.) correctly instead of
  // mangling it into other characters.
  res.status(200).send('\uFEFF' + csvContent);
}

function dateRangeFilter(from, to, field) {
  let filter = '';
  if (from) filter += `&${field}=gte.${encodeURIComponent(from)}T00:00:00`;
  if (to) filter += `&${field}=lte.${encodeURIComponent(to)}T23:59:59`;
  return filter;
}

async function ordersReport(req, res, from, to) {
  try {
    const path = `orders?select=*,order_items(*)&order=created_at.desc&limit=5000${dateRangeFilter(from, to, 'created_at')}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load orders for the report.' });
      return;
    }
    const orders = await resp.json();

    const columns = [
      { label: 'Order #', value: 'order_no' },
      { label: 'Date', value: (o) => (o.created_at || '').slice(0, 10) },
      { label: 'Type', value: (o) => (o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx')) },
      { label: 'Patient', value: 'patient_name' },
      { label: 'Phone', value: 'tel_no' },
      { label: 'Frame', value: 'frame' },
      { label: 'Lens Type', value: 'lens_type' },
      { label: 'Items', value: (o) => (o.order_items || []).map(i => `${i.item_name} x${i.item_qty}`).join('; ') },
      { label: 'Amount', value: 'amount' },
      { label: 'Deposit', value: 'deposit' },
      { label: 'Balance', value: 'balance' },
      { label: 'Payment Status', value: 'payment_status' },
      { label: 'Payment Method', value: 'payment_method' },
      { label: 'Status', value: 'status' },
      { label: 'Taken By', value: 'taken_by' },
    ];

    sendCsv(res, `orders-report-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(orders, columns));
  } catch (err) {
    console.error('Unexpected error generating orders report:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function salesReport(req, res, from, to) {
  try {
    const [ordersResp, paymentsResp] = await Promise.all([
      supabaseRequest(
        `orders?select=order_no,created_at,patient_name,amount,deposit,balance,payment_status,payment_method,split_cash,split_gcash&order=created_at.desc&limit=5000${dateRangeFilter(from, to, 'created_at')}`,
        { method: 'GET' }
      ),
      supabaseRequest(
        `balance_payments?select=*&order=created_at.desc&limit=5000${dateRangeFilter(from, to, 'created_at')}`,
        { method: 'GET' }
      ),
    ]);

    const orders = ordersResp.ok ? await ordersResp.json() : [];
    const payments = paymentsResp.ok ? await paymentsResp.json() : [];

    // Combine both into one chronological list of payment EVENTS -- an
    // order's own deposit/amount collected at creation, plus any later
    // balance payments logged against it. This gives a true picture of
    // money actually collected in the date range, not just orders placed.
    const rows = [];
    orders.forEach(o => {
      const collected = parseFloat(o.deposit) || 0;
      if (collected > 0) {
        rows.push({
          date: (o.created_at || '').slice(0, 10),
          order_no: o.order_no,
          patient_name: o.patient_name,
          amount_collected: collected.toFixed(2),
          method: o.payment_method || 'cash',
          split_cash: o.split_cash || '',
          split_gcash: o.split_gcash || '',
          source: 'Order deposit',
        });
      }
    });
    payments.forEach(p => {
      rows.push({
        date: (p.created_at || '').slice(0, 10),
        order_no: p.order_no,
        patient_name: '',
        amount_collected: parseFloat(p.amount || 0).toFixed(2),
        method: p.payment_method || 'cash',
        split_cash: p.split_cash || '',
        split_gcash: p.split_gcash || '',
        source: 'Balance payment',
      });
    });
    rows.sort((a, b) => (a.date < b.date ? 1 : -1));

    const totalCollected = rows.reduce((sum, r) => sum + (parseFloat(r.amount_collected) || 0), 0);
    const totalCash = rows.reduce((sum, r) => {
      if (r.method === 'cash') return sum + (parseFloat(r.amount_collected) || 0);
      if (r.method === 'split') return sum + (parseFloat(r.split_cash) || 0);
      return sum;
    }, 0);
    const totalGcash = rows.reduce((sum, r) => {
      if (r.method === 'gcash_cc') return sum + (parseFloat(r.amount_collected) || 0);
      if (r.method === 'split') return sum + (parseFloat(r.split_gcash) || 0);
      return sum;
    }, 0);

    const columns = [
      { label: 'Date', value: 'date' },
      { label: 'Order #', value: 'order_no' },
      { label: 'Patient', value: 'patient_name' },
      { label: 'Amount Collected', value: 'amount_collected' },
      { label: 'Method', value: 'method' },
      { label: 'Split — Cash', value: 'split_cash' },
      { label: 'Split — GCash/CC', value: 'split_gcash' },
      { label: 'Source', value: 'source' },
    ];

    let csvContent = toCsv(rows, columns);
    csvContent += '\r\n\r\n';
    csvContent += `Total Collected,${totalCollected.toFixed(2)}\r\n`;
    csvContent += `Total Cash,${totalCash.toFixed(2)}\r\n`;
    csvContent += `Total GCash/CC,${totalGcash.toFixed(2)}\r\n`;

    sendCsv(res, `sales-report-${new Date().toISOString().slice(0, 10)}.csv`, csvContent);
  } catch (err) {
    console.error('Unexpected error generating sales report:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function patientsReport(req, res) {
  try {
    const resp = await supabaseRequest('patients?select=*&order=name.asc&limit=5000', { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load patients for the report.' });
      return;
    }
    const patients = await resp.json();

    const columns = [
      { label: 'Name', value: 'name' },
      { label: 'Phone', value: 'phone' },
      { label: 'Email', value: 'email' },
      { label: 'Patient Since', value: (p) => (p.created_at || '').slice(0, 10) },
    ];

    sendCsv(res, `patients-report-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(patients, columns));
  } catch (err) {
    console.error('Unexpected error generating patients report:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function inventoryReport(req, res) {
  try {
    const resp = await supabaseRequest('catalog_items?select=*&order=category.asc,name.asc&limit=5000', { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load inventory for the report.' });
      return;
    }
    const items = await resp.json();

    const columns = [
      { label: 'Category', value: (i) => (i.category === 'frame' ? 'Frame' : 'Lens') },
      { label: 'Code', value: 'code' },
      { label: 'Brand', value: 'brand' },
      { label: 'Name', value: 'name' },
      { label: 'Base Price', value: 'base_price' },
      { label: 'Sale Price', value: 'price' },
      { label: 'Qty on Hand', value: 'qty' },
      { label: 'Status', value: (i) => (i.active === false ? 'Inactive' : 'Active') },
    ];

    sendCsv(res, `inventory-report-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(items, columns));
  } catch (err) {
    console.error('Unexpected error generating inventory report:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

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

  const { type, from, to } = req.query || {};

  if (type === 'orders') return ordersReport(req, res, from, to);
  if (type === 'sales') return salesReport(req, res, from, to);
  if (type === 'patients') return patientsReport(req, res);
  if (type === 'inventory') return inventoryReport(req, res);

  res.status(400).json({ ok: false, error: 'type must be one of: orders, sales, patients, inventory' });
};
