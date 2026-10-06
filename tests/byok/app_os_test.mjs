// The desktop app's OS integration (BYOK PRD §11.1 "Background", PF-2, §16.1
// step 9, §16.3 "Uninstall", OB-3, B3.5): the login item on each OS (none on
// Linux, which runs from source only: systems plan D6),
// what uninstall deletes (every path checked by name), and the Screen
// Recording entries it resets on macOS (the app's and the capture helper's).
// Plain node --test; no Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as loginItemModule from '../../app/desktop/src/login-item.mjs';
import { createLoginItem, APP_ID as LOGIN_APP_ID } from '../../app/desktop/src/login-item.mjs';
import {
  uninstallTargets, removeTargets, cacheBase, readCaptureBundleId, tccBundleIds,
  APP_ID, PRODUCT_DIR, UPDATER_CACHE_DIR, DEFAULT_CAPTURE_BUNDLE_ID,
} from '../../app/desktop/src/uninstall.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bones-os-'));

function fakeApp() {
  const calls = [];
  let open = false;
  return {
    calls,
    getLoginItemSettings: opts => { calls.push(['get', opts]); return { openAtLogin: open }; },
    setLoginItemSettings: s => { calls.push(['set', s]); open = s.openAtLogin; },
  };
}

// ---------------------------------------------------------------------------
// Login item.

test('a development run is named as the build: app/desktop/package.json\'s name and productName are the app\'s identity\'s (Electron names its data and logs folders after them)', () => {
  const app = JSON.parse(fs.readFileSync(new URL('../../app/desktop/package.json', import.meta.url), 'utf8'));
  assert.deepEqual([app.name, app.productName], [IDENTITY.name, IDENTITY.productName]);
});

test('login item: macOS and Windows through Electron; Windows starts hidden under the app id’s Run value', () => {
  const mac = fakeApp();
  const m = createLoginItem({ app: mac, packaged: true, platform: 'darwin' });
  assert.deepEqual(m.get(), { supported: true, openAtLogin: false });
  assert.equal(m.set(true).openAtLogin, true);
  assert.deepEqual(mac.calls.find(c => c[0] === 'set')[1], { openAtLogin: true });

  const win = fakeApp();
  const w = createLoginItem({ app: win, packaged: true, platform: 'win32' });
  w.set(true);
  assert.deepEqual(win.calls.find(c => c[0] === 'set')[1], { openAtLogin: true, args: ['--hidden'], name: IDENTITY.appId });
  assert.deepEqual(win.calls.find(c => c[0] === 'get')[1], { args: ['--hidden'] });
  assert.equal(LOGIN_APP_ID, APP_ID);

  const dev = createLoginItem({ app: fakeApp(), packaged: false, platform: 'darwin' });
  assert.deepEqual(dev.get(), { supported: false, openAtLogin: false, reason: 'dev_build' });
  assert.equal(dev.set(true).error, 'dev_build');
  assert.equal(createLoginItem({ app: fakeApp(), packaged: true, platform: 'freebsd' }).get().supported, false);
});

test('login item on Linux: not offered (from source only, systems plan D6); nothing is written, Electron is never asked', () => {
  const app = fakeApp();
  const li = createLoginItem({ app, packaged: true, platform: 'linux' });
  assert.deepEqual(li.get(), { supported: false, openAtLogin: false, reason: 'unsupported_os' });
  assert.deepEqual(li.set(true), { ok: false, error: 'unsupported' });
  assert.equal(app.calls.length, 0);
  for (const gone of ['autostartPath', 'desktopEntry', 'linuxExecPath', 'AUTOSTART_FILE']) assert.equal(loginItemModule[gone], undefined, `${gone} is gone`);
});

// ---------------------------------------------------------------------------
// Uninstall.

test('uninstall targets on macOS: data, the separate logs folder, both update caches and the bundle-id leftovers', () => {
  const home = '/Users/p';
  const { productName, name, appId } = IDENTITY; // the folders and files are named after the app's identity
  const t = uninstallTargets({
    platform: 'darwin', env: {}, home,
    userData: `${home}/Library/Application Support/${productName}`,
    logs: `${home}/Library/Logs/${productName}`,
  });
  // The folders it names itself are joined with the running OS's path rules (as on Windows below).
  const lib = (...p) => path.join(home, 'Library', ...p);
  assert.deepEqual(t.map(x => x.path), [
    `${home}/Library/Application Support/${productName}`,
    `${home}/Library/Logs/${productName}`,
    lib('Caches', `${name}-updater`),
    lib('Caches', `${appId}.ShipIt`),
    lib('Caches', appId),
    lib('HTTPStorages', appId),
    lib('Saved Application State', `${appId}.savedState`),
    lib('Preferences', `${appId}.plist`),
  ]);
  assert.equal(t.at(-1).kind, 'file');
});

test('uninstall targets on Windows and Linux: logs inside the data folder go with it; the updater cache by its own name', () => {
  const win = uninstallTargets({
    // Host-style paths: the module uses the running OS's path rules, which are Windows' on Windows.
    platform: 'win32', env: { LOCALAPPDATA: '/w/Local' }, home: '/w',
    userData: path.join('/w', 'Roaming', PRODUCT_DIR), logs: path.join('/w', 'Roaming', PRODUCT_DIR, 'logs'),
  });
  assert.deepEqual(win.map(x => x.path), [path.join('/w', 'Roaming', PRODUCT_DIR), path.join('/w/Local', UPDATER_CACHE_DIR)]);
  assert.equal(cacheBase({ platform: 'win32', env: {}, home: '/h' }), path.join('/h', 'AppData', 'Local'));
  const linData = `/h/.config/${IDENTITY.productName}`;
  const lin = uninstallTargets({ platform: 'linux', env: { XDG_CACHE_HOME: '/x/cache' }, home: '/h', userData: linData, logs: `${linData}/logs` });
  assert.deepEqual(lin.map(x => x.path), [linData, path.join('/x/cache', UPDATER_CACHE_DIR)]);
});

test('uninstall never deletes a folder that isn’t the one it expects', () => {
  for (const userData of ['/', '/Users/p', '/Users/p/Library/Application Support', `relative/${IDENTITY.productName}`, '', null]) {
    const t = uninstallTargets({ platform: 'darwin', env: {}, home: '/Users/p', userData, logs: null });
    assert.ok(t.every(x => [PRODUCT_DIR, UPDATER_CACHE_DIR].includes(path.basename(x.path)) || path.basename(x.path).startsWith(APP_ID)), JSON.stringify(userData));
    assert.ok(!t.some(x => x.path === userData), `never ${JSON.stringify(userData)}`);
  }
  const dir = tmp();
  try {
    const data = path.join(dir, PRODUCT_DIR);
    fs.mkdirSync(path.join(data, 'bridge'), { recursive: true });
    fs.writeFileSync(path.join(data, 'app-state.json'), '{}');
    const keep = path.join(dir, 'keep.txt');
    fs.writeFileSync(keep, 'x');
    const removed = removeTargets([{ path: data, kind: 'dir' }, { path: path.join(dir, 'missing'), kind: 'dir' }]);
    assert.deepEqual(removed, [data]);
    assert.equal(fs.existsSync(data), false);
    assert.equal(fs.existsSync(keep), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Screen Recording: uninstall resets the app and the capture helper, which holds the permission under its own id', () => {
  // The app's own helper id (none for an app without a helper); only ids this app ships: never a checkout's own helper (bridge/capture/mac/BUNDLE_ID), whose grant uninstall leaves alone (final review L3-4).
  assert.equal(DEFAULT_CAPTURE_BUNDLE_ID, IDENTITY.captureHelper?.bundleId ?? null);
  assert.deepEqual(tccBundleIds(), [APP_ID, ...(DEFAULT_CAPTURE_BUNDLE_ID ? [DEFAULT_CAPTURE_BUNDLE_ID] : [])]);
  const checkoutId = fs.readFileSync(new URL('../../bridge/capture/mac/BUNDLE_ID', import.meta.url), 'utf8').trim();
  assert.deepEqual(tccBundleIds({ fromFile: checkoutId, fromBridge: [checkoutId, 'org.example.capture'] }), [APP_ID]);
  const ours = APP_ID.slice(0, APP_ID.lastIndexOf('.') + 1); // the app id's own prefix
  assert.deepEqual(tccBundleIds({ fromFile: `${ours}capture2`, fromBridge: [`${ours}other`, 'bad id; rm -rf', APP_ID, 5, 'org.example.other'] }), [APP_ID, `${ours}capture2`, `${ours}other`]);
  const dir = tmp();
  try {
    assert.equal(readCaptureBundleId([dir]), null);
    const f = path.join(dir, 'bridge', 'capture', 'mac', 'BUNDLE_ID');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'org.example.capture\n');
    assert.equal(readCaptureBundleId(['/nonexistent', dir]), 'org.example.capture');
    fs.writeFileSync(f, 'not a bundle id');
    assert.equal(readCaptureBundleId([dir]), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // The default is the id the packaged app carries (build-app.sh --public builds its helper with it), in an app with a helper.
  if (DEFAULT_CAPTURE_BUNDLE_ID) assert.equal(fs.readFileSync(new URL('../../app/desktop/build/bridge/capture/mac/BUNDLE_ID', import.meta.url), 'utf8').trim(), DEFAULT_CAPTURE_BUNDLE_ID);
  const plist = fs.readFileSync(new URL('../../bridge/capture/mac/Info.plist', import.meta.url), 'utf8');
  assert.match(plist, /<string>__BUNDLE_ID__<\/string>/);
});
