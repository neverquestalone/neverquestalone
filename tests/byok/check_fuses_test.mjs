// The Electron fuse check (tools/check-fuses.mjs; PRD §11.2, SC-9). Synthetic
// binaries only: a sentinel, a version and length byte, and the fuse bytes, as
// @electron/fuses writes them. No network, no Electron.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SENTINEL, FUSES, REQUIRED, PLANNED, planCoversPrd, readWires, checkWires, fuseFiles, run, defaultAppIn } from '../../tools/check-fuses.mjs';

const OFF = 0x30, ON = 0x31, REMOVED = 0x72;
// A wire with the given states by name; the rest as Electron ships them.
function wire(states = {}, { version = 1, length = FUSES.length } = {}) {
  const shipped = { RunAsNode: ON, EnableCookieEncryption: OFF, EnableNodeOptionsEnvironmentVariable: ON, EnableNodeCliInspectArguments: ON,
    EnableEmbeddedAsarIntegrityValidation: OFF, OnlyLoadAppFromAsar: OFF, LoadBrowserProcessSpecificV8Snapshot: OFF, GrantFileProtocolExtraPrivileges: ON, WasmTrapHandlers: OFF };
  const bytes = FUSES.slice(0, length).map(n => states[n] ?? shipped[n]);
  return Buffer.concat([SENTINEL, Buffer.from([version, length, ...bytes])]);
}
const FLIPPED = { RunAsNode: OFF, EnableNodeOptionsEnvironmentVariable: OFF, EnableNodeCliInspectArguments: OFF, EnableEmbeddedAsarIntegrityValidation: ON, OnlyLoadAppFromAsar: ON, GrantFileProtocolExtraPrivileges: OFF, EnableCookieEncryption: ON };
const binary = (...wires) => Buffer.concat([Buffer.alloc(64, 7), ...wires.flatMap(w => [w, Buffer.alloc(33, 1)])]);

function capture(argv) {
  const out = [], err = [];
  const code = run(argv, { stdout: s => out.push(s), stderr: s => err.push(s) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'check-fuses-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('the required fuses are the five PRD §11.2 names and the file-protocol privileges (off, C3 review)', () => {
  assert.deepEqual(REQUIRED, { RunAsNode: 'off', EnableNodeOptionsEnvironmentVariable: 'off', EnableNodeCliInspectArguments: 'off', EnableEmbeddedAsarIntegrityValidation: 'on', OnlyLoadAppFromAsar: 'on', GrantFileProtocolExtraPrivileges: 'off' });
  assert.equal(FUSES.indexOf('RunAsNode'), 0);
  assert.equal(FUSES.indexOf('OnlyLoadAppFromAsar'), 5);
});

test('readWires and checkWires: a flipped wire passes; Electron defaults fail, naming each fuse', () => {
  const good = readWires(binary(wire(FLIPPED)));
  assert.equal(good.length, 1);
  assert.equal(good[0].offset, 64);
  assert.equal(good[0].fuses.RunAsNode, 'off');
  assert.deepEqual(checkWires(good), []);
  const shipped = checkWires(readWires(binary(wire())));
  assert.deepEqual(shipped, [
    'wire: RunAsNode is on, expected off',
    'wire: EnableNodeOptionsEnvironmentVariable is on, expected off',
    'wire: EnableNodeCliInspectArguments is on, expected off',
    'wire: EnableEmbeddedAsarIntegrityValidation is off, expected on',
    'wire: OnlyLoadAppFromAsar is off, expected on',
    'wire: GrantFileProtocolExtraPrivileges is on, expected off',
  ]);
  // A build with only the file-protocol fuse back on fails the release gate too.
  assert.deepEqual(checkWires(readWires(binary(wire({ ...FLIPPED, GrantFileProtocolExtraPrivileges: ON })))), ['wire: GrantFileProtocolExtraPrivileges is on, expected off']);
});

test('a universal binary: both slices are checked, and one bad slice fails', () => {
  assert.deepEqual(checkWires(readWires(binary(wire(FLIPPED), wire(FLIPPED)))), []);
  const half = checkWires(readWires(binary(wire(FLIPPED), wire({ ...FLIPPED, RunAsNode: ON }))));
  assert.deepEqual(half, ['wire 2 of 2: RunAsNode is on, expected off']);
  assert.match(checkWires(readWires(binary(wire(FLIPPED), wire(FLIPPED), wire(FLIPPED)))).join(), /3 fuse wires/);
});

test('no wire, a short wire, a removed fuse or another version all fail', () => {
  assert.match(checkWires(readWires(Buffer.alloc(100))).join(), /no fuse wire found/);
  assert.match(checkWires(readWires(binary(wire(FLIPPED, { length: 4 })))).join(), /OnlyLoadAppFromAsar is missing/);
  assert.match(checkWires(readWires(binary(wire({ ...FLIPPED, RunAsNode: REMOVED })))).join(), /RunAsNode is removed/);
  assert.match(checkWires(readWires(binary(wire(FLIPPED, { version: 2 })))).join(), /version 2, expected 1/);
});

test('paths: an .app reads its Electron Framework; an unpacked folder, each file with a wire', (t) => {
  const d = tmpdir(t);
  const app = path.join(d, 'NeverQuestAlone.app');
  const fw = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  fs.mkdirSync(path.dirname(fw), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(fw, binary(wire(FLIPPED), wire(FLIPPED)));
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'NeverQuestAlone'), Buffer.alloc(10));
  assert.deepEqual(fuseFiles(app), [fw]);
  assert.deepEqual(fuseFiles(path.join(app, 'Contents', 'MacOS', 'NeverQuestAlone')), [fw]);
  const unpacked = path.join(d, 'win-unpacked');
  fs.mkdirSync(path.join(unpacked, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'NeverQuestAlone.exe'), binary(wire(FLIPPED)));
  fs.writeFileSync(path.join(unpacked, 'ffmpeg.dll'), Buffer.alloc(50));
  fs.writeFileSync(path.join(unpacked, 'resources', 'app.asar'), binary(wire()));
  assert.deepEqual(fuseFiles(unpacked), [path.join(unpacked, 'NeverQuestAlone.exe')]);
  fs.mkdirSync(path.join(d, 'plain'));
  fs.writeFileSync(path.join(d, 'plain', 'readme.txt'), 'no wire here');
  assert.throws(() => fuseFiles(path.join(d, 'plain')), /no file .* carries a fuse wire/);
  assert.throws(() => fuseFiles(path.join(d, 'missing')), /not found/);
});

test('one checker: the gate asserts the app\'s whole plan (fuses.cjs FUSE_PLAN), which must cover the PRD; cookie encryption too', (t) => {
  assert.deepEqual({ ...PLANNED }, {
    RunAsNode: 'off', EnableNodeOptionsEnvironmentVariable: 'off', EnableNodeCliInspectArguments: 'off', OnlyLoadAppFromAsar: 'on',
    EnableEmbeddedAsarIntegrityValidation: 'on', GrantFileProtocolExtraPrivileges: 'off', EnableCookieEncryption: 'on',
  });
  assert.deepEqual(planCoversPrd(), []);
  assert.deepEqual(planCoversPrd({ ...PLANNED, RunAsNode: 'on' }), ['RunAsNode: the plan says on, the PRD off']);
  const d = tmpdir(t);
  const noCookies = path.join(d, 'no-cookies');
  fs.writeFileSync(noCookies, binary(wire({ ...FLIPPED, EnableCookieEncryption: OFF })));
  const r = capture([noCookies]);
  assert.equal(r.code, 1);
  assert.match(r.err, /EnableCookieEncryption is off, expected on/);
  const weak = run([noCookies], { stdout: () => {}, stderr: () => {}, planned: { ...PLANNED, RunAsNode: 'on' } });
  assert.equal(weak, 1, 'a plan weaker than the PRD fails by itself');
  assert.equal(fs.existsSync(path.join(import.meta.dirname, '..', '..', 'app', 'desktop', 'scripts', 'check-fuses.mjs')), false, 'the second checker is gone');
});

test('cli: exit 0 when flipped, 1 when not (printing each state), 2 on usage', (t) => {
  const d = tmpdir(t);
  const good = path.join(d, 'good');
  const bad = path.join(d, 'bad');
  fs.writeFileSync(good, binary(wire(FLIPPED), wire(FLIPPED)));
  fs.writeFileSync(bad, binary(wire(FLIPPED), wire({ ...FLIPPED, OnlyLoadAppFromAsar: OFF })));
  let r = capture([good]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.split('\n').filter(l => l.includes('RunAsNode=off')).length, 2);
  assert.match(r.out, /PASS/);
  r = capture([good, bad]);
  assert.equal(r.code, 1);
  assert.match(r.err, /bad: wire 2 of 2: OnlyLoadAppFromAsar is off, expected on/);
  assert.match(r.out, /FAIL/);
  assert.equal(capture([path.join(d, 'nope')]).code, 1);
  assert.equal(capture([]).code, 2);
  assert.equal(capture(['--read']).code, 2);
});

test('W(d): Electron\'s stock default_app.asar never ships: afterPack drops it from Resources (Mac and unpacked alike), and the gate fails a build that still has it', (t) => {
  const d = tmpdir(t);
  const hooks = createRequire(import.meta.url)(path.join(import.meta.dirname, '..', '..', 'app', 'desktop', 'scripts', 'fuses.cjs'));
  assert.equal(hooks.DEFAULT_APP, 'default_app.asar');
  // A Mac app and a Windows unpacked folder as electron-builder leaves them, with a flipped wire.
  const app = path.join(d, 'NeverQuestAlone.app');
  const fw = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
  fs.mkdirSync(path.dirname(fw), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(fw, binary(wire(FLIPPED)));
  const unpacked = path.join(d, 'win-unpacked');
  fs.mkdirSync(path.join(unpacked, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(unpacked, 'NeverQuestAlone.exe'), binary(wire(FLIPPED)));
  for (const res of [path.join(app, 'Contents', 'Resources'), path.join(unpacked, 'resources')]) {
    fs.writeFileSync(path.join(res, 'app.asar'), 'the app');
    fs.writeFileSync(path.join(res, 'default_app.asar'), 'Electron\'s default app');
  }
  let r = capture([app, unpacked]);
  assert.equal(r.code, 1, 'the gate fails while it ships');
  assert.match(r.err, /Contents[\\/]Resources[\\/]default_app\.asar: Electron's default app ships/);
  assert.match(r.err, /resources[\\/]default_app\.asar: Electron's default app ships/);
  assert.ok(defaultAppIn(`${app}/`), 'a trailing slash reads the same');
  // afterPack's step: gone, the app's own asar kept, and a second run changes nothing.
  for (const res of [path.join(app, 'Contents', 'Resources'), path.join(unpacked, 'resources')]) {
    assert.equal(hooks.dropDefaultApp(res), true);
    assert.equal(hooks.dropDefaultApp(res), false);
    assert.deepEqual(fs.readdirSync(res), ['app.asar']);
  }
  r = capture([app, unpacked]);
  assert.equal(r.code, 0, r.err);
  assert.equal(defaultAppIn(app), null);
  // afterPack calls it for every pack, the halves of a universal build included (they must stay identical).
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'app', 'desktop', 'scripts', 'fuses.cjs'), 'utf8');
  const body = src.slice(src.indexOf('async function afterPack'));
  assert.ok(body.indexOf('dropDefaultApp(resources)') > 0 && body.indexOf('dropDefaultApp(resources)') < body.indexOf('if (universalHalf(context))'));
});
