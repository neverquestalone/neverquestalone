// The bridge's write worker with a test's hooks around its jobs (code health BR-04, durable writes; the
// ordering tests in tests/byok/durable_queue_test.mjs). It runs the real thing: write-queue.mjs's
// serveJobs (the job lock, the answers, DONE) and runJob (a file written durably or quick, and the slot
// table with the plugin's runner, transport/slots.mjs runSlotJob), unchanged; the hooks only add time or end it:
//   delayMs       a slow disk: the job waits this long, inside the job lock, before it is written
//   at            'before' (the default) or 'after' the job is written: when `then` happens
//   then          'kill'  the whole process, at once (SIGKILL; on Windows, TerminateProcess)
//                 'exit'  this thread ends (process.exit in a worker), with the job lock held
//                 'hang'  the job is never taken: the thread waits, outside the job lock, until the main
//                         thread has taken the writes over (CANCEL), then stops
//   marker        a file written just before `then`, saying which job it was (the kill test reads it)
// workerData.startDelayMs: a slow start (modules loading): the thread waits this long before it serves jobs.
// A rule fits a job by match { kind: 'file' | 'slots', base: the file's name, durable }, and acts on the
// nth job that fits (1 by default), or every one (every: true). armed: the rule waits until the test sets
// workerData.arm[0] to 1.
//
// Every job's end is told in its answer's log, in the order the jobs were written: 'job-done' with its
// kind, file name, durable, when, the watched files as they were on disk right then (workerData.watch),
// and, with workerData.spyFsync, every fsync the job tried (the file or folder, when, and whether the system
// took it: Windows refuses a folder's, which writeFileDurable allows).
import fs from 'node:fs';
import path from 'node:path';
import { workerData } from 'node:worker_threads';
import { serveJobs, runJob, CTL } from '../../../bridge/write-queue.mjs';
import { runSlotJob } from '../../../bridge/transport/slots.mjs';

const { hooks = [], watch = [], spyFsync = false, arm = null, startDelayMs = 0 } = workerData;
const armed = arm ? new Int32Array(arm) : null;
const counts = hooks.map(() => 0);
const kindOf = job => job.kind || 'slots';
const baseOf = job => (job.file ? path.basename(job.file) : null);
const fits = (m = {}, job) => (m.kind === undefined || m.kind === kindOf(job))
  && (m.base === undefined || m.base === baseOf(job))
  && (m.durable === undefined || !!job.durable === m.durable);

function hookFor(job) {
  for (const [i, h] of hooks.entries()) {
    if (h.armed && !(armed && Atomics.load(armed, 0) === 1)) continue;
    if (!fits(h.match, job)) continue;
    counts[i] += 1;
    if (h.every || counts[i] === (h.nth ?? 1)) return h;
  }
  return null;
}
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
function act(h, job) {
  if (h.marker) fs.writeFileSync(h.marker, JSON.stringify({ kind: kindOf(job), base: baseOf(job), durable: !!job.durable, at: h.at ?? 'before', then: h.then }));
  if (h.then === 'kill') process.kill(process.pid, 'SIGKILL');
  if (h.then === 'exit') process.exit(1);
}

// Every fsync this thread tries, by the path its descriptor was opened for.
const synced = [];
if (spyFsync) {
  const o = { open: fs.openSync, close: fs.closeSync, fsync: fs.fsyncSync };
  const paths = new Map();
  fs.openSync = function (p, ...a) { const fd = o.open.call(this, p, ...a); paths.set(fd, String(p)); return fd; };
  fs.closeSync = function (fd) { paths.delete(fd); return o.close.call(this, fd); };
  fs.fsyncSync = function (fd) {
    const e = { file: paths.get(fd) ?? '?', at: Date.now(), ok: false };
    synced.push(e);
    const r = o.fsync.call(this, fd);
    Object.assign(e, { at: Date.now(), ok: true });
    return r;
  };
}

if (startDelayMs) sleep(startDelayMs);
let hook = null; // the rule for the job being served
serveJobs({
  port: workerData.port,
  ctl: new Int32Array(workerData.ctl),
  before(job, ctl) {
    hook = hookFor(job);
    if (hook?.then === 'hang') while (Atomics.load(ctl, CTL.CANCEL) === 0) Atomics.wait(ctl, CTL.CANCEL, 0, 50);
  },
  run(job, log) {
    const h = hook;
    if (h?.delayMs) sleep(h.delayMs);
    if (h?.then && h.then !== 'hang' && h.at !== 'after') act(h, job);
    const res = runJob(job, log, runSlotJob);
    log('job-done', { kind: kindOf(job), base: baseOf(job), durable: !!job.durable, at: Date.now(),
      files: Object.fromEntries(watch.map(f => [f, read(f)])), fsyncs: synced.splice(0) });
    if (h?.then && h.at === 'after') { if (h.delayAfterMs) sleep(h.delayAfterMs); act(h, job); }
    return res;
  },
});
