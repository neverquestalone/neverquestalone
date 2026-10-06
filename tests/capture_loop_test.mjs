// The capture loop end to end (display design rev 5, Layer 5 §4; DR-04, SY-01, SY-20): the real public
// addon in the fengari VM against a bridge built by bootByok, so boot's wiring is under test too, with a
// temp WoW folder (the addon installed as the app installs it, 200 slots), a memory key store and a stand-in
// capture helper. The stand-in hands the VM's strip to the core only while it's "readable", and sends
// stats, window, connection and restart events as a helper does; nothing mocks the delivery path: the
// slots and SavedVariables are real files the VM and the core read.
//   H1: the 00:23Z incident: blind with frames, a message sent and stuck, the Reload writes SavedVariables
//       after the attach, R4' (one restart, no_signal rung), the new session's hello read, ok.
//   H2: a helper restart publishes and rings nothing.
// The addon says mode= in its hello (SY-03's report). With display P0's addon half (DR-07, DR-08):
//   H1 also shows the stuck line's Reload at 15 s of the strip on screen, before the player's Reload;
//   H15a: the self-probe's seen clears a published no_signal once capture reads again (R6);
//   H8b: a mid-session switch to stream (its mode seen by the strip and the outbox) and that session's
//        Reload raise no R4'; SY-17b: the same switch while the strip is blind (the seen only in the
//        outbox, read with the record in the same write) raises none either.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootByok } from '../bridge/byok/boot.mjs';
import { installAddon } from '../bridge/byok/wow.mjs';
import { createKeyStore } from '../bridge/byok/security/keystore.mjs';
import { slotName } from '../bridge/transport/slots.mjs';
import { parseRecord } from '../bridge/transport/records.mjs';
import { waitFor, sleep, tmpDir, NO_CHECKS } from './byok/helpers/byok-env.mjs';
import { coveredCornerScenario, standInScene } from './byok/helpers/covered-corner.mjs';

const require = createRequire(import.meta.url);
const { newVM, reloadVM } = require('./helpers/nqa-vm.js');
const { PUBLIC } = require('./helpers/byok-slots.js');

const NOT_RUNNING = () => ({ status: 1, stdout: '' });

/** A capture helper stand-in: what boot gave it, its restarts, and a strip it reads only while readable. */
function standIn() {
  const h = { o: null, readable: true, restarts: [], fed: null, kind: 'mac-app' };
  h.make = (o) => {
    h.o = o;
    return {
      kind: h.kind,
      start() {}, stop() {},
      restart(reason) { h.restarts.push(reason); return true; },
      retryNow() { return false; },
      status: () => ({ kind: h.kind, connected: true, permission: true }),
    };
  };
  /**
   * The helper starts: connected, the game, the window (an attach). The game's pid is a live one (this
   * process): the core also asks the OS about it every 10 s (checkGamePid), and a made-up pid is an
   * exited game, which ends the attach R4' judges, once a loaded runner takes 10 s to get there.
   */
  h.up = (pid = process.pid) => {
    h.o.onStatus({ connected: true });
    h.o.onGame({ state: 'running', pid });
    h.o.onStatus({ permission: true });
    h.o.onStatus({ window: { pid, scale: 2, widthPt: 1728, heightPt: 1117 } });
  };
  h.stats = (frames, decoded) => h.o.onStatus({ stats: { interval: { frames, decoded, rejected: 0 }, attached: true, hidden: false, asleep: false, locked: false, onScreen: true } });
  /** What the addon draws now reaches the core, once per payload, if the helper can read it. */
  h.read = (vm) => {
    const s = vm.strip();
    if (!s || !h.readable || s.payload === h.fed) return false;
    h.fed = s.payload;
    h.o.onPayload({ id: s.frame, text: s.payload });
    return true;
  };
  return h;
}

// The addon's next slots as they are on disk now, for its next loads to read as the game would.
function offerSlots(vm, addons) {
  const next = vm.num('NS.R.slots.nextIndex');
  const files = [];
  for (let i = next; i <= Math.min(200, next + 3); i++) {
    const text = fs.readFileSync(path.join(addons, slotName(i), 'Inbox.lua'), 'utf8');
    files.push(`SLOTS[${JSON.stringify(slotName(i))}] = function()\n${text}\nend`);
  }
  vm.run(`SLOTS = {}\n${files.join('\n')}\nSTUB.onLoadAddOn = function(name) if SLOTS[name] then SLOTS[name]() end end`);
}
// The addon hears a push ring and loads its next slot: the file on disk, as the game reads it.
function ringAndLoad(vm, addons) {
  vm.advance(1.6);
  offerSlots(vm, addons);
  const bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false); vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true); vm.run('NS.Transport.Poll()');
  vm.advance(0.3);
}
// The hello's answer on disk and rung (code health BR-04, the 1.4.1 revert): the bridge's slot worker
// writes it a moment after the hello is heard, and rings once it's on disk; the addon loads a slot only
// on a ring. So the test's ring (ringAndLoad) waits for that: the slot the addon loads next holds its
// session's nonce, and nothing is being written (the bridge rang). A fixed 40 ms was enough only while
// the write held the bridge's thread.
function answered(b, vm, addons) {
  const nonce = vm.evaluate('NS.R.nonce');
  const file = path.join(addons, slotName(vm.num('NS.R.slots.nextIndex')), 'Inbox.lua');
  const there = () => { try { return fs.readFileSync(file, 'utf8').includes(`nonce = "${nonce}"`); } catch { return false; } };
  return waitFor(() => there() && !b.bridge.publisher.writing(), 5000, 'the hello\'s answer on disk, rung');
}
/** The game's /reload: it writes SavedVariables (db.outbox among them), in the game's own layout. */
function writeSavedVariables(flavorDir, vm) {
  const dir = path.join(flavorDir, 'WTF', 'Account', 'TESTACCOUNT', 'SavedVariables');
  fs.mkdirSync(dir, { recursive: true });
  const out = vm.outboxWires();
  const entries = out.map(e => `\t\t{\n\t\t\t["key"] = "${e.key}",\n\t\t\t["hex"] = "${Buffer.from(e.wire, 'utf8').toString('hex')}",\n\t\t},\n`).join('');
  fs.writeFileSync(path.join(dir, 'NeverQuestAlone.lua'), `NQADB = {\n\t["token"] = "${vm.evaluate('NQADB.token')}",\n\t["outbox"] = {\n${entries}\t},\n}\n`);
  return out;
}

async function loop(t) {
  const root = tmpDir('bones-loop-');
  const flavorDir = path.join(root, 'wow', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  const inst = installAddon({ flavorDir, running: false });
  assert.equal(inst.ok, true, JSON.stringify(inst.steps));
  const addons = inst.addonsDir;
  const helper = standIn();
  // The game first: making the VM can take seconds on a loaded runner, which the bridge's real clock
  // would count against its first ring.
  const vm = newVM({ extra: PUBLIC }).login();
  const b = await bootByok({
    paths: { userData: path.join(root, 'ud') }, home: path.join(root, 'home'), env: {}, log: () => {},
    keystore: createKeyStore({ backend: 'memory' }),
    config: { wow: { flavorDir }, byok: { provider: 'anthropic' } },
    capture: true, createCapture: helper.make, lockDir: path.join(root, 'locks'), egress: false,
    wow: { run: NOT_RUNNING, roots: [] }, backendOptions: NO_CHECKS,
    signalTimings: { pulseMs: { push: 20, alive: 20, act: 5 }, actGapMs: 5 },
  });
  t.after(() => b.stop());
  assert.ok(b.bridge, 'the bridge runs for the folder');
  return { root, flavorDir, addons, helper, vm, b };
}

const capOf = vm => vm.json('NS.R.bridge and NS.R.bridge.capture');
const stripTypes = vm => vm.stripWires().map(w => parseRecord(w)).filter(r => r.ok).map(r => r.record.type);

test('H1 end to end: blind with frames after the hello, a message sent and stuck; the Reload writes SavedVariables after the attach; one restart and no_signal (blind), rung; the new session\'s hello is read and ok is rung; the message is acked', async (t) => {
  const env = await loop(t);
  const { flavorDir, addons, helper, b } = env;
  let vm = env.vm;
  helper.up();
  helper.stats(40, 0);
  // The session's hello is read off the strip and answered.
  vm.advance(3.1);
  assert.deepEqual(stripTypes(vm), ['hello']);
  assert.equal(helper.read(vm), true);
  await waitFor(() => b.bridge.status().token?.nonce === vm.evaluate('NS.R.nonce'), 2000, 'the hello heard');
  await answered(b, vm, addons);
  ringAndLoad(vm, addons);
  assert.equal(vm.bool('NS.R.helloAnswered'), true);
  assert.equal(b.bridge.status().reading.mode, 'pixel', 'the hello said its mode (SY-12)');
  assert.deepEqual(capOf(vm)?.state, 'ok', 'the slot carries the watchdog\'s state under cap capture');
  // Then blind: the window changed scale, frames come, nothing decodes (the 00:23Z incident).
  helper.readable = false;
  for (let i = 0; i < 6; i++) { helper.stats(40, 0); b.bridge.captureHealth.tick(); }
  const push = b.bridge.status().push;
  vm.send('where do I turn this in?');
  vm.advance(1);
  assert.ok(stripTypes(vm).includes('msg'), 'the message is on the strip');
  helper.read(vm); // blind: nothing reaches the core
  vm.advance(13);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Stop', 'not stuck before 15 s on screen (14 s)');
  vm.advance(6);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Reload', 'DR-07: the stuck line\'s one action, which the player clicks');
  assert.match(vm.evaluate('NS.HUD.h.sub.text'), /not read yet$/);
  for (let i = 0; i < 3; i++) { helper.stats(40, 0); b.bridge.captureHealth.tick(); }
  assert.equal(b.bridge.captureHealth.state(), 'ok', 'nothing judged before the Reload');
  assert.deepEqual(helper.restarts, []);
  const key = vm.list('NQADB.outbox').map(e => e.key).find(k => /_\d+$/.test(k));
  assert.ok(key, 'the message waits in the outbox too (the Reload carries it)');
  // The player clicks Reload: the game writes SavedVariables, after the helper's attach.
  await sleep(20);
  const wrote = writeSavedVariables(flavorDir, vm);
  assert.ok(wrote.some(e => e.key === key));
  b.bridge.pollSavedVariables();
  assert.deepEqual(helper.restarts, ['R4 blind'], 'one restart, at once, through the supervisor');
  const pub = b.bridge.buildSlot().bridge.capture;
  assert.deepEqual([pub.state, pub.cause], ['no_signal', 'blind']);
  await waitFor(() => b.bridge.status().push > push, 2000, 'rung');
  assert.equal(b.bridge.captureHealth.pausesRering(), true);
  // The /reload: a new UI session. The restarted helper can read, and the new hello is on the strip.
  vm = reloadVM(vm).login();
  helper.o.onStatus({ connected: false });
  helper.readable = true;
  helper.fed = null;
  helper.up();
  vm.advance(3.1);
  assert.deepEqual(stripTypes(vm).slice(0, 1), ['hello']);
  const push2 = b.bridge.status().push;
  assert.equal(helper.read(vm), true);
  assert.equal(b.bridge.captureHealth.state(), 'ok', 'R6: the strip is read');
  await waitFor(() => b.bridge.status().push > push2, 2000, 'the ok rung');
  await answered(b, vm, addons);
  ringAndLoad(vm, addons);
  assert.equal(vm.bool('NS.R.helloAnswered'), true);
  assert.equal(capOf(vm)?.state, 'ok', 'the new session reads ok');
  assert.ok(vm.list('NS.R.bridge.acked').includes(key), 'the stuck message was taken: its ack is in the slot');
  assert.deepEqual(helper.restarts, ['R4 blind']);
  const health = b.bridge.status().capture;
  assert.equal(health.ringsLeft, 5, 'the new session has rung once (its ok)');
});

test('H2 end to end (SY-20): a helper restart mid-session (its socket closes, it comes back, its first stats: frames, nothing decoded) publishes and rings nothing; the addon\'s slot keeps ok', async (t) => {
  const { addons, helper, b, vm } = await loop(t);
  helper.up();
  helper.stats(40, 1);
  vm.advance(3.1);
  helper.read(vm);
  await waitFor(() => b.bridge.status().token?.nonce === vm.evaluate('NS.R.nonce'), 2000, 'the hello heard');
  await answered(b, vm, addons);
  ringAndLoad(vm, addons);
  assert.equal(capOf(vm)?.state, 'ok');
  await sleep(60);
  const push = b.bridge.status().push;
  const slot = b.bridge.buildSlot().bridge.capture;
  helper.o.onStatus({ connected: false });
  b.bridge.captureHealth.tick();
  helper.up();
  helper.stats(40, 0);
  for (let i = 0; i < 5; i++) { helper.stats(40, 0); b.bridge.captureHealth.tick(); }
  helper.o.onError({ kind: 'window_minimized', message: 'World of Warcraft is minimized; restore it to keep chatting' });
  b.bridge.captureHealth.tick();
  await sleep(60);
  assert.equal(b.bridge.status().push, push, 'nothing rung');
  assert.deepEqual(b.bridge.buildSlot().bridge.capture, slot, 'the slot as it was');
  assert.deepEqual(helper.restarts, []);
});

// SY-12: the app's reload state had never shown, because no addon said its mode. The public addon's
// hello says it (SY-03's report), and a reload-mode session's hello reaches the bridge through
// SavedVariables: the watchdog's state is off (the strip isn't the way out, so its Reloads are never
// blindness), and the window shows no screen reading.
test('SY-12 end to end: the real addon in reload mode puts its hello (mode=reload) in SavedVariables; the core reads mode reload, the watchdog\'s state is off and its Reloads fire nothing; the window says no screen reading', async (t) => {
  const root = tmpDir('bones-loop-reload-');
  const flavorDir = path.join(root, 'wow', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  assert.equal(installAddon({ flavorDir, running: false }).ok, true);
  const helper = standIn();
  const vm = newVM({ extra: PUBLIC, db: 'NQADB = { settings = { mode = "reload" } }' }).login();
  const b = await bootByok({
    paths: { userData: path.join(root, 'ud') }, home: path.join(root, 'home'), env: {}, log: () => {},
    keystore: createKeyStore({ backend: 'memory' }), config: { wow: { flavorDir }, byok: { provider: 'anthropic' } },
    capture: true, createCapture: helper.make, lockDir: path.join(root, 'locks'), egress: false,
    wow: { run: NOT_RUNNING, roots: [] }, backendOptions: NO_CHECKS,
  });
  t.after(() => b.stop());
  helper.up();
  vm.advance(3.1);
  assert.equal(vm.strip(), null, 'reload mode draws nothing');
  const hello = vm.outboxWires().map(e => parseRecord(e.wire)).find(r => r.ok && r.record.type === 'hello');
  assert.equal(hello?.record.args.mode, 'reload', 'the hello says its mode');
  vm.send('anything nearby?');
  await sleep(20);
  writeSavedVariables(flavorDir, vm);
  b.bridge.pollSavedVariables();
  assert.equal(b.bridge.status().reading.mode, 'reload');
  assert.equal(b.bridge.captureHealth.state(), 'off');
  assert.deepEqual(helper.restarts, [], 'reload mode\'s records come by Reload: no evidence of anything');
  const st = await b.api.status();
  assert.equal(st.capture.mode, 'reload');
  assert.equal(st.view.screen.mode, 'none');
});

// A session whose hello the helper read and the core answered (a readable helper, the slot loaded).
async function live(env) {
  const { addons, helper, b, vm } = env;
  helper.up();
  helper.stats(40, 1);
  vm.advance(3.1);
  assert.equal(helper.read(vm), true);
  await waitFor(() => b.bridge.status().token?.nonce === vm.evaluate('NS.R.nonce'), 2000, 'the hello heard');
  await answered(b, vm, addons);
  ringAndLoad(vm, addons);
  assert.equal(vm.bool('NS.R.helloAnswered'), true);
  vm.run('NS.R.stateRec = nil; NS.Transport.RefreshStrip()'); // the companion's state: taken as read
  vm.advance(6); // the seen after the load goes by
  helper.read(vm);
  return env;
}

test('H15a end to end (DR-08, SY-14e): R4\' publishes no_signal and the addon reads it; with nothing to send, its self-probe\'s seen, 60 s on screen later, is read once capture reads again: ok', async (t) => {
  const env = await live(await loop(t));
  const { flavorDir, addons, helper, b, vm } = env;
  helper.readable = false;
  vm.send('where do I turn this in?');
  vm.advance(1);
  helper.read(vm);
  await sleep(20);
  writeSavedVariables(flavorDir, vm);
  const push = b.bridge.status().push;
  b.bridge.pollSavedVariables();
  assert.deepEqual(helper.restarts, ['R4 blind']);
  await waitFor(() => b.bridge.status().push > push, 2000, 'rung');
  await sleep(40);
  ringAndLoad(vm, addons);
  assert.equal(capOf(vm)?.state, 'no_signal', 'the addon reads the published state');
  assert.equal(vm.evaluate('next(NS.R.out)'), null, 'the Reload\'s write delivered the message: its ack came with the load');
  vm.advance(6); // the seen after that load goes by, unread
  helper.read(vm);
  assert.equal(b.bridge.captureHealth.state(), 'no_signal');
  helper.readable = true; // the cause went away (the overlay moved, the scale settled)
  vm.advance(40);
  assert.equal(helper.read(vm), false, 'nothing on the strip yet');
  assert.equal(b.bridge.captureHealth.state(), 'no_signal');
  vm.advance(15);
  assert.equal(helper.read(vm), true, 'the self-probe\'s seen, 60 s on screen after the state came');
  assert.deepEqual(stripTypes(vm), ['seen']);
  assert.equal(b.bridge.captureHealth.state(), 'ok', 'R6');
});

test('H8b end to end (DR-08, SY-17b): a switch to stream mid-session says mode=stream by the strip and the outbox; that session\'s Reload delivers its record by SavedVariables and raises no R4\'; the same switch on a blind strip (the seen only in the outbox, in the same write as the record) raises none either', async (t) => {
  for (const blind of [false, true]) {
    const env = await live(await loop(t));
    const { flavorDir, helper, b, vm } = env;
    if (blind) helper.readable = false;
    vm.slash('stream on');
    assert.deepEqual(stripTypes(vm), ['seen'], 'the mode seen, on the strip for its last seconds');
    helper.read(vm);
    vm.advance(6);
    assert.equal(vm.strip(), null);
    vm.send('anything nearby?');
    assert.equal(vm.strip(), null, 'stream mode: the record waits in the outbox');
    await sleep(20);
    writeSavedVariables(flavorDir, vm);
    b.bridge.pollSavedVariables();
    assert.deepEqual(helper.restarts, [], `${blind ? 'blind' : 'readable'}: no R4'`);
    assert.equal(b.bridge.captureHealth.state(), 'off', 'the newest session\'s mode is stream: off');
  }
});

// DR-25 (SY-09): the covered corner, R4' at the player's Reload and the clear, the steps the windows-smoke job
// runs against the real Windows helper and a real screen (tests/byok/windows_smoke_test.mjs), here with a
// stand-in helper on every OS: the same scenario, so its SavedVariables, its boot wiring and its numbers are
// proven everywhere and a change to it is tried before it costs a CI run.
test('DR-25 (stand-in helper): a covered corner reads nothing and publishes nothing; the Reload after it is R4\' (one restart, no_signal, rung); the cover gone, the strip is read and ok is rung', async (t) => {
  const r = await coveredCornerScenario(t, standInScene());
  assert.equal(r, undefined, JSON.stringify(r));
});
