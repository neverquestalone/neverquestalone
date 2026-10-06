// The single-bridge lock (bridge/byok/lock.mjs; public BYOK PRD §8.1, §11.1; BUILD-PLAN "boot.mjs"
// step 5): one bridge per AddOns folder, whoever runs it. The lock is per real folder (a symlinked
// path shares its target's), and the developer command line's `start` refuses
// while the app serves the folder. Temp folders only; the CLI runs in a child process with HOME and
// its data folder in a temp folder, no capture, and is refused before it publishes anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockFileFor, publicPaths } from '../../bridge/byok/paths.mjs';
import { takeBridgeLock } from '../../bridge/byok/boot.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bridge', 'nqa.mjs');
// The developer command line (bridge/nqa.mjs; the source export carries it too). These cases plant a
// symlink and a lock with a uid, which Windows can't do as they're written.
const NO_CLI = process.platform === 'win32' ? 'a symlinked AddOns path and a uid in the lock (POSIX)'
  : !fs.existsSync(CLI) ? 'no bridge/nqa.mjs here (a tree without the developer command line)' : false;
const NO_SYMLINKS = process.platform === 'win32' ? 'it plants symlinks, which take an administrator or Developer Mode to make on Windows' : false;
const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const DEAD = 2 ** 22 + 54321;

test('lockFileFor: a symlinked path to the AddOns folder shares its target\'s lock', { skip: NO_SYMLINKS }, () => {
  const root = tmp('bones-lock-');
  const real = path.join(root, 'World of Warcraft', '_forever_', 'Interface', 'AddOns');
  fs.mkdirSync(real, { recursive: true });
  fs.symlinkSync(path.join(root, 'World of Warcraft'), path.join(root, 'wow-link'));
  const linked = path.join(root, 'wow-link', '_forever_', 'Interface', 'AddOns');
  assert.equal(lockFileFor('/s', linked), lockFileFor('/s', real));
  assert.equal(lockFileFor('/s', `${real}/`), lockFileFor('/s', real));
  // A folder that isn't there yet resolves through its nearest existing parent.
  assert.equal(lockFileFor('/s', path.join(root, 'wow-link', '_classic_beta_', 'Interface', 'AddOns')), lockFileFor('/s', path.join(root, 'World of Warcraft', '_classic_beta_', 'Interface', 'AddOns')));
  assert.notEqual(lockFileFor('/s', path.join(root, 'World of Warcraft', '_classic_beta_', 'Interface', 'AddOns')), lockFileFor('/s', real));
});

test('lockHolder: the live pid a lock names (a bare pid or {pid}); a dead pid, this process or junk is none', async () => {
  const { lockHolder } = await import('../../bridge/byok/lock.mjs');
  const dir = tmp('bones-lock-');
  const f = path.join(dir, 'x.lock');
  assert.equal(lockHolder(f), null, 'no file');
  fs.writeFileSync(f, String(process.ppid));
  assert.equal(lockHolder(f), process.ppid);
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, addonsDir: '/a' }));
  assert.equal(lockHolder(f), process.ppid);
  fs.writeFileSync(f, JSON.stringify({ pid: DEAD }));
  assert.equal(lockHolder(f), null, 'a crashed run');
  fs.writeFileSync(f, String(process.pid));
  assert.equal(lockHolder(f), null, 'our own');
  fs.writeFileSync(f, 'not a lock');
  assert.equal(lockHolder(f), null);
});

/** The developer command line's `start` in a sandbox: HOME, its data folder and the WoW folder all in temp, the addon installed. */
async function cliStart(t, { holdPublicLock, before = null }) {
  const { installAddon } = await import('../../bridge/byok/wow.mjs');
  const home = tmp('bones-cli-');
  const flavorDir = path.join(home, 'World of Warcraft', '_forever_');
  const addonsDir = path.join(flavorDir, 'Interface', 'AddOns');
  fs.mkdirSync(addonsDir, { recursive: true });
  assert.equal(installAddon({ flavorDir, running: false, slots: 3 }).ok, true);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const k of ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'APPDATA', 'LOCALAPPDATA', 'NQA_API_KEY']) delete env[k];
  before?.({ flavorDir, addonsDir, home });
  const pub = publicPaths({ platform: process.platform, env, home });
  let holder = null;
  if (holdPublicLock) {
    // The app (this test process stands in for it) serves the folder, through a linked path: its one
    // lock is the AddOns folder's (code health BR-27), which the linked path reaches too.
    fs.symlinkSync(path.join(home, 'World of Warcraft'), path.join(home, 'wow-link'));
    const linked = path.join(home, 'wow-link', '_forever_', 'Interface', 'AddOns');
    holder = takeBridgeLock({ lockDir: pub.state, addonsDir: linked });
    assert.equal(holder.folder, true);
  }
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'start', '--wow', flavorDir, '--data', path.join(home, 'data'), '--no-capture'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  holder?.();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const inbox = path.join(addonsDir, 'NeverQuestAlone', 'Inbox.lua');
  return { ...r, home, addonsDir, ownLock: lockFileFor(pub.state, addonsDir),
    published: () => fs.existsSync(inbox) && /Written by the NeverQuestAlone app/.test(fs.readFileSync(inbox, 'utf8')) };
}

test('the developer command line\'s `start` refuses while the app\'s bridge serves the same AddOns folder (through a linked path)', { skip: NO_CLI }, async (t) => {
  const r = await cliStart(t, { holdPublicLock: true });
  assert.equal(r.code, 3, `${r.out}\n${r.err}`);
  assert.match(r.err, new RegExp(`Another copy of NeverQuestAlone is already serving this World of Warcraft folder \\(pid ${process.pid}\\)`));
  assert.equal(fs.existsSync(r.ownLock), false, 'it took no lock of its own');
  assert.equal(r.published(), false, 'and published nothing into AddOns');
});

test('a lock written before this computer last started is stale, whatever live pid it names (final review L3-6)', async () => {
  const { lockHolder, bootTime, BOOT_MARGIN_MS } = await import('../../bridge/byok/lock.mjs');
  const dir = tmp('bones-lock-');
  const f = path.join(dir, 'x.lock');
  const bootAt = bootTime();
  const before = new Date(bootAt - BOOT_MARGIN_MS - 3600e3);
  // A power loss left the lock; at the next login its pid belongs to another live process.
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: before.toISOString() }));
  assert.equal(lockHolder(f), null, '{pid, at} from before the restart');
  fs.writeFileSync(f, String(process.ppid)); // a bare pid: its mtime says when
  fs.utimesSync(f, before, before);
  assert.equal(lockHolder(f), null, 'a bare pid written before the restart');
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }));
  assert.equal(lockHolder(f), process.ppid, 'one written since is live');
  // takeBridgeLock takes such a lock over instead of refusing the start.
  const lockDir = tmp('bones-lock-');
  const addonsDir = tmp('bones-addons-');
  fs.writeFileSync(lockFileFor(lockDir, addonsDir), JSON.stringify({ pid: process.ppid, addonsDir, at: before.toISOString() }));
  const release = takeBridgeLock({ lockDir, addonsDir });
  assert.equal(JSON.parse(fs.readFileSync(lockFileFor(lockDir, addonsDir), 'utf8')).pid, process.pid);
  release();
});

test('the heartbeat (SY-12): a crashed app\'s lock whose pid another live process now has is taken over once it stops beating (2 min), not at the next reboot; a beating one refuses; one with no hb keeps the pid rule', async () => {
  const { lockHolder, takeFolderLock, folderLockFile, HEARTBEAT_MS, STALE_MS } = await import('../../bridge/byok/lock.mjs');
  assert.deepEqual([HEARTBEAT_MS, STALE_MS], [30_000, 120_000]);
  const dir = tmp('bones-lock-');
  const f = path.join(dir, 'x.lock');
  const ago = ms => new Date(Date.now() - ms).toISOString();
  // A system process and our parent are alive: a reused pid, as after a crash. The system one is
  // pid 1 (init, launchd) on POSIX and pid 4 (System) on Windows, which has no pid 1.
  const SYSTEM_PID = process.platform === 'win32' ? 4 : 1;
  for (const pid of [SYSTEM_PID, process.ppid]) {
    fs.writeFileSync(f, JSON.stringify({ pid, at: ago(STALE_MS + 5000), hb: 30 }));
    assert.equal(lockHolder(f), null, `pid ${pid}: silent for over 2 minutes is stale`);
    fs.writeFileSync(f, JSON.stringify({ pid, at: ago(40_000), hb: 30 }));
    assert.equal(lockHolder(f), pid, `pid ${pid}: a beat 40 s ago is live`);
  }
  // Written 20 minutes ago by a computer that has run longer than that (a CI machine may have started
  // minutes ago, and a lock from before the start is the boot rule's, tested above).
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: ago(STALE_MS * 10) }));
  assert.equal(lockHolder(f, { bootAt: Date.now() - STALE_MS * 100 }), process.ppid, 'no hb (an older build\'s lock): the pid rule alone');
  // takeBridgeLock takes a crashed app's lock in the AddOns folder over (a live pid in it), and leaves
  // the one an older build kept in its state folder as it was: that one is only the fallback now
  // (code health BR-27: one lock, one heartbeat).
  const lockDir = tmp('bones-lock-');
  const addonsDir = tmp('bones-addons-');
  fs.mkdirSync(path.join(addonsDir, 'NeverQuestAlone', 'sig'), { recursive: true });
  const home = lockFileFor(lockDir, addonsDir);
  fs.mkdirSync(lockDir, { recursive: true });
  const homeText = JSON.stringify({ pid: SYSTEM_PID, addonsDir, at: ago(STALE_MS + 1000), hb: 30 });
  fs.writeFileSync(home, homeText);
  const folder = folderLockFile(addonsDir);
  fs.writeFileSync(folder, JSON.stringify({ pid: process.ppid, host: os.hostname(), at: ago(STALE_MS + 1000), by: 'nqa', hb: 30 }));
  const release = takeBridgeLock({ lockDir, addonsDir, beatMs: 40 });
  try {
    assert.equal(release.folder, true);
    const rec = JSON.parse(fs.readFileSync(folder, 'utf8'));
    assert.deepEqual([rec.pid, rec.hb], [process.pid, 1]);
    // It beats: the lock's at moves on while this process holds it.
    const first = Date.parse(rec.at);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(Date.parse(JSON.parse(fs.readFileSync(folder, 'utf8')).at) > first, 'rewritten');
    assert.deepEqual(fs.readdirSync(path.dirname(folder)).filter(n => n.endsWith('.beat')), [], 'no temp file left');
    assert.equal(fs.readFileSync(home, 'utf8'), homeText, 'the state folder\'s lock neither taken nor beaten');
    // While it beats, another bridge is refused, whatever the pid rule would say.
    assert.throws(() => takeFolderLock({ addonsDir, pid: process.pid + 1, alive: () => true }), e => e.code === 'BRIDGE_RUNNING');
  } finally { release(); }
  assert.equal(fs.existsSync(folder), false);
});

test('the idle heartbeat (SY-30): while WoW is closed the lock beats every minute and says so (hb 60), so a reader waits three of those beats (3 minutes) before calling it silent; never less than 2 minutes, and a lock can\'t name a slower beat to hold on longer', async () => {
  const { lockHolder, folderLockFile, IDLE_HEARTBEAT_MS, STALE_MS, silentAfterMs } = await import('../../bridge/byok/lock.mjs');
  assert.equal(IDLE_HEARTBEAT_MS, 60_000);
  assert.equal(silentAfterMs(30_000), STALE_MS, 'the running beat: 2 minutes, as before');
  assert.equal(silentAfterMs(60_000), 180_000, 'the idle beat: 3 minutes');
  assert.equal(silentAfterMs(86_400_000), 180_000, 'a slower beat counts as a minute');
  assert.equal(silentAfterMs(null), STALE_MS);
  const dir = tmp('bones-lock-');
  const f = path.join(dir, 'x.lock');
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const bootAt = Date.now() - 3600_000; // a computer that has run an hour (the boot rule is tested above)
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: ago(150_000), hb: 60 }));
  assert.equal(lockHolder(f, { bootAt }), process.ppid, '2.5 minutes after an idle beat: live');
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: ago(200_000), hb: 60 }));
  assert.equal(lockHolder(f, { bootAt }), null, 'three idle beats missed: silent');
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: ago(200_000), hb: 86400 }));
  assert.equal(lockHolder(f, { bootAt }), null, 'a lock that names a day\'s beat is held to a minute\'s');
  fs.writeFileSync(f, JSON.stringify({ pid: process.ppid, at: ago(3 * 60_000), hb: 30 }));
  assert.equal(lockHolder(f, { bootAt }), null, 'the running beat, 3 minutes silent: stale, as before');
  // The holder's side: pace() beats the lock at once with the new hb, then at that pace. One lock (code
  // health BR-27): the AddOns folder's, and none in the state folder.
  const lockDir = tmp('bones-lock-');
  const addonsDir = tmp('bones-addons-');
  fs.mkdirSync(path.join(addonsDir, 'NeverQuestAlone', 'sig'), { recursive: true });
  const file = folderLockFile(addonsDir);
  const release = takeBridgeLock({ lockDir, addonsDir, beatMs: 40 });
  try {
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(read().hb, 1);
    release.pace(5000); // slower (the app: a minute while WoW is closed)
    assert.equal(read().hb, 5, 'said at once, before the slower beat is due');
    const at = read().at;
    await new Promise(r => setTimeout(r, 200));
    assert.equal(read().at, at, 'and no beat meanwhile');
    release.pace(40); // WoW started again
    assert.equal(read().hb, 1);
    const again = Date.parse(read().at);
    await new Promise(r => setTimeout(r, 150));
    assert.ok(Date.parse(read().at) > again, 'it beats again');
    assert.equal(fs.existsSync(lockFileFor(lockDir, addonsDir)), false, 'no second lock to beat');
  } finally { release(); }
  assert.equal(fs.existsSync(file), false);
});

test('code health BR-27: one lock and one heartbeat: the AddOns folder\'s where it can be taken, refusing a live holder from any state folder; the state folder\'s only where it can\'t (no addon folder, a link where sig goes), refusing a second bridge of that state folder', async () => {
  const { folderLockFile } = await import('../../bridge/byok/lock.mjs');
  const lockDir = tmp('bones-lock-');
  const addonsDir = tmp('bones-addons-');
  fs.mkdirSync(path.join(addonsDir, 'NeverQuestAlone'), { recursive: true });
  const release = takeBridgeLock({ lockDir, addonsDir });
  try {
    assert.equal(release.folder, true);
    assert.equal(JSON.parse(fs.readFileSync(folderLockFile(addonsDir), 'utf8')).pid, process.pid);
    assert.equal(fs.existsSync(lockFileFor(lockDir, addonsDir)), false, 'none in the state folder');
    for (const dir of [lockDir, tmp('bones-lock-')]) {
      assert.throws(() => takeBridgeLock({ lockDir: dir, addonsDir, pid: process.pid + 1, alive: () => true }),
        e => e.code === 'BRIDGE_RUNNING' && /already serving this World of Warcraft folder \(pid \d+\)\. Only one copy/.test(e.message), dir);
      assert.equal(fs.existsSync(lockFileFor(dir, addonsDir)), false, 'a refused start takes no lock either');
    }
  } finally { release(); }
  assert.equal(fs.existsSync(folderLockFile(addonsDir)), false, 'released');
  // No addon folder there, or (where links can be made) a link where its sig folder goes: the state
  // folder's lock in its stead, with its own heartbeat.
  const bare = tmp('bones-addons-');
  const dirs = [bare];
  if (!NO_SYMLINKS) {
    const linked = tmp('bones-addons-');
    fs.mkdirSync(path.join(linked, 'NeverQuestAlone'));
    fs.symlinkSync(tmp('bones-victim-'), path.join(linked, 'NeverQuestAlone', 'sig'));
    dirs.push(linked);
  }
  for (const dir of dirs) {
    const r = takeBridgeLock({ lockDir, addonsDir: dir, beatMs: 40 });
    const home = lockFileFor(lockDir, dir);
    try {
      assert.equal(r.folder, false, dir);
      assert.equal(JSON.parse(fs.readFileSync(home, 'utf8')).pid, process.pid);
      r.pace(5000);
      assert.equal(JSON.parse(fs.readFileSync(home, 'utf8')).hb, 5, 'its own heartbeat, paced');
      assert.throws(() => takeBridgeLock({ lockDir, addonsDir: dir, pid: process.pid + 1, alive: () => true }),
        e => e.code === 'BRIDGE_RUNNING' && /already running for this World of Warcraft \(pid \d+\)\. Quit it first\./.test(e.message), dir);
    } finally { r(); }
    assert.equal(fs.existsSync(home), false, 'released');
  }
});

test('takeFolderLock: nothing without a real NeverQuestAlone folder, never through a link; refused for a live holder; a stale one is taken over', { skip: NO_SYMLINKS }, async () => {
  const { takeFolderLock, folderLockFile } = await import('../../bridge/byok/lock.mjs');
  const addonsDir = tmp('bones-addons-');
  assert.equal(takeFolderLock({ addonsDir }), null, 'no addon folder: nothing to lock');
  const victim = tmp('bones-victim-');
  fs.symlinkSync(victim, path.join(addonsDir, 'NeverQuestAlone'));
  assert.equal(takeFolderLock({ addonsDir }), null, 'a linked addon folder is not followed');
  assert.deepEqual(fs.readdirSync(victim), []);
  fs.rmSync(path.join(addonsDir, 'NeverQuestAlone'));
  fs.mkdirSync(path.join(addonsDir, 'NeverQuestAlone'));
  fs.symlinkSync(victim, path.join(addonsDir, 'NeverQuestAlone', 'sig'));
  assert.equal(takeFolderLock({ addonsDir }), null, 'nor a linked sig folder');
  assert.deepEqual(fs.readdirSync(victim), []);
  fs.rmSync(path.join(addonsDir, 'NeverQuestAlone', 'sig'));
  const release = takeFolderLock({ addonsDir });
  const file = folderLockFile(addonsDir);
  const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(rec.pid, process.pid);
  assert.equal(rec.by, 'nqa');
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  assert.throws(() => takeFolderLock({ addonsDir, pid: process.pid + 1, alive: () => true }), e => e.code === 'BRIDGE_RUNNING' && /Another copy of NeverQuestAlone is already serving this World of Warcraft folder/.test(e.message));
  release();
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ pid: DEAD, host: 'x' }));
  const again = takeFolderLock({ addonsDir });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'a dead pid\'s lock is taken over');
  again();
});

test('the developer command line\'s `start` refuses while another bridge holds the lock inside the AddOns folder, whatever HOME it ran under (final review L3-1)', { skip: NO_CLI }, async (t) => {
  const r = await cliStart(t, {
    holdPublicLock: false,
    before: ({ addonsDir }) => {
      // The app's bridge under another HOME (this test process stands in for it).
      fs.writeFileSync(path.join(addonsDir, 'NeverQuestAlone', 'sig', 'bridge.lock'), JSON.stringify({ pid: process.pid, uid: process.getuid(), host: os.hostname(), at: new Date().toISOString(), by: 'nqa' }));
    },
  });
  assert.equal(r.code, 3, `${r.out}\n${r.err}`);
  assert.match(r.err, new RegExp(`Another copy of NeverQuestAlone is already serving this World of Warcraft folder \\(pid ${process.pid}\\)`));
  assert.equal(fs.existsSync(r.ownLock), false, 'it took no lock of its own');
  assert.equal(r.published(), false, 'and published nothing');
});

test('code health BR-17: the lock in the AddOns folder names no computer or account in the clear (a salted hash of each), and still tells this computer\'s lock from another\'s and another account\'s', async () => {
  const { takeFolderLock, folderLockFile } = await import('../../bridge/byok/lock.mjs');
  const addonsDir = tmp('bones-addons-');
  fs.mkdirSync(path.join(addonsDir, 'NeverQuestAlone', 'sig'), { recursive: true });
  const file = folderLockFile(addonsDir);
  const host = 'Somebodys-MacBook-Pro.local';
  const release = takeFolderLock({ addonsDir, host, uid: 501 });
  try {
    const text = fs.readFileSync(file, 'utf8');
    const rec = JSON.parse(text);
    assert.ok(!text.includes('Somebody') && !text.includes('MacBook') && !/"uid"\s*:\s*501/.test(text), text);
    assert.equal(rec.host, undefined, 'no host name');
    assert.equal(rec.uid, undefined, 'no uid');
    assert.match(rec.salt, /^[0-9a-f]{32}$/);
    assert.match(rec.hostHash, /^[0-9a-f]{64}$/);
    assert.match(rec.uidHash, /^[0-9a-f]{64}$/);
    // This computer, the same account: held.
    assert.throws(() => takeFolderLock({ addonsDir, host, uid: 501, pid: process.pid + 1, alive: () => true }),
      e => e.code === 'BRIDGE_RUNNING' && /\(pid \d+\)\. Only one copy/.test(e.message));
    // This computer, another account: held, and said so.
    assert.throws(() => takeFolderLock({ addonsDir, host, uid: 502, pid: process.pid + 1, alive: () => true }),
      e => e.code === 'BRIDGE_RUNNING' && /under another account on this computer/.test(e.message));
  } finally { release(); }
  assert.equal(fs.existsSync(file), false, 'released by the one that took it');
  // Another computer's (an AddOns folder on a shared drive): its pid can't be checked here, so it's taken over.
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, salt: 'ab'.repeat(16), hostHash: 'cd'.repeat(32), at: new Date().toISOString(), by: 'nqa', hb: 30 }));
  const mine = takeFolderLock({ addonsDir, host, uid: 501, alive: () => true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'another computer\'s lock is taken over');
  // A lock from before (its host in the clear) is still read: this computer's holds.
  mine();
  fs.writeFileSync(file, JSON.stringify({ pid: process.ppid, uid: 501, host, at: new Date().toISOString(), by: 'nqa', hb: 30 }));
  assert.throws(() => takeFolderLock({ addonsDir, host, uid: 501, alive: () => true }), e => e.code === 'BRIDGE_RUNNING');
  fs.rmSync(file, { force: true });
});
