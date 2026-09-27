// DCAM Optical — staff assistant chat bubble.
// Included on staff pages with: <script src="staff-assistant.js" defer></script>
// Asks /api/chat?mode=staff what this user may use; shows nothing at all if
// the assistant is off (or the user isn't logged in). Read-only by design.
(function () {
  if (window.__dcamStaffAssistant) return;
  window.__dcamStaffAssistant = true;

  const SUGGESTIONS = {
    orders: ['Which orders are ready for claim?', 'Orders due today'],
    balances: ['Who has a balance still owing?'],
    stock: ['Which frames are low on stock?'],
    sales: ["How much did we collect today?"],
    patients: ["Look up a patient's last Rx"],
    howto: ['How do I log a balance payment?'],
  };

  const css = `
  .dsa-fab{position:fixed;right:20px;bottom:20px;z-index:9998;width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;
    background:#B05A9E;color:#fff;box-shadow:0 6px 20px rgba(56,51,52,.28);display:flex;align-items:center;justify-content:center;transition:transform .15s,background .15s}
  .dsa-fab:hover{background:#8F4680;transform:translateY(-1px)}
  .dsa-fab:focus-visible{outline:3px solid #5BAFC0;outline-offset:3px}
  .dsa-panel{position:fixed;right:20px;bottom:88px;z-index:9999;width:380px;max-width:calc(100vw - 32px);height:540px;max-height:calc(100vh - 120px);
    background:#F7F1E8;border:1px solid rgba(56,51,52,.14);border-radius:18px;box-shadow:0 16px 48px rgba(56,51,52,.25);
    display:none;flex-direction:column;overflow:hidden;font-family:'Sora',sans-serif;color:#383334}
  .dsa-panel.open{display:flex}
  .dsa-head{background:#383334;color:#F7F1E8;padding:14px 16px;display:flex;align-items:center;gap:10px}
  .dsa-head .dsa-dot{width:8px;height:8px;border-radius:50%;background:#5BAFC0;flex-shrink:0}
  .dsa-head .dsa-title{font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:.92rem;flex:1}
  .dsa-head .dsa-sub{font-size:.68rem;opacity:.65;text-transform:uppercase;letter-spacing:.06em}
  .dsa-close{background:transparent;border:none;color:#F7F1E8;cursor:pointer;font-size:1.3rem;line-height:1;padding:2px 6px;border-radius:6px;opacity:.8}
  .dsa-close:hover{opacity:1;background:rgba(247,241,232,.12)}
  .dsa-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .dsa-msg{max-width:88%;padding:10px 13px;border-radius:14px;font-size:.86rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
  .dsa-msg.bot{background:#fff;border:1px solid rgba(56,51,52,.1);align-self:flex-start;border-bottom-left-radius:4px}
  .dsa-msg.user{background:#B05A9E;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .dsa-msg.thinking{opacity:.55;font-style:italic}
  .dsa-msg.err{background:rgba(176,64,90,.08);border-color:rgba(176,64,90,.25);color:#8a2f45}
  .dsa-meta{font-size:.68rem;color:#4A4547;opacity:.7;align-self:flex-start;margin-top:-4px}
  .dsa-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 10px}
  .dsa-chip{font-family:inherit;font-size:.74rem;background:#fff;border:1px solid rgba(56,51,52,.18);color:#383334;padding:6px 11px;border-radius:100px;cursor:pointer}
  .dsa-chip:hover{border-color:#B05A9E}
  .dsa-input{border-top:1px solid rgba(56,51,52,.12);padding:12px;display:flex;gap:8px;background:#fff}
  .dsa-input textarea{flex:1;resize:none;border:1.5px solid rgba(56,51,52,.16);border-radius:12px;padding:9px 12px;font-family:inherit;font-size:.86rem;color:#383334;height:42px;max-height:110px;outline:none}
  .dsa-input textarea:focus{border-color:#5BAFC0}
  .dsa-send{width:42px;height:42px;border-radius:50%;border:none;background:#383334;color:#F7F1E8;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .dsa-send:disabled{opacity:.4;cursor:default}
  .dsa-foot{font-size:.66rem;color:#4A4547;opacity:.7;text-align:center;padding:0 12px 10px;background:#fff}
  @media (max-width:480px){.dsa-panel{right:8px;left:8px;width:auto;max-width:none;bottom:84px;height:calc(100vh - 110px)}.dsa-fab{right:14px;bottom:14px}}
  @media print{.dsa-fab,.dsa-panel{display:none!important}}`;

  const LOOKUP_LABELS = {
    search_orders: 'orders', balances_overview: 'balances', get_stock: 'stock',
    sales_summary: 'sales', find_patient: 'patients',
  };

  let turns = [];
  let busy = false;
  let els = {};

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function addMsg(text, cls) {
    const m = el('div', 'dsa-msg ' + cls, text);
    els.body.appendChild(m);
    els.body.scrollTop = els.body.scrollHeight;
    return m;
  }

  function build(areas) {
    const style = el('style');
    style.textContent = css;
    document.head.appendChild(style);

    const fab = el('button', 'dsa-fab');
    fab.type = 'button';
    fab.setAttribute('aria-label', 'Open staff assistant');
    fab.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>';

    const panel = el('div', 'dsa-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Staff assistant');

    const head = el('div', 'dsa-head');
    head.appendChild(el('div', 'dsa-dot'));
    const titleWrap = el('div', 'dsa-title');
    titleWrap.appendChild(el('div', null, 'Staff assistant'));
    titleWrap.appendChild(el('div', 'dsa-sub', 'Read-only · DCAM Optical'));
    head.appendChild(titleWrap);
    const close = el('button', 'dsa-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    head.appendChild(close);

    const body = el('div', 'dsa-body');
    const chips = el('div', 'dsa-chips');
    areas.forEach(a => (SUGGESTIONS[a] || []).forEach(q => {
      const c = el('button', 'dsa-chip', q);
      c.type = 'button';
      c.dataset.q = q;
      chips.appendChild(c);
    }));

    const inputRow = el('div', 'dsa-input');
    const ta = el('textarea');
    ta.placeholder = 'Ask about orders, balances, stock…';
    ta.rows = 1;
    const send = el('button', 'dsa-send');
    send.type = 'button';
    send.setAttribute('aria-label', 'Send');
    send.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    inputRow.appendChild(ta);
    inputRow.appendChild(send);

    const foot = el('div', 'dsa-foot', 'Answers come from live records — double-check before acting on money or Rx.');

    panel.appendChild(head);
    panel.appendChild(body);
    panel.appendChild(chips);
    panel.appendChild(inputRow);
    panel.appendChild(foot);
    document.body.appendChild(panel);
    document.body.appendChild(fab);

    els = { fab, panel, body, chips, ta, send };

    addMsg("Hi! Ask me about today's work — I can only look things up, not change them.", 'bot');

    fab.addEventListener('click', () => {
      const open = !panel.classList.contains('open');
      panel.classList.toggle('open', open);
      if (open) ta.focus();
    });
    close.addEventListener('click', () => { panel.classList.remove('open'); fab.focus(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) panel.classList.remove('open'); });
    send.addEventListener('click', () => ask(ta.value));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(ta.value); }
    });
    ta.addEventListener('input', () => { ta.style.height = '42px'; ta.style.height = Math.min(ta.scrollHeight, 110) + 'px'; });
    chips.addEventListener('click', e => {
      const b = e.target.closest('.dsa-chip');
      if (b) ask(b.dataset.q);
    });
  }

  async function ask(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    busy = true;
    els.ta.value = '';
    els.ta.style.height = '42px';
    els.send.disabled = true;
    els.chips.style.display = 'none';
    addMsg(text, 'user');
    turns.push({ role: 'user', content: text });
    const thinking = addMsg('Looking that up…', 'bot thinking');

    try {
      const resp = await fetch('/api/chat?mode=staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ messages: turns }),
      });
      const result = await resp.json().catch(() => ({}));
      thinking.remove();
      if (resp.status === 401) {
        turns.pop();
        addMsg('Your session has ended — please log in again.', 'bot err');
        return;
      }
      if (!resp.ok || !result.ok) {
        turns.pop();
        addMsg(result.error || 'Something went wrong — please try again.', 'bot err');
        return;
      }
      addMsg(result.reply, 'bot');
      turns.push({ role: 'assistant', content: result.reply });
      const used = [...new Set((result.lookups || []).map(n => LOOKUP_LABELS[n]).filter(Boolean))];
      if (used.length) {
        const meta = el('div', 'dsa-meta', 'Checked: ' + used.join(', '));
        els.body.appendChild(meta);
        els.body.scrollTop = els.body.scrollHeight;
      }
    } catch (e) {
      thinking.remove();
      turns.pop();
      addMsg("Couldn't reach the assistant — check your connection and try again.", 'bot err');
    } finally {
      busy = false;
      els.send.disabled = false;
      els.ta.focus();
    }
  }

  async function init() {
    try {
      const resp = await fetch('/api/chat?mode=staff', { credentials: 'same-origin' });
      if (!resp.ok) return;
      const status = await resp.json();
      if (!status.ok || !status.enabled) return;
      build(status.areas || []);
      if (status.testMode) {
        const sub = document.querySelector('.dsa-sub');
        if (sub) sub.textContent = 'Test mode · keyword lookups, no AI';
        const foot = document.querySelector('.dsa-foot');
        if (foot) foot.textContent = 'Test mode — real data, simple keyword matching, no AI cost.';
      }
    } catch (e) { /* stay hidden */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
