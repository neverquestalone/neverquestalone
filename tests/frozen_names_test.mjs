// Names frozen at the first public build (rename spec §1.13): changing one orphans installs,
// saved keys, Screen Recording grants, bindings or SavedVariables. Change one only with a
// migration and a systems-critic OK. The app's own are one file (open-shell lane 2a): the wow
// plugin's identity.json, which the build and every reader take them from.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const IDENTITY_FILE = 'plugins/wow/identity.json';

test('NeverQuestAlone\'s identity holds the names frozen at the first public build, and this repo builds it', () => {
  assert.deepEqual(JSON.parse(read(IDENTITY_FILE)), {
    appId: 'com.neverquestalone.app',
    productName: 'NeverQuestAlone',
    name: 'neverquestalone',
    keychainService: 'NeverQuestAlone',
    captureHelper: { bundleId: 'com.neverquestalone.capture', app: 'NeverQuestAlone Capture' },
    nsisGuid: '41dade80-3a47-5a7a-986a-4e589f1545a2',
    releases: { owner: 'tommygeoco', repo: 'neverquestalone' },
    copyright: 'Copyright © 2026 chelinho139 and The NeverQuestAlone authors (MIT)',
  });
  assert.equal(JSON.parse(read('package.json')).plugin, 'wow');
});

test('every reader takes them from the identity, and none says them itself', async () => {
  const id = JSON.parse(read(IDENTITY_FILE));
  const { IDENTITY } = await import('../bridge/identity.mjs');
  const { IDENTITY: APP_IDENTITY } = await import('../app/desktop/src/identity.mjs');
  assert.deepEqual(IDENTITY, id, 'the reader');
  assert.equal(APP_IDENTITY, IDENTITY, 'one reader: the app\'s modules get the bridge\'s');
  const { pluginConfig } = await import('../app/desktop/scripts/plugin-config.mjs');
  const built = pluginConfig();
  assert.deepEqual([built.appId, built.productName, built.copyright, built.nsis.guid, built.publish[0].owner, built.publish[0].repo, built.extraMetadata.name, built.extraMetadata.productName],
    [id.appId, id.productName, id.copyright, id.nsisGuid, id.releases.owner, id.releases.repo, id.name, id.productName], 'the build (electron-builder.yml extends scripts/plugin-config.mjs)');
  const [login, uninstall, loader, paths, keystore, updater] = await Promise.all(['../app/desktop/src/login-item.mjs', '../app/desktop/src/uninstall.mjs', '../app/desktop/src/api-loader.mjs',
    '../bridge/byok/paths.mjs', '../bridge/byok/security/keystore.mjs', '../app/desktop/updater.mjs'].map(f => import(f)));
  assert.deepEqual([login.APP_ID, uninstall.APP_ID, uninstall.PRODUCT_DIR, uninstall.UPDATER_CACHE_DIR, uninstall.DEFAULT_CAPTURE_BUNDLE_ID, paths.PRODUCT_DIR, paths.LINUX_DIR, keystore.SERVICE, loader.KEY_SERVICE, loader.CAPTURE_APP_NAME],
    [id.appId, id.appId, id.productName, `${id.name}-updater`, id.captureHelper.bundleId, id.productName, id.name, id.keychainService, id.keychainService, `${id.captureHelper.app}.app`]);
  assert.deepEqual(updater.feedConfig(APP_IDENTITY), { provider: 'github', owner: 'tommygeoco', repo: 'neverquestalone', private: false, releaseType: 'release' });
  assert.match(read('app/desktop/main.mjs'), /\nconst APP_ID = IDENTITY\.appId;\n/);
  // None says what it takes (the product name in the app's own sentences is lane 3a's {app}).
  const everywhere = [id.appId, id.nsisGuid, id.captureHelper.bundleId, `${id.name}-updater`];
  const says = {
    'app/desktop/main.mjs': [],
    'app/desktop/src/login-item.mjs': [],
    'app/desktop/src/uninstall.mjs': [`'${id.productName}'`],
    'app/desktop/src/api-loader.mjs': [`'${id.keychainService}'`, id.captureHelper.app],
    'app/desktop/updater.mjs': [`owner: '${id.releases.owner}'`],
    'app/desktop/electron-builder.yml': [id.captureHelper.app, `owner: ${id.releases.owner}`, `productName: ${id.productName}`],
    'bridge/byok/paths.mjs': [`'${id.productName}'`, `'${id.name}'`],
    'bridge/byok/security/keystore.mjs': [`'${id.keychainService}'`],
    'bridge/config.mjs': [id.captureHelper.app],
  };
  for (const [f, values] of Object.entries(says)) {
    const code = read(f).replace(/^\s*(?:\/\/|#|\*).*$/gm, '');
    for (const v of [...everywhere, ...values]) assert.ok(!code.includes(v), `${f} says ${v} itself`);
  }
});

// What still keeps a copy, because something outside the app reads it, and the plugin's own names.
const FROZEN = [
  // The packaged helper's id for the capture module's code requirement and test.yml's capture-mac job
  // (equal to the identity's: the next test), and a development run's names (Electron's for an unpackaged
  // app; tests/byok/app_os_test.mjs holds them equal to the identity's, in the export too).
  ['app/desktop/build/bridge/capture/mac/BUNDLE_ID', /^com\.neverquestalone\.capture\s*$/],
  // The identifier the helper asks of whoever serves its socket, compiled into it (equal to the
  // identity's app id: the next test; tests/capture_mac_test.js holds it so for any app that ships it).
  ['bridge/capture/mac/Sources/NQACapture/PeerCheck.swift', /^let nqaAppIdentifier = "com\.neverquestalone\.app"$/m],
  ['app/desktop/package.json', /^  "name": "neverquestalone",$/m],
  ['app/desktop/package.json', /^  "productName": "NeverQuestAlone",$/m],
  // Where the releases go (release.yml, which the source export doesn't hold: tools/shell-tree.mjs GOES_ANYWAY).
  ...(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'release.yml')) ? [['.github/workflows/release.yml', /^\s+RELEASES_REPO: tommygeoco\/neverquestalone$/m]] : []),
  // Where /bones app sends a player for the download: the releases page, the one place with the Mac and
  // Windows downloads once a release publishes (UX-W01, before the first public build, so no install
  // carried the domain it replaces).
  ['addon/NeverQuestAlone/Paste.lua', /^P\.APP_PAGE = "https:\/\/github\.com\/tommygeoco\/neverquestalone\/releases"$/m],
  ['bridge/byok/wow.mjs', /ADDON_NAME = 'NeverQuestAlone'/],
  ['bridge/byok/wow.mjs', /DATA_NAME = 'NQA_Data'/],
  ['bridge/transport/slots.mjs', /SLOT_PREFIX = 'NQA_S'/],
  ['bridge/transport/slots.mjs', /SLOT_CATEGORY = 'NeverQuestAlone Parts'/],
  ['addon/NeverQuestAlone/NeverQuestAlone.toc', /^## SavedVariables: NQADB, NQAMapDB$/m],
  ...['OPEN_AND_TYPE', 'ASK_NEXT', 'ASK_TARGET', 'ASK_ITEM', 'OKAY'].map(b => ['addon/NeverQuestAlone/Bindings.xml', new RegExp(`name="NQA_${b}"`)]),
];

test('the names frozen at the first public build are unchanged', () => {
  for (const [f, re] of FROZEN) assert.match(read(f), re, `${f} must keep ${re}`);
  const id = JSON.parse(read(IDENTITY_FILE));
  assert.equal(read('app/desktop/build/bridge/capture/mac/BUNDLE_ID').trim(), id.captureHelper.bundleId, 'the packaged helper\'s id is the identity\'s');
  assert.ok(read('bridge/capture/mac/Sources/NQACapture/PeerCheck.swift').includes(`let nqaAppIdentifier = "${id.appId}"`), 'the helper asks for the identity\'s app id');
});
