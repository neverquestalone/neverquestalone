// Durable writes only where money and messages need them (systems plan Batch 4, SY-03): through
// the whole bridge (core + local backend, the providers' mock server on 127.0.0.1, canary keys, a
// 200-slot pool), every fsync of a turn is the outbox's new message or the ledger's 'sending' mark
// (and their folder). Everything else is written with a rename alone, and still reads back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBridge } from '../../bridge/service.mjs';
import { installSlots } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { createLedger } from '../../bridge/byok/ledger.mjs';
import { writeFileQuick, writeFileDurable, ensureStateDir } from '../../bridge/files.mjs';
import { startMock, reply, manifestsAt, canaryKeystore, waitFor, tmpDir, NO_CHECKS } from './helpers/byok-env.mjs';

const TOKEN = '3fa9c2d1';
const NONCE = 'a3f1';
const CHAT = 'c3f9a1e';

// Every fsync while `on`, by the file (or folder) its descriptor was opened for.
function spyFsync() {
  const fdPath = new Map();
  const seen = [];
  const o = { open: fs.openSync, close: fs.closeSync, fsync: fs.fsyncSync };
  let on = false;
  fs.openSync = function (p, ...a) { const fd = o.open.call(this, p, ...a); fdPath.set(fd, String(p)); return fd; };
  fs.closeSync = function (fd) { fdPath.delete(fd); return o.close.call(this, fd); };
  fs.fsyncSync = function (fd) { if (on) seen.push(fdPath.get(fd) || '?'); return o.fsync.call(this, fd); };
  return {
    seen,
    start() { on = true; seen.length = 0; },
    stop() { on = false; },
    restore() { Object.assign(fs, { openSync: o.open, closeSync: o.close, fsyncSync: o.fsync }); },
  };
}
// A temp file's name back to the file it replaces (".ledger.json.<pid>.<t>.tmp" → "ledger.json").
const fileOf = p => path.basename(p).replace(/^\.(.+?)\.\d+\.[0-9a-z-]+\.tmp$/, '$1');

test('a turn fsyncs only the outbox\'s new message and the ledger\'s sending mark (4 fsyncs with their folders, was 40); state, records, caps, history and byok-chats read back', async (t) => {
  const mock = await startMock(() => reply('Head east along the road.\n\nTL;DR: East.', { input: 2000, output: 60 }));
  const tmp = tmpDir('nqa-durable-');
  const addons = path.join(tmp, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const keystore = await canaryKeystore();
  const dirs = { state: path.join(tmp, 'state'), data: path.join(tmp, 'data') };
  const logs = [];
  const log = (k, f) => logs.push({ k, ...f });
  const bridge = createBridge({ transport: { slots: 200 } }, {
    stateDir: dirs.state, addonsDir: addons, log,
    gatewayFactory: h => createLocalBackend(h, { config: { byok: { provider: 'anthropic' } }, dataDir: dirs.data, keystore, log,
      manifests: manifestsAt(mock.url), providerOpts: { timeouts: { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 } }, checks: NO_CHECKS }),
  });
  const spy = spyFsync();
  let k = 0;
  const msg = text => encodeRecord({ token: TOKEN, key: `${NONCE}_${++k}`, type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Route', ctx: 0 }, text });
  const replies = () => logs.filter(l => l.k === 'reply').length;
  try {
    const started = Date.now();
    bridge.start();
    // 5 s, as most whole-bridge tests wait (this one had 3 s: on Windows the test takes 1.4 to 1.8 s in all, and
    // a loaded runner's start of a 200-slot pool once used the 3); how long it took goes in the log.
    await waitFor(() => bridge.status().gateway.state === 'ready', 5000, 'ready');
    t.diagnostic(`ready ${Date.now() - started} ms after start (200 slots)`);
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200 } }));
    bridge.handlePayload(msg('warm up'));
    await waitFor(() => replies() === 1, 5000, 'the first reply');
    await new Promise(r => setTimeout(r, 50));
    spy.start();
    for (let i = 2; i <= 4; i++) {
      bridge.handlePayload(msg(`question ${i}`));
      await waitFor(() => replies() === i, 5000, `reply ${i}`);
    }
    await new Promise(r => setTimeout(r, 50));
    spy.stop();
    const files = spy.seen.map(fileOf);
    assert.deepEqual([...new Set(files)].sort(), ['data', 'ledger.json', 'outbox.jsonl', 'state'], `fsynced: ${files.join(', ')}`);
    assert.equal(files.filter(f => f === 'outbox.jsonl').length, 3, 'one per new message');
    assert.equal(files.filter(f => f === 'ledger.json').length, 3, 'one per sending mark');
    assert.equal(files.length, 12, '4 a turn, with the two folders');
    // What was written without fsync is all there.
    const state = JSON.parse(fs.readFileSync(path.join(dirs.state, 'state.json'), 'utf8'));
    assert.equal(state.seq, bridge.status().seq);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.state, 'records.json'), 'utf8')).filter(r => r.t === 'reply').length, 4);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dirs.data, 'usage-history.json'), 'utf8')).recent.length, 4);
    assert.ok(fs.existsSync(path.join(dirs.data, 'byok-chats.json')));
    assert.deepEqual(fs.readdirSync(dirs.state).filter(f => f.endsWith('.tmp')), [], 'no temp file left');
  } finally {
    spy.restore();
    await bridge.stop();
    await mock.close();
  }
});

test('PF-04: ten copies of one state line (the strip redraws it with every change) save companion.json once at most; a new session, or a minute later, saves', async () => {
  const tmp = tmpDir('nqa-heard-');
  const addons = path.join(tmp, 'AddOns');
  installSlots(addons, { count: 2, iface: '16001' });
  const dirs = { state: path.join(tmp, 'state') };
  const clock = { t: Date.UTC(2026, 8, 27, 12) };
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: dirs.state, addonsDir: addons, now: () => clock.t,
    gatewayFactory: () => ({ kind: 'byok', start() {}, stop() {} }),
  });
  const saves = [];
  const rename = fs.renameSync;
  fs.renameSync = function (from, to, ...a) { if (path.basename(String(to)) === 'companion.json') saves.push(to); return rename.call(this, from, to, ...a); };
  const SID = 'a1b2c3d4e5f60718';
  const OTHER = 'b1b2c3d4e5f60718';
  const state = (sid, seq) => encodeRecord({ token: TOKEN, key: NONCE, type: 'state', chat: '', args: { cur: 0, sid, seq },
    body: JSON.stringify({ v: 1, sid, seq, t: 1790000000, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 8, xp: 300, xpMax: 1400, money: 11800 },
      loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 }, quests: [], prof: [], pending: [], omitted: [] }) });
  try {
    bridge.start();
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '1.5.2', sig: 'ok', slots: 200, sid: SID } }));
    bridge.handlePayload(state(SID, 1));
    const before = saves.length;
    for (let i = 0; i < 10; i++) bridge.handlePayload(state(SID, 1));
    assert.ok(saves.length - before <= 1, `${saves.length - before} saves for 10 copies (was 10)`);
    const quiet = saves.length;
    clock.t += 61_000;
    bridge.handlePayload(state(SID, 1));
    assert.equal(saves.length, quiet + 1, 'a minute later, the time it was heard is saved');
    bridge.handlePayload(state(OTHER, 1));
    assert.ok(saves.length >= quiet + 2, 'another session: saved at once');
    const comp = JSON.parse(fs.readFileSync(path.join(dirs.state, 'companion.json'), 'utf8'));
    assert.equal(comp.heard[TOKEN].sid, OTHER);
    assert.equal(comp.states[TOKEN].sid, OTHER);
  } finally {
    fs.renameSync = rename;
    await bridge.stop();
  }
});

test('the ledger: begin and done are written without fsync, sending with it; a crash (no stop) still reports the sending turn once', () => {
  const dir = tmpDir('nqa-ledger-durable-');
  const file = path.join(dir, 'ledger.json');
  const spy = spyFsync();
  try {
    const l = createLedger(file);
    spy.start();
    l.begin('k1', { chatId: CHAT });
    assert.equal(spy.seen.length, 0, 'queued: no fsync');
    l.set('k1', 'sending', { estMicros: 50 });
    assert.deepEqual(spy.seen.map(fileOf), ['ledger.json', path.basename(dir)], 'sending: the file and its folder');
    l.set('k1', 'done', { outMicros: 40 });
    assert.equal(spy.seen.length, 2, 'done: no fsync');
    l.begin('k2', { chatId: CHAT });
    l.set('k2', 'sending');
    spy.stop();
    // The app is gone without a stop: the next one reports k2, once, and never k1.
    const again = createLedger(file);
    assert.deepEqual(again.interruptedAtStartup().map(e => e.key), ['k2']);
    assert.deepEqual(again.interruptedAtStartup(), []);
  } finally { spy.restore(); }
});

test('writeFileQuick: 0600, a rename (no fsync), two writes in one millisecond, and nothing left behind when it fails', () => {
  const dir = tmpDir('nqa-quick-');
  const file = path.join(dir, 'x.json');
  const spy = spyFsync();
  spy.start();
  try {
    for (let i = 0; i < 50; i++) writeFileQuick(file, `{"i":${i}}\n`);
  } finally { spy.stop(); spy.restore(); }
  assert.equal(spy.seen.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"i":49}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => writeFileQuick(path.join(dir, 'missing', 'y.json'), 'x'));
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});

test('writeFileDurable: 0600, fsynced, and no temp file left behind when the write fails; ensureStateDir makes a 0700 folder', () => {
  const dir = tmpDir('nqa-durable-');
  const file = path.join(dir, 'outbox.jsonl');
  assert.throws(() => writeFileDurable(file, Symbol('not writable')));
  assert.deepEqual(fs.readdirSync(dir), [], 'no .tmp left');
  const spy = spyFsync();
  spy.start();
  try { writeFileDurable(file, '{}\n'); } finally { spy.stop(); spy.restore(); }
  assert.ok(spy.seen.some(p => p.endsWith('.tmp')), 'the temp file is fsynced before the rename');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const state = path.join(dir, 'a', 'state');
  assert.equal(ensureStateDir(state), state);
  if (process.platform !== 'win32') assert.equal(fs.statSync(state).mode & 0o777, 0o700);
});
