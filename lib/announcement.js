// Announcement pop-up shown on the public home page (marketing / news).
//
// Two app_settings rows, same idea as the team photos:
//   announcement        { enabled, alt, link_url, start_at, end_at, frequency, image_v }
//   announcement_image  { data: "data:image/jpeg;base64,..." }
//
// The image lives in its own row so the regular settings load never
// downloads it. The home page gets it from
// /api/settings?view=announcement_image&v=<hash>, so browsers can cache it
// for a year and a re-upload shows immediately.
//
// start_at / end_at are ISO timestamps (the settings page turns the
// Manila date + time the admin picks into one). Blank start = shows right
// away; blank end = no end.

const crypto = require('crypto');

const MAX_IMAGE_CHARS = 1200000; // ~900 KB image; the settings page sends ~300 KB
const IMAGE_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
const FREQUENCIES = ['once', 'daily', 'session'];

class AnnouncementError extends Error {}

function clean(s, n) {
  return String(s == null ? '' : s).replace(/\r/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
}
function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

function cleanTime(v, label) {
  if (v === undefined || v === null || v === '') return '';
  const ms = Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new AnnouncementError(`The ${label} date and time is not valid.`);
  return new Date(ms).toISOString();
}

// Only web addresses and on-site links; never javascript: or data: links.
function cleanLink(v) {
  const s = clean(v, 300);
  if (!s) return '';
  if (/^https:\/\/[^\s]+$/i.test(s)) return s;
  if (/^(\/|#)[^\s]*$/.test(s) && !s.startsWith('//')) return s;
  throw new AnnouncementError('The link must start with https:// or be a page on this site such as /intake or /#book.');
}

// value: what the settings page sent. May carry image_data (a new image)
// or remove_image: true; otherwise the stored image is kept.
function buildAnnouncement(value, prevMeta, prevImage) {
  const v = value || {};
  const prev = prevMeta || {};
  const out = {
    enabled: v.enabled === true,
    alt: clean(v.alt, 160),
    link_url: cleanLink(v.link_url),
    start_at: cleanTime(v.start_at, 'start'),
    end_at: cleanTime(v.end_at, 'end'),
    frequency: FREQUENCIES.includes(v.frequency) ? v.frequency : 'daily',
    image_v: '',
  };
  if (out.start_at && out.end_at && Date.parse(out.end_at) <= Date.parse(out.start_at)) {
    throw new AnnouncementError('The end date and time must be after the start.');
  }

  let image = null; // what to write to announcement_image, or null for "unchanged"
  let removeImage = false;
  if (typeof v.image_data === 'string' && v.image_data) {
    if (v.image_data.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(v.image_data)) {
      throw new AnnouncementError('The image must be a JPEG, PNG or WebP under 900 KB.');
    }
    image = { data: v.image_data };
    out.image_v = hash(v.image_data);
  } else if (!v.remove_image && prevImage && prevImage.data) {
    out.image_v = prev.image_v || hash(prevImage.data);
  } else {
    removeImage = true;
  }
  if (out.enabled && !out.image_v) {
    throw new AnnouncementError('Upload an image before turning the pop-up on.');
  }
  return { meta: out, image, removeImage };
}

function imageUrl(meta) {
  return meta && meta.image_v ? `/api/settings?view=announcement_image&v=${meta.image_v}` : '';
}

// Where "now" sits against the window: 'off' | 'scheduled' | 'live' | 'ended'.
function announcementState(meta, now) {
  if (!meta || !meta.enabled || !meta.image_v) return 'off';
  const t = now == null ? Date.now() : now;
  if (meta.start_at && t < Date.parse(meta.start_at)) return 'scheduled';
  if (meta.end_at && t >= Date.parse(meta.end_at)) return 'ended';
  return 'live';
}

// Settings page: the saved values plus a link to the stored image.
function adminAnnouncement(meta) {
  const m = meta || {};
  return {
    enabled: m.enabled === true,
    alt: m.alt || '',
    link_url: m.link_url || '',
    start_at: m.start_at || '',
    end_at: m.end_at || '',
    frequency: FREQUENCIES.includes(m.frequency) ? m.frequency : 'daily',
    image_v: m.image_v || '',
    image_url: imageUrl(m),
    state: announcementState(m),
  };
}

// Public site: only what a visitor needs, and only while it is live.
function publicAnnouncement(meta, now) {
  if (announcementState(meta, now) !== 'live') return null;
  return {
    id: meta.image_v,
    image_url: imageUrl(meta),
    alt: meta.alt || 'Announcement from DCAM Optical',
    link_url: meta.link_url || '',
    frequency: meta.frequency || 'daily',
    end_at: meta.end_at || '',
  };
}

function decodeImage(row) {
  const m = row && typeof row.data === 'string' && row.data.match(IMAGE_RE);
  return m ? { type: m[1], buf: Buffer.from(m[2], 'base64') } : null;
}

module.exports = {
  AnnouncementError, buildAnnouncement, adminAnnouncement, publicAnnouncement,
  announcementState, decodeImage, imageUrl, FREQUENCIES,
};
