// Shared validation for staff account profile fields (username, email,
// phone) -- used both by admin-side account management
// (api/staff-users.js) and by a staff member editing their own profile
// (api/staff-auth.js). Pulled out to one place so the rules (and the
// error messages shown to the person typing) can't quietly drift
// between "an admin edits someone else's account" and "I edit my own".

function sanitizeUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  // Keep usernames simple and URL/query-safe -- letters, numbers, dots,
  // underscores, hyphens.
  if (!/^[a-z0-9._-]{2,40}$/.test(trimmed)) return null;
  return trimmed;
}

// Returns { ok: true, value } with value either null (cleared) or the
// cleaned string, or { ok: false } if the field was provided but isn't
// blank and isn't valid -- lets callers tell "left alone", "cleared",
// and "invalid" apart.
function sanitizeEmail(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { ok: true, value: null };
  if (trimmed.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

function sanitizePhone(raw) {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: null };
  // Philippine mobile/landline numbers, allowing a leading + and the
  // usual spaces/dashes/parens people type them with. Not exhaustive --
  // this just filters obvious typos, not a strict carrier format.
  const digits = trimmed.replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(digits)) return { ok: false };
  return { ok: true, value: trimmed };
}

// Supabase/Postgres reports a unique-index violation as error code 23505.
// staff_users has partial unique indexes on lower(email) and phone (see
// supabase-schema.sql), so a duplicate here means "some other account
// already uses that email/phone", not a database problem.
function isUniqueViolation(errText) {
  return typeof errText === 'string' && errText.includes('23505');
}

module.exports = { sanitizeUsername, sanitizeEmail, sanitizePhone, isUniqueViolation };
