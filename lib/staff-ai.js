// Staff assistant: read-only lookup tools + instructions.
//
// The model never writes queries. It can only call the fixed tools
// below, and only the ones whose area is switched on for the caller's
// role in Settings -> AI assistant (see lib/ai-access.js). Each tool
// re-checks its area before touching the database, so a tool the model
// wasn't offered can't be run even if it asks for it by name.
//
// Every tool is a SELECT. Nothing here creates, edits or deletes data.

const { supabaseRequest } = require('./supabase');

const TZ = 'Asia/Manila';

function todayManila() {
  return new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
}

function num(v) {
  if (v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function peso(n) {
  return '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// Manila-day boundaries -> PostgREST filters on created_at.
function dateFilter(from, to, field = 'created_at') {
  let f = '';
  if (isDate(from)) f += `&${field}=gte.${encodeURIComponent(from + 'T00:00:00+08:00')}`;
  if (isDate(to)) f += `&${field}=lte.${encodeURIComponent(to + 'T23:59:59+08:00')}`;
  return f;
}

// Free text from the model goes into ilike patterns; strip anything that
// could change the PostgREST filter syntax.
function cleanQuery(q) {
  return String(q || '').replace(/[^\p{L}\p{N}\s\-#.@]/gu, ' ').replace(/#/g, '').trim().slice(0, 60);
}

function clampLimit(v, def, max) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

async function getJson(path) {
  const resp = await supabaseRequest(path, { method: 'GET' });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`lookup failed (${resp.status}) ${t.slice(0, 200)}`);
  }
  return resp.json();
}

function toManilaDate(ts) {
  if (!ts) return null;
  try { return new Date(ts).toLocaleDateString('en-CA', { timeZone: TZ }); } catch (e) { return String(ts).slice(0, 10); }
}

// ---------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------

const TOOLS = {
  search_orders: {
    area: 'orders',
    definition: {
      name: 'search_orders',
      description: 'Search orders. Filter by order number or patient name text, order status, payment status, date the order was created, or due date. Returns newest first.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Order number or part of a patient name.' },
          status: { type: 'string', enum: ['ordered', 'ready', 'claimed'] },
          payment_status: { type: 'string', enum: ['unpaid', 'partial', 'paid'] },
          created_from: { type: 'string', description: 'YYYY-MM-DD (Manila date)' },
          created_to: { type: 'string', description: 'YYYY-MM-DD (Manila date)' },
          due_on_or_before: { type: 'string', description: 'YYYY-MM-DD; orders whose due date is on or before this day.' },
          limit: { type: 'integer', description: 'Max results, default 20, max 50.' },
        },
      },
    },
    async run(input, ctx) {
      const showMoney = ctx.areas.includes('balances');
      const fields = [
        'order_no', 'order_type', 'rx_subtype', 'patient_name', 'order_date', 'due_date', 'status',
        'amount', 'frame', 'lens_type', 'lens_material', 'item_name', 'created_at',
        'order_items(item_name,item_qty,item_line_total)',
      ];
      if (showMoney) fields.push('deposit', 'balance', 'payment_status');

      let path = `orders?select=${fields.join(',')}&order=created_at.desc`;
      const q = cleanQuery(input.query);
      if (q) path += `&or=(order_no.ilike.*${encodeURIComponent(q)}*,patient_name.ilike.*${encodeURIComponent(q)}*)`;
      if (['ordered', 'ready', 'claimed'].includes(input.status)) path += `&status=eq.${input.status}`;
      if (showMoney && ['unpaid', 'partial', 'paid'].includes(input.payment_status)) path += `&payment_status=eq.${input.payment_status}`;
      path += dateFilter(input.created_from, input.created_to);

      const limit = clampLimit(input.limit, 20, 50);
      // due_date is free text on the form, so filter it here rather than in SQL.
      const dueCut = isDate(input.due_on_or_before) ? input.due_on_or_before : null;
      path += `&limit=${dueCut ? 300 : limit}`;

      let rows = await getJson(path);
      if (dueCut) rows = rows.filter(o => isDate(o.due_date) && o.due_date <= dueCut).slice(0, limit);

      return {
        count: rows.length,
        note: showMoney ? undefined : 'Balance and payment details are switched off for your role.',
        orders: rows.map(o => ({
          order_no: o.order_no,
          type: o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx'),
          patient: o.patient_name,
          created: toManilaDate(o.created_at),
          order_date: o.order_date || null,
          due: o.due_date || null,
          status: o.status,
          amount: o.amount || null,
          ...(showMoney ? { deposit: o.deposit || null, balance: o.balance || null, payment_status: o.payment_status } : {}),
          frame: o.frame || null,
          lens: [o.lens_type, o.lens_material].filter(Boolean).join(', ') || null,
          items: (o.order_items || []).map(i => `${i.item_name}${i.item_qty ? ' x' + i.item_qty : ''}`),
        })),
      };
    },
  },

  balances_overview: {
    area: 'balances',
    definition: {
      name: 'balances_overview',
      description: 'Orders that still have money owing (unpaid or partial, balance above zero), oldest first, with the total outstanding. Optionally also lists balance payments logged in a date range.',
      input_schema: {
        type: 'object',
        properties: {
          payments_from: { type: 'string', description: 'YYYY-MM-DD; include balance payments logged from this day.' },
          payments_to: { type: 'string', description: 'YYYY-MM-DD' },
          created_from: { type: 'string', description: 'Only outstanding orders created on/after this day.' },
          created_to: { type: 'string', description: 'Only outstanding orders created on/before this day.' },
        },
      },
    },
    async run(input) {
      const orders = await getJson(
        'orders?select=order_no,patient_name,created_at,due_date,status,amount,deposit,balance,payment_status' +
        '&payment_status=in.(unpaid,partial)&order=created_at.asc&limit=300' +
        dateFilter(input.created_from, input.created_to)
      );
      const owing = orders.filter(o => num(o.balance) > 0);
      const total = owing.reduce((s, o) => s + num(o.balance), 0);

      const result = {
        outstanding_count: owing.length,
        outstanding_total: peso(total),
        outstanding: owing.slice(0, 60).map(o => ({
          order_no: o.order_no,
          patient: o.patient_name,
          created: toManilaDate(o.created_at),
          due: o.due_date || null,
          status: o.status,
          payment_status: o.payment_status,
          amount: o.amount || null,
          balance: o.balance,
        })),
      };
      if (owing.length > 60) result.note = `Showing the 60 oldest of ${owing.length}.`;

      if (isDate(input.payments_from) || isDate(input.payments_to)) {
        const pays = await getJson(
          'balance_payments?select=order_no,amount,payment_method,taken_by,created_at&order=created_at.desc&limit=200' +
          dateFilter(input.payments_from, input.payments_to)
        );
        result.payments_logged = {
          count: pays.length,
          total: peso(pays.reduce((s, p) => s + num(p.amount), 0)),
          payments: pays.slice(0, 60).map(p => ({
            order_no: p.order_no,
            amount: p.amount,
            method: p.payment_method,
            taken_by: p.taken_by || null,
            date: toManilaDate(p.created_at),
          })),
        };
      }
      return result;
    },
  },

  get_stock: {
    area: 'stock',
    definition: {
      name: 'get_stock',
      description: 'Catalog frames and lenses with quantity on hand and sale price. Can filter by text, category, or items at/below a quantity (low stock).',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Part of a name, brand or code.' },
          category: { type: 'string', enum: ['frame', 'lens'] },
          qty_at_or_below: { type: 'integer', description: 'Only items with this quantity or fewer.' },
          include_inactive: { type: 'boolean' },
        },
      },
    },
    async run(input, ctx) {
      const isAdmin = ctx.role === 'admin';
      const fields = ['category', 'code', 'name', 'brand', 'description', 'price', 'qty', 'active'];
      if (isAdmin) fields.push('base_price');
      let path = `catalog_items?select=${fields.join(',')}&order=category.asc,qty.asc,name.asc&limit=150`;
      if (!input.include_inactive) path += '&active=eq.true';
      if (['frame', 'lens'].includes(input.category)) path += `&category=eq.${input.category}`;
      const q = cleanQuery(input.query);
      if (q) {
        const e = encodeURIComponent(q);
        path += `&or=(name.ilike.*${e}*,brand.ilike.*${e}*,code.ilike.*${e}*)`;
      }
      if (Number.isFinite(parseInt(input.qty_at_or_below, 10))) path += `&qty=lte.${parseInt(input.qty_at_or_below, 10)}`;
      const rows = await getJson(path);
      return {
        count: rows.length,
        items: rows.map(i => ({
          category: i.category,
          code: i.code || null,
          name: [i.brand, i.name].filter(Boolean).join(' '),
          description: i.description || null,
          sale_price: i.price || null,
          ...(isAdmin ? { base_price: i.base_price || null } : {}),
          qty: i.qty,
          active: i.active,
        })),
      };
    },
  },

  sales_summary: {
    area: 'sales',
    definition: {
      name: 'sales_summary',
      description: 'Money collected in a date range (order deposits + balance payments, the same basis as the Sales report), split into cash and GCash/card, plus orders created and total billed.',
      input_schema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'YYYY-MM-DD (Manila date)' },
          to: { type: 'string', description: 'YYYY-MM-DD (Manila date)' },
        },
        required: ['from', 'to'],
      },
    },
    async run(input) {
      const from = isDate(input.from) ? input.from : todayManila();
      const to = isDate(input.to) ? input.to : from;
      const [orders, pays] = await Promise.all([
        getJson('orders?select=amount,deposit,payment_method,split_cash,split_gcash&limit=5000' + dateFilter(from, to)),
        getJson('balance_payments?select=amount,payment_method,split_cash,split_gcash&limit=5000' + dateFilter(from, to)),
      ]);

      const events = [];
      orders.forEach(o => { const a = num(o.deposit); if (a > 0) events.push({ a, m: o.payment_method || 'cash', c: num(o.split_cash), g: num(o.split_gcash) }); });
      pays.forEach(p => events.push({ a: num(p.amount), m: p.payment_method || 'cash', c: num(p.split_cash), g: num(p.split_gcash) }));

      const collected = events.reduce((s, e) => s + e.a, 0);
      const cash = events.reduce((s, e) => s + (e.m === 'cash' ? e.a : e.m === 'split' ? e.c : 0), 0);
      const gcash = events.reduce((s, e) => s + (e.m === 'gcash_cc' ? e.a : e.m === 'split' ? e.g : 0), 0);

      return {
        from, to,
        orders_created: orders.length,
        total_billed_on_new_orders: peso(orders.reduce((s, o) => s + num(o.amount), 0)),
        collected_total: peso(collected),
        collected_cash: peso(cash),
        collected_gcash_card: peso(gcash),
        deposits_collected: peso(orders.reduce((s, o) => s + num(o.deposit), 0)),
        balance_payments_collected: peso(pays.reduce((s, p) => s + num(p.amount), 0)),
        balance_payment_count: pays.length,
      };
    },
  },

  find_patient: {
    area: 'patients',
    definition: {
      name: 'find_patient',
      description: 'Find a patient by name or phone number and return their contact details, recent orders with full Rx values, and recent intake submissions.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Part of the patient name, or phone digits.' } },
        required: ['query'],
      },
    },
    async run(input) {
      const q = cleanQuery(input.query);
      if (q.length < 2) return { error: 'Give at least 2 characters of a name or phone number.' };
      const e = encodeURIComponent(q);
      const digits = q.replace(/\D/g, '');
      const phoneClause = digits.length >= 4 ? `,phone.ilike.*${digits.slice(-7)}*` : '';
      const patients = await getJson(`patients?select=id,name,phone,email,created_at&or=(name.ilike.*${e}*${phoneClause})&limit=5`);
      if (!patients.length) return { count: 0, patients: [] };

      const ids = patients.map(p => p.id).join(',');
      const [orders, intakes] = await Promise.all([
        getJson(
          `orders?select=patient_id,order_no,order_type,rx_subtype,created_at,order_date,status,payment_status,balance,` +
          `rx_r_sph,rx_r_cyl,rx_r_axis,rx_r_prism,rx_r_base,rx_l_sph,rx_l_cyl,rx_l_axis,rx_l_prism,rx_l_base,` +
          `add_r,add_l,pd_mode,pd_r,pd_l,seg_ht_r,seg_ht_l,lens_type,lens_material,frame` +
          `&patient_id=in.(${ids})&order=created_at.desc&limit=40`
        ),
        getJson(`intake_submissions?select=patient_id,reason,patient_type,pref_date,created_at&patient_id=in.(${ids})&order=created_at.desc&limit=20`).catch(() => []),
      ]);

      return {
        count: patients.length,
        patients: patients.map(p => ({
          name: p.name,
          phone: p.phone,
          email: p.email || null,
          patient_since: toManilaDate(p.created_at),
          recent_orders: orders.filter(o => o.patient_id === p.id).slice(0, 8).map(o => ({
            order_no: o.order_no,
            type: o.order_type === 'non_rx' ? 'Non-Rx' : (o.rx_subtype || 'Rx'),
            created: toManilaDate(o.created_at),
            status: o.status,
            payment_status: o.payment_status,
            balance: o.balance || null,
            rx: o.order_type === 'non_rx' ? undefined : {
              OD: { sph: o.rx_r_sph, cyl: o.rx_r_cyl, axis: o.rx_r_axis, prism: o.rx_r_prism, base: o.rx_r_base, add: o.add_r, seg_ht: o.seg_ht_r },
              OS: { sph: o.rx_l_sph, cyl: o.rx_l_cyl, axis: o.rx_l_axis, prism: o.rx_l_prism, base: o.rx_l_base, add: o.add_l, seg_ht: o.seg_ht_l },
              pd: [o.pd_mode, o.pd_r, o.pd_l].filter(Boolean).join(' '),
              lens: [o.lens_type, o.lens_material].filter(Boolean).join(', '),
              frame: o.frame || null,
            },
          })),
          recent_intakes: intakes.filter(i => i.patient_id === p.id).slice(0, 5).map(i => ({
            submitted: toManilaDate(i.created_at),
            reason: i.reason || null,
            patient_type: i.patient_type || null,
            preferred_date: i.pref_date || null,
          })),
        })),
      };
    },
  },
};

const HOWTO_GUIDE = `STAFF SYSTEM GUIDE (for how-to questions):
- Orders page (staff-orders.html): lists all orders; filter tabs All / Ordered / Ready / Claimed. Change an order's status or payment status (Unpaid / Partial / Paid) with the dropdowns on each row. "Edit" under the order number opens it in the order form. "Log payment" records a balance payment: enter amount and method (Cash, GCash/CC, or Split), then "Save payment" — the balance drops and the status becomes Partial, or Paid once the balance reaches zero.
- New order (order-form.html): choose "Rx Order" or "Non-Rx Order". Rx orders use the SPH/CYL/AXIS/ADD dropdowns (a CYL needs an AXIS). "+ Add item" adds line items; items picked from the catalog reduce stock automatically when saved. Enter amount, deposit and payment method, then "Save order". "Print order + stub" prints the job order with the claim stub. When editing an existing order, "Payment & edit history" shows who changed what.
- Patient lookup (staff-patient-lookup.html): search by name or phone to see a patient's intake forms and orders together. "Edit" changes the patient's details; "Move to different patient" reassigns an order or intake that was saved under the wrong person; "Edit order" opens that order.
- Catalog (staff-catalog.html): Frames and Lenses tabs. Add items with brand, base (cost) price, sale price and quantity. Quantity goes down automatically when an item is sold on an order.
- Reports (staff-reports.html): pick a date range and "Download CSV" for Orders, Sales / revenue, Patient list, or Inventory / stock levels.
- Settings (admins only): Rx dropdown ranges, Business info (shown on the order form and to the website chat), intake phone validation, Staff accounts, and AI assistant access.
- Website intake form (intake.html): patients submit it online; it appears under Patient lookup.`;

function toolsFor(areas) {
  return Object.values(TOOLS).filter(t => areas.includes(t.area)).map(t => t.definition);
}

async function runTool(name, input, ctx) {
  const tool = TOOLS[name];
  if (!tool || !ctx.areas.includes(tool.area)) {
    return { error: 'That lookup is switched off in Settings for your role.' };
  }
  try {
    return await tool.run(input || {}, ctx);
  } catch (err) {
    console.error(`staff-ai: tool ${name} failed`, err.message);
    return { error: 'The lookup failed. Tell the user to try again or check the page directly.' };
  }
}

const AREA_WORDS = {
  orders: 'orders', balances: 'balances and payments', stock: 'inventory/stock',
  sales: 'sales and revenue', patients: 'patient records', howto: 'how to use the system',
};

function buildStaffPrompt(ctx) {
  const on = ctx.areas.map(a => AREA_WORDS[a]);
  const off = Object.keys(AREA_WORDS).filter(a => !ctx.areas.includes(a)).map(a => AREA_WORDS[a]);
  return `You are the internal staff assistant for DCAM Optical, an optometry practice in the Philippines. You are talking with ${ctx.username || 'a staff member'} (${ctx.role}). Today is ${todayManila()} (Asia/Manila). Currency is Philippine pesos (₱).

You can help with: ${on.join(', ') || 'nothing (all areas are switched off)'}.
Switched off for this user's role: ${off.join(', ') || 'none'}. If asked about a switched-off area, say it's turned off in Settings -> AI assistant and that an admin can enable it. Don't try to work around this.

RULES:
- Use the lookup tools for any question about real data. Never guess or invent order numbers, names, amounts, quantities or Rx values. If a lookup returns nothing, say so.
- You are read-only. You cannot create, edit, delete, or mark anything paid. When asked to change something, say which page and button to use.
- Resolve relative dates ("today", "this week", "last month") into exact YYYY-MM-DD Manila dates before calling tools, and state the range you used.
- Be brief and scannable: a one-line answer first, then a short list if needed. Plain text; simple "- " bullets are fine, no tables or headings.
- Money: show pesos with ₱. Totals come from the tools; don't recompute unless combining tool results.
- Rx data is for staff reference only; don't give clinical advice or interpret prescriptions medically.
${ctx.areas.includes('howto') ? '\n' + HOWTO_GUIDE : ''}`;
}

module.exports = { toolsFor, runTool, buildStaffPrompt, todayManila };
