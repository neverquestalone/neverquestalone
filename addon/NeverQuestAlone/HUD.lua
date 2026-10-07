-- HUD.lua: the Bones HUD, a small panel to read while you play (the UI
-- review's first move). By default it sits left of the quest tracker, level
-- with its top, anchored to it so it follows wherever Edit Mode puts the
-- tracker. It is the game's own portrait frame, as the backpack is: Bones's
-- skull in the round slot at its top-left corner, the gold-trimmed border, the
-- title band. Only its controls take the mouse: clicks and mouselook anywhere
-- else on it reach the world. Everything is a click (maintainer, 2026-09-26: "click
-- explicit, not hover"); the pointer only lights what it's on.
--   - The portrait: click opens your chats in the window, right-click the menu,
--     drag moves the HUD. It lights up under the pointer, as a bag's does, and
--     a small dot on its edge says Bones's state (blue thinking, gold news, red
--     trouble).
--   - The title band: drag it to move the HUD, right-click it for the menu. The
--     button at its right end makes the HUD one line.
--   - Beside the portrait: a status line in Bones's voice ("Reading the old
--     scrolls…") over a quieter second line ("14 s · usually 20 s"); a
--     connection problem comes first. At its right, Ask: a box right here.
--   - News: "Bones says" beside the portrait, what he says (the reply's TL;DR)
--     under it, and only Okay (it's read, nothing is sent) and Open chat (the
--     same bubble as Ask). Nothing else to click (maintainer, 2026-09-26).
--   - Working: what you asked (or the game sent), with Stop.
--   - The route you follow: its name with Re-plan, Skip and End; stop n of m
--     on a segmented bar; an arrow with the stop, its distance and which way
--     ("ahead", "to your left"); what to do there; each quest's objectives as a
--     list, with your live counts, and under a quest that's a step of a chain,
--     where it leads (Chains.lua). While you're a ghost the route steps aside
--     (maintainer): only the arrow to your corpse, how far and which way.
-- Minimized, in combat and while the window is open, it's one bar: the arrow,
-- the quest it points to, the distance and the route's bar (a box you're
-- typing in keeps the panel until Enter or Esc); minimized further, the
-- compass: the arrow and the distance. One type scale, one set of colour roles and a 4-unit
-- spacing rhythm run through all of it (the UI critic's round 7).
-- Nothing here acts in the game: the box sends as the window does.

local _, ns = ...
local H = {}
ns.HUD = H
local R = ns.R

-- [code health AD-04] The layout's constants (sizes, colours, times, art and words), in
-- one table: as ~90 locals they held this chunk at 198 of Lua 5.1's 200, and three
-- more broke the file (tests/lua51_runtime_test.mjs keeps 20 spare in every file).
local L = {}

-- Spacing (§3): a 12-unit gutter, then 4 between lines of a group (LINE), 8
-- between content and its controls (CONTROLS), 12 between groups (GROUP).
L.W, L.PAD = 300, 12
L.LINE, L.CONTROLS, L.GROUP = 4, 8, 12
L.TITLE_H = 21 -- the frame's title band (the game's panel frame)
-- The backpack's own corner (HeldBagLayout, ContainerFrame.lua): a 36-unit
-- portrait at -4, +1 of the corner, the title from 35. It reaches this far
-- right and down; the header sits right of it, the content under it.
L.PORTRAIT, L.PORTRAIT_X, L.PORTRAIT_Y, L.TITLE_X = 36, -4, 1, 35
L.PORTRAIT_R, L.PORTRAIT_B = L.PORTRAIT_X + L.PORTRAIT, L.PORTRAIT - L.PORTRAIT_Y
L.CORNER = "ui-frame-portraitmetal-cornertopleftsmall" -- HeldBagLayout's top-left, 16 above the frame
L.HEAD_X = L.PORTRAIT_R + L.CONTROLS -- the header's text
L.HEAD_Y = L.TITLE_H + L.LINE -- its top, just under the title band
L.MIN_BTN = 24 -- the corner's buttons, minimize and close (0 to 24)
-- Ask, clear of the corner's metal (maintainer: too close to the top right
-- borders): 12 under the corner's buttons, on the right gutter with the rest;
-- the status line is centred on it.
L.ASK_Y, L.ASK_R = L.MIN_BTN + L.GROUP, L.PAD
L.ICON = 20 -- the route heading row's height, and its icons' boxes
L.GLYPH = 16 -- the route's icons, in their boxes
L.ASK_W = 56 -- the header's Ask button
L.STATUS_W = L.W - L.HEAD_X - L.ASK_R - L.ASK_W - L.CONTROLS
L.BUTTON_W, L.BUTTON_H, L.BOX_H, L.BOX_INSET = 64, 22, 28, 8
L.ROUTE_ASK_W = 124 -- "Ask for a Route", and room to grow (STYLE §12)
L.SEGMENTS_MAX, L.SEG_H, L.SEG_GAP = 12, 4, 2
L.ARROW, L.ARROW_COL = 44, 48 -- the route's arrow, in a column this wide (28 read too small in game)
L.STOP_X = L.PAD + L.ARROW_COL + L.CONTROLS
L.BULLET, L.BULLET_X = 10, L.PAD + 2 -- the objectives' list
-- A chained quest's mark, on the bullets' column: the quest log's own dungeon and raid icons (Forever's
-- QUEST_TAG_ATLAS, Blizzard_FrameXMLBase/Constants.lua), a reward's own item icon.
L.CHAIN_ICON = 12
L.CHAIN_ATLAS = { dungeon = "questlog-questtypeicon-dungeon", raid = "questlog-questtypeicon-raid" }
-- The one-line HUD (minimized, in combat, with the window open).
L.BAR_ARROW = 30 -- the one line's arrow
L.CORNER_BTN = 24 -- the corner's buttons
L.UNDO_SECONDS, L.FLASH_SECONDS = 3, 6
L.LAST_SESSION_FOR = 600 -- s after login the last session shows
L.DING_SECONDS, L.MOMENT_SECONDS, L.QUIP_SECONDS, L.QUIP_GAP = 10, 6, 8, 60
L.REPLAN_FOR = 180 -- s the route heading says "Re-planning…" at most
L.NEAR_YD = 20 -- the arrow turns green this close to the stop
L.CIRCLE = "Interface\\CHARACTERFRAME\\TempPortraitAlphaMask"
L.ARROW_FILE = "Interface\\Minimap\\MinimapArrow" -- the minimap's own arrow, pointing up

-- Colour roles (§2), after the quest tracker's: gold names things (headings,
-- labels, quest titles), white is what you read or act on now, light is body
-- text, grey is meta, green is done or here, red is an error.
L.GOLD = { 1, 0.82, 0 }
L.WHITE = { 1, 1, 1 }
L.LIGHT = { 0.8, 0.8, 0.8 }
L.GREY = { 0.6, 0.6, 0.6 }
L.GREEN = ns.GREEN or { 0.1, 1, 0.1 } -- the game's own, shared (Store.lua)
L.RED = { 1, 0.13, 0.13 }
L.STATE_COLOR = { thinking = { 0.49, 0.78, 1 }, news = L.GOLD, error = L.RED } -- idle: no dot
-- The route bar: done, the stop you're on (with a white edge), still to come.
L.SEG_DONE, L.SEG_NOW, L.SEG_TODO = { 0.78, 0.62, 0.1 }, { 1, 0.82, 0 }, { 0.35, 0.29, 0.20 }
local function Hex(c)
	return string.format("|cff%02x%02x%02x", math.floor(c[1] * 255 + 0.5), math.floor(c[2] * 255 + 0.5), math.floor(c[3] * 255 + 0.5))
end

-- The type scale (§1): six styles, each one font object made once from the
-- game's own, so they follow its font and the UI scale. Sizes since the maintainer's
-- "some of the list / description text is too small" (2026-09-26): nothing
-- under 11.
--   H heading (14): the route's name. L label (12): "Welcome", a quest's name.
--   P primary (13): the status, what Bones says, the stop. V value (16): the
--   distance. B body (12): notes, objectives, what you asked. M meta (11):
--   second lines, counts, which way.
L.STYLE = {
	H = { "GameFontNormal", 14, L.GOLD }, -- gold set outright, not left to the copied font
	L = { "GameFontNormal" },
	P = { "GameFontHighlight", 13, L.WHITE },
	V = { "GameFontHighlight", 16, L.WHITE },
	B = { "GameFontHighlight", nil, L.LIGHT },
	M = { "GameFontDisableSmall", 11, L.GREY },
}
local fonts = {}
local function Font(style)
	if fonts[style] then return fonts[style] end
	local spec, name = L.STYLE[style], L.STYLE[style][1]
	if spec[2] and type(CreateFont) == "function" and type(_G[spec[1]]) == "table" then
		local ok, f = pcall(CreateFont, "NQAHUDFont" .. style)
		if ok and f and type(f.CopyFontObject) == "function" then
			pcall(f.CopyFontObject, f, _G[spec[1]])
			local file, _, flags = f:GetFont()
			if file then pcall(f.SetFont, f, file, spec[2], flags or "") end
			name = "NQAHUDFont" .. style
		end
	end
	fonts[style] = name
	return name
end

local h = {} -- the frames
H.h = h
local news -- { chat, t, kind, drew }: the newest reply or error, until read or dismissed
local asked -- { chat, t }: the chat an ask from here, a chip or a quick ask went to
local ding -- { level, untilT }
local moment -- { line, sub, untilT }: a finished route, or a detour's place reached
local quip -- { text, untilT }
local flash -- { text, sub, untilT }: a send that didn't go
local pending -- { owner, words, untilT }: a send from here, still undoable
local replanning -- { layer, rev, chat, at }: a re-plan asked, until the new route comes
local showFull -- Show More (or /bones hud full) asked for the panel now: combat and the open window don't fold it
local lastQuipAt

local Try = ns.Try
local function S() return ns.db and ns.db.settings end
local Call = ns.Call -- (Store.lua; code health AD-14)

-- The addon's one tooltip shape (UI.lua, ns.Tip), to the left: the HUD sits
-- at the screen's right, by the quest tracker.
local function ShowTip(owner, t) ns.Tip(owner, ns.OurTip(t), "ANCHOR_LEFT") end -- [UX-5] our words in the companion's name
local function HideTip() if GameTooltip then GameTooltip:Hide() end end

local function Paint(s, c) s:SetTextColor(c[1], c[2], c[3]) end

-- A text in one of the styles; lines 0 wraps without a limit.
H.Font = Font -- the banner (UI.lua) sets its words in the HUD's type

local function Text(parent, style, lines)
	local s = parent:CreateFontString(nil, "OVERLAY", Font(style))
	s:SetJustifyH("LEFT")
	s:SetJustifyV("TOP")
	s:SetWordWrap((lines or 1) ~= 1)
	if s.SetMaxLines then s:SetMaxLines(lines or 1) end
	if L.STYLE[style][3] then Paint(s, L.STYLE[style][3]) end
	s.style = style
	return s
end
local function Restyle(s, style)
	if s.style == style then return end
	s:SetFontObject(Font(style))
	if L.STYLE[style][3] then Paint(s, L.STYLE[style][3]) end
	s.style = style
end

-- The game's own art where this client has it: an atlas, else a file (checked
-- with GetFileIDFromPath where it exists), else a fallback file.
local function Art(tex, atlas, file, fallback)
	if atlas and tex.SetAtlas and C_Texture and Try(C_Texture.GetAtlasExists, atlas) then
		tex:SetAtlas(atlas)
		return true
	end
	local path = file or fallback
	if file and fallback and type(GetFileIDFromPath) == "function" then
		local id = Try(GetFileIDFromPath, file)
		if not id or id == 0 then path = fallback end
	end
	tex:SetTexture(path)
	return false
end

-- The shortest the panel can be: its portrait, and a gutter under it. Not the
-- corner art's size (C-77): GetAtlasInfo gives some 150 for it in game, which
-- made the HUD huge; the game's own short panels with this corner (a bag of
-- one row, ReadyCheckFrame at 112) just crop their bottom corners (FitHeight).
-- Never shorter than the metal corners need (the portrait's top one 75 tall
-- at +16, the bottom ones 32 at -8 on Forever): shorter, the game crops the
-- bottom corners and the sides stop short of them (maintainer).
L.UNCROPPED_H = 75 + 32 - 16 - 8
local function MinHeight() return math.max(L.PORTRAIT_B + L.GROUP, L.UNCROPPED_H) end

-- A new height, and the bottom corners cropped where they'd meet the top one,
-- as bags do on every resize (ContainerFrame.lua, NineSlice.lua).
local function FitHeight(f, height)
	f:SetHeight(height)
	if type(NineSliceUtil) == "table" and type(NineSliceUtil.UpdateCornerCropping) == "function" then
		pcall(NineSliceUtil.UpdateCornerCropping, f, height)
	end
end

-- The game's red button: one per block, for its main action.
-- A click that takes a block away (Okay, Got it) pulls what was under it up
-- under the pointer: for a moment the HUD's buttons let a second click of it
-- pass, as JustMoved does after a drag (C-72).
L.OKAY_TIP = { title = "Okay", text = "Marks the reply read and puts it away; nothing is sent." }
L.TIMED = { flash = true, moment = true, ding = true, quip = true } -- header lines that end by themselves (E-1)
-- The first button of a reply that drew a route, or put one pin, follows it
-- (maintainer: "when bones suggests a path, im clicking okay and then its not
-- adopting the path"; Map.FollowDrawn), and says so on its face (C-100):
-- Follow Route or Follow Pin, just Follow in the bar and the banner; Okay
-- when there's nothing new to follow. Its tooltip names what it follows.
L.FOLLOW_W, L.FOLLOW_SHORT_W = 104, 60 -- room to grow (STYLE §12)
local function Drawn(drew)
	local l = drew and type(NQAMap) == "table" and NQAMap.PickDrawn and NQAMap.PickDrawn(drew)
	local r = ns.MapShared and ns.MapShared.navView
	if not l or (r and r.layer == l.name) then return nil end
	return l
end
local function OkayLabel(drew, short)
	local l = Drawn(drew)
	if not l then return "Okay" end
	if short then return "Follow" end
	return l.ordered and "Follow Route" or "Follow Pin"
end
H.OkayLabel = OkayLabel
local function OkayTip(drew, short)
	local l = Drawn(drew)
	if not l then return L.OKAY_TIP end
	local name = ns.Escape(H.Unapprox and H.Unapprox(l.title or l.name) or (l.title or l.name))
	local title = OkayLabel(drew, short)
	if l.ordered then
		return { title = title, text = string.format("Marks the reply read and follows the route it drew: %s.", name) }
	end
	return { title = title, text = string.format("Marks the reply read and points the arrow at the pin it put: %s.", name) }
end
H.OkayTip = OkayTip
L.GUARD_SECONDS = 0.4
local function Guarded() return h.guardUntil ~= nil and GetTime() < h.guardUntil end
local function Guard() h.guardUntil = GetTime() + L.GUARD_SECONDS end

local function RedButton(parent, label, onClick, tip, width)
	local b = ns.UI.Button(parent, label, width or L.BUTTON_W, function(...)
		if Guarded() then return end
		onClick(...)
	end)
	b:SetHeight(L.BUTTON_H)
	b.tip = tip -- its tooltip (ns.Tip's shape); a render may change it
	if tip then
		b:SetScript("OnEnter", function(self) ShowTip(self, self.tip) end)
		b:SetScript("OnLeave", HideTip)
	end
	return b
end

-- The route's two actions (maintainer: Re-plan and End only, icons, not buttons):
-- the game's common icons (common-icon-rotateright, -undo, -yellowx), one gold,
-- in 20-unit boxes with the game's highlight; a click is taken as the red
-- buttons' are (the guard after Okay). Their tooltips say what they do.
L.ICON_GOLD = { 1, 0.82, 0 }
local function IconArt(tex, atlas, fallback)
	if tex.SetAtlas and C_Texture and Try(C_Texture.GetAtlasExists, atlas) then
		tex:SetAtlas(atlas)
	else
		tex:SetTexture(fallback)
	end
	Call(tex, "SetDesaturated", true) -- one gold for both, whatever each atlas's own colour
	tex:SetVertexColor(L.ICON_GOLD[1], L.ICON_GOLD[2], L.ICON_GOLD[3])
end
local function IconAction(parent, atlas, fallback, onClick)
	local b = CreateFrame("Button", nil, parent)
	b:SetSize(L.ICON, L.ICON)
	b.icon = b:CreateTexture(nil, "ARTWORK")
	b.icon:SetSize(L.GLYPH, L.GLYPH)
	b.icon:SetPoint("CENTER", b, "CENTER", 0, 0)
	IconArt(b.icon, atlas, fallback)
	local hl = b:CreateTexture(nil, "HIGHLIGHT")
	hl:SetAllPoints(b)
	hl:SetTexture("Interface\\Buttons\\UI-Common-MouseHilight")
	Call(hl, "SetBlendMode", "ADD")
	b:RegisterForClicks("LeftButtonUp")
	b:SetScript("OnMouseDown", function(self) self.icon:SetPoint("CENTER", self, "CENTER", 1, -1) end)
	b:SetScript("OnMouseUp", function(self) self.icon:SetPoint("CENTER", self, "CENTER", 0, 0) end)
	b:SetScript("OnClick", function(self, button)
		if Guarded() then return end
		HideTip()
		onClick(self, button)
	end)
	b:SetScript("OnLeave", HideTip)
	return b
end
L.REPLAN_ICON, L.UNDO_ICON, L.END_ICON = "common-icon-rotateright", "common-icon-undo", "common-icon-yellowx"
L.REPLAN_FILE, L.END_FILE = "Interface\\Buttons\\UI-RefreshButton", "Interface\\Buttons\\UI-GroupLoot-Pass-Up"

-- The corner's buttons: the game's red set, shared with the window (UI.lua
-- KitButton), so + is the exact inverse of -, beside the same X.
local function KitButton(parent, kind, onClick, size) return ns.UI.KitButton(parent, kind, onClick, size or L.CORNER_BTN) end

-- The round highlight a bag's portrait shows under the pointer ("bags-
-- roundhighlight"), else the minimap buttons' own.
local function RoundGlow(parent, size)
	local g = parent:CreateTexture(nil, "HIGHLIGHT")
	g:SetSize(size, size)
	g:SetPoint("CENTER", parent, "CENTER", 0, 0)
	Art(g, "bags-roundhighlight", "Interface\\Minimap\\UI-Minimap-ZoomButton-Highlight")
	Call(g, "SetBlendMode", "ADD")
	return g
end

-- The game's multi-line input border (the nine pieces of InputScrollFrameTemplate),
-- on the box's own edges: it stretches to any height, as the one-line
-- template's 20-tall art can't.
L.BORDER = "Interface\\Common\\Common-Input-Border-"
local function InputBorder(box)
	local function Piece(key)
		local t = box:CreateTexture(nil, "BACKGROUND")
		t:SetTexture(L.BORDER .. key)
		return t
	end
	local tl, tr, bl, br = Piece("TL"), Piece("TR"), Piece("BL"), Piece("BR")
	for _, c in ipairs({ tl, tr, bl, br }) do c:SetSize(8, 8) end
	tl:SetPoint("TOPLEFT", box, "TOPLEFT", 0, 0)
	tr:SetPoint("TOPRIGHT", box, "TOPRIGHT", 0, 0)
	bl:SetPoint("BOTTOMLEFT", box, "BOTTOMLEFT", 0, 0)
	br:SetPoint("BOTTOMRIGHT", box, "BOTTOMRIGHT", 0, 0)
	local top, bottom, left, right, mid = Piece("T"), Piece("B"), Piece("L"), Piece("R"), Piece("M")
	top:SetPoint("TOPLEFT", tl, "TOPRIGHT", 0, 0)
	top:SetPoint("BOTTOMRIGHT", tr, "BOTTOMLEFT", 0, 0)
	bottom:SetPoint("TOPLEFT", bl, "TOPRIGHT", 0, 0)
	bottom:SetPoint("BOTTOMRIGHT", br, "BOTTOMLEFT", 0, 0)
	left:SetPoint("TOPLEFT", tl, "BOTTOMLEFT", 0, 0)
	left:SetPoint("BOTTOMRIGHT", bl, "TOPRIGHT", 0, 0)
	right:SetPoint("TOPLEFT", tr, "BOTTOMLEFT", 0, 0)
	right:SetPoint("BOTTOMRIGHT", br, "TOPRIGHT", 0, 0)
	mid:SetPoint("TOPLEFT", left, "TOPRIGHT", 0, 0)
	mid:SetPoint("BOTTOMRIGHT", right, "BOTTOMLEFT", 0, 0)
end

-- Bones's state as a dot with a dark rim: blue (breathing) while he thinks, gold
-- for news, red for trouble; none when idle.
local function StateDot(parent, size)
	local d = CreateFrame("Frame", nil, parent)
	d:SetSize(size, size)
	d.rim = d:CreateTexture(nil, "OVERLAY", nil, 1)
	d.rim:SetAllPoints()
	d.rim:SetTexture(L.CIRCLE)
	d.rim:SetVertexColor(0.05, 0.04, 0.03, 1)
	d.fill = d:CreateTexture(nil, "OVERLAY", nil, 2)
	d.fill:SetPoint("TOPLEFT", d, "TOPLEFT", 2, -2)
	d.fill:SetPoint("BOTTOMRIGHT", d, "BOTTOMRIGHT", -2, 2)
	d.fill:SetTexture(L.CIRCLE)
	d.pulse = d.fill:CreateAnimationGroup()
	local a = d.pulse:CreateAnimation("Alpha")
	if a then
		if a.SetFromAlpha then a:SetFromAlpha(1) end
		if a.SetToAlpha then a:SetToAlpha(0.3) end
		if a.SetDuration then a:SetDuration(0.9) end
	end
	if d.pulse.SetLooping then d.pulse:SetLooping("BOUNCE") end
	return d
end

local function PaintState(d, state)
	local c = L.STATE_COLOR[state]
	d:SetShown(c ~= nil)
	if not c then return end
	d.fill:SetVertexColor(c[1], c[2], c[3], 1)
	if state == "thinking" then
		if not d.pulse:IsPlaying() then d.pulse:Play() end
	elseif d.pulse:IsPlaying() then
		d.pulse:Stop()
		d.fill:SetAlpha(1)
	end
end

-- The route's arrow: the minimap's own, in its own silver (maintainer: "silver/
-- white"; untinted), pointing where to go or to your corpse; green when you're
-- there, hidden with no bearing (another continent).
local function Arrow(parent, size)
	local t = parent:CreateTexture(nil, "OVERLAY")
	t:SetSize(size, size)
	t:SetTexture(L.ARROW_FILE)
	return t
end

-- Which way, in words, from how far the stop is turned from where you face
-- (0 ahead, and counterclockwise, as the game's facing: 90 is left).
L.WAYS = { "ahead", "ahead, left", "to your left", "behind, left", "behind you", "behind, right", "to your right", "ahead, right" }
local function Way(rel)
	local d = math.deg(rel) % 360
	return L.WAYS[math.floor((d + 22.5) / 45) % 8 + 1]
end
H.Way = Way

-- What the arrow row can show: 2 while the arrow points (a distance, a
-- bearing, and which way you face), 1 with only a distance, 0 with neither
-- (an instance, another continent). A change lays the HUD out again (C-85):
-- the arrow's column shows only while it points, in every form (C-84, C-90).
local function NavState(v)
	if not (v and v.dist) then return 0 end
	return (v.bearing ~= nil and Try(GetPlayerFacing) ~= nil) and 2 or 1
end
H.NavState = NavState

-- "off the map" said on its own: "Off the map".
local function Capital(s)
	return (s:gsub("^%l", string.upper))
end

local function PointArrow(t, v)
	local facing = Try(GetPlayerFacing)
	if v and v.dist and v.bearing and facing then
		local c = v.dist <= L.NEAR_YD and L.GREEN or L.WHITE
		t:SetVertexColor(c[1], c[2], c[3], 1)
		t:SetRotation(v.bearing - facing)
		t:Show()
		return Way(v.bearing - facing)
	end
	t:Hide()
end

---------------------------------------------------------------------------
-- What to show
---------------------------------------------------------------------------

function H.Active()
	local s = S()
	return s ~= nil and s.hud == true
end

-- Where news shows: the HUD, unless it's the compass, which shows only the
-- arrow and the distance; then a toast, as with the HUD off (Notify, C-87).
function H.ShowsNews()
	local s = S()
	return H.Active() and not (s.hudMin and s.hudCompass)
end

-- The HUD shows the route, never the navigator's frame (Map.lua's, now only
-- for a game where this file isn't loaded yet): in the panel, the bar or the
-- compass while it's on, and closed or off on its own bar (maintainer).
function H.ShowsRoute()
	return ns.db ~= nil
end

-- The HUD on screen: its one line while that's up, else the panel (the two
-- share their top-left corner).
function H.Frame() return (h.bar ~= nil and h.bar:IsShown() and h.bar) or h.frame end

local function Working()
	local n = 0
	for _, c in ipairs(ns.db.chats) do
		if ns.Chats.IsBusy(c) then n = n + 1 end
	end
	return n
end

-- A busy chat to report on: the one you last asked from here, else any.
local function BusyChat()
	if asked then
		local c = ns.Chats.Find(asked.chat)
		if c and ns.Chats.IsBusy(c) then return c end
	end
	local last = ns.db.lastPing and ns.Chats.Find(ns.db.lastPing)
	if last and ns.Chats.IsBusy(last) then return last end
	for _, c in ipairs(ns.db.chats) do
		if ns.Chats.IsBusy(c) then return c end
	end
end

-- The newest thing Bones said in a chat: { entry, chat }, a reply or an error.
local function Newest(chatId)
	local c = ns.Chats.Find(chatId)
	if not c then return nil end
	for i = #c.history, 1, -1 do
		local e = c.history[i]
		-- [C-31] A line that answers nothing (a map block that didn't draw) isn't what was said;
		-- automatic help pausing itself is.
		if e.role == "assistant" or (e.err and (not e.info or e.kind == "auto_paused")) then return e, c end
		if e.role == "user" then return nil end
	end
end

-- What Bones is working on: the entry of the oldest pending send (yours, or
-- the game's), else the newest of them.
local function AskedEntry(chat)
	local p = chat.pending[1]
	for i = #chat.history, 1, -1 do
		local e = chat.history[i]
		if e.role == "user" and (not p or e.key == p.key) then return e end
	end
end

-- "You asked: …" (or "From the game: …"), led in gold.
local function AskedBody(chat)
	local ae = chat and AskedEntry(chat)
	return ae and (Hex(L.GOLD) .. (ae.event and "From the game:" or "You asked:") .. "|r "
		.. ns.Escape(ae.event and (ae.text or "") or ns.Chats.PlainWords(ae))) or ""
end

-- A reply or error Quiet in Combat holds until the fight ends (Notify,
-- R.dndQueue): the newest, else nil. Not one the window shows already (C-107).
local function HeldNews()
	local q = R.dndQueue
	for i = #(q or {}), 1, -1 do
		local n = q[i]
		if (n.kind == "reply" or n.kind == "error") and not ns.UI.IsShowing(n.chat) then return n end
	end
end

-- The previous session, from the companion's recap (NQADB.companion
-- .lastSession, our own fixed-order JSON): minutes, XP and quests. Nothing
-- after a /reload (same session) or for another character.
function H.LastSession()
	local c = ns.db and ns.db.companion
	local json = type(c) == "table" and c.lastSession
	if type(json) ~= "string" then return nil end
	local sid = json:match('"sid":"(%x+)"')
	local ok, ch = pcall(ns.Companion and ns.Companion.CharDB or error)
	if ok and type(ch) == "table" and sid and ch.sid == sid then return nil end
	local who = json:match('"char":{"name":"([^"]*)"')
	local me = ns.Readable(Try(UnitName, "player"))
	if who and me and who ~= me then return nil end
	local t0 = tonumber(json:match('"start":{"t":(%d+)'))
	local t1 = tonumber(json:match('"end":{"t":(%d+)'))
	local xp = tonumber(json:match('"xpGained":(%-?%d+)'))
	local quests = tonumber(json:match('"questsTurnedIn":(%d+)'))
	if not (t0 and t1 and t1 >= t0) then return nil end
	return { minutes = math.floor((t1 - t0) / 60 + 0.5), xp = xp or 0, quests = quests or 0 }
end

-- "31 min · +1,952 XP · 1 quest": short enough for the header's second line.
local Thousands = ns.Thousands
H.Thousands = Thousands

function H.LastSessionLine()
	local l = H.LastSession()
	if not l then return nil end
	local parts = { ns.FmtDur(l.minutes * 60), "+" .. Thousands(l.xp) .. " XP" }
	if l.quests > 0 then parts[#parts + 1] = ns.Plural(l.quests, "1 quest", "{n} quests") end
	-- A number and its unit never part (STYLE §13): no-break spaces (U+00A0), so a wrap
	-- falls only at " · ". Inline, not a local (the chunk was near Lua's 200 then; AD-04 freed 88).
	for i, p in ipairs(parts) do parts[i] = p:gsub(" ", "\194\160") end
	return table.concat(parts, " · ")
end

-- [UX-3, C-02, C-23] The spend line (PRD §9.5): one line, only when spend needs you
-- (usage.needs), until it changes or you say Okay; nothing about spend while
-- all is well. Returns its words and colour, or nil. Not while the backend is
-- held by the same state (rt): the status line says it, in red, with what to
-- do under it (C-02). Not for slowed: that passes on its own (C-03). The
-- public build has no limits of its own: near or at a limit only with one the
-- player set (usage.capMicros) or a provider's free tier.
function H.SpendLine()
	local u = ns.Usage()
	local needs = u and ns.Str(u.needs, 20)
	if not needs or needs == "slowed" then return nil end
	if ns.db.spendOkay == tostring(u.day or "") .. ":" .. needs then return nil end
	local T = ns.Transport
	local w = T.BridgeAlive() and T.RTWords() or nil
	if w and w.spend and w.head then return nil end
	local cap = tonumber(u.capMicros) -- nil: no limit set; $0 is one
	local free = (tonumber(u.freeLimit) or 0) > 0
	if (needs == "near_cap" or needs == "cap") and not cap and not free then return nil end
	-- [BR-09, UX-W06] A limit held because today's spend couldn't be read is never "reached" (the red as a value: no constant to move).
	if needs == "cap" and u.held == "load_error" then return ns.P("Today's spend couldn't be read, so NeverQuestAlone rests. Set your limit again in the NeverQuestAlone app."), { 1, 0.13, 0.13 }, "Spend unknown" end
	-- The third value: a few words for the one-line HUD (the whole line is its tooltip).
	-- [UX-W20] The bubble's and the desktop's words (errors.mjs), whole sentences with named places (§12).
	local t = { used = ns.Int(u.freeUsed), limit = free and ns.Int(u.freeLimit) or (cap and ns.Dollars(cap)), spent = ns.Dollars(u.spentMicros), company = ns.ProviderOwnName() }
	if needs == "near_cap" then
		if free then return ns.Fill("You've used {used} of today's {limit} free requests.", t), L.GOLD, ns.Fill("{used} of {limit} free used", t) end
		return ns.Fill("You've used {spent} of your {limit} daily spend limit.", t), L.GOLD, "Near your daily limit"
	elseif needs == "cap" then
		if free then
			t.time = T.FreeResetAt()
			return t.time and ns.Fill("You've used today's {limit} free requests. It resets at {time}.", t)
				or ns.Fill("You've used today's {limit} free requests. It resets tomorrow.", t), L.RED, "Free requests used up"
		end
		return ns.Fill("You've reached your daily spend limit ({limit}). Raise it in the NeverQuestAlone app, or it resets at midnight.", t), L.RED, "Daily limit reached"
	elseif needs == "out_of_credit" then
		return t.company and ns.Fill("Your {company} account is out of credit. Add credit at {company}, or pick another AI in the NeverQuestAlone app.", t)
			or "Your account is out of credit. Add credit, or pick another AI in the NeverQuestAlone app.", L.RED, "Out of credit"
	elseif needs == "key_invalid" then
		return t.company and ns.Fill("Your {company} key was rejected. Replace it in the NeverQuestAlone app.", t)
			or "Your key was rejected. Replace it in the NeverQuestAlone app.", L.RED, "Key rejected"
	end
	return nil
end

-- [G1, DR-09] After the first reply the setup block is gone for good, so the
-- app losing sight of the game shows as a warn line instead (onboarding spec
-- §3.10, gap 12): a message stuck on the strip (T.StuckWords: 15 s on screen
-- unread, or a Reload that didn't deliver it), else the bridge's capture state
-- (cap capture) once it has held 8 s on screen (T.CaptureCause; a state the
-- addon doesn't know names nothing). It stays until the state ends or you say
-- Okay (then until it changes). { key, head, sub, text, action }, or nil. A stuck message's row, when the HUD works on it, says it there.
-- h.capOkay: the key of the warn line you said Okay to. The warn line's
-- helpers here are H's fields, their tables in blocks: this file's main chunk
-- was near Lua 5.1's 200 locals when they came (AD-04 freed 88). [G1]
do
	function H.CaptureWarn()
		if not ns.db.firstReply then return nil end
		local T = ns.Transport
		if not T.BridgeAlive() then return nil end -- the connection line says it
		local w, key = T.StuckWords(), nil
		if w then
			key = w.action .. ":" .. w.short
			if h.capOkay == key then return nil end
			return { key = key, head = w.short, sub = w.next, text = w.text, action = w.action }
		end
		key = T.CaptureCause()
		local c = key and T.CauseWords(key)
		if not c then h.capOkay = nil return nil end
		if h.capOkay == key then return nil end
		return { key = key, head = c.head, sub = c.next, text = c.text }
	end

	-- [DR-07] A stuck message under "Sending…" (or "Stopping…"): the row's button
	-- is its one action (Reload, or Discard after a Reload that didn't deliver it), the
	-- line under it says what's wrong in one line (so nothing moves), and the whole of
	-- it is a click on the line away. It outranks the AI's state (a key to add, say):
	-- nothing reaches the app until the Reload. Before it's stuck, and with no
	-- connection line, a published cause that has held 8 s is named there too. v: the
	-- view being made; p: the send's progress; conn: a connection line has the row.
	function H.StuckRow(v, p, conn)
		local T = ns.Transport
		local w = T.StuckWords()
		if w then
			v.stuck, v.short, v.detail = w.action, w.short, w.text
			v.sub = w.sub or ns.Fill("{duration} · not read yet", { duration = ns.FmtDur(p.elapsed or 0) })
			v.subOneLine = true
			return
		end
		if conn then return end
		local cause = T.CaptureCause()
		local c = cause and T.CauseWords(cause)
		if c then v.sub, v.short, v.detail = c.head, c.head, c.text end
	end
	-- The row's button, clicked while it's the stuck send's: its action. True when it was.
	function H.StuckAct()
		local v = h.view
		if not (v and v.stuck) then return false end
		ns.UI.StuckAct(v.stuck)
		H.Render()
		return true
	end
	-- The HUD shows the stuck send's button itself (the banner then stays away).
	function H.StuckShown()
		local v = h.view
		local shown = (h.frame and h.frame:IsShown()) or (h.bar and h.bar:IsShown())
		return (shown and v and v.stuck and not v.routeOnly) and true or false
	end
	H.STUCK_TIPS = {
		reload = { title = "Reload", text = "Reloads WoW's interface, which sends your message." },
		discard = { title = "Discard", text = "Drops the message that didn't go through. Nothing is sent." },
	}
end

-- Okay on the spend line, or on a spend state the status line names (C-23):
-- put away until what it says changes (ns.SpendKey).
function H.PutSpendAway()
	local key = ns.SpendKey()
	if key then ns.db.spendOkay = key end
end
function H.SpendOkay()
	H.PutSpendAway()
	H.Render()
end

-- An error that says what the state already says (C-02): out of credit, a
-- rejected key, the cap, a local server that's down. Returns whether the
-- backend's state (rt) and the usage (usage.needs) are that state now.
do -- a block, for Lua 5.1's 200 locals (H.CaptureWarn's note) [C-02]
	local SAME_STATE = { out_of_credit = "out_of_credit", auth_invalid = "key_invalid", cap_spend = "cap", local_unreachable = "local_down" }
	function H.NewsIsState(e)
		local st = e and e.err and e.action and SAME_STATE[e.kind]
		if not st then return false, false end
		local rt, u = ns.RT(), ns.Usage()
		return (rt ~= nil and rt.state == st and ns.Transport.BridgeAlive()), (u ~= nil and ns.Str(u.needs, 20) == st)
	end
end

-- The connection, when it needs saying: a status line, a second line, the
-- state, and the light's own words for the tooltip. [UX-1, C-02, C-23]
-- With rt (BYOK) also the status line's colour, whether it's a spend state,
-- whether that one's Okay is still to come, and a few words for the bar: the
-- backend's state in the provider's words, in red when the player has to act,
-- with what to do on the line under it. Said Okay to, a spend state is named
-- calmly, in grey and alone, until it changes.
local function Connection()
	local T = ns.Transport
	local light, tip = T.Light()
	local words = T.BridgeAlive() and T.RTWords() or nil
	if words then
		if not words.head then return nil end
		local spend = words.spend == true
		if spend and ns.db.spendOkay ~= nil and ns.db.spendOkay == ns.SpendKey() then
			return words.head, "", "idle", tip, L.GREY, true, false, words.short
		end
		return words.head, words.sub or "", words.ring, tip, words.red and L.RED or nil, spend, spend, words.short
	end
	-- [C-05] The desktop app and the provider, by their names.
	if light == "red" then
		local age = T.BridgeAge() or (GetTime() - (R.loginAt or GetTime()))
		-- [UX-W10, UX-W19] the app by its name, the time spelled out
		return "Can't reach the NeverQuestAlone app", ns.Fill("No word for {duration}. Is it running?", { duration = ns.DurWords(age) }), "error", tip
	elseif light == "grey" then
		return "Not ready", "Click to see why in the window.", "idle", tip -- [C-05, UX-W23] where the click goes
	elseif light == "yellow" then
		-- [C-05, UX-W23] the line names what can't be reached; the click, where it goes
		return ns.Fill("Can't reach {AI}", { AI = ns.ProviderName() }), "Click to see why in the window.", "idle", tip
	elseif light == "wait" then
		-- The line "Ready" will have, so nothing moves when the hello lands (C-106).
		local last = (GetTime() - (R.loginAt or GetTime())) < L.LAST_SESSION_FOR and H.LastSessionLine() or nil
		return "Connecting…", last and ns.Fill("Last time: {summary}", { summary = last }) or "", "idle", tip
	end
end

-- The news stays until that chat is read in the window, or you say Okay.
local function CurrentNews()
	if not news then return nil end
	local c = ns.Chats.Find(news.chat)
	if not c then
		news = nil
		return nil
	end
	if ns.UI.IsShowing(c.id) then
		news = nil
		return nil
	end
	local e = Newest(c.id)
	if not e then return nil end
	return e, c
end

-- The chat quick asks and Ask go to (made the first time you ask).
local function QuickChat()
	return (ns.QuickChat and ns.QuickChat()) or ns.Chats.Active()
end
-- The same, without making it: drawing never adds a chat.
local function FoundQuick()
	for _, c in ipairs(ns.db.chats) do
		if c.quick then return c end
	end
end

-- "(approx)" and "Approx Classic coords." in a stop's words (converted
-- coordinates) say it once, as "approx." after the distance.
local function Unapprox(s)
	if type(s) ~= "string" or s == "" then return s or "", false end
	local found = s:lower():find("approx", 1, true) ~= nil
	s = s:gsub("%s*%(%s*[Aa]pprox%.?%s*%)", "")
	s = s:gsub("[Aa]pprox%.?%s+[Cc]lassic%s+coord[s]?%.?%s*", "")
	s = s:gsub("%s*[Aa]pprox%.?%s*$", "")
	s = s:gsub("^%s+", ""):gsub("%s+$", "")
	return s, found
end
H.Unapprox = Unapprox

-- An objective as the list shows it (Store.lua; the map's pins say it the same way).
local SplitObjective = ns.SplitObjective
H.SplitObjective = SplitObjective

-- The stop's quests as a list: a quest's name, then one row per objective (a
-- bullet, its words, its count; a check and grey once done). A ready quest is
-- one green row ("turn in"); a turned-in or missing one, one grey row. An
-- objective with no count that the stop's label or note already says isn't
-- said again, nor a quest with nothing left to say. Rows: { kind = "quest" |
-- "row", text, count, done, color, id (a quest's name, a ready quest's row and
-- one to pick up here: where its chain leads goes under it) }.
local function QuestRows(r, label, note)
	local said = (label .. "\n" .. note):lower()
	local rows = {}
	for _, q in ipairs(type(r.quests) == "table" and r.quests or {}) do
		local title = tostring(q.title or "")
		if q.state == "ready" then
			rows[#rows + 1] = { kind = "row", text = title, count = "turn in", done = true, color = L.GREEN, id = q.id, ready = true }
		elseif q.state == "done" or q.state == "missing" then
			-- [UC-02] One to pick up here (Map.lua's q.pickup) shows where it leads too.
			rows[#rows + 1] = { kind = "row", text = title, count = tostring(q.what or ""), done = q.state == "done", color = L.GREY, id = q.pickup and q.id or nil }
		else
			local items = {}
			for _, o in ipairs(q.objectives or {}) do
				local words, count = SplitObjective(o.text)
				if words ~= "" and (count or not said:find(words:lower(), 1, true)) then
					items[#items + 1] = { kind = "row", text = words, count = count, done = o.finished and true or false }
				end
			end
			if #items > 0 then
				rows[#rows + 1] = { kind = "quest", text = title, id = q.id }
				for _, it in ipairs(items) do rows[#rows + 1] = it end
			elseif not said:find(title:lower(), 1, true) then
				rows[#rows + 1] = { kind = "quest", text = title, id = q.id }
			end
		end
	end
	return rows
end
H.QuestRows = QuestRows

-- A note that only restates the list under it ("8 Water Seekers, 8
-- Thornweavers, 3 Hunters.") isn't said: every word of it longer than three
-- letters, plurals folded, is in the list's words (numbers don't count).
local function Stem(w)
	w = w:lower()
	return (w:gsub("ies$", "y"):gsub("s$", ""))
end
local function RestatesList(note, rows)
	local words = {}
	for _, it in ipairs(rows) do
		for w in tostring(it.text or ""):gmatch("%a+") do words[Stem(w)] = true end
	end
	local any = false
	for w in note:gmatch("%a+") do
		if #w > 3 then
			if not words[Stem(w)] then return false end
			any = true
		end
	end
	return any
end
H.RestatesList = RestatesList

-- Under "Sending…" (and "Stopping…" before the run was picked up): the
-- connection's trouble, if any; else one line from the start, so nothing
-- moves when it speaks (maintainer: no timer-driven layout): how long it has
-- waited; once it's stuck, H.StuckRow says that it hasn't been read or why,
-- and gives the row's button its action (DR-07). A /reload does send it, blind
-- capture or not: the app reads every outbox record in the saved file (the
-- design's §1 correction). Returns the line and whether it's cut to one line.
local function SendingSub(connLine, connSub, p)
	if connLine then return connSub or "", false end
	return ns.FmtDur(p.elapsed or 0), true -- [DR-07] H.StuckRow says the rest
end

-- The Quality of Life step's showing, decided once a session at its first
-- chance, so it never lands or folds by itself (C-107): a known problem then
-- (the light grey or yellow, or the app silent after this session's hello
-- was answered) holds it until the next session; otherwise it's there from
-- that first frame until answered.
-- "Connecting…" before the hello is answered (an old inbox) is the login's
-- normal start. Its parts (QoL.lua's step) share one local, Qol: this chunk
-- was near Lua's limit of 200 when they came (AD-04 freed 88).
local Qol = {}

function Qol.FirstShow()
	if R.qolShown then return true end
	local light = ns.Transport.Light()
	if light == "grey" or light == "yellow" or (light == "red" and R.helloAnswered) then
		R.qolHold = true
		if ns.QoL.Held then ns.QoL.Held() end
		return false
	end
	R.qolShown = true
	return true
end

-- Everything the HUD shows, worked out from the state (no drawing).
function H.View()
	local now = GetTime()
	if ding and now > ding.untilT then ding = nil end
	if moment and now > moment.untilT then moment = nil end
	if quip and now > quip.untilT then quip = nil end
	if flash and now > flash.untilT then flash = nil end
	local nav = ns.MapShared and ns.MapShared.navView or nil
	if replanning and (now - replanning.at > L.REPLAN_FOR or (nav and (nav.layer ~= replanning.layer or nav.rev ~= replanning.rev))) then
		replanning = nil
	end
	local v = {}
	local e, nc = CurrentNews()
	-- What Bones says: the reply's TL;DR, else the reply (or the error).
	local says = e and ((type(e.summary) == "string" and e.summary ~= "") and e.summary or (e.text or "")) or nil
	local busy = BusyChat()
	local held = not e and not busy and HeldNews() or nil
	local capWarn = H.CaptureWarn() -- [G1]
	local connLine, connSub, connRing, connTip, connColor, connIsSpend, connOkay, connShort = Connection()
	-- [UX-3, C-02, C-27] The spend line; an error that repeats the state
	-- is said once (as the news, with its Okay); a spend state while other news
	-- waits is the spend row after the block, the news keeping the header.
	v.spend, v.spendColor, v.spendShort = H.SpendLine()
	local sameState, sameNeeds = H.NewsIsState(e)
	if sameNeeds then v.spend = nil end
	local stateUnderNews = connIsSpend == true and e ~= nil and not sameState
	if stateUnderNews then
		if connOkay then
			v.spend, v.spendColor = connLine .. "." .. (connSub ~= "" and (" " .. connSub) or ""), L.RED
		else
			v.spend, v.spendColor = connLine .. ".", L.GREY -- said Okay to: named calmly
		end
	end
	-- [G1] The setup block, before the first reply, until its Okay this
	-- session (in main's Welcome's place).
	-- [C-137] With no app yet and Copy and Paste on, Ask already works: main's Welcome says how,
	-- never the app-only setup rows (they can't be finished without the app).
	local first = not ns.db.firstReply and not R.setupOkay
	local welcome = first and H.PasteWelcome()
	local setup = (first and not welcome and ns.UI.SetupRows) and ns.UI.SetupRows() or nil
	v.min = S().hudMin == true
	-- Combat and the open window fold the panel to the bar, unless you asked
	-- for it (Show More): that holds while you look, until Show Less or its -,
	-- or the fight is over and the window closed; then they fold it as before.
	local squeeze = ns.InCombat() or ns.UI.IsOpen()
	if not squeeze then showFull = nil end
	v.compact = v.min or (squeeze and not showFull)
	v.working = Working()
	v.asking = h.replyBox ~= nil and h.replyBox:IsShown()
	-- The one-line HUD, unless a box you're typing in keeps the panel; minimized
	-- further, the compass: the arrow and the distance, nothing else (maintainer).
	v.bar = v.compact and not v.asking
	v.compass = v.bar and v.min and S().hudCompass == true
	-- [G1] While the setup block shows, its rows name a missing or rejected
	-- key and credit: the header counts the steps ("Setting up · 2 of 3 done");
	-- only a connection problem takes it (onboarding spec §3.10).
	local rtNow = setup and not v.compact and not e and not busy and ns.RT() or nil
	local setupSays = rtNow ~= nil and (rtNow.state == "no_key" or rtNow.state == "key_invalid" or rtNow.state == "out_of_credit")

	-- The header, most pressing first. v.live: something is happening (white),
	-- else idle (grey).
	v.live = true
	if flash then
		v.ring, v.status, v.sub, v.tip = flash.kind == "warn" and "news" or "error", flash.text, flash.sub or "", flash.tip
		-- What the header shows, so the bar's Okay acts on that line (E-1); its
		-- words a click away (the status lines' button).
		v.header, v.detail = "flash", flash.tip
	elseif pending then
		-- One line, so nothing under it moves: the button itself says Undo.
		v.ring, v.status, v.sub = "thinking", "Asking: " .. ns.Escape(pending.words), ""
		v.header = "pending"
	elseif moment then
		v.ring, v.status, v.sub = "news", moment.line, moment.sub or ""
		v.header = "moment"
	elseif ding then
		v.header = "ding"
		v.ring, v.status, v.sub = "news", "Ding! Level " .. ns.Int(ding.level), R.dingQueued == ding.level and ns.P("NeverQuestAlone is on it.") or "" -- [UX-5]
	elseif connLine and (connRing == "error" or not busy) and not sameState and not stateUnderNews and not setupSays then -- [C-02, G1]
		v.ring, v.status, v.sub, v.tip = connRing, connLine, connSub, connTip
		-- The light's words, a click away; over unread news the bar's row is the
		-- connection's, so its Okay isn't the news's (E-1, C-29).
		v.detail, v.connHeader = connTip, e ~= nil
		-- [C-02, C-23] A BYOK state in its colour, its Okay (a spend state
		-- not yet said Okay to), its few words for the bar.
		v.statusColor, v.stateOk, v.short = connColor, connOkay == true, connShort
		if connColor == L.GREY then v.live = false end
	elseif e then
		-- "Bones says", and the block under it what he says; work still going is
		-- the second line. The one-line HUD shows his words themselves, cut.
		v.ring = e.err and "error" or "news"
		v.status = e.err and "Something went wrong" or (ns.Chats.AgentName(e.agent or nc.agent) .. " says")
		v.says = not e.err -- a label over his words: gold, as a speaker's name is
		v.short = e.err and "Something went wrong" or says:gsub("%s*\n+%s*", " ")
		v.sub = busy and ("Still working on " .. (busy.id == nc.id and "your next message." or (ns.Escape(busy.name) .. "."))) or ""
		v.tip = says .. (busy and ("\n\n" .. ns.UI.WorkingText(busy)) or "")
		-- [C-10] An error by its kind (cap ekind), as the window's bubbles say
		-- it: "Didn't go through" in gold, "Needs you" in red, "Declined" in grey.
		local label, _, class = ns.UI.ErrorLook(e)
		if e.err and class then
			v.status, v.short = label, label
			if e.kind == "auto_paused" then v.short = says:gsub("%s*\n+%s*", " ") end -- its words on the bar, as a reply's are
			v.statusColor = (class == "retry" or class == "held") and L.GOLD or (class == "declined" or class == "notsent" or class == "note") and L.GREY or L.RED
			v.ring = v.statusColor == L.RED and "error" or "news"
		end
	elseif busy then
		local p = ns.Chats.Progress(busy)
		local typical = ns.Chats.TypicalRunTime()
		v.ring = "thinking"
		if p.paste then
			-- Copy and Paste (Paste.lua): nothing works on it until the player pastes
			-- the AI's reply; the lines are the way back to the window that takes it.
			v.ring, v.status, v.sub = "news", "Waiting for your AI", "Click to paste its reply."
			v.detail, v.pasteChat = "paste", busy.id
		elseif p.stopping then
			-- The header keeps its lines, so Stop stays under the pointer (C-72):
			-- before the run was picked up, its second line stays what it was.
			local sub, one = ns.P("NeverQuestAlone was asked to stop."), false -- [UX-5]
			if not p.acked then
				if ns.Transport.StripOut() then
					sub, one = SendingSub(connLine, connSub, p)
					-- The connection's line, borrowed, keeps its click (UXC-UI-21).
					if connLine then v.detail = connTip end
				else
					sub = "Reload when it suits you."
				end
			end
			v.status, v.sub, v.subOneLine = "Stopping…", sub, one
			if not p.acked and ns.Transport.StripOut() then H.StuckRow(v, p, connLine ~= nil) end -- [DR-07] the stop can be stuck too
		elseif not p.acked then
			if ns.Transport.StripOut() then
				v.status = "Sending…"
				v.sub, v.subOneLine = SendingSub(connLine, connSub, p)
				if connLine then v.detail = connTip end -- "Click to see how." stays a click (UXC-UI-21)
				-- [G1, DR-07] Why it doesn't go, in the line's one line, and the row's button its one action.
				H.StuckRow(v, p, connLine ~= nil)
			else
				v.status, v.sub = "Waiting for a reload", "Reload when it suits you."
			end
		else
			-- The voice alone on the first line, so it never wraps as the clock runs;
			-- the time and what's usual under it (the one-line HUD keeps both).
			v.status = ns.UI.Voice(p.title, p.elapsed)
			v.short = v.status .. " " .. ns.FmtDur(p.elapsed)
			v.sub = ns.FmtDur(p.elapsed) .. (typical and (" · usually " .. ns.FmtDur(typical)) or "")
			v.subOneLine = true -- cut, never wrapped: the clock mustn't move what's below
			-- [C-03] Slowed by the provider while it works: that, and the countdown.
			local rt = ns.RT()
			local slowed = rt and rt.state == "slowed" and ns.Transport.BridgeAlive() and ns.Transport.RTWords()
			if slowed and slowed.head then v.status, v.sub, v.short = slowed.head, slowed.sub, slowed.head end
		end
		v.tip = ns.UI.WorkingText(busy) .. (v.working > 1 and ("\n" .. v.working .. " chats working.") or "")
	elseif h.warning then
		-- [C-13] A warning (cap ekind): a state line until you say Okay; the
		-- whole of it a click on the line away.
		local warning = h.warning
		v.ring, v.status, v.sub, v.tip, v.detail = "news", warning.short, "Click to see it all in the window.", warning.text, warning.text -- [UX-W23]
		v.short, v.warn, v.statusColor = warning.short, true, L.GOLD
	elseif capWarn then
		-- [G1] The app can't see the game (after the first reply): a warn
		-- line with its Okay, until it can.
		v.ring, v.status, v.sub, v.tip = "news", capWarn.head, capWarn.sub, capWarn.text
		v.short, v.warn, v.statusColor, v.capWarn = capWarn.head, true, L.GOLD, capWarn.key -- the bar: its head, as a warning's
	elseif held then
		-- Not "Ready": he answered, and Quiet in Combat holds it (C-104). White,
		-- with no dot, so a fight stays quiet.
		if held.kind == "error" then
			v.ring, v.status, v.sub = "idle", "Error after the fight", "Something went wrong; it shows when the fight ends."
		else
			v.ring, v.status = "idle", "Reply after the fight"
			v.sub = string.format("%s answered; it shows when the fight ends.", ns.Chats.AgentName(held.agent))
		end
	elseif quip then
		v.ring, v.status, v.sub = "idle", quip.text, ""
		v.header = "quip"
	else
		v.ring, v.status, v.live = "idle", "Ready", false
		local last = (now - (R.loginAt or now)) < L.LAST_SESSION_FOR and H.LastSessionLine() or nil
		v.sub = last and ns.Fill("Last time: {summary}", { summary = last }) or ""
		if setup then v.status = string.format("Setting up · %d of 3 done", setup.done) end -- [G1]
		-- [UX-1] Slow mode is a state, so it's named here too; what to do is a click away.
		local slow = ns.Transport.SlowMode()
		if slow then v.sub, v.detail = slow .. ".", select(2, ns.Transport.Light()) end
		-- [C-19] The bar has room for the spend line only when there's
		-- nothing else, and not in a fight, like every line that can wait.
		if v.spend and not ns.InCombat() then
			v.short, v.shortSpend = v.spendShort or v.spend, true
			v.tip = v.spend
		end
	end
	v.tip = v.tip or connTip or ""
	if v.detail == "" then v.detail = nil end
	v.error = v.ring == "error"

	-- The block: news first, then work, then the setup block or the Quality of Life step.
	if e then
		v.mode = "news"
		v.chat, v.chatName = nc.id, nc.name
		v.body = says
	elseif busy then
		-- What you asked (or the game sent), led by a gold "You asked:".
		v.mode = "working"
		v.chat = busy.id
		v.body = AskedBody(busy)
		v.stopping = ns.Chats.Progress(busy).stopping
		v.pasting = ns.Chats.Progress(busy).paste
	elseif v.warn then
		v.mode = "warn" -- [C-13] its Okay in the block
	elseif held then
		-- What you asked stays, with no Stop: it's done, and shows after the fight.
		v.mode, v.held = "working", true
		v.chat = held.chat
		v.body = AskedBody(ns.Chats.Find(held.chat))
	elseif setup then
		v.mode, v.setup = "setup", setup -- [G1] in main's Welcome's place (its words head /bones help)
	elseif welcome then
		v.mode = "welcome" -- [C-137] its Okay is the setup block's; the header stays Ready
	elseif ns.QoL and ns.QoL.Offer() and not v.asking and not (ns.MapShared and ns.MapShared.corpseView)
		and not Try(UnitIsDeadOrGhost, "player") and Qol.FirstShow() then
		-- The Quality of Life step, until answered (Qol.FirstShow). A box you're
		-- typing in, or death, puts it aside.
		v.mode = "qol"
	else
		v.mode = "idle"
	end
	v.target = v.asking and h.replyBox.chatId or nil
	-- A ghost: the arrow points to your corpse until you're alive (Map.lua), and
	-- the route steps aside till then (maintainer: "its not relevant at all").
	v.corpse = ns.MapShared and ns.MapShared.corpseView or nil
	v.route = not v.corpse and nav or nil
	v.replanning = replanning ~= nil
	-- What the reply's first button says (C-100): Follow Route or Follow Pin
	-- while it drew one you don't follow, else Okay.
	if e then v.okLabel, v.okShort = OkayLabel(news and news.drew), OkayLabel(news and news.drew, true) end
	-- No route and nothing else going on: the route's place says so, with the
	-- one click that gets one (maintainer: a button "in the zero content state").
	v.empty = v.mode == "idle" and not v.route and not v.corpse
	return v
end

---------------------------------------------------------------------------
-- Placement
---------------------------------------------------------------------------

-- Its own place when you moved it, else docked beside the quest tracker. The
-- one-line HUD shares the panel's top-left corner, so neither jumps.
-- A place you chose is the HUD's top-right corner, against the screen's
-- bottom-left in whole units: the panel and the one-line HUD each hang their
-- top-right corner there, so each is kept on screen by itself. The one-line
-- HUD hung on the hidden panel moved when the game pushed the panel back on
-- screen, as you let go near the left or the bottom (C-99). An older save of
-- the panel's top-left gets its right edge from the panel's width.
local function SavedCorner(s)
	if s.hudRelPoint ~= "BOTTOMLEFT" then return nil end
	if s.hudPoint == "TOPRIGHT" then return s.hudX or 0, s.hudY or 0 end
	if s.hudPoint == "TOPLEFT" then return (s.hudX or 0) + L.W, s.hudY or 0 end
end
-- The one line's place: that corner, else the docked panel's right edge.
local function BarToPlace()
	local x, y = SavedCorner(S())
	h.bar:ClearAllPoints()
	if x then
		h.bar:SetPoint("TOPRIGHT", UIParent, "BOTTOMLEFT", x, y)
	else
		h.bar:SetPoint("TOPRIGHT", h.frame, "TOPRIGHT", 0, 0)
	end
end
local function PlaceFrame()
	local f, s = h.frame, S()
	if not f then return end
	local x, y = SavedCorner(s)
	if x then
		f:ClearAllPoints()
		f:SetPoint("TOPRIGHT", UIParent, "BOTTOMLEFT", x, y)
	elseif s.hudPoint then
		f:ClearAllPoints()
		f:SetPoint(s.hudPoint, UIParent, s.hudRelPoint or s.hudPoint, s.hudX or 0, s.hudY or 0)
	else
		ns.UI.Dock(f, 0)
	end
	if h.bar then
		BarToPlace()
		h.barAnchor = "panel"
	end
end
H.Place = PlaceFrame

-- The one line keeps the panel's right edge; a closed HUD's route bar sits
-- under the small bar while that stands in (the HUD off, not closed), where
-- the navigator's box did, unless you've moved the HUD (C-92).
local function AnchorBar(underMini)
	local want = underMini and "mini" or "panel"
	if h.barAnchor == want then return end
	h.barAnchor = want
	h.bar:ClearAllPoints()
	if underMini then
		h.bar:SetPoint("TOPRIGHT", ns.UI.MiniFrame(), "BOTTOMRIGHT", 0, -6)
	else
		BarToPlace()
	end
end

function H.ResetPosition()
	local s = S()
	s.hudPoint, s.hudRelPoint, s.hudX, s.hudY = nil, nil, nil, nil
	PlaceFrame()
end

-- A plain drag moves it (the title band, the portrait, the one-line HUD). Its
-- top-left corner is kept, so the panel and the one-line HUD share it.
local function BeginMove(frame)
	if frame.moving then return end
	frame.moving = true
	HideTip()
	frame:StartMoving()
end
local function EndMove(frame)
	if not frame.moving then return end
	frame.moving = nil
	frame:StopMovingOrSizing()
	Call(frame, "SetUserPlaced", false)
	local s = S()
	-- Its top-right corner, which every form shares (SavedCorner).
	local right, top = frame:GetRight(), frame:GetTop()
	if type(right) == "number" and type(top) == "number" then
		s.hudPoint, s.hudRelPoint, s.hudX, s.hudY = "TOPRIGHT", "BOTTOMLEFT", math.floor(right + 0.5), math.floor(top + 0.5)
	else
		local point, _, relPoint, x, y = frame:GetPoint()
		s.hudPoint, s.hudRelPoint, s.hudX, s.hudY = point, relPoint, x, y
	end
	h.movedAt = GetTime()
	PlaceFrame()
end
local function JustMoved() return h.movedAt ~= nil and GetTime() - h.movedAt < 0.3 end

-- The HUD on or off; off, the small bar stands in (UI.RenderMini).
function H.SetShown(on)
	S().hud = on and true or false
	if not on then S().miniHidden = nil end -- turned off (menu, Settings): the small bar stands in
	H.Render()
	ns.UI.RenderMini()
	if not on then ns.Notify.Local(ns.P(string.format("The HUD is off: the small bar stands in. %s, in Settings, turns it back on.", ns.Settings.LABELS.hud))) end -- [UX-5]
end

-- The X: it closes, and nothing stands in (the small bar stays hidden too, as
-- its own X leaves it) until you bring Bones back; replies still come as toasts.
-- A route you follow (or your corpse) keeps its bar, whose menu brings the HUD
-- back (H.Render).
function H.Close()
	local s = S()
	s.hud = false
	s.miniHidden = true
	H.Render()
	ns.UI.RenderMini()
	ns.Notify.Local(ns.P(string.format("The HUD is closed; replies still show as they come, and a route you follow keeps its bar. %s, in Settings, or Show More in that bar's right-click menu brings it back.", ns.Settings.LABELS.hud))) -- [UX-5]
end

-- The whole panel, the bar or the compass (the arrow and the distance);
-- remembered (settings.hudMin, hudCompass). Asked for, the panel shows now,
-- even in combat or with the window open (maintainer: Show More is "always
-- something the user can select and view").
function H.SetForm(form)
	local s = S()
	s.hudMin = form ~= "full"
	s.hudCompass = form == "compass"
	showFull = form == "full" or nil
	H.Render()
end
function H.SetMinimized(on) H.SetForm(on and "bar" or "full") end

-- The HUD back on, in the form given (a closed HUD's route bar: Show More).
function H.ShowForm(form)
	local s = S()
	s.hud, s.miniHidden = true, nil
	H.SetForm(form)
	ns.UI.RenderMini()
end

---------------------------------------------------------------------------
-- Actions
---------------------------------------------------------------------------

-- Open the window, on the news's chat when there is news.
function H.OpenWindow()
	local _, c = CurrentNews()
	if c then ns.Chats.Switch(c.id) end
	ns.UI.Toggle(true)
end

-- Your chats: the window with the list of them shown, on the news's chat when
-- there is news (the portrait's click).
function H.OpenChats()
	local _, c = CurrentNews()
	if c then ns.Chats.Switch(c.id) end
	ns.UI.Toggle(true)
	if ns.UI.SetListShown then ns.UI.SetListShown(true) end
end

-- [UX-2] An error said Okay to in the window: the HUD's news of it goes too.
function H.DismissChat(chatId)
	if news and news.chat == chatId then H.Dismiss() end
end

-- Okay: the news is read (its unread count goes too) and put away; it stays
-- in its chat, and nothing is sent. The button follows a route it drew (or a
-- pin it put), and then reads Follow (OkayLabel); the Okay key, whose name
-- says okay, only puts it away (C-102): keepRoute.
function H.Dismiss(keepRoute)
	local c = news and ns.Chats.Find(news.chat)
	if c then c.unread = 0 end
	-- [C-02] News that said what the state says (the same error): its Okay is the state's too.
	local e = news and CurrentNews()
	if e and e.action then
		local sameState, sameNeeds = H.NewsIsState(e)
		if sameState or sameNeeds then H.PutSpendAway() end
	end
	local drew = news and news.drew
	news = nil
	if drew and not keepRoute and type(NQAMap) == "table" and NQAMap.FollowDrawn then Try(NQAMap.FollowDrawn, drew) end
	ns.Refresh("status")
	H.Render()
end
function H.Okay() H.Dismiss(false) end

-- The bar's Okay, for what its row shows, never for something under it (E-1,
-- C-29, C-30): a timed line over the news (a flash, a finished route, a ding,
-- a quip) ends now and the row falls back to the news, whose Okay the same
-- button then is; a pending ask goes now; the news, unless a connection state
-- has the row (then Show More, and the news's own Okay).
function H.BarOkay()
	local v = h.view
	if v and L.TIMED[v.header] then
		if v.header == "flash" then flash = nil
		elseif v.header == "moment" then moment = nil
		elseif v.header == "ding" then ding = nil
		else quip = nil end
		H.Render()
	elseif v and v.header == "pending" then
		H.SendNow()
	elseif v and v.stuck and not (news and not v.connHeader) then -- [DR-07]
		H.StuckAct()
	elseif v and v.warn then -- [C-13, C-19, C-23] a warning, a spend state or the spend line (the public build's)
		H.WarnOkay()
	elseif v and (v.shortSpend or v.stateOk) then
		H.SpendOkay()
	elseif v and v.mode == "news" and not v.connHeader then
		H.Okay()
	end
end

-- The status lines' words, in the window (their button: the lines point to a
-- click, never to a tooltip).
function H.ShowDetails()
	local v = h.view
	if v and v.pasteChat and ns.Paste then
		ns.Paste.Open(v.pasteChat)
	elseif v and v.detail then
		ns.UI.ShowDetails(v.detail)
	end
end
-- The key (Bindings.xml, NQA_OKAY): the HUD's news, else the top banner's
-- reply when the HUD shows none (closed, off, the compass; C-103).
NeverQuestAlone.Okay = function()
	if news then H.Dismiss(true) elseif ns.UI.OkayToast then ns.UI.OkayToast() end
end

-- Something to say at once: the status line for a while, red for a send
-- that didn't go, gold for a warning; tip: the whole of it, on the portrait.
function H.Flash(text, sub, tip, kind)
	flash = { text = text, sub = sub, tip = tip, kind = kind, untilT = GetTime() + L.FLASH_SECONDS * (kind == "warn" and 2 or 1) }
	H.Render()
end

-- [C-13] A warning with cap ekind (Transport.Warn): the status line says it
-- in gold until you say Okay, and a click on it opens the whole of it
-- (h.warning: { short, text }).
function H.Warn(short, text)
	h.warning = { short = short, text = text }
	H.Render()
end
function H.WarnOkay()
	-- [G1] The capture warn line, when it's the one showing: until its state changes.
	local v = h.view
	if not h.warning and v and v.capWarn then h.capOkay = v.capWarn else h.warning = nil end
	H.Render()
end

-- Send words from here (a chip, the box) to a chat; the HUD follows it.
local function SendTo(chatId, text)
	local key, why, refused = ns.Chats.Send(text, chatId) -- [both:B B-2] (KY-10) refused: "key"
	if key then
		H.Asked(chatId)
	else
		H.Flash("Not sent", why or "Open the window to see why.")
	end
	return key, refused
end

-- A send from here (Re-plan) waits UNDO_SECONDS, unless you click it again
-- (the header says what it asks meanwhile, and the button reads Undo).
local function Delay(owner, words, go)
	if pending and pending.owner == owner then
		pending = nil
		H.Render()
		return
	end
	local mine = { owner = owner, words = words, untilT = GetTime() + L.UNDO_SECONDS }
	pending = mine
	H.Render()
	local function Go()
		if pending ~= mine then return end
		pending = nil
		go()
		H.Render()
	end
	mine.go = Go -- the bar's Okay sends it now (H.SendNow)
	if C_Timer and C_Timer.After then C_Timer.After(L.UNDO_SECONDS, Go) else Go() end
end

-- The pending ask, now: the undo wait ends (the bar's Okay, E-1).
function H.SendNow()
	if pending and pending.go then pending.go() end
end

-- Re-plan: a fresh route from where you are (Commands.lua, ns.RouteAsk), sent
-- after the same 3 s as a chip; the route's heading says "Re-planning…" until
-- the new route comes.
function H.Replan(owner)
	local nav = ns.MapShared and ns.MapShared.navView
	Delay(owner or h.replanIcon, nav and "a new route" or "a route", function()
		local chat = QuickChat()
		if ns.QuickAsk("route") and chat then
			replanning = { layer = nav and nav.layer, rev = nav and nav.rev, chat = chat.id, at = GetTime() }
		end
	end)
end

-- No route: the same ask, from the empty route's button (its label is Undo
-- for those 3 s).
function H.AskRoute() H.Replan(h.routeAskBtn) end

-- The bar's parts (maintainer): a click goes to that part's stop, back or ahead
-- (Map.lua holds it); a part of several stops goes to its first, then on
-- through them. The stop you're on stays.
function H.FocusStop(first, last)
	local r = ns.MapShared and ns.MapShared.navView
	if not r or not first or type(NQAMap) ~= "table" or not NQAMap.Focus then return end
	local target = first
	if last and r.index >= first and r.index < last then target = r.index + 1 end
	if target == r.index then return end
	NQAMap.Focus(target)
end

-- A part's tooltip: its stop (or stops) and what a click does.
local function SegmentTip(self)
	local r = ns.MapShared and ns.MapShared.navView
	if not r or not self.first then return end
	local function Label(i)
		local name = type(NQAMap) == "table" and NQAMap.StopLabel and NQAMap.StopLabel(i)
		return ns.Escape(name or string.format("%d/%d", i, r.total))
	end
	local here = r.index >= self.first and r.index <= self.last
	if self.first == self.last then
		ShowTip(self, { title = Label(self.first), text = here and "The stop you're on." or ns.Fill("Stop {i} of {n}.", { i = self.first, n = r.total }),
			actions = not here and { "Click to go to this stop" } or nil })
	else
		local names = {}
		for i = self.first, self.last do names[#names + 1] = Label(i) end
		ShowTip(self, { title = string.format("Stops %d to %d", self.first, self.last), lines = names, actions = { "Click to go through these stops" } })
	end
end

-- The portrait's and the title band's right-click menu.
-- Only what we need (maintainer): the panel's - and X minimize and close it, and
-- putting it back is in Settings and /bones hud reset. The bar and the compass
-- have no buttons (maintainer: "make that a right click thing only"): Show More and
-- Show Less step between the three; the panel's has Show Less too, as its -
-- does (maintainer). Folded to the bar by combat or the open window, Show More is
-- still there and shows the panel now (H.SetForm). With the HUD closed, its
-- route's bar or compass: Show More brings the HUD back, a step up.
function H.Menu(anchor)
	local s, v = S(), h.view
	local items = { { "Open Your Chats", H.OpenChats }, { "Ask What's Next", function() ns.QuickAsk("next") end } }
	if ns.Try(UnitExists, "target") then items[#items + 1] = { "Ask About Your Target", function() ns.QuickAsk("target") end } end
	if v and v.routeOnly then
		items[#items + 1] = { "Show More", function() H.ShowForm(v.compass and "bar" or "full") end }
		if not v.compass then items[#items + 1] = { "Show Less", function() H.SetForm("compass") end } end
	elseif v and v.bar then
		local form = not s.hudMin and "full" or (s.hudCompass and "compass" or "bar")
		items[#items + 1] = { "Show More", function() H.SetForm(form == "compass" and "bar" or "full") end }
		if form ~= "compass" then items[#items + 1] = { "Show Less", function() H.SetForm("compass") end } end
	elseif v then
		items[#items + 1] = { "Show Less", function() H.SetMinimized(true) end }
	end
	items[#items + 1] = { "Open Settings", function() ns.Settings.Open() end }
	ns.UI.PopupMenu(anchor, ns.P("NeverQuestAlone HUD"), items) -- [UX-5]
end

---------------------------------------------------------------------------
-- Building
---------------------------------------------------------------------------

-- Drag moves the HUD, a click (not a drag) acts, right-click opens the menu.
-- onClick: a button's left click (a plain frame only has the menu).
local function Handle(region, frame, onClick)
	region:EnableMouse(true)
	region:RegisterForDrag("LeftButton")
	region:SetScript("OnDragStart", function() BeginMove(frame) end)
	region:SetScript("OnDragStop", function() EndMove(frame) end)
	if onClick then
		region:RegisterForClicks("LeftButtonUp", "RightButtonUp")
		region:SetScript("OnClick", function(self, button)
			HideTip()
			if JustMoved() then return end
			if button == "RightButton" then H.Menu(self) elseif onClick then onClick(self) end
		end)
	else
		region:SetScript("OnMouseUp", function(self, button)
			if button == "RightButton" and not JustMoved() then H.Menu(self) end
		end)
	end
end

-- Bones's tooltip, as a bag's portrait has one: his name (and the window's
-- key, when bound), what he's doing, and in green what a click does.
local function PortraitTip(self)
	local key = type(GetBindingKey) == "function" and Try(GetBindingKey, "NQA_OPEN_AND_TYPE")
	local keyText = key and type(GetBindingText) == "function" and Try(GetBindingText, key) or key
	-- What he's doing: the whole of it (the status's detail), else the status.
	local doing = (h.tip and h.tip ~= "") and h.tip or (h.status and h.status:GetText()) or nil
	ShowTip(self, { title = ns.Chats.AgentName(), key = keyText, text = doing,
		actions = { "Click to open your chats", "Right-click for the menu", "Drag to move the HUD" } })
end

-- The HUD's dress, for both of its shapes (the panel and the one line): the
-- game's portrait frame with the backpack's corner, as every bag has it
-- (HeldBagLayout: ContainerFrame.xml's layoutType, which
-- NineSliceUtil.UpdateCornerCropping reads; a 36-unit portrait at -4, +1 and the
-- title from 35, ContainerFrame.lua; on Camelot the mask on the portrait's own
-- square, Camelot/ContainerFrame.lua), the double corner piece for its two
-- buttons (PortraitFrameTemplateMinimizable's; Camelot shifts both corner atlases
-- alike), Bones in the portrait slot (his round face, picked for its drawn size
-- (ns.UI.SetRoundFace, which crops it with the frame's own SetPortraitTexCoord); the global
-- SetPortraitToTexture is missing on 70009).
-- Click-through: only the controls take the mouse. A tooltip backdrop where the
-- template is missing. Returns whether it's framed, and its title's text.
local function DressFrame(f, tpl)
	f:SetWidth(L.W)
	f:SetFrameStrata("MEDIUM")
	f:SetClampedToScreen(true)
	f:SetMovable(true)
	Call(f, "SetDontSavePosition", true)
	f:EnableMouse(false)
	local framed = tpl == "ButtonFrameTemplate"
	local title
	if framed then
		local inset = ns.UI.Child(f, "Inset")
		if inset then inset:Hide() end
		local close = ns.UI.Child(f, "CloseButton")
		if close then close:Hide() end -- the corner's X is one of the red set (Corner)
		title = ns.UI.Child(f, "TitleContainer") and ns.UI.Child(f.TitleContainer, "TitleText")
		f.layoutType = "HeldBagLayout"
		Call(f, "SetBorder", "HeldBagLayout")
		local corner = ns.UI.Child(f, "NineSlice") and ns.UI.Child(f.NineSlice, "TopRightCorner")
		if corner and C_Texture and Try(C_Texture.GetAtlasExists, "UI-Frame-Metal-CornerTopRightDouble") then
			pcall(corner.SetAtlas, corner, "UI-Frame-Metal-CornerTopRightDouble", true)
		end
		Call(f, "SetPortraitTextureSizeAndOffset", L.PORTRAIT, L.PORTRAIT_X, L.PORTRAIT_Y)
		Call(f, "SetTitleOffsets", L.TITLE_X)
		local pc = ns.UI.Child(f, "PortraitContainer")
		local tex = pc and ns.UI.Child(pc, "portrait")
		local mask = pc and ns.UI.Child(pc, "CircleMask")
		if tex and mask then
			mask:ClearAllPoints()
			mask:SetPoint("TOPLEFT", tex, "TOPLEFT", 0, 0)
			mask:SetPoint("BOTTOMRIGHT", tex, "BOTTOMRIGHT", 0, 0)
		end
		h.portraitTex = tex
		ns.UI.SetRoundFace(f, tex, L.PORTRAIT) -- with its crop, shared with the window's (C-150)
	elseif type(f.SetBackdrop) == "function" then
		f:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 14, insets = { left = 3, right = 3, top = 3, bottom = 3 } })
		f:SetBackdropColor(0.06, 0.05, 0.04, 0.92)
		f:SetBackdropBorderColor(0.55, 0.42, 0.22, 1)
	end
	if not title then
		title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal") -- as the template's TitleText
		title:SetPoint("TOP", f, "TOP", 0, -5)
	end
	FitHeight(f, MinHeight())
	return framed, title
end

-- Above the border (the game's nine-slice sits at level 500), as the game's
-- own corner buttons are.
local function TopLevel(f) return math.max(510, (f:GetFrameLevel() or 1) + 10) end

-- The portrait: click opens your chats, right-click the menu, drag moves the
-- HUD; it lights under the pointer (the bag's round highlight), with the
-- state's dot on its edge. Where the frame has no portrait slot, his square
-- face is drawn in the same place.
local function PortraitButton(f, framed)
	local p = CreateFrame("Button", nil, f)
	p:SetSize(L.PORTRAIT + 4, L.PORTRAIT + 4)
	p:SetPoint("CENTER", f, "TOPLEFT", L.PORTRAIT_X + L.PORTRAIT / 2, L.PORTRAIT_Y - L.PORTRAIT / 2)
	p:SetFrameLevel(TopLevel(f))
	if not framed then
		p.face = p:CreateTexture(nil, "ARTWORK")
		p.face:SetPoint("TOPLEFT", p, "TOPLEFT", 2, -2)
		p.face:SetPoint("BOTTOMRIGHT", p, "BOTTOMRIGHT", -2, 2)
		p.face:SetTexture(ns.UI.FACE.square)
		Call(p.face, "SetTexCoord", 0.08, 0.92, 0.08, 0.92)
	end
	RoundGlow(p, L.PORTRAIT + 4)
	Handle(p, f, function() H.OpenChats() end)
	p:SetScript("OnEnter", PortraitTip)
	p:SetScript("OnLeave", HideTip)
	local dot = StateDot(p, 12)
	dot:SetPoint("CENTER", p, "BOTTOMRIGHT", -5, 5)
	return p, dot
end

-- The title band moves the HUD and opens the menu on a right-click.
L.GRIP_TIP = { title = "NeverQuestAlone HUD", text = "What NeverQuestAlone is doing and saying, and the route you follow.",
	actions = { "Drag to move the HUD", "Right-click for the menu" } }
local function Grip(f)
	local g = CreateFrame("Frame", nil, f)
	g:SetPoint("TOPLEFT", f, "TOPLEFT", L.PORTRAIT_R, 0)
	g:SetPoint("TOPRIGHT", f, "TOPRIGHT", -(2 * L.CORNER_BTN + 4), 0)
	g:SetHeight(L.TITLE_H)
	Handle(g, f)
	g:SetScript("OnEnter", function(self) ShowTip(self, L.GRIP_TIP) end)
	g:SetScript("OnLeave", HideTip)
	return g
end

-- The panel's corner, as the game's panels pair them (CommunitiesFrame: the
-- one flush left of the other): -, then the X in the close button's socket.
-- The X closes the HUD, with nothing in its place. The bar and the compass
-- have no buttons: their menu has Show More and Show Less (maintainer).
local function Corner(f)
	local close = KitButton(f, "exit", function() H.Close() end)
	close:SetFrameLevel(TopLevel(f))
	close:SetScript("OnEnter", function(self) ShowTip(self, { title = "Close HUD", text = "Closes the HUD; replies still show as they come, and a route you follow keeps its bar.",
		note = string.format("%s, in Settings, or Show More in that bar's right-click menu brings it back.", ns.Settings.LABELS.hud) }) end)
	close:SetScript("OnLeave", HideTip)
	-- The close button's socket, placed as the game places its own on this
	-- client (UIPanelCloseButtonDefaultAnchorsMixin: Camelot's TOPRIGHT -2, 1,
	-- which is what the window's X gets; retail's is 1, 0). Retail's numbers
	-- left our X 3 past the frame's edge on Forever (maintainer: "a little awkward
	-- placed").
	local anchor = type(UIPanelCloseButtonDefaultAnchorsMixin) == "table" and UIPanelCloseButtonDefaultAnchorsMixin.OnLoad
	if not (type(anchor) == "function" and pcall(anchor, close)) then close:SetPoint("TOPRIGHT", f, "TOPRIGHT", -2, 1) end
	local min = KitButton(f, "minus", function() H.SetMinimized(true) end)
	min:SetFrameLevel(TopLevel(f))
	min:SetScript("OnEnter", function(self) ShowTip(self, { title = "Minimize", text = "Shrinks the HUD to one bar: your route's arrow, quest and distance.",
		note = "Right-click the bar to show less, or all of it again." }) end)
	min:SetScript("OnLeave", HideTip)
	min:SetPoint("RIGHT", close, "LEFT", 0, 0)
	return min, close
end

-- The route's bar: one segment per stop (past 12 stops, the 12 share them),
-- done, the stop you're on (with a white edge), still to come.
-- Each part takes a click (maintainer): the navigator goes to that stop, back or
-- ahead (Map.lua holds a stop you chose). A part that holds several stops (past
-- 12) goes to its first, then on through them. The click area is the part,
-- 4 above and 6 below it; the part lights under the pointer, and its tooltip
-- names the stop.
L.SEG_UP, L.SEG_DOWN = L.LINE, 6
local function Segments(f)
	local segs = { hit = {} }
	local edge = f:CreateTexture(nil, "ARTWORK", nil, 1)
	edge:SetColorTexture(1, 1, 1, 0.9)
	for i = 1, L.SEGMENTS_MAX do
		local t = f:CreateTexture(nil, "ARTWORK", nil, 2)
		t:SetHeight(L.SEG_H)
		segs[i] = t
		local b = CreateFrame("Button", nil, f)
		b:SetFrameLevel((f:GetFrameLevel() or 0) + 3) -- above anything that drags (the minimized row), so a click never starts a drag
		b:RegisterForClicks("LeftButtonUp")
		local hl = b:CreateTexture(nil, "HIGHLIGHT")
		hl:SetPoint("TOPLEFT", t, "TOPLEFT", 0, 0)
		hl:SetPoint("BOTTOMRIGHT", t, "BOTTOMRIGHT", 0, 0)
		hl:SetColorTexture(1, 1, 1, 0.45)
		b:SetScript("OnClick", function(self)
			if Guarded() then return end
			HideTip()
			H.FocusStop(self.first, self.last)
		end)
		b:SetScript("OnEnter", function(self) SegmentTip(self) end)
		b:SetScript("OnLeave", HideTip)
		b:Hide()
		segs.hit[i] = b
	end
	return segs, edge
end
local function DrawSegments(f, segs, edge, r, y, clickable, x0, width)
	x0, width = x0 or L.PAD, width or (L.W - 2 * L.PAD)
	local total, n = r.total, math.min(r.total, L.SEGMENTS_MAX)
	local segW = (width - (n - 1) * L.SEG_GAP) / math.max(1, n)
	local nowSeg
	for i = 1, L.SEGMENTS_MAX do
		local t = segs[i]
		if i <= n then
			local lastStop = total <= L.SEGMENTS_MAX and i or math.ceil(i * total / n)
			local firstStop = total <= L.SEGMENTS_MAX and i or (math.ceil((i - 1) * total / n) + 1)
			t:ClearAllPoints()
			t:SetPoint("TOPLEFT", f, "TOPLEFT", x0 + (i - 1) * (segW + L.SEG_GAP), -y)
			t:SetWidth(segW)
			local hit = segs.hit[i]
			hit:ClearAllPoints()
			hit:SetPoint("TOPLEFT", f, "TOPLEFT", x0 + (i - 1) * (segW + L.SEG_GAP), -(y - L.SEG_UP))
			hit:SetSize(segW + (i < n and L.SEG_GAP or 0), L.SEG_UP + L.SEG_H + L.SEG_DOWN) -- no gap between parts to miss
			hit.first, hit.last = firstStop, lastStop
			hit:SetShown(clickable == true)
			local c = L.SEG_TODO
			if lastStop < r.index then
				c = L.SEG_DONE
			elseif firstStop <= r.index then
				c, nowSeg = L.SEG_NOW, t
			end
			t:SetColorTexture(c[1], c[2], c[3], 1)
			t:Show()
		else
			t:Hide()
			segs.hit[i]:Hide()
		end
	end
	if nowSeg then
		edge:ClearAllPoints()
		edge:SetPoint("TOPLEFT", nowSeg, "TOPLEFT", -1, 1)
		edge:SetPoint("BOTTOMRIGHT", nowSeg, "BOTTOMRIGHT", 1, -1)
		edge:Show()
	else
		edge:Hide()
	end
end
local function HideSegments(segs, edge)
	for _, t in ipairs(segs) do t:Hide() end
	for _, b in ipairs(segs.hit or {}) do b:Hide() end
	edge:Hide()
end

-- The minimized HUD (also in combat and with the window open), small (maintainer:
-- "its still a huge hud"). The metal panel can't be short (its corners are
-- some 150 tall in game), so it's the game's own small frame, the tooltip's
-- border (TooltipBackdropTemplate), in the HUD's dark and gold. At its left the
-- panel's big arrow (maintainer: the compass in place of the skull), then one row:
-- where it points (the quest, in place of "Ready") and the distance (Okay for
-- news); the route's bar under the row, which shows where you are (no "2/6"). With nothing to point to,
-- just the row. Minimized further, the compass: the arrow and the distance,
-- nothing else. Neither has buttons (maintainer: "make that a right click thing
-- only"): a click opens your chats, as his portrait does, right-click the menu
-- (Show More, Show Less). MINI_W wide (the compass as wide as what it shows),
-- its right edge the panel's; MINI_H tall with the arrow, MINI_LINE without.
-- The arrow's texture is 44, but what shows of it turns within a circle some
-- 28 across, so it fits.
L.MINI_W, L.MINI_H, L.MINI_LINE, L.MINI_PAD = 272, 44, 32, 6
L.MINI_IN = L.MINI_PAD + 4 -- words' inset from either side
L.MINI_COL, L.MINI_BTN = L.ARROW_COL, 20 -- the arrow's column, as the panel's (44 in 48); Okay's height
-- The row's start right of the arrow (without it, MINI_IN), where the arrow has
-- as much room on its right as on its left (maintainer: "make them the same
-- optically"): what shows of it is centred some 27.5 in (its texture's middle,
-- 28, less the drawn arrowhead's 0.7 to the left), the border's inner edge is
-- some 2.7 in, so the words start at twice the one less the other, 52. Measured
-- in his screenshot, 60 left 15 on its left and 22 on its right. The compass
-- starts its distance there too.
L.MINI_X = 52
L.MINI_ROW, L.MINI_BAR = 16, 30 -- the row's middle over the route's bar, and the bar

-- Where the arrow points, named for the one line (maintainer: in place of "Ready"):
-- the stop's first quest not yet done, as the quest log shows its name (its
-- level's colour; plain for a tooltip's title), else the stop's words without
-- their number. Returns the words and whether they're a quest's.
local function MiniTarget(r, plain)
	for _, q in ipairs(type(r.quests) == "table" and r.quests or {}) do
		if q.state ~= "done" and q.state ~= "missing" and type(q.title) == "string" and q.title ~= "" then
			local qt = not plain and ns.MapShared and ns.MapShared.QuestTitle
			return (qt and q.id) and qt(q.id, ns.Escape(q.title)) or ns.Escape(q.title), true
		end
	end
	local label = Unapprox(r.label or "")
	return ns.Escape((label:gsub("^%d+%.%s*", ""))), false
end

-- The bar's tooltip is Bones's, as his portrait's. The compass shows nothing
-- else, and a closed HUD's bar only the route, so theirs first names where
-- the arrow points, then what to do there (the words the bar leaves out).
L.MINI_ACTIONS = { "Click to open your chats", "Right-click for the menu", "Drag to move the HUD" }
local function MiniTip(self)
	local v = h.view
	if not (v and (v.compass or v.routeOnly)) then return PortraitTip(self) end
	local r = v.route
	local closed = v.routeOnly and "The HUD is closed: Show More in the menu brings it back." or nil
	if v.corpse then
		ShowTip(self, { title = "Your Corpse", text = "Reach it to come back to life.", actions = L.MINI_ACTIONS, note = closed })
	elseif r then
		local note = Unapprox(r.note or "")
		ShowTip(self, { title = (MiniTarget(r, true)), text = ns.Fill("Stop {i} of {n}.", { i = r.index, n = r.total }),
			lines = note ~= "" and { ns.Escape(note) } or nil, actions = L.MINI_ACTIONS, note = closed })
	else
		PortraitTip(self)
	end
end

local function BuildBar()
	local b, tpl = ns.UI.Create("Frame", "NQAHUDBar", UIParent, { "TooltipBackdropTemplate", "BackdropTemplate" })
	h.bar = b
	b:SetSize(L.MINI_W, L.MINI_H)
	b:SetFrameStrata("MEDIUM")
	b:SetClampedToScreen(true)
	b:SetMovable(true)
	Call(b, "SetDontSavePosition", true)
	b:EnableMouse(false)
	-- The tooltip's border and centre, in the HUD's colours.
	local nine = ns.UI.Child(b, "NineSlice")
	if tpl == "TooltipBackdropTemplate" and nine then
		Call(nine, "SetCenterColor", 0.08, 0.07, 0.06, 0.94)
		Call(nine, "SetBorderColor", 0.78, 0.62, 0.3, 1)
	elseif b.SetBackdrop then
		b:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border",
			tile = true, tileSize = 16, edgeSize = 16, insets = { left = 4, right = 4, top = 4, bottom = 4 } })
		b:SetBackdropColor(0.08, 0.07, 0.06, 0.94)
		b:SetBackdropBorderColor(0.78, 0.62, 0.3, 1)
	end
	-- The panel's big arrow at the left, in its column.
	b.arrowZone = CreateFrame("Frame", nil, b)
	b.arrowZone:SetSize(L.MINI_COL, L.MINI_H)
	b.arrowZone:SetPoint("LEFT", b, "LEFT", 4, 0)
	b.arrow = Arrow(b.arrowZone, L.ARROW)
	b.arrow:SetPoint("CENTER", b.arrowZone, "CENTER", 0, 0)
	-- All of it: a click opens your chats, as Bones's portrait does (not the
	-- second click of a double one on Okay, which is over it); right-click the
	-- menu; a drag moves the HUD.
	local g = CreateFrame("Button", nil, b)
	g:SetAllPoints(b)
	Handle(g, b, function() if not Guarded() then H.OpenChats() end end)
	g:SetScript("OnEnter", MiniTip)
	g:SetScript("OnLeave", HideTip)
	b.grip = g
	-- Guarded as the panel's buttons are: what it does changes under the pointer
	-- (a ding's Okay, then the news's Follow), so a double-click is one (C-109).
	b.okBtn = ns.UI.Button(b, "Okay", 52, function() if Guarded() then return end; Guard(); H.BarOkay() end) -- the row under it opens your chats
	b.okBtn:SetHeight(L.MINI_BTN)
	b.okBtn:SetFrameLevel((g:GetFrameLevel() or 0) + 2) -- over the row that opens your chats
	b.okBtn:SetScript("OnEnter", function(self)
		local v = h.view
		if v and v.header == "pending" then -- what this Okay does: the line it's beside (E-1)
			ShowTip(self, { title = "Send", text = "Sends it now, without the 3 s wait." })
		elseif v and v.stuck and not (news and not v.connHeader) then -- [DR-07]
			ShowTip(self, H.STUCK_TIPS[v.stuck])
		elseif v and L.TIMED[v.header] then
			ShowTip(self, { title = "Okay", text = "Puts it away; nothing is sent." })
		elseif v and (v.warn or v.shortSpend or v.stateOk) then -- [C-13] a state's or the spend line's Okay
			ShowTip(self, { title = "Okay", text = "Puts it away; nothing is sent." }) -- [UX-W23] the timed line's words: one action, one wording
		else
			ShowTip(self, OkayTip(news and news.drew, true))
		end
	end)
	b.okBtn:SetScript("OnLeave", HideTip)
	b.status = Text(b, "P", 1)
	b.dist = Text(b, "P", 1)
	b.why = Text(b, "M", 1)
	b.segs, b.segEdge = Segments(b)
	b:SetScript("OnUpdate", function(self, elapsed)
		self.t = (self.t or 0) + elapsed
		if self.t < 0.1 then return end
		local dt = self.t
		self.t = 0
		H.Tick(dt)
	end)
	b:Hide()
end

-- The portrait slot's round face, picked for its drawn size.
function H.PickFace()
	if h.frame and h.framed then ns.UI.SetRoundFace(h.frame, h.portraitTex, L.PORTRAIT) end
end

local function Build()
	if h.frame or not ns.db then return end
	-- The game's portrait frame with the backpack's corner (DressFrame).
	local f, tpl = ns.UI.Create("Frame", "NQAHUD", UIParent, { "ButtonFrameTemplate", "BackdropTemplate" })
	h.frame, h.template = f, tpl
	local framed, title = DressFrame(f, tpl)
	h.title = title
	h.portraitBtn, h.dot = PortraitButton(f, framed)
	h.framed = framed
	-- His round face picked again when the UI scale or the display changes (ns.UI.RoundFace).
	local faces = CreateFrame("Frame")
	for _, e in ipairs({ "UI_SCALE_CHANGED", "DISPLAY_SIZE_CHANGED" }) do pcall(faces.RegisterEvent, faces, e) end
	faces:SetScript("OnEvent", function() H.PickFace() end)
	h.grip = Grip(f)
	h.minBtn, h.closeBtn = Corner(f)

	-- Beside the portrait: the status and its second line, then Ask at the right.
	h.status = Text(f, "P", 2)
	h.status:SetWidth(L.STATUS_W)
	h.sub = Text(f, "M", 2)
	h.sub:SetPoint("TOPLEFT", h.status, "BOTTOMLEFT", 0, -L.LINE)
	h.sub:SetWidth(L.STATUS_W)
	-- The status lines' words a click away (Header shows it only while there's
	-- more to say): the lines never point to a tooltip.
	h.statusBtn = CreateFrame("Button", nil, f)
	h.statusBtn:SetFrameLevel((f:GetFrameLevel() or 1) + 5)
	-- It lights under the pointer, as the quest log's rows do: the lines are a button.
	local shl = h.statusBtn:CreateTexture(nil, "HIGHLIGHT")
	shl:SetPoint("TOPLEFT", h.statusBtn, "TOPLEFT", -4, 3)
	shl:SetPoint("BOTTOMRIGHT", h.statusBtn, "BOTTOMRIGHT", 4, -3)
	shl:SetTexture("Interface\\QuestFrame\\UI-QuestTitleHighlight")
	Call(shl, "SetBlendMode", "ADD")
	h.statusBtn:SetScript("OnClick", function() H.ShowDetails() end)
	h.statusBtn:SetScript("OnEnter", function(self)
		local v = h.view
		if v and v.pasteChat then
			ShowTip(self, { title = "Paste Reply", text = "Opens Copy and Paste, where you paste your AI's reply." })
		elseif v and v.detail then
			ShowTip(self, { title = "Details", actions = { "Click to see all of it in the window" } })
		end
	end)
	h.statusBtn:SetScript("OnLeave", HideTip)
	h.statusBtn:Hide()
	h.askBtn = RedButton(f, "Ask", function() H.ToggleAsk() end, { title = "Ask",
		text = "Opens a box here for a quick question; Enter sends it to your Quick questions chat.", note = "Esc, or the X, closes the box." }, L.ASK_W)
	-- Open, Ask turns into the box's X (maintainer): a bare gold X, the route icons'
	-- kind, at Ask's right end; not a red one, which the corner's close is (C-73).
	h.askClose = IconAction(f, L.END_ICON, L.END_FILE, function() H.ToggleAsk() end)
	h.askClose:SetScript("OnEnter", function(self)
		ShowTip(self, { title = "Close Box", text = "Puts the box away; what you typed stays for next time." })
	end)
	h.askClose:Hide()

	-- The block: text, then its red button (and, for a reply, Open chat).
	h.label = Text(f, "L", 1)
	h.body = Text(f, "P", 4)
	h.body:SetWidth(L.W - 2 * L.PAD)
	h.okBtn = RedButton(f, "Okay", function() Guard(); H.Okay() end, L.OKAY_TIP)
	h.openBtn = RedButton(f, "Open Chat", function() H.OpenWindow() end, { title = "Open Chat", text = "Opens the reply's chat in the window, where you can answer." }, 84)
	h.stopBtn = RedButton(f, "Stop", function()
		if H.StuckAct() then return end -- [DR-07] Reload or Discard, while the message is stuck
		local c = BusyChat()
		if c then ns.Chats.Stop(c.id) end
		H.Render()
	end, { title = "Stop", text = "Stops work on this message." }, 80)
	h.stopTip = h.stopBtn.tip
	h.pasteBtn = RedButton(f, "Paste Reply", function()
		local c = BusyChat()
		if c and ns.Paste then ns.Paste.Open(c.id) end
	end, { title = "Paste Reply", text = "Opens Copy and Paste, where you paste your AI's reply." }, 96)
	-- [UX-3, C-13, C-23] The public build's: the spend line and its Okay, a
	-- warning's Okay, a spend state's Okay (main's red buttons, whose tips say
	-- only what the click does), hidden until a BYOK bridge says one of them.
	h.spend = Text(f, "B", 2)
	h.spend:SetWidth(L.W - 2 * L.PAD - L.BUTTON_W - L.CONTROLS)
	h.spendOk = RedButton(f, "Okay", function() Guard(); H.SpendOkay() end, { title = "Okay", text = "Puts this away until it changes; nothing is sent." })
	h.warnOk = RedButton(f, "Okay", function() Guard(); H.WarnOkay() end, { title = "Okay", text = "Puts the warning away; nothing is sent." })
	h.stateOk = RedButton(f, "Okay", function() Guard(); H.SpendOkay() end, { title = "Okay", text = "Puts it away; a short line stays until it changes. Nothing is sent." }) -- [UX-W23] not in colour alone
	-- [G1] The setup block's parts: three rows, the sound line, Say Hi and
	-- its Okay (main's red buttons, whose tips say only what the click does), and
	-- why Say Hi can't work yet.
	h.setupRows = { Text(f, "B", 1), Text(f, "B", 1), Text(f, "B", 1) }
	h.setupSlow = Text(f, "B", 2)
	h.setupSlow:SetWidth(L.W - 2 * L.PAD)
	Paint(h.setupSlow, L.GOLD)
	h.setupWhy = Text(f, "M", 1)
	-- [ingame-clarity] The step to do now, as a guide marks it (RestedXP's current step): a faint gold
	-- band behind its row, or, once the rows are done, a gold ring around Say Hi (2 thick, 3 out; it
	-- never pulses); and, once Say Hi works, a line that says what the colored bar at the top of the
	-- screen is (a player: "I have no idea what this is at the top of my screen").
	h.setupNow = f:CreateTexture(nil, "ARTWORK")
	h.setupNow:SetColorTexture(L.GOLD[1], L.GOLD[2], L.GOLD[3], 0.12)
	h.setupBar = Text(f, "M", 1)
	h.sayHiBtn = RedButton(f, "Say Hi", function() Guard(); H.SayHi() end, { title = "Say Hi", text = "Sends \"hi\" to NeverQuestAlone." }, 72)
	h.sayHiRing = {}
	for i, side in ipairs({ { "TOPLEFT", "TOPRIGHT" }, { "BOTTOMLEFT", "BOTTOMRIGHT" }, { "TOPLEFT", "BOTTOMLEFT" }, { "TOPRIGHT", "BOTTOMRIGHT" } }) do
		local t = f:CreateTexture(nil, "ARTWORK")
		t:SetColorTexture(L.GOLD[1], L.GOLD[2], L.GOLD[3], 1)
		for _, point in ipairs(side) do
			t:SetPoint(point, h.sayHiBtn, point, point:find("LEFT") and -5 or 5, point:find("TOP") and 5 or -5)
		end
		if i <= 2 then t:SetHeight(2) else t:SetWidth(2) end
		t:Hide()
		h.sayHiRing[i] = t
	end
	Call(h.sayHiBtn, "SetMotionScriptsWhileDisabled", true) -- greyed, it still says what it does
	h.setupOk = RedButton(f, "Okay", function() Guard(); H.SetupOkay() end, { title = "Okay", text = "Puts this away until you next log in or reload." })
	for _, b in ipairs({ h.spend, h.spendOk, h.warnOk, h.stateOk, h.setupSlow, h.setupWhy, h.sayHiBtn, h.setupOk, h.setupRows[1], h.setupRows[2], h.setupRows[3], h.setupNow, h.setupBar }) do b:Hide() end
	-- The Quality of Life step (QoL.lua): its checks come from Qol.Check.
	h.qolChecks = {}
	h.qolOn = RedButton(f, "Turn On", function() Guard(); ns.QoL.TurnOn() end, { title = "Turn On",
		text = "Turns on the options you picked.", note = "Type /nqa qol to change them later." })
	h.qolSkip = RedButton(f, "Skip", function() Guard(); ns.QoL.Skip() end, { title = "Skip",
		text = "Changes nothing.", note = "Type /nqa qol to turn options on later." })
	h.qolWhy = Text(f, "M", 2)
	h.qolWhy:SetWidth(L.W - 2 * L.PAD)

	-- The box (Ask): a line with room, the whole width. Enter sends, Esc cancels.
	-- The template's border is a fixed 20 tall, so it gives way to the game's
	-- nine-piece input border (InputScrollFrameTemplate's), as tall as the box.
	local box = ns.UI.Create("EditBox", nil, f, { "InputBoxInstructionsTemplate", "InputBoxTemplate" })
	box:SetSize(L.W - 2 * L.PAD, L.BOX_H)
	box:SetAutoFocus(false)
	box:SetFontObject(ChatFontNormal)
	Call(box, "SetTextInsets", L.BOX_INSET, L.BOX_INSET, 0, 0)
	for _, key in ipairs({ "Left", "Right", "Middle" }) do
		local t = ns.UI.Child(box, key)
		if t then t:Hide() end
	end
	InputBorder(box)
	-- The hint where the words you type start, at their size, in grey.
	local hint = ns.UI.Child(box, "Instructions")
	if not hint then
		hint = box:CreateFontString(nil, "ARTWORK", "ChatFontNormal")
		box:HookScript("OnTextChanged", function(self) hint:SetShown((self:GetText() or "") == "") end)
	else
		hint:SetFontObject(ChatFontNormal)
	end
	hint:ClearAllPoints()
	hint:SetPoint("LEFT", box, "LEFT", L.BOX_INSET, 0)
	hint:SetPoint("RIGHT", box, "RIGHT", -L.BOX_INSET, 0)
	hint:SetJustifyH("LEFT")
	if hint.SetWordWrap then hint:SetWordWrap(false) end
	Paint(hint, L.GREY)
	h.replyHint = hint
	box:SetScript("OnEnterPressed", function(self) H.SubmitAsk() end)
	box:SetScript("OnEscapePressed", function(self)
		self:ClearFocus()
		self:Hide()
		H.Render()
	end)
	box:Hide()
	h.replyBox = box
	-- Its words come through a reload or a logout, as the window's box's do: kept at
	-- PLAYER_LOGOUT (below), back in the hidden box for their chat; a key never.
	local kept = ns.db and ns.db.askDraft
	if type(kept) == "table" and type(kept.text) == "string" and type(kept.chat) == "string" and not ns.Chats.KeyShaped(kept.text) then
		box:SetText(kept.text)
		box.chatId = kept.chat
	end
	if ns.db then ns.db.askDraft = nil end

	-- The route: its heading with Re-plan, Skip and End; the bar; the arrow and
	-- the stop; the note; the quests' objectives as a list.
	h.sep = f:CreateTexture(nil, "ARTWORK")
	h.sep:SetHeight(1)
	h.sep:SetColorTexture(0.55, 0.42, 0.22, 0.6)
	h.routeTitle = Text(f, "H", 1)
	h.routeCount = Text(f, "M", 1)
	h.routeCount:SetJustifyH("RIGHT")
	-- The route's two actions, icons at the heading's right (maintainer: Re-plan and
	-- End only; the bar's parts go back or ahead).
	h.replanIcon = IconAction(f, L.REPLAN_ICON, L.REPLAN_FILE, function() H.Replan() end)
	h.replanIcon:SetScript("OnEnter", function(self)
		if pending and pending.owner == self then
			ShowTip(self, { title = "Undo Re-plan", text = "Takes the re-plan back; nothing is sent." })
		else
			ShowTip(self, { title = "Re-plan Route", text = "Asks for a fresh route from where you are, for the quests you still have.",
				note = "It's sent after 3 s; click again before then to undo." })
		end
	end)
	h.endIcon = IconAction(f, L.END_ICON, L.END_FILE, function()
		if type(NQAMap) == "table" and NQAMap.Stop then NQAMap.Stop() end
	end)
	h.endIcon:SetScript("OnEnter", function(self)
		ShowTip(self, { title = "End Route", text = "Stops following this route; it stays on your map.",
			note = "Click one of its pins, or type /nqa map nav, to follow it again." })
	end)
	-- No route: what will be here and how to get it (STYLE §5), and the button.
	h.emptyText = Text(f, "B", 2)
	h.emptyText:SetWidth(L.W - 2 * L.PAD)
	h.routeAskBtn = RedButton(f, "Ask for a Route", function() H.AskRoute() end, nil, L.ROUTE_ASK_W)
	h.routeAskBtn:SetScript("OnEnter", function(self)
		if pending and pending.owner == self then
			ShowTip(self, { title = "Undo", text = "Takes the ask back; nothing is sent." })
		else
			ShowTip(self, { title = "Ask for a Route", text = "Asks for a route from where you are, for the quests in your log.",
				note = "It's sent after 3 s; click again before then to undo." })
		end
	end)
	h.routeAskBtn:SetScript("OnLeave", HideTip)
	h.segs, h.segEdge = Segments(f)
	-- The arrow takes the mouse for its tooltip: it says what it is.
	h.arrowZone = CreateFrame("Frame", nil, f)
	h.arrowZone:SetSize(L.ARROW_COL, L.ARROW_COL)
	h.arrowZone:EnableMouse(true)
	h.arrowZone:SetScript("OnEnter", function(self)
		local shared = ns.MapShared
		if shared and shared.corpseView then
			ShowTip(self, { title = "Way to Your Corpse", text = "The arrow turns as you do: straight up is ahead of you.",
				note = shared.navView and "Reach your corpse to come back to life; your route comes back then." or "Reach your corpse to come back to life." })
			return
		end
		local v = shared and shared.navView
		ShowTip(self, { title = "Way to the Stop", text = "The arrow turns as you do: straight up is ahead of you.",
			note = v and v.waypoint and "The game's waypoint marks the stop in the world too." or nil })
	end)
	h.arrowZone:SetScript("OnLeave", HideTip)
	h.arrow = Arrow(h.arrowZone, L.ARROW)
	h.arrow:SetPoint("CENTER", h.arrowZone, "CENTER", 0, 0)
	h.stop = Text(f, "P", 2)
	h.stop:SetWidth(L.W - L.STOP_X - L.PAD)
	h.dist = Text(f, "V", 1)
	h.distMeta = Text(f, "M", 1)
	h.note = Text(f, "B", 4)
	h.note:SetWidth(L.W - 2 * L.PAD)
	h.qTitles, h.qRows, h.qChains = {}, {}, {}

	-- Every 0.1 s: the arrow and the distance, and what times out.
	f:SetScript("OnUpdate", function(self, elapsed)
		self.t = (self.t or 0) + elapsed
		if self.t < 0.1 then return end
		local dt = self.t
		self.t = 0
		H.Tick(dt)
	end)
	f:Hide()
	BuildBar()
	PlaceFrame()
end
H.Build = Build

---------------------------------------------------------------------------
-- Drawing
---------------------------------------------------------------------------

-- Place a piece at y (from the top); returns the y under it.
local function Put(piece, y, x)
	piece:ClearAllPoints()
	piece:SetPoint("TOPLEFT", h.frame, "TOPLEFT", x or L.PAD, -y)
	piece:Show()
	local ht = piece.GetStringHeight and piece:GetStringHeight() or piece:GetHeight()
	if not ht or ht < 1 then ht = 12 end
	return y + ht
end

-- The Quality of Life step's checks and the loot key its text names, for
-- the layout's key.
function Qol.Key()
	local t, parts = ns.QoL.Ticks(), { tostring(ns.QoL.LootKey()) }
	for _, k in ipairs(ns.QoL.Offered()) do parts[#parts + 1] = t[k] and k or "" end
	return table.concat(parts, ",")
end

-- What decides the layout (not the status texts, which change every tick).
local function LayoutKey(v)
	local r = v.route
	return table.concat({
		v.mode, v.compact and "c" or "", v.body or "", v.chat or "", v.held and "h" or "",
		pending and pending.words or "", v.stopping and "x" or "",
		v.asking and (v.target or "?") or "", tostring(h.mainY), v.replanning and "r" or "", v.corpse and "dead" or "", v.empty and "e" or "", v.okLabel or "",
		v.okShort or "",
		r and (tostring(r.layer) .. ":" .. tostring(r.index) .. ":" .. tostring(r.rev) .. ":" .. tostring(r.gen)) or "",
		tostring(NavState(v.corpse or r)), v.mode == "qol" and Qol.Key() or "",
		v.spend or "", v.warn and "w" or "", v.stateOk and "s" or "", -- [UX-3, C-13, C-23]
		v.setup and v.setup.key or "", -- [G1]
		v.stuck or "", -- [DR-07] the row's button says the stuck send's action (its text; nothing moves)
		ns.Chains and ns.Chains.On() and "q" or "", -- Settings' Quest Chains: the quests' chain lines
	}, "\30")
end

-- The distance, the arrow, and which way (every tick). full: the panel's
-- "231 yd · ahead · approx." (a value, then meta); the one line's "231 yd".
local function Distance(num, meta, arrow, v, full)
	local way = PointArrow(arrow, v)
	if v.dist then
		local yd = ns.Int(math.floor(v.dist + 0.5))
		num:SetText(full and yd or (yd .. " yd"))
		num:Show()
		if meta then
			meta:SetText("yd" .. (way and (" · " .. way) or "") .. (h.approx and " · approx." or ""))
			if meta.mode ~= "after" then
				meta:ClearAllPoints()
				meta:SetPoint("BOTTOMLEFT", num, "BOTTOMRIGHT", L.LINE, 1)
				meta.mode = "after"
			end
		end
	else
		num:SetText("")
		num:Hide()
		if meta then
			meta:SetText(Capital(ns.Escape(v.where or "")))
			if meta.mode ~= "alone" then
				meta:ClearAllPoints()
				meta:SetPoint("TOPLEFT", num, "TOPLEFT", 0, -2)
				meta.mode = "alone"
			end
		end
	end
end

-- One objective row (a bullet or a check, the words, the count at the right),
-- or a quest's name, from the pools.
local function QuestTitle(i)
	local t = h.qTitles[i]
	if not t then
		t = Text(h.frame, "L", 1)
		t:SetWidth(L.W - 2 * L.PAD)
		h.qTitles[i] = t
	end
	return t
end
local function QuestRow(i)
	local row = h.qRows[i]
	if not row then
		row = {}
		row.mark = h.frame:CreateTexture(nil, "OVERLAY")
		row.mark:SetSize(L.BULLET, L.BULLET)
		row.text = Text(h.frame, "B", 2)
		row.count = Text(h.frame, "B", 1)
		row.count:SetJustifyH("RIGHT")
		h.qRows[i] = row
	end
	return row
end
local function HideQuestPieces(fromTitle, fromRow, fromChain)
	for i = fromTitle, #h.qTitles do h.qTitles[i]:Hide() end
	for i = fromRow, #h.qRows do
		local row = h.qRows[i]
		row.mark:Hide(); row.text:Hide(); row.count:Hide()
	end
	for i = fromChain or 1, #h.qChains do h.qChains[i].mark:Hide(); h.qChains[i].text:Hide() end
end

-- Where a quest's chain leads (Chains.lua), 4 under its name, its ready row or
-- its row to pick it up, so a quest that looks minor shows what it's a step of:
-- the payoff's mark on the bullets' column (the quest log's dungeon or raid
-- icon, or the reward's own icon), then the quest page's words in the meta
-- style, the place in gold and a reward's name in its quality's colour, "Leads
-- to The Deadmines · step 1 of 7". Never a link: nothing on the HUD takes the
-- mouse [UC-01]. Wider than the list, it says where without the step, in two
-- lines at most [UC-03]. Nothing for a quest that leads to nothing for this
-- character, for a ready last step of a chain to a place (you've been [UC-04]),
-- or with Settings' Quest Chains off. n: the lines used so far. Returns y, n.
local function ChainLine(n, id, y, ready)
	local text, item, two, kind
	if ns.Chains and id then text, item, two, kind = ns.Chains.Line(id, Hex(L.GOLD)) end
	if ready and kind ~= "item" and text and not ns.Chains.For(id).next then text = nil end
	if not text then return y, n end
	n = n + 1
	local c = h.qChains[n]
	if not c then
		c = { mark = h.frame:CreateTexture(nil, "OVERLAY"), text = Text(h.frame, "M", 2) }
		c.mark:SetSize(L.CHAIN_ICON, L.CHAIN_ICON)
		h.qChains[n] = c
	end
	y = y + L.LINE
	local icon = item and Try(C_Item and C_Item.GetItemIconByID, item)
	if icon then
		c.mark:SetTexture(icon)
		c.mark:SetTexCoord(0.08, 0.92, 0.08, 0.92) -- the icon without its border, as the bags crop it
	end
	-- Off the bullets' centre by half the size's difference; none where this client has no such icon [UC-06].
	c.mark:SetShown(icon ~= nil or (not item and Art(c.mark, L.CHAIN_ATLAS[kind])))
	c.mark:ClearAllPoints()
	c.mark:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.BULLET_X - (L.CHAIN_ICON - L.BULLET) / 2, -y)
	local x = L.BULLET_X + L.BULLET + 6
	local w = L.W - L.PAD - x -- [UC-05] to the right gutter, as the counts end
	c.text:SetWidth(w)
	c.text:SetText(text)
	if two then
		local full = Try(c.text.GetUnboundedStringWidth, c.text) or Try(c.text.GetStringWidth, c.text)
		if tonumber(full) and full > w then c.text:SetText(two:match("^[^\n]+")) end
	end
	local bottom = Put(c.text, y, x)
	return math.max(bottom, y + L.CHAIN_ICON), n
end

-- The quests' objectives, as the quest tracker lists them: a quest's name, then
-- a bullet per objective, its words and its count; done ones checked and grey.
local function RenderQuests(rows, y)
	local nt, nr, nc, prev, spaced = 0, 0, 0, nil, false
	for _, it in ipairs(rows) do
		if it.kind == "quest" then
			-- A quest's name: 8 under the rows before it, as the game's quest log
			-- and tracker show it (maintainer): its colour for its level against yours,
			-- and "[12]" before it, as you've set them (Map.lua QuestTitle).
			nt = nt + 1
			local t = QuestTitle(nt)
			local qt = ns.MapShared and ns.MapShared.QuestTitle
			t:SetText(qt and it.id and qt(it.id, ns.Escape(it.text)) or ns.Escape(it.text))
			Paint(t, L.GOLD) -- the tracker's header colour, where no colour is set
			y = Put(t, y + (prev and L.CONTROLS or 0))
			y, nc = ChainLine(nc, it.id, y)
			spaced = false
		else
			-- A row: 4 under the name or the row before it, as the tracker spaces them;
			-- 8 under a row's chain line, so the line reads as its own row's [UC-07].
			nr = nr + 1
			y = y + (spaced and L.CONTROLS or (prev and L.LINE or 0))
			local row = QuestRow(nr)
			local c = it.color or (it.done and L.GREY or L.LIGHT)
			local countW = 0
			if it.count and it.count ~= "" then
				row.count:SetText(ns.Escape(it.count))
				row.count:ClearAllPoints()
				row.count:SetPoint("TOPRIGHT", h.frame, "TOPRIGHT", -L.PAD, -y)
				Paint(row.count, c)
				row.count:Show()
				countW = (row.count:GetStringWidth() or 20) + L.CONTROLS
			else
				row.count:Hide()
			end
			-- The tracker's own nub and check, in their own colours.
			if it.done then
				Art(row.mark, "ui-questtracker-tracker-check", "Interface\\Buttons\\UI-CheckBox-Check")
			else
				Art(row.mark, "ui-questtracker-objective-nub", L.CIRCLE)
			end
			row.mark:SetVertexColor(1, 1, 1, 1)
			row.mark:ClearAllPoints()
			row.mark:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.BULLET_X, -(y + 1))
			row.mark:Show()
			row.text:SetWidth(L.W - 2 * L.PAD - (L.BULLET + 6) - countW)
			row.text:SetText(ns.Escape(it.text))
			Paint(row.text, c)
			local bottom = Put(row.text, y, L.BULLET_X + L.BULLET + 6)
			y = math.max(bottom, y + L.BULLET + 2)
			local had = nc
			if it.id then y, nc = ChainLine(nc, it.id, y, it.ready) end -- a ready quest's row, or one to pick up
			spaced = nc > had
		end
		prev = it.kind
	end
	HideQuestPieces(nt + 1, nr + 1, nc + 1)
	return y
end

-- The route (Map.lua's navigator state, ns.MapShared.navView).
-- The route's heading row (the name, "4/6", Re-plan and End) and its bar.
local function RenderRouteHead(v, r, y)
	-- The heading row: the name (H), then "4/6" (M) and the two icons at the
	-- right, End last (its glyph on the gutter).
	local inset = (L.ICON - L.GLYPH) / 2 -- a glyph's edge inside its box
	h.endIcon:ClearAllPoints()
	h.endIcon:SetPoint("TOPRIGHT", h.frame, "TOPRIGHT", -(L.PAD - inset), -y)
	h.endIcon:Show()
	local undo = pending ~= nil and pending.owner == h.replanIcon
	if h.replanIcon.undo ~= undo then
		h.replanIcon.undo = undo
		IconArt(h.replanIcon.icon, undo and L.UNDO_ICON or L.REPLAN_ICON, L.REPLAN_FILE)
	end
	h.replanIcon:ClearAllPoints()
	h.replanIcon:SetPoint("RIGHT", h.endIcon, "LEFT", -(L.CONTROLS - 2 * inset), 0) -- the glyphs 8 apart
	h.replanIcon:Show()
	h.routeCount:SetText(v.replanning and "Re-planning…" or string.format("%d/%d", r.index, r.total))
	h.routeCount:ClearAllPoints()
	h.routeCount:SetPoint("RIGHT", h.replanIcon, "LEFT", -(L.CONTROLS - inset), 0)
	h.routeCount:Show()
	h.routeTitle:SetText(ns.Escape(r.title or "Route"))
	h.routeTitle:ClearAllPoints()
	h.routeTitle:SetPoint("LEFT", h.frame, "TOPLEFT", L.PAD, -(y + L.ICON / 2))
	h.routeTitle:SetPoint("RIGHT", h.routeCount, "LEFT", -L.CONTROLS, 0)
	h.routeTitle:Show()
	y = y + L.ICON + L.LINE
	-- The bar.
	DrawSegments(h.frame, h.segs, h.segEdge, r, y, true)
	return y + L.SEG_H
end

-- While you're a ghost (v.corpse) there's no route to show (H.View): under the
-- divider, only the arrow row, your corpse's, until you're alive.
local function RenderRoute(v, y)
	local pieces = { h.sep, h.routeTitle, h.routeCount, h.replanIcon, h.endIcon, h.arrowZone, h.stop, h.dist, h.distMeta, h.note, h.segEdge }
	local r, corpse = v.route, v.corpse
	local empty = v.empty and not v.compact
	if (not r and not corpse and not empty) or v.compact then
		h.navState = nil
		for _, p in ipairs(pieces) do p:Hide() end
		h.emptyText:Hide()
		h.routeAskBtn:Hide()
		HideSegments(h.segs, h.segEdge)
		for _, t in ipairs(h.segs) do t:Hide() end
		HideQuestPieces(1, 1)
		return y
	end
	-- A divider, 12 above and 8 below.
	y = y + L.GROUP
	h.sep:ClearAllPoints()
	h.sep:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.PAD, -y)
	h.sep:SetPoint("TOPRIGHT", h.frame, "TOPRIGHT", -L.PAD, -y)
	h.sep:Show()
	y = y + 1 + L.CONTROLS
	-- No route (maintainer): what will be here and the one click that gets it; the
	-- button is Undo for the 3 s before the ask goes.
	if empty then
		h.navState = nil
		for i = 2, #pieces do pieces[i]:Hide() end
		HideSegments(h.segs, h.segEdge)
		for _, t in ipairs(h.segs) do t:Hide() end
		HideQuestPieces(1, 1)
		h.emptyText:SetText("No route yet. Ask for one: it's drawn from the quests in your log.")
		y = Put(h.emptyText, y) + L.GROUP
		h.routeAskBtn:SetText((pending and pending.owner == h.routeAskBtn) and "Undo" or "Ask for a Route")
		h.routeAskBtn:ClearAllPoints()
		h.routeAskBtn:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.PAD, -y)
		h.routeAskBtn:Show()
		return y + L.BUTTON_H
	end
	h.emptyText:Hide()
	h.routeAskBtn:Hide()
	-- The heading and the bar, then 12 to the arrow row.
	if r then
		y = RenderRouteHead(v, r, y) + L.GROUP
	else
		for _, p in ipairs({ h.routeTitle, h.routeCount, h.replanIcon, h.endIcon }) do p:Hide() end
		HideSegments(h.segs, h.segEdge)
	end
	-- The arrow row: the arrow, then the stop (P) and its distance and way (V, M);
	-- a ghost's, "Your corpse".
	local label, note, a1, a2 = "Your corpse", "", false, false
	if not corpse then
		label, a1 = Unapprox(r.label or "")
		note, a2 = Unapprox(r.note or "")
	end
	h.approx = a1 or a2
	-- The arrow's column only while it points (C-90); else the stop's words
	-- start at the gutter, and why is said on its own ("Off the map").
	h.navState = NavState(corpse or r)
	local pointing = h.navState == 2
	local sx = pointing and L.STOP_X or L.PAD
	if pointing then
		h.arrowZone:ClearAllPoints()
		h.arrowZone:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.PAD, -y)
	end
	h.arrowZone:SetShown(pointing)
	-- The stop and its distance, as one block centred on the arrow.
	h.stop:SetWidth(L.W - sx - L.PAD)
	h.stop:SetText(ns.Escape(label))
	h.distMeta:Show()
	h.distMeta.mode = nil
	Distance(h.dist, h.distMeta, h.arrow, corpse or r, true)
	local sh = h.stop:GetStringHeight() or 16
	if sh < 1 then sh = 16 end
	local dh = (h.dist:IsShown() and h.dist:GetStringHeight()) or h.distMeta:GetStringHeight() or 16
	if dh < 1 then dh = 16 end
	local top = pointing and (y + math.max(0, math.floor((L.ARROW_COL - (sh + L.LINE + dh)) / 2 + 0.5))) or y
	local ty = Put(h.stop, top, sx)
	h.dist:ClearAllPoints()
	h.dist:SetPoint("TOPLEFT", h.frame, "TOPLEFT", sx, -(ty + L.LINE))
	y = math.max(pointing and (y + L.ARROW_COL) or y, ty + L.LINE + dh)
	if corpse then
		h.note:Hide()
		HideQuestPieces(1, 1)
		return y
	end
	-- What to do there (B), then the quests' objectives as a list: 12 under the
	-- stop row, 8 between the note and the list. A note the list already says
	-- isn't said twice.
	local rows = QuestRows(r, label, note)
	if RestatesList(note, rows) then note = "" end
	local gap = L.GROUP
	if note ~= "" then
		h.note:SetText(ns.Escape(note))
		y = Put(h.note, y + gap)
		gap = L.CONTROLS
	else
		h.note:Hide()
	end
	if #rows > 0 then
		y = RenderQuests(rows, y + gap)
	else
		HideQuestPieces(1, 1)
	end
	return y
end


-- The Quality of Life step's checks: the game's check box, its whole row a
-- click (the label too, white: what you act on); a click only checks or
-- unchecks, with the game's check box sound, and nothing changes until Turn
-- On. Its tooltip is the switch's Settings description. The block is at
-- most 232 units tall: its text three lines in the game's font, four at most
-- (PRD G4).
Qol.ROW, Qol.CHECK = 24, 24
function Qol.Text(offered)
	local loot = false
	for _, k in ipairs(offered) do loot = loot or k == "loot" end
	local key = loot and ns.QoL.LootKey()
	if not loot then return "Click Turn On and these finish the quest and vendor windows you open. Hold Shift as you open one to finish it yourself." end
	if key and key ~= "Shift" then
		-- %s: the game's loot key
		return string.format("Click Turn On and these finish the quest, loot and vendor windows you open. Hold Shift (%s for loot) as you open one to finish it yourself.", key)
	end
	return "Click Turn On and these finish the quest, loot and vendor windows you open. Hold Shift as you open one to finish it yourself."
end
function Qol.Check(i)
	local c = h.qolChecks[i]
	if c then return c end
	c = ns.UI.Create("CheckButton", nil, h.frame, { "UICheckButtonTemplate" })
	c:SetSize(Qol.CHECK, Qol.CHECK)
	local own = rawget(c, "Text") -- the template's label: ours is c.text
	if type(own) == "table" and type(own.SetText) == "function" then own:SetText("") end
	c.text = Text(h.frame, "B", 1)
	Paint(c.text, L.WHITE)
	c.text:SetPoint("LEFT", c, "RIGHT", 2, 0)
	c.text:SetWidth(L.W - 2 * L.PAD - Qol.CHECK - 2)
	Call(c, "SetHitRectInsets", 0, -(L.W - 2 * L.PAD - Qol.CHECK), 0, 0)
	c:SetScript("OnClick", function(self)
		if Guarded() then self:SetChecked(ns.QoL.Ticks()[self.key] == true) return end
		ns.QoL.Tick(self.key)
		local on = ns.QoL.Ticks()[self.key] == true
		local kit = type(SOUNDKIT) == "table" and SOUNDKIT or {}
		Try(PlaySound, on and (kit.IG_MAINMENU_OPTION_CHECKBOX_ON or 856) or (kit.IG_MAINMENU_OPTION_CHECKBOX_OFF or 857))
		H.Render()
	end)
	c:SetScript("OnEnter", function(self)
		ShowTip(self, { title = ns.QoL.LABELS[self.key], text = ns.QoL.Describe(self.key) })
	end)
	c:SetScript("OnLeave", HideTip)
	h.qolChecks[i] = c
	return c
end

-- Lay the panel out for a view: every control is set shown or hidden once,
-- so one that stays never blinks.
local function Layout(v)
	local f = h.frame
	local y = h.mainY
	local show = {}
	if not v.compact then
		-- [C-23] A spend state the status line names: its Okay under the second line.
		if v.stateOk then
			y = y + L.GROUP
			h.stateOk:ClearAllPoints()
			h.stateOk:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
			show[h.stateOk] = true
			y = y + L.BUTTON_H
		end
		if v.mode == "qol" then
			-- The first run's Quality of Life step: what these are, the one-click
			-- set as checks, then Turn On and Skip (QoL.lua).
			local Q = ns.QoL
			h.label:SetText("Quality of Life")
			y = Put(h.label, y + L.GROUP) + L.LINE
			Restyle(h.body, "B")
			if h.body.SetMaxLines then h.body:SetMaxLines(4) end -- the block's budget: 232 units at most
			local offered = Q.Offered()
			h.body:SetText(Qol.Text(offered))
			y = Put(h.body, y) + L.CONTROLS
			local ticks = Q.Ticks()
			for i, key in ipairs(offered) do
				local c = Qol.Check(i)
				c.key = key
				c.text:SetText(Q.LABELS[key])
				c:SetChecked(ticks[key] == true)
				c:ClearAllPoints()
				c:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD - 4, -y) -- the box's art sits 4 inside its frame
				show[c], show[c.text] = true, true
				y = y + Qol.ROW
			end
			y = y + L.CONTROLS
			local any = Q.AnyTicked()
			h.qolOn:ClearAllPoints()
			h.qolOn:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
			Call(h.qolOn, "SetEnabled", any)
			h.qolSkip:ClearAllPoints()
			h.qolSkip:SetPoint("LEFT", h.qolOn, "RIGHT", L.CONTROLS, 0)
			show[h.label], show[h.body], show[h.qolOn], show[h.qolSkip] = true, true, true, true
			y = y + L.BUTTON_H
			if not any then
				-- A disabled button says why, beside it (docs/STYLE.md §14).
				h.qolWhy:SetText("Pick an option first, or click Skip.")
				y = Put(h.qolWhy, y + L.LINE)
				show[h.qolWhy] = true
			end
		elseif v.mode == "news" or v.mode == "working" then
			-- What Bones says is the block's one P line; what you asked is body text.
			Restyle(h.body, v.mode == "news" and "P" or "B")
			if h.body.SetMaxLines then h.body:SetMaxLines(4) end
			h.body:SetText(v.body)
			y = Put(h.body, y + L.GROUP)
			show[h.body] = true
			if v.mode == "news" then
				-- Only Okay and Open chat.
				y = y + L.CONTROLS
				h.okBtn:ClearAllPoints()
				h.okBtn:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
				h.openBtn:ClearAllPoints()
				h.openBtn:SetPoint("LEFT", h.okBtn, "RIGHT", L.CONTROLS, 0)
				-- [UX-5] Our words in the companion's name before the chat's name joins them.
				h.openBtn.tip = { title = "Open Chat", text = ns.P("Opens %s in the window, with the whole reply, where you can answer."):format(ns.Escape(v.chatName or "the chat")), raw = true }
				h.okBtn:SetText(v.okLabel or "Okay")
				h.okBtn:SetWidth((v.okLabel or "Okay") == "Okay" and L.BUTTON_W or L.FOLLOW_W)
				h.okBtn.tip = OkayTip(news and news.drew)
				show[h.okBtn], show[h.openBtn] = true, true
				y = y + L.BUTTON_H
			elseif v.pasting then
				-- Copy and Paste: the one thing to do is paste the reply (Stop is in its window).
				y = y + L.CONTROLS
				h.pasteBtn:ClearAllPoints()
				h.pasteBtn:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
				show[h.pasteBtn] = true
				y = y + L.BUTTON_H
			elseif not v.held then
				-- Stop; once clicked the same button, greyed, says "Stopping…" until
				-- the run ends, so nothing moves under a second click (C-72).
				y = y + L.CONTROLS
				h.stopBtn:ClearAllPoints()
				h.stopBtn:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
				-- [DR-07] While the message is stuck, the same button (the text changes, it
				-- doesn't move) is its one action: Reload, or Discard after a Reload.
				h.stopBtn:SetText((v.stuck and (v.stuck == "discard" and "Discard" or "Reload")) or (v.stopping and "Stopping…") or "Stop")
				h.stopBtn.tip = H.STUCK_TIPS[v.stuck] or h.stopTip
				Call(h.stopBtn, "SetEnabled", v.stuck ~= nil or not v.stopping)
				show[h.stopBtn] = true
				y = y + L.BUTTON_H
			end
		elseif v.setup then
			-- [G1] The setup block, in main's Welcome parts: its gold label,
			-- the body, three rows with the ready check's marks, the gold sound
			-- line, then Say Hi and Okay (main's red buttons) and, while Say Hi
			-- can't work yet, why, in grey.
			local st = v.setup
			h.label:SetText("Welcome")
			y = Put(h.label, y + L.GROUP) + L.LINE
			-- [ingame-clarity] Ready, the line that says the one thing to do is the block's primary line.
			Restyle(h.body, st.ready and "P" or "B")
			if h.body.SetMaxLines then h.body:SetMaxLines(2) end
			h.body:SetText(ns.P(st.ready and "I'm NeverQuestAlone. Click Say Hi, then ask me anything." or "I'm NeverQuestAlone. I'll answer anything you ask, right here.")) -- [CF-UX-05] the button beside it
			y = Put(h.body, y) + L.CONTROLS
			-- [ingame-clarity] One step at a time: the first row not done is the one to do (white, on the
			-- band); the rows done and the ones after it wait in grey, their marks saying which is which.
			local now
			for i = 1, 3 do
				if not st.ok[i] then now = i break end
			end
			for i = 1, 3 do
				local row = h.setupRows[i]
				row:SetText(ns.UI.Mark(st.ok[i]) .. " " .. st.rows[i])
				Paint(row, i == now and L.WHITE or L.GREY)
				local top = y
				y = Put(row, y) + L.LINE
				if i == now then
					h.setupNow:ClearAllPoints()
					h.setupNow:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD - 4, -(top - 2))
					h.setupNow:SetSize(L.W - 2 * L.PAD + 8, y - L.LINE - top + 4)
					show[h.setupNow] = true
				end
				show[row] = true
			end
			if st.slow then
				h.setupSlow:SetText("Replies are slow with game sound off: keep Enable Sound on.")
				y = Put(h.setupSlow, y) + L.LINE
				show[h.setupSlow] = true
			end
			y = y - L.LINE + L.CONTROLS
			h.sayHiBtn:ClearAllPoints()
			h.sayHiBtn:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
			Call(h.sayHiBtn, "SetEnabled", st.ready)
			h.setupOk:ClearAllPoints()
			h.setupOk:SetPoint("LEFT", h.sayHiBtn, "RIGHT", L.GROUP, 0) -- [ingame-clarity] clear of Say Hi's ring
			show[h.label], show[h.body], show[h.sayHiBtn], show[h.setupOk] = true, true, true, true
			for _, t in ipairs(h.sayHiRing) do show[t] = st.ready end -- [ingame-clarity] the step now is Say Hi
			y = y + L.BUTTON_H
			-- Under the buttons, one grey line: why Say Hi waits; once it works, what the player sees when
			-- it sends: the colored bar while screen reading draws it, else the reload messages wait for
			-- (no bar comes then). The block keeps main's Welcome's height.
			if not st.ready then
				h.setupWhy:SetText("Say Hi works once all three are done.")
				y = Put(h.setupWhy, y + L.LINE)
				show[h.setupWhy] = true
			else
				h.setupBar:SetText(ns.Transport.StripOut() and "Sending shows a colored bar up top." or "Your messages wait for a reload.")
				y = Put(h.setupBar, y + L.LINE + 4) -- under the ring
				show[h.setupBar] = true
			end
		elseif v.mode == "welcome" then
			-- [C-137] Main's Copy and Paste Welcome: its gold label, the whole body (no line cap), Okay.
			h.label:SetText("Welcome")
			y = Put(h.label, y + L.GROUP) + L.LINE
			Restyle(h.body, "B")
			if h.body.SetMaxLines then h.body:SetMaxLines(0) end
			h.body:SetText(ns.Paste.Named(ns.Paste.WELCOME))
			y = Put(h.body, y) + L.CONTROLS
			h.setupOk:ClearAllPoints()
			h.setupOk:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
			show[h.label], show[h.body], show[h.setupOk] = true, true, true
			y = y + L.BUTTON_H
		elseif v.warn then
			-- [C-13] The status line says the warning; its Okay here.
			y = y + L.GROUP
			h.warnOk:ClearAllPoints()
			h.warnOk:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
			show[h.warnOk] = true
			y = y + L.BUTTON_H
		end
		-- [UX-3, C-02] The spend line, when spend needs you: after the block,
		-- never between a label and its words; its Okay at the right, but not while
		-- news shows (that has its own Okay).
		if v.spend then
			y = y + L.GROUP
			local okay = v.mode ~= "news"
			h.spend:SetWidth(L.W - 2 * L.PAD - (okay and (L.BUTTON_W + L.CONTROLS) or 0))
			h.spend:SetText(v.spend)
			Paint(h.spend, v.spendColor or L.GOLD)
			local sh = h.spend:GetStringHeight()
			if not sh or sh < 1 then sh = 12 end
			h.spend:ClearAllPoints()
			h.spend:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -(y + (okay and math.max(0, math.floor((L.BUTTON_H - sh) / 2 + 0.5)) or 0)))
			show[h.spend] = true
			if okay then
				h.spendOk:ClearAllPoints()
				h.spendOk:SetPoint("TOPRIGHT", f, "TOPRIGHT", -L.PAD, -y)
				show[h.spendOk] = true
			end
			y = y + math.max(sh, okay and L.BUTTON_H or 0)
		end
	end
	for _, b in ipairs({ h.label, h.body, h.okBtn, h.openBtn, h.stopBtn, h.pasteBtn, h.qolOn, h.qolSkip, h.qolWhy }) do
		b:SetShown(show[b] == true)
	end
	for _, c in ipairs(h.qolChecks) do
		c:SetShown(show[c] == true)
		c.text:SetShown(show[c.text] == true)
	end
	for _, b in ipairs({ h.spend, h.spendOk, h.warnOk, h.stateOk, h.sayHiBtn, h.setupOk, h.setupSlow, h.setupWhy, h.setupRows[1], h.setupRows[2], h.setupRows[3], h.setupNow, h.setupBar,
		h.sayHiRing[1], h.sayHiRing[2], h.sayHiRing[3], h.sayHiRing[4] }) do -- the public build's, only as they change
		if b:IsShown() ~= (show[b] == true) then b:SetShown(show[b] == true) end
	end
	-- The box you're typing in, even folded (combat, the window open).
	if v.asking then
		y = y + L.GROUP
		h.replyBox:ClearAllPoints()
		h.replyBox:SetPoint("TOPLEFT", f, "TOPLEFT", L.PAD, -y)
		y = y + L.BOX_H
	end
	y = RenderRoute(v, y)
	FitHeight(f, math.max(y + L.GROUP, MinHeight()))
end

-- The status texts (which change as time passes), beside the portrait and
-- level with its middle; the state's dot; the title.
local function Header(v)
	h.tip = v.tip
	-- [code health AD-18] Redrawn only when what it shows changes: the dot, the status
	-- lines and their colour, the details' button, Ask or its box, and the title's count.
	local open = h.replyBox ~= nil and h.replyBox:IsShown()
	local color = v.statusColor or (v.error and L.RED) or (v.says and L.GOLD) or (v.live and L.WHITE or L.GREY) -- [C-10] statusColor: a BYOK state's
	local unread = 0
	for _, ch in ipairs(ns.db.chats) do unread = unread + (tonumber(ch.unread) or 0) end
	local key = table.concat({ tostring(v.ring), tostring(color), v.subOneLine and "1" or "2", tostring(v.mode), v.status or "", v.sub or "",
		v.detail and "d" or "", open and "o" or "", ns.Chats.AgentName(), unread }, "\30")
	if key == h.headerKey then return end
	h.headerKey = key
	PaintState(h.dot, v.ring)
	Paint(h.status, color)
	if h.sub.SetMaxLines then h.sub:SetMaxLines(v.subOneLine and 1 or 2) end
	-- The Quality of Life step lays out as if the header were at its tallest
	-- (two status lines and two under them), so a connection state or a flash
	-- never moves its checks and Turn On under the pointer (C-117): each
	-- line's two-line height, measured in its own font.
	local tall
	if v.mode == "qol" then
		h.status:SetText("M\nM")
		h.sub:SetText("M\nM")
		tall = { h.status:GetStringHeight() or 28, h.sub:GetStringHeight() or 24 }
	end
	h.status:SetText(v.status or "")
	h.sub:SetText(v.sub or "")
	-- Ask 12 under the corner's buttons, the status line centred on it, the
	-- second line under it. As much room under the lines as over them (maintainer:
	-- "more evenly spaced around them"): the next block starts that far below.
	local sh = h.status:GetStringHeight() or 14
	local bh = (v.sub or "") ~= "" and (h.sub:GetStringHeight() or 12) or 0
	local block = math.ceil(sh + (bh > 0 and (L.LINE + bh) or 0))
	local top = math.max(L.HEAD_Y, L.ASK_Y + math.max(0, math.floor((L.BUTTON_H - sh) / 2 + 0.5)))
	h.status:ClearAllPoints()
	h.status:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.HEAD_X, -top)
	-- Over the status lines while they have more to say; else clicks there
	-- reach the world.
	if v.detail then
		h.statusBtn:ClearAllPoints()
		h.statusBtn:SetPoint("TOPLEFT", h.frame, "TOPLEFT", L.HEAD_X, -top)
		h.statusBtn:SetSize(L.STATUS_W, math.max(block, 14))
		h.statusBtn:Show()
	elseif h.statusBtn:IsShown() then
		h.statusBtn:Hide()
	end
	-- Ask, a button at the right; while a reply shows, only its Okay and Open
	-- chat (maintainer: one way to talk at a time, no second bubble). While its box
	-- is open it's the box's X (maintainer).
	h.askBtn:ClearAllPoints()
	h.askBtn:SetPoint("TOPRIGHT", h.frame, "TOPRIGHT", -L.ASK_R, -L.ASK_Y)
	h.askBtn:SetShown(v.mode ~= "news" and not open)
	h.askClose:ClearAllPoints()
	h.askClose:SetPoint("RIGHT", h.frame, "TOPRIGHT", -(L.ASK_R - (L.ICON - L.GLYPH) / 2), -(L.ASK_Y + L.BUTTON_H / 2)) -- its glyph on the gutter, level with Ask
	h.askClose:SetShown(open)
	local gap = top - L.TITLE_H -- over the lines, from the title band
	h.mainY = math.max(L.PORTRAIT_B, top + block + gap - L.GROUP, L.ASK_Y + L.BUTTON_H) -- blocks start GROUP under mainY
	if tall then
		local ttop = math.max(L.HEAD_Y, L.ASK_Y + math.max(0, math.floor((L.BUTTON_H - tall[1]) / 2 + 0.5)))
		h.mainY = math.max(h.mainY, ttop + math.ceil(tall[1] + L.LINE + tall[2]) + (ttop - L.TITLE_H) - L.GROUP)
	end
	-- "Bones  2 new": unread replies across your chats.
	local title = ns.Chats.AgentName() .. (unread > 0 and ("  " .. Hex(L.GREEN) .. unread .. " new|r") or "")
	h.title:SetText(title)
	if h.bar and h.bar.title then h.bar.title:SetText(title) end
end

-- The compass's distance starts where the bar's words do (MINI_X: the arrow
-- as much room on either side). It keeps one width for any distance up to
-- 9999 yd, so the arrow never hops as the digits change (C-86); its right
-- edge is the panel's.
L.COMPASS_X = L.MINI_X
local function FitCompass(b)
	local w
	if b.dist:IsShown() then
		w = math.max(b.distMax or 0, b.dist:GetStringWidth() or 0)
	else
		w = b.status:GetStringWidth() or 60
	end
	b:SetWidth((b.pointing and L.COMPASS_X or L.MINI_IN) + math.ceil(w) + L.MINI_IN)
end


-- The compass: the arrow and the distance, nothing else (maintainer). Where the
-- arrow has nowhere to point, no arrow, and why in grey (your corpse not on
-- this map, off the map in an instance, another continent), or that there's
-- no route.
local function RenderCompass(v, b)
	b.okBtn:Hide()
	b.why:Hide()
	HideSegments(b.segs, b.segEdge)
	local rowY = (b.pointing and L.MINI_H or L.MINI_LINE) / 2
	if b.navState > 0 then
		b.status:Hide()
		Distance(b.dist, nil, b.arrow, b.nav, false)
		local now = b.dist:GetText()
		b.dist:SetText("9999 yd")
		b.distMax = b.dist:GetStringWidth() or 60
		b.dist:SetText(now)
		b.dist:ClearAllPoints()
		b.dist:SetPoint("LEFT", b, "TOPLEFT", b.pointing and L.COMPASS_X or L.MINI_IN, -rowY)
	else
		b.arrow:Hide()
		b.dist:Hide()
		local where = b.nav and b.nav.where
		b.status:SetText(v.corpse and ("Your corpse" .. (where and (": " .. ns.Escape(where)) or ""))
			or (where and Capital(ns.Escape(where))) or "No route")
		Paint(b.status, L.GREY)
		b.status:ClearAllPoints()
		b.status:SetPoint("LEFT", b, "TOPLEFT", L.MINI_IN, -rowY)
		b.status:Show()
	end
	b:SetHeight(b.pointing and L.MINI_H or L.MINI_LINE)
	FitCompass(b)
end

-- The bar's row, right to left: the distance (or Okay for news, his words
-- then having the row); then what the arrow points to (the quest, in
-- place of "Ready"), or Bones's state while something's happening, takes
-- what's left and is cut first. The arrow at the left while it points
-- somewhere (your corpse, else the stop), news or not; with a route, the row
-- sits over its bar.
local function RenderBar(v)
	local b = h.bar
	local r, news = v.route, v.mode == "news"
	-- A ghost with nothing else to say: what the arrow points to.
	local corpse = v.corpse and not v.live
	h.tip = v.tip
	b.nav = v.corpse or r or nil
	b.compass = v.compass
	-- The arrow's column only while it points (C-84); news has the row, the
	-- arrow still pointing, and the distance is back after Okay (C-88).
	b.navState = NavState(b.nav)
	b.pointing = b.navState == 2
	-- The news has the row only while the row shows it: a connection state over
	-- it keeps the distance and the reason (C-110).
	local newsRow = news and not v.connHeader
	b.rowDist = b.navState > 0 and (v.compass or not newsRow)
	b.arrowZone:SetShown(b.pointing)
	if v.compass then return RenderCompass(v, b) end
	local height = (b.pointing or r) and L.MINI_H or L.MINI_LINE
	local rowY = r and L.MINI_ROW or height / 2
	local x = b.pointing and L.MINI_X or L.MINI_IN
	local right, used = nil, 0
	local function Place(region, inset)
		region:ClearAllPoints()
		if right then
			region:SetPoint("RIGHT", right, "LEFT", -L.CONTROLS, 0)
		else
			region:SetPoint("RIGHT", b, "TOPRIGHT", -inset, -rowY)
		end
		used = used + (right and L.CONTROLS or inset)
		right = region
	end
	-- The news's Okay only while the row shows the news or a line over it that
	-- the Okay ends first, never a connection state over it (E-1).
	-- [C-13, C-19, C-23] Okay also for a warning, a spend state or the spend
	-- line the row shows (H.BarOkay), never on a ghost's row or a closed HUD's.
	local stateRow = (v.warn or v.shortSpend or v.stateOk) and not corpse and not v.routeOnly
	local stuckRow = v.stuck and not newsRow and not corpse and not v.routeOnly -- [DR-07] the row's one action
	if newsRow or stateRow or stuckRow then
		local label = (stuckRow and (v.stuck == "discard" and "Discard" or "Reload")) or (v.header == "pending" and "Send") -- [DR-07]
			or ((L.TIMED[v.header] or stateRow) and "Okay") or (v.okShort or "Okay")
		b.okBtn:SetText(label)
		b.okBtn:SetWidth((label == "Okay" or label == "Send" or label == "Reload" or label == "Discard") and 52 or L.FOLLOW_SHORT_W)
		Place(b.okBtn, L.MINI_IN)
		b.okBtn:Show()
		used = used + (b.okBtn:GetWidth() or 52)
	else
		b.okBtn:Hide()
	end
	if b.rowDist then
		Place(b.dist, L.MINI_IN)
		Distance(b.dist, nil, b.arrow, b.nav, false)
		used = used + (b.dist:IsShown() and (b.dist:GetStringWidth() or 40) or 0)
	else
		b.dist:Hide()
		if b.pointing then PointArrow(b.arrow, b.nav) else b.arrow:Hide() end
	end
	-- A stop the arrow can't point to says why where its distance goes, in
	-- grey ("off the map" in an instance, another continent); a
	-- ghost's row says it already.
	local why = r and not newsRow and b.navState == 0 and r.where
	if why then
		b.why:SetText(ns.Escape(why))
		Place(b.why, L.MINI_IN)
		b.why:Show()
		used = used + (b.why:GetStringWidth() or 60)
	else
		b.why:Hide()
	end
	-- The row's words: where the arrow points while Bones is idle, else his
	-- state (what he says, his work, a ding); a ghost's, "Your corpse".
	-- No n/n here: the route's bar under the row shows where you are (maintainer:
	-- "not important when we already have the progress bar visible"); a
	-- re-plan asked says so in the row, as the panel's heading does.
	local target, quest
	if r and not v.live and not v.shortSpend then -- [C-19] the spend line's words over the route's
		if v.replanning then target = "Re-planning…" else target, quest = MiniTarget(r) end
	end
	-- [C-10, C-19] The spend line in its own colour (gold, or red when you must act); a state or an error in theirs.
	Paint(b.status, (v.shortSpend and not corpse and (v.spendColor or L.GOLD)) or v.statusColor or (v.error and L.RED) or (target and (quest and L.GOLD or L.WHITE)) or ((v.live or corpse) and L.WHITE or L.GREY))
	b.status:SetText(corpse and ("Your corpse" .. ((not v.corpse.dist and v.corpse.where) and (": " .. ns.Escape(v.corpse.where)) or ""))
		or target or v.short or v.status or "")
	b.status:ClearAllPoints()
	b.status:SetPoint("LEFT", b, "TOPLEFT", x, -rowY)
	if right then
		b.status:SetPoint("RIGHT", right, "LEFT", -L.CONTROLS, 0)
	else
		b.status:SetPoint("RIGHT", b, "TOPRIGHT", -L.MINI_IN, -rowY)
	end
	b.status:Show()
	-- His words need room: with less than about 12 characters' worth, the line
	-- says "Bones says" in gold; the tooltip has them.
	if v.says and not corpse and (L.MINI_W - x - used - L.CONTROLS) < 12 * 6.5 then
		b.status:SetText(v.status or "")
		Paint(b.status, L.GOLD)
	end
	-- The route's bar under the row, from where the words start.
	if r then
		DrawSegments(b, b.segs, b.segEdge, r, L.MINI_BAR, true, x, L.MINI_W - x - L.MINI_IN)
	else
		HideSegments(b.segs, b.segEdge)
	end
	b:SetSize(L.MINI_W, height)
end

-- How solid the HUD is: your setting (60–100 %), never the pointer.
local function Fade()
	local a = math.max(60, math.min(100, tonumber(S().hudAlpha) or 100)) / 100
	h.frame:SetAlpha(a)
	h.bar:SetAlpha(a)
end

function H.Render()
	if not ns.db then return end
	if not H.Active() then
		showFull = nil -- closed or off: a Show More from before isn't kept
		if h.frame then h.frame:Hide() end
		-- Closed or off, a route you follow (or your corpse) keeps its bar, or
		-- the compass if that's your form: only the way there, never Bones's
		-- news (a toast then), and its menu brings the HUD back (maintainer: "no way
		-- to expand this").
		local shared = ns.MapShared
		if shared and (shared.navView or shared.corpseView) then
			if not h.frame then Build() end
			local s, v = S(), H.View()
			v.routeOnly, v.bar, v.compass = true, true, s.hudMin == true and s.hudCompass == true
			v.mode, v.live, v.error, v.says, v.short, v.tip = "idle", false, false, nil, nil, ""
			-- No Bones states on a closed HUD's route bar (maintainer), the public build's either.
			v.warn, v.shortSpend, v.stateOk, v.statusColor, v.spendColor, v.detail, v.stuck = nil, nil, nil, nil, nil, nil, nil
			h.view = v
			AnchorBar(ns.UI.MiniFrame and ns.UI.MiniFrame() ~= nil and ns.UI.MiniStandsIn() and not s.hudPoint)
			RenderBar(v)
			h.bar:Show()
			Fade()
		elseif h.bar then
			h.bar:Hide()
		end
		return
	end
	if not h.frame then Build() end
	local v = H.View()
	h.view = v
	AnchorBar(false)
	Header(v) -- the panel's texts stay current under the one line
	if v.bar then
		h.frame:Hide()
		RenderBar(v)
		h.bar:Show()
	else
		h.bar:Hide()
		local key = LayoutKey(v)
		if key ~= h.layoutKey then
			h.layoutKey = key
			Layout(v)
		end
		h.frame:Show()
	end
	Fade()
end

function H.Refresh() H.Render() end

-- The box, for a chat: the one given, the news's, the one you were last told
-- about, or the open one. Words typed for another chat don't go to this one.
function H.OpenReply(chat)
	if not h.replyBox then return end
	local _, c = CurrentNews()
	c = chat or c or (ns.db.lastPing and ns.Chats.Find(ns.db.lastPing)) or ns.Chats.Active()
	if not c then return end
	if h.replyBox.chatId ~= c.id then h.replyBox:SetText("") end
	h.replyBox.chatId = c.id
	local quick = FoundQuick()
	h.replyHint:SetText(quick and c.id == quick.id and ns.P("Ask anything: Enter sends, Esc closes") or ns.Fill("Reply in {chat}", { chat = ns.Escape(c.name) })) -- [UX-5]
	h.replyHint:SetShown((h.replyBox:GetText() or "") == "")
	h.replyBox:Show()
	H.Render()
	h.replyBox:SetFocus()
end

-- The Ask box's words, kept for the next login (Build puts them back).
ns.On("PLAYER_LOGOUT", function()
	local box = h.replyBox
	local text = box and box:GetText() or ""
	if not ns.db then return end
	ns.db.askDraft = (ns.Trim(text) ~= "" and box.chatId and not ns.Chats.KeyShaped(text)) and { chat = box.chatId, text = text } or nil
end)

-- The box's words go to its chat (Enter); the box goes away unless they
-- didn't go.
function H.SubmitAsk()
	local box = h.replyBox
	if not box then return end
	local text = ns.Trim(box:GetText() or "")
	local target = box.chatId and ns.Chats.Find(box.chatId)
	if text ~= "" and target then
		if ns.UI.RunTyped and text:sub(1, 1) == "/" then
			ns.UI.RunTyped(text)
		else
			-- [both:B B-2] (KY-10) An API key goes from the box at once; other words stay when they didn't go.
			local key, refused = SendTo(target.id, text)
			if not key and refused ~= "key" then return end -- the words stay; the status line says it didn't go
		end
	end
	box:SetText("")
	box:ClearFocus()
	box:Hide()
	H.Render()
end

-- Ask: the box for your Quick questions chat; open, the button is its X and
-- puts it away, your words kept for next time (maintainer). Enter sends.
function H.ToggleAsk()
	local box = h.replyBox
	if box and box:IsShown() then
		box:ClearFocus()
		box:Hide()
		H.Render()
		return
	end
	H.OpenReply(QuickChat())
end

-- Every 0.1 s.
function H.Tick()
	local shown = (h.frame and h.frame:IsShown()) or (h.bar and h.bar:IsShown())
	if not shown then return end
	local now = GetTime()
	local v = h.view
	local due = (flash and now > flash.untilT) or (moment and now > moment.untilT)
		or (ding and now > ding.untilT) or (quip and now > quip.untilT)
		or (replanning and now - replanning.at > L.REPLAN_FOR)
	if due then H.Render() end
	if v and (v.route or v.corpse) then H.TickRoute() end
end

-- The arrow, the distance and which way, in whichever of the two is shown.
function H.TickRoute()
	local shared = ns.MapShared
	local corpse = shared and shared.corpseView
	local v = corpse or (shared and shared.navView)
	if not v then return end
	-- The arrow found (or lost) somewhere to point since the HUD was laid out
	-- (into an instance, out of one): lay it out again (C-85, C-90).
	local state = NavState(v)
	if h.frame and h.frame:IsShown() and h.navState then
		if state ~= h.navState then return H.Render() end
		Distance(h.dist, h.distMeta, h.arrow, v, true)
	end
	local b = h.bar
	if b and b:IsShown() and b.nav then
		if state ~= b.navState then return H.Render() end
		if b.rowDist then Distance(b.dist, nil, b.arrow, v, false) elseif b.pointing then PointArrow(b.arrow, v) end
		if b.compass then FitCompass(b) end
	end
end

---------------------------------------------------------------------------
-- News, asks, the welcome, dings, finished routes and quips
---------------------------------------------------------------------------

-- A reply or error was delivered (Notify): it's the news until read. A box
-- you're typing in stays, aimed where it was. A reply to a re-plan ends the wait.
function H.OnNews(note)
	if not note or not note.chat then return end
	-- What a reply drew waits for its Okay, though newer news covers it.
	news = { chat = note.chat, t = GetTime(), kind = note.kind, drew = note.drew or (news and news.drew) }
	if replanning and replanning.chat == note.chat then replanning = nil end
	H.Render()
end

-- You asked something (from here, a chip, a key binding, the map or the quest
-- log): the HUD follows that chat, and older news gives way.
function H.Asked(chatId)
	asked = { chat = chatId, t = GetTime() }
	news = nil
	H.Render()
end

-- [G2] The setup block's Say Hi: "hi" to the HUD's chat (your Quick
-- questions), marked as the first meeting; the HUD follows it.
function H.SayHi()
	local rows = ns.UI.SetupRows and ns.UI.SetupRows()
	if not (rows and rows.ready) then return end
	local chat = ns.QuickChat() or ns.Chats.Active()
	if chat and ns.Chats.Send("hi", chat.id, { intro = true }) then H.Asked(chat.id) end
end
-- [C-137] Copy and Paste with no app answering yet: the first run's Welcome instead of the setup rows.
function H.PasteWelcome()
	return ns.Paste ~= nil and ns.Paste.On() and not ns.db.linked
end
-- [G1] Its Okay: away for this UI session (a /reload or the next login brings it back).
function H.SetupOkay()
	R.setupOkay = true
	H.Render()
end

-- A route you followed to its end: a moment in gold.
-- A place you went out of your way to (Okay on a reply's pin, while on a
-- route) reached: back to the route where you left it (Map.Step).
function H.DetourDone(place, route)
	moment = { line = string.format("Reached %s", ns.Escape(H.Unapprox(place or ""))),
		sub = string.format("Back to %s.", ns.Escape(route or "your route")), untilT = GetTime() + L.MOMENT_SECONDS }
	H.Render()
end

function H.RouteDone(title, stops)
	local name = ns.Escape(title or "")
	moment = { line = "Route finished",
		sub = stops and ns.Plural(stops, "1 stop on {title}. Nice work.", "{n} stops on {title}. Nice work.", { title = name })
			or ns.Fill("{title}. Nice work.", { title = name }),
		untilT = GetTime() + L.MOMENT_SECONDS }
	H.Render()
end

L.QUIPS = {
	dead = {
		"That one had it coming. Well, you did.",
		"A tactical nap. The spirit healer is waiting.",
		"Next time, pull one at a time.",
		"Walk it off. As a ghost.",
		"I'm writing this one in the logbook.",
	},
	alive = {
		"Back in one piece. Mostly.",
		"Death is just a long run back.",
		"Welcome back. Your gear missed you.",
	},
}

function H.Quip(kind)
	local s = S()
	if not s or not s.quips then return nil end
	if lastQuipAt and GetTime() - lastQuipAt < L.QUIP_GAP then return nil end
	local list = L.QUIPS[kind]
	if not list then return nil end
	lastQuipAt = GetTime()
	quip = { text = list[math.random(1, #list)], untilT = GetTime() + L.QUIP_SECONDS }
	H.Render()
	return quip.text
end

ns.On("PLAYER_DEAD", function() H.Quip("dead") end)
ns.On("PLAYER_UNGHOST", function() H.Quip("alive") end)
ns.On("PLAYER_LEVEL_UP", function(_, level)
	level = tonumber(level)
	if not level then return end
	ding = { level = level, untilT = GetTime() + L.DING_SECONDS }
	H.Render()
end)
ns.On("PLAYER_LOGIN", function()
	Build()
	H.Render()
end)
-- The layout loaded, or Edit Mode moved the tracker: dock beside it again.
for _, e in ipairs({ "PLAYER_ENTERING_WORLD", "EDIT_MODE_LAYOUTS_UPDATED" }) do
	ns.On(e, function() if h.frame then PlaceFrame() end end)
end
-- Combat folds it to one line, and back; a send still waiting is taken back
-- (ask again after the fight), but only when the fold hides its Undo: with the
-- panel held up (Show More, the box you're typing in) it stays yours (C-105).
ns.On("PLAYER_REGEN_DISABLED", function()
	if h.frame then H.Render() end
	if pending and not (h.frame and h.frame:IsShown()) then
		pending = nil
		H.Flash("Ask taken back", "You went into combat: ask again after the fight.", nil, "warn")
	end
end)
for _, e in ipairs({ "PLAYER_REGEN_ENABLED", "ZONE_CHANGED_NEW_AREA" }) do
	ns.On(e, function() if h.frame then H.Render() end end)
end
-- The objectives' counts: redraw now and then while a route shows.
ns.On("QUEST_LOG_UPDATE", function()
	if h.frame and h.frame:IsShown() and h.view and h.view.route and (not h.lastQuestDraw or GetTime() - h.lastQuestDraw > 1) then
		h.lastQuestDraw = GetTime()
		h.layoutKey = nil
		H.Render()
	end
end)
