// The provider wrapper's stream behavior (PRD §7.5, §10, DB20, KY-3, KY-7,
// KY-8): first-token, idle and run timeouts, and silent reasoning that is
// neither; the caller's abort; network failures before vs after the request
// left; the egress guard's refusal; redirects refused so a key can't follow
// one; a request that can't be built; a missing or unreadable key; keys and
// bodies never in logs or errors; the "Last request" view redacted; early exit
// releases the connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { serveOne, startMock, fixture, mockProvider, collect, textOf, last, req, CANARY } from './helpers/mock-provider.mjs';

const FAST = { firstTokenMs: 150, idleMs: 150, runMs: 600, requestMs: 300 };
const haiku = () => req('claude-haiku-4-5');

async function closedPort() {
  const srv = net.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise(r => srv.close(r));
  return port;
}

test('no response headers within the first-token window → timeout (first_token)', async () => {
  const mock = await serveOne({ hangBeforeHeaders: true });
  try {
    const { provider } = mockProvider('anthropic', mock.url, { timeouts: FAST });
    const t0 = Date.now();
    const events = await collect(provider.stream(haiku()));
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(events.length, 1);
    assert.deepEqual([events[0].error.kind, events[0].error.phase, events[0].error.afterMs, events[0].error.retryable], ['timeout', 'first_token', 150, false]);
  } finally { await mock.close(); }
});

test('headers but no token → timeout (first_token)', async () => {
  const body = fixture('anthropic', 'success.sse').body.split('event: content_block_start')[0];
  const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body, hangAfterBody: true });
  try {
    const events = await collect(mockProvider('anthropic', mock.url, { timeouts: FAST }).provider.stream(haiku()));
    assert.equal(events[0].type, 'start');
    assert.deepEqual([last(events).error.kind, last(events).error.phase], ['timeout', 'first_token']);
  } finally { await mock.close(); }
});

test('tokens, then silence → timeout (idle); the partial text was delivered', async () => {
  const full = fixture('anthropic', 'success.sse').body;
  const body = full.slice(0, full.indexOf('event: content_block_stop'));
  const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body, hangAfterBody: true });
  try {
    const events = await collect(mockProvider('anthropic', mock.url, { timeouts: { ...FAST, firstTokenMs: 3000 } }).provider.stream(haiku()));
    assert.equal(textOf(events), 'Hello, adventurer. 🦴');
    assert.deepEqual([last(events).error.kind, last(events).error.phase, last(events).error.afterMs], ['timeout', 'idle', 150]);
  } finally { await mock.close(); }
});

test('a steady trickle that never ends → timeout (run) at the wall-clock limit', async () => {
  const delta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"."}}\n\n';
  const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: delta.repeat(400), splitEvery: delta.length, chunkDelayMs: 50 });
  try {
    const t0 = Date.now();
    const events = await collect(mockProvider('anthropic', mock.url, { timeouts: { ...FAST, firstTokenMs: 3000, idleMs: 1000 } }).provider.stream(haiku()));
    const took = Date.now() - t0;
    assert.ok(took >= 550 && took < 5000, String(took));
    assert.deepEqual([last(events).error.kind, last(events).error.phase], ['timeout', 'run']);
    assert.ok(textOf(events).length > 3);
  } finally { await mock.close(); }
});

test('a slow consumer is not a stalled provider', async () => {
  const mock = await serveOne(fixture('anthropic', 'success.sse'));
  try {
    const { provider } = mockProvider('anthropic', mock.url, { timeouts: { ...FAST, runMs: 5000 } });
    const events = [];
    for await (const ev of provider.stream(haiku())) {
      events.push(ev);
      if (ev.type === 'text') await new Promise(r => setTimeout(r, 250)); // longer than idleMs
    }
    assert.deepEqual(last(events), { type: 'done', finish: 'stop' });
  } finally { await mock.close(); }
});

test('the caller aborts mid-stream → interrupted (aborted), and the connection is closed', async () => {
  const delta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n';
  const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: delta.repeat(200), splitEvery: delta.length, chunkDelayMs: 20 });
  try {
    const ac = new AbortController();
    const events = [];
    for await (const ev of mockProvider('anthropic', mock.url).provider.stream(haiku(), { signal: ac.signal })) {
      events.push(ev);
      if (ev.type === 'text' && events.length === 3) ac.abort();
    }
    const e = last(events);
    assert.deepEqual([e.type, e.error.kind, e.error.aborted, e.error.retryable], ['error', 'interrupted', true, false]);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(mock.requests[0].clientClosed, true, 'the socket was torn down, not left streaming');
  } finally { await mock.close(); }
});

test('an already-aborted signal makes no request', async () => {
  const mock = await serveOne(fixture('anthropic', 'success.sse'));
  try {
    const events = await collect(mockProvider('anthropic', mock.url).provider.stream(haiku(), { signal: AbortSignal.abort() }));
    assert.equal(events[0].error.kind, 'interrupted');
    assert.equal(mock.requests.length, 0);
  } finally { await mock.close(); }
});

test('the consumer breaking early releases the connection', async () => {
  const delta = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"y"}}\n\n';
  const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: delta.repeat(200), splitEvery: delta.length, chunkDelayMs: 20 });
  try {
    for await (const ev of mockProvider('anthropic', mock.url).provider.stream(haiku())) if (ev.type === 'text') break;
    await new Promise(r => setTimeout(r, 100));
    assert.equal(mock.requests[0].clientClosed, true);
  } finally { await mock.close(); }
});

test('connection refused on a cloud host → network_before_send (safe to resend: it never left)', async () => {
  const port = await closedPort();
  const { provider } = mockProvider('anthropic', `http://127.0.0.1:${port}`);
  const events = await collect(provider.stream(haiku()));
  assert.deepEqual([events[0].error.kind, events[0].error.retryable, events[0].error.code], ['network_before_send', true, 'ECONNREFUSED']);
});

test('DNS failure (injected fetch) → network_before_send', async () => {
  const fetchFn = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.anthropic.com'), { code: 'ENOTFOUND' }) }); };
  const events = await collect(mockProvider('anthropic', 'https://api.anthropic.com', { fetch: fetchFn }).provider.stream(haiku()));
  assert.deepEqual([events[0].error.kind, events[0].error.code], ['network_before_send', 'ENOTFOUND']);
});

test('the server drops the connection after reading the request → network_after_send (no auto-resend)', async () => {
  const mock = await serveOne({ destroyBeforeHeaders: true });
  try {
    const events = await collect(mockProvider('anthropic', mock.url).provider.stream(haiku()));
    assert.deepEqual([events[0].error.kind, events[0].error.retryable], ['network_after_send', false]);
    assert.equal(mock.requests.length, 1, 'the request did reach the server');
  } finally { await mock.close(); }
});

test('the connection drops mid-stream → network_after_send after the partial text', async () => {
  const full = fixture('anthropic', 'success.sse').body;
  const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: full.slice(0, full.indexOf('event: content_block_stop')), destroyAfterBody: true });
  try {
    const events = await collect(mockProvider('anthropic', mock.url).provider.stream(haiku()));
    assert.equal(textOf(events), 'Hello, adventurer. 🦴');
    assert.equal(last(events).error.kind, 'network_after_send');
  } finally { await mock.close(); }
});

test('redirects are refused: the key never follows one to another host, and it isn\'t called a dropped connection', async () => {
  const thief = await startMock(() => fixture('anthropic', 'success.sse'));
  for (const status of [301, 302, 307, 308]) {
    const mock = await serveOne({ status, redirect: `${thief.url}/v1/messages` });
    try {
      const events = await collect(mockProvider('anthropic', mock.url).provider.stream(haiku()));
      assert.equal(events.length, 1);
      assert.deepEqual([events[0].error.kind, events[0].error.code, events[0].error.status, events[0].error.retryable], ['unknown', 'redirect_refused', status, false]);
      const v = await mockProvider('anthropic', mock.url).provider.validate();
      assert.deepEqual([v.ok, v.error.code], [false, 'redirect_refused']);
    } finally { await mock.close(); }
  }
  assert.equal(thief.requests.length, 0, 'the second host saw nothing');
  await thief.close();
});

test('an egress-guard block (KY-7) → egress_blocked, not a network outage, never retried', async () => {
  const fetchFn = async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('host not in the allowlist'), { code: 'EGRESS_BLOCKED' }) }); };
  for (const [id, model] of [['anthropic', 'claude-haiku-4-5'], ['google', 'gemini-3.8-flash']]) {
    const { provider, lines } = mockProvider(id, 'http://127.0.0.1:9', { fetch: fetchFn });
    const events = await collect(provider.stream(req(model)));
    assert.deepEqual([events[0].error.kind, events[0].error.code, events[0].error.retryable], ['egress_blocked', 'EGRESS_BLOCKED', false], id);
    assert.ok(lines.some(l => l.includes('"errorKind":"egress_blocked"')));
    assert.equal((await provider.validate()).error.kind, 'egress_blocked');
  }
});

test('a request that can\'t be built → unknown (bad_request_shape), and nothing is sent', async () => {
  const mock = await serveOne(fixture('anthropic', 'success.sse'));
  try {
    const { provider, lines } = mockProvider('anthropic', mock.url);
    for (const bad of [{ system: 'a string, not blocks' }, { messages: 'nope' }, { maxTokens: 10n }]) {
      const events = await collect(provider.stream(req('claude-haiku-4-5', bad)));
      assert.equal(events.length, 1);
      assert.deepEqual([events[0].error.kind, events[0].error.code, events[0].error.retryable], ['unknown', 'bad_request_shape', false], JSON.stringify(Object.keys(bad)));
    }
    const badHeader = mockProvider('anthropic', mock.url, { getKey: async () => `${CANARY.anthropic}\nx-evil: 1` }).provider;
    const e = (await collect(badHeader.stream(haiku())))[0].error;
    assert.deepEqual([e.kind, e.code], ['unknown', 'bad_request_shape'], 'a header fetch would refuse');
    assert.ok(!JSON.stringify(e).includes('CANARY') && !lines.join('').includes('CANARY'), 'the thrown message quoted the key; it is dropped');
    assert.equal(mock.requests.length, 0);
  } finally { await mock.close(); }
});

test('keys never reach a log line, an error object or the start event', async () => {
  for (const [id, model, name] of [['anthropic', 'claude-haiku-4-5', 'http-401-authentication.json'], ['openai', 'gpt-6-luna', 'http-401-invalid-key.json'], ['google', 'gemini-3.8-flash', 'http-400-invalid-key.json'], ['xai', 'grok-4.3', 'http-401.json']]) {
    for (const spec of [fixture(id, name), { destroyBeforeHeaders: true }]) {
      const mock = await serveOne(spec);
      try {
        const { provider, lines } = mockProvider(id, mock.url);
        const events = await collect(provider.stream(req(model)));
        const everything = JSON.stringify(events) + lines.join('\n');
        assert.ok(!everything.includes(CANARY[id]), `${id}: canary leaked`);
        assert.ok(!everything.includes('CANARY'), `${id}: key fragment leaked`);
        assert.equal(mock.requests[0]?.raw.includes(CANARY[id]) ?? false, false, `${id}: key in the request body`);
      } finally { await mock.close(); }
    }
  }
});

test('the "Last request" view (KY-8) gets the exact body with the auth header redacted', async () => {
  const mock = await serveOne(fixture('openai', 'success.sse'));
  try {
    const seen = [];
    const { provider } = mockProvider('openai', mock.url, { onRequest: (r) => seen.push(r) });
    await collect(provider.stream(req('gpt-6-luna')));
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].body, mock.requests[0].body, 'exactly what went to the provider');
    assert.match(seen[0].headers.authorization, /^Bearer sk-proj…xxxx \(redacted\)$/);
    assert.ok(!JSON.stringify(seen).includes(CANARY.openai));
  } finally { await mock.close(); }
});

test('a throwing getKey is keystore_error (no_key), never a rejected key', async () => {
  const mock = await serveOne(fixture('anthropic', 'success.sse'));
  try {
    const { provider, lines } = mockProvider('anthropic', mock.url, { getKey: async () => { throw new Error('keychain locked'); } });
    const events = await collect(provider.stream(haiku()));
    assert.deepEqual([events[0].error.kind, events[0].error.code, events[0].error.retryable], ['no_key', 'keystore_error', false]);
    const v = await provider.validate();
    assert.deepEqual([v.error.kind, v.error.code], ['no_key', 'keystore_error']);
    assert.doesNotMatch(lines.join('\n'), /keychain locked|auth_invalid/);
    assert.equal(mock.requests.length, 0);
  } finally { await mock.close(); }
});

// ---- silent reasoning (§7.5) ---------------------------------------------------

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const ANTHROPIC_HEAD = sse('message_start', { message: { id: 'msg_T', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 10, output_tokens: 1 } } });
const ANTHROPIC_THINK = sse('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
const ANTHROPIC_TAIL = sse('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'EqQB' } })
  + sse('content_block_stop', { index: 0 })
  + sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
  + sse('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'Go north.' } })
  + sse('content_block_stop', { index: 1 })
  + sse('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 900 } })
  + sse('message_stop', {});
const SSE_HEADERS = { 'content-type': 'text/event-stream' };

test('a hidden thinking block longer than the first-token and idle windows is not a stall', async () => {
  // 700 ms of silence: past both the first-token (400) and idle (150) windows.
  const mock = await serveOne({ status: 200, headers: SSE_HEADERS, script: [[0, ANTHROPIC_HEAD + ANTHROPIC_THINK], [700, ANTHROPIC_TAIL]] });
  try {
    const events = await collect(mockProvider('anthropic', mock.url, { timeouts: { ...FAST, firstTokenMs: 400, runMs: 5000 } }).provider.stream(req('claude-sonnet-5', { effort: 'high' })));
    assert.equal(textOf(events), 'Go north.');
    assert.deepEqual(last(events), { type: 'done', finish: 'stop' });
    assert.ok(!events.some(e => e.type === 'thinking'), 'the mark stays inside the provider layer');
  } finally { await mock.close(); }
});

test('after the thinking block ends, the idle timer is back', async () => {
  const afterThink = sse('content_block_stop', { index: 0 }) + sse('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
  const mock = await serveOne({ status: 200, headers: SSE_HEADERS, script: [[0, ANTHROPIC_HEAD + ANTHROPIC_THINK], [50, afterThink], [2000, ANTHROPIC_TAIL]] });
  try {
    const events = await collect(mockProvider('anthropic', mock.url, { timeouts: { ...FAST, firstTokenMs: 1000, runMs: 5000 } }).provider.stream(req('claude-sonnet-5', { effort: 'high' })));
    assert.deepEqual([last(events).error.kind, last(events).error.phase], ['timeout', 'idle']);
  } finally { await mock.close(); }
});

test('silent thinking that never ends is still bounded by the run timer', async () => {
  const mock = await serveOne({ status: 200, headers: SSE_HEADERS, body: ANTHROPIC_HEAD + ANTHROPIC_THINK, hangAfterBody: true });
  try {
    const t0 = Date.now();
    const events = await collect(mockProvider('anthropic', mock.url, { timeouts: { ...FAST, firstTokenMs: 300, runMs: 900 } }).provider.stream(req('claude-sonnet-5', { effort: 'high' })));
    assert.ok(Date.now() - t0 >= 850);
    assert.deepEqual([last(events).error.kind, last(events).error.phase], ['timeout', 'run']);
  } finally { await mock.close(); }
});

test('an OpenAI reasoning item with no summary is not a stall either', async () => {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const head = ev('response.created', { response: { id: 'resp_T', status: 'in_progress' } })
    + ev('response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } });
  const tail = ev('response.output_item.done', { output_index: 0, item: { id: 'rs_1', type: 'reasoning', summary: [] } })
    + ev('response.output_item.added', { output_index: 1, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } })
    + ev('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'Head to Goldshire.' })
    + ev('response.completed', { response: { id: 'resp_T', status: 'completed', usage: { input_tokens: 10, output_tokens: 300, output_tokens_details: { reasoning_tokens: 290 } } } });
  const mock = await serveOne({ status: 200, headers: SSE_HEADERS, script: [[0, head], [700, tail]] });
  try {
    const events = await collect(mockProvider('openai', mock.url, { timeouts: { ...FAST, firstTokenMs: 400, runMs: 5000 } }).provider.stream(req('gpt-6-sol', { effort: 'high' })));
    assert.equal(textOf(events), 'Head to Goldshire.');
    assert.equal(events.find(e => e.type === 'usage').usage.reasoning, 290);
    assert.deepEqual(last(events), { type: 'done', finish: 'stop' });
  } finally { await mock.close(); }
});

test('validate() has its own request timeout', async () => {
  const mock = await serveOne({ hangBeforeHeaders: true });
  try {
    const r = await mockProvider('anthropic', mock.url, { timeouts: FAST }).provider.validate();
    assert.deepEqual([r.ok, r.error.kind, r.error.phase], [false, 'timeout', 'request']);
  } finally { await mock.close(); }
});
