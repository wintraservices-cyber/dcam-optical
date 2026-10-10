// Patient opt-ins for reminders / offers (kept on the patient record).
// Nothing is sent from this yet -- these flags are what the future SMS /
// email notifications will check before messaging anyone.
//
//   notify_reminders  eye-exam recalls, "your glasses are ready", etc.
//   notify_promos     offers and news
//   notify_sms / notify_email   which channels they agreed to
//   notify_consent_at / notify_consent_source   when and where they said yes
//
// Consent is separate from the consent to process data for an appointment,
// and is always opt-in: unticked means no. A form that arrives with nothing
// ticked never changes an existing patient's choice (only staff or the
// patient ticking something does).

const { supabaseRequest } = require('./supabase');

const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1' || v === 'on';

// Reads the four flags from a request body (camelCase from the public form).
// Returns null when the person opted in to nothing usable.
function readOptIn(body) {
  if (!body || typeof body !== 'object') return null;
  const reminders = truthy(body.notifyReminders);
  const promos = truthy(body.notifyPromos);
  const sms = truthy(body.notifySms);
  const email = truthy(body.notifyEmail);
  if (!(reminders || promos)) return null;
  if (!(sms || email)) return null; // a topic with no way to reach them = not opted in
  return { reminders, promos, sms, email };
}

// Best-effort save: never breaks the form if the migration hasn't been run.
async function savePrefs(patientId, prefs, source) {
  if (!patientId || !prefs) return false;
  try {
    const resp = await supabaseRequest(`patients?id=eq.${encodeURIComponent(patientId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        notify_reminders: !!prefs.reminders,
        notify_promos: !!prefs.promos,
        notify_sms: !!prefs.sms,
        notify_email: !!prefs.email,
        notify_consent_at: new Date().toISOString(),
        notify_consent_source: source || null,
      }),
    });
    return resp.ok;
  } catch (e) {
    return false;
  }
}

function describe(prefs) {
  if (!prefs) return 'No';
  const what = [prefs.reminders && 'reminders', prefs.promos && 'offers & news'].filter(Boolean).join(' + ');
  const how = [prefs.sms && 'SMS', prefs.email && 'email'].filter(Boolean).join(' + ');
  return `${what} by ${how}`;
}

module.exports = { readOptIn, savePrefs, describe, truthy };
