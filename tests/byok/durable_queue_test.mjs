// Code health BR-04 (durable writes): one ordered queue, on the slot worker's thread
// (bridge/write-queue.mjs), for the slot files and every write of the outbox, the ledger and
// state.json. The money path's four ordering rules, each against a deliberately wrong ordering too, to
// show the check can catch one:
//   (a) a kill (the whole process) or the worker's death between a message's durable outbox write and
//       its ack's slot never leaves the ack on disk without the message (a queue that puts the slot
//       first is caught);
//   (b) FIFO across kinds: a quick write never lands before an earlier durable one, nor a slot write
//       (quick writes that skip the queue are caught);
//   (c) the ledger's 'sending' mark is fsynced before the provider sees the request, both times a held
//       turn marks it (a writer that answers before the mark is on disk is caught);
//   (d) the main thread's fallback (a worker that can't start, dies or hangs) writes what's left in the
//       same order, a publish asked for while it does so included.
// Then the store's and the ledger's own halves of it: what a queued write's answer does (BR-11's owed
// writes and health), and the ledger's startup report written before anything is booked.
// The worker is the real one (serveJobs, runJob) with a test's hooks around its jobs
// (tests/byok/helpers/hooked-writer.mjs): a slow disk, a kill, a death, a hang.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createBridge } from '../../bridge/service.mjs';
import { openStore } from '../../bridge/app/store.mjs';
import { createLedger } from '../../bridge/byok/ledger.mjs';
import { createSlotWorker } from '../../bridge/write-queue.mjs';
import { installSlots } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { startMock, reply, makeBackend, sendParams, canaryKeystore, waitFor, sleep, tmpDir } from './helpers/byok-env.mjs';

const HOOKED = pathToFileURL(path.join(import.meta.dirname, 'helpers', 'hooked-writer.mjs'));
const KILL_CHILD = path.join(import.meta.dirname, 'helpers', 'durable-kill-child.mjs');
const TOKEN = '3fa9c2d1';
const NONCE = 'a3f1';
const CHAT = 'c3f9a1e';
const KEY = `${NONCE}_1`;
const OUTBOX_DURABLE = { kind: 'file', base: 'outbox.jsonl', durable: true };

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const ackedIn = text => { const m = /acked = \{([^}]*)\}/.exec(text || ''); return m ? [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]) : []; };
const keysIn = text => (text || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).key; } catch { return null; } });
const slotFiles = addons => [1, 2, 3].map(i => path.join(addons, `NQA_S00${i}`, 'Inbox.lua')).concat(path.join(addons, 'NeverQuestAlone', 'Inbox.lua'));
const idle = (writer, what = 'the queue empty') => waitFor(() => !writer.busy(), 10000, what);

/** The real worker with hooks (helpers/hooked-writer.mjs); its log lines (job-done …) go to logs. */
function hooked({ hooks = [], watch = [], spyFsync = false, arm = null, startDelayMs = 0, logs = [], ...opts } = {}) {
  return createSlotWorker({ url: HOOKED, data: { serve: false, hooks, watch, spyFsync, arm, startDelayMs }, log: (k, d) => logs.push({ k, ...d }), ...opts });
}

function addonsIn(root) {
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 3, iface: '16001' });
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true });
  return addons;
}

// Every file the main thread renames into place, as it happens (the takeover's writes are the main
// thread's): a slot that brings the ack in while the outbox on disk doesn't hold the message is a
// violation. order: what came in, in turn (outbox: its keys; a slot: whether it carries the ack).
function watchRenames(stateDir) {
  const real = fs.renameSync;
  const out = { violations: [], order: [] };
  const outbox = path.join(stateDir, 'outbox.jsonl');
  fs.renameSync = function (from, to, ...a) {
    const base = path.basename(String(to));
    if (base === 'Inbox.lua' && ackedIn(read(from)).includes(KEY)) {
      const kept = keysIn(read(outbox)).includes(KEY);
      out.order.push({ slot: path.basename(path.dirname(String(to))), ack: true, kept });
      if (!kept) out.violations.push(`${path.basename(path.dirname(String(to)))} took the ack while the outbox didn't hold ${KEY}`);
    } else if (base === 'outbox.jsonl') out.order.push({ outbox: keysIn(read(from)) });
    return real.call(this, from, to, ...a);
  };
  out.restore = () => { fs.renameSync = real; };
  return out;
}

/**
 * A bridge (the real core, its store, publisher and backend's queue on one writer) whose backend can't
 * take a send (NOT_READY), so a message stays in the outbox. Its hello is answered and its writes are on disk
 * before it returns. say(): the typed message (KEY); acks(): the slot files on disk that carry its ack.
 */
async function scene(writer, { root = tmpDir('nqa-queue-'), logs = [] } = {}) {
  const addons = addonsIn(root);
  const stateDir = path.join(root, 'state');
  const bridge = createBridge({ transport: { slots: 3, ackRingMs: 0 } }, {
    stateDir, addonsDir: addons, log: (k, d) => logs.push({ k, ...d }),
    publisherOpts: { coalesceMs: 1, progressMs: 0, worker: writer },
    gatewayFactory: h => ({
      start() { h.onState({ state: 'ready', since: Date.now() }); h.onReady(); },
      stop() {},
      send: () => { throw new Error('NOT_READY: held for this test'); },
    }),
  });
  bridge.start();
  bridge.handlePayload(encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200 } }));
  await waitFor(() => bridge.status().publishes.publishes > 0, 10000, 'the hello\'s answer');
  for (let i = 0; i < 3; i++) { await idle(writer); await sleep(30); }
  const rings = () => { const r = bridge.signals.stats().rings; return r.push_a + r.push_b; };
  return {
    bridge, root, addons, stateDir, logs, rings,
    say: () => bridge.handlePayload(encodeRecord({ token: TOKEN, key: KEY, type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Q' }, text: 'where next?' })),
    acks: () => slotFiles(addons).filter(f => ackedIn(read(f)).includes(KEY)),
    kept: () => keysIn(read(path.join(stateDir, 'outbox.jsonl'))).includes(KEY),
  };
}

// ------------------------------------------------------------------------------------------- (a)

test('code health BR-04 (a): the process killed between a message\'s durable outbox write and its ack\'s slot: the ack is never on disk without the message; a queue that puts the slot first is caught', () => {
  const run = (order, point) => {
    const root = tmpDir('nqa-kill-');
    const r = spawnSync(process.execPath, [KILL_CHILD, root, order, point], { encoding: 'utf8', timeout: 60_000 });
    const marker = read(path.join(root, 'killed.json'));
    return {
      r, killed: marker ? JSON.parse(marker) : null,
      acks: slotFiles(path.join(root, 'AddOns')).filter(f => ackedIn(read(f)).includes(KEY)),
      kept: keysIn(read(path.join(root, 'state', 'outbox.jsonl'))).includes(KEY),
    };
  };
  for (const point of ['before', 'after']) {
    const k = run('fifo', point);
    assert.deepEqual(k.killed, { kind: 'file', base: 'outbox.jsonl', durable: true, at: point, then: 'kill' },
      `${point}: killed at the message's durable outbox write (exit ${k.r.status}, ${k.r.signal}; ${String(k.r.stderr).slice(-400)})`);
    assert.notEqual(k.r.status, 0);
    assert.notEqual(k.r.status, 3, 'killed, not timed out');
    assert.deepEqual(k.acks, [], `${point}: no slot on disk carries the ack (it was queued behind the outbox write)`);
    assert.equal(k.kept, point === 'after', point === 'after' ? 'after it: the message is in the outbox (written durably)' : 'before it: the message isn\'t on disk, and neither is its ack');
  }
  // The deliberately wrong queue: the outbox's write behind the ack's slot. The same kill finds the
  // ack on disk and the message nowhere: the check above would have failed.
  const wrong = run('reordered', 'before');
  assert.ok(wrong.killed, `the wrong queue was killed at the outbox write too (${String(wrong.r.stderr).slice(-300)})`);
  assert.ok(wrong.acks.length > 0 && !wrong.kept, `caught: ${wrong.acks.length} slot(s) carry the ack, the outbox ${wrong.kept ? 'holds' : 'doesn\'t hold'} the message`);
});

test('code health BR-04 (a): the worker dying before or after a message\'s durable outbox write: the main thread writes the rest in order, the message first; no slot takes the ack before the outbox holds it, and the ring comes after both', async () => {
  for (const at of ['before', 'after']) {
    const logs = [];
    const writer = hooked({ logs, hooks: [{ match: OUTBOX_DURABLE, at, then: 'exit', ...(at === 'after' ? { delayAfterMs: 200 } : { delayMs: 200 }) }] });
    const s = await scene(writer, { logs });
    const spy = watchRenames(s.stateDir);
    try {
      const rung = s.rings();
      s.say();
      await waitFor(() => s.rings() > rung && s.acks().length > 0, 10000, `${at}: the ack's ring`);
      assert.deepEqual(logs.filter(l => l.k === 'slot-worker-failed').map(l => l.why), ['exit'], at);
      assert.equal(writer.state(), 'failed');
      assert.ok(s.kept(), `${at}: the message is in the outbox`);
      assert.deepEqual(spy.violations, [], at);
      const first = spy.order.findIndex(o => o.ack);
      assert.ok(first >= 0, `${at}: the ack's slot was written by the main thread`);
      if (at === 'before') assert.ok(spy.order.slice(0, first).some(o => o.outbox?.includes(KEY)), 'the outbox write the worker never made, made first');
    } finally {
      spy.restore();
      await s.bridge.stop();
    }
  }
});

// ------------------------------------------------------------------------------------------- (b)

test('code health BR-04 (b): FIFO across kinds: a slow durable outbox write is never overtaken by the quick state.json writes and the slot write queued after it; quick writes that skip the queue are caught', async () => {
  const runOrder = async (wrong) => {
    const root = tmpDir('nqa-fifo-');
    const addons = addonsIn(root);
    const stateDir = path.join(root, 'state');
    const files = { outbox: path.join(stateDir, 'outbox.jsonl'), state: path.join(stateDir, 'state.json'), slot: path.join(addons, 'NQA_S001', 'Inbox.lua') };
    const logs = [];
    const writer = hooked({ logs, watch: Object.values(files), hooks: [{ match: OUTBOX_DURABLE, delayMs: 250 }] });
    // The wrong queue: a quick write of a file goes in place, at once (as if only durable writes were queued).
    const w = wrong ? { ...writer, writeFile: (job, done) => (job.durable ? writer.writeFile(job, done) : false) } : writer;
    const store = openStore(stateDir, { writer: w });
    try {
      await idle(writer);
      logs.length = 0;
      // In this order: state.json (quick: the flush an outbox write makes first), the outbox (durable,
      // slow), a slot table, state.json again (quick), and the outbox again.
      store.state.seq = 7;
      store.saveState();
      store.addOutbox({ token: TOKEN, key: 'k1', chat: CHAT, kind: 'msg', text: 'one' });
      assert.equal(read(files.outbox), null, 'queued, not written in place');
      writer.write({ addonsDir: addons, text: 'NQA_SlotData = { n = 1 }\n', inbox: 'NQA_Inbox = { n = 1 }\n', opts: { count: 3 } }, () => {});
      store.state.seq = 8;
      store.saveState();
      store.flush();
      store.removeOutbox(TOKEN, 'k1');
      await idle(writer);
      const done = logs.filter(l => l.k === 'job-done');
      const durable = done.find(d => d.base === 'outbox.jsonl' && d.durable);
      return { done, durable, files, final: { outbox: keysIn(read(files.outbox)), seq: JSON.parse(read(files.state)).seq, slot: read(files.slot) } };
    } finally { writer.stop(); }
  };
  const r = await runOrder(false);
  assert.deepEqual(r.done.map(d => d.base ?? d.kind), ['state.json', 'outbox.jsonl', 'slots', 'state.json', 'outbox.jsonl'], 'written in the order queued');
  assert.equal(r.done[1].durable, true);
  // When the slow durable write landed, nothing queued after it had.
  assert.deepEqual(keysIn(r.durable.files[r.files.outbox]), ['k1']);
  assert.equal(JSON.parse(r.durable.files[r.files.state]).seq, 7, 'the later state.json (seq 8) not yet');
  assert.doesNotMatch(r.durable.files[r.files.slot] ?? '', /n = 1/, 'nor the slot table');
  assert.deepEqual([r.final.outbox, r.final.seq], [[], 8], 'and in the end, the newest of each');
  assert.match(r.final.slot, /n = 1/);
  // Quick writes in place: the later state.json is on disk before the earlier durable write lands.
  const wrong = await runOrder(true);
  assert.equal(JSON.parse(wrong.durable.files[wrong.files.state]).seq, 8, 'caught: a quick write landed before the durable one queued ahead of it');
});

// ------------------------------------------------------------------------------------------- (c)

test('code health BR-04 (c): the ledger\'s \'sending\' mark is fsynced before the provider sees the request, both times a turn held for the network marks it; a writer that answers before the mark is on disk is caught', async () => {
  const runTurn = async (lying) => {
    const mock = await startMock(() => reply('Head east.\n\nTL;DR: east.'));
    const logs = [];
    // Every durable ledger write waits 600 ms in the worker (a slow disk), and says what it fsynced.
    const writer = hooked({ logs, spyFsync: true, hooks: [{ match: { kind: 'file', base: 'ledger.json', durable: true }, delayMs: 600, every: true }] });
    // The wrong writer: it says a write is done as soon as it's queued.
    const w = lying ? { ...writer, writeFile(job, done) { const queued = writer.writeFile(job, () => {}); if (queued) setImmediate(() => done({ ok: true })); return queued; } } : writer;
    const dataDir = tmpDir('nqa-ledger-order-');
    const ledgerFile = path.join(dataDir, 'ledger.json');
    const p = sendParams(CHAT, 'k1', 'still there?');
    // The provider as the scripted fetch sees it: each request, with the turn's ledger entry as it is on
    // disk at that moment. The first one never connects (nothing left: the turn is held, then marked again).
    const seen = [];
    const fetch = async (url, init) => {
      if (init?.method === 'POST') {
        seen.push({ at: Date.now(), onDisk: JSON.parse(read(ledgerFile) || '{"entries":{}}').entries[p.idem]?.state ?? null });
        if (seen.length === 1) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      }
      return globalThis.fetch(url, init);
    };
    const env = makeBackend({ url: mock.url, dataDir, keystore: await canaryKeystore(), writer: w, fetch, holdProbeMs: { first: 20, max: 20 } });
    try {
      await env.backend.start();
      await env.backend.send(p);
      await waitFor(() => env.chats('final').length + env.chats('error').length > 0, 15000, 'the turn\'s end');
      await idle(writer);
      return { seen, logs, final: env.chats('final').length, ledger: env.backend.ledger.get(p.idem)?.state, dataDir };
    } finally { await env.backend.stop(); writer.stop(); await mock.close(); }
  };
  const r = await runTurn(false);
  assert.equal(r.final, 1, 'the reply');
  assert.equal(r.ledger, 'done');
  assert.deepEqual(r.seen.map(s => s.onDisk), ['sending', 'sending'], 'each request found its turn marked on disk');
  const marks = r.logs.filter(l => l.k === 'job-done' && l.base === 'ledger.json' && l.durable);
  assert.equal(marks.length, 2, 'two durable writes: the first mark, and the mark again after the hold');
  for (const [i, m] of marks.entries()) {
    const tmp = m.fsyncs.find(f => /^\.ledger\.json\..*\.tmp$/.test(path.basename(f.file)));
    assert.ok(tmp?.ok, `mark ${i + 1}: the file fsynced (${JSON.stringify(m.fsyncs)})`);
    // Its folder's too, where the system allows it (Windows refuses a folder's fsync; writeFileDurable goes on).
    assert.ok(m.fsyncs.some(f => path.basename(f.file) === path.basename(r.dataDir) && (f.ok || process.platform === 'win32')), `mark ${i + 1}: its folder fsynced`);
    assert.ok(m.fsyncs.every(f => f.at <= r.seen[i].at) && m.at <= r.seen[i].at, `mark ${i + 1}: fsynced before the request`);
  }
  // Answered before the write: the first request finds the turn only 'queued' on disk.
  const wrong = await runTurn(true);
  assert.notEqual(wrong.seen[0]?.onDisk, 'sending', 'caught: a request went out before its mark was on disk');
});

// ------------------------------------------------------------------------------------------- (d)

test('code health BR-04 (d): a worker that can\'t start, dies at the outbox write or hangs there (without the job lock) leaves the rest to the main thread, in the same order: the message before its ack, the ring after; then everything in place', async () => {
  const cases = [
    ['missing', 'error', logs => createSlotWorker({ url: pathToFileURL(path.join(tmpDir('nqa-noworker-'), 'no-such-worker.mjs')), log: (k, d) => logs.push({ k, ...d }) })],
    ['dies', 'exit', logs => hooked({ logs, hooks: [{ match: OUTBOX_DURABLE, delayMs: 200, then: 'exit' }] })],
    ['hangs', 'timeout', logs => hooked({ logs, watchMs: 300, hooks: [{ match: OUTBOX_DURABLE, then: 'hang' }] })],
  ];
  for (const [name, why, make] of cases) {
    const logs = [];
    const writer = make(logs);
    const s = await scene(writer, { logs });
    const spy = watchRenames(s.stateDir);
    try {
      const rung = s.rings();
      s.say();
      await waitFor(() => s.rings() > rung && s.acks().length > 0, 10000, `${name}: the ack's ring`);
      assert.deepEqual(logs.filter(l => l.k === 'slot-worker-failed').map(l => l.why), [why], name);
      assert.equal(writer.state(), 'failed', name);
      assert.ok(s.kept(), name);
      assert.deepEqual(spy.violations, [], name);
      const first = spy.order.findIndex(o => o.ack);
      assert.ok(spy.order.slice(0, first).some(o => o.outbox?.includes(KEY)), `${name}: the message's outbox write before the ack's slot`);
      // From here on, in place: the next message is in the outbox when handlePayload returns.
      s.bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${NONCE}_2`, type: 'msg', chat: 'c4b2d0f', args: { cur: 0, agent: 'main', name: 'R' }, text: 'and then?' }));
      assert.ok(keysIn(read(path.join(s.stateDir, 'outbox.jsonl'))).includes(`${NONCE}_2`), `${name}: written in place`);
      assert.equal(writer.busy(), false);
    } finally {
      spy.restore();
      await s.bridge.stop();
    }
  }
});

test('code health BR-04 (d): the worker dying in a slot write with the message\'s outbox write queued behind it, and a publish asked for meanwhile: the main thread writes the queue in order, and the publish that carries the ack goes behind the outbox write, not before it', async () => {
  const logs = [];
  const arm = new SharedArrayBuffer(4);
  // The next slot write after the test arms the rule: held 300 ms, then the thread ends.
  const writer = hooked({ logs, arm, hooks: [{ match: { kind: 'slots' }, armed: true, delayMs: 300, then: 'exit' }] });
  const s = await scene(writer, { logs });
  const spy = watchRenames(s.stateDir);
  try {
    const rung = s.rings();
    Atomics.store(new Int32Array(arm), 0, 1);
    s.bridge.publisher.publish({ push: true }); // a ringing publish: its slot write is the one that dies
    await waitFor(() => s.bridge.publisher.writing(), 5000, 'that slot write in the worker');
    s.say(); // the message's outbox write queues behind it, and its ack's publish waits for it (again)
    // (Two rings this close are one pulse of the bell: signals.mjs.)
    await waitFor(() => s.rings() > rung && s.acks().length > 0 && !s.bridge.publisher.writing(), 10000, 'the ring, the ack on disk');
    assert.deepEqual(logs.filter(l => l.k === 'slot-worker-failed').map(l => l.why), ['exit']);
    assert.deepEqual(spy.violations, []);
    const first = spy.order.findIndex(o => o.ack);
    assert.ok(spy.order.slice(0, first).some(o => o.outbox?.includes(KEY)), 'the outbox write first');
  } finally {
    spy.restore();
    await s.bridge.stop();
  }
});

test('code health BR-04 (d): a worker slow in a job (holding the job lock) past its watch is waited for, not taken over: its write lands once, in order, and the queue goes on in the worker', async () => {
  const logs = [];
  const root = tmpDir('nqa-slow-');
  const file = n => path.join(root, `f${n}.json`);
  const writer = hooked({ logs, watchMs: 100, hooks: [{ match: { kind: 'file', base: 'f1.json' }, delayMs: 600 }] });
  try {
    const answers = [];
    for (const n of [1, 2, 3]) assert.equal(writer.writeFile({ file: file(n), data: `{"n":${n}}\n` }, res => answers.push([n, res.ok])), true);
    await idle(writer);
    assert.deepEqual(answers, [[1, true], [2, true], [3, true]]);
    assert.deepEqual(logs.filter(l => l.k === 'job-done').map(l => l.base), ['f1.json', 'f2.json', 'f3.json']);
    assert.deepEqual(logs.filter(l => l.k === 'slot-worker-failed'), [], 'slow is not stuck: no takeover');
    assert.equal(writer.state(), 'running');
  } finally { writer.stop(); }
});

test('code health BR-04 (e): a worker still starting past its watch (its modules loading) is waited for, not taken over; one that never starts within startMs is', async () => {
  // CI's macOS runner once took longer to start the worker than (d)'s 100 ms watch (2026-10-05), and the
  // queue read the thread that wasn't serving yet as hung.
  for (const [startDelayMs, startMs, takenOver] of [[400, 30000, false], [1500, 300, true]]) {
    const logs = [];
    const root = tmpDir('nqa-start-');
    const file = n => path.join(root, `f${n}.json`);
    const writer = hooked({ logs, watchMs: 100, startMs, startDelayMs });
    try {
      const answers = [];
      for (const n of [1, 2]) assert.equal(writer.writeFile({ file: file(n), data: `{"n":${n}}\n` }, res => answers.push([n, res.ok])), true);
      await idle(writer);
      assert.deepEqual(answers, [[1, true], [2, true]], `start ${startDelayMs} ms`);
      for (const n of [1, 2]) assert.equal(read(file(n)), `{"n":${n}}\n`);
      assert.deepEqual(logs.filter(l => l.k === 'slot-worker-failed').map(l => l.why), takenOver ? ['timeout'] : [], `start ${startDelayMs} ms, startMs ${startMs}`);
      assert.deepEqual(logs.filter(l => l.k === 'job-done').map(l => l.base), takenOver ? [] : ['f1.json', 'f2.json']);
    } finally { writer.stop(); }
  }
});

// ------------------------------------------------------------------------------------------- the store and the ledger

// A writer the test answers by hand: writeFile holds each job; answer(res) answers the oldest with res, or
// writes it (as the worker would) when res is null.
function manualWriter() {
  const held = [];
  const write = (job) => {
    if (job.kind !== 'file') return { ok: true };
    try { fs.mkdirSync(path.dirname(job.file), { recursive: true }); fs.writeFileSync(job.file, job.data); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
  };
  return {
    held,
    answer(res = null) { const { job, done } = held.shift(); done(res ?? write(job)); },
    writeFile(job, done) { held.push({ job: { kind: 'file', ...job }, done }); return true; },
    write(job, done) { held.push({ job, done }); return true; },
    after(cb) { held.push({ job: { kind: 'mark' }, done: () => cb() }); return true; },
    drain() { while (held.length) this.answer(); },
    stop() {}, state: () => 'running', busy: () => held.length > 0,
  };
}

test('store (code health BR-04 with BR-11): with a writer, state.json and the outbox are written in its queue (records.json in place); a write the disk refused is owed and said, and retryWrites hears the queue\'s answer', () => {
  const dir = tmpDir('nqa-store-queue-');
  const w = manualWriter();
  const heard = [];
  const logs = [];
  const s = openStore(dir, { writer: w, onWriteError: () => heard.push(s.health().writeError?.code ?? null), log: (k, d) => logs.push({ k, ...d }) });
  w.drain(); // the new store's first state.json
  s.addOutbox({ token: TOKEN, key: 'k1', chat: CHAT, kind: 'msg', text: 'one' });
  assert.deepEqual(w.held.map(h => [path.basename(h.job.file), h.job.durable]), [['outbox.jsonl', true]], 'queued, durable');
  assert.equal(read(s.files.outbox), null, 'nothing in place');
  // A quick outbox write queued while that durable one is unanswered is durable too: if that one fails, this
  // may be the first to hold its message (as an outbox write owed since a failure is).
  s.updateOutbox('k1', { token: TOKEN, attempts: 1 });
  assert.equal(w.held[1].job.durable, true);
  s.addRecord({ t: 'reply', chat: CHAT, text: 'hi' }, Date.now());
  assert.match(read(s.files.records), /"hi"/, 'records.json: in place, as before');
  // The disk refuses the first: owed and said, at once (the host's onWriteError, the log).
  w.answer({ ok: false, code: 'ENOSPC' });
  assert.deepEqual([s.health().writeError?.file, s.health().writeError?.code, s.health().writeError?.diskFull], ['outbox.jsonl', 'ENOSPC', true]);
  assert.deepEqual(heard, ['ENOSPC']);
  assert.ok(logs.some(l => l.k === 'store-write-error' && l.file === 'outbox.jsonl' && l.error === 'ENOSPC'));
  w.answer({ ok: false, code: 'ENOSPC' });
  assert.deepEqual(heard, ['ENOSPC'], 'said once');
  // retryWrites: queued again; known once the queue answers, and onWritten hears it then.
  let recovered = 0;
  assert.equal(s.retryWrites(() => { recovered += 1; }), false, 'not written yet');
  assert.equal(recovered, 0);
  assert.equal(w.held.at(-1).job.kind, 'mark');
  w.drain();
  assert.equal(recovered, 1);
  assert.equal(s.health().writeError, null);
  assert.deepEqual(heard, ['ENOSPC', null]);
  assert.deepEqual(keysIn(read(s.files.outbox)), ['k1']);
  // state.json refused: due again (the next flush writes it).
  s.state.seq = 41;
  s.saveState();
  s.flush();
  w.answer({ ok: false, code: 'EIO' });
  assert.equal(s.health().writeError?.file, 'state.json');
  assert.equal(s.retryWrites(), false);
  w.drain();
  assert.equal(JSON.parse(read(s.files.state)).seq, 41);
  assert.equal(s.health().writeError, null);
});

test('ledger (code health BR-04): with a writer, begin and the final states are queued without waiting; the \'sending\' mark is a durable write whose promise settles on its answer (a refusal rejects with LEDGER_WRITE_FAILED and steps the turn back); the startup report is written in place after the queue', async () => {
  const dir = tmpDir('nqa-ledger-queue-');
  const file = path.join(dir, 'sub', 'ledger.json');
  const w = manualWriter();
  const l = createLedger(file, { writer: w });
  assert.equal(l.begin('k1', { chatId: CHAT }).fresh, true);
  assert.deepEqual(w.held.map(h => [h.job.durable, h.job.mkdir]), [[false, true]], 'begin: one quick write, in the queue, its folder made');
  const marked = l.set('k1', 'sending', { estMicros: 50 });
  assert.ok(marked instanceof Promise, 'the mark is awaited');
  assert.equal(w.held[1].job.durable, true, 'and durable');
  let settled = false;
  marked.then(() => { settled = true; });
  await sleep(10);
  assert.equal(settled, false, 'not before its answer');
  w.drain();
  assert.equal(await marked, true);
  assert.equal(JSON.parse(read(file)).entries.k1.state, 'sending', 'on disk when it settles');
  assert.equal(l.set('k1', 'done', { outMicros: 40 }), true, 'done: queued, not awaited');
  w.drain();
  // A refused mark: rejected, and the turn is as it was before it (queued), as in place.
  l.begin('k2', { chatId: CHAT });
  w.drain();
  const refused = l.set('k2', 'sending');
  w.answer({ ok: false, code: 'ENOSPC' });
  await assert.rejects(refused, e => e.code === 'LEDGER_WRITE_FAILED' && e.fsCode === 'ENOSPC');
  assert.equal(l.get('k2').state, 'queued');
  // The next process: its startup report is on disk before it returns (the backend books after it).
  l.begin('k3', { chatId: CHAT });
  const m3 = l.set('k3', 'sending');
  w.drain();
  await m3;
  const again = createLedger(file, { writer: w });
  w.write({ addonsDir: dir, text: '', inbox: '', opts: {} }, () => {}); // something still queued: drained first
  const left = again.interruptedAtStartup();
  assert.deepEqual(left.map(e => [e.key, e.state, !!e.neverSent]), [['k2', 'queued', true], ['k3', 'interrupted', false]]);
  assert.equal(w.busy(), false, 'the queue drained first');
  assert.equal(JSON.parse(read(file)).entries.k3.state, 'interrupted', 'written in place, now');
});
