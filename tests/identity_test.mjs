// The app's identity (open-shell PRD lane 2a): plugins/<plugin>/identity.json, of the plugin the root
// package.json names, read and checked by bridge/identity.mjs (the one reader: app/desktop/src/identity.mjs
// imports it), turned into electron-builder's config by app/desktop/scripts/plugin-config.mjs, which also
// refuses a signed build under names that aren't the app's own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { identityProblems, readIdentity, FIELDS, IDENTITY } from '../bridge/identity.mjs';
import { IDENTITY as APP_IDENTITY } from '../app/desktop/src/identity.mjs';
import { pluginConfig, signedRefusal, signs, RESERVED } from '../app/desktop/scripts/plugin-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const WOW = read('plugins/wow/identity.json');
const EXAMPLE = read('plugins/example/identity.json');

function tree(t, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'))); // as import.meta.url names it (macOS: /private/var)
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [f, v] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), typeof v === 'string' ? v : JSON.stringify(v));
  }
  return dir;
}

test('identity: both plugins\' files are good; the example is neutral, with no feed and no capture helper, and shares no name with NeverQuestAlone', () => {
  assert.deepEqual(identityProblems(WOW), []);
  assert.deepEqual(identityProblems(EXAMPLE), []);
  assert.deepEqual([EXAMPLE.releases, EXAMPLE.captureHelper], [null, null]);
  for (const k of ['appId', 'productName', 'name', 'keychainService', 'nsisGuid', 'copyright']) assert.notEqual(EXAMPLE[k], WOW[k], k);
  assert.doesNotMatch(JSON.stringify(EXAMPLE), /NeverQuestAlone|neverquestalone|nqa/i);
});

test('identity: a field missing, extra or malformed is named', () => {
  const bad = (patch, want) => assert.deepEqual(identityProblems({ ...WOW, ...patch }), want, JSON.stringify(patch));
  bad({ appId: 'not an id' }, ['appId: not valid']);
  bad({ productName: '../Library' }, ['productName: not valid']);
  bad({ name: 'Upper' }, ['name: not valid']);
  bad({ nsisGuid: '41DADE80-3A47-5A7A-986A-4E589F1545A2' }, ['nsisGuid: not valid']);
  bad({ releases: { owner: 'x/../y', repo: 'r' } }, ['releases: not valid']);
  bad({ releases: { owner: 'o', repo: 'r', token: 't' } }, ['releases: not valid']);
  bad({ captureHelper: { bundleId: 'com.x.capture' } }, ['captureHelper: not valid']);
  bad({ copyright: 'two\nlines' }, ['copyright: not valid']);
  bad({ feed: 'https://x' }, ['feed: not an identity field']);
  bad({ windowsPublisherEnv: 'NQA_PUBLISHER_NAME' }, ['windowsPublisherEnv: not an identity field']); // the build's environment names the pin (dist.mjs)
  const { keychainService: _k, ...missing } = WOW;
  assert.deepEqual(identityProblems(missing), ['keychainService: missing']);
  assert.deepEqual(identityProblems(null), ['not an object']);
  assert.equal(Object.keys(FIELDS).length, 8);
});

test('identity: read from the plugin the root\'s package.json names, frozen; refused when it names none, a path, or a file with problems', (t) => {
  const good = tree(t, { 'package.json': { plugin: 'example' }, 'plugins/example/identity.json': EXAMPLE });
  const { plugin, identity } = readIdentity(good);
  assert.equal(plugin, 'example');
  assert.deepEqual(identity, EXAMPLE);
  assert.ok(Object.isFrozen(identity));
  assert.throws(() => readIdentity(tree(t, { 'package.json': {} })), /"plugin" names no plugin folder/);
  assert.throws(() => readIdentity(tree(t, { 'package.json': { plugin: '../wow' } })), /"plugin" names no plugin folder/);
  assert.throws(() => readIdentity(tree(t, { 'package.json': { plugin: 'x' }, 'plugins/x/identity.json': { ...EXAMPLE, appId: 'x' } })), /plugins\/x\/identity\.json: appId: not valid/);
});

test('identity: one reader, the bridge\'s: it takes the identity from app.asar when the app runs from one, else from the checkout; the app\'s modules get that same object', async (t) => {
  assert.equal(APP_IDENTITY, IDENTITY, 'app/desktop/src/identity.mjs hands on the bridge\'s, not a copy');
  const src = fs.readFileSync(path.join(ROOT, 'bridge', 'identity.mjs'), 'utf8');
  const dir = tree(t, {
    // A packaged app: the app's package.json names the plugin (the build writes it), its identity beside the bridge.
    'Resources/app.asar/package.json': { plugin: 'example' }, 'Resources/app.asar/plugins/example/identity.json': EXAMPLE, 'Resources/app.asar/bridge/identity.mjs': src,
    // A plugin folder outside app.asar, which a packaged app never reads.
    'Resources/plugins/example/identity.json': { ...EXAMPLE, appId: 'com.planted.app' },
    // A checkout: the repo's package.json names it.
    'repo/package.json': { plugin: 'wow' }, 'repo/plugins/wow/identity.json': WOW, 'repo/bridge/identity.mjs': src,
  });
  const packaged = await import(pathToFileURL(path.join(dir, 'Resources', 'app.asar', 'bridge', 'identity.mjs')).href);
  assert.equal(packaged.ROOT, path.join(dir, 'Resources', 'app.asar'));
  assert.deepEqual(packaged.IDENTITY, EXAMPLE);
  const checkout = await import(pathToFileURL(path.join(dir, 'repo', 'bridge', 'identity.mjs')).href);
  assert.equal(checkout.ROOT, path.join(dir, 'repo'));
  assert.deepEqual(checkout.IDENTITY, WOW);
  assert.ok(Object.isFrozen(checkout.IDENTITY.releases));
});

test('identity: electron-builder\'s config from it; an identity with no feed or helper has neither', () => {
  const ex = pluginConfig('example', EXAMPLE);
  assert.deepEqual(ex, {
    appId: 'com.example.app', productName: 'Example App', copyright: EXAMPLE.copyright,
    extraMetadata: { name: 'example-app', productName: 'Example App', plugin: 'example' },
    files: [{ from: '../../plugins/example', to: 'plugins/example', filter: ['identity.json'] }],
    nsis: { guid: EXAMPLE.nsisGuid },
    publish: null,
  });
  const wow = pluginConfig('wow', WOW);
  assert.deepEqual(wow.mac, { extraResources: [{ from: '../../bridge/capture/mac/build-public/NeverQuestAlone Capture.app', to: 'NeverQuestAlone Capture.app' }], signIgnore: ['/Contents/Resources/NeverQuestAlone Capture\\.app(/|$)'] });
});

test('identity: a signed build goes out under names of its own: never NeverQuestAlone\'s in an app with another name, the example\'s, nor another plugin\'s; an unsigned one may', (t) => {
  const root = tree(t, { 'plugins/wow/identity.json': WOW, 'plugins/example/identity.json': EXAMPLE, 'plugins/mine/identity.json': { ...EXAMPLE, appId: 'com.mine.app', keychainService: 'Mine' } });
  const signed = { CSC_LINK: 'x' };
  const refusal = (plugin, identity, env = signed) => signedRefusal({ plugin, identity, env, root, platform: 'linux' });
  assert.equal(refusal('wow', WOW), null, 'NeverQuestAlone\'s own build');
  assert.equal(refusal('mine', { ...EXAMPLE, appId: 'com.mine.app', keychainService: 'Mine' }), null, 'a fork under its own names');
  assert.match(refusal('example', EXAMPLE), /the app id com\.example\.app is plugins\/example's/, 'the example, signed as it is');
  assert.match(refusal('mine', { ...EXAMPLE, appId: 'com.mine.app' }), /the key store service "Example App" is plugins\/example's/);
  assert.match(refusal('other', { ...EXAMPLE, appId: 'com.mine.app', keychainService: 'Other' }), /the app id com\.mine\.app is plugins\/mine's/, 'another plugin\'s, beside it');
  assert.match(refusal('other', { ...EXAMPLE, appId: 'com.other.app', keychainService: 'Mine' }), /the key store service "Mine" is plugins\/mine's/);
  assert.equal(refusal('example', EXAMPLE, {}), null, 'unsigned: a developer\'s build of the example');
  // NeverQuestAlone's two reserved names, whatever the plugin is called and with no plugin of this repo
  // beside it (a public fork): refused in an app with another name; NeverQuestAlone's own build passes.
  assert.deepEqual(RESERVED, [['appId', WOW.appId], ['keychainService', WOW.keychainService]]);
  const fork = tree(t, { 'plugins/mine/identity.json': {} });
  const renamed = { ...EXAMPLE, productName: 'Mine', name: 'mine', appId: 'com.mine.app', keychainService: 'Mine' };
  for (const plugin of ['mine', 'wow']) {
    for (const r of [root, fork]) {
      assert.match(signedRefusal({ plugin, identity: { ...renamed, appId: WOW.appId }, env: signed, root: r }), /the app id "com\.neverquestalone\.app" is NeverQuestAlone's/, plugin);
      assert.match(signedRefusal({ plugin, identity: { ...renamed, keychainService: WOW.keychainService }, env: signed, root: r }), /the key store service "NeverQuestAlone" is NeverQuestAlone's/, plugin);
    }
  }
  assert.equal(signedRefusal({ plugin: 'mine', identity: renamed, env: signed, root: fork }), null, 'a fork under names of its own');
  assert.equal(signedRefusal({ plugin: 'mine', identity: { ...renamed, appId: WOW.appId }, env: {}, root: fork, platform: 'linux' }), null, 'unsigned: no refusal');
  for (const platform of ['linux', 'win32', 'darwin']) {
    for (const env of [{ CSC_LINK: 'x' }, { CSC_NAME: 'x' }, { WIN_CSC_LINK: 'x' }, { NQA_AZURE_ENDPOINT: 'x' }]) assert.ok(signs({ ...env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, platform), `${platform} ${JSON.stringify(env)}`);
  }
  for (const platform of ['linux', 'win32']) {
    for (const env of [{}, { CSC_LINK: '' }, { CSC_KEY_PASSWORD: 'x' }, { NQA_PUBLISHER_NAME: 'x' }]) assert.ok(!signs(env, platform), `${platform} ${JSON.stringify(env)}`);
  }
  // On a Mac, electron-builder signs with any Developer ID in the login keychain unless discovery is off
  // (critic round 2, 2A-13): a build like that counts as signed, so the example as it is (npm run pack)
  // is refused there; with discovery off it's unsigned; NeverQuestAlone's own build is never refused.
  assert.ok(signs({}, 'darwin'));
  assert.ok(signs({ CSC_IDENTITY_AUTO_DISCOVERY: 'true' }, 'darwin'));
  assert.ok(!signs({ CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, 'darwin'));
  assert.ok(!signs({ CSC_IDENTITY_AUTO_DISCOVERY: 'false', CSC_LINK: '' }, 'darwin'));
  assert.match(signedRefusal({ plugin: 'example', identity: EXAMPLE, env: {}, root, platform: 'darwin' }), /the app id com\.example\.app is plugins\/example's/);
  assert.equal(signedRefusal({ plugin: 'example', identity: EXAMPLE, env: { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }, root, platform: 'darwin' }), null);
  assert.equal(signedRefusal({ plugin: 'wow', identity: WOW, env: {}, root, platform: 'darwin' }), null, 'NeverQuestAlone\'s own build, keychain or not');
  // This repo's build is NeverQuestAlone's own, signed or not; dist.mjs asks before anything else, with
  // the environment it gives electron-builder (discovery off when no Mac identity is named).
  assert.equal(signedRefusal({ env: signed }), null);
  const dist = fs.readFileSync(path.join(ROOT, 'app', 'desktop', 'scripts', 'dist.mjs'), 'utf8');
  const at = s => { const i = dist.indexOf(s); assert.ok(i >= 0, `dist.mjs has ${s}`); return i; };
  assert.ok(at("if (!set('CSC_LINK') && !set('CSC_NAME')) childEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';") < at('const refused = signedRefusal({ env: childEnv });'), 'judged as electron-builder will run');
  assert.ok(at('const refused = signedRefusal({ env: childEnv });') < at('spawnSync('), 'refused before anything is built');
});
