// The capture watchdog (display design rev 5, Layer 2; DR-04): the one source of the slot's
// bridge.capture and of the app's screen state, and the one place that starts a capture helper over.
//
// Pure: no timers and no I/O. The core (service.mjs) feeds it and calls tick() every 2 s, on the
// timer that re-rings; boot passes it the supervisor (capture.mjs restart()) through
// setCaptureControl. Its outputs are the published state and two actions, restart(reason) and
// publish({ ring }).
//
//   createCaptureHealth({ platform, now, log, publish, changed, off, thresholds })
//     inputs:  status(ev)  a helper line: {stats} {permission} {window} {away} {connected} {error: null}
//              error(e)    a typed error: {kind, message, locked?, asleep?}
//              game(g)     {state: running|launched|exited|absent, pid}
//              record(r, via)   every record the core handles (its session's mode, hello, slot end)
//              strip(records)   a strip payload's records (R6; which session the strip carries)
//              write({ mtimeMs, first })  one SavedVariables write: its keyed records read there first (R4')
//              control({ restart, kind })  the supervisor, once boot has made it
//              tick(), reset()
//     outputs: state(), slot() (bridge.capture), pausesRering(), view() (the app's), info() (status().capture)
//
// The slot contract (bridge.caps += "capture"): bridge.capture = { state, since, cause? }, state one of
// CAPTURE_STATES. Everything the helpers or the addon say maps into it here, and nowhere else (SY-20):
//   permission:false                                    -> no_permission
//   capture_blocked_by_app                              -> blocked
//   helper_missing, signature_invalid, helper_failed x3 -> damaged
//   capture_unsupported                                 -> unsupported (its own state, SY-24: the app's
//                                                          "can't read this screen", never a restart)
//   blind (R4'), access_lost past its wait (not held),
//   window_offscreen, window_spans_displays, scaled     -> no_signal (cause: the kind, or "blind")
//   the host's switch off, no helper for this platform,
//   the newest session's mode stream or reload          -> off (never rung for)
//   held (Mac: off screen, hidden, asleep, locked; Windows: locked, window_minimized)
//                                                       -> never in the slot
// "ok" means no problem named, not "seen": nothing sent is nothing judged (design §7).
//
// The rules, checked at every tick (and at the events that move them):
//   R0  stats every 10 s (capture.mjs STATS_SEC), which R2 and R3 count in.
//   R1  a typed error publishes its state once it has lasted 3 s (Windows access_lost 10 s: the Mac
//       helper already waited 10 s before saying it, SY-28). A restart can fix access_lost (Mac only;
//       the Windows helper reopens by itself), no_permission (a new process sees a new grant) and
//       helper_failed; those restart on the backoff, each kind on its own. access_lost waits while
//       locked or asleep, and its wait starts again (10 s) when that ends. window_minimized is a hold:
//       never published.
//   R2  hung: the game runs, the helper's last word said attached, and no stats line for 30 s. Restart.
//   R3  stalled (Mac only): the game runs, attached, nothing holds, and two stats lines in a row with
//       no complete frame. Restart. (A minimized Windows WoW keeps attached with 0 frames.)
//   R4' blind: a SavedVariables write delivers a keyed record for the first time (the strip never
//       carried it) while the helper was attached, from before the write (the attach current at the
//       write's mtime, SY-22); that record's session drew the strip (pixel, its slots not at their
//       end); no typed error R1 owns lives; and it is the live session's record, or none is live. At
//       once: a restart and no_signal (blind), rung; then silent restarts on the backoff while it stays.
//   R6  the next strip payload clears what is published (blind, and any typed error). A helper's
//       "cleared", complete frames (for what a frame disproves), a new grant or a helper that connects
//       clear their own.
//   C   at most 6 rung state publishes per UI session (a new session's first hello starts one), the
//       ok included: a non-ok rings only while two are left (itself and its ok), and the ok that ends
//       a non-ok rings only if a non-ok rang. Past the cap a change is written unrung.
//   Backoff 0, 30 s, 2 min, 10 min, then every 10 min, per rule, reset by that rule's own proof
//   (SY-14f): a stats line (R2); complete frames (R3); for R1, per kind, the helper's cleared,
//   complete frames or the strip (access_lost), a grant, frames or the strip (no_permission), a
//   helper that connects (helper_failed); a keyed record or a hello off the strip (R4', never a seen
//   alone, SY-25). A stream start the watchdog only infers (a new Mac helper's window line) clears
//   access_lost but proves nothing yet, so a stream that keeps failing is started over less and less
//   often, and the frames that follow a real heal start its backoff over.
//   A hold never restarts, publishes or withdraws anything; a restart settles 5 s before another.
//   An episode (which session the strip carries: `live`) ends at a SavedVariables write (after R4'
//   has judged it), when the game exits, and at a game line with a new pid.
import { SLOT_COUNT } from './slots.mjs';

/** The slot's bridge.capture.state keys (the contract; the addon words each, a key it doesn't know names no cause). */
export const CAPTURE_STATES = Object.freeze(['ok', 'off', 'no_permission', 'no_signal', 'blocked', 'damaged', 'unsupported']);

/** The rules' numbers (design Layer 2's table); tests pass smaller ones through `thresholds`. */
export const HEALTH = Object.freeze({
  typedWaitMs: 3000,          // R1: a typed error that has lasted this long is published
  accessLostWaitMs: 10_000,   // R1: Windows access_lost, and any access_lost after a hold (SY-28)
  hungMs: 30_000,             // R2: 3 stats lines missed
  stallRuns: 2,               // R3: stats lines in a row with no complete frame
  failedRuns: 3,              // helper_failed this many times without a start that worked: damaged
  maxRings: 6,                // C
  holdLogMs: 5000,            // a hold is logged once it has lasted this long
  settleMs: 5000,             // one restart settles before another
  backoffMs: Object.freeze([0, 30_000, 120_000, 600_000]),
  keepSessions: 6,            // UI sessions remembered (their mode, hello, slot end)
  keepAttachMs: 600_000,      // how far back the attach history reaches (R4' judges a write's mtime)
});

/** A helper's typed kind -> the slot state it publishes (helper_failed: damaged after 3; others: none). */
export const KIND_STATE = Object.freeze({
  no_permission: 'no_permission',
  capture_blocked_by_app: 'blocked',
  helper_missing: 'damaged',
  signature_invalid: 'damaged',
  capture_unsupported: 'unsupported',
  access_lost: 'no_signal',
  window_offscreen: 'no_signal',
  window_spans_displays: 'no_signal',
  scaled: 'no_signal',
});
// When more than one is published, the slot names the one the player must fix first.
const RANK = Object.freeze({ no_permission: 5, damaged: 4, unsupported: 3, blocked: 2, no_signal: 1 });
// The kinds kept here: the contract's, helper_failed (damaged at the third) and window_minimized (a
// hold). Anything else says nothing about capture health: the window not found (the game is closed,
// or the helper still looks), a refused instance lock (the supervisor stops the holder, SY-15), an
// error line with no kind, a kind a later helper adds. The supervisor logs them all.
const KEPT = new Set([...Object.keys(KIND_STATE), 'helper_failed', 'window_minimized']);
// What a complete frame disproves: the stream runs, so it isn't lost, minimized, refused or unable to
// start. Not a window blocked from capture, nor a corner off screen or scaled: frames come and the
// strip still can't be read (DR-13: only a decode clears those).
const FRAME_CLEARS = new Set(['access_lost', 'window_minimized', 'no_permission', 'capture_unsupported', 'helper_missing', 'signature_invalid', 'helper_failed']);
// R1's restarts, each kind on its own backoff.
const RESTARTS = ['access_lost', 'no_permission', 'helper_failed'];
const MODES = new Set(['pixel', 'stream', 'reload']);
// What a window line may keep (no title, no path: a path can name the player's account).
const WINDOW_FIELDS = ['pid', 'scale', 'widthPt', 'heightPt', 'width', 'height', 'dpi', 'dpiAwareness', 'underExeDir', 'onScreen', 'active'];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// A keyed record or a hello: whole records the strip carried (a seen or a state alone is a few bytes).
const wholeRecord = r => isObj(r) && typeof r.type === 'string' && r.type !== 'seen' && r.type !== 'state';

export function createCaptureHealth({ platform = process.platform, now = () => Date.now(), log = () => {},
  publish = () => {}, changed = () => {}, off = () => false, thresholds = {} } = {}) {
  const T = { ...HEALTH, ...thresholds };
  const mac = platform === 'darwin';
  const win = platform === 'win32';
  let control = null;
  const rule = () => ({ step: 0, at: -Infinity });
  const S = {
    pub: { state: 'ok', cause: null, since: now() },
    dirty: false,              // a non-ok rang since the last ok: the ok that ends it rings
    rings: 0,                  // rung state publishes this UI session (C)
    connected: false, connectAt: 0,
    statsAt: 0, statsSeen: false, lastStats: null, framesUp: null, zeroRuns: 0,
    attached: false, attaches: [], // [{ from, to }], the latest last; to null while it lasts
    window: null,
    facts: { onScreen: null, hidden: false, asleep: false, locked: false }, // the Mac's hold facts
    away: null,                // the Windows away line: 'locked' | null
    errors: new Map(),         // live typed errors: kind -> { at, clockFrom, published, heldOnce }
    failed: 0,                 // helper_failed since a start that worked
    game: { running: false, pid: null },
    sessions: new Map(),       // token/nonce -> { mode, helloVia, slotEnd }
    newest: null,              // the session met last (its mode decides off)
    live: null,                // the session a strip record carried this episode
    blind: null,               // R4''s verdict, until the strip is read: { at, key }
    seenAt: 0,                 // the last strip payload
    backoff: { R2: rule(), R3: rule(), R4: rule(), ...Object.fromEntries(RESTARTS.map(k => [`R1 ${k}`, rule()])) },
    lastRestartAt: -Infinity,
    restarts: 0,
    hold: { reason: null, since: 0, logged: false },
    viewKey: '',
  };

  // ------------------------------------------------------------ facts
  function holdReason() {
    if (S.facts.locked || S.away === 'locked') return 'locked';
    if (S.facts.asleep) return 'asleep';
    if (S.errors.has('window_minimized')) return 'minimized';
    if (S.facts.hidden) return 'hidden';
    if (S.facts.onScreen === false) return 'offscreen';
    return null;
  }
  // A lock or a sleeping display explains a lost stream: access_lost waits while one holds.
  const accessHeld = () => S.facts.locked || S.facts.asleep || S.away === 'locked';
  const sessionMode = e => e?.mode ?? (e?.helloVia === 'reload' ? 'reload' : 'pixel');
  function isOff() {
    try { if (off()) return true; } catch { /* the host's switch reads as on */ }
    if (control?.kind === 'none') return true;
    const e = S.newest ? S.sessions.get(S.newest) : null;
    return !!e && sessionMode(e) !== 'pixel';
  }
  function stateOf(kind) {
    if (kind === 'helper_failed') return S.failed >= T.failedRuns ? 'damaged' : null;
    return KIND_STATE[kind] ?? null;
  }
  // A typed error R1 owns (a problem named, or on its way to being): R4' leaves those to R1. A hold
  // (window_minimized) isn't one: the player can't click Reload in a minimized game anyway.
  const ownedError = () => [...S.errors.keys()].some(k => k !== 'window_minimized');

  // ------------------------------------------------------------ attaches (R4', SY-22)
  const openAttach = () => { const a = S.attaches.at(-1); return a && a.to === null ? a : null; };
  function endAttach(t) { const a = openAttach(); if (a) a.to = t; }
  function startAttach(t) {
    endAttach(t);
    S.attaches.push({ from: t, to: null });
    while (S.attaches.length > 1 && (S.attaches.length > 64 || t - S.attaches[0].to > T.keepAttachMs)) S.attaches.shift();
  }
  // Was the helper attached at this moment, by an attach that began before it? The attach current
  // then, not now: a re-plan's window line between the write and the poll doesn't hide the write.
  function attachedAt(ms) {
    for (let i = S.attaches.length - 1; i >= 0; i--) {
      const a = S.attaches[i];
      if (a.from < ms) return a.to === null || a.to >= ms;
    }
    return false;
  }

  // ------------------------------------------------------------ typed errors
  function addError(kind) {
    if (S.errors.has(kind)) return; // said again (once a minute while it lasts): its clock runs on
    const t = now();
    S.errors.set(kind, { at: t, clockFrom: t, published: false, heldOnce: false });
  }
  function clearError(kind, why) {
    const e = S.errors.get(kind);
    if (!e) return false;
    S.errors.delete(kind);
    if (kind === 'helper_failed') S.failed = 0;
    if (e.published || e.heldOnce || kind === 'window_minimized') log('capture-clear', { kind, why });
    return true;
  }
  const clearAll = (why) => { for (const k of [...S.errors.keys()]) clearError(k, why); };
  // R1's proof, per kind (SY-14f): the next restart for it starts at the first step. The stream runs
  // (the helper's cleared, complete frames, the strip read): access_lost's; frames or the strip also
  // prove the grant, as the grant itself does: no_permission's; a helper that connects: helper_failed's.
  // Given whether the error still lives: a clear the watchdog only inferred (a new Mac helper's window
  // line) proved nothing, and the frames that come after it do.
  const proven = (...kinds) => { for (const k of kinds) S.backoff[`R1 ${k}`].step = 0; };

  // ------------------------------------------------------------ publishing
  function target() {
    if (isOff()) return { state: 'off', cause: null };
    let best = null;
    for (const [kind, e] of S.errors) {
      const st = e.published ? stateOf(kind) : null;
      if (st && (!best || RANK[st] > RANK[best.state])) best = { state: st, cause: kind };
    }
    if (best) return best;
    if (S.blind) return { state: 'no_signal', cause: 'blind' };
    return { state: 'ok', cause: null };
  }
  function recompute() {
    const t = target();
    const p = S.pub;
    if (t.state === p.state && t.cause === p.cause) return false;
    const moved = t.state !== p.state;
    let ring = false;
    if (moved && t.state === 'ok') ring = S.dirty && S.rings < T.maxRings;
    else if (moved && t.state !== 'off') ring = S.rings <= T.maxRings - 2;
    if (ring) S.rings += 1;
    if (t.state === 'ok') S.dirty = false;
    else if (ring) S.dirty = true;
    S.pub = { state: t.state, cause: t.cause, since: moved ? now() : p.since };
    log('capture-health', { from: p.state, to: t.state, ...(t.cause ? { cause: t.cause } : {}), rung: ring, ringsLeft: Math.max(0, T.maxRings - S.rings) });
    try { publish({ ring }); } catch (e) { log('capture-publish-error', { error: String(e?.message ?? e).slice(0, 120) }); }
    touch();
    return true;
  }
  function view() {
    const a = openAttach();
    return {
      state: S.pub.state, cause: S.pub.cause, since: S.pub.since,
      minimized: S.errors.has('window_minimized'),
      seen: !!a && S.seenAt >= a.from,
      game: S.game.running, connected: S.connected,
    };
  }
  // The app hears a change of what it shows, never a stats line (SY-10).
  function touch() {
    const v = view();
    const key = `${v.state}|${v.cause}|${v.minimized}|${v.seen}|${v.game}|${v.connected}`;
    if (key === S.viewKey) return;
    S.viewKey = key;
    try { changed(); } catch { /* a listener never breaks the bridge */ }
  }

  // ------------------------------------------------------------ restarts
  const waitAt = step => T.backoffMs[Math.min(step, T.backoffMs.length - 1)];
  const dueAt = name => { const b = S.backoff[name]; return b.at + waitAt(b.step); };
  function restartFor(name, reason) {
    const t = now();
    if (typeof control?.restart !== 'function') return false;
    if (t < dueAt(name) || t - S.lastRestartAt < T.settleMs) return false;
    const b = S.backoff[name];
    b.at = t;
    b.step += 1;
    S.lastRestartAt = t;
    S.restarts += 1;
    S.zeroRuns = 0;
    log('capture-restart', { rule: name, reason, step: b.step, nextInMs: waitAt(b.step) });
    // The supervisor logs it with the rule's words: "R1 access_lost", "R2 hung", "R4 blind".
    const words = name.startsWith('R1 ') ? name : `${name} ${reason}`;
    try { control.restart(words); } catch (e) { log('capture-restart-error', { error: String(e?.message ?? e).slice(0, 120) }); }
    return true;
  }
  function restartable(kind) {
    if (kind === 'access_lost') return !win && S.connected; // SY-28: the Windows helper reopens by itself; a hung one is R2's
    if (kind === 'no_permission') return S.connected;
    if (kind === 'helper_failed') return !S.connected;
    return false;
  }
  // R2 counts in stats lines, which the Mac and Windows helpers write (capture_x11.py writes none).
  const writesStats = () => mac || win || S.statsSeen;
  function checkHung() {
    if (!S.connected || !S.game.running || !S.attached || !writesStats()) return;
    const quiet = now() - Math.max(S.statsAt, openAttach()?.from ?? 0, S.connectAt);
    if (quiet < T.hungMs) return;
    if (restartFor('R2', 'hung')) log('capture-hung', { quietMs: quiet, stats: S.lastStats });
  }
  function checkStall() {
    if (!mac || S.zeroRuns < T.stallRuns || isOff()) return;
    if (!S.connected || !S.game.running || !S.attached || holdReason()) { S.zeroRuns = 0; return; }
    const runs = S.zeroRuns;
    if (restartFor('R3', 'stalled')) log('capture-stalled', { runs, stats: S.lastStats });
  }
  function checkHold() {
    const r = holdReason();
    const h = S.hold;
    if (r !== h.reason) {
      if (h.logged) log('capture-hold', { reason: null, was: h.reason, lastedMs: now() - h.since });
      S.hold = { reason: r, since: now(), logged: false };
      return;
    }
    if (r && !h.logged && now() - h.since >= T.holdLogMs) { h.logged = true; log('capture-hold', { reason: r }); }
  }
  function endEpisode(why) {
    if (S.live) log('capture-episode', { ended: why });
    S.live = null;
  }

  // ------------------------------------------------------------ helper lines
  const pickWindow = w => Object.fromEntries(WINDOW_FIELDS.filter(k => ['number', 'string', 'boolean'].includes(typeof w[k])).map(k => [k, w[k]]));
  function onConnected(up) {
    if (up) {
      S.connected = true;
      S.connectAt = now();
      // A helper that started: whatever kept the last one from starting is over.
      for (const k of ['helper_missing', 'signature_invalid', 'helper_failed']) clearError(k, 'connected');
      S.failed = 0;
      proven('helper_failed');
    } else {
      S.connected = false;
      endAttach(now());
      S.attached = false;
      S.zeroRuns = 0;
    }
  }
  function onStats(st) {
    const t = now();
    S.statsAt = t;
    S.statsSeen = true;
    S.lastStats = { ...st, at: t };
    S.backoff.R2.step = 0; // R2's proof
    // The Mac's hold facts, read when the line was written (DR-02): the newest line that carries one wins.
    for (const k of ['hidden', 'asleep', 'locked']) if (typeof st[k] === 'boolean') S.facts[k] = st[k];
    if (typeof st.onScreen === 'boolean') S.facts.onScreen = st.onScreen;
    const attached = st.attached === true;
    if (attached && !openAttach()) startAttach(t); // attached with no window line (a Windows reopen)
    if (!attached) endAttach(t);
    S.attached = attached;
    const frames = Number(st.interval?.frames);
    const up = Number.isFinite(frames) && frames > 0;
    if (up !== S.framesUp) {
      S.framesUp = up;
      log('capture-stats', { frames: Number.isFinite(frames) ? frames : null, decoded: st.interval?.decoded ?? null, rejected: st.interval?.rejected ?? null,
        attached, held: holdReason() ?? undefined, frameScale: st.frameScale, streamScale: st.streamScale });
    }
    if (up) {
      // Complete frames: R3's proof, and what a frame disproves is over (the stream runs).
      S.zeroRuns = 0;
      S.backoff.R3.step = 0;
      proven('access_lost', 'no_permission');
      for (const k of [...S.errors.keys()]) if (FRAME_CLEARS.has(k)) clearError(k, 'frames');
    } else if (mac && S.game.running && attached && !holdReason()) S.zeroRuns += 1;
    else S.zeroRuns = 0;
    checkHold();
    checkStall();
  }
  function onWindow(w) {
    S.window = pickWindow(w);
    startAttach(now());
    S.attached = true;
    // A Mac window line is a stream that started: a lost one is back, as far as the line says (a new
    // helper never says cleared for its predecessor's loss). Frames or the strip prove it (proven).
    if (mac) clearError('access_lost', 'attached');
  }

  const api = {
    // ---------------------------------------------------------- inputs
    /** A helper line through the supervisor's onStatus. */
    status(ev) {
      if (!isObj(ev)) return;
      if (typeof ev.connected === 'boolean') onConnected(ev.connected);
      else if (isObj(ev.stats)) onStats(ev.stats);
      else if (Object.hasOwn(ev, 'away')) { S.away = ev.away === 'locked' ? 'locked' : null; checkHold(); }
      else {
        if (ev.permission === false) addError('no_permission');
        else if (ev.permission === true) { clearError('no_permission', 'granted'); proven('no_permission'); }
        if (isObj(ev.window)) onWindow(ev.window);
        if (Object.hasOwn(ev, 'error') && ev.error === null) { clearAll('cleared'); proven('access_lost'); }
      }
      recompute();
      touch();
    },
    /** A typed error through the supervisor's onError. */
    error(e) {
      const kind = typeof e?.kind === 'string' ? e.kind : 'capture_error';
      // What the line says holds capture (the Mac's access_lost, SY-18).
      if (typeof e?.locked === 'boolean') S.facts.locked = e.locked;
      if (typeof e?.asleep === 'boolean') S.facts.asleep = e.asleep;
      if (kind === 'helper_failed') S.failed += 1;
      if (KEPT.has(kind)) addError(kind);
      checkHold();
      recompute();
      touch();
    },
    /** The game's lines (the helper's, and the core's own pid check). */
    game({ state, pid } = {}) {
      if ((state === 'running' || state === 'launched') && Number.isInteger(pid)) {
        if (S.game.pid !== null && pid !== S.game.pid) endEpisode('new pid');
        S.game = { running: true, pid };
      } else if (state === 'exited') {
        // An older process ending (a leftover window's) while the game runs on says nothing.
        if (Number.isInteger(pid) && S.game.pid !== null && pid !== S.game.pid) return;
        S.game = { running: false, pid: null };
        // No game, no window to be attached to (a helper that stops its stats with the game closed
        // says no more; SY-30), and the strip carried that game's session.
        endAttach(now());
        S.attached = false;
        endEpisode('exited');
      } else if (state === 'absent') S.game = { running: false, pid: null };
      touch();
    },
    /** Every record the core handles: its UI session's mode, how its hello came, whether its slots ran out. */
    record(r, via) {
      if (!isObj(r) || typeof r.nonce !== 'string' || typeof r.token !== 'string') return;
      const key = `${r.token}/${r.nonce}`;
      let e = S.sessions.get(key);
      if (!e) {
        e = { mode: null, helloVia: null, slotEnd: false };
        S.sessions.set(key, e);
        S.newest = key;
        while (S.sessions.size > T.keepSessions) S.sessions.delete(S.sessions.keys().next().value);
      }
      const a = isObj(r.args) ? r.args : {};
      if (r.type === 'hello') {
        // A new UI session's first hello starts its ring count (C). Its hello read again (the strip
        // shows it up to 20 s; SavedVariables keeps the last session's until the next write) doesn't.
        if (!e.helloVia) { e.helloVia = via === 'reload' ? 'reload' : 'strip'; S.rings = 0; }
        if (String(a.slots) === '0') e.slotEnd = true;
      }
      if (MODES.has(a.mode)) e.mode = a.mode;
      const slot = Number(a.slot);
      if (Number.isInteger(slot) && slot > SLOT_COUNT) e.slotEnd = true; // past the pool: the reload fallback
      recompute();
      touch();
    },
    /** A strip payload, after its records were handled: R6, and the session the strip carries. */
    strip(records = []) {
      const t = now();
      S.seenAt = t;
      let proof = false;
      for (const r of Array.isArray(records) ? records : []) {
        if (!isObj(r)) continue;
        if (wholeRecord(r)) proof = true;
        if (typeof r.nonce === 'string' && typeof r.token === 'string') S.live = `${r.token}/${r.nonce}`;
      }
      // R4''s backoff starts over only on a keyed record or a hello: a short seen that decodes while
      // longer records don't (a region too narrow) must not restart the helper at every message (SY-25).
      if (proof) S.backoff.R4.step = 0;
      proven('access_lost', 'no_permission');
      if (S.blind) { log('capture-seen', { after: 'blind', ms: t - S.blind.at }); S.blind = null; }
      clearAll('strip');
      recompute();
      touch();
    },
    /** One SavedVariables write, once all its records are handled: R4', then the episode ends. */
    write({ mtimeMs, first = [] } = {}) {
      const mtime = Number(mtimeMs);
      let verdict = null;
      const list = Array.isArray(first) ? first : [];
      if (list.length && Number.isFinite(mtime) && !isOff() && attachedAt(mtime) && !ownedError()) {
        for (const r of list) {
          if (!isObj(r)) continue;
          const key = `${r.token}/${r.nonce}`;
          const e = S.sessions.get(key);
          if (sessionMode(e) !== 'pixel' || e?.slotEnd) continue; // it never drew the strip for this
          if (S.live && S.live !== key) continue; // another client's, while the strip carries this one's (§7)
          verdict = { key: typeof r.key === 'string' ? r.key : null };
          break;
        }
      }
      endEpisode('write');
      if (!verdict) return false;
      log('capture-blind', { reason: 'reload', key: verdict.key, stats: S.lastStats, window: S.window });
      if (!S.blind) S.blind = { at: now(), key: verdict.key };
      restartFor('R4', 'blind');
      recompute();
      touch();
      return true;
    },
    /** The supervisor: { restart(reason), kind } (capture.mjs). */
    control(c) {
      const next = isObj(c) ? c : null;
      // A new helper (or none: the app's Screen Reading off) starts afresh: no old errors or backoff.
      if (next !== control) { S.errors.clear(); S.blind = null; S.failed = 0; S.zeroRuns = 0; const t = now(); for (const b of Object.values(S.backoff)) { b.step = 0; b.at = t; } }
      control = next;
      recompute();
      touch();
    },
    tick() {
      checkHold();
      if (!isOff()) {
        // R1: a typed error that has lasted its wait is published, and restarted when a restart can fix it.
        for (const [kind, e] of [...S.errors]) {
          if (kind === 'window_minimized' || (kind === 'access_lost' && accessHeld())) {
            e.clockFrom = now();
            e.heldOnce = kind === 'access_lost' || e.heldOnce;
            continue;
          }
          const wait = kind === 'access_lost' && (win || e.heldOnce) ? T.accessLostWaitMs : T.typedWaitMs;
          if (now() - e.clockFrom < wait) continue;
          if (!e.published && stateOf(kind)) {
            e.published = true;
            log('capture-typed', { kind, lastedMs: now() - e.at });
          }
          if (restartable(kind)) restartFor(`R1 ${kind}`, kind);
        }
        checkStall();
        // R4''s later restarts: silent, while no_signal (blind) stays published and the game runs.
        if (S.blind && S.game.running && S.connected) restartFor('R4', 'blind');
      }
      checkHung(); // a helper that writes nothing is hung, whatever holds
      recompute();
      touch();
    },
    /**
     * The app's Restart screen reading (DR-06): its restart is each rule's first step, so the
     * watchdog's next one waits the backoff's next wait from now.
     */
    reset() {
      const t = now();
      for (const b of Object.values(S.backoff)) { b.step = 1; b.at = t; }
      S.lastRestartAt = t;
      S.restarts += 1;
      log('capture-reset', {});
    },

    // ---------------------------------------------------------- outputs
    state: () => S.pub.state,
    /** bridge.capture: { state, since (unix s), cause? }. */
    slot() {
      const p = S.pub;
      return { state: p.state, since: Math.floor(p.since / 1000), ...(p.cause && p.state !== 'ok' && p.state !== 'off' ? { cause: p.cause } : {}) };
    },
    /** D-29's bridge half: a blind strip can't answer a re-ring, and each one costs the addon a slot load. */
    pausesRering: () => S.pub.state === 'no_signal',
    /** What the app shows (DR-06): the published state and cause, a live window_minimized, a strip read since the attach. */
    view,
    /** status().capture and the diagnostics: the view, with what holds, the restarts and the last stats. */
    info() {
      const v = view();
      const pending = [];
      if (S.blind && S.game.running) pending.push(dueAt('R4'));
      for (const [kind, e] of S.errors) if (e.published && restartable(kind)) pending.push(dueAt(`R1 ${kind}`));
      if (mac && S.zeroRuns >= T.stallRuns) pending.push(dueAt('R3'));
      return {
        ...v, held: holdReason(), attached: S.attached, live: !!S.live,
        restarts: S.restarts, nextRestartAt: pending.length ? Math.max(now(), Math.min(...pending), S.lastRestartAt + T.settleMs) : null,
        ringsLeft: Math.max(0, T.maxRings - S.rings), lastStats: S.lastStats, window: S.window,
      };
    },
  };
  return api;
}
