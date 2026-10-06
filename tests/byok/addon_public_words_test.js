'use strict';
// The words on main's widget (the consolidation plan's commit 1, D; PRD C-04,
// C-05, C-14, UX-5, UX-6): "NeverQuestAlone", never NeverQuestAlone, the bridge, the
// gateway, pairing or a private term (SCRUB_TERMS: tests/helpers/private-terms.js),
// and no "he" or "his" in our own words; the companion named through ns.P; /nqa. One build since
// the retired build went: an install's TOC stamp (PUBLIC, the app's) changes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM, reloadVM, lstr } = require('../helpers/nqa-vm');
const { PUBLIC, ring, provider, usage, capped, byokSlot, confirmHello, apply, replyRec, errorRec } = require('../helpers/byok-slots');
const { PRIVATE_SKIP, privateTerms } = require('../helpers/private-terms');

const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
const activeId = vm => vm.evaluate('NQADB.activeChat');
const plain = t => String(t ?? '').replace(/\|H[^|]*\|h/g, '').replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '').replace(/\|A:[^|]*\|a/g, '');
// An install the desktop app made, logged in.
const appVM = (opts = {}) => newVM({ ...opts, extra: PUBLIC + (opts.extra || '') }).login();
// ...and its first slot, from a BYOK bridge (the hello answered on it).
function byokFirst(slot = {}, opts = {}) {
  const vm = appVM(opts);
  vm.advance(3.1);
  vm.slot(byokSlot({ ...slot, nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}

// ---------------------------------------------------------------- the backend from load (R3)

test('one build from load, whatever installed it: /nqa (no /oc), the keys\' section NeverQuestAlone, and no saved backend (0.5.3\'s is dropped at load)', () => {
  for (const vm of [appVM(), newVM().login()]) {
    assert.equal(vm.evaluate('BINDING_HEADER_NQA'), 'NeverQuestAlone');
    assert.equal(vm.evaluate('SLASH_BONES1'), '/nqa');
    assert.equal(vm.evaluate('SLASH_BONES2'), '/bones', '/bones, the earlier command, still works');
    assert.equal(vm.evaluate('SLASH_BONESOC1'), null, 'no /oc');
    assert.equal(vm.evaluate('NQADB.backend'), null);
  }
  // Saved data from 0.5.3, which kept which of its two builds the last slot came from.
  const older = newVM({ db: 'NQADB = { cursor = 12, reported = 12, token = "0a1b2c3d", backend = "legacy" }' }).login();
  assert.equal(older.evaluate('NQADB.backend'), null, 'dropped at load');
  assert.equal(older.evaluate('SLASH_BONES1'), '/nqa');
  assert.equal(older.evaluate('select(2, NS.Transport.Light())'), 'Waiting to hear from the NeverQuestAlone app…');
});

test('a slot whose provider part failed (bridge.backend "byok", no provider): the app\'s words, never the retired build\'s, the bridge\'s, pairing or a private term', async (t) => {
  const vm = byokFirst();
  // What the bridge sends when its provider and usage views throw (a provider gone from the manifests).
  const failed = byokSlot().replace(/, provider = \{[^}]*\}, usage = \{[^}]*\}/, '').replace(/rt = \{[^}]*\}, /, '')
    .replace('gw = { state = "ready"', 'gw = { state = "no_key", reason = "unknown provider"');
  assert.ok(!failed.includes('provider = {') && failed.includes('backend = "byok"'), failed);
  apply(vm, failed);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('BINDING_HEADER_NQA'), 'NeverQuestAlone');
  const said = [vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text'), vm.evaluate('select(2, NS.Transport.Light())')].join(' | ');
  assert.doesNotMatch(said, /bridge|pairing/i, said);
  assert.match(said, /can't reach your AI: unknown provider\./, said);
  await t.test('nor a private term (SCRUB_TERMS)', { skip: PRIVATE_SKIP }, async () => {
    assert.deepEqual((await privateTerms()).hits([said]), []);
  });
  vm.slash('');
  vm.slash('diag');
  assert.match(notice(vm), /\nProvider: no report from NeverQuestAlone yet\n/);
  assert.doesNotMatch(notice(vm), /Gateway/);
});

test('C-05: /nqa probe and /nqa state say the desktop app, never the bridge', () => {
  const vm = byokFirst();
  vm.slash('');
  vm.slash('probe');
  const probe = plain(notice(vm));
  assert.match(probe, /told NeverQuestAlone /);
  vm.slash('state');
  const state = plain(notice(vm));
  assert.match(state, /^.*\nNeverQuestAlone has seq /m);
  assert.match(state, /Milestones waiting for NeverQuestAlone: \d+\. Companion (on|off); NeverQuestAlone caps: /);
  for (const t of [probe, state]) assert.doesNotMatch(t, /bridge/i, t);
});

// ---------------------------------------------------------------- UX-6

test('the command is /nqa, and /bones still works, unlisted (the owner, 2026-10-05): both run the one handler, in the chat frame and the window\'s box; no help line or tooltip shows /bones', () => {
  const vm = byokFirst();
  vm.slash('');
  // The game's slash table: /nqa first, /bones its silent alias, one handler (and /br for replies).
  assert.deepEqual([vm.evaluate('SLASH_BONES1'), vm.evaluate('SLASH_BONES2'), vm.evaluate('SLASH_BONES3'), vm.evaluate('SLASH_BONESREPLY1')], ['/nqa', '/bones', null, '/br']);
  assert.equal(vm.evaluate('tostring(SlashCmdList.BONES ~= nil)'), 'true');
  // Typed in the window's box, either one runs the command.
  vm.run('NS.UI.ui.input:SetText("/bones chat"); NS.UI.SendFromInput()');
  assert.match(notice(vm), /^Chats \(\/nqa chat <number> opens one\):/, '/bones chat lists them, and the answer names /nqa');
  vm.run('NS.UI.ui.input:SetText("/nqa help all"); NS.UI.SendFromInput()');
  const help = plain(notice(vm));
  assert.ok(help.includes('/nqa  Open or close the window'), help);
  assert.doesNotMatch(help, /\/bones\b/, 'the help never shows /bones');
  vm.run('SlashCmdList.BONES("help")');
  assert.doesNotMatch(plain(notice(vm)), /\/bones\b/);
  // The help's every line starts with /nqa or /br.
  for (const l of help.split('\n').filter(x => x.startsWith('/'))) assert.match(l, /^\/(nqa|br)\b/, l);
});

test('UX-6: /nqa is the command, in the chat frame and the window\'s box; /oc isn\'t one', () => {
  const vm = byokFirst();
  vm.slash('');
  vm.run('SlashCmdList.BONES("help all")');
  assert.ok(plain(notice(vm)).includes('/nqa  Open or close the window'), notice(vm));
  assert.doesNotMatch(notice(vm), /\/oc\b/, 'no /oc in the help');
  vm.run('NS.UI.ui.input:SetText("/oc help"); NS.UI.SendFromInput()');
  assert.match(notice(vm), /^Not a command: \/oc\./);
  vm.run('NS.UI.ui.input:SetText("/nqa chat"); NS.UI.SendFromInput()');
  assert.match(notice(vm), /^Chats \(\/nqa chat <number> opens one\):/);
});

test('N-1: /nqa update names the desktop app, which keeps the addon up to date; the chat list has no version line or update button', () => {
  const vm = byokFirst();
  vm.slash('');
  vm.run('NS.UI.Update = function() STUB.updateCalled = true end');
  vm.slash('update');
  assert.equal(notice(vm), 'The NeverQuestAlone app keeps the addon up to date.');
  assert.equal(vm.evaluate('STUB.updateCalled'), null, 'nothing asks a bridge for updates');
  assert.equal(vm.outboxWires().length, 0);
  vm.slash('update install');
  assert.equal(notice(vm), 'The NeverQuestAlone app keeps the addon up to date.');
  assert.equal(vm.outboxWires().length, 0, 'nothing asks for updates from the game');
  vm.run('NS.UI.SetListShown(true); NS.Refresh("all")');
  assert.equal(vm.evaluate('NS.UI.ui.updateBtn'), null);
  assert.equal(vm.evaluate('NS.UI.ui.version'), null);
  assert.equal(vm.evaluate('NQAUpdateButton'), null);
  vm.slash('help');
  assert.doesNotMatch(notice(vm), /\/nqa update/);
  // A bridge that offers updates from the game (cap upd, bridge.update): nothing in the addon offers them.
  apply(vm, byokSlot().replace(/caps = \{/, 'caps = { "upd", ').replace('think = "medium"', 'think = "medium", update = { state = "update", repo = "0.9.0", installed = "0.5.3", loaded = "0.5.3", at = time() }'));
  vm.run('NS.Refresh("all")');
  assert.doesNotMatch(vm.evaluate('NS.UI.StatusText()'), /update/i);
});

// ---------------------------------------------------------------- UX-5, the persona

test('UX-5: the companion\'s name runs through the addon\'s own words (the window, the bindings, the map, the chat frame\'s prefix); where they mean the product, "NeverQuestAlone" stays', () => {
  const vm = byokFirst({ p: provider({ companion: 'Nova' }), companion: 'Nova' });
  vm.slash('');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.Name()'), 'Nova');
  assert.equal(vm.evaluate('NS.UI.ui.hint.text'), 'Ask anything (Up Arrow brings back what you sent)', 'main\'s hint, with no name (PUI-22; the owner, 2026-10-05)');
  // The key bindings: main's names (Title Case, STYLE §6), under the product's header.
  assert.equal(vm.evaluate('BINDING_NAME_NQA_OPEN_AND_TYPE'), 'Open or Close the Window');
  assert.equal(vm.evaluate('BINDING_HEADER_NQA'), 'NeverQuestAlone');
  const nessa = byokFirst({ p: provider({ companion: 'Nessa' }), companion: 'Nessa' });
  assert.equal(nessa.evaluate('NS.P("Update NeverQuestAlone, then ask NeverQuestAlone.")'), 'Update NeverQuestAlone, then ask Nessa.', 'the product\'s name survives any persona');
  // Where the words mean the product, its name stays: the app, the addon, a menu path (STYLE §11).
  assert.equal(nessa.evaluate('NS.P("NeverQuestAlone answered. Open the NeverQuestAlone app, the NeverQuestAlone addon or Options > AddOns > NeverQuestAlone.")'),
    'Nessa answered. Open the NeverQuestAlone app, the NeverQuestAlone addon or Options > AddOns > NeverQuestAlone.');
  assert.equal(nessa.evaluate('NS.P("50% NeverQuestAlone")'), '50% Nessa', 'a % in the words is no trouble');
  vm.run('NS.Notify.Local(NS.P("NeverQuestAlone is hidden."))');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[Nova]|r Nova is hidden.');
  vm.slash('help all');
  assert.ok(notice(vm).includes('Ask what to do next'), 'the help names no one');
  vm.run('NS.Notify.Game(NS.P("Asked NeverQuestAlone."))');
  assert.equal(vm.list('STUB.errors').at(-1), 'Asked Nova.');
  vm.run('table.insert(STUB.prints, "-"); NQAMap.Command("")');
  const prints = vm.list('STUB.prints');
  assert.ok(prints.slice(prints.lastIndexOf('-')).includes('|cff7ec8ff[Nova]|r Nothing on the map yet. Ask for a route, like: /nqa route me through copper veins in Loch Modan'), prints.join('\n'));
  // Kept across a reload (the saved agent names, the saved backend).
  const vm2 = reloadVM(vm).login();
  assert.equal(vm2.evaluate('NS.Name()'), 'Nova');
  assert.equal(vm2.evaluate('BINDING_NAME_NQA_ASK_NEXT'), 'Ask What to Do Next');
  // The voices: Thinking… and Writing… (no tools to name).
  assert.equal(vm.evaluate('NS.UI.Voice("exec: ls", 10)'), 'Thinking…');
  assert.equal(vm.evaluate('NS.UI.Voice("Writing", 50)'), 'Writing…');
  // A slot whose agents list names the companion, with no provider part: its name too (C2).
  const listed = confirmHello(newVM().login());
  apply(listed, byokSlot().replace(/caps = \{[^}]*\}/, 'caps = { "state", "evt", "think", "z", "ctx" }').replace(/, provider = \{[^}]*\}, usage = \{[^}]*\}/, '').replace('name = "NeverQuestAlone"', 'name = "Nova"'));
  assert.equal(listed.evaluate('NS.Name()'), 'Nova');
  assert.equal(listed.evaluate('NS.P("Ask NeverQuestAlone")'), 'Ask Nova');
  assert.equal(listed.evaluate('BINDING_HEADER_NQA'), 'NeverQuestAlone');
});

test('PUI-23, UX-5: main\'s line under a reply cut in the window says to ask for the rest (no name: the owner, 2026-10-05)', () => {
  const vm = byokFirst({ p: provider({ companion: 'Nova' }), companion: 'Nova' });
  vm.slash('');
  const id = activeId(vm);
  apply(vm, byokSlot({ p: provider({ companion: 'Nova' }), companion: 'Nova', records: [replyRec(1, id, 'Long answer, first part.', ', more = 2345')] }));
  vm.run('NS.UI.Toggle(true)');
  const n = vm.num('#NS.Chats.Active().history');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${n}].body.text`), 'Long answer, first part.\n\n|cff9d9d9d(… the rest didn\'t fit in the window: ask for it)|r');
});

test('UX-5: the name goes into our own words only: chat names, items and the bridge\'s words keep theirs ("Bones" too); a name with "NeverQuestAlone" in it comes out once', () => {
  const vm = byokFirst({ p: provider({ companion: 'Nova' }), companion: 'Nova' }, { db: 'NQADB = { weights = { ["Testchar-Test Realm"] = { str = 1 } } }', extra: `
STUB.stats = { ["item:1"] = { ITEM_MOD_STRENGTH_SHORT = 10 }, ["item:2"] = { ITEM_MOD_STRENGTH_SHORT = 5 } }
C_Item.GetItemStats = function(link) return STUB.stats["item:" .. tostring(link):match("item:(%d+)")] end
C_Item.GetItemInfoInstant = function(link) return tonumber(tostring(link):match("item:(%d+)")), nil, nil, "INVTYPE_CHEST" end
function GetInventoryItemLink(unit, slot) if slot == 5 then return "|Hitem:2|h[Bonescythe Breastplate]|h" end end
STUB.lines = {}
function GameTooltip:AddLine(t) table.insert(STUB.lines, t) end
function GameTooltip:GetItem() return "x", STUB.hover end
` });
  vm.slash('');
  vm.slash('new Bones and Bonescythe');
  vm.slash('chat');
  assert.match(notice(vm), /\n\d+\. Bones and Bonescythe {2}\(current\)/);
  vm.run('STUB.lines = {}; STUB.hover = "|Hitem:1|h[Bone Vest]|h"; NS.Tooltips.OnItemTooltip(GameTooltip)');
  assert.deepEqual(vm.list('STUB.lines'), ['Nova: an upgrade for your build, +100% over Bonescythe Breastplate']);
  vm.run('NS.Transport.Warn("w", "NeverQuestAlone saw Bonescythe drop. Bones says hi.", "x")');
  assert.equal(notice(vm), 'NeverQuestAlone saw Bonescythe drop. Bones says hi.');
  const jr = byokFirst({ p: provider({ companion: 'NeverQuestAlone Jr' }), companion: 'NeverQuestAlone Jr' });
  jr.slash('');
  jr.run('NS.Notify.Game(NS.P("Asked NeverQuestAlone."))');
  assert.equal(jr.list('STUB.errors').at(-1), 'Asked NeverQuestAlone Jr.');
  assert.equal(jr.evaluate('NS.P("Target something first, then ask NeverQuestAlone about it.")'), 'Target something first, then ask NeverQuestAlone Jr about it.');
  // A name with the earlier default in it is a name of its own: only "Bones" itself reads as the default.
  const bonesJr = byokFirst({ p: provider({ companion: 'Bones Jr' }), companion: 'Bones Jr' });
  bonesJr.slash('');
  assert.equal(bonesJr.evaluate('NS.Name()'), 'Bones Jr');
  bonesJr.run('NS.Notify.Game(NS.P("Asked NeverQuestAlone."))');
  assert.equal(bonesJr.list('STUB.errors').at(-1), 'Asked Bones Jr.');
});

test('"Bones", the companion\'s name until 1.4.9, reads as the default, NeverQuestAlone: in saved data, and from an app that still sends it (the owner, 2026-10-05)', () => {
  // An app before 1.4.9 sends "Bones" as the persona and in the agents list.
  const vm = byokFirst({ p: provider({ companion: 'Bones' }), companion: 'Bones' });
  vm.slash('');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.Name()'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('tostring(NQADB.agentNames.main)'), 'nil', 'nothing saved: the default');
  vm.run('NS.Notify.Local(NS.P("NeverQuestAlone is hidden."))');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[NeverQuestAlone]|r NeverQuestAlone is hidden.');
  // A renamed companion goes back to the default when the app says "Bones" again.
  apply(vm, byokSlot({ p: provider({ companion: 'Nova' }), companion: 'Nova' }));
  assert.equal(vm.evaluate('NS.Name()'), 'Nova');
  apply(vm, byokSlot({ p: provider({ companion: 'Bones' }), companion: 'Bones' }));
  assert.equal(vm.evaluate('NS.Name()'), 'NeverQuestAlone');
  // Saved data from before 1.4.9 holds "Bones": it goes at load, a name of the player's own stays.
  const old = newVM({ db: 'NQADB = { agentNames = { main = "Bones", scout = "Nyx" } }' }).login();
  assert.equal(old.evaluate('NS.Name()'), 'NeverQuestAlone');
  assert.equal(old.evaluate('tostring(NQADB.agentNames.main)'), 'nil');
  assert.equal(old.evaluate('NQADB.agentNames.scout'), 'Nyx');
  assert.equal(old.evaluate('NS.Notify.Prefix()'), '|cff7ec8ff[NeverQuestAlone]|r ');
});

// ---------------------------------------------------------------- the notice, the welcome, the dialog

test('C-04, C-14: the window\'s notices are NeverQuestAlone\'s (C-124); the Delete dialog and tip name the desktop app; the game-data tick says no "he"', () => {
  const vm = byokFirst();
  vm.slash('');
  vm.slash('chat');
  assert.equal(vm.evaluate('NS.UI.ui.notice.who.text'), 'NeverQuestAlone');
  vm.slash('delete');
  assert.equal(vm.evaluate('StaticPopupDialogs.NQA_DELETE.text'), 'Delete the chat "%s"?\n\nIts chat history is deleted here and in the NeverQuestAlone app. This can\'t be undone.');
  assert.equal(vm.evaluate('StaticPopupDialogs.NQA_DELETE.button1'), 'Delete', 'the verb on its button (STYLE §5)');
  vm.run('NS.UI.RenderContext()');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.detail'), 'Sent with your messages, so NeverQuestAlone knows what you know.');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.text.text'), 'Game Data', 'a check box\'s label, in Title Case (CF-UX-15)');
  // The delete button's tooltip: where the history goes, and that it asks first.
  vm.run('NS.UI.SetListShown(true); NS.UI.RenderList(); STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local d = NS.UI.ui.rows[1].del; d.scripts.OnEnter(d)');
  assert.deepEqual(vm.list('STUB.tip').slice(0, 2), ['Deletes this chat and its history, here and in the NeverQuestAlone app.', 'It asks first.']);
});

// ---------------------------------------------------------------- the words scan

test('C-04, C-05, C-14: the public build\'s player-facing words never say NeverQuestAlone, bridge or gateway, pairing or a private term, nor he or his (every text drawn, printed, flashed, tooltipped, in a menu, a popup or Settings)', async (t) => {
  const SPY = `
STUB.tips, STUB.menu = {}, {}
function GameTooltip:AddLine(t) table.insert(STUB.tips, tostring(t)) end
local setText = GameTooltip.SetText
function GameTooltip:SetText(t, ...) table.insert(STUB.tips, tostring(t)); if setText then return setText(self, t, ...) end end
MenuUtil = { CreateContextMenu = function(owner, fn)
	local root = {}
	function root:CreateTitle(t) table.insert(STUB.menu, t) end
	function root:CreateButton(t) table.insert(STUB.menu, t) end
	function root:CreateDivider() end
	fn(owner, root)
end }
AddonCompartmentFrame = { RegisterAddon = function(self, d) STUB.compartment = d end }
STUB.controls, STUB.inits = {}, {}
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name) STUB.category = { name = name, GetID = function() return 42 end }; return STUB.category, {} end,
	RegisterInitializer = function(cat, i) table.insert(STUB.inits, i) end,
	RegisterProxySetting = function(cat, var, vt, name, def, get, set) return { var = var, name = name } end,
	CreateCheckbox = function(cat, s, tip) table.insert(STUB.controls, s.name); table.insert(STUB.controls, type(tip) == "function" and tip() or tostring(tip)) end,
	CreateDropdown = function(cat, s, options, tip) table.insert(STUB.controls, s.name); for _, o in ipairs(options()) do table.insert(STUB.controls, o.label) end; table.insert(STUB.controls, type(tip) == "function" and tip() or tostring(tip)) end,
	CreateControlTextContainer = function() local c = { data = {} }; function c:Add(v, l) table.insert(self.data, { value = v, label = l }) end; function c:GetData() return self.data end; return c end,
	CreateSliderOptions = function(a, b, c) return { SetLabelFormatter = function() end } end,
	CreateSlider = function(cat, s, o, tip) table.insert(STUB.controls, s.name); table.insert(STUB.controls, type(tip) == "function" and tip() or tostring(tip)) end,
	RegisterAddOnCategory = function() end,
	OpenToCategory = function() end,
}
function CreateSettingsListSectionHeaderInitializer(name) return { header = name } end
function CreateSettingsButtonInitializer(name, text, click, tip) return { name = name, button = text, tip = type(tip) == "function" and tip() or tip } end
`;
  const texts = [];
  const collect = vm => {
    // Every tooltip a player can bring up: the shown frames' (a hidden one can't be pointed at).
    vm.run('local function seen(f) while f do if f.shown == false then return false end f = f.parent end return true end for _, f in ipairs(STUB.frames) do if f.scripts and f.scripts.OnEnter and seen(f) then pcall(f.scripts.OnEnter, f) end end');
    for (const k of ['texts', 'prints', 'errors', 'tips', 'menu', 'controls']) texts.push(...vm.list(`STUB.${k}`).map(t => [k, t]));
    for (const i of vm.list('(function() local o = {} for _, i in ipairs(STUB.inits or {}) do o[#o + 1] = tostring(i.header or "") .. " " .. tostring(i.name or "") .. " " .. tostring(i.button or "") .. " " .. tostring(i.tip or "") end return o end)()')) texts.push(['settings', i]);
    for (const d of vm.list('(function() local o = {} for _, d in pairs(StaticPopupDialogs) do o[#o + 1] = tostring(d.text) end return o end)()')) texts.push(['popup', d]);
    vm.run('STUB.texts, STUB.prints, STUB.errors, STUB.tips, STUB.menu, STUB.controls, STUB.inits = {}, {}, {}, {}, {}, {}, {}');
  };
  // An app install before the app has ever answered, then after 2 min of silence.
  const fresh = appVM({ extra: SPY });
  fresh.slash('');
  fresh.slash('help');
  fresh.slash('companion');
  fresh.slash('update');
  fresh.advance(130);
  fresh.run('NS.Refresh("all"); NS.HUD.Render()');
  fresh.run('STUB.compartment.funcOnEnter({})');
  collect(fresh);
  // The app answering, through the forms, the commands and the dialogs a player meets.
  const vm = byokFirst({ p: provider({ companion: 'Nova' }), companion: 'Nova' }, { extra: SPY, db: 'NQADB = { hudIntro = true }' });
  vm.advance(11); // the settings page, made after 10 s or the first slot
  vm.slash('');
  const id = activeId(vm);
  let seq = 0;
  for (const form of ['full', 'min', 'compass', 'full']) {
    vm.slash(`hud ${form}`);
    vm.run('NS.UI.Toggle(false); NS.Refresh("all"); NS.HUD.Render()');
    collect(vm);
    vm.run('NS.HUD.Menu(UIParent)');
    collect(vm);
    vm.slash('');
  }
  apply(vm, byokSlot({ p: provider({ companion: 'Nova' }), companion: 'Nova', records: [replyRec(++seq, id, 'Head north to the ridge.'), errorRec(++seq, id, 'overloaded', 'retry', 'It went wrong.')] }));
  vm.run('NS.Refresh("all"); NS.HUD.Render()');
  collect(vm);
  // Every backend state, spend state and error kind a player meets (the HUD, the bar, the window, the panel).
  for (const st of ['no_key', 'key_invalid', 'slowed', 'out_of_credit', 'cap', 'provider_down', 'local_down', 'paused', 'ready']) {
    apply(vm, byokSlot({ rt: `{ state = "${st}", retryIn = 18 }`, ...(st === 'cap' ? { u: capped() } : {}) }));
    vm.run('NS.Refresh("all"); NS.HUD.Render(); NQADB.settings.hudMin = true; NS.HUD.Render(); NQADB.settings.hudMin = false; NS.HUD.Render()');
    collect(vm);
  }
  for (const u of [capped({ needs: 'near_cap' }), capped({ needs: 'cap' }), usage({ needs: 'slowed' }), usage({ needs: 'out_of_credit' }), usage({ needs: 'key_invalid' }),
    usage({ autoOn: true, autoPaused: true }), usage({ autoOn: false }), usage({ freeUsed: 50, freeLimit: 50, needs: 'cap' })]) {
    apply(vm, byokSlot({ u }));
    vm.slash('companion');
    vm.slash('usage');
    vm.run('NS.Refresh("all"); NS.HUD.Render(); NQADB.settings.hudMin = true; NS.HUD.Render(); NQADB.settings.hudMin = false; NS.HUD.Render()');
    collect(vm);
  }
  apply(vm, byokSlot());
  vm.slash('');
  for (const [kind, action] of [['overloaded', 'retry'], ['out_of_credit', 'desktop'], ['content_blocked', 'none'], ['interrupted', 'none'], ['auto_paused', 'none'],
    ['map_block', 'none'], ['local_unreachable', 'desktop'], ['model_not_found', 'desktop']]) {
    vm.run(`NS.UI.ui.input:SetText("plan my evening"); NS.UI.SendFromInput()`);
    vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    apply(vm, byokSlot({ records: [errorRec(++seq, id, kind, action, 'It went wrong.')] }));
    vm.run('for i = #NS.UI.ui.bubbles, 1, -1 do local b = NS.UI.ui.bubbles[i]; if b.shown and b.errEntry then NS.UI.ToggleErrorDetails(b.errEntry) break end end');
    vm.run('NS.Refresh("all"); NS.HUD.Render()');
    collect(vm);
  }
  apply(vm, byokSlot({ records: [replyRec(++seq, id, 'Head north.', ', usage = { ["in"] = 100, out = 10, micros = 400, exact = true }')] }));
  vm.run('NS.UI.ToggleUsage(); NS.Refresh("all")');
  collect(vm);
  vm.run('NS.UI.ToggleUsage()');
  for (const cmd of ['help', 'think', 'think high', 'think default', 'companion', 'companion on', 'context', 'context off', 'context on',
    'hud min', 'hud compass', 'hud full', 'hud off', 'hud on', 'text large', 'text medium', 'waypoint off', 'waypoint on', 'tooltips off', 'tooltips on',
    'quips on', 'quips off', 'echo short', 'echo summary', 'dnd combat off', 'dnd combat on', 'chat', 'new Second', 'rename Third', 'pin', 'unpin',
    'settings', 'update', 'delete', 'diag', 'stop']) {
    vm.slash(cmd);
    collect(vm);
  }
  vm.run('local t = NS.UI.ui.thinkBtn; t.scripts.OnClick(t)');
  vm.run('NS.UI.ChatMenu(NQADB.activeChat, UIParent)');
  vm.run('NS.HUD.SetShown(false); NS.HUD.Close()');
  vm.run('STUB.compartment.funcOnEnter({})');
  apply(vm, byokSlot().replace('ver = "1.4.0"', 'ver = "1.4.0"'));
  vm.run('NS.Transport.SelfTest(); STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest(); NS.Refresh("all")');
  collect(vm);
  const BAD = /\bbridge\b|\bgateway\b|\bpairing\b|\b(he|his|him)\b/i;
  const bad = texts.filter(([, x]) => BAD.test(plain(x)));
  assert.deepEqual(bad, [], 'player-facing words');
  assert.ok(texts.length > 300, `a real sample (${texts.length})`);
  // The private terms, read from SCRUB_TERMS (never written here): none in any of those words.
  const said = texts.map(([kind, x]) => `${kind}: ${plain(x)}`);
  await t.test('nor a private term in any of them (SCRUB_TERMS)', { skip: PRIVATE_SKIP }, async () => {
    assert.deepEqual((await privateTerms()).hits(said), [], 'player-facing words');
  });
  assert.equal(vm.evaluate('BINDING_HEADER_NQA'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('STUB.compartment.text'), 'NeverQuestAlone');
  assert.equal(vm.evaluate('STUB.category.name'), 'NeverQuestAlone');
  // The scan reaches what it looks for: a line that says "the bridge" is found.
  const probe = confirmHello(newVM({ extra: SPY, db: 'NQADB = { hudIntro = true }' }).login());
  probe.run('NS.UI.Toggle(true)'); // its notices are drawn while the window shows (code health AD-05)
  probe.run('NS.Notify.Local("A line about the bridge."); NS.Transport.Warn("p", "The gateway said so.", "his words")');
  texts.length = 0;
  collect(probe);
  assert.deepEqual(texts.filter(([, x]) => BAD.test(plain(x))).length >= 3, true, 'each one caught');
});

test('S-06, C-18: the Settings page is made at the first slot, in the companion\'s name, or 10 s without one', () => {
  const API = `
STUB.headers = {}
Settings = {
	VarType = { Boolean = "boolean", String = "string", Number = "number" },
	RegisterVerticalLayoutCategory = function(name) STUB.category = { name = name, GetID = function() return 42 end }; return STUB.category, {} end,
	RegisterInitializer = function(cat, i) if i.header then table.insert(STUB.headers, i.header) end end,
	RegisterProxySetting = function(cat, var, vt, name) return { var = var, name = name } end,
	CreateCheckbox = function() end, CreateDropdown = function() end, CreateSlider = function() end,
	CreateControlTextContainer = function() local c = { data = {} }; function c:Add() end; function c:GetData() return self.data end; return c end,
	CreateSliderOptions = function() return {} end,
	RegisterAddOnCategory = function() end,
}
function CreateSettingsListSectionHeaderInitializer(name) return { header = name } end
function CreateSettingsButtonInitializer(name, text, click, tip) return { name = name } end
`;
  const app = appVM({ extra: API });
  assert.equal(app.evaluate('STUB.category'), null, 'not at login');
  app.advance(3.1);
  app.slot(byokSlot({ p: provider({ companion: 'Nova' }), companion: 'Nova', nonce: app.evaluate('NS.R.nonce') }));
  ring(app);
  assert.equal(app.evaluate('STUB.category.name'), 'NeverQuestAlone');
  assert.ok(app.list('STUB.headers').includes('What Nova Knows'));
  const quiet = appVM({ extra: API });
  quiet.advance(10.5);
  assert.equal(quiet.evaluate('STUB.category.name'), 'NeverQuestAlone', '10 s without a slot');
  const plainVM = newVM({ extra: API }).login();
  assert.equal(plainVM.evaluate('STUB.category'), null, 'not at login, whatever installed it');
});
