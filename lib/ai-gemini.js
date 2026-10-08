// Gemini (Google) provider for the website chat and staff assistant.
//
// Two ways to connect, chosen by which Vercel environment variable is set
// (Vertex wins if both are):
//
//   VERTEX_API_KEY  -- Google Cloud (Vertex AI / "Gemini Enterprise Agent
//                      Platform", express mode or a billed project). Usage
//                      is billed to Google Cloud, so Google Cloud credits
//                      (including the $300 free trial) apply, and Google
//                      Cloud terms mean prompts are NOT used for training.
//   GEMINI_API_KEY  -- Google AI Studio. Free tier available, BUT on the free
//                      tier Google may use prompts and replies to improve its
//                      products. Google Cloud trial credits can't pay for
//                      AI Studio usage (accounts opened after March 2026).
//
// GEMINI_MODEL (optional env) or Settings -> AI assistant picks the model;
// default below.
//
// The rest of the app speaks Claude's message/tool format. This file
// translates both ways so api/chat.js can swap providers without changing
// its logic:
//   - Claude-style messages (text, tool_use, tool_result blocks) -> Gemini
//     `contents` (text, functionCall, functionResponse parts)
//   - Claude tool definitions -> Gemini functionDeclarations
//   - Gemini responses -> Claude-shaped results
// Gemini 3 returns "thought signatures" on function calls that must be sent
// back unchanged on the next turn; the raw model parts are carried along on
// the assistant message (`_geminiParts`) for exactly that reason.

const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

function geminiRoute() {
  const vertex = (process.env.VERTEX_API_KEY || '').trim();
  if (vertex) {
    return { route: 'vertex', key: vertex, base: 'https://aiplatform.googleapis.com/v1/publishers/google/models' };
  }
  const studio = (process.env.GEMINI_API_KEY || '').trim();
  if (studio) {
    return { route: 'aistudio', key: studio, base: 'https://generativelanguage.googleapis.com/v1beta/models' };
  }
  return null;
}

function geminiModel(settingModel) {
  const fromEnv = (process.env.GEMINI_MODEL || '').trim();
  const pick = fromEnv || (typeof settingModel === 'string' ? settingModel.trim() : '') || DEFAULT_GEMINI_MODEL;
  // Model names are path segments: keep them to safe characters.
  return /^[a-z0-9][a-z0-9.\-]{1,60}$/i.test(pick) ? pick : DEFAULT_GEMINI_MODEL;
}

// Only the JSON-schema keywords Gemini's function declarations accept.
function cleanSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  ['type', 'description', 'enum', 'required', 'format', 'nullable'].forEach(k => {
    if (schema[k] !== undefined) out[k] = schema[k];
  });
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    Object.keys(schema.properties).forEach(k => { out.properties[k] = cleanSchema(schema.properties[k]); });
  }
  if (schema.items) out.items = cleanSchema(schema.items);
  return out;
}

function toGeminiBody({ system, messages, tools, maxTokens }) {
  // Map tool_use ids -> function names so tool_result blocks can be named.
  const idToName = {};
  messages.forEach(m => {
    if (Array.isArray(m.content)) {
      m.content.forEach(b => { if (b && b.type === 'tool_use') idToName[b.id] = b.name; });
    }
  });

  const contents = messages.map(m => {
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (m.role === 'assistant' && Array.isArray(m._geminiParts)) {
      return { role, parts: m._geminiParts };  // keeps thought signatures intact
    }
    if (typeof m.content === 'string') return { role, parts: [{ text: m.content }] };
    const parts = [];
    (m.content || []).forEach(b => {
      if (!b) return;
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      else if (b.type === 'tool_result') {
        let response;
        try { response = JSON.parse(b.content); } catch (e) { response = { result: String(b.content || '') }; }
        if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
        parts.push({ functionResponse: { name: idToName[b.tool_use_id] || 'tool', response } });
      }
    });
    return { role, parts: parts.length ? parts : [{ text: ' ' }] };
  });

  const body = {
    contents,
    generationConfig: {
      // Gemini 3 models may "think" before answering and those tokens count
      // toward this cap, so leave headroom above the visible reply length.
      maxOutputTokens: Math.max(1024, (maxTokens || 450) * 3),
      temperature: 0.4,
    },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Array.isArray(tools) && tools.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name,
        description: t.description,
        parameters: cleanSchema(t.input_schema),
      })),
    }];
  }
  return body;
}

function usageFrom(meta) {
  const m = meta || {};
  return {
    input: m.promptTokenCount || 0,
    // Thinking tokens are billed as output.
    output: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0),
  };
}

// Builds the Claude-shaped pieces from the model's raw parts.
function fromParts(parts) {
  const contentBlocks = [];
  const toolUses = [];
  let text = '';
  (parts || []).forEach((p, i) => {
    if (p.thought) return;  // internal reasoning summary, never shown
    if (typeof p.text === 'string' && p.text) {
      text += p.text;
      const last = contentBlocks[contentBlocks.length - 1];
      if (last && last.type === 'text') last.text += p.text;
      else contentBlocks.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      const block = {
        type: 'tool_use',
        id: `gm_${i}_${p.functionCall.name}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      };
      contentBlocks.push(block);
      toolUses.push(block);
    }
  });
  return { text, contentBlocks, toolUses };
}

class GeminiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function postGemini(route, model, method, body, query) {
  const url = `${route.base}/${encodeURIComponent(model)}:${method}?${query ? query + '&' : ''}key=${encodeURIComponent(route.key)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    // Never echo the URL (it contains the key).
    throw new GeminiError(`Gemini ${route.route} ${resp.status}: ${t.slice(0, 300)}`, resp.status);
  }
  return resp;
}

// Non-streaming call (staff assistant). Returns a Claude-shaped response:
// { stop_reason, content: [...blocks], usage: { input_tokens, output_tokens }, _geminiParts }
async function geminiMessage({ system, messages, tools, maxTokens, model }) {
  const route = geminiRoute();
  if (!route) throw new GeminiError('No Gemini API key configured', 503);
  const resp = await postGemini(route, model, 'generateContent', toGeminiBody({ system, messages, tools, maxTokens }));
  const data = await resp.json();
  const cand = (data.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  const { contentBlocks, toolUses } = fromParts(parts);
  const usage = usageFrom(data.usageMetadata);
  return {
    stop_reason: toolUses.length ? 'tool_use' : 'end_turn',
    content: contentBlocks,
    usage: { input_tokens: usage.input, output_tokens: usage.output },
    _geminiParts: parts,
  };
}

// Streaming call (website chat). Calls onText(chunk) as text arrives and
// returns the same shape as readAnthropicStream() in api/chat.js, plus
// geminiParts for the follow-up turn.
async function geminiStream({ system, messages, tools, maxTokens, model, onText }) {
  const route = geminiRoute();
  if (!route) throw new GeminiError('No Gemini API key configured', 503);
  const resp = await postGemini(route, model, 'streamGenerateContent', toGeminiBody({ system, messages, tools, maxTokens }), 'alt=sse');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const allParts = [];
  let usage = { input: 0, output: 0 };

  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(payload); } catch (e) { return; }
    const cand = (evt.candidates || [])[0];
    const parts = (cand && cand.content && cand.content.parts) || [];
    parts.forEach(p => {
      allParts.push(p);
      if (!p.thought && typeof p.text === 'string' && p.text) onText(p.text);
    });
    if (evt.usageMetadata) usage = usageFrom(evt.usageMetadata);  // cumulative
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      handle(buffer.slice(0, nl).trim());
      buffer = buffer.slice(nl + 1);
    }
  }
  if (buffer.trim()) handle(buffer.trim());

  // Merge streamed text fragments so the follow-up turn gets tidy parts.
  const merged = [];
  allParts.forEach(p => {
    const last = merged[merged.length - 1];
    const plainText = typeof p.text === 'string' && !p.thought && !p.thoughtSignature && !p.functionCall;
    if (plainText && last && typeof last.text === 'string' && !last.thought && !last.thoughtSignature && !last.functionCall) {
      last.text += p.text;
    } else {
      merged.push({ ...p });
    }
  });

  const { contentBlocks, toolUses } = fromParts(merged);
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    stopReason: toolUses.length ? 'tool_use' : 'end_turn',
    contentBlocks,
    toolUses,
    geminiParts: merged,
  };
}

function geminiStatus() {
  const r = geminiRoute();
  return { configured: !!r, route: r ? r.route : null, envModel: (process.env.GEMINI_MODEL || '').trim() || null };
}

module.exports = {
  DEFAULT_GEMINI_MODEL, geminiRoute, geminiModel, geminiMessage, geminiStream, geminiStatus,
  toGeminiBody, fromParts, GeminiError,
};
