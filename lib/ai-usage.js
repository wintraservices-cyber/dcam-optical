// AI usage + cost tracking.
//
// Every assistant reply (website or staff) writes one row to
// ai_usage_log with the tokens the Claude API reported and an ESTIMATED
// USD cost computed from the price table below at that moment -- so a
// future price change never rewrites past costs.
//
// These are estimates from token counts. The Anthropic Console's billing
// page is the source of truth for what's actually charged; this should
// match it closely for plain (uncached, non-batch) calls like ours.

const { supabaseRequest } = require('./supabase');

// USD per million tokens. Update here if pricing or the model changes.
// Source: https://platform.claude.com/docs/en/about-claude/pricing
const PRICES = [
  { match: 'haiku-4-5',  input: 1,  output: 5 },
  { match: 'sonnet-4-5', input: 3,  output: 15 },
  { match: 'sonnet-4',   input: 3,  output: 15 },
  { match: 'opus-4-5',   input: 5,  output: 25 },
];
const FALLBACK = { input: 3, output: 15 }; // conservative if the model isn't listed

function priceFor(model) {
  const m = String(model || '');
  return PRICES.find(p => m.includes(p.match)) || FALLBACK;
}

function costUsd(model, inputTokens, outputTokens) {
  const p = priceFor(model);
  return (inputTokens * p.input + outputTokens * p.output) / 1e6;
}

// Best-effort: a logging failure must never break a chat reply.
async function logUsage({ channel, model, inputTokens, outputTokens, apiCalls, toolCalls, username, role }) {
  const inTok = Math.max(0, parseInt(inputTokens, 10) || 0);
  const outTok = Math.max(0, parseInt(outputTokens, 10) || 0);
  if (!inTok && !outTok) return;
  try {
    const resp = await supabaseRequest('ai_usage_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        channel,
        model,
        input_tokens: inTok,
        output_tokens: outTok,
        api_calls: apiCalls || 1,
        tool_calls: toolCalls || 0,
        cost_usd: Number(costUsd(model, inTok, outTok).toFixed(6)),
        username: username || null,
        role: role || null,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.error('ai-usage: log insert failed', resp.status, t.slice(0, 200));
    }
  } catch (e) {
    console.error('ai-usage: log insert error', e.message);
  }
}

// Daily totals per channel from the ai_usage_daily() SQL function.
// from/to are YYYY-MM-DD Manila dates; either may be null (open-ended).
async function usageDaily(from, to) {
  const resp = await supabaseRequest('rpc/ai_usage_daily', {
    method: 'POST',
    body: JSON.stringify({ p_from: from || null, p_to: to || null }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`ai_usage_daily failed (${resp.status}) ${t.slice(0, 200)}`);
  }
  return resp.json();
}

function summarize(rows) {
  const blank = () => ({ messages: 0, api_calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  const out = { total: blank(), website: blank(), staff: blank() };
  rows.forEach(r => {
    const bucket = r.channel === 'staff' ? out.staff : out.website;
    [bucket, out.total].forEach(b => {
      b.messages += Number(r.messages) || 0;
      b.api_calls += Number(r.api_calls) || 0;
      b.input_tokens += Number(r.input_tokens) || 0;
      b.output_tokens += Number(r.output_tokens) || 0;
      b.cost_usd += Number(r.cost_usd) || 0;
    });
  });
  ['total', 'website', 'staff'].forEach(k => { out[k].cost_usd = Number(out[k].cost_usd.toFixed(4)); });
  return out;
}

// { range: {from,to,totals,days:[...]}, all_time: totals }
async function usageReport(from, to) {
  const [rangeRows, allRows] = await Promise.all([usageDaily(from, to), usageDaily(null, null)]);

  const byDay = {};
  rangeRows.forEach(r => {
    const d = (byDay[r.day] = byDay[r.day] || { day: r.day, website_messages: 0, staff_messages: 0, cost_usd: 0 });
    if (r.channel === 'staff') d.staff_messages += Number(r.messages) || 0;
    else d.website_messages += Number(r.messages) || 0;
    d.cost_usd += Number(r.cost_usd) || 0;
  });
  const days = Object.values(byDay)
    .map(d => ({ ...d, cost_usd: Number(d.cost_usd.toFixed(4)) }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));

  const firstDay = allRows.reduce((m, r) => (!m || r.day < m ? r.day : m), null);

  return {
    range: { from, to, totals: summarize(rangeRows), days },
    all_time: { since: firstDay, totals: summarize(allRows) },
  };
}

module.exports = { logUsage, usageReport, costUsd, priceFor };
