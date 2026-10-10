// Where an intake came from: the visitor's last tagged or referred visit
// (src-track.js on the public pages) plus the optional "How did you hear
// about us?" answer. Turned into one channel name so Website insights can
// count intakes by channel. No personal data is involved.

const HEARD = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  google: 'Google search',
  google_maps: 'Google Maps',
  friend: 'Friend or family',
  walk_by: 'Walked by the shop',
  returning: 'Been here before',
  other: 'Other',
};

const CHANNELS = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  messenger: 'Messenger',
  ai: 'AI assistants',
  google_business: 'Google Business Profile',
  google_ads: 'Google Ads',
  search: 'Search engines',
  referral: 'Other websites',
  email: 'Email',
  direct: 'Direct or unknown',
};

// Links clicked inside AI assistants (referring host or utm_source, e.g. ChatGPT adds utm_source=chatgpt.com).
const AI_RE = /chatgpt|chat\.openai|openai\.com|perplexity|gemini\.google|bard\.google|copilot\.microsoft|copilot\.cloud\.microsoft|claude\.ai|anthropic|meta\.ai|deepseek|grok\.com|you\.com|phind|mistral|poe\.com/;

const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '');

function channelOf(s) {
  const src = s.source.toLowerCase(), med = s.medium.toLowerCase(), camp = s.campaign.toLowerCase(), ref = s.ref.toLowerCase();
  const all = src + ' ' + ref;
  // AI assistants first: gemini.google.com and copilot.microsoft.com would otherwise count as search.
  if (AI_RE.test(all)) return 'ai';
  if (/messenger|m\.me/.test(all)) return 'messenger';
  if (/instagram|^ig$|\big\b/.test(all)) return 'instagram';
  if (/facebook|^fb$|fb\.com|fb\.me/.test(all) || s.click === 'fbclid') return 'facebook';
  if (/gbp|business.?profile|google.?maps/.test(camp + ' ' + src) || /maps\.google|business\.google/.test(ref)) return 'google_business';
  if (s.click === 'gclid' || (/google/.test(src) && /cpc|ppc|paid|ads/.test(med))) return 'google_ads';
  if (/email|newsletter/.test(med + ' ' + src)) return 'email';
  if (/google|bing|yahoo|duckduckgo|ecosia|yandex/.test(all)) return 'search';
  if (s.source || s.ref) return 'referral';
  return 'direct';
}

// body.source = { source, medium, campaign, ref, click, landing } or null; body.heardAbout = key above.
function readAttribution(body) {
  const raw = body && body.source && typeof body.source === 'object' ? body.source : {};
  const s = {
    source: clean(raw.source, 60),
    medium: clean(raw.medium, 60),
    campaign: clean(raw.campaign, 80),
    ref: clean(raw.ref, 120).replace(/[^a-z0-9.\-]/gi, ''),
    click: raw.click === 'fbclid' || raw.click === 'gclid' ? raw.click : '',
    landing: clean(raw.landing, 120),
  };
  const heard = body && HEARD[body.heardAbout] ? body.heardAbout : null;
  return {
    src_channel: channelOf(s),
    src_source: s.source || null,
    src_medium: s.medium || null,
    src_campaign: s.campaign || null,
    src_referrer: s.ref || null,
    src_landing: s.landing || null,
    heard_about: heard,
  };
}

function describeAttribution(a) {
  const parts = [CHANNELS[a.src_channel] || a.src_channel];
  if (a.src_campaign) parts.push('campaign ' + a.src_campaign);
  if (a.heard_about) parts.push('told us: ' + HEARD[a.heard_about]);
  return parts.join(' · ');
}

module.exports = { readAttribution, describeAttribution, CHANNELS, HEARD, channelOf, AI_RE };
