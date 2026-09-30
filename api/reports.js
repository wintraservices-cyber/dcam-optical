// Staff-facing reports, exported as CSV. Report types, chosen via ?type=:
//   orders      -> every order, one row per order (Rx + Non-Rx combined)
//   sales       -> one row per order within a date range (order date,
//                  order #, patient, frame, lens, type, qty, total,
//                  deposit, payment type, balance, payment status,
//                  status, taken by), with Amount/Deposit/Balance
//                  totals at the bottom
//   patients    -> the full patient list
//   inventory   -> current catalog stock levels
//   expenses    -> logged business expenses within a date range
//   withdrawals -> logged cash/check withdrawals within a date range,
//                  with Cash/Checking split columns and totals
//
// Date filtering (orders, sales, expenses, withdrawals) via
// ?from=YYYY-MM-DD&to=YYYY-MM-DD, both optional -- omitting both returns
// everything.
//
// Role-based access (RBAC): admins can export every report type above.
// Staff (non-admin) can only export orders, patients, and inventory --
// the same records they can already see and work with elsewhere in the
// app (orders list, patient lookup, catalog). Sales, expenses, and
// withdrawals surface money movement (revenue, payroll, cash draws)
// and are admin-only, matching the Expenses/Withdrawal tabs' own
// admin-gating on staff-expenses.html.

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const STAFF_ALLOWED_TYPES = ['orders', 'patients', 'inventory'];
const ADMIN_ONLY_TYPES = ['sales', 'expenses', 'withdrawals'];

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
    const path = `orders?select=*,order_items(*)&order=created_at.desc&limit=5000&deleted_at=is.null${dateRangeFilter(from, to, 'created_at')}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load orders for the report.' });
      return;
    }
    const orders = await resp.json();

    // Column order mirrors the client's own paper/Excel "Job Orders" sheet
    // (Job# -> Patient -> Frame -> Lens -> Type -> Total -> Deposit ->
    // Balance -> Payment Method) so a report can be compared side by side
    // with their existing sheet without re-sorting columns by hand.
    // Date leads since their sheet has no date column at all (each tab is
    // one day). Everything their sheet doesn't have is appended at the
    // end, in the same order it was in before, rather than interleaved.
    const columns = [
      { label: 'Order Date', value: (o) => o.order_date || '' },
      { label: 'Order #', value: 'order_no' },
      { label: 'Patient', value: 'patient_name' },
      { label: 'Frame', value: 'frame' },
      { label: 'Lens Type', value: 'lens_type' },
      { label: 'Type', value: (o) => (o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx')) },
      { label: 'Amount', value: 'amount' },
      { label: 'Deposit', value: 'deposit' },
      { label: 'Balance', value: 'balance' },
      { label: 'Payment Method', value: 'payment_method' },
      // -- not on the client's sheet, appended at the end --
      { label: 'Created Date', value: (o) => (o.created_at || '').slice(0, 10) },
      { label: 'Phone', value: 'tel_no' },
      { label: 'Items', value: (o) => (o.order_items || []).map(i => `${i.item_name} x${i.item_qty}`).join('; ') },
      { label: 'Payment Status', value: 'payment_status' },
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
    const path = `orders?select=*,order_items(*)&order=created_at.desc&limit=5000&deleted_at=is.null${dateRangeFilter(from, to, 'created_at')}`;
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

    // Column order mirrors the client's own "Sales" sheet (Job# -> Patient
    // -> Frame -> Lens -> Type -> Qty -> Total/Unit Price -> Payment today
    // -> Payment Method -> Balance) so this report can sit side by side
    // with their existing sheet without re-sorting columns by hand. Date
    // leads since their sheet has no date column at all (each tab is one
    // day). Everything their sheet doesn't have is appended at the end,
    // in the same order it was in before, rather than interleaved.
    //
    // Payment Method and Balance were swapped 2026-09-30 to match their
    // "Oct 1 2026" sheet, which reordered those two columns from how
    // their "Sep 29 2026" sheet had them (Balance, then Payment Method).
    const columns = [
      { label: 'Order Date', value: (o) => o.order_date || '' },
      { label: 'Order #', value: 'order_no' },
      { label: 'Patient', value: 'patient_name' },
      { label: 'Frame', value: 'frame' },
      { label: 'Lens', value: 'lens_type' },
      { label: 'Type', value: (o) => (o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx')) },
      { label: 'Qty', value: totalQty },
      { label: 'Total', value: 'amount' },
      { label: 'Payment Today', value: 'deposit' },
      { label: 'Payment Method', value: 'payment_method' },
      { label: 'Balance', value: 'balance' },
      // -- not on the client's sheet, appended at the end --
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
    const resp = await supabaseRequest('patients?select=*&order=name.asc&limit=5000&deleted_at=is.null', { method: 'GET' });
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

async function withdrawalsReport(req, res, from, to) {
  try {
    const path = `withdrawals?select=*&order=withdrawal_date.desc,created_at.desc&limit=5000${dateRangeFilter(from, to, 'withdrawal_date')}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load withdrawals for the report.' });
      return;
    }
    const withdrawals = await resp.json();

    // Cash/Checking are split display columns -- each row's amount shows
    // under whichever source it was, the other left blank -- matching
    // how the sample data (and a paper ledger) lays this out, rather
    // than a single "amount" column paired with a separate "source" one.
    const columns = [
      { label: 'Date', value: 'withdrawal_date' },
      { label: 'Description', value: 'description' },
      { label: 'Amount', value: 'amount' },
      { label: 'Source', value: (w) => (w.source === 'check' ? 'CHECK' : 'CASH') },
      { label: 'Cash', value: (w) => (w.source === 'cash' ? w.amount : '') },
      { label: 'Checking', value: (w) => (w.source === 'check' ? w.amount : '') },
      { label: 'Logged By', value: 'created_by' },
    ];

    const totalCash = withdrawals.reduce((sum, w) => sum + (w.source === 'cash' ? (parseFloat(w.amount) || 0) : 0), 0);
    const totalCheck = withdrawals.reduce((sum, w) => sum + (w.source === 'check' ? (parseFloat(w.amount) || 0) : 0), 0);

    let csvContent = toCsv(withdrawals, columns);
    csvContent += '\r\n\r\n';
    csvContent += `Total Cash,${totalCash.toFixed(2)}\r\n`;
    csvContent += `Total Checking,${totalCheck.toFixed(2)}\r\n`;
    csvContent += `Total Withdrawals,${(totalCash + totalCheck).toFixed(2)}\r\n`;

    sendCsv(res, `withdrawals-report-${new Date().toISOString().slice(0, 10)}.csv`, csvContent);
  } catch (err) {
    console.error('Unexpected error generating withdrawals report:', err);
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

  const session = requireAuth(req, res);
  if (!session) return;

  const { type, from, to } = req.query || {};

  const validTypes = [...STAFF_ALLOWED_TYPES, ...ADMIN_ONLY_TYPES];
  if (!validTypes.includes(type)) {
    res.status(400).json({ ok: false, error: `type must be one of: ${validTypes.join(', ')}` });
    return;
  }
  if (ADMIN_ONLY_TYPES.includes(type) && session.role !== 'admin') {
    res.status(403).json({ ok: false, error: 'This report requires an admin account.' });
    return;
  }

  if (type === 'orders') return ordersReport(req, res, from, to);
  if (type === 'sales') return salesReport(req, res, from, to);
  if (type === 'patients') return patientsReport(req, res);
  if (type === 'inventory') return inventoryReport(req, res);
  if (type === 'expenses') return expensesReport(req, res, from, to);
  if (type === 'withdrawals') return withdrawalsReport(req, res, from, to);
};
