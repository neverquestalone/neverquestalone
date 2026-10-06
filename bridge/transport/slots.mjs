// Slot addons and the reload-path inbox (docs/PROTOCOL.md §1, §4).
//
// install side (setup): NQA_S001..S200 folders with a TOC carrying the
// client's interface number (rewritten when it changes, PRD §9.3), and the
// doorbells: sig/ctl/present.wav and the bell_*.wav files (PROTOCOL §3), which
// the client only sees if they exist when the UI loads.
// publish side (bridge): the same slot table into every slot's Inbox.lua and
// into NeverQuestAlone/Inbox.lua. Slot files are derived data: no fsync (PRD §9.5).
import fs from 'node:fs';
import path from 'node:path';
import { BELLS, signalPaths } from './signals.mjs';
import { createRetrier, renameWithRetry, writeFileWithRetry } from './fsretry.mjs';

export const SLOT_COUNT = 200;
export const SLOT_PREFIX = 'NQA_S';
// The slots' one row in the game's AddOns list: a category, which the addon
// folds once (Settings.lua P.FoldParts, the same name as ns.SLOT_CATEGORY).
export const SLOT_CATEGORY = 'NeverQuestAlone Parts';
// Each slot's icon there, once that row is unfolded: the addon's own, never
// the red question mark the list gives an addon that names none.
export const SLOT_ICON = 'Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone';
export const slotName = i => `${SLOT_PREFIX}${String(i).padStart(3, '0')}`;
// What a slot's Inbox.lua holds until the bridge writes one.
export const SLOT_PLACEHOLDER = 'NQA_SlotData = nil\n';

// A slot's TOC. The list shows its title, and its notes on hover, so those
// are the player's words (docs/STYLE.md, where "slot" is a plumbing word).
// Its Group is its own name: left to the client, a slot joins NeverQuestAlone's group
// (named alike, and needing it), and 0.5.2's list showed all 200, each with a
// check box, under NeverQuestAlone's row. With a Group of its own and the Category,
// each sits under that category's row instead (Blizzard_AddOnList's
// AddonList_Update), and its row's menu items "Disable All AddOns" and
// "Enable All AddOns" (the game's ADDON_LIST_DISABLE_CATEGORY and
// _ENABLE_CATEGORY) reach all 200 (they walk its direct children).
// One TOC for every install: the app's installer (bridge/byok/wow.mjs, which the
// developer command line runs too) and the addon zip (tools/package-addon.mjs) both write it.
export function slotToc(i, iface) {
  const n = String(i).padStart(3, '0');
  return [
    `## Interface: ${iface}`,
    `## Title: NeverQuestAlone Part ${n}`,
    '## Notes: A part of NeverQuestAlone that brings replies into the game. Leave it checked.',
    `## Category: ${SLOT_CATEGORY}`,
    `## Group: ${slotName(i)}`,
    `## IconTexture: ${SLOT_ICON}`,
    '## LoadOnDemand: 1',
    '## Dependencies: NeverQuestAlone',
    '',
    'Inbox.lua',
    '',
  ].join('\n');
}

// A link another account planted in AddOns (public BYOK PRD TH12) is removed, never written
// through: a folder that isn't a real folder of this account's, or a file that isn't a regular
// file, goes first, and files are created with O_EXCL, so one planted after the check fails the
// write. Publishing checks the folders it writes into the same way each time (audit CV-04): one
// swapped for a link while the bridge runs is skipped, and the next install repairs it.
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const UID = process.getuid?.();
const ownRealDir = (st, uid) => !!st && st.isDirectory() && (uid === undefined || st.uid === uid);
function realDir(dir, uid = UID) {
  const st = lstat(dir);
  if (ownRealDir(st, uid)) return;
  if (st) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
}
function freshFile(file, text) {
  if (lstat(file)) fs.rmSync(file, { recursive: true, force: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
}

/**
 * Create (or bring up to date) the slot pool and the doorbells.
 * Returns { created, rewritten, kept } counts. Deletes nothing but a link (or a
 * non-file) where one of its own folders or files goes.
 */
export function installSlots(addonsDir, { count = SLOT_COUNT, iface = '16001' } = {}) {
  let created = 0, rewritten = 0, kept = 0;
  fs.mkdirSync(addonsDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    const dir = path.join(addonsDir, slotName(i));
    const toc = path.join(dir, `${slotName(i)}.toc`);
    const inbox = path.join(dir, 'Inbox.lua');
    realDir(dir);
    const want = slotToc(i, iface);
    let have = null;
    if (lstat(toc)?.isFile()) { try { have = fs.readFileSync(toc, 'utf8'); } catch { /* new */ } }
    if (have === null) { freshFile(toc, want); created++; } else if (have !== want) { freshFile(toc, want); rewritten++; } else kept++;
    if (!lstat(inbox)?.isFile()) freshFile(inbox, SLOT_PLACEHOLDER);
  }
  const sig = signalPaths(addonsDir);
  fs.mkdirSync(path.dirname(sig.root), { recursive: true });
  realDir(sig.root);
  realDir(sig.dir('ctl'));
  for (const file of [sig.present(), ...BELLS.map(sig.bell)]) if (!lstat(file)?.isFile()) freshFile(file, '');
  return { created, rewritten, kept };
}

// The AddOns list keeps which categories are folded in g_addonCategoriesCollapsed,
// Blizzard_AddOnList's "SavedVariablesMachine" (its TOC at 1.60.1.70009): one file
// for the whole computer, which the game reads at its start (character select
// included) and writes back from memory when it quits. A key the list finds true
// is folded; a player's unfold sets it to nil (AddonList.lua:489, :913).
export const FOLD_VAR = 'g_addonCategoriesCollapsed';
export const addonListFile = flavorDir => path.join(flavorDir, 'WTF', 'SavedVariables', 'Blizzard_AddOnList.lua');

// A SavedVariables file as the game writes it: `NAME = value` statements, where a
// value is a table, a string, a number, true, false or nil. Returns each statement
// with where its value sits, or throws on anything else (the fold then leaves the
// file alone). Read as latin1, so every byte comes back as it was.
function savedStatements(text) {
  let i = 0;
  const fail = what => { throw new Error(`${what} at ${i}`); };
  const longOpen = () => /^\[(=*)\[/.exec(text.slice(i, i + 64));
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (!text.startsWith('--', i)) return;
      i += 2;
      const long = longOpen();
      if (long) {
        const end = text.indexOf(`]${long[1]}]`, i);
        if (end < 0) fail('comment');
        i = end + long[1].length + 2;
      } else {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
      }
    }
  };
  const ESC = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', "'": "'", '\n': '\n' };
  const string = () => {
    const q = text[i];
    if (q === '"' || q === "'") {
      let out = '';
      i++;
      while (text[i] !== q) {
        if (i >= text.length || text[i] === '\n') fail('string');
        if (text[i] !== '\\') { out += text[i++]; continue; }
        const c = text[i + 1];
        const d = /^\d{1,3}/.exec(text.slice(i + 1, i + 4));
        if (d) { out += String.fromCharCode(Number(d[0])); i += 1 + d[0].length; } else if (c in ESC) { out += ESC[c]; i += 2; } else fail('escape');
      }
      i++;
      return out;
    }
    const long = longOpen();
    if (!long) fail('string');
    const start = i + long[0].length;
    const end = text.indexOf(`]${long[1]}]`, start);
    if (end < 0) fail('string');
    i = end + long[1].length + 2;
    return text.slice(start, end).replace(/^\r?\n/, '');
  };
  const value = () => {
    skip();
    const start = i;
    if (text[i] === '{') {
      i++;
      const entries = [];
      for (;;) {
        skip();
        if (text[i] === '}') { i++; return { type: 'table', start, end: i, entries }; }
        let key = null;
        if (text[i] === '[' && !longOpen()) {
          i++;
          key = value();
          skip();
          if (text[i] !== ']') fail(']');
          i++;
          skip();
          if (text[i] !== '=') fail('=');
          i++;
        } else {
          const id = /^[A-Za-z_]\w*/.exec(text.slice(i, i + 256));
          if (id && !['true', 'false', 'nil'].includes(id[0])) {
            i += id[0].length;
            skip();
            if (text[i] !== '=' || text[i + 1] === '=') fail('=');
            i++;
            key = { type: 'string', value: id[0] };
          }
        }
        entries.push({ key, value: value() });
        skip();
        if (text[i] === ',' || text[i] === ';') i++;
        else if (text[i] !== '}') fail('separator');
      }
    }
    if (text[i] === '"' || text[i] === "'" || longOpen()) return { type: 'string', value: string(), start, end: i };
    const m = /^(?:true|false|nil|-?(?:0[xX][\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?))/.exec(text.slice(i, i + 64));
    if (!m || /\w/.test(text[i + m[0].length] || '')) fail('value');
    i += m[0].length;
    return { type: m[0] === 'nil' ? 'nil' : /^(true|false)$/.test(m[0]) ? 'boolean' : 'number', value: m[0], start, end: i };
  };
  const out = [];
  skip();
  while (i < text.length) {
    const id = /^[A-Za-z_]\w*/.exec(text.slice(i, i + 256));
    if (!id) fail('name');
    i += id[0].length;
    skip();
    if (text[i] !== '=') fail('=');
    i++;
    out.push({ name: id[0], value: value() });
    skip();
    if (text[i] === ';') { i++; skip(); }
  }
  return out;
}

const luaQuote = s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;

/**
 * Fold the slots' category in the game's AddOns list (C-119): ["<category>"] = true
 * in g_addonCategoriesCollapsed, the file and the table made if they're missing,
 * every other key and everything else in the file left as it was. Call it only
 * while the game isn't running: it writes that file back from memory when it quits.
 * Returns 'folded' (written), 'kept' (the key is there already: the game's own, or
 * a player's) or 'unreadable' (a file this can't read for sure, left alone).
 */
export function foldSlotCategory(flavorDir, category = SLOT_CATEGORY) {
  const file = addonListFile(flavorDir);
  let text = null;
  try { text = fs.readFileSync(file, 'latin1'); } catch (e) { if (e.code !== 'ENOENT') return 'unreadable'; }
  const eol = text !== null && text.includes('\r\n') ? '\r\n' : '\n';
  const entry = `\t[${luaQuote(category)}] = true,`;
  let out;
  if (text === null) {
    out = `\n${FOLD_VAR} = {\n${entry}\n}\n`; // the game's own layout for a new file
  } else {
    let found;
    try { found = savedStatements(text).filter(s => s.name === FOLD_VAR).at(-1); } catch { return 'unreadable'; }
    const v = found?.value;
    if (!v) {
      out = `${text}${text === '' || text.endsWith('\n') ? '' : eol}${FOLD_VAR} = {${eol}${entry}${eol}}${eol}`;
    } else if (v.type === 'nil') {
      out = `${text.slice(0, v.start)}{${eol}${entry}${eol}}${text.slice(v.end)}`;
    } else if (v.type === 'table') {
      if (v.entries.some(e => e.key?.type === 'string' && e.key.value === category)) return 'kept';
      out = `${text.slice(0, v.start + 1)}${eol}${entry}${text.slice(v.start + 1)}`;
    } else {
      return 'unreadable';
    }
  }
  // What's written must read back folded, or nothing is written.
  const back = savedStatements(out).filter(s => s.name === FOLD_VAR).at(-1)?.value;
  if (!back?.entries?.some(e => e.key?.value === category && e.value.value === 'true')) return 'unreadable';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.nqa-tmp`;
  fs.writeFileSync(tmp, out, 'latin1');
  fs.renameSync(tmp, file);
  return 'folded';
}

/**
 * The parts' row in the game's AddOns list, folded at install (C-119), so a new
 * player's first character select shows one folded "NeverQuestAlone Parts" row, not
 * 200 parts above their own addons. Once per install: recorded in the installer's
 * config file (partsFolded, by the category's name, as the addon's backstop remembers
 * it), so a player who unfolds it keeps it open through a later install. Only while
 * WoW isn't running: the game writes that file back from memory when it quits, so the
 * installer refuses to run while it is and running() is asked again here. Every
 * installer calls this one: bridge/byok/wow.mjs installAddon, with the app's config.json (or the
 * developer command line's).
 * Returns foldSlotCategory's answer ('folded', 'kept', 'unreadable'), 'done before',
 * 'running' or 'config unreadable' (nothing folded: without the record, a later install
 * would undo a player's unfold).
 */
export function foldPartsOnce({ flavorDir, configFile, running, category = SLOT_CATEGORY }) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') return 'config unreadable'; }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return 'config unreadable';
  if (cfg.partsFolded === category) return 'done before';
  if (running()) return 'running';
  const res = foldSlotCategory(flavorDir, category);
  if (res === 'folded' || res === 'kept') {
    cfg.partsFolded = category;
    let mode = 0o644;
    try { mode = fs.statSync(configFile).mode & 0o777; } catch { /* a new file */ }
    const tmp = `${configFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode });
    fs.renameSync(tmp, configFile);
  }
  return res;
}

/**
 * A slot table as the bridge's write queue runs it (bridge/write-queue.mjs write()): job = { addonsDir, text,
 * inbox, opts } (writeSlots's arguments, opts without a log or a retrier).
 */
export function runSlotJob(job, log) {
  return writeSlots(job.addonsDir, job.text, job.inbox, { ...job.opts, log });
}
/** What runs this plugin's jobs in the write queue (its use()): here, and in its worker by module and export. */
export const SLOT_JOB = Object.freeze({ run: runSlotJob, url: import.meta.url, name: 'runSlotJob' });

/** Slot folders present on disk (for diagnostics and the version check). */
export function countSlots(addonsDir) {
  try { return fs.readdirSync(addonsDir).filter(n => new RegExp(`^${SLOT_PREFIX}\\d{3}$`).test(n)).length; } catch { return 0; }
}

/** The interface number the slot TOCs carry (from S001), or null. */
export function slotInterface(addonsDir) {
  try {
    const t = fs.readFileSync(path.join(addonsDir, slotName(1), `${slotName(1)}.toc`), 'utf8');
    return (t.match(/^## Interface:\s*(\d+)/m) || [])[1] || null;
  } catch { return null; }
}

/** What a slot holds when it has nothing for this session: loading it applies nothing. */
export const EMPTY_SLOT = 'NQA_SlotData = nil\n';

// ---------------------------------------------------------------- the slot window (systems plan SY-03)
// The addon loads slots in order, one per load, each at most once per UI session, so a publish need
// only write the slots it can load next. The addon says where its next load is (slot=<R.slots.nextIndex>,
// on its hello and on a seen after every load; D5), and each report higher than the last is the
// anchor: lo = base, hi = base + margin. The margin holds the loads it can make before its next
// report is read: a seen stays on the strip 5 s and the next goes at the 2 s tick after it, at one
// load per 1.5 s at most: 5. A report that raises the top has the slots ahead written at once
// (service.mjs), so the next load always finds the table. An addon that reports nothing (an older
// one) has no window: every slot is written, which is correct, only heavier.
//
// Slots outside the window are emptied once when it starts (and below lo as it rises), so a load
// that ever runs past hi reads nothing rather than an old table: a later ring's load gets the next.
// No anchor, or a window reaching every slot: every slot is written, as before.
export const WINDOW_MARGIN = 8;

/**
 * The slots one publish writes, for the window `win` ({base, at, blanked, blankTo, top}: blankTo,
 * the slots below it already emptied; top, the highest written with the table), or null for every
 * slot. Returns {from, to, blank: [[a, b], …]}: the table goes to from..to, EMPTY_SLOT to each blank
 * range.
 */
export function slotWindow(win, { count = SLOT_COUNT } = {}) {
  if (!win || !Number.isInteger(win.base) || win.base < 1 || win.base > count || !Number.isFinite(win.at)) return null;
  const lo = win.base;
  const hi = win.base + WINDOW_MARGIN;
  if (hi >= count && lo <= 1) return null;
  const to = Math.min(count, hi);
  const blank = [];
  if (!win.blanked) {
    if (lo > 1) blank.push([1, lo - 1]);
    if (to < count) blank.push([to + 1, count]);
  } else {
    if ((win.blankTo | 0) < lo - 1) blank.push([Math.max(1, (win.blankTo | 0) + 1), lo - 1]);
    // A new anchor can bring the top down: what was written above it goes.
    if ((win.top | 0) > to) blank.push([to + 1, Math.min(count, win.top | 0)]);
  }
  return { from: lo, to, blank };
}

/**
 * Write one slot table text to the reload inbox and to the slots `from`..`to` (default: every
 * slot), and EMPTY_SLOT to each `blank` range. Windows sharing violations (the game or antivirus
 * holding a file) are retried by one retrier for the whole publish (fsretry.mjs). A folder that
 * isn't a real folder of this account's (`uid`) is skipped, never written through (audit CV-04).
 * Returns {bytes, errors, files, written, retries: the retrier's counts}.
 */
export function writeSlots(addonsDir, slotText, inboxText, { count = SLOT_COUNT, log = () => {}, from = 1, to = count, blank = [], retrier = null, uid = UID } = {}) {
  let bytes = 0, errors = 0, files = 0, written = 0;
  const retry = retrier || createRetrier({ onRetry: (e, n) => { if (n === 1) log('slot-retry', { error: e.code }); } });
  const write = (file, text) => {
    const tmp = `${file}.tmp`;
    files++;
    try {
      if (!ownRealDir(lstat(path.dirname(file)), uid)) throw Object.assign(new Error('not_a_folder'), { code: 'not_a_folder' });
      // O_EXCL: a leftover temp file (or a link planted there) is removed, never written through.
      try { writeFileWithRetry(retry, tmp, text, { flag: 'wx' }); } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        fs.rmSync(tmp, { force: true });
        writeFileWithRetry(retry, tmp, text, { flag: 'wx' });
      }
      renameWithRetry(retry, tmp, file);
      bytes += Buffer.byteLength(text);
      written++;
    } catch (e) {
      errors++;
      if (errors <= 3) log('slot-error', { file: path.relative(addonsDir, file), error: e.code || e.message });
    }
  };
  const lo = Math.max(1, from | 0), hi = Math.min(count, to | 0);
  for (let i = lo; i <= hi; i++) write(path.join(addonsDir, slotName(i), 'Inbox.lua'), slotText);
  for (const [a, b] of blank) for (let i = Math.max(1, a); i <= Math.min(count, b); i++) write(path.join(addonsDir, slotName(i), 'Inbox.lua'), EMPTY_SLOT);
  write(path.join(addonsDir, 'NeverQuestAlone', 'Inbox.lua'), inboxText);
  return { bytes, errors, files, written, retries: retry.stats() };
}
