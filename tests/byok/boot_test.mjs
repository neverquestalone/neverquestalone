// Booting the public bridge (bridge/byok/boot.mjs; BUILD-PLAN "boot.mjs"; public BYOK PRD §8.1,
// §8.4, §11.2, SC-1, KY-6/KY-7/KY-9, TH10/TH15): the assembly the desktop app runs (there is no
// headless bridge and no control pipe, systems plan D6). Temp folders for WoW, the app's data and the locks;
// a memory key store with canary keys; the providers' mock server on 127.0.0.1; a stand-in capture
// helper. The egress guard is the real one (process-wide, uninstalled by stop()).
import test from 'node:test';
import assert from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { bootByok, takeBridgeLock, withPrivacy, secretKeystore, pidAlive, givenFlavorDir } from '../../bridge/byok/boot.mjs';
import * as bootModule from '../../bridge/byok/boot.mjs';
import { DEFAULTS, configWithDefaults } from '../../bridge/config.mjs';
import { lockFileFor, captureSocketPath, SOCKET_PATH_MAX } from '../../bridge/byok/paths.mjs';
import { installAddon, readUninstallRecord, UNINSTALL_RECORD, FOREVER_FLAVORS, NOT_GAME } from '../../bridge/byok/wow.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { redact } from '../../bridge/byok/security/redact.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';
import { startMock, reply, manifestsAt, waitFor, sendParams, tmpDir, CANARY_KEYS } from './helpers/byok-env.mjs';
import { scanDirForCanaries } from './helpers/canary.mjs';

const TIMEOUTS = { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 };
const CTX = 'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)\nCharacter: Tavi on Testrealm, level 8 Tauren Shaman (Horde)';
const json = (body, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const posts = mock => mock.requests.filter(r => r.method === 'POST');

/** The addon's side of a session, as the capture helper hands its records to the core: a hello, then typed messages. */
function inGame(bridge, { chat = 'c3f9a1e', nonce = 'a3f1', token = '3fa9c2d1' } = {}) {
  let n = 0;
  const rec = (type, args = {}, extra = {}) => encodeRecord({ token, key: type === 'hello' ? nonce : `${nonce}_${++n}`, type, chat: type === 'hello' ? '' : chat, args: { cur: 0, ...args }, ...extra });
  bridge.handlePayload(rec('hello', { ver: '1.4.0', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: 3, sid: 'a1b2c3d4e5f60718' }, { body: CTX }), 'strip');
  return { say: text => bridge.handlePayload(rec('msg', { agent: 'main', name: 'Route', ctx: 1, q: 'followup' }, { text, context: CTX }), 'strip') };
}
const NOT_RUNNING = () => ({ status: 1, stdout: '' });
// WoW running, as the process list shows it (pgrep, or tasklist's CSV on Windows).
const RUNNING = cmd => (/pgrep$|tasklist/i.test(cmd) ? { status: 0, stdout: process.platform === 'win32' ? '"WowClassicB.exe","5120","Console","1","900,000 K"\r\n' : '5120\n' } : { status: 1, stdout: '' });
// The old guard hooked every socket in the process; the guarded fetch hooks nothing (SY-13).
const socketHooks = () => dc.channel('net.client.socket').hasSubscribers || dc.channel('undici:client:beforeConnect').hasSubscribers;

/** A WoW install in a temp folder, with the addon (and 3 slots) when asked. */
function wowFolder({ addon = true } = {}) {
  const root = tmpDir('bones-boot-wow-');
  const flavorDir = path.join(root, '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  if (addon) assert.equal(installAddon({ flavorDir, running: false, slots: 3 }).ok, true);
  return { root, flavorDir, addonsDir: path.join(flavorDir, 'Interface', 'AddOns') };
}

// rawConfig: the config exactly as given (null: none, so boot reads <userData>/config.json, which isn't there).
async function boot(t, { flavorDir = null, keys = [], handler = null, config = {}, rawConfig, ...extra } = {}) {
  const mock = handler ? await startMock(handler) : null;
  if (mock) t.after(() => mock.close());
  const root = tmpDir('bones-boot-');
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const keystore = createKeyStore({ backend: 'memory' });
  for (const id of keys) await keystore.set(id, CANARY_KEYS[id]);
  const lines = [];
  const secrets = new Set();
  const log = (k, d) => lines.push(`${k} ${JSON.stringify(d ?? {})}`);
  log.addSecret = s => secrets.add(s);
  log.scrub = s => redact(String(s), secrets);
  const opts = {
    paths: { userData: path.join(root, 'ud') }, home, env: {}, log, keystore,
    config: rawConfig !== undefined ? (rawConfig ?? undefined)
      : { wow: { flavorDir: flavorDir ?? path.join(root, 'no-wow') }, transport: { slots: 3 }, byok: { provider: 'anthropic' }, ...config },
    capture: false, lockDir: path.join(root, 'locks'),
    manifests: mock ? manifestsAt(mock.url) : undefined, providerOpts: { timeouts: TIMEOUTS }, backendOptions: { checks: { models: false } },
    wow: { run: NOT_RUNNING, roots: [] },
    ...extra,
  };
  const b = await bootByok(opts);
  t.after(() => b.stop());
  return { b, root, home, lines, secrets, keystore, mock, opts };
}

test('no WoW folder: the backend runs alone and the API answers; stop undoes everything, twice is once', async (t) => {
  const { b, lines } = await boot(t);
  assert.equal(b.bridge, null);
  assert.ok(b.backend, 'the backend alone');
  const st = await b.api.status();
  assert.equal(st.bridge.running, false);
  assert.equal(st.bridge.error, 'wow_not_found');
  assert.equal(st.backend.rt.state, 'no_key');
  assert.equal(typeof b.egress.fetch, 'function', 'the guarded fetch');
  assert.equal(socketHooks(), false, 'no process-wide socket hooks');
  assert.equal(b.config.byok.privacy.companion, false, 'automatic turns off until the player opts in');
  assert.equal(b.config.companion, undefined, 'no copy of the switch for the core: it reads byok.privacy (code health BR-28)');
  assert.ok(lines.some(l => l.startsWith('byok-no-bridge {"reason":"wow_not_found"}')));
  await b.stop();
  await b.stop();
  await assert.rejects(b.egress.fetch('http://127.0.0.1:9/'), e => e.cause?.code === 'EGRESS_STOPPED', 'nothing goes after stop, and the refusal says the guard stopped');
  assert.equal(b.egress.stopped(), true);
  assert.ok(!lines.some(l => /control/.test(l)), 'no control pipe');
});

test('no limits of the build\'s own (the owner, 2026-09-26; spec §9.9): a config saved by the capped build loses its $1.00 default and turn limits, written back once with v: 2; a limit the player sets later is kept, $1.00 included', async (t) => {
  const dir = tmpDir('bones-boot-cfg-');
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ backend: 'byok', wow: { flavorDir: path.join(dir, 'no-wow') }, byok: { provider: 'anthropic', caps: { dailyUsd: 1, typedPerDay: 200, autoPerDay: 20 } } }));
  const a = await boot(t, { rawConfig: null, configFile: file });
  assert.deepEqual(a.b.config.byok.caps, { v: 2, dailyUsd: null });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).byok.caps, { v: 2, dailyUsd: null }, 'written back at load');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).byok.provider, 'anthropic', 'the rest of the section as it was');
  assert.deepEqual(await a.b.api.caps(), { dailyUsd: null, spentTodayMicros: 0 });
  assert.equal(a.b.backend.caps.config().dailyUsd, null);
  assert.equal((await a.b.api.status()).backend.usage.capMicros, undefined);
  // The player sets one, the old default's amount even: saved with v: 2, so the next launch keeps it.
  assert.deepEqual(await a.b.api.setCaps({ dailyUsd: 1 }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).byok.caps, { v: 2, dailyUsd: 1 });
  await a.b.stop();
  const again = await boot(t, { rawConfig: null, configFile: file });
  assert.deepEqual(await again.b.api.caps(), { dailyUsd: 1, spentTodayMicros: 0 });
  assert.equal(again.b.backend.caps.snapshot().capMicros, 1000000);
  // And turns it off again.
  assert.deepEqual(await again.b.api.setCaps({ dailyUsd: null }), { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).byok.caps, { v: 2, dailyUsd: null });
  assert.equal(again.b.backend.caps.snapshot().capMicros, undefined);
});

test('a limit the player chose on the capped build (any amount but the old $1.00 default, $0 included) is kept at the upgrade, enforced, and written back with v: 2', async (t) => {
  for (const [usd, micros] of [[0.5, 500000], [0, 0]]) {
    const dir = tmpDir('bones-boot-cfg-');
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ backend: 'byok', wow: { flavorDir: path.join(dir, 'no-wow') }, byok: { provider: 'anthropic', caps: { dailyUsd: usd, typedPerDay: 200, autoPerDay: 20 } } }));
    const a = await boot(t, { rawConfig: null, configFile: file });
    assert.deepEqual(a.b.config.byok.caps, { v: 2, dailyUsd: usd });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).byok.caps, { v: 2, dailyUsd: usd });
    assert.deepEqual(await a.b.api.caps(), { dailyUsd: usd, spentTodayMicros: 0 });
    assert.equal(a.b.backend.caps.snapshot().capMicros, micros);
    assert.equal((await a.b.api.status()).backend.usage.capMicros, micros);
    await a.b.stop();
  }
});

test('with WoW and the addon: the bridge runs on its AddOns folder under a lock that stop releases', async (t) => {
  const w = wowFolder();
  const { b, root } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'] });
  assert.ok(b.bridge, 'the bridge');
  const st = await b.api.status();
  assert.equal(st.bridge.running, true);
  assert.equal(st.wow.addon, true);
  // One lock (code health BR-27): the AddOns folder's, none in the state folder.
  const lock = path.join(w.addonsDir, 'NeverQuestAlone', 'sig', 'bridge.lock');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  if (process.platform !== 'win32') assert.equal(fs.statSync(lock).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(lockFileFor(path.join(root, 'locks'), w.addonsDir)), false);
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  assert.ok(fs.existsSync(path.join(w.addonsDir, 'NQA_S001', 'Inbox.lua')), 'the slots are published to');
  await b.stop();
  assert.equal(fs.existsSync(lock), false, 'released');
});

test('the runaway fuse reaches the window: a pause pushes a status whose usage says autoPaused (no reply follows to push it), status() and usage() carry it while it holds, and the player\'s next typed message ends it', async (t) => {
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Noted.\n\nTL;DR: noted.'),
    config: { byok: { provider: 'anthropic', privacy: { identity: false, otherNames: false, companion: true, echo: false, gameContext: true } } } });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  const g = inGame(b.bridge);
  let n = 0;
  const at = Math.floor(Date.now() / 1000);
  const evt = i => encodeRecord({ token: '3fa9c2d1', key: `e0f2_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'route_done', agent: 'main', name: 'Companion', sid: 'a1b2c3d4e5f60718', layer: `loop${i}`, at }, body: '' });
  const compReplies = () => b.bridge.buildSlot().records.filter(r => r.t === 'reply' && r.chat === 'c0ffee0').length;
  for (let i = 0; i < 10; i++) b.bridge.handlePayload(evt(i), 'strip');
  await waitFor(() => compReplies() === 10, 10000, 'ten replies');
  await new Promise(r => setTimeout(r, 400)); // the replies' own pushes are through
  const pushes = [];
  b.api.onChange(st => pushes.push(st));
  assert.equal(Object.hasOwn((await b.api.status()).backend.usage, 'autoPaused'), false, 'left out while it doesn\'t hold');
  b.bridge.handlePayload(evt(10), 'strip');
  assert.equal(b.bridge.status().companion.autoPaused, true);
  await waitFor(() => pushes.some(p => p.backend?.usage?.autoPaused === true), 3000, 'a status push that says so');
  assert.equal((await b.api.status()).backend.usage.autoPaused, true);
  assert.equal((await b.api.usage({ days: 1 })).today.autoPaused, true);
  const held = await b.api.status();
  assert.equal(Number.isInteger(held.backend.usage.fuse?.turns) && held.backend.usage.fuse.windowMs > 0, true, 'the window that tripped (D4)');
  assert.match(held.view.checkIns.line, /paused check-ins: more than \d+ came in /);
  g.say('back now');
  assert.equal(b.bridge.status().companion.autoPaused, false, 'ended when the message came in');
  await waitFor(() => { const last = pushes.at(-1); return last && !Object.hasOwn(last.backend.usage, 'autoPaused') ? last : null; }, 3000, 'a push without it');
  assert.equal(Object.hasOwn((await b.api.status()).backend.usage, 'autoPaused'), false);
  assert.equal(Object.hasOwn((await b.api.usage({ days: 1 })).today, 'autoPaused'), false);
});

test('the typed guard reaches the window (SY-18): the 21st typed message in a minute pushes a status with sendingPaused at once, and Resume sending pushes one without it', async (t) => {
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Noted.\n\nTL;DR: noted.') });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  const g = inGame(b.bridge);
  const answered = () => b.bridge.buildSlot().records.filter(r => r.t === 'reply' || r.t === 'error').length;
  for (let i = 0; i < 20; i++) g.say(`quick ${i}`);
  await waitFor(() => answered() >= 20, 15000, 'twenty answered');
  await new Promise(r => setTimeout(r, 400)); // their own pushes are through
  const pushes = [];
  b.api.onChange(st => pushes.push(st));
  g.say('the 21st');
  assert.equal(b.bridge.status().sending?.paused, true, 'the bridge paused sending');
  await waitFor(() => pushes.some(p => p.backend?.sendingPaused), 3000, 'a status push that says so (onSendPause)');
  const sp = (await b.api.status()).backend.sendingPaused;
  assert.deepEqual([sp.turns, sp.windowMs], [20, 60_000]);
  assert.equal((await b.api.resumeSending()).ok, true);
  await waitFor(() => { const last = pushes.at(-1); return last && !last.backend?.sendingPaused ? last : null; }, 3000, 'a push without it');
});

test('a write the disk refuses reaches the window at once (code health BR-11): boot hands the core onHealthChange, so a status push says chats can\'t be saved, and one without it follows the write made again', async (t) => {
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'] });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  await new Promise(r => setTimeout(r, 400)); // the start's own pushes are through
  const pushes = [];
  b.api.onChange(st => pushes.push(st));
  // Every write into the core's state folder fails with ENOSPC while `full`, as bridge_v2's BR-11 test has it.
  const dir = b.bridge.store.dir;
  const real = { writeFileSync: fs.writeFileSync, openSync: fs.openSync };
  let full = true;
  const inState = p => String(p).startsWith(dir);
  const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  fs.writeFileSync = function (p, ...a) { if (full && inState(p)) throw enospc(); return real.writeFileSync.call(this, p, ...a); };
  fs.openSync = function (p, flags, ...a) { if (full && inState(p) && /w|a/.test(String(flags))) throw enospc(); return real.openSync.call(this, p, flags, ...a); };
  try {
    // A write only the store makes: nothing else (a reply, a state change) pushes a status here.
    b.bridge.store.saveRecords();
    const said = await waitFor(() => pushes.find(p => p.store?.writeError), 3000, 'a status push that says so (onHealthChange)');
    assert.deepEqual(said.store.writeError, { file: 'records.json', code: 'ENOSPC', at: said.store.writeError.at, diskFull: true });
    assert.deepEqual([said.view.saving.headline, said.view.needsPlayer], ['Your disk is full, so chats aren’t saved.', true]);
    full = false;
    assert.equal(b.bridge.retryWrites(), true, 'made again once there\'s room');
    await waitFor(() => { const last = pushes.at(-1); return last && !last.store ? last : null; }, 3000, 'a push without it');
    assert.equal((await b.api.status()).view.saving, null);
  } finally {
    Object.assign(fs, real);
  }
});

test('reload mode reads the newest NeverQuestAlone.lua across WoW accounts (SY-18): boot hands the bridge the WTF folder, not one account\'s file', async (t) => {
  const w = wowFolder();
  const sv = acct => path.join(w.flavorDir, 'WTF', 'Account', acct, 'SavedVariables', 'NeverQuestAlone.lua');
  for (const a of ['FIRST', 'SECOND']) fs.mkdirSync(path.dirname(sv(a)), { recursive: true });
  // The game runs (reload mode's files are its /reloads'): while it does, the bridge polls every 2 s
  // (SY-30; with it closed, every 30 s).
  const { b, lines } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], wow: { run: RUNNING, roots: [] } });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  // SECOND played last: its file is newer. The bridge polls every 2 s and says when the account changes.
  fs.writeFileSync(sv('FIRST'), 'NQADB = {}\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(sv('FIRST'), old, old);
  await new Promise(r => setTimeout(r, 2300));
  fs.writeFileSync(sv('SECOND'), 'NQADB = {}\n');
  await waitFor(() => lines.some(l => l.startsWith('savedvariables-account ')), 6000, 'the newer account\'s file read');
  assert.ok(!lines.some(l => l.includes('SECOND') || l.includes('FIRST')), 'no account name in the log');
});

test('a config.json that can\'t be read (SY-12): the app starts on the defaults, the file is kept aside, and the window says so once', async (t) => {
  const root = tmpDir('bones-boot-cfg-');
  const configFile = path.join(root, 'config.json');
  fs.writeFileSync(configFile, '{"byok": {"provider": ');
  const { b, lines } = await boot(t, { rawConfig: null, configFile });
  const st = await b.api.status();
  assert.deepEqual(st.settings, { reset: true });
  assert.deepEqual(st.view.settingsReset, { headline: 'Your settings couldn’t be read and were reset.', detail: 'Your keys are kept. Check your AI and spend limit.' });
  const kept = fs.readdirSync(root).filter(n => n.startsWith('config.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(root, kept[0]), 'utf8'), '{"byok": {"provider": ');
  assert.ok(lines.some(l => l.startsWith('byok-config-reset ')));
  // A good file: nothing said.
  const good = path.join(tmpDir('bones-boot-cfg-'), 'config.json');
  fs.writeFileSync(good, '{}');
  const { b: b2 } = await boot(t, { rawConfig: null, configFile: good });
  const st2 = await b2.api.status();
  assert.equal(st2.settings, undefined);
  assert.equal(st2.view.settingsReset, null);
});

test('one bridge per AddOns folder: another live NeverQuestAlone refuses the start with a plain message', async (t) => {
  const w = wowFolder();
  const lockDir = tmpDir('bones-locks-');
  // Another live process of this account on this computer (our parent) holds the folder's lock.
  const lock = path.join(w.addonsDir, 'NeverQuestAlone', 'sig', 'bridge.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const holder = { pid: process.ppid, host: os.hostname(), ...(process.getuid ? { uid: process.getuid() } : {}), at: new Date().toISOString(), by: 'nqa', hb: 30 };
  fs.writeFileSync(lock, JSON.stringify(holder));
  await assert.rejects(boot(t, { flavorDir: w.flavorDir, lockDir }), e => e.code === 'BRIDGE_RUNNING' && /Another copy of NeverQuestAlone is already serving this World of Warcraft folder \(pid \d+\)\. Only one copy can at a time: quit that one first\./.test(e.message));
  assert.equal(socketHooks(), false, 'a refused start leaves nothing installed');
  assert.equal(fs.existsSync(lockFileFor(lockDir, w.addonsDir)), false, 'and takes no lock of its own');
  // A lock from a crashed run (a pid that's gone) is taken over.
  fs.writeFileSync(lock, JSON.stringify({ ...holder, pid: 2 ** 22 + 12345 }));
  assert.equal(pidAlive(2 ** 22 + 12345), false);
  const ok = await boot(t, { flavorDir: w.flavorDir, lockDir });
  assert.ok(ok.b.bridge);
  await ok.b.stop();
  // Code health BR-27: the folder's lock is the one rule. A state folder's lock (an older build kept
  // one beside the folder's) refuses nothing while the folder's can be taken.
  fs.writeFileSync(lockFileFor(lockDir, w.addonsDir), JSON.stringify({ pid: process.ppid, addonsDir: w.addonsDir, at: new Date().toISOString(), hb: 30 }));
  const again = await boot(t, { flavorDir: w.flavorDir, lockDir });
  assert.ok(again.b.bridge);
  await again.b.stop();
});

test('a config that names no WoW folder never takes a default one (there is none): findWow decides (C3 review)', async (t) => {
  // The retired default: a real folder on its author's Mac, which an older build saved into configs.
  const RETIRED = '/Applications/World of Warcraft/_classic_beta_';
  assert.equal(DEFAULTS.wow.flavorDir, null, 'no default folder');
  assert.equal(givenFlavorDir(DEFAULTS.wow.flavorDir), null);
  assert.equal(givenFlavorDir(RETIRED), null);
  assert.equal(givenFlavorDir(''), null);
  assert.equal(givenFlavorDir('/games/wow/_forever_'), '/games/wow/_forever_');
  // A fresh app's config (none on disk), a config with no wow section, one naming the default (none)
  // outright, one an older build saved with the retired default, and loadConfig's (the defaults
  // merged in): findWow is asked, and with nothing found the backend runs alone.
  for (const config of [null, {}, { wow: { flavorDir: DEFAULTS.wow.flavorDir } }, { wow: { flavorDir: RETIRED } }, configWithDefaults({})]) {
    const asked = [];
    const find = (o) => { asked.push(o); return []; };
    const { b, lines } = await boot(t, { rawConfig: config, wow: { run: NOT_RUNNING, roots: [], find } });
    assert.equal(b.bridge, null, JSON.stringify(config));
    assert.equal(b.config.wow.flavorDir, null);
    assert.ok(asked.length >= 1, 'findWow was asked');
    const st = await b.api.status();
    assert.equal(st.bridge.error, 'wow_not_found');
    assert.equal(st.wow.found, false);
    assert.ok(lines.some(l => l.startsWith('byok-no-bridge {"reason":"wow_not_found"}')));
    await b.stop();
  }
  // What findWow finds is used (and a folder the config names skips it).
  const w = wowFolder();
  const found = await boot(t, { rawConfig: { transport: { slots: 3 }, byok: { provider: 'anthropic' } }, keys: ['anthropic'], wow: { run: NOT_RUNNING, roots: [], find: () => [{ flavorDir: w.flavorDir, flavor: '_forever_', root: w.root }] } });
  assert.ok(found.b.bridge);
  assert.equal(found.b.config.wow.flavorDir, w.flavorDir);
  await found.b.stop();
  const named = await boot(t, { flavorDir: w.flavorDir, wow: { run: NOT_RUNNING, roots: [], find: () => { throw new Error('not asked'); } } });
  assert.ok(named.b.bridge);
  await named.b.stop();
});

test('a WoW folder the config names that is gone is no folder: nothing is searched (final review L4-1)', async (t) => {
  // The incident: a sandbox's config named a folder that didn't exist, boot searched, and findWow
  // handed back the live game in /Applications. A spy stands in for findWow, so nothing real is
  // searched even by the code this test guards against.
  const asked = [];
  const find = (o) => { asked.push(o); return []; };
  const { b, lines } = await boot(t, { flavorDir: path.join(tmpDir('bones-gone-'), 'no-such-wow', '_forever_'), wow: { run: NOT_RUNNING, find } });
  assert.deepEqual(asked, [], 'findWow was not asked');
  assert.equal(b.bridge, null);
  assert.equal((await b.api.status()).bridge.error, 'wow_not_found');
  assert.ok(lines.some(l => l.startsWith('byok-no-bridge {"reason":"wow_not_found"}')));
});

test('from a HOME that isn\'t the account\'s own, findWow searches only the roots inside it (final review L3-1)', async (t) => {
  // /Applications and Program Files don't move with HOME, and neither do the running bridges'
  // locks: a sandbox (a temp HOME, as every test here has) must never find the live game there.
  const asked = [];
  const find = (o) => { asked.push(o); return []; };
  const { b, home, lines } = await boot(t, { rawConfig: null, wow: { run: NOT_RUNNING, find } });
  assert.equal(asked.length, 1);
  const { roots } = asked[0];
  assert.ok(Array.isArray(roots), `the roots are named, not left to findWow's system-wide defaults: ${JSON.stringify(roots)}`);
  for (const r of roots) assert.ok(!path.relative(home, r).startsWith('..') && !path.isAbsolute(path.relative(home, r)), `${r} is inside the sandbox's HOME`);
  if (process.platform === 'darwin') assert.deepEqual(roots, [path.join(home, 'Applications', 'World of Warcraft')]);
  assert.equal(b.bridge, null);
  assert.ok(lines.some(l => l.startsWith('byok-wow-search {"scope":"home"')));
  // The account's own HOME searches everywhere (the app, for a player).
  const own = [];
  const mine = await boot(t, { rawConfig: null, realHome: null, wow: { run: NOT_RUNNING, find: (o) => { own.push(o); return []; } } });
  assert.ok(Array.isArray(own[0].roots), 'an unknown account home counts as a sandbox too');
  await mine.b.stop();
  const same = [];
  const real = await boot(t, { rawConfig: null, wow: { run: NOT_RUNNING, find: (o) => { same.push(o); return []; } } });
  await real.b.stop();
  const same2 = [];
  const acct = await boot(t, { rawConfig: null, realHome: real.home, home: real.home, wow: { run: NOT_RUNNING, find: (o) => { same2.push(o); return []; } } });
  assert.equal(same2[0].roots, null, 'HOME is the account\'s own: findWow\'s own roots');
  await acct.b.stop();
});

test('one bridge per AddOns folder whatever HOME it runs under: the lock inside the folder refuses a second one (final review L3-1, L4-1)', async (t) => {
  // Two bridges with different HOMEs and lock folders: before this, neither
  // saw the other's lock and both published into the same slots.
  const w = wowFolder();
  const first = await boot(t, { flavorDir: w.flavorDir });
  assert.ok(first.b.bridge);
  const lock = path.join(w.addonsDir, 'NeverQuestAlone', 'sig', 'bridge.lock');
  const held = JSON.parse(fs.readFileSync(lock, 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.equal(held.by, 'nqa');
  if (process.platform !== 'win32') assert.equal(fs.statSync(lock).mode & 0o777, 0o644, 'every account can read it');
  // Another process (our parent stands in for another account's bridge) holds it: refused.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, uid: 4242, host: held.host, at: new Date().toISOString(), by: 'nqa' }));
  // Windows has no uid (process.getuid is undefined), so a lock there can't tell accounts apart.
  const account = process.platform === 'win32' ? '' : ', under another account on this computer';
  await assert.rejects(boot(t, { flavorDir: w.flavorDir }), e => e.code === 'BRIDGE_RUNNING' && new RegExp(`Another copy of NeverQuestAlone is already serving this World of Warcraft folder \\(pid \\d+${account}\\)`).test(e.message));
  fs.writeFileSync(lock, JSON.stringify(held));
  await first.b.stop();
  assert.equal(fs.existsSync(lock), false, 'stop releases it');
  // A second bridge on the same folder from another HOME, while the first runs: refused.
  const again = await boot(t, { flavorDir: w.flavorDir });
  assert.ok(again.b.bridge);
  const pidOnly = JSON.parse(fs.readFileSync(lock, 'utf8'));
  fs.writeFileSync(lock, JSON.stringify({ ...pidOnly, pid: process.ppid }));
  await assert.rejects(boot(t, { flavorDir: w.flavorDir }), e => e.code === 'BRIDGE_RUNNING');
  fs.writeFileSync(lock, JSON.stringify(pidOnly));
});

test('outside the app (a stock node) boot takes only a key store its caller passes: there is no headless bridge; the app makes the OS store', async (t) => {
  const made = [];
  const keystoreFactory = (o) => { made.push([o.backend, o.service ?? null]); return createKeyStore({ backend: 'memory' }); };
  await assert.rejects(boot(t, { keystore: undefined, keystoreFactory, platform: 'darwin', electron: false }), e => e.code === 'NOT_THE_APP');
  assert.deepEqual(made, [], 'no key store was made at all');
  // The app (Electron, its own signed identity) keeps the Keychain, under one service name only.
  const app = await boot(t, { keystore: undefined, keystoreFactory, platform: 'darwin', electron: true });
  assert.deepEqual(made, [['os', IDENTITY.keychainService]], 'the identity\'s service, and no old-name store beside it');
  await app.b.stop();
});

test('Windows: the WoW folder the addon went into is listed for the uninstaller, at start and whenever the settings are saved (audit CV-07)', async (t) => {
  const { flavorDir } = wowFolder();
  const { b, opts } = await boot(t, { flavorDir, platform: 'win32' });
  const file = path.join(opts.paths.userData, UNINSTALL_RECORD);
  assert.deepEqual(readUninstallRecord(file), [flavorDir], 'at start: installs made before the list existed');
  // A save with another folder (installAddon saves the folder it installed into) puts that one first.
  const other = wowFolder().flavorDir;
  b.config.wow.flavorDir = other;
  assert.equal((await b.api.setPrivacy({ echo: true })).ok, true, 'any save of the settings');
  assert.deepEqual(readUninstallRecord(file), [other, flavorDir]);
  // The in-app uninstall removes it with the rest of the app's data: an addon the player chose to
  // keep there is then never removed by the NSIS uninstaller either.
  assert.equal((await b.api.uninstall({ removeAddon: false })).ok, true);
  assert.equal(fs.existsSync(file), false);
  await b.stop();
  assert.equal(fs.existsSync(file), false, 'nothing makes it again at quit');
  // Not on macOS or Linux: they have no uninstaller that reads it.
  const mac = await boot(t, { flavorDir, platform: 'darwin' });
  assert.equal(fs.existsSync(path.join(mac.opts.paths.userData, UNINSTALL_RECORD)), false);
  await mac.b.stop();
});

test('Windows without Credential Manager (or its binding, which Smart App Control can block): this session\'s memory, and the window is told', async (t) => {
  const made = [];
  const unusable = { ...createKeyStore({ backend: 'memory' }), backend: 'os', probe: async () => ({ ok: false, code: 'keystore_unavailable' }) };
  const keystoreFactory = (o) => { made.push(o.backend); return o.backend === 'os' ? unusable : createKeyStore({ backend: 'memory' }); };
  const { b, lines } = await boot(t, { keystore: undefined, keystoreFactory, platform: 'win32', electron: true });
  assert.deepEqual(made, ['os', 'memory']);
  assert.equal(b.keystore.backend, 'memory');
  assert.equal(b.keystore.persistent, false);
  assert.ok(lines.some(l => l.startsWith('byok-keystore {"backend":"memory","reason":"keystore_unavailable"}')));
  assert.equal((await b.api.status()).keys?.persistent, false, 'status says keys last until the app quits');
  await b.stop();
  // A macOS Keychain that answers is never swapped for memory.
  made.length = 0;
  const mac = await boot(t, { keystore: undefined, keystoreFactory: (o) => { made.push(o.backend); return { ...createKeyStore({ backend: 'memory' }), backend: o.backend, persistent: true }; }, platform: 'darwin', electron: true });
  assert.deepEqual(made, ['os']);
  await mac.b.stop();
});
test('egress: the chosen provider\'s hosts and loopback; a key test widens it only meanwhile; Other adds exactly its one host; other hosts are refused before connecting and listed', async (t) => {
  // Other's service answers through a fake fetch under the guard (no real network).
  const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
  const seen = [];
  const fetch = async (url, init) => { seen.push(`${init?.method ?? 'GET'} ${url} ${init?.headers?.authorization ? 'key' : 'nokey'}`); return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }); };
  const { b } = await boot(t, { keys: ['anthropic'], fetch });
  assert.equal(b.egress.allowed('api.anthropic.com'), true);
  assert.equal(b.egress.allowed('openrouter.ai'), false);
  assert.equal(b.egress.allowed('127.0.0.1'), true, 'a server on this computer');
  assert.equal(b.egress.allowed('evil.example'), false);
  const release = b.egress.widen(['generativelanguage.googleapis.com'], 'key_test');
  assert.equal(b.egress.allowed('generativelanguage.googleapis.com'), true);
  release();
  assert.equal(b.egress.allowed('generativelanguage.googleapis.com'), false);
  // Other: its one test request goes to its host alone, allowed for that request; once connected the
  // allowlist is that one host (and loopback), nothing else: not its subdomains, not another service.
  const r = await b.api.connectCustom({ baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', key: CANARY_KEYS.openrouter });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(seen, ['POST https://openrouter.ai/api/v1/chat/completions key']);
  assert.equal(b.egress.allowed('openrouter.ai'), true, 'the allowlist follows the choice');
  assert.equal(b.egress.allowed('api.openrouter.ai'), false);
  assert.equal(b.egress.allowed('api.anthropic.com'), false);
  assert.equal(b.egress.allowed('evil.example'), false);
  assert.deepEqual(b.config.byok.custom, { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' });
  assert.deepEqual(await b.api.choose({ provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }), { ok: true });
  assert.equal(b.egress.allowed('openrouter.ai'), false, 'another AI chosen: Other\'s host goes');
  assert.equal(b.api.setExtraHost, undefined, 'no "allow a host" (systems plan D6)');
  // A host off the list: refused before fetch is called, so nothing reaches it, not even a lookup.
  await assert.rejects(b.egress.fetch('https://192.0.2.1:9/x'), e => e.cause?.code === 'EGRESS_BLOCKED');
  const c = await b.api.connections();
  assert.ok(c.blocked.some(r2 => r2.host === '192.0.2.1' && r2.port === 9), JSON.stringify(c));
  assert.equal(c.selfTest, undefined, 'no startup HEAD request');
});

test('a saved OpenRouter, Ollama or LM Studio choice loads as Other with its address; an OpenRouter key moves to Other\'s entry; a never-chosen OpenRouter default starts on Claude', async (t) => {
  const or = await boot(t, { keys: ['openrouter'], config: { byok: { provider: 'openrouter', model: 'meta-llama/llama-4-scout:free', auth: 'oauth', authBy: { openrouter: 'oauth' }, terms: { openrouter: { v: 1 } } } } });
  assert.equal(or.b.config.byok.provider, 'custom');
  assert.deepEqual(or.b.config.byok.custom, { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-4-scout:free' });
  assert.equal(or.b.config.byok.auth, 'key');
  assert.deepEqual(or.b.config.byok.authBy, {});
  assert.equal(await or.keystore.get('custom'), CANARY_KEYS.openrouter, 'the key moved');
  assert.equal(await or.keystore.get('openrouter'), null);
  assert.equal(or.b.egress.allowed('openrouter.ai'), true, 'its one host');
  const st = await or.b.api.status();
  assert.equal(st.backend.provider.id, 'custom');
  assert.equal(st.backend.provider.name, 'openrouter.ai');
  assert.ok(or.lines.some(l => l.startsWith('byok-provider-migrated {"from":"openrouter","to":"custom"}')));
  const ol = await boot(t, { config: { byok: { provider: 'ollama', model: 'qwen3:4b' } } });
  assert.deepEqual([ol.b.config.byok.provider, ol.b.config.byok.custom], ['custom', { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:4b' }]);
  assert.equal((await ol.b.api.status()).backend.provider.auth, 'local');
  const lm = await boot(t, { config: { byok: { provider: 'lmstudio', model: 'qwen/qwen3-8b' } } });
  assert.deepEqual(lm.b.config.byok.custom, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-8b' });
  const def = await boot(t, { config: { byok: { provider: 'openrouter', model: null } } });
  assert.equal(def.b.config.byok.provider, 'anthropic', 'OpenRouter was the no-key default: with no key, never Other');
  assert.equal(def.b.config.byok.custom, undefined);
});

test('a key test goes through the guarded fetch and shows in Connections (§8.4 item 1)', async (t) => {
  const { b, mock } = await boot(t, { keys: ['anthropic'], handler: (r) => (r.method === 'GET' ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }, { id: 'claude-sonnet-5' }] }) } : reply('ok', { input: 5, output: 1 })) });
  const tk = await b.api.testKey('anthropic');
  assert.equal(tk.ok, true, JSON.stringify(tk));
  const c = await b.api.connections();
  assert.ok(c.rows.some(r => r.port === mock.port && r.count >= 2), JSON.stringify(c.rows));
  assert.equal(posts(mock).length, 1, 'the one tiny test request, nothing at startup');
});
// fix-102 (2026-09-30, the owner's app, live): the app kept its window after its boot stopped (a quit
// that didn't finish), and every key test was refused by the stopped guard before it was sent:
// "egress-blocked {host: api.anthropic.com, port: 443, feature: provider}", then setup's "Can't reach
// Anthropic. Check your internet". The boot's stop is the same here; what a stopped boot says isn't.
test('fix-102: after stop, setup\'s test and Test key say the app needs a restart (never the internet), nothing is sent, the log says the guard stopped, and status is not_running app_stopped', async (t) => {
  const handler = r => (r.method === 'GET' ? json({ data: [{ id: 'claude-haiku-4-5' }] }) : reply('ok', { input: 5, output: 1 }));
  const { b, mock, lines } = await boot(t, { keys: ['anthropic'], handler });
  assert.equal((await b.api.recordTerms('anthropic', 1)).ok, true);
  const before = await b.api.testStagedKey('anthropic', async () => CANARY_KEYS.anthropic, { context: 'setup' });
  assert.equal(before.ok, true, `a running boot reaches the AI: ${JSON.stringify(before)}`);
  assert.equal((await b.api.testKey('anthropic')).ok, true);
  assert.equal((await b.api.status()).backend.rt.state, 'ready');
  const sent = mock.requests.length;
  await b.stop();
  // Setup's test of a pasted key: its own result, restart.
  const staged = await b.api.testStagedKey('anthropic', async () => CANARY_KEYS.anthropic, { context: 'setup' });
  assert.deepEqual([staged.ok, staged.error, staged.kind], [false, 'restart', 'egress_blocked']);
  // Setup's retest of the saved key (Use saved key) is setup's result too.
  const reuse = await b.api.useSavedKey('anthropic');
  assert.deepEqual([reuse.ok, reuse.error], [false, 'restart']);
  // Your AI's Test key: the window's words and its Quit and reopen.
  const saved = await b.api.testKey('anthropic');
  assert.deepEqual([saved.ok, saved.error, saved.action], [false, 'egress_blocked', 'restart']);
  assert.equal(saved.headline, 'NeverQuestAlone needs a restart.');
  assert.equal(saved.detail, 'Click Quit and reopen.');
  assert.doesNotMatch(JSON.stringify([staged, reuse, saved]), /internet|Can.t reach|Connections/i);
  assert.equal(mock.requests.length, sent, 'nothing was sent after the stop');
  const blocked = lines.filter(l => l.startsWith('egress-blocked'));
  assert.ok(blocked.length >= 3 && blocked.every(l => l.includes('"stopped":true')), `the log says the guard had stopped: ${blocked.join(' | ')}`);
  // Every card: the status says the app needs a restart (the window's not-running card, Quit and reopen).
  const st = await b.api.status();
  assert.deepEqual(st.backend.rt, { state: 'not_running', reason: 'app_stopped' });
  assert.deepEqual([st.bridge.running, st.bridge.error], [false, 'stopped']);
  assert.deepEqual([st.view.key, st.view.words, st.view.needsPlayer], ['not_running', 'Needs a restart', true]);
});

test('keys: every one read or written is registered with the log\'s redactor first; a turn leaves no key in the log or on disk', async (t) => {
  const w = wowFolder();
  const { b, root, lines, secrets } = await boot(t, { flavorDir: w.flavorDir, handler: () => reply('Mulgore.', { input: 100, output: 5 }) });
  assert.deepEqual(await b.api.setKey('anthropic', CANARY_KEYS.anthropic), { ok: true, masked: 'sk-ant-…xxxx' });
  assert.ok(secrets.has(CANARY_KEYS.anthropic));
  secrets.clear();
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  await b.backend.send(sendParams('c3f9a1e', 'k1', 'where am I?'));
  await waitFor(async () => (await b.api.usage({ days: 1 })).replies.length === 1, 5000, 'reply');
  assert.ok(secrets.has(CANARY_KEYS.anthropic), 'the provider\'s read registered it again before the call');
  assert.ok(!lines.join('\n').includes('CANARY'));
  assert.ok(!(await b.api.diagnostics()).text.includes('CANARY'));
  await b.stop();
  assert.deepEqual(scanDirForCanaries(root), []);
  assert.deepEqual(scanDirForCanaries(w.addonsDir), []);
});

// Code health BR-21: a bridge line was redacted three times on its way to the app's shell.log (four
// passes of the redactor), and JSON-encoded twice.
test('the log (code health BR-21): each line is redacted once, by the host\'s redactor, and a host that takes a redacted line (log.line, the app\'s) gets it as the diagnostics keep it, never (event, data) to redact again; no key reaches either', async (t) => {
  const w = wowFolder();
  const secrets = new Set();
  const scrubbed = []; // [what came in, what went out]
  const got = [];
  const log = () => { throw new Error('a host with log.line is never handed (event, data)'); };
  log.addSecret = s => secrets.add(s);
  log.scrub = (s) => { const out = redact(String(s), secrets); scrubbed.push([String(s), out]); return out; };
  log.line = l => got.push([l, scrubbed.at(-1)]);
  const { b } = await boot(t, { flavorDir: w.flavorDir, handler: () => reply('Mulgore.', { input: 100, output: 5 }), log });
  assert.deepEqual(await b.api.setKey('anthropic', CANARY_KEYS.anthropic), { ok: true, masked: 'sk-ant-…xxxx' });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  await b.backend.send(sendParams('c3f9a1e', 'k1', 'where am I?'));
  await waitFor(async () => (await b.api.usage({ days: 1 })).replies.length === 1, 5000, 'reply');
  assert.ok(got.length >= 5, `${got.length} lines`);
  for (const [line, [raw, out]] of got) {
    assert.equal(line, out, 'the line exactly as the redactor gave it');
    assert.match(raw, /^[a-z][a-z0-9_.-]*(?: |$)/, `redacted from the raw line (no time, no earlier pass): ${raw.slice(0, 60)}`);
  }
  assert.ok(!got.map(g => g[0]).join('\n').includes('CANARY'), 'no key in the host\'s lines');
  const diag = (await b.api.diagnostics()).text;
  assert.ok(!diag.includes('CANARY'));
  const ring = diag.slice(diag.indexOf('== Last log lines ==')).split('\n').slice(1).map(l => l.replace(/^\S+ /, ''));
  for (const [line] of got.slice(-20)) assert.ok(ring.includes(line), `the ring keeps the line the host got: ${line.slice(0, 80)}`);
});

test('code health (privacy): the diagnostics bundle carries no reply\'s words, the first reply\'s that setup quotes included (only their length), and no message', async (t) => {
  const w = wowFolder();
  const REPLY = 'Turn in The Hunt Begins to Baine Bloodhoof first, then take the kodo quest before you leave.';
  const { b } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply(`${REPLY}\n\nTL;DR: Baine Bloodhoof first.`, { input: 100, output: 5 }) });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  inGame(b.bridge).say('which kodo quest comes first?');
  const words = await waitFor(async () => (await b.api.status()).setup.firstWords, 8000, 'the first reply\'s words, for setup\'s last screen');
  assert.ok(words.length > 10, words);
  const diag = (await b.api.diagnostics()).text;
  const status = JSON.parse(/\nstatus: (.*)\n/.exec(diag)[1]);
  assert.equal(Object.hasOwn(status.setup, 'firstWords'), false, 'the words stay out');
  assert.equal(status.setup.firstWordsLength, words.length, 'their length is kept');
  for (const bit of [words, words.slice(0, 24), 'Hunt Begins', 'Bloodhoof', 'which kodo quest']) assert.ok(!diag.includes(bit), `the bundle quotes no reply or message: ${bit}`);
  assert.equal((await b.api.status()).setup.firstWords, words, 'the window still has them');
});

test('"Delete all transcripts" in the app takes the core\'s ring of published replies too (final review L5-1)', async (t) => {
  const w = wowFolder();
  const { b, root } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Thunder Bluff is north.\n\nTL;DR: north.', { input: 100, output: 5 }) });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  const game = inGame(b.bridge);
  game.say('where is the capital?');
  const ring = path.join(root, 'ud', 'bridge', 'records.json');
  await waitFor(() => fs.existsSync(ring) && fs.readFileSync(ring, 'utf8').includes('Thunder Bluff is north.'), 5000, 'the reply in the ring');
  const r = await b.api.transcripts({ deleteAll: true });
  assert.equal(r.ok, true);
  assert.ok(!fs.readFileSync(ring, 'utf8').includes('Thunder Bluff'), 'records.json holds no reply');
});

/** A stand-in capture helper: boot's options kept, the supervisor's restart() and retryNow() recorded. */
function fakeHelper(made, kind = 'mac-app') {
  return (o) => {
    const cap = { o, kind, started: 0, stopped: 0, restarts: [], retries: 0,
      start() { cap.started += 1; }, stop() { cap.stopped += 1; },
      restart(reason) { cap.restarts.push(reason); return true; }, retryNow() { cap.retries += 1; return true; },
      status: () => ({ kind, connected: false }) };
    made.push(cap);
    return cap;
  };
}
/** The helper's side of a session, as capture.mjs hands it on: connected, the game, the window, a stats line. */
function helperUp(cap, { pid = 4242, frames = 40, decoded = 0 } = {}) {
  cap.o.onStatus({ connected: true });
  cap.o.onGame({ state: 'running', pid });
  cap.o.onStatus({ permission: true });
  cap.o.onStatus({ window: { pid, scale: 2, widthPt: 1728, heightPt: 1117 } });
  cap.o.onStatus({ stats: { interval: { frames, decoded, rejected: 0 }, frames: frames * 3, decoded, attached: true, hidden: false, asleep: false, locked: false, onScreen: true } });
}

test('capture: started with the bridge (payloads, game lines, the helper\'s status and typed errors wired to the watchdog, its restart() to the supervisor), never without it, stopped by stop()', async (t) => {
  const made = [];
  const createCapture = fakeHelper(made);
  const none = await boot(t, { capture: true, createCapture });
  assert.equal(made.length, 0, 'no WoW, no capture');
  await none.b.stop();
  const w = wowFolder();
  const { b, root } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture, captureThresholds: { typedWaitMs: 0 } });
  assert.equal(made.length, 1);
  const cap = made[0];
  assert.equal(cap.started, 1);
  assert.equal(cap.o.mac.socketPath, path.join(root, 'ud', 'bridge', 'capture.sock'), 'under the app\'s own state folder');
  assert.equal(cap.o.statsSec, 10);
  const got = [];
  const handle = b.bridge.handlePayload;
  b.bridge.handlePayload = (text, via) => got.push([text, via]);
  cap.o.onPayload({ text: 'payload', id: 1 });
  assert.deepEqual(got, [['payload', 'strip']]);
  b.bridge.handlePayload = handle;
  // The slot's capture state is the watchdog's (cap capture): ok, since when; no cause.
  let slot = b.bridge.buildSlot().bridge;
  assert.ok(slot.caps.includes('capture'));
  assert.deepEqual(Object.keys(slot.capture), ['state', 'since']);
  assert.equal(slot.capture.state, 'ok');
  assert.equal(slot.backend, 'byok');
  // A typed error goes through the core to the watchdog: a missing helper is damaged (at once here).
  cap.o.onError({ kind: 'helper_missing', message: 'x' });
  b.bridge.captureHealth.tick();
  slot = b.bridge.buildSlot().bridge;
  assert.deepEqual([slot.capture.state, slot.capture.cause], ['damaged', 'helper_missing']);
  assert.equal((await b.api.status()).capture.state, 'damaged', 'the window reads the same state');
  // A helper that starts clears it; the status pushes go through the core too.
  helperUp(cap);
  assert.equal(b.bridge.buildSlot().bridge.capture.state, 'ok');
  assert.equal(b.bridge.status().capture.lastStats.interval.frames, 40);
  assert.deepEqual(b.bridge.status().capture.window, { pid: 4242, scale: 2, widthPt: 1728, heightPt: 1117 });
  // The legacy publisher is gone (SY-20): no second mapping in boot, no check timer in the core.
  for (const gone of ['captureStateOf', 'CAPTURE_ERROR_FOR_MS']) assert.equal(bootModule[gone], undefined, gone);
  assert.equal(b.bridge.captureChanged, undefined);
  await b.stop();
  assert.equal(cap.stopped, 1);
});

// Screen Reading in the app (its Your data switch; the orchestrator's trust plan, 2026-10-03): the
// capture helper alone stops and starts, never the core, so a reply in flight still lands; the slot tells
// the addon (bridge.reading, cap reading), the watchdog says off, and setup has nothing to allow.
test('Screen Reading off in the app: the helper alone stops (same core, no restart), a reply in flight still lands, the slot and watchdog say off; on again, a new helper starts', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b, mock, root } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], capture: true, createCapture: fakeHelper(made), captureThresholds: { typedWaitMs: 0 },
    handler: () => reply('The Barrens.\n\nTL;DR: The Barrens.', { delayMs: 1200 }) });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  assert.equal(made.length, 1);
  helperUp(made[0]);
  assert.equal((await b.api.privacy()).screenReading, true, 'on by default');
  assert.equal(b.bridge.buildSlot().bridge.reading, 'on');
  const core = b.bridge;
  const replies = () => b.bridge.buildSlot().records.filter(r => r.t === 'reply').length;
  const game = inGame(b.bridge);
  game.say('where next?');
  await waitFor(() => posts(mock).length === 1, 8000, 'the turn is in flight');
  assert.equal(replies(), 0, 'its reply still streaming');
  // Off: the helper stops; the core, its run and its backend are the same ones.
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), screenReading: false }), { ok: true });
  assert.equal(replies(), 0, 'the turn is still in flight after the switch (SY-11)');
  assert.equal(made[0].stopped, 1, 'the helper stopped');
  assert.equal(b.capture, null);
  assert.equal(b.bridge, core, 'no restart: the same core');
  assert.equal(b.bridge.buildSlot().bridge.reading, 'off', 'the addon is told');
  assert.ok(b.bridge.buildSlot().bridge.caps.includes('reading'));
  b.bridge.captureHealth.tick();
  assert.equal(b.bridge.buildSlot().bridge.capture.state, 'off', 'the watchdog says off');
  const st = await b.api.status();
  assert.deepEqual([st.capture.state, st.capture.mode], ['off', 'reload'], 'the window: no screen reading');
  assert.equal(st.setup.captureState, 'off', 'setup: nothing to allow');
  await waitFor(() => replies() === 1, 8000, 'the reply in flight still lands');
  assert.equal(posts(mock).length, 1, 'once: never sent again (SY-11)');
  assert.equal(b.bridge.captureHealth.state(), 'off', 'so no re-rings (signals_test: the screen-reading switch)');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'ud', 'config.json'), 'utf8')).byok.privacy.screenReading, false, 'saved');
  // On again: a new helper starts (a Mac asks for Screen Recording only now, as it starts).
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), screenReading: true }), { ok: true });
  assert.equal(made.length, 2, 'a new helper');
  assert.equal(made[1].started, 1);
  assert.equal(b.bridge, core, 'still the same core');
  assert.equal(b.bridge.buildSlot().bridge.reading, 'on');
  // Flipping to what it already is starts or stops nothing.
  await b.api.setPrivacy({ ...(await b.api.privacy()), screenReading: true });
  assert.deepEqual([made.length, made[1].stopped], [2, 0]);
  await b.stop();
  assert.equal(made[1].stopped, 1);
});

// SY-03: on, then off again while the capture module is still loading (the first start of a session
// that began with screen reading off): no helper starts behind the "off".
test('Screen Reading on then off during the capture module\'s first load: no helper starts', async (t) => {
  const made = [];
  const w = wowFolder();
  const slow = async (p) => { await new Promise(res => setTimeout(res, 60)); return p.endsWith(path.join('transport', 'capture.mjs')) ? { createCaptureForPlatform: fakeHelper(made) } : import(p); };
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, importer: slow, config: { byok: { privacy: { screenReading: false } } } });
  assert.equal(made.length, 0, 'off at the start: no helper');
  const p = await b.api.privacy();
  const on = b.api.setPrivacy({ ...p, screenReading: true });
  await new Promise(res => setTimeout(res, 10));
  await b.api.setPrivacy({ ...p, screenReading: false });
  await on;
  await new Promise(res => setTimeout(res, 100));
  assert.equal(made.filter(c => c.started > c.stopped).length, 0, 'no helper left running');
  assert.equal(b.capture, null);
});

// SF-01 (the /safety critic, 2026-10-03): with Screen Reading off in the ADDON (its session says stream or
// reload), no capture helper runs either, so a Mac's Screen Recording indicator goes off with it. A
// pixel hello (by the reload that turned it back on, from SavedVariables) starts it again; the app's own
// switch off still wins; a kept stream mode starts nothing at a cold start.
test('the addon\'s Screen Reading off stops the helper too (SF-01): stream stops it, a pixel hello from SavedVariables starts it, the app\'s off wins, a kept stream mode starts nothing', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture: fakeHelper(made), captureThresholds: { typedWaitMs: 0 } });
  assert.equal(made.length, 1, 'a fresh install: on by default');
  const tick = () => new Promise(res => setImmediate(res));
  const hello = (nonce, mode) => encodeRecord({ token: '3fa9c2d1', key: nonce, type: 'hello', chat: '', args: { cur: 0, ver: '1.4.2', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: 3, sid: 'a1b2c3d4e5f60718', mode } });
  // The addon's switch off: its hello says stream (by the outbox, read at a reload).
  b.bridge.handlePayload(hello('b001', 'stream'), 'reload');
  await tick(); await tick();
  assert.equal(made[0].stopped, 1, 'stream: the helper stopped');
  assert.equal(b.capture, null);
  assert.equal((await b.api.status()).setup.captureState, 'off', 'setup: nothing to allow, no prompt');
  // Back on in game: the reload that said so brings a pixel hello from SavedVariables.
  b.bridge.handlePayload(hello('b002', 'pixel'), 'reload');
  await tick(); await tick();
  assert.equal(made.length, 2, 'pixel: a new helper');
  assert.equal(made[1].started, 1);
  // The app's switch off wins over a pixel hello.
  await b.api.setPrivacy({ ...(await b.api.privacy()), screenReading: false });
  assert.equal(made[1].stopped, 1);
  b.bridge.handlePayload(hello('b003', 'pixel'), 'reload');
  await tick(); await tick();
  assert.equal(made.length, 2, 'the app\'s off: no helper for a pixel hello');
  await b.api.setPrivacy({ ...(await b.api.privacy()), screenReading: true });
  assert.equal(made.length, 3, 'on again in the app, the addon on: a helper');
  // A kept stream mode at a cold start (the core again, from its saved tokens): no helper.
  b.bridge.handlePayload(hello('b004', 'stream'), 'reload');
  await tick(); await tick();
  assert.equal(made[2].stopped, 1);
  await b.restart();
  assert.equal(made.length, 3, 'a kept stream mode starts nothing');
  assert.equal(b.capture, null);
  // SY-12: off said mid-session (a mode seen, not a hello) is kept too: a restart starts nothing.
  b.bridge.handlePayload(hello('b005', 'pixel'), 'reload');
  await tick(); await tick();
  assert.equal(made.length, 4, 'pixel: a helper');
  b.bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'b005', type: 'seen', chat: '', args: { cur: 0, mode: 'stream' } }), 'strip');
  await tick(); await tick();
  assert.equal(made[3].stopped, 1, 'a mode seen stream: stopped');
  await b.restart();
  assert.equal(made.length, 4, 'kept after a restart: no helper');
  assert.equal((await b.api.status()).setup.captureState, 'off');
});

// H2 through boot (display SY-20): the old publisher guessed no_signal from the helper's cumulative
// decoded count, 0 after every launch, and put minimized in the slot: 2-4 rings per helper restart and
// 2 per minimize, outside any budget (critic-r4-legacy). The watchdog publishes neither.
test('H2 through boot (SY-20): a helper restart publishes and rings nothing (its first stats: frames, none decoded), and a typed window_minimized leaves the slot as it was', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture: fakeHelper(made, 'windows-helper'), captureThresholds: { typedWaitMs: 0, accessLostWaitMs: 0 } });
  const cap = made[0];
  helperUp(cap, { frames: 40, decoded: 3 });
  b.bridge.captureHealth.tick();
  const push = b.bridge.status().push;
  const before = b.bridge.buildSlot().bridge.capture;
  const logsBefore = b.bridge.status().capture.restarts;
  // The helper's socket closes; it's launched again 3 s later; its first stats line: frames, nothing decoded.
  cap.o.onStatus({ connected: false });
  b.bridge.captureHealth.tick();
  helperUp(cap, { frames: 40, decoded: 0 });
  b.bridge.captureHealth.tick();
  cap.o.onError({ kind: 'window_minimized', message: 'World of Warcraft is minimized; restore it to keep chatting' });
  for (let i = 0; i < 5; i++) b.bridge.captureHealth.tick();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(b.bridge.status().push, push, 'nothing rung');
  assert.deepEqual(b.bridge.buildSlot().bridge.capture, before, 'the slot as it was: ok');
  assert.equal(b.bridge.status().capture.restarts, logsBefore, 'nothing restarted');
  assert.equal(b.bridge.status().capture.held, 'minimized');
  assert.deepEqual(cap.restarts, []);
});

// DR-06 (SY-10): the window hears the watchdog through boot's wiring (onCaptureChange → the app's
// changed(), debounced), only when what it shows changes: a stats line every 10 s re-renders nothing.
test('DR-06 (SY-10): through boot, the window is pushed one status when the screen state changes, and nothing for stats lines', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture: fakeHelper(made, 'windows-helper'), captureThresholds: { typedWaitMs: 0 } });
  const cap = made[0];
  helperUp(cap, { frames: 40, decoded: 0 });
  b.bridge.captureHealth.tick();
  await new Promise(r => setTimeout(r, 200)); // past the push's 150 ms debounce
  let changes = 0;
  const changed = b.api.changed;
  b.api.changed = () => { changes += 1; changed(); };
  const pushes = [];
  b.api.onChange(st => pushes.push(st));
  const stats = { interval: { frames: 40, decoded: 0, rejected: 0 }, attached: true, hidden: false, asleep: false, locked: false, onScreen: true };
  for (let i = 0; i < 6; i++) { cap.o.onStatus({ stats }); b.bridge.captureHealth.tick(); }
  await new Promise(r => setTimeout(r, 200));
  assert.equal(changes, 0, 'a stats line tells the window nothing');
  assert.deepEqual(pushes, []);
  cap.o.onError({ kind: 'capture_blocked_by_app', message: 'x' });
  b.bridge.captureHealth.tick();
  for (let i = 0; i < 3; i++) { cap.o.onStatus({ stats }); b.bridge.captureHealth.tick(); }
  await waitFor(() => pushes.length === 1, 2000, 'one push');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(changes, 1, 'the state change, once');
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].capture.state, 'blocked');
  assert.deepEqual([pushes[0].view.screen.state, pushes[0].view.screen.ok], ['blocked', false]);
});

/** A SavedVariables write, as the game makes one at /reload: the outbox with these records, written now. */
function writeSavedVariables(flavorDir, wires, { token = '3fa9c2d1' } = {}) {
  const dir = path.join(flavorDir, 'WTF', 'Account', 'TESTACCOUNT', 'SavedVariables');
  fs.mkdirSync(dir, { recursive: true });
  const entries = wires.map((wire, i) => `\t\t{\n\t\t\t["key"] = "k${i}",\n\t\t\t["hex"] = "${Buffer.from(wire, 'utf8').toString('hex')}",\n\t\t},\n`).join('');
  fs.writeFileSync(path.join(dir, 'NeverQuestAlone.lua'), `NQADB = {\n\t["token"] = "${token}",\n\t["outbox"] = {\n${entries}\t},\n}\n`);
  return path.join(dir, 'NeverQuestAlone.lua');
}

// The probe's T3 (display audit): the 00:23Z incident's signature (connected, permission, frames, nothing
// decoded) read "ok" from "connected". Now nothing is judged until a message is waiting: the Reload that
// delivers it is the evidence (R4'), which restarts the helper through the supervisor and publishes
// no_signal, rung, in the slot and in the window alike; the new session's hello read off the strip is ok.
test('the incident through boot (T3, H1): connected with frames and nothing decoded names nothing; the Reload\'s first-time record restarts the helper once and publishes no_signal (blind), rung; the window says the same; the next hello off the strip is ok', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture: fakeHelper(made) });
  const cap = made[0];
  const rec = (type, key, args = {}, extra = {}) => encodeRecord({ token: '3fa9c2d1', key, type, chat: type === 'hello' ? '' : 'c3f9a1e', args: { cur: 0, ...args }, ...extra });
  // Session a3f1's hello was read off the strip; then capture went blind (frames, nothing decoded).
  helperUp(cap, { frames: 40, decoded: 0 });
  b.bridge.handlePayload(rec('hello', 'a3f1', { ver: '1.5.2', n: 0, ctx: 0, sig: 'ok', slot: 3, mode: 'pixel' }), 'strip');
  await new Promise(r => setTimeout(r, 30));
  for (let i = 0; i < 3; i++) cap.o.onStatus({ stats: { interval: { frames: 40, decoded: 0, rejected: 0 }, attached: true, hidden: false, asleep: false, locked: false, onScreen: true } });
  b.bridge.captureHealth.tick();
  assert.equal(b.bridge.buildSlot().bridge.capture.state, 'ok', 'nothing sent, nothing judged');
  assert.deepEqual(cap.restarts, []);
  const push = b.bridge.status().push;
  // A message sticks; the player clicks Reload: the game writes it to SavedVariables, a moment after the attach.
  await new Promise(r => setTimeout(r, 20));
  writeSavedVariables(w.flavorDir, [rec('msg', 'a3f1_1', { agent: 'main', name: 'Route', ctx: 0 }, { text: 'where now?' })]);
  b.bridge.pollSavedVariables();
  assert.deepEqual(cap.restarts, ['R4 blind'], 'the helper started over at once, through the supervisor');
  const slot = b.bridge.buildSlot().bridge.capture;
  assert.deepEqual([slot.state, slot.cause], ['no_signal', 'blind']);
  await waitFor(() => b.bridge.status().push > push, 2000, 'rung');
  const st = await b.api.status();
  assert.equal(st.capture.state, 'no_signal', 'the window reads the watchdog\'s state');
  assert.equal(st.view.screen.ok, false);
  assert.equal(b.bridge.status().capture.live, false, 'the write ended the episode');
  // The restarted helper reads the new session's hello: ok, rung.
  const push2 = b.bridge.status().push;
  b.bridge.handlePayload(rec('hello', 'b7c9', { ver: '1.5.2', n: 1, ctx: 0, sig: 'ok', slot: 3, mode: 'pixel' }), 'strip');
  assert.equal(b.bridge.buildSlot().bridge.capture.state, 'ok');
  await waitFor(() => b.bridge.status().push > push2, 2000, 'the ok rung');
  assert.deepEqual(cap.restarts, ['R4 blind']);
});

test('capture (display DR-05): the Windows helper gets the flavor folders, the game\'s own helpers to refuse, and the served WoW folder to prefer', async (t) => {
  const made = [];
  const createCapture = (o) => { made.push(o); return { start() {}, stop() {}, status: () => ({ kind: 'windows-helper', connected: false }) }; };
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture });
  assert.deepEqual(made[0].windows.flavorDirs, FOREVER_FLAVORS);
  assert.deepEqual(made[0].windows.notGame, NOT_GAME);
  assert.equal(made[0].windows.exeDir, w.flavorDir, 'the folder the addon is in');
  assert.equal(made[0].statsSec, 10, 'a stats line every 10 s (display R0, DR-03): the watchdog counts in them');
  await b.stop();
});

test('capture (PF-07): a data folder too deep for a socket puts capture.sock in the per-user temp folder, the same name each time; a short one keeps it in the state folder', async (t) => {
  const made = [];
  const createCapture = (o) => { made.push(o); return { start() {}, stop() {}, status: () => ({ kind: 'mac-app', connected: false }) }; };
  const w = wowFolder();
  const tmp = tmpDir('bones-t-');
  const deep = path.join(tmpDir('bones-deep-'), 'd'.repeat(70), 'NeverQuestAlone');
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture, env: { TMPDIR: tmp }, paths: { userData: deep } });
  const sock = made[0].mac.socketPath;
  assert.ok(Buffer.byteLength(path.join(deep, 'bridge', 'capture.sock')) > SOCKET_PATH_MAX, 'too long in the state folder');
  assert.ok(Buffer.byteLength(sock) <= SOCKET_PATH_MAX, `${Buffer.byteLength(sock)} bytes`);
  assert.equal(path.dirname(sock), tmp, 'in $TMPDIR');
  assert.match(path.basename(sock), /^capture-[0-9a-f]{16}\.sock$/);
  assert.equal(captureSocketPath(path.join(deep, 'bridge'), { env: { TMPDIR: tmp } }), sock, 'one install, one name');
  assert.notEqual(captureSocketPath(path.join(deep, 'other'), { env: { TMPDIR: tmp } }), sock, 'another install, another');
  assert.equal(captureSocketPath('/short/state', { env: { TMPDIR: tmp } }), path.join('/short/state', 'capture.sock'));
  assert.equal(path.dirname(captureSocketPath(path.join(deep, 'bridge'), { env: { TMPDIR: 'relative/tmp' }, tmpdir: tmp })), tmp, 'a relative TMPDIR is ignored');
  await b.stop();
});

test('installAddon from a boot with no addon yet: the bridge starts for the folder (restart)', async (t) => {
  const w = wowFolder({ addon: false });
  const { b } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'] });
  assert.equal(b.bridge, null);
  assert.equal((await b.api.status()).bridge.error, 'addon_not_installed');
  const res = await b.api.installAddon();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(b.bridge, 'the bridge now');
  const st = await b.api.status();
  assert.equal(st.bridge.running, true);
  assert.equal(st.wow.addon, true);
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'the new backend is ready');
});

test('manifests and prices are the bundled ones: no data file is fetched, and nothing turns capture off at boot', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b, lines, root } = await boot(t, { flavorDir: w.flavorDir, manifests: null, capture: true, createCapture: (o) => { made.push(o); return { start() {}, stop() {}, status: () => ({}) }; } });
  assert.equal((await b.api.providers()).find(p => p.id === 'anthropic').name, 'Anthropic');
  assert.equal(made.length, 1, 'the capture helper starts');
  assert.ok(!lines.some(l => /datafile|kill-switch/.test(l)), lines.join('\n'));
  assert.equal(fs.existsSync(path.join(root, 'ud', 'datafile.json')), false);
});

test('withPrivacy: with game context off a typed turn goes without context lines or state; events and everything else pass through (code health BR-22: it wraps send, the core\'s one way in)', async () => {
  const seen = [];
  const backend = {
    kind: 'byok',
    get displayName() { return 'Anthropic'; },
    send: (args) => { seen.push(args); return { runId: args.idem, status: 'started' }; },
    outcomes: ids => ids.map(runId => ({ runId, state: 'unknown' })),
    slotExtras: () => ({ rt: { state: 'ready' } }),
    checkModel: () => 3,
    start() {}, stop() {},
  };
  let privacy = { gameContext: true, companion: true };
  const w = withPrivacy(backend, () => privacy);
  assert.equal(w.kind, 'byok');
  assert.equal(w.displayName, 'Anthropic');
  assert.equal(w.checkModel(), 3);
  assert.notEqual(w.send, backend.send, 'send is wrapped');
  const params = { chatId: 'c3f9a1e', idem: 'k', turn: { kind: 'msg', typed: 'hi', contextLines: 'Game: …', state: { char: {} }, useContext: true } };
  assert.deepEqual(w.send(params), { runId: 'k', status: 'started' }, 'the backend\'s answer, as it gave it');
  assert.deepEqual(seen[0], params, 'both on: untouched');
  privacy = { gameContext: false };
  w.send(params);
  assert.deepEqual(seen[1].turn, { kind: 'msg', typed: 'hi', contextLines: null, useContext: false });
  assert.deepEqual([seen[1].chatId, seen[1].idem], ['c3f9a1e', 'k'], 'the rest of the send as it was');
  assert.equal(params.turn.state.char !== undefined, true, 'the caller\'s params are not changed');
  const evt = { chatId: 'c0ffee0', idem: 'e', turn: { kind: 'evt', event: { kind: 'level_up' }, state: { x: 1 }, contextLines: 'c' } };
  w.send(evt);
  assert.deepEqual(seen[2], evt, 'companion events are their own opt-in');
  assert.deepEqual(w.outcomes(['k']), [{ runId: 'k', state: 'unknown' }], 'everything else passes through');
  // The companion switch (audit CV-01, QL-F-14): off, or unreadable, a typed turn keeps its context lines
  // and its state's game information only: the character, the place and every quest's id, title and ready
  // flag; no objectives, quest levels, gear, points, professions or milestones.
  const full = { v: 1, sid: 'a1b2c3d4e5f60718', seq: 3, t: 1790000000, char: { name: 'Tavi', level: 20 }, loc: { zone: 'Mulgore', x: 47.5, y: 58.2 },
    questCount: 2, questMax: 40, questUnread: 1,
    quests: [{ id: 748, title: 'Poison Water', level: 6, trivial: false, complete: false, obj: [{ text: 'Well Stone', have: 1, need: 6 }] },
      { id: 1527, title: 'Call of F', cut: true, level: 20, complete: true, obj: [] }],
    poi: [{ id: 748, map: 1412, x: 50, y: 60 }], prof: [{ name: 'Mining', rank: 45, max: 75 }], gear: [{ slot: 1, id: 2, ilvl: 3 }],
    pending: [{ kind: 'zone', zone: 'Thunder Bluff', t: 1 }], omitted: ['poi', 'quests.obj.text', 'quests.title.short'] };
  const listOnly = { v: 1, sid: 'a1b2c3d4e5f60718', seq: 3, t: 1790000000, char: { name: 'Tavi', level: 20 }, loc: { zone: 'Mulgore', x: 47.5, y: 58.2 },
    questCount: 2, questMax: 40, questUnread: 1,
    quests: [{ id: 748, title: 'Poison Water', complete: false }, { id: 1527, title: 'Call of F', cut: true, complete: true }], omitted: ['quests.title.short'] };
  const withFull = { ...params, turn: { ...params.turn, state: full } };
  for (const pv of [{ gameContext: true }, { gameContext: true, companion: false }, null]) {
    privacy = pv;
    w.send(params);
    assert.deepEqual(seen.at(-1).turn, { kind: 'msg', typed: 'hi', contextLines: 'Game: …', state: { char: {} }, useContext: true }, JSON.stringify(pv));
    w.send(withFull);
    assert.deepEqual(seen.at(-1).turn.state, listOnly, JSON.stringify(pv));
    assert.deepEqual(Object.keys(seen.at(-1).turn.state), Object.keys(listOnly), 'in its order');
  }
  privacy = { gameContext: true, companion: true };
  w.send(withFull);
  assert.deepEqual(seen.at(-1).turn.state, full, 'on: the whole state');
  const unreadable = withPrivacy(backend, () => { throw new Error('no'); });
  unreadable.send(withFull);
  assert.deepEqual(seen.at(-1).turn.state, listOnly, 'a privacy it can\'t read keeps all but the game information home');
  const tooLarge = { v: 1, sid: 'a1b2c3d4e5f60718', seq: 4, state: 'too_large' };
  unreadable.send({ ...params, turn: { ...params.turn, state: tooLarge } });
  assert.deepEqual(seen.at(-1).turn.state, tooLarge, 'a too_large state as it is');
  unreadable.send({ ...params, turn: { ...params.turn, state: 'junk' } });
  assert.equal('state' in seen.at(-1).turn, false, 'a state that isn\'t one stays home');
  assert.equal(params.turn.state.char !== undefined, true, 'the caller\'s params are still not changed');
  assert.equal(full.gear.length, 1, 'nor its state');
});

test('withPrivacy: game context on sends the context even when the core was built with it off; the slot carries the echo and Screen Reading switches', async () => {
  const seen = [];
  const backend = {
    send: (args) => { seen.push(args); return { runId: args.idem, status: 'started' }; },
    slotExtras: () => ({ bridge: { caps: ['provider', 'usage'], provider: { id: 'anthropic' } }, rt: { state: 'ready' } }),
  };
  let privacy = { gameContext: true, echo: false };
  const w = withPrivacy(backend, () => privacy);
  // The core read game context once, at start, while it was off.
  const params = { chatId: 'c3f9a1e', idem: 'k', turn: { kind: 'msg', typed: 'hi', contextLines: 'Game: …', useContext: false } };
  w.send(params);
  assert.equal(seen[0].turn.useContext, true);
  assert.equal(seen[0].turn.contextLines, 'Game: …');
  assert.equal(params.turn.useContext, false, 'the caller\'s params are not changed');
  // Echo (PR-1, TH13): off for new installs; the addon reads bridge.echo, gated on the 'echo' cap.
  // Screen Reading (the app's Your data switch): on unless the player turned it off; the addon reads
  // bridge.reading, gated on the 'reading' cap.
  assert.deepEqual(w.slotExtras(), { bridge: { caps: ['provider', 'usage', 'echo', 'reading'], provider: { id: 'anthropic' }, echo: 'off', reading: 'on' }, rt: { state: 'ready' } });
  privacy = { gameContext: true, echo: true };
  assert.equal(w.slotExtras().bridge.echo, 'on');
  assert.deepEqual(w.slotExtras().bridge.caps, ['provider', 'usage', 'echo', 'reading']);
  privacy = { gameContext: true, echo: true, screenReading: false };
  assert.equal(w.slotExtras().bridge.reading, 'off');
  privacy = { gameContext: true, echo: true, screenReading: true };
  assert.equal(w.slotExtras().bridge.reading, 'on');
});

test('secretKeystore registers keys before they are used or stored; the store is otherwise the same', async () => {
  const got = [];
  const ks = secretKeystore(createKeyStore({ backend: 'memory' }), { addSecret: s => got.push(s) });
  await ks.set('xai', CANARY_KEYS.xai);
  assert.deepEqual(got, [CANARY_KEYS.xai]);
  assert.equal(await ks.get('xai'), CANARY_KEYS.xai);
  assert.equal(got.length, 2);
  assert.equal(await ks.get('openai'), null);
  assert.equal(got.length, 2, 'nothing for no key');
  assert.deepEqual(await ks.list(), ['xai']);
  assert.equal(await ks.delete('xai'), true);
  assert.equal(ks.label, 'this session only');
  assert.equal(Object.isFrozen(ks), true);
});

test('a typed turn runs at the player\'s effort, never an old config\'s sessions.thinking level (read by nothing: code health BR-28)', async (t) => {
  const w = wowFolder();
  const { b, mock } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Fine.\n\nTL;DR: fine.'),
    config: { byok: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, sessions: { thinking: 'high' } } });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  assert.equal((await b.api.status()).backend.provider.effort, 'low');
  inGame(b.bridge).say('hi');
  await waitFor(() => posts(mock).length === 1, 8000, 'the turn');
  assert.deepEqual(posts(mock)[0].body.output_config, { effort: 'low' }, 'what the player picked (DB22), never high');
});

test('code health BR-28: the core reads the companion switch from byok.privacy: off (the default) a game event takes no turn; on in the app, the next one does, with no restart; off again, none; an old config\'s companion section is read by nothing', async (t) => {
  const w = wowFolder();
  const { b, mock, lines } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Ding!\n\nTL;DR: ding.'), config: { companion: { enabled: true } } });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  inGame(b.bridge);
  let n = 0;
  const evt = to => encodeRecord({ token: '3fa9c2d1', key: `e0f2_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'level_up', from: to - 1, to, agent: 'main', name: 'Companion', sid: 'a1b2c3d4e5f60718' }, body: '' });
  const dropped = () => lines.filter(l => l.startsWith('evt-dropped ') && JSON.parse(l.slice('evt-dropped '.length)).reason === 'companion off').length;
  assert.equal((await b.api.privacy()).companion, false, 'the shipped default');
  b.bridge.handlePayload(evt(8), 'strip');
  assert.equal(dropped(), 1, 'off: dropped, the old section notwithstanding');
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), companion: true }), { ok: true });
  b.bridge.handlePayload(evt(9), 'strip');
  await waitFor(() => posts(mock).length === 1, 8000, 'the event\'s turn');
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), companion: false }), { ok: true });
  b.bridge.handlePayload(evt(10), 'strip');
  assert.equal(dropped(), 2, 'off again: dropped');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(posts(mock).length, 1, 'one turn in all');
});

test('game context turned back on reaches the next typed turn, without a restart', async (t) => {
  const w = wowFolder();
  const { b, mock } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Mulgore.\n\nTL;DR: Mulgore.'), config: { byok: { provider: 'anthropic', privacy: { gameContext: false } } } });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  const game = inGame(b.bridge);
  game.say('where am I?');
  await waitFor(() => posts(mock).length === 1, 8000, 'the first turn');
  assert.ok(!JSON.stringify(posts(mock)[0].body).includes('Tauren Shaman'), 'off: no context lines');
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), gameContext: true }), { ok: true });
  game.say('and now?');
  await waitFor(() => posts(mock).length === 2, 8000, 'the second turn');
  assert.ok(JSON.stringify(posts(mock)[1].body).includes('Tauren Shaman'), 'on again: the context lines go');
});

test('the companion switch holds in the bridge (PRIVACY.md, audit CV-01, QL-F-14): off, a typed turn carries no companion information (objectives, gear), with st= or without, from any addon, and its quests\' titles as game information; on, it does; off again, it stops', async (t) => {
  const w = wowFolder();
  const { b, mock } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('East.\n\nTL;DR: east.') });
  assert.equal((await b.api.privacy()).companion, false, 'the shipped default');
  // Code health BR-22 (r4): the core calls the backend's send directly, so the send it holds must be
  // boot's privacy wrapper's (a core handed the backend's own would send what's checked below).
  assert.equal(typeof b.bridge.gateway.send, 'function');
  assert.notEqual(b.bridge.gateway.send, b.backend.send, 'the core\'s send is withPrivacy\'s');
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  const token = '3fa9c2d1', nonce = 'a3f1', sid = 'a1b2c3d4e5f60718';
  let n = 0, seq = 0;
  const put = (type, args, extra) => b.bridge.handlePayload(encodeRecord({ token, key: type === 'msg' ? `${nonce}_${++n}` : nonce, type, chat: type === 'msg' ? 'c3f9a1e' : '', args: { cur: 0, ...args }, ...extra }), 'strip');
  // What an addon that sends its state whatever the app's switch says puts on the strip (the release candidate's did).
  const state = () => {
    seq += 1;
    put('state', { sid, seq: String(seq) }, { body: JSON.stringify({ v: 1, sid, seq, t: 1790000000 + seq,
      char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 8, xp: 300, xpMax: 1400, money: 11800 },
      loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 47.5, y: 58.2 },
      quests: [{ id: 747, title: 'CV01QUEST The Hunt Begins', level: 3, objectives: [{ text: 'CV01OBJECTIVE Plainstrider Meat', have: 3, need: 7 }] }],
      gear: [{ slot: 11, id: 1491, name: 'CV01GEAR Ring of Probing', ilvl: 14 }], prof: [], pending: [], omitted: [] }) });
  };
  const say = (text, st) => put('msg', { agent: 'main', name: 'Route', ctx: 1, q: 'followup', ...(st ? { st: String(st) } : {}) }, { text, context: CTX });
  const companionIn = i => /CV01(OBJECTIVE|GEAR)/.test(JSON.stringify(posts(mock)[i].body));
  const titleIn = i => JSON.stringify(posts(mock)[i].body).includes('CV01QUEST The Hunt Begins');
  put('hello', { ver: '1.4.4', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: 3, sid }, { body: CTX });
  state();
  say('what next?', seq);
  await waitFor(() => posts(mock).length === 1, 8000, 'the first turn');
  assert.equal(companionIn(0), false, 'off, st=: no objective or gear name');
  assert.equal(titleIn(0), true, 'off, st=: the quest\'s title, game information (QL-F-14)');
  assert.ok(JSON.stringify(posts(mock)[0].body).includes('Mulgore'), 'game context still goes (its own switch)');
  say('and then?');
  await waitFor(() => posts(mock).length === 2, 8000, 'the second turn');
  assert.equal(companionIn(1), false, 'off, no st=: the stored state stays home too');
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), companion: true }), { ok: true });
  state();
  say('now?', seq);
  await waitFor(() => posts(mock).length === 3, 8000, 'the third turn');
  assert.equal(companionIn(2), true, 'on: the companion state goes');
  assert.deepEqual(await b.api.setPrivacy({ ...(await b.api.privacy()), companion: false }), { ok: true });
  say('and now?', seq);
  await waitFor(() => posts(mock).length === 4, 8000, 'the fourth turn');
  assert.equal(companionIn(3), false, 'off again in the same session: the state kept from while it was on keeps its companion information home');
  assert.equal(titleIn(3), true, 'and its quest titles go');
});

test('a model the start-time check switches is saved and shown; the next launch keeps it and says nothing again', async (t) => {
  const handler = (r) => {
    if (r.method === 'GET' && r.url.startsWith('/v1/models')) return json({ data: [{ id: 'claude-haiku-4-5-20251001', type: 'model' }], has_more: false });
    if (r.method === 'POST') return r.body?.model === 'claude-sonnet-5' ? json({ type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonnet-5' } }, 404) : reply('Fine.\n\nTL;DR: fine.');
    return null;
  };
  const { b, root, mock, opts, lines } = await boot(t, { keys: ['anthropic'], handler, config: { byok: { provider: 'anthropic', model: 'claude-sonnet-5' } }, backendOptions: { checks: { models: true } } });
  const configFile = path.join(root, 'ud', 'config.json');
  const st = await waitFor(async () => { const s = await b.api.status(); return s.backend.notice ? s : null; }, 5000, 'the notice');
  assert.equal(st.backend.notice.kind, 'model_switched');
  assert.equal(st.backend.notice.from, 'claude-sonnet-5');
  const to = st.backend.notice.to;
  assert.equal(to, 'claude-haiku-4-5');
  await waitFor(() => b.config.byok.model === to, 2000, 'the config');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).byok.model, to, 'saved');
  assert.ok(lines.some(l => l.startsWith('byok-model-kept')));
  const tk = await b.api.testKey('anthropic');
  assert.equal(tk.ok, true, JSON.stringify(tk));
  assert.equal(posts(mock).at(-1).body.model, to, 'the key test uses it');
  assert.equal((await b.api.status()).backend.provider.model, to, 'the window shows it');
  await b.stop();
  // The next launch reads the saved config: no switch, and the model check says nothing. The model it
  // switched to here, Claude Haiku 4.5, is one Anthropic retires (SY-102-5): the window's notice says that, not the switch.
  const again = await bootByok({ ...opts, config: undefined, configFile });
  t.after(() => again.stop());
  assert.equal(again.config.byok.model, to);
  await waitFor(() => again.backend.status().modelCheck, 5000, 'the check');
  assert.equal(again.backend.status().notice, null);
  assert.deepEqual((await again.api.status()).backend.notice, { kind: 'model_retiring', model: to, after: '2026-10-15', to: 'claude-sonnet-5-5', at: null, name: 'Claude Haiku 4.5', toName: 'Claude Sonnet 5.5' });
});

test('uninstall: keys, the app\'s data and (asked) the addon go; the app quitting afterwards makes none of it again', async (t) => {
  const w = wowFolder();
  const { b, root, keystore } = await boot(t, { flavorDir: w.flavorDir, keys: ['anthropic'], handler: () => reply('Mulgore.', { input: 100, output: 5 }) });
  await waitFor(async () => (await b.api.status()).backend.rt.state === 'ready', 3000, 'ready');
  await b.backend.send(sendParams('c3f9a1e', 'k1', 'where am I?'));
  await waitFor(async () => (await b.api.usage({ days: 1 })).replies.length === 1, 5000, 'reply');
  await b.api.choose({ provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' }); // a saved config.json
  const ud = path.join(root, 'ud');
  for (const f of ['ledger.json', 'transcripts', 'bridge', 'config.json']) assert.ok(fs.existsSync(path.join(ud, f)), f);
  const r = await b.api.uninstall({ removeAddon: true });
  assert.deepEqual(r, { ok: true, removed: ['keys', 'data', 'addon', 'slots', 'doorbells'] });
  assert.deepEqual(await keystore.list(), []);
  assert.deepEqual(fs.readdirSync(ud), [], 'the data folder is empty (the desktop shell removes it at quit)');
  assert.deepEqual(fs.readdirSync(w.addonsDir).filter(n => n.startsWith('NeverQuestAlone')), []);
  assert.equal(b.bridge, null, 'stopped through boot, so its stop() has nothing left to write');
  await b.stop();
  assert.deepEqual(fs.readdirSync(ud), [], 'nothing made again at quit');
  assert.deepEqual(fs.readdirSync(w.addonsDir).filter(n => n.startsWith('NeverQuestAlone')), []);
  // One lock (code health BR-27): the AddOns folder's, gone with the addon; none of its own anywhere.
  const locks = path.join(root, 'locks');
  assert.equal(fs.existsSync(locks) ? fs.readdirSync(locks).length : 0, 0, 'no lock left');
});

test('capture: an app whose identity names no Mac helper (config\'s capture.app null) still boots and starts capture; what it reads on a Mac without one is lane 4\'s', async (t) => {
  const made = [];
  const w = wowFolder();
  const { b } = await boot(t, { flavorDir: w.flavorDir, capture: true, createCapture: fakeHelper(made), captureThresholds: { typedWaitMs: 0 }, config: { capture: { app: null } } });
  assert.equal(b.config.capture.app, null);
  assert.equal(made.length, 1, 'capture started');
  assert.equal(made[0].o.mac.app, null, 'no helper to name');
});
