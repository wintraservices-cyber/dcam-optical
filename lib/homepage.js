// Homepage content controls, stored in app_settings under "homepage" and
// edited by admins in Settings -> Website -> Homepage.
//
// {
//   sections: { services, story, faq, quiz, track }   // true = shown
//   faq: [{ q, a }]                                     // FAQ shown on the home page
// }
//
// FAQ answers may use placeholders filled in from Settings -> Business
// info when the page loads, so hours/address are typed in one place only:
//   {name} {branch} {address} {hours} {mobile} {tel} {email}
// A placeholder with no value in Business info is shown as blank.
//
// A missing or partial setting always normalizes to the page's original
// content, so nothing disappears before an admin changes something.

const SECTION_KEYS = ['services', 'story', 'faq', 'quiz', 'track'];

const SECTION_LABELS = {
  services: 'What we do (services)',
  story: 'Our story',
  faq: 'Frequently asked questions',
  quiz: 'Find your frame (style quiz)',
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
  return { sections, faq };
}

module.exports = { SECTION_KEYS, SECTION_LABELS, DEFAULT_FAQ, MAX_FAQ, MAX_Q, MAX_A, normalizeHomepage };
