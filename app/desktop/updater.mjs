// Updates (BYOK PRD §11.5, DB12, PF-4; SC-1 for the macOS loopback server).
//
// electron-updater against a public GitHub repository's releases: the app's
// identity's releases (src/identity.mjs; the build's publish block is made from
// the same file, scripts/plugin-config.mjs). An identity with none has no
// updates. No GitHub token ever: the feed is set with private:false and
// nothing else.
//
// Policy: allowDowngrade off. With Automatic updates on (the default since
// 1.4.6, the owner 2026-10-05; Settings has the switch), a check that finds a
// newer version downloads it, and it installs at the first quiet moment: the
// game closed and the window shut (idle(), main's), then the app comes back
// hidden; or when the player quits. With it off, a check notifies; the player
// clicks Download; the update installs when they quit. Never a restart while
// the game runs. electron-updater's own autoDownload stays off: the download
// is this file's, so the version guard and notify-only rules hold either way. "Never check" turns checks off: About
// says so, with the download page a click away, and nothing reminds the player
// (the owner's app trim cut the monthly reminder; code health AP-08, AP-14).
// Linux is notify-only.
//
// The feed (latest.yml) isn't signed, so a compromised release host could
// serve an old, validly signed, vulnerable build. guardDownloads reads the
// version out of the downloaded installer itself and refuses anything not
// newer than the running app, wherever electron-updater 6.8.9 moves a file
// towards installing it: right after each class's download task (NSIS,
// AppImage and Mac all run one; BaseUpdater throws away the caller's done
// step, so a done-only guard never ran on Windows or Linux), at the handoff
// (the Mac done step to Squirrel.Mac; BaseUpdater's "downloaded" mark, which a
// cached download reaches without a task), and in install() (NSIS and
// AppImage, on quit or on Restart to update), which re-reads the file it's
// about to run. tests/byok/app_updater_test.mjs drives the real classes.
//
// On macOS, electron-updater hands the zip to Squirrel.Mac from a 127.0.0.1 server
// with a random password; closeSquirrelServerWhenFetched closes it once Squirrel.Mac
// has read the zip (SC-1), not at quit.
//
// electron-updater is imported lazily inside startUpdater, so the pure parts
// here run under plain node --test.
import { execFile as nodeExecFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Versions (semver 2.0 ordering, build metadata ignored).

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v) {
  const m = SEMVER.exec(String(v ?? '').trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

/** -1, 0 or 1; null when either side isn't a version. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1;
  if (!y.pre.length) return -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p > +q ? 1 : -1; continue; }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p > q ? 1 : -1;
  }
  return 0;
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) === 1;

// ---------------------------------------------------------------------------
// Reading an installer's own version.

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = fs.readSync(fd, buf, 0, len, pos);
  return n === len ? buf : buf.subarray(0, n);
}

/** One entry's bytes from a zip file, by predicate on its name; null when absent. Stored and deflated entries; zip64 sizes. */
export function readZipEntry(file, match, { maxBytes = 1 << 20 } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const tailLen = Math.min(size, 65557);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || cdSize === 0xffffffff || entries === 0xffff) {
      const loc = eocd - 20;
      if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) return null;
      const z64Off = Number(tail.readBigUInt64LE(loc + 8));
      const z = readAt(fd, z64Off, 56);
      if (z.readUInt32LE(0) !== 0x06064b50) return null;
      entries = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOff = Number(z.readBigUInt64LE(48));
    }
    if (cdSize > 64 * 1024 * 1024 || cdOff + cdSize > size) return null;
    const cd = readAt(fd, cdOff, cdSize);
    let p = 0;
    for (let n = 0; n < entries && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) return null;
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let local = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      if (match(name)) {
        // zip64 extended information, when a field overflowed.
        let e = p + 46 + nameLen;
        const end = e + extraLen;
        while (e + 4 <= end) {
          const id = cd.readUInt16LE(e);
          const len = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (local === 0xffffffff) { local = Number(cd.readBigUInt64LE(q)); }
          }
          e += 4 + len;
        }
        if (usize > maxBytes || csize > maxBytes * 4) return null;
        const lh = readAt(fd, local, 30);
        if (lh.readUInt32LE(0) !== 0x04034b50) return null;
        const dataOff = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
        const raw = readAt(fd, dataOff, csize);
        if (method === 0) return raw;
        if (method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
        return null;
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** A <string> value for a <key> in an XML property list (the top-level dict). */
export function plistString(xml, key) {
  const text = String(xml);
  if (text.startsWith('bplist')) return null; // binary plists aren't read: refuse rather than guess
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`<key>\\s*${esc}\\s*</key>\\s*<string>([^<]{1,64})</string>`).exec(text);
  return m ? m[1].trim() : null;
}

/** CFBundleShortVersionString of the one top-level .app in a macOS update zip. */
export function readMacZipVersion(file) {
  const buf = readZipEntry(file, name => /^[^/]+\.app\/Contents\/Info\.plist$/.test(name));
  return buf ? plistString(buf.toString('utf8'), 'CFBundleShortVersionString') : null;
}

/**
 * The ProductVersion string of a Windows PE file's RT_VERSION resource (the
 * NSIS installer's VIAddVersionKey ProductVersion, which electron-builder sets
 * to the app version), falling back to the fixed file info's product version.
 *
 * Only what leads to it is read, at its offset through one file handle: the DOS
 * header, the PE and optional headers, the section table, the three resource
 * directories on the way down and the version resource itself, a few KB in all
 * (code health AP-12: the whole 112 MB installer used to be read into memory on
 * the main thread, three times an update). The NSIS payload after the sections
 * is never touched. The bounds are the file's, as the whole-file read's were:
 * anything that runs past its end is null.
 */
export function readPeVersion(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    /** len bytes at pos, or null when they aren't all in the file. */
    const bytes = (pos, len) => {
      if (pos < 0 || pos + len > size) return null;
      if (len === 0) return Buffer.alloc(0);
      const b = readAt(fd, pos, len);
      return b.length === len ? b : null;
    };
    const dos = bytes(0, 64);
    if (!dos || dos.readUInt16LE(0) !== 0x5a4d) return null; // MZ
    const pe = dos.readUInt32LE(0x3c);
    const head = bytes(pe, 26); // PE\0\0, the file header, the optional header's magic
    if (!head || head.readUInt32LE(0) !== 0x00004550) return null; // PE\0\0
    const nSections = head.readUInt16LE(6);
    const optSize = head.readUInt16LE(20);
    const opt = pe + 24;
    const magic = head.readUInt16LE(24);
    const ddBase = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
    const dd = ddBase < 0 ? null : bytes(ddBase, 24); // the data directories up to the resource table's
    if (!dd) return null;
    const rsrcRva = dd.readUInt32LE(16);
    if (!rsrcRva) return null;
    const table = bytes(opt + optSize, nSections * 40);
    if (!table) return null;
    const sections = [];
    for (let s = 0; s < table.length; s += 40) {
      sections.push({ va: table.readUInt32LE(s + 12), vsize: table.readUInt32LE(s + 8), rawSize: table.readUInt32LE(s + 16), raw: table.readUInt32LE(s + 20) });
    }
    const toOff = rva => {
      for (const s of sections) {
        if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) return s.raw + (rva - s.va);
      }
      return -1;
    };
    const root = toOff(rsrcRva);
    if (root < 0) return null;
    /** A resource directory's entries, as many as the file holds. */
    const entries = dir => {
      const d = bytes(dir, 16);
      if (!d) return [];
      const n = Math.min(d.readUInt16LE(12) + d.readUInt16LE(14), Math.floor((size - dir - 16) / 8));
      const list = n > 0 ? bytes(dir + 16, n * 8) : null;
      const out = [];
      for (let e = 0; list && e < list.length; e += 8) out.push({ id: list.readUInt32LE(e), off: list.readUInt32LE(e + 4) });
      return out;
    };
    const isDir = off => (off & 0x80000000) !== 0;
    const RT_VERSION = 16;
    const type = entries(root).find(e => e.id === RT_VERSION && isDir(e.off));
    if (!type) return null;
    const name = entries(root + (type.off & 0x7fffffff)).find(e => isDir(e.off));
    if (!name) return null;
    const lang = entries(root + (name.off & 0x7fffffff)).find(e => !isDir(e.off));
    if (!lang) return null;
    const data = bytes(root + lang.off, 8);
    if (!data) return null;
    const vOff = toOff(data.readUInt32LE(0));
    const vLen = data.readUInt32LE(4);
    if (vOff < 0 || vOff + vLen > size) return null;
    return versionFromVersionInfo(bytes(vOff, vLen) ?? Buffer.alloc(0));
  } finally {
    fs.closeSync(fd);
  }
}

/** Walk a VS_VERSIONINFO block: StringFileInfo → StringTable → "ProductVersion", else VS_FIXEDFILEINFO. */
export function versionFromVersionInfo(v) {
  const align = n => (n + 3) & ~3;
  const block = at => {
    if (at + 6 > v.length) return null;
    const len = v.readUInt16LE(at);
    const valueLen = v.readUInt16LE(at + 2);
    const type = v.readUInt16LE(at + 4);
    let p = at + 6;
    let key = '';
    while (p + 2 <= v.length && v.readUInt16LE(p) !== 0) { key += String.fromCharCode(v.readUInt16LE(p)); p += 2; }
    const valueAt = align(p + 2);
    const end = Math.min(at + len, v.length);
    if (len < 6 || end <= at) return null;
    return { key, valueLen, type, valueAt, end };
  };
  const children = (b, firstChild) => {
    const out = [];
    let at = align(firstChild);
    while (at + 6 <= b.end) {
      const c = block(at);
      if (!c) break;
      out.push(c);
      at = align(c.end);
    }
    return out;
  };
  const root = block(0);
  if (!root || root.key !== 'VS_VERSION_INFO') return null;
  let fixed = null;
  if (root.valueLen >= 52 && v.readUInt32LE(root.valueAt) === 0xfeef04bd) {
    const ms = v.readUInt32LE(root.valueAt + 16);
    const ls = v.readUInt32LE(root.valueAt + 20);
    fixed = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}`;
  }
  for (const sfi of children(root, root.valueAt + root.valueLen)) {
    if (sfi.key !== 'StringFileInfo') continue;
    for (const table of children(sfi, sfi.valueAt)) {
      for (const str of children(table, table.valueAt)) {
        if (str.key !== 'ProductVersion' || str.type !== 1) continue;
        let s = '';
        for (let p = str.valueAt; p + 2 <= str.end; p += 2) {
          const c = v.readUInt16LE(p);
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        if (s) return s.trim();
      }
    }
  }
  return fixed;
}

/**
 * The installer's own version; null when it can't be read (the guard then
 * refuses). kind is the updater class's own file type ('exe' for NSIS, 'zip'
 * for Mac, 'AppImage'…), never the feed's file name, which a compromised feed
 * chooses; without a kind (tests, older callers) the extension decides.
 * Linux packages aren't read: Linux is notify-only, so a download there is
 * always refused.
 */
export function readInstallerVersion(file, kind = null) {
  const k = String(kind ?? path.extname(String(file)).slice(1)).toLowerCase();
  try {
    if (k === 'zip') return readMacZipVersion(file);
    if (k === 'exe') return readPeVersion(file);
  } catch {}
  return null;
}

/** The file type an updater installs on this platform, for install() (which has no task options to say). */
export function installerKind(platform = process.platform) {
  return platform === 'win32' ? 'exe' : platform === 'darwin' ? 'zip' : 'linux';
}

/**
 * The anti-rollback check: the downloaded installer's own version must be
 * readable, equal to the version the feed announced, and newer than the
 * running app.
 */
export function guardInstaller({ file, feedVersion, currentVersion, readVersion = readInstallerVersion }) {
  const version = readVersion(file);
  if (!version) return { ok: false, reason: 'unreadable_version' };
  if (!parseVersion(version)) return { ok: false, reason: 'bad_version', version };
  if (feedVersion != null && compareVersions(version, feedVersion) !== 0) return { ok: false, reason: 'feed_mismatch', version };
  if (!isNewer(version, currentVersion)) return { ok: false, reason: 'not_newer', version };
  return { ok: true, version };
}

export function refusalError(verdict) {
  const err = new Error(`update refused: ${verdict.reason}`);
  err.code = 'NQA_UPDATE_REFUSED';
  err.verdict = verdict;
  return err;
}

/**
 * Put guardInstaller on an electron-updater instance (see the header):
 *   - executeDownload: the class's download task is wrapped, so the file is
 *     checked as soon as it's on disk, before electron-updater renames it into
 *     place or runs any done step. This is the path NSIS and AppImage take:
 *     BaseUpdater.executeDownload replaces the caller's done with its own
 *     (mark downloaded, install on quit), so a done-only guard never ran there.
 *     The caller's done is wrapped too: on macOS it's kept, and it's where
 *     Squirrel.Mac is handed the zip, a cached download included (the cache
 *     path skips the task).
 *   - dispatchUpdateDownloaded (BaseUpdater: NSIS, AppImage): where its own
 *     done step marks a download ready, a cached one included, before it
 *     queues the install for quit;
 *   - install (BaseUpdater): synchronous, so it can re-read the file it's
 *     about to run at the last moment, whatever path got it there.
 * A refusal deletes the file, clears electron-updater's record of it, calls
 * onRefused and fails the download (or makes install return false), so
 * nothing installs, on quit or otherwise.
 */
export function guardDownloads(updater, { currentVersion, readVersion = readInstallerVersion, onRefused = () => {}, platform = process.platform }) {
  const originalExecute = updater.executeDownload;
  if (typeof originalExecute !== 'function') throw new Error('electron-updater has no executeDownload; the version guard cannot be installed');
  const check = (file, feedVersion, kind) => guardInstaller({ file, feedVersion, currentVersion, readVersion: f => readVersion(f, kind) });
  const forget = (self, file) => {
    try { if (file) fs.rmSync(file, { force: true }); } catch {}
    return Promise.resolve().then(() => self?.downloadedUpdateHelper?.clear?.()).catch(() => {});
  };

  updater.executeDownload = function guardedExecuteDownload(taskOptions) {
    const self = this;
    const kind = taskOptions?.fileExtension ?? null;
    const feedVersion = taskOptions?.downloadUpdateOptions?.updateInfoAndProvider?.info?.version ?? null;
    const opts = { ...taskOptions };
    if (typeof taskOptions?.task === 'function') {
      opts.task = async function guardedTask(destinationFile, ...rest) {
        const out = await taskOptions.task.call(this, destinationFile, ...rest);
        const verdict = check(destinationFile, feedVersion, kind);
        if (!verdict.ok) {
          await forget(self, destinationFile);
          onRefused(verdict);
          throw refusalError(verdict);
        }
        return out;
      };
    }
    if (typeof taskOptions?.done === 'function') {
      opts.done = async function guardedDone(event) {
        const verdict = check(event?.downloadedFile, event?.version ?? feedVersion, kind);
        if (!verdict.ok) {
          await forget(self, event?.downloadedFile);
          onRefused(verdict);
          throw refusalError(verdict);
        }
        return taskOptions.done.call(this, event);
      };
    }
    return originalExecute.call(this, opts);
  };

  if (typeof updater.install === 'function') {
    const originalInstall = updater.install;
    const kind = installerKind(platform);
    // BaseUpdater's own done step (it replaced ours) marks the download ready
    // here, synchronously inside the download's promise chain, and only then
    // queues the install for quit. A cached download skips the task, so this
    // is where it's checked; a throw fails the download before the queueing.
    // (Not on macOS, where electron-updater calls this from a server callback;
    // the done wrapper above covers that handoff.)
    const originalDispatch = updater.dispatchUpdateDownloaded;
    if (typeof originalDispatch === 'function') {
      updater.dispatchUpdateDownloaded = function guardedDispatch(event) {
        const verdict = check(event?.downloadedFile, event?.version ?? null, kind);
        if (!verdict.ok) {
          forget(this, event?.downloadedFile);
          onRefused(verdict);
          throw refusalError(verdict);
        }
        return originalDispatch.call(this, event);
      };
    }
    updater.install = function guardedInstall(...args) {
      const file = this.installerPath;
      if (file) {
        const verdict = check(file, this.downloadedUpdateHelper?.versionInfo?.version ?? null, kind);
        if (!verdict.ok) {
          forget(this, file);
          onRefused(verdict);
          try { this.dispatchError?.(refusalError(verdict)); } catch {}
          return false;
        }
      }
      return originalInstall.apply(this, args);
    };
  }
  return updater;
}

/**
 * SC-1 (code health, the 2026-09-26 audit's LA-03; its fix 5b102c0 never merged): electron-updater
 * 6.8.9's MacUpdater serves the zip to Squirrel.Mac from a 127.0.0.1 server (a random port, Basic
 * auth with a random 64-byte password, a random 64-byte path) and closes it only at the next download
 * or at Restart to update, so with install-on-quit it listened until the app quit. Close it once the
 * native autoUpdater (Squirrel.Mac) has the update, or has failed: Restart to update and the install
 * at quit then only call Squirrel.Mac, and a new download makes a new server. Never on
 * electron-updater's own update-downloaded (the window's "ready"): that comes before Squirrel.Mac reads
 * the zip. A close lets a read in progress finish; it refuses new connections. Returns whether it
 * hooked (only MacUpdater has a native updater).
 */
export function closeSquirrelServerWhenFetched(updater) {
  const native = updater?.nativeUpdater;
  if (typeof native?.on !== 'function' || typeof updater.closeServerIfExists !== 'function') return false;
  const close = () => { try { updater.closeServerIfExists(); } catch {} };
  native.on('update-downloaded', close);
  native.on('error', close);
  return true;
}

// ---------------------------------------------------------------------------
// The Windows installer's publisher, checked failing closed (SY-13).

/**
 * A Distinguished Name's attributes, as electron-updater compares them ("CN=Name, O=Org, C=US";
 * a value may be quoted, with "" for a quote). Keys upper-cased. → Map.
 */
export function parseDn(dn) {
  const out = new Map();
  const s = String(dn ?? '');
  let i = 0;
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === ',' || s[i] === ';' || s[i] === '+') i += 1;
    const eq = s.indexOf('=', i);
    if (eq < 0) break;
    const key = s.slice(i, eq).trim().toUpperCase();
    i = eq + 1;
    let val = '';
    if (s[i] === '"') {
      i += 1;
      while (i < s.length) {
        if (s[i] === '"' && s[i + 1] === '"') { val += '"'; i += 2; continue; }
        if (s[i] === '"') { i += 1; break; }
        val += s[i]; i += 1;
      }
    } else {
      const end = s.slice(i).search(/[,;+]/);
      val = (end < 0 ? s.slice(i) : s.slice(i, i + end)).trim();
      i = end < 0 ? s.length : i + end;
    }
    if (key && !out.has(key)) out.set(key, val);
  }
  return out;
}

/** Windows PowerShell 5.1 by its full path (System32): a bare name is looked for in the working folder first (final review L3-7). */
export function windowsPowerShell(env = process.env) {
  return path.win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * What the check's command starts with (SY-21). No progress records: the first use of a module writes
 * one to stderr, and any stderr is a refusal. The answer in UTF-8: redirected, PowerShell writes in the
 * console's OEM code page (437, 850, 866, 936 and so on), so an installer under C:\Users\Jürgen came
 * back with a mangled path, failed the same-file check and every update was refused.
 */
export const POWERSHELL_PREAMBLE = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ";

/**
 * The environment the check's PowerShell runs in: this one with PSModulePath emptied, whatever its
 * case, so Windows PowerShell 5.1 loads its own modules. A PSModulePath inherited from PowerShell 7
 * makes Get-AuthenticodeSignature unloadable, and every update was refused (electron-builder#7127; SY-21).
 */
export function powerShellEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PSMODULEPATH') out[k] = v;
  out.PSModulePath = '';
  return out;
}

/**
 * electron-updater's own check of a downloaded NSIS installer (windowsExecutableCodeSignatureVerifier)
 * says "fine" when it can't run PowerShell's ConvertTo-Json or Get-AuthenticodeSignature (locked-down
 * PowerShell, an old Windows): it logs "Ignoring signature validation" and installs whatever was
 * downloaded. This one fails closed: null (install) only when Get-AuthenticodeSignature ran, said
 * Valid (Status 0), for this very file, and the signer matches a pinned publisher (every attribute
 * of a full DN, else the CN); anything else is a reason string, and electron-updater refuses the
 * installer ("not signed by the application owner"). The player then reinstalls from the site.
 * Windows PowerShell is run directly (its full path, no shell), with the path as a single-quoted
 * literal, UTF-8 answers and its own module path (POWERSHELL_PREAMBLE, powerShellEnv; SY-21), so a
 * profile folder with non-ASCII characters in it, or a PowerShell 7 parent, doesn't refuse every update.
 * A check that runs out of time is asked once more before the update is refused: a cold PowerShell
 * reading a fresh download while the antivirus scans it can take over 20 s on a slow or busy PC (it
 * did on a CI runner, windows-smoke 37143027538), and a refusal sends the player to reinstall by hand.
 * → (publisherNames, file) => Promise<string|null>, NsisUpdater's verifyUpdateCodeSignature.
 */
export const SIGNATURE_CHECK_MS = 60_000;
export function strictSignatureVerifier({ execFile = nodeExecFile, log = () => {}, env = process.env, timeoutMs = SIGNATURE_CHECK_MS, tries = 2 } = {}) {
  return (publisherNames, file) => new Promise((settle) => {
    let done = false;
    const resolve = (v) => { if (!done) { done = true; settle(v); } };
    const fail = (why) => { if (done) return; log(`updater: refused the installer's signature (${why})`); resolve(`couldn't verify the installer: ${why}`); };
    const names = (Array.isArray(publisherNames) ? publisherNames : [publisherNames]).filter(n => typeof n === 'string' && n);
    if (!names.length) return fail('no publisher pinned');
    const literal = String(file).replace(/'/g, "''");
    const command = `${POWERSHELL_PREAMBLE}Get-AuthenticodeSignature -LiteralPath '${literal}' | ConvertTo-Json -Compress -Depth 3`;
    const run = (left) => {
    let child;
    try {
      child = execFile(windowsPowerShell(env), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 << 20, env: powerShellEnv(env) }, (err, stdout, stderr) => {
          const outOfTime = !!err && (err.killed === true || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT');
          if (outOfTime && left > 1 && !done) { log(`updater: the installer's signature check took over ${Math.round(timeoutMs / 1000)} s; asking once more`); return run(left - 1); }
          if (err) return fail(`PowerShell didn't run (${err.code ?? err.signal ?? 'error'})`);
          if (String(stderr ?? '').trim()) return fail('PowerShell reported an error');
          let data;
          try { data = JSON.parse(String(stdout).replace(/^\uFEFF/, '')); } catch { return fail('unreadable answer'); }
          if (!data || typeof data !== 'object' || data.Status !== 0) return fail(`status ${data?.Status ?? 'missing'}`);
          if (typeof data.Path !== 'string' || path.win32.normalize(data.Path).toLowerCase() !== path.win32.normalize(String(file)).toLowerCase()) return fail('the answer is about another file');
          const subject = parseDn(data.SignerCertificate?.Subject);
          const match = names.some((name) => {
            const dn = parseDn(name);
            if (dn.size && name.includes('=')) return [...dn.keys()].every(k => dn.get(k) === subject.get(k));
            return name === subject.get('CN');
          });
          return match ? resolve(null) : fail('signed by another publisher');
        });
    } catch (e) { return fail(`PowerShell didn't start (${e?.code ?? 'error'})`); }
    child?.on?.('error', e => fail(`PowerShell didn't start (${e?.code ?? 'error'})`));
    };
    run(Math.max(1, tries));
  });
}

// ---------------------------------------------------------------------------
// The feed, from the app's identity.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
export const PLACEHOLDER_OWNER = 'OWNER';

export function releasesRepo(identity) {
  const r = identity?.releases ?? {};
  const owner = String(r.owner ?? '');
  const repo = String(r.repo ?? '');
  const valid = OWNER.test(owner) && REPO.test(repo);
  return { owner, repo, valid, configured: valid && owner !== PLACEHOLDER_OWNER };
}

/** electron-updater's feed: GitHub, public, releases only. Never a token. */
export function feedConfig(identity) {
  const { owner, repo } = releasesRepo(identity);
  return { provider: 'github', owner, repo, private: false, releaseType: 'release' };
}

export function releasesUrl(identity) {
  const r = releasesRepo(identity);
  return r.configured ? `https://github.com/${r.owner}/${r.repo}/releases` : null;
}

// ---------------------------------------------------------------------------
// The controller main.mjs uses.

/**
 * Whether a Windows build pins its installer's publisher: app-update.yml's publisherName, which
 * electron-updater's NsisUpdater reads through the same lazy load. Without one, NsisUpdater's
 * verifySignature says "install" before any check runs, so such a build (every allow_unsigned
 * build, and every build until the Azure signing exists) must only notify (rename spec H30). True
 * only for a non-empty string, or a list holding one; false for none, an empty one or a read error.
 */
export async function pinsPublisherOnDisk(updater) {
  try {
    const name = (await updater.configOnDisk.value)?.publisherName;
    const set = v => typeof v === 'string' && v !== '';
    return set(name) || (Array.isArray(name) && name.some(set));
  } catch { return false; }
}

/**
 * No release yet: electron-updater's code for an empty releases feed, and builder-util-runtime's for
 * a feed page that isn't there (rename spec H30). The check then finds nothing new, which is not a
 * failure. A release without its feed file (ERR_UPDATER_CHANNEL_FILE_NOT_FOUND) and network errors
 * stay errors.
 */
export const noRelease = e => e?.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || e?.code === 'HTTP_ERROR_404';

/**
 * startUpdater({ app, identity, prefs, savePrefs, platform, log, onChange, notify, timer?, loadUpdater?, pinsPublisher? })
 * → { status(), check(), download(), setMode(mode), installNow(), scheduled() }.
 * Not packaged, or no releases repo configured: a controller that says so and does nothing.
 * notify is main's gate on desktop notifications (the player can turn them off). On Windows,
 * pinsPublisher(updater) decides whether updates may install or only notify (pinsPublisherOnDisk).
 */
export async function startUpdater({
  app, identity, prefs, savePrefs, platform = process.platform, log = () => {}, onChange = () => {}, notify = () => {}, now = Date.now,
  timer = globalThis, loadUpdater = defaultLoadUpdater, verifySignature = null, pinsPublisher = pinsPublisherOnDisk,
  idle = async () => false, beforeInstall = () => {},
}) {
  const repo = releasesRepo(identity);
  const current = app.getVersion();
  const st = {
    mode: prefs.mode === 'never' ? 'never' : 'notify',
    auto: prefs.auto !== false,
    configured: repo.configured,
    supported: app.isPackaged && repo.configured,
    notifyOnly: platform === 'linux', current, state: 'idle', available: null, progress: null,
    lastCheck: prefs.lastCheck ?? null, error: null,
  };
  const snapshot = () => ({ ...st, available: st.available ? { ...st.available } : null });
  const emit = () => onChange(snapshot());
  const save = patch => { Object.assign(prefs, patch); savePrefs(prefs); };

  let updater = null;
  // Settles a download() still waiting on downloadUpdate() when update-downloaded comes (see download()).
  let downloaded = null;
  if (st.supported) {
    updater = await loadUpdater();
    updater.logger = { info: m => log(`updater: ${m}`), warn: m => log(`updater: ${m}`), error: m => log(`updater: ${m}`), debug: () => {} };
    updater.setFeedURL(feedConfig(identity));
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.allowPrerelease = /-/.test(current);
    updater.fullChangelog = false;
    // A web installer's payload is a second file the version guard doesn't read.
    updater.disableWebInstaller = true;
    guardDownloads(updater, { currentVersion: current, platform, onRefused: v => log(`updater: refused a download (${v.reason}${v.version ? `, installer says ${v.version}` : ''})`) });
    if (platform === 'darwin') closeSquirrelServerWhenFetched(updater);
    // The installer's publisher, failing closed where PowerShell can't run (SY-13).
    if (platform === 'win32') updater.verifyUpdateCodeSignature = verifySignature ?? strictSignatureVerifier({ log });
    // A Windows build that pins no publisher only notifies, as Linux does: checks still run, so the
    // player still learns of an update, and the release page is where it comes from.
    if (platform === 'win32' && !(await pinsPublisher(updater))) {
      st.notifyOnly = true;
      updater.autoInstallOnAppQuit = false;
      log('updater: this Windows build pins no publisher, so updates only notify');
    }
    updater.on('checking-for-update', () => { st.state = 'checking'; emit(); });
    updater.on('update-available', info => {
      st.state = 'available';
      st.available = { version: String(info?.version ?? ''), date: info?.releaseDate ?? null };
      emit();
      // Automatic: it downloads now and says so once it's ready (below); nothing to click.
      if (autoOn()) { timer.setTimeout(() => { ctl.download(); }, 0); return; }
      notify({ title: `NeverQuestAlone ${st.available.version} is available.`, body: st.notifyOnly ? 'Get it from the download page.' : 'Click to open About, then click Download. It installs when you quit.', page: 'about' });
    });
    updater.on('update-not-available', () => { st.state = 'none'; emit(); });
    updater.on('download-progress', p => { st.state = 'downloading'; st.progress = Math.round(p?.percent ?? 0); emit(); });
    updater.on('update-downloaded', () => {
      const was = st.state;
      st.state = 'ready'; st.progress = 100; emit(); downloaded?.();
      if (was !== 'ready' && autoOn()) {
        const v = st.available?.version;
        notify({ title: v ? `NeverQuestAlone ${v} is ready.` : 'An update is ready.', body: 'It installs by itself while WoW is closed.', page: 'about' });
        waitForQuiet();
      }
    });
    updater.on('error', e => {
      if (st.state === 'checking' && noRelease(e)) { st.state = 'none'; st.error = null; log('updater: no release found yet'); emit(); return; }
      st.state = 'error';
      st.error = e?.code === 'NQA_UPDATE_REFUSED' ? 'refused' : /net::|ENOTFOUND|ECONN|ETIMEDOUT|ERR_/.test(String(e?.message)) ? 'network' : 'failed';
      emit();
    });
  }

  // Automatic updates apply only where a download can: never notify-only builds, never with checks off.
  function autoOn() { return st.supported && st.auto && !st.notifyOnly && st.mode !== 'never'; }
  // Ready and automatic: install at the first quiet moment (main's idle(): the game closed, the
  // window shut), checked now and every QUIET_EVERY_MS; quitting installs it too (autoInstallOnAppQuit).
  let quietTimer = null;
  function stopQuiet() { if (quietTimer) { timer.clearInterval(quietTimer); quietTimer = null; } }
  async function tryQuiet() {
    if (!autoOn() || st.state !== 'ready' || !updater) { stopQuiet(); return false; }
    let ok = false;
    try { ok = (await idle()) === true; } catch { ok = false; }
    if (!ok || !autoOn() || st.state !== 'ready') return false;
    stopQuiet();
    log('updater: installing the update while the game is closed');
    try { beforeInstall(); } catch {}
    updater.quitAndInstall(true, true);
    return true;
  }
  function waitForQuiet() {
    stopQuiet();
    quietTimer = timer.setInterval(() => { tryQuiet(); }, QUIET_EVERY_MS);
    quietTimer?.unref?.();
    tryQuiet();
  }

  const ctl = {
    status: snapshot,
    async check() {
      if (!st.supported) return { ok: false, error: st.configured ? 'not_packaged' : 'not_configured' };
      if (st.mode === 'never') return { ok: false, error: 'checks_off' };
      st.error = null;
      st.lastCheck = now();
      save({ lastCheck: st.lastCheck });
      try { await updater.checkForUpdates(); } catch (e) {
        if (noRelease(e)) {
          if (st.state !== 'none') log('updater: no release found yet');
          st.state = 'none';
          st.error = null;
        } else { st.state = 'error'; st.error = st.error ?? 'network'; }
      }
      emit();
      return { ok: st.state !== 'error', status: snapshot() };
    },
    async download() {
      if (!st.supported || st.state !== 'available') return { ok: false, error: 'nothing_to_download' };
      if (st.notifyOnly) return { ok: false, error: 'notify_only' };
      st.state = 'downloading';
      st.progress = 0;
      emit();
      // Done at whichever comes first: downloadUpdate() settling, or its update-downloaded event. On a
      // Mac, electron-updater 6.8.9's MacUpdater resolves that promise only when its loopback response
      // to Squirrel.Mac emits 'finish', which a loaded Mac was seen never to do after Squirrel.Mac had
      // read every byte, so the promise alone could leave this (and the window's Download) pending
      // forever. The race keeps a handler on the late promise: a rejection after "ready" is never
      // unhandled, and electron-updater's own 'error' event still reports it.
      const ready = new Promise(r => { downloaded = r; });
      try { await Promise.race([updater.downloadUpdate(), ready]); } catch { st.state = 'error'; st.error = st.error ?? 'failed'; } finally { downloaded = null; }
      emit();
      return { ok: st.state === 'ready', status: snapshot() };
    },
    setMode(mode) {
      st.mode = mode;
      save({ mode });
      schedule();
      emit();
      return { ok: true, status: snapshot() };
    },
    /** Automatic updates (Settings): on downloads one already found, and installs a ready one when quiet. */
    setAuto(on) {
      st.auto = on === true;
      save({ auto: st.auto });
      if (autoOn() && st.state === 'available') timer.setTimeout(() => { ctl.download(); }, 0);
      if (autoOn() && st.state === 'ready') waitForQuiet(); else if (!st.auto) stopQuiet();
      emit();
      return { ok: true, status: snapshot() };
    },
    installNow() {
      if (!updater || st.state !== 'ready') return { ok: false, error: 'no_update_ready' };
      setImmediate(() => updater.quitAndInstall(false, true));
      return { ok: true };
    },
  };

  // Checks run 30 s after launch (or after checks are turned back on), then
  // every 12 hours; "Never check" stops them. setMode reschedules.
  let timers = [];
  function schedule() {
    for (const t of timers) { timer.clearTimeout(t); timer.clearInterval(t); }
    timers = [];
    if (!st.supported || st.mode !== 'notify') return;
    timers.push(timer.setTimeout(() => ctl.check(), FIRST_CHECK_MS), timer.setInterval(() => ctl.check(), CHECK_EVERY_MS));
    for (const t of timers) t?.unref?.();
  }
  ctl.scheduled = () => timers.length > 0;
  schedule();
  return ctl;
}

export const FIRST_CHECK_MS = 30_000;
export const QUIET_EVERY_MS = 5 * 60 * 1000;
export const CHECK_EVERY_MS = 12 * 3600 * 1000;

async function defaultLoadUpdater() {
  const mod = await import('electron-updater');
  return mod.autoUpdater ?? mod.default?.autoUpdater;
}

/** The controller for runs where updates can't run (self-test, unpackaged). */
export function idleUpdater({ identity, prefs = {}, savePrefs = () => {}, current, packaged = false }) {
  const repo = releasesRepo(identity);
  const st = { mode: prefs?.mode === 'never' ? 'never' : 'notify', auto: prefs?.auto !== false, configured: repo.configured, supported: false, notifyOnly: false, current, state: 'off', available: null, progress: null, lastCheck: prefs?.lastCheck ?? null, error: packaged ? null : 'not_packaged' };
  const snap = () => ({ ...st });
  return {
    status: snap,
    check: async () => ({ ok: false, error: st.configured ? 'not_packaged' : 'not_configured' }),
    download: async () => ({ ok: false, error: 'nothing_to_download' }),
    setMode: mode => {
      st.mode = mode;
      Object.assign(prefs, { mode });
      savePrefs(prefs);
      return { ok: true, status: snap() };
    },
    setAuto: on => {
      st.auto = on === true;
      Object.assign(prefs, { auto: st.auto });
      savePrefs(prefs);
      return { ok: true, status: snap() };
    },
    installNow: () => ({ ok: false, error: 'no_update_ready' }),
  };
}
