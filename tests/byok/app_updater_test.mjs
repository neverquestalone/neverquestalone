// Updates (BYOK PRD §11.5, DB12, PF-4): the version guard that refuses an
// installer not newer than the running app, read from the installer itself
// (the Info.plist inside a macOS update zip, the VERSIONINFO resource of a
// Windows NSIS installer), and wired in before electron-updater hands the file
// to its installer; the feed is GitHub, public, with no token.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { IDENTITY } from '../../app/desktop/src/identity.mjs';
import { fileURLToPath } from 'node:url';
import {
  parseVersion, compareVersions, isNewer, guardInstaller, guardDownloads, readZipEntry, readMacZipVersion,
  readPeVersion, versionFromVersionInfo, readInstallerVersion, plistString, releasesRepo, feedConfig, releasesUrl, idleUpdater,
  startUpdater, pinsPublisherOnDisk, noRelease, installerKind, FIRST_CHECK_MS, CHECK_EVERY_MS, QUIET_EVERY_MS, strictSignatureVerifier, parseDn, windowsPowerShell, powerShellEnv, POWERSHELL_PREAMBLE,
  closeSquirrelServerWhenFetched,
} from '../../app/desktop/updater.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', '..', 'app', 'desktop');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bones-updater-'));
// The real electron-updater classes load under plain node; the tests that use
// them are skipped when app/desktop's dependencies aren't installed.
const UPDATER_OUT = path.join(APP, 'node_modules', 'electron-updater', 'out');
const HAS_UPDATER = fs.existsSync(path.join(UPDATER_OUT, 'BaseUpdater.js'));
// NQA_REQUIRE_UPDATER=1 (test.yml's windows-smoke, after npm ci in app/desktop) fails them instead.
const NO_UPDATER = !HAS_UPDATER && process.env.NQA_REQUIRE_UPDATER !== '1' && 'app/desktop/node_modules is not installed';
const desktopRequire = createRequire(path.join(APP, 'package.json'));

// ---------------------------------------------------------------------------
// Fixtures: a zip writer and a minimal PE32+ with a version resource.

function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = Buffer.from(e.data);
    const comp = e.method === 8 ? zlib.deflateRawSync(data) : data;
    const name = Buffer.from(e.name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
const plist = v => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>NeverQuestAlone</string>
  <key>CFBundleShortVersionString</key>
  <string>${v}</string>
</dict></plist>`;

const utf16z = s => Buffer.from(`${s}\0`, 'utf16le');
const pad4 = b => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
function vblock(key, value, valueLen, type, children = []) {
  let b = pad4(Buffer.concat([Buffer.alloc(6), utf16z(key)]));
  if (value) b = pad4(Buffer.concat([b, value]));
  for (const c of children) b = pad4(Buffer.concat([b, c]));
  b.writeUInt16LE(b.length, 0);
  b.writeUInt16LE(valueLen, 2);
  b.writeUInt16LE(type, 4);
  return b;
}
function versionInfo({ product, fixed = [0, 0, 0, 0] }) {
  const ffi = Buffer.alloc(52);
  ffi.writeUInt32LE(0xfeef04bd, 0);
  ffi.writeUInt32LE(0x00010000, 4);
  ffi.writeUInt32LE(((fixed[0] << 16) | fixed[1]) >>> 0, 8);
  ffi.writeUInt32LE(((fixed[2] << 16) | fixed[3]) >>> 0, 12);
  ffi.writeUInt32LE(((fixed[0] << 16) | fixed[1]) >>> 0, 16);
  ffi.writeUInt32LE(((fixed[2] << 16) | fixed[3]) >>> 0, 20);
  const strings = [['ProductName', 'NeverQuestAlone'], ...(product ? [['ProductVersion', product]] : []), ['FileVersion', 'decoy 9.9.9']]
    .map(([k, v]) => vblock(k, utf16z(v), v.length + 1, 1));
  const table = vblock('040904b0', null, 0, 1, strings);
  const sfi = vblock('StringFileInfo', null, 0, 1, [table]);
  return vblock('VS_VERSION_INFO', ffi, 52, 0, [sfi]);
}
function makePe(blob) {
  const RAW = 0x200;
  const VA = 0x1000;
  const res = Buffer.alloc(0x58);
  res.writeUInt16LE(1, 14); res.writeUInt32LE(16, 16); res.writeUInt32LE((0x80000000 | 0x18) >>> 0, 20);
  res.writeUInt16LE(1, 0x18 + 14); res.writeUInt32LE(1, 0x18 + 16); res.writeUInt32LE((0x80000000 | 0x30) >>> 0, 0x18 + 20);
  res.writeUInt16LE(1, 0x30 + 14); res.writeUInt32LE(1033, 0x30 + 16); res.writeUInt32LE(0x48, 0x30 + 20);
  res.writeUInt32LE(VA + 0x58, 0x48); res.writeUInt32LE(blob ? blob.length : 0, 0x48 + 4);
  const section = blob ? Buffer.concat([res, blob]) : Buffer.alloc(0);
  const head = Buffer.alloc(RAW);
  head.write('MZ', 0, 'ascii');
  head.writeUInt32LE(0x40, 0x3c);
  head.write('PE\0\0', 0x40, 'binary');
  head.writeUInt16LE(0x8664, 0x44);
  head.writeUInt16LE(1, 0x46);
  head.writeUInt16LE(240, 0x54);
  const opt = 0x58;
  head.writeUInt16LE(0x20b, opt);
  head.writeUInt32LE(16, opt + 108);
  if (blob) { head.writeUInt32LE(VA, opt + 112 + 16); head.writeUInt32LE(section.length, opt + 112 + 20); }
  const sec = opt + 240;
  head.write('.rsrc', sec, 'ascii');
  head.writeUInt32LE(section.length, sec + 8); head.writeUInt32LE(VA, sec + 12);
  head.writeUInt32LE(section.length, sec + 16); head.writeUInt32LE(RAW, sec + 20);
  return Buffer.concat([head, section]);
}

// ---------------------------------------------------------------------------

test('versions: semver ordering with prereleases', () => {
  assert.equal(parseVersion('not.a.version'), null);
  assert.equal(parseVersion('1.2'), null);
  assert.deepEqual(parseVersion('v1.2.3-alpha.1+build.5'), { major: 1, minor: 2, patch: 3, pre: ['alpha', '1'] });
  const ordered = ['0.1.0-alpha.1', '0.1.0-alpha.2', '0.1.0-alpha.10', '0.1.0-beta', '0.1.0-beta.2', '0.1.0-rc.1', '0.1.0', '0.1.1', '0.2.0', '1.0.0', '10.0.0'];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareVersions(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compareVersions('1.0.0', 'junk'), null);
  assert.equal(isNewer('0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
  assert.equal(isNewer('junk', '0.1.0'), false);
});

test('guardInstaller: newer and matching the feed passes; equal, older, unreadable or mismatched is refused', () => {
  const read = v => () => v;
  assert.deepEqual(guardInstaller({ file: 'x', feedVersion: '0.2.0', currentVersion: '0.1.0', readVersion: read('0.2.0') }), { ok: true, version: '0.2.0' });
  assert.equal(guardInstaller({ file: 'x', feedVersion: '0.1.0', currentVersion: '0.1.0', readVersion: read('0.1.0') }).reason, 'not_newer');
  assert.equal(guardInstaller({ file: 'x', feedVersion: '0.2.0', currentVersion: '0.1.0', readVersion: read('0.0.9') }).reason, 'feed_mismatch', 'an old signed build behind a new feed version');
  assert.equal(guardInstaller({ file: 'x', feedVersion: '0.0.9', currentVersion: '0.1.0', readVersion: read('0.0.9') }).reason, 'not_newer');
  assert.equal(guardInstaller({ file: 'x', feedVersion: '0.2.0', currentVersion: '0.1.0', readVersion: read(null) }).reason, 'unreadable_version');
  assert.equal(guardInstaller({ file: 'x', feedVersion: '0.2.0', currentVersion: '0.1.0', readVersion: read('9.9') }).reason, 'bad_version');
  assert.equal(guardInstaller({ file: 'x', feedVersion: '0.1.0-alpha.2', currentVersion: '0.1.0-alpha.1', readVersion: read('0.1.0-alpha.2') }).ok, true);
});

test('the macOS update zip: the top-level app’s Info.plist, stored or deflated; nested plists are ignored', () => {
  const dir = tmp();
  try {
    for (const method of [0, 8]) {
      const file = path.join(dir, `update-${method}.zip`);
      fs.writeFileSync(file, makeZip([
        { name: 'NeverQuestAlone.app/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist', data: plist('44.4.5'), method },
        { name: 'NeverQuestAlone.app/Contents/Info.plist', data: plist('0.2.0'), method },
        { name: 'NeverQuestAlone.app/Contents/MacOS/NeverQuestAlone', data: Buffer.alloc(64, 1), method },
      ]));
      assert.equal(readMacZipVersion(file), '0.2.0', `method ${method}`);
      assert.equal(readInstallerVersion(file), '0.2.0');
      assert.equal(readZipEntry(file, n => n === 'missing'), null);
    }
    const junk = path.join(dir, 'junk.zip');
    fs.writeFileSync(junk, Buffer.from('not a zip at all'));
    assert.equal(readInstallerVersion(junk), null);
    const nested = path.join(dir, 'nested.zip');
    fs.writeFileSync(nested, makeZip([{ name: 'x/NeverQuestAlone.app/Contents/Info.plist', data: plist('9.9.9'), method: 8 }]));
    assert.equal(readMacZipVersion(nested), null, 'only a top-level .app counts');
    assert.equal(plistString('bplist00....', 'CFBundleShortVersionString'), null, 'binary plists are refused, not guessed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Windows installer: ProductVersion from the RT_VERSION resource, else the fixed file info', () => {
  const dir = tmp();
  try {
    const exe = path.join(dir, 'NeverQuestAlone-Setup-0.2.0.exe');
    fs.writeFileSync(exe, makePe(versionInfo({ product: '0.2.0-beta.1', fixed: [0, 2, 0, 0] })));
    assert.equal(readPeVersion(exe), '0.2.0-beta.1');
    assert.equal(readInstallerVersion(exe), '0.2.0-beta.1');
    const fixedOnly = path.join(dir, 'fixed.exe');
    fs.writeFileSync(fixedOnly, makePe(versionInfo({ product: null, fixed: [1, 4, 7, 0] })));
    assert.equal(readPeVersion(fixedOnly), '1.4.7');
    const noRes = path.join(dir, 'nores.exe');
    fs.writeFileSync(noRes, makePe(null));
    assert.equal(readPeVersion(noRes), null);
    const notPe = path.join(dir, 'notpe.exe');
    fs.writeFileSync(notPe, Buffer.from('MZ but nothing else'));
    assert.equal(readInstallerVersion(notPe), null);
    assert.equal(versionFromVersionInfo(Buffer.alloc(8)), null);
    assert.equal(readInstallerVersion(path.join(dir, 'x.AppImage')), null, 'Linux is notify-only');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Code health AP-12: readPeVersion reads only what leads to the version resource, at its offsets, with the same
// answers as the whole-file reader it replaced. That reader (1.3.1), on a buffer, is the reference here.
function wholeFileReadPeVersion(buf) {
  if (buf.length < 64 || buf.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null;
  const nSections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const ddBase = magic === 0x20b ? opt + 112 : magic === 0x10b ? opt + 96 : -1;
  if (ddBase < 0 || ddBase + 24 > buf.length) return null;
  const rsrcRva = buf.readUInt32LE(ddBase + 16);
  if (!rsrcRva) return null;
  const secBase = opt + optSize;
  const sections = [];
  for (let i = 0; i < nSections; i++) {
    const sec = secBase + i * 40;
    if (sec + 40 > buf.length) return null;
    sections.push({ va: buf.readUInt32LE(sec + 12), vsize: buf.readUInt32LE(sec + 8), rawSize: buf.readUInt32LE(sec + 16), raw: buf.readUInt32LE(sec + 20) });
  }
  const toOff = rva => { for (const x of sections) if (rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize)) return x.raw + (rva - x.va); return -1; };
  const root = toOff(rsrcRva);
  if (root < 0) return null;
  const entries = dir => {
    if (dir + 16 > buf.length) return [];
    const n = buf.readUInt16LE(dir + 12) + buf.readUInt16LE(dir + 14);
    const out = [];
    for (let i = 0; i < n && dir + 16 + i * 8 + 8 <= buf.length; i++) { const e = dir + 16 + i * 8; out.push({ id: buf.readUInt32LE(e), off: buf.readUInt32LE(e + 4) }); }
    return out;
  };
  const isDir = off => (off & 0x80000000) !== 0;
  const type = entries(root).find(e => e.id === 16 && isDir(e.off));
  if (!type) return null;
  const name = entries(root + (type.off & 0x7fffffff)).find(e => isDir(e.off));
  if (!name) return null;
  const lang = entries(root + (name.off & 0x7fffffff)).find(e => !isDir(e.off));
  if (!lang) return null;
  const dataEntry = root + lang.off;
  if (dataEntry + 8 > buf.length) return null;
  const vOff = toOff(buf.readUInt32LE(dataEntry));
  const vLen = buf.readUInt32LE(dataEntry + 4);
  if (vOff < 0 || vOff + vLen > buf.length) return null;
  return versionFromVersionInfo(buf.subarray(vOff, vOff + vLen));
}

/** A resource tree for an .rsrc section at rva: a type directory per id (in order), each to one name and one language; RT_VERSION's leaf is blob. */
function rsrcTree(rva, blob, types) {
  const rootSize = 16 + 8 * types.length;
  const leafAt = i => rootSize + types.length * 48 + i * 16;
  const blobAt = rootSize + types.length * 64;
  const buf = Buffer.alloc(blobAt + (blob ? blob.length : 0));
  buf.writeUInt16LE(types.length, 14);
  types.forEach((id, i) => {
    const td = rootSize + i * 48;
    buf.writeUInt32LE(id, 16 + i * 8); buf.writeUInt32LE((0x80000000 | td) >>> 0, 20 + i * 8);
    buf.writeUInt16LE(1, td + 14); buf.writeUInt32LE(1, td + 16); buf.writeUInt32LE((0x80000000 | (td + 24)) >>> 0, td + 20);
    buf.writeUInt16LE(1, td + 24 + 14); buf.writeUInt32LE(1033, td + 24 + 16); buf.writeUInt32LE(leafAt(i), td + 24 + 20);
    buf.writeUInt32LE(rva + blobAt, leafAt(i)); buf.writeUInt32LE(id === 16 && blob ? blob.length : 0, leafAt(i) + 4);
  });
  if (blob) blob.copy(buf, blobAt);
  return buf;
}
/** A PE32+ (or PE32) installer: .rsrc with other sections before or after it in the table, and an overlay (NSIS's payload). */
function buildPe({ blob, pe32 = false, types = [16], extra = null, overlay = 0 }) {
  const RAW = 0x400;
  const opt = 0x58;
  const optSize = pe32 ? 224 : 240;
  const rsrcVa = 0x3000;
  const filler = Buffer.alloc(0x300, 0xcc);
  const list = [{ name: '.rsrc', va: rsrcVa, data: rsrcTree(rsrcVa, blob, types) }];
  if (extra === 'before') list.unshift({ name: '.text', va: 0x1000, data: filler });
  if (extra === 'after') list.push({ name: '.data', va: 0x6000, data: filler });
  const head = Buffer.alloc(RAW);
  head.write('MZ', 0, 'ascii'); head.writeUInt32LE(0x40, 0x3c); head.write('PE\0\0', 0x40, 'binary');
  head.writeUInt16LE(pe32 ? 0x14c : 0x8664, 0x44); head.writeUInt16LE(list.length, 0x46); head.writeUInt16LE(optSize, 0x54);
  head.writeUInt16LE(pe32 ? 0x10b : 0x20b, opt);
  head.writeUInt32LE(rsrcVa, opt + (pe32 ? 96 : 112) + 16); head.writeUInt32LE(list.find(x => x.name === '.rsrc').data.length, opt + (pe32 ? 96 : 112) + 20);
  let raw = RAW;
  list.forEach((x, i) => {
    const e = opt + optSize + i * 40;
    head.write(x.name, e, 'ascii');
    head.writeUInt32LE(x.data.length, e + 8); head.writeUInt32LE(x.va, e + 12); head.writeUInt32LE(x.data.length, e + 16); head.writeUInt32LE(raw, e + 20);
    raw += x.data.length;
  });
  return Buffer.concat([head, ...list.map(x => x.data), Buffer.alloc(overlay, 0x5a)]);
}

test('the Windows installer’s version is read at its offsets, never the whole file: an installer with a 24 MB payload costs a few KB (code health AP-12)', () => {
  const dir = tmp();
  const reads = { bytes: 0, calls: 0, whole: 0 };
  const { readSync, readFileSync } = fs;
  try {
    const exe = path.join(dir, 'NeverQuestAlone-Setup-1.3.2.exe');
    fs.writeFileSync(exe, buildPe({ blob: versionInfo({ product: '1.3.2', fixed: [1, 3, 2, 0] }), types: [3, 14, 16, 24], extra: 'before', overlay: 24 << 20 }));
    fs.readSync = (...a) => { const n = readSync(...a); reads.bytes += n; reads.calls += 1; return n; };
    fs.readFileSync = (...a) => { reads.whole += 1; return readFileSync(...a); };
    assert.equal(readPeVersion(exe), '1.3.2');
    assert.equal(readInstallerVersion(exe, 'exe'), '1.3.2');
  } finally {
    fs.readSync = readSync;
    fs.readFileSync = readFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(reads.whole, 0, 'no whole-file read');
  assert.ok(reads.bytes < 16 * 1024, `${reads.bytes} bytes read for two answers`);
  assert.ok(reads.calls <= 2 * 12, `${reads.calls} reads`);
});

test('the offset reader answers exactly as the whole-file reader did: PE32 and PE32+, sections in any order, other resources first, a payload after, and every truncation and corruption tried (code health AP-12)', () => {
  const dir = tmp();
  // A seeded generator: the same cases on every run.
  let seed = 0x5eed1e55;
  const rand = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const safe = fn => { try { return fn(); } catch { return null; } };
  let cases = 0;
  const same = (buf, label) => {
    const file = path.join(dir, `c${cases++}.exe`);
    fs.writeFileSync(file, buf);
    const want = safe(() => wholeFileReadPeVersion(buf));
    assert.equal(safe(() => readPeVersion(file)), want, `${label}: readPeVersion`);
    assert.equal(readInstallerVersion(file, 'exe'), want, `${label}: readInstallerVersion`);
    fs.rmSync(file);
    return want;
  };
  try {
    const bases = [];
    for (const pe32 of [false, true]) {
      for (const extra of [null, 'before', 'after']) {
        for (const types of [[16], [3, 14, 16, 24], [24, 16]]) bases.push([`pe32=${pe32} extra=${extra} types=${types}`, buildPe({ blob: versionInfo({ product: '2.0.1-beta.3', fixed: [2, 0, 1, 0] }), pe32, types, extra, overlay: 512 })]);
      }
    }
    bases.push(['fixed only', buildPe({ blob: versionInfo({ product: null, fixed: [1, 4, 7, 0] }), types: [3, 16] })]);
    bases.push(['no version resource', buildPe({ blob: null, types: [3, 14] })]);
    bases.push(['the original fixture', makePe(versionInfo({ product: '0.2.0-beta.1', fixed: [0, 2, 0, 0] }))]);
    for (const [label, base] of bases) {
      const want = same(base, label);
      assert.equal(want, /fixed only/.test(label) ? '1.4.7' : /no version/.test(label) ? null : /original/.test(label) ? '0.2.0-beta.1' : '2.0.1-beta.3', label);
      // Cut short: at every header boundary and at random lengths.
      for (const at of [0, 1, 63, 64, 0x40 + 23, 0x40 + 24, 0x40 + 25, 0x40 + 26, 0x58 + 112, 0x58 + 135, 0x58 + 136, 0x200, 0x3ff, 0x400, base.length - 1]) same(base.subarray(0, Math.min(at, base.length)), `${label} cut at ${at}`);
      for (let i = 0; i < 20; i++) { const at = rand(base.length); same(base.subarray(0, at), `${label} cut at ${at}`); }
      // Corrupted: bytes, and whole 16- and 32-bit fields, anywhere in the headers, the tree or the version.
      for (let i = 0; i < 40; i++) {
        const b = Buffer.from(base);
        const span = Math.min(b.length, 0x400 + 0x400);
        for (let k = 1 + rand(3); k > 0; k--) {
          const at = rand(span - 4);
          const how = rand(3);
          if (how === 0) b[at] = rand(256);
          else if (how === 1) b.writeUInt16LE(rand(0x10000), at);
          else b.writeUInt32LE((rand(0x10000) * 0x10000 + rand(0x10000)) >>> 0, at);
        }
        same(b, `${label} corrupted #${i}`);
      }
    }
    assert.ok(cases > 1000, `${cases} cases`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('guardDownloads: runs before electron-updater’s handoff; a refused download is cleared and never handed over', async () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'update.zip');
    const make = (feed, inside) => {
      fs.writeFileSync(file, makeZip([{ name: 'NeverQuestAlone.app/Contents/Info.plist', data: plist(inside), method: 8 }]));
      const events = [];
      const updater = {
        downloadedUpdateHelper: { clear: async () => { events.push('clear'); } },
        async executeDownload(opts) {
          events.push(`download:${this === updater}`);
          return opts.done({ version: feed, downloadedFile: file });
        },
      };
      const refused = [];
      guardDownloads(updater, { currentVersion: '0.1.0', onRefused: v => refused.push(v.reason) });
      return { updater, events, refused };
    };

    const good = make('0.2.0', '0.2.0');
    const out = await good.updater.executeDownload({ done: async ev => { good.events.push(`handoff:${ev.version}`); return 'handed'; } });
    assert.equal(out, 'handed');
    assert.deepEqual(good.events, ['download:true', 'handoff:0.2.0']);

    for (const [feed, inside, reason] of [['0.1.0', '0.1.0', 'not_newer'], ['0.3.0', '0.0.5', 'feed_mismatch']]) {
      const bad = make(feed, inside);
      await assert.rejects(
        bad.updater.executeDownload({ done: async () => { bad.events.push('handoff'); } }),
        e => e.code === 'NQA_UPDATE_REFUSED' && e.message.includes(reason),
      );
      assert.deepEqual(bad.events, ['download:true', 'clear']);
      assert.deepEqual(bad.refused, [reason]);
      assert.equal(fs.existsSync(file), false, 'the refused file is deleted');
    }
    assert.throws(() => guardDownloads({}, { currentVersion: '0.1.0' }), /executeDownload/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The guard on the real electron-updater 6.8.9 classes (NsisUpdater and
// AppImageUpdater extend BaseUpdater, whose executeDownload drops the
// caller's done; MacUpdater keeps it). Only the network download, the
// installer launch and electron's event plumbing are stubbed.

const exe = v => makePe(versionInfo({ product: v, fixed: v.split(/[.-]/).slice(0, 3).map(Number) }));
const macZip = v => makeZip([{ name: 'NeverQuestAlone.app/Contents/Info.plist', data: plist(v), method: 8 }]);
const sha512 = b => crypto.createHash('sha512').update(b).digest('base64');

function realUpdater(className, dir, { platform = className === 'MacUpdater' ? 'darwin' : 'win32' } = {}) {
  const Klass = desktopRequire(`electron-updater/out/${className}.js`)[className];
  const { DownloadedUpdateHelper } = desktopRequire('electron-updater/out/DownloadedUpdateHelper.js');
  const u = Object.create(Klass.prototype);
  const seen = { downloaded: [], quitHandlers: 0, errors: [], installed: [], refused: [], handoffs: [] };
  u._logger = { info() {}, warn() {}, error() {}, debug() {} };
  u.downloadedUpdateHelper = new DownloadedUpdateHelper(path.join(dir, `${className}-cache`));
  u.dispatchUpdateDownloaded = ev => { seen.downloaded.push(ev.version); };
  u.dispatchError = e => { seen.errors.push(e); };
  u.addQuitHandler = () => { seen.quitHandlers++; };
  u.doInstall = () => { seen.installed.push(u.installerPath); return true; };
  guardDownloads(u, { currentVersion: '0.2.0', platform, onRefused: v => seen.refused.push(v.reason) });
  return { u, seen, Klass };
}

/** Drive executeDownload the way NsisUpdater/MacUpdater.doDownloadUpdate do, with a task that "downloads" bytes. */
function runDownload(u, { feed, bytes, ext, done }) {
  const name = `NeverQuestAlone-${feed}.${ext}`;
  const fileInfo = { url: new URL(`https://github.com/o/r/releases/download/v${feed}/${name}`), info: { url: name, sha512: sha512(bytes), size: bytes.length } };
  const info = { version: feed, files: [fileInfo.info], path: name, sha512: sha512(bytes), releaseDate: '2026-09-26T00:00:00.000Z' };
  return u.executeDownload({
    fileExtension: ext,
    fileInfo,
    downloadUpdateOptions: { requestHeaders: {}, cancellationToken: null, updateInfoAndProvider: { info, provider: null } },
    task: async dest => { fs.writeFileSync(dest, bytes); },
    ...(done ? { done } : {}),
  });
}
const pendingFiles = u => {
  const dir = u.downloadedUpdateHelper.cacheDirForPendingUpdate;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => !f.endsWith('.json')) : [];
};

test('real NsisUpdater: an installer not newer than the app is refused in the download task; nothing is marked ready or queued for quit', { skip: NO_UPDATER }, async () => {
  const dir = tmp();
  try {
    for (const [feed, inside, reason] of [['0.1.0', '0.1.0', 'not_newer'], ['0.3.0', '0.1.0', 'feed_mismatch'], ['0.2.0', '0.2.0', 'not_newer']]) {
      const { u, seen } = realUpdater('NsisUpdater', dir);
      await assert.rejects(runDownload(u, { feed, bytes: exe(inside), ext: 'exe' }), e => e.code === 'NQA_UPDATE_REFUSED' && e.message.includes(reason), `${feed}/${inside}`);
      assert.deepEqual(seen.refused, [reason]);
      assert.deepEqual(seen.downloaded, [], 'never marked downloaded');
      assert.equal(seen.quitHandlers, 0, 'never queued to install on quit');
      assert.equal(u.installerPath, null);
      assert.deepEqual(pendingFiles(u), [], 'the refused file is gone');
      fs.rmSync(u.downloadedUpdateHelper.cacheDir, { recursive: true, force: true });
    }
    // Not a PE at all (a zip named by the feed), whatever its name says: refused.
    const { u: odd, seen: oddSeen } = realUpdater('NsisUpdater', dir);
    await assert.rejects(runDownload(odd, { feed: '0.3.0', bytes: macZip('0.3.0'), ext: 'exe' }), /unreadable_version/);
    assert.equal(oddSeen.quitHandlers, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real NsisUpdater: a newer installer passes; install() re-reads the file and refuses one swapped for an old build', { skip: NO_UPDATER }, async () => {
  const dir = tmp();
  try {
    const { u, seen } = realUpdater('NsisUpdater', dir);
    const files = await runDownload(u, { feed: '0.3.0', bytes: exe('0.3.0'), ext: 'exe' });
    assert.deepEqual(seen.downloaded, ['0.3.0']);
    assert.equal(seen.quitHandlers, 1);
    assert.equal(u.installerPath, files[0]);
    assert.equal(u.install(true, false), true);
    assert.deepEqual(seen.installed, [files[0]], 'the real install() ran');

    u.quitAndInstallCalled = false;
    fs.writeFileSync(u.installerPath, exe('0.1.0'));
    assert.equal(u.install(true, false), false, 'refused at install time');
    assert.equal(seen.installed.length, 1, 'the installer never ran');
    assert.equal(seen.errors.at(-1)?.code, 'NQA_UPDATE_REFUSED');
    assert.deepEqual(seen.refused, ['feed_mismatch']);
    assert.equal(fs.existsSync(files[0]), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real NsisUpdater: an old installer already in the cache (the path that skips the task) is refused before it is queued', { skip: NO_UPDATER }, async () => {
  const dir = tmp();
  try {
    const { u, seen } = realUpdater('NsisUpdater', dir);
    const bytes = exe('0.1.0');
    const pending = u.downloadedUpdateHelper.cacheDirForPendingUpdate;
    fs.mkdirSync(pending, { recursive: true });
    fs.writeFileSync(path.join(pending, 'NeverQuestAlone-0.1.0.exe'), bytes);
    fs.writeFileSync(path.join(pending, 'update-info.json'), JSON.stringify({ fileName: 'NeverQuestAlone-0.1.0.exe', sha512: sha512(bytes), isAdminRightsRequired: false }));
    let taskRan = false;
    const name = 'NeverQuestAlone-0.1.0.exe';
    const fileInfo = { url: new URL(`https://github.com/o/r/releases/download/v0.1.0/${name}`), info: { url: name, sha512: sha512(bytes), size: bytes.length } };
    await assert.rejects(u.executeDownload({
      fileExtension: 'exe', fileInfo,
      downloadUpdateOptions: { requestHeaders: {}, cancellationToken: null, updateInfoAndProvider: { info: { version: '0.1.0', files: [fileInfo.info], path: name, sha512: sha512(bytes) }, provider: null } },
      task: async () => { taskRan = true; },
    }), /not_newer/);
    assert.equal(taskRan, false, 'the cache path really skipped the task');
    assert.deepEqual(seen.downloaded, []);
    assert.equal(seen.quitHandlers, 0);
    assert.deepEqual(seen.refused, ['not_newer']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real AppImageUpdater: Linux downloads are always refused (notify-only; the guard reads no Linux package)', { skip: NO_UPDATER }, async () => {
  const dir = tmp();
  try {
    const { u, seen } = realUpdater('AppImageUpdater', dir, { platform: 'linux' });
    await assert.rejects(runDownload(u, { feed: '0.3.0', bytes: Buffer.from('\x7fELF…'), ext: 'AppImage' }), /unreadable_version/);
    assert.equal(seen.quitHandlers, 0);
    assert.equal(installerKind('linux'), 'linux');
    assert.equal(readInstallerVersion('/x/NeverQuestAlone-0.3.0.exe', 'linux'), null, 'the kind, not the name, decides');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real MacUpdater: the zip is checked before Squirrel.Mac is handed it, fresh or cached', { skip: NO_UPDATER }, async () => {
  const dir = tmp();
  try {
    const { u, seen } = realUpdater('MacUpdater', dir);
    assert.equal(typeof u.install, 'undefined', 'MacUpdater has no install(); Squirrel.Mac installs');
    const handoff = [];
    const done = async ev => { handoff.push(ev.version); };
    await assert.rejects(runDownload(u, { feed: '0.1.0', bytes: macZip('0.1.0'), ext: 'zip', done }), /not_newer/);
    assert.deepEqual(handoff, []);
    const files = await runDownload(u, { feed: '0.3.0', bytes: macZip('0.3.0'), ext: 'zip', done });
    assert.deepEqual(handoff, ['0.3.0']);
    // Same feed entry again: electron-updater finds it cached and skips the task; the done guard still reads it.
    fs.writeFileSync(files[0], macZip('0.1.0'));
    await assert.rejects(runDownload(u, { feed: '0.3.0', bytes: macZip('0.3.0'), ext: 'zip', done }), /feed_mismatch/);
    assert.deepEqual(handoff, ['0.3.0'], 'the swapped zip was never handed over');
    assert.ok(seen.refused.includes('not_newer'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('update checks: turning them back on schedules them again, "Never check" stops them', async () => {
  const timers = [];
  const timer = {
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout', live: true }; timers.push(t); return t; },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval', live: true }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.live = false; },
    clearInterval: t => { if (t) t.live = false; },
  };
  const live = () => timers.filter(t => t.live).map(t => `${t.kind}:${t.ms}`).sort();
  const fake = { on() {}, setFeedURL() {}, checkForUpdates: async () => {}, executeDownload() {} };
  const prefs = { mode: 'never' };
  const u = await startUpdater({
    app: { getVersion: () => '0.1.0', isPackaged: true },
    identity: { releases: { owner: 'bones-co', repo: 'neverquestalone' } },
    prefs, savePrefs: () => {}, platform: 'darwin', timer, loadUpdater: async () => fake,
  });
  assert.deepEqual(live(), [], 'launched with checks off: nothing scheduled');
  assert.equal(fake.disableWebInstaller, true);
  u.setMode('notify');
  assert.deepEqual(live(), [`interval:${CHECK_EVERY_MS}`, `timeout:${FIRST_CHECK_MS}`].sort(), 'back on: a first check and the 12-hour one');
  assert.equal(u.scheduled(), true);
  u.setMode('never');
  assert.deepEqual(live(), [], 'off again: both cleared');
  u.setMode('notify');
  u.setMode('notify');
  assert.equal(live().length, 2, 'never doubled');
});

// The update feed's two guards (rename spec H30): a literal owner turns the feed on, so a Windows build
// with no pinned publisher must only notify, and a feed with no release yet is "up to date".
const NO_TIMER = { setTimeout: () => null, setInterval: () => null, clearTimeout() {}, clearInterval() {} };
const FEED = { releases: { owner: 'bones-co', repo: 'neverquestalone' } };
function eventFake(extra = {}) {
  const handlers = {};
  const calls = { download: 0 };
  const fake = {
    on(ev, fn) { handlers[ev] = fn; }, setFeedURL() {}, executeDownload() {}, checkForUpdates: async () => {},
    downloadUpdate: async () => { calls.download++; handlers['update-downloaded']?.(); },
    ...extra,
  };
  return { fake, handlers, calls };
}

// SC-1 (code health; the 2026-09-26 audit's LA-03): electron-updater serves the update zip to Squirrel.Mac
// from a 127.0.0.1 server with a random password and left it listening until quit. startUpdater closes it
// once Squirrel.Mac has the update (the native autoUpdater's update-downloaded) or failed (its error);
// electron-updater's own update-downloaded, the window's "ready", comes before Squirrel.Mac reads the zip.
test('macOS: the Squirrel.Mac loopback server closes once Squirrel.Mac has the update or failed, never at electron-updater’s own "ready" (SC-1, LA-03)', async () => {
  const fakeUpdater = () => {
    const u = new EventEmitter();
    Object.assign(u, { closes: 0, setFeedURL() {}, checkForUpdates: async () => {}, executeDownload() {}, nativeUpdater: new EventEmitter() });
    u.closeServerIfExists = () => { u.closes += 1; };
    return u;
  };
  const start = (platform, u) => startUpdater({ app: { getVersion: () => '0.1.0', isPackaged: true }, identity: FEED, prefs: { mode: 'notify' }, savePrefs() {}, platform, timer: NO_TIMER, pinsPublisher: async () => true, loadUpdater: async () => u });
  const mac = fakeUpdater();
  await start('darwin', mac);
  mac.emit('update-downloaded', { version: '0.2.0' });
  assert.equal(mac.closes, 0, 'electron-updater’s own "ready" comes before Squirrel.Mac reads the zip');
  mac.nativeUpdater.emit('update-downloaded');
  assert.equal(mac.closes, 1, 'closed once Squirrel.Mac has the update');
  mac.nativeUpdater.emit('error', new Error('Squirrel.Mac failed'));
  assert.equal(mac.closes, 2, 'and when Squirrel.Mac fails');
  const win = fakeUpdater();
  await start('win32', win);
  win.nativeUpdater.emit('update-downloaded');
  assert.equal(win.closes, 0, 'only macOS has Squirrel.Mac');
  assert.equal(closeSquirrelServerWhenFetched({}), false, 'an updater without a native one: nothing to hook');
});

test('real MacUpdater: the loopback server stops listening once Squirrel.Mac has read the zip; Restart to update still reaches Squirrel.Mac (SC-1, LA-03)', { skip: NO_UPDATER, timeout: 20_000 }, async () => {
  const dir = tmp();
  let u = null;
  try {
    const { MacUpdater } = desktopRequire('electron-updater/out/MacUpdater.js');
    const zip = path.join(dir, 'update.zip');
    fs.writeFileSync(zip, macZip('0.3.0'));
    // A new connection each time (no keep-alive): what a closed server refuses is new connections.
    const get = (url, headers = {}) => new Promise((resolve, reject) => {
      http.get(url, { headers, agent: false }, res => { const parts = []; res.on('data', d => parts.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) })); }).on('error', reject);
    });
    // A stand-in for Electron's autoUpdater (Squirrel.Mac): it reads the feed with the password
    // electron-updater gave it, then the zip. It says it has the update later (below), as Squirrel.Mac
    // does only after unpacking it: saying so the moment the last byte arrived raced the server's own
    // 'finish' (the close came first, so electron-updater's updateDownloaded never settled; a loaded Mac
    // and windows-smoke 37162965518).
    const native = new EventEmitter();
    const seen = { feed: null, zipBytes: 0, quitAndInstall: 0 };
    let zipRead; const zipReadP = new Promise((r, j) => { zipRead = { r, j }; });
    native.setFeedURL = f => { seen.feed = f; };
    native.checkForUpdates = async () => {
      try {
        const feed = await get(seen.feed.url, seen.feed.headers);
        const zipRes = await get(JSON.parse(String(feed.body)).url);
        seen.zipBytes = zipRes.body.length;
        zipRead.r();
      } catch (e) { zipRead.j(e); native.emit('error', e); }
    };
    native.quitAndInstall = () => { seen.quitAndInstall += 1; };
    // The real class, as its constructor leaves it (only the feed and the logger are stubbed).
    u = Object.create(MacUpdater.prototype);
    EventEmitter.call(u);
    u._logger = { info() {}, warn() {}, error() {}, debug() {} };
    u.nativeUpdater = native;
    u.squirrelDownloadedUpdate = false;
    native.on('error', e => u.emit('error', e));
    native.on('update-downloaded', () => { u.squirrelDownloadedUpdate = true; });
    u.setFeedURL = () => {};
    u.app = { quit() {} };
    u.autoRunAppAfterInstall = true;
    let listeningAtReady = null;
    // Each wait names itself if it stalls (a loaded Mac once ran out the file's 20 s with no clue which step hung).
    const within = (step, p, ms = 8_000) => { let t; return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(new Error(`${step}: nothing after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
    const ctl = await within('startUpdater', startUpdater({
      app: { getVersion: () => '0.2.0', isPackaged: true }, identity: FEED, prefs: { mode: 'notify' }, savePrefs() {}, platform: 'darwin', timer: NO_TIMER, loadUpdater: async () => u,
      onChange: s => { if (s.state === 'ready' && listeningAtReady === null) listeningAtReady = !!u.server?.listening; },
    }));
    assert.equal(u.autoInstallOnAppQuit, true, 'NeverQuestAlone installs on quit, so Squirrel.Mac fetches the zip at once');
    // Settles on the native updater's error too: a failed loopback fetch fails this test with its reason,
    // never leaves the promise pending until node cancels the rest of the file (windows-smoke 37153137267).
    const fetched = new Promise((r, j) => { native.once('update-downloaded', r); native.once('error', j); });
    const served = u.updateDownloaded({ url: new URL('https://github.com/o/r/releases/download/v0.3.0/NeverQuestAlone-0.3.0-arm64-mac.zip'), info: { size: fs.statSync(zip).size } }, { downloadedFile: zip, version: '0.3.0' });
    // electron-updater's own promise settles on its server response's 'finish', which a loaded machine
    // has been seen to never emit after the client read every byte (the suite on e5d31feb, load ~13). What
    // the app relies on is the update-downloaded event (the window's "ready") and the close below, so the
    // test waits for those, never for that promise.
    served.catch(() => {});
    await within('Squirrel.Mac reading the feed and the zip', zipReadP);
    assert.equal(listeningAtReady, true, 'the window’s "ready" came while Squirrel.Mac still needed the server');
    native.emit('update-downloaded');
    await within('Squirrel.Mac\'s update-downloaded', fetched);
    await within('the loopback server closing', new Promise(r => { const t = setInterval(() => { if (!u.server?.listening) { clearInterval(t); r(); } }, 10); }));
    await new Promise(r => setTimeout(r, 50));
    assert.equal(ctl.status().state, 'ready');
    assert.equal(listeningAtReady, true, 'the window’s "ready" came while Squirrel.Mac still needed the server');
    assert.equal(seen.zipBytes, fs.statSync(zip).size, 'Squirrel.Mac read the whole zip');
    assert.equal(u.server.listening, false, 'closed once Squirrel.Mac has read the zip');
    await assert.rejects(get(seen.feed.url, seen.feed.headers), e => e.code === 'ECONNREFUSED', 'nothing answers on that port any more');
    u.quitAndInstall();
    assert.equal(seen.quitAndInstall, 1, 'Restart to update still hands over to Squirrel.Mac');
  } finally {
    // A server left listening would keep this test file running.
    try { u?.server?.closeAllConnections?.(); u?.server?.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('H30: a Windows build that pins no publisher only notifies (no download, no install on quit); one that pins it downloads', async () => {
  const app = { getVersion: () => '0.1.0', isPackaged: true };
  const logs = [], notes = [];
  const unpinned = eventFake({ configOnDisk: { value: Promise.resolve({ provider: 'github', owner: 'x', repo: 'y' }) } });
  const u = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify' }, savePrefs: () => {}, platform: 'win32', timer: NO_TIMER,
    log: m => logs.push(m), notify: n => notes.push(n), loadUpdater: async () => unpinned.fake });
  assert.equal(u.status().notifyOnly, true, 'the default reads app-update.yml: no publisherName there');
  assert.equal(unpinned.fake.autoInstallOnAppQuit, false);
  assert.ok(logs.includes('updater: this Windows build pins no publisher, so updates only notify'), logs.join('\n'));
  unpinned.handlers['update-available']({ version: '0.2.0' });
  // [UX-W06] The app's word for it everywhere is "download page"; a notification title ends with a period.
  assert.equal(notes.at(-1).body, 'Get it from the download page.', 'sent to the download page, as on Linux');
  assert.equal(notes.at(-1).title, 'NeverQuestAlone 0.2.0 is available.');
  assert.deepEqual(await u.download(), { ok: false, error: 'notify_only' });
  assert.equal(unpinned.calls.download, 0, 'downloadUpdate never called');
  // A signed build that pins its publisher downloads as before.
  const pinned = eventFake();
  const pinnedNotes = [];
  const s = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify', auto: false }, savePrefs: () => {}, platform: 'win32', timer: NO_TIMER,
    pinsPublisher: async () => true, loadUpdater: async () => pinned.fake, notify: n => pinnedNotes.push(n) });
  assert.equal(s.status().notifyOnly, false);
  assert.equal(pinned.fake.autoInstallOnAppQuit, true);
  pinned.handlers['update-available']({ version: '0.2.0' });
  // The click opens About, where Download is (CL-words-80): the body names both steps.
  assert.deepEqual([pinnedNotes.at(-1).body, pinnedNotes.at(-1).page], ['Click to open About, then click Download. It installs when you quit.', 'about']);
  assert.equal((await s.download()).ok, true);
  assert.equal(pinned.calls.download, 1);
  // Other platforms never ask.
  const mac = eventFake();
  const m = await startUpdater({ app, identity: FEED, prefs: { mode: 'never' }, savePrefs: () => {}, platform: 'darwin', timer: NO_TIMER,
    pinsPublisher: async () => { throw new Error('asked'); }, loadUpdater: async () => mac.fake });
  assert.equal(m.status().notifyOnly, false);
  // What counts as pinned: a non-empty name, or a list holding one; nothing else, and a read error is no.
  const disk = v => ({ configOnDisk: { value: v } });
  for (const [cfg, want] of [
    [disk(Promise.resolve({ publisherName: 'Bones Games LLC' })), true],
    [disk(Promise.resolve({ publisherName: ['', 'Bones Games LLC'] })), true],
    [disk(Promise.resolve({ publisherName: '' })), false],
    [disk(Promise.resolve({ publisherName: [] })), false],
    [disk(Promise.resolve({ publisherName: [''] })), false],
    [disk(Promise.resolve({})), false],
    [disk(Promise.resolve(null)), false],
    [disk(Promise.reject(new Error('ENOENT: app-update.yml'))), false],
    [{}, false],
  ]) assert.equal(await pinsPublisherOnDisk(cfg), want, JSON.stringify(cfg));
});

test('H30: no release yet is "up to date", not a failure; a 404 while downloading, a release with no feed file and a network error stay errors', async () => {
  const app = { getVersion: () => '0.1.0', isPackaged: true };
  const run = async (err, during = 'check') => {
    const logs = [];
    const f = eventFake();
    f.fake.checkForUpdates = async () => {
      f.handlers['checking-for-update']();
      if (during === 'check') { f.handlers.error(err); throw err; } // electron-updater emits error, then rejects
      f.handlers['update-available']({ version: '0.2.0' });
    };
    f.fake.downloadUpdate = async () => { f.handlers['download-progress']({ percent: 10 }); f.handlers.error(err); throw err; };
    const u = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify' }, savePrefs: () => {}, platform: 'darwin', timer: NO_TIMER,
      log: m => logs.push(m), loadUpdater: async () => f.fake });
    const r = await u.check();
    if (during === 'download') await u.download();
    return { r, st: u.status(), logs };
  };
  const coded = (code, msg = code) => Object.assign(new Error(msg), { code });
  for (const code of ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'HTTP_ERROR_404']) {
    assert.equal(noRelease(coded(code)), true, code);
    const { r, st, logs } = await run(coded(code));
    assert.equal(r.ok, true, code);
    assert.equal(st.state, 'none', code);
    assert.equal(st.error, null, code);
    assert.equal(logs.filter(l => l === 'updater: no release found yet').length, 1, code);
  }
  const d = await run(coded('HTTP_ERROR_404', 'HttpError: 404'), 'download');
  assert.equal(d.st.state, 'error', 'a 404 during a download stays an error');
  for (const e of [coded('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'Cannot find latest.yml in the latest release artifacts'), new Error('net::ERR_INTERNET_DISCONNECTED')]) {
    assert.equal(noRelease(e), false, e.message);
    const { r, st } = await run(e);
    assert.equal(r.ok, false, e.message);
    assert.equal(st.state, 'error', e.message);
  }
});

// On a Mac, electron-updater 6.8.9's MacUpdater resolves downloadUpdate() only when its loopback
// response to Squirrel.Mac emits 'finish', which a loaded Mac was seen never to do (the real-MacUpdater
// test above). download() settles on update-downloaded too, so it never hangs past the window's "ready".
test('download() settles at update-downloaded when downloadUpdate() never does; a rejection is still an error; a resolving one is unchanged', { timeout: 10_000 }, async () => {
  const app = { getVersion: () => '0.1.0', isPackaged: true };
  // A regression fails here with its step's name instead of hanging until the file's timeout.
  const within = (step, p, ms = 2_000) => { let t; return Promise.race([p, new Promise((_, j) => { t = setTimeout(() => j(new Error(`${step}: nothing after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t)); };
  const ticks = () => new Promise(r => setImmediate(() => setImmediate(r)));
  const start = async (f, platform = 'darwin') => {
    const u = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify' }, savePrefs: () => {}, platform, timer: NO_TIMER,
      pinsPublisher: async () => true, loadUpdater: async () => f.fake });
    f.handlers['update-available']({ version: '0.2.0' });
    return u;
  };

  // Never resolves: Squirrel.Mac has the zip (update-downloaded), the promise stays pending, then rejects late.
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const hung = eventFake();
    let late = null;
    hung.fake.downloadUpdate = () => {
      hung.calls.download++;
      setImmediate(() => { hung.handlers['download-progress']({ percent: 100 }); hung.handlers['update-downloaded']({ version: '0.2.0' }); });
      return new Promise((_, j) => { late = j; });
    };
    const u = await start(hung);
    const r = await within('download() with a downloadUpdate() that never settles', u.download());
    assert.equal(r.ok, true);
    assert.equal(r.status.state, 'ready');
    assert.equal(r.status.progress, 100);
    assert.equal(hung.calls.download, 1);
    assert.deepEqual(await within('a second Download click', u.download()), { ok: false, error: 'nothing_to_download' }, 'a second click returns at once');
    late(new Error('the loopback response never finished'));
    await ticks();
    assert.equal(u.status().state, 'ready', 'the late rejection changes nothing');
    assert.deepEqual(unhandled, [], 'and is never unhandled');
  } finally { process.off('unhandledRejection', onUnhandled); }

  // Rejects: the error state, as before (the error event's reason kept, else "failed").
  for (const [emits, want] of [[null, 'failed'], [new Error('net::ERR_INTERNET_DISCONNECTED'), 'network']]) {
    const f = eventFake();
    f.fake.downloadUpdate = async () => { f.calls.download++; if (emits) f.handlers.error(emits); throw emits ?? new Error('boom'); };
    const u = await start(f);
    const r = await within(`download() rejecting (${want})`, u.download());
    assert.equal(r.ok, false, want);
    assert.equal(r.status.state, 'error', want);
    assert.equal(r.status.error, want);
  }

  // Resolves after update-downloaded, as NsisUpdater and a healthy MacUpdater do: unchanged, on either OS.
  for (const platform of ['darwin', 'win32']) {
    const f = eventFake();
    f.fake.downloadUpdate = async () => { f.calls.download++; await ticks(); f.handlers['update-downloaded']({ version: '0.2.0' }); await ticks(); return ['update.zip']; };
    const u = await start(f, platform);
    const r = await within(`download() resolving (${platform})`, u.download());
    assert.equal(r.ok, true, platform);
    assert.equal(r.status.state, 'ready', platform);
    assert.equal(f.calls.download, 1, platform);
    // Resolving without update-downloaded (nothing handed over) is not "ready", as before.
    const g = eventFake();
    g.fake.downloadUpdate = async () => { g.calls.download++; return []; };
    const v = await start(g, platform);
    const s = await within(`download() resolving with no update-downloaded (${platform})`, v.download());
    assert.equal(s.ok, false, platform);
    assert.equal(s.status.state, 'downloading', platform);
  }
});

test('the feed: GitHub, public, releases only, never a token; the build names the releases repo the publish job uploads to; the placeholder means not configured', () => {
  // The app's identity (the built plugin's identity.json): its releases, the repo release.yml publishes
  // to (desktop UI critic r4, DU-31), so updates are set up in this build; or none, and no updates.
  const { owner = '', repo = '' } = IDENTITY.releases ?? {};
  assert.deepEqual(feedConfig(IDENTITY), { provider: 'github', owner, repo, private: false, releaseType: 'release' });
  assert.equal(releasesRepo(IDENTITY).configured, !!IDENTITY.releases);
  assert.equal(releasesUrl(IDENTITY), IDENTITY.releases ? `https://github.com/${owner}/${repo}/releases` : null);
  // An identity with no releases (the example plugin's) has no updates.
  assert.deepEqual([releasesRepo({ releases: null }).configured, releasesUrl({ releases: null })], [false, null]);
  // The OWNER placeholder is never a configured feed.
  const placeholder = { releases: { owner: 'OWNER', repo: 'neverquestalone' } };
  assert.equal(releasesRepo(placeholder).valid, true);
  assert.equal(releasesRepo(placeholder).configured, false);
  assert.equal(releasesUrl(placeholder), null);
  const real = { releases: { owner: 'bones-co', repo: 'neverquestalone' } };
  assert.equal(releasesRepo(real).configured, true);
  assert.equal(releasesUrl(real), 'https://github.com/bones-co/neverquestalone/releases');
  assert.equal(releasesRepo({ releases: { owner: 'x/../y', repo: 'r' } }).valid, false);
  const src = fs.readFileSync(path.join(APP, 'updater.mjs'), 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(src, /token\s*:|GH_TOKEN|GITHUB_TOKEN|requestHeaders\s*=|addAuthHeader/i, 'no token anywhere in the updater');
  for (const re of [/autoDownload = false/, /allowDowngrade = false/, /autoInstallOnAppQuit = true/, /disableWebInstaller = true/, /guardDownloads\(updater/]) assert.match(src, re);
});

test('"Never check": checks off and saved, and nothing reminds the player (the owner’s app trim cut the monthly reminder; code health AP-08, AP-14)', async () => {
  const prefs = {};
  const saved = [];
  const u = idleUpdater({ identity: {}, prefs, savePrefs: p => saved.push({ ...p }), current: '0.1.0' });
  assert.equal(u.status().state, 'off');
  assert.equal(u.setMode('never').status.mode, 'never');
  assert.deepEqual(saved.at(-1), { mode: 'never' });
  const live = await startUpdater({ app: { getVersion: () => '0.1.0', isPackaged: true }, identity: FEED, prefs: { mode: 'never' }, savePrefs() {}, platform: 'darwin', timer: NO_TIMER, loadUpdater: async () => eventFake().fake });
  for (const ctl of [u, live]) {
    assert.equal('remind' in ctl.status(), false, 'no reminder in the status');
    assert.equal(ctl.dismissReminder, undefined, 'and nothing to put away');
  }
  const mod = await import('../../app/desktop/updater.mjs');
  assert.equal(mod.reminderDue, undefined);
});
test('SY-13: the Windows installer\'s publisher check fails closed: PowerShell that can\'t run, an error, another file, status or publisher is a refusal; only Valid from the pinned publisher installs', async () => {
  const FILE = 'C:\\Users\\p\\AppData\\Local\\neverquestalone-updater\\pending\\NeverQuestAlone-Setup-0.2.0.exe';
  const SUBJECT = 'CN=Bones Games LLC, O=Bones Games LLC, L=Portland, S=Oregon, C=US';
  const answer = (over = {}) => JSON.stringify({ Status: 0, Path: FILE, SignerCertificate: { Subject: SUBJECT }, ...over });
  const calls = [];
  const exec = (outcome) => (cmd, args, opts, cb) => { calls.push({ cmd, args, opts }); setImmediate(() => cb(...outcome)); return { on() {} }; };
  const logs = [];
  const verify = outcome => strictSignatureVerifier({ execFile: exec(outcome), log: l => logs.push(l) });
  // electron-updater's own verifier resolves null (install) here; ours refuses.
  const noPs = Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' });
  assert.match(await verify([noPs, '', ''])(['Bones Games LLC'], FILE), /couldn't verify the installer: PowerShell didn't run \(ENOENT\)/);
  assert.match(await verify([null, '', 'ConvertTo-Json : blocked by policy'])(['Bones Games LLC'], FILE), /PowerShell reported an error/);
  assert.match(await verify([null, 'not json', ''])(['Bones Games LLC'], FILE), /unreadable answer/);
  assert.match(await verify([null, answer({ Status: 1 }), ''])(['Bones Games LLC'], FILE), /status 1/);
  assert.match(await verify([null, answer({ Path: 'C:\\other.exe' }), ''])(['Bones Games LLC'], FILE), /another file/);
  assert.match(await verify([null, answer(), ''])(['Someone Else'], FILE), /another publisher/);
  assert.match(await verify([null, answer(), ''])([], FILE), /no publisher pinned/);
  assert.equal(await verify([null, answer(), ''])(['Bones Games LLC'], FILE), null, 'Valid, pinned CN');
  assert.equal(await verify([null, answer({ Path: FILE.toUpperCase() }), ''])(['CN=Bones Games LLC, O=Bones Games LLC, C=US'], FILE), null, 'a full DN: every attribute it names');
  assert.match(await verify([null, answer(), ''])(['CN=Bones Games LLC, C=CA'], FILE), /another publisher/);
  // Out of time (Node kills the child: killed, SIGTERM): asked once more, at 60 s each, then refused;
  // any other error is refused at once (windows-smoke 37143027538: a cold PowerShell took 20.2 s).
  const timedOut = () => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null });
  const seq = (...outcomes) => { const q = [...outcomes]; const seen = []; return { seen, execFile: (cmd, args, opts, cb) => { seen.push(opts); const o = q.shift(); setImmediate(() => cb(...o)); return { on() {} }; } }; };
  const slow = seq([timedOut(), '', ''], [null, answer(), '']);
  const slowLogs = [];
  assert.equal(await strictSignatureVerifier({ execFile: slow.execFile, log: l => slowLogs.push(l) })(['Bones Games LLC'], FILE), null, 'slow once, then Valid: installs');
  assert.deepEqual(slow.seen.map(o => o.timeout), [60_000, 60_000]);
  assert.match(slowLogs.join('\n'), /took over 60 s; asking once more/);
  const stuck = seq([timedOut(), '', ''], [timedOut(), '', ''], [null, answer(), '']);
  assert.match(await strictSignatureVerifier({ execFile: stuck.execFile })(['Bones Games LLC'], FILE), /PowerShell didn't run \(SIGTERM\)/, 'out of time twice: refused');
  assert.equal(stuck.seen.length, 2, 'never a third try');
  const other = seq([noPs, '', ''], [null, answer(), '']);
  assert.match(await strictSignatureVerifier({ execFile: other.execFile })(['Bones Games LLC'], FILE), /ENOENT/);
  assert.equal(other.seen.length, 1, 'only running out of time is asked again');
  // Windows PowerShell itself, by its full path, no shell; the path a single-quoted literal (a quote
  // doubled); no progress records and UTF-8 answers; PSModulePath emptied whatever its case (SY-21).
  const q = [];
  const env = { SystemRoot: 'D:\\WINDOWS', PSMODULEPATH: 'C:\\Program Files\\PowerShell\\7\\Modules', Path: 'C:\\x' };
  await strictSignatureVerifier({ env, execFile: (cmd, args, opts, cb) => { q.push({ cmd, args, opts }); setImmediate(() => cb(null, answer({ Path: "C:\\it's.exe" }), '')); return { on() {} }; } })(['Bones Games LLC'], "C:\\it's.exe");
  assert.equal(q[0].cmd, 'D:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'never a lookup in the working folder or PATH');
  assert.equal(q[0].opts.shell, undefined);
  assert.deepEqual(q[0].args.slice(0, -1), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command']);
  assert.equal(q[0].args.at(-1), "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-AuthenticodeSignature -LiteralPath 'C:\\it''s.exe' | ConvertTo-Json -Compress -Depth 3");
  assert.deepEqual(q[0].opts.env, { SystemRoot: 'D:\\WINDOWS', Path: 'C:\\x', PSModulePath: '' }, 'PowerShell 7\'s module path never reaches 5.1; the rest as it was');
  assert.equal(windowsPowerShell({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(powerShellEnv({ PSModulePath: 'x', psmodulepath: 'y', A: '1' }), { A: '1', PSModulePath: '' });
  assert.equal(POWERSHELL_PREAMBLE, "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ");
  // A profile folder with non-ASCII characters: the UTF-8 answer names this very file and installs; what
  // an OEM code page made of the same path (cp850: ü is 0x81, and 测试 has no code at all) was refused.
  // A byte-order mark before the answer is read past. tests/byok/updater_windows_test.mjs runs the real
  // PowerShell on such a folder.
  const JURGEN = 'C:\\Users\\Jürgen 测试\\AppData\\Local\\neverquestalone-updater\\pending\\NeverQuestAlone-Setup-0.2.0.exe';
  assert.equal(await verify([null, answer({ Path: JURGEN }), ''])(['Bones Games LLC'], JURGEN), null, 'a non-ASCII profile, answered in UTF-8');
  assert.equal(await verify([null, `\uFEFF${answer({ Path: JURGEN })}`, ''])(['Bones Games LLC'], JURGEN), null, 'a BOM first');
  assert.match(await verify([null, answer({ Path: JURGEN.replace('ü', '\u0081').replace('测试', '??') }), ''])(['Bones Games LLC'], JURGEN), /another file/);
  assert.ok(logs.some(l => /refused the installer's signature/.test(l)));
  assert.deepEqual([...parseDn('CN="Bones, ""Games""", O=B').entries()], [['CN', 'Bones, "Games"'], ['O', 'B']]);
  // startUpdater puts it on the Windows updater only.
  for (const platform of ['win32', 'darwin']) {
    const fake = { on() {}, setFeedURL() {}, checkForUpdates: async () => {}, executeDownload() {} };
    await startUpdater({ app: { getVersion: () => '0.1.0', isPackaged: true }, identity: { releases: { owner: 'bones-co', repo: 'neverquestalone' } },
      prefs: { mode: 'never' }, savePrefs: () => {}, platform, loadUpdater: async () => fake });
    assert.equal(typeof fake.verifyUpdateCodeSignature, platform === 'win32' ? 'function' : 'undefined', platform);
  }
});

// ---------------------------------------------------------------------------
// The staged rollout (PRD §11.5, audit CV-09): tools/stage-rollout.mjs writes stagingPercentage into
// the feeds release.yml publishes, and electron-updater offers the update to that share of installs.

test('CV-09: stage-rollout sets the share in a feed (10, then 50, then everyone; 0 stops it), the dry run writes nothing, and anything else is refused', async () => {
  const { stageFeed, stagedPercent, run } = await import('../../tools/stage-rollout.mjs');
  const feed = 'version: 0.3.0\nfiles:\n  - url: NeverQuestAlone-Setup-0.3.0.exe\n    sha512: abc\n    size: 1\npath: NeverQuestAlone-Setup-0.3.0.exe\nsha512: abc\nreleaseDate: \'2026-09-27T00:00:00.000Z\'\n';
  assert.equal(stagedPercent(feed), 100, 'no field: everyone');
  const ten = stageFeed(feed, 10);
  assert.ok(ten.endsWith('\nstagingPercentage: 10\n'));
  assert.equal(stagedPercent(ten), 10);
  const fifty = stageFeed(ten, 50);
  assert.equal(fifty.match(/stagingPercentage/g).length, 1, 'raised in place, never twice');
  assert.equal(stagedPercent(fifty), 50);
  assert.equal(stageFeed(fifty, 100), feed, 'everyone: the field goes');
  assert.equal(stagedPercent(stageFeed(fifty, 0)), 0, '0 stops a bad one');
  for (const bad of [-1, 101, 12.5, NaN]) assert.throws(() => stageFeed(feed, bad), /whole number from 0 to 100/);
  // The CLI, as release.yml's attest job runs it on the bundle's feeds.
  const dir = tmp();
  try {
    const win = path.join(dir, 'latest.yml');
    const mac = path.join(dir, 'latest-mac.yml');
    fs.writeFileSync(win, feed);
    fs.writeFileSync(mac, feed.replaceAll('Setup-0.3.0.exe', '0.3.0-arm64-mac.zip'));
    const out = [], err = [];
    const io = { stdout: s => out.push(s), stderr: s => err.push(s) };
    assert.equal(run(['--percent', '10', '--dry-run', win, mac], io), 0);
    assert.equal(fs.readFileSync(win, 'utf8'), feed, 'the dry run writes nothing');
    assert.match(out.join('\n'), /latest\.yml: offered to 10% of installs \(was 100%\) \[dry run: not written\]/);
    assert.equal(run(['--percent', '10', win, mac], io), 0);
    assert.equal(stagedPercent(fs.readFileSync(win, 'utf8')), 10);
    assert.equal(stagedPercent(fs.readFileSync(mac, 'utf8')), 10);
    assert.equal(run(['--percent', '50', win], io), 0);
    assert.equal(stagedPercent(fs.readFileSync(win, 'utf8')), 50);
    fs.writeFileSync(path.join(dir, 'notes.yml'), feed);
    assert.equal(run(['--percent', '10', path.join(dir, 'notes.yml')], io), 2, 'only latest*.yml');
    fs.writeFileSync(path.join(dir, 'latest-linux.yml'), 'hello: 1\n');
    assert.equal(run(['--percent', '10', path.join(dir, 'latest-linux.yml')], io), 1, 'no version: not a feed');
    assert.equal(run(['--percent', '150', win], io), 2);
    assert.equal(run([win], io), 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // release.yml runs this tool on the bundle's feeds, with the dispatch's share (where it is: the source
  // export holds no release.yml, tools/shell-tree.mjs GOES_ANYWAY).
  const RELEASE_YML = path.join(HERE, '..', '..', '.github', 'workflows', 'release.yml');
  if (fs.existsSync(RELEASE_YML)) {
    const rel = fs.readFileSync(RELEASE_YML, 'utf8');
    assert.match(rel, /node \.\.\/tools\/stage-rollout\.mjs --percent "\$STAGED" "\$\{feeds\[@\]\}"/);
    assert.match(rel, /STAGED: \$\{\{ inputs\.staged \}\}/);
  }
});

test('CV-09: electron-updater (the real NsisUpdater) offers a staged feed to that share of installs: 0 to none, 100 to all, 10 to an install in the first tenth only', { skip: NO_UPDATER }, async () => {
  const { stageFeed } = await import('../../tools/stage-rollout.mjs');
  // The semver and YAML reader electron-updater itself resolves (its own copies, not the app's).
  const updaterRequire = createRequire(desktopRequire.resolve('electron-updater/out/AppUpdater.js'));
  const yaml = updaterRequire('js-yaml');
  const semver = updaterRequire('semver');
  const { NsisUpdater } = desktopRequire('electron-updater/out/NsisUpdater.js');
  // An install's staging id: its last 4 bytes, over 0xffffffff, are where it sits (0 first, 1 last).
  const updater = (id) => {
    const u = Object.create(NsisUpdater.prototype);
    u._logger = { info() {}, warn() {}, error() {}, debug() {} };
    u.currentVersion = semver.parse('0.2.0');
    u.allowDowngrade = false;
    u.stagingUserIdPromise = { value: Promise.resolve(id) };
    u._isUpdateSupported = () => true;
    u._isUserWithinRollout = info => u.isStagingMatch(info);
    return u;
  };
  const early = '6f1c2d3e-4a5b-4c6d-8e7f-000000000100'; // near the start of the line
  const late = '6f1c2d3e-4a5b-4c6d-8e7f-0000ffffff00'; // near its end
  const feed = 'version: 0.3.0\npath: NeverQuestAlone-Setup-0.3.0.exe\nsha512: abc\nreleaseDate: \'2026-09-27T00:00:00.000Z\'\n';
  const offered = async (percent, id) => updater(id).isUpdateAvailable(yaml.load(stageFeed(feed, percent)));
  assert.equal(await offered(0, early), false, '0: no install');
  assert.equal(await offered(0, late), false);
  assert.equal(await offered(100, early), true, '100 (no field): every install');
  assert.equal(await offered(100, late), true);
  assert.equal(await offered(10, early), true, '10: the first tenth');
  assert.equal(await offered(10, late), false, 'and no other');
  assert.equal(await offered(50, late), false);
});

// Install updates automatically (the owner, 2026-10-05; on by default, Settings has the switch): a found
// update downloads by itself, says it's ready once, and installs at the first quiet moment main reports
// (WoW closed, the window shut), relaunching hidden; never on a notify-only build or with checks off.
test('automatic updates: found → downloaded → installed at the first quiet moment; off is the old notify-and-click', async () => {
  const app = { getVersion: () => '0.1.0', isPackaged: true };
  const timers = [];
  const timer = {
    setTimeout: (fn, ms) => { const t = { fn, ms, kind: 'timeout', live: true }; timers.push(t); return t; },
    setInterval: (fn, ms) => { const t = { fn, ms, kind: 'interval', live: true }; timers.push(t); return t; },
    clearTimeout: t => { if (t) t.live = false; }, clearInterval: t => { if (t) t.live = false; },
  };
  const runTimeouts = async () => { for (const t of timers.filter(x => x.kind === 'timeout' && x.live && x.ms === 0)) { t.live = false; await t.fn(); } await new Promise(r => setImmediate(r)); };
  const tick = async () => { for (const t of timers.filter(x => x.kind === 'interval' && x.live && x.ms === QUIET_EVERY_MS)) await t.fn(); await new Promise(r => setImmediate(r)); };
  const installs = [];
  const ev = eventFake({ quitAndInstall: (silent, run) => installs.push([silent, run]) });
  let quiet = false;
  const notes = [], before = [], saved = [];
  const u = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify' }, savePrefs: p => saved.push({ ...p }), platform: 'darwin', timer,
    loadUpdater: async () => ev.fake, notify: n => notes.push(n), idle: async () => quiet, beforeInstall: () => before.push(1) });
  assert.equal(u.status().auto, true, 'on unless turned off');
  ev.handlers['update-available']({ version: '0.2.0' });
  assert.equal(notes.length, 0, 'nothing to click, so nothing asks');
  await runTimeouts();
  assert.equal(ev.calls.download, 1, 'it downloads by itself');
  assert.equal(u.status().state, 'ready');
  assert.deepEqual(notes.map(n => [n.title, n.body]), [['NeverQuestAlone 0.2.0 is ready.', 'It installs by itself while WoW is closed.']]);
  assert.deepEqual(installs, [], 'WoW open (or the window up): it waits');
  await tick();
  assert.deepEqual(installs, [], 'still busy at the next look');
  quiet = true;
  await tick();
  assert.deepEqual(installs, [[true, true]], 'quiet: silent install, then the app starts again');
  assert.equal(before.length, 1, 'main marks the relaunch hidden first');
  assert.equal(timers.filter(t => t.kind === 'interval' && t.ms === QUIET_EVERY_MS && t.live).length, 0, 'and stops looking');
  // Off: the old way, a notification and Download.
  const ev2 = eventFake({ quitAndInstall: () => installs.push('off') });
  const notes2 = [];
  const off = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify', auto: false }, savePrefs() {}, platform: 'darwin', timer: NO_TIMER,
    loadUpdater: async () => ev2.fake, notify: n => notes2.push(n), idle: async () => true });
  ev2.handlers['update-available']({ version: '0.2.0' });
  assert.equal(ev2.calls.download, 0);
  assert.equal(notes2.at(-1).body, 'Click to open About, then click Download. It installs when you quit.');
  // Turned on with one found: it downloads; turned off: saved.
  const savedOff = [];
  const later = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify', auto: false }, savePrefs: p => savedOff.push({ ...p }), platform: 'darwin', timer,
    loadUpdater: async () => ev2.fake, notify() {}, idle: async () => false });
  ev2.handlers['update-available']({ version: '0.3.0' });
  assert.equal(later.setAuto(true).status.auto, true);
  await runTimeouts();
  assert.equal(ev2.calls.download, 1, 'switching it on downloads the one already found');
  assert.equal(later.setAuto(false).status.auto, false);
  assert.equal(savedOff.at(-1).auto, false);
  // Never on a notify-only build, never with checks off.
  const win = eventFake();
  const w = await startUpdater({ app, identity: FEED, prefs: { mode: 'notify' }, savePrefs() {}, platform: 'win32', timer: NO_TIMER,
    pinsPublisher: async () => false, loadUpdater: async () => win.fake, notify() {} });
  win.handlers['update-available']({ version: '0.2.0' });
  await new Promise(r => setImmediate(r));
  assert.equal(win.calls.download, 0, 'notify-only stays notify-only');
  // The dev stand-in keeps the setting too.
  const idleSaved = [];
  const dev = idleUpdater({ identity: {}, prefs: {}, savePrefs: p => idleSaved.push({ ...p }), current: '0.1.0' });
  assert.equal(dev.status().auto, true);
  assert.equal(dev.setAuto(false).status.auto, false);
  assert.equal(idleSaved.at(-1).auto, false);
});
