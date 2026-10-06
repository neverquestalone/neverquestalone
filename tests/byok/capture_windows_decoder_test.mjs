// The Windows capture helper's portable parts (PRD §11.3, DB11; PF-1): decoder.c,
// errlimit.c and winpick.c, compiled with this machine's cc into the decode_raw harness,
// against raw-RGB (PPM) strips encoded by the addon's real Codec.lua and rendered
// like a compositor might show them: 4, 5 and 6.5 px cells, a title bar, a busy
// background, noise and gamma. Also the helper's own pixel format (DXGI's 4-byte
// BGRA with padded rows), its crop (900 x 300, grown to the measured strip) and
// its typed-error limiter, and which window it takes for the game's (winpick.c,
// display DR-05). Skips without cc.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { REPO, encodeWithCodec, encodeBytes, bytesToCells, renderRgb, ppm } from './helpers/strip-fixtures.mjs';

const SRC = path.join(REPO, 'bridge', 'capture', 'windows');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-capture-win-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function compile() {
  const cc = process.env.CC || 'cc';
  try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); } catch { return null; }
  const bin = path.join(TMP, 'decode_raw');
  execFileSync(cc, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-o', bin,
    ...['decoder.c', 'errlimit.c', 'jsonl.c', 'ppm.c', 'winpick.c', 'decode_raw.c'].map(f => path.join(SRC, f)), '-lm'], { stdio: ['ignore', 'ignore', 'inherit'] });
  return bin;
}

const BIN = compile();
const skip = BIN ? false : 'needs a C compiler (cc)';

function fixture(name, cells, opts) {
  const file = path.join(TMP, name + '.ppm');
  fs.writeFileSync(file, ppm(renderRgb(cells, opts)));
  return file;
}

/** Decode files in one harness run; returns one result per file, in order. */
function decode(files, extra = []) {
  const out = execFileSync(BIN, [...extra, ...files], { encoding: 'utf8' });
  return out.trim().split('\n').map(l => JSON.parse(l));
}

const US = '\x1F', RS = '\x1E';
const record = (i, body) => ['a1b2c3d4', 'c3f9a1', String(i), '', '', 'Hyjal route', body].join(US);

test('decodes NeverQuestAlone strips (C7 2C) at 4, 5 and 6.5 px cells', { skip }, () => {
  const text = record(41, 'fastest way to Hyjal from here? ✓ Mulgore → Hyjal');
  const pitches = [4, 5, 6.5];
  const files = pitches.map(p => fixture(`pitch-${p}`, encodeWithCodec('NeverQuestAlone', 41, text), { pitch: p, width: 1400, height: 400 }));
  decode(files).forEach((r, i) => {
    assert.equal(r.status, 'decoded', JSON.stringify(r));
    assert.equal(r.id, 41);
    assert.equal(r.text, text);
    assert.equal(r.bytes, Buffer.byteLength(text));
    assert.ok(Math.abs(r.geometry.pitch - pitches[i]) < 0.05, `pitch ${r.geometry.pitch} vs ${pitches[i]}`);
  });
});

test('the magic is configurable: upstream C7 1A only with --magic C71A, and never by default', { skip }, () => {
  const text = record(3, 'strip v1');
  const upstream = fixture('magic-c71a', encodeWithCodec('upstream', 3, text), { pitch: 4 });
  const fork = fixture('magic-c72c', encodeWithCodec('NeverQuestAlone', 3, text), { pitch: 4 });
  const [a, b] = decode([upstream, fork]);
  assert.equal(a.status, 'none', 'C7 1A must not decode under the default C7 2C');
  assert.equal(b.text, text);
  const [c, d] = decode([upstream, fork], ['--magic', 'C71A']);
  assert.equal(c.text, text);
  assert.equal(d.status, 'none');
  assert.equal(decode([fork], ['--magic', '0xc72c'])[0].text, text);
});

test('decodes through noise, gamma, a title bar, a busy background and an offset', { skip }, () => {
  const cases = [
    ['noise-gamma-titlebar', { pitch: 4, y0: 56, titleBar: 56, jitter: 40, gamma: 1.2 }],
    ['fractional-5.4-noise', { pitch: 5.4, jitter: 30 }],
    ['fractional-4.5-offset', { pitch: 4.5, x0: 1, y0: 28, titleBar: 28, gamma: 0.8 }],
    ['busy-6.25', { pitch: 6.25, busyBackground: true, height: 700 }],
    ['crop-900x300', { pitch: 4, width: 900, height: 300, jitter: 20 }],
  ];
  const text = record(12, 'héllo wörld — "quotes" & \\backslash\\ ✓');
  const files = cases.map(([name, opts]) => fixture(name, encodeWithCodec('NeverQuestAlone', 12, text), opts));
  decode(files).forEach((r, i) => assert.equal(r.text, text, `${cases[i][0]}: ${JSON.stringify(r).slice(0, 200)}`));
});

test('a damaged strip is rejected on its checksum; no strip is nothing', { skip }, () => {
  const cells = encodeWithCodec('NeverQuestAlone', 9, record(9, 'checksum victim'));
  cells[40] = (cells[40] + 3) % 8; // flip bits in the payload
  const bad = fixture('damaged', cells, { pitch: 4 });
  const bad5 = fixture('damaged-5', cells, { pitch: 5, jitter: 20 });
  const empty = fixture('empty', [], { pitch: 4, busyBackground: true });
  const [a, b, c] = decode([bad, bad5, empty]);
  assert.equal(a.status, 'rejected');
  assert.equal(a.reason, 'checksum');
  assert.equal(b.reason, 'checksum');
  assert.equal(c.status, 'none');
});

test('a length past the strip is rejected, not read out of bounds', { skip }, () => {
  // A frame header that claims 60000 bytes: the strip holds at most 3600.
  const lcells = bytesToCells([0xC7, 0x2C, 0, 5, 0xEA, 0x60, ...Buffer.from('short'), 0, 0]);
  const [r] = decode([fixture('length-liar', lcells, { pitch: 4 })]);
  assert.equal(r.status, 'rejected');
  assert.equal(r.reason, 'length');
});

test('a near-full strip (two records, ~40 rows) decodes at a fractional pitch', { skip }, () => {
  const long = 'x'.repeat(1400) + ' middle ' + 'y'.repeat(1400);
  const text = record(7, long.slice(0, 1500)) + RS + record(8, long.slice(1500, 2880));
  const [r] = decode([fixture('long-5.4', encodeWithCodec('NeverQuestAlone', 8, text), { pitch: 5.4, height: 800, jitter: 20 })]);
  assert.equal(r.status, 'decoded', JSON.stringify(r).slice(0, 300));
  assert.equal(r.text, text);
});

test('sweep: long strips at 16 pitches (3.6 to 9 px) and offsets', { skip }, () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const cases = [];
  for (let i = 0; i < 16; i++) {
    const pitch = Math.round((3.6 + rand() * 5.4) * 100) / 100;
    const titleBar = rand() < 0.5 ? 0 : [28, 56, 64][i % 3];
    const opts = { pitch, x0: Math.floor(rand() * 4), y0: titleBar + Math.floor(rand() * 3), titleBar,
      jitter: Math.floor(rand() * 50), gamma: rand() < 0.3 ? 0.7 + rand() * 0.8 : 0, seed: i + 1,
      busyBackground: i % 4 === 0, height: 900, width: 1900 };
    const text = record(100 + i, 'z'.repeat(200 + Math.floor(rand() * 2400)));
    cases.push({ i, pitch, text, file: fixture(`sweep-${i}`, encodeWithCodec('NeverQuestAlone', 100 + i, text), opts) });
  }
  const results = decode(cases.map(c => c.file));
  const failures = cases.filter((c, k) => results[k].text !== c.text).map((c, k) => ({ i: c.i, pitch: c.pitch, got: results[k].status, reason: results[k].reason }));
  assert.deepEqual(failures, []);
});

test('payload text reaches JSON intact: separators, quotes, non-ASCII; invalid UTF-8 becomes U+FFFD', { skip }, () => {
  const good = record(21, 'tab\there, newline\nthere, NUL-free ✓ 🐉 "q" \\ end') + RS + 'x';
  const bad = Buffer.from([0x41, 0xFF, 0x42, 0xE2, 0x82, 0x43, 0xC0, 0xAF, 0xED, 0xA0, 0x80, 0xF0, 0x9F, 0x90, 0x89, 0xF4, 0x90, 0x80, 0x80, 0xE2, 0x82]);
  // Cross-check: the JS encoder agrees with Codec.lua cell for cell.
  assert.deepEqual(encodeBytes(21, Buffer.from(good, 'utf8')), encodeWithCodec('NeverQuestAlone', 21, good));
  const [a, b] = decode([fixture('utf8-good', encodeWithCodec('NeverQuestAlone', 21, good), { pitch: 4 }),
    fixture('utf8-bad', encodeBytes(22, bad), { pitch: 4 })]);
  assert.equal(a.text, good);
  assert.equal(b.status, 'decoded');
  assert.equal(b.bytes, bad.length);
  assert.equal(b.text, new TextDecoder('utf-8').decode(bad)); // WHATWG maximal-subpart replacement
});

test('the hint: the last good geometry decodes directly, and a stale one falls back to the search', { skip }, () => {
  const text = record(30, 'hinted');
  const file = fixture('hint', encodeWithCodec('NeverQuestAlone', 30, text), { pitch: 5, x0: 2, y0: 10, titleBar: 10 });
  const [free] = decode([file]);
  const g = free.geometry;
  assert.equal(decode([file], ['--hint', `${g.x0},${g.y0},${g.pitch}`])[0].text, text);
  assert.equal(decode([file], ['--hint', '0,0,4'])[0].text, text);
  // A hint that isn't finite is no geometry: nothing is read with it, and the search still finds the
  // strip (code health LS-12: on x86-64 a NaN hint read a pixel far outside the picture and crashed).
  for (const bad of ['nan,0,4', '0,nan,4', '0,0,nan', 'nan,nan,nan', 'inf,0,4', '0,-inf,4']) assert.equal(decode([file], ['--hint', bad])[0].text, text, bad);
});

test('a 900x300 crop decodes in well under the 250 ms tick (idle frames too)', { skip }, () => {
  const text = record(40, 'q'.repeat(2000));
  const strip = fixture('perf-strip', encodeWithCodec('NeverQuestAlone', 40, text), { pitch: 4, width: 900, height: 300 });
  const idle = fixture('perf-idle', [], { pitch: 4, width: 900, height: 300, busyBackground: true });
  const [a, b] = decode([strip, idle], ['--repeat', '50']);
  assert.equal(a.text, text);
  assert.equal(b.status, 'none');
  assert.ok(a.ms < 25 && b.ms < 25, `decode ${a.ms} ms, idle ${b.ms} ms`);
});

test('DXGI\'s pixels: 4-byte BGRA (and RGBA) with padded rows decode like RGB', { skip }, () => {
  const text = record(50, 'bgra ✓ → padded rows ' + 'b'.repeat(400));
  const cells = encodeWithCodec('NeverQuestAlone', 50, text);
  const files = [fixture('bgra-4', cells, { pitch: 4, width: 900, height: 300, jitter: 20 }),
    fixture('bgra-5.4', cells, { pitch: 5.4, width: 1300, height: 360, jitter: 20, gamma: 1.1 })];
  for (const flags of [[], ['--bgra-stride', '0'], ['--bgra-stride', String(1300 * 4 + 192)], ['--rgba-stride', String(1300 * 4 + 64)]]) {
    decode(files, flags).forEach((r, i) => assert.equal(r.text, text, `${flags.join(' ')} ${i}: ${JSON.stringify(r).slice(0, 200)}`));
  }
  // (BGRA and RGBA put R at opposite ends of the pixel, so both decoding proves the order flag is honored.)
  const [narrow] = decode([files[0]], ['--bgra-stride', '100']);
  assert.match(narrow.error, /narrower than the image/);
});

test('the crop: 900 x 300 cuts a scaled strip off; the helper grows it to the strip and decodes the next frame', { skip }, () => {
  const long = record(41, 'fastest way to Hyjal from here? ✓ Mulgore → Hyjal ' + 'q'.repeat(300));
  for (const pitch of [5, 6.5, 9]) {
    // The whole strip: x0 + 200 p + 8 wide and y0 + 48 p + 8 tall (x0, y0 < 2 px here), at least 900 x 300.
    const crop = { width: Math.ceil(200 * pitch) + 8, height: Math.max(300, Math.ceil(48 * pitch) + 8) };
    const file = fixture(`crop-${pitch}`, encodeWithCodec('NeverQuestAlone', 41, long), { pitch, width: 2000, height: 700, jitter: 20 });
    // One frame at the old fixed crop: cut off, read as truncated (the defect).
    const [cut] = decode([file], ['--crop', '900x300']);
    assert.deepEqual([cut.status, cut.reason], ['rejected', 'truncated'], `pitch ${pitch}: ${JSON.stringify(cut).slice(0, 200)}`);
    assert.ok(Math.abs(cut.geometry.pitch - pitch) < 0.05, 'the cut-off strip still measures the pitch');
    // The helper's rule: the next crop holds the whole strip, and it decodes.
    const [grown] = decode([file], ['--crop', '900x300', '--frames', '2']);
    assert.equal(grown.text, long, `pitch ${pitch}: ${JSON.stringify(grown).slice(0, 200)}`);
    assert.ok(grown.crop.width >= crop.width && grown.crop.width <= crop.width + 2, `pitch ${pitch}: crop ${JSON.stringify(grown.crop)}`);
    assert.ok(grown.crop.height >= crop.height && grown.crop.height <= crop.height + 2, `pitch ${pitch}: crop ${JSON.stringify(grown.crop)}`);
    // Through the helper's real pixel format too.
    assert.equal(decode([file], ['--crop', '900x300', '--frames', '2', '--bgra-stride', String(2000 * 4 + 128)])[0].text, long);
  }
});

test('the crop: a native 4 px strip keeps 900 x 300; a short scaled frame sizes it for the next; no strip keeps it', { skip }, () => {
  const long = record(42, 'n'.repeat(1200));
  const native = fixture('crop-native', encodeWithCodec('NeverQuestAlone', 42, long), { pitch: 4, width: 2000, height: 700 });
  const [a] = decode([native], ['--crop', '900x300', '--frames', '3']);
  assert.equal(a.text, long);
  assert.deepEqual(a.crop, { width: 900, height: 300 });
  // 20 bytes fit in one 900 px row at 5 px: it decodes in the first frame, and sizes the crop anyway.
  const short = fixture('crop-short-5', encodeWithCodec('NeverQuestAlone', 43, 'hi'), { pitch: 5, width: 2000, height: 700 });
  const [b] = decode([short], ['--crop', '900x300']);
  assert.equal(b.text, 'hi');
  assert.deepEqual(decode([short], ['--crop', '900x300', '--frames', '2'])[0].crop, { width: 1008, height: 300 });
  const idle = fixture('crop-idle', [], { pitch: 5, width: 2000, height: 700, busyBackground: true });
  const [c] = decode([idle], ['--crop', '900x300', '--frames', '3']);
  assert.deepEqual([c.status, c.crop], ['none', { width: 900, height: 300 }]);
  // Never past the window: a small window clamps the crop.
  const small = fixture('crop-small', encodeWithCodec('NeverQuestAlone', 44, long), { pitch: 5, width: 950, height: 260 });
  assert.deepEqual(decode([small], ['--crop', '900x300', '--frames', '2'])[0].crop, { width: 950, height: 260 });
});

test('typed errors: said when they start, then at most once a minute per kind, however often they flap', { skip }, () => {
  const script = [
    '0 set access_lost', '100 clear',            // said, then "capturing"
    '5000 set access_lost', '5100 clear',        // back within the minute: quiet both ways
    '30000 set access_lost', '30100 clear',
    '60000 set access_lost',                     // a minute on: said again
    '60100 set window_not_found',                // another kind: its own minute
    '61000 set window_not_found', '62000 clear', '62100 clear',
  ].join('\n') + '\n';
  const r = spawnSync(BIN, ['--errors'], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  // The harness prints through the C runtime, whose stdout is text mode on Windows (CRLF); the
  // helper itself writes raw bytes with WriteFile.
  assert.deepEqual(r.stdout.trim().split(/\r?\n/), [
    'error access_lost', 'capturing',
    'quiet', 'quiet',
    'quiet', 'quiet',
    'error access_lost',
    'error window_not_found',
    'quiet', 'capturing', 'quiet',
  ]);
  // A condition that holds says it once a minute, not every second.
  const held = Array.from({ length: 180 }, (_, i) => `${i * 1000} set window_not_found`).join('\n') + '\n';
  const said = spawnSync(BIN, ['--errors'], { input: held, encoding: 'utf8' }).stdout.split('\n').filter(l => l.startsWith('error'));
  assert.equal(said.length, 3);
});

// ---------------------------------------------------------------- which window is the game's (DR-05)

// The bridge's rules (boot.mjs: FOREVER_FLAVORS, NOT_GAME, the WoW folder it serves) and a window
// list, through winpick.c as the helper runs it.
const GAME_DIR = 'C:\\Program Files (x86)\\World of Warcraft\\_forever_';
const RULES = { names: ['Wow*'], flavors: ['_forever_', '_classic_beta_'], notGame: ['VoiceProxy', 'Error'], exeDir: GAME_DIR };
const win = (id, pid, path, { iconic = false, width = 1920, height = 1080 } = {}) => ({ id, pid, path, iconic, width: iconic ? 0 : width, height: iconic ? 0 : height });
function pickWith({ names = RULES.names, flavors = RULES.flavors, notGame = RULES.notGame, exeDir = RULES.exeDir, windows, attached = null }) {
  const script = [
    ...names.map(n => `name ${n}`), ...flavors.map(f => `flavor ${f}`), ...notGame.map(n => `notgame ${n}`),
    ...(exeDir ? [`exedir ${exeDir}`] : []),
    ...windows.map(w => `window ${w.id} ${w.pid} ${w.iconic ? 1 : 0} ${w.width} ${w.height} ${w.path ?? '-'}`),
    ...(attached != null ? [`attached ${attached}`] : []),
  ].join('\n') + '\n';
  const r = spawnSync(BIN, ['--pick'], { input: script, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  out.refused = Object.fromEntries(out.windows.map(w => [w.id, w.refused]));
  out.under = Object.fromEntries(out.windows.map(w => [w.id, w.underExeDir]));
  return out;
}
const WOWUP = 'C:\\Users\\Jürgen\\AppData\\Local\\Programs\\WowUp\\WowUp.exe';

test('D-03: WowUp.exe beside the game is never the game, visible and larger or not; the game minimized still is', { skip }, () => {
  const both = pickWith({ windows: [win(1, 100, WOWUP, { width: 2560, height: 1400 }), win(2, 200, `${GAME_DIR}\\Wow.exe`)] });
  assert.equal(both.best, 2);
  assert.equal(both.refused[1], 'not in a game folder');
  assert.equal(both.refused[2], null);
  // An iconic game beside a visible WowUp: the game (the helper says it's minimized).
  assert.equal(pickWith({ windows: [win(1, 100, WOWUP), win(2, 200, `${GAME_DIR}\\Wow.exe`, { iconic: true })] }).best, 2);
  // WowUp alone is no game at all.
  assert.equal(pickWith({ windows: [win(1, 100, WOWUP)] }).best, null);
  // Attached to WowUp (what the old helper did): it moves to the game.
  assert.deepEqual([both.best, pickWith({ windows: [win(1, 100, WOWUP), win(2, 200, `${GAME_DIR}\\Wow.exe`)], attached: 1 }).switch],
    [2, "the attached window is gone, or no longer the game's"]);
});

test('DR-05: the flavor folder is the gate, as data: an unknown Wow*.exe in one is the game, Wow.exe in no flavor folder isn\'t, case never matters, -ARM64 is a Wow*', { skip }, () => {
  const other = pickWith({ exeDir: null, windows: [win(1, 1, 'D:\\Games\\WoW\\_classic_beta_\\WowNext.exe'), win(2, 2, 'D:\\Games\\WoW\\Wow.exe')] });
  assert.equal(other.refused[1], null, 'an exe name nobody listed, in a flavor folder');
  assert.equal(other.refused[2], 'not in a game folder');
  assert.equal(other.best, 1);
  const cased = pickWith({ windows: [win(1, 1, 'C:\\PROGRAM FILES (X86)\\WORLD OF WARCRAFT\\_FOREVER_\\WOW.EXE')] });
  assert.deepEqual([cased.best, cased.under[1]], [1, true], 'WOW.EXE under _FOREVER_, and under the served folder whatever its case');
  assert.equal(pickWith({ windows: [win(1, 1, `${GAME_DIR}\\Wow-ARM64.exe`)] }).best, 1);
  assert.equal(pickWith({ windows: [win(1, 1, `${GAME_DIR}\\Wow-64.exe`)] }).best, 1);
  // The flavor must be a folder: a file named like one, or a folder that only starts with the name, isn't.
  assert.equal(pickWith({ exeDir: null, windows: [win(1, 1, 'C:\\Games\\_forever_old\\Wow.exe'), win(2, 2, 'C:\\Games\\x\\_forever_')] }).best, null);
  // A path that can't be read never matches; a name that isn't Wow* never does.
  const odd = pickWith({ windows: [win(1, 1, null), win(2, 2, `${GAME_DIR}\\Battle.net.exe`)] });
  assert.deepEqual([odd.best, odd.refused[1], odd.refused[2]], [null, "its path can't be read", 'not a game name']);
  // No flavor folder given: nothing is the game's (the folders are the bridge's data, never guessed).
  assert.equal(pickWith({ flavors: [], windows: [win(1, 1, `${GAME_DIR}\\Wow.exe`)] }).best, null);
  // A visible window under 200 x 150 is a launcher or a splash screen; a minimized one has no size to judge.
  const small = pickWith({ windows: [win(1, 1, `${GAME_DIR}\\Wow.exe`, { width: 180, height: 120 })] });
  assert.deepEqual([small.best, small.refused[1]], [null, 'too small (a launcher or a splash screen)']);
});

test('SY-05: the game\'s own crash reporter and voice proxy are refused (--not-game), even visible beside a minimized game', { skip }, () => {
  const r = pickWith({ windows: [
    win(1, 10, `${GAME_DIR}\\WowError.exe`, { width: 600, height: 400 }),
    win(2, 11, `${GAME_DIR}\\WowVoiceProxy.exe`, { width: 800, height: 600 }),
    win(3, 12, `${GAME_DIR}\\Wow.exe`, { iconic: true }),
  ] });
  assert.deepEqual([r.best, r.refused[1], r.refused[2], r.refused[3]], [3, "the game's helper, not the game", "the game's helper, not the game", null]);
  assert.equal(pickWith({ notGame: ['voiceproxy'], windows: [win(1, 1, `${GAME_DIR}\\WOWVOICEPROXY.EXE`)] }).best, null, 'any case');
});

test('DR-05: --exe-dir only ranks: a junction or a \\\\?\\ prefix loses or keeps the preference, never the game; the served folder wins over another install', { skip }, () => {
  // The same install reached through a junction (another drive letter): still the game, without the preference.
  const junction = pickWith({ windows: [win(1, 1, 'D:\\WoW\\_forever_\\Wow.exe')] });
  assert.deepEqual([junction.best, junction.under[1]], [1, false]);
  // A \\?\ or \??\ path, and forward slashes: the preference kept.
  for (const p of [`\\\\?\\${GAME_DIR}\\Wow.exe`, `\\??\\${GAME_DIR}\\Wow.exe`, `${GAME_DIR.replace(/\\/g, '/')}/Wow.exe`]) {
    const r = pickWith({ windows: [win(1, 1, p)] });
    assert.deepEqual([r.best, r.under[1]], [1, true], p);
  }
  const unc = pickWith({ exeDir: '\\\\nas\\games\\World of Warcraft\\_forever_', windows: [win(1, 1, '\\\\?\\UNC\\nas\\games\\World of Warcraft\\_forever_\\Wow.exe')] });
  assert.deepEqual([unc.best, unc.under[1]], [1, true], 'a share, as \\\\?\\UNC\\');
  // Not a prefix of a longer folder name.
  assert.equal(pickWith({ windows: [win(1, 1, `${GAME_DIR}2\\_forever_\\Wow.exe`)] }).under[1], false);
  // Two installs: the served one, even minimized and smaller, over another visible one.
  const two = pickWith({ windows: [win(1, 1, 'E:\\Other\\World of Warcraft\\_forever_\\Wow.exe', { width: 2560, height: 1440 }), win(2, 2, `${GAME_DIR}\\Wow.exe`, { iconic: true })] });
  assert.equal(two.best, 2);
});

test('DR-05: the re-scan moves only to a better window: into the served folder, visible over minimized, larger; never on a tie or for the same window', { skip }, () => {
  const other = 'E:\\Other\\World of Warcraft\\_forever_\\Wow.exe';
  const here = `${GAME_DIR}\\Wow.exe`;
  const move = (windows, attached) => pickWith({ windows, attached });
  assert.equal(move([win(1, 1, other), win(2, 2, here, { width: 800, height: 600 })], 1).switch, "it is in the game folder the bridge serves, the attached one isn't");
  assert.equal(move([win(1, 1, here, { iconic: true }), win(2, 2, here)], 1).switch, 'it is visible, the attached one is minimized');
  assert.equal(move([win(1, 1, here, { width: 800, height: 600 }), win(2, 2, here)], 1).switch, 'it is larger');
  assert.equal(move([win(1, 1, here), win(2, 2, here)], 1).switch, null, 'a tie stays');
  assert.equal(move([win(1, 1, here), win(2, 2, here, { width: 800, height: 600 })], 1).switch, null);
  assert.equal(move([win(1, 1, here), win(2, 2, other, { width: 2560, height: 1440 })], 1).switch, null, 'the served folder wins over size');
  assert.equal(move([win(1, 1, here)], 1).switch, null, 'the same window');
  // A new game process in place of the old one: the old window gone from the list.
  const fresh = move([win(9, 300, here)], 5);
  assert.deepEqual([fresh.best, fresh.switch], [9, "the attached window is gone, or no longer the game's"]);
});

// ---------------------------------------------------------------- the session's lock (DR-26)

/** winpick.c's lock decision and away line: each script line prints what the helper would send after it. */
function lockRun(lines) {
  const r = spawnSync(BIN, ['--lock'], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(/\r?\n/);
}

test('SY-13, SY-17d: access denied or a disconnected session is "locked" only when the input desktop confirms it; a grabbed frame clears it; otherwise access_lost stays typed', { skip }, () => {
  assert.deepEqual(lockRun(['0 tick', '5000 open denied other', '7000 open denied other', '60000 frame']),
    ['away null', 'away locked', 'quiet', 'away null'], 'the lock screen (Winlogon), then unlocked');
  assert.deepEqual(lockRun(['0 tick', '5000 open denied unopenable']), ['away null', 'away locked'], 'an input desktop this account can\'t open');
  assert.deepEqual(lockRun(['0 tick', '5000 open disconnected other']), ['away null', 'away locked'], 'a disconnected session');
  // Access denied with the player's own desktop in front isn't the lock: the typed access_lost, as before.
  assert.deepEqual(lockRun(['0 tick', '5000 open denied default', '7000 open denied default']), ['away null', 'access_lost', 'access_lost']);
  // Locked, then the desktop comes back but duplication is still refused: not locked, typed.
  assert.deepEqual(lockRun(['0 tick', '5000 open denied other', '9000 open denied default']), ['away null', 'away locked', 'access_lost + away null']);
  // Another failure (unsupported, say) neither locks nor unlocks.
  assert.deepEqual(lockRun(['0 tick', '5000 open other other', '6000 open denied other', '8000 open other default', '9000 tick']),
    ['away null', 'quiet', 'away locked', 'quiet', 'quiet']);
});

test('DR-26: the away line goes at once when the helper starts, on every change after it, at most once a second, and never a repeat', { skip }, () => {
  assert.deepEqual(lockRun(['0 tick', '10 open denied other', '500 tick', '1010 tick', '1020 frame', '1500 tick', '2020 tick', '2100 tick']),
    ['away null', 'quiet', 'quiet', 'away locked', 'quiet', 'quiet', 'away null', 'quiet']);
  // A lock and an unlock within the second: nothing to say, the bridge was told null and it's null.
  assert.deepEqual(lockRun(['0 tick', '100 open denied other', '200 frame', '1500 tick']), ['away null', 'quiet', 'quiet', 'quiet']);
});

// ---------------------------------------------------------------- an unsupported monitor's retries (SY-24)

/** winpick.c's wait between tries to open duplication: each "try" line prints try or wait. */
function openRun(lines) {
  const r = spawnSync(BIN, ['--open'], { input: lines.join('\n') + '\n', encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split(/\r?\n/);
}

test('SY-24: an unsupported monitor is tried again after 2 s, 10 s, then every 60 s, not every 2 s; another monitor, a success or another failure starts over', { skip }, () => {
  // Each try that fails as unsupported, and the tries in between.
  const fails = at => [`${at} try 1`, `${at} unsupported 1`];
  assert.deepEqual(openRun([...fails(0), '1999 try 1', ...fails(2000), '11999 try 1', ...fails(12000), '71999 try 1', ...fails(72000), '131999 try 1', '132000 try 1']),
    ['try', 'wait', 'try', 'wait', 'try', 'wait', 'try', 'wait', 'try']);
  // An hour of it, the helper's loop asking each second and every try failing: about 60 tries, not
  // about 1,800 (a D3D11 device each, every 2 s). A "wait" answer isn't a try, so no result follows it.
  const hour = [];
  const r = spawnSync(BIN, ['--open'], { input: (() => {
    let t = 0, after = 0, fails = 0;
    for (; t < 3_600_000; t += 1000) {
      hour.push(`${t} try 1`);
      if (t >= after) { hour.push(`${t} unsupported 1`); fails = Math.min(fails + 1, 3); after = t + [2000, 10000, 60000][fails - 1]; }
    }
    return hour.join('\n') + '\n';
  })(), encoding: 'utf8' });
  const said = r.stdout.trim().split(/\r?\n/);
  assert.equal(said.length, 3600);
  assert.equal(said.filter(x => x === 'try').length, 62, 'the harness agrees with the schedule: 2 s, 10 s, then each minute');
  // WoW moved to another monitor: tried at once, and counted from the start there.
  assert.deepEqual(openRun([...fails(0), ...fails(2000), '3000 try 9', '3000 unsupported 9', '4000 try 9', '5000 try 9']), ['try', 'try', 'try', 'wait', 'try']);
  // A success, or another failure (the lock: back within 2 s of the unlock), starts over.
  assert.deepEqual(openRun([...fails(0), ...fails(2000), '12000 try 1', '12000 ok 1', '12001 try 1', '12001 unsupported 1', '13000 try 1', '14001 try 1']), ['try', 'try', 'try', 'try', 'wait', 'try']);
});

test('main.c and build.sh use the tested crop rule and error limiter', () => {
  const main = fs.readFileSync(path.join(SRC, 'main.c'), 'utf8');
  assert.match(main, /wc_crop_size\(&o->spec, have_measured \? &measured : NULL, o->width, o->height/);
  assert.match(main, /wc_measured\(&g_result, &measured\)/);
  assert.match(main, /wc_errlimit_set\(&g_errors, kind, GetTickCount64\(\)\)/);
  assert.doesNotMatch(main, /g_err_kind/);
  assert.match(main, /if \(wc_pick_refused\(&c->o->rules, w\)\) return TRUE;/, 'the window search asks winpick.c');
  assert.match(main, /best = wc_pick_best\(&o->rules, c->w, c->n\);/);
  assert.match(main, /sw = still \? wc_pick_switch\(&o->rules, c->w, attached, best\) : WC_SWITCH_GONE;/);
  assert.doesNotMatch(main, /wildcard_match|image_matches/, 'no second matcher beside winpick.c');
  // DR-26: dda_open's access denied asks winpick.c with the input desktop; a frame clears it; the line never goes through errlimit.
  assert.match(main, /if \(!wc_away_open_failed\(&g_away, hr == E_ACCESSDENIED \? WC_DUP_ACCESS_DENIED : WC_DUP_SESSION_DISCONNECTED,\s+input_desktop\(desk, \(DWORD\)sizeof desk\)\)\)\s+set_error\("access_lost"/);
  assert.match(main, /clear_error\(\);\n\s+wc_away_frame\(&g_away\);/);
  assert.match(main, /if \(wc_away_due\(&g_away, GetTickCount64\(\)\)\)\n\s+send_line\(/);
  assert.match(main, /emit_start\(&o, pmv2\);\n\s+say_away\(\);/, 'the first away line right after the start line');
  assert.match(main, /opened = dda_open\(&d, mon\);\n\s+wc_open_result\([^;]*;\n(?:\s+\/\*[\s\S]*?\*\/\n)?\s+say_away\(\);\n\s+if \(opened != 0\) \{/,
    'the lock an open decided is said at once, not after the 2 s wait');
  // SY-24: every capture_unsupported path of dda_open says so, and the loop asks winpick.c before it tries.
  const open = main.slice(main.indexOf('static int dda_open('), main.indexOf('/* 1: a new frame is mapped'));
  const unsupportedPaths = (open.match(/set_error\("capture_unsupported"/g) || []).length;
  assert.equal(unsupportedPaths, 7, 'no DXGI, no output, no D3D11, no IDXGIOutput1, four capturers, another refusal, a rotated display');
  assert.equal((open.match(/return OPEN_UNSUPPORTED;/g) || []).length + (open.match(/unsupported = 1;/g) || []).length, unsupportedPaths, 'each unsupported path returns OPEN_UNSUPPORTED');
  assert.match(open, /return unsupported \? OPEN_UNSUPPORTED : -1;/);
  assert.match(main, /if \(!wc_open_may_try\(&open_wait, [^;]*?GetTickCount64\(\)\)\) \{\n\s+Sleep\(1000\);\n\s+continue;/);
  assert.match(main, /wc_open_result\(&open_wait, [^;]*opened == OPEN_UNSUPPORTED, GetTickCount64\(\)\);/);
  const build = fs.readFileSync(path.join(SRC, 'build.sh'), 'utf8');
  assert.match(build, /SOURCES=\(main\.c decoder\.c errlimit\.c jsonl\.c ppm\.c winpick\.c\)/);
  assert.match(build, /ZIG_VERSION="0\.16\.0"/);
});

// build.sh's proof that the helper reproduces (SY-26's follow-up): zig caches the linked exe, so a second build that
// shares the first one's cache is a copy of it (0.1 s against 20 s from nothing, the same bytes either way). The second
// build gets its own empty zig caches; WC_ONE_BUILD=1 (test.yml's capture-windows, which builds from zig's cache) builds
// once and says the proof is made elsewhere. A stand-in zig logs the caches each build was given.
const FAKE_ZIG = [
  '#!/bin/bash',
  'if [ "$1" = version ]; then echo 0.16.0; exit 0; fi',
  'out=""; prev=""',
  'for a in "$@"; do [ "$prev" = -o ] && out="$a"; prev="$a"; done',
  'g="${ZIG_GLOBAL_CACHE_DIR:-}"; l="${ZIG_LOCAL_CACHE_DIR:-}"; empty=no',
  'if [ -n "$g" ] && [ -d "$g" ] && [ -z "$(ls -A "$g")" ]; then empty=yes; fi',
  'echo "global=$g local=$l empty=$empty out=$out" >> "$FAKE_ZIG_LOG"',
  'n=$(wc -l < "$FAKE_ZIG_LOG" | tr -d " ")',
  'if [ "${FAKE_ZIG_DIFFER:-}" = 1 ]; then tag="build $n"; else tag=same; fi',
  "printf 'MZ %s\\0KERNEL32.dll\\0d3d11.dll\\0dxgi.dll\\0' \"$tag\" > \"$out\"",
  'if [ -n "$g" ]; then mkdir -p "$g" && touch "$g/o"; fi',
].join('\n') + '\n';
const hasStrings = spawnSync('strings', ['-a', path.join(SRC, 'build.sh')], { stdio: 'ignore' }).status === 0;
test('build.sh proves the helper reproduces with a second build from its own empty zig caches, refuses one that differs, and WC_ONE_BUILD=1 builds once and says so', {
  skip: process.platform === 'win32' ? 'build.sh\'s zig build runs on Linux and macOS (Windows compiles the helper with --native)' : hasStrings ? false : 'needs strings (binutils)',
}, (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-zigproof-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const zig = path.join(d, 'zig');
  fs.writeFileSync(zig, FAKE_ZIG, { mode: 0o755 });
  const warm = path.join(d, 'warm-cache');
  fs.mkdirSync(warm);
  fs.writeFileSync(path.join(warm, 'o'), 'cached objects');
  const build = (name, extra = {}) => {
    const log = path.join(d, `${name}.log`);
    const out = path.join(d, name);
    const env = { ...process.env, ZIG: zig, FAKE_ZIG_LOG: log, WC_BUILD_DIR: out, ZIG_GLOBAL_CACHE_DIR: warm, ...extra };
    for (const k of ['WC_ONE_BUILD', 'ZIG_LOCAL_CACHE_DIR', 'ZIG_ANY_VERSION']) if (!(k in extra)) delete env[k];
    const r = spawnSync('bash', [path.join(SRC, 'build.sh')], { encoding: 'utf8', env });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => /^global=(\S*) local=(\S*) empty=(\w+) out=(\S*)$/.exec(l).slice(1)) : [];
    return { r, calls, exe: path.join(out, 'nqa-capture.exe') };
  };

  // The proof: the first build with the environment's cache, the second from its own empty ones, removed after.
  const p = build('proof');
  assert.equal(p.r.status, 0, p.r.stderr);
  assert.equal(p.calls.length, 2, 'two builds');
  const [[g1, , e1, o1], [g2, l2, e2, o2]] = p.calls;
  assert.deepEqual([g1, e1, o1], [warm, 'no', p.exe], 'the first build: the environment\'s cache, into the output folder');
  assert.ok(g2 && l2 && g2 !== warm && l2 !== g2, `the second build's own caches: global "${g2}", local "${l2}"`);
  assert.equal(e2, 'yes', 'empty when the second build starts');
  assert.notEqual(path.dirname(o2), path.dirname(p.exe), 'in another folder');
  assert.ok(!fs.existsSync(g2), 'removed after');
  assert.match(p.r.stdout, /^reproducible: a second build in another folder, from its own empty zig cache, is identical$/m);
  assert.ok(fs.existsSync(p.exe) && fs.existsSync(`${p.exe}.sha256`));
  assert.match(p.r.stdout, /^imports: d3d11\.dll dxgi\.dll kernel32\.dll $/m);

  // Two builds that differ: refused, and no helper left.
  const bad = build('differ', { FAKE_ZIG_DIFFER: '1' });
  assert.equal(bad.r.status, 4, bad.r.stdout);
  assert.match(bad.r.stderr, /refusing: two builds of the same sources differ/);
  assert.ok(!fs.existsSync(bad.exe));

  // WC_ONE_BUILD=1: one build, and it says the proof is elsewhere.
  const one = build('one', { WC_ONE_BUILD: '1' });
  assert.equal(one.r.status, 0, one.r.stderr);
  assert.equal(one.calls.length, 1);
  assert.match(one.r.stdout, /^one build \(WC_ONE_BUILD=1\): not checked for reproducibility here; test\.yml's capture-windows-reproducible and a release check it$/m);
  assert.ok(fs.existsSync(one.exe));
});

test('the helper\'s version resource shows no version a release never had: "(unreleased)" and 0,0,0,0, or the app\'s own version in both', () => {
  const rc = fs.readFileSync(path.join(SRC, 'nqa-capture.rc'), 'utf8');
  const str = k => (rc.match(new RegExp(`VALUE "${k}", "([^"]*)"`)) || [])[1];
  const num = k => (rc.match(new RegExp(`^${k} (\\d+,\\d+,\\d+,\\d+)$`, 'm')) || [])[1];
  const app = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'desktop', 'package.json'), 'utf8')).version;
  const released = str('FileVersion') === app;
  if (released) {
    const [a, b, c] = app.split(/[.-]/).map(Number);
    assert.deepEqual([str('ProductVersion'), num('FILEVERSION'), num('PRODUCTVERSION')], [app, `${a},${b},${c},0`, `${a},${b},${c},0`]);
  } else {
    assert.deepEqual([str('FileVersion'), str('ProductVersion'), num('FILEVERSION'), num('PRODUCTVERSION')], ['(unreleased)', '(unreleased)', '0,0,0,0', '0,0,0,0']);
  }
});

// With zig (ZIG=/path/to/zig, or zig on PATH), the whole helper cross-compiles with -Werror.
const ZIG = process.env.ZIG || 'zig';
const hasZig = spawnSync(ZIG, ['version'], { encoding: 'utf8' }).status === 0;
test('the helper cross-compiles for Windows with -Wall -Wextra -Werror and imports no networking DLL', { skip: hasZig ? false : 'needs zig (ZIG=/path/to/zig)' }, () => {
  const exe = path.join(TMP, 'nqa-capture.exe');
  const r = spawnSync(ZIG, ['cc', '-target', 'x86_64-windows-gnu', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-municode', '-DUNICODE', '-D_UNICODE',
    '-s', '-o', exe, ...['main.c', 'decoder.c', 'errlimit.c', 'jsonl.c', 'ppm.c', 'winpick.c', 'nqa-capture.rc'].map(f => path.join(SRC, f)),
    '-ld3d11', '-ldxgi', '-luser32', '-lkernel32'], { encoding: 'utf8', cwd: SRC });
  assert.equal(r.status, 0, r.stderr);
  const dlls = [...new Set((fs.readFileSync(exe).toString('latin1').match(/[A-Za-z0-9_.-]+\.dll/g) || []).map(d => d.toLowerCase()))];
  assert.ok(dlls.includes('d3d11.dll') && dlls.includes('dxgi.dll'), dlls.join(' '));
  assert.ok(!dlls.some(d => /^(ws2_32|wsock32|mswsock|wininet|winhttp|dnsapi|iphlpapi|urlmon|webio|httpapi|netapi32)\.dll$/.test(d)), dlls.join(' '));
});
