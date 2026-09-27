// Business expenses (petty cash, payroll advances, supplies, etc.).
// Admin can always log/view/delete entries. Whether ordinary staff can
// also log entries is controlled by the app_settings 'expense_access'
// key ({staff_enabled: true|false}) -- admin-only by default until that
// flag is turned on in Settings. Staff (non-admin) can never delete an
// entry, even when their access is enabled, since expenses double as a
// lightweight financial record.
//
// GET  ?from=YYYY-MM-DD&to=YYYY-MM-DD   -> list entries in that range
//      (both optional; omitting both returns everything, capped at 1000)
// GET  ?types=1                          -> distinct `type` values seen
//      so far, for the entry form's autocomplete
// POST { expense_date, type, details, amount } -> create an entry
// DELETE ?id=X                           -> remove an entry (admin only)

const { requireAuth, requireAdmin } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const TYPE_MAX_LEN = 60;
const DETAILS_MAX_LEN = 300;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const session = requireAuth(req, res);
  if (!session) return;

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

  if (req.method === 'DELETE') {
    // Deleting is always admin-only, regardless of the staff-logging flag.
    if (!requireAdmin(req, res)) return;
    return deleteExpense(req, res);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
