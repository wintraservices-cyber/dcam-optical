const { requireAuth } = require('../lib/auth');
const { supabaseRequest } = require('../lib/supabase');

// Field allow-list + length caps, same defensive pattern as orders.js.
const FIELD_LIMITS = {
  category: 10,
  code: 40,
  name: 200,
  brand: 100,
  description: 300,
  price: 20,
  base_price: 20,
  notes: 300,
};

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function isValidCategory(category) {
  return ['lens', 'frame'].includes(category);
}

async function createItem(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {
      res.status(400).json({ ok: false, error: 'Invalid JSON body' });
      return;
    }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing catalog item data' });
    return;
  }

  const record = {};
  for (const [key, maxLen] of Object.entries(FIELD_LIMITS)) {
    record[key] = sanitize(body[key], maxLen);
  }

  if (!isValidCategory(record.category)) {
    res.status(400).json({ ok: false, error: 'Category must be "lens" or "frame".' });
    return;
  }
  if (!record.name) {
    res.status(400).json({ ok: false, error: 'Name is required.' });
    return;
  }

  record.active = body.active === false ? false : true;
  record.sort_order = Number.isFinite(body.sort_order) ? body.sort_order : 0;
  record.qty = Number.isFinite(body.qty) ? Math.max(0, Math.trunc(body.qty)) : 0;
  record.created_at = new Date().toISOString();
  record.updated_at = new Date().toISOString();

  try {
    const resp = await supabaseRequest('catalog_items', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(record),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase insert error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not save the catalog item.' });
      return;
    }

    const [saved] = await resp.json();
    res.status(200).json({ ok: true, item: saved });
  } catch (err) {
    console.error('Unexpected error creating catalog item:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function listItems(req, res) {
  const { category, active_only } = req.query || {};

  let path = 'catalog_items?select=*&order=category.asc,sort_order.asc,name.asc&limit=500';

  if (category && isValidCategory(category)) {
    path += `&category=eq.${encodeURIComponent(category)}`;
  }

  // Order form uses active_only=1 so retired items don't show up as
  // choices; the admin page omits this to show everything, including
  // items staff have deactivated rather than deleted.
  if (active_only === '1') {
    path += '&active=eq.true';
  }

  try {
    const resp = await supabaseRequest(path, { method: 'GET' });
    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase list error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not load the catalog.' });
      return;
    }
    const items = await resp.json();
    res.status(200).json({ ok: true, items });
  } catch (err) {
    console.error('Unexpected error listing catalog items:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function updateItem(req, res) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const { id } = body || {};

  if (!id) {
    res.status(400).json({ ok: false, error: 'A valid catalog item id is required.' });
    return;
  }

  const patch = {};
  for (const [key, maxLen] of Object.entries(FIELD_LIMITS)) {
    if (body[key] !== undefined) {
      const cleaned = sanitize(body[key], maxLen);
      if (key === 'category' && cleaned && !isValidCategory(cleaned)) {
        res.status(400).json({ ok: false, error: 'Category must be "lens" or "frame".' });
        return;
      }
      patch[key] = cleaned;
    }
  }
  if (body.active !== undefined) patch.active = !!body.active;
  if (body.sort_order !== undefined && Number.isFinite(body.sort_order)) patch.sort_order = body.sort_order;
  if (body.qty !== undefined && Number.isFinite(body.qty)) patch.qty = Math.max(0, Math.trunc(body.qty));

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: 'Provide at least one field to update.' });
    return;
  }
  patch.updated_at = new Date().toISOString();

  try {
    const resp = await supabaseRequest(`catalog_items?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(patch),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase update error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not update the catalog item.' });
      return;
    }

    const [updated] = await resp.json();
    res.status(200).json({ ok: true, item: updated });
  } catch (err) {
    console.error('Unexpected error updating catalog item:', err);
    res.status(500).json({ ok: false, error: 'Unexpected server error.' });
  }
}

async function deleteItem(req, res) {
  const { id } = req.query || {};
  if (!id) {
    res.status(400).json({ ok: false, error: 'A valid catalog item id is required.' });
    return;
  }

  try {
    const resp = await supabaseRequest(`catalog_items?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Supabase delete error:', resp.status, errText);
      res.status(502).json({ ok: false, error: 'Could not delete the catalog item.' });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Unexpected error deleting catalog item:', err);
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

  if (!requireAuth(req, res)) return;

  if (req.method === 'POST') return createItem(req, res);
  if (req.method === 'GET') return listItems(req, res);
  if (req.method === 'PATCH') return updateItem(req, res);
  if (req.method === 'DELETE') return deleteItem(req, res);

  res.status(405).json({ ok: false, error: 'Method not allowed' });
};
