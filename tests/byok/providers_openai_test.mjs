// The Responses adapter for OpenAI and xAI against a local mock (PRD §7.2
// "OpenAI", "xAI", §7.4, §10, PV-4, PV-8): store:false always, encrypted
// reasoning when reasoning is on, the per-install safety_identifier (OpenAI
// only), errors inside the 200 stream, refusals and incompletes, each §10
// status, xAI's key check and its Chat Completions fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { serveOne, startMock, fixture, mockProvider, collect, textOf, last, req, CANARY } from './helpers/mock-provider.mjs';

async function run(id, name, request, opts = {}) {
  const mock = await serveOne({ ...fixture(id, name), ...(opts.spec || {}) });
  try {
    const { provider, lines } = mockProvider(id, mock.url, opts.provider);
    const events = await collect(provider.stream(request));
    return { events, sent: mock.requests[0], lines };
  } finally { await mock.close(); }
}
const luna = (extra) => req('gpt-6-luna', extra);

test('OpenAI success: text, usage (cached split out, reasoning counted), done', async () => {
  const { events, sent } = await run('openai', 'success.sse', luna());
  assert.equal(textOf(events), 'Head to Goldshire.');
  assert.deepEqual(events.find(e => e.type === 'usage').usage, { input: 476, output: 40, cacheRead: 1024, cacheWrite: 0, reasoning: 8, exact: false });
  assert.deepEqual(last(events), { type: 'done', finish: 'stop' });
  assert.equal(sent.url, '/v1/responses');
  assert.equal(sent.headers.authorization, `Bearer ${CANARY.openai}`);
});

test('OpenAI request: store:false, system as the first input item, max_output_tokens, safety_identifier', async () => {
  const { sent } = await run('openai', 'success.sse', luna({ maxTokens: 900 }), { provider: { requestOptions: { store: true } } });
  const b = sent.body;
  assert.equal(b.store, false, 'store:false even if something asks otherwise');
  assert.equal(b.stream, true);
  assert.equal(b.max_output_tokens, 900);
  assert.deepEqual(b.input[0], { role: 'system', content: 'You are NeverQuestAlone, a skeleton guide.\n\nGame data: level 12 warrior in Elwynn.' });
  assert.deepEqual(b.input[1], { role: 'user', content: 'Where do I go next?' });
  assert.equal(b.safety_identifier, '6f1c2a0e-1111-4222-8333-944455556666');
});

test('OpenAI effort (fix-102): Off = reasoning none and no encrypted include; Low to Max = that effort, with encrypted reasoning', async () => {
  const lunaOff = (await run('openai', 'success.sse', luna({ effort: 'off' }))).sent.body;
  assert.deepEqual(lunaOff.reasoning, { effort: 'none' });
  assert.ok(!('include' in lunaOff));
  const lunaLow = (await run('openai', 'success.sse', luna({ effort: 'low' }))).sent.body;
  assert.deepEqual(lunaLow.reasoning, { effort: 'low' }, 'Low is low reasoning, never none');
  assert.deepEqual(lunaLow.include, ['reasoning.encrypted_content']);
  for (const model of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      const b = (await run('openai', 'success.sse', req(model, { effort }))).sent.body;
      assert.deepEqual(b.reasoning, { effort }, `${model} ${effort}`);
      assert.deepEqual(b.include, ['reasoning.encrypted_content'], `${model} ${effort}`);
    }
  }
  const solOff = (await run('openai', 'success.sse', req('gpt-6-sol', { effort: 'off' }))).sent.body;
  assert.deepEqual(solOff.reasoning, { effort: 'none' });
});

test('OpenAI refusal content → done refusal; incomplete content_filter and max_output_tokens', async () => {
  assert.deepEqual(last((await run('openai', 'refusal.sse', luna())).events), { type: 'done', finish: 'refusal' });
  const cf = (await run('openai', 'incomplete-content-filter.sse', luna())).events;
  assert.deepEqual(last(cf), { type: 'done', finish: 'content_filter' });
  assert.ok(cf.some(e => e.type === 'usage'));
  assert.deepEqual(last((await run('openai', 'incomplete-max-tokens.sse', luna())).events), { type: 'done', finish: 'length' });
});

test('OpenAI errors inside the 200: response.failed and the error event', async () => {
  const cases = [
    ['failed-context-length.sse', 'context_too_long'],
    ['failed-rate-limit.sse', 'rate_limited'],
    ['failed-insufficient-quota.sse', 'out_of_credit'],
    ['error-event-misalignment.sse', 'content_blocked'],
  ];
  for (const [name, kind] of cases) {
    const { events, lines } = await run('openai', name, luna());
    assert.equal(last(events).type, 'error', name);
    assert.equal(last(events).error.kind, kind, name);
    assert.doesNotMatch(lines.join('\n'), /exceeds the context|blocked\.|exceeded your current quota/, `${name}: no provider text in the log`);
  }
});

const OPENAI_HTTP = [
  ['http-401-invalid-key.json', 'auth_invalid'],
  ['http-429-credit-exhausted.json', 'out_of_credit'],
  ['http-429-insufficient-quota.json', 'out_of_credit'],
  ['http-429-org-spend-limit.json', 'spend_limit'],
  ['http-429-project-spend-limit.json', 'spend_limit'],
  ['http-429-org-usage-limit.json', 'spend_limit'],
  ['http-429-rate-limit.json', 'rate_limited'],
  ['http-429-slow-down.json', 'rate_limited'],
  ['http-503-overloaded.json', 'overloaded'],
  ['http-500.json', 'overloaded'],
  ['http-403-region.json', 'region_blocked'],
  ['http-403-misalignment.json', 'content_blocked'],
  ['http-400-identifier-blocked.json', 'identifier_blocked'],
  ['http-400-context-length.json', 'context_too_long'],
  ['http-404-model-not-found.json', 'model_not_found'],
];
for (const [name, kind] of OPENAI_HTTP) {
  test(`OpenAI HTTP ${name} → ${kind}`, async () => {
    const { events, lines } = await run('openai', name, luna());
    assert.equal(events.length, 1);
    assert.equal(events[0].error.kind, kind);
    assert.doesNotMatch(lines.join('\n'), /CANARY|Incorrect API key/);
  });
}

test('OpenAI split into 3-byte chunks', async () => {
  const { events } = await run('openai', 'success.sse', luna(), { spec: { splitEvery: 3 } });
  assert.equal(textOf(events), 'Head to Goldshire.');
  assert.equal(last(events).finish, 'stop');
});

test('OpenAI validate() lists models; testCall uses the manifest\'s floor of 16 output tokens', async () => {
  const mock = await startMock((r) => (r.method === 'GET' ? fixture('openai', 'models.json') : fixture('openai', 'success.sse')));
  try {
    const { provider } = mockProvider('openai', mock.url);
    assert.deepEqual(await provider.validate(), { ok: true, models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] });
    const t = await provider.testCall();
    assert.equal(t.ok, true);
    assert.equal(mock.requests[1].body.max_output_tokens, 16);
    assert.equal(mock.requests[1].body.model, 'gpt-6.1-sol', 'the default model (fix-102)');
    assert.deepEqual(mock.requests[1].body.reasoning, { effort: 'low' }, 'its lowest level: GPT-6.1 Sol takes no none');
    await provider.testCall({ model: 'gpt-6-luna' });
    assert.deepEqual(mock.requests[2].body.reasoning, { effort: 'none' }, 'Luna\'s lowest is Off: the key test doesn\'t reason');
  } finally { await mock.close(); }
});

// ---- xAI -------------------------------------------------------------------

test('xAI success through Responses with store:false; no safety_identifier; grok-4.3 takes the Thinking level (SY-47)', async () => {
  const { events, sent } = await run('xai', 'success.sse', req('grok-4.3'));
  assert.equal(textOf(events), 'Grok says hi.');
  assert.equal(sent.url, '/v1/responses');
  assert.equal(sent.body.store, false);
  assert.ok(!('safety_identifier' in sent.body), 'the id goes to OpenAI only');
  assert.deepEqual(sent.body.reasoning, { effort: 'low' }, 'xAI documents reasoning effort for grok-4.3');
  assert.equal(sent.headers.authorization, `Bearer ${CANARY.xai}`);
});

test('xAI grok-4.7 effort maps to reasoning.effort with encrypted reasoning included', async () => {
  const { sent } = await run('xai', 'success.sse', req('grok-4.7', { effort: 'high' }));
  assert.deepEqual(sent.body.reasoning, { effort: 'high' });
  assert.deepEqual(sent.body.include, ['reasoning.encrypted_content']);
});

test('xAI Chat Completions fallback (useAltAdapter): no store (a Responses parameter, unverified there)', async () => {
  const { events, sent } = await run('xai', 'chat-success.sse', req('grok-4.3'), { provider: { useAltAdapter: true } });
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(textOf(events), 'Grok fallback.');
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  assert.ok(!('store' in sent.body));
  assert.ok(!('reasoning' in sent.body), 'never the Responses reasoning object on the fallback');
  assert.equal(sent.body.reasoning_effort, 'low', 'grok-4.3 takes a top-level reasoning_effort there (SY-47)');
});

test('xAI fallback on grok-4.7: effort is a top-level reasoning_effort, never the Responses reasoning object', async () => {
  for (const effort of ['low', 'medium', 'high']) {
    const { sent } = await run('xai', 'chat-success.sse', req('grok-4.7', { effort }), { provider: { useAltAdapter: true } });
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.body.reasoning_effort, effort);
    for (const k of ['reasoning', 'include', 'store', 'safety_identifier']) assert.ok(!(k in sent.body), `${effort}: no ${k}`);
  }
  const main = (await run('xai', 'success.sse', req('grok-4.7', { effort: 'low' }))).sent.body;
  assert.deepEqual([main.reasoning, main.store, 'reasoning_effort' in main], [{ effort: 'low' }, false, false], 'the Responses path is unchanged');
});

for (const [name, kind] of [['http-403-spending-limit.json', 'out_of_credit'], ['http-401.json', 'auth_invalid'], ['http-429.json', 'rate_limited'], ['http-404.json', 'model_not_found'], ['http-500.json', 'overloaded']]) {
  test(`xAI HTTP ${name} → ${kind}`, async () => {
    const { events } = await run('xai', name, req('grok-4.3'));
    assert.equal(events[0].error.kind, kind);
  });
}

test('xAI validate(): GET /v1/api-key first; a disabled key is auth_invalid', async () => {
  let keyFixture = 'api-key.json';
  const mock = await startMock((r) => (r.url === '/v1/api-key' ? fixture('xai', keyFixture) : fixture('xai', 'models.json')));
  try {
    const { provider } = mockProvider('xai', mock.url);
    assert.deepEqual(await provider.validate(), { ok: true, models: ['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-4.20-0309-reasoning', 'grok-4.20-0309-non-reasoning'] });
    assert.deepEqual(mock.requests.map(r => r.url), ['/v1/api-key', '/v1/models']);
    keyFixture = 'api-key-disabled.json';
    const bad = await provider.validate();
    assert.equal(bad.ok, false);
    assert.deepEqual([bad.error.kind, bad.error.code], ['auth_invalid', 'api_key_disabled']);
  } finally { await mock.close(); }
});

test('the output ceiling is finish "length" on every OpenAI-style path (fix-empty-reply): Responses cut at max_output_tokens with only reasoning, and Chat Completions\' length, or Gemini\'s MAX_TOKENS a gateway passes on', async () => {
  const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const reasoningOnly = sse('response.output_item.added', { output_index: 0, item: { id: 'rs_1', type: 'reasoning' } })
    + sse('response.output_item.done', { output_index: 0, item: { id: 'rs_1', type: 'reasoning' } })
    + sse('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 900, output_tokens: 3248, output_tokens_details: { reasoning_tokens: 3248 } } } });
  for (const id of ['openai', 'xai']) {
    const { events } = await run(id, 'success.sse', req(id === 'openai' ? 'gpt-6.1-sol' : 'grok-4.7'), { spec: { body: reasoningOnly } });
    assert.equal(textOf(events), '', id);
    assert.deepEqual(last(events), { type: 'done', finish: 'length' }, id);
  }
  const chunk = (d, finish) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: d, finish_reason: finish }] })}\n\n`;
  for (const reason of ['length', 'max_tokens', 'MAX_TOKENS', 'stop']) {
    const body = chunk({ role: 'assistant', reasoning_content: 'thinking' }, null) + chunk({}, reason) + 'data: [DONE]\n\n';
    const mock = await serveOne({ status: 200, headers: { 'content-type': 'text/event-stream' }, body });
    try {
      for (const id of ['google', 'xai']) {
        const { provider } = mockProvider(id, mock.url, id === 'xai' ? { useAltAdapter: true } : {});
        const events = await collect(provider.stream(req(id === 'google' ? 'gemini-3.8-flash' : 'grok-4.7')));
        assert.deepEqual(last(events), { type: 'done', finish: reason === 'stop' ? 'stop' : 'length' }, `${id} ${reason}`);
      }
    } finally { await mock.close(); }
  }
  // Not streamed (a server that ignored stream:true): the same.
  const whole = await serveOne({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'max_tokens' }] }) });
  try {
    const { provider } = mockProvider('google', whole.url);
    assert.deepEqual(last(await collect(provider.stream(req('gemini-3.8-flash')))), { type: 'done', finish: 'length' });
  } finally { await whole.close(); }
});
