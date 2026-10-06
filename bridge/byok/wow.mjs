// The game on this computer (public BYOK PRD §11.1 "WoW discovery", §11.4, §16.1 step 2, PF-5,
// TH12): find World of Warcraft: Forever, tell whether it's running, and install the addon, the
// 200 slot folders and the doorbells, only while it isn't.
//
//   findWow({ platform, env, home, roots, run, fs }) → [{ flavorDir, flavor, root, version?, iface?, account? }]
//       the Forever flavors the addon's TOC targets (addon/NeverQuestAlone/*.toc ## Interface), best first; a
//       client a patch moved to a newer line is still found (clientFits)
//   clientInterface(flavorDir, { platform, run, plist }) → { iface, version, from } | null
//       the game's interface number as its install says it (.build.info; on macOS the app's Info.plist)
//   installedInterfaces(addonsDir) → { addon, slot }: the Interface lines of the installed TOCs
//   retargetAddon({ addonsDir, iface }) → { changed, kept, errors, error? }
//       patch day (systems critic SY-29): the installed TOCs' Interface line set to the game's number
//   wowRunning({ platform, flavorDir, run }) → { running, pids }
//   checkAddonsPermissions(addonsDir, { platform, run, tighten }) → { ok, worldWritable, paths, fixed, fixable, detail }
//       POSIX: the install's root and flavor folder, Interface/, AddOns/, and every folder and file of
//       the addon's own (NeverQuestAlone, NQA_Data, NQA_S###)
//   installAddon({ flavorDir, platform, run, addonSource, slots, tighten, configFile })
//       → { ok, steps, restartNeeded, permissions, iface, partsFold? } | { ok: false, error, detail }
//       never writes through a link another account planted in AddOns (TH12): a link, or another
//       account's folder, in the addon's place is removed first, and files are created O_EXCL; with
//       configFile, folds the parts' row in the game's AddOns list once per install (C-119)
//   recordAddonFolder({ userData, flavorDir, platform }) → boolean
//       Windows: lists the flavor folder in <userData>/uninstall.ini, which the NSIS uninstaller reads
//       to remove the addon, its slot folders and its saved chat history (audit CV-07)
// Where the game is looked for:
//   macOS    /Applications and ~/Applications (World of Warcraft/)
//   Windows  Program Files (x86), Program Files, upstream wow-ai's other roots, the install path
//            Blizzard's registry key names, and the paths Battle.net's product.db lists
//   Linux    Wine prefixes: $WINEPREFIX, ~/.wine, Lutris (~/Games/*), Bottles
// A flavor folder's version comes from the install's .build.info (every OS) or, on macOS, the
// client app's Info.plist. Commands run with an argument list, never a shell string, and nothing
// built from a path is ever a pattern a shell sees.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installSlots, countSlots, foldPartsOnce, SLOT_COUNT } from '../transport/slots.mjs';
import { BELLS, signalPaths } from '../transport/signals.mjs';
import { createRetrier, renameWithRetry, writeFileWithRetry } from '../transport/fsretry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ADDON_SOURCE = path.resolve(HERE, '..', '..', 'addon', 'NeverQuestAlone');
export const ADDON_NAME = 'NeverQuestAlone';
/** The data addon's folder (reserved; none ships yet): the uninstall record and the permission walk know it. */
export const DATA_NAME = 'NQA_Data';
/** Flavor folders a Forever client installs under, best first. The Windows capture helper takes a
 * window for the game's only when its exe is in one of these (boot passes them; display DR-05). */
export const FOREVER_FLAVORS = Object.freeze(['_forever_', '_classic_beta_']);
/** Exes in a flavor folder that aren't the game: the voice proxy and the crash reporter (a stem an
 * image name holds, any case). The process list and the capture helper refuse them (SY-05). */
export const NOT_GAME = Object.freeze(['VoiceProxy', 'Error']);
export const RESTART_LINE = 'New addon files only load after a full restart of World of Warcraft, not /reload.';
export const RUNNING_LINE = `Quit World of Warcraft completely first (not just log out). ${RESTART_LINE}`;

const pathFor = platform => (platform === 'win32' ? path.win32 : path.posix);

/**
 * A Windows system tool by its full path (System32): a bare name is looked up in the working
 * folder before PATH, so a tasklist.exe in Downloads would run on every status poll (final review
 * L3-7).
 */
export function windowsTool(name, env = process.env) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', `${name}.exe`);
}
const isDir = (f, p) => { try { return f.statSync(p).isDirectory(); } catch { return false; } };
const list = (f, p) => { try { return f.readdirSync(p); } catch { return []; } };
const reEscape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The interface number the addon's TOC declares ('16001'), or null. */
export function addonInterface(addonDir = ADDON_SOURCE, f = fs) {
  const toc = list(f, addonDir).find(n => n.endsWith('.toc'));
  if (!toc) return null;
  try { return (/^## Interface:\s*(\d+)/m.exec(f.readFileSync(path.join(addonDir, toc), 'utf8')) || [])[1] ?? null; } catch { return null; }
}

/** 1.60.1 → '16001'. */
export function interfaceFromVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? String(Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3])) : null;
}

/** The same client line (major.minor): the slots are rewritten for the patch, the addon loads. */
export const sameLine = (a, b) => !!a && !!b && Math.floor(Number(a) / 100) === Math.floor(Number(b) / 100);

/**
 * Is a client at interface `iface` one the addon is for, in the flavor folder `flavor` (systems
 * critic SY-29)? The same major version as the addon's TOC (Forever is 1.x). In _forever_ any line
 * of it: a newer line is patch day, and the app retargets the TOCs to it (retargetAddon); an older
 * one is a game that hasn't taken the update an app release already targets. Elsewhere
 * (_classic_beta_, where other games' betas live too) only the TOC's line or a newer one.
 */
export function clientFits(iface, tocIface, flavor = '_forever_') {
  const a = Number(iface), b = Number(tocIface);
  if (!Number.isInteger(a) || !Number.isInteger(b) || Math.floor(a / 10000) !== Math.floor(b / 10000)) return false;
  return flavor === '_forever_' || Math.floor(a / 100) >= Math.floor(b / 100);
}

/**
 * .build.info (Blizzard's pipe table at the install root) → { '<flavor>': version }. The product
 * code names the flavor folder: wow_classic_beta → _classic_beta_, wow_forever → _forever_.
 */
export function parseBuildInfo(text) {
  const lines = String(text || '').split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return {};
  const cols = lines[0].split('|').map(c => c.split('!')[0].trim());
  const iv = cols.indexOf('Version');
  const ip = cols.indexOf('Product');
  if (iv < 0 || ip < 0) return {};
  const out = {};
  for (const l of lines.slice(1)) {
    const v = l.split('|');
    const product = String(v[ip] || '').trim();
    const version = String(v[iv] || '').trim();
    if (!/^wow[a-z_]*$/.test(product) || !version) continue;
    const flavor = `_${product.replace(/^wow_?/, '')}_`;
    if (flavor !== '__') out[flavor] = version;
  }
  return out;
}

/** The client app's version on macOS (CFBundleShortVersionString). */
function macAppVersion(flavorDir, { run, f }) {
  for (const a of list(f, flavorDir).filter(n => n.endsWith('.app') && /World of Warcraft/.test(n))) {
    const r = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(flavorDir, a, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 });
    const v = String(r?.stdout || '').trim();
    if (interfaceFromVersion(v)) return v;
  }
  return null;
}

/** Install roots that Battle.net's product.db names (a protobuf; its strings are plain UTF-8). */
export function productDbRoots(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('latin1') : String(buf || '');
  const out = new Set();
  for (const m of text.matchAll(/[A-Za-z]:[\\/][\x20-\x7e]{0,200}?World of Warcraft/g)) out.add(m[0].replace(/\//g, '\\'));
  return [...out];
}

/** Install roots Blizzard's registry key names (reg.exe query, an argument list). */
function registryRoots(run, env = process.env) {
  const out = [];
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Blizzard Entertainment\\World of Warcraft', 'HKLM\\SOFTWARE\\Blizzard Entertainment\\World of Warcraft']) {
    const r = run(windowsTool('reg', env), ['query', key, '/v', 'InstallPath'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const m = /InstallPath\s+REG_SZ\s+(.+)$/m.exec(String(r?.stdout || ''));
    if (m) out.push(m[1].trim().replace(/[\\/]+$/, '').replace(/[\\/]_[a-z_]+_$/i, ''));
  }
  return out;
}

/** Where a WoW install may be (the folder that holds _forever_ / _classic_beta_), in order. */
export function wowRoots({ platform = process.platform, env = process.env, home = os.homedir(), run = spawnSync, f = fs } = {}) {
  const p = pathFor(platform);
  const roots = [];
  if (platform === 'darwin') {
    roots.push('/Applications/World of Warcraft', p.join(home, 'Applications', 'World of Warcraft'));
  } else if (platform === 'win32') {
    for (const r of [env['ProgramFiles(x86)'], env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files', 'D:\\', 'E:\\', 'D:\\Games', 'E:\\Games', 'C:\\Games']) {
      if (r) roots.push(p.join(r, 'World of Warcraft'));
    }
    roots.push(...registryRoots(run, env));
    const programData = env.ProgramData || 'C:\\ProgramData';
    try { roots.push(...productDbRoots(f.readFileSync(p.join(programData, 'Battle.net', 'Agent', 'product.db')))); } catch { /* no Battle.net here */ }
  } else {
    const prefixes = [env.WINEPREFIX, p.join(home, '.wine'), p.join(home, 'Games', 'battlenet'), p.join(home, 'Games', 'world-of-warcraft')];
    for (const g of list(f, p.join(home, 'Games'))) prefixes.push(p.join(home, 'Games', g));
    const bottles = p.join(home, '.local', 'share', 'bottles', 'bottles');
    for (const b of list(f, bottles)) prefixes.push(p.join(bottles, b));
    for (const pre of prefixes.filter(Boolean)) {
      for (const pf of ['Program Files (x86)', 'Program Files']) roots.push(p.join(pre, 'drive_c', pf, 'World of Warcraft'));
    }
  }
  return [...new Set(roots)];
}

/** Does this folder hold a game client (a Wow*.exe, a World of Warcraft app, or its Interface folder)? */
function isClient(f, dir) {
  if (!isDir(f, dir)) return false;
  const names = list(f, dir);
  return names.some(n => /^Wow.*\.exe$/i.test(n) || (/World of Warcraft/.test(n) && n.endsWith('.app'))) || isDir(f, path.join(dir, 'Interface'));
}

/** The one WoW account folder under WTF/Account, or null. */
export function accountOf(flavorDir, f = fs) {
  const dir = path.join(flavorDir, 'WTF', 'Account');
  const names = list(f, dir).filter(n => !n.startsWith('.') && n !== 'SavedVariables' && isDir(f, path.join(dir, n)));
  return names.length === 1 ? names[0] : null;
}

/** The Forever installs on this computer, best first; [] when there's none. */
export function findWow({ platform = process.platform, env = process.env, home = os.homedir(), roots = null, run = spawnSync, f = fs, tocInterface = addonInterface(ADDON_SOURCE, f) } = {}) {
  // Folders on this computer's disk: joined by its own path rules (as isClient, accountOf and
  // macAppVersion join them), whichever platform's usual roots were asked for.
  const out = [];
  for (const root of roots ?? wowRoots({ platform, env, home, run, f })) {
    let builds = {};
    try { builds = parseBuildInfo(f.readFileSync(path.join(root, '.build.info'), 'utf8')); } catch { /* none */ }
    for (const flavor of FOREVER_FLAVORS) {
      const flavorDir = path.join(root, flavor);
      if (!isClient(f, flavorDir)) continue;
      const version = builds[flavor] ?? (platform === 'darwin' ? macAppVersion(flavorDir, { run, f }) : null);
      const iface = interfaceFromVersion(version);
      // A client of another game (another major version, or an older line in _classic_beta_) isn't
      // Forever. A patch's newer line is (SY-29): the app retargets the TOCs to it.
      if (iface && tocInterface && !clientFits(iface, tocInterface, flavor)) continue;
      const account = accountOf(flavorDir, f);
      out.push({ flavorDir, flavor, root, ...(version ? { version } : {}), ...(iface ? { iface } : {}), ...(account ? { account } : {}) });
    }
  }
  // Seen game data (an account folder) first, then a known version, then the flavor order.
  const rank = w => (w.account ? 0 : 2) + (w.version ? 0 : 1);
  return out.map((w, i) => ({ w, i })).sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i).map(x => x.w);
}

/**
 * The game's interface number for a flavor folder, as its install says it: the install's .build.info
 * (every OS; Battle.net rewrites it when an update lands), else on macOS, when `plist`, the client
 * app's Info.plist (a PlistBuddy run). → { iface, version, from: 'build.info' | 'app' } | null
 */
export function clientInterface(flavorDir, { platform = process.platform, run = spawnSync, f = fs, plist = true } = {}) {
  const p = pathFor(platform);
  if (typeof flavorDir !== 'string' || !flavorDir) return null;
  let version = null;
  let from = null;
  try {
    version = parseBuildInfo(f.readFileSync(p.join(p.dirname(flavorDir), '.build.info'), 'utf8'))[p.basename(flavorDir)] ?? null;
    if (version) from = 'build.info';
  } catch { /* none */ }
  if (!interfaceFromVersion(version) && plist && platform === 'darwin') {
    version = macAppVersion(flavorDir, { run, f });
    from = version ? 'app' : null;
  }
  const iface = interfaceFromVersion(version);
  return iface ? { iface, version, from } : null;
}

// A TOC's Interface line (its value may list several numbers; ours name one). CRLF-safe.
const IFACE_LINE = /^##[ \t]*Interface[ \t]*:[ \t]*([^\r\n]*?)[ \t]*(?=\r?$)/m;
const tocFile = (addonsDir, name) => path.join(addonsDir, name, `${name}.toc`);

/** The Interface lines of the installed addon's TOC and of its first slot's (as written), or null each. */
export function installedInterfaces(addonsDir, f = fs) {
  const read = (file) => { try { return IFACE_LINE.exec(f.readFileSync(file, 'utf8'))?.[1] ?? null; } catch { return null; } };
  return { addon: read(tocFile(addonsDir, ADDON_NAME)), slot: read(tocFile(addonsDir, 'NQA_S001')) };
}

/**
 * Patch day (systems critic SY-29): World of Warcraft moved past the interface number the installed
 * TOCs name, and the game won't load an addon it calls out of date. This sets the Interface line of
 * the addon's own TOC and of every slot TOC to the game's number, and changes nothing else in them;
 * the game reads them at its next start. As the install does (TH12), nothing is written through a
 * link or into anything but a regular file in a real folder of this account's: each TOC is written
 * to a temp file (O_EXCL) and renamed over it, with Windows' sharing violations retried (fsretry).
 * → { changed, kept, errors, error? } (error: the first failure's code)
 */
export function retargetAddon({ addonsDir, iface, uid = process.getuid?.() } = {}) {
  if (typeof addonsDir !== 'string' || !/^\d{5,6}$/.test(String(iface ?? ''))) return { changed: 0, kept: 0, errors: 1, error: 'bad_input' };
  let names = [];
  try { names = fs.readdirSync(addonsDir); } catch { /* none */ }
  const files = [tocFile(addonsDir, ADDON_NAME), ...names.filter(n => /^NQA_S\d{3}$/.test(n)).sort().map(n => tocFile(addonsDir, n))];
  const mine = st => uid === undefined || st.uid === uid;
  const fail = code => Object.assign(new Error(code), { code });
  const retry = createRetrier();
  let changed = 0, kept = 0, errors = 0, error = null;
  for (const file of files) {
    try {
      const dir = fs.lstatSync(path.dirname(file));
      if (!dir.isDirectory() || !mine(dir)) throw fail('not_a_folder');
      const st = fs.lstatSync(file);
      if (!st.isFile() || !mine(st)) throw fail('not_a_file');
      const text = fs.readFileSync(file, 'utf8');
      if (!IFACE_LINE.test(text)) throw fail('no_interface_line');
      const next = text.replace(IFACE_LINE, `## Interface: ${iface}`);
      if (next === text) { kept += 1; continue; }
      const tmp = `${file}.${process.pid}.tmp`;
      try { fs.rmSync(tmp, { force: true }); } catch { /* the O_EXCL write says */ }
      writeFileWithRetry(retry, tmp, next, { flag: 'wx' });
      try { renameWithRetry(retry, tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } throw e; }
      changed += 1;
    } catch (e) {
      errors += 1;
      error ??= e.code || 'failed';
    }
  }
  return { changed, kept, errors, ...(error ? { error } : {}) };
}

/** Wow*.exe image names, the -64 and -ARM64 builds too. */
const WIN_IMAGE = /^Wow[A-Za-z]*(?:-64|-ARM64)?\.exe$/i;
/** tasklist gives names, no paths: WowUp (an addon manager named Wow*) and NOT_GAME are refused by
 * name. The capture helper's own game pid, when it has one, comes first (app-api wowRunningNow). */
const NOT_GAME_IMAGE = new RegExp(['WowUp', ...NOT_GAME].map(reEscape).join('|'), 'i');
export function parseTasklist(csv) {
  const pids = [];
  for (const line of String(csv || '').split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && WIN_IMAGE.test(m[1]) && !NOT_GAME_IMAGE.test(m[1])) pids.push(Number(m[2]));
  }
  return pids;
}

/** Is the game running (this flavor's, when flavorDir is given)? pgrep / tasklist, argument lists only. */
export function wowRunning({ platform = process.platform, flavorDir = null, run = spawnSync, env = process.env } = {}) {
  let pids = [];
  if (platform === 'win32') {
    const r = run(windowsTool('tasklist', env), ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    pids = parseTasklist(r?.stdout);
  } else {
    const pattern = platform === 'darwin'
      ? (flavorDir ? `${reEscape(flavorDir)}/.*World of Warcraf[t]` : 'World of Warcraft[^/]*\\.app/Contents/MacOS/')
      : 'Wow[A-Za-z]*(-64)?\\.exe';
    const r = run('pgrep', ['-f', pattern], { encoding: 'utf8', timeout: 5000 });
    if (r?.status === 0) pids = String(r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n !== process.pid);
  }
  return { running: pids.length > 0, pids };
}

/**
 * wowRunning off the main thread's clock: the same check through async execFile (tasklist, pgrep),
 * so a slow process list never blocks Electron's main thread (systems plan SY-07). A given `run`
 * (a spawnSync stand-in, in tests) is used as it is. → Promise<{running, pids}>
 */
export function wowRunningAsync({ platform = process.platform, flavorDir = null, run = null, env = process.env, exec = execFile } = {}) {
  if (run) return Promise.resolve(wowRunning({ platform, flavorDir, run, env }));
  const [cmd, args, opts] = platform === 'win32'
    ? [windowsTool('tasklist', env), ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true }]
    : ['pgrep', ['-f', platform === 'darwin' ? (flavorDir ? `${reEscape(flavorDir)}/.*World of Warcraf[t]` : 'World of Warcraft[^/]*\\.app/Contents/MacOS/') : 'Wow[A-Za-z]*(-64)?\\.exe'], { encoding: 'utf8', timeout: 5000 }];
  return new Promise((resolve) => {
    exec(cmd, args, opts, (err, stdout) => {
      // pgrep exits 1 when nothing matches: that's "not running", as is a tool that failed.
      const out = platform === 'win32' ? (err ? '' : stdout) : (err && err.code !== 1 ? '' : stdout);
      const pids = platform === 'win32' ? parseTasklist(out)
        : String(out || '').split(/\s+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n !== process.pid);
      resolve({ running: pids.length > 0, pids });
    });
  });
}

// icacls lines: "C:\...\AddOns BUILTIN\Users:(OI)(CI)(F)". A write-capable grant to a group every
// account is in means another Windows account can write addon code the game will run (TH12).
const BROAD_GRANT = /(Everyone|(?:BUILTIN\\)?Users|(?:NT AUTHORITY\\)?Authenticated Users|(?:NT AUTHORITY\\)?INTERACTIVE):((?:\([A-Z,]+\))+)\s*$/i;
const WRITE_RIGHTS = /\((?:[A-Z]+,)*(?:F|M|W|WD|AD|GA|GW)(?:,[A-Z]+)*\)/;
export function broadWritersFromIcacls(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = BROAD_GRANT.exec(line.trimEnd());
    if (m && WRITE_RIGHTS.test(m[2])) out.push(`${m[1]}:${m[2]}`);
  }
  return out;
}

/** The addon's own folders in AddOns: NeverQuestAlone, NQA_Data and the slot folders. */
export const isAddonFolder = name => name === ADDON_NAME || name === DATA_NAME || /^NQA_S\d{3}$/.test(name);
const MAX_WALK = 5000;

/** Every folder and file of the addon's own under addonsDir (links listed, never followed). */
function addonEntries(f, p, addonsDir) {
  const out = [];
  const walk = (d) => {
    if (out.length >= MAX_WALK) return;
    out.push(d);
    let st;
    try { st = f.lstatSync(d); } catch { return; }
    if (st.isDirectory()) for (const n of list(f, d)) walk(p.join(d, n));
  };
  for (const n of list(f, addonsDir).filter(isAddonFolder).sort()) walk(p.join(addonsDir, n));
  return out;
}

/**
 * TH12: can another account on this computer change what the game loads from AddOns (and so run
 * addon code in the player's client)? POSIX, every folder on the way and everything the addon is:
 *   - the install's root and the flavor folder: group- or world-writable without the sticky bit
 *     (another account could move Interface/ aside and put its own there);
 *   - Interface/ and AddOns/: group- or world-writable (a new folder there is a new addon);
 *   - the addon's own folders and files (NeverQuestAlone, NQA_Data, NQA_S###, walked): group- or
 *     world-writable, a link, or another account's.
 * `tighten` removes the group and world write bits on the ones this account owns (never a link).
 * Windows: a write grant to Everyone, Users or Authenticated Users on AddOns; reported only
 * (fixing an inherited ACL under Program Files takes an admin).
 */
export function checkAddonsPermissions(addonsDir, { platform = process.platform, run = spawnSync, tighten = false, f = fs, uid = process.getuid?.(), env = process.env } = {}) {
  const p = pathFor(platform);
  if (platform === 'win32') {
    const r = run(windowsTool('icacls', env), [addonsDir], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r?.status !== 0) return { ok: null, worldWritable: null, paths: [], fixed: [], fixable: false, detail: 'Couldn’t read the AddOns folder’s permissions.' };
    const broad = broadWritersFromIcacls(r.stdout);
    return {
      ok: broad.length === 0, worldWritable: broad.length > 0, paths: broad.length ? [addonsDir] : [], grants: broad, fixed: [], fixable: false,
      detail: broad.length ? 'Every account on this PC can change the AddOns folder, so another account could run addon code in your game.' : '',
    };
  }
  const iface = p.dirname(addonsDir);
  const flavor = p.dirname(iface);
  const targets = [
    ...[p.dirname(flavor), flavor].map(d => ({ path: d, kind: 'parent' })),
    ...[iface, addonsDir].map(d => ({ path: d, kind: 'tree' })),
    ...addonEntries(f, p, addonsDir).map(d => ({ path: d, kind: 'addon' })),
  ];
  const loose = [];
  const fixed = [];
  let fixable = true;
  for (const t of targets) {
    let st;
    try { st = t.kind === 'addon' ? f.lstatSync(t.path) : f.statSync(t.path); } catch { continue; }
    if (t.kind !== 'addon' && !st.isDirectory()) continue;
    const link = st.isSymbolicLink();
    const mine = uid === undefined || st.uid === uid;
    const other = t.kind === 'addon' && !mine;
    const writable = !link && !!(st.mode & 0o022) && !(t.kind === 'parent' && (st.mode & 0o1000));
    if (!link && !other && !writable) continue;
    if (writable && !other && tighten && mine) {
      try { f.chmodSync(t.path, st.mode & 0o7755); fixed.push(t.path); continue; } catch { /* fall through: still loose */ }
    }
    if (link || other || !mine) fixable = false;
    loose.push({ path: t.path, world: link || (writable && !!(st.mode & 0o002)), group: writable && !!(st.mode & 0o020), link, other });
  }
  const world = loose.some(l => l.world);
  const shown = loose.slice(0, 3).map(l => l.path);
  const more = loose.length - shown.length;
  return {
    ok: loose.length === 0, worldWritable: world, groupWritable: loose.some(l => l.group), paths: loose.map(l => l.path), fixed, fixable: loose.length > 0 && fixable,
    ...(loose.some(l => l.link) ? { links: loose.filter(l => l.link).map(l => l.path) } : {}),
    // The player's computer by its name: this Mac, this computer elsewhere (STYLE §2.1; UX-W41).
    detail: loose.length ? `${world ? 'Every account' : 'Other accounts'} on this ${platform === 'darwin' ? 'Mac' : 'computer'} can change ${shown.join(' and ')}${more ? ` and ${more} more` : ''}, so they could run addon code in your game.` : '',
  };
}

// Paths in AddOns another account may have planted something at (TH12): a link, a file where a
// folder goes, or another account's folder is removed (a link itself, never what it points to),
// and files are created with O_EXCL, so a link planted after the check fails the write instead
// of being followed.
function ownDir(f, dir, uid) {
  let st = null;
  try { st = f.lstatSync(dir); } catch { /* none */ }
  if (st && (!st.isDirectory() || (uid !== undefined && st.uid !== uid))) { f.rmSync(dir, { recursive: true, force: true }); st = null; }
  if (!st) f.mkdirSync(dir);
}
function freshFile(f, file, data) {
  let st = null;
  try { st = f.lstatSync(file); } catch { /* none */ }
  if (st) f.rmSync(file, { recursive: true, force: true });
  f.writeFileSync(file, data, { flag: 'wx' });
}
const isRegular = (f, p) => { try { return f.lstatSync(p).isFile(); } catch { return false; } };

// The addon's TOC as the app installs it (the consolidation plan's R3; PRD "Internal identifiers
// stay": the folder, the file names and the SavedVariables keep theirs): the product's Title and
// Notes, whatever the copy it came from says. They are the repo's TOC's since main 0.5.3 (C-120,
// C-124; tests/byok/wow_locate_test.mjs holds them equal), so an install's TOC is the repo's, line
// for line: the AddOns list, the Settings category and every other way in say NeverQuestAlone. The
// addon reads nothing from its TOC but its version: one build, with /nqa and the product's words from
// the first frame whatever made the copy. (Until 2026-09-29 the stamp also added "## X-Backend:
// byok", which only the two-build addon read; a copy that has it loses it here.) The slot TOCs are
// slots.mjs's slotToc, the same for every install ("NeverQuestAlone Part NNN" under one folded
// "NeverQuestAlone Parts" row, E-047). At install, both carry the game's own interface number (SY-29): stampToc's iface
// for the addon's TOC, slotToc's for the slots, so each TOC is written once, words and number
// together; patch day's retargetAddon then changes only that number.
export const PUBLIC_TITLE = 'NeverQuestAlone';
// The AddOns list's tooltip: a short bullet list of what it does (maintainer; main c9599b5). |n is the
// TOC's line break.
export const PUBLIC_NOTES = '• Ask anything, right in the game|n• Quest help, routes and gear advice|n• Your route drawn on the map|n• Quality-of-life helpers you turn on|n• Any AI, with or without the free NeverQuestAlone app';
export function stampToc(text, { iface = null } = {}) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let titled = false;
  for (const l of lines) {
    if (/^##\s*X-Backend\s*:/i.test(l)) continue; // an earlier build's mark, read by the two-build addon only
    if (/^##\s*Title\s*:/i.test(l)) { out.push(`## Title: ${PUBLIC_TITLE}`); titled = true; continue; }
    if (/^##\s*Notes\s*:/i.test(l)) { out.push(`## Notes: ${PUBLIC_NOTES}`); continue; }
    // The install writes the game's own interface number (SY-29), so a newer client loads it too.
    if (iface && /^##\s*Interface\s*:/i.test(l)) { out.push(`## Interface: ${iface}`); continue; }
    out.push(l);
  }
  if (!titled) out.unshift(`## Title: ${PUBLIC_TITLE}`);
  return out.join('\n');
}

// Copy the addon's own files; keep sig/ (live doorbells) and a bridge-written Inbox.lua. Plain
// reads and writes, so it works from inside the app's asar too. The addon's own TOC is stamped
// (stampToc, with the game's interface number) under the same exclusive write.
function copyAddon(f, src, dst, uid, iface = null) {
  ownDir(f, dst, uid);
  let files = 0;
  for (const e of f.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'sig' || (e.name === 'Inbox.lua' && isRegular(f, path.join(dst, 'Inbox.lua')))) continue;
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) {
      f.rmSync(to, { recursive: true, force: true });
      files += copyAddon(f, from, to, uid);
    } else if (e.isFile()) {
      const toc = e.name === `${ADDON_NAME}.toc` && path.basename(dst) === ADDON_NAME;
      freshFile(f, to, toc ? stampToc(f.readFileSync(from, 'utf8'), { iface }) : f.readFileSync(from));
      files += 1;
    }
  }
  return files;
}

/**
 * Install the addon, the slot pool and the doorbells into flavorDir's AddOns folder (PF-5), only
 * while the game is closed, then check every file. Every TOC, the addon's and the slots', carries
 * the client's interface number when its install names one the addon fits (clientFits: a newer line
 * too, SY-29), else the addon TOC's own. With configFile (the app's config.json), the parts' row
 * in the game's AddOns list is folded once per install, before the game's first start,
 * once per install (slots.mjs foldPartsOnce, C-119): the result's partsFold says
 * what it did ('folded', 'kept', 'done before', 'running', 'unreadable', 'config unreadable' or
 * 'failed'). It never fails the install: where it didn't fold, the addon folds the row at its
 * first logout (Settings.lua P.FoldParts). running: true or false (asked already), a function
 * asked at each check, or null (this asks the system each time).
 */
export function installAddon({ flavorDir, platform = process.platform, run = spawnSync, addonSource = ADDON_SOURCE, slots = SLOT_COUNT, tighten = false, f = fs, version = null, running = null, uid = process.getuid?.(), configFile = null } = {}) {
  const p = pathFor(platform);
  if (typeof flavorDir !== 'string' || !p.isAbsolute(flavorDir) || !isDir(f, flavorDir)) return { ok: false, error: 'wow_not_found', detail: 'That folder doesn’t have World of Warcraft in it.' };
  const gameRunning = () => (typeof running === 'function' ? !!running() : (running ?? wowRunning({ platform, flavorDir, run }).running));
  if (gameRunning()) return { ok: false, error: 'wow_running', detail: RUNNING_LINE };
  const tocIface = addonInterface(addonSource, f);
  if (!tocIface) return { ok: false, error: 'addon_missing', detail: 'This copy of NeverQuestAlone is missing its addon files. Download NeverQuestAlone again.' };
  const addonsDir = p.join(flavorDir, 'Interface', 'AddOns');
  const steps = [];
  const step = (name, fn) => {
    try { const r = fn(); steps.push({ name, ok: r !== false }); return r; } catch (e) { steps.push({ name, ok: false, error: e.code || 'failed' }); return false; }
  };
  f.mkdirSync(addonsDir, { recursive: true });
  let iface = interfaceFromVersion(version) || clientInterface(flavorDir, { platform, run, f })?.iface || null;
  iface = iface && clientFits(iface, tocIface, p.basename(flavorDir)) ? iface : tocIface;
  step('Addon folder', () => copyAddon(f, addonSource, p.join(addonsDir, ADDON_NAME), uid, iface) > 0);
  step(`${slots} slot folders`, () => { installSlots(addonsDir, { count: slots, iface }); return true; });
  const sig = signalPaths(addonsDir);
  step('Doorbell folder', () => [sig.present(), ...BELLS.map(sig.bell)].every(file => isRegular(f, file)));
  // Every file there, and no link left anywhere in the addon's folders.
  step('Checked every file', () => isRegular(f, p.join(addonsDir, ADDON_NAME, `${ADDON_NAME}.toc`)) && countSlots(addonsDir) >= slots
    && addonEntries(f, p, addonsDir).every((e) => { try { return !f.lstatSync(e).isSymbolicLink(); } catch { return true; } }));
  // The parts' row folded for the game's first start (C-119), once per install, the game asked
  // about again right before the write (it saves that file from memory when it quits).
  let partsFold = null;
  if (typeof configFile === 'string' && configFile && steps.every(s => s.ok)) {
    try { partsFold = foldPartsOnce({ flavorDir, configFile, running: gameRunning }); } catch { partsFold = 'failed'; }
  }
  // TH12, after the files are written, so it covers them too.
  const permissions = checkAddonsPermissions(addonsDir, { platform, run, tighten, f, uid });
  const ok = steps.every(s => s.ok);
  return { ok, ...(ok ? {} : { error: 'install_failed' }), steps, restartNeeded: true, restartLine: RESTART_LINE, permissions, iface, addonsDir, ...(partsFold ? { partsFold } : {}) };
}

// ---------------------------------------------------------------------------
// The Windows uninstaller's list of WoW folders (audit CV-07).

/** The file in the app's data folder that lists them. */
export const UNINSTALL_RECORD = 'uninstall.ini';
/** How many folders it keeps (newest first). installer.nsh reads folder1 up to this. */
export const UNINSTALL_RECORD_MAX = 8;
const RECORD_LINE = /^folder(\d{1,2})="([^"\r\n]*)"$/;

/** The flavor folders an uninstall.ini lists, in order (UTF-16LE with a byte-order mark, or UTF-8). */
export function readUninstallRecord(file, f = fs) {
  let buf;
  try { buf = f.readFileSync(file); } catch { return []; }
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.subarray(2).toString('utf16le') : buf.toString('utf8').replace(/^\uFEFF/, '');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = RECORD_LINE.exec(line.trim());
    if (m && m[2]) out.push(m[2]);
  }
  return out;
}

/**
 * Lists a flavor folder the addon was installed into in <userData>/uninstall.ini, newest first, at
 * most UNINSTALL_RECORD_MAX, for the Windows uninstaller (app/desktop/build/installer.nsh): it reads
 * the list with ReadINIStr before it removes the app's data folder, then removes the addon, its slot
 * folders and its saved chat history from each (audit CV-07). UTF-16LE with a byte-order mark, which
 * the Windows profile API reads as Unicode, so a folder with non-ASCII characters in its path comes
 * through whole. Windows only (the Mac app has no uninstaller; Linux runs from source); nothing is
 * written when the folder already heads the list or the data folder doesn't exist. → true if written.
 */
export function recordAddonFolder({ userData, flavorDir, platform = process.platform, f = fs } = {}) {
  if (platform !== 'win32' || typeof userData !== 'string' || !userData || !isDir(f, userData)) return false;
  if (typeof flavorDir !== 'string' || !path.win32.isAbsolute(flavorDir) || /["\r\n\0]/.test(flavorDir)) return false;
  const file = path.join(userData, UNINSTALL_RECORD);
  const had = readUninstallRecord(file, f);
  const same = d => path.win32.normalize(d).toLowerCase() === path.win32.normalize(flavorDir).toLowerCase();
  if (had.length && same(had[0])) return false;
  const list = [flavorDir, ...had.filter(d => !same(d))].slice(0, UNINSTALL_RECORD_MAX);
  const text = [
    '; NeverQuestAlone: the World of Warcraft folders its addon was installed into. The Windows',
    '; uninstaller removes the addon, its slot folders and its saved chat history from each.',
    '[addon]',
    ...list.map((d, i) => `folder${i + 1}="${d}"`),
    '',
  ].join('\r\n');
  const tmp = `${file}.${process.pid}.tmp`;
  f.writeFileSync(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]));
  f.renameSync(tmp, file);
  return true;
}
