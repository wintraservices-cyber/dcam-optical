// Customer order-status lookup ("Are my glasses ready?").
//
// A customer proves the order is theirs with BOTH:
//   - the job order number printed on their claim stub
//     (Rx "2026-0012", Non-Rx "2026-09-0012"; spaces, "#" or missing
//     dashes are tolerated), and
//   - the last 4 digits of the phone number saved on that order.
// Orders are never looked up by name.
//
// Only the minimum is returned: Ordered / Ready / Claimed, the due date,
// and -- only if Settings allows it -- the remaining balance. No Rx,
// items, names or full phone numbers ever leave this file.
//
// Guessing is blocked with a persistent limiter (table
// order_lookup_attempts): 5 failed tries per visitor (hashed IP) per
// 15 minutes, and 8 failed tries against the same order number per hour.
//
// Switched on in Settings -> AI assistant -> Website assistant
// ("Order status lookup", off by default).

const crypto = require('crypto');
const { supabaseRequest } = require('./supabase');

const IP_WINDOW_MIN = 15;
const IP_MAX_FAILS = 5;
const ORDER_WINDOW_MIN = 60;
const ORDER_MAX_FAILS = 8;

const STATUS_LABEL = {
  ordered: 'Being prepared',
  ready: 'Ready for pick-up',
  claimed: 'Already claimed',
};

function hash(value) {
  const secret = process.env.STAFF_SESSION_SECRET || 'dcam-optical-demo-session-secret-v1';
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex').slice(0, 32);
}

function clientIp(req) {
  return String((req && req.headers && req.headers['x-forwarded-for']) || (req && req.socket && req.socket.remoteAddress) || 'unknown')
    .split(',')[0].trim();
}

// All the stored forms an order number the customer typed could take.
function orderNoCandidates(raw) {
  const s = String(raw || '').replace(/[#\s]/g, '').trim().toUpperCase();
  if (!s || s.length > 20 || !/^[0-9A-Z-]+$/.test(s)) return [];
  const out = new Set([s]);
  const d = s.replace(/\D/g, '');
  if (/^\d{8,9}$/.test(d)) out.add(`${d.slice(0, 4)}-${d.slice(4)}`);                        // 20260012 -> 2026-0012
  if (/^\d{10,11}$/.test(d)) out.add(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`);      // 2026090012 -> 2026-09-0012
  return [...out].slice(0, 4);
}

function cleanLast4(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

async function recentFailures(field, value, minutes) {
  const since = new Date(Date.now() - minutes * 60000).toISOString();
  try {
    const resp = await supabaseRequest(
      `order_lookup_attempts?select=id&success=eq.false&${field}=eq.${value}&created_at=gte.${encodeURIComponent(since)}`,
      { method: 'HEAD', headers: { Prefer: 'count=exact', Range: '0-0' } }
    );
    const total = parseInt(String(resp.headers.get('content-range') || '').split('/')[1], 10);
    return Number.isFinite(total) ? total : 0;
  } catch (e) {
    return 0;
  }
}

async function recordAttempt(ipHash, orderHash, success) {
  try {
    // Daily tally for the Settings dashboard (no personal data). Best effort:
    // before the schema update is run this simply does nothing.
    supabaseRequest('rpc/bump_order_check', { method: 'POST', body: JSON.stringify({ p_found: !!success }) }).catch(() => {});
    await supabaseRequest('order_lookup_attempts', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ip_hash: ipHash, order_hash: orderHash, success }),
    });
    // Occasionally clear attempts older than a day.
    if (Math.random() < 0.05) {
      const cutoff = new Date(Date.now() - 86400000).toISOString();
      await supabaseRequest(`order_lookup_attempts?created_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  } catch (e) {
    console.error('order-status: could not record attempt', e.message);
  }
}

function money(v) {
  const n = parseFloat(String(v || '').replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(n)) return null;
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Returns one of:
//   { result: 'found', status, status_label, due_date, balance? , payment_status? }
//   { result: 'not_found' }      -- wrong number or last 4 (never says which)
//   { result: 'need_details', missing: [...] }
//   { result: 'locked' }         -- too many wrong tries; try later or call
//   { result: 'error' }
async function lookupOrderStatus({ orderNo, phoneLast4, req, showBalance }) {
  const candidates = orderNoCandidates(orderNo);
  const last4 = cleanLast4(phoneLast4);
  const missing = [];
  if (!candidates.length) missing.push('order_number');
  if (!last4) missing.push('phone_last4');
  if (missing.length) return { result: 'need_details', missing };

  const ipHash = hash('ip:' + clientIp(req));
  const orderHash = hash('order:' + candidates[candidates.length - 1]);

  const [ipFails, orderFails] = await Promise.all([
    recentFailures('ip_hash', ipHash, IP_WINDOW_MIN),
    recentFailures('order_hash', orderHash, ORDER_WINDOW_MIN),
  ]);
  if (ipFails >= IP_MAX_FAILS || orderFails >= ORDER_MAX_FAILS) return { result: 'locked' };

  let rows;
  try {
    const list = candidates.map(c => `"${c}"`).join(',');
    const resp = await supabaseRequest(
      `orders?select=order_no,tel_no,status,due_date,balance,payment_status&order_no=in.(${encodeURIComponent(list)})&deleted_at=is.null&limit=5`,
      { method: 'GET' }
    );
    if (!resp.ok) return { result: 'error' };
    rows = await resp.json();
  } catch (e) {
    console.error('order-status: lookup failed', e.message);
    return { result: 'error' };
  }

  const match = rows.find(o => cleanLast4(o.tel_no) === last4);
  await recordAttempt(ipHash, orderHash, !!match);
  if (!match) return { result: 'not_found' };

  const out = {
    result: 'found',
    order_number: match.order_no,
    status: match.status,
    status_label: STATUS_LABEL[match.status] || match.status,
    due_date: match.status === 'claimed' ? undefined : (match.due_date || null),
  };
  if (showBalance && match.status !== 'claimed') {
    const bal = parseFloat(String(match.balance || '0').replace(/[^0-9.\-]/g, '')) || 0;
    out.balance = bal > 0 ? money(bal) : '₱0.00';
    out.fully_paid = bal <= 0;
  }
  return out;
}

// A plain-language reply (used by the chat form and Test mode).
function describeResult(r, business) {
  const hours = business && business.hours ? ` We're open ${business.hours}.` : '';
  const where = business && (business.branch || business.address) ? ` at ${business.branch || business.address}` : '';
  switch (r.result) {
    case 'found': {
      if (r.status === 'claimed') return `Order ${r.order_number} has already been claimed. If that doesn't sound right, please contact the clinic.`;
      let msg = r.status === 'ready'
        ? `Good news — order ${r.order_number} is ready for pick-up${where}!${hours} Please bring your claim stub.`
        : `Order ${r.order_number} is still being prepared.${r.due_date ? (String(r.due_date).toUpperCase() === 'TBA' ? ' The expected date is still to be confirmed.' : ` The expected date is ${r.due_date}.`) : ''} We'll let you know when it's ready.`;
      if (r.balance !== undefined) msg += r.fully_paid ? ' It is fully paid.' : ` Remaining balance: ${r.balance}.`;
      return msg;
    }
    case 'need_details':
      return 'To check your order, I need the job order number on your claim stub (e.g. 2026-0012) and the last 4 digits of the phone number you gave us.';
    case 'locked':
      return "There have been too many tries. Please wait about 15 minutes, or contact the clinic directly and we'll check for you.";
    case 'not_found':
      return "I couldn't find an order with that order number and phone number. Please check the number on your claim stub and the last 4 digits of the phone number you gave us.";
    default:
      return "Sorry — I couldn't check that right now. Please try again in a moment or contact the clinic.";
  }
}

// Tool definition for the website AI (only offered when switched on).
const ORDER_TOOL = {
  name: 'check_order_status',
  description: "Check whether a customer's glasses/order is still being prepared, ready for pick-up, or already claimed. Requires BOTH the job order number from their claim stub and the last 4 digits of the phone number on the order. Never guess either value.",
  input_schema: {
    type: 'object',
    properties: {
      order_number: { type: 'string', description: 'Job order number exactly as the customer gave it, e.g. 2026-0012 or 2026-09-0012.' },
      phone_last4: { type: 'string', description: 'Last 4 digits of the phone number on the order.' },
    },
    required: ['order_number', 'phone_last4'],
  },
};

// Pull an order number and last-4 from recent customer messages (Test mode).
// Newest message wins: a number typed now beats one from earlier in the chat.
const ORDER_RE = /\b(\d{4}-\d{2}-\d{3,}|\d{4}-\d{3,}|20\d{8}|20\d{6})\b/g;
function findInMessage(text) {
  // Dashed order numbers first; digits-only only with a year prefix (20xx),
  // so a pasted phone number (09xx...) isn't mistaken for an order number.
  const orders = String(text || '').match(ORDER_RE) || [];
  const orderNo = orders.length ? orders[orders.length - 1] : null;
  let rest = String(text || '');
  orders.forEach(o => { rest = rest.split(o).join(' '); });
  const fours = rest.match(/(?<![\d-])\d{4}(?![\d-])/g);
  let last4 = fours ? fours[fours.length - 1] : null;
  if (!last4) {
    const phone = rest.match(/(?:\+?63|0)9\d{2}[\s-]?\d{3}[\s-]?\d{4}/);
    if (phone) last4 = phone[0].replace(/\D/g, '').slice(-4);
  }
  return { orderNo, last4 };
}

function extractFromText(texts) {
  let orderNo = null;
  let last4 = null;
  for (let i = texts.length - 1; i >= 0 && (!orderNo || !last4); i--) {
    const found = findInMessage(texts[i]);
    if (!orderNo && found.orderNo) orderNo = found.orderNo;
    if (!last4 && found.last4) last4 = found.last4;
  }
  return { orderNo, last4 };
}

module.exports = { lookupOrderStatus, describeResult, ORDER_TOOL, extractFromText, orderNoCandidates };
