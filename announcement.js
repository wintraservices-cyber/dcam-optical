// DCAM Optical -- announcement pop-up for the public home page.
// Include at the end of the page:  <script src="announcement.js" defer></script>
//
// Asks GET /api/settings?view=announcement. When Settings -> Website ->
// Announcement pop-up is on and today is inside its start/end window, the
// image opens in a pop-up a moment after the page loads. How often a
// visitor sees it again is the "How often" choice in Settings.
// If the check fails or the image will not load, nothing is shown.
//
// The settings page reuses the same pop-up for its Preview button:
//   window.DCAM_ANNOUNCE_MANUAL = true  (before loading this file) stops
//   the automatic check, and DCAMAnnouncement.show({...}) opens it.
(function () {
  var STYLE_ID = 'dcam-announce-style';
  var open = null; // the pop-up currently on screen

  function css() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent =
      '.dcam-ann{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;' +
      'padding:16px;background:rgba(56,51,52,.72);opacity:0;transition:opacity .25s ease}' +
      '.dcam-ann.on{opacity:1}' +
      '.dcam-ann-card{position:relative;max-width:min(92vw,520px);max-height:92vh;display:flex;flex-direction:column;' +
      'align-items:center;gap:10px;transform:translateY(14px) scale(.98);transition:transform .25s ease}' +
      '.dcam-ann.on .dcam-ann-card{transform:none}' +
      '.dcam-ann-img{display:block;max-width:100%;max-height:calc(92vh - 56px);width:auto;height:auto;' +
      'border-radius:14px;background:#383334;box-shadow:0 18px 50px rgba(0,0,0,.45)}' +
      '.dcam-ann a.dcam-ann-link{display:block;line-height:0;border-radius:14px}' +
      '.dcam-ann-close{align-self:flex-end;display:inline-flex;align-items:center;gap:8px;min-height:44px;' +
      'padding:0 18px;border:none;border-radius:999px;background:#F7F1E8;color:#383334;cursor:pointer;' +
      'font:600 14px Sora,system-ui,sans-serif;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
      '.dcam-ann-close:hover{background:#fff}' +
      '.dcam-ann-close:focus-visible,.dcam-ann a:focus-visible{outline:3px solid #5BAFC0;outline-offset:2px}' +
      '@media (prefers-reduced-motion:reduce){.dcam-ann,.dcam-ann-card{transition:none}}';
    document.head.appendChild(st);
  }

  function close() {
    if (!open) return;
    var o = open; open = null;
    document.removeEventListener('keydown', o.onKey, true);
    o.root.classList.remove('on');
    setTimeout(function () { if (o.root.parentNode) o.root.parentNode.removeChild(o.root); }, 250);
    if (o.opener && o.opener.focus) { try { o.opener.focus(); } catch (e) {} }
    if (o.onClose) o.onClose();
  }

  function show(a) {
    if (open || !a || !a.image_url) return;
    css();
    var root = document.createElement('div');
    root.className = 'dcam-ann';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', a.alt || 'Announcement');

    var card = document.createElement('div');
    card.className = 'dcam-ann-card';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dcam-ann-close';
    btn.textContent = 'Close';
    btn.setAttribute('aria-label', 'Close announcement');

    var img = document.createElement('img');
    img.className = 'dcam-ann-img';
    img.src = a.image_url;
    img.alt = a.alt || 'Announcement from DCAM Optical';
    img.decoding = 'async';

    var picture = img;
    if (a.link_url) {
      var link = document.createElement('a');
      link.className = 'dcam-ann-link';
      link.href = a.link_url;
      if (/^https?:/i.test(a.link_url)) { link.target = '_blank'; link.rel = 'noopener'; }
      link.addEventListener('click', function () { if (!a.preview) close(); });
      link.appendChild(img);
      picture = link;
    }
    card.appendChild(btn);
    card.appendChild(picture);
    root.appendChild(card);

    var state = {
      root: root,
      opener: document.activeElement,
      onClose: a.onClose,
      onKey: function (e) {
        if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
        if (e.key !== 'Tab') return;
        var items = root.querySelectorAll('button, a[href]');
        if (!items.length) return;
        var first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    open = state;
    btn.addEventListener('click', close);
    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    document.addEventListener('keydown', state.onKey, true);
    document.body.appendChild(root);
    requestAnimationFrame(function () { root.classList.add('on'); btn.focus(); });
  }

  window.DCAMAnnouncement = { show: show, close: close };
  if (window.DCAM_ANNOUNCE_MANUAL) return;

  // ---- automatic: only once the visitor has been here a moment ----
  function manilaDay() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }
  function seenBefore(a) {
    var key = 'dcam_announce_' + a.id;
    try {
      if (a.frequency === 'session') return sessionStorage.getItem(key) === '1';
      var v = localStorage.getItem(key);
      if (!v) return false;
      return a.frequency === 'once' ? true : v === manilaDay();
    } catch (e) { return false; }
  }
  function markSeen(a) {
    var key = 'dcam_announce_' + a.id;
    try {
      if (a.frequency === 'session') sessionStorage.setItem(key, '1');
      else localStorage.setItem(key, a.frequency === 'once' ? '1' : manilaDay());
    } catch (e) {}
  }

  function start() {
    fetch('/api/settings?view=announcement')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var a = d && d.announcement;
        if (!a || !a.id || !a.image_url || seenBefore(a)) return;
        var pre = new Image();
        pre.onload = function () {
          setTimeout(function () {
            if (document.visibilityState === 'hidden') return;
            markSeen(a);
            show(a);
          }, 1200);
        };
        pre.src = a.image_url;
      })
      .catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
