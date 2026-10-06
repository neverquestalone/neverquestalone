// Game context: upstream's context lines, as the addon sends them (PRD §9.9, SE-7): unchanged in its
// hello body, and in a msg body when the context changed. The backend reads them from the turn
// (the turn's contextLines, backend.send).
//
// A turn that names a game state (st=, cap ctx) gets its lines from that state
// where it has them (withState): a message beside the state leaves its context
// out, and the stored one supplies only what the state doesn't carry.

import { questCountPhrase } from './companion.mjs';
/** Parse upstream's context lines into fields. */
export function parseContextLines(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = line.match(/^([A-Za-z ()*,=-]+?):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (key === 'Game') out.game = value;
    else if (key === 'Character') out.character = value;
    else if (key === 'Location') out.location = value;
    else if (key === 'Position') out.position = value;
    else if (key.startsWith('Money')) out.money = line.trim();
    else if (key === 'Talents') out.talents = value;
    else if (key === 'Professions') out.professions = value;
    else if (key.startsWith('Quest log')) out.quests = value;
  }
  return out;
}

// The context's lines in the order the addon writes them (Chats.lua GameContext).
const ORDER = ['Game', 'Character', 'Location', 'Position', 'Money', 'Talents', 'Professions', 'Quest log'];
const sectionOf = (line) => {
  const k = (line.match(/^([A-Za-z ()*,=-]+?):/) || [])[1];
  if (!k) return null;
  if (k === 'XP' || k.startsWith('Money')) return 'Money';
  if (k.startsWith('Quest log')) return 'Quest log';
  return ORDER.includes(k) ? k : null;
};
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
// Copper as the addon writes it (Chats.lua Money): "1g 18s 0c", "7s 3c", "3c".
const money = (copper) => {
  const c = Math.max(0, Math.floor(Number(copper) || 0));
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, cu = c % 100;
  return g > 0 ? `${g}g ${s}s ${cu}c` : s > 0 ? `${s}s ${cu}c` : `${cu}c`;
};

/**
 * The context lines for a turn that names a game state (companion F1, cap ctx;
 * PROTOCOL §2.6), written the way the addon writes them: the level, location,
 * position, money and XP, professions and quest log come from the state; the
 * game and client, the rest of the character line (name, realm, race, class,
 * faction, guild) and talents stay as the stored context has them (the addon
 * sends its context again when those change). What the state leaves out (a
 * too_large state has none of it) stays as stored, and a context written for
 * another character comes back unchanged.
 */
export function withState(contextText, state) {
  const s = isObj(state) ? state : {};
  const ch = isObj(s.char) ? s.char : null;
  const loc = isObj(s.loc) ? s.loc : null;
  const stored = new Map();
  const other = [];
  for (const line of String(contextText ?? '').split('\n')) {
    const sec = sectionOf(line);
    if (sec && !stored.has(sec)) stored.set(sec, line);
    else if (line.trim()) other.push(line);
  }
  const who = stored.get('Character');
  if (ch && ch.name && who !== undefined) {
    const head = `Character: ${ch.name}${ch.realm ? ` on ${ch.realm}` : ''}`;
    if (!who.startsWith(head) || !/^(?:$|[ ,(])/.test(who.slice(head.length))) return String(contextText ?? '');
  }
  const fresh = {}; // section -> the state's line (null: the state says there's none)
  if (ch && who !== undefined && Number.isInteger(ch.level)) fresh.Character = who.replace(/, level \d+/, `, level ${ch.level}`);
  if (loc) {
    fresh.Location = loc.zone ? `Location: ${loc.zone}${loc.sub && loc.sub !== loc.zone ? ` - ${loc.sub}` : ''}` : null;
    fresh.Position = Number.isFinite(loc.x) && Number.isFinite(loc.y)
      ? `Position: ${loc.x.toFixed(1)}, ${loc.y.toFixed(1)}${Number.isInteger(loc.map) ? ` (map ${loc.map})` : ''}` : null;
  }
  if (ch) {
    const parts = [];
    if (Number.isFinite(ch.money)) parts.push(`Money: ${money(ch.money)}`);
    if (Number.isFinite(ch.xp) && Number.isFinite(ch.xpMax) && ch.xpMax > 0) parts.push(`XP: ${ch.xp}/${ch.xpMax}`);
    fresh.Money = parts.length ? parts.join('; ') : null;
  }
  if (Array.isArray(s.prof)) {
    const prof = s.prof.filter(p => isObj(p) && p.name).map(p => `${p.name}${p.rank != null ? ` ${p.rank}${p.max != null ? `/${p.max}` : ''}` : ''}`);
    fresh.Professions = prof.length ? `Professions: ${prof.join(', ')}` : null;
  }
  if (Array.isArray(s.quests)) {
    // Every quest, after its count against the game's cap (Chats.lua writes the
    // same line); with none listed, the line still goes when some weren't read.
    const ids = s.quests.filter(q => isObj(q) && Number.isInteger(q.id)).map(q => `${q.id}${q.complete ? '*' : ''}`);
    const count = questCountPhrase(s);
    const whole = !count || / all listed$/.test(count);
    fresh['Quest log'] = ids.length || !whole ? `Quest log (id, * = ready to turn in): ${[count, ids.join(',')].filter(Boolean).join(': ')}` : null;
  }
  const lines = ORDER.map(sec => (sec in fresh ? fresh[sec] : stored.get(sec))).filter(Boolean);
  return [...lines, ...other].join('\n');
}

/**
 * The context with its Quest log line's "all listed" marked as of an earlier
 * read: a turn that named a state (st=) goes with the stored context when that
 * state didn't come within the wait or was too_large, and a quest picked up
 * since may not be on the stored line (the data block says the same of an
 * older state: STALE_NOTE). Other lines, and a line already saying it isn't
 * the whole log, stay as they are.
 */
export const STALE_LISTED = ', all listed as of an earlier read (a quest picked up since may not be on it)';
export function staleContext(contextText) {
  return String(contextText ?? '').split('\n')
    .map(l => (sectionOf(l) === 'Quest log' ? l.replace(/, all listed(?=: |$)/, STALE_LISTED) : l)).join('\n');
}
