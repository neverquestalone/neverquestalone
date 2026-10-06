// tools/sbom.mjs (open-shell PRD lane 7): the CycloneDX SBOM release.yml attaches to every release, read from
// app/desktop's lockfile alone. A planted lockfile proves the walk (Node's resolution, platforms, optional and
// development packages, local sources refused); the real one proves the release's file: every production
// package npm would install for the shipped platforms, and Electron, with hashes, licences and purls, the same
// bytes for the same commit, and no local path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { purlOf, hashesOf, licensesOf, onTargets, shippedPackages, buildSbom, sbomTime, DEFAULT_TARGETS } from '../tools/sbom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'app', 'desktop');
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const cli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'sbom.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });
const SHA512 = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
const reg = (name, version) => `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;

test('sbom: purls, hashes as hex, licences as SPDX expressions or names, and the platform filter', () => {
  assert.equal(purlOf('@napi-rs/keyring', '2.1.0'), 'pkg:npm/%40napi-rs/keyring@2.1.0');
  assert.equal(purlOf('ms', '2.1.3'), 'pkg:npm/ms@2.1.3');
  assert.equal(purlOf('x', '1.0.0+build.1'), 'pkg:npm/x@1.0.0%2Bbuild.1');
  assert.deepEqual(hashesOf(`${SHA512} sha1-${Buffer.alloc(20, 1).toString('base64')}`), [
    { alg: 'SHA-512', content: '07'.repeat(64) }, { alg: 'SHA-1', content: '01'.repeat(20) }]);
  assert.deepEqual(hashesOf(undefined), []);
  assert.deepEqual(licensesOf('MIT'), [{ expression: 'MIT' }]);
  assert.deepEqual(licensesOf('(MIT OR Apache-2.0)'), [{ expression: '(MIT OR Apache-2.0)' }]);
  assert.deepEqual(licensesOf('Apache-2.0 WITH LLVM-exception'), [{ expression: 'Apache-2.0 WITH LLVM-exception' }]);
  assert.deepEqual(licensesOf({ type: 'BSD-2-Clause' }), [{ expression: 'BSD-2-Clause' }]);
  assert.deepEqual(licensesOf('SEE LICENSE IN LICENSE.md'), [{ license: { name: 'SEE LICENSE IN LICENSE.md' } }]);
  assert.equal(licensesOf(undefined), undefined);
  const t = ['darwin-arm64', 'darwin-x64', 'win32-x64'];
  assert.ok(onTargets({}, t), 'no platform fields: everywhere');
  assert.ok(onTargets({ os: ['darwin'], cpu: ['x64'] }, t));
  assert.ok(onTargets({ os: ['win32'], cpu: ['x64'] }, t));
  assert.ok(!onTargets({ os: ['win32'], cpu: ['arm64'] }, t));
  assert.ok(!onTargets({ os: ['linux'], cpu: ['x64'], libc: ['glibc'] }, t));
  assert.ok(!onTargets({ os: ['win32'], cpu: ['x64'] }, ['darwin-arm64', 'darwin-x64']), 'a Mac-only release has no Windows binding');
  assert.ok(onTargets({ os: ['!win32'] }, ['darwin-arm64']) && !onTargets({ os: ['!win32'] }, ['win32-x64']), 'a negated os');
});

test('sbom: the walk resolves like Node (nested first), keeps required peers, skips other platforms and development-only optionals, and refuses a missing, development or local package', () => {
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'app', version: '1.0.0', dependencies: { a: '1', b: '1' }, devDependencies: { tool: '1' } },
      'node_modules/a': { version: '1.0.0', resolved: reg('a', '1.0.0'), integrity: SHA512, license: 'MIT', dependencies: { c: '^2' }, optionalDependencies: { 'a-win32-x64': '1', 'a-linux-x64': '1', 'a-gone': '1' } },
      'node_modules/a-win32-x64': { version: '1.0.0', resolved: reg('a-win32-x64', '1.0.0'), integrity: SHA512, os: ['win32'], cpu: ['x64'], optional: true },
      'node_modules/a-linux-x64': { version: '1.0.0', resolved: reg('a-linux-x64', '1.0.0'), integrity: SHA512, os: ['linux'], cpu: ['x64'], optional: true },
      'node_modules/a/node_modules/c': { version: '2.0.0', resolved: reg('c', '2.0.0'), integrity: SHA512, license: 'ISC' },
      'node_modules/b': { version: '1.0.0', resolved: reg('b', '1.0.0'), integrity: SHA512, dependencies: { c: '^1' }, peerDependencies: { p: '1', q: '1' }, peerDependenciesMeta: { q: { optional: true } } },
      'node_modules/c': { version: '1.0.0', resolved: reg('c', '1.0.0'), integrity: SHA512 },
      'node_modules/p': { version: '1.0.0', resolved: reg('p', '1.0.0'), integrity: SHA512, peer: true },
      'node_modules/q': { version: '1.0.0', resolved: reg('q', '1.0.0'), integrity: SHA512, dev: true, peer: true },
      'node_modules/tool': { version: '1.0.0', resolved: reg('tool', '1.0.0'), integrity: SHA512, dev: true },
    },
  };
  const { packages, direct } = shippedPackages(lock, DEFAULT_TARGETS);
  assert.deepEqual(packages.map(p => `${p.key} ${p.name}@${p.version}`), [
    'node_modules/a a@1.0.0', 'node_modules/a-win32-x64 a-win32-x64@1.0.0', 'node_modules/b b@1.0.0',
    'node_modules/c c@1.0.0', 'node_modules/a/node_modules/c c@2.0.0', 'node_modules/p p@1.0.0']);
  assert.deepEqual(direct, ['node_modules/a', 'node_modules/b']);
  assert.deepEqual(packages.find(p => p.key === 'node_modules/a').deps, ['node_modules/a/node_modules/c', 'node_modules/a-win32-x64']);
  assert.deepEqual(shippedPackages(lock, ['darwin-arm64']).packages.map(p => p.name).filter(n => n.startsWith('a-')), [], 'no Windows binding in a Mac-only list');
  const bom = buildSbom({ pkg: { name: 'app', productName: 'App', version: '1.0.0', license: 'MIT' }, lock, time: new Date(0) });
  assert.deepEqual(bom.components.map(c => c.purl), ['pkg:npm/a@1.0.0', 'pkg:npm/a-win32-x64@1.0.0', 'pkg:npm/b@1.0.0', 'pkg:npm/c@1.0.0', 'pkg:npm/c@2.0.0', 'pkg:npm/p@1.0.0']);
  assert.deepEqual(bom.dependencies.find(d => d.ref === 'app@1.0.0').dependsOn, ['pkg:npm/a@1.0.0', 'pkg:npm/b@1.0.0'], 'no Electron in this lockfile, so none listed');
  assert.deepEqual(bom.dependencies.find(d => d.ref === 'pkg:npm/b@1.0.0').dependsOn, ['pkg:npm/c@1.0.0', 'pkg:npm/p@1.0.0']);
  // What it refuses: a package the app needs and the lockfile lacks, one it marks as development-only, a local source.
  const without = structuredClone(lock); delete without.packages['node_modules/c'];
  assert.throws(() => shippedPackages(without), /node_modules\/b needs c, which the lockfile doesn't have/);
  const dev = structuredClone(lock); dev.packages['node_modules/p'].dev = true;
  assert.throws(() => shippedPackages(dev), /needs p, which the lockfile marks as a development package/);
  for (const resolved of ['file:../local-a', 'http://registry.npmjs.org/a/-/a-1.0.0.tgz', undefined]) {
    const local = structuredClone(lock); local.packages['node_modules/a'].resolved = resolved;
    assert.throws(() => shippedPackages(local), /node_modules\/a isn't from a registry over https/);
  }
  assert.throws(() => shippedPackages({ lockfileVersion: 1, dependencies: {} }), /lockfileVersion 2 or 3/);
});

test('sbom: the real app: CycloneDX 1.5 with every production package npm installs for the shipped platforms, Electron from its release, the same bytes for the same SOURCE_DATE_EPOCH, and no local path', (t) => {
  const pkg = readJson(path.join(APP, 'package.json'));
  const lock = readJson(path.join(APP, 'package-lock.json'));
  const bom = buildSbom({ pkg, lock, time: new Date(1_700_000_000_000) });
  assert.equal(bom.bomFormat, 'CycloneDX');
  assert.equal(bom.specVersion, '1.5');
  assert.equal(bom.version, 1);
  assert.match(bom.serialNumber, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a version 5 UUID: the schema\'s pattern');
  assert.equal(bom.metadata.timestamp, '2023-11-14T22:13:20Z');
  assert.deepEqual(bom.metadata.component, { type: 'application', 'bom-ref': `${pkg.name}@${pkg.version}`, name: pkg.productName, version: pkg.version, licenses: [{ expression: pkg.license }] });
  // npm's own view: every entry it would install with --omit=dev (no dev flag) whose os and cpu fit a shipped platform.
  const npmProd = Object.entries(lock.packages).filter(([k, e]) => k && !e.dev && onTargets(e, DEFAULT_TARGETS))
    .map(([k, e]) => `pkg:npm/${(e.name || k.slice(k.lastIndexOf('node_modules/') + 13)).replace(/^@/, '%40')}@${e.version}`);
  const libraries = bom.components.filter(c => c.type === 'library');
  assert.deepEqual(libraries.map(c => c.purl).sort(), [...new Set(npmProd)].sort());
  for (const dep of Object.keys(pkg.dependencies)) assert.ok(libraries.some(c => `${c.group ? `${c.group}/` : ''}${c.name}` === dep), dep);
  for (const arch of ['darwin-arm64', 'darwin-x64', 'win32-x64-msvc']) assert.ok(libraries.some(c => c.name === `keyring-${arch}`), `the ${arch} keychain binding ships`);
  assert.ok(!libraries.some(c => /keyring-(linux|freebsd|android)|win32-(arm64|ia32)/.test(c.name)), 'no binding for a platform no download has');
  for (const c of libraries) {
    assert.match(c.purl, /^pkg:npm\/(%40[\w.-]+\/)?[\w.-]+@[\w.%+-]+$/);
    assert.equal(c['bom-ref'], c.purl);
    assert.ok(c.hashes?.length && c.hashes.every(h => h.alg === 'SHA-512' && /^[0-9a-f]{128}$/.test(h.content)), `${c.purl}: its SHA-512, in hex`);
    assert.ok(c.licenses?.length, `${c.purl}: a licence`);
    assert.match(c.externalReferences[0].url, /^https:\/\/registry\.npmjs\.org\//);
  }
  const electron = bom.components.find(c => c.name === 'electron');
  assert.equal(electron.type, 'framework');
  assert.equal(electron.version, lock.packages['node_modules/electron'].version);
  assert.equal(electron.hashes, undefined, 'npm\'s tarball isn\'t what ships');
  assert.equal(electron.externalReferences[0].url, `https://github.com/electron/electron/releases/tag/v${electron.version}`);
  // The graph: the app depends on its dependencies and Electron, and every ref is a component (or the app).
  const refs = new Set([bom.metadata.component['bom-ref'], ...bom.components.map(c => c['bom-ref'])]);
  for (const d of bom.dependencies) { assert.ok(refs.has(d.ref), d.ref); for (const r of d.dependsOn) assert.ok(refs.has(r), r); }
  assert.ok(bom.dependencies[0].dependsOn.includes(electron.purl));
  // The CLI: deterministic for one SOURCE_DATE_EPOCH, a Mac-only list without the Windows binding, no local path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const a = cli(['--out', path.join(dir, 'a.json')], { SOURCE_DATE_EPOCH: '1700000000' });
  const b = cli(['--out', path.join(dir, 'b.json')], { SOURCE_DATE_EPOCH: '1700000000' });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, new RegExp(`^sbom: ${bom.components.length} components for ${pkg.productName} ${pkg.version} \\(darwin-arm64, darwin-x64, win32-x64\\) in a\\.json\\n$`));
  const text = fs.readFileSync(path.join(dir, 'a.json'), 'utf8');
  assert.equal(text, fs.readFileSync(path.join(dir, 'b.json'), 'utf8'), 'the same bytes');
  assert.equal(text, `${JSON.stringify(bom, null, 2)}\n`, 'the CLI writes what buildSbom builds');
  assert.doesNotMatch(text, /file:|\/Users\/|\/home\/|[A-Z]:\\\\|\bnode_modules\//, 'no local path');
  const mac = cli(['--targets', 'darwin-arm64,darwin-x64'], { SOURCE_DATE_EPOCH: '1700000000' });
  assert.equal(mac.status, 0, mac.stderr);
  assert.doesNotMatch(mac.stdout, /keyring-win32/);
  assert.notEqual(JSON.parse(mac.stdout).serialNumber, bom.serialNumber, 'another list, another serial number');
  assert.equal(cli(['--targets', 'mac']).status, 2);
  assert.equal(cli(['--nope', 'x']).status, 2);
  assert.equal(cli(['--app', 'no/such/dir']).status, 2);
  assert.throws(() => sbomTime({ SOURCE_DATE_EPOCH: 'yesterday' }), /isn't a number of seconds/);
  assert.equal(sbomTime({ SOURCE_DATE_EPOCH: '0' }).toISOString(), '1970-01-01T00:00:00.000Z');
});
