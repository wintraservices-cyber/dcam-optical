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

const { requireAdmin } = require('../lib/auth');
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

  // Both resources, every method: admin only. No staff exception.
  const session = requireAdmin(req, res);
  if (!session) return;

  const resource = (req.query && req.query.resource) === 'withdrawals' ? 'withdrawals' : 'expenses';

  if (resource === 'withdrawals') {
    if (req.method === 'GET') return listWithdrawals(req, res);
    if (req.method === 'POST') return createWithdrawal(req, res, session);
    if (req.method === 'PATCH') return updateWithdrawal(req, res);
    if (req.method === 'DELETE') return deleteWithdrawal(req, res);

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
