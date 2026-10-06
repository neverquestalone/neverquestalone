// The addon zip (tools/package-addon.mjs): what a store install unpacks is the
// addon plus everything the transport needs when the UI loads, so the NeverQuestAlone app added later is heard with no WoW restart (docs/ADDON-FIRST.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ADDON_DIR, addonEntries, packageAddon, readToc, zip } from '../tools/package-addon.mjs';
import { SLOT_CATEGORY, SLOT_COUNT, SLOT_ICON, SLOT_PLACEHOLDER, installSlots, slotName, slotToc } from '../bridge/transport/slots.mjs';
import { BELLS } from '../bridge/transport/signals.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// A reader of its own: end record, then central directory, then each local
// header, checking sizes and CRCs against both.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0 && end === buf.length - 22, 'one end record, no comment');
  const count = buf.readUInt16LE(end + 10), cdSize = buf.readUInt32LE(end + 12), cdAt = buf.readUInt32LE(end + 16);
  assert.equal(cdAt + cdSize, end, 'the central directory runs up to the end record');
  const out = new Map();
  let at = cdAt;
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(at), 0x02014b50);
    const method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extra = buf.readUInt16LE(at + 30), comment = buf.readUInt16LE(at + 32);
    const attrs = buf.readUInt32LE(at + 38), local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extra + comment;
    assert.equal(buf.readUInt32LE(local), 0x04034b50, `${name}: local header`);
    assert.equal(buf.subarray(local + 30, local + 30 + buf.readUInt16LE(local + 26)).toString('utf8'), name);
    assert.equal(buf.readUInt32LE(local + 14), crc, `${name}: local CRC`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
    assert.ok(method === 0 || method === 8, `${name}: stored or deflated`);
    assert.equal(data.length, usize, `${name}: size`);
    assert.equal(zlib.crc32(data) >>> 0, crc, `${name}: CRC`);
    assert.ok(!out.has(name), `${name}: once`);
    out.set(name, { data, dir: name.endsWith('/'), mode: attrs >>> 16 });
  }
  return out;
}

function extract(files, dir) {
  for (const [name, f] of files) {
    const to = path.join(dir, ...name.split('/'));
    if (f.dir) fs.mkdirSync(to, { recursive: true });
    else { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, f.data); }
  }
}

const listFiles = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? listFiles(dir, path.join(rel, e.name)) : [path.join(rel, e.name)])).sort();

const built = (() => {
  const { version, iface, entries } = addonEntries();
  return { version, iface, entries, buf: zip(entries) };
})();

test('the zip holds NeverQuestAlone byte for byte, its doorbells and every slot, each under the AddOns list\'s one parts row', () => {
  const files = unzip(built.buf);
  const toc = readToc(fs.readFileSync(path.join(ADDON_DIR, 'NeverQuestAlone.toc'), 'utf8'));
  assert.equal(built.iface, toc.fields.Interface);
  assert.equal(built.version, toc.fields.Version);
  assert.equal(toc.fields.IconTexture, 'Interface\\AddOns\\NeverQuestAlone\\Media\\NeverQuestAlone', 'the AddOns list shows Bones, not a question mark');
  // Bones's art ships in the addon folder: the square icon, the round portrait and its 64 px twin (the
  // Ember kit), and the old icon, which slot TOCs written before this one still name.
  for (const f of ['NeverQuestAlone.tga', 'NeverQuestAlone-portrait.tga', 'NeverQuestAlone-portrait-64.tga', 'BonesIcon.tga']) {
    assert.ok(fs.existsSync(path.join(ADDON_DIR, 'Media', f)), f);
    assert.ok(files.has(`NeverQuestAlone/Media/${f}`), `${f} in the zip`);
  }

  const tops = new Set([...files.keys()].map(n => n.split('/')[0]));
  assert.deepEqual([...tops].sort(), ['NeverQuestAlone', ...Array.from({ length: SLOT_COUNT }, (_, i) => slotName(i + 1))].sort(), 'only addon folders at the top');
  for (const name of files.keys()) assert.ok(!name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..'), `${name}: a plain relative path`);

  for (const f of listFiles(ADDON_DIR)) {
    const name = `NeverQuestAlone/${f.split(path.sep).join('/')}`;
    assert.ok(files.has(name), `${name} shipped`);
    assert.ok(files.get(name).data.equals(fs.readFileSync(path.join(ADDON_DIR, f))), `${name} unchanged`);
    assert.equal(files.get(name).mode, 0o100644);
  }
  for (const f of [...toc.files, 'Bindings.xml']) assert.ok(files.has(`NeverQuestAlone/${f}`), `${f} (the TOC and bindings) shipped`);
  assert.ok(files.get('NeverQuestAlone/LICENSE.txt').data.equals(fs.readFileSync(path.join(REPO, 'LICENSE'))), 'the licence ships inside, as the release job puts it');
  // Beside the art it doesn't cover, what the licence leaves out (systems critic OS-06).
  assert.match(files.get('NeverQuestAlone/NOTICE.txt').data.toString('utf8'), /^NeverQuestAlone's code is under the MIT license\. The license doesn't cover the name NeverQuestAlone or its artwork, the pictures in Media\/ among them/);

  for (const f of ['present', ...BELLS.map(b => `bell_${b}`)]) {
    const e = files.get(`NeverQuestAlone/sig/ctl/${f}.wav`);
    assert.ok(e, `doorbell ${f} ships, so the client sees it from the first load`);
    assert.equal(e.data.length, 0, 'a doorbell is a 0-byte file, as the bridge makes it');
  }

  for (let i = 1; i <= SLOT_COUNT; i++) {
    const n = slotName(i);
    const t = files.get(`${n}/${n}.toc`).data.toString('utf8');
    assert.equal(t, slotToc(i, built.iface));
    const f = readToc(t).fields;
    assert.equal(f.Interface, built.iface);
    // The same TOC as setup writes (E-047): under the one category row the addon folds, in a group of
    // its own (named alike and needing NeverQuestAlone, a slot would join NeverQuestAlone's group, 200 check boxes
    // under its row), with the addon's icon.
    assert.equal(f.Category, SLOT_CATEGORY, 'the AddOns list puts the slot under the parts\' category row');
    assert.equal(f.Group, n, 'a group of its own, never NeverQuestAlone\'s');
    assert.equal(f.IconTexture, SLOT_ICON, 'the addon\'s icon, not a question mark');
    assert.equal(f.Title, `NeverQuestAlone Part ${String(i).padStart(3, '0')}`);
    assert.equal(f.LoadOnDemand, '1');
    assert.equal(f.Dependencies, 'NeverQuestAlone');
    assert.equal(files.get(`${n}/Inbox.lua`).data.toString('utf8'), SLOT_PLACEHOLDER);
    assert.ok(files.get(`${n}/`).dir && files.get(`${n}/`).mode === 0o40755, `${n}/ is a folder`);
  }
  const folders = new Set(built.entries.flatMap(e => e.name.split('/').slice(0, -1).map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`)));
  assert.ok(folders.has('NeverQuestAlone/sig/ctl/') && folders.has(`${slotName(SLOT_COUNT)}/`));
  assert.equal(files.size, built.entries.length + folders.size, 'every file, plus a record for each folder');
  for (const f of folders) assert.ok(files.get(f)?.dir, `${f} has its folder record`);
});

test('unpacked, it is exactly what the app\'s setup makes, so setup changes nothing and WoW needs no restart', () => {
  const addons = tmp('nqa-pkg-');
  extract(unzip(built.buf), addons);
  const before = listFiles(addons);
  const stamp = new Map(before.map(f => [f, fs.readFileSync(path.join(addons, f))]));
  assert.deepEqual(installSlots(addons, { iface: built.iface }), { created: 0, rewritten: 0, kept: SLOT_COUNT });
  assert.deepEqual(listFiles(addons), before, 'no file added');
  for (const [f, data] of stamp) assert.ok(fs.readFileSync(path.join(addons, f)).equals(data), `${f} untouched`);
});

test('a build is reproducible, and a standard unzip agrees', (t) => {
  assert.ok(zip(addonEntries().entries).equals(built.buf), 'same input, same bytes');
  const other = zip(built.entries, { date: new Date(Date.UTC(2030, 5, 15, 12, 30, 42)) });
  assert.ok(!other.equals(built.buf), 'the date is the build date');
  assert.throws(() => zip([{ name: '../x', data: Buffer.alloc(0) }]), /bad zip name/);
  assert.throws(() => zip([{ name: 'a/b', data: Buffer.alloc(1) }, { name: 'a/b', data: Buffer.alloc(1) }]), /two files/);

  const dir = tmp('nqa-pkgcli-');
  const r = spawnSync(process.execPath, [path.join(REPO, 'tools', 'package-addon.mjs'), '--out', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const file = path.join(dir, `NeverQuestAlone-${built.version}.zip`);
  assert.ok(fs.readFileSync(file).equals(built.buf), 'the command writes the same zip');
  assert.match(r.stdout, new RegExp(`: ${built.entries.length} files, `));
  assert.deepEqual(packageAddon({ outDir: dir }).file, file);
  const named = spawnSync(process.execPath, [path.join(REPO, 'tools', 'package-addon.mjs'), '--out', dir, '--name', 'NeverQuestAlone-addon-1.2.3.zip'], { encoding: 'utf8' });
  assert.equal(named.status, 0, named.stderr);
  assert.ok(fs.readFileSync(path.join(dir, 'NeverQuestAlone-addon-1.2.3.zip')).equals(built.buf), 'the release job\'s name, the same zip');
  assert.equal(spawnSync(process.execPath, [path.join(REPO, 'tools', 'package-addon.mjs'), '--out', dir, '--name', '../x.zip']).status, 2, 'a name is a file name, never a path');

  const u = spawnSync('unzip', ['-tq', file], { encoding: 'utf8' });
  if (u.error) { t.diagnostic('no unzip on this machine; the reader above checked the zip'); return; }
  assert.equal(u.status, 0, u.stdout + u.stderr);
});
