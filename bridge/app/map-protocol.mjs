// The map's command protocol and a reply's summary (code health BR-24): the live half of upstream
// wow-ai's bridge/protocol.js, whose other half (strip jobs, agent prompts, its own Lua writer)
// served only the coding-agent bridge this repo no longer has. Pure: no I/O, no state of its own.
//
//   splitSummary(text)              the game chat's TL;DR and the whole reply (render.mjs)
//   extractMapBlocks(text)          the ```wowmap blocks a reply draws with, taken out of its text
//   validateMapCommand(c, why)      one command, sanitized, or null with the reason in why
//   newMap(epoch), applyMapCommands(map, cmds, now)
//                                   the layers the core keeps (app/map.mjs), versioned, in budget
//   dropDistanceClaims(note)        a stop's note without how far or how close the stop is
// MAP_KINDS, MAP_LIMITS, DISTANCE_CLAIMS and the claims' word sets are exported for the prompt
// (tools/gen-prompts.mjs) and Copy and Paste's generated twin in Paste.lua (tests/helpers/paste-lua.mjs).

// Pull the game-chat summary out of a reply: whatever follows the last "TL;DR:"
// marker that starts a line (bold or a heading around it is tolerated:
// "**TL;DR:**", "## TL;DR"). The text for the window stays the whole reply, so
// nothing the model wrote is lost; without a marker the summary is empty
// (render.mjs then takes the reply's first sentence).
const MARKER_RE = /(?:^|\n)[ \t]*(?:#+[ \t]*)?(?:\*\*|__)?[ \t]*TL;?DR[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*:?[ \t]*/gi;
export function splitSummary(text) {
  const full = String(text || '').trim();
  const last = [...full.matchAll(MARKER_RE)].pop();
  const summary = last ? full.slice(last.index + last[0].length).trim() : '';
  return { text: full, summary };
}

// ---------------------------------------------------------------------------
// Map layers
// ---------------------------------------------------------------------------
//
// A reply marks the in-game map with a ```wowmap fenced block of commands (the prompt pack says
// how). The core owns the resulting layers (its state) and ships the whole set, versioned, in the
// slot files; the addon replaces its copy when the version is newer. So a mark is never applied
// twice, and a client that lost its saved data gets everything back on its next hello.
//
//   {"op":"set","layer":"mining","title":"Copper loop","ordered":true,"loop":true,
//    "points":[{"m":1432,"x":41.5,"y":47.8,"label":"1. Copper Vein","kind":"ore"}]}
//   {"op":"clear","layer":"mining"}    {"op":"clearall"}

export const MAP_KINDS = new Set(['ore', 'herb', 'quest', 'turnin', 'kill', 'loot', 'object', 'explore', 'npc', 'trainer', 'vendor', 'dungeon', 'flight', 'poi']);
// NeverQuestAlone: a point may also carry `note` (what to do at the stop) and `q` (quest
// ids whose progress the addon shows); notes are budgeted so maps stay small
// enough for the slot files.
export const MAP_LIMITS = { layers: 12, pointsPerLayer: 400, totalPoints: 1500, label: 80, title: 80, note: 200, quests: 6, layerNotes: 6000, mapNotes: 16000, layerName: 32, mapIdMax: 99999 };

function cleanText(s, max) {
  return String(s ?? '').replace(/[\x00-\x1f\x7f|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// A stop's note says what to do there; the HUD shows the stop's live distance above it. A note
// that says how far or how close the stop is ("Closest stop, a few steps from you.") was true when
// the route was planned and goes stale as the player moves, so it contradicts the live line.
// dropDistanceClaims takes such claims out of a note, by the list below, and never an instruction:
// in a clause that makes one, only the claim's own words go (the matched words, a trailing "away"
// or "ahead", a leading "just", "right", "a" and the like, and an "is" or "it's" left hanging at
// the clause's edge), and the clause goes whole only when nothing else is left in it but stop
// words. "Kill 8 boars 20yd away, then rest." keeps "Kill 8 boars, then rest."; "Closest stop, a
// few steps from you. Hand in the head." keeps "Hand in the head.". A note with no claim comes back
// unchanged, and one with nothing else comes back empty (the stop then has no note). Place names,
// landmarks and compass directions stay: a clause with a compass point in it ("west of the
// Crossroads", "50 yards north") is never touched, unless the point is of the player ("west of
// you"). Paste.lua's P.DropDistanceClaims is the same rule for Copy and Paste, with the same list;
// tests/paste_test.mjs and tests/lua51_runtime_test.mjs hold them to the same answers.
//
// Each entry is words in order, matched whole after a clause is lowercased and cut to letters,
// digits and apostrophes: a/b is either word, a trailing ? makes a word optional, # is a number
// and #yd a number run into its unit ("175yd"); a leading ^ ties the entry to the clause's start
// and a trailing $ to its end; a trailing ~ marks a distance that stays when the clause says what
// it's measured from ("a few steps from the inn", "just ahead of the bridge").
export const DISTANCE_CLAIMS = [
  // Where the player is, and what's beside them.
  'from you', 'from here', 'near you', 'next to you', 'beside you', 'behind you', 'in front of you', 'ahead of you',
  'north/south/east/west/northeast/northwest/southeast/southwest/left/right of you', 'of you', 'right by you',
  'close/closer/closest/nearer/nearest to you', 'where you are', 'where you stand', "you're standing", 'you are standing',
  'right here', "it's/he's/she's/they're/that's right/just/very/really/so? nearby",
  "it's/he's/she's/they're/that's right/just/very/really/so? close$",
  // Which stop is the nearest.
  'closest/nearest stop/stops/one/ones/first/quest/quests/turn/pickup/objective/objectives/point/spot', 'closest/nearest$',
  // How far it is.
  'few steps~', 'few yards~', 'a/one step away~', 'steps away~', 'short walk/run/ride~', "stone's throw~",
  'just ahead~', 'around the corner~', '# yd/yds/yard/yards~', '#yd~', 'close by$', '^nearby$',
];
// After a ~ distance, these words with a place after them (not you, your, here or where) say what
// it's measured from.
export const MEASURED_FROM = new Set(['of', 'from', 'past', 'beyond', 'behind', 'beside', 'along', 'across', 'toward', 'towards', 'by', 'near']);
export const SELF_WORDS = new Set(['you', 'your', 'here', 'where']);
export const COMPASS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'northern', 'southern', 'eastern', 'western']);
// A claim's own words around what the list matched: after it, and before it.
export const CLAIM_AFTER = new Set(['away', 'ahead']);
export const CLAIM_BEFORE = new Set(['just', 'right', 'a', 'an', 'the', 'only', 'about', 'roughly', 'very', 'so', 'really']);
// Words left hanging at a clause's edge once a claim there is gone ("Hezrul is", "it's").
export const HANGING = new Set([...CLAIM_BEFORE, 'is', 'are', 'was', 'were', 'it', "it's", "he's", "she's", "they're", "that's", "there's",
  'that', 'which', 'who', 'and', 'or', 'but']);
// What isn't an instruction: stop words and the claims' own vocabulary (numbers neither).
export const NOT_CONTENT = new Set([...HANGING, 'then', 'if', 'be', 'its', 'he', 'she', 'they', 'them', 'him', 'her', 'his', 'their',
  'this', 'these', 'those', 'there', 'here', 'you', 'your', "you're", 'yours', 'i', "i'm", 'we', "we're", 'us', 'me', 'my',
  'to', 'of', 'from', 'by', 'at', 'in', 'on', 'for', 'with', 'up', 'down', 'over', 'into', 'onto', 'quite', 'pretty', 'also',
  'already', 'still', 'now', 'first', 'one', 'ones', 'where', 'as',
  'away', 'ahead', 'close', 'closer', 'closest', 'near', 'nearer', 'nearest', 'nearby', 'far', 'steps', 'step', 'yards', 'yard',
  'yd', 'yds', 'few']);
export const CLAUSE_SEPS = [' -- ', ' - ', ' — ', ' – ', '—', ', ', '; ', ': '];

const DISTANCE_RULES = DISTANCE_CLAIMS.map(entry => {
  let e = entry;
  const rule = { first: false, last: false, near: false, slots: [] };
  if (e.startsWith('^')) { rule.first = true; e = e.slice(1); }
  if (e.endsWith('$')) { rule.last = true; e = e.slice(0, -1); } else if (e.endsWith('~')) { rule.near = true; e = e.slice(0, -1); }
  for (let w of e.split(' ')) {
    const slot = { opt: false, num: false, unit: false, alts: new Set() };
    if (w.endsWith('?')) { slot.opt = true; w = w.slice(0, -1); }
    if (w === '#') slot.num = true;
    else if (w === '#yd') slot.unit = true;
    else for (const a of w.split('/')) slot.alts.add(a);
    rule.slots.push(slot);
  }
  return rule;
});

// A clause's words, where they are in it: runs of ASCII letters, digits and apostrophes (' or a
// curly one), lowercased, apostrophes at their ends left out.
function noteTokens(s) {
  const out = [];
  const re = /[A-Za-z0-9'‘’]+/g;
  let m;
  while ((m = re.exec(s))) {
    const w = m[0].replace(/[‘’]/g, "'").toLowerCase().replace(/^'+/, '').replace(/'+$/, '');
    if (w !== '') out.push({ s: m.index, e: m.index + m[0].length, w });
  }
  return out;
}

// Where the rule's slots from k on, matched from word i, end (one past the last word), or -1.
function matchSlots(words, i, slots, k, last) {
  if (k === slots.length) return last && i < words.length ? -1 : i;
  const s = slots[k];
  const w = words[i];
  const hit = w !== undefined && (s.alts.has(w) || (s.num && /^\d+$/.test(w)) || (s.unit && /^\d+(?:yds?|yards?)$/.test(w)));
  if (hit) {
    const e = matchSlots(words, i + 1, slots, k + 1, last);
    if (e >= 0) return e;
  }
  return s.opt ? matchSlots(words, i, slots, k + 1, last) : -1;
}

const trimSpaces = s => s.replace(/^ +/, '').replace(/ +$/, '');

// Spaces and punctuation once words are gone from a clause.
function tidyClause(s) {
  return s.replace(/ {2,}/g, ' ').replace(/ ([,.;:!?)])/g, '$1').replace(/\( /g, '(').replace(/\(\)/g, '').replace(/""/g, '')
    .replace(/ {2,}/g, ' ').replace(/^[ ,;:]+/, '').replace(/[ ,;:]+$/, '');
}

// A clause without its claims: the same text when it makes none, '' when nothing else is in it.
function clauseWithoutClaims(clause) {
  const toks = noteTokens(clause);
  const w = toks.map(t => t.w);
  const n = w.length;
  for (let k = 0; k < n; k++) {
    if (COMPASS.has(w[k]) && !(w[k + 1] === 'of' && SELF_WORDS.has(w[k + 2]))) return clause;
  }
  const marked = new Array(n).fill(false);
  let any = false;
  for (const r of DISTANCE_RULES) {
    const starts = r.first ? Math.min(1, n) : n;
    for (let i = 0; i < starts; i++) {
      const e = matchSlots(w, i, r.slots, 0, r.last);
      if (e < 0) continue;
      let measured = false;
      if (r.near) {
        for (let k = 0; k + 1 < n; k++) {
          if ((k < i || k >= e) && MEASURED_FROM.has(w[k]) && !SELF_WORDS.has(w[k + 1])) { measured = true; break; }
        }
      }
      if (measured) continue;
      any = true;
      for (let k = i; k < e; k++) marked[k] = true;
    }
  }
  if (!any) return clause;
  for (let k = 1; k < n; k++) if (marked[k - 1] && !marked[k] && CLAIM_AFTER.has(w[k])) marked[k] = true;
  for (let k = n - 2; k >= 0; k--) if (marked[k + 1] && !marked[k] && CLAIM_BEFORE.has(w[k])) marked[k] = true;
  if (marked[n - 1]) {
    let k = n - 1;
    while (k >= 0 && marked[k]) k--;
    while (k >= 0 && HANGING.has(w[k])) { marked[k] = true; k--; }
  }
  if (marked[0]) {
    let k = 0;
    while (k < n && marked[k]) k++;
    while (k < n && HANGING.has(w[k])) { marked[k] = true; k++; }
  }
  let content = false;
  for (let k = 0; k < n; k++) if (!marked[k] && !NOT_CONTENT.has(w[k]) && !/^\d+$/.test(w[k])) content = true;
  if (!content) return '';
  // Each run of claim words goes, from its first word's start to its last word's end.
  let out = '', pos = 0;
  for (let k = 0; k < n; k++) {
    if (!marked[k] || (k > 0 && marked[k - 1])) continue;
    let j = k;
    while (j + 1 < n && marked[j + 1]) j++;
    out += clause.slice(pos, toks[k].s);
    pos = toks[j].e;
  }
  return tidyClause(out + clause.slice(pos));
}

function noteClauses(body) {
  const out = [];
  let cs = 0, i = 0, sep = '';
  while (i < body.length) {
    const hit = CLAUSE_SEPS.find(x => body.startsWith(x, i));
    if (hit) {
      out.push({ sep, text: body.slice(cs, i) });
      sep = hit;
      i += hit.length;
      cs = i;
    } else i++;
  }
  out.push({ sep, text: body.slice(cs) });
  return out;
}

/** A stop's note without its distance and proximity claims (see DISTANCE_CLAIMS); '' when that's all it said. */
export function dropDistanceClaims(note) {
  const s = String(note ?? '');
  if (s === '') return s;
  let changed = false;
  // A parenthesis, as one clause: without its claims, or gone when that's all it held.
  const t = s.replace(/( ?)\(([^()]*)\)/g, (m, space, inner) => {
    const left = clauseWithoutClaims(inner);
    if (left === inner) return m;
    changed = true;
    return left === '' ? '' : `${space}(${left})`;
  });
  // Sentences end at . ! or ? before a space (cleanText leaves single spaces), or at the end.
  const sentences = [];
  const re = /[.!?] /g;
  let start = 0, m;
  while ((m = re.exec(t))) {
    sentences.push(t.slice(start, m.index + 1));
    start = m.index + 2;
  }
  if (start < t.length) sentences.push(t.slice(start));
  const out = [];
  for (const sentence of sentences) {
    const [, body, end] = sentence.match(/^([\s\S]*?)([.!?]*)$/);
    const kept = [];
    let edited = false;
    for (const c of noteClauses(body)) {
      const left = clauseWithoutClaims(c.text);
      if (left !== c.text) edited = true;
      if (left !== '') kept.push({ sep: c.sep, text: left });
    }
    if (!edited) { out.push(trimSpaces(sentence)); continue; }
    changed = true;
    let str = trimSpaces(kept.map((c, k) => (k ? c.sep : '') + c.text).join(''));
    if (str === '') continue;
    str = str.replace(/^[a-z]/, ch => ch.toUpperCase());
    out.push(str + end);
  }
  return changed ? trimSpaces(out.join(' ')) : s;
}

// One command, sanitized, or null (with the reason in `why`). Never throws: JSON can shadow
// toString or valueOf ({"title":{"toString":1}}), which makes String() and Number() throw, and a
// reply's text (game data the model echoed) must never take the reply down with it (as public-ui
// 3cec025; SY-03).
export function validateMapCommand(c, why = []) {
  try {
    return validateMapCommandRaw(c, why);
  } catch {
    why.push('a map command could not be read');
    return null;
  }
}

function validateMapCommandRaw(c, why) {
  if (!c || typeof c !== 'object') { why.push('not an object'); return null; }
  if (c.op === 'clearall') return { op: 'clearall' };
  const layer = String(c.layer ?? '');
  // "__proto__" would set the layers object's prototype, not a layer (SY-05).
  if (!/^[A-Za-z0-9_.-]+$/.test(layer) || layer.length > MAP_LIMITS.layerName || layer === '__proto__') { why.push(`bad layer name "${layer.slice(0, 40)}"`); return null; }
  if (c.op === 'clear') return { op: 'clear', layer };
  if (c.op !== 'set') { why.push(`unknown op "${String(c.op).slice(0, 20)}"`); return null; }
  if (!Array.isArray(c.points)) { why.push(`layer ${layer}: points must be an array`); return null; }
  const points = [];
  let noteChars = 0, notesDropped = false;
  for (const p of c.points.slice(0, MAP_LIMITS.pointsPerLayer)) {
    const m = Number(p && p.m), x = Number(p && p.x), y = Number(p && p.y);
    if (!Number.isInteger(m) || m <= 0 || m > MAP_LIMITS.mapIdMax || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = {
      m, x: Math.round(Math.min(100, Math.max(0, x)) * 100) / 100, y: Math.round(Math.min(100, Math.max(0, y)) * 100) / 100,
      label: cleanText(p.label, MAP_LIMITS.label), kind: MAP_KINDS.has(p.kind) ? p.kind : 'poi',
    };
    const note = dropDistanceClaims(cleanText(p.note, MAP_LIMITS.note));
    if (note && noteChars + note.length <= MAP_LIMITS.layerNotes) { point.note = note; noteChars += note.length; } else if (note) notesDropped = true;
    const q = Array.isArray(p.q) ? [...new Set(p.q.map(Number).filter(n => Number.isInteger(n) && n > 0 && n < 1e6))].slice(0, MAP_LIMITS.quests) : [];
    if (q.length) point.q = q;
    points.push(point);
  }
  if (notesDropped) why.push(`layer ${layer}: notes past ${MAP_LIMITS.layerNotes} characters dropped`);
  if (c.points.length > MAP_LIMITS.pointsPerLayer) why.push(`layer ${layer}: kept the first ${MAP_LIMITS.pointsPerLayer} points`);
  if (points.length < c.points.slice(0, MAP_LIMITS.pointsPerLayer).length) why.push(`layer ${layer}: dropped invalid points`);
  if (!points.length) { why.push(`layer ${layer}: no valid points`); return null; }
  return { op: 'set', layer, title: cleanText(c.title || layer, MAP_LIMITS.title), ordered: !!c.ordered, loop: !!c.loop, points };
}

export function newMap(epoch) {
  return { epoch: epoch || Math.random().toString(36).slice(2, 10), version: 0, layers: {} };
}

// Apply commands in order. Returns { changed, notes } and mutates `map`.
export function applyMapCommands(map, cmds, now = Date.now()) {
  const notes = [];
  let changed = false;
  for (const raw of cmds || []) {
    const why = [];
    const c = validateMapCommand(raw, why);
    notes.push(...why);
    if (!c) continue;
    if (c.op === 'clearall') {
      if (Object.keys(map.layers).length) { map.layers = {}; changed = true; }
      notes.push('cleared all layers');
    } else if (c.op === 'clear') {
      if (Object.hasOwn(map.layers, c.layer)) { delete map.layers[c.layer]; changed = true; notes.push(`cleared layer ${c.layer}`); }
    } else {
      map.layers[c.layer] = { title: c.title, ordered: c.ordered, loop: c.loop, points: c.points, t: now };
      changed = true;
      notes.push(`layer ${c.layer}: ${c.points.length} point(s)`);
    }
  }
  // Keep within budget: drop the oldest layers first.
  const total = () => Object.values(map.layers).reduce((s, l) => s + l.points.length, 0);
  const names = () => Object.keys(map.layers).sort((a, b) => map.layers[a].t - map.layers[b].t);
  while (Object.keys(map.layers).length > MAP_LIMITS.layers || total() > MAP_LIMITS.totalPoints) {
    const old = names()[0];
    delete map.layers[old];
    notes.push(`dropped old layer ${old} (map full)`);
    changed = true;
  }
  // Stop notes too: the oldest layers lose theirs first.
  const noteChars = () => Object.values(map.layers).reduce((s, l) => s + l.points.reduce((n, p) => n + (p.note ? p.note.length : 0), 0), 0);
  for (const name of names()) {
    if (noteChars() <= MAP_LIMITS.mapNotes) break;
    const l = map.layers[name];
    if (!l.points.some(p => p.note)) continue;
    for (const p of l.points) delete p.note;
    notes.push(`layer ${name}: notes dropped (map full)`);
    changed = true;
  }
  if (changed) map.version = (map.version || 0) + 1;
  return { changed, notes };
}

// Pull ```wowmap blocks out of a reply: a JSON object, an array, or one object per line.
// NeverQuestAlone (public BYOK PRD §6.3, RT-3): anchored like the UI blocks in render.mjs. Each fence is
// on a line of its own (up to 3 spaces in), and the body opens no other fence, so a block that's
// never closed can't swallow the ```wowchips block after it. A block written inline, or never
// closed, stays in the text; the caller reports it (byok/runtime/repair.mjs mapFailures).
const MAP_BLOCK_RE = /^[ \t]{0,3}```wowmap[^\n]*\n((?:(?![ \t]{0,3}```)[^\n]*\n)*?)[ \t]{0,3}```[ \t]*\r?$/gm;
export function extractMapBlocks(text) {
  const cmds = [], errors = [];
  const stripped = String(text ?? '').replace(MAP_BLOCK_RE, (_, body) => {
    const src = body.trim();
    try {
      const v = JSON.parse(src);
      cmds.push(...(Array.isArray(v) ? v : [v]));
    } catch {
      for (const line of src.split('\n')) {
        if (!line.trim()) continue;
        try { cmds.push(JSON.parse(line)); } catch { errors.push('unreadable wowmap line: ' + line.trim().slice(0, 60)); }
      }
    }
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { text: stripped, cmds, errors };
}
