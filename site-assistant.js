// DCAM Optical — customer-facing chat assistant.
// Include on public pages with: <script src="site-assistant.js" defer></script>
//
// - Adds a floating chat bubble (bottom-right) on every page it's on.
// - On the homepage it ALSO drives the inline "Ask us anything" panel
//   (#chatBody / #chatInput / #chatSend / #chatChips) — one shared
//   conversation, shown in both places, so visitors never get two chats.
// - Asks GET /api/chat whether the website chat is switched on
//   (Settings -> AI assistant). If it's off, the bubble isn't shown and
//   the homepage "Ask us anything" section and its nav links are hidden.
(function () {
  if (window.__dcamSiteAssistant) return;
  window.__dcamSiteAssistant = true;

  const BOOK_MARKER = '[[BOOK]]';
  const BOOK_URL = 'intake.html';
  const SUGGESTIONS = [
    ['Do you take HMO / insurance?', 'Do you take insurance?'],
    ['First exam — what to expect?', 'What happens at a first eye exam?'],
    ["What are your hours?", 'What are your hours and where are you located?'],
  ];
  const GREETING = "Hi! I'm the DCAM Optical assistant. Ask me about hours, HMO coverage, eye exams or eyewear — or I can help you book a visit.";

  const css = `
  .dca-fab{position:fixed;right:20px;bottom:20px;z-index:9998;height:56px;min-width:56px;padding:0 20px 0 16px;border-radius:100px;border:none;cursor:pointer;
    background:#B05A9E;color:#fff;box-shadow:0 8px 24px rgba(56,51,52,.3);display:flex;align-items:center;gap:10px;
    font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:.92rem;transition:transform .15s,background .15s}
  .dca-fab:hover{background:#8F4680;transform:translateY(-1px)}
  .dca-fab:focus-visible{outline:3px solid #5BAFC0;outline-offset:3px}
  .dca-fab.open .dca-fab-label{display:none}
  .dca-fab.open{padding:0;width:56px;justify-content:center}
  .dca-panel{position:fixed;right:20px;bottom:88px;z-index:9999;width:380px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);
    background:#F7F1E8;border:1px solid rgba(56,51,52,.14);border-radius:20px;box-shadow:0 18px 50px rgba(56,51,52,.28);
    display:none;flex-direction:column;overflow:hidden;font-family:'Sora',sans-serif;color:#383334}
  .dca-panel.open{display:flex}
  .dca-head{background:#383334;color:#F7F1E8;padding:15px 16px;display:flex;align-items:center;gap:10px}
  .dca-dot{width:9px;height:9px;border-radius:50%;background:#5BAFC0;flex-shrink:0;box-shadow:0 0 0 3px rgba(91,175,192,.25)}
  .dca-title{flex:1;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:.95rem}
  .dca-sub{font-family:'Sora',sans-serif;font-weight:400;font-size:.7rem;opacity:.65;margin-top:1px}
  .dca-close{background:transparent;border:none;color:#F7F1E8;cursor:pointer;font-size:1.35rem;line-height:1;padding:2px 7px;border-radius:6px;opacity:.8}
  .dca-close:hover{opacity:1;background:rgba(247,241,232,.12)}
  .dca-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
  .dca-panel .msg{max-width:88%;padding:10px 13px;border-radius:14px;font-size:.87rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}
  .dca-panel .msg.bot{background:#fff;border:1px solid rgba(56,51,52,.1);align-self:flex-start;border-bottom-left-radius:4px}
  .dca-panel .msg.user{background:#B05A9E;color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
  .dca-panel .msg.thinking{opacity:.55;font-style:italic}
  .dca-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 12px}
  .dca-chip{font-family:inherit;font-size:.76rem;background:#fff;border:1px solid rgba(56,51,52,.18);color:#383334;padding:7px 12px;border-radius:100px;cursor:pointer}
  .dca-chip:hover{border-color:#B05A9E}
  .dca-input{border-top:1px solid rgba(56,51,52,.12);padding:12px;display:flex;gap:8px;background:#fff}
  .dca-input input{flex:1;border:1.5px solid rgba(56,51,52,.16);border-radius:100px;padding:10px 15px;font-family:inherit;font-size:.87rem;color:#383334;outline:none;min-width:0}
  .dca-input input:focus{border-color:#5BAFC0}
  .dca-send{width:42px;height:42px;border-radius:50%;border:none;background:#383334;color:#F7F1E8;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .dca-send:disabled{opacity:.4;cursor:default}
  .dca-foot{font-size:.66rem;color:#4A4547;opacity:.75;text-align:center;padding:0 14px 10px;background:#fff;line-height:1.4}
  .chat-book-btn{align-self:flex-start;display:inline-flex;align-items:center;gap:6px;background:#B05A9E;color:#fff !important;
    font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;font-size:.85rem;text-decoration:none;padding:9px 16px;border-radius:20px;margin-top:-2px}
  .chat-book-btn:hover{background:#8F4680}
  .dca-chip.order{border-color:#5BAFC0;color:#458F9E;font-weight:600}
  .dca-order{align-self:stretch;background:#fff;border:1px solid rgba(56,51,52,.12);border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:8px}
  .dca-order .dca-order-title{font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;font-size:.84rem}
  .dca-order label{font-size:.7rem;text-transform:uppercase;letter-spacing:.05em;color:#4A4547;display:block;margin-bottom:3px}
  .dca-order input{width:100%;box-sizing:border-box;border:1.5px solid rgba(56,51,52,.16);border-radius:10px;padding:9px 11px;font-family:inherit;font-size:.86rem;color:#383334;outline:none}
  .dca-order input:focus{border-color:#5BAFC0}
  .dca-order .dca-order-row{display:grid;grid-template-columns:1.4fr 1fr;gap:8px}
  .dca-order button{align-self:flex-start;background:#383334;color:#F7F1E8;border:none;border-radius:100px;padding:9px 16px;font-family:'Plus Jakarta Sans',sans-serif;font-weight:600;font-size:.82rem;cursor:pointer}
  .dca-order button:disabled{opacity:.5;cursor:default}
  .dca-order .dca-order-note{font-size:.7rem;color:#4A4547;opacity:.8}
  @media (max-width:480px){
    .dca-panel{right:8px;left:8px;width:auto;max-width:none;bottom:82px;height:calc(100vh - 100px);max-height:none}
    .dca-fab{right:14px;bottom:14px}
    .dca-fab .dca-fab-label{display:none}
    .dca-fab{padding:0;width:56px;justify-content:center}
  }
  @media print{.dca-fab,.dca-panel{display:none!important}}`;

  // --------------------------------------------------------------------
  // Shared conversation, rendered into every registered view
  // --------------------------------------------------------------------
  const views = []; // { body, chips, input, send }
  const turns = [];
  let busy = false;

  function scrollAll() { views.forEach(v => { v.body.scrollTop = v.body.scrollHeight; }); }

  // Adds a message to every view; returns a handle to update/remove all copies.
  function addMsg(text, cls) {
    const els = views.map(v => {
      const d = document.createElement('div');
      d.className = 'msg ' + cls;
      d.textContent = text;
      v.body.appendChild(d);
      return d;
    });
    scrollAll();
    return {
      set(t) { els.forEach(e => { e.textContent = t; }); scrollAll(); },
      remove() { els.forEach(e => e.remove()); },
    };
  }

  function addBookButton() {
    views.forEach(v => {
      const a = document.createElement('a');
      a.className = 'chat-book-btn';
      a.href = BOOK_URL;
      a.textContent = 'Book an exam →';
      v.body.appendChild(a);
    });
    scrollAll();
  }

  function setBusy(on) {
    busy = on;
    views.forEach(v => { v.send.disabled = on; });
  }

  function hideChips() { views.forEach(v => { if (v.chips) v.chips.style.display = 'none'; }); }

  // Hide the booking marker (and any half-streamed start of it).
  function visibleText(raw) {
    let t = raw.split(BOOK_MARKER).join('');
    for (let i = BOOK_MARKER.length - 1; i > 0; i--) {
      if (t.endsWith(BOOK_MARKER.slice(0, i))) { t = t.slice(0, -i); break; }
    }
    return t.trim();
  }

  async function askServer(onText) {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: turns }),
    });
    if (!resp.ok) {
      let msg = null;
      try { msg = (await resp.json()).error; } catch (e) {}
      const err = new Error(msg || 'Request failed');
      err.status = resp.status;
      err.userMessage = msg;
      throw err;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      onText(full);
    }
    return full + decoder.decode();
  }

  // Fallback only for previews opened inside the Claude app (no /api there).
  async function askClaudeApp(onText) {
    if (!(window.claude && window.claude.use)) throw new Error('no-fallback');
    const sample = await window.claude.use('sample');
    const intro = "You are DCAM Optical's website front-desk assistant (optometry practice, Philippines). Be brief and warm, never diagnose, send possibly urgent symptoms to prompt in-person care, and don't invent prices or phone numbers. If booking is the helpful next step, end with [[BOOK]].";
    const result = await sample([{ role: 'user', content: intro }, ...turns], {
      cache: false, modelTier: 'quick', onText: ({ text }) => onText(text),
    });
    return result.text;
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    views.forEach(v => { v.input.value = ''; });
    setBusy(true);
    hideChips();
    addMsg(text, 'user');
    turns.push({ role: 'user', content: text });

    const thinking = addMsg('Thinking…', 'bot thinking');
    let bubble = null;
    const onText = (raw) => {
      const shown = visibleText(raw);
      if (!shown) return;
      if (!bubble) { thinking.remove(); bubble = addMsg('', 'bot'); }
      bubble.set(shown);
    };

    try {
      let full;
      try {
        full = await askServer(onText);
      } catch (e) {
        if (e.status === 404 || e instanceof TypeError) full = await askClaudeApp(onText);
        else throw e;
      }
      const wantsBooking = full.includes(BOOK_MARKER);
      const clean = visibleText(full);
      if (!clean) throw new Error('empty');
      if (!bubble) { thinking.remove(); bubble = addMsg(clean, 'bot'); }
      bubble.set(clean);
      turns.push({ role: 'assistant', content: clean });
      if (wantsBooking) addBookButton();
    } catch (e) {
      thinking.remove();
      if (bubble) bubble.remove();
      turns.pop();
      addMsg((e && e.userMessage) || "Sorry — I couldn't answer just now. Please try again, or start the intake form and the clinic will get back to you.", 'bot');
    } finally {
      setBusy(false);
    }
  }

  function registerView(v) {
    views.push(v);
    v.send.addEventListener('click', () => send(v.input.value));
    v.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); send(v.input.value); }
    });
    if (v.chips) {
      v.chips.addEventListener('click', e => {
        const b = e.target.closest('[data-q]');
        if (b) send(b.getAttribute('data-q'));
      });
    }
  }

  // --------------------------------------------------------------------
  // Floating bubble
  // --------------------------------------------------------------------
  function buildBubble(orderStatusOn) {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const fab = document.createElement('button');
    fab.type = 'button';
    fab.className = 'dca-fab';
    fab.setAttribute('aria-label', 'Chat with DCAM Optical');
    fab.setAttribute('aria-expanded', 'false');
    const chatIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    const closeIcon = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>';
    fab.innerHTML = chatIcon + '<span class="dca-fab-label">Ask us</span>';

    const panel = document.createElement('div');
    panel.className = 'dca-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'DCAM Optical assistant');
    panel.innerHTML = `
      <div class="dca-head">
        <div class="dca-dot"></div>
        <div class="dca-title">DCAM Optical<div class="dca-sub">Usually answers instantly</div></div>
        <button type="button" class="dca-close" aria-label="Close chat">×</button>
      </div>
      <div class="dca-body"></div>
      <div class="dca-chips"></div>
      <div class="dca-input">
        <input type="text" placeholder="Type your question…" autocomplete="off" aria-label="Your question">
        <button type="button" class="dca-send" aria-label="Send"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
      </div>
      <div class="dca-foot">AI assistant — can't diagnose. For urgent eye problems, seek care right away.</div>`;

    const body = panel.querySelector('.dca-body');
    const greet = document.createElement('div');
    greet.className = 'msg bot';
    greet.textContent = GREETING;
    body.appendChild(greet);

    const chips = panel.querySelector('.dca-chips');
    if (orderStatusOn) {
      const oc = document.createElement('button');
      oc.type = 'button';
      oc.className = 'dca-chip order';
      oc.textContent = 'Check my order';
      oc.addEventListener('click', () => showOrderForm(body));
      chips.appendChild(oc);
    }
    SUGGESTIONS.forEach(([label, q]) => {
      const c = document.createElement('button');
      c.type = 'button';
      c.className = 'dca-chip';
      c.textContent = label;
      c.setAttribute('data-q', q);
      chips.appendChild(c);
    });

    document.body.appendChild(panel);
    document.body.appendChild(fab);

    const input = panel.querySelector('.dca-input input');
    registerView({ body, chips, input, send: panel.querySelector('.dca-send') });

    function setOpen(open) {
      panel.classList.toggle('open', open);
      fab.classList.toggle('open', open);
      fab.setAttribute('aria-expanded', String(open));
      fab.innerHTML = open ? closeIcon : chatIcon + '<span class="dca-fab-label">Ask us</span>';
      if (open) { body.scrollTop = body.scrollHeight; input.focus(); }
    }
    fab.addEventListener('click', () => setOpen(!panel.classList.contains('open')));
    panel.querySelector('.dca-close').addEventListener('click', () => { setOpen(false); fab.focus(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel.classList.contains('open')) setOpen(false); });

    // Let other buttons on the page open the chat: <a data-open-chat>…</a>
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-open-chat]');
      if (!t) return;
      e.preventDefault();
      setOpen(true);
    });
  }

  // "Check my order": order number + last 4 phone digits -> status.
  // Goes straight to /api/chat?mode=order (no AI, no cost).
  function showOrderForm(body) {
    const existing = body.querySelector('.dca-order');
    if (existing) { existing.querySelector('input').focus(); return; }
    const card = document.createElement('form');
    card.className = 'dca-order';
    card.innerHTML = `
      <div class="dca-order-title">Check if your glasses are ready</div>
      <div class="dca-order-row">
        <div><label for="dcaOrderNo">Order no. (claim stub)</label><input id="dcaOrderNo" inputmode="numeric" autocomplete="off" placeholder="2026-0012" maxlength="20" required></div>
        <div><label for="dcaLast4">Phone — last 4</label><input id="dcaLast4" inputmode="numeric" autocomplete="off" placeholder="4567" maxlength="4" pattern="[0-9]{4}" required></div>
      </div>
      <button type="submit">Check status</button>
      <div class="dca-order-note">Use the number on your claim stub and the last 4 digits of the phone number you gave us.</div>`;
    body.appendChild(card);
    body.scrollTop = body.scrollHeight;
    const orderIn = card.querySelector('#dcaOrderNo');
    const last4In = card.querySelector('#dcaLast4');
    last4In.addEventListener('input', () => { last4In.value = last4In.value.replace(/\D/g, '').slice(0, 4); });
    orderIn.focus();

    card.addEventListener('submit', async (e) => {
      e.preventDefault();
      const orderNo = orderIn.value.trim();
      const last4 = last4In.value.trim();
      if (!orderNo || last4.length !== 4) {
        last4In.focus();
        return;
      }
      const btn = card.querySelector('button');
      btn.disabled = true;
      card.remove();
      hideChips();
      addMsg(`Check order ${orderNo} (phone ending ${last4})`, 'user');
      const thinking = addMsg('Checking…', 'bot thinking');
      try {
        const resp = await fetch('/api/chat?mode=order', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order_number: orderNo, phone_last4: last4 }),
        });
        const r = await resp.json().catch(() => ({}));
        thinking.remove();
        const msg = r.message || r.error || "Sorry — I couldn't check that right now. Please contact the clinic.";
        addMsg(msg, 'bot');
        turns.push({ role: 'user', content: `Check my order ${orderNo}` });
        turns.push({ role: 'assistant', content: msg });
        if (r.result === 'not_found') {
          const again = document.createElement('button');
          again.type = 'button';
          again.className = 'dca-chip order';
          again.style.alignSelf = 'flex-start';
          again.textContent = 'Try again';
          again.addEventListener('click', () => { again.remove(); showOrderForm(body); });
          body.appendChild(again);
          body.scrollTop = body.scrollHeight;
        }
      } catch (err) {
        thinking.remove();
        addMsg("Couldn't reach the clinic system — please try again or contact the clinic.", 'bot');
      }
    });
  }

  // Homepage inline panel, if present.
  function attachInline() {
    const body = document.getElementById('chatBody');
    const input = document.getElementById('chatInput');
    const sendBtn = document.getElementById('chatSend');
    if (!body || !input || !sendBtn) return;
    registerView({ body, chips: document.getElementById('chatChips'), input, send: sendBtn });
  }

  // Test mode: say so plainly in both chat views so nobody mistakes the
  // sample answers for the real assistant.
  function markTestMode() {
    const sub = document.querySelector('.dca-sub');
    if (sub) sub.textContent = 'Test mode · sample replies';
    const foot = document.querySelector('.dca-foot');
    if (foot) foot.textContent = 'Test mode — sample replies, not the real AI assistant. No AI cost.';
    const tag = document.querySelector('.chat-panel .chat-head .tag');
    if (tag) tag.textContent = 'test mode';
  }

  function hideChatEverywhere() {
    const section = document.getElementById('ai');
    if (section) section.style.display = 'none';
    document.querySelectorAll('a[href="#ai"], [data-open-chat]').forEach(a => { a.style.display = 'none'; });
  }

  async function init() {
    let enabled = true;
    let testMode = false;
    let orderStatus = false;
    try {
      const resp = await fetch('/api/chat', { method: 'GET', cache: 'no-store' });
      if (resp.ok) {
        const s = await resp.json();
        enabled = s.enabled !== false;
        testMode = s.testMode === true;
        orderStatus = s.orderStatus === true;
      }
      // 404 / non-OK: no backend (e.g. a preview) -> stay on; send() falls back.
    } catch (e) { /* offline preview: stay on */ }

    if (!enabled) { hideChatEverywhere(); return; }
    attachInline();
    buildBubble(orderStatus);
    if (testMode) markTestMode();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
