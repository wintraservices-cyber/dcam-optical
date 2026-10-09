// Adds an eye / closed-eyelid button to every password box so people can check what
// they typed. Purely a display toggle -- nothing is stored or sent.
(function () {
  function enhance(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    var wrap = document.createElement('span');
    wrap.style.cssText = 'position:relative;display:block;width:100%;';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.paddingRight = '42px';
    input.style.boxSizing = 'border-box';
    var OPEN = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/></svg>';
    // Closed eyelid: a downward curve with lashes.
    var CLOSED = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 9.5c2.2 3.6 5.6 5.5 9.5 5.5s7.3-1.9 9.5-5.5"/><path d="M6 13.4 4.2 16M10 15 9.3 18M14 15l.7 3M18 13.4l1.8 2.6"/></svg>';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = CLOSED;
    btn.setAttribute('aria-label', 'Show password');
    btn.setAttribute('title', 'Show password');
    // !important so page-level `button { ... }` rules (full-width, filled) can't override.
    ['position:absolute','right:8px','left:auto','width:auto','height:auto','margin:0','padding:4px 6px','background:none','border:0','box-shadow:none','line-height:0','color:#8A3F7B','cursor:pointer','border-radius:6px','transition:opacity .15s'].forEach(function (d) {
      var i = d.indexOf(':'); btn.style.setProperty(d.slice(0, i), d.slice(i + 1), 'important');
    });
    // Center on the input itself (the wrapper can include the input's bottom margin).
    function place() { btn.style.setProperty('top', (input.offsetTop + input.offsetHeight / 2) + 'px', 'important'); btn.style.setProperty('transform', 'translateY(-50%)', 'important'); }
    place(); window.addEventListener('load', place); window.addEventListener('resize', place);
    if (window.ResizeObserver) new ResizeObserver(place).observe(input); // fires when a hidden tab becomes visible
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.style.setProperty('opacity', '0.3', 'important');
      setTimeout(function () { btn.innerHTML = show ? OPEN : CLOSED; btn.style.setProperty('opacity', '1', 'important'); }, 90);
      var label = show ? 'Hide password' : 'Show password';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
    });
    wrap.appendChild(btn);
  }
  function run() { document.querySelectorAll('input[type="password"]').forEach(enhance); }
  // Pages that build their forms later (profile) get covered too.
  if (window.MutationObserver) new MutationObserver(function () { run(); }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
