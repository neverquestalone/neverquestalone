// Map layers (RC-7, upstream's MAP.md). The bridge owns the layers in its
// state; the slot file carries them in the shape the addon's Map.lua reads:
//   map = { epoch, version, layers = { { name, title, ordered, loop, points = { { m, x, y, label, kind[, note[, q]] }, … } } } }
// A point's note (what to do there) and q (quest ids) are positional: note is ""
// when only q is set, and both are left off when neither is.
import { luaValue } from '../transport/luaenc.mjs';
import { validateMapCommand, MAP_LIMITS } from './map-protocol.mjs';

// The map's share of a slot file (DREW-SY-04). A slot carries the map only when the whole file fits
// its 64 KB (luaenc.mjs SLOT_BYTES_MAX), so a map inside the prompt's own limits (1,500 points, 12
// layers: 60 KB to 120 KB of Lua) never reached the game, with no word, and a reply's drew named a
// route the addon didn't have. The bridge keeps the map within MAP_BYTES_MAX: 64 KB less the slot
// header's 8 KB and 16 KB for records, which while the map rides get what the map leaves them
// (luaenc.mjs slotTable). About 800 points with short labels; fewer with long labels and notes.
export const MAP_BYTES_MAX = 40 * 1024;

export { newMap, applyMapCommands } from './map-protocol.mjs';

// The layers a reply drew: its valid "set" commands whose layer is still on the
// map after it (a later clear in the same reply, or the budget, can take one
// off), in the order it drew them; null for none. The reply record carries
// them as `drew`, so the game's Okay on that reply follows what it drew.
export function drawnLayers(map, cmds) {
  const out = [];
  for (const raw of cmds || []) {
    const c = validateMapCommand(raw, []);
    if (c && c.op === 'set' && Object.hasOwn(map.layers || {}, c.layer) && !out.includes(c.layer)) out.push(c.layer);
  }
  return out.length ? out.slice(0, MAP_LIMITS.layers) : null;
}

/** The map's line in a slot file, in bytes. */
export function mapBytes(map) {
  return Buffer.byteLength(`\tmap = ${luaValue(toSlotMap(map))},`);
}

/**
 * Keep the map within max bytes of slot file (MAP_BYTES_MAX): the oldest layers go first (layers set
 * by one reply, the first it set first), never the newest; if that one alone is still over, its
 * stops' notes go, then its last stops. Returns {changed, dropped: [{name, title}], notes: name|null,
 * stops: {name, title, kept, of}|null}; a change bumps the map's version.
 */
export function fitMapBytes(map, max = MAP_BYTES_MAX) {
  const out = { changed: false, dropped: [], notes: null, stops: null };
  const layers = map?.layers;
  if (!layers || mapBytes(map) <= max) return out;
  const oldestFirst = () => Object.keys(layers).sort((a, b) => (layers[a].t || 0) - (layers[b].t || 0));
  while (Object.keys(layers).length > 1 && mapBytes(map) > max) {
    const name = oldestFirst()[0];
    out.dropped.push({ name, title: layers[name].title || '' });
    delete layers[name];
    out.changed = true;
  }
  const [name] = oldestFirst();
  const l = name && layers[name];
  if (l && mapBytes(map) > max && l.points.some(p => p.note)) {
    for (const p of l.points) delete p.note;
    out.notes = name;
    out.changed = true;
  }
  if (l && mapBytes(map) > max) {
    // The most stops from the start that fit (at least one).
    const all = l.points;
    let lo = 1, hi = all.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      l.points = all.slice(0, mid);
      if (mapBytes(map) <= max) lo = mid; else hi = mid - 1;
    }
    l.points = all.slice(0, lo);
    out.stops = { name, title: l.title || '', kept: lo, of: all.length };
    out.changed = true;
  }
  if (out.changed) map.version = (map.version || 0) + 1;
  return out;
}

export function toSlotMap(map) {
  if (!map) return null;
  return {
    epoch: map.epoch,
    version: map.version || 0,
    layers: Object.entries(map.layers || {}).map(([name, l]) => ({
      name, title: l.title, ordered: !!l.ordered, loop: !!l.loop,
      points: (l.points || []).map(p => {
        const out = [p.m, p.x, p.y, p.label, p.kind];
        if (p.note || p.q) out.push(p.note || '');
        if (p.q) out.push(p.q);
        return out;
      }),
    })),
  };
}

/**
 * The route the map shows now, for the desktop's Home (CL-design-41): the newest ordered layer's
 * title, its first stop's label (the next stop as drawn) and how many stops it has; null with none.
 * The words come from the map, already cleaned when the layer was set (map-protocol.mjs cleanText).
 */
export function routeNow(map) {
  const layers = map?.layers;
  if (!layers) return null;
  let best = null;
  for (const l of Object.values(layers)) {
    if (!l?.ordered || !Array.isArray(l.points) || !l.points.length) continue;
    if (!best || (l.t || 0) >= (best.t || 0)) best = l;
  }
  if (!best) return null;
  const next = String(best.points[0]?.label || '').trim();
  return next ? { title: String(best.title || ''), next, stops: best.points.length, at: best.t || null } : null;
}
