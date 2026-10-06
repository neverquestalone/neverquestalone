// The usage history the app shows (bridge/byok/usage/history.mjs; public BYOK PRD §9.2 "Totals", US-1,
// US-7): per local day and provider, the last 50 turns, numbers and ids only, 90 days kept, atomic
// 0600 writes, a corrupt file kept aside. Temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageHistory, cleanRow, dayRange, KEEP_DAYS, RECENT_MAX } from '../../bridge/byok/usage/history.mjs';
import { localDay } from '../../bridge/byok/usage/caps.mjs';

const DAY = 86400000;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-usage-history-'));
const T0 = new Date(2026, 8, 26, 15, 0, 0).getTime();

test('record → view: today\'s totals by provider, typed and automatic turns apart, the recent list newest first', () => {
  let t = T0;
  const h = createUsageHistory({ now: () => t });
  h.record({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'claude-haiku-4-5', in: 7500, out: 350, micros: 9300, exact: false });
  t += 1000;
  h.record({ chatId: 'c0ffee0', provider: 'anthropic', model: 'claude-haiku-4-5', in: 6500, out: 250, micros: 7750, exact: false, auto: true });
  t += 1000;
  h.record({ chatId: 'c3f9a1e', provider: 'openrouter', model: 'meta-llama/llama-4-scout:free', in: 900, out: 40, micros: 0, exact: true, error: 'overloaded' });
  const v = h.view({ days: 3 });
  assert.deepEqual(v.days.map(d => d.day), [localDay(T0 - 2 * DAY), localDay(T0 - DAY), localDay(T0)], 'every day of the window, oldest first');
  assert.deepEqual(v.days[0], { day: localDay(T0 - 2 * DAY), micros: 0, turns: 0, auto: 0, byProvider: {} });
  assert.deepEqual(v.days[2], { day: localDay(T0), micros: 17050, turns: 2, auto: 1,
    byProvider: { anthropic: { micros: 17050, turns: 2, auto: 1 }, openrouter: { micros: 0, turns: 1, auto: 0 } } },
  'a provider\'s turns are all of them, auto the automatic ones among them (the window splits them as the day rows)');
  assert.equal(v.recent.length, 3);
  assert.deepEqual(v.recent[0], { at: T0 + 2000, chatId: 'c3f9a1e', provider: 'openrouter', model: 'meta-llama/llama-4-scout:free', in: 900, out: 40, micros: 0, exact: true, error: 'overloaded' });
  assert.equal(v.recent[1].auto, true);
  assert.equal(h.view().days.length, 30, 'the default window is 30 days');
  assert.equal(h.view({ days: 400 }).days.length, KEEP_DAYS, 'at most what is kept');
});

test('only numbers and ids are kept: text, fractions, negative counts and odd ids are dropped', () => {
  const r = cleanRow({ at: T0, chatId: 'not a chat', provider: 'anthropic\nx', model: 'a model with spaces', in: 12.7, out: -3, micros: 99.9, exact: 'yes', error: 'Bad thing happened', text: 'hello', prompt: 'secret' });
  assert.deepEqual(r, { at: T0, chatId: null, provider: 'unknown', model: '', in: 12, out: 0, micros: 99, exact: false });
  assert.equal(cleanRow({}), null, 'no time, no row');
});

test('persisted atomically (0600), read back, pruned to 90 days; the recent list holds the last 50', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage-history.json');
  let t = T0 - 100 * DAY;
  const a = createUsageHistory({ file, now: () => t });
  a.record({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'm', in: 1, out: 1, micros: 5, exact: true });
  t = T0;
  for (let i = 0; i < RECENT_MAX + 5; i++) { t += 1000; a.record({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'm', in: 1, out: 1, micros: 10, exact: true }); }
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600); // Windows has no POSIX modes
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.keys(raw.days).length, 1, 'the day 100 days ago is gone');
  assert.equal(raw.recent.length, RECENT_MAX);
  assert.ok(!fs.readdirSync(dir).some(f => f.includes('.tmp')), 'no temp file left');
  const b = createUsageHistory({ file, now: () => t });
  const v = b.view({ days: 1 });
  assert.equal(v.days[0].micros, 10 * (RECENT_MAX + 5));
  assert.equal(v.days[0].turns, RECENT_MAX + 5);
  assert.equal(v.recent.length, RECENT_MAX);
  assert.equal(v.recent[0].at, t);
  // "Delete usage history" drops every row and every day but today's totals, which a cap the player
  // set counts against (the history is the one store of daily totals: systems plan D6).
  b.clear();
  const c = createUsageHistory({ file, now: () => t });
  assert.deepEqual(c.view({ days: 1 }).recent, []);
  assert.equal(c.view({ days: 1 }).days[0].turns, RECENT_MAX + 5, 'today\'s totals stay');
  assert.deepEqual(c.days().map(d => d.day), [localDay(t)]);
});

test('the one store of daily totals: day() and days() with how many were estimated; a file that can\'t be read says so (loadError, keptAs) until acknowledged', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage-history.json');
  let t = T0;
  const h = createUsageHistory({ file, now: () => t });
  h.record({ provider: 'anthropic', micros: 100, exact: true });
  h.record({ provider: 'anthropic', micros: 250, exact: false, auto: true });
  t += DAY;
  h.record({ provider: 'openai', micros: 40, exact: false });
  assert.deepEqual(h.day(localDay(T0)), { micros: 350, turns: 1, auto: 1, estimated: 1, byProvider: { anthropic: { micros: 350, turns: 2, auto: 1 } } });
  assert.deepEqual(h.day().micros, 40, 'today by default');
  assert.deepEqual(h.day('2020-01-01'), { micros: 0, turns: 0, auto: 0, estimated: 0, byProvider: {} });
  assert.deepEqual(h.days().map(d => [d.day, d.micros, d.estimated]), [[localDay(t), 40, 1], [localDay(T0), 350, 1]], 'newest first');
  assert.equal(h.loadError, null);
  fs.writeFileSync(file, '{"v":1,"days":');
  const bad = createUsageHistory({ file, now: () => t });
  assert.equal(bad.loadError, 'corrupt');
  assert.match(path.basename(bad.keptAs), /^usage-history\.json\.corrupt-\d+$/);
  assert.equal(bad.acknowledgeLoadError(), true);
  assert.equal(bad.loadError, null);
});

test('a provider\'s automatic turns are read back from disk; a file from before them reads as 0, and never more than its turns', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage-history.json');
  const a = createUsageHistory({ file, now: () => T0 });
  a.record({ chatId: 'c0ffee0', provider: 'anthropic', model: 'm', in: 1, out: 1, micros: 5, exact: true, auto: true });
  a.record({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'm', in: 1, out: 1, micros: 5, exact: true });
  assert.deepEqual(createUsageHistory({ file, now: () => T0 }).view({ days: 1 }).days[0].byProvider, { anthropic: { micros: 10, turns: 2, auto: 1 } });
  fs.writeFileSync(file, JSON.stringify({ v: 1, days: { [localDay(T0)]: { micros: 7, turns: 2, auto: 1, byProvider: { anthropic: { micros: 7, turns: 3 }, xai: { micros: 0, turns: 1, auto: 9 } } } }, recent: [] }));
  assert.deepEqual(createUsageHistory({ file, now: () => T0 }).view({ days: 1 }).days[0].byProvider, { anthropic: { micros: 7, turns: 3, auto: 0 }, xai: { micros: 0, turns: 1, auto: 1 } });
});

test('a corrupt file is kept aside and history starts over; a write that fails is logged, never thrown', () => {
  const dir = tmp();
  const file = path.join(dir, 'usage-history.json');
  fs.writeFileSync(file, '{not json');
  const lines = [];
  const h = createUsageHistory({ file, now: () => T0, log: (k, d) => lines.push([k, d]) });
  assert.deepEqual(lines[0], ['usage-history-read-failed', { code: 'corrupt' }]);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('usage-history.json.corrupt-')));
  h.record({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'm', in: 1, out: 1, micros: 1, exact: true });
  assert.equal(h.view({ days: 1 }).days[0].turns, 1);
  // A folder where the file should be: the write fails, the history stays in memory.
  const dir2 = tmp();
  const bad = path.join(dir2, 'usage-history.json');
  const h2 = createUsageHistory({ file: bad, now: () => T0, log: (k, d) => lines.push([k, d]) });
  fs.mkdirSync(bad);
  assert.doesNotThrow(() => h2.record({ chatId: 'c3f9a1e', provider: 'anthropic', model: 'm', in: 1, out: 1, micros: 1, exact: true }));
  assert.ok(lines.some(([k]) => k === 'usage-history-write-failed'));
  assert.equal(h2.view({ days: 1 }).days[0].turns, 1);
});

test('dayRange: local calendar days, oldest first, across a month end', () => {
  assert.deepEqual(dayRange(new Date(2026, 9, 1, 9).getTime(), 3), ['2026-09-29', '2026-09-30', '2026-10-01']);
});
