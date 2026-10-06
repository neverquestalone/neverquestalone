// Caps (PRD §9.4, §9.2, DB8, US-6; systems plan D6): no usage limits of the public build's own
// (the owner, 2026-09-26: no default spend cap, no typed or automatic turn cap), so a loop of turns is
// metered and never refused; the daily spend cap the player may set, checked as today's spend (the
// usage history, the one store of daily totals) plus this turn's estimate, with no reservations:
// overshoot bounded by the turns running at once, local midnight rollover, a restart keeping the
// day, and every way that cap could fail open: a 0 estimate, a history that can't be read, invalid
// settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCaps, localDay, nextLocalMidnight, normalizeCapsConfig, CAP_DEFAULTS } from '../../bridge/byok/usage/caps.mjs';
import { createUsageHistory } from '../../bridge/byok/usage/history.mjs';
import { estimateTurn } from '../../bridge/byok/usage/meter.mjs';
import { priceFor, TIER_REACH } from '../../bridge/byok/usage/prices.mjs';
import { createRunQueue } from '../../bridge/byok/runqueue.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-caps-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Local wall-clock times, whatever TZ the test runs in.
const local = (y, mo, d, h = 12, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

function clockAt(ms) {
  const c = { t: ms, now: () => c.t };
  return c;
}
// A caps over a history file (the store a restart reads back).
function onFile(file, clock, config = {}, log = () => {}) {
  const history = createUsageHistory({ file, now: clock.now, log });
  return createCaps({ history, config, now: clock.now, log });
}

test('defaults: no cap of the build\'s own, only the per-turn ceiling (never above TIER_REACH); the snapshot is the slot\'s bridge.usage, capMicros only with a cap the player set', () => {
  assert.deepEqual({ ...CAP_DEFAULTS }, { dailyUsd: null, perTurnInput: 20000, perTurnOutput: 1200 });
  assert.equal(CAP_DEFAULTS.perTurnInput, TIER_REACH, 'no request reaches a long-context price');
  const clock = clockAt(local(2026, 9, 26, 15));
  const caps = createCaps({ now: clock.now });
  assert.deepEqual(caps.snapshot(), { day: '2026-09-26', spentMicros: 0, turns: 0, auto: 0, exact: true });
  assert.equal(caps.fitsTurn({ inputTokens: 20000, maxOutputTokens: 1200 }), true);
  assert.equal(caps.fitsTurn({ inputTokens: 20001, maxOutputTokens: 1200 }), false);
  assert.equal(caps.fitsTurn({ inputTokens: 100, maxOutputTokens: 1201 }), false);
  // The old limits' fields are ignored; null is "no cap", not a bad value; the ceiling can go down, not past TIER_REACH.
  assert.deepEqual(normalizeCapsConfig({ dailyUsd: -1, typedPerDay: 2.5, autoPerDay: 0 }), { ...CAP_DEFAULTS });
  assert.equal(normalizeCapsConfig({ dailyUsd: null }, { ...CAP_DEFAULTS, dailyUsd: 2 }).dailyUsd, null);
  assert.equal(normalizeCapsConfig({}, { ...CAP_DEFAULTS, dailyUsd: 2 }).dailyUsd, 2, 'a missing field keeps the current cap');
  assert.equal(normalizeCapsConfig({ perTurnInput: 8000 }).perTurnInput, 8000);
  assert.equal(normalizeCapsConfig({ perTurnInput: 200000 }).perTurnInput, 20000);
  const mine = createCaps({ config: { dailyUsd: 2.5 }, now: clock.now });
  assert.deepEqual(mine.snapshot(), { day: '2026-09-26', spentMicros: 0, capMicros: 2500000, turns: 0, auto: 0, exact: true });
});

test('no limits of our own: with no cap set, a loop of typed and automatic turns is booked and never refused', () => {
  const caps = createCaps({ now: clockAt(local(2026, 9, 26)).now });
  const outcomes = new Set();
  for (let i = 0; i < 600; i++) {
    const kind = i % 6 === 0 ? 'auto' : 'typed';
    outcomes.add(caps.check({ estMicros: 5000 }, kind) ?? 'ok');
    caps.book({ provider: 'anthropic', micros: 5000, exact: true, auto: kind === 'auto' });
  }
  assert.deepEqual([...outcomes], ['ok'], 'nothing refused: no default spend cap, no typed or automatic turn cap');
  const s = caps.snapshot();
  assert.deepEqual([s.spentMicros, s.turns, s.auto], [600 * 5000, 500, 100], '$3.00 spent, every turn counted');
  assert.equal(s.capMicros, undefined, 'no cap in the slot');
  assert.equal(caps.check({ estMicros: 5e9 }), null);
  assert.equal(caps.check({ estMicros: 1 }, 'auto'), null);
  assert.equal(caps.details().held, null);
});

test('a cap the player set: today\'s spend + this turn\'s estimate > cap is refused; exactly at the cap goes; a free turn is never refused; a paid 0 estimate throws', () => {
  const caps = createCaps({ config: { dailyUsd: 0.01 }, now: clockAt(local(2026, 9, 26)).now });
  assert.equal(caps.check({ estMicros: 10000 }), null, 'exactly the cap');
  assert.equal(caps.check({ estMicros: 10001 }), 'cap_spend');
  caps.book({ provider: 'anthropic', micros: 6000, exact: true });
  assert.equal(caps.check({ estMicros: 4000 }), null);
  assert.equal(caps.check({ estMicros: 4001 }), 'cap_spend');
  assert.equal(caps.check(4001, 'auto'), 'cap_spend', 'a bare number; automatic turns too');
  assert.equal(caps.check({ estMicros: 0, free: true }), null, 'a local or $0 price');
  caps.book({ provider: 'ollama', micros: 0, exact: true });
  assert.equal(caps.snapshot().turns, 2, 'a free turn still counts as a turn');
  assert.throws(() => caps.check({ estMicros: 0 }), /estMicros must be above 0/);
  assert.throws(() => caps.check({}), /non-negative number/);
  assert.throws(() => caps.check({ estMicros: 5, free: true }), /a free turn costs nothing/);
  assert.throws(() => caps.check({ estMicros: 5 }, 'repair'), /unknown turn kind/);
  // Past the cap on its own (a reply cost more than its estimate): everything paid is refused.
  caps.book({ provider: 'anthropic', micros: 9000, exact: false });
  assert.equal(caps.check({ estMicros: 1 }), 'cap_spend');
  assert.deepEqual([caps.snapshot().spentMicros, caps.snapshot().exact], [15000, false]);
});

test('the reviewer\'s bypass is closed: a BUILD-PLAN request on Haiku can\'t slip under a $0.01 cap', () => {
  const haiku = priceFor('anthropic', 'claude-haiku-4-5', '2026-09-26T12:00:00Z');
  const req = { model: 'claude-haiku-4-5', system: [{ text: 'x'.repeat(20000), cache: true }], messages: [{ role: 'user', content: 'hi' }], maxTokens: 1200, effort: null };
  const caps = createCaps({ config: { dailyUsd: 0.01 }, now: clockAt(local(2026, 9, 26)).now });
  assert.equal(caps.check(estimateTurn(req, haiku), 'typed'), 'cap_spend', 'a turn that may cost $0.019 never fits a $0.01 cap');
  // With room for exactly one, one goes and the rest are refused.
  const c2 = createCaps({ config: { dailyUsd: 0.03 }, now: clockAt(local(2026, 9, 26)).now });
  const outcomes = [];
  for (let i = 0; i < 5; i++) {
    const no = c2.check(estimateTurn(req, haiku), 'typed');
    outcomes.push(no ?? 'ok');
    if (!no) c2.book({ provider: 'anthropic', micros: 19000, exact: true });
  }
  assert.deepEqual(outcomes, ['ok', 'cap_spend', 'cap_spend', 'cap_spend', 'cap_spend']);
});

test('a cap and two chats at once (the run queue): the overshoot is at most what the turns running at once cost', async () => {
  const EST = 2000;
  const CAP = 10000;
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const caps = createCaps({ config: { dailyUsd: CAP / 1e6 }, now: clockAt(local(2026, 9, 26)).now });
  const q = createRunQueue({ concurrency: 2 });
  let inFlight = 0;
  let peak = 0;
  const refused = new Set();
  const turn = chat => q.run(chat, async () => {
    if (caps.check({ estMicros: EST })) { refused.add(chat); return 'cap_spend'; }
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(1 + Math.floor(rand() * 3));
    inFlight--;
    caps.book({ provider: 'anthropic', micros: EST, exact: true }); // at most its estimate: the estimate is an upper bound
    return 'ok';
  });
  const results = [];
  for (let i = 0; i < 12; i++) results.push(turn('chatA'), turn('chatB'));
  await Promise.all(results);
  const spent = caps.snapshot().spentMicros;
  assert.equal(peak, 2, 'both chats ran at once');
  assert.deepEqual([...refused].sort(), ['chatA', 'chatB'], 'both chats reached the cap');
  assert.ok(spent - CAP <= 2 * EST, `overshoot ${spent - CAP} ≤ the two turns running at once`);
});

test('the day rolls over at local midnight: a cap reached yesterday lets today\'s turns go', () => {
  const clock = clockAt(local(2026, 9, 26, 23, 59, 30));
  const caps = createCaps({ config: { dailyUsd: 0.01 }, now: clock.now });
  caps.book({ provider: 'anthropic', micros: 10000, exact: true });
  assert.equal(caps.check({ estMicros: 1 }), 'cap_spend');
  assert.equal(nextLocalMidnight(clock.t), local(2026, 9, 27, 0, 0, 0));
  assert.equal(caps.details().resetsAt, local(2026, 9, 27, 0, 0, 0));
  clock.t = local(2026, 9, 27, 0, 0, 1);
  assert.equal(caps.check({ estMicros: 5000 }), null);
  assert.deepEqual([caps.snapshot().day, caps.snapshot().spentMicros], ['2026-09-27', 0]);
  assert.equal(caps.details().history.find(d => d.day === '2026-09-26').spentMicros, 10000);
  assert.equal(localDay(local(2026, 9, 26, 0, 0, 0)), '2026-09-26');
});

test('a restart keeps the day: the history file is read back, and the cap counts from what it holds', () => {
  const file = path.join(tmpDir(), 'usage-history.json');
  const clock = clockAt(local(2026, 9, 26, 15));
  const a = onFile(file, clock, { dailyUsd: 0.02 });
  a.book({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'claude-haiku-4-5', in: 7500, out: 350, micros: 15000, exact: false });
  const b = onFile(file, clock, { dailyUsd: 0.02 });
  assert.deepEqual([b.snapshot().spentMicros, b.snapshot().turns, b.snapshot().exact], [15000, 1, false]);
  assert.equal(b.check({ estMicros: 5001 }), 'cap_spend');
  assert.equal(b.check({ estMicros: 5000 }), null);
});

test('a history that can\'t be read is kept aside; with a cap the player set today counts as at it until acknowledged, with none nothing is held, and a cap set later that day holds too', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'usage-history.json');
  const clock = clockAt(local(2026, 9, 26, 15));
  fs.writeFileSync(file, '{"v":1,"days":{"2026-09-26":');
  const logs = [];
  const held = onFile(file, clock, { dailyUsd: 1 }, (k, d) => logs.push([k, d]));
  assert.ok(logs.some(([k, d]) => k === 'usage-history-read-failed' && d.code === 'corrupt'));
  assert.equal(held.check({ estMicros: 1 }), 'cap_spend', 'never fails open');
  assert.deepEqual([held.snapshot().spentMicros, held.snapshot().exact, held.details().held, held.details().loadError], [1000000, false, 'load_error', 'corrupt']);
  assert.match(path.basename(held.details().keptAs), /^usage-history\.json\.corrupt-\d+$/);
  assert.ok(fs.existsSync(held.details().keptAs), 'kept as it was');
  assert.equal(held.check({ estMicros: 0, free: true }), null, 'a free turn still goes');
  assert.equal(held.acknowledgeLoadError(), true);
  assert.equal(held.check({ estMicros: 1 }), null, 'acknowledged: counts from here');
  assert.equal(held.details().held, null);
  // No cap: nothing to hold. A cap set that day, before acknowledging: held.
  fs.writeFileSync(file, 'not json');
  const none = onFile(file, clock, {});
  assert.equal(none.check({ estMicros: 5e6 }), null);
  none.setConfig({ dailyUsd: 5 });
  assert.equal(none.check({ estMicros: 1 }), 'cap_spend', 'the day\'s spend before the load isn\'t known');
  // The next day is a fresh day.
  clock.t = local(2026, 9, 27, 9);
  assert.equal(none.check({ estMicros: 1 }), null);
});

test('invalid settings keep the current value, never the default; null clears the player\'s cap', () => {
  const logs = [];
  const caps = createCaps({ config: { dailyUsd: 0.25 }, now: clockAt(local(2026, 9, 26)).now, log: (k, d) => logs.push([k, d]) });
  assert.deepEqual(caps.setConfig({ dailyUsd: NaN, typedPerDay: 2.5, autoPerDay: 10 }), { ...CAP_DEFAULTS, dailyUsd: 0.25 });
  assert.equal(caps.snapshot().capMicros, 250000, 'still $0.25, not cleared');
  assert.deepEqual(logs, [['caps_config_rejected', { fields: ['dailyUsd'] }]], 'the old limits\' fields are ignored, not rejected');
  for (const bad of [{ dailyUsd: -1 }, { dailyUsd: '5' }, { dailyUsd: Infinity }, null, 'x']) caps.setConfig(bad);
  assert.equal(caps.config().dailyUsd, 0.25);
  assert.deepEqual(normalizeCapsConfig({ dailyUsd: NaN }, { ...CAP_DEFAULTS, dailyUsd: 0.5 }).dailyUsd, 0.5);
  // The player turns the cap off: no cap, and nothing refused.
  caps.setConfig({ dailyUsd: null });
  assert.equal(caps.config().dailyUsd, null);
  assert.equal(caps.snapshot().capMicros, undefined);
  assert.equal(caps.check({ estMicros: 5_000_000 }), null);
});

test('totals per provider, per session and per day (§9.2)', () => {
  const file = path.join(tmpDir(), 'usage-history.json');
  const clock = clockAt(local(2026, 9, 26, 10));
  const caps = onFile(file, clock);
  const spend = (provider, micros, auto = false) => caps.book({ provider, micros, exact: true, auto });
  spend('anthropic', 9250);
  spend('anthropic', 4300);
  spend('openrouter', 2100, true);
  spend('ollama', 0);
  const d = caps.details();
  assert.deepEqual(d.byProvider, { anthropic: { spentMicros: 13550, turns: 2 }, openrouter: { spentMicros: 2100, turns: 1 }, ollama: { spentMicros: 0, turns: 1 } });
  assert.deepEqual(d.history[0].byProvider, d.byProvider);
  assert.deepEqual([d.session.spentMicros, d.session.turns, d.session.auto], [15650, 3, 1]);
  assert.deepEqual([d.typed, d.turns, d.auto], [3, 3, 1]);
  // A new game session starts its totals from 0; the day's keep going.
  clock.t += 3600 * 1000;
  const ended = caps.startSession();
  assert.equal(ended.spentMicros, 15650);
  spend('anthropic', 1000);
  assert.deepEqual([caps.details().session.spentMicros, caps.details().session.byProvider.anthropic.turns], [1000, 1]);
  assert.equal(caps.details().byProvider.anthropic.spentMicros, 14550);
  // A provider name that isn't an id is bucketed, never trusted as a key; "constructor" is only a key.
  spend('__proto__', 5);
  spend('constructor', 5);
  assert.equal(caps.details().byProvider.unknown.spentMicros, 5);
  assert.equal(caps.details().byProvider.constructor.spentMicros, 5);
  assert.equal(typeof Object.prototype.constructor.micros, 'undefined', 'nothing written onto Object');
  // Per-provider totals survive a restart.
  assert.deepEqual(onFile(file, clock).details().byProvider, caps.details().byProvider);
});
