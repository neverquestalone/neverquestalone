// The strip's label (Transport.lua, T.PlaceStripLabel; a player, 2026-10-05: "I have no idea what this
// is at the top of my screen"): a few words beside the strip that no decoder ever reads. The proof:
//   1. Where the addon puts it: a child of the strip (it shows and hides with it), drawn at the UI's
//      own scale, always in the label's zone (right of the strip's whole area, 200 cells whatever its
//      rows, or under its whole 48 rows, with a gap past the capture's 8-pixel margin), and on screen,
//      at every screen width and UI scale.
//   2. Nothing in that zone is ever read. The JavaScript decoder (bridge/transport/strip.mjs: Capture's
//      StripDecoder.swift rule for rule, its search a little wider) decodes strips of every row count
//      from 1 to 48, natively, scaled and under a title bar, with the zone filled with a fake strip or
//      noise, and every pixel it reads is recorded: none is in the zone, and the result is the one it
//      reads with the zone empty. The Windows helper's decoder (decoder.c, through its test harness)
//      and the Mac helper's (StripDecoder.swift, through --test-image) decode the same pictures exactly
//      as they decode them with the zone empty.
//   3. The numbers the zone rests on, read from each decoder's source: the search box, the widest
//      pitch, the nudges around a fitted geometry and the capture's margin.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { LIVE, findAndDecode } from '../bridge/transport/strip.mjs';
import { REPO, encodeWithCodec, renderRgb, ppm } from './byok/helpers/strip-fixtures.mjs';

const require = createRequire(import.meta.url);
const { newVM } = require('./helpers/nqa-vm');
const { png } = require('./helpers/strip-render');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-strip-label-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// 1. Where the addon puts the label
// ---------------------------------------------------------------------------

// A screen in physical pixels and the UI scale the player set (null: none, one UI unit a pixel).
// UIParent spans the screen: 768 units tall at scale 1, so 768 / scale.
function screenLua({ w, h, ui }) {
  const us = ui ?? 768 / h;
  return `STUB.metrics = true
function GetPhysicalScreenSize() return ${w}, ${h} end
UIParent.width, UIParent.height = ${w} * 768 / ${h} / ${us}, 768 / ${us}
function UIParent:GetEffectiveScale() return ${us} end`;
}
// The strip drawn: the hello goes on it 3 s after login, in an install the app has answered.
function drawn(screen) {
  const vm = newVM({ extra: screenLua(screen) }).login();
  vm.advance(3.1);
  assert.ok(vm.strip(), `${screen.name}: the hello is on the strip`);
  return vm;
}
const label = vm => vm.json('NS.Transport.StripLabelRect()');
// The zone's edges, in strip pixels from the strip's top-left: where "beside" starts on a screen as
// wide as can be, and where "under" starts on one too narrow for beside. The addon's own numbers.
const zoneOf = vm => ({ x: vm.num('(NS.Transport.StripLabelPlace(1e6, 1, 100))'), y: vm.num('(select(2, NS.Transport.StripLabelPlace(0, 1, 100)))') });

const SCREENS = [
  { name: '4K, UI scale 1', w: 3840, h: 2160, ui: 1 },
  { name: '4K, no UI scale', w: 3840, h: 2160, ui: null },
  { name: '1440p, UI scale 0.64', w: 2560, h: 1440, ui: 0.64 },
  { name: 'a MacBook Pro\'s Retina panel, UI scale 1', w: 3456, h: 2234, ui: 1 },
  { name: 'a Retina window, UI scale 1', w: 2048, h: 1280, ui: 1 },
  { name: '1080p, no UI scale', w: 1920, h: 1080, ui: null },
  { name: '1080p, UI scale 1', w: 1920, h: 1080, ui: 1 },
  { name: '1080p, UI scale 1.15', w: 1920, h: 1080, ui: 1.15 },
  { name: '1366 x 768', w: 1366, h: 768, ui: null },
  { name: '1280 x 720, UI scale 1.15', w: 1280, h: 720, ui: 1.15 },
  { name: '1024 x 768', w: 1024, h: 768, ui: null },
  { name: '1024 x 768, UI scale 1.15', w: 1024, h: 768, ui: 1.15 },
  { name: '900 x 700', w: 900, h: 700, ui: null },
  { name: '800 x 600', w: 800, h: 600, ui: null },
  { name: '640 x 480, UI scale 1', w: 640, h: 480, ui: 1 },
];

test('the label: a child of the strip, in the UI\'s own scale, takes no clicks; its words are plain and short', () => {
  const vm = drawn(SCREENS[5]);
  assert.equal(vm.evaluate('NQAStripLabel.parent == NQAStrip'), 'true', 'it shows and hides with the strip');
  assert.equal(vm.evaluate('NQAStripLabel.mouse'), 'false', 'clicks go to the world under it');
  assert.equal(vm.evaluate('NQAStripLabel.template'), 'TooltipBackdropTemplate', 'the game\'s tooltip frame, as the small bar and the reply banner');
  const words = vm.evaluate('NQAStripLabel.words.text');
  assert.equal(words, 'Sending to the NeverQuestAlone app…');
  assert.ok(words.split(/\s+/).length <= 6, words);
  assert.doesNotMatch(words, /\bBones\b|\bNQA\b|\bstrip\b|\bpixel/i, 'one name, and no plumbing words (docs/STYLE.md §2.1, §10)');
  assert.equal(vm.evaluate('NQAStripLabel.mark.texture'), 'Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone', 'the mark players know from the HUD and the AddOns list');
  // None of the strip's own cells: the capture's reading of them (vm.strip) is untouched.
  assert.equal(vm.evaluate('(function() for _, t in ipairs(NQAStrip.textures) do if t == NQAStripLabel.mark then return "cell" end end return "own" end)()'), 'own');
  // Hidden with the strip: nothing else shows or hides it.
  vm.run('NS.Transport.HideStrip()');
  assert.equal(vm.evaluate('NQAStrip.shown'), 'false');
  assert.equal(vm.evaluate('NQAStripLabel.parent.shown'), 'false');
});

test('the label sits in its zone, beside the strip\'s whole area or under it, and on screen, at every screen width and UI scale', () => {
  const placed = [];
  for (const sc of SCREENS) {
    const vm = drawn(sc);
    const zone = zoneOf(vm);
    assert.deepEqual(zone, { x: 800 + 16, y: 192 + 16 }, 'the strip\'s whole area (200 by 48 cells of 4 pixels) and a 16-pixel gap');
    const r = label(vm);
    const us = sc.ui ?? 768 / sc.h;
    const k = us * sc.h / 768;
    assert.ok(Math.abs(r.k - k) < 1e-9, `${sc.name}: a label unit is ${k} pixels (the UI's scale), not ${r.k}`);
    assert.ok(Math.abs(vm.num('NQAStripLabel.scale') - k) < 1e-9, `${sc.name}: its scale`);
    const where = r.x >= zone.x ? 'beside' : r.y >= zone.y ? 'under' : 'IN THE STRIP\'S AREA';
    assert.notEqual(where, 'IN THE STRIP\'S AREA', `${sc.name}: ${JSON.stringify(r)}`);
    // Its anchor is the rectangle reported, in its own units.
    assert.deepEqual(vm.json('{ NQAStripLabel.points.TOPLEFT.rel == NQAStrip, NQAStripLabel.points.TOPLEFT.relPoint }'), [true, 'TOPLEFT']);
    assert.ok(Math.abs(vm.num('NQAStripLabel.points.TOPLEFT.x') * k - r.x) < 1e-6 && Math.abs(-vm.num('NQAStripLabel.points.TOPLEFT.y') * k - r.y) < 1e-6, `${sc.name}: anchored where it says`);
    assert.ok(Math.abs(vm.num('NQAStripLabel.width') * k - r.w) < 1e-6 && Math.abs(vm.num('NQAStripLabel.height') * k - r.h) < 1e-6, `${sc.name}: its size`);
    // On screen: clear of the right edge beside the strip, and inside the screen under it.
    assert.ok(r.x + r.w <= sc.w - (where === 'beside' ? 8 : 0) + 1e-6, `${sc.name}: ${where}, ${r.x} + ${r.w} past ${sc.w}`);
    assert.ok(r.y + r.h <= sc.h, `${sc.name}: below the screen`);
    placed.push(`${sc.name}: ${where}${r.wrap ? ' (wrapped)' : ''}`);
  }
  // Every way it can go is exercised.
  assert.ok(placed.some(p => /beside$/.test(p)) && placed.some(p => /beside \(wrapped\)$/.test(p)) && placed.some(p => /under$/.test(p)), placed.join('\n'));
});

test('a UI scale or display change places the label again, before the strip next shows', () => {
  const vm = drawn(SCREENS[5]); // 1080p, no UI scale: beside, one line
  assert.equal(label(vm).x, 816);
  vm.run(`${screenLua({ w: 800, h: 600, ui: null })}; STUB.FireEvent("DISPLAY_SIZE_CHANGED")`);
  assert.deepEqual([label(vm).x, label(vm).y], [0, 208], 'the window made narrow: under the strip\'s whole height');
  vm.run(`${screenLua({ w: 1920, h: 1080, ui: 1.15 })}; STUB.FireEvent("UI_SCALE_CHANGED")`);
  assert.equal(label(vm).x, 816, 'wide again: beside');
  assert.ok(Math.abs(label(vm).k - 1.15 * 1080 / 768) < 1e-9, 'at the new UI scale');
});

test('turning screen reading off: while the strip tells the app so one last time (the mode seen, about 5 s), the label says "Stopping screen reading…", in its zone; on again, a send says sending (UI critic C-09)', () => {
  const vm = drawn(SCREENS[5]);
  vm.slash('stream on');
  assert.equal(vm.evaluate('NS.Transport.StripOut()'), 'false', 'off: nothing goes out on the strip any more');
  assert.match(vm.stripWires().join('\n'), /mode/, 'but the mode seen does, once');
  assert.equal(vm.evaluate('NQAStripLabel.words.text'), 'Stopping screen reading…');
  const r = label(vm), zone = zoneOf(vm);
  assert.ok(r.x >= zone.x || r.y >= zone.y, JSON.stringify(r));
  vm.advance(6);
  assert.equal(vm.evaluate('NQAStrip.shown'), 'false', 'gone after its few seconds');
  for (const [cmd, words] of [['reading off', 'Stopping screen reading…'], ['mode reload', 'Stopping screen reading…']]) {
    const off = drawn(SCREENS[5]);
    off.slash(cmd);
    assert.ok(off.strip(), cmd);
    assert.equal(off.evaluate('NQAStripLabel.words.text'), words, cmd);
  }
  vm.slash('stream off');
  vm.send('where is the forge?');
  assert.ok(vm.strip(), 'on again: the message on the strip');
  assert.equal(vm.evaluate('NQAStripLabel.words.text'), 'Sending to the NeverQuestAlone app…');
  assert.ok('Stopping screen reading…'.split(/\s+/).length <= 6);
});

// ---------------------------------------------------------------------------
// 2. Nothing in the zone is ever read
// ---------------------------------------------------------------------------

const ZONE = { x: 816, y: 208 }; // checked against the addon's own numbers above
// A record of exactly `rows` strip rows: 75 bytes a row (200 cells of 3 bits), less the frame's 8 and a little.
function cellsFor(rows, id = 300 + rows) {
  let seed = rows * 7919;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const text = Array.from({ length: 75 * rows - 10 }, () => String.fromCharCode(32 + Math.floor(rand() * 95))).join('');
  const cells = encodeWithCodec('NeverQuestAlone', id, text);
  assert.equal(Math.ceil(cells.length / 200), rows);
  return { cells, text, id };
}
const FAKE = encodeWithCodec('NeverQuestAlone', 999, 'not the strip: '.repeat(14)); // three rows of a valid frame
// A capture: s is captured pixels a strip pixel (the cells' pitch over 4); x0, y0 where the strip's
// top-left is in the picture (y0 under a title bar of that height).
const CAPTURES = [
  { name: 'native', s: 1, x0: 0, y0: 0 },
  { name: 'native, under a 28-pt title bar at 2x', s: 1, x0: 0, y0: 56, titleBar: 56 },
  { name: '5 px cells, a pixel in', s: 1.25, x0: 1, y0: 0 },
  { name: 'a non-native fullscreen (5.33 px cells)', s: 4 / 3, x0: 0, y0: 0 },
  { name: '2x, under a title bar', s: 2, x0: 0, y0: 56, titleBar: 56 },
  { name: 'a 1728-pt Retina panel at 1280 x 800 (10.8 px cells)', s: 2.7, x0: 0, y0: 0 },
  { name: '3 px cells', s: 0.75, x0: 0, y0: 0 },
];
const zoneIn = c => {
  const zx = Math.floor(c.x0 + ZONE.x * c.s), zy = Math.floor(c.y0 + ZONE.y * c.s);
  return { zx, zy, has: (x, y) => x >= zx || y >= zy };
};
function picture(c, cells) {
  const z = zoneIn(c);
  return renderRgb(cells, { pitch: 4 * c.s, x0: c.x0, y0: c.y0, titleBar: c.titleBar || 0, width: z.zx + Math.ceil(300 * c.s), height: z.zy + Math.ceil(120 * c.s) });
}
// The zone filled: a fake strip tiled from its corner (beside: from the strip's top row; under: from
// its left), or seeded noise, every channel fully on or off, as the label could never be.
function filled(c, img, how) {
  const z = zoneIn(c), p = 4 * c.s, rgb = Buffer.from(img.rgb);
  let seed = 4242;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (!z.has(x, y)) continue;
    let v;
    if (how === 'noise') v = Math.floor(rand() * 8);
    else {
      const beside = x >= z.zx;
      const cx = Math.floor((x - (beside ? z.zx : c.x0)) / p), cy = Math.floor((y - (beside ? c.y0 : z.zy)) / p);
      v = FAKE[((((cy % 3) + 3) % 3) * 200) + (((cx % 200) + 200) % 200)] ?? 0;
    }
    const i = (y * img.width + x) * 3;
    rgb[i] = v & 4 ? 255 : 0; rgb[i + 1] = v & 2 ? 255 : 0; rgb[i + 2] = v & 1 ? 255 : 0;
  }
  return { ...img, rgb };
}
// The picture as strip.mjs reads it, with every pixel read checked against the zone.
function watched(img, has) {
  const seen = { reads: 0, inZone: [] };
  const data = new Proxy(img.rgb, {
    get(t, k) {
      if (typeof k === 'string' && k.length > 0 && k.charCodeAt(0) >= 48 && k.charCodeAt(0) <= 57) {
        const px = Math.floor(Number(k) / 3), x = px % img.width, y = Math.floor(px / img.width);
        seen.reads++;
        if (has(x, y) && seen.inZone.length < 5) seen.inZone.push([x, y]);
      }
      const v = Reflect.get(t, k, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return { img: { width: img.width, height: img.height, channels: 3, data }, seen };
}
const plain = img => ({ width: img.width, height: img.height, channels: 3, data: img.rgb });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

test('the JavaScript decoder never reads a pixel of the zone, at every row count from 1 to 48, natively, scaled and under a title bar; with the zone filled it reads what it reads with it empty', () => {
  const MAC_2X = { ...LIVE, searchRows: 160, searchCols: 64 }; // Capture.swift's searchSpec at a 2x display
  let pictures = 0, reads = 0;
  for (const c of CAPTURES) {
    const rowsList = c.s === 1 && c.y0 === 0 ? Array.from({ length: 48 }, (_, i) => i + 1) : [1, 2, 5, 15, 43, 48];
    for (const rows of rowsList) {
      const { cells, text, id } = cellsFor(rows);
      const clean = picture(c, cells);
      for (const spec of c.s >= 1 && c.titleBar ? [LIVE, MAC_2X] : [LIVE]) {
        const want = findAndDecode(plain(clean), spec);
        assert.deepEqual([want.kind, want.id, want.text === text], ['decoded', id, true], `${c.name}, ${rows} rows: ${want.kind} ${want.reason || ''}`);
        const z = zoneIn(c);
        for (const how of rows % 2 || c.s !== 1 ? ['fake strip'] : ['fake strip', 'noise']) {
          const img = filled(c, clean, how);
          for (const hint of [null, want.geometry]) {
            const w = watched(img, z.has);
            const got = findAndDecode(w.img, spec, hint);
            assert.deepEqual(w.seen.inZone, [], `${c.name}, ${rows} rows, ${how}${hint ? ', hinted' : ''}: read the zone at ${JSON.stringify(w.seen.inZone)}`);
            assert.ok(same(got, want), `${c.name}, ${rows} rows, ${how}: ${JSON.stringify(got).slice(0, 160)}`);
            pictures++;
            reads += w.seen.reads;
          }
        }
      }
    }
  }
  assert.ok(pictures > 200 && reads > 1e6, `${pictures} pictures, ${reads} pixel reads checked`);
});

// The Windows helper's decoder, compiled with this machine's cc into its test harness (as
// tests/byok/capture_windows_decoder_test.mjs builds it).
function decodeRaw() {
  const cc = process.env.CC || 'cc';
  try { execFileSync(cc, ['--version'], { stdio: 'ignore' }); } catch { return null; }
  const src = path.join(REPO, 'bridge', 'capture', 'windows');
  const bin = path.join(TMP, 'decode_raw');
  execFileSync(cc, ['-std=c11', '-O2', '-o', bin, ...['decoder.c', 'errlimit.c', 'jsonl.c', 'ppm.c', 'winpick.c', 'decode_raw.c'].map(f => path.join(src, f)), '-lm'], { stdio: ['ignore', 'ignore', 'inherit'] });
  return bin;
}
const RAW = decodeRaw();
// The pairs both native decoders read: a clean picture and the same with its zone filled.
function pairs(kind) {
  const out = [];
  for (const c of CAPTURES.filter(x => x.s !== 0.75 || kind === 'c')) {
    for (const rows of kind === 'c' ? [1, 2, 15, 43, 48] : [1, 15, 48]) {
      const { cells } = cellsFor(rows);
      const clean = picture(c, cells);
      const name = `${c.name.replace(/[^a-z0-9]+/gi, '-')}-${rows}`;
      out.push({ name, clean, fake: filled(c, clean, 'fake strip'), noise: filled(c, clean, 'noise') });
    }
  }
  return out;
}
const result = r => ({ status: r.status, reason: r.reason ?? null, id: r.id ?? null, text: r.text ?? null, geometry: r.geometry ?? null, crop: r.crop ?? null });

test('the Windows helper\'s decoder (decoder.c) reads every picture with its zone filled as it reads it empty, at its crop too', { skip: RAW ? false : 'needs a C compiler (cc)' }, () => {
  const files = [];
  for (const p of pairs('c')) {
    for (const [tag, img] of [['clean', p.clean], ['fake', p.fake], ['noise', p.noise]]) {
      const f = path.join(TMP, `${p.name}-${tag}.ppm`);
      fs.writeFileSync(f, ppm(img));
      files.push(f);
    }
  }
  for (const flags of [[], ['--crop', '900x300', '--frames', '2']]) {
    const out = execFileSync(RAW, [...flags, ...files], { encoding: 'utf8', maxBuffer: 1 << 26 }).trim().split('\n').map(l => JSON.parse(l));
    for (let i = 0; i < out.length; i += 3) {
      const [clean, fake, noise] = out.slice(i, i + 3).map(result);
      assert.equal(clean.status, 'decoded', `${files[i]} ${flags.join(' ')}: ${JSON.stringify(clean).slice(0, 160)}`);
      assert.deepEqual(fake, clean, `${files[i + 1]} ${flags.join(' ')}`);
      assert.deepEqual(noise, clean, `${files[i + 2]} ${flags.join(' ')}`);
    }
  }
});

// The Mac helper, built as tests/capture_mac_test.js builds it.
function macHelper() {
  if (process.platform !== 'darwin') return null;
  const pkg = path.join(REPO, 'bridge', 'capture', 'mac');
  try { execFileSync('swift', ['--version'], { stdio: 'ignore' }); } catch { return null; }
  execFileSync('swift', ['build', '-c', 'release', '--package-path', pkg], { stdio: ['ignore', 'ignore', 'inherit'] });
  const bin = execFileSync('swift', ['build', '-c', 'release', '--package-path', pkg, '--show-bin-path'], { encoding: 'utf8' }).trim();
  return path.join(bin, 'NQACapture');
}
const MAC = macHelper();

test('the Mac helper\'s decoder (StripDecoder.swift) reads every picture with its zone filled as it reads it empty', { skip: MAC ? false : 'needs macOS with Swift' }, () => {
  const read = img => {
    const f = path.join(TMP, 'mac.png');
    fs.writeFileSync(f, png(img.width, img.height, img.rgb));
    return JSON.parse(execFileSync(MAC, ['--test-image', f, '--magic', 'C72C'], { encoding: 'utf8' }).trim().split('\n').pop());
  };
  for (const p of pairs('mac')) {
    const clean = read(p.clean);
    assert.ok(typeof clean.text === 'string' && clean.geometry, `${p.name}: ${JSON.stringify(clean).slice(0, 160)}`);
    assert.deepEqual(read(p.fake), clean, `${p.name}, a fake strip in the zone`);
    assert.deepEqual(read(p.noise), clean, `${p.name}, noise in the zone`);
  }
});

// ---------------------------------------------------------------------------
// 3. The numbers the zone rests on
// ---------------------------------------------------------------------------

test('the zone\'s gap covers every decoder\'s reach: its search box, the widest pitch\'s nudges and the capture\'s 8-pixel margin, read from each source', () => {
  const read = f => fs.readFileSync(path.join(REPO, f), 'utf8');
  const c = read('bridge/capture/windows/decoder.c'), swift = read('bridge/capture/mac/Sources/StripDecoder/StripDecoder.swift');
  const capture = read('bridge/capture/mac/Sources/NQACapture/Capture.swift'), x11 = read('bridge/capture_x11.py'), js = read('bridge/transport/strip.mjs');
  const transport = read('addon/NeverQuestAlone/Transport.lua');
  // The strip's geometry: 4-pixel cells, 200 a row, 48 rows at most.
  assert.match(transport, /local CELL, CELLS_PER_ROW, MAX_ROWS = 4, 200, 48/);
  // Every decoder: an 80-row, 32-column search (Capture.swift scales both by the display's scale), runs
  // measured over six cells at the widest pitch (12) and 4 pixels more, and the same nudges.
  assert.match(c, /search_rows = 80;[\s\S]*search_cols = 32;[\s\S]*max_pitch = 12\.0;/);
  assert.match(c, /limit = x \+ \(int\)\(spec->max_pitch \* 6\) \+ 4;/);
  assert.match(c, /dps\[6\] = \{0\.005, -0\.005, 0\.01, -0\.01, 0\.02, -0\.02\};\s*static const double dys\[3\] = \{1\.0, -1\.0, 2\.0\};\s*static const double dxs\[2\] = \{0\.5, -0\.5\};/);
  assert.match(c, /#define WC_CROP_MARGIN 8\b/);
  assert.match(swift, /searchRows = 80\b[\s\S]*searchCols = 32\b[\s\S]*maxPitch = 12\.0/);
  assert.match(swift, /limit = min\(px\.width, x \+ Int\(spec\.maxPitch \* 6\) \+ 4\)/);
  assert.match(swift, /for dp in \[0\.005, -0\.005, 0\.01, -0\.01, 0\.02, -0\.02\][\s\S]*for dy in \[1\.0, -1\.0, 2\.0\][\s\S]*for dx in \[0\.5, -0\.5\]/);
  assert.match(capture, /static let stripMarginPx = 8\.0/);
  assert.match(capture, /s\.searchRows = Int\(\(80 \* scale\)\.rounded\(\)\)\s*s\.searchCols = Int\(\(32 \* scale\)\.rounded\(\)\)/);
  assert.match(x11, /^SLACK = 8\b/m);
  assert.match(js, /searchRows: 80, searchCols: 32, minPitch: 2\.5, maxPitch: 12/);
  // The farthest any of them reads from the strip's top-left, in captured pixels, for cells of p
  // pixels at a fitted geometry: the last cell's centre at the widest nudge (a pitch 0.02 more, half a
  // pixel right, 2 down), the search box (the Mac's at a 2x display, its widest), and the capture's
  // margin past the strip's whole area. The zone (816 and 208 strip pixels, so 204 and 52 cells) starts
  // past all of it, for every pitch a decoder reads (2.5 to 12) and a 2x display's search.
  for (let p = 2.5; p <= 12; p += 0.25) {
    const s = p / 4;
    const reachX = Math.max(0.5 + 199.5 * (p + 0.02) + 1, 200 * p + 8, (p >= 4 ? 64 : 32) + 6 * 12 + 4);
    const reachY = Math.max(2 + 47.5 * (p + 0.02) + 1, 48 * p + 8, p >= 4 ? 160 : 80);
    assert.ok(ZONE.x * s > reachX, `${p} px cells: the zone at ${ZONE.x * s}, reads reach ${reachX}`);
    assert.ok(ZONE.y * s > reachY, `${p} px cells: the zone at ${ZONE.y * s}, reads reach ${reachY}`);
  }
});
