// The run queue (PRD §6.5, RT-7): one run at a time per chat in arrival
// order, at most 2 at once across chats, and abort that stops the running
// fn's signal and drops the chat's waiting runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunQueue } from '../../bridge/byok/runqueue.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const tick = () => new Promise(r => setImmediate(r));

test('a chat\'s runs go one at a time, in arrival order', async () => {
  const q = createRunQueue({ concurrency: 2 });
  const log = [];
  const gates = [deferred(), deferred(), deferred()];
  const runs = gates.map((g, i) => q.run('c0ffee0', async () => { log.push(`start${i}`); await g.promise; log.push(`end${i}`); return i; }));
  await tick();
  assert.deepEqual(log, ['start0']);
  assert.equal(q.busy('c0ffee0'), true);
  assert.equal(q.queued('c0ffee0'), 2);
  gates[1].resolve(); // finishing out of order changes nothing: run 1 hasn't started
  await tick();
  assert.deepEqual(log, ['start0']);
  gates[0].resolve();
  gates[2].resolve();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  assert.deepEqual(log, ['start0', 'end0', 'start1', 'end1', 'start2', 'end2']);
  assert.equal(q.busy('c0ffee0'), false);
  assert.equal(q.queued('c0ffee0'), 0);
});

test('at most 2 runs at once across chats; the earliest waiting run whose chat is free goes next', async () => {
  const q = createRunQueue({ concurrency: 2 });
  const gates = {};
  const started = [];
  let active = 0;
  let peak = 0;
  const job = name => async () => {
    started.push(name);
    active++;
    peak = Math.max(peak, active);
    gates[name] = deferred();
    await gates[name].promise;
    active--;
    return name;
  };
  const all = [q.run('A', job('A1')), q.run('A', job('A2')), q.run('B', job('B1')), q.run('C', job('C1')), q.run('D', job('D1'))];
  await tick();
  assert.deepEqual(started, ['A1', 'B1'], 'A2 waits behind A1, so B1 takes the second slot');
  assert.deepEqual(q.stats(), { running: 2, queued: 3, concurrency: 2 });
  gates.A1.resolve();
  await tick();
  assert.deepEqual(started, ['A1', 'B1', 'A2'], 'A2 arrived before C1 and its chat is free now');
  gates.B1.resolve();
  await tick();
  assert.deepEqual(started, ['A1', 'B1', 'A2', 'C1']);
  gates.A2.resolve();
  await tick();
  gates.C1.resolve();
  await tick();
  gates.D1.resolve();
  assert.deepEqual(await Promise.all(all), ['A1', 'A2', 'B1', 'C1', 'D1']);
  assert.equal(peak, 2);
  assert.deepEqual(q.stats(), { running: 0, queued: 0, concurrency: 2 });
});

test('abort stops the running fn through its signal and drops the chat\'s waiting runs', async () => {
  const q = createRunQueue({ concurrency: 2 });
  let seen = null;
  const running = q.run('A', signal => new Promise((resolve, reject) => {
    seen = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  let calledQueued = false;
  const queued1 = q.run('A', async () => { calledQueued = true; });
  const queued2 = q.run('A', async () => { calledQueued = true; });
  const other = deferred();
  const b = q.run('B', () => other.promise);
  await tick();
  assert.equal(seen.aborted, false);
  assert.deepEqual(q.abort('A'), { aborted: true, dropped: 2 });
  assert.equal(seen.aborted, true);
  for (const p of [running, queued1, queued2]) await assert.rejects(p, e => e.name === 'AbortError');
  assert.equal(calledQueued, false, 'dropped runs never start');
  assert.equal(q.busy('A'), false);
  assert.equal(q.busy('B'), true, 'other chats are untouched');
  assert.deepEqual(q.abort('A'), { aborted: false, dropped: 0 });
  // The chat takes new messages after an abort.
  assert.equal(await q.run('A', async () => 'again'), 'again');
  other.resolve('b');
  assert.equal(await b, 'b');
});

test('an aborted run keeps its chat busy until it actually stops, so the next one never overlaps', async () => {
  const q = createRunQueue({ concurrency: 2 });
  const slow = deferred();
  const log = [];
  const first = q.run('A', async signal => { await slow.promise; log.push(`first saw aborted=${signal.aborted}`); });
  await tick();
  q.abort('A', new Error('player cancelled'));
  const next = q.run('A', async () => { log.push('next'); });
  await tick();
  assert.deepEqual(log, [], 'next waits for the aborted run to wind down');
  assert.equal(q.busy('A'), true);
  slow.resolve();
  await first;
  await next;
  assert.deepEqual(log, ['first saw aborted=true', 'next']);
});

test('a failing run doesn\'t block its chat, and busy() is already false when the caller resumes', async () => {
  const q = createRunQueue({ concurrency: 1 });
  await assert.rejects(q.run('A', () => { throw new Error('sync boom'); }), /sync boom/);
  await assert.rejects(q.run('A', async () => { throw new Error('async boom'); }), /async boom/);
  const v = await q.run('A', async () => 7);
  assert.equal(v, 7);
  assert.equal(q.busy('A'), false);
  assert.equal(await q.run('A', () => 'plain value'), 'plain value');
  await assert.rejects(q.run('A', 'not a function'), /fn must be a function/);
});

test('abortAll clears every chat; concurrency must be a positive integer', async () => {
  const q = createRunQueue();
  assert.equal(q.stats().concurrency, 2, 'default 2 (PRD §6.5)');
  const hang = signal => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const ps = [q.run('A', hang), q.run('B', hang), q.run('C', hang), q.run('A', hang)];
  await tick();
  assert.equal(q.abortAll(), 3);
  const settled = await Promise.allSettled(ps);
  assert.ok(settled.every(s => s.status === 'rejected' && s.reason.name === 'AbortError'));
  assert.deepEqual(q.stats(), { running: 0, queued: 0, concurrency: 2 });
  for (const bad of [0, -1, 1.5, '2']) assert.throws(() => createRunQueue({ concurrency: bad }), /positive integer/);
});
