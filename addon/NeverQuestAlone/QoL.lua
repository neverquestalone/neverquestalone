-- QoL.lua: Quality of Life, the player's own options for the clicks WoW asks
-- for all night. Each is a switch in Settings (its "Quality of Life" section,
-- Settings.lua), and the HUD offers five of them once, in one step (HUD.lua).
-- The addon's own options start off; the game's own two keep the game's
-- values (Auto Track Quests is on by the game's default).
--   Auto Loot                  the game's own Auto Loot (the autoLootDefault CVar)
--   Auto Accept Quests         a quest a quest giver shows you
--   Auto Turn In Quests        a finished quest, at its quest giver
--   Quest Rewards              Your Pick (default), Best Upgrade, Highest Price
--   Auto Skip to Quests        a greeting that offers only quests opens yours
--   Auto Sell Junk             your gray items, when you open a vendor
--   Auto Repair                your gear, with your own gold, at a vendor who repairs
--   Auto Track Quests          the game's own quest tracking (the autoQuestWatch CVar)
--
-- The line it never crosses (PRD DB28, PO-10 to PO-13): nothing acts without
-- this player's own click or key press on that window. It only finishes a
-- conversation the player's own click opened (a quest giver's pages in turn,
-- a body or chest, a vendor), and only in the ways above; a quest another
-- player shares opens without this player's click, so it's always theirs to
-- answer. It answers none of the game's own questions (a gold hand-in, a PvP
-- flag, another player's escort, a bind on pickup, a loot roll) but one: Auto
-- Sell Junk is the player's standing yes to the vendor's Sell All Junk
-- question, and says so. It never moves, targets, attacks, casts, uses an
-- item, picks a gossip option, rolls on loot, talks to anyone or acts while
-- the player is away, and never takes a quest whose acceptance starts
-- something (an escort, a fight, a flight, a teleport, an event, a timer),
-- nor hands in one whose hand-in starts a fight, a flight or a teleport
-- (STARTS and HANDIN, generated from the emulator's quest scripts). Nothing
-- outside the game (the bridge, the app, a reply, a chip) changes a switch:
-- only the player's clicks here, in Settings, and /bones qol. Shift held as a
-- page opens leaves that conversation, and one the game chains to it, to the
-- player.
-- Every call it makes exists for camelot at wow-ui-source bd2470a
-- (Blizzard_UIPanels_Game/Mainline/QuestFrame.lua, GossipFrameShared.lua,
-- MerchantFrame.lua) and none is marked protected there; protection, taint
-- and combat are checked in game (PRD B3.15). No Blizzard frame is touched.
-- Events are registered only while an option needs them; nothing polls.

local _, ns = ...
local Q = {}
ns.QoL = Q
local R = ns.R
local Try = ns.Try

-- The options this addon runs, saved in ns.db.settings (all off to start).
Q.OWN = { "qolAccept", "qolTurnIn", "qolSkip", "qolJunk", "qolRepair" }
-- The game's own settings two switches stand for. Forever's Options show Auto
-- Loot (Controls) but not quest tracking (Blizzard_ObjectiveTracker.lua:35).
Q.CVARS = { loot = "autoLootDefault", track = "autoQuestWatch" }
Q.REWARDS = { you = true, bones = true, sell = true }
-- The step's one-click set: nothing in it spends your gold (Auto Repair stays
-- in Settings; Quest Rewards stays Your Pick).
Q.ONBOARD = { "loot", "qolAccept", "qolTurnIn", "qolSkip", "qolJunk" }

Q.LABELS = {
	loot = "Auto Loot", qolAccept = "Auto Accept Quests", qolTurnIn = "Auto Turn In Quests", qolSkip = "Auto Skip to Quests",
	qolJunk = "Auto Sell Junk", qolRepair = "Auto Repair", track = "Auto Track Quests",
	qolRewards = "Quest Rewards",
}
-- One sentence each (docs/STYLE.md §3): what it does, and the way to do it by
-- hand. Auto Loot's names the game's own loot key (Q.Describe).
Q.DESCRIPTIONS = {
	qolAccept = "Accepts the quest a quest giver shows you, but not low-level, group, escort, timed or PvP quests, or ones that start a fight; hold Shift as you talk to the quest giver to decide yourself.",
	qolTurnIn = "Hands in a finished quest at its quest giver, unless it costs gold or items that aren't quest items, or starts a fight; hold Shift as you talk to the quest giver to do it yourself.",
	qolRewards = "Which reward Auto Turn In Quests takes when a quest offers a choice.",
	qolSkip = "Skips a greeting that offers only quests, opening your finished quest or the only new one; hold Shift as you talk to the quest giver to see it.",
	qolJunk = "Sells your gray items when you open a vendor, as its Sell All Junk Items button does but without asking, and the last 12 stay on its Buyback tab; hold Shift as you open it to sell by hand.",
	qolRepair = "Repairs all your gear with your own gold when you open a vendor who repairs; hold Shift as you open the vendor to repair by hand.",
	track = "Tracks each quest you accept or make progress on (the game's own setting); hold Shift as you click one in your quest log to untrack it until you make progress again.",
}
-- Quest Rewards' three rules, one sentence each: the tooltips of their three
-- rows in Settings ("Quest Rewards: Your Pick", Settings.lua). Each starts
-- with what the rule is for (C-122): the Options search shows a row without
-- Auto Turn In Quests above it, grayed while that's off.
Q.REWARD_TIPS = {
	you = "When a quest offers a choice of rewards, Auto Turn In Quests leaves the pick to you.",
	bones = "When a quest offers a choice of rewards, Auto Turn In Quests takes the biggest upgrade for your build by NeverQuestAlone's stat weights, and sends nothing; with no weights, no upgrade or a tie, you pick.",
	sell = "When a quest offers a choice of rewards, Auto Turn In Quests takes the one that sells for the most at a vendor, counting a stack, even one you can't use; with a tie, you pick.",
}
-- An option turned on in Settings says how to do it by hand (docs/STYLE.md
-- §14: never only in a tooltip). Auto Loot's names the game's loot key (LootOn).
local ON = {
	qolAccept = "Auto Accept Quests is on. Hold Shift as you talk to a quest giver to decide yourself.",
	qolTurnIn = "Auto Turn In Quests is on. Hold Shift as you talk to a quest giver to do it yourself.",
	qolSkip = "Auto Skip to Quests is on. Hold Shift as you talk to a quest giver to see the greeting.",
	qolJunk = "Auto Sell Junk is on. Hold Shift as you open a vendor to sell by hand.",
	qolRepair = "Auto Repair is on. Hold Shift as you open a vendor to repair by hand.",
	track = "Auto Track Quests is on. Hold Shift as you click a quest in your quest log to untrack it until you make progress again.",
}

-- Why a quest waits for you: each a whole line (docs/STYLE.md §12), %s the
-- quest's name.
local LEFT = {
	qolAccept = {
		pvp = "Auto Accept Quests left %s to you because it flags you for PvP.",
		full = "Auto Accept Quests left %s to you because your quest log is full.",
		escort = "Auto Accept Quests left %s to you because it's an escort quest.",
		fight = "Auto Accept Quests left %s to you because accepting it starts a fight.",
		event = "Auto Accept Quests left %s to you because accepting it starts something right away.",
		flight = "Auto Accept Quests left %s to you because accepting it starts a flight.",
		moves = "Auto Accept Quests left %s to you because accepting it teleports you.",
		timed = "Auto Accept Quests left %s to you because it has a time limit.",
		group = "Auto Accept Quests left %s to you because it's a group quest.",
		dungeon = "Auto Accept Quests left %s to you because it's a dungeon quest.",
		raid = "Auto Accept Quests left %s to you because it's a raid quest.",
		pvpQuest = "Auto Accept Quests left %s to you because it's a PvP quest.",
		low = "Auto Accept Quests left %s to you because it's a low-level quest.",
		-- The game took it itself: its page has no Decline, and its Accept only
		-- closes it (QuestFrame.lua:551-589). Nothing was left undone.
		game = "The game already added %s to your quest log, so Auto Accept Quests has nothing to do. Click Accept to close its page.",
		-- In /bones qol last only (Left's quiet): pages it leaves without a word.
		other = "Auto Accept Quests left %s to you because its page opened just as another quest giver's reward page closed.",
		taken = "Auto Accept Quests left %s to you because it's already in your quest log.",
	},
	qolTurnIn = {
		gold = "Auto Turn In Quests left %s to you because handing it in costs gold.",
		currency = "Auto Turn In Quests left %s to you because handing it in costs a currency.",
		goods = "Auto Turn In Quests left %s to you because it takes items that aren't quest items.",
		again = "Auto Turn In Quests left %s to you because it's repeatable and takes items.",
		fight = "Auto Turn In Quests left %s to you because handing it in starts a fight.",
		flight = "Auto Turn In Quests left %s to you because handing it in starts a flight.",
		moves = "Auto Turn In Quests left %s to you because handing it in teleports you.",
		bags = "Auto Turn In Quests left %s to you because your bags don't have room for its rewards. Make room, then click Complete Quest.",
	},
}
-- Why Quest Rewards leaves a choice to you. %s is the quest's name.
local PICK = {
	weights = "Quest Rewards left the choice for %s to you because NeverQuestAlone has no stat weights for this character yet.",
	loading = "Quest Rewards left the choice for %s to you because some of its rewards haven't loaded yet.",
	noUpgrade = "Quest Rewards left the choice for %s to you because none of its rewards is an upgrade for your build.",
	tie = "Quest Rewards left the choice for %s to you because two of its rewards are equally good for your build.",
	noPrice = "Quest Rewards left the choice for %s to you because none of its rewards has a sell price.",
	samePrice = "Quest Rewards left the choice for %s to you because two of its rewards have the same sell price.",
}

-- BEGIN generated by tools/qol-quests/generate.mjs: don't edit by hand
-- From the emulator's quest scripts and hooks by generate.mjs's rules, with
-- reviewed.json's corrections (each checked on Wowhead Classic). Sources:
--   cmangos/classic-db Full_DB/ClassicDB_1_12_1_z2815.sql.gz@28ef625
--   cmangos/mangos-classic@8ec338a (ScriptDevAI quest hooks)
--   wago.tools FactionTemplate 1.15.9.69722 (who's hostile to whom)
--   wago.tools SpellEffect 1.15.9.69722 (which spells move you)
-- tools/qol-quests/README.md says how to refresh them.
-- Quests whose acceptance starts something: Auto Accept Quests leaves them
-- to you. 48 escorts, 24 fights, 1 flight, 1 teleport, 6 events, 23 timed.
-- An escort's tag (84), "escort" in its objectives or a time limit the
-- game reports counts too, for any this list misses.
local STARTS = {
	[28] = "timed", -- Trial of the Lake
	[29] = "timed", -- Trial of the Lake
	[68] = "fight", -- The Legend of Stalvan
	[74] = "fight", -- The Legend of Stalvan
	[155] = "escort", -- The Defias Brotherhood
	[212] = "timed", -- A Meal Served Cold
	[219] = "escort", -- Missing In Action
	[257] = "timed", -- A Hunter's Boast
	[258] = "timed", -- A Hunter's Challenge
	[309] = "escort", -- Protecting the Shipment
	[434] = "event", -- The Attack!
	[435] = "escort", -- Escorting Erland
	[452] = "fight", -- Pyrewood Ambush
	[590] = "fight", -- A Rogue's Deal
	[647] = "timed", -- MacKreel's Moonshine
	[648] = "escort", -- Rescue OOX-17/TN!
	[654] = "timed", -- Tanaris Field Sampling
	[660] = "escort", -- Hints of a New Plague?
	[665] = "escort", -- Sunken Treasure
	[667] = "fight", -- Death From Below
	[731] = "escort", -- The Absent Minded Prospector
	[778] = "fight", -- This Is Going to Be Hard
	[812] = "timed", -- Need for a Cure
	[836] = "escort", -- Rescue OOX-09/HL!
	[853] = "timed", -- Apothecary Zamah
	[863] = "escort", -- The Escape
	[898] = "escort", -- Free From the Hold
	[938] = "escort", -- Mist
	[945] = "escort", -- Therylune's Escape
	[976] = "escort", -- Supplies to Auberdine
	[994] = "escort", -- Escape Through Force
	[995] = "escort", -- Escape Through Stealth
	[1090] = "fight", -- Gerenzo's Orders
	[1119] = "timed", -- Zanzil's Mixture and a Fool's Stout
	[1120] = "timed", -- Get the Gnomes Drunk
	[1121] = "timed", -- Get the Goblins Drunk
	[1144] = "escort", -- Willix the Importer
	[1149] = "moves", -- Test of Faith
	[1173] = "fight", -- Challenge Overlord Mok'Morokk
	[1222] = "escort", -- Stinky's Escape
	[1249] = "fight", -- The Missing Diplomat
	[1270] = "escort", -- Stinky's Escape
	[1273] = "escort", -- Questioning Reethe
	[1324] = "fight", -- The Missing Diplomat
	[1393] = "escort", -- Galen's Escape
	[1440] = "escort", -- Return to Vahlarriel
	[1447] = "fight", -- The Missing Diplomat
	[1560] = "escort", -- Tooga's Quest
	[1640] = "fight", -- Beat Bartleby
	[1651] = "fight", -- The Tome of Valor
	[1699] = "timed", -- The Rethban Gauntlet
	[1719] = "timed", -- The Affray
	[1824] = "timed", -- Trial at the Field of Giants
	[1955] = "timed", -- The Exorcism
	[1957] = "fight", -- Mana Surges
	[2742] = "escort", -- Rin'ji is Trapped!
	[2767] = "escort", -- Rescue OOX-22/FE!
	[2845] = "escort", -- Wandering Shay
	[2863] = "timed", -- Alpha Strike
	[2904] = "escort", -- A Fine Mess
	[2969] = "escort", -- Freedom for All Creatures
	[3364] = "timed", -- Scalding Mornbrew Delivery
	[3367] = "escort", -- Suntara Stones
	[3382] = "fight", -- A Crew Under Fire
	[3522] = "timed", -- Iverron's Antidote
	[3525] = "fight", -- Extinguishing the Idol
	[3566] = "fight", -- Rise, Obsidion!
	[3843] = "timed", -- The Newest Member of the Family
	[3982] = "fight", -- What Is Going On?
	[4021] = "fight", -- Counterattack!
	[4023] = "fight", -- A Taste of Flame
	[4121] = "escort", -- Precarious Predicament
	[4245] = "escort", -- Chasing A-Me 01
	[4261] = "escort", -- Ancient Spirit
	[4322] = "escort", -- Jail Break!
	[4491] = "escort", -- A Little Help From My Friends
	[4770] = "escort", -- Homeward Bound
	[4901] = "escort", -- Guardians of the Altar
	[4904] = "escort", -- Free at Last
	[4961] = "timed", -- Cleansing of the Orb of Orahil
	[4966] = "fight", -- Protect Kanati Greycloud
	[5162] = "flight", -- Wrath of the Blue Flight
	[5203] = "escort", -- Rescue From Jaedenar
	[5321] = "escort", -- The Sleeper Has Awakened
	[5713] = "fight", -- One Shot. One Kill.
	[5821] = "escort", -- Bodyguard for Hire 
	[5943] = "escort", -- Gizelton Caravan
	[5944] = "escort", -- In Dreams
	[6132] = "escort", -- Get Me Out of Here!
	[6403] = "escort", -- The Great Masquerade
	[6482] = "escort", -- Freedom to Ruul
	[6523] = "escort", -- Protect Kaya
	[6544] = "escort", -- Torek's Assault
	[6622] = "event", -- Triage
	[6624] = "event", -- Triage
	[6641] = "escort", -- Vorsha the Lasher
	[7046] = "event", -- The Scepter of Celebras
	[7622] = "event", -- The Balance of Light and Shadow
	[8193] = "timed", -- Master Angler
	[8447] = "event", -- Waking Legends
	[8730] = "timed", -- Nefarius's Corruption
	[8736] = "fight", -- The Nightmare Manifests
	[9015] = "fight", -- The Challenge
}
Q.STARTS = STARTS
-- Quests whose hand-in starts a fight, a flight or a teleport: Auto Turn In Quests
-- leaves them to you. 13 fights, 0 flights, 4 teleports.
local HANDIN = {
	[254] = "fight", -- Digging Through the Dirt
	[349] = "fight", -- Stranglethorn Fever
	[410] = "fight", -- The Dormant Shade
	[502] = "fight", -- Elixir of Pain
	[619] = "fight", -- Enticing Negolash
	[652] = "fight", -- Breaking the Keystone
	[779] = "fight", -- Seal of the Earth
	[795] = "fight", -- Seal of the Earth
	[930] = "fight", -- The Glowing Fruit
	[3421] = "moves", -- Return Trip
	[3503] = "moves", -- Meeting with the Master
	[3567] = "moves", -- To the Top
	[4821] = "fight", -- Alien Egg
	[5058] = "fight", -- Mrs. Dalson's Diary
	[5059] = "fight", -- Locked Away
	[7786] = "fight", -- Thunderaan the Windseeker
	[8250] = "moves", -- Magecraft
}
Q.HANDIN = HANDIN
-- END generated

local QUEST_CLASS = 12 -- Enum.ItemClass.Questitem
local POOR = 0 -- Enum.ItemQuality.Poor
local EXCLUDE_JUNK = 64 -- Enum.BagSlotFlags.ExcludeJunkSell
-- Quest tags (QuestInfo ids; Enum.QuestTag names all but Escort, 84) that are
-- the player's call.
local ESCORT_TAG = 84
local TAG_WHY = { [1] = "group", [41] = "pvpQuest", [62] = "raid", [81] = "dungeon", [85] = "dungeon", [88] = "raid", [89] = "raid" }
local LOG_MAX = 5 -- the last things it did or left to you, for /bones qol last
-- A page the game opens right after one you took by hand (a follow-up
-- offered as the hand-in closes) stays yours: seconds.
local HAND_CARRY = 0.5

local function S() return ns.db and ns.db.settings end
local function P(s) return type(ns.P) == "function" and ns.P(s) or s end
local function Now() return tonumber((Try(GetTime))) or 0 end
-- An item's sell price in copper: C_Item.GetItemInfo's 11th return (past
-- ns.Try's seven), nil while the item isn't loaded yet.
local function SellPrice(item)
	if item == nil or not (C_Item and C_Item.GetItemInfo) then return nil end
	local ok, name, _, _, _, _, _, _, _, _, _, price = pcall(C_Item.GetItemInfo, item)
	if ok and name ~= nil then return tonumber(price) end
end
local function EnumValue(group, name, fallback)
	return type(Enum) == "table" and type(Enum[group]) == "table" and Enum[group][name] or fallback
end
local function Render()
	if ns.Settings and ns.Settings.Refresh then ns.Settings.Refresh() end
	if ns.HUD and ns.HUD.Render then ns.HUD.Render() end
end

local frame -- the event frame, below

---------------------------------------------------------------------------
-- The game's own two settings (CVars), changed outside combat only: a change
-- asked in a fight waits for its end.
---------------------------------------------------------------------------

local later = {} -- CVar name -> "1" or "0", until the fight ends

local function CVarRead(name)
	if C_CVar and C_CVar.GetCVar then return Try(C_CVar.GetCVar, name) end
	if GetCVar then return Try(GetCVar, name) end
end

local function CVarWrite(name, value)
	if C_CVar and C_CVar.SetCVar then return Try(C_CVar.SetCVar, name, value) end
	if SetCVar then return Try(SetCVar, name, value) end
end

-- This client has the setting (Settings and the step show only those).
function Q.HasCVar(key)
	return CVarRead(Q.CVARS[key]) ~= nil
end

function Q.CVarOn(key)
	local name = Q.CVARS[key]
	if later[name] then return later[name] == "1" end
	return CVarRead(name) == "1"
end

-- The game's own default, for the Settings row's default.
function Q.CVarDefault(key)
	return (C_CVar and C_CVar.GetCVarDefault and Try(C_CVar.GetCVarDefault, Q.CVARS[key])) == "1"
end

function Q.SetCVar(key, on)
	local name = Q.CVARS[key]
	if not name then return end
	local value = on and "1" or "0"
	if type(InCombatLockdown) == "function" and InCombatLockdown() then
		later[name] = value
		frame:RegisterEvent("PLAYER_REGEN_ENABLED")
		return
	end
	later[name] = nil
	CVarWrite(name, value)
end

-- The Settings page's Defaults at work (Blizzard_SettingsPanel.lua:451-460):
-- the game's own two keep their values then; the game's page resets them.
local function Defaulting()
	local panel = SettingsPanel
	if type(panel) ~= "table" or type(panel.CheckIsSettingDefaults) ~= "function" then return false end
	return Try(panel.CheckIsSettingDefaults, panel) and true or false
end

---------------------------------------------------------------------------
-- By hand: Shift held as a page opens (and for the rest of that conversation,
-- and a page the game chains to it), or away from the keyboard.
---------------------------------------------------------------------------

local function ByHand()
	if Try(IsShiftKeyDown) then R.qolByHand = true end
	if not R.qolByHand and R.qolHandUntil and Now() <= R.qolHandUntil then R.qolByHand = true end
	if R.qolByHand then return true end
	return Try(UnitIsAFK, "player") and true or false
end

-- One action of a kind per quest per conversation: a page that comes back (a
-- hand-in the server refused) never loops.
local function Once(kind, id)
	R.qolDone = R.qolDone or {}
	local done = R.qolDone[kind] or {}
	R.qolDone[kind] = done
	id = id or "none"
	if done[id] then return false end
	done[id] = true
	return true
end

local Drop -- below: the lines still waiting for the game

local function Fresh()
	R.qolByHand, R.qolOther, R.qolDone, R.qolWait, R.qolRewardOpen, R.qolRetried = nil, nil, nil, nil, nil, nil
end

-- Who the conversation is with, by which unit, and whether that's the page's
-- own: the page's own unit, as the game's frame reads it ("questnpc" on the
-- quest frame's pages, its greeting too, QuestFrame.lua:113-121; "npc" on a
-- gossip greeting or a vendor, GossipFrameShared.lua:285, MerchantFrame.lua:
-- 275), else the other. Read the other way round, an "npc" still set from the
-- last greeting or vendor would name the hand-in's pages, and the page the
-- game chains to the hand-in, "npc" gone by then, would look like another
-- quest giver's. Unknown (nil, by the page's own unit) where the game keeps
-- that unit's GUID secret (UnitGUID is SecretWhenUnitIdentityRestricted):
-- Opened compares it, and a secret can't be compared (ns.IsSecret first,
-- ns.Readable). A secret own unit never falls back to the other, which may be
-- that stale "npc".
local function With(quest)
	local own, other = "npc", "questnpc"
	if quest then own, other = other, own end
	local who = Try(UnitGUID, own)
	if ns.IsSecret(who) then return nil, own, true end
	if who ~= nil then return who, own, true end
	return ns.Readable(Try(UnitGUID, other)), other, false
end

-- A window opened (quest: a page of the quest frame; vendor: a vendor's,
-- which only your click opens). A new conversation starts fresh (Shift, what
-- was done), after a close or with someone else; a page of the same one keeps
-- them. Two reads name someone else only when both are by the same unit or
-- both by their page's own: "npc" can still name the last vendor on a quest
-- page whose "questnpc" shows up a page later. (So a reward page read by "npc"
-- alone and another NPC's page read by its "questnpc" are one conversation:
-- that page is almost surely your own click, and the options finish it.)
-- Straight from one NPC to the next (your click on the next closes the last
-- window) is a new conversation, and Shift at the last one carries only to the
-- page the game chains to it. But a page from someone else within half a
-- second of a reward page's close, other than a vendor's, may be one the game
-- opened by itself for that hand-in: it's yours (R.qolOther says why). Lines
-- still waiting for the game's word are dropped, and the quest the last
-- hand-in frees forgotten (Drop, LogFull), but for the page the game chains to
-- it (the same quest giver within half a second), which the game's word on
-- that hand-in, and its log update, may still follow. Only the reward page
-- that's showing waits for its item data (QUEST_ITEM_UPDATE).
local function Opened(quest, vendor)
	local who, unit, own = With(quest)
	local moved = who ~= nil and R.qolWith ~= nil and who ~= R.qolWith and (unit == R.qolWithUnit or (own and R.qolWithOwn))
	if not R.qolOpen or moved then
		Fresh()
		local soon = not R.qolOpen and R.qolClosedAt and Now() - R.qolClosedAt <= HAND_CARRY
		local other = who ~= nil and R.qolLastWith ~= nil and who ~= R.qolLastWith and (unit == R.qolLastUnit or (own and R.qolLastOwn))
		if other then
			R.qolHandUntil = nil
			if soon and R.qolAtReward and not vendor then R.qolByHand, R.qolOther = true, true end
		end
		if not soon or other then Drop() end
	end
	R.qolOpen, R.qolRewardOpen, R.qolAtReward = true, nil, nil
	if who ~= nil then R.qolWith, R.qolWithUnit, R.qolWithOwn = who, unit, own end
end

local function WindowClosed()
	R.qolHandUntil = R.qolByHand and (Now() + HAND_CARRY) or nil
	R.qolLastWith, R.qolLastUnit, R.qolLastOwn, R.qolClosedAt = R.qolWith, R.qolWithUnit, R.qolWithOwn, Now()
	R.qolOpen, R.qolWith, R.qolWithUnit, R.qolWithOwn = nil, nil, nil, nil
	Fresh()
end

---------------------------------------------------------------------------
-- What it did or left to you: /bones qol last keeps the last few; a line in
-- the chat frame says when gold changed hands, a rule chose for you, or a
-- page waits for you and why. Each line names the option that acted.
---------------------------------------------------------------------------

local function Coins(copper)
	copper = math.floor(tonumber(copper) or 0)
	if type(GetMoneyString) == "function" then
		local ok, s = pcall(GetMoneyString, copper, true)
		if ok and type(s) == "string" and s ~= "" then return s end
	end
	local g, s, c = math.floor(copper / 10000), math.floor(copper / 100) % 100, copper % 100
	local parts = {}
	-- %s: an amount of gold, silver or copper
	if g > 0 then parts[#parts + 1] = string.format("%sg", ns.Thousands(g)) end
	if s > 0 then parts[#parts + 1] = string.format("%ss", ns.Int(s)) end
	if c > 0 or #parts == 0 then parts[#parts + 1] = string.format("%sc", ns.Int(c)) end
	return table.concat(parts, " ")
end
Q.Coins = Coins

-- tell: in the chat frame too. once: a reason that doesn't change (the same
-- quest giver opened again) is said once a session.
local function Note(line, tell, once)
	if once then
		R.qolSaid = R.qolSaid or {}
		if R.qolSaid[line] then return end
		R.qolSaid[line] = true
	end
	R.qolLog = R.qolLog or {}
	table.insert(R.qolLog, 1, line)
	while #R.qolLog > LOG_MAX do table.remove(R.qolLog) end
	if tell then ns.Notify.Local(line) end
end

function Q.Last()
	return R.qolLog or {}
end

-- What it did, said once the game confirms it (QUEST_ACCEPTED, QUEST_TURNED_IN),
-- within a few seconds: a quest the server refused leaves no line, and never
-- one for what the player does by hand later.
local CONFIRM_WITHIN = 5 -- seconds
local pending = { QUEST_ACCEPTED = {}, QUEST_TURNED_IN = {} }
-- Forget lines past their few seconds, and stop hearing what nothing waits for
-- (a refusal only drops lines: a hand-in with no line left waits for its
-- QUEST_TURNED_IN alone, Drop).
local function Settle()
	local waiting = false
	for event, lines in pairs(pending) do
		for id, p in pairs(lines) do
			if Now() - p.at > CONFIRM_WITHIN then lines[id] = nil elseif p.line then waiting = true end
		end
		if next(lines) == nil then frame:UnregisterEvent(event) end
	end
	if not waiting then frame:UnregisterEvent("UI_ERROR_MESSAGE") end
end
-- The game's refusals of an accept or a hand-in (GlobalStrings, as
-- UI_ERROR_MESSAGE says them; LootFrame.lua:190 compares ERR_INV_FULL the same
-- way). Any other error ("Out of range.") leaves a waiting line alone.
local REFUSALS = {
	"ERR_INV_FULL", "ERR_BAG_FULL", "ERR_ITEM_MAX_COUNT", "ERR_QUEST_LOG_FULL", "ERR_QUEST_ALREADY_ON",
	"ERR_QUEST_ALREADY_DONE", "ERR_QUEST_ALREADY_DONE_DAILY", "ERR_QUEST_ONLY_ONE_TIMED", "ERR_QUEST_MUST_CHOOSE",
	"ERR_QUEST_NEED_PREREQS", "ERR_QUEST_HAS_IN_PROGRESS", "ERR_QUEST_FAILED_LOW_LEVEL", "ERR_QUEST_FAILED_WRONG_RACE",
	"ERR_QUEST_FAILED_MISSING_ITEMS", "ERR_QUEST_FAILED_NOT_ENOUGH_MONEY", "ERR_QUEST_FAILED_SPELL",
	"ERR_QUEST_FAILED_EXPANSION", "ERR_QUEST_FAILED_CAIS", "ERR_QUEST_FAILED_S", "ERR_QUEST_FAILED_BAG_FULL_S",
	"ERR_QUEST_FAILED_MAX_COUNT_S", "ERR_QUEST_FAILED_TOO_MANY_DAILY_QUESTS_I",
}
local function IsRefusal(message)
	for _, name in ipairs(REFUSALS) do
		local s = _G[name]
		if type(s) == "string" and s ~= "" then
			if s == message then return true end
			-- A string with a %s or %d in it, as a pattern.
			local pattern = s:gsub("[%%%^%$%(%)%.%[%]%*%+%-%?]", "%%%0"):gsub("%%%%s", ".+"):gsub("%%%%d", "%%d+")
			if pattern ~= s and message:find("^" .. pattern .. "$") then return true end
		end
	end
	return false
end
-- A message it can't read counts as a refusal: dropping a line only leaves it unsaid.
local function Refused(message)
	if type(message) ~= "string" then return true end
	local ok, refused = pcall(IsRefusal, message)
	return not ok or refused
end

-- Drop the lines still waiting (one event's, or all): the game refused
-- an accept or a hand-in (UI_ERROR_MESSAGE: refused), a new conversation
-- began, or the option went off. What the player then does by hand is never
-- credited to an option. All of them (a refusal, a new conversation) forget
-- the quest the last hand-in frees too: a refused hand-in frees nothing
-- (LogFull). But a refusal can be another action's ("Inventory is full." as
-- you loot), so a hand-in's line goes and its quest is still watched for: the
-- game's word on it within those few seconds frees it after all (Confirmed),
-- and says nothing.
Drop = function(event, refused)
	for e, lines in pairs(pending) do
		if event == nil or e == event then
			for id, p in pairs(lines) do
				if refused and e == "QUEST_TURNED_IN" then p.line = nil else lines[id] = nil end
			end
		end
	end
	if event == nil then R.qolHanded = nil end
	Settle()
end
local function Later(event, id, line, tell)
	if id == nil then Note(line, tell) return end
	pending[event][id] = { line = line, tell = tell, at = Now() }
	frame:RegisterEvent(event)
	frame:RegisterEvent("UI_ERROR_MESSAGE")
end
local function Confirmed(event, id)
	local p = id ~= nil and pending[event][id]
	if p then
		pending[event][id] = nil
		-- A line-less one: a hand-in a stray refusal hid (Drop), freeing its quest.
		if Now() - p.at <= CONFIRM_WITHIN then
			if p.line then Note(p.line, p.tell) else R.qolHanded = id end
		end
	end
	Settle()
end

local function Title()
	local t = Try(GetTitleText)
	return (type(t) == "string" and t ~= "") and ns.Escape(t) or "this quest"
end

-- quiet: in /bones qol last only, not the chat frame.
local function Left(option, why, quiet)
	Note(string.format(LEFT[option][why], Title()), not quiet, true)
end

---------------------------------------------------------------------------
-- Quests offered: accept
---------------------------------------------------------------------------

-- The quests in your log, as ns.QuestLog reads them (every one GetInfo lists,
-- under a collapsed header too, hidden quests aside, those with no id yet
-- too), and its meta (max: the cap, never less than the log holds). LogFull
-- and the reward page's R.qolHandedCount take this one measure.
local function LogCount()
	local _, m = ns.QuestLog()
	return m.count + m.unread, m
end

-- Your log has no room: its quests (LogCount) against the game's cap
-- (ns.QuestLogMax: the larger of GetMaxNumQuestsCanAccept and the one
-- Forever's own log shows, "n/40", Constants.QuestLogConsts,
-- Camelot/QuestMapFrameUtils.lua:16-22; never MAX_QUESTS, a stale 25 on
-- camelot, Constants.lua:464; never less than the log holds, since a log past
-- the cap the game reports has a bigger one). With neither known, its
-- "fallback", 40, the largest any client's: a log of 40 is full on every one,
-- and one holding more has a cap nobody knows, so no verdict: the game refuses
-- a full log itself (ERR_QUEST_LOG_FULL). A cap too low would leave a quest to
-- you as full; one too high only lets the game refuse it with its own error.
-- The quest a hand-in frees (R.qolHanded) is still counted until the game's
-- log update, which can land after the page the game chains to it: that one
-- isn't, while the log still lists it or its count hasn't gone down since the
-- reward page (R.qolHandedCount: set only when the log listed it there). That
-- room is one quest's: once one takes it, the count is right again. Auto
-- Accept Quests' own accept and a page the game already took forget it at once
-- (OnDetail); a page left to you (R.qolLeftId) takes it when its quest is in
-- your log (your own click on its Accept).
local function LogFull()
	local count, m = LogCount()
	local cap, source = ns.QuestLogMax()
	if source == "fallback" and count > cap then return false end
	local handed, left = R.qolHanded, R.qolLeftId
	if handed and not (left ~= nil and Try(C_QuestLog and C_QuestLog.IsOnQuest, left))
		and (Try(C_QuestLog and C_QuestLog.IsOnQuest, handed) or count >= (R.qolHandedCount or math.huge)) then
		count = count - 1
	end
	return count >= m.max
end

-- Why an offered quest waits for you (a LEFT.qolAccept key), or nil.
local function Why(id)
	-- The game asks before a quest flags you for PvP (QuestFrame.lua:579-589).
	if Try(QuestFlagsPVP) then return "pvp" end
	if LogFull() then return "full" end
	if id and STARTS[id] then return STARTS[id] end
	-- (its first return only: tonumber would take the second as a base)
	if id and (tonumber((Try(C_QuestLog and C_QuestLog.GetTimeAllowed, id))) or 0) > 0 then return "timed" end
	local tag = id and Try(C_QuestLog and C_QuestLog.GetQuestTagInfo, id)
	local tagID = type(tag) == "table" and tag.tagID or nil
	if tagID == ESCORT_TAG then return "escort" end
	-- Old quests may lack the tag, so the objectives' own word counts too
	-- (QuestInfo.lua:393; English clients: a miss means the list or the tag).
	local objectives = Try(GetObjectiveText)
	if type(objectives) == "string" and objectives:lower():find("%f[%a]escort") then return "escort" end
	if tagID and TAG_WHY[tagID] then return TAG_WHY[tagID] end
	if (tonumber((Try(GetSuggestedGroupSize))) or 0) > 1 then return "group" end
	if id and Try(C_QuestLog and C_QuestLog.IsQuestTrivial, id) then return "low" end
	return nil
end

-- A quest offered to you (QUEST_DETAIL, after the game's QuestFrame showed
-- it). The game's own kinds close before this: an item's quest goes to the
-- tracker's pop-up, a zone's is the game's to take (QuestFrame.lua:43-60); one
-- the game already took (QuestGetAutoAccept) stays open for a click on its
-- Accept, which only closes it, and a line says so. A quest another player
-- shares opened without your click: always yours. The page the game chains to
-- a hand-in (the next quest, as it closes) is that conversation's, however its
-- window, the game's word and the log update fall (Opened, LogFull). A page
-- it leaves says why: in the chat frame when it waits for your click, in
-- /bones qol last when it's another quest giver's right after a hand-in or
-- already taken (Shift, being away and the game's own pop-ups need no word).
local function OnDetail(startItem)
	Opened(true)
	if ns.Readable(Try(UnitIsPlayer, "questnpc")) then return end -- a secret: an NPC (a player's identity never is one)
	if ByHand() or not S().qolAccept then
		if R.qolOther and S().qolAccept then Left("qolAccept", "other", true) end
		return
	end
	if (tonumber(startItem) or 0) ~= 0 then return end
	if Try(QuestIsFromAreaTrigger) or Try(QuestIsFromAdventureMap) then return end
	if Try(QuestGetAutoAccept) then
		R.qolHanded, R.qolHandedCount = nil, nil -- it took the room a hand-in freed (LogFull)
		Left("qolAccept", "game")
		return
	end
	local id = Try(GetQuestID)
	-- The accept already sent waits for the game's word (the page again in a new
	-- window, as the last closed): never twice.
	local sent = id and pending.QUEST_ACCEPTED[id]
	if sent and Now() - sent.at <= CONFIRM_WITHIN then return end
	-- Already in your log (the page again once the accept has landed), but for
	-- the quest just handed in: a repeatable offered again before the log update.
	if id and id ~= R.qolHanded and Try(C_QuestLog and C_QuestLog.IsOnQuest, id) then
		Left("qolAccept", "taken", true)
		return
	end
	local why = Why(id)
	if why then
		R.qolLeftId = id -- yours to accept: then it takes the room a hand-in freed (LogFull)
		Left("qolAccept", why)
		return
	end
	if not Once("accept", id) then return end
	-- %s: the quest's name
	Later("QUEST_ACCEPTED", id, string.format("Auto Accept Quests accepted %s.", Title()))
	-- The room the last hand-in freed is this quest's now (LogFull).
	R.qolHanded, R.qolHandedCount = nil, nil
	AcceptQuest()
end

---------------------------------------------------------------------------
-- Quests finished: hand in, and the reward
---------------------------------------------------------------------------

local function IsQuestItem(itemID)
	if not itemID then return false end
	local classID = select(6, Try(C_Item and C_Item.GetItemInfoInstant, itemID))
	return classID == EnumValue("ItemClass", "Questitem", QUEST_CLASS)
end

-- A quest you can take again (a repeatable, a daily, a weekly).
local function Recurring(id)
	if not id then return false end
	if Try(C_QuestLog and C_QuestLog.IsRepeatableQuest, id) then return true end
	local index = Try(C_QuestLog and C_QuestLog.GetLogIndexForQuestID, id)
	local info = index and Try(C_QuestLog.GetInfo, index)
	return type(info) == "table" and (tonumber(info.frequency) or 0) > 0
end

-- What handing this quest in takes, as its progress page lists it, or nil:
-- gold (the game asks first), a currency, items that aren't quest items
-- (cloth, ore: your call), or quest items.
local function Takes()
	if (tonumber((Try(GetQuestMoneyToGet))) or 0) > 0 then return "gold" end
	if (tonumber((Try(GetNumQuestCurrencies))) or 0) > 0 then return "currency" end
	local n = tonumber((Try(GetNumQuestItems))) or 0
	for i = 1, n do
		if not IsQuestItem((select(6, Try(GetQuestItemInfo, "required", i)))) then return "goods" end
	end
	return n > 0 and "items" or nil
end

-- The progress page (QUEST_PROGRESS): its Continue, when the quest is done and
-- takes nothing but quest items (and nothing at all, for one you can repeat).
local function OnProgress()
	Opened(true)
	if ByHand() or not S().qolTurnIn then return end
	if not Try(IsQuestCompletable) then return end
	local id = Try(GetQuestID)
	local takes = id and HANDIN[id] or Takes()
	if takes == "items" then takes = Recurring(id) and "again" or nil end
	if takes then
		R.qolWait = id -- and its reward page is yours too
		Left("qolTurnIn", takes)
		return
	end
	if not Once("progress", id) then return end
	CompleteQuest()
end

-- Free room in your plain bags (a quiver or a herb bag takes only its kind).
local function FreeSlots()
	if not (C_Container and C_Container.GetContainerNumFreeSlots) then return nil end
	local free = 0
	for bag = 0, tonumber(NUM_BAG_SLOTS) or 4 do
		local n, family = Try(C_Container.GetContainerNumFreeSlots, bag)
		if tonumber(n) and (tonumber(family) or 0) == 0 then free = free + n end
	end
	return free
end

-- Best Upgrade: the biggest upgrade over what you wear, by the AI's stat
-- weights (Tooltips.lua scores it as its item-tooltip verdict does). Returns
-- the choice, or nil and a PICK key, and whether item data is on its way: a
-- reward you can use whose stats haven't loaded is never counted as no
-- upgrade (it waits, then it's yours).
local function BonesPick(n)
	local T = ns.Tooltips
	local weights = T and T.Weights and T.Weights()
	if not weights then return nil, "weights" end
	local best, bestGain, tie
	for i = 1, n do
		local link = Try(GetQuestItemLink, "choice", i)
		if not link then return nil, "loading", true end
		local usable = select(5, Try(GetQuestItemInfo, "choice", i))
		if usable and T.Gain then
			local gain, loading = T.Gain(link, weights)
			if loading then return nil, "loading", true end
			if gain and gain > 0 then
				if bestGain and math.abs(gain - bestGain) < 1e-6 then
					tie = true
				elseif not bestGain or gain > bestGain then
					best, bestGain, tie = i, gain, false
				end
			end
		end
	end
	if not best then return nil, "noUpgrade" end
	if tie then return nil, "tie" end
	return best
end

-- Highest Price: price times how many; returns the choice and its worth,
-- or nil and a PICK key, and whether item data is on its way.
local function SellPick(n)
	local best, bestValue, tie
	for i = 1, n do
		local price = SellPrice(Try(GetQuestItemLink, "choice", i))
		if price == nil then return nil, "loading", true end
		local count = math.max(1, tonumber((select(3, Try(GetQuestItemInfo, "choice", i)))) or 1)
		local value = (tonumber(price) or 0) * count
		if value > 0 then
			if bestValue and value == bestValue then
				tie = true
			elseif not bestValue or value > bestValue then
				best, bestValue, tie = i, value, false
			end
		end
	end
	if not best then return nil, "noPrice" end
	if tie then return nil, "samePrice" end
	return best, bestValue
end

local function ChoiceName(i)
	local name = Try(GetQuestItemInfo, "choice", i)
	return (type(name) == "string" and name ~= "") and ns.Escape(name) or "the reward"
end

-- The reward page (QUEST_COMPLETE): its Complete Quest, when there's nothing
-- to choose or the rule you set chooses; never when it costs gold (the game
-- asks first, QuestFrame.lua:147-164) or your bags have no room for it. Seen
-- with Auto Turn In Quests off too: the quest handed in here, by your click or
-- the option's, is the one LogFull leaves out for the follow-up's page, and a
-- page from someone else right after this one closes is yours (Opened). With
-- no quest ID here nothing is freed: nothing shows the log held it (a turn-in
-- outside the log frees nothing), and the game's own reward page reads that ID
-- (QuestInfo.lua:124-133, :608).
local function OnComplete()
	Opened(true)
	local id = Try(GetQuestID)
	R.qolHanded, R.qolAtReward, R.qolLeftId = id, true, nil
	local listed = id and Try(C_QuestLog and C_QuestLog.IsOnQuest, id)
	R.qolHandedCount = listed and (LogCount()) or nil -- LogFull's measure
	if ByHand() or not S().qolTurnIn then return end
	R.qolRewardOpen = true
	if R.qolWait ~= nil and R.qolWait == id then return end
	if id and HANDIN[id] then
		Left("qolTurnIn", HANDIN[id])
		return
	end
	if (tonumber((Try(GetQuestMoneyToGet))) or 0) > 0 then return end
	local rule = S().qolRewards
	local n = tonumber((Try(GetNumQuestChoices))) or 0
	local pick, worth = n, nil
	if n > 1 then
		if rule ~= "bones" and rule ~= "sell" then return end -- Your Pick
		local why, loading
		if rule == "bones" then
			pick, why, loading = BonesPick(n)
		else
			pick, worth, loading = SellPick(n)
			if not pick then why, worth = worth, nil end
		end
		if not pick then
			-- Item data on its way: the game says when it lands, once.
			if loading and not R.qolRetried then
				R.qolRetried = true
				frame:RegisterEvent("QUEST_ITEM_UPDATE")
				return
			end
			Note(string.format(P(PICK[why]), Title()), true, true)
			return
		end
	end
	local need = (tonumber((Try(GetNumQuestRewards))) or 0) + (n > 0 and 1 or 0)
	local free = FreeSlots()
	if need > 0 and free and free < need then
		Left("qolTurnIn", "bags")
		return
	end
	if not Once("reward", id) then return end
	if n > 1 and rule == "bones" then
		-- %s: the item's name, then the quest's
		Later("QUEST_TURNED_IN", id, string.format(P("Quest Rewards took %s, the best upgrade for your build, as the reward for %s."), ChoiceName(pick), Title()), true)
	elseif n > 1 then
		-- %s: the item's name, its worth, then the quest's name
		Later("QUEST_TURNED_IN", id, string.format("Quest Rewards took %s, which has the highest sell price (%s), as the reward for %s.", ChoiceName(pick), Coins(worth), Title()), true)
	else
		Later("QUEST_TURNED_IN", id, string.format("Auto Turn In Quests handed in %s.", Title()))
	end
	GetQuestReward(pick)
end

---------------------------------------------------------------------------
-- Greetings: straight to the quest when that's all there is
---------------------------------------------------------------------------

-- A gossip greeting (GOSSIP_SHOW). Anything besides quests (a vendor, a
-- trainer, a flight master, an innkeeper) is your pick, and so is a greeting
-- the game wants read (ForceGossip, GossipFrameShared.lua:195). A gossip
-- option is never picked. Seen with Auto Skip to Quests off too: Shift held
-- here makes the rest of this conversation yours.
local function OnGossip()
	Opened()
	if ByHand() or not S().qolSkip then return end
	local G = C_GossipInfo
	if not G or Try(G.ForceGossip) then return end
	local options = Try(G.GetOptions)
	if type(options) == "table" and #options > 0 then return end
	for _, q in ipairs(Try(G.GetActiveQuests) or {}) do
		if type(q) == "table" and q.isComplete and not q.isIgnored and Once("skip", q.questID) then
			G.SelectActiveQuest(q.questID)
			return
		end
	end
	local available = Try(G.GetAvailableQuests) or {}
	local q = available[1]
	if #available == 1 and type(q) == "table" and not q.isTrivial and not q.isIgnored and Once("skip", q.questID) then
		G.SelectAvailableQuest(q.questID)
	end
end

-- The quest greeting (QUEST_GREETING): an NPC that offers only quests
-- (QuestFrame.lua:308-409). The same rule, by the page's own numbering. A page
-- of the quest frame, named by "questnpc" as its quest pages are (With).
local function OnGreeting()
	Opened(true)
	if ByHand() or not S().qolSkip then return end
	for i = 1, tonumber((Try(GetNumActiveQuests))) or 0 do
		local _, complete = Try(GetActiveTitle, i)
		if complete and Once("skip", Try(GetActiveQuestID, i) or -i) then
			SelectActiveQuest(i)
			return
		end
	end
	if (tonumber((Try(GetNumAvailableQuests))) or 0) == 1 then
		local trivial, _, _, _, id = Try(GetAvailableQuestInfo, 1)
		if not trivial and Once("skip", id or 0) then SelectAvailableQuest(1) end
	end
end

---------------------------------------------------------------------------
-- Vendors: gray items, then repairs
---------------------------------------------------------------------------

-- A bag you left out of Sell All Junk (its bag menu's check box,
-- ContainerFrame.lua:675-691).
local function Excluded(bag)
	local C = C_Container
	if not C then return false end
	if bag == 0 then return Try(C.GetBackpackSellJunkDisabled) and true or false end
	return Try(C.GetBagSlotFlag, bag, EnumValue("BagSlotFlags", "ExcludeJunkSell", EXCLUDE_JUNK)) and true or false
end

-- Your gray items that Sell All Junk sells: how many, and what they're
-- worth (nil while a price isn't known).
local function Greys()
	local count, worth = 0, 0
	local C = C_Container
	if not (C and C.GetContainerNumSlots and C.GetContainerItemInfo) then return 0, nil end
	for bag = 0, tonumber(NUM_BAG_SLOTS) or 4 do
		if not Excluded(bag) then
			for slot = 1, tonumber((Try(C.GetContainerNumSlots, bag))) or 0 do
				local info = Try(C.GetContainerItemInfo, bag, slot)
				if type(info) == "table" and info.quality == EnumValue("ItemQuality", "Poor", POOR) and not info.hasNoValue and not info.isLocked then
					count = count + 1
					local price = worth and SellPrice(info.itemID)
					if price == nil then worth = nil else worth = worth + price * (tonumber(info.stackCount) or 1) end
				end
			end
		end
	end
	return count, worth
end

-- The game's own Sell All Junk: the vendor's button asks first
-- (MerchantFrame.lua:1124-1132), and this switch is the player's standing yes.
-- Where the vendor has no such button (IsSellAllJunkEnabled, :482) your gray
-- items stay yours: nothing is sold one by one. Returns how many, and what
-- they were worth when known.
local function SellJunk()
	local MF = C_MerchantFrame
	if not (MF and MF.SellAllJunkItems and Try(MF.IsSellAllJunkEnabled)) then
		if Greys() > 0 then
			Note("Auto Sell Junk left your gray items to you because this vendor has no Sell All Junk Items button.", true, true)
		end
		return 0
	end
	local n = tonumber((Try(MF.GetNumJunkItems))) or 0
	if n <= 0 then return 0 end
	local count, worth = Greys()
	if count ~= n then worth = nil end -- the game counts differently: no sum rather than a wrong one
	MF.SellAllJunkItems()
	if worth and worth > 0 then
		-- %s: how many, then what they were worth
		Note(string.format(n == 1 and "Auto Sell Junk sold %s gray item for %s." or "Auto Sell Junk sold %s gray items for %s.", ns.Int(n), Coins(worth)), true)
	else
		Note(string.format(n == 1 and "Auto Sell Junk sold %s gray item." or "Auto Sell Junk sold %s gray items.", ns.Int(n)), true)
	end
	return n, worth
end

local function RepairLeft(cost)
	-- %s: the cost
	Note(string.format("Auto Repair left your repairs to you because they cost %s, more than you have.", Coins(cost)), true)
end

-- With your own gold only, never your guild's (RepairAllItems(true)). coming:
-- gold the gray items bring (true while unknown): the repair waits for it,
-- until the vendor closes.
local function Repair(coming)
	if not Try(CanMerchantRepair) then return end
	local cost, can = Try(GetRepairAllCost)
	cost = tonumber(cost) or 0
	if not can or cost <= 0 then return end
	local money = tonumber((Try(GetMoney))) or 0
	if money >= cost then
		R.qolRepairWait = nil
		frame:UnregisterEvent("PLAYER_MONEY")
		RepairAllItems()
		Note(string.format("Auto Repair paid %s to repair your gear.", Coins(cost)), true)
	elseif coming == true or (tonumber(coming) and money + coming >= cost) then
		R.qolRepairWait = cost
		frame:RegisterEvent("PLAYER_MONEY")
	else
		R.qolRepairWait = nil
		RepairLeft(cost)
	end
end

local function OnVendor()
	Opened(false, true)
	R.qolVendor = true
	if ByHand() then return end
	local s = S()
	local sold, worth = 0, nil
	if s.qolJunk then sold, worth = SellJunk() end
	if s.qolRepair then Repair(sold > 0 and (worth or true) or nil) end
end

---------------------------------------------------------------------------
-- Events, registered only while an option needs them
---------------------------------------------------------------------------

local HANDLERS = {
	QUEST_DETAIL = function(startItem) OnDetail(startItem) end,
	QUEST_PROGRESS = function() OnProgress() end,
	QUEST_COMPLETE = function() OnComplete() end,
	QUEST_ITEM_UPDATE = function()
		frame:UnregisterEvent("QUEST_ITEM_UPDATE")
		if R.qolRewardOpen then OnComplete() end
	end,
	QUEST_ACCEPTED = function(id) Confirmed("QUEST_ACCEPTED", id) end,
	QUEST_TURNED_IN = function(id) Confirmed("QUEST_TURNED_IN", id) end,
	-- The game refused an accept or a hand-in (a full log, full bags): no line
	-- waiting now may be said. Any other error only lets go of stale lines.
	UI_ERROR_MESSAGE = function(_, message) if Refused(message) then Drop(nil, true) else Settle() end end,
	GOSSIP_SHOW = function() OnGossip() end,
	QUEST_GREETING = function() OnGreeting() end,
	-- A greeting that hands over to a quest page is still the same conversation.
	GOSSIP_CLOSED = function(continuing) if not continuing then WindowClosed() end end,
	QUEST_FINISHED = function() WindowClosed() end,
	MERCHANT_SHOW = function() OnVendor() end,
	MERCHANT_CLOSED = function()
		frame:UnregisterEvent("PLAYER_MONEY")
		if R.qolRepairWait then RepairLeft(R.qolRepairWait) end
		R.qolVendor, R.qolRepairWait = nil, nil
		WindowClosed()
	end,
	-- The sale's gold landed: the repair waits no longer, unless the vendor
	-- is yours now (Shift) or you're away.
	PLAYER_MONEY = function()
		if not (R.qolRepairWait and R.qolVendor and S().qolRepair) then return end
		if ByHand() then
			R.qolRepairWait = nil
			frame:UnregisterEvent("PLAYER_MONEY")
			return
		end
		if (tonumber((Try(GetMoney))) or 0) >= R.qolRepairWait then Repair(nil) end
	end,
	PLAYER_REGEN_ENABLED = function()
		frame:UnregisterEvent("PLAYER_REGEN_ENABLED")
		for name, value in pairs(later) do CVarWrite(name, value) end
		for name in pairs(later) do later[name] = nil end
	end,
}

frame = CreateFrame("Frame")
frame:SetScript("OnEvent", function(_, event, ...)
	local fn = HANDLERS[event]
	if fn then fn(...) end
end)
Q.frame = frame

local function Want(on, ...)
	for i = 1, select("#", ...) do
		local e = select(i, ...)
		if on then pcall(frame.RegisterEvent, frame, e) else pcall(frame.UnregisterEvent, frame, e) end
	end
end

-- Events for the options that are on, none for those that are off. The
-- greeting is heard whenever any option is on: Shift held there (a quest
-- giver's, a vendor's) makes the rest of that conversation yours.
function Q.Apply()
	local s = S()
	if not s then return end
	local quests = s.qolAccept or s.qolTurnIn or s.qolSkip
	local vendor = s.qolJunk or s.qolRepair
	-- No close event heard from here on: no conversation carries over.
	if not (quests or vendor) then R.qolOpen, R.qolWith, R.qolByHand = nil, nil, nil end
	Want(s.qolAccept, "QUEST_DETAIL")
	-- The hand-in's pages: Auto Turn In Quests finishes them; Auto Accept Quests
	-- hears them for the follow-up the game chains to a hand-in (Shift there,
	-- and the quest it frees).
	Want(s.qolAccept or s.qolTurnIn, "QUEST_PROGRESS", "QUEST_COMPLETE")
	Want(quests, "QUEST_GREETING", "QUEST_FINISHED")
	Want(quests or vendor, "GOSSIP_SHOW", "GOSSIP_CLOSED")
	Want(vendor, "MERCHANT_SHOW", "MERCHANT_CLOSED")
	if not s.qolTurnIn then Want(false, "QUEST_ITEM_UPDATE") end
	if not vendor then Want(false, "PLAYER_MONEY") end
	-- An option turned off says nothing more, and hears nothing more.
	if not s.qolAccept then Drop("QUEST_ACCEPTED") end
	if not s.qolTurnIn then Drop("QUEST_TURNED_IN") end
end

---------------------------------------------------------------------------
-- The switches (Settings, the step, /bones qol)
---------------------------------------------------------------------------

-- The game's Auto Loot key as its Options name it ("Shift"), or nil for none.
function Q.LootKey()
	local k = Try(GetModifiedClick, "AUTOLOOTTOGGLE")
	if k == "SHIFT" then return "Shift" elseif k == "CTRL" then return "Ctrl" elseif k == "ALT" then return "Alt" end
	return nil
end

-- What Turn On and /bones qol on say, each whole: one option (never Auto
-- Loot, which has its own line), or several [with another loot key]. %s: the
-- options' names, then the loot key.
local IS_ON = "%s is on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change it."
local ARE_ON = {
	[false] = "%s are on. Hold Shift as you open a window to finish it yourself. Type /nqa qol to change them.",
	[true] = "%s are on. Hold Shift as you open a window to finish it yourself, or %s as you loot. Type /nqa qol to change them.",
}

local function LootOn()
	local key = Q.LootKey()
	if key then return string.format("Auto Loot is on. Hold %s as you loot to pick items yourself.", key) end
	return "Auto Loot is on. To loot by hand, set a loot key in the game's Options > Controls."
end

-- A switch by key: one of Q.OWN, or "loot" and "track" (the game's own).
function Q.Get(key)
	if Q.CVARS[key] then return Q.CVarOn(key) end
	local s = S()
	return s ~= nil and s[key] == true
end

-- The step answered: it never shows again, and the line about it is moot.
function Q.Answer()
	if ns.db then ns.db.qolAsked, ns.db.qolTold = true, true end
end

-- A switch changed from Settings, the step or a command; any of them answers
-- the step. quiet: the step and /bones qol on say it in one line of their own.
function Q.Set(key, on, quiet)
	on = on and true or false
	if Q.CVARS[key] then
		if Defaulting() then return end
		Q.SetCVar(key, on)
	else
		local s = S()
		if not s then return end
		s[key] = on
		Q.Apply()
	end
	Q.Answer()
	if on and not quiet then
		local line = key == "loot" and LootOn() or ON[key]
		if line then ns.Notify.Local(line) end
	end
	Render()
end

function Q.SetRewards(rule)
	local s = S()
	if not s or not Q.REWARDS[rule] then return end
	s.qolRewards = rule
	Q.Answer()
	Render()
end

-- The step shows until it's answered, after the first reply (db.hudIntro),
-- and not in the UI session of the first reply: R.qolHold.
function Q.Offer()
	local db = ns.db
	return db ~= nil and not db.qolAsked and db.hudIntro == true and not R.qolHold
end

-- The step's five, as far as this client has them: the game's own two only
-- where they're off (one already on has nothing to turn on), and Auto Loot
-- only with a loot key to loot by hand.
function Q.Offered()
	local list = {}
	for _, k in ipairs(Q.ONBOARD) do
		local ok = true
		if Q.CVARS[k] then ok = Q.HasCVar(k) and not Q.CVarOn(k) end
		if k == "loot" and ok then ok = Q.LootKey() ~= nil end
		if ok then list[#list + 1] = k end
	end
	return list
end

-- The step's checks: all of the five checked to start.
function Q.Ticks()
	if not R.qolTicks then
		R.qolTicks = {}
		for _, k in ipairs(Q.Offered()) do R.qolTicks[k] = true end
	end
	return R.qolTicks
end

function Q.Tick(key)
	local t = Q.Ticks()
	t[key] = not t[key] or nil
end

function Q.AnyTicked()
	for _, k in ipairs(Q.Offered()) do
		if Q.Ticks()[k] then return true end
	end
	return false
end

-- "A, B and C" (docs/STYLE.md §3).
local function List(names)
	if #names <= 1 then return names[1] or "" end
	-- %s: the names but the last, then the last
	return string.format("%s and %s", table.concat(names, ", ", 1, #names - 1), names[#names])
end

-- Turn On (the step's checked ones), or /bones qol on (all of the step's
-- five): those on, the rest as they were; the step is answered. say: where
-- the line goes (the chat frame, else a command's own answer).
function Q.TurnOn(all, say)
	local names, t, loot = {}, Q.Ticks(), false
	for _, k in ipairs(Q.Offered()) do
		if all or t[k] then
			Q.Set(k, true, true)
			names[#names + 1] = Q.LABELS[k]
			loot = loot or k == "loot"
		end
	end
	Q.Answer()
	R.qolTicks = nil
	local key = loot and Q.LootKey() or nil
	local tell = say or ns.Notify.Local
	if loot and #names == 1 then
		-- Auto Loot alone: its own key, never Shift for windows none of which are on. %s: the key
		tell(string.format("Auto Loot is on. Hold %s as you loot to pick items yourself. Type /nqa qol to change it.", key or "Shift"))
	elseif #names == 1 then
		tell(string.format(IS_ON, names[1]))
	else
		tell(string.format(ARE_ON[key ~= nil and key ~= "Shift"], List(names), key))
	end
	-- /bones qol on skips Auto Loot on a client with no loot key (Offered), so
	-- looting by hand stays possible: say why, once, beside what went on.
	if all and Q.HasCVar("loot") and not Q.CVarOn("loot") and not Q.LootKey() then
		tell("Auto Loot stays off without a loot key, so you can always loot by hand. Set one in the game's Options > Controls, then type /nqa qol on again.")
	end
	Render()
end

-- Skip: nothing changes.
function Q.Skip()
	Q.Answer()
	R.qolTicks = nil
	ns.Notify.Local("Nothing changed. Type /nqa qol to turn options on later.")
	Render()
end

-- /bones qol off: every option this addon runs goes off. The game's own
-- Auto Loot and quest tracking stay as you set them.
function Q.AllOff()
	local s = S()
	for _, k in ipairs(Q.OWN) do s[k] = false end
	Q.Answer()
	Q.Apply()
	Render()
end

function Q.Describe(key)
	if key == "loot" then
		local k = Q.LootKey()
		-- %s: the game's loot key
		return k and string.format("Takes everything when you loot (the game's own Auto Loot); hold %s as you loot to pick items yourself.", k)
			or "Takes everything when you loot (the game's own Auto Loot); to loot by hand, set a loot key in the game's Options > Controls."
	end
	return P(Q.DESCRIPTIONS[key]) -- the companion's name, where players can rename it
end

function Q.RewardTip(rule)
	return P(Q.REWARD_TIPS[rule])
end

-- The once-ever line where the step can't show (the HUD closed or off, or
-- the step held for the session); the bar and compass get their own below.
local TOLD = "Quality of Life is new in Settings, with options for quests, loot and vendors. Nothing changes until you turn one on. Type /nqa qol to see them."

-- The step held for this session (a problem at its first chance, HUD.lua):
-- the same once-ever line says where it is.
function Q.Held()
	local db = ns.db
	if not db or db.qolTold then return end
	db.qolTold = true
	ns.Notify.Local(TOLD)
end

-- The step shows only in the whole HUD. Where it can't (the HUD closed or
-- off, the bar, the compass), one line, once ever, says where it is; nothing
-- opens by itself.
ns.On("PLAYER_ENTERING_WORLD", function(_, isLogin, isReload)
	local db = ns.db
	if not (isLogin or isReload) or not db or db.qolTold or not Q.Offer() then return end
	local H, s = ns.HUD, S()
	local shown = H and H.Active and H.Active()
	if shown and not (s and s.hudMin) then return end
	db.qolTold = true
	-- The compass's Show More gives the bar first; the whole HUD is one more.
	local line = TOLD
	if shown and s.hudCompass then
		line = "Quality of Life is new, with options for quests, loot and vendors. Nothing changes until you turn one on. Click Show More twice in the HUD's right-click menu to see them, or type /nqa qol."
	elseif shown then
		line = "Quality of Life is new, with options for quests, loot and vendors. Nothing changes until you turn one on. Click Show More in the HUD's right-click menu to see them, or type /nqa qol."
	end
	ns.Notify.Local(line)
end)

ns.On("PLAYER_LOGIN", function() Q.Apply() end)
