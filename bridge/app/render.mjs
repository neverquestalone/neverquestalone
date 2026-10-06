// Agent text → WoW-safe text (PRD §9.5 "Rendering", RC-2, RC-3, RC-4, RC-7).
//
// Every `|` in agent text is doubled before anything else, so it can never form
// a game escape (a link, a texture, a color); the only escapes in the output are
// the color codes this file adds (TB3). Markdown becomes plain text that reads
// well in a small window. TL;DR, wowmap blocks and the map protocol are
// map-protocol.mjs's.
import { cleanOutput } from '../byok/runtime/sanitize.mjs';
import { extractMapBlocks, splitSummary } from './map-protocol.mjs';

export const RECORD_TEXT_MAX = 12000;
export const SUMMARY_MAX = 160;
const GOLD = '|cffffd100';
const GRAY = '|cffa0a0a0';
const END = '|r';
export const TABLE_NOTE = "(tables don't fit here: open this chat in the Control UI)";

export const escapePipes = s => String(s ?? '').replace(/\|/g, '||');

/** Inline markdown to plain text (no escapes added). */
export function inlinePlain(s) {
  return String(s ?? '')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, url) => `[image${alt ? ': ' + alt : ''}] (${url})`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, url) => (t === url ? url : `${t} (${url})`))
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
}

const isTableRow = l => /^\s*\|.*\|\s*$/.test(l);
const isTableSep = l => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l);
const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => inlinePlain(c.trim()));

/** Markdown → WoW text: headings gold, bullets •, code gray and indented, tables noted. */
export function markdownToWow(md) {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inCode = !inCode; continue; }
    if (inCode) { out.push(line.trim() ? `    ${GRAY}${escapePipes(line)}${END}` : ''); continue; }
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const rows = [cells(line)];
      i += 1;
      while (i + 1 < lines.length && isTableRow(lines[i + 1])) rows.push(cells(lines[++i]));
      out.push(`${GRAY}${escapePipes(TABLE_NOTE)}${END}`);
      for (const r of rows.slice(0, 6)) out.push(escapePipes(r.join(' · ')));
      if (rows.length > 6) out.push(`${GRAY}${escapePipes(`… ${rows.length - 6} more row(s)`)}${END}`);
      continue;
    }
    let m;
    if ((m = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/))) { out.push(`${GOLD}${escapePipes(inlinePlain(m[2]))}${END}`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('———'); continue; }
    if ((m = line.match(/^(\s*)[-*+]\s+\[( |x|X)\]\s+(.*)$/))) { out.push(`${'  '.repeat(Math.floor(m[1].length / 2))}${m[2] === ' ' ? '☐' : '☑'} ${escapePipes(inlinePlain(m[3]))}`); continue; }
    if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) { out.push(`${'  '.repeat(Math.floor(m[1].length / 2))}• ${escapePipes(inlinePlain(m[2]))}`); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { out.push(`${GRAY}  ${escapePipes(inlinePlain(m[1]))}${END}`); continue; }
    out.push(escapePipes(inlinePlain(line)));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Strip our color codes (for summaries and length math on the plain text). */
export const stripCodes = s => String(s ?? '').replace(/\|c[0-9a-fA-F]{8}|\|r/g, '');

/** First sentence or line of plain text, at most `max` characters. */
export function firstSentence(plain, max = SUMMARY_MAX) {
  const t = String(plain ?? '').replace(/^\s+/, '');
  const line = t.split('\n').find(l => l.trim()) || '';
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  let s = (m ? m[1] : line).trim();
  if (s.length > max) s = s.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return s;
}

// The game-side blocks a reply can end with, beside wowmap (PROTOCOL §4.1):
//   ```wowchips   up to 3 suggested replies, a JSON array or one per line
//   ```wowrefs    quest, item and spell ids: {"q":[766],"i":[4804],"s":[8017]}
//   ```wowweights stat weights for the character's build: {"str":1,"sta":0.8}
// They leave the text and ride as the record's chips, refs and weights. The
// addon turns refs into game links from the ids alone, so nothing Bones writes
// becomes a live link (TB3).
export const CHIPS_MAX = 3;
export const CHIP_CHARS = 60;
export const REFS_MAX = 8;
export const WEIGHT_KEYS = ['str', 'agi', 'sta', 'int', 'spi', 'armor', 'dps', 'ap', 'rap', 'crit', 'hit', 'sp', 'heal', 'mp5', 'def', 'dodge', 'parry', 'block'];
/** A stat weight is kept when |v| is less than this (so 100 and -100 are dropped). */
export const WEIGHT_MAX = 100;
// Fences on lines of their own (up to 3 spaces in, as Markdown allows), so a
// sentence that mentions ```wowchips, or ``` inside a line, never cuts text.
const UI_BLOCK_RE = /^[ \t]{0,3}```(wowchips|wowrefs|wowweights)[ \t]*\r?\n([\s\S]*?)^[ \t]{0,3}```[ \t]*$/gm;

const parseJson = s => { try { return JSON.parse(s); } catch { return undefined; } };

/** Suggested replies: plain text, no |, one line each, at most 60 characters. */
export function parseChips(src) {
  const j = parseJson(src);
  const list = Array.isArray(j) ? j : String(src).split('\n').map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ''));
  const out = [];
  for (const s of list) {
    if (typeof s !== 'string') continue;
    let t = inlinePlain(cleanOutput(s)).replace(/\|/g, '').replace(/\s+/g, ' ').trim();
    if ([...t].length > CHIP_CHARS) t = [...t].slice(0, CHIP_CHARS - 1).join('').replace(/\s+\S*$/, '') + '…';
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= CHIPS_MAX) break;
  }
  return out.length ? out : null;
}

const ID = v => (Number.isInteger(v) && v > 0 && v < 2147483647 ? v : null);

/** Game references: whole ids, 8 of each kind at most. */
export function parseRefs(src) {
  const j = parseJson(src);
  const out = {};
  const add = (k, v) => {
    const id = ID(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v);
    if (!id) return;
    out[k] = out[k] || [];
    if (out[k].length < REFS_MAX && !out[k].includes(id)) out[k].push(id);
  };
  const KEYS = { q: 'q', quest: 'q', quests: 'q', i: 'i', item: 'i', items: 'i', s: 's', spell: 's', spells: 's' };
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    for (const [k, v] of Object.entries(j)) {
      const kk = KEYS[k.toLowerCase()];
      if (kk) for (const x of Array.isArray(v) ? v : [v]) add(kk, x);
    }
  } else {
    for (const line of String(src).split('\n')) {
      const m = line.trim().match(/^(quests?|items?|spells?|q|i|s)\s*[:=]?\s*([\d,\s]+)$/i);
      if (m) for (const x of m[2].split(/[,\s]+/)) add(KEYS[m[1].toLowerCase()], x);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Stat weights under the keys the addon knows, finite numbers with |v| under WEIGHT_MAX. */
export function parseWeights(src) {
  const j = parseJson(src);
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const out = {};
  for (const [k, v] of Object.entries(j)) {
    const key = k.toLowerCase();
    if (WEIGHT_KEYS.includes(key) && typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < WEIGHT_MAX) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Take the game-side blocks out of a reply: { text, chips, refs, weights, errors }. */
export function extractUiBlocks(raw) {
  let chips = null, refs = null, weights = null;
  const errors = [];
  const text = String(raw ?? '').replace(UI_BLOCK_RE, (_, kind, body) => {
    const src = body.trim();
    const got = kind === 'wowchips' ? parseChips(src) : kind === 'wowrefs' ? parseRefs(src) : parseWeights(src);
    if (!got) errors.push(`${kind}: nothing usable`);
    else if (kind === 'wowchips') chips = got;
    else if (kind === 'wowrefs') refs = got;
    else weights = got;
    return '';
  });
  return { text, chips, refs, weights, errors };
}

/**
 * A final reply → { text, summary, more, chips, refs, weights, mapCommands, mapErrors, uiErrors }.
 * text: WoW-safe, at most RECORD_TEXT_MAX characters; more: characters left out.
 */
export function renderReply(raw) {
  // SC-7 step 3 (code health BR-07): no control, bidi or zero-width character from the model reaches the
  // game, in the text, the summary or a chip (a chip's JSON escapes decode after this, so parseChips
  // cleans each one again).
  const { text: noMap, cmds, errors } = extractMapBlocks(cleanOutput(raw));
  const ui = extractUiBlocks(noMap);
  const { text: full, summary: rawSummary } = splitSummary(ui.text);
  const wow = markdownToWow(full);
  let summary = rawSummary ? inlinePlain(rawSummary.replace(/\s*\n\s*/g, ' ')).trim() : firstSentence(stripCodes(markdownToWow(full)).replace(/\|\|/g, '|'));
  if (summary.length > SUMMARY_MAX) summary = summary.slice(0, SUMMARY_MAX - 1).replace(/\s+\S*$/, '') + '…';
  summary = escapePipes(summary.replace(/\|\|/g, '|'));
  let text = wow;
  let more = 0;
  if (text.length > RECORD_TEXT_MAX) {
    // Cut at a line break when there is one near the limit, and never inside an escape.
    let cut = text.lastIndexOf('\n', RECORD_TEXT_MAX);
    if (cut < RECORD_TEXT_MAX - 2000) cut = RECORD_TEXT_MAX;
    while (cut > 0 && text[cut - 1] === '|') cut--;
    more = text.length - cut;
    text = text.slice(0, cut) + (text.slice(0, cut).lastIndexOf(GRAY) > text.slice(0, cut).lastIndexOf(END) ? END : '');
  }
  return { text, summary, more, chips: ui.chips, refs: ui.refs, weights: ui.weights, mapCommands: cmds, mapErrors: errors, uiErrors: ui.errors };
}

/** Plain system line for errors and aborts (RC-5). */
export function systemLine(s) {
  return escapePipes(cleanOutput(s).replace(/\s+/g, ' ').trim());
}
