// Mirrors the Reports / Catalog / New order staff permissions on screen.
// The server enforces them (403); this hides the links and replaces a closed
// page with a short message so staff do not hit a page full of errors.
// Admins are never restricted. Opening a saved order (order-form.html?id=...)
// is governed by the other order permissions, not by "Create new orders".
(function () {
  var PAGES = {
    'staff-reports.html': 'view_reports',
    'staff-catalog.html': 'view_catalog',
    'order-form.html': 'create_orders'
  };
  var here = location.pathname.split('/').pop().replace(/^$/, 'index') ;
  if (!/\.html$/.test(here)) here += '.html';
  function run(role, perms) {
    if (role === 'admin') return;
    Object.keys(PAGES).forEach(function (page) {
      if (perms[PAGES[page]] !== false) return;
      document.querySelectorAll('a[href="' + page + '"]').forEach(function (a) { a.remove(); });
    });
    var key = PAGES[here];
    if (!key || perms[key] !== false) return;
    if (here === 'order-form.html' && new URLSearchParams(location.search).get('id')) return;
    document.body.innerHTML = '<div style="max-width:460px;margin:20vh auto;padding:0 20px;font-family:system-ui,sans-serif;text-align:center">' +
      '<h2>Not available for your account</h2><p>An admin has turned this page off for staff. ' +
      'Ask an admin if you need it.</p><p><a href="staff-dashboard.html">Back to the dashboard</a></p></div>';
  }
  Promise.all([
    fetch('/api/staff-auth', { credentials: 'same-origin' }).then(function (r) { return r.json(); }),
    fetch('/api/settings?view=permissions', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
  ]).then(function (v) {
    if (!v[0] || !v[0].authenticated || !v[1] || !v[1].ok) return;
    var go = function () { run(v[0].role, v[1].permissions || {}); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }).catch(function () { /* the server still enforces */ });
})();
