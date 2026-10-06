// capture_x11.py (PRD §11.1, §11.3, PF-7): the Python unit tests
// (tests/byok/capture_x11_test.py: --magic, --pitch-search, the probe's verdict,
// typed errors, the game's lifecycle), then the script's --test-image CLI on PNG
// strips encoded by the addon's real Codec.lua and rendered with scaling, noise
// and gamma. Skips without python3. No display is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { REPO, encodeWithCodec, renderPng } from './helpers/strip-fixtures.mjs';

const SCRIPT = path.join(REPO, 'bridge', 'capture_x11.py');
const PYTEST = path.join(REPO, 'tests', 'byok', 'capture_x11_test.py');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-capture-x11-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let python = null;
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); python = 'python3'; } catch { /* none */ }
const skip = python ? false : 'needs python3';

function decodePng(name, cells, opts, flags = []) {
  const file = path.join(TMP, name + '.png');
  fs.writeFileSync(file, renderPng(cells, opts));
  const r = spawnSync(python, [SCRIPT, '--test-image', file, ...flags], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const record = (i, body) => ['a1b2c3d4', 'c3f9a1', String(i), '', '', 'Hyjal route', body].join('\x1F');

test('python unit tests: --magic, pitch search, the probe, typed errors, the game\'s lifecycle', { skip }, () => {
  const r = spawnSync(python, [PYTEST], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /OK/);
});

test('the default magic is NeverQuestAlone\'s C7 2C; upstream C7 1A needs --magic C71A', { skip }, () => {
  const text = record(5, 'magic ✓ → 2C');
  assert.equal(decodePng('c72c', encodeWithCodec('NeverQuestAlone', 5, text), { pitch: 4, width: 900, height: 300 }).text, text);
  const upstream = encodeWithCodec('upstream', 5, text);
  assert.match(decodePng('c71a-default', upstream, { pitch: 4, width: 900, height: 300 }).error, /no valid strip/);
  assert.equal(decodePng('c71a-flag', upstream, { pitch: 4, width: 900, height: 300 }, ['--magic', 'C71A']).text, text);
  assert.match(decodePng('c72c-as-c71a', encodeWithCodec('NeverQuestAlone', 5, text), { pitch: 4, width: 900, height: 300 }, ['--magic', 'C71A']).error, /no valid strip/);
});

test('a bad --magic is a usage error', { skip }, () => {
  const r = spawnSync(python, [SCRIPT, '--magic', 'C7', '--test-image', '/nonexistent.png'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--magic: magic must be 4 hex digits/);
});

test('--pitch-search decodes 3.5 to 6 px strips (scaled, noisy) that a fixed 4 px cell cannot', { skip }, () => {
  for (const [pitch, extra] of [[5, {}], [5.4, { jitter: 30 }], [3.5, { gamma: 0.8 }], [6, { x0: 3, y0: 2, jitter: 20 }], [4.5, { busyBackground: true }]]) {
    const text = record(60, 'long payload '.repeat(60));
    const cells = encodeWithCodec('NeverQuestAlone', 60, text);
    const opts = { pitch, width: 1300, height: 360, ...extra };
    const fixed = decodePng(`fixed-${pitch}`, cells, opts);
    assert.ok(fixed.text !== text, `pitch ${pitch} decoded without --pitch-search`);
    const measured = decodePng(`search-${pitch}`, cells, opts, ['--pitch-search']);
    assert.equal(measured.text, text, `pitch ${pitch}: ${JSON.stringify(measured).slice(0, 160)}`);
  }
});

test('--pitch-search leaves the native 4 px path and its rejects as they were', { skip }, () => {
  const text = record(61, 'native');
  assert.equal(decodePng('native-search', encodeWithCodec('NeverQuestAlone', 61, text), { pitch: 4, width: 900, height: 300 }, ['--pitch-search']).text, text);
  const cells = encodeWithCodec('NeverQuestAlone', 62, record(62, 'checksum victim'));
  cells[40] = (cells[40] + 3) % 8;
  assert.equal(decodePng('damaged-search', cells, { pitch: 4, width: 900, height: 300 }, ['--pitch-search']).error, 'checksum');
});
