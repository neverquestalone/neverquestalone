#!/usr/bin/env node
// The SBOM a release attaches (open-shell PRD lane 7): every package the shipped app holds, as CycloneDX 1.5
// JSON, read from app/desktop's package-lock.json alone (no install, no dependency, no network).
//
// What it lists:
// - the packages electron-builder packs into app.asar: app/desktop's production dependencies, walked from its
//   package.json through the lockfile the way Node resolves them (a nested node_modules first), with their
//   required peers. A platform package (os, cpu, libc) is listed only when a target the release ships matches it,
//   so the Mac keychain bindings are in a Mac release and the Windows one only when Windows is built;
// - Electron, the runtime every download carries (a devDependency, since electron-builder takes its binary from
//   Electron's own release, never from the npm package; so no tarball hash for it, only its release page).
// The root package's dependencies don't ship (the bridge in app.asar loads app/desktop's), so its lockfile isn't read.
//
// Each package: name (a scope as its group), version, purl, the lockfile's integrity as hex hashes, its licence
// when the lockfile has one, and the registry tarball it came from. The dependency graph is in "dependencies".
// The output is the same for the same lockfile and SOURCE_DATE_EPOCH (its timestamp; the serial number is a
// UUID made from the contents), and holds no local path: a lockfile entry resolved from anything but https is
// refused.
//
//   node tools/sbom.mjs [--app app/desktop] [--targets darwin-arm64,darwin-x64,win32-x64] [--out <file>]
//   exit 0 written (to stdout without --out) · 1 the lockfile lacks a package the app needs, or has a local one · 2 usage
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_TARGETS = Object.freeze(['darwin-arm64', 'darwin-x64', 'win32-x64']);
const HASH_ALGS = Object.freeze({ sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' });
// RFC 4122's URL namespace, for the name-based (version 5) serial number.
const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/** A package's name from its lockfile key (node_modules/a/node_modules/@s/b → @s/b), unless the entry names itself. */
const nameOf = (key, entry) => entry.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** The purl of an npm package: pkg:npm/%40scope/name@version. */
export function purlOf(name, version) {
  const [scope, bare] = name.startsWith('@') ? name.split('/') : [null, name];
  return `pkg:npm/${scope ? `${encodeURIComponent(scope)}/` : ''}${encodeURIComponent(bare)}@${encodeURIComponent(version)}`;
}

/** The lockfile's integrity ("sha512-<base64> …") as CycloneDX hashes (hex). */
export function hashesOf(integrity = '') {
  const out = [];
  for (const part of integrity.split(/\s+/).filter(Boolean)) {
    const m = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+=*)$/.exec(part);
    if (m) out.push({ alg: HASH_ALGS[m[1]], content: Buffer.from(m[2], 'base64').toString('hex') });
  }
  return out;
}

/** A licence field as CycloneDX licenses: an SPDX expression, or a name for anything else ("SEE LICENSE IN …"). */
export function licensesOf(license) {
  const l = typeof license === 'string' ? license.trim() : typeof license?.type === 'string' ? license.type.trim() : '';
  if (!l) return undefined;
  if (/^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$|^\(.*\)$/.test(l) && !/^(?:UNLICENSED|SEE\b)/i.test(l)) return [{ expression: l }];
  return [{ license: { name: l } }];
}

/** Whether a lockfile entry's os, cpu and libc fields let it install on one of the targets ("darwin-arm64"). */
export function onTargets(entry, targets) {
  const fits = (list, value) => {
    if (!Array.isArray(list) || !list.length) return true;
    const no = list.filter(v => v.startsWith('!')).map(v => v.slice(1));
    const yes = list.filter(v => !v.startsWith('!'));
    return !no.includes(value) && (!yes.length || yes.includes(value));
  };
  return targets.some(t => {
    const [os, cpu] = t.split('-');
    // libc is a Linux field: no release target here is Linux, so an entry that names one never ships.
    if (Array.isArray(entry.libc) && entry.libc.length && os !== 'linux') return false;
    return fits(entry.os, os) && fits(entry.cpu, cpu);
  });
}

/** Where a dependency resolves from a lockfile key, as Node looks: its own node_modules, then each parent's. */
function resolveKey(packages, fromKey, name) {
  for (let dir = fromKey; ; ) {
    const key = dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[key]) return key;
    if (!dir) return null;
    const at = dir.lastIndexOf('/node_modules/');
    dir = at < 0 ? '' : dir.slice(0, at);
  }
}

/**
 * The packages the app ships, walked from app/desktop's package.json through its lockfile.
 * → { packages: [{ key, name, version, entry, deps: [key] }] sorted by name and version, direct: [key] };
 * throws on a package the app needs that the lockfile lacks, marks as development-only or has from a local source.
 */
export function shippedPackages(lock, targets = DEFAULT_TARGETS) {
  const packages = lock?.packages;
  if (!packages || ![2, 3].includes(lock.lockfileVersion)) throw new Error('expected a package-lock.json with lockfileVersion 2 or 3');
  const root = packages[''] ?? {};
  // What an entry needs: its dependencies, optional ones and peers (an optional peer only when it's installed for production).
  const needs = (fromKey, entry) => {
    const optional = new Set([...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.entries(entry.peerDependenciesMeta ?? {}).filter(([, m]) => m?.optional).map(([n]) => n)]);
    const names = [...Object.keys(entry.dependencies ?? {}), ...Object.keys(entry.optionalDependencies ?? {}), ...Object.keys(entry.peerDependencies ?? {})];
    return [...new Set(names)].map(name => ({ name, key: resolveKey(packages, fromKey, name), optional: optional.has(name), from: fromKey }));
  };
  const seen = new Map();
  const edges = new Map([['', []]]);
  const queue = needs('', { dependencies: root.dependencies, optionalDependencies: root.optionalDependencies });
  while (queue.length) {
    const { name, key, optional, from } = queue.shift();
    const who = from || 'the app';
    if (!key) {
      if (optional) continue;
      throw new Error(`${who} needs ${name}, which the lockfile doesn't have`);
    }
    const entry = packages[key];
    if (entry.dev) {
      if (optional) continue; // installed for development only: never packed
      throw new Error(`${who} needs ${name}, which the lockfile marks as a development package`);
    }
    if (!onTargets(entry, targets)) continue;
    if (!edges.get(from).includes(key)) edges.get(from).push(key);
    if (seen.has(key)) continue;
    if (entry.link || !/^https:\/\//.test(entry.resolved ?? '')) throw new Error(`${key} isn't from a registry over https (${entry.link ? 'a link' : entry.resolved ? 'a local or non-https source' : 'no resolved URL'}): an SBOM never names a local path`);
    seen.set(key, { key, name: nameOf(key, entry), version: entry.version, entry });
    edges.set(key, []);
    queue.push(...needs(key, entry));
  }
  const order = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : a.version > b.version ? 1 : 0);
  return { packages: [...seen.values()].map(p => ({ ...p, deps: edges.get(p.key) })).sort(order), direct: edges.get('') };
}

/** A version 5 (name-based, SHA-1) UUID. */
function uuid5(name, namespace = URL_NAMESPACE) {
  const h = crypto.createHash('sha1').update(Buffer.from(namespace.replace(/-/g, ''), 'hex')).update(name).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/**
 * The CycloneDX 1.5 BOM from the app's package.json (pkg) and package-lock.json (lock), for the targets.
 * → the BOM object. time: its timestamp (sbomTime(): SOURCE_DATE_EPOCH's, else now).
 */
export function buildSbom({ pkg, lock, targets = DEFAULT_TARGETS, time = new Date() } = {}) {
  const { packages: shipped, direct } = shippedPackages(lock, targets);
  const app = { name: pkg.productName || pkg.name, version: pkg.version };
  const appRef = `${pkg.name}@${pkg.version}`;
  const refs = new Map();
  const components = [];
  for (const p of shipped) {
    const ref = purlOf(p.name, p.version);
    refs.set(p.key, ref);
    if (components.some(c => c['bom-ref'] === ref)) continue; // the same version nested twice is one component
    const [group, name] = p.name.startsWith('@') ? p.name.split('/') : [undefined, p.name];
    components.push({
      type: 'library', 'bom-ref': ref, ...(group ? { group } : {}), name, version: p.version, scope: 'required',
      ...(hashesOf(p.entry.integrity).length ? { hashes: hashesOf(p.entry.integrity) } : {}), ...(licensesOf(p.entry.license) ? { licenses: licensesOf(p.entry.license) } : {}), purl: ref,
      externalReferences: [{ type: 'distribution', url: p.entry.resolved }],
    });
  }
  // Electron: the runtime in every download, from Electron's release (electron-builder's download), not npm's tarball.
  const electron = lock.packages['node_modules/electron'];
  const electronRef = electron ? purlOf('electron', electron.version) : null;
  if (electron) {
    components.push({
      type: 'framework', 'bom-ref': electronRef, name: 'electron', version: electron.version, scope: 'required',
      ...(licensesOf(electron.license) ? { licenses: licensesOf(electron.license) } : {}), purl: electronRef,
      externalReferences: [{ type: 'distribution', url: `https://github.com/electron/electron/releases/tag/v${electron.version}` }],
    });
  }
  const dependencies = [
    { ref: appRef, dependsOn: [...new Set([...(electronRef ? [electronRef] : []), ...direct.map(k => refs.get(k))])].sort() },
    ...(electronRef ? [{ ref: electronRef, dependsOn: [] }] : []),
  ];
  for (const p of shipped) {
    const ref = refs.get(p.key);
    const dependsOn = [...new Set(p.deps.map(k => refs.get(k)))].sort();
    const had = dependencies.find(d => d.ref === ref);
    if (had) had.dependsOn = [...new Set([...had.dependsOn, ...dependsOn])].sort();
    else dependencies.push({ ref, dependsOn });
  }
  const body = { components, dependencies };
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${uuid5(`${appRef} ${targets.join(',')} ${crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex')}`)}`,
    version: 1,
    metadata: {
      timestamp: time.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      tools: { components: [{ type: 'application', name: 'sbom.mjs', description: 'tools/sbom.mjs: the shipped packages, from app/desktop/package-lock.json' }] },
      component: { type: 'application', 'bom-ref': appRef, name: app.name, version: app.version, ...(licensesOf(pkg.license) ? { licenses: licensesOf(pkg.license) } : {}) },
      properties: [{ name: 'targets', value: targets.join(',') }],
    },
    components,
    dependencies,
  };
}

/** The timestamp: SOURCE_DATE_EPOCH (seconds) when set, else now. */
export function sbomTime(env = process.env) {
  const s = env.SOURCE_DATE_EPOCH;
  if (s === undefined || s === '') return new Date();
  if (!/^\d+$/.test(s)) throw new Error(`SOURCE_DATE_EPOCH isn't a number of seconds: ${s}`);
  return new Date(Number(s) * 1000);
}

function main(argv) {
  const opts = { app: 'app/desktop', targets: DEFAULT_TARGETS.join(','), out: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, '');
    if (!['app', 'targets', 'out'].includes(k) || !argv[i].startsWith('--') || argv[i + 1] === undefined) {
      process.stderr.write('usage: node tools/sbom.mjs [--app <dir>] [--targets <os-cpu,…>] [--out <file>]\n');
      return 2;
    }
    opts[k] = argv[++i];
  }
  const targets = opts.targets.split(',').map(s => s.trim()).filter(Boolean);
  if (!targets.length || targets.some(t => !/^[a-z0-9]+-[a-z0-9]+$/.test(t))) {
    process.stderr.write(`sbom: --targets wants os-cpu names, such as ${DEFAULT_TARGETS.join(',')}\n`);
    return 2;
  }
  const dir = path.resolve(ROOT, opts.app);
  let pkg, lock;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  } catch (e) {
    process.stderr.write(`sbom: can't read ${opts.app}'s package.json and package-lock.json: ${e.message}\n`);
    return 2;
  }
  let text;
  try {
    const bom = buildSbom({ pkg, lock, targets, time: sbomTime() });
    text = `${JSON.stringify(bom, null, 2)}\n`;
    if (opts.out) {
      fs.writeFileSync(opts.out, text);
      process.stderr.write(`sbom: ${bom.components.length} components for ${bom.metadata.component.name} ${bom.metadata.component.version} (${targets.join(', ')}) in ${path.basename(opts.out)}\n`);
    } else process.stdout.write(text);
  } catch (e) {
    process.stderr.write(`sbom: ${e.message}\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
