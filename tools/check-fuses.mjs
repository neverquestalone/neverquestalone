#!/usr/bin/env node
// The Electron fuse check for release builds (PRD §11.2 and SC-9; release.yml
// runs it on every OS). The macOS Keychain promise depends on the packaged app
// not being usable as plain Node or with a debugger attached, so a build whose
// fuses aren't flipped must fail, not just print them.
//
// It reads the fuse wire the way @electron/fuses writes it: a 32-byte sentinel,
// a version byte (1), a length byte, then one byte per fuse ('0' off, '1' on,
// 'r' removed), in FuseV1Options order. It reads every copy of the wire in a
// file, so both slices of a universal macOS binary are checked (the
// @electron/fuses "read" command shows only the first). No dependencies.
//
// The one fuse checker (systems plan Batch 6): it asserts the app's whole plan,
// app/desktop/scripts/fuses.cjs FUSE_PLAN (what afterPack flips: PRD §11.2's
// list plus cookie encryption), and fails if that plan ever asks for less than
// the PRD (REQUIRED).
//
//   node tools/check-fuses.mjs <path> [<path> …]
//     <path>  an .app bundle (its Electron Framework binary is read), an
//             Electron binary, or an unpacked folder (win-unpacked,
//             linux-unpacked: every top-level file carrying the wire is read)
//   exit 0 every wire as required · 1 a fuse differs, or no wire found · 2 usage
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
export const FUSES = ['RunAsNode', 'EnableCookieEncryption', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments',
  'EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar', 'LoadBrowserProcessSpecificV8Snapshot', 'GrantFileProtocolExtraPrivileges', 'WasmTrapHandlers'];
const STATES = { 0x30: 'off', 0x31: 'on', 0x72: 'removed', 0x90: 'inherit' };

// PRD §11.2: runAsNode, nodeOptions and nodeCliInspect off; onlyLoadAppFromAsar
// and embeddedAsarIntegrityValidation on. And grantFileProtocolExtraPrivileges
// off: the app's page comes from its own scheme (nqa://app/), never file:, so
// a build with it back on is a regression this gate catches (C3 review).
export const REQUIRED = {
  RunAsNode: 'off',
  EnableNodeOptionsEnvironmentVariable: 'off',
  EnableNodeCliInspectArguments: 'off',
  EnableEmbeddedAsarIntegrityValidation: 'on',
  OnlyLoadAppFromAsar: 'on',
  GrantFileProtocolExtraPrivileges: 'off',
};

// FUSE_PLAN as the wire states it: { name: 'on'|'off' }. What run() asserts.
const { FUSE_PLAN } = createRequire(import.meta.url)(path.join(HERE, '..', 'app', 'desktop', 'scripts', 'fuses.cjs'));
export const PLANNED = Object.freeze(Object.fromEntries(Object.entries(FUSE_PLAN).map(([k, v]) => [k, v ? 'on' : 'off'])));

// The plan never asks for less than the PRD: every REQUIRED fuse, in the same state.
export function planCoversPrd(planned = PLANNED, prd = REQUIRED) {
  return Object.entries(prd).filter(([k, v]) => planned[k] !== v).map(([k, v]) => `${k}: the plan says ${planned[k] ?? 'nothing'}, the PRD ${v}`);
}

// Every fuse wire in a buffer: [{ offset, version, fuses: { name: state } }].
export function readWires(buf) {
  const wires = [];
  for (let at = buf.indexOf(SENTINEL); at >= 0; at = buf.indexOf(SENTINEL, at + 1)) {
    const p = at + SENTINEL.length;
    const version = buf[p], length = buf[p + 1] ?? 0;
    const fuses = {};
    for (let i = 0; i < length && p + 2 + i < buf.length; i++) {
      fuses[FUSES[i] ?? `fuse${i}`] = STATES[buf[p + 2 + i]] ?? `0x${buf[p + 2 + i].toString(16)}`;
    }
    wires.push({ offset: at, version, fuses });
  }
  return wires;
}

// The problems with a file's wires; empty when every wire is as required.
export function checkWires(wires, required = REQUIRED) {
  if (!wires.length) return ['no fuse wire found (not an Electron binary, or Electron older than 12)'];
  const problems = [];
  wires.forEach((w, i) => {
    const which = wires.length > 1 ? `wire ${i + 1} of ${wires.length}` : 'wire';
    if (w.version !== 1) { problems.push(`${which}: version ${w.version}, expected 1`); return; }
    for (const [name, want] of Object.entries(required)) {
      const got = w.fuses[name] ?? 'missing';
      if (got !== want) problems.push(`${which}: ${name} is ${got}, expected ${want}`);
    }
  });
  if (wires.length > 2) problems.push(`${wires.length} fuse wires; at most 2 are expected (one per slice of a universal binary)`);
  return problems;
}

// Electron's stock default_app.asar in a packed app's Resources (afterPack drops it; the audit's
// cross-lens note for the release lane, W(d)): the file, or null when it isn't there or the path
// isn't a packed app (an .app bundle, or an unpacked folder with resources/).
export function defaultAppIn(p) {
  const clean = p.replace(/[\\/]+$/, '');
  const resources = clean.endsWith('.app') ? path.join(clean, 'Contents', 'Resources') : path.join(clean, 'resources');
  const file = path.join(resources, 'default_app.asar');
  return fs.existsSync(file) ? file : null;
}

// The files a path stands for, as @electron/fuses resolves them.
export function fuseFiles(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) throw new Error(`not found: ${p}`);
  if (p.replace(/[\\/]+$/, '').endsWith('.app')) return [path.join(p, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')];
  if (/\.app[\\/]Contents[\\/]MacOS[\\/]/.test(p)) return [path.resolve(p, '..', '..', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')];
  if (!st.isDirectory()) return [p];
  const found = fs.readdirSync(p, { withFileTypes: true }).filter(e => e.isFile()).map(e => path.join(p, e.name))
    .filter(f => fs.readFileSync(f).includes(SENTINEL)).sort();
  if (!found.length) throw new Error(`no file in ${p} carries a fuse wire`);
  return found;
}

export function run(argv, { stdout = s => process.stdout.write(s + '\n'), stderr = s => process.stderr.write(s + '\n'), planned = PLANNED } = {}) {
  if (!argv.length || argv.some(a => a.startsWith('-'))) { stderr('usage: node tools/check-fuses.mjs <app.app | electron binary | unpacked folder> …'); return 2; }
  let failed = false;
  for (const gap of planCoversPrd(planned)) { stderr(`check-fuses: ${gap}`); failed = true; }
  for (const target of argv) {
    const stock = defaultAppIn(target);
    if (stock) { stderr(`check-fuses: ${stock}: Electron's default app ships (scripts/fuses.cjs drops it after packing)`); failed = true; }
    let files;
    try { files = fuseFiles(target); } catch (e) { stderr(`check-fuses: ${e.message}`); failed = true; continue; }
    for (const f of files) {
      let buf;
      try { buf = fs.readFileSync(f); } catch (e) { stderr(`check-fuses: can't read ${f}: ${e.code || e.message}`); failed = true; continue; }
      const wires = readWires(buf);
      const problems = checkWires(wires, planned);
      for (const w of wires) stdout(`${f} @0x${w.offset.toString(16)}: ${Object.keys(planned).map(n => `${n}=${w.fuses[n] ?? 'missing'}`).join(' ')}`);
      if (problems.length) { failed = true; for (const p of problems) stderr(`check-fuses: ${f}: ${p}`); }
    }
  }
  stdout(failed ? 'FAIL: the fuses are not as app/desktop/scripts/fuses.cjs plans (PRD §11.2 and cookie encryption).'
    : `PASS: every fuse wire is as planned (${Object.keys(planned).length} fuses, PRD §11.2's six hardened).`);
  return failed ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
