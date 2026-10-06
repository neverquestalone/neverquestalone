// Setup's side of the app API (bridge/byok/app-api.mjs, setup-view.mjs, screen-permission.mjs;
// onboarding spec §9.3; plan §5.2): the terms, connect (and a first key with no credit), the saved
// key, status().setup, the install armed for when WoW closes, the launcher, Screen Recording's check
// and request (always a new instance of the helper), Other (custom). Everything is a fake: a memory
// key store, temp folders, a fake run and fetch, the mock provider server; never a real key, WoW,
// the keychain or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAppApi, ARM_POLL_MS, PERMISSION_LOOP_MS, PERMISSION_BACKOFF_MS, WINDOW_RECENT_MS } from '../../bridge/byok/app-api.mjs';
import { setupView, permissionOf, captureStateOf, helloView } from '../../bridge/byok/setup-view.mjs';
import { createScreenPermission, openArgs, parsePermission, ASKED_MS } from '../../bridge/byok/screen-permission.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';
import { ADDON_SOURCE } from '../../bridge/byok/wow.mjs';
import { configWithDefaults } from '../../bridge/config.mjs';
import { startMock, reply, errorReply, manifestsAt, tmpDir, CANARY_KEYS } from './helpers/byok-env.mjs';

const ALL_TERMS = { anthropic: { at: 1, v: 1 }, openai: { at: 1, v: 1 }, xai: { at: 1, v: 1 }, google: { at: 1, v: 1 } };

/** The app API alone (no backend, no bridge), on a memory key store and a temp home. */
async function api(t, { byok = {}, handler = null, wow = {}, platform = 'darwin', now = Date.now, screenPermission = null, restart = null, fetch = undefined, flavorDir = null, bridge = undefined, capture = undefined, egress = null } = {}) {
  const mock = handler ? await startMock(handler) : null;
  const home = tmpDir('bones-setup-home-');
  const keystore = createKeyStore({ backend: 'memory' });
  const manifests = mock ? manifestsAt(mock.url, ['anthropic', 'google', 'openai']) : loadManifests();
  const config = configWithDefaults({ wow: { flavorDir: flavorDir ?? path.join(home, 'nowhere') }, byok: { provider: 'anthropic', ...byok } });
  const lines = [];
  const log = (k, d) => lines.push(JSON.stringify({ k, ...d }));
  const restarts = [];
  const a = createAppApi({
    keystore, config, paths: { userData: home }, log, manifests, home, platform, now, fetch,
    wow: { run: () => ({ status: 1, stdout: '' }), roots: [], ...wow }, restart: restart ?? (async () => { restarts.push(now()); }),
    ...(screenPermission ? { screenPermission } : {}), ...(bridge !== undefined ? { bridge } : {}), ...(capture !== undefined ? { capture } : {}), ...(egress ? { egress } : {}),
  });
  t.after(async () => { await a.stop(); await mock?.close(); });
  return { api: a, keystore, config, home, mock, lines, restarts };
}

// CI run 37150133957 (windows 2/3): a socket the mock provider kept alive outlived the test that opened
// it, and Node 22's fetch threw once later tests here mocked the timers (tests/byok/helpers/mock-provider.mjs).
test('the mock provider answers Connection: close, so no socket of a test here outlives it', async (t) => {
  const mock = await startMock(() => reply('ok'));
  t.after(() => mock.close());
  const res = await fetch(`${mock.url}/v1/messages`, { method: 'POST', body: '{}' });
  assert.equal(res.headers.get('connection'), 'close');
  await res.text();
});

test('recordTerms: saved at the version setup showed; a pasted key’s test refuses an AI company with none; Other has no terms of ours', async (t) => {
  const r = await api(t);
  assert.deepEqual(await r.api.testStagedKey('anthropic', () => CANARY_KEYS.anthropic), { ok: false, error: 'terms_required' });
  assert.deepEqual(await r.api.testStagedKey('google', () => CANARY_KEYS.google), { ok: false, error: 'terms_required' });
  assert.equal(r.api.signInOpenRouter, undefined, 'no OpenRouter sign-in: OpenRouter connects through Other');
  const rec = await r.api.recordTerms('anthropic', 1);
  assert.deepEqual(rec, { ok: true, v: 1 });
  assert.equal(r.config.byok.terms.anthropic.v, 1);
  assert.equal((await r.api.providers()).find(p => p.id === 'anthropic').terms.recorded, true);
  assert.equal((await r.api.providers()).find(p => p.id === 'openai').terms.recorded, false);
  assert.equal((await r.api.providers()).find(p => p.id === 'custom').terms.recorded, true, 'Other: the service\'s own terms, none of ours to show');
  assert.equal((await r.api.recordTerms('custom', 1)).error, 'bad_input');
  // An older version recorded isn't the current one.
  const old = await api(t, { byok: { terms: { anthropic: { at: 1, v: 0 } } } });
  assert.equal((await old.api.testStagedKey('anthropic', () => CANARY_KEYS.anthropic)).error, 'terms_required');
});

test('connect: saves the key and picks the default model (thinking low) for a new AI; noCredit only on a first key; a passing test clears the mark', async (t) => {
  const handler = (req) => (req.method === 'GET' ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-5' }] }) } : reply('ok', { input: 5, output: 1 }));
  const r = await api(t, { byok: { terms: ALL_TERMS }, handler });
  const first = await r.api.connect('anthropic', CANARY_KEYS.anthropic, { noCredit: true });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.first, true);
  assert.equal(r.config.byok.provider, 'anthropic');
  assert.equal(r.config.byok.model, 'claude-sonnet-5-5', 'the default model: Claude Sonnet 5.5 (fix-102)');
  assert.equal(r.config.byok.effort, 'low', 'thinking Low (DB22)');
  assert.equal(await r.keystore.get('anthropic'), CANARY_KEYS.anthropic);
  const listed = (await r.api.providers()).find(p => p.id === 'anthropic');
  assert.equal(listed.key.state, 'no_credit', 'saved, and says it needs credit (T1)');
  assert.ok(!JSON.stringify(first).includes('CANARY'), 'only the mask comes back');
  // noCredit on a key that's already saved is refused: a Replace never saves an unproven key.
  assert.equal((await r.api.connect('anthropic', CANARY_KEYS.anthropic, { noCredit: true })).error, 'bad_input');
  // A passing test of the saved key clears the mark.
  const tk = await r.api.testKey('anthropic');
  assert.equal(tk.ok, true, JSON.stringify(tk));
  assert.equal((await r.api.providers()).find(p => p.id === 'anthropic').key.state, 'ok');
  // Another AI's key: switches to its default model.
  const o = await r.api.connect('openai', CANARY_KEYS.openai);
  assert.equal(o.ok, true);
  assert.equal(r.config.byok.provider, 'openai');
  assert.equal(r.config.byok.model, 'gpt-6.1-sol', 'OpenAI\'s default: GPT-6.1 Sol (fix-102)');
  assert.equal(r.config.byok.effort, 'low');
  // A Google key: Gemini, its default model, thinking low.
  const g = await r.api.connect('google', CANARY_KEYS.google);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(r.config.byok.provider, 'google');
  assert.equal(r.config.byok.model, 'gemini-3.8-flash');
  assert.equal(r.config.byok.effort, 'low');
  // Other's key never goes through connect: it comes with its service's address (connectCustom).
  assert.equal((await r.api.connect('custom', CANARY_KEYS.openrouter)).error, 'bad_input');
  // A key of another AI's shape is refused before anything is written.
  assert.equal((await r.api.connect('anthropic', CANARY_KEYS.openai)).error, 'key_mismatch');
});

// fix-102: new setups get each AI's new default; a model a player already has stays as it is.
test('a saved older model stays (fix-102): a replaced key or Use saved key keeps Claude Haiku 4.5 and its level; only an AI new to the player takes its default', async (t) => {
  const handler = (req) => (req.method === 'GET' ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-4-5' }] }) } : reply('ok', { input: 5, output: 1 }));
  const r = await api(t, { byok: { terms: ALL_TERMS, model: 'claude-haiku-4-5', effort: null }, handler });
  await r.keystore.set('anthropic', CANARY_KEYS.anthropic);
  // A 1.0.x player on Haiku 4.5 (setup saved no level for it) pastes a new key: the model and level stay.
  const re = await r.api.connect('anthropic', CANARY_KEYS.anthropic.replace(/x{8}$/, 'NEWNEWNE'));
  assert.equal(re.ok, true, JSON.stringify(re));
  assert.equal(re.first, false);
  assert.deepEqual([r.config.byok.provider, r.config.byok.model, r.config.byok.effort], ['anthropic', 'claude-haiku-4-5', null]);
  assert.equal(re.model, 'Claude Haiku 4.5');
  // Setup's Use saved key for the AI in use: the same.
  const saved = await r.api.useSavedKey('anthropic');
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.deepEqual([r.config.byok.model, r.config.byok.effort], ['claude-haiku-4-5', null]);
  assert.equal(r.mock.requests.filter(x => x.method === 'POST').at(-1).body.model, 'claude-haiku-4-5', 'the key test uses the model in use');
  // A new AI takes its default at Low.
  const g = await r.api.connect('google', CANARY_KEYS.google);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.deepEqual([r.config.byok.provider, r.config.byok.model, r.config.byok.effort], ['google', 'gemini-3.8-flash', 'low']);
});

test('testStagedKey in setup: a failure is setup’s result (setupKind), with the model’s name; nothing is saved', async (t) => {
  const handler = (req) => (req.method === 'GET'
    ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-sonnet-5-5' }] }) }
    : errorReply(400, { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
  const r = await api(t, { byok: { terms: ALL_TERMS }, handler });
  const res = await r.api.testStagedKey('anthropic', () => CANARY_KEYS.anthropic, { context: 'setup' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'out_of_credit');
  assert.equal(res.documented, true);
  assert.equal(res.model, 'Claude Sonnet 5.5', 'the model setup tests with: the default (fix-102)');
  assert.equal(res.headline, undefined, 'no in-game words: the window has its own table');
  assert.equal(await r.keystore.get('anthropic'), null, 'nothing saved');
  // Without the setup context, the §10 line as before.
  const legacy = await r.api.testStagedKey('anthropic', () => CANARY_KEYS.anthropic);
  assert.equal(typeof legacy.headline, 'string');
});

test('useSavedKey: the saved key’s test, setup’s way; the AI becomes the one in use; a key store that won’t read is read_failed', async (t) => {
  const handler = (req) => (req.method === 'GET' ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }) } : reply('ok', { input: 5, output: 1 }));
  const r = await api(t, { byok: { terms: ALL_TERMS }, handler });
  assert.equal((await r.api.useSavedKey('anthropic')).error, 'no_key');
  await r.keystore.set('anthropic', CANARY_KEYS.anthropic);
  const ok = await r.api.useSavedKey('anthropic');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(r.config.byok.provider, 'anthropic');
  const noTerms = await api(t, { handler });
  await noTerms.keystore.set('anthropic', CANARY_KEYS.anthropic);
  assert.equal((await noTerms.api.useSavedKey('anthropic')).error, 'terms_required');
  const broken = await api(t, { byok: { terms: ALL_TERMS } });
  broken.keystore.get = async () => { throw Object.assign(new Error('locked'), { code: 'keystore_error' }); };
  assert.equal((await broken.api.useSavedKey('anthropic')).error, 'read_failed');
});

// ---------------------------------------------------------------------------
// status().setup

test('setupView: the hello from the core’s token; stream or reload is Screen Reading off; first message and reply only as the core says', () => {
  const t0 = Date.UTC(2026, 8, 27, 9);
  assert.equal(helloView(null), null);
  const h = helloView({ helloAt: t0, iface: '11507', sig: 'ok', loc: 'deDE', fr: true, mode: 'stream', helloVia: 'strip' });
  assert.deepEqual(h, { at: t0, iface: '11507', sig: 'ok', loc: 'deDE', fr: true, mode: 'stream', via: 'strip' });
  assert.equal(helloView({ helloAt: t0, loc: 'de-DE; DROP' }).loc, null, 'a locale of the wrong shape is dropped');
  const base = { platform: 'darwin', now: t0, captureOn: true };
  for (const mode of ['stream', 'reload']) {
    const v = setupView({ ...base, core: { token: { helloAt: t0, mode } } });
    assert.equal(v.captureState, 'off', mode);
  }
  const fresh = setupView({ ...base, core: {} });
  assert.deepEqual([fresh.firstMsgAt, fresh.firstReplyAt, fresh.firstReplyBefore, fresh.firstWords, fresh.game.hello], [null, null, false, null, null]);
  const fr = setupView({ ...base, core: { token: { helloAt: t0, fr: true } } });
  assert.equal(fr.firstReplyBefore, true);
  assert.equal(fr.firstReplyAt, null, 'fr=1 never claims a reply this app never saw');
  const said = setupView({ ...base, core: { firstMsgAt: t0 + 1, firstReplyAt: t0 + 2, firstWords: 'x'.repeat(300) } });
  assert.equal(said.firstReplyAt, t0 + 2);
  assert.equal(said.firstWords.length, 200);
  assert.equal(setupView({ ...base, platform: 'win32' }).permission, 'n/a');
  assert.equal(setupView({ ...base, core: { warn: 'slot addons are for interface 11500, the client is 11507: run setup again and restart WoW' } }).game.ifaceMismatch, true);
});

test('Screen Recording in setup: not asked, asked for 2 minutes after the request, then denied while a check says no; a check or a read frame says granted', () => {
  const t0 = 1_000_000;
  const p = o => permissionOf({ platform: 'darwin', now: t0, requestedAt: null, probe: null, cs: null, decoded: false, ...o });
  assert.equal(p({}), 'not_asked');
  assert.equal(p({ requestedAt: t0 - 1000 }), 'asked');
  assert.equal(p({ requestedAt: t0 - 1000, probe: { permission: false } }), 'asked', 'still answering the box');
  assert.equal(p({ requestedAt: t0 - ASKED_MS - 1, probe: { permission: false } }), 'denied');
  assert.equal(p({ requestedAt: t0 - ASKED_MS - 1, probe: { permission: true } }), 'granted');
  assert.equal(p({ decoded: true, probe: { permission: false } }), 'granted', 'a decoded frame outranks any check');
  assert.equal(permissionOf({ platform: 'win32' }), 'n/a');
  const cs = o => captureStateOf({ platform: 'darwin', mode: 'pixel', captureOn: true, typedError: null, permission: 'granted', cs: { connected: true }, decoded: false, ...o });
  assert.equal(cs({ typedError: 'window_minimized' }), 'minimized');
  assert.equal(cs({ typedError: 'capture_blocked_by_app' }), 'blocked');
  assert.equal(cs({ typedError: 'signature_invalid' }), 'damaged');
  assert.equal(cs({ permission: 'denied' }), 'no_permission');
  assert.equal(cs({ decoded: true }), 'ok');
  assert.equal(cs({ cs: { connected: true, window: { id: 1 } } }), 'no_signal');
});

test('status().setup: the install row from the installs found (no search on every status), launcher, permission; Screen Recording’s request records when it was asked', async (t) => {
  const root = tmpDir('bones-wowroot-');
  const flavor = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavor, 'Interface'), { recursive: true });
  let finds = 0;
  const find = () => { finds += 1; return [{ flavorDir: flavor, flavor: '_forever_', root }]; };
  const calls = [];
  const screen = { probe: async () => { calls.push('probe'); return { permission: false }; }, request: async () => { calls.push('request'); return { permission: false }; } };
  const r = await api(t, { wow: { find, running: async () => ({ running: false }), launcher: () => ({ found: true, path: '/Applications/Battle.net.app' }) }, screenPermission: screen });
  const s1 = (await r.api.status()).setup;
  assert.equal(s1.addon.state, 'found');
  assert.equal(s1.addon.path, flavor);
  assert.equal(s1.launcher, true);
  assert.equal(s1.permission, 'not_asked');
  await r.api.status();
  await r.api.status();
  assert.equal(finds, 1, 'status reads the last find, never searches again');
  const req = await r.api.requestScreenPermission();
  assert.equal(req.ok, true);
  assert.ok(Number.isFinite(r.config.capture.permissionRequestedAt));
  assert.equal((await r.api.status()).setup.permission, 'asked');
  await new Promise(res => setImmediate(res));
  assert.deepEqual(calls, ['request'], 'the request’s own answer is the check');
  assert.equal((await r.api.status()).setup.permission, 'asked', 'still answering the box (2 minutes)');
  // Windows has no Screen Recording.
  const w = await api(t, { platform: 'win32' });
  assert.equal((await w.api.status()).setup.permission, 'n/a');
  assert.deepEqual(await w.api.requestScreenPermission(), { ok: false, error: 'unsupported' });
});

// Code health BR-05: a denied Screen Recording was checked every 10 s for as long as the app ran, each
// check a new helper launched after a signature check on the main thread.
const settled = async () => { for (let i = 0; i < 6; i++) await new Promise(res => setImmediate(res)); };

test('the Screen Recording loop (code health BR-05): while not granted and WoW runs, a check after 10 s, then 60 s, then every 5 min; a flip to granted restarts the helper and stops it; never in Screen Reading off', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(PERMISSION_BACKOFF_MS, [PERMISSION_LOOP_MS, 60_000, 300_000]);
  let answer = false;
  let probes = 0;
  const screen = { probe: async () => { probes += 1; return { permission: answer }; }, request: async () => ({ permission: false }) };
  let running = true;
  const core = { token: null };
  const bridge = { status: () => ({ ...core, companion: { gamePid: running ? 4242 : null } }) };
  const helperRestarts = [];
  const r = await api(t, { screenPermission: screen, bridge, capture: { status: () => ({ connected: true, permission: false }), restart: reason => { helperRestarts.push(reason); return true; } } });
  const after = async (ms) => { t.mock.timers.tick(ms); await settled(); return probes; };
  await r.api.status(); // WoW runs, not granted: the loop starts
  assert.equal(await after(PERMISSION_LOOP_MS - 1), 0);
  assert.equal(await after(1), 1, 'the first after 10 s');
  assert.equal(await after(59_999), 1);
  assert.equal(await after(1), 2, 'then 60 s');
  assert.equal(await after(300_000), 3, 'then 5 min');
  assert.equal(await after(300_000), 4, 'and every 5 min after that');
  answer = true;
  assert.equal(await after(300_000), 5);
  assert.deepEqual(helperRestarts, ['screen recording granted'], 'turned on in System Settings: the helper starts again');
  assert.equal(r.restarts.length, 0, 'the helper alone, never the core: a reply in flight stays (SY-04)');
  assert.equal((await r.api.status()).setup.permission, 'granted');
  assert.equal(await after(PERMISSION_BACKOFF_MS.at(-1) * 3), 5, 'granted: it stops');
  // Screen Reading off (the hello says stream): no loop at all.
  let p2 = 0;
  core.token = { helloAt: 1, mode: 'stream' };
  const off = await api(t, { screenPermission: { probe: async () => { p2 += 1; return { permission: false }; }, request: async () => ({}) }, bridge });
  await off.api.status();
  t.mock.timers.tick(PERMISSION_BACKOFF_MS.at(-1) * 3);
  await settled();
  assert.equal(p2, 0);
  running = false;
});

test('the Screen Recording loop (code health BR-05): with WoW closed, a denied permission is checked only while the window was in front lately (its focus asks for a fresh check), on the same backoff, then not at all', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let clock = 1_790_000_000_000;
  let probes = 0;
  const screen = { probe: async () => { probes += 1; return { permission: false }; }, request: async () => ({ permission: false }) };
  const bridge = { status: () => ({ token: null, companion: { gamePid: null } }) };
  const r = await api(t, { now: () => clock, screenPermission: screen, bridge, wow: { running: async () => ({ running: false }) }, capture: { status: () => ({ connected: true, permission: false }) } });
  const after = async (ms) => { clock += ms; t.mock.timers.tick(ms); await settled(); return probes; };
  r.config.capture.permissionRequestedAt = clock - 3_600_000; // asked an hour ago, and denied
  assert.equal((await r.api.status()).setup.permission, 'denied');
  assert.equal(await after(24 * 3_600_000), 0, 'WoW closed, the window not in front: no check in a day (was 8,640)');
  // The player brings the window to the front: a check now, then 10 s, 60 s and 5 min on.
  await r.api.screenPermission({ fresh: true });
  assert.equal(probes, 1);
  assert.equal(await after(PERMISSION_LOOP_MS), 2);
  assert.equal(await after(60_000), 3);
  assert.equal(await after(300_000), 4);
  assert.ok(370_000 + 300_000 > WINDOW_RECENT_MS);
  assert.equal(await after(300_000), 4, 'the window not in front for 10 minutes: no more');
  assert.equal(await after(24 * 3_600_000), 4);
  // Allow (the request) is the window too: the loop runs again while it's answered.
  await r.api.requestScreenPermission();
  await settled();
  assert.equal(await after(PERMISSION_LOOP_MS), 5);
});

test('screen-permission: the check and the request are always a new instance of the helper (open -n -g -W), after its signature check; one {permission} line', async () => {
  assert.deepEqual(openArgs('/A/Helper.app', '--check-permission', '/t/o', '/t/e'), ['-n', '-g', '-W', '-a', '/A/Helper.app', '--stdout', '/t/o', '--stderr', '/t/e', '--args', '--check-permission']);
  assert.equal(parsePermission('{"info":"x"}\n{"permission":true}\n'), true);
  assert.equal(parsePermission('noise'), null);
  const dir = tmpDir('bones-helper-');
  const app = path.join(dir, 'Helper.app');
  fs.mkdirSync(app);
  const runs = [];
  const run = async (cmd, args, o) => {
    runs.push([cmd, args, o.timeout]);
    fs.writeFileSync(args[args.indexOf('--stdout') + 1], '{"permission":false}\n');
    return { status: 0 };
  };
  const sp = createScreenPermission({ app, verify: async () => true, run });
  assert.deepEqual(await sp.probe(), { permission: false });
  assert.deepEqual(await sp.request(), { permission: false });
  assert.equal(runs[0][0], '/usr/bin/open');
  assert.equal(runs[0][1][0], '-n', 'a new instance, so a running socket helper doesn’t swallow it');
  assert.equal(runs[0][1].at(-1), '--check-permission');
  assert.equal(runs[1][1].at(-1), '--request-permission');
  assert.equal(runs[0][2], 10_000);
  assert.equal(runs[1][2], 130_000);
  const unsigned = createScreenPermission({ app, verify: async () => false, run });
  assert.deepEqual(await unsigned.probe(), { permission: null, error: 'signature_invalid' });
  assert.equal(runs.length, 2, 'a helper that fails its check never runs');
  assert.deepEqual(await createScreenPermission({ app: path.join(dir, 'missing.app'), run }).probe(), { permission: null, error: 'helper_missing' });
});

// ---------------------------------------------------------------------------
// The install, armed for when WoW closes.

function wowFixture() {
  const root = tmpDir('bones-wowroot-');
  const flavor = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavor, 'Interface', 'AddOns'), { recursive: true });
  return { root, flavor, find: () => [{ flavorDir: flavor, flavor: '_forever_', root }] };
}

test('armInstall: never while WoW runs; installs once the first time it doesn’t, then restarts; Cancel disarms; a WoW started during the install is a race', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const w = wowFixture();
  let running = true;
  const installs = [];
  const install = (o) => { installs.push(o.flavorDir); fs.mkdirSync(path.join(o.flavorDir, 'Interface', 'AddOns', 'NeverQuestAlone'), { recursive: true }); fs.writeFileSync(path.join(o.flavorDir, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), '## Version: 0.0.1\n'); return { ok: true, steps: [{ name: 'Addon folder', ok: true }], permissions: { ok: true } }; };
  const r = await api(t, { wow: { find: w.find, running: async () => ({ running }), install, addonSource: ADDON_SOURCE } });
  const armed = await r.api.armInstall({});
  assert.deepEqual([armed.ok, armed.armed, armed.path], [true, true, w.flavor]);
  assert.equal((await r.api.status()).setup.addon.state, 'armed');
  t.mock.timers.tick(ARM_POLL_MS);
  await new Promise(res => setImmediate(res));
  assert.deepEqual(installs, [], 'never while WoW runs');
  running = false;
  t.mock.timers.tick(ARM_POLL_MS);
  for (let i = 0; i < 5; i++) await new Promise(res => setImmediate(res));
  assert.deepEqual(installs, [w.flavor], 'once, the first time it doesn’t');
  assert.equal(r.restarts.length, 1, 'then the bridge starts with it');
  t.mock.timers.tick(ARM_POLL_MS * 3);
  await new Promise(res => setImmediate(res));
  assert.equal(installs.length, 1, 'not again');
  assert.equal((await r.api.status()).setup.addon.state, 'older', 'installed: an addon older than the one this app ships says so');
  // Older, never just different: a newer copy (a store's, a test build's) is current, so nothing downgrades it (2026-10-05).
  fs.writeFileSync(path.join(installs[0], 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), '## Version: 9.9.9\n');
  assert.equal((await r.api.status()).setup.addon.state, 'current', 'a newer addon is never called older');
  fs.writeFileSync(path.join(installs[0], 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), '## Version: 0.0.1\n');
  // Cancel disarms.
  running = true;
  const again = await api(t, { wow: { find: wowFixture().find, running: async () => ({ running }), install } });
  await again.api.armInstall({});
  assert.deepEqual(await again.api.cancelInstall(), { ok: true, cancelled: true });
  assert.notEqual((await again.api.status()).setup.addon.state, 'armed');
  // A race: WoW started while the files went in (so they didn't load).
  let started = false;
  const racing = await api(t, { wow: { find: wowFixture().find, running: async () => ({ running: started }), install: (o) => { started = true; return install(o); } } });
  await racing.api.armInstall({});
  assert.equal((await racing.api.status()).setup.addon.state, 'race');
});

test('setup’s install: EPERM carries the administrator’s command on Windows (D-37), none on a Mac (UX-W28); ENOSPC is disk_full', async (t) => {
  const w = wowFixture();
  const eperm = () => ({ ok: false, error: 'install_failed', steps: [{ name: 'Addon folder', ok: false, error: 'EPERM' }] });
  const perms = () => ({ ok: false, fixable: false, paths: [path.join(w.flavor, 'Interface', 'AddOns')], links: [] });
  const r = await api(t, { wow: { find: w.find, running: async () => ({ running: false }), install: eperm, permissions: perms } });
  await r.api.setupInstall({});
  const a = (await r.api.status()).setup.addon;
  assert.equal(a.state, 'eperm');
  // chmod go-w takes write access from other accounts; it wouldn't give this one the folder, so a
  // Mac gets no command, and the row says what to ask an administrator for (epermNoSid's words).
  assert.equal(a.admin, null, 'no command that doesn’t fix what the row says');
  // Windows: icacls gives this account its own change permission there, by its SID.
  const win = await api(t, { platform: 'win32', wow: { find: w.find, running: async () => ({ running: false }), install: eperm, sid: () => 'S-1-5-21-1-2-3-1001', permissions: () => ({ ok: false, fixable: false, grants: ['BUILTIN\\Users:(OI)(CI)(M)'], paths: [path.join(w.flavor, 'Interface', 'AddOns')], links: [] }) } });
  await win.api.setupInstall({});
  const wa = (await win.api.status()).setup.addon;
  assert.equal(wa.state, 'eperm');
  assert.match(wa.admin.command, /^icacls ".+AddOns" \/inheritance:d \/grant:r \*S-1-5-32-545:\(OI\)\(CI\)RX \*S-1-5-21-1-2-3-1001:\(OI\)\(CI\)M$/);
  assert.equal(wa.admin.explanation, 'Stops other accounts from changing the AddOns folder; yours still can.');
  const full = await api(t, { wow: { find: wowFixture().find, running: async () => ({ running: false }), install: () => ({ ok: false, error: 'install_failed', steps: [{ ok: false, error: 'ENOSPC' }] }) } });
  await full.api.setupInstall({});
  assert.equal((await full.api.status()).setup.addon.state, 'disk_full');
  const busy = await api(t, { wow: { find: wowFixture().find, running: async () => ({ running: true }) } });
  assert.equal((await busy.api.setupInstall({})).error, 'wow_running');
  // A first install that fails isn't an update; one over an older addon is, so the row says
  // "The addon didn’t update." with Update again (onboarding strings, failed.headlineUpdate).
  assert.equal((await full.api.status()).setup.addon.update, false);
  const old = wowFixture();
  fs.mkdirSync(path.join(old.flavor, 'Interface', 'AddOns', 'NeverQuestAlone'), { recursive: true });
  fs.writeFileSync(path.join(old.flavor, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), '## Version: 0.0.1\n');
  const upd = await api(t, { wow: { find: old.find, running: async () => ({ running: false }), install: () => ({ ok: false, error: 'install_failed', steps: [{ ok: false, error: 'EIO' }] }) } });
  await upd.api.setupInstall({});
  const ua = (await upd.api.status()).setup.addon;
  assert.deepEqual([ua.state, ua.update], ['failed', true]);
});

test('launcher: Battle.net where the OS keeps it', async (t) => {
  const r = await api(t, { wow: { launcher: () => ({ found: true, path: '/Applications/Battle.net.app' }) } });
  assert.deepEqual(await r.api.launcher(), { found: true, path: '/Applications/Battle.net.app' });
  const none = await api(t, { wow: { launcher: () => ({ found: false }) } });
  assert.deepEqual(await none.api.launcher(), { found: false, path: null });
});

// ---------------------------------------------------------------------------
// Other (custom): the player's own OpenAI-compatible service.

/** A fake network and egress guard for connectCustom: what was sent, where, and what was allowed then. */
function customNet(answer = () => ({ status: 200, body: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n` })) {
  const sent = [];
  const widened = [];
  let open = null;
  const egress = { widen: (hosts, feature) => { open = { hosts: [...hosts], feature }; widened.push(open); return () => { open = null; }; }, ledger: () => [] };
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    sent.push({ url: String(url), method: init.method ?? 'GET', auth: init.headers?.authorization ?? null, body: init.body ? JSON.parse(init.body) : null, allowed: open ? open.hosts.includes(u.hostname) : false });
    const a = answer(u);
    return new Response(a.body ?? '', { status: a.status, headers: { 'content-type': a.type ?? 'text/event-stream' } });
  };
  return { fetch, egress, sent, widened };
}

test('connectCustom: one tiny request to <base URL>/chat/completions (its host allowed for it alone), then the service, its model and its key saved and in use', async (t) => {
  const net = customNet();
  const r = await api(t, { fetch: net.fetch, egress: net.egress });
  const res = await r.api.connectCustom({ baseUrl: 'https://openrouter.ai/api/v1/', model: 'openai/gpt-5-mini', key: `  ${CANARY_KEYS.openrouter}\n` });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual({ ...res, testCall: undefined }, { ok: true, name: 'openrouter.ai', model: 'openai/gpt-5-mini', local: false, masked: 'sk-or-…xxxx', testCall: undefined });
  assert.equal(net.sent.length, 1, 'one request, no model list');
  assert.deepEqual([net.sent[0].method, net.sent[0].url, net.sent[0].auth, net.sent[0].allowed], ['POST', 'https://openrouter.ai/api/v1/chat/completions', `Bearer ${CANARY_KEYS.openrouter}`, true]);
  assert.equal(net.sent[0].body.model, 'openai/gpt-5-mini');
  assert.deepEqual(net.widened, [{ hosts: ['openrouter.ai'], feature: 'key_test' }], 'exactly its one host');
  assert.equal(await r.keystore.get('custom'), CANARY_KEYS.openrouter, 'the key, trimmed');
  assert.deepEqual(r.config.byok.custom, { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' });
  assert.deepEqual([r.config.byok.provider, r.config.byok.model, r.config.byok.effort], ['custom', 'openai/gpt-5-mini', null]);
  assert.ok(!JSON.stringify(res).includes('CANARY'), 'only the mask comes back');
  const listed = (await r.api.providers()).find(p => p.id === 'custom');
  assert.deepEqual(listed.custom, { baseUrl: 'https://openrouter.ai/api/v1', host: 'openrouter.ai', model: 'openai/gpt-5-mini', local: false });
  assert.deepEqual([listed.name, listed.auth, listed.key.saved, listed.local], ['openrouter.ai', 'custom', true, false]);
  assert.deepEqual(listed.models.map(m => [m.id, m.priceHint]), [['openai/gpt-5-mini', undefined]], 'no price shown for another service');
  // Again with no key (a service that takes none): the saved key goes; no authorization header is sent.
  const again = await r.api.connectCustom({ baseUrl: 'https://api.example.com/v1', model: 'm-1' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(net.sent[1].auth, null);
  assert.equal(await r.keystore.get('custom'), null);
  assert.equal((await r.api.providers()).find(p => p.id === 'custom').key.saved, false);
});

test('connectCustom at a server on the player\'s own network (http://192.168…, no key): connects, never local, its messages leave this computer (a player, 2026-10-05)', async (t) => {
  const net = customNet();
  const r = await api(t, { fetch: net.fetch, egress: net.egress });
  const res = await r.api.connectCustom({ baseUrl: 'http://192.168.1.20:11434/v1', model: 'qwen3:8b', key: '' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.local, true, 'another computer at home is not this computer');
  assert.equal(net.sent[0].url, 'http://192.168.1.20:11434/v1/chat/completions');
});

test('connectCustom at a server on this computer (http://localhost, no key): local, $0, its messages stay here', async (t) => {
  const net = customNet();
  const r = await api(t, { fetch: net.fetch, egress: net.egress });
  const res = await r.api.connectCustom({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', key: '' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.local, true);
  assert.equal(res.testCall.micros, 0);
  assert.equal(net.sent[0].url, 'http://localhost:11434/v1/chat/completions');
  assert.equal(net.widened[0].feature, 'local_model');
  const listed = (await r.api.providers()).find(p => p.id === 'custom');
  assert.equal(listed.local, true);
  assert.equal(listed.privacyCard.class, 'local');
  assert.deepEqual(listed.models[0].priceHint, { local: true });
});

test('connectCustom refuses a bad address or model before anything is sent; a failed test saves nothing', async (t) => {
  const net = customNet(u => (u.hostname === 'down.example' ? { status: 401, type: 'application/json', body: JSON.stringify({ error: { message: 'bad key', code: 401 } }) } : { status: 404, type: 'application/json', body: JSON.stringify({ error: { message: 'no model', code: 404 } }) }));
  const r = await api(t, { fetch: net.fetch, egress: net.egress });
  for (const [baseUrl, error] of [['http://openrouter.ai/api/v1', 'https_required'], ['http://8.8.8.8:11434/v1', 'https_required'], ['https://u:p@x.example/v1', 'credentials'],
    ['https://x.example/v1?key=1', 'query'], ['https://x.example/v1#a', 'query'], ['ftp://x.example/v1', 'not_http'], ['nope', 'bad_url'], ['', 'empty']]) {
    assert.deepEqual(await r.api.connectCustom({ baseUrl, model: 'm' }), { ok: false, error }, baseUrl);
  }
  for (const model of ['', 'has space', '/leading', 'x'.repeat(200)]) assert.deepEqual(await r.api.connectCustom({ baseUrl: 'https://x.example/v1', model }), { ok: false, error: 'bad_model' }, model);
  assert.deepEqual(await r.api.connectCustom({ baseUrl: 'https://x.example/v1', model: 'm', key: 'two words' }), { ok: false, error: 'not_a_key' });
  assert.equal(net.sent.length, 0, 'nothing was sent');
  const rejected = await r.api.connectCustom({ baseUrl: 'https://down.example/v1', model: 'm', key: CANARY_KEYS.openrouter });
  assert.deepEqual([rejected.ok, rejected.error], [false, 'auth_invalid']);
  const missing = await r.api.connectCustom({ baseUrl: 'https://x.example/v1', model: 'missing' });
  assert.deepEqual([missing.ok, missing.error], [false, 'model_access']);
  assert.equal(await r.keystore.get('custom'), null, 'nothing saved');
  assert.equal(r.config.byok.custom, undefined);
  assert.equal(r.config.byok.provider, 'anthropic', 'the AI in use is unchanged');
  assert.ok(!r.lines.join('\n').includes('CANARY'));
});

test('Other\'s saved key: testKey tests the service in use; deleteKey removes it; setKey refuses it (its key comes with its address)', async (t) => {
  const net = customNet();
  const r = await api(t, { fetch: net.fetch, egress: net.egress });
  assert.equal((await r.api.connectCustom({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', key: CANARY_KEYS.openrouter })).ok, true);
  const tk = await r.api.testKey('custom');
  assert.equal(tk.ok, true, JSON.stringify(tk));
  assert.equal(net.sent.at(-1).url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal((await r.api.setKey('custom', CANARY_KEYS.openrouter)).error, 'bad_input');
  assert.deepEqual(await r.api.deleteKey('custom'), { ok: true });
  assert.equal(await r.keystore.get('custom'), null);
});

test('connectCustom again with another model at the same service: the test asks for the new model, never the one in use', async (t) => {
  const net = customNet();
  const r = await api(t, { fetch: net.fetch, egress: net.egress });
  assert.equal((await r.api.connectCustom({ baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' })).ok, true);
  assert.equal((await r.api.connectCustom({ baseUrl: 'https://api.groq.com/openai/v1', model: 'qwen/qwen3-32b' })).ok, true);
  assert.deepEqual(net.sent.map(x => x.body.model), ['llama-3.3-70b-versatile', 'qwen/qwen3-32b']);
  assert.deepEqual([r.config.byok.model, r.config.byok.custom.model], ['qwen/qwen3-32b', 'qwen/qwen3-32b']);
});
