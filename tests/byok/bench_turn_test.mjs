// tools/bench-turn.mjs (systems critic SY-27): what a typed turn costs the app's main thread (the app's
// own assembly, bootByok, with a status listener), the numbers docs/VERIFICATION.md records for this
// Mac and windows-smoke prints for Windows. Here it runs two turns and its budgets hold whatever the
// machine's speed: no fsync on the main thread (the outbox's and the ledger's durable writes, with their
// folders, are the write worker's: code health BR-04, durable writes; was at most 4), the slot window's
// files and no more (report mode, SY-03), 2 publishes (the ack's and the reply's, PF-02), a status push
// for the window, and a state line the strip repeats writes nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/byok-env.mjs';

const BENCH = fileURLToPath(new URL('../../tools/bench-turn.mjs', import.meta.url));

test('tools/bench-turn.mjs: a typed turn\'s synchronous file work, publishes and main-thread time, within the budgets; a repeated state line writes nothing', () => {
  const r = spawnSync(process.execPath, [BENCH, '--turns', '2', '--dir', tmpDir('bones-bench-turn-')], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: tmpDir('bones-bench-home-') } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.turns, 2);
  for (const k of ['fsync', 'rename', 'open', 'writeFile', 'write', 'fsMs', 'publishes', 'slotFiles', 'pushes', 'activeMs', 'loopMaxMs']) {
    assert.ok(Number.isFinite(out.perTurn[k]?.p50) && Number.isFinite(out.perTurn[k]?.max), `${k}: ${JSON.stringify(out.perTurn[k])}`);
  }
  assert.equal(out.perTurn.fsync.max, 0, `fsyncs on the main thread a turn: ${out.perTurn.fsync.max} (the write worker's, BR-04)`);
  assert.ok(out.perTurn.publishes.max <= 2, `publishes a turn: ${out.perTurn.publishes.max}`);
  assert.ok(out.perTurn.slotFiles.max <= 2 * 10, `slot files a turn: ${out.perTurn.slotFiles.max} (the window's 9 and the reload inbox, twice)`);
  assert.ok(out.perTurn.pushes.max >= 1, 'the window and the tray hear of each turn');
  assert.ok(out.perTurn.activeMs.max > 0);
  assert.ok(Number.isFinite(out.statusMs.p50) && out.statusMs.max >= out.statusMs.p50, JSON.stringify(out.statusMs));
  assert.deepEqual(out.dupState10, { fsync: 0, rename: 0, open: 0, writeFile: 0, write: 0, fsMs: 0 });
  assert.match(out.platform, /^[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(out.worker, 'running', 'the app writes the slot files from a worker thread (code health BR-04)');
  assert.ok(out.perTurn.rename.max < out.perTurn.slotFiles.max, `the main thread renames none of the ${out.perTurn.slotFiles.max} slot files: ${out.perTurn.rename.max} renames`);
});

test('tools/bench-turn.mjs --mode stream (code health BR-04): with Screen Reading off every publish writes all 200 slots and the inbox, from the worker thread, so the main thread renames none of the 402 files a turn', () => {
  const r = spawnSync(process.execPath, [BENCH, '--turns', '1', '--mode', 'stream', '--dir', tmpDir('bones-bench-stream-')], { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: tmpDir('bones-bench-home-') } });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.mode, 'stream');
  assert.equal(out.worker, 'running');
  assert.equal(out.perTurn.slotFiles.max, 2 * 201, 'no window: every slot and the inbox, twice');
  assert.ok(out.perTurn.rename.max < 40, `renames on the main thread: ${out.perTurn.rename.max} (402 slot files before BR-04)`);
});

test('tools/bench-turn.mjs: a bad --turns or --mode is a usage error', () => {
  for (const args of [['--turns', '0'], ['--mode', 'reload']]) {
    const r = spawnSync(process.execPath, [BENCH, ...args], { encoding: 'utf8', timeout: 30000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: node tools\/bench-turn\.mjs/);
  }
});
