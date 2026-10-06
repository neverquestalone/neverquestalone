#!/usr/bin/env node
// Build the addon zip that CurseForge, Wago, WowUp and a manual install unpack
// into Interface/AddOns: NeverQuestAlone with its doorbells, and the slot pool.
//
// An addon-only install works at once (Copy and Paste, Paste.lua). Because the
// zip also carries every file the transport needs, and the client only sees
// files that exist when the UI loads (PROTOCOL.md §1, §3), a player who adds
// the NeverQuestAlone app later is heard without restarting WoW
// (docs/ADDON-FIRST.md).
//
//   node tools/package-addon.mjs [--out <dir>] [--name <file.zip>]   → <dir>/NeverQuestAlone-<version>.zip (default dist/)
//
// The repository's LICENSE goes in as NeverQuestAlone/LICENSE.txt, as the release job
// ships it, so that job can build its zip with this.
//
// No dependencies: zlib does the deflate and the CRC. Entries are sorted and
// dated SOURCE_DATE_EPOCH (else 2026-01-01 UTC), so a build is reproducible.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { SLOT_COUNT, SLOT_PLACEHOLDER, slotName, slotToc } from '../bridge/transport/slots.mjs';
import { BELLS, signalPaths } from '../bridge/transport/signals.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ADDON_DIR = path.join(REPO, 'addon', 'NeverQuestAlone');

/** A TOC's ## fields and the files it lists, with / separators. */
export function readToc(text) {
  const fields = {}, files = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^##\s*([^:]+):\s*(.*)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
    else if (line && !line.startsWith('#')) files.push(line.replace(/\\/g, '/'));
  }
  return { fields, files };
}

/**
 * Every file the zip holds, as { name, data } with / separators: the addon
 * folder as it is (minus dotfiles and any sig/ left from a live install), its
 * licence, the 0-byte doorbells the bridge makes (signals.mjs), and each
 * slot's TOC and placeholder inbox, as setup makes them (slots.mjs).
 */
export function addonEntries({ addonDir = ADDON_DIR, slots = SLOT_COUNT, license = path.join(REPO, 'LICENSE') } = {}) {
  const { fields, files } = readToc(fs.readFileSync(path.join(addonDir, 'NeverQuestAlone.toc'), 'utf8'));
  const iface = fields.Interface, version = fields.Version;
  if (!/^\d+$/.test(iface || '')) throw new Error('NeverQuestAlone.toc has no ## Interface number');
  if (!/^[\w.-]+$/.test(version || '')) throw new Error('NeverQuestAlone.toc has no ## Version');
  for (const f of files) if (!fs.existsSync(path.join(addonDir, f))) throw new Error(`NeverQuestAlone.toc lists ${f}, which is missing`);

  const entries = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || (!rel && e.name === 'sig')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) entries.push({ name: `NeverQuestAlone/${r}`, data: fs.readFileSync(path.join(dir, e.name)) });
    }
  };
  walk(addonDir, '');
  if (license && fs.existsSync(license) && !entries.some(e => e.name === 'NeverQuestAlone/LICENSE.txt')) {
    entries.push({ name: 'NeverQuestAlone/LICENSE.txt', data: fs.readFileSync(license) });
  }

  const root = path.resolve('addons');
  const sig = signalPaths(root);
  for (const file of [sig.present(), ...BELLS.map(sig.bell)]) {
    entries.push({ name: path.relative(root, file).split(path.sep).join('/'), data: Buffer.alloc(0) });
  }
  for (let i = 1; i <= slots; i++) {
    const n = slotName(i);
    entries.push({ name: `${n}/${n}.toc`, data: Buffer.from(slotToc(i, iface)) });
    entries.push({ name: `${n}/Inbox.lua`, data: Buffer.from(SLOT_PLACEHOLDER) });
  }
  return { version, iface, entries };
}

// CRC-32 (zip's polynomial). zlib.crc32 is Node 22.2+; the table is the fallback.
let TABLE;
function crc32(buf) {
  if (zlib.crc32) return zlib.crc32(buf) >>> 0;
  TABLE ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS time and date fields (2-second steps, years from 1980). */
function dosTime(date) {
  const d = new Date(date);
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    day: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

export function buildDate(env = process.env) {
  const s = Number(env.SOURCE_DATE_EPOCH);
  return Number.isFinite(s) && s >= 315532800 ? new Date(s * 1000) : new Date(Date.UTC(2026, 0, 1));
}

/**
 * A zip of the entries, with a directory record for every folder. Deflated
 * where that's smaller, stored otherwise; Unix modes 644 and 755.
 */
export function zip(entries, { date = buildDate() } = {}) {
  const names = new Set();
  for (const e of entries) {
    if (!/^[\w.-]+(\/[\w.-]+)*$/.test(e.name) || e.name.split('/').includes('..')) throw new Error(`bad zip name: ${e.name}`);
    if (names.has(e.name)) throw new Error(`two files named ${e.name}`);
    names.add(e.name);
  }
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.name.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join('/')}/`);
  }
  const all = [...[...dirs].map(name => ({ name, data: Buffer.alloc(0), dir: true })), ...entries]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const { time, day } = dosTime(date);
  const locals = [], centrals = [];
  let offset = 0;
  for (const e of all) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = e.data.length ? zlib.deflateRawSync(e.data, { level: 9 }) : null;
    const method = deflated && deflated.length < e.data.length ? 8 : 0;
    const body = method === 8 ? deflated : e.data;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the modes below count
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((((e.dir ? 0o40755 : 0o100644) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  if (all.length > 0xffff || offset + cd.length > 0xffffffff) throw new Error('too big for a zip without zip64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(all.length, 8);
  end.writeUInt16LE(all.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** Build the zip into outDir (as name, else NeverQuestAlone-<version>.zip). Returns { file, bytes, files }. */
export function packageAddon({ outDir = path.join(REPO, 'dist'), name = null, addonDir = ADDON_DIR, date = buildDate() } = {}) {
  const { version, entries } = addonEntries({ addonDir });
  const buf = zip(entries, { date });
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, name || `NeverQuestAlone-${version}.zip`);
  fs.writeFileSync(file, buf);
  return { file, bytes: buf.length, files: entries.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = flag => { const at = process.argv.indexOf(flag); return at > 0 ? process.argv[at + 1] : undefined; };
  const out = arg('--out'), name = arg('--name');
  if (name !== undefined && !/^[\w.-]+\.zip$/.test(name)) { console.error('--name takes a plain file name ending in .zip'); process.exit(2); }
  const r = packageAddon({ ...(out !== undefined ? { outDir: path.resolve(out || '.') } : {}), ...(name ? { name } : {}) });
  console.log(`${path.relative(process.cwd(), r.file) || r.file}: ${r.files} files, ${Math.round(r.bytes / 1024)} KB`);
}
