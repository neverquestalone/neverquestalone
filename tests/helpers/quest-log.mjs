// The quest log as the game has it, for the quest-log tests: a C_QuestLog stub
// with zone headers (collapsible: as on WoW: Forever, GetInfo still lists a
// collapsed header's quests, and the game's own list hides them while it
// draws), hidden quests, task rows, bounties and the log's cap, and the logs
// those tests read:
//   fullLog():  Forever's cap, 40 quests under 15 zone headers (56 entries with
//               one hidden quest); the last header is "Shaman" and its quest,
//               the log's last, is 1527 "Call of Fire", ready to turn in.
//   worstLog(): 40 quests with 60-byte titles and 5 objectives of 60-byte text
//               each, in words, random ASCII or 3-byte CJK (WORST_OTHERS adds
//               19 gear, 25 quest points, 6 professions, 10 milestones).
// The stub's C_QuestLog is defined before the addon loads (Map.lua keeps it).
// ExpandQuestHeader and CollapseQuestHeader only count their calls
// (STUB.headerCalls): the addon never makes one.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lstr } = require('./nqa-vm.js');

export const QLOG_STUB = `
STUB.entries = STUB.entries or {}
STUB.collapsed = STUB.collapsed or {}
STUB.headerCalls = 0
STUB.maxQuests = 40
local function Q(id) for _, e in ipairs(STUB.entries) do if e.id == id then return e end end end
C_QuestLog = {
	GetNumQuestLogEntries = function()
		local n = 0
		for _, e in ipairs(STUB.entries) do if not e.header then n = n + 1 end end
		return #STUB.entries, n
	end,
	GetInfo = function(i)
		local e = STUB.entries[i]
		if not e then return nil end
		if e.header then return { title = e.header, isHeader = true, isCollapsed = STUB.collapsed[e.header] == true, headerSortKey = "k" .. e.header, questLogIndex = i } end
		return { title = e.title, questID = e.id, level = e.level, isHeader = false, isHidden = e.hidden == true, isTask = e.task == true, isBounty = e.bounty == true, questLogIndex = i }
	end,
	GetMaxNumQuestsCanAccept = function() return STUB.maxQuests end,
	IsOnQuest = function(id) return Q(id) ~= nil end,
	IsComplete = function(id) local q = Q(id); return q ~= nil and q.complete == true end,
	ReadyForTurnIn = function(id) local q = Q(id); return q ~= nil and q.complete == true end,
	IsQuestTrivial = function(id) local q = Q(id); return q ~= nil and q.trivial == true end,
	IsQuestFlaggedCompleted = function(id) return false end,
	GetTitleForQuestID = function(id) local q = Q(id); return q and q.title end,
	GetQuestObjectives = function(id) local q = Q(id); return q and q.objectives or {} end,
	GetQuestsOnMap = function(map) return STUB.poi end,
}
function ExpandQuestHeader() STUB.headerCalls = STUB.headerCalls + 1 end
function CollapseQuestHeader() STUB.headerCalls = STUB.headerCalls + 1 end
`;

/** STUB.entries for these entries: { header } or { id, title, level, complete, trivial, hidden, task, bounty, objectives: [{ text, have, need }] }. */
export function entriesLua(entries) {
  const one = (e) => {
    if (e.header) return `{ header = ${lstr(e.header)} }`;
    const obj = (e.objectives || []).map(o => `{ text = ${lstr(`${o.text}: ${o.have}/${o.need}`)}, numFulfilled = ${o.have}, numRequired = ${o.need}, finished = ${o.have >= o.need} }`).join(', ');
    return `{ id = ${e.id}, title = ${lstr(e.title)}, level = ${e.level}, complete = ${!!e.complete}, trivial = ${!!e.trivial}, hidden = ${!!e.hidden}, task = ${!!e.task}, bounty = ${!!e.bounty}, objectives = { ${obj} } }`;
  };
  return `STUB.entries = {\n${entries.map(one).join(',\n')}\n}`;
}

export const ZONES = ['Mulgore', 'The Barrens', 'Stonetalon Mountains', 'Ashenvale', 'Thousand Needles', 'Desolace', 'Hillsbrad Foothills',
  'Arathi Highlands', 'Dustwallow Marsh', 'Stranglethorn Vale', 'Swamp of Sorrows', 'Badlands', 'Tanaris', 'Feralas'];
export const CALL_OF_FIRE = { id: 1527, title: 'Call of Fire', level: 20, complete: true, trivial: false, objectives: [{ text: 'Fire Sapta', have: 1, need: 1 }] };

// A title of 50 to 60 bytes: some multibyte, one with a quote.
function title(i, zone) {
  let t = i === 5 ? `The "Wanted" poster of ${zone}, part ${i}` : `${i % 7 === 3 ? 'Ñandú and Ögre' : 'Errands'} along the roads of ${zone}, part ${i}`;
  while (Buffer.byteLength(t) < 50) t += ' again';
  while (Buffer.byteLength(t) > 60) t = t.slice(0, -1);
  return t.trim();
}

/**
 * Forever's cap: 40 quests under 15 zone headers, one hidden quest, the last
 * header "Shaman" with 1527 "Call of Fire". headers: how many zone headers the
 * 39 other quests go under (up to 14 zones, then more); 30 gives 70 entries.
 */
export function fullLog({ headers = 14 } = {}) {
  const zones = Array.from({ length: headers }, (_, i) => (i < ZONES.length ? ZONES[i] : `${ZONES[i % ZONES.length]} ${Math.floor(i / ZONES.length) + 1}`));
  const quests = Array.from({ length: 39 }, (_, i) => ({
    id: 1488 + i, level: 5 + (i % 20), complete: i % 4 === 1, trivial: i % 9 === 0,
    objectives: Array.from({ length: 1 + (i % 5) }, (_, j) => ({ text: `Collected thing ${j + 1} for quest ${i}`, have: j, need: 6 })),
  }));
  const out = [];
  let q = 0;
  zones.forEach((zone, z) => {
    out.push({ header: zone });
    const n = Math.floor(39 / zones.length) + (z < 39 % zones.length ? 1 : 0);
    for (let k = 0; k < n; k++, q++) out.push({ ...quests[q], title: title(q, zone) });
    if (z === 0) out.push({ id: 90001, title: 'A hidden tracking quest', level: 1, hidden: true, objectives: [] });
  });
  out.push({ header: 'Shaman' }, CALL_OF_FIRE);
  return out;
}

// Deterministic "random" ASCII.
function rng(seed) { let x = seed >>> 0; return () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) / 65536; }
const ALNUM = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
/** A 60-byte string in one of three kinds of text. */
export function text60(kind, n, seed = 1) {
  if (kind === 'cjk') return Array.from({ length: 20 }, (_, i) => String.fromCodePoint(0x4e00 + ((n * 37 + i * 11 + seed) % 20000))).join('');
  if (kind === 'random') { const r = rng(n * 7919 + seed); return Array.from({ length: 60 }, () => ALNUM[Math.floor(r() * ALNUM.length)]).join(''); }
  let t = `The long and winding errand number ${n} across the old roads`;
  while (t.length < 60) t += ' x';
  return t.slice(0, 60);
}

/** 40 quests with 60-byte titles and 5 objectives of 60-byte text, the last 1527. kind: words, random or cjk. */
export function worstLog(kind) {
  const out = [];
  for (let i = 0; i < 40; i++) {
    if (i % 3 === 0) out.push({ header: `Zone ${i / 3 + 1}` });
    out.push({
      id: i === 39 ? 1527 : 1488 + i, title: text60(kind, i), level: 10 + (i % 30), complete: i % 5 === 0 || i === 39, trivial: i % 8 === 0,
      objectives: Array.from({ length: 5 }, (_, j) => ({ text: text60(kind, 100 + i * 5 + j, 3), have: j, need: 9 })),
    });
  }
  return out;
}

/** The rest of a worst-case state: 19 gear, 25 quest points, 6 professions, 10 milestones with 60-byte titles. */
export function worstOthers(kind) {
  return `
STUB.poi = {}
for i = 1, 25 do STUB.poi[i] = { questID = 1488 + i, x = 0.1234 + i / 100, y = 0.5678 } end
for slot = 1, 19 do STUB.inv[slot] = { id = 20000 + slot, link = "|cff1eff00|Hitem:" .. (20000 + slot) .. "::::::::|h[Gear " .. slot .. "]|h|r" }; STUB.ilvl[20000 + slot] = 20 + slot end
NS.Chats.Professions = function() local out = {} for i = 1, 6 do out[i] = { name = "Profession " .. i, rank = 300, max = 300 } end return out end
local p = {}
${Array.from({ length: 10 }, (_, i) => `p[${i + 1}] = { pid = ${i + 1}, id = ${100 + i}, kind = "quest_done", title = ${lstr(text60(kind, 500 + i, 5))}, t = ${1700000000 + i} }`).join('\n')}
NS.Companion.CharDB().pending = p`;
}
