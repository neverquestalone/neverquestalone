#!/usr/bin/env node
// A registry package's tarball, checked against a lockfile's integrity before anything installs it
// (security review SR-07). release.yml installs the other Mac's keychain binding by hand, because npm
// installs only the runner's own optional native package, and npm ci's check against the lockfile
// never covers that install. This downloads the locked version's tarball (npm pack, no scripts),
// hashes the file itself with SHA-512, and prints its path only when the hash is the lockfile's
// "integrity" for that package; release.yml then installs that very file. Anything else fails closed,
// and a tarball that doesn't match is deleted: no entry for the package in the lockfile, no sha512 in
// its integrity, npm pack giving anything but the one tarball of that name and version, or other bytes.
//
//   node tools/locked-tarball.mjs --lock <package-lock.json> --package <name> --out <folder>
//   stdout: the tarball's path · exit 0 it matches the lockfile · 1 it doesn't, or nothing to check it
//   against · 2 usage, or npm pack gave no tarball
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The lockfile's version and sha512 hashes (base64) for a package at its top level: { version, sha512: [...] }, or null. */
export function lockedIntegrity(lock, name) {
  const e = lock?.packages?.[`node_modules/${name}`];
  if (!e?.version) return null;
  const sha512 = String(e.integrity ?? '').split(/\s+/).filter(h => h.startsWith('sha512-')).map(h => h.slice('sha512-'.length).split('?')[0]);
  return { version: e.version, sha512 };
}

/** A file's SHA-512, base64, as an npm integrity carries it. */
export const sha512Of = file => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');

/** npm pack <spec> into out, run in cwd (its .npmrc), no scripts: npm's --json report. */
function npmPack(spec, out, cwd) {
  return execFileSync(npm, ['pack', spec, '--pack-destination', out, '--json', '--ignore-scripts'], { cwd, encoding: 'utf8', maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });
}

export function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`), pack = npmPack } = {}) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (!['--lock', '--package', '--out'].includes(a) || v === undefined || v.startsWith('--')) {
      stderr('usage: node tools/locked-tarball.mjs --lock <package-lock.json> --package <name> --out <folder>');
      return 2;
    }
    o[a.slice(2)] = v;
    i++;
  }
  if (!o.lock || !o.package || !o.out) { stderr('usage: node tools/locked-tarball.mjs --lock <package-lock.json> --package <name> --out <folder>'); return 2; }
  let lock;
  try { lock = JSON.parse(fs.readFileSync(o.lock, 'utf8')); } catch (e) { stderr(`locked-tarball: can't read ${o.lock}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); return 2; }
  const want = lockedIntegrity(lock, o.package);
  if (!want) { stderr(`locked-tarball: ${o.lock} doesn't lock ${o.package}`); return 1; }
  if (!want.sha512.length) { stderr(`locked-tarball: ${o.lock} has no sha512 integrity for ${o.package}@${want.version}, so nothing to check its tarball against`); return 1; }
  const spec = `${o.package}@${want.version}`;
  fs.mkdirSync(o.out, { recursive: true });
  let report;
  try { report = JSON.parse(pack(spec, o.out, path.dirname(path.resolve(o.lock)))); } catch (e) { stderr(`locked-tarball: npm pack ${spec} gave no tarball (${String(e.message).split('\n')[0]})`); return 2; }
  const packed = Array.isArray(report) && report.length === 1 ? report[0] : null;
  const file = packed?.filename && path.basename(packed.filename) === packed.filename ? path.join(o.out, packed.filename) : null;
  if (!packed || packed.name !== o.package || packed.version !== want.version || !file || !fs.existsSync(file)) {
    stderr(`locked-tarball: npm pack ${spec} didn't give the one tarball of ${spec}`);
    return 2;
  }
  const got = sha512Of(file);
  if (!want.sha512.includes(got)) {
    fs.rmSync(file, { force: true });
    stderr(`locked-tarball: ${spec}'s tarball isn't the one ${o.lock} locks: its SHA-512 is sha512-${got}, the lockfile's ${want.sha512.map(h => `sha512-${h}`).join(' or ')}. Not installed, and deleted.`);
    return 1;
  }
  stderr(`locked-tarball: ${spec}: its SHA-512 is the lockfile's integrity`);
  stdout(file);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
