// Clinic knowledge box + "questions it couldn't answer".
//
// KNOWLEDGE (app_settings key "ai_knowledge"), edited by admins in
// Settings -> AI assistant -> Clinic knowledge:
//   { entries: [{ id, title, answer, audience: 'website'|'staff'|'both', active }] }
// Active entries are added to the assistants' instructions on every
// message, so edits apply immediately -- no retraining. Sizes are capped
// because this text is sent (and paid for) with every AI reply.
//
// UNANSWERED (table ai_unanswered), only when Settings switch
// "Log questions it couldn't answer" is on (off by default). The AI marks
// a reply with [[UNANSWERED]] when your info doesn't cover the question;
// the marker is stripped before anyone sees the reply. Phone numbers and
// emails are removed before saving, repeats are counted instead of
// duplicated, and rows older than 90 days are deleted automatically.

const { supabaseRequest } = require('./supabase');

const MAX_ENTRIES = 60;
const MAX_TITLE = 150;
const MAX_ANSWER = 1500;
const MAX_TOTAL_CHARS = 12000; // ~3,000 tokens ≈ $0.003 extra per Haiku reply at most
const AUDIENCES = ['website', 'staff', 'both'];
const UNANSWERED_MARKER = '[[UNANSWERED]]';
const RETENTION_DAYS = 90;

function cleanText(v, max) {
  return typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// Always returns { entries: [...] } within the caps; drops blank entries.
function normalizeKnowledge(value) {
  const raw = value && Array.isArray(value.entries) ? value.entries : [];
  const entries = [];
  let total = 0;
  for (const e of raw) {
    if (entries.length >= MAX_ENTRIES) break;
    if (!e || typeof e !== 'object') continue;
    const title = cleanText(e.title, MAX_TITLE);
    const answer = cleanText(e.answer, MAX_ANSWER);
    if (!title || !answer) continue;
    const size = title.length + answer.length;
    if (total + size > MAX_TOTAL_CHARS) break;
    total += size;
    entries.push({
      id: typeof e.id === 'string' && /^[a-z0-9]{4,20}$/.test(e.id) ? e.id : newId(),
      title,
      answer,
      audience: AUDIENCES.includes(e.audience) ? e.audience : 'both',
      active: e.active !== false,
    });
  }
  return { entries };
}

async function loadKnowledge() {
  try {
    const resp = await supabaseRequest('app_settings?key=eq.ai_knowledge&select=value&limit=1', { method: 'GET' });
    if (!resp.ok) return { entries: [] };
    const rows = await resp.json();
    return normalizeKnowledge(rows[0] && rows[0].value);
  } catch (e) {
    console.error('ai-knowledge: could not load', e.message);
    return { entries: [] };
  }
}

// channel: 'website' | 'staff'
function entriesFor(knowledge, channel) {
  return knowledge.entries.filter(e => e.active && (e.audience === 'both' || e.audience === channel));
}

function knowledgePromptBlock(knowledge, channel) {
  const list = entriesFor(knowledge, channel);
  if (!list.length) return '';
  return 'CLINIC KNOWLEDGE (written by the clinic -- authoritative; prefer it over general assumptions):\n' +
    list.map(e => `Q: ${e.title}\nA: ${e.answer}`).join('\n\n');
}

function unansweredInstruction(enabled) {
  if (!enabled) return '';
  return `\nKNOWLEDGE GAPS:
If the question is about this clinic or its services/policies and the answer is NOT in the details, clinic knowledge or lookup results you were given (so you had to say you don't know or refer them elsewhere), end your reply with the exact marker ${UNANSWERED_MARKER} on its own line. It is removed before anyone sees the reply. Don't use it for greetings, off-topic requests, urgent-symptom advice, or when a data lookup simply returned no matching records.`;
}

// Test mode: best keyword match in the knowledge entries, or null.
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'are', 'what', 'how', 'can', 'does', 'do', 'is', 'a', 'an', 'to', 'of', 'in', 'on', 'my', 'i', 'we', 'our', 'with', 'have', 'there', 'any', 'ba', 'po', 'ang', 'ng', 'sa', 'na', 'ko', 'ako', 'kayo', 'mo', 'may']);
function words(s) {
  return String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2 && !STOP.has(w));
}
function matchKnowledge(knowledge, channel, question) {
  const q = new Set(words(question));
  if (!q.size) return null;
  let best = null;
  for (const e of entriesFor(knowledge, channel)) {
    const titleWords = words(e.title);
    const hitsTitle = titleWords.filter(w => q.has(w)).length;
    const hitsAnswer = words(e.answer).filter(w => q.has(w)).length;
    const score = hitsTitle * 3 + Math.min(hitsAnswer, 3);
    if (score >= 3 && (!best || score > best.score)) best = { entry: e, score };
  }
  return best ? best.entry : null;
}

// ---------------------------------------------------------------------
// Unanswered questions
// ---------------------------------------------------------------------
function stripMarker(text) {
  return String(text || '').split(UNANSWERED_MARKER).join('').replace(/\n{3,}/g, '\n\n').trim();
}

// Remove contact details before storing anything a visitor typed.
function redact(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/(\+?\d[\d\s().-]{6,}\d)/g, '[number]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function normalizeQuestion(text) {
  return redact(text).toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function logUnanswered({ channel, question, username, role }) {
  const clean = redact(question);
  const norm = normalizeQuestion(question);
  if (norm.length < 3) return;
  try {
    // Repeat of an open question? Bump its count instead of adding a row.
    const existing = await supabaseRequest(
      `ai_unanswered?select=id,times_asked&status=eq.open&channel=eq.${channel}&question_norm=eq.${encodeURIComponent(norm)}&limit=1`,
      { method: 'GET' }
    );
    const rows = existing.ok ? await existing.json() : [];
    if (rows.length) {
      await supabaseRequest(`ai_unanswered?id=eq.${rows[0].id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ times_asked: (rows[0].times_asked || 1) + 1, last_asked_at: new Date().toISOString() }),
      });
    } else {
      const resp = await supabaseRequest('ai_unanswered', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ channel, question: clean, question_norm: norm, asked_by: username || null, asked_by_role: role || null }),
      });
      if (!resp.ok) console.error('ai-knowledge: unanswered insert failed', resp.status, (await resp.text().catch(() => '')).slice(0, 200));
    }
    // Retention: occasionally clear anything older than RETENTION_DAYS.
    if (Math.random() < 0.1) {
      const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
      await supabaseRequest(`ai_unanswered?last_asked_at=lt.${encodeURIComponent(cutoff)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    }
  } catch (e) {
    console.error('ai-knowledge: unanswered log error', e.message);
  }
}

async function listUnanswered(status) {
  const filter = ['open', 'resolved', 'dismissed'].includes(status) ? `&status=eq.${status}` : '';
  const resp = await supabaseRequest(
    `ai_unanswered?select=id,created_at,last_asked_at,channel,question,times_asked,asked_by,status,resolved_by,resolved_at${filter}&order=last_asked_at.desc&limit=200`,
    { method: 'GET' }
  );
  if (!resp.ok) throw new Error(`list failed (${resp.status})`);
  return resp.json();
}

async function setUnansweredStatus(id, status, username) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw new Error('bad id');
  if (!['open', 'resolved', 'dismissed'].includes(status)) throw new Error('bad status');
  const resp = await supabaseRequest(`ai_unanswered?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status,
      resolved_by: status === 'open' ? null : (username || null),
      resolved_at: status === 'open' ? null : new Date().toISOString(),
    }),
  });
  if (!resp.ok) throw new Error(`update failed (${resp.status})`);
}

module.exports = {
  MAX_ENTRIES, MAX_ANSWER, MAX_TITLE, MAX_TOTAL_CHARS, UNANSWERED_MARKER,
  normalizeKnowledge, loadKnowledge, entriesFor, knowledgePromptBlock, unansweredInstruction,
  matchKnowledge, stripMarker, redact, logUnanswered, listUnanswered, setUnansweredStatus,
};
