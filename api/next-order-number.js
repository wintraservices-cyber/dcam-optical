// Vercel Serverless Function: /api/next-order-number
// Staff-only. Rx and Non-Rx orders use DIFFERENT formats and DIFFERENT
// reset periods:
//
//   Rx      : YYYY-NNNN        (e.g. "2025-0001")       -- resets YEARLY
//   Non-Rx  : YYYY-MM-NNNN     (e.g. "2025-01-0001")    -- resets MONTHLY
//
// Each type's counter is independent of the other. Call with
// ?order_type=rx or ?order_type=non_rx to get the right suggestion.
//
// Purely a suggestion -- the order form field stays editable, and
// nothing here reserves or locks the number.

const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');

const RX_RE = /^(\d{4})-(\d{4,})$/;
const NON_RX_RE = /^(\d{4})-(\d{2})-(\d{4,})$/;

function suggestNextRx(existingOrderNos, currentYear) {
  let maxCounter = 0;
  let widestPadding = 4;

  for (const orderNo of existingOrderNos) {
    const trimmed = (orderNo || '').trim();
    const match = trimmed.match(RX_RE);
    if (!match) continue; // skip anything not in plain YEAR-NNNN form (e.g. old Non-Rx or legacy entries)

    const [, year, counterStr] = match;
    if (year !== String(currentYear)) continue; // only this year's Rx orders count

    const counterValue = parseInt(counterStr, 10);
    if (counterValue > maxCounter) {
      maxCounter = counterValue;
      widestPadding = counterStr.length;
    }
  }

  const next = maxCounter + 1;
  return `${currentYear}-${String(next).padStart(widestPadding, '0')}`;
}

function suggestNextNonRx(existingOrderNos, currentYear, currentMonth) {
  let maxCounter = 0;
  let widestPadding = 4;
  const monthStr = String(currentMonth).padStart(2, '0');

  for (const orderNo of existingOrderNos) {
    const trimmed = (orderNo || '').trim();
    const match = trimmed.match(NON_RX_RE);
    if (!match) continue; // skip anything not in YEAR-MM-NNNN form

    const [, year, month, counterStr] = match;
    if (year !== String(currentYear) || month !== monthStr) continue; // only this year+month's Non-Rx orders count

    const counterValue = parseInt(counterStr, 10);
    if (counterValue > maxCounter) {
      maxCounter = counterValue;
      widestPadding = counterStr.length;
    }
  }

  const next = maxCounter + 1;
  return `${currentYear}-${monthStr}-${String(next).padStart(widestPadding, '0')}`;
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

  if (!requireAuth(req, res)) return;

  const { order_type } = req.query || {};
  if (order_type !== 'rx' && order_type !== 'non_rx') {
    res.status(400).json({ ok: false, error: 'order_type must be "rx" or "non_rx".' });
    return;
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1; // JS months are 0-indexed

  try {
    let prefix, rows;

    if (order_type === 'rx') {
      // Rx resets yearly -- filter to this year's plain YEAR-NNNN entries.
      prefix = encodeURIComponent(`${currentYear}-%`);
    } else {
      // Non-Rx resets monthly -- filter to this year+month's entries.
      const monthStr = String(currentMonth).padStart(2, '0');
      prefix = encodeURIComponent(`${currentYear}-${monthStr}-%`);
    }

    const resp = await supabaseRequest(
      `orders?select=order_no&order_no=ilike.${prefix}&order=order_no.desc&limit=500`,
      { method: 'GET' }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase next-order-number error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not determine next order number.' });
      return;
    }

    rows = await resp.json();
    const orderNos = rows.map(r => r.order_no);

    const suggestion = order_type === 'rx'
      ? suggestNextRx(orderNos, currentYear)
      : suggestNextNonRx(orderNos, currentYear, currentMonth);

    res.status(200).json({ ok: true, suggestion });
  } catch (err) {
    console.error('Unexpected error suggesting next order number:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
};
