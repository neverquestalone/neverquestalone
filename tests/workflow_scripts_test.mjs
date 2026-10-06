// Every bash script in .github/workflows parses (`bash -n`). Tests elsewhere match a step's text, which
// can't see a script bash refuses to read: 1.4.3's publish failed its "Check the draft" step on an
// apostrophe ("owner's") inside a single-quoted `node -e '…'`, after the release itself was up (E-064).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runBlocks } from './helpers/workflow-blocks.mjs';

const DIR = path.join(import.meta.dirname, '..', '.github', 'workflows');

test('every bash `run:` script in .github/workflows parses (bash -n): a quote bash can\'t close fails here, not mid-release', { skip: process.platform === 'win32' && 'bash on a Windows PATH may be WSL\'s' }, () => {
  const blocks = fs.readdirSync(DIR).filter(f => f.endsWith('.yml')).flatMap(f => runBlocks(f, fs.readFileSync(path.join(DIR, f), 'utf8')));
  const bash = blocks.filter(b => b.shell === 'bash');
  // The public repo's export holds test.yml alone (tools/shell-tree.mjs, written from this repo's), and at
  // most lane 7's public build beside it; this repo holds the release workflows too.
  const min = fs.readdirSync(DIR).filter(f => f.endsWith('.yml')).length > 2 ? 35 : 2;
  assert.ok(bash.length >= min, `found ${bash.length} bash scripts (49 run blocks at 1.4.3, 40 of them bash; the export's test.yml alone has 2)`);
  const bad = [];
  for (const b of bash) {
    const r = spawnSync('bash', ['-n'], { input: b.script, encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${b.file}:${b.line}: ${r.stderr.trim().split('\n')[0]}`);
  }
  assert.deepEqual(bad, []);
});

test('the parse check would have caught 1.4.3\'s apostrophe', () => {
  const yml = "jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Check\n        run: |\n          node -e '\n            bad.push(\"only the owner's click\");\n          '\n";
  const [b] = runBlocks('x.yml', yml);
  assert.equal(b.shell, 'bash');
  assert.notEqual(spawnSync('bash', ['-n'], { input: b.script, encoding: 'utf8' }).status, 0);
});
