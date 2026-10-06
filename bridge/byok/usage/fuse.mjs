// The public build's two money guards against a bug that loops (onboarding spec §9.9, PRD §9.4 and
// §10; DB26, T20; systems plan D4): the exceptions to "no limits on anything for public release"
// (maintainer, 2026-09-26), never quotas.
//
// AUTO_FUSE, the check-ins fuse: more than 10 automatic (companion) turns whose send times fall
// within a minute, or more than 60 within an hour, pause check-ins until the player's next typed
// message. Normal play reaches neither: events are at least 120 s apart (at most 30 an hour), and a
// double level-up is two in a minute. A loop at 9 a minute slipped under the minute alone (about
// 13,000 turns a day); the hour stops it after 60.
//
// TYPED_GUARD: more than 20 typed messages within a minute pause sending until the player presses
// Resume sending in the desktop app. A typed message can't end it: the loop is made of them.
//
// A check-in counts at its event's send time (the evt's at=, the addon's time(), PRD SL-4), not
// when it arrives, so a backlog that arrives at once (the reload path, capture or the bridge coming
// back) keeps the addon's 120 s spacing and never trips it. What it doesn't catch, by design (PRD
// TH4, R25): forged events with spaced-out at= times.
//
// Pure: the caller (service.mjs) says when a turn is about to start and at what time, keeps the
// state (snapshot(), across a restart) and decides what a held turn does (a check-in rides along
// with the next typed message; a typed message is answered with the paused line).

const WINDOW = (turns, windowMs) => Object.freeze({ turns, windowMs });
/** The check-ins fuse: a minute's window and an hour's. null turns it off. */
export const AUTO_FUSE = Object.freeze({ ...WINDOW(10, 60_000), hour: WINDOW(60, 3_600_000) });
/** The typed guard: machine speed. null turns it off. */
export const TYPED_GUARD = WINDOW(20, 60_000);

/** A window's span in a sentence: "a minute", "an hour", "5 minutes", "90 seconds". */
export function spanText(ms) {
  if (ms === 60_000) return 'a minute';
  if (ms === 3_600_000) return 'an hour';
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} hours`;
  if (ms % 60_000 === 0) return `${ms / 60_000} minutes`;
  return `${Math.round(ms / 1000)} seconds`;
}

/**
 * The Check-ins chat's one line when the fuse pauses (PRD §10), in STYLE's words: check-ins,
 * and what turns them back on (PUI-01). One line whatever the limits, whichever window tripped
 * (the minute's or the hour's); the desktop app's status names the window (status-view.mjs).
 */
export function autoPausedLine(name) {
  return `${name || 'NeverQuestAlone'} paused check-ins: your next message turns them back on.`;
}

/** The typed guard's line: {headline, detail}; the desktop app has the Resume sending button. */
export function sendPausedLine(by = TYPED_GUARD) {
  const turns = by?.turns ?? TYPED_GUARD.turns;
  const ms = by?.windowMs ?? TYPED_GUARD.windowMs;
  return { headline: 'Sending is paused.', detail: `More than ${turns} messages went in ${spanText(ms)}, which normal play doesn't do.` };
}

const isTime = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = v => (Number.isInteger(v) && v >= 0 ? v : 0);
const valid = w => !!w && Number.isInteger(w.turns) && w.turns > 0 && isTime(w.windowMs) && w.windowMs > 0;

/** The windows a fuse's options name: {turns, windowMs}, its `hour`, and any `windows` list. */
export function windowsOf(o) {
  if (!o || typeof o !== 'object') return [];
  return [o, o.hour, ...(Array.isArray(o.windows) ? o.windows : [])].filter(valid).map(w => WINDOW(w.turns, w.windowMs));
}

/**
 * createAutoFuse({turns, windowMs, hour?, windows?, now, state}) → {allow(atMs), reset(), paused,
 * pausedBy, trips, held, snapshot()} (null, or no window with whole turns: off, and allow() is
 * always true). The typed guard is the same machine with TYPED_GUARD.
 *
 * allow(atMs) records a turn about to start at its send time (ms; not a finite number: now()) and
 * returns false when it would be one more than a window's turns whose send times fall within that
 * window. From then on `paused` is true (pausedBy: that window) and every allow() is false (each one
 * counted in `held`) until reset(). reset() ends a pause and starts afresh; it returns whether it
 * was paused. snapshot() is the state as plain JSON, which `state` takes back (a restart keeps the
 * windows and a pause).
 */
export function createAutoFuse(opts = AUTO_FUSE) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const wins = windowsOf(o);
  const on = wins.length > 0;
  const longest = on ? Math.max(...wins.map(w => w.windowMs)) : 0;
  const most = on ? Math.max(...wins.map(w => w.turns)) : 0;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  const s = o.state && typeof o.state === 'object' ? o.state : {};
  let times = on && Array.isArray(s.times) ? s.times.filter(isTime).sort((a, b) => a - b).slice(-(most + 1)) : [];
  let paused = on && s.paused === true;
  let pausedAt = paused && isTime(s.pausedAt) ? s.pausedAt : null;
  let pausedBy = paused ? (wins.find(w => w.turns === s.by?.turns && w.windowMs === s.by?.windowMs) ?? wins[0]) : null;
  let trips = count(s.trips);
  let held = paused ? count(s.held) : 0;

  // The most send times one window of `ms` holding `at` takes: a window that holds the most starts
  // at one of them, at or before `at`.
  function busiest(all, at, ms) {
    let top = 0;
    for (let i = 0; i < all.length && all[i] <= at; i++) {
      if (at - all[i] >= ms) continue;
      let k = 0;
      for (let j = i; j < all.length && all[j] - all[i] < ms; j++) k += 1;
      if (k > top) top = k;
    }
    return top;
  }

  function allow(atMs) {
    if (!on) return true;
    if (paused) { held += 1; return false; }
    // Never a send time ahead of the clock: not this one, and none kept from before a clock was set back.
    const t = now();
    const at = isTime(atMs) ? Math.min(atMs, t) : t;
    const all = [...times.filter(x => x <= t), at].sort((a, b) => a - b);
    const tripped = wins.find(w => busiest(all, at, w.windowMs) > w.turns);
    if (tripped) {
      paused = true;
      pausedAt = t;
      pausedBy = tripped;
      trips += 1;
      held = 1;
      times = [];
      return false;
    }
    // Only what a later send time can still share a window with.
    const newest = all[all.length - 1];
    times = all.filter(x => newest - x < longest).slice(-(most + 1));
    return true;
  }

  function reset() {
    const was = paused;
    paused = false;
    pausedAt = null;
    pausedBy = null;
    held = 0;
    times = [];
    return was;
  }

  return {
    allow,
    reset,
    get on() { return on; },
    get paused() { return paused; },
    /** The window that tripped ({turns, windowMs}) while paused, else null. */
    get pausedBy() { return pausedBy ? { ...pausedBy } : null; },
    get pausedAt() { return pausedAt; },
    get trips() { return trips; },
    get held() { return held; },
    snapshot: () => (on ? { times: [...times], paused, ...(paused ? { pausedAt, held, by: { ...pausedBy } } : {}), trips } : { trips }),
  };
}
