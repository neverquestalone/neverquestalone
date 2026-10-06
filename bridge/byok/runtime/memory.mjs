// The memory digest (public BYOK PRD §6.2 "Memory", §12.3 TH8, §13.1; RT-5).
//
// Each turn carries at most 400 tokens (4 characters a token, measured as the block encodes it:
// JSON with `<` and `>` escaped, encodeData) of what the logbook keeps for the character in
// <dataDir>/memory/<Name-Realm>/, as labeled data for the game data block, and its quest lines up to
// QUEST_TOKENS more when they're the turn's only quest titles:
//   updated     when the facts were last written
//   character   the facts lines (character, XP, money, location, professions, gear)
//   recent      the newest log lines (milestones and sessions, with the logbook's own XP/h)
//   notes       what the player wrote outside the markers (a build plan, reminders)
//   quests      the quest lines, left out when the turn carries the live quest log (quests: false):
//               the live list is the whole log. Without it they're the only quest titles the model
//               has, with room of their own (QUEST_TOKENS: a full log of 40 at their least): the
//               context's Quest log line (live) keeps the quests still in the log (all of them when
//               it says it's the whole log, else those first). Over the budget each line first
//               shrinks to its id, title and whether it's ready to turn in, then the other parts
//               give way some, and only then do lines go, from the end; then
//   questsNote  names the ids left out, so the model never takes the rest for the whole log
// Everything is read as untrusted text (the player can edit these files, and game strings got into
// them): each line sanitized and capped. Memory never authorizes anything; it's background (TH8).
// With identity off (the default, §13.1) the character's name and realm become "your character"
// and "your realm".
import fs from 'node:fs';
import path from 'node:path';
import { FILES, START, END, MEMORY_DIR, memoryDir } from './logbook.mjs';
import { sanitizeGameString, encodeData } from './sanitize.mjs';
import { replaceWords } from './pseudonym.mjs';
import { estimateTokens } from './history.mjs';

export const DIGEST_TOKENS = 400;
// The quest lines' own room when they're the turn's only titles: 40 quests at their least ("1527 Call
// of Fire (ready to turn in)", some 10 tokens each; 40-character titles take 16). Within the digest's
// 400 they kept 11 to 19 of a full log's 40, and a quest at the end, the maintainer's Call of Fire, never (the
// breaker's r2).
export const QUEST_TOKENS = 640;
const LINE = 200;

/** A digest's size as it's sent: the block's encoding, where each `<` or `>` takes six characters. */
export const digestTokens = d => (d ? estimateTokens(encodeData(d)) : 0);

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

const stripComments = s => s.replace(/<!--[\s\S]*?-->/g, '');
const item = l => sanitizeGameString(stripComments(l).replace(/^\s*[-*]\s+/, ''), LINE);
// A quest line as the logbook writes it: "- <id> <title> (L20, grey): <objectives>" (logbook.mjs questFacts).
const QUEST_ITEM = /^\s*- \d+ /;
// The same line at its least: "<id> <title>", and "(ready to turn in)" when it is: what comes before
// its flags ("(L20, grey): "), else before its objectives or state, else (a line cut at LINE, in its
// objectives) before its last ": ".
function compactQuest(l) {
  const ready = /: complete, turn it in$/.test(l);
  const flagged = l.match(/^(.*?) \((?:L\d+(?:, grey)?|grey)\): /);
  let head = flagged ? flagged[1] : l.replace(/: (complete, turn it in|in progress)$/, '').replace(/: [^:]*\d+\/\d+(, [^:]*\d+\/\d+)*$/, '');
  if (head === l) head = l.replace(/: [^:]*$/, '');
  return `${head}${ready ? ' (ready to turn in)' : ''}`;
}

/**
 * The quests on a context's `Quest log` line (Chats.lua GameContext, context.mjs withState): their
 * ids, and whether it says it's the whole log ("all listed", not "as of an earlier read"). null
 * without one.
 */
export function liveQuests(contextLines) {
  const lines = Array.isArray(contextLines) ? contextLines : String(contextLines ?? '').split('\n');
  const line = lines.map(String).find(l => /^Quest log\b/.test(l));
  if (!line) return null;
  const m = line.match(/: ([\d*,]+)$/);
  const ids = m ? m[1].split(',').map(x => Number(x.replace('*', ''))).filter(Number.isInteger) : [];
  return { ids, whole: /, all listed(?=: |$)/.test(line) };
}

/** The facts block's lines and the text outside it. */
export function splitFacts(text) {
  const t = String(text ?? '');
  const i = t.indexOf(START);
  const j = i >= 0 ? t.indexOf(END, i + START.length) : -1;
  if (i < 0 || j < 0) return { inside: '', outside: t };
  return { inside: t.slice(i + START.length, j), outside: t.slice(0, i) + t.slice(j + END.length) };
}

// The player's own lines: not headings, not the logbook's own headings or boilerplate.
function playerLines(outside) {
  return stripComments(outside).split('\n')
    .filter(l => l.trim() && !/^\s*#/.test(l) && !/^Milestones and sessions, written by /.test(l))
    .map(item).filter(Boolean);
}

/**
 * digest({name, realm}, {dataDir, maxTokens = 400, identity = false, quests = true, live = null,
 * questTokens = QUEST_TOKENS}) → the labeled digest, or null when the character has no memory yet.
 * live: liveQuests of the turn's context.
 */
export function digest(char, { dataDir, maxTokens = DIGEST_TOKENS, identity = false, recentMax = 8, quests: withQuests = true, live = null, questTokens = QUEST_TOKENS } = {}) {
  if (!dataDir || !char || typeof char !== 'object' || !char.name) return null;
  const dir = memoryDir(dataDir, char);
  const character = read(path.join(dir, FILES.character));
  const quests = read(path.join(dir, FILES.quests));
  const log = read(path.join(dir, FILES.log));
  if (character === null && quests === null && log === null) return null;

  const c = splitFacts(character);
  const q = splitFacts(quests);
  const d = {};
  const updated = c.inside.match(/Updated (\d{4}-\d\d-\d\d \d\d:\d\d)/);
  if (updated) d.updated = updated[1];
  d.character = c.inside.split('\n').filter(l => /^\s*- /.test(l)).map(item).filter(Boolean);
  d.recent = (log ?? '').split('\n').filter(l => /^\s*- /.test(l)).map(item).filter(Boolean).slice(-recentMax);
  d.notes = [...playerLines(c.outside), ...playerLines(q.outside)].slice(0, 12);
  d.quests = withQuests ? q.inside.split('\n').filter(l => QUEST_ITEM.test(l)).map(item).filter(Boolean) : [];
  // The quests still in the log (the context's line): only those when it's the whole log, else those first.
  if (live && Array.isArray(live.ids) && d.quests.length) {
    const inLog = new Set(live.ids);
    const idOf = l => Number(l.match(/^\d+/)?.[0]);
    const now = d.quests.filter(l => inLog.has(idOf(l)));
    d.quests = live.whole ? now : [...now, ...d.quests.filter(l => !inLog.has(idOf(l)))];
  }

  if (!identity) {
    // The folder is named after the character, but its files can mention it too.
    const swaps = [[char.name, 'your character'], [char.realm, 'your realm']]
      .map(([k, v]) => [sanitizeGameString(k, 60), v]).filter(([k]) => [...k].length >= 2);
    const redact = s => replaceWords(s, swaps);
    // Not the quest lines: their titles are the game's (a character named Fire keeps "Call of Fire").
    for (const k of ['character', 'recent', 'notes']) d[k] = d[k].map(redact);
  }

  // Fit the budget: the quest lines at their least, then the facts beyond the character line, older
  // log lines and notes some, then quest lines from the end (their ids named), then the rest.
  const room = () => maxTokens + (d.quests.length ? Math.min(questTokens, digestTokens({ quests: d.quests })) : 0);
  const over = () => digestTokens(prune(d)) > room();
  const cut = (k, keep) => { while (over() && d[k].length > keep) d[k].pop(); };
  const cutOldest = (k, keep) => { while (over() && d[k].length > keep) d[k].shift(); };
  if (over()) d.quests = d.quests.map(compactQuest);
  cut('character', 1);
  cutOldest('recent', 3);
  cut('notes', 4);
  const all = d.quests.length;
  const gone = [];
  while (over() && d.quests.length) {
    gone.unshift(d.quests.pop().match(/^\d+/)?.[0] ?? '?');
    d.questsNote = `${gone.length} of ${all} quest lines left out to fit (ids ${gone.join(', ')}); those quests may still be in the log.`;
  }
  cutOldest('recent', 0);
  cut('notes', 0);
  cut('character', 0);
  const out = prune(d);
  if (digestTokens(out) > room()) return null;
  return Object.keys(out).length ? out : null;
}

function prune(d) {
  const out = {};
  for (const [k, v] of Object.entries(d)) if (Array.isArray(v) ? v.length : v) out[k] = v;
  return out;
}

/** Delete one character's memory folder (the app's "delete"). True when there was one. */
export function forgetMemory(dataDir, char) {
  const dir = memoryDir(dataDir, char);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Delete every character's memory (the app's "delete all"). Returns how many folders went. */
export function forgetAllMemory(dataDir) {
  const root = path.join(dataDir, MEMORY_DIR);
  let n = 0;
  try { n = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).length; } catch (e) { if (e.code === 'ENOENT') return 0; throw e; }
  fs.rmSync(root, { recursive: true, force: true });
  return n;
}

/** createMemory(dataDir) → { dir(char), digest(char, opts), forget(char), forgetAll() } */
export function createMemory(dataDir, defaults = {}) {
  return {
    dir: char => memoryDir(dataDir, char),
    digest: (char, opts = {}) => digest(char, { dataDir, ...defaults, ...opts }),
    forget: char => forgetMemory(dataDir, char),
    forgetAll: () => forgetAllMemory(dataDir),
  };
}
