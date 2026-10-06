-- NeverQuestAlone minimap pins: the map layers (Map.lua) drawn on the minimap too, so a
-- route can be followed without opening the world map.
--
-- Positions use Map.lua's geometry (continent map space measured in yards, the
-- math the route navigator uses), and the highlighted next stop is the
-- navigator's own state (NQAMapDB.nav), read at every draw: when the
-- navigator advances, the pins do too.
--
-- Forever's minimap is retail's (Blizzard_Minimap, Mainline family, build
-- 70009): C_Minimap.GetViewRadius() is the view radius in yards for the current
-- zoom and indoor or outdoor view, and the minimap turns with the player while
-- the rotateMinimap CVar is on, unless C_Minimap.IsRotateMinimapIgnored().
-- Addons that reshape the minimap say so through GetMinimapShape().
--
-- Display only: nothing here moves, targets, casts or acts for the player, or
-- sends chat. It hooks and changes no Blizzard frame: the pins are plain frames
-- parented to Minimap (not protected, so they also update in combat), and the
-- view is read by polling.
--
-- Cost: points are projected once per layer change (or continent change) into
-- 250-yard grid cells; a draw looks only at the cells around the player and
-- reuses pooled pin frames. Checks run 20 times a second (every frame only
-- while a rotating minimap turns), and pins move only when the player (a
-- pixel's worth), the view, the layers or the next stop changed.

local ADDON_NAME, ns = ...
local S = ns.MapShared -- Map.lua
if not S then return end

local P = {}
ns.MinimapPins = P

local CELL = 250   -- yards per grid cell
local TICK = 0.05  -- seconds between checks while nothing turns
local PIN, ROUTE_PIN, NEXT_PIN = 12, 14, 18
local MAX_PINS = 100
local ARROW_ATLAS = "Navigation-Tracked-Arrow" -- Forever's SuperTrackedFrame arrow, pointing up
local ARROW_FILE = "Interface\\Minimap\\MinimapArrow"
local ARROW_SIZE = 14
local EDGE_INSET = NEXT_PIN / 2 + ARROW_SIZE + 1 -- a pinned stop sits this far inside the rim, its arrow beyond it
local sqrt, floor, abs, sin, cos, max = math.sqrt, math.floor, math.abs, math.sin, math.cos, math.max
local atan2 = math.atan2 or math.atan -- Lua 5.1 in game; 5.3 in the test VM
local Try = S.Try

-- The quadrants that are round for each shape GetMinimapShape() may name:
-- { top-left, bottom-left, top-right, bottom-right }. Without it: round.
local SHAPES = {
	ROUND = { true, true, true, true },
	SQUARE = { false, false, false, false },
	["CORNER-TOPLEFT"] = { true, false, false, false },
	["CORNER-TOPRIGHT"] = { false, false, true, false },
	["CORNER-BOTTOMLEFT"] = { false, true, false, false },
	["CORNER-BOTTOMRIGHT"] = { false, false, false, true },
	["SIDE-LEFT"] = { true, true, false, false },
	["SIDE-RIGHT"] = { false, false, true, true },
	["SIDE-TOP"] = { true, false, true, false },
	["SIDE-BOTTOM"] = { false, true, false, true },
	["TRICORNER-TOPLEFT"] = { true, true, true, false },
	["TRICORNER-TOPRIGHT"] = { true, false, true, true },
	["TRICORNER-BOTTOMLEFT"] = { true, true, false, true },
	["TRICORNER-BOTTOMRIGHT"] = { false, true, true, true },
}

---------------------------------------------------------------------------
-- Points near the player: a grid of the layers' points on one continent
---------------------------------------------------------------------------

-- grid[Cell(cx, cy)] = { point, ... }; byStop[layer .. "\031" .. index] = point.
-- A point: { ex, sy (yards east and south of the continent's top-left corner),
-- layer, index, count, kind, label, title, ordered, p (the layer's own point) }.
local cache = { rev = -1, cont = nil, grid = {}, byStop = {} }
-- [code health AD-10] A cell's key as a number: the string keys ("12:34") were made
-- for every cell around the player 20 times a second while moving (17 KB/s).
local function Cell(cx, cy) return cx * 1048576 + cy end

local function Rebuild(cont)
	local grid, byStop = {}, {}
	cache.grid, cache.byStop, cache.cont, cache.rev = grid, byStop, cont, S.rev
	local w, h = S.ContinentYards(cont)
	if not (w and h) then return end
	local hidden = S.DB().hidden
	-- Each map projects onto the continent as x' = ox + sx * x: work it out once per map.
	local affine = {}
	for _, l in ipairs(S.Layers()) do
		if not hidden[l.name] then
			for i, p in ipairs(l.points) do
				local a = affine[p[1]]
				if a == nil then
					a = false
					if S.ContinentOf(p[1]) == cont then
						local x0, y0 = S.Project(p[1], 0, 0, cont)
						local x1, y1 = S.Project(p[1], 1, 1, cont)
						if x0 and x1 then a = { x0, y0, x1 - x0, y1 - y0 } end
					end
					affine[p[1]] = a
				end
				if a and tonumber(p[2]) and tonumber(p[3]) then
					local pt = {
						ex = (a[1] + a[3] * p[2] / 100) * w, sy = (a[2] + a[4] * p[3] / 100) * h,
						layer = l.name, index = i, count = #l.points, kind = p[5], label = p[4], title = l.title, ordered = l.ordered, p = p,
					}
					local key = Cell(floor(pt.ex / CELL), floor(pt.sy / CELL))
					local cell = grid[key]
					if not cell then cell = {}; grid[key] = cell end
					cell[#cell + 1] = pt
					if l.ordered then byStop[l.name .. "\031" .. i] = pt end
				end
			end
		end
	end
end

-- The player in the same yards, or nil (loading, an instance, no map here).
local function PlayerYards()
	local cont, px, py = S.PlayerOnContinent()
	if not cont then return end
	local w, h = S.ContinentYards(cont)
	if not (w and h) then return end
	return cont, px * w, py * h
end

---------------------------------------------------------------------------
-- Pins
---------------------------------------------------------------------------

local pool, used = {}, 0
local here = {} -- the player's position at the last draw, for tooltips
P.pool = pool

local function ShowTip(self)
	local pt = self.pt
	if not pt then return end
	-- The addon's one tooltip shape (ns.Tip): the stop, where it is on which
	-- route, what to do there and its quests, and how far.
	local dist = here.x and floor(sqrt((pt.ex - here.x) ^ 2 + (pt.sy - here.y) ^ 2) + 0.5)
	ns.Tip(self, {
		title = S.Esc((pt.label and pt.label ~= "") and pt.label or pt.layer),
		text = pt.ordered and ns.Fill(self.isNext and "Your next stop: {i} of {n}." or "Stop {i} of {n}.", { i = pt.index or 0, n = pt.count or 0 })
			or ns.Fill("On {route}.", { route = S.Esc(pt.title or pt.layer) }),
		lines = S.StopLines(pt.p),
		note = dist and string.format("%d yd away.", dist) or nil,
	}, "ANCHOR_LEFT")
end

local function HideTip()
	GameTooltip:Hide()
end

local function NewPin()
	local b = CreateFrame("Frame", nil, Minimap)
	b.ring = b:CreateTexture(nil, "ARTWORK")
	b.ring:SetPoint("CENTER")
	b.ring:SetTexture(S.CIRCLE)
	b.dot = b:CreateTexture(nil, "OVERLAY")
	b.dot:SetAllPoints()
	b.dot:SetTexture(S.CIRCLE)
	b.num = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.num:SetPoint("CENTER")
	b.num:SetTextColor(0, 0, 0)
	b.arrow = b:CreateTexture(nil, "OVERLAY")
	if b.arrow.SetAtlas and C_Texture and Try(C_Texture.GetAtlasExists, ARROW_ATLAS) then
		b.arrow:SetAtlas(ARROW_ATLAS)
		local info = Try(C_Texture.GetAtlasInfo, ARROW_ATLAS)
		local w, h = info and info.width or ARROW_SIZE, info and info.height or ARROW_SIZE
		local k = ARROW_SIZE / max(w, h, 1)
		b.arrow:SetSize(w * k, h * k)
	else
		b.arrow:SetTexture(ARROW_FILE)
		b.arrow:SetSize(ARROW_SIZE, ARROW_SIZE)
	end
	b.arrow:Hide()
	-- Hover shows the label; clicks go through to the minimap.
	b:EnableMouse(true)
	if b.SetMouseClickEnabled then b:SetMouseClickEnabled(false) end
	b:SetScript("OnEnter", ShowTip)
	b:SetScript("OnLeave", HideTip)
	return b
end

-- Pin n shows pt (the world map's icon for its kind: a dot in the kind's colour
-- on a black ring; the next stop is bigger, ringed in white).
local function Assign(n, pt, isNext)
	local b = pool[n]
	if not b then b = NewPin(); pool[n] = b end
	if b.pt ~= pt or b.isNext ~= isNext then
		local color = S.KIND_COLOR[pt.kind] or S.KIND_COLOR.poi
		local size = isNext and NEXT_PIN or (pt.ordered and ROUTE_PIN or PIN)
		b:SetSize(size, size)
		b.ring:SetSize(size + 3, size + 3)
		b.dot:SetVertexColor(color[1], color[2], color[3], 1)
		local r = isNext and 1 or 0
		b.ring:SetVertexColor(r, r, r, 0.9)
		b.num:SetText(pt.ordered and tostring(pt.index) or "")
		if b.num.SetTextScale then b.num:SetTextScale(isNext and 1 or 0.8) end
		b:SetFrameLevel(Minimap:GetFrameLevel() + (isNext and 6 or 5))
		b.pt, b.isNext = pt, isNext
	end
	return b
end

local function Place(b, dx, dy)
	b:ClearAllPoints()
	b:SetPoint("CENTER", Minimap, "CENTER", dx, dy)
	b:Show()
end

local function HideAll()
	for i = 1, used do pool[i]:Hide(); pool[i].pt = nil end
	used = 0
end

-- Pixels from the minimap's centre to pt: east is right, north is up, and a
-- rotating minimap turns everything by the player's facing.
local function Offset(pt, px, py, scale, facing, sn, cs)
	local dx, dy = (pt.ex - px) * scale, (py - pt.sy) * scale
	if facing then dx, dy = dx * cs + dy * sn, dy * cs - dx * sn end
	return dx, dy
end

-- (dx, dy) when a pin with this margin fits inside the minimap there;
-- otherwise the point on the edge (inset by margin) toward it, and true.
local function Clamp(dx, dy, w, h, margin, shape)
	local rx, ry = w / 2 - margin, h / 2 - margin
	if rx <= 0 or ry <= 0 then return 0, 0, true end
	local nx, ny = dx / rx, dy / ry
	local q = (dx < 0 and 1 or 3) + (dy < 0 and 1 or 0)
	local d = shape[q] and sqrt(nx * nx + ny * ny) or max(abs(nx), abs(ny))
	if d <= 1 then return dx, dy, false end
	return dx / d, dy / d, true
end

---------------------------------------------------------------------------
-- Drawing
---------------------------------------------------------------------------

local rotating = false  -- the rotateMinimap CVar
local dirty = true      -- an event says the view may have changed
local last = {}         -- what the pins show now

local function ReadRotate()
	local was = rotating
	rotating = Try(GetCVar, "rotateMinimap") == "1"
	if rotating ~= was then dirty = true end
end
P.ReadRotate = ReadRotate

-- facing: what the driver read this tick, so it's read once (nil: read here).
function P.Update(force, facing)
	local db = S.DB()
	local radius = C_Minimap and Try(C_Minimap.GetViewRadius)
	local cont, px, py
	if db.minimap and Minimap and Minimap:IsVisible() and type(radius) == "number" and radius > 0 then
		cont, px, py = PlayerYards()
	end
	local turn = cont and rotating and not Try(C_Minimap.IsRotateMinimapIgnored)
	facing = turn and (facing or Try(GetPlayerFacing)) or nil
	-- No position, or a turning minimap without the facing (hidden in instances): no pins.
	if not cont or (turn and not facing) then
		if used > 0 then HideAll() end
		last.cont = nil
		return
	end
	local w, h = Minimap:GetWidth(), Minimap:GetHeight()
	local shapeName = type(GetMinimapShape) == "function" and Try(GetMinimapShape) or "ROUND"
	local nav = db.nav
	local navLayer, navIndex = nav and nav.layer, nav and nav.index
	-- [code health AD-10] Pins move once the player has moved a pixel's worth of yards
	-- (radius / half the width): they moved 20 times a second for every 0.05 yd.
	local pixel = radius / max(1, w / 2)
	if not force and not dirty and last.cont == cont and abs(last.x - px) < pixel and abs(last.y - py) < pixel
		and last.radius == radius and last.facing == facing and last.w == w and last.h == h and last.shape == shapeName
		and last.rev == S.rev and last.navLayer == navLayer and last.navIndex == navIndex then
		return -- nothing moved
	end
	dirty = false
	last.cont, last.x, last.y, last.radius, last.facing, last.w, last.h, last.shape, last.rev, last.navLayer, last.navIndex =
		cont, px, py, radius, facing, w, h, shapeName, S.rev, navLayer, navIndex
	here.x, here.y = px, py
	P.draws = (P.draws or 0) + 1
	if cache.rev ~= S.rev or cache.cont ~= cont then Rebuild(cont) end

	local shape = SHAPES[shapeName] or SHAPES.ROUND
	local scale = (w / 2) / radius
	local sn, cs = 0, 1
	if facing then sn, cs = sin(facing), cos(facing) end
	local nextPt = navLayer and cache.byStop[navLayer .. "\031" .. tostring(navIndex)]
	local n = 0
	-- The cells the minimap can see (a square minimap's corners reach radius * sqrt 2).
	local reach = radius * 1.42
	for cx = floor((px - reach) / CELL), floor((px + reach) / CELL) do
		for cy = floor((py - reach) / CELL), floor((py + reach) / CELL) do
			local cell = cache.grid[Cell(cx, cy)]
			if cell then
				for _, pt in ipairs(cell) do
					if pt ~= nextPt and n < MAX_PINS then
						local dx, dy = Offset(pt, px, py, scale, facing, sn, cs)
						local _, _, out = Clamp(dx, dy, w, h, (pt.ordered and ROUTE_PIN or PIN) / 2, shape)
						if not out then
							n = n + 1
							local b = Assign(n, pt, false)
							b.arrow:Hide()
							Place(b, dx, dy)
						end
					end
				end
			end
		end
	end
	-- The next stop: always shown, on the edge and pointing at it when it's out of range.
	if nextPt then
		local dx, dy = Offset(nextPt, px, py, scale, facing, sn, cs)
		n = n + 1
		local b = Assign(n, nextPt, true)
		local _, _, out = Clamp(dx, dy, w, h, NEXT_PIN / 2, shape)
		if out then
			local ex, ey = Clamp(dx, dy, w, h, EDGE_INSET, shape)
			local len = sqrt(dx * dx + dy * dy)
			local ux, uy = dx / len, dy / len
			local gap = NEXT_PIN / 2 + ARROW_SIZE / 2
			b.arrow:ClearAllPoints()
			b.arrow:SetPoint("CENTER", b, "CENTER", ux * gap, uy * gap)
			b.arrow:SetRotation(atan2(-ux, uy))
			b.arrow:Show()
			b.onEdge = true
			Place(b, ex, ey)
		else
			b.arrow:Hide()
			b.onEdge = nil
			Place(b, dx, dy)
		end
	end
	for i = n + 1, used do pool[i]:Hide(); pool[i].pt = nil end
	used = n
end

---------------------------------------------------------------------------
-- Driver: a check 20 times a second, and every frame while the minimap turns
---------------------------------------------------------------------------

local driver = CreateFrame("Frame")
P.driver = driver
local acc, cvarAcc, lastFacing = 0, 0, nil

local function OnUpdate(_, elapsed)
	acc, cvarAcc = acc + elapsed, cvarAcc + elapsed
	if cvarAcc >= 1 then cvarAcc = 0; ReadRotate() end -- a setting changed without CVAR_UPDATE
	local f = rotating and Try(GetPlayerFacing) or nil
	if acc >= TICK or f ~= lastFacing then
		acc, lastFacing = 0, f
		P.Update(false, f)
	end
end

-- Map.lua calls this when layers, the hidden set, the next stop or the toggle
-- change. The driver runs only while there is something to draw.
function P.Wake()
	local db = S.DB()
	local any = false
	if db.minimap then
		for _, l in ipairs(S.Layers()) do
			if not db.hidden[l.name] and #l.points > 0 then any = true; break end
		end
	end
	dirty = true
	if any then
		driver:SetScript("OnUpdate", OnUpdate)
		P.Update(true)
	else
		driver:SetScript("OnUpdate", nil)
		HideAll()
		last.cont = nil
	end
end
S.OnChange = P.Wake

local EVENTS = { "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA", "ZONE_CHANGED", "ZONE_CHANGED_INDOORS", "MINIMAP_UPDATE_ZOOM", "CVAR_UPDATE" }
for _, e in ipairs(EVENTS) do pcall(driver.RegisterEvent, driver, e) end
driver:SetScript("OnEvent", function(_, event, name)
	if event == "PLAYER_LOGIN" then
		ReadRotate()
		P.Wake()
	elseif event == "CVAR_UPDATE" then
		if name == "rotateMinimap" or name == "ROTATE_MINIMAP" then ReadRotate() end
	else
		dirty = true -- zone, indoor/outdoor, zoom: checked on the next tick
	end
end)
