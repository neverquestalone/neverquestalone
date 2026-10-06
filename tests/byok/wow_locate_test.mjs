// Finding the game and installing the addon (bridge/byok/wow.mjs; public BYOK PRD §11.1 "WoW
// discovery", §11.4, §16.1 step 2, PF-5, TH12). Temp folders stand in for WoW installs; commands
// (pgrep, tasklist, reg, icacls, PlistBuddy) are stubs that record their argument lists, so
// nothing here looks at the real game, the real AddOns folder or the registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findWow, wowRoots, wowRunning, wowRunningAsync, installAddon, checkAddonsPermissions, addonInterface, interfaceFromVersion, sameLine,
  parseBuildInfo, productDbRoots, parseTasklist, broadWritersFromIcacls, accountOf, ADDON_SOURCE, FOREVER_FLAVORS, NOT_GAME, RESTART_LINE,
  recordAddonFolder, readUninstallRecord, UNINSTALL_RECORD, UNINSTALL_RECORD_MAX,
  stampToc, PUBLIC_TITLE, PUBLIC_NOTES,
} from '../../bridge/byok/wow.mjs';
import { installSlots, slotToc, addonListFile, FOLD_VAR, SLOT_CATEGORY, SLOT_ICON } from '../../bridge/transport/slots.mjs';
import { saveConfig } from '../../bridge/config.mjs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const tmp = (p = 'bones-wow-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
// TH12's POSIX cases, and what stands for them on Windows.
const POSIX_MODES = process.platform === 'win32' ? 'POSIX permission bits: on Windows checkAddonsPermissions reads the AddOns folder\'s ACL with icacls instead (broadWritersFromIcacls, tested here)' : false;
const PLANTED_LINKS = process.platform === 'win32' ? "a link planted in the AddOns folder is TH12's POSIX case: making a symlink on Windows takes an administrator or Developer Mode, and the Windows check there is the folder's ACL (broadWritersFromIcacls, tested here)" : false;
const BUILD_INFO = [
  'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Install Key!HEX:16|IM Size!DEC:4|CDN Path!STRING:0|CDN Hosts!STRING:0|CDN Servers!STRING:0|Tags!STRING:0|Armadillo!STRING:0|Last Activated!STRING:0|Version!STRING:0|KeyRing!HEX:16|Product!STRING:0',
  'eu|1|aa|bb|cc||tpr/wow|h|s|t|||1.60.1.70009||wow_classic_beta',
  'eu|1|aa|bb|cc||tpr/wow|h|s|t|||11.2.5.64000||wow',
  'eu|1|aa|bb|cc||tpr/wow|h|s|t|||1.15.7.61000||wow_classic_era',
].join('\n');

/** A fake install: root/<flavor>/{Interface, World of Warcraft.app | Wow.exe}, and optionally .build.info and an account. */
function makeInstall(root, flavor, { exe = false, app = true, account = null, buildInfo = null } = {}) {
  const dir = path.join(root, flavor);
  fs.mkdirSync(path.join(dir, 'Interface', 'AddOns'), { recursive: true });
  if (app) fs.mkdirSync(path.join(dir, 'World of Warcraft Classic.app'), { recursive: true });
  if (exe) fs.writeFileSync(path.join(dir, 'WowClassicB.exe'), '');
  if (account) fs.mkdirSync(path.join(dir, 'WTF', 'Account', account, 'SavedVariables'), { recursive: true });
  if (buildInfo) fs.writeFileSync(path.join(root, '.build.info'), buildInfo);
  return dir;
}

/** A spawnSync stub: answers per command, records every call. */
function runStub(answers = {}) {
  const calls = [];
  const run = (cmd, argv, opts) => {
    calls.push({ cmd, argv, shell: opts?.shell });
    // Windows tools come by their full System32 path (final review L3-7): answered by their name.
    const a = answers[cmd] ?? answers[/^[A-Za-z]:\\/.test(cmd) ? path.win32.basename(cmd).replace(/\.exe$/i, '') : ''];
    return typeof a === 'function' ? a(argv) : a ?? { status: 1, stdout: '' };
  };
  return { run, calls };
}

test('the addon\'s TOC targets interface 16001, the Forever line', () => {
  assert.equal(addonInterface(ADDON_SOURCE), '16001');
  assert.equal(interfaceFromVersion('1.60.1.70009'), '16001');
  assert.equal(interfaceFromVersion('bad'), null);
  assert.ok(sameLine('16002', '16001'), 'a patch of the same line');
  assert.ok(!sameLine('11205', '16001'));
  assert.deepEqual(FOREVER_FLAVORS, ['_forever_', '_classic_beta_']);
});

test('.build.info: product codes name the flavor folders', () => {
  assert.deepEqual(parseBuildInfo(BUILD_INFO), { _classic_beta_: '1.60.1.70009', _classic_era_: '1.15.7.61000' });
  assert.deepEqual(parseBuildInfo(''), {});
  assert.deepEqual(parseBuildInfo('Nonsense\nrow'), {});
});

test('findWow: Forever flavors only, the one with game data first; another client line is skipped', () => {
  const root = tmp();
  const a = makeInstall(path.join(root, 'A'), '_classic_beta_', { buildInfo: BUILD_INFO, account: 'ACCT1' });
  const b = makeInstall(path.join(root, 'B'), '_forever_');
  makeInstall(path.join(root, 'B'), '_retail_');
  // A _forever_ folder whose version is another line (a retail-engine client): the addon wouldn't load.
  makeInstall(path.join(root, 'C'), '_forever_', { buildInfo: BUILD_INFO.replace('wow_classic_beta', 'wow_forever').replace('1.60.1.70009', '11.2.5.1') });
  const { run } = runStub();
  const found = findWow({ platform: 'darwin', roots: [path.join(root, 'B'), path.join(root, 'A'), path.join(root, 'C'), path.join(root, 'missing')], run });
  assert.deepEqual(found.map(w => w.flavorDir), [a, b]);
  assert.deepEqual(found[0], { flavorDir: a, flavor: '_classic_beta_', root: path.join(root, 'A'), version: '1.60.1.70009', iface: '16001', account: 'ACCT1' });
  assert.equal(found[1].version, undefined, 'no version known');
  assert.equal(accountOf(a), 'ACCT1');
  assert.deepEqual(findWow({ platform: 'darwin', roots: [path.join(root, 'nowhere')], run }), []);
});

test('findWow on macOS reads the client app\'s version with PlistBuddy (an argument list) when there\'s no .build.info', () => {
  const root = tmp();
  const dir = makeInstall(root, '_forever_');
  const { run, calls } = runStub({ '/usr/libexec/PlistBuddy': { status: 0, stdout: '1.60.2\n' } });
  const [w] = findWow({ platform: 'darwin', roots: [root], run });
  assert.equal(w.flavorDir, dir);
  assert.equal(w.iface, '16002');
  assert.deepEqual(calls[0].argv.slice(0, 2), ['-c', 'Print :CFBundleShortVersionString']);
  assert.equal(calls[0].shell, undefined, 'never a shell');
});

test('wowRoots: macOS Applications; Windows Program Files, the registry and Battle.net\'s product.db; Linux Wine prefixes', () => {
  assert.deepEqual(wowRoots({ platform: 'darwin', home: '/Users/p', env: {} }), ['/Applications/World of Warcraft', '/Users/p/Applications/World of Warcraft']);
  const reg = runStub({ reg: argv => (argv[1].includes('WOW6432Node') ? { status: 0, stdout: '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft\r\n    InstallPath    REG_SZ    E:\\Blizzard\\World of Warcraft\\_classic_beta_\\\r\n' } : { status: 1, stdout: '' }) });
  const productDb = Buffer.concat([Buffer.from([0x0a, 0x12]), Buffer.from('wow_classic_beta'), Buffer.from([0x1a, 0x28]), Buffer.from('F:/Games/World of Warcraft'), Buffer.from([0x00, 0x22])]);
  const f = { readFileSync: p => { if (/product\.db$/.test(p)) return productDb; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); }, readdirSync: () => [], statSync: () => { throw new Error('no'); } };
  const win = wowRoots({ platform: 'win32', home: 'C:\\Users\\p', env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files', ProgramData: 'C:\\ProgramData' }, run: reg.run, f });
  assert.equal(win[0], 'C:\\Program Files (x86)\\World of Warcraft');
  assert.ok(win.includes('E:\\Blizzard\\World of Warcraft'), 'the registry\'s InstallPath, flavor folder removed');
  assert.ok(win.includes('F:\\Games\\World of Warcraft'), 'product.db\'s install path');
  assert.ok(reg.calls.every(c => c.cmd === 'C:\\Windows\\System32\\reg.exe' && c.argv[0] === 'query' && c.shell === undefined), 'reg by its full path, never a bare name the working folder could answer');
  assert.deepEqual(productDbRoots(productDb), ['F:\\Games\\World of Warcraft']);

  const home = tmp();
  fs.mkdirSync(path.join(home, 'Games', 'wow-lutris'), { recursive: true });
  const lin = wowRoots({ platform: 'linux', home, env: { WINEPREFIX: '/pfx' } });
  assert.equal(lin[0], '/pfx/drive_c/Program Files (x86)/World of Warcraft');
  // Linux's roots are joined by Linux's rules (path.posix), whatever computer asks.
  assert.ok(lin.includes(path.posix.join(home, '.wine', 'drive_c', 'Program Files (x86)', 'World of Warcraft')), JSON.stringify(lin));
  assert.ok(lin.includes(path.posix.join(home, 'Games', 'wow-lutris', 'drive_c', 'Program Files (x86)', 'World of Warcraft')), 'a Lutris prefix');
});

// SY-14: two process-list checks at once on a folder with no game said "running": each pgrep's own
// command line held the pattern it searched for. "Warcraf[t]" never matches its own text (real pgrep).
test('wowRunningAsync: two checks at once on a folder with no game both say not running (real pgrep)', { skip: process.platform === 'win32' ? 'no pgrep on Windows (tasklist)' : false }, async () => {
  const flavorDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-nogame-')), 'World of Warcraft (x)', '_forever_');
  fs.mkdirSync(flavorDir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    const both = await Promise.all([wowRunningAsync({ platform: 'darwin', flavorDir }), wowRunningAsync({ platform: 'darwin', flavorDir })]);
    assert.deepEqual(both.map(r => r.running), [false, false], `round ${i + 1}`);
  }
});

test('wowRunning: pgrep -f with the flavor folder escaped (no shell); tasklist on Windows; our own pid never counts', () => {
  const mac = runStub({ pgrep: argv => ({ status: 0, stdout: `4242\n${process.pid}\n`, argv }) });
  assert.deepEqual(wowRunning({ platform: 'darwin', flavorDir: '/Applications/World of Warcraft (x)/_forever_', run: mac.run }), { running: true, pids: [4242] });
  assert.deepEqual(mac.calls[0].argv, ['-f', '/Applications/World of Warcraft \\(x\\)/_forever_/.*World of Warcraf[t]'], 'regex characters from the path are escaped; "Warcraf[t]" never matches the pgrep\'s own line (SY-14)');
  const none = runStub({ pgrep: { status: 1, stdout: '' } });
  assert.equal(wowRunning({ platform: 'darwin', run: none.run }).running, false);
  assert.match(none.calls[0].argv[1], /World of Warcraft/);
  const lin = runStub({ pgrep: { status: 0, stdout: '77\n' } });
  assert.equal(wowRunning({ platform: 'linux', run: lin.run }).running, true);
  assert.deepEqual(lin.calls[0].argv, ['-f', 'Wow[A-Za-z]*(-64)?\\.exe']);
  const csv = '"System","4","Services","0","100 K"\r\n"WowClassicB.exe","5120","Console","1","900,000 K"\r\n"WowVoiceProxy.exe","5200","Console","1","10,000 K"\r\n"Battle.net.exe","400","Console","1","200,000 K"\r\n';
  assert.deepEqual(parseTasklist(csv), [5120]);
  // tasklist names no paths, so the addon manager WowUp and the game's own helpers are refused by
  // name (display DR-05, D-03); the -ARM64 build counts.
  const more = ['"WowUp.exe","700","Console","1","300,000 K"', '"WOWUP.EXE","701","Console","1","1 K"', '"WowError.exe","702","Console","1","1 K"',
    '"Wow-ARM64.exe","703","Console","1","1 K"', '"Wow-64.exe","704","Console","1","1 K"', '"Wow.exe","705","Console","1","1 K"'].join('\r\n');
  assert.deepEqual(parseTasklist(more), [703, 704, 705]);
  assert.deepEqual(NOT_GAME, ['VoiceProxy', 'Error']);
  assert.ok(Object.isFrozen(NOT_GAME));
  const win = runStub({ tasklist: { status: 0, stdout: csv } });
  assert.deepEqual(wowRunning({ platform: 'win32', run: win.run, env: { SystemRoot: 'D:\\WINDOWS' } }), { running: true, pids: [5120] });
  assert.deepEqual(win.calls[0].argv, ['/FO', 'CSV', '/NH']);
  assert.equal(win.calls[0].cmd, 'D:\\WINDOWS\\System32\\tasklist.exe', 'by its full path (final review L3-7)');
});

test('installAddon refuses while WoW runs, and says a new addon needs a full restart', () => {
  const root = tmp();
  const dir = makeInstall(root, '_forever_');
  const r = installAddon({ flavorDir: dir, running: true });
  assert.deepEqual(r, { ok: false, error: 'wow_running', detail: `Quit World of Warcraft completely first (not just log out). ${RESTART_LINE}` });
  assert.equal(fs.existsSync(path.join(dir, 'Interface', 'AddOns', 'NeverQuestAlone')), false, 'nothing written');
  assert.equal(installAddon({ flavorDir: path.join(root, 'nope'), running: false }).error, 'wow_not_found');
  assert.equal(installAddon({ flavorDir: 'relative/_forever_', running: false }).error, 'wow_not_found');
});

test('installAddon copies the addon, makes the slot pool and the doorbells, checks every file, keeps a bridge-written Inbox.lua', () => {
  const root = tmp();
  const dir = makeInstall(root, '_classic_beta_', { buildInfo: BUILD_INFO });
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone', 'sig', 'ctl'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'NeverQuestAlone', 'Inbox.lua'), 'NQA_Inbox = { v = 2 }\n');
  fs.writeFileSync(path.join(addons, 'NeverQuestAlone', 'sig', 'ctl', 'bell_push_a.wav'), '');
  const r = installAddon({ flavorDir: dir, running: false, slots: 7 });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(r.steps.map(s => [s.name, s.ok]), [['Addon folder', true], ['7 slot folders', true], ['Doorbell folder', true], ['Checked every file', true]]);
  assert.equal(r.restartNeeded, true);
  assert.equal(r.iface, '16001');
  assert.ok(fs.existsSync(path.join(addons, 'NeverQuestAlone', 'NeverQuestAlone.toc')));
  assert.equal(fs.readFileSync(path.join(addons, 'NeverQuestAlone', 'Inbox.lua'), 'utf8'), 'NQA_Inbox = { v = 2 }\n', 'the bridge\'s inbox is kept');
  assert.equal(fs.readFileSync(path.join(addons, 'NeverQuestAlone', 'Chats.lua'), 'utf8'), fs.readFileSync(path.join(ADDON_SOURCE, 'Chats.lua'), 'utf8'));
  assert.match(fs.readFileSync(path.join(addons, 'NQA_S007', 'NQA_S007.toc'), 'utf8'), /^## Interface: 16001$/m);
  for (const f of ['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act']) assert.ok(fs.existsSync(path.join(addons, 'NeverQuestAlone', 'sig', 'ctl', `${f}.wav`)), f);
  assert.equal(r.permissions.ok, true);
  // No addon files in this build: say so, write nothing.
  const empty = tmp();
  const dir2 = makeInstall(tmp(), '_forever_');
  assert.equal(installAddon({ flavorDir: dir2, running: false, addonSource: empty }).error, 'addon_missing');
});

test('R3: the installed addon\'s TOC is stamped: the product\'s Title and the AddOns list\'s bullet-list Notes, which are the repo TOC\'s since main 0.5.3, so it is the repo\'s line for line (the addon reads none of it: one build); the slot TOCs are the one slotToc, under one "NeverQuestAlone Parts" row (E-047)', () => {
  const repoToc = fs.readFileSync(path.join(ADDON_SOURCE, 'NeverQuestAlone.toc'), 'utf8');
  const field = (t, k) => (t.match(new RegExp(`^## ${k}:[ \\t]*(.*)$`, 'm')) || [])[1];
  // One product name everywhere (C-120, C-124) and the owner's bullet list (main c9599b5): the stamp's
  // Title and Notes are the repo TOC's.
  assert.equal(PUBLIC_TITLE, 'NeverQuestAlone');
  assert.equal(field(repoToc, 'Title'), PUBLIC_TITLE);
  assert.equal(field(repoToc, 'Notes'), PUBLIC_NOTES);
  assert.match(PUBLIC_NOTES, /^• Ask anything, right in the game\|n• /, 'a short bullet list, a |n between lines');
  assert.doesNotMatch(repoToc, /X-Backend/);
  const dir = makeInstall(tmp(), '_forever_');
  assert.equal(installAddon({ flavorDir: dir, running: false, slots: 2 }).ok, true);
  const toc = fs.readFileSync(path.join(dir, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8');
  assert.match(toc, /^## Title: NeverQuestAlone$/m);
  assert.doesNotMatch(toc, /X-Backend/, 'no build\'s mark (the two-build addon read one until 2026-09-29)');
  assert.equal(field(toc, 'Notes'), PUBLIC_NOTES);
  for (const k of ['Title', 'Notes']) assert.doesNotMatch(field(toc, k), /bridge/, `the list's ${k}: one product name, no plumbing`);
  // Everything else, line for line: the interface, version, saved variables and the files in order.
  assert.equal(toc, repoToc);
  // The slot addons, 200 rows of the game's AddOns list: slotToc's title and notes, the parts'
  // category, each its own group and the addon's icon, as the addon zip writes them too (E-047), so
  // the list shows one folded "NeverQuestAlone Parts" row.
  const s2 = fs.readFileSync(path.join(dir, 'Interface', 'AddOns', 'NQA_S002', 'NQA_S002.toc'), 'utf8');
  assert.equal(s2, slotToc(2, '16001'));
  assert.match(s2, /^## Title: NeverQuestAlone Part 002$/m);
  assert.match(s2, /^## Notes: A part of NeverQuestAlone that brings replies into the game\. Leave it checked\.$/m);
  assert.equal(field(s2, 'Category'), SLOT_CATEGORY);
  assert.equal(field(s2, 'Group'), 'NQA_S002');
  assert.equal(field(s2, 'IconTexture'), SLOT_ICON);
  assert.match(s2, /^## LoadOnDemand: 1$/m);
  assert.match(s2, /^## Dependencies: NeverQuestAlone$/m);
  assert.doesNotMatch(s2, /Reply slot|Load-on-demand/);
  const mainSlots = tmp();
  installSlots(mainSlots, { count: 2, iface: '16001' });
  assert.equal(fs.readFileSync(path.join(mainSlots, 'NQA_S002', 'NQA_S002.toc'), 'utf8'), s2, 'one slotToc for every install');
  // Stamping is idempotent, a TOC without a Title gets one, and older words give way to the product's.
  assert.equal(stampToc(toc), toc);
  assert.match(stampToc('## Interface: 16001\nCodec.lua\n'), /^## Title: NeverQuestAlone\n## Interface: 16001\n/);
  assert.equal(stampToc(`## Title: NeverQuestAlone\n## X-Backend: byok\n## Interface: 16001\nCodec.lua\n`), `## Title: ${PUBLIC_TITLE}\n## Interface: 16001\nCodec.lua\n`, 'an earlier build\'s mark goes');
  const old = stampToc('## Interface: 16001\n## Title: NeverQuestAlone\n## Notes: Talk to your AI from inside the game.\nCodec.lua\n');
  assert.equal(field(old, 'Title'), PUBLIC_TITLE);
  assert.equal(field(old, 'Notes'), PUBLIC_NOTES);
  // A second install over it (an update) stamps the same.
  assert.equal(installAddon({ flavorDir: dir, running: false, slots: 2 }).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8'), toc);
});

test('C-119: installAddon folds the parts\' row in the game\'s AddOns list once per install, as setup does: recorded in the app\'s config, only while the game is closed, and never over a player\'s unfold', () => {
  const dir = makeInstall(tmp(), '_forever_');
  const configFile = path.join(tmp('bones-cfg-'), 'config.json');
  fs.writeFileSync(configFile, `${JSON.stringify({ wow: { flavorDir: dir }, byok: { provider: 'anthropic' } }, null, 2)}\n`, { mode: 0o600 });
  const r = installAddon({ flavorDir: dir, running: false, slots: 2, configFile });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.equal(r.partsFold, 'folded');
  // The game's own file and layout for a new one, with our one key (slots.mjs foldSlotCategory).
  const file = addonListFile(dir);
  assert.equal(fs.readFileSync(file, 'latin1'), `\n${FOLD_VAR} = {\n\t["${SLOT_CATEGORY}"] = true,\n}\n`);
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(cfg.partsFolded, SLOT_CATEGORY, 'once per install, by the category\'s name');
  assert.deepEqual(cfg.byok, { provider: 'anthropic' }, 'the app\'s settings kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(configFile).mode & 0o777, 0o600, 'the config keeps its mode');
  // The app's next save keeps the record (config.mjs saveConfig keeps the file's other keys).
  saveConfig({ wow: { flavorDir: dir, account: '' }, byok: { provider: 'openai' } }, configFile);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).partsFolded, SLOT_CATEGORY);
  // The player unfolds the row (the game saves the table without our key); an update's install
  // leaves it open.
  const unfolded = `\n${FOLD_VAR} = {\n}\n`;
  fs.writeFileSync(file, unfolded, 'latin1');
  const again = installAddon({ flavorDir: dir, running: false, slots: 2, configFile });
  assert.equal(again.ok, true);
  assert.equal(again.partsFold, 'done before');
  assert.equal(fs.readFileSync(file, 'latin1'), unfolded);
  // The game started while the files went in: asked again right before the fold, so nothing is
  // folded or recorded (the addon folds the row at its first logout instead).
  const dir2 = makeInstall(tmp(), '_forever_');
  const cfg2 = path.join(tmp('bones-cfg-'), 'config.json');
  let asked = 0;
  const late = installAddon({ flavorDir: dir2, running: () => ++asked > 1, slots: 2, configFile: cfg2 });
  assert.equal(late.ok, true, JSON.stringify(late.steps));
  assert.equal(late.partsFold, 'running');
  assert.equal(asked, 2, 'asked before the install and again at the fold');
  assert.ok(!fs.existsSync(addonListFile(dir2)));
  assert.ok(!fs.existsSync(cfg2), 'nothing recorded');
  // While the game runs, nothing is installed or folded.
  assert.equal(installAddon({ flavorDir: dir2, running: true, slots: 2, configFile: cfg2 }).error, 'wow_running');
  assert.ok(!fs.existsSync(addonListFile(dir2)));
  // A config it can't read: no fold (without the record, a later install could undo an unfold);
  // the install itself stands.
  const dir3 = makeInstall(tmp(), '_forever_');
  const cfg3 = path.join(tmp('bones-cfg-'), 'config.json');
  fs.writeFileSync(cfg3, '{ not json');
  const unread = installAddon({ flavorDir: dir3, running: false, slots: 2, configFile: cfg3 });
  assert.equal(unread.ok, true);
  assert.equal(unread.partsFold, 'config unreadable');
  assert.ok(!fs.existsSync(addonListFile(dir3)));
  // No config given: no fold, and nothing about one in the result.
  assert.equal('partsFold' in installAddon({ flavorDir: dir3, running: false, slots: 2 }), false);
  assert.ok(!fs.existsSync(addonListFile(dir3)));
});

test('R3 (lane D): one stamp for every copy a player gets: the release zip\'s (tools/stamp-toc.mjs) is the install\'s byte for byte; the addon loads the same from either TOC, before any slot (it reads no stamp: one build)', async () => {
  const { stampAddonCopy } = await import('../../tools/stamp-toc.mjs');
  const dir = makeInstall(tmp(), '_forever_');
  assert.equal(installAddon({ flavorDir: dir, running: false, slots: 1 }).ok, true);
  const installed = fs.readFileSync(path.join(dir, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8');
  // release.yml's Stage step: a plain copy of the repo's addon, then the tool.
  const stage = path.join(tmp('bones-stage-'), 'NeverQuestAlone');
  fs.cpSync(ADDON_SOURCE, stage, { recursive: true });
  const cli = spawnSync(process.execPath, [path.join(REPO, 'tools', 'stamp-toc.mjs'), stage], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(fs.readFileSync(path.join(stage, 'NeverQuestAlone.toc'), 'utf8'), installed, 'the zip\'s TOC is the install\'s');
  assert.equal(stampAddonCopy(stage), installed, 'and stamping again changes nothing');
  // Never the repo's own folder (the installer stamps each copy).
  const repoBefore = fs.readFileSync(path.join(ADDON_SOURCE, 'NeverQuestAlone.toc'), 'utf8');
  const refused = spawnSync(process.execPath, [path.join(REPO, 'tools', 'stamp-toc.mjs'), ADDON_SOURCE], { encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.equal(fs.readFileSync(path.join(ADDON_SOURCE, 'NeverQuestAlone.toc'), 'utf8'), repoBefore);
  assert.doesNotMatch(repoBefore, /X-Backend/);
  // The addon, reading its metadata from that TOC as the game does at its start, before any slot
  // has loaded (no stand-in that answers "byok" whatever the file says): the one build either way.
  const { newVM } = createRequire(import.meta.url)('../helpers/nqa-vm.js');
  const metaOf = text => Object.fromEntries([...text.matchAll(/^## ([A-Za-z-]+):[ \t]*(.*)$/gm)].map(m => [m[1], m[2].trim()]));
  const lua = meta => `C_AddOns.GetAddOnMetadata = function(name, field) local m = ${'{ ' + Object.entries(meta).map(([k, v]) => `[${JSON.stringify(k)}] = ${JSON.stringify(v)}`).join(', ') + ' }'}; return m[field] end\n`;
  const app = newVM({ extra: lua(metaOf(installed)) }).login();
  assert.equal(app.num('#STUB.loads'), 0, 'no slot loaded yet');
  assert.equal(app.evaluate('SLASH_BONES1'), '/nqa');
  assert.equal(app.evaluate('NS.AppInstall'), null, 'nothing reads the stamp');
  const repo = newVM({ extra: lua(metaOf(fs.readFileSync(path.join(ADDON_SOURCE, 'NeverQuestAlone.toc'), 'utf8'))) }).login();
  assert.equal(repo.evaluate('SLASH_BONES1'), '/nqa', 'the repo\'s TOC, unstamped: the same addon');
  assert.equal(repo.evaluate('select(2, NS.Transport.Light())'), app.evaluate('select(2, NS.Transport.Light())'));
});

test('TH12: a group- or world-writable AddOns folder is reported, and tightened on request when it\'s ours', { skip: POSIX_MODES }, () => {
  const root = tmp();
  const dir = makeInstall(root, '_forever_');
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.chmodSync(addons, 0o777);
  const r = checkAddonsPermissions(addons, { platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.worldWritable, true);
  assert.deepEqual(r.paths, [addons]);
  assert.equal(r.fixable, true);
  // The player's computer by its name (STYLE §2.1; UX-W41): this Mac on macOS, this computer elsewhere.
  assert.match(r.detail, /Every account on this Mac can change/);
  assert.match(checkAddonsPermissions(addons, { platform: 'linux' }).detail, /Every account on this computer can change/);
  const fixed = checkAddonsPermissions(addons, { platform: 'darwin', tighten: true });
  assert.deepEqual(fixed.fixed, [addons]);
  assert.equal(fixed.ok, true);
  assert.equal(fs.statSync(addons).mode & 0o777, 0o755);
  const notMine = checkAddonsPermissions(addons, { platform: 'darwin', uid: -5 });
  assert.equal(notMine.ok, true, 'already tight');
  fs.chmodSync(addons, 0o775);
  const other = checkAddonsPermissions(addons, { platform: 'darwin', tighten: true, uid: -5 });
  assert.equal(other.ok, false, 'a folder another account owns is only reported');
  assert.equal(other.fixable, false);
  assert.equal(other.groupWritable, true);
  fs.chmodSync(addons, 0o755);
  // installAddon passes tighten through and reports the result.
  fs.chmodSync(addons, 0o777);
  const inst = installAddon({ flavorDir: dir, running: false, slots: 2, tighten: true });
  assert.equal(inst.ok, true);
  assert.deepEqual(inst.permissions.fixed, [addons]);
});

test('TH12 on Windows: icacls write grants to Everyone, Users or Authenticated Users are reported, never changed', () => {
  const out = [
    'C:\\Program Files (x86)\\World of Warcraft\\_classic_beta_\\Interface\\AddOns BUILTIN\\Users:(I)(OI)(CI)(F)',
    '                                                                          NT AUTHORITY\\SYSTEM:(I)(OI)(CI)(F)',
    '                                                                          BUILTIN\\Administrators:(I)(OI)(CI)(F)',
    '                                                                          NT AUTHORITY\\Authenticated Users:(I)(M)',
    '                                                                          Everyone:(OI)(CI)(RX)',
    '',
    'Successfully processed 1 files; Failed processing 0 files',
  ].join('\r\n');
  assert.deepEqual(broadWritersFromIcacls(out), ['BUILTIN\\Users:(I)(OI)(CI)(F)', 'NT AUTHORITY\\Authenticated Users:(I)(M)']);
  const { run, calls } = runStub({ icacls: { status: 0, stdout: out } });
  const r = checkAddonsPermissions('C:\\WoW\\_forever_\\Interface\\AddOns', { platform: 'win32', run, tighten: true });
  assert.equal(r.ok, false);
  assert.equal(r.worldWritable, true);
  assert.equal(r.fixable, false);
  assert.deepEqual(calls.map(c => [c.cmd, c.argv]), [['C:\\Windows\\System32\\icacls.exe', ['C:\\WoW\\_forever_\\Interface\\AddOns']]], 'read only, one argument list, by its full path');
  const tight = runStub({ icacls: { status: 0, stdout: 'X NT AUTHORITY\\SYSTEM:(F)\r\n  BUILTIN\\Users:(RX)\r\n' } });
  assert.equal(checkAddonsPermissions('C:\\x', { platform: 'win32', run: tight.run }).ok, true);
});

// ---------------------------------------------------------------- TH12: links and permissions

const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
/** Every link under a folder (lstat, never followed). */
function linksUnder(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) out.push(p); else if (e.isDirectory()) walk(p); } };
  walk(dir);
  return out;
}

test('installAddon never writes through a link another account planted in AddOns: the links go, the files they point at stay', { skip: PLANTED_LINKS }, () => {
  const root = tmp();
  const outside = tmp('bones-victim-');
  const victim = f => path.join(outside, f);
  for (const f of ['zshrc', 'toc2', 'inbox3']) fs.writeFileSync(victim(f), `mine: ${f}\n`);
  fs.mkdirSync(victim('slotdir'));
  fs.mkdirSync(victim('sigdir'));
  const dir = makeInstall(root, '_forever_');
  const addons = path.join(dir, 'Interface', 'AddOns');
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone'));
  fs.symlinkSync(victim('zshrc'), path.join(addons, 'NeverQuestAlone', 'NeverQuestAlone.toc'));
  fs.symlinkSync(victim('sigdir'), path.join(addons, 'NeverQuestAlone', 'sig'));
  fs.symlinkSync(victim('slotdir'), path.join(addons, 'NQA_S001'));
  fs.mkdirSync(path.join(addons, 'NQA_S002'));
  fs.symlinkSync(victim('toc2'), path.join(addons, 'NQA_S002', 'NQA_S002.toc'));
  fs.mkdirSync(path.join(addons, 'NQA_S003'));
  fs.symlinkSync(victim('inbox3'), path.join(addons, 'NQA_S003', 'Inbox.lua'));
  fs.symlinkSync(victim('not-there-yet'), path.join(addons, 'NQA_S003', 'NQA_S003.toc')); // a dangling one
  const r = installAddon({ flavorDir: dir, running: false, slots: 3 });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  for (const f of ['zshrc', 'toc2', 'inbox3']) assert.equal(fs.readFileSync(victim(f), 'utf8'), `mine: ${f}\n`, `${f} untouched`);
  assert.deepEqual(fs.readdirSync(victim('slotdir')), [], 'nothing written into a linked slot folder');
  assert.deepEqual(fs.readdirSync(victim('sigdir')), [], 'nor a linked doorbell folder');
  assert.equal(fs.existsSync(victim('not-there-yet')), false, 'nor created through a dangling link');
  assert.deepEqual(linksUnder(addons), [], 'no link left');
  assert.match(fs.readFileSync(path.join(addons, 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8'), /^## Interface: /m);
  assert.match(fs.readFileSync(path.join(addons, 'NQA_S002', 'NQA_S002.toc'), 'utf8'), /^## Interface: /m);
  // The whole addon folder a link to somewhere else: replaced by a real folder.
  const dir2 = makeInstall(tmp(), '_forever_');
  const addons2 = path.join(dir2, 'Interface', 'AddOns');
  fs.symlinkSync(victim('slotdir'), path.join(addons2, 'NeverQuestAlone'));
  assert.equal(installAddon({ flavorDir: dir2, running: false, slots: 1 }).ok, true);
  assert.equal(isLink(path.join(addons2, 'NeverQuestAlone')), false);
  assert.deepEqual(fs.readdirSync(victim('slotdir')), []);
});

test('the bridge\'s slot and doorbell writes never follow a link planted in their place', { skip: PLANTED_LINKS }, async () => {
  const { writeSlots, installSlots } = await import('../../bridge/transport/slots.mjs');
  const { createSignals } = await import('../../bridge/transport/signals.mjs');
  const outside = tmp('bones-victim-');
  const victim = path.join(outside, 'zshrc');
  fs.writeFileSync(victim, 'mine\n');
  const addons = path.join(tmp(), 'AddOns');
  fs.mkdirSync(addons);
  installSlots(addons, { count: 2, iface: '16001' });
  // A temp file the bridge renames into place, linked to a file elsewhere.
  fs.symlinkSync(victim, path.join(addons, 'NQA_S001', 'Inbox.lua.tmp'));
  const w = writeSlots(addons, 'NQA_SlotData = { v = 2 }\n', 'NQA_Inbox = { v = 2 }\n', { count: 2 });
  assert.equal(w.errors, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'mine\n');
  assert.equal(fs.readFileSync(path.join(addons, 'NQA_S001', 'Inbox.lua'), 'utf8'), 'NQA_SlotData = { v = 2 }\n');
  assert.equal(isLink(path.join(addons, 'NQA_S001', 'Inbox.lua')), false);
  // A doorbell put back in place (the bridge's start does it) where a dangling link now sits.
  const bell = path.join(addons, 'NeverQuestAlone', 'sig', 'ctl', 'bell_act.wav');
  fs.rmSync(bell);
  fs.symlinkSync(path.join(outside, 'made-by-the-bell'), bell);
  assert.deepEqual(createSignals(addons).ensure(), ['act']);
  assert.equal(fs.existsSync(path.join(outside, 'made-by-the-bell')), false, 'nothing made through it');
  assert.equal(isLink(bell), false);
  assert.ok(fs.lstatSync(bell).isFile(), 'the bell is back, a plain file');
});

test('publishing never writes through a slot folder or NeverQuestAlone/ swapped for a link after install, or into a folder another account owns (audit CV-04, TH12)', { skip: PLANTED_LINKS }, async () => {
  const { writeSlots, installSlots } = await import('../../bridge/transport/slots.mjs');
  const outside = tmp('bones-victim-');
  const mine = path.join(outside, 'mine'), mine2 = path.join(outside, 'mine2');
  fs.mkdirSync(mine); fs.mkdirSync(mine2);
  fs.writeFileSync(path.join(mine, 'Inbox.lua'), 'the player\'s own file\n');
  const addons = path.join(tmp(), 'AddOns');
  fs.mkdirSync(addons);
  installSlots(addons, { count: 3, iface: '16001' });
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true });
  // While the bridge runs, another account moves S001 and NeverQuestAlone aside and links the names to the player's folders.
  fs.renameSync(path.join(addons, 'NQA_S001'), path.join(addons, 'moved-S001'));
  fs.symlinkSync(mine, path.join(addons, 'NQA_S001'), 'dir');
  fs.renameSync(path.join(addons, 'NeverQuestAlone'), path.join(addons, 'moved-NeverQuestAlone'));
  fs.symlinkSync(mine2, path.join(addons, 'NeverQuestAlone'), 'dir');
  const logs = [];
  const w = writeSlots(addons, 'NQA_SlotData = { v = 3 }\n', 'NQA_Inbox = { v = 3 }\n', { count: 3, log: (k, d) => logs.push([k, d]) });
  assert.equal(fs.readFileSync(path.join(mine, 'Inbox.lua'), 'utf8'), 'the player\'s own file\n', 'the player\'s file is untouched');
  assert.deepEqual(fs.readdirSync(mine2), [], 'nothing made in the other folder');
  assert.equal(w.errors, 2, 'both refused, and counted');
  assert.ok(logs.some(([k, d]) => k === 'slot-error' && d.error === 'not_a_folder'), 'the log says why');
  assert.equal(fs.readFileSync(path.join(addons, 'NQA_S002', 'Inbox.lua'), 'utf8'), 'NQA_SlotData = { v = 3 }\n', 'the real slots still get the table');
  // A real folder that isn't this account's (another account made it first) is refused too.
  const logs2 = [];
  const other = writeSlots(addons, 'x\n', 'y\n', { count: 3, uid: fs.statSync(path.join(addons, 'NQA_S002')).uid + 1, log: (k, d) => logs2.push([k, d]) });
  assert.equal(other.errors, 4, 'every folder is someone else\'s to this uid');
  assert.equal(fs.readFileSync(path.join(addons, 'NQA_S002', 'Inbox.lua'), 'utf8'), 'NQA_SlotData = { v = 3 }\n');
  // The next install repairs the links: real folders again, the player's untouched.
  installSlots(addons, { count: 3, iface: '16001' });
  assert.equal(isLink(path.join(addons, 'NQA_S001')), false);
  assert.equal(fs.readFileSync(path.join(mine, 'Inbox.lua'), 'utf8'), 'the player\'s own file\n');
  assert.equal(writeSlots(addons, 'z\n', 'z\n', { count: 3 }).errors, 1, 'only NeverQuestAlone/, which the addon install puts back, is left');
});

test('TH12: the flavor folder and the install root count (a loose, non-sticky parent); the addon\'s own files are walked and tightened', { skip: POSIX_MODES }, () => {
  const root = tmp();
  const dir = makeInstall(root, '_forever_');
  const addons = path.join(dir, 'Interface', 'AddOns');
  assert.equal(installAddon({ flavorDir: dir, running: false, slots: 2 }).ok, true);
  fs.chmodSync(root, 0o755);
  // Probe 4: the flavor folder 0777 with Interface and AddOns 0755.
  fs.chmodSync(dir, 0o777);
  const r = checkAddonsPermissions(addons, { platform: 'darwin' });
  assert.equal(r.ok, false);
  assert.equal(r.worldWritable, true);
  assert.deepEqual(r.paths, [dir]);
  const other = checkAddonsPermissions(addons, { platform: 'darwin', tighten: true, uid: -5 });
  assert.equal(other.ok, false);
  assert.equal(other.fixable, false, 'another account\'s folder is only reported');
  assert.equal(fs.statSync(dir).mode & 0o777, 0o777, 'and never changed');
  const fixed = checkAddonsPermissions(addons, { platform: 'darwin', tighten: true });
  assert.deepEqual(fixed.fixed, [dir]);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
  // The install's root, with the sticky bit: another account can't move our folders aside.
  fs.chmodSync(root, 0o1777);
  assert.equal(checkAddonsPermissions(addons, { platform: 'darwin' }).ok, true);
  fs.chmodSync(root, 0o777);
  assert.deepEqual(checkAddonsPermissions(addons, { platform: 'darwin' }).paths, [root]);
  fs.chmodSync(root, 0o755);
  // The addon's files and the slot folders the install wrote.
  const toc = path.join(addons, 'NeverQuestAlone', 'NeverQuestAlone.toc');
  const slotLua = path.join(addons, 'NQA_S002', 'Inbox.lua');
  fs.chmodSync(toc, 0o666);
  fs.chmodSync(path.join(addons, 'NQA_S001'), 0o777);
  fs.chmodSync(slotLua, 0o664);
  const files = checkAddonsPermissions(addons, { platform: 'darwin' });
  assert.equal(files.ok, false);
  assert.deepEqual(files.paths.sort(), [toc, path.join(addons, 'NQA_S001'), slotLua].sort());
  assert.equal(files.fixable, true);
  const t2 = checkAddonsPermissions(addons, { platform: 'darwin', tighten: true });
  assert.equal(t2.fixed.length, 3);
  assert.equal(fs.statSync(toc).mode & 0o777, 0o644);
  assert.equal(checkAddonsPermissions(addons, { platform: 'darwin' }).ok, true);
  // Another account's file there, or a link: reported, never "fixed".
  fs.symlinkSync(os.tmpdir(), path.join(addons, 'NeverQuestAlone', 'Extra.lua'));
  const linked = checkAddonsPermissions(addons, { platform: 'darwin', tighten: true });
  assert.equal(linked.ok, false);
  assert.deepEqual(linked.links, [path.join(addons, 'NeverQuestAlone', 'Extra.lua')]);
  assert.equal(linked.fixable, false);
  fs.rmSync(path.join(addons, 'NeverQuestAlone', 'Extra.lua'));
  const foreign = checkAddonsPermissions(addons, { platform: 'darwin', uid: -5 });
  assert.equal(foreign.ok, false, 'the addon\'s files belong to another account');
  assert.ok(foreign.paths.includes(toc));
  assert.equal(foreign.fixable, false);
});

test('the Windows uninstaller\'s list of WoW folders (audit CV-07): UTF-16 with a byte-order mark, newest first, at most 8, Windows only', () => {
  const data = tmp('bones-record-');
  const file = path.join(data, UNINSTALL_RECORD);
  const a = 'C:\\Program Files (x86)\\World of Warcraft\\_forever_';
  const b = 'D:\\Spiele Jürgen\\World of Warcraft\\_forever_';
  // Only on Windows, only into a data folder that exists, only an absolute Windows path a value can hold.
  assert.equal(recordAddonFolder({ userData: data, flavorDir: a, platform: 'darwin' }), false);
  assert.equal(recordAddonFolder({ userData: path.join(data, 'missing'), flavorDir: a, platform: 'win32' }), false);
  for (const bad of ['World of Warcraft\\_forever_', 'C:\\a"b', 'C:\\a\nb', '', null]) assert.equal(recordAddonFolder({ userData: data, flavorDir: bad, platform: 'win32' }), false, String(bad));
  assert.equal(fs.existsSync(file), false);
  assert.equal(recordAddonFolder({ userData: data, flavorDir: a, platform: 'win32' }), true);
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe], 'a UTF-16LE byte-order mark: the Windows profile API (ReadINIStr) reads it as Unicode');
  const text = bytes.subarray(2).toString('utf16le');
  assert.match(text, /\r\n\[addon\]\r\nfolder1="C:\\Program Files \(x86\)\\World of Warcraft\\_forever_"\r\n$/);
  // A second folder goes first; the first one again moves back to the top, never twice (any case).
  assert.equal(recordAddonFolder({ userData: data, flavorDir: b, platform: 'win32' }), true);
  assert.deepEqual(readUninstallRecord(file), [b, a], 'a non-ASCII path comes back whole');
  assert.equal(recordAddonFolder({ userData: data, flavorDir: b.toUpperCase(), platform: 'win32' }), false, 'already first: nothing written');
  assert.equal(recordAddonFolder({ userData: data, flavorDir: a.toLowerCase(), platform: 'win32' }), true);
  assert.deepEqual(readUninstallRecord(file), [a.toLowerCase(), b]);
  for (let i = 0; i < 12; i++) recordAddonFolder({ userData: data, flavorDir: `E:\\Games${i}\\World of Warcraft\\_forever_`, platform: 'win32' });
  const list = readUninstallRecord(file);
  assert.equal(list.length, UNINSTALL_RECORD_MAX);
  assert.equal(list[0], 'E:\\Games11\\World of Warcraft\\_forever_');
  assert.deepEqual(fs.readdirSync(data), [UNINSTALL_RECORD], 'written through a temp file, nothing left beside it');
  // A UTF-8 file (someone edited it) still reads; junk lines don't.
  fs.writeFileSync(file, '\uFEFF[addon]\nfolder1="C:\\x"\nfolder2=C:\\unquoted\nnonsense\n');
  assert.deepEqual(readUninstallRecord(file), ['C:\\x']);
  assert.deepEqual(readUninstallRecord(path.join(data, 'none.ini')), []);
  fs.rmSync(data, { recursive: true, force: true });
});
