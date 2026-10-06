'use strict';
// A fengari VM running the real NeverQuestAlone addon (addon/NeverQuestAlone, every file in its
// TOC order) on upstream's WoW stub (tests/wow_stub.lua), plus:
//   - the Forever APIs the stub lacks (SOUNDKIT, FlashClientIcon, EventRegistry,
//     DEFAULT_CHAT_FRAME, combat lockdown, ...), as build 70009 has them;
//   - a timer queue that honours delays: STUB.Advance(seconds) runs every
//     C_Timer.After callback and ticker that falls due, in time order;
//   - traps for everything NeverQuestAlone must never call (SendChatMessage, RunScript,
//     loadstring, ...): each call is recorded in STUB.forbidden and raises.
// The addon's private table is passed in as NS, so tests can read its state;
// in the game nothing of it is global (PRD TB5).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('node:assert/strict');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = require('fengari');

const ROOT = path.join(__dirname, '..', '..');
const ADDON = path.join(ROOT, 'addon', 'NeverQuestAlone');
const SIG = 'Interface\\AddOns\\NeverQuestAlone\\sig\\';
const CELLS_PER_ROW = 200;

// A Lua string literal holding exactly these UTF-8 bytes (control and high
// bytes as \ddd), so tests can pass any text into the VM.
function lstr(s) {
  const bytes = Buffer.from(String(s), 'utf8');
  let out = '"';
  for (const b of bytes) {
    if (b === 0x22 || b === 0x5c) out += '\\' + String.fromCharCode(b);
    else if (b < 0x20 || b >= 0x7f) out += '\\' + String(b).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

function tocFiles() {
  const toc = fs.readFileSync(path.join(ADDON, 'NeverQuestAlone.toc'), 'utf8');
  return toc.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#') && l.endsWith('.lua'));
}

// Frame methods the upstream stub lacks. Appended to its chunk, so they can
// reach its local Methods table and NewObject.
const STUB_METHODS = `
-- date("*t", t) as the game's (Lua 5.1's os.date) gives it: a table. The stub's date gives "12:00" for every format, so the table says 12:00 too.
do
	local stubDate = date
	function date(fmt, t)
		if fmt == "*t" then return { year = 2026, month = 9, day = 26, hour = 12, min = 0, sec = 0, wday = 7, yday = 269, isdst = false } end
		return stubDate(fmt, t)
	end
end
function Methods.SetScale(self, s) self.scale = s end
function Methods.GetScale(self) return self.scale or 1 end
function Methods.SetTextColor(self, r, g, b) self.textColor = { r, g, b } end
function Methods.SetVertexColor(self, r, g, b, a) self.vcolor = { r, g, b, a } end
function Methods.SetRotation(self, r) self.rotation = r end
function Methods.SetAllPoints(self, rel) if type(rel) == "table" then self.width, self.height = rel.width, rel.height end end
function Methods.GetFrameLevel(self) return self.level or 1 end
function Methods.SetFrameLevel(self, l) self.level = l end
function Methods.CreateLine(self, name) local l = NewObject("Line", name, self); table.insert(self.textures, l); return l end
function Methods.GetVerticalScroll(self) return self.vscroll or 0 end
function Methods.SetVerticalScroll(self, v) self.vscroll = v end
function Methods.HighlightText(self) self.highlighted = true end
function Methods.SetFontObject(self, f) self.font = f end
function Methods.SetMaxLines(self, n) self.maxLines = n end
function Methods.SetFrameStrata(self, s) self.strata = s end
function Methods.SetDontSavePosition(self, v) self.dontSavePosition = v end
function Methods.SetUserPlaced(self, v) self.userPlaced = v end
function Methods.StartMoving(self) self.moving = true end
function Methods.StartSizing(self, point) self.sizing = point end
-- As the engine does, a move or a resize ends with the frame re-anchored,
-- here by its centre on UIParent (the engine picks a point by where it is),
-- so code that keeps one anchor of its own has to set it again (the audit's
-- mutation check: KeepPlace after the grip went untested).
function Methods.StopMovingOrSizing(self)
	self.moving, self.sizing = nil, nil
	local l, r = self.GetLeft and self:GetLeft(), self.GetRight and self:GetRight()
	local t, b = self.GetTop and self:GetTop(), self.GetBottom and self:GetBottom()
	if type(l) == "number" and type(r) == "number" and type(t) == "number" and type(b) == "number" then
		self:ClearAllPoints()
		self:SetPoint("CENTER", UIParent, "BOTTOMLEFT", (l + r) / 2, (t + b) / 2)
	end
end
function Methods.SetHitRectInsets(self, l, r, t, b) self.hitInsets = { l, r, t, b } end
function Methods.GetFrameStrata(self) return self.strata or "MEDIUM" end
-- For the UI preview (tests/render_ui.js): every anchor point, the font and
-- layer a region was made with, atlases, crops and justification. With
-- STUB.metrics on, strings measure themselves roughly as the game's fonts do;
-- off (the default), they keep the fixed 14 and 100 the tests expect.
local StubSetPoint = Methods.SetPoint
function Methods.SetPoint(self, point, rel, relPoint, x, y)
	StubSetPoint(self, point, rel, relPoint, x, y)
	if type(rel) == "number" then x, y, rel, relPoint = rel, relPoint, nil, nil end
	self.points = self.points or {}
	self.points[point] = { rel = rel, relPoint = relPoint or point, x = x or 0, y = y or 0 }
end
function Methods.ClearAllPoints(self) self.points = {} end
local StubSetAllPoints = Methods.SetAllPoints
function Methods.SetAllPoints(self, rel)
	StubSetAllPoints(self, rel)
	self.points = { TOPLEFT = { rel = rel, relPoint = "TOPLEFT", x = 0, y = 0 }, BOTTOMRIGHT = { rel = rel, relPoint = "BOTTOMRIGHT", x = 0, y = 0 } }
end
function Methods.CreateFontString(self, name, layer, font)
	local o = NewObject("FontString", name, self)
	o.layer, o.font = layer, font
	return o
end
function Methods.CreateTexture(self, name, layer, template, sublevel)
	local t = NewObject("Texture", name, self)
	table.insert(self.textures, t)
	t.layer, t.sublevel = layer, sublevel
	return t
end
function Methods.SetAtlas(self, atlas) self.atlas = atlas end
function Methods.SetTexCoord(self, ...) self.texCoord = { ... } end
function Methods.SetJustifyH(self, j) self.justifyH = j end
function Methods.SetWordWrap(self, w) self.wordWrap = w end
function Methods.SetPortraitTextureRaw(self, t) self.portraitTexture = t end
function Methods.SetPortraitTextureSizeAndOffset(self, size, x, y) self.portraitSize = { size, x, y } end
function Methods.SetNormalTexture(self, t) if type(t) == "string" then self.normalArt = t end end
function Methods.SetChecked(self, on) self.checked = on and true or false end
function Methods.GetChecked(self) return self.checked == true end
function Methods.Disable(self) self.disabled = true end
function Methods.Enable(self) self.disabled = false end
function Methods.SetEnabled(self, on) self.disabled = not on end
function Methods.IsEnabled(self) return not self.disabled end
function Methods.SetNormalAtlas(self, a) if type(a) == "string" then self.normalArt = a end end
local FONT_SIZE = { GameFontNormal = 12, GameFontHighlight = 12, GameFontDisable = 12, GameFontNormalSmall = 10,
	GameFontHighlightSmall = 10, GameFontDisableSmall = 10, GameFontNormalLarge = 16, GameFontHighlightLarge = 16,
	ChatFontNormal = 14, NQAHUDFontV = 14, GameFontNormalMed2 = 14 }
function Methods.SetFont(self, file, size) self.fontSize = size end
function STUB.FontSize(o)
	if o.fontSize then return o.fontSize end
	local f = o.font
	if type(f) == "table" then f = f.name end
	-- A font the addon made (CreateFont, then SetFont at a size).
	local made = type(f) == "string" and rawget(_G, f)
	if type(made) == "table" and type(made.size) == "number" then return made.size end
	return FONT_SIZE[f or ""] or 12
end
local function Plain(t)
	t = tostring(t or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|c[^|]-:", ""):gsub("|r", ""):gsub("|T.-|t", "  "):gsub("|A.-|a", "  ") -- an atlas (the setup rows' marks) is an icon, not its name
	t = t:gsub("|H.-|h", ""):gsub("|h", "") -- a link shows its [name]
	return (t:gsub("\\226\\128[\\166\\162\\147\\148]", "."))
end
function STUB.TextWidth(text, size) return #Plain(text) * size * 0.52 end
local StubStringWidth, StubStringHeight = Methods.GetStringWidth, Methods.GetStringHeight
function Methods.GetStringWidth(self)
	if not STUB.metrics then return StubStringWidth(self) end
	local w = 0
	for line in (tostring(self.text or "") .. "\\n"):gmatch("(.-)\\n") do w = math.max(w, STUB.TextWidth(line, STUB.FontSize(self))) end
	return w
end
function Methods.GetStringHeight(self)
	if not STUB.metrics then return StubStringHeight(self) end
	local size = STUB.FontSize(self)
	if not self.text or self.text == "" then return 0 end
	local lines = 0
	for para in (tostring(self.text) .. "\\n"):gmatch("(.-)\\n") do
		local n, lineW = 1, 0
		if self.width and self.wordWrap ~= false then
			for word in Plain(para):gmatch("%S+") do
				local ww = STUB.TextWidth(word .. " ", size)
				if lineW > 0 and lineW + ww > self.width then n, lineW = n + 1, ww else lineW = lineW + ww end
			end
		end
		lines = lines + n
	end
	if self.maxLines and self.maxLines > 0 then lines = math.min(lines, self.maxLines) end
	return lines * math.floor(size * 1.2 + 0.5)
end
-- The frame tree under a region, for the preview renderer: ids for anchors.
function STUB.Dump(root)
	local ids, n = {}, 0
	STUB.dumped = {} -- id -> region, so the preview can hand back the sizes it laid out
	local function id(o)
		if type(o) ~= "table" then return tostring(o) end
		if not ids[o] then n = n + 1; ids[o] = n; STUB.dumped[n] = o end
		return ids[o]
	end
	local seen = {}
	local function walk(o)
		if seen[o] then return { id = id(o), kind = o.kind, points = {}, children = {}, shown = false } end
		seen[o] = true
		local node = { id = id(o), kind = o.kind, name = o.name, shown = o.shown, alpha = o.alpha, w = o.width, h = o.height, vscroll = o.vscroll,
			text = (type(o.text) == "string" or type(o.text) == "number") and o.text or nil, -- a frame's .text can be its FontString
			font = (type(o.font) == "table" and o.font.name) or (type(o.font) == "string" and o.font) or nil, fontSize = o.kind == "FontString" and STUB.FontSize(o) or nil,
			textColor = o.textColor, color = o.color, vcolor = o.vcolor, texture = o.texture, atlas = o.atlas, rotation = o.rotation,
			maxLines = o.maxLines, justifyH = o.justifyH, layer = o.layer, sublevel = o.sublevel, level = o.level, template = o.template,
			backdrop = o.backdrop and { edge = o.backdrop.edgeFile, bg = o.backdrop.bgFile } or nil, portrait = o.portraitTexture,
			texCoord = o.texCoord, normalArt = o.normalArt, portraitSize = o.portraitSize, layoutType = o.layoutType,
			checked = o.checked, disabled = o.disabled, wordWrap = o.wordWrap, points = {}, children = {} }
		for p, a in pairs(o.points or {}) do
			node.points[#node.points + 1] = { point = p, rel = a.rel ~= nil and id(a.rel) or nil, relPoint = a.relPoint, x = a.x, y = a.y }
		end
		if o.kind == "FontString" or o.kind == "EditBox" then node.sw, node.sh = Methods.GetStringWidth(o), Methods.GetStringHeight(o) end
		for _, c in ipairs(o.children or {}) do node.children[#node.children + 1] = walk(c) end
		return node
	end
	return walk(root)
end
`;

const EXTRA = `
-- Lua 5.1 (the game) is stricter than 5.3 (this VM) about string.format: %s
-- takes only a string or a number (5.3 prints nil and booleans), and the
-- numeric conversions only numbers.
do
	local realFormat = string.format
	local function Check(fmt, ...)
		fmt = tostring(fmt)
		local i, pos = 0, 1
		while true do
			local s = fmt:find("%", pos, true)
			if not s then break end
			if fmt:sub(s + 1, s + 1) == "%" then
				pos = s + 2
			else
				local conv, e = fmt:match("^[%-+ #0]*%d*%.?%d*(%a)()", s + 1)
				if not conv then break end
				i = i + 1
				local v = select(i, ...)
				local t = type(v)
				if conv == "s" or conv == "q" then
					if t ~= "string" and t ~= "number" then error("bad argument #" .. (i + 1) .. " to 'format' (string expected, got " .. t .. ")", 3) end
				elseif t ~= "number" and not (t == "string" and tonumber(v)) then
					error("bad argument #" .. (i + 1) .. " to 'format' (number expected, got " .. t .. ")", 3)
				end
				pos = e
			end
		end
	end
	string.format = function(fmt, ...)
		Check(fmt, ...)
		return realFormat(fmt, ...)
	end
end

-- Secret values, as build 70009 has them (issecretvalue in
-- FrameScriptDocumentation.lua). STUB.Secret(v) makes one: type() gives v's own
-- type, as the game's does, and indexing it (s:gsub), joining it, its length,
-- ordering, arithmetic, tostring and calling it raise, as an addon's do in the
-- game (joins and tostring only make another secret there; raising is
-- stricter). Lua 5.3 compares a table with a string or nil without asking its
-- metatable, so s == "" can't raise here as it does in the game.
do
	local secrets = setmetatable({}, { __mode = "k" })
	local function Refuse(what) return function() error("attempt to " .. what .. " a secret value", 2) end end
	local mt = { __index = Refuse("index"), __newindex = Refuse("index"), __concat = Refuse("concatenate"), __len = Refuse("get the length of"),
		__eq = Refuse("compare"), __lt = Refuse("compare"), __le = Refuse("compare"), __call = Refuse("call"), __tostring = Refuse("convert"),
		__add = Refuse("do arithmetic on"), __sub = Refuse("do arithmetic on"), __mul = Refuse("do arithmetic on"), __div = Refuse("do arithmetic on"),
		__mod = Refuse("do arithmetic on"), __pow = Refuse("do arithmetic on"), __unm = Refuse("do arithmetic on") }
	function STUB.Secret(v)
		local s = setmetatable({}, mt)
		secrets[s] = type(v)
		return s
	end
	function issecretvalue(v) return secrets[v] ~= nil end
	local realType = type
	function type(v) return secrets[v] or realType(v) end
end

-- As on build 70009 (E-020): UnitName returns a second value, a string, even
-- for your own character. Code that passes UnitName(...) straight into another
-- call gets it as an extra argument. STUB.names[unit] names another unit (a
-- target); a unit in STUB.secretNames gets secrets, as an NPC's name is in a
-- fight (UnitName is SecretWhenUnitNameIdentityRestricted).
STUB.names, STUB.secretNames = {}, {}
do
	local realUnitName = UnitName
	function UnitName(unit)
		local n = realUnitName(unit) or STUB.names[unit]
		if not n then return nil end
		if STUB.secretNames[unit] then return STUB.Secret(n), STUB.Secret("") end
		return n, ""
	end
end

STUB.chat, STUB.played, STUB.flashed, STUB.forbidden, STUB.loads = {}, {}, 0, {}, {}
STUB.combat = false
STUB.cvars = { Sound_EnableAllSound = "1", Sound_EnableSFX = "1" }
function InCombatLockdown() return STUB.combat end
SOUNDKIT = { TELL_MESSAGE = 3081, RAID_WARNING = 8959, READY_CHECK = 8960, MAP_PING = 3175, UI_BNET_TOAST = 18019 }
function PlaySound(id) table.insert(STUB.played, id); return true, 1 end
function FlashClientIcon() STUB.flashed = STUB.flashed + 1 end
DEFAULT_CHAT_FRAME = CreateFrame("Frame", "ChatFrame1")
function DEFAULT_CHAT_FRAME:AddMessage(text) table.insert(STUB.chat, tostring(text)) end
RaidWarningFrame = CreateFrame("Frame", "RaidWarningFrame")
function RaidNotice_AddMessage(frame, text) STUB.notice = text end
function GetCVar(name) return STUB.cvars[name] end
function IsShiftKeyDown() return STUB.shift or false end
UIParent.width, UIParent.height = 1382.4, 893.6 -- the screen in UI units, as on the owner's Mac
function GetScreenWidth() return 1382.4 end
function GetScreenHeight() return 893.6 end
function IsMacClient() return true end
function GetBuildInfo() return "1.60.1", "70009", "Sep 1 2026", 16001 end

-- Blizzard's SharedXML EventRegistry, and ItemRef.lua's SetItemRef, which
-- hands "addon:" links to the "SetItemRef" callback without trying a tooltip.
EventRegistry = { callbacks = {} }
function EventRegistry:RegisterCallback(event, fn, owner)
	self.callbacks[event] = self.callbacks[event] or {}
	table.insert(self.callbacks[event], { fn = fn, owner = owner })
end
function EventRegistry:TriggerEvent(event, ...)
	for _, c in ipairs(self.callbacks[event] or {}) do
		if c.owner ~= nil then c.fn(c.owner, ...) else c.fn(...) end
	end
end
function SetItemRef(link, text, button, chatFrame)
	if tostring(link):sub(1, 6) == "addon:" then
		EventRegistry:TriggerEvent("SetItemRef", link, text, button, chatFrame)
		return
	end
	STUB.itemRef = link
end

-- A timer queue that honours delays. Tickers get their handle as the argument.
STUB.queue = {}
C_Timer.After = function(delay, fn) table.insert(STUB.queue, { at = STUB.now + (delay or 0), fn = fn }) end
C_Timer.NewTimer = function(delay, fn)
	local t = { at = STUB.now + (delay or 0), fn = fn }
	t.Cancel = function() t.cancelled = true end
	table.insert(STUB.queue, t)
	return t
end
C_Timer.NewTicker = function(delay, fn, iterations)
	local t = { at = STUB.now + delay, every = delay, fn = fn, left = iterations }
	t.Cancel = function() t.cancelled = true end
	t.IsCancelled = function() return t.cancelled end
	table.insert(STUB.queue, t)
	return t
end
function STUB.Advance(sec)
	local target = STUB.now + (sec or 0)
	while true do
		local best
		for _, t in ipairs(STUB.queue) do
			if not t.cancelled and t.at <= target + 1e-9 and (not best or t.at < best.at) then best = t end
		end
		if not best then break end
		if best.at > STUB.now then STUB.now = best.at end
		if best.every then
			best.at = best.at + best.every
			if best.left then
				best.left = best.left - 1
				if best.left <= 0 then best.cancelled = true end
			end
			best.fn(best)
		else
			best.cancelled = true
			best.fn()
		end
	end
	STUB.now = target
	local keep = {}
	for _, t in ipairs(STUB.queue) do if not t.cancelled then keep[#keep + 1] = t end end
	STUB.queue = keep
end

-- The TOC's metadata as the game read it at its start (STUB.tocVersion; nil: none).
C_AddOns.GetAddOnMetadata = function(name, field)
	if field == "Version" then return STUB.tocVersion end
end

-- Slot addons: every call is counted; STUB.slotReason makes loads fail.
C_AddOns.LoadAddOn = function(name)
	table.insert(STUB.loads, name)
	if STUB.slotReason then return false, STUB.slotReason end
	STUB.loaded[name] = true
	if STUB.onLoadAddOn then STUB.onLoadAddOn(name) end
	return true
end

-- SavedVariables as the client writes them: a Lua table literal.
function STUB.Serialize(v)
	local t = type(v)
	if t == "string" then return string.format("%q", v) end
	if t == "number" then
		if v == math.floor(v) and math.abs(v) < 2^53 then return string.format("%d", v) end
		return string.format("%.17g", v)
	end
	if t == "boolean" then return tostring(v) end
	if t == "table" then
		local parts = {}
		for k, x in pairs(v) do
			local xs = STUB.Serialize(x)
			if xs then parts[#parts + 1] = "[" .. STUB.Serialize(k) .. "] = " .. xs end
		end
		return "{ " .. table.concat(parts, ", ") .. " }"
	end
	return nil
end
`;

// C_EncodingUtil's deflate and base64 calls as build 70009 documents them
// (EncodingUtilDocumentation.lua at wow-ui-source bd2470a), done by Node's zlib:
// CompressString(source[, method[, level]]) and DecompressString(source[, method])
// with Enum.CompressionMethod Deflate 0 (raw deflate), Zlib 1, Gzip 2 and
// Enum.CompressionLevel Default 0, OptimizeForSpeed 1, OptimizeForSize 2;
// EncodeBase64/DecodeBase64(source[, variant]), Standard 0 or StandardUrlSafe 1.
// A bad argument raises; input that doesn't inflate returns nothing (the docs'
// MayReturnNothing). Tests replace or remove them in Lua.
const DEFLATE = [zlib.deflateRawSync, zlib.deflateSync, zlib.gzipSync];
const INFLATE = [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync];
const LEVELS = [{}, { level: 1 }, { level: 9 }];
function installEncodingUtil(L) {
  const src = (L1, i) => Buffer.from(lauxlib.luaL_checklstring(L1, i));
  const opt = (L1, i, n) => {
    const v = lauxlib.luaL_optinteger(L1, i, 0);
    if (v < 0 || v >= n) lauxlib.luaL_argerror(L1, i, to_luastring('invalid enum value'));
    return v;
  };
  const push = (L1, buf) => { const u = Uint8Array.from(buf); lua.lua_pushlstring(L1, u, u.length); return 1; };
  const fns = {
    CompressString: L1 => push(L1, DEFLATE[opt(L1, 2, 3)](src(L1, 1), LEVELS[opt(L1, 3, 3)])),
    DecompressString: L1 => {
      const input = src(L1, 1);
      const inflate = INFLATE[opt(L1, 2, 3)];
      let out;
      try { out = inflate(input); } catch { return 0; }
      return push(L1, out);
    },
    EncodeBase64: L1 => {
      const input = src(L1, 1);
      const b64 = input.toString('base64');
      return push(L1, Buffer.from(opt(L1, 2, 2) === 1 ? b64.replace(/\+/g, '-').replace(/\//g, '_') : b64));
    },
    DecodeBase64: L1 => { const input = src(L1, 1); opt(L1, 2, 2); return push(L1, Buffer.from(input.toString('latin1'), 'base64')); },
  };
  lua.lua_createtable(L, 0, 4);
  for (const [name, fn] of Object.entries(fns)) {
    lua.lua_pushjsfunction(L, fn);
    lua.lua_setfield(L, -2, to_luastring(name));
  }
  lua.lua_setglobal(L, to_luastring('C_EncodingUtil'));
}
const ENUMS = `
Enum = Enum or {}
Enum.CompressionMethod = { Deflate = 0, Zlib = 1, Gzip = 2 }
Enum.CompressionLevel = { Default = 0, OptimizeForSpeed = 1, OptimizeForSize = 2 }
Enum.Base64Variant = { Standard = 0, StandardUrlSafe = 1 }
`;

// Installed after the addon's files have loaded: anything that could reach
// another player or run code records itself and raises.
const TRAPS = `
local function Trap(name)
	return function()
		table.insert(STUB.forbidden, name)
		error("NeverQuestAlone must never call " .. name, 2)
	end
end
SendChatMessage = Trap("SendChatMessage")
C_ChatInfo = { SendAddonMessage = Trap("C_ChatInfo.SendAddonMessage"), SendChatMessage = Trap("C_ChatInfo.SendChatMessage") }
BNSendWhisper = Trap("BNSendWhisper")
SendMail = Trap("SendMail")
RunScript = Trap("RunScript")
RunMacroText = Trap("RunMacroText")
loadstring = Trap("loadstring")
load = Trap("load")
dofile = Trap("dofile")
loadfile = Trap("loadfile")
`;

function newVM(opts = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const check = (status, what) => {
    if (status !== lua.LUA_OK) {
      const msg = to_jsstring(lua.lua_tostring(L, -1));
      lua.lua_pop(L, 1);
      throw new Error(`${what}: ${msg}`);
    }
  };
  const run = (code, name = 'test') => {
    check(lauxlib.luaL_loadbuffer(L, to_luastring(code), null, to_luastring('=' + name)), 'Lua load');
    check(lua.lua_pcall(L, 0, 0, 0), 'Lua error');
  };
  // Load one addon file the way the client does: (addonName, addonTable).
  const loadFile = (src, name) => {
    check(lauxlib.luaL_loadbuffer(L, to_luastring(src), null, to_luastring('@NeverQuestAlone/' + name)), 'Lua load ' + name);
    lua.lua_pushstring(L, to_luastring('NeverQuestAlone'));
    lua.lua_getglobal(L, to_luastring('NS'));
    check(lua.lua_pcall(L, 2, 0, 0), 'Lua error in ' + name);
  };
  const toJS = (idx, depth = 0) => {
    const t = lua.lua_type(L, idx);
    if (t === lua.LUA_TNIL) return null;
    if (t === lua.LUA_TBOOLEAN) return lua.lua_toboolean(L, idx);
    if (t === lua.LUA_TNUMBER) return lua.lua_tonumber(L, idx);
    if (t === lua.LUA_TSTRING) return to_jsstring(lua.lua_tostring(L, idx));
    if (t === lua.LUA_TTABLE) {
      if (depth > 60) return '<deep>'; // deep enough for a frame tree (STUB.Dump), and no cycle runs away
      if (!lua.lua_checkstack(L, 4)) return '<deep>'; // each level holds a key and a value
      const abs = lua.lua_absindex(L, idx);
      const entries = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, abs) !== 0) {
        entries.push([toJS(-2, depth + 1), toJS(-1, depth + 1)]);
        lua.lua_pop(L, 1);
      }
      const isArray = entries.length > 0 && entries.every(([k]) => typeof k === 'number')
        && entries.map(([k]) => k).sort((a, b) => a - b).every((k, i) => k === i + 1);
      if (isArray) return entries.sort((a, b) => a[0] - b[0]).map(([, v]) => v);
      return Object.fromEntries(entries.map(([k, v]) => [String(k), v]));
    }
    return `<${to_jsstring(lua.lua_typename(L, t))}>`;
  };
  const evaluate = (expr) => {
    run(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`, 'evaluate');
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const s = lua.lua_isnil(L, -1) ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  const json = (expr) => {
    run(`RESULT = (${expr})`, 'json');
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const v = toJS(-1);
    lua.lua_pop(L, 1);
    return v;
  };
  const num = (expr) => Number(evaluate(expr));

  run(fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8') + STUB_METHODS, 'wow_stub');
  run(EXTRA, 'extra');
  // The client's deflate and base64 (70009 has them; opts.encoding false leaves them out).
  if (opts.encoding !== false) {
    installEncodingUtil(L);
    run(ENUMS, 'enums');
  }
  run('math.randomseed(' + (opts.seed || 7) + ')');
  if (opts.now) run(`STUB.now = ${opts.now}`);
  // present.wav and the doorbells exist when the UI loads (setup makes them, PROTOCOL §3).
  if (opts.signals !== false) {
    for (const f of ['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act']) run(`STUB.sounds[${JSON.stringify(SIG + 'ctl\\' + f + '.wav')}] = true`);
  }
  if (opts.sounds) run(`for k, v in pairs(${opts.sounds}) do STUB.sounds[k] = v end`);
  if (opts.extra) run(opts.extra, 'opts.extra');
  if (opts.db) run(opts.db, 'saved variables');
  // An install the app (or the bridge) has answered: what every transport test
  // is about. opts.linked false is a fresh store install with no app yet, where
  // messages go by Copy and Paste (Paste.lua, docs/ADDON-FIRST.md).
  if (opts.linked !== false) run('NQADB = NQADB or {}; if NQADB.linked == nil then NQADB.linked = true end', 'linked');
  run('NS = {}');
  // opts.skip: files the client didn't load (a /reload runs the TOC's old list:
  // a file new in an update loads only after a full restart).
  for (const f of tocFiles().filter(f => !(opts.skip || []).includes(f))) {
    let src = fs.readFileSync(path.join(ADDON, f), 'utf8');
    if (f === 'Inbox.lua' && opts.inbox) src = opts.inbox; // what the bridge wrote there
    loadFile(src, f);
  }
  run(TRAPS, 'traps');
  if (opts.before) run(opts.before, 'opts.before');

  const vm = {
    L, run, evaluate, json, num,
    bool: (expr) => evaluate(`(${expr}) and true or false`) === 'true',
    login() {
      run('STUB.FireEvent("ADDON_LOADED", "NeverQuestAlone"); STUB.FireEvent("PLAYER_LOGIN")');
      return vm;
    },
    advance(sec) { run(`STUB.Advance(${sec})`); return vm; },
    // A signal file exists (created by the bridge), or not.
    signal(family, name, on = true) {
      run(`STUB.sounds[${JSON.stringify(SIG + family + '\\' + name + '.wav')}] = ${on ? 'true' : 'nil'}`);
      return vm;
    },
    // Every following slot load reads this Lua (a statement that assigns NQA_SlotData).
    slotText(text) { run(`STUB.onLoadAddOn = function(name)\n${text}\nend`); return vm; },
    slot(tableExpr) { return vm.slotText(`NQA_SlotData = ${tableExpr}`); },
    loads: () => num('#STUB.loads'),
    slash: (text) => run(`SlashCmdList.BONES(${lstr(text)})`),
    // Words to the chat you're in, as the window's box sends them (with the
    // window closed, /nqa <text> goes to Quick questions instead).
    send: (text) => run(`NS.Chats.Send(${lstr(text)})`),
    reply: (text) => run(`SlashCmdList.BONESREPLY(${lstr(text)})`),
    chatLines: () => vm.list('STUB.chat'),
    history: (i = null) => vm.list(i === null ? 'NS.Chats.Active().history' : `NQADB.chats[${i}].history`),
    lastHistory: () => { const h = vm.history(); return h[h.length - 1]; },
    saved: () => evaluate('STUB.Serialize(NQADB)'),
    sounds: () => evaluate('STUB.Serialize(STUB.sounds)'),
    // The strip as the capture app reads it: { frame, payload } or null.
    strip() {
      if (evaluate('NQAStrip ~= nil and NQAStrip.shown') !== 'true') return null;
      run(`
        local parts = {}
        for _, t in ipairs(NQAStrip.textures) do
          if t.shown and t.color then
            local c, r = math.floor(t.x / 4 + 0.5), math.floor(-t.y / 4 + 0.5)
            local v = (t.color[1] >= 0.5 and 4 or 0) + (t.color[2] >= 0.5 and 2 or 0) + (t.color[3] >= 0.5 and 1 or 0)
            parts[#parts + 1] = (r * ${CELLS_PER_ROW} + c) .. ":" .. v
          end
        end
        RESULT = table.concat(parts, ",")`, 'strip');
      const cells = [];
      for (const p of evaluate('RESULT').split(',')) {
        const [i, v] = p.split(':').map(Number);
        cells[i] = v;
      }
      const bytes = [];
      let acc = 0, nbits = 0;
      for (let i = 0; i < cells.length; i++) {
        acc = (acc << 3) | (cells[i] || 0);
        nbits += 3;
        while (nbits >= 8) {
          bytes.push((acc >> (nbits - 8)) & 0xff);
          nbits -= 8;
          acc &= (1 << nbits) - 1;
        }
      }
      assert.equal(bytes[0], 0xc7, 'magic 1');
      assert.equal(bytes[1], 0x2c, 'magic 2 (v2: 0x2C, never upstream\'s 0x1A)');
      const frame = bytes[2] * 256 + bytes[3];
      const len = bytes[4] * 256 + bytes[5];
      let s1 = 0, s2 = 0;
      for (let k = 2; k < 6 + len; k++) { s1 = (s1 + bytes[k]) % 255; s2 = (s2 + s1) % 255; }
      assert.equal(bytes[6 + len], s1, 'fletcher s1');
      assert.equal(bytes[7 + len], s2, 'fletcher s2');
      assert.ok(len <= 3200, `payload ${len} bytes`);
      return { frame, len, payload: Buffer.from(bytes.slice(6, 6 + len)).toString('utf8') };
    },
    stripWires() {
      const s = vm.strip();
      return s ? s.payload.split('\x1e') : [];
    },
    // A Lua table as a JS array ({} when empty comes back as an object).
    list(expr) {
      const v = vm.json(expr);
      return Array.isArray(v) ? v : [];
    },
    outboxWires() {
      return vm.list('NQADB.outbox').map(e => ({ key: e.key, wire: Buffer.from(e.hex, 'hex').toString('utf8') }));
    },
  };
  return vm;
}

// A /reload: SavedVariables and the signal files carry over, the Lua is read
// again (a fresh VM), every slot is free again.
function reloadVM(vm, opts = {}) {
  return newVM({ ...opts, now: vm.num('STUB.now'), db: 'NQADB = ' + vm.saved(), sounds: vm.sounds() });
}

// STUB_METHODS, EXTRA and TRAPS are exported for tests/lua51_runtime_test.mjs, which
// builds the same environment in a real Lua 5.1 runtime (LuaJIT).
module.exports = { newVM, reloadVM, lstr, SIG, ADDON, tocFiles, STUB_METHODS, EXTRA, TRAPS };
