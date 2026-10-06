// Rendering and game context (PRD §9.5, §9.9).
import test from 'node:test';
import assert from 'node:assert/strict';
import { withState } from '../bridge/app/context.mjs';
import { markdownToWow, renderReply, escapePipes, inlinePlain, RECORD_TEXT_MAX, TABLE_NOTE, extractUiBlocks, parseChips, parseRefs, parseWeights, systemLine } from '../bridge/app/render.mjs';
import { newMap, applyMapCommands, toSlotMap } from '../bridge/app/map.mjs';
import { slotTable } from '../bridge/transport/luaenc.mjs';

const CTX = [
  'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)',
  'Character: Tavi on Testrealm, level 6 Tauren Warrior (Horde), guild <Night Shift>',
  'Location: Mulgore - Red Cloud Mesa',
  'Position: 44.1, 76.3 on Mulgore (map 1412)',
  'Money: 1g 2s 3c; XP: 100/1000',
  'Talents: Arms 0 / Fury 0 / Protection 0',
  'Professions: Mining 50/75, Herbalism 12/75',
  'Quest log (id, * = ready to turn in): 747,750*,752',
].join('\n');

// The companion's state (F1) for the same character, some play later (cap ctx).
const STATE = {
  v: 1, sid: 'a1b2c3d4e5f60718', seq: 7, t: 1790000000,
  char: { name: 'Tavi', realm: 'Testrealm', class: 'WARRIOR', race: 'Tauren', level: 7, xp: 40, xpMax: 1100, money: 11800 },
  loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66 },
  questCount: 3, questMax: 40,
  quests: [{ id: 747, title: 'The Hunt Begins', complete: true, obj: [] }, { id: 752, complete: false, obj: [] }, { id: 761, complete: false, obj: [] }],
  prof: [{ name: 'Mining', rank: 55, max: 75 }, { name: 'Herbalism', rank: 12, max: 75 }, { name: 'Cooking', rank: 1, max: 75 }],
  pending: [], omitted: [],
};

test('context (cap ctx): withState writes the state\'s level, place, money, XP, professions and quests the way the addon does; the game, faction, guild and talents stay as stored', () => {
  assert.equal(withState(CTX, STATE), [
    'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)',
    'Character: Tavi on Testrealm, level 7 Tauren Warrior (Horde), guild <Night Shift>',
    'Location: Mulgore - Bloodhoof Village',
    'Position: 49.6, 66.0 (map 1412)',
    'Money: 1g 18s 0c; XP: 40/1100',
    'Talents: Arms 0 / Fury 0 / Protection 0',
    'Professions: Mining 55/75, Herbalism 12/75, Cooking 1/75',
    'Quest log (id, * = ready to turn in): 3 of 40 quests, all listed: 747*,752,761',
  ].join('\n'));
  // An older addon's state (no questCount): the ids alone, as its own context wrote them.
  const { questCount, questMax, ...older } = STATE;
  assert.match(withState(CTX, older), /\nQuest log \(id, \* = ready to turn in\): 747\*,752,761$/);
  // Quests the game listed with no id yet: how many, and that they're still in the log.
  assert.match(withState(CTX, { ...STATE, questUnread: 2 }), /\nQuest log \(id, \* = ready to turn in\): 3 quests listed \(max 40\), not the whole log \(the game listed 2 more without a quest id yet; still in the log\): 747\*,752,761$/);
  // None read, some not: the line still says so.
  assert.match(withState(CTX, { ...STATE, questCount: 0, quests: [], questUnread: 1 }), /\nQuest log \(id, \* = ready to turn in\): 0 quests listed \(max 40\), not the whole log \(the game listed 1 more without a quest id yet; still in the log\)$/);
  // What the state says isn't there goes: no subzone, no position (an instance), no XP bar, no quests, no professions.
  const bare = withState(CTX, { ...STATE, char: { ...STATE.char, xpMax: 0 }, loc: { map: 1412, zone: 'Mulgore' }, quests: [], prof: [] });
  assert.deepEqual(bare.split('\n').slice(1, 5), ['Character: Tavi on Testrealm, level 7 Tauren Warrior (Horde), guild <Night Shift>', 'Location: Mulgore', 'Money: 1g 18s 0c', 'Talents: Arms 0 / Fury 0 / Protection 0']);
  assert.equal(bare.split('\n').length, 5);
  // Money written as the addon writes it.
  for (const [c, s] of [[3, '3c'], [703, '7s 3c'], [10000, '1g 0s 0c'], [123456, '12g 34s 56c']]) {
    assert.match(withState(CTX, { ...STATE, char: { ...STATE.char, money: c } }), new RegExp(`\nMoney: ${s}; XP: 40/1100\n`));
  }
});

test('context (cap ctx): what the state doesn\'t have stays as stored; too_large, another character, or no state change nothing', () => {
  const tooLarge = { v: 1, sid: 'a1b2c3d4e5f60718', seq: 7, state: 'too_large' };
  assert.equal(withState(CTX, tooLarge), CTX, 'too_large: the stored lines as they were');
  assert.equal(withState(CTX, null), CTX);
  for (const char of [{ ...STATE.char, name: 'Jok' }, { ...STATE.char, name: 'Tavilicious' }, { ...STATE.char, realm: 'Otherrealm' }]) {
    assert.equal(withState(CTX, { ...STATE, char }), CTX, `${char.name}-${char.realm}: another character's context isn't mixed in`);
  }
  // A state without some keys: those lines stay as stored.
  const noLoc = withState(CTX, { ...STATE, loc: undefined, prof: undefined });
  assert.match(noLoc, /\nLocation: Mulgore - Red Cloud Mesa\nPosition: 44\.1, 76\.3 on Mulgore \(map 1412\)\nMoney: 1g 18s 0c; XP: 40\/1100\n/);
  assert.match(noLoc, /\nProfessions: Mining 50\/75, Herbalism 12\/75\n/);
  // A context without a line the state has gets it, in the addon's order.
  assert.equal(withState('Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)\nCharacter: Tavi on Testrealm, level 6 Tauren Warrior (Horde)', STATE).split('\n')[2], 'Location: Mulgore - Bloodhoof Village');
});

test('render: pipes are doubled so agent text can never form a game escape (RC-4, TB3)', () => {
  const evil = 'click |Hitem:19019|h[Thunderfury]|h and |cffff0000red|r |TInterface\\\\Icons\\\\x:0|t';
  const out = markdownToWow(evil);
  assert.equal(out, escapePipes(evil));
  // Every | in the output is either doubled or one of our own color codes.
  const bare = markdownToWow('# Title with | pipe').replace(/\|\|/g, '').replace(/\|cff[0-9a-f]{6}|\|r/g, '');
  assert.doesNotMatch(bare, /\|/);
});

test('render: headings, bullets, code, links, emphasis and tables', () => {
  const md = ['## Route', '- Take the **flight** to [Thunder Bluff](https://x.y/tb)', '  - then `/wave`', '1. step one', '```lua', 'print("a|b")', '```', '| a | b |', '|---|---|', '| 1 | 2 |', '> quoted'].join('\n');
  const out = markdownToWow(md).split('\n');
  assert.equal(out[0], '|cffffd100Route|r');
  assert.equal(out[1], '• Take the flight to Thunder Bluff (https://x.y/tb)');
  assert.equal(out[2], '  • then /wave');
  assert.equal(out[3], '1. step one');
  assert.equal(out[4], '    |cffa0a0a0print("a||b")|r');
  assert.equal(out[5], `|cffa0a0a0${TABLE_NOTE}|r`);
  assert.equal(out[6], 'a · b');
  assert.equal(out[7], '1 · 2');
  assert.equal(out[8], '|cffa0a0a0  quoted|r');
  assert.equal(inlinePlain('snake_case_name and _it_ and *em*'), 'snake_case_name and it and em');
});

test('render (SC-7 step 3, LS-04, code health): controls, bidi and zero-width characters never reach the text, the summary, the chips or a system line', () => {
  const BAD = /[\u{0}-\u{8}\u{b}-\u{1f}\u{7f}-\u{9f}\u{ad}\u{61c}\u{200b}-\u{200f}\u{2028}-\u{202e}\u{2060}-\u{206f}\u{fe00}-\u{fe0f}\u{feff}]/u;
  const FENCE = '```';
  const r = renderReply(`a\u{0}b\u{202e}c\u{200b}d\u{85}e\u{2028}f\u{feff}g\u{ad}h.\n\n${FENCE}wowchips\n["\u{202e}evil", "x\u{0}y\u{200b}z", "\\u2066escaped\\u0007"]\n${FENCE}\n`);
  assert.doesNotMatch(r.text, BAD);
  assert.doesNotMatch(r.summary, BAD);
  assert.equal(r.chips.length, 3);
  for (const c of r.chips) assert.doesNotMatch(c, BAD, JSON.stringify(c));
  assert.match(r.text, /^abcd/, 'taken out, not turned into spaces');
  assert.ok(r.text.includes('e\nf'), 'a line separator becomes a line break');
  assert.doesNotMatch(parseChips('["\u{202e}evil"]')[0], BAD);
  assert.doesNotMatch(systemLine('x\u{202e}y\u{0}z'), BAD);
  assert.doesNotMatch(renderReply('\u{202e}Hello\u{200b} world. more').summary, BAD);
  assert.equal(renderReply('one\ttwo |x\nthree').text, 'one\ttwo ||x\nthree', 'tabs, line breaks and pipe doubling as before');
});

test('render: TL;DR split and the first-sentence fallback (RC-3)', () => {
  const a = renderReply('Long answer here. More detail.\n\n**TL;DR:** Fly from Thunder Bluff | fast.');
  assert.equal(a.summary, 'Fly from Thunder Bluff || fast.');
  const b = renderReply('## Plan\nGo north first. Then east.');
  assert.equal(b.summary, 'Plan');
  const c = renderReply('Go north first. Then east.');
  assert.equal(c.summary, 'Go north first.');
  assert.ok(renderReply('x'.repeat(500)).summary.length <= 160);
});

test('render (UI v2): wowchips, wowrefs and wowweights leave the text and ride as chips, refs and weights', () => {
  const r = renderReply([
    'The forge is east of the inn.',
    '```wowchips', 'Route me there', '- Where do I train?', '3. Thanks | a **lot**', 'a fourth one', '```',
    '```wowrefs', '{"q":[766,"770",0,-1,1.5],"items":[4804],"spell":8017,"npc":[5]}', '```',
    '```wowweights', '{"str":1,"STA":0.5,"bogus":3,"agi":"x","int":1e9}', '```',
    '', 'TL;DR: Forge east of the inn.',
  ].join('\n'));
  assert.doesNotMatch(r.text, /wowchips|wowrefs|wowweights|Route me there|4804|"str"/);
  assert.match(r.text, /^The forge is east of the inn\./);
  assert.equal(r.summary, 'Forge east of the inn.', 'blocks after the TL;DR never leak into it');
  assert.deepEqual(r.chips, ['Route me there', 'Where do I train?', 'Thanks a lot'], 'three at most, plain words, no |');
  assert.deepEqual(r.refs, { q: [766, 770], i: [4804], s: [8017] }, 'whole ids only, known kinds only');
  assert.deepEqual(r.weights, { str: 1, sta: 0.5 }, 'known keys, numbers under 100');
  assert.deepEqual(r.uiErrors, []);
  // The other shapes: a JSON list of chips, refs as lines; long chips are cut at a word.
  assert.deepEqual(parseChips('["Yes", "No thanks", "Yes"]'), ['Yes', 'No thanks']);
  assert.equal(parseChips('word '.repeat(30))[0].length <= 60, true);
  assert.ok(parseChips('word '.repeat(30))[0].endsWith('…'));
  assert.deepEqual(parseRefs('quest 766, 770\nitem: 4804\nspells 8017 8018\nnonsense 5'), { q: [766, 770], i: [4804], s: [8017, 8018] });
  assert.equal(parseWeights('[1,2]'), null);
  assert.equal(parseWeights('{"luck":1}'), null);
  // Nothing usable: the block still leaves, and the bridge logs why.
  const bad = extractUiBlocks('Hi.\n```wowrefs\nnone here\n```\n```wowchips\n\n```');
  assert.equal(bad.text.trim(), 'Hi.');
  assert.deepEqual(bad.errors, ['wowrefs: nothing usable', 'wowchips: nothing usable']);
  assert.equal(renderReply('Plain answer.\n\nTL;DR: done').chips, null, 'no blocks, no fields');
});

test('UI blocks: only fences on lines of their own count; a sentence that mentions one keeps every word', () => {
  const said = 'Use a ```wowchips block like ``` this.\nStill here.';
  assert.deepEqual(extractUiBlocks(said), { text: said, chips: null, refs: null, weights: null, errors: [] });
  const inline = 'a ```wowchips\nfoo``` b';
  assert.equal(extractUiBlocks(inline).text, inline);
  const indented = extractUiBlocks('Here.\n  ```wowrefs\n{"q":[12]}\n  ```\nThere.');
  assert.deepEqual(indented.refs, { q: [12] });
  assert.equal(indented.text, 'Here.\n\nThere.');
});

test('render: wowmap blocks leave the text and become map commands (RC-7)', () => {
  const r = renderReply('Here you go.\n```wowmap\n{"op":"set","layer":"route","title":"Hyjal","ordered":true,"points":[{"m":1412,"x":44.1,"y":76.3,"label":"start","kind":"poi"}]}\n```\nTL;DR: route drawn');
  assert.doesNotMatch(r.text, /wowmap|"op"/);
  assert.equal(r.mapCommands.length, 1);
  const map = newMap('e1');
  assert.equal(applyMapCommands(map, r.mapCommands).changed, true);
  assert.deepEqual(toSlotMap(map), { epoch: 'e1', version: 1, layers: [{ name: 'route', title: 'Hyjal', ordered: true, loop: false, points: [[1412, 44.1, 76.3, 'start', 'poi']] }] });
});

test('map: a stop can say what to do there (note) and which quests it serves (q); both reach the slot file', () => {
  const r = renderReply('Route.\n```wowmap\n' + JSON.stringify({ op: 'set', layer: 'mulgore', title: 'Mulgore quests', ordered: true, points: [
    { m: 1412, x: 49.5, y: 67.5, label: '2. Wolves', kind: 'kill', note: 'Kill 8 Prairie Wolves |cffff0000now\nand 6 Plainstriders.', q: [761, '762', 761, -3, 1.5, 'x'] },
    { m: 1412, x: 57.6, y: 63.2, label: '4. Malah', kind: 'turnin', q: [764] },
    { m: 1412, x: 45, y: 61.6, label: '1. Pyall', kind: 'turnin', note: 'Turn in Cooking.' },
    { m: 1412, x: 46, y: 60, label: '5. Plain', kind: 'poi' },
  ] }) + '\n```\nTL;DR: route drawn');
  const map = newMap('e1');
  applyMapCommands(map, r.mapCommands);
  const pts = toSlotMap(map).layers[0].points;
  assert.deepEqual(pts[0], [1412, 49.5, 67.5, '2. Wolves', 'kill', 'Kill 8 Prairie Wolves cffff0000now and 6 Plainstriders.', [761, 762]], 'pipes and new lines cleaned; q kept to whole positive ids, once each');
  assert.deepEqual(pts[1], [1412, 57.6, 63.2, '4. Malah', 'turnin', '', [764]], 'q without a note keeps its place');
  assert.deepEqual(pts[2], [1412, 45, 61.6, '1. Pyall', 'turnin', 'Turn in Cooking.']);
  assert.deepEqual(pts[3], [1412, 46, 60, '5. Plain', 'poi'], 'a plain point is unchanged');
  const lua = slotTable('NQA_SlotData', { v: 2, token: 't', bridge: {}, records: [], map: toSlotMap(map) }, { includeMap: true }).text;
  assert.ok(lua.includes('{ 1412, 57.6, 63.2, "4. Malah", "turnin", "", { 764 } }'), lua);
});

test('map: notes are capped at 200 characters each and budgeted per layer and per map', () => {
  const long = 'n'.repeat(500);
  const pts = Array.from({ length: 40 }, (_, i) => ({ m: 1412, x: i, y: i, label: 'p' + i, kind: 'poi', note: long }));
  const map = newMap('e1');
  const res = applyMapCommands(map, [{ op: 'set', layer: 'a', points: pts }]);
  const kept = map.layers.a.points.filter(p => p.note);
  assert.equal(kept[0].note.length, 200);
  assert.equal(kept.length, 30, '6,000 characters of notes per layer');
  assert.ok(res.notes.some(n => /notes past 6000 characters dropped/.test(n)));
  // Three more layers: past 16,000 characters on the map, the oldest layer's notes go.
  for (const name of ['b', 'c']) applyMapCommands(map, [{ op: 'set', layer: name, points: pts }]);
  assert.equal(map.layers.a.points.some(p => p.note), false);
  assert.equal(map.layers.c.points.filter(p => p.note).length, 30);
});

test('render: records longer than 12,000 characters are cut, with the rest counted in more (RC-2)', () => {
  const r = renderReply(('line of text\n').repeat(2000));
  assert.ok(r.text.length <= RECORD_TEXT_MAX);
  assert.ok(r.more > 0);
  assert.equal(r.text.length + r.more, ('line of text\n').repeat(2000).trim().length);
});
