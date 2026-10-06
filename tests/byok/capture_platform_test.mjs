// bridge/transport/capture.mjs (PRD §11.1, §11.3; PF-1, PF-6, PF-7; SC-2, TH11):
// the bundle id's single source, the code requirement that replaced the
// certificate-name check (built, parsed by the real codesign on macOS, and
// enforced before launch), the macOS launcher's unchanged
// behavior, the Windows helper on stdout (no pipe, token or launch-time signature
// check: systems plan Batch 1, SY-07), the X11 script's arguments, relaunching a
// helper that fails to start, UTF-8 split across reads, and the per-OS
// dispatcher. Child processes are mocks, except where a real spawn is the point
// (a stand-in helper that answers on stdout and exits when stdin ends); sockets
// are real, in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import {
  CAPTURE_BUNDLE_ID, IDENTITY_NAME, buildRequirement, verifyRequirement, localCertRoots, readBundleId, checkCaptureApp,
  createCapture, createWindowsCapture, createX11Capture, createCaptureForPlatform, createLineHandler, lineSplitter,
  bundleExecutable, STATS_SEC, RETRY_MS, BUSY_REPEAT_MS, checkPeer, PEER_CHECK_MS, PEER_CHECKS_MAX,
} from '../../bridge/transport/capture.mjs';
import * as captureModule from '../../bridge/transport/capture.mjs';
import { buildPlan } from '../../bridge/capture/build.mjs';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const MAC = path.join(REPO, 'bridge', 'capture', 'mac');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcap-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ROOT = '5eed0000c0ffee00000000000000000000001234';
const OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECURITY_OUT = [
  'SHA-256 hash: 2222222222222222222222222222222222222222222222222222222222222222',
  `SHA-1 hash: ${ROOT.toUpperCase()}`,
  'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
  'attributes:',
  `    "alis"<blob>="${IDENTITY_NAME}"`,
  `    "labl"<blob>="${IDENTITY_NAME}"`,
  'SHA-256 hash: 1111111111111111111111111111111111111111111111111111111111111111',
  `SHA-1 hash: ${OTHER.toUpperCase()}`,
  'keychain: "/Users/x/Library/Keychains/login.keychain-db"',
  'attributes:',
  `    "alis"<blob>="Evil ${IDENTITY_NAME} Copy"`,
  `    "labl"<blob>="Evil ${IDENTITY_NAME} Copy"`,
  '',
].join('\n');

const unixOnly = process.platform === 'win32' ? 'the macOS launcher listens on a unix socket' : false;

const until = async (cond, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 5));
  }
};

/** A spawnSync stand-in: `security` lists certificates, `codesign --verify` passes when `accept(req)` says so. */
function fakeRun({ security = SECURITY_OUT, accept = () => true } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'security') return { status: 0, stdout: security, stderr: '' };
    if (cmd === 'codesign' && args[0] === '--verify') {
      const req = args[args.indexOf('-R') + 1].slice(1);
      return accept(req, args[args.length - 1]) ? { status: 0, stdout: '', stderr: '' }
        : { status: 3, stdout: '', stderr: 'test-requirement: code failed to satisfy specified code requirement(s)' };
    }
    if (cmd === 'codesign') return { status: 0, stdout: '', stderr: 'Identifier=x\nSignature=adhoc\n' };
    return { status: 1, stdout: '', stderr: '' };
  };
  return { run, calls };
}

function fakeChild() {
  const c = new EventEmitter();
  c.stdin = { written: '', ended: false, on() {}, end(d) { this.written += d ?? ''; this.ended = true; } };
  c.stderr = new EventEmitter();
  c.stdout = new EventEmitter();
  c.killed = false;
  c.kill = () => { c.killed = true; setImmediate(() => { c.emit('exit', null, 'SIGTERM'); c.emit('close', null, 'SIGTERM'); }); };
  return c;
}

/** A child whose spawn fails the way Node reports it: 'error', then 'close', never 'exit'. */
function failedChild(code = 'ENOENT') {
  const c = fakeChild();
  setImmediate(() => { c.emit('error', Object.assign(new Error(`spawn ${code}`), { code })); c.emit('close', -2, null); });
  return c;
}

function recorder() {
  const ev = { payloads: [], games: [], errors: [], logs: [], statuses: [] };
  return {
    ev,
    cbs: {
      onPayload: p => ev.payloads.push(p), onGame: g => ev.games.push(g), onError: e => ev.errors.push(e),
      onStatus: s => ev.statuses.push(s), log: (tag, data) => ev.logs.push([tag, data]),
    },
  };
}

// ---------------------------------------------------------------- one bundle id

test('the bundle id has one source, read by capture.mjs, build-app.sh, Info.plist and main.swift', () => {
  const id = fs.readFileSync(path.join(MAC, 'BUNDLE_ID'), 'utf8').trim();
  assert.equal(CAPTURE_BUNDLE_ID, id);
  assert.equal(readBundleId(), id);
  const gen = fs.readFileSync(path.join(MAC, 'Sources', 'NQACapture', 'BundleID.swift'), 'utf8');
  assert.ok(gen.includes(`let captureBundleId = "${id}"`), 'BundleID.swift is stale: run bridge/capture/mac/build-app.sh');
  const main = fs.readFileSync(path.join(MAC, 'Sources', 'NQACapture', 'main.swift'), 'utf8');
  assert.match(main, /Bundle\.main\.bundleIdentifier == captureBundleId/);
  const plist = fs.readFileSync(path.join(MAC, 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleIdentifier<\/key>\s*<string>__BUNDLE_ID__<\/string>/);
  const build = fs.readFileSync(path.join(MAC, 'build-app.sh'), 'utf8');
  assert.match(build, /PRIVATE_ID="\$\(readid "\$HERE\/BUNDLE_ID"\)"/);
  assert.match(build, /id="\$\(tr -d '\[:space:\]' < "\$1"\)"/);
  assert.match(build, /s\/__BUNDLE_ID__\/\$BUNDLE_ID\/g/);
  // NeverQuestAlone's helper (--public): its own id, from the file the packaged app carries, its
  // own output and Swift build folders (final review L3-4).
  const publicId = fs.readFileSync(path.join(MAC, '..', '..', '..', 'app', 'desktop', 'build', 'bridge', 'capture', 'mac', 'BUNDLE_ID'), 'utf8').trim();
  assert.notEqual(publicId, id);
  assert.match(build, /PUBLIC_ID="\$\(readid "\$HERE\/\.\.\/\.\.\/\.\.\/app\/desktop\/build\/bridge\/capture\/mac\/BUNDLE_ID"\)"/);
  assert.match(build, /OUT="\$HERE\/build-public"/);
  assert.match(build, /SWIFT_ARGS=\(--scratch-path "\$HERE\/\.build-public" -Xswiftc -DNQA_PUBLIC_ID\)/);
  assert.ok(gen.includes(`#if NQA_PUBLIC_ID\nlet captureBundleId = "${publicId}"\n#else\nlet captureBundleId = "${id}"\n#endif`), 'BundleID.swift is stale: run bridge/capture/mac/build-app.sh');
  for (const [name, text] of [['main.swift', main], ['Info.plist', plist], ['build-app.sh', build]]) {
    assert.ok(!text.includes(id), `${name} still hard-codes ${id}`);
  }
  assert.throws(() => readBundleId(path.join(TMP, 'nope')), /ENOENT/);
  fs.writeFileSync(path.join(TMP, 'BAD_ID'), 'com.x" or anchor apple\n');
  assert.throws(() => readBundleId(path.join(TMP, 'BAD_ID')), /not a bundle id/);
});

// ---------------------------------------------------------------- the code requirement

test('the requirement: bundle id and the local identity\'s certificate root, or a Developer ID team', () => {
  assert.equal(buildRequirement({ certRoots: [ROOT.toUpperCase()] }),
    `identifier "${CAPTURE_BUNDLE_ID}" and (certificate root = H"${ROOT}")`);
  const team = buildRequirement({ teamId: 'ABCDE12345' });
  assert.equal(team, `identifier "${CAPTURE_BUNDLE_ID}" and ((anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and `
    + 'certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "ABCDE12345"))');
  const both = buildRequirement({ bundleId: 'org.example.cap', certRoots: [ROOT], teamId: 'ABCDE12345' });
  assert.match(both, /^identifier "org\.example\.cap" and \(certificate root = H"5eed[0-9a-f]+" or \(anchor apple generic and .*"ABCDE12345"\)\)$/);
});

test('the requirement refuses input that could change its meaning, and an empty signer list', () => {
  assert.throws(() => buildRequirement({ teamId: 'abcde12345' }), /10-character Apple team ID/);
  assert.throws(() => buildRequirement({ teamId: 'ABCDE1234"' }), /team ID/);
  assert.throws(() => buildRequirement({ teamId: 'ABCDE12345" or anchor apple' }), /team ID/);
  assert.throws(() => buildRequirement({ certRoots: ['xyz'] }), /bad certificate hash/);
  assert.throws(() => buildRequirement({ certRoots: [ROOT + '"'] }), /bad certificate hash/);
  assert.throws(() => buildRequirement({ bundleId: 'a" or anchor apple or identifier "b', certRoots: [ROOT] }), /bad bundle id/);
  assert.throws(() => buildRequirement({}), /no signer to accept/);
});

test('the local identity is found by its exact name, not a look-alike', () => {
  const { run, calls } = fakeRun();
  assert.deepEqual(localCertRoots(IDENTITY_NAME, run), [ROOT]);
  assert.deepEqual(calls[0], ['security', 'find-certificate', '-a', '-c', IDENTITY_NAME, '-Z']);
  assert.deepEqual(localCertRoots(IDENTITY_NAME, () => ({ status: 44, stdout: '' })), []);
  assert.deepEqual(localCertRoots(IDENTITY_NAME, () => ({ status: 0, stdout: '' })), []);
});

test('verifyRequirement runs codesign --verify --strict -R "=<requirement>"', () => {
  const { run, calls } = fakeRun({ accept: req => req.includes(ROOT) });
  const req = buildRequirement({ certRoots: [ROOT] });
  assert.equal(verifyRequirement('/x/App.app', req, run).ok, true);
  assert.deepEqual(calls[0], ['codesign', '--verify', '--strict', '-R', '=' + req, '/x/App.app']);
  const bad = verifyRequirement('/x/App.app', buildRequirement({ certRoots: [OTHER] }), run);
  assert.equal(bad.ok, false);
  assert.match(bad.detail, /failed to satisfy/);
});

test('checkCaptureApp: the launcher\'s check', () => {
  const ok = checkCaptureApp('/x/App.app', { run: fakeRun({ accept: req => req.includes(ROOT) }).run });
  assert.deepEqual(ok, { ok: true, requirement: buildRequirement({ certRoots: [ROOT] }), detail: '' });
  const team = checkCaptureApp('/x/App.app', { teamId: 'ABCDE12345', run: fakeRun({ security: '', accept: req => req.includes('ABCDE12345') }).run });
  assert.equal(team.ok, true);
  const bad = checkCaptureApp('/x/App.app', { run: fakeRun({ accept: () => false }).run });
  assert.equal(bad.ok, false);
  assert.match(bad.requirement, /certificate root/);
  assert.match(bad.detail, /failed to satisfy/);
  const none = checkCaptureApp('/x/App.app', { run: fakeRun({ security: '' }).run });
  assert.deepEqual([none.ok, none.requirement], [false, null]);
  assert.match(none.detail, /no signer to accept/);
  // The developer command line (bridge/nqa.mjs) runs capture through boot.mjs,
  // whose launcher enforces this requirement; it never checks codesign's Authority line itself (a
  // Developer ID app has another name).
  const cliFile = path.join(REPO, 'bridge', 'nqa.mjs');
  if (fs.existsSync(cliFile)) {
    const cli = fs.readFileSync(cliFile, 'utf8');
    assert.match(cli, /import\('\.\/byok\/boot\.mjs'\)/);
    assert.doesNotMatch(cli, /Authority=NeverQuestAlone Local Code Signing|codesign/);
  }
});

// Code health BR-05: the launch check (security, then codesign --verify) ran every 10 s on the app's main
// thread while Screen Recording was denied, with no time limit.
test('checkCaptureApp (code health BR-05): a pass is kept for the helper as it is on disk, and checked again once the bundle changes; a refusal or a timeout isn\'t kept; the async check runs both programs as child processes, with a time limit each', async () => {
  const { checkCaptureAppAsync, CHECK_TIMEOUT_MS } = captureModule;
  // A stand-in bundle on disk: its folder, its executable and its signature's file.
  const app = path.join(TMP, 'Kept.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', '_CodeSignature'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict><key>CFBundleExecutable</key><string>Kept</string></dict></plist>');
  const exe = path.join(app, 'Contents', 'MacOS', 'Kept');
  fs.writeFileSync(exe, 'one');
  fs.writeFileSync(path.join(app, 'Contents', '_CodeSignature', 'CodeResources'), 'sig');
  let accept = true;
  let codesign = null; // a codesign answer of the test's (a timeout)
  const f = fakeRun({ accept: () => accept });
  const limits = [];
  const run = (cmd, args, o) => { limits.push(o?.timeout); return cmd === 'codesign' && codesign ? codesign : f.run(cmd, args, o); };
  const runAsync = async (cmd, args, o) => run(cmd, args, o);
  const cache = new Map();
  const ok = checkCaptureApp(app, { run, cache });
  assert.equal(ok.ok, true);
  assert.deepEqual(f.calls.map(c => c[0]), ['security', 'codesign']);
  assert.deepEqual(limits, [CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS], 'each program has a time limit');
  assert.deepEqual(checkCaptureApp(app, { run, cache }), ok, 'the same helper on disk: kept');
  assert.deepEqual(await checkCaptureAppAsync(app, { run: runAsync, cache }), ok, 'the async check keeps the same passes');
  assert.equal(f.calls.length, 2, 'neither ran a program again');
  // Changed in place (a new executable): checked again.
  fs.writeFileSync(exe, 'three');
  assert.equal((await checkCaptureAppAsync(app, { run: runAsync, cache })).ok, true);
  assert.deepEqual(f.calls.slice(2).map(c => c[0]), ['security', 'codesign']);
  assert.deepEqual(limits.slice(2), [CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS]);
  // A refusal isn't kept: the next check runs again (a helper fixed meanwhile passes). Each change here
  // changes the size too: NTFS can keep a file's times through two writes in the same moment (windows CI).
  fs.writeFileSync(exe, 'four, again');
  accept = false;
  assert.equal(checkCaptureApp(app, { run, cache }).ok, false);
  assert.equal(checkCaptureApp(app, { run, cache }).ok, false);
  assert.equal(f.calls.length, 8);
  // Nor is a codesign that timed out.
  accept = true;
  codesign = { status: null, stdout: '', stderr: '', timedOut: true };
  const late = await checkCaptureAppAsync(app, { run: runAsync, cache });
  assert.deepEqual([late.ok, late.detail], [false, 'codesign timed out']);
  codesign = null;
  assert.equal((await checkCaptureAppAsync(app, { run: runAsync, cache })).ok, true, 'and the next one runs');
  // A test's own run, with no cache given, is asked every time; a bundle that isn't there is never kept.
  const n = f.calls.length;
  checkCaptureApp(app, { run });
  checkCaptureApp(app, { run });
  assert.equal(f.calls.length, n + 4);
  checkCaptureApp(path.join(TMP, 'Gone.app'), { run, cache });
  checkCaptureApp(path.join(TMP, 'Gone.app'), { run, cache });
  assert.equal(f.calls.length, n + 8);
});

const onMac = process.platform === 'darwin' && spawnSync('codesign', ['-h'], { encoding: 'utf8' }).error === undefined;

test('codesign parses every requirement we build, and enforces it on a real (ad hoc) signature', { skip: onMac ? false : 'macOS only' }, () => {
  // Grammar: an Apple-signed binary fails these requirements (status 3), never a syntax error (status 1).
  for (const req of [buildRequirement({ certRoots: [ROOT] }), buildRequirement({ teamId: 'ABCDE12345' }),
    buildRequirement({ certRoots: [ROOT, OTHER], teamId: 'ABCDE12345' })]) {
    const v = verifyRequirement('/bin/ls', req);
    assert.equal(v.status, 3, `${req}: ${v.detail}`);
  }
  // A copy of /usr/bin/true, ad hoc signed with our identifier: the identifier alone
  // matches, but no requirement we build accepts an ad hoc signature.
  const bin = path.join(TMP, 'adhoc-true');
  fs.copyFileSync('/usr/bin/true', bin);
  const s = spawnSync('codesign', ['--force', '--sign', '-', '--identifier', CAPTURE_BUNDLE_ID, bin], { encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr);
  assert.equal(verifyRequirement(bin, `identifier "${CAPTURE_BUNDLE_ID}"`).ok, true);
  assert.equal(verifyRequirement(bin, buildRequirement({ certRoots: [ROOT] })).ok, false);
  assert.equal(verifyRequirement(bin, buildRequirement({ teamId: 'ABCDE12345' })).ok, false);
});

// ---------------------------------------------------------------- macOS launcher

function macApp(name) {
  const app = path.join(TMP, name, 'NeverQuestAlone Capture.app');
  fs.mkdirSync(app, { recursive: true });
  return app;
}

test('macOS: the self-signed setup launches exactly as before, and the app\'s lines reach the callbacks', { skip: unixOnly }, async () => {
  const app = macApp('mac-ok');
  const socketPath = path.join(TMP, 'mac-ok', 'state', 'capture.sock');
  const { run, calls } = fakeRun({ accept: (req, target) => target === app && req === buildRequirement({ certRoots: [ROOT] }) });
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath, run, spawnOpen: args => opens.push(args), ...cbs });
  assert.equal(cap.kind, 'mac-app');
  cap.start();
  await until(() => opens.length === 1);
  // Stats every 10 s (display R0): the watchdog's hung and stalled rules count in these lines.
  assert.deepEqual(opens[0], ['-g', '-a', app, '--args', '--socket', socketPath, '--magic', 'C72C', '--interval-ms', '250', '--stats-sec', '10']);
  assert.ok(calls.some(c => c[0] === 'codesign' && c[1] === '--verify'));
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const s = net.connect(socketPath);
  await new Promise(r => s.on('connect', r));
  s.write('{"game":"running","pid":42}\n{"permission":true}\n{"id":7,"text":"hi \\u001f there"}\n');
  s.write('{"error":"WoW is minimized","kind":"window_minimized"}\n{"stats":{"frames":3}}\n');
  await until(() => ev.errors.length === 1 && cap.status().stats);
  assert.deepEqual(ev.games, [{ state: 'running', pid: 42 }]);
  assert.equal(ev.payloads[0].id, 7);
  assert.equal(ev.payloads[0].text, 'hi \x1f there');
  assert.deepEqual(ev.errors, [{ kind: 'window_minimized', message: 'WoW is minimized' }]);
  assert.equal(cap.status().permission, true);
  assert.equal(cap.status().connected, true);
  s.destroy();
  cap.stop();
});

test('macOS (SY-04): a revoke says permission false, a lost stream is an error until the helper says cleared, and a helper that doesn\'t connect in 10 s is launched again', { skip: unixOnly }, async () => {
  const app = macApp('mac-revoke');
  const socketPath = path.join(TMP, 'mac-revoke', 'state', 'capture.sock');
  const { run } = fakeRun({ accept: (req, target) => target === app });
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath, run, spawnOpen: args => opens.push(args), connectWaitMs: 40, ...cbs });
  cap.start();
  await until(() => opens.length >= 2);
  assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-warn' && /did not connect within 10 s; launching a new copy/.test(d.warn)));
  // The launch after one that never connected is a new instance (display DR-03): LaunchServices may
  // think an old copy still runs; the instance lock keeps it to one (SY-15).
  assert.equal(opens[0][0], '-g', 'the first launch as before');
  assert.equal(opens[1][0], '-n', 'then open -n');
  const s = net.connect(socketPath);
  await new Promise(r => s.on('connect', r));
  s.write('{"info":"screen recording: granted","permission":true}\n');
  await until(() => cap.status().permission === true && cap.status().connected);
  const launched = opens.length;
  await new Promise(r => setTimeout(r, 120));
  assert.equal(opens.length, launched, 'connected: no more launches');
  assert.equal(cap.status().error, null);
  s.write('{"error":"screen reading stopped (SCStreamErrorDomain -3815) and hasn\'t come back","kind":"access_lost"}\n');
  await until(() => cap.status().error);
  assert.equal(cap.status().error.kind, 'access_lost', 'kept while connected, so the view says "can\'t see the game"');
  s.write('{"info":"capturing","cleared":true}\n');
  await until(() => cap.status().error === null);
  s.write('{"permission":false}\n');
  await until(() => cap.status().permission === false);
  s.destroy();
  cap.stop();
});

test('macOS: an app that fails the requirement is never launched', { skip: unixOnly }, async () => {
  const app = macApp('mac-bad');
  const { run } = fakeRun({ accept: () => false });
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath: path.join(TMP, 'mac-bad', 'capture.sock'), run, spawnOpen: a => opens.push(a), ...cbs });
  cap.start();
  await until(() => ev.errors.length === 1);
  assert.equal(opens.length, 0);
  assert.equal(ev.errors[0].kind, 'signature_invalid');
  const refusal = ev.logs.find(([tag]) => tag === 'capture-error');
  assert.match(refusal[1].error, /refusing to launch: the app does not satisfy the code requirement/);
  assert.match(refusal[1].requirement, /certificate root = H"5eed/);
  cap.stop();
});

test('macOS: a Developer ID team from config is accepted without a local identity; neither refuses', { skip: unixOnly }, async () => {
  const app = macApp('mac-team');
  const teamReq = buildRequirement({ teamId: 'ABCDE12345' });
  const { run } = fakeRun({ security: '', accept: req => req === teamReq });
  const opens = [];
  const cap = createCapture({ app, socketPath: path.join(TMP, 'mac-team', 'capture.sock'), teamId: 'ABCDE12345', run, spawnOpen: a => opens.push(a) });
  cap.start();
  await until(() => opens.length === 1);
  cap.stop();

  const none = recorder();
  const cap2 = createCapture({ app, socketPath: path.join(TMP, 'mac-team', 'capture2.sock'), run: fakeRun({ security: '' }).run, spawnOpen: a => opens.push(a), ...none.cbs });
  cap2.start();
  await until(() => none.ev.errors.length === 1);
  assert.equal(opens.length, 1);
  assert.match(none.ev.errors[0].message, /isn't in your keychain and capture.teamId isn't set/);
  cap2.stop();
});

// ---------------------------------------------------------------- the supervisor (display DR-03)

/** A capture app bundle as build-app.sh lays it out: Info.plist naming the executable in Contents/MacOS. */
function macBundle(name) {
  const app = macApp(name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist><dict>\n\t<key>CFBundleExecutable</key>\n\t<string>NQACapture</string>\n</dict></plist>\n');
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'NQACapture'), '');
  return app;
}
/** fakeRun, and `ps -o comm= -p <pid>` answering what exe(pid) says. */
function fakeRunPs(exe) {
  const base = fakeRun();
  const ps = [];
  const run = (cmd, args, o) => {
    if (cmd === 'ps') { ps.push(args); const e = exe(Number(args.at(-1))); return e ? { status: 0, stdout: `${e}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }; }
    return base.run(cmd, args, o);
  };
  return { run, ps };
}
const connectTo = socketPath => new Promise((resolve, reject) => { const s = net.connect(socketPath); s.on('connect', () => resolve(s)); s.on('error', reject); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
/** A live stand-in process (the old helper that keeps the lock), and a promise of the signal it died of. */
function dummyHolder() {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const died = new Promise(r => p.on('exit', (code, signal) => r(signal ?? code)));
  return { pid: p.pid, died, stop: () => { try { p.kill('SIGKILL'); } catch { /* gone */ } } };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('the supervisor\'s numbers: stats every 10 s, failed starts tried again after 30 s, 2 min, then every 10 min; a second refused lock within 2 min', () => {
  assert.equal(STATS_SEC, 10);
  assert.deepEqual([...RETRY_MS], [30_000, 120_000, 600_000]);
  assert.equal(BUSY_REPEAT_MS, 120_000);
  const app = macBundle('mac-exe');
  assert.equal(bundleExecutable(app), path.join(app, 'Contents', 'MacOS', 'NQACapture'));
  fs.rmSync(path.join(app, 'Contents', 'Info.plist'));
  assert.equal(bundleExecutable(app), path.join(app, 'Contents', 'MacOS', 'NQACapture'), 'the one file in Contents/MacOS');
  assert.equal(bundleExecutable(path.join(TMP, 'none.app')), null);
});

test('macOS (display DR-03): restart() drops the connected helper, which is relaunched once, as a new instance; connecting and closing reach onStatus; with nothing connected there is nothing to restart', { skip: unixOnly }, async () => {
  const app = macApp('mac-restart');
  const socketPath = path.join(TMP, 'mac-restart', 'capture.sock');
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath, run: fakeRun().run, spawnOpen: a => opens.push(a), relaunchMs: 20, connectWaitMs: 60_000, ...cbs });
  try {
    cap.start();
    await until(() => opens.length === 1);
    assert.equal(cap.restart('nothing connected'), false, 'nothing running, nothing waiting');
    const s = await connectTo(socketPath);
    await until(() => cap.status().connected);
    assert.deepEqual(ev.statuses.filter(x => 'connected' in x), [{ connected: true }]);
    const closed = new Promise(r => s.on('close', r));
    assert.equal(cap.restart('stalled'), true);
    await closed;
    assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-restart' && d.reason === 'stalled'));
    await until(() => opens.length === 2);
    assert.equal(opens[1][0], '-n', 'an old copy that doesn\'t exit is met by the instance lock');
    assert.deepEqual(ev.statuses.filter(x => 'connected' in x), [{ connected: true }, { connected: false }]);
    await sleep(80);
    assert.equal(opens.length, 2, 'relaunched once');
  } finally { cap.stop(); }
});

test('macOS (display DR-03): a missing app and a refused signature are tried again on the backoff, and launched once they\'re fixed; retryNow() tries at once', { skip: unixOnly }, async () => {
  const app = path.join(TMP, 'mac-later', 'NeverQuestAlone Capture.app');
  const socketPath = path.join(TMP, 'mac-later', 'capture.sock');
  let accept = false;
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath, run: fakeRun({ accept: () => accept }).run, spawnOpen: a => opens.push(a), retryMs: [60, 120], ...cbs });
  try {
    cap.start();
    await until(() => ev.errors.length === 1);
    assert.equal(ev.errors[0].kind, 'helper_missing');
    fs.mkdirSync(app, { recursive: true }); // back, but not signed as required yet
    await until(() => ev.errors.length === 2, 3000);
    assert.equal(ev.errors[1].kind, 'signature_invalid');
    assert.deepEqual(ev.logs.filter(([tag]) => tag === 'capture-retry').map(([, d]) => [d.why, d.inMs]), [['helper_missing', 60], ['signature_invalid', 120]]);
    accept = true;
    await until(() => opens.length === 1, 3000);
    assert.equal(ev.errors.length, 2);
  } finally { cap.stop(); }
  // The Restart button: at once, whatever the backoff says.
  const app2 = path.join(TMP, 'mac-now', 'NeverQuestAlone Capture.app');
  const opens2 = [];
  const r2 = recorder();
  const cap2 = createCapture({ app: app2, socketPath: path.join(TMP, 'mac-now', 'capture.sock'), run: fakeRun().run, spawnOpen: a => opens2.push(a), retryMs: [60_000], ...r2.cbs });
  try {
    cap2.start();
    await until(() => r2.ev.errors.length === 1);
    fs.mkdirSync(app2, { recursive: true });
    assert.equal(cap2.restart('the watchdog'), true, 'a start waiting on its backoff runs now');
    await until(() => opens2.length === 1);
    assert.equal(cap2.retryNow(), false, 'waiting to connect: nothing more to try');
  } finally { cap2.stop(); }
});

test('macOS (display DR-03): open exiting non-zero (LaunchServices refused the launch) is a failed start, helper_failed', { skip: unixOnly }, async () => {
  const app = macApp('mac-open-fails');
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath: path.join(TMP, 'mac-open-fails', 'capture.sock'), run: fakeRun().run, connectWaitMs: 60_000,
    spawnOpen: () => { const c = new EventEmitter(); setImmediate(() => c.emit('exit', 1, null)); return c; }, ...cbs });
  try {
    cap.start();
    await until(() => ev.errors.length === 1);
    assert.deepEqual(ev.errors[0], { kind: 'helper_failed', message: 'the capture app didn\'t open (open exited 1)' });
    assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-error' && d.error === 'open exited 1'));
  } finally { cap.stop(); }
});

// SY-15: a helper that doesn't exit when its socket closes keeps its instance lock, and every new copy
// is refused ({"kind":"instance_busy","holder":N}). The supervisor stops the holder, but only when it is
// this app's own executable, compared as real paths: a pid the lock file names that another program
// uses now is left alone.
test('macOS (display DR-03, SY-15): a refused copy\'s holder is killed only when it\'s this app\'s executable (as real paths, through a symlinked app), and exactly one relaunch follows; any other executable is left alone; a second refusal within 2 min is helper_failed', { skip: unixOnly }, async () => {
  const real = macBundle('mac-busy');
  const link = path.join(TMP, 'mac-busy', 'Linked.app');
  fs.symlinkSync(real, link); // an /Applications symlink, App Translocation
  const holder = dummyHolder();
  const other = dummyHolder();
  const exe = fs.realpathSync(bundleExecutable(real));
  const { run, ps } = fakeRunPs(pid => (pid === holder.pid ? exe : pid === other.pid ? '/usr/libexec/something-else' : null));
  const socketPath = path.join(TMP, 'mac-busy', 'capture.sock');
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app: link, socketPath, run, spawnOpen: a => opens.push(a), relaunchMs: 20, connectWaitMs: 60_000, retryMs: [60_000], ...cbs });
  const refused = async (pid) => {
    const s = await connectTo(socketPath);
    const closed = new Promise(r => s.on('close', r));
    s.end(`{"error":"another copy of the capture helper is already running (pid ${pid})","kind":"instance_busy","holder":${pid}}\n`);
    await closed;
  };
  try {
    cap.start();
    await until(() => opens.length === 1);
    // Another program's pid in the lock: left alone; the copy exits and is launched again.
    await refused(other.pid);
    await until(() => opens.length === 2);
    assert.equal(alive(other.pid), true, 'not ours: never killed');
    assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-warn' && /left alone/.test(d.warn) && d.holder === other.pid));
    assert.deepEqual(ev.errors, [], 'the first refusal is no error');
    assert.deepEqual(ps.at(-1), ['-o', 'comm=', '-p', String(other.pid)]);
    cap.stop();
    // Ours (a fresh supervisor, so the refusal isn't a repeat): SIGKILL, and one relaunch.
    const opens2 = [];
    const r2 = recorder();
    const cap2 = createCapture({ app: link, socketPath, run, spawnOpen: a => opens2.push(a), relaunchMs: 20, connectWaitMs: 60_000, retryMs: [60_000], ...r2.cbs });
    try {
      cap2.start();
      await until(() => opens2.length === 1);
      const s = await connectTo(socketPath);
      const closed = new Promise(r => s.on('close', r));
      s.end(`{"error":"another copy of the capture helper is already running (pid ${holder.pid})","kind":"instance_busy","holder":${holder.pid}}\n`);
      assert.equal(await holder.died, 'SIGKILL');
      await closed;
      await until(() => opens2.length === 2);
      await sleep(80);
      assert.equal(opens2.length, 2, 'exactly one relaunch');
      assert.ok(r2.ev.logs.some(([tag, d]) => tag === 'capture-holder-stopped' && d.holder === holder.pid));
      assert.deepEqual(r2.ev.errors, []);
      // Refused again within 2 minutes: the lock stays held, so a failed start, tried on the backoff (no 3 s relaunch).
      const s2 = await connectTo(socketPath);
      const closed2 = new Promise(r => s2.on('close', r));
      s2.end(`{"error":"another copy of the capture helper is already running (pid ${holder.pid})","kind":"instance_busy","holder":${holder.pid}}\n`);
      await closed2;
      await until(() => r2.ev.errors.length === 1);
      assert.equal(r2.ev.errors[0].kind, 'helper_failed');
      await sleep(80);
      assert.equal(opens2.length, 2, 'the next try waits on the backoff');
      assert.ok(r2.ev.logs.some(([tag, d]) => tag === 'capture-retry' && d.why === 'instance_busy'));
    } finally { cap2.stop(); }
  } finally { cap.stop(); holder.stop(); other.stop(); }
});

test('the line contract passes on what a typed error line carries (access_lost\'s locked and asleep, SY-18; instance_busy\'s holder, SY-15), and keeps the Windows away line in state (DR-26)', () => {
  const statuses = [];
  const errors = [];
  const logs = [];
  const h = createLineHandler({ onStatus: s => statuses.push(s), onError: e => errors.push(e), log: (tag, d) => logs.push([tag, d]) });
  h.onLine('{"error":"screen reading stopped (-3815) and hasn\'t come back","kind":"access_lost","locked":false,"asleep":true}');
  h.onLine('{"error":"another copy of the capture helper is already running (pid 4242)","kind":"instance_busy","holder":4242}');
  h.onLine('{"error":"x","kind":"window_minimized","holder":"4242","locked":"yes"}');
  assert.deepEqual(errors, [
    { kind: 'access_lost', message: 'screen reading stopped (-3815) and hasn\'t come back', locked: false, asleep: true },
    { kind: 'instance_busy', message: 'another copy of the capture helper is already running (pid 4242)', holder: 4242 },
    { kind: 'window_minimized', message: 'x' },
  ], 'only well-formed facts pass');
  assert.equal(h.state.away, null);
  h.onLine('{"away":"locked"}');
  assert.equal(h.state.away, 'locked');
  h.onLine('{"away":"locked"}');
  h.onLine('{"away":null}');
  assert.equal(h.state.away, null);
  assert.deepEqual(statuses, [{ away: 'locked' }, { away: 'locked' }, { away: null }], 'every line passed on');
  assert.deepEqual(logs.filter(([tag]) => tag === 'capture-away').map(([, d]) => d.away), ['locked', null], 'logged on a change only');
});

// A capture socket that can't be opened (audit PF-07, LS-07): the listen error is a typed error,
// never an uncaught one that left capture waiting for good with the process umask at 077.
async function unopenable(socketPath) {
  const uncaught = [];
  const onUncaught = e => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  const mask = process.umask();
  const opens = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app: path.join(TMP, 'nonexistent.app'), socketPath, launch: false, spawnOpen: a => opens.push(a), ...cbs });
  try {
    cap.start();
    await until(() => ev.errors.length === 1);
    await new Promise(r => setTimeout(r, 50));
    return { uncaught, mask, umask: process.umask(), opens, ev };
  } finally { process.off('uncaughtException', onUncaught); cap.stop(); }
}
const asRoot = process.getuid?.() === 0 ? 'root can bind in a read-only folder' : false;

test('macOS (PF-07, display DR-03): a capture socket in a folder it can\'t write is a failed start (helper_failed), not an uncaught error; the umask comes back', { skip: unixOnly || asRoot }, async () => {
  const dir = path.join(TMP, 'mac-ro');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  try {
    const r = await unopenable(path.join(dir, 'capture.sock'));
    assert.deepEqual(r.uncaught, []);
    assert.equal(r.ev.errors[0].kind, 'helper_failed', 'a listen() that fails can work on a later try: not "can\'t read this screen"');
    assert.match(r.ev.errors[0].message, /^the capture socket could not be opened \(EACCES\)$/);
    assert.equal(r.umask, r.mask, 'the umask is back');
    assert.deepEqual(r.opens, [], 'no helper launched');
    assert.ok(r.ev.logs.some(([tag, d]) => tag === 'capture-error' && d.error === 'capture socket: EACCES'));
  } finally { fs.chmodSync(dir, 0o700); }
});

// A failed listen used to leave capture dead until the app restarted (display audit D-41, BH-12):
// it's tried again on the backoff, and the first try that listens launches the helper.
test('macOS (display DR-03): a listen that fails is tried again on the backoff (30 s, 2 min, 10 min; short here), and the try that listens launches the helper', { skip: unixOnly || asRoot }, async () => {
  const dir = path.join(TMP, 'mac-ro-retry');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  const app = macApp('mac-ro-retry-app');
  const opens = [];
  const { ev, cbs } = recorder();
  const socketPath = path.join(dir, 'capture.sock');
  const cap = createCapture({ app, socketPath, run: fakeRun().run, spawnOpen: a => opens.push(a), retryMs: [60, 120, 240], ...cbs });
  try {
    cap.start();
    await until(() => ev.errors.length === 1);
    assert.equal(ev.errors[0].kind, 'helper_failed');
    assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-retry' && d.inMs === 60 && /^listen EACCES$/.test(d.why)), 'the first wait');
    await until(() => ev.errors.length === 2, 3000);
    assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-retry' && d.inMs === 120), 'the next wait is longer');
    assert.equal(opens.length, 0);
    fs.chmodSync(dir, 0o700); // the folder is writable again
    await until(() => opens.length === 1, 3000);
    assert.equal(ev.errors.length, 2, 'no more failures');
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  } finally { cap.stop(); fs.chmodSync(dir, 0o700); }
});

test('macOS (PF-07): a socket path past macOS\'s 104 bytes (a long account name or a deep home folder) is the same typed error', { skip: process.platform === 'darwin' ? false : 'macOS only: its listen() refuses a path over 104 bytes; Linux truncates one, and the folder test above covers the error path there' }, async () => {
  const socketPath = path.join(TMP, 'mac-long', 'x'.repeat(60), 'capture.sock');
  assert.ok(Buffer.byteLength(socketPath) > 104, `${Buffer.byteLength(socketPath)} bytes`);
  const r = await unopenable(socketPath);
  assert.deepEqual(r.uncaught, []);
  assert.equal(r.ev.errors[0].kind, 'capture_unsupported');
  assert.match(r.ev.errors[0].message, /could not be opened \(EINVAL\)/);
  assert.equal(r.umask, r.mask);
});

// ---------------------------------------------------------------- the Mac socket's peer check (code health LS-03 / peer check)
// Node can't name a socket's peer, so the app hands each connection to the helper's own executable
// (--check-peer, fd 3) before it reads a byte of it. Here a stand-in executable (sh) answers for the
// helper, or a stand-in check decides; tests/capture_mac_test.js drives the real one on macOS.

/** A capture app bundle whose executable stands in for the helper's --check-peer: it keeps its argv, says
 * whether fd 3 is a socket, and answers by the requirement: ALLOW passes, HANG never answers, else refused. */
function peerStandIn(name) {
  const app = macBundle(name);
  const exe = path.join(app, 'Contents', 'MacOS', 'NQACapture');
  fs.writeFileSync(exe, [
    '#!/bin/sh',
    'printf \'%s\\n\' "$@" > "$0.args"',
    '[ "$1" = --check-peer ] || exit 9',
    '[ -S /dev/fd/3 ] || { echo "NeverQuestAlone Capture: refused: the program that connected can\'t be named (errno 38)" >&2; exit 6; }',
    'case "$2" in',
    '  *ALLOW*) exit 0 ;;',
    '  *HANG*) exec sleep 30 ;;',
    '  *) echo "NeverQuestAlone Capture: refused: the program that connected isn\'t NeverQuestAlone\'s capture helper (-67050)" >&2; exit 6 ;;',
    'esac', ''].join('\n'));
  fs.chmodSync(exe, 0o755);
  return { app, exe };
}
const NOT_HELPER = 'the program that connected isn\'t NeverQuestAlone\'s capture helper (-67050)';

test('code health LS-03 / peer check: checkPeer runs the helper\'s executable with --check-peer and the connection as its fd 3; exit 0 is the only yes (its refusal line, a hang killed at its time, no executable, one that can\'t start); the connection is left as it was', { skip: unixOnly }, async () => {
  assert.equal(PEER_CHECK_MS, 5000);
  assert.equal(PEER_CHECKS_MAX, 4);
  const { exe } = peerStandIn('peer-check');
  const sock = path.join(TMP, 'peer-check', 'p.sock');
  const got = [];
  const srv = net.createServer({ pauseOnConnect: true }, (s) => { s.on('error', () => {}); got.push(s); });
  await new Promise(r => srv.listen(sock, r));
  const accepted = async () => { const n = got.length; const c = await connectTo(sock); c.on('error', () => {}); await until(() => got.length > n); return { c, s: got.at(-1) }; };
  try {
    let { c, s } = await accepted();
    c.write('a line sent before the check\n');
    assert.deepEqual(await checkPeer(s, { exe, requirement: 'identifier "x" ALLOW' }), { ok: true, why: null });
    assert.deepEqual(fs.readFileSync(`${exe}.args`, 'utf8'), '--check-peer\nidentifier "x" ALLOW\n', 'its argv: the mode and the requirement, nothing else');
    // The connection is untouched in this process (the check's copy of it went with the check): what was
    // sent before is still there to read, and it still carries both ways.
    s.resume();
    assert.equal(String(await new Promise(r => s.once('data', r))), 'a line sent before the check\n');
    s.write('back\n');
    assert.equal(String(await new Promise(r => c.once('data', r))), 'back\n');
    c.destroy();
    ({ s } = await accepted());
    assert.deepEqual(await checkPeer(s, { exe, requirement: 'identifier "x"' }), { ok: false, why: NOT_HELPER });
    ({ s } = await accepted());
    const t0 = Date.now();
    assert.deepEqual(await checkPeer(s, { exe, requirement: 'HANG', timeoutMs: 200 }), { ok: false, why: 'the check didn\'t answer within 200 ms' });
    assert.ok(Date.now() - t0 < 3000, 'killed at its time');
    assert.deepEqual(await checkPeer(s, { exe: null, requirement: 'ALLOW' }), { ok: false, why: 'no capture helper executable to check with' });
    assert.deepEqual(await checkPeer(s, { exe: path.join(TMP, 'peer-check', 'none'), requirement: 'ALLOW' }), { ok: false, why: 'the check could not run (ENOENT)' });
    // A stand-in spawn that throws, and one that exits without a line.
    assert.deepEqual(await checkPeer(s, { exe, requirement: 'ALLOW', spawnImpl: () => { throw Object.assign(new Error('x'), { code: 'EMFILE' }); } }), { ok: false, why: 'the check could not run (EMFILE)' });
    const quiet = await checkPeer(s, { exe, requirement: 'ALLOW', spawnImpl: () => { const ch = fakeChild(); setImmediate(() => ch.emit('close', 5, null)); return ch; } });
    assert.deepEqual(quiet, { ok: false, why: 'the check exited 5' });
  } finally { srv.close(); for (const s of got) s.destroy(); }
});

test('code health LS-03 / peer check: with a team, every connection to the Mac socket is checked before a byte of it is read: a stranger that connects first is closed unread with one typed line and the helper still gets through; one in the 3 s before a relaunch is refused too; a second connection is refused unchecked; checks are capped', { skip: unixOnly }, async () => {
  const app = macApp('peer-flow');
  const socketPath = path.join(TMP, 'peer-flow', 'capture.sock');
  const opens = [];
  const checks = [];
  const { ev, cbs } = recorder();
  const cap = createCapture({ app, socketPath, teamId: 'ABCDE12345', certRoots: [], run: fakeRun({ security: '' }).run, spawnOpen: a => opens.push(a),
    relaunchMs: 400, connectWaitMs: 60_000, peerCheck: s => new Promise(r => checks.push({ s, r })), peerChecksMax: 2, ...cbs });
  const refusals = () => ev.logs.filter(([tag]) => tag === 'capture-peer-refused').map(([, d]) => d);
  const connected = () => ev.statuses.filter(x => 'connected' in x).map(x => x.connected);
  try {
    cap.start();
    await until(() => opens.length === 1);
    // A stranger first, writing what a helper would: nothing of it is read while it's checked.
    const stranger = await connectTo(socketPath);
    const strangerClosed = new Promise(r => stranger.on('close', r));
    stranger.write('{"permission":true}\n{"id":1,"text":"spend the player\'s key"}\n{"game":"running","pid":1}\n{"error":"x","kind":"access_lost"}\n');
    await until(() => checks.length === 1);
    await sleep(40);
    assert.deepEqual([ev.payloads, ev.games, ev.errors, connected(), cap.status().connected, cap.status().permission], [[], [], [], [], false, null]);
    checks[0].r({ ok: false, why: NOT_HELPER });
    await strangerClosed;
    assert.deepEqual(refusals(), [{ why: NOT_HELPER }], 'one typed line');
    assert.deepEqual([ev.payloads, ev.games, ev.errors, connected()], [[], [], [], []], 'nothing of it was read; it never counted as connected');
    // The helper: its lines, sent before its check ends, are all read once it's taken.
    const helper = await connectTo(socketPath);
    helper.write('{"permission":true}\n{"id":7,"text":"hi"}\n');
    await until(() => checks.length === 2);
    await sleep(40);
    assert.deepEqual([ev.payloads, cap.status().connected], [[], false], 'nothing before its check passes');
    checks[1].r({ ok: true, why: null });
    await until(() => ev.payloads.length === 1);
    assert.deepEqual([ev.payloads[0].id, ev.payloads[0].text, cap.status().permission, cap.status().connected, connected()], [7, 'hi', true, true, [true]]);
    // A second connection while it's connected: refused at once, unchecked, as before.
    const second = await connectTo(socketPath);
    await new Promise(r => second.on('close', r));
    assert.equal(checks.length, 2);
    assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-warn' && d.warn === 'a second capture connection was refused'));
    // The helper goes, and the app relaunches it in 3 s (400 ms here): a stranger in that gap is checked
    // and refused too, and the relaunched helper gets through.
    helper.destroy();
    await until(() => cap.status().connected === false);
    const gap = await connectTo(socketPath);
    const gapClosed = new Promise(r => gap.on('close', r));
    gap.write('{"id":2,"text":"in the gap"}\n');
    await until(() => checks.length === 3);
    assert.equal(opens.length, 1, 'still in the gap');
    checks[2].r({ ok: false, why: NOT_HELPER });
    await gapClosed;
    assert.equal(refusals().length, 2);
    await until(() => opens.length === 2);
    const again = await connectTo(socketPath);
    await until(() => checks.length === 4);
    checks[3].r({ ok: true });
    await until(() => cap.status().connected);
    assert.deepEqual(ev.payloads.map(p => p.id), [7], 'only the helper\'s records, ever');
    again.destroy();
    await until(() => cap.status().connected === false);
    // At most two checks at once here (four in the app): a third waiting connection is refused unchecked.
    const waiting = [await connectTo(socketPath), await connectTo(socketPath)];
    await until(() => checks.length === 6);
    const third = await connectTo(socketPath);
    await new Promise(r => third.on('close', r));
    assert.equal(checks.length, 6);
    assert.deepEqual(refusals().at(-1), { why: '2 connections are being checked already' });
    // A check that throws refuses; one still running when capture stops is dropped with it.
    checks[4].r(Promise.reject(new Error('the check broke')));
    await until(() => refusals().length === 4);
    assert.deepEqual(refusals().at(-1), { why: 'the check broke' });
    const dropped = new Promise(r => waiting[1].on('close', r));
    cap.stop();
    await dropped;
    checks[5].r({ ok: true });
    await sleep(20);
    assert.equal(cap.status().connected, false, 'not taken after stop');
  } finally { cap.stop(); }
});

test('code health LS-03 / peer check: boot\'s wiring: with a team, the helper\'s own executable (Contents/MacOS, as Info.plist names it) checks each connection against the bundle id and the team\'s Developer ID (buildRequirement\'s team branch); with none, an unsigned or ad hoc build, nothing is checked', { skip: unixOnly }, async () => {
  const { app, exe } = peerStandIn('peer-boot');
  const opens = [];
  const r1 = recorder();
  const socketPath = path.join(TMP, 'peer-boot', 'capture.sock');
  const cap = createCapture({ app, socketPath, teamId: 'ABCDE12345', certRoots: [], run: fakeRun({ security: '' }).run, spawnOpen: a => opens.push(a), connectWaitMs: 60_000, ...r1.cbs });
  try {
    cap.start();
    await until(() => opens.length === 1);
    const c = await connectTo(socketPath);
    await new Promise(r => c.on('close', r));
    // The stand-in refuses what it can't meet: the Developer ID requirement holds no ALLOW.
    assert.deepEqual(fs.readFileSync(`${exe}.args`, 'utf8'), `--check-peer\n${buildRequirement({ bundleId: CAPTURE_BUNDLE_ID, teamId: 'ABCDE12345' })}\n`);
    assert.deepEqual(r1.ev.logs.filter(([tag]) => tag === 'capture-peer-refused').map(([, d]) => d), [{ why: NOT_HELPER }]);
    assert.equal(cap.status().connected, false);
  } finally { cap.stop(); }
  // A bundle id the stand-in meets (its requirement says ALLOW): taken.
  fs.rmSync(`${exe}.args`);
  const r2 = recorder();
  const cap2 = createCapture({ app, socketPath, teamId: 'ABCDE12345', bundleId: 'org.example.ALLOW', certRoots: [], run: fakeRun({ security: '' }).run, spawnOpen: a => opens.push(a), connectWaitMs: 60_000, ...r2.cbs });
  try {
    cap2.start();
    await until(() => opens.length === 2);
    const c = await connectTo(socketPath);
    c.write('{"id":3,"text":"through"}\n');
    await until(() => r2.ev.payloads.length === 1);
    assert.match(fs.readFileSync(`${exe}.args`, 'utf8'), /^--check-peer\nidentifier "org\.example\.ALLOW" and \(\(anchor apple generic and .*"ABCDE12345"\)\)\n$/);
    c.destroy();
  } finally { cap2.stop(); }
  // No team (an unsigned or ad hoc app, a checkout without capture.teamId): nothing runs; the connection is taken at once.
  fs.rmSync(`${exe}.args`);
  const r3 = recorder();
  const cap3 = createCapture({ app, socketPath, run: fakeRun().run, spawnOpen: a => opens.push(a), connectWaitMs: 60_000, ...r3.cbs });
  try {
    cap3.start();
    await until(() => opens.length === 3);
    const c = await connectTo(socketPath);
    c.write('{"id":4,"text":"as before"}\n');
    await until(() => r3.ev.payloads.length === 1);
    assert.equal(fs.existsSync(`${exe}.args`), false, 'no check ran');
    c.destroy();
  } finally { cap3.stop(); }
});

// ---------------------------------------------------------------- Windows helper (stdout)

function windowsRig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'win-'));
  const exe = path.join(dir, 'nqa-capture.exe');
  fs.writeFileSync(exe, 'MZ');
  const spawns = [];
  const { ev, cbs } = recorder();
  const cap = createWindowsCapture({
    exe, relaunchMs: 20,
    spawnImpl: (cmd, args, opts) => { const c = fakeChild(); spawns.push({ cmd, args, opts, child: c }); return c; },
    ...cbs, ...(typeof extra === 'function' ? extra(spawns) : extra),
  });
  return { cap, exe, spawns, ev };
}

test('Windows: the helper gets its flags and nothing else; its stdout lines reach the callbacks; stdin stays open and silent', async () => {
  const { cap, exe, spawns, ev } = windowsRig();
  assert.equal(cap.kind, 'windows-helper');
  assert.equal(cap.pipeName, undefined, 'no named pipe');
  cap.start();
  await until(() => spawns.length === 1);
  const { cmd, args, opts, child } = spawns[0];
  assert.equal(cmd, exe);
  assert.deepEqual(args, ['--process-name', 'Wow*', '--width', '900', '--height', '300', '--interval-ms', '250', '--magic', 'C72C', '--stats-sec', '10']);
  assert.deepEqual(opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(opts.windowsHide, true);
  assert.deepEqual([child.stdin.written, child.stdin.ended], ['', false], 'nothing is written to stdin, and it stays open');
  assert.equal(cap.status().connected, false, 'not connected before the helper says anything');

  child.stdout.emit('data', Buffer.from('{"info":"nqa-capture 0.2.0 started"}\n{"game":"running","pid":9}\n{"window":{"pid":9,"width":2560}}\n{"id":3,"te'));
  child.stdout.emit('data', Buffer.from('xt":"hello"}\n{"error":"World of Warcraft is minimized","kind":"window_minimized"}\n'));
  await until(() => ev.payloads.length === 1 && ev.errors.length === 1);
  assert.deepEqual(ev.games.map(g => g.state), ['running', 'running']);
  assert.equal(ev.payloads[0].text, 'hello');
  assert.equal(ev.errors[0].kind, 'window_minimized');
  assert.equal(cap.status().connected, true);
  assert.equal(cap.status().error.kind, 'window_minimized', 'a typed error stays in status until it clears');
  assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-conn' && d.connected === true));
  child.stdout.emit('data', Buffer.from('{"info":"capturing","cleared":true}\n'));
  await until(() => cap.status().error === null);

  cap.stop();
  assert.equal(child.stdin.ended, true, 'stop ends stdin (the helper exits on its own too)');
  assert.equal(child.killed, true);
});

test('Windows (display DR-05): the flavor folders, the game\'s own helpers and the served WoW folder reach the helper, one flag each; empty ones never do', async () => {
  const dir = 'C:\\Program Files (x86)\\World of Warcraft\\_forever_';
  const { FOREVER_FLAVORS, NOT_GAME } = await import('../../bridge/byok/wow.mjs');
  const { cap, spawns } = windowsRig({ flavorDirs: FOREVER_FLAVORS, notGame: NOT_GAME, exeDir: dir });
  cap.start();
  await until(() => spawns.length === 1);
  const { args } = spawns[0];
  assert.deepEqual(args.slice(0, 2), ['--process-name', 'Wow*'], 'Wow* stays the name filter');
  assert.deepEqual(args.slice(12), ['--flavor-dir', '_forever_', '--flavor-dir', '_classic_beta_', '--not-game', 'VoiceProxy', '--not-game', 'Error', '--exe-dir', dir]);
  cap.stop();
  const bare = windowsRig({ flavorDirs: ['', null, '_forever_'], notGame: 'Error', exeDir: '' });
  bare.cap.start();
  await until(() => bare.spawns.length === 1);
  assert.deepEqual(bare.spawns[0].args.slice(12), ['--flavor-dir', '_forever_']);
  bare.cap.stop();
});

test('Windows: no signature check at launch (no PowerShell); signer, requireSigner and verifyExe are ignored', async () => {
  let verified = 0;
  const rig = windowsRig({ signer: 'Example Publisher', requireSigner: true, verifyExe: () => { verified += 1; return { ok: false, detail: 'NotSigned' }; } });
  rig.cap.start();
  await until(() => rig.spawns.length === 1);
  assert.equal(verified, 0);
  assert.deepEqual(rig.ev.errors, []);
  rig.cap.stop();
  for (const gone of ['windowsSignerCheck', 'windowsPowerShell', 'isPackagedApp']) assert.equal(captureModule[gone], undefined, `${gone} is gone`);
  // Nor a setting for it in the config's defaults (systems critic SY-09).
  const { DEFAULTS } = await import('../../bridge/config.mjs');
  assert.deepEqual(Object.keys(DEFAULTS.capture).sort(), ['app', 'enabled', 'intervalMs', 'teamId']);
  const src = fs.readFileSync(path.join(REPO, 'bridge', 'transport', 'capture.mjs'), 'utf8');
  for (const code of [/powershell\.exe/i, /Get-AuthenticodeSignature/, /timingSafeEqual/, /'--token'/, /'--pipe'/]) assert.doesNotMatch(src, code);
});

test('Windows (display DR-03): a missing helper is not launched, and is looked for again on the backoff; back, it starts; retryNow() looks at once', async () => {
  const missing = windowsRig({ retryMs: [60, 120, 240] });
  fs.rmSync(missing.exe);
  missing.cap.start();
  await until(() => missing.ev.errors.length === 1);
  assert.equal(missing.ev.errors[0].kind, 'helper_missing');
  assert.equal(missing.spawns.length, 0);
  // Defender quarantined it, then gave it back: the next try starts it (it used to stop for good, D-12).
  await until(() => missing.ev.errors.length === 2, 3000);
  assert.ok(missing.ev.logs.some(([tag, d]) => tag === 'capture-retry' && d.inMs === 120), 'the waits grow');
  fs.writeFileSync(missing.exe, 'MZ');
  await until(() => missing.spawns.length === 1, 3000);
  missing.cap.stop();
  // The app's Restart button doesn't wait for the backoff.
  const again = windowsRig({ retryMs: [60_000] });
  fs.rmSync(again.exe);
  again.cap.start();
  await until(() => again.ev.errors.length === 1);
  fs.writeFileSync(again.exe, 'MZ');
  assert.equal(again.cap.retryNow(), true);
  await until(() => again.spawns.length === 1);
  assert.equal(again.cap.retryNow(), false, 'running: nothing to try');
  again.cap.stop();
});

test('Windows: a helper that exits is relaunched with fresh pipes; the old one\'s late lines are still read, status follows the new one', async () => {
  const { cap, spawns, ev } = windowsRig();
  cap.start();
  await until(() => spawns.length === 1);
  spawns[0].child.stdout.emit('data', Buffer.from('{"id":1,"text":"first"}\n'));
  await until(() => cap.status().connected);
  spawns[0].child.emit('exit', 0, null);
  await until(() => spawns.length === 2);
  assert.equal(cap.status().connected, false, 'the new helper has said nothing yet');
  assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-conn' && d.connected === false));
  spawns[1].child.stdout.emit('data', Buffer.from('{"id":2,"text":"after relaunch"}\n'));
  await until(() => ev.payloads.length === 2 && cap.status().connected);
  cap.stop();
});

test('Windows (display DR-03): restart() kills the helper, which is relaunched once; the away line reaches status() and onStatus (DR-26); connecting and exiting reach onStatus', async () => {
  const { cap, spawns, ev } = windowsRig({ relaunchMs: 20 });
  cap.start();
  await until(() => spawns.length === 1);
  assert.equal(cap.status().away, null);
  spawns[0].child.stdout.emit('data', Buffer.from('{"info":"nqa-capture 0.2.0 started"}\n{"away":null}\n'));
  await until(() => cap.status().connected);
  spawns[0].child.stdout.emit('data', Buffer.from('{"error":"the screen can\'t be read right now (access denied)","kind":"access_lost"}\n{"away":"locked"}\n'));
  await until(() => cap.status().away === 'locked');
  assert.deepEqual(ev.statuses.filter(s => 'away' in s || 'connected' in s), [{ connected: true }, { away: null }, { away: 'locked' }]);
  assert.equal(cap.retryNow(), false, 'running: nothing to try');
  assert.equal(cap.restart('hung'), true);
  assert.equal(spawns[0].child.killed, true);
  assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-restart' && d.reason === 'hung'));
  await until(() => spawns.length === 2);
  assert.deepEqual(ev.statuses.filter(s => 'connected' in s), [{ connected: true }, { connected: false }]);
  await sleep(80);
  assert.equal(spawns.length, 2, 'relaunched once');
  spawns[1].child.stdout.emit('data', Buffer.from('{"away":null}\n'));
  await until(() => cap.status().away === null && cap.status().connected);
  cap.stop();
  assert.equal(cap.restart(), false, 'stopped');
});

test('Windows: a helper that fails to start is relaunched, and status() says it is not running', async () => {
  const { cap, spawns, ev } = windowsRig(list => ({ spawnImpl: (cmd, args) => { const c = failedChild('EACCES'); list.push({ cmd, args, child: c }); return c; } }));
  cap.start();
  await until(() => spawns.length >= 2);
  assert.ok(ev.errors.some(e => e.kind === 'helper_failed'));
  await until(() => !cap.status().running);
  assert.deepEqual([cap.status().running, cap.status().connected], [false, false]);
  cap.stop();
});

// Windows' spawn throws some failures instead of emitting 'error' (a file that isn't a program:
// spawn UNKNOWN). Out of a relaunch timer that would be an uncaught exception, so it's the same
// failure and the same relaunch, everywhere.
test('a spawn that throws (as Windows\' does) is a failed start and relaunched, for the Windows helper and capture_x11.py', async () => {
  const thrower = (tries) => () => { tries.push(Date.now()); throw Object.assign(new Error('spawn UNKNOWN'), { code: 'UNKNOWN', errno: -4094 }); };
  const winTries = [];
  const { cap, ev } = windowsRig({ spawnImpl: thrower(winTries) });
  assert.doesNotThrow(() => cap.start());
  await until(() => winTries.length >= 2);
  assert.ok(ev.errors.some(e => e.kind === 'helper_failed' && /spawn UNKNOWN/.test(e.message)));
  assert.ok(ev.logs.some(([tag, d]) => tag === 'capture-error' && /could not start: spawn UNKNOWN/.test(d.error)));
  assert.deepEqual([cap.status().running, cap.status().connected], [false, false]);
  cap.stop();
  const linTries = [];
  const { ev: lev, cbs } = recorder();
  const lin = createX11Capture({ relaunchMs: 20, spawnImpl: thrower(linTries), ...cbs });
  assert.doesNotThrow(() => lin.start());
  await until(() => linTries.length >= 2);
  assert.ok(lev.errors.some(e => e.kind === 'helper_failed'));
  lin.stop();
});

test('Windows: a real spawn that fails (not an executable) is relaunched', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'win-real-'));
  const exe = path.join(dir, 'nqa-capture.exe');
  fs.writeFileSync(exe, 'MZ not a program', { mode: 0o644 });
  const { ev, cbs } = recorder();
  const cap = createWindowsCapture({ exe, relaunchMs: 20, ...cbs });
  cap.start();
  await until(() => ev.logs.filter(([tag]) => tag === 'capture-launch').length >= 2, 5000);
  assert.ok(ev.errors.some(e => e.kind === 'helper_failed'));
  cap.stop();
});

// A stand-in for nqa-capture.exe, as a real child process: it says it started, echoes its
// arguments, answers on stdout, and exits (writing a marker) when its stdin ends, as the real
// helper does when the bridge is gone.
const STAND_IN = `
const fs = require('node:fs');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
out({ info: 'nqa-capture 0.2.0 started', args: process.argv.slice(2) });
out({ game: 'running', pid: 4242 });
out({ id: 7, text: 'from a real child' });
process.stdin.on('data', () => {});
process.stdin.on('end', () => { fs.writeFileSync(process.env.WCAP_MARKER, 'stdin ended'); process.exit(0); });
`;

test('Windows: a real child on stdout (a stand-in helper): its lines arrive, and ending stdin makes it exit', async () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'win-standin-'));
  const exe = path.join(dir, 'nqa-capture.exe');
  fs.writeFileSync(exe, 'MZ');
  const script = path.join(dir, 'stand-in.cjs');
  fs.writeFileSync(script, STAND_IN);
  const marker = path.join(dir, 'marker.txt');
  const { ev, cbs } = recorder();
  let child = null;
  const cap = createWindowsCapture({
    exe, processNames: ['WowB', 'Wow*'], ...cbs,
    spawnImpl: (cmd, args, opts) => (child = spawn(process.execPath, [script, ...args], { ...opts, env: { ...process.env, WCAP_MARKER: marker } })),
  });
  cap.start();
  await until(() => ev.payloads.length === 1, 10000);
  assert.equal(ev.payloads[0].text, 'from a real child');
  assert.deepEqual(ev.games, [{ state: 'running', pid: 4242 }]);
  const started = ev.logs.find(([tag, d]) => tag === 'capture-info' && Array.isArray(d.args));
  assert.deepEqual(started[1].args.slice(0, 2), ['--process-name', 'WowB,Wow*']);
  assert.equal(cap.status().connected, true);
  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));
  child.stdin.end(); // what the bridge quitting looks like to the helper
  const how = await exited;
  assert.deepEqual(how, { code: 0, signal: null });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'stdin ended');
  cap.stop();
});

// ---------------------------------------------------------------- Linux (X11)

test('Linux: capture_x11.py runs with the NeverQuestAlone magic and pitch search, and relaunches when it exits', async () => {
  const spawns = [];
  const { ev, cbs } = recorder();
  const cap = createX11Capture({ relaunchMs: 20, spawnImpl: (cmd, args, opts) => { const c = fakeChild(); spawns.push({ cmd, args, opts, child: c }); return c; }, ...cbs });
  assert.equal(cap.kind, 'x11');
  cap.start();
  assert.equal(spawns[0].cmd, 'python3');
  assert.deepEqual(spawns[0].args, [path.join(REPO, 'bridge', 'capture_x11.py'), '--magic', 'C72C', '--interval-ms', '250', '--process-name', 'WowB', '--pitch-search']);
  const out = spawns[0].child.stdout;
  out.emit('data', Buffer.from('{"info":"attached"}\n{"id":4,"te'));
  out.emit('data', Buffer.from('xt":"split across chunks"}\n{"error":"DISPLAY is not set","kind":"capture_unsupported"}\n'));
  assert.equal(ev.payloads[0].text, 'split across chunks');
  assert.deepEqual(ev.errors, [{ kind: 'capture_unsupported', message: 'DISPLAY is not set' }]);
  spawns[0].child.emit('exit', 3, null);
  await until(() => spawns.length === 2);
  cap.stop();
  assert.equal(spawns[1].child.killed, true);
});

test('Linux: window name, composite hint, an upstream magic and no pitch search are passed through', () => {
  const spawns = [];
  const cap = createX11Capture({ magic: 'C71A', pitchSearch: false, windowName: 'World of Warcraft', keepComposited: true, python: '/usr/bin/python3',
    spawnImpl: (cmd, args) => { spawns.push([cmd, ...args]); return fakeChild(); } });
  cap.start();
  assert.deepEqual(spawns[0].slice(0, 1), ['/usr/bin/python3']);
  assert.deepEqual(spawns[0].slice(2), ['--magic', 'C71A', '--interval-ms', '250', '--process-name', 'WowB', '--window-name', 'World of Warcraft', '--keep-composited']);
  cap.stop();
});

test('Linux: status() says connected only once the script has written a line', async () => {
  const spawns = [];
  const cap = createX11Capture({ spawnImpl: (cmd, args) => { const c = fakeChild(); spawns.push(c); return c; } });
  cap.start();
  assert.deepEqual([cap.status().running, cap.status().connected], [true, false]);
  spawns[0].stdout.emit('data', Buffer.from('{"info":"attached to window 0x1 (800x600)"}\n'));
  assert.equal(cap.status().connected, true);
  cap.stop();
});

test('Linux: a python that isn\'t there (a real spawn) is retried, and never reported as connected', async () => {
  const { ev, cbs } = recorder();
  const cap = createX11Capture({ python: path.join(TMP, 'no-such-python3'), relaunchMs: 20, ...cbs });
  cap.start();
  await until(() => ev.logs.filter(([tag]) => tag === 'capture-launch').length >= 2, 5000);
  assert.ok(ev.errors.length >= 1 && ev.errors.every(e => e.kind === 'helper_failed'));
  assert.equal(cap.status().connected, false);
  await until(() => !cap.status().running, 5000);
  cap.stop();
});

test('Linux: the script\'s game lines reach onGame (the quit recap needs "exited")', () => {
  const spawns = [];
  const { ev, cbs } = recorder();
  const cap = createX11Capture({ spawnImpl: () => { const c = fakeChild(); spawns.push(c); return c; }, ...cbs });
  cap.start();
  spawns[0].stdout.emit('data', Buffer.from('{"game":"absent"}\n{"game":"launched","pid":4242}\n'
    + '{"info":"attached to window 0x2 (1920x1080)","window":{"pid":4242,"width":1920,"height":1080}}\n'
    + '{"error":"waiting for WowB window (the game isn\'t running, or its window has another name)","kind":"window_not_found"}\n{"game":"exited","pid":4242}\n'));
  assert.deepEqual(ev.games, [{ state: 'absent', pid: null }, { state: 'launched', pid: 4242 }, { state: 'running', pid: 4242 }, { state: 'exited', pid: 4242 }]);
  assert.equal(ev.errors[0].kind, 'window_not_found');
  assert.equal(cap.status().window.width, 1920);
  cap.stop();
});

// ---------------------------------------------------------------- lines

test('lineSplitter: a character split between two reads arrives whole', () => {
  const got = [];
  const split = lineSplitter(l => got.push(l));
  const line = Buffer.from('{"id":1,"text":"Mulgore → Hyjal 🐉 ✓"}\n', 'utf8');
  const arrow = line.indexOf(Buffer.from('→'));
  const dragon = line.indexOf(Buffer.from('🐉'));
  // Cut inside the 3-byte arrow and twice inside the 4-byte dragon.
  for (const [a, b] of [[0, arrow + 1], [arrow + 1, arrow + 2], [arrow + 2, dragon + 1], [dragon + 1, dragon + 3], [dragon + 3, line.length]]) split(line.subarray(a, b));
  assert.deepEqual(got, ['{"id":1,"text":"Mulgore → Hyjal 🐉 ✓"}']);
  assert.ok(!got[0].includes('\uFFFD'));
  // A runaway line is dropped at 1 MiB; the next line still arrives.
  split(Buffer.alloc((1 << 20) + 10, 0x61));
  split(Buffer.from('\n{"ok":1}\n'));
  assert.deepEqual(got.slice(1), ['{"ok":1}']);
});

// ---------------------------------------------------------------- dispatch

test('createCaptureForPlatform picks the helper per OS and routes the per-OS options', async () => {
  const mac = createCaptureForPlatform({ platform: 'darwin', mac: { app: '/nope.app', socketPath: path.join(TMP, 'd.sock') } });
  assert.equal(mac.kind, 'mac-app');

  const spawns = [];
  const spawnImpl = (cmd, args) => { spawns.push([cmd, ...args]); return fakeChild(); };
  const dir = fs.mkdtempSync(path.join(TMP, 'dispatch-'));
  const exe = path.join(dir, 'helper.exe');
  fs.writeFileSync(exe, 'MZ');
  const win = createCaptureForPlatform({ platform: 'win32', magic: 'C72C', intervalMs: 500,
    windows: { exe, processNames: ['WowB', 'Wow*'], spawnImpl } });
  assert.equal(win.kind, 'windows-helper');
  win.start();
  await until(() => spawns.length === 1);
  assert.equal(spawns[0][0], exe);
  assert.ok(spawns[0].includes('WowB,Wow*'));
  assert.equal(spawns[0][spawns[0].indexOf('--interval-ms') + 1], '500');
  win.stop();

  const lin = createCaptureForPlatform({ platform: 'linux', linux: { python: 'python3.12', spawnImpl } });
  assert.equal(lin.kind, 'x11');
  lin.start();
  assert.equal(spawns[1][0], 'python3.12');
  lin.stop();

  const errors = [];
  const other = createCaptureForPlatform({ platform: 'freebsd', onError: e => errors.push(e) });
  assert.equal(other.kind, 'none');
  other.start();
  assert.deepEqual(errors, [{ kind: 'capture_unsupported', message: "screen capture isn't supported on freebsd" }]);
  assert.deepEqual(other.status(), { kind: 'none', connected: false });
});

test('the shared line contract ignores junk and keeps the last stats, permission and window', () => {
  const got = [];
  const h = createLineHandler({ onPayload: p => got.push(['p', p.id]), onStatus: s => got.push(['s', Object.keys(s)[0]]), onError: e => got.push(['e', e.kind]) });
  for (const l of ['not json', '[]', 'null', '{"id":"7","text":"x"}', '{"error":"plain"}', '{"stats":{"frames":1}}', '{"permission":false}', '{"id":8,"text":"ok"}']) h.onLine(l);
  assert.deepEqual(got, [['e', 'capture_error'], ['s', 'stats'], ['s', 'permission'], ['p', 8]]);
  assert.equal(h.state.stats.frames, 1);
  assert.equal(h.state.permission, false);
  // A typed error holds in state until the helper says capture works again (once, "cleared").
  assert.equal(h.state.error.kind, 'capture_error');
  h.onLine('{"info":"capturing"}');
  assert.equal(h.state.error.kind, 'capture_error', 'a plain info line clears nothing');
  h.onLine('{"info":"capturing","cleared":true}');
  assert.equal(h.state.error, null);
  assert.deepEqual(got.at(-1), ['s', 'error']);
});

// npm run capture:build (bridge/capture/build.mjs): this computer's helper, where a run from source looks for it;
// on Windows only in Git Bash, whose MSYSTEM it checks (from PowerShell, `bash` can be WSL's; systems critic OS-16).
test('capture:build builds the helper for the computer it runs on: the Mac app, the Windows helper in Git Bash, nothing on Linux', () => {
  assert.deepEqual(buildPlan('darwin', {}, ['--universal']), { cmd: path.join(MAC, 'build-app.sh'), args: ['--universal'] });
  const win = buildPlan('win32', { MSYSTEM: 'MINGW64' });
  assert.equal(win.cmd, 'bash');
  assert.deepEqual(win.args.slice(1), ['--native']);
  assert.ok(win.args[0].endsWith('bridge/capture/windows/build.sh') && !win.args[0].includes('\\'), 'a path Git Bash reads');
  assert.equal(path.resolve(win.args[0]), path.join(REPO, 'bridge', 'capture', 'windows', 'build.sh'));
  assert.deepEqual(buildPlan('win32', {}), { say: 'Build the Windows helper in Git Bash, with MinGW-w64\'s gcc on PATH: open Git Bash in this folder and run npm run capture:build again.', code: 1 });
  assert.equal(buildPlan('linux', {}).code, 0);
  assert.match(buildPlan('linux', {}).say, /capture_x11\.py/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts['capture:build'], 'node bridge/capture/build.mjs');
});
