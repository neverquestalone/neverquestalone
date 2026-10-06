// The provider layer's C2a pieces (public BYOK PRD §7.5, §8.4 item 3, §9.2, §10, KY-8, US-1): usage
// reported so far when a stream fails after it began (Anthropic's message_start then overloaded,
// a cut connection, a stop; OpenAI's response.failed; a Chat Completions error chunk), the per-call "Last request" hook, the header redaction, and reach(),
// the key-less probe a turn held for the network uses. Against the mock on 127.0.0.1; canary keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { serveOne, fixture, mockProvider, mockCustom, collect, textOf, last, req, CANARY } from './helpers/mock-provider.mjs';
import { redactHeaders, getManifest } from '../../bridge/byok/providers/index.mjs';
import { partialUsage } from '../../bridge/byok/providers/adapters/anthropic.mjs';

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const data = obj => `data: ${JSON.stringify(obj)}\n\n`;
const HEAD = sse('message_start', { message: { id: 'msg_T', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [],
  usage: { input_tokens: 1200, cache_read_input_tokens: 300, cache_creation_input_tokens: 0, output_tokens: 1 } } })
  + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
const delta = text => sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });

async function stream(id, model, spec, opts = {}) {
  const mock = await serveOne(spec);
  try {
    // Other (custom) at OpenRouter's address, with an OpenRouter key: what OpenRouter sends back.
    const { provider, lines } = id === 'custom'
      ? mockCustom(mock.url, { baseUrl: 'https://openrouter.ai/api/v1', model, key: CANARY.openrouter, ...opts })
      : mockProvider(id, mock.url, opts);
    const events = await collect(provider.stream(req(model), opts.call || {}));
    return { events, lines, mock };
  } finally { await mock.close(); }
}
const usageOf = events => events.filter(e => e.type === 'usage').map(e => e.usage);

test('Anthropic overloaded mid-stream: the usage so far (message_start\'s input and cache, the output streamed) comes before the error, partial', async () => {
  const { events, lines } = await stream('anthropic', 'claude-haiku-4-5', fixture('anthropic', 'error-overloaded-midstream.sse'));
  assert.equal(textOf(events), 'Hel');
  const [u] = usageOf(events);
  assert.deepEqual(u, { input: 1200, output: 1, cacheRead: 0, cacheWrite: 4100, cacheWrite1h: 4100, reasoning: 0, exact: false, partial: true });
  const i = events.findIndex(e => e.type === 'usage');
  assert.equal(events[i + 1].type, 'error', 'right before the error');
  assert.equal(last(events).error.kind, 'overloaded');
  assert.ok(lines.some(l => l.includes('"kind":"provider.usage"') && l.includes('"partial":true')), 'logged like any usage: numbers only');
});

test('Anthropic: the output so far is the larger of the count sent and the streamed text at 4 characters a token', async () => {
  const text = 'x'.repeat(403);
  const { events } = await stream('anthropic', 'claude-haiku-4-5', { status: 200, headers: { 'content-type': 'text/event-stream' },
    body: HEAD + delta(text) + sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }) });
  const [u] = usageOf(events);
  assert.equal(u.output, 101);
  assert.equal(u.input, 1200);
  assert.equal(u.cacheRead, 300);
  assert.deepEqual(partialUsage({ output_tokens: 500 }, 40), { input: 0, output: 500, cacheRead: 0, cacheWrite: 0, reasoning: 0, exact: false, partial: true });
});

test('Anthropic: a stream cut after message_start (truncated, or the connection dropped) reports the partial usage, then network_after_send', async () => {
  const cut = await stream('anthropic', 'claude-haiku-4-5', fixture('anthropic', 'truncated.sse'));
  assert.equal(usageOf(cut.events)[0].partial, true);
  assert.equal(usageOf(cut.events)[0].input, 1200);
  assert.equal(last(cut.events).error.kind, 'network_after_send');
  const drop = await stream('anthropic', 'claude-haiku-4-5', { status: 200, headers: { 'content-type': 'text/event-stream' }, body: HEAD + delta('Hello'), destroyAfterBody: true });
  assert.deepEqual(usageOf(drop.events).map(u => [u.input, u.cacheRead, u.output, u.partial]), [[1200, 300, 2, true]]);
  assert.equal(last(drop.events).error.kind, 'network_after_send');
});

test('Anthropic: an error before message_start reports no usage (nothing was generated), and a success reports it once, not partial', async () => {
  const early = await stream('anthropic', 'claude-haiku-4-5', { status: 200, headers: { 'content-type': 'text/event-stream' },
    body: sse('error', { error: { type: 'overloaded_error', message: 'Overloaded' } }) });
  assert.equal(usageOf(early.events).length, 0);
  assert.equal(last(early.events).error.kind, 'overloaded');
  const ok = await stream('anthropic', 'claude-haiku-4-5', fixture('anthropic', 'success.sse'));
  assert.equal(usageOf(ok.events).length, 1);
  assert.equal(usageOf(ok.events)[0].partial, undefined);
});

test('Anthropic: a stop mid-stream (the caller\'s abort) still reports the partial usage before interrupted', async () => {
  const spec = { status: 200, headers: { 'content-type': 'text/event-stream' }, script: [[0, HEAD + delta('Hi')], [5000, delta('never')]] };
  const mock = await serveOne(spec);
  try {
    const ac = new AbortController();
    const events = [];
    for await (const ev of mockProvider('anthropic', mock.url).provider.stream(req('claude-haiku-4-5'), { signal: ac.signal })) {
      events.push(ev);
      if (ev.type === 'text') ac.abort();
    }
    assert.equal(usageOf(events)[0].partial, true);
    assert.deepEqual([last(events).error.kind, last(events).error.aborted], ['interrupted', true]);
  } finally { await mock.close(); }
});

test('Chat Completions (Other at OpenRouter): an error chunk mid-stream reports the usage sent so far, partial; a cut stream too', async () => {
  const chunk = (d, extra = {}) => data({ id: 'gen-T', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: null }], ...extra });
  const err = data({ id: 'gen-T', choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }],
    usage: { prompt_tokens: 900, completion_tokens: 12, cost: 0.00042 }, error: { code: 502, message: 'Provider disconnected', metadata: { error_type: 'provider_overloaded' } } });
  const a = await stream('custom', 'openrouter/free', { status: 200, headers: { 'content-type': 'text/event-stream' }, body: chunk({ content: 'Par' }) + err });
  const [u] = usageOf(a.events);
  assert.deepEqual([u.input, u.output, u.costUsd, u.partial], [900, 12, 0.00042, true]);
  assert.equal(last(a.events).error.kind, 'overloaded');
  // The fixture's error chunk carries no usage: none reported, the error as before.
  const b = await stream('custom', 'openrouter/free', fixture('openrouter', 'error-midstream.sse'));
  assert.equal(usageOf(b.events).length, 0);
  assert.equal(last(b.events).error.kind, 'overloaded', 'the error\'s numeric code stands in for the status');
  // Usage seen in an earlier chunk, then the stream ends without [DONE] or a finish: partial, then the cut.
  const c = await stream('custom', 'openrouter/free', { status: 200, headers: { 'content-type': 'text/event-stream' },
    body: chunk({ content: 'Par' }, { usage: { prompt_tokens: 800, completion_tokens: 3 } }) });
  assert.deepEqual(usageOf(c.events).map(x => [x.input, x.output, x.partial]), [[800, 3, true]]);
  assert.equal(last(c.events).error.kind, 'network_after_send');
});

test('OpenAI Responses: response.failed with the response\'s usage reports it, partial, before the error', async () => {
  const ev = (type, d) => `event: ${type}\ndata: ${JSON.stringify({ type, ...d })}\n\n`;
  const body = ev('response.created', { response: { id: 'resp_T', status: 'in_progress', usage: null } })
    + ev('response.output_text.delta', { delta: 'Hel' })
    + ev('response.failed', { response: { id: 'resp_T', status: 'failed', error: { code: 'server_error', message: 'x' }, usage: { input_tokens: 700, output_tokens: 5 } } });
  const { events } = await stream('openai', 'gpt-6-luna', { status: 200, headers: { 'content-type': 'text/event-stream' }, body });
  assert.deepEqual(usageOf(events).map(u => [u.input, u.output, u.partial]), [[700, 5, true]]);
  assert.equal(last(events).type, 'error');
  const failed = await stream('openai', 'gpt-6-luna', fixture('openai', 'failed-rate-limit.sse'));
  assert.equal(last(failed.events).type, 'error', 'a failure with no usage: the error as before');
});

test('stream(req, {onRequest}) hands this call\'s request to its own hook (the backend\'s per-chat Last request), with the method and the key redacted', async () => {
  const mock = await serveOne(fixture('anthropic', 'success.sse'));
  try {
    const both = [];
    const mine = [];
    const { provider } = mockProvider('anthropic', mock.url, { onRequest: r => both.push(r), headers: { 'x-proxy-token': 'tok-123' } });
    await collect(provider.stream(req('claude-haiku-4-5'), { onRequest: r => mine.push(r) }));
    await collect(provider.stream(req('claude-haiku-4-5')));
    assert.equal(both.length, 2, 'the provider-wide hook sees every call');
    assert.equal(mine.length, 1, 'the call\'s own hook only its call');
    assert.equal(mine[0].method, 'POST');
    assert.match(mine[0].url, /\/v1\/messages$/);
    assert.deepEqual(mine[0].body, mock.requests[0].body);
    assert.match(mine[0].headers['x-api-key'], /^sk-ant-…xxxx \(redacted\)$/);
    assert.equal(mine[0].headers['x-proxy-token'], '[redacted]', 'another credential header, whole');
    assert.equal(mine[0].headers['anthropic-version'], '2023-06-01');
    assert.ok(!JSON.stringify(mine).includes(CANARY.anthropic));
  } finally { await mock.close(); }
});

test('redactHeaders: the auth header masked (a short key keeps no characters), credential-shaped headers replaced, the rest kept', () => {
  const m = getManifest('custom'); // Other's Bearer key: an OpenRouter one, say
  const out = redactHeaders({ Authorization: `Bearer ${CANARY.openrouter}`, 'content-type': 'application/json', cookie: 'a=b', 'x-goog-api-key': 'AIzaSomething' }, m);
  assert.equal(out.Authorization, 'Bearer sk-or-v…xxxx (redacted)');
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out.cookie, '[redacted]');
  assert.equal(out['x-goog-api-key'], '[redacted]');
  assert.equal(redactHeaders({ authorization: 'Bearer short' }, m).authorization, 'Bearer … (redacted)');
});

test('reach(): a HEAD with no key; any HTTP answer is reachable, a refused connection is network_before_send', async () => {
  const mock = await serveOne({ status: 401, headers: { 'content-type': 'application/json' }, body: '{}' });
  try {
    const { provider } = mockProvider('anthropic', mock.url);
    assert.deepEqual(await provider.reach(), { ok: true, status: 401 });
    assert.equal(mock.requests[0].method, 'HEAD');
    assert.equal(mock.requests[0].headers['x-api-key'], undefined, 'no key on the probe');
    assert.match(mock.requests[0].url, /^\/v1\/models/);
  } finally { await mock.close(); }
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(r => closed.close(r));
  const r = await mockProvider('anthropic', url).provider.reach();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'network_before_send');
  const ac = new AbortController();
  ac.abort();
  const a = await mockProvider('anthropic', url).provider.reach({ signal: ac.signal });
  assert.deepEqual([a.ok, a.error.kind, a.error.aborted], [false, 'interrupted', true]);
});
