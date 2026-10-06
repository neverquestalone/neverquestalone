// Quitting, and never serving a stopped bridge (fix-102): app/desktop/src/quit.mjs (the quit lifecycle
// main runs) and src/api-loader.mjs createLiveApi (the app API main holds).
//
// 2026-09-30, the owner's app, live: at 06:44:34 UTC a quit began, main's before-quit ran the boot's
// full stop (the egress guard uninstalled) and asked to quit again, and the process lived on with a new
// window until 06:59. Every key test from then on was refused by the stopped guard before it was sent,
// and setup said "Can't reach Anthropic. Check your internet". These tests hold the fix: nothing stops
// at a request, the stop runs only at a committed quit and is followed by the exit, and a bridge that
// stopped while the process lives on starts again at once, so the window never talks to a stopped one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createQuitFlow, QUIT_STOP_MS, QUIT_STALL_MS } from '../../app/desktop/src/quit.mjs';
import { createLiveApi, loadApi, wrapApi, API_METHODS, REBOOT_WAIT_MS } from '../../app/desktop/src/api-loader.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { startMock, reply, manifestsAt, CANARY_KEYS } from './helpers/byok-env.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const tick = () => new Promise(r => setImmediate(r));

/**
 * Electron's app as the quit flow sees it: events whose listeners may call preventDefault; exit()
 * emits 'quit' as Electron's does (its shutdown begins inside app.exit: browser.cc Shutdown).
 */
function fakeApp() {
  const app = new EventEmitter();
  app.exits = [];
  app.exit = (code) => { app.exits.push(code); app.emit('quit', {}, code); };
  app.relaunches = 0;
  app.relaunch = () => { app.relaunches += 1; };
  app.fire = (name) => {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.emit(name, e);
    return e;
  };
  return app;
}

/** Timers the test runs by hand: {setTimeout, clearTimeout, run(ms)}. */
function manualTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++seq; due.set(id, { at: now + ms, fn }); return { id, unref() {} }; },
    clearTimeout(h) { if (h) due.delete(h.id); },
    async run(ms) {
      now += ms;
      for (const [id, d] of [...due].sort((a, b) => a[1].at - b[1].at)) {
        if (d.at <= now && due.has(id)) { due.delete(id); d.fn(); }
      }
      await tick();
    },
  };
}

function flow(extra = {}) {
  const app = fakeApp();
  const timers = manualTimers();
  const lines = [];
  const calls = [];
  const q = createQuitFlow({
    app, timers, now: timers.now, log: l => lines.push(l),
    stop: async () => { calls.push('stop'); },
    onCommit: () => calls.push('commit'),
    beforeExit: () => calls.push('beforeExit'),
    ...extra,
  });
  return { app, timers, lines, calls, q };
}

test('quit (fix-102): before-quit is only a request: nothing stops, the log says quit-requested, and a request never committed is quit-stalled and forgotten', async () => {
  const { app, timers, lines, calls, q } = flow();
  const e = app.fire('before-quit');
  assert.equal(e.defaultPrevented, false, 'the request goes on to close the windows');
  assert.deepEqual(calls, [], 'nothing stops at a request');
  assert.deepEqual(lines, ['quit-requested']);
  assert.equal(q.state(), 'requested');
  app.fire('before-quit');
  assert.deepEqual(lines, ['quit-requested'], 'once per request');
  // The quit is called off (a window stayed open): the app runs on, whole.
  await timers.run(QUIT_STALL_MS);
  assert.equal(q.state(), 'running');
  assert.match(lines[1], /^quit-stalled \(requested 10 s ago and never committed: .*the bridge kept running\)$/);
  assert.deepEqual(calls, [], 'still nothing stopped');
  assert.deepEqual(app.exits, []);
  // A later quit starts over.
  app.fire('before-quit');
  assert.equal(lines.at(-1), 'quit-requested');
});

test('quit (fix-102): will-quit commits: preventDefault, quit-committed, onCommit, the stop awaited, beforeExit, then exit(0); a second will-quit does nothing', async () => {
  let release;
  const order = [];
  const { app, timers, lines, q } = flow({
    onCommit: () => order.push('commit'),
    stop: () => { order.push('stop'); return new Promise(r => { release = r; }); },
    beforeExit: () => order.push('beforeExit'),
  });
  app.exit = code => order.push(`exit ${code}`);
  app.fire('before-quit');
  const e = app.fire('will-quit');
  assert.equal(e.defaultPrevented, true, 'the quit waits for the stop');
  assert.equal(q.committed(), true);
  assert.deepEqual(lines, ['quit-requested', 'quit-committed']);
  await tick();
  assert.deepEqual(order, ['commit', 'stop'], 'no exit before the stop ends');
  const again = app.fire('will-quit');
  assert.equal(again.defaultPrevented, false, 'app.exit emits no will-quit, and a stray one is let through');
  release();
  await tick();
  await tick();
  assert.deepEqual(order, ['commit', 'stop', 'beforeExit', 'exit 0']);
  assert.match(lines.at(-1), /^quit: the bridge stopped in \d/);
  await timers.run(1);
  assert.equal(q.committed(), true);
});

test('quit (fix-102): a stop that runs over the bound is quit-stalled, and the app quits anyway; a stop that throws still exits', async () => {
  const slow = flow({ stop: () => new Promise(() => {}) });
  slow.app.fire('before-quit');
  slow.app.fire('will-quit');
  await tick();
  assert.deepEqual(slow.app.exits, []);
  await slow.timers.run(QUIT_STOP_MS);
  await tick();
  assert.deepEqual(slow.app.exits, [0]);
  assert.ok(slow.lines.some(l => /^quit-stalled \(the bridge took over 3 s to stop; quitting anyway\)$/.test(l)), slow.lines.join(' | '));
  assert.deepEqual(slow.calls, ['commit', 'beforeExit']);

  const bad = flow({ stop: async () => { throw new Error('boom'); } });
  bad.app.fire('will-quit');
  await tick();
  await tick();
  assert.deepEqual(bad.app.exits, [0]);
  assert.ok(bad.lines.some(l => l === "quit: the bridge's stop failed: boom"));
});

test('quit (quit-race): still running 5 s after an exit that began, the quit stays committed: the line says it is still ending, nothing comes back, and a launch then opens no window', async () => {
  const { app, timers, lines, calls, q } = flow();
  app.fire('will-quit');
  await tick();
  await tick();
  assert.deepEqual(app.exits, [0]);
  // Electron's exit began ('quit'), and the process runs on: a busy Windows PC (CI run 37107199251).
  await timers.run(5000);
  assert.deepEqual(calls, ['commit', 'stop', 'beforeExit'], 'nothing more: no hook brings the bridge or the tray back');
  assert.equal(q.state(), 'committed', 'never back to running in a process that is ending');
  assert.equal(lines.at(-1), 'quit: still ending 5 s after exit (the exit began; nothing starts again)');
  assert.ok(!lines.some(l => l.startsWith('quit-stalled')), lines.join(' | '));
  assert.equal(q.reopen(), true, 'a launch now still opens no window: the quit takes it');
  assert.deepEqual(app.exits, [0], 'asked once');
});

test('quit (quit-race): an exit that never began (no quit event; never seen) is quit-stalled and asked again, and still nothing comes back', async () => {
  const { app, timers, lines, calls, q } = flow();
  app.exit = code => app.exits.push(code); // no 'quit': Electron's shutdown never began
  app.fire('will-quit');
  await tick();
  await tick();
  await timers.run(5000);
  assert.deepEqual(app.exits, [0, 0]);
  assert.equal(lines.at(-1), "quit-stalled (the exit hadn't begun 5 s after exit; asking again)");
  assert.equal(q.committed(), true);
  assert.deepEqual(calls, ['commit', 'stop', 'beforeExit']);
});

test('quit (SY-102-3): a launch during the committed quit relaunches once, so the exiting app comes back; before the commit it opens the window as ever', async () => {
  let release;
  const { app, lines, q } = flow({ stop: () => new Promise(r => { release = r; }) });
  assert.equal(q.reopen(), false, 'running: the launch opens the window');
  app.fire('before-quit');
  assert.equal(q.reopen(), false, 'requested: nothing is committed yet, the window may still open');
  assert.equal(app.relaunches, 0);
  app.fire('will-quit');
  await tick();
  // The owner's case: Cmd+Q, then NeverQuestAlone opened again 1.8 s later, while the bridge stopped.
  assert.equal(q.reopen(), true, 'committed: the quit takes the launch (no window opens)');
  assert.equal(app.relaunches, 1, 'app.relaunch(): the exit under way starts the app again');
  assert.equal(lines.at(-1), 'quit: reopened during the quit');
  assert.equal(q.reopen(), true);
  assert.equal(app.relaunches, 1, 'once: Electron would start a copy for every call');
  assert.equal(lines.at(-1), 'quit: reopened during the quit (it reopens already)');
  release();
  await tick();
  await tick();
  assert.deepEqual(app.exits, [0], 'the quit still ends: the relaunch happens at the exit');
});

test('quit (SY-102-3): Quit and reopen and a launch during its quit are one relaunch; an update that installs at this quit is never relaunched over', () => {
  const both = flow();
  assert.equal(both.q.relaunchOnce(), true, 'Quit and reopen asks first');
  both.app.fire('before-quit');
  both.app.fire('will-quit');
  assert.equal(both.q.reopen(), true);
  assert.equal(both.app.relaunches, 1, 'one copy comes back, not two');
  assert.equal(both.lines.at(-1), 'quit: reopened during the quit (it reopens already)');
  assert.equal(both.q.relaunchOnce(), false);

  const update = flow({ canRelaunch: () => false });
  update.app.fire('will-quit');
  assert.equal(update.q.reopen(), true, 'still no window: the quit is committed');
  assert.equal(update.app.relaunches, 0, 'its installer replaces the app as it exits');
  assert.equal(update.lines.at(-1), 'quit: reopened during the quit (an update installs at this quit, so it stays closed)');

  const broken = flow({ relaunch: () => { throw new Error('no relauncher'); } });
  broken.app.fire('will-quit');
  assert.equal(broken.q.reopen(), true);
  assert.ok(broken.lines.includes('quit: the relaunch failed: no relauncher'), broken.lines.join(' | '));
  assert.ok(!broken.lines.includes('quit: reopened during the quit'));
});

test('quit (fix-102): main wires it: no stop in before-quit, the tray goes and the holder commits at will-quit, no window opens once committed', () => {
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /import \{ createQuitFlow \} from '\.\/src\/quit\.mjs';/);
  assert.doesNotMatch(main, /app\.on\('before-quit'/, 'before-quit is the flow\'s alone, and it stops nothing');
  assert.doesNotMatch(main, /app\.on\('will-quit'/);
  const flowSrc = /const quit = createQuitFlow\(\{([\s\S]*?)\n\}\);/.exec(main)?.[1] ?? '';
  assert.match(flowSrc, /onCommit: \(\) => \{\s*live\?\.commit\(\);[\s\S]*?tray\?\.destroy\(\)/);
  assert.match(flowSrc, /stop: \(\) => api\?\.stop\?\.\(\)/);
  assert.match(flowSrc, /removeTargets\(uninstallTargets\(/, 'the uninstall\'s removal waits for the stop');
  // quit-race: still running after exit, nothing comes back; main never asks the holder to boot again.
  assert.doesNotMatch(flowSrc, /onExitFailed/);
  assert.doesNotMatch(main, /\.reboot\(/);
  assert.match(main, /live = createLiveApi\(\{\s*boot: [^\n]*\n\s*log: holderLog,/, 'a self-test says a start after the commit (scripts/self-test.mjs fails it)');
  assert.match(main, /function openWindow\(page\) \{\n[^\n]*\n  if \(quit\.committed\(\)\) return null;/);
  assert.match(main, /live = createLiveApi\(\{\s*boot: \(\) => loadApi\(/);
  assert.match(main, /api = SELF_TEST \? withHostileRequest\(live\.api\) : live\.api;/);
  // SY-102-3: a second launch and macOS's reopen go to the flow first; Quit and reopen is its one relaunch.
  assert.match(main, /app\.on\('second-instance', launchedAgain\);\n  app\.on\('activate', launchedAgain\);/);
  assert.match(main, /function launchedAgain\(\) \{\n  if \(quit\.reopen\(\)\) return;\n  openWindow\(\);\n\}/);
  assert.match(main, /function relaunch\(\) \{\n  if \(HEADLESS && !NO_RELAUNCH\) return \{ ok: true \};\n  quit\.relaunchOnce\(\);\n  setImmediate\(\(\) => app\.quit\(\)\);/);
  assert.equal((main.match(/app\.relaunch\(/g) ?? []).length, 1, 'one call of app.relaunch, the flow\'s');
  assert.match(flowSrc, /relaunch: NO_RELAUNCH \? \(\) => quitLog\('relaunch: skipped \(--no-relaunch\)'\) : relaunchApp,/, 'the self-test\'s relaunch run skips it (SY-102-2)');
  assert.match(flowSrc, /canRelaunch: \(\) => updater\?\.status\?\.\(\)\?\.state !== 'ready',/);
  assert.match(main, /app\.relaunch\(\{ args: process\.argv\.slice\(1\)\.filter\(a => a !== '--hidden'\) \}\);/, 'a relaunch the player asked for opens the window');
  // The quit's own lines, from the flow: quit-requested, quit-committed, quit-stalled.
  const src = fs.readFileSync(path.join(APP, 'src', 'quit.mjs'), 'utf8');
  for (const w of ["log('quit-requested')", "log('quit-committed')", 'log(`quit-stalled (']) assert.ok(src.includes(w), w);
});

// ---------------------------------------------------------------------------
// The holder (createLiveApi).

/** A boot as loadApi returns one: a wrapped API that records calls and whether it was stopped. */
function fakeBoot(n, record) {
  const listeners = new Set();
  const api = {
    stopped: false,
    async status() { record.push(`status@${n}`); return { n, stopped: api.stopped }; },
    async testStagedKey() { record.push(`test@${n}`); return api.stopped ? { ok: false, error: 'restart' } : { ok: true, n }; },
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    push(s) { for (const cb of listeners) cb(s); },
    listeners,
    async stop() { record.push(`stop@${n}`); api.stopped = true; },
  };
  return { api: wrapApi(api, { stop: () => api.stop() }), raw: api, mode: 'real', reason: null };
}

function holder() {
  const record = [];
  const boots = [];
  const lines = [];
  const seen = [];
  const live = createLiveApi({
    boot: async () => { const b = fakeBoot(boots.length + 1, record); boots.push(b); return b; },
    log: l => lines.push(l),
    onBoot: l => seen.push(l),
  });
  return { live, record, boots, lines, seen };
}

test('live API (fix-102): every contract call goes to the current boot; onBoot hears it', async () => {
  const { live, boots, seen } = holder();
  await live.start();
  assert.equal(boots.length, 1);
  assert.equal(seen[0], boots[0]);
  for (const m of API_METHODS) assert.equal(typeof live.api[m], 'function', m);
  assert.deepEqual(await live.api.status(), { n: 1, stopped: false });
  assert.deepEqual(await live.api.providers(), { ok: false, error: 'unsupported' }, 'a call the boot lacks, as wrapApi says');
});

test('live API (fix-102): a boot stopped with no quit committed starts again at once; a call meanwhile waits and goes to the new boot, never the stopped one; the listeners move', async () => {
  const { live, record, boots, lines } = holder();
  await live.start();
  const heard = [];
  live.api.onChange(s => heard.push(s));
  boots[0].raw.push('one');
  await live.stop();
  const r = await live.api.testStagedKey('anthropic');
  assert.deepEqual(r, { ok: true, n: 2 }, 'the new boot answered');
  assert.equal(boots.length, 2);
  assert.equal(boots[0].raw.stopped, true);
  assert.equal(boots[1].raw.stopped, false);
  assert.ok(!record.includes('test@1'), 'the stopped boot was never asked');
  assert.ok(lines.some(l => /^the bridge starts again \(it stopped with no quit committed\)$/.test(l)), lines.join(' | '));
  await tick();
  // The new boot's status went out at once: the tray and the window stop showing the stopped one's.
  assert.deepEqual(heard, ['one', { n: 2, stopped: false }]);
  boots[0].raw.push('old');
  boots[1].raw.push('two');
  assert.deepEqual(heard, ['one', { n: 2, stopped: false }, 'two'], 'listeners follow the current boot only');
  assert.equal(boots[0].raw.listeners.size, 0, 'the old boot lost its listener');
});

test('live API (fix-102, quit-race): a committed quit stops the boot for good: calls answer quitting, nothing starts again, and reboot() boots nothing either (a commit is final)', async () => {
  const { live, boots, record, lines } = holder();
  await live.start();
  live.commit();
  await live.stop();
  await live.stop();
  assert.equal(record.filter(x => x === 'stop@1').length, 1, 'twice is once');
  assert.deepEqual(await live.api.testStagedKey('anthropic'), { ok: false, error: 'quitting' });
  assert.equal(boots.length, 1, 'a committed quit boots nothing');
  assert.equal(live.stopped(), true);
  // What main's onExitFailed asked when an exit was only slow (CI run 37107199251): nothing boots.
  assert.equal(await live.reboot('the quit didn’t end the process'), null);
  assert.equal(boots.length, 1);
  assert.ok(lines.includes('the bridge stays stopped: the quit is committed (the quit didn’t end the process)'), lines.join(' | '));
  assert.ok(!lines.some(l => l.startsWith('the bridge starts again')), lines.join(' | '));
  assert.deepEqual(await live.api.testStagedKey('anthropic'), { ok: false, error: 'quitting' });
  assert.equal(live.stopped(), true);
});

/** A holder whose first boot's stop runs until release() (a stop that outran the quit's 3 s bound). */
function slowStopHolder(extra = {}) {
  const record = [];
  const boots = [];
  const lines = [];
  let release = null;
  const live = createLiveApi({
    boot: async () => {
      const n = boots.length + 1;
      record.push(`boot@${n}`);
      const b = fakeBoot(n, record);
      if (n === 1) b.raw.stop = () => { record.push('stop@1'); return new Promise((r) => { release = () => { record.push('stopped@1'); b.raw.stopped = true; r(); }; }); };
      boots.push(b);
      return b;
    },
    log: l => lines.push(l),
    ...extra,
  });
  return { live, record, boots, lines, release: () => release() };
}

test('live API (SY-102-7): a reboot asked while the old boot still stops waits for that stop to end, so its lock release can\'t take the new boot\'s lock (same pid)', async () => {
  const { live, record, boots, release } = slowStopHolder();
  await live.start();
  const quitStop = live.stop(); // no quit committed: the process lives on
  await tick();
  const again = live.reboot('asked');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(record, ['boot@1', 'stop@1'], 'no new boot while the old stop runs');
  const call = live.api.testStagedKey('anthropic');
  await tick();
  assert.equal(boots.length, 1, 'a call waits for the reboot too');
  release();
  await again;
  await quitStop;
  assert.deepEqual(await call, { ok: true, n: 2 }, 'the call went to the new boot');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(record.slice(0, 4), ['boot@1', 'stop@1', 'stopped@1', 'boot@2'], 'the old stop ended before the new boot began');
  assert.equal(boots.length, 2, 'one new boot: the old stop ending reboots nothing more');
  assert.ok(!record.includes('stop@2'));
  assert.equal(live.current(), boots[1]);
});

test('live API (SY-102-7): the wait is bounded: a stop that never ends is said, the bridge starts again after waitMs, and when it ends later it stops nothing new', async () => {
  const timers = manualTimers();
  const { live, record, boots, lines, release } = slowStopHolder({ timers, waitMs: REBOOT_WAIT_MS });
  await live.start();
  const quitStop = live.stop(); // no quit committed
  await tick();
  const again = live.reboot('asked');
  await tick();
  assert.equal(boots.length, 1);
  await timers.run(REBOOT_WAIT_MS - 1);
  assert.equal(boots.length, 1, 'still waiting');
  await timers.run(1);
  await again;
  assert.equal(boots.length, 2);
  assert.ok(lines.includes('the old bridge was still stopping after 10 s; the bridge starts again anyway'), lines.join(' | '));
  release();
  await quitStop;
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(boots.length, 2, 'a stop that ends after a newer boot was adopted reboots nothing');
  assert.ok(!record.includes('stop@2'));
  assert.equal(live.stopped(), false);
});

test('live API (SY-102-7): a call during a stop with no quit committed waits for that stop, then one new boot serves it (never a second stop and a third boot)', async () => {
  const { live, record, boots, release } = slowStopHolder();
  await live.start();
  const stopping = live.stop();
  await tick();
  const call = live.api.testStagedKey('anthropic');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(boots.length, 1, 'no boot beside a stop that still runs');
  release();
  await stopping;
  assert.deepEqual(await call, { ok: true, n: 2 });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(boots.length, 2);
  assert.ok(!record.includes('stop@2'), record.join(' '));
});

test('quit-race (CI run 37107199251): Quit and reopen, a second launch during the committed quit, then an exit that ends slowly: the exiting process never boots the bridge again and opens no window; the one relaunch is the way back', async () => {
  // The holder and the flow wired as main.mjs wires them: the commit is the holder's, the stop the app API's.
  const { live, boots, lines: holderLines } = holder();
  await live.start();
  const app = fakeApp();
  const timers = manualTimers();
  const lines = [];
  const q = createQuitFlow({
    app, timers, now: timers.now, log: l => lines.push(l),
    onCommit: () => live.commit(),
    stop: () => live.api.stop(),
    relaunch: () => lines.push('relaunch: skipped (--no-relaunch)'), // the self-test's relaunch run
  });
  // Quit and reopen (main.mjs relaunch()): the flow's one relaunch, then app.quit().
  assert.equal(q.relaunchOnce(), true);
  app.fire('before-quit');
  app.fire('will-quit');
  // The second launch (on Windows, second-instance), while the bridge stops.
  assert.equal(q.reopen(), true, 'the quit takes the launch');
  for (let i = 0; i < 5; i++) await tick();
  assert.deepEqual(app.exits, [0]);
  assert.equal(boots[0].raw.stopped, true);
  // Electron's exit began ('quit') and the process ran on past 5 s: CI's updated app on a busy runner.
  await timers.run(5000);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(q.committed(), true, 'the quit stays committed');
  assert.equal(q.reopen(), true, 'a launch now still opens no window in the ending process');
  assert.deepEqual(await live.api.status(), { ok: false, error: 'quitting' }, 'a late call boots nothing');
  // Whatever asks the holder now (main's onExitFailed did, then the tray came back): nothing boots.
  assert.equal(await live.reboot('the quit didn’t end the process'), null);
  assert.equal(boots.length, 1, 'one boot, stopped for good');
  assert.ok(!holderLines.some(l => l.startsWith('the bridge starts again')), holderLines.join(' | '));
  assert.ok(!lines.some(l => l.startsWith('quit-stalled')), lines.join(' | '));
  assert.ok(lines.includes('quit: still ending 5 s after exit (the exit began; nothing starts again)'), lines.join(' | '));
  assert.deepEqual(lines.filter(l => l.startsWith('relaunch:')), ['relaunch: skipped (--no-relaunch)'], 'one relaunch: the way back');
});

test('quit-race: a quit committed while a reboot waits for the old boot\'s stop boots nothing when that stop ends (a commit is final)', async () => {
  const { live, record, boots, lines, release } = slowStopHolder();
  await live.start();
  const oldStop = live.stop(); // no quit committed: it would boot again when it ends
  await tick();
  const call = live.api.testStagedKey('anthropic'); // waits for that reboot
  await tick();
  live.commit(); // the player quits meanwhile
  await live.stop(); // the quit's stop: nothing new to stop
  release();
  await oldStop;
  assert.deepEqual(await call, { ok: false, error: 'quitting' }, 'the call never reached a new boot');
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(boots.length, 1, 'nothing booted after the commit');
  assert.deepEqual(record, ['boot@1', 'stop@1', 'stopped@1']);
  assert.ok(lines.some(l => l.startsWith('the bridge stays stopped: the quit is committed')), lines.join(' | '));
  assert.ok(!lines.some(l => l.startsWith('the bridge starts again')), lines.join(' | '));
});

test('live API (fix-102), the owner\'s case on the real bridge: its boot stopped while the app ran on; the next key test goes to a new boot and reaches the AI, never a stopped guard', async (t) => {
  const mock = await startMock(r => (r.method === 'GET' ? { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: [{ id: 'claude-haiku-4-5' }] }) } : reply('ok', { input: 5, output: 1 })));
  t.after(() => mock.close());
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-quit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keystore = createKeyStore({ backend: 'memory' });
  await keystore.set('anthropic', CANARY_KEYS.anthropic);
  const lines = [];
  const log = l => lines.push(String(l));
  const bootOptions = () => ({
    keystore, manifests: manifestsAt(mock.url),
    config: { wow: { flavorDir: path.join(root, 'no-wow') }, transport: { slots: 3 }, byok: { provider: 'anthropic', terms: { anthropic: { at: 1, v: 1 } } } },
    configFile: path.join(root, 'ud', 'config.json'), home: path.join(root, 'home'), env: {},
    egress: true, capture: false, lockDir: path.join(root, 'locks'),
    wow: { run: () => ({ status: 1, stdout: '' }), roots: [] }, backendOptions: { checks: { models: false } },
  });
  const paths = { userData: path.join(root, 'ud'), state: path.join(root, 'ud', 'bridge'), logs: path.join(root, 'logs'), version: '0.1.0-test' };
  const live = createLiveApi({ boot: () => loadApi({ appDir: APP, paths, log, bootOptions: bootOptions() }), log });
  const first = await live.start();
  t.after(async () => { live.commit(); await live.stop(); });
  assert.equal(first.mode, 'real', JSON.stringify(first.reason));
  const key = async () => CANARY_KEYS.anthropic;
  assert.equal((await live.api.testStagedKey('anthropic', key, { context: 'setup' })).ok, true);
  // The stop the old before-quit ran, with the process living on.
  await first.api.stop();
  const stale = await first.api.testStagedKey('anthropic', key, { context: 'setup' });
  assert.equal(stale.error, 'restart', 'a stopped boot on its own says restart, never network');
  await live.stop();
  const again = await live.api.testStagedKey('anthropic', key, { context: 'setup' });
  assert.equal(again.ok, true, `the holder's next call reached the AI through a new boot: ${JSON.stringify(again)}`);
  assert.notEqual(live.current(), first);
  assert.equal((await live.api.status()).backend.rt.state !== 'not_running', true);
  assert.ok(lines.some(l => l.startsWith('the bridge starts again')), lines.join('\n'));
});
