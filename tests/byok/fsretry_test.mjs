// bridge/transport/fsretry.mjs (systems plan Batch 1, SY-08): the Windows sharing-violation
// retries for slot, inbox and doorbell files. Here with fake errors and a fake clock on every OS;
// tests/byok/windows_smoke_test.mjs makes real sharing violations on NTFS in Windows CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRetrier, sleepSync, RETRY_CODES, RETRY_DELAYS_MS, renameWithRetry, unlinkWithRetry, writeFileWithRetry } from '../../bridge/transport/fsretry.mjs';

const err = (code) => Object.assign(new Error(code), { code });

/** fn that throws each code in turn, then returns 'done'. */
function flaky(codes) {
  let i = 0;
  const fn = () => { if (i < codes.length) throw err(codes[i++]); return 'done'; };
  fn.calls = () => i;
  return fn;
}

test('Windows: EBUSY twice, then success: two retries at 25 and 50 ms, counted as recovered', () => {
  const slept = [];
  const r = createRetrier({ platform: 'win32', sleep: ms => slept.push(ms) });
  assert.equal(r.run(flaky(['EBUSY', 'EBUSY'])), 'done');
  assert.deepEqual(slept, [25, 50]);
  assert.deepEqual(r.stats(), { retries: 2, recovered: 1, failed: 0, gaveUp: false });
});

test('Windows: EPERM, EACCES and EBUSY are retried 3 times over 150 ms at most, then the last error is thrown', () => {
  assert.deepEqual([...RETRY_CODES], ['EPERM', 'EACCES', 'EBUSY']);
  assert.equal(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0), 150);
  for (const code of RETRY_CODES) {
    const slept = [];
    const r = createRetrier({ platform: 'win32', sleep: ms => slept.push(ms) });
    const fn = flaky([code, code, code, code, code]);
    assert.throws(() => r.run(fn), e => e.code === code);
    assert.equal(fn.calls(), 4, 'one try and three retries');
    assert.deepEqual(slept, [25, 50, 75]);
    assert.deepEqual(r.stats(), { retries: 3, recovered: 0, failed: 1, gaveUp: true });
  }
});

test('once a file used up its retries, later files in the same retrier are tried once (a locked folder costs one wait per publish)', () => {
  const slept = [];
  const r = createRetrier({ platform: 'win32', sleep: ms => slept.push(ms) });
  assert.throws(() => r.run(flaky(['EACCES', 'EACCES', 'EACCES', 'EACCES'])));
  const second = flaky(['EACCES']);
  assert.throws(() => r.run(second));
  assert.equal(second.calls(), 1, 'no retries after giving up');
  assert.equal(r.run(() => 'fine'), 'fine', 'files that work still work');
  assert.deepEqual(slept, [25, 50, 75]);
  assert.equal(r.stats().failed, 2);
  // A new publish gets a new retrier, and retries again.
  const next = createRetrier({ platform: 'win32', sleep: () => {} });
  assert.equal(next.run(flaky(['EBUSY'])), 'done');
});

test('other errors are thrown at once, and nothing is retried off Windows (there EACCES is a real permission problem)', () => {
  const slept = [];
  const win = createRetrier({ platform: 'win32', sleep: ms => slept.push(ms) });
  const enoent = flaky(['ENOENT']);
  assert.throws(() => win.run(enoent), e => e.code === 'ENOENT');
  assert.equal(enoent.calls(), 1);
  for (const platform of ['darwin', 'linux']) {
    const r = createRetrier({ platform, sleep: ms => slept.push(ms) });
    const fn = flaky(['EBUSY']);
    assert.throws(() => r.run(fn), e => e.code === 'EBUSY');
    assert.equal(fn.calls(), 1);
    assert.deepEqual(r.stats(), { retries: 0, recovered: 0, failed: 0, gaveUp: false });
  }
  assert.deepEqual(slept, []);
});

test('onRetry hears each retry; a throwing logger changes nothing', () => {
  const heard = [];
  const r = createRetrier({ platform: 'win32', sleep: () => {}, onRetry: (e, n) => { heard.push([e.code, n]); throw new Error('logger broke'); } });
  assert.equal(r.run(flaky(['EPERM', 'EBUSY'])), 'done');
  assert.deepEqual(heard, [['EPERM', 1], ['EBUSY', 2]]);
});

test('sleepSync really waits (Atomics.wait), and the file helpers do the real operations', () => {
  const t0 = performance.now();
  sleepSync(30);
  assert.ok(performance.now() - t0 >= 25, 'slept about 30 ms');
  sleepSync(0);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wcap-fsretry-'));
  try {
    const r = createRetrier();
    const a = path.join(dir, 'a.tmp'), b = path.join(dir, 'b.lua');
    writeFileWithRetry(r, a, 'slot', { flag: 'wx' });
    renameWithRetry(r, a, b);
    assert.equal(fs.readFileSync(b, 'utf8'), 'slot');
    unlinkWithRetry(r, b);
    assert.equal(fs.existsSync(b), false);
    assert.throws(() => unlinkWithRetry(r, b), e => e.code === 'ENOENT');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
