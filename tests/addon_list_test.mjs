// The AddOns list (the owner, 2026-09-27: "we will need to reduce all of this to one
// addon checkbox why is this 400 sub check boxes?"). The 200 slots the addon reads
// replies from (NQA_S001…S200, docs/PROTOCOL.md §1, §4) can't go away: each
// reply needs an addon the game hasn't loaded yet. So each slot leaves NeverQuestAlone's
// group for a category of their own (bridge/transport/slots.mjs). Setup folds
// that category at install, before the game's first start (C-119), and the addon
// folds it once where setup didn't (Settings.lua, P.FoldParts): the list shows the
// category's one folded row and the addon's own row with its check box (E-047).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { slotToc, slotName, installSlots, slotInterface, SLOT_CATEGORY, SLOT_ICON, SLOT_COUNT, foldSlotCategory, foldPartsOnce, addonListFile, FOLD_VAR } from '../bridge/transport/slots.mjs';
import { addonListRows, tocMeta } from './helpers/addon-list.mjs';
import { newLuaVM } from './helpers/luavm.mjs';

const require = createRequire(import.meta.url);
const { newVM, reloadVM, lstr } = require('./helpers/nqa-vm.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADDON_TOC = tocMeta(fs.readFileSync(path.join(ROOT, 'addon', 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8'));

// The list's addons, in the client's order (by folder name): the owner's three Leatrix addons, NeverQuestAlone, then the slots.
const OTHERS = ['Leatrix_Maps', 'Leatrix_Plus', 'Leatrix_Sounds'].map(name => ({ name, title: name.replace('_', ' '), group: name }));
const listed = slots => [...OTHERS, { name: 'NeverQuestAlone', title: ADDON_TOC.Title, group: 'NeverQuestAlone', icon: ADDON_TOC.IconTexture }, ...slots];
const slots = (count = SLOT_COUNT) => Array.from({ length: count }, (_, k) => {
  const m = tocMeta(slotToc(k + 1, '16001'));
  return { name: slotName(k + 1), title: m.Title, group: m.Group, category: m.Category, icon: m.IconTexture };
});
// 0.5.2's TOCs: no Group or Category, so the client grouped them under NeverQuestAlone (named alike, and needing it).
const OLD_TOC = n => ['## Interface: 16001', `## Title: NeverQuestAlone slot ${n}`, '## Notes: Reply slot for NeverQuestAlone. Load-on-demand; leave it enabled.',
  '## LoadOnDemand: 1', '## Dependencies: NeverQuestAlone', '', 'Inbox.lua', ''].join('\n');
const oldSlots = () => Array.from({ length: SLOT_COUNT }, (_, k) => ({ name: slotName(k + 1), title: tocMeta(OLD_TOC(String(k + 1).padStart(3, '0'))).Title, group: 'NeverQuestAlone' }));

test('a slot\'s TOC: a category of their own, its own group (out of NeverQuestAlone\'s), the addon\'s icon, NeverQuestAlone\'s words; still load-on-demand and needing NeverQuestAlone', () => {
  const text = slotToc(7, '16001');
  const toc = tocMeta(text);
  assert.deepEqual(Object.keys(toc), ['Interface', 'Title', 'Notes', 'Category', 'Group', 'IconTexture', 'LoadOnDemand', 'Dependencies']);
  assert.equal(toc.Interface, '16001');
  assert.equal(toc.Title, 'NeverQuestAlone Part 007');
  assert.equal(toc.Notes, 'A part of NeverQuestAlone that brings replies into the game. Leave it checked.');
  assert.equal(toc.Category, 'NeverQuestAlone Parts');
  assert.equal(toc.Category, SLOT_CATEGORY);
  assert.equal(toc.Group, 'NQA_S007', 'its own name: left to the client, it joins NeverQuestAlone\'s group');
  for (const i of [1, 99, 200]) assert.equal(tocMeta(slotToc(i, '16001')).Group, slotName(i));
  assert.equal(toc.LoadOnDemand, '1');
  assert.equal(toc.Dependencies, 'NeverQuestAlone');
  assert.equal(toc.IconTexture, SLOT_ICON);
  assert.equal(SLOT_ICON, ADDON_TOC.IconTexture, 'the addon\'s own icon, never the red question mark the list gives an addon that names none');
  assert.ok(fs.existsSync(path.join(ROOT, 'addon', 'NeverQuestAlone', 'Media', 'NeverQuestAlone.tga')), 'the icon ships with the addon');
  assert.match(text, /^## Interface: 16001\n/, 'the interface line first');
  assert.match(text, /\n\nInbox\.lua\n$/);
  // The words a player reads (docs/STYLE.md; the lint doesn't read these TOCs): the product's new name, no plumbing, short.
  for (const w of [toc.Title, toc.Notes, SLOT_CATEGORY]) {
    assert.match(w, /NeverQuestAlone/, w);
    assert.doesNotMatch(w, /\bslots?\b|load-on-demand|\b(en|dis)abled?\b/i, w);
  }
  assert.match(toc.Notes, /Leave it checked\.$/, 'says to keep it on, in the glossary\'s word');
  assert.notEqual(SLOT_CATEGORY, ADDON_TOC.Title, 'never the addon row\'s own name');
  assert.notEqual(SLOT_CATEGORY, 'NeverQuestAlone', 'nor the product\'s alone, the addon row\'s name after the rename');
  assert.ok(SLOT_CATEGORY.length <= 24, 'short: the category row\'s title is 220 wide at 12 pt, with no icon');
});

test('setup rewrites a slot\'s TOC from 0.5.2, keeps what the bridge wrote in it, keeps a TOC that\'s current, and the interface still reads', () => {
  const addons = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-slots-'));
  try {
    const dir = path.join(addons, slotName(1));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${slotName(1)}.toc`), OLD_TOC('001'));
    fs.writeFileSync(path.join(dir, 'Inbox.lua'), 'NQA_SlotData = { v = 2 }\n');
    assert.deepEqual(installSlots(addons, { count: 2, iface: '16001' }), { created: 1, rewritten: 1, kept: 0 });
    assert.equal(fs.readFileSync(path.join(dir, `${slotName(1)}.toc`), 'utf8'), slotToc(1, '16001'));
    assert.equal(fs.readFileSync(path.join(dir, 'Inbox.lua'), 'utf8'), 'NQA_SlotData = { v = 2 }\n');
    assert.deepEqual(installSlots(addons, { count: 2, iface: '16001' }), { created: 0, rewritten: 0, kept: 2 });
    assert.equal(slotInterface(addons), '16001', 'the bridge\'s interface check reads the new TOC');
  } finally {
    fs.rmSync(addons, { recursive: true, force: true });
  }
});

test('the AddOns list, as AddonList.lua builds it: 0.5.2 put 200 check boxes under NeverQuestAlone; 0.5.3 shows the slots\' one folded row and NeverQuestAlone\'s own', () => {
  const before = addonListRows(listed(oldSlots()));
  assert.equal(before.filter(r => r.checkbox).length, OTHERS.length + 1 + SLOT_COUNT, 'the owner\'s screenshot: every slot a check box');
  assert.equal(before.filter(r => r.depth === 1).length, SLOT_COUNT, 'all under NeverQuestAlone');

  const folded = addonListRows(listed(slots()), { [SLOT_CATEGORY]: true });
  assert.deepEqual(folded.map(r => [r.text, r.depth, r.checkbox]),
    [[SLOT_CATEGORY, 0, false], ['Leatrix Maps', 0, true], ['Leatrix Plus', 0, true], ['Leatrix Sounds', 0, true], [ADDON_TOC.Title, 0, true]],
    'ours: the category\'s folded row (no check box) and NeverQuestAlone\'s own row, its check box the one we show');
  assert.equal(folded.filter(r => /NeverQuestAlone Part |NQA_S/.test(r.text)).length, 0, 'folded, it hides every slot');
  // One name for the product in the list (C-120): the category and the addon's own row both say NeverQuestAlone.
  assert.equal(ADDON_TOC.Title, 'NeverQuestAlone');
  assert.ok(SLOT_CATEGORY.startsWith(`${ADDON_TOC.Title} `), 'the parts\' row names the addon\'s');

  // Unfolded (before the addon first folds it, or a player who opens it): every slot under the category, none under NeverQuestAlone.
  const open = addonListRows(listed(slots()));
  assert.equal(open.length, 1 + OTHERS.length + 1 + SLOT_COUNT);
  assert.deepEqual(open.slice(0, 3).map(r => [r.text, r.depth]), [[SLOT_CATEGORY, 0], ['NeverQuestAlone Part 001', 1], ['NeverQuestAlone Part 002', 1]]);
  assert.equal(open.filter(r => r.depth === 1).length, SLOT_COUNT, 'each slot one level in, under the category: its Enable All and Disable All reach all 200');
  assert.equal(open.filter(r => r.depth > 1).length, 0);
  assert.deepEqual(open.at(-1), { text: ADDON_TOC.Title, depth: 0, checkbox: true, category: false, icon: ADDON_TOC.IconTexture, status: '' }, 'NeverQuestAlone\'s row has nothing under it');
  assert.ok(open.filter(r => r.depth === 1).every(r => r.icon === SLOT_ICON), 'no red question marks');

  // A slot missing (deleted by hand), the first one included: the others stay in the category.
  for (const gone of [1, 100]) {
    const some = slots().filter(p => p.name !== slotName(gone));
    assert.deepEqual(addonListRows(listed(some), { [SLOT_CATEGORY]: true }).map(r => r.text), folded.map(r => r.text), `without ${slotName(gone)}`);
  }
  // Half rewritten (a setup that stopped part way): the old ones still sit under NeverQuestAlone, the new ones in the category.
  const mixed = [...slots(100), ...oldSlots().slice(100)];
  const rows = addonListRows(listed(mixed), { [SLOT_CATEGORY]: true });
  assert.equal(rows.filter(r => r.depth === 1).length, 100);
});

// ---------------------------------------------------------------------------
// The fold, once (Settings.lua)

// The game as the fold sees it: the slots' TOC fields as the client read them
// at its start (STUB.slotsCategory; nil: 0.5.2's TOCs), and Blizzard_AddOnList's
// table of folded categories (saved for the whole computer), when it's loaded.
const GAME = (category, table) => `
STUB.slotsCategory = ${category ? lstr(category) : 'nil'}
do
	local get = C_AddOns.GetAddOnMetadata
	C_AddOns.GetAddOnMetadata = function(name, field)
		if name == "${slotName(1)}" and field == "Category" then return STUB.slotsCategory end
		return get(name, field)
	end
end
g_addonCategoriesCollapsed = ${table}
STUB.foldTable = g_addonCategoriesCollapsed
`;
const DB = 'NQADB = { hudIntro = true, qolAsked = true }';
const folded = vm => vm.evaluate(`g_addonCategoriesCollapsed and g_addonCategoriesCollapsed[${lstr(SLOT_CATEGORY)}]`);
const logout = vm => vm.run('STUB.FireEvent("PLAYER_LOGOUT")');
// The next session: NQADB and the machine's table carry over, as saved at logout.
const next = (vm, extra = GAME(SLOT_CATEGORY, vm.evaluate('STUB.Serialize(g_addonCategoriesCollapsed)'))) => reloadVM(vm, { extra }).login();

test('the addon\'s name for the slots\' category is the bridge\'s', () => {
  const vm = newVM({ db: DB }).login();
  assert.equal(vm.evaluate('NS.SLOT_CATEGORY'), SLOT_CATEGORY);
});

test('the addon folds the slots\' category once, at logout, setting only its own key in the game\'s own table; a player who opens it keeps it open', () => {
  let vm = newVM({ db: DB, extra: GAME(SLOT_CATEGORY, '{ ["Bags"] = true }') }).login();
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", true, false); STUB.FireEvent("ADDON_LOADED", "Blizzard_AddOnList")');
  vm.advance(30);
  vm.run('STUB.FireEvent("PLAYER_ENTERING_WORLD", false, true)');
  assert.equal(folded(vm), null, 'never while playing: the game\'s own AddOns list reads that table, and a key we set would run it tainted');
  logout(vm);
  assert.equal(folded(vm), 'true', 'set as the game saves it (logout, quit or /reload)');
  assert.deepEqual(vm.json('g_addonCategoriesCollapsed'), { Bags: true, [SLOT_CATEGORY]: true }, 'another category left as it was, nothing else added');
  assert.equal(vm.evaluate('g_addonCategoriesCollapsed == STUB.foldTable'), 'true', 'the game\'s own table, never replaced');
  assert.equal(vm.evaluate('NQADB.partsFolded'), SLOT_CATEGORY, 'remembered, by the category it folded');
  vm = next(vm);
  logout(vm);
  assert.equal(folded(vm), 'true');

  // The player unfolds it at character select (the list sets the key to nil): it stays open.
  vm = next(vm, GAME(SLOT_CATEGORY, '{ ["Bags"] = true }'));
  logout(vm);
  assert.equal(folded(vm), null, 'once: a player who opens it keeps it open');
  assert.equal(vm.evaluate('NQADB.partsFolded'), SLOT_CATEGORY);
  vm = next(vm);
  logout(vm);
  assert.equal(folded(vm), null);
});

test('the fold waits for the game\'s table, and folds the bridge\'s name for the category while the client still has 0.5.2\'s TOCs', () => {
  // Blizzard_AddOnList not loaded: nothing made, nothing remembered.
  let vm = newVM({ db: DB, extra: GAME(SLOT_CATEGORY, 'nil') }).login();
  logout(vm);
  assert.equal(vm.evaluate('g_addonCategoriesCollapsed'), null, 'no table of ours made');
  assert.equal(vm.evaluate('NQADB.partsFolded'), null);
  // The TOCs rewritten while the game ran (it reads them at its start): the new name, so the list is folded at the restart.
  vm = next(vm, GAME(null, '{}'));
  logout(vm);
  assert.equal(folded(vm), 'true');
  assert.equal(vm.evaluate('NQADB.partsFolded'), SLOT_CATEGORY);
  // After the restart, the TOCs name it too: nothing more to do, and a player's opening it holds.
  vm = next(vm, GAME(SLOT_CATEGORY, '{}'));
  logout(vm);
  assert.equal(folded(vm), null);
});

test('a category renamed later (a new TOC) is folded once too; the old key is left alone', () => {
  const vm = newVM({ db: 'NQADB = { hudIntro = true, qolAsked = true, partsFolded = "Old Name" }', extra: GAME(SLOT_CATEGORY, '{ ["Old Name"] = true }') }).login();
  logout(vm);
  assert.equal(folded(vm), 'true');
  assert.equal(vm.evaluate('NQADB.partsFolded'), SLOT_CATEGORY);
  assert.equal(vm.evaluate('g_addonCategoriesCollapsed["Old Name"]'), 'true');
});

test('a fold that can\'t read the TOCs raises nothing at logout: it folds the bridge\'s name', () => {
  const vm = newVM({ db: DB, extra: GAME(SLOT_CATEGORY, '{}') + '\nC_AddOns.GetAddOnMetadata = function() error("no metadata") end' }).login();
  assert.doesNotThrow(() => logout(vm));
  assert.equal(folded(vm), 'true');
  // A table the fold can't write to (another addon's doing) is left alone, and nothing raises.
  const odd = newVM({ db: DB, extra: GAME(SLOT_CATEGORY, 'setmetatable({}, { __newindex = function() error("read-only") end })') }).login();
  assert.doesNotThrow(() => logout(odd));
  assert.equal(odd.evaluate('NQADB.partsFolded'), null, 'not remembered: tried again at the next logout');
});

test('the addon finds the fold in place at login (setup made it, or the player): remembered and never written, so a player who opens it in game keeps it open', () => {
  let vm = newVM({ db: DB, extra: GAME(SLOT_CATEGORY, `{ [${lstr(SLOT_CATEGORY)}] = true, ["Bags"] = true }`) }).login();
  assert.equal(vm.evaluate('NQADB.partsFolded'), SLOT_CATEGORY, 'remembered at login');
  vm.run(`g_addonCategoriesCollapsed[${lstr(SLOT_CATEGORY)}] = nil`); // the player unfolds it in game's AddOns list
  logout(vm);
  assert.equal(folded(vm), null, 'open, as the player left it');
  vm = next(vm);
  logout(vm);
  assert.equal(folded(vm), null);
  // Nothing at login is ever written: the fold itself waits for a logout.
  const fresh = newVM({ db: DB, extra: GAME(SLOT_CATEGORY, '{}') }).login();
  assert.deepEqual(fresh.json('g_addonCategoriesCollapsed'), {});
  assert.equal(fresh.evaluate('NQADB.partsFolded'), null);
});

// ---------------------------------------------------------------------------
// The fold at install (C-119): setup, while WoW isn't running

// A flavor folder and the app's config, both scratch.
function install() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-fold-'));
  const flavorDir = path.join(dir, '_classic_beta_');
  fs.mkdirSync(flavorDir);
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ wow: { flavorDir }, capture: { intervalMs: 500 } }, null, 2) + '\n');
  const file = addonListFile(flavorDir);
  return { dir, flavorDir, configFile, file, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
// The file as the game reads it (a Lua chunk), and its table.
const readFold = file => { const L = newLuaVM(); L.run(fs.readFileSync(file, 'latin1')); return L.global(FOLD_VAR); };
// The game's own layout (WTF/SavedVariables): a blank line, then each variable, a tab per level.
const WOW_FILE = `\n${FOLD_VAR} = {\n\t["Bags"] = true,\n\t["Leatrix \\"Plus\\" [2]"] = true,\n}\n`;

test('C-119: setup folds the parts\' row before the first start: a fresh WTF gets the game\'s own file with the one key; recorded in the app\'s config', () => {
  const t = install();
  try {
    assert.equal(fs.existsSync(path.join(t.flavorDir, 'WTF')), false, 'a game never started');
    assert.equal(t.file, path.join(t.flavorDir, 'WTF', 'SavedVariables', 'Blizzard_AddOnList.lua'), 'Blizzard_AddOnList\'s SavedVariablesMachine: one file for the whole computer');
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => false }), 'folded');
    assert.equal(fs.readFileSync(t.file, 'utf8'), `\n${FOLD_VAR} = {\n\t["NeverQuestAlone Parts"] = true,\n}\n`);
    assert.deepEqual(readFold(t.file), { [SLOT_CATEGORY]: true });
    const cfg = JSON.parse(fs.readFileSync(t.configFile, 'utf8'));
    assert.equal(cfg.partsFolded, SLOT_CATEGORY, 'once per install, by the category\'s name');
    assert.equal(cfg.capture.intervalMs, 500, 'the rest of the config as it was');
    // The first character select: one folded row and the addon's own, nothing else of ours.
    assert.deepEqual(addonListRows(listed(slots()), readFold(t.file)).map(r => r.text), [SLOT_CATEGORY, 'Leatrix Maps', 'Leatrix Plus', 'Leatrix Sounds', ADDON_TOC.Title]);
  } finally { t.done(); }
});

test('C-119: an existing file keeps its keys and every other byte; the table or the variable made where missing; CRLF kept', () => {
  const t = install();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(t.file, WOW_FILE);
    assert.equal(foldSlotCategory(t.flavorDir), 'folded');
    assert.equal(fs.readFileSync(t.file, 'utf8'), WOW_FILE.replace(`${FOLD_VAR} = {\n`, `${FOLD_VAR} = {\n\t["NeverQuestAlone Parts"] = true,\n`), 'one line added, nothing else touched');
    assert.deepEqual(readFold(t.file), { Bags: true, 'Leatrix "Plus" [2]': true, [SLOT_CATEGORY]: true });
    // The key there already (the game's own, or a player who folded it): nothing written.
    const before = fs.statSync(t.file).mtimeMs;
    const bytes = fs.readFileSync(t.file);
    assert.equal(foldSlotCategory(t.flavorDir), 'kept');
    assert.ok(fs.readFileSync(t.file).equals(bytes));
    assert.equal(fs.statSync(t.file).mtimeMs, before);
    // A table the game saved empty, a variable saved as nil, a file without it, Windows line ends.
    for (const [have, want] of [
      [`\n${FOLD_VAR} = {\n}\n`, { [SLOT_CATEGORY]: true }],
      [`${FOLD_VAR} = {}`, { [SLOT_CATEGORY]: true }],
      [`\n${FOLD_VAR} = nil\n`, { [SLOT_CATEGORY]: true }],
      ['', { [SLOT_CATEGORY]: true }],
      [`\nOtherVar = {\n\t["x"] = 1,\n}`, { [SLOT_CATEGORY]: true }],
      [`\r\n${FOLD_VAR} = {\r\n\t["Bags"] = true,\r\n}\r\n`, { Bags: true, [SLOT_CATEGORY]: true }],
      [`\n${FOLD_VAR} = {\n\t["Bags"] = true, -- a note\n\t[ [[Long]] ] = true;\n\tplain = true,\n}\n`, { Bags: true, Long: true, plain: true, [SLOT_CATEGORY]: true }],
    ]) {
      fs.writeFileSync(t.file, have);
      assert.equal(foldSlotCategory(t.flavorDir), 'folded', JSON.stringify(have));
      assert.deepEqual(readFold(t.file), want, JSON.stringify(have));
      const text = fs.readFileSync(t.file, 'utf8');
      if (have.includes('\r\n')) assert.doesNotMatch(text.replace(/\r\n/g, ''), /\n/, 'CRLF throughout');
      if (have.includes('OtherVar')) assert.ok(text.startsWith(have), 'the other variable left as it was');
    }
    // Bytes that aren't UTF-8 (a category another addon names in its own encoding) come back as they were.
    const odd = Buffer.concat([Buffer.from(`\n${FOLD_VAR} = {\n\t["Caf`), Buffer.from([0xe9]), Buffer.from('"] = true,\n}\n')]);
    fs.writeFileSync(t.file, odd);
    assert.equal(foldSlotCategory(t.flavorDir), 'folded');
    const out = fs.readFileSync(t.file);
    assert.ok(out.includes(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x22])), 'the byte kept');
    assert.equal(out.length, odd.length + '\t["NeverQuestAlone Parts"] = true,\n'.length);
  } finally { t.done(); }
});

test('C-119: a file it can\'t read for sure is left alone and nothing is recorded (the addon folds at its first logout instead)', () => {
  const t = install();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    for (const have of [`${FOLD_VAR} = setmetatable({}, {})`, `${FOLD_VAR} = "yes"`, `${FOLD_VAR} = {\n\t["Bags"] = true,\n`, 'local x = 1', `${FOLD_VAR} = { ["a" ] = tru }`]) {
      fs.writeFileSync(t.file, have);
      assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => false }), 'unreadable', have);
      assert.equal(fs.readFileSync(t.file, 'utf8'), have, 'untouched');
      assert.equal(JSON.parse(fs.readFileSync(t.configFile, 'utf8')).partsFolded, undefined, 'not recorded: the next setup tries again');
    }
    assert.deepEqual(fs.readdirSync(path.dirname(t.file)), ['Blizzard_AddOnList.lua'], 'no temp file left behind');
    // A config it can't read: nothing folded, since without the record a later setup would undo a player's unfold.
    fs.rmSync(t.file);
    fs.writeFileSync(t.configFile, '{ "wow": ');
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => false }), 'config unreadable');
    assert.equal(fs.existsSync(t.file), false);
    assert.equal(fs.readFileSync(t.configFile, 'utf8'), '{ "wow": ');
  } finally { t.done(); }
});

test('C-119: once per install: a second setup changes nothing, not even after the player unfolds the row; never while WoW runs', () => {
  const t = install();
  try {
    // WoW running (setup refuses, and the fold checks again): nothing written, nothing recorded.
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => true }), 'running');
    assert.equal(fs.existsSync(t.file), false);
    assert.equal(JSON.parse(fs.readFileSync(t.configFile, 'utf8')).partsFolded, undefined);
    // Closed: folded, recorded.
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => false }), 'folded');
    const cfg = fs.readFileSync(t.configFile);
    const file = fs.readFileSync(t.file);
    const mtime = fs.statSync(t.file).mtimeMs;
    // A second setup: nothing changes, and the game isn't even asked about.
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => { throw new Error('not asked'); } }), 'done before');
    assert.ok(fs.readFileSync(t.file).equals(file));
    assert.equal(fs.statSync(t.file).mtimeMs, mtime);
    assert.ok(fs.readFileSync(t.configFile).equals(cfg));
    // The player unfolds it (the game saves the table without the key): a later setup leaves it open.
    fs.writeFileSync(t.file, `\n${FOLD_VAR} = {\n}\n`);
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => false }), 'done before');
    assert.deepEqual(readFold(t.file), {});
    // A category renamed later is folded once too.
    assert.equal(foldPartsOnce({ flavorDir: t.flavorDir, configFile: t.configFile, running: () => false, category: 'Another Name' }), 'folded');
    assert.deepEqual(readFold(t.file), { 'Another Name': true });
  } finally { t.done(); }
});
