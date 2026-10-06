// Pictures to pixels, for the strip decoder (strip.mjs): the game's screenshot
// formats (the screenshotFormat CVar: jpeg, the default, png or tga). PNG and
// TGA need only zlib; JPEG uses jpeg-js (pure JavaScript, no dependencies).
//
// → { width, height, channels, data } with R, G, B first in each pixel.
import zlib from 'node:zlib';
import jpeg from 'jpeg-js';

const MAX_PIXELS = 200e6; // an 8K screenshot is 33 million

export function imageKind(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 18 && [2, 10].includes(buf[2]) && [24, 32].includes(buf[16])) return 'tga';
  return null;
}

export function decodeImage(buf) {
  const kind = imageKind(buf);
  if (kind === 'png') return decodePng(buf);
  if (kind === 'tga') return decodeTga(buf);
  if (kind === 'jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: false, maxResolutionInMP: MAX_PIXELS / 1e6, maxMemoryUsageInMB: 2048 });
    return { width: img.width, height: img.height, channels: 3, data: img.data };
  }
  throw new Error('not a PNG, JPEG or TGA picture');
}

/** 8-bit RGB or RGBA, not interlaced: what games and our tests write. */
export function decodePng(buf) {
  let at = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (at + 8 <= buf.length) {
    const len = buf.readUInt32BE(at), type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      const depth = data[8], color = data[9], interlace = data[12];
      if (depth !== 8 || ![2, 6].includes(color) || interlace !== 0) throw new Error(`PNG: only 8-bit RGB or RGBA, not interlaced (depth ${depth}, colour ${color})`);
      channels = color === 6 ? 4 : 3;
      if (width * height > MAX_PIXELS) throw new Error('PNG: too big');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    at += 12 + len;
  }
  if (!channels) throw new Error('PNG: no header');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error('PNG: short image data');
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[row + x - channels] : 0;
      const b = y ? out[up + x] : 0;
      const c = x >= channels && y ? out[up + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new Error(`PNG: bad filter ${f}`);
      out[row + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** True-colour TGA, plain or run-length (types 2 and 10), 24 or 32 bits, either origin. */
export function decodeTga(buf) {
  const idLen = buf[0], type = buf[2], width = buf.readUInt16LE(12), height = buf.readUInt16LE(14);
  const bpp = buf[16] / 8, topDown = (buf[17] & 0x20) !== 0;
  if (buf[1] !== 0) throw new Error('TGA: colour-mapped pictures are not supported');
  if (width * height > MAX_PIXELS) throw new Error('TGA: too big');
  const px = new Uint8Array(width * height * 3);
  let src = 18 + idLen, n = 0;
  const put = (at) => { px[n * 3] = buf[at + 2]; px[n * 3 + 1] = buf[at + 1]; px[n * 3 + 2] = buf[at]; n++; };
  if (type === 2) {
    if (src + width * height * bpp > buf.length) throw new Error('TGA: short image data');
    for (let i = 0; i < width * height; i++) put(src + i * bpp);
  } else {
    while (n < width * height) {
      if (src >= buf.length) throw new Error('TGA: short image data');
      const h = buf[src++], count = (h & 0x7f) + 1;
      if (n + count > width * height) throw new Error('TGA: bad run');
      if (h & 0x80) { for (let k = 0; k < count; k++) put(src); src += bpp; } else { for (let k = 0; k < count; k++) put(src + k * bpp); src += count * bpp; }
    }
  }
  if (topDown) return { width, height, channels: 3, data: px };
  const flipped = new Uint8Array(px.length), stride = width * 3;
  for (let y = 0; y < height; y++) flipped.set(px.subarray((height - 1 - y) * stride, (height - y) * stride), y * stride);
  return { width, height, channels: 3, data: flipped };
}
