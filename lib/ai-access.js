// AI access controls, stored in app_settings under the key "ai_access"
// and edited by admins in Staff -> Settings -> AI assistant.
//
// Shape:
// {
//   enabled: bool,                                   // ALL AI features (kill switch)
//   test_mode: bool,                                 // free sample replies, no API calls
//   public: { enabled: bool, stock: bool },          // website chat
//   staff:  {
//     enabled: bool,                                   // staff chat bubble
//     areas: { <area>: { admin: bool, staff: bool } }  // what it may look up, per role
//   }
// }
//
// Everything is normalized against DEFAULTS, so a missing or partial
// setting (first deploy, older saved value) always resolves to a safe,
// complete object. Patient data is OFF by default.

const { supabaseRequest } = require('./supabase');

const AREAS = {
  orders: {
    label: 'Orders',
    help: 'Order numbers, status (ordered / ready / claimed), due dates, items and totals. Shows the patient name on each order, but not phone numbers or Rx values.',
  },
  balances: {
    label: 'Balances & payments',
    help: 'Unpaid and partial orders, remaining balances, and balance payments logged.',
  },
  stock: {
    label: 'Inventory / stock',
    help: 'Frames and lenses in the catalog with quantities and sale prices. Admins also see base (cost) price.',
  },
  sales: {
    label: 'Sales & revenue',
    help: 'Money collected in a date range (deposits + balance payments), split by cash and GCash/card.',
  },
  patients: {
    label: 'Patient records',
    help: 'Patient name and phone lookups, visit history and Rx values. This sends patient data to the AI provider to answer — disclose to patients before enabling.',
  },
  howto: {
    label: 'How-to help',
    help: 'Explains how to use the staff system (orders, payments, catalog, reports). No data is looked up.',
  },
};

const DEFAULTS = {
  enabled: true,
  test_mode: false,
  public: { enabled: true, stock: true },
  staff: {
    enabled: true,
    areas: {
      orders:   { admin: true,  staff: true },
      balances: { admin: true,  staff: true },
      stock:    { admin: true,  staff: true },
      sales:    { admin: true,  staff: false },
      patients: { admin: false, staff: false },
      howto:    { admin: true,  staff: true },
    },
  },
};

function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

function normalizeAiAccess(value) {
  const v = value && typeof value === 'object' ? value : {};
  const pub = v.public && typeof v.public === 'object' ? v.public : {};
  const staff = v.staff && typeof v.staff === 'object' ? v.staff : {};
  const areasIn = staff.areas && typeof staff.areas === 'object' ? staff.areas : {};

  const areas = {};
  Object.keys(AREAS).forEach(key => {
    const a = areasIn[key] && typeof areasIn[key] === 'object' ? areasIn[key] : {};
    areas[key] = {
      admin: bool(a.admin, DEFAULTS.staff.areas[key].admin),
      staff: bool(a.staff, DEFAULTS.staff.areas[key].staff),
    };
  });

  const master = bool(v.enabled, DEFAULTS.enabled);
  return {
    enabled: master,
    test_mode: bool(v.test_mode, DEFAULTS.test_mode),
    public: {
      enabled: bool(pub.enabled, DEFAULTS.public.enabled),
      stock: bool(pub.stock, DEFAULTS.public.stock),
    },
    staff: {
      enabled: bool(staff.enabled, DEFAULTS.staff.enabled),
      areas,
    },
  };
}

// Areas the given role may use right now (empty if staff AI is off).
function allowedAreas(access, role) {
  if (!access.enabled || !access.staff.enabled) return [];
  const r = role === 'admin' ? 'admin' : 'staff';
  return Object.keys(AREAS).filter(key => access.staff.areas[key][r]);
}

// Reads the saved setting fresh (no cache) so an admin switching
// something off takes effect on the very next message.
async function loadAiAccess() {
  try {
    const resp = await supabaseRequest('app_settings?key=eq.ai_access&select=value&limit=1', { method: 'GET' });
    if (!resp.ok) return normalizeAiAccess(null);
    const rows = await resp.json();
    return normalizeAiAccess(rows[0] && rows[0].value);
  } catch (e) {
    console.error('ai-access: could not load setting', e.message);
    return normalizeAiAccess(null);
  }
}

// Website chat is live only when both the master and its own switch are on.
function publicChatOn(access) {
  return access.enabled && access.public.enabled;
}

module.exports = { publicChatOn, AREAS, DEFAULTS, normalizeAiAccess, allowedAreas, loadAiAccess };
