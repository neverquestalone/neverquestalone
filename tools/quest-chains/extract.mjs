#!/usr/bin/env node
// tools/quest-chains/extract.mjs: reads the emulator's quest data and writes the
// facts (tools/quest-chains/cmangos.json) that generate.mjs turns into the quest
// chains the addon knows (Chains.lua). Run it by hand when a source moves; the
// tests run only generate.mjs, on the committed facts. README.md says where each
// input comes from.
//
//   node tools/quest-chains/extract.mjs \
//     --db ClassicDB_1_12_1_z2815.sql.gz --maps Map.csv --areas AreaTable.csv --factions FactionTemplate.csv \
//     --skills SkillLine.csv --abilities SkillLineAbility.csv --equips SpellEquippedItems.csv \
//     --combos CharBaseInfo.csv \
//     --pinDb "<file@commit>" --pinMaps "<table build>" --pinAreas "<table build>" --pinFactions "<table build>" \
//     --pinSkills "<tables build>" --pinCombos "<table build>"
//
// The facts, per quest that's linked to another one (a quest it needs, one
// that needs it, one in its exclusive group, the one offered after it, or the
// one it's a breadcrumb for), and per quest those name, in each set of linked
// quests that could end in a payoff (one of them is a dungeon or raid quest,
// rewards a rare or better item, or has its objectives on an instance's map):
//   title, type (81 dungeon, 62 raid, 1 elite ...), zone (where the quest log
//   files it: an area id, or a negative sort), level, min (level to take it),
//   races, classes (the masks it needs), takers (the races its quest givers
//   offer it to: a creature that would attack a race doesn't, by
//   FactionTemplate as tools/qol-quests reads it; an object or an item offers
//   it to anyone; left out when that's every race), prev, next, ex, nic, crumb (the
//   template's own links), disabled (Method 1), noStarter (no creature, object
//   or item starts it), repeatable, event (a world event's quest), cond and
//   skill (other requirements, for review), rewards (the rare or better items
//   it gives: [item, 1 for a choice]), and where (the maps its objectives are
//   found on: the creatures and objects it names, the creatures credited for
//   them, and those that drop or hold the items it asks for), with unknown
//   (objectives found nowhere) when there are any.
// Beside them: items (each rare or better reward's name, quality, classes, and
// its item class and subclass), proficiencies (which classes can equip each
// weapon and armor subclass: a weapon or armor skill's ability that equips
// one subclass, and the classes it names, from wago.tools), combos (the
// classes each race can be, from wago.tools' CharBaseInfo: race bit -> class
// mask), instances (each instance map's name, kind and areas) and zones (the
// name and map of each area a quest is filed under).

import fs from "node:fs";
import path from "node:path";
import { readDump, tables, csv } from "./dump.mjs";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const need of ["db", "maps", "areas", "factions", "skills", "abilities", "equips", "combos"]) {
	if (!args[need]) {
		console.error(`extract.mjs: --${need} is required (see the header)`);
		process.exit(2);
	}
}
const OUT = args.out || path.join(path.dirname(new URL(import.meta.url).pathname), "cmangos.json");
const N = (v) => Number(v) || 0;

const sql = readDump(args.db);
const db = tables(sql);
const QUEST_COLS = ["entry", "Method", "ZoneOrSort", "MinLevel", "QuestLevel", "Type", "RequiredClasses", "RequiredRaces", "RequiredSkill",
	"RequiredCondition", "SpecialFlags", "PrevQuestId", "NextQuestId", "ExclusiveGroup", "BreadcrumbForQuestId", "NextQuestInChain", "SrcItemId", "Title",
	...[1, 2, 3, 4].flatMap((i) => [`ReqItemId${i}`, `ReqCreatureOrGOId${i}`]),
	...[1, 2, 3, 4, 5, 6].map((i) => `RewChoiceItemId${i}`), ...[1, 2, 3, 4].map((i) => `RewItemId${i}`)];
const quests = db.rows("quest_template", QUEST_COLS);
const byId = new Map(quests.map((q) => [N(q.entry), q]));
const items = new Map(db.rows("item_template", ["entry", "name", "Quality", "AllowableClass", "startquest", "class", "subclass"]).map((r) => [N(r.entry), r]));
const versionColumn = db.columns("db_version")[0];
const version = db.rows("db_version", [versionColumn])[0]?.[versionColumn] || "";

// Who starts each quest: a creature, an object, or an item that starts it.
const started = new Set();
for (const t of ["creature_questrelation", "gameobject_questrelation"]) for (const r of db.rows(t, ["id", "quest"])) started.add(N(r.quest));
for (const it of items.values()) if (N(it.startquest)) started.add(N(it.startquest));

// --- who a quest giver offers a quest to (FactionTemplate; the client's IsHostileTo, as tools/qol-quests) --
const templates = new Map();
for (const r of csv(args.factions)) {
	const n = (k) => N(r[k]);
	templates.set(n("ID"), {
		faction: n("Faction"), ours: n("FactionGroup"), enemies: n("EnemyGroup"),
		enemyList: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => n(`Enemies_${i}`)).filter(Boolean),
		friendList: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => n(`Friend_${i}`)).filter(Boolean),
	});
}
function hostile(a, b) {
	if (a.enemyList.includes(b.faction)) return true;
	if (a.friendList.includes(b.faction)) return false;
	return (a.enemies & b.ours) !== 0;
}
// The playable races by quest_template.RequiredRaces bit, and their own templates.
const RACES = [[1, 1], [2, 2], [4, 3], [8, 4], [16, 5], [32, 6], [64, 115], [128, 116]].map(([bit, t]) => ({ bit, t: templates.get(t) }));
const creatureFaction = new Map(db.rows("creature_template", ["Entry", "Faction"]).map((c) => [N(c.Entry), templates.get(N(c.Faction))]));
const takers = new Map(); // quest -> race mask its givers offer it to
const offer = (quest, mask) => takers.set(quest, (takers.get(quest) || 0) | mask);
for (const r of db.rows("creature_questrelation", ["id", "quest"])) {
	const t = creatureFaction.get(N(r.id));
	offer(N(r.quest), t ? RACES.filter((x) => !hostile(t, x.t)).reduce((m, x) => m | x.bit, 0) : 255);
}
for (const r of db.rows("gameobject_questrelation", ["id", "quest"])) offer(N(r.quest), 255);
for (const it of items.values()) if (N(it.startquest)) offer(N(it.startquest), 255);
// World events' quests (holidays, the Darkmoon Faire, ...).
const eventOf = new Map();
for (const r of db.rows("game_event_quest", ["quest", "event"])) if (!eventOf.has(N(r.quest))) eventOf.set(N(r.quest), N(r.event));

// --- where objectives are found ------------------------------------------------
const spawnMaps = (table) => {
	const m = new Map();
	for (const r of db.rows(table, ["id", "map"])) {
		const k = N(r.id);
		if (!m.has(k)) m.set(k, new Set());
		m.get(k).add(N(r.map));
	}
	return m;
};
const creatureMaps = spawnMaps("creature");
const objectMaps = spawnMaps("gameobject");
const credited = new Map(); // a creature id -> the creatures whose kill counts as it (KillCredit1/2)
const byLootId = new Map(); // creature_loot_template entry -> creatures that use it
for (const c of db.rows("creature_template", ["Entry", "LootId", "KillCredit1", "KillCredit2"])) {
	for (const k of [N(c.KillCredit1), N(c.KillCredit2)]) {
		if (!k) continue;
		if (!credited.has(k)) credited.set(k, []);
		credited.get(k).push(N(c.Entry));
	}
	if (N(c.LootId)) {
		if (!byLootId.has(N(c.LootId))) byLootId.set(N(c.LootId), []);
		byLootId.get(N(c.LootId)).push(N(c.Entry));
	}
}
const byObjectLoot = new Map(); // gameobject_loot_template entry -> chests (type 3) and fishing holes (25) that use it
for (const g of db.rows("gameobject_template", ["entry", "type", "data1"])) {
	if (!["3", "25"].includes(g.type) || !N(g.data1)) continue;
	if (!byObjectLoot.has(N(g.data1))) byObjectLoot.set(N(g.data1), []);
	byObjectLoot.get(N(g.data1)).push(N(g.entry));
}
// item -> the loot tables it's in, references followed back to the creature and object tables.
const LOOT = ["entry", "item", "mincountOrRef"];
const dropsIn = new Map();
const refsFrom = new Map(); // reference entry -> the tables that name it
const addDrop = (item, src) => { if (!dropsIn.has(item)) dropsIn.set(item, []); dropsIn.get(item).push(src); };
for (const [kind, table] of [["creature", "creature_loot_template"], ["object", "gameobject_loot_template"], ["reference", "reference_loot_template"]]) {
	for (const r of db.rows(table, LOOT)) {
		const ref = -N(r.mincountOrRef);
		if (ref > 0) {
			if (!refsFrom.has(ref)) refsFrom.set(ref, []);
			refsFrom.get(ref).push({ kind, entry: N(r.entry) });
		} else addDrop(N(r.item), { kind, entry: N(r.entry) });
	}
}
function owners(src, seen = new Set()) {
	if (src.kind !== "reference") return [src];
	if (seen.has(src.entry)) return [];
	seen.add(src.entry);
	return (refsFrom.get(src.entry) || []).flatMap((s) => owners(s, seen));
}
function itemMaps(item) {
	const maps = new Set();
	for (const src of (dropsIn.get(item) || []).flatMap((s) => owners(s))) {
		const holders = src.kind === "creature" ? byLootId.get(src.entry) : byObjectLoot.get(src.entry);
		const spawns = src.kind === "creature" ? creatureMaps : objectMaps;
		for (const h of holders || []) for (const m of spawns.get(h) || []) maps.add(m);
	}
	return maps;
}
// The maps where each of a quest's objectives can be done; unknown counts those found nowhere.
function where(q) {
	const found = [];
	let unknown = 0;
	for (const i of [1, 2, 3, 4]) {
		const id = N(q[`ReqCreatureOrGOId${i}`]);
		const item = N(q[`ReqItemId${i}`]);
		const sets = [];
		if (id > 0) {
			const s = new Set(creatureMaps.get(id) || []);
			for (const c of credited.get(id) || []) for (const m of creatureMaps.get(c) || []) s.add(m);
			sets.push(s);
		} else if (id < 0) sets.push(new Set(objectMaps.get(-id) || []));
		if (item && item !== N(q.SrcItemId)) sets.push(itemMaps(item));
		for (const s of sets) {
			if (s.size) found.push(...s);
			else unknown++;
		}
	}
	return { maps: [...new Set(found)].sort((a, b) => a - b), unknown };
}

// --- which quests ---------------------------------------------------------------
const LINKS = ["PrevQuestId", "NextQuestId", "NextQuestInChain", "BreadcrumbForQuestId"];
const linked = new Set();
for (const q of quests) {
	const own = LINKS.some((k) => N(q[k])) || N(q.ExclusiveGroup);
	if (own) linked.add(N(q.entry));
	for (const k of LINKS) if (N(q[k]) && byId.has(Math.abs(N(q[k])))) linked.add(Math.abs(N(q[k])));
}

// --- the facts ------------------------------------------------------------------
const out = {};
const rewardItems = new Map();
for (const id of [...linked].sort((a, b) => a - b)) {
	const q = byId.get(id);
	const f = { title: q.Title };
	const put = (k, v) => { if (v) f[k] = v; };
	put("type", N(q.Type));
	f.zone = N(q.ZoneOrSort);
	f.level = N(q.QuestLevel);
	f.min = N(q.MinLevel);
	put("races", N(q.RequiredRaces));
	put("classes", N(q.RequiredClasses));
	if (takers.has(id) && takers.get(id) !== 255) f.takers = takers.get(id);
	put("prev", N(q.PrevQuestId));
	put("next", N(q.NextQuestId));
	put("ex", N(q.ExclusiveGroup));
	put("nic", N(q.NextQuestInChain));
	put("crumb", N(q.BreadcrumbForQuestId));
	if (N(q.Method) === 1) f.disabled = true;
	if (!started.has(id)) f.noStarter = true;
	if (N(q.SpecialFlags) & 1) f.repeatable = true;
	put("event", eventOf.get(id) || 0);
	put("cond", N(q.RequiredCondition));
	put("skill", N(q.RequiredSkill));
	const rewards = [];
	for (const [k, choice] of [...[1, 2, 3, 4].map((i) => [`RewItemId${i}`, 0]), ...[1, 2, 3, 4, 5, 6].map((i) => [`RewChoiceItemId${i}`, 1])]) {
		const it = items.get(N(q[k]));
		if (!it || N(it.Quality) < 3) continue;
		rewards.push([N(it.entry), choice]);
		rewardItems.set(N(it.entry), it);
	}
	if (rewards.length) f.rewards = rewards;
	const w = where(q);
	if (w.maps.length) f.where = w.maps;
	put("unknown", w.unknown);
	out[id] = f;
}
const instanceMaps = new Set(db.rows("instance_template", ["map"]).map((r) => N(r.map)));

// Only the chains that could end in a payoff: a set of quests linked to each
// other (any of the links above) is kept when one of them is a dungeon or raid
// quest, rewards a rare or better item, or has its objectives on an instance's
// map. generate.mjs decides which really are; no other chain can have one.
const root = new Map([...Object.keys(out)].map((id) => [Number(id), Number(id)]));
const find = (x) => { while (root.get(x) !== x) { root.set(x, root.get(root.get(x))); x = root.get(x); } return x; };
const join = (a, b) => { if (root.has(a) && root.has(b)) root.set(find(a), find(b)); };
const firstOfGroup = new Map();
for (const [id, f] of Object.entries(out)) {
	for (const k of ["prev", "next", "nic", "crumb"]) if (f[k]) join(Number(id), Math.abs(f[k]));
	if (f.ex) { if (firstOfGroup.has(f.ex)) join(Number(id), firstOfGroup.get(f.ex)); else firstOfGroup.set(f.ex, Number(id)); }
}
const mayPay = (f) => f.type === 81 || f.type === 62 || !!f.rewards || (f.where || []).some((m) => instanceMaps.has(m));
const paying = new Set(Object.entries(out).filter(([, f]) => mayPay(f)).map(([id]) => find(Number(id))));
for (const id of Object.keys(out)) {
	if (!paying.has(find(Number(id)))) delete out[id];
	else for (const [item] of out[id].rewards || []) rewardItems.get(item).kept = true;
}
for (const [item, it] of rewardItems) if (!it.kept) rewardItems.delete(item);
const itemFacts = {};
for (const id of [...rewardItems.keys()].sort((a, b) => a - b)) {
	const it = rewardItems.get(id);
	itemFacts[id] = { name: it.name, quality: N(it.Quality), class: N(it.class), subclass: N(it.subclass) };
	if (N(it.AllowableClass) > 0) itemFacts[id].classes = N(it.AllowableClass);
}

// --- who can equip what (wago.tools: the weapon and armor skills' proficiencies) ----------
// A weapon (SkillLine category 6) or armor (8) skill's ability learned with it (AcquireMethod 2) that
// equips exactly one item subclass, and the classes it names (its ClassMask; 0, as Unarmed's and
// Defense's, names none): item class -> subclass -> class mask.
const skillCategory = new Map(csv(args.skills).map((r) => [N(r.ID), N(r.CategoryID)]));
const equips = new Map(csv(args.equips).map((r) => [N(r.SpellID), r]));
const proficiencies = {};
for (const a of csv(args.abilities)) {
	if (![6, 8].includes(skillCategory.get(N(a.SkillLine))) || N(a.AcquireMethod) !== 2 || !N(a.ClassMask)) continue;
	const e = equips.get(N(a.Spell));
	const mask = e ? N(e.EquippedItemSubclass) : 0;
	if (!e || N(e.EquippedItemClass) < 0 || !mask || (mask & (mask - 1)) !== 0) continue;
	const sub = Math.log2(mask);
	const byClass = (proficiencies[N(e.EquippedItemClass)] ||= {});
	byClass[sub] = (byClass[sub] || 0) | N(a.ClassMask);
}

// --- the races and classes the game pairs (wago.tools CharBaseInfo) ----------------
// race bit -> class mask, the bits the templates' masks use (RaceID and ClassID, 1-based).
const combos = {};
for (const r of csv(args.combos)) {
	const race = 2 ** (N(r.RaceID) - 1), cls = 2 ** (N(r.ClassID) - 1);
	if (N(r.RaceID) > 0 && N(r.ClassID) > 0) combos[race] = (combos[race] || 0) | cls;
}

// --- instances and areas (wago.tools) ---------------------------------------------
const areas = csv(args.areas);
const instances = {};
for (const m of csv(args.maps)) {
	if (!instanceMaps.has(N(m.ID))) continue;
	const inside = {};
	for (const a of areas) if (N(a.ContinentID) === N(m.ID)) inside[N(a.ID)] = a.AreaName_lang;
	instances[N(m.ID)] = { name: m.MapName_lang, kind: N(m.InstanceType), area: N(m.AreaTableID), inside };
}
const areaById = new Map(areas.map((a) => [N(a.ID), a]));
const zones = {};
for (const z of [...new Set(Object.values(out).map((f) => f.zone).filter((z) => z > 0))].sort((a, b) => a - b)) {
	const a = areaById.get(z);
	if (a) zones[z] = { name: a.AreaName_lang, map: N(a.ContinentID) };
}

const doc = {
	about: "Facts from the cmangos classic data and wago.tools, written by tools/quest-chains/extract.mjs; generate.mjs turns them into Chains.lua's quest chains. Don't edit by hand: re-run extract.mjs.",
	sources: {
		db: args.pinDb || path.basename(args.db),
		dbVersion: version,
		maps: args.pinMaps || path.basename(args.maps),
		areas: args.pinAreas || path.basename(args.areas),
		factions: args.pinFactions || path.basename(args.factions),
		skills: args.pinSkills || path.basename(args.skills),
		combos: args.pinCombos || path.basename(args.combos),
	},
};
// One quest, item, instance or zone a line, so a refresh reads as a short diff.
const block = (o) => Object.entries(o).map(([k, v]) => `\t\t"${k}": ${JSON.stringify(v)}`).join(",\n");
fs.writeFileSync(OUT, [
	"{",
	`\t"about": ${JSON.stringify(doc.about)},`,
	`\t"sources": ${JSON.stringify(doc.sources)},`,
	`\t"instances": {\n${block(instances)}\n\t},`,
	`\t"zones": {\n${block(zones)}\n\t},`,
	`\t"proficiencies": {\n${block(proficiencies)}\n\t},`,
	`\t"combos": ${JSON.stringify(combos)},`,
	`\t"items": {\n${block(itemFacts)}\n\t},`,
	`\t"quests": {\n${block(out)}\n\t}`,
	"}",
	"",
].join("\n"));
console.log(`extract.mjs: ${Object.keys(out).length} quests, ${Object.keys(itemFacts).length} items, ${Object.keys(instances).length} instances, ${Object.keys(zones).length} zones -> ${OUT}`);
