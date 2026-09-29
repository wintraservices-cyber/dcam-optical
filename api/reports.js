// Staff-facing reports, exported as CSV. Four report types, chosen via
// ?type=:
//   orders    -> every order, one row per order (Rx + Non-Rx combined)
//   sales     -> one row per order within a date range (order date, order
//                #, patient, frame, lens, type, qty, total, deposit,
//                payment type, balance, payment status, status, taken
//                by), with Amount/Deposit/Balance totals at the bottom
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
      { label: 'Order Date', value: (o) => o.order_date || '' },
      { label: 'Created Date', value: (o) => (o.created_at || '').slice(0, 10) },
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
    const path = `orders?select=*,order_items(*)&order=created_at.desc&limit=5000${dateRangeFilter(from, to, 'created_at')}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load orders for the report.' });
      return;
    }
    const orders = await resp.json();

    // One row per order (not per payment event) -- qty is every line
    // item's quantity added together, so it reads as "how many units on
    // this order" rather than a list of individual items.
    const totalQty = (o) => (o.order_items || []).reduce((sum, i) => sum + (parseInt(i.item_qty, 10) || 0), 0) || '';

    const columns = [
      { label: 'Order Date', value: (o) => o.order_date || '' },
      { label: 'Order #', value: 'order_no' },
      { label: 'Patient', value: 'patient_name' },
      { label: 'Frame', value: 'frame' },
      { label: 'Lens', value: 'lens_type' },
      { label: 'Type', value: (o) => (o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx')) },
      { label: 'Qty', value: totalQty },
      { label: 'Total', value: 'amount' },
      { label: 'Deposit', value: 'deposit' },
      { label: 'Payment Type', value: 'payment_method' },
      { label: 'Balance', value: 'balance' },
      { label: 'Payment Status', value: 'payment_status' },
      { label: 'Status', value: 'status' },
      { label: 'Taken By', value: 'taken_by' },
    ];

    const totalAmount = orders.reduce((sum, o) => sum + (parseFloat(o.amount) || 0), 0);
    const totalDeposit = orders.reduce((sum, o) => sum + (parseFloat(o.deposit) || 0), 0);
    const totalBalance = orders.reduce((sum, o) => sum + (parseFloat(o.balance) || 0), 0);

    let csvContent = toCsv(orders, columns);
    csvContent += '\r\n\r\n';
    csvContent += `Total Amount,${totalAmount.toFixed(2)}\r\n`;
    csvContent += `Total Deposit,${totalDeposit.toFixed(2)}\r\n`;
    csvContent += `Total Balance,${totalBalance.toFixed(2)}\r\n`;

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

async function expensesReport(req, res, from, to) {
  try {
    const path = `expenses?select=*&order=expense_date.desc,created_at.desc&limit=5000${dateRangeFilter(from, to, 'expense_date')}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load expenses for the report.' });
      return;
    }
    const expenses = await resp.json();

    const columns = [
      { label: 'Date', value: 'expense_date' },
      { label: 'Type', value: 'type' },
      { label: 'Recipient / Details', value: 'details' },
      { label: 'Amount', value: 'amount' },
      { label: 'Logged By', value: 'created_by' },
    ];

    const total = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);

    let csvContent = toCsv(expenses, columns);
    csvContent += '\r\n\r\n';
    csvContent += `Total Expenses,${total.toFixed(2)}\r\n`;

    sendCsv(res, `expenses-report-${new Date().toISOString().slice(0, 10)}.csv`, csvContent);
  } catch (err) {
    console.error('Unexpected error generating expenses report:', err);
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
  if (type === 'expenses') return expensesReport(req, res, from, to);

  res.status(400).json({ ok: false, error: 'type must be one of: orders, sales, patients, inventory, expenses' });
};
