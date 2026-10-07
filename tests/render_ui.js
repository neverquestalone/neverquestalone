'use strict';
// A preview of the HUD (and its one-line form) in each of its states, as an HTML
// page: node tests/render_ui.js <out dir>. It runs the real addon in the test VM
// with rough text metrics on (STUB.metrics) and draws the frame tree with
// tests/helpers/ui-render.js. For layout and spacing, not the game's own art.
// Not part of npm test. WINDOW=1 draws the window instead (SIZE=WxH: at a size
// set with the grip, else at its default); SETTINGS=1 the
// addon's page in the game's Settings list, ADDONS=1 the game's AddOns list and
// KEYBINDINGS=1 the game's Keybindings page (stand-ins for what the game draws,
// from what the addon registers); PARTS=1 what a player reads when a part won't
// load (C-121); STRIP=1 the top of the screen while the strip shows, with its
// label beside it, in physical pixels; QUEST=1 Chains.lua's line on the game's quest pages.
const fs = require('node:fs');
const path = require('node:path');
const { newVM, lstr } = require('./helpers/nqa-vm');
const { renderTree, page, layout } = require('./helpers/ui-render');

// The UI tests' fixtures, read from their source (the map stub, a route).
const src = fs.readFileSync(path.join(__dirname, 'ui_v2_test.js'), 'utf8');
const grab = name => {
  const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!m) throw new Error('fixture not found: ' + name);
  return m[1];
};
const MAP_STUB = grab('MAP_STUB');
const SCALE = Number(process.env.SCALE || 1.5); // pixels per UI unit
const ROUTE = grab('ROUTE');

const METRICS = `
STUB.metrics = true
-- The game's base fonts, so the HUD's made fonts (CreateFont at 14, 13, 16, 11) exist here too.
for name, size in pairs({ GameFontNormal = 12, GameFontHighlight = 12, GameFontDisable = 12, GameFontNormalSmall = 10,
	GameFontHighlightSmall = 10, GameFontDisableSmall = 10 }) do
	if type(_G[name]) ~= "table" then _G[name] = { name = name, size = size } end
end
ChatFontNormal.name = "ChatFontNormal"
function ChatFontNormal:GetFont() return "Fonts\\\\ARIALN.TTF", 14, "" end
function CreateFont(name)
	local f = { name = name }
	function f:CopyFontObject(o) self.base = o end
	function f:GetFont() return "Fonts\\\\FRIZQT__.TTF", 12, "" end
	function f:SetFont(file, size) self.size = size end
	function f:SetTextColor() end
	_G[name] = f
	return f
end
`;

function ring(vm) {
  const bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false);
  vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true);
  vm.run('NS.Transport.Poll()');
}
function slotLua({ push = 0, nonce = null, acked = [], records = [], chats = '{}', extra = '', bridge = '' } = {}) {
  return `{ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.4.0", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = { ${acked.map(k => `"${k}"`).join(', ')} }${bridge} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = ${chats}, records = { ${records.join(', ')} }${extra} }`;
}
function confirmHello(vm) {
  vm.advance(3.1);
  vm.slot(slotLua({ nonce: vm.evaluate('NS.R.nonce'), push: 0 }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}
const apply = (vm, slot) => vm.run(`NS.Transport.HandleSlotData(${slot}, "slot")`);

// A route like the owner's (2026-09-26): a stop with three kill counts.
const BARRENS = `
STUB.log = {
	{ id = 871, title = "Disrupt the Attacks", complete = false, objectives = {
		{ text = "1/8 Razormane Water Seeker slain", type = "monster", finished = false, numFulfilled = 1, numRequired = 8 },
		{ text = "1/8 Razormane Thornweaver slain", type = "monster", finished = false, numFulfilled = 1, numRequired = 8 },
		{ text = "1/3 Razormane Hunter slain", type = "monster", finished = false, numFulfilled = 1, numRequired = 3 } } },
	{ id = 766, title = "Swoop Hunting", complete = true, objectives = { { text = "Trophy Swoop Quill: 8/8", finished = true } } },
}
`;
const BARRENS_ROUTE = `, map = { epoch = "e1", version = 1, layers = { { name = "barrens", title = "Barrens loop", ordered = true, loop = false, points = {
  { 1432, 20, 30, "1. The Crossroads", "turnin", "Hand in what you have.", { 766 } },
  { 1432, 30, 40, "2. The Stagnant Oasis", "kill", "Kolkar and raptors.", {} },
  { 1432, 40, 50, "3. The Forgotten Pools", "explore", "Approx Classic coords. Explore the waters.", {} },
  { 1432, 56, 40, "4. The Fold", "kill", "8 Water Seekers, 8 Thornweavers, 3 Hunters.", { 871 } },
  { 1432, 60, 45, "5. Northwatch Hold", "kill", "", {} },
  { 1432, 70, 60, "6. Ratchet", "turnin", "", {} } } } } }`;

// Chains.lua's quests in the log of a human warrior (UnitRace's and UnitClass's ids, for the records by
// class), with the reward icons the game would give (C_Item.GetItemIconByID), and a route through them.
const CHAIN_LOG = `
function UnitRace() return "Human", "Human", 1 end
function UnitClass() return "Warrior", "WARRIOR", 1 end
C_Item.GetItemIconByID = function(id) return "Interface\\\\Icons\\\\INV_Item_" .. id end
for _, q in ipairs({
	{ id = 65, title = "The Defias Brotherhood", complete = false, objectives = {} },
	{ id = 1718, title = "The Islander", complete = false, objectives = { { text = "Trophy of the Islander: 0/1", finished = false } } },
	{ id = 6822, title = "The Molten Core", complete = true, objectives = { { text = "Fire Lord slain: 1/1", finished = true } } },
	{ id = 7785, title = "Examine the Vessel", complete = false, objectives = { { text = "Vessel of Rebirth: 0/1", finished = false } } },
	{ id = 886, title = "The Barrens Oases", complete = false, objectives = {} },
	{ id = 8945, title = "Dead Man's Plea", complete = false, objectives = { { text = "Find Ysida Harmon", finished = false } } },
	{ id = 166, title = "The Defias Brotherhood", complete = true, objectives = { { text = "Edwin VanCleef slain: 1/1", finished = true } } },
	{ id = 396, title = "An Audience with the King", complete = true, objectives = {} },
}) do table.insert(STUB.log, q) end
local titles = { [132] = "The Defias Brotherhood" } -- one to pick up, not in the log
local logTitle = C_QuestLog.GetTitleForQuestID
C_QuestLog.GetTitleForQuestID = function(id) return titles[id] or (logTitle and logTitle(id)) end
`;
const CHAIN_ROUTE = `, map = { epoch = "e1", version = 1, layers = { { name = "chains", title = "Chains loop", ordered = true, loop = false, points = {
  { 1432, 30, 40, "1. Sentinel Hill", "turnin", "", { 6822, 65, 1718, 871 } },
  { 1432, 40, 50, "2. The Crossroads", "kill", "", { 7785, 886, 8945 } },
  { 1432, 50, 60, "3. Stormwind Keep", "quest", "", { 166, 396, 132 } } } } } }`;

function hud({ db = 'NQADB = { hudIntro = true, qolAsked = true, firstReply = true }', route = true, setup = null, extra = '' } = {}) {
  const vm = confirmHello(newVM({ db, extra: METRICS + MAP_STUB + BARRENS + extra }).login());
  if (route) {
    apply(vm, slotLua({ extra: BARRENS_ROUTE }));
    vm.run('NQAMap.Command("nav barrens 4"); NQAMap.UpdateNavigator(); NS.HUD.Render()');
  }
  if (setup) setup(vm);
  vm.run('NS.HUD.Render()');
  return vm;
}

function panel(vm, caption, root) {
  const bar = vm.evaluate('NQAHUDBar and NQAHUDBar.shown') === 'true';
  const tree = vm.json(`STUB.Dump(${root || (bar ? 'NQAHUDBar' : 'NQAHUD')})`);
  return { caption, w: (tree.w || 300) + 20, h: (tree.h || 100) + 20, html: renderTree(tree, { ox: 10, oy: 10, scale: SCALE, wrap: true }) };
}

// The window (UI.lua), open on a chat.
function win({ setup = null, list = false, size = process.env.SIZE } = {}) {
  const wh = size ? size.split('x').map(Number) : null;
  const grip = wh ? `, width = ${wh[0] + (list ? 226 : 0)}, height = ${wh[1]}, heightSet = true` : '';
  const vm = confirmHello(newVM({ db: `NQADB = { hudIntro = true, qolAsked = true, firstReply = true, settings = { listShown = ${list}${grip} } }`, extra: METRICS + MAP_STUB + BARRENS }).login());
  vm.run('NS.UI.Toggle(true)');
  // The transcript's scroll range, as the game works it out, so the addon scrolls where it would.
  vm.run('function NS.UI.ui.scroll:GetVerticalScrollRange() return math.max(0, (NS.UI.ui.content.height or 0) - (self.height or 0)) end');
  if (setup) setup(vm);
  vm.run('NS.Refresh("all")');
  return vm;
}
// The stub doesn't size a frame from its anchors, and the window sizes its
// bubbles from its scroll frame's width: lay the tree out, hand the frames
// their sizes, redraw, twice.
function settle(vm, root) {
  for (let pass = 0; pass < 2; pass++) {
    const { byId, rects } = layout(vm.json(`STUB.Dump(${root})`));
    const sets = [];
    for (const [id, n] of byId) {
      if (n.kind === 'Texture' || n.kind === 'Line' || (n.points || []).length < 2) continue;
      const r = rects.get(id);
      // A string held at both sides gets its width (it wraps as in the game); its height stays its own.
      if (n.kind === 'FontString') { if (r && r.w > 0) sets.push(`do local o = STUB.dumped[${id}]; if o then o.width = ${r.w} end end`); continue; }
      if (r && r.w > 0 && r.h > 0) sets.push(`do local o = STUB.dumped[${id}]; if o then o.width, o.height = ${r.w}, ${r.h} end end`);
    }
    vm.run(sets.join('\n'));
    vm.run('NS.Refresh("all")');
    vm.advance(0); // the scroll it decided (U.ScrollTo waits a frame)
  }
}
// The transcript cut at its edges, at the scroll the addon set (the newest, or a long notice's start).
// after: what happens once the window is drawn (a command's answer lands as it would in the game).
function windowPanel(vm, caption, { after = null } = {}) {
  settle(vm, 'NQAFrame');
  if (after) { after(vm); vm.advance(0); }
  const tree = vm.json('STUB.Dump(NQAFrame)');
  const size = `${Math.round(tree.w)} x ${Math.round(tree.h)}`;
  return { caption: `${caption} (${size})`, w: (tree.w || 600) + 20, h: (tree.h || 400) + 20, html: renderTree(tree, { ox: 10, oy: 10, scale: SCALE, clip: true, wrap: true }) };
}

// STRIP=1: the top of a screen while the strip shows, in its physical pixels (the strip draws one
// cell 4 of them; its label, Transport.lua's T.PlaceStripLabel, in the UI's own units). w, h: the
// screen in pixels; ui: the UI scale (null: none, one unit a pixel); pv: preview pixels a screen pixel.
function stripScreen({ w, h, ui = null, send = null, slash = null, pv = 1, band = 280 }, caption) {
  const us = ui ?? 768 / h;
  const screen = `function GetPhysicalScreenSize() return ${w}, ${h} end
UIParent.width, UIParent.height = ${w} * 768 / ${h} / ${us}, 768 / ${us}
function UIParent:GetEffectiveScale() return ${us} end`;
  const vm = newVM({ extra: METRICS + screen }).login();
  vm.advance(3.1); // the hello on the strip
  if (send) vm.send(send);
  if (slash) vm.slash(slash);
  const cells = vm.json('(function() local out = {} for _, t in ipairs(NQAStrip.textures) do if t.shown and t.color then out[#out + 1] = { x = t.x, y = -t.y, c = t.color } end end return out end)()');
  const r = vm.json('NS.Transport.StripLabelRect()');
  const tree = vm.json('STUB.Dump(NQAStripLabel)');
  const px = v => v * pv / SCALE; // page() scales by SCALE: undo it, so a screen pixel is pv preview pixels
  const cellsHtml = cells.map(c => `<div style="position:absolute;left:${c.x * pv}px;top:${c.y * pv}px;width:${4 * pv}px;height:${4 * pv}px;background:rgb(${c.c.slice(0, 3).map(v => Math.round(v * 255)).join(',')})"></div>`).join('');
  const label = `<div style="position:absolute;left:${r.x * pv}px;top:${r.y * pv}px">${renderTree(tree, { scale: r.k * pv })}</div>`;
  // A stand-in for the world behind it (sky, then ground), so the label is judged over a scene.
  const world = '<div style="position:absolute;inset:0;background:linear-gradient(180deg,#6f8fb0 0%,#9db3c4 38%,#7b8a62 39%,#56653f 70%,#3f4a2e 100%)"></div>';
  return { caption, w: px(w), h: px(band), html: `<div style="position:absolute;left:0;top:0;width:${w * pv}px;height:${band * pv}px;overflow:hidden">${world}${cellsHtml}${label}</div>` };
}

// SETTINGS=1: the addon's page in the game's Settings, a stand-in. The game draws
// that list, not the addon, so a Settings stub records every row the addon
// registers, in order (a check box, a slider, a header, a button; a row's
// indent, gray-out tests and parent link, if any), and this draws them with
// the list's own measures (Blizzard_SettingsList.lua and
// Blizzard_SettingControls.xml/.lua at bd2470a): the Container is 665 wide;
// its ScrollBox starts 15 left of it and ends 20 short, and its view pads rows
// 25 on the left, 10 at the top and 9 apart. A row is 26 tall (a header 45):
// its label from 37 in (15 more when indented) to 85 left of its middle, one
// line cut with "...", in GameFontNormal (GameFontNormalSmall only for a row
// whose parent is in the layout, which the addon no longer makes, QL-36); a
// check box (30 x 29) or a slider (250 x 40, its words 25 right of the bar)
// from 80 left of its middle; a button (200) from 40 left of it.
const SETTINGS_STUB = `
STUB.list = {}
local function Push(i) table.insert(STUB.list, i); return i end
local function Init(kind, setting, extra)
	local i = { kind = kind, setting = setting }
	for k, v in pairs(extra or {}) do i[k] = v end
	function i:SetParentInitializer(parent, predicate) self.parent = parent; if predicate then self:AddModifyPredicate(predicate) end end
	function i:Indent() self.indent = 15 end
	function i:AddModifyPredicate(fn) self.predicates = self.predicates or {}; table.insert(self.predicates, fn) end
	function i:AddEvaluateStateCVar(var) self.watches = self.watches or {}; table.insert(self.watches, var) end
	return Push(i)
end
STUB.byName = {}
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name) STUB.category = { name = name, GetID = function() return 42 end }; return STUB.category, {} end,
	RegisterInitializer = function(cat, i) Push(i) end,
	RegisterProxySetting = function(cat, var, vt, name, def, get, set)
		local s = { var = var, name = name, def = def, get = get, set = set }
		function s:NotifyUpdate() end
		STUB.byName[name] = s
		return s
	end,
	CreateCheckbox = function(cat, setting, tip) return Init("checkbox", setting, { tip = tip }) end,
	CreateSliderOptions = function(min, max, step) local o = { minValue = min, maxValue = max, step = step }; function o:SetLabelFormatter(kind, fn) self.fmt = fn end; return o end,
	CreateSlider = function(cat, setting, options, tip) return Init("slider", setting, { options = options, tip = tip }) end,
	RegisterAddOnCategory = function() end,
	OpenToCategory = function() end,
	KEYBINDINGS_CATEGORY_ID = 7,
}
function CreateSettingsListSectionHeaderInitializer(name) return { kind = "header", name = name } end
function CreateSettingsButtonInitializer(name, text) return { kind = "button", name = name, text = text } end
MinimalSliderWithSteppersMixin = { Label = { Left = 1, Right = 2 } }
-- Each row as the list would draw it now.
function STUB.SettingsRows()
	local out = {}
	for _, i in ipairs(STUB.list) do
		local r = { kind = i.kind, name = i.name, text = i.text }
		if i.setting then r.name, r.value = i.setting.name, i.setting.get() end
		if i.tip ~= nil then r.tip = type(i.tip) == "function" and i.tip() or i.tip end
		if i.kind == "slider" then
			r.min, r.max = i.options.minValue, i.options.maxValue
			r.label = i.options.fmt and i.options.fmt(r.value) or tostring(r.value)
		end
		-- The game's own rules: indented when asked, or under a parent in the layout (then 10 pt);
		-- grayed while any gray-out test says no.
		r.child = i.parent ~= nil
		r.indent = (i.indent or r.child) and 15 or 0
		r.enabled = true
		for _, fn in ipairs(i.predicates or {}) do if not fn() then r.enabled = false end end
		out[#out + 1] = r
	end
	return out
end
`;
function settingsRows({ db = 'NQADB = { hudIntro = true, qolAsked = true, firstReply = true }', setup = null } = {}) {
  // A client with the game's own Auto Loot and quest tracking settings, as the owner's has.
  const cvars = 'STUB.cvars.autoLootDefault = "0"; STUB.cvars.autoQuestWatch = "1"';
  const vm = confirmHello(newVM({ db, extra: METRICS + SETTINGS_STUB + cvars }).login());
  if (setup) setup(vm);
  const rows = vm.list('STUB.SettingsRows()');
  rows.category = vm.evaluate('STUB.category and STUB.category.name'); // the page's title: the name the addon registers
  return rows;
}
// The rows from a section's header to the next header (or the whole page).
function section(rows, name) {
  const at = rows.findIndex(r => r.kind === 'header' && r.name === name);
  const end = rows.findIndex((r, i) => i > at && r.kind === 'header');
  return rows.slice(at, end < 0 ? rows.length : end);
}
// A tooltip as the game draws one (a stand-in): its title (and a right-hand
// value) in white at 14, then each line wrapped at the tooltip's width, at 12.
// Lines wrap by the rough measure the tests use (0.52 em a character).
function drawTip(at, x, y, { title, right = null, lines = [], w = 300 }) {
  const WHITE = [1, 1, 1, 1];
  const wrap = (s, size, width) => {
    let n = 1, line = 0;
    for (const word of s.split(/\s+/)) {
      const ww = (word.length + 1) * size * 0.52;
      if (line > 0 && line + ww > width) { n++; line = ww; } else line += ww;
    }
    return n;
  };
  const box = at({ kind: 'Texture', w, h: 10, color: [0.03, 0.03, 0.05, 0.94] }, x, y);
  const edge = [0.55, 0.55, 0.6, 1];
  const border = [at({ kind: 'Texture', w, h: 1, color: edge }, x, y), at({ kind: 'Texture', w: 1, h: 10, color: edge }, x, y)];
  let cy = y + 10;
  at({ kind: 'FontString', text: title, w: w - 20 - (right ? 60 : 0), sh: 17, fontSize: 14, textColor: WHITE, justifyH: 'LEFT', wordWrap: false }, x + 10, cy);
  if (right) at({ kind: 'FontString', text: right, w: 56, sh: 17, fontSize: 14, textColor: WHITE, justifyH: 'RIGHT', wordWrap: false }, x + w - 66, cy);
  cy += 17 + 2;
  for (const l of lines) {
    const h = wrap(l.text, 12, w - 20) * 14;
    at({ kind: 'FontString', text: l.text, w: w - 20, sh: h, fontSize: 12, textColor: l.color || [1, 0.82, 0, 1], justifyH: 'LEFT' }, x + 10, cy);
    cy += h + 2;
  }
  const h = cy - y + 8;
  box.h = h;
  border[1].h = h;
  border.push(at({ kind: 'Texture', w, h: 1, color: edge }, x, y + h - 1), at({ kind: 'Texture', w: 1, h, color: edge }, x + w - 1, y));
  return h;
}

// tip: { row: a row's name, title, lines } drawn beside that row, the panel made wider for it.
// page: the list's header as a category shows it (its name, as the addon registers it, and Defaults);
// search: as an Options search shows it ("Search Results", no Defaults; Blizzard_SettingsPanel.lua:730-734).
function settingsPanel(rows, caption, { page = false, search = false, tip = null } = {}) {
  const W = 665, ROW_X = 10, ROW_W = 635, CX = ROW_X + ROW_W / 2;
  const GOLD = [1, 0.82, 0, 1], GRAY = [0.5, 0.5, 0.5, 1], WHITE = [1, 1, 1, 1];
  const nodes = [];
  let nid = 1;
  const root = { id: nid++, kind: 'Frame', w: W, h: 100, points: [], children: nodes, shown: true };
  const at = (n, x, y) => { Object.assign(n, { id: nid++, points: [{ point: 'TOPLEFT', rel: root.id, relPoint: 'TOPLEFT', x, y: -y }], children: [], shown: true }); nodes.push(n); return n; };
  const text = (s, x, y, w, size, color) => at({ kind: 'FontString', text: s, w, sh: Math.round(size * 1.2), fontSize: size, textColor: color, justifyH: 'LEFT', wordWrap: false }, x, y);
  const bg = at({ kind: 'Texture', layer: 'BACKGROUND', w: W, h: 100, color: [0.07, 0.06, 0.05, 1] }, 0, 0);
  const rowY = {};
  let y = 10;
  if (page || search) {
    text(search ? 'Search Results' : rows.category || '?', 7, 22, 300, 20, WHITE);
    if (!search) at({ kind: 'Button', template: 'UIPanelButtonTemplate', text: 'Defaults', w: 96, h: 22 }, W - 36 - 96, 16);
    at({ kind: 'Texture', w: W - 20, h: 1, color: [0.45, 0.38, 0.25, 1] }, 10, 50);
    y = 52 + 10;
  }
  for (const r of rows) {
    if (r.kind === 'header') {
      text(r.name, ROW_X + 7, y + 16, 400, 16, WHITE);
      y += 45 + 9;
      continue;
    }
    const on = r.enabled !== false, size = r.child ? 10 : 12;
    const lx = ROW_X + (r.indent || 0) + 37;
    text(r.name, lx, y + (26 - Math.round(size * 1.2)) / 2, CX - 85 - lx, size, on ? GOLD : GRAY);
    if (r.kind === 'checkbox') {
      at({ kind: 'CheckButton', template: 'UICheckButtonTemplate', w: 30, h: 29, checked: r.value === true, disabled: !on }, CX - 80, y - 1.5);
    } else if (r.kind === 'slider') {
      const x0 = CX - 80, mid = y + 13 - 3, sx = x0 + 19, sw = 250 - 38;
      const frac = r.max > r.min ? (r.value - r.min) / (r.max - r.min) : 0;
      at({ kind: 'Texture', w: sw, h: 6, color: [0.2, 0.17, 0.13, 1] }, sx, mid - 3);
      at({ kind: 'Texture', w: Math.max(1, sw * frac), h: 6, color: on ? [0.62, 0.48, 0.12, 1] : [0.35, 0.35, 0.35, 1] }, sx, mid - 3);
      at({ kind: 'Texture', w: 12, h: 16, color: on ? [0.95, 0.82, 0.35, 1] : [0.5, 0.5, 0.5, 1] }, sx + sw * frac - 6, mid - 8);
      const dim = [0.45, 0.37, 0.1, 1];
      text('◀', x0 + 4, mid - 7, 11, 12, on && r.value > r.min ? GOLD : dim);
      text('▶', x0 + 250 - 19 + 4, mid - 7, 9, 12, on && r.value < r.max ? GOLD : dim);
      text(r.label, sx + sw + 25, mid - 7, W - (sx + sw + 25) - 10, 12, on ? GOLD : GRAY);
    } else if (r.kind === 'button') {
      at({ kind: 'Button', template: 'UIPanelButtonTemplate', text: r.text, w: 200, h: 26 }, CX - 40, y);
    }
    rowY[r.name] = y;
    y += 26 + 9;
  }
  bg.h = root.h = y + 1;
  if (tip && rowY[tip.row] !== undefined) {
    const th = drawTip(at, W + 12, rowY[tip.row], tip);
    root.w = W + 12 + (tip.w || 300);
    root.h = Math.max(root.h, rowY[tip.row] + th + 4);
  }
  return { caption, w: root.w + 20, h: root.h + 20, html: renderTree(root, { ox: 10, oy: 10, scale: SCALE }) };
}

// ADDONS=1: the game's AddOns list (character select or in game), a stand-in:
// AddonList_Update's rows (tests/helpers/addon-list.mjs) drawn with
// AddonList.xml's measures. A row is 16 tall, 8 apart, 20 in per level; an
// addon's check box (24) at 5, its icon (20) and title from 32, its status at
// the right in GameFontNormalSmall; a category's arrow (10) at 13 and its title
// 8 right of it, 220 wide, with no check box and no icon.
async function addonsPanels() {
  const { addonListRows, tocMeta } = await import('./helpers/addon-list.mjs');
  const S = await import('../bridge/transport/slots.mjs');
  const toc = tocMeta(fs.readFileSync(path.join(__dirname, '..', 'addon', 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8'));
  const LOD = 'Only loadable on demand'; // ADDON_DEMAND_LOADED: a slot's status, as the owner read it
  const WHITE_TIP = [1, 1, 1, 1]; // AddonTooltip_Update: the notes in white
  const others = ['Leatrix_Maps', 'Leatrix_Plus', 'Leatrix_Sounds'].map(name => ({ name, title: name.replace('_', ' '), group: name, icon: 'Interface\\ICONS\\INV_Misc_QuestionMark' }));
  const us = { name: 'NeverQuestAlone', title: toc.Title, group: 'NeverQuestAlone', icon: toc.IconTexture };
  const now = Array.from({ length: S.SLOT_COUNT }, (_, k) => { const m = tocMeta(S.slotToc(k + 1, '16001')); return { name: S.slotName(k + 1), title: m.Title, group: m.Group, category: m.Category, icon: m.IconTexture, status: LOD }; });
  const was = Array.from({ length: S.SLOT_COUNT }, (_, k) => ({ name: S.slotName(k + 1), title: `NeverQuestAlone slot ${String(k + 1).padStart(3, '0')}`, group: 'NeverQuestAlone', icon: 'Interface\\ICONS\\INV_Misc_QuestionMark', status: LOD }));
  // tip: { row: a row's text, title, right, lines } drawn beside that row (the list's AddonTooltip).
  const draw = (rows, caption, { max = 14, tip = null } = {}) => {
    const W = 560, GOLD = [1, 0.82, 0, 1], WHITE = [1, 1, 1, 1];
    const rowY = {};
    const nodes = [];
    let nid = 1;
    const root = { id: nid++, kind: 'Frame', w: W, h: 100, points: [], children: nodes, shown: true };
    const at = (n, x, y) => { Object.assign(n, { id: nid++, points: [{ point: 'TOPLEFT', rel: root.id, relPoint: 'TOPLEFT', x, y: -y }], children: [], shown: true }); nodes.push(n); return n; };
    const text = (s, x, y, w, size, color) => at({ kind: 'FontString', text: s, w, sh: Math.round(size * 1.2), fontSize: size, textColor: color, justifyH: 'LEFT', wordWrap: false }, x, y);
    const bg = at({ kind: 'Texture', layer: 'BACKGROUND', w: W, h: 100, color: [0.06, 0.05, 0.04, 1] }, 0, 0);
    let y = 5;
    const shown = rows.slice(0, max);
    for (const r of shown) {
      const x = 5 + r.depth * 20;
      if (r.category) {
        text(r.folded ? '▶' : '▼', x + 13, y + 1, 10, 11, GOLD);
        text(r.text, x + 31, y + 2, 220, 12, GOLD);
      } else {
        at({ kind: 'CheckButton', template: 'UICheckButtonTemplate', w: 24, h: 24, checked: true }, x + 5, y - 4);
        at({ kind: 'Texture', texture: r.icon, w: 16, h: 16 }, x + 32, y);
        text(r.text, x + 52, y + 2, 280, 12, GOLD);
        if (r.status) text(r.status, W - 150, y + 3, 145, 10, GOLD);
      }
      rowY[r.text] = y;
      y += 16 + 8;
    }
    if (rows.length > max) { text(`… ${rows.length - max} more rows`, 37, y + 2, 300, 12, WHITE); y += 24; }
    bg.h = root.h = y + 5;
    if (tip && rowY[tip.row] !== undefined) {
      const th = drawTip(at, W + 12, rowY[tip.row], tip);
      root.w = W + 12 + (tip.w || 300);
      root.h = Math.max(root.h, rowY[tip.row] + th + 4);
    }
    return { caption, w: root.w + 20, h: root.h + 20, html: renderTree(root, { ox: 10, oy: 10, scale: SCALE }) };
  };
  // The rows 0.5.2 showed: its TOC's title ("NeverQuestAlone") and the old slot TOCs.
  const old = { ...us, title: 'NeverQuestAlone' };
  return [
    draw(addonListRows([...others, old, ...was]), '0.5.2 (the owner\'s report): NeverQuestAlone with its 200 parts under it, each with a check box and a red question mark (the Leatrix icons aren\'t modeled)'),
    draw(addonListRows([...others, us, ...now], { [S.SLOT_CATEGORY]: true }), `0.5.3, folded (setup folds it at install, before the first start, C-119; the addon at a logout where setup didn't): the parts' one row, then the addon's own, "${toc.Title}"`),
    draw(addonListRows([...others, us, ...now]), '0.5.3, unfolded (a player who opens it): the parts under their row, none under the addon\'s own'),
    draw(addonListRows([...others, us, ...now], { [S.SLOT_CATEGORY]: true }), 'The addon\'s row under the pointer (C-120): its name and version, and its notes in plain words',
      { tip: { row: toc.Title, title: toc.Title, right: toc.Version, lines: [{ text: toc.Notes, color: WHITE_TIP }] } }),
  ];
}

// KEYBINDINGS=1: the game's Keybindings page (Options > Keybindings), a stand-in: its sections as
// Keybindings.lua builds them from Bindings.xml (tests/helpers/keybindings.mjs), drawn with the page's
// measures. A section is a 30-tall bar with its name 21 in (SettingsExpandableSectionTemplate,
// GameFontNormal), its element 25 tall and 9 from the next; open, its keys start 45 down and are 25 apart,
// each with its name 37 in on one line 170 wide (cut with "…") and two key buttons of 160 by 22 from 80 left
// of the row's middle (KeyBindingFrameBindingTemplate), "Not Bound" in gray while unbound (BindingUtil.lua).
// The page's top: the Character Specific Keybindings check box, then Click Casting and Quick Keybind Mode.
function keybindingsPanel(elements, caption, { top = false } = {}) {
  const W = 665, ROW_X = 10, ROW_W = 635, CX = ROW_X + ROW_W / 2;
  const GOLD = [1, 0.82, 0, 1], WHITE = [1, 1, 1, 1];
  const nodes = [];
  let nid = 1;
  const root = { id: nid++, kind: 'Frame', w: W, h: 100, points: [], children: nodes, shown: true };
  const at = (n, x, y) => { Object.assign(n, { id: nid++, points: [{ point: 'TOPLEFT', rel: root.id, relPoint: 'TOPLEFT', x, y: -y }], children: [], shown: true }); nodes.push(n); return n; };
  const text = (s, x, y, w, size, color, justifyH = 'LEFT') => at({ kind: 'FontString', text: s, w, sh: Math.round(size * 1.2), fontSize: size, textColor: color, justifyH, wordWrap: false }, x, y);
  const bg = at({ kind: 'Texture', layer: 'BACKGROUND', w: W, h: 100, color: [0.07, 0.06, 0.05, 1] }, 0, 0);
  let y = 10;
  if (top) {
    text('Keybindings', 7, 22, 300, 20, WHITE);
    at({ kind: 'Button', template: 'UIPanelButtonTemplate', text: 'Defaults', w: 96, h: 22 }, W - 36 - 96, 16);
    at({ kind: 'Texture', w: W - 20, h: 1, color: [0.45, 0.38, 0.25, 1] }, 10, 50);
    y = 52 + 10;
  }
  for (const e of elements) {
    if (e.kind === 'checkbox') {
      text(e.name, ROW_X + 37, y + 6, CX - 85 - ROW_X - 37, 12, GOLD);
      at({ kind: 'CheckButton', template: 'UICheckButtonTemplate', w: 30, h: 29, checked: !!e.value }, CX - 80, y - 1.5);
      y += 26 + 9;
      continue;
    }
    if (e.kind === 'button') {
      at({ kind: 'Button', template: 'UIPanelButtonTemplate', text: e.text, w: 200, h: 26 }, CX - 40, y);
      y += 26 + 9;
      continue;
    }
    // A section: its bar, its name, and + or − at the bar's right.
    at({ kind: 'Texture', w: ROW_W - 20, h: 30, color: [0.17, 0.14, 0.1, 1] }, ROW_X, y);
    at({ kind: 'Texture', w: ROW_W - 20, h: 1, color: [0.32, 0.27, 0.2, 1] }, ROW_X, y + 29);
    text(e.name, ROW_X + 21, y + 6, 400, 12, GOLD);
    text(e.expanded ? '−' : '+', ROW_X + ROW_W - 20 - 26, y + 5, 14, 14, GOLD, 'CENTER');
    let h = 25;
    if (e.expanded) {
      let ry = y + 45;
      for (const k of e.entries) {
        if (!k.spacer) {
          text(k.label, ROW_X + 37, ry + 5, 170, 12, GOLD);
          for (const bx of [CX - 80, CX + 80]) {
            at({ kind: 'Frame', template: 'InsetFrameTemplate', w: 160, h: 22 }, bx, ry + 1.5);
            text('Not Bound', bx + 5, ry + 1.5 + 5, 150, 10, [0.5, 0.5, 0.5, 0.8], 'CENTER');
          }
        }
        ry += 25;
      }
      h = 25 * e.entries.length + 45;
    }
    y += h + 9;
  }
  bg.h = root.h = y + 1;
  return { caption, w: root.w + 20, h: root.h + 20, html: renderTree(root, { ox: 10, oy: 10, scale: SCALE }) };
}

async function keybindingsPanels() {
  const { bindingsXml, keybindingSections, GAME_STRINGS } = await import('./helpers/keybindings.mjs');
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true, firstReply = true }', extra: METRICS }).login());
  const G = k => vm.evaluate(`type(_G[${lstr(k)}]) == "string" and _G[${lstr(k)}] or nil`) ?? GAME_STRINGS[k];
  const bindings = bindingsXml(fs.readFileSync(path.join(__dirname, '..', 'addon', 'NeverQuestAlone', 'Bindings.xml'), 'utf8'));
  // Round 3 (d3ac2a7): category="ADDONS", a header on the first key, and the item key's name then.
  const was = bindings.map((b, i) => ({ ...b, category: 'ADDONS', header: i === 0 ? 'NQA' : undefined }));
  const wasG = k => (k === 'BINDING_NAME_NQA_ASK_ITEM' ? 'Ask About the Item Under the Mouse' : G(k));
  const sections = (list, g, open = null) => keybindingSections(list, g, { game: true }).map(s => ({ name: s.name, expanded: s.name === open,
    entries: s.entries.map(k => (k.spacer ? k : { label: g(`BINDING_NAME_${k.action}`) })) }));
  const top = [{ kind: 'checkbox', name: GAME_STRINGS.CHARACTER_SPECIFIC_KEYBINDINGS, value: false },
    { kind: 'button', text: GAME_STRINGS.CLICK_BIND_MODE }, { kind: 'button', text: GAME_STRINGS.SETTINGS_QUICK_KEYBIND_BUTTON }];
  const name = G('BINDING_HEADER_NQA');
  return [
    keybindingsPanel([...top, ...sections(was, wasG).slice(0, 5)], 'Round 3 (d3ac2a7): Bind Keys opened the page at its top, as nothing on it was named NeverQuestAlone', { top: true }),
    keybindingsPanel(sections(was, wasG, 'AddOns').slice(-4), 'Round 3: the page\'s end, AddOns opened: a blank row (the header), then the five keys, unnamed (the item key cut)'),
    keybindingsPanel(sections(bindings, G).slice(-4), `0.5.3 (C-127): the keys' own section, ${name}, last on the page; Bind Keys scrolls to it, collapsed as the game's own open`),
    keybindingsPanel(sections(bindings, G, name).slice(-4), `One click on ${name}: its five keys, each name whole (the item key: Ask About the Hovered Item)`),
  ];
}

// QUEST=1: Chains.lua's line on the game's quest pages, stand-ins for what the game draws: Mainline
// QuestFrame.xml (the frame 338 x 496, the detail page's scroll frame at 5, -65, 300 x 403, Accept and
// Decline at its foot) and QuestInfo.lua's templates (QUEST_TEMPLATE_DETAIL: the title at 10, -10, the
// description 5 under it, "Quest Objectives" 15 under that, its text 5 under, the rewards 15 under;
// QUEST_TEMPLATE_MAP_DETAILS: the world map's quest log, 289 wide, the title at 5, -10 and the
// objectives under it), the fonts at the game's sizes (QuestTitleFont 18, QuestFont 13) and the
// parchment's colours (the title black, the text dark brown). Chains.lua's own post-hook puts the line in.
const QUEST_PAGE = `
QuestFont = { name = "QuestFont", size = 13 }
QuestTitleFont = { name = "QuestTitleFont", size = 18 }
local INK, TITLE_INK = { 0.18, 0.12, 0.06 }, { 0, 0, 0 }
local function Part(name, font, color, text)
	local p = UIParent:CreateFontString(name, "ARTWORK", font.name)
	p.font = font
	p.GetFontObject = function() return font end
	p.GetPoint = function(self) local t = self.points and self.points.TOPLEFT; if t then return "TOPLEFT", t.rel, t.relPoint, t.x, t.y end end
	p.SetParent = function(self, parent)
		if self.parent and self.parent.children then for i, c in ipairs(self.parent.children) do if c == self then table.remove(self.parent.children, i) break end end end
		self.parent = parent
		table.insert(parent.children, self)
	end
	p:SetTextColor(color[1], color[2], color[3])
	p.GetTextColor = function(self) return self.textColor[1], self.textColor[2], self.textColor[3] end
	p:SetJustifyH("LEFT")
	if text then p:SetText(text) end
	return p
end
Part("QuestInfoTitleHeader", QuestTitleFont, TITLE_INK)
Part("QuestInfoDescriptionText", QuestFont, INK)
Part("QuestInfoObjectivesHeader", QuestTitleFont, TITLE_INK, "Quest Objectives")
Part("QuestInfoObjectivesText", QuestFont, INK)
Part("QuestInfoRewardsHeader", QuestTitleFont, TITLE_INK, "Rewards")
Part("QuestInfoDescriptionHeader", QuestTitleFont, TITLE_INK, "Description")
Part("QuestInfoRewardText", QuestFont, INK, "You will receive:")
QUEST_TEMPLATE_DETAIL = { contentWidth = 275, parts = { { "QuestInfoTitleHeader", 10, -10 }, { "QuestInfoDescriptionText", 0, -5 },
	{ "QuestInfoObjectivesHeader", 0, -15 }, { "QuestInfoObjectivesText", 0, -5 }, { "QuestInfoRewardsHeader", 0, -15 }, { "QuestInfoRewardText", 0, -5 } } }
QUEST_TEMPLATE_MAP_DETAILS = { questLog = true, contentWidth = 289, parts = { { "QuestInfoTitleHeader", 5, -10 }, { "QuestInfoObjectivesText", 0, -5 },
	{ "QuestInfoDescriptionHeader", 0, -20 }, { "QuestInfoDescriptionText", 0, -5 } } }
QUEST_TEMPLATE_LOG = { questLog = true, contentWidth = 285, parts = {} }
function QuestInfo_Display(template, parent)
	local last
	for _, e in ipairs(template.parts) do
		local p = _G[e[1]]
		p:SetParent(parent)
		p:ClearAllPoints()
		p:SetWidth(template.contentWidth)
		p:Show()
		if last then p:SetPoint("TOPLEFT", last, "BOTTOMLEFT", e[2], e[3]) else p:SetPoint("TOPLEFT", parent, "TOPLEFT", e[2], e[3]) end
		last = p
	end
end
local function Box(name, parent, w, h, r, g, b)
	local f = CreateFrame("Frame", name, parent)
	f:SetSize(w, h)
	if r then local t = f:CreateTexture(nil, "BACKGROUND"); t:SetAllPoints(f); t:SetColorTexture(r, g, b, 1) end
	return f
end
-- The offer page.
QuestFrame = Box("QuestFrame", UIParent, 338, 496, 0.13, 0.11, 0.09)
QuestFrame:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
local name = QuestFrame:CreateFontString(nil, "OVERLAY", "GameFontNormal")
name:SetPoint("TOP", QuestFrame, "TOP", 0, -6)
name.textColor = { 1, 0.82, 0 }
QuestFrame.npc = name
local page = Box(nil, QuestFrame, 316, 418, 0.86, 0.78, 0.60)
page:SetPoint("TOPLEFT", QuestFrame, "TOPLEFT", 6, -60)
QuestDetailScrollChildFrame = Box("QuestDetailScrollChildFrame", QuestFrame, 300, 403)
QuestDetailScrollChildFrame:SetPoint("TOPLEFT", QuestFrame, "TOPLEFT", 5, -65)
for i, label in ipairs({ "Accept", "Decline" }) do
	local b = Box(nil, QuestFrame, 78, 22, 0.45, 0.07, 0.05)
	b:SetPoint(i == 1 and "BOTTOMLEFT" or "BOTTOMRIGHT", QuestFrame, i == 1 and "BOTTOMLEFT" or "BOTTOMRIGHT", i == 1 and 6 or -6, 4)
	local t = b:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	t:SetPoint("CENTER", b, "CENTER", 0, 0)
	t:SetText(label)
end
-- The world map's quest log, its details pane.
QuestMapDetails = Box("QuestMapDetails", UIParent, 304, 300, 0.86, 0.78, 0.60)
QuestMapDetails:SetPoint("TOPLEFT", UIParent, "TOPLEFT", 0, 0)
QuestMapDetailsContents = Box("QuestMapDetailsContents", QuestMapDetails, 300, 300)
QuestMapDetailsContents:SetPoint("TOPLEFT", QuestMapDetails, "TOPLEFT", 2, -2)
QI = { quest = 0, selected = 0 }
function GetQuestID() return QI.quest end
C_QuestLog = C_QuestLog or {}
C_QuestLog.GetSelectedQuest = function() return QI.selected end
`;
function questPage({ quest, npc, title, text, objectives, race = 1, cls = 1, map = false, extra = '' }) {
  const vm = newVM({ extra: METRICS + QUEST_PAGE + `
function UnitRace() return "Race", "Race", ${race} end
function UnitClass() return "Class", "CLASS", ${cls} end
${extra}` }).login();
  vm.run(`QuestInfoTitleHeader:SetText(${lstr(title)}); QuestInfoDescriptionText:SetText(${lstr(text)}); QuestInfoObjectivesText:SetText(${lstr(objectives)})`);
  if (map) vm.run(`QI.selected = ${quest}; QuestInfo_Display(QUEST_TEMPLATE_MAP_DETAILS, QuestMapDetailsContents)`);
  else vm.run(`QI.quest = ${quest}; QuestFrame.npc:SetText(${lstr(npc)}); QuestInfo_Display(QUEST_TEMPLATE_DETAIL, QuestDetailScrollChildFrame)`);
  return vm;
}
function questPanels() {
  const P = [];
  const offer = (o, caption) => P.push(panel(questPage(o), caption, 'QuestFrame'));
  offer({ quest: 65, npc: 'Gryan Stoutmantle', title: 'The Defias Brotherhood', text: 'The Defias have grown bold in Westfall. Take this note to Wiley in Stormwind and learn what he knows of them.', objectives: 'Speak with Wiley in the Stormwind trade district.' },
    'The offer page, a dungeon: "Leads to The Deadmines · step 1 of 7" 5 under the title, the description 10 under it (a human warrior, level 16)');
  offer({ quest: 1718, npc: 'Klannoc Macleod', title: 'The Islander', text: 'Prove yourself on the isle across the water, and you may yet learn the way of the whirlwind.', objectives: 'Bring a Trophy of the Islander to Klannoc Macleod.' },
    'A reward that is one pick of three: its own link in its quality\'s colour, "or 2 more"; hover shows its tooltip and the comparison');
  offer({ quest: 6182, npc: 'Highlord Bolvar Fordragon', title: 'The First and the Last', text: 'The dead do not rest in the Eastern Plaguelands. Speak with those who have fought there, and learn what they know.', objectives: 'Speak with Highlord Bolvar Fordragon.', cls: 2 },
    'A paladin, where the chain\'s picks are a bow, a wand and a shield: the shield alone, no "or 2 more" for picks a paladin can\'t use');
  offer({ quest: 7785, npc: 'Highlord Demitrian', title: 'Examine the Vessel', text: 'The vessel hums with the wind lord\'s power. Bring it to me, and its secrets with it.', objectives: 'Bring the Vessel of Rebirth to Highlord Demitrian.' },
    'The longest name: a legendary reward; the game wraps the link, and the step goes on a line of its own');
  offer({ quest: 886, npc: 'Tonga Runetotem', title: 'The Barrens Oases', text: 'The oases of the Barrens are changing. Go to the Crossroads and ask after them.', objectives: 'Speak with Tonga Runetotem at the Crossroads.', race: 6 },
    'A breadcrumb to a chain: where it leads, with no step ("Leads to Wailing Caverns", a tauren)');
  offer({ quest: 8945, npc: 'Anthion Harmon', title: 'Dead Man\'s Plea', text: 'Anthion asks you to carry his plea into the city, where his love still waits.', objectives: 'Find Ysida Harmon in Stratholme.' },
    'Saying less: the ways on differ in length, so no count ("Leads to Stratholme · step 10")');
  offer({ quest: 4024, npc: 'Cyrus Therepentous', title: 'A Taste of Flame', text: 'Bring me the flame of the fire lord\'s lieutenant, and I\'ll tell you what it hides.', objectives: 'Bring a Black Dragonflight Molt to Cyrus Therepentous.' },
    'Saying less: two ways in at different steps, so no step ("Leads to Blackrock Depths")');
  offer({ quest: 748, npc: 'Mull Thunderhorn', title: 'Poison Water', text: 'The wells are fouled. Bring me paws and talons, so I can find what spoils them.', objectives: 'Bring 6 Prairie Wolf Paws and 6 Plainstrider Talons to Mull Thunderhorn.' },
    'A quest whose chain leads to nothing: no line, the page as the game draws it');
  P.push(panel(questPage({ quest: 132, map: true, title: 'The Defias Brotherhood', text: 'Wiley says the Defias meet in secret. Bring his note to Gryan, who will know what it means.', objectives: 'Bring the note to Gryan Stoutmantle at Sentinel Hill.' }),
    'The world map\'s quest log: the line under the title, the objectives 10 under it ("Leads to The Deadmines · step 2 of 7")', 'QuestMapDetails'));
  return P;
}

async function main() {
  const out = process.argv[2] || path.join(process.cwd(), 'render');
  fs.mkdirSync(out, { recursive: true });
  const id = vm => vm.evaluate('NQADB.activeChat');
  const panels = [];
  panels.push(panel(hud(), 'Idle, following a route (as in the owner\'s screenshot)'));
  panels.push(panel(hud({ route: false }), 'Idle, no route (the owner, 2026-09-27: "the UI looks like this and its ass")'));
  panels.push(panel(hud({ route: false, setup: vm => vm.run('local b = NS.HUD.h.routeAskBtn; b.scripts.OnClick(b, "LeftButton")') }), 'No route, Ask for a Route clicked: Undo for 3 s, "Asking: a route"'));
  panels.push(panel(hud({ setup: vm => apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "x", summary = "Drew a 5-stop loop: the Fold, then the Thornweavers, then the Crossroads.", more = 0, drew = { "barrens" } }`] })) }), 'News: a reply that drew a route (Okay follows it; its tooltip says so)'));
  panels.push(panel(hud({ route: false, setup: vm => { vm.send('where are the thornweavers'); for (let t = 0; t < 3; t++) { vm.advance(11.7); vm.run('NS.Transport.Beat()'); } } }), 'Sending for 35 s, the message unread: how long, and that it hasn\'t reached NeverQuestAlone'));
  // A reply that drew another route than the one you follow: its first button says Follow Route (C-100).
  const NEW_ROUTE = BARRENS_ROUTE.replace('version = 1, layers = {', 'version = 2, layers = { { name = "mulgore", title = "Red Cloud loop", ordered = true, loop = false, points = { { 1432, 60, 70, "1. Camp", "kill" }, { 1432, 65, 75, "2. Well", "object" } } },');
  panels.push(panel(hud({ setup: vm => apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "x", summary = "Drew a 2-stop loop at Red Cloud Mesa: the camp, then the well.", more = 0, drew = { "mulgore" } }`], extra: NEW_ROUTE })) }), 'News: a reply that drew another route: Follow Route, then Open Chat (C-100)'));
  panels.push(panel(hud({ setup: vm => apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "Long.\\n\\nTL;DR: The Fold is north of the Crossroads; the Thornweavers are on the ridge.", summary = "The Fold is north of the Crossroads; the Thornweavers are on the ridge.", more = 0, chips = { "Route me there", "What drops the beads?" } }`] })) }), 'News: a reply'));
  panels.push(panel(hud({ route: false, setup: vm => { vm.send('where are the thornweavers'); } }), 'Working (no route)'));
  panels.push(panel(hud({ setup: vm => vm.run('local b = NS.HUD.h.askBtn; if b then b.scripts.OnClick(b, "LeftButton") end') }), 'Asking'));
  panels.push(panel(hud({ route: false, db: 'NQADB = {}' }), 'The first run: the setup block in main\'s Welcome\'s place'));
  panels.push(panel(hud({ setup: vm => vm.run('NQADB.settings.hudMin = true') }), 'Minimized'));
  // A ghost: the arrow points to the corpse (Map.lua's corpse view).
  const ghost = vm => vm.run(`UnitIsGhost = function() return true end
    C_DeathInfo = { GetCorpseMapPosition = function(mapID) if mapID == 1432 then return CreateVector2D(0.5, 0.3) end end }
    STUB.FireEvent("PLAYER_ALIVE")
    local d = NQAMap.driver; d.scripts.OnUpdate(d, 0.2)`);
  panels.push(panel(hud({ setup: ghost }), 'A ghost, following a route: the route steps aside, only the way to the corpse'));
  panels.push(panel(hud({ setup: vm => { ghost(vm); vm.run('NQADB.settings.hudMin = true') } }), 'A ghost, minimized'));
  panels.push(panel(hud({ setup: vm => vm.run('local b = NS.HUD.h.replanIcon; b.scripts.OnClick(b, "LeftButton")') }), 'Re-plan clicked: for 3 s its icon is Undo'));
  panels.push(panel(hud({ setup: vm => { vm.send('where are the thornweavers'); vm.run('local b = NS.HUD.h.stopBtn; b.scripts.OnClick(b)'); } }), 'Stop clicked: the same button, greyed, until the run ends'));
  panels.push(panel(hud({ setup: vm => vm.run('local b = NS.HUD.h.segs.hit[2]; b.scripts.OnClick(b, "LeftButton"); NQAMap.UpdateNavigator()') }), 'The bar\'s second part clicked: back to stop 2'));
  panels.push(panel(hud({ setup: vm => { vm.run('local b = NS.HUD.h.askBtn; b.scripts.OnClick(b, "LeftButton")'); vm.run('NS.HUD.h.replyBox:SetText("where do the raptors spawn?")'); } }), 'Asking, with words typed: Ask is the box\'s X'));
  panels.push(panel(hud({ setup: vm => { vm.run('NQADB.settings.hudMin = true'); apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "The Fold is north.", summary = "The Fold is north.", more = 0 }`] })); } }), 'Minimized, with news: NeverQuestAlone says, and Okay'));
  panels.push(panel(hud({ route: false, setup: vm => vm.run('NQADB.settings.hudMin = true') }), 'Minimized, no route'));
  panels.push(panel(hud({ setup: vm => vm.run('NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true') }), 'The compass (the bar\'s Show Less): the arrow and the distance'));
  panels.push(panel(hud({ setup: vm => { ghost(vm); vm.run('NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true') } }), 'The compass, a ghost'));
  panels.push(panel(hud({ route: false, setup: vm => vm.run('NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true') }), 'The compass, no route'));
  const instance = vm => vm.run('local n = NS.MapShared.navView; n.dist, n.bearing, n.where = nil, nil, "off the map"; NS.HUD.TickRoute()');
  panels.push(panel(hud({ setup: vm => { vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()'); instance(vm); } }), 'Minimized in an instance: no arrow, why in grey'));
  panels.push(panel(hud({ setup: vm => { vm.run('NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true; NS.HUD.Render()'); instance(vm); } }), 'The compass in an instance'));
  panels.push(panel(hud({ setup: vm => instance(vm) }), 'The panel in an instance: no column, why on its own'));
  panels.push(panel(hud({ setup: vm => vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton"); NQAMap.UpdateNavigator()') }), 'The HUD closed (its X), following a route: the route\'s own bar'));
  panels.push(panel(hud({ setup: vm => vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton"); NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true; NS.HUD.Render()') }), 'The HUD closed, its form the compass'));
  panels.push(panel(hud({ setup: vm => { vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton")'); apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "The Thornweavers are on the ridge north of the Fold.", summary = "The Thornweavers are on the ridge north of the Fold.", more = 0 }`] })); } }),
    'A reply with the HUD closed: the banner at the top middle, until Okay or Open Chat', 'NQAToast1'));
  panels.push(panel(hud({ setup: vm => { vm.run('local b = NS.HUD.h.closeBtn; b.scripts.OnClick(b, "LeftButton")'); apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "x", summary = "The Thornweavers camp on the ridge north of the Fold; pull them one at a time, since they cast from range and flee at low health.", more = 0 }`] })); } }),
    'A long reply: two lines, the banner as tall as they are', 'NQAToast1'));
  // Folded to the bar by a fight while NeverQuestAlone works: its menu still has Show More, which shows the panel now (the owner, 2026-09-27).
  const fight = vm => { vm.send('where are the thornweavers'); vm.run('NS.UI.Toggle(false); STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")'); };
  const barMenu = vm => vm.run('local g = NQAHUDBar.grip; g.scripts.OnClick(g, "RightButton")');
  panels.push(panel(hud({ setup: fight }), 'In combat, NeverQuestAlone working: folded to the bar'));
  panels.push(panel(hud({ setup: vm => { fight(vm); barMenu(vm); } }), 'In combat, NeverQuestAlone working: the bar\'s right-click menu (Show More always there)', 'NQAPopupMenu'));
  panels.push(panel(hud({ setup: vm => { fight(vm); barMenu(vm); vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show More" then b.scripts.OnClick(b) end end'); } }),
    'In combat, Show More picked: the whole panel, NeverQuestAlone working'));
  // The reply lands mid-fight and Quiet in Combat holds it (C-104): not "Ready".
  const held = vm => { fight(vm); barMenu(vm); vm.run('for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == "Show More" then b.scripts.OnClick(b) end end'); vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end'); apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "Up on the ridge.", summary = "", more = 0 }`] })); };
  panels.push(panel(hud({ route: false, setup: held }), 'In combat, the reply held by Quiet in Combat: the panel (Show More)'));
  panels.push(panel(hud({ setup: vm => { held(vm); vm.run('local b = NS.HUD.h.minBtn; b.scripts.OnClick(b)'); } }), 'In combat, the reply held: the bar'));
  // The bar re-planning: its row says so (no 4/6 on the bar since 0.4.8).
  panels.push(panel(hud({ setup: vm => { vm.run('NQADB.settings.hudMin = true; NS.HUD.Replan()'); vm.advance(3.1); vm.run('for _, c in ipairs(NQADB.chats) do c.pending = {} end'); } }), 'Minimized, Re-planning…'));
  // 0.4.9: the status lines a click away (never "the portrait's tooltip says how"), and the bar's Okay on what its row shows (E-1).
  const lightIs = (state, extra = '') => vm => vm.run(`${extra} NS.Transport.Light = function() return "${state}", "The NeverQuestAlone app is running but can't reach your AI: connecting." end`);
  panels.push(panel(hud({ route: false, setup: lightIs('grey') }), 'Not ready: Click to see why in the window (the lines are a button)'));
  panels.push(panel(hud({ route: false, setup: lightIs('yellow', 'NS.R.gw = { state = "connecting" };') }), 'Can\'t reach your AI: Click to see why in the window'));
  panels.push(panel(hud({ setup: vm => vm.run('NS.Transport.Warn("t", "Replies arrive more slowly for now: the game can\'t hear the sound that says a reply is ready. A /reload usually fixes it.", "Replies are slower for now")') }), 'A warning from the transport: Click for the details'));
  const barNews = vm => { vm.run('NQADB.settings.hudMin = true'); apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id(vm)}", mid = "m1", agent = "main", text = "The Fold is north.", summary = "", more = 0 }`] })); };
  panels.push(panel(hud({ setup: vm => { barNews(vm); vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 24)'); } }), 'Minimized, a ding over unread news: its Okay ends the ding first (E-1)'));
  panels.push(panel(hud({ setup: vm => { barNews(vm); vm.advance(200); } }), 'Minimized, the app silent over unread news: no Okay (E-1)'));
  // Quest chains (Chains.lua) in the HUD's list: a human warrior at a stop whose quests lead somewhere.
  const chains = (setup = null) => hud({ route: false, extra: CHAIN_LOG, setup: vm => {
    apply(vm, slotLua({ extra: CHAIN_ROUTE }));
    vm.run('NQAMap.Command("nav chains 1"); NQAMap.UpdateNavigator(); NS.HUD.Render()');
    if (setup) setup(vm);
  } });
  panels.push(panel(chains(), 'Chained quests at a stop: under a quest\'s name, its payoff\'s icon and where it leads (a dungeon, a reward "or 2 more", a raid under a ready quest\'s row); nothing under a quest that leads nowhere'));
  panels.push(panel(chains(vm => vm.run('NQAMap.Command("nav chains 2"); NQAMap.UpdateNavigator(); NS.HUD.Render()')),
    'The longest: a legendary reward in two lines, without its step; a breadcrumb with no step, and a step with no count'));
  panels.push(panel(chains(vm => vm.run('NQAMap.Command("nav chains 3"); NQAMap.UpdateNavigator(); NS.HUD.Render()')),
    'Chains, ready and to pick up: a ready last step to a dungeon says nothing (you\'ve been), a reward\'s keeps its line, one to pick up here says where it leads'));
  panels.push(panel(chains(vm => vm.run('NQADB.settings.chains = false; NS.HUD.Render()')), 'Settings\' Quest Chains off: no chain lines, the list as before'));
  // QOL=1: the Quality of Life step (QoL.lua), in a session after the first
  // reply's, on a client with the game's Auto Loot setting and loot key.
  if (process.env.QOL) {
    panels.length = 0;
    const key = k => `function GetModifiedClick(a) if a == "AUTOLOOTTOGGLE" then return "${k}" end end`;
    const step = { db: 'NQADB = { hudIntro = true, firstReply = true }', extra: `STUB.cvars.autoLootDefault = "0"; STUB.cvars.autoQuestWatch = "1"; ${key('SHIFT')}` };
    const untick = (...rows) => vm => vm.run(rows.map(i => `do local c = NS.HUD.h.qolChecks[${i}]; c.scripts.OnClick(c) end`).join('\n'));
    panels.push(panel(hud({ ...step, route: false }), 'The Quality of Life step, as it first shows (the HUD ready, a session after the first reply\'s)'));
    panels.push(panel(hud({ ...step, route: false, setup: untick(5) }), 'One unchecked (Auto Sell Junk)'));
    panels.push(panel(hud({ ...step, route: false, setup: untick(1, 2, 3, 4, 5) }), 'All unchecked: Turn On waits, and says why'));
    panels.push(panel(hud({ ...step }), 'The step while a route is followed'));
    panels.push(panel(hud({ ...step, route: false, extra: `STUB.cvars.autoLootDefault = "0"; STUB.cvars.autoQuestWatch = "1"; ${key('CTRL')}` }), 'The loot key is Ctrl: the text names it (its longest)'));
    panels.push(panel(hud({ ...step, route: false, extra: `STUB.cvars.autoLootDefault = "1"; STUB.cvars.autoQuestWatch = "1"; ${key('SHIFT')}` }), 'Auto Loot already on: four rows, no loot in the text'));
    panels.push(panel(hud({ ...step, route: false, db: 'NQADB = {}' }), 'Before it: the first run\'s setup block'));
    panels.push(panel(hud({ ...step, route: false, setup: vm => vm.run('local b = NS.HUD.h.qolOn; b.scripts.OnClick(b)') }), 'After Turn On: the HUD rests'));
  }
  // ONLY=<words>: just the panels whose caption has them, for a quick look.
  if (process.env.ONLY) {
    const keep = panels.filter(p => p.caption.includes(process.env.ONLY));
    panels.length = 0;
    panels.push(...keep);
  }
  if (process.env.WINDOW) {
    panels.length = 0;
    const talk = vm => {
      const id = vm.evaluate('NQADB.activeChat');
      vm.send('where are the thornweavers?');
      vm.run('local keys = {} for k in pairs(NS.R.out) do keys[#keys + 1] = k end for _, k in ipairs(keys) do NS.Transport.Acked(k, "slot") end'); // the app read it
      apply(vm, slotLua({ records: [`{ seq = 1, t = "reply", chat = "${id}", mid = "m1", agent = "main", text = "Up on the ridge north of the Fold, past the second tent. They cast from range, so pull them one at a time.\\n\\nTL;DR: The Thornweavers are on the ridge north of the Fold; pull one at a time.", summary = "The Thornweavers are on the ridge north of the Fold; pull one at a time.", more = 0, chips = { "Route me there", "What drops the beads?" } }`] }));
    };
    panels.push(windowPanel(win({ setup: talk }), 'Window: a question and its reply'));
    panels.push(windowPanel(win({ setup: vm => { talk(vm); vm.send('and the hunters?'); } }), 'Window: working'));
    panels.push(windowPanel(win(), 'Window: an empty chat'));
    panels.push(windowPanel(win({ setup: talk, list: true }), 'Window: the chat list shown'));
    // The owner's list (2026-09-27, "not so crammed"): two pinned chats, then Quick questions, open.
    const twoPinned = vm => {
      vm.run('local a = NS.Chats.New("Companion"); NS.Chats.SetPinned(a.id, true); local b = NS.Chats.New("For the build im going"); NS.Chats.SetPinned(b.id, true); local q = NS.QuickChat(); NS.Chats.Switch(q.id)');
      talk(vm);
    };
    panels.push(windowPanel(win({ setup: twoPinned, list: true }), 'Window: the owner\'s list, two pinned and Quick questions open'));
    const ready = vm => { talk(vm); apply(vm, slotLua({ bridge: ', caps = { "upd" }, update = { state = "update", repo = "0.4.1", installed = "0.4.0", loaded = "0.4.0", at = time() }' })); };
    panels.push(windowPanel(win({ setup: ready, list: true }), 'Window: the list, an update ready'));
    const typed = (vm, text) => vm.run(`NS.UI.ui.input:SetText(${JSON.stringify(text)}); NS.UI.ui.input.scripts.OnEnterPressed(NS.UI.ui.input)`);
    panels.push(windowPanel(win({ setup: vm => { vm.run('NS.R.skipGameData = true'); typed(vm, 'where are the thornweavers?'); } }), 'Window: game data unticked, a message sent without it'));
    const restart = vm => { talk(vm); apply(vm, slotLua({ bridge: ', caps = { "upd" }, update = { state = "restart", repo = "0.4.1", installed = "0.4.1", loaded = "0.4.1", files = { "Newthing.lua" }, at = time(), n = 3 }' })); };
    panels.push(windowPanel(win({ setup: restart, list: true }), 'Window: an update that added a file: restart WoW'));
    // A status line too long for one line at a narrow width: two, the panes a line lower.
    panels.push(windowPanel(win({ setup: vm => vm.slash('stream on') }), 'Window: no screen reading (its status line on two lines)'));
    // /nqa help: where a line won't fit, each command on a line of its own and its words under it.
    panels.push(windowPanel(win(), 'Window: /nqa help, at its start', { after: vm => vm.slash('help') }));
    panels.push(windowPanel(win({ setup: vm => vm.run('NQADB.settings.textSize = "xlarge"') }), 'Window: /nqa help at Extra Large text', { after: vm => vm.slash('help') }));
  }
  if (process.env.SETTINGS) {
    panels.length = 0;
    const page = settingsRows();
    const turnIn = vm => vm.run('NS.QoL.Set("qolTurnIn", true, true)');
    panels.push(settingsPanel(page, 'The whole page (0.5.3): each choice a slider or check-box rows, no dropdown; the Map row whole (Next Stop as a Waypoint, C-123); Auto Turn In Quests off, so Quest Rewards\' rows are indented and grayed, at 12 pt (QL-36)', { page: true }));
    panels.push(settingsPanel(section(page, 'Replies'), 'Replies as it first shows: TL;DR and Medium, the defaults'));
    panels.push(settingsPanel(section(settingsRows({ setup: vm => vm.run('NQADB.settings.echo = "off"; NQADB.settings.textSize = "small"') }), 'Replies'),
      'Replies at the left ends: Off and Small (the left arrows dim)'));
    panels.push(settingsPanel(section(settingsRows({ setup: vm => vm.run('NQADB.settings.echo = "full"; NQADB.settings.textSize = "large"') }), 'Replies'),
      'Replies at the right ends: Whole Reply and Large'));
    // A row's tooltip, as the list shows it (Settings.InitTooltip: its name, then its words, wrapped).
    const tipOf = (rows, name) => ({ row: name, title: name, lines: [{ text: rows.find(r => r.name === name).tip }] });
    const quests = section(page, 'Quests');
    panels.push(settingsPanel(quests, 'Quests: Quest Chains, on by default (Chains.lua\'s line on the quest pages and the HUD); its tooltip', { tip: tipOf(quests, 'Quest Chains') }));
    const qol = section(page, 'Quality of Life');
    panels.push(settingsPanel(qol, 'Quality of Life, Auto Turn In Quests off: Quest Rewards\' three rows under it, indented and grayed at 12 pt (no parent link, QL-36), Your Pick checked; its tooltip says what the rule is for first (C-122)',
      { tip: tipOf(qol, 'Quest Rewards: Your Pick') }));
    const on = section(settingsRows({ setup: turnIn }), 'Quality of Life');
    panels.push(settingsPanel(on, 'Auto Turn In Quests on: the three rows ready, Your Pick checked; Highest Price\'s tooltip', { tip: tipOf(on, 'Quest Rewards: Highest Price') }));
    const picked = section(settingsRows({ setup: vm => { turnIn(vm); vm.run(`STUB.byName[${lstr('Quest Rewards: Best Upgrade')}].set(true)`); } }), 'Quality of Life');
    panels.push(settingsPanel(picked, 'Best Upgrade clicked: it alone checked', { tip: tipOf(picked, 'Quest Rewards: Best Upgrade') }));
    // The Options search (SettingsPanelMixin:OnSearchTextChanged): each row whose name has the words, under the
    // list's "Search Results" and no Defaults; with no parent link, a row shows without Auto Turn In Quests above it
    // (QL-36), grayed while it's off, and its tooltip says what it's for (C-122). The addon's rows only; the game's
    // own aren't modeled.
    const found = page.filter(r => r.kind === 'checkbox' && r.name.toUpperCase().includes('REWARD'));
    panels.push(settingsPanel(found, 'An Options search for "reward", Auto Turn In Quests off: Quest Rewards\' rows on their own, grayed, each tooltip with its context',
      { search: true, tip: tipOf(found, 'Quest Rewards: Your Pick') }));
    // Our own window, where the game's Settings list is missing: buttons that step through a choice, as before.
    const own = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true, firstReply = true }', extra: METRICS }).login());
    own.slash('settings');
    panels.push(panel(own, 'Our own window (no Settings API): each choice a button that steps to the next, unchanged', 'NQASettings'));
  }
  if (process.env.ADDONS) {
    panels.length = 0;
    panels.push(...await addonsPanels());
  }
  if (process.env.KEYBINDINGS) {
    panels.length = 0;
    panels.push(...await keybindingsPanels());
  }
  if (process.env.STRIP) {
    panels.length = 0;
    panels.push(stripScreen({ w: 1920, h: 1080 }, '1920 x 1080 with no UI scale (a unit a pixel), the hello at login, at 1:1'));
    panels.push(stripScreen({ w: 1920, h: 1080, ui: 1, send: 'where do I turn in the wolf pelts?' }, '1920 x 1080 at UI scale 1, a message on its way, at 1:1'));
    panels.push(stripScreen({ w: 2880, h: 1800, ui: 1, pv: 0.5, band: 360 }, 'A Retina 2880 x 1800 at UI scale 1, at 0.5 (the Mac\'s points)'));
    panels.push(stripScreen({ w: 1024, h: 768 }, '1024 x 768: one line won\'t fit beside it, so two, at 1:1'));
    panels.push(stripScreen({ w: 800, h: 600, band: 300 }, '800 x 600: no room beside it, so under its whole 48 rows, at 1:1'));
    panels.push(stripScreen({ w: 1920, h: 1080, slash: 'stream on' }, 'Screen reading just turned off: the strip tells the app so, for about 5 s, at 1:1'));
  }
  // PARTS=1: a part that won't load (C-121), after the hello: the HUD's line and the window's notice.
  if (process.env.QUEST) {
    panels.length = 0;
    panels.push(...questPanels());
  }
  if (process.env.PARTS) {
    panels.length = 0;
    const fail = code => vm => vm.run(`STUB.slotReason = "${code}"; NS.Transport.LoadSlot("push")`);
    panels.push(panel(hud({ route: false, setup: fail('DISABLED') }), 'The parts turned off in the AddOns list (their row\'s "Disable All AddOns"): the HUD\'s line; a click shows how to turn them back on'));
    panels.push(panel(hud({ route: false, setup: fail('MISSING') }), 'A part missing, or out of date after a patch: the HUD\'s line'));
    panels.push(windowPanel(win({ setup: fail('DISABLED') }), 'The window: the whole notice (the chat frame says it too)'));
  }
  const file = path.join(out, 'hud.html');
  fs.writeFileSync(file, page('HUD preview', panels, { scale: SCALE }));
  console.log(file);
  // One page per state too, for screenshots (hud-1.html …, with its size).
  panels.forEach((p, i) => {
    const one = path.join(out, `hud-${i + 1}.html`);
    fs.writeFileSync(one, page(p.caption, [p], { scale: SCALE }));
    console.log(one, Math.ceil((p.w + 80) * SCALE), Math.ceil((p.h + 80) * SCALE));
  });
}

main().catch(e => { console.error(e); process.exit(1); });
