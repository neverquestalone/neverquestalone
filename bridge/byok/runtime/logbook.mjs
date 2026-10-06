// The logbook, run by the bridge (public BYOK PRD §6.2 "Logbook and quest scripts", RT-5, RT-9;
// companion PRD F4, F6).
//
// A deterministic port of an older build's logbook script, which its model ran on event
// turns from the fenced JSON and its sha256. Here the bridge calls applyLogbook() itself with the
// state or recap object it holds: no model in the loop, so no fence, no hash, and nothing for the
// prompt to carry. It writes only
// <dataDir>/memory/<Name-Realm>/ (folders 0700, files 0600):
//   character.md, quests.md   facts only between <!-- nqa:facts:start --> and
//                             <!-- nqa:facts:end --> (a marked block is added if missing);
//                             everything outside the markers stays byte for byte, so the player's
//                             own notes there are safe
//   log.md                    one line per milestone (level, first zone visit, new profession
//                             tier, quest turned in) and per session, each once; the newest
//                             LOG_MAX_ENTRIES are kept (the digest reads only the last few)
// Idempotent: a state whose sid and seq were already applied, or older than the facts written,
// changes nothing; log lines are keyed. Game strings are data (TH8): one line, no markup that could
// escape a note, at most 60 characters; every number printed is checked to be one.
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeGameString } from './sanitize.mjs';

export const START = '<!-- nqa:facts:start -->';
export const END = '<!-- nqa:facts:end -->';
export const FILES = { character: 'character.md', quests: 'quests.md', log: 'log.md' };
export const MEMORY_DIR = 'memory';
/** log.md keeps its newest entries only (systems plan Batch 7): the digest reads the last 8. */
export const LOG_MAX_ENTRIES = 500;
const LAST_RE = /<!-- nqa:last (\{.*?\}) -->/;
const KEY_RE = /<!-- nqa:m (\S+) -->/g;
const WRITER = 'Written by NeverQuestAlone from game data: edit outside the markers.';

// ---------------------------------------------------------------- checking

const isInt = v => Number.isInteger(v);
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';
/** A whole number as text, or '?' (a forged state can put anything where a number goes). */
const int = v => (isInt(v) ? String(v) : '?');

/** 'state', 'session', 'too_large', or an Error explaining what's wrong. */
export function classify(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return new Error('not a JSON object');
  if (doc.v !== 1) return new Error('v must be 1');
  if (doc.state === 'too_large') return 'too_large';
  if (!isStr(doc.sid) || !/^[0-9a-f]{16}$/.test(doc.sid)) return new Error('sid must be 16 lowercase hex characters');
  const c = doc.char;
  if (!c || typeof c !== 'object' || !isStr(c.name) || !clean(c.name)) return new Error('char.name is missing');
  if (doc.kind === 'session') {
    for (const k of ['start', 'end']) {
      const p = doc[k];
      if (!p || !isInt(p.t) || !isInt(p.level)) return new Error(`${k} needs t and level`);
    }
    if (doc.end.t < doc.start.t) return new Error('end.t is before start.t');
    return 'session';
  }
  if (!isInt(doc.seq) || doc.seq < 0) return new Error('seq must be a whole number');
  if (!isInt(doc.t)) return new Error('t must be unix seconds');
  if (!isInt(c.level) || c.level < 1) return new Error('char.level must be a positive whole number');
  for (const k of ['quests', 'prof', 'gear', 'pending', 'poi', 'omitted']) {
    if (doc[k] !== undefined && !Array.isArray(doc[k])) return new Error(`${k} must be a list`);
  }
  return 'state';
}

// ---------------------------------------------------------------- formatting

export function money(copper) {
  if (!isNum(copper)) return '?';
  const sign = copper < 0 ? '-' : '';
  const c = Math.abs(Math.trunc(copper));
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, cc = c % 100;
  if (g) return `${sign}${g}g ${s}s ${cc}c`;
  if (s) return `${sign}${s}s ${cc}c`;
  return `${sign}${cc}c`;
}

const num = n => (isNum(n) ? Math.round(n).toLocaleString('en-US') : '?');
const coord = n => (isNum(n) ? String(Math.round(n * 100) / 100) : '?');

/** "2026-09-25 14:03" in local time (TZ applies). */
export function when(t) {
  const d = new Date(t * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function duration(sec) {
  const m = Math.max(0, Math.round(sec / 60));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

/** A game string as a note may hold it: one line, no controls or invisible characters, no comment or markup syntax, capped. */
export function clean(s, max = 60) {
  const t = sanitizeGameString(s, 400).replace(/<!--|-->/g, ' ').replace(/[`<>]/g, '').replace(/\s+/g, ' ').trim();
  return [...t].slice(0, max).join('').trim();
}

const who = c => `${clean(c.name)}${c.realm && clean(c.realm) ? `-${clean(c.realm)}` : ''}`;
const title = c => [c.race, c.class].filter(isStr).map(x => clean(x).toLowerCase().replace(/^\p{L}/u, ch => ch.toUpperCase())).filter(Boolean).join(' ');

/** The memory folder's name for a character: "Name-Realm", made safe as one path segment on every OS. */
export function charKey(char) {
  const c = char && typeof char === 'object' ? char : {};
  let k = `${clean(c.name, 48)}${c.realm && clean(c.realm, 48) ? `-${clean(c.realm, 48)}` : ''}`
    .replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(k)) k += '_'; // Windows device names
  return k || 'unknown';
}

/** <dataDir>/memory/<Name-Realm> */
export function memoryDir(dataDir, char) {
  return path.join(dataDir, MEMORY_DIR, charKey(char));
}

export function characterFacts(doc, last) {
  const c = doc.char;
  const lines = [`Updated ${when(doc.t)} from game data (session ${doc.sid.slice(0, 6)}, seq ${doc.seq}). ${WRITER}`, ''];
  lines.push(`- Character: ${clean(c.name)}${c.realm && clean(c.realm) ? ` on ${clean(c.realm)}` : ''}, level ${c.level}${title(c) ? ` ${title(c)}` : ''}`);
  if (isNum(c.xp) && isNum(c.xpMax) && c.xpMax > 0) lines.push(`- XP: ${num(c.xp)} / ${num(c.xpMax)} (${Math.floor((c.xp / c.xpMax) * 100)}%)`);
  if (isNum(c.money)) lines.push(`- Money: ${money(c.money)}`);
  const l = doc.loc;
  if (l && typeof l === 'object' && clean(l.zone)) {
    const pos = isNum(l.x) && isNum(l.y) ? ` (map ${int(l.map)}, ${coord(l.x)}, ${coord(l.y)})` : '';
    lines.push(`- Location: ${clean(l.zone)}${l.sub && clean(l.sub) && clean(l.sub) !== clean(l.zone) ? `, ${clean(l.sub)}` : ''}${pos}`);
  }
  const prof = (doc.prof || []).filter(p => p && typeof p === 'object' && clean(p.name));
  if (prof.length) lines.push(`- Professions: ${prof.map(p => `${clean(p.name)} ${int(p.rank)}/${int(p.max)}`).join(', ')}`);
  const gear = (doc.gear || []).filter(g => g && typeof g === 'object' && isInt(g.id));
  if (gear.length) lines.push(`- Gear: ${gear.map(g => `slot ${int(g.slot)} ${g.name && clean(g.name) ? `${clean(g.name)} ` : ''}(${g.id}) ilvl ${int(g.ilvl)}`).join('; ')}`);
  if (doc.omitted?.length) lines.push(`- Left out to fit: ${doc.omitted.map(k => clean(k)).filter(Boolean).join(', ')}`);
  lines.push(`<!-- nqa:last ${JSON.stringify(last)} -->`);
  return lines.join('\n');
}

// How many quests the log has (as the skill's wow-logbook.mjs says it): the state's questCount says
// the list is the whole log (and against which cap); an older addon's list stopped at 25.
function questCount(doc, qs) {
  const n = qs.length;
  const s = n === 1 ? '' : 's';
  if (!isInt(doc.questCount)) return n >= 25 ? `${n} active quests listed (an older addon sent at most 25; there may be more)` : `${n} active quest${s}`;
  const max = isInt(doc.questMax) && doc.questMax > 0 ? doc.questMax : null;
  const unread = isInt(doc.questUnread) && doc.questUnread > 0 ? doc.questUnread : 0;
  if (unread) return `${n} active quest${s} listed${max ? ` (max ${max})` : ''}, not the whole log: the game listed ${unread} more without a quest id yet, still in the log`;
  return `${n} active quest${s} (the whole log${max ? `, max ${max}` : ''})`;
}

export function questFacts(doc) {
  const qs = (doc.quests || []).filter(q => q && typeof q === 'object' && isInt(q.id));
  const lines = [`Updated ${when(doc.t)} from game data (seq ${doc.seq}). ${questCount(doc, qs)}. ${WRITER}`, ''];
  if (doc.omitted?.some(k => /^quests/.test(String(k)))) lines.push('- Some quest details were left out to fit (never a quest).');
  for (const q of qs) {
    const flags = [isInt(q.level) && q.level ? `L${q.level}` : null, q.trivial === true ? 'grey' : null].filter(Boolean).join(', ');
    const head = `${q.id} ${q.title && clean(q.title) ? `${clean(q.title)}${q.cut === true ? '… (title cut to fit)' : ''}` : '(title left out)'}${flags ? ` (${flags})` : ''}`;
    const obj = Array.isArray(q.obj) ? q.obj.filter(o => o && typeof o === 'object') : [];
    let rest;
    if (q.complete === true) rest = 'complete, turn it in';
    else if (obj.length) rest = obj.map(o => `${o.text && clean(o.text) ? clean(o.text) : 'objective'} ${int(o.have)}/${int(o.need)}`).join(', ');
    else rest = 'in progress';
    lines.push(`- ${head}: ${rest}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- milestones

/** A log key: one token, whatever the names in it (they have spaces). */
export function key(...parts) {
  return parts.map(p => encodeURIComponent(String(p))).join(':');
}

/** Log entries this document adds: [{ key, t, text }], before dedupe against the log. */
export function milestones(doc, last) {
  const c = doc.char;
  const me = who(c);
  const out = [];
  if (last && last.who === me && isInt(last.level) && c.level > last.level) {
    for (let lv = last.level + 1; lv <= c.level; lv++) out.push({ key: key('level', me, lv), t: doc.t, text: `Reached level ${lv}` });
  }
  for (const p of doc.pending || []) {
    if (!p || typeof p !== 'object') continue;
    const t = isInt(p.t) ? p.t : doc.t;
    if (p.kind === 'zone' && clean(p.zone)) out.push({ key: key('zone', me, clean(p.zone)), t, text: `First visit: ${clean(p.zone)}` });
    else if (p.kind === 'prof' && clean(p.name) && isInt(p.max)) out.push({ key: key('prof', me, clean(p.name), p.max), t, text: `${clean(p.name)}: trained up to ${p.max}` });
    else if (p.kind === 'quest_done' && isInt(p.id)) out.push({ key: key('quest', me, p.id), t, text: `Turned in ${p.title && clean(p.title) ? clean(p.title) : 'quest'} (${p.id})` });
  }
  return out;
}

export function sessionLine(doc) {
  const s = doc.start, e = doc.end;
  const secs = e.t - s.t;
  const hours = secs / 3600;
  const xpRate = isNum(doc.xpGained) && secs >= 600 ? ` (${num(doc.xpGained / hours)} XP/h)` : '';
  const parts = [`Session ${duration(secs)}`];
  parts.push(e.level !== s.level ? `level ${s.level} to ${e.level}` : `level ${e.level}`);
  if (isNum(doc.xpGained)) parts.push(`${num(doc.xpGained)} XP${xpRate}`);
  if (isNum(doc.moneyDelta)) parts.push(`money ${doc.moneyDelta >= 0 ? '+' : ''}${money(doc.moneyDelta)}`);
  if (isInt(doc.questsTurnedIn)) parts.push(`${doc.questsTurnedIn} quest${doc.questsTurnedIn === 1 ? '' : 's'} turned in`);
  const zones = Array.isArray(doc.zones) ? doc.zones.map(z => clean(z)).filter(Boolean) : [];
  if (zones.length) parts.push(`zones: ${zones.join(', ')}`);
  return { key: key('session', doc.sid), t: s.t, text: parts.join(', ') };
}

// ---------------------------------------------------------------- notes

/** Replace what's between the markers, or append a marked block. Outside text stays byte for byte. */
export function putBlock(text, block, heading) {
  const body = `${START}\n${block}\n${END}`;
  const i = text.indexOf(START);
  const j = i >= 0 ? text.indexOf(END, i + START.length) : -1;
  if (i >= 0 && j >= 0) return text.slice(0, i) + body + text.slice(j + END.length);
  const sep = text === '' ? '' : text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}## ${heading}\n\n${body}\n`;
}

export function readLast(characterText) {
  const i = characterText.indexOf(START);
  const j = i >= 0 ? characterText.indexOf(END, i) : -1;
  if (i < 0 || j < 0) return null;
  const m = characterText.slice(i, j).match(LAST_RE);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function logKeys(logText) {
  return new Set([...logText.matchAll(KEY_RE)].map(m => m[1]));
}

function readOr(file, fallback) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const d of [path.dirname(dir), dir]) { try { fs.chmodSync(d, 0o700); } catch { /* Windows */ } }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* Windows */ }
  fs.renameSync(tmp, file);
}

/** log.md with only its newest LOG_MAX_ENTRIES entry lines; the heading and anything else stay. */
export function capLog(text, max = LOG_MAX_ENTRIES) {
  const lines = String(text).split('\n');
  let over = lines.filter(l => /^- /.test(l)).length - max;
  if (over <= 0) return text;
  return lines.filter(l => !(/^- /.test(l) && over-- > 0)).join('\n');
}

/**
 * Apply one state or recap document to the character's memory folder.
 * Returns { ok: true, changed: [file names], log: [new lines], note, dir } or { ok: false, error }.
 * Reads, computes, then writes (unless dryRun); never throws.
 */
export function applyLogbook(doc, { dataDir, dryRun = false } = {}) {
  try {
    if (!dataDir) throw new Error('applyLogbook needs the data folder');
    const kind = classify(doc);
    if (kind instanceof Error) return { ok: false, error: `not a companion document: ${kind.message}` };
    if (kind === 'too_large') return { ok: true, changed: [], log: [], note: 'The state was too large to send, so there are no facts to write.', dir: null };
    const dir = memoryDir(dataDir, doc.char);
    const paths = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, path.join(dir, f)]));
    const character = readOr(paths.character, null);
    const quests = readOr(paths.quests, null);
    const logText = readOr(paths.log, null);
    const last = character ? readLast(character) : null;
    const me = who(doc.char);
    const writes = {};
    let entries = [];
    let note = null;

    if (kind === 'state') {
      if (last && last.who === me && last.sid === doc.sid && isInt(last.seq) && doc.seq <= last.seq) {
        return { ok: true, changed: [], log: [], note: `Already applied (seq ${doc.seq} ≤ ${last.seq}); nothing written.`, dir };
      }
      if (last && last.who === me && isInt(last.t) && doc.t < last.t) {
        return { ok: true, changed: [], log: [], note: 'Older than the facts already written; nothing written.', dir };
      }
      const newLast = { who: me, sid: doc.sid, seq: doc.seq, t: doc.t, level: doc.char.level };
      writes.character = putBlock(character ?? '# Character\n', characterFacts(doc, newLast), 'Facts (from the game)');
      writes.quests = putBlock(quests ?? '# Quests\n', questFacts(doc), 'Active quests (from the game)');
      entries = milestones(doc, last);
      if (!last) note = 'First run: no level milestone without an earlier level to compare.';
    } else {
      entries = [sessionLine(doc)];
      if (last && last.who === me && isInt(last.t) && doc.end.t > last.t && character) {
        // The session's end is the newest word on level: keep the facts' comparison point current.
        const updated = { ...last, t: doc.end.t, level: doc.end.level };
        writes.character = character.replace(LAST_RE, `<!-- nqa:last ${JSON.stringify(updated)} -->`);
      }
    }

    const have = logKeys(logText ?? '');
    const fresh = entries.filter(e => !have.has(e.key));
    if (fresh.length) {
      let text = logText ?? '# Log\n\nMilestones and sessions, written by NeverQuestAlone from game data.\n';
      if (!text.endsWith('\n')) text += '\n';
      for (const e of fresh) text += `- ${when(e.t)} · ${e.text} <!-- nqa:m ${e.key} -->\n`;
      writes.log = capLog(text);
    }

    const changed = [];
    for (const [k, text] of Object.entries(writes)) {
      const before = k === 'character' ? character : k === 'quests' ? quests : logText;
      if (text === before) continue;
      if (!dryRun) {
        ensureDir(dir);
        writeAtomic(paths[k], text);
      }
      changed.push(FILES[k]);
    }
    return { ok: true, changed, log: fresh.map(e => e.text), note, dir };
  } catch (e) {
    return { ok: false, error: `can't update the memory folder: ${e.code || e.message}` };
  }
}
