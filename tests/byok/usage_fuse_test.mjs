// The public build's money guards, pure (bridge/byok/usage/fuse.mjs; onboarding spec §9.9, PRD §9.4
// and §10, DB26, T20; systems plan D4): more than 10 automatic turns whose send times fall within
// 60 s, or more than 60 within an hour, pause them until reset() (the player's next typed message);
// the typed guard, the same machine, pauses sending past 20 typed messages in a minute. The
// bridge's use of them is in bridge_byok_e2e_test and money_guards_test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoFuse, AUTO_FUSE, TYPED_GUARD, autoPausedLine, sendPausedLine, spanText, windowsOf } from '../../bridge/byok/usage/fuse.mjs';

const T0 = Date.parse('2026-09-26T20:00:00Z');
// The clock is 3 hours past T0: send times from T0 on are in the past, as a real turn's always are.
const rig = (extra = {}) => { const clock = { t: T0 + 3 * 3600e3 }; return { clock, fuse: createAutoFuse({ ...AUTO_FUSE, now: () => clock.t, ...extra }) }; };

test('AUTO_FUSE: 10 check-ins within 60 s, 60 within an hour, frozen; the one line names the companion, whichever window tripped', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(AUTO_FUSE)), { turns: 10, windowMs: 60_000, hour: { turns: 60, windowMs: 3_600_000 } });
  assert.ok(Object.isFrozen(AUTO_FUSE) && Object.isFrozen(AUTO_FUSE.hour));
  assert.deepEqual(windowsOf(AUTO_FUSE), [{ turns: 10, windowMs: 60_000 }, { turns: 60, windowMs: 3_600_000 }]);
  assert.equal(autoPausedLine('NeverQuestAlone'), 'NeverQuestAlone paused check-ins: your next message turns them back on.');
  assert.equal(autoPausedLine('Mira'), 'Mira paused check-ins: your next message turns them back on.');
  // One line whatever the limits (PUI-01): the hour's window says the same.
  assert.equal(autoPausedLine('Mira', AUTO_FUSE.hour), 'Mira paused check-ins: your next message turns them back on.');
  assert.match(autoPausedLine(''), /^NeverQuestAlone paused/);
  assert.deepEqual([spanText(60_000), spanText(3_600_000), spanText(300_000), spanText(7_200_000), spanText(90_000)], ['a minute', 'an hour', '5 minutes', '2 hours', '90 seconds']);
});

test('the hour: a loop slower than the minute (one every 7 s) goes 60 times, and the 61st within the hour pauses, by the hour', () => {
  const { fuse } = rig();
  for (let i = 0; i < 60; i++) assert.equal(fuse.allow(T0 + i * 7000), true, `turn ${i + 1}`);
  assert.equal(fuse.allow(T0 + 60 * 7000), false, 'the 61st');
  assert.deepEqual(fuse.pausedBy, { turns: 60, windowMs: 3_600_000 });
  assert.equal(fuse.snapshot().by.windowMs, 3_600_000, 'kept for a restart (the app\'s status names the window)');
  // Normal play: events 120 s apart are 30 an hour, for hours.
  const play = rig();
  for (let i = 0; i < 90; i++) assert.equal(play.fuse.allow(T0 + i * 120_000), true, `event ${i + 1}`);
  assert.equal(play.fuse.paused, false);
  // The minute still trips first in a burst.
  const burst = rig();
  for (let i = 0; i < 10; i++) burst.fuse.allow(T0 + i * 100);
  assert.equal(burst.fuse.allow(T0 + 1000), false);
  assert.deepEqual(burst.fuse.pausedBy, { turns: 10, windowMs: 60_000 });
});

test('TYPED_GUARD: 20 typed messages within a minute go, the 21st pauses sending until reset(); the line and its words', () => {
  assert.deepEqual({ ...TYPED_GUARD }, { turns: 20, windowMs: 60_000 });
  const clock = { t: T0 };
  const guard = createAutoFuse({ ...TYPED_GUARD, now: () => clock.t });
  for (let i = 0; i < 20; i++) { clock.t += 1000; assert.equal(guard.allow(), true, `message ${i + 1}`); }
  clock.t += 1000;
  assert.equal(guard.allow(), false, 'the 21st in a minute');
  clock.t += 3600e3;
  assert.equal(guard.allow(), false, 'held until reset, however long');
  assert.equal(guard.reset(), true);
  // A fast typist: a message every 3 s is 20 a minute, never more.
  for (let i = 0; i < 100; i++) { clock.t += 3000; assert.equal(guard.allow(), true); }
  assert.deepEqual(sendPausedLine(), { headline: 'Sending is paused.', detail: "More than 20 messages went in a minute, which normal play doesn't do." });
});

test('10 within 60 s go; the 11th is refused and pauses; every allow() after it is refused until reset(), which starts a fresh window', () => {
  const { fuse } = rig();
  for (let i = 0; i < 10; i++) assert.equal(fuse.allow(T0 + i * 1000), true, `turn ${i + 1}`);
  assert.equal(fuse.paused, false);
  assert.equal(fuse.allow(T0 + 10_000), false, 'the 11th');
  assert.equal(fuse.paused, true);
  assert.equal(fuse.trips, 1);
  assert.equal(fuse.held, 1);
  // Held until reset, whatever the send time (an hour later too).
  assert.equal(fuse.allow(T0 + 3600e3), false);
  assert.equal(fuse.allow(T0 + 7200e3), false);
  assert.equal(fuse.held, 3);
  assert.equal(fuse.reset(), true, 'it had paused');
  assert.equal(fuse.paused, false);
  assert.equal(fuse.held, 0);
  assert.equal(fuse.reset(), false, 'nothing to end');
  // A fresh window: ten more in the same minute go.
  for (let i = 0; i < 10; i++) assert.equal(fuse.allow(T0 + 20_000 + i * 100), true);
  assert.equal(fuse.allow(T0 + 21_000), false);
  assert.equal(fuse.trips, 2);
});

test('counted by send time, so a backlog that arrives at once keeps its spacing: 2 hours of events 120 s apart, all at one arrival, never trip it; nor does a double level-up', () => {
  const { clock, fuse } = rig();
  const start = clock.t - 2 * 3600e3;
  for (let i = 0; i < 60; i++) assert.equal(fuse.allow(start + i * 120_000), true, `backlog ${i}`);
  // Then live play: a double level-up a second apart, and events two minutes apart.
  assert.equal(fuse.allow(clock.t), true);
  clock.t += 1000;
  assert.equal(fuse.allow(clock.t), true);
  for (let i = 1; i <= 30; i++) { clock.t += 120_000; assert.equal(fuse.allow(clock.t), true); }
  assert.equal(fuse.paused, false);
  assert.equal(fuse.trips, 0);
  assert.ok(fuse.snapshot().times.length <= 31, 'only what a later turn can share a window with is kept (an hour at 120 s)');
});

test('the window is 60 s exactly: 10 in 54 s and the 11th 60 s after the first go; the 11th within 60 s of the first is refused', () => {
  const { fuse } = rig();
  for (let i = 0; i < 10; i++) assert.equal(fuse.allow(T0 + i * 6000), true);
  assert.equal(fuse.allow(T0 + 60_000), true, 'the first is out of its window');
  const b = rig().fuse;
  for (let i = 0; i < 10; i++) assert.equal(b.allow(T0 + i * 6000), true);
  assert.equal(b.allow(T0 + 59_999), false, 'still within 60 s of the first');
});

test('a loop\'s events count however they arrive: one arriving late with an earlier send time still makes the 11th in its minute', () => {
  const { clock, fuse } = rig();
  for (let i = 0; i < 10; i++) assert.equal(fuse.allow(clock.t - 30_000 + i * 1000), true);
  assert.equal(fuse.allow(clock.t - 29_500), false, 'within the loop\'s minute, though it came last');
  // A loop that ran while the bridge was away, delivered hours later, trips it too.
  const late = rig();
  const was = late.clock.t - 3 * 3600e3;
  for (let i = 0; i < 10; i++) assert.equal(late.fuse.allow(was + i * 500), true);
  assert.equal(late.fuse.allow(was + 5000), false);
});

test('a send time that is missing, not a number or ahead of the clock counts as now; one kept from before a clock was set back is dropped', () => {
  const { clock, fuse } = rig();
  for (let i = 0; i < 5; i++) assert.equal(fuse.allow(undefined), true);
  for (let i = 0; i < 3; i++) assert.equal(fuse.allow(NaN), true);
  assert.equal(fuse.allow(clock.t + 10 * 60_000), true, 'ahead of the clock: now');
  assert.equal(fuse.allow(-1), true, 'negative: now');
  assert.equal(fuse.allow(null), false, 'the 11th now');
  // The clock goes back an hour: the times it kept are ahead of it and no longer count.
  const s = rig();
  for (let i = 0; i < 10; i++) s.fuse.allow(s.clock.t + i);
  s.clock.t -= 3600e3;
  for (let i = 0; i < 10; i++) assert.equal(s.fuse.allow(s.clock.t + i), true, `after the clock went back ${i}`);
  assert.equal(s.fuse.allow(s.clock.t + 20), false, 'and the fuse still works');
});

test('off: AUTO_FUSE = null (or no whole turns) never pauses', () => {
  for (const off of [null, undefined, { turns: null, windowMs: 60_000 }, { turns: Infinity, windowMs: 60_000 }, { turns: 10, windowMs: 0 }]) {
    const fuse = off === undefined ? createAutoFuse({ turns: 0 }) : createAutoFuse(off);
    for (let i = 0; i < 500; i++) assert.equal(fuse.allow(T0), true);
    assert.equal(fuse.paused, false, JSON.stringify(off));
    assert.equal(fuse.on, false);
    assert.equal(fuse.reset(), false);
  }
  assert.equal(createAutoFuse().on, true, 'AUTO_FUSE by default');
});

test('snapshot() and state: a restart keeps the window and a pause; a bad state is ignored', () => {
  const a = rig();
  for (let i = 0; i < 9; i++) a.fuse.allow(T0 + i * 1000);
  const saved = JSON.parse(JSON.stringify(a.fuse.snapshot()));
  assert.equal(saved.paused, false);
  assert.equal(saved.times.length, 9);
  const b = rig({ state: saved });
  assert.equal(b.fuse.allow(T0 + 9000), true, 'the 10th');
  assert.equal(b.fuse.allow(T0 + 9500), false, 'the 11th, across the restart');
  const held = JSON.parse(JSON.stringify(b.fuse.snapshot()));
  assert.equal(held.paused, true);
  assert.equal(held.trips, 1);
  const c = rig({ state: held });
  assert.equal(c.fuse.paused, true, 'still paused after a restart');
  assert.equal(c.fuse.allow(T0 + 3600e3), false);
  assert.equal(c.fuse.reset(), true);
  assert.deepEqual(c.fuse.snapshot(), { times: [], paused: false, trips: 1 });
  for (const bad of [null, 'x', { times: 'x', paused: 'yes' }, { times: [NaN, -5, 'a'], paused: 1, trips: -3 }]) {
    const d = rig({ state: bad });
    assert.equal(d.fuse.paused, false, JSON.stringify(bad));
    assert.deepEqual(d.fuse.snapshot(), { times: [], paused: false, trips: 0 });
  }
  assert.deepEqual(createAutoFuse(null).snapshot(), { trips: 0 }, 'off keeps nothing');
});
