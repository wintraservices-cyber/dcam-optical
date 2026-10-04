// Homepage content controls, stored in app_settings under "homepage" and
// edited by admins in Settings -> Website -> Homepage.
//
// {
//   sections: { services, story, faq, quiz, book, track }   // true = shown
//   faq: [{ q, a }]                                     // FAQ shown on the home page
//   text: { <field key>: string }                       // Page text overrides (see TEXT_FIELDS)
// }
//
// FAQ answers may use placeholders filled in from Settings -> Business
// info when the page loads, so hours/address are typed in one place only:
//   {name} {branch} {address} {hours} {mobile} {tel} {email}
// A placeholder with no value in Business info is shown as blank.
//
// A missing or partial setting always normalizes to the page's original
// content, so nothing disappears before an admin changes something.

// 'book' MUST be listed here: normalizeHomepage() rebuilds `sections` from
// this list, so any key missing from it is silently dropped on every save.
const SECTION_KEYS = ['services', 'story', 'faq', 'quiz', 'book', 'track'];

const SECTION_LABELS = {
  services: 'What we do (services)',
  story: 'Our story',
  faq: 'Frequently asked questions',
  quiz: 'Find your frame (style quiz)',
  book: 'Book your eye exam (booking form)',
  track: '"Are my glasses ready?" order check',
};

const MAX_FAQ = 12;
const MAX_Q = 200;
const MAX_A = 1000;

const DEFAULT_FAQ = [
  {
    q: 'Do you take HMO or insurance?',
    a: 'We accept a number of HMO providers — bring your HMO card and a valid ID for your visit and our front desk will confirm coverage.',
  },
  {
    q: 'What happens at a first eye exam?',
    a: 'A first visit starts with a quick history, then a full refraction and eye health check. Most first exams take about 20–30 minutes.',
  },
  {
    q: 'What are your hours and where are you located?',
    a: '{name} is at {branch}, {address}. We are open {hours}.',
  },
];

// ---------------------------------------------------------------------
// Page text (Settings -> Website -> Homepage -> Page text).
// Each field maps to an element marked data-text="<key>" in index.html.
// `original` is the text shipped in index.html; the saved setting stores
// only fields that differ from it, so "Restore original" just drops the
// override. Plain text only -- fields marked rich also allow **bold**.
// ---------------------------------------------------------------------
const TEXT_FIELDS = [
  { key: "hero_badge", group: "Hero (top of page)", label: "Small badge above the headline", max: 120, original: "Formerly Limuaco Optical · Ever Gotesco Commonwealth" },
  { key: "hero_title_1", group: "Hero (top of page)", label: "Headline \u2014 line 1", max: 60, original: "See the world" },
  { key: "hero_title_2", group: "Hero (top of page)", label: "Headline \u2014 line 2 (coloured)", max: 60, original: "in focus." },
  { key: "hero_lede", group: "Hero (top of page)", label: "Text under the headline", max: 300, original: "Eye exams and eyewear chosen with care, right in Quezon City. Step inside, and everything gets clearer from here." },
  { key: "services_kicker", group: "What we do", label: "Small label", max: 40, original: "What we do" },
  { key: "services_title", group: "What we do", label: "Heading", max: 100, original: "Clear sight, start to finish." },
  { key: "services_lede", group: "What we do", label: "Intro text", max: 300, original: "From your first exam to the day you pick up your new glasses, one team looks after you." },
  { key: "svc1_title", group: "What we do", label: "Card 1 \u2014 title", max: 60, original: "Eye exams" },
  { key: "svc1_text", group: "What we do", label: "Card 1 \u2014 text", max: 240, original: "Vision and eye health checks for adults and kids, with results explained in plain language." },
  { key: "svc2_title", group: "What we do", label: "Card 2 \u2014 title", max: 60, original: "Glasses, lenses & frames" },
  { key: "svc2_text", group: "What we do", label: "Card 2 \u2014 text", max: 240, original: "Prescription glasses, contact lenses, frames and sunwear. Bring your own Rx or use ours." },
  { key: "svc3_title", group: "What we do", label: "Card 3 \u2014 title", max: 60, original: "Order tracking" },
  { key: "svc3_text", group: "What we do", label: "Card 3 \u2014 text", max: 240, original: "Use the order number on your claim stub and your phone number to see if your glasses are ready." },
  { key: "story_title", group: "Our story", label: "Heading", max: 120, original: "Formerly Limuaco Optical, now DCAM Optical." },
  { key: "story_p1", group: "Our story", label: "Paragraph 1", max: 900, rich: true, original: "For decades, families along Commonwealth Avenue have known us as **Limuaco Optical**, a family-friendly optical shop that earned its reputation the old-fashioned way: careful eye exams, precise refraction, and glasses and contact lenses fitted properly, first on Panay Avenue and later at Ever Gotesco Commonwealth." },
  { key: "story_p2", group: "Our story", label: "Paragraph 2", max: 900, rich: true, original: "Today, that practice transcends to **DCAM Optical**. We're in the same home at Ever Gotesco and share the same belief that good eye care shouldn't be rushed, now with a new name, a refreshed shop, and new conveniences like online booking and order tracking." },
  { key: "value1_title", group: "Our story", label: "Value 1 \u2014 title", max: 60, original: "Unhurried exams" },
  { key: "value1_text", group: "Our story", label: "Value 1 \u2014 text", max: 200, original: "Time to ask questions, and results you actually understand." },
  { key: "value2_title", group: "Our story", label: "Value 2 \u2014 title", max: 60, original: "Honest advice" },
  { key: "value2_text", group: "Our story", label: "Value 2 \u2014 text", max: 200, original: "We recommend what you need, not the most expensive option." },
  { key: "value3_title", group: "Our story", label: "Value 3 \u2014 title", max: 60, original: "Frames that fit your life" },
  { key: "value3_text", group: "Our story", label: "Value 3 \u2014 text", max: 200, original: "Try on as many as you like. We'll help you find the one." },
  { key: "book_title", group: "Booking & order check", label: "Booking \u2014 heading", max: 80, original: "Book your eye exam" },
  { key: "book_note", group: "Booking & order check", label: "Booking \u2014 note under the button", max: 240, original: "This opens our full patient intake form. It takes about two minutes." },
  { key: "track_title", group: "Booking & order check", label: "Order check \u2014 heading", max: 80, original: "Are my glasses ready?" },
  { key: "track_text", group: "Booking & order check", label: "Order check \u2014 text", max: 240, original: "Enter both details from when you placed your order." },
  { key: "quiz_kicker", group: "Find your frame (quiz)", label: "Small label", max: 40, original: "Find your frame" },
  { key: "quiz_title", group: "Find your frame (quiz)", label: "Heading", max: 100, original: "A 30-second style match." },
  { key: "quiz_lede", group: "Find your frame (quiz)", label: "Intro text", max: 400, original: "Answer a few quick questions and we'll point you toward frame shapes that actually suit you — a starting point for your fitting, not a final decision." },
  { key: "privacy_title", group: "Privacy & AI notice", label: "Privacy \u2014 heading", max: 60, original: "Your privacy" },
  { key: "privacy_body", group: "Privacy & AI notice", label: "Privacy \u2014 text (your email from Business info is added after it)", max: 900, original: "We handle your personal and health information in line with the Data Privacy Act of 2012 (RA 10173). We collect only what we need for your care and orders, keep it secure, and never sell it. You can ask us to access, correct or delete your data at any time." },
  { key: "ai_notice_title", group: "Privacy & AI notice", label: "AI notice \u2014 heading", max: 60, original: "How we use AI" },
  { key: "ai_notice_body", group: "Privacy & AI notice", label: "AI notice \u2014 text", max: 900, original: "Our website chat uses AI to answer common questions and help you book. It doesn't diagnose or give medical advice; eye health questions go to our licensed optometrists. Please don't share sensitive health details in chat. You can always reach a person at the shop." },
];
const TEXT_KEYS = TEXT_FIELDS.map(f => f.key);

function normalizeText(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  TEXT_FIELDS.forEach(f => {
    if (typeof t[f.key] !== 'string') return;
    const v = t[f.key].replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim().slice(0, f.max);
    if (v && v !== f.original) out[f.key] = v;   // blank or unchanged = use the original
  });
  return out;
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

function normalizeHomepage(value) {
  const v = value && typeof value === 'object' ? value : {};
  const s = v.sections && typeof v.sections === 'object' ? v.sections : {};
  const sections = {};
  SECTION_KEYS.forEach(k => { sections[k] = typeof s[k] === 'boolean' ? s[k] : true; });

  let faq;
  if (Array.isArray(v.faq)) {
    faq = v.faq
      .filter(x => x && typeof x === 'object')
      .map(x => ({ q: cleanText(x.q, MAX_Q), a: cleanText(x.a, MAX_A) }))
      .filter(x => x.q && x.a)
      .slice(0, MAX_FAQ);
  } else {
    faq = DEFAULT_FAQ.map(x => ({ ...x }));
  }
  return { sections, faq, text: normalizeText(v.text) };
}

module.exports = { TEXT_FIELDS, TEXT_KEYS, normalizeText, SECTION_KEYS, SECTION_LABELS, DEFAULT_FAQ, MAX_FAQ, MAX_Q, MAX_A, normalizeHomepage };
