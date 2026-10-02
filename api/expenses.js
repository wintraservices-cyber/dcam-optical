// Business expenses (petty cash, payroll advances, supplies, etc.), and
// cash/check withdrawals (payroll runs, owner draws, etc.) -- both live
// in this one file/function rather than separate ones since Vercel's
// Hobby plan caps a project at 12 serverless functions and this project
// is already at that cap.
//
// Both resources are admin-only for every method, full stop -- staff
// never see the Expenses page at all (its nav button is hidden for
// them), and this endpoint backs that up server-side rather than
// relying on the UI alone. There used to be an app_settings
// 'expense_access' toggle letting an admin opt staff into logging
// expenses; that's been removed in favor of a flat admin-only rule, so
// there's no longer a setting that can quietly widen access.
//
// Both resources share the same request shape, selected via
// ?resource=expenses (default) or ?resource=withdrawals:
//
// GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD   -> list entries in that range
//      (both optional; omitting both returns everything, capped at 1000)
// GET  ?types=1                          -> (expenses only) distinct
//      `type` values seen so far, for the entry form's autocomplete
// POST { ... } -> create an entry (expenses: expense_date, type,
//      details, amount; withdrawals: withdrawal_date, description,
//      amount, source)
// PATCH ?id=X { ... } -> edit an entry
// DELETE ?id=X -> remove an entry
//
// A third resource, ?resource=cashflow, lives here too (same admin-only
// gate, same 12-function cap reasoning). See the comment above its
// routes further down for the daily-cash-reconciliation design.

const { requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const TYPE_MAX_LEN = 60;
const DETAILS_MAX_LEN = 300;
const DESCRIPTION_MAX_LEN = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WITHDRAWAL_SOURCES = ['cash', 'check', 'gcash'];
const EXPENSE_SOURCES = ['cash', 'check', 'gcash'];
const TZ = 'Asia/Manila';

function todayManila() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function dateRangeFilter(from, to) {
  let filter = '';
  if (from && DATE_RE.test(from)) filter += `&expense_date=gte.${encodeURIComponent(from)}`;
  if (to && DATE_RE.test(to)) filter += `&expense_date=lte.${encodeURIComponent(to)}`;
  return filter;
}

async function listExpenses(req, res) {
  const { from, to } = req.query || {};
  try {
    const path = `expenses?select=*&order=expense_date.desc,created_at.desc&limit=1000${dateRangeFilter(from, to)}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase expenses list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load expenses.' });
      return;
    }
    const expenses = await resp.json();
    const total = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
    res.status(200).json({ ok: true, expenses, total: total.toFixed(2) });
  } catch (err) {
    console.error('Unexpected error listing expenses:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function listTypes(req, res) {
  try {
    // Only need distinct type values for the autocomplete list -- pull a
    // generous recent slice and de-dupe here rather than relying on
    // PostgREST's more limited distinct support.
    const resp = await supabaseRequest('expenses?select=type&order=created_at.desc&limit=1000', { method: 'GET' });
    if (!resp.ok) {
      res.status(200).json({ ok: true, types: [] }); // non-fatal -- form just has no suggestions
      return;
    }
    const rows = await resp.json();
    const seen = new Set();
    const types = [];
    for (const row of rows) {
      const t = (row.type || '').trim();
      if (t && !seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        types.push(t);
      }
    }
    res.status(200).json({ ok: true, types });
  } catch (err) {
    console.error('Unexpected error listing expense types:', err);
    res.status(200).json({ ok: true, types: [] });
  }
}

async function createExpense(req, res, session) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing expense data' });
    return;
  }

  const expenseDate = sanitizeText(body.expense_date, 20);
  const type = sanitizeText(body.type, TYPE_MAX_LEN);
  const details = sanitizeText(body.details, DETAILS_MAX_LEN);
  const amountNum = parseFloat(body.amount);
  const source = EXPENSE_SOURCES.includes(body.source) ? body.source : 'cash';

  if (!expenseDate || !DATE_RE.test(expenseDate)) {
    res.status(400).json({ ok: false, error: 'A valid expense date is required.' });
    return;
  }
  if (!type) {
    res.status(400).json({ ok: false, error: 'Type is required.' });
    return;
  }
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    res.status(400).json({ ok: false, error: 'A valid amount greater than 0 is required.' });
    return;
  }

  try {
    const resp = await supabaseRequest('expenses', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        expense_date: expenseDate,
        type,
        details,
        amount: amountNum.toFixed(2),
        source,
        created_by: session.username,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase expenses insert error:', resp.status, errText);
      res.status(502).json({ ok: false, error: sourceCheckConstraintMessage(errText) || 'Could not save the expense.' });
      return;
    }
    const [saved] = await resp.json();
    res.status(200).json({ ok: true, expense: saved });
  } catch (err) {
    console.error('Unexpected error creating expense:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function updateExpense(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'An expense id is required.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing expense data' });
    return;
  }

  const expenseDate = sanitizeText(body.expense_date, 20);
  const type = sanitizeText(body.type, TYPE_MAX_LEN);
  const details = sanitizeText(body.details, DETAILS_MAX_LEN);
  const amountNum = parseFloat(body.amount);
  const source = EXPENSE_SOURCES.includes(body.source) ? body.source : 'cash';

  if (!expenseDate || !DATE_RE.test(expenseDate)) {
    res.status(400).json({ ok: false, error: 'A valid expense date is required.' });
    return;
  }
  if (!type) {
    res.status(400).json({ ok: false, error: 'Type is required.' });
    return;
  }
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    res.status(400).json({ ok: false, error: 'A valid amount greater than 0 is required.' });
    return;
  }

  try {
    const resp = await supabaseRequest(`expenses?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        expense_date: expenseDate,
        type,
        details,
        amount: amountNum.toFixed(2),
        source,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase expenses update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: sourceCheckConstraintMessage(errText) || 'Could not save changes to this expense.' });
      return;
    }
    const [saved] = await resp.json();
    if (!saved) {
      res.status(404).json({ ok: false, error: 'Expense not found.' });
      return;
    }
    res.status(200).json({ ok: true, expense: saved });
  } catch (err) {
    console.error('Unexpected error updating expense:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function deleteExpense(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'An expense id is required.' });
    return;
  }
  try {
    const resp = await supabaseRequest(`expenses?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase expenses delete error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not delete the expense.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error deleting expense:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// ---------------------------------------------------------------------
// Withdrawals (cash/check/gcash payroll runs, owner draws, etc.) --
// always admin-only, no staff-access flag. Source is fixed to one of
// 'cash', 'check', or 'gcash' so the list can reliably show the amount
// under a Cash, Checking, or Gcash column rather than trying to split
// free text.
// ---------------------------------------------------------------------

function withdrawalDateRangeFilter(from, to) {
  let filter = '';
  if (from && DATE_RE.test(from)) filter += `&withdrawal_date=gte.${encodeURIComponent(from)}`;
  if (to && DATE_RE.test(to)) filter += `&withdrawal_date=lte.${encodeURIComponent(to)}`;
  return filter;
}

async function listWithdrawals(req, res) {
  const { from, to } = req.query || {};
  try {
    const path = `withdrawals?select=*&order=withdrawal_date.desc,created_at.desc&limit=1000${withdrawalDateRangeFilter(from, to)}`;
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase withdrawals list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load withdrawals.' });
      return;
    }
    const withdrawals = await resp.json();
    const total = withdrawals.reduce((sum, w) => sum + (parseFloat(w.amount) || 0), 0);
    const totalCash = withdrawals.reduce((sum, w) => sum + (w.source === 'cash' ? (parseFloat(w.amount) || 0) : 0), 0);
    const totalCheck = withdrawals.reduce((sum, w) => sum + (w.source === 'check' ? (parseFloat(w.amount) || 0) : 0), 0);
    const totalGcash = withdrawals.reduce((sum, w) => sum + (w.source === 'gcash' ? (parseFloat(w.amount) || 0) : 0), 0);
    res.status(200).json({
      ok: true,
      withdrawals,
      total: total.toFixed(2),
      total_cash: totalCash.toFixed(2),
      total_check: totalCheck.toFixed(2),
      total_gcash: totalGcash.toFixed(2),
    });
  } catch (err) {
    console.error('Unexpected error listing withdrawals:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

function validateWithdrawalBody(body) {
  const withdrawalDate = sanitizeText(body.withdrawal_date, 20);
  const description = sanitizeText(body.description, DESCRIPTION_MAX_LEN);
  const source = sanitizeText(body.source, 10);
  const amountNum = parseFloat(body.amount);

  if (!withdrawalDate || !DATE_RE.test(withdrawalDate)) {
    return { error: 'A valid withdrawal date is required.' };
  }
  if (!description) {
    return { error: 'Description is required.' };
  }
  if (!source || !WITHDRAWAL_SOURCES.includes(source.toLowerCase())) {
    return { error: 'Source must be Cash, Check, or Gcash.' };
  }
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { error: 'A valid amount greater than 0 is required.' };
  }
  return { withdrawalDate, description, source: source.toLowerCase(), amountNum };
}

async function createWithdrawal(req, res, session) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing withdrawal data' });
    return;
  }

  const validated = validateWithdrawalBody(body);
  if (validated.error) {
    res.status(400).json({ ok: false, error: validated.error });
    return;
  }

  try {
    const resp = await supabaseRequest('withdrawals', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        withdrawal_date: validated.withdrawalDate,
        description: validated.description,
        amount: validated.amountNum.toFixed(2),
        source: validated.source,
        created_by: session.username,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase withdrawals insert error:', resp.status, errText);
      res.status(502).json({ ok: false, error: sourceCheckConstraintMessage(errText) || 'Could not save the withdrawal.' });
      return;
    }
    const [saved] = await resp.json();
    res.status(200).json({ ok: true, withdrawal: saved });
  } catch (err) {
    console.error('Unexpected error creating withdrawal:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Gcash support (expenses.source / withdrawals.source) was added via
// migrations in supabase-schema.sql that may not have been run against
// the live Supabase project yet. If so, saving a Gcash expense or
// withdrawal fails at the database level in one of two ways, and
// otherwise surfaces to the user as a generic, unhelpful save failure:
//   - withdrawals.source already existed with a stricter CHECK
//     constraint (cash/check only) before Gcash was added -- a 'gcash'
//     value now violates it (Postgres code 23514).
//   - expenses.source is a brand-new column -- if that migration never
//     ran, the column doesn't exist at all (Postgres code 42703,
//     "column does not exist").
// Detect both cases and say so plainly, naming the fix, instead of a
// generic "could not save" message.
function sourceCheckConstraintMessage(errText) {
  if (typeof errText !== 'string') return null;
  if (errText.includes('23514') && errText.includes('source_check')) {
    return 'Gcash isn\'t enabled on the database yet -- a CHECK constraint needs to be updated in Supabase to allow it (see supabase-schema.sql). Cash and Check still work normally.';
  }
  if (errText.includes('42703') && errText.includes('source')) {
    return 'Gcash isn\'t enabled on the database yet -- a database migration from supabase-schema.sql needs to be run in Supabase first. Cash and Check still work normally.';
  }
  return null;
}

async function updateWithdrawal(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A withdrawal id is required.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing withdrawal data' });
    return;
  }

  const validated = validateWithdrawalBody(body);
  if (validated.error) {
    res.status(400).json({ ok: false, error: validated.error });
    return;
  }

  try {
    const resp = await supabaseRequest(`withdrawals?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        withdrawal_date: validated.withdrawalDate,
        description: validated.description,
        amount: validated.amountNum.toFixed(2),
        source: validated.source,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase withdrawals update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: sourceCheckConstraintMessage(errText) || 'Could not save changes to this withdrawal.' });
      return;
    }
    const [saved] = await resp.json();
    if (!saved) {
      res.status(404).json({ ok: false, error: 'Withdrawal not found.' });
      return;
    }
    res.status(200).json({ ok: true, withdrawal: saved });
  } catch (err) {
    console.error('Unexpected error updating withdrawal:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function deleteWithdrawal(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A withdrawal id is required.' });
    return;
  }
  try {
    const resp = await supabaseRequest(`withdrawals?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase withdrawals delete error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not delete the withdrawal.' });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error deleting withdrawal:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// ---------------------------------------------------------------------
// Daily Cash Reconciliation (CashFlow) -- Phase 2 feature matching the
// client's manual "CashFlow" spreadsheet tab: a rolling daily ledger of
// cash/Gcash/checking balances, closed out once a day.
//
// Routes (all admin-only, same gate as expenses/withdrawals above):
//   GET  ?resource=cashflow&action=today
//     Returns today's row. If it doesn't exist yet, returns a draft
//     built from yesterday's ending balances (or all-zero if there is
//     no prior day at all -- the very first day, before it's been
//     seeded) plus today's activity computed live from orders/expenses/
//     withdrawals. Nothing is written to the database by this call --
//     it's a preview only.
//   GET  ?resource=cashflow&action=history
//     Lists closed days, most recent first.
//   POST ?resource=cashflow&action=seed
//     body { beginning_cash, beginning_gcash, beginning_checking,
//             beginning_outstanding }
//     One-time entry of opening balances. Only allowed when no
//     cash_positions rows exist yet -- once any day has been closed,
//     every later day's beginning balance comes from the prior day's
//     ending balance automatically, not from this route.
//   POST ?resource=cashflow&action=close
//     Locks today's row: computes and stores every activity/ending
//     field from today's actual data, sets closed_at. Refuses to
//     re-close an already-closed day (that field is a frozen snapshot,
//     see the schema comment in supabase-schema.sql), and refuses to
//     close today if yesterday exists but was never closed, so a
//     skipped day can't silently produce wrong beginning balances.
// ---------------------------------------------------------------------

function yesterdayManila() {
  // Compute "yesterday" the same way todayManila() computes "today":
  // take the Manila calendar date, not a UTC-minus-24h shift, so this
  // is correct even when the server's day and Manila's day differ.
  const now = new Date();
  const manilaNow = new Date(now.toLocaleString('en-US', { timeZone: TZ }));
  manilaNow.setDate(manilaNow.getDate() - 1);
  const y = manilaNow.getFullYear();
  const m = String(manilaNow.getMonth() + 1).padStart(2, '0');
  const d = String(manilaNow.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchCashPosition(dateStr) {
  const resp = await supabaseRequest(`cash_positions?select=*&position_date=eq.${encodeURIComponent(dateStr)}`, { method: 'GET' });
  if (!resp.ok) return { ok: false };
  const rows = await resp.json();
  return { ok: true, row: rows[0] || null };
}

// Live totals for a given day, drawn straight from orders/expenses/
// withdrawals -- the same three sources the Dashboard's money block and
// the Expenses/Withdrawals reports already use, just narrowed to one
// day and split out by tender where the client's sheet needs that.
async function computeDayActivity(dateStr) {
  const dayFilter = `&order_date=eq.${encodeURIComponent(dateStr)}`;
  const [ordersResp, expensesResp, withdrawalsResp] = await Promise.all([
    supabaseRequest(`orders?select=amount,balance,payment_method${dayFilter}&deleted_at=is.null`, { method: 'GET' }),
    supabaseRequest(`expenses?select=amount,source&expense_date=eq.${encodeURIComponent(dateStr)}`, { method: 'GET' }),
    supabaseRequest(`withdrawals?select=amount,source&withdrawal_date=eq.${encodeURIComponent(dateStr)}`, { method: 'GET' }),
  ]);

  const activity = {
    cash_sales: 0,
    gcash_sales: 0,
    total_expenses: 0,
    total_expenses_cash: 0,
    total_expenses_checking: 0,
    total_expenses_gcash: 0,
    total_withdrawals_cash: 0,
    total_withdrawals_checking: 0,
    total_withdrawals_gcash: 0,
    outstanding_created: 0,
  };

  if (ordersResp.ok) {
    const orders = await ordersResp.json();
    orders.forEach((o) => {
      const amount = num(o.amount);
      if (o.payment_method === 'gcash_cc') activity.gcash_sales += amount;
      else activity.cash_sales += amount; // cash is the default/fallback tender
      activity.outstanding_created += num(o.balance);
    });
  }
  if (expensesResp.ok) {
    const expenses = await expensesResp.json();
    expenses.forEach((e) => {
      const amount = num(e.amount);
      activity.total_expenses += amount;
      // Legacy rows (logged before the source column existed) default to
      // 'cash' in the database, so this still lands in the right bucket
      // without a backfill.
      if (e.source === 'check') activity.total_expenses_checking += amount;
      else if (e.source === 'gcash') activity.total_expenses_gcash += amount;
      else activity.total_expenses_cash += amount;
    });
  }
  if (withdrawalsResp.ok) {
    const withdrawals = await withdrawalsResp.json();
    withdrawals.forEach((w) => {
      const amount = num(w.amount);
      if (w.source === 'check') activity.total_withdrawals_checking += amount;
      else if (w.source === 'gcash') activity.total_withdrawals_gcash += amount;
      else activity.total_withdrawals_cash += amount;
    });
  }
  return activity;
}

async function cashflowToday(req, res) {
  try {
    const today = todayManila();
    const { ok, row } = await fetchCashPosition(today);
    if (!ok) {
      res.status(502).json({ ok: false, error: 'Could not load today’s cash position.' });
      return;
    }

    if (row && row.closed_at) {
      // Already closed -- return the frozen snapshot as-is, no recompute.
      res.status(200).json({ ok: true, position: row, closed: true });
      return;
    }

    // Draft: beginning balances come from an existing (not-yet-closed)
    // row if one was already seeded today, otherwise from yesterday's
    // ending balances, otherwise all zero (first day ever, unseeded).
    let beginning = { beginning_cash: 0, beginning_gcash: 0, beginning_checking: 0, beginning_outstanding: 0 };
    let seeded = false;
    if (row) {
      beginning = {
        beginning_cash: num(row.beginning_cash),
        beginning_gcash: num(row.beginning_gcash),
        beginning_checking: num(row.beginning_checking),
        beginning_outstanding: num(row.beginning_outstanding),
      };
      seeded = true;
    } else {
      const y = await fetchCashPosition(yesterdayManila());
      if (y.ok && y.row && y.row.closed_at) {
        beginning = {
          beginning_cash: num(y.row.ending_cash),
          beginning_gcash: num(y.row.ending_gcash),
          beginning_checking: num(y.row.ending_checking),
          beginning_outstanding: num(y.row.ending_outstanding),
        };
        seeded = true;
      }
    }

    const activity = await computeDayActivity(today);

    // outstanding_collected isn't tracked as its own event anywhere yet
    // (no "this payment was against an old balance" flag on orders), so
    // it's left at 0 for now and admin can see/adjust the ending
    // outstanding number is an estimate; noted in the UI.
    const outstandingCollected = 0;

    const position = {
      position_date: today,
      ...beginning,
      ...activity,
      outstanding_collected: outstandingCollected,
      ending_cash: beginning.beginning_cash + activity.cash_sales - activity.total_expenses_cash - activity.total_withdrawals_cash,
      ending_gcash: beginning.beginning_gcash + activity.gcash_sales - activity.total_expenses_gcash - activity.total_withdrawals_gcash,
      ending_checking: beginning.beginning_checking - activity.total_withdrawals_checking - activity.total_expenses_checking,
      ending_outstanding: beginning.beginning_outstanding + activity.outstanding_created - outstandingCollected,
      closed_at: null,
    };

    res.status(200).json({ ok: true, position, closed: false, seeded, isFirstDay: !seeded });
  } catch (err) {
    console.error('Unexpected error building cashflow today view:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function cashflowHistory(req, res) {
  try {
    const resp = await supabaseRequest('cash_positions?select=*&closed_at=not.is.null&order=position_date.desc&limit=90', { method: 'GET' });
    if (!resp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load cash position history.' });
      return;
    }
    const positions = await resp.json();
    res.status(200).json({ ok: true, positions });
  } catch (err) {
    console.error('Unexpected error listing cashflow history:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function cashflowSeed(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing opening balance data' });
    return;
  }

  try {
    // Seeding is only for the very first day this feature is used --
    // once any row exists, beginning balances flow from the prior day's
    // close instead, so re-seeding could quietly overwrite a real
    // history. Check first rather than relying on a unique-constraint
    // error, so the refusal message is clear.
    const existingResp = await supabaseRequest('cash_positions?select=id&limit=1', { method: 'GET' });
    if (existingResp.ok) {
      const existing = await existingResp.json();
      if (existing.length) {
        res.status(409).json({ ok: false, error: 'Opening balances have already been set. Beginning balances now carry forward automatically from the previous closed day.' });
        return;
      }
    }

    const beginningCash = num(body.beginning_cash);
    const beginningGcash = num(body.beginning_gcash);
    const beginningChecking = num(body.beginning_checking);
    const beginningOutstanding = num(body.beginning_outstanding);

    if ([beginningCash, beginningGcash, beginningChecking, beginningOutstanding].some((n) => n < 0)) {
      res.status(400).json({ ok: false, error: 'Opening balances cannot be negative.' });
      return;
    }

    const today = todayManila();
    const resp = await supabaseRequest('cash_positions', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        position_date: today,
        beginning_cash: beginningCash.toFixed(2),
        beginning_gcash: beginningGcash.toFixed(2),
        beginning_checking: beginningChecking.toFixed(2),
        beginning_outstanding: beginningOutstanding.toFixed(2),
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase cash_positions seed insert error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save opening balances.' });
      return;
    }
    const [saved] = await resp.json();
    res.status(200).json({ ok: true, position: saved });
  } catch (err) {
    console.error('Unexpected error seeding cashflow:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function cashflowClose(req, res, session) {
  try {
    const today = todayManila();

    const { ok, row } = await fetchCashPosition(today);
    if (!ok) {
      res.status(502).json({ ok: false, error: 'Could not load today’s cash position.' });
      return;
    }
    if (row && row.closed_at) {
      res.status(409).json({ ok: false, error: 'Today has already been closed.' });
      return;
    }

    // Refuse to close today if yesterday exists as an open (unclosed)
    // draft -- closing out of order would compute today's beginning
    // balances from nothing rather than from yesterday's real numbers.
    // (If yesterday's row simply doesn't exist at all -- e.g. this is
    // day one, or a day was skipped before the feature was seeded --
    // that's fine; there's nothing to close first.)
    const yesterday = await fetchCashPosition(yesterdayManila());
    if (yesterday.ok && yesterday.row && !yesterday.row.closed_at) {
      res.status(409).json({ ok: false, error: 'Yesterday hasn’t been closed yet. Close it first so today starts from the right beginning balances.' });
      return;
    }

    // Beginning balances: from today's own row if it was seeded (day
    // one), otherwise from yesterday's close, otherwise zero (closing
    // with nothing seeded at all -- an edge case, but better than
    // failing outright).
    let beginning = { beginning_cash: 0, beginning_gcash: 0, beginning_checking: 0, beginning_outstanding: 0 };
    if (row) {
      beginning = {
        beginning_cash: num(row.beginning_cash),
        beginning_gcash: num(row.beginning_gcash),
        beginning_checking: num(row.beginning_checking),
        beginning_outstanding: num(row.beginning_outstanding),
      };
    } else if (yesterday.ok && yesterday.row && yesterday.row.closed_at) {
      beginning = {
        beginning_cash: num(yesterday.row.ending_cash),
        beginning_gcash: num(yesterday.row.ending_gcash),
        beginning_checking: num(yesterday.row.ending_checking),
        beginning_outstanding: num(yesterday.row.ending_outstanding),
      };
    }

    const activity = await computeDayActivity(today);
    const outstandingCollected = 0;

    const closedFields = {
      ...beginning,
      cash_sales: activity.cash_sales.toFixed(2),
      gcash_sales: activity.gcash_sales.toFixed(2),
      total_expenses: activity.total_expenses.toFixed(2),
      total_withdrawals_cash: activity.total_withdrawals_cash.toFixed(2),
      total_withdrawals_checking: activity.total_withdrawals_checking.toFixed(2),
      total_withdrawals_gcash: activity.total_withdrawals_gcash.toFixed(2),
      outstanding_created: activity.outstanding_created.toFixed(2),
      outstanding_collected: outstandingCollected.toFixed(2),
      ending_cash: (beginning.beginning_cash + activity.cash_sales - activity.total_expenses_cash - activity.total_withdrawals_cash).toFixed(2),
      ending_gcash: (beginning.beginning_gcash + activity.gcash_sales - activity.total_expenses_gcash - activity.total_withdrawals_gcash).toFixed(2),
      ending_checking: (beginning.beginning_checking - activity.total_withdrawals_checking - activity.total_expenses_checking).toFixed(2),
      ending_outstanding: (beginning.beginning_outstanding + activity.outstanding_created - outstandingCollected).toFixed(2),
      closed_at: new Date().toISOString(),
      closed_by: session.username,
    };

    let resp;
    if (row) {
      resp = await supabaseRequest(`cash_positions?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(closedFields),
      });
    } else {
      resp = await supabaseRequest('cash_positions', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ position_date: today, ...closedFields }),
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase cash_positions close error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not close today’s cash position.' });
      return;
    }
    const [saved] = await resp.json();
    res.status(200).json({ ok: true, position: saved });
  } catch (err) {
    console.error('Unexpected error closing cashflow day:', err);
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

  // Both resources, every method: admin only. No staff exception.
  const session = requireAdmin(req, res);
  if (!session) return;

  const resourceParam = req.query && req.query.resource;
  const resource = resourceParam === 'withdrawals' ? 'withdrawals' : resourceParam === 'cashflow' ? 'cashflow' : 'expenses';

  if (resource === 'withdrawals') {
    if (req.method === 'GET') return listWithdrawals(req, res);
    if (req.method === 'POST') return createWithdrawal(req, res, session);
    if (req.method === 'PATCH') return updateWithdrawal(req, res);
    if (req.method === 'DELETE') return deleteWithdrawal(req, res);

    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (resource === 'cashflow') {
    const action = req.query && req.query.action;

    if (req.method === 'GET') {
      if (action === 'today') return cashflowToday(req, res);
      if (action === 'history') return cashflowHistory(req, res);
      res.status(400).json({ ok: false, error: 'Unknown or missing action for GET cashflow (expected "today" or "history").' });
      return;
    }

    if (req.method === 'POST') {
      if (action === 'seed') return cashflowSeed(req, res);
      if (action === 'close') return cashflowClose(req, res, session);
      res.status(400).json({ ok: false, error: 'Unknown or missing action for POST cashflow (expected "seed" or "close").' });
      return;
    }

    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (req.method === 'GET') {
    if (req.query && req.query.types === '1') return listTypes(req, res);
    return listExpenses(req, res);
  }

  if (req.method === 'POST') return createExpense(req, res, session);
  if (req.method === 'PATCH') return updateExpense(req, res);
  if (req.method === 'DELETE') return deleteExpense(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
