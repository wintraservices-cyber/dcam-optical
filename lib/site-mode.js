// Coming Soon / Maintenance switch for the public website.
//
// Stored in app_settings under the key "site_mode":
//   { enabled, variant: 'coming_soon' | 'maintenance', message,
//     facebook_url, pin_hash, pin_salt }
//
// The preview PIN (lets staff or the client see the real site while the
// teaser is up) is hashed with the same scrypt helper as staff passwords
// and is never sent back to any browser -- redactSiteMode() swaps it for
// a plain pin_set flag.

const { hashPassword, verifyPassword } = require('./password');

const VARIANTS = ['coming_soon', 'maintenance'];
const FB_HOSTS = ['facebook.com', 'fb.com', 'fb.me', 'm.me'];

class SiteModeError extends Error {}

// Used until a link is saved in Settings > Website.
const DEFAULT_FACEBOOK_URL = 'https://www.facebook.com/dcamoptical';

// Share links copied from the Facebook app carry tracking bits
// (mibextid, fbclid...) that can make phones bounce into the app and
// land on a blank page. Drop them; keep the page address (and the id
// of a profile.php link).
const TRACKING = /^(mibextid|fbclid|rdid|share_url|ref|__cft__|__tn__|_rdr|sfnsn)/i;
function tidyFacebookUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    [...u.searchParams.keys()].forEach(k => { if (TRACKING.test(k)) u.searchParams.delete(k); });
    u.hash = '';
    return u.toString();
  } catch (e) { return ''; }
}

function cleanFacebookUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch (e) {
    throw new SiteModeError('Facebook link must be a full link, like https://www.facebook.com/yourpage');
  }
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\.|^web\./, '');
  if (u.protocol !== 'https:' || !FB_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    throw new SiteModeError('Facebook link must start with https:// and point to facebook.com or m.me.');
  }
  return tidyFacebookUrl(u.toString());
}

// Build the value to store from what the settings page sent, keeping
// the existing PIN unless a new one is given or removal was asked for.
function normalizeSiteMode(value, existing) {
  const v = value || {};
  const prev = existing || {};
  const out = {
    enabled: v.enabled === true,
    variant: VARIANTS.includes(v.variant) ? v.variant : 'coming_soon',
    message: String(v.message || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    facebook_url: cleanFacebookUrl(v.facebook_url),
  };
  const newPin = typeof v.pin === 'string' ? v.pin.trim() : '';
  if (newPin) {
    if (newPin.length < 4 || newPin.length > 12) {
      throw new SiteModeError('Preview PIN must be 4 to 12 characters.');
    }
    const { hash, salt } = hashPassword(newPin);
    out.pin_hash = hash;
    out.pin_salt = salt;
  } else if (!v.clear_pin && prev.pin_hash && prev.pin_salt) {
    out.pin_hash = prev.pin_hash;
    out.pin_salt = prev.pin_salt;
  }
  return out;
}

// What staff screens may see: everything except the PIN hash.
function redactSiteMode(value) {
  if (!value || typeof value !== 'object') return value;
  const { pin_hash, pin_salt, ...rest } = value;
  return { ...rest, pin_set: !!(pin_hash && pin_salt) };
}

// What anyone on the internet may see.
function publicSiteMode(value) {
  const v = value || {};
  return {
    mode: v.enabled ? (VARIANTS.includes(v.variant) ? v.variant : 'coming_soon') : 'live',
    message: v.message || '',
    facebook_url: tidyFacebookUrl(v.facebook_url) || DEFAULT_FACEBOOK_URL,
    pin_set: !!(v.pin_hash && v.pin_salt),
  };
}

function checkPreviewPin(value, pin) {
  const v = value || {};
  const candidate = String(pin || '').trim();
  if (!candidate || !v.pin_hash || !v.pin_salt) return false;
  try { return verifyPassword(candidate, v.pin_hash, v.pin_salt); } catch (e) { return false; }
}

module.exports = { tidyFacebookUrl, DEFAULT_FACEBOOK_URL, normalizeSiteMode, redactSiteMode, publicSiteMode, checkPreviewPin, SiteModeError };
