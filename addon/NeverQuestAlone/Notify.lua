-- Notify.lua: tier 1 notifications (NT-1) and combat do-not-disturb (NT-2).
--
-- A reply or error in one of your WoW chats plays the whisper sound, shows a
-- toast (unless that chat is on screen), echoes a line into your own chat
-- frame, flashes the Dock icon and bumps the unread badge. In combat only the
-- badge moves; the rest waits and is delivered within 3 s of the fight ending,
-- collapsed into one line when more than three are waiting.
--
-- The echo is local: DEFAULT_CHAT_FRAME:AddMessage (or print). Nothing here,
-- or anywhere in NeverQuestAlone, sends chat to anyone (§11): no SendChatMessage, no
-- channel API, no RunScript or loadstring.

local _, ns = ...
local N = {}
ns.Notify = N
local R = ns.R

local FLUSH_DELAY = 1 -- after PLAYER_REGEN_ENABLED; well inside the 3 s
local COLLAPSE_OVER = 3
local SHORT_MAX = 200
local SUMMARY_MAX = 160
local FULL_MAX = 4000

-- [open] and [reply] links. With EventRegistry, Blizzard's SetItemRef hands
-- links that start with "addon:" to the "SetItemRef" callback without trying a
-- tooltip; older UI code gets our own prefix and a post-hook.
local HAS_REGISTRY = type(EventRegistry) == "table" and type(EventRegistry.RegisterCallback) == "function"
N.LINK_PREFIX = HAS_REGISTRY and "addon:NeverQuestAlone:" or "nqa:"

local function Link(action, chatId, color, label)
	return "|cff" .. color .. "|H" .. N.LINK_PREFIX .. action .. ":" .. chatId .. "|h[" .. label .. "]|h|r"
end

function N.Links(chatId)
	return Link("open", chatId, "7ec8ff", "Open") .. " " .. Link("reply", chatId, "55ff55", "Reply")
end

local lastLink, lastLinkAt

-- A click on [open] or [reply]: open that chat; reply also focuses the input.
function N.OnLink(link)
	if type(link) ~= "string" or not ns.db then return end
	local action, chatId = link:match("^addon:NeverQuestAlone:(%a+):(c%x%x%x%x%x%x)$")
	if not action then action, chatId = link:match("^nqa:(%a+):(c%x%x%x%x%x%x)$") end
	if action ~= "open" and action ~= "reply" then return end
	-- Both routes below can fire for one click, in the same frame.
	local now = GetTime()
	if link == lastLink and now == lastLinkAt then return end
	lastLink, lastLinkAt = link, now
	if ns.Chats.Find(chatId) and ns.db.activeChat ~= chatId then ns.Chats.Switch(chatId) end
	ns.UI.Toggle(true)
	if action == "reply" then ns.UI.FocusInput() end
end

if HAS_REGISTRY then
	pcall(EventRegistry.RegisterCallback, EventRegistry, "SetItemRef", function(...)
		for i = 1, select("#", ...) do
			local a = select(i, ...)
			if type(a) == "string" and a:find("^addon:NeverQuestAlone:") then
				N.OnLink(a)
				return
			end
		end
	end, N)
end
if type(hooksecurefunc) == "function" and type(SetItemRef) == "function" then
	hooksecurefunc("SetItemRef", function(link)
		if type(link) == "string" then N.OnLink(link) end
	end)
end

---------------------------------------------------------------------------
-- Local output
---------------------------------------------------------------------------

function N.Print(line)
	if type(DEFAULT_CHAT_FRAME) == "table" and type(DEFAULT_CHAT_FRAME.AddMessage) == "function" then
		DEFAULT_CHAT_FRAME:AddMessage(line)
	else
		print(line)
	end
end

-- The one prefix for the addon's own lines, as for Bones's replies: the
-- companion's name (the bridge's, escaped; "Bones" before it says).
function N.Prefix()
	local name = ns.db and ns.Chats and ns.Chats.AgentName() or "NeverQuestAlone"
	return "|cff7ec8ff[" .. name .. "]|r "
end

function N.Local(text)
	N.Print(N.Prefix() .. text)
end

-- A short word where the game says "you can't do that" (UIErrorsFrame): red
-- for what didn't happen, yellow for what did. The chat frame where it's missing.
function N.Game(text, isError)
	local f = type(UIErrorsFrame) == "table" and UIErrorsFrame or nil
	local fn = f and (isError and f.AddExternalErrorMessage or f.AddExternalWarningMessage)
	if type(fn) == "function" and pcall(fn, f, text) then return end
	N.Local(text)
end

-- One line of (escaped) agent text, at most max bytes; the cut never splits a
-- character or leaves half an escape (SafeText doubles a stray |).
local function Flat(s, max)
	local flat = tostring(s or ""):gsub("%s+", " ")
	flat = ns.Trim(flat)
	if #flat > max then flat = ns.SafeText(ns.Utf8Cut(flat, max)) .. " …" end
	return flat
end

local function FirstLine(s, max)
	for line in (tostring(s or "") .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then return Flat(line, max) end
	end
	return ""
end

---------------------------------------------------------------------------
-- The chat echo (RC-8): summary (default), full, short or off
---------------------------------------------------------------------------

-- [PR-1, TH13] The desktop switch (cap echo, bridge.echo): NeverQuestAlone's "Echo replies to the chat frame", off for new installs because
-- chat loggers keep what's there. Off there, nothing goes into the chat frame,
-- whatever /bones echo says here; on, /bones echo applies. Without the cap
-- (an app from before it) only /bones echo decides.
function N.DesktopEchoOff()
	return ns.HasCap("echo") and ns.R.bridge.echo ~= "on"
end

-- The echo mode in force: off while the desktop's is off, else this addon's own.
function N.EchoMode()
	if N.DesktopEchoOff() then return "off" end
	return ns.db.settings.echo
end

function N.EchoLines(note)
	local chat = ns.Chats.Find(note.chat)
	if not chat then return {} end
	local mode = N.EchoMode() -- [PR-1]
	if mode == "off" then return {} end
	local prefix = "|cff7ec8ff[" .. ns.Chats.AgentName(note.agent or chat.agent) .. " · " .. ns.Escape(chat.name) .. "]|r "
	local links = "  " .. N.Links(chat.id)
	local body = note.text or ""
	if note.kind ~= "reply" then
		-- An error in red; automatic help paused itself (the public build's) in the held gold.
		return { prefix .. (note.held and "|cffffd100" or "|cffff7070") .. Flat(body, SHORT_MAX) .. "|r" .. links }
	end
	if mode == "summary" then
		local s = (note.summary and note.summary ~= "") and Flat(note.summary, SUMMARY_MAX) or FirstLine(body, SUMMARY_MAX)
		return { prefix .. s .. links }
	elseif mode == "short" then
		return { prefix .. Flat(body, SHORT_MAX) .. links }
	end
	-- full: the reply line by line, up to FULL_MAX bytes, then the links.
	local out, shown, first = {}, 0, true
	for line in (body .. "\n"):gmatch("(.-)\n") do
		if line:match("%S") then
			if shown + #line > FULL_MAX then
				if first then
					-- One line longer than the whole budget: its start, then the note.
					out[#out + 1] = prefix .. ns.SafeText(ns.Utf8Cut(line, FULL_MAX)) .. " …"
					shown = FULL_MAX
				end
				out[#out + 1] = "    |cff888888(… the rest is in the window: click [Open])|r"
				break
			end
			out[#out + 1] = (first and prefix or "    ") .. line
			first = false
			shown = shown + #line
		end
	end
	out[#out + 1] = "    " .. N.Links(chat.id)
	return out
end

function N.Echo(note)
	for _, line in ipairs(N.EchoLines(note)) do N.Print(line) end
end

---------------------------------------------------------------------------
-- Delivery
---------------------------------------------------------------------------

-- A soft paper sound (Bones passes you a note), not the whisper's, which
-- means a player wrote to you.
local function Ping()
	local id = type(SOUNDKIT) == "table" and SOUNDKIT.IG_QUEST_LOG_OPEN or 844
	if type(PlaySound) == "function" then pcall(PlaySound, id) end
	if type(FlashClientIcon) == "function" then pcall(FlashClientIcon) end
end

-- notes: { { chat, kind = reply|error|aborted, text, summary, agent }, ... }
function N.Deliver(notes)
	if #notes == 0 then return end
	Ping()
	for _, note in ipairs(notes) do
		local chat = ns.Chats.Find(note.chat)
		if chat then
			N.Echo(note)
			-- One place shows it: the HUD when it's on (not the compass, which
			-- shows only the arrow and the distance), else a toast.
			if not ns.UI.IsShowing(chat.id) then
				if ns.HUD and ns.HUD.ShowsNews() then
					ns.HUD.OnNews(note)
				else
					local title = ns.Chats.AgentName(note.agent or chat.agent) .. " · " .. ns.Escape(chat.name)
					local line = note.kind == "reply" and ((note.summary and note.summary ~= "") and note.summary or FirstLine(note.text, SUMMARY_MAX)) or FirstLine(note.text, SUMMARY_MAX)
					-- The banner's two lines keep what to do; the window has the whole of it. [PUI-01] check-ins (STYLE §2.2)
					if note.held then line = ns.P("NeverQuestAlone paused check-ins: your next message turns them back on.") end
					ns.UI.Toast(title, line, chat.id, note.held and "held" or note.kind, note.drew) -- a gold title, not an error's
				end
			end
			ns.db.lastPing = chat.id
		end
	end
	ns.Refresh()
end

-- More than three waited out a fight: one sound, one toast, one line.
function N.DeliverCollapsed(notes)
	local order, counts, nr, drew = {}, {}, 0, nil
	for _, n in ipairs(notes) do
		drew = n.drew or drew -- the newest route drawn, for the one Okay
		if not counts[n.chat] then
			counts[n.chat] = 0
			order[#order + 1] = n.chat
		end
		counts[n.chat] = counts[n.chat] + 1
		if n.kind == "reply" then nr = nr + 1 end
	end
	local parts = {}
	for _, id in ipairs(order) do
		local c = ns.Chats.Find(id)
		if c then parts[#parts + 1] = ns.Escape(c.name) .. " (" .. counts[id] .. ")" end
	end
	local last = notes[#notes].chat
	-- Replies, errors, or both: each count says only what arrived.
	local what = nr == #notes and ns.Plural(#notes, "1 reply arrived during combat", "{n} replies arrived during combat")
		or nr == 0 and ns.Plural(#notes, "1 error arrived during combat", "{n} errors arrived during combat")
		or ns.Fill("{n} replies and errors arrived during combat", { n = #notes })
	Ping()
	if N.EchoMode() ~= "off" then -- [PR-1]
		N.Print("|cff7ec8ff[" .. ns.Chats.AgentName(ns.DEFAULT_AGENT) .. "]|r " .. what .. ": " .. table.concat(parts, ", ") .. "  " .. N.Links(last))
	end
	if ns.HUD and ns.HUD.ShowsNews() then
		local newest = notes[#notes]
		ns.HUD.OnNews({ chat = newest.chat, kind = newest.kind, text = newest.text, summary = newest.summary, agent = newest.agent, drew = drew })
	else
		ns.UI.Toast(ns.Chats.AgentName(ns.DEFAULT_AGENT), what, last, nil, drew)
	end
	ns.db.lastPing = last
	ns.Refresh()
end

-- NT-2: in combat only the badge (bumped when the record was applied) moves.
function N.Push(notes)
	if ns.db.settings.dndCombat and ns.InCombat() then
		for _, n in ipairs(notes) do table.insert(R.dndQueue, n) end
		ns.Refresh()
		return
	end
	N.Deliver(notes)
end

function N.Flush()
	if #R.dndQueue == 0 then return end
	if ns.db.settings.dndCombat and ns.InCombat() then return end
	local q = R.dndQueue
	R.dndQueue = {}
	if #q > COLLAPSE_OVER then N.DeliverCollapsed(q) else N.Deliver(q) end
end

function N.OnRegenEnabled()
	R.inCombat = false
	R.regenAt = GetTime()
	C_Timer.After(FLUSH_DELAY, N.Flush)
end

-- The 2-second tick's backstop, in case the timer or the event was missed.
function N.Tick()
	if #R.dndQueue == 0 then return end
	if R.regenAt and GetTime() - R.regenAt < FLUSH_DELAY then return end
	N.Flush()
end

-- /br: the chat that last pinged you.
function N.LastPingChat()
	return ns.Chats.Find(ns.db.lastPing)
end
