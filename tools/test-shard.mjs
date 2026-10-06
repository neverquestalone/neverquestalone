#!/usr/bin/env node
// npm test in shards (systems critic SY-26): test.yml runs npm test's files on several runners at
// once, each runner a share of them, one file at a time as npm test runs them (a 2-core runner runs
// its files one after another anyway, so a shard's files run just as they do in npm test).
// package.json's "test" script stays the one recipe, and tools/run-tests.mjs the one list of files
// (code health RP-10): this reads the script, here or in the public tree it's exported to, and runs
//   - its `node tools/run-tests.mjs …` command with --test-shard=<i>/<n> (Node's own split: it sorts
//     the files by path, and the k-th of them, counting from 0, goes to shard (k mod n) + 1, so each
//     file runs in exactly one shard, whatever the list's order), and
//   - its other commands (the addon order checks, the codec round-trip) in shard 1 only,
// in the script's order, stopping at the first that fails, as && does, with its exit status.
//
//   node tools/test-shard.mjs <i>/<n>      e.g. node tools/test-shard.mjs 2/3
//   exit: the failing command's status · 2 usage, or a test script this can't run without a shell
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER = 'tools/run-tests.mjs';

/**
 * The commands shard `i/n` runs from an npm test script, each as argv words ('node' first). Throws on
 * a bad shard, or a script that isn't plain node commands joined by && with exactly one RUNNER.
 */
export function shardCommands(script, shard) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(String(shard ?? ''));
  if (!m || Number(m[1]) > Number(m[2])) throw new Error(`a shard is <i>/<n> with 1 <= i <= n, not "${shard}"`);
  const first = m[1] === '1';
  const cmds = String(script ?? '').split('&&').map(c => c.trim()).filter(Boolean).map(c => c.split(/\s+/));
  if (!cmds.length) throw new Error('package.json has no test script');
  for (const w of cmds) {
    if (w[0] !== 'node' || w.some(x => /["'`$|;<>(){}\\*?]/.test(x))) throw new Error(`not a plain node command: ${w.join(' ').slice(0, 80)}`);
  }
  if (cmds.filter(w => w[1] === RUNNER).length !== 1 || cmds.some(w => w[1] === '--test')) {
    throw new Error(`npm test must run its files once, through node ${RUNNER}`);
  }
  return cmds.flatMap(w => (w[1] === RUNNER ? [[...w, `--test-shard=${shard}`]] : first ? [w] : []));
}

/** Runs shard argv[0] of the test script in cwd's package.json. → exit status. */
export function run(argv, { cwd = process.cwd(), spawn = spawnSync, log = s => console.log(s), env = process.env } = {}) {
  if (argv.length !== 1) { log('usage: node tools/test-shard.mjs <i>/<n>'); return 2; }
  let cmds;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    cmds = shardCommands(pkg.scripts?.test, argv[0]);
  } catch (e) { log(`test-shard: ${e.message}`); return 2; }
  for (const [, ...args] of cmds) {
    const shown = args.join(' ');
    log(`test-shard ${argv[0]}: node ${shown.length > 140 ? `${shown.slice(0, 140)} …` : shown}`);
    const r = spawn(process.execPath, args, { cwd, stdio: 'inherit', env });
    if (r.error) { log(`test-shard: node didn't start (${r.error.code ?? r.error.message})`); return 1; }
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) process.exitCode = run(process.argv.slice(2));
