// Setup's key-test results (bridge/byok/providers/setup-errors.mjs; onboarding spec §3.4.4, §9.3):
// the one tiny test request in Connect <AI> fails for reasons play never meets, each with its own
// fix. Each case is a docs-derived fixture through the real classify(), so play's order (code, type,
// status) and its kinds are what setup reclassifies. UNVERIFIED against live consoles (spec §12 R5–R8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../../bridge/byok/providers/errors.mjs';
import { setupKind } from '../../bridge/byok/providers/setup-errors.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';

const MS = Object.fromEntries(loadManifests().map(m => [m.id, m]));
const err = (id, status, error, extra = {}) => classify(MS[id], { status, body: JSON.stringify({ type: 'error', error, ...extra }), now: Date.UTC(2026, 8, 27) });
const kindOf = (id, status, error, extra) => setupKind(err(id, status, error, extra), id);

test('Anthropic: workspace, model access, region, the tier cap, and documented no credit', () => {
  assert.equal(kindOf('anthropic', 400, { type: 'invalid_request_error', message: 'anthropic-workspace-id is required for this key' }).error, 'workspace_required');
  assert.equal(kindOf('anthropic', 403, { type: 'permission_error', message: 'Your API key does not have permission to use the specified resource.' }).error, 'model_access');
  assert.equal(kindOf('anthropic', 404, { type: 'not_found_error', message: 'model: claude-haiku-4-5' }).error, 'model_access');
  assert.equal(kindOf('anthropic', 403, { type: 'forbidden', message: 'Request not allowed' }).error, 'region_blocked');
  const tier = kindOf('anthropic', 429, { type: 'rate_limit_error', message: 'You have reached your specified API usage limits.', details: { error_code: 'enforced_spend_limit_reached' } });
  assert.equal(tier.error, 'spend_limit');
  assert.equal(tier.tier, true, 'the monthly tier cap, not a limit the player set');
  assert.equal(tier.resetAt, Date.UTC(2026, 9, 1), 'until the 1st');
  const low = kindOf('anthropic', 400, { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' });
  assert.deepEqual([low.error, low.documented], ['out_of_credit', true]);
  const billing = kindOf('anthropic', 402, { type: 'billing_error', message: 'billing' });
  assert.deepEqual([billing.error, billing.documented], ['out_of_credit', true]);
  assert.equal(kindOf('anthropic', 401, { type: 'authentication_error', message: 'invalid x-api-key' }).error, 'auth_invalid');
});

test('OpenAI: missing scopes, an organization to verify, model access, and documented no credit', () => {
  assert.equal(kindOf('openai', 401, { message: 'You have insufficient permissions for this operation. Missing scopes: model.request.', type: 'invalid_request_error', code: null }).error, 'key_restricted');
  assert.equal(kindOf('openai', 400, { message: 'Your organization must be verified to use the model `gpt-6-luna`.', type: 'invalid_request_error', code: 'unsupported_value' }).error, 'org_verification');
  assert.equal(kindOf('openai', 404, { message: 'The model `gpt-6-luna` does not exist or you do not have access to it.', type: 'invalid_request_error', code: 'model_not_found' }).error, 'model_access');
  const quota = kindOf('openai', 429, { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' });
  assert.deepEqual([quota.error, quota.documented], ['out_of_credit', true]);
  const exhausted = kindOf('openai', 429, { message: 'Credit balance exhausted.', type: 'insufficient_quota', code: 'credit_balance_exhausted' });
  assert.deepEqual([exhausted.error, exhausted.documented], ['out_of_credit', true]);
  assert.equal(kindOf('openai', 401, { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' }).error, 'auth_invalid');
});

test('xAI: a 400 is a bad key; a 429 or 402 on the one test is no credit, inferred (held, never saved as no credit)', () => {
  assert.equal(kindOf('xai', 400, { message: 'Incorrect API key provided: xa***. You can obtain an API key from https://console.x.ai.' }).error, 'auth_invalid');
  for (const status of [429, 402]) {
    const r = kindOf('xai', status, { message: 'Your team has no credits.' });
    assert.deepEqual([r.error, r.inferred, r.documented], ['out_of_credit', true, false], String(status));
  }
});

// Gemini's OpenAI compatibility layer wraps its errors in a list: [{error: {code, message, status}}].
const gemini = (status, message, st) => setupKind(classify(MS.google, { status, body: JSON.stringify([{ error: { code: status, message, status: st } }]), now: Date.UTC(2026, 8, 27) }), 'google');

test('Gemini: a bad key is a 400 that says so; the region, a key without the API, and a model with no quota (held, inferred)', () => {
  assert.equal(gemini(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT').error, 'auth_invalid');
  assert.equal(gemini(400, 'User location is not supported for the API use.', 'FAILED_PRECONDITION').error, 'region_blocked');
  assert.equal(gemini(403, 'Permission denied on resource project.', 'PERMISSION_DENIED').error, 'model_access', 'a good key without access, never a rejected one');
  assert.equal(gemini(404, 'models/gemini-9 is not found.', 'NOT_FOUND').error, 'model_access');
  const quota = gemini(429, 'You exceeded your current quota, please check your plan and billing details.', 'RESOURCE_EXHAUSTED');
  assert.deepEqual([quota.error, quota.inferred, quota.documented], ['out_of_credit', true, false], 'one request can’t hit a rate limit: billing isn’t set up');
  assert.equal(gemini(400, 'Invalid JSON payload received.', 'INVALID_ARGUMENT').error, 'failed', 'any other 400 is ours, not the key');
});

test('Other (custom): a service the app knows nothing of maps by play’s kind alone', () => {
  const t = loadManifests().find(m => m.id === 'custom');
  const k = (status, body) => setupKind(classify(t, { status, body: JSON.stringify(body) }), 'custom').error;
  assert.equal(k(401, { error: { message: 'bad key', code: 401 } }), 'auth_invalid');
  assert.equal(k(402, { error: { message: 'Insufficient credits', code: 402, metadata: { limit_source: 'openrouter_credits' } } }), 'out_of_credit');
  assert.equal(k(404, { error: { message: 'no such model', code: 404 } }), 'model_access');
  assert.equal(k(429, { error: { message: 'slow down' } }), 'rate_limited');
  assert.equal(k(503, { error: { message: 'busy' } }), 'overloaded');
});

test('documented is true only for the documented signals; the rest map by play’s kind', () => {
  const guessed = setupKind({ kind: 'out_of_credit', status: 402 }, 'xai');
  assert.equal(guessed.documented, false);
  const plain = setupKind({ kind: 'out_of_credit', status: 400 }, 'anthropic');
  assert.equal(plain.documented, false, 'a 400 with no documented message');
  for (const [kind, error] of [['rate_limited', 'rate_limited'], ['rate_limited_daily', 'rate_limited'], ['overloaded', 'overloaded'], ['timeout', 'overloaded'],
    ['network_before_send', 'network'], ['network_after_send', 'network'], ['tls', 'network'], ['egress_blocked', 'restart'], ['spend_limit', 'spend_limit'],
    ['region_blocked', 'region_blocked'], ['auth_invalid', 'auth_invalid'], ['oauth_expired', 'auth_invalid'], ['bad_request', 'failed'], ['unknown', 'failed']]) {
    assert.equal(setupKind({ kind }, 'custom').error, error, kind);
  }
  assert.equal(setupKind({ kind: 'no_key', code: 'keystore_error' }, 'anthropic').error, 'keystore_error');
  assert.equal(setupKind(null, 'anthropic').error, 'failed');
});

// fix-102 (2026-09-30): the app's own guard refused api.anthropic.com after its bridge stopped, and
// setup told a player with a good key and a working internet to check their internet. Every
// request setup's test makes goes to the AI's own host, so a guard's refusal there is the app's
// fault: its own result, restart, for every AI, whether the guard had stopped or lost the host.
test('fix-102: a guard refusal in setup\'s test is restart for every AI, stopped or not, never network', () => {
  for (const id of ['anthropic', 'openai', 'xai', 'google', 'custom']) {
    for (const code of ['EGRESS_STOPPED', 'EGRESS_BLOCKED']) {
      const r = setupKind({ kind: 'egress_blocked', code, provider: id, retryable: false }, id);
      assert.equal(r.error, 'restart', `${id} ${code}`);
      assert.notEqual(r.error, 'network', `${id} ${code}`);
    }
  }
  // A real network failure keeps its line.
  assert.equal(setupKind({ kind: 'network_before_send', code: 'ENOTFOUND' }, 'anthropic').error, 'network');
});
