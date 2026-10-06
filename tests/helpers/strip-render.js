'use strict';
// Test helper: encode a message with the addon's real Codec.lua (in a Lua VM)
// and render it the way the Mac compositor might show it: at the native 4 px
// cell, or scaled (bilinear) to another pitch, below a title bar, over a busy
// background, with noise and a gamma curve.
// [code health AD-11] The shipped encoder (addon/NeverQuestAlone/Codec.lua, magic C7 2C), so
// the decoder tests read what the game draws; magic2 0x1A stands in for upstream's strip.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const CODEC = path.join(__dirname, '..', '..', 'addon', 'NeverQuestAlone', 'Codec.lua');

// magic2: the second magic byte, for an upstream fixture (0x1A); the shipped codec's (0x2C) by default.
function encodeWithLua(id, payload, magic2) {
  const bytes = Buffer.from(payload, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = fs.readFileSync(CODEC, 'utf8') +
    (magic2 !== undefined ? `\nNQA_Codec.MAGIC2 = ${magic2}\n` : '') +
    `\nlocal cells = NQA_Codec.Encode(${id}, ${lit})\n` +
    'local t = {}\nfor i = 1, #cells do t[i] = string.format("%d", cells[i]) end\n' +
    'RESULT = table.concat(t, ",")\n';
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) {
    throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  }
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

function png(width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Deterministic noise so a failure reproduces.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

/**
 * Render cells into an RGB canvas.
 * opts: { width, height, x0, y0, pitch (px per cell, fractional ok), cell (native px, 4),
 *         cellsPerRow (200), jitter (±noise), gamma, seed, busyBackground, titleBar (px of grey bar) }
 */
function render(cells, opts) {
  const o = Object.assign({ width: 1800, height: 600, x0: 0, y0: 0, pitch: 4, cell: 4, cellsPerRow: 200,
    jitter: 0, gamma: 0, seed: 7, busyBackground: false, titleBar: 0 }, opts);
  const rand = rng(o.seed);
  const W = o.width, H = o.height;
  const rgb = Buffer.alloc(W * H * 3);
  // Background: a dark game scene, or a busy one with yellow-ish UI bits near the corner.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (o.busyBackground) {
      const band = ((x >> 3) + (y >> 4)) % 7;
      const pal = [[40, 30, 20], [200, 170, 40], [60, 90, 140], [230, 230, 210], [10, 10, 10], [150, 40, 40], [30, 120, 50]][band];
      rgb[i] = pal[0]; rgb[i + 1] = pal[1]; rgb[i + 2] = pal[2];
    } else {
      rgb[i] = 0x30; rgb[i + 1] = 0x2a; rgb[i + 2] = 0x26;
    }
  }
  for (let y = 0; y < Math.min(o.titleBar, H); y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3; rgb[i] = 0xe6; rgb[i + 1] = 0xe6; rgb[i + 2] = 0xe6;
  }
  // The strip at its native size (what the game draws), then scaled bilinearly.
  const rows = Math.ceil(cells.length / o.cellsPerRow);
  const nW = o.cellsPerRow * o.cell, nH = rows * o.cell;
  const native = new Float32Array(nW * nH * 3);
  for (let i = 0; i < rows * o.cellsPerRow; i++) {
    const v = cells[i] || 0;
    const c = i % o.cellsPerRow, r = Math.floor(i / o.cellsPerRow);
    const lv = [Math.floor(v / 4) % 2, Math.floor(v / 2) % 2, v % 2].map(l => l * 255);
    for (let y = 0; y < o.cell; y++) for (let x = 0; x < o.cell; x++) {
      const k = ((r * o.cell + y) * nW + (c * o.cell + x)) * 3;
      native[k] = lv[0]; native[k + 1] = lv[1]; native[k + 2] = lv[2];
    }
  }
  const s = o.pitch / o.cell;
  const outW = Math.round(nW * s), outH = Math.round(nH * s);
  const sample = (fx, fy, k) => {
    const x = Math.max(0, Math.min(nW - 1, fx)), y = Math.max(0, Math.min(nH - 1, fy));
    const xa = Math.floor(x), ya = Math.floor(y), xb = Math.min(nW - 1, xa + 1), yb = Math.min(nH - 1, ya + 1);
    const tx = x - xa, ty = y - ya;
    const at = (xx, yy) => native[(yy * nW + xx) * 3 + k];
    return at(xa, ya) * (1 - tx) * (1 - ty) + at(xb, ya) * tx * (1 - ty) + at(xa, yb) * (1 - tx) * ty + at(xb, yb) * tx * ty;
  };
  for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
    const X = x + Math.round(o.x0), Y = y + Math.round(o.y0);
    if (X >= W || Y >= H) continue;
    const i = (Y * W + X) * 3;
    for (let k = 0; k < 3; k++) {
      let val = s === 1 ? native[(y * nW + x) * 3 + k] : sample((x + 0.5) / s - 0.5, (y + 0.5) / s - 0.5, k);
      if (o.gamma) val = 255 * Math.pow(val / 255, o.gamma);
      if (o.jitter) val += Math.round((rand() * 2 - 1) * o.jitter);
      rgb[i + k] = Math.max(0, Math.min(255, Math.round(val)));
    }
  }
  return png(W, H, rgb);
}

module.exports = { encodeWithLua, render, png };
