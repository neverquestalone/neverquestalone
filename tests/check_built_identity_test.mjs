// tools/check-built-identity.mjs (open-shell lane 2a, for 1.4.5): what electron-builder builds the app
// with, against the app's identity. release.yml's Windows job runs it right after its build; test.yml
// doesn't run release.yml, so these are that step's proof until a release rehearsal runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { builtIdentityProblems } from '../tools/check-built-identity.mjs';
import { IDENTITY } from '../bridge/identity.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = path.join(ROOT, 'tools', 'check-built-identity.mjs');
const desktop = createRequire(path.join(ROOT, 'app', 'desktop', 'package.json'));
const installed = m => { try { desktop.resolve(m); return true; } catch { return false; } };
const NO_YAML = installed('js-yaml') ? false : "electron-builder's YAML parser isn't installed (app/desktop's npm ci)";
const NO_BUILDER = installed('app-builder-lib/out/util/config/config.js') ? false : "electron-builder isn't installed (app/desktop's npm ci)";
const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });

const config = ({ appId = IDENTITY.appId, productName = IDENTITY.productName, guid = IDENTITY.nsisGuid } = {}) => ({
  appId, productName, directories: { output: 'dist' }, nsis: { oneClick: true, perMachine: false, ...(guid === null ? {} : { guid }) }, // guid null: none
});

test('check-built-identity: the app id, product name and NSIS guid electron-builder built with are the identity\'s; each one missing or different is a line naming it', () => {
  assert.deepEqual(builtIdentityProblems(config(), IDENTITY), []);
  assert.deepEqual(builtIdentityProblems(config({ guid: '00000000-0000-5000-8000-000000000000' }), IDENTITY), [`nsis.guid is "00000000-0000-5000-8000-000000000000", not the identity's "${IDENTITY.nsisGuid}"`]);
  assert.match(builtIdentityProblems(config({ appId: 'com.other.app' }), IDENTITY).join('\n'), /^appId is "com\.other\.app"/);
  assert.match(builtIdentityProblems(config({ productName: 'Other' }), IDENTITY).join('\n'), /^productName is "Other"/);
  assert.deepEqual(builtIdentityProblems(config({ guid: null }), IDENTITY), ['nsis.guid is missing']);
  assert.deepEqual(builtIdentityProblems({}, IDENTITY), ['appId is missing', 'productName is missing', 'nsis.guid is missing']);
  assert.deepEqual(builtIdentityProblems(null, IDENTITY).length, 3);
});

test('check-built-identity: an effective config electron-builder wrote (builder-effective-config.yaml), read with its own parser: a match passes; a wrong guid, app id or product name, or no guid, fails naming it', { skip: NO_YAML }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'built-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // As electron-builder writes it: YAML of the config, keys in its order.
  let n = 0;
  const yaml = (fields) => {
    const c = config(fields);
    const file = path.join(dir, `${n++}.yaml`);
    fs.writeFileSync(file, [
      'directories:', `  output: ${c.directories.output}`, `appId: ${JSON.stringify(c.appId)}`, `productName: ${JSON.stringify(c.productName)}`,
      'nsis:', `  oneClick: ${c.nsis.oneClick}`, `  perMachine: ${c.nsis.perMachine}`, ...(c.nsis.guid ? [`  guid: ${c.nsis.guid}`] : []), '',
    ].join('\n'));
    return file;
  };
  const ok = run(yaml({}));
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /the app id, product name and NSIS guid are the identity's/);
  for (const [fields, named] of [
    [{ guid: '00000000-0000-5000-8000-000000000000' }, /nsis\.guid is "00000000-0000-5000-8000-000000000000"/],
    [{ appId: 'com.other.app' }, /appId is "com\.other\.app"/],
    [{ productName: 'Other' }, /productName is "Other"/],
    [{ guid: null }, /nsis\.guid is missing/],
  ]) {
    const r = run(yaml(fields));
    assert.equal(r.status, 1, JSON.stringify(fields));
    assert.match(r.stdout, named);
    assert.equal(r.stdout.trim().split('\n').length, 1, 'one line, naming the field');
  }
  assert.equal(run().status, 2, 'usage');
  assert.equal(run(path.join(dir, 'none.yaml')).status, 2, 'no such file');
});

test('check-built-identity: release.yml\'s step, on this checkout: electron-builder\'s own loader reads the app\'s config, and the three names are the identity\'s', { skip: NO_BUILDER }, () => {
  const r = run('app/desktop');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /electron-builder's config(?: and \S+)?: the app id, product name and NSIS guid are the identity's/);
});

// release.yml is this repo's: the source export holds the tool and this file, not the workflow (tools/shell-tree.mjs GOES_ANYWAY).
const RELEASE_YML = path.join(ROOT, '.github', 'workflows', 'release.yml');
test('check-built-identity: release.yml\'s Windows job runs it right after its build, one plain line, no value of the identity\'s in the workflow', { skip: !fs.existsSync(RELEASE_YML) && 'no release.yml here (the source export)' }, () => {
  const release = fs.readFileSync(RELEASE_YML, 'utf8');
  const job = release.slice(release.indexOf('\n  desktop-windows:\n'));
  const steps = job.split('\n      - ').slice(1);
  const build = steps.findIndex(s => /^name: Build and sign \(scripts\/dist\.mjs/.test(s));
  assert.ok(build >= 0, 'the Windows job\'s build step');
  assert.match(steps[build], /\n {8}run: node scripts\/dist\.mjs --win nsis --x64 --publish never$/);
  const check = steps[build + 1];
  assert.match(check, /^name: [^\n]+\n {8}run: node tools\/check-built-identity\.mjs app\/desktop$/, 'the next step, its run one line');
  assert.doesNotMatch(check.split('\n').find(l => l.includes('run:')), /["']/, 'no quotes in its run line');
  for (const v of [IDENTITY.nsisGuid, IDENTITY.appId, IDENTITY.productName]) assert.ok(!check.includes(v), `no ${v} in the step`);
  assert.ok(!release.includes(IDENTITY.nsisGuid), 'the guid nowhere in release.yml');
});
