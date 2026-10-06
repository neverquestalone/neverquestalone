// A wowmap block that failed: what's wrong, the one line the player sees and the log line (public
// BYOK PRD §6.3, RT-3). The repair pass (a second paid call asking for a corrected block) is cut
// (systems plan D6): the player sees "Couldn't draw the map: …" and the reply's text stays.
//
// mapFailures(reply) says what's wrong with a reply's map blocks, as the app draws them
// (bridge/app/map-protocol.mjs extractMapBlocks and validateMapCommand): a line that isn't JSON, a command
// the validator drops (a bad layer name, an unknown op, a layer with no usable stop), stops dropped
// for want of a map id or position, and a block that isn't fenced on lines of its own or is never
// closed (map-protocol.mjs leaves those in the text). Budget clamps (the 400th point, notes past the
// layer's allowance) aren't failures. mapFailureLine gives the one line the player sees in game and
// mapFailureLog the log's; the core shows and logs them for the reply it renders.
import { sanitizeGameString } from './sanitize.mjs';
import { extractMapBlocks, validateMapCommand, MAP_LIMITS } from '../../app/map-protocol.mjs';

export const REPAIR_ERRORS_MAX = 6;
export const LINE_MAX = 160;

const FENCE_LINE = /^[ \t]{0,3}```/;
const MAP_OPEN = /^[ \t]{0,3}```wowmap/;
const BARE_CLOSE = /^[ \t]{0,3}```[ \t]*\r?$/;
// A line of a block that was never closed: JSON-looking, or blank. Prose after it stays.
const BLOCKISH = /^\s*(?:[{}[\]",]|$)/;
// A block opened mid-line; its body holds no other fence, and the close isn't another block's opener.
const INLINE_RE = /```wowmap[^\n]*\n((?:(?!```)[\s\S])*?)```(?!\w)/g;

/**
 * The wowmap blocks in a text, in order: [{start, end, body, closed, inline}] (offsets, end
 * exclusive). A block on lines of its own ends at its ``` line; one that's never closed ends before
 * the next fence or the first line that isn't JSON (so it never takes the next block with it).
 */
export function mapFences(text) {
  const s = String(text ?? '');
  const lines = s.split('\n');
  const at = [];
  let o = 0;
  for (const l of lines) { at.push(o); o += l.length + 1; }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!MAP_OPEN.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !FENCE_LINE.test(lines[j])) j++;
    if (j < lines.length && BARE_CLOSE.test(lines[j])) {
      out.push({ start: at[i], end: at[j] + lines[j].length, body: lines.slice(i + 1, j).join('\n'), closed: true, inline: false });
      i = j;
      continue;
    }
    let k = i + 1;
    while (k < j && BLOCKISH.test(lines[k])) k++;
    let e = k;
    while (e > i + 1 && !lines[e - 1].trim()) e--; // blank lines after it aren't the block's
    out.push({ start: at[i], end: at[e - 1] + lines[e - 1].length, body: lines.slice(i + 1, e).join('\n'), closed: false, inline: false });
    i = k - 1;
  }
  for (const m of s.matchAll(INLINE_RE)) {
    const start = m.index;
    if (out.some(f => start >= f.start && start < f.end)) continue;
    const lineStart = s.lastIndexOf('\n', start - 1) + 1;
    if (/^[ \t]{0,3}$/.test(s.slice(lineStart, start))) continue; // a line-start fence: found above
    out.push({ start, end: start + m[0].length, body: m[1], closed: true, inline: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What's wrong with a reply's wowmap blocks, as short lines for the model and the log ([] when nothing). */
export function mapFailures(reply) {
  const s = String(reply ?? '');
  const out = [];
  for (const f of mapFences(s)) {
    if (f.inline) out.push('a wowmap block was not on lines of its own (the opening fence must start a line)');
    else if (!f.closed) out.push('a wowmap block was never closed with a ``` line of its own');
  }
  const { cmds, errors } = extractMapBlocks(s);
  return [...out, ...commandFailures(cmds, errors)];
}

// Parse errors, then each command the validator drops or keeps only part of.
function commandFailures(cmds, errors) {
  const out = [...(Array.isArray(errors) ? errors.filter(e => typeof e === 'string') : [])];
  for (const c of Array.isArray(cmds) ? cmds : []) {
    // A command that can't even be looked at (JSON that shadows toString) is a failure, never a throw.
    try {
      const why = [];
      const v = validateMapCommand(c, why);
      const total = Array.isArray(c?.points) ? Math.min(c.points.length, MAP_LIMITS.pointsPerLayer) : 0;
      if (!v) {
        out.push(why.some(w => /no valid points/.test(w))
          ? `layer ${typeof c.layer === 'string' || typeof c.layer === 'number' ? String(c.layer).slice(0, 32) : '?'}: none of its ${plural(total, 'stop')} had a usable map id and position (m a whole number from 1 to ${MAP_LIMITS.mapIdMax}, x and y numbers)`
          : why[0] || 'a map command was dropped');
      } else if (v.op === 'set' && v.points.length < total) {
        out.push(`layer ${v.layer}: ${total - v.points.length} of ${plural(total, 'stop')} had no usable map id or position (m a whole number from 1 to ${MAP_LIMITS.mapIdMax}, x and y numbers)`);
      }
    } catch {
      out.push('a map command could not be read');
    }
  }
  return out.map(e => sanitizeGameString(e, LINE_MAX)).filter(Boolean);
}

// The failures from what the caller has: mapFailures' list, the raw reply, or renderReply's result
// (its parse errors and commands; the raw reply is better, since only it shows a misplaced fence).
function failuresOf(x) {
  if (Array.isArray(x)) return x.filter(e => typeof e === 'string' && e);
  if (typeof x === 'string') return mapFailures(x);
  if (x && typeof x === 'object' && (Array.isArray(x.mapCommands) || Array.isArray(x.mapErrors))) {
    return commandFailures(x.mapCommands, x.mapErrors);
  }
  return [];
}

/** The one line the player sees in game for a reply whose map blocks failed, or null when none did. */
export function mapFailureLine(failures) {
  const f = failuresOf(failures);
  if (!f.length) return null;
  const count = re => f.filter(x => re.test(x)).length;
  const parts = [];
  const unread = count(/^unreadable wowmap line/);
  if (unread) parts.push(`${plural(unread, 'line')} of it couldn't be read`);
  const stops = f.reduce((n, x) => n + Number((x.match(/: (\d+) of \d+ stops? had no usable/) || [])[1] || 0), 0);
  if (stops) parts.push(`${plural(stops, 'stop')} had no map position`);
  const layers = count(/bad layer name|unknown op|not an object|points must be an array|none of its|a map command/);
  if (layers) parts.push(`${plural(layers, 'layer')} couldn't be used`);
  if (count(/never closed|not on lines of its own/)) parts.push('the block was cut off or out of place');
  return sanitizeGameString(`Couldn't draw the map: ${parts.join('; ') || 'the block had a problem'}.`, LINE_MAX);
}

/**
 * The one line the player sees when the map was too big for the game (DREW-SY-04; map.mjs
 * fitMapBytes' result): which routes and marks were taken off, or what of the newest was left out.
 * Titles are the model's words, so they're sanitized; a layer without one goes by its name.
 */
export function mapTrimLine(fit) {
  if (!fit || !fit.changed) return null;
  const name = l => sanitizeGameString(String(l?.title || l?.name || ''), 40) || 'one';
  const list = xs => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
  const parts = [];
  const gone = (fit.dropped || []).map(name);
  if (gone.length > 3) parts.push(`the oldest ${gone.length} routes and marks were taken off it`);
  else if (gone.length) parts.push(`${list(gone)} ${gone.length === 1 ? 'was' : 'were'} taken off it`);
  if (fit.notes) parts.push('the stops\' notes were left out');
  if (fit.stops) parts.push(`only the first ${fit.stops.kept} of ${fit.stops.of} stops of ${name(fit.stops)} fit`);
  return sanitizeGameString(`The map was too big for the game, so ${parts.join('; ') || 'some of it was left out'}.`, LINE_MAX);
}

/** The log's line for the same: why, sanitized and capped (model text, never a key). */
export function mapFailureLog(failures) {
  const f = failuresOf(failures);
  return f.length ? sanitizeGameString(`map block failed: ${f.slice(0, REPAIR_ERRORS_MAX).join('; ')}`, 600) : null;
}
