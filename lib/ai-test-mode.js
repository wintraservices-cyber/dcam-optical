// AI TEST MODE -- free replies for testing, no Anthropic API calls.
//
// Turned on by either:
//   - Settings -> AI assistant -> "Test mode" (ai_access.test_mode), or
//   - the Vercel environment variable AI_TEST_MODE=1 (forces it on).
//
// Website chat: keyword-matched sample answers built from your REAL
// Business info and in-stock catalog, so hours/contacts/stock show what
// the live assistant would be told. Includes the "Book an exam" hand-off
// and the urgent-symptom path.
//
// Staff assistant: routes the question by keywords to the SAME read-only
// lookups the AI uses (lib/staff-ai.js), honouring the per-role switches,
// and formats the real results as plain text. Only Supabase is queried.
//
// Replies are simple and literal -- they test the plumbing (bubble,
// streaming, toggles, lookups, logging), not the AI's understanding.

const { supabaseRequest } = require('./supabase');
const { runTool, todayManila, HOWTO_GUIDE } = require('./staff-ai');

function isTestMode(access) {
  const env = String(process.env.AI_TEST_MODE || '').toLowerCase();
  if (env === '1' || env === 'true' || env === 'yes' || env === 'on') return true;
  return !!(access && access.test_mode);
}

function has(text, re) { return re.test(text); }

// ---------------------------------------------------------------------
// Website chat
// ---------------------------------------------------------------------
async function loadBusinessInfo() {
  try {
    const resp = await supabaseRequest('app_settings?key=eq.business_info&select=value&limit=1', { method: 'GET' });
    if (!resp.ok) return {};
    const rows = await resp.json();
    return (rows[0] && rows[0].value) || {};
  } catch (e) { return {}; }
}

async function loadStock(limit) {
  try {
    const resp = await supabaseRequest(
      `catalog_items?select=category,name,brand,price,qty&active=eq.true&qty=gt.0&order=category.asc,sort_order.asc,name.asc&limit=${limit}`,
      { method: 'GET' }
    );
    return resp.ok ? await resp.json() : [];
  } catch (e) { return []; }
}

const NOT_SET = '(not set yet in Settings -> Business info)';

async function publicTestReply(question, access) {
  const q = String(question || '').toLowerCase();
  const b = await loadBusinessInfo();
  const name = b.name || 'DCAM Optical';
  const book = '\n[[BOOK]]';

  if (has(q, /sudden|biglang|injur|hit my eye|chemical|splash|flash|floater|curtain|can'?t see|cannot see|lost vision|bulag|severe|sobrang sakit|bleed|dugo/)) {
    return 'That could be urgent. Please get in-person care right away — visit us during clinic hours, or go to an emergency room or an ophthalmologist now if it is severe or getting worse. Please don\'t wait for a routine booking.';
  }
  if (has(q, /red|pain|masakit|namumula|itch|makati|swollen|discharge|muta/)) {
    return 'I can\'t diagnose eye problems. If the redness or pain has lasted more than a day or two, or is getting worse, please see an eye doctor soon — you can visit us or book the earliest available exam.' + book;
  }
  if (has(q, /hour|open|close|oras|bukas|sarado|schedule today|what time/)) {
    return `${name} hours: ${b.hours || NOT_SET}. Would you like to book a visit?` + book;
  }
  if (has(q, /where|location|address|saan|branch|located|direction|mall/)) {
    const where = [b.branch, b.address].filter(Boolean).join(' — ');
    return `You'll find us at: ${where || NOT_SET}.${b.hours ? ' Hours: ' + b.hours + '.' : ''}`;
  }
  if (has(q, /phone|call|contact|number|mobile|tel|email|text|viber|messenger|facebook|instagram/)) {
    const parts = [
      b.tel && `Tel: ${b.tel}`, b.mobile && `Mobile: ${b.mobile}`, b.email && `Email: ${b.email}`,
      b.social && `Social: ${String(b.social).replace(/\s*\n\s*/g, ', ')}`,
    ].filter(Boolean);
    return parts.length ? `You can reach ${name} here — ${parts.join(' · ')}.` : `Contact details are ${NOT_SET}.`;
  }
  if (has(q, /insurance|hmo|maxicare|intellicare|medicard|philhealth|coverage|card/)) {
    return 'Coverage depends on your specific HMO or vision plan — the clinic will confirm it for you. Bring your HMO card to your visit.' + book;
  }
  if (has(q, /price|cost|magkano|how much|frame|lens|glasses|salamin|eyeglass|stock|brand|sunglass/)) {
    if (!access.public.stock) {
      return 'Our frame and lens selection changes often — please visit the branch or ask during your exam and we\'ll show you what fits your prescription and budget.' + book;
    }
    const items = await loadStock(4);
    if (!items.length) return 'There are no in-stock items listed in the catalog right now — please visit the branch to see our current selection.' + book;
    const list = items.map(i => `- ${[i.brand, i.name].filter(Boolean).join(' ')} (${i.category})${i.price ? ' — ' + i.price : ''}`).join('\n');
    return `A few items currently in stock (please confirm availability in-store):\n${list}` + book;
  }
  if (has(q, /exam|first|check.?up|what to expect|how long|tagal|contact lens|kids|child|bata/)) {
    return 'A first visit is a comprehensive eye exam of about 45–60 minutes: a vision test, eye health screening and a prescription check. New patients are welcome.' + book;
  }
  if (has(q, /book|appointment|schedule|reserve|pa-?schedule|walk.?in/)) {
    return 'Happy to help you book! Tap the button below to fill in the quick intake form, and the clinic will confirm your appointment by phone or text.' + book;
  }
  if (has(q, /^(hi|hello|hey|good (morning|afternoon|evening)|kumusta|musta)\b/)) {
    return `Hi! Welcome to ${name}. I can help with hours, location, contact details, HMO coverage, what to expect at an exam, or booking a visit.`;
  }
  return 'I can help with our hours, location, contact details, HMO coverage, what to expect at an eye exam, frames and lenses, or booking a visit. What would you like to know?';
}

// ---------------------------------------------------------------------
// Staff assistant
// ---------------------------------------------------------------------
function shiftDay(ymd, days) {
  const d = new Date(ymd + 'T12:00:00+08:00');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dateRangeFrom(q) {
  const today = todayManila();
  if (/yesterday|kahapon/.test(q)) return { from: shiftDay(today, -1), to: shiftDay(today, -1), label: 'yesterday' };
  if (/this week|week|linggo/.test(q)) return { from: shiftDay(today, -6), to: today, label: 'the last 7 days' };
  if (/last month/.test(q)) {
    const [y, m] = today.split('-').map(Number);
    const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1;
    const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const mm = String(pm).padStart(2, '0');
    return { from: `${py}-${mm}-01`, to: `${py}-${mm}-${last}`, label: 'last month' };
  }
  if (/this month|month|buwan/.test(q)) return { from: today.slice(0, 8) + '01', to: today, label: 'this month' };
  return { from: today, to: today, label: 'today' };
}

const OFF = (what) => `${what} lookups are switched off for your role in Settings -> AI assistant. An admin can turn them on.`;

function bullets(lines, max) {
  const shown = lines.slice(0, max);
  const more = lines.length > max ? `\n…and ${lines.length - max} more.` : '';
  return shown.map(l => '- ' + l).join('\n') + more;
}

async function staffTestReply(question, ctx) {
  const q = String(question || '').toLowerCase();
  const can = (a) => ctx.areas.includes(a);
  const lookups = [];
  const call = async (name, input) => { lookups.push(name); return runTool(name, input, ctx); };
  const done = (reply) => ({ reply, lookups });

  // How-to questions first ("how do I log a payment" shouldn't look up balances).
  if (/^(how|paano|where do i|where can i|what does)\b|how (do|can|to)\b/.test(q)) {
    if (!can('howto')) return done(OFF('How-to'));
    const words = q.split(/\W+/).filter(w => w.length > 3 && !['how', 'what', 'where', 'does', 'paano'].includes(w));
    const lines = HOWTO_GUIDE.split('\n').filter(l => l.startsWith('- '));
    // Pick the guide section sharing the most words with the question.
    const scored = lines
      .map(l => ({ l, score: words.filter(w => l.toLowerCase().includes(w)).length }))
      .sort((a, b) => b.score - a.score);
    if (!scored.length || !scored[0].score) {
      return done('I can explain the Orders, New order, Patient lookup, Catalog, Reports and Settings pages. Try e.g. "how do I log a payment?" or "how do I print a claim stub?".');
    }
    return done(scored[0].l.slice(2));
  }

  if (/sales|revenue|collect|kita|benta|income|earn/.test(q)) {
    if (!can('sales')) return done(OFF('Sales'));
    const r = dateRangeFrom(q);
    const s = await call('sales_summary', { from: r.from, to: r.to });
    if (s.error) return done(s.error);
    return done(`Collected ${r.label} (${s.from} to ${s.to}): ${s.collected_total}\n- Cash: ${s.collected_cash}\n- GCash/card: ${s.collected_gcash_card}\n- New orders: ${s.orders_created} (billed ${s.total_billed_on_new_orders})\n- Balance payments: ${s.balance_payment_count} (${s.balance_payments_collected})`);
  }

  if (/balance|owe|owing|utang|unpaid|partial|outstanding|receivable|collectible/.test(q)) {
    if (!can('balances')) return done(OFF('Balance'));
    const r = await call('balances_overview', {});
    if (r.error) return done(r.error);
    if (!r.outstanding_count) return done('No orders have a balance owing right now.');
    return done(`${r.outstanding_count} order(s) still owe a total of ${r.outstanding_total} (oldest first):\n` +
      bullets(r.outstanding.map(o => `#${o.order_no} ${o.patient} — ${o.balance} (${o.payment_status}, ${o.status})`), 10));
  }

  if (/stock|inventory|frame|lens|catalog|low|out of|qty|quantity/.test(q)) {
    if (!can('stock')) return done(OFF('Stock'));
    const input = {};
    if (/low|running out|out of|ubos|konti/.test(q)) input.qty_at_or_below = 2;
    if (/frame/.test(q)) input.category = 'frame';
    else if (/lens/.test(q)) input.category = 'lens';
    const r = await call('get_stock', input);
    if (r.error) return done(r.error);
    if (!r.count) return done(input.qty_at_or_below != null ? 'Nothing is at 2 or fewer in stock.' : 'No matching catalog items found.');
    const head = input.qty_at_or_below != null ? `${r.count} item(s) at 2 or fewer:` : `${r.count} catalog item(s):`;
    return done(head + '\n' + bullets(r.items.map(i => `${i.name} (${i.category}) — qty ${i.qty}${i.sale_price ? ', ' + i.sale_price : ''}${i.base_price ? ' [cost ' + i.base_price + ']' : ''}`), 12));
  }

  if (/patient|rx|prescription|reseta|grado|phone number|contact of|last visit|history/.test(q)) {
    if (!can('patients')) return done(OFF('Patient record'));
    const term = q.replace(/\b(patient|patients|rx|prescription|reseta|grado|phone|number|contact|of|last|visit|history|find|look|up|lookup|search|for|the|what|was|is|show|me|a|an|and|about)\b/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim();
    if (term.length < 2) return done('Give me a patient name or phone number, e.g. "patient Juan Dela Cruz".');
    const r = await call('find_patient', { query: term });
    if (r.error) return done(r.error);
    if (!r.count) return done(`No patient found matching "${term}".`);
    return done(r.patients.map(p => {
      const last = p.recent_orders.find(o => o.rx);
      const rx = last ? `\n  Last Rx (#${last.order_no}, ${last.created}): OD ${[last.rx.OD.sph, last.rx.OD.cyl, last.rx.OD.axis].filter(Boolean).join(' / ') || '—'} · OS ${[last.rx.OS.sph, last.rx.OS.cyl, last.rx.OS.axis].filter(Boolean).join(' / ') || '—'}${last.rx.pd ? ' · PD ' + last.rx.pd : ''}` : '\n  No Rx orders on file.';
      return `${p.name} — ${p.phone}${p.email ? ', ' + p.email : ''} (${p.recent_orders.length} recent order(s))${rx}`;
    }).join('\n'));
  }

  if (/order|ready|claim|due|pickup|pick up|job|#?\d{3,}/.test(q)) {
    if (!can('orders')) return done(OFF('Order'));
    const input = {};
    if (/ready|pickup|pick up/.test(q)) input.status = 'ready';
    else if (/claimed/.test(q)) input.status = 'claimed';
    else if (/pending|not ready|in progress|ordered/.test(q)) input.status = 'ordered';
    if (/due/.test(q)) input.due_on_or_before = todayManila();
    else if (/today|ngayon/.test(q)) { input.created_from = todayManila(); input.created_to = todayManila(); }
    const num = q.match(/#?(\d{3,})/);
    if (num) input.query = num[1];
    const r = await call('search_orders', input);
    if (r.error) return done(r.error);
    if (!r.count) return done('No matching orders found.');
    return done(`${r.count} order(s) found:\n` + bullets(r.orders.map(o =>
      `#${o.order_no} ${o.patient} — ${o.status}${o.due ? ', due ' + o.due : ''}${o.balance ? ', balance ' + o.balance : ''}${o.payment_status ? ' (' + o.payment_status + ')' : ''}`
    ), 12) + (r.note ? `\n${r.note}` : ''));
  }

  const examples = [
    can('orders') && '"orders ready for claim", "orders due today"',
    can('balances') && '"who has a balance?"',
    can('stock') && '"low stock frames"',
    can('sales') && '"sales this week"',
    can('patients') && '"patient Juan Dela Cruz"',
    can('howto') && '"how do I log a payment?"',
  ].filter(Boolean);
  return done('Test mode understands simple keyword questions. Try: ' + examples.join(', ') + '.');
}

// Streams text to the browser in small chunks, like the live assistant.
async function streamText(res, text) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const parts = text.match(/\S+\s*|\s+/g) || [text];
  for (let i = 0; i < parts.length; i += 3) {
    res.write(parts.slice(i, i + 3).join(''));
    await new Promise(r => setTimeout(r, 25));
  }
}

module.exports = { isTestMode, publicTestReply, staffTestReply, streamText };
