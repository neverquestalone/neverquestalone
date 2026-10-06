// The addon in a real Lua 5.1 runtime (LuaJIT; companion PRD DC5). The other
// suites run it in fengari (Lua 5.3) with a 5.1 string.format shim, and
// order_check.js parses it as 5.1. This runs the same environment (the WoW
// stub, the extras, every addon file in TOC order) under LuaJIT and checks the
// bytes that matter against fengari's: the game-state JSON the bridge hashes,
// the worst case with multibyte text, and the session document. It also
// catches any 5.2+ library call (table.unpack, utf8, math.type, ...) on those
// paths. Skipped, with a note, when luajit isn't installed (brew install luajit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as protocol from '../bridge/app/map-protocol.mjs';

const require = createRequire(import.meta.url);
const { newVM, ADDON, SIG, tocFiles, STUB_METHODS, EXTRA, TRAPS, lstr } = require('./helpers/nqa-vm.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

const luajit = spawnSync('luajit', ['-v'], { encoding: 'utf8' });
const HAVE = luajit.status === 0;
const skip = HAVE ? false : 'luajit is not installed (brew install luajit)';

const SID = 'a1b2c3d4e5f60718';
const GAME = `
STUB.log = {
	{ id = 748, title = "Poison Water", level = 5, complete = false, trivial = false, objectives = { { text = "Prairie Wolf Paw: 3/6", numFulfilled = 3, numRequired = 6, finished = false } } },
	{ id = 761, title = "Swoop Hunting", level = 8, complete = true, trivial = true, objectives = { { text = "Trophy Swoop Quill: 8/8", numFulfilled = 8, numRequired = 8, finished = true } } },
}
STUB.done = {}
local function Q(id) for _, q in ipairs(STUB.log) do if q.id == id then return q end end end
C_QuestLog = {
	GetNumQuestLogEntries = function() return #STUB.log end,
	GetInfo = function(i) local q = STUB.log[i]; if q then return { title = q.title, questID = q.id, level = q.level, isHeader = false } end end,
	IsOnQuest = function(id) return Q(id) ~= nil end,
	IsComplete = function(id) local q = Q(id); return q ~= nil and q.complete end,
	ReadyForTurnIn = function(id) local q = Q(id); return q ~= nil and q.complete end,
	IsQuestTrivial = function(id) local q = Q(id); return q ~= nil and q.trivial end,
	IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end,
	GetTitleForQuestID = function(id) local q = Q(id); return q and q.title end,
	GetQuestObjectives = function(id) local q = Q(id); return q and q.objectives or {} end,
	GetQuestsOnMap = function(map) return STUB.poi end,
}
function UnitName(unit) if unit == "player" then return "Tävï", "" end end -- the client gives the realm too, even "" (E-020)
function GetRealmName() return "Testrealm" end
function UnitRace() return "Tauren", "Tauren" end
function UnitClass() return "Shaman", "SHAMAN" end
STUB.level, STUB.money, STUB.xp, STUB.xpMax = 7, 11800, 300, 1400
function UnitXP() return STUB.xp end
function UnitXPMax() return STUB.xpMax end
STUB.zone, STUB.subzone = "Mulgore", "Bloodhoof Village"
function GetRealZoneText() return STUB.zone end
STUB.posX, STUB.posY = 0.496, 0.663
C_Map.GetBestMapForUnit = function() return 1412 end
STUB.inv, STUB.equipLoc, STUB.ilvl = {}, {}, {}
function GetInventoryItemID(unit, slot) local i = STUB.inv[slot]; return i and i.id end
function GetInventoryItemLink(unit, slot) local i = STUB.inv[slot]; return i and i.link end
C_Item.GetItemInfoInstant = function(item)
	local id = tonumber(tostring(item):match("item:(%d+)")) or tonumber(item)
	if id then return id, "Armor", "Misc", STUB.equipLoc[id] or "" end
end
C_Item.GetDetailedItemLevelInfo = function(link) local id = tonumber(tostring(link):match("item:(%d+)")); return id and STUB.ilvl[id] end
function IsInInstance() return false end
STUB.inv[16] = { id = 2495, link = "|cffffffff|Hitem:2495::::::::7:::::|h[Walking Stick]|h|r" }
STUB.equipLoc[2495], STUB.ilvl[2495] = "INVTYPE_2HWEAPON", 5
`;
// An install the bridge has answered (linked), as every VM transport test is (helpers/nqa-vm.js).
const DB = `NQADB = { linked = true, companion = { chars = { ["Tävï-Testrealm"] = { sid = "${SID}" } } } }`;

// A reply as an AI page's Copy gives it, with every part the addon reads, in
// words that aren't ASCII too (\u escapes, a pair for an emoji, a cut chip).
const PASTED = [
  '## Dein Weg 🗺️',
  '- Erst **Sentinel Hill**, dann *die Farm* | und `zurück`',
  '```wowmap',
  '{"op":"set","layer":"weg","title":"Westfall \\u00fcber alles \\ud83d\\ude00","ordered":true,"points":[{"m":1436,"x":56.35,"y":"47.5","label":"1. Hügel","kind":"turnin","note":"Abgeben","q":[36,36,37]}]}',
  '```',
  '```wowchips',
  '- Führe mich dorthin, über die Brücke und dann weiter bis zum großen Turm im Norden',
  '- Was jetzt?',
  '```',
  '```wowrefs',
  '{"q":[36],"i":["2140"]}',
  '```',
  '```wowweights',
  '{"agi":1.25,"sta":0.5}',
  '```',
  '**TL;DR:** Zum Hügel, dann zur Farm.',
].join('\n');

// Route stop notes (tests/fixtures/stop-notes.json): what Paste.lua's P.DropDistanceClaims keeps
// of each, and a pasted stop with the owner's recording's note, through P.MapCommand.
const NOTES = require('./fixtures/stop-notes.json');
const NOTE_LIST = [NOTES.recording[0], ...NOTES.keep, ...NOTES.drop.map(d => d[0]), ...NOTES.mixed.map(d => d[0])];
const STOP_ROUTE = JSON.stringify({ op: 'set', layer: 'barrens', ordered: true, points: [{ m: 1413, x: 52.1, y: 31.6, label: '1. Hezrul Bloodmark turn-in', kind: 'turnin', note: NOTES.recording[0], q: [852] }] });

// The same steps in both runtimes; each result is a string in OUT.
const SCENARIO = `
OUT = {}
STUB.FireEvent("ADDON_LOADED", "NeverQuestAlone")
STUB.FireEvent("PLAYER_LOGIN")
STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)
STUB.Advance(3.1)
OUT.state = NS.Companion.Build().json
STUB.xp = 1250
STUB.FireEvent("PLAYER_XP_UPDATE", "player")
STUB.level, STUB.xp, STUB.xpMax = 8, 100, 1600
STUB.FireEvent("PLAYER_XP_UPDATE", "player")
STUB.money = 123456789
STUB.FireEvent("PLAYER_MONEY")
STUB.Advance(2.5)
OUT.session = NS.Companion.SessionJSON()
STUB.xp, STUB.xpMax, STUB.money = 0, 0, 0 -- as PLAYER_LOGOUT reads them on 70009
OUT.logout = NS.Companion.SessionJSON()
STUB.xp, STUB.xpMax, STUB.money = 100, 1600, 123456789
local log = {}
for i = 1, 25 do
	local objs = {}
	for j = 1, 5 do
		objs[j] = { text = "Größere Wolfspfote " .. j .. " für den Häuptling: " .. j .. "/9", numFulfilled = j, numRequired = 9, finished = false }
	end
	log[i] = { id = 1000 + i, title = "Die Ländereien der Tauren, Teil " .. i .. " ✓", level = 10 + i % 7, complete = i % 3 == 0, trivial = i % 4 == 0, objectives = objs }
end
STUB.log = log
STUB.posX, STUB.posY = 0.123456, 0.987654
local worst = NS.Companion.Fit(NS.Companion.Gather(), 42, 1790000000)
OUT.worst = worst
OUT.worstBytes = tostring(#worst)
OUT.ctxquests = NS.Chats.GameContext():match("Quest log[^\\n]*$")
-- A full log (40 quests, 60-byte titles) for a bridge with cap qlog, sent plain (3,100
-- bytes): every quest, titles shortened on a UTF-8 boundary with "cut", the count and cap first.
for i = 1, 40 do
	log[i] = log[i] or { id = 1000 + i, level = 12, complete = false, trivial = false, objectives = {} }
	log[i].title = "Die Ländereien der Tauren und größere Wolfspfoten ✓ Teil " .. i
end
OUT.qlog = NS.Companion.Fit(NS.Companion.Gather(), 43, 1790000000, { qlog = true })
-- The state deflated for the strip (cap z), through a stand-in for the client's
-- deflate that both runtimes run the same: each text is kept under a short key,
-- and base64 leaves the key as it is. The addon's checks and the record are real.
local kept, n = {}, 0
C_EncodingUtil = {
	CompressString = function(s) n = n + 1; kept["k" .. n] = s; return "k" .. n end,
	DecompressString = function(k) return kept[k] end,
	EncodeBase64 = function(s) return s end,
	DecodeBase64 = function(s) return s end,
}
-- The app's check-ins switch on (cap usage, usage.autoOn): the companion sends nothing without it.
NS.R.bridge = { caps = { "state", "evt", "z", "usage" }, usage = { autoOn = true } }
NS.Companion.QueueState()
OUT.zstate = NS.R.stateRec.wire:match("\\31state\\31\\31(.*)$")
OUT.zjson = kept.k1
-- A message beside its state, with a bridge that takes the game context from it (cap ctx):
-- the context stays out although the place changed.
NS.R.bridge = { caps = { "state", "evt", "z", "ctx", "usage" }, usage = { autoOn = true } }
STUB.posX = 0.2
NS.Chats.Send("where next?")
OUT.ctxmsg = NS.FromHex(NQADB.outbox[#NQADB.outbox].hex):match("\\31msg\\31c%x+\\31(.*)$") -- args and body (the token, key and chat id are random)
-- Copy and Paste (Paste.lua): the message for the AI, and a reply read back,
-- written out in one fixed order (keys sorted) so the runtimes can be compared.
local function S(v)
	if type(v) == "table" then
		local keys = {}
		for k in pairs(v) do keys[#keys + 1] = tostring(k) end
		table.sort(keys)
		local parts = {}
		for _, k in ipairs(keys) do
			local x = v[k]
			if x == nil then x = v[tonumber(k)] end
			parts[#parts + 1] = k .. "=" .. S(x)
		end
		return "{" .. table.concat(parts, ",") .. "}"
	end
	if type(v) == "number" then return v == math.floor(v) and string.format("%d", v) or string.format("%.4f", v) end
	return tostring(v)
end
NQADB.settings.replies = "paste"
NS.Chats.Send("Route me, please")
OUT.pasteMsg = NQAPasteOut:GetText()
local r = NS.Paste.Parse(${lstr(PASTED)})
OUT.pasteParse = S(r)
OUT.pasteCmd = S(NS.Paste.MapCommand(r.map[1]))
local notes = {}
for _, s in ipairs({ ${NOTE_LIST.map(lstr).join(', ')} }) do notes[#notes + 1] = NS.Paste.DropDistanceClaims(s) end
OUT.stopNotes = table.concat(notes, "\\n")
local okStop, stop = NS.Paste.JSON(${lstr(STOP_ROUTE)})
OUT.stopCmd = okStop and S(NS.Paste.MapCommand(stop)) or "unreadable"
`;
// LuaJIT only: fengari's integers are 32-bit, so it can't format a number past 2^31; the game's doubles can.
const BIG = `OUT.big = NS.Companion.Fit(NS.Companion.Gather(), 4294967296, 1790000000):match('"seq":[^,]*')`;

// What the scenario's program writes: each result on a line, as key TAB value.
const WRITE_OUT = 'for _, k in ipairs({ "state", "session", "logout", "worst", "worstBytes", "qlog", "ctxquests", "big", "zstate", "zjson", "ctxmsg", "pasteMsg", "pasteParse", "pasteCmd", "stopNotes", "stopCmd" }) do WRITE(k, "\\t", (OUT[k] or "<nil>"):gsub("\\n", "\\\\n"), "\\n") end';

// Every chunk newVM runs, in its order, as one LuaJIT program, then the steps given (the scenario's by default).
function program(steps = [SCENARIO, BIG, WRITE_OUT]) {
  const bracket = src => { let eq = ''; while (src.includes(`]${eq}]`)) eq += '='; return `[${eq}[\n${src}]${eq}]`; };
  const parts = [
    'local WRITE = io.write',
    fs.readFileSync(path.join(HERE, 'wow_stub.lua'), 'utf8') + STUB_METHODS,
    EXTRA,
    'math.randomseed(7)',
    ...['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act'].map(f => `STUB.sounds[${JSON.stringify(SIG + 'ctl\\' + f + '.wav')}] = true`),
    GAME,
    DB,
    'NS = {}',
    ...tocFiles().map(f => `assert(loadstring(${bracket(fs.readFileSync(path.join(ADDON, f), 'utf8'))}, "@NeverQuestAlone/${f}"))("NeverQuestAlone", NS)`),
    TRAPS,
    ...steps,
  ];
  return parts.join('\n');
}

function viaLuaJIT() {
  const r = spawnSync('luajit', ['-'], { input: program(), encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, `luajit failed:\n${r.stderr}`);
  return Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => { const i = l.indexOf('\t'); return [l.slice(0, i), l.slice(i + 1).replace(/\\n/g, '\n')]; }));
}

function viaFengari() {
  const vm = newVM({ extra: GAME, db: DB });
  vm.run(SCENARIO, 'scenario');
  return Object.fromEntries(['state', 'session', 'logout', 'worst', 'worstBytes', 'qlog', 'ctxquests', 'zstate', 'zjson', 'ctxmsg', 'pasteMsg', 'pasteParse', 'pasteCmd', 'stopNotes', 'stopCmd'].map(k => [k, vm.evaluate(`OUT.${k}`)]));
}

test('Lua 5.1 (LuaJIT): the state, the worst case (also fitted for a bridge with qlog, titles shortened), the context\'s quest line, the session document (also as written at a logout that reads 0), the state record deflated for the strip and a message beside it without its context come out byte for byte as in the test VM', { skip }, () => {
  const jit = viaLuaJIT();
  const vm = viaFengari();
  for (const k of ['state', 'session', 'logout', 'worst', 'worstBytes', 'qlog', 'ctxquests', 'zstate', 'zjson', 'ctxmsg', 'pasteMsg', 'pasteParse', 'pasteCmd', 'stopNotes', 'stopCmd']) assert.equal(jit[k], vm[k], `${k} differs between LuaJIT and fengari`);
  // Copy and Paste read the reply's parts under Lua 5.1 too.
  assert.match(jit.pasteMsg, /The player's message:\nRoute me, please$/);
  assert.match(jit.pasteParse, /summary=Zum Hügel, dann zur Farm\./);
  // Cut at 59 characters, then back to the last whole word, as the app cuts a chip.
  assert.match(jit.pasteParse, /chips=\{1=Führe mich dorthin, über die Brücke und dann weiter bis…,2=Was jetzt\?\}/);
  assert.match(jit.pasteCmd, /title=Westfall über alles 😀/);
  assert.match(jit.pasteCmd, /q=\{1=36,2=37\}/);
  // A stop note's distance claims go under Lua 5.1 as in the app: the recording's note keeps its
  // instruction, and every fixture note comes out as map-protocol.mjs has it.
  assert.deepEqual(jit.stopNotes.split('\n'), NOTE_LIST.map(n => protocol.dropDistanceClaims(n)));
  assert.equal(jit.stopNotes.split('\n')[0], 'Hand in the head.');
  assert.deepEqual(jit.stopNotes.split('\n').slice(-NOTES.mixed.length), NOTES.mixed.map(d => d[1]), 'an instruction never goes with a claim');
  assert.match(jit.stopCmd, /label=1\. Hezrul Bloodmark turn-in,m=1413,note=Hand in the head\.,q=\{1=852\}/);
  // The message: ctx=0 and st= naming its state, and just its words.
  const [margs, mbody] = jit.ctxmsg.split('\x1f');
  assert.match(margs, /;ctx=0;q=followup;st=\d+$/);
  assert.equal(mbody, 'where next?');
  // The deflated state's record: z=1 after cur, sid and seq, and the stand-in's key as the body.
  const [args, body] = jit.zstate.split('\x1f');
  assert.match(args, new RegExp(`^cur=0;sid=${SID};seq=\\d+;z=1$`));
  assert.equal(body, 'k1');
  assert.equal(JSON.parse(jit.zjson).sid, SID, 'the JSON it deflated');
  for (const k of ['state', 'session', 'worst']) {
    const doc = JSON.parse(jit[k]);
    assert.equal(JSON.stringify(doc), jit[k], `${k}: canonical JSON (no spaces, whole numbers without .0)`);
  }
  const state = JSON.parse(jit.state);
  assert.equal(state.sid, SID);
  assert.equal(state.char.name, 'Tävï', 'multibyte text survives');
  const worst = JSON.parse(jit.worst);
  assert.equal(jit.big, '"seq":4294967296', 'a number past 2^31 prints whole in 5.1');
  assert.ok(Number(jit.worstBytes) <= 2800, 'within the 2,800-byte budget');
  assert.ok(worst.omitted.length > 0 || worst.state === 'too_large', 'the drop order ran');
  assert.equal(worst.quests.length, 25, 'every quest');
  const qlog = JSON.parse(jit.qlog);
  assert.equal(JSON.stringify(qlog), jit.qlog);
  assert.ok(Buffer.byteLength(jit.qlog) <= 3100, `${Buffer.byteLength(jit.qlog)} bytes`);
  assert.deepEqual([qlog.questCount, qlog.questMax, qlog.quests.length], [40, 40, 40], 'the whole log, and the cap');
  assert.ok(qlog.quests.some(q => q.cut === true) && qlog.quests.every(q => q.title && !q.title.includes('\ufffd')), 'titles shortened on a character, and said so');
  assert.match(jit.ctxquests, /^Quest log \(id, \* = ready to turn in\): 25 of 40 quests, all listed: 1001,1002,1003\*,/);
  const session = JSON.parse(jit.session);
  assert.equal(session.kind, 'session');
  assert.equal(session.moneyDelta, 123456789 - 11800);
  assert.equal(jit.logout, jit.session, 'a logout that reads 0 writes what play last saw');
});

// [code health AD-02] Copy and Paste's Pair() looked for a closing mark again from every opener:
// one 60 KB line of unclosed ** took seconds in LuaJIT (quadratic), longer in the game, and froze
// the client; so did the cut at 12,000 bytes, looking for the last line break, grey and close
// from every byte of a text with none. One pass each now, and the text comes out as it went in
// (paste_test.mjs holds the replies to the app's renderer; the scenario above holds them to fengari).
test('Lua 5.1 (LuaJIT): a pasted reply that is one 60 KB line of unclosed marks reads at once, its text as it was (code health AD-02)', { skip }, () => {
  const steps = [`
STUB.FireEvent("ADDON_LOADED", "NeverQuestAlone")
STUB.FireEvent("PLAYER_LOGIN")
local worst, same = 0, true
for _, mark in ipairs({ "**", "__", "~~" }) do
	local line = string.rep(mark .. "x ", 14990) -- 59,960 bytes: the TL;DR line fits in the 60,000 read
	local t0 = os.clock()
	local r = NS.Paste.Parse(line .. "\\nTL;DR: marks.")
	worst = math.max(worst, os.clock() - t0)
	same = same and r.text == line:sub(1, 12000) and r.summary == "marks."
end
WRITE(string.format("%.3f %s\\n", worst, tostring(same)))`];
  const r = spawnSync('luajit', ['-'], { input: program(steps), encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, `luajit failed:\n${r.stderr}`);
  const [secs, same] = r.stdout.trim().split(' ');
  assert.equal(same, 'true', 'the text is the line as it went in (cut at 12,000 bytes), and the TL;DR is read');
  assert.ok(Number(secs) < 0.5, `${secs} s for the slowest mark`);
});

// [code health AD-03] The strip encodes every frame into one table (no 160 KB of garbage a draw):
// frame after frame, longer and shorter, each one's cells under real Lua 5.1 must be exactly the
// reference encoder's (tests/byok/helpers/strip-fixtures.mjs, in JavaScript), with nothing left
// over from a longer frame before it, and the same as a fresh table's.
test('Lua 5.1 (LuaJIT): the strip\'s encoder fills one table frame after frame, longer and shorter, each frame\'s cells exactly the reference encoder\'s (code health AD-03)', { skip }, async () => {
  const { encodeBytes } = await import('./byok/helpers/strip-fixtures.mjs');
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const frames = [3200, 12, 0, 1777, 3, 3200, 640, 1, 2999].map((len, i) => ({ id: (i * 9973 + 65000) % 65536, bytes: Buffer.from(Array.from({ length: len }, () => Math.floor(rand() * 256))) }));
  const lit = b => '"' + [...b].map(x => '\\' + x).join('') + '"';
  const prog = [
    fs.readFileSync(path.join(ADDON, 'Codec.lua'), 'utf8'),
    'local into = {}',
    ...frames.map(f => `do
      local cells, n = NQA_Codec.Encode(${f.id}, ${lit(f.bytes)}, into)
      local fresh = NQA_Codec.Encode(${f.id}, ${lit(f.bytes)})
      io.write(cells == into and "same" or "other", " ", n, " ", #fresh == #cells and "len" or "LEN", " ", table.concat(cells, ""), "\\n")
    end`),
  ].join('\n');
  const r = spawnSync('luajit', ['-'], { input: prog, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, frames.length);
  frames.forEach((f, i) => {
    const [table, n, len, cells] = lines[i].split(' ');
    assert.equal(table, 'same', `frame ${i}: the table given is filled`);
    assert.equal(Number(n), f.bytes.length + 8, `frame ${i}: bytes encoded`);
    assert.equal(len, 'len', `frame ${i}: as many cells as a fresh table's`);
    assert.equal(cells ?? '', encodeBytes(f.id, [...f.bytes]).join(''), `frame ${i} (${f.bytes.length} bytes): the reference encoder's cells`);
  });
});

// [code health AD-04] Lua 5.1 allows 200 active locals in a function, the main chunk included,
// and a file past it doesn't load at all. HUD.lua's main chunk sat at 198 (three more before its
// line 3050 broke it), and code was bent around the limit. Every file now keeps 20 spare.
const SPARE = 20;
const luaparse = require('luaparse');
// The most locals active at once in each function of a file, by Lua 5.1's rules (a numeric or
// generic for adds 3 hidden ones; a method has self), as the audit counted them (locals.cjs).
function mostLocals(src) {
  const ast = luaparse.parse(src, { luaVersion: '5.1', locations: true });
  const out = [];
  let fn = null;
  const open = (name, line) => { fn = { name, line, scopes: [], active: 0, max: 0, at: line, up: fn }; out.push(fn); fn.scopes.push(0); };
  const close = () => { fn = fn.up; };
  const declare = (line, n = 1) => { fn.scopes[fn.scopes.length - 1] += n; fn.active += n; if (fn.active > fn.max) { fn.max = fn.active; fn.at = line; } };
  const push = () => fn.scopes.push(0);
  const pop = () => { fn.active -= fn.scopes.pop(); };
  const func = (node, name) => {
    open(name, node.loc.start.line);
    if (node.identifier && node.identifier.type === 'MemberExpression' && node.identifier.indexer === ':') declare(node.loc.start.line);
    declare(node.loc.start.line, node.parameters.filter(p => p.type === 'Identifier').length);
    block(node.body);
    close();
  };
  const expr = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.type === 'FunctionDeclaration') return func(e, '<function>');
    for (const k of Object.keys(e)) {
      if (k === 'loc') continue;
      const v = e[k];
      if (Array.isArray(v)) v.forEach(expr); else if (v && typeof v === 'object' && v.type) expr(v);
    }
  };
  const block = (body) => body.forEach(stmt);
  const stmt = (s) => {
    const line = s.loc.start.line;
    switch (s.type) {
      case 'LocalStatement': s.init.forEach(expr); declare(line, s.variables.length); break;
      case 'FunctionDeclaration': if (s.isLocal) declare(line); func(s, s.identifier ? (s.identifier.name || s.identifier.identifier?.name || '?') : '<function>'); break;
      case 'IfStatement': for (const c of s.clauses) { expr(c.condition); push(); block(c.body); pop(); } break;
      case 'WhileStatement': expr(s.condition); push(); block(s.body); pop(); break;
      case 'RepeatStatement': push(); block(s.body); expr(s.condition); pop(); break;
      case 'DoStatement': push(); block(s.body); pop(); break;
      case 'ForNumericStatement': expr(s.start); expr(s.end); expr(s.step); push(); declare(line, 4); push(); block(s.body); pop(); pop(); break;
      case 'ForGenericStatement': s.iterators.forEach(expr); push(); declare(line, 3 + s.variables.length); push(); block(s.body); pop(); pop(); break;
      default: expr(s);
    }
  };
  open('main chunk', 1);
  block(ast.body);
  return out;
}

test(`every addon file keeps ${SPARE} of Lua 5.1's 200 locals spare in every function, the main chunk included (luaparse, code health AD-04)`, () => {
  const over = [];
  for (const f of tocFiles()) {
    for (const fn of mostLocals(fs.readFileSync(path.join(ADDON, f), 'latin1'))) {
      if (fn.max > 200 - SPARE) over.push(`${f}: ${fn.name} (line ${fn.line}) has ${fn.max} active at line ${fn.at}`);
    }
  }
  assert.deepEqual(over, [], 'past 180 active locals: fold constants into a table, or move code into a block or a function');
  // The count is Lua's own: HUD.lua's main chunk had 198 (193 declared at its top level, 5 hidden by two loops).
  const hud = mostLocals(fs.readFileSync(path.join(ADDON, 'HUD.lua'), 'latin1'))[0];
  assert.ok(hud.max <= 120, `HUD.lua's main chunk: ${hud.max} active`);
});

test(`Lua 5.1 (LuaJIT): every addon file still compiles with ${SPARE} more locals at the top of its main chunk (code health AD-04)`, { skip }, () => {
  const extra = `local ${Array.from({ length: SPARE }, (_, i) => `spare${i + 1}`).join(', ')}\n`;
  const bracket = src => { let eq = ''; while (src.includes(`]${eq}]`)) eq += '='; return `[${eq}[\n${src}]${eq}]`; };
  const prog = tocFiles().map(f => `do local ok, why = loadstring(${bracket(extra + fs.readFileSync(path.join(ADDON, f), 'utf8'))}, "@${f}"); io.write(${JSON.stringify(f)}, "\\t", ok and "ok" or tostring(why), "\\n") end`).join('\n');
  const r = spawnSync('luajit', ['-'], { input: prog, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  const bad = r.stdout.trim().split('\n').filter(l => !l.endsWith('\tok'));
  assert.deepEqual(bad, [], 'a file that no longer loads with 20 more locals');
  assert.equal(r.stdout.trim().split('\n').length, tocFiles().length, 'every file in the TOC');
});
