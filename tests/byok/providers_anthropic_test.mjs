// The Anthropic adapter against a local mock (PRD §7.2 "Anthropic", §7.3,
// §7.4, §10, PV-4, PV-6, PV-8): request shape (no sampling params, 1-hour
// cache_control on the prefix, effort, headers), streaming text and usage with
// cache fields, stop reasons, a mid-stream error after a 200, each §10 status,
// validate() and testCall().
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveOne, startMock, fixture, mockProvider, collect, textOf, last, req, CANARY } from './helpers/mock-provider.mjs';
import { createProvider } from '../../bridge/byok/providers/index.mjs';

const ID = 'anthropic';

async function run(name, request = req('claude-haiku-4-5'), opts = {}) {
  const mock = await serveOne({ ...fixture(ID, name), ...(opts.spec || {}) });
  try {
    const { provider, lines } = mockProvider(ID, mock.url, opts.provider);
    const events = await collect(provider.stream(request));
    return { events, sent: mock.requests[0], lines };
  } finally { await mock.close(); }
}

test('success: text, usage with 1-hour cache writes, done', async () => {
  const { events, sent, lines } = await run('success.sse');
  assert.equal(events[0].type, 'start');
  assert.equal(textOf(events), 'Hello, adventurer. 🦴');
  const usage = events.find(e => e.type === 'usage').usage;
  assert.deepEqual(usage, { input: 1200, output: 12, cacheRead: 0, cacheWrite: 4100, cacheWrite1h: 4100, reasoning: 0, exact: false });
  assert.deepEqual(last(events), { type: 'done', finish: 'stop' });
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/messages');
  assert.ok(lines.some(l => l.includes('"kind":"provider.usage"') && l.includes('"cacheWrite":4100')), 'cache usage is logged (PV-6)');
});

test('request: x-api-key and anthropic-version headers; the key only in its header', async () => {
  const { sent } = await run('success.sse');
  assert.equal(sent.headers['x-api-key'], CANARY.anthropic);
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal(sent.headers.authorization, undefined);
  assert.ok(!sent.url.includes('CANARY') && !sent.raw.includes('CANARY'));
});

test('request: the cached prefix carries cache_control ttl 1h; volatile blocks carry none; no sampling params', async () => {
  // Haiku 4.5 with no thinking level (a 1.0.x setup saved none): no thinking fields at all.
  const { sent } = await run('success.sse', req('claude-haiku-4-5', { maxTokens: 777, effort: null }), { provider: { requestOptions: { temperature: 0.2, top_p: 0.9, top_k: 5 } } });
  const b = sent.body;
  assert.deepEqual(b.system, [
    { type: 'text', text: 'You are NeverQuestAlone, a skeleton guide.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    { type: 'text', text: 'Game data: level 12 warrior in Elwynn.' },
  ]);
  assert.equal(b.stream, true);
  assert.equal(b.max_tokens, 777);
  assert.equal(b.model, 'claude-haiku-4-5');
  assert.deepEqual(b.messages, [{ role: 'user', content: 'Where do I go next?' }]);
  for (const k of ['temperature', 'top_p', 'top_k']) assert.ok(!(k in b), `${k} is never sent`);
  assert.ok(!('thinking' in b) && !('output_config' in b), 'Haiku with no level: thinking off, no effort field (it has none)');
});

test('request: at most 4 cache breakpoints, the last ones win; 5m TTL on request', async () => {
  const system = Array.from({ length: 6 }, (_, i) => ({ text: `block ${i}`, cache: true }));
  const { sent } = await run('success.sse', req('claude-haiku-4-5', { system, cacheTtl: '5m' }));
  const marked = sent.body.system.map(s => !!s.cache_control);
  assert.deepEqual(marked, [false, false, true, true, true, true]);
  assert.deepEqual(sent.body.system[5].cache_control, { type: 'ephemeral' });
});

test('effort on Sonnet 5 (§7.4, fix-102): Off = thinking disabled at effort low; Low to Max = output_config.effort alone', async () => {
  const off = (await run('success.sse', req('claude-sonnet-5', { effort: 'off' }))).sent.body;
  assert.deepEqual(off.output_config, { effort: 'low' });
  assert.deepEqual(off.thinking, { type: 'disabled' });
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const b = (await run('success.sse', req('claude-sonnet-5', { effort: level }))).sent.body;
    assert.deepEqual(b.output_config, { effort: level }, level);
    assert.ok(!('thinking' in b), `${level}: adaptive thinking, the model's default`);
  }
  const none = (await run('success.sse', req('claude-sonnet-5', { effort: null }))).sent.body;
  assert.ok(!('output_config' in none) && !('thinking' in none));
});

// Anthropic's docs (2026-09-30): Sonnet 5.5 refuses thinking disabled; between_tools (no other field)
// turns up-front thinking off at effort high or below. Opus 5.5 and Fable 5.1 always think. Haiku 4.5
// has extended thinking only: thinking enabled with budget_tokens (at least 1,024, below max_tokens).
test('effort on the rest of the lineup (fix-102): Sonnet 5.5\'s Off is between_tools alone; Opus 5.5 and Fable 5.1 by effort; Haiku 4.5 by budget', async () => {
  const off = (await run('success.sse', req('claude-sonnet-5-5', { effort: 'off' }))).sent.body;
  assert.deepEqual(off.thinking, { type: 'between_tools' }, 'no display, budget or binding field with it (the API refuses them)');
  assert.deepEqual(off.output_config, { effort: 'low' }, 'between_tools only at high or below');
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    for (const model of ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1']) {
      const b = (await run('success.sse', req(model, { effort: level }))).sent.body;
      assert.deepEqual(b.output_config, { effort: level }, `${model} ${level}`);
      assert.ok(!('thinking' in b), `${model} ${level}: adaptive, never disabled or enabled (both refused)`);
    }
  }
  const haikuOff = (await run('success.sse', req('claude-haiku-4-5', { effort: 'off' }))).sent.body;
  assert.ok(!('thinking' in haikuOff) && !('output_config' in haikuOff), 'Haiku\'s Off: its default, no thinking');
  const haikuLow = (await run('success.sse', req('claude-haiku-4-5', { effort: 'low', maxTokens: 1200 + 2048 }))).sent.body;
  assert.deepEqual(haikuLow.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(haikuLow.max_tokens, 3248, 'the reply\'s 1,200 on top of the budget (buildRequest\'s room)');
  assert.ok(!('output_config' in haikuLow), 'Haiku takes no effort field');
  // A caller that asks for less than the budget: the reply's ceiling still goes on top, never a 400.
  const tight = (await run('success.sse', req('claude-haiku-4-5', { effort: 'max', maxTokens: 777 }))).sent.body;
  assert.deepEqual(tight.thinking, { type: 'enabled', budget_tokens: 62800 }, 'Max: its 64K less the reply\'s 1,200 (SY-102-6)');
  assert.equal(tight.max_tokens, 62800 + 777);
  const full = (await run('success.sse', req('claude-haiku-4-5', { effort: 'max', maxTokens: 64000 }))).sent.body;
  assert.deepEqual([full.thinking.budget_tokens, full.max_tokens], [62800, 64000], 'buildRequest\'s Max, held to its 64K: the budget stays under it');
});

test('extra headers (anthropic-workspace-id for unscoped keys)', async () => {
  const { sent } = await run('success.sse', undefined, { provider: { headers: { 'anthropic-workspace-id': 'wrkspc_FIXTURE' } } });
  assert.equal(sent.headers['anthropic-workspace-id'], 'wrkspc_FIXTURE');
});

test('thinking blocks (omitted display) are progress, not text; cache reads counted', async () => {
  const { events } = await run('success-thinking.sse', req('claude-sonnet-5', { effort: 'medium' }));
  assert.equal(textOf(events), 'Go north.');
  assert.equal(events.find(e => e.type === 'usage').usage.cacheRead, 4100);
  assert.ok(!events.some(e => e.type === 'progress' || e.type === 'thinking'), 'progress and thinking marks never leave the provider');
});

test('stop reasons: refusal, max_tokens, model_context_window_exceeded', async () => {
  const refusal = (await run('refusal.sse')).events;
  assert.deepEqual(last(refusal), { type: 'done', finish: 'refusal' });
  assert.ok(refusal.some(e => e.type === 'usage'), 'a refusal may be billed: usage still reported');
  assert.deepEqual(last((await run('max-tokens.sse')).events), { type: 'done', finish: 'length' });
  const cw = last((await run('context-window-exceeded.sse')).events);
  assert.equal(cw.type, 'error');
  assert.equal(cw.error.kind, 'context_too_long');
});

test('an error event after a 200 (overloaded mid-stream)', async () => {
  const { events, lines } = await run('error-overloaded-midstream.sse');
  assert.equal(textOf(events), 'Hel');
  const e = last(events);
  assert.equal(e.type, 'error');
  assert.equal(e.error.kind, 'overloaded');
  assert.equal(e.error.retryable, true);
  assert.equal(e.error.status, 200);
  assert.ok(lines.some(l => l.includes('"kind":"provider.error"') && l.includes('overloaded_error')));
});

test('a stream cut mid-event is network_after_send', async () => {
  const { events } = await run('truncated.sse');
  assert.equal(last(events).error.kind, 'network_after_send');
  assert.equal(last(events).error.retryable, false);
});

test('split into 1-byte chunks: same text and usage', async () => {
  const { events } = await run('success.sse', undefined, { spec: { splitEvery: 1 } });
  assert.equal(textOf(events), 'Hello, adventurer. 🦴');
  assert.deepEqual(last(events), { type: 'done', finish: 'stop' });
});

const HTTP = [
  ['http-401-authentication.json', 'auth_invalid'],
  ['http-402-billing.json', 'out_of_credit'],
  ['http-400-credit-low.json', 'out_of_credit'],
  ['http-400-usage-limits.json', 'spend_limit'],
  ['http-400-workspace-usage-limits.json', 'spend_limit'],
  ['http-429-rate-limit.json', 'rate_limited'],
  ['http-429-spend-limit.json', 'spend_limit'],
  ['http-529-overloaded.json', 'overloaded'],
  ['http-500-api-error.json', 'overloaded'],
  ['http-404-not-found.json', 'model_not_found'],
  ['http-400-prompt-too-long.json', 'context_too_long'],
  ['http-403-permission.json', 'bad_request'],
];
for (const [name, kind] of HTTP) {
  test(`HTTP ${name} → ${kind}, one error event, body kept off the log`, async () => {
    const { events, lines } = await run(name);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].error.kind, kind);
    assert.ok(events[0].error.body, 'body in memory');
    const log = lines.join('\n');
    assert.doesNotMatch(log, /credit balance|usage limits|prompt is too long|invalid x-api-key|CANARY/);
  });
}

test('rate-limit headers ride on the start event (US-3)', async () => {
  const { events } = await run('success.sse', undefined, { spec: { headers: { 'content-type': 'text/event-stream', 'request-id': 'req_START', 'anthropic-ratelimit-requests-remaining': '41', 'anthropic-ratelimit-requests-limit': '50' } } });
  assert.equal(events[0].requestId, 'req_START');
  assert.equal(events[0].rateLimit.requests.remaining, 41);
});

test('validate() lists models (GET /v1/models?limit=1000) and follows pagination', async () => {
  let page = 0;
  const mock = await startMock((r) => {
    page += 1;
    if (page === 1) return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }], has_more: true, last_id: 'claude-sonnet-5-5' }) };
    return fixture(ID, 'models.json');
  });
  try {
    const { provider } = mockProvider(ID, mock.url);
    const r = await provider.validate();
    assert.equal(r.ok, true);
    assert.deepEqual(r.models, ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], 'both pages, each id once');
    assert.equal(mock.requests[0].url, '/v1/models?limit=1000');
    assert.equal(mock.requests[1].url, '/v1/models?limit=1000&after_id=claude-sonnet-5-5');
    assert.equal(mock.requests[0].headers['x-api-key'], CANARY.anthropic);
  } finally { await mock.close(); }
});

test('validate() pages from a models path with no query: page 3 is still a well-formed URL', async () => {
  const pages = [
    { data: [{ id: 'a' }], has_more: true, last_id: 'a' },
    { data: [{ id: 'b' }], has_more: true, last_id: 'b' },
    { data: [{ id: 'c' }], has_more: false, last_id: 'c' },
  ];
  const mock = await startMock((r) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(pages[mock.requests.length - 1]) }));
  try {
    const m = mockProvider(ID, mock.url).manifest;
    const provider = createProvider({ ...m, paths: { ...m.paths, models: '/models' } }, { getKey: async () => CANARY.anthropic });
    const r = await provider.validate();
    assert.deepEqual(r, { ok: true, models: ['a', 'b', 'c'] });
    assert.deepEqual(mock.requests.map(q => q.url), ['/v1/models', '/v1/models?after_id=a', '/v1/models?after_id=b']);
  } finally { await mock.close(); }
});

test('validate() with a bad key → auth_invalid', async () => {
  const mock = await serveOne(fixture(ID, 'http-401-authentication.json'));
  try {
    const r = await mockProvider(ID, mock.url).provider.validate();
    assert.equal(r.ok, false);
    assert.equal(r.error.kind, 'auth_invalid');
  } finally { await mock.close(); }
});

test('testCall() sends a 1-token request at the model\'s lowest thinking level: Off where it has one, so a key test doesn\'t think (fix-102)', async () => {
  const sent = async (model) => {
    const mock = await serveOne(fixture(ID, 'max-tokens.sse'));
    try {
      const r = await mockProvider(ID, mock.url).provider.testCall(model ? { model } : {});
      assert.equal(r.ok, true, model);
      assert.equal(r.finish, 'length', model);
      return mock.requests[0].body;
    } finally { await mock.close(); }
  };
  const b = await sent('claude-sonnet-5');
  assert.equal(b.max_tokens, 1);
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.deepEqual(b.output_config, { effort: 'low' });
  // The default model, Claude Sonnet 5.5: between_tools (its Off) at effort low.
  const d = await sent(null);
  assert.equal(d.model, 'claude-sonnet-5-5');
  assert.equal(d.max_tokens, 1);
  assert.deepEqual(d.thinking, { type: 'between_tools' });
  assert.deepEqual(d.output_config, { effort: 'low' });
  // Opus 5.5 always thinks: its lowest level, effort low, and a thinking stop is still a passing test.
  const o = await sent('claude-opus-5-5');
  assert.deepEqual(o.output_config, { effort: 'low' });
  assert.ok(!('thinking' in o));
  // Haiku 4.5: Off, no thinking field (a budget would need max_tokens above 1,024).
  const h = await sent('claude-haiku-4-5');
  assert.equal(h.max_tokens, 1);
  assert.ok(!('thinking' in h) && !('output_config' in h));
});

test('no key in the keychain → no_key (missing_key), never auth_invalid, and no request is made', async () => {
  const mock = await serveOne(fixture(ID, 'success.sse'));
  try {
    const { provider } = mockProvider(ID, mock.url, { getKey: async () => null });
    const events = await collect(provider.stream(req('claude-haiku-4-5')));
    assert.deepEqual([events.length, events[0].error.kind, events[0].error.code, events[0].error.retryable], [1, 'no_key', 'missing_key', false]);
    const v = await provider.validate();
    assert.deepEqual([v.ok, v.error.kind, v.error.code], [false, 'no_key', 'missing_key']);
    assert.equal(mock.requests.length, 0);
  } finally { await mock.close(); }
});
