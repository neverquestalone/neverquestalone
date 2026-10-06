#!/usr/bin/env node
// npm test's test files (code health RP-10): every tests/**/*_test.js and *_test.mjs except the
// ones run on their own (EXCLUDE), so a new test file runs without anyone adding it to a list.
//
//   node tools/run-tests.mjs [--test-… options]    node --test <options> <the files>, from the repo root
//   node tools/run-tests.mjs --list                 the files, one a line
//
// npm test runs it between the addon order checks and the codec round trip; tools/test-shard.mjs
// (CI's shards) runs it with Node's --test-shard, and the public repo's export (tools/shell-tree.mjs)
// carries it, so here, in CI and in the exported tree it's the one list.
// exit: node --test's status · 2 usage
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /^tests\/(?:[^/]+\/)*[^/]+_test\.m?js$/;
// Folders under tests/ that hold no tests of npm test's: data, scratch output, installed modules.
const NOT_TESTS = /(^|\/)(fixtures|tmp|node_modules)\//;

/** Test files npm test leaves to other runs, and where they run. */
export const EXCLUDE = Object.freeze({
  'tests/byok/bridge_byok_e2e_test.mjs': 'npm run test:e2e (real time, one file at a time; SY-15)',
  'tests/byok/windows_install_test.mjs': 'test.yml\'s windows-smoke job, on the signed installer it builds',
  'tests/codec_test.js': 'npm test\'s last step, on its own (a script, not node:test)',
});

/** npm test's files among repo-relative paths (forward slashes), sorted. */
export function selectTests(files) {
  return files.filter(f => TEST_FILE.test(f) && !NOT_TESTS.test(f) && !Object.hasOwn(EXCLUDE, f)).sort();
}

/** npm test's files in a checkout (or an exported tree) at root. */
export function testFiles(root = ROOT) {
  const out = [];
  const walk = rel => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const f = `${rel}/${d.name}`;
      if (d.isDirectory()) walk(f);
      else if (d.isFile()) out.push(f);
    }
  };
  walk('tests');
  return selectTests(out);
}

/** Runs node --test on npm test's files with argv's --test-… options. → exit status. */
export function run(argv, { root = ROOT, spawn = spawnSync, log = s => console.log(s), env = process.env } = {}) {
  if (argv.length === 1 && argv[0] === '--list') { for (const f of testFiles(root)) log(f); return 0; }
  if (!argv.every(a => a.startsWith('--test-'))) { log('usage: node tools/run-tests.mjs [--list | --test-… options for node --test]'); return 2; }
  const r = spawn(process.execPath, ['--test', ...argv, ...testFiles(root)], { cwd: root, stdio: 'inherit', env });
  if (r.error) { log(`run-tests: node didn't start (${r.error.code ?? r.error.message})`); return 1; }
  return r.status ?? 1;
}

const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) process.exitCode = run(process.argv.slice(2));
