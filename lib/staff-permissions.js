// Staff permissions: what a non-admin staff account may do with orders.
// Stored in app_settings under "staff_permissions" and toggled by admins in
// Settings > Staff accounts. Admins are never restricted. A missing or
// partial setting normalizes to the defaults below (the locked-down rules
// agreed 2026-10-05), so nothing is open by accident.
//
// Printing is not a permission: it runs in the browser and cannot be locked
// from the server.

const { supabaseRequest } = require('./supabase');

// key -> { default, label, hint }. Order here is the order on the Settings card.
const PERMISSIONS = {
  edit_saved_orders: { default: false, label: 'Edit a saved order', hint: 'Off: a saved order opens read-only for staff; only an admin can change it.' },
  change_order_number: { default: false, label: 'Choose or change the job number', hint: 'Off: new orders get the next number automatically and it cannot be changed by staff.' },
  set_transaction_date: { default: false, label: 'Set the transaction date', hint: 'Off: staff-entered orders always use today\'s date (Manila time).' },
  delete_orders: { default: false, label: 'Delete orders', hint: 'Off: only an admin can move an order to Trash.' },
  set_payment_status: { default: false, label: 'Change payment status by hand', hint: 'Off: payment status only changes through Log payment and saving.' },
  log_payments: { default: true, label: 'Log a balance payment', hint: 'On: staff can record a payment against an order.' },
  set_job_status: { default: true, label: 'Move job status forward (Ordered, Ready, Claimed)', hint: 'On: staff can mark an order Ready or Claimed.' },
  reverse_job_status: { default: false, label: 'Move job status backwards', hint: 'Off: staff cannot, for example, change Claimed back to Ready.' },
};

const KEYS = Object.keys(PERMISSIONS);

function defaults() {
  const out = {};
  for (const k of KEYS) out[k] = PERMISSIONS[k].default;
  return out;
}

function normalizePermissions(value) {
  const src = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const k of KEYS) out[k] = typeof src[k] === 'boolean' ? src[k] : PERMISSIONS[k].default;
  return out;
}

async function getPermissions() {
  try {
    const resp = await supabaseRequest('app_settings?key=eq.staff_permissions&limit=1', { method: 'GET' });
    if (!resp.ok) return defaults();
    const rows = await resp.json();
    return normalizePermissions(rows[0] ? rows[0].value : null);
  } catch (e) {
    console.error('Could not read staff_permissions, using defaults:', e.message);
    return defaults();
  }
}

// Admins can always; staff only when the toggle is on.
function can(session, perms, key) {
  if (session && session.role === 'admin') return true;
  return !!(perms && perms[key]);
}

const STATUS_ORDER = ['ordered', 'ready', 'claimed'];
function isBackwards(from, to) {
  const a = STATUS_ORDER.indexOf(from);
  const b = STATUS_ORDER.indexOf(to);
  return a >= 0 && b >= 0 && b < a;
}

// Today's calendar date in Manila (UTC+8).
function manilaToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function deny(res, message) {
  res.status(403).json({ ok: false, error: message });
}

module.exports = { PERMISSIONS, KEYS, defaults, normalizePermissions, getPermissions, can, isBackwards, manilaToday, deny };
