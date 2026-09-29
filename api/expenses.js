// Business expenses (petty cash, payroll advances, supplies, etc.), and
// cash/check withdrawals (payroll runs, owner draws, etc.) -- both live
// in this one file/function rather than separate ones since Vercel's
// Hobby plan caps a project at 12 serverless functions and this project
// is already at that cap.
//
// Admin can always log/view/delete entries of either kind. Whether
// ordinary staff can also log EXPENSE entries is controlled by the
// app_settings 'expense_access' key ({staff_enabled: true|false}) --
// admin-only by default until that flag is turned on in Settings.
// Withdrawals are always admin-only, with no equivalent staff-access
// flag, since they represent larger, less frequent cash movements
// (payroll, draws) rather than day-to-day petty cash. Staff (non-admin)
// can never delete an expense entry, even when their access is enabled,
// since expenses double as a lightweight financial record.
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
// PATCH ?id=X { ... } -> edit an entry (admin only, same as delete --
//      both resources double as a lightweight financial record, so
//      correcting a past entry is kept to the same trust level as
//      removing one)
// DELETE ?id=X -> remove an entry (admin only)

const { requireAuth, requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const TYPE_MAX_LEN = 60;
const DETAILS_MAX_LEN = 300;
const DESCRIPTION_MAX_LEN = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WITHDRAWAL_SOURCES = ['cash', 'check'];

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

// Reads the current staff-access flag from app_settings. Defaults to
// disabled (admin-only) if the key has never been set, so a fresh
// deploy can't accidentally let anyone log expenses before an admin
// has deliberately turned it on.
async function staffAccessEnabled() {
  try {
    const resp = await supabaseRequest('app_settings?key=eq.expense_access&limit=1', { method: 'GET' });
    if (!resp.ok) return false;
    const [row] = await resp.json();
    return !!(row && row.value && row.value.staff_enabled === true);
  } catch (err) {
    console.error('Could not read expense_access setting, defaulting to admin-only:', err);
    return false;
  }
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
        created_by: session.username,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase expenses insert error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save the expense.' });
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
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase expenses update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save changes to this expense.' });
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
// Withdrawals (cash/check payroll runs, owner draws, etc.) -- always
// admin-only, no staff-access flag. Source is fixed to 'cash' or
// 'check' so the list can reliably show the amount under a Cash or
// Checking column rather than trying to split free text.
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
    res.status(200).json({
      ok: true,
      withdrawals,
      total: total.toFixed(2),
      total_cash: totalCash.toFixed(2),
      total_check: totalCheck.toFixed(2),
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
    return { error: 'Source must be Cash or Check.' };
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
      res.status(502).json({ ok: false, error: 'Could not save the withdrawal.' });
      return;
    }
    const [saved] = await resp.json();
    res.status(200).json({ ok: true, withdrawal: saved });
  } catch (err) {
    console.error('Unexpected error creating withdrawal:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
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
      res.status(502).json({ ok: false, error: 'Could not save changes to this withdrawal.' });
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

  const resource = (req.query && req.query.resource) === 'withdrawals' ? 'withdrawals' : 'expenses';

  // Withdrawals: always admin-only for every method, no staff-access flag.
  if (resource === 'withdrawals') {
    if (!requireAdmin(req, res)) return;

    if (req.method === 'GET') return listWithdrawals(req, res);
    if (req.method === 'POST') return createWithdrawal(req, res, session);
    if (req.method === 'PATCH') return updateWithdrawal(req, res);
    if (req.method === 'DELETE') return deleteWithdrawal(req, res);

    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  if (req.method === 'GET') {
    if (req.query && req.query.types === '1') return listTypes(req, res);
    if (req.query && req.query.access === '1') {
      // Lets the page ask "can I even show the entry form to this
      // person?" without duplicating the settings lookup client-side.
      const enabled = session.role === 'admin' || await staffAccessEnabled();
      res.status(200).json({ ok: true, can_log: enabled, is_admin: session.role === 'admin' });
      return;
    }
    return listExpenses(req, res);
  }

  if (req.method === 'POST') {
    if (session.role !== 'admin') {
      const enabled = await staffAccessEnabled();
      if (!enabled) {
        res.status(403).json({ ok: false, error: 'Logging expenses is currently admin-only.' });
        return;
      }
    }
    return createExpense(req, res, session);
  }

  if (req.method === 'PATCH') {
    // Editing is admin-only, same as delete -- see the note above.
    if (!requireAdmin(req, res)) return;
    return updateExpense(req, res);
  }

  if (req.method === 'DELETE') {
    // Deleting is always admin-only, regardless of the staff-logging flag.
    if (!requireAdmin(req, res)) return;
    return deleteExpense(req, res);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
