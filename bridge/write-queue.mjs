// The bridge's writes off the main thread, in one ordered queue (code health BR-04). The desktop app runs
// the bridge in Electron's main process, where every synchronous file call holds the window and the tray.
// A publish that writes every slot (stream and reload modes, or no window reported) is 201
// files: 34 ms on the author's Mac and 146 ms p50, 540 ms max on a Windows runner (CI windows-smoke),
// twice a typed turn. And a typed turn's durable writes, the outbox's new message and the ledger's
// 'sending' mark, are four fsyncs, about 19 ms a turn here. Here they all run in one worker thread, the
// same code (the plugin's runner, files.mjs writeFileDurable and writeFileQuick): the main thread
// posts a job and hears back once it is on disk. The queue knows nothing of the plugin's jobs (its slot
// tables): the plugin gives it what runs them (use()), so the shell imports no plugin code.
//
// One queue, first in first out, whatever the job (code health BR-04, durable writes): the slot files and
// every write of the outbox, the ledger and state.json go through it, so they reach the disk in the order
// the bridge asked for them, as when each was written in place. That order is what the money path rests
// on: an outbox write queued before an ack's slot is on disk first (the ack never names a message the
// disk doesn't hold), a quick write never lands before an earlier durable one (nor overwrites it with an
// older copy), P is on disk before a slot carries it, and the ledger's 'sending' mark, which the backend
// awaits, is fsynced before the provider is asked. The Windows sharing-violation retries (fsretry.mjs)
// run in the worker as they ran in place; their Atomics.wait blocks only that thread.
//
//   createSlotWorker({ log, waitMs, watchMs, startMs, url, data })
//     → { use(runner), write(job, done), writeFile(job, done), after(cb), drain(), stop(), state(), busy() }
//   use(runner)           what runs write()'s jobs, the plugin's: { run(job, log) on this thread, and url and
//                         name, the module and export the worker runs them with }. Before the first job, so
//                         the worker starts with it; a different one after that throws (the worker would go
//                         on running the old one). A worker without one refuses them, and the main thread
//                         takes the writes over
//   write(job, done)      the plugin's job, as its runner takes it; done(res) hears the runner's answer
//   writeFile(job, done)  a file replaced whole: job = { file, data, durable, mode, mkdir } (mkdir: its
//                         folder made first, 0700); done({ ok, code }) hears whether it was written
//   → true: queued, and done hears it once its files are on disk, in queue order, always later (never
//     inside the call). false: no queue (the worker never started, or failed and has nothing left to
//     write): the caller writes in place, at once, as before.
//   after(cb)             cb() once every job queued before it is on disk (now, when nothing is queued)
//   drain()               blocks (at most waitMs) until every queued job is on disk, its done called
//   stop()                drains, then ends the worker
//   state()               'idle' (not started yet), 'running', 'failed' or 'stopped'; busy(): jobs queued
//
// The fallback stays on the main thread and in order. A worker that can't start (an app whose packaging
// can't load it), dies, answers a job with an error, or leaves its oldest job unanswered for watchMs while
// it isn't writing anything (it holds no job lock: hung, not slow; one still loading its modules, a cold
// disk or a first launch's virus scan, is starting, not hung, for up to startMs) is logged once ('slot-worker-failed')
// and not tried again: the main thread writes every job still queued, in order, then every job after it
// in place. A job that the worker is writing is never written over it: the worker takes a job lock (a
// shared word) for each job, the main thread sets CANCEL and takes that lock before it writes anything,
// and the worker starts no job once CANCEL is set. So at any moment the disk holds the queue's jobs up to
// some point, in order, as a crash would leave them, and the main thread goes on from exactly there (a
// job the worker died in the middle of is written again, whole: the same bytes). A worker that is still
// writing when a drain's time is up keeps its queue (nothing is written in place ahead of it); the main
// thread takes over once its job ends.
import fs from 'node:fs';
import path from 'node:path';
import { Worker, MessageChannel, receiveMessageOnPort, isMainThread, workerData } from 'node:worker_threads';
import { writeFileDurable, writeFileQuick } from './files.mjs';
import { sleepSync } from './transport/fsretry.mjs';

const ROLE = 'nqa-slot-worker';
export const WORKER_WAIT_MS = 10000;
/** How long a worker still starting (its loop not serving yet) is waited for before the main thread takes over. */
export const WORKER_START_MS = 30000;
// The words the two threads share (an Int32Array over a SharedArrayBuffer).
export const CTL = Object.freeze({
  DONE: 0, // the last job the worker finished (its answer is posted first)
  CANCEL: 1, // 1 once the main thread is taking the writes over: the worker starts no job after that
  LOCK: 2, // 1 while the worker writes a job; once the main thread has taken it, for good
  UP: 3, // 1 once the worker's loop serves jobs: before that it is starting (loading its modules), not hung
});

/** One job, on whichever thread writes it: a file replaced whole, a marker (nothing), or the plugin's (run, use()'s). */
export function runJob(job, log = () => {}, run = null) {
  if (job.kind === 'file') {
    try {
      if (job.mkdir) fs.mkdirSync(path.dirname(job.file), { recursive: true, mode: 0o700 });
      (job.durable ? writeFileDurable : writeFileQuick)(job.file, job.data, job.mode ?? 0o600);
      return { ok: true };
    } catch (e) {
      return { ok: false, code: typeof e?.code === 'string' ? e.code : 'error' };
    }
  }
  if (job.kind === 'mark') return { ok: true };
  if (typeof run !== 'function') throw new Error('no runner for the plugin\'s jobs (use())');
  return run(job, log);
}

// ---------------------------------------------------------------- the worker's side
/**
 * The worker's loop: each job written under the job lock, its answer posted, then DONE moved. run(job, log)
 * writes it (runJob); before(job, ctl) runs ahead of the lock (a test's hook: tests/byok/helpers/hooked-writer.mjs).
 */
export function serveJobs({ port, ctl, run = runJob, before = null }) {
  const cancelled = () => Atomics.load(ctl, CTL.CANCEL) === 1;
  Atomics.store(ctl, CTL.UP, 1);
  port.on('message', (job) => {
    try { before?.(job, ctl); } catch { /* a test's hook */ }
    for (;;) {
      if (cancelled()) { port.close(); return; }
      if (Atomics.compareExchange(ctl, CTL.LOCK, 0, 1) === 0) break;
      Atomics.wait(ctl, CTL.LOCK, 1, 50);
    }
    // CANCEL set after the lock was taken: the main thread is waiting for it, to write this job itself.
    if (cancelled()) { Atomics.store(ctl, CTL.LOCK, 0); Atomics.notify(ctl, CTL.LOCK); port.close(); return; }
    const lines = [];
    let res = null;
    let error = null;
    try {
      res = run(job, (kind, data) => { lines.push([kind, data]); });
    } catch (e) { error = String(e?.message || e).slice(0, 160); }
    // The answer is queued before DONE moves, so a drain that sees DONE finds the answer; both before the lock goes.
    port.postMessage({ id: job.id, res, error, log: lines });
    Atomics.store(ctl, CTL.DONE, job.id);
    Atomics.notify(ctl, CTL.DONE);
    Atomics.store(ctl, CTL.LOCK, 0);
    Atomics.notify(ctl, CTL.LOCK);
  });
}

// The worker: the plugin's runner first (use()'s module and export), then every job; what's posted meanwhile
// waits on the port. A runner that can't load ends the thread, and the main thread takes the writes over.
if (!isMainThread && workerData?.role === ROLE && workerData.serve !== false) {
  const runner = workerData.runner ? import(workerData.runner.url).then(m => m[workerData.runner.name]) : Promise.resolve(null);
  runner.then(run => serveJobs({ port: workerData.port, ctl: new Int32Array(workerData.ctl), run: (job, log) => runJob(job, log, run) }));
}

// ---------------------------------------------------------------- the main thread's side
// data: more workerData for a worker script of a test's own (url).
export function createSlotWorker({ log = () => {}, waitMs = WORKER_WAIT_MS, watchMs = WORKER_WAIT_MS, startMs = WORKER_START_MS, url = new URL(import.meta.url), data = null } = {}) {
  let worker = null;
  let port = null;
  let ctl = null;
  let state = 'idle'; // idle, running, taking (taking over: the worker is still writing a job), failed, stopped
  let ended = false; // stop() was called
  let nextId = 0;
  const queue = []; // queued and not yet on disk, oldest first: { id, job, done }
  let pumping = false; // the main thread is writing the queue in place: what's queued meanwhile goes behind it
  let watch = null; // the oldest job's timer (watchMs)
  let retry = null; // a takeover waiting for the worker's job to end
  let owned = false; // the main thread holds the job lock, or the worker's thread is gone: it writes nothing more
  let runner = null; // the plugin's: what runs write()'s jobs (use())
  let startedAt = 0; // when start() made the thread (startMs counts from here)
  let upSeenAt = 0; // when this thread first saw the worker serving (CTL.UP): a job's watch counts from no earlier
  const say = (kind, d) => { try { log(kind, d); } catch { /* a logger's problem */ } };
  const call = (q, res) => {
    try { q.done(res); } catch (e) { say('slot-worker-done-error', { error: String(e?.message || e).slice(0, 160) }); }
  };

  function start() {
    state = 'running';
    startedAt = Date.now();
    try {
      const ch = new MessageChannel();
      ctl = new Int32Array(new SharedArrayBuffer(4 * Object.keys(CTL).length));
      port = ch.port1;
      port.on('message', heard);
      port.unref();
      worker = new Worker(url, { workerData: { ...(data || {}), role: ROLE, port: ch.port2, ctl: ctl.buffer, ...(runner ? { runner: { url: String(runner.url), name: runner.name } } : {}) }, transferList: [ch.port2] });
      // Its thread is gone: nothing of it can write any more.
      worker.on('error', e => takeOver('error', e, { gone: true }));
      worker.on('exit', code => takeOver('exit', { message: `exited (${code})` }, { gone: true }));
      worker.unref(); // an idle worker never keeps the process; a queued job does (queue())
    } catch (e) { takeOver('start', e, { gone: true }); }
  }

  // An answer: the oldest job is on disk (answers come in queue order).
  function heard(m) {
    if (!queue.length || m?.id !== queue[0].id) return;
    for (const [kind, d] of Array.isArray(m.log) ? m.log : []) say(kind, d);
    if (m.error || !m.res) { takeOver('write', { message: m.error || 'no answer' }); return; }
    const q = queue.shift();
    rewatch();
    if (!queue.length) { try { worker?.unref(); } catch { /* ended */ } }
    call(q, m.res);
  }
  /** The answers already posted, heard now. → whether there was one. */
  function pull() {
    let any = false;
    for (let got; port && queue.length && (got = receiveMessageOnPort(port));) { any = true; heard(got.message); }
    return any;
  }

  function rewatch() {
    clearTimeout(watch);
    watch = null;
    if (state !== 'running' || !queue.length) return;
    const id = queue[0].id;
    watch = setTimeout(() => { watch = null; if (queue[0]?.id === id) stalled(); else rewatch(); }, watchMs);
    watch.unref?.();
  }
  /** When this thread first saw the worker serving (0: not yet). */
  function upSince() {
    if (!upSeenAt && ctl && Atomics.load(ctl, CTL.UP) === 1) upSeenAt = Date.now();
    return upSeenAt;
  }
  // The oldest job unanswered for watchMs. A worker writing it (the job lock held) is slow, and waited for,
  // and so is one still starting (its loop not serving yet: CI's macOS runner once took longer than a test's
  // 100 ms watch, 2026-10-05), for up to startMs, and one seen serving only lately, for a whole watch from
  // then (it's about to take its first job: Windows CI caught that gap, 2026-10-06). One that has served for
  // a watch and writes nothing is hung, and the main thread takes over.
  function stalled() {
    if (state !== 'running') return;
    if (pull()) return;
    if (Atomics.load(ctl, CTL.LOCK) === 1) { rewatch(); return; }
    const up = upSince();
    if (up ? Date.now() - up < watchMs : Date.now() - startedAt < startMs) { rewatch(); return; }
    takeOver('timeout', { message: `no answer in ${watchMs} ms` });
  }

  /** The job lock, taken for good (the worker writes nothing more), waiting at most ms. → whether it is held. */
  function grab(ms) {
    if (owned || !ctl) return (owned = true);
    const end = Date.now() + ms;
    for (;;) {
      if (Atomics.compareExchange(ctl, CTL.LOCK, 0, 1) === 0) return (owned = true);
      const left = end - Date.now();
      if (left <= 0) return false;
      try { Atomics.wait(ctl, CTL.LOCK, 1, Math.min(left, 50)); } catch { sleepSync(1); }
    }
  }

  /**
   * The main thread takes the writes over, once the worker can't write anything more: its thread gone, or
   * the job lock taken after CANCEL (waiting at most ms for a job it is writing to end; if it doesn't, the
   * queue waits and this is tried again). Then what it answered first is heard, and the rest written in
   * place, in order. → whether it did.
   */
  function takeOver(why, e, { gone = false, ms = 0 } = {}) {
    if (state === 'failed' || state === 'stopped') return true;
    if (state !== 'taking') {
      say('slot-worker-failed', { why, error: String(e?.code || e?.message || e).slice(0, 160) });
      state = 'taking';
      clearTimeout(watch);
      watch = null;
      if (ctl) Atomics.store(ctl, CTL.CANCEL, 1);
    }
    if (gone) owned = true;
    if (!grab(ms)) {
      if (!retry) { retry = setTimeout(() => { retry = null; takeOver(why, e); }, 50); retry.unref?.(); }
      return false;
    }
    clearTimeout(retry);
    retry = null;
    pull();
    state = ended ? 'stopped' : 'failed';
    const w = worker;
    worker = null;
    try { port?.close(); } catch { /* closing */ }
    port = null;
    try { w?.terminate()?.catch?.(() => {}); } catch { /* ending */ }
    pump();
    return true;
  }

  // Every queued job written in place, in order; what a done queues meanwhile goes behind them.
  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const q = queue.shift();
        let res;
        try { res = runJob(q.job, say, runner?.run); } catch (err) {
          say('slot-worker-failed', { why: 'in-place', error: String(err?.message || err).slice(0, 160) });
          res = q.job.kind === 'file' ? { ok: false, code: 'error' } : null;
        }
        call(q, res);
      }
    } finally { pumping = false; }
  }

  function post(job, done) {
    // Behind what the main thread is writing in place, or waiting to take over.
    if (pumping || state === 'taking') { queue.push({ id: ++nextId, job, done }); return true; }
    if (state === 'idle' && !ended) start();
    if (state !== 'running') return false; // failed or stopped, nothing queued: in place
    const id = ++nextId;
    queue.push({ id, job, done });
    upSince(); // a worker already serving when the job comes has had its start
    try {
      worker.ref(); // a queued job keeps the process open until it's on disk
      port.postMessage({ ...job, id });
    } catch (e) {
      takeOver('post', e); // the worker didn't get it: it's written in place, after what it did get
      return true;
    }
    if (queue.length === 1) rewatch();
    return true;
  }

  function drain(ms = waitMs) {
    if (pumping) return; // the main thread is writing them now
    const end = Date.now() + ms;
    while (queue.length) {
      const left = end - Date.now();
      if (state === 'taking') { if (!takeOver(null, null, { ms: Math.max(0, left) })) return; continue; }
      if (state !== 'running') return;
      const seen = Atomics.load(ctl, CTL.DONE);
      if (pull()) continue;
      if (left <= 0) { takeOver('timeout', { message: `no answer in ${ms} ms` }); continue; }
      // Until the worker moves DONE past what it had finished (or 50 ms, then look again).
      try { Atomics.wait(ctl, CTL.DONE, seen, Math.min(left, 50)); } catch { sleepSync(1); }
    }
  }

  return {
    use(r) {
      if (state !== 'idle' && r !== runner) throw new Error('the write queue takes its runner before its first job');
      runner = r;
    },
    write: (job, done) => post(job, done),
    writeFile: (job, done) => post({ kind: 'file', ...job }, done),
    after(cb) { if (!post({ kind: 'mark' }, () => cb())) cb(); },
    drain,
    stop() {
      ended = true;
      drain();
      clearTimeout(watch);
      watch = null;
      // Still writing a job when the drain's time was up: its queue waits for it (the takeover ends it).
      if (state === 'taking' || state === 'stopped') return;
      if (ctl) Atomics.store(ctl, CTL.CANCEL, 1);
      state = 'stopped';
      const w = worker;
      worker = null;
      try { port?.close(); } catch { /* closing */ }
      port = null;
      try { w?.terminate()?.catch?.(() => {}); } catch { /* ending */ }
    },
    state: () => (state === 'taking' ? 'failed' : state),
    /** Whether jobs are queued (tests, diagnostics, the bench). */
    busy: () => queue.length > 0,
  };
}
