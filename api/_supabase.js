// Shared Supabase client for serverless functions.
// Uses the SERVICE ROLE key (server-side only — never expose this to the browser)
// so these functions can bypass row-level security intentionally, since access
// control is handled by our own session-cookie check instead.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function assertConfigured() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase environment variables are not configured (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).');
  }
}

// Minimal REST wrapper around Supabase's PostgREST API — avoids needing the
// full @supabase/supabase-js package as a dependency for such a small surface.
async function supabaseRequest(path, options = {}) {
  assertConfigured();
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const resp = await fetch(url, {
    ...options,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return resp;
}

module.exports = { supabaseRequest, assertConfigured };
