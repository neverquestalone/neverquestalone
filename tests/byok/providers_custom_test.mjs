// Other (custom): any OpenAI-compatible Chat Completions service at the player's own base URL
// (providers/index.mjs checkCustomUrl, customManifest; custom.json), against a local mock. The base
// URL's rules (https, or http for this computer only; no credentials, query or fragment), the
// manifest it makes (its one host, local exactly for this computer, the model listed), the request
// (the Bearer key only when there is one, nothing any one service needs), what OpenAI-compatible
// services send back (an exact cost, errors under a 200, keep-alive comments), the generic §10
// kinds for their statuses, and the key test's one request. The fixtures are OpenRouter's and LM
// Studio's: two services players connect through Other.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCustomUrl, customManifest, withCustom, manifestFor, getManifest, loadManifests, validateManifest, pickProviderForKey, CUSTOM_ID } from '../../bridge/byok/providers/index.mjs';
import { serveOne, startMock, fixture, mockCustom, collect, textOf, last, req } from './helpers/mock-provider.mjs';

const KEY = `sk-or-v1-CANARY${'x'.repeat(64)}`;
const REMOTE = 'https://svc.example.com/api/v1';
// URLs with a user part are built with AT: the scrub scanner reads user@host as an email address,
// and these files go out with the public tree (security review SR-02).
const AT = '@';

async function run(fixtureDir, name, request, { baseUrl, key = null, spec = {} } = {}) {
  const mock = await serveOne({ ...fixture(fixtureDir, name), ...spec });
  try {
    const { provider, lines, manifest } = mockCustom(mock.url, { ...(baseUrl ? { baseUrl } : {}), model: request.model, key });
    const events = await collect(provider.stream(request));
    return { events, sent: mock.requests[0], lines, manifest };
  } finally { await mock.close(); }
}

test('the base URL: https, or http for this computer only; no credentials, query or fragment; normalised', () => {
  const good = [
    ['https://openrouter.ai/api/v1', 'https://openrouter.ai/api/v1', 'openrouter.ai', false],
    ['https://openrouter.ai/api/v1/', 'https://openrouter.ai/api/v1', 'openrouter.ai', false],
    ['  https://api.groq.com/openai/v1  ', 'https://api.groq.com/openai/v1', 'api.groq.com', false],
    ['https://api.together.xyz/v1/chat/completions', 'https://api.together.xyz/v1', 'api.together.xyz', false],
    ['HTTPS://API.Example.COM:8443/v1', 'https://api.example.com:8443/v1', 'api.example.com', false],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1', 'localhost', true],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1', '127.0.0.1', true],
    ['http://[::1]:1234/v1', 'http://[::1]:1234/v1', '[::1]', true],
    ['https://localhost:8443/v1', 'https://localhost:8443/v1', 'localhost', true],
  ];
  for (const [raw, baseUrl, host, local] of good) assert.deepEqual(checkCustomUrl(raw), { ok: true, baseUrl, host, local }, raw);
  const bad = [
    ['', 'empty'], ['   ', 'empty'], [null, 'empty'], [42, 'empty'], [`https://x.example/${'a'.repeat(600)}`, 'too_long'],
    ['openrouter.ai/api/v1', 'bad_url'], ['not a url', 'bad_url'],
    ['http://openrouter.ai/api/v1', 'https_required'], ['http://172.32.0.1/v1', 'https_required'], ['http://192.169.1.1/v1', 'https_required'],
    ['http://8.8.8.8/v1', 'https_required'], ['http://[2001:db8::1]/v1', 'https_required'], ['http://gaming-pc.example/v1', 'https_required'],
    ['http://localhost.evil.example/v1', 'https_required'], ['http://127.0.0.1.nip.io/v1', 'https_required'],
    [`https://user:pw${AT}openrouter.ai/api/v1`, 'credentials'], [`https://user${AT}openrouter.ai/api/v1`, 'credentials'], ['https://@openrouter.ai/api/v1', 'credentials'],
    ['https://openrouter.ai/api/v1?key=abc', 'query'], ['https://openrouter.ai/api/v1?', 'query'], ['https://openrouter.ai/api/v1#top', 'query'], ['https://openrouter.ai/#', 'query'],
    ['ftp://openrouter.ai/v1', 'not_http'], ['file:///etc/passwd', 'not_http'], ['javascript:alert(1)', 'not_http'],
  ];
  for (const [raw, error] of bad) assert.deepEqual(checkCustomUrl(raw), { ok: false, error }, String(raw));
  // The player's own network (a player, 2026-10-05: "Requires HTTPS with local models"): http to a literal private
  // address or an mDNS .local name, never local (it leaves this computer), never a public name that resolves there.
  const lan = [
    ['http://192.168.1.20:11434/v1', 'http://192.168.1.20:11434/v1', '192.168.1.20'], ['http://10.0.0.2/v1', 'http://10.0.0.2/v1', '10.0.0.2'],
    ['http://172.16.5.4:1234/v1', 'http://172.16.5.4:1234/v1', '172.16.5.4'], ['http://169.254.1.1/v1', 'http://169.254.1.1/v1', '169.254.1.1'],
    ['http://Gaming-PC.local:1234/v1/', 'http://gaming-pc.local:1234/v1', 'gaming-pc.local'], ['http://[fd12::1]:8080/v1', 'http://[fd12::1]:8080/v1', '[fd12::1]'],
  ];
  for (const [raw, baseUrl, host] of lan) assert.deepEqual(checkCustomUrl(raw), { ok: true, baseUrl, host, local: false, lan: true }, raw);
});

test('the template: no base URL, no hosts, an optional Bearer key, no key shape, Chat Completions only', () => {
  const t = getManifest(CUSTOM_ID);
  assert.equal(t.custom, true);
  assert.equal(t.baseUrl, null);
  assert.deepEqual(t.hosts, []);
  assert.deepEqual(t.auth, { header: 'authorization', scheme: 'Bearer', optional: true });
  assert.equal(t.keyPattern, null);
  assert.equal(t.adapter, 'openai-chat');
  assert.deepEqual(t.defaultRequestOptions, {}, 'nothing any one service needs');
  assert.deepEqual(t.effort, {});
  assert.equal(t.display.card, 'Other');
  assert.equal(pickProviderForKey(KEY).id, null, 'no pasted key routes to Other');
  // The schema's custom rules: a template or a filled one, never a cloud shape.
  const bad = patch => validateManifest({ ...structuredClone(t), ...patch });
  assert.ok(bad({ adapter: 'openai-responses' }).some(p => /Chat Completions only/.test(p)));
  assert.ok(bad({ hosts: ['evil.example'] }).some(p => /no hosts/.test(p)));
  assert.ok(bad({ auth: { header: 'authorization', scheme: 'Bearer' } }).some(p => /optional Bearer key/.test(p)));
  assert.ok(bad({ keyPattern: '^sk-' }).some(p => /no key shape/.test(p)));
  assert.ok(bad({ baseUrl: 'http://openrouter.ai/api/v1', hosts: ['openrouter.ai'] }).some(p => /checkCustomUrl/.test(p)));
  assert.ok(bad({ baseUrl: 'https://openrouter.ai/api/v1', hosts: ['evil.example'] }).some(p => /one host/.test(p)));
  assert.ok(bad({ id: 'other' }).some(p => /id is custom/.test(p)));
});

test('customManifest: the player\'s service as a manifest (its one host, its name, the model listed), local exactly for this computer', () => {
  const t = getManifest(CUSTOM_ID);
  const r = customManifest(t, { baseUrl: 'https://openrouter.ai/api/v1/', model: 'openai/gpt-5-mini' });
  assert.equal(r.baseUrl, 'https://openrouter.ai/api/v1');
  assert.deepEqual(r.hosts, ['openrouter.ai']);
  assert.equal(r.name, 'openrouter.ai');
  assert.equal(r.local, false);
  assert.equal(r.models.default, 'openai/gpt-5-mini');
  assert.deepEqual(r.models.list, [{ id: 'openai/gpt-5-mini', label: 'openai/gpt-5-mini', costRank: 0, effort: false }]);
  assert.equal(r.privacy.class, 'cloud');
  assert.equal(r.priceSource, 'response');
  assert.deepEqual(validateManifest(r), []);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.hosts));
  const l = customManifest(t, { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' });
  assert.equal(l.local, true);
  assert.equal(l.name, 'localhost:11434');
  assert.equal(l.privacy.class, 'local');
  assert.match(l.privacy.player.keeps, /stay on this/);
  assert.equal(l.priceSource, 'free');
  assert.deepEqual(l.auth, t.auth, 'a server here may still take a key');
  for (const bad of [{ baseUrl: 'http://evil.example/v1', model: 'm' }, { baseUrl: 'https://x.example/v1', model: '' }, { baseUrl: 'https://x.example/v1', model: 'has space' }, { baseUrl: 'https://x.example/v1?k=1', model: 'm' }, null, {}]) {
    assert.equal(customManifest(t, bad), null, JSON.stringify(bad));
  }
  assert.equal(customManifest(getManifest('openai'), { baseUrl: 'https://x.example/v1', model: 'm' }), null, 'only the template');
});

test('code health BR-06: a server on this computer serving a cloud model (Ollama\'s "-cloud" and ":cloud" ids go to ollama.com) is cloud: cloud privacy, the service\'s price, never "local, $0"', () => {
  const t = getManifest(CUSTOM_ID);
  for (const model of ['gpt-oss:120b-cloud', 'deepseek-v3.1:671b-cloud', 'qwen3-coder:480b-cloud', 'kimi-k2:cloud', 'GLM-4.6:CLOUD', 'cloud']) {
    const m = customManifest(t, { baseUrl: 'http://localhost:11434/v1', model });
    assert.ok(m, model);
    assert.equal(m.local, false, `${model}: not local`);
    assert.equal(m.privacy.class, 'cloud', model);
    assert.doesNotMatch(m.privacy.player.keeps, /stay on this/, model);
    assert.equal(m.priceSource, 'response', `${model}: priced as a service, not free`);
    assert.deepEqual(m.hosts, ['localhost'], 'still this computer\'s server');
    assert.deepEqual(validateManifest(m), [], model);
  }
  // Any other model a server here serves stays local and free; a word that merely ends in "cloud" too.
  for (const model of ['qwen3:8b', 'llama3.2:3b', 'wordcloud', 'mycloud:7b', 'cloud-coder:7b']) {
    const m = customManifest(t, { baseUrl: 'http://127.0.0.1:11434/v1', model });
    assert.equal(m.local, true, model);
    assert.equal(m.privacy.class, 'local', model);
    assert.equal(m.priceSource, 'free', model);
  }
});

test('withCustom and manifestFor: the Other card is the player\'s service, or absent until it\'s set; the others are as shipped', () => {
  const ms = loadManifests();
  assert.deepEqual(withCustom(ms, null).map(m => m.id), ms.map(m => m.id).filter(id => id !== CUSTOM_ID));
  const set = withCustom(ms, { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' });
  assert.deepEqual(set.find(m => m.id === CUSTOM_ID).hosts, ['api.groq.com']);
  assert.equal(set.find(m => m.id === 'openai'), ms.find(m => m.id === 'openai'), 'the same object: untouched');
  assert.equal(manifestFor('custom', ms, null), null);
  assert.equal(manifestFor('custom', ms, { baseUrl: 'https://api.groq.com/openai/v1', model: 'm' }).hosts[0], 'api.groq.com');
  assert.equal(manifestFor('anthropic', ms, null), ms.find(m => m.id === 'anthropic'));
  assert.equal(manifestFor('openrouter', ms, null), null, 'OpenRouter is no AI of its own now');
});

test('a service off this computer: the Bearer key, include_usage, the model as typed, no effort or service-specific fields', async () => {
  const { events, sent } = await run('openrouter', 'success.sse', req('meta-llama/llama-4-scout', { effort: 'low' }), { baseUrl: REMOTE, key: KEY });
  assert.equal(textOf(events), 'Free model says hi.');
  assert.equal(sent.url, '/api/v1/chat/completions');
  assert.equal(sent.headers.authorization, `Bearer ${KEY}`);
  const b = sent.body;
  assert.equal(b.model, 'meta-llama/llama-4-scout');
  assert.deepEqual(b.stream_options, { include_usage: true });
  assert.equal(b.stream, true);
  assert.equal(b.max_tokens, 300);
  assert.equal(b.messages[0].role, 'system');
  for (const k of ['provider', 'reasoning', 'reasoning_effort', 'store', 'safety_identifier', 'temperature', 'top_p']) assert.ok(!(k in b), k);
  for (const h of ['http-referer', 'x-title', 'x-openrouter-title']) assert.equal(sent.headers[h], undefined, h);
});

test('DeepSeek on Other (a player, 2026-10-05): its own host gets thinking off, so a 1,200-token reply is an answer, not all chain of thought; no other host does', async () => {
  const t = getManifest(CUSTOM_ID);
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/', 'https://API.DeepSeek.com/chat/completions']) {
    const m = customManifest(t, { baseUrl, model: 'deepseek-v4-pro' });
    assert.deepEqual(m.defaultRequestOptions, { thinking: { type: 'disabled' } }, baseUrl);
    assert.deepEqual(validateManifest(m), [], baseUrl);
  }
  for (const [baseUrl, model] of [['https://openrouter.ai/api/v1', 'deepseek/deepseek-v4-pro'], ['https://api.together.xyz/v1', 'deepseek-ai/DeepSeek-V4-Pro'], ['http://localhost:11434/v1', 'deepseek-r1:8b'], ['https://constructor/v1', 'm']]) {
    assert.deepEqual(customManifest(t, { baseUrl, model }).defaultRequestOptions, {}, `${baseUrl}: DeepSeek's switch goes to DeepSeek's own host only`);
  }
  const { sent, events } = await run('openrouter', 'success.sse', req('deepseek-v4-pro', { maxTokens: 1200, effort: null }), { baseUrl: 'https://api.deepseek.com', key: KEY });
  assert.equal(sent.url, '/chat/completions');
  assert.deepEqual(sent.body.thinking, { type: 'disabled' });
  assert.equal(sent.body.max_tokens, 1200, 'the reply\'s ceiling, all of it for the answer');
  assert.deepEqual(sent.body.stream_options, { include_usage: true });
  for (const k of ['reasoning', 'reasoning_effort', 'temperature', 'top_p']) assert.ok(!(k in sent.body), k);
  assert.equal(textOf(events), 'Free model says hi.');
});

test('DeepSeek\'s insufficient_system_resource stop is the service being busy (waited out and tried again), never a whole reply or "no reply"', async () => {
  const chunk = (delta, finish = null, usage = null) => `data: ${JSON.stringify({ id: 'ds1', object: 'chat.completion.chunk', model: 'deepseek-v4-pro', choices: [{ index: 0, delta, finish_reason: finish }], usage })}\n\n`;
  const body = chunk({ role: 'assistant', content: 'Head to Gold' }) + chunk({ content: '' }, 'insufficient_system_resource', { prompt_tokens: 7000, completion_tokens: 4, total_tokens: 7004 }) + 'data: [DONE]\n\n';
  const { events } = await run('openrouter', 'success.sse', req('deepseek-v4-pro'), { baseUrl: 'https://api.deepseek.com', key: KEY, spec: { body } });
  assert.equal(events.some(e => e.type === 'done'), false, 'never finished');
  assert.equal(events.find(e => e.type === 'usage').usage.partial, true, 'what it used so far, before the error');
  const err = last(events).error;
  assert.deepEqual([err.kind, err.code, err.retryable, err.provider], ['overloaded', 'insufficient_system_resource', true, CUSTOM_ID]);
});

test('no key: no authorization header at all (a server on this computer, or a service that takes none)', async () => {
  const { sent, events } = await run('lmstudio', 'success.sse', req('qwen/qwen3-8b'), { spec: { splitEvery: 1 } });
  assert.equal(sent.headers.authorization, undefined);
  assert.equal(sent.url, '/v1/chat/completions');
  assert.equal(textOf(events), 'Studio reply.');
  // On this computer: $0, exact (the backend's usage then costs nothing).
  assert.deepEqual(events.find(e => e.type === 'usage').usage, { input: 800, output: 4, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0, exact: true });
  const remote = await run('openrouter', 'success.sse', req('m'), { baseUrl: REMOTE });
  assert.equal(remote.sent.headers.authorization, undefined, 'off this computer with no key: none either');
});

test('a service that reports its exact cost (usage.cost) is taken at its word', async () => {
  const { events } = await run('openrouter', 'success-paid.sse', req('some/model'), { baseUrl: REMOTE, key: KEY });
  const u = events.find(e => e.type === 'usage').usage;
  assert.equal(u.costUsd, 0.000412);
  assert.equal(u.exact, true);
  assert.equal(u.cacheRead, 500);
  assert.equal(u.input, 1500);
});

test('errors under a 200: mid-stream after some text, a body holding only an error, a refusal', async () => {
  const mid = await run('openrouter', 'error-midstream.sse', req('m'), { baseUrl: REMOTE, key: KEY });
  assert.equal(textOf(mid.events), 'Par');
  assert.equal(last(mid.events).type, 'error');
  const only = await run('openrouter', 'error-in-200.json', req('m'), { baseUrl: REMOTE, key: KEY });
  assert.equal(only.events[0].type, 'start');
  assert.equal(last(only.events).type, 'error');
  const refusal = await run('openrouter', 'refusal-in-200.json', req('m'), { baseUrl: REMOTE, key: KEY });
  assert.deepEqual(last(refusal.events), { type: 'done', finish: 'refusal' });
});

// Other knows nothing of any one service's error format: the generic codes, types and statuses.
const HTTP = [
  ['http-401.json', 'auth_invalid'],
  ['http-402-credits.json', 'out_of_credit'],
  ['http-429-per-minute.json', 'rate_limited'],
  ['http-503-provider-overloaded.json', 'overloaded'],
  ['http-404.json', 'model_not_found'],
  ['http-400.json', 'bad_request'],
];
for (const [name, kind] of HTTP) {
  test(`a service's HTTP ${name} → ${kind}, with nothing of the body in a log`, async () => {
    const { events, lines } = await run('openrouter', name, req('m'), { baseUrl: REMOTE, key: KEY });
    assert.equal(events.length, 1);
    assert.equal(events[0].error.kind, kind);
    assert.equal(events[0].error.provider, CUSTOM_ID);
    assert.doesNotMatch(lines.join('\n'), /flagged_input|echoed|violence|CANARY/);
  });
}
test('a body that quotes the prompt (a moderation 403) never reaches a log', async () => {
  const { events, lines } = await run('openrouter', 'http-403-moderation.json', req('m'), { baseUrl: REMOTE, key: KEY });
  assert.equal(events[0].type, 'error');
  assert.doesNotMatch(lines.join('\n'), /flagged_input|echoed|violence|CANARY/);
});

test('a server on this computer that isn\'t running is local_unreachable (never a network outage to wait out)', async () => {
  const mock = await serveOne({ status: 200, body: '' });
  const port = mock.port;
  await mock.close();
  const { provider } = mockCustom(`http://127.0.0.1:${port}`, { model: 'qwen3:8b' });
  const events = await collect(provider.stream(req('qwen3:8b')));
  assert.equal(last(events).error.kind, 'local_unreachable');
});

test('the key test: one tiny request to <base URL>/chat/completions with the model, never the model list', async () => {
  const mock = await startMock(() => fixture('lmstudio', 'success.sse'));
  try {
    const { provider } = mockCustom(mock.url, { baseUrl: REMOTE, model: 'openai/gpt-5-mini', key: KEY });
    const r = await provider.testCall();
    assert.equal(r.ok, true);
    assert.deepEqual(mock.requests.map(x => `${x.method} ${x.url}`), ['POST /api/v1/chat/completions']);
    assert.equal(mock.requests[0].body.model, 'openai/gpt-5-mini');
    assert.equal(mock.requests[0].body.max_tokens, getManifest('custom').limits.testMaxTokens);
    assert.equal(mock.requests[0].headers.authorization, `Bearer ${KEY}`);
  } finally { await mock.close(); }
});

test('a redirect from the service is never followed (the key never goes to another host)', async () => {
  const mock = await serveOne({ redirect: 'https://evil.example/steal', status: 307 });
  try {
    const { provider } = mockCustom(mock.url, { baseUrl: REMOTE, model: 'm', key: KEY });
    const events = await collect(provider.stream(req('m')));
    assert.equal(last(events).error.code, 'redirect_refused');
    assert.equal(mock.requests.length, 1);
  } finally { await mock.close(); }
});
