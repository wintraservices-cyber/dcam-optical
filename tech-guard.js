// Tech accounts can only use Settings (AI assistant + Website). Any other
// staff page sends them straight there. The server enforces this too
// (those APIs answer 403) -- this just avoids a page full of errors.
(function () {
  fetch('/api/staff-auth', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.authenticated && d.role === 'tech') window.location.replace('staff-settings.html');
    })
    .catch(function () { /* the page's own auth check handles failures */ });
})();
