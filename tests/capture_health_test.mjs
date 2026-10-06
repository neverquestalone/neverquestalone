// The capture watchdog (bridge/transport/capture-health.mjs; display design rev 5 Layer 2, DR-04):
// its rules as timelines on a fake clock, every rung and hold: R1 typed errors (with SY-24's own
// unsupported state and SY-28's Windows access_lost wait), R2 hung, R3 stalled (Mac only), R4' blind at
// the player's Reload (with SY-22's attach at the write's mtime), R6 clear, the cap of 6 rung publishes
// per UI session, the holds, the backoff and its resets (SY-14f, SY-25), the episode ends, the mode per
// UI session (SY-12, SY-17b) and the logs. Pure: no timers, no files; each case drives the module the
// way service.mjs does (record() per record, then strip() or write()) and ticks it every 2 s.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCaptureHealth, CAPTURE_STATES, KIND_STATE, HEALTH } from '../bridge/transport/capture-health.mjs';

const TOKEN = '3fa9c2d1';
const T0 = 1_800_000_000_000;
const KEYED = new Set(['msg', 'stop', 'patch', 'forget', 'evt', 'upd']);

/** A record as parseRecord gives it (only what the watchdog reads). */
let seq = 0;
function rec(nonce, type = 'msg', args = {}, token = TOKEN) {
  return { token, nonce, type, key: KEYED.has(type) ? `${nonce}_${++seq}` : nonce, args: { cur: '0', ...args } };
}
const hello = (nonce, args = {}) => rec(nonce, 'hello', { sig: 'ok', slot: 3, ...args });

/**
 * The watchdog on a fake clock, wired as the core wires it, with the supervisor's restart recorded.
 * pubs: every publish ({ring, state, cause}); restarts: every restart asked for.
 */
function rig({ platform = 'darwin', off = () => false, kind = null, thresholds } = {}) {
  const clock = { t: T0 };
  const logs = [];
  const pubs = [];
  const restarts = [];
  let changes = 0;
  const h = createCaptureHealth({
    platform, now: () => clock.t, log: (k, d) => logs.push({ k, ...d }), off, thresholds,
    publish: ({ ring }) => pubs.push({ ring, ...h.slot(), at: clock.t }),
    changed: () => { changes += 1; },
  });
  h.control({ kind: kind ?? (platform === 'win32' ? 'windows-helper' : 'mac-app'), restart: reason => restarts.push({ reason, at: clock.t }) });
  const r = {
    h, clock, logs, pubs, restarts,
    changes: () => changes,
    rings: () => pubs.filter(p => p.ring),
    state: () => h.state(),
    /** Time passes: a tick every 2 s, and the helper's stats line every 10 s (stats: false for none). */
    run(ms, s = {}) {
      const { every = 10_000, stats = true, ...line } = s;
      let since = 0;
      for (let e = 0; e < ms; e += 2000) {
        const step = Math.min(2000, ms - e);
        clock.t += step;
        since += step;
        if (stats && since >= every) { since = 0; r.stats(line); }
        h.tick();
      }
      return r;
    },
    /** One stats line (the Mac's shape: interval counts, attached, the hold facts). */
    stats({ frames = 40, decoded = 0, attached = true, ...facts } = {}) {
      h.status({ stats: { interval: { frames, decoded, rejected: 0 }, frames: 9000, decoded: 12, rejected: 0, attached,
        ...(platform === 'darwin' ? { hidden: false, asleep: false, locked: false, onScreen: true } : {}), ...facts } });
      return r;
    },
    /** The helper connects, the game runs, the window is attached. */
    up({ pid = 4242, scale = 2 } = {}) {
      h.status({ connected: true });
      h.game({ state: 'running', pid });
      h.status({ permission: true });
      h.status({ window: { pid, scale, widthPt: 1728, heightPt: 1117, title: 'World of Warcraft', path: '/Users/someone/wow' } });
      return r;
    },
    /** A strip payload: the core's record() for each, then strip(). */
    strip(...recs) { for (const x of recs) h.record(x, 'strip'); h.strip(recs); return r; },
    /** A SavedVariables write at mtime: record() for each, the keyed ones read first here, then write(). */
    write(mtimeMs, recs, { dup = [] } = {}) {
      const first = [];
      for (const x of recs) {
        h.record(x, 'reload');
        if (KEYED.has(x.type) && !dup.includes(x.key)) first.push({ token: x.token, nonce: x.nonce, key: x.key, type: x.type });
      }
      return h.write({ mtimeMs, first });
    },
  };
  return r;
}

// ------------------------------------------------------------ the contract

test('the contract: seven state keys, each helper kind to its state (capture_unsupported its own, SY-24), minimized and unknown gone (SY-20); the numbers', () => {
  assert.deepEqual([...CAPTURE_STATES], ['ok', 'off', 'no_permission', 'no_signal', 'blocked', 'damaged', 'unsupported']);
  assert.deepEqual(KIND_STATE, {
    no_permission: 'no_permission', capture_blocked_by_app: 'blocked', helper_missing: 'damaged', signature_invalid: 'damaged',
    capture_unsupported: 'unsupported', access_lost: 'no_signal', window_offscreen: 'no_signal', window_spans_displays: 'no_signal', scaled: 'no_signal',
  });
  for (const v of Object.values(KIND_STATE)) assert.ok(CAPTURE_STATES.includes(v), v);
  assert.ok(!CAPTURE_STATES.includes('minimized') && !CAPTURE_STATES.includes('unknown'));
  assert.equal(HEALTH.typedWaitMs, 3000);
  assert.equal(HEALTH.accessLostWaitMs, 10_000);
  assert.equal(HEALTH.hungMs, 30_000);
  assert.equal(HEALTH.stallRuns, 2);
  assert.equal(HEALTH.maxRings, 6);
  assert.deepEqual([...HEALTH.backoffMs], [0, 30_000, 120_000, 600_000]);
  const r = rig();
  assert.deepEqual(r.h.slot(), { state: 'ok', since: Math.floor(T0 / 1000) }, 'ok: no cause, the time it began');
  assert.equal(r.h.pausesRering(), false);
});

// ------------------------------------------------------------ R4' (blind), R6, the rings

test('H1, the 00:23Z incident: 40 frames an interval, none decoded, nothing unread: nothing until the Reload; at the Reload one restart and one rung no_signal (blind) at once; the new session\'s hello by strip gives a rung ok; 2 rings', () => {
  const r = rig().up();
  r.strip(hello('a1b2')); // session A's hello was read: the strip carried A
  r.run(5 * 60_000, { frames: 40, decoded: 0 }); // then blind (the scale change): frames, nothing decoded
  assert.equal(r.restarts.length, 0, 'nothing before the Reload: frames without a decode is also what "nothing to send" looks like');
  assert.equal(r.pubs.length, 0);
  assert.equal(r.state(), 'ok');
  const changes = r.changes();
  // The player sent, the line stuck, they clicked Reload: the write carries A's record for the first time.
  r.clock.t += 700;
  assert.equal(r.write(r.clock.t - 300, [rec('a1b2', 'msg')]), true);
  assert.equal(r.restarts.length, 1, 'one restart, at once');
  assert.deepEqual(r.pubs.map(p => [p.state, p.cause, p.ring]), [['no_signal', 'blind', true]]);
  assert.ok(r.changes() > changes, 'the app hears it');
  assert.equal(r.h.pausesRering(), true, 're-rings pause while it holds (D-29)');
  const blind = r.logs.find(l => l.k === 'capture-blind');
  assert.equal(blind.reason, 'reload');
  assert.deepEqual(blind.window, { pid: 4242, scale: 2, widthPt: 1728, heightPt: 1117 }, 'the window as it was: no title, no path');
  assert.equal(blind.stats.interval.frames, 40, 'the last stats');
  // The restarted helper reads the new session's hello (the strip keeps it up to 20 s): R6.
  r.h.status({ connected: false });
  r.run(3000, { stats: false });
  r.up();
  r.run(2000, { stats: false });
  r.strip(hello('c3d4'));
  assert.deepEqual(r.pubs.map(p => [p.state, p.ring]), [['no_signal', true], ['ok', true]]);
  assert.equal(r.rings().length, 2, 'two watchdog rings in all');
  assert.equal(r.h.pausesRering(), false);
  assert.equal(r.restarts.length, 1, 'no more restarts');
  assert.ok(r.logs.some(l => l.k === 'capture-seen' && l.after === 'blind'));
});

test('H1b: the restart doesn\'t help: no_signal stays, the helper is started over after 30 s, 2 min and 10 min more, ringing nothing; once capture reads again, the self-probe seen gives a rung ok', () => {
  const r = rig().up();
  r.strip(hello('a1b2'));
  r.run(20_000);
  assert.equal(r.write(r.clock.t - 500, [rec('a1b2', 'msg')]), true);
  const t0 = r.clock.t;
  r.run(13 * 60_000);
  assert.deepEqual(r.restarts.map(x => (x.at - t0) / 1000), [0, 30, 150, 750], '0, then 30 s, 2 min, 10 min apart');
  assert.ok(r.restarts.every(x => /^R4 blind$/.test(x.reason)));
  assert.equal(r.pubs.length, 1, 'the later restarts are silent');
  assert.equal(r.state(), 'no_signal');
  // Every 10 minutes after that.
  r.run(10 * 60_000);
  assert.equal(r.restarts.length, 5);
  assert.equal((r.restarts[4].at - r.restarts[3].at) / 60_000, 10);
  // Capture reads again: the addon's 60 s self-probe draws a seen, which clears it.
  r.strip(rec('a1b2', 'seen', { p: 3 }));
  assert.deepEqual(r.pubs.map(p => [p.state, p.ring]), [['no_signal', true], ['ok', true]]);
});

test('H7, slot-only: a session whose hello said sig=sound-off still draws its records on the strip, so its Reload\'s first-time record is R4\', as in H1', () => {
  const r = rig().up();
  r.strip(hello('b0b0', { sig: 'sound-off', mode: 'pixel' }));
  r.run(20_000);
  assert.equal(r.write(r.clock.t - 1, [rec('b0b0')]), true);
  assert.deepEqual(r.pubs.map(p => [p.state, p.cause, p.ring]), [['no_signal', 'blind', true]]);
  assert.equal(r.restarts.length, 1);
});

test('H8: reload mode is off (written, never rung); H8b: a session switched to stream mid-session (its seen with mode=stream, by strip or outbox): its later Reloads\' first-time records fire nothing', () => {
  const r = rig().up();
  r.strip(hello('0e0e', { mode: 'reload' }));
  assert.equal(r.state(), 'off');
  assert.deepEqual(r.pubs.map(p => [p.state, p.ring]), [['off', false]], 'off is never rung for');
  assert.equal(r.write(r.clock.t, [rec('0e0e')]), false, 'reload mode: every record comes by Reload');
  // A pixel session, then Screen Reading turned off mid-session: its seen says mode=stream.
  for (const via of ['strip', 'outbox']) {
    const s = rig().up();
    s.strip(hello('5e55', { mode: 'pixel' }));
    s.run(20_000);
    const seen = rec('5e55', 'seen', { mode: 'stream' });
    if (via === 'strip') s.strip(seen); else s.write(s.clock.t - 1, [seen]);
    assert.equal(s.state(), 'off', via);
    s.run(20_000);
    assert.equal(s.write(s.clock.t - 1, [rec('5e55'), rec('5e55')]), false, `${via}: stream mode's Reloads are no evidence`);
    assert.equal(s.restarts.length, 0, via);
    assert.ok(s.pubs.every(p => !p.ring), via);
  }
});

test('H8c, the mode fallback (SY-12): a hello without mode= read off the strip is pixel for R4\'; the same hello read from SavedVariables isn\'t; keyed records with no hello and no session live are pixel', () => {
  const byStrip = rig().up();
  byStrip.strip(rec('aa11', 'hello', { sig: 'ok' })); // an addon from before mode=
  byStrip.run(20_000);
  assert.equal(byStrip.write(byStrip.clock.t - 1, [rec('aa11')]), true);
  const byReload = rig().up();
  byReload.run(20_000);
  // A stream- or reload-mode addon puts its hello in the outbox: it came with the write.
  assert.equal(byReload.write(byReload.clock.t - 1, [rec('bb22', 'hello', { sig: 'ok' }), rec('bb22')]), false);
  assert.equal(byReload.state(), 'off', 'and the newest session doesn\'t draw the strip');
  const none = rig().up();
  none.run(20_000);
  assert.equal(none.write(none.clock.t - 1, [rec('cc33')]), true, 'blind from the start: no hello was ever read');
});

test('H8d, the mode per UI session (SY-17b): session A said mode=stream; session B, pixel and blind from the start, never had its hello read; B\'s first-time record is R4\' and the state is no longer off. A switched back to pixel on a blind strip: its seen (from the outbox) and first record, in either order, are R4\'', () => {
  const r = rig().up();
  r.write(r.clock.t - 60_000, [rec('a0a0', 'hello', { mode: 'stream' })]);
  r.run(20_000);
  assert.equal(r.state(), 'off');
  // /reload: session B, pixel, its hello strip-only and unread. Its message sticks; the player clicks Reload.
  assert.equal(r.write(r.clock.t - 1, [rec('b1b1')]), true);
  assert.equal(r.restarts.length, 1);
  assert.deepEqual(r.pubs.filter(p => p.ring).map(p => [p.state, p.cause]), [['no_signal', 'blind']]);
  assert.equal(r.state(), 'no_signal', 'no longer off: B draws the strip');
  for (const order of ['seen first', 'record first']) {
    const s = rig().up();
    s.write(s.clock.t - 60_000, [hello('a2a2', { mode: 'stream' })]);
    s.run(20_000);
    const seen = rec('a2a2', 'seen', { mode: 'pixel' });
    const msg = rec('a2a2');
    assert.equal(s.write(s.clock.t - 1, order === 'seen first' ? [seen, msg] : [msg, seen]), true, order);
    assert.equal(s.state(), 'no_signal', order);
  }
});

test('H10: R4\' with a typed error live (capture_blocked_by_app) adds nothing; with the helper not attached, nothing; a session out of slots (the reload fallback) is no evidence', () => {
  const r = rig({ platform: 'win32' }).up();
  r.strip(hello('d1d1'));
  r.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  r.run(4000);
  assert.equal(r.state(), 'blocked');
  const pubs = r.pubs.length;
  assert.equal(r.write(r.clock.t - 1, [rec('d1d1')]), false, 'R1 owns it');
  assert.equal(r.pubs.length, pubs);
  assert.equal(r.restarts.length, 0, 'blocked: the player fixes it, never a restart');
  // Not attached: a stats line said so (the stream stopped), and the write came after.
  const d = rig().up();
  d.strip(hello('d2d2'));
  d.stats({ attached: false, frames: 0 });
  d.run(5000, { stats: false });
  assert.equal(d.write(d.clock.t - 1, [rec('d2d2')]), false);
  const gone = rig().up();
  gone.h.status({ connected: false });
  gone.run(5000, { stats: false });
  assert.equal(gone.write(gone.clock.t - 1, [rec('e2e2')]), false, 'no helper: nothing watched the strip');
  // The addon's last slot is loaded (slot=201): it falls back to the reload path and hides the strip.
  const out = rig().up();
  out.strip(hello('f1f1'), rec('f1f1', 'seen', { slot: 201 }));
  out.run(20_000);
  assert.equal(out.write(out.clock.t - 1, [rec('f1f1')]), false);
  const none = rig().up();
  none.run(20_000);
  assert.equal(none.write(none.clock.t - 1, [rec('f2f2', 'hello', { slots: 0, mode: 'pixel' }), rec('f2f2')]), false, 'a hello with no free slot');
});

test('H10b, a second client: while session A is live, a write carrying session B\'s record is nothing; once the episode ends (the write itself, the game\'s exit, a new pid), any session\'s counts', () => {
  const r = rig().up();
  r.strip(hello('a0a0'));
  r.run(20_000);
  assert.equal(r.write(r.clock.t - 1, [rec('b0b0')]), false, 'the strip carries A: B is another client');
  assert.equal(r.write(r.clock.t - 1, [rec('b0b0')]), true, 'that write ended the episode');
  for (const end of ['exited', 'new pid']) {
    const s = rig().up();
    s.strip(hello('a0a0'));
    s.run(20_000);
    if (end === 'exited') { s.h.game({ state: 'exited', pid: 4242 }); s.h.game({ state: 'launched', pid: 5151 }); } else s.h.game({ state: 'running', pid: 5151 });
    s.h.status({ window: { pid: 5151, scale: 2 } });
    s.run(20_000);
    assert.equal(s.write(s.clock.t - 1, [rec('b0b0')]), true, end);
    assert.ok(s.logs.some(l => l.k === 'capture-episode' && l.ended === end), end);
  }
  // An older process's exit (a leftover window's pid) while the game runs on ends nothing.
  const old = rig().up({ pid: 5151 });
  old.strip(hello('a0a0'));
  old.h.game({ state: 'exited', pid: 4242 });
  old.run(20_000);
  assert.equal(old.write(old.clock.t - 1, [rec('b0b0')]), false);
});

test('H10c, whose writes count (SY-22): an old file read at startup, written before the helper attached, is nothing; a file first written after the attach (a fresh install\'s first Reload) is R4\'; a duplicate is nothing; a re-plan\'s window line between the write and the poll doesn\'t hide the write', () => {
  const r = rig();
  const oldMtime = T0 - 3_600_000;
  r.run(4000, { stats: false });
  r.up();
  r.run(20_000);
  assert.equal(r.write(oldMtime, [rec('0101'), rec('0101')]), false, 'written an hour before the attach: not watched');
  const first = rig().up();
  first.run(30_000);
  assert.equal(first.write(first.clock.t - 1500, [rec('0303')]), true, 'no hello read, no session live: the first Reload counts');
  const dup = rig().up();
  dup.strip(hello('0404'));
  dup.run(20_000);
  const m = rec('0404');
  assert.equal(dup.write(dup.clock.t - 1, [m], { dup: [m.key] }), false, 'read off the strip before: acked again, no evidence');
  // SY-22's nit: the write at t, a re-plan at t + 1 s (a new window line), the poll at t + 2 s.
  const nit = rig().up();
  nit.strip(hello('0505'));
  nit.run(20_000);
  const mtime = nit.clock.t;
  nit.clock.t += 1000;
  nit.h.status({ window: { pid: 4242, scale: 1 } });
  nit.clock.t += 1000;
  assert.equal(nit.write(mtime, [rec('0505')]), true, 'judged against the attach current at the write');
});

test('R6 and the ring cap (H9): capture_blocked_by_app on and off 5 times in one UI session: at most 6 rings, a non-ok rings only while there\'s room for its ok, an ok only after a rung non-ok, the rest written unrung with the latest state; a new hello nonce starts the count again', () => {
  const r = rig({ platform: 'win32' }).up();
  r.strip(hello('9a9a'));
  // Blocked, the Windows loop skips the grab: stats with no frame.
  for (let i = 0; i < 5; i++) {
    r.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
    r.run(4000, { frames: 0, every: 2000 });
    r.h.status({ error: null }); // the helper's "cleared"
    r.run(2000, { frames: 0, every: 2000 });
  }
  assert.deepEqual(r.pubs.map(p => `${p.state}${p.ring ? '!' : ''}`), ['blocked!', 'ok!', 'blocked!', 'ok!', 'blocked!', 'ok!', 'blocked', 'ok', 'blocked', 'ok']);
  assert.equal(r.rings().length, 6);
  assert.equal(r.h.info().ringsLeft, 0);
  r.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  r.run(4000, { frames: 0, every: 2000 });
  assert.deepEqual(r.h.slot(), { state: 'blocked', since: Math.floor(r.clock.t / 1000), cause: 'capture_blocked_by_app' }, 'the slot always has the latest');
  // A /reload: a new UI session, a new count. Its hello read off the strip clears what was published (R6).
  r.strip(hello('9b9b'));
  assert.deepEqual([r.pubs.at(-1).state, r.pubs.at(-1).ring], ['ok', false], 'that non-ok never rang, so its ok doesn\'t');
  r.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  r.run(4000, { stats: false });
  assert.equal(r.pubs.at(-1).ring, true, 'rung again in the new session');
});

test('H12: re-rings pause while no_signal is published (either cause) and come back with the ok', () => {
  const r = rig().up();
  r.strip(hello('1212'));
  r.run(20_000);
  r.write(r.clock.t - 1, [rec('1212')]);
  assert.equal(r.h.pausesRering(), true);
  r.strip(hello('1313'));
  assert.equal(r.h.pausesRering(), false);
  const w = rig({ platform: 'win32' }).up();
  w.h.error({ kind: 'access_lost', message: 'x' });
  w.run(12_000, { stats: false });
  assert.equal(w.state(), 'no_signal');
  assert.equal(w.h.pausesRering(), true);
  w.h.status({ error: null });
  assert.equal(w.h.pausesRering(), false);
});

test('H15: (a) a Windows no_signal (an overlay on the corner) clears at the self-probe seen once the overlay moves; (b) blocked needs no probe: the helper\'s cleared gives ok', () => {
  const a = rig({ platform: 'win32' }).up();
  a.strip(hello('1515'));
  a.run(20_000, { frames: 40 });
  a.write(a.clock.t - 1, [rec('1515')]);
  assert.equal(a.state(), 'no_signal');
  a.run(45_000, { frames: 40 });
  assert.equal(a.state(), 'no_signal', 'frames alone prove nothing');
  a.strip(rec('1515', 'seen', { p: 2 })); // the 60 s self-probe, now readable
  assert.equal(a.state(), 'ok');
  assert.equal(a.pubs.at(-1).ring, true);
  const b = rig({ platform: 'win32' }).up();
  b.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  b.run(4000, { stats: false });
  b.h.status({ error: null });
  assert.deepEqual(b.pubs.map(p => [p.state, p.ring]), [['blocked', true], ['ok', true]]);
});

test('H2 (SY-20): a helper restart publishes and rings nothing: the socket closes, the helper comes back 3 s later, its first stats have frames and none decoded; a typed window_minimized leaves the slot as it was', () => {
  const r = rig().up();
  r.strip(hello('2222'));
  r.run(60_000, { frames: 40, decoded: 1 });
  const slot = r.h.slot();
  r.h.status({ connected: false });
  r.run(3000, { stats: false });
  r.up();
  r.stats({ frames: 40, decoded: 0 });
  r.run(60_000, { frames: 40, decoded: 0 });
  assert.deepEqual(r.pubs, [], 'nothing published, nothing rung');
  assert.equal(r.state(), 'ok');
  assert.deepEqual(r.h.slot(), slot);
  const w = rig({ platform: 'win32' }).up();
  w.h.error({ kind: 'window_minimized', message: 'x' });
  w.run(60_000, { frames: 0 });
  assert.deepEqual(w.pubs, []);
  assert.equal(w.state(), 'ok');
});

// ------------------------------------------------------------ R1, typed errors

test('H11: the Mac\'s access_lost (the helper waited 10 s) publishes no_signal 3 s later and restarts; no_permission restarts on the backoff; capture_blocked_by_app is blocked, never restarted; cleared gives ok', () => {
  const r = rig().up();
  r.run(20_000);
  r.h.error({ kind: 'access_lost', message: 'screen reading stopped (-3815) and hasn\'t come back', locked: false, asleep: false });
  r.run(2000, { stats: false });
  assert.equal(r.state(), 'ok', 'not yet');
  r.run(2000, { stats: false });
  assert.deepEqual(r.pubs.map(p => [p.state, p.cause, p.ring]), [['no_signal', 'access_lost', true]]);
  assert.deepEqual(r.restarts.map(x => x.reason), ['R1 access_lost']);
  // The new helper's stream starts (its window line): the loss is over, though it never said it.
  r.h.status({ connected: false });
  r.run(4000, { stats: false });
  r.up();
  assert.equal(r.state(), 'ok');
  // Permission taken back: no_permission, and a fresh process (a restart) picks up a new grant.
  const p = rig().up();
  p.h.status({ permission: false });
  p.run(3000, { stats: false });
  assert.equal(p.state(), 'no_permission');
  const t0 = p.clock.t;
  p.run(3 * 60_000, { frames: 0, attached: false }); // no grant, no stream
  assert.deepEqual(p.restarts.map(x => (x.at - t0) / 1000), [0, 30, 150], 'at once, then 30 s, then 2 min');
  p.h.status({ permission: true });
  assert.equal(p.state(), 'ok');
  // blocked: the player's to fix.
  const b = rig({ platform: 'win32' }).up();
  b.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  b.run(10 * 60_000, { frames: 0 });
  assert.equal(b.state(), 'blocked');
  assert.equal(b.restarts.length, 0);
});

test('H11b (SY-28): a Windows access_lost cleared after 6 s (a mode change, Alt+Enter) publishes and restarts nothing; one that lasts is no_signal at 10 s and is never restarted (the helper reopens by itself)', () => {
  const r = rig({ platform: 'win32' }).up();
  r.h.error({ kind: 'access_lost', message: 'screen capture was interrupted' });
  r.run(6000, { stats: false });
  r.h.status({ error: null });
  r.run(60_000);
  assert.deepEqual(r.pubs, []);
  assert.deepEqual(r.restarts, []);
  const s = rig({ platform: 'win32' }).up();
  s.h.error({ kind: 'access_lost', message: 'x' });
  s.run(8000, { stats: false });
  assert.equal(s.state(), 'ok');
  s.run(2000, { stats: false });
  assert.equal(s.state(), 'no_signal');
  s.run(15 * 60_000, { frames: 0, attached: false }); // duplication lost: the helper reopens every 2 s
  assert.deepEqual(s.restarts, [], 'a hung Windows helper is R2\'s');
});

test('SY-24: capture_unsupported (a hybrid GPU\'s other adapter, too many capturers, no D3D11) is its own state, unsupported, with its cause, never no_signal and never restarted; a frame clears it', () => {
  const r = rig({ platform: 'win32' }).up();
  r.h.error({ kind: 'capture_unsupported', message: 'DXGI_ERROR_UNSUPPORTED' });
  r.run(3000, { stats: false });
  assert.deepEqual(r.h.slot(), { state: 'unsupported', since: Math.floor(r.clock.t / 1000), cause: 'capture_unsupported' });
  assert.equal(r.pubs[0].ring, true);
  assert.equal(r.h.pausesRering(), false, 'not no_signal');
  r.run(20 * 60_000, { frames: 0, attached: false });
  assert.equal(r.restarts.length, 0);
  r.stats({ frames: 30 }); // the helper's own retry (2 s, 10 s, 60 s) got a frame
  assert.equal(r.state(), 'ok');
});

test('what a frame disproves (DR-13): frames clear a lost stream, a minimized window, an unsupported screen or a refused grant, never a window blocked from capture (frames come and the strip still can\'t be read); the helper\'s cleared or the strip does', () => {
  const r = rig({ platform: 'win32' }).up();
  r.h.error({ kind: 'capture_blocked_by_app', message: 'excluded from screen capture' });
  r.run(4000, { frames: 0, every: 2000 });
  assert.equal(r.state(), 'blocked');
  r.run(60_000, { frames: 40 });
  assert.equal(r.state(), 'blocked', 'frames alone');
  r.h.status({ error: null });
  assert.equal(r.state(), 'ok', 'the helper said it cleared');
  const s = rig({ platform: 'win32' }).up();
  s.strip(hello('b1b1'));
  s.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  s.run(4000, { stats: false });
  s.strip(rec('b1b1', 'seen'));
  assert.equal(s.state(), 'ok', 'a strip read is the proof');
  for (const kind of ['access_lost', 'capture_unsupported', 'window_minimized']) {
    const k = rig({ platform: 'win32' }).up();
    k.h.error({ kind, message: 'x' });
    k.run(12_000, { stats: false });
    k.stats({ frames: 30 });
    assert.equal(k.state(), 'ok', kind);
    assert.equal(k.h.view().minimized, false, kind);
  }
});

test('R1\'s backoff per kind (SY-14f): a Mac stream that keeps failing after each restart is started over at once, then 30 s, then 2 min later: the new helper\'s window line clears access_lost but proves nothing; complete frames do, and the next loss is restarted at once', () => {
  const r = rig().up();
  r.run(20_000);
  const lost = () => r.h.error({ kind: 'access_lost', message: 'screen reading stopped (-3815) and hasn\'t come back', locked: false, asleep: false });
  // The helper restarted: its socket closes, it relaunches 3 s later, its stream starts (a window line)
  // and stops again; 10 s later it says access_lost again.
  const cycle = () => { r.h.status({ connected: false }); r.run(4000, { stats: false }); r.up(); r.stats({ frames: 0, attached: false }); r.run(10_000, { stats: false }); lost(); };
  lost();
  r.run(4000, { stats: false });
  assert.equal(r.restarts.length, 1, 'at once, 3 s after the helper\'s own 10 s');
  for (let i = 0; i < 4; i++) { cycle(); r.run(4000, { stats: false }); }
  r.run(5 * 60_000, { frames: 0, attached: false });
  const at = r.restarts.map(x => x.at);
  assert.equal(at.length, 3, 'three restarts in six minutes of a stream that keeps failing, not one every ~18 s');
  assert.ok(at[1] - at[0] >= 30_000 && at[1] - at[0] < 60_000, `then 30 s on (${at[1] - at[0]} ms)`);
  assert.ok(at[2] - at[1] >= 120_000 && at[2] - at[1] < 150_000, `then 2 min on (${at[2] - at[1]} ms)`);
  assert.ok(r.restarts.every(x => x.reason === 'R1 access_lost'));
  assert.ok(r.pubs.filter(p => p.ring).length <= 6, 'the flaps ring within the cap');
  // Frames prove the stream runs: the next loss is restarted at once.
  const n = r.restarts.length;
  r.h.status({ connected: false }); r.run(4000, { stats: false }); r.up();
  r.stats({ frames: 40 });
  r.run(20_000);
  lost();
  r.run(4000, { stats: false });
  assert.equal(r.restarts.length, n + 1);
  assert.equal(r.h.info().restarts, n + 1);
});

test('kinds the contract doesn\'t name (a later helper\'s, an error line with no kind) are neither kept nor published and never hold R4\' back; a live window_minimized (a hold, not a problem) doesn\'t either', () => {
  const r = rig({ platform: 'win32' }).up();
  r.strip(hello('c0c0'));
  r.h.error({ kind: 'gpu_switched', message: 'x' });
  r.h.error({ message: 'no kind' });
  r.run(20_000);
  assert.deepEqual(r.pubs, []);
  assert.equal(r.write(r.clock.t - 1, [rec('c0c0')]), true, 'R4\' as without them');
  const m = rig({ platform: 'win32' }).up();
  m.strip(hello('c1c1'));
  m.run(20_000);
  m.h.error({ kind: 'window_minimized', message: 'x' });
  assert.equal(m.write(m.clock.t - 1, [rec('c1c1')]), true);
  assert.deepEqual(m.pubs.map(p => [p.state, p.cause]), [['no_signal', 'blind']]);
});

test('the cap counts per UI session: a hello read again (the strip shows one up to 20 s; a second client\'s comes by Reload between) never starts the count over; a new session\'s first hello does', () => {
  const r = rig({ platform: 'win32' }).up();
  const flap = () => { r.h.error({ kind: 'capture_blocked_by_app', message: 'x' }); r.run(4000, { stats: false }); r.h.status({ error: null }); };
  r.strip(hello('d0d0'));
  // A second client's session (§7's one-client policy: read by Reload only) says hello.
  r.write(r.clock.t - 1, [hello('d9d9', { mode: 'pixel' })]);
  for (let i = 0; i < 3; i++) flap();
  assert.equal(r.rings().length, 6);
  // The first session's hello, read off the strip again: the same UI session.
  r.strip(hello('d0d0'));
  flap();
  assert.equal(r.rings().length, 6, 'no more rings this session');
  assert.ok(r.pubs.slice(-2).every(p => !p.ring), 'written unrung');
  r.strip(hello('d1d1'));
  flap();
  assert.equal(r.rings().length, 8, 'a new session rings its own');
});

test('the game\'s exit ends the attach (a helper that stops its stats with the game closed says nothing more, SY-30): the logout\'s write, made before the exit, is still judged; a write made after it is not', () => {
  const r = rig().up();
  r.strip(hello('e0e0'));
  r.run(20_000);
  const logoutAt = r.clock.t - 500;
  r.h.game({ state: 'exited', pid: 4242 });
  assert.equal(r.h.info().attached, false);
  r.run(4000, { stats: false });
  assert.equal(r.write(logoutAt, [rec('e0e0')]), true, 'written while the helper watched');
  const s = rig().up();
  s.strip(hello('e1e1'));
  s.run(20_000);
  s.h.game({ state: 'exited', pid: 4242 });
  s.run(4000, { stats: false });
  assert.equal(s.write(s.clock.t - 1, [rec('e1e1')]), false, 'no game, nothing watched');
});

test('damaged: a missing or unsigned helper is damaged at 3 s and never restarted by R1 (the supervisor retries it); helper_failed is damaged at the third in a row, restarted meanwhile; a helper that starts clears it', () => {
  const r = rig();
  r.h.error({ kind: 'helper_missing', message: 'x' });
  r.run(3000, { stats: false });
  assert.deepEqual(r.h.slot(), { state: 'damaged', since: Math.floor(r.clock.t / 1000), cause: 'helper_missing' });
  r.run(60_000, { stats: false });
  assert.equal(r.restarts.length, 0);
  r.up();
  assert.equal(r.state(), 'ok');
  const f = rig();
  f.h.error({ kind: 'helper_failed', message: 'open exited 1' });
  f.run(4000, { stats: false });
  assert.equal(f.state(), 'ok', 'one failed start names nothing');
  assert.deepEqual(f.restarts.map(x => x.reason), ['R1 helper_failed'], 'the waiting start runs now');
  f.h.error({ kind: 'helper_failed', message: 'open exited 1' });
  f.run(4000, { stats: false });
  assert.equal(f.state(), 'ok');
  f.h.error({ kind: 'helper_failed', message: 'open exited 1' });
  f.run(2000, { stats: false });
  assert.deepEqual(f.h.slot(), { state: 'damaged', since: Math.floor(f.clock.t / 1000), cause: 'helper_failed' });
  f.h.status({ connected: true });
  assert.equal(f.state(), 'ok');
  // A refused lock and the window not found say nothing here (the supervisor's, and a closed game).
  const q = rig();
  q.h.error({ kind: 'instance_busy', message: 'x', holder: 99 });
  q.h.error({ kind: 'window_not_found', message: 'x' });
  q.run(60_000, { stats: false });
  assert.deepEqual(q.pubs, []);
});

test('the slot names the worst of several: no_permission over damaged over unsupported over blocked over no_signal; the cause follows without a ring', () => {
  const r = rig({ platform: 'win32' }).up();
  r.strip(hello('7070'));
  r.run(20_000);
  r.write(r.clock.t - 1, [rec('7070')]);
  assert.deepEqual([r.state(), r.h.slot().cause], ['no_signal', 'blind']);
  r.h.error({ kind: 'access_lost', message: 'x' });
  r.run(10_000, { stats: false });
  assert.deepEqual([r.state(), r.h.slot().cause, r.pubs.at(-1).ring], ['no_signal', 'access_lost', false], 'the same state: no ring');
  r.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  r.run(4000, { stats: false });
  assert.equal(r.state(), 'blocked');
  r.h.error({ kind: 'capture_unsupported', message: 'x' });
  r.run(4000, { stats: false });
  assert.equal(r.state(), 'unsupported');
  r.h.status({ error: null }); // the helper cleared them all; the blind verdict stays until the strip is read
  assert.deepEqual([r.state(), r.h.slot().cause], ['no_signal', 'blind']);
});

// ------------------------------------------------------------ holds

test('H4: a minimized Windows WoW (typed window_minimized) is held: no restart, nothing published, the app\'s view says minimized; restored, nothing happens. On a Mac an off-screen or hidden window holds R3', () => {
  const r = rig({ platform: 'win32' }).up();
  r.strip(hello('4040'));
  r.h.error({ kind: 'window_minimized', message: 'World of Warcraft is minimized; restore it to keep chatting' });
  r.run(5 * 60_000, { frames: 0, attached: true }); // the loop skips the grab but keeps its duplication
  assert.deepEqual([r.pubs, r.restarts], [[], []]);
  assert.equal(r.h.view().minimized, true);
  assert.equal(r.h.info().held, 'minimized');
  r.stats({ frames: 40 }); // restored: frames again
  assert.equal(r.h.view().minimized, false);
  assert.deepEqual(r.pubs, []);
  for (const facts of [{ onScreen: false }, { hidden: true }]) {
    const m = rig().up();
    m.run(5 * 60_000, { frames: 0, ...facts });
    assert.deepEqual(m.restarts, [], JSON.stringify(facts));
    assert.equal(m.h.view().minimized, false, 'the Mac\'s holds are never shown');
  }
});

test('H6: two empty intervals on a Mac, on screen and awake: a restart; hidden, asleep or locked: none. Windows with 0 frames for a minute (window_minimized live, or muted by its once-a-minute limit): none, R3 is Mac-only', () => {
  const r = rig().up();
  r.run(10_000, { frames: 40 });
  r.stats({ frames: 0 });
  r.h.tick();
  assert.equal(r.restarts.length, 0, 'one empty interval can be a Space switch');
  r.stats({ frames: 0 });
  r.h.tick();
  assert.deepEqual(r.restarts.map(x => x.reason), ['R3 stalled']);
  assert.ok(r.logs.some(l => l.k === 'capture-stalled' && l.runs === 2));
  for (const facts of [{ hidden: true }, { asleep: true }, { locked: true }]) {
    const m = rig().up();
    m.run(3 * 60_000, { frames: 0, ...facts });
    assert.deepEqual(m.restarts, [], JSON.stringify(facts));
  }
  const w = rig({ platform: 'win32' }).up();
  w.h.error({ kind: 'window_minimized', message: 'x' });
  w.run(60_000, { frames: 0 });
  w.h.status({ error: null });
  w.run(60_000, { frames: 0 }); // minimized again within the minute: the helper's limiter mutes the line
  assert.deepEqual(w.restarts, []);
});

test('H17: a lock for 10 minutes with a stale access_lost (Windows locked, or a Mac locked): nothing published, no restart, the backoff untouched; after unlock a Mac stall is restarted at the first step. H17b, the Mac\'s lock race (SY-18): locked:false in the stats line, then access_lost carrying locked:true: nothing', () => {
  const w = rig({ platform: 'win32' }).up();
  w.h.error({ kind: 'access_lost', message: 'x' });
  w.run(1000, { stats: false });
  w.h.status({ away: 'locked' }); // the helper's lock line, half a second after the lock screen's access_lost
  w.run(10 * 60_000, { frames: 0, attached: false });
  assert.deepEqual([w.pubs, w.restarts], [[], []]);
  assert.ok(w.logs.some(l => l.k === 'capture-hold' && l.reason === 'locked'), 'logged once it lasted 5 s');
  w.h.status({ away: null });
  w.stats({ frames: 30 }); // unlocked: the helper reopened by itself
  w.run(60_000);
  assert.deepEqual([w.pubs, w.restarts], [[], []]);
  const m = rig().up();
  m.run(20_000, { frames: 40 });
  m.stats({ frames: 0, locked: true });
  m.h.error({ kind: 'access_lost', message: 'x', locked: true, asleep: false });
  m.run(10 * 60_000, { frames: 0, locked: true });
  assert.deepEqual([m.pubs, m.restarts], [[], []]);
  // Unlocked, the stream came back (a window line) but delivers nothing: R3, at its first step.
  m.stats({ frames: 0, locked: false });
  m.h.status({ window: { pid: 4242, scale: 2 } });
  m.run(20_000, { frames: 0 });
  assert.deepEqual(m.restarts.map(x => x.reason), ['R3 stalled']);
  assert.equal(m.h.info().restarts, 1);
  assert.deepEqual(m.pubs, [], 'R3 never publishes');
  // H17b: the stream stopped before the session showed the lock.
  const race = rig().up();
  race.run(20_000);
  race.stats({ frames: 0, attached: false, locked: false }); // stopped()'s line
  race.h.error({ kind: 'access_lost', message: 'x', locked: true, asleep: false }); // no newer stats line
  race.run(60_000, { stats: false });
  assert.deepEqual([race.pubs, race.restarts], [[], []]);
  assert.equal(race.h.view().state, 'ok', 'nothing for the app to alarm on');
  // The hold ends: access_lost that outlasts it waits 10 s from then, and then acts.
  race.stats({ frames: 0, attached: false, locked: false });
  race.run(8000, { stats: false });
  assert.equal(race.state(), 'ok');
  race.run(4000, { stats: false });
  assert.equal(race.state(), 'no_signal');
});

// ------------------------------------------------------------ R2, R3 and the backoff

test('H5: stats stop for 30 s with the game running and the helper attached: a restart, and the stats resume with nothing published. H5b: the same with the game closed: no restart', () => {
  const r = rig({ platform: 'win32' }).up();
  r.run(20_000);
  r.run(28_000, { stats: false });
  assert.equal(r.restarts.length, 0);
  r.run(4000, { stats: false });
  assert.deepEqual(r.restarts.map(x => x.reason), ['R2 hung']);
  assert.ok(r.logs.some(l => l.k === 'capture-hung' && l.quietMs >= 30_000));
  r.run(20_000);
  assert.deepEqual(r.pubs, []);
  const closed = rig().up();
  closed.run(20_000);
  closed.h.game({ state: 'exited', pid: 4242 });
  closed.run(5 * 60_000, { stats: false });
  assert.deepEqual(closed.restarts, []);
});

test('H14, the backoff (SY-14f): an R3 restart proven by frames leaves the next stall at the first step (0 s, not 30 s); R2\'s resets on a stats line; R4\'s on a keyed record or a hello off the strip, never on a seen alone (SY-25); one restart settles 5 s before another', () => {
  const r = rig().up();
  r.run(20_000, { frames: 40 });
  r.stats({ frames: 0 }); r.stats({ frames: 0 }); r.h.tick();
  assert.equal(r.restarts.length, 1);
  r.run(20_000, { frames: 40 }); // it healed
  r.stats({ frames: 0 }); r.stats({ frames: 0 }); r.h.tick();
  assert.equal(r.restarts.length, 2, 'the next stall at once');
  // Without the proof, the next stall waits 30 s from the last restart.
  r.stats({ frames: 0 }); r.stats({ frames: 0 }); r.h.tick();
  assert.equal(r.restarts.length, 2);
  r.run(30_000, { frames: 0 });
  assert.equal(r.restarts.length, 3);
  // R2: a stats line starts its backoff over.
  const h2 = rig({ platform: 'win32' }).up();
  h2.run(20_000);
  h2.run(32_000, { stats: false });
  assert.equal(h2.restarts.length, 1);
  h2.up();
  h2.stats();
  h2.run(32_000, { stats: false });
  assert.equal(h2.restarts.length, 2, 'hung again: restarted at the first step');
  // R4': a seen that decodes doesn't start its backoff over (SY-25): a region too narrow for longer records.
  const b = rig().up();
  b.strip(hello('2525'));
  b.run(20_000);
  b.write(b.clock.t - 1, [rec('2525')]);
  b.strip(rec('2525', 'seen'));
  assert.equal(b.state(), 'ok');
  b.run(10_000);
  b.write(b.clock.t - 1, [rec('2525')]);
  assert.equal(b.state(), 'no_signal', 'the next stuck message: named again');
  assert.equal(b.restarts.length, 1, 'but the restart waits its 30 s');
  b.run(20_000);
  assert.equal(b.restarts.length, 2);
  b.strip(hello('2626')); // a hello decodes: the strip reads whole records
  b.run(20_000);
  b.write(b.clock.t - 1, [rec('2626')]);
  assert.equal(b.restarts.length, 3, 'and the next one is at once');
  // The settle: two rules due together restart once.
  const s = rig().up();
  s.run(20_000, { frames: 40 });
  s.strip(hello('2727'));
  s.stats({ frames: 0 }); s.stats({ frames: 0 });
  s.write(s.clock.t - 1, [rec('2727')]);
  s.h.tick();
  assert.equal(s.restarts.length, 1);
});

test('the Restart button (DR-06): reset() is each rule\'s first step, so the watchdog\'s next restart waits 30 s from it; nothing restarts without a supervisor', () => {
  const r = rig().up();
  r.strip(hello('2828'));
  r.run(20_000);
  r.write(r.clock.t - 1, [rec('2828')]);
  r.run(10_000);
  assert.equal(r.restarts.length, 1);
  r.h.reset();
  r.run(28_000);
  assert.equal(r.restarts.length, 1);
  r.run(4000);
  assert.equal(r.restarts.length, 2);
  assert.ok(r.logs.some(l => l.k === 'capture-reset'));
  const none = rig();
  none.h.control(null);
  none.up();
  none.run(20_000, { frames: 0 });
  assert.equal(none.state(), 'ok');
});

// ------------------------------------------------------------ off, the app's view, the logs

test('off: the app\'s screen-reading switch, and no helper for this platform, are off whatever the helper says; never rung', () => {
  let on = true;
  const r = rig({ off: () => !on }).up();
  on = false;
  r.h.tick();
  assert.equal(r.state(), 'off');
  r.h.error({ kind: 'capture_blocked_by_app', message: 'x' });
  r.run(10_000);
  assert.equal(r.state(), 'off');
  assert.ok(r.pubs.every(p => !p.ring));
  const none = rig({ kind: 'none' });
  none.h.error({ kind: 'capture_unsupported', message: 'screen capture isn\'t supported on freebsd' });
  none.run(10_000, { stats: false });
  assert.equal(none.state(), 'off');
});

test('the app\'s view (DR-06, SY-10): the published state, a live window_minimized, a strip read since the current attach; changed() on a change of it, never per stats line', () => {
  const r = rig().up();
  assert.deepEqual(r.h.view(), { state: 'ok', cause: null, since: T0, minimized: false, seen: false, game: true, connected: true });
  r.strip(hello('3030'));
  assert.equal(r.h.view().seen, true);
  const changes = r.changes();
  r.run(60 * 60_000, { frames: 40 });
  assert.equal(r.changes(), changes, 'an hour of stats lines pushes nothing');
  r.h.status({ window: { pid: 4242, scale: 1 } }); // a re-plan: a new attach, not read yet
  assert.equal(r.h.view().seen, false);
  assert.equal(r.changes(), changes + 1);
  const info = r.h.info();
  for (const k of ['state', 'cause', 'held', 'since', 'restarts', 'nextRestartAt', 'lastStats', 'window', 'ringsLeft']) assert.ok(Object.hasOwn(info, k), k);
  assert.equal(info.ringsLeft, 6);
  assert.equal(info.lastStats.interval.frames, 40);
});

test('the logs: frames crossing zero and every health change and restart, never a stats line while frames flow (a chatty hour of sends and seens); holds only once they last 5 s', () => {
  const r = rig().up();
  r.strip(hello('3131'));
  const statsLogs = () => r.logs.filter(l => l.k === 'capture-stats').length;
  r.run(10_000, { frames: 40 });
  const n = statsLogs();
  for (let i = 0; i < 360; i++) { r.run(10_000, { frames: 40 }); r.strip(rec('3131', 'msg'), rec('3131', 'seen')); }
  assert.equal(statsLogs(), n, 'no stats line while frames stay above zero');
  r.stats({ frames: 0 });
  assert.equal(statsLogs(), n + 1, 'frames crossed zero');
  r.stats({ frames: 12 });
  assert.equal(statsLogs(), n + 2);
  assert.ok(!r.logs.some(l => l.k === 'capture-stats' && 'decodedCrossed' in l));
  const holds = rig().up();
  holds.stats({ hidden: true });
  holds.run(4000, { stats: false });
  assert.equal(holds.logs.filter(l => l.k === 'capture-hold').length, 0);
  holds.run(2000, { stats: false });
  assert.deepEqual(holds.logs.filter(l => l.k === 'capture-hold').map(l => l.reason), ['hidden']);
  holds.stats({ hidden: false });
  holds.h.tick();
  assert.deepEqual(holds.logs.filter(l => l.k === 'capture-hold').map(l => l.reason), ['hidden', null]);
});
