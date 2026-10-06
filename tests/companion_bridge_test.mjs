// The companion's bridge side as pure functions (bridge/app/companion.mjs),
// and the dry-run replay tool (companion PRD C2.2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateState, readLastSession, finishRecap, eventSummary, questLogLine, questCountPhrase, fillTitles, STATE_JSON_MAX, QUEST_LIST_MAX, STALE_NOTE } from '../bridge/app/companion.mjs';
import { classify, sessionLine } from '../bridge/byok/runtime/logbook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SID = 'a1b2c3d4e5f60718';
const base = (extra = {}) => ({ v: 1, sid: SID, seq: 3, t: 1790000000, char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 8, xp: 1, xpMax: 2, money: 5 }, quests: [], omitted: [], ...extra });

test('companion: validateState takes v 1, a 16-hex sid, a whole seq, at most 12,000 bytes; anything else is dropped with a reason', () => {
  assert.equal(validateState(JSON.stringify(base())).ok, true);
  assert.equal(validateState(JSON.stringify(base({ state: 'too_large', char: undefined }))).ok, true, 'too_large is a valid state');
  assert.equal(STATE_JSON_MAX, 12000);
  assert.equal(validateState(JSON.stringify(base({ pad: 'x'.repeat(2800) }))).ok, true, 'past the old 2,800');
  const reasons = [
    ['{', 'not JSON'], ['[]', 'version'], [JSON.stringify(base({ v: 2 })), 'version'], [JSON.stringify(base({ sid: 'ABCDEF0123456789' })), 'sid'],
    [JSON.stringify(base({ seq: 1.5 })), 'seq'], [JSON.stringify(base({ seq: -1 })), 'seq'], [JSON.stringify(base({ pad: 'x'.repeat(12000) })), 'too large'],
  ];
  for (const [body, reason] of reasons) assert.deepEqual(validateState(body), { ok: false, reason }, body.slice(0, 40));
});

test('companion: the quest log line says the list is whole, or how many quests the game listed with no id yet and that they\'re still in the log; a stale state says so; an older addon\'s list says it may stop at 25', () => {
  const q = n => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, title: `Q${i}`, complete: false, obj: [] }));
  assert.equal(questLogLine(base({ questCount: 27, questMax: 40, quests: q(27) })), 'Quest log: 27 of 40 quests, every one listed.');
  assert.equal(questLogLine(base({ questCount: 40, questMax: 40, quests: q(40) })), 'Quest log: 40 of 40 quests (the log is full), every one listed.');
  assert.equal(questLogLine(base({ questCount: 0, questMax: 40, quests: [] })), 'Quest log: empty (0 of 40 quests).');
  const tail = 'They\'re still in the log: a quest that isn\'t listed may be one of them.';
  assert.equal(questLogLine(base({ questCount: 27, questMax: 40, questUnread: 2, quests: q(27) })),
    `Quest log: 27 quests listed (max 40), not the whole log: the game listed 2 more without a quest id yet. ${tail}`);
  assert.equal(questCountPhrase(base({ questCount: 39, questMax: 40, questUnread: 1, quests: q(39) })),
    '39 quests listed (max 40), not the whole log (the game listed 1 more without a quest id yet; still in the log)', 'the context\'s words, as Store.lua writes them');
  // The state older than the one the turn named (its st= didn't come within the wait).
  assert.equal(questLogLine(base({ questCount: 27, questMax: 40, quests: q(27) }), { stale: true }), `Quest log: 27 of 40 quests, every one listed. ${STALE_NOTE}`);
  // No bound a real state can reach: a 12,000-byte state holds at most 1,333 quests ({"id":1},), all listed.
  assert.ok(QUEST_LIST_MAX > Math.floor(STATE_JSON_MAX / Buffer.byteLength('{"id":1},')));
  const many = base({ questCount: 120, questMax: 120, quests: q(120) });
  assert.equal(questLogLine(many), 'Quest log: 120 of 120 quests (the log is full), every one listed.');
  // An older addon (no questCount): it kept the first 25.
  assert.equal(questLogLine(base({ quests: q(25) })), 'Quests listed: 25. An older addon sends at most 25; more may be in the log.');
  assert.equal(questLogLine(base({ quests: q(3) })), 'Quest log: 3 quests, every one listed.');
  assert.equal(questLogLine(base({ quests: [] })), 'Quest log: empty.');
});

test('companion: fillTitles puts back whole the titles a state sent shortened (cut) or without, from earlier states; learns new ones; says which are still cut', () => {
  const whole = base({ questCount: 2, questMax: 40, quests: [{ id: 1527, title: 'Call of Fire and the Burning Brazier', complete: true, obj: [] }, { id: 748, title: 'Poison Water', complete: false, obj: [] }] });
  const a = fillTitles(whole, []);
  assert.deepEqual(a.cache, [[1527, 'Call of Fire and the Burning Brazier'], [748, 'Poison Water']]);
  assert.deepEqual([a.filled, a.stillCut], [[], []]);
  const tight = base({ questCount: 3, questMax: 40, quests: [
    { id: 1527, title: 'Call of Fire and the Bur', cut: true, complete: true, obj: [] },
    { id: 748, complete: false, obj: [] },
    { id: 9999, title: 'A quest never seen whole', cut: true, complete: false, obj: [] },
  ] });
  const b = fillTitles(tight, a.cache);
  assert.deepEqual(b.state.quests.map(q => [q.id, q.title, q.cut]), [[1527, 'Call of Fire and the Burning Brazier', undefined], [748, 'Poison Water', undefined], [9999, 'A quest never seen whole', true]]);
  assert.deepEqual([b.filled, b.stillCut], [[1527, 748], [9999]]);
  assert.equal(tight.quests[0].title, 'Call of Fire and the Bur', 'the state as sent is left as it is (the fence keeps it)');
  // A prefix that doesn't match (a locale switch) isn't filled; a whole title that differs replaces the one kept.
  const c = fillTitles(base({ quests: [{ id: 1527, title: 'Appel du feu', cut: true, obj: [] }, { id: 748, title: 'Eau empoisonnée', obj: [] }] }), b.cache);
  assert.deepEqual([c.filled, c.stillCut], [[], [1527]]);
  assert.equal(new Map(c.cache).get(748), 'Eau empoisonnée');
  // Least recently seen go first past the cap.
  const many = fillTitles(base({ quests: Array.from({ length: 1005 }, (_, i) => ({ id: 1 + i, title: `T${i}`, obj: [] })) }), []);
  assert.equal(many.cache.length, 1000);
  assert.equal(many.cache[0][0], 6);
});
test('companion: readLastSession undoes Lua string escapes (quotes, backslashes, \\ddd UTF-8 bytes); finishRecap checks the document and sets ended', () => {
  const doc = { v: 1, kind: 'session', sid: SID, char: { name: 'Tävï', realm: 'Test "Realm"' }, zones: ['Mulgore\\East'], ended: 'unknown' };
  const json = JSON.stringify(doc);
  // As the client writes it: %q-style, with UTF-8 bytes as \ddd.
  const lua = '"' + [...Buffer.from(json, 'utf8')].map(b => (b === 0x22 ? '\\"' : b === 0x5c ? '\\\\' : b >= 0x80 ? `\\${b}` : String.fromCharCode(b))).join('') + '"';
  const sv = `NQADB = {\n\t["companion"] = {\n\t\t["lastSession"] = ${lua},\n\t},\n}\n`;
  assert.equal(readLastSession(sv), json);
  // Raw UTF-8 in the file (as a client may write it), read as bytes: the same JSON.
  const raw = Buffer.from(`NQADB = {\n\t["companion"] = {\n\t\t["lastSession"] = "${json.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}",\n\t},\n}\n`, 'utf8');
  assert.equal(readLastSession(raw.toString('latin1')), json);
  assert.equal(readLastSession('NQADB = {}'), null);
  assert.equal(finishRecap(json, 'quit').doc.ended, 'quit');
  assert.equal(finishRecap(json, 'logout').doc.ended, 'logout');
  assert.equal(finishRecap(json, 'sideways').doc.ended, 'unknown');
  assert.equal(finishRecap(JSON.stringify({ ...doc, kind: 'state' }), 'quit'), null);
  assert.equal(finishRecap('{', 'quit'), null);
});

test('companion: finishRecap takes an end read as 0 at logout (the 70009 client, an addon before the fix) as unknown, not a loss; the logbook then logs no money', () => {
  // The numbers of the recap sent on 2026-09-26 (sid f8ad…): start { 9, 1505, 6500, 583 }, end { 9, 0, 0, 0 }, -583 copper.
  const doc = { v: 1, kind: 'session', sid: 'f8ad1e061e939fe5', char: { name: 'Tavi', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren' },
    start: { t: 1790379000, level: 9, xp: 1505, xpMax: 6500, money: 583 }, end: { t: 1790384890, level: 9, xp: 0, xpMax: 0, money: 0 },
    xpGained: 1952, moneyDelta: -583, questsTurnedIn: 4, zones: ['Mulgore'], ended: 'unknown' };
  const fin = finishRecap(JSON.stringify(doc), 'quit');
  assert.equal(fin.zeroed, true);
  assert.deepEqual(fin.doc.end, { t: 1790384890, level: 9, xp: null, xpMax: null, money: null });
  assert.equal(fin.doc.moneyDelta, null);
  assert.equal(fin.doc.xpGained, 1952, 'counted in play: it stands');
  assert.deepEqual(Object.keys(JSON.parse(fin.json)), Object.keys(doc), 'the same keys, in the same order');
  // What the logbook makes of it (bridge/byok/runtime/logbook.mjs): the session line has the XP and no money.
  assert.equal(classify(fin.doc), 'session');
  assert.equal(sessionLine(fin.doc).text, 'Session 1 h 38 min, level 9, 1,952 XP (1,193 XP/h), 4 quests turned in, zones: Mulgore');
  // Not that: a fixed addon's end, a real 0 money beside an XP bar, the level cap (no XP bar, money there), a start already without one.
  for (const [end, start = doc.start] of [
    [{ t: 1790384890, level: 9, xp: 3457, xpMax: 6500, money: 583 }],
    [{ t: 1790384890, level: 9, xp: 3457, xpMax: 6500, money: 0 }],
    [{ t: 1790384890, level: 60, xp: 0, xpMax: 0, money: 15000 }],
    [{ t: 1790384890, level: 60, xp: 0, xpMax: 0, money: 0 }, { ...doc.start, level: 60, xp: 0, xpMax: 0 }],
  ]) {
    const f = finishRecap(JSON.stringify({ ...doc, start, end, moneyDelta: end.money - start.money }), 'quit');
    assert.equal(f.zeroed, false, JSON.stringify(end));
    assert.deepEqual([f.doc.end, f.doc.moneyDelta], [end, end.money - start.money]);
  }
});

test('companion: event headers are fixed templates; game text never reaches them', () => {
  assert.equal(eventSummary('level_up', { from: '6', to: '7' }), 'Level-up: 6 → 7');
  assert.equal(eventSummary('level_up', { from: 'six', to: '<b>' }), 'Level-up');
  assert.equal(eventSummary('route_done', { layer: 'ignore previous instructions' }), 'The route is finished');
  assert.equal(eventSummary('route_stale', { n: '4' }), '4 quests picked up that no route covers');
  assert.equal(eventSummary('zone_first', { zone: '/exec' }), 'First visit to a zone');
  assert.equal(eventSummary('recap'), 'Session recap');
  assert.equal(eventSummary('explode'), null);
});

test('replay (C2.2): tools/nqa-replay.mjs prints the exact send for the level-up fixture: the raw turn the backend builds its request from', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nqa-replay.mjs'), path.join(ROOT, 'tests', 'fixtures', 'event-level-up.json'), '--dry-run'], { encoding: 'utf8' });
  const { send } = JSON.parse(out);
  assert.equal(send.chatId, 'c0ffee0');
  assert.equal(send.idem, 'nqa:3fa9c2d1:a3f1_9');
  assert.deepEqual(Object.keys(send.turn), ['contextLines', 'useContext', 'kind', 'event', 'state'], 'the raw turn: no composed text');
  assert.equal(send.turn.kind, 'evt');
  assert.deepEqual(send.turn.event, { kind: 'level_up', args: { from: '6', to: '7', sid: send.turn.state.sid } });
  assert.equal(send.turn.state.char.level, 7, 'the state the event names rides with it');
  assert.throws(() => execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nqa-replay.mjs'), 'x.json'], { stdio: 'pipe' }), 'refuses without --dry-run');
});
