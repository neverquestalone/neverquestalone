#!/usr/bin/env node
// The release gate for a macOS build (audit LA-04 and KA-08; PRD PF-3, §11.1, §22 Q2):
// nothing ad hoc or unsigned goes to testers. On an ad hoc build the asar integrity check
// protects nothing (Info.plist can be edited to match), each saved key's Keychain entry is
// tied to that one build's code hash, and Squirrel.Mac can never accept an update, because
// the next build can't meet a cdhash designated requirement. So every piece of signed code
// in the app must be:
//   - signed with a Developer ID Application certificate, not ad hoc;
//   - one team: a TeamIdentifier, the same on the app, its capture helper and its keychain
//     binding;
//   - hardened runtime (the "runtime" code-directory flag);
//   - a Developer ID designated requirement (anchor apple generic, the Developer ID leaf
//     and intermediate markers, and leaf[subject.OU] = that team), so the next update and
//     the Keychain's access list still match;
//   - valid under codesign --verify --deep --strict;
//   - the entitlements it should have (security review SR-06): the app exactly
//     app/desktop/build/entitlements.mac.plist's (allow-jit), and each helper app in Resources (the
//     capture helper) none at all, the hardened runtime alone (scripts/sign-mac.cjs signs it so),
//     read with codesign -d --entitlements - --xml.
// And no Mach-O file in the app may carry a debug map (N_SO/N_OSO stabs name every object
// and source file by its absolute path on the build machine) or this checkout's own path,
// and our own helpers no absolute home path at all (audit LS-06; the afterPack hook runs
// the same check on every Mac build).
// release.yml runs it on every macOS build; the owner runs it on any .app built elsewhere
// before uploading it. --allow-unsigned (release.yml's allow_unsigned input, an internal
// test build) turns the signature findings into warnings; the binary findings still fail.
//
//   node tools/check-release.mjs [--allow-unsigned] <NeverQuestAlone.app> …
//   exit 0 ready to ship · 1 a check failed · 2 usage, or codesign missing
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The app's own entitlements, as electron-builder.yml signs it with them. */
export const APP_ENTITLEMENTS = path.join(ROOT, 'app', 'desktop', 'build', 'entitlements.mac.plist');

const TEAM_ID = /^[A-Z0-9]{10}$/;
// The Developer ID markers codesign writes into a Developer ID Application designated requirement.
const DEV_ID_CA = 'certificate 1[field.1.2.840.113635.100.6.2.6]';
const DEV_ID_LEAF = 'certificate leaf[field.1.2.840.113635.100.6.1.13]';

/**
 * Entitlements from a plist: what `codesign -d --entitlements - --xml` prints, or an entitlements file.
 * { key: its value as XML, e.g. '<true/>' }; {} when there are none (no output, or an empty dict); null
 * when it isn't one plist dict.
 */
export function entitlementsOf(xml) {
  const text = String(xml ?? '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return {};
  const body = /<plist\b[^>]*>([\s\S]*)<\/plist>/.exec(text)?.[1].trim();
  if (body === undefined) return null;
  if (/^<dict\s*\/>$/.test(body)) return {};
  const dict = /^<dict>([\s\S]*)<\/dict>$/.exec(body);
  if (!dict) return null;
  const tokens = (dict[1].match(/<[^>]+>|[^<]+/g) ?? []).map(t => t.trim()).filter(Boolean);
  const out = {};
  for (let i = 0; i < tokens.length;) {
    if (tokens[i] !== '<key>' || tokens[i + 2] !== '</key>') return null;
    const key = tokens[i + 1];
    i += 3;
    let depth = 0, value = '';
    do {
      const t = tokens[i++];
      if (t === undefined) return null;
      value += t;
      if (t.startsWith('</')) depth--;
      else if (t.startsWith('<') && !t.endsWith('/>')) depth++;
    } while (depth > 0);
    out[key] = value;
  }
  return out;
}

const entitlementsText = e => (Object.keys(e).length ? Object.entries(e).map(([k, v]) => (v === '<true/>' ? k : `${k} ${v}`)).join(', ') : 'none');

/**
 * One piece of code's signature, from codesign's own output: `codesign -dv --verbose=2` (codesignDv),
 * `codesign -d -r-` (designated) and whether `codesign --verify --deep --strict` passed (verifyOk).
 * team: the app's TeamIdentifier, which nested code must share. With wantEntitlements ({} for none),
 * its entitlements (`codesign -d --entitlements - --xml`) must be exactly those, once it's signed.
 * Returns { ok, reasons, teamId }.
 */
export function checkMacSignature({ codesignDv = '', designated = '', verifyOk = false, team = null, entitlements = '', wantEntitlements }) {
  const reasons = [];
  const flags = (/\bflags=0x[0-9a-f]+\(([^)]*)\)/i.exec(codesignDv)?.[1] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const teamLine = /^TeamIdentifier=(.*)$/m.exec(codesignDv)?.[1]?.trim() ?? '';
  const teamId = TEAM_ID.test(teamLine) ? teamLine : null;
  if (!/^CodeDirectory /m.test(codesignDv)) reasons.push('not signed');
  if (flags.includes('adhoc') || /^Signature=adhoc$/m.test(codesignDv)) reasons.push('adhoc');
  if (!teamId) reasons.push('no TeamIdentifier');
  if (!flags.includes('runtime')) reasons.push('no hardened runtime');
  const dr = /designated => (.*)$/m.exec(designated)?.[1] ?? '';
  const ou = /certificate leaf\[subject\.OU\] = "?([A-Z0-9]{10})"?/.exec(dr)?.[1] ?? null;
  if (!/\banchor apple generic\b/.test(dr) || !dr.includes(DEV_ID_CA) || !dr.includes(DEV_ID_LEAF) || !ou || ou !== teamId) {
    reasons.push('designated requirement is not Developer ID');
  }
  if (team && teamId && teamId !== team) reasons.push(`signed by team ${teamId}, not the app's ${team}`);
  if (!verifyOk) reasons.push('the signature does not verify (codesign --verify --deep --strict)');
  if (wantEntitlements && /^CodeDirectory /m.test(codesignDv)) {
    const got = entitlementsOf(entitlements);
    if (!got) reasons.push('its entitlements are unreadable');
    else if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(wantEntitlements).sort())) {
      reasons.push(`its entitlements are ${entitlementsText(got)}, not ${entitlementsText(wantEntitlements)}`);
    }
  }
  return { ok: reasons.length === 0, reasons, teamId };
}

// The signed code inside an app: the app, each helper app in Resources (the capture helper)
// and each native module in app.asar.unpacked (the keychain binding).
export function signedParts(app) {
  const res = path.join(app, 'Contents', 'Resources');
  const parts = [app];
  const list = dir => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  for (const e of list(res)) if (e.isDirectory() && e.name.endsWith('.app')) parts.push(path.join(res, e.name));
  const walk = dir => {
    for (const e of list(dir)) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.node')) parts.push(p);
    }
  };
  walk(path.join(res, 'app.asar.unpacked'));
  return parts;
}

const N_STAB = 0xe0;
const N_OPT = 0x3c;
const LC_SYMTAB = 0x2;

/**
 * The debug stabs (symbols with an N_STAB type: N_SO, N_OSO, N_FUN, …) in a Mach-O file, thin or
 * universal: { slices, stabs }, or null when buf isn't Mach-O. N_OPT isn't counted: ld64 writes one
 * ("radr://5614542") into every linked binary, it names nothing, and strip -S keeps it.
 */
export function machoStabs(buf) {
  const thin = off => {
    if (off + 32 > buf.length) return null;
    const magic = buf.readUInt32LE(off);
    if (magic !== 0xfeedfacf && magic !== 0xfeedface) return null;
    const wide = magic === 0xfeedfacf;
    const ncmds = buf.readUInt32LE(off + 16);
    let p = off + (wide ? 32 : 28), stabs = 0;
    for (let i = 0; i < ncmds; i++) {
      if (p + 8 > buf.length) return null;
      const cmd = buf.readUInt32LE(p), size = buf.readUInt32LE(p + 4);
      if (size < 8) return null;
      if (cmd === LC_SYMTAB) {
        const symoff = buf.readUInt32LE(p + 8), nsyms = buf.readUInt32LE(p + 12), entry = wide ? 16 : 12;
        for (let s = 0; s < nsyms; s++) {
          const at = off + symoff + s * entry;
          if (at + entry > buf.length) return null;
          if ((buf[at + 4] & N_STAB) && buf[at + 4] !== N_OPT) stabs++;
        }
      }
      p += size;
    }
    return stabs;
  };
  if (buf.length >= 8 && (buf.readUInt32BE(0) === 0xcafebabe || buf.readUInt32BE(0) === 0xcafebabf)) {
    const n = buf.readUInt32BE(4), wide = buf.readUInt32BE(0) === 0xcafebabf;
    if (n < 1 || n > 16) return null;
    let stabs = 0;
    for (let i = 0; i < n; i++) {
      const e = 8 + i * (wide ? 32 : 20);
      if (e + (wide ? 32 : 20) > buf.length) return null;
      const s = thin(wide ? Number(buf.readBigUInt64BE(e + 8)) : buf.readUInt32BE(e + 8));
      if (s === null) return null;
      stabs += s;
    }
    return { slices: n, stabs };
  }
  const s = thin(0);
  return s === null ? null : { slices: 1, stabs: s };
}

const MACHO_MAGIC = new Set([0xcffaedfe, 0xcefaedfe, 0xcafebabe, 0xcafebabf]);
const HOME_PATH = /\/(?:Users|home)\/[^/\0\s]+\//;

/**
 * Every Mach-O file in a macOS app (symlinks not followed): one with debug stabs, or this checkout's
 * own path (buildRoot), fails; so does any absolute home path in our own helpers (Resources, not the
 * third-party modules in app.asar.unpacked, whose CI builders' paths are theirs). Returns the problems.
 */
export function checkMacBinaries(app, { buildRoot = ROOT } = {}) {
  const problems = [];
  const root = buildRoot ? Buffer.from(buildRoot) : null;
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!e.isFile()) continue;
      const head = Buffer.alloc(4);
      const fd = fs.openSync(abs, 'r');
      try { if (fs.readSync(fd, head, 0, 4, 0) < 4 || !MACHO_MAGIC.has(head.readUInt32BE(0))) continue; } finally { fs.closeSync(fd); }
      const buf = fs.readFileSync(abs);
      const info = machoStabs(buf);
      if (!info) continue;
      const rel = path.relative(app, abs).split(path.sep).join('/');
      if (info.stabs) problems.push(`${rel}: ${info.stabs} debug stabs (strip -S -x it before signing)`);
      if (root && buf.includes(root)) problems.push(`${rel}: carries this build's path`);
      const own = rel.startsWith('Contents/Resources/') && !rel.includes('/app.asar.unpacked/');
      if (own && HOME_PATH.test(buf.toString('latin1'))) problems.push(`${rel}: carries an absolute home path`);
    }
  };
  walk(app);
  return problems;
}

const codesign = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });

export function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`), exec = codesign } = {}) {
  const allowUnsigned = argv.includes('--allow-unsigned');
  const apps = argv.filter(a => a !== '--allow-unsigned');
  if (!apps.length || apps.some(a => a.startsWith('-'))) {
    stderr('usage: node tools/check-release.mjs [--allow-unsigned] <NeverQuestAlone.app> …');
    return 2;
  }
  let appEntitlements;
  try { appEntitlements = entitlementsOf(fs.readFileSync(APP_ENTITLEMENTS, 'utf8')); } catch { appEntitlements = null; }
  if (!appEntitlements || !Object.keys(appEntitlements).length) { stderr(`check-release: no entitlements to check the app against in ${path.relative(ROOT, APP_ENTITLEMENTS)}`); return 2; }
  let failed = false;
  let warned = 0;
  for (const app of apps) {
    if (!app.replace(/[\\/]+$/, '').endsWith('.app') || !fs.statSync(app, { throwIfNoEntry: false })?.isDirectory()) {
      stderr(`check-release: not an .app bundle: ${app}`);
      failed = true;
      continue;
    }
    // Named with its folder: a build has three apps of one name (dist/mac-universal, mac-arm64 and mac).
    const label = `${path.basename(path.dirname(path.resolve(app)))}/${path.basename(app)}`;
    let team = null;
    for (const part of signedParts(app)) {
      const name = part === app ? label : `${label}/${path.relative(app, part).split(path.sep).join('/')}`;
      const dv = exec('codesign', ['-dv', '--verbose=2', part]);
      if (dv.error) { stderr(`check-release: codesign didn't run (${dv.error.code || dv.error.message}); it runs on macOS`); return 2; }
      const dr = exec('codesign', ['-d', '-r-', part]);
      const verify = exec('codesign', ['--verify', '--deep', '--strict', part]);
      // The app's own entitlements, and none for a helper app (SR-06); a native module's aren't read.
      const wantEntitlements = part === app ? appEntitlements : part.endsWith('.app') ? {} : undefined;
      const ent = wantEntitlements ? exec('codesign', ['-d', '--entitlements', '-', '--xml', part]) : null;
      const r = checkMacSignature({ codesignDv: `${dv.stdout}${dv.stderr}`, designated: `${dr.stdout}${dr.stderr}`, verifyOk: verify.status === 0, team, entitlements: ent?.stdout ?? '', wantEntitlements });
      if (part === app) team = r.teamId;
      if (r.ok) { stdout(`PASS ${name}: Developer ID, team ${r.teamId}, hardened runtime${wantEntitlements ? `, entitlements: ${entitlementsText(wantEntitlements)}` : ''}`); continue; }
      if (allowUnsigned) { warned++; stderr(`warning: ${name}: ${r.reasons.join('; ')} (allowed: --allow-unsigned, an internal build that never goes to testers)`); continue; }
      stderr(`check-release: ${name}: ${r.reasons.join('; ')}`);
      stdout(`FAIL ${name}`);
      failed = true;
    }
    const binaries = checkMacBinaries(app);
    for (const p of binaries) stderr(`check-release: ${label}/${p}`);
    if (binaries.length) { stdout(`FAIL ${label}: debug maps or build paths in its Mach-O files`); failed = true; }
    else stdout(`PASS ${label}: no debug stabs or build paths in its Mach-O files`);
  }
  stdout(failed ? 'FAIL: not a release build (PRD PF-3, §22 Q2). Sign it with the Developer ID (CSC_LINK) and the hardened runtime, from a helper build-app.sh stripped.'
    : warned ? `PASS with --allow-unsigned only: ${warned} pieces of code aren't signed as a release must be (the warnings above), so this is an internal build, never for testers.`
      : 'PASS: every piece of signed code is Developer ID with the hardened runtime.');
  return failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
