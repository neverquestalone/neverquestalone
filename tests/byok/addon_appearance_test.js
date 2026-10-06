'use strict';
// The additive appearance options (the consolidation's commit 5, S; the owner's "settings
// page more personalizable for appearance"): Chat Text Size › Extra Large, Message Times,
// Name on Your Messages. Each defaults to main's exact look, and the code that reads them
// draws main's bytes at their defaults. None touches the widget's layout.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM, reloadVM } = require('../helpers/nqa-vm');
const { PUBLIC, ring, byokSlot, confirmHello, apply, errorRec } = require('../helpers/byok-slots');

const FONTS = `
GameFontDisable = { GetFont = function() return "Fonts\\\\FRIZQT__.TTF", 12, "" end }
ChatFontNormal = { GetFont = function() return "Fonts\\\\ARIALN.TTF", 14, "" end }
`;
// The game's Settings list as the addon uses it since 0.5.3 (E-047): check boxes and sliders, each
// slider's words at its right; every way the API has to make a dropdown counts itself in
// STUB.dropdowns, and every parent link in STUB.parentLinks: the public build makes none (QL-37, QL-36).
const SETTINGS = `
STUB.controls, STUB.settings, STUB.sliders, STUB.dropdowns, STUB.parentLinks = {}, {}, {}, {}, {}
local function Init(name)
	local i = { control = name }
	function i:SetParentInitializer() table.insert(STUB.parentLinks, name) end
	function i:Indent() end
	function i:AddModifyPredicate() end
	function i:AddEvaluateStateCVar() end
	return i
end
local function Dropdown(name) return function() table.insert(STUB.dropdowns, name) end end
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name) STUB.category = { name = name, GetID = function() return 42 end }; return STUB.category, {} end,
	RegisterInitializer = function() end,
	RegisterProxySetting = function(cat, var, vt, name, def, get, set) local s = { var = var, name = name, def = def, get = get, set = set }; function s:NotifyUpdate() end; STUB.settings[var] = s; return s end,
	CreateCheckbox = function(cat, s) table.insert(STUB.controls, "checkbox: " .. s.name); return Init(s.name) end,
	CreateControlTextContainer = function() local c = { data = {} }; function c:Add(v, l) table.insert(self.data, { value = v, label = l }) end; function c:GetData() return self.data end; return c end,
	CreateSliderOptions = function(min, max, step) local o = { minValue = min, maxValue = max, step = step }; function o:SetLabelFormatter(kind, fn) self.fmt = fn end; return o end,
	CreateSlider = function(cat, s, o) STUB.sliders[s.name] = o; table.insert(STUB.controls, "slider: " .. s.name .. " " .. o.minValue .. "-" .. o.maxValue); return Init(s.name) end,
	CreateDropdown = Dropdown("Settings.CreateDropdown"), CreateDropdownInitializer = Dropdown("Settings.CreateDropdownInitializer"),
	CreateDropdownOptionInserter = Dropdown("Settings.CreateDropdownOptionInserter"), CreateDropdownButton = Dropdown("Settings.CreateDropdownButton"),
	CreateDropdownCheckbox = Dropdown("Settings.CreateDropdownCheckbox"), InitDropdown = Dropdown("Settings.InitDropdown"),
	SetupCVarDropdown = Dropdown("Settings.SetupCVarDropdown"), SetupModifiedClickDropdown = Dropdown("Settings.SetupModifiedClickDropdown"),
	RegisterAddOnCategory = function() end, OpenToCategory = function() end,
}
CreateSettingsCheckboxDropdownInitializer = Dropdown("CreateSettingsCheckboxDropdownInitializer")
function CreateSettingsListSectionHeaderInitializer(name) return { header = name } end
function CreateSettingsButtonInitializer(name) return { name = name } end
MinimalSliderWithSteppersMixin = { Label = { Left = 1, Right = 2 } }
`;
// The public build: an app install whose first slot is its BYOK bridge's (the window open).
function pub(extra = '', db) {
  const vm = newVM({ extra: PUBLIC + extra, ...(db ? { db } : {}) }).login();
  vm.advance(3.1);
  vm.slot(byokSlot({ nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  vm.slash('');
  return vm;
}
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');

test('Extra Large: the chat text and the box at 20 pt; the composer\'s hint stops at Large (17) so two lines fit main\'s box; /nqa text xlarge; the Settings slider\'s fourth step (no dropdown, E-047)', () => {
  const vm = pub(FONTS + SETTINGS);
  vm.run('NS.Chats.Send("hello there")');
  vm.slash('text xlarge');
  assert.equal(vm.evaluate('NQADB.settings.textSize'), 'xlarge');
  assert.equal(notice(vm), 'Chat Text Size: Extra Large. Settings has it too.', 'the Settings row\'s name and its choice\'s words (main\'s answer, C-116)');
  assert.equal(vm.num('NS.UI.ui.bubbles[1].body.fontSize'), 20);
  assert.equal(vm.num('NS.UI.ui.input.fontSize'), 20);
  assert.equal(vm.num('NS.UI.ui.hint.fontSize'), 17, 'the hint stops at Large');
  vm.slash('text medium');
  assert.equal(vm.num('NS.UI.ui.hint.fontSize'), 14, 'main\'s size at Medium');
  // Settings: a slider through the four sizes, least to most, the size's words at its right; no dropdown.
  assert.ok(vm.list('STUB.controls').includes('slider: Chat Text Size 1-4'), vm.list('STUB.controls').join('\n'));
  assert.deepEqual([1, 2, 3, 4].map(n => vm.evaluate(`STUB.sliders["Chat Text Size"].fmt(${n})`)), ['Small', 'Medium', 'Large', 'Extra Large']);
  assert.deepEqual(vm.list('STUB.dropdowns'), [], 'no dropdown');
  vm.run('STUB.settings.NQA_TEXTSIZE.set(4)');
  assert.equal(vm.evaluate('NQADB.settings.textSize'), 'xlarge');
  assert.equal(vm.num('STUB.settings.NQA_TEXTSIZE.get()'), 4, 'read back as its step');
  vm.run('STUB.settings.NQA_TEXTSIZE.set(9)');
  assert.equal(vm.evaluate('NQADB.settings.textSize'), 'xlarge', 'never past the largest');
  vm.slash('help all');
  assert.ok(notice(vm).includes('/nqa text small||medium||large||xlarge|r  Set the text size'), notice(vm));
});

test('Message Times: on by default (main\'s "17:05" at the top right); off, no time on any bubble at once; an error\'s details still say when', () => {
  const vm = pub(SETTINGS);
  const id = vm.evaluate('NQADB.activeChat');
  vm.run('NS.Chats.Send("hello there")');
  assert.equal(vm.evaluate('NQADB.settings.times'), 'true');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].when.text'), '12:00');
  assert.ok(vm.list('STUB.controls').includes('checkbox: Message Times'));
  const sw = vm.evaluate('(function() for i, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == "Message Times" then return i end end end)()');
  vm.run(`STUB.settings.NQA_SWITCH_${sw}.set(false)`);
  assert.equal(vm.evaluate('NQADB.settings.times'), 'false');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].when.text'), '', 'gone at once');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, byokSlot({ records: [errorRec(1, id, 'overloaded', 'retry', 'Anthropic is busy right now.')] }));
  const e = 'NS.Chats.Active().history[#NS.Chats.Active().history]';
  assert.match(vm.evaluate(`NS.UI.ErrorDetails(${e})`), /\nWhen: 12:00\./, 'the details keep their time');
  vm.run(`STUB.settings.NQA_SWITCH_${sw}.set(true)`);
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].when.text'), '12:00');
  // The game's clock setting (CF-UX-32, STYLE §8): 12-hour when its 24-hour time is off.
  vm.run('STUB.cvars.timeMgrUseMilitaryTime = "0"; NS.UI.LookChanged()');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].when.text'), '12:00 PM');
  assert.match(vm.evaluate(`NS.UI.ErrorDetails(${e})`), /\nWhen: 12:00 PM\./);
});

test('Name on Your Messages: "You" by default; your character\'s name in the window and the chat list when you pick it; the saved data keeps the choice, never the name; nothing sent changes', () => {
  const vm = pub(SETTINGS);
  // Settings: a check box row per option, exactly one checked (no dropdown, E-047).
  const controls = vm.list('STUB.controls');
  assert.deepEqual(controls.filter(c => c.includes('Name on Your Messages')), ['checkbox: Name on Your Messages: You', 'checkbox: Name on Your Messages: Testchar']);
  assert.deepEqual(vm.list('STUB.dropdowns'), [], 'no dropdown');
  assert.deepEqual(vm.list('STUB.parentLinks'), [], 'no parent link');
  assert.deepEqual([vm.evaluate('STUB.settings.NQA_YOUNAME_YOU.get()'), vm.evaluate('STUB.settings.NQA_YOUNAME_CHARACTER.get()')], ['true', 'false']);
  vm.run('NS.Chats.Send("hello there")');
  const wireYou = vm.outboxWires().at(-1).wire;
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].who.text'), 'You · sending');
  vm.run('STUB.settings.NQA_YOUNAME_CHARACTER.set(true)');
  assert.deepEqual([vm.evaluate('STUB.settings.NQA_YOUNAME_YOU.get()'), vm.evaluate('STUB.settings.NQA_YOUNAME_CHARACTER.get()')], ['false', 'true'], 'one checked');
  assert.equal(vm.evaluate('NQADB.settings.youName'), 'character', 'the choice, never the name');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].who.text'), 'Testchar · sending', 'at once');
  assert.equal(vm.evaluate('NS.Chats.Preview(NS.Chats.Active(), 40)'), 'Testchar: hello there');
  assert.ok(!vm.saved().includes('Testchar"'), 'the name isn\'t saved');
  vm.run('NS.Chats.Send("hello there")');
  const wireName = vm.outboxWires().at(-1).wire;
  const same = w => w.replace(/_\d+\x1f/, '_N\x1f'); // the send's own number aside
  assert.equal(same(wireName), same(wireYou), 'the same words go out');
  assert.ok(!wireName.includes('Testchar'), 'never sent');
});

test('the saved options are cleaned at load: junk goes back to main\'s look', () => {
  const vm = confirmHello(newVM({ extra: PUBLIC, db: 'NQADB = { settings = { times = "yes", youName = "Arthas", textSize = "huge" } }' }).login());
  assert.equal(vm.evaluate('NQADB.settings.times'), 'true');
  assert.equal(vm.evaluate('NQADB.settings.youName'), 'you');
  assert.equal(vm.evaluate('NQADB.settings.textSize'), 'medium');
  const again = reloadVM(pub('', 'NQADB = { settings = { textSize = "xlarge", times = false, youName = "character" } }')).login();
  assert.equal(again.evaluate('NQADB.settings.textSize'), 'xlarge');
  assert.equal(again.evaluate('NQADB.settings.times'), 'false');
  assert.equal(again.evaluate('NQADB.settings.youName'), 'character');
});

test('saved choices draw from the first frame of the next session: Extra Large, your character\'s name, no times', () => {
  const db = 'NQADB = { settings = { textSize = "xlarge", times = false, youName = "character" } }';
  const vm = pub(FONTS, db);
  vm.run('NS.Chats.Send("hello there")');
  assert.equal(vm.num('NS.UI.ui.bubbles[1].body.fontSize'), 20);
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].who.text'), 'Testchar · sending');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].when.text'), '');
});

test('our own window (no Settings API): the Message Times check, and the cycles through Extra Large and Name on Your Messages', () => {
  const vm = pub();
  vm.slash('settings');
  const labels = vm.list('(function() local o = {} for _, cb in pairs(NS.Settings.page.checks) do o[#o + 1] = cb.label.text end table.sort(o) return o end)()');
  assert.ok(labels.includes('Message Times') && labels.includes('Reply Cost'), labels.join('|'));
  // A choice's place in the list (Quality of Life's Quest Rewards sits between main's two and the public build's row).
  const at = (v, label) => v.num(`(function() for i, ch in ipairs(NS.Settings.CHOICES) do if ch[2] == "${label}" then return i end end end)()`);
  const sizeAt = at(vm, 'Chat Text Size'), nameAt = at(vm, 'Name on Your Messages');
  const cycle = i => vm.run(`local b = NS.Settings.page.cycles[${i}]; b.scripts.OnClick(b)`);
  const size = () => vm.evaluate('NQADB.settings.textSize');
  cycle(sizeAt); assert.equal(size(), 'large');
  cycle(sizeAt); assert.equal(size(), 'xlarge');
  assert.equal(vm.evaluate(`NS.Settings.page.cycles[${sizeAt}].text`), 'Extra Large');
  cycle(sizeAt); assert.equal(size(), 'small');
  cycle(nameAt);
  assert.equal(vm.evaluate('NQADB.settings.youName'), 'character');
  assert.equal(vm.evaluate(`NS.Settings.page.cycles[${nameAt}].text`), 'Testchar');
});
