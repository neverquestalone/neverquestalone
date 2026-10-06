// Doorbells (docs/PROTOCOL.md §3, C-8): pulses delete a bell and recreate it,
// the two bells of a pair are never missing together, and the bridge re-rings
// push until the addon says (seen p=) that it has read the latest publish.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSignals, BELLS, PUSH_MIN_MS } from '../bridge/transport/signals.mjs';
import { installSlots } from '../bridge/transport/slots.mjs';
import { createBridge, RERING_FAST_MS, RERING_SLOW_MS, RERING_FOR_MS } from '../bridge/service.mjs';
import { encodeRecord } from '../bridge/transport/records.mjs';

// A clock and timers the test moves by hand.
function fakeTimers() {
  let now = 0;
  let id = 0;
  const due = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const t = ++id; due.set(t, { at: now + ms, fn }); return t; },
    clearTimeout(t) { due.delete(t); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let next = null;
        for (const [t, d] of due) if (d.at <= until && (!next || d.at < next[1].at)) next = [t, d];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = until;
    },
  };
}

function addons() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-bells-')), 'AddOns');
  installSlots(dir, { count: 2, iface: '16001' });
  return dir;
}
const bellFile = (dir, b) => path.join(dir, 'NeverQuestAlone', 'sig', 'ctl', `bell_${b}.wav`);
const armed = (dir, b) => fs.existsSync(bellFile(dir, b));

test('doorbells: setup makes every bell; a ring deletes one bell for its pulse, then recreates it', () => {
  const dir = addons();
  for (const b of BELLS) assert.ok(armed(dir, b), `${b} made at setup`);
  const clock = fakeTimers();
  const sig = createSignals(dir, { timers: clock });
  sig.ringPush();
  assert.equal(armed(dir, 'push_a'), false, 'push_a rung');
  assert.equal(armed(dir, 'push_b'), true);
  clock.advance(2999);
  assert.equal(armed(dir, 'push_a'), false);
  clock.advance(1);
  assert.equal(armed(dir, 'push_a'), true, 'back after 3 s');
  sig.ringPush();
  assert.equal(armed(dir, 'push_b'), false, 'the next ring uses the other bell');
  clock.advance(3000);
  assert.deepEqual(sig.stats().rings, { push_a: 1, push_b: 1, alive_a: 0, alive_b: 0, act: 0 });
});

test('doorbells: a ring during a pulse follows it on the other bell; the two of a pair are never missing together', () => {
  const dir = addons();
  const clock = fakeTimers();
  const sig = createSignals(dir, { timers: clock });
  sig.ringPush();
  clock.advance(1000);
  sig.ringPush();
  sig.ringPush(); // folds into the one that follows
  for (let t = 0; t < 8000; t += 100) {
    assert.ok(armed(dir, 'push_a') || armed(dir, 'push_b'), `a push bell present at ${t} ms`);
    clock.advance(100);
  }
  assert.equal(sig.stats().rings.push_a + sig.stats().rings.push_b, 2);
  sig.beat();
  assert.equal(armed(dir, 'alive_a'), false);
  clock.advance(2500);
  assert.equal(armed(dir, 'alive_a'), true);
  sig.beat();
  assert.equal(armed(dir, 'alive_b'), false, 'alive bells take turns');
});

test('doorbells (PF-03): a reply rung 400 ms after its ack starts its pulse within 1 s of the ack\'s, not after the ack\'s 3 s; then it lasts its whole pulse', () => {
  const dir = addons();
  const clock = fakeTimers();
  const sig = createSignals(dir, { timers: clock });
  assert.equal(PUSH_MIN_MS, 1000);
  sig.ringPush(); // the ack's publish
  clock.advance(400);
  sig.ringPush(); // the reply's, during the ack's pulse
  let t = 400;
  while (armed(dir, 'push_b') && t < 5000) {
    clock.advance(50);
    t += 50;
    assert.ok(armed(dir, 'push_a') || armed(dir, 'push_b'), `a push bell present at ${t} ms`);
  }
  assert.ok(t <= PUSH_MIN_MS, `the reply's bell rang at ${t} ms (before the cut: 3000 ms)`);
  assert.equal(armed(dir, 'push_a'), true, 'the ack\'s bell is back before the reply\'s went');
  // Nothing behind it: the reply's pulse keeps its whole 3 s, for a reader on the 2 s tick.
  clock.advance(2999);
  assert.equal(armed(dir, 'push_b'), false, 'still ringing at 2999 ms');
  clock.advance(1);
  assert.equal(armed(dir, 'push_b'), true, 'back at 3000 ms');
  assert.equal(sig.stats().rings.push_a + sig.stats().rings.push_b, 2);
});

test('doorbells (PF-03): rings asked for in one tick during a pulse still fold into one follow-up after the cut', () => {
  const dir = addons();
  const clock = fakeTimers();
  const sig = createSignals(dir, { timers: clock });
  sig.ringPush();
  clock.advance(1500);
  sig.ringPush();
  sig.ringPush();
  sig.ringPush();
  clock.advance(0);
  assert.equal(armed(dir, 'push_a'), true, 'cut at once: past its first second');
  assert.equal(armed(dir, 'push_b'), false);
  for (let t = 0; t < 6000; t += 100) {
    assert.ok(armed(dir, 'push_a') || armed(dir, 'push_b'), `a push bell present at ${t} ms`);
    clock.advance(100);
  }
  assert.equal(sig.stats().rings.push_a + sig.stats().rings.push_b, 2, 'the three rings behind it are one');
});

test('doorbells: act pulses queue with gaps a 4 Hz reader can see; stop puts every bell back', () => {
  const dir = addons();
  const clock = fakeTimers();
  const sig = createSignals(dir, { timers: clock });
  for (let i = 0; i < 12; i++) sig.act();
  let pulses = 0, was = true;
  for (let t = 0; t < 20000; t += 50) {
    const now = armed(dir, 'act');
    if (was && !now) pulses++;
    was = now;
    clock.advance(50);
  }
  assert.equal(pulses, 9, 'one pulsing and at most 8 waiting; extras dropped');
  sig.ringPush();
  sig.beat();
  sig.act();
  sig.stop();
  for (const b of BELLS) assert.ok(armed(dir, b), `${b} back in place after stop`);
});

test('doorbells: cleanup removes the v2.0 signal files and keeps the bells', () => {
  const dir = addons();
  const root = path.join(dir, 'NeverQuestAlone', 'sig');
  for (const [fam, name] of [['ack', 'a3f1_1'], ['push', '7'], ['act', 'a3f1_1_1'], ['presence', '59679030'], ['ctl', 'live_a3f1'], ['ctl', 'probe_a3f1']]) {
    fs.mkdirSync(path.join(root, fam), { recursive: true });
    fs.writeFileSync(path.join(root, fam, `${name}.wav`), '');
  }
  const sig = createSignals(dir);
  assert.equal(sig.cleanupLegacy(), 6);
  for (const b of BELLS) assert.ok(armed(dir, b));
  assert.ok(fs.existsSync(path.join(root, 'ctl', 'present.wav')));
});

// A link planted where the doorbells go is TH12's POSIX case (another account that can write AddOns).
const PLANTED_LINKS = process.platform === 'win32' ? 'making a symlink on Windows takes an administrator or Developer Mode; the Windows check is the AddOns folder\'s ACL (bridge/byok/wow.mjs broadWritersFromIcacls)' : false;

test('doorbells: cleanup never follows a link planted where sig/ or one of its folders goes (TH12, final review L3-3)', { skip: PLANTED_LINKS }, () => {
  // Another account that can write AddOns plants sig/push → the player's own folder; the player's
  // bridge must not delete that folder's .wav files.
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-victim-'));
  for (const f of ['song.wav', 'take2.wav', 'live_x.wav', 'notes.txt']) fs.writeFileSync(path.join(victim, f), 'mine');
  const dir = addons();
  const root = path.join(dir, 'NeverQuestAlone', 'sig');
  fs.mkdirSync(path.join(root, 'ack'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ack', 'a3f1_1.wav'), '');
  fs.symlinkSync(victim, path.join(root, 'push'));
  fs.rmSync(path.join(root, 'ctl'), { recursive: true });
  fs.symlinkSync(victim, path.join(root, 'ctl'));
  fs.symlinkSync(path.join(victim, 'song.wav'), path.join(root, 'ack', 'linked.wav'));
  const sig = createSignals(dir);
  assert.equal(sig.cleanupLegacy(), 1, 'only the real legacy file');
  assert.deepEqual(fs.readdirSync(victim).sort(), ['live_x.wav', 'notes.txt', 'song.wav', 'take2.wav']);
  // sig/ itself a link: nothing at all.
  const dir2 = addons();
  fs.rmSync(path.join(dir2, 'NeverQuestAlone', 'sig'), { recursive: true });
  fs.mkdirSync(path.join(victim, 'push'));
  fs.writeFileSync(path.join(victim, 'push', '7.wav'), 'mine');
  fs.symlinkSync(victim, path.join(dir2, 'NeverQuestAlone', 'sig'));
  assert.equal(createSignals(dir2).cleanupLegacy(), 0);
  assert.deepEqual(fs.readdirSync(path.join(victim, 'push')), ['7.wav']);
});

// What a folder outside AddOns holds, name → contents (a folder shows as '<dir>').
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map(f => {
  const st = fs.lstatSync(path.join(dir, f));
  return [f, st.isFile() ? fs.readFileSync(path.join(dir, f), 'utf8') : '<dir>'];
}));
const isLink = f => { try { return fs.lstatSync(f).isSymbolicLink(); } catch { return false; } };

test('doorbells: nothing is written or removed through a link planted at sig/ctl; setup puts a real folder back (TH12)', { skip: PLANTED_LINKS }, () => {
  // Another account that can write AddOns plants sig/ctl → the player's own folder, where some
  // files happen to carry bell names: a ring would delete them, ensure and stop would add bells.
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-victim-'));
  for (const f of ['bell_push_a.wav', 'bell_alive_a.wav', 'bell_act.wav', 'present.wav', 'notes.txt']) fs.writeFileSync(path.join(victim, f), 'mine');
  const before = snapshot(victim);
  const dir = addons();
  const ctl = path.join(dir, 'NeverQuestAlone', 'sig', 'ctl');
  fs.rmSync(ctl, { recursive: true });
  fs.symlinkSync(victim, ctl);
  const clock = fakeTimers();
  const logged = [];
  const sig = createSignals(dir, { timers: clock, log: (ev, o) => logged.push([ev, o.error]) });
  assert.deepEqual(sig.missingFolders(), ['ctl'], 'a link is not the ctl folder: run setup');
  assert.deepEqual(sig.ensure(), [], 'nothing made through the link');
  assert.equal(sig.isArmed('push_a'), false);
  sig.ringPush(); sig.beat(); sig.act();
  clock.advance(10000);
  sig.ringPush(); sig.beat();
  sig.stop();
  assert.deepEqual(snapshot(victim), before, 'the outside folder is untouched');
  assert.ok(isLink(ctl), 'the bridge removes nothing at ctl; setup replaces it');
  assert.ok(logged.length > 0 && logged.every(([ev, e]) => ev === 'signal-error' && e === 'ctl_not_a_folder'));
  // A link to an outside file where the folder goes: the same.
  const outside = path.join(victim, 'notes.txt');
  const dir2 = addons();
  const ctl2 = path.join(dir2, 'NeverQuestAlone', 'sig', 'ctl');
  fs.rmSync(ctl2, { recursive: true });
  fs.symlinkSync(outside, ctl2);
  const sig2 = createSignals(dir2, { timers: clock });
  assert.deepEqual(sig2.ensure(), []);
  sig2.ringPush(); clock.advance(3000); sig2.stop();
  assert.deepEqual(snapshot(victim), before);
  // Setup removes the link (never what it points to) and makes the bells; rings work again.
  installSlots(dir, { count: 2, iface: '16001' });
  assert.equal(isLink(ctl), false);
  assert.deepEqual(sig.missingFolders(), []);
  assert.deepEqual(sig.ensure(), []);
  sig.ringPush();
  assert.equal(armed(dir, 'push_a'), false, 'rung');
  clock.advance(3000);
  assert.equal(armed(dir, 'push_a'), true, 'back after 3 s');
  assert.deepEqual(snapshot(victim), before);
});

test('doorbells: a link planted at a bell\'s path is removed and the bell made; the file it points to is untouched (TH12)', { skip: PLANTED_LINKS }, () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-victim-'));
  const victim = path.join(outsideDir, 'zshrc');
  fs.writeFileSync(victim, 'mine\n');
  const dir = addons();
  const ctl = path.join(dir, 'NeverQuestAlone', 'sig', 'ctl');
  const plant = (name, target = victim) => { const f = path.join(ctl, name); fs.rmSync(f, { recursive: true, force: true }); fs.symlinkSync(target, f); return f; };
  // A link to an existing file (the plain existence check followed it and kept the link), and a
  // dangling one.
  plant('present.wav');
  plant('bell_push_a.wav');
  plant('bell_alive_a.wav', path.join(outsideDir, 'made-by-the-bell'));
  const clock = fakeTimers();
  const sig = createSignals(dir, { timers: clock });
  assert.equal(sig.isArmed('push_a'), false, 'a link is not a bell');
  assert.deepEqual(sig.ensure(), ['present', 'push_a', 'alive_a']);
  for (const f of ['present.wav', 'bell_push_a.wav', 'bell_alive_a.wav']) {
    assert.ok(fs.lstatSync(path.join(ctl, f)).isFile(), `${f} a plain file again`);
  }
  assert.deepEqual(snapshot(outsideDir), { zshrc: 'mine\n' }, 'nothing written, removed or made outside');
  // Planted again after start: a ring removes the link itself, and the bell comes back a file.
  plant('bell_push_a.wav');
  sig.ringPush();
  assert.equal(fs.existsSync(path.join(ctl, 'bell_push_a.wav')) || isLink(path.join(ctl, 'bell_push_a.wav')), false, 'the link is gone for the pulse');
  assert.equal(armed(dir, 'push_b'), true);
  clock.advance(3000);
  assert.ok(fs.lstatSync(path.join(ctl, 'bell_push_a.wav')).isFile());
  // Planted during a pulse: the bell made when it ends replaces the link.
  sig.ringPush();
  plant('bell_push_b.wav');
  clock.advance(3000);
  assert.ok(fs.lstatSync(path.join(ctl, 'bell_push_b.wav')).isFile());
  // stop() replaces one too.
  plant('bell_alive_b.wav');
  sig.stop();
  assert.ok(fs.lstatSync(path.join(ctl, 'bell_alive_b.wav')).isFile());
  assert.deepEqual(snapshot(outsideDir), { zshrc: 'mine\n' });
  // Only regular files and links are removed: a folder at a bell's path stays, and so does its file.
  const folder = path.join(ctl, 'bell_act.wav');
  fs.rmSync(folder);
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'mine');
  assert.deepEqual(sig.ensure(), []);
  sig.act(); clock.advance(2000); sig.stop();
  assert.equal(fs.readFileSync(path.join(folder, 'keep.txt'), 'utf8'), 'mine');
  // Normal rings still work, on time.
  sig.ringPush(); // the third push ring: push_a again
  assert.equal(armed(dir, 'push_a'), false);
  assert.equal(armed(dir, 'push_b'), true);
  clock.advance(2999);
  assert.equal(armed(dir, 'push_a'), false);
  clock.advance(1);
  assert.equal(armed(dir, 'push_a'), true, 'back after 3 s');
  assert.deepEqual(sig.stats().rings, { push_a: 2, push_b: 1, alive_a: 0, alive_b: 0, act: 1 });
});

test('bridge: push re-rings every 10 s six times, then every 60 s, until the addon reports p or 10 minutes pass', () => {
  const dir = addons();
  const clock = fakeTimers();
  const stateDir = path.join(path.dirname(dir), 'state');
  // A turn's ack rings at once here (ackRingMs 0): this is about the re-rings, not the ack's window.
  const bridge = createBridge({ transport: { slots: 2, ackRingMs: 0 } }, {
    stateDir, addonsDir: dir, now: clock.now,
    publisherOpts: { coalesceMs: 1 },
    signalsOpts: { timers: clock },
    gatewayFactory: () => ({ start() {}, stop() {} }),
  });
  const TOKEN = '3fa9c2d1';
  const rec = (type, args, key = 'a3f1', chat = '') => encodeRecord({ token: TOKEN, key, type, chat, args: { cur: 0, ...args }, text: type === 'msg' ? 'hi' : undefined });
  const rings = () => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
  bridge.handlePayload(rec('hello', { ver: '1.1.0', n: 0, ctx: 0, sig: 'ok', slots: 200 }));
  bridge.publisher.flushNow(); // the hello's answer: push rings once
  const P = bridge.status().push;
  assert.equal(rings(), 1);
  assert.equal(bridge.status().token.readPush, 0, 'not read yet');
  bridge.reRing();
  assert.equal(rings(), 1, 'nothing before 10 s');
  const ringAt = [];
  for (let t = 0; t <= RERING_FOR_MS + 120000; t += 1000) {
    clock.advance(1000);
    const before = rings();
    bridge.reRing();
    if (rings() > before) ringAt.push(clock.now());
  }
  const gaps = ringAt.map((t, i) => t - (i ? ringAt[i - 1] : 0));
  assert.deepEqual(gaps.slice(0, 6), [RERING_FAST_MS, RERING_FAST_MS, RERING_FAST_MS, RERING_FAST_MS, RERING_FAST_MS, RERING_FAST_MS]);
  assert.ok(gaps.slice(6).every(g => g === RERING_SLOW_MS), 'then every 60 s');
  assert.ok(ringAt.at(-1) <= RERING_FOR_MS, 'none past 10 minutes');
  // A new publish, then the addon says it read it: no re-rings.
  bridge.handlePayload(rec('msg', { agent: 'main', ctx: 0 }, 'a3f1_1', 'c3f9a1e'));
  clock.advance(5);
  bridge.publisher.flushNow();
  const n = rings();
  bridge.handlePayload(rec('seen', { p: bridge.status().push }));
  assert.equal(bridge.status().token.readPush, bridge.status().push);
  clock.advance(RERING_FAST_MS * 3);
  bridge.reRing();
  assert.equal(rings(), n, 'read: no re-ring');
  assert.ok(bridge.status().push > P);
});

// Code health BR-04: in stream and reload modes the addon draws no strip and reads no doorbell
// (Transport.lua T.SlotOnly: it loads slots on its own timers), so the bridge sounds none for it.
test('bridge (code health BR-04): a session in stream or reload mode reads no doorbell, so nothing rings for it: no push ring, re-ring or alive beat, while P and pushAt go on; its mode seen back to pixel, or a record of it off the strip, and the bells sound again', async () => {
  const dir = addons();
  const clock = fakeTimers();
  const logs = [];
  const bridge = createBridge({ transport: { slots: 2, ackRingMs: 0 } }, {
    stateDir: path.join(path.dirname(dir), 'state'), addonsDir: dir, now: clock.now, log: (k, f) => logs.push({ k, ...f }),
    publisherOpts: { coalesceMs: 1 }, signalsOpts: { timers: clock }, aliveEveryMs: 20,
    // A backend that never says it's ready: nothing is sent. This is about the bells, not the turn.
    gatewayFactory: () => ({ start() {}, stop() {} }),
  });
  const TOKEN = '3fa9c2d1';
  const rec = (type, args, key = 'a3f1', chat = '') => encodeRecord({ token: TOKEN, key, type, chat, args: { cur: 0, ...args }, text: type === 'msg' ? 'hi' : undefined });
  const rings = () => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
  const beats = () => { const r = bridge.signals.stats().rings; return r.alive_a + r.alive_b; };
  const reRings = () => logs.filter(l => l.k === 'rering').length;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  // Ten minutes of the core's 2 s re-ring checks, on the bridge's clock.
  const tenMinutes = () => { for (let t = 0; t < RERING_FOR_MS; t += 2000) { clock.advance(2000); bridge.reRing(); } };
  clock.advance(1000);
  bridge.start();
  try {
    // Screen Reading off: the hello comes from SavedVariables, saying stream.
    bridge.handlePayload(rec('hello', { ver: '1.3.2', n: 0, ctx: 0, sig: 'ok', slots: 200, slot: 1, mode: 'stream' }), 'reload');
    bridge.publisher.flushNow();
    assert.equal(bridge.status().push, 1, 'the hello\'s answer is counted');
    assert.equal(rings(), 0, 'and not rung');
    clock.advance(5000);
    assert.equal(bridge.status().reading.unreadMs, 5000, 'pushAt as ever');
    tenMinutes();
    assert.deepEqual([rings(), reRings()], [0, 0], 'no re-rings');
    const b0 = beats();
    await wait(120);
    assert.equal(beats(), b0, 'no alive beat');
    // The player turns Screen Reading on again: the mode seen, on the strip and from then on read there.
    bridge.handlePayload(rec('seen', { mode: 'pixel' }));
    bridge.handlePayload(rec('msg', { agent: 'main', ctx: 0 }, 'a3f1_1', 'c3f9a1e'));
    bridge.publisher.flushNow();
    assert.equal(rings(), 1, 'its ack rings');
    clock.advance(10_001);
    bridge.reRing();
    assert.equal(rings(), 2, 'and is rung again while unread');
    await wait(120);
    assert.ok(beats() > b0, 'the beat is back');
    // Turned off again (the mode seen says so, with what it read): the next ack isn't rung.
    bridge.handlePayload(rec('seen', { mode: 'stream', p: bridge.status().push }));
    bridge.handlePayload(rec('msg', { agent: 'main', ctx: 0 }, 'a3f1_2', 'c3f9a1e'), 'reload');
    bridge.publisher.flushNow();
    assert.equal(rings(), 2, 'stream again: the ack isn\'t rung');
    // A record of the session read off the strip: only pixel mode draws one (stream and reload draw a
    // mode seen alone), so the bells are read again, even by a bridge that never heard the mode seen.
    clock.advance(3000); // the re-ring's pulse is over
    bridge.handlePayload(rec('msg', { agent: 'main', ctx: 0 }, 'a3f1_3', 'c3f9a1e'));
    bridge.publisher.flushNow();
    assert.equal(rings(), 3, 'a record off the strip: rung');
    // A new UI session in reload mode (/nqa mode reload): silent from its hello on.
    bridge.handlePayload(rec('hello', { ver: '1.3.2', n: 3, ctx: 0, sig: 'ok', slots: 200, slot: 1, mode: 'reload' }, 'b4f2'), 'reload');
    bridge.publisher.flushNow();
    assert.equal(bridge.status().token.nonce, 'b4f2');
    tenMinutes();
    assert.equal(rings(), 3, 'reload mode: nothing rung');
  } finally {
    await bridge.stop();
  }
});

// The 1.4.1 revert (CI run 37127457103): a publish the slot worker is still writing isn't on disk, so
// nothing may ring for it yet, and status().push names the last one that is.
test('bridge (code health BR-04, the 1.4.1 revert): a re-ring never sounds for a publish still being written, and status().push is the last publish on disk; its own ring comes once its files are', async () => {
  const dir = addons();
  const clock = fakeTimers();
  const held = [];
  const { writeSlots } = await import('../bridge/transport/slots.mjs');
  const answer = () => { const { job, done } = held.shift(); done(writeSlots(job.addonsDir, job.text, job.inbox, job.opts)); };
  const worker = { write(job, done) { held.push({ job, done }); return true; }, drain() { while (held.length) answer(); }, stop() {}, state: () => 'running', busy: () => held.length > 0 };
  const bridge = createBridge({ transport: { slots: 2, ackRingMs: 0 } }, {
    stateDir: path.join(path.dirname(dir), 'state'), addonsDir: dir, now: clock.now,
    publisherOpts: { coalesceMs: 1, worker }, signalsOpts: { timers: clock },
    gatewayFactory: () => ({ start() {}, stop() {} }),
  });
  const TOKEN = '3fa9c2d1';
  const rec = (type, args, key = 'a3f1', chat = '') => encodeRecord({ token: TOKEN, key, type, chat, args: { cur: 0, ...args }, text: type === 'msg' ? 'hi' : undefined });
  const rings = () => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
  const tick = () => new Promise(r => setImmediate(r));
  clock.advance(1000);
  bridge.handlePayload(rec('hello', { ver: '1.4.1', n: 0, ctx: 0, sig: 'ok', slots: 200, mode: 'pixel' }));
  await tick();
  answer(); // the hello's answer on disk, rung
  assert.deepEqual([rings(), bridge.status().push], [1, 1]);
  bridge.handlePayload(rec('seen', { p: 1 })); // the addon read it
  clock.advance(3000);
  clock.advance(60_000); // a minute on: P=1 rang long ago
  bridge.handlePayload(rec('msg', { agent: 'main', ctx: 0 }, 'a3f1_1', 'c3f9a1e'));
  await tick(); // its ack's ringing publish (P=2) is built and posted
  assert.equal(held.length, 1, 'P=2 is being written');
  assert.equal(bridge.status().push, 1, 'status().push: the last publish on disk');
  for (let i = 0; i < 5; i++) { clock.advance(2000); bridge.reRing(); }
  assert.equal(rings(), 1, 'no ring while P=2 isn\'t on disk: a ring always finds its publish');
  answer();
  assert.deepEqual([rings(), bridge.status().push], [2, 2], 'on disk: rung');
  await bridge.stop();
});

// D-29, the bridge's half (display DR-04, H12): while no_signal is published the strip can't answer a
// re-ring, and each one costs the addon a slot load of its 200; the ok's own ring catches it up.
test('bridge (display DR-04): re-rings pause while the capture watchdog publishes no_signal, and resume after the ok', () => {
  const dir = addons();
  const clock = fakeTimers();
  const stateDir = path.join(path.dirname(dir), 'state');
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir, addonsDir: dir, now: clock.now,
    publisherOpts: { coalesceMs: 1 },
    signalsOpts: { timers: clock },
    captureHealth: { platform: 'win32', thresholds: { accessLostWaitMs: 0 } },
    gatewayFactory: () => ({ kind: 'byok', start() {}, stop() {} }),
  });
  const TOKEN = '3fa9c2d1';
  const rec = (type, args, key = 'a3f1', chat = '') => encodeRecord({ token: TOKEN, key, type, chat, args: { cur: 0, ...args } });
  const rings = () => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
  bridge.handlePayload(rec('hello', { ver: '1.5.2', n: 0, ctx: 0, sig: 'ok', slot: 3, mode: 'pixel' }));
  bridge.publisher.flushNow();
  assert.equal(rings(), 1, 'the hello\'s answer');
  // Duplication lost for good (Windows access_lost, past its wait): no_signal, rung.
  bridge.onCaptureStatus({ connected: true });
  bridge.onCaptureError({ kind: 'access_lost', message: 'x' });
  clock.advance(1000);
  bridge.captureHealth.tick();
  assert.equal(bridge.captureHealth.state(), 'no_signal');
  bridge.publisher.flushNow();
  clock.advance(5000); // a ring during the hello's pulse follows it
  const n = rings();
  assert.equal(n, 2, 'the no_signal publish rang');
  // An hour of the 2 s timer: no re-ring, though nothing was read.
  for (let t = 0; t < 3_600_000; t += 2000) { clock.advance(2000); bridge.reRing(); }
  assert.equal(rings(), n, 'paused');
  // The helper says it reads again: ok, rung; and an unread publish is re-rung again.
  bridge.onCaptureStatus({ error: null });
  bridge.publisher.flushNow();
  clock.advance(5000);
  assert.equal(bridge.captureHealth.state(), 'ok');
  assert.equal(rings(), n + 1, 'the ok rang');
  clock.advance(RERING_FAST_MS);
  bridge.reRing();
  assert.equal(rings(), n + 2, 're-rung while unread');
});

// The screen-reading switch (SY-01): off (the app's switch, the watchdog's off()), nothing can say a ring
// was read, so a publish rings once and is never re-rung; the addon hears that one ring and loads.
test('bridge (the screen-reading switch): with screen reading off a publish rings once and is never re-rung; on again, an unread publish is re-rung', () => {
  const dir = addons();
  const clock = fakeTimers();
  const stateDir = path.join(path.dirname(dir), 'state');
  let off = false;
  const bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir, addonsDir: dir, now: clock.now,
    publisherOpts: { coalesceMs: 1 },
    signalsOpts: { timers: clock },
    captureHealth: { platform: 'darwin', off: () => off },
    gatewayFactory: () => ({ kind: 'byok', start() {}, stop() {} }),
  });
  const TOKEN = '3fa9c2d1';
  const rec = (type, args, key = 'a3f1', chat = '') => encodeRecord({ token: TOKEN, key, type, chat, args: { cur: 0, ...args } });
  const rings = () => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
  bridge.handlePayload(rec('hello', { ver: '1.5.2', n: 0, ctx: 0, sig: 'ok', slot: 3, mode: 'pixel' }));
  bridge.publisher.flushNow();
  clock.advance(5000);
  const n = rings();
  assert.ok(n >= 1, 'the hello\'s answer rang');
  // Off in the app: the watchdog says off; a publish rings once; an hour of the 2 s timer rings nothing more.
  off = true;
  bridge.captureHealth.tick();
  assert.equal(bridge.captureHealth.state(), 'off');
  bridge.publisher.publish({ push: true });
  bridge.publisher.flushNow();
  clock.advance(5000);
  const once = rings();
  assert.ok(once > n, 'the publish rang once');
  for (let t = 0; t < 3_600_000; t += 2000) { clock.advance(2000); bridge.reRing(); }
  assert.equal(rings(), once, 'never re-rung while off');
  // On again: an unread publish is re-rung as before.
  off = false;
  bridge.captureHealth.tick();
  bridge.publisher.publish({ push: true });
  bridge.publisher.flushNow();
  clock.advance(5000);
  const on = rings();
  clock.advance(RERING_FAST_MS);
  bridge.reRing();
  assert.equal(rings(), on + 1, 're-rung while unread');
});
