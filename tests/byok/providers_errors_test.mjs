// Error classification and the in-game lines (PRD §10, ER-1 to ER-3, ER-6,
// §7.5): every documented case per provider from the docs-derived fixtures,
// code before type before status, errors inside a 200, network phases, retry
// timing from headers, the body kept off logs, and the exact §10 lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, userLine, retryPlan, parseDuration, parseRetryAfter, parseRateLimit, fetchErrorPhase, errorLogFields, nextMidnight, extractError, makeError, cleanRequestId, KINDS } from '../../bridge/byok/providers/errors.mjs';
import { getManifest, customManifest } from '../../bridge/byok/providers/index.mjs';
import { fixture } from './helpers/mock-provider.mjs';

const NOW = Date.parse('2026-09-26T19:30:00Z');
// Other (custom) as the player sets it up: at a service off this computer, and at a server on this one.
const CUSTOM = customManifest(getManifest('custom'), { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' });
const CUSTOM_LOCAL = customManifest(getManifest('custom'), { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-8b' });
// extra.now === 'real': the real clock, read after the fixture's {{now+N}} stamps.
const fromFixture = (id, name, extra = {}) => {
  const f = fixture(id, name);
  const now = extra.now === 'real' ? Date.now() : extra.now ?? NOW;
  return classify(getManifest(id), { status: f.status, headers: f.headers, body: f.body, ...extra, now });
};

// [provider, fixture, kind, extra checks]
const HTTP_CASES = [
  ['anthropic', 'http-401-authentication.json', 'auth_invalid', { requestId: 'req_011FIXTURE', type: 'authentication_error' }],
  ['anthropic', 'http-403-permission.json', 'bad_request', { type: 'permission_error', retryable: false }],
  ['anthropic', 'http-402-billing.json', 'out_of_credit', { retryable: false }],
  ['anthropic', 'http-400-credit-low.json', 'out_of_credit', { retryable: false }],
  ['anthropic', 'http-400-usage-limits.json', 'spend_limit'],
  ['anthropic', 'http-400-workspace-usage-limits.json', 'spend_limit'],
  ['anthropic', 'http-429-rate-limit.json', 'rate_limited', { retryable: true, retryAfterMs: 20000 }],
  ['anthropic', 'http-429-spend-limit.json', 'spend_limit', { retryable: false, code: 'enforced_spend_limit_reached', resetAt: Date.parse('2026-10-01T00:00:00Z') }],
  ['anthropic', 'http-529-overloaded.json', 'overloaded', { retryable: true }],
  ['anthropic', 'http-500-api-error.json', 'overloaded'],
  ['anthropic', 'http-404-not-found.json', 'model_not_found'],
  ['anthropic', 'http-400-prompt-too-long.json', 'context_too_long'],
  ['anthropic', 'http-400-bad-request.json', 'bad_request'],
  ['openai', 'http-401-invalid-key.json', 'auth_invalid', { code: 'invalid_api_key', requestId: 'req_FIXTURE_OAI' }],
  ['openai', 'http-429-credit-exhausted.json', 'out_of_credit', { code: 'credit_balance_exhausted', retryable: false }],
  ['openai', 'http-429-insufficient-quota.json', 'out_of_credit', { retryable: false }],
  ['openai', 'http-429-org-spend-limit.json', 'spend_limit', { code: 'organization_spend_limit_exceeded', type: 'insufficient_quota' }],
  ['openai', 'http-429-project-spend-limit.json', 'spend_limit'],
  ['openai', 'http-429-org-usage-limit.json', 'spend_limit'],
  ['openai', 'http-429-rate-limit.json', 'rate_limited', { retryAfterMs: 360000, retryable: true }],
  ['openai', 'http-429-slow-down.json', 'rate_limited', { code: 'slow_down', retryAfterMs: 1500 }],
  ['openai', 'http-503-overloaded.json', 'overloaded', { code: 'server_is_overloaded', retryAfterMs: 2000 }],
  ['openai', 'http-500.json', 'overloaded'],
  ['openai', 'http-403-region.json', 'region_blocked', { retryable: false }],
  ['openai', 'http-403-misalignment.json', 'content_blocked', { retryable: false }],
  ['openai', 'http-400-identifier-blocked.json', 'identifier_blocked'],
  ['openai', 'http-400-context-length.json', 'context_too_long'],
  ['openai', 'http-404-model-not-found.json', 'model_not_found'],
  ['xai', 'http-403-spending-limit.json', 'out_of_credit', { code: 'personal-team-blocked:spending-limit' }],
  ['xai', 'http-401.json', 'auth_invalid'],
  ['xai', 'http-429.json', 'rate_limited'],
  ['xai', 'http-404.json', 'model_not_found'],
  ['xai', 'http-500.json', 'overloaded'],
  ['google', 'http-400-invalid-key.json', 'auth_invalid', { status: 400 }],
  ['google', 'http-400-location.json', 'region_blocked', { retryable: false }],
  ['google', 'http-403-permission.json', 'bad_request', { retryable: false }],
  ['google', 'http-429-quota.json', 'rate_limited', { retryable: true }],
];

for (const [id, name, kind, extra = {}] of HTTP_CASES) {
  test(`classify ${id} ${name} → ${kind}`, () => {
    const err = fromFixture(id, name);
    assert.equal(err.kind, kind);
    assert.equal(err.provider, id);
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(err[k], v, `${k}`);
  });
}

// Other (custom) knows nothing of a service's own codes: what OpenRouter and LM Studio send, through
// the generic codes, types and statuses. The fixtures' reset headers are relative to the real clock.
const CUSTOM_CASES = [
  ['openrouter', 'http-401.json', 'auth_invalid'],
  ['openrouter', 'http-402-credits.json', 'out_of_credit', { retryable: false }],
  ['openrouter', 'http-429-per-minute.json', 'rate_limited', { retryable: true }],
  ['openrouter', 'http-503-provider-overloaded.json', 'overloaded', { retryAfterMs: 3000 }],
  ['openrouter', 'http-404.json', 'model_not_found'],
  ['openrouter', 'http-400.json', 'bad_request'],
  ['openrouter', 'error-in-200.json', 'overloaded'],
  ['lmstudio', 'http-400.json', 'bad_request'],
];
for (const [dir, name, kind, extra = {}] of CUSTOM_CASES) {
  test(`classify Other (custom) with ${dir}'s ${name} → ${kind}`, () => {
    const f = fixture(dir, name);
    const err = classify(dir === 'lmstudio' ? CUSTOM_LOCAL : CUSTOM, { status: f.status, headers: f.headers, body: f.body, now: Date.now() });
    assert.equal(err.kind, kind);
    assert.equal(err.provider, 'custom');
    for (const [k, v] of Object.entries(extra)) assert.deepEqual(err[k], v, `${k}`);
  });
}

test('a 429 with no retry-after carries its bucket\'s reset as its retry time, near or far: no daily cap is read from a reset header (code health BR-23)', () => {
  // Load the fixture first: its {{now+N}} stamps must not be older than `now`.
  const minute = fixture('openrouter', 'http-429-per-minute.json');
  const now = Date.now();
  // A manifest that names the buckets, and the key OpenRouter's manifest had for its free daily cap (no longer read).
  const m = {
    ...CUSTOM,
    rateLimitHeaders: { resetFormat: 'epoch_ms', buckets: { requests: { limit: 'x-ratelimit-limit', remaining: 'x-ratelimit-remaining', reset: 'x-ratelimit-reset' } } },
    errorMap: { ...CUSTOM.errorMap, dailyFromResetHeader: true },
  };
  const perMinute = classify(m, { ...minute, now });
  assert.ok(perMinute.retryAfterMs > 25000 && perMinute.retryAfterMs <= 30000, String(perMinute.retryAfterMs));
  const far = classify(m, { status: 429, headers: { 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now + 5 * 3600e3) }, body: { error: { code: 429, message: 'Rate limit exceeded' } }, now });
  assert.equal(far.kind, 'rate_limited');
  assert.equal(far.retryAfterMs, 5 * 3600e3);
  assert.deepEqual([far.resetAt, far.limit, far.freeTier], [undefined, undefined, undefined]);
  // A daily limit is what a manifest's errorMap names: its reset is the next midnight in its zone (UTC unless it says).
  const daily = classify({ ...m, errorMap: { ...m.errorMap, codes: { daily_limit_reached: 'rate_limited_daily' } } }, { status: 429, body: { error: { code: 'daily_limit_reached' } }, now: NOW });
  assert.deepEqual([daily.kind, daily.resetAt, daily.retryAfterMs, daily.retryable], ['rate_limited_daily', Date.parse('2026-09-27T00:00:00Z'), undefined, false]);
});

test('errors inside a 200 stream classify by their code, never by the 200', () => {
  const m = (id) => getManifest(id);
  assert.equal(classify(m('anthropic'), { status: 200, streamEvent: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }).kind, 'overloaded');
  assert.equal(classify(m('openai'), { status: 200, streamEvent: { type: 'response.failed', response: { error: { code: 'context_length_exceeded', message: 'x' } } } }).kind, 'context_too_long');
  assert.equal(classify(m('openai'), { status: 200, streamEvent: { type: 'response.failed', response: { error: { code: 'rate_limit_exceeded' } } } }).kind, 'rate_limited');
  assert.equal(classify(m('openai'), { status: 200, streamEvent: { type: 'response.failed', response: { error: { code: 'insufficient_quota' } } } }).kind, 'out_of_credit');
  assert.equal(classify(m('openai'), { status: 200, streamEvent: { type: 'error', code: 'misalignment_policy_violation', message: 'no' } }).kind, 'content_blocked');
  assert.equal(classify(m('openai'), { status: 200, streamEvent: { type: 'response.failed', response: { error: { code: 'server_error' } } } }).kind, 'overloaded');
  assert.equal(classify(CUSTOM, { status: 200, streamEvent: { error: { code: 502, message: 'x', metadata: { error_type: 'provider_overloaded' } } } }).kind, 'overloaded');
  assert.equal(classify(CUSTOM, { status: 200, streamEvent: { error: { code: 502, message: 'x' } } }).kind, 'overloaded', 'the numeric code stands in for the status');
  assert.equal(classify(CUSTOM_LOCAL, { status: 200, streamEvent: { error: 'unexpected EOF' } }).kind, 'unknown');
  assert.equal(classify(m('google'), { status: 200, streamEvent: [{ error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } }] }).kind, 'rate_limited', 'Gemini\'s list-wrapped error');
  assert.equal(classify(m('anthropic'), { status: 200, streamEvent: { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long' } } }).kind, 'bad_request', 'documented strings are scoped to their 400');
});

test('code wins over type, type over status', () => {
  const o = getManifest('openai');
  assert.equal(classify(o, { status: 429, body: { error: { type: 'insufficient_quota', code: 'project_spend_limit_exceeded' } } }).kind, 'spend_limit');
  assert.equal(classify(o, { status: 400, body: { error: { type: 'rate_limit_error', code: null } } }).kind, 'rate_limited');
  assert.equal(classify(o, { status: 418, body: {} }).kind, 'unknown');
  assert.equal(classify(o, { status: 502, body: 'not json at all' }).kind, 'overloaded');
  assert.equal(classify('someone-new', { status: 401 }).kind, 'auth_invalid', 'a bare id uses the generic tables');
});

test('a 403 permission_error is a good key without access (bad_request), never a rejected key', () => {
  const body = { type: 'error', error: { type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' } };
  assert.equal(classify(getManifest('anthropic'), { status: 403, body }).kind, 'bad_request');
  assert.equal(classify(getManifest('anthropic'), { status: 403, body: 'not json' }).kind, 'bad_request', 'Anthropic\'s 403 status alone');
  assert.equal(classify('someone-new', { status: 403, body }).kind, 'bad_request', 'the generic type table agrees');
  assert.equal(classify(getManifest('anthropic'), { status: 401, body: { type: 'error', error: { type: 'authentication_error' } } }).kind, 'auth_invalid', 'the 401 still is');
});

test('code health BR-10: a 403 that says nothing (no code, type or message: a CDN\'s, a firewall\'s or a proxy\'s page) is bad_request on every AI, never a rejected key; a 403 that says why is still read', () => {
  const page = '<html><body><h1>403 Forbidden</h1><p>Request blocked.</p></body></html>';
  for (const m of [getManifest('openai'), getManifest('xai'), CUSTOM, getManifest('anthropic'), getManifest('google')]) {
    for (const body of [page, '', null, '{}', { error: {} }]) {
      const e = classify(m, { status: 403, headers: { 'content-type': 'text/html' }, body });
      assert.equal(e.kind, 'bad_request', `${m.id} ${JSON.stringify(body)?.slice(0, 20)}`);
      assert.equal(e.retryable, false);
    }
  }
  // What a provider names stays its own: OpenAI's region code, xAI's spending limit, a 401.
  assert.equal(fromFixture('openai', 'http-403-region.json').kind, 'region_blocked');
  assert.equal(fromFixture('xai', 'http-403-spending-limit.json').kind, 'out_of_credit');
  assert.equal(classify(getManifest('openai'), { status: 401, body: page }).kind, 'auth_invalid', 'a body-less 401 is still a rejected key');
  assert.equal(classify(getManifest('xai'), { status: 403, body: { error: 'The caller does not have permission' } }).kind, 'auth_invalid', 'a 403 with words of its own reads by its status, as before');
});

test('message text is used only for the documented strings the manifest lists', () => {
  const o = getManifest('openai');
  assert.equal(classify(o, { status: 400, body: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } } }).kind, 'bad_request', 'OpenAI does not list that string');
  assert.equal(classify(getManifest('anthropic'), { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } } }).matched, 'message');
});

test('network failures: before vs after the request left, and local servers', () => {
  const refused = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) });
  const reset = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  const socket = new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.x.ai'), { code: 'ENOTFOUND' }) });
  const tls = new TypeError('fetch failed', { cause: Object.assign(new Error('cert'), { code: 'CERT_HAS_EXPIRED' }) });
  assert.equal(fetchErrorPhase(refused), 'before_send');
  assert.equal(fetchErrorPhase(dns), 'before_send');
  assert.equal(fetchErrorPhase(tls), 'before_send');
  assert.equal(fetchErrorPhase(reset), 'after_send', 'a reset may come after the request left: never auto-resend (DB20)');
  assert.equal(fetchErrorPhase(socket), 'after_send');
  assert.equal(fetchErrorPhase(new Error('mystery')), 'after_send');
  const before = classify(getManifest('anthropic'), { networkPhase: 'before_send', networkError: dns });
  assert.deepEqual([before.kind, before.retryable, before.code], ['network_before_send', true, 'ENOTFOUND']);
  const after = classify(getManifest('anthropic'), { networkPhase: 'after_send', networkError: socket });
  assert.deepEqual([after.kind, after.retryable], ['network_after_send', false]);
  const local = classify(CUSTOM_LOCAL, { networkPhase: 'before_send', networkError: refused });
  assert.deepEqual([local.kind, local.retryable], ['local_unreachable', false]);
  // SY-12: a certificate failure never left either, but it isn't the network being down: its own
  // kind (never held for 10 minutes, never "offline"), with the fix for its cause.
  const cert = classify(getManifest('anthropic'), { networkPhase: 'before_send', networkError: tls });
  assert.deepEqual([cert.kind, cert.retryable, cert.code], ['tls', false, 'CERT_HAS_EXPIRED']);
  assert.deepEqual(line(cert), { headline: "Couldn't make a secure connection to Anthropic.", detail: "Check your computer's date and time, then click Retry.", action: { id: 'retry', label: 'Retry', desktop: false } });
  const scanned = new TypeError('fetch failed', { cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) });
  const inspected = classify(getManifest('openai'), { networkPhase: fetchErrorPhase(scanned), networkError: scanned });
  assert.equal(inspected.kind, 'tls');
  assert.equal(line(inspected).detail, 'Turn off HTTPS scanning in your antivirus, then click Retry.');
  assert.equal(classify(CUSTOM, { networkPhase: 'before_send', networkError: refused }).kind, 'network_before_send', 'Other off this computer: the network, never a local server');
});

test('an egress-guard block is its own kind: never retried, never "check your internet"', () => {
  const blocked = new TypeError('fetch failed', { cause: Object.assign(new Error('host not allowed'), { code: 'EGRESS_BLOCKED' }) });
  assert.equal(fetchErrorPhase(blocked), 'before_send', 'the request never left');
  for (const [id, mf] of [['anthropic', getManifest('anthropic')], ['custom', CUSTOM_LOCAL]]) {
    for (const networkPhase of ['before_send', 'after_send']) {
      const e = classify(mf, { networkPhase, networkError: blocked });
      assert.deepEqual([e.kind, e.code, e.retryable], ['egress_blocked', 'EGRESS_BLOCKED', false], `${id} ${networkPhase}`);
      assert.equal(retryPlan(e, 0).retry, false);
    }
  }
  const l = userLine(classify(getManifest('anthropic'), { networkPhase: 'before_send', networkError: blocked }), NAMES);
  assert.equal(l.headline, 'NeverQuestAlone blocked the connection to Anthropic.');
  assert.equal(l.detail, 'Check Connections in the NeverQuestAlone app.');
  assert.deepEqual(l.action, { id: 'connections', label: 'Open Connections', desktop: true });
  assert.doesNotMatch(l.headline + l.detail, /internet|when it's back/);
});

test('retry timing: retry-after seconds or date, retry-after-ms, Go durations, RFC 3339 resets', () => {
  assert.equal(parseDuration('6m0s'), 360000);
  assert.equal(parseDuration('1s'), 1000);
  assert.equal(parseDuration('20ms'), 20);
  assert.equal(parseDuration('1h2m3.5s'), 3723500);
  assert.equal(parseDuration('0.5s'), 500);
  assert.equal(parseDuration('6 minutes'), null);
  assert.equal(parseRetryAfter({ 'retry-after': '20' }), 20000);
  assert.equal(parseRetryAfter({ 'Retry-After': '1.5' }), 1500);
  assert.equal(parseRetryAfter({ 'retry-after-ms': '250', 'retry-after': '9' }), 250);
  assert.equal(parseRetryAfter({ 'retry-after': new Date(NOW + 30000).toUTCString() }, NOW), 30000);
  assert.equal(parseRetryAfter({ 'retry-after': 'soon' }), null);
  assert.equal(parseRetryAfter(new Headers({ 'retry-after': '3' })), 3000);
  const rl = parseRateLimit({ 'anthropic-ratelimit-requests-limit': '1000', 'anthropic-ratelimit-requests-remaining': '999', 'anthropic-ratelimit-requests-reset': '2026-09-26T19:31:00Z', 'anthropic-ratelimit-tokens-remaining': '12' }, getManifest('anthropic'), NOW);
  assert.deepEqual(rl.requests, { limit: 1000, remaining: 999, resetAt: NOW + 60000 });
  assert.equal(rl.tokens.remaining, 12);
  assert.equal(parseRateLimit({}, getManifest('anthropic'), NOW), null);
  const oai = parseRateLimit({ 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '6m0s' }, getManifest('openai'), NOW);
  assert.equal(oai.tokens.resetAt, NOW + 360000);
});

test('nextMidnight: Pacific and UTC', () => {
  assert.equal(nextMidnight('America/Los_Angeles', NOW), Date.parse('2026-09-27T07:00:00Z'));
  assert.equal(nextMidnight('UTC', NOW), Date.parse('2026-09-27T00:00:00Z'));
});

test('classify (KB-09, code health): a request id shaped like a key, or not like an id at all, is dropped wherever it came from; a real one stays', () => {
  const m = getManifest('anthropic');
  const canary = 'sk-ant-api03-CANARY' + 'a'.repeat(40);
  const body = { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
  for (const bad of [canary, `req_${canary}`, 'r'.repeat(65), 'req id with spaces', 'req_<b>']) {
    const what = bad.slice(0, 12);
    assert.equal(classify(m, { status: 401, headers: { 'request-id': bad }, body }).requestId, undefined, `request-id ${what}`);
    assert.equal(classify(m, { status: 401, headers: { 'x-request-id': bad }, body }).requestId, undefined, `x-request-id ${what}`);
    assert.equal(classify(m, { status: 401, headers: {}, body: { ...body, request_id: bad } }).requestId, undefined, `the body's ${what}`);
    assert.equal(makeError({ kind: 'bad_request', requestId: bad }).requestId, undefined, `an error made from a stream's start ${what}`);
    assert.equal(cleanRequestId(bad), undefined, what);
  }
  assert.equal(classify(m, { status: 401, headers: { 'request-id': 'req_011CUabcDEF123' }, body }).requestId, 'req_011CUabcDEF123');
  assert.equal(cleanRequestId('req_011CUabcDEF123'), 'req_011CUabcDEF123');
  assert.equal(cleanRequestId(42), undefined);
});

test('the provider body stays in memory only: not in JSON, not in log fields', () => {
  const f = fixture('openrouter', 'http-403-moderation.json');
  const err = classify(CUSTOM, { status: f.status, headers: f.headers, body: f.body, now: NOW });
  assert.ok(err.body && String(err.body).includes('flagged_input'), 'kept for the app\'s error view');
  assert.ok(!Object.keys(err).includes('body'));
  assert.doesNotMatch(JSON.stringify(err), /flagged|player prompt|echoed/);
  const oai = fromFixture('openai', 'http-401-invalid-key.json');
  assert.doesNotMatch(JSON.stringify(oai), /CANARY|Incorrect API key/, 'a masked key fragment in the body never leaves');
  assert.deepEqual(Object.keys(errorLogFields(oai)).sort(), ['code', 'errorKind', 'provider', 'requestId', 'retryable', 'status', 'type']);
  assert.throws(() => { 'use strict'; err.body = 'x'; }, TypeError);
});

test('extractError handles every provider shape', () => {
  assert.equal(extractError({ type: 'error', error: { type: 'overloaded_error', message: 'm', details: { error_code: 'x' } }, request_id: 'r' }).requestId, 'r');
  assert.equal(extractError('[{"error":{"code":429,"message":"slow down"}}]').httpCode, 429, 'a body wrapped in an array');
  assert.equal(extractError('[{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}]').type, null, 'Gemini\'s gRPC status isn\'t a type: the status decides');
  assert.equal(extractError({ code: 'personal-team-blocked:spending-limit', error: 'msg' }).code, 'personal-team-blocked:spending-limit');
  assert.equal(extractError({ error: 'model not found' }).message, 'model not found');
  assert.equal(extractError({ type: 'error', code: 'server_error', message: 'x' }).code, 'server_error');
  assert.equal(extractError(Buffer.from('{"error":{"code":"quota_exceeded"}}')).code, 'quota_exceeded');
  assert.deepEqual(extractError(null), {});
});

test('retryPlan: transient kinds only, at most two retries, honoring retry-after with jitter', () => {
  const r = (fields) => makeError({ provider: 'anthropic', ...fields });
  assert.deepEqual(retryPlan(r({ kind: 'rate_limited', retryAfterMs: 20000 }), 0, { random: () => 0 }), { retry: true, delayMs: 20000 });
  const jittered = retryPlan(r({ kind: 'rate_limited', retryAfterMs: 20000 }), 1, { random: () => 0.999 });
  assert.ok(jittered.retry && jittered.delayMs > 20000 && jittered.delayMs <= 21000);
  assert.equal(retryPlan(r({ kind: 'rate_limited', retryAfterMs: 20000 }), 2).retry, false);
  assert.deepEqual(retryPlan(r({ kind: 'overloaded' }), 0, { random: () => 0 }), { retry: true, delayMs: 2000 });
  assert.deepEqual(retryPlan(r({ kind: 'overloaded' }), 1, { random: () => 0 }), { retry: true, delayMs: 4000 });
  assert.equal(retryPlan(r({ kind: 'network_before_send' }), 0).retry, true);
  for (const kind of ['out_of_credit', 'spend_limit', 'auth_invalid', 'content_blocked', 'cap_spend', 'network_after_send', 'rate_limited_daily', 'timeout', 'no_key', 'egress_blocked']) {
    assert.equal(retryPlan(r({ kind }), 0).retry, false, kind);
  }
  assert.equal(retryPlan(r({ kind: 'rate_limited', retryAfterMs: 10 * 60000 }), 0).retry, false, 'a long wait is not retried automatically');
});

const NAMES = { provider: 'Anthropic', model: 'Claude Haiku 4.5', companion: 'NeverQuestAlone', product: 'NeverQuestAlone', now: NOW, timeZone: 'America/Los_Angeles' };
const line = (fields, names = NAMES) => userLine(makeError({ provider: 'anthropic', ...fields }), names);

test('userLine: the exact §10 lines, with the product and companion names', () => {
  const cases = [
    [{ kind: 'auth_invalid' }, {}, 'Your Anthropic key was rejected.', 'Replace it in the NeverQuestAlone app.'],
    [{ kind: 'out_of_credit' }, {}, 'Your Anthropic account is out of credit.', 'Add credit at Anthropic, or pick another AI in the NeverQuestAlone app.'], // the HUD's words (UX-W31)
    [{ kind: 'spend_limit', resetAt: Date.parse('2026-10-01T00:00:00Z') }, {}, "You've reached the spend limit you set at Anthropic.", 'Raise it there, or wait until Sep 30 at 5:00 PM.'],
    [{ kind: 'spend_limit' }, {}, "You've reached the spend limit you set at Anthropic.", 'Raise it there, or wait until it resets.'],
    [{ kind: 'cap_spend' }, { capMicros: 1000000 }, "You've reached your daily spend limit ($1.00).", 'Raise it or turn it off in the NeverQuestAlone app, or it resets at midnight.'],
    [{ kind: 'cap_spend' }, {}, "You've reached your daily spend limit.", 'Raise it or turn it off in the NeverQuestAlone app, or it resets at midnight.'],
    // Held because today's spend couldn't be read (code health BR-09): never "reached" (bones-ux-writer UX-W02).
    [{ kind: 'cap_spend' }, { capMicros: 1000000, capHeld: 'load_error' }, "Today's spend couldn't be read, so NeverQuestAlone rests.", 'Set your limit again in the NeverQuestAlone app.'],
    [{ kind: 'cap_spend' }, { capHeld: 'load_error', companion: 'Nyx' }, "Today's spend couldn't be read, so Nyx rests.", 'Set your limit again in the NeverQuestAlone app.'],
    [{ kind: 'rate_limited', retryAfterMs: 17200 }, {}, 'Anthropic asked NeverQuestAlone to slow down.', 'Trying again in 18 seconds.'],
    [{ kind: 'rate_limited_daily', resetAt: Date.parse('2026-09-27T00:00:00Z') }, {}, "Anthropic's daily limit is used up.", 'It resets at 5:00 PM.'],
    [{ kind: 'rate_limited_daily' }, {}, "Anthropic's daily limit is used up.", 'It resets tomorrow.'],
    [{ kind: 'overloaded' }, {}, 'Anthropic is busy right now.', 'Trying again…'],
    [{ kind: 'overloaded' }, { final: true }, 'Anthropic is busy right now.', 'Still busy. Try again in a minute.'],
    [{ kind: 'model_not_found' }, { fallbackModel: 'Claude Haiku 4.5', model: 'Claude Sonnet 5' }, "Claude Sonnet 5 isn't available on your Anthropic account.", 'Switched to Claude Haiku 4.5 for now. Change it in the NeverQuestAlone app.'],
    [{ kind: 'model_not_found' }, {}, 'Claude Haiku 4.5 was retired.', 'Pick another model in the NeverQuestAlone app.'],
    [{ kind: 'context_too_long' }, {}, 'This chat is too long for Claude Haiku 4.5.', 'Start a new chat.'],
    [{ kind: 'content_blocked' }, {}, 'Claude Haiku 4.5 declined to answer that.', 'Try asking another way.'],
    [{ kind: 'network_before_send' }, {}, "Can't reach Anthropic. Check your internet.", "Your message will send when it's back."],
    [{ kind: 'network_after_send' }, {}, 'No answer: the connection dropped.', ''],
    [{ kind: 'local_unreachable' }, { provider: 'Ollama' }, "NeverQuestAlone can't reach Ollama.", 'Start Ollama, then click Retry.'],
    [{ kind: 'oauth_expired' }, { provider: 'OpenRouter' }, 'Your OpenRouter sign-in ended.', 'Sign in again in the NeverQuestAlone app.'],
    [{ kind: 'region_blocked' }, { provider: 'OpenAI' }, "OpenAI isn't available where you are.", 'Pick another AI in the NeverQuestAlone app.'],
    [{ kind: 'identifier_blocked' }, { provider: 'OpenAI' }, 'OpenAI has blocked this install.', 'See the details in the NeverQuestAlone app.'],
    [{ kind: 'interrupted' }, {}, 'NeverQuestAlone restarted before NeverQuestAlone answered.', ''],
    [{ kind: 'timeout', afterMs: 60000 }, {}, 'No answer from Anthropic after 60 seconds.', ''],
    [{ kind: 'timeout', afterMs: 180000 }, {}, 'No answer from Anthropic after 3 minutes.', ''],
  ];
  for (const [fields, names, headline, detail] of cases) {
    const l = line(fields, { ...NAMES, ...names });
    assert.equal(l.headline, headline, fields.kind);
    assert.equal(l.detail, detail, fields.kind);
    assert.ok(l.action && typeof l.action.id === 'string', `${fields.kind} has a next step`);
  }
});

test('userLine: the fix buttons use the app\'s words, and a line with no AI name says "your AI company" (UX-W07)', () => {
  assert.equal(line({ kind: 'model_not_found' }).action.label, 'Pick Another Model');
  assert.equal(line({ kind: 'context_too_long', reason: 'num_ctx' }).action.label, 'Pick Another Model');
  assert.equal(line({ kind: 'no_key', code: 'keystore_error' }).action.label, 'Open Your AI');
  const bare = fields => userLine(makeError({ ...fields }), { product: 'NeverQuestAlone' });
  const noName = bare({ kind: 'out_of_credit' });
  assert.equal(noName.headline, 'Your AI company account is out of credit.');
  assert.equal(noName.detail, 'Add credit at your AI company, or pick another AI in the NeverQuestAlone app.');
  assert.equal(bare({ kind: 'overloaded' }).headline, 'Your AI company is busy right now.');
  assert.equal(bare({ kind: 'auth_invalid' }).headline, 'Your AI company key was rejected.');
  for (const kind of KINDS) {
    const l = bare({ kind });
    assert.ok(!/provider/i.test(`${l.headline} ${l.detail}`), kind);
    assert.ok(!/Your Your|your Your/.test(`${l.headline} ${l.detail}`), kind);
  }
});

test('userLine: a spend-limit reset reads as the player\'s local time', () => {
  const at = (resetAt, timeZone) => line({ kind: 'spend_limit', resetAt: Date.parse(resetAt) }, { ...NAMES, timeZone }).detail;
  assert.equal(at('2026-10-01T00:00:00Z', 'UTC'), 'Raise it there, or wait until Oct 1.', 'a reset at local midnight is just the day');
  assert.equal(at('2026-10-01T00:00:00Z', 'Europe/Berlin'), 'Raise it there, or wait until Oct 1 at 2:00 AM.', 'Intl’s AM and PM (STYLE §8)');
  assert.equal(at('2026-10-01T00:00:00Z', 'America/Los_Angeles'), 'Raise it there, or wait until Sep 30 at 5:00 PM.', 'not "Sep 30": access returns that afternoon');
  assert.equal(at('2026-09-26T23:15:00Z', 'America/Los_Angeles'), 'Raise it there, or wait until 4:15 PM.', 'later today: the time alone');
  assert.equal(at('2026-09-27T07:00:00Z', 'America/Los_Angeles'), 'Raise it there, or wait until Sep 27.', 'tomorrow at local midnight');
});

test('userLine: no key set up, or a keychain that couldn\'t be read, is never "rejected"', () => {
  const missing = line({ kind: 'no_key', code: 'missing_key' });
  assert.deepEqual([missing.headline, missing.detail], ['No Anthropic key is set up.', 'Add one in the NeverQuestAlone app.']);
  assert.deepEqual(missing.action, { id: 'add_key', label: 'Add Key', desktop: true });
  const unreadable = line({ kind: 'no_key', code: 'keystore_error' });
  assert.deepEqual([unreadable.headline, unreadable.detail], ["Couldn't read your Anthropic key.", 'Check it in the NeverQuestAlone app.']);
  assert.deepEqual(unreadable.action, { id: 'keys', label: 'Open Your AI', desktop: true }, 'the app has no Keys page (UX-W07)');
  for (const l of [missing, unreadable]) assert.doesNotMatch(l.headline + l.detail, /rejected|Replace/);
});

test('userLine: a companion renamed by the player shows up in its line', () => {
  assert.equal(line({ kind: 'local_unreachable' }, { ...NAMES, provider: 'LM Studio', companion: 'Mortimer' }).headline, "Mortimer can't reach LM Studio.");
});

test('userLine: next steps match §10 (retry offers, desktop fixes, resend)', () => {
  assert.deepEqual(line({ kind: 'network_after_send' }).action, { id: 'send_again', label: 'Retry', desktop: false });
  assert.deepEqual(line({ kind: 'network_before_send' }).action, { id: 'cancel', label: 'Cancel', desktop: false });
  assert.deepEqual(line({ kind: 'interrupted' }).action.id, 'send_again');
  assert.deepEqual(line({ kind: 'timeout', afterMs: 60000 }).action, { id: 'retry', label: 'Retry', desktop: false });
  assert.equal(line({ kind: 'overloaded' }, { ...NAMES, final: true }).action.label, 'Retry');
  for (const kind of ['auth_invalid', 'out_of_credit', 'spend_limit', 'cap_spend', 'oauth_expired', 'region_blocked', 'identifier_blocked']) {
    assert.equal(line({ kind }).action.desktop, true, kind);
  }
  assert.equal(line({ kind: 'content_blocked' }).action.desktop, false, 'refusals: rephrase, no desktop fix');
});

test('userLine covers every kind with a headline, and never echoes provider text', () => {
  const noisy = classify(getManifest('openai'), { status: 401, body: { error: { message: 'Incorrect API key provided: sk-proj-****LEAK', code: 'invalid_api_key' } } });
  assert.doesNotMatch(JSON.stringify(userLine(noisy, NAMES)), /LEAK|Incorrect/);
  for (const kind of KINDS) {
    const l = line({ kind });
    assert.ok(l.headline && l.headline.length > 5, kind);
    assert.equal(typeof l.detail, 'string', kind);
  }
});

test('userLine: an empty reply, twice in one turn (fix-empty-reply), has its own line: ask again, or lower Thinking; another model where the model has no levels; never the generic one', () => {
  const l = line({ kind: 'empty_reply', code: 'length' });
  assert.deepEqual([l.headline, l.detail], ["NeverQuestAlone couldn't finish a reply.", 'Ask again, or lower Thinking.']);
  assert.deepEqual(l.action, { id: 'retry', label: 'Retry', desktop: false }, 'Retry sends it again; nothing to fix first');
  assert.equal(line({ kind: 'empty_reply', code: 'stop' }).detail, 'Ask again, or lower Thinking.');
  const none = line({ kind: 'empty_reply', code: 'length' }, { ...NAMES, thinking: false });
  assert.deepEqual([none.headline, none.detail], ["NeverQuestAlone couldn't finish a reply.", 'Ask again, or pick another model in the NeverQuestAlone app.']);
  assert.equal(line({ kind: 'empty_reply' }, { ...NAMES, companion: 'Mortimer' }).headline, "Mortimer couldn't finish a reply.", 'the companion\'s name');
  for (const x of [l, none]) assert.doesNotMatch(`${x.headline} ${x.detail}`, /Something went wrong|Anthropic|Claude/);
  assert.ok(KINDS.includes('empty_reply'));
  const e = makeError({ kind: 'empty_reply', provider: 'anthropic', code: 'length' });
  assert.deepEqual([e.kind, e.retryable], ['empty_reply', false], 'its own kind, never retried by retryPlan (the backend tried once more already)');
  assert.equal(retryPlan(e, 0).retry, false);
});

test('the ollama "context too small" line (§7.2)', () => {
  const l = line({ kind: 'context_too_long', reason: 'num_ctx' }, { ...NAMES, provider: 'Ollama', model: 'qwen3:8b' });
  assert.equal(l.headline, "This model's context is too small.");
});

test('D7: the busy line (retries done) and the out-of-credit line carry a second action, Pick Another AI, to the app; never an automatic switch', async () => {
  const { userLine, PICK_ANOTHER_AI } = await import('../../bridge/byok/providers/errors.mjs');
  assert.deepEqual(PICK_ANOTHER_AI, { id: 'pick_provider', label: 'Pick Another AI', desktop: true });
  assert.deepEqual(userLine({ kind: 'out_of_credit', provider: 'anthropic' }, { provider: 'Anthropic' }).alt, PICK_ANOTHER_AI);
  assert.deepEqual(userLine({ kind: 'overloaded' }, { provider: 'Anthropic', final: true }).alt, PICK_ANOTHER_AI);
  assert.equal(userLine({ kind: 'overloaded' }, { provider: 'Anthropic' }).alt, undefined, 'not while it still retries');
  assert.equal(userLine({ kind: 'auth_invalid' }, { provider: 'Anthropic' }).alt, undefined);
});
