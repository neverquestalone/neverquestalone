// The single-bridge lock (public BYOK PRD §8.1, §11.1; BUILD-PLAN "boot.mjs" step 5): one bridge
// per AddOns folder, whoever runs it (the app, or the developer command line through boot.mjs),
// whichever account or HOME it runs under, so two bridges never read the same outbox or write the
// same slots. One lock and one heartbeat (code health BR-27; beside them, the app's Electron
// single-instance lock): the one inside the AddOns folder itself, and only where that can't be
// taken, the bridge's own in its state folder.
//
//   lockFileFor(stateDir, addonsDir, platform?) → <stateDir>/bridge-<16 hex>.lock
//       the hash is of the folder's real path (symlinks resolved), case-folded on macOS and Windows
//   folderLockFile(addonsDir, platform?) → <addonsDir>/NeverQuestAlone/sig/bridge.lock
//       the lock every bridge on this computer sees: a lock under $HOME isn't seen by a bridge
//       started with another HOME (a sandbox) or by another account's (final review L3-1, L4-1)
//   lockHolder(file, { alive, bootAt, now }) → the live pid a lock file names ({pid} JSON or a bare pid), or null
//       a lock written before this computer last started is stale whatever pid it names (L3-6); so
//       is a lock that says it beats (hb) and hasn't been rewritten in STALE_MS, or in three of the
//       beats it names (SY-12: a crashed app's pid, reused by any other process, no longer refuses
//       every start until a reboot; SY-30: an idle bridge beats every minute, and says so)
//   takeFolderLock({ addonsDir, by, platform, alive, pid }) → release() | null (no addon folder
//       there, or a link where NeverQuestAlone/ or sig/ goes: nothing to lock); refused (BRIDGE_RUNNING) while
//       a live bridge holds it, any account's; its file is 0644, so every account can read it.
//       release.pace(ms) sets the heartbeat
//   takeBridgeLock({ lockDir, addonsDir, platform, alive, pid }) → release()
//       the folder's lock (takeFolderLock), else (none to take there) <lockDir>'s for the folder;
//       refused (err.code 'BRIDGE_RUNNING', a plain message) while a live process holds the one it
//       takes; a dead pid's lock, or one from before a restart, is taken over. release.folder: the
//       lock is the folder's. release.pace(ms) sets its heartbeat (HEARTBEAT_MS while the game runs,
//       IDLE_HEARTBEAT_MS while it's closed)
//   pidAlive(pid) → bool
//   bootTime() → when this computer last started (ms)
//
// Only fs, os, path and crypto.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** When this computer last started, in ms since the epoch. */
export function bootTime() { return Date.now() - os.uptime() * 1000; }
// A lock taken just after the computer started (a login item) stays live whatever small error
// the boot time has; a real lock from before a restart is older than this by far.
export const BOOT_MARGIN_MS = 30_000;
const beforeBoot = (at, bootAt) => Number.isFinite(at) && Number.isFinite(bootAt) && at < bootAt - BOOT_MARGIN_MS;
// The heartbeat (SY-12): a holder rewrites its lock's `at` every HEARTBEAT_MS, and a lock that says
// it beats (hb) but hasn't in STALE_MS is stale whatever pid it names. A lock with no hb (an older build's,
// or a bare pid) keeps the pid and boot-time rules alone.
export const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;
// While World of Warcraft is closed the public build's bridge beats every IDLE_HEARTBEAT_MS instead
// (systems critic SY-30: no idle work but a slow check), and its lock says so (hb, in seconds): a
// lock is silent once it has missed three of the beats it names, and never before STALE_MS. A beat
// slower than IDLE_HEARTBEAT_MS counts as that, so a lock can't hold a folder longer by naming one.
// A minute, not more: a crashed app's lock whose pid another process took (Windows reuses pids
// soon) refuses a new start until it's silent, 3 minutes here against 2 while the game runs.
export const IDLE_HEARTBEAT_MS = 60_000;
export const silentAfterMs = hbMs => Math.max(STALE_MS, 3 * Math.min(Number.isFinite(hbMs) && hbMs > 0 ? hbMs : HEARTBEAT_MS, IDLE_HEARTBEAT_MS));
const silent = (l, now) => l.beats && Number.isFinite(l.at) && now - l.at > silentAfterMs(l.hbMs);

function lockError(message) {
  const e = new Error(message);
  e.code = 'BRIDGE_RUNNING';
  return e;
}

/**
 * A folder's real path: symlinks resolved, so a linked path and its target share one lock. A
 * folder that doesn't exist yet resolves through its nearest existing parent.
 */
export function realDir(dir, p = path, real = fs.realpathSync.native) {
  const abs = p.resolve(String(dir));
  try { return real(abs); } catch {
    const up = p.dirname(abs);
    return up === abs ? abs : p.join(realDir(up, p, real), p.basename(abs));
  }
}

/** The lock file that says which bridge serves an AddOns folder (one per folder, in the state dir). */
export function lockFileFor(stateDir, addonsDir, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  // Only resolve links on the OS this runs on (a win32 path is never looked up on a Mac).
  const here = (platform === 'win32') === (process.platform === 'win32');
  const resolved = here ? realDir(addonsDir, p) : p.resolve(String(addonsDir));
  const norm = platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
  const h = crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
  return p.join(stateDir, `bridge-${h}.lock`);
}

/** The lock inside the AddOns folder: <addonsDir>/NeverQuestAlone/sig/bridge.lock. */
export function folderLockFile(addonsDir, platform = process.platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.join(String(addonsDir), 'NeverQuestAlone', 'sig', 'bridge.lock');
}

// The folder lock names its computer and account by a salted hash of each (code health BR-17): it sits
// in the AddOns folder (0644, rewritten every minute), which backup and addon-manager tools copy and
// share, so it holds no host name or uid in the clear. Each lock has its own random salt; a reader hashes
// its own host name and uid with it to tell this computer's lock, and this account's, from another's.
const HEX = /^[0-9a-f]+$/;
export const saltedHash = (salt, value) => crypto.createHash('sha256').update(`${salt}\0${value}`).digest('hex');

// A lock file's pid and when it was written: its JSON `at`, else the file's mtime (an older
// build's lock is a bare pid). null when there's no file or it names no pid. host and uid: an older
// build's, in the clear; salt, hostHash and uidHash: this one's (BR-17).
function readLock(file) {
  let text, st;
  try { text = String(fs.readFileSync(file, 'utf8')).trim(); st = fs.statSync(file); } catch (e) { return e.code === 'ENOENT' ? null : { unreadable: true }; }
  let pid = Number(text);
  let rec = null;
  if (!Number.isInteger(pid)) { try { rec = JSON.parse(text); pid = Number(rec?.pid); } catch { pid = NaN; } }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const at = typeof rec?.at === 'string' && Number.isFinite(Date.parse(rec.at)) ? Date.parse(rec.at) : st.mtimeMs;
  const hb = Number(rec?.hb);
  const hex = (v, n) => (typeof v === 'string' && v.length === n && HEX.test(v) ? v : null);
  return { pid, at, beats: hb > 0, hbMs: hb > 0 ? hb * 1000 : null, rec, uid: Number.isInteger(rec?.uid) ? rec.uid : null, host: typeof rec?.host === 'string' ? rec.host : null, by: typeof rec?.by === 'string' ? rec.by : null,
    salt: hex(rec?.salt, 32), hostHash: hex(rec?.hostHash, 64), uidHash: hex(rec?.uidHash, 64) };
}
/** Is this lock this computer's? Its hash of our host name, or (an older build's) our host name; one that names neither, yes. */
function sameHost(l, host) {
  if (l.hostHash) return !!l.salt && saltedHash(l.salt, String(host)) === l.hostHash;
  return l.host === null || l.host === host;
}
/** Is this lock another account's on this computer? Only when the lock and we both know an account. */
function otherAccount(l, uid) {
  if (uid === null || uid === undefined) return false;
  if (l.uidHash) return !!l.salt && saltedHash(l.salt, String(uid)) !== l.uidHash;
  return l.uid !== null && l.uid !== uid;
}

const hbSeconds = ms => Math.max(1, Math.round(ms / 1000));

/**
 * Keep a lock this process holds alive: rewrite its `at` every beatMs (write, then rename, so a
 * reader never sees half a file), for as long as the file still names this pid. → { stop(), pace(ms) }:
 * pace beats at once with the new hb, so a reader knows the slower beat before it has to wait for it.
 */
function heartbeat(file, { pid, mode, beatMs = HEARTBEAT_MS, now = () => Date.now() }) {
  let every = beatMs;
  let timer = null;
  const beat = () => {
    const l = readLock(file);
    if (!l || l.unreadable || l.pid !== pid || !l.rec) { clearInterval(timer); timer = null; return; } // released, or taken over
    const tmp = `${file}.${pid}.beat`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ ...l.rec, at: new Date(now()).toISOString(), hb: hbSeconds(every) }) + '\n', { mode });
      try { fs.chmodSync(tmp, mode); } catch { /* Windows: the folder's ACL */ }
      fs.renameSync(tmp, file);
    } catch { try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ } } // the next beat tries again
  };
  const arm = () => {
    clearInterval(timer);
    timer = setInterval(beat, every);
    timer.unref?.();
  };
  arm();
  return {
    stop: () => { clearInterval(timer); timer = null; },
    pace(ms) {
      if (!timer || !(ms > 0) || ms === every) return;
      every = ms;
      beat();
      if (timer) arm();
    },
  };
}

/**
 * The live pid a lock file names, or null (no file, unreadable, a dead pid, this process, or a
 * lock written before this computer last started: after a restart its pid may be any process).
 */
export function lockHolder(file, { alive = pidAlive, self = process.pid, bootAt = bootTime(), now = Date.now() } = {}) {
  const l = readLock(file);
  if (!l || l.unreadable || l.pid === self || beforeBoot(l.at, bootAt) || silent(l, now)) return null;
  return alive(l.pid) ? l.pid : null;
}

const realDirAt = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };

/**
 * Take the lock inside the AddOns folder (NeverQuestAlone/sig/bridge.lock, holding {pid, salt, hostHash,
 * uidHash, at, by, hb}: BR-17), which every bridge on this computer checks whatever HOME or account it runs under. No
 * addon folder there, or a link (or a file) where NeverQuestAlone/ or sig/ goes: nothing to take (null);
 * a link is never followed. A lock another account holds can't be read only when its folder
 * says so: that one is refused too (fail closed), naming the file.
 */
export function takeFolderLock({ addonsDir, by = 'nqa', platform = process.platform, alive = pidAlive, pid = process.pid, bootAt = bootTime(), host = os.hostname(), uid = process.getuid?.() ?? null, now = Date.now, beatMs = HEARTBEAT_MS } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const addon = p.join(String(addonsDir), 'NeverQuestAlone');
  const sig = p.join(addon, 'sig');
  if (!realDirAt(addon)) return null;
  let st = null;
  try { st = fs.lstatSync(sig); } catch { /* none yet */ }
  if (st && !st.isDirectory()) return null;
  if (!st) { try { fs.mkdirSync(sig); } catch (e) { if (e.code !== 'EEXIST') return null; } if (!realDirAt(sig)) return null; }
  const file = folderLockFile(addonsDir, platform);
  let beats = null;
  const release = () => {
    beats?.stop();
    const l = readLock(file);
    if (l && !l.unreadable && l.pid === pid && sameHost(l, host)) { try { fs.rmSync(file, { force: true }); } catch { /* gone */ } }
  };
  /** Beat every ms from now on (HEARTBEAT_MS while the game runs, IDLE_HEARTBEAT_MS while it's closed). */
  release.pace = ms => beats?.pace(ms);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      try {
        // The host and the account as salted hashes, never in the clear (BR-17).
        const salt = crypto.randomBytes(16).toString('hex');
        const who = { salt, hostHash: saltedHash(salt, String(host)), ...(uid !== null && uid !== undefined ? { uidHash: saltedHash(salt, String(uid)) } : {}) };
        fs.writeSync(fd, JSON.stringify({ pid, ...who, at: new Date(now()).toISOString(), by, hb: Math.round(beatMs / 1000) || 1 }) + '\n');
        // Readable by every account (whatever the umask), so another account's bridge sees it.
        try { fs.fchmodSync(fd, 0o644); } catch { /* Windows: the folder's ACL */ }
      } finally { fs.closeSync(fd); }
      beats = heartbeat(file, { pid, mode: 0o644, beatMs, now });
      return release;
    } catch (e) {
      // A folder this account can't write to: it can't publish there either, so nothing to lock.
      if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) return null;
      if (e.code !== 'EEXIST') throw e;
      const l = readLock(file);
      if (l?.unreadable) throw lockError(`Another bridge may be serving this World of Warcraft folder: its lock (${file}) belongs to another account and can't be read. Quit that bridge first, or delete that file if nothing is running.`);
      // Another computer's (an AddOns folder on a shared drive) can't be checked; this computer's
      // is held while its pid lives and it was written since this computer started.
      const held = l && l.pid !== pid && sameHost(l, host) && !beforeBoot(l.at, bootAt) && !silent(l, now()) && alive(l.pid);
      if (held) {
        const where = otherAccount(l, uid) ? ', under another account on this computer' : '';
        throw lockError(`Another copy of NeverQuestAlone is already serving this World of Warcraft folder (pid ${l.pid}${where}). Only one copy can at a time: quit that one first.`);
      }
      try { fs.rmSync(file, { force: true }); } catch { /* raced */ } // stale, or our own from before a crash
    }
  }
  throw lockError('Could not take the bridge lock in this World of Warcraft folder.');
}

/**
 * Take the lock for an AddOns folder (code health BR-27: one lock, one heartbeat): the one in the
 * folder itself (takeFolderLock), which every bridge on this computer checks whatever HOME or account
 * it runs under. Only where there's none to take (no real NeverQuestAlone/sig folder, a link where one
 * goes, a folder this account can't write to): <lockDir>/bridge-<hash>.lock holding {pid, addonsDir},
 * so two bridges of one state folder still never share an AddOns folder. A lock that refuses
 * (BRIDGE_RUNNING) is never followed by the other.
 */
export function takeBridgeLock({ lockDir, addonsDir, platform = process.platform, alive = pidAlive, pid = process.pid, bootAt = bootTime(), now = Date.now, beatMs = HEARTBEAT_MS }) {
  const inFolder = takeFolderLock({ addonsDir, by: 'nqa', platform, alive, pid, bootAt, now, beatMs });
  if (inFolder) {
    const release = () => inFolder();
    release.folder = true;
    // It beats at the pace asked for (SY-30: IDLE_HEARTBEAT_MS while the game is closed).
    release.pace = ms => inFolder.pace(ms);
    return release;
  }
  const file = lockFileFor(lockDir, addonsDir, platform);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeSync(fd, JSON.stringify({ pid, addonsDir, at: new Date(now()).toISOString(), hb: Math.round(beatMs / 1000) || 1 }) + '\n'); } finally { fs.closeSync(fd); }
      const beats = heartbeat(file, { pid, mode: 0o600, beatMs, now });
      const release = () => {
        beats.stop();
        try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true }); } catch { /* gone */ }
      };
      release.folder = false; // no lock in the folder itself: this one in its stead
      release.pace = ms => beats.pace(ms);
      return release;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const held = lockHolder(file, { alive, self: pid, bootAt, now: now() });
      if (held) throw lockError(`Another copy of NeverQuestAlone is already running for this World of Warcraft (pid ${held}). Quit it first.`);
      fs.rmSync(file, { force: true }); // stale, or our own from before a crash
    }
  }
  throw lockError('Could not take the bridge lock for this World of Warcraft folder.');
}
