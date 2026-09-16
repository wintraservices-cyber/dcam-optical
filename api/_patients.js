// Shared patient identity logic. Both the intake API and the orders API
// call findOrCreatePatient() so a person's intake requests and order
// history end up linked under the same patient record over time.
//
// Matching is by phone number only (per the agreed approach) -- simplest
// reliable signal available without a login system or patient ID.

const { supabaseRequest } = require('./_supabase');

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  // Strip everything except digits and a leading +, so "0917 123 4567",
  // "0917-123-4567", and "+63 917 123 4567" entered inconsistently by
  // different staff/patients still match as the same number where
  // possible. This is intentionally simple -- not full E.164 normalization.
  return phone.trim().replace(/[^\d+]/g, '');
}

// Finds an existing patient by phone, or creates one. If found and the
// name or email differs from what's on file, updates the record with
// the latest values (people's stored name may have been a typo, or
// they use a different email each time -- last submission wins).
//
// Returns the patient row (with id), or null if phone is missing/invalid
// (some historical orders may have no phone on file -- those simply
// don't get linked, which is fine; patient_id stays null).
async function findOrCreatePatient({ phone, name, email }) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) return null;

  const trimmedName = (name || '').trim();
  const trimmedEmail = (email || '').trim() || null;

  // Look up existing patient by phone.
  const lookupResp = await supabaseRequest(
    `patients?phone=eq.${encodeURIComponent(normalizedPhone)}&limit=1`,
    { method: 'GET' }
  );
  if (!lookupResp.ok) {
    const errText = await lookupResp.text();
    throw new Error(`Patient lookup failed: ${lookupResp.status} ${errText}`);
  }
  const existing = await lookupResp.json();

  if (existing.length > 0) {
    const patient = existing[0];
    const needsUpdate =
      (trimmedName && trimmedName !== patient.name) ||
      (trimmedEmail && trimmedEmail !== patient.email);

    if (needsUpdate) {
      const updateResp = await supabaseRequest(
        `patients?id=eq.${encodeURIComponent(patient.id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            name: trimmedName || patient.name,
            email: trimmedEmail || patient.email,
            updated_at: new Date().toISOString(),
          }),
        }
      );
      if (updateResp.ok) {
        const [updated] = await updateResp.json();
        return updated;
      }
      // If the update fails for some reason, fall back to the existing
      // record rather than blocking the whole save.
      return patient;
    }
    return patient;
  }

  // No existing patient -- create one.
  const createResp = await supabaseRequest('patients', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      phone: normalizedPhone,
      name: trimmedName || 'Unknown',
      email: trimmedEmail,
    }),
  });
  if (!createResp.ok) {
    const errText = await createResp.text();
    throw new Error(`Patient creation failed: ${createResp.status} ${errText}`);
  }
  const [created] = await createResp.json();
  return created;
}

module.exports = { findOrCreatePatient, normalizePhone };
