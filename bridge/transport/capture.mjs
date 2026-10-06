// Capture helpers, one per OS (public BYOK PRD §11.1, §11.3; PF-1, PF-6, PF-7;
// SC-2, TH11), from the fork's Capture.app supervisor (fork PRD §9.10).
//
// createCaptureForPlatform(opts) picks this OS's helper. Each returns
// { kind, start(), stop(), status(), probe(), restart(), retryNow() } and reports through the same
// callbacks: onPayload({ id, text, at }) per strip payload, onGame({ state, pid })
// for the game's launch and exit, onError({ kind, message, locked?, asleep? }) for typed errors,
// onStatus for stats, permission, window, the Windows away line and the helper connecting
// ({ connected }), and log for everything else.
//
// restart() starts the running helper over (display DR-03): the Mac's socket is dropped (the app
// exits when it closes) and the Windows child is killed, and either comes back through the usual
// 3 s relaunch and its limiter; with nothing running, a start waiting on its backoff runs now. The
// capture watchdog (capture-health.mjs) and the app's Restart button share it. retryNow() is the
// button's second half: a helper that can't start (missing, unsigned, a socket that won't open) is
// tried again at once, its backoff started over.
//
// - darwin: "NeverQuestAlone Capture.app" (ScreenCaptureKit) on <state>/capture.sock
//   (0600, born under umask 077), launched through LaunchServices so the Screen
//   Recording grant belongs to the app, never to node (V-13). It is launched only
//   if it satisfies a code requirement: the bundle id from capture/mac/BUNDLE_ID
//   and either the local self-signed identity's certificate root (the existing
//   setup) or a Developer ID team (capture.teamId). With a team, every connection
//   to the socket is checked before a byte of it is read: whoever connected must
//   be signed with that bundle id by that team, or it's closed unread (checkPeer;
//   code health LS-03 / peer check).
// - win32: nqa-capture.exe (DXGI Desktop Duplication) on its own stdout,
//   spawned with anonymous pipes; its stdin stays open with nothing written, so
//   the helper exits when the bridge does (see createWindowsCapture).
// - linux: capture_x11.py (X11 under Wine) on stdout: magic C72C, --pitch-search.
//
// Every helper is relaunched after it exits (3-5 s), at most 5 launches a minute. One that can't
// start at all (missing, refused, a socket that won't open) is tried again after 30 s, 2 min, then
// every 10 min (RETRY_MS), where it used to stop for good (display audit D-12, BH-05).
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLE_ID_FILE = path.join(HERE, '..', 'capture', 'mac', 'BUNDLE_ID');
export const X11_SCRIPT = path.join(HERE, '..', 'capture_x11.py');
export const WINDOWS_EXE = path.join(HERE, '..', 'capture', 'windows', 'build', 'nqa-capture.exe');

const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const TEAM_RE = /^[A-Z0-9]{10}$/;
const SHA1_RE = /^[0-9a-f]{40}$/i;

/**
 * How often the helpers write their stats line, in seconds (display R0): the watchdog's hung and
 * stalled rules count in these lines, and at 60 s they would need 60-120 s to call anything.
 */
export const STATS_SEC = 10;
/** A helper that can't start is tried again after these waits, the last one repeating (DR-03). */
export const RETRY_MS = Object.freeze([30_000, 120_000, 600_000]);
/** A second refused instance lock within this is a helper that can't start (SY-15). */
export const BUSY_REPEAT_MS = 120_000;
/**
 * The Mac socket's peer check (code health LS-03 / peer check): how long one check may take (it
 * answers in about 10-200 ms; a launch waits 10 s to connect), and how many run at once (a flood of
 * connections is refused unchecked rather than met with a process each).
 */
export const PEER_CHECK_MS = 5000;
export const PEER_CHECKS_MAX = 4;

/** The capture app's bundle id: one constant, shared with build-app.sh and main.swift (PF-6). */
export function readBundleId(file = BUNDLE_ID_FILE) {
  const id = fs.readFileSync(file, 'utf8').trim();
  if (!BUNDLE_RE.test(id)) throw new Error(`${file}: not a bundle id`);
  return id;
}
export const CAPTURE_BUNDLE_ID = readBundleId();

/** The local self-signed identity: a code-signing certificate with exactly this name (build-app.sh says how). */
export const IDENTITY_NAME = 'NeverQuestAlone Local Code Signing';

/** What codesign says about an app (diagnostics only; the gate is the requirement). */
export function appSigning(app, run = spawnSync) {
  const r = run('codesign', ['-dv', '--verbose=2', app], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS });
  const text = (r.stderr || '') + (r.stdout || '');
  return {
    signed: r.status === 0,
    adhoc: /Signature=adhoc/.test(text),
    authority: (text.match(/^Authority=(.+)$/m) || [])[1] || null,
    identifier: (text.match(/^Identifier=(.+)$/m) || [])[1] || null,
    teamId: (text.match(/^TeamIdentifier=(.+)$/m) || [])[1] || null,
  };
}

// The launch check's two programs (security, codesign) get this long each (code health BR-05): it
// ran with no time limit on the app's main thread.
export const CHECK_TIMEOUT_MS = 10_000;

/** SHA-1s (lowercase hex) of the keychain certificates named exactly `identity`. */
export function localCertRoots(identity = IDENTITY_NAME, run = spawnSync) {
  return certRootsIn(run('security', ['find-certificate', '-a', '-c', identity, '-Z'], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS }), identity);
}
function certRootsIn(r, identity) {
  if (r?.status !== 0 || !r.stdout) return [];
  const certs = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    const sha1 = line.match(/^SHA-1 hash: ([0-9A-Fa-f]{40})\s*$/);
    if (sha1) { cur = { sha1: sha1[1].toLowerCase(), names: [] }; certs.push(cur); continue; }
    const name = line.match(/^\s*"(?:labl|alis)"<blob>="(.*)"\s*$/);
    if (name && cur) cur.names.push(name[1]);
  }
  // `-c` matches substrings; only a certificate with exactly this name counts.
  return [...new Set(certs.filter(c => c.names.includes(identity)).map(c => c.sha1))];
}

/**
 * The code requirement the capture app must satisfy: its bundle id, and either
 * one of the local identity's certificate roots or a Developer ID team.
 */
export function buildRequirement({ bundleId = CAPTURE_BUNDLE_ID, certRoots = [], teamId = null } = {}) {
  if (!BUNDLE_RE.test(bundleId || '')) throw new Error(`bad bundle id ${JSON.stringify(bundleId)}`);
  const signers = [];
  for (const h of certRoots || []) {
    if (!SHA1_RE.test(h)) throw new Error(`bad certificate hash ${JSON.stringify(h)}`);
    signers.push(`certificate root = H"${h.toLowerCase()}"`);
  }
  if (teamId != null) {
    if (!TEAM_RE.test(teamId)) throw new Error(`capture.teamId must be a 10-character Apple team ID, not ${JSON.stringify(teamId)}`);
    // Apple's Developer ID form: an Apple anchor, the Developer ID CA and application
    // certificate extensions, and the team in the leaf's OU.
    signers.push('(anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] and '
      + `certificate leaf[field.1.2.840.113635.100.6.1.13] and certificate leaf[subject.OU] = "${teamId}")`);
  }
  if (!signers.length) throw new Error(`no signer to accept: "${IDENTITY_NAME}" isn't in your keychain and capture.teamId isn't set`);
  return `identifier "${bundleId}" and (${signers.join(' or ')})`;
}

/** codesign --verify --strict -R: does the app satisfy the requirement? */
export function verifyRequirement(app, requirement, run = spawnSync) {
  return verdict(run('codesign', ['--verify', '--strict', '-R', '=' + requirement, app], { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS }));
}
function verdict(r) {
  const detail = ((r?.stderr || '') + (r?.stdout || '')).trim().split('\n').slice(-2).join(' ').slice(0, 300);
  return { ok: r?.status === 0, status: r?.status ?? null, detail: detail || (r?.timedOut ? 'codesign timed out' : '') };
}

// The launch check once per run (code health BR-05): two programs a few hundred ms long, which the
// Screen Recording check ran every 10 s on the app's main thread, and every helper launch runs too.
// A pass is kept for the helper as it is on disk: the bundle folder's, its executable's and its
// signature's identity (device, inode, size, mtime and ctime, which no one can set back), so a
// helper replaced or changed in place is checked again. A refusal, or a check that timed out or
// couldn't run, isn't kept. Only the real programs' answers are kept (a test's own run is asked
// every time, unless it passes a cache).
const passed = new Map();
function onDisk(app) {
  const stamp = [];
  for (const f of [app, bundleExecutable(app), path.join(app, 'Contents', '_CodeSignature', 'CodeResources')]) {
    if (!f) return null;
    let st;
    try { st = fs.statSync(f); } catch { return null; }
    stamp.push([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs].join(':'));
  }
  return stamp.join('|');
}
function passKey(app, { teamId, certRoots, identity, bundleId }) {
  const stamp = typeof app === 'string' && app ? onDisk(app) : null;
  return stamp && JSON.stringify([path.resolve(app), stamp, teamId ?? null, certRoots ?? null, identity, bundleId]);
}

/**
 * The launch check: build the requirement from the keychain's local identity and
 * capture.teamId, then verify the app against it.
 * { ok, requirement, detail } (requirement is null when there is no signer to accept).
 */
export function checkCaptureApp(app, { teamId = null, certRoots = null, identity = IDENTITY_NAME, bundleId = CAPTURE_BUNDLE_ID, run = spawnSync, cache = run === spawnSync ? passed : null } = {}) {
  const key = cache ? passKey(app, { teamId, certRoots, identity, bundleId }) : null;
  if (key && cache.has(key)) return { ...cache.get(key) };
  let requirement;
  try {
    requirement = buildRequirement({ bundleId, certRoots: certRoots ?? localCertRoots(identity, run), teamId });
  } catch (e) {
    return { ok: false, requirement: null, detail: e.message };
  }
  const v = verifyRequirement(app, requirement, run);
  const out = { ok: v.ok, requirement, detail: v.ok ? '' : v.detail };
  if (key && out.ok) cache.set(key, out);
  return { ...out };
}

/** execFile as a promise: {status, stdout, stderr, timedOut}; never throws. */
export function runAsync(cmd, args, { timeout } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      resolve({ status: err ? (Number.isInteger(err.code) ? err.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: !!err?.killed });
    });
  });
}

/**
 * checkCaptureApp off the main thread (code health BR-05): the same check and the same kept passes,
 * its two programs run as async child processes, CHECK_TIMEOUT_MS each. run(cmd, args, {timeout})
 * → Promise<{status, stdout, stderr}>.
 */
export async function checkCaptureAppAsync(app, { teamId = null, certRoots = null, identity = IDENTITY_NAME, bundleId = CAPTURE_BUNDLE_ID, run = runAsync, cache = run === runAsync ? passed : null } = {}) {
  const key = cache ? passKey(app, { teamId, certRoots, identity, bundleId }) : null;
  if (key && cache.has(key)) return { ...cache.get(key) };
  let requirement;
  try {
    const roots = certRoots ?? certRootsIn(await run('security', ['find-certificate', '-a', '-c', identity, '-Z'], { timeout: CHECK_TIMEOUT_MS }), identity);
    requirement = buildRequirement({ bundleId, certRoots: roots, teamId });
  } catch (e) {
    return { ok: false, requirement: null, detail: e.message };
  }
  const v = verdict(await run('codesign', ['--verify', '--strict', '-R', '=' + requirement, app], { timeout: CHECK_TIMEOUT_MS }));
  const out = { ok: v.ok, requirement, detail: v.ok ? '' : v.detail };
  if (key && out.ok) cache.set(key, out);
  return { ...out };
}

/**
 * Splits a byte stream into lines (a runaway line without a newline is dropped at
 * 1 MiB). UTF-8 is decoded across chunks, so a character split between two reads
 * arrives whole.
 */
export function lineSplitter(onLine) {
  const utf8 = new StringDecoder('utf8');
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : utf8.write(chunk);
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (l.trim()) onLine(l);
    }
    if (buf.length > 1 << 20) buf = '';
  };
}

/**
 * The helpers' shared line contract ({stats} {game} {permission} {window} {away} {info|warn|error[,kind]}
 * {id,text}). state.error is the last typed error until the helper says it cleared
 * ({"info":"capturing","cleared":true}, both helpers), so status can rank a live error above "connected".
 * state.away is the Windows helper's lock line ({"away":"locked"|null}, display DR-26), kept and passed on
 * through onStatus (DR-03). A typed error passes on what the line says beside its kind: the Mac's
 * access_lost carries locked and asleep (SY-18), a refused instance lock the pid holding it (SY-15).
 */
export function createLineHandler({ onPayload = () => {}, onStatus = () => {}, onGame = () => {}, onError = () => {}, log = () => {} } = {}) {
  const state = { stats: null, permission: null, window: null, error: null, away: null };
  function onLine(line) {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    if (ev.stats) { state.stats = { ...ev.stats, at: Date.now() }; onStatus({ stats: state.stats }); return; }
    // The game's own lifecycle: running, absent, launched, exited (companion F6).
    if (typeof ev.game === 'string') { log('capture-game', { game: ev.game, pid: ev.pid ?? null }); onGame({ state: ev.game, pid: Number.isInteger(ev.pid) ? ev.pid : null }); return; }
    // A locked session (the lock screen, a UAC prompt), on a line of its own: never a typed error, which
    // the helper mutes for a minute after a clear (D-34). Logged on a change only: it comes once a start.
    if (Object.hasOwn(ev, 'away')) {
      const away = typeof ev.away === 'string' && ev.away ? ev.away.slice(0, 20) : null;
      if (away !== state.away) log('capture-away', { away });
      state.away = away;
      onStatus({ away });
      return;
    }
    if ('permission' in ev) { state.permission = ev.permission; onStatus({ permission: state.permission }); }
    if (ev.window) { state.window = ev.window; onStatus({ window: state.window }); if (Number.isInteger(ev.window.pid)) onGame({ state: 'running', pid: ev.window.pid }); }
    if (ev.info || ev.warn || ev.error) {
      log(ev.error ? 'capture-error' : ev.warn ? 'capture-warn' : 'capture-info', ev);
      if (ev.error) {
        const e = { kind: typeof ev.kind === 'string' ? ev.kind : 'capture_error', message: String(ev.error) };
        if (typeof ev.locked === 'boolean') e.locked = ev.locked;
        if (typeof ev.asleep === 'boolean') e.asleep = ev.asleep;
        if (Number.isInteger(ev.holder) && ev.holder > 0) e.holder = ev.holder;
        state.error = { ...e, at: Date.now() };
        onError(e);
      } else if (ev.cleared === true && state.error) {
        state.error = null;
        onStatus({ error: null });
      }
      return;
    }
    if (typeof ev.id === 'number' && typeof ev.text === 'string') onPayload({ id: ev.id, text: ev.text, at: Date.now() });
  }
  return { onLine, state };
}

/**
 * Calls onDone once when a child process is over: after 'exit', or after 'close'
 * alone (a spawn that fails emits 'error' and 'close' but never 'exit').
 */
function whenDone(c, onDone) {
  let done = false;
  const finish = (code, signal) => { if (!done) { done = true; onDone(code, signal); } };
  c.on('exit', finish);
  c.on('close', finish);
}

/** At most `max` launches a minute; returns false (and says so) when over. */
function launchLimiter(max = 5) {
  const launches = [];
  return (now = Date.now()) => {
    while (launches.length && now - launches[0] > 60000) launches.shift();
    if (launches.length >= max) return false;
    launches.push(now);
    return true;
  };
}

/**
 * A start that failed, tried again on a backoff (RETRY_MS: 30 s, 2 min, then every 10 min). One try
 * waits at a time; run() takes a waiting one now (the watchdog's restart), keeping the backoff's place;
 * reset() starts the backoff over (a start that worked, the app's Restart button).
 */
function startRetry(delays, log) {
  let step = 0;
  let timer = null;
  let task = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; task = null; };
  return {
    schedule(fn, why) {
      if (timer) return;
      const ms = delays[Math.min(step, delays.length - 1)];
      step += 1;
      task = fn;
      log('capture-retry', { why, inMs: ms });
      timer = setTimeout(() => { const f = task; clear(); f?.(); }, ms);
      timer.unref?.();
    },
    run() { if (!timer) return false; const f = task; clear(); f?.(); return true; },
    reset() { step = 0; },
    pending: () => !!timer,
    clear,
  };
}

// ---------------------------------------------------------------- macOS

/**
 * The longest Unix socket path in bytes: macOS's sockaddr_un holds 104 with the closing NUL. A
 * longer one is refused (EINVAL) by some Node versions and silently cut short by others, which then
 * bind at another path (release.yml's dry run, SY-16: Node 22 on macOS listened, and the chmod after
 * it found no file there).
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/**
 * The executable a capture app bundle runs: Contents/MacOS/<CFBundleExecutable of its Info.plist>, or
 * the one file in Contents/MacOS; null when neither says.
 */
export function bundleExecutable(app) {
  const macos = path.join(app, 'Contents', 'MacOS');
  try {
    const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
    const name = (plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
    if (name && !name.includes('/')) return path.join(macos, name.trim());
  } catch { /* no plist: the folder may still say */ }
  try {
    const files = fs.readdirSync(macos);
    return files.length === 1 ? path.join(macos, files[0]) : null;
  } catch { return null; }
}

/** Are these the same file? Both as real paths (an /Applications symlink, App Translocation), else as given. */
function samePath(a, b) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return !!a && !!b && real(a) === real(b);
}

/**
 * The app's side of the peer check on the Mac's socket (code health LS-03 / peer check). Node can't
 * name a socket's peer, so the capture helper's own signed executable does (its --check-peer mode,
 * PeerCheck.swift): run directly with the accepted connection as its fd 3 (Node hands a socket in
 * stdio to the child as a duplicate of its descriptor; checked on Node 22, 24 and 26 and on
 * Electron 44's Node 24), it reads that socket's peer audit token (LOCAL_PEERTOKEN: the process that
 * connected, never a pid that could be reused), names its code, and exits 0 when it meets
 * `requirement`, else 6 with one stderr line. Node stops reading a socket it hands to a child, so
 * nothing of the connection is read meanwhile; whoever takes it resumes it. Anything but exit 0 within
 * timeoutMs refuses: no executable, a spawn that fails, a crash, a hang (killed).
 * → Promise<{ ok, why }> (why null when ok), never rejected.
 */
export function checkPeer(socket, { exe, requirement, timeoutMs = PEER_CHECK_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let err = '';
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, why: ok ? null : String(why || 'refused').replace(/^NeverQuestAlone Capture: refused: /, '').slice(0, 200) });
    };
    if (!exe) { done(false, 'no capture helper executable to check with'); return; }
    let child;
    try {
      child = spawnImpl(exe, ['--check-peer', requirement], { stdio: ['ignore', 'ignore', 'pipe', socket] });
    } catch (e) { done(false, `the check could not run (${e?.code || 'error'})`); return; }
    timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(false, `the check didn't answer within ${timeoutMs} ms`); }, timeoutMs);
    timer.unref?.();
    child.stderr?.on('data', (d) => { if (err.length < 1000) err += d; });
    child.on('error', e => done(false, `the check could not run (${e?.code || 'error'})`));
    child.on('close', (code, signal) => done(code === 0, err.split('\n').map(l => l.trim()).find(Boolean) || `the check exited ${code ?? signal}`));
  });
}

export function createCapture({ app, socketPath, magic = 'C72C', intervalMs = 250, statsSec = STATS_SEC, launch = true, connectWaitMs = 10000,
  teamId = null, certRoots = null, identity = IDENTITY_NAME, bundleId = CAPTURE_BUNDLE_ID, run = spawnSync,
  onPayload = () => {}, onStatus = () => {}, onGame = () => {}, onError = () => {}, log = () => {},
  spawnOpen = (args) => spawn('open', args, { stdio: 'ignore' }),
  relaunchMs = 3000, retryMs = RETRY_MS, busyRepeatMs = BUSY_REPEAT_MS, kill = (pid, signal) => process.kill(pid, signal),
  peerCheck = undefined, peerChecksMax = PEER_CHECKS_MAX }) {
  let server = null;
  let sock = null;
  let stopping = false;
  let listening = false;
  let connectTimer = null; // a launch waiting to connect
  let unconnected = 0;     // launches in a row that didn't connect in connectWaitMs (the next is open -n)
  let busyAt = 0;          // the last refused instance lock (instance_busy)
  const checking = new Set(); // connections whose peer check runs
  // Who may connect (code health LS-03 / peer check): with a Developer ID team (boot's: a signed app's
  // own, else capture.teamId), the helper this app launches, signed with its bundle id by that team, and
  // nothing else: every connection, the first and any in the 3 s before a relaunch, before a byte of it
  // is read (checkPeer, with the helper's own executable and boot's requirement for it, the team's
  // branch alone). That executable sits in the app's own signed bundle, which the launch check verifies
  // (again whenever it changes on disk: BR-05's kept passes) and macOS keeps other programs from
  // changing (App Management, macOS 13 on; the helper needs 14). An unsigned or ad hoc build has no team
  // and checks none, as the helper's own check skips when it has none. peerCheck replaces the check
  // (tests: (socket) → { ok, why }), null drops it.
  const verify = peerCheck !== undefined ? peerCheck : teamId == null ? null : (s) => {
    let requirement;
    try { requirement = buildRequirement({ bundleId, teamId }); } catch (e) { return { ok: false, why: e.message }; }
    return checkPeer(s, { exe: bundleExecutable(app), requirement });
  };
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref?.();
    timers.add(t);
    return t;
  };
  const allowLaunch = launchLimiter();
  const retry = startRetry(retryMs, log);
  const lines = createLineHandler({ onPayload, onStatus, onGame, onError: helperError, log });

  // A copy the app couldn't start because an old one keeps the instance lock (SY-15): the old one is
  // killed only when it is this app's own executable, compared as real paths, so a pid the lock file
  // names that some other program reuses now is left alone. A second refusal within 2 minutes is a
  // helper that can't start, tried again on the backoff.
  function helperError(e) {
    if (e?.kind !== 'instance_busy') { onError(e); return; }
    const t = Date.now();
    const again = busyAt && t - busyAt < busyRepeatMs;
    busyAt = t;
    if (again) {
      log('capture-error', { error: 'the capture helper\'s instance lock is still held after the old copy was stopped', holder: e.holder ?? null });
      onError({ kind: 'helper_failed', message: 'another copy of the capture helper keeps its lock' });
      retry.schedule(launchApp, 'instance_busy');
      return;
    }
    const pid = e.holder;
    const exe = Number.isInteger(pid) && pid > 1 ? String(run('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' })?.stdout ?? '').trim() : '';
    const mine = bundleExecutable(app);
    if (!exe || !mine || !samePath(exe, mine)) {
      log('capture-warn', { warn: 'another program holds the capture helper\'s instance lock; it is left alone', holder: pid ?? null });
      return;
    }
    try {
      kill(pid, 'SIGKILL');
      log('capture-holder-stopped', { holder: pid });
    } catch (err) {
      log('capture-error', { error: `the old capture helper could not be stopped (${err?.code || 'error'})`, holder: pid });
    }
    // The refused copy exits now, and its socket closing relaunches the helper through the limiter.
  }

  function refuse(message, extra) {
    log('capture-error', { error: `refusing to launch: ${message}`, ...extra });
    onError({ kind: 'signature_invalid', message });
    return false;
  }

  function signedOk() {
    const v = checkCaptureApp(app, { teamId, certRoots, identity, bundleId, run });
    if (v.ok) return true;
    if (!v.requirement) return refuse(v.detail);
    return refuse('the app does not satisfy the code requirement', { requirement: v.requirement, detail: v.detail, sig: appSigning(app, run) });
  }

  // open's own exit: a launch LaunchServices refused (no such app, a damaged bundle) is a failed start.
  function watchOpen(child) {
    if (!child || typeof child.on !== 'function') return;
    child.on('error', (err) => {
      log('capture-error', { error: `open could not run: ${err?.code || err?.message || 'error'}` });
      onError({ kind: 'helper_failed', message: `open could not run (${err?.code || 'error'})` });
    });
    child.on('exit', (code) => {
      if (code === 0 || code === null || stopping) return;
      log('capture-error', { error: `open exited ${code}` });
      onError({ kind: 'helper_failed', message: `the capture app didn't open (open exited ${code})` });
    });
  }

  function launchApp() {
    if (!launch || stopping || sock) return;
    if (!listening) { listen(); return; }
    if (!fs.existsSync(app)) {
      log('capture-error', { error: `no app at ${app}; run npm run capture:build` });
      onError({ kind: 'helper_missing', message: `no capture app at ${app}` });
      retry.schedule(launchApp, 'helper_missing');
      return;
    }
    if (!signedOk()) { retry.schedule(launchApp, 'signature_invalid'); return; }
    if (!allowLaunch()) {
      log('capture-error', { error: 'capture app keeps exiting; not relaunching for a minute' });
      later(launchApp, 60000);
      return;
    }
    // After a launch that never connected (LaunchServices kept a copy it thinks runs, or an old copy
    // that won't exit): a new instance (-n). The instance lock keeps it to one, and a copy it refuses
    // names the holder (SY-15).
    const fresh = unconnected > 0;
    watchOpen(spawnOpen([...(fresh ? ['-n'] : []), '-g', '-a', app, '--args', '--socket', socketPath, '--magic', magic,
      '--interval-ms', String(intervalMs), '--stats-sec', String(statsSec)]));
    log('capture-launch', fresh ? { fresh: true } : {});
    // Not connected in 10 s (LaunchServices dropped the launch, or it died first): launch again (SY-04),
    // at most 5 times a minute (allowLaunch).
    if (connectTimer) { clearTimeout(connectTimer); timers.delete(connectTimer); }
    connectTimer = later(() => {
      connectTimer = null;
      if (sock || stopping) return;
      unconnected += 1;
      log('capture-warn', { warn: 'the capture helper did not connect within 10 s; launching a new copy of it' });
      launchApp();
    }, connectWaitMs);
  }

  // The helper's connection, once it's this app's: its lines are read from here on.
  function take(s) {
    sock = s;
    unconnected = 0;
    if (connectTimer) { clearTimeout(connectTimer); timers.delete(connectTimer); connectTimer = null; }
    log('capture-conn', { connected: true });
    onStatus({ connected: true });
    s.on('data', lineSplitter(lines.onLine));
    s.on('close', () => {
      if (sock === s) sock = null;
      log('capture-conn', { connected: false });
      onStatus({ connected: false });
      // Relaunched in 3 s, unless a start already waits on the backoff (a lock that stays held).
      if (!stopping && !retry.pending()) later(() => { if (!stopping && !sock) launchApp(); }, relaunchMs);
    });
    s.resume();
  }

  // A connection that isn't the helper's (code health LS-03 / peer check): closed unread, one typed
  // line. The socket stays open for the helper.
  function refusePeer(s, why) {
    log('capture-peer-refused', { why: String(why || 'refused').slice(0, 200) });
    s.destroy();
  }

  // The socket. One that can't be opened here at all (a path too long for one, or a path cut short)
  // is capture_unsupported: no retry can change that (audit PF-07, LS-07). A listen() that fails (a
  // folder it can't write, the address in use) is a helper that can't start: helper_failed, tried again
  // on the backoff (DR-03, D-41), never an uncaught error that leaves capture dead for good.
  // Connections come paused (pauseOnConnect): nothing is read from one before verify says it's the
  // helper's (LS-03 / peer check), or at once when there's nothing to verify.
  function listen() {
    if (stopping || listening || server) return;
    try { fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 }); } catch { /* listen says why */ }
    try { fs.unlinkSync(socketPath); } catch { /* none */ }
    const cantOpen = (why) => {
      log('capture-error', { error: `capture socket: ${why}` });
      onError({ kind: 'capture_unsupported', message: `the capture socket could not be opened (${why})` });
    };
    // Refused before listen(), the same on every Node (MAX_SOCKET_PATH_BYTES).
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) { cantOpen('EINVAL'); return; }
    const srv = net.createServer({ pauseOnConnect: true }, (s) => {
      s.on('error', () => {});
      if (sock) { log('capture-warn', { warn: 'a second capture connection was refused' }); s.destroy(); return; }
      if (!verify) { take(s); return; }
      if (checking.size >= peerChecksMax) { refusePeer(s, `${checking.size} connections are being checked already`); return; }
      checking.add(s);
      Promise.resolve().then(() => verify(s)).catch(e => ({ ok: false, why: e?.message })).then((v) => {
        checking.delete(s);
        if (stopping) { s.destroy(); return; }
        if (v?.ok !== true) { refusePeer(s, v?.why); return; }
        if (sock) { log('capture-warn', { warn: 'a second capture connection was refused' }); s.destroy(); return; }
        take(s);
      });
    });
    server = srv;
    const oldMask = process.umask(0o077);
    // The umask comes back on every path.
    let up = false;
    srv.on('error', (err) => {
      const why = err?.code || err?.message || 'error';
      if (up) { log('capture-error', { error: `capture socket: ${why}` }); return; }
      process.umask(oldMask);
      try { srv.close(); } catch { /* not listening */ }
      if (server === srv) server = null;
      log('capture-error', { error: `capture socket: ${why}` });
      onError({ kind: 'helper_failed', message: `the capture socket could not be opened (${why})` });
      retry.schedule(launchApp, `listen ${why}`);
    });
    srv.listen(socketPath, () => {
      up = true;
      process.umask(oldMask);
      if (stopping) { try { srv.close(); } catch { /* closing */ } return; }
      // A socket that isn't where it was asked for (a cut-short path) is closed, never used.
      try { fs.chmodSync(socketPath, 0o600); } catch (e) {
        try { srv.close(); } catch { /* closing */ }
        cantOpen(e?.code || 'error');
        return;
      }
      listening = true;
      retry.reset();
      launchApp();
    });
  }

  return {
    kind: 'mac-app',
    start() { listen(); },
    // error: the helper's last typed error until it says cleared (a stream back after access_lost), as on
    // Windows, so a Mac that reads nothing never shows "can see the game" (SY-04).
    status: () => ({ kind: 'mac-app', connected: !!sock, permission: lines.state.permission, window: lines.state.window, stats: lines.state.stats, error: lines.state.error }),
    /**
     * Start the helper over (DR-03). A connected one: its socket is dropped, the app exits when it
     * closes, and the close relaunches it in 3 s as a new instance, so an old copy that doesn't exit is
     * met by the instance lock and stopped (SY-15). With none connected, a start waiting on its backoff
     * runs now. → whether anything was done.
     */
    restart(reason = 'restart') {
      if (stopping) return false;
      if (sock) {
        log('capture-restart', { reason });
        unconnected = Math.max(unconnected, 1);
        try { sock.destroy(); } catch { /* closing */ }
        return true;
      }
      return retry.run();
    },
    /** The app's Restart button: a helper that can't start is tried again now, its backoff started over. */
    retryNow() {
      if (stopping || sock) return false;
      retry.reset();
      if (retry.run()) return true;
      if (connectTimer) return false; // a launch is already waiting to connect
      launchApp();
      return true;
    },
    stop() {
      stopping = true;
      retry.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try { sock?.destroy(); } catch { /* closing */ }
      for (const s of checking) { try { s.destroy(); } catch { /* closing */ } }
      try { server?.close(); } catch { /* closing */ }
      try { fs.unlinkSync(socketPath); } catch { /* gone */ }
    },
  };
}

// ---------------------------------------------------------------- Windows

/**
 * nqa-capture.exe on its own stdout (systems plan Batch 1, SY-07). The helper is spawned with
 * three anonymous pipes: its JSON lines come on stdout, stderr goes to the log, and stdin stays
 * open with nothing written, so the helper exits when the bridge quits or crashes (end of file
 * there). An anonymous pipe has no name another process could find or squat, so there is no token,
 * hello or server-PID check.
 *
 * There is no signature check at launch either. The helper sits in a per-user install folder the
 * player's own account can write, and a program running as the player could as well replace the
 * app or read its Credential Manager items, so a check here crosses no boundary (the threat note in
 * app/desktop/src/api-loader.mjs); the PowerShell one it replaced blocked the main thread for up to
 * 20 s per launch and failed closed where PowerShell is locked down. What protects players stays:
 * the release job refuses a build unless every .exe and .node in it is validly signed,
 * electron-updater checks each installer's publisher, and Smart App Control and SmartScreen check
 * signatures when Windows loads them.
 *
 * Which window is the game's (the helper's winpick.c; display DR-05): an image named as processNames
 * says (any Wow*.exe by default) whose path has a folder named in flavorDirs (boot passes
 * FOREVER_FLAVORS; with none, no window is the game's), whose name holds none of notGame (boot passes
 * NOT_GAME: the game's voice proxy and crash reporter), minimized or at least 200 x 150 (not a launcher
 * or a splash screen). The best: under exeDir (the WoW folder the bridge serves) first, then visible
 * over minimized, then the largest; the helper looks again every 5 s while attached. So WowUp.exe, an
 * addon manager that the Wow* name alone matched, is never taken for the game (display audit D-03).
 * region is where its crop starts (900 x 300 physical pixels); it grows to hold a whole strip.
 */
export function createWindowsCapture({ exe = WINDOWS_EXE, magic = 'C72C', intervalMs = 250, statsSec = STATS_SEC,
  processNames = ['Wow*'], flavorDirs = [], notGame = [], exeDir = null,
  region = { width: 900, height: 300 }, logFile = null, launch = true, relaunchMs = 3000, retryMs = RETRY_MS,
  onPayload = () => {}, onStatus = () => {}, onGame = () => {}, onError = () => {}, log = () => {},
  spawnImpl = spawn } = {}) {
  let child = null;
  let heard = false;     // the running helper has written a line
  let stopping = false;
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    t.unref?.();
    timers.add(t);
    return t;
  };
  const allowLaunch = launchLimiter();
  const retry = startRetry(retryMs, log);
  const lines = createLineHandler({ onPayload, onStatus, onGame, onError, log });

  const words = list => (Array.isArray(list) ? list : []).filter(w => typeof w === 'string' && w !== '');
  function helperArgs() {
    return ['--process-name', processNames.join(','), '--width', String(region.width), '--height', String(region.height),
      '--interval-ms', String(intervalMs), '--magic', magic, '--stats-sec', String(statsSec), ...(logFile ? ['--log', logFile] : []),
      ...words(flavorDirs).flatMap(f => ['--flavor-dir', f]), ...words(notGame).flatMap(n => ['--not-game', n]),
      ...(typeof exeDir === 'string' && exeDir ? ['--exe-dir', exeDir] : [])];
  }

  function launchHelper() {
    if (!launch || stopping || child) return;
    if (!fs.existsSync(exe)) {
      // Missing (Defender quarantined it, an update half done): tried again on the backoff, where it
      // used to stop for good (DR-03, D-12).
      log('capture-error', { error: `no capture helper at ${exe}; run npm run capture:build in Git Bash` });
      onError({ kind: 'helper_missing', message: `no capture helper at ${exe}` });
      retry.schedule(launchHelper, 'helper_missing');
      return;
    }
    if (!allowLaunch()) {
      log('capture-error', { error: 'capture helper keeps exiting; not relaunching for a minute' });
      later(launchHelper, 60000);
      return;
    }
    let c;
    try {
      c = spawnImpl(exe, helperArgs(), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      // Windows throws some failures (a file that isn't a program: spawn UNKNOWN) instead of emitting
      // 'error': the same failure, and the same relaunch, never an exception out of a timer.
      log('capture-launch', { exe: path.basename(exe) });
      log('capture-error', { error: `capture helper could not start: ${err.message}` });
      onError({ kind: 'helper_failed', message: err.message });
      if (!stopping) later(launchHelper, relaunchMs);
      return;
    }
    child = c;
    heard = false;
    c.stdin?.on('error', () => {}); // open and silent: its end is the helper's signal to exit
    c.stdout?.on('data', lineSplitter((line) => {
      if (child === c && !heard) {
        heard = true;
        retry.reset();
        log('capture-conn', { connected: true });
        onStatus({ connected: true });
      }
      lines.onLine(line);
    }));
    c.stderr?.on('data', (d) => log('capture-warn', { warn: String(d).trim().slice(0, 300) }));
    c.on('error', (err) => {
      log('capture-error', { error: `capture helper could not start: ${err.message}` });
      onError({ kind: 'helper_failed', message: err.message });
    });
    whenDone(c, (code, signal) => {
      if (child === c) {
        child = null;
        if (heard) { log('capture-conn', { connected: false }); onStatus({ connected: false }); }
        heard = false;
      }
      log('capture-exit', { code, signal });
      if (!stopping) later(launchHelper, relaunchMs);
    });
    log('capture-launch', { exe: path.basename(exe) });
    later(() => {
      if (!heard && !stopping && child === c) log('capture-warn', { warn: 'the capture helper wrote nothing within 10 s' });
    }, 10000);
  }

  return {
    kind: 'windows-helper',
    start() { launchHelper(); },
    probe() { /* the Windows helper writes no files (PRD §11.3) */ },
    // away: the helper's lock line (DR-26), kept until it says otherwise.
    status: () => ({ kind: 'windows-helper', connected: !!child && heard, running: !!child, window: lines.state.window, stats: lines.state.stats, error: lines.state.error, away: lines.state.away }),
    /** Start the helper over (DR-03): the child is killed and relaunched in 3 s; with none, a start waiting on its backoff runs now. */
    restart(reason = 'restart') {
      if (stopping) return false;
      if (child) {
        log('capture-restart', { reason });
        try { child.kill(); } catch { /* gone */ }
        return true;
      }
      return retry.run();
    },
    /** The app's Restart button: a helper that can't start (missing) is tried again now, its backoff started over. */
    retryNow() {
      if (stopping || child) return false;
      retry.reset();
      if (retry.run()) return true;
      launchHelper();
      return true;
    },
    stop() {
      stopping = true;
      retry.clear();
      for (const t of timers) clearTimeout(t);
      timers.clear();
      try { child?.stdin?.end(); } catch { /* gone */ }
      try { child?.kill(); } catch { /* gone */ }
    },
  };
}

// ---------------------------------------------------------------- Linux (X11)

export function createX11Capture({ script = X11_SCRIPT, python = 'python3', magic = 'C72C', pitchSearch = true, intervalMs = 250,
  processName = 'WowB', windowName = '', keepComposited = false, launch = true, relaunchMs = 5000,
  onPayload = () => {}, onStatus = () => {}, onGame = () => {}, onError = () => {}, log = () => {}, spawnImpl = spawn } = {}) {
  let child = null;
  let heard = false;     // the running script has written a line (it started and found its display)
  let stopping = false;
  const allowLaunch = launchLimiter();
  const lines = createLineHandler({ onPayload, onStatus, onGame, onError, log });

  function scriptArgs() {
    return [script, '--magic', magic, '--interval-ms', String(intervalMs), '--process-name', processName,
      ...(pitchSearch ? ['--pitch-search'] : []), ...(windowName ? ['--window-name', windowName] : []),
      ...(keepComposited ? ['--keep-composited'] : [])];
  }

  function launchScript() {
    if (!launch || stopping || child) return;
    if (!allowLaunch()) {
      log('capture-error', { error: 'capture_x11.py keeps exiting; not relaunching for a minute' });
      setTimeout(launchScript, 60000).unref?.();
      return;
    }
    let c;
    try {
      c = spawnImpl(python, scriptArgs(), { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log('capture-launch', { script: path.basename(script) });
      log('capture-error', { error: `capture_x11.py could not start (${python}): ${err.message}` });
      onError({ kind: 'helper_failed', message: err.message });
      if (!stopping) setTimeout(launchScript, relaunchMs).unref?.();
      return;
    }
    child = c;
    heard = false;
    c.stdout?.on('data', lineSplitter((line) => { if (child === c) heard = true; lines.onLine(line); }));
    c.stderr?.on('data', (d) => log('capture-warn', { warn: String(d).trim().slice(0, 300) }));
    c.on('error', (err) => {
      log('capture-error', { error: `capture_x11.py could not start (${python}): ${err.message}` });
      onError({ kind: 'helper_failed', message: err.message });
    });
    whenDone(c, (code, signal) => {
      if (child === c) { child = null; heard = false; }
      log('capture-exit', { code, signal });
      if (!stopping) setTimeout(launchScript, relaunchMs).unref?.();
    });
    log('capture-launch', { script: path.basename(script) });
  }

  return {
    kind: 'x11',
    start() { launchScript(); },
    probe() { /* npm run probe runs capture_x11.py --probe by hand */ },
    status: () => ({ kind: 'x11', connected: !!child && heard, running: !!child, window: lines.state.window, stats: lines.state.stats }),
    /** Start the script over (DR-03): killed, and relaunched as after any exit. */
    restart(reason = 'restart') {
      if (stopping || !child) return false;
      log('capture-restart', { reason });
      try { child.kill(); } catch { /* gone */ }
      return true;
    },
    retryNow() { if (stopping || child) return false; launchScript(); return true; },
    stop() {
      stopping = true;
      try { child?.kill(); } catch { /* gone */ }
    },
  };
}

// ---------------------------------------------------------------- dispatch

/**
 * The capture helper for this OS. Shared options (callbacks, magic, intervalMs,
 * statsSec) apply to all; per-OS ones go in `mac` ({ app, socketPath, teamId,
 * certRoots, identity, spawnOpen, run, kill, relaunchMs, retryMs, busyRepeatMs, peerCheck }), `windows` ({ exe,
 * processNames, flavorDirs, notGame, exeDir, region, logFile, spawnImpl, relaunchMs, retryMs }) and
 * `linux` ({ script, python, pitchSearch, processName, windowName, keepComposited, spawnImpl }).
 */
export function createCaptureForPlatform({ platform = process.platform, mac = {}, windows = {}, linux = {}, ...common } = {}) {
  if (platform === 'darwin') return createCapture({ ...common, ...mac });
  if (platform === 'win32') return createWindowsCapture({ ...common, ...windows });
  if (platform === 'linux') return createX11Capture({ ...common, ...linux });
  const { onError = () => {}, log = () => {} } = common;
  return {
    kind: 'none',
    start() {
      log('capture-error', { error: `no capture helper for ${platform}` });
      onError({ kind: 'capture_unsupported', message: `screen capture isn't supported on ${platform}` });
    },
    probe() {},
    status: () => ({ kind: 'none', connected: false }),
    restart: () => false,
    retryNow: () => false,
    stop() {},
  };
}
