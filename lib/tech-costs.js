// Technology costs shown to the client in Settings -> Website -> Tech costs,
// stored in app_settings under "tech_costs".
//
// { currency: 'USD' | 'PHP', items: [{ name, provider, amount, period, status, note }] }
//   period: 'month' | 'year' | 'once'
//   status: 'placeholder' (an estimate, not a real bill) | 'actual'
//
// A missing setting normalizes to the placeholder list below so the page
// is never empty. Amounts are plain numbers; nothing here is billed.

const PERIODS = ['month', 'year', 'once'];
const STATUSES = ['placeholder', 'actual'];
const MAX_ITEMS = 30;

const DEFAULT_ITEMS = [
  { name: 'Domain name (dcamoptical.com)', provider: 'GoDaddy', amount: 22, period: 'year', status: 'placeholder', note: 'Renews yearly.' },
  { name: 'Website hosting', provider: 'Vercel (Hobby plan)', amount: 0, period: 'month', status: 'placeholder', note: 'Free plan at launch; a paid plan may be needed if traffic grows.' },
  { name: 'Database', provider: 'Supabase (free plan)', amount: 0, period: 'month', status: 'placeholder', note: 'Free plan at launch.' },
  { name: 'Business email', provider: 'Google Workspace (2 mailboxes)', amount: 16.98, period: 'month', status: 'placeholder', note: 'About $8.49 per mailbox. Not yet purchased.' },
  { name: 'AI assistants (website chat and staff assistant)', provider: 'Claude / Gemini', amount: 20, period: 'month', status: 'placeholder', note: 'Estimate for moderate use; see Usage & cost in the AI assistant tab for the real figure.' },
  { name: 'Website analytics', provider: 'Google Analytics and Search Console', amount: 0, period: 'month', status: 'placeholder', note: 'Free.' },
  { name: 'Ongoing support and updates', provider: 'ArrowheadX AI', amount: 0, period: 'month', status: 'placeholder', note: 'To be agreed.' },
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
    const n = Number(x.amount);
    return {
      name: text(x.name, 80),
      provider: text(x.provider, 80),
      amount: Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 100) / 100, 10000000) : 0,
      period: PERIODS.includes(x.period) ? x.period : 'month',
      status: STATUSES.includes(x.status) ? x.status : 'placeholder',
      note: text(x.note, 200),
    };
  }).filter((it) => it.name);
  return { currency, items };
}

module.exports = { normalizeTechCosts, DEFAULT_ITEMS };
