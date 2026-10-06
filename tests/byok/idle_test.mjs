// No idle work while World of Warcraft is closed (systems critic SY-30). The public build's core
// (bridge/service.mjs with deps.gameGate, as bridge/byok/boot.mjs builds it) beats, re-rings, polls,
// sweeps and retries only while the game runs, and for a minute after it exits; the rest of the time
// one slow check runs (a SavedVariables stat, and the process list when no capture helper reports the
// game). The locks beat every minute while it's closed and say so. What each part does is counted
// through the functions the core is given (the SavedVariables file, the capture state, the process
// list) and read off the doorbells in a temp AddOns folder: nothing here touches a real game.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, GAME_LINGER_MS, GAME_CHECK_MS, GAME_ASK_MS } from '../../bridge/service.mjs';
import { installSlots } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { bootByok } from '../../bridge/byok/boot.mjs';
import { installAddon } from '../../bridge/byok/wow.mjs';
import { folderLockFile, lockFileFor, IDLE_HEARTBEAT_MS } from '../../bridge/byok/lock.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { waitFor, sleep, tmpDir } from './helpers/byok-env.mjs';

const BELLS = ['push_a', 'push_b', 'alive_a', 'alive_b', 'act'];
const bellFile = (addons, b) => path.join(addons, 'NeverQuestAlone', 'sig', 'ctl', `bell_${b}.wav`);
/** Each bell's file identity: a pulse deletes and re-creates it, so a pulse changes it. */
const bellIds = addons => BELLS.map((b) => { try { const st = fs.statSync(bellFile(addons, b)); return `${st.ino}:${st.birthtimeMs}`; } catch { return 'missing'; } });
const allBells = addons => BELLS.every((b) => { try { return fs.lstatSync(bellFile(addons, b)).isFile(); } catch { return false; } });

/** A backend stand-in: ready at once, a send answered started. */
function gatewayDouble() {
  return (handlers) => ({
    kind: 'byok',
    persona: 'NeverQuestAlone',
    start() { handlers.onState({ state: 'ready', since: Date.now() }); handlers.onReady(); },
    stop() {},
    send: args => ({ runId: args.idem, status: 'started' }),
    outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
  });
}

/** A core on a temp AddOns folder, with the gate (unless gate: false) and fast timings, counting what runs. */
// askMs: the process list's backoff after a "not running" (BR-15; 2 min, then 5 min in the app): here
// the slow check's own pace unless a test says otherwise. wtf: a WTF folder whose Account is watched.
function core({ gate = true, helper = false, running = false, reported = false, checkDelayMs = 0, pids = null, lingerMs = 200, askMs = [60], wtf = null } = {}) {
  const root = tmpDir('bones-idle-');
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 3, iface: '16001' });
  const calls = { sv: 0, capture: 0, check: 0, checkAt: [] };
  const said = [];
  const world = { running, reported, pids };
  const bridge = createBridge({ transport: { slots: 3 }, sessions: { labels: { main: 'NeverQuestAlone' } } }, {
    stateDir: path.join(root, 'state'), addonsDir: addons, log: (kind, f) => { if (kind === 'game-state') said.push(f); },
    gatewayFactory: gatewayDouble(),
    publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 5, alive: 5, act: 5 }, actGapMs: 5 },
    savedVariablesFile: () => { calls.sv += 1; return null; },
    // The capture watchdog, ticked on the in-game 2 s beat (20 ms here): calls.capture counts its ticks.
    captureHealth: { platform: 'win32' },
    aliveEveryMs: 20, ringEveryMs: 20, savedVarsEveryMs: 20, runCheckEveryMs: 20,
    ...(gate ? {
      gameGate: true, gameHelper: helper, gameCheckMs: 60, gameLingerMs: lingerMs, gameAskMs: askMs, wakeMs: 20, ...(wtf ? { wtfDir: wtf } : {}),
      gameCheck: async () => {
        calls.check += 1;
        calls.checkAt.push(Date.now());
        if (checkDelayMs) await sleep(checkDelayMs);
        return world.pids ? { running: world.running, pids: world.running ? world.pids : [] } : world.running;
      },
      gamePidEveryMs: 40,
      gameReported: () => world.reported,
    } : {}),
  });
  const h = bridge.captureHealth;
  const tick = h.tick;
  h.tick = (...a) => { calls.capture += 1; return tick(...a); };
  return { root, addons, bridge, calls, said, world };
}
const snapshot = c => ({ ...c.calls, checkAt: undefined, bells: bellIds(c.addons), rings: c.bridge.status().bells });
// At most this many runs of a 60 ms slow check in `ms`, however late a loaded machine runs them.
const atMostSlowChecks = ms => Math.floor(ms / 60) + 1;
// A publish the start or a transition asked for (the capture state is read with every slot, and a
// ready gateway rings once) settles before a quiet window is measured: every bell in place and the
// ring counts the same twice, 80 ms apart (a loaded machine runs them late).
async function settle(c) {
  let last = null;
  for (let i = 0; i < 60; i++) {
    const now = JSON.stringify([c.bridge.status().bells, bellIds(c.addons)]);
    if (now === last && allBells(c.addons)) return;
    last = now;
    await sleep(80);
  }
}

test('the constants: a minute of in-game work after the game exits, a slow check every 30 s, the process list again 2 min after a "not running", then every 5 min', () => {
  assert.equal(GAME_LINGER_MS, 60_000);
  assert.equal(GAME_CHECK_MS, 30_000);
  assert.deepEqual(GAME_ASK_MS, [120_000, 300_000]);
  assert.equal(IDLE_HEARTBEAT_MS, 60_000);
});

test('WoW closed, no capture helper (Screen Reading off): after the start\'s check, only the slow check runs: a SavedVariables stat each time, and the process list on its backoff (code health BR-15); no beat, no re-ring, no capture check, no bell touched', async (t) => {
  // The process list again 240 ms after the start's "not running", then every 600 ms (2 min, 5 min in the app).
  const c = core({ askMs: [240, 600] });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  await waitFor(() => c.bridge.status().game?.state === 'down' && !c.bridge.status().game.working, 2000, 'the game known to be closed');
  assert.deepEqual(c.said[0], { state: 'down', why: 'check' }, 'from unknown: no linger');
  await settle(c);
  assert.ok(allBells(c.addons), 'every bell in place for the next UI load');
  const a = snapshot(c);
  const t0 = Date.now();
  await waitFor(() => c.calls.check >= 4, 5000, 'four asks');
  const b = snapshot(c);
  const elapsed = Date.now() - t0;
  assert.equal(b.capture - a.capture, 0, 'no capture-state check');
  assert.deepEqual(b.bells, a.bells, 'no bell deleted or made: no alive beat, no ring');
  assert.deepEqual(b.rings, a.rings);
  // The slow check: every 60 ms here (30 s in the app), each a SavedVariables stat.
  const ticks = b.sv - a.sv;
  assert.ok(ticks >= 6 && ticks <= atMostSlowChecks(elapsed), `${ticks} slow checks in ${elapsed} ms`);
  // The process list: at the start, then 240 ms on, then 600 ms between asks.
  const gaps = c.calls.checkAt.slice(1, 4).map((at, i) => at - c.calls.checkAt[i]);
  assert.ok(gaps[0] >= 230 && gaps[1] >= 590 && gaps[2] >= 590, `the asks' gaps: ${gaps.join(', ')} ms`);
  assert.ok(b.check - a.check < ticks, 'fewer asks than slow checks');
});

test('WoW closed (code health BR-15): a write under WTF/Account (a login\'s caches, a /reload\'s SavedVariables) wakes the slow check at once, and it asks the process list whatever its backoff says', async (t) => {
  const wtf = path.join(tmpDir('bones-idle-wtf-'), 'WTF');
  const sv = path.join(wtf, 'Account', 'ACCOUNT', 'SavedVariables');
  fs.mkdirSync(sv, { recursive: true });
  const c = core({ askMs: [60_000], wtf });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  await waitFor(() => c.bridge.status().game?.state === 'down' && !c.bridge.status().game.working, 2000, 'the game known to be closed');
  await sleep(300);
  assert.equal(c.calls.check, 1, 'the start\'s ask, then a minute\'s wait');
  // The player starts WoW: it writes in its account folder.
  c.world.running = true;
  fs.writeFileSync(path.join(sv, 'NeverQuestAlone.lua'), 'NQADB = {}\n');
  await waitFor(() => c.bridge.status().game.state === 'up', 5000, 'woken, asked, found');
  assert.equal(c.calls.check, 2);
  assert.deepEqual(c.said.at(-1), { state: 'up', why: 'check' });
});

test('the game\'s launch starts the in-game work; its exit keeps it a minute (here 600 ms) for the logout\'s SavedVariables, then stops it with every bell in place', async (t) => {
  const c = core({ lingerMs: 600 });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  await waitFor(() => c.bridge.status().game?.state === 'down' && !c.bridge.status().game.working, 2000, 'closed');
  // The capture helper says the game launched (a workspace notification on a Mac, a window on Windows).
  c.bridge.onGame({ state: 'launched', pid: 4242 });
  assert.deepEqual([c.bridge.status().game.state, c.bridge.status().game.working], ['up', true]);
  const a = snapshot(c);
  await waitFor(() => c.calls.capture - a.capture >= 3 && c.calls.sv - a.sv >= 3 && JSON.stringify(bellIds(c.addons)) !== JSON.stringify(a.bells), 3000,
    'the capture check, the SavedVariables poll and the alive bells running');
  assert.equal(c.calls.check - a.check, 0, 'no process list while the game is known to run');
  // It exits: the minute's linger (the logout's SavedVariables, the recap), then nothing.
  c.bridge.onGame({ state: 'exited', pid: 4242 });
  assert.deepEqual([c.bridge.status().game.state, c.bridge.status().game.working], ['down', true], 'lingering');
  const l0 = c.calls.sv;
  await waitFor(() => c.calls.sv - l0 >= 2, 3000, 'still polling SavedVariables during the linger');
  assert.equal(c.bridge.status().game.working, true, 'polled during the linger, not after it');
  await waitFor(() => !c.bridge.status().game.working, 3000, 'the linger over');
  assert.deepEqual(c.said.map(s => s.state), ['down', 'up', 'down']);
  assert.equal(c.said[2].lingerMs, 600);
  await settle(c);
  assert.ok(allBells(c.addons), 'no bell left mid-pulse');
  const d = snapshot(c);
  await sleep(250);
  const e = snapshot(c);
  assert.equal(e.capture - d.capture, 0);
  assert.deepEqual(e.bells, d.bells);
});

test('a strip read off the screen means the game runs, whatever the process list says; a process list that finds it starts the work too', async (t) => {
  const HELLO = encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.5.3', build: '70009', iface: '16001', n: 0, ctx: 0, sig: 'ok', slots: 3 } });
  // The start's check is on its way (slow here) when the strip is read: its "not running" is overruled.
  const c = core({ checkDelayMs: 150 });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  c.bridge.handlePayload(HELLO, 'strip');
  assert.equal(c.bridge.status().game.state, 'up');
  assert.deepEqual(c.said, [{ state: 'up', why: 'strip' }]);
  await sleep(300);
  assert.equal(c.bridge.status().game.state, 'up', 'the process list\'s late "not running" doesn\'t win over a strip just read');
  assert.equal(c.calls.check, 1, 'and it isn\'t asked again while the game runs');
  // A record from SavedVariables (a reload's, read at the slow check) isn't proof the game runs now.
  const d = core();
  d.bridge.start();
  t.after(() => d.bridge.stop());
  await waitFor(() => d.bridge.status().game?.state === 'down', 2000, 'closed');
  d.bridge.handlePayload(HELLO, 'reload');
  assert.equal(d.bridge.status().game.state, 'down');
  // The process list finds the game (Screen Reading off, WoW started): the work starts.
  d.world.running = true;
  await waitFor(() => d.bridge.status().game.state === 'up', 2000, 'the slow check to find the game');
  assert.deepEqual(d.said.at(-1), { state: 'up', why: 'check' });
});

test('no capture helper: a game the process list found is followed by its pid, so its exit ends the work (after the linger) with no process list while it runs', async (t) => {
  const { spawn } = await import('node:child_process');
  const wowStandIn = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => { try { wowStandIn.kill(); } catch { /* gone */ } });
  await waitFor(() => Number.isInteger(wowStandIn.pid), 2000, 'the stand-in game');
  const c = core({ running: true, pids: [wowStandIn.pid] });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  await waitFor(() => c.bridge.status().game?.state === 'up', 2000, 'the process list finds the game');
  assert.deepEqual(c.said, [{ state: 'up', why: 'check' }]);
  assert.equal(c.bridge.status().companion.gamePid, wowStandIn.pid, 'its pid is followed (the app reads "running" from it too)');
  await sleep(200);
  assert.equal(c.calls.check, 1, 'no process list while it runs: the pid check is enough');
  // The game quits: the pid check sees it gone, the work lingers (the logout's SavedVariables), then stops.
  c.world.running = false;
  const gone = new Promise(r => wowStandIn.once('exit', r));
  wowStandIn.kill();
  await gone;
  await waitFor(() => c.bridge.status().game.state === 'down', 2000, 'the exit seen by the pid check');
  assert.deepEqual(c.said.at(-1), { state: 'down', why: 'exited', lingerMs: 200 });
  assert.equal(c.bridge.status().companion.gamePid, null);
  await waitFor(() => !c.bridge.status().game.working, 2000, 'the linger over');
  // Back to the slow check, which asks the process list again.
  await waitFor(() => c.calls.check >= 2, 2000, 'the slow check asks again');
  assert.equal(c.bridge.status().game.state, 'down');
});

test('a capture helper that reports the game: nothing asks the process list, not even at the start; the slow check reads SavedVariables alone (a reload\'s messages, whatever the helper says)', async (t) => {
  const c = core({ helper: true, reported: true });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  assert.equal(c.bridge.status().game.state, 'unknown', 'waiting for the helper\'s word, working meanwhile');
  assert.equal(c.bridge.status().game.working, true);
  c.bridge.onGame({ state: 'absent' }); // the helper's first line with the game closed
  assert.deepEqual([c.bridge.status().game.state, c.bridge.status().game.working, c.bridge.status().game.helper], ['down', false, true]);
  await settle(c);
  const a = snapshot(c);
  const t0 = Date.now();
  await waitFor(() => c.calls.sv - a.sv >= 3, 5000, 'three slow checks');
  const b = snapshot(c);
  const elapsed = Date.now() - t0;
  assert.equal(b.check, 0, 'no process list at all');
  assert.ok(b.sv - a.sv <= atMostSlowChecks(elapsed), `the SavedVariables stat only, at the slow check's pace: ${b.sv - a.sv} in ${elapsed} ms`);
  assert.equal(b.capture - a.capture, 0);
  assert.deepEqual(b.bells, a.bells);
  // A helper that never says leaves the core as it always was: working.
  const quiet = core({ helper: true, reported: false });
  quiet.bridge.start();
  t.after(() => quiet.bridge.stop());
  await sleep(150);
  assert.deepEqual([quiet.bridge.status().game.state, quiet.bridge.status().game.working, quiet.calls.check], ['unknown', true, 0]);
});

test('without the gate (a host that doesn\'t ask for it) everything runs from the start, as before, and the status has no game', async (t) => {
  const c = core({ gate: false });
  c.bridge.start();
  t.after(() => c.bridge.stop());
  const a = snapshot(c);
  await waitFor(() => c.calls.capture - a.capture >= 3 && c.calls.sv - a.sv >= 3 && JSON.stringify(bellIds(c.addons)) !== JSON.stringify(a.bells), 3000,
    'the capture check, the SavedVariables poll and the alive bells running');
  assert.equal(c.bridge.status().game, undefined);
});

// ---------------------------------------------------------------- boot: the app's own wiring

const NOT_RUNNING = () => ({ status: 1, stdout: '' });
const RUNNING = cmd => (/pgrep$/.test(cmd) || /tasklist/i.test(cmd) ? { status: 0, stdout: process.platform === 'win32' ? '"WowClassicB.exe","5120","Console","1","900,000 K"\r\n' : '5120\n' } : { status: 1, stdout: '' });

async function boot(t, { run = NOT_RUNNING, capture = false, createCapture = null } = {}) {
  const root = tmpDir('bones-idle-boot-');
  const flavorDir = path.join(root, 'wow', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  assert.equal(installAddon({ flavorDir, running: false, slots: 3 }).ok, true);
  const lines = [];
  const b = await bootByok({
    paths: { userData: path.join(root, 'ud') }, home: path.join(root, 'home'), env: {}, log: (k, d) => lines.push([k, d]),
    keystore: createKeyStore({ backend: 'memory' }), config: { wow: { flavorDir }, transport: { slots: 3 }, byok: { provider: 'anthropic' } },
    capture, ...(createCapture ? { createCapture } : {}), egress: false, lockDir: path.join(root, 'locks'),
    backendOptions: { checks: { models: false } }, wow: { run: (cmd, argv, o) => run(cmd, argv, o), roots: [] },
  });
  t.after(() => b.stop());
  return { b, root, flavorDir, addons: path.join(flavorDir, 'Interface', 'AddOns'), lockDir: path.join(root, 'locks'), lines };
}
const lockOf = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('boot (SY-30): with Screen Reading off the app asks the process list; WoW closed, the lock beats every minute and says so (hb 60), WoW running, every 30 s', async (t) => {
  const closed = await boot(t);
  await waitFor(() => closed.b.bridge.status().game?.state === 'down', 3000, 'closed');
  const folder = folderLockFile(closed.addons);
  await waitFor(() => lockOf(folder).hb === IDLE_HEARTBEAT_MS / 1000, 2000, 'the idle beat named in the lock');
  // One lock (code health BR-27): the AddOns folder's, none in the state folder.
  assert.equal(fs.existsSync(lockFileFor(closed.lockDir, closed.addons)), false);
  // The game starts: a strip read; the lock goes back to 30 s.
  closed.b.bridge.onGame({ state: 'launched', pid: 5120 });
  await waitFor(() => lockOf(folder).hb === 30, 2000, 'the running beat');
  const up = await boot(t, { run: RUNNING });
  await waitFor(() => up.b.bridge.status().game?.state === 'up', 3000, 'the process list finds it');
  assert.equal(lockOf(folderLockFile(up.addons)).hb, 30);
});

test('boot (SY-30): with a capture helper the app waits for its word, and the window says "The app looks for WoW when it starts." while WoW is closed, not "can\'t see the game"', async (t) => {
  const made = [];
  const createCapture = (o) => {
    const cap = { o, start() {}, stop() {}, status: () => ({ kind: 'windows-helper', connected: true, running: true, window: null, stats: null, error: cap.error ?? null }) };
    made.push(cap);
    return cap;
  };
  const r = await boot(t, { capture: true, createCapture });
  const cap = made[0];
  assert.equal(r.b.bridge.status().game.state, 'unknown', 'no process list: the helper is on its way');
  assert.ok(!r.lines.some(([k]) => k === 'game-state'));
  // The Windows helper's first scan with the game closed: absent, and window_not_found once.
  cap.o.onGame({ state: 'absent', pid: null });
  cap.error = { kind: 'window_not_found', message: 'x', at: Date.now() };
  cap.o.onError({ kind: 'window_not_found', message: 'x' });
  const st = await r.b.api.status();
  assert.equal(st.capture.state, 'waiting');
  assert.deepEqual([st.view.screen.ok, st.view.screen.headline], [true, 'The app looks for WoW when it starts.']);
  assert.equal(r.b.bridge.status().game.helper, true);
  // It launches and the helper follows it, the window not found yet: the helper's word, never an
  // alarm (the watchdog publishes no state for it, SY-20); the app watches, claiming nothing (DR-06).
  cap.o.onStatus({ connected: true });
  cap.o.onGame({ state: 'launched', pid: 5120 });
  const up = await r.b.api.status();
  assert.deepEqual([up.capture.state, up.view.screen.ok], ['watching', true]);
});

test('tools/bench-idle.mjs (the numbers in docs/VERIFICATION.md, before and after SY-30): the app booted on a closed game, then left alone, runs no timer, touches nothing in AddOns and starts no process', async () => {
  const { spawnSync } = await import('node:child_process');
  const bench = fileURLToPath(new URL('../../tools/bench-idle.mjs', import.meta.url));
  for (const helper of ['report', 'none']) {
    const r = spawnSync(process.execPath, [bench, '--seconds', '3', '--warmup', '2', '--helper', helper], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: tmpDir('bones-bench-home-') } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepEqual([out.helper, out.seconds, out.game?.state, out.game?.working, out.game?.helper], [helper, 3, 'down', false, helper === 'report']);
    // Over 3 s the slow check (every 30 s) and the idle lock beat (every minute) don't come due.
    assert.deepEqual(out.total, { timers: 0, addons: 0, wow: 0, data: 0, spawns: 0 }, `${helper}: ${JSON.stringify(out)}`);
  }
});
