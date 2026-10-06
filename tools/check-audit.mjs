#!/usr/bin/env node
// The high-severity npm audit gate on what the app runs (code health AP-09): npm audit --omit=dev
// over both lockfiles fails on any advisory of high or critical severity. If one with no fix must not
// block a release, the answer is a pinned, dated override recorded here, never a disabled gate:
// tools/audit-allow.json lists them, and starts empty.
//
//   [{ "id": "GHSA-xxxx-xxxx-xxxx", "package": "<the npm package it's in>", "reason": "<why it can wait>", "until": "YYYY-MM-DD" }]
//
// An entry lets exactly that advisory in exactly that package through, until the end of its day
// (UTC). An entry past its date, or one that isn't exactly those four fields well formed (or names
// the same advisory twice), fails the gate; an advisory no entry names fails as before. An entry
// that matches nothing is said, so it gets removed. It prints advisory ids, packages and titles only.
//
// Electron too (security review SR-04): it's a devDependency of app/desktop, because electron-builder
// copies its binary into the app rather than npm installing it there, so npm audit --omit=dev never
// sees it, yet it's the Chromium and Node every player runs. So a lockfile that pins one of SHIPPED_DEV
// is audited a second time with its dev dependencies, and any advisory in those packages themselves
// of moderate severity or more fails the gate (SHIPPED_LEVELS), through the same allow file. The rest
// of that second report is build tooling that never ships, and never fails it: it's counted in one
// line. Known there and out of scope (2026-10-03, app/desktop): GHSA-ch52-4w7c-c8xp (high),
// http-cache-semantics' max-stale handling, which npm counts as 8 highs, one per package on the
// path: http-cache-semantics, cacheable-request, got, @electron/get, app-builder-lib, dmg-builder,
// electron-builder and electron-builder-squirrel-windows. They download Electron and the build's
// tools on the build machine; none is in the app.
//
//   node tools/check-audit.mjs [--dir <folder holding a package-lock.json>]... [--allow <file>] [--now <ISO date>]
//   (default: the repo root and app/desktop, and tools/audit-allow.json; with the defaults, a lockfile
//   must pin electron)
//   exit 0 nothing high or critical left, and nothing moderate or worse in electron · 1 one no live
//   entry names, or an entry expired or malformed · 2 usage, no allow file, npm audit gave no report,
//   or the default lockfiles pin no electron
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LEVELS = ['high', 'critical'];
/** devDependencies whose code ships anyway (electron-builder packs them into the app), and the severities that fail for them. */
export const SHIPPED_DEV = Object.freeze(['electron']);
export const SHIPPED_LEVELS = Object.freeze(['moderate', 'high', 'critical']);
const GHSA = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;
const PACKAGE = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;
const FIELDS = ['id', 'package', 'reason', 'until'];

const validDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * The allow file's entries checked: { entries, problems }. A problem is a malformed entry (not
 * exactly the four fields, a field that isn't well formed, the same advisory and package twice) or
 * an expired one (its until before now's day).
 */
export function checkAllow(list, now) {
  const problems = [];
  if (!Array.isArray(list)) return { entries: [], problems: ['the allow file must be a JSON array of entries'] };
  const today = new Date(now).toISOString().slice(0, 10);
  const seen = new Set();
  const entries = [];
  list.forEach((e, i) => {
    const at = `entry ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) { problems.push(`${at}: not an object`); return; }
    const keys = Object.keys(e).sort();
    if (keys.join() !== [...FIELDS].sort().join()) { problems.push(`${at}: needs exactly ${FIELDS.join(', ')} (it has ${keys.join(', ') || 'none'})`); return; }
    const bad = [];
    if (typeof e.id !== 'string' || !GHSA.test(e.id)) bad.push('id is no GHSA-xxxx-xxxx-xxxx');
    if (typeof e.package !== 'string' || !PACKAGE.test(e.package)) bad.push('package is no npm package name');
    if (typeof e.reason !== 'string' || !e.reason.trim()) bad.push('no reason');
    if (typeof e.until !== 'string' || !validDay(e.until)) bad.push('until is no YYYY-MM-DD date');
    if (bad.length) { problems.push(`${at}: ${bad.join('; ')}`); return; }
    const key = `${e.id} ${e.package}`;
    if (seen.has(key)) { problems.push(`${at}: ${e.id} in ${e.package} is listed twice`); return; }
    seen.add(key);
    if (e.until < today) { problems.push(`${at}: ${e.id} in ${e.package} expired on ${e.until}; fix it, or renew the entry with a new reason`); return; }
    entries.push(e);
  });
  return { entries, problems };
}

/**
 * The advisories in an npm audit --json report (auditReportVersion 2) at or above high (or the given
 * levels), in any package (or only the given packages): [{ id, package, severity, title, fix }], one
 * per advisory and package. The packages that are vulnerable only through another one ("via": a name)
 * carry no advisory of their own.
 */
export function advisories(report, { levels = LEVELS, packages = null } = {}) {
  const out = new Map();
  for (const v of Object.values(report?.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (!via || typeof via !== 'object' || !levels.includes(via.severity)) continue;
      const id = (/\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})\b/.exec(via.url ?? '') ?? [])[1] ?? `npm advisory ${via.source ?? '?'}`;
      const pkg = via.name ?? v.name;
      if (packages && !packages.includes(pkg)) continue;
      out.set(`${id} ${pkg}`, { id, package: pkg, severity: via.severity, title: via.title ?? '', fix: v.fixAvailable ? 'a fix is available' : 'no fix yet' });
    }
  }
  return [...out.values()];
}

/** The SHIPPED_DEV packages a folder's package-lock.json pins at its top level: ['electron@44.5.1']; none when it has no lockfile. */
export function shippedDevPins(dir) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')); } catch { return []; }
  return SHIPPED_DEV.filter(n => lock?.packages?.[`node_modules/${n}`]?.version).map(n => `${n}@${lock.packages[`node_modules/${n}`].version}`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
/** npm audit --json over a folder's lockfile alone (no install needed), --omit=dev unless dev: the parsed report. */
function npmAudit(dir, { dev = false } = {}) {
  let out;
  try {
    out = execFileSync(npm, ['audit', '--json', ...(dev ? [] : ['--omit=dev']), '--package-lock-only'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  } catch (e) { out = String(e.stdout ?? ''); } // npm audit exits 1 when it finds anything
  return JSON.parse(out);
}

export async function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`), audit = npmAudit, root = ROOT } = {}) {
  const o = { dirs: [], allow: path.join(root, 'tools', 'audit-allow.json'), now: new Date() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    const need = () => { if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`); i++; return v; };
    try {
      if (a === '--dir') o.dirs.push(need());
      else if (a === '--allow') o.allow = need();
      else if (a === '--now') { o.now = new Date(need()); if (Number.isNaN(o.now.getTime())) throw new Error('--now needs an ISO date'); }
      else throw new Error(`unknown argument: ${a}`);
    } catch (e) { stderr(`check-audit: ${e.message}`); return 2; }
  }
  const defaults = !o.dirs.length;
  if (defaults) o.dirs = [root, path.join(root, 'app', 'desktop')];
  const allowName = path.relative(root, o.allow) || o.allow;
  let list;
  try { list = JSON.parse(fs.readFileSync(o.allow, 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') { stderr(`check-audit: no allow file at ${allowName} (it may be an empty list, [], never absent)`); return 2; }
    list = { malformed: e.message };
  }
  const { entries, problems } = list?.malformed ? { entries: [], problems: [`${allowName} isn't JSON: ${list.malformed}`] } : checkAllow(list, o.now);
  for (const p of problems) stdout(`::error::check-audit: ${allowName}: ${p}`);
  const used = new Set();
  const blocked = [];
  const shipped = [];
  let total = 0;
  const report = async (dir, where, opts) => {
    let r;
    try { r = await audit(dir, opts); } catch (e) { stderr(`check-audit: npm audit${opts ? ' with dev' : ''} gave no report for ${where}: ${String(e.message).split('\n')[0]}`); return null; }
    if (!r || r.error || !r.vulnerabilities) { stderr(`check-audit: npm audit${opts ? ' with dev' : ''} gave no report for ${where}: ${r?.error?.summary ?? r?.error?.code ?? 'no vulnerabilities map'}`); return null; }
    return r;
  };
  for (const dir of o.dirs) {
    const where = path.relative(root, dir) || '.';
    const seen = new Set();
    const consider = (a, kind) => {
      seen.add(`${a.id} ${a.package}`);
      total++;
      const entry = entries.find(e => e.id === a.id && e.package === a.package);
      if (entry) {
        used.add(entry);
        stdout(`check-audit: ${where}: ${a.id} (${a.severity}) in ${a.package}: let through until ${entry.until} by ${allowName}: ${entry.reason}`);
      } else {
        blocked.push({ ...a, kind });
        stdout(`check-audit: ${where}: ${a.id} (${a.severity}) in ${a.package}: ${a.title} (${a.fix})`);
      }
    };
    const prod = await report(dir, where);
    if (!prod) return 2;
    for (const a of advisories(prod)) consider(a, 'runs');
    // Electron (SR-04): the lockfile again with its dev dependencies, for the packages that ship anyway.
    const pins = shippedDevPins(dir);
    if (!pins.length) continue;
    shipped.push(...pins);
    const full = await report(dir, where, { dev: true });
    if (!full) return 2;
    for (const a of advisories(full, { levels: SHIPPED_LEVELS, packages: SHIPPED_DEV })) if (!seen.has(`${a.id} ${a.package}`)) consider(a, 'shipped');
    const tooling = advisories(full, { levels: ['info', 'low', ...SHIPPED_LEVELS] }).filter(a => !SHIPPED_DEV.includes(a.package) && !seen.has(`${a.id} ${a.package}`));
    if (tooling.length) stdout(`check-audit: ${where}: build tooling only, never in the app, out of scope: ${tooling.map(a => `${a.id} (${a.severity}) in ${a.package}`).join('; ')}`);
  }
  if (defaults && !shipped.length) {
    stderr(`check-audit: no lockfile pins ${SHIPPED_DEV.join(' or ')}, so the Electron check would see nothing (app/desktop/package-lock.json pins it)`);
    return 2;
  }
  for (const e of entries) if (!used.has(e)) stdout(`note: ${allowName}'s entry for ${e.id} in ${e.package} matches no advisory now; remove it`);
  if (blocked.length || problems.length) {
    const runs = blocked.filter(a => a.kind === 'runs').length, ships = blocked.length - runs;
    const what = [
      ...(runs || !ships ? [`${runs} high or critical advisor${runs === 1 ? 'y' : 'ies'} in what the app runs`] : []),
      ...(ships ? [`${ships} advisor${ships === 1 ? 'y' : 'ies'} of moderate severity or more in ${SHIPPED_DEV.join(', ')}`] : []),
    ].join(' and ');
    stdout(`FAIL: ${what} that no entry lets through${problems.length ? `, and ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${allowName}` : ''}. Update the package, or, if there's no fix, add a dated entry with its reason to ${allowName}.`);
    return 1;
  }
  stdout(`PASS: no high or critical advisory in what the app runs${shipped.length ? `, and none moderate or worse in ${shipped.join(', ')}` : ''}${total ? `, but the ${total} ${allowName} lets through` : ''} (npm audit --omit=dev, ${o.dirs.length} lockfile${o.dirs.length === 1 ? '' : 's'}${shipped.length ? '; with dev for electron' : ''}).`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
