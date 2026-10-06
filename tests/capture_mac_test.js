'use strict';
// The Mac capture helper's decoder (bridge/capture/mac, --test-image) against
// strips encoded by the addon's shipped Codec.lua (magic C7 2C, decoded with --magic C72C as
// the app runs the helper, bridge/transport/capture.mjs; code health AD-11): native Retina (4 px cells), a
// 2x scale, fractional pitches from a non-native fullscreen mode, a title bar,
// a busy background, noise and gamma. --test-image touches no capture API, so
// this never involves Screen Recording permission.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { encodeWithLua, render } = require('./helpers/strip-render');

const PKG = path.join(__dirname, '..', 'bridge', 'capture', 'mac');
const TMP = path.join(__dirname, 'tmp', 'capture-mac');

function binary() {
  if (process.platform !== 'darwin') return null;
  try { execFileSync('swift', ['--version'], { stdio: 'ignore' }); } catch { return null; }
  execFileSync('swift', ['build', '-c', 'release', '--package-path', PKG], { stdio: ['ignore', 'ignore', 'inherit'] });
  const bin = execFileSync('swift', ['build', '-c', 'release', '--package-path', PKG, '--show-bin-path'], { encoding: 'utf8' }).trim();
  return path.join(bin, 'NQACapture');
}

const BIN = binary();
const skip = BIN ? false : 'needs macOS with Swift';

// The app runs the helper with the addon's magic (capture.mjs createCapture).
const MAGIC = ['--magic', 'C72C'];

function decodePng(file, extra = MAGIC) {
  const out = execFileSync(BIN, ['--test-image', file, ...extra], { encoding: 'utf8' }).trim().split('\n').pop();
  return JSON.parse(out);
}

function roundTrip(name, id, text, renderOpts, extra = MAGIC, magic2) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, name + '.png');
  fs.writeFileSync(file, render(encodeWithLua(id, text, magic2), renderOpts));
  return decodePng(file, extra);
}

const RS = '\x1E', US = '\x1F';
const record = (i, body) => ['a1b2c3d4', 'c3f9a1', String(i), '', '', 'Hyjal route', body].join(US);

const CASES = [
  ['native-4px', { pitch: 4 }],
  ['native-4px-titlebar-noise', { pitch: 4, y0: 56, titleBar: 56, jitter: 40, gamma: 1.2 }],
  ['2x-8px-titlebar', { pitch: 8, y0: 56, titleBar: 56, height: 800 }],
  ['fractional-5.4px', { pitch: 5.4, jitter: 30 }],
  ['fractional-4.5px-offset', { pitch: 4.5, x0: 1, y0: 28, titleBar: 28, gamma: 0.8 }],
  ['fractional-6.25px-busy', { pitch: 6.25, busyBackground: true, height: 700 }],
];

for (const [name, opts] of CASES) {
  test(`decodes a short record at ${name}`, { skip }, () => {
    const text = record(41, 'fastest way to Hyjal from here? ✓ Mulgore → Hyjal');
    const r = roundTrip(name + '-short', 41, text, opts);
    assert.equal(r.id, 41, JSON.stringify(r));
    assert.equal(r.text, text);
    assert.ok(Math.abs(r.geometry.pitch - opts.pitch) < 0.05, `pitch ${r.geometry.pitch} vs ${opts.pitch}`);
  });
}

// Code health LS-12 (decoder.c's guard, in the Swift decoder): a hint that isn't a finite geometry, or
// one past Int's range, is no strip there, never a crash (Swift's Int() of NaN or infinity traps); the
// search still finds the strip. --hint is --test-image's stand-in for the capture loop's last geometry.
test('a --hint of nan, inf or past Int\'s range is no geometry, never a crash: the search finds the strip (code health LS-12)', { skip }, () => {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'hint-native-4px.png');
  const text = record(42, 'where next? Mulgore');
  fs.writeFileSync(file, render(encodeWithLua(42, text), { pitch: 4 }));
  for (const hint of ['nan,0,4', '0,nan,4', '0,0,nan', 'inf,0,4', '-inf,0,4', '0,inf,4', '0,0,inf', '0,0,-inf', '1e300,0,4', '0,0,1e300']) {
    const r = decodePng(file, [...MAGIC, '--hint', hint]);
    assert.deepEqual([r.id, r.text], [42, text], `--hint ${hint}: ${JSON.stringify(r)}`);
  }
  assert.equal(decodePng(file, [...MAGIC, '--hint', '0,0,4']).id, 42, 'a finite hint as before');
});

test('decodes a near-full strip (40 rows, two records) at a fractional pitch', { skip }, () => {
  const long = 'x'.repeat(1400) + ' middle ' + 'y'.repeat(1400);
  const text = record(7, long.slice(0, 1500)) + RS + record(8, long.slice(1500, 2880));
  const r = roundTrip('long-5.4', 8, text, { pitch: 5.4, height: 800, jitter: 20 });
  assert.equal(r.id, 8, JSON.stringify(r).slice(0, 300));
  assert.equal(r.text, text);
});

// A full 200-cell row is where a pitch error adds up (200 x error must stay
// under half a cell), so sweep pitches and offsets with long payloads.
test('sweep: long strips at 24 pitches and offsets', { skip }, () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const failures = [];
  for (let i = 0; i < 24; i++) {
    const pitch = Math.round((3.6 + rand() * 5.4) * 100) / 100; // 3.6 .. 9.0
    const titleBar = rand() < 0.5 ? 0 : [28, 56, 64][i % 3];
    const opts = { pitch, x0: Math.floor(rand() * 4), y0: titleBar + Math.floor(rand() * 3), titleBar,
      jitter: Math.floor(rand() * 50), gamma: rand() < 0.3 ? 0.7 + rand() * 0.8 : 0, seed: i + 1,
      busyBackground: i % 4 === 0, height: 900, width: 1900 };
    const n = 200 + Math.floor(rand() * 2400);
    const text = record(100 + i, 'z'.repeat(n));
    const r = roundTrip(`sweep-${i}`, 100 + i, text, opts);
    if (r.text !== text) failures.push({ i, pitch, x0: opts.x0, y0: opts.y0, n, got: r.error || r.geometry });
  }
  assert.deepEqual(failures, []);
});

test('decodes the fork magic (C7 2C) only when asked to; the helper\'s default is upstream\'s C7 1A', { skip }, () => {
  const text = record(3, 'strip v2');
  assert.equal(roundTrip('magic-c72c', 3, text, { pitch: 4 }).text, text);
  const other = roundTrip('magic-c72c-as-upstream', 3, text, { pitch: 4 }, []);
  assert.match(other.error, /no valid strip/);
  // An upstream strip (C7 1A), with the helper's default.
  assert.equal(roundTrip('magic-c71a', 3, text, { pitch: 4 }, [], 0x1A).text, text);
});

test('reports a damaged strip as rejected, and no strip as nothing', { skip }, () => {
  fs.mkdirSync(TMP, { recursive: true });
  const cells = encodeWithLua(9, record(9, 'checksum victim'));
  cells[40] = (cells[40] + 3) % 8; // flip bits in the payload
  const bad = path.join(TMP, 'damaged.png');
  fs.writeFileSync(bad, render(cells, { pitch: 4 }));
  assert.match(decodePng(bad).error, /rejected: checksum/);
  const empty = path.join(TMP, 'empty.png');
  fs.writeFileSync(empty, render([], { pitch: 4, busyBackground: true }));
  assert.match(decodePng(empty).error, /no valid strip/);
});

// The stream follows the window across displays. ScreenCaptureKit keeps the
// pixel size a stream was set up with, so the helper re-plans when the window's
// display scale or size changes (2026-09-27: the external monitor went away,
// the window landed on the Retina panel, the old 1x stream saw 2 px cells and
// found no strip for six minutes while an ask sat on "Sending...").
function plan(attached, now) {
  const out = execFileSync(BIN, ['--test-plan', attached, now], { encoding: 'utf8' }).trim().split('\n').pop();
  return JSON.parse(out);
}

function stripAt(name, pitch) {
  const text = record(61, 'lets plan the next path');
  const r = roundTrip(name, 61, text, { pitch, x0: 0, y0: 2 * pitch, titleBar: 2 * pitch, jitter: 20 });
  return { r, text };
}

test('a window moving from a 1x monitor to a Retina panel re-plans the stream at 2x', { skip }, () => {
  const p = plan('2742x1570@1', '1728x1117@2');
  assert.match(p.change || '', /scale 1(\.0)? -> 2/);
  // The region: 300 pt tall, as wide as a whole strip at the widest pitch (SY-25): 2432 pt at 1x, 1232 pt at 2x.
  assert.deepEqual([p.attached.width, p.attached.height], [2432, 300]);
  assert.deepEqual([p.now.width, p.now.height, p.now.searchRows, p.now.searchCols], [2464, 600, 160, 64]);
  // The old stream's frames: 2 px cells, under the decoder's minimum. Not
  // decoded, but named (it read as "no strip" on 2026-09-27), which also asks
  // the helper to re-plan.
  assert.equal(p.stalePitch, 2);
  const stale = stripAt('move-1x-to-2x-stale', p.stalePitch);
  assert.match(stale.r.error || '', /rejected: pitch_too_small/);
  // The re-planned stream's frames: the native 4 px cells, decoded.
  assert.equal(p.pitch, 4);
  const fresh = stripAt('move-1x-to-2x-replanned', p.pitch);
  assert.equal(fresh.r.text, fresh.text, JSON.stringify(fresh.r));
});

test('a window moving from a Retina panel to a 1x monitor re-plans the stream at 1x', { skip }, () => {
  const p = plan('1728x1117@2', '2742x1570@1');
  assert.match(p.change || '', /scale 2(\.0)? -> 1/);
  assert.deepEqual([p.attached.width, p.attached.height], [2464, 600]);
  assert.deepEqual([p.now.width, p.now.height, p.now.searchRows, p.now.searchCols], [2432, 300, 80, 32]);
  // The old stream would upscale 2x (8 px cells) and search 160 rows; re-planned, 4 px.
  assert.equal(p.stalePitch, 8);
  assert.equal(p.pitch, 4);
  const fresh = stripAt('move-2x-to-1x-replanned', p.pitch);
  assert.equal(fresh.r.text, fresh.text, JSON.stringify(fresh.r));
});

test('the same display and size keep the stream; a window narrower than the region re-plans it', { skip }, () => {
  assert.equal(plan('1728x1117@2', '1728x1117@2').change, null);
  assert.equal(plan('1728x1117@2', '1600x1000@2').change, null); // still wider than the 1232x300 pt region
  const small = plan('1728x1117@2', '640x480@2');
  assert.match(small.change || '', /region 1232(\.0)?x300(\.0)? -> 640(\.0)?x300(\.0)? pt/);
  assert.deepEqual([small.now.width, small.now.height], [1280, 600]);
});

// A non-native fullscreen mode scales the strip up: 4 px cells drawn at 1920x1080 on a 1x 2560-pt
// screen show at 5.33 px, the live reject's 4.84 px, and at 1280x800 on a 1728-pt Retina panel 10.8 px.
// A whole row is then 200 x pitch wide, past the fixed 900 pt region the helper had, which cut every
// real record off ("truncated"; systems critic r5 SY-25, measured with this helper). The region holds a
// whole row at the widest pitch the decoder reads now, never wider than the window.
test('SY-25: at a non-native fullscreen the region holds the whole strip: real records decode at 5.33, 4.84 and 10.8 px', { skip }, () => {
  const long = record(71, 'x'.repeat(850));           // about 890 bytes, 12 rows
  const hello = record(72, 'Zone: Mount Hyjal (Nordrassil). Level 60 Night Elf Druid. Target: none. Quests: 7 active; nearest objective 240 yards north.');
  for (const [window, pitch, width] of [['2560x1440@1', 16 / 3, 2432], ['2400x1350@1', 4.84, 2400], ['1728x1117@2', 10.8, 2464]]) {
    const p = plan(window, window);
    assert.equal(p.change, null);
    assert.deepEqual([p.now.width, p.now.height], [width, window.endsWith('@2') ? 600 : 300], window);
    const scale = Number(window.split('@')[1]);
    for (const [name, text] of [['long', long], ['hello', hello]]) {
      const at = { pitch, x0: 2, y0: 2 * pitch, titleBar: 2 * pitch, jitter: 20 };
      // What the new region sees: the whole strip.
      const fresh = roundTrip(`sy25-${window}-${name}`, 71, text, { ...at, width: p.now.width, height: p.now.height });
      assert.equal(fresh.text, text, `${window} ${name}: ${JSON.stringify(fresh).slice(0, 200)}`);
      // What the old 900 pt region saw: the row cut off.
      const old = roundTrip(`sy25-${window}-${name}-900pt`, 71, text, { ...at, width: 900 * scale, height: p.now.height });
      assert.match(old.error || '', /rejected: truncated/, `${window} ${name} at 900 pt`);
    }
  }
});

// The region against the strip (code health (Mac crop)). A stream reads the whole search region above only
// until a frame decodes; then the strip's own area as measured: every cell of its 200-cell rows and every row
// the decoder reads (48, the longest record's), at the measured origin and pitch, plus 8 px, in whole points.
// A strip it can't read whole there (it moved, or its cells grew) takes the whole region back, and so do a new
// stream (another window, scale or size) and displays that changed. --test-crop runs the frame queue's and
// replan's rules (RegionFit, replanStep) on rendered frames: each picture is the window's top-left as the
// display shows it, of which a stream gets the region's top-left corner.
function crop(window, steps) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `crop-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ window, steps }));
  const lines = execFileSync(BIN, ['--test-crop', file, ...MAGIC], { encoding: 'utf8' }).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, steps.length, JSON.stringify(lines));
  return lines;
}
const region = s => [s.region.widthPt, s.region.heightPt, s.region.width, s.region.height];
/** A picture of the window's top-left with the strip of record(id, body) drawn at pitch (and below a title bar). */
function windowShot(name, id, body, at) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `crop-${name}.png`);
  fs.writeFileSync(file, render(encodeWithLua(id, record(id, body)), { width: 2600, height: 700, ...at }));
  return file;
}
const SHORT = 'where next?';
const LONGEST = 'y'.repeat(3540); // 3,581 bytes framed: all 48 rows, the most the decoder reads

test('code health (Mac crop): a decode narrows the region to the strip\'s own area, 808x200 px at 1x and 2x, a title bar\'s height more; records of more rows, up to all 48, still read whole there', { skip }, () => {
  const short = windowShot('short-4', 41, SHORT, { pitch: 4 });
  const long = windowShot('long-4', 42, 'x'.repeat(2800), { pitch: 4, jitter: 20 });
  const longest = windowShot('longest-4', 43, LONGEST, { pitch: 4 });
  for (const [window, whole, own] of [['1728x1117@2', [1232, 300, 2464, 600], [404, 100, 808, 200]],
    ['2560x1440@1', [2432, 300, 2432, 300], [808, 200, 808, 200]]]) {
    const [before, first, ...rest] = crop(window, [{ window }, { frame: short }, { frame: long }, { frame: longest }]);
    assert.deepEqual(region(before), whole, `${window}: the whole search region until a frame decodes`);
    assert.deepEqual([first.decoded?.id, first.change, region(first)], [41, 'fit', own], `${window}: ${JSON.stringify(first)}`);
    // More rows than the strip measured: read in place, the region kept.
    assert.deepEqual(rest.map(s => [s.decoded?.id, s.change, region(s)]), [[42, undefined, own], [43, undefined, own]], window);
    assert.equal(rest[1].decoded.bytes, 3573);
  }
  // In a window with a title bar (28 pt: 56 px at 2x), the strip sits below it: its area reaches that much lower.
  const titled = windowShot('short-4-titled', 44, SHORT, { pitch: 4, y0: 56, titleBar: 56 });
  const longTitled = windowShot('longest-4-titled', 45, LONGEST, { pitch: 4, y0: 56, titleBar: 56 });
  const [a, b] = crop('1728x1117@2', [{ frame: titled }, { frame: longTitled }]);
  assert.deepEqual([a.change, region(a)], ['fit', [404, 128, 808, 256]]);
  assert.deepEqual([b.decoded?.id, b.change, region(b)], [45, undefined, [404, 128, 808, 256]]);
});

test('code health (Mac crop): a new scale or a window too small for the region starts over at the whole search region, and so do displays that changed; the same window keeps the strip\'s area', { skip }, () => {
  const short = windowShot('short-4', 41, SHORT, { pitch: 4 });
  const steps = crop('1728x1117@2', [
    { frame: short }, { window: '1728x1117@2' }, { window: '1600x1000@2' }, // fitted, kept, kept: the region still fits the window
    { window: '2742x1570@1' }, { frame: short }, // another display's scale: a new stream, the whole region, then fitted at 1x
    { window: '700x500@1' }, { frame: short }, // narrower than the strip's area: a new stream; fitted again within the window
    { displays: true }, { frame: short }, // the displays changed: the whole region, then fitted again
  ]);
  assert.deepEqual(steps.map(s => [s.change ?? s.restart ?? null, region(s)]), [
    ['fit', [404, 100, 808, 200]],
    [null, [404, 100, 808, 200]],
    [null, [404, 100, 808, 200]],
    ['scale 2 -> 1, region 404x100 -> 2432x300 pt', [2432, 300, 2432, 300]],
    ['fit', [808, 200, 808, 200]],
    ['region 808x200 -> 700x200 pt', [700, 300, 700, 300]],
    ['fit', [700, 200, 700, 200]],
    ['whole', [700, 300, 700, 300]],
    ['fit', [700, 200, 700, 200]],
  ]);
  // Back at the whole region, displays that change again change nothing.
  assert.equal(crop('1728x1117@2', [{ displays: true }])[0].change, undefined);
});

test('code health (Mac crop): a strip the narrowed region can\'t read whole is never lost: bigger cells (a non-native fullscreen mode) or a damaged strip take the whole region back, then the new area; one that moves down is fitted again', { skip }, () => {
  // 1x: native 4 px cells, then the game at 1920x1080 on a 2560-pt screen (5.33 px, SY-25's).
  const short = windowShot('short-4', 41, SHORT, { pitch: 4 });
  const wide = windowShot('long-5.33', 51, 'z'.repeat(850), { pitch: 16 / 3, jitter: 20 });
  const wider = windowShot('longest-5.33', 52, 'w'.repeat(3190), { pitch: 16 / 3 });
  const one = crop('2560x1440@1', [{ frame: short }, { frame: wide }, { frame: wide }, { frame: wider }]);
  assert.deepEqual(one.map(s => [s.decoded?.id ?? s.rejected, s.change, region(s)]), [
    [41, 'fit', [808, 200, 808, 200]],
    ['truncated', 'whole', [2432, 300, 2432, 300]], // cut by the 4 px strip's area: the whole region at once
    [51, 'fit', [1075, 264, 1075, 264]], // read whole there: the 5.33 px strip's area
    [52, undefined, [1075, 264, 1075, 264]], // 3,223 bytes, 44 rows at 5.33 px: whole in place
  ]);
  // 2x: native 4 px cells, then 1280x800 on the 1728-pt Retina panel (10.8 px, SY-25's), below a title bar.
  const big = { pitch: 10.8, x0: 2, y0: 2 * 10.8, titleBar: 2 * 10.8, jitter: 20 };
  const retina = windowShot('long-10.8', 53, 'x'.repeat(850), big);
  const two = crop('1728x1117@2', [{ frame: short }, { frame: retina }, { frame: retina }]);
  assert.deepEqual(two.map(s => [s.decoded?.id ?? (s.rejected ? 'rejected' : null), s.change, region(s)]), [
    [41, 'fit', [404, 100, 808, 200]],
    ['rejected', 'whole', [1232, 300, 2464, 600]],
    // (2 + 200 x 10.8 + 8) / 2 by (22 + 48 x 10.8 + 8) / 2, rounded up: the strip drawn 22 px down.
    [53, 'fit', [1085, 275, 2170, 550]],
  ]);
  // A strip that moved down (a title bar now above it): read in the area, then fitted to where it is.
  const moved = windowShot('short-4-moved', 46, SHORT, { pitch: 4, y0: 56, titleBar: 56 });
  const down = crop('1728x1117@2', [{ frame: short }, { frame: moved }]);
  assert.deepEqual(down.map(s => [s.decoded?.id, s.change, region(s)]), [[41, 'fit', [404, 100, 808, 200]], [46, 'fit', [404, 128, 808, 256]]]);
  // Any strip seen but not read whole there, not only one cut off: a damaged one takes the whole region back
  // too, where the same reject changes nothing more (the helper warns of it as before).
  const cells = encodeWithLua(47, record(47, 'checksum victim'));
  cells[40] = (cells[40] + 3) % 8;
  const damaged = path.join(TMP, 'crop-damaged-4.png');
  fs.writeFileSync(damaged, render(cells, { pitch: 4, width: 2600, height: 700 }));
  const hurt = crop('1728x1117@2', [{ frame: short }, { frame: damaged }, { frame: damaged }]);
  assert.deepEqual(hurt.map(s => [s.decoded?.id ?? s.rejected, s.change, region(s)]), [
    [41, 'fit', [404, 100, 808, 200]],
    ['checksum', 'whole', [1232, 300, 2464, 600]],
    ['checksum', undefined, [1232, 300, 2464, 600]],
  ]);
});

test('code health (Mac crop): never cut: at 12 pitches, offsets and title bars, the area a short record narrows the region to reads the longest record whole', { skip }, () => {
  let seed = 4242;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const failures = [];
  for (let i = 0; i < 12; i++) {
    // At 2x pitches of 3.6 to 9 px; at 1x of 3.6 to 5.5 px, whose 48 rows the whole region's 300 pt holds too.
    const retina = i % 2 === 0;
    const pitch = Math.round((retina ? 3.6 + rand() * 5.4 : 3.6 + rand() * 1.9) * 100) / 100;
    const titleBar = rand() < 0.5 ? 0 : retina ? 56 : 28;
    const at = { pitch, x0: Math.floor(rand() * 4), y0: titleBar + Math.floor(rand() * 3), titleBar, jitter: Math.floor(rand() * 40), seed: i + 1 };
    const steps = crop(retina ? '1728x1117@2' : '2560x1440@1',
      [{ frame: windowShot(`sweep-${i}-short`, 60 + i, SHORT, at) }, { frame: windowShot(`sweep-${i}-longest`, 80 + i, LONGEST, at) }]);
    const [fitTo, longest] = steps;
    if (fitTo.change !== 'fit' || longest.decoded?.id !== 80 + i || longest.change !== undefined) failures.push({ i, at, steps });
  }
  assert.deepEqual(failures, []);
});

test('D-14: a running stream holds App Nap and timer coalescing off, never idle sleep', { skip }, () => {
  // The same options the helper begins its activity with (Capture.swift activityOptions), only while
  // a stream runs: no activity at all with the game closed.
  assert.deepEqual(plan('1728x1117@2', '1728x1117@2').activity, { idleSystemSleepDisabled: false, latencyCritical: true, userInitiated: true });
  const src = fs.readFileSync(path.join(PKG, 'Sources', 'NQACapture', 'Capture.swift'), 'utf8');
  assert.equal((src.match(/beginActivity\(/g) || []).length, 1, 'one place begins it');
  assert.match(src, /beginActivity\(options: Self\.activityOptions/);
});

// Which window to capture (26 Sep, 18:47Z: the helper attached to an old game
// process's off-screen window while the new one was on screen, and saw nothing
// for 11 min 40 s).
function pick(input) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `pick-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(input));
  const out = execFileSync(BIN, ['--test-pick', file], { encoding: 'utf8' }).trim().split('\n').pop();
  return JSON.parse(out);
}
const wow = (id, pid, onScreen, width = 1371, height = 799, layer = 0) =>
  ({ id, pid, onScreen, layer, width, height, bundleId: 'com.blizzard.worldofwarcraft', appName: 'Wow', title: 'World of Warcraft' });

test('two game windows: the on-screen one of the running game wins, and an attached old one is left', { skip }, () => {
  const windows = [wow(101, 14157, false), wow(202, 14223, true)];
  assert.deepEqual(pick({ gamePid: 14223, attached: 101, windows }),
    { best: 202, switch: 'window 202 of the game\'s pid 14223, not pid 14157' });
  // Without a game pid, on screen still wins.
  assert.deepEqual(pick({ gamePid: null, attached: 101, windows }),
    { best: 202, switch: 'window 202 is on screen, window 101 isn\'t' });
  // Attached to the right one already: stay.
  assert.deepEqual(pick({ gamePid: 14223, attached: 202, windows }), { best: 202, switch: null });
});

test('one game window off screen (another Space, minimized) stays attached; the game\'s small windows never count', { skip }, () => {
  const windows = [wow(7, 18682, false, 1728, 1117), wow(8, 18682, true, 1728, 33), wow(9, 18682, true, 84, 77, 3),
    { ...wow(10, 555, true, 1900, 1200), bundleId: 'com.apple.Safari', appName: 'Safari', title: 'World of Warcraft wiki' }];
  assert.deepEqual(pick({ gamePid: 18682, attached: 7, windows }), { best: 7, switch: null });
  assert.deepEqual(pick({ gamePid: null, attached: null, windows: windows.slice(1) }), { best: null, switch: null });
  // "The game" as the search's gate judges it: the bundle id when the app has
  // one, its name only when it hasn't.
  const other = { ...wow(11, 777, true), bundleId: 'com.example.launcher', appName: 'World of Warcraft Launcher' };
  const noBundle = { ...wow(12, 888, true), bundleId: '', appName: 'World of Warcraft' };
  assert.deepEqual(pick({ gamePid: null, attached: null, windows: [other] }), { best: null, switch: null });
  assert.equal(pick({ gamePid: null, attached: null, windows: [other, noBundle] }).best, 12);
});

test('a hidden game (Cmd+H: its one window off screen) stays attached; nothing else is picked', { skip }, () => {
  const windows = [wow(31, 900, false),
    { ...wow(32, 555, true, 1900, 1200), bundleId: 'com.apple.Safari', appName: 'Safari', title: 'World of Warcraft wiki' }];
  assert.deepEqual(pick({ gamePid: 900, attached: 31, windows }), { best: 31, switch: null });
  assert.deepEqual(pick({ gamePid: 900, attached: null, windows }), { best: 31, switch: 'window 31 of pid 900; the attached one is gone' });
});

// What holds capture (DR-02, SY-13, SY-18): the session's lock from its dictionary, and what a stream
// that stopped says once it's been gone 10 s: a stats line while locked or asleep explains it,
// access_lost otherwise, carrying both. Only the booleans come out, never the dictionary (it names
// the user).
function session(input) {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, `session-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(input));
  const out = execFileSync(BIN, ['--test-session', file], { encoding: 'utf8' }).trim();
  assert.equal(out.split('\n').length, 1, out);
  return JSON.parse(out);
}

test('SY-13, SY-18: the lock from the session dictionary, and what a lost stream says: a stats line while locked or asleep, else access_lost carrying both', { skip }, () => {
  const user = { kCGSSessionUserNameKey: 'somebody-private', kCGSSessionLongUserNameKey: 'Somebody Private', kCGSSessionUserIDKey: 501 };
  const locked = session({ session: { ...user, kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: true }, code: -3815 });
  assert.deepEqual(locked, { locked: true, asleep: false, send: { stats: { attached: false, locked: true, asleep: false, hidden: false } } });
  const away = session({ session: { ...user, kCGSSessionOnConsoleKey: false }, code: -3815 });
  assert.equal(away.locked, true, 'another user on the console (fast user switching)');
  assert.ok(away.send.stats);
  const normal = session({ session: { ...user, kCGSSessionOnConsoleKey: true }, code: -3815 });
  assert.deepEqual(normal, { locked: false, asleep: false, send: { error: 'screen reading stopped (-3815) and hasn\'t come back', kind: 'access_lost', locked: false, asleep: false } });
  const unlockedKey = session({ session: { ...user, kCGSSessionOnConsoleKey: true, CGSSessionScreenIsLocked: false }, code: -3821 });
  assert.equal(unlockedKey.send.kind, 'access_lost');
  assert.match(unlockedKey.send.error, /\(-3821\)/);
  const asleep = session({ session: { ...user, kCGSSessionOnConsoleKey: true }, asleep: true });
  assert.deepEqual(asleep.send, { stats: { attached: false, locked: false, asleep: true, hidden: false } }, 'a sleeping display holds it too');
  assert.equal(session({}).locked, false, 'no session dictionary says nothing');
  for (const r of [locked, away, normal, asleep]) assert.ok(!JSON.stringify(r).includes('omebody'), 'nothing of the dictionary but the booleans');
});

// One helper per bridge (D-43), refused with a typed line the bridge can act on (SY-15).
test('SY-15, D-43: a second copy against a held lock says instance_busy with the holder\'s pid; the lock is free again once the holder is gone', { skip }, async () => {
  const { spawn, spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wcap-lock-'));
  const lockFile = path.join(dir, 'capture.lock');
  try {
    const holder = spawn(BIN, ['--test-lock', lockFile], { stdio: ['pipe', 'pipe', 'inherit'] });
    const first = await new Promise((resolve, reject) => {
      let buf = '';
      holder.stdout.on('data', (d) => { buf += d; if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0])); });
      holder.once('exit', code => reject(new Error(`the holder exited (${code}) before taking the lock`)));
    });
    assert.deepEqual(first, { info: 'holding the lock', pid: holder.pid });
    const second = spawnSync(BIN, ['--test-lock', lockFile], { encoding: 'utf8', timeout: 10000 });
    assert.equal(second.status, 3);
    assert.deepEqual(JSON.parse(second.stdout.trim()), { error: `another copy of the capture helper is already running (pid ${holder.pid})`, kind: 'instance_busy', holder: holder.pid });
    const gone = new Promise(r => holder.once('exit', r));
    holder.stdin.end();
    await gone;
    const again = spawnSync(BIN, ['--test-lock', lockFile], { input: '', encoding: 'utf8', timeout: 10000 });
    assert.equal(again.status, 0, again.stdout);
    assert.equal(JSON.parse(again.stdout.trim().split('\n')[0]).info, 'holding the lock');
    // A lock file that holds no pid (overwritten under a holder): refused all the same, no holder named.
    const other = spawn(BIN, ['--test-lock', lockFile], { stdio: ['pipe', 'pipe', 'inherit'] });
    await new Promise(r => other.stdout.once('data', r));
    fs.writeFileSync(lockFile, 'junk');
    const nameless = spawnSync(BIN, ['--test-lock', lockFile], { encoding: 'utf8', timeout: 10000 });
    assert.deepEqual(JSON.parse(nameless.stdout.trim()), { error: 'another copy of the capture helper is already running', kind: 'instance_busy' });
    other.stdin.end();
    await new Promise(r => other.once('exit', r));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The capture run takes it beside the bridge's socket, per build, never a folder every build shares.
  const src = fs.readFileSync(path.join(PKG, 'Sources', 'NQACapture', 'main.swift'), 'utf8');
  assert.match(src, /let lockPath = InstanceLock\.path\(forSocket: sock\)/);
  assert.match(src, /out\.emit\(InstanceLock\.busyLine\(holder: InstanceLock\.holder\(path: lockPath\)\)\)\n\s+exit\(3\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(PKG, 'Sources', 'NQACapture', 'InstanceLock.swift'), 'utf8'), /"Library\/Application Support\/nqa"/);
});

// Warnings have a 5 s budget per key (D-16): a run of strip rejects no longer swallows "capture stopped".
test('D-16: a reject warning doesn\'t swallow "capture stopped"; each key has its own 5 s', { skip }, () => {
  fs.mkdirSync(TMP, { recursive: true });
  const file = path.join(TMP, 'warns.json');
  fs.writeFileSync(file, JSON.stringify([
    { at: 100, key: 'rejected', warn: 'strip seen but rejected: checksum' },
    { at: 101, key: 'stopped', warn: 'capture stopped (x -3815)' },
    { at: 102, key: 'rejected', warn: 'strip seen but rejected: truncated' },
    { at: 104.9, key: 'stopped', warn: 'capture stopped (x -3821)' },
    { at: 105.5, key: 'rejected', warn: 'strip seen but rejected: length' },
    { at: 106, warn: 'no key: its own text' },
    { at: 107, warn: 'no key: its own text' },
  ]));
  const out = execFileSync(BIN, ['--test-warns', file], { encoding: 'utf8' }).trim().split('\n').map(l => JSON.parse(l).warn);
  assert.deepEqual(out, ['strip seen but rejected: checksum', 'capture stopped (x -3815)', 'strip seen but rejected: length', 'no key: its own text']);
});

test('run directly (not through LaunchServices), the app refuses to capture', { skip }, () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(BIN, ['--socket', '/tmp/nqa-no-such.sock'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /only runs as "NeverQuestAlone Capture.app"/);
  const p = spawnSync(BIN, ['--check-permission'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(p.status, 5);
});

// No idle work while the game is closed (systems critic SY-30): the helper stays
// connected (it reports the game's launch through a workspace notification, no
// polling), and nothing of its runs on a timer then. While the game runs: the
// activity that keeps App Nap off the 250 ms stream, the stats line, the 10 s
// replan. Capture.swift's follow(gameRunning:) applies exactly this table.
test('with the game closed nothing runs on a timer: no App Nap opt-out, no stats line, no replan (SY-30)', { skip }, () => {
  const out = JSON.parse(execFileSync(BIN, ['--test-idle'], { encoding: 'utf8' }).trim().split('\n').pop());
  assert.deepEqual(out, { closed: [], running: ['activity', 'stats', 'replan'] });
  const src = fs.readFileSync(path.join(PKG, 'Sources', 'NQACapture', 'Capture.swift'), 'utf8');
  // The only beginActivity is follow's, and the only repeating timers are the two it owns.
  assert.equal((src.match(/beginActivity\(/g) || []).length, 1);
  assert.equal((src.match(/repeats: true/g) || []).length, 2);
  const follow = src.slice(src.indexOf('private func follow(gameRunning'), src.indexOf('// MARK: The game\'s process'));
  assert.match(follow, /beginActivity/);
  assert.equal((follow.match(/repeats: true/g) || []).length, 2, 'both repeating timers are started by follow() alone');
});

// The app's own Screen Recording check and request (onboarding spec §9.4): new instances beside a
// socket helper, so both come before the socket and the instance lock; NeverQuestAlone's helper
// never asks at start (only on the player's Allow).
test('--request-permission: parsed; handled with --check-permission before the socket and the lock; the public build asks only then', () => {
  const src = f => fs.readFileSync(path.join(PKG, 'Sources', 'NQACapture', f), 'utf8');
  const options = src('Options.swift');
  assert.match(options, /case "--request-permission": o\.requestPermission = true/);
  const main = src('main.swift');
  const at = s => { const i = main.indexOf(s); assert.ok(i >= 0, s); return i; };
  assert.ok(at('if opts.checkPermission {') < at('guard let sock = opts.socketPath'), 'the check before the socket');
  assert.ok(at('if opts.requestPermission {') < at('guard let sock = opts.socketPath'), 'the request before the socket');
  assert.ok(at('guard let sock = opts.socketPath') < at('InstanceLock.acquire(path: lockPath)'), 'a bare launch (Quit & Reopen) exits before the lock');
  assert.ok(main.lastIndexOf('refuseUnlessLaunchedAsApp()') < at('if opts.checkPermission {'), 'both only as the app LaunchServices started');
  assert.match(main, /_ = CGRequestScreenCaptureAccess\(\)\n\s+let until = Date\(\)\.addingTimeInterval\(120\)/, 'it waits up to 120 s for the answer');
  const capture = src('Capture.swift');
  const pub = /#if NQA_PUBLIC_ID\n([\s\S]*?)#else\n([\s\S]*?)#endif/.exec(capture);
  assert.ok(pub, 'start() branches on the public build');
  assert.doesNotMatch(pub[1], /CGRequestScreenCaptureAccess/, 'NeverQuestAlone’s helper asks nothing at start');
  assert.match(pub[2], /CGRequestScreenCaptureAccess/, 'your build keeps its prompt');
  assert.match(capture, /#if NQA_PUBLIC_ID\n\s+\/\/ Every ScreenCaptureKit call waits for the grant/);
  const build = fs.readFileSync(path.join(PKG, 'build-app.sh'), 'utf8');
  assert.match(build, /NAME="NeverQuestAlone"/);
  assert.match(fs.readFileSync(path.join(PKG, 'Info.plist'), 'utf8'), /<string>__NAME__<\/string>[\s\S]*<string>__USAGE__<\/string>/);
});

test('run directly, --request-permission refuses too (the grant belongs to the app LaunchServices starts)', { skip }, () => {
  const { spawnSync } = require('child_process');
  const r = spawnSync(BIN, ['--request-permission'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 5, r.stderr);
});

// ---------------------------------------------------------------- NeverQuestAlone's helper (code health BR-01)
// The public build (-DNQA_PUBLIC_ID, in the Swift build folder build-app.sh --public uses) is a Screen
// Recording grant that any process of the player's could otherwise launch with its own socket and its
// own aim (the old audit LS-01). Argv can't aim it, and who serves its socket is checked first. These
// run nothing that touches a capture or permission API: argv is refused before the launch check, and
// PeerCheck.swift is driven by a harness of its own (no capture code linked in).
const os = require('os');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const SRC = path.join(PKG, 'Sources', 'NQACapture');
const REPO = path.join(__dirname, '..');
// The app's own id and helper: its identity's (the plugin the root package.json names; bridge/identity.mjs
// reads the same file). The identifier this helper's source asks for is the app's when the app ships the
// helper; an app without one (the example's) doesn't, and NeverQuestAlone's is pinned in frozen_names_test.
const IDENTITY = require(path.join(REPO, 'plugins', require(path.join(REPO, 'package.json')).plugin, 'identity.json'));
const APP_ID = IDENTITY.appId;
const SHIPS_HELPER = !!IDENTITY.captureHelper;
const PTMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nqcap-')); // short: a socket path has 104 bytes
test.after(() => fs.rmSync(PTMP, { recursive: true, force: true }));

let publicBin = null;
function publicBinary() {
  if (!publicBin) {
    const flags = ['-c', 'release', '--package-path', PKG, '--scratch-path', path.join(PKG, '.build-public'), '-Xswiftc', '-DNQA_PUBLIC_ID'];
    execFileSync('swift', ['build', ...flags], { stdio: ['ignore', 'ignore', 'inherit'] });
    publicBin = path.join(execFileSync('swift', ['build', ...flags, '--show-bin-path'], { encoding: 'utf8' }).trim(), 'NQACapture');
  }
  return publicBin;
}

/** A Swift file as one build compiles it: NeverQuestAlone's (-DNQA_PUBLIC_ID) or a checkout's. */
function buildView(src, pub = true) {
  const keep = []; // per open #if: whether this build compiles the branch (null: another condition, kept)
  const out = [];
  for (const line of src.split('\n')) {
    const t = line.trim();
    const m = /^#if\s+(!?)NQA_PUBLIC_ID\s*$/.exec(t);
    if (m) keep.push(m[1] ? !pub : pub);
    else if (/^#if\b/.test(t)) keep.push(null);
    else if (/^#else\b/.test(t)) { const k = keep.pop(); keep.push(k === null ? null : !k); }
    else if (/^#endif\b/.test(t)) keep.pop();
    else if (!keep.includes(false)) out.push(line);
  }
  return out.join('\n');
}
const swiftSource = f => fs.readFileSync(path.join(SRC, f), 'utf8');

test('BR-01: NeverQuestAlone\'s helper refuses every flag that aims it, with a typed line and exit 7, before anything else; a checkout\'s build doesn\'t', { skip }, () => {
  const exe = publicBinary();
  const dir = fs.mkdtempSync(path.join(PTMP, 'argv-'));
  const png = path.join(dir, 'x.png');
  const r = spawnSync(exe, ['--socket', path.join(dir, 'capture.sock'), '--bundle-id', 'com.apple.Safari', '--window-name', 'Safari',
    '--process', 'Safari', '--region-pt', '9999x9999', '--probe', png, '--magic', 'C72C'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 7, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { error: 'this build doesn\'t take --bundle-id, --window-name, --process, --region-pt, --probe', kind: 'args_refused' });
  assert.ok(!fs.existsSync(png), 'no picture written');
  // Each one alone, wherever it stands, and before a test mode could run.
  for (const flag of ['--process', '--bundle-id', '--window-name', '--region-pt', '--probe']) {
    const one = spawnSync(exe, ['--test-idle', flag, 'x', '--socket', path.join(dir, 'capture.sock')], { encoding: 'utf8', timeout: 10000 });
    assert.equal(one.status, 7, flag);
    assert.equal(JSON.parse(one.stdout.trim()).kind, 'args_refused', flag);
  }
  // What the app passes is taken: the launch check (exit 5) is what stops a run from a shell.
  const app = spawnSync(exe, ['--socket', path.join(dir, 'capture.sock'), '--magic', 'C72C', '--interval-ms', '250', '--stats-sec', '10'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(app.status, 5, app.stderr);
  for (const mode of ['--check-permission', '--request-permission']) assert.equal(spawnSync(exe, [mode], { encoding: 'utf8', timeout: 10000 }).status, 5, mode);
  // The test modes still run in it (no capture, no permission, no lock).
  assert.deepEqual(JSON.parse(execFileSync(exe, ['--test-idle'], { encoding: 'utf8' }).trim().split('\n').pop()), { closed: [], running: ['activity', 'stats', 'replan'] });
  // A checkout's build: the build decides, never argv. The same flags reach the launch check.
  const dev = spawnSync(BIN, ['--socket', path.join(dir, 'capture.sock'), '--window-name', 'Safari', '--probe', png], { encoding: 'utf8', timeout: 10000 });
  assert.equal(dev.status, 5, dev.stderr);
});

test('BR-01: who serves the socket is checked after connecting and before the lock, the capture or any permission call; a checkout\'s build doesn\'t check its socket\'s owner (both answer the app\'s --check-peer: LS-03)', () => {
  const main = buildView(swiftSource('main.swift'));
  const at = s => { const i = main.indexOf(s); assert.ok(i >= 0, `NeverQuestAlone's main.swift has no ${s}`); return i; };
  const check = at('peerRefusal(fd: out.fd)');
  assert.ok(at('out.connect(socketPath: sock)') < check);
  for (const later of ['InstanceLock.acquire(path: lockPath)', 'NSApplication.shared', 'CaptureController(', 'controller.start()', 'out.onCommand']) assert.ok(check < at(later), later);
  assert.match(main.slice(check, at('InstanceLock.acquire(path: lockPath)')), /exit\(6\)/);
  // Argv first of all: before the test modes and the launch check.
  const refused = at('if !opts.refused.isEmpty');
  for (const later of ['opts.checkPeer', 'opts.testImage', 'opts.testLock', 'refuseUnlessLaunchedAsApp()', 'opts.checkPermission']) assert.ok(refused < at(later), later);
  assert.match(buildView(swiftSource('Options.swift')), /if Options\.aiming\.contains\(a\) \{\n\s+o\.refused\.append\(a\)/);
  assert.match(swiftSource('Options.swift'), /static let aiming = \["--process", "--bundle-id", "--window-name", "--region-pt", "--probe"\]/);
  // The peer's audit token (a pid can be reused), its code, and a requirement checked against it;
  // the team from this helper's own signature, after that signature is checked for the code running.
  const peer = buildView(swiftSource('PeerCheck.swift'));
  for (const s of ['LOCAL_PEERTOKEN', 'kSecGuestAttributeAudit', 'SecCodeCopyGuestWithAttributes', 'SecCodeCheckValidity(peer, [], requirement)', 'SecCodeCopySelf', 'SecCodeCheckValidity(me, [], nil)', 'kSecCodeInfoTeamIdentifier']) assert.ok(peer.includes(s), s);
  assert.ok(peer.indexOf('SecCodeCheckValidity(me, [], nil)') < peer.indexOf('kSecCodeInfoTeamIdentifier'), 'the team is read only from a signature that holds');
  assert.doesNotMatch(peer, /LOCAL_PEERPID/);
  if (SHIPS_HELPER) assert.ok(peer.includes(`let nqaAppIdentifier = "${APP_ID}"`), 'the identifier it asks for is the app\'s own (its identity\'s appId)');
  // A checkout's build: none of the helper's own check. Both builds answer the app's --check-peer
  // (code health LS-03 / peer check): its connection on fd 3, before the test modes and the launch
  // check, and nothing else.
  assert.doesNotMatch(buildView(swiftSource('main.swift'), false), /peerRefusal\(fd: out\.fd\)|opts\.refused/);
  const devPeer = buildView(swiftSource('PeerCheck.swift'), false);
  assert.doesNotMatch(devPeer, /ownTeam|peerRequirement|nqaAppIdentifier|func peerRefusal\(fd: Int32\) ->/);
  assert.match(devPeer, /func peerRefusal\(fd: Int32, requirement text: String, who: String = "the socket's owner", wanted: String = "NeverQuestAlone"\) -> String\?/);
  assert.doesNotMatch(buildView(swiftSource('Options.swift'), false), /refused/);
  for (const pub of [true, false]) {
    const m = buildView(swiftSource('main.swift'), pub);
    const mode = m.slice(m.indexOf('if let requirement = opts.checkPeer {'), m.indexOf('if let path = opts.testImage {'));
    assert.match(mode, /peerRefusal\(fd: 3, requirement: requirement, who: "the program that connected", wanted: "NeverQuestAlone's capture helper"\)/);
    assert.match(mode, /exit\(6\)\n    \}\n    exit\(0\)\n\}/);
    assert.doesNotMatch(mode.replace(/^\s*\/\/.*$/gm, ''), /\bout\.|\.connect\(|InstanceLock|CGPreflight|CGRequest|SCShareable|NSApplication/, 'nothing else runs in it');
    assert.ok(m.indexOf('if let requirement = opts.checkPeer {') < m.indexOf('refuseUnlessLaunchedAsApp()'), 'run directly by the app, not through LaunchServices');
  }
  assert.match(swiftSource('Options.swift'), /case "--check-peer": o\.checkPeer = next\(\)/);
  assert.ok(!/"--check-peer"/.test(/static let aiming = \[[^\]]*\]/.exec(swiftSource('Options.swift'))[0]), 'it aims nothing');
});

/** PeerCheck.swift and Emitter.swift with a stand-in main (no capture code): serve, check, team or requirement. */
const HARNESS_MAIN = `import Foundation
import Security
let a = CommandLine.arguments
func say(_ o: [String: Any]) { print(String(data: try! JSONSerialization.data(withJSONObject: o), encoding: .utf8)!); fflush(stdout) }
switch a[1] {
case "serve":
    alarm(60)
    let s = socket(AF_UNIX, SOCK_STREAM, 0)
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let b = Array(a[2].utf8)
    withUnsafeMutableBytes(of: &addr.sun_path) { $0.copyBytes(from: b); $0[b.count] = 0 }
    let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
    let ok = bound == 0 && listen(s, 8) == 0
    say(["listening": ok])
    while ok {
        let c = accept(s, nil, nil)
        if c < 0 { continue }
        var buf = [UInt8](repeating: 0, count: 256)
        while read(c, &buf, buf.count) > 0 {}
        close(c)
    }
case "requirement":
    let text = peerRequirement(team: a[2])
    var req: SecRequirement?
    say(["requirement": text, "compiles": SecRequirementCreateWithString(text as CFString, [], &req) == errSecSuccess])
case "team":
    switch ownTeam() {
    case .team(let t): say(["team": t])
    case .none: say(["team": NSNull()])
    case .unreadable(let why): say(["unreadable": why])
    }
default:
    let out = Emitter()
    guard out.connect(socketPath: a[2]) else { say(["connected": false]); exit(2) }
    let why = a.count > 3 ? peerRefusal(fd: out.fd, requirement: a[3]) : peerRefusal(fd: out.fd)
    say(["connected": true, "refused": why.map { $0 as Any } ?? NSNull()])
}
exit(0)
`;

test('BR-01: the peer check names whoever serves the socket by its audit token and holds it to the app\'s identifier and the helper\'s own team, by boot\'s rule; a teamless (ad hoc) helper has none to ask for', { skip }, async () => {
  const dir = fs.mkdtempSync(path.join(PTMP, 'peer-'));
  fs.writeFileSync(path.join(dir, 'main.swift'), HARNESS_MAIN);
  const bin = path.join(dir, 'harness');
  execFileSync('swiftc', ['-DNQA_PUBLIC_ID', '-o', bin, path.join(SRC, 'PeerCheck.swift'), path.join(SRC, 'Emitter.swift'), path.join(dir, 'main.swift')], { stdio: ['ignore', 'ignore', 'inherit'] });
  // Ad hoc signatures (no identity, no keychain): the harness as this helper, and a stand-in signed as the app.
  const sign = (file, ...extra) => execFileSync('codesign', ['--force', '--sign', '-', ...extra, file], { stdio: ['ignore', 'ignore', 'pipe'] });
  sign(bin);
  const app = path.join(dir, 'standin');
  fs.copyFileSync(bin, app);
  sign(app, '--identifier', APP_ID);
  const run = (...args) => JSON.parse(execFileSync(bin, args, { encoding: 'utf8', timeout: 20000 }).trim().split('\n').pop());
  const ad = `identifier "${APP_ID}"`; // what an ad hoc stand-in can meet: the app's identifier, no team

  // This test process (node) serves: not the app.
  const nodeSock = path.join(dir, 'n.sock');
  const server = net.createServer(s => s.on('error', () => {}));
  await new Promise(r => server.listen(nodeSock, r));
  try {
    const r = run('check', nodeSock, ad);
    assert.equal(r.connected, true);
    assert.match(r.refused, /^the socket's owner isn't NeverQuestAlone \(-?\d+\)$/);
    // A helper with no team (this ad hoc harness, as an ad hoc or locally signed build is) skips the check.
    assert.deepEqual(run('team'), { team: null });
    assert.deepEqual(run('check', nodeSock), { connected: true, refused: null });
  } finally { server.close(); }

  // The stand-in app serves: it meets the app's identifier; a team's Developer ID it can't.
  const appSock = path.join(dir, 'a.sock');
  const serve = spawn(app, ['serve', appSock], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const first = await new Promise(r => serve.stdout.once('data', d => r(JSON.parse(String(d)))));
    assert.equal(first.listening, true);
    assert.deepEqual(run('check', appSock, ad), { connected: true, refused: null });
    assert.match(run('check', appSock, run('requirement', 'ABCDE12345').requirement).refused, /isn't NeverQuestAlone/);
  } finally { serve.kill(); }

  // Signed by a team, it asks what boot asks of it, mirrored: the app's identifier and that team's Developer ID.
  const { buildRequirement } = await import('../bridge/transport/capture.mjs');
  const asked = run('requirement', 'ABCDE12345');
  assert.equal(asked.compiles, true);
  if (SHIPS_HELPER) assert.equal(asked.requirement, buildRequirement({ bundleId: APP_ID, teamId: 'ABCDE12345' }));
});

// ---------------------------------------------------------------- the app's peer check (code health LS-03 / peer check)
// The other way round: the app hands each connection to its capture socket to the helper's own
// executable (--check-peer, with the connection as its fd 3: transport/capture.mjs checkPeer) before it
// reads a byte of it. Real sockets, the real helper (both builds), real ad hoc signatures; nothing here
// touches a capture or permission API, and LaunchServices launches nothing.

/** A stand-in for whoever connects to the app's socket: connects to argv[1], sends argv[2] and a newline,
 * and stays until the socket closes (the app refused it, or stopped) or its stdin ends. */
const CLIENT_C = `#include <poll.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  int s = socket(AF_UNIX, SOCK_STREAM, 0);
  struct sockaddr_un a;
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  strncpy(a.sun_path, argv[1], sizeof a.sun_path - 1);
  if (connect(s, (struct sockaddr *)&a, sizeof a) != 0) return 3;
  if (write(s, argv[2], strlen(argv[2])) < 0 || write(s, "\\n", 1) < 0) return 4;
  struct pollfd p[2] = { { s, POLLIN, 0 }, { 0, POLLIN, 0 } };
  char buf[256];
  for (;;) {
    if (poll(p, 2, -1) < 0) return 5;
    if ((p[0].revents & (POLLIN | POLLHUP)) && read(s, buf, sizeof buf) <= 0) return 0;
    if ((p[1].revents & (POLLIN | POLLHUP)) && read(0, buf, sizeof buf) <= 0) return 0;
  }
}
`;

test('code health LS-03 / peer check: the helper\'s --check-peer names whoever connected to the app\'s socket by the audit token on its fd 3, as checkPeer hands the connection over (both builds): a program signed with the helper\'s bundle id meets that requirement; another program, /usr/bin/nc, or any ad hoc signature held to a Developer ID team doesn\'t; the app\'s listener with it closes a stranger unread and takes the helper', { skip }, async () => {
  const { checkPeer, createCapture, buildRequirement } = await import('../bridge/transport/capture.mjs');
  const until = async (cond, ms = 10000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 10)); } };
  const exited = p => new Promise(r => p.on('exit', code => r(code)));
  const dir = fs.mkdtempSync(path.join(PTMP, 'app-'));
  fs.writeFileSync(path.join(dir, 'client.c'), CLIENT_C);
  const client = path.join(dir, 'client');
  execFileSync('cc', ['-o', client, path.join(dir, 'client.c')], { stdio: ['ignore', 'ignore', 'inherit'] });
  // Ad hoc signatures (no identity, no keychain): one as NeverQuestAlone's helper (its bundle id), one as another program.
  const PUB = fs.readFileSync(path.join(REPO, 'app', 'desktop', 'build', 'bridge', 'capture', 'mac', 'BUNDLE_ID'), 'utf8').trim();
  const signedAs = (id) => { const f = path.join(dir, id); fs.copyFileSync(client, f); execFileSync('codesign', ['--force', '--sign', '-', '--identifier', id, f], { stdio: ['ignore', 'ignore', 'pipe'] }); return f; };
  const asHelper = signedAs(PUB);
  const other = signedAs('org.example.other');
  const own = `identifier "${PUB}"`; // what an ad hoc stand-in can meet: the helper's bundle id, no team
  const team = buildRequirement({ bundleId: PUB, teamId: 'ABCDE12345' }); // boot's, with a Developer ID team
  const NOT = /^the program that connected isn't NeverQuestAlone's capture helper \(-\d+\)$/;
  const kids = [];
  const run = (cmd, args) => { const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] }); kids.push(p); return p; };

  // checkPeer and the helper's check, on connections this test accepts.
  const sock = path.join(dir, 'a.sock');
  const got = [];
  const srv = net.createServer({ pauseOnConnect: true }, (s) => { s.on('error', () => {}); got.push(s); });
  await new Promise(r => srv.listen(sock, r));
  const accepted = async (cmd, args) => { const n = got.length; run(cmd, args); await until(() => got.length > n); return got.at(-1); };
  try {
    for (const exe of [BIN, publicBinary()]) {
      let s = await accepted(asHelper, [sock, '{"id":7,"text":"hi"}']);
      assert.deepEqual(await checkPeer(s, { exe, requirement: own }), { ok: true, why: null }, exe);
      // Nothing of it was read meanwhile: its line is still there, whole.
      s.resume();
      assert.equal(String(await new Promise(r => s.once('data', r))), '{"id":7,"text":"hi"}\n');
      for (const [cmd, args, requirement] of [[asHelper, [sock, 'x'], team], [other, [sock, 'x'], own], ['/usr/bin/nc', ['-d', '-U', sock], own]]) {
        s = await accepted(cmd, args);
        const v = await checkPeer(s, { exe, requirement });
        assert.equal(v.ok, false, `${path.basename(cmd)} against ${requirement}`);
        assert.match(v.why, NOT);
      }
    }
  } finally { srv.close(); for (const s of got) s.destroy(); }

  // The app's listener (createCapture) with the real check (the public build) and the requirement an ad
  // hoc stand-in meets: nc, then another program writing what a helper would, both connecting first, are
  // closed unread with one line each; then the helper gets through, and its line is read.
  const logs = [];
  const payloads = [];
  const statuses = [];
  const sock2 = path.join(dir, 'c.sock');
  const cap = createCapture({ app: path.join(dir, 'none.app'), socketPath: sock2, launch: false, peerCheck: s => checkPeer(s, { exe: publicBinary(), requirement: own }),
    log: (k, d) => logs.push([k, d]), onPayload: p => payloads.push(p), onStatus: x => statuses.push(x) });
  try {
    cap.start();
    await until(() => fs.existsSync(sock2));
    const nc = run('/usr/bin/nc', ['-d', '-U', sock2]);
    let heard = '';
    nc.stdout.on('data', (d) => { heard += d; });
    assert.equal(await exited(nc), 0, 'nc goes: the app closed it');
    assert.equal(await exited(run(other, [sock2, '{"id":1,"text":"spend the player\'s key"}'])), 0, 'closed by the app');
    const refused = logs.filter(([k]) => k === 'capture-peer-refused').map(([, d]) => d.why);
    assert.equal(refused.length, 2);
    for (const why of refused) assert.match(why, NOT);
    assert.deepEqual([payloads, statuses.filter(x => 'connected' in x), heard], [[], [], ''], 'nothing of theirs read, nothing sent to them, never connected');
    const helper = run(asHelper, [sock2, '{"id":7,"text":"hi"}']);
    await until(() => payloads.length === 1);
    assert.deepEqual([payloads[0].id, payloads[0].text, cap.status().connected], [7, 'hi', true]);
    const gone = exited(helper);
    cap.stop();
    assert.equal(await gone, 0, 'its socket closed, it goes');
  } finally { cap.stop(); }

  // Boot's own wiring (a team): the helper's executable in its bundle, and boot's Developer ID requirement,
  // which no ad hoc program meets: the stand-in helper is refused by the requirement, not by its syntax.
  const bundle = path.join(dir, 'H.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<plist><dict>\n\t<key>CFBundleExecutable</key>\n\t<string>NQACapture</string>\n</dict></plist>\n');
  fs.symlinkSync(publicBinary(), path.join(bundle, 'Contents', 'MacOS', 'NQACapture'));
  const logs3 = [];
  const sock3 = path.join(dir, 'd.sock');
  const cap3 = createCapture({ app: bundle, socketPath: sock3, launch: false, teamId: 'ABCDE12345', bundleId: PUB, log: (k, d) => logs3.push([k, d]) });
  try {
    cap3.start();
    await until(() => fs.existsSync(sock3));
    assert.equal(await exited(run(asHelper, [sock3, 'x'])), 0, 'closed by the app');
    const why = logs3.filter(([k]) => k === 'capture-peer-refused').map(([, d]) => d.why);
    assert.equal(why.length, 1);
    assert.match(why[0], NOT);
    assert.equal(cap3.status().connected, false);
  } finally { cap3.stop(); for (const k of kids) { try { k.kill(); } catch { /* gone */ } } }
});
