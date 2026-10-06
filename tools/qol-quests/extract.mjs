#!/usr/bin/env node
// tools/qol-quests/extract.mjs: reads the emulator's quest data and writes the
// facts (tools/qol-quests/cmangos.json) that generate.mjs turns into QoL.lua's
// STARTS and HANDIN lists. Run it by hand when a source moves; the tests run
// only generate.mjs, on the committed facts. README.md says where each input
// comes from.
//
//   node tools/qol-quests/extract.mjs \
//     --db ClassicDB_1_12_1_z2815.sql.gz \
//     --scripts <mangos-classic>/src/game/AI/ScriptDevAI/scripts \
//     --factions FactionTemplate.csv --spells SpellEffect.csv \
//     --pinDb "<file@commit>" --pinScripts "<repo@commit>" --pinFactions "<table@build>" \
//     --pinSpells "<table@build>"
//
// Per quest it keeps only what matters to Auto Accept and Auto Turn In:
//   accept   the start script's effects (relays followed), the spell the game
//            casts on accepting (SrcSpell) and C++ accept hooks
//   handin   the end script's effects (relays followed), the spell the game
//            casts on the reward (RewSpellCast) and C++ rewarded hooks
//   limit    quest_template.LimitTime, in seconds
// An effect is one of: summon (the creature, and whether it's hostile to a
// player who can do the quest), attack, faction (a creature turning hostile),
// taxi, teleport, spawngroup, path (a creature walking a path) and cast (a
// spell; `teleports` when it, or a spell it triggers, moves the target, by
// SpellEffect's effect types; reviewed.json judges the rest: most are a
// salute or a glow). A spell's creature ids aren't used: the classic client's
// table names the wrong creature for some summons.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
for (const need of ["db", "scripts", "factions", "spells"]) {
	if (!args[need]) {
		console.error(`extract.mjs: --${need} is required (see the header)`);
		process.exit(2);
	}
}
const OUT = args.out || path.join(path.dirname(new URL(import.meta.url).pathname), "cmangos.json");

// --- the SQL dump -----------------------------------------------------------
const raw = fs.readFileSync(args.db);
const sql = (args.db.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8");

function columns(table) {
	const m = sql.match(new RegExp("CREATE TABLE `" + table + "` \\(([\\s\\S]*?)\\n\\)"));
	if (!m) throw new Error(`no table ${table}`);
	return [...m[1].matchAll(/^\s*`(\w+)`/gm)].map((c) => c[1]);
}

// One INSERT's tuples, as arrays of strings (null for NULL).
function tuples(body) {
	const out = [];
	let i = 0;
	while (i < body.length) {
		if (body[i] !== "(") { i++; continue; }
		i++;
		const row = [];
		for (;;) {
			if (body[i] === "'") {
				let s = "";
				i++;
				for (;;) {
					const ch = body[i];
					if (ch === "\\") { s += body[i + 1]; i += 2; continue; }
					if (ch === "'") {
						if (body[i + 1] === "'") { s += "'"; i += 2; continue; }
						i++;
						break;
					}
					s += ch;
					i++;
				}
				row.push(s);
			} else {
				let j = i;
				while (body[j] !== "," && body[j] !== ")") j++;
				const v = body.slice(i, j).trim();
				row.push(v === "NULL" ? null : v);
				i = j;
			}
			if (body[i] === ",") { i++; continue; }
			if (body[i] === ")") { i++; break; }
			throw new Error(`bad tuple near ${body.slice(i - 20, i + 20)}`);
		}
		out.push(row);
	}
	return out;
}

function rows(table, keep) {
	const cols = columns(table);
	const idx = keep.map((k) => {
		const n = cols.indexOf(k);
		if (n < 0) throw new Error(`${table} has no ${k}`);
		return n;
	});
	const out = [];
	const re = new RegExp("INSERT INTO `" + table + "` VALUES (.*?);\\n", "gs");
	for (const m of sql.matchAll(re)) {
		for (const t of tuples(m[1])) {
			const r = {};
			keep.forEach((k, n) => { r[k] = t[idx[n]]; });
			out.push(r);
		}
	}
	return out;
}

const SCRIPT_COLS = ["id", "command", "datalong", "datalong2", "dataint", "dataint2"];
const quests = rows("quest_template", ["entry", "Title", "StartScript", "CompleteScript", "LimitTime", "RequiredRaces", "SrcSpell", "RewSpellCast"]);
const scripts = {
	start: rows("dbscripts_on_quest_start", SCRIPT_COLS),
	end: rows("dbscripts_on_quest_end", SCRIPT_COLS),
	relay: rows("dbscripts_on_relay", SCRIPT_COLS),
};
const randoms = rows("dbscript_random_templates", ["id", "type", "target_id"]);
const creatures = new Map(rows("creature_template", ["Entry", "Name", "Faction", "ScriptName"]).map((c) => [c.Entry, c]));
const starters = rows("creature_questrelation", ["id", "quest"]);
const enders = rows("creature_involvedrelation", ["id", "quest"]);
const versionColumn = columns("db_version")[0];
const version = rows("db_version", [versionColumn])[0]?.[versionColumn] || "";

function csv(file) {
	const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
	const head = lines.shift().split(",");
	return lines.map((l) => {
		const v = [];
		let cur = "";
		let quoted = false;
		for (let i = 0; i < l.length; i++) {
			const ch = l[i];
			if (quoted) {
				if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
			} else if (ch === '"') quoted = true;
			else if (ch === ",") { v.push(cur); cur = ""; } else cur += ch;
		}
		v.push(cur);
		return Object.fromEntries(head.map((h, n) => [h, v[n]]));
	});
}

// --- who's hostile to whom (FactionTemplate; the client's IsHostileTo) --------
const templates = new Map();
for (const r of csv(args.factions)) {
	const n = (k) => Number(r[k]);
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
// The playable races, by quest_template.RequiredRaces bit, and their templates.
const RACES = [[1, 1], [2, 2], [4, 3], [8, 4], [16, 5], [32, 6], [64, 115], [128, 116]].map(([bit, t]) => ({ bit, t: templates.get(t) }));

// Who can do a quest: the races it allows, less those its quest giver (or,
// for a hand-in, whoever takes it) would attack.
// If that leaves no one (an NPC unknown to the table), every allowed race.
function players(q, relation) {
	const mask = Number(q.RequiredRaces) || 255;
	const npcs = relation.filter((r) => r.quest === q.entry).map((r) => templates.get(Number((creatures.get(r.id) || {}).Faction))).filter(Boolean);
	const allowed = RACES.filter((r) => mask & r.bit);
	const who = allowed.filter((r) => !npcs.some((npc) => hostile(npc, r.t)));
	return (who.length ? who : allowed).map((r) => r.t);
}
// A creature of this faction attacks one of them: true, false, or null when
// the faction is unknown.
function hostileTo(templateId, who) {
	const t = templates.get(Number(templateId));
	if (!t) return null;
	return who.some((p) => hostile(t, p));
}

// --- spells that move you (SpellEffect's effect types) --------------------------
const TELEPORT = new Set([5, 43, 252]); // TELEPORT_UNITS, TELEPORT_UNITS_FACE_CASTER, …_WITH_VISUAL_LOADING_SCREEN
const TRIGGERS = new Set([64, 140, 142]); // TRIGGER_SPELL, FORCE_CAST, TRIGGER_SPELL_WITH_VALUE
const PERIODIC_TRIGGER = 23; // an aura that casts EffectTriggerSpell
const spellEffects = new Map();
for (const e of csv(args.spells)) {
	if (!spellEffects.has(e.SpellID)) spellEffects.set(e.SpellID, []);
	spellEffects.get(e.SpellID).push(e);
}
function teleports(spell, seen = new Set()) {
	if (seen.has(spell) || seen.size > 8) return false;
	seen.add(spell);
	return (spellEffects.get(String(spell)) || []).some((e) => {
		const effect = Number(e.Effect);
		if (TELEPORT.has(effect)) return true;
		const next = Number(e.EffectTriggerSpell);
		const triggers = TRIGGERS.has(effect) || (effect === 6 && Number(e.EffectAura) === PERIODIC_TRIGGER);
		return triggers && next > 0 && teleports(next, seen);
	});
}
function cast(spell) {
	return teleports(Number(spell)) ? { do: "cast", spell: Number(spell), teleports: true } : { do: "cast", spell: Number(spell) };
}

// --- the scripts, relays followed --------------------------------------------
const byId = { start: new Map(), end: new Map(), relay: new Map() };
for (const [kind, list] of Object.entries(scripts)) {
	for (const r of list) {
		if (!byId[kind].has(r.id)) byId[kind].set(r.id, []);
		byId[kind].get(r.id).push(r);
	}
}
const randomById = new Map();
for (const r of randoms) {
	if (!randomById.has(r.id)) randomById.set(r.id, []);
	randomById.get(r.id).push(r);
}

function summon(entry, faction, who) {
	const cr = creatures.get(String(entry)) || {};
	return { do: "summon", entry: Number(entry), name: cr.Name || "?", hostile: hostileTo(Number(faction) || Number(cr.Faction), who) };
}

function effects(kind, id, who, seen = new Set()) {
	const key = `${kind}:${id}`;
	if (seen.has(key)) return [];
	seen.add(key);
	const out = [];
	for (const r of byId[kind].get(id) || []) {
		const c = Number(r.command);
		if (c === 10) {
			out.push(summon(r.datalong, r.dataint2, who));
		} else if (c === 26) {
			out.push({ do: "attack" });
		} else if (c === 22 && Number(r.datalong) > 0) {
			out.push({ do: "faction", faction: Number(r.datalong), hostile: hostileTo(r.datalong, who) });
		} else if (c === 30) {
			out.push({ do: "taxi", path: Number(r.datalong) });
		} else if (c === 6) {
			out.push({ do: "teleport" });
		} else if (c === 51 || c === 58) {
			out.push({ do: "spawngroup", id: Number(r.datalong) });
		} else if (c === 20 && (r.datalong === "2" || r.datalong === "3")) {
			out.push({ do: "path" });
		} else if (c === 15) {
			out.push(cast(r.datalong));
		} else if (c === 45) {
			const relays = [];
			if (Number(r.datalong) > 0) relays.push(r.datalong);
			for (const t of randomById.get(r.datalong2) || []) relays.push(t.target_id);
			for (const rid of relays) out.push(...effects("relay", rid, who, seen));
		}
	}
	return out;
}

// --- the C++ hooks -------------------------------------------------------------
function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? walk(p) : e.name.endsWith(".cpp") ? [p] : [];
	});
}
const byScriptName = new Map();
for (const c of creatures.values()) {
	if (!c.ScriptName) continue;
	if (!byScriptName.has(c.ScriptName)) byScriptName.set(c.ScriptName, []);
	byScriptName.get(c.ScriptName).push(c.Entry);
}
const questsOf = (relation, entries) => relation.filter((r) => entries.includes(r.id)).map((r) => Number(r.quest));
// What a hook's body does, for generate.mjs's rules: the calls that start a
// fight, an escort or an event, and the AI events it sends.
const SIGNALS = /\b(AttackStart|SummonCreature|SetFactionTemporary|Start|StartEscort|DoStartEscort|StartRiggerEscort|StartFollow|StartEvent|BeginEvent|DoStart\w*|SetData|SendAIEvent|CastSpell|DoCastSpellIfCan)\s*\(|\b(AI_EVENT_\w+)/g;

const hooks = [];
const root = path.resolve(args.scripts);
for (const file of walk(root).sort()) {
	const src = fs.readFileSync(file, "utf8");
	const rel = path.relative(root, file).split(path.sep).join("/");
	// Quest ids by name, from the file and the headers beside it.
	const consts = new Map();
	const headers = fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".h")).map((f) => fs.readFileSync(path.join(path.dirname(file), f), "utf8"));
	for (const text of [...headers, src]) {
		for (const m of text.matchAll(/\b(QUEST_[A-Z0-9_]+)\s*=\s*(\d+)/g)) consts.set(m[1], Number(m[2]));
	}
	const value = (tok) => (/^\d+$/.test(tok) ? Number(tok) : consts.get(tok));
	const registered = [];
	for (const block of src.matchAll(/\w+->Name\s*=\s*"(\w+)";([\s\S]*?)RegisterSelf\(/g)) {
		for (const h of block[2].matchAll(/p(QuestAcceptNPC|QuestAcceptGO|QuestRewardedNPC|QuestRewardedGO)\s*=\s*&(\w+)/g)) {
			registered.push({ script: block[1], field: h[1], fn: h[2] });
		}
	}
	for (const reg of registered) {
		const def = src.match(new RegExp("bool\\s+" + reg.fn + "\\s*\\([^)]*\\)\\s*\\{"));
		if (!def) continue;
		let i = def.index + def[0].length;
		let depth = 1;
		while (depth && i < src.length) {
			if (src[i] === "{") depth++;
			else if (src[i] === "}") depth--;
			i++;
		}
		const body = src.slice(def.index + def[0].length, i);
		const line = src.slice(0, def.index).split("\n").length;
		const ids = new Set();
		for (const m of body.matchAll(/GetQuestId\(\)\s*==\s*(\w+)/g)) if (value(m[1])) ids.add(value(m[1]));
		for (const m of body.matchAll(/case\s+(\w+)\s*:/g)) if (value(m[1])) ids.add(value(m[1]));
		const side = reg.field.startsWith("QuestAccept") ? "accept" : "handin";
		// A hook that checks no quest applies to every quest its NPC starts or ends.
		const scoped = ids.size > 0;
		if (!scoped && reg.field.endsWith("NPC")) {
			const entries = byScriptName.get(reg.script) || [];
			for (const q of questsOf(side === "accept" ? starters : enders, entries)) ids.add(q);
		}
		const signals = [...new Set([...body.matchAll(SIGNALS)].map((m) => m[1] || m[2]))];
		hooks.push({ side, where: `${rel}:${line}`, fn: reg.fn, scoped, ids: [...ids].sort((a, b) => a - b), signals });
	}
}

// --- the facts -------------------------------------------------------------------
const out = {};
const byEntry = new Map(quests.map((q) => [Number(q.entry), q]));
function entry(id) {
	if (!out[id]) out[id] = { title: byEntry.get(id).Title, accept: [], handin: [], limit: Number(byEntry.get(id).LimitTime) || 0 };
	return out[id];
}
for (const q of quests) {
	const id = Number(q.entry);
	const accept = q.StartScript !== "0" ? effects("start", q.StartScript, players(q, starters)) : [];
	const handin = q.CompleteScript !== "0" ? effects("end", q.CompleteScript, players(q, enders)) : [];
	if (Number(q.SrcSpell) > 0) accept.push({ via: "accept spell", ...cast(q.SrcSpell) });
	if (Number(q.RewSpellCast) > 0) handin.push({ via: "reward spell", ...cast(q.RewSpellCast) });
	if (!accept.length && !handin.length && !(Number(q.LimitTime) > 0)) continue;
	const e = entry(id);
	e.accept.push(...accept.map((x) => ({ via: "start script", ...x })));
	e.handin.push(...handin.map((x) => ({ via: "end script", ...x })));
}
for (const h of hooks) {
	for (const id of h.ids) {
		if (!byEntry.has(id)) continue;
		entry(id)[h.side].push({ via: h.side === "accept" ? "accept hook" : "rewarded hook", where: h.where, fn: h.fn, scoped: h.scoped, signals: h.signals });
	}
}
const sorted = Object.fromEntries(Object.keys(out).map(Number).sort((a, b) => a - b).map((id) => [id, out[id]]));
const doc = {
	about: "Facts from the cmangos classic data, written by tools/qol-quests/extract.mjs; generate.mjs turns them into QoL.lua's STARTS and HANDIN. Don't edit by hand: re-run extract.mjs.",
	sources: {
		db: args.pinDb || path.basename(args.db),
		dbVersion: version,
		scripts: args.pinScripts || path.basename(root),
		factions: args.pinFactions || path.basename(args.factions),
		spells: args.pinSpells || path.basename(args.spells),
	},
	quests: sorted,
};
// One quest a line, so a refresh reads as a short diff.
const lines = Object.entries(sorted).map(([id, q]) => `\t\t"${id}": ${JSON.stringify(q)}`);
fs.writeFileSync(OUT, `{\n\t"about": ${JSON.stringify(doc.about)},\n\t"sources": ${JSON.stringify(doc.sources)},\n\t"quests": {\n${lines.join(",\n")}\n\t}\n}\n`);
console.log(`extract.mjs: ${Object.keys(sorted).length} quests, ${hooks.length} hooks -> ${OUT}`);
