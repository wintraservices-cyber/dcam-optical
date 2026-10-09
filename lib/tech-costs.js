// Technology costs shown to the client in Settings -> Website -> Tech costs,
// stored in app_settings under "tech_costs".
//
// { currency: 'USD' | 'PHP', items: [{ name, provider, amount, period, status, note }] }
//   period: 'month' | 'year' | 'once'
//   paid_on: 'YYYY-MM-DD' or '' (when it was last paid)
//   status: 'placeholder' (an estimate, not a real bill) | 'actual'
//
// A missing setting normalizes to the placeholder list below so the page
// is never empty. Amounts are plain numbers; nothing here is billed.

const PERIODS = ['month', 'year', 'once'];
const STATUSES = ['placeholder', 'actual'];
const MAX_ITEMS = 30;

const DEFAULT_ITEMS = [
  { name: 'Domain name (dcamoptical.com)', provider: 'GoDaddy', amount: 22, period: 'year', status: 'placeholder', paid_on: '2026-09-28', note: 'Renews yearly.' },
  { name: 'Website hosting', provider: 'Vercel (Hobby plan)', amount: 0, period: 'month', status: 'placeholder', note: 'Free plan at launch; a paid plan may be needed if traffic grows.' },
  { name: 'Database', provider: 'Supabase (free plan)', amount: 0, period: 'month', status: 'placeholder', note: 'Free plan at launch.' },
  { name: 'Business email', provider: 'Google Workspace (2 mailboxes), TBD: Microsoft 365 or Google', amount: 16.98, period: 'month', status: 'placeholder', note: 'About $8.49 per mailbox. Priced as Google Workspace for now; provider still to be decided (Microsoft 365 or Google). Not yet purchased.' },
  { name: 'AI assistant: Claude (manual load)', provider: 'Anthropic', amount: 20, period: 'once', status: 'actual', paid_on: '2026-10-09', note: '$20 of prepaid credit loaded on 2026-10-09. Loaded by hand and not renewed automatically; more is added when it runs low.' },
  { name: 'AI assistant: Gemini (trial)', provider: 'Google Cloud', amount: 0, period: 'once', status: 'actual', note: 'Free trial with $300 of credit for about 3 months. If the credit is used up, more will be loaded by hand.' },
  { name: 'Website analytics', provider: 'Google Analytics and Search Console', amount: 0, period: 'month', status: 'placeholder', note: 'Free.' },
  { name: 'Social media', provider: 'TBD', amount: 0, label: '$$$', period: 'month', status: 'placeholder', note: 'TBD. Not included in the totals.' },
  { name: 'Ongoing support and updates', provider: 'ArrowheadX AI', amount: 0, label: '$$$', period: 'month', status: 'placeholder', note: 'To be agreed. Not included in the totals.' },
];

function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function normalizeTechCosts(value) {
  const v = value && typeof value === 'object' ? value : {};
  const currency = v.currency === 'PHP' ? 'PHP' : 'USD';
  const src = Array.isArray(v.items) ? v.items : DEFAULT_ITEMS;
  const items = src.slice(0, MAX_ITEMS).map((it) => {
    const x = it && typeof it === 'object' ? it : {};
    // A number is an amount; any other text (for example "$$$" or "TBD") is
    // kept as a label, shown instead of a number and left out of the totals.
    const raw = typeof x.amount === 'string' ? x.amount.trim() : x.amount;
    const n = raw === '' || raw === null || raw === undefined ? 0 : Number(raw);
    const label = typeof x.label === 'string' ? x.label.trim() : '';
    const isText = typeof raw === 'string' && raw !== '' && !Number.isFinite(n);
    return {
      name: text(x.name, 80),
      provider: text(x.provider, 120),
      amount: !isText && Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 100) / 100, 10000000) : 0,
      label: isText ? raw.slice(0, 12) : (typeof x.amount === 'string' && Number.isFinite(n) ? '' : label.slice(0, 12)),
      paid_on: typeof x.paid_on === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.paid_on) ? x.paid_on : '',
      period: PERIODS.includes(x.period) ? x.period : 'month',
      status: STATUSES.includes(x.status) ? x.status : 'placeholder',
      note: text(x.note, 200),
    };
  }).filter((it) => it.name);
  return { currency, items };
}

module.exports = { normalizeTechCosts, DEFAULT_ITEMS };
