// The shell's write queue (bridge/write-queue.mjs; open-shell lane 2a) runs the plugin's jobs (write())
// with the runner the plugin gives it (use()): in its worker thread, by the module and export named, and on
// the main thread when it writes in place. It knows nothing of what they are (NeverQuestAlone's are slot
// tables: transport/slots.mjs SLOT_JOB, the WoW plugin's). Here a stand-in plugin writes a file per job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSlotWorker, runJob } from '../bridge/write-queue.mjs';

async function plugin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-queue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'put.mjs');
  fs.writeFileSync(file, "import fs from 'node:fs';\nimport { isMainThread } from 'node:worker_threads';\n"
    + "export function put(job, log) { fs.writeFileSync(job.file, job.text); log('put', { main: isMainThread }); return { wrote: job.text }; }\n");
  const url = pathToFileURL(file).href;
  return { dir, runner: { run: (await import(url)).put, url, name: 'put' } };
}

test('write queue: the plugin\'s jobs run in the worker with the runner use() gave it, in order with the queue\'s own files', async (t) => {
  const { dir, runner } = await plugin(t);
  const logs = [];
  const w = createSlotWorker({ log: (k, d) => logs.push([k, d]) });
  w.use(runner);
  const heard = [];
  assert.equal(w.write({ file: path.join(dir, 'a.txt'), text: 'one' }, r => heard.push(r)), true);
  assert.equal(w.writeFile({ file: path.join(dir, 'b.txt'), data: 'two' }, r => heard.push(r)), true);
  w.drain();
  assert.deepEqual(heard, [{ wrote: 'one' }, { ok: true }]);
  assert.deepEqual([fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')], ['one', 'two']);
  assert.deepEqual(logs, [['put', { main: false }]], 'written in the worker, and nothing failed');
  assert.equal(w.state(), 'running');
  w.stop();
});

test('write queue: in place, the main thread runs them with the same runner; with none, a plugin\'s job is refused, never guessed at; the runner is set before the first job', async (t) => {
  const { dir, runner } = await plugin(t);
  const said = [];
  assert.deepEqual(runJob({ file: path.join(dir, 'c.txt'), text: 'three' }, (k, d) => said.push([k, d]), runner.run), { wrote: 'three' });
  assert.deepEqual(said, [['put', { main: true }]]);
  assert.throws(() => runJob({ file: path.join(dir, 'd.txt'), text: 'four' }), /no runner for the plugin's jobs/);
  assert.deepEqual(runJob({ kind: 'mark' }), { ok: true }, 'the queue\'s own jobs need none');
  // A worker that can't start: what was queued is written in place, by the runner.
  const logs = [];
  const w = createSlotWorker({ log: (k, d) => logs.push([k, d]), url: pathToFileURL(path.join(dir, 'no-such-worker.mjs')) });
  w.use(runner);
  const heard = [];
  w.write({ file: path.join(dir, 'e.txt'), text: 'five' }, r => heard.push(r));
  for (let i = 0; i < 100 && !heard.length; i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(heard, [{ wrote: 'five' }]);
  assert.deepEqual(logs.map(([k, d]) => (k === 'slot-worker-failed' ? `${k} ${d.why}` : `${k} ${d.main}`)), ['slot-worker-failed error', 'put true']);
  w.stop();
  // The runner comes before the first job: the same one again is fine (the bridge and its publisher both
  // hand it the one they share); another one after the worker started throws, since the worker would go
  // on running the old one.
  const set = createSlotWorker({ log: () => {} });
  set.use(runner);
  set.write({ file: path.join(dir, 'f.txt'), text: 'six' }, () => {});
  set.drain();
  set.use(runner);
  assert.throws(() => set.use({ ...runner }), /takes its runner before its first job/);
  set.stop();
  const late = createSlotWorker({ log: () => {} });
  late.writeFile({ file: path.join(dir, 'g.txt'), data: 'seven' }, () => {});
  late.drain();
  assert.throws(() => late.use(runner), /takes its runner before its first job/);
  late.stop();
});
