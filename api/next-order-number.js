// Vercel Serverless Function: /api/next-order-number
// Staff-only. Order number format is YEAR-TYPE-NNNN (e.g. "2025-RX-0001"
// or "2025-NRX-0001"). Rx and Non-Rx orders each have their OWN counter,
// and each counter resets to 0001 at the start of each new year.
//
// Call with ?order_type=rx or ?order_type=non_rx to get the right
// suggestion for that type (e.g. last Rx order was "2025-RX-0944" ->
// suggests "2025-RX-0945"; a fresh year or a type with no orders yet
// suggests "<year>-RX-0001" / "<year>-NRX-0001").
//
// Purely a suggestion -- the order form field stays editable, and
// nothing here reserves or locks the number.

const { requireAuth } = require('./_auth');
const { supabaseRequest } = require('./_supabase');

const TYPE_TOKENS = { rx: 'RX', non_rx: 'NRX' };

function buildOrderNoRegex(token) {
  // e.g. ^(\d{4})-RX-(\d{4,})$
  return new RegExp(`^(\\d{4})-${token}-(\\d{4,})$`);
}

function suggestNext(existingOrderNos, currentYear, token) {
  const re = buildOrderNoRegex(token);
  let maxCounter = 0;
  let widestPadding = 4;

  for (const orderNo of existingOrderNos) {
    const trimmed = (orderNo || '').trim();
    const match = trimmed.match(re);
    if (!match) continue; // skip anything not matching this type's YEAR-TOKEN-NNNN form

    const [, year, counterStr] = match;
    if (year !== String(currentYear)) continue; // only this year's orders count toward the counter

    const counterValue = parseInt(counterStr, 10);
    if (counterValue > maxCounter) {
      maxCounter = counterValue;
      widestPadding = counterStr.length;
    }
  }

  const next = maxCounter + 1;
  return `${currentYear}-${token}-${String(next).padStart(widestPadding, '0')}`;
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
  const token = TYPE_TOKENS[order_type];

  if (!token) {
    res.status(400).json({ ok: false, error: 'order_type must be "rx" or "non_rx".' });
    return;
  }

  const currentYear = new Date().getFullYear();

  try {
    // Filter server-side to this year + this type's prefix, so the
    // counter is correct even with many historical orders across years
    // and types -- we only ever need this year+type's rows.
    const prefix = encodeURIComponent(`${currentYear}-${token}-%`);
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

    const rows = await resp.json();
    const suggestion = suggestNext(rows.map(r => r.order_no), currentYear, token);
    res.status(200).json({ ok: true, suggestion });
  } catch (err) {
    console.error('Unexpected error suggesting next order number:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
};
