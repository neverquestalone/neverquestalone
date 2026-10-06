// Other players' names from game data → "Player A" (public BYOK PRD §13.1, §13.2, RT-12, DB14).
//
// A name that reaches the model from game data (the target of a "my target" ask, a shift-clicked
// player link, a "Made by" line in a linked item's tooltip) is replaced by a pseudonym before the
// request leaves the machine, and put back in the reply before the player reads it. The mapping
// lives in memory for the session (one pseudonymizer per bridge run): "Player A" is the same person
// all session, and nothing about it is written to disk.
//
// Only names passed in are masked (mask's `names`, plus every name passed earlier this session);
// names the player types go as typed, which the first-run page says. Where a name came from decides
// where it's masked (final review L5-4): one the addon wrote into the player's own line (a "my
// target" ask) or a player link's head is someone the player is talking about, masked everywhere,
// the typed text included (maskStrong); one from a "Made by" line (register(…, {strong: false})) is
// masked in game data and the model's own replies only, so a crafter called "Where" or "Frost"
// never rewrites the player's question ("Where do I train?"). A name must look like a WoW
// character name (a capital, then 1 to 11 lowercase letters, or 2 to 12 letters of a script without
// case, optionally "-Realm"), so forged game text ("<Made by the>") can't turn a common word into a
// name that's masked all session. Matching is exact and case-sensitive, on whole words (letters and
// digits in any script), so "Thokk" doesn't touch "Thokks" and "bread" (typed) isn't the player
// "Bread". A "Name-Realm" also masks the bare "Name" (as the first player seen with it).
//
// Across sessions: transcripts keep the real text and each row's names (namesIn), never pseudonyms,
// so a later session registers those names again and masks the history with its own labels. A label
// found in the history that this session didn't hand out (a transcript stored in wire form, one the
// model made up) is reserved (reserveLabelsIn): it stays unknown and is never given to someone new,
// so a "Player A" from an earlier session never reaches the model, or the player, meaning someone else.
// This reduces what a provider learns about other players; it doesn't make anything anonymous.

export const PREFIX = 'Player ';
// Where the addon's message lists its links' tooltips (Chats.lua ExpandLinks); context.mjs splits on it.
export const LINKED_MARK = '\n\n--- Linked from the game ---\n';
// The datamark local models get between the words of game text (context.mjs, TH5); a label the
// model copies with it ("PlayerˆA") still maps back.
export const DATAMARK = '\u02c6';
const WORD = '[\\p{L}\\p{N}\\p{M}_]';
const LABEL_RE = /(?<![\p{L}\p{N}_])Player[ \u02c6]([A-Z]{1,3})(?![\p{L}\p{N}_])/gu;
// A WoW character name: a capital and 1 to 11 lowercase letters (accents and marks allowed), or 2 to
// 12 letters of a script without case; then an optional realm, "-Realm" (no spaces at its ends).
const NAME_RE = /^(?:\p{Lu}[\p{Ll}\p{M}]{1,11}|\p{Lo}[\p{Lo}\p{M}]{1,11})(?:-[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}' ]{0,38}[\p{L}\p{N}\p{M}'])?)?$/u;

/** 0 → "Player A", 25 → "Player Z", 26 → "Player AA". */
export function labelFor(i) {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return PREFIX + s;
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A matcher for whole-word occurrences of any of the strings (longest first), or null for none. */
export function wordsRegex(words) {
  const ws = [...new Set((words || []).filter(w => typeof w === 'string' && w))].sort((a, b) => b.length - a.length);
  return ws.length ? new RegExp(`(?<!${WORD})(?:${ws.map(escapeRe).join('|')})(?!${WORD})`, 'gu') : null;
}

/** Replace whole-word occurrences, [[from, to], ...]; the longest match wins. */
export function replaceWords(text, pairs) {
  const map = new Map((pairs || []).filter(([k]) => typeof k === 'string' && k));
  const re = wordsRegex([...map.keys()]);
  return re ? String(text ?? '').replace(re, hit => map.get(hit) ?? hit) : String(text ?? '');
}

/**
 * A name as the game gives it, or null when it can't be a WoW character name: "Thokk", "Thrâll",
 * "Мирон", "Arthas-Stormrage" pass; "the", "Hogger killers", "12345" and the labels don't.
 */
export function normalizeName(name) {
  const s = String(name ?? '').replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}|]/gu, '').replace(/\s+/g, ' ').trim();
  if ([...s].length > 48 || !NAME_RE.test(s)) return null;
  if (/^player$/i.test(s)) return null; // would collide with the labels
  return s;
}

export function createPseudonymizer() {
  const labels = new Map(); // name → label
  const names = new Map();  // label → the name as first given
  const reserved = new Set(); // labels seen in text this session didn't write: never handed out
  const strong = new Set(); // names masked in the player's own text too (a target ask, a player link)
  let next = 0;             // the next label's number
  let re = null;            // the matcher for every known name, rebuilt when one is added
  let reStrong = null;      // the same for the strong ones

  function add(name, isStrong = true) {
    const n = normalizeName(name);
    if (!n) return null;
    // "Name-Realm" gets its own pseudonym; the bare "Name" maps to the first player seen with it.
    const base = n.includes('-') ? normalizeName(n.slice(0, n.indexOf('-'))) : null;
    let label = labels.get(n);
    if (!label) {
      while (reserved.has(labelFor(next))) next += 1;
      label = labelFor(next);
      next += 1;
      names.set(label, n);
      labels.set(n, label);
      re = null;
    }
    if (base && !labels.has(base)) { labels.set(base, label); re = null; }
    if (isStrong && !strong.has(n)) {
      strong.add(n);
      if (base && labels.get(base) === label) strong.add(base);
      reStrong = null;
    }
    return label;
  }

  function matcher() {
    if (!re && labels.size) re = wordsRegex([...labels.keys()]);
    return re;
  }
  function strongMatcher() {
    if (!reStrong && strong.size) reStrong = wordsRegex([...strong]);
    return reStrong;
  }

  return {
    /** Register names from game data, then replace every known name in text with its pseudonym. */
    mask(text, newNames = []) {
      for (const n of newNames || []) add(n);
      const m = matcher();
      const s = String(text ?? '');
      return m ? s.replace(m, hit => labels.get(hit) ?? hit) : s;
    },
    /** Register names; strong: false for a "Made by" line's (masked in game data and replies only). */
    register(newNames = [], { strong: isStrong = true } = {}) {
      for (const n of newNames || []) add(n, isStrong);
    },
    /** Replace the strong names only: the player's own text (the typed words, their history rows). */
    maskStrong(text) {
      const m = strongMatcher();
      const s = String(text ?? '');
      return m ? s.replace(m, hit => labels.get(hit) ?? hit) : s;
    },
    /** Is this name masked in the player's own text? */
    isStrong: name => strong.has(normalizeName(name)),
    /** Put the real names back (a reply, before it's rendered for the game). Unknown labels stay. */
    unmask(text) {
      return String(text ?? '').replace(LABEL_RE, (all, l) => names.get(PREFIX + l) ?? all);
    },
    /**
     * The known names in a text with real names (a transcript row: the player's text, or a reply
     * after unmask), each once, in order: what the row must carry so a later session masks it again.
     */
    namesIn(text, { strongOnly = false } = {}) {
      const m = strongOnly ? strongMatcher() : matcher();
      if (!m) return [];
      return [...new Set(String(text ?? '').match(m) || [])];
    },
    /**
     * Keep the labels in a text that this session didn't hand out (a transcript stored in wire form,
     * or a label the model made up) from ever meaning someone this session: they stay unknown, so
     * unmask leaves them as they are. Returns the labels reserved.
     */
    reserveLabelsIn(text) {
      const out = [];
      for (const m of String(text ?? '').matchAll(LABEL_RE)) {
        const label = PREFIX + m[1];
        if (!names.has(label) && !reserved.has(label)) { reserved.add(label); out.push(label); }
      }
      return out;
    },
    /** The pseudonym for a name, registering it; null for something that can't be a name. */
    labelOf: add,
    /** [{label, name}] in order, for the app's "Last request" view (kept in memory only). */
    known() { return [...names].map(([label, name]) => ({ label, name })); },
    get size() { return names.size; },
  };
}

/** A link as the context builder holds it: { head, lines }, from an object or a bare string. */
function linkParts(link) {
  if (typeof link === 'string') return { head: link, lines: [] };
  if (!link || typeof link !== 'object') return { head: '', lines: [] };
  return { head: typeof link.head === 'string' ? link.head : '', lines: Array.isArray(link.lines) ? link.lines.filter(l => typeof l === 'string') : [] };
}

const PLAYER_HEAD_RE = /^\s*\[([^\]\n]{2,48})\] player\s*$/;
const MADE_BY_RE = /<Made by ([^<>\n]{2,48})>/g;

/**
 * Other players' names in a message's linked tooltips, however they arrived (split from the message,
 * or passed as game.linked): a player link's head "[Name] player", and "<Made by Name>" in any line
 * (madeBy: false leaves those out: the player links' names only).
 */
export function namesFromLinked(links, { madeBy = true } = {}) {
  const out = new Set();
  for (const link of Array.isArray(links) ? links : []) {
    const { head, lines } = linkParts(link);
    const p = head.match(PLAYER_HEAD_RE);
    if (p) out.add(p[1]);
    if (madeBy) for (const l of [head, ...lines]) for (const m of l.matchAll(MADE_BY_RE)) out.add(m[1]);
  }
  return [...out].map(normalizeName).filter(Boolean);
}

/**
 * Other players' names inside a message the addon built from game data:
 *   the "my target" quick ask, when the addon says the target is a player (Commands.lua TargetLine),
 *     in the typed part, where the addon writes it;
 *   player links, expanded as "[Name] player", and "<Made by Name>" lines in a linked item's tooltip,
 *     only in the "Linked from the game" part (Chats.lua), never in what the player typed.
 */
export function namesFromMessage(text) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n');
  const at = s.indexOf(LINKED_MARK);
  const typed = at < 0 ? s : s.slice(0, at);
  const out = [];
  const target = typed.match(/What do you know about my target: (.+?) \(([^()]*)\)\?/);
  if (target && /(^|, )a player(,|$)/.test(target[2])) out.push(target[1]);
  if (at >= 0) {
    const links = [];
    for (const raw of s.slice(at + LINKED_MARK.length).split('\n')) {
      if (!raw.trim()) continue;
      if (/^\s/.test(raw) && links.length) links[links.length - 1].lines.push(raw);
      else links.push({ head: raw, lines: [] });
    }
    out.push(...namesFromLinked(links));
  }
  return [...new Set(out.map(normalizeName).filter(Boolean))];
}
