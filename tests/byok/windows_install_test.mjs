// The Windows installer and uninstaller, run for real (systems critic SY-01; audit CV-07), and an
// update in place (SY-25). test.yml's windows-smoke job runs this after packaging, on the installer
// it signed (NQA_INSTALLER, with NQA_REQUIRE_INSTALLER=1 so a missing one fails) and the
// same tree built as an older version (NQA_PREVIOUS_INSTALLER). Everywhere else it skips.
//
//   before  a fake World of Warcraft folder (a path with non-ASCII characters in it) holding the
//           addon and its 200 slot folders, installed the app's own way (installAddon), the chats
//           the game would keep for it under two accounts, and another addon with its own saved
//           variables; the app's data folder (%APPDATA%\NeverQuestAlone) with its settings and the
//           uninstaller's list of WoW folders, written the app's way (recordAddonFolder); a canary
//           key in Credential Manager through the app's key store; the login item; the update cache
//   then    the installer (/S), the installed app's --self-test, the uninstaller (/S)
//   after   the install folder, its shortcuts, %APPDATA%\NeverQuestAlone, the key, the login item,
//           the update cache, the addon's folders and its saved chats are gone; the other addon,
//           its saved variables and a folder whose name only looks like the addon's stay
//
// The update in place: the same world, plus the app's own chats (a transcript), with the previous
// version installed (/S; its self-test says that version). Then this build arrives the way the app
// gets it: the app's updater (app/desktop/updater.mjs startUpdater: electron-updater's own
// NsisUpdater, the version guard, the publisher check against the installed app's app-update.yml)
// checks a feed, downloads the installer, and when the app quits runs it as electron-updater does
// (--updated /S). Only Electron's app object, its network stack and the feed's address stand in:
// the feed is this build's latest.yml and installer, served on 127.0.0.1. After it, this build is
// installed (its self-test says this version), the app wasn't started, and the key, both kinds of
// chats, the settings, the uninstaller's list, the addon's folders and the login item are as they
// were; then the uninstaller leaves nothing, as above.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { installAddon, recordAddonFolder, readUninstallRecord, isAddonFolder, UNINSTALL_RECORD } from '../../bridge/byok/wow.mjs';
import { saveConfig } from '../../bridge/config.mjs';
import { createTranscripts } from '../../bridge/byok/runtime/history.mjs';
import { run as selfTest, resultLine } from '../../app/desktop/scripts/self-test.mjs';
import { startUpdater, strictSignatureVerifier, readInstallerVersion, isNewer } from '../../app/desktop/updater.mjs';
import { CANARY_KEYS } from './helpers/canary.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';

const WIN = process.platform === 'win32';
const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const INSTALLER = process.env.NQA_INSTALLER ? path.resolve(process.env.NQA_INSTALLER) : null;
const PREVIOUS = process.env.NQA_PREVIOUS_INSTALLER ? path.resolve(process.env.NQA_PREVIOUS_INSTALLER) : null;
const REQUIRED = process.env.NQA_REQUIRE_INSTALLER === '1';
const skip = !WIN ? 'Windows only (the NSIS installer)'
  : (INSTALLER && fs.existsSync(INSTALLER)) || REQUIRED ? false
    : "no installer: set NQA_INSTALLER (test.yml's windows-smoke job builds one and runs this)";
const skipUpdate = !WIN ? 'Windows only (the NSIS installer)'
  : (INSTALLER && fs.existsSync(INSTALLER) && PREVIOUS && fs.existsSync(PREVIOUS)) || REQUIRED ? false
    : "no previous installer: set NQA_INSTALLER and NQA_PREVIOUS_INSTALLER (test.yml's windows-smoke job builds both and runs this)";

const APP_ID = 'com.neverquestalone.app';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const system32 = exe => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
const reg = args => spawnSync(system32('reg.exe'), args, { encoding: 'utf8', windowsHide: true });
const cmdkeyList = () => spawnSync(system32('cmdkey.exe'), ['/list'], { encoding: 'utf8', windowsHide: true }).stdout;
const running = image => spawnSync(system32('tasklist.exe'), ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${image}`], { encoding: 'utf8', windowsHide: true }).stdout.toLowerCase().includes(`"${image.toLowerCase()}"`);
const exists = p => fs.existsSync(p);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(cond, ms, what) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(250);
  }
  return Date.now() - t0;
}

/** Where the installer puts things, and the app's folders. */
function places() {
  const LOCAL = process.env.LOCALAPPDATA;
  const ROAMING = process.env.APPDATA;
  const INSTALL_DIR = path.join(LOCAL, 'Programs', 'neverquestalone');
  return {
    LOCAL, ROAMING, INSTALL_DIR,
    EXE: path.join(INSTALL_DIR, 'NeverQuestAlone.exe'),
    UNINSTALLER: path.join(INSTALL_DIR, 'Uninstall NeverQuestAlone.exe'),
    DATA: path.join(ROAMING, 'NeverQuestAlone'),
    CACHE: path.join(LOCAL, 'neverquestalone-updater'),
    SHORTCUTS: [path.join(ROAMING, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'NeverQuestAlone.lnk'), path.join(process.env.USERPROFILE ?? '', 'Desktop', 'NeverQuestAlone.lnk')],
  };
}

/**
 * The player's world before an install: the WoW folder with the addon installed the app's way (under
 * a non-ASCII path), its chats and another addon; the app's data folder with its settings and the
 * uninstaller's list; a canary key; the login item; and (updateCache) the update cache.
 */
async function seedWorld(P, ks, { updateCache = true } = {}) {
  const base = fs.mkdtempSync(path.join(P.LOCAL, 'bones-ci-wow-'));
  const flavorDir = path.join(base, 'Spiele Jürgen', 'World of Warcraft', '_forever_');
  const addons = path.join(flavorDir, 'Interface', 'AddOns');
  const accounts = path.join(flavorDir, 'WTF', 'Account');
  fs.mkdirSync(flavorDir, { recursive: true });
  fs.writeFileSync(path.join(flavorDir, 'WowClassic.exe'), '');
  const installed = installAddon({ flavorDir, platform: 'win32', running: false });
  assert.equal(installed.ok, true, JSON.stringify(installed.steps));
  fs.mkdirSync(path.join(addons, 'OtherAddon'), { recursive: true });
  fs.writeFileSync(path.join(addons, 'OtherAddon', 'OtherAddon.toc'), '## Interface: 16001\n');
  fs.mkdirSync(path.join(addons, 'NQA_Extras'), { recursive: true });
  fs.mkdirSync(path.join(addons, 'NQA_Data'), { recursive: true }); // the addon's data folder, where one is kept
  for (const acct of ['FAKEACCOUNT', 'SECOND']) {
    const sv = path.join(accounts, acct, 'SavedVariables');
    fs.mkdirSync(sv, { recursive: true });
    fs.writeFileSync(path.join(sv, 'NeverQuestAlone.lua'), 'NQADB = { chats = { { text = "where do I turn in this quest?" } } }\n');
    fs.writeFileSync(path.join(sv, 'NeverQuestAlone.lua.bak'), 'NQADB = {}\n');
    fs.writeFileSync(path.join(sv, 'OtherAddon.lua'), 'OtherAddonDB = {}\n');
  }
  const ours = () => fs.readdirSync(addons).filter(isAddonFolder);
  assert.equal(ours().length, 202, 'the addon, its data folder and 200 slot folders');

  // The app's data folder, as the app leaves it: its settings and the uninstaller's list.
  fs.mkdirSync(P.DATA, { recursive: true });
  saveConfig({ wow: { flavorDir, account: '' } }, path.join(P.DATA, 'config.json'));
  assert.equal(recordAddonFolder({ userData: P.DATA, flavorDir, platform: 'win32' }), true);
  assert.deepEqual(readUninstallRecord(path.join(P.DATA, UNINSTALL_RECORD)), [flavorDir]);

  // A canary key through the app's key store; the login item; the update cache.
  await ks.set('anthropic', CANARY_KEYS.anthropic);
  assert.equal(await ks.get('anthropic'), CANARY_KEYS.anthropic);
  assert.match(cmdkeyList(), /anthropic\.NeverQuestAlone/);
  assert.equal(reg(['add', RUN_KEY, '/v', APP_ID, '/t', 'REG_SZ', '/d', `"${P.EXE}"`, '/f']).status, 0);
  if (updateCache) {
    fs.mkdirSync(path.join(P.CACHE, 'pending'), { recursive: true });
    fs.writeFileSync(path.join(P.CACHE, 'pending', 'update-info.json'), '{}');
  }
  return { base, flavorDir, addons, accounts, ours };
}

/** Runs an installer silently and waits for the installed app and its uninstaller. */
async function install(t, P, installer, what) {
  const t0 = Date.now();
  const inst = spawnSync(installer, ['/S'], { windowsHide: true, timeout: 300_000 });
  assert.equal(inst.status, 0, `installer exit ${inst.status} ${inst.error?.code ?? ''}`);
  await until(() => exists(P.EXE) && exists(P.UNINSTALLER), 60_000, 'the installed app and its uninstaller');
  t.diagnostic(`${what} installed in ${Date.now() - t0} ms: ${P.INSTALL_DIR}`);
}

/** The installed app's --self-test, from its own folder: passes, and returns the version it says it is. */
function installedSelfTest(t, P) {
  const said = [];
  let version = null;
  const spawn = (...a) => { const r = spawnSync(...a); version = resultLine(r.stdout)?.versions?.app ?? null; return r; };
  const rc = selfTest([P.EXE], { stdout: s => said.push(s), stderr: s => said.push(s), spawn });
  for (const line of said) t.diagnostic(line);
  assert.equal(rc, 0, said.join('\n'));
  assert.ok(exists(path.join(P.DATA, UNINSTALL_RECORD)), 'the self-test ran in a sandbox of its own and left the player\'s data folder as it was');
  return version;
}

/** The uninstaller (/S), then nothing of the app is left, in Windows or in the WoW folder. */
async function uninstallLeavesNothing(t, P, w, ks, shortcuts) {
  // NSIS copies the uninstaller to %TEMP% and runs it from there, so the first process ends at
  // once: wait for what it removes last (the app's data folder), after the install folder.
  const t1 = Date.now();
  const un = spawnSync(P.UNINSTALLER, ['/S'], { windowsHide: true, timeout: 300_000 });
  assert.equal(un.status, 0, `uninstaller exit ${un.status} ${un.error?.code ?? ''}`);
  await until(() => !exists(P.INSTALL_DIR) && !exists(P.DATA), 180_000, 'the install folder and the app data to go');
  t.diagnostic(`uninstalled in ${Date.now() - t1} ms`);

  assert.ok(!exists(P.INSTALL_DIR), 'the install folder is gone');
  for (const s of shortcuts) assert.ok(!exists(s), `${s} is gone`);
  assert.ok(!exists(P.DATA), '%APPDATA%\\NeverQuestAlone is gone');
  assert.equal(await ks.get('anthropic'), null, 'the key is gone from Credential Manager');
  assert.doesNotMatch(cmdkeyList(), /anthropic\.NeverQuestAlone/);
  assert.notEqual(reg(['query', RUN_KEY, '/v', APP_ID]).status, 0, 'the login item is gone');
  assert.ok(!exists(P.CACHE), 'the update cache is gone');
  assert.deepEqual(w.ours(), [], 'the addon, its data folder and every slot folder are gone');
  for (const acct of ['FAKEACCOUNT', 'SECOND']) {
    const sv = path.join(w.accounts, acct, 'SavedVariables');
    assert.deepEqual(fs.readdirSync(sv).sort(), ['OtherAddon.lua'], `${acct}: the addon's saved chats are gone, another addon's saved variables stay`);
  }
  assert.ok(exists(path.join(w.addons, 'OtherAddon', 'OtherAddon.toc')), 'another addon stays');
  assert.ok(exists(path.join(w.addons, 'NQA_Extras')), 'a folder whose name only looks like the addon\'s stays');
}

/**
 * After each test, passed or failed: the canary key, the login item and the fake WoW folder go, and
 * so does what the test installed (code-health AP-02: a failure left the app installed, and the next
 * test failed at "nothing installed before"). installed is set just before the test's first
 * install, after its check that nothing was installed before, so only its own install is touched:
 * the installed app stopped if a failure left it running, its uninstaller (/S), then whatever is
 * left of it (the install folder, %APPDATA%\NeverQuestAlone, the update cache, the shortcuts).
 * Nothing here throws: the test's own failure is the one reported.
 */
async function cleanUp(ks, w, P = null, { installed = false } = {}) {
  try { await ks.delete('anthropic'); } catch { /* gone */ }
  reg(['delete', RUN_KEY, '/v', APP_ID, '/f']);
  if (w?.base) { try { fs.rmSync(w.base, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left */ } }
  if (!installed || !P) return;
  const ps = 'Get-Process -Name NeverQuestAlone -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($env:NQA_CLEAN_DIR, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force';
  spawnSync(system32(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe')), ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 60_000, env: { ...process.env, NQA_CLEAN_DIR: P.INSTALL_DIR } });
  if (exists(P.UNINSTALLER)) {
    spawnSync(P.UNINSTALLER, ['/S'], { windowsHide: true, timeout: 300_000 });
    try { await until(() => !exists(P.INSTALL_DIR) && !exists(P.DATA), 180_000, 'the uninstaller (clean-up)'); } catch { /* removed below */ }
  }
  for (const p of [P.INSTALL_DIR, P.DATA, P.CACHE, ...P.SHORTCUTS]) {
    try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5 }); } catch { /* left */ }
  }
}

test('the NSIS installer installs, the installed app passes its self-test, and the uninstaller leaves nothing of the app behind, in Windows or in the WoW folder', { skip, timeout: 600_000 }, async (t) => {
  assert.ok(INSTALLER && exists(INSTALLER), `the installer: ${INSTALLER}`);
  const { createKeyStore, SERVICE } = await import('../../bridge/byok/security/keystore.mjs');
  const P = places();
  assert.ok(!exists(P.INSTALL_DIR), `nothing installed before: ${P.INSTALL_DIR}`);
  assert.ok(!exists(P.DATA), `no app data before: ${P.DATA}`);
  const ks = createKeyStore({ backend: 'os', service: SERVICE });
  let w = null;
  let installed = false;
  try {
    w = await seedWorld(P, ks);

    installed = true;
    await install(t, P, INSTALLER, 'this build');
    // What electron-builder built the installer with, from the installer itself: its uninstall entry is
    // under the identity's NSIS guid and named after its product (release.yml's Windows job checks the
    // config: tools/check-built-identity.mjs; frozen_names_test holds the identity to 1.4.4's names).
    const entry = reg(['query', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${IDENTITY.nsisGuid}`, '/v', 'DisplayName']);
    assert.equal(entry.status, 0, `an uninstall entry under the identity's NSIS guid ${IDENTITY.nsisGuid}`);
    assert.ok(new RegExp(`DisplayName\\s+REG_SZ\\s+${IDENTITY.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `).test(entry.stdout), `named after ${IDENTITY.productName}: ${entry.stdout.trim()}`);
    const shortcuts = P.SHORTCUTS.filter(exists);
    t.diagnostic(`shortcuts: ${shortcuts.join(', ') || 'none'}`);
    assert.ok(shortcuts.length > 0, 'a Start menu or desktop shortcut');

    // The installed app, from its own folder under %LOCALAPPDATA%\Programs.
    installedSelfTest(t, P);

    await uninstallLeavesNothing(t, P, w, ks, shortcuts);
  } finally {
    await cleanUp(ks, w, P, { installed });
  }
});

// The player's things an update must keep, read the same way before and after.
function kept(P, w, transcripts, chat) {
  const read = f => (exists(f) ? fs.readFileSync(f, 'utf8') : null);
  return {
    settings: read(path.join(P.DATA, 'config.json')),
    uninstallList: read(path.join(P.DATA, UNINSTALL_RECORD)),
    appChats: transcripts.rows(chat, 0),
    gameChats: ['FAKEACCOUNT', 'SECOND'].map(acct => read(path.join(w.accounts, acct, 'SavedVariables', 'NeverQuestAlone.lua'))),
    addonFolders: w.ours().sort(),
    loginItem: reg(['query', RUN_KEY, '/v', APP_ID]).status === 0,
  };
}

test('an update in place (SY-25): the previous version installed, then this build through the app\'s own updater (electron-updater\'s NsisUpdater, the version guard, the publisher check, installed when the app quits) keeps the saved key, the chats and the settings; then the uninstaller leaves nothing', { skip: skipUpdate, timeout: 900_000 }, async (t) => {
  assert.ok(INSTALLER && exists(INSTALLER), `this build's installer: ${INSTALLER}`);
  assert.ok(PREVIOUS && exists(PREVIOUS), `the previous version's installer: ${PREVIOUS}`);
  const feedDir = path.dirname(INSTALLER);
  const feed = fs.readFileSync(path.join(feedDir, 'latest.yml'), 'utf8');
  const version = /^version: (\S+)$/m.exec(feed)?.[1];
  const previous = readInstallerVersion(PREVIOUS);
  assert.equal(readInstallerVersion(INSTALLER), version, 'the feed announces this build\'s installer');
  assert.ok(isNewer(version, previous), `${version} is newer than the previous ${previous}`);
  assert.match(feed, new RegExp(`^path: ${path.basename(INSTALLER).replace(/[.+]/g, '\\$&')}$`, 'm'));

  const { createKeyStore, SERVICE } = await import('../../bridge/byok/security/keystore.mjs');
  const desktopRequire = createRequire(path.join(APP, 'package.json'));
  const { NsisUpdater } = desktopRequire('electron-updater/out/NsisUpdater.js');
  const { getAppCacheDir } = desktopRequire('electron-updater/out/AppAdapter.js');
  // The HTTP base class electron-updater itself resolves (its own copy, not the app's).
  const { HttpExecutor, configureRequestUrl, configureRequestOptions } = createRequire(desktopRequire.resolve('electron-updater/out/AppUpdater.js'))('builder-util-runtime');

  const P = places();
  assert.ok(!exists(P.INSTALL_DIR), `nothing installed before: ${P.INSTALL_DIR}`);
  assert.ok(!exists(P.DATA), `no app data before: ${P.DATA}`);
  const ks = createKeyStore({ backend: 'os', service: SERVICE });
  let w = null;
  let server = null;
  let installed = false;
  try {
    // The world, with no update waiting (the real download below makes the cache), and the app's own chats.
    w = await seedWorld(P, ks, { updateCache: false });
    const transcripts = createTranscripts(P.DATA);
    const CHAT = 'c1a2b3c';
    transcripts.append(CHAT, { role: 'user', text: 'where do I turn in this quest?' });
    transcripts.append(CHAT, { role: 'assistant', text: 'Back to Marshal Dughan in Goldshire, by the inn.' });
    const before = kept(P, w, transcripts, CHAT);
    assert.equal(before.appChats.length, 2);
    assert.equal(before.loginItem, true);

    // 1. The previous version, as the player has it.
    installed = true;
    await install(t, P, PREVIOUS, `the previous version (${previous})`);
    const shortcuts = P.SHORTCUTS.filter(exists);
    assert.ok(shortcuts.length > 0, 'a Start menu or desktop shortcut');
    assert.equal(installedSelfTest(t, P), previous, 'the previous version is what\'s installed');

    // 2. This build, the way the app gets it. The feed: this build's latest.yml and installer.
    const served = [];
    server = http.createServer((req, res) => {
      const name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1));
      const file = path.join(feedDir, name);
      served.push(name);
      if (!name || name !== path.basename(name) || !exists(file)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const feedUrl = `http://127.0.0.1:${server.address().port}/`;
    // Electron's app, as electron-updater's ElectronAppAdapter reads it, for the installed previous version.
    const quitHandlers = [];
    const app = {
      version: previous, name: 'NeverQuestAlone', isPackaged: true,
      appUpdateConfigPath: path.join(P.INSTALL_DIR, 'resources', 'app-update.yml'),
      userDataPath: P.DATA, baseCachePath: getAppCacheDir(),
      whenReady: () => Promise.resolve(), relaunch() {}, quit() {}, onQuit: h => quitHandlers.push(h),
    };
    // Electron's network stack: Node's (the feed is plain http on this machine). download() is
    // electron-updater's ElectronHttpExecutor.download; the rest is the shared base class.
    class NodeHttpExecutor extends HttpExecutor {
      createRequest(options, callback) { return http.request(options, callback); }
      download(url, destination, options) {
        return options.cancellationToken.createPromise((resolve, reject, onCancel) => {
          const requestOptions = { headers: options.headers || undefined };
          configureRequestUrl(url, requestOptions);
          configureRequestOptions(requestOptions);
          this.doDownload(requestOptions, { destination, options, onCancel, callback: e => (e == null ? resolve(destination) : reject(e)), responseHandler: null }, 0);
        });
      }
    }
    const logs = [];
    const checkedSignatures = [];
    let updater = null;
    const strict = strictSignatureVerifier({ log: m => logs.push(m) });
    const ctl = await startUpdater({
      app: { getVersion: () => previous, isPackaged: true },
      // The app's identity, its feed's owner changed (setFeedURL below points it at this machine anyway).
      identity: { ...IDENTITY, releases: { owner: 'bones-ci', repo: IDENTITY.releases?.repo ?? IDENTITY.name } },
      prefs: {}, savePrefs: () => {}, platform: 'win32', log: m => logs.push(m), notify: () => {},
      timer: { setTimeout: () => null, setInterval: () => null, clearTimeout() {}, clearInterval() {} },
      // The app's own publisher check, watched: it must run, on the downloaded installer.
      verifySignature: (names, file) => { checkedSignatures.push({ names, file }); return strict(names, file); },
      pinsPublisher: async () => true, // a signed build, as a release is (rename spec H30)
      loadUpdater: async () => {
        updater = new NsisUpdater(null, app);
        updater.httpExecutor = new NodeHttpExecutor();
        const setFeedURL = updater.setFeedURL.bind(updater);
        updater.setFeedURL = () => setFeedURL({ provider: 'generic', url: feedUrl }); // the feed's address: the one change
        return updater;
      },
    });
    const checked = await ctl.check();
    assert.equal(checked.ok, true, logs.join('\n'));
    assert.equal(checked.status.state, 'available', logs.join('\n'));
    assert.equal(checked.status.available.version, version);
    const got = await ctl.download();
    assert.equal(got.ok, true, logs.join('\n'));
    assert.equal(got.status.state, 'ready');
    assert.ok(served.includes('latest.yml') && served.includes(path.basename(INSTALLER)), `the feed and the installer were fetched: ${served.join(', ')}`);
    assert.equal(checkedSignatures.length, 1, 'the publisher check ran on the download');
    assert.ok(checkedSignatures[0].names.length > 0, 'against the publisher the installed app pins');
    if (process.env.NQA_PUBLISHER_NAME) assert.ok(checkedSignatures[0].names.includes(process.env.NQA_PUBLISHER_NAME), `the pin: ${checkedSignatures[0].names}`);
    assert.doesNotMatch(logs.join('\n'), /refused/, logs.join('\n'));
    assert.equal(quitHandlers.length, 1, 'the download is queued to install when the app quits');

    // The player quits the app: electron-updater runs the installer (--updated /S) and the app stays closed.
    assert.ok(updater?.installerPath && exists(updater.installerPath), 'the downloaded installer');
    const image = path.basename(updater.installerPath);
    const t1 = Date.now();
    quitHandlers[0](0);
    await until(() => running(image), 60_000, 'the update\'s installer to start');
    await until(() => !running(image), 480_000, 'the update\'s installer to finish');
    t.diagnostic(`updated in place in ${Date.now() - t1} ms (${image})`);
    assert.ok(!running('NeverQuestAlone.exe'), 'a silent update on quit leaves the app closed');

    // 3. This build is installed, and the player's things are as they were.
    assert.equal(installedSelfTest(t, P), version, 'this build is what\'s installed now');
    assert.equal(await ks.get('anthropic'), CANARY_KEYS.anthropic, 'the saved key is kept');
    assert.match(cmdkeyList(), /anthropic\.NeverQuestAlone/);
    assert.deepEqual(kept(P, w, transcripts, CHAT), before, 'the chats (the app\'s and the game\'s), the settings, the uninstaller\'s list, the addon\'s folders and the login item are kept');
    for (const s of shortcuts) assert.ok(exists(s), `${s} is kept`);

    // 4. The uninstaller: nothing of the app is left.
    await uninstallLeavesNothing(t, P, w, ks, shortcuts);
  } finally {
    server?.close();
    await cleanUp(ks, w, P, { installed });
  }
});
