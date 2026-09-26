// Shared helper for writing to order_audit_log. Kept as a thin, best-effort
// wrapper -- an audit-log write failing should never block or roll back the
// underlying order/payment change, since losing one audit row is far less
// harmful than losing the order itself.

const { supabaseRequest } = require('./supabase');

const VALID_ACTIONS = ['created', 'status_change', 'payment_status_change', 'full_edit', 'balance_payment'];

async function logOrderAudit({ orderId, orderNo, action, changedBy, changes }) {
  if (!orderId || !orderNo || !VALID_ACTIONS.includes(action) || !changedBy) return;
  try {
    const resp = await supabaseRequest('order_audit_log', {
      method: 'POST',
      body: JSON.stringify({
        order_id: orderId,
        order_no: orderNo,
        action,
        changed_by: changedBy,
        changes: changes || null,
      }),
    });
    if (!resp.ok) {
      console.error('order_audit_log insert failed:', resp.status, await resp.text());
    }
  } catch (err) {
    console.error('Unexpected error writing order_audit_log:', err);
  }
}

// Builds a {field: {before, after}} diff, only for fields that actually
// changed. `before` is the row as it existed prior to the update; `patch`
// is the set of fields being written. Skips a field if before/after are
// both empty-ish (null/undefined/''), since that's not a real change.
function diffFields(before, patch) {
  const changes = {};
  for (const [key, after] of Object.entries(patch)) {
    if (key === 'updated_at') continue;
    const beforeVal = before ? before[key] : undefined;
    const beforeNorm = beforeVal === undefined || beforeVal === null ? '' : String(beforeVal);
    const afterNorm = after === undefined || after === null ? '' : String(after);
    if (beforeNorm === afterNorm) continue;
    changes[key] = { before: beforeVal ?? null, after: after ?? null };
  }
  return changes;
}

module.exports = { logOrderAudit, diffFields };
