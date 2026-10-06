// The JavaScript strip decoder (bridge/transport/strip.mjs) and picture readers
// (images.mjs): the live strip as NeverQuestAlone Capture sees it, and a screenshot's
// 8 px strip through the game's formats, JPEG included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import jpeg from 'jpeg-js';
import { LIVE, SHOT, decodeAt, findAndDecode } from '../bridge/transport/strip.mjs';
import { decodeImage, decodePng, decodeTga, imageKind } from '../bridge/transport/images.mjs';

const require = createRequire(import.meta.url);
const { encodeWithLua, render } = require('./helpers/strip-render.js');
const cellsFor = (id, text) => encodeWithLua(id, text); // the shipped codec, magic C7 2C (code health AD-11)

const shot = (cells, o = {}) => render(cells, { cellsPerRow: SHOT.cells, cell: 8, pitch: 8, width: 1024, height: 768, ...o });
const rgba = img => {
  const out = Buffer.alloc(img.width * img.height * 4);
  for (let i = 0; i < img.width * img.height; i++) {
    out[i * 4] = img.data[i * 3]; out[i * 4 + 1] = img.data[i * 3 + 1]; out[i * 4 + 2] = img.data[i * 3 + 2]; out[i * 4 + 3] = 255;
  }
  return out;
};
function tga(img, { topDown = false } = {}) {
  const h = Buffer.alloc(18);
  h[2] = 2; h.writeUInt16LE(img.width, 12); h.writeUInt16LE(img.height, 14); h[16] = 24; h[17] = topDown ? 0x20 : 0;
  const px = Buffer.alloc(img.width * img.height * 3);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const from = (y * img.width + x) * 3, to = ((topDown ? y : img.height - 1 - y) * img.width + x) * 3;
    px[to] = img.data[from + 2]; px[to + 1] = img.data[from + 1]; px[to + 2] = img.data[from];
  }
  return Buffer.concat([h, px]);
}

const TEXT = 'v=2;k=msg;c=main;t=Where do I turn in Hogger’s head? Ünïcödé ✓';

test('the live strip: 4 px cells at the corner, and scaled under a title bar with noise', () => {
  const clean = decodePng(render(cellsFor(4242, TEXT), { width: 900, height: 200 }));
  const r = findAndDecode(clean, LIVE);
  assert.equal(r.kind, 'decoded');
  assert.equal(r.id, 4242);
  assert.equal(r.text, TEXT);
  assert.deepEqual(r.geometry, { x0: 0, y0: 0, pitch: 4 });

  const rough = decodePng(render(cellsFor(7, TEXT), { width: 1200, height: 260, pitch: 5.4, y0: 28, titleBar: 28, busyBackground: true, gamma: 1.2, jitter: 20 }));
  const s = findAndDecode(rough, LIVE);
  assert.equal(s.kind, 'decoded', JSON.stringify(s));
  assert.equal(s.text, TEXT);
  assert.ok(Math.abs(s.geometry.pitch - 5.4) < 0.05 && Math.abs(s.geometry.y0 - 28) < 2);
  assert.deepEqual(findAndDecode(rough, LIVE, s.geometry), s, 'a hint that worked decodes at once');
});

test('a screenshot strip: 8 px cells, 100 a row, up to the largest payload', () => {
  const big = 'x'.repeat(3180) + '✓✓✓✓✓✓';
  assert.equal(Buffer.byteLength(big), 3198);
  const img = decodePng(shot(cellsFor(65535, big), { busyBackground: true }));
  const r = findAndDecode(img, SHOT);
  assert.equal(r.kind, 'decoded');
  assert.equal(r.id, 65535);
  assert.equal(r.text, big);
  assert.notEqual(findAndDecode(img, LIVE).kind, 'decoded', 'the row length is part of the geometry');
});

test('a screenshot strip survives the game\'s JPEG compression at 8 px cells, even off the corner', () => {
  // Off the corner, the game shows through to the strip's left: the decoder
  // tries each run of the magic's first colour, not only the first.
  for (const [x0, y0] of [[0, 0], [37, 13]]) {
    const img = decodePng(shot(cellsFor(99, TEXT), { busyBackground: true, x0, y0 }));
    for (const quality of [20, 30, 50, 90]) {
      const file = Buffer.from(jpeg.encode({ data: rgba(img), width: img.width, height: img.height }, quality).data);
      assert.equal(imageKind(file), 'jpeg');
      const r = findAndDecode(decodeImage(file), SHOT);
      assert.equal(r.kind, 'decoded', `(${x0}, ${y0}) at quality ${quality}: ${JSON.stringify(r)}`);
      assert.equal(r.text, TEXT);
    }
  }
});

test('TGA, plain and run-length, top-down and bottom-up, reads the same pixels as PNG', () => {
  const img = decodePng(shot(cellsFor(5, TEXT), { width: 820, height: 120 }));
  for (const topDown of [false, true]) {
    const t = tga(img, { topDown });
    assert.equal(imageKind(t), 'tga');
    assert.deepEqual(decodeImage(t).data, img.data);
    assert.equal(findAndDecode(decodeTga(t), SHOT).text, TEXT);
  }
  // 3 x 2, run-length: a run of two reds, a raw blue, then a raw white, green, black (bottom row first).
  const h = Buffer.alloc(18);
  h[2] = 10; h.writeUInt16LE(3, 12); h.writeUInt16LE(2, 14); h[16] = 24;
  const body = Buffer.from([0x81, 0, 0, 255, 0x00, 255, 0, 0, 0x02, 255, 255, 255, 0, 255, 0, 0, 0, 0]);
  const rle = decodeTga(Buffer.concat([h, body]));
  assert.deepEqual([...rle.data], [255, 255, 255, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255]);
});

test('no strip, a damaged strip and cells too small to read are told apart', () => {
  const blank = decodePng(render([], { width: 400, height: 100 }));
  assert.deepEqual(findAndDecode(blank, SHOT), { kind: 'none' });

  const img = decodePng(shot(cellsFor(1, TEXT), { width: 820, height: 120 }));
  const g = findAndDecode(img, SHOT).geometry;
  // Flip one payload cell (the 30th) to another colour: the checksum catches it.
  const x = Math.floor(g.x0 + 29.5 * g.pitch), y = Math.floor(g.y0 + 0.5 * g.pitch);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const p = ((y + dy) * img.width + x + dx) * 3;
    img.data[p] ^= 0xff;
  }
  const bad = findAndDecode(img, SHOT);
  assert.equal(bad.kind, 'rejected');
  assert.equal(bad.reason, 'checksum');
  assert.equal(decodeAt(img, g, SHOT).reason, 'checksum');

  const tiny = decodePng(render(cellsFor(1, TEXT), { width: 500, height: 60, pitch: 2 }));
  assert.equal(findAndDecode(tiny, LIVE).reason, 'pitch_too_small');
  assert.throws(() => decodeImage(Buffer.from('not a picture at all')), /not a PNG, JPEG or TGA/);
});
