// The strip decoder in JavaScript (docs/PROTOCOL.md §2.1), for pictures the
// bridge reads itself, such as the game's own screenshots (docs/ADDON-FIRST.md).
// It follows NeverQuestAlone Capture's StripDecoder.swift rule for rule: a cell is read
// at its centre, a channel is on at 128 or more, and the geometry (top-left
// corner and cell pitch) is measured from the magic's colour runs, then fitted
// to the colour changes along the first row.
//
// An image is { width, height, channels, data } with R, G, B first in each
// pixel (images.mjs makes them).

export const MAGIC = [0xc7, 0x2c];
// Transport.lua's live strip: 4 px cells, 200 a row, up to 48 rows.
export const LIVE = { cells: 200, rows: 48 };
// A screenshot's strip: 8 px cells, which survive the game's JPEG compression
// where 4 px cells don't; 100 a row, so it fits an 800 px wide screen. The
// search reaches further in, in case the UI sits inside a safe area.
export const SHOT = { cells: 100, rows: 96, searchCols: 96, searchRows: 160 };

const SPEC = { cells: 200, rows: 48, magic: MAGIC, searchRows: 80, searchCols: 32, minPitch: 2.5, maxPitch: 12 };
const spec = s => ({ ...SPEC, ...s });

/** The 3-bit value of one pixel. */
export function cellAt(img, x, y) {
  const p = (y * img.width + x) * img.channels, d = img.data;
  return (d[p] >= 128 ? 4 : 0) | (d[p + 1] >= 128 ? 2 : 0) | (d[p + 2] >= 128 ? 1 : 0);
}

/**
 * Decode with the cells sampled at their centres for one geometry { x0, y0, pitch }.
 * → { kind: 'none' } | { kind: 'rejected', reason, geometry } | { kind: 'decoded', id, text, bytes, geometry }
 */
export function decodeAt(img, g, s = SPEC) {
  s = spec(s);
  let acc = 0, nbits = 0, needed = 6;
  const out = [];
  const total = s.cells * s.rows;
  for (let i = 0; i < total && out.length < needed; i++) {
    const x = Math.floor(g.x0 + ((i % s.cells) + 0.5) * g.pitch);
    const y = Math.floor(g.y0 + (Math.floor(i / s.cells) + 0.5) * g.pitch);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
      return out.length >= 2 ? { kind: 'rejected', reason: 'truncated', geometry: g } : { kind: 'none' };
    }
    acc = ((acc << 3) | cellAt(img, x, y)) >>> 0;
    nbits += 3;
    while (nbits >= 8) {
      out.push((acc >>> (nbits - 8)) & 0xff);
      nbits -= 8;
      acc &= (1 << nbits) - 1;
      if (out.length === 2 && (out[0] !== s.magic[0] || out[1] !== s.magic[1])) return { kind: 'none' };
      if (out.length === 6) {
        needed = 8 + ((out[4] << 8) | out[5]);
        if (needed > Math.floor((total * 3) / 8)) return { kind: 'rejected', reason: 'length', geometry: g };
      }
      if (out.length >= needed) break;
    }
  }
  if (out.length < needed) return { kind: 'rejected', reason: 'truncated', geometry: g };
  const len = (out[4] << 8) | out[5];
  let s1 = 0, s2 = 0;
  for (let k = 2; k < 6 + len; k++) { s1 = (s1 + out[k]) % 255; s2 = (s2 + s1) % 255; }
  if (out[6 + len] !== s1 || out[7 + len] !== s2) return { kind: 'rejected', reason: 'checksum', geometry: g };
  const text = Buffer.from(out.slice(6, 6 + len)).toString('utf8');
  return { kind: 'decoded', id: (out[2] << 8) | out[3], text, bytes: len, geometry: g };
}

/** The magic's first five whole cells, as runs of equal values. */
function magicRuns(s) {
  const m = (s.magic[0] << 8) | s.magic[1];
  const runs = [];
  for (let k = 0; k < 5; k++) {
    const v = (m >>> (13 - 3 * k)) & 7;
    if (runs.length && runs[runs.length - 1].value === v) runs[runs.length - 1].cells += 1;
    else runs.push({ value: v, cells: 1 });
  }
  return runs;
}

/**
 * Candidate geometries: rows near the top where, close to the left edge, the
 * magic's colour runs start; the pitch comes from where the runs change. Also the
 * first magic whose cells are too small to decode (tooSmall).
 */
function candidates(img, s, maxCandidates = 4) {
  const want = magicRuns(s);
  const found = [];
  let tooSmall = null;
  const maxY = Math.min(s.searchRows, img.height), maxX = Math.min(s.searchCols, img.width);
  // Unlike the Swift decoder, every run of the first magic colour in the
  // search span is tried, not just the first: in a screenshot the game can
  // show through to the left of the strip.
  for (let y = 0, x = 0; y < maxY && found.length < maxCandidates; x++) {
    if (x >= maxX) { y++; x = -1; continue; }
    if (cellAt(img, x, y) !== want[0].value || (x > 0 && cellAt(img, x - 1, y) === want[0].value)) continue;
    // Run lengths over a fixed span (six cells at the largest pitch), with
    // 1-pixel blips (blended edges) folded into the run before them.
    const limit = Math.min(img.width, x + Math.floor(s.maxPitch * 6) + 4);
    const runs = [];
    let cur = cellAt(img, x, y), start = x, xx = x + 1;
    for (; xx < limit; xx++) {
      const v = cellAt(img, xx, y);
      if (v !== cur) { runs.push({ value: cur, start, len: xx - start }); cur = v; start = xx; }
    }
    runs.push({ value: cur, start, len: xx - start });
    const merged = [];
    for (const r of runs) {
      if (r.len <= 1 && merged.length) { merged[merged.length - 1].len += r.len; continue; }
      if (merged.length && merged[merged.length - 1].value === r.value) merged[merged.length - 1].len += r.len;
      else merged.push({ ...r });
    }
    if (merged.length < want.length || want.some((w, k) => merged[k].value !== w.value)) continue;
    const cellsBefore = want.slice(0, -1).reduce((n, w) => n + w.cells, 0);
    const p = (merged[want.length - 1].start - merged[0].start) / cellsBefore;
    if (p > s.maxPitch || p < 1.5) continue;
    let runsOk = true;
    for (let k = 0; k < want.length - 1; k++) {
      const expect = p * want[k].cells;
      if (merged[k].len < expect * 0.5 || merged[k].len > expect * 1.6) { runsOk = false; break; }
    }
    if (!runsOk) continue;
    const g = { x0: merged[0].start, y0: y, pitch: p };
    if (p < s.minPitch) { tooSmall ??= g; continue; }
    if (!found.some(f => Math.abs(f.x0 - g.x0) < 1 && Math.abs(f.pitch - g.pitch) < 0.3 && Math.abs(f.y0 - g.y0) < p)) found.push(g);
  }
  return { found, tooSmall };
}

/**
 * Sharpen x0 and the pitch with a least-squares fit of the colour changes along
 * the first cell row, where each change sits on a boundary x0 + k * pitch.
 */
function refine(img, g0, s) {
  const g = { ...g0 };
  const y = Math.floor(g.y0 + 0.5 * g.pitch);
  if (y < 0 || y >= img.height) return g;
  for (const maxCells of [12, 32, 80, s.cells]) {
    const xEnd = Math.min(img.width, Math.floor(g.x0 + maxCells * g.pitch));
    let n = 0, sk = 0, st = 0, skk = 0, skt = 0, lastK = -1;
    let prev = cellAt(img, Math.max(0, Math.floor(g.x0)), y);
    for (let x = Math.max(0, Math.floor(g.x0)) + 1; x < xEnd; x++) {
      const v = cellAt(img, x, y);
      if (v === prev) continue;
      const kf = (x - g.x0) / g.pitch, k = Math.round(kf);
      if (k >= 1 && Math.abs(kf - k) < 0.35 && k !== lastK) { n++; sk += k; st += x; skk += k * k; skt += k * x; lastK = k; }
      prev = v;
    }
    if (n < 3) continue;
    const den = n * skk - sk * sk;
    if (den <= 0) continue;
    const p = (n * skt - sk * st) / den, x0 = (st - p * sk) / n;
    if (p > s.minPitch && p < s.maxPitch && Math.abs(p - g.pitch) < g.pitch * 0.2) { g.pitch = p; g.x0 = x0; }
  }
  return g;
}

/** Find and decode the strip; hint is the last geometry that worked. */
export function findAndDecode(img, s = SPEC, hint = null) {
  s = spec(s);
  let rejected = null;
  if (hint) {
    const r = decodeAt(img, hint, s);
    if (r.kind === 'decoded') return r;
    if (r.kind === 'rejected') rejected = r;
  }
  const { found, tooSmall } = candidates(img, s);
  for (const est of found) {
    const f = refine(img, est, s);
    // The fit, one-axis nudges around it, then the raw estimate: at most 13
    // decodes a candidate, so a damaged strip can't eat the CPU.
    const tries = [f,
      ...[0.005, -0.005, 0.01, -0.01, 0.02, -0.02].map(dp => ({ ...f, pitch: f.pitch + dp })),
      ...[1, -1, 2].map(dy => ({ ...f, y0: f.y0 + dy })),
      ...[0.5, -0.5].map(dx => ({ ...f, x0: f.x0 + dx })),
      est];
    for (const g of tries) {
      const r = decodeAt(img, g, s);
      if (r.kind === 'decoded') return r;
      if (r.kind === 'rejected') rejected ??= r;
    }
  }
  if (rejected) return rejected;
  if (tooSmall && decodeAt(img, tooSmall, s).kind !== 'none') return { kind: 'rejected', reason: 'pitch_too_small', geometry: tooSmall };
  return { kind: 'none' };
}
