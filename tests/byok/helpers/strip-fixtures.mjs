// Strip fixtures for the capture decoders (PRD §11.1, §11.3): encode with the
// addon's real Codec.lua in a Lua VM (NeverQuestAlone's C7 2C; or upstream wow-ai's
// C7 1A, which is the same codec with the other magic: code health RP-02), render with
// tests/helpers/strip-render.js (pitch, title bar, busy background, noise, gamma), and
// hand back raw RGB, a binary PPM (for the C harness) or a PNG (for capture_x11.py).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const fengari = require('fengari');
const { render } = require('../../helpers/strip-render.js');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CODEC = path.join(REPO, 'addon', 'NeverQuestAlone', 'Codec.lua');
const CODECS = {
  NeverQuestAlone: { magic: [0xC7, 0x2C] },
  // Upstream's strip (protocol v1), for the decoders' --magic C71A: the shipped encoder with its
  // second magic byte set to upstream's, as tests/helpers/strip-render.js draws it (AD-11).
  upstream: { magic: [0xC7, 0x1A] },
};

/** Cells (0..7) for one frame, from the addon's own Codec.lua. */
export function encodeWithCodec(codec, id, text) {
  const c = CODECS[codec];
  if (!c) throw new Error(`unknown codec ${codec}`);
  const bytes = Buffer.from(text, 'utf8');
  const lit = '"' + [...bytes].map(b => '\\' + b).join('') + '"';
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const code = fs.readFileSync(CODEC, 'utf8') +
    `\nNQA_Codec.MAGIC2 = ${c.magic[1]}\n` +
    `\nlocal cells = NQA_Codec.Encode(${id}, ${lit})\n` +
    'local t = {}\nfor i = 1, #cells do t[i] = string.format("%d", cells[i]) end\n' +
    'RESULT = table.concat(t, ",")\n';
  if (lauxlib.luaL_dostring(L, to_luastring(code)) !== 0) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1)).split(',').map(Number);
}

/** Bytes -> 3-bit cells, MSB first, as Codec.lua packs them. */
export function bytesToCells(bytes) {
  const cells = [];
  let acc = 0, nbits = 0;
  for (const b of bytes) {
    acc = acc * 256 + b; nbits += 8;
    while (nbits >= 3) { const shift = nbits - 3; cells.push(Math.floor(acc / 2 ** shift) % 8); nbits = shift; acc %= 2 ** nbits; }
  }
  if (nbits > 0) cells.push((acc * 2 ** (3 - nbits)) % 8);
  return cells;
}

/** The same frame as Codec.lua, for byte payloads Lua literals can't carry cleanly (invalid UTF-8). */
export function encodeBytes(id, payload, magic = CODECS.NeverQuestAlone.magic) {
  const bytes = [magic[0], magic[1], (id >> 8) & 255, id & 255, (payload.length >> 8) & 255, payload.length & 255, ...payload];
  let s1 = 0, s2 = 0;
  for (let i = 2; i < bytes.length; i++) { s1 = (s1 + bytes[i]) % 255; s2 = (s2 + s1) % 255; }
  bytes.push(s1, s2);
  return bytesToCells(bytes);
}

/** PNG (as strip-render writes it: 8-bit RGB, filter 0 on every row) -> raw RGB. */
export function pngToRgb(png) {
  let pos = 8, width = 0, height = 0;
  const idat = [];
  while (pos < png.length) {
    const n = png.readUInt32BE(pos), type = png.toString('ascii', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + n);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + n;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    if (raw[y * (width * 3 + 1)] !== 0) throw new Error('unexpected PNG filter');
    raw.copy(rgb, y * width * 3, y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1));
  }
  return { width, height, rgb };
}

export function ppm({ width, height, rgb }) {
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`, 'ascii'), rgb]);
}

/** Render cells (strip-render options: pitch, x0, y0, titleBar, jitter, gamma, busyBackground, width, height, seed). */
export function renderRgb(cells, opts) {
  return pngToRgb(render(cells, opts));
}

export { render as renderPng };
