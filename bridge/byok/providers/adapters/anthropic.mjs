// The Anthropic Messages API adapter (PRD §7.1, §7.2 "Anthropic", §7.3
// caching, §7.4 effort). Request rules:
// - never temperature, top_p or top_k (Sonnet 5 and 4.7+ reject them);
// - system blocks marked `cache` get cache_control {type:'ephemeral', ttl:'1h'}
//   (the 1-hour TTL, since game pacing misses the 5-minute cache; at most 4
//   breakpoints, the last ones win);
// - effort comes from the manifest map (fix-102: every level each model has): Off is
//   thinking between_tools on Sonnet 5.5 and disabled on Sonnet 5, each at effort low;
//   Low to Max are output_config.effort; Haiku 4.5's levels are thinking budgets.
// Stream events: message_start, content_block_*, message_delta (cumulative
// usage), message_stop, ping, and `error`, which can arrive after a 200.
// A stream that fails after message_start (an `error` event such as overloaded
// mid-stream, a cut connection, a stall) still reports what it used so far:
// message_start's input and cache tokens and the output so far (the larger of
// the last count sent and the streamed text at 4 characters a token), as
// {partial: true, exact: false}, before the error, so the turn isn't counted
// as free (§9.2, US-1).
// A thinking block (Sonnet 5 hides its text by default, so it can run silent
// for a minute) is reported as {type:'thinking', active} so the wrapper's
// timers treat it as a live provider (§7.5).
import { readSSE } from '../sse.mjs';
import { requestBody, effortFragment, joinUrl, parseJSON, num, withQuery } from '../util.mjs';

const THINKING_BLOCKS = new Set(['thinking', 'redacted_thinking']);

const MAX_BREAKPOINTS = 4;
const SAMPLING = ['temperature', 'top_p', 'top_k'];

const FINISH = {
  end_turn: 'stop', stop_sequence: 'stop', tool_use: 'stop', pause_turn: 'stop',
  max_tokens: 'length', refusal: 'refusal',
};

export function buildSystem(system, ttl = '1h') {
  const blocks = (system || [])
    .map(b => (typeof b === 'string' ? { text: b } : b))
    .filter(b => b && b.text)
    .map(b => ({ type: 'text', text: String(b.text), cache: !!b.cache }));
  const marked = blocks.map((b, i) => (b.cache ? i : -1)).filter(i => i >= 0).slice(-MAX_BREAKPOINTS);
  return blocks.map((b, i) => {
    const out = { type: 'text', text: b.text };
    if (marked.includes(i)) out.cache_control = ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };
    return out;
  });
}

export function chatRequest(manifest, req, { authHeaders = {}, requestOptions = null, path } = {}) {
  const system = buildSystem(req.system, req.cacheTtl);
  const core = {
    model: req.model,
    max_tokens: req.maxTokens ?? manifest.limits.maxOutputTokens,
    messages: (req.messages || []).map(m => ({ role: m.role, content: String(m.content ?? '') })),
  };
  if (system.length) core.system = system;
  const body = requestBody(manifest.defaultRequestOptions, effortFragment(manifest, req.model, req.effort), requestOptions, core);
  if (system.length) body.system = system; // arrays merge by replacement; keep ours
  // A thinking budget (Claude Haiku 4.5's levels) must stay below max_tokens, or the API refuses the
  // request: the reply's ceiling goes on top of it (buildRequest already asks for that room).
  const budget = body.thinking?.type === 'enabled' ? body.thinking.budget_tokens : undefined;
  if (Number.isInteger(budget) && Number.isInteger(body.max_tokens) && body.max_tokens <= budget) body.max_tokens = budget + body.max_tokens;
  body.stream = true;
  for (const k of SAMPLING) delete body[k];
  return {
    url: joinUrl(manifest.baseUrl, path || manifest.paths.chat),
    method: 'POST',
    headers: { ...manifest.headers, ...authHeaders, 'content-type': 'application/json', accept: 'text/event-stream' },
    body,
  };
}

function mergeUsage(acc, u) {
  if (!u || typeof u !== 'object') return;
  for (const [k, v] of Object.entries(u)) {
    if (typeof v === 'number') acc[k] = v;
    else if (v && typeof v === 'object' && k === 'cache_creation') acc.cache_creation = { ...(acc.cache_creation || {}), ...v };
  }
}

export function normalizeUsage(u) {
  const out = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    reasoning: 0,
    exact: false,
  };
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens;
  if (typeof oneHour === 'number') out.cacheWrite1h = oneHour;
  return out;
}

/** What a stream that failed after message_start used so far: {partial: true, exact: false}. */
export function partialUsage(u, streamedChars = 0) {
  const n = normalizeUsage(u);
  return { ...n, output: Math.max(n.output, Math.ceil(Math.max(0, streamedChars) / 4)), exact: false, partial: true };
}

export async function* parse(res, ctx) {
  const usage = {};
  let stop = null;
  let ended = false;
  let started = false; // message_start seen: the input is being billed
  let chars = 0; // text and thinking streamed so far (the output count arrives only at the end)
  let thinkingIndex = null;
  const soFar = () => ({ type: 'usage', usage: partialUsage(usage, chars) });
  try {
    for await (const ev of readSSE(res.body)) {
      const data = parseJSON(ev.data);
      if (!data || typeof data !== 'object') continue;
      const type = data.type || ev.event;
      if (type === 'message_start') { started = true; mergeUsage(usage, data.message?.usage); }
      else if (type === 'content_block_start') {
        const block = data.content_block || {};
        if (THINKING_BLOCKS.has(block.type)) { thinkingIndex = data.index ?? -1; yield { type: 'thinking', active: true }; }
        else if (block.type === 'text' && block.text) { chars += block.text.length; yield { type: 'text', delta: block.text }; }
      } else if (type === 'content_block_stop') {
        if (thinkingIndex !== null && (data.index ?? -1) === thinkingIndex) { thinkingIndex = null; yield { type: 'thinking', active: false }; }
      } else if (type === 'content_block_delta') {
        const d = data.delta || {};
        if (d.type === 'text_delta') { if (d.text) { chars += d.text.length; yield { type: 'text', delta: d.text }; } }
        else {
          if (typeof d.thinking === 'string') chars += d.thinking.length;
          yield { type: 'progress' }; // thinking, signature, tool input
        }
      } else if (type === 'message_delta') {
        if (data.delta?.stop_reason) stop = data.delta.stop_reason;
        mergeUsage(usage, data.usage);
      } else if (type === 'message_stop') {
        ended = true;
        break;
      } else if (type === 'error') {
        if (started) yield soFar();
        yield { type: 'error', error: ctx.fail(data) };
        return;
      }
      // ping and unknown event types are ignored
    }
  } catch (e) {
    // A cut connection, a stall or a stop mid-stream: what was used so far, then the failure.
    if (started && !ended) yield soFar();
    throw e;
  }
  if (!ended) {
    if (started) yield soFar();
    yield { type: 'error', error: ctx.truncated() };
    return;
  }
  yield { type: 'usage', usage: normalizeUsage(usage) };
  if (stop === 'model_context_window_exceeded') {
    yield { type: 'error', error: ctx.error({ kind: 'context_too_long', code: stop }) };
    return;
  }
  yield { type: 'done', finish: FINISH[stop] ?? 'stop' };
}

export function modelsPage(json, path) {
  const ids = Array.isArray(json?.data) ? json.data.map(m => m?.id).filter(x => typeof x === 'string') : [];
  const next = json?.has_more && json?.last_id ? withQuery(path, 'after_id', json.last_id) : null;
  return { ids, next };
}

export default { id: 'anthropic-messages', chatRequest, parse, modelsPage };
