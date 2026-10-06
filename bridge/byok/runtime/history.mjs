// Per-chat conversation transcripts (public BYOK PRD §6.4, §13.1, RT-6, RT-9, RT-12).
//
// Each chat's history is kept here, in
// <dataDir>/transcripts/<chatId>.jsonl: one JSON row per turn, {t, role, text[, kind][, names]}, and a
// reply's row also {run, usage}: its turn's key and its cost, written with the reply itself (code health
// BR-22), so a reply written just before a crash is found by its turn whatever the ledger says.
// Rows hold real text, never pseudonyms: a user row is what the player typed or the fixed event
// line (buildRequest's req.transcript), never the game data block (a block that slips in is taken
// off); an assistant row is the reply as the model wrote it with the real names put back
// (replyTranscript), not records.json's rendered and capped copy. `names` lists the other players'
// names from game data in the row, so the next session's pseudonymizer registers them and masks the
// history with its own labels ("Player A" from an earlier session would mean someone else now).
// Owner-only: the folder 0700, the files 0600 (on Windows, the per-user data folder's ACL does that
// job); the file names are the addon's chat ids (c + 6 hex, records.mjs), never a device name.
//
// window(chatId, budget) is what goes back to the model: whole exchanges (a user row and the reply
// that followed it), newest first while they fit a token budget (default 1,500 at 4 characters a
// token), returned oldest first. Each row is shortened first: a wowmap block becomes one line
// naming its layers and stops (the map already holds it), and a row over 500 tokens keeps its start
// and its end (the TL;DR) with a marked cut. A turn with no reply (an error, an abort, a crash) is
// left out, so the roles always alternate. The Companion chat (c0ffee0) never ends, so this cut is
// what keeps a typed turn near the PRD's 7,500 input tokens (§7.3). Older rows go after 30 days
// (prune), and forget/forgetAll delete a chat or everything ("delete all" in one click).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CHAT_RE } from '../../transport/records.mjs';
import { normalizeName } from './pseudonym.mjs';

export const HISTORY_BUDGET = 1500;
export const RETENTION_DAYS = 30;
export const TEXT_MAX = 64 * 1024;
export const ROW_TOKENS = 500;
export const NAMES_MAX = 32;
const DAY_MS = 86400000;
const ROLES = new Set(['user', 'assistant']);
const DATA_BLOCK_RE = /^<game_data id="([0-9a-f]+)">\n[^\n]*\n<\/game_data id="\1">\n*/;
// A wowmap block on lines of its own whose body opens no other fence, else one written inline.
const MAP_BLOCK_RE = /^[ \t]{0,3}```wowmap[^\n]*\n((?:(?![ \t]{0,3}```)[^\n]*\n)*?)[ \t]{0,3}```[ \t]*$|```wowmap[^\n]*\n((?:(?!```)[\s\S])*?)```(?!\w)/gm;

/** The PRD's token estimate: 4 characters a token. */
export const estimateTokens = s => Math.ceil(String(s ?? '').length / 4);

// One map command in a few words: "set layer mulgore, 14 stops".
function describeCommand(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.op === 'clearall') return 'clear all layers';
  const layer = /^[A-Za-z0-9_.-]{1,32}$/.test(String(c.layer ?? '')) ? c.layer : 'a layer';
  if (c.op === 'clear') return `clear layer ${layer}`;
  if (c.op === 'set') return `set layer ${layer}, ${Array.isArray(c.points) ? c.points.length : 0} ${c.ordered ? 'stops' : 'points'}`;
  return null;
}

function describeMapBlock(body) {
  const src = String(body ?? '').trim();
  let cmds = [];
  try { const v = JSON.parse(src); cmds = Array.isArray(v) ? v : [v]; } catch {
    for (const line of src.split('\n')) {
      if (!line.trim()) continue;
      try { cmds.push(JSON.parse(line)); } catch { cmds.push(null); }
    }
  }
  const said = cmds.map(describeCommand);
  const ok = said.filter(Boolean);
  const bad = said.length - ok.length;
  return [...ok.slice(0, 4), ...(ok.length > 4 ? [`${ok.length - 4} more`] : []), ...(bad ? [`${bad} line${bad === 1 ? '' : 's'} that couldn't be read`] : [])].join('; ') || 'nothing';
}

// A cut position moved off the middle of a surrogate pair (a lone half is invalid Unicode to an API).
const isLow = c => c >= 0xdc00 && c <= 0xdfff;
const safeAt = (s, i) => (i > 0 && i < s.length && isLow(s.charCodeAt(i)) ? i - 1 : i);

/**
 * A row's text as the history window sends it: wowmap blocks as one line each (the map holds the
 * points; the pack says this is a note, not a format), and at most maxTokens, keeping the start and
 * the end (where the TL;DR is) around a marked cut.
 */
export function compactText(text, maxTokens = ROW_TOKENS) {
  let t = String(text ?? '').replace(MAP_BLOCK_RE, (_, a, b) => `(wowmap block left out of the history: ${describeMapBlock(a ?? b)})`);
  const max = Math.max(40, maxTokens) * 4;
  if (t.length > max) {
    const head = safeAt(t, max - Math.floor(max / 4) - 60);
    const from = safeAt(t, t.length - Math.floor(max / 4));
    t = `${t.slice(0, head)}\n[… ${from - head} characters left out of the history …]\n${t.slice(from)}`;
  }
  return t;
}

/** A reply row's cost as kept: {in, out, micros, model, exact} in whole numbers, or null (code health BR-22). */
export function rowUsage(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const n = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const out = { in: n(u.in), out: n(u.out), micros: n(u.micros), model: typeof u.model === 'string' ? u.model.slice(0, 100) : '', exact: u.exact === true };
  return out.in === null || out.out === null || out.micros === null ? null : out;
}

// A row's names: other players' names, checked, each once, at most 32.
function cleanNames(names) {
  return Array.isArray(names) ? [...new Set(names.map(normalizeName).filter(Boolean))].slice(0, NAMES_MAX) : [];
}

function chmod(p, mode) {
  try { fs.chmodSync(p, mode); } catch { /* Windows, or gone: nothing to tighten */ }
}

function parseLines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; } // a torn line from a crash
    if (!r || !ROLES.has(r.role) || typeof r.text !== 'string' || !Number.isFinite(r.t)) continue;
    const row = { ...r };
    delete row.names;
    const names = cleanNames(r.names);
    if (names.length) row.names = names;
    out.push(row);
  }
  return out;
}

// Retention pruning (code health BR-20) read every transcript whole, twice, on the main thread, at
// the backend's start and every day. Rows go in in time order (the backend's nextT never goes back),
// so a transcript whose first row is inside the retention has nothing to prune: only its head is
// read (HEAD_BYTES, doubling while the first line is longer, at most HEAD_MAX). One whose first row
// is older, or whose first line isn't a whole row, is read once, whole, and rewritten as before; a
// torn line further on in a transcript with nothing old waits for its head to age (every read skips
// one). pruneAsync reads the same way, asynchronously; its rewrite is synchronous, and only when the
// file is still the one it read (same size and time), so a row appended meanwhile is never lost.
const HEAD_BYTES = 4096;
const HEAD_MAX = 256 * 1024;
const lineIn = (buf, n) => { const i = buf.subarray(0, n).indexOf(0x0a); return i < 0 ? null : buf.toString('utf8', 0, i); };
function headSync(file) {
  const fd = fs.openSync(file, 'r');
  try {
    for (let size = HEAD_BYTES; ; size *= 2) {
      const buf = Buffer.alloc(size);
      const n = fs.readSync(fd, buf, 0, size, 0);
      const line = lineIn(buf, n);
      if (line !== null || n < size || size >= HEAD_MAX) return line;
    }
  } finally { fs.closeSync(fd); }
}
async function headAsync(fh) {
  for (let size = HEAD_BYTES; ; size *= 2) {
    const buf = Buffer.alloc(size);
    const { bytesRead: n } = await fh.read(buf, 0, size, 0);
    const line = lineIn(buf, n);
    if (line !== null || n < size || size >= HEAD_MAX) return line;
  }
}
// Is the first row (its line) inside the retention?
const freshHead = (line, old) => { const [row] = line === null ? [] : parseLines(line); return !!row && row.t >= old; };
// A transcript's text after the prune: null when nothing changes (nothing old, no torn lines), else
// {removed, text} ('' when no row is left).
function prunedText(raw, old) {
  const all = parseLines(raw);
  const keep = all.filter(r => r.t >= old);
  if (keep.length === raw.split('\n').filter(l => l.trim()).length) return null;
  return { removed: all.length - keep.length, text: keep.length ? keep.map(r => JSON.stringify(r)).join('\n') + '\n' : '' };
}

/** Whole exchanges: each user row that the next row answers. */
export function exchanges(rows) {
  const out = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    if (rows[i].role === 'user' && rows[i + 1].role === 'assistant') { out.push([rows[i], rows[i + 1]]); i++; }
  }
  return out;
}

/**
 * createTranscripts(dataDir) → { dir, append, window, rows, chats, forget, forgetAll, prune }.
 * Transcripts go in <dataDir>/transcripts/. now() is injectable for tests.
 */
export function createTranscripts(dataDir, { now = () => Date.now(), retentionDays = RETENTION_DAYS } = {}) {
  if (!dataDir) throw new Error('createTranscripts needs the data folder');
  const dir = path.join(dataDir, 'transcripts');
  const tightened = new Set();

  const fileOf = (chatId) => {
    if (!CHAT_RE.test(String(chatId ?? ''))) throw new Error('bad chat id');
    return path.join(dir, `${chatId}.jsonl`);
  };
  const ensureDir = () => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!tightened.has(dir)) { chmod(dir, 0o700); tightened.add(dir); }
  };
  const readAll = (file) => {
    try { return parseLines(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  };
  // The newest rows: the file's last `bytes`, less the first (partial) line, or all of it.
  const readTail = (file, bytes) => {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { if (e.code === 'ENOENT') return { rows: [], whole: true }; throw e; }
    try {
      const size = fs.fstatSync(fd).size;
      const n = Math.min(size, bytes);
      const buf = Buffer.alloc(n);
      fs.readSync(fd, buf, 0, n, size - n);
      let text = buf.toString('utf8');
      if (n < size) text = text.slice(text.indexOf('\n') + 1);
      return { rows: parseLines(text), whole: n === size };
    } finally { fs.closeSync(fd); }
  };
  const writeAtomic = (file, text) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    chmod(tmp, 0o600);
    fs.renameSync(tmp, file);
  };
  // retentionDays: a number, or a function read at each use (the backend's setting, which the app changes live).
  const keepDays = () => { const d = typeof retentionDays === 'function' ? retentionDays() : retentionDays; return Number.isFinite(d) && d > 0 ? d : RETENTION_DAYS; };
  const cutoff = (days = keepDays()) => now() - days * DAY_MS;

  return {
    dir,

    /**
     * Add one row: {role: 'user'|'assistant', text, t?, kind?, names?} (req.transcript, or
     * replyTranscript(reply)), and for a reply its turn's key (run, at most 200 characters) and cost
     * (usage {in, out, micros, model, exact}). A user row never keeps a game data block. Returns the
     * row written.
     */
    append(chatId, { role, text, t, kind, names, run, usage } = {}) {
      const file = fileOf(chatId);
      if (!ROLES.has(role)) throw new Error('role must be user or assistant');
      let body = String(text ?? '');
      if (role === 'user') body = body.replace(DATA_BLOCK_RE, '');
      const row = { t: Number.isFinite(t) ? t : now(), role, text: body.slice(0, safeAt(body, TEXT_MAX)) };
      if (kind) row.kind = String(kind).slice(0, 20);
      const who = cleanNames(names);
      if (who.length) row.names = who;
      if (role === 'assistant' && typeof run === 'string' && run && run.length <= 200) row.run = run;
      const cost = role === 'assistant' ? rowUsage(usage) : null;
      if (cost) row.usage = cost;
      ensureDir();
      // A crash can leave a last line without its newline: start on a fresh line, so only that row is lost.
      let lead = '';
      try {
        const fd = fs.openSync(file, 'r');
        try {
          const size = fs.fstatSync(fd).size;
          if (size > 0) {
            const b = Buffer.alloc(1);
            fs.readSync(fd, b, 0, 1, size - 1);
            if (b[0] !== 0x0a) lead = '\n';
          }
        } finally { fs.closeSync(fd); }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      fs.appendFileSync(file, `${lead}${JSON.stringify(row)}\n`, { mode: 0o600 });
      if (!tightened.has(file)) { chmod(file, 0o600); tightened.add(file); }
      return row;
    },

    /** The prior turns for a request: [{role, content, names}], shortened (compactText), oldest first, within budgetTokens. */
    window(chatId, budgetTokens = HISTORY_BUDGET) {
      const file = fileOf(chatId);
      const budget = Math.max(0, Number(budgetTokens) || 0);
      if (!budget) return [];
      const old = cutoff();
      let bytes = Math.max(64 * 1024, budget * 32);
      for (;;) {
        const { rows, whole } = readTail(file, bytes);
        const pairs = exchanges(rows.filter(r => r.t >= old));
        const picked = [];
        let used = 0;
        let full = false;
        for (let i = pairs.length - 1; i >= 0; i--) {
          const pair = pairs[i].map(r => ({ role: r.role, content: compactText(r.text), names: r.names || [] }));
          const cost = estimateTokens(pair[0].content) + estimateTokens(pair[1].content);
          if (used + cost > budget) { full = true; break; }
          picked.unshift(pair);
          used += cost;
        }
        if (full || whole) return picked.flat();
        bytes *= 4;
      }
    },

    /**
     * The last `limit` rows as stored (for the app's history view), read from the file's end
     * (a long transcript isn't read whole for its last 100 rows); limit 0: every row.
     */
    rows(chatId, limit = 100) {
      const file = fileOf(chatId);
      if (!(limit > 0)) return readAll(file);
      let bytes = Math.max(16 * 1024, limit * 1024);
      for (;;) {
        const { rows, whole } = readTail(file, bytes);
        if (whole || rows.length >= limit) return rows.slice(-limit);
        bytes *= 4;
      }
    },

    /** Chat ids with a transcript. */
    chats() {
      try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).filter(c => CHAT_RE.test(c)); } catch (e) {
        if (e.code === 'ENOENT') return [];
        throw e;
      }
    },

    /** Delete one chat's transcript. True when there was one. */
    forget(chatId) {
      try { fs.unlinkSync(fileOf(chatId)); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
    },

    /** Delete every transcript. Returns how many. */
    forgetAll() {
      let n = 0;
      for (const c of this.chats()) if (this.forget(c)) n += 1;
      return n;
    },

    /** Drop rows older than `days` (default 30); a transcript left empty is deleted. */
    prune(days = keepDays()) {
      const old = cutoff(days);
      let files = 0;
      let removed = 0;
      for (const c of this.chats()) {
        const file = fileOf(c);
        let p;
        try {
          if (freshHead(headSync(file), old)) continue; // its first row is inside the retention: every row is
          p = prunedText(fs.readFileSync(file, 'utf8'), old);
        } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (!p) continue; // nothing old, no torn lines
        removed += p.removed;
        files += 1;
        if (p.text) writeAtomic(file, p.text);
        else fs.unlinkSync(file);
      }
      return { files, removed };
    },

    /** prune() with asynchronous reads (BR-20): the backend's start and its daily prune. Resolves to {files, removed}. */
    async pruneAsync(days = keepDays()) {
      const old = cutoff(days);
      let files = 0;
      let removed = 0;
      let names = [];
      try { names = await fsp.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return { files, removed }; throw e; }
      for (const c of names.filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -6)).filter(x => CHAT_RE.test(x))) {
        const file = fileOf(c);
        let raw;
        let st;
        try {
          const fh = await fsp.open(file, 'r');
          try {
            if (freshHead(await headAsync(fh), old)) continue;
            st = await fh.stat();
            raw = await fh.readFile();
          } finally { await fh.close(); }
        } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        const p = prunedText(raw.toString('utf8'), old);
        if (!p) continue;
        // Synchronous from here: the file must still be the one read (a turn appends synchronously too).
        let now;
        try { now = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        if (now.size !== raw.length || now.mtimeMs !== st.mtimeMs) continue; // written since: the next prune
        removed += p.removed;
        files += 1;
        if (p.text) writeAtomic(file, p.text);
        else fs.unlinkSync(file);
      }
      return { files, removed };
    },
  };
}
