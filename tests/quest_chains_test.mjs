// Quest chains (addon/NeverQuestAlone/Chains.lua, tools/quest-chains): the rules that turn the
// emulator's quest data into "Leads to The Deadmines · step 1 of 7", on small hand-made chains
// (one rule a test) and on the shipped data; the line on the game's quest pages, in the fengari VM
// running the real addon; and the facts NeverQuestAlone gets (the state, Copy and Paste's game data,
// the bridge's data block and its fit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import * as gen from '../tools/quest-chains/generate.mjs';
import { QLOG_STUB, entriesLua, worstLog, worstOthers } from './helpers/quest-log.mjs';
import { parseRecord, inflateBody } from '../bridge/transport/records.mjs';
import { validateState, STATE_JSON_MAX, STATE_BODY_MAX } from '../bridge/app/companion.mjs';
import { fitData, buildRequest, readDataBlock, listOnlyState, CHAIN_NOTE } from '../bridge/byok/runtime/context.mjs';
import { sanitizeState } from '../bridge/byok/runtime/sanitize.mjs';

const require = createRequire(import.meta.url);
const { newVM, lstr } = require('./helpers/nqa-vm.js');

// ---------------------------------------------------------------------------
// The rules, on hand-made facts

const ALLIANCE = 1 | 4 | 8 | 64, HORDE = 2 | 16 | 32 | 128;
const WARRIOR = 1, PRIEST = 16;
// An instance a quest can be in, and the quest log's header for it outside (Uldaman's in the Badlands).
const BASE = {
  sources: { db: 'test db', maps: 'test maps', areas: 'test areas' },
  instances: {
    36: { name: 'Deadmines', kind: 1, area: 0, inside: { 206: 'Westfall', 1581: 'The Deadmines' } },
    70: { name: 'Uldaman', kind: 1, area: 1337, inside: { 1337: 'Uldaman' } },
    409: { name: 'Molten Core', kind: 2, area: 2717, inside: { 2717: 'Molten Core' } },
    30: { name: 'Alterac Valley', kind: 3, area: 0, inside: { 2597: 'Alterac Valley' } },
    169: { name: 'Emerald Dream', kind: 2, area: 0, inside: {} },
  },
  zones: { 40: { name: 'Westfall', map: 0 }, 1581: { name: 'The Deadmines', map: 36 }, 1517: { name: 'Uldaman', map: 0 }, 2597: { name: 'Alterac Valley', map: 30 } },
  items: { 900: { name: 'Blue Blade', quality: 3 }, 901: { name: 'Purple Plate', quality: 4, classes: WARRIOR }, 902: { name: 'Purple Robe', quality: 4, classes: PRIEST }, 903: { name: 'Green Ring', quality: 2 } },
};
const facts = quests => ({ ...BASE, quests });
const review = (extra = {}) => ({ instances: {}, quests: {}, ...extra });
const q = (title, more = {}) => ({ title, zone: 40, level: 18, min: 14, ...more });
// Every quest's records, as the block writes them: quest -> { all } | { class } | { race }.
const run = (qs, rv = review()) => gen.chains(facts(qs), rv);
const one = (all, id) => all.get(id)?.all;

test('a straight chain: each step its number, of the dungeon quest at its end, and the quest after it', () => {
  const all = run({
    1: q('First', { nic: 2 }), 2: q('Second', { prev: 1, nic: 3 }), 3: q('Into the Mines', { prev: 2, type: 81, zone: 1581 }),
  });
  assert.deepEqual(one(all, 1), { step: 1, of: 3, pay: { kind: 'dungeon', map: 36 }, next: 2 });
  assert.deepEqual(one(all, 2), { step: 2, of: 3, pay: { kind: 'dungeon', map: 36 }, next: 3 });
  assert.deepEqual(one(all, 3), { step: 3, of: 3, pay: { kind: 'dungeon', map: 36 }, next: null });
});

test('a dungeon or raid quest: tagged and filed under the instance (inside it, its map\'s area, or its name outside), or every objective in one instance', () => {
  const cases = {
    10: q('Tagged, filed inside', { type: 81, zone: 1581 }),
    11: q('Tagged, the header outside', { type: 81, zone: 1517 }),
    12: q('Untagged, every objective in Molten Core', { where: [409] }),
    13: q('Tagged, filed in Westfall (an area inside the Deadmines\' map has that name too)', { type: 81, zone: 40 }),
    14: q('Objectives in two instances', { where: [36, 70] }),
    15: q('Objectives in and out', { where: [0, 36] }),
    16: q('An objective found nowhere', { where: [36], unknown: 1 }),
    17: q('A battleground', { type: 62, zone: 2597, where: [30] }),
  };
  const chain = {};
  for (const [id, f] of Object.entries(cases)) {
    chain[id] = f;
    chain[Number(id) + 100] = q(`Before ${id}`, {});
    chain[id].prev = Number(id) + 100;
  }
  const all = run(chain);
  const to = id => all.get(Number(id) + 100)?.all?.pay?.map ?? null;
  assert.deepEqual([10, 11, 12, 13, 14, 15, 16, 17].map(to), [36, 70, 409, null, null, null, null, null]);
});

test('a reward: rare or better, the highest quality then the nearest, only one the class can use, and never a first step\'s own', () => {
  const all = run({
    1: q('Start', { rewards: [[900, 0]] }),
    2: q('Middle', { prev: 1, rewards: [[903, 0]] }),
    3: q('End', { prev: 2, rewards: [[901, 1], [902, 1], [900, 1]] }),
  });
  const warrior = all.get(1).class?.[WARRIOR] ?? all.get(1).all;
  const priest = all.get(1).class?.[PRIEST] ?? all.get(1).all;
  assert.equal(warrior.pay.item, 901, 'the epic the warrior can use');
  assert.equal(priest.pay.item, 902, 'the priest\'s epic');
  assert.equal(all.get(1).class[4].pay.item, 900, 'a hunter can use neither epic: the rare');
  assert.equal(warrior.of, 3);
  assert.equal(warrior.pay.more, 1, 'the warrior could take the plate or the blade: "or 1 more"');
  assert.equal(all.get(1).class[4].pay.more, 0, 'the blade is the only pick the hunter can use: no "or N more"');
});

test('a reward the class can\'t equip is no payoff for it, picked or fixed: the chain leads to the next best, or to nothing', () => {
  const all = run({
    1: q('Start'),
    2: q('Middle', { prev: 1, rewards: [[900, 0]] }),
    3: q('End', { prev: 2, rewards: [[901, 1], [902, 1]] }),
  });
  const of = (c) => all.get(1).class?.[c] ?? all.get(1).all;
  assert.deepEqual([of(WARRIOR).pay.item, of(WARRIOR).pay.more, of(WARRIOR).of], [901, 0, 3], 'the plate; the robe is no pick for a warrior');
  assert.deepEqual([of(4).pay.item, of(4).of], [900, 2], 'a hunter can use neither epic: the blade a step before');
  const none = run({ 1: q('Start'), 2: q('End', { prev: 1, rewards: [[901, 1], [902, 1]] }) });
  assert.equal(none.get(1).class?.[4], undefined, 'a hunter gets no record: nothing the chain gives is theirs');
  assert.equal(none.get(1).class[WARRIOR].pay.item, 901);
});

test('a breadcrumb or a quest only offered next is no step: the chain starts without it (a breadcrumb still leads there)', () => {
  const all = run({
    1: q('Go see Gryan', { crumb: 2, nic: 2 }),
    2: q('The Brotherhood', { nic: 3 }),
    3: q('The Mines', { prev: 2, type: 81, zone: 1581 }),
  });
  assert.deepEqual(one(all, 1), { step: null, of: null, pay: { kind: 'dungeon', map: 36 }, next: 2 }, 'the breadcrumb leads where its quest leads, with no step');
  assert.equal(one(all, 2).step, 1);
  assert.equal(one(all, 2).of, 2);
});

test('an each-from-all group is one step, done side by side: the quest after it is one past the group\'s last', () => {
  const even = run({
    1: q('Dogs', { next: 3, ex: -1 }), 2: q('Skies', { next: 3, ex: -1 }),
    3: q('Redemption', { nic: 4 }), 4: q('Into the Mines', { prev: 3, type: 81, zone: 1581 }),
  });
  assert.deepEqual([one(even, 1).step, one(even, 1).of, one(even, 3).step, one(even, 4).step], [1, 3, 2, 3]);
  const uneven = run({
    1: q('Dogs', { next: 3, ex: -1 }), 2: q('Skies', { prev: 5, next: 3, ex: -1 }), 5: q('Before the skies'),
    3: q('Redemption'), 4: q('Into the Mines', { prev: 3, type: 81, zone: 1581 }),
  });
  assert.equal(one(uneven, 3).step, 3, 'one past the group\'s last (Skies, step 2)');
  assert.equal(one(uneven, 4).step, 4);
  assert.deepEqual([one(uneven, 1).step, one(uneven, 1).of], [1, 4], 'counted from Dogs, the group waits for Skies');
});

test('two ways into a quest at different steps: the step is unknown from there on, and each way counts its own', () => {
  const all = run({
    1: q('Long way', { nic: 2 }), 2: q('Long way 2', { prev: 1, next: 4, ex: 7 }),
    3: q('Short way', { nic: 4, ex: 7 }),
    4: q('The flame', { prev: 3, type: 81, zone: 1581 }),
  });
  assert.equal(one(all, 4).step, null);
  assert.deepEqual([one(all, 1).step, one(all, 1).of], [1, 3], 'along the long way');
  assert.deepEqual([one(all, 3).step, one(all, 3).of], [1, 2], 'along the short way');
});

test('races and classes: each worked out on its own, a quest giver who\'d attack a race doesn\'t count, and records that differ go by race or class', () => {
  const all = run({
    1: q('Shared start', { races: 255 }),
    2: q('Alliance road', { races: ALLIANCE, prev: 1 }),
    3: q('Horde road', { races: HORDE, prev: 1 }), 4: q('Horde road 2', { races: HORDE, prev: 3 }),
    5: q('The mines (Alliance)', { races: ALLIANCE, prev: 2, type: 81, zone: 1581 }),
    6: q('The mines (Horde)', { races: HORDE, prev: 4, type: 81, zone: 1581 }),
    7: q('Offered by a Horde giver only', { races: 255, takers: HORDE, prev: 6, type: 81, zone: 1581 }),
  });
  const start = all.get(1);
  assert.ok(start.race, 'the step count differs by race');
  assert.equal(start.race[1].of, 3, 'a human: three steps');
  assert.equal(start.race[2].of, 5, 'an orc: through the giver who offers it to the Horde');
  assert.equal(all.get(7).all.step, 5);
  assert.equal(gen.whoCan({ races: 255, takers: HORDE }), HORDE);
});

test('a record for all only when everyone who can take the quest has it: a class or race it leads to nothing for gets none', () => {
  // The plate only a warrior can wear: a priest, who can take the quest too, gets no record of it.
  const all = run({ 1: q('Start'), 2: q('End', { prev: 1, rewards: [[901, 0]] }) });
  assert.equal(all.get(1).all, undefined, 'not one record for everyone');
  assert.deepEqual(Object.keys(all.get(1).class).map(Number), [WARRIOR]);
  // The Horde's road leads to the mines, the Alliance's to nothing: by race, the Alliance with none.
  const roads = run({
    1: q('Start', { races: 255 }), 2: q('Alliance road', { races: ALLIANCE, prev: 1 }),
    3: q('Horde road', { races: HORDE, prev: 1 }), 4: q('The mines', { races: HORDE, prev: 3, type: 81, zone: 1581 }),
  });
  assert.deepEqual(Object.keys(roads.get(1).race).map(Number).sort((a, b) => a - b), [2, 16, 32, 128]);
  // Nothing for some and a record for others that differ both ways: nothing at all, never a guess.
  assert.equal(gen.degrade([{ step: 1, of: 2, pay: { kind: 'dungeon', map: 36 }, next: 2 }, null]), null);
});

test('only the races and classes the game pairs count: an orc paladin, who doesn\'t exist, can\'t make a paladin\'s chain say nothing', () => {
  const PALADIN = 2;
  const qs = {
    1: q('Start'),
    2: q('The paladin\'s end', { prev: 1, classes: PALADIN, races: ALLIANCE, rewards: [[900, 0]] }),
    3: q('Everyone else\'s end', { prev: 1, classes: 0x7ff & ~PALADIN, rewards: [[900, 0]] }),
  };
  const combos = { 1: WARRIOR | PALADIN, 2: WARRIOR };
  const paired = gen.chains({ ...facts(qs), combos }, review());
  assert.deepEqual(paired.get(1).class[PALADIN].next, 2);
  assert.deepEqual(paired.get(1).class[WARRIOR].next, 3);
  assert.deepEqual(gen.pairs({ combos }), [[1, WARRIOR], [1, PALADIN], [2, WARRIOR]]);
  assert.equal(run(qs).get(1), undefined, 'every pair, the orc paladin included: it leads to nothing for him, so it says nothing');
  assert.equal(gen.pairs({}).length, 72);
});

test('records that differ by race and by class say only what they all agree on, and name a payoff only when they all name one', () => {
  // The Horde way is longer, and warriors take a side road: the step count differs both ways.
  const all = run({
    1: q('Start', { races: 255 }),
    2: q('Alliance road', { races: ALLIANCE, prev: 1 }),
    3: q('Horde road', { races: HORDE, prev: 1 }), 4: q('Horde road 2', { races: HORDE, prev: 3 }),
    5: q('Warrior detour', { classes: WARRIOR, prev: 2 }),
    6: q('The mines', { races: ALLIANCE, prev: 2, type: 81, zone: 1581, classes: 2047 & ~WARRIOR }),
    7: q('The mines (warriors)', { races: ALLIANCE, prev: 5, type: 81, zone: 1581, classes: WARRIOR }),
    8: q('The mines (Horde)', { races: HORDE, prev: 4, type: 81, zone: 1581 }),
  });
  const rec = all.get(1).all;
  assert.ok(rec, 'one record for everyone');
  assert.deepEqual([rec.step, rec.of, rec.pay.map, rec.next], [1, null, 36, null], 'the step all agree on; the count and the next quest left out');
  assert.equal(gen.degrade([{ step: 1, of: 3, pay: { kind: 'dungeon', map: 36 }, next: 2 }, { step: 1, of: 3, pay: { kind: 'dungeon', map: 70 }, next: 2 }]), null, 'two payoffs: nothing');
});

test('what no one can do is never a step: disabled, no quest giver, repeatable, a world event\'s, or skipped by the review', () => {
  for (const flag of [{ disabled: true }, { noStarter: true }, { repeatable: true }, { event: 1 }]) {
    const all = run({ 1: q('Start'), 2: q('Gated', { prev: 1, ...flag }), 3: q('The mines', { prev: 2, type: 81, zone: 1581 }) });
    assert.equal(all.get(1), undefined, JSON.stringify(flag));
  }
  const skipped = run({ 1: q('Start'), 2: q('Gated', { prev: 1 }), 3: q('The mines', { prev: 2, type: 81, zone: 1581 }) },
    review({ quests: { 2: { skip: true, why: 'not in the game' } } }));
  assert.equal(skipped.get(1), undefined);
});

test('a dungeon\'s "of" is the last quest after it in that instance; ties between instances fall back to a reward', () => {
  const all = run({
    1: q('Start'), 2: q('In 1', { prev: 1, type: 81, zone: 1581 }), 3: q('In 2', { prev: 2, type: 81, zone: 1581 }),
    4: q('In 3', { prev: 3, type: 81, zone: 1581 }), 5: q('After', { prev: 4 }),
  });
  assert.deepEqual([one(all, 1).of, one(all, 2).of, one(all, 3).of, one(all, 2).next], [4, 4, 4, 3]);
  const tie = run({
    1: q('Start', {}), 2: q('Deadmines way', { prev: 1, type: 81, zone: 1581 }), 3: q('Uldaman way', { prev: 1, type: 81, zone: 1517 }),
    4: q('Reward', { prev: 2, rewards: [[900, 0]] }),
  });
  assert.equal(one(tie, 1).pay.kind, 'item', 'two instances one step away: neither is named');
});

test('the review: it corrects with a why, and refuses one that repeats the rules or names a quest the facts don\'t have', () => {
  const qs = { 1: q('Start'), 2: q('Hidden dungeon', { prev: 1 }) };
  assert.equal(run(qs).get(1), undefined);
  assert.equal(one(run(qs, review({ quests: { 2: { dungeon: 36, why: 'its objective is a scripted spawn' } } })), 1).pay.map, 36);
  assert.throws(() => run(qs, review({ quests: { 2: { dungeon: 36 } } })), /needs its why/);
  assert.throws(() => run({ 1: q('Start'), 2: q('Mines', { prev: 1, type: 81, zone: 1581 }) }, review({ quests: { 2: { dungeon: 36, why: 'x' } } })), /already say/);
  assert.throws(() => run(qs, review({ quests: { 99: { skip: true, why: 'x' } } })), /not in cmangos\.json/);
  assert.throws(() => run({ 1: q('Start'), 2: q('In the Dream', { prev: 1, where: [169] }) }), /no area that names it/);
});

test('names written into Lua: a quote, a backslash, a control character, a | or a bracket is refused', () => {
  const qs = { 1: q('Start'), 2: q('End', { prev: 1, rewards: [[900, 0]] }) };
  for (const bad of ['Blue "Blade"', 'Blue\\Blade', 'Blue\nBlade', 'Blue|Blade', 'Blue [Blade]']) {
    const f = facts(qs);
    f.items = { ...f.items, 900: { name: bad, quality: 3 } };
    assert.throws(() => gen.render(f, review()), /refusing to write it/, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// The shipped data

const LUA = fs.readFileSync(gen.LUA, 'utf8');
const { facts: FACTS, review: REVIEW } = gen.load();

test('Chains.lua\'s block is exactly what generate.mjs writes from the facts and the review (run node tools/quest-chains/generate.mjs)', () => {
  assert.equal(gen.splice(LUA, gen.render(FACTS, REVIEW).block), LUA);
});

test('the shipped chains: the Deadmines from Westfall, every record a step the rules can stand behind, and the data small', () => {
  const all = gen.chains(FACTS, REVIEW);
  assert.deepEqual(all.get(65).all, { step: 1, of: 7, pay: { kind: 'dungeon', map: 36 }, next: 132 }, 'The Defias Brotherhood');
  assert.equal(all.get(166).all.step, 7);
  for (const [id, recs] of all) {
    for (const rec of recs.all ? [recs.all] : Object.values(recs.class || recs.race)) {
      if (rec.of !== null) assert.ok(rec.step !== null && rec.of >= rec.step, `quest ${id}: of ${rec.of} at step ${rec.step}`);

    }
  }
  assert.ok(all.size > 500, `${all.size} quests`);
  const block = LUA.slice(LUA.indexOf(gen.BEGIN), LUA.indexOf(gen.END));
  assert.ok(Buffer.byteLength(block) < 40000, `the block is ${Buffer.byteLength(block)} bytes`);
  assert.match(FACTS.sources.db, /28ef625/, 'the dump pinned to its commit');
});

// ---------------------------------------------------------------------------
// The addon

// The quest pages as QuestInfo.lua lays them out: each part under the last, from the title. The
// parts are the game's shared regions, moved to whichever page displays.
const PAGES = `
QUEST_TEMPLATE_DETAIL = { contentWidth = 275, parts = { "QuestInfoTitleHeader", "QuestInfoDescriptionText", "QuestInfoObjectivesText" } }
QUEST_TEMPLATE_LOG = { questLog = true, contentWidth = 285, parts = { "QuestInfoTitleHeader", "QuestInfoObjectivesText", "QuestInfoDescriptionText" } }
QUEST_TEMPLATE_MAP_DETAILS = { questLog = true, contentWidth = 289, parts = { "QuestInfoTitleHeader", "QuestInfoObjectivesText", "QuestInfoDescriptionText" } }
QUEST_TEMPLATE_REWARD = { contentWidth = 285, parts = { "QuestInfoTitleHeader", "QuestInfoRewardText" } }
QUEST_TEMPLATE_MAP_REWARDS = { questLog = true, contentWidth = 289, parts = { "QuestInfoRewardsFrame" } }
QI = { quest = 65, selected = 65 }
local function Part(name)
	local p = UIParent:CreateFontString(name)
	p.GetPoint = function(self, i) local t = self.points and self.points.TOPLEFT; if t then return "TOPLEFT", t.rel, t.relPoint, t.x, t.y end end
	p.SetParent = function(self, parent) self.parent = parent end
	p.GetTextColor = function() return 0.18, 0.12, 0.06 end
	p.GetFontObject = function() return QuestFont end
	return p
end
QuestFont = { name = "QuestFont" }
for _, n in ipairs({ "QuestInfoTitleHeader", "QuestInfoDescriptionText", "QuestInfoObjectivesText", "QuestInfoRewardText", "QuestInfoRewardsFrame" }) do Part(n) end
QuestMapRewardsFrame = CreateFrame("Frame", "QuestMapRewardsFrame", UIParent)
QuestDetailScrollChildFrame = CreateFrame("Frame", "QuestDetailScrollChildFrame", UIParent)
QuestMapDetailsContents = CreateFrame("Frame", "QuestMapDetailsContents", UIParent)
QuestRewardScrollChildFrame = CreateFrame("Frame", "QuestRewardScrollChildFrame", UIParent)
function QuestInfo_Display(template, parent)
	local last
	for _, name in ipairs(template.parts) do
		local p = _G[name]
		p:SetParent(parent)
		p:ClearAllPoints()
		p:Show()
		if last then p:SetPoint("TOPLEFT", last, "BOTTOMLEFT", 0, -5) else p:SetPoint("TOPLEFT", parent, "TOPLEFT", 10, -10) end
		last = p
	end
end
function GetQuestID() return QI.quest end
-- The offer page hides its parts while its text types in, then shows or fades them in (QuestInfo.lua).
function QuestInfo_HideAlphaDependentText(parent) end
function QuestInfo_ShowAlphaDependentText(parent) end
function QuestInfo_FadeInAlphaDependentText(parent, t) end
C_QuestLog = C_QuestLog or {}
C_QuestLog.GetSelectedQuest = function() return QI.selected end
function UnitRace() return "Human", "Human", 1 end
function UnitClass() return "Warrior", "WARRIOR", 1 end
QI.items = {}
QI.requested = {}
C_Item = C_Item or {}
C_Item.GetItemInfo = function(id) local it = QI.items[id]; if it then return it.name, it.link end end
C_Item.GetItemNameByID = function(id) local it = QI.items[id]; return it and it.name end
C_Item.RequestLoadItemDataByID = function(id) QI.requested[#QI.requested + 1] = id end
C_Map = C_Map or {}
C_Map.GetAreaInfo = function(id) return QI.areas and QI.areas[id] end
`;
const vmWith = (more = '') => newVM({ extra: PAGES + more }).login();
const show = (vm, template, parent) => vm.run(`QuestInfo_Display(${template}, ${parent})`);
const lineOn = (vm, parent) => vm.json(`(function()
  for _, c in ipairs(${parent}.children) do
    if c.kind == "Frame" and c.text and c.text.text then
      local a = c.points and c.points.TOPLEFT
      return { shown = c.shown, text = c.text.text, mouse = c.mouse == true, width = c.text.width, anchor = a and a.rel and a.rel.name, gap = a and a.y, font = c.text.font and c.text.font.name, color = c.text.textColor, alpha = c.alpha or 1 }
    end
  end
end)()`);
const under = (vm, part) => vm.json(`(function() local t = ${part}.points.TOPLEFT; return { rel = t.rel.name or (t.rel.text and t.rel.text.text and "line") or "?", y = t.y } end)()`);

test('the offer page: the line under the title, the description under the line, in the page\'s own font and colour', () => {
  const vm = vmWith();
  assert.equal(vm.bool('NS.Chains.hooked'), true, 'hooked QuestInfo_Display');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  const line = lineOn(vm, 'QuestDetailScrollChildFrame');
  assert.deepEqual(line, { shown: true, text: 'Leads to The Deadmines · step 1 of 7', mouse: false, width: 275, anchor: 'QuestInfoTitleHeader', gap: -5, font: 'QuestFont', color: [0.18, 0.12, 0.06], alpha: 1 });
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'line', y: -10 }, 'the description 10 under the line, the templates\' gap between parts');
  // The area's name as the client has it.
  vm.run('QI.areas = { [1581] = "Les Mortemines" }');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').text, 'Leads to Les Mortemines · step 1 of 7');
});

test('no line on a quest that leads to nothing, on the reward page, or with Quest Chains off; the page\'s own layout stays as the game made it', () => {
  const vm = vmWith();
  vm.run('QI.quest = 748');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame'), null);
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'QuestInfoTitleHeader', y: -5 });
  vm.run('QI.quest = 65');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, true);
  show(vm, 'QUEST_TEMPLATE_REWARD', 'QuestRewardScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, false, 'the parts left for the reward page');
  assert.equal(lineOn(vm, 'QuestRewardScrollChildFrame'), null);
  vm.run('NQADB.settings.chains = false');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, false);
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'QuestInfoTitleHeader', y: -5 });
});

test('the quest log\'s details (the world map and the details window): the selected quest, the objectives under the line', () => {
  const vm = vmWith();
  vm.run('QI.selected = 132');
  show(vm, 'QUEST_TEMPLATE_MAP_DETAILS', 'QuestMapDetailsContents');
  const line = lineOn(vm, 'QuestMapDetailsContents');
  assert.equal(line.text, 'Leads to The Deadmines · step 2 of 7');
  assert.equal(line.width, 289);
  assert.deepEqual(under(vm, 'QuestInfoObjectivesText'), { rel: 'line', y: -10 });
  // The world map shows the rewards next, in a frame of their own: the title stays, so does the line.
  show(vm, 'QUEST_TEMPLATE_MAP_REWARDS', 'QuestMapRewardsFrame');
  assert.equal(lineOn(vm, 'QuestMapDetailsContents').shown, true, 'the details keep their line');
  // The offer page takes the title: the details' line goes.
  vm.run('QI.quest = 65');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestMapDetailsContents').shown, false);
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, true);
});

test('a reward: its link in its quality\'s colour, the game\'s own once it has the item, and the reward\'s tooltip and clicks', () => {
  const vm = vmWith();
  // The Rethban Gauntlet: a warrior's chain to the Fire Hardened Hauberk.
  vm.run('QI.quest = 1699');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  let line = lineOn(vm, 'QuestDetailScrollChildFrame');
  assert.match(line.text, /^Leads to \|c[0-9a-fA-F]{8}\|Hitem:6972\|h\[Fire Hardened Hauberk\]\|h\|r · step 1 of 4$/);
  assert.equal(line.mouse, true, 'the link takes the mouse');
  assert.deepEqual(vm.json('QI.requested'), [6972], 'the game is asked for the item');
  vm.run('QI.items[6972] = { name = "Fire Hardened Hauberk", link = "|cnIQ3:|Hitem:6972::::::::22:1|h[Fire Hardened Hauberk]|h|r" }');
  vm.run('STUB.FireEvent("GET_ITEM_INFO_RECEIVED", 6972, true)');
  line = lineOn(vm, 'QuestDetailScrollChildFrame');
  assert.equal(line.text, 'Leads to |cnIQ3:|Hitem:6972::::::::22:1|h[Fire Hardened Hauberk]|h|r · step 1 of 4');
  // Hover shows the reward's tooltip; a modified click does what it does on the page's own rewards.
  vm.run(`
    local f
    for _, c in ipairs(QuestDetailScrollChildFrame.children) do if c.text and c.text.text then f = c end end
    QI.f = f
    GameTooltip.SetOwner = function(self, owner, anchor) QI.anchor = anchor end
    GameTooltip.SetHyperlink = function(self, link) QI.tip = link end
    GameTooltip.Show = function() QI.tipShown = true end
    GameTooltip.Hide = function() QI.tipShown = false end
    function GameTooltip_ShowCompareItem(tip) QI.compared = (QI.compared or 0) + 1 end
    function IsModifiedClick() return QI.modified end
    function HandleModifiedItemClick(link) QI.clicked = link end
    f.scripts.OnHyperlinkEnter(f, "item:6972", "[Fire Hardened Hauberk]")
    f.scripts.OnHyperlinkClick(f, "item:6972", "LINKTEXT", "LeftButton")
    QI.modified = true
    f.scripts.OnHyperlinkClick(f, "item:6972", "LINKTEXT", "LeftButton")`);
  assert.equal(vm.evaluate('QI.tip'), 'item:6972');
  assert.equal(vm.evaluate('QI.anchor'), 'ANCHOR_CURSOR_RIGHT', 'anchored as the page\'s own links are');
  assert.equal(vm.num('QI.compared'), 1, 'compared with what you wear, as the page\'s own rewards are');
  assert.equal(vm.bool('type(rawget(QI.f, "UpdateTooltip")) == "function"'), true, 'kept up to date while the mouse is on it (Shift to compare)');
  vm.run('QI.f.UpdateTooltip(QI.f)');
  assert.equal(vm.num('QI.compared'), 2);
  vm.run('QI.f.scripts.OnHyperlinkLeave(QI.f)');
  assert.equal(vm.bool('rawget(QI.f, "UpdateTooltip") == nil and not QI.tipShown'), true, 'off the link: no tooltip, no updates');
  assert.equal(vm.evaluate('QI.clicked'), 'LINKTEXT', 'only a modified click acts, as on the page\'s own rewards');
});

test('a record by class: the warrior\'s reward, not the priest\'s; a race or class the client won\'t name gets no line rather than another\'s', () => {
  // Finkle Einhorn, At Your Service!: Leggings of Arcana for most, Cap of the Scarlet Savant for casters.
  const warrior = vmWith();
  warrior.run('QI.quest = 5047');
  show(warrior, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.match(lineOn(warrior, 'QuestDetailScrollChildFrame').text, /\[Leggings of Arcana\]/);
  const priest = vmWith('function UnitClass() return "Priest", "PRIEST", 5 end');
  priest.run('QI.quest = 5047');
  show(priest, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.match(lineOn(priest, 'QuestDetailScrollChildFrame').text, /\[Cap of the Scarlet Savant\]/);
  const unknown = vmWith('function UnitClass() return "Warrior", "WARRIOR" end');
  assert.equal(unknown.evaluate('NS.Chains.Line(5047)'), null);
  assert.equal(unknown.evaluate('NS.Chains.Line(65)'), 'Leads to The Deadmines · step 1 of 7', 'one record for everyone needs no class');
});

test('a choice: the first pick this class can equip, "or N more" counting only the picks it could take; none it can equip, no line', () => {
  // The Islander: the warrior can take any of the three Whirlwind picks.
  const warrior = vmWith();
  assert.match(warrior.evaluate('NS.Chains.Line(1718)'), /^Leads to \|c[0-9a-fA-F]{8}\|Hitem:6975\|h\[Whirlwind Axe\]\|h\|r or 2 more · step 1 of 6$/);
  assert.deepEqual(warrior.json('NS.Chains.Facts(1718)'), { step: 1, of: 6, to: 'Whirlwind Axe', kind: 'reward', item: 6975, quality: 'rare', choice: 3, next: 1719 });
  // The First and the Last: a bow, a wand and a shield; a paladin can only take the shield.
  const paladin = vmWith('function UnitClass() return "Paladin", "PALADIN", 2 end');
  assert.match(paladin.evaluate('NS.Chains.Line(6182)'), /\|Hitem:16998\|h\[Sacred Protector\]\|h\|r · step 1 of 6$/);
  // Milli's Lexicon is the mage's only pick (the other is a shield).
  const mage = vmWith('function UnitClass() return "Mage", "MAGE", 8 end');
  assert.match(mage.evaluate('NS.Chains.Line(5527)'), /\|h\[[^\]]+\]\|h\|r · step 1 of 2$/);
  // The Matron Protectorate: plate and mail, which a priest can't wear: no line, no facts.
  const priest = vmWith('function UnitClass() return "Priest", "PRIEST", 5 end');
  assert.equal(priest.evaluate('NS.Chains.Line(5160)'), null);
  assert.equal(priest.evaluate('NS.Chains.Facts(5160)'), null);
  assert.match(warrior.evaluate('NS.Chains.Line(5160)'), /\|Hitem:12895\|h\[Breastplate of the Chromatic Flight\]\|h\|r · step 1 of 5$/, 'a warrior can wear the plate the chain gives first');
  // A lone pick is no choice for the AI either: the warlock's orb, with no "one of 1".
  const warlock = vmWith('function UnitClass() return "Warlock", "WARLOCK", 9 end');
  assert.deepEqual(warlock.json('NS.Chains.Facts(1799)'), { step: 1, of: 4, to: "Orb of Dar'Orahil", kind: 'reward', item: 15108, quality: 'rare', next: 4961 });
  assert.equal(warlock.evaluate('NS.Chains.Words(NS.Chains.Facts(1799))'), "step 1 of 4, Orb of Dar'Orahil (rare reward), next quest 4961");
});

test('a quest whose chain leads to nothing for this class or race has no line, though others who can take it have one', () => {
  const as = (cls, id, race = '"Human", "Human", 1') => vmWith(`function UnitClass() return "C", "C", ${id} end; function UnitRace() return ${race} end`);
  // Thunderfury is a one-handed sword: nothing for a priest, a shaman or a druid on the way to it.
  for (const [name, id, race] of [['priest', 5], ['shaman', 7, '"Orc", "Orc", 2'], ['druid', 11, '"Tauren", "Tauren", 6']]) {
    const vm = as(name, id, race);
    for (const quest of [7785, 7786, 7787]) assert.equal(vm.evaluate(`NS.Chains.Line(${quest})`), null, `${name} on ${quest}`);
    assert.equal(vm.evaluate('NS.Chains.Facts(7785)'), null);
  }
  assert.match(as('rogue', 4).evaluate('NS.Chains.Line(7785)'), /\[Thunderfury, Blessed Blade of the Windseeker\]\|h\|r · step 1 of 3$/);
  assert.equal(as('priest', 5).evaluate('NS.Chains.Line(5166)'), null, 'plate');
  assert.equal(as('mage', 8).evaluate('NS.Chains.Line(5167)'), null, 'mail');
  assert.equal(as('warrior', 1).evaluate('NS.Chains.Line(5063)'), null, 'a caster\'s cap');
  assert.equal(as('mage', 8).evaluate('NS.Chains.Line(5067)'), null, 'leather');
  // The Platinum Discs: the Horde's way on leads to Uldaman, the Alliance's to nothing.
  assert.equal(as('warrior', 1).evaluate('NS.Chains.Line(2278)'), null, 'a human');
  assert.equal(as('warrior', 1, '"Orc", "Orc", 2').evaluate('NS.Chains.Line(2278)'), 'Leads to Uldaman · step 1 of 2');
});

test('a breadcrumb: the errand that sends you to a chain leads where it leads, with no step', () => {
  // The Barrens Oases sends you to the chain into Wailing Caverns (a tauren warrior).
  const vm = vmWith('function UnitRace() return "Tauren", "Tauren", 6 end');
  assert.equal(vm.evaluate('NS.Chains.Line(886)'), 'Leads to Wailing Caverns');
  assert.deepEqual(vm.json('NS.Chains.Facts(886)'), { to: 'Wailing Caverns', kind: 'dungeon', next: 870 });
});

test('the offer page types its text in: the line hides with the page\'s parts, then shows or fades in with them', () => {
  const vm = vmWith();
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  vm.run('QuestInfo_HideAlphaDependentText(QuestDetailScrollChildFrame)');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').alpha, 0, 'hidden while the text types in');
  vm.run('QuestInfo_FadeInAlphaDependentText(QuestDetailScrollChildFrame, 0.4)');
  assert.equal(vm.bool('(function() for _, c in ipairs(QuestDetailScrollChildFrame.children) do if c.fade then return c.fade.playing end end end)()'), true, 'fades in over the page\'s own time');
  vm.run('QuestInfo_HideAlphaDependentText(QuestDetailScrollChildFrame); QuestInfo_ShowAlphaDependentText(QuestDetailScrollChildFrame)');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').alpha, 1, 'shown at once with instant quest text');
  assert.equal(vm.evaluate('NS.Chains.lastError'), null);
});

test('Quest Chains turned off and on again acts at once: the line goes and the description is back under the title, then it comes back', () => {
  const vm = vmWith();
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  const row = "STUB.byName and STUB.byName['Quest Chains']";
  // Settings' own setter, as the list's check box calls it.
  vm.run('for _, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == "Quest Chains" then QI.setter = sw[4] end end');
  vm.run('QI.setter(false)');
  void row;
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, false);
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'QuestInfoTitleHeader', y: -5 }, 'where the game put it');
  vm.run('QI.setter(true)');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, true);
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'line', y: -10 });
  // A page opened while it was off has no line yet: turning it on puts one there at once.
  vm.run('QI.setter(false); QI.quest = 1718');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').shown, false);
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'QuestInfoTitleHeader', y: -5 });
  vm.run('QI.setter(true)');
  const line = lineOn(vm, 'QuestDetailScrollChildFrame');
  assert.equal(line.shown, true);
  assert.match(line.text, /\[Whirlwind Axe\]/, 'the quest on the page now, not the last one with a line');
  assert.deepEqual(under(vm, 'QuestInfoDescriptionText'), { rel: 'line', y: -10 });
  // The reward page (no line there) keeps the title: the switch leaves it alone.
  vm.run('QI.setter(false)');
  show(vm, 'QUEST_TEMPLATE_REWARD', 'QuestRewardScrollChildFrame');
  vm.run('QI.setter(true)');
  assert.equal(lineOn(vm, 'QuestRewardScrollChildFrame'), null);
  assert.equal(vm.evaluate('NS.Chains.lastError'), null);
});

test('a line wider than the page goes in two, the step on a line of its own, so a wrap never splits it', () => {
  // Text metrics on (the renderer's): Examine the Vessel leads to the longest name, Thunderfury's.
  const vm = vmWith('STUB.metrics = true; QI.quest = 7785');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  const line = lineOn(vm, 'QuestDetailScrollChildFrame');
  assert.match(line.text, /^Leads to \|c[0-9a-fA-F]{8}\|Hitem:19019\|h\[Thunderfury, Blessed Blade of the Windseeker\]\|h\|r\nStep 1 of 3$/);
  assert.equal(vm.evaluate('NS.Chains.Line(7785)').endsWith(' · step 1 of 3'), true, 'one line where it fits');
  // The Defias Brotherhood fits the page on one line.
  vm.run('QI.quest = 65');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').text, 'Leads to The Deadmines · step 1 of 7');
  // No step, nothing to keep whole: the game wraps it.
  vm.run('QI.quest = 4024');
  show(vm, 'QUEST_TEMPLATE_DETAIL', 'QuestDetailScrollChildFrame');
  assert.equal(lineOn(vm, 'QuestDetailScrollChildFrame').text, 'Leads to Blackrock Depths');
  assert.equal(vm.evaluate('NS.Chains.lastError'), null);
});

test('saying less: a step with no count, and no step at all', () => {
  const vm = vmWith();
  // Dead Man's Plea, ten steps into Anthion's chain: the ways on to Stratholme differ in length.
  assert.equal(vm.evaluate('NS.Chains.Line(8945)'), 'Leads to Stratholme · step 10');
  // A Taste of Flame: a long way and a short way in, at different steps.
  assert.equal(vm.evaluate('NS.Chains.Line(4024)'), 'Leads to Blackrock Depths');
  // Divine Retribution starts the long way: counted along it.
  assert.equal(vm.evaluate('NS.Chains.Line(3441)'), 'Leads to Blackrock Depths · step 1 of 11');
});

// The state's quests and chains to start, for a level 16 human warrior in Westfall with The Defias
// Brotherhood's second step in the log.
const WESTFALL = `
STUB.log = { { id = 132, title = "The Defias Brotherhood", level = 18 }, { id = 748, title = "Poison Water", level = 5 } }
STUB.done = { [65] = true }
C_QuestLog = C_QuestLog or {}
C_QuestLog.GetNumQuestLogEntries = function() return #STUB.log, #STUB.log end
C_QuestLog.GetInfo = function(i) local q = STUB.log[i]; if q then return { title = q.title, questID = q.id, level = q.level } end end
C_QuestLog.IsOnQuest = function(id) for _, q in ipairs(STUB.log) do if q.id == id then return true end end return false end
C_QuestLog.IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end
C_QuestLog.GetQuestObjectives = function() return {} end
C_QuestLog.GetTitleForQuestID = function(id) return ({ [2398] = "The Lost Dwarves" })[id] end
C_QuestLog.RequestLoadQuestByID = function(id) QI.asked = (QI.asked or 0) + 1 end
function UnitLevel() return 16 end
function GetRealZoneText() return "Westfall" end
`;

test('the state: each quest\'s chain after its objectives, the chains to start near the level, and both dropped in their turn to fit', () => {
  const vm = vmWith(WESTFALL);
  vm.run('QI.areas = { [40] = "Westfall", [17] = "The Barrens" }');
  const g = vm.json('NS.Companion.Gather()');
  assert.deepEqual(g.quests[0].chain, { step: 2, of: 7, to: 'The Deadmines', kind: 'dungeon', next: 135 });
  assert.equal(g.quests[1].chain, undefined, 'Poison Water leads nowhere');
  const json = vm.evaluate('NS.Companion.Encode(NS.Companion.Gather(), {}, 1, 1)');
  const st = JSON.parse(json);
  assert.deepEqual(Object.keys(st.quests[0]), ['id', 'title', 'level', 'complete', 'obj', 'chain']);
  assert.equal(JSON.stringify(st.quests[0].chain), '{"step":2,"of":7,"to":"The Deadmines","kind":"dungeon","next":135}', 'keys in this order');
  const starts = st.chainStarts;
  assert.ok(Array.isArray(starts) && starts.length >= 1 && starts.length <= 3, JSON.stringify(starts));
  for (const s of starts) {
    assert.ok(s.level >= 11 && s.level <= 19, `${s.id} at level ${s.level}`);
    assert.deepEqual(Object.keys(s).filter(k => !['title', 'zone', 'item', 'quality', 'choice', 'next', 'of'].includes(k)), ['id', 'level', 'to', 'kind'], 'flat: the first step\'s own, then its chain\'s (no step: it\'s 1)');
    assert.notEqual(s.id, 65, 'done already');
  }
  const keys = Object.keys(st);
  assert.ok(keys.indexOf('chainStarts') === keys.indexOf('quests') + 1 || keys.indexOf('chainStarts') > keys.indexOf('quests'));
  // The drop order: the chains to start after the quest points, each quest's chain after its objectives.
  const order = vm.json('(function() local o = {}; for i = 1, 20 do local ok, v = pcall(function() return NS.Companion.DROP_ORDER and NS.Companion.DROP_ORDER[i] end); if ok and v then o[#o + 1] = v end end; return o end)()');
  void order;
  const dropped = JSON.parse(vm.evaluate('NS.Companion.Encode(NS.Companion.Gather(), { chainStarts = true, ["quests.chain"] = true }, 1, 1)'));
  assert.equal(dropped.chainStarts, undefined);
  assert.equal(dropped.quests[0].chain, undefined);
  assert.ok(dropped.omitted.includes('chainStarts') && dropped.omitted.includes('quests.chain'), JSON.stringify(dropped.omitted));
});

test('the chains to start: not done, not in the log, the level allows, the race and class can take it, and no exclusive stand-in', () => {
  const vm = vmWith(WESTFALL);
  const ids = () => vm.json('(function() local o = {}; for _, s in ipairs(NS.Chains.Starts(16, {}) or {}) do o[#o + 1] = s.id end; return o end)()') || [];
  const human = ids();
  assert.ok(human.length > 0);
  assert.ok(!human.includes(65), 'The Defias Brotherhood is done');
  vm.run('STUB.done = {}');
  assert.ok(ids().includes(65) || ids().length === 5, 'not done: it may start');
  const orc = vmWith(WESTFALL + 'function UnitRace() return "Orc", "Orc", 2 end');
  orc.run('STUB.done = {}');
  const horde = orc.json('(function() local o = {}; for _, s in ipairs(NS.Chains.Starts(16, {}) or {}) do o[#o + 1] = s.id end; return o end)()') || [];
  assert.ok(!horde.includes(65), 'an Alliance chain is never an orc\'s');
  // A title the client doesn't have yet is asked for, so the next state has it.
  assert.ok(vm.num('QI.asked or 0') >= 1);
});

test('Copy and Paste\'s game data: a line for the log\'s chains and one for those to start, in words', () => {
  const vm = vmWith(WESTFALL);
  vm.run('QI.areas = { [40] = "Westfall" }');
  const data = vm.evaluate('NS.Paste.GameData()');
  assert.match(data, /^Quest chains in the log \(quest id: step, where the chain leads, the next quest\): 132: step 2 of 7, The Deadmines \(dungeon\), next quest 135$/m);
  assert.match(data, /^Quest chains they can start near their level \(quest id, title, level, zone: step, where the chain leads, the next quest\): \d+/m);
  assert.doesNotMatch(data, /\?/, 'a title or zone the game hasn\'t named yet is left out, never "?"');
  assert.equal(vm.evaluate('NS.Chains.Words({ step = 2, of = 6, to = "Whirlwind Axe", kind = "reward", quality = "rare", choice = 3 })'), 'step 2 of 6, Whirlwind Axe (rare reward, one of 3 to pick from)');
  assert.equal(vm.evaluate('NS.Chains.Words({ to = "Blackrock Depths", kind = "dungeon" })'), 'Blackrock Depths (dungeon)');
});

test('a full log of long titles and objectives with 12 chains still fits one strip frame: the chains to start go after the quest points, each quest\'s chain after its objectives, and no quest goes', () => {
  // The worst-case log (40 quests, 60-byte titles, 5 objectives each), its first 12 quests real chain steps.
  const CHAINED = [65, 132, 135, 141, 142, 155, 166, 214, 2198, 2199, 2200, 2201];
  let k = 0;
  const log = worstLog('words').map(e => (e.header || k >= CHAINED.length || e.id === 1527 ? e : { ...e, id: CHAINED[k++] }));
  const BASE = `
function UnitName(unit) if unit == "player" then return "Tavi", "" end end
function GetRealmName() return "Testrealm" end
STUB.level, STUB.money, STUB.xp, STUB.xpMax = 20, 11800, 300, 1400
function UnitXP() return STUB.xp end
function UnitXPMax() return STUB.xpMax end
C_Map.GetBestMapForUnit = function() return 1436 end
STUB.inv, STUB.ilvl = {}, {}
function GetInventoryItemID(unit, slot) local i = STUB.inv[slot]; return i and i.id end
function GetInventoryItemLink(unit, slot) local i = STUB.inv[slot]; return i and i.link end
C_Item.GetDetailedItemLevelInfo = function(link) local id = tonumber(tostring(link):match("item:(%d+)")); return id and STUB.ilvl[id] end
function IsInInstance() return false end
function UnitLevel() return 20 end
function GetRealZoneText() return "Westfall" end
`;
  for (const caps of [['state', 'evt', 'z', 'ctx', 'qlog'], ['state', 'evt', 'qlog']]) {
    const vm = newVM({ extra: PAGES + BASE + QLOG_STUB + entriesLua(log) }).login();
    vm.run(`NS.R.bridge = { caps = { ${[...caps, 'usage'].map(c => `"${c}"`).join(', ')} }, usage = { autoOn = true } }; NS.R.nonce = "a3f1"`);
    vm.run(worstOthers('words'));
    const st = vm.json('NS.Companion.Build()');
    assert.equal(st.tooLarge ?? null, null, caps.join(','));
    const state = JSON.parse(st.json);
    assert.equal(state.quests.length, 40, 'every quest');
    const om = state.omitted;
    const at = name => om.indexOf(name);
    if (at('chainStarts') >= 0) assert.ok(at('chainStarts') > at('poi'), om.join(','));
    if (at('quests.chain') >= 0) assert.ok(at('quests.chain') > at('quests.obj') && (at('quests.level') < 0 || at('quests.chain') < at('quests.level')), om.join(','));
    if (caps.includes('z')) {
      vm.run('NS.Companion.QueueState()');
      const rec = parseRecord(vm.evaluate('NS.R.stateRec.wire')).record;
      assert.ok(rec.body.length <= 3100, `${rec.body.length} bytes of body`);
      const back = inflateBody(rec.body, { maxBody: STATE_BODY_MAX, maxText: STATE_JSON_MAX });
      assert.ok(validateState(back.text).ok);
      // With room, the chains go: the Defias Brotherhood's steps say where they lead.
      if (at('quests.chain') < 0) assert.deepEqual(state.quests.find(q => q.id === 65).chain, { step: 1, of: 7, to: 'The Deadmines', kind: 'dungeon', next: 132 });
    } else assert.ok(Buffer.byteLength(st.json) <= 3100, `${Buffer.byteLength(st.json)} bytes`);
  }
});

test('a /reload after the update that added Chains.lua runs without it: the state, Copy and Paste and Settings work, with no chains', () => {
  const vm = newVM({ extra: PAGES + WESTFALL, skip: ['Chains.lua'] }).login();
  const g = vm.json('NS.Companion.Gather()');
  assert.equal(g.quests[0].chain, undefined);
  assert.equal(g.chainStarts, undefined);
  assert.doesNotMatch(vm.evaluate('NS.Paste.GameData()'), /Quest chains/);
  vm.run('QuestInfo_Display(QUEST_TEMPLATE_DETAIL, QuestDetailScrollChildFrame)');
});

// ---------------------------------------------------------------------------
// The bridge: the data block carries the facts, sanitized, and cuts them in their turn

test('the bridge: chain facts pass the sanitizer, the chains to start are bounded, and the fit cuts them after the quest points', () => {
  const state = {
    v: 1, sid: 'a1b2c3d4e5f60718', seq: 3, t: 1,
    quests: [{ id: 132, title: 'The Defias Brotherhood', level: 18, complete: false, obj: [], chain: { step: 2, of: 7, to: 'The Deadmines', kind: 'dungeon', next: 135 } }],
    poi: [{ id: 132, map: 1436, x: 1, y: 2 }],
    chainStarts: Array.from({ length: 9 }, (_, i) => ({ id: 1000 + i, title: `Start ${i}`, level: 16, of: 3, to: 'The Stockade', kind: 'dungeon' })),
  };
  const clean = sanitizeState(state);
  assert.deepEqual(clean.quests[0].chain, state.quests[0].chain);
  assert.equal(clean.chainStarts.length, 3, 'no more than the addon sends');
  const big = { source: 'game', game: { state: { ...clean, quests: [{ ...clean.quests[0], obj: [{ text: 'x'.repeat(60), have: 1, need: 2 }] }] } } };
  const tight = fitData(structuredClone(big), JSON.stringify(big).length - 40);
  assert.deepEqual(tight.omitted.slice(0, 2), ['state.quests.obj.text', 'state.poi'].slice(0, tight.omitted.length >= 2 ? 2 : 1));
  const tighter = fitData(structuredClone(big), 400);
  const cut = tighter.omitted;
  assert.ok(cut.indexOf('state.chainStarts') > cut.indexOf('state.poi'), cut.join(','));
  if (cut.includes('state.quests.chain')) assert.ok(cut.indexOf('state.quests.chain') > cut.indexOf('state.quests.obj'), cut.join(','));
  const req = buildRequest({ pack: 'pack', game: { state: clean }, userText: 'is this quest worth it?', nonce: 'abcd' });
  const block = readDataBlock(req.messages.at(-1).content);
  assert.deepEqual(block.data.game.state.quests[0].chain, state.quests[0].chain);
  // The note that says what they mean comes after the quest log's count, and only with chains.
  assert.deepEqual(block.data.game.notes, ['Quest log: 1 quest, every one listed.', CHAIN_NOTE]);
  const none = buildRequest({ pack: 'pack', game: { state: { ...clean, chainStarts: [], quests: [{ id: 748, title: 'Poison Water', complete: false }] } }, userText: 'x', nonce: 'abcd' });
  assert.deepEqual(readDataBlock(none.messages.at(-1).content).data.game.notes, ['Quest log: 1 quest, every one listed.']);
  assert.ok(CHAIN_NOTE.length <= 480, `${CHAIN_NOTE.length} characters`);
  // The companion switch off: the quest log alone, so no chains and no note.
  const listOnly = buildRequest({ pack: 'pack', game: { state: listOnlyState(clean) }, userText: 'x', nonce: 'abcd' });
  const lo = readDataBlock(listOnly.messages.at(-1).content).data.game;
  assert.equal(lo.state.quests[0].chain, undefined);
  assert.equal(lo.state.chainStarts, undefined);
  assert.deepEqual(lo.notes, ['Quest log: 1 quest, every one listed.']);
});
