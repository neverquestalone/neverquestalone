// The player's own daily spend cap, checked in the bridge before every call (PRD §9.2, §9.4, DB8,
// US-6), and the totals the app shows (§9.2: per day, per session, per provider). The public build
// sets no usage limits of its own (maintainer, 2026-09-26: "no limits on anything for public release"):
// no daily spend cap by default, no typed-message cap, no automatic-turn cap. What stays: the cap
// the player may set in the desktop app (dailyUsd, null = none, never pre-filled), and the per-turn
// ceiling of 20,000 input / 1,200 reply tokens (the size of one request, a technical bound), with the
// thinking level's room on top of the reply (runtime/context.mjs, THINK_ROOM: 65,536 at Max, never
// past the model's own output ceiling).
//
// The accounting is the usage history (usage/history.mjs), the one store of daily totals (systems
// plan D6): a turn is booked there once, when it's over, at what it cost (or at its estimate when the
// cost can't be known). With a cap, a paid turn is refused when
//   today's spend + this turn's estimate > cap        (cap_spend)
// Turns running at the same moment aren't counted until they're over, so a cap can be passed by what
// those cost: at most 2 at once (runqueue.mjs), each at most its estimate at the per-turn ceiling:
// about $0.11 on the default Claude Sonnet 5.5 at Low, and about $3.74 on the dearest model at its
// highest level (Claude Fable 5.1 at Max, SY-102-6's room), so at most about $7.48. A turn whose
// reply came back empty and out of room may try once more with more room (backend.mjs
// roomForRetry): that try is checked against the cap first, with what the turn spent so far. A
// turn the provider may have billed when the app stopped is booked at its estimate at the next
// start, from the run ledger (backend.mjs). A turn marked free (a local or $0 price) is never refused, and a paid turn with a 0
// estimate is an error, never a free pass. Typed and automatic (check-in) turns are counted apart,
// never capped.
//
// A history that couldn't be read at start: today's spend isn't known, so a cap the player set holds
// that day as reached until the player acknowledges it (the cap never fails open). With no cap there's
// nothing to hold, until the player sets one that day. The snapshot says why (held: 'load_error'), and
// the player's own cap change in the app acknowledges it (backend.mjs setConfig; code health BR-09: no
// caller did, so every paid turn was refused for the rest of that day).
import { MICROS_PER_USD, turnTokens } from './meter.mjs';
import { TIER_REACH } from './prices.mjs';
import { createUsageHistory, localDay } from './history.mjs';

export { localDay };

// dailyUsd: the player's own daily spend cap in USD, or null for none (the default: never pre-filled).
export const CAP_DEFAULTS = Object.freeze({ dailyUsd: null, perTurnInput: 20000, perTurnOutput: 1200 });
export const TURN_KINDS = Object.freeze(['typed', 'auto']);

/** The next local midnight after `ms` (when today's totals, and a cap the player set, start over). */
export function nextLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/**
 * Caps config with every field valid: a bad or missing field keeps `base`'s value (the defaults
 * unless given). dailyUsd null is "no cap" (a value, not a bad one). The input ceiling can be set
 * lower, never above TIER_REACH (no request may reach a long-context price). Fields from before the
 * public build dropped its own limits (typedPerDay, autoPerDay) are ignored.
 */
export function normalizeCapsConfig(c = {}, base = CAP_DEFAULTS) {
  const src = c && typeof c === 'object' ? c : {};
  const usd = (v, d) => (v === null ? null : Number.isFinite(v) && v >= 0 ? v : d);
  const n = (v, d, max = Infinity) => (Number.isInteger(v) && v >= 0 && v <= max ? v : d);
  return {
    dailyUsd: usd(src.dailyUsd, base.dailyUsd ?? null),
    perTurnInput: n(src.perTurnInput, base.perTurnInput, TIER_REACH),
    perTurnOutput: n(src.perTurnOutput, base.perTurnOutput),
  };
}

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);
const plain = byProvider => Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, { ...v }]));
const newSession = at => ({ since: at, spentMicros: 0, turns: 0, auto: 0, estimated: 0, byProvider: Object.create(null) });

function toMicros(v, what) {
  if (!Number.isFinite(v) || v < 0) throw new TypeError(`caps: ${what} must be a non-negative number of micro-dollars`);
  return Math.ceil(v);
}

/**
 * createCaps({history, config, now, log}) → history: usage/history.mjs's store (default: one in
 * memory).
 *   check(est, kind) → 'cap_spend' when a turn like this would pass a cap the player set now, else
 *       null. est is estimateTurn's {estMicros, free}, or a number of micro-dollars; throws on a paid
 *       turn without an estimate above 0
 *   book(row) → the row as kept: a turn that's over ({chatId, provider, model, in, out, micros,
 *       exact, auto?, error?}), into the history and this session's totals
 *   snapshot() · details() · startSession() · acknowledgeLoadError() · config() · setConfig(partial)
 *   fitsTurn(req)
 * now() returns epoch ms (or a Date).
 */
export function createCaps({ history = null, config = {}, now = Date.now, log = () => {} } = {}) {
  let cfg = normalizeCapsConfig(config);
  const clock = () => +now();
  const hist = history ?? createUsageHistory({ file: null, now: clock, log });
  // The player's cap in micro-dollars, or null: none set (the default).
  const capMicros = () => (cfg.dailyUsd === null ? null : Math.round(cfg.dailyUsd * MICROS_PER_USD));
  // The day that counts as at the cap until acknowledged: the history couldn't be read (only with a
  // cap then, or one set later that day).
  const loadDay = hist.loadError ? localDay(clock()) : null;
  let heldDay = loadDay !== null && cfg.dailyUsd !== null ? loadDay : null;
  let session = newSession(clock());

  function turnOf(est) {
    const a = typeof est === 'number' ? { estMicros: est } : isObj(est) ? est : {};
    if (a.free === true) {
      if (a.estMicros !== undefined && a.estMicros !== 0) throw new TypeError('caps: a free turn costs nothing (estMicros must be 0)');
      return { free: true, micros: 0 };
    }
    const micros = toMicros(a.estMicros, 'estMicros');
    if (micros === 0) throw new TypeError('caps: estMicros must be above 0; only a free turn (a local or $0 price, free: true) costs nothing');
    return { free: false, micros };
  }

  /** Would a turn like this pass a cap the player set, now? 'cap_spend', or null. */
  function check(est, kind = 'typed') {
    if (!TURN_KINDS.includes(kind)) throw new TypeError(`caps: unknown turn kind ${kind}`);
    const turn = turnOf(est);
    const cap = capMicros();
    if (turn.free || cap === null) return null;
    const day = localDay(clock());
    if (heldDay === day) return 'cap_spend';
    return hist.day(day).micros + turn.micros > cap ? 'cap_spend' : null;
  }

  /** A turn that's over, at what it cost (or its estimate): booked once. */
  function book(row = {}) {
    const r = hist.record({ ...row, micros: toMicros(row.micros ?? 0, 'micros') });
    if (!r) return null;
    session.spentMicros += r.micros;
    if (r.auto) session.auto += 1; else session.turns += 1;
    if (!r.exact) session.estimated += 1;
    const bp = (session.byProvider[r.provider] ??= { spentMicros: 0, turns: 0 });
    bp.spentMicros += r.micros;
    bp.turns += 1;
    return r;
  }

  /**
   * The slot's bridge.usage fields (§9.5): today's spend, typed and automatic turns, and capMicros
   * only when the player set a cap (absent: none).
   */
  function snapshot() {
    const day = localDay(clock());
    const d = hist.day(day);
    const cap = capMicros();
    const held = cap !== null && heldDay === day;
    return {
      day,
      spentMicros: held ? Math.max(d.micros, cap) : d.micros,
      ...(cap !== null ? { capMicros: cap } : {}),
      turns: d.turns,
      auto: d.auto,
      exact: !held && d.estimated === 0,
      // Why the cap counts as reached when it isn't by today's spend: the history couldn't be read (BR-09).
      ...(held ? { held: 'load_error' } : {}),
    };
  }

  const sessionView = () => ({ ...session, byProvider: plain(session.byProvider) });
  const providerView = byProvider => Object.fromEntries(Object.entries(byProvider).map(([k, v]) => [k, { spentMicros: v.micros, turns: v.turns }]));

  /** Everything the app's usage page shows: today, per provider, this session, the history's days. */
  function details() {
    const t = clock();
    const day = localDay(t);
    const d = hist.day(day);
    return {
      ...snapshot(),
      typed: d.turns,
      perTurnInput: cfg.perTurnInput,
      perTurnOutput: cfg.perTurnOutput,
      resetsAt: nextLocalMidnight(t),
      byProvider: providerView(d.byProvider),
      session: sessionView(),
      history: hist.days().map(x => ({ day: x.day, spentMicros: x.micros, turns: x.turns, auto: x.auto, exact: x.estimated === 0, byProvider: providerView(x.byProvider) })),
      loadError: hist.loadError,
      held: capMicros() !== null && heldDay === day ? 'load_error' : null,
      keptAs: hist.keptAs,
    };
  }

  /**
   * The per-turn ceiling (§9.4): the caller trims history first, then refuses. Takes a request or
   * counts. The output ceiling holds the reply (replyTokens); a thinking level's room comes on top of
   * it (runtime/context.mjs), and the estimate a cap is checked with counts all of it.
   */
  function fitsTurn(req) {
    const tk = turnTokens(req);
    return tk.inputTokens <= cfg.perTurnInput && tk.replyTokens <= cfg.perTurnOutput;
  }

  return {
    check,
    book,
    snapshot,
    details,
    fitsTurn,
    get history() { return hist; },
    /** A new game session: its totals start from 0. Returns the one that ended. */
    startSession() {
      const ended = sessionView();
      session = newSession(clock());
      return ended;
    },
    /** The player saw that the history was unreadable (the app's confirm): today's spend counts from here. */
    acknowledgeLoadError() {
      if (heldDay === null && !hist.loadError) return false;
      heldDay = null;
      hist.acknowledgeLoadError();
      return true;
    },
    config: () => ({ ...cfg }),
    /**
     * Change the player's cap (dailyUsd, null for none) or the per-turn ceiling; an invalid field
     * keeps its current value (never the default). A cap set on the day the history couldn't be read,
     * before the player acknowledged it, holds that day as the cap at load does: the day's spend
     * before the load isn't known, so it can't count from 0 (it never fails open).
     */
    setConfig(partial = {}) {
      const next = normalizeCapsConfig(partial, cfg);
      const rejected = Object.keys(isObj(partial) ? partial : {}).filter(k => Object.hasOwn(CAP_DEFAULTS, k) && partial[k] !== next[k]);
      if (rejected.length) log('caps_config_rejected', { fields: rejected });
      if (hist.loadError && loadDay !== null && heldDay === null && next.dailyUsd !== null) heldDay = loadDay;
      cfg = next;
      return { ...cfg };
    },
  };
}
