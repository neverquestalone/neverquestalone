// The transport's local failures (systems plan Batches 2-4, SY-02, SY-03, SY-12): a store that
// starts over under an addon that kept its cursor, files that can't be read, and the slot window,
// end to end against the real addon (tests/helpers/nqa-vm.js) where it matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../bridge/service.mjs';
import { openStore, EPOCH_RE } from '../bridge/app/store.mjs';
import { installSlots, slotName, slotWindow, writeSlots, EMPTY_SLOT, WINDOW_MARGIN } from '../bridge/transport/slots.mjs';
import { createSignals } from '../bridge/transport/signals.mjs';
import { createRetrier } from '../bridge/transport/fsretry.mjs';
import { encodeRecord, parseRecord, RS } from '../bridge/transport/records.mjs';

const require = createRequire(import.meta.url);
const { newVM, reloadVM } = require('./helpers/nqa-vm.js');
const { PUBLIC } = require('./helpers/byok-slots.js'); // the addon as the desktop app installs it: the public build from load

const sleep = ms => new Promise(r => setTimeout(r, ms));
// The deadline bounds the waiting, not the code under test: a publish of the whole pool (201 slot
// files) is one synchronous step, which a stalled disk stretched past a 2-second budget on Windows CI
// (run 36318056822: "timed out waiting for the ready ring", rung by then). So the condition gets one
// more look once the deadline has passed.
async function waitFor(pred, ms = 3000, label = 'condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(10); }
  const v = await pred();
  if (v) return v;
  throw new Error(`timed out waiting for ${label}`);
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-resilience-'));

// ---------------------------------------------------------------- the store on its own

test('store: an unreadable state.json is kept aside and logged, never read as empty in silence; the numbering never falls behind its records', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'state.json'), '{"v":1,"seq":350,"push":900');
  fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify([{ seq: 348, t: 'reply', chat: 'c3f9a1e', text: 'x' }, { seq: 349, t: 'reply', chat: 'c3f9a1e', text: 'y' }]));
  const logs = [];
  const s = openStore(dir, { log: (kind, f) => logs.push({ kind, ...f }), now: () => 1234 });
  const kept = logs.find(l => l.kind === 'store-corrupt');
  assert.deepEqual([kept.file, kept.error, kept.keptAs], ['state.json', 'corrupt', 'state.json.corrupt-1234']);
  assert.ok(fs.existsSync(path.join(dir, 'state.json.corrupt-1234')), 'the unreadable file is kept as it was');
  assert.equal(s.state.seq, 349, 'the next record is numbered past the ones kept');
  assert.match(s.state.epoch, EPOCH_RE);
  assert.deepEqual(s.health().problems.map(p => p.file), ['state.json']);
  assert.equal(s.addRecord({ t: 'reply', chat: 'c3f9a1e', text: 'z' }).seq, 350);
});

test('store: records.json and outbox.jsonl that don\'t parse are kept aside too; the outbox keeps every line that does', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'records.json'), '[{"seq":1,');
  fs.writeFileSync(path.join(dir, 'outbox.jsonl'), '{"token":"3fa9c2d1","key":"a3f1_1","chat":"c3f9a1e"}\n{"token":"3fa9c2d1","key":"a3f1_2",\n');
  const logs = [];
  const s = openStore(dir, { log: (kind, f) => logs.push({ kind, ...f }), now: () => 99 });
  assert.deepEqual(logs.filter(l => l.kind === 'store-corrupt').map(l => l.file), ['records.json', 'outbox.jsonl']);
  assert.deepEqual(s.records, []);
  assert.deepEqual(s.outbox.map(o => o.key), ['a3f1_1'], 'the line that parses still goes');
  assert.ok(fs.existsSync(path.join(dir, 'records.json.corrupt-99')));
  assert.ok(fs.existsSync(path.join(dir, 'outbox.jsonl.corrupt-99')), 'a copy of the outbox as it was');
});

test('store: the epoch is made once and kept; a new store (a reinstall) gets a new one', () => {
  const dir = tmp();
  const a = openStore(dir).state.epoch;
  assert.match(a, EPOCH_RE);
  assert.equal(openStore(dir).state.epoch, a, 'kept across opens');
  const b = openStore(tmp()).state.epoch;
  assert.notEqual(b, a);
});

test('store: an addon cursor or push counter past the store\'s own moves the store up to it (store-behind), once', () => {
  const dir = tmp();
  const logs = [];
  const s = openStore(dir, { log: (kind, f) => logs.push({ kind, ...f }) });
  s.state.tokens['3fa9c2d1'] = { startSeq: 0, lastReported: 0, maxReported: 0 };
  assert.equal(s.reportCursor('3fa9c2d1', 87), true);
  assert.equal(s.state.seq, 87);
  assert.equal(s.state.tokens['3fa9c2d1'].lastReported, 87);
  assert.equal(s.addRecord({ t: 'reply', chat: 'c3f9a1e', text: 'after the reset' }).seq, 88, 'the next reply is past what the addon read');
  assert.equal(s.catchUp({ push: 40 }), true);
  assert.equal(s.state.push, 40);
  assert.equal(s.catchUp({ seq: 10, push: 12 }), false, 'lower values change nothing');
  assert.equal(logs.filter(l => l.kind === 'store-behind').length, 2);
  // Kept on disk: a restart doesn't fall back.
  assert.deepEqual([openStore(dir).state.seq, openStore(dir).state.push], [88, 40]);
});

test('SY-14: published ids and runs keep PUBLISHED_MAX (500), newest kept', async () => {
  const { PUBLISHED_MAX } = await import('../bridge/app/store.mjs');
  assert.equal(PUBLISHED_MAX, 500);
  const s = openStore(tmp());
  for (let i = 0; i < PUBLISHED_MAX + 100; i++) { s.markPublished(`m${i}`, i); s.markRun(`r${i}`, i); }
  assert.equal(Object.keys(s.state.published).length, PUBLISHED_MAX);
  assert.equal(Object.keys(s.state.publishedRuns).length, PUBLISHED_MAX);
  assert.equal(s.isPublished(`m${PUBLISHED_MAX + 99}`), true);
  assert.equal(s.isPublished('m99'), false, 'the oldest go first');
  assert.equal(s.isRunPublished(`r${PUBLISHED_MAX + 99}`), true);
  assert.equal(s.isRunPublished('r99'), false);
});

// Code health BR-13: records.json was rewritten whole for every record, 0.8-3 MB once the ring held
// 500 long replies.
test('store (code health BR-13): the records ring is held to RECORDS_BYTES on disk and in memory, the oldest read records first; a record a token seen lately hasn\'t read stays, whatever the size', async () => {
  const { RECORDS_BYTES, RECORDS_MAX, DEDUPE_MS } = await import('../bridge/app/store.mjs');
  assert.equal(RECORDS_BYTES, 256 * 1024);
  let clock = 1_790_000_000_000;
  const dir = tmp();
  const s = openStore(dir, { now: () => clock });
  const file = () => fs.readFileSync(path.join(dir, 'records.json'), 'utf8');
  const reply = i => ({ t: 'reply', chat: 'c3f9a1e', text: `reply ${i} `.padEnd(4000, 'é'), summary: `sum ${i}` });
  // A token that reads everything as it comes (its cursor at the newest record).
  s.state.tokens.a1b2c3d4 = { lastReported: 0, maxReported: 0, startSeq: 0, lastSeen: clock };
  for (let i = 1; i <= 300; i++) { s.addRecord(reply(i), clock); s.state.tokens.a1b2c3d4.lastReported = s.state.seq; }
  const onDisk = JSON.parse(file());
  assert.ok(Buffer.byteLength(file()) <= RECORDS_BYTES + 1, `${Buffer.byteLength(file())} bytes`);
  assert.ok(onDisk.length > 20 && onDisk.length < 60, `${onDisk.length} records (each about 6 KB)`);
  assert.deepEqual(onDisk.map(r => r.seq), s.records.map(r => r.seq), 'the ring in memory is the file');
  assert.equal(onDisk.at(-1).seq, 300, 'the newest stays');
  assert.deepEqual(onDisk.map(r => r.seq), Array.from({ length: onDisk.length }, (_, i) => 301 - onDisk.length + i), 'the oldest went first');
  // Records the token hasn't read yet stay, past the bytes (RECORDS_MAX still bounds the ring).
  const read = s.state.seq;
  for (let i = 301; i <= 360; i++) s.addRecord(reply(i), clock);
  assert.ok(s.records.some(r => r.seq === read + 1) && s.records.length >= 60, 'every unread record kept');
  assert.ok(Buffer.byteLength(file()) > RECORDS_BYTES);
  assert.equal(s.recordsFor('a1b2c3d4').length, 60, 'the slot still has every one');
  // A token not seen for longer than the dedupe window holds nothing back.
  clock += DEDUPE_MS + 1;
  s.addRecord(reply(361), clock);
  assert.ok(Buffer.byteLength(file()) <= RECORDS_BYTES + 1);
  assert.equal(s.records.at(-1).seq, 361);
  assert.ok(RECORDS_MAX >= s.records.length);
});

// BR-13 with BR-11 (the 1.4.0 merge): a records write the disk refuses is owed, never thrown, and the
// ring it holds meanwhile is still held to the cap.
test('store (code health BR-13 with BR-11): a records write the disk refuses keeps the ring held to RECORDS_BYTES in memory and owed; retryWrites writes it as it is then', async () => {
  const { RECORDS_BYTES } = await import('../bridge/app/store.mjs');
  const dir = tmp();
  let told = 0;
  const s = openStore(dir, { onWriteError: () => { told += 1; } });
  const real = fs.writeFileSync;
  let full = true;
  fs.writeFileSync = function (p, ...a) { if (full && String(p).startsWith(dir)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return real.call(this, p, ...a); };
  try {
    for (let i = 1; i <= 120; i++) s.addRecord({ t: 'reply', chat: 'c3f9a1e', text: `reply ${i} `.padEnd(4000, 'x') }, Date.now());
    assert.deepEqual([s.health().writeError?.file, s.health().writeError?.code], ['records.json', 'ENOSPC']);
    assert.ok(Buffer.byteLength(JSON.stringify(s.records)) <= RECORDS_BYTES, 'the ring held to the cap while the disk is full');
    assert.equal(s.records.at(-1).seq, 120, 'the newest kept');
    full = false;
    assert.equal(s.retryWrites(), true, 'written once there is room');
    assert.equal(s.health().writeError, null);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'records.json'), 'utf8')).map(r => r.seq), s.records.map(r => r.seq), 'the file is the ring as it is now');
    assert.equal(told, 2, 'the error came, then went');
  } finally { fs.writeFileSync = real; }
});

test('SY-19: a counter off the screen has a ceiling: a 13-digit cur is refused, a 13-digit p dropped, and catchUp never jumps past 2^31 - 1, the most the addon writes with %d (a C long, 32 bits on Windows)', () => {
  const huge = '1' + '0'.repeat(20);
  assert.deepEqual(parseRecord(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: huge, p: 5 } })), { ok: false, reason: 'cur' });
  assert.equal(parseRecord(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: '1'.repeat(13) } })).reason, 'cur');
  const twelve = parseRecord(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: '9'.repeat(12), p: 7 } }));
  assert.equal(twelve.ok, true, '12 digits is decades of turns, and fine');
  assert.equal(twelve.record.args.p, '7');
  const badP = parseRecord(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: 4, p: huge } }));
  assert.equal(badP.ok, true, 'the record is kept');
  assert.equal(badP.record.args.p, undefined, 'its push counter isn\'t');
  // The store on its own, whoever calls it: the numbering keeps counting in ones.
  const s = openStore(tmp());
  s.state.tokens['3fa9c2d1'] = { startSeq: 0, lastReported: 0, maxReported: 0 };
  s.reportCursor('3fa9c2d1', huge);
  assert.equal(s.catchUp({ seq: 1e20, push: 1e20 }), false);
  assert.equal(s.catchUp({ seq: 2 ** 53 + 2 }), false);
  const a = s.addRecord({ t: 'reply', chat: 'c3f9a1e', text: 'one' }).seq;
  const b = s.addRecord({ t: 'reply', chat: 'c3f9a1e', text: 'two' }).seq;
  assert.deepEqual([a, b], [1, 2], 'every reply its own seq');
  assert.equal(s.catchUp({ seq: 2 ** 31, push: 2 ** 31 }), false, 'one past what the addon can write');
  assert.equal(s.catchUp({ seq: 2 ** 31 - 1 }), true, 'the ceiling itself is taken');
  assert.equal(s.addRecord({ t: 'reply', chat: 'c3f9a1e', text: 'three' }).seq, 2 ** 31);
});

// ---------------------------------------------------------------- end to end, with the real addon

// A backend stand-in: ready at start, a send answered started, and finals (with their rows' ids, as
// the backend's are) sent when the test says.
function doubleGateway() {
  const gw = { sends: [], handlers: null };
  gw.factory = (handlers) => {
    gw.handlers = handlers;
    return {
      kind: 'byok',
      persona: 'NeverQuestAlone',
      start() { handlers.onState({ state: 'ready', since: Date.now() }); handlers.onReady(); },
      stop() {},
      send: (args) => { gw.sends.push(args); return { runId: args.idem, status: 'started' }; },
      abort: () => ({ aborted: false }),
      forget: () => ({ ok: true }),
      outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
    };
  };
  let n = 0;
  gw.reply = (chatId, text) => {
    n += 1;
    gw.handlers.onEvent({ event: 'chat', payload: { state: 'final', chatId, runId: `run-${n}`,
      message: { role: 'assistant', content: [{ type: 'text', text }], __nqa: { id: `byok:${chatId}:${n}`, seq: n } } } });
  };
  return gw;
}

function makeBridge(stateDir, addons, gw, logs = [], deps = {}, transport = {}) {
  return createBridge({ transport: { slots: 200, ...transport } }, {
    stateDir, addonsDir: addons, log: (kind, f) => logs.push({ kind, ...f }), gatewayFactory: gw.factory,
    publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 20, alive: 20, act: 5 }, actGapMs: 5 },
    ...deps,
  });
}

// What the addon draws now goes to the bridge, as the capture app would read it. report: false
// takes slot= out of every record, as an addon that doesn't say where its next load is would draw them.
const unreported = payload => payload.split(RS).map((w) => {
  const f = w.split('\x1f');
  if (f.length < 7) return w;
  f[5] = f[5].split(';').filter(a => !a.startsWith('slot=')).join(';');
  return f.join('\x1f');
}).join(RS);
function capture(vm, bridge, { report = true } = {}) {
  const s = vm.strip();
  if (s) bridge.handlePayload(report ? s.payload : unreported(s.payload));
  return !!s;
}
// What the addon drew, as records: the args of each of this type on the strip now.
const stripArgs = (vm, type) => vm.stripWires().map(w => parseRecord(w)).filter(r => r.ok && r.record.type === type).map(r => r.record.args);
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
// The addon hears a push ring and loads its next slot: the file on disk, as the game would read it.
function ringAndLoad(vm, addons) {
  vm.advance(1.6); // past PUSH_GAP
  offerSlots(vm, addons);
  const bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false); vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true); vm.run('NS.Transport.Poll()');
  vm.advance(0.3);
}
const replies = vm => vm.history().filter(h => h.kind === 'reply' || h.role === 'bones' || h.from === 'bones' || h.t === 'reply');

test('e2e: a store that starts over (a reinstall) under an addon that kept its cursor: today\'s addon shows 2 of 2 replies (was 0 of 2)', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const gw = doubleGateway();
  let bridge = makeBridge(path.join(root, 'state-a'), addons, gw);
  // The game first: making the VM can take seconds on a loaded runner, which the bridge's real
  // clock would count against its first ring (a ring unread for 10 s turns the window to time mode).
  let vm = newVM().login();
  bridge.start();
  try {
    vm.advance(3.1); // the hello goes up
    assert.ok(capture(vm, bridge), 'the hello is on the strip');
    await sleep(40);
    ringAndLoad(vm, addons);
    assert.equal(vm.bool('NS.R.helloAnswered'), true, 'the bridge answered the hello');
    // A chat, and three replies in it: the addon's cursor moves to 3.
    vm.send('first words');
    capture(vm, bridge);
    await waitFor(() => gw.sends.length === 1, 2000, 'the send');
    const chatId = gw.sends[0].chatId;
    for (const t of ['one', 'two', 'three']) gw.reply(chatId, `Reply ${t}.`);
    await sleep(40);
    ringAndLoad(vm, addons);
    assert.equal(vm.num('NQADB.cursor'), bridge.status().seq, 'the addon read every record');
    const cursor = vm.num('NQADB.cursor');
    assert.ok(cursor >= 3);
    await bridge.stop();

    // The app is uninstalled and installed again: its store starts over; the game's SavedVariables stay.
    vm = reloadVM(vm).login();
    const logs = [];
    bridge = makeBridge(path.join(root, 'state-b'), addons, gw, logs);
    bridge.start();
    vm.advance(3.1);
    capture(vm, bridge);
    await sleep(40);
    ringAndLoad(vm, addons);
    const before = vm.history().length;
    vm.send('are you there?');
    capture(vm, bridge);
    await waitFor(() => gw.sends.length === 2, 2000, 'the second send');
    gw.reply(chatId, 'Still here after the reinstall.');
    gw.reply(chatId, 'And a second reply.');
    await sleep(40);
    ringAndLoad(vm, addons);
    const added = vm.history().slice(before).filter(h => /reinstall|second reply/.test(JSON.stringify(h)));
    assert.equal(added.length, 2, '2 of 2 replies shown');
    assert.ok(logs.some(l => l.kind === 'store-behind' && l.seq >= cursor), 'the store moved up to the addon\'s cursor, and said so');
    assert.ok(bridge.status().store.behind, 'status says it happened');
  } finally {
    await bridge.stop();
  }
});

// ---------------------------------------------------------------- the slot window (SY-03)

test('slotWindow: from the report, its margin; outside is emptied once, what it passed as it rises, what was above a lower new top; a small pool, a window reaching every slot, or no anchor: every slot', () => {
  const at = 1_000_000;
  const w = { base: 5, at, mode: 'report', blanked: false, blankTo: 0 };
  assert.deepEqual(slotWindow(w, { count: 200 }), { from: 5, to: 5 + WINDOW_MARGIN, blank: [[1, 4], [14, 200]] });
  // Written once: only the window from then on; the anchor rising empties what it passed.
  Object.assign(w, { blanked: true, blankTo: 4, top: 13, base: 8 });
  assert.deepEqual(slotWindow(w, { count: 200 }), { from: 8, to: 16, blank: [[5, 7]] });
  // Reaching every slot from the first: every slot, as before.
  assert.equal(slotWindow({ ...w, base: 1 }, { count: 1 + WINDOW_MARGIN }), null);
  assert.equal(slotWindow({ ...w, base: 1 }, { count: 3 }), null, 'a small pool is always written whole');
  // A new anchor that brings the top down empties what was above it.
  assert.deepEqual(slotWindow({ base: 20, at, mode: 'report', blanked: true, blankTo: 19, top: 40 }, { count: 200 }).blank, [[29, 40]]);
  assert.equal(slotWindow(null, {}), null);
  assert.equal(slotWindow({ base: 0, at }, {}), null);
});

test('slotWindow: the report and the margin however long ago it came; at the end of the pool, clipped to it', () => {
  const at = 1_000_000;
  const w = { base: 5, at, mode: 'report', blanked: false, blankTo: 0 };
  assert.deepEqual(slotWindow(w, { count: 200 }), { from: 5, to: 5 + WINDOW_MARGIN, blank: [[1, 4], [14, 200]] });
  // The next report, an hour on: what it passed is emptied, the top follows it.
  Object.assign(w, { blanked: true, blankTo: 4, top: 13, base: 9, at: at + 3_600_000 });
  assert.deepEqual(slotWindow(w, { count: 200 }), { from: 9, to: 17, blank: [[5, 8]] });
  assert.deepEqual(slotWindow({ ...w, base: 196 }, { count: 200 }), { from: 196, to: 200, blank: [[5, 195]] });
});

function slotFiles(addons, i) { return fs.readFileSync(path.join(addons, slotName(i), 'Inbox.lua'), 'utf8'); }
const tableIn = (addons, i) => /^NQA_SlotData = \{/m.test(slotFiles(addons, i));
// A bridge on a clock that stands still unless the test moves it (the window must not care). It
// starts where the addon's does (the VM's time() at login: STUB.epoch + STUB.now, 1,700,001,000 s),
// as the bridge and the game share the machine's clock: the addon reads how long the app has been
// quiet from a slot's now, and since main 0.5.3 an app quiet that long sends messages by Copy and
// Paste instead (Paste.lua, E-050).
function clockBridge(root, addons, logs, config = {}, deps = {}, gw = doubleGateway()) {
  const clock = { t: 1_700_001_000_000 };
  const bridge = createBridge({ transport: { slots: 200, ...config } }, {
    stateDir: path.join(root, `state-${Object.keys(config).length}`), addonsDir: addons, log: (kind, f) => logs.push({ kind, ...f }), now: () => clock.t,
    gatewayFactory: gw.factory, publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 5, alive: 5, act: 5 }, actGapMs: 5 },
    ...deps,
  });
  return { bridge, clock };
}
const win = b => { const w = b.status().slotWindow; return w && [w.mode, w.from, w.to]; };

test('e2e window: an addon that doesn\'t say where it loads (an older one: no slot=) has no window: every slot is written, and every reply shown', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const gw = doubleGateway();
  const logs = [];
  // The guards off, as this is about the window, and each ack rings at once (ackRingMs 0), as the
  // loads below follow a ring for the ack and one for the reply.
  const bridge = makeBridge(path.join(root, 'state'), addons, gw, logs, { typedGuard: null, autoFuse: null }, { ackRingMs: 0 });
  const cap = () => capture(vm, bridge, { report: false });
  const vm = newVM().login();
  bridge.start();
  try {
    vm.advance(3.1);
    cap();
    await sleep(30);
    ringAndLoad(vm, addons);
    cap(); // the seen after the load
    assert.equal(vm.bool('NS.R.helloAnswered'), true);
    assert.equal(bridge.status().slotWindow, null, 'no report, no window');
    const mark = logs.length;
    let chatId = null;
    for (let i = 1; i <= 3; i++) {
      vm.send(`question ${i}`);
      cap();
      await waitFor(() => gw.sends.length === i, 2000, `send ${i}`);
      chatId ??= gw.sends[0].chatId;
      await sleep(15);
      ringAndLoad(vm, addons); // the ack
      cap();
      vm.advance(4);
      cap();
      gw.reply(chatId, `Answer number ${i}.`);
      await sleep(15);
      ringAndLoad(vm, addons); // the reply
      cap();
      vm.advance(6);
      cap();
      assert.match(JSON.stringify(vm.history()), new RegExp(`Answer number ${i}\\.`), `reply ${i} shown`);
    }
    const files = logs.slice(mark).filter(l => l.kind === 'publish').map(p => p.files);
    assert.ok(files.length > 0 && files.every(f => f === 201), `every slot and the inbox, every publish: ${[...new Set(files)].join(',')}`);
  } finally {
    await bridge.stop();
  }
});


test('e2e window, report mode: the public build\'s addon says where its next load is (slot= on its hello, a seen after every load): 30 turns, every reply shown, at most 12 files a publish, the window at its report', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const gw = doubleGateway();
  const logs = [];
  const bridge = makeBridge(path.join(root, 'state'), addons, gw, logs, { typedGuard: null, autoFuse: null });
  // The game first, as above: the VM's start isn't counted against the bridge's first ring.
  const vm = newVM({ extra: PUBLIC }).login();
  bridge.start();
  try {
    vm.advance(3.1);
    const [hello] = stripArgs(vm, 'hello');
    assert.deepEqual([hello.slot, hello.mode, hello.sig], ['1', 'pixel', 'ok'], 'the hello says where the next load is, and the way out');
    capture(vm, bridge);
    await sleep(30);
    assert.deepEqual(win(bridge), ['report', 1, 1 + WINDOW_MARGIN]);
    ringAndLoad(vm, addons);
    assert.equal(vm.bool('NS.R.helloAnswered'), true);
    assert.equal(stripArgs(vm, 'seen')[0]?.slot, '2', 'a seen after the load says the next slot');
    capture(vm, bridge);
    await sleep(30);
    assert.deepEqual(win(bridge), ['report', 2, 2 + WINDOW_MARGIN]);
    const mark = logs.length;
    let chatId = null;
    for (let i = 1; i <= 30; i++) {
      vm.send(`question ${i}`);
      capture(vm, bridge);
      await waitFor(() => gw.sends.length === i, 2000, `send ${i}`);
      chatId ??= gw.sends[0].chatId;
      await sleep(15);
      ringAndLoad(vm, addons); // the ack
      capture(vm, bridge);
      vm.advance(4);
      capture(vm, bridge);
      gw.reply(chatId, `Answer number ${i}.`);
      // The reply's publish on disk in the slot the addon loads next (a slow disk may take a while).
      await waitFor(() => slotFiles(addons, vm.num('NS.R.slots.nextIndex')).includes(`Answer number ${i}.`), 3000, `reply ${i} written`);
      ringAndLoad(vm, addons); // the reply
      capture(vm, bridge);
      vm.advance(6);
      capture(vm, bridge);
      await sleep(15);
      assert.match(JSON.stringify(vm.history()), new RegExp(`Answer number ${i}\\.`), `reply ${i} shown`);
      assert.equal(bridge.status().slotWindow.from, vm.num('NS.R.slots.nextIndex'), `turn ${i}: the window starts at the addon's next slot`);
    }
    const files = logs.slice(mark).filter(l => l.kind === 'publish').map(p => p.files);
    assert.ok(Math.max(...files) <= 12, `at most 12 files a publish: ${files.join(',')}`);
    assert.equal(bridge.status().slotWindow.mode, 'report');
    assert.ok(vm.num('NS.R.slots.nextIndex') > 60, 'the addon went through 60+ slots, each read from disk');
  } finally {
    await bridge.stop();
  }
});

test('e2e window, report mode, slot-only (the game\'s sound off, so no doorbells: the addon loads on its own timers): a question, a 4-minute run and another, every reply shown, at most 12 files a publish 6 minutes in (the window follows its reports)', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const logs = [];
  const gw = doubleGateway();
  const { bridge, clock } = clockBridge(root, addons, logs, {}, { typedGuard: null, autoFuse: null, runCheckEveryMs: 3_600_000 }, gw);
  bridge.start();
  const vm = newVM({ extra: PUBLIC, signals: false }).login();
  let fed = null;
  // Seconds of play: the slots on disk offered to the addon's next load, the game's clock and the
  // bridge's moved on together, and the strip handed over when it changed (as the capture app does).
  const play = async (sec) => {
    for (let i = 0; i < sec; i++) {
      offerSlots(vm, addons);
      vm.advance(1);
      clock.t += 1000;
      const st = vm.strip();
      if (st && st.payload !== fed) { fed = st.payload; bridge.handlePayload(st.payload); }
      await sleep(10);
    }
  };
  const shown = text => JSON.stringify(vm.history()).includes(text);
  const ask = async (words, n) => {
    vm.send(words);
    await play(1);
    await waitFor(() => gw.sends.length === n, 2000, `send ${n}`);
    return gw.sends[0].chatId;
  };
  try {
    await play(4);
    const [hello] = stripArgs(vm, 'hello');
    assert.deepEqual([hello.slot, hello.mode], ['1', 'pixel']);
    assert.notEqual(hello.sig, 'ok', 'no doorbells: slot-only');
    await play(10); // slot-only reads the hello's answer a few seconds after it went up
    assert.equal(vm.bool('NS.R.hello.confirmed ~= nil'), true);
    assert.deepEqual(win(bridge), ['report', 2, 2 + WINDOW_MARGIN], 'the load was reported');
    const mark = logs.length;
    const chatId = await ask('Where is the flight master?', 1);
    await play(14);
    gw.reply(chatId, 'East of the inn.');
    await play(40);
    assert.ok(shown('East of the inn.'), 'the first reply, from a scheduled load');
    // A long run: the addon keeps loading on its timers (the schedule, then every 30 s), so it passes
    // the margin before the reply comes; each load is reported, and the window follows it.
    await ask('Plan my next hour.', 2);
    const from = vm.num('NS.R.slots.nextIndex');
    await play(240);
    assert.ok(vm.num('NS.R.slots.nextIndex') - from > WINDOW_MARGIN, `more loads than the margin while it ran (${from} to ${vm.num('NS.R.slots.nextIndex')})`);
    gw.reply(chatId, 'Here is your hour.');
    await play(35);
    assert.ok(shown('Here is your hour.'), 'the long run\'s reply, from a load on the addon\'s own timer');
    await ask('Thanks!', 3);
    await play(8);
    gw.reply(chatId, 'Any time.');
    await play(25);
    assert.ok(shown('Any time.'));
    assert.deepEqual(win(bridge), ['report', vm.num('NS.R.slots.nextIndex'), vm.num('NS.R.slots.nextIndex') + WINDOW_MARGIN], 'the window starts at the addon\'s next slot');
    const files = logs.slice(mark).filter(l => l.kind === 'publish').map(p => p.files);
    assert.ok(Math.max(...files) <= 12, `at most 12 files a publish: ${files.join(',')}`);
  } finally {
    await bridge.stop();
  }
});

test('window: re-rings count from when a ring rang, not from the start of its write: a write the disk stretches past 10 s leaves nothing unread yet (Windows CI 36318056822)', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  let clock = 1_700_000_000_000;
  const logs = [];
  const bridge = createBridge({ transport: { slots: 200 } }, {
    stateDir: path.join(root, 'state'), addonsDir: addons, log: (kind, f) => logs.push({ kind, ...f }), now: () => clock,
    gatewayFactory: doubleGateway().factory, publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 5, alive: 5, act: 5 }, actGapMs: 5 },
  });
  const rings = () => bridge.signals.stats().rings.push_a + bridge.signals.stats().rings.push_b;
  const rename = fs.renameSync;
  bridge.start();
  try {
    await waitFor(() => rings() >= 1, 2000, 'the ready ring');
    // A disk that takes 60 ms a slot file (a virus scan of each new file on a busy machine): the
    // hello's answer, the window's first write, also empties the 191 slots past it, so it rings 12 s on.
    fs.renameSync = (from, to) => { if (/Inbox\.lua\.tmp$/.test(String(from))) clock += 60; return rename(from, to); };
    const before = clock;
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.4.9', sig: 'ok', slots: 200, slot: 1, mode: 'pixel' } }));
    await waitFor(() => rings() >= 2, 2000, 'the hello\'s answer, rung');
    fs.renameSync = rename;
    assert.ok(clock - before > 10_000, `the write took ${clock - before} ms of the bridge's clock`);
    // Rung just now: the addon has had no time to hear it, so nothing is re-rung.
    bridge.reRing();
    await sleep(30);
    assert.ok(!logs.some(l => l.kind === 'rering'), 'no re-ring yet');
    // 10 s after the ring, it's unread: rung again.
    clock += 10_001;
    bridge.reRing();
    await sleep(30);
    assert.ok(logs.some(l => l.kind === 'rering'));
    assert.deepEqual(win(bridge), ['report', 1, 1 + WINDOW_MARGIN], 'the window stays at the report');
  } finally {
    fs.renameSync = rename;
    await bridge.stop();
  }
});


test('window, report mode (SY-03): a hello with slot= anchors at it; a higher report moves it and writes the slots ahead at once; nothing is guessed (an unread ring, an hour); an older, a repeated or another session\'s report moves nothing; mode= reaches status', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const logs = [];
  const { bridge, clock } = clockBridge(root, addons, logs);
  const publishes = () => logs.filter(l => l.kind === 'publish').length;
  const seen = (args, key = 'a3f1') => bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key, type: 'seen', args: { cur: 0, ...args } }));
  bridge.start();
  try {
    await waitFor(() => bridge.signals.stats().rings.push_a + bridge.signals.stats().rings.push_b >= 1, 2000, 'the ready ring');
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.4.9', sig: 'ok', slots: 200, slot: 1, mode: 'pixel' } }));
    await waitFor(() => logs.some(l => l.kind === 'publish' && l.push && l.window === '1-9'), 2000, 'the hello\'s answer, in the window');
    assert.deepEqual(win(bridge), ['report', 1, 1 + WINDOW_MARGIN]);
    assert.deepEqual([bridge.status().reading.mode, bridge.status().reading.helloVia], ['pixel', 'strip']);
    assert.ok(tableIn(addons, 1) && tableIn(addons, 9), 'the report and the margin hold the table');
    assert.equal(slotFiles(addons, 10), EMPTY_SLOT, 'past it: emptied');
    // A ring unread for 10 s: a reporting addon's window stays as it is (no time mode), and an hour changes nothing.
    const quiet = publishes();
    clock.t += 10_001;
    bridge.reRing();
    await sleep(30);
    assert.deepEqual(win(bridge), ['report', 1, 9]);
    assert.equal(publishes(), quiet, 'nothing written for it');
    clock.t += 3_600_000;
    assert.deepEqual(win(bridge), ['report', 1, 9]);
    // Five loads on (a seen after the last), the window is at the report, and the slots ahead are written now.
    seen({ p: 1, slot: 6 });
    await waitFor(() => publishes() > quiet, 2000, 'the slots ahead written');
    assert.deepEqual(win(bridge), ['report', 6, 6 + WINDOW_MARGIN]);
    assert.ok(tableIn(addons, 6) && tableIn(addons, 14), 'from the report to the margin: the table');
    assert.equal(slotFiles(addons, 15), EMPTY_SLOT);
    assert.equal(slotFiles(addons, 5), EMPTY_SLOT, 'what it passed is emptied');
    assert.equal(logs.filter(l => l.kind === 'publish').at(-1).window, '6-14');
    // The same report read again (the strip redrawn with another record), an older one, another
    // session's, and one past the pool (no slot left): nothing moves and nothing is written.
    const n = publishes();
    seen({ p: 1, slot: 6 });
    seen({ p: 1, slot: 4 });
    seen({ slot: 50 }, 'b7c2');
    seen({ slot: 201 });
    await sleep(30);
    assert.equal(publishes(), n);
    assert.deepEqual(win(bridge), ['report', 6, 14]);
    // One load on: the window follows the report, and the slot its top reached is written.
    seen({ slot: 7 });
    await waitFor(() => publishes() === n + 1, 2000, 'the new top written');
    assert.deepEqual(win(bridge), ['report', 7, 15]);
    assert.ok(tableIn(addons, 15));
    assert.equal(slotFiles(addons, 6), EMPTY_SLOT);
  } finally {
    await bridge.stop();
  }
});

test('window: an addon that doesn\'t report (an older one) has none, so every slot is written; its first slot= report (a hello that said none) anchors one; slotWindow false writes every slot', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  let logs = [];
  const hello = encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200 } });
  const pushes = () => logs.filter(l => l.kind === 'publish' && l.push).length;
  // A turn's ack rings at once here (ackRingMs 0): the window's answer to it is what this looks at.
  const { bridge } = clockBridge(root, addons, logs, { ackRingMs: 0 });
  bridge.start();
  try {
    await waitFor(() => bridge.signals.stats().rings.push_a + bridge.signals.stats().rings.push_b >= 1, 2000, 'the ready ring');
    const ready = pushes(); // the ready ring's publish, before any hello
    bridge.handlePayload(hello);
    await waitFor(() => pushes() === ready + 1, 2000, 'the hello\'s answer rung');
    assert.equal(bridge.status().slotWindow, null, 'no report, no window');
    assert.equal(logs.filter(l => l.kind === 'publish').at(-1).files, 201, 'every slot and the inbox');
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: 0, p: 1 } }));
    assert.equal(bridge.status().slotWindow, null, 'a load proved is no report: nothing is guessed');
    // Its first report anchors a window, and a ring doesn't grow it.
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: 0, p: 1, slot: 5 } }));
    assert.deepEqual(win(bridge), ['report', 5, 13]);
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1_1', type: 'msg', chat: 'c3f9a1e', args: { cur: 0 }, body: 'hi' }));
    await waitFor(() => pushes() === ready + 2, 2000, 'the ack rung');
    assert.deepEqual(win(bridge), ['report', 5, 13], 'the ack\'s ring adds nothing');
    assert.equal(logs.filter(l => l.kind === 'publish' && l.push).at(-1).window, '5-13', 'written in the window');
  } finally {
    await bridge.stop();
  }
  logs = [];
  const { bridge: whole } = clockBridge(root, addons, logs, { slotWindow: false, ackRingMs: 0 });
  whole.start();
  try {
    whole.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'b7c2', type: 'hello', args: { cur: 0, ver: '1.4.9', sig: 'ok', slots: 200, slot: 1 } }));
    await sleep(20);
    assert.equal(whole.status().slotWindow, null);
    assert.equal(logs.filter(l => l.kind === 'publish').at(-1).files, 201);
  } finally {
    await whole.stop();
  }
});

test('tools/bench-publish.mjs (windows-smoke runs it for a Windows number, SY-03): window mode writes the report\'s window and the inbox, full mode every slot, with no error', () => {
  const bench = fileURLToPath(new URL('../tools/bench-publish.mjs', import.meta.url));
  for (const [mode, files] of [['window', 1 + WINDOW_MARGIN + 1], ['full', 201]]) {
    const r = spawnSync(process.execPath, [bench, '--mode', mode, '--runs', '3', '--dir', tmp()], { encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    assert.deepEqual([out.mode, out.runs, out.files, out.errors], [mode, 3, files, 0], r.stdout);
    assert.equal(out.window, mode === 'window' ? `1-${1 + WINDOW_MARGIN}` : 'all');
    assert.ok(out.p50 > 0 && out.max >= out.p50, r.stdout);
  }
  assert.equal(spawnSync(process.execPath, [bench, '--mode', 'half'], { encoding: 'utf8' }).status, 2, 'a mode it doesn\'t know is refused');
});

// ---------------------------------------------------------------- Windows sharing violations (Batch 1's retrier, SY-08)

test('writeSlots and the doorbells ride out a sharing violation (EBUSY twice, then fine) with one retrier; a lasting one is counted, not thrown', () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 3, iface: '16001' });
  const rename = fs.renameSync;
  let fails = 2;
  fs.renameSync = (a, b) => { if (fails > 0 && String(b).endsWith(path.join(slotName(2), 'Inbox.lua'))) { fails -= 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } return rename(a, b); };
  try {
    const retrier = createRetrier({ platform: 'win32', sleep: () => {} });
    const res = writeSlots(addons, 'NQA_SlotData = { v = 2 }\n', 'NQA_Inbox = { v = 2 }\n', { count: 3, retrier });
    assert.deepEqual([res.errors, res.written, res.retries.retries, res.retries.recovered], [0, 4, 2, 1]);
    assert.equal(slotFiles(addons, 2), 'NQA_SlotData = { v = 2 }\n');
    // Locked for good: one error, logged; the others still written.
    fails = 99;
    const logs = [];
    const res2 = writeSlots(addons, 'NQA_SlotData = { v = 3 }\n', 'x', { count: 3, retrier: createRetrier({ platform: 'win32', sleep: () => {} }), log: (k, f) => logs.push({ k, ...f }) });
    assert.deepEqual([res2.errors, res2.written], [1, 3]);
    assert.equal(logs[0].k, 'slot-error');
  } finally {
    fs.renameSync = rename;
  }
  const rm = fs.rmSync;
  let busy = 2;
  fs.rmSync = (f, o) => { if (busy > 0 && String(f).includes('bell_push_a')) { busy -= 1; throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } return rm(f, o); };
  try {
    const sig = createSignals(addons, { retrier: createRetrier({ platform: 'win32', sleep: () => {} }), pulseMs: { push: 5, alive: 5, act: 5 } });
    sig.ringPush();
    assert.equal(fs.existsSync(sig.paths.bell('push_a')), false, 'the ring went through after two retries');
    assert.equal(sig.stats().errors, 0);
    sig.stop();
  } finally {
    fs.rmSync = rm;
  }
});

// ---------------------------------------------------------------- the slot fan-out off the main thread (code health BR-04)

// A publisher on its own, its slot table numbered by the test (bridge.n) and carrying the push counter.
async function workerPublisher(root, { worker = true, range = null } = {}) {
  const { createPublisher } = await import('../bridge/transport/publisher.mjs');
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true });
  const store = openStore(path.join(root, 'state'));
  const logs = [];
  const at = { n: 0 };
  const buildSlot = () => ({ v: 2, ts: '2026-10-03T00:00:00.000Z', now: 1, token: '3fa9c2d1', bridge: { push: store.state.push, n: at.n }, gw: {}, agents: [], chats: [], records: [] });
  const inbox = () => fs.readFileSync(path.join(addons, 'NeverQuestAlone', 'Inbox.lua'), 'utf8');
  // At each ring: what the addon would find on disk then (three slots and the reload inbox).
  const rings = [];
  const signals = { ringPush: () => rings.push({ push: store.state.push, files: [1, 100, 200].map(i => slotFiles(addons, i)), inbox: inbox() }) };
  const pub = createPublisher({ store, signals, addonsDir: addons, buildSlot, log: (k, f) => logs.push({ k, ...f }), slotCount: 200, coalesceMs: 5, worker, range });
  return { pub, store, addons, logs, rings, at, inbox };
}
const everySlot = addons => Array.from({ length: 200 }, (_, i) => slotFiles(addons, i + 1));
const tick = () => new Promise(r => setImmediate(r));

test('publisher (code health BR-04): with the worker, the slot files are written off the main thread, byte for byte what the in-place write makes; P is on disk first and the ring comes once they are; one write at a time, what was asked for meanwhile goes once after it; flushNow lands it now', async () => {
  const root = tmp();
  const range = { plan: null };
  const w = await workerPublisher(root, { range: () => range.plan });
  try {
    w.at.n = 1;
    w.pub.publish({ push: true });
    await tick(); // the push's tick: the table is built and posted
    assert.equal(w.pub.writing(), true, 'posted to the worker: the main thread goes on');
    assert.equal(w.store.state.push, 1);
    assert.equal(JSON.parse(fs.readFileSync(w.store.files.state, 'utf8')).push, 1, 'P is on disk before its slots are written');
    // Asked for while that one is written: one more write, after it, with the newest state.
    w.at.n = 2;
    w.pub.publish({ push: true });
    w.pub.publish({});
    await waitFor(() => w.rings.length === 2 && !w.pub.writing(), 5000, 'both rings');
    for (const [i, ring] of w.rings.entries()) {
      assert.equal(ring.push, i + 1);
      for (const text of [...ring.files, ring.inbox]) assert.match(text, new RegExp(`bridge = \\{ push = ${i + 1}, n = ${i + 1} \\}`), 'the ring found its own publish on disk');
    }
    assert.equal(w.pub.stats().publishes, 2, 'the snapshot asked for meanwhile went with the second write');
    assert.equal(w.pub.stats().worker, 'running');
    assert.ok(w.logs.filter(l => l.k === 'publish').every(l => l.files === 201 && Number.isFinite(l.main) && l.main <= l.ms), 'each publish says its main-thread time beside its whole time');
    // The same table, written by the worker and then in place: the same 200 slots and inbox.
    w.at.n = 3;
    w.pub.publish({});
    await waitFor(() => w.pub.stats().publishes === 3 && !w.pub.writing(), 5000, 'the snapshot');
    const byWorker = [...everySlot(w.addons), w.inbox()];
    w.pub.flushNow();
    assert.equal(w.pub.stats().publishes, 4);
    assert.deepEqual([...everySlot(w.addons), w.inbox()], byWorker);
    // A window's plan reaches the worker: the table to 1-9, the rest emptied.
    range.plan = { from: 1, to: 9, blank: [[10, 200]] };
    w.at.n = 4;
    w.pub.publish({ push: true });
    await waitFor(() => w.rings.length === 3, 5000, 'the window\'s ring');
    assert.equal(w.logs.filter(l => l.k === 'publish').at(-1).window, '1-9');
    assert.match(slotFiles(w.addons, 9), /n = 4/);
    assert.equal(slotFiles(w.addons, 10), EMPTY_SLOT);
    // flushNow with a write in flight: that one lands (and rings) first, then this one, in place, now.
    range.plan = null;
    w.at.n = 5;
    w.pub.publish({ push: true });
    await tick();
    assert.equal(w.pub.writing(), true);
    w.at.n = 6;
    w.pub.flushNow();
    assert.equal(w.pub.writing(), false);
    assert.equal(w.rings.length, 4, 'the write in flight rang once its files were on disk');
    assert.match(w.rings[3].files[0], /push = 4, n = 5/);
    assert.match(slotFiles(w.addons, 200), /push = 4, n = 6/, 'and the flush is on disk when flushNow returns');
  } finally {
    w.pub.stop();
  }
  assert.equal(w.pub.stats().worker, 'stopped');
});

// The 1.4.1 revert (CI run 37127457103): with the slot files written a moment later by the worker, what a
// ringing publish's slot carries is fixed when it's built, not when it's written. A worker the test
// answers by hand (write-queue.mjs's surface): write() holds the job, answer() writes it as the worker would.
function manualWorker() {
  const held = [];
  const answer = (res) => { const { job, done } = held.shift(); done(res ?? writeSlots(job.addonsDir, job.text, job.inbox, job.opts)); };
  return { held, answer, write(job, done) { held.push({ job, done }); return true; }, drain() { while (held.length) answer(); }, stop() {}, state: () => 'running', busy: () => held.length > 0 };
}

test('publisher (code health BR-04, the 1.4.1 revert): an ack that comes while a ringing publish is being written keeps its ring owed (that slot was built without it); the next ringing publish pays it; one that writes nothing leaves the ring owed', async () => {
  const worker = manualWorker();
  const w = await workerPublisher(tmp(), { worker });
  const settled = async () => { await sleep(20); while (worker.held.length) { worker.answer(); await sleep(20); } };
  try {
    w.at.n = 1;
    w.pub.publish({ push: true }); // a reply: its slot is built now, written when the worker answers
    await tick();
    assert.equal(worker.held.length, 1, 'being written');
    w.pub.pushWithin(8000); // a message's ack, after that slot was built
    assert.equal(w.pub.owesRing(), true);
    worker.answer(); // the reply's slot is on disk: it rings
    assert.equal(w.rings.length, 1);
    assert.equal(w.pub.owesRing(), true, 'that slot doesn\'t carry the ack: its ring is still owed');
    await settled(); // the ack's snapshot (not rung)
    assert.equal(w.rings.length, 1);
    w.pub.publish({ push: true }); // the next ringing publish carries the ack
    await tick();
    worker.answer();
    assert.equal(w.rings.length, 2);
    assert.equal(w.pub.owesRing(), false, 'paid by a slot built after the ack');
    // A ringing publish that reached no file (a read-only AddOns) takes its P back and pays nothing.
    w.pub.pushWithin(8000);
    await settled();
    w.pub.publish({ push: true });
    await tick();
    worker.answer({ bytes: 0, errors: 201, files: 201, written: 0, retries: null });
    assert.equal(w.rings.length, 2, 'nothing written: nothing rung');
    assert.equal(w.pub.owesRing(), true, 'and the ack\'s ring is still owed');
  } finally {
    w.pub.stop();
  }
});

test('publisher (code health BR-04): a worker that can\'t start, dies with a write in flight, or never answers leaves the writes in place: every publish lands and rings after its files, said once in the log', async () => {
  const { createSlotWorker } = await import('../bridge/write-queue.mjs');
  const { pathToFileURL } = await import('node:url');
  const scripts = tmp();
  const cases = [
    ['start', 'error', 'no-such-worker.mjs', null, {}],
    ['dies', 'exit', 'dying-worker.mjs', "import { workerData } from 'node:worker_threads';\nworkerData.port.on('message', () => process.exit(3));\n", {}],
    ['hangs', 'timeout', 'silent-worker.mjs', "import { workerData } from 'node:worker_threads';\nworkerData.port.on('message', () => {});\n", { waitMs: 300 }],
  ];
  for (const [name, why, file, src, opts] of cases) {
    if (src) fs.writeFileSync(path.join(scripts, file), src);
    const logs = [];
    const writer = createSlotWorker({ log: (k, f) => logs.push({ k, ...f }), url: pathToFileURL(path.join(scripts, file)), ...opts });
    const w = await workerPublisher(tmp(), { worker: writer });
    try {
      w.at.n = 1;
      w.pub.publish({ push: true });
      if (name === 'hangs') { await sleep(50); w.pub.flushNow(); } else await waitFor(() => w.rings.length === 1, 5000, `${name}: the ring`);
      assert.equal(w.rings[0].push, 1, name);
      for (const text of [...w.rings[0].files, w.rings[0].inbox]) assert.match(text, /push = 1, n = 1/, `${name}: on disk before the ring`);
      assert.deepEqual(logs.filter(l => l.k === 'slot-worker-failed').map(l => l.why), [why], name);
      assert.equal(writer.state(), 'failed');
      // From then on, in place: a ringing publish is on disk at the push's tick.
      w.at.n = 2;
      w.pub.publish({ push: true });
      await tick();
      assert.equal(w.pub.writing(), false, name);
      assert.equal(w.rings.length, 2, name);
      assert.match(slotFiles(w.addons, 200), /n = 2/, name);
      assert.equal(logs.filter(l => l.k === 'slot-worker-failed').length, 1, `${name}: said once`);
    } finally {
      w.pub.stop();
    }
  }
});

// ---------------------------------------------------------------- the reload path's file (SY-04, Batch 2)

test('SavedVariables: the newest WTF/Account/*/SavedVariables/NeverQuestAlone.lua, looked up at each poll: two accounts, a stale folder, or none until the first login', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 3, iface: '16001' });
  const wtf = path.join(root, 'WTF');
  const gw = doubleGateway();
  const logs = [];
  const bridge = createBridge({ transport: { slots: 3 } }, {
    stateDir: path.join(root, 'state'), addonsDir: addons, log: (kind, f) => logs.push({ kind, ...f }), wtfDir: wtf,
    gatewayFactory: gw.factory, publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 5, alive: 5, act: 5 }, actGapMs: 5 },
  });
  const wire = (key, text) => Buffer.from(encodeRecord({ token: '3fa9c2d1', key, type: 'msg', chat: 'c3f9a1e', args: { cur: 0, agent: 'main', name: 'Q' }, text }), 'utf8').toString('hex');
  const sv = (account, key, text, mtime) => {
    const dir = path.join(wtf, 'Account', account, 'SavedVariables');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'NeverQuestAlone.lua');
    fs.writeFileSync(file, `NQADB = {\n\t["token"] = "3fa9c2d1",\n\t["outbox"] = {\n\t\t{\n\t\t\t["hex"] = "${wire(key, text)}",\n\t\t},\n\t},\n}\n`);
    fs.utimesSync(file, mtime, mtime);
  };
  bridge.start();
  try {
    await waitFor(() => bridge.status().gateway.state === 'ready', 2000, 'ready');
    bridge.pollSavedVariables(); // no account yet: nothing, no error
    fs.mkdirSync(path.join(wtf, 'Account', 'STALE#1'), { recursive: true }); // a folder with no file
    const t = Date.now() / 1000;
    sv('ACCOUNT#1', 'a3f1_1', 'from the first account', t - 60);
    sv('ACCOUNT#2', 'a3f1_2', 'from the second account', t - 10);
    bridge.pollSavedVariables();
    await waitFor(() => gw.sends.length === 1, 2000, 'the newest file read');
    assert.match(gw.sends[0].turn.typed, /second account/);
    // The first account plays next: its file is the newest now, and is read.
    sv('ACCOUNT#1', 'a3f1_3', 'the first account again', t);
    bridge.pollSavedVariables();
    await waitFor(() => gw.sends.length === 2, 2000, 'the other account read');
    assert.match(gw.sends[1].turn.typed, /first account again/);
    assert.ok(logs.some(l => l.kind === 'savedvariables-account'));
  } finally {
    await bridge.stop();
  }
});

// ---------------------------------------------------------------- a missed reply that says what one shown said (DREW-SY-06)

test('a missed reply (DREW-SY-06, code health BR-22): one with the same words as a reply shown, drawing another layer, found by outcomes() after its final was lost, is published with its drawing; asked again, nothing more', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 2, iface: '16001' });
  const CHAT = 'c3f9a1e';
  const done = new Map(); // runId → the reply outcomes() gives for it
  const sends = [];
  const gw = { handlers: null };
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: path.join(root, 'state'), addonsDir: addons, log: () => {},
    publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 20, alive: 20, act: 5 }, actGapMs: 5 },
    gatewayFactory: (handlers) => {
      gw.handlers = handlers;
      return {
        start() { handlers.onState({ state: 'ready', since: Date.now() }); handlers.onReady(); },
        stop() {},
        send: (args) => { sends.push(args); return { runId: args.idem, status: 'started' }; },
        outcomes: ids => ids.map(runId => (done.has(runId) ? { runId, chatId: CHAT, state: 'done', message: done.get(runId) } : { runId, state: 'running' })),
      };
    },
  });
  const WORDS = 'Marked it on your map.';
  const said = layer => `${WORDS}\n\n\`\`\`wowmap\n${JSON.stringify({ op: 'set', layer, title: layer, points: [{ m: 1412, x: 50, y: 50, label: layer }] })}\n\`\`\`\n`;
  const row = (seq, layer) => ({ role: 'assistant', content: [{ type: 'text', text: said(layer) }], __nqa: { seq, id: `byok:${CHAT}:${seq}` } });
  const replies = () => bridge.buildSlot().records.filter(r => r.t === 'reply');
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', 3000, 'ready');
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', chat: '', args: { cur: 0, ver: '1.5.2', sig: 'ok', slots: 200 } }));
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1_1', type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Route', ctx: 0 }, text: 'mark the camp' }));
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1_2', type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Route', ctx: 0 }, text: 'and the cave' }));
    await waitFor(() => sends.length === 2, 3000, 'the sends');
    // The first reply arrives live and draws "a"; the second, with the same words, drew "b" and its final was lost.
    gw.handlers.onEvent({ event: 'chat', payload: { state: 'final', chatId: CHAT, runId: sends[0].idem, message: row(1, 'a') } });
    assert.deepEqual(replies().map(r => r.drew), [['a']]);
    done.set(sends[1].idem, row(2, 'b'));
    bridge.checkRuns(true);
    assert.deepEqual(replies().map(r => [r.text, r.drew]), [[WORDS, ['a']], [WORDS, ['b']]], 'the missed reply is shown, with what it drew');
    assert.ok(bridge.buildSlot().map.layers.some(l => l.name === 'b'), 'and its layer is on the map');
    assert.equal(bridge.status().inflight, 0, 'both runs over');
    // A late final for it publishes nothing more: the run is shown.
    gw.handlers.onEvent({ event: 'chat', payload: { state: 'final', chatId: CHAT, runId: sends[1].idem, message: row(2, 'b') } });
    assert.equal(replies().length, 2);
  } finally { await bridge.stop(); }
});

test('code health BR-16: while the strip is unread mid-session (the game up and, for over 30 s, no payload and no frame decoded; or the watchdog\'s no_signal) a ringing publish writes every slot, at most once per 30 s and only for something new; a strip read again brings the window back', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const logs = [];
  // The 2 s tick every 20 ms here (ringEveryMs), on a clock the test moves.
  const { bridge, clock } = clockBridge(root, addons, logs, { ackRingMs: 0 }, { captureHealth: { platform: 'darwin' }, gameGate: true, gameHelper: true, ringEveryMs: 20 });
  bridge.start();
  const publishes = from => logs.slice(from).filter(l => l.kind === 'publish');
  // The window's slots and the inbox, nothing emptied (at most 9 + 1 files, so 12 is slack).
  const windowed = from => publishes(from).length > 0 && publishes(from).every(p => p.window === '5-13' && p.files <= 12);
  const ring = () => { bridge.publisher.publish({ push: true }); bridge.publisher.flushNow(); };
  try {
    const seen = slot => encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'seen', args: { cur: 0, p: 0, slot } });
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200, slot: 5 } }));
    assert.equal(bridge.status().game.state, 'up', 'a strip read: the game is up');
    // The start's publishes all made before the clock moves: the hello's answer, and the backend's
    // ready ring (onGatewayState's setTimeout 0), which a loaded runner's 201-file write can put after
    // a fixed sleep, so a snapshot below would take it along and ring (full suite, 2026-10-03).
    await waitFor(() => publishes(0).length > 0, 3000, 'the hello\'s answer');
    for (let n = -1; n !== publishes(0).length;) { n = publishes(0).length; await sleep(25); await new Promise(r => setImmediate(r)); }
    assert.deepEqual(win(bridge), ['report', 5, 13]);
    clock.t += 29_000;
    assert.deepEqual(win(bridge), ['report', 5, 13], 'under 30 s: the window holds');
    // A minute with the game up and nothing read off the screen: the addon's loads can't be followed.
    clock.t += 2_000;
    assert.deepEqual(win(bridge), ['report', 1, 200], 'a ringing publish now writes every slot');
    let mark = logs.length;
    bridge.publisher.flushNow(); // a snapshot: nothing new to read
    assert.ok(windowed(mark), 'a publish that doesn\'t ring keeps to the window');
    mark = logs.length;
    ring(); // a record, an ack: new to read
    assert.deepEqual(publishes(mark).map(p => p.files), [201], 'every slot and the inbox, once');
    // Inside the 30 s: a ringing publish keeps to the window, and its full write is owed.
    clock.t += 5_000;
    mark = logs.length;
    ring();
    assert.ok(windowed(mark), 'at most once per 30 s');
    assert.deepEqual(win(bridge), ['report', 5, 13]);
    assert.ok(tableIn(addons, 1) && tableIn(addons, 200), 'and it empties nothing: the full write\'s table stays where the blind addon loads');
    await sleep(100);
    assert.ok(windowed(mark), 'not before the 30 s are up');
    // Past the 30 s, the 2 s tick makes the owed one, and rings it.
    clock.t += 26_000;
    await waitFor(() => publishes(mark).some(p => p.files === 201), 2000, 'the owed full write');
    assert.ok(publishes(mark).find(p => p.files === 201).push > 0, 'rung');
    // Nothing new since: no more full writes, however long the strip stays unread.
    mark = logs.length;
    clock.t += 45_000;
    await sleep(100);
    bridge.publisher.flushNow();
    assert.ok(windowed(mark), 'nothing new: the window');
    // The helper's stats say it decodes the strip (one that doesn't change is sent once): read, so the window.
    bridge.onCaptureStatus({ stats: { interval: { frames: 40, decoded: 40, rejected: 0 }, frames: 400, decoded: 400, attached: true } });
    mark = logs.length;
    ring();
    assert.deepEqual(publishes(mark).map(p => p.window), ['5-13'], 'a decoded strip is a read one: the window (what\'s outside it emptied once)');
    // The strip read again: the window is back, at the new report, and what's outside it is emptied again.
    bridge.handlePayload(seen(6));
    assert.deepEqual(win(bridge), ['report', 6, 14]);
    bridge.publisher.flushNow();
    assert.ok(tableIn(addons, 6) && tableIn(addons, 14));
    for (const i of [1, 5, 15, 200]) assert.equal(slotFiles(addons, i), EMPTY_SLOT, `slot ${i} emptied again`);
  } finally {
    await bridge.stop();
  }
});

// BR-16 with the slot worker (BR-04, the 1.4.0 merge): the plan is asked for when a write starts, and
// what it wrote is booked when the worker answers.
test('code health BR-16 with the slot worker (BR-04): the full-range rule holds when a worker thread writes the slots: every slot once, the 30 s counted from that write\'s answer, and the owed full write made and rung', async () => {
  const root = tmp();
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 200, iface: '16001' });
  const logs = [];
  const { bridge, clock } = clockBridge(root, addons, logs, { ackRingMs: 0 }, { captureHealth: { platform: 'darwin' }, gameGate: true, gameHelper: true, ringEveryMs: 20,
    publisherOpts: { coalesceMs: 5, progressMs: 0, worker: true } });
  bridge.start();
  const publishes = from => logs.slice(from).filter(l => l.kind === 'publish');
  const windowed = from => publishes(from).length > 0 && publishes(from).every(p => p.window === '5-13' && p.files <= 12);
  const written = () => waitFor(() => !bridge.publisher.writing(), 3000, 'the worker\'s write');
  const ring = async () => { const n = publishes(0).length; bridge.publisher.publish({ push: true }); await waitFor(() => publishes(0).length > n, 3000, 'the ring\'s write'); await written(); };
  try {
    bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200, slot: 5 } }));
    await waitFor(() => publishes(0).length > 0, 3000, 'the hello\'s answer');
    for (let n = -1; n !== publishes(0).length;) { n = publishes(0).length; await sleep(40); await written(); }
    assert.equal(bridge.status().publishes.worker, 'running');
    assert.deepEqual(win(bridge), ['report', 5, 13]);
    clock.t += 31_000; // the game up, nothing read off the screen for over 30 s
    let mark = logs.length;
    await ring();
    assert.deepEqual(publishes(mark).map(p => p.files), [201], 'every slot and the inbox, once, by the worker');
    clock.t += 5_000;
    mark = logs.length;
    await ring();
    assert.ok(windowed(mark), 'inside the 30 s from the full write\'s answer: the window, nothing emptied');
    assert.ok(tableIn(addons, 1) && tableIn(addons, 200));
    clock.t += 26_000;
    await waitFor(() => publishes(mark).some(p => p.files === 201), 3000, 'the owed full write');
    assert.ok(publishes(mark).find(p => p.files === 201).push > 0, 'rung');
  } finally {
    await bridge.stop();
  }
});
