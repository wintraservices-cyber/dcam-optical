// Adds a Show/Hide button to every password box so people can check what
// they typed. Purely a display toggle -- nothing is stored or sent.
(function () {
  function enhance(input) {
    if (input.dataset.pwToggle) return;
    input.dataset.pwToggle = '1';
    var wrap = document.createElement('span');
    wrap.style.cssText = 'position:relative;display:block;width:100%;';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.paddingRight = '64px';
    input.style.boxSizing = 'border-box';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Show';
    btn.setAttribute('aria-label', 'Show password');
    btn.style.cssText = 'position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;padding:4px 8px;font:inherit;font-size:12px;font-weight:600;color:#8A3F7B;cursor:pointer;';
    btn.addEventListener('click', function () {
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? 'Hide' : 'Show';
      btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(btn);
  }
  function run() { document.querySelectorAll('input[type="password"]').forEach(enhance); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
