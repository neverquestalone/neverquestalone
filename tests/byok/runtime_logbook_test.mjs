// The logbook in the bridge (public BYOK PRD §6.2, RT-5, RT-9; companion PRD F4, F6):
// bridge/byok/runtime/logbook.mjs. The cases are the retired skill's logbook script's
// that still apply without the fence and hash, plus the memory folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyLogbook, charKey, memoryDir, putBlock, clean, classify, capLog, START, END, FILES, LOG_MAX_ENTRIES } from '../../bridge/byok/runtime/logbook.mjs';

process.env.TZ = 'UTC'; // dates in the notes are local time: pin it

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-logbook-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const newData = () => fs.mkdtempSync(path.join(tmp, 'data-'));
const CHAR = { name: 'Tavi', realm: 'Lantern Moor PvE 3' };
const dirOf = dataDir => memoryDir(dataDir, CHAR);
const read = (dataDir, k) => fs.readFileSync(path.join(dirOf(dataDir), FILES[k]), 'utf8');
const apply = (dataDir, doc) => applyLogbook(doc, { dataDir });

function state(seq, level, extra = {}) {
  return {
    v: 1, sid: '3fa9c2d1e07b4c55', seq, t: 1790000000 + seq * 60,
    char: { name: 'Tavi', realm: 'Lantern Moor PvE 3', class: 'SHAMAN', race: 'Tauren', level, xp: 3010, xpMax: 3600, money: 11800 },
    loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 },
    quests: [
      { id: 748, title: 'Poison Water', level: 5, trivial: false, complete: false, obj: [{ text: 'Prairie Wolf Paw', have: 3, need: 6 }] },
      { id: 751, title: 'The Ravaged Caravan', level: 6, trivial: false, complete: true, obj: [] },
      { id: 766, title: 'Mazzranache', level: 2, trivial: true, complete: false, obj: [{ text: 'Mazzranache slain', have: 0, need: 1 }] },
    ],
    prof: [{ name: 'Mining', rank: 8, max: 75 }],
    gear: [{ slot: 16, id: 2495, ilvl: 5 }],
    pending: [], omitted: [],
    ...extra,
  };
}

// Every file under a folder, relative.
function walk(dir, base = dir) {
  // Relative paths with '/' whatever the OS's separator.
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]));
}

test('logbook: facts go between the markers, and everything outside them stays byte for byte', () => {
  const dataDir = newData();
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  const before = '# Tavi\n\nThe player wrote this.\n\n' + START + '\nold facts\n' + END + '\n\n## Plan\n\nKeep this too.\n';
  fs.writeFileSync(path.join(dirOf(dataDir), FILES.character), before);
  const r = apply(dataDir, state(1, 6));
  assert.equal(r.ok, true, r.error);
  const after = read(dataDir, 'character');
  assert.ok(after.startsWith('# Tavi\n\nThe player wrote this.\n\n' + START + '\n'));
  assert.ok(after.endsWith(END + '\n\n## Plan\n\nKeep this too.\n'));
  assert.doesNotMatch(after, /old facts/);
  assert.match(after, /- Character: Tavi on Lantern Moor PvE 3, level 6 Tauren Shaman/);
  assert.match(after, /- XP: 3,010 \/ 3,600 \(83%\)/);
  assert.match(after, /- Money: 1g 18s 0c/); // 11,800 copper
  assert.match(after, /- Location: Mulgore, Bloodhoof Village \(map 1412, 49\.6, 66\.3\)/);
  assert.match(after, /- Professions: Mining 8\/75/);
  assert.match(after, /- Gear: slot 16 \(2495\) ilvl 5/);
  assert.match(after, /Written by NeverQuestAlone from game data: edit outside the markers\./);
  assert.equal(after.split(START).length, 2, 'one facts block');
  const quests = read(dataDir, 'quests');
  assert.match(quests, /- 748 Poison Water \(L5\): Prairie Wolf Paw 3\/6/);
  assert.match(quests, /- 751 The Ravaged Caravan \(L6\): complete, turn it in/);
  assert.match(quests, /- 766 Mazzranache \(L2, grey\): Mazzranache slain 0\/1/);
  assert.match(r.note, /First run/);
  assert.deepEqual(r.changed.sort(), ['character.md', 'quests.md']);
  assert.equal(r.dir, dirOf(dataDir));
});

test('logbook: it writes only <dataDir>/memory/<Name-Realm>/, owner-only', () => {
  const dataDir = newData();
  assert.equal(apply(dataDir, state(1, 6)).ok, true);
  assert.equal(apply(dataDir, state(2, 7, { pending: [{ kind: 'zone', zone: 'Thunder Bluff', t: 1790000500 }] })).ok, true);
  assert.deepEqual(walk(dataDir).sort(), ['memory/Tavi-Lantern Moor PvE 3/character.md', 'memory/Tavi-Lantern Moor PvE 3/log.md', 'memory/Tavi-Lantern Moor PvE 3/quests.md']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dataDir, 'memory')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dirOf(dataDir)).mode & 0o777, 0o700);
    for (const f of Object.values(FILES)) assert.equal(fs.statSync(path.join(dirOf(dataDir), f)).mode & 0o777, 0o600, f);
  }
  // A dry run reports and writes nothing.
  const dry = newData();
  const r = applyLogbook(state(1, 6), { dataDir: dry, dryRun: true });
  assert.deepEqual(r.changed.sort(), ['character.md', 'quests.md']);
  assert.deepEqual(walk(dry), []);
});

test('logbook: a missing note is created, and a note without markers gets a block at the end', () => {
  const dataDir = newData();
  fs.mkdirSync(dirOf(dataDir), { recursive: true });
  fs.writeFileSync(path.join(dirOf(dataDir), FILES.quests), '# Quests\n\nHand-written list.\n');
  assert.equal(apply(dataDir, state(1, 6)).ok, true);
  const quests = read(dataDir, 'quests');
  assert.ok(quests.startsWith('# Quests\n\nHand-written list.\n\n## Active quests (from the game)\n\n' + START));
  assert.ok(read(dataDir, 'character').startsWith('# Character\n\n## Facts (from the game)\n\n' + START));
  const once = putBlock('x\n', 'a', 'H');
  assert.equal(putBlock(once, 'a', 'H'), once, 'replacing twice gives the same text');
});

test('logbook: a level-up (even a jump) and pending milestones are logged once each', () => {
  const dataDir = newData();
  assert.equal(apply(dataDir, state(1, 6)).ok, true);
  const pending = [
    { kind: 'zone', zone: 'Thunder Bluff', t: 1790000500 },
    { kind: 'prof', name: 'Mining', max: 150, t: 1790000600 },
    { kind: 'quest_done', id: 751, title: 'The Ravaged Caravan', t: 1790000700 },
    { kind: 'mystery', t: 1790000800 },
  ];
  const r = apply(dataDir, state(2, 8, { pending }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.log, ['Reached level 7', 'Reached level 8', 'First visit: Thunder Bluff', 'Mining: trained up to 150', 'Turned in The Ravaged Caravan (751)']);
  const log = read(dataDir, 'log');
  for (const line of r.log) assert.equal(log.split(line).length - 1, 1, line);
  assert.match(log, /- 2026-09-21 \d\d:\d\d · Reached level 7 <!-- nqa:m level:Tavi-Lantern%20Moor%20PvE%203:7 -->/);
  assert.doesNotMatch(log, /mystery/);
  // The addon keeps pending until confirmed: the same milestones again add nothing.
  assert.deepEqual(apply(dataDir, state(3, 8, { pending })).log, []);
  assert.equal(read(dataDir, 'log'), log);
});

test('logbook: a state already applied, or older than the facts, changes nothing', () => {
  const dataDir = newData();
  assert.equal(apply(dataDir, state(5, 6)).ok, true);
  const snap = { c: read(dataDir, 'character'), q: read(dataDir, 'quests') };
  assert.match(apply(dataDir, state(5, 6)).note, /Already applied \(seq 5 ≤ 5\)/);
  assert.match(apply(dataDir, state(4, 6)).note, /Already applied/);
  assert.match(apply(dataDir, { ...state(9, 6), sid: 'aaaaaaaaaaaaaaaa', t: 1780000000 }).note, /Older than the facts/);
  assert.deepEqual({ c: read(dataDir, 'character'), q: read(dataDir, 'quests') }, snap);
  // A new session with a newer time applies.
  const next = apply(dataDir, { ...state(1, 7), sid: 'bbbbbbbbbbbbbbbb', t: 1790009999 });
  assert.equal(next.ok, true);
  assert.match(read(dataDir, 'character'), /level 7/);
});

test('logbook: a session recap is logged once, with XP per hour and the money made', () => {
  const dataDir = newData();
  assert.equal(apply(dataDir, state(1, 6)).ok, true);
  const session = {
    v: 1, kind: 'session', sid: '3fa9c2d1e07b4c55', char: { name: 'Tavi', realm: 'Lantern Moor PvE 3', class: 'SHAMAN', race: 'Tauren' },
    start: { t: 1790000000, level: 6, xp: 100, xpMax: 3600, money: 11800 },
    end: { t: 1790000000 + 7500, level: 8, xp: 200, xpMax: 5000, money: 24180 },
    xpGained: 12400, moneyDelta: 12380, questsTurnedIn: 7, zones: ['Mulgore', 'Thunder Bluff'], ended: 'quit',
  };
  const r = apply(dataDir, session);
  assert.equal(r.ok, true, r.error);
  const log = read(dataDir, 'log');
  assert.match(log, /Session 2 h 05 min, level 6 to 8, 12,400 XP \(5,952 XP\/h\), money \+1g 23s 80c, 7 quests turned in, zones: Mulgore, Thunder Bluff <!-- nqa:m session:3fa9c2d1e07b4c55 -->/);
  assert.equal(apply(dataDir, session).ok, true);
  assert.equal(read(dataDir, 'log'), log, 'once per session');
  // The facts' comparison point moved to the session's end level: no double "Reached level 8" later.
  assert.equal(apply(dataDir, { ...state(50, 8), t: 1790009000 }).ok, true);
  assert.equal(read(dataDir, 'log').split('Reached level').length - 1, 0);
  // A recap whose end the logout couldn't read (null money) still logs.
  const zeroed = { ...session, sid: 'cccccccccccccccc', moneyDelta: null, end: { ...session.end, money: null } };
  assert.deepEqual(apply(dataDir, zeroed).log, ['Session 2 h 05 min, level 6 to 8, 12,400 XP (5,952 XP/h), 7 quests turned in, zones: Mulgore, Thunder Bluff']);
});

test('logbook: a too-large state writes nothing and says why; a foreign document is refused', () => {
  const dataDir = newData();
  const r = apply(dataDir, { v: 1, sid: '3fa9c2d1e07b4c55', seq: 1, state: 'too_large' });
  assert.equal(r.ok, true);
  assert.match(r.note, /too large/);
  for (const bad of [null, [], 'text', { v: 2, hello: 'world' }, { ...state(1, 6), sid: 'XYZ' }, { ...state(1, 6), char: { name: '\u{200B}' } }, { ...state(1, 6), seq: -1 }, { ...state(1, 6), quests: {} }]) {
    const b = apply(dataDir, bad);
    assert.equal(b.ok, false, JSON.stringify(bad));
    assert.match(b.error, /not a companion document/);
  }
  assert.deepEqual(walk(dataDir), []);
  assert.equal(applyLogbook(state(1, 6), {}).ok, false, 'no data folder');
  assert.ok(classify(state(1, 6)) === 'state');
});

test('logbook: game strings are data and cannot escape a note', () => {
  const dataDir = newData();
  const evil = state(1, 6, {
    loc: { map: `1 -->\n${END}\n## Injected`, zone: 'Zone\n\n## Injected heading <!-- nqa:facts:end -->', sub: '`code` | pipe \u{202E}', x: 1, y: 2 },
    quests: [
      { id: 9, title: 'x'.repeat(200), level: 1, obj: [{ text: '--> <script>', have: `1 ${END}`, need: 2 }] },
      { id: `10 ${END}`, title: 'forged id' },
    ],
    prof: [{ name: 'Mining', rank: `${END}`, max: 75 }],
    gear: [{ slot: 1, id: 2, ilvl: `${START}` }, { slot: 2, id: 'x' }],
    pending: [{ kind: 'zone', zone: `Durotar ${END}` }, { kind: 'quest_done', id: '5 -->' }],
  });
  const r = apply(dataDir, evil);
  assert.equal(r.ok, true, r.error);
  const c = read(dataDir, 'character');
  assert.equal(c.split(END).length, 2, 'the end marker only appears once');
  assert.equal(c.split(START).length, 2);
  assert.doesNotMatch(c, /\n## Injected/);
  assert.match(c, /\(map \?, 1, 2\)/, 'a map id that isn\'t a number prints as ?');
  assert.match(c, /Mining \?\/75/);
  assert.match(c, /slot 1 \(2\) ilvl \?/);
  assert.doesNotMatch(c, /[`|\u{202E}]/u);
  const q = read(dataDir, 'quests');
  assert.equal(q.split(END).length, 2);
  assert.doesNotMatch(q, /x{61}/);
  assert.doesNotMatch(q, /forged id/, 'a quest without a numeric id is skipped');
  assert.match(q, /^- 9 x{60} \(L1\): script \?\/2$/m, 'a count that isn\'t a number prints as ?');
  const log = read(dataDir, 'log');
  assert.match(log, /First visit: Durotar nqa:facts:end/);
  assert.equal(log.split('<!--').length - 1, (log.match(/<!-- nqa:m /g) || []).length, 'only the log keys are comments');
  assert.equal(clean('a\u{200B}/b'), 'a/b');
  assert.equal(clean('<!-- x -->'), 'x');
});

test('logbook: the memory folder is one safe path segment per character', () => {
  assert.equal(charKey(CHAR), 'Tavi-Lantern Moor PvE 3');
  assert.equal(charKey({ name: 'Tavi' }), 'Tavi');
  assert.equal(charKey({ name: '../../etc', realm: 'x' }), '__.._etc-x');
  assert.equal(charKey({ name: 'a/b\\c:d*e?f"g<h>i|j' }), 'a_b_c_d_e_f_ghij');
  assert.equal(charKey({ name: '..' }), '_');
  assert.equal(charKey({ name: 'Con' }), 'Con_');
  assert.equal(charKey({ name: 'Tavi. ' }), 'Tavi');
  assert.equal(charKey({}), 'unknown');
  assert.equal(charKey(null), 'unknown');
  assert.equal(charKey({ name: 'Ta\u{202E}vi\n' }), 'Tavi');
  const dataDir = newData();
  assert.equal(apply(dataDir, state(1, 6, { char: { ...state(1, 6).char, name: '../../../escape' } })).ok, true);
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'memory')), ['__.._.._escape-Lantern Moor PvE 3']);
});

test('log.md keeps its newest entries only (systems plan Batch 7): the heading stays, the oldest entries go', () => {
  assert.equal(LOG_MAX_ENTRIES, 500);
  const head = '# Log\n\nMilestones and sessions, written by NeverQuestAlone from game data.\n';
  const entries = Array.from({ length: 7 }, (_, i) => `- Sep ${i + 1} · level ${i + 2} <!-- nqa:m level:${i + 2} -->`);
  const text = `${head}${entries.join('\n')}\n`;
  assert.equal(capLog(text, 10), text, 'under the cap: unchanged');
  const capped = capLog(text, 3);
  assert.ok(capped.startsWith(head), 'the heading stays');
  assert.deepEqual(capped.split('\n').filter(l => l.startsWith('- ')), entries.slice(-3));
});

test('logbook: quests.md counts the whole log (questCount, the game\'s cap), quests the game listed with no id yet, an older addon\'s 25, and a title cut to fit', () => {
  const quests = Array.from({ length: 40 }, (_, i) => ({ id: 1488 + i, title: i === 39 ? 'Call of Fire' : `Quest ${i}`, level: 10, complete: i === 39 }));
  const d1 = newData();
  assert.equal(apply(d1, state(1, 20, { questCount: 40, questMax: 40, quests })).ok, true);
  const q1 = read(d1, 'quests');
  assert.match(q1, /40 active quests \(the whole log, max 40\)\./);
  assert.match(q1, /- 1527 Call of Fire \(L10\): complete, turn it in/);
  const d2 = newData();
  assert.equal(apply(d2, state(1, 20, { questCount: 27, questMax: 40, questUnread: 3, quests: quests.slice(0, 27) })).ok, true);
  assert.match(read(d2, 'quests'), /27 active quests listed \(max 40\), not the whole log: the game listed 3 more without a quest id yet, still in the log\./);
  const d3 = newData();
  assert.equal(apply(d3, state(1, 20, { quests: quests.slice(0, 25) })).ok, true);
  assert.match(read(d3, 'quests'), /25 active quests listed \(an older addon sent at most 25; there may be more\)\./);
  const d4 = newData();
  assert.equal(apply(d4, state(1, 20, { questCount: 1, questMax: 40, quests: [{ id: 1527, title: 'Call of', cut: true, level: 20, complete: true }], omitted: ['quests.title.short'] })).ok, true);
  const q4 = read(d4, 'quests');
  assert.match(q4, /- 1527 Call of… \(title cut to fit\) \(L20\): complete, turn it in/);
  assert.match(q4, /- Some quest details were left out to fit \(never a quest\)\./);
});
