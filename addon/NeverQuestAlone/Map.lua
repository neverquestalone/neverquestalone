-- NeverQuestAlone map: layers the agent draws (routes, quest stops, marks), synced from the
-- bridge. (Upstream's herb and ore pins, from a node data addon that never came, are
-- gone: code health AD-19.)
--
-- A near-verbatim port of upstream wow-ai's Map.lua (RC-7): renamed to NQAMap,
-- NQAMapDB and "[NeverQuestAlone map]", its commands under /bones map, its data from
-- NQA_SlotData.map and NQA_Inbox.map (upstream's shape).
--
-- Layers arrive in slot files as { epoch, version, layers = { { name, title,
-- ordered, loop, points = { { uiMapID, x, y, label, kind[, note[, quests]] }, ... } } } };
-- x/y are map percent, note says what to do at a stop and quests are quest ids.
-- The bridge owns them; a newer version (or another epoch) replaces our copy
-- wholesale. Everything here reads positions and draws; nothing moves, targets
-- or acts for the player.
--
-- The minimap pins (MinimapPins.lua) share this file's layers, geometry and
-- navigator state through the addon's private table (ns.MapShared), so the
-- minimap and the navigator always agree on where the next stop is.

local ADDON_NAME, ns = ...
local M = {}
NQAMap = M

local ARRIVE_YARDS = 12
local PIN_SIZE = 16
local CIRCLE = "Interface\\CHARACTERFRAME\\TempPortraitAlphaMask"
local ARROW = "Interface\\Minimap\\MinimapArrow"
local CONTINENT = (Enum and Enum.UIMapType and Enum.UIMapType.Continent) or 2
local atan2 = math.atan2 or math.atan -- Lua 5.1 in game; 5.3 in the test VM

local KIND_COLOR = {
	ore = { 0.95, 0.6, 0.25 }, herb = { 0.35, 0.95, 0.35 }, quest = { 1, 0.85, 0 }, turnin = { 0.35, 0.8, 1 },
	kill = { 1, 0.3, 0.3 }, loot = { 1, 0.5, 0.85 }, object = { 0.8, 0.6, 1 }, explore = { 0.5, 1, 1 },
	npc = { 1, 1, 1 }, trainer = { 0.95, 0.95, 0.4 }, vendor = { 0.6, 0.95, 0.6 }, dungeon = { 1, 0.45, 0.1 },
	flight = { 0.55, 0.75, 1 }, poi = { 1, 1, 1 },
}

local mdb -- NQAMapDB: { map, hidden = { [layer] = true }, nav = { layer, index, held }, navPos, minimap }

local Try = ns.Try -- (Store.lua; code health AD-14)

-- Layer names, titles and labels come from the bridge: shown with | doubled,
-- so they read literally and can never form a game escape (ns.Escape).
local Esc = ns.Escape

-- [UX-5] Our own words in the companion's name (ns.P), before a quest
-- title or a layer's name joins them, so those are never rewritten.
local function PW(s)
	return (type(ns) == "table" and ns.P) and ns.P(s) or s
end

local function Print(msg)
	print((ns.Notify and ns.Notify.Prefix and ns.Notify.Prefix() or "|cff7ec8ff[NeverQuestAlone]|r ") .. msg) -- the one prefix (Notify.Prefix)
end

local function DB()
	if not mdb then
		NQAMapDB = NQAMapDB or {}
		mdb = NQAMapDB
		mdb.hidden = mdb.hidden or {}
		mdb.nodes = nil -- the node layer's settings, from before it went (AD-19)
		if mdb.minimap == nil then mdb.minimap = true end
	end
	return mdb
end

local function Layers()
	local m = DB().map
	return m and m.layers or {}
end

local function FindLayer(name)
	for i, l in ipairs(Layers()) do
		if l.name == name then return l, i end
	end
end

-- What the minimap pins read (never a copy): rev counts changes to the layers,
-- the hidden set, the navigator's stop and the minimap toggle; OnChange is
-- MinimapPins.lua's wake-up call.
local shared = { rev = 0 }
ns.MapShared = shared
local StartDriver -- the route's ticker (M.Drive, below)

local function Changed()
	shared.rev = shared.rev + 1
	if shared.OnChange then Try(shared.OnChange) end
	if StartDriver then StartDriver() end -- a route may have started (code health AD-20)
end

---------------------------------------------------------------------------
-- Map geometry (C_Map only; results cached)
---------------------------------------------------------------------------

local continentOf = {}
local function ContinentOf(mapID)
	if continentOf[mapID] ~= nil then return continentOf[mapID] or nil end
	local id, guard = mapID, 0
	while id and id > 0 and guard < 10 do
		local info = Try(C_Map.GetMapInfo, id)
		if type(info) ~= "table" then break end
		if info.mapType == CONTINENT then continentOf[mapID] = id; return id end
		id, guard = info.parentMapID, guard + 1
	end
	continentOf[mapID] = false
end

-- Where mapID's (x, y) (0-1) falls on `target` (0-1), or nil if it doesn't.
local function Project(mapID, x, y, target)
	if mapID == target then return x, y end
	local minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, mapID, target)
	if type(minX) == "number" and maxX ~= minX and maxY ~= minY then
		return minX + (maxX - minX) * x, minY + (maxY - minY) * y
	end
	-- `target` sits inside mapID (a city map shown while the point is on its zone).
	minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, target, mapID)
	if type(minX) == "number" and maxX ~= minX and maxY ~= minY then
		return (x - minX) / (maxX - minX), (y - minY) / (maxY - minY)
	end
end

-- Continent-space size in yards, measured from the engine's own map->world transform.
local continentSize = {}
local function ContinentYards(cont)
	if continentSize[cont] then return continentSize[cont][1], continentSize[cont][2] end
	local w, h
	if C_Map.GetWorldPosFromMapPos and CreateVector2D then
		local _, a = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(0, 0))
		local _, b = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(1, 0))
		local _, c = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(0, 1))
		if a and b and c then
			w = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
			h = math.sqrt((c.x - a.x) ^ 2 + (c.y - a.y) ^ 2)
		end
	end
	if not (w and h and w > 0 and h > 0) then
		local ww, hh = Try(C_Map.GetMapWorldSize, cont)
		w, h = ww, hh
	end
	if w and h and w > 0 and h > 0 then continentSize[cont] = { w, h } end
	return w, h
end

-- The player's position as (continent, cx, cy) in continent map space.
local function PlayerOnContinent()
	local mapID = Try(C_Map.GetBestMapForUnit, "player")
	if not mapID then return end
	local pos = Try(C_Map.GetPlayerMapPosition, mapID, "player")
	if not pos then return end
	local px, py = pos.x, pos.y
	if not px or (px == 0 and py == 0) then return end
	local cont = ContinentOf(mapID)
	if not cont then return end
	local cx, cy = Project(mapID, px, py, cont)
	if cx then return cont, cx, cy end
end

-- Yards and bearing (radians, counter-clockwise from north) from the player to a point.
local function Heading(p)
	local cont, px, py = PlayerOnContinent()
	if not cont then return nil, "off the map" end -- an instance: no place on a continent
	local tcont = ContinentOf(p[1])
	if tcont ~= cont then return nil, "on another continent" end
	local tx, ty = Project(p[1], p[2] / 100, p[3] / 100, cont)
	if not tx then return nil, "can't find this stop" end
	local w, h = ContinentYards(cont)
	local east, south = (tx - px) * (w or 1), (ty - py) * (h or 1)
	local dist = w and math.sqrt(east * east + south * south) or nil
	return dist, atan2(-east, -south)
end

-- Dead and released (a ghost): your corpse as a point, on the map you're on or
-- the first map above it that has it (C_DeathInfo.GetCorpseMapPosition, build
-- 70009; the world map's corpse pin makes the same call). nil while you're
-- alive; false when no map around you has it (it's in an instance).
local function Ghost() return Try(UnitIsGhost, "player") == true end
local function CorpsePoint()
	if not Ghost() then return nil end
	local DI = C_DeathInfo
	if not (DI and DI.GetCorpseMapPosition) then return false end
	local mapID, guard = Try(C_Map.GetBestMapForUnit, "player"), 0
	while type(mapID) == "number" and mapID > 0 and guard < 6 do
		local pos = Try(DI.GetCorpseMapPosition, mapID)
		if type(pos) == "table" and type(pos.x) == "number" and type(pos.y) == "number" and (pos.x ~= 0 or pos.y ~= 0) then
			return { mapID, pos.x * 100, pos.y * 100 }
		end
		local info = Try(C_Map.GetMapInfo, mapID)
		mapID, guard = type(info) == "table" and info.parentMapID or nil, guard + 1
	end
	return false
end

shared.Try, shared.Esc, shared.DB, shared.Layers = Try, Esc, DB, Layers
shared.KIND_COLOR, shared.CIRCLE = KIND_COLOR, CIRCLE
shared.ContinentOf, shared.Project, shared.ContinentYards, shared.PlayerOnContinent = ContinentOf, Project, ContinentYards, PlayerOnContinent

---------------------------------------------------------------------------
-- Stops: what to do there, and live progress from the player's quest log
---------------------------------------------------------------------------

-- A stop's quests are the agent's quest ids (point field 7). Without them, the
-- quests in the log whose whole title the stop's label or note names. Quest
-- state is read from the player's own quest log (C_QuestLog, build 70009);
-- questGen counts log changes, so the answers are cached until the next one.
local QL = C_QuestLog
local questGen = 0
local questLogReady = false -- the first QUEST_LOG_UPDATE of the session: before it, every quest looks missing
local turnedIn = {} -- this session's turn-ins (QUEST_TURNED_IN), before the flag catches up

local function Note(p) return type(p[6]) == "string" and p[6] or "" end

local logTitles, logTitlesGen
local function QuestLogTitles()
	if logTitles and logTitlesGen == questGen then return logTitles end
	logTitles, logTitlesGen = {}, questGen
	-- Every quest in the log (ns.QuestLog), to the last one, under a collapsed
	-- header too. It's read again after each change in the log.
	for _, q in ipairs((ns.QuestLog())) do
		if type(q.title) == "string" then logTitles[#logTitles + 1] = { title = q.title:lower(), id = q.id } end
	end
	return logTitles
end

-- "done" (turned in), "ready" (complete: turn it in), "active" (in the log) or "missing".
local function QuestState(id)
	if not QL then return "missing" end
	if turnedIn[id] or Try(QL.IsQuestFlaggedCompleted, id) then return "done" end
	if Try(QL.IsOnQuest, id) then
		if Try(QL.ReadyForTurnIn, id) or Try(QL.IsComplete, id) then return "ready" end
		return "active"
	end
	return "missing"
end

-- Is the stop finished? Its quests picked up (kind "quest"), turned in
-- ("turnin"), or complete (any other kind).
local function QuestsDone(kind, ids)
	for _, id in ipairs(ids) do
		local s = QuestState(id)
		if kind == "turnin" then
			if s ~= "done" then return false end
		elseif kind == "quest" then
			if s == "missing" then return false end
		elseif s ~= "ready" and s ~= "done" then
			return false
		end
	end
	return true
end

-- A quest's lines, as the HUD lists them (QuestRows): a quest under way is its
-- title on a line of its own, then one line per objective, its count and its
-- words ("- 1/8 Razormane Water Seeker", no "slain"; once done, grey with the
-- tracker's check in place of the dash); a
-- turned-in, ready or missing quest is one line, "{title} · turned in". Also
-- the same as data, for the HUD to draw in its own styles:
-- { title, state, what (a done/ready/missing line's words), pickup (missing at a stop to
-- pick it up), objectives = { { text, finished } } }.
-- A quest's title as the game's quest log and tracker show it (maintainer: its
-- colour for its level against yours): SetQuestTitleLevelAndDifficultyColor
-- (DifficultyUtil.lua, loaded for camelot) colours it (grey, green, yellow,
-- orange, red) when the map's quest-difficulty filter is on, and puts "[12]"
-- before it when you show quest levels or use colourblind mode (C-78). Where
-- it sets no colour, the caller's (the tracker's header gold).
local function QuestTitle(id, title)
	local t = type(SetQuestTitleLevelAndDifficultyColor) == "function" and Try(SetQuestTitleLevelAndDifficultyColor, id, title) or nil
	return (type(t) == "string" and t ~= "") and t or title
end
shared.QuestTitle = QuestTitle

local OBJ_DONE = "|TInterface\\Buttons\\UI-CheckBox-Check:0|t "
local function QuestLines(kind, ids)
	local out, quests = {}, {}
	for _, id in ipairs(ids) do
		local title = Esc(QL and Try(QL.GetTitleForQuestID, id) or ns.Fill("Quest {id}", { id = id }))
		local s = QuestState(id)
		local q = { id = id, title = title, state = s, objectives = {} }
		quests[#quests + 1] = q
		if s == "done" then
			q.what = "turned in"
		elseif s == "ready" then
			q.what = "complete, turn it in"
		elseif s == "missing" then
			q.what = kind == "quest" and "pick it up here" or "not in your quest log"
			q.pickup = kind == "quest" or nil -- the HUD says where its chain leads (HUD.lua ChainLine)
		end
		if q.what then
			local line = ns.Fill("{title} · {what}", { title = title, what = q.what })
			out[#out + 1] = (s == "ready" and (ns.GREEN_HEX or "|cff1aff1a") or "|cff808080") .. line .. "|r"
		else
			local qt = QuestTitle(id, title)
			if not qt:find("^|c") then qt = "|cffffd100" .. qt .. "|r" end -- no colour set: the tracker's header gold
			out[#out + 1] = qt
			for _, o in ipairs(QL and Try(QL.GetQuestObjectives, id) or {}) do
				if type(o) == "table" and type(o.text) == "string" and o.text ~= "" then
					q.objectives[#q.objectives + 1] = { text = Esc(o.text), finished = o.finished and true or false }
					local words, count = ns.SplitObjective(Esc(o.text))
					-- Done: the tracker's check and grey, never the colour alone (STYLE §14).
					local line = (count and (count .. " ") or "") .. (words ~= "" and words or Esc(o.text))
					out[#out + 1] = o.finished and ("|cff808080" .. OBJ_DONE .. line .. "|r") or ("- " .. line)
				end
			end
		end
	end
	return out, quests
end

-- What a stop needs, cached per point until the quest log changes:
-- { ids, lines, done (nil when it has no quests: arrival decides) }.
local stopInfo = setmetatable({}, { __mode = "k" })
local function StopInfo(p)
	local c = stopInfo[p]
	if c and c.gen == questGen then return c end
	local ids = {}
	if type(p[7]) == "table" and #p[7] > 0 then
		for _, id in ipairs(p[7]) do if type(id) == "number" then ids[#ids + 1] = id end end
	else
		-- Titles leave the log when a quest is turned in: keep what matched before.
		local seen = {}
		for _, id in ipairs(c and c.ids or {}) do ids[#ids + 1] = id; seen[id] = true end
		local text = ((p[4] or "") .. " " .. Note(p)):lower()
		for _, q in ipairs(QuestLogTitles()) do
			if not seen[q.id] and #q.title >= 5 and text:find(q.title, 1, true) then ids[#ids + 1] = q.id; seen[q.id] = true end
		end
	end
	local done -- stays nil without quests (not "a and b or nil": false would turn into nil)
	if #ids > 0 then done = QuestsDone(p[5], ids) end
	local lines, quests = QuestLines(p[5], ids)
	c = { gen = questGen, ids = ids, lines = lines, quests = quests, done = done, seenUndone = c and c.seenUndone }
	stopInfo[p] = c
	return c
end

-- A stop's note and quest lines, for its pins' tooltips (world map and
-- minimap): the lines of ns.Tip's shape.
local function StopLines(p)
	if type(p) ~= "table" then return {} end
	local out = {}
	local note = Note(p)
	if note ~= "" then out[#out + 1] = Esc(note) end
	for _, line in ipairs(StopInfo(p).lines) do out[#out + 1] = line end
	return out
end
shared.StopLines = StopLines

-- A stop whose quests are all missing (not in the log, not done), with no stop
-- ahead to pick them up, can't be done: the navigator moves past it (a quest
-- skipped at its pickup, or abandoned). Pickup stops never count as that.
local function Unavailable(l, i, p, info)
	if not questLogReady or p[5] == "quest" or #info.ids == 0 then return false end
	for _, id in ipairs(info.ids) do
		if QuestState(id) ~= "missing" then return false end
	end
	for j = i + 1, #l.points do
		local q = l.points[j]
		if q[5] == "quest" and type(q[7]) == "table" then
			for _, id in ipairs(info.ids) do
				for _, qid in ipairs(q[7]) do
					if qid == id then return false end
				end
			end
		end
	end
	return true
end

-- For the companion (Companion.lua): every quest id a layer's stops name.
function shared.CoveredQuests()
	local set = {}
	for _, l in ipairs(Layers()) do
		for _, p in ipairs(l.points or {}) do
			if type(p[7]) == "table" then
				for _, id in ipairs(p[7]) do set[id] = true end
			end
		end
	end
	return set
end

---------------------------------------------------------------------------
-- World map drawing
---------------------------------------------------------------------------

local overlay
local pins, pinCount = {}, 0
local lines, lineCount = {}, 0

-- A pin's tooltip, in the addon's one shape (ns.Tip): a route's stop (its
-- name; where it is on which route; its note and quests; what a click does).
local function ShowTip(self)
	local info = self.info
	if not info or not info.layer or not ns.Tip then return end
	local l = FindLayer(info.layer)
	local route = Esc(info.title or info.layer)
	local ordered = l and l.ordered
	ns.Tip(self, { title = Esc(info.label or ""), lines = StopLines(info.p),
		text = ordered and ns.Fill("Stop {i} of {n}.", { i = info.index or 0, n = #l.points }) or ns.Fill("On {route}.", { route = route }),
		actions = { ordered and "Click to follow the route from here" or "Click to go here" } })
end

local function NewPin(size)
	local b = CreateFrame("Button", nil, overlay)
	b:SetSize(size, size)
	b.dot = b:CreateTexture(nil, "OVERLAY")
	b.dot:SetAllPoints()
	b.dot:SetTexture(CIRCLE)
	b.ring = b:CreateTexture(nil, "ARTWORK")
	b.ring:SetPoint("CENTER")
	b.ring:SetSize(size + 4, size + 4)
	b.ring:SetTexture(CIRCLE)
	b.ring:SetVertexColor(0, 0, 0, 0.85)
	b.num = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.num:SetPoint("CENTER", 0, 0)
	b.num:SetTextColor(0, 0, 0)
	b:SetScript("OnEnter", ShowTip)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b:RegisterForClicks("LeftButtonUp")
	b:SetScript("OnClick", function(self)
		if self.info and self.info.layer then M.Navigate(self.info.layer, self.info.index) end
	end)
	return b
end

local function Place(frame, x, y, scale)
	local w, h = overlay:GetWidth(), overlay:GetHeight()
	frame:SetScale(scale)
	frame:ClearAllPoints()
	frame:SetPoint("CENTER", overlay, "TOPLEFT", x * w / scale, -y * h / scale)
	frame:Show()
end

local function CanvasScale()
	local s = WorldMapFrame and WorldMapFrame.GetCanvasScale and Try(WorldMapFrame.GetCanvasScale, WorldMapFrame)
	return (type(s) == "number" and s > 0) and s or 1
end

local function AddLine(x1, y1, x2, y2, color, thickness)
	lineCount = lineCount + 1
	local l = lines[lineCount]
	if not l then
		l = overlay:CreateLine(nil, "ARTWORK")
		lines[lineCount] = l
	end
	local w, h = overlay:GetWidth(), overlay:GetHeight()
	l:SetThickness(thickness)
	l:SetColorTexture(color[1], color[2], color[3], 0.75)
	l:SetStartPoint("TOPLEFT", overlay, x1 * w, -y1 * h)
	l:SetEndPoint("TOPLEFT", overlay, x2 * w, -y2 * h)
	l:Show()
end

function M.Refresh()
	if not overlay or not WorldMapFrame:IsShown() then return end
	for i = 1, pinCount do pins[i]:Hide() end
	for i = 1, lineCount do lines[i]:Hide() end
	pinCount, lineCount = 0, 0
	local mapID = WorldMapFrame:GetMapID()
	if not mapID then return end
	local scale = 1 / CanvasScale()
	overlay.drawnScale = CanvasScale()
	local nav = DB().nav
	for _, l in ipairs(Layers()) do
		if not mdb.hidden[l.name] then
			local prev, first
			for i, p in ipairs(l.points) do
				local x, y = Project(p[1], p[2] / 100, p[3] / 100, mapID)
				local inside = x and x >= 0 and x <= 1 and y >= 0 and y <= 1
				if inside then
					local color = KIND_COLOR[p[5]] or KIND_COLOR.poi
					if l.ordered and prev then AddLine(prev[1], prev[2], x, y, color, 2.5 * scale) end
					pinCount = pinCount + 1
					local b = pins[pinCount]
					if not b then b = NewPin(PIN_SIZE); pins[pinCount] = b end
					local current = nav and nav.layer == l.name and nav.index == i
					b.dot:SetVertexColor(color[1], color[2], color[3], 1)
					b.ring:SetVertexColor(current and 1 or 0, current and 1 or 0, current and 1 or 0, 0.9)
					b.num:SetText(l.ordered and tostring(i) or "")
					b:SetFrameLevel(overlay:GetFrameLevel() + (current and 20 or 10))
					b.info = { title = l.title, label = p[4] ~= "" and p[4] or l.name, layer = l.name, index = i, p = p }
					Place(b, x, y, scale)
					prev = { x, y }
					first = first or { x, y, color }
				else
					prev = nil
				end
			end
			-- A loop closes back to its first stop.
			if l.loop and l.ordered and prev and first and #l.points > 2 then
				AddLine(prev[1], prev[2], first[1], first[2], first[3], 2.5 * scale)
			end
		end
	end
end

local function SetupWorldMap()
	if overlay or not WorldMapFrame or not WorldMapFrame.GetCanvas then return end
	local canvas = WorldMapFrame:GetCanvas()
	overlay = CreateFrame("Frame", nil, canvas)
	overlay:SetAllPoints(canvas)
	overlay:SetFrameLevel(canvas:GetFrameLevel() + 2000)
	if type(WorldMapFrame.OnMapChanged) == "function" then hooksecurefunc(WorldMapFrame, "OnMapChanged", M.Refresh) end
	WorldMapFrame:HookScript("OnShow", M.Refresh)
	-- Ctrl+right-click on the map: ask Bones about that spot (the map's own click
	-- handlers, Blizzard_MapCanvas; a plain right-click still zooms out).
	if type(WorldMapFrame.AddCanvasClickHandler) == "function" then
		pcall(WorldMapFrame.AddCanvasClickHandler, WorldMapFrame, function(_, button, cursorX, cursorY)
			if button ~= "RightButton" or not (type(IsControlKeyDown) == "function" and IsControlKeyDown()) then return false end
			local mapID = WorldMapFrame:GetMapID()
			if not mapID or type(cursorX) ~= "number" or type(cursorY) ~= "number" or not ns.QuickAsk then return false end
			local info = Try(C_Map.GetMapInfo, mapID)
			ns.QuickAsk("spot", { mapID = mapID, x = cursorX, y = cursorY, mapName = type(info) == "table" and info.name or nil })
			return true
		end, 100)
	end
	-- Keep pins the same size on screen while zooming.
	overlay:SetScript("OnUpdate", function(self, elapsed)
		self.t = (self.t or 0) + elapsed
		if self.t < 0.1 then return end
		self.t = 0
		if math.abs(CanvasScale() - (self.drawnScale or 0)) > 0.01 then M.Refresh() end
	end)
end

---------------------------------------------------------------------------
-- Navigator: arrow, distance, and auto-advance along an ordered layer
---------------------------------------------------------------------------

local nav

local function NavPoint()
	local n = DB().nav
	if not n then return end
	local l = FindLayer(n.layer)
	if not l or not l.points[n.index] then return end
	return l, l.points[n.index], n.index
end

local NAV_WIDTH, NAV_TEXT = 320, 262

local function NavString(font, lines)
	local s = nav:CreateFontString(nil, "OVERLAY", font)
	s:SetWidth(NAV_TEXT)
	s:SetJustifyH("LEFT")
	s:SetWordWrap(lines > 1)
	if s.SetMaxLines then s:SetMaxLines(lines) end
	return s
end

-- The route's next stop as the game's own waypoint (the in-world marker with
-- its distance, as a Ctrl-click on the map makes): C_Map.SetUserWaypoint and
-- C_SuperTrack.SetSuperTrackedUserWaypoint, both in Forever's UI code (build
-- 70009). Only a waypoint we set is ever cleared, so one you placed yourself
-- stays. /bones waypoint off turns it off.
local waypoint -- { key, mapID, x, y }: the one we set
local function WaypointWanted()
	local s = ns.db and ns.db.settings
	return not s or s.waypoint ~= false
end

local function ClearWaypoint()
	if not waypoint then return end
	local cur = C_Map and Try(C_Map.GetUserWaypoint)
	local pos = type(cur) == "table" and cur.position
	if type(cur) == "table" and cur.uiMapID == waypoint.mapID and type(pos) == "table"
		and math.abs((pos.x or -1) - waypoint.x) < 1e-4 and math.abs((pos.y or -1) - waypoint.y) < 1e-4 then
		Try(C_Map.ClearUserWaypoint)
		if C_SuperTrack then Try(C_SuperTrack.SetSuperTrackedUserWaypoint, false) end
	end
	waypoint = nil
end

-- The game keeps one waypoint, so a new stop's replaces the last; ours is
-- cleared only when a stop can't be pinned (so a stale one doesn't linger).
local function SetWaypoint(key, p)
	if waypoint and waypoint.key == key then return true end
	if not WaypointWanted() or not (C_Map and C_Map.SetUserWaypoint and UiMapPoint and UiMapPoint.CreateFromCoordinates) then
		ClearWaypoint()
		return false
	end
	local mapID, x, y = p[1], p[2] / 100, p[3] / 100
	local point = (not C_Map.CanSetUserWaypointOnMap or Try(C_Map.CanSetUserWaypointOnMap, mapID)) and Try(UiMapPoint.CreateFromCoordinates, mapID, x, y)
	if not point or not Try(C_Map.SetUserWaypoint, point) then
		ClearWaypoint()
		return false
	end
	if C_SuperTrack then Try(C_SuperTrack.SetSuperTrackedUserWaypoint, true) end
	waypoint = { key = key, mapID = mapID, x = x, y = y }
	return true
end
shared.ClearWaypoint = ClearWaypoint

function M.WaypointSettingChanged()
	if not WaypointWanted() then ClearWaypoint() end
	M.UpdateNavigator()
end

local function BuildNavigator()
	nav = CreateFrame("Frame", "NQANavigator", UIParent, "BackdropTemplate")
	nav:SetSize(NAV_WIDTH, 44)
	nav:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 12, insets = { left = 3, right = 3, top = 3, bottom = 3 } })
	nav:SetBackdropColor(0, 0, 0, 0.7)
	-- Its own place, or docked beside the quest tracker under the small bar
	-- (the HUD shows the route when it is on).
	local p = DB().navPos
	if p then nav:SetPoint(p[1], UIParent, p[1], p[2], p[3]) else ns.UI.Dock(nav, -36) end
	nav:SetMovable(true)
	nav:EnableMouse(true)
	nav:RegisterForDrag("LeftButton")
	nav:SetScript("OnDragStart", nav.StartMoving)
	nav:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, _, x, y = self:GetPoint()
		DB().navPos = { point, x, y }
	end)
	nav.arrow = nav:CreateTexture(nil, "ARTWORK")
	nav.arrow:SetSize(34, 34)
	nav.arrow:SetPoint("TOPLEFT", 6, -5)
	nav.arrow:SetTexture(ARROW)
	-- The stop (2 lines), then distance, route and the stop after it. What to do
	-- there and its quests' counts are kept for the tooltip only (maintainer: "dont
	-- show the descriptions"). A right-click never steps the route (maintainer:
	-- "right clicking is skipping quests"): /bones map next and prev do.
	nav.title = NavString("GameFontNormal", 2)
	nav.note = NavString("GameFontHighlightSmall", 4)
	nav.quests = NavString("GameFontHighlightSmall", 6)
	nav.text = NavString("GameFontHighlightSmall", 1)
	nav.note:Hide()
	nav.quests:Hide()
	nav:SetScript("OnEnter", function(self)
		local lines = {}
		for _, fs in ipairs({ self.note, self.quests }) do
			local t = fs:GetText()
			if t and t ~= "" then lines[#lines + 1] = t end
		end
		ns.Tip(self, { title = "Route", text = "A stop with quests moves on when they're done; any other stop when you get there.",
			lines = lines, actions = { "Drag to move it" }, note = "/nqa map next or prev steps it; /nqa map lists the options." }, "ANCHOR_BOTTOM")
	end)
	nav:SetScript("OnLeave", function() GameTooltip:Hide() end)
	nav:Hide()
end

-- The route runs on its own ticker, so it still moves on while the navigator's
-- frame is hidden (the HUD shows the route then).
-- [code health AD-20] Only while there's a route to follow or a corpse to find: it ran
-- every frame for good, checking for a ghost 10 times a second. A change to the
-- routes (Changed), the login and dying, releasing and coming back (the events at
-- the end of this file) start it; it stops itself once neither is left.
local driver = CreateFrame("Frame")
local function Drive(self, elapsed)
	self.t = (self.t or 0) + elapsed
	if self.t < 0.1 then return end
	self.t = 0
	if mdb and (mdb.nav or shared.navView) then M.UpdateNavigator() end
	M.UpdateCorpse()
	if not (mdb and (mdb.nav or shared.navView)) and not shared.corpseView and not Ghost() then self:SetScript("OnUpdate", nil) end
end
function M.Drive()
	if driver:GetScript("OnUpdate") ~= Drive then driver:SetScript("OnUpdate", Drive) end
end
StartDriver = M.Drive
M.driver = driver

-- While you're a ghost, the arrows point to your corpse (the HUD's copy:
-- shared.corpseView, like navView; the distance every tick), then back to
-- the route once you're alive.
function M.UpdateCorpse()
	local p = CorpsePoint()
	local view = shared.corpseView
	if p == nil then
		if view then
			shared.corpseView = nil
			if ns.HUD then ns.HUD.Render() end
		end
		return
	end
	local fresh = view == nil
	view = view or {}
	local dist, bearing
	if p then dist, bearing = Heading(p) else bearing = "not on this map" end
	view.dist = dist
	view.bearing = type(bearing) == "number" and bearing or nil
	view.where = (not dist and type(bearing) == "string") and bearing or nil
	shared.corpseView = view
	if fresh and ns.HUD then ns.HUD.Render() end
end

-- /bones roll: one of your quests with a point on this map, picked at random,
-- as the game's waypoint. Local: no Bones, no slots.
function M.Roll()
	DB()
	if mdb.nav and FindLayer(mdb.nav.layer) then
		Print("You're following a route: /nqa map stop first, then roll.")
		return nil
	end
	local mapID = Try(C_Map.GetBestMapForUnit, "player")
	local list = mapID and QL and Try(QL.GetQuestsOnMap, mapID)
	local picks = {}
	for _, q in ipairs(type(list) == "table" and list or {}) do
		if type(q) == "table" and type(q.questID) == "number" and type(q.x) == "number" and type(q.y) == "number" then picks[#picks + 1] = q end
	end
	if #picks == 0 then
		Print("None of your quests has a point on this map.")
		return nil
	end
	local q = picks[math.random(1, #picks)]
	local title = Try(QL.GetTitleForQuestID, q.questID)
	local set = SetWaypoint("roll:" .. q.questID, { mapID, q.x * 100, q.y * 100 })
	-- [UX-5] Our words in the companion's name (PW), before the quest's title joins them.
	Print(ns.Fill(PW(set and "NeverQuestAlone rolled: {quest}. Waypoint set." or "NeverQuestAlone rolled: {quest}."), { quest = Esc(type(title) == "string" and title or ns.Fill("Quest {id}", { id = q.questID })) }))
	return q.questID
end

-- Stack the strings that have text and fit the box around them.
local function LayoutNavigator()
	local y = -7
	for _, s in ipairs({ nav.title, nav.text }) do
		if s:GetText() ~= "" then
			s:ClearAllPoints()
			s:SetPoint("TOPLEFT", 46, y)
			s:Show()
			y = y - s:GetStringHeight() - 3
		else
			s:Hide()
		end
	end
	nav:SetHeight(math.max(44, 5 - y))
end

function M.UpdateNavigator()
	local l, p, i = NavPoint()
	if not l then
		if nav then nav:Hide() end
		if waypoint and not waypoint.key:find("^roll:") then ClearWaypoint() end -- a /bones roll pin stays
		if shared.navView then
			shared.navView = nil
			if ns.HUD then ns.HUD.Render() end
		end
		return
	end
	if not nav then BuildNavigator() end
	-- The HUD shows the route (HUD.ShowsRoute); this frame, only where HUD.lua
	-- isn't loaded yet, keeps its stop's lines either way.
	local shown = not (ns.HUD and ns.HUD.ShowsRoute and ns.HUD.ShowsRoute())
	if shown ~= nav.wasShown then nav.wasShown, nav.key = shown, nil end -- shown again: its lines laid out afresh (below)
	nav:SetShown(shown)
	local info = StopInfo(p)
	local dist, bearing = Heading(p)
	-- [code health AD-10] The waypoint's key only for a new stop: it was made 10 times a second.
	if not (waypoint and waypoint.p == p and waypoint.index == i and waypoint.layer == l.name) then
		SetWaypoint(l.name .. ":" .. i .. ":" .. p[1] .. ":" .. p[2] .. ":" .. p[3], p)
		if waypoint then waypoint.p, waypoint.index, waypoint.layer = p, i, l.name end
	end
	-- The HUD's copy of the route (HUD.lua reads it; the distance every tick).
	local view = shared.navView
	local fresh = not view or view.layer ~= l.name or view.index ~= i or view.gen ~= questGen or view.rev ~= shared.rev
	if fresh then
		view = { layer = l.name, gen = questGen, rev = shared.rev, title = l.title or l.name, index = i, total = #l.points,
			label = p[4] ~= "" and p[4] or l.title, note = Note(p), questLines = info.lines, quests = info.quests }
		shared.navView = view
	end
	view.dist = dist
	view.bearing = type(bearing) == "number" and bearing or nil
	view.where = (not dist and type(bearing) == "string") and bearing or nil
	view.waypoint = waypoint ~= nil
	if fresh and ns.HUD then ns.HUD.Render() end
	-- [code health AD-10] The arrow and its line only while this frame shows: hidden (the HUD
	-- shows the route), they were set 10 times a second for no one.
	if shown then
		local nextI = i < #l.points and i + 1 or (l.loop and 1 or nil)
		local np = nextI and l.points[nextI]
		local after = np and string.format("|cff888888  then %s|r", Esc(np[4] ~= "" and np[4] or (nextI .. "/" .. #l.points))) or ""
		local corpse = shared.corpseView
		if corpse then
			-- A ghost: the arrow is your corpse's until you're alive again.
			local facing = Try(GetPlayerFacing)
			nav.arrow:SetShown(corpse.dist ~= nil)
			nav.arrow:SetRotation((facing and corpse.bearing) and (corpse.bearing - facing) or 0)
			nav.text:SetText(ns.Fill("Your corpse: {where}", { where = corpse.dist and string.format("%d yd", math.floor(corpse.dist + 0.5)) or (corpse.where or "") }))
		elseif not dist and type(bearing) == "string" then
			nav.arrow:Hide()
			nav.text:SetText(bearing .. after)
		else
			nav.arrow:Show()
			local facing = Try(GetPlayerFacing)
			if facing and bearing then nav.arrow:SetRotation(bearing - facing) else nav.arrow:SetRotation(0) end
			nav.text:SetText((dist and string.format("%d yd  |cff888888%s|r", math.floor(dist + 0.5), Esc(l.title)) or Esc(l.title)) .. after)
		end
	end
	-- The stop's own lines change with the route, the stop or the quest log, not every tick.
	local key = shared.rev .. ":" .. questGen
	if nav.key ~= key then
		nav.key = key
		nav.title:SetText(string.format("%d/%d  %s", i, #l.points, Esc(p[4] ~= "" and p[4] or l.title)))
		nav.note:SetText(Esc(Note(p)))
		nav.quests:SetText(table.concat(info.lines, "\n"))
		LayoutNavigator()
	end
	-- A stop you chose is held (Hold): not passed over, and reached only once
	-- you've been away from it.
	local held = type(mdb.nav.held) == "table" and mdb.nav.held.index == i and mdb.nav.held or nil
	if held and dist and dist > ARRIVE_YARDS then held.away = true end
	-- A stop that can't be done (its quests aren't in the log and nothing ahead
	-- picks them up) is passed over, so one route stays current as you play.
	if not l.loop and not held and Unavailable(l, i, p, info) then
		Print(string.format("Skipped %s: it isn't in your quest log.", Esc(p[4] ~= "" and p[4] or (i .. "/" .. #l.points))))
		M.Step(1, true)
		return
	end
	-- Moving on: a stop with quests when they're done (a loop only by arrival,
	-- it's a circuit); any other stop on arrival.
	if info.done ~= nil and not l.loop then
		if info.done then
			-- Stops that were done before we got to them are skipped quietly; one
			-- you chose after it was done stays until you move on.
			if not (held and held.done) then
				if info.seenUndone then Try(PlaySound, SOUNDKIT and SOUNDKIT.MAP_PING or 3175) end
				M.Step(1, true)
			end
		else
			info.seenUndone = true
			if held then held.done = false end -- done from here on moves on, as any stop
		end
	elseif dist and dist <= ARRIVE_YARDS and not Ghost() and (not held or held.away) then -- a ghost running past arrives nowhere
		Try(PlaySound, SOUNDKIT and SOUNDKIT.MAP_PING or 3175)
		M.Step(1, true)
	end
end

-- A stop you stepped to (the HUD's bar; next, prev and the navigator's
-- right-click) is held there (maintainer: back or ahead along the route). A held
-- stop isn't passed over for being done already or for being unavailable, and
-- it counts as reached only once you've been away from it, so choosing the
-- stop you stand at doesn't move on at once. Once its quests get done after
-- you chose it, it moves on as any stop does. Following a route (a pin, /bones
-- map nav) isn't stepping: it starts where it can.
local function Hold(l, index)
	local p = l and l.points[index]
	DB().nav.held = { index = index, done = p ~= nil and StopInfo(p).done == true, away = false }
end

-- The HUD's bar: go to a stop of the route you follow, back or ahead.
function M.Focus(index)
	local l = NavPoint()
	if not l then return end
	index = math.max(1, math.min(math.floor(tonumber(index) or 1), #l.points))
	DB().nav.index = index
	Hold(l, index)
	Changed()
	M.Refresh()
	M.UpdateNavigator()
end

-- A stop's name on the route you follow (the bar's tooltips).
function M.StopLabel(index)
	local l = NavPoint()
	local p = l and l.points[index]
	if not p then return nil end
	return (type(p[4]) == "string" and p[4] ~= "") and p[4] or string.format("%d/%d", index, #l.points)
end

function M.Navigate(layer, index)
	local l = FindLayer(layer)
	if not l then Print(ns.Fill("Nothing on the map is called {name}. /nqa map lists what's there.", { name = Esc(layer) })); return end
	DB().nav = { layer = layer, index = math.max(1, math.min(index or 1, #l.points)) }
	mdb.lastNav = layer
	mdb.hidden[layer] = nil
	Changed()
	M.UpdateNavigator()
	M.Refresh()
end

-- The route a detour left (FollowDrawn), if it's still on the map.
local function DetourBack()
	local b = mdb.nav and mdb.nav.back
	local l = type(b) == "table" and FindLayer(b.layer)
	if not l or #l.points == 0 then return nil end
	return l, math.max(1, math.min(math.floor(tonumber(b.index) or 1), #l.points))
end

function M.Step(delta, arrived)
	local l, _, i = NavPoint()
	if not l then return end
	local nexti = i + delta
	if nexti > #l.points then
		if l.loop then nexti = 1 else
			-- A detour done goes back to the route where you left it; the route
			-- isn't finished, so Bones isn't told it is.
			local back, backIndex = DetourBack()
			if back then
				Print(ns.Fill("Reached {stop}. Back to {route}.", { stop = Esc(M.StopLabel(i) or l.title or l.name), route = Esc(back.title or back.name) }))
				if arrived and ns.HUD and ns.HUD.DetourDone then Try(ns.HUD.DetourDone, M.StopLabel(i) or l.title or l.name, back.title or back.name) end
				mdb.nav = { layer = back.name, index = backIndex }
				mdb.lastNav = back.name
				Changed()
				M.UpdateNavigator()
				M.Refresh()
				return
			end
			Print(ns.Fill("Route finished: {title}.", { title = Esc(l.title or l.name) }))
			-- Finished by getting there: a moment in the HUD.
			if arrived and ns.HUD and ns.HUD.RouteDone then Try(ns.HUD.RouteDone, l.title or l.name, #l.points) end
			mdb.nav = nil
			Changed()
			-- Finished by getting there (or past stops that can't be done), not by skipping ahead.
			if arrived and shared.OnRouteDone then Try(shared.OnRouteDone, l) end
			M.UpdateNavigator()
			M.Refresh()
			return
		end
	elseif nexti < 1 then
		nexti = l.loop and #l.points or 1
	end
	mdb.nav.index = nexti
	if not arrived then Hold(l, nexti) end -- next or prev by hand: held there (Hold)
	Changed()
	M.Refresh()
	if not arrived then M.UpdateNavigator() end
end

-- What a reply drew, to follow (Okay on that reply; maintainer: "when bones suggests
-- a path, im clicking okay and then its not adopting the path"): its route,
-- else the one place it marked. Marks of several places with no order aren't
-- a way to go. A place while you're on a route is a detour: reaching it goes
-- back to the route where you left it (Step). Returns the layer followed, and
-- whether it was already the one you follow.
function M.PickDrawn(names)
	DB()
	if type(names) ~= "table" then return nil end
	local place
	for _, name in ipairs(names) do
		local l = type(name) == "string" and FindLayer(name)
		if l and #l.points > 0 then
			if l.ordered then return l end
			if not place and #l.points == 1 then place = l end
		end
	end
	return place
end

function M.FollowDrawn(names)
	local l = M.PickDrawn(names)
	if not l then return nil end
	local n = mdb.nav
	local cur = n and FindLayer(n.layer)
	if cur and cur.name == l.name then return l, true end
	-- A detour keeps the route it left (a second detour, the first one's).
	local back
	if not l.ordered and cur then
		if DetourBack() then back = n.back
		elseif cur.ordered then back = { layer = cur.name, index = n.index } end
	end
	-- As Navigate, with the way back set before the navigator first looks.
	mdb.nav = { layer = l.name, index = 1, back = back }
	mdb.lastNav = l.name
	mdb.hidden[l.name] = nil
	Changed()
	M.UpdateNavigator()
	M.Refresh()
	return l, false
end

function M.Stop()
	DB().nav = nil
	Changed()
	M.UpdateNavigator()
	M.Refresh()
end

---------------------------------------------------------------------------
-- Sync from the bridge
---------------------------------------------------------------------------

local function LayerKey(l)
	local parts = { l.title or "", tostring(l.ordered), tostring(l.loop), #(l.points or {}) }
	for _, p in ipairs(l.points or {}) do
		parts[#parts + 1] = table.concat({ p[1], p[2], p[3], p[4], Note(p), type(p[7]) == "table" and table.concat(p[7], "/") or "" }, ",")
	end
	return table.concat(parts, ";")
end

function M.Sync(m)
	if type(m) ~= "table" or type(m.layers) ~= "table" then return end
	local cur = DB().map
	if cur and cur.epoch == m.epoch and (tonumber(m.version) or 0) <= (tonumber(cur.version) or 0) then return end
	local old = {}
	for _, l in ipairs(cur and cur.layers or {}) do old[l.name] = LayerKey(l) end
	local layers, changed = {}, {}
	-- [code health AD-15] A point the game can't place goes (no map id, x and y as finite
	-- numbers): the navigator works with them 10 times a second, so one bad point raised
	-- an error every tick. The app sends only good ones (protocol.js validateMapCommand).
	local function Num(v) return type(v) == "number" and v == v and v ~= math.huge and v ~= -math.huge end
	for _, l in ipairs(m.layers) do
		if type(l) == "table" and type(l.name) == "string" and type(l.points) == "table" then
			local points = {}
			for _, p in ipairs(l.points) do
				if type(p) == "table" and Num(p[1]) and Num(p[2]) and Num(p[3]) then points[#points + 1] = p end
			end
			l.points = points
			layers[#layers + 1] = l
			if old[l.name] ~= LayerKey(l) then changed[#changed + 1] = l end
		end
	end
	mdb.map = { epoch = m.epoch, version = tonumber(m.version) or 0, layers = layers }
	-- Drop navigation that points at a layer that is gone (a detour's goes back
	-- to its route, if that's still there).
	if mdb.nav and not FindLayer(mdb.nav.layer) then
		local back, backIndex = DetourBack()
		mdb.nav = back and { layer = back.name, index = backIndex } or nil
	end
	for _, l in ipairs(changed) do
		mdb.hidden[l.name] = nil
		Print(l.ordered
			and ns.Plural(#l.points, "Route of 1 stop on your map: {title}. Open the map (M) to see it.", "Route of {n} stops on your map: {title}. Open the map (M) to see it.", { title = Esc(l.title or l.name) })
			or ns.Plural(#l.points, "1 pin on your map: {title}. Open the map (M) to see it.", "{n} pins on your map: {title}. Open the map (M) to see them.", { title = Esc(l.title or l.name) }))
		-- A new or changed route on the player's continent starts navigation at its first
		-- stop, unless the player is already following another route.
		local here = PlayerOnContinent()
		local free = not mdb.nav or mdb.nav.layer == l.name
		if l.ordered and #l.points > 0 and free and (not here or ContinentOf(l.points[1][1]) == here) then
			mdb.nav = { layer = l.name, index = 1 }
		end
	end
	Changed()
	if shared.OnRoutesChanged then Try(shared.OnRoutesChanged) end
	M.UpdateNavigator()
	M.Refresh()
end

---------------------------------------------------------------------------
-- /bones map (Commands.lua calls M.Command)
---------------------------------------------------------------------------

local function Status()
	local layers = Layers()
	if #layers == 0 then Print(PW("Nothing on the map yet. Ask for a route, like: /nqa route me through copper veins in Loch Modan")) end -- [UX-5]
	for _, l in ipairs(layers) do
		local count = l.ordered and ns.Plural(#l.points, "1 stop", "{n} stops") or ns.Plural(#l.points, "1 pin", "{n} pins")
		local following = (mdb.nav and mdb.nav.layer == l.name) and ns.Fill("  following, stop {i} of {n}", { i = mdb.nav.index, n = #l.points }) or ""
		Print(string.format("%s%s|r  %s (%s)%s", mdb.hidden[l.name] and "|cff888888" or "|cffffffff", Esc(l.name), Esc(l.title), count, following))
	end
	Print("Minimap pins: " .. (mdb.minimap and "on" or "off") .. ".")
	-- The commands, as the addon's help writes them (STYLE §3), with | escaped so it shows (Esc).
	for _, line in ipairs({
		"/nqa map show|hide <name>  Show or hide routes and marks on your map",
		"/nqa map nav [name [stop number]]  Follow a route",
		"/nqa map next|prev  Go to the next or previous stop",
		"/nqa map stop  End the route you're following",
		"/nqa map minimap [on|off]  Show or hide pins on the minimap",
	}) do Print(Esc(line)) end
end

function M.Command(msg)
	DB()
	local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = (cmd or ""):lower()
	if cmd == "" then Status()
	elseif (cmd == "show" or cmd == "hide") and rest ~= "" then
		if not FindLayer(rest) then Print(ns.Fill("Nothing on the map is called {name}. /nqa map lists what's there.", { name = Esc(rest) })); return end
		mdb.hidden[rest] = (cmd == "hide") or nil
		Changed()
		M.Refresh()
	elseif cmd == "minimap" then
		local v = rest:lower()
		mdb.minimap = (v == "on") or (v ~= "off" and not mdb.minimap)
		Print("Minimap pins " .. (mdb.minimap and "shown." or "hidden."))
		Changed()
	elseif cmd == "nav" then
		local name, idx = rest:match("^(%S+)%s*(%d*)$")
		if not name then
			-- No layer named: the route you last followed, else the only one there is.
			name = mdb.lastNav
			if not name or not FindLayer(name) then
				local routes = {}
				for _, l in ipairs(mdb.map and mdb.map.layers or {}) do
					if l.ordered then routes[#routes + 1] = l.name end
				end
				name = #routes == 1 and routes[1] or nil
			end
			if not name then Print("Which route? /nqa map lists them; /nqa map nav <name> follows one."); return end
		end
		M.Navigate(name, tonumber(idx))
	elseif cmd == "next" then M.Step(1)
	elseif cmd == "prev" then M.Step(-1)
	elseif cmd == "stop" then M.Stop()
	else Status() end
end

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
-- A level-up too: a quest's colour for its level against yours changes then.
for _, e in ipairs({ "QUEST_LOG_UPDATE", "QUEST_ACCEPTED", "QUEST_REMOVED", "QUEST_TURNED_IN", "QUEST_WATCH_UPDATE", "PLAYER_LEVEL_UP" }) do pcall(ev.RegisterEvent, ev, e) end
-- [code health AD-20] Dying, releasing (a ghost), coming back, and every loading screen: the route's ticker looks again.
-- Forever has all three death events, and its own UI runs on them (wow-ui-source forever e3ecc27b, 1.60.1.70205):
-- documented in Blizzard_APIDocumentationGenerated/DeathInfoDocumentation.lua:125, 131, 147; registered through
-- Blizzard_Game.toc:12, 16, 42 (Camelot/Startup.lua:1, Camelot/EventRouting.lua:10-11, 22-25, Mainline/EventRouting.lua:78)
-- for the death popup and the ghost frame (Camelot/EventImplementation.lua:17, 37; Mainline/EventImplementation.lua:249).
local DRIVE_EVENTS = { PLAYER_ENTERING_WORLD = true, PLAYER_DEAD = true, PLAYER_ALIVE = true, PLAYER_UNGHOST = true }
for e in pairs(DRIVE_EVENTS) do pcall(ev.RegisterEvent, ev, e) end
ev:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" and (arg1 == ADDON_NAME or arg1 == "Blizzard_WorldMap") then
		DB()
		SetupWorldMap()
	elseif event == "PLAYER_LOGIN" then
		DB()
		SetupWorldMap()
		M.UpdateNavigator()
		M.Drive() -- a route kept from the last session (code health AD-20)
	elseif DRIVE_EVENTS[event] then
		M.Drive()
	else
		-- The quest log changed: stop progress is read again on the next tick.
		if event == "QUEST_TURNED_IN" and type(arg1) == "number" then turnedIn[arg1] = true end
		if event == "QUEST_LOG_UPDATE" then questLogReady = true end
		questGen = questGen + 1
	end
end)
