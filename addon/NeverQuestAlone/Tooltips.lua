-- Tooltips.lua: Bones's verdict in item tooltips. Bones sends stat weights for
-- your build once (a ```wowweights``` block, passed on by the bridge as a
-- reply's `weights`, PROTOCOL §4.1, and saved per character in
-- NQADB.weights). From then on every item tooltip scores the item against
-- what you wear in that slot, right here, with no message and no wait:
--   Bones: an upgrade for your build, +12% over Band of Ash
-- It reads TooltipDataProcessor.AddTooltipPostCall (Blizzard_SharedXMLGame,
-- loaded on Forever) and C_Item.GetItemStats (documented on 70009); without
-- either it does nothing. /bones tooltips off turns it off.

local _, ns = ...
local T = {}
ns.Tooltips = T

-- Our short names (ns.WEIGHT_KEYS) and the client's stat keys they cover.
local STAT_KEYS = {
	str = { "ITEM_MOD_STRENGTH_SHORT" },
	agi = { "ITEM_MOD_AGILITY_SHORT" },
	sta = { "ITEM_MOD_STAMINA_SHORT" },
	int = { "ITEM_MOD_INTELLECT_SHORT" },
	spi = { "ITEM_MOD_SPIRIT_SHORT" },
	armor = { "RESISTANCE0_NAME" },
	dps = { "ITEM_MOD_DAMAGE_PER_SECOND_SHORT" },
	ap = { "ITEM_MOD_ATTACK_POWER_SHORT" },
	rap = { "ITEM_MOD_RANGED_ATTACK_POWER_SHORT" },
	crit = { "ITEM_MOD_CRIT_RATING_SHORT", "ITEM_MOD_CRIT_MELEE_RATING_SHORT", "ITEM_MOD_CRIT_SPELL_RATING_SHORT" },
	hit = { "ITEM_MOD_HIT_RATING_SHORT", "ITEM_MOD_HIT_MELEE_RATING_SHORT", "ITEM_MOD_HIT_SPELL_RATING_SHORT" },
	sp = { "ITEM_MOD_SPELL_POWER_SHORT", "ITEM_MOD_SPELL_DAMAGE_DONE_SHORT" },
	heal = { "ITEM_MOD_SPELL_HEALING_DONE_SHORT" },
	mp5 = { "ITEM_MOD_MANA_REGENERATION_SHORT", "ITEM_MOD_POWER_REGEN0_SHORT" },
	def = { "ITEM_MOD_DEFENSE_SKILL_RATING_SHORT" },
	dodge = { "ITEM_MOD_DODGE_RATING_SHORT" },
	parry = { "ITEM_MOD_PARRY_RATING_SHORT" },
	block = { "ITEM_MOD_BLOCK_RATING_SHORT", "ITEM_MOD_BLOCK_VALUE_SHORT" },
}
T.STAT_KEYS = STAT_KEYS

local Try = ns.Try

function T.Weights()
	local db = ns.db
	return db and db.weights and db.weights[ns.CharKey()] or nil
end

-- An item's score under the weights, or nil when the client has no stats for it.
function T.Score(link, weights)
	if type(link) ~= "string" or type(weights) ~= "table" then return nil end
	local stats = Try(C_Item and C_Item.GetItemStats, link)
	if type(stats) ~= "table" then return nil end
	local score = 0
	for short, w in pairs(weights) do
		for _, key in ipairs(STAT_KEYS[short] or {}) do
			local v = tonumber(stats[key])
			if v then score = score + w * v end
		end
	end
	return score
end

local function NameOf(link)
	return type(link) == "string" and link:match("%[(.-)%]") or "what you wear"
end

-- The item itself, suffix and all: "item:1234:0:0:0:..." up to the link's |h.
local function ItemString(link)
	return type(link) == "string" and (link:match("|H(item:[^|]+)|h") or link:match("^(item:[%-%d:]+)")) or nil
end

local UP, SAME, DOWN, INFO = { 0.49, 0.78, 1 }, { 0.75, 0.75, 0.75 }, { 0.6, 0.6, 0.6 }, { 0.6, 0.6, 0.6 }
-- [UX-5] "NeverQuestAlone:" at the start is ours, in the companion's name
-- (ns.Name); the item names after it stay as they are.
local HEAD = "NeverQuestAlone:"
local function Line(text, c)
	if text:sub(1, #HEAD) == HEAD then text = ns.Name() .. text:sub(#HEAD) end
	return { text = text, r = c[1], g = c[2], b = c[3] }
end
local OFF_HAND = { INVTYPE_SHIELD = true, INVTYPE_HOLDABLE = true, INVTYPE_WEAPONOFFHAND = true }
local EITHER_SLOT = { INVTYPE_FINGER = true, INVTYPE_TRINKET = true }

-- "+12% over Band of Ash" or "18% under ...", against what you wear. Worn
-- gear that scores next to nothing makes any percentage silly: then "a big
-- upgrade". atLevel: the item's required level, when that's above yours.
local function Compare(mine, theirs, name, atLevel)
	local when = atLevel and (" at level " .. ns.Int(atLevel)) or " for your build"
	-- Neither has anything your weights count (a shirt, white gear under caster
	-- weights): no verdict rather than a meaningless one.
	if mine == 0 and theirs == 0 then return nil end
	if mine > 0 and theirs < mine * 0.1 then return Line(atLevel and ns.Fill("NeverQuestAlone: a big upgrade at level {level} over {item}", { level = ns.Int(atLevel), item = name }) or ns.Fill("NeverQuestAlone: a big upgrade over {item}", { item = name }), UP) end
	if theirs == 0 then return Line(atLevel and ns.Fill("NeverQuestAlone: not an upgrade at level {level} over {item}", { level = ns.Int(atLevel), item = name }) or ns.Fill("NeverQuestAlone: not an upgrade over {item}", { item = name }), DOWN) end
	local pct = math.floor((mine - theirs) / math.abs(theirs) * 100 + 0.5)
	if pct > 0 then return Line(string.format("NeverQuestAlone: an upgrade%s, +%d%% over %s", when, pct, name), UP) end
	if pct == 0 then return Line(ns.Fill("NeverQuestAlone: about the same as {item}", { item = name }), SAME) end
	return Line(string.format("NeverQuestAlone: not an upgrade%s, %d%% under %s", atLevel and when or "", -pct, name), DOWN)
end

-- What the tooltip says in red about using the item, as the game shows it:
-- "level" when only its required level is too high, "no" for anything else
-- (armour or weapon type, class), nil when nothing. Durability doesn't count.
local function Red(c)
	if type(c) ~= "table" then return false end
	local r, g, b = c.r, c.g, c.b
	if r == nil and type(c.GetRGB) == "function" then r, g, b = c:GetRGB() end
	return type(r) == "number" and r > 0.9 and (tonumber(g) or 1) < 0.35 and (tonumber(b) or 1) < 0.35
end

local function Pattern(template, fallback)
	if type(template) ~= "string" then return fallback end
	return "^" .. template:gsub("([%(%)%.%+%-%*%?%[%]%^%$])", "%%%1"):gsub("%%d", "%%d+")
end

local function Usability(data)
	if type(data) ~= "table" or type(data.lines) ~= "table" then return nil end
	local levelPat = Pattern(ITEM_MIN_LEVEL, "^Requires Level %d+")
	local durPat = Pattern(DURABILITY_TEMPLATE, "^Durability")
	local what
	for _, line in ipairs(data.lines) do
		if type(line) == "table" then
			for _, side in ipairs({ { line.leftText, line.leftColor }, { line.rightText, line.rightColor } }) do
				local text = side[1]
				if type(text) == "string" and text ~= "" and Red(side[2]) and not text:find(durPat) then
					if text:find(levelPat) then what = "level" else return "no" end
				end
			end
		end
	end
	return what
end
T.Usability = Usability

-- The verdict line for a link, or nil: { text, r, g, b }. data: the tooltip's
-- own lines (the post-call's), for what the game says about using it.
function T.Verdict(link, data)
	local s = ns.db and ns.db.settings
	if not s or not s.tooltips then return nil end
	local weights = T.Weights()
	local item = ItemString(link)
	if not weights or not item then return nil end
	local _, _, _, equipLoc = Try(C_Item and C_Item.GetItemInfoInstant, link)
	local slots = type(equipLoc) == "string" and ns.Chats.EQUIP_SLOTS and ns.Chats.EQUIP_SLOTS[equipLoc]
	if not slots then return nil end
	local usable = Usability(data)
	if usable == "no" then return Line("NeverQuestAlone: you can't use this", INFO) end
	local atLevel
	if usable == "level" then
		atLevel = tonumber((select(5, Try(C_Item and C_Item.GetItemInfo, link))))
		if not atLevel then return Line("NeverQuestAlone: not yet, you're below its level", INFO) end
	end
	local empty = atLevel and ns.Fill("NeverQuestAlone: fills an empty slot at level {level}", { level = ns.Int(atLevel) }) or "NeverQuestAlone: fills an empty slot"
	local mine = T.Score(link, weights)
	if not mine then return nil end
	local worn = {}
	for _, slot in ipairs(slots) do
		local eq = Try(GetInventoryItemLink, "player", slot)
		worn[slot] = type(eq) == "string" and eq or nil
		-- The very same item (its suffix too), not just the same id.
		if worn[slot] and ItemString(worn[slot]) == item then return Line("NeverQuestAlone: you're wearing this", INFO) end
	end
	-- A two-hander takes both hands: against the two together.
	if equipLoc == "INVTYPE_2HWEAPON" then
		local main, off = worn[16], worn[17]
		if not main and not off then return Line(empty, UP) end
		local both = (T.Score(main, weights) or 0) + (T.Score(off, weights) or 0)
		return Compare(mine, both, off and "your two hands" or NameOf(main), atLevel)
	end
	-- An off-hand item can't be used beside a two-hander.
	if OFF_HAND[equipLoc] then
		local main = Try(GetInventoryItemLink, "player", 16)
		local _, _, _, mainLoc = Try(C_Item and C_Item.GetItemInfoInstant, main)
		if mainLoc == "INVTYPE_2HWEAPON" then return Line("NeverQuestAlone: only with a one-hander (you wield a two-hander)", INFO) end
		if not worn[17] then return Line(empty, UP) end
		return Compare(mine, T.Score(worn[17], weights) or 0, NameOf(worn[17]), atLevel)
	end
	-- A one-hander goes in the main hand.
	if equipLoc == "INVTYPE_WEAPON" then
		if not worn[16] then return Line(empty, UP) end
		return Compare(mine, T.Score(worn[16], weights) or 0, NameOf(worn[16]), atLevel)
	end
	-- Rings and trinkets: a free slot takes it; else against the weaker of the two.
	if EITHER_SLOT[equipLoc] then
		for _, slot in ipairs(slots) do
			if not worn[slot] then return Line(empty, UP) end
		end
		local worst, worstLink
		for _, slot in ipairs(slots) do
			local sc = T.Score(worn[slot], weights) or 0
			if not worst or sc < worst then worst, worstLink = sc, worn[slot] end
		end
		return Compare(mine, worst, NameOf(worstLink), atLevel)
	end
	-- One slot.
	local slot = slots[1]
	if not worn[slot] then return Line(empty, UP) end
	return Compare(mine, T.Score(worn[slot], weights) or 0, NameOf(worn[slot]), atLevel)
end

-- How much more an item scores than what you wear where it goes, by the same
-- slots as the verdict (both hands for a two-hander, the weaker ring or
-- trinket, nothing worn counts 0): above 0 is an upgrade. nil when it isn't
-- gear or can't be worn with what you wield; nil and true while the game has
-- no stats for it yet (the item cache), which is never "no upgrade".
-- Quality of Life's Best Upgrade (QoL.lua) takes the biggest.
function T.Gain(link, weights)
	if not weights or not ItemString(link) then return nil end
	local _, _, _, equipLoc = Try(C_Item and C_Item.GetItemInfoInstant, link)
	local slots = type(equipLoc) == "string" and ns.Chats.EQUIP_SLOTS and ns.Chats.EQUIP_SLOTS[equipLoc]
	if not slots then return nil end
	local mine = T.Score(link, weights)
	if not mine then return nil, true end
	local function Worn(slot)
		local eq = Try(GetInventoryItemLink, "player", slot)
		return type(eq) == "string" and (T.Score(eq, weights) or 0) or 0
	end
	if equipLoc == "INVTYPE_2HWEAPON" then return mine - (Worn(16) + Worn(17)) end
	if OFF_HAND[equipLoc] then
		local _, _, _, mainLoc = Try(C_Item and C_Item.GetItemInfoInstant, Try(GetInventoryItemLink, "player", 16))
		if mainLoc == "INVTYPE_2HWEAPON" then return nil end
		return mine - Worn(17)
	end
	if equipLoc == "INVTYPE_WEAPON" then return mine - Worn(16) end
	if EITHER_SLOT[equipLoc] then
		local worst
		for _, slot in ipairs(slots) do
			local sc = Worn(slot)
			if not worst or sc < worst then worst = sc end
		end
		return mine - (worst or 0)
	end
	return mine - Worn(slots[1])
end

-- The post-call: our line under the game's own, on the main tooltips only.
function T.OnItemTooltip(tooltip, data)
	if tooltip ~= GameTooltip and tooltip ~= ItemRefTooltip then return end
	if type(tooltip.GetItem) ~= "function" then return end
	local _, link = Try(tooltip.GetItem, tooltip)
	local v = T.Verdict(link, data)
	if v then tooltip:AddLine(v.text, v.r, v.g, v.b, true) end
end

-- Weights arrived or changed: nothing is cached, so nothing to do but redraw
-- a tooltip that's open.
function T.Changed()
	if GameTooltip and GameTooltip.IsShown and GameTooltip:IsShown() and GameTooltip.RefreshData then
		pcall(GameTooltip.RefreshData, GameTooltip)
	end
end

if type(TooltipDataProcessor) == "table" and type(TooltipDataProcessor.AddTooltipPostCall) == "function"
	and type(Enum) == "table" and type(Enum.TooltipDataType) == "table" and Enum.TooltipDataType.Item then
	pcall(TooltipDataProcessor.AddTooltipPostCall, Enum.TooltipDataType.Item, function(tooltip, data)
		pcall(T.OnItemTooltip, tooltip, data)
	end)
	T.hooked = true
end
