// Optometrists shown on the home page ("Meet our optometrists").
//
// Two app_settings rows:
//   optometrists        { entries: [{ id, name, title, license, bio, active, photo_v }] }
//   optometrist_photos  { <id>: "data:image/jpeg;base64,..." }
//
// Photos live in their own row so the regular settings load (and every
// staff page that reads settings) never downloads them. The home page
// gets each photo from /api/settings?view=team_photo&id=..&v=.. where v
// is a short hash of the image, so browsers can cache it for a year and
// a re-upload shows immediately.

const crypto = require('crypto');

const MAX_ENTRIES = 24;
const GROUPS = ['optometrist', 'staff', 'tech'];
function cleanGroup(g) { return GROUPS.includes(g) ? g : 'optometrist'; }
const MAX_PHOTO_CHARS = 700000; // ~500 KB image; the settings page sends ~100 KB
const PHOTO_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;

class TeamError extends Error {}

function clean(s, n) {
  return String(s == null ? '' : s).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
}
function hash(s) {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);
}

// value: what the settings page sent. Entries may carry photo_data (a
// new image) or remove_photo: true; otherwise the stored photo is kept.
function buildTeam(value, prevMeta, prevPhotos) {
  const list = Array.isArray(value && value.entries) ? value.entries : [];
  if (list.length > MAX_ENTRIES) throw new TeamError(`You can list up to ${MAX_ENTRIES} people.`);
  const prevById = {};
  ((prevMeta && prevMeta.entries) || []).forEach(e => { if (e && e.id) prevById[e.id] = e; });
  const oldPhotos = prevPhotos || {};
  const photos = {};
  const seen = new Set();
  const entries = list.map((e) => {
    e = e || {};
    let id = typeof e.id === 'string' && /^[a-z0-9]{6,24}$/.test(e.id) ? e.id : '';
    if (!id || seen.has(id)) id = crypto.randomBytes(6).toString('hex');
    seen.add(id);
    const name = clean(e.name, 80);
    if (!name) throw new TeamError('Everyone listed needs a name.');
    const out = {
      id,
      name,
      group: cleanGroup(e.group),
      title: clean(e.title, 80),
      license: clean(e.license, 40),
      bio: String(e.bio == null ? '' : e.bio).replace(/\r/g, '').trim().slice(0, 900),
      active: e.active !== false,
      photo_v: '',
    };
    if (typeof e.photo_data === 'string' && e.photo_data) {
      if (e.photo_data.length > MAX_PHOTO_CHARS || !PHOTO_RE.test(e.photo_data)) {
        throw new TeamError(`The photo for ${name} must be a JPEG, PNG or WebP under 500 KB.`);
      }
      photos[id] = e.photo_data;
      out.photo_v = hash(e.photo_data);
    } else if (!e.remove_photo && oldPhotos[id]) {
      photos[id] = oldPhotos[id];
      out.photo_v = (prevById[id] && prevById[id].photo_v) || hash(oldPhotos[id]);
    }
    return out;
  });
  return { meta: { entries }, photos };
}

function photoUrl(e) {
  return e.photo_v ? `/api/settings?view=team_photo&id=${encodeURIComponent(e.id)}&v=${e.photo_v}` : '';
}

// Settings page: every entry, with a link to its stored photo.
function adminTeam(meta) {
  return { entries: ((meta && meta.entries) || []).map(e => ({ ...e, group: cleanGroup(e.group), photo_url: photoUrl(e) })) };
}

// Home page: visible entries only, public fields only.
function publicTeam(meta) {
  // Grouped Optometrists -> Staff -> Technicians; order within a group is
  // the saved list order (Array.sort is stable). Older entries have no
  // group and count as optometrists.
  return ((meta && meta.entries) || [])
    .filter(e => e && e.active !== false && e.name)
    .map(e => ({ ...e, group: cleanGroup(e.group) }))
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group))
    .map(e => ({ id: e.id, group: e.group, name: e.name, title: e.title || '', license: e.license || '', bio: e.bio || '', photo_url: photoUrl(e) }));
}

function decodePhoto(dataUrl) {
  const m = PHOTO_RE.exec(String(dataUrl || ''));
  if (!m) return null;
  return { type: m[1], buf: Buffer.from(m[2], 'base64') };
}

module.exports = { buildTeam, adminTeam, publicTeam, decodePhoto, TeamError };
