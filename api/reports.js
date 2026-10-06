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

// Shared by both the Orders and Sales reports: one row per order (not per
// payment event). Rx orders are always a single job, so Qty is always 1
// regardless of what (if anything) is saved in item_qty -- this covers
// older Rx orders from before the order-form Qty field existed too.
// Non-Rx orders have no fixed Qty -- it's every order_items line item's
// quantity added together, reading as "how many units on this order"
// rather than a list of individual items.
function totalQty(o) {
  // A balance-payment row (see fetchPaymentRows() below) is always 1
  // transaction -- one payment collected, regardless of how many items
  // or what quantity the underlying order itself carries.
  if (o.__entry === 'payment') return '1';
  // Rx orders are always "one job" -- Qty is always 1, regardless of
  // whether item_qty was saved on the order form (older orders predate
  // that field and have no item_qty at all).
  if (o.order_type !== 'non_rx') return '1';
  const items = o.order_items || [];
  if (items.length > 0) {
    return items.reduce((sum, i) => sum + (parseInt(i.item_qty, 10) || 0), 0) || '';
  }
  return o.item_qty || '';
}

// Both reports originally showed one row per ORDER, dated by when the
// order was created -- so a balance paid today against an order placed
// days ago never produced any row dated today at all, even though real
// money changed hands today. This pulls every balance payment actually
// collected within the report's date range (dated by when it was
// logged, via balance_payments.created_at, not the parent order's own
// date) and turns each into its own report row shaped like an order
// row, so it flows through the same `columns` definitions as a normal
// order row below.
//
// Each payment row's Amount is just that payment (not the order's full
// price -- the order's own row already counted that), Deposit is blank
// (that term is specific to the order-intake payment), and Balance is
// the order's balance immediately after this payment (balance_after,
// recorded by api/balance-payments.js at the moment it was logged --
// added 2026-10-02; a payment logged before that column existed shows
// a blank Balance here rather than a guessed number). Payment Method is
// this payment's own method, which can genuinely differ from the
// order's original deposit method -- e.g. deposit paid cash, balance
// paid GCash -- something the order-only view could never show. Taken
// By is who collected THIS payment specifically, not whoever originally
// took the order.
//
// Patient/Frame/Lens/Type/Phone are carried over from the parent order
// (fetched via PostgREST's relationship embed in one round trip) purely
// for cross-reference, regardless of whether that order's own date
// falls inside this report's range or whether it's since been
// soft-deleted (embed comes back empty/null in that case, handled
// below).
async function fetchPaymentRows(from, to) {
  const path = `balance_payments?select=*,orders(order_no,order_date,patient_name,frame,lens_type,order_type,rx_subtype,tel_no,payment_status,status)&order=created_at.desc&limit=5000${dateRangeFilter(from, to, 'created_at')}`;
  const resp = await supabaseRequest(path, { method: 'GET' });
  if (!resp.ok) {
    const errText = await resp.text();
    console.error('Supabase balance_payments read error:', resp.status, errText);
    return [];
  }
  const payments = await resp.json();
  return payments.map(p => {
    const order = p.orders || {};
    return {
      __entry: 'payment',
      order_no: p.order_no || order.order_no || '',
      patient_name: order.patient_name || '',
      frame: order.frame || '',
      lens_type: order.lens_type || '',
      order_type: order.order_type || '',
      rx_subtype: order.rx_subtype || '',
      tel_no: order.tel_no || '',
      payment_status: order.payment_status || '',
      status: order.status || '',
      // Order Date always stays the order's OWN date -- when it was
      // actually placed -- never the date of a later payment against
      // it; that distinction is what Transaction Date (below) is for.
      order_date: order.order_date || '',
      // When this row's own event actually happened: for a payment row,
      // that's when the payment was collected (not the order's date).
      transaction_date: (p.created_at || '').slice(0, 10),
      created_at: p.created_at,
      amount: p.amount,
      deposit: '',
      payment_method: p.payment_method,
      split_cash: p.split_cash || '',
      split_gcash: p.split_gcash || '',
      balance: p.balance_after || '',
      order_items: [],
      item_qty: '',
      taken_by: p.taken_by || '',
    };
  });
}

// Same display labels used on the order form / staff-orders payment
// method dropdowns, so a report reads the same way staff already do.
function paymentMethodLabel(method) {
  if (method === 'gcash_cc') return 'GCash/CC';
  if (method === 'split') return 'Split';
  return 'Cash';
}

// What the Orders report's "Items" column shows for a Balance Payment
// row (an order row keeps its normal item list, untouched) -- there are
// no items on a payment, but leaving the column blank throws away the
// one thing a standalone payment row most needs to be useful at a
// glance: how much, how it was paid, and the split breakdown if any,
// all in the one column staff are already scanning for "what is this
// row." Not a replacement for the dedicated Amount/Payment Method
// columns -- those stay authoritative -- just a readable summary.
function paymentRowSummary(p) {
  const amount = parseFloat(p.amount) || 0;
  const methodLabel = paymentMethodLabel(p.payment_method);
  let detail = methodLabel;
  if (p.payment_method === 'split') {
    const parts = [];
    if (p.split_cash) parts.push(`Cash ₱${p.split_cash}`);
    if (p.split_gcash) parts.push(`GCash/CC ₱${p.split_gcash}`);
    if (parts.length) detail = `Split: ${parts.join(' / ')}`;
  }
  return `Balance payment -- ₱${amount.toFixed(2)} (${detail})`;
}

// Combines an order-rows array (already tagged __entry: 'order') with
// the payment rows above into one list, sorted newest-first by the
// timestamp each row actually represents -- an order's own created_at
// for an order row, or when it was collected for a payment row -- so
// the two interleave in the one true chronological order rather than
// all orders first, then all payments.
// Balance shown on a report row. A Balance Payment row shows the balance
// right after that payment (balance_after). An Order row shows what was
// still owed when the order was placed (Total minus the intake deposit),
// not the order's live balance -- otherwise an order settled later reads
// as owing nothing on the day it was taken. Set to false to go back to
// showing the order's current balance on Order rows (changed 2026-10-05).
const ORDER_ROW_BALANCE_AS_OF_INTAKE = true;
function rowBalance(o) {
  if (o.__entry === 'payment' || !ORDER_ROW_BALANCE_AS_OF_INTAKE) return o.balance;
  const amount = parseFloat(o.amount);
  if (!Number.isFinite(amount)) return o.balance;
  const deposit = parseFloat(o.deposit) || 0;
  return Math.max(amount - deposit, 0).toFixed(2);
}

function mergeRowsByDate(orderRows, paymentRows) {
  return [...orderRows, ...paymentRows].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// ---------------------------------------------------------------------
// Column choice for the Orders and Sales downloads. The page can ask for a
// subset, in its own order, with ?cols=Label1,Label2,... (labels exactly as
// below). Unknown labels are ignored; nothing valid = every column in the
// default order. ?meta=columns returns the labels so the page never keeps
// its own copy of the list.
// ---------------------------------------------------------------------
function pickColumns(all, colsParam) {
  if (typeof colsParam !== 'string' || !colsParam.trim()) return all;
  const byLabel = new Map(all.map(c => [c.label, c]));
  const seen = new Set();
  const picked = [];
  colsParam.split(',').map(x => x.trim()).forEach(label => {
    if (byLabel.has(label) && !seen.has(label)) { seen.add(label); picked.push(byLabel.get(label)); }
  });
  return picked.length ? picked : all;
}

const ORDERS_COLUMNS = [
  { label: 'Order Date', value: (o) => o.order_date || '' },
  { label: 'Order #', value: 'order_no' },
  { label: 'Patient', value: 'patient_name' },
  { label: 'Frame', value: 'frame' },
  { label: 'Lens Type', value: 'lens_type' },
  { label: 'Type', value: (o) => (o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx')) },
  { label: 'Qty', value: totalQty },
  // "Total" and "Payment Today" replace the old Amount/Deposit pair
  // (2026-10-05) so this report reads the same as the Sales report:
  // Total is the order's price (blank on a Balance Payment row, so
  // the column can be summed without double-counting), and Payment
  // Today is the money collected on that row -- the intake deposit
  // on an Order row, the payment itself on a Balance Payment row.
  { label: 'Total', value: (o) => (o.__entry === 'payment' ? '' : o.amount) },
  { label: 'Payment Today', value: (o) => (o.__entry === 'payment' ? o.amount : o.deposit) },
  { label: 'Payment Method', value: 'payment_method' },
  { label: 'Transaction Date', value: (o) => o.transaction_date || '' },
  { label: 'Entry', value: (o) => (o.__entry === 'payment' ? 'Balance Payment' : 'Order') },
  { label: 'Balance', value: rowBalance },
  // -- not on the client's sheet, appended at the end --
  { label: 'Created Date', value: (o) => (o.created_at || '').slice(0, 10) },
  { label: 'Phone', value: 'tel_no' },
  { label: 'Items', value: (o) => (o.__entry === 'payment' ? paymentRowSummary(o) : (o.order_items || []).map(i => `${i.item_name} x${i.item_qty}`).join('; ')) },
  { label: 'Payment Status', value: 'payment_status' },
  { label: 'Status', value: 'status' },
  { label: 'Taken By', value: 'taken_by' },
];

const SALES_COLUMNS = [
  { label: 'Order Date', value: (o) => o.order_date || '' },
  { label: 'Order #', value: 'order_no' },
  { label: 'Patient', value: 'patient_name' },
  { label: 'Frame', value: 'frame' },
  { label: 'Lens', value: 'lens_type' },
  { label: 'Type', value: (o) => (o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx')) },
  { label: 'Qty', value: totalQty },
  { label: 'Total', value: (o) => (o.__entry === 'payment' ? '' : o.amount) },
  { label: 'Payment Today', value: (o) => (o.__entry === 'payment' ? o.amount : o.deposit) },
  { label: 'Payment Method', value: 'payment_method' },
  { label: 'Transaction Date', value: (o) => o.transaction_date || '' },
  { label: 'Entry', value: (o) => (o.__entry === 'payment' ? 'Balance Payment' : 'Order') },
  { label: 'Balance', value: rowBalance },
  // -- not on the client's sheet, appended at the end --
  { label: 'Payment Status', value: 'payment_status' },
  { label: 'Status', value: 'status' },
  { label: 'Taken By', value: 'taken_by' },
];

async function ordersReport(req, res, from, to) {
  try {
    const path = `orders?select=*,order_items(*)&order=created_at.desc&limit=5000&deleted_at=is.null${dateRangeFilter(from, to, 'created_at')}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load orders for the report.' });
      return;
    }
    const orders = await resp.json();
    const orderRows = orders.map(o => ({ ...o, __entry: 'order', transaction_date: (o.created_at || '').slice(0, 10) }));
    const paymentRows = await fetchPaymentRows(from, to);
    const rows = mergeRowsByDate(orderRows, paymentRows);

    // Column order mirrors the client's own paper/Excel "Job Orders" sheet
    // (Job# -> Patient -> Frame -> Lens -> Type -> Total -> Deposit ->
    // Payment Method -> Balance) so a report can be compared side by side
    // with their existing sheet without re-sorting columns by hand.
    // Date leads since their sheet has no date column at all (each tab is
    // one day). Everything their sheet doesn't have is appended at the
    // end, in the same order it was in before, rather than interleaved.
    //
    // Payment Method and Balance swapped 2026-10-02 to match the Sales
    // report's own fix (2026-09-30), confirming the client's "Oct 1 2026"
    // sheet reordered this same pair on the Job Orders tab too. Qty
    // added the same day (matching the Sales report's own Qty column)
    // after this report was found to be missing it entirely.
    //
    // "Transaction Date" and "Entry" added the same day a balance
    // payment collected today against an order placed days ago was
    // found to produce no row dated today at all -- the report only
    // ever looked at orders.created_at. Each payment now gets its own
    // row (see fetchPaymentRows()). "Order Date" always stays that
    // order's own placement date, even on a payment row, so it never
    // changes meaning -- "Transaction Date" is the date THIS row's own
    // event happened (the payment's own date, on a payment row), and
    // "Entry" says which kind of row it is. Moved 2026-10-02 to sit
    // right after Payment Method and before Balance -- between what
    // was paid and how, and the resulting balance -- per the client's
    // own placement of a "Date"/"Payment type" pair in that same spot
    // on their sheet, rather than appended after everything else.
    const columns = pickColumns(ORDERS_COLUMNS, req.query && req.query.cols);

    sendCsv(res, `orders-report-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows, columns));
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
    const orderRows = orders.map(o => ({ ...o, __entry: 'order', transaction_date: (o.created_at || '').slice(0, 10) }));
    const paymentRows = await fetchPaymentRows(from, to);
    const rows = mergeRowsByDate(orderRows, paymentRows);

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
    //
    // "Transaction Date", "Entry" and "Payment Today" on a Balance
    // Payment row: see the "Transaction Date"/"Entry" comment in
    // ordersReport() above for why these rows exist and why Order Date
    // stays the order's own date while Transaction Date carries the
    // payment's own date instead. Moved 2026-10-02, same as
    // ordersReport(), to sit right after Payment Method and before
    // Balance. "Payment Today" normally shows the order's intake
    // deposit -- on a payment row there's no separate "deposit"
    // concept, so it shows that payment's own amount instead, which is
    // exactly what "payment today" means for that row.
    const columns = pickColumns(SALES_COLUMNS, req.query && req.query.cols);

    // Unchanged from before "Entry" rows existed -- these three stay
    // order-level sums (total billed, total collected at intake, total
    // still owed as of now) computed from the actual orders only, so
    // they keep matching the client's own paper-sheet totals rather
    // than double-counting a balance payment on top of the order's full
    // amount. What those sums were missing -- cash collected from
    // balance payments within this date range -- is its own new line
    // below instead of folded into "Total Deposit".
    const totalAmount = orders.reduce((sum, o) => sum + (parseFloat(o.amount) || 0), 0);
    const totalDeposit = orders.reduce((sum, o) => sum + (parseFloat(o.deposit) || 0), 0);
    const totalBalance = orders.reduce((sum, o) => sum + (parseFloat(o.balance) || 0), 0);
    const totalBalancePayments = paymentRows.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

    let csvContent = toCsv(rows, columns);
    csvContent += '\r\n\r\n';
    csvContent += `Total Amount,${totalAmount.toFixed(2)}\r\n`;
    csvContent += `Total Deposit,${totalDeposit.toFixed(2)}\r\n`;
    csvContent += `Total Balance,${totalBalance.toFixed(2)}\r\n`;
    csvContent += `Total Balance Payments Collected,${totalBalancePayments.toFixed(2)}\r\n`;

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

  if (req.query && req.query.meta === 'columns' && (type === 'orders' || type === 'sales')) {
    const all = type === 'orders' ? ORDERS_COLUMNS : SALES_COLUMNS;
    return res.status(200).json({ ok: true, columns: all.map(c => c.label) });
  }
  if (type === 'orders') return ordersReport(req, res, from, to);
  if (type === 'sales') return salesReport(req, res, from, to);
  if (type === 'patients') return patientsReport(req, res);
  if (type === 'inventory') return inventoryReport(req, res);
  if (type === 'expenses') return expensesReport(req, res, from, to);
  if (type === 'withdrawals') return withdrawalsReport(req, res, from, to);
};
