// Remembers where a visitor came from (campaign tags or the referring
// site) so an intake form sent later can say "came from Facebook" etc.
// Kept in this browser only (localStorage, 90 days), no personal data:
// just the source name, campaign and landing page. The intake form reads
// it with window.dcamSource(). Loaded on the public pages before the
// address bar is tidied of utm_* tags.
(function () {
  var KEY = 'dcam_src', DAYS = 90;
  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && v.at && Date.now() - v.at < DAYS * 864e5) return v;
    } catch (e) {}
    return null;
  }
  try {
    var u = new URL(location.href), p = u.searchParams;
    var ref = '';
    try { if (document.referrer) { var r = new URL(document.referrer); if (r.hostname && r.hostname.replace(/^www\./, '') !== location.hostname.replace(/^www\./, '')) ref = r.hostname; } } catch (e) {}
    var src = {
      source: (p.get('utm_source') || '').slice(0, 60),
      medium: (p.get('utm_medium') || '').slice(0, 60),
      campaign: (p.get('utm_campaign') || '').slice(0, 80),
      ref: ref.slice(0, 120),
      click: p.get('fbclid') ? 'fbclid' : p.get('gclid') ? 'gclid' : '',
      landing: u.pathname.slice(0, 120),
      at: Date.now()
    };
    // Keep the most recent visit that came from somewhere (a direct visit
    // later doesn't wipe out "came from Facebook").
    if (src.source || src.ref || src.click) localStorage.setItem(KEY, JSON.stringify(src));
  } catch (e) {}
  window.dcamSource = function () {
    var v = read();
    if (!v) return null;
    return { source: v.source, medium: v.medium, campaign: v.campaign, ref: v.ref, click: v.click, landing: v.landing };
  };
})();
