// Slot files are executed Lua, so this encoder is the barrier between agent
// text and the game (PRD §11, TB3). Strings become double-quoted Lua literals
// with every quote, backslash and control byte escaped; nothing else is ever
// written unquoted except numbers, booleans and identifier keys we choose.
//
// slotTable() also applies the slot budget (docs/PROTOCOL.md §4.1): at most
// 64 KB per file; records at most 40 KB (oldest reply bodies are replaced by
// their summary plus `more = <length>`, records are never dropped), and while
// the map rides, at most what it leaves them (DREW-SY-04: the bridge keeps the
// map within 40 KB, map.mjs MAP_BYTES_MAX, so the records keep 16 KB or more);
// the map only when it fits.

export const SLOT_BYTES_MAX = 65536;
export const HEAD_BYTES_MAX = 8192;
export const RECORD_BYTES_MAX = 40960;

/** A Lua string literal. Lone surrogates become U+FFFD first (the file is UTF-8). */
export function luaStr(s) {
  const t = String(s ?? '').toWellFormed();
  return '"' + t
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, c => '\\' + String(c.charCodeAt(0)).padStart(3, '0'))
    + '"';
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LUA_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while']);

function luaKey(k) {
  return IDENT.test(k) && !LUA_KEYWORDS.has(k) ? k : `[${luaStr(k)}]`;
}

/** Any JSON-like value as a Lua expression. undefined and null fields are left out. */
export function luaValue(v) {
  if (v === null || v === undefined) return 'nil';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '0';
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  }
  if (typeof v === 'string') return luaStr(v);
  if (Array.isArray(v)) return '{ ' + v.filter(x => x !== undefined && x !== null).map(luaValue).join(', ') + ' }';
  if (typeof v === 'object') {
    const parts = [];
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || x === null) continue;
      parts.push(`${luaKey(k)} = ${luaValue(x)}`);
    }
    return '{ ' + parts.join(', ') + ' }';
  }
  return 'nil';
}

const bytes = s => Buffer.byteLength(s, 'utf8');

/**
 * Fit records into `max` bytes of Lua. Oldest reply bodies go first: replaced
 * by their summary (or an empty text) with `more` set to what was left out.
 * Returns { records (copies), lua: [lines], trimmed: <count> }.
 */
export function fitRecords(records, max = RECORD_BYTES_MAX) {
  const out = records.map(r => ({ ...r }));
  const line = r => `\t\t${luaValue(r)},`;
  let lines = out.map(line);
  let total = lines.reduce((a, l) => a + bytes(l) + 1, 0);
  let trimmed = 0;
  for (let i = 0; i < out.length && total > max; i++) {
    const r = out[i];
    if (r.t !== 'reply' && r.t !== 'msg') continue;
    const len = String(r.text || '').length;
    if (!len) continue;
    r.more = (r.more || 0) + len;
    r.text = r.summary ? String(r.summary) : '';
    const l = line(r);
    total += bytes(l) - bytes(lines[i]);
    lines[i] = l;
    trimmed++;
  }
  return { records: out, lua: lines, trimmed };
}

/**
 * The whole slot file. slot: { v, ts, now, token, bridge, gw, agents, chats,
 * rt?, records, map? }. Returns { text, bytes, trimmed, mapIncluded }.
 */
export function slotTable(globalName, slot, { includeMap = false, maxBytes = SLOT_BYTES_MAX, recordBytes = RECORD_BYTES_MAX } = {}) {
  const head = [
    '-- Written by the NeverQuestAlone app. Do not edit.',
    `${globalName} = {`,
    `\tv = 2, ts = ${luaStr(slot.ts)}, now = ${luaValue(slot.now)}, token = ${luaStr(slot.token || '')},`,
    `\tbridge = ${luaValue(slot.bridge || {})},`,
    `\tgw = ${luaValue(slot.gw || {})},`,
    `\tagents = ${luaValue(slot.agents || [])},`,
    `\tchats = ${luaValue(slot.chats || [])},`,
  ];
  // The backend's own state beside gw (BYOK rt: ready, no_key, slowed…; the addon reads data.rt).
  if (slot.rt && typeof slot.rt === 'object') head.push(`\trt = ${luaValue(slot.rt)},`);
  let headText = head.join('\n');
  if (bytes(headText) > HEAD_BYTES_MAX) {
    // Progress titles are the largest free text in the chat snapshot.
    let chats = (slot.chats || []).map(c => (c.run ? { ...c, run: { ...c.run, last: String(c.run.last || '').slice(0, 60) } } : c));
    head[6] = `\tchats = ${luaValue(chats)},`;
    headText = head.join('\n');
    // Then a chat's own model's display name (BYOK chats[].modelName): the addon shows its id instead.
    if (bytes(headText) > HEAD_BYTES_MAX) {
      chats = chats.map(({ modelName: _name, ...c }) => c);
      head[6] = `\tchats = ${luaValue(chats)},`;
      headText = head.join('\n');
    }
  }
  const mapLine = includeMap && slot.map ? `\tmap = ${luaValue(slot.map)},` : null;
  // While the map rides, the records take what it leaves: the oldest reply bodies are cut to their
  // summary before the map is left out (the file's newlines, braces and final "}" are the 64).
  const recordMax = mapLine ? Math.max(0, Math.min(recordBytes, maxBytes - bytes(headText) - bytes(mapLine) - 64)) : recordBytes;
  const fit = fitRecords(slot.records || [], recordMax);
  const body = ['\trecords = {', ...fit.lua, '\t},'].join('\n');
  let text = headText + '\n' + body;
  let mapIncluded = false;
  if (mapLine && bytes(text) + bytes(mapLine) + 4 <= maxBytes) {
    text += '\n' + mapLine;
    mapIncluded = true;
  }
  text += '\n}\n';
  return { text, bytes: bytes(text), trimmed: fit.trimmed, mapIncluded };
}
