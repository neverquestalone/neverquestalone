// Quality of Life (addon/NeverQuestAlone/QoL.lua; PRD DB28), in the fengari VM running
// the real addon: the addon's own options off to start; nothing acts without
// the player's own click on that window (a quest giver's pages in turn, a body
// or chest, a vendor; never another player's share), and only as QoL.lua
// lists; Shift held as a page opens (or being away) leaves it to the player; nothing
// from outside the game turns any of it on; and every edge case the spec
// names: multi-reward quests, repeatables and dailies, item and gold
// hand-ins, escort, event and group quests, shared quests,
// NPCs with both services and quests, full bags, and loot rolls and
// bind-on-pickup (never touched: the game's own Auto Loot).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { newVM, reloadVM, lstr, ADDON, SIG, tocFiles, STUB_METHODS, EXTRA, TRAPS: VM_TRAPS } = require('./helpers/nqa-vm.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// The game as QoL.lua sees it: the quest on offer (QS.q), a greeting (QS.g,
// QS.greet), a vendor (QS.m), your bags (QS.bags, QS.excluded), whoever
// shares a quest (QS.sharer), and the CVars. Every action QoL may take is
// recorded in QS.calls; everything it must never call is a trap (STUB.forbidden).
const WORLD = `
QS = { calls = {} }
local function Call(name, ...)
	local parts = { name }
	for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
	table.insert(QS.calls, table.concat(parts, " "))
end
QS.Call = Call
function QS.Reset()
	QS.calls = {}
	QS.q = { id = 871, title = "Disrupt the Attacks", startItem = 0, autoAccept = false, areaTrigger = false, adventure = false,
		pvp = false, group = 0, tag = nil, trivial = false, repeatable = false, frequency = 0, completable = true,
		money = 0, currencies = 0, required = {}, choices = {}, rewards = 0, timer = nil }
	QS.g = { options = {}, active = {}, available = {}, force = false }
	QS.greet = { active = {}, available = {} }
	QS.m = { canRepair = true, cost = 0, junkEnabled = true, junk = 0 }
	QS.bags = { [0] = {}, [1] = {}, [2] = {}, [3] = {}, [4] = {} }
	QS.excluded = {}
	QS.free = { [0] = 10 }
	QS.sharer = nil
	QS.npc, QS.questnpc = nil, nil
	QS.afk = false
	QS.logCount = 5
	QS.log = {}
	QS.prices = {}
	QS.items = {}
	QS.defaulting = false
	STUB.shift = false
end
QS.Reset()

-- The quest pages (QuestFrame.lua's globals).
function GetQuestID() return QS.q.id end
function GetTitleText() return QS.q.title end
function GetObjectiveText() return QS.q.objectives or "Kill 8 Razormane Water Seekers, 8 Razormane Thornweavers and 3 Razormane Hunters." end
function QuestGetAutoAccept() return QS.q.autoAccept end
function QuestIsFromAreaTrigger() return QS.q.areaTrigger end
function QuestIsFromAdventureMap() return QS.q.adventure end
function QuestFlagsPVP() return QS.q.pvp end
function GetSuggestedGroupSize() return QS.q.group end
function IsQuestCompletable() return QS.q.completable end
function GetQuestMoneyToGet() return QS.q.money end
function GetNumQuestCurrencies() return QS.q.currencies end
function GetNumQuestItems() return #QS.q.required end
function GetNumQuestChoices() return #QS.q.choices end
function GetNumQuestRewards() return QS.q.rewards end
function GetQuestItemInfo(kind, i)
	local list = kind == "required" and QS.q.required or (kind == "choice" and QS.q.choices) or {}
	local it = list[i]
	if not it then return nil end
	return it.name, 134400, it.count or 1, it.quality or 2, it.usable ~= false, it.id
end
function GetQuestItemLink(kind, i)
	local list = kind == "required" and QS.q.required or (kind == "choice" and QS.q.choices) or {}
	local it = list[i]
	return it and it.link
end
function AcceptQuest() Call("AcceptQuest") end
function CompleteQuest() Call("CompleteQuest") end
function GetQuestReward(i) Call("GetQuestReward", i) end
C_QuestLog = C_QuestLog or {}
C_QuestLog.GetQuestTagInfo = function(id) if QS.q.tag then return { tagID = QS.q.tag, tagName = "Tag" } end end
C_QuestLog.IsQuestTrivial = function(id) return QS.q.trivial end
C_QuestLog.IsRepeatableQuest = function(id) return QS.q.repeatable end
C_QuestLog.GetLogIndexForQuestID = function(id) return 3 end
-- The log GetNumQuestLogEntries tells: two headers, then QS.logCount quests
-- (ns.QuestLog, which LogFull counts, reads it row by row).
C_QuestLog.GetInfo = function(i)
	if i <= 2 then return { isHeader = true, title = "Zone " .. i } end
	return { questID = QS.q.id, frequency = QS.q.frequency }
end
C_QuestLog.GetNumQuestLogEntries = function() return QS.logCount + 2, QS.logCount end
C_QuestLog.GetMaxNumQuestsCanAccept = function() return 20 end
-- The quests in your log by id (QS.log), apart from the count above.
C_QuestLog.IsOnQuest = function(id) return QS.log[id] == true end
C_QuestLog.GetTimeAllowed = function(id) if QS.q.timer then return QS.q.timer, 0 end end

-- Who opened the page: an NPC (the game's two units for it, QS.npc and
-- QS.questnpc), or a player sharing a quest.
function UnitIsPlayer(u)
	if u == "questnpc" then return QS.sharer ~= nil end
	return u == "player"
end
function UnitGUID(u)
	if u == "questnpc" then if QS.sharer then return QS.sharer.guid end return QS.questnpc end
	if u == "npc" then return QS.npc end
	if u == "player" then return "Player-1-0000000A" end
end
function UnitIsAFK(u) return u == "player" and QS.afk end
local function Sharer(g) return QS.sharer and QS.sharer.guid == g and QS.sharer or nil end
C_PartyInfo = { IsGUIDInGroup = function(g) local s = Sharer(g); return s ~= nil and s.grouped == true end }
C_FriendList = { IsFriend = function(g) local s = Sharer(g); return s ~= nil and s.friend == true end }
C_BattleNet = { GetAccountInfoByGUID = function(g) local s = Sharer(g); if s and s.bnet then return { accountName = "Friend#1234" } end end }
function IsGuildMember(g) local s = Sharer(g); return s ~= nil and s.guild == true end

-- Greetings: gossip (C_GossipInfo) and the quest greeting (legacy globals).
C_GossipInfo = {
	GetOptions = function() return QS.g.options end,
	GetActiveQuests = function() return QS.g.active end,
	GetAvailableQuests = function() return QS.g.available end,
	ForceGossip = function() return QS.g.force end,
	SelectActiveQuest = function(id) Call("SelectActiveQuest", id) end,
	SelectAvailableQuest = function(id) Call("SelectAvailableQuest", id) end,
}
function GetNumActiveQuests() return #QS.greet.active end
function GetActiveTitle(i) local q = QS.greet.active[i]; return q.title, q.complete end
function GetActiveQuestID(i) return QS.greet.active[i].id end
function GetNumAvailableQuests() return #QS.greet.available end
function GetAvailableQuestInfo(i) local q = QS.greet.available[i]; return q.trivial, 0, false, false, q.id end
function SelectActiveQuest(i) Call("GreetingActive", i) end
function SelectAvailableQuest(i) Call("GreetingAvailable", i) end

-- A vendor, and bags left out of Sell All Junk (the bag menu's check box).
function CanMerchantRepair() return QS.m.canRepair end
function GetRepairAllCost() return QS.m.cost, QS.m.cost > 0 end
function RepairAllItems(guild) Call("RepairAllItems", guild) end
C_MerchantFrame = {
	IsSellAllJunkEnabled = function() return QS.m.junkEnabled end,
	GetNumJunkItems = function() return QS.m.junk end,
	SellAllJunkItems = function() Call("SellAllJunkItems") end,
}
MerchantFrame = CreateFrame("Frame", "MerchantFrame")
NUM_BAG_SLOTS = 4
C_Container = {
	GetContainerNumSlots = function(bag) return #(QS.bags[bag] or {}) end,
	GetContainerItemInfo = function(bag, slot) local it = (QS.bags[bag] or {})[slot]; if it and it.itemID then return it end end,
	UseContainerItem = function(bag, slot) Call("UseContainerItem", bag, slot) end,
	GetContainerNumFreeSlots = function(bag) return QS.free[bag] or 0, 0 end,
	GetBagSlotFlag = function(bag, flag) return flag == 64 and QS.excluded[bag] == true end,
	GetBackpackSellJunkDisabled = function() return QS.excluded[0] == true end,
}
local itemInfo = C_Item.GetItemInfo
C_Item.GetItemInfo = function(item)
	local key = tostring(item)
	local id = tonumber(key:match("item:(%d+)")) or tonumber(item)
	if id and QS.prices[id] ~= nil then
		local name = key:match("%[(.-)%]") or ("Item " .. id)
		return name, key, 2, 10, 5, "Armor", "Misc", 1, "", 134400, QS.prices[id]
	end
	return itemInfo(item)
end
C_Item.GetItemInfoInstant = function(item)
	local id = tonumber(tostring(item):match("item:(%d+)")) or tonumber(item)
	local it = id and QS.items[id]
	if it then return id, "Armor", "Misc", it.equipLoc or "", 134400, it.classID or 4, 0 end
	if id then return id, "Armor", "Misc", "", 134400, 4, 0 end
end
C_Item.GetItemStats = function(link)
	local id = tonumber(tostring(link):match("item:(%d+)"))
	local it = id and QS.items[id]
	return it and it.stats
end
QS.worn = {}
function GetInventoryItemLink(unit, slot) return QS.worn[slot] end

-- The game's own settings, and its Settings page's Defaults at work.
STUB.cvars.autoLootDefault = "0"
STUB.cvars.autoQuestWatch = "1"
C_CVar = {
	GetCVar = function(n) return STUB.cvars[n] end,
	SetCVar = function(n, v) Call("SetCVar", n, v); STUB.cvars[n] = v; return true end,
	GetCVarDefault = function(n) if n == "autoQuestWatch" then return "1" end if n == "autoLootDefault" then return "0" end end,
}
function GetModifiedClick(action) if action == "AUTOLOOTTOGGLE" then return QS.lootKey or "SHIFT" end end
SettingsPanel = { CheckIsSettingDefaults = function(self) return QS.defaulting == true end }
SOUNDKIT = SOUNDKIT or {}
SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_ON, SOUNDKIT.IG_MAINMENU_OPTION_CHECKBOX_OFF = 856, 857
-- GlobalStrings the game's refusals use (UI_ERROR_MESSAGE).
ERR_INV_FULL, ERR_QUEST_LOG_FULL, ERR_QUEST_FAILED_S = "Inventory is full.", "Your quest log is full.", "%s failed."
ERR_OUT_OF_RANGE = "Out of range."
`;

// What QoL must never call: every one records itself and raises.
const NEVER = [
  'LootSlot', 'ConfirmLootSlot', 'RollOnLoot', 'ConfirmLootRoll', 'ConfirmAcceptQuest', 'DeclineQuest',
  'AcknowledgeAutoAcceptQuest', 'CloseQuest', 'SelectGossipOption', 'TargetUnit', 'InteractUnit', 'AssistUnit',
  'FollowUnit', 'UseItemByName', 'UseInventoryItem', 'UseContainerItem', 'PickupContainerItem', 'DeleteCursorItem', 'EquipItemByName',
  'AcceptGroup', 'AcceptTrade', 'AcceptResurrect', 'RepopMe', 'RetrieveCorpse', 'BuyMerchantItem', 'BuybackItem',
  'StaticPopup_OnClick', 'CastSpell', 'MoveForwardStart', 'JumpOrAscendStart', 'ToggleAutoRun',
  'CastSpellByName', 'CastSpellByID', 'CastShapeshiftForm', 'TargetNearestEnemy', 'TargetNearestFriend', 'TargetLastTarget',
  'AttackTarget', 'StartAttack', 'UseAction', 'RunMacro', 'RunMacroText', 'MoveBackwardStart', 'TurnLeftStart',
  'TurnRightStart', 'StrafeLeftStart', 'StrafeRightStart',
];
const TRAPS = `
local function Trap(name) return function() table.insert(STUB.forbidden, name); error("QoL must never call " .. name, 2) end end
for _, name in ipairs({ ${NEVER.map(n => `"${n}"`).join(', ')} }) do _G[name] = Trap(name) end
C_GossipInfo.SelectOption = Trap("C_GossipInfo.SelectOption")
C_GossipInfo.SelectOptionByIndex = Trap("C_GossipInfo.SelectOptionByIndex")
C_Container.UseContainerItem = Trap("C_Container.UseContainerItem")
`;

// The game's Settings API, as ui_v2_test.js stubs it, keeping each row's
// tooltip, indent, gray-out tests and the settings it watches. Every way it
// has to make a dropdown counts itself in STUB.dropdowns, and every parent
// link in STUB.parentLinks: the addon makes none (E-047, QL-36).
const SETTINGS_API = `
STUB.controls, STUB.settings, STUB.inits, STUB.tips, STUB.notified, STUB.dropdowns, STUB.parentLinks = {}, {}, {}, {}, {}, {}, {}
local function Init(name)
	local i = { control = name }
	-- The Options search reads a row's parent link unguarded (Blizzard_SettingsPanel.lua:712).
	function i:SetParentInitializer(parent, predicate) table.insert(STUB.parentLinks, name); self.parent, self.predicate = parent.control, predicate end
	function i:Indent() self.indent = 15 end
	function i:AddModifyPredicate(fn) self.predicates = self.predicates or {}; table.insert(self.predicates, fn) end
	function i:AddEvaluateStateCVar(var) self.watches = self.watches or {}; table.insert(self.watches, var) end
	table.insert(STUB.inits, i)
	return i
end
local function Dropdown(name) return function() table.insert(STUB.dropdowns, name) end end
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name)
		STUB.category = { name = name, GetID = function() return 42 end }
		return STUB.category, { AddInitializer = function() end }
	end,
	RegisterInitializer = function(cat, i) table.insert(STUB.inits, i) end,
	RegisterProxySetting = function(cat, var, vt, name, def, get, set)
		local s = { var = var, name = name, def = def, get = get, set = set, vt = vt }
		function s:NotifyUpdate() table.insert(STUB.notified, self.name) end
		STUB.settings[name] = s
		return s
	end,
	CreateCheckbox = function(cat, setting, tip) table.insert(STUB.controls, "checkbox: " .. setting.name); STUB.tips[setting.name] = tip; return Init(setting.name) end,
	CreateDropdown = Dropdown("Settings.CreateDropdown"),
	CreateDropdownInitializer = Dropdown("Settings.CreateDropdownInitializer"),
	InitDropdown = Dropdown("Settings.InitDropdown"),
	CreateControlTextContainer = function() local c = { data = {} }; function c:Add(v, l, t) table.insert(self.data, { value = v, label = l, tooltip = t }) end; function c:GetData() return self.data end; return c end,
	CreateSliderOptions = function(min, max, step) local o = { minValue = min, maxValue = max, step = step }; function o:SetLabelFormatter() end; return o end,
	CreateSlider = function(cat, setting) table.insert(STUB.controls, "slider: " .. setting.name); return Init(setting.name) end,
	RegisterAddOnCategory = function(c) STUB.registered = c end,
	OpenToCategory = function(id, name) STUB.opened, STUB.openedAt = id, name end,
	KEYBINDINGS_CATEGORY_ID = 7,
}
function CreateSettingsListSectionHeaderInitializer(name) return { header = name } end
function CreateSettingsButtonInitializer(name, text, click, tip, tags) return { button = text } end
MinimalSliderWithSteppersMixin = { Label = { Left = 1, Right = 2 } }
AddonCompartmentFrame = { RegisterAddon = function(self, d) STUB.compartment = d end }
STUB.menus = {}
Menu = { ModifyMenu = function(tag, fn) STUB.menus[tag] = fn end }
`;

// Saved data past the first reply (in an earlier session): the HUD is main's widget, and the
// Quality of Life step may show (hudIntro; before the first reply the setup block stands there).
const WELCOMED = 'NQADB = { hudIntro = true, firstReply = true, qolAsked = true }';
const B = '|cff7ec8ff[NeverQuestAlone]|r ';

// The bridge answers the hello, so the HUD is ready (tests/ui_v2_test.js's).
function hello(vm) {
  vm.advance(3.1);
  vm.slot(`{ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.4.1", push = 0, nonce = "${vm.evaluate('NS.R.nonce')}", acked = {} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {}, records = {} }`);
  const bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false);
  vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true);
  vm.run('NS.Transport.Poll()');
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  vm.run('NS.HUD.Render()');
  return vm;
}

function world({ db = WELCOMED, settings = false, extra = '', skip, ready = false, before = '', inbox } = {}) {
  const vm = newVM({ db, extra: WORLD + (settings ? SETTINGS_API : '') + extra, before: TRAPS + before, skip, inbox }).login();
  if (ready) hello(vm);
  else if (settings) vm.advance(10.1); // the Settings page waits for the app's first answer, or 10 s (C-18)
  vm.calls = () => vm.list('QS.calls');
  vm.fire = (event, ...args) => vm.run(`STUB.FireEvent("${event}"${args.map(a => ', ' + a).join('')})`);
  // Options on as a test's starting point: no line of their own, no calls.
  vm.on = (...keys) => { for (const k of keys) vm.run(`NS.QoL.Set("${k}", true, true)`); vm.run('QS.calls = {}; STUB.chat = {}'); return vm; };
  vm.reset = () => vm.run('QS.Reset()');
  vm.q = (lua) => vm.run(`local q = QS.q; ${lua}`);
  vm.said = (text) => vm.chatLines().filter(l => l === B + text).length;
  return vm;
}
// A body of Lua values for a quest item: { name, id, link, count, usable }.
const item = (id, name, extra = '') => `{ name = ${lstr(name)}, id = ${id}, link = "|cffffffff|Hitem:${id}::::::::20:::::|h[${name}]|h|r"${extra ? ', ' + extra : ''} }`;
const LEFT = (option, quest, why) => `${option} left ${quest} to you because ${why}.`;
// The page of a quest the game took itself: nothing was left undone (QC-12).
const GAME = quest => `The game already added ${quest} to your quest log, so Auto Accept Quests has nothing to do. Click Accept to close its page.`;

// ---------------------------------------------------------------------------
// Off to start; events only while an option needs them
// ---------------------------------------------------------------------------

test('the addon\'s own options are off to start: none on, no event registered, a quest giver and a vendor get no help', () => {
  const vm = world();
  for (const k of ['qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk', 'qolRepair']) {
    assert.equal(vm.evaluate(`NQADB.settings.${k}`), 'false', k);
  }
  assert.equal(vm.evaluate('NQADB.settings.qolShared'), null, 'no option for another player\'s share');
  assert.equal(vm.evaluate('NQADB.settings.qolRewards'), 'you');
  assert.deepEqual(Object.keys(vm.json('NS.QoL.frame.events') || {}), [], 'nothing listens while every option is off');
  assert.equal(vm.evaluate('NS.QoL.frame.scripts.OnUpdate'), null, 'nothing polls');
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.run('QS.g.available = { { questID = 5, title = "One", isTrivial = false, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  vm.run('QS.m.junk = 3; QS.m.cost = 500');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '0', 'the game\'s Auto Loot is left as it was');
  assert.equal(vm.evaluate('STUB.cvars.autoQuestWatch'), '1', 'and its quest tracking, on by the game\'s default');
});

test('events: each option registers only what it needs, and turning it off unregisters them', () => {
  const vm = world();
  const events = () => Object.keys(vm.json('NS.QoL.frame.events') || {}).sort();
  vm.on('qolAccept');
  // The hand-in's two pages too: Shift there, and the quest it frees, count for the follow-up the game chains to it.
  assert.deepEqual(events(), ['GOSSIP_CLOSED', 'GOSSIP_SHOW', 'QUEST_COMPLETE', 'QUEST_DETAIL', 'QUEST_FINISHED', 'QUEST_GREETING', 'QUEST_PROGRESS']);
  vm.run('NS.QoL.Set("qolAccept", false)');
  assert.deepEqual(events(), []);
  vm.on('qolTurnIn');
  assert.deepEqual(events(), ['GOSSIP_CLOSED', 'GOSSIP_SHOW', 'QUEST_COMPLETE', 'QUEST_FINISHED', 'QUEST_GREETING', 'QUEST_PROGRESS']);
  vm.run('NS.QoL.Set("qolTurnIn", false)');
  vm.on('qolJunk');
  assert.deepEqual(events(), ['GOSSIP_CLOSED', 'GOSSIP_SHOW', 'MERCHANT_CLOSED', 'MERCHANT_SHOW'], 'a vendor\'s greeting too: Shift there counts');
  vm.run('NS.QoL.Set("qolJunk", false)');
  vm.on('loot', 'track');
  assert.deepEqual(events(), [], 'the game\'s own two need no event of ours');
});

// ---------------------------------------------------------------------------
// Auto Accept Quests
// ---------------------------------------------------------------------------

test('Auto Accept Quests: a quest giver\'s quest is accepted once; off, with Shift held, or while away, it waits; the line waits for the game\'s QUEST_ACCEPTED', () => {
  const vm = world().on('qolAccept');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
  assert.deepEqual(vm.list('NS.QoL.Last()'), [], 'nothing said before the server confirms');
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ACCEPTED'), 'true');
  vm.fire('QUEST_ACCEPTED', 871);
  assert.deepEqual(vm.list('NS.QoL.Last()'), ['Auto Accept Quests accepted Disrupt the Attacks.']);
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ACCEPTED'), null, 'and stops listening');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'one accept per quest per conversation');
  vm.fire('QUEST_FINISHED');
  vm.advance(1);
  vm.run('QS.calls = {}; STUB.shift = true');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'Shift held: by hand');
  vm.run('STUB.shift = false');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'the rest of that conversation stays yours');
  vm.fire('QUEST_FINISHED');
  vm.advance(1);
  vm.run('QS.afk = true');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'away from the keyboard: nothing');
  vm.run('QS.afk = false; NS.QoL.Set("qolAccept", false); QS.calls = {}');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'off');
});

test('Auto Accept Quests: the game\'s own kinds, and low-level, group, dungeon, raid, PvP, escort and timed quests, and a full log, are left to you, saying why once', () => {
  const cases = [
    ['an item\'s quest (the tracker\'s pop-up)', '', 12345, null],
    // Its page has no Decline and waits for a click on Accept, which only closes it (QuestFrame.lua:551-589).
    ['one the game already took itself', 'q.autoAccept = true', 0, GAME('Disrupt the Attacks')],
    ['a zone\'s (the game took it: the tracker\'s pop-up)', 'q.autoAccept = true; q.areaTrigger = true', 0, null],
    ['a zone\'s', 'q.areaTrigger = true', 0, null],
    ['the adventure map\'s', 'q.adventure = true', 0, null],
    ['PvP', 'q.pvp = true', 0, 'it flags you for PvP'],
    ['a suggested group of 3', 'q.group = 3', 0, 'it\'s a group quest'],
    ['tagged Group', 'q.tag = 1', 0, 'it\'s a group quest'],
    ['tagged Dungeon', 'q.tag = 81', 0, 'it\'s a dungeon quest'],
    ['tagged Raid', 'q.tag = 62', 0, 'it\'s a raid quest'],
    ['tagged PvP', 'q.tag = 41', 0, 'it\'s a PvP quest'],
    ['tagged Escort', 'q.tag = 84', 0, 'it\'s an escort quest'],
    ['an escort by its objectives (no tag)', 'q.objectives = "Escort Gilthares Firebough back to Ratchet."', 0, 'it\'s an escort quest'],
    ['with a time limit', 'q.timer = 900', 0, 'it has a time limit'],
    ['low-level', 'q.trivial = true', 0, 'it\'s a low-level quest'],
    ['with the log full', 'QS.logCount = 20', 0, 'your quest log is full'],
  ];
  for (const [what, lua, startItem, why] of cases) {
    const vm = world().on('qolAccept');
    vm.q(lua);
    vm.fire('QUEST_DETAIL', startItem);
    assert.deepEqual(vm.calls(), [], what);
    const said = vm.chatLines().filter(l => l.includes('Disrupt the Attacks'));
    // A why, or a whole line (one that ends with its period).
    if (why) assert.deepEqual(said, [B + (why.endsWith('.') ? why : LEFT('Auto Accept Quests', 'Disrupt the Attacks', why))], what);
    else assert.deepEqual(said, [], `${what}: the game's own, nothing to say`);
    // The same quest giver again: said once a session.
    vm.fire('QUEST_FINISHED');
    vm.fire('QUEST_DETAIL', startItem);
    assert.equal(vm.chatLines().filter(l => l.includes('Disrupt the Attacks')).length, why ? 1 : 0, `${what}: once`);
  }
  // A class quest, a profession quest or a repeatable is accepted like any other.
  const vm = world().on('qolAccept');
  vm.q('q.repeatable = true; q.tag = 21');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
});

test('Auto Accept Quests: a full log is the game\'s real cap (ns.QuestLogMax), never the stale MAX_QUESTS: without GetMaxNumQuestsCanAccept, 25 quests on Forever (cap 40) isn\'t full', () => {
  const accept = (lua) => {
    const vm = world().on('qolAccept');
    vm.run(`C_QuestLog.GetMaxNumQuestsCanAccept = nil; MAX_QUESTS = 25; ${lua}`);
    vm.fire('QUEST_DETAIL', 0);
    return vm.calls();
  };
  assert.deepEqual(accept('QS.logCount = 25'), ['AcceptQuest'], 'the fallback cap, 40: 25 is room to spare');
  assert.deepEqual(accept('QS.logCount = 25; Constants = { QuestLogConsts = { MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT = 40 } }'), ['AcceptQuest'], 'Forever\'s own constant');
  assert.deepEqual(accept('QS.logCount = 40'), [], 'full at 40');
  assert.deepEqual(accept('QS.logCount = 35; C_QuestLog.GetMaxNumQuestsCanAccept = function() return 35 end'), [], 'the API first when it answers');
  // The quests in the log, as ns.QuestLog reads them (the critic's r2 QL-F-12): a hidden quest the
  // game's count takes in isn't one, so 39 quests and a hidden one aren't a full log of 40.
  const LOG = `C_QuestLog.GetMaxNumQuestsCanAccept = function() return 40 end
    C_QuestLog.GetInfo = function(i) if i > QS.logCount + 2 then return nil end
      if i <= 2 then return { isHeader = true, title = "Zone " .. i } end
      return { questID = 1000 + i, isHidden = i == 3 } end`;
  assert.deepEqual(accept(`QS.logCount = 40; ${LOG}`), ['AcceptQuest'], '39 quests and a hidden one');
  assert.deepEqual(accept(`QS.logCount = 41; ${LOG}`), [], '40 quests and a hidden one: full');
});

test('a quest whose acceptance starts something is never taken, whatever its tag, objectives or timer say: one from each of the list\'s sources', () => {
  for (const [id, title, why] of [
    [648, 'Rescue OOX-17/TN!', 'it\'s an escort quest'], // an accept hook's escort
    [6523, 'Protect Kaya', 'it\'s an escort quest'],
    [898, 'Free From the Hold', 'it\'s an escort quest'],
    [590, 'A Rogue\'s Deal', 'accepting it starts a fight'], // an accept hook: Calvin attacks
    [1640, 'Beat Bartleby', 'accepting it starts a fight'],
    [1447, 'The Missing Diplomat', 'accepting it starts a fight'], // a hook and a start script: two thugs
    [68, 'The Legend of Stalvan', 'accepting it starts a fight'], // a start script: a spirit attacks
    [1651, 'The Tome of Valor', 'accepting it starts a fight'], // reviewed: waves of Defias
    [6622, 'Triage', 'accepting it starts something right away'], // an accept hook's event
    [434, 'The Attack!', 'accepting it starts something right away'], // reviewed: a walk and a talk
    [5162, 'Wrath of the Blue Flight', 'accepting it starts a flight'], // reviewed: a cast, then a teleport
    [1149, 'Test of Faith', 'accepting it teleports you'], // the quest's own spell on accepting teleports you
    [3364, 'Scalding Mornbrew Delivery', 'it has a time limit'], // the data's time limit, with no timer on the page
  ]) {
    const vm = world().on('qolAccept');
    vm.q(`q.id = ${id}; q.title = ${lstr(title)}; q.objectives = "Speak with Jeziba in the Plaguelands."`);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), [], title);
    assert.equal(vm.said(LEFT('Auto Accept Quests', title, why)), 1, `${title}\n${vm.chatLines().join('\n')}`);
  }
});

// The lists come from the emulator's data (tools/qol-quests), never by hand. The generator and its
// facts (extracts of cmangos classic-db, mangos-classic and wago.tools) go with the source export
// (tools/shell-tree.mjs); a tree that holds QoL.lua with its lists and this file, not them, skips these
// two tests and runs the rest (TRF-SYS-05).
const GENERATOR = new URL('../tools/qol-quests/generate.mjs', import.meta.url);
const gen = fs.existsSync(GENERATOR) ? await import(GENERATOR.href) : null;
const NO_GENERATOR = gen ? false : 'this tree has QoL.lua\'s lists, not their generator and its facts (tools/qol-quests)';

test('STARTS and HANDIN are generate.mjs\'s output from the emulator\'s data and its review, not a hand-kept list; every quest with a time limit is in STARTS', { skip: NO_GENERATOR }, () => {
  const { facts, review } = gen.load();
  const lua = fs.readFileSync(gen.LUA, 'utf8');
  assert.equal(gen.splice(lua, gen.render(facts, review)), lua, 'QoL.lua\'s block is exactly what generate.mjs writes (run node tools/qol-quests/generate.mjs)');
  const lists = gen.lists(facts, review);
  const vm = world();
  const inGame = name => new Map(vm.json(`(function() local o = {} for id, kind in pairs(NS.QoL.${name}) do o[#o + 1] = id .. ":" .. kind end return o end)()`)
    .map(s => s.split(':')).map(([id, kind]) => [Number(id), kind]));
  assert.deepEqual(inGame('STARTS'), new Map([...lists.accept].map(([id, v]) => [id, v.kind])));
  assert.deepEqual(inGame('HANDIN'), new Map([...lists.handin].map(([id, v]) => [id, v.kind])));
  // Each source, as the data records it.
  const via = (id, side) => facts.quests[id][side].map(e => e.via);
  assert.ok(via(590, 'accept').includes('accept hook'));
  assert.ok(via(1447, 'accept').includes('accept hook') && via(1447, 'accept').includes('start script'));
  assert.ok(facts.quests[68].accept.some(e => e.do === 'attack'));
  assert.ok(facts.quests[502].handin.some(e => e.do === 'faction' && e.hostile), 'Stanley turns hostile');
  assert.ok(facts.quests[5059].handin.some(e => e.do === 'summon' && e.hostile), 'Farmer Dalson');
  assert.ok(facts.quests[7786].handin.some(e => e.do === 'summon' && e.hostile), 'Prince Thunderaan');
  // Every time limit in the data (QL-17), whatever else the quest starts.
  const timed = Object.entries(facts.quests).filter(([, q]) => q.limit > 0).map(([id]) => Number(id));
  assert.equal(timed.length, 29);
  for (const id of timed) assert.ok(lists.accept.has(id), `${id} ${facts.quests[id].title}`);
  assert.ok([...lists.accept.values()].every(v => ['escort', 'fight', 'flight', 'moves', 'event', 'timed'].includes(v.kind)));
  assert.ok([...lists.handin.values()].every(v => ['fight', 'flight', 'moves'].includes(v.kind)));
  // The quests that move you (QL-30): a spell the quest casts, or its script's.
  assert.deepEqual([...lists.accept].filter(([, v]) => v.kind === 'moves').map(([id]) => id), [1149]);
  assert.deepEqual([...lists.handin].filter(([, v]) => v.kind === 'moves').map(([id]) => id).sort((a, b) => a - b), [3421, 3503, 3567, 8250]);
  // Each kind has its own line.
  for (const kind of ['escort', 'fight', 'flight', 'moves', 'event', 'timed']) {
    assert.match(lua, new RegExp(`\\n\\t\\t${kind} = "Auto Accept Quests left %s to you because`), kind);
  }
  for (const kind of ['fight', 'flight', 'moves']) {
    assert.match(lua, new RegExp(`\\n\\t\\t${kind} = "Auto Turn In Quests left %s to you because`), kind);
  }
});

test('generate.mjs refuses a review that repeats the rules, one for a quest the data no longer has, one without its why, and a title that could end its comment', { skip: NO_GENERATOR }, () => {
  const { facts, review } = gen.load();
  assert.throws(() => gen.lists(facts, { ...review, accept: { ...review.accept, 590: { kind: 'fight', why: 'Calvin attacks.' } } }), /already say/);
  assert.throws(() => gen.lists(facts, { ...review, accept: { ...review.accept, 9446: { kind: 'escort', why: 'Truuen.' } } }), /not in cmangos\.json/);
  assert.throws(() => gen.lists(facts, { ...review, handin: { ...review.handin, 1371: { kind: 'none' } } }), /needs its why/);
  assert.throws(() => gen.lists(facts, { ...review, accept: { ...review.accept, 590: { kind: 'brawl', why: 'x' } } }), /unknown kind/);
  // A title is written into a Lua comment: a line break in the data would end it and run the rest as code.
  const bad = structuredClone(facts);
  bad.quests[590].title = 'A Rogue\'s Deal\nNS.QoL.STARTS = {}';
  assert.throws(() => gen.render(bad, review), /control character/);
});

// ---------------------------------------------------------------------------
// Another player's share: it opens without this player's click
// ---------------------------------------------------------------------------

test('a quest another player shares is never accepted, a friend\'s or a stranger\'s, with every option on; nothing is said', () => {
  for (const who of ['friend = true', 'bnet = true', 'guild = true', '']) {
    const vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk', 'qolRepair');
    vm.run(`QS.sharer = { guid = "Player-1-00000B0B", grouped = true, ${who} }`);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), [], who || 'a stranger');
    assert.deepEqual(vm.chatLines(), [], who || 'a stranger');
  }
  const code = fs.readFileSync(path.join(ADDON, 'QoL.lua'), 'utf8');
  assert.doesNotMatch(code, /qolShared|IsGUIDInGroup|IsGuildMember|C_FriendList|C_BattleNet/, 'no share option, and no reading of friends or guilds');
});

test('an escort another player starts (the game\'s "wants to start" question) is never answered', () => {
  const vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
  vm.fire('QUEST_ACCEPT_CONFIRM', '"Grom"', '"Free From the Hold"', 898);
  assert.deepEqual(vm.calls(), []);
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// ---------------------------------------------------------------------------
// Auto Turn In Quests
// ---------------------------------------------------------------------------

test('Auto Turn In Quests: Continue when done and nothing is taken but quest items; gold, a currency or other items wait for you', () => {
  // Done, nothing taken.
  let vm = world().on('qolTurnIn');
  vm.fire('QUEST_PROGRESS');
  assert.deepEqual(vm.calls(), ['CompleteQuest']);
  // Not done yet: nothing to continue.
  vm = world().on('qolTurnIn');
  vm.q('q.completable = false');
  vm.fire('QUEST_PROGRESS');
  assert.deepEqual(vm.calls(), []);
  // Quest items only.
  vm = world().on('qolTurnIn');
  vm.run(`QS.items[4760] = { classID = 12 }; QS.q.required = { ${item(4760, 'Sparkleshell Crab Claw')} }`);
  vm.fire('QUEST_PROGRESS');
  assert.deepEqual(vm.calls(), ['CompleteQuest']);
  // Gold, a currency, cloth: yours.
  for (const [lua, why] of [
    ['QS.q.money = 2000', 'handing it in costs gold'],
    ['QS.q.currencies = 1', 'handing it in costs a currency'],
    [`QS.items[2589] = { classID = 7 }; QS.q.required = { ${item(2589, 'Linen Cloth', 'count = 20')} }`, 'it takes items that aren\'t quest items'],
  ]) {
    vm = world().on('qolTurnIn');
    vm.run(lua);
    vm.fire('QUEST_PROGRESS');
    assert.deepEqual(vm.calls(), [], why);
    assert.equal(vm.said(LEFT('Auto Turn In Quests', 'Disrupt the Attacks', why)), 1, why);
    // Its reward page is yours too, after you press Continue yourself.
    vm.run('QS.q.money = 0; QS.q.currencies = 0');
    vm.fire('QUEST_COMPLETE');
    assert.deepEqual(vm.calls(), [], `${why}: the reward page waits too`);
  }
});

test('Auto Turn In Quests: a repeatable, a daily or a weekly that takes items waits; one that takes nothing is handed in', () => {
  for (const lua of ['QS.q.repeatable = true', 'QS.q.frequency = 1', 'QS.q.frequency = 2']) {
    let vm = world().on('qolTurnIn');
    vm.run(`${lua}; QS.items[12840] = { classID = 12 }; QS.q.required = { ${item(12840, 'Minion\'s Scourgestone', 'count = 20')} }`);
    vm.fire('QUEST_PROGRESS');
    assert.deepEqual(vm.calls(), [], lua);
    assert.equal(vm.said(LEFT('Auto Turn In Quests', 'Disrupt the Attacks', 'it\'s repeatable and takes items')), 1, lua);
    vm = world().on('qolTurnIn');
    vm.run(lua);
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    assert.deepEqual(vm.calls(), ['CompleteQuest', 'GetQuestReward 0'], `${lua}, nothing taken`);
  }
});

test('Auto Turn In Quests leaves a quest whose hand-in starts a fight, at its progress page or straight at its reward page: Stranglethorn Fever, and one from each way the data shows it', () => {
  for (const [id, title, why] of [
    [502, 'Elixir of Pain'], // an end script turns Stanley hostile
    [5059, 'Locked Away'], // an end script summons Farmer Dalson
    [7786, 'Thunderaan the Windseeker'], // an end script summons a raid boss
    [254, 'Digging Through the Dirt'],
    [3567, 'To the Top', 'teleports you'], // an end script's spell teleports you
    [3503, 'Meeting with the Master', 'teleports you'], // the quest's own reward spell does
  ]) {
    const line = LEFT('Auto Turn In Quests', title, `handing it in ${why || 'starts a fight'}`);
    for (const pages of [['QUEST_PROGRESS', 'QUEST_COMPLETE'], ['QUEST_COMPLETE']]) {
      const vm = world().on('qolTurnIn');
      vm.run(`QS.q.id = ${id}; QS.q.title = ${lstr(title)}`);
      for (const page of pages) vm.fire(page);
      assert.deepEqual(vm.calls(), [], `${title}: ${pages.join(', ')}`);
      assert.equal(vm.said(line), 1, title);
    }
  }
  const line = LEFT('Auto Turn In Quests', 'Stranglethorn Fever', 'handing it in starts a fight');
  let vm = world().on('qolTurnIn');
  vm.run(`QS.q.id = 349; QS.q.title = "Stranglethorn Fever"; QS.items[2799] = { classID = 12 }; QS.q.required = { ${item(2799, 'Gorilla Fang', 'count = 10')} }`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), [], 'neither Continue nor the reward');
  assert.equal(vm.said(line), 1);
  vm = world().on('qolTurnIn');
  vm.run('QS.q.id = 349; QS.q.title = "Stranglethorn Fever"');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), [], 'no progress page: the reward page waits too');
  assert.equal(vm.said(line), 1);
  assert.equal(vm.evaluate('NS.QoL.HANDIN[349]'), 'fight');
});

test('the reward page: none or one reward is taken; gold, several with Your Pick, or bags without room wait for you', () => {
  let vm = world().on('qolTurnIn');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 0'], 'nothing to choose: index 0, as QuestInfo.lua:1056 starts it');
  assert.deepEqual(vm.list('NS.QoL.Last()'), [], 'said when the game confirms it');
  vm.fire('QUEST_TURNED_IN', 871, 450, 0);
  assert.deepEqual(vm.list('NS.QoL.Last()'), ['Auto Turn In Quests handed in Disrupt the Attacks.']);
  vm = world().on('qolTurnIn');
  vm.run(`QS.q.choices = { ${item(6150, 'A Frayed Knot')} }`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 1'], 'the only choice (QuestFrame.lua:148-150)');
  vm = world().on('qolTurnIn');
  vm.run('QS.q.money = 5000');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), [], 'the game asks before you pay (CONFIRM_COMPLETE_EXPENSIVE_QUEST): never skipped');
  vm = world().on('qolTurnIn');
  vm.run(`QS.q.choices = { ${item(6150, 'A Frayed Knot')}, ${item(6151, 'Chipped Stone')} }`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), [], 'Your Pick: yours');
  // Short of room: a reward and a choice need 2 free slots.
  vm = world().on('qolTurnIn');
  vm.run(`QS.free = { [0] = 1 }; QS.q.rewards = 1; QS.q.choices = { ${item(6150, 'A Frayed Knot')} }`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  const bags = LEFT('Auto Turn In Quests', 'Disrupt the Attacks', 'your bags don\'t have room for its rewards').replace(/\.$/, '. Make room, then click Complete Quest.');
  assert.equal(vm.said(bags), 1, vm.chatLines().join('\n'));
  vm.fire('QUEST_COMPLETE');
  assert.equal(vm.said(bags), 1, 'said once');
  // Room in a quiver doesn't count.
  vm = world().on('qolTurnIn');
  vm.run('QS.free = { [0] = 0, [1] = 16 }; QS.q.rewards = 1');
  vm.run('C_Container.GetContainerNumFreeSlots = function(bag) if bag == 1 then return 16, 1 end return 0, 0 end');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  // Shift: yours.
  vm = world().on('qolTurnIn');
  vm.run('STUB.shift = true');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
});

// ---------------------------------------------------------------------------
// Quest Rewards: a rule you pick, never a silent guess
// ---------------------------------------------------------------------------

test('Quest Rewards, Highest Price: the one worth the most (price times how many); a tie or nothing sellable is yours', () => {
  const choices = `QS.q.choices = { ${item(101, 'Rugged Boots')}, ${item(102, 'Healing Potion', 'count = 5')}, ${item(103, 'Iron Ring')} }`;
  let vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); ${choices}; QS.prices[101] = 150; QS.prices[102] = 40; QS.prices[103] = 120`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 2'], '5 potions at 40c beat boots at 1s 50c');
  const took = 'Quest Rewards took Healing Potion, which has the highest sell price (2s), as the reward for Disrupt the Attacks.';
  assert.equal(vm.said(took), 0, 'not before the game confirms it');
  vm.fire('QUEST_TURNED_IN', 871, 450, 0);
  assert.equal(vm.said(took), 1, vm.chatLines().join('\n'));
  vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); ${choices}; QS.prices[101] = 200; QS.prices[102] = 40; QS.prices[103] = 120`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said('Quest Rewards left the choice for Disrupt the Attacks to you because two of its rewards have the same sell price.'), 1);
  vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); ${choices}; QS.prices[101] = 0; QS.prices[102] = 0; QS.prices[103] = 0`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said('Quest Rewards left the choice for Disrupt the Attacks to you because none of its rewards has a sell price.'), 1);
});

test('Quest Rewards: a reward not loaded yet waits for the game\'s QUEST_ITEM_UPDATE, once, then picks or says why', () => {
  const choices = `QS.q.choices = { ${item(101, 'Rugged Boots')}, ${item(103, 'Iron Ring')} }`;
  let vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); ${choices}; QS.prices[101] = 150`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ITEM_UPDATE'), 'true', 'it waits for the data');
  vm.run('QS.prices[103] = 120');
  vm.fire('QUEST_ITEM_UPDATE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 1']);
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ITEM_UPDATE'), null, 'and stops listening');
  // Still missing after the update: yours, and it says so.
  vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); ${choices}; QS.prices[101] = 150`);
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_ITEM_UPDATE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said('Quest Rewards left the choice for Disrupt the Attacks to you because some of its rewards haven\'t loaded yet.'), 1);
});

const PICK_SETUP = `
    NS.QoL.SetRewards("bones")
    QS.items[201] = { equipLoc = "INVTYPE_FEET", stats = { ITEM_MOD_STRENGTH_SHORT = 5 } }
    QS.items[202] = { equipLoc = "INVTYPE_FINGER", stats = { ITEM_MOD_STRENGTH_SHORT = 9 } }
    QS.items[203] = { equipLoc = "INVTYPE_CLOAK", stats = { ITEM_MOD_INTELLECT_SHORT = 12 } }
    QS.items[301] = { equipLoc = "INVTYPE_FEET", stats = { ITEM_MOD_STRENGTH_SHORT = 1 } }
    QS.items[302] = { equipLoc = "INVTYPE_FINGER", stats = { ITEM_MOD_STRENGTH_SHORT = 8 } }
    QS.items[303] = { equipLoc = "INVTYPE_FINGER", stats = { ITEM_MOD_STRENGTH_SHORT = 7 } }
    QS.worn[8] = "|cffffffff|Hitem:301::::::::20:::::|h[Old Boots]|h|r"
    QS.worn[11] = "|cffffffff|Hitem:302::::::::20:::::|h[Ring A]|h|r"
    QS.worn[12] = "|cffffffff|Hitem:303::::::::20:::::|h[Ring B]|h|r"
    QS.q.choices = { ${item(201, 'Rugged Boots')}, ${item(202, 'Iron Ring')}, ${item(203, 'Mage Cloak')} }`;

test('Quest Rewards, Best Upgrade: the biggest upgrade over what you wear by NeverQuestAlone\'s stat weights; no weights, no upgrade or a tie is yours', () => {
  const pickFor = why => `Quest Rewards left the choice for Disrupt the Attacks to you because ${why}.`;
  // No weights for this character yet.
  let vm = world().on('qolTurnIn');
  vm.run(PICK_SETUP);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said(pickFor('NeverQuestAlone has no stat weights for this character yet')), 1);
  // Weights: boots +4 (5 over 1), the ring +2 over the weaker ring (9 over 7), the cloak 0 (no intellect weight).
  vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { str = 1 }`);
  const outbox = vm.outboxWires().length;
  vm.run('NS.R.out = NS.R.out or {}; OUT_KEYS = 0; for _ in pairs(NS.R.out) do OUT_KEYS = OUT_KEYS + 1 end');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 1']);
  vm.fire('QUEST_TURNED_IN', 871, 450, 0);
  assert.equal(vm.said('Quest Rewards took Rugged Boots, the best upgrade for your build, as the reward for Disrupt the Attacks.'), 1, vm.chatLines().join('\n'));
  // Decided here from the weights NeverQuestAlone already sent: no message, no turn, nothing waited on.
  assert.equal(vm.outboxWires().length, outbox, 'nothing queued for NeverQuestAlone');
  assert.equal(vm.num('(function() local n = 0 for _ in pairs(NS.R.out) do n = n + 1 end return n end)()'), vm.num('OUT_KEYS'), 'nothing on the strip');
  assert.equal(vm.evaluate('NS.Chats.IsBusy(NS.Chats.Active())'), 'false', 'no turn started');
  // One you can't use is never picked.
  vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { str = 1 }; QS.q.choices[1].usable = false`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 2'], 'the ring, the only upgrade you can use');
  // None is an upgrade.
  vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { int = 1 }; QS.worn[15] = "|cffffffff|Hitem:304::::::::20:::::|h[Big Cloak]|h|r"; QS.items[304] = { equipLoc = "INVTYPE_CLOAK", stats = { ITEM_MOD_INTELLECT_SHORT = 20 } }`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said(pickFor('none of its rewards is an upgrade for your build')), 1);
  // A tie.
  vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { str = 1 }; QS.items[201].stats.ITEM_MOD_STRENGTH_SHORT = 3`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said(pickFor('two of its rewards are equally good for your build')), 1);
});

test('Quest Rewards, Best Upgrade: a reward you can use whose stats haven\'t loaded is never counted as no upgrade: it waits once, then picks or leaves it to you', () => {
  // The boots' stats land with the game's QUEST_ITEM_UPDATE: then they're the pick.
  let vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { str = 1 }; BOOTS = QS.items[201].stats; QS.items[201].stats = nil`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), [], 'not the ring: the boots may be better');
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ITEM_UPDATE'), 'true');
  vm.run('QS.items[201].stats = BOOTS');
  vm.fire('QUEST_ITEM_UPDATE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 1']);
  // Still not loaded: yours, and it says why.
  vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { str = 1 }; QS.items[201].stats = nil`);
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_ITEM_UPDATE');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said('Quest Rewards left the choice for Disrupt the Attacks to you because some of its rewards haven\'t loaded yet.'), 1);
  // One you can't use needs no stats: the ring is picked at once.
  vm = world().on('qolTurnIn');
  vm.run(`${PICK_SETUP}; NQADB.weights[NS.CharKey()] = { str = 1 }; QS.items[201].stats = nil; QS.q.choices[1].usable = false`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 2']);
});

// ---------------------------------------------------------------------------
// Auto Skip to Quests
// ---------------------------------------------------------------------------

test('Auto Skip to Quests: a greeting with only quests opens a finished one first, else the only new one; never a gossip option', () => {
  let vm = world().on('qolSkip');
  vm.run(`QS.g.active = { { questID = 766, title = "Swoop Hunting", isComplete = true, isIgnored = false }, { questID = 871, title = "Disrupt", isComplete = false, isIgnored = false } }
    QS.g.available = { { questID = 872, title = "New", isTrivial = false, isIgnored = false } }`);
  vm.fire('GOSSIP_SHOW');
  assert.deepEqual(vm.calls(), ['SelectActiveQuest 766'], 'a finished quest first');
  vm = world().on('qolSkip');
  vm.run('QS.g.active = { { questID = 871, title = "Disrupt", isComplete = false, isIgnored = false } }; QS.g.available = { { questID = 872, title = "New", isTrivial = false, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  assert.deepEqual(vm.calls(), ['SelectAvailableQuest 872'], 'the only new one, past one still in progress');
  for (const [what, lua] of [
    ['two new ones: your pick', 'QS.g.available = { { questID = 1, isTrivial = false, isIgnored = false }, { questID = 2, isTrivial = false, isIgnored = false } }'],
    ['a low-level one', 'QS.g.available = { { questID = 1, isTrivial = true, isIgnored = false } }'],
    ['an ignored one', 'QS.g.available = { { questID = 1, isTrivial = false, isIgnored = true } }'],
    ['a vendor with a quest (a service to pick)', 'QS.g.options = { { name = "Let me browse your goods.", orderIndex = 1, gossipOptionID = 11 } }; QS.g.active = { { questID = 766, isComplete = true, isIgnored = false } }'],
    ['a greeting the game wants read', 'QS.g.force = true; QS.g.available = { { questID = 1, isTrivial = false, isIgnored = false } }'],
  ]) {
    vm = world().on('qolSkip');
    vm.run(lua);
    vm.fire('GOSSIP_SHOW');
    assert.deepEqual(vm.calls(), [], what);
  }
  // One pick per quest per conversation, even if the greeting comes back.
  vm = world().on('qolSkip');
  vm.run('QS.g.active = { { questID = 766, isComplete = true, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_SHOW');
  assert.deepEqual(vm.calls(), ['SelectActiveQuest 766']);
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('an NPC whose identity the game keeps secret (70009: UnitGUID is SecretWhenUnitIdentityRestricted, as in a fight) is still one conversation, and nothing compares or tests the secret', () => {
  // A fresh secret each call, as the game's: comparing two of them raises, as it does in the game.
  // Whether the quest giver is a player: a secret too (only an NPC's can be one), which the stub
  // can't make raise in a truth test, so the accept going through is the check.
  const vm = world({ extra: `
local realGUID = UnitGUID
function UnitGUID(u) if u == "npc" or (u == "questnpc" and not QS.sharer) then return STUB.Secret("Creature-0-1-2-3-3139-0000") end return realGUID(u) end
local realIsPlayer = UnitIsPlayer
function UnitIsPlayer(u) if u == "questnpc" and not QS.sharer then return STUB.Secret(false) end return realIsPlayer(u) end
` }).on('qolSkip', 'qolAccept');
  vm.run('QS.g.available = { { questID = 871, title = "Disrupt the Attacks", isTrivial = false, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_SHOW');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['SelectAvailableQuest 871', 'AcceptQuest'], 'one pick for the conversation, and its quest accepted');
  vm.fire('QUEST_FINISHED');
  vm.reset();
  vm.run('QS.g.available = { { questID = 872, title = "New", isTrivial = false, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  assert.deepEqual(vm.calls(), ['SelectAvailableQuest 872'], 'the next conversation starts fresh');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('Auto Skip to Quests: the quest greeting (an NPC with only quests) by its own numbering', () => {
  let vm = world().on('qolSkip');
  vm.run('QS.greet.active = { { title = "A", complete = false, id = 1 }, { title = "B", complete = true, id = 2 } }; QS.greet.available = { { id = 3, trivial = false } }');
  vm.fire('QUEST_GREETING');
  assert.deepEqual(vm.calls(), ['GreetingActive 2']);
  vm = world().on('qolSkip');
  vm.run('QS.greet.available = { { id = 3, trivial = false } }');
  vm.fire('QUEST_GREETING');
  assert.deepEqual(vm.calls(), ['GreetingAvailable 1']);
  vm = world().on('qolSkip');
  vm.run('QS.greet.available = { { id = 3, trivial = false }, { id = 4, trivial = false } }');
  vm.fire('QUEST_GREETING');
  assert.deepEqual(vm.calls(), [], 'two: your pick');
  vm = world().on('qolSkip');
  vm.run('QS.greet.available = { { id = 3, trivial = true } }');
  vm.fire('QUEST_GREETING');
  assert.deepEqual(vm.calls(), [], 'low-level: yours');
});

// ---------------------------------------------------------------------------
// By hand: Shift for the whole conversation, and the page it chains to
// ---------------------------------------------------------------------------

test('Shift held at the greeting keeps the whole conversation yours, even with Auto Skip to Quests off; a later one starts fresh', () => {
  const vm = world().on('qolAccept');
  vm.run('STUB.shift = true');
  vm.fire('GOSSIP_SHOW');
  vm.run('STUB.shift = false');
  vm.fire('GOSSIP_CLOSED', 'true'); // the greeting hands over to the quest page: the same conversation
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'Shift at the greeting counts for the quest page it opened');
  vm.fire('QUEST_FINISHED');
  vm.advance(1);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'a later conversation is the options\' again');
  vm.run('QS.calls = {}; QS.q.id = 900; STUB.shift = true');
  vm.fire('GOSSIP_SHOW');
  vm.run('STUB.shift = false');
  vm.fire('GOSSIP_CLOSED', 'false');
  vm.advance(1);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'a greeting closed for good ends that conversation');
});

test('Shift at a hand-in keeps the follow-up the game opens as it closes yours too (within half a second); one after that is the options\' again', () => {
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.run('STUB.shift = true');
  vm.fire('QUEST_PROGRESS');
  vm.run('STUB.shift = false');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), [], 'the hand-in, by hand');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.q.id = 872; QS.q.title = "Follow-Up"');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'the follow-up the game chained to it');
  vm.fire('QUEST_FINISHED');
  vm.advance(1);
  vm.run('QS.q.id = 873; QS.q.title = "Another"');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
});

test('a new conversation starts fresh: Shift at one quest giver never carries to another, even when the game\'s close went unheard', () => {
  const npc = 'QS.npc = "Creature-0-1-1-1-1-0000000A"; local guid = UnitGUID; function UnitGUID(u) if u == "npc" then return QS.npc end return guid(u) end';
  const vm = world({ extra: npc }).on('qolAccept');
  vm.run('STUB.shift = true');
  vm.fire('GOSSIP_SHOW');
  vm.run('STUB.shift = false');
  vm.fire('GOSSIP_CLOSED', 'true');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'the same quest giver\'s page: still yours');
  // No QUEST_FINISHED heard; the next window is someone else's.
  vm.advance(5);
  vm.run('QS.npc = "Creature-0-1-1-1-2-0000000B"; QS.q.id = 900');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
});

test('a line waits only a few seconds for the game: a refused action never later credits the option for what you do by hand', () => {
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
  vm.fire('QUEST_FINISHED');
  // The server refused it; ten minutes on, you accept it by hand.
  vm.advance(600);
  vm.fire('QUEST_ACCEPTED', 871);
  assert.deepEqual(vm.list('NS.QoL.Last()'), [], 'not "Auto Accept Quests accepted …"');
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ACCEPTED'), null, 'and stops listening');
  // Confirmed in time, it's said.
  vm.run('QS.calls = {}; QS.q.id = 900; QS.q.title = "Another"');
  vm.fire('QUEST_DETAIL', 0);
  vm.advance(1);
  vm.fire('QUEST_ACCEPTED', 900);
  assert.deepEqual(vm.list('NS.QoL.Last()'), ['Auto Accept Quests accepted Another.']);
});

test('a line still waiting is dropped when the game refuses, when a new conversation starts, or when its option goes off; nothing waits, nothing is heard', () => {
  const heard = vm => Object.keys(vm.json('NS.QoL.frame.events') || {}).filter(e => /^(QUEST_ACCEPTED|QUEST_TURNED_IN|UI_ERROR_MESSAGE)$/.test(e)).sort();
  // Refused, then accepted by hand at the same quest giver 3 s later: yours.
  let vm = world().on('qolAccept');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
  vm.fire('QUEST_FINISHED');
  vm.advance(3);
  vm.run('STUB.shift = true');
  vm.fire('QUEST_DETAIL', 0);
  vm.run('STUB.shift = false');
  vm.fire('QUEST_ACCEPTED', 871);
  assert.deepEqual(vm.list('NS.QoL.Last()'), [], 'a new conversation: not "Auto Accept Quests accepted …"');
  assert.deepEqual(heard(vm), []);
  // The pick the game refuses (its error message), then yours on the same page 3 s later: yours.
  vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); QS.q.choices = { ${item(101, 'Healing Potion')}, ${item(102, 'Tin Ring')} }; QS.prices[101] = 200; QS.prices[102] = 40`);
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['GetQuestReward 1']);
  assert.deepEqual(heard(vm), ['QUEST_TURNED_IN', 'UI_ERROR_MESSAGE']);
  vm.fire('UI_ERROR_MESSAGE', 3, lstr('Inventory is full.'));
  // The line is gone; only the game's word on the hand-in is still heard, for
  // the quest it would free (a refusal can be another action's, QC-11).
  assert.deepEqual(heard(vm), ['QUEST_TURNED_IN']);
  vm.advance(3);
  vm.fire('QUEST_TURNED_IN', 871);
  assert.deepEqual(vm.chatLines().filter(l => l.includes('Quest Rewards took')), []);
  assert.deepEqual(vm.list('NS.QoL.Last()'), []);
  assert.deepEqual(heard(vm), []);
  // An error that isn't a refusal ("Out of range.") leaves the line: the pick is said once the game confirms it.
  vm = world().on('qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); QS.q.choices = { ${item(101, 'Healing Potion')}, ${item(102, 'Tin Ring')} }; QS.prices[101] = 200; QS.prices[102] = 40`);
  vm.fire('QUEST_COMPLETE');
  vm.fire('UI_ERROR_MESSAGE', 51, 'ERR_OUT_OF_RANGE');
  vm.fire('QUEST_TURNED_IN', 871);
  assert.equal(vm.chatLines().filter(l => l.includes('Quest Rewards took Healing Potion')).length, 1, vm.chatLines().join('\n'));
  // A refusal with the quest's name in it ("%s failed.") drops it.
  vm = world().on('qolAccept');
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('UI_ERROR_MESSAGE', 3, lstr('Disrupt the Attacks failed.'));
  vm.fire('QUEST_ACCEPTED', 871);
  assert.deepEqual(vm.list('NS.QoL.Last()'), []);
  // Nothing confirms: the next thing heard lets it go (no timer; nothing polls).
  vm = world().on('qolAccept');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(heard(vm), ['QUEST_ACCEPTED', 'UI_ERROR_MESSAGE']);
  vm.advance(6);
  vm.fire('QUEST_ACCEPTED', 555);
  assert.deepEqual(heard(vm), []);
  // …and so does any error, a refusal or not (QL-33).
  vm.fire('QUEST_FINISHED');
  vm.advance(1);
  vm.run('QS.q.id = 900; QS.q.title = "Another"');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(heard(vm), ['QUEST_ACCEPTED', 'UI_ERROR_MESSAGE'], 'a line waits');
  vm.advance(6);
  vm.fire('UI_ERROR_MESSAGE', 51, 'ERR_OUT_OF_RANGE');
  assert.deepEqual(heard(vm), [], 'a stale line is let go on the next error');
  // Turned off while a line waits: dropped, and nothing more is heard.
  vm = world().on('qolAccept');
  vm.fire('QUEST_DETAIL', 0);
  vm.run('NS.QoL.Set("qolAccept", false, true)');
  assert.deepEqual(heard(vm), []);
  vm.fire('QUEST_ACCEPTED', 871);
  assert.deepEqual(vm.list('NS.QoL.Last()'), []);
  // The follow-up the game chains to a hand-in (same quest giver, within half a second) keeps the hand-in's line.
  vm = world().on('qolAccept', 'qolTurnIn');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.q.id = 872; QS.q.title = "The Next Step"');
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_TURNED_IN', 871);
  assert.ok(vm.list('NS.QoL.Last()').includes('Auto Turn In Quests handed in Disrupt the Attacks.'), vm.list('NS.QoL.Last()').join(' | '));
});

test('a page from another quest giver within half a second of a reward page\'s close may be one the game opened by itself for that hand-in: it\'s yours', () => {
  const npc = 'QS.npc = "Creature-0-1-1-1-1-0000000A"; local guid = UnitGUID; function UnitGUID(u) if u == "npc" then return QS.npc end return guid(u) end';
  let vm = world({ extra: npc }).on('qolAccept', 'qolTurnIn');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.calls = {}; QS.npc = "Creature-0-1-1-1-2-0000000B"; QS.q.id = 901');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [], 'someone else, right after the hand-in');
  // Why, in /nqa qol last only: nothing waits on a page you opened.
  const other = 'Auto Accept Quests left Disrupt the Attacks to you because its page opened just as another quest giver\'s reward page closed.';
  assert.equal(vm.list('NS.QoL.Last()')[0], other, vm.list('NS.QoL.Last()').join(' | '));
  assert.equal(vm.said(other), 0, 'not in the chat frame');
  // A greeting too (the game can open one by itself); a vendor never opens without your click.
  vm = world({ extra: npc }).on('qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk');
  vm.run('QS.m.junk = 1');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.calls = {}; QS.npc = "Creature-0-1-1-1-2-0000000B"; QS.g.available = { { questID = 900, isTrivial = false, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  assert.deepEqual(vm.calls(), [], 'another NPC\'s greeting right after the hand-in');
  vm = world({ extra: npc }).on('qolAccept', 'qolTurnIn', 'qolJunk');
  vm.run('QS.m.junk = 1');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.calls = {}; QS.npc = "Creature-0-1-1-1-9-0000000C"');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), ['SellAllJunkItems'], 'a vendor right after the hand-in is your click');
  // The same quest giver's follow-up is the chain: taken.
  vm = world({ extra: npc }).on('qolAccept', 'qolTurnIn');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.calls = {}; QS.q.id = 902');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'the same quest giver\'s follow-up');
});

test('all three together: talk to the quest giver once and a finished quest is handed in and its follow-up taken, with no click', () => {
  const vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
  vm.run('QS.g.active = { { questID = 766, isComplete = true, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_CLOSED', 'true');
  vm.run('QS.q.id = 766; QS.q.title = "Swoop Hunting"');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_TURNED_IN', 766, 450, 0);
  vm.fire('QUEST_FINISHED');
  vm.run('QS.q.id = 767; QS.q.title = "Swoop Hunting II"');
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_ACCEPTED', 767);
  assert.deepEqual(vm.calls(), ['SelectActiveQuest 766', 'CompleteQuest', 'GetQuestReward 0', 'AcceptQuest']);
  assert.deepEqual(vm.list('NS.QoL.Last()'), ['Auto Accept Quests accepted Swoop Hunting II.', 'Auto Turn In Quests handed in Swoop Hunting.']);
});

test('all three together never carry you off: a hand-in whose reward teleports you stops at its reward page (To the Top)', () => {
  const vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
  vm.run('QS.g.active = { { questID = 3567, isComplete = true, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_CLOSED', 'true');
  vm.run('QS.q.id = 3567; QS.q.title = "To the Top"');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), ['SelectActiveQuest 3567'], 'Auto Skip opens it; the reward waits for your click');
  assert.equal(vm.said(LEFT('Auto Turn In Quests', 'To the Top', 'handing it in teleports you')), 1);
});

// ---------------------------------------------------------------------------
// The follow-up the game chains to a hand-in (the owner, 0.5.2: "during one of my
// auto turn in quests, it immediately ran into a quest follow up and it didnt
// auto accept it even though the setting was on")
// ---------------------------------------------------------------------------

// The quest giver, as both of the game's units name it; the log at its cap
// (20 of the stub's 20) with the quest being handed in, 871, in it.
const GIVER = 'Creature-0-1-1-1-1-0000000A';
const AT_CAP = `QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"; QS.logCount = 20; QS.log[871] = true`;
// The game's log update for the hand-in: 871 leaves the log.
const LANDED = 'QS.logCount = 19; QS.log[871] = nil';
// The follow-up the game chains to it.
const NEXT = 'QS.q.id = 872; QS.q.title = "The Next Step"';
const HANDED = ['CompleteQuest', 'GetQuestReward 0'];

test('the follow-up the game chains to an auto hand-in is accepted once, whatever the order of its page, the close, the game\'s QUEST_TURNED_IN and the log update, with the log at its cap until the hand-in lands', () => {
  const steps = {
    complete: vm => vm.fire('QUEST_COMPLETE'),
    turnedIn: vm => vm.fire('QUEST_TURNED_IN', 871, 450, 0),
    finished: vm => vm.fire('QUEST_FINISHED'),
    landed: vm => vm.run(LANDED),
    page: vm => { vm.run(NEXT); vm.fire('QUEST_DETAIL', 0); },
    soon: vm => vm.advance(0.2),
    slow: vm => vm.advance(1.5),
  };
  for (const order of [
    'complete page turnedIn landed finished', // the page in the same window, before the game's word (the server sends it with the reward)
    'complete finished page turnedIn landed', // the window closes and opens again on the page, then the word
    'complete turnedIn finished page landed', // the word, the close, the page; the log update still to come
    'complete turnedIn finished soon page landed', // 0.2 s on
    'complete finished soon page turnedIn landed', // 0.2 s on, the word after the page
    'complete turnedIn landed finished page', // the log already updated
    'complete turnedIn finished slow landed page', // a slow server: 1.5 s on
  ]) {
    const vm = world().on('qolAccept', 'qolTurnIn');
    vm.run(AT_CAP);
    vm.fire('QUEST_PROGRESS');
    for (const s of order.split(' ')) steps[s](vm);
    assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], order);
    assert.deepEqual(vm.chatLines().filter(l => l.includes('The Next Step')), [], `${order}: nothing left to you`);
    vm.fire('QUEST_ACCEPTED', 872);
    assert.ok(vm.list('NS.QoL.Last()').includes('Auto Accept Quests accepted The Next Step.'), `${order}: ${vm.list('NS.QoL.Last()').join(' | ')}`);
    // The page coming back, in that window or a new one, never accepts it twice.
    vm.run('QS.log[872] = true');
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], `${order}: once`);
  }
});

test('the follow-up behind the greeting the game opens again after a hand-in: Auto Skip opens it and Auto Accept takes it, the log update still to come', () => {
  const vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
  vm.run(`${AT_CAP}; QS.g.active = { { questID = 871, isComplete = true, isIgnored = false } }`);
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_CLOSED', 'true');
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_TURNED_IN', 871, 450, 0);
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.g.active = {}; QS.g.available = { { questID = 872, isTrivial = false, isIgnored = false } }');
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_CLOSED', 'true');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  vm.run(LANDED);
  assert.deepEqual(vm.calls(), ['SelectActiveQuest 871', ...HANDED, 'SelectAvailableQuest 872', 'AcceptQuest']);
});

test('the chained page is the same quest giver\'s whichever unit names it: both, questnpc alone, npc gone after the close, npc still naming the last vendor, or none (a book, a poster); another quest giver\'s page right after the close stays yours', () => {
  const V = 'Creature-0-1-1-1-9-0000000C';
  const OTHER = 'Creature-0-1-1-1-2-0000000B';
  const chain = (handIn, chained) => {
    const vm = world().on('qolAccept', 'qolTurnIn');
    vm.run(handIn);
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('QUEST_TURNED_IN', 871, 450, 0);
    vm.fire('QUEST_FINISHED');
    vm.advance(0.2);
    vm.run(`${chained}; ${NEXT}`);
    vm.fire('QUEST_DETAIL', 0);
    return vm.calls();
  };
  const both = `QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"`;
  for (const [what, handIn, chained] of [
    ['both units', both, both],
    ['questnpc alone', `QS.questnpc = "${GIVER}"`, `QS.questnpc = "${GIVER}"`],
    ['npc gone after the close', both, 'QS.npc = nil'],
    ['npc alone', `QS.npc = "${GIVER}"`, `QS.npc = "${GIVER}"`],
    ['npc still naming the last vendor, cleared at the close', `QS.npc, QS.questnpc = "${V}", "${GIVER}"`, 'QS.npc = nil'],
    ['no unit (a book, a poster)', 'QS.npc, QS.questnpc = nil, nil', 'QS.npc, QS.questnpc = nil, nil'],
  ]) assert.deepEqual(chain(handIn, chained), [...HANDED, 'AcceptQuest'], what);
  assert.deepEqual(chain(`QS.questnpc = "${GIVER}"`, `QS.questnpc = "${OTHER}"`), HANDED, 'another quest giver\'s page, by the quest page\'s own unit');
  assert.deepEqual(chain(`QS.npc = "${GIVER}"`, `QS.npc = "${OTHER}"`), HANDED, 'another quest giver\'s page, by npc');
});

test('Auto Accept Quests alone hears the hand-in too: the follow-up after one you hand in yourself is taken with the log at its cap, and Shift at that hand-in keeps it yours', () => {
  let vm = world().on('qolAccept');
  vm.run(AT_CAP);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE'); // you click Complete Quest
  vm.fire('QUEST_FINISHED');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], vm.chatLines().join(' | '));
  for (const page of ['QUEST_PROGRESS', 'QUEST_COMPLETE']) {
    vm = world().on('qolAccept');
    vm.fire('QUEST_PROGRESS');
    vm.run('STUB.shift = true');
    vm.fire(page);
    vm.run('STUB.shift = false');
    if (page === 'QUEST_PROGRESS') vm.fire('QUEST_COMPLETE');
    vm.fire('QUEST_FINISHED');
    vm.advance(0.2);
    vm.run(NEXT);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), [], `Shift at ${page}: the follow-up is yours`);
  }
});

test('the quest a hand-in frees counts only for the page the game chains to it: a later conversation, or a hand-in the game refused, with the log still full says so', () => {
  for (const [what, wait] of [['a later conversation', 5], ['the same quest giver again right after a refused hand-in', 0.3]]) {
    const vm = world().on('qolAccept', 'qolTurnIn');
    vm.run(AT_CAP);
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('UI_ERROR_MESSAGE', 3, lstr('Inventory is full.')); // the game refuses the hand-in: 871 stays in the log
    vm.fire('QUEST_FINISHED');
    vm.advance(wait);
    vm.run('QS.q.id = 900; QS.q.title = "Another"');
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), HANDED, what);
    assert.equal(vm.said(LEFT('Auto Accept Quests', 'Another', 'your quest log is full')), 1, `${what}: ${vm.chatLines().join(' | ')}`);
  }
});

test('a full log is the game\'s own cap: GetMaxNumQuestsCanAccept or Forever\'s log (Constants.QuestLogConsts, 40), whichever is larger; never MAX_QUESTS, a stale 25 on this client', () => {
  const cap = api => `MAX_QUESTS = 25; Constants = { QuestLogConsts = { MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT = 40 } }; C_QuestLog.GetMaxNumQuestsCanAccept = ${api}`;
  for (const [what, lua, count, full] of [
    ['no API: Forever\'s 40, not MAX_QUESTS', cap('nil'), 26, false],
    ['no API, 40 of 40', cap('nil'), 40, true],
    ['the API says 0', cap('function() return 0 end'), 26, false],
    ['the API says 35, the log 40', cap('function() return 35 end'), 36, false],
    ['the API says 40', cap('function() return 40 end'), 40, true],
    ['neither: the game refuses a full log itself', 'MAX_QUESTS = 25; Constants = nil; C_QuestLog.GetMaxNumQuestsCanAccept = nil', 60, false],
  ]) {
    const vm = world({ extra: lua }).on('qolAccept');
    vm.run(`QS.logCount = ${count}`);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), full ? [] : ['AcceptQuest'], what);
    assert.equal(vm.said(LEFT('Auto Accept Quests', 'Disrupt the Attacks', 'your quest log is full')), full ? 1 : 0, what);
  }
});

test('a follow-up left to you on purpose says why, once: low-level, a group quest, one that starts a fight', () => {
  for (const [lua, title, why] of [
    ['QS.q.trivial = true', 'The Next Step', 'it\'s a low-level quest'],
    ['QS.q.group = 3', 'The Next Step', 'it\'s a group quest'],
    ['QS.q.id = 1640; QS.q.title = "Beat Bartleby"', 'Beat Bartleby', 'accepting it starts a fight'],
  ]) {
    const vm = world().on('qolAccept', 'qolTurnIn');
    vm.run(AT_CAP);
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('QUEST_FINISHED');
    vm.run(`${NEXT}; ${lua}`);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), HANDED, why);
    assert.equal(vm.said(LEFT('Auto Accept Quests', title, why)), 1, `${why}: ${vm.chatLines().join(' | ')}`);
  }
});

test('a reward page waiting for its item data never acts on the follow-up the game opens in its place', () => {
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(`NS.QoL.SetRewards("sell"); QS.q.choices = { ${item(101, 'Rugged Boots')}, ${item(103, 'Iron Ring')} }; QS.prices[101] = 150`);
  vm.fire('QUEST_COMPLETE');
  assert.equal(vm.evaluate('NS.QoL.frame.events.QUEST_ITEM_UPDATE'), 'true', 'it waits for the ring\'s price');
  // You pick the boots yourself; the game opens the follow-up in the same window, and its rewards load.
  vm.run(`${NEXT}; QS.q.choices = {}`);
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_ITEM_UPDATE');
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'no GetQuestReward on the follow-up\'s page');
});

test('the quest greeting is a page of the quest frame, named by questnpc as its quest pages are: Shift there keeps the hand-in and its follow-up yours, and the greeting the game opens again after a hand-in is that quest giver\'s, whatever npc still names', () => {
  const V = 'Creature-0-1-1-1-9-0000000C';
  for (const [what, units] of [
    ['both units', `QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"`],
    ['npc still naming the last vendor', `QS.npc, QS.questnpc = "${V}", "${GIVER}"`],
    ['questnpc alone', `QS.npc, QS.questnpc = nil, "${GIVER}"`],
  ]) {
    // Shift at the quest greeting, then let go: its hand-in and the follow-up the game chains to it stay yours.
    let vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
    vm.run(`${units}; QS.logCount = 20; QS.log[871] = true; QS.greet.active = { { title = "Disrupt the Attacks", complete = true, id = 871 } }; STUB.shift = true`);
    vm.fire('QUEST_GREETING');
    vm.run('STUB.shift = false');
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('QUEST_FINISHED');
    vm.run(NEXT);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), [], `${what}: Shift at the quest greeting`);
    // The quest greeting the game opens again 0.2 s after an auto hand-in, the log update still to come:
    // Auto Skip opens the follow-up and Auto Accept takes it.
    vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
    vm.run(`${units}; QS.logCount = 20; QS.log[871] = true`);
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('QUEST_TURNED_IN', 871, 450, 0);
    vm.fire('QUEST_FINISHED');
    vm.advance(0.2);
    vm.run('QS.greet.available = { { id = 872, trivial = false } }');
    vm.fire('QUEST_GREETING');
    vm.run(NEXT);
    vm.fire('QUEST_DETAIL', 0);
    vm.run(LANDED);
    assert.deepEqual(vm.calls(), [...HANDED, 'GreetingAvailable 1', 'AcceptQuest'], `${what}: the quest greeting again after a hand-in`);
    assert.deepEqual(vm.chatLines().filter(l => l.includes('The Next Step')), [], `${what}: nothing left to you`);
  }
});

test('a follow-up the game already took itself (QuestGetAutoAccept: no Decline, its Accept only closes the page) is never answered for you, and says so once', () => {
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(AT_CAP);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_TURNED_IN', 871, 450, 0);
  vm.fire('QUEST_FINISHED');
  vm.run(`${NEXT}; QS.q.autoAccept = true; QS.log[872] = true`);
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), HANDED);
  assert.deepEqual(vm.list('STUB.forbidden'), [], 'its Accept (AcknowledgeAutoAcceptQuest) and its close are the player\'s');
  assert.equal(vm.said(GAME('The Next Step')), 1, vm.chatLines().join(' | '));
});

test('a quest already in your log is never accepted again (said in /nqa qol last only), but for the one just handed in: a repeatable offered again under its own ID before the log update is taken', () => {
  // The same page once the accept has landed.
  let vm = world().on('qolAccept');
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_ACCEPTED', 871);
  vm.run('QS.log[871] = true');
  vm.fire('QUEST_FINISHED');
  vm.advance(1);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest']);
  const taken = 'Auto Accept Quests left Disrupt the Attacks to you because it\'s already in your quest log.';
  assert.deepEqual(vm.list('NS.QoL.Last()'), [taken, 'Auto Accept Quests accepted Disrupt the Attacks.']);
  assert.equal(vm.said(taken), 0, 'not in the chat frame');
  // A repeatable handed in and offered again as the reward page closes, the log still listing it.
  vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(`QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"; QS.log[871] = true; QS.q.repeatable = true`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest']);
  assert.deepEqual(vm.chatLines(), []);
});

test('the follow-up\'s page again in a new window before the game\'s word on its accept: never accepted twice', () => {
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(AT_CAP);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_FINISHED');
  vm.advance(0.1);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest']);
  vm.fire('QUEST_ACCEPTED', 872);
  assert.ok(vm.list('NS.QoL.Last()').includes('Auto Accept Quests accepted The Next Step.'), 'and its line still comes with the game\'s word');
});

// bones-qol-critic r2's QC-09: your click on the next NPC closes the window
// still open (a vendor's, a greeting, a quest page), and the next one's opens
// within half a second. That's a new conversation, the options' to finish.
test('straight from one NPC to the next is a new conversation the options finish: from a vendor, a greeting or a quest page; Shift at the last one stays there; only a reward page\'s close holds back the next page', () => {
  const V = 'Creature-0-1-1-1-9-0000000C';
  const OTHER = 'Creature-0-1-1-1-2-0000000B';
  const vendorThen = (opts, units, lua = '') => {
    const vm = world().on(...opts);
    vm.run(`QS.npc, QS.questnpc = "${V}", nil; QS.m.junk = 1${lua}`);
    vm.fire('MERCHANT_SHOW');
    vm.run('STUB.shift = false');
    vm.fire('MERCHANT_CLOSED');
    vm.advance(0.05);
    vm.run(`QS.calls = {}; ${units}`);
    return vm;
  };
  // A vendor, then a quest giver: its quest is taken, or its finished one handed in; a quest greeting skipped.
  let vm = vendorThen(['qolAccept', 'qolTurnIn', 'qolJunk'], `QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"`);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'a vendor, then a quest page');
  assert.deepEqual(vm.list('NS.QoL.Last()').filter(l => l.includes('Disrupt the Attacks')), [], 'nothing left to you');
  vm = vendorThen(['qolAccept', 'qolTurnIn', 'qolJunk'], `QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  assert.deepEqual(vm.calls(), HANDED, 'a vendor, then a hand-in');
  vm = vendorThen(['qolSkip', 'qolJunk'], `QS.npc, QS.questnpc = "${OTHER}", "${OTHER}"; QS.greet.available = { { id = 3, trivial = false } }`);
  vm.fire('QUEST_GREETING');
  assert.deepEqual(vm.calls(), ['GreetingAvailable 1'], 'a vendor, then a quest greeting');
  // Shift held as you opened the vendor stays with the vendor.
  vm = vendorThen(['qolAccept', 'qolJunk'], `QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"`, '; STUB.shift = true');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'Shift at the vendor, then a quest page');
  // A gossip greeting still open, then another NPC's: Auto Skip opens its only quest.
  vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
  vm.run(`QS.npc, QS.questnpc = "${GIVER}", nil; QS.g.options = { { name = "Train me" } }`);
  vm.fire('GOSSIP_SHOW');
  vm.fire('GOSSIP_CLOSED', 'false');
  vm.advance(0.05);
  vm.run(`QS.npc = "${OTHER}"; QS.g.options = {}; QS.g.available = { { questID = 900, isTrivial = false, isIgnored = false } }`);
  vm.fire('GOSSIP_SHOW');
  assert.deepEqual(vm.calls(), ['SelectAvailableQuest 900'], 'a greeting, then another');
  // A quest page still open (a quest not finished yet), then another quest giver's.
  vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(`QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"; QS.q.completable = false`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.05);
  vm.run(`QS.npc, QS.questnpc = "${OTHER}", "${OTHER}"; QS.q.id = 900; QS.q.title = "Another"`);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), ['AcceptQuest'], 'a quest page, then another quest giver\'s');
  // After a hand-in whose follow-up waits for you (low-level), straight on to another quest giver.
  vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(`QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.run(`${NEXT}; QS.q.trivial = true`);
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_FINISHED');
  vm.advance(0.05);
  vm.run(`QS.npc, QS.questnpc = "${OTHER}", "${OTHER}"; QS.q.id = 900; QS.q.title = "Another"; QS.q.trivial = false`);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], 'the follow-up left to you, then another quest giver\'s');
});

// bones-qol-critic r2's QC-13: "npc" can still name the last vendor on the
// hand-in's pages while "questnpc" names the quest giver only from a later
// page. A read by the page's own unit and one by the other never make two
// quest givers.
test('the page\'s own unit and the other disagreeing is never someone else: "questnpc" showing up a page later, "npc" still naming the last vendor, keeps the hand-in\'s conversation, its Shift and the quest it frees', () => {
  const V = 'Creature-0-1-1-1-9-0000000C';
  for (const [what, close, chained] of [
    ['in the same window', false, `QS.questnpc = "${GIVER}"`],
    ['in the same window, npc gone', false, `QS.npc, QS.questnpc = nil, "${GIVER}"`],
    ['after the close', true, `QS.npc, QS.questnpc = nil, "${GIVER}"`],
    ['after the close, questnpc gone again', true, `QS.questnpc = nil`],
  ]) {
    for (const shift of [false, true]) {
      const vm = world().on('qolAccept', 'qolTurnIn');
      vm.run(`${AT_CAP}; QS.npc, QS.questnpc = "${V}", nil`);
      if (what.endsWith('gone again')) vm.run(`QS.questnpc = "${GIVER}"`);
      vm.fire('QUEST_PROGRESS');
      if (shift) vm.run('STUB.shift = true');
      vm.fire('QUEST_COMPLETE');
      vm.run('STUB.shift = false');
      if (close) { vm.fire('QUEST_FINISHED'); vm.advance(0.2); }
      vm.run(`${chained}; ${NEXT}`);
      vm.fire('QUEST_DETAIL', 0);
      const how = `${what}${shift ? ', Shift at the reward page' : ''}`;
      assert.deepEqual(vm.calls(), shift ? ['CompleteQuest'] : [...HANDED, 'AcceptQuest'], how);
      assert.deepEqual(vm.chatLines(), [], `${how}: nothing left to you`);
    }
  }
  // bones-qol-critic r3's QC-17, by design: a reward page read by "npc" alone
  // and another NPC's page read by its "questnpc" 0.2 s after the close are one
  // conversation too (that page is almost surely your own click): the options
  // finish it.
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(`QS.npc, QS.questnpc = "${GIVER}", nil`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.advance(0.2);
  vm.run('QS.npc, QS.questnpc = nil, "Creature-0-1-1-1-2-0000000B"; QS.q.id, QS.q.title = 900, "Another"');
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], 'npc on the reward page, another NPC\'s questnpc after it');
  assert.deepEqual(vm.chatLines(), []);
});

// bones-qol-critic r2's QC-10: the log can stop listing the quest handed in
// before its count goes down.
test('the quest a hand-in frees counts while the log lists it or its count hasn\'t gone down since the reward page; one the log didn\'t list there frees nothing', () => {
  let vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(AT_CAP);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.run('QS.log[871] = nil'); // IsOnQuest first, the count still 20 of 20
  vm.fire('QUEST_FINISHED');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], 'IsOnQuest ahead of the count');
  vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(`QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"; QS.logCount = 20`); // 871 never in the log
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), HANDED, 'a quest the log didn\'t list');
  assert.equal(vm.said(LEFT('Auto Accept Quests', 'The Next Step', 'your quest log is full')), 1, vm.chatLines().join(' | '));
});

// The merge with quest-log-full (bones-qol-critic r3's QC-15): LogFull counts
// the log as ns.QuestLog reads it, and the reward page records the count the
// hand-in is judged against (R.qolHandedCount) the same way, never by the
// game's own count, which may take in a hidden quest.
test('the quest a hand-in frees is judged on the count LogFull takes (ns.QuestLog): with a hidden quest in the game\'s count, a log that hasn\'t gone down still frees it', () => {
  // 20 quests and a hidden one: the game's count says 21; the log is at its cap of 20.
  const LOG = `${AT_CAP}; QS.logCount = 21
    local info = C_QuestLog.GetInfo
    C_QuestLog.GetInfo = function(i) if i == QS.logCount + 2 then return { questID = 5000, isHidden = true } end return info(i) end`;
  const full = world().on('qolAccept');
  full.run(LOG);
  full.run(NEXT);
  full.fire('QUEST_DETAIL', 0);
  assert.deepEqual(full.calls(), [], 'no hand-in: 20 of 20 is full');
  const vm = world().on('qolAccept', 'qolTurnIn');
  vm.run(LOG);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.run('QS.log[871] = nil'); // IsOnQuest first, the log still 20 quests
  vm.fire('QUEST_FINISHED');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], vm.chatLines().join(' | '));
});

// The same merge: the cap LogFull judges against is ns.QuestLogMax's, never
// less than the log holds. A log past the cap the game reports shows its real
// cap is bigger, so the quest a hand-in frees is room for the follow-up (a cap
// too low would leave it to you as full; one too high only lets the game refuse).
test('a log holding more than the cap the game reports is full as it stands, but the quest a hand-in frees leaves room for the follow-up', () => {
  const CAP = 'Constants = { QuestLogConsts = { MAXIMUM_NUM_QUESTS_LOG_CAN_ACCEPT = 40 } }; C_QuestLog.GetMaxNumQuestsCanAccept = nil';
  const full = world({ extra: CAP }).on('qolAccept');
  full.run(`QS.npc, QS.questnpc = "${GIVER}", "${GIVER}"; QS.logCount = 41`);
  full.fire('QUEST_DETAIL', 0);
  assert.deepEqual(full.calls(), [], '41 quests against 40: full');
  const vm = world({ extra: CAP }).on('qolAccept', 'qolTurnIn');
  vm.run(`${AT_CAP}; QS.logCount = 41`);
  vm.fire('QUEST_PROGRESS');
  vm.fire('QUEST_COMPLETE');
  vm.fire('QUEST_FINISHED');
  vm.run(NEXT);
  vm.fire('QUEST_DETAIL', 0);
  assert.deepEqual(vm.calls(), [...HANDED, 'AcceptQuest'], vm.chatLines().join(' | '));
});

// bones-qol-critic r2's QC-11: a refusal string that isn't the hand-in's
// ("Inventory is full." as you loot) before the game's word on it.
test('a refusal before the game\'s word on a hand-in drops its line, but the word within 5 s still frees its quest for the follow-up; later, or never, it frees nothing', () => {
  const heard = vm => Object.keys(vm.json('NS.QoL.frame.events') || {}).filter(e => /^(QUEST_ACCEPTED|QUEST_TURNED_IN|UI_ERROR_MESSAGE)$/.test(e)).sort();
  for (const [what, wait, word, freed] of [
    ['the word right after', 0, true, true],
    ['the word 6 s later', 6, true, false],
    ['no word (the game refused it)', 0, false, false],
  ]) {
    const vm = world().on('qolAccept', 'qolTurnIn');
    vm.run(AT_CAP);
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('UI_ERROR_MESSAGE', 3, lstr('Inventory is full.'));
    assert.deepEqual(heard(vm), ['QUEST_TURNED_IN'], `${what}: only the hand-in's word is heard`);
    vm.advance(wait);
    if (word) vm.fire('QUEST_TURNED_IN', 871, 450, 0);
    if (word) assert.deepEqual(heard(vm), [], `${what}: then nothing`);
    vm.fire('QUEST_FINISHED');
    vm.run(NEXT);
    vm.fire('QUEST_DETAIL', 0);
    assert.deepEqual(vm.calls(), freed ? [...HANDED, 'AcceptQuest'] : HANDED, what);
    assert.equal(vm.said(LEFT('Auto Accept Quests', 'The Next Step', 'your quest log is full')), freed ? 0 : 1, `${what}: ${vm.chatLines().join(' | ')}`);
    assert.ok(!vm.list('NS.QoL.Last()').some(l => l.includes('handed in')), `${what}: the dropped line is never said`);
  }
});

// bones-qol-critic r3's QC-14 (its probe R8): the room a hand-in frees is one
// quest's. Once the follow-up has taken it, the log is full again, and
// another quest in the same conversation (the quest greeting the game opens
// again, Auto Skip to Quests picking its next quest) must be left as full,
// not accepted into a log the game will refuse.
test('the room a hand-in frees is taken once: after the follow-up takes it (Auto Accept Quests\' accept, your own Accept on a page left to you, a page the game already took), another quest in the same conversation is left as full; a follow-up you decline leaves the room free', () => {
  const THIRD = 'QS.q.id, QS.q.title, QS.q.group, QS.q.autoAccept = 873, "Third", 0, false';
  for (const [what, landed, follow, calls] of [
    ['Auto Accept Quests took it', true, vm => {
      vm.fire('QUEST_DETAIL', 0);
      vm.fire('QUEST_ACCEPTED', 872);
      vm.run('QS.logCount, QS.log[872] = 20, true');
    }, ['AcceptQuest']],
    ['you accepted it yourself, left to you as a group quest', true, vm => {
      vm.run('QS.q.group = 5');
      vm.fire('QUEST_DETAIL', 0);
      vm.run('QS.logCount, QS.log[872] = 20, true'); // your click on its Accept
    }, []],
    ['the game already took it', true, vm => {
      vm.run('QS.q.autoAccept = true; QS.logCount, QS.log[872] = 20, true');
      vm.fire('QUEST_DETAIL', 0);
    }, []],
    ['you declined it, left to you as a group quest; the log update still to come', false, vm => {
      vm.run('QS.q.group = 5');
      vm.fire('QUEST_DETAIL', 0);
    }, []],
  ]) {
    const vm = world().on('qolAccept', 'qolTurnIn', 'qolSkip');
    vm.run(`${AT_CAP}; QS.greet.active = { { title = "Disrupt the Attacks", complete = true, id = 871 } }`);
    vm.fire('QUEST_GREETING');
    vm.fire('QUEST_PROGRESS');
    vm.fire('QUEST_COMPLETE');
    vm.fire('QUEST_TURNED_IN', 871, 450, 0);
    if (landed) vm.run(LANDED);
    vm.run(NEXT);
    follow(vm);
    vm.fire('QUEST_FINISHED');
    vm.advance(0.1);
    vm.run('QS.greet.active = {}; QS.greet.available = { { id = 873, trivial = false } }');
    vm.fire('QUEST_GREETING');
    vm.run(THIRD);
    vm.fire('QUEST_DETAIL', 0);
    const free = !landed;
    assert.deepEqual(vm.calls(), ['GreetingActive 1', ...HANDED, ...calls, 'GreetingAvailable 1', ...(free ? ['AcceptQuest'] : [])], what);
    assert.equal(vm.said(LEFT('Auto Accept Quests', 'Third', 'your quest log is full')), free ? 0 : 1, `${what}: ${vm.chatLines().join(' | ')}`);
  }
});

// ---------------------------------------------------------------------------
// Vendors: Auto Sell Junk and Auto Repair
// ---------------------------------------------------------------------------

const GREYS = `
  QS.bags[0] = {
    { itemID = 4865, quality = 0, stackCount = 2, hasNoValue = false, isLocked = false },
    { itemID = 2589, quality = 1, stackCount = 20, hasNoValue = false, isLocked = false },
    { itemID = 4866, quality = 0, stackCount = 1, hasNoValue = true, isLocked = false },
    { itemID = 4867, quality = 0, stackCount = 1, hasNoValue = false, isLocked = true },
  }
  QS.bags[1] = { {}, { itemID = 4868, quality = 0, stackCount = 1, hasNoValue = false, isLocked = false } }
  QS.prices[4865], QS.prices[4868] = 55, 120`;

test('Auto Sell Junk: the game\'s own Sell All Junk; says what it sold and for how much, counting only bags you didn\'t leave out', () => {
  let vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junk = 2`);
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), ['SellAllJunkItems']);
  assert.equal(vm.said('Auto Sell Junk sold 2 gray items for 2s 30c.'), 1, vm.chatLines().join('\n'));
  // A bag left out of Sell All Junk: the game sells around it, and the sum does too.
  vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junk = 1; QS.excluded[1] = true`);
  vm.fire('MERCHANT_SHOW');
  assert.equal(vm.said('Auto Sell Junk sold 1 gray item for 1s 10c.'), 1, vm.chatLines().join('\n'));
  vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junk = 1; QS.excluded[0] = true`);
  vm.fire('MERCHANT_SHOW');
  assert.equal(vm.said('Auto Sell Junk sold 1 gray item for 1s 20c.'), 1, 'the backpack left out');
  // The game counts differently: how many, and no sum rather than a wrong one.
  vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junk = 3`);
  vm.fire('MERCHANT_SHOW');
  assert.equal(vm.said('Auto Sell Junk sold 3 gray items.'), 1, vm.chatLines().join('\n'));
  // Nothing to sell: nothing said.
  const quiet = world().on('qolJunk');
  quiet.fire('MERCHANT_SHOW');
  assert.deepEqual(quiet.calls(), []);
  assert.deepEqual(quiet.chatLines(), []);
});

test('Auto Sell Junk without the vendor\'s Sell All Junk button: nothing is sold one by one; it says so once a session', () => {
  let vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junkEnabled = false`);
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), []);
  assert.deepEqual(vm.list('STUB.forbidden'), [], 'no item used');
  vm.fire('MERCHANT_CLOSED');
  vm.fire('MERCHANT_SHOW');
  assert.equal(vm.said('Auto Sell Junk left your gray items to you because this vendor has no Sell All Junk Items button.'), 1);
  // No gray items: nothing to say.
  vm = world().on('qolJunk');
  vm.run('QS.m.junkEnabled = false');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.chatLines(), []);
  // Shift held as you open the vendor: yours.
  vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junk = 2; STUB.shift = true`);
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), []);
  // Shift held at a vendor's greeting ("Let me browse your goods."): the goods are yours too.
  vm = world().on('qolJunk');
  vm.run(`${GREYS}; QS.m.junk = 2; STUB.shift = true`);
  vm.fire('GOSSIP_SHOW');
  vm.run('STUB.shift = false');
  vm.fire('GOSSIP_CLOSED', 'true');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), []);
  vm.fire('MERCHANT_CLOSED');
  vm.advance(1);
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), ['SellAllJunkItems'], 'the next visit is the options\' again');
});

test('Auto Repair: with your own gold only, never your guild\'s; not enough says so; the gold the gray items bring counts', () => {
  let vm = world().on('qolRepair');
  vm.run('QS.m.cost = 3400');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), ['RepairAllItems nil'], 'no argument: your own gold (RepairAllItems(true) is the guild\'s)');
  assert.equal(vm.said('Auto Repair paid 34s to repair your gear.'), 1);
  vm = world().on('qolRepair');
  vm.run('QS.m.cost = 0');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), [], 'nothing to repair');
  vm = world().on('qolRepair');
  vm.run('QS.m.cost = 3400; QS.m.canRepair = false');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), [], 'a vendor who doesn\'t repair');
  vm = world().on('qolRepair');
  vm.run('QS.m.cost = 20000; STUB.money = 12345');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), []);
  assert.equal(vm.said('Auto Repair left your repairs to you because they cost 2g, more than you have.'), 1);
  // 12,345 copper and a 12,500 repair; the gray items bring 230.
  vm = world().on('qolJunk', 'qolRepair');
  vm.run(`${GREYS}; QS.m.junk = 2; QS.m.cost = 12500; STUB.money = 12345`);
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), ['SellAllJunkItems'], 'the repair waits for the sale\'s gold');
  vm.run('STUB.money = 12400');
  vm.fire('PLAYER_MONEY');
  assert.deepEqual(vm.calls(), ['SellAllJunkItems'], 'not yet enough');
  vm.run('STUB.money = 12575');
  vm.fire('PLAYER_MONEY');
  assert.deepEqual(vm.calls(), ['SellAllJunkItems', 'RepairAllItems nil']);
  vm.fire('MERCHANT_CLOSED');
  assert.ok(!vm.chatLines().some(l => l.includes('more than you have')));
  // Away, or Shift held, when the sale's gold lands: the repair is yours.
  for (const lua of ['QS.afk = true', 'STUB.shift = true']) {
    vm = world().on('qolJunk', 'qolRepair');
    vm.run(`${GREYS}; QS.m.junk = 2; QS.m.cost = 12500; STUB.money = 12345`);
    vm.fire('MERCHANT_SHOW');
    vm.run(`${lua}; STUB.money = 12575`);
    vm.fire('PLAYER_MONEY');
    assert.deepEqual(vm.calls(), ['SellAllJunkItems'], lua);
    assert.equal(vm.evaluate('NS.QoL.frame.events.PLAYER_MONEY'), null, lua);
  }
  // The vendor closes first: it says so then.
  vm = world().on('qolJunk', 'qolRepair');
  vm.run(`${GREYS}; QS.m.junk = 2; QS.m.cost = 12500; STUB.money = 12345`);
  vm.fire('MERCHANT_SHOW');
  vm.fire('MERCHANT_CLOSED');
  assert.equal(vm.said('Auto Repair left your repairs to you because they cost 1g 25s, more than you have.'), 1);
  assert.equal(vm.evaluate('NS.QoL.frame.events.PLAYER_MONEY'), null);
  // Shift: yours.
  vm = world().on('qolRepair');
  vm.run('QS.m.cost = 3400; STUB.shift = true');
  vm.fire('MERCHANT_SHOW');
  assert.deepEqual(vm.calls(), []);
});

// ---------------------------------------------------------------------------
// Loot: the game's own Auto Loot; rolls and bind-on-pickup never touched
// ---------------------------------------------------------------------------

test('Auto Loot is the game\'s own setting: Settings and the step set autoLootDefault; a fight defers the change; its text names the game\'s loot key', () => {
  const vm = world({ settings: true });
  vm.run('STUB.settings["Auto Loot"].set(true)');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1');
  assert.equal(vm.said('Auto Loot is on. Hold Shift as you loot to pick items yourself.'), 1, 'how to loot by hand, in the chat frame');
  vm.run('STUB.combat = true; NS.QoL.Set("loot", false)');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1', 'not in a fight');
  assert.equal(vm.evaluate('NS.QoL.Get("loot")'), 'false', 'Settings shows what you asked for');
  vm.run('STUB.combat = false');
  vm.fire('PLAYER_REGEN_ENABLED');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '0', 'set when the fight ends');
  assert.equal(vm.evaluate('NS.QoL.Describe("loot")'), 'Takes everything when you loot (the game\'s own Auto Loot); hold Shift as you loot to pick items yourself.');
  vm.run('QS.lootKey = "CTRL"');
  assert.match(vm.evaluate('NS.QoL.Describe("loot")'), /hold Ctrl as you loot/);
  vm.run('QS.lootKey = "NONE"');
  assert.match(vm.evaluate('NS.QoL.Describe("loot")'), /to loot by hand, set a loot key in the game's Options > Controls\.$/);
});

test('the Settings page\'s Defaults: the addon\'s options go to off, and the game\'s own Auto Loot and quest tracking keep their values', () => {
  const vm = world({ settings: true }).on('loot', 'qolJunk');
  vm.run('NS.QoL.Set("track", false, true); QS.calls = {}');
  vm.run('QS.defaulting = true; for _, name in ipairs({ "Auto Loot", "Auto Track Quests", "Auto Sell Junk" }) do local s = STUB.settings[name]; s.set(s.def) end; QS.defaulting = false');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1', 'Auto Loot stays on');
  assert.equal(vm.evaluate('STUB.cvars.autoQuestWatch'), '0', 'quest tracking stays off');
  assert.equal(vm.evaluate('NQADB.settings.qolJunk'), 'false', 'the addon\'s own option goes to its default');
  assert.deepEqual(vm.calls(), [], 'no CVar written');
  vm.advance(0.1);
  assert.deepEqual(vm.list('STUB.notified').sort(), ['Auto Loot', 'Auto Track Quests'], 'once the game has drawn the default, the two rows read the real value again');
});

test('loot windows, rolls and bind-on-pickup: every option on, nothing is looted, rolled or confirmed', () => {
  const vm = world().on('loot', 'qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk', 'qolRepair', 'track');
  vm.fire('LOOT_READY', 'true');
  vm.fire('LOOT_OPENED', 'true', 'false');
  vm.fire('LOOT_BIND_CONFIRM', 1);
  vm.fire('START_LOOT_ROLL', 7, 60000);
  vm.fire('CONFIRM_LOOT_ROLL', 7, 1, '"LOOT_BIND"');
  vm.fire('LOOT_CLOSED');
  assert.deepEqual(vm.calls(), []);
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// ---------------------------------------------------------------------------
// Auto Track Quests: the game's own quest tracking
// ---------------------------------------------------------------------------

test('Auto Track Quests is the game\'s own autoQuestWatch; both game settings hide where the client lacks them', () => {
  const vm = world({ settings: true });
  vm.run('NS.QoL.Set("track", false)');
  assert.equal(vm.evaluate('STUB.cvars.autoQuestWatch'), '0');
  vm.run('STUB.settings["Auto Track Quests"].set(true)');
  assert.equal(vm.evaluate('STUB.cvars.autoQuestWatch'), '1');
  assert.equal(vm.said('Auto Track Quests is on. Hold Shift as you click a quest in your quest log to untrack it until you make progress again.'), 1);
  const bare = world({ settings: true, extra: 'STUB.cvars.autoQuestWatch = nil; STUB.cvars.autoLootDefault = nil' });
  const controls = bare.list('STUB.controls');
  assert.ok(!controls.includes('checkbox: Auto Track Quests') && !controls.includes('checkbox: Auto Loot'), controls.join('\n'));
  assert.ok(controls.includes('checkbox: Auto Accept Quests'));
});

// ---------------------------------------------------------------------------
// Settings: one Quality of Life section
// ---------------------------------------------------------------------------

// Quest Rewards' rows in the game's Settings (E-047), and a row's initializer by its name.
const REWARD_ROWS = ['Your Pick', 'Best Upgrade', 'Highest Price'].map(w => `Quest Rewards: ${w}`);
const initOf = name => `(function() for _, i in ipairs(STUB.inits) do if i.control == ${lstr(name)} then return i end end end)()`;

test('Settings: one Quality of Life section, its rows in order, the addon\'s off by default, each described in one sentence that says how to do it by hand', () => {
  const vm = world({ settings: true });
  const inits = vm.list('STUB.inits');
  const start = inits.findIndex(i => i.header === 'Quality of Life');
  assert.ok(start > 0, 'the section');
  const rows = [];
  for (const i of inits.slice(start + 1)) { if (i.header) break; rows.push(i.control); }
  assert.deepEqual(rows, ['Auto Loot', 'Auto Accept Quests', 'Auto Turn In Quests', ...REWARD_ROWS, 'Auto Skip to Quests',
    'Auto Sell Junk', 'Auto Repair', 'Auto Track Quests']);
  // E-047: Quest Rewards is a check box per rule, never a dropdown (0.5.2's crashed the game when opened).
  assert.deepEqual(vm.list('STUB.dropdowns'), []);
  for (const name of REWARD_ROWS) assert.ok(vm.list('STUB.controls').includes(`checkbox: ${name}`), name);
  for (const name of ['Auto Accept Quests', 'Auto Turn In Quests', 'Auto Skip to Quests', 'Auto Sell Junk', 'Auto Repair', 'Auto Track Quests']) {
    const tip = vm.evaluate(`STUB.tips[${lstr(name)}]()`);
    assert.match(tip, /hold Shift as/, `${name}: says how to do it by hand`);
    assert.equal((tip.match(/\. /g) || []).length, 0, `${name}: one sentence`);
    assert.ok(tip.endsWith('.'), name);
    if (name !== 'Auto Track Quests') {
      assert.equal(vm.evaluate(`STUB.settings[${lstr(name)}].def`), 'false', `${name}: off by default`);
      assert.equal(vm.evaluate(`STUB.settings[${lstr(name)}].get()`), 'false', name);
    }
  }
  assert.equal(vm.evaluate('STUB.settings["Auto Loot"].def'), 'false', 'the game\'s own default (off)');
  assert.equal(vm.evaluate('STUB.settings["Auto Track Quests"].def'), 'true', 'the game\'s own default (on)');
  assert.deepEqual(REWARD_ROWS.map(n => vm.evaluate(`STUB.settings[${lstr(n)}].def`)), ['true', 'false', 'false'], 'Your Pick by default');
  assert.match(vm.evaluate('STUB.tips["Auto Sell Junk"]()'), /as its Sell All Junk Items button does but without asking/, 'says plainly that the game\'s question is skipped');
  // Quest Rewards' rows sit under Auto Turn In Quests: indented, grayed while it's off, and looked at again when
  // its setting changes. Never linked to it (QL-36): the Options search reads a row's parent link unguarded, so a
  // search that found one would show its results with our taint (the Discord row's restricted call then blocked).
  const turnIn = vm.evaluate('STUB.settings["Auto Turn In Quests"].var');
  assert.match(turnIn, /^NQA_SWITCH_\d+$/);
  assert.deepEqual(vm.list('STUB.parentLinks'), [], 'no row has a parent link');
  for (const n of REWARD_ROWS) {
    assert.equal(vm.evaluate(`${initOf(n)}.parent`), null, n);
    assert.equal(vm.num(`${initOf(n)}.indent`), 15, `${n}: indented, as a sub-setting is`);
    assert.equal(vm.num(`#${initOf(n)}.predicates`), 1, n);
    assert.equal(vm.evaluate(`${initOf(n)}.predicates[1]()`), 'false', `${n}: grayed while Auto Turn In Quests is off`);
    assert.deepEqual(vm.list(`${initOf(n)}.watches`), [turnIn], `${n}: redrawn when Auto Turn In Quests changes`);
  }
  vm.run('NS.QoL.Set("qolTurnIn", true, true)');
  for (const n of REWARD_ROWS) assert.equal(vm.evaluate(`${initOf(n)}.predicates[1]()`), 'true', n);
  // No other row is indented or grayed.
  assert.deepEqual(vm.list('STUB.inits').filter(i => i.control && (i.indent || i.predicates || i.watches)).map(i => i.control), REWARD_ROWS);
  // Each rule's tooltip says what it's for first (C-122): a search shows the row without Auto Turn In Quests above it.
  const tip = n => vm.evaluate(`STUB.tips[${lstr(n)}]()`);
  assert.equal(tip(REWARD_ROWS[0]), 'When a quest offers a choice of rewards, Auto Turn In Quests leaves the pick to you.');
  assert.equal(tip(REWARD_ROWS[1]), 'When a quest offers a choice of rewards, Auto Turn In Quests takes the biggest upgrade for your build by NeverQuestAlone\'s stat weights, and sends nothing; with no weights, no upgrade or a tie, you pick.');
  assert.equal(tip(REWARD_ROWS[2]), 'When a quest offers a choice of rewards, Auto Turn In Quests takes the one that sells for the most at a vendor, counting a stack, even one you can\'t use; with a tie, you pick.');
  // Each row's name fits the list's label column at 12 pt, indented (about 180 units; the lint's measure, 0.52 em a character).
  for (const n of REWARD_ROWS) assert.ok(n.length * 12 * 0.52 <= 180, `${n}: ${Math.round(n.length * 12 * 0.52)} units`);
  // A row turns its option on, answers the step, and says how to do it by hand.
  vm.run('NQADB.qolAsked = nil; STUB.chat = {}; STUB.settings["Auto Repair"].set(true)');
  assert.equal(vm.evaluate('NQADB.settings.qolRepair'), 'true');
  assert.equal(vm.evaluate('NQADB.qolAsked'), 'true');
  assert.deepEqual(vm.chatLines(), [B + 'Auto Repair is on. Hold Shift as you open a vendor to repair by hand.']);
  vm.run('STUB.chat = {}; STUB.settings["Auto Repair"].set(false)');
  assert.deepEqual(vm.chatLines(), [], 'off says nothing');
  vm.run(`STUB.settings[${lstr(REWARD_ROWS[2])}].set(true)`);
  assert.equal(vm.evaluate('NQADB.settings.qolRewards'), 'sell');
  // /nqa qol opens the page at the section.
  vm.slash('qol');
  assert.deepEqual([vm.evaluate('STUB.opened'), vm.evaluate('STUB.openedAt')], ['42', 'Quality of Life']);
});

test('Quest Rewards in Settings: three rows, exactly one checked, as radio buttons are; each settable from the list and read back, on the page\'s Defaults too', () => {
  const vm = world({ settings: true });
  const checked = () => REWARD_ROWS.map(n => vm.evaluate(`STUB.settings[${lstr(n)}].get()`) === 'true');
  const set = (i, v) => vm.run(`STUB.settings[${lstr(REWARD_ROWS[i])}].set(${v})`);
  assert.deepEqual(checked(), [true, false, false]);
  // A pick: its rule saved, and the row it replaced told to read its value again (the game redraws a row only when told).
  vm.run('STUB.notified = {}');
  set(1, true);
  assert.equal(vm.evaluate('NQADB.settings.qolRewards'), 'bones');
  assert.deepEqual(checked(), [false, true, false]);
  assert.deepEqual(vm.list('STUB.notified'), [REWARD_ROWS[0]]);
  vm.run('STUB.notified = {}');
  set(2, true);
  assert.equal(vm.evaluate('NQADB.settings.qolRewards'), 'sell');
  assert.deepEqual(checked(), [false, false, true]);
  assert.deepEqual(vm.list('STUB.notified'), [REWARD_ROWS[1]]);
  // A click on the checked row keeps it the pick: once the game has drawn the click, the row reads checked again.
  vm.run('STUB.notified = {}');
  set(2, false);
  assert.equal(vm.evaluate('NQADB.settings.qolRewards'), 'sell');
  assert.deepEqual(vm.list('STUB.notified'), [], 'not while the game is still drawing the click');
  vm.advance(0.1);
  assert.deepEqual(vm.list('STUB.notified'), [REWARD_ROWS[2]]);
  assert.deepEqual(checked(), [false, false, true]);
  // A rule set elsewhere (our own window's button) reads back on the rows.
  vm.run('NS.QoL.SetRewards("bones")');
  assert.deepEqual(checked(), [false, true, false]);
  // The page's Defaults: the game sets each row to its default, in no set order, and only where the value differs
  // (SettingMixin:ApplyValue). Every order ends at Your Pick, and only it.
  for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2]]) {
    set(2, true);
    vm.run(`for _, k in ipairs({ ${order.map(k => k + 1).join(', ')} }) do
      local s = STUB.settings[({ ${REWARD_ROWS.map(lstr).join(', ')} })[k]]
      if s.get() ~= s.def then s.set(s.def) end
    end`);
    vm.advance(0.1);
    assert.equal(vm.evaluate('NQADB.settings.qolRewards'), 'you', `order ${order}`);
    assert.deepEqual(checked(), [true, false, false], `order ${order}`);
  }
});

test('a /reload after an update, before the restart that loads QoL.lua: Settings, the addon menu, the quest menu, the HUD and /nqa qol work without it', () => {
  const vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', settings: true, skip: ['QoL.lua'] });
  assert.equal(vm.evaluate('NS.QoL'), null, 'QoL.lua isn\'t loaded');
  assert.equal(vm.evaluate('STUB.registered ~= nil'), 'true', 'the Settings page registered');
  const headers = vm.list('STUB.inits').filter(i => i.header).map(i => i.header);
  assert.deepEqual(headers, ['The HUD', 'Map', 'Quests', 'Replies', 'Tooltips', 'What NeverQuestAlone Knows', 'Personality', 'Usage', 'Keys and Places']);
  assert.equal(vm.evaluate('STUB.compartment ~= nil'), 'true', 'the addon menu');
  assert.equal(vm.evaluate('STUB.menus.MENU_QUEST_MAP_LOG_TITLE ~= nil'), 'true', 'the quest menu');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'idle');
  vm.fire('PLAYER_ENTERING_WORLD', 'false', 'true');
  vm.slash('qol');
  assert.equal(vm.said('Quality of Life isn\'t loaded yet. Restart WoW to load it: /reload isn\'t enough.'), 1, vm.chatLines().join('\n'));
  vm.slash('settings');
  assert.equal(vm.evaluate('STUB.opened'), '42');
});

// ---------------------------------------------------------------------------
// /nqa qol, on, off and last
// ---------------------------------------------------------------------------

test('/nqa qol on turns on the step\'s five, answers the step and says how to do it by hand; /nqa qol off turns off the addon\'s own and leaves the game\'s two', () => {
  let vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  vm.slash('qol on');
  assert.deepEqual(['qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk', 'qolRepair'].map(k => vm.evaluate(`NQADB.settings.${k}`)),
    ['true', 'true', 'true', 'true', 'false'], 'the five, not Auto Repair');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1');
  assert.equal(vm.evaluate('NQADB.qolAsked'), 'true');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'idle');
  assert.deepEqual(vm.chatLines().filter(l => l.includes(' on.')), [B + 'Auto Loot, Auto Accept Quests, Auto Turn In Quests, Auto Skip to Quests and Auto Sell Junk are on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change them.']);
  // A loot key other than Shift is named; Auto Loot already on isn't listed.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: 'QS.lootKey = "CTRL"', ready: true });
  vm.slash('qol on');
  assert.ok(vm.chatLines().some(l => l.endsWith('Hold Shift as you open a window to finish it yourself, or Ctrl as you loot. Type /nqa qol to change them.')), vm.chatLines().join('\n'));
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: 'STUB.cvars.autoLootDefault = "1"' });
  vm.slash('qol on');
  assert.ok(vm.chatLines().some(l => l === B + 'Auto Accept Quests, Auto Turn In Quests, Auto Skip to Quests and Auto Sell Junk are on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change them.'), vm.chatLines().join('\n'));
  // No loot key: Auto Loot stays off (looting by hand needs one), and the answer says why.
  let noKey = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: 'QS.lootKey = "NONE"', ready: true });
  noKey.slash('qol on');
  assert.equal(noKey.evaluate('STUB.cvars.autoLootDefault'), '0');
  assert.ok(noKey.chatLines().some(l => l === B + 'Auto Accept Quests, Auto Turn In Quests, Auto Skip to Quests and Auto Sell Junk are on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change them.'), noKey.chatLines().join('\n'));
  assert.equal(noKey.said('Auto Loot stays off without a loot key, so you can always loot by hand. Set one in the game\'s Options > Controls, then type /nqa qol on again.'), 1);
  // Auto Loot already on: no such line.
  assert.equal(vm.chatLines().filter(l => l.includes('Auto Loot stays off')).length, 0);
  // Off: the addon's own; the game's own Auto Loot stays.
  vm.slash('qol off');
  for (const k of ['qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk', 'qolRepair']) assert.equal(vm.evaluate(`NQADB.settings.${k}`), 'false', k);
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1', 'the game\'s own Auto Loot stays');
  assert.deepEqual(Object.keys(vm.json('NS.QoL.frame.events') || {}), []);
  assert.equal(vm.said('Your Quality of Life options are off. Auto Loot and Auto Track Quests are the game\'s own settings, so they stay as they were.'), 1);
});

test('/nqa qol last says what the options did, newest first; the help lists every /nqa qol command', () => {
  const vm = world().on('qolAccept');
  vm.slash('qol last');
  assert.equal(vm.said('Your Quality of Life options haven\'t done anything since you logged in or reloaded.'), 1);
  vm.fire('QUEST_DETAIL', 0);
  vm.fire('QUEST_ACCEPTED', 871);
  vm.slash('qol last');
  assert.ok(vm.chatLines().includes(B + 'What your Quality of Life options did, newest first:\nAuto Accept Quests accepted Disrupt the Attacks.'), vm.chatLines().join('\n'));
  const help = fs.readFileSync(path.join(ADDON, 'Commands.lua'), 'utf8');
  for (const line of [
    '/nqa qol  Open Quality of Life in Settings',
    '/nqa qol on|off  Turn Quality of Life options on or off',
    '/nqa qol last  Show what Quality of Life did lately',
  ]) assert.ok(help.includes(`"${line}"`), line); // in /nqa help all (commands-ux: /nqa help is six lines)
  vm.slash('help all');
  const all = vm.chatLines().concat([vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text') || '']).join('\n').replace(/\|c[0-9a-f]{8}|\|r/g, '');
  for (const line of ['/nqa qol  Open Quality of Life in Settings', '/nqa qol on||off  Turn Quality of Life options on or off', '/nqa qol last  Show what Quality of Life did lately']) {
    assert.ok(all.includes(line), `help all shows "${line}"`);
  }
});

// ---------------------------------------------------------------------------
// Nothing from outside the game turns any of it on
// ---------------------------------------------------------------------------

test('nothing from outside the game changes a Quality of Life switch: no slot field, reply, chip or /nqa line in a reply', () => {
  const vm = world();
  const id = vm.evaluate('NS.Chats.Active().id');
  const before = vm.evaluate('STUB.Serialize(NQADB.settings)');
  vm.run(`NS.Transport.HandleSlotData({ v = 2, ts = "2026-09-26T18:04:00Z", now = time(), token = NQADB.token,
    bridge = { ver = "1.4.1", push = 0, acked = {}, qol = { qolAccept = true, loot = true }, settings = { qolJunk = true } },
    settings = { qolAccept = true, qolRepair = true }, qolAsked = false,
    gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {},
    records = { { seq = 1, t = "reply", chat = "${id}", mid = "m1", agent = "main", text = "/nqa qol on\\n/nqa qol", summary = "Turn on Auto Accept Quests.",
      more = 0, chips = { "/nqa qol on", "Turn on quality of life" }, qol = { qolAccept = true } } } }, "slot")`);
  assert.equal(vm.evaluate('STUB.Serialize(NQADB.settings)'), before, 'the settings are as they were');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '0');
  assert.equal(vm.evaluate('NS.QoL.Get("qolAccept")'), 'false');
  // A chip's words are a message, never a command (UI.lua's ChipClick sends them).
  vm.run('NS.UI.Toggle(true)');
  const sent = vm.outboxWires().length;
  vm.run(`NS.Chats.Send("/nqa qol on", "${id}")`);
  assert.equal(vm.outboxWires().length, sent + 1, 'sent to NeverQuestAlone as words');
  assert.equal(vm.evaluate('NS.QoL.Get("qolAccept")'), 'false');
});

// ---------------------------------------------------------------------------
// The step: the HUD's Quality of Life block
// ---------------------------------------------------------------------------

const STEP_ROWS = '(function() local o = {} for _, c in ipairs(NS.HUD.h.qolChecks) do if c.shown then o[#o + 1] = c.text.text .. (c.checked and " [x]" or " [ ]") end end return o end)()';

test('the step: in a session after the welcome\'s, the HUD offers five, checked; Turn On turns those on; nothing changes until a click', () => {
  const vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol');
  assert.equal(vm.evaluate('NS.HUD.h.label.text'), 'Quality of Life');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Click Turn On and these finish the quest, loot and vendor windows you open. Hold Shift as you open one to finish it yourself.');
  assert.deepEqual(vm.list(STEP_ROWS), ['Auto Loot [x]', 'Auto Accept Quests [x]', 'Auto Turn In Quests [x]', 'Auto Skip to Quests [x]', 'Auto Sell Junk [x]']);
  assert.deepEqual(vm.json('NS.HUD.h.qolChecks[1].text.textColor'), [1, 1, 1], 'white: what you act on');
  assert.deepEqual(['qolOn', 'qolSkip'].map(b => vm.evaluate(`NS.HUD.h.${b}.text`)), ['Turn On', 'Skip']);
  assert.deepEqual(vm.json('NS.HUD.h.qolOn.tip'), { title: 'Turn On', text: 'Turns on the options you picked.', note: 'Type /nqa qol to change them later.' });
  assert.deepEqual(vm.json('NS.HUD.h.qolSkip.tip'), { title: 'Skip', text: 'Changes nothing.', note: 'Type /nqa qol to turn options on later.' });
  // 30 s on, nothing changed by itself.
  vm.advance(30);
  assert.equal(vm.evaluate('NS.HUD.h.label.text'), 'Quality of Life');
  assert.equal(vm.evaluate('NQADB.settings.qolAccept'), 'false');
  // Uncheck Auto Sell Junk (the game's check box sound), then Turn On.
  vm.run('STUB.played = {}; local c = NS.HUD.h.qolChecks[5]; c.scripts.OnClick(c)');
  assert.equal(vm.evaluate('NS.HUD.h.qolChecks[5].checked'), 'false');
  assert.deepEqual(vm.list('STUB.played'), [857]);
  vm.advance(1);
  vm.run('local b = NS.HUD.h.qolOn; b.scripts.OnClick(b)');
  assert.deepEqual(['qolAccept', 'qolTurnIn', 'qolSkip', 'qolJunk'].map(k => vm.evaluate(`NQADB.settings.${k}`)), ['true', 'true', 'true', 'false']);
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1');
  assert.equal(vm.evaluate('NQADB.qolAsked'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.label.shown'), 'false', 'the block is gone');
  assert.deepEqual(vm.chatLines().filter(l => l.includes(' on.')), [B + 'Auto Loot, Auto Accept Quests, Auto Turn In Quests and Auto Skip to Quests are on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change them.']);
  // It never comes back, after a /reload too.
  const again = hello(reloadVM(vm).login());
  assert.equal(again.evaluate('NS.HUD.View().mode'), 'idle');
});

test('Turn On with Auto Loot alone says its own key, never Shift for windows none of which are on', () => {
  for (const [key, name] of [['SHIFT', 'Shift'], ['CTRL', 'Ctrl']]) {
    const vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true, extra: `QS.lootKey = "${key}"` });
    vm.run('for i = 2, 5 do local c = NS.HUD.h.qolChecks[i]; c.scripts.OnClick(c) end');
    vm.advance(1);
    vm.run('local b = NS.HUD.h.qolOn; b.scripts.OnClick(b)');
    assert.equal(vm.said(`Auto Loot is on. Hold ${name} as you loot to pick items yourself. Type /nqa qol to change it.`), 1, vm.chatLines().join('\n'));
  }
});

test('Turn On with one of the addon\'s own options says it in the singular, with Shift for its windows', () => {
  const vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  vm.run('for i = 1, 4 do local c = NS.HUD.h.qolChecks[i]; c.scripts.OnClick(c) end');
  vm.advance(1);
  vm.run('local b = NS.HUD.h.qolOn; b.scripts.OnClick(b)');
  assert.equal(vm.said('Auto Sell Junk is on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change it.'), 1, vm.chatLines().join('\n'));
  assert.equal(vm.evaluate('tostring(NQADB.settings.qolJunk)'), 'true');
  assert.equal(vm.evaluate('tostring(NQADB.settings.qolAccept)'), 'false');
});

test('the step offers only what it can turn on: the game\'s settings already on aren\'t in it, nor Auto Loot without a loot key; another loot key is named', () => {
  let vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: 'STUB.cvars.autoLootDefault = "1"', ready: true });
  assert.deepEqual(vm.list(STEP_ROWS), ['Auto Accept Quests [x]', 'Auto Turn In Quests [x]', 'Auto Skip to Quests [x]', 'Auto Sell Junk [x]']);
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Click Turn On and these finish the quest and vendor windows you open. Hold Shift as you open one to finish it yourself.');
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: 'QS.lootKey = "NONE"', ready: true });
  assert.ok(!vm.list(STEP_ROWS).includes('Auto Loot [x]'), 'no loot key: Auto Loot would leave no way to loot by hand');
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: 'QS.lootKey = "CTRL"', ready: true });
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'Click Turn On and these finish the quest, loot and vendor windows you open. Hold Shift (Ctrl for loot) as you open one to finish it yourself.');
});

test('the step: Skip changes nothing; all unchecked says why Turn On waits; it waits for a fight, the first reply\'s session, and shows in the one after', () => {
  let vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  vm.run('local b = NS.HUD.h.qolSkip; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('NQADB.qolAsked'), 'true');
  assert.deepEqual(['qolAccept', 'qolJunk'].map(k => vm.evaluate(`NQADB.settings.${k}`)), ['false', 'false']);
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '0');
  assert.equal(vm.said('Nothing changed. Type /nqa qol to turn options on later.'), 1);
  // All unchecked: Turn On is disabled, and a line says why.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  vm.run('for i = 1, 5 do local c = NS.HUD.h.qolChecks[i]; c.scripts.OnClick(c) end');
  assert.equal(vm.evaluate('NS.HUD.h.qolOn.disabled'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.qolWhy.text'), 'Pick an option first, or click Skip.');
  assert.equal(vm.evaluate('NS.HUD.h.qolWhy.shown'), 'true');
  // The setup block first; the first reply puts the step off to a later session (no card in
  // the session of the first reply, T4); the next session offers it.
  vm = world({ db: 'NQADB = {}', ready: true });
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'setup');
  vm.run(`NS.Transport.HandleSlotData({ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.4.1", push = 0, acked = {} },
    gw = { state = "ready", queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {},
    records = { { seq = 1, t = "reply", chat = NQADB.activeChat, mid = "m-1", agent = "main", text = "Hi, I'm NeverQuestAlone.", summary = "", more = 0 } } }, "slot")`);
  vm.run('NS.HUD.Okay()');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'idle', 'not in the first reply\'s session');
  assert.equal(hello(reloadVM(vm).login()).evaluate('NS.HUD.View().mode'), 'qol', 'the next session');
  // In a fight the HUD is one line: the block waits, untouched.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  vm.run('STUB.combat = true; NS.R.inCombat = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'false');
  vm.run('STUB.combat = false; NS.R.inCombat = false; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.label.text'), 'Quality of Life');
  // The public build holds it in the UI session of the first reply (T4).
  vm.run('NS.R.qolHold = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'idle');
});

// The bridge's last word as the game reads it at login (Inbox.lua), age seconds old.
const INBOX = (age, gw = 'ready') => `NQA_Inbox = { v = 2, ts = "x", now = time() - ${age}, token = "old", bridge = { ver = "1.4.1", push = 0, acked = {} }, gw = { state = "${gw}", restartIn = 30 }, agents = {}, chats = {}, records = {} }`;

test('the step\'s showing is decided once a session: there from the first frame (an old inbox\'s red is the login\'s normal start) and never folding; a known problem holds it for the session; typing or death puts it aside', () => {
  const height = vm => vm.num('NQAHUD:GetHeight()');
  // The renderer's text metrics (tests/render_ui.js), so heights are the panel's own.
  const METRICS = fs.readFileSync(path.join(HERE, 'render_ui.js'), 'utf8').match(/const METRICS = `([\s\S]*?)`;/)[1];
  // No inbox, or one an hour old (the bridge's last word before an idle evening): red, yet the step from the first frame, and the same height once the hello is answered.
  for (const [what, inbox] of [['no inbox', undefined], ['an inbox an hour old', INBOX(3600)], ['an inbox 30 s old', INBOX(30)]]) {
    const vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', inbox, extra: METRICS });
    assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol', `${what}: the first frame`);
    assert.deepEqual(['label', 'qolOn'].map(k => vm.evaluate(`NS.HUD.h.${k}.shown`)), ['true', 'true'], what);
    const h = height(vm);
    hello(vm);
    assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol', what);
    // Only main's header may change (a red status's second line goes); nothing lands.
    assert.ok(height(vm) <= h, `${what}: nothing popped in when the hello was answered (${h} then ${height(vm)})`);
  }
  // Once shown, whatever the connection or a flash does, it stays.
  let vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true });
  for (const light of ['red', 'grey', 'yellow', 'wait']) {
    vm.run(`LIGHT = NS.Transport.Light; NS.Transport.Light = function() return "${light}" end`);
    assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol', `${light}: once shown, it stays`);
    vm.run('NS.Transport.Light = LIGHT');
  }
  vm.run('NS.HUD.Flash("Not sent")');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol', 'a failed send\'s flash doesn\'t fold it');
  vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")');
  assert.notEqual(vm.evaluate('NS.HUD.View().mode'), 'qol', 'typing a question: the player\'s click');
  // A known problem at its first chance (a fresh inbox: the app's AI not ready, no key or a rejected one): held for the session, never landing by itself; the next session shows it.
  for (const gw of ['no_key', 'key_invalid']) {
    vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', inbox: INBOX(20, gw) });
    assert.notEqual(vm.evaluate('NS.HUD.View().mode'), 'qol', gw);
    hello(vm);
    assert.notEqual(vm.evaluate('NS.HUD.View().mode'), 'qol', `${gw}: still held once it clears`);
    assert.equal(vm.said('Quality of Life is new in Settings, with options for quests, loot and vendors. Nothing changes until you turn one on. Type /nqa qol to see them.'), 1, `${gw}: the once-ever line says where it is`);
    const next = hello(reloadVM(vm).login());
    assert.equal(next.evaluate('NS.HUD.View().mode'), 'qol', `${gw}: the next session`);
    assert.equal(next.chatLines().filter(l => l.includes('Quality of Life is new')).length, 0, `${gw}: said once ever`);
  }
  // The bridge silent after this session's hello was answered: a known problem too.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true, qolAsked = true }', ready: true });
  vm.run('NQADB.qolAsked = nil; NS.Transport.Light = function() return "red" end');
  assert.notEqual(vm.evaluate('NS.HUD.View().mode'), 'qol');
  // Dead or a ghost.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true, extra: 'function UnitIsDeadOrGhost(u) return u == "player" and QS.dead == true end' });
  vm.run('QS.dead = true');
  assert.notEqual(vm.evaluate('NS.HUD.View().mode'), 'qol', 'dead or a ghost');
  vm.run('QS.dead = false');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol');
});

test('the step\'s block keeps its budget with the renderer\'s metrics and five rows: 232 units from its label down (249 with none checked), plus the 12-unit gaps above and below, with either loot key', () => {
  const METRICS = fs.readFileSync(path.join(HERE, 'render_ui.js'), 'utf8').match(/const METRICS = `([\s\S]*?)`;/)[1];
  // Measured from the header's end (mainY), not against the idle HUD, whose
  // own "No route yet" block (0.4.7) would hide 83 units of slack.
  const block = vm => vm.num('NQAHUD:GetHeight()') - vm.num('NS.HUD.h.mainY');
  for (const [what, key] of [['Shift loots', ''], ['Ctrl loots', 'function GetModifiedClick(k) if k == "AUTOLOOTTOGGLE" then return "CTRL" end return "SHIFT" end']]) {
    const step = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true, extra: METRICS + '\n' + key });
    assert.equal(step.evaluate('NS.HUD.View().mode'), 'qol', what);
    assert.equal(step.list('NS.QoL.Offered()').length, 5, `${what}: five rows`);
    const checked = block(step);
    assert.ok(checked <= 12 + 232 + 12, `${what}: ${checked} under the header`);
    step.run('for _, k in ipairs(NS.QoL.Offered()) do NS.QoL.Tick(k) end NS.HUD.Render()');
    assert.ok(block(step) <= 12 + 249 + 12, `${what}, none checked: ${block(step)} under the header`);
    assert.ok(block(step) > checked, `${what}: the gray line shows`);
  }
});

test('Show More in a fight brings up the step (main 0.4.8): Turn On there waits for the fight\'s end to change Auto Loot', () => {
  const vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', ready: true, extra: 'STUB.cvars.autoLootDefault = "0"; LOCK = false; function InCombatLockdown() return LOCK end' });
  vm.run('LOCK = true; NS.R.inCombat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED"); NS.HUD.Render()');
  assert.equal(vm.evaluate('tostring(NS.HUD.View().bar)'), 'true', 'a fight folds it to the bar');
  const items = vm.evaluate('(function() local t = {} NS.UI.PopupMenu = function(a, title, list) for _, it in ipairs(list) do t[#t + 1] = it[1]; MENU = MENU or {}; MENU[it[1]] = it[2] end end NS.HUD.Menu(NQAHUDBar) return table.concat(t, " | ") end)()');
  assert.match(items, /Show More/);
  vm.run('MENU["Show More"](); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol', 'the panel, with the step');
  vm.run('local b = NS.HUD.h.qolOn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '0', 'not in the fight');
  vm.run('LOCK = false; NS.R.inCombat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('STUB.cvars.autoLootDefault'), '1', 'at its end');
});

test('where the step can\'t show (the HUD closed, off, the bar or the compass), one line, once ever, says where it is; /nqa qol answers it; nothing opens by itself', () => {
  const closed = 'Quality of Life is new in Settings, with options for quests, loot and vendors. Nothing changes until you turn one on. Type /nqa qol to see them.';
  const small = 'Quality of Life is new, with options for quests, loot and vendors. Nothing changes until you turn one on. Click Show More in the HUD\'s right-click menu to see them, or type /nqa qol.';
  const compass = 'Quality of Life is new, with options for quests, loot and vendors. Nothing changes until you turn one on. Click Show More twice in the HUD\'s right-click menu to see them, or type /nqa qol.';
  let vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true, settings = { hud = false } }' });
  vm.fire('PLAYER_ENTERING_WORLD', 'true', 'false');
  vm.fire('PLAYER_ENTERING_WORLD', 'false', 'false');
  vm.fire('PLAYER_ENTERING_WORLD', 'false', 'true');
  assert.equal(vm.said(closed), 1);
  assert.equal(vm.evaluate('NQADB.qolTold'), 'true');
  const again = reloadVM(vm).login();
  again.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  assert.equal(again.chatLines().filter(l => l.includes('Quality of Life is new')).length, 0, 'once ever: not after a /reload');
  // The bar; the compass (its Show More gives the bar first).
  for (const [form, line] of [['hudMin = true', small], ['hudMin = true, hudCompass = true', compass]]) {
    vm = world({ db: `NQADB = { hudIntro = true, firstReply = true, settings = { hud = true, ${form} } }` });
    vm.fire('PLAYER_ENTERING_WORLD', 'true', 'false');
    assert.equal(vm.said(line), 1, form);
  }
  // The whole HUD shows the step itself.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }' });
  vm.fire('PLAYER_ENTERING_WORLD', 'true', 'false');
  assert.ok(!vm.chatLines().some(l => l.includes('Quality of Life is new')));
  // /nqa qol opens Settings at the section, and that answers the step.
  vm = world({ db: 'NQADB = { hudIntro = true, firstReply = true }', settings: true, ready: true });
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'qol');
  vm.slash('qol');
  assert.equal(vm.evaluate('NQADB.qolAsked'), 'true');
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'idle');
  assert.equal(vm.evaluate('STUB.openedAt'), 'Quality of Life');
});

// ---------------------------------------------------------------------------
// Tooltips.Gain: the verdict's slots, as a number
// ---------------------------------------------------------------------------

test('Tooltips.Gain scores against what you wear by the verdict\'s slots: both hands for a two-hander, the weaker ring, an empty slot as 0; stats not loaded are "still loading"', () => {
  const vm = world();
  vm.run(`
    QS.items[1] = { equipLoc = "INVTYPE_2HWEAPON", stats = { ITEM_MOD_STRENGTH_SHORT = 20 } }
    QS.items[2] = { equipLoc = "INVTYPE_WEAPON", stats = { ITEM_MOD_STRENGTH_SHORT = 6 } }
    QS.items[3] = { equipLoc = "INVTYPE_SHIELD", stats = { ITEM_MOD_STRENGTH_SHORT = 5 } }
    QS.items[4] = { equipLoc = "INVTYPE_FINGER", stats = { ITEM_MOD_STRENGTH_SHORT = 4 } }
    QS.items[5] = { equipLoc = "INVTYPE_FINGER", stats = { ITEM_MOD_STRENGTH_SHORT = 1 } }
    QS.items[6] = { equipLoc = "INVTYPE_FINGER", stats = { ITEM_MOD_STRENGTH_SHORT = 3 } }
    QS.items[7] = { equipLoc = "INVTYPE_HEAD" }
    L = function(id) return "|cffffffff|Hitem:" .. id .. "::::::::20:::::|h[I" .. id .. "]|h|r" end
    QS.worn[16], QS.worn[17] = L(2), L(3)
    QS.worn[11], QS.worn[12] = L(5), L(6)
    W = { str = 1 }`);
  assert.equal(vm.num('NS.Tooltips.Gain(L(1), W)'), 20 - (6 + 5), 'a two-hander against both hands');
  assert.equal(vm.num('NS.Tooltips.Gain(L(4), W)'), 4 - 1, 'a ring against the weaker one');
  vm.run('QS.worn[12] = nil');
  assert.equal(vm.num('NS.Tooltips.Gain(L(4), W)'), 4, 'an empty ring slot counts 0');
  vm.run('QS.worn[16] = L(1); QS.worn[17] = nil');
  assert.equal(vm.evaluate('NS.Tooltips.Gain(L(3), W)'), null, 'a shield beside a two-hander: no');
  assert.equal(vm.evaluate('NS.Tooltips.Gain("not a link", W)'), null);
  assert.equal(vm.evaluate('select(2, NS.Tooltips.Gain(L(7), W))'), 'true', 'gear whose stats haven\'t loaded: still loading, never "no upgrade"');
});

// ---------------------------------------------------------------------------
// The source: what QoL.lua may call, and nothing that crosses the line
// ---------------------------------------------------------------------------

test('the source: the addon names no targeting, looting, rolling, gossip-option, item-use or movement API; QoL.lua\'s actions are the allowed ones', () => {
  const code = {};
  for (const f of fs.readdirSync(ADDON).filter(f => f.endsWith('.lua'))) {
    code[f] = fs.readFileSync(path.join(ADDON, f), 'utf8').replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, '');
  }
  const never = new RegExp(`\\b(${NEVER.join('|')}|SelectOption|SelectOptionByIndex|RepairAllItems\\s*\\(\\s*true)\\b`);
  for (const [f, src] of Object.entries(code)) assert.doesNotMatch(src, never, f);
  // QoL.lua opens no dialog of the game's and answers none (UI.lua's own dialogs are its business).
  assert.doesNotMatch(code['QoL.lua'], /\bStaticPopup/, 'QoL.lua');
  // Every call QoL.lua makes that changes something in the game.
  const acts = new Set();
  for (const m of code['QoL.lua'].matchAll(/\b(AcceptQuest|CompleteQuest|GetQuestReward|SelectActiveQuest|SelectAvailableQuest|SellAllJunkItems|UseContainerItem|RepairAllItems|SetCVar)\s*\(/g)) acts.add(m[1]);
  assert.deepEqual([...acts].sort(), ['AcceptQuest', 'CompleteQuest', 'GetQuestReward', 'RepairAllItems', 'SelectActiveQuest', 'SelectAvailableQuest', 'SellAllJunkItems', 'SetCVar']);
  assert.doesNotMatch(code['QoL.lua'], /\b(C_Timer|OnUpdate|hooksecurefunc)\b/, 'no timers, no polling, no hooks');
  assert.doesNotMatch(code['QoL.lua'], /\bSetCVar\s*\(\s*"(?!autoLootDefault|autoQuestWatch)/, 'no CVar but the two by name');
  const cvars = [...code['QoL.lua'].matchAll(/(\w+)\s*=\s*"(auto\w+)"/g)].map(m => m[2]);
  assert.deepEqual(cvars.sort(), ['autoLootDefault', 'autoQuestWatch']);
  // Nothing outside QoL.lua calls its actions.
  for (const [f, src] of Object.entries(code)) {
    if (f === 'QoL.lua') continue;
    assert.doesNotMatch(src, /\b(AcceptQuest|CompleteQuest|GetQuestReward|SellAllJunkItems|RepairAllItems)\s*\(/, f);
  }
});

// ---------------------------------------------------------------------------
// The game's Lua is 5.1: the same walk-through in LuaJIT gives the same calls and lines
// ---------------------------------------------------------------------------

const luajit = spawnSync('luajit', ['-v'], { encoding: 'utf8' });
const WALK = `
OUT = {}
STUB.FireEvent("ADDON_LOADED", "NeverQuestAlone")
STUB.FireEvent("PLAYER_LOGIN")
for _, k in ipairs({ "loot", "qolAccept", "qolTurnIn", "qolSkip", "qolJunk", "qolRepair" }) do NS.QoL.Set(k, true) end
NS.QoL.SetRewards("sell")
QS.calls = {}
QS.q.autoAccept = true
STUB.FireEvent("QUEST_DETAIL", 0)
QS.q.autoAccept = false
STUB.FireEvent("QUEST_FINISHED")
QS.q.objectives = "Escort Gilthares Firebough back to Ratchet."
STUB.FireEvent("QUEST_DETAIL", 0)
QS.q.objectives = nil
STUB.FireEvent("QUEST_FINISHED")
QS.q.id, QS.q.title = 5162, "Wrath of the Blue Flight"
STUB.FireEvent("QUEST_DETAIL", 0)
STUB.FireEvent("QUEST_FINISHED")
QS.q.id, QS.q.title = 871, "Disrupt the Attacks"
STUB.FireEvent("QUEST_DETAIL", 0)
STUB.FireEvent("QUEST_ACCEPTED", 871)
STUB.FireEvent("QUEST_FINISHED")
QS.g.active = { { questID = 766, title = "Swoop Hunting", isComplete = true, isIgnored = false } }
QS.logCount, QS.log[766] = 20, true
STUB.FireEvent("GOSSIP_SHOW")
STUB.FireEvent("GOSSIP_CLOSED", true)
QS.q.id, QS.q.title = 766, "Swoop Hunting"
QS.items[4760] = { classID = 12 }
QS.q.required = { ${item(4760, 'Trophy Swoop Quill', 'count = 8')} }
STUB.FireEvent("QUEST_PROGRESS")
QS.q.choices = { ${item(101, 'Rugged Boots')}, ${item(102, 'Healing Potion', 'count = 5')} }
QS.prices[101], QS.prices[102] = 150, 40
STUB.FireEvent("QUEST_COMPLETE")
STUB.FireEvent("QUEST_TURNED_IN", 766, 450, 0)
STUB.FireEvent("QUEST_FINISHED")
QS.q.id, QS.q.title, QS.q.required, QS.q.choices = 767, "Swoop Hunting II", {}, {}
STUB.FireEvent("QUEST_DETAIL", 0)
QS.logCount, QS.log[766], QS.log[767] = 20, nil, true
STUB.FireEvent("QUEST_ACCEPTED", 767)
STUB.FireEvent("QUEST_FINISHED")
QS.q.id, QS.q.title = 768, "Swoop Hunting III"
STUB.FireEvent("QUEST_DETAIL", 0)
STUB.FireEvent("QUEST_FINISHED")
QS.bags[0] = { { itemID = 4865, quality = 0, stackCount = 2, hasNoValue = false, isLocked = false } }
QS.prices[4865] = 55
QS.m.junk, QS.m.cost, STUB.money = 1, 12400, 12345
QS.npc = "Creature-0-1-1-1-9-0000000C"
STUB.FireEvent("MERCHANT_SHOW")
STUB.money = 12455
STUB.FireEvent("PLAYER_MONEY")
STUB.money = 12600
STUB.FireEvent("PLAYER_MONEY")
STUB.FireEvent("MERCHANT_CLOSED")
QS.npc, QS.questnpc = "Creature-0-1-1-1-2-0000000B", "Creature-0-1-1-1-2-0000000B"
QS.q.id, QS.q.title, QS.logCount = 900, "Straight On", 19
STUB.FireEvent("QUEST_DETAIL", 0)
OUT.calls = table.concat(QS.calls, "|")
OUT.last = table.concat(NS.QoL.Last(), "|")
OUT.chat = table.concat(STUB.chat, "|")
OUT.words = NS.QoL.Describe("loot") .. "|" .. NS.QoL.Coins(1234567) .. "|" .. NS.QoL.Coins(0) .. "|" .. NS.QoL.Describe("qolJunk")
`;

test('Lua 5.1 (LuaJIT): a walk through every option gives the same calls, log and chat lines as the test VM', { skip: luajit.status === 0 ? false : 'luajit is not installed (brew install luajit)' }, () => {
  const bracket = src => { let eq = ''; while (src.includes(`]${eq}]`)) eq += '='; return `[${eq}[\n${src}]${eq}]`; };
  const program = [
    'local WRITE = io.write',
    fs.readFileSync(path.join(HERE, 'wow_stub.lua'), 'utf8') + STUB_METHODS,
    EXTRA,
    'math.randomseed(7)',
    ...['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act'].map(f => `STUB.sounds[${JSON.stringify(SIG + 'ctl\\' + f + '.wav')}] = true`),
    WORLD,
    WELCOMED,
    'NS = {}',
    ...tocFiles().map(f => `assert(loadstring(${bracket(fs.readFileSync(path.join(ADDON, f), 'utf8'))}, "@NeverQuestAlone/${f}"))("NeverQuestAlone", NS)`),
    VM_TRAPS,
    TRAPS,
    WALK,
    'for _, k in ipairs({ "calls", "last", "chat", "words" }) do WRITE(k, "\\t", (OUT[k] or "<nil>"):gsub("\\n", "\\\\n"), "\\n") end',
  ].join('\n');
  const r = spawnSync('luajit', ['-'], { input: program, encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, `luajit failed:\n${r.stderr}`);
  const jit = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => { const i = l.indexOf('\t'); return [l.slice(0, i), l.slice(i + 1)]; }));
  const vm = newVM({ db: WELCOMED, extra: WORLD, before: TRAPS });
  vm.run(WALK, 'walk');
  for (const k of ['calls', 'last', 'chat', 'words']) assert.equal(jit[k], vm.evaluate(`(OUT.${k}:gsub("\\n", "\\\\n"))`), `${k} differs between LuaJIT and fengari`);
  // The last AcceptQuest: a quest giver clicked straight from the vendor (QC-09).
  assert.equal(jit.calls, 'AcceptQuest|SelectActiveQuest 766|CompleteQuest|GetQuestReward 2|AcceptQuest|SellAllJunkItems|RepairAllItems nil|AcceptQuest');
  // Swoop Hunting II: the follow-up the game chains to the hand-in, the log at its cap until the hand-in lands.
  // Swoop Hunting III, next in that conversation: the log is full again, since II took the room the hand-in freed (QC-14).
  assert.equal(jit.last, 'Auto Repair paid 1g 24s to repair your gear.|Auto Sell Junk sold 1 gray item for 1s 10c.|Auto Accept Quests left Swoop Hunting III to you because your quest log is full.|Auto Accept Quests accepted Swoop Hunting II.|Quest Rewards took Healing Potion, which has the highest sell price (2s), as the reward for Swoop Hunting.');
  // The quest the game took itself: its page left for the player's click on Accept, with its line.
  assert.ok(jit.chat.includes(`${B}${GAME('Disrupt the Attacks')}`), jit.chat);
});

// C-117 (nqa-ui-critic R54): the step's checks and Turn On never move by
// themselves. The header can grow with nobody clicking (red after 121 s with the
// bridge silent; a flash whose status wraps), so the step lays out for the
// header at its tallest.
test('the step holds still: Turn On keeps its place while the header goes red or a flash comes and goes (C-117)', () => {
  const METRICS = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'render_ui.js'), 'utf8').match(/const METRICS = `([\s\S]*?)`;/)[1];
  const y = vm => vm.json('{ NS.HUD.h.qolOn.points.TOPLEFT.y }')[0];
  // The bridge never answers: "Connecting…", then red at 121 s.
  const silent = newVM({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: WORLD + METRICS }).login();
  let t = 0;
  const seen = [];
  for (const at of [0.5, 60, 119.5, 121, 125]) {
    silent.advance(at - t); t = at;
    silent.run('NS.HUD.Render()');
    assert.equal(silent.evaluate('NS.HUD.View().mode'), 'qol');
    seen.push(y(silent));
  }
  assert.equal(silent.evaluate('NS.Transport.Light()'), 'red', 'the header did go red');
  assert.deepEqual(seen, Array(5).fill(seen[0]), `Turn On at ${seen.join(', ')}`);
  // The bridge answers; a flash whose status wraps comes and goes.
  const vm = newVM({ db: 'NQADB = { hudIntro = true, firstReply = true }', extra: WORLD + METRICS }).login();
  vm.advance(3.1);
  vm.slot(`{ v = 2, ts = "x", now = time(), token = NQADB.token, bridge = { ver = "1.4.1", push = 0, nonce = "${vm.evaluate('NS.R.nonce')}", acked = {} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {}, records = {} }`);
  vm.signal('ctl', 'bell_push_a', false); vm.run('NS.Transport.Poll()'); vm.signal('ctl', 'bell_push_a', true); vm.run('NS.Transport.Poll()');
  vm.run('STUB.onLoadAddOn = nil'); vm.advance(0.3); vm.run('NS.HUD.Render()');
  const ready = y(vm);
  vm.run('NS.Transport.Warn("live", "Replies still arrive, more slowly.", "Replies come slower this session")');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Replies come slower this session');
  assert.equal(y(vm), ready, 'a flash leaves Turn On where it was');
  vm.advance(30); vm.run('NS.HUD.Render()');
  assert.equal(y(vm), ready, 'and so does its end');
  assert.equal(ready, seen[0], 'one place in every state');
});
