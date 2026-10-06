// Round-trip test: the addon's real Codec.lua (addon/NeverQuestAlone, run in a Lua VM) -> PNG ->
// the Linux capture helper's decoder (bridge/capture_x11.py --test-image). Simulates game
// rendering with heavy noise and gamma. Skips without python3: the Mac and Windows decoders
// have their own round trips (tests/capture_mac_test.js, tests/byok/capture_windows_decoder_test.mjs).
'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const { encodeWithLua, render } = require('./helpers/strip-render.js');

try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); }
catch { console.log('SKIP Codec.lua round-trip: python3 is required.'); process.exit(0); }

const CAPTURE_X11 = path.join(__dirname, '..', 'bridge', 'capture_x11.py');
const TMP = path.join(__dirname, 'tmp');
const CELLS = 200, MAXROWS = 48, CELL = 4;
fs.mkdirSync(TMP, { recursive: true });

function decode(file) {
  const out = execFileSync('python3', [CAPTURE_X11, '--test-image', file], { encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop());
}

const cases = [
  { id: 7, payload: 'sess1\x1Fchat1\x1F7\x1FC:\\Users\\me\\proj\x1F\x1Fname\x1Fhéllo wörld ✓ — "quotes" & \\backslash\\ end', jitter: 0, gamma: 1 },
  { id: 4242, payload: 'sess1\x1Fchat1\x1F4242\x1FC:\\x\x1Fn\x1F\x1F' + 'Refactor the player controller so jumping feels less floaty. '.repeat(40), jitter: 60, gamma: 0.6 },
  { id: 9, payload: 'sess1\x1Fchat1\x1F9\x1FC:\\x\x1F\x1F\x1F' + 'a fairly long paste: '.repeat(140), jitter: 100, gamma: 1.8 },
  { id: 65000, payload: '\x1F\x1F\x1F\x1F\x1F\x1Fx', jitter: 120, gamma: 1 },
];

let pass = 0;
for (const t of cases) {
  const cells = encodeWithLua(t.id, t.payload);
  const file = path.join(TMP, `strip_${t.id}.png`);
  fs.writeFileSync(file, render(cells, { width: CELLS * CELL, height: MAXROWS * CELL, jitter: t.jitter, gamma: t.gamma, seed: t.id }));
  const res = decode(file);
  const ok = res.id === t.id && res.text === t.payload;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  id=${t.id}  bytes=${Buffer.byteLength(t.payload)}  cells=${cells.length}  rows=${Math.ceil(cells.length / CELLS)}  noise=±${t.jitter} gamma=${t.gamma}` + (ok ? '' : `\n   got ${JSON.stringify(res).slice(0, 200)}`));
}
console.log(pass === cases.length ? '>>> CODEC ROUND-TRIP PASS' : '>>> CODEC ROUND-TRIP FAIL');
process.exit(pass === cases.length ? 0 : 1);
