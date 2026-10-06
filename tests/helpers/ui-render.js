'use strict';
// A rough preview of addon frames, for looking at layout and spacing without the
// game: the test VM's frame tree (STUB.Dump, with STUB.metrics on) becomes an HTML
// page of absolutely placed boxes. Anchors are resolved as the game resolves
// them; the game's art is stood in for by shapes and glyphs, and its fonts by a
// serif at the same sizes. Good for alignment, rhythm and density; not for the
// look of the game's own textures. Used by tests/render_ui.js.

const POINTS = {
  TOPLEFT: [0, 0], TOP: [0.5, 0], TOPRIGHT: [1, 0],
  LEFT: [0, 0.5], CENTER: [0.5, 0.5], RIGHT: [1, 0.5],
  BOTTOMLEFT: [0, 1], BOTTOM: [0.5, 1], BOTTOMRIGHT: [1, 1],
};
const LAYERS = { BACKGROUND: 0, BORDER: 1, ARTWORK: 2, OVERLAY: 3, HIGHLIGHT: 4 };

// The game's art, stood in for.
const GLYPHS = [
  [/HumanSkull|BonesIcon/i, { glyph: '💀', bg: '#2a2622' }],
  [/INV_Misc_QuestionMark/i, { glyph: '?', color: '#ff3a2a', bg: '#3a1a14' }],
  [/MinimapArrow|Navigation-Tracked-Arrow/i, { arrow: true }],
  [/UI-RefreshButton/i, { glyph: '↻', color: '#ffd100' }],
  [/GossipGossipIcon|UI-ChatIcon-Chat-Up/i, { glyph: '💬' }],
  [/UI-ChatWhisperIcon/i, { glyph: '🗨' }],
  [/UI-ChatConversationIcon/i, { glyph: '👥' }],
  [/UI-ChatIcon-Maximize/i, { glyph: '⤢', color: '#ffd100' }],
  [/NextPage|ChatFrameExpandArrow/i, { glyph: '▶', color: '#ffd100' }],
  [/common-icon-rotateright/i, { glyph: '↻', color: '#ffd100' }],
  [/common-icon-undo/i, { glyph: '↶', color: '#ffd100' }],
  [/common-icon-yellowx/i, { glyph: '✕', color: '#ffd100' }],
  [/GroupLoot-Pass|redx|StopButton|ClearBroadcast|clearbutton|CancelButton/i, { glyph: '✕', color: '#ff4040' }],
  [/objective-nub|BulletPoint/i, { dot: '#ffd100' }],
  [/tracker-check/i, { glyph: '✓', color: '#1aff1a' }],
  [/RedButton-Condense|UI-Panel-SmallerButton|128-redbutton-minus/i, { button: '–' }],
  [/RedButton-Expand|UI-Panel-BiggerButton|128-redbutton-plus/i, { button: '+' }],
  [/128-redbutton-exit/i, { button: '✕' }],
  [/UI-Background-Rock/i, { fill: '#1d1915' }],
  [/Common-Input-Border-/i, { fill: '#080706' }], // its edge: the box's own outline (below)
  [/TempPortraitAlphaMask/i, { circle: true }],
  [/MiniMap-TrackingBorder/i, { ring: '#c9a24a' }], // its round part is the top-left 31 of 50
  [/StatusIcon-Online/i, { lamp: '#1aff1a' }],
  [/StatusIcon-Away/i, { lamp: '#ffd100' }],
  [/StatusIcon-DnD/i, { lamp: '#ff3030' }],
  [/StatusIcon-Offline/i, { lamp: '#8a8a8a' }],
  [/friendslist-categorybutton-arrow-down|Arrow-Down-Up/i, { glyph: '▾', color: '#ffd100' }],
  [/MouseHilight|roundhighlight|Highlight/i, { skip: true }],
];

// The addon's own art (Media/*.tga: Bones's faces, the app icon's glass skull), drawn with its real pixels as a
// PNG data URL: the TGA (32-bit, uncompressed) decoded and the PNG written here, once per file.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const MEDIA_DIR = path.join(__dirname, '..', '..', 'addon', 'NeverQuestAlone', 'Media');
const MEDIA_RE = /^Interface\\AddOns\\NeverQuestAlone\\Media\\([\w-]+)$/i;
const mediaCache = new Map();
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = b => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function mediaUrl(name) {
  if (mediaCache.has(name)) return mediaCache.get(name);
  let url = null;
  try {
    const b = fs.readFileSync(path.join(MEDIA_DIR, `${name}.tga`));
    const idLen = b[0], w = b.readUInt16LE(12), h = b.readUInt16LE(14), topDown = (b[17] & 0x20) !== 0;
    if (b[2] !== 2 || b[16] !== 32) throw new Error('not a 32-bit uncompressed TGA');
    const raw = Buffer.alloc(h * (w * 4 + 1));
    for (let y = 0; y < h; y++) {
      const src = 18 + idLen + (topDown ? y : h - 1 - y) * w * 4;
      for (let x = 0; x < w; x++) {
        const o = y * (w * 4 + 1) + 1 + x * 4, i = src + x * 4;
        raw[o] = b[i + 2]; raw[o + 1] = b[i + 1]; raw[o + 2] = b[i]; raw[o + 3] = b[i + 3];
      }
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
    url = `data:image/png;base64,${png.toString('base64')}`;
  } catch { url = null; }
  mediaCache.set(name, url);
  return url;
}

function art(node) {
  const key = String(node.atlas || node.texture || '');
  const media = MEDIA_RE.exec(key);
  if (media && mediaUrl(media[1])) return { image: mediaUrl(media[1]) };
  for (const [re, v] of GLYPHS) if (re.test(key)) return v;
  return key ? { label: key.split(/[\\/]/).pop() } : null;
}

const rgba = (c, a = 1) => c ? `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] ?? a})` : null;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// "|cffffd100Name|r: rest" → spans; other escapes dropped.
function richText(text) {
  let out = '', i = 0, open = 0;
  const s = String(text ?? '');
  while (i < s.length) {
    // || is one | in the game; two spaces stay two (HTML would fold them).
    if (s.startsWith('||', i)) { out += '|'; i += 2; continue; }
    if (s.startsWith('  ', i)) { out += ' &nbsp;'; i += 2; continue; }
    if (s.startsWith('|c', i) && /^\|c[0-9a-fA-F]{8}/.test(s.slice(i, i + 10))) {
      out += `<span style="color:#${s.slice(i + 4, i + 10)}">`; open++; i += 10; continue;
    }
    if (s.startsWith('|r', i)) { if (open) { out += '</span>'; open--; } i += 2; continue; }
    // A link (|H…|h[Name]|h) shows its [Name], as the game draws it.
    if (s.startsWith('|H', i)) { const e = s.indexOf('|h', i); i = e < 0 ? s.length : e + 2; continue; }
    if (s.startsWith('|h', i)) { i += 2; continue; }
    if (s.startsWith('|T', i)) { const e = s.indexOf('|t', i); i = e < 0 ? s.length : e + 2; out += '■'; continue; }
    // [UX-8] An atlas (|A:name:w:h|a): the ready check's marks as their glyphs, anything else a square.
    if (s.startsWith('|A:', i)) {
      const e = s.indexOf('|a', i);
      const name = s.slice(i + 3, e < 0 ? s.length : e);
      out += /ReadyMark/.test(name) ? '<span style="color:#1aff1a">✓</span>' : /PendingMark/.test(name) ? '<span style="color:#9d9d9d">○</span>' : '■';
      i = e < 0 ? s.length : e + 2; continue;
    }
    if (s[i] === '\n') { out += '<br>'; i++; continue; }
    out += esc(s[i]); i++;
  }
  return out + '</span>'.repeat(open);
}

function defaultColor(node) {
  const f = String(node.font || '');
  if (/Normal/.test(f)) return [1, 0.82, 0];
  if (/Disable/.test(f)) return [0.5, 0.5, 0.5];
  return [1, 1, 1];
}

// Lua's empty tables come back as {} rather than [].
const list = v => (Array.isArray(v) ? v : Object.values(v || {}));
function normalize(n) {
  n.children = list(n.children).map(normalize);
  n.points = list(n.points);
  return n;
}

function layout(tree) {
  normalize(tree);
  const byId = new Map();
  const parentOf = new Map();
  (function index(n, parent) {
    byId.set(n.id, n);
    if (parent) parentOf.set(n.id, parent);
    for (const c of n.children || []) index(c, n);
  })(tree, null);
  const rects = new Map();
  rects.set(tree.id, { l: 0, t: 0, w: tree.w || 300, h: tree.h || 100 });
  const resolving = new Set();

  function sizeOf(n) {
    let w = n.w, h = n.h;
    if (n.kind === 'FontString') { w = w ?? n.sw; h = n.sh; }
    return { w: w || 0, h: h || 0 };
  }
  function rectOf(n) {
    if (rects.has(n.id)) return rects.get(n.id);
    if (resolving.has(n.id)) return { l: 0, t: 0, w: 0, h: 0 };
    resolving.add(n.id);
    const parent = parentOf.get(n.id);
    const pr = parent ? rectOf(parent) : { l: 0, t: 0, w: 0, h: 0 };
    const size = sizeOf(n);
    const pts = n.points || [];
    // Where each anchor point lands, in page coordinates (y down).
    const at = {};
    for (const p of pts) {
      const rel = p.rel != null && byId.has(p.rel) ? rectOf(byId.get(p.rel)) : pr;
      const [fx, fy] = POINTS[p.relPoint] || POINTS[p.point];
      at[p.point] = { x: rel.l + fx * rel.w + (p.x || 0), y: rel.t + fy * rel.h - (p.y || 0) };
    }
    let l, t, w = size.w, h = size.h;
    const xs = Object.entries(at).map(([k, v]) => ({ fx: POINTS[k][0], fy: POINTS[k][1], ...v }));
    if (!xs.length) { l = pr.l; t = pr.t; w = w || pr.w; h = h || pr.h; }
    else {
      const left = xs.find(a => a.fx === 0), right = xs.find(a => a.fx === 1);
      const top = xs.find(a => a.fy === 0), bottom = xs.find(a => a.fy === 1);
      if (left && right && right.x > left.x) { w = right.x - left.x; l = left.x; }
      else { const a = xs[0]; l = a.x - a.fx * w; }
      if (top && bottom && bottom.y > top.y) { h = bottom.y - top.y; t = top.y; }
      else { const a = xs.find(p => p.fy !== undefined) || xs[0]; t = a.y - a.fy * h; }
    }
    const r = { l, t, w, h };
    rects.set(n.id, r);
    resolving.delete(n.id);
    return r;
  }
  for (const id of byId.keys()) rectOf(byId.get(id));
  return { byId, rects, parentOf };
}

function visible(n, parentOf, byId) {
  for (let x = n; x; x = parentOf.get(x.id)) if (x.shown === false) return false;
  return true;
}
function alphaOf(n, parentOf) {
  let a = 1;
  for (let x = n; x; x = parentOf.get(x.id)) a *= (x.alpha ?? 1);
  return a;
}

// clip: what a ScrollFrame holds is cut at its top and bottom edges, as the game cuts it (a
// window narrower than its words showed bubbles spilling over the composer), at the scroll the addon
// set (vscroll, where the caller gave the stub a scroll range); scrollEnd: the names of the ScrollFrames
// shown at their end when it set none (the stub's range is 0 unless the caller gives one).
function scrollClips(byId, rects, parentOf, scrollEnd) {
  const frames = new Map();
  for (const n of byId.values()) {
    if (n.kind !== 'ScrollFrame') continue;
    const rs = rects.get(n.id);
    const child = (n.children || []).find(c => c.kind === 'Frame' && !(c.points || []).length);
    const offset = n.vscroll > 0 ? n.vscroll : scrollEnd.includes(n.name) && child && child.h ? Math.max(0, child.h - rs.h) : 0;
    frames.set(n.id, { rs, offset });
  }
  return n => {
    for (let x = parentOf.get(n.id); x; x = parentOf.get(x.id)) if (frames.has(x.id)) return frames.get(x.id);
    return null;
  };
}

// wrap: a string the game wraps breaks where the addon measured it (the test VM's metrics: each
// word's bytes x 0.52 of its size, colour and texture escapes dropped), not where the browser's
// stand-in font would, cut at its line cap with "…" as the game cuts it. The preview then shows the
// addon's own lines (a status line it measured as two showed as one).
function plainBytes(t) {
  const plain = String(t).replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '').replace(/\|T.*?\|t/g, '  ').replace(/\|A.*?\|a/g, '  ')
    .replace(/\|H.*?\|h/g, '').replace(/\|h/g, '') // a link shows its [name]
    .replace(/[…•–—]/g, '.');
  return Buffer.byteLength(plain, 'utf8');
}
function wrapLikeTheMetrics(text, width, size, maxLines) {
  const out = [];
  for (const whole of String(text).split('\n')) {
    // A line's own indent (a help line's words under its command) stays, as the game draws it; the
    // metrics count words only (STUB's GetStringHeight), so it takes no width here either.
    const indent = /^ */.exec(whole)[0], para = whole.slice(indent.length);
    let line = indent, lineW = 0;
    for (const word of para.split(' ')) {
      const ww = (plainBytes(word) + 1) * size * 0.52;
      if (line.trim() !== '' && plainBytes(word) > 0 && lineW + ww > width) { out.push(line); line = word; lineW = ww; }
      else { line = line.trim() === '' ? line + word : `${line} ${word}`; lineW += ww; }
    }
    out.push(line);
  }
  if (maxLines > 0 && out.length > maxLines) return [...out.slice(0, maxLines - 1), `${out[maxLines - 1]}…`].join('\n');
  return out.join('\n');
}

// One frame tree as HTML (a fragment, positioned at ox, oy).
function renderTree(tree, { ox = 0, oy = 0, scale = 2, clip = false, scrollEnd = [], wrap = false } = {}) {
  const { byId, rects, parentOf } = layout(tree);
  if (wrap) {
    for (const n of byId.values()) {
      if (n.kind === 'FontString' && n.text && n.w > 0 && n.wordWrap !== false) n.text = wrapLikeTheMetrics(n.text, n.w, n.fontSize || 12, n.maxLines || 0);
    }
  }
  const scrollOf = clip ? scrollClips(byId, rects, parentOf, scrollEnd) : () => null;
  const items = [];
  let order = 0;
  for (const n of byId.values()) {
    if (!visible(n, parentOf, byId)) continue;
    let r = rects.get(n.id);
    if (!r || (r.w <= 0 && r.h <= 0 && n.kind !== 'FontString')) continue;
    const sc = scrollOf(n);
    let cut = null;
    if (sc) {
      r = { ...r, t: r.t - sc.offset };
      const top = Math.max(0, sc.rs.t - r.t), bottom = Math.max(0, r.t + r.h - (sc.rs.t + sc.rs.h));
      if (top + bottom >= r.h && r.h > 0) continue; // all of it scrolled out of view
      if (top || bottom) cut = `clip-path:inset(${top * scale}px 0 ${bottom * scale}px 0)`;
    }
    const depth = (() => { let d = 0; for (let x = n; x; x = parentOf.get(x.id)) d++; return d; })();
    const z = (n.level || depth) * 100 + (LAYERS[n.layer] ?? (n.kind === 'FontString' ? 3 : 2)) * 10 + ((n.sublevel || 0) + 8) / 2;
    const style = [`left:${(r.l + ox) * scale}px`, `top:${(r.t + oy) * scale}px`, `width:${r.w * scale}px`, `height:${r.h * scale}px`,
      `z-index:${Math.round(z)}`, `opacity:${alphaOf(n, parentOf)}`];
    let inner = '', cls = n.kind;
    if (n.kind === 'FontString') {
      const size = (n.fontSize || 12) * scale;
      const color = rgba(n.textColor || defaultColor(n));
      style.push(`font-size:${size}px`, `line-height:${Math.round((n.fontSize || 12) * 1.2) * scale}px`, `color:${color}`,
        `text-align:${(n.justifyH || 'LEFT').toLowerCase()}`,
        // SetWordWrap(false) with a width: one line, cut with "..." as the game does.
        n.wordWrap === false ? 'white-space:nowrap;text-overflow:ellipsis' : (n.w || (n.points || []).length > 1 ? 'white-space:normal' : 'white-space:nowrap'),
        'overflow:hidden');
      if (!n.w && (n.points || []).length <= 1) {
        // One anchor and no width: the text's own width, held at its anchor's side
        // (the preview's serif runs narrower or wider than the game's font).
        style[2] = `width:auto`;
        const pt = String(n.points?.[0]?.point || 'TOPLEFT');
        if (/RIGHT$/.test(pt)) style[0] = `left:${(r.l + r.w + ox) * scale}px;transform:translateX(-100%)`;
        else if (/^(TOP|BOTTOM|CENTER)$/.test(pt)) style[0] = `left:${(r.l + r.w / 2 + ox) * scale}px;transform:translateX(-50%)`;
        style.push('white-space:nowrap');
      }
      inner = richText(n.text);
    } else if (n.kind === 'Texture' || n.kind === 'Line') {
      if (n.layer === 'HIGHLIGHT') continue;
      const a = art(n);
      if (a && a.skip) continue;
      if (n.color) style.push(`background:${rgba(n.color)}`);
      else if (a && a.fill) style.push(`background:${a.fill}`);
      else if (a && a.circle) style.push(`border-radius:50%`, `background:${rgba(n.vcolor || [1, 1, 1, 1])}`);
      else if (a && a.ring) {
        style[2] = `width:${r.w * 0.62 * scale}px`; style[3] = `height:${r.h * 0.62 * scale}px`;
        style.push(`border-radius:50%;border:${2 * scale}px solid ${a.ring};box-sizing:border-box`);
      }
      else if (a && a.lamp) style.push(`display:flex;align-items:center;justify-content:center`) && (inner = `<div style="width:60%;height:60%;border-radius:50%;background:${a.lamp};box-shadow:0 0 ${2 * scale}px ${a.lamp}"></div>`);
      else if (a && a.dot) style.push(`display:flex;align-items:center;justify-content:center`) && (inner = `<div style="width:${3 * scale}px;height:${3 * scale}px;border-radius:50%;background:${a.dot}"></div>`);
      else if (a && a.arrow) {
        // MinimapArrow as the game draws it: a silver arrowhead with a dark blue
        // gem at its base, in the middle of its 32-pixel square (about 15 wide
        // and 20 tall), its colours times the vertex colour.
        const rot = -(n.rotation || 0);
        const v = n.vcolor || [1, 1, 1, 1];
        const tint = (r, g, b) => rgba([r * v[0], g * v[1], b * v[2], 1]);
        inner = `<svg viewBox="0 0 32 32" width="100%" height="100%" style="transform:rotate(${rot}rad)">`
          + `<polygon points="15.5,6 8,20.5 11.5,24.5 15.5,25.8 19.5,24.5 23,20.5" fill="#111" stroke="#111" stroke-width="1.2" stroke-linejoin="round"/>`
          + `<polygon points="15.5,6.8 8.8,20.3 15.5,18.6" fill="${tint(0.54, 0.54, 0.58)}"/>`
          + `<polygon points="15.5,6.8 22.2,20.3 15.5,18.6" fill="${tint(0.72, 0.72, 0.76)}"/>`
          + `<line x1="15.5" y1="7.6" x2="15.5" y2="16.6" stroke="${tint(0.93, 0.93, 0.95)}" stroke-width="0.9"/>`
          + `<circle cx="15.5" cy="20.6" r="3.9" fill="${tint(0.06, 0.08, 0.2)}" stroke="${tint(0.6, 0.63, 0.72)}" stroke-width="0.9"/>`
          + `<circle cx="14.4" cy="19.5" r="0.9" fill="${tint(0.35, 0.42, 0.62)}"/></svg>`;
      } else if (a && a.image) {
        // SetTexCoord's crop (left, right, top, bottom), as the game draws it.
        const [L, R, T, B] = n.texCoord ? list(n.texCoord) : [0, 1, 0, 1];
        const bw = r.w * scale / (R - L), bh = r.h * scale / (B - T);
        style.push(`background:url(${a.image}) ${-L * bw}px ${-T * bh}px / ${bw}px ${bh}px no-repeat`);
      } else if (a && a.glyph) {
        style.push(`display:flex;align-items:center;justify-content:center`, `font-size:${Math.max(8, r.h * 0.8) * scale}px`, `color:${a.color || '#fff'}`);
        if (a.bg) style.push(`background:${a.bg}`);
        inner = a.glyph;
      } else if (a && a.button) {
        style.push(`background:#8a1010;border:${scale}px solid #d8a93a;border-radius:${2 * scale}px;color:#ffd100;display:flex;align-items:center;justify-content:center;font-size:${r.h * 0.7 * scale}px;box-sizing:border-box`);
        inner = a.button;
      } else if (a && a.label) {
        style.push(`border:1px dashed #888;color:#aaa;font-size:${8 * scale}px;overflow:hidden`);
        inner = esc(a.label);
      } else continue;
      cls = 'Texture';
    } else {
      // Frames: templates and backdrops the stub doesn't build.
      const tpl = String(n.template || '');
      if (/TooltipBackdropTemplate/.test(tpl) && n === tree) {
        // The game's tooltip frame, in the HUD's colours: a dark centre, a thin gold edge.
        style.push(`background:rgba(20,18,15,0.94);border:${1.5 * scale}px solid #c79f4d;border-radius:${3 * scale}px;box-sizing:border-box`);
      } else if (/ButtonFrameTemplate|PortraitFrameTemplate/.test(tpl) && n === tree) {
        style.push(`background:#15120e;border:${3 * scale}px solid #8a6a34;box-sizing:border-box`);
        inner = `<div style="position:absolute;left:0;right:0;top:0;height:${21 * scale}px;background:#2b2217;border-bottom:${scale}px solid #6b5228"></div>`;
        if (n.portrait) {
          // The portrait slot: PortraitFrameTemplate's 62 at (-5, +7), or what SetPortraitTextureSizeAndOffset set (a bag's 36 at -4, +1).
          const [size, px, py] = n.portraitSize ? list(n.portraitSize) : [62, -5, 7];
          const ring = Math.max(2, Math.round(size / 20));
          // Bones's own round portrait where it's the addon's art, cropped as U.SetRoundFace crops it in both
          // slots (0.12 to 0.88 across, 0.10 to 0.86 down: 0.76 of the art, from 50% and 41.67% of the slack),
          // else the old stand-in.
          const m = MEDIA_RE.exec(String(n.portrait)), img = m && mediaUrl(m[1]);
          const face = img ? `background:url(${img}) 50% 41.667% / ${100 / 0.76}% no-repeat` : 'background:#2a2622';
          inner += `<div style="position:absolute;left:${px * scale}px;top:${-py * scale}px;width:${size * scale}px;height:${size * scale}px;border-radius:50%;${face};border:${ring * scale}px solid #c9a24a;box-sizing:border-box;display:flex;align-items:center;justify-content:center;font-size:${size * 0.55 * scale}px;z-index:9999">${img ? '' : '💀'}</div>`;
        }
      } else if (/UIPanelButtonTemplate/.test(tpl) || (n.kind === 'Button' && n.text && !n.children?.length)) {
        // Disabled, the game greys the red button and its label.
        const [bg, fg] = n.disabled ? ['linear-gradient(#5a4a4a,#3a3030)', '#8a8a8a'] : ['linear-gradient(#a01818,#6a0a0a)', '#ffd100'];
        style.push(`background:${bg};border:${scale}px solid #c9a24a;border-radius:${3 * scale}px;color:${fg};display:flex;align-items:center;justify-content:center;font-size:${12 * scale}px;box-sizing:border-box`);
        inner = esc(n.text || '');
      } else if ((n.children || []).some(c => /Common-Input-Border/.test(String(c.texture || '')))) {
        style.push(`border:${scale}px solid #6b5a3a;border-radius:${2 * scale}px;box-sizing:border-box`);
        style.push('z-index:99999');
      } else if (/InputBox/.test(tpl)) {
        style.push(`background:#0b0a08;border:${scale}px solid #6b5228;box-sizing:border-box;color:#9d9d9d;font-size:${11 * scale}px;display:flex;align-items:center;padding-left:${6 * scale}px`);
        inner = esc(n.text || '');
      } else if (/UICheckButtonTemplate/.test(tpl)) {
        // The game's tick box: a dark square with a gold edge, a tick when checked.
        const inset = 3 * scale;
        style.push(`display:flex;align-items:center;justify-content:center;color:#ffd100;font-size:${r.h * 0.7 * scale}px`);
        inner = `<div style="position:absolute;left:${inset}px;top:${inset}px;right:${inset}px;bottom:${inset}px;background:#0b0a08;border:${scale}px solid #8a6a34;border-radius:${2 * scale}px;opacity:${n.disabled ? 0.5 : 1}"></div><span style="position:relative">${n.checked ? '✓' : ''}</span>`;
      } else if (/UIPanelCloseButton|UIPanelHideButton/.test(tpl)) {
        // The game's red corner buttons: the close X, and the hide (minimize) bar.
        const glyph = /Hide/.test(tpl) ? '–' : '✕';
        style.push(`background:#8a1010;border:${scale}px solid #d8a93a;border-radius:${3 * scale}px;color:#ffd100;display:flex;align-items:center;justify-content:center;font-size:${r.h * 0.6 * scale}px;box-sizing:border-box`);
        inner = glyph;
      } else if (/InsetFrameTemplate/.test(tpl)) {
        style.push(`background:#0c0a08;border:${scale}px solid #3f3020;box-sizing:border-box`);
      } else if (n.normalArt && art({ texture: n.normalArt })?.button) {
        style.push(`background:#8a1010;border:${scale}px solid #d8a93a;border-radius:${2 * scale}px;color:#ffd100;display:flex;align-items:center;justify-content:center;font-size:${r.h * 0.7 * scale}px;box-sizing:border-box`);
        inner = art({ texture: n.normalArt }).button;
      } else if (n.backdrop) {
        style.push(`background:#1d1915;border:${2 * scale}px solid #c79f40;border-radius:${3 * scale}px;box-sizing:border-box`);
      } else continue;
    }
    if (cut) style.push(cut);
    items.push({ z: order++, html: `<div class="${cls}" style="position:absolute;${style.join(';')}">${inner}</div>` });
  }
  return items.map(i => i.html).join('\n');
}

function page(title, panels, { scale = 2, bg = '#3b4a3a' } = {}) {
  const body = panels.map(p => `<figure style="position:relative;display:inline-block;vertical-align:top;margin:${20 * scale}px;width:${p.w * scale}px;height:${p.h * scale}px">
<figcaption style="position:absolute;top:${-16 * scale}px;left:0;color:#ddd;font:${10 * scale}px sans-serif;white-space:nowrap">${esc(p.caption)}</figcaption>
${p.html}</figure>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{margin:0;padding:${20 * scale}px;background:${bg};font-family:"Friz Quadrata TT","Palatino Linotype",Georgia,serif}figure div{box-sizing:border-box}</style></head>
<body>${body}</body></html>`;
}

module.exports = { layout, renderTree, page };
