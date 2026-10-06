#!/usr/bin/env node
// What a typed turn costs the app's main thread (systems critic SY-27, the fix pass's PF-04 probe as a
// tool). The desktop app runs the bridge in Electron's main process, and its file I/O is synchronous,
// so every millisecond here is one the window and the tray wait for. The app's own assembly
// (bridge/byok/boot.mjs bootByok: the core, the backend, the app API with a status listener, as
// main.mjs has one) runs on a temp WoW folder with the addon and its 200 slot folders installed, a
// reporting addon's hello (slot=1), the companion's state, and a loopback stand-in for the AI
// (tests/byok/helpers/mock-provider.mjs: no network). Then, per typed message until its reply is in
// the slots:
//   fsync, rename, open, writeFile, write   the synchronous file calls (in the temp folders only)
//   fsMs                                    the time they took
//   publishes, slotFiles                    the core's publishes and the slot files they wrote
//   pushes                                  the app's status pushes (each one a status() for the
//                                           window and the tray)
//   activeMs                                the main thread's busy time (its event loop's), and
//                                           loopMaxMs, its longest stall (monitorEventLoopDelay, 1 ms
//                                           resolution). The stand-in AI runs in a thread of its own
//                                           (code health BR-04), so this is the app's work alone; the
//                                           slot files, which the app's publisher writes from a worker
//                                           thread (bridge/write-queue.mjs), aren't in it either, nor
//                                           the outbox, state.json and the ledger, written by the same
//                                           thread in one ordered queue (BR-04, durable writes): the
//                                           counts above are the main thread's own file calls.
// then the same state line read 10 times (the strip redraws it with every change), which must write
// nothing, and status() itself 20 times (statusMs). windows-smoke runs it on the runner's NTFS, so
// there is a Windows number beside the Mac's (docs/VERIFICATION.md).
//
// --mode window (the default): a reporting addon in pixel mode, its records read off the screen, so
// a publish writes its slot window. --mode stream: Screen Reading off in game (stream mode), so the
// hello and the messages come from SavedVariables (the reload path), there is no window, and every
// publish writes all 200 slots and the reload inbox.
//
//   node tools/bench-turn.mjs [--turns 5] [--mode window|stream] [--dir <folder for the temp files>]
//
// Prints one JSON line: { turns, mode, perTurn: { <metric>: { p50, max } }, first: <turn 1's counts>,
// dupState10, statusMs: { p50, max }, worker (the slot worker's state), platform, node }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const TURNS = Number(arg('turns', 5));
const MODE = arg('mode', 'window');
if (!Number.isInteger(TURNS) || TURNS < 1 || TURNS > 50 || !['window', 'stream'].includes(MODE)) {
  console.error('usage: node tools/bench-turn.mjs [--turns 5] [--mode window|stream] [--dir <folder>]');
  process.exit(2);
}
const VIA = MODE === 'stream' ? 'reload' : 'strip'; // how the addon's records reach the app
const root = fs.mkdtempSync(path.join(arg('dir', os.tmpdir()), 'bench-turn-'));

// ---------------------------------------------------------------- counting (before the bridge loads)
const C = { fsync: 0, rename: 0, open: 0, writeFile: 0, write: 0, fsMs: 0 };
const fds = new Set(); // descriptors opened inside the temp root
const inRoot = (p) => {
  const s = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : null;
  return !!s && path.resolve(s).startsWith(root);
};
const wrap = (name, key, counts) => {
  const orig = fs[name];
  fs[name] = function (...a) {
    const mine = counts(a);
    const t0 = mine ? performance.now() : 0;
    const r = orig.apply(this, a);
    if (mine) { C[key] += 1; C.fsMs += performance.now() - t0; if (name === 'openSync' && typeof r === 'number') fds.add(r); }
    return r;
  };
};
wrap('openSync', 'open', a => inRoot(a[0]));
wrap('fsyncSync', 'fsync', a => fds.has(a[0]));
wrap('renameSync', 'rename', a => inRoot(a[1]));
wrap('writeFileSync', 'writeFile', a => (typeof a[0] === 'number' ? fds.has(a[0]) : inRoot(a[0])));
wrap('writeSync', 'write', a => fds.has(a[0]));
const closeSync = fs.closeSync;
fs.closeSync = function (fd) { fds.delete(fd); return closeSync.call(this, fd); };
syncBuiltinESMExports();

const { bootByok } = await import('../bridge/byok/boot.mjs');
const { installAddon } = await import('../bridge/byok/wow.mjs');
const { SLOT_COUNT } = await import('../bridge/transport/slots.mjs');
const { encodeRecord } = await import('../bridge/transport/records.mjs');
const E = await import('../tests/byok/helpers/byok-env.mjs');

const TOKEN = '3fa9c2d1', CHAT = 'c3f9a1e', SID = 'a1b2c3d4e5f60718', NONCE = 'a3f1';
const CTX = 'Game: World of Warcraft: Forever\nCharacter: Testy on Testrealm, level 8\nLocation: Mulgore';
const STATE = seq => JSON.stringify({ v: 1, sid: SID, seq, t: 1790000000, char: { name: 'Testy', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 8, xp: 300, xpMax: 1400, money: 11800 }, loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 }, quests: [], prof: [], pending: [], omitted: [] });
let n = 0;
const hello = () => encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '0.5.3', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: SLOT_COUNT, sid: SID, slot: 1, mode: MODE === 'stream' ? 'stream' : 'pixel' }, body: CTX });
const state = seq => encodeRecord({ token: TOKEN, key: NONCE, type: 'state', args: { cur: 0, sid: SID, seq }, body: STATE(seq) });
const msg = text => encodeRecord({ token: TOKEN, key: `${NONCE}_${++n}`, type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Route', ctx: 1, q: 'followup' }, text, context: CTX });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const seen = p => encodeRecord({ token: TOKEN, key: NONCE, type: 'seen', args: { cur: 0, p } });
const snap = () => ({ ...C });
const diff = (a, b) => Object.fromEntries(Object.keys(b).map(k => [k, k === 'fsMs' ? Math.round((b[k] - a[k]) * 100) / 100 : b[k] - a[k]]));
const q = (xs, f) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };

// The process list, for a game that isn't running (the core's slow check and the app's status).
const NOT_RUNNING = () => ({ status: 1, stdout: '' });

// The stand-in AI, in a thread of its own: its HTTP server's work isn't the app's (code health BR-04).
// It answers after 800 ms, as a real one takes a while: the ack's publish and the reply's are two.
function startAi() {
  const ai = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    (async () => {
      const E = await import(workerData.env);
      const mock = await E.startMock(() => E.reply(workerData.text, { input: 2000, output: 80, delayMs: 800 }));
      parentPort.postMessage(mock.url);
      parentPort.once('message', async () => { await mock.close(); parentPort.postMessage('closed'); });
    })();`, { eval: true, workerData: { env: new URL('../tests/byok/helpers/byok-env.mjs', import.meta.url).href,
    text: 'You are in Mulgore, south of Bloodhoof Village.\n\nTL;DR: Mulgore.' } });
  const said = () => new Promise((resolve, reject) => { ai.once('message', resolve); ai.once('error', reject); });
  return said().then(url => ({ url, close: async () => { ai.postMessage('close'); await said(); await ai.terminate(); } }));
}

let app = null;
let mock = null;
let out = null;
try {
  mock = await startAi();
  const flavorDir = path.join(root, 'wow', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  const installed = installAddon({ flavorDir, running: false, run: NOT_RUNNING });
  if (!installed.ok) throw new Error(`the addon didn't install: ${JSON.stringify(installed.steps ?? installed)}`);
  const logs = [];
  app = await bootByok({
    paths: { userData: path.join(root, 'ud') }, home: path.join(root, 'home'), env: {}, log: (k, d) => logs.push({ k, ...d }),
    keystore: await E.canaryKeystore(),
    config: { wow: { flavorDir }, byok: { provider: 'anthropic', privacy: { companion: true, gameContext: true } } },
    capture: false, egress: false, lockDir: path.join(root, 'locks'),
    manifests: E.manifestsAt(mock.url), backendOptions: { checks: E.NO_CHECKS }, wow: { roots: [], run: NOT_RUNNING },
  });
  const bridge = app.bridge;
  if (!bridge) throw new Error('the bridge didn\'t start on the temp WoW folder');
  // Until the file calls and the publishes have been still for 300 ms (at most 5 s): a turn's last
  // publish is coalesced 250 ms, and the backend writes its ledger after the reply. A publish whose
  // slots the worker thread is still writing isn't still (its files aren't counted here, and a
  // loaded machine can take longer than 300 ms to start the worker for the first one), nor is a
  // write still in the worker's queue (BR-04, durable writes).
  const quiet = async (maxMs = 5000) => {
    const sig = () => `${C.rename}:${C.fsync}:${C.writeFile}:${C.open}:${logs.filter(l => l.k === 'publish').length}`;
    const t0 = Date.now();
    let last = sig();
    while (Date.now() - t0 < maxMs) {
      await sleep(300);
      const now = sig();
      if (now === last && !bridge.publisher.writing?.() && !bridge.writesQueued?.()) return;
      last = now;
    }
  };
  let pushes = 0;
  app.api.onChange(() => { pushes += 1; }); // the app's main.mjs listens, so each change is a status()
  await E.waitFor(() => bridge.status().gateway.state === 'ready', 5000, 'the backend ready');
  bridge.handlePayload(hello(), VIA);
  bridge.handlePayload(state(1), VIA);
  await quiet(); // the hello's answer (the window's first write empties the slots outside it)
  const turns = [];
  const loop = monitorEventLoopDelay({ resolution: 1 });
  for (let i = 1; i <= TURNS; i++) {
    const a = snap();
    const pubs0 = logs.filter(l => l.k === 'publish').length;
    const pushes0 = pushes;
    const elu0 = performance.eventLoopUtilization();
    loop.reset();
    loop.enable();
    bridge.handlePayload(msg(`what zone am I in? ${i}`), VIA);
    await E.waitFor(() => bridge.buildSlot().records.filter(r => r.t === 'reply').length >= i, 10000, `reply ${i}`);
    await quiet(); // the turn's last publish, its ring, the backend's writes and the status push
    loop.disable();
    const elu = performance.eventLoopUtilization(elu0);
    const pubs = logs.filter(l => l.k === 'publish').slice(pubs0);
    turns.push({
      ...diff(a, snap()),
      publishes: pubs.length,
      slotFiles: pubs.reduce((s, p) => s + (p.files || 0), 0),
      pushes: pushes - pushes0,
      activeMs: Math.round(elu.active * 100) / 100,
      loopMaxMs: Math.round(loop.max / 1e4) / 100,
    });
    // The addon reads the slot and says so (seen, p=), so nothing is rung again while the next turn is
    // measured (a re-ring every 10 s otherwise); not counted. (In stream mode it says so at its next
    // reload, from SavedVariables.)
    bridge.handlePayload(seen(bridge.status().push), VIA);
    await quiet();
  }
  const a = snap();
  const r = state(1);
  for (let i = 0; i < 10; i++) bridge.handlePayload(r, VIA);
  await sleep(200);
  const dupState10 = diff(a, snap());
  // status(): what the window and the tray get at every push.
  const st = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await app.api.status();
    st.push(performance.now() - t0);
  }
  const ms2 = v => Math.round(v * 100) / 100;
  const keys = Object.keys(turns[0]);
  out = {
    turns: TURNS,
    mode: MODE,
    perTurn: Object.fromEntries(keys.map(k => [k, { p50: q(turns.map(t => t[k]), 0.5), max: Math.max(...turns.map(t => t[k])) }])),
    first: turns[0],
    dupState10,
    statusMs: { p50: ms2(q(st, 0.5)), max: ms2(Math.max(...st)) },
    worker: bridge.status().publishes?.worker ?? null,
    platform: `${process.platform}-${process.arch}`, node: process.version,
  };
} finally {
  try { await app?.stop(); } catch { /* stopping */ }
  try { await mock?.close(); } catch { /* closing */ }
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
