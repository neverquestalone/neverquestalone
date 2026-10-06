#!/usr/bin/env node
// What the app does while World of Warcraft is closed (systems critic SY-30): the public build's
// bridge, booted as the desktop app boots it (bridge/byok/boot.mjs bootByok) on a temp WoW folder
// with the addon and its 200 slot folders installed, the game closed, and then left alone. For
// --seconds it counts what the process does on its own:
//   timers   timer callbacks run (setTimeout, setInterval, setImmediate), each a wakeup
//   addons   file operations in the AddOns folder (the doorbells, the lock, the slots)
//   wow      file operations in the rest of the game's folder (WTF: the SavedVariables poll)
//   data     file operations in the app's data folder (its state, its lock)
//   spawns   child processes started (the process list, pgrep or tasklist)
// and, on macOS with --top, the idle wakeups top counts for this process.
//
//   node tools/bench-idle.mjs [--seconds 60] [--warmup 5] [--helper report|none] [--tree <checkout>] [--top]
//
// --helper report: a capture helper that says the game is closed, as the Mac helper does from its
//   start (a stand-in: no screen is read); none: Screen Reading off, so the app asks the process
//   list itself (the real pgrep or tasklist, for a folder no game runs from).
// --tree: another checkout's bridge (its bridge/byok/boot.mjs, wow.mjs and keystore), so the same
//   numbers can be taken before and after a change. Prints one JSON line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const SECONDS = Number(arg('seconds', 60));
const WARMUP = Number(arg('warmup', 5));
const HELPER = arg('helper', 'report');
const TREE = path.resolve(arg('tree', path.join(HERE, '..')));
const TOP = process.argv.includes('--top') && process.platform === 'darwin';
let commit = null; // the measured tree's commit, when it's a git checkout
try { commit = cp.execFileSync('git', ['-C', TREE, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { /* not a checkout */ }
if (!(SECONDS > 0) || !(WARMUP >= 0) || !['report', 'none'].includes(HELPER) || !fs.existsSync(path.join(TREE, 'bridge', 'byok', 'boot.mjs'))) {
  console.error('usage: node tools/bench-idle.mjs [--seconds 60] [--warmup 5] [--helper report|none] [--tree <checkout>] [--top]');
  process.exit(2);
}

// ---------------------------------------------------------------- counting (installed before the bridge loads)
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-idle-'));
const flavorDir = path.join(root, 'wow', '_forever_');
const addons = path.join(flavorDir, 'Interface', 'AddOns');
const data = path.join(root, 'ud');
const counts = { timers: 0, addons: 0, wow: 0, data: 0, spawns: 0, byOp: {} };
let counting = false;
const where = (p) => {
  const s = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? fileURLToPath(p) : null;
  if (!s) return null;
  if (s.startsWith(addons)) return 'addons';
  if (s.startsWith(flavorDir)) return 'wow';
  if (s.startsWith(data) || s.startsWith(path.join(root, 'locks'))) return 'data';
  return null;
};
for (const name of ['statSync', 'lstatSync', 'readdirSync', 'readFileSync', 'writeFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'openSync', 'mkdirSync', 'chmodSync', 'existsSync', 'realpathSync', 'utimesSync', 'copyFileSync']) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  const wrapped = function (...a) {
    if (counting) {
      const w = where(a[0]);
      if (w) { counts[w] += 1; counts.byOp[`${w}.${name}`] = (counts.byOp[`${w}.${name}`] || 0) + 1; }
    }
    return orig.apply(this, a);
  };
  if (orig.native) wrapped.native = orig.native;
  fs[name] = wrapped;
}
const realSpawn = cp.spawn;
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
  const orig = cp[name];
  cp[name] = function (...a) { if (counting) counts.spawns += 1; return orig.apply(this, a); };
}
syncBuiltinESMExports();
const realSetTimeout = globalThis.setTimeout; // the bench's own waits aren't the app's wakeups
for (const name of ['setTimeout', 'setInterval', 'setImmediate']) {
  const orig = globalThis[name];
  globalThis[name] = function (fn, ...rest) {
    if (typeof fn !== 'function') return orig.call(this, fn, ...rest);
    return orig.call(this, function (...a) { if (counting) counts.timers += 1; return fn.apply(this, a); }, ...rest);
  };
}

// ---------------------------------------------------------------- the app, booted on a closed game
const load = rel => import(pathToFileURL(path.join(TREE, rel)).href);
const { bootByok } = await load('bridge/byok/boot.mjs');
const { installAddon } = await load('bridge/byok/wow.mjs');
const { createKeyStore } = await load('bridge/byok/security/keystore.mjs');
fs.mkdirSync(addons, { recursive: true });
// A player's SavedVariables, as after a first login (the poll looks it up in WTF/Account at each tick).
const sv = path.join(flavorDir, 'WTF', 'Account', 'ACCOUNT', 'SavedVariables', 'NeverQuestAlone.lua');
fs.mkdirSync(path.dirname(sv), { recursive: true });
fs.writeFileSync(sv, 'NQADB = {\n\t["token"] = "3fa9c2d1",\n}\n');
const installed = installAddon({ flavorDir, running: false });
if (!installed.ok) { console.error(`bench-idle: the addon didn't install: ${JSON.stringify(installed.steps ?? installed)}`); process.exit(1); }
const helper = HELPER === 'report' ? (o) => ({
  kind: 'mac-app',
  start() { setImmediate(() => o.onGame?.({ state: 'absent', pid: null })); },
  stop() {},
  probe() {},
  status: () => ({ kind: 'mac-app', connected: true, permission: true, window: null, stats: null }),
}) : null;
const sleep = ms => new Promise(r => realSetTimeout(r, ms));
let app = null;
let out = null;
try {
  app = await bootByok({
    paths: { userData: data }, home: path.join(root, 'home'), env: {}, log: () => {},
    keystore: createKeyStore({ backend: 'memory' }),
    config: { wow: { flavorDir }, byok: { provider: 'anthropic' }, capture: { enabled: HELPER === 'report' } },
    capture: HELPER === 'report', ...(helper ? { createCapture: helper } : {}),
    egress: false, lockDir: path.join(root, 'locks'),
    backendOptions: { checks: { models: false } }, wow: { roots: [] },
  });
  if (!app.bridge) throw new Error('the bridge didn\'t start on the temp WoW folder');
  await sleep(WARMUP * 1000);
  // A tree with the game's state (SY-30) settles on it first: the helper's word, or the process list's
  // answer (tasklist can take seconds on a loaded Windows machine), so the idle state is what's counted.
  for (let i = 0; i < 150; i++) {
    const g = app.bridge.status().game;
    if (!g || (g.state !== 'unknown' && !g.working)) break;
    await sleep(100);
  }
  let top = null;
  if (TOP) {
    let text = '';
    top = realSpawn('top', ['-l', '2', '-s', String(Math.max(1, Math.round(SECONDS))), '-pid', String(process.pid), '-stats', 'pid,idlew'], { stdio: ['ignore', 'pipe', 'ignore'] });
    top.stdout.on('data', (d) => { text += String(d); });
    top.done = new Promise(r => top.on('close', () => r(text)));
  }
  counting = true;
  await sleep(SECONDS * 1000);
  counting = false;
  let idle = null;
  if (top) {
    const text = await top.done;
    const rows = [...text.matchAll(new RegExp(`^${process.pid}\\s+(\\d+)`, 'gm'))].map(m => Number(m[1]));
    if (rows.length >= 2) idle = rows[1] - rows[0];
  }
  const perMinute = v => Math.round((v * 60 / SECONDS) * 10) / 10;
  const st = app.bridge.status();
  out = {
    tree: TREE === path.resolve(HERE, '..') ? '.' : TREE, commit, helper: HELPER, seconds: SECONDS,
    game: st.game ?? null,
    perMinute: { timers: perMinute(counts.timers), addons: perMinute(counts.addons), wow: perMinute(counts.wow), data: perMinute(counts.data), spawns: perMinute(counts.spawns),
      ...(idle !== null ? { idleWakeups: perMinute(idle) } : {}) },
    total: { timers: counts.timers, addons: counts.addons, wow: counts.wow, data: counts.data, spawns: counts.spawns, ...(idle !== null ? { idleWakeups: idle } : {}) },
    byOp: counts.byOp, platform: `${process.platform}-${process.arch}`, node: process.version,
  };
} finally {
  counting = false;
  await app?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
