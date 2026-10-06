#!/usr/bin/env node
// The 7-day release-age cooldown on the committed lockfiles (PRD SC-4, TH16; audit LS-08; code
// health AP-09). .npmrc's min-release-age=7 stops npm from resolving a version under 7 days old,
// but only when it resolves one: a lockfile that already pins a young version installs as it is
// (npm ci reads no publish dates, and CI's npm 10 ignores the setting). So CI checks every version
// both lockfiles pin against the registry's publish times: each must be 7 days old.
//
// One exception, for security backports: electron may be 48 hours old when it's a patch or minor
// release above the previous lock's electron, in the same major (44.4.5 to 44.5.1, never 44 to 45).
// The previous lock is the electron version the lockfiles pinned before this one: found in git
// history (the first-parent commits that changed the lockfile holding electron), or named with
// --previous-lock <an older package-lock.json>. No previous lock found: no exception.
//
// The check reads only the public registry (one GET per package name) and prints names, versions
// and ages.
//
//   node tools/check-release-age.mjs [--lock <package-lock.json>]... [--previous-lock <file>] [--days <n>] [--now <ISO date>]
//   (default: package-lock.json and app/desktop/package-lock.json, 7 days, the previous lock from git)
//   exit 0 every version old enough · 1 a young version, or one the registry has no time for · 2 usage or unreadable input
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, parseVersion } from '../app/desktop/updater.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DAYS = 7;
export const ELECTRON_HOURS = 48;
export const REGISTRY = 'https://registry.npmjs.org/';
const HOUR_MS = 60 * 60 * 1000;
const PARALLEL = 6;

/** Every registry package a lockfile (v2 or v3) pins: [{ name, version, lockfile }]; not the root, links or bundled packages. */
export function lockEntries(lock, lockfile) {
  if (!lock || !lock.packages || ![2, 3].includes(lock.lockfileVersion)) throw new Error(`${lockfile}: expected lockfileVersion 2 or 3 with a "packages" map`);
  const seen = new Map();
  for (const [key, e] of Object.entries(lock.packages)) {
    if (!key || e.link || e.inBundle || !e.version || !e.resolved) continue;
    const name = e.name || key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    seen.set(`${name}@${e.version}`, { name, version: e.version, lockfile });
  }
  return [...seen.values()];
}

/** The electron version a lockfile pins (its top-level node_modules/electron), or null. */
export function lockedElectron(lock) {
  return lock?.packages?.['node_modules/electron']?.version ?? null;
}

/**
 * Whether electron `version` may ship at `hours` old: a patch or minor release above `previous`
 * (the previous lock's electron), in the same major, not a prerelease, and ELECTRON_HOURS old.
 */
export function electronBackport(version, previous, hours) {
  const v = parseVersion(version), p = parseVersion(previous);
  if (!v || !p || v.pre.length) return false;
  return v.major === p.major && compareVersions(version, previous) === 1 && hours >= ELECTRON_HOURS;
}

/**
 * The problems with entries given the registry's publish times (times[name][version], ISO dates): a
 * version under `days` old (but electron under the backport rule), and a version with no publish
 * time. → [{ name, version, lockfile, reason }]; `notes` gets a line for each version let through.
 */
export function findYoung(entries, times, now, { days = DAYS, previousElectron = null, notes = [] } = {}) {
  const out = [];
  const nowMs = new Date(now).getTime();
  for (const entry of entries) {
    const t = times?.[entry.name]?.[entry.version];
    const ms = t ? new Date(t).getTime() : NaN;
    if (!Number.isFinite(ms)) { out.push({ ...entry, reason: 'no publish time in the registry' }); continue; }
    const hours = (nowMs - ms) / HOUR_MS;
    if (hours >= days * 24) continue;
    if (entry.name === 'electron' && electronBackport(entry.version, previousElectron, hours)) {
      notes.push(`electron@${entry.version} is ${(hours / 24).toFixed(1)} days old: a backport within ${previousElectron}'s major (at least ${ELECTRON_HOURS} h old), allowed`);
      continue;
    }
    const why = entry.name === 'electron' && previousElectron
      ? `; electron's 48-hour rule needs a patch or minor above ${previousElectron} in its major, ${ELECTRON_HOURS} h old`
      : '';
    out.push({ ...entry, reason: `${(hours / 24).toFixed(1)} days old, under ${days}${why}` });
  }
  return out;
}

/**
 * The previous lock's electron from git history: walking the first-parent commits that changed
 * `lockfile` (repo-relative), newest first, the electron version before the change that brought in
 * `current`. null when git or the history doesn't say (a shallow clone, no change).
 */
export function previousElectronFromGit(repo, lockfile, current, { git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  const at = rev => { try { return lockedElectron(JSON.parse(git(['show', `${rev}:${lockfile}`]))); } catch { return null; } };
  let commits;
  try { commits = git(['log', '--first-parent', '--format=%H', '-n', '200', 'HEAD', '--', lockfile]).split('\n').filter(Boolean); } catch { return null; }
  for (const c of commits) {
    if (at(c) !== current) continue;
    const before = at(`${c}^`);
    if (before && before !== current) return before;
  }
  return null;
}

const registryUrl = name => REGISTRY + name.replace('/', '%2f');

export async function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`), fetch = globalThis.fetch, root = ROOT, previousFromGit = previousElectronFromGit } = {}) {
  const o = { locks: [], previousLock: null, days: DAYS, now: new Date() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const need = () => { if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); i++; return v; };
    try {
      if (a === '--lock') o.locks.push(need());
      else if (a === '--previous-lock') o.previousLock = need();
      else if (a === '--days') { o.days = Number(need()); if (!(o.days > 0)) throw new Error('--days needs a positive number'); }
      else if (a === '--now') { o.now = new Date(need()); if (Number.isNaN(o.now.getTime())) throw new Error('--now needs an ISO date'); }
      else throw new Error(`unknown argument: ${a}`);
    } catch (e) { stderr(`check-release-age: ${e.message}`); return 2; }
  }
  if (!o.locks.length) o.locks = [path.join(root, 'package-lock.json'), path.join(root, 'app', 'desktop', 'package-lock.json')];
  const byVersion = new Map();
  let electron = null, electronLock = null, previousElectron = null;
  try {
    for (const f of o.locks) {
      const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
      const rel = path.relative(root, f) || f;
      if (lockedElectron(lock)) { electron = lockedElectron(lock); electronLock = f; }
      for (const e of lockEntries(lock, rel)) {
        const k = `${e.name}@${e.version}`;
        const seen = byVersion.get(k);
        byVersion.set(k, seen ? { ...seen, lockfile: `${seen.lockfile}, ${e.lockfile}` } : e);
      }
    }
    if (o.previousLock) previousElectron = lockedElectron(JSON.parse(fs.readFileSync(o.previousLock, 'utf8')));
    else if (electron) previousElectron = previousFromGit(root, path.relative(root, electronLock).split(path.sep).join('/'), electron);
  } catch (e) { stderr(`check-release-age: ${e.code === 'ENOENT' ? `no such file: ${e.path}` : e.message}`); return 2; }
  const entries = [...byVersion.values()];
  if (electron) stdout(`electron@${electron}; the previous lock's: ${previousElectron ?? 'not found (no 48-hour backport rule)'}`);

  const names = [...new Set(entries.map(e => e.name))].sort();
  const times = {};
  const failed = [];
  for (let i = 0; i < names.length; i += PARALLEL) {
    await Promise.all(names.slice(i, i + PARALLEL).map(async name => {
      try {
        const r = await fetch(registryUrl(name), { headers: { accept: 'application/json' } });
        if (!r.ok) { failed.push(`${name} (HTTP ${r.status})`); return; }
        times[name] = (await r.json()).time ?? {};
      } catch (e) { failed.push(`${name} (${e.code || e.message})`); }
    }));
  }
  if (failed.length) stderr(`check-release-age: no registry answer for ${failed.length} package(s): ${failed.sort().join(', ')}`);
  const notes = [];
  const problems = findYoung(entries, times, o.now, { days: o.days, previousElectron, notes });
  for (const n of notes) stdout(n);
  for (const p of problems) stdout(`${p.name}@${p.version} (${p.lockfile}): ${p.reason}`);
  stdout(problems.length
    ? `FAIL: ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${entries.length} locked versions. SC-4: a version must be ${o.days} days old before it ships (electron: 48 hours for a patch or minor in the previous lock's major); wait, or pin an older version.`
    : `PASS: all ${entries.length} locked versions are at least ${o.days} days old${notes.length ? ', but the electron backport above' : ''}.`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
