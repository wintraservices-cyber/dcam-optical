// Vercel Serverless Function: /api/intake-payment
//
// Started as a single-purpose endpoint (PATCH payment_status on an
// intake_submissions row) and has grown into intake's general
// management endpoint plus the staff/admin Dashboard summary -- folded
// in here rather than as new files, since Vercel's Hobby plan caps this
// project at 12 serverless functions and it's already at the cap. Same
// ?resource= / ?action= query-param routing pattern already used on
// api/expenses.js for withdrawals.
//
// Routes:
//   PATCH /api/intake-payment                          (default, unchanged)
//     body { id, payment_status } -- update an intake's payment_status.
//     Used by staff-patient-lookup.html's per-intake payment dropdown.
//
//   PATCH /api/intake-payment   body { id, contact_status } -- contact touch point
//     (not_contacted | contacted | left_message | no_response | booked | declined).
//
//   GET   /api/intake-payment?resource=intakes&status=new
//     List intake_submissions, optionally filtered by status ('new' or
//     'contacted'). Used by the Dashboard's intake queue.
//
//   PATCH /api/intake-payment?resource=intakes&action=contacted
//     body { id } -- mark an intake 'contacted'. This is a manual,
//     independent action: staff might contact a patient who then
//     reschedules, doesn't qualify, or books an order -- none of that is
//     inferred, staff say so directly.
//
//   GET   /api/intake-payment?resource=dashboard
//     One aggregated summary for the Dashboard: new-intake count,
//     today's orders grouped by status, and (admin only) today's sales
//     totals. See dashboardSummary() below for the exact shape.

const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

const TZ = 'Asia/Manila';

function todayManila() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function isValidPaymentStatus(status) {
  return ['unpaid', 'paid'].includes(status);
}

const CONTACT_STATUSES = ['not_contacted', 'contacted', 'left_message', 'no_response', 'booked', 'declined'];
function isValidContactStatus(v) {
  return CONTACT_STATUSES.includes(v);
}

function isValidIntakeStatus(status) {
  return ['new', 'contacted'].includes(status);
}

async function updateIntakePaymentStatus(req, res, body) {
  const { id, payment_status } = body || {};

  if (!id || !isValidPaymentStatus(payment_status)) {
    res.status(400).json({ ok: false, error: 'A valid intake id and payment_status are required.' });
    return;
  }

  try {
    const resp = await supabaseRequest(`intake_submissions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ payment_status }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase intake payment update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not update payment status.' });
      return;
    }

    const [updated] = await resp.json();
    res.status(200).json({ ok: true, intake: updated });
  } catch (err) {
    console.error('Unexpected error updating intake payment status:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// Staff-set contact touch point on an intake request (Look up customer).
// Contacted / Booked / Declined mean the follow-up is done, so the intake
// leaves the Dashboard's "new" queue; Left message and No response keep it
// there so the follow-up isn't forgotten.
async function updateIntakeContactStatus(req, res, body) {
  const { id, contact_status } = body || {};
  if (!id || !isValidContactStatus(contact_status)) {
    res.status(400).json({ ok: false, error: 'A valid intake id and contact_status are required.' });
    return;
  }
  const done = ['contacted', 'booked', 'declined'].includes(contact_status);
  try {
    const resp = await supabaseRequest(`intake_submissions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ contact_status, status: done ? 'contacted' : 'new' }),
    });
    if (!resp.ok) {
      console.error('Supabase intake contact_status update error:', resp.status, await resp.text());
      res.status(502).json({ ok: false, error: 'Could not update the contact status. (Has the contact_status column been added to the database?)' });
      return;
    }
    const [updated] = await resp.json();
    res.status(200).json({ ok: true, intake: updated });
  } catch (err) {
    console.error('Unexpected error updating intake contact status:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function markIntakeContacted(req, res, body) {
  const { id } = body || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'An intake id is required.' });
    return;
  }

  try {
    let resp = await supabaseRequest(`intake_submissions?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'contacted', contact_status: 'contacted' }),
    });
    if (!resp.ok) {
      // contact_status column not added yet -- fall back to the status-only update.
      resp = await supabaseRequest(`intake_submissions?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'contacted' }),
      });
    }

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase intake status update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not update this intake.' });
      return;
    }

    const [updated] = await resp.json();
    if (!updated) {
      res.status(404).json({ ok: false, error: 'Intake not found.' });
      return;
    }
    res.status(200).json({ ok: true, intake: updated });
  } catch (err) {
    console.error('Unexpected error marking intake contacted:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function listIntakes(req, res) {
  const { status } = req.query || {};
  let path = 'intake_submissions?select=*&order=created_at.desc&limit=200';
  if (status && isValidIntakeStatus(status)) {
    path += `&status=eq.${encodeURIComponent(status)}`;
  }

  try {
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase intake list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load intakes.' });
      return;
    }
    const intakes = await resp.json();
    res.status(200).json({ ok: true, intakes });
  } catch (err) {
    console.error('Unexpected error listing intakes:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

// One aggregated summary for the Dashboard landing page. Every staff
// member gets the intake queue and today's orders; the money section is
// only included for admins (session.role === 'admin'), so a staff
// session gets a smaller payload rather than data it can't see, mirroring
// the RBAC already enforced on /api/reports.
async function dashboardSummary(req, res, session) {
  try {
    const today = todayManila();
    const todayFilter = `&order_date=eq.${encodeURIComponent(today)}`;

    // "Due" orders: still status=ordered (nothing's arrived/been fitted
    // yet) but due_date has reached today -- these are the ones staff
    // need to chase a vendor or call the patient about, since the order
    // itself says it should already be here or ready. due.lte.today
    // also catches anything overdue, not just due exactly today.
    const dueFilter = `&status=eq.ordered&due_date=lte.${encodeURIComponent(today)}&due_date=not.is.null`;
    // "Unclaimed Rx (Ready)": status=ready, any date -- glasses are done
    // and waiting at the counter for the patient to pick up.
    const unclaimedFilter = `&status=eq.ready`;

    const intakeQuery = (cols) => supabaseRequest(`intake_submissions?select=${cols}&status=eq.new&order=created_at.desc&limit=50`, { method: 'GET' });
    const tbaFilter = `&status=eq.ordered&due_date=ilike.TBA`;
    const [newIntakesResp, todaysOrdersResp, dueOrdersResp, unclaimedOrdersResp, tbaOrdersResp] = await Promise.all([
      // contact_status is newer; fall back without it until the column exists.
      intakeQuery('id,fname,lname,phone,reason,pref_date,pref_time,created_at,contact_status').then((r) => (r.ok ? r : intakeQuery('id,fname,lname,phone,reason,pref_date,pref_time,created_at'))),
      supabaseRequest(`orders?select=id,order_no,patient_name,status,balance,amount,payment_status${todayFilter}&deleted_at=is.null&order=created_at.desc&limit=200`, { method: 'GET' }),
      supabaseRequest(`orders?select=id,order_no,patient_name,tel_no,due_date${dueFilter}&deleted_at=is.null&order=due_date.asc&limit=200`, { method: 'GET' }),
      supabaseRequest(`orders?select=id,order_no,patient_name,tel_no,due_date${unclaimedFilter}&deleted_at=is.null&order=due_date.asc&limit=200`, { method: 'GET' }),
      supabaseRequest(`orders?select=id,order_no,patient_name,tel_no,due_date${tbaFilter}&deleted_at=is.null&order=created_at.asc&limit=200`, { method: 'GET' }),
    ]);

    if (!newIntakesResp.ok || !todaysOrdersResp.ok || !dueOrdersResp.ok || !unclaimedOrdersResp.ok || !tbaOrdersResp.ok) {
      res.status(502).json({ ok: false, error: 'Could not load the dashboard.' });
      return;
    }

    const newIntakes = await newIntakesResp.json();
    const todaysOrders = await todaysOrdersResp.json();
    const dueOrders = await dueOrdersResp.json();
    const unclaimedOrders = await unclaimedOrdersResp.json();
    const tbaOrders = await tbaOrdersResp.json();

    const ordersByStatus = { ordered: 0, ready: 0, claimed: 0 };
    todaysOrders.forEach((o) => {
      if (ordersByStatus[o.status] !== undefined) ordersByStatus[o.status] += 1;
    });

    const summary = {
      today,
      newIntakeCount: newIntakes.length,
      newIntakes: newIntakes.slice(0, 8),
      todaysOrders: {
        total: todaysOrders.length,
        byStatus: ordersByStatus,
      },
      dueOrderCount: dueOrders.length,
      dueOrders: dueOrders.slice(0, 8),
      tbaOrderCount: tbaOrders.length,
      tbaOrders: tbaOrders.slice(0, 8),
      unclaimedCount: unclaimedOrders.length,
      unclaimedOrders: unclaimedOrders.slice(0, 8),
    };

    if (session.role === 'admin') {
      const [salesResp, expensesResp] = await Promise.all([
        supabaseRequest(`orders?select=amount,deposit,balance,payment_status,created_at${todayFilter}&deleted_at=is.null`, { method: 'GET' }),
        supabaseRequest(`expenses?select=amount&expense_date=eq.${encodeURIComponent(today)}`, { method: 'GET' }),
      ]);
      if (salesResp.ok) {
        const salesOrders = await salesResp.json();
        const totalAmount = salesOrders.reduce((sum, o) => sum + num(o.amount), 0);
        const totalDeposit = salesOrders.reduce((sum, o) => sum + num(o.deposit), 0);
        const totalOutstanding = salesOrders.reduce((sum, o) => sum + num(o.balance), 0);
        let totalExpenses = 0;
        if (expensesResp.ok) {
          const todaysExpenses = await expensesResp.json();
          totalExpenses = todaysExpenses.reduce((sum, e) => sum + num(e.amount), 0);
        }
        summary.money = {
          todaysOrderCount: salesOrders.length,
          totalAmount,
          totalCollectedToday: totalDeposit,
          totalOutstanding,
          totalExpensesToday: totalExpenses,
          // Net today = today's total sales value minus today's expenses
          // -- a same-day profitability read, distinct from cash actually
          // in hand (which would net expenses against deposits instead).
          netToday: totalAmount - totalExpenses,
        };
      }
    }

    res.status(200).json({ ok: true, summary });
  } catch (err) {
    console.error('Unexpected error building dashboard summary:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const session = requireAuth(req, res);
  if (!session) return;

  const { resource, action } = req.query || {};

  if (req.method === 'GET') {
    if (resource === 'dashboard') return dashboardSummary(req, res, session);
    if (resource === 'intakes') return listIntakes(req, res);
    res.status(400).json({ ok: false, error: 'GET requires ?resource=dashboard or ?resource=intakes' });
    return;
  }

  if (req.method === 'PATCH') {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {
        res.status(400).json({ ok: false, error: 'Invalid JSON body' });
        return;
      }
    }

    if (resource === 'intakes' && action === 'contacted') {
      return markIntakeContacted(req, res, body);
    }
    if (body && body.contact_status !== undefined) return updateIntakeContactStatus(req, res, body);
    // Default, unchanged behavior: update payment_status.
    return updateIntakePaymentStatus(req, res, body);
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
