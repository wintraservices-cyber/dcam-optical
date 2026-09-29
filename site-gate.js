// DCAM Optical — Coming Soon / Maintenance gate for public pages.
// Include as the FIRST script in <head>:  <script src="site-gate.js"></script>
//
// Asks GET /api/settings?view=site_mode whether the site is live. If
// Settings -> Website has Coming Soon or Maintenance switched on, the
// visitor is sent to /coming-soon. Someone who entered the preview PIN
// on that page keeps seeing the real site (with a small "Preview" pill
// to leave). If the check fails or is slow, the page just shows —
// the site never gets stuck behind the gate.
(function () {
  var KEY = 'dcam_site_preview';
  var de = document.documentElement;
  var previewing = false;
  try { previewing = localStorage.getItem(KEY) === '1'; } catch (e) {}

  var shown = false;
  function show() { if (shown) return; shown = true; de.style.visibility = ''; }
  if (!previewing) { de.style.visibility = 'hidden'; setTimeout(show, 2500); }

  function previewPill() {
    var add = function () {
      var b = document.createElement('div');
      b.setAttribute('role', 'status');
      b.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:10000;display:flex;align-items:center;gap:10px;' +
        'background:#383334;color:#F7F1E8;border-radius:999px;padding:8px 8px 8px 14px;font:600 13px Sora,system-ui,sans-serif;' +
        'box-shadow:0 8px 24px rgba(0,0,0,.25)';
      b.innerHTML = 'Preview — visitors see the Coming Soon page';
      var x = document.createElement('button');
      x.type = 'button';
      x.textContent = 'Exit preview';
      x.style.cssText = 'border:none;border-radius:999px;background:#B05A9E;color:#fff;font:600 12px Sora,system-ui,sans-serif;padding:7px 12px;cursor:pointer';
      x.onclick = function () { try { localStorage.removeItem(KEY); } catch (e) {} location.href = '/coming-soon'; };
      b.appendChild(x);
      document.body.appendChild(b);
    };
    if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  }

  fetch('/api/settings?view=site_mode')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      var gated = d && d.ok && d.mode && d.mode !== 'live';
      if (!gated) {
        if (previewing) { try { localStorage.removeItem(KEY); } catch (e) {} }
        show();
        return;
      }
      if (previewing) { previewPill(); return; }
      location.replace('/coming-soon');
    })
    .catch(show);
})();
