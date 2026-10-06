#!/usr/bin/env node
// Runs a packaged NeverQuestAlone's --self-test and checks the one JSON line it prints (systems
// plan Batches 1 and 5: test.yml's windows-smoke job runs it on the unsigned NSIS build, and it's
// the check after any local --dir build). The app makes its own temp data folder and removes it;
// --use-mock-keychain keeps Chromium off the macOS Keychain (it changes nothing elsewhere).
//
// Twice (systems critic SY-102-2): the self-test ends through the real quit (before-quit, will-quit's
// preventDefault, the bridge's stop, app.exit), and its lines must say quit-requested, quit-committed
// and the bridge stopped, with exit code 0; then --no-relaunch quits as Quit and reopen does
// (app.relaunch skipped, one asked for) with a second launch during the quit (SY-102-3). The second
// run checks only the window on the real bridge, so it takes a second or two.
//
// A failed run names what failed (code-health AP-02): the app's own list (failed: [names]), every
// false value, the quit's problems, and the crash dumps the self-test's crash reporter left in
// CRASH_DIR (main.mjs; CI keeps that folder when windows-smoke fails).
//
// Then a third start (code health AP-04): with --remote-debugging-port=<a free port> the packaged app
// must refuse before 'ready' (exit 1, its line, nothing a ready app says), and nothing may answer on
// that port while it runs or after (debugSwitchRefused). Every place CI runs this file runs it.
//
// And what the app may be started with (SR-05; src/launch-guard.mjs, src/net-guard.mjs): a fourth
// start with --gpu-launcher, a switch no launcher of the app's passes, must refuse before 'ready' the
// same way, its launcher never run (launchSwitchRefused). The full run starts with
// NAPI_RS_NATIVE_LIBRARY_PATH naming a file that records it ran, and NODE_EXTRA_CA_CERTS naming a CA
// file: the app must say it removed the first, its key store's binding must load, the file must never
// run, the second must be gone and Node must have added no certificate from it (startEnvProblems).
// The relaunch run starts with the switches the app's launchers pass (LAUNCHER_ARGS), so a build that
// refused one of them fails.
//
// A Mac app's full run also checks its capture helper's peer check (code health BR-01; main.mjs,
// src/capture-gate.mjs), and the app's own check of who connects to its socket (LS-03 / peer check).
// The app can't tell a build whose signing didn't happen from an ad hoc one, so a signed build's job
// says so: NQA_SELF_TEST_SIGNED=true asks for the app's team and every capture check (signedProblems).
//
//   node scripts/self-test.mjs "dist/mac-arm64/NeverQuestAlone.app"
//   node scripts/self-test.mjs "dist/win-unpacked/NeverQuestAlone.exe"
//   exit 0 ok · 1 the app said not ok (every false value and quit problem is named) · 2 usage, or no answer
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** The executable inside an .app bundle, or the path itself. */
export function appBinary(target) {
  const t = target.replace(/[\\/]+$/, '');
  return t.endsWith('.app') ? path.join(t, 'Contents', 'MacOS', path.basename(t, '.app')) : t;
}

/** Where a self-test's crash reporter writes its dumps (main.mjs, the same temp folder). */
export const CRASH_DIR = path.join(os.tmpdir(), 'nqa-self-test-crashes');

/** The crash dumps (.dmp) under dir, by their paths there; [] when there are none. */
export function crashDumpsIn(dir = CRASH_DIR) {
  try { return fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.toLowerCase().endsWith('.dmp')).sort(); } catch { return []; }
}

/** The self-test's JSON line in the app's stdout, or null. */
export function resultLine(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).reverse().find(l => l.startsWith('{"selfTest":"neverquestalone"'));
  if (!line) return null;
  try { return JSON.parse(line); } catch { return null; }
}

/** Every check that came back false, as dotted paths (checks.page.csp …). */
export function falseChecks(value, at = 'checks') {
  if (value === false) return [at];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([k, v]) => falseChecks(v, `${at}.${k}`));
}

/** The quit flow's lines in the app's stdout ({"selfTestQuit": line}), in order. */
export function quitLines(stdout) {
  const out = [];
  for (const l of String(stdout ?? '').split(/\r?\n/)) {
    if (!l.startsWith('{"selfTestQuit"')) continue;
    try { const v = JSON.parse(l).selfTestQuit; if (typeof v === 'string') out.push(v); } catch { /* not one */ }
  }
  return out;
}

/**
 * What the real quit must have said (SY-102-2): quit-requested, quit-committed, then the bridge
 * stopped, in that order, nothing stalled or failed, and the bridge never started again once the
 * quit was committed (quit-race: the exiting process rebooted it when its exit was only slow; a
 * slow exit is now "quit: still ending", and the exit code is still checked). The relaunch run also
 * asked for exactly one relaunch (skipped) and took the launch that came during the quit; the plain
 * run asked for none.
 * → the problems, [] when there are none.
 */
export function quitProblems(lines, { relaunch = false } = {}) {
  const p = [];
  const at = re => lines.findIndex(l => re.test(l));
  const req = at(/^quit-requested$/);
  const com = at(/^quit-committed$/);
  const stop = at(/^quit: the bridge stopped in \d/);
  if (req < 0) p.push('no quit-requested');
  if (com < 0) p.push('no quit-committed');
  if (stop < 0) p.push('no "quit: the bridge stopped"');
  if (req >= 0 && com >= 0 && stop >= 0 && !(req < com && com < stop)) p.push('the quit\'s lines are out of order');
  for (const l of lines) if (/^quit-stalled|^quit: .*failed/.test(l)) p.push(l);
  if (com >= 0) for (const l of lines.slice(com + 1)) if (/^the bridge starts again/.test(l)) p.push(`after the commit: ${l}`);
  const asked = lines.filter(l => l.startsWith('relaunch:')).length;
  if (relaunch) {
    if (asked !== 1 || !lines.includes('relaunch: skipped (--no-relaunch)')) p.push(`${asked} relaunches asked for, not one skipped`);
    if (at(/^quit: reopened during the quit/) < 0) p.push('no "quit: reopened during the quit"');
  } else if (asked) p.push('a relaunch in the plain quit');
  return p;
}

/**
 * What a signed Mac build's full run must have (BR-01): the app's Developer ID team, and its helper
 * serving it, refusing a stranger's socket and refusing aim; and the app's own listener closing a
 * stranger's connection and taking the helper's (LS-03 / peer check). → the problems, [] when there are none.
 */
export function signedProblems(checks) {
  const p = [];
  if (!/^[A-Z0-9]{10}$/.test(String(checks?.captureHelper?.team ?? ''))) p.push('the app has no Developer ID team');
  const peer = checks?.capturePeer;
  if (!peer || typeof peer !== 'object') p.push('no capture peer check ran');
  else for (const k of ['handshake', 'strangerRefused', 'argsRefused', 'connectRefused', 'connectAccepted']) if (peer[k] !== true) p.push(`capturePeer.${k} is not true`);
  return p;
}

/**
 * What the app's own launchers pass (src/net-guard.mjs ALLOWED_SWITCHES): the NSIS installer after
 * every Windows update (--updated), the Windows login item (--hidden), and COM's -Embedding when a
 * notification's click starts the app on Windows. Nothing in a self-test reads them.
 */
export const LAUNCHER_ARGS = Object.freeze(['--hidden', '--updated', ...(process.platform === 'win32' ? ['-Embedding'] : [])]);

/**
 * The two runs: the whole self-test, quit as the tray's Quit; then quit as Quit and reopen, relaunch
 * skipped, started as the app's launchers start it (a relaunch passes on what the launch had).
 */
export const RUNS = Object.freeze([
  Object.freeze({ run: 'full', args: Object.freeze(['--self-test', '--use-mock-keychain']) }),
  Object.freeze({ run: 'relaunch', args: Object.freeze(['--self-test', '--no-relaunch', '--use-mock-keychain', ...LAUNCHER_ARGS]) }),
]);

/** A variable the full run starts with (one src/net-guard.mjs guardLoaderEnv removes before any module loads). */
export const LOADER_VARIABLE = 'NAPI_RS_NATIVE_LIBRARY_PATH';
/**
 * The other (src/net-guard.mjs EXTRA_CA_ENV), naming a real CA file (one of Node's own roots): Electron
 * unsets it before Node reads it while the NODE_OPTIONS fuse is off, so it's gone and Node adds nothing.
 */
export const CA_VARIABLE = 'NODE_EXTRA_CA_CERTS';

/**
 * A CommonJS file that writes `ran` beside itself whenever it's run or require()d, and exports
 * nothing a loader could use. → { file, ran(), remove() }.
 */
export function tripwire(tmp = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tmp, 'nqa-self-test-wire-'));
  const file = path.join(dir, 'wire.cjs');
  fs.writeFileSync(file, "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran'), 'ran');\nmodule.exports = {};\n");
  return { file, ran: () => fs.existsSync(path.join(dir, 'ran')), remove: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } } };
}

/**
 * What the full run must say about the two variables it started with (SR-05): LOADER_VARIABLE removed
 * by the app, gone, the key store's binding loaded and the file it named never run; CA_VARIABLE gone
 * and no certificate added from it. → the problems, [] when there are none.
 */
export function startEnvProblems(checks, { ran = false } = {}) {
  const p = [];
  const le = checks?.loaderEnv;
  if (!le || typeof le !== 'object') p.push('no loader check ran');
  else {
    if (!Array.isArray(le.removed) || !le.removed.includes(LOADER_VARIABLE)) p.push(`the app didn't remove ${LOADER_VARIABLE}`);
    if (le.gone !== true) p.push(`${LOADER_VARIABLE} was still set`);
    if (le.keyStoreLoads !== true) p.push('the key store\'s binding didn\'t load');
  }
  if (ran) p.push(`the file ${LOADER_VARIABLE} named ran`);
  const ne = checks?.networkEnv;
  if (ne?.extraCaGone !== true) p.push(`${CA_VARIABLE} reached the app`);
  if (ne?.extraCaCerts !== 0) p.push(`Node added ${ne?.extraCaCerts ?? 'an unknown number of'} certificates from ${CA_VARIABLE}`);
  return p;
}

export function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`), spawn = spawnSync, timeoutMs = 60000, crashDir = CRASH_DIR, env = process.env } = {}) {
  if (argv.length !== 1 || argv[0].startsWith('-')) { stderr('usage: node scripts/self-test.mjs <NeverQuestAlone.app | NeverQuestAlone.exe | neverquestalone>'); return 2; }
  const bin = appBinary(argv[0]);
  if (!fs.existsSync(bin)) { stderr(`self-test: no app at ${bin}`); return 2; }
  const signedMac = env.NQA_SELF_TEST_SIGNED === 'true' && /\.app[\\/]*$/.test(argv[0]);
  if (signedMac) stdout('self-test: a signed build (NQA_SELF_TEST_SIGNED): the app\'s team and every capture check are asked for');
  let worst = 0;
  const dumpsBefore = new Set(crashDumpsIn(crashDir));
  const newDumps = (name) => {
    const fresh = crashDumpsIn(crashDir).filter(f => !dumpsBefore.has(f));
    if (fresh.length) stderr(`self-test (${name}): crash dumps in ${crashDir}: ${fresh.join(', ')}`);
    for (const f of fresh) dumpsBefore.add(f);
  };
  for (const { run: name, args } of RUNS) {
    const t0 = Date.now();
    // The full run (SR-05): LOADER_VARIABLE names a tripwire, which the app must remove before any module
    // loads; CA_VARIABLE names a CA file beside it, one of Node's own roots, which must never reach Node.
    const wire = name === 'full' ? tripwire() : null;
    let r;
    let wireRan = false;
    try {
      let startEnv = {};
      if (wire) {
        const ca = path.join(path.dirname(wire.file), 'ca.pem');
        fs.writeFileSync(ca, tls.rootCertificates[0]);
        startEnv = { env: { ...env, [LOADER_VARIABLE]: wire.file, [CA_VARIABLE]: ca } };
      }
      r = spawn(bin, [...args], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20, ...startEnv });
    } finally {
      wireRan = wire?.ran() ?? false;
      wire?.remove();
    }
    const wallMs = Date.now() - t0;
    const out = resultLine(r.stdout);
    if (!out) {
      stderr(`self-test (${name}): no result line (exit ${r.status}${r.signal ? `, ${r.signal}` : ''}${r.error ? `, ${r.error.code ?? r.error.message}` : ''})`);
      const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-15).join('\n');
      if (tail) stderr(tail);
      newDumps(name);
      return 2;
    }
    const failed = falseChecks(out.checks);
    stdout(`self-test (${name}): ok=${out.ok} api=${out.api} packaged=${out.packaged} elapsedMs=${out.elapsedMs} wallMs=${wallMs} electron=${out.versions?.electron ?? '?'}`);
    if (out.checks?.bridge) stdout(`self-test (${name}): bridge ${JSON.stringify(out.checks.bridge)}`);
    if (out.checks?.captureHelper) stdout(`self-test (${name}): capture helper ${JSON.stringify(out.checks.captureHelper)}`);
    if (out.checks?.capturePeer) stdout(`self-test (${name}): capture peer check ${JSON.stringify(out.checks.capturePeer)}`);
    if (out.error) stderr(`self-test (${name}): error ${out.error}`);
    const lines = quitLines(r.stdout);
    const quit = out.ok === true ? quitProblems(lines, { relaunch: name === 'relaunch' }) : [];
    if (out.ok === true) stdout(`self-test (${name}): quit ${quit.length ? 'NOT ok' : 'ok'}: ${lines.join(' · ') || 'no lines'} (exit ${r.status})`);
    const signed = signedMac && name === 'full' ? signedProblems(out.checks) : [];
    const startEnv = wire ? startEnvProblems(out.checks, { ran: wireRan }) : [];
    if (wire && !startEnv.length) {
      stdout(`self-test (${name}): ${LOADER_VARIABLE} named a file; the app removed the variable before any module loaded, its key store's binding loaded, and the file never ran`);
      stdout(`self-test (${name}): ${CA_VARIABLE} named a CA file; it was gone before the app's code ran, and Node added no certificate from it (Electron's NODE_OPTIONS fuse)`);
    }
    const ok = out.ok === true && out.run === name && r.status === 0 && quit.length === 0 && signed.length === 0 && startEnv.length === 0;
    if (!ok) {
      // Every false value (some are false by design: nodeIntegration, spellcheck, webviewTag), and what the quit lacked.
      if (Array.isArray(out.failed) && out.failed.length) stderr(`self-test (${name}): failed: ${out.failed.join(', ')}`);
      for (const f of failed) stderr(`self-test (${name}): false: ${f}`);
      if (out.run !== name) stderr(`self-test (${name}): the app ran ${out.run ?? 'an older self-test'}`);
      for (const q of quit) stderr(`self-test (${name}): quit: ${q}`);
      for (const q of signed) stderr(`self-test (${name}): signed build: ${q}`);
      for (const q of startEnv) stderr(`self-test (${name}): environment: ${q}`);
      worst = 1;
    }
    newDumps(name);
  }
  return worst;
}

// ---------------------------------------------------------------------------
// The refusal starts. Each passes --self-test and --use-mock-keychain, so a build that didn't refuse
// would run in the self-test's sandbox, never on the player's data or keychain.

/**
 * What a refusal start lacked; [] when it refused as it must: it exited 1 by itself, said its
 * self-test line ({ok: false, error, [key]: value}), wrote its line to stderr, and ran no check and
 * no quit (either means it got as far as `past`).
 */
function refusalProblems({ code, signal = null, stdout = '', stderr = '', timedOut = false }, { error, key, value, line, past }) {
  const p = [];
  if (timedOut) p.push('it didn\'t exit');
  if (code !== 1) p.push(`exit ${code}${signal ? ` (${signal})` : ''}, not 1`);
  const said = resultLine(stdout);
  if (!said) p.push('no self-test line');
  else if (said.ok !== false || said.error !== error || said[key] !== value) p.push(`its self-test line: ${JSON.stringify(said).slice(0, 160)}`);
  if (said && (said.checks || said.run)) p.push(`it ran the self-test, so ${past}`);
  if (quitLines(stdout).length) p.push(`it quit through the quit flow, so ${past}`);
  if (!String(stderr).includes(line)) p.push('no refusal line on stderr');
  return p;
}

/** The app's own refusal line in its stderr (its words, for the log), or ''. */
export function refusalLine(stderr) {
  return String(stderr ?? '').split(/\r?\n/).find(l => l.includes('won’t start')) ?? '';
}

/**
 * A start the app must refuse, through spawnSync (it waits for the exit, and stops a start that
 * outlives timeoutMs). → { failed: why it couldn't be started, or null; res: what refusalProblems
 * reads; wallMs }.
 */
function refusedStart(bin, args, { spawn, timeoutMs, env = null }) {
  const t0 = Date.now();
  let r;
  try { r = spawn(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20, ...(env ? { env } : {}) }); } catch (e) { r = { status: null, error: e }; }
  const timedOut = r?.error?.code === 'ETIMEDOUT';
  return {
    failed: r?.error && !timedOut ? `it didn't start (${r.error.code ?? r.error.message})` : null,
    res: { code: r?.status ?? null, signal: r?.signal ?? null, stdout: r?.stdout ?? '', stderr: r?.stderr ?? '', timedOut },
    wallMs: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Code health AP-04: Chromium's debugging switches. The packaged app takes them off its command line
// and exits 1 before 'ready' (src/launch-guard.mjs, src/net-guard.mjs launchSwitches). This start
// proves it on the build itself: --remote-debugging-port at a free port, and a build that didn't
// refuse would be caught answering on that port.

/** The switch the check starts the app with (one of src/net-guard.mjs DEBUG_SWITCHES). */
export const DEBUG_SWITCH = 'remote-debugging-port';

/** A port nothing listens on right now, on 127.0.0.1. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

/** Whether anything accepts a connection on 127.0.0.1:port. */
export function listening(port, { ms = 500 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(ms, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** What a refusal start lacked; [] when it refused as it must. */
export function debugSwitchProblems({ code, signal = null, stdout = '', stderr = '', listened = false, timedOut = false }) {
  const p = refusalProblems({ code, signal, stdout, stderr, timedOut }, { error: 'debug_switch', key: 'switch', value: DEBUG_SWITCH, line: `won’t start with --${DEBUG_SWITCH}.`, past: 'it got past ready' });
  if (listened) p.push('something answered on the debugging port');
  return p;
}

/**
 * Start the app with the switch and knock on the port every everyMs until it has gone, then once more.
 * → { ok, problems, port, code, wallMs }.
 */
export async function debugSwitchRefused(target, { spawn = nodeSpawn, isListening = listening, port = null, timeoutMs = 30_000, everyMs = 25 } = {}) {
  const bin = appBinary(target);
  const p = port ?? await freePort();
  const t0 = Date.now();
  let child;
  try { child = spawn(bin, [`--${DEBUG_SWITCH}=${p}`, '--self-test', '--use-mock-keychain'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) {
    return { ok: false, problems: [`it didn't start (${e?.code ?? e?.message ?? e})`], port: p, code: null, wallMs: Date.now() - t0 };
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding?.('utf8');
  child.stderr?.setEncoding?.('utf8');
  child.stdout?.on('data', d => { stdout += d; });
  child.stderr?.on('data', d => { stderr += d; });
  let gone = false;
  const exited = new Promise(resolve => {
    child.once('error', e => { gone = true; resolve({ code: null, signal: null, error: e }); });
    child.once('exit', (code, signal) => { gone = true; resolve({ code, signal }); });
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  let listened = false;
  const knocking = (async () => {
    while (!gone) {
      if (await isListening(p)) listened = true;
      if (!gone) await new Promise(r => setTimeout(r, everyMs));
    }
  })();
  let timer = null;
  const timedOut = await Promise.race([exited.then(() => false), new Promise(r => { timer = setTimeout(() => r(true), timeoutMs); })]);
  clearTimeout(timer);
  if (timedOut) { try { child.kill(); } catch {} }
  const end = await exited;
  // Its last lines: the pipes close after the exit (a helper process may hold them a moment).
  await Promise.race([closed, new Promise(r => setTimeout(r, 2000))]);
  await knocking;
  if (await isListening(p)) listened = true;
  const problems = debugSwitchProblems({ code: end.code, signal: end.signal, stdout, stderr, listened, timedOut });
  if (end.error) problems.unshift(`it didn't start (${end.error.code ?? end.error.message})`);
  return { ok: problems.length === 0, problems, port: p, code: end.code, wallMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// SR-05: a switch none of the app's launchers pass. The packaged app refuses it before 'ready' as it
// does AP-04's (src/launch-guard.mjs, src/net-guard.mjs launchSwitches). The switch is --gpu-launcher,
// the earliest of the four that run a program as a child process starts, naming a tripwire (this Node
// running a file that records it ran), so a build that let Chromium start its GPU process is caught.

/** The switch the check starts the app with (one of src/net-guard.mjs LAUNCH_SWITCHES). */
export const LAUNCH_SWITCH = 'gpu-launcher';

/** What the --gpu-launcher start lacked; [] when it refused as it must. */
export function launchSwitchProblems({ code, signal = null, stdout = '', stderr = '', timedOut = false, ran = false }) {
  const p = refusalProblems({ code, signal, stdout, stderr, timedOut }, { error: 'launch_switch', key: 'switch', value: LAUNCH_SWITCH, line: `won’t start with --${LAUNCH_SWITCH}.`, past: 'it got past ready' });
  if (ran) p.push('its GPU launcher ran');
  return p;
}

/**
 * Start the app with --gpu-launcher=<this Node> <a tripwire>. Chromium splits a launcher at its
 * spaces, so where either path has one the launcher is a name that runs nothing, and only the
 * refusal is checked (watched: false). → { ok, problems, watched, code, wallMs, line }.
 */
export function launchSwitchRefused(target, { spawn = spawnSync, timeoutMs = 30_000, execPath = process.execPath, tmp = os.tmpdir() } = {}) {
  const wire = tripwire(tmp);
  const watched = !/\s/.test(execPath) && !/\s/.test(wire.file);
  const launcher = watched ? `${execPath} ${wire.file}` : 'nqa-self-test-no-launcher';
  let s;
  let ran = false;
  try {
    s = refusedStart(appBinary(target), [`--${LAUNCH_SWITCH}=${launcher}`, '--self-test', '--use-mock-keychain'], { spawn, timeoutMs });
    ran = wire.ran();
  } finally { wire.remove(); }
  const problems = s.failed ? [s.failed] : launchSwitchProblems({ ...s.res, ran });
  return { ok: problems.length === 0, problems, watched, code: s.res.code, wallMs: s.wallMs, line: refusalLine(s.res.stderr) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let code = run(argv);
  // AP-04 and SR-05 wherever this runs on a build (test.yml's windows-smoke, release.yml's Mac and Windows builds): no flag needed.
  if (code !== 2) {
    const d = await debugSwitchRefused(argv[0]);
    if (d.ok) process.stdout.write(`self-test (debug-switch): --${DEBUG_SWITCH}=${d.port} refused before ready (exit 1 in ${d.wallMs} ms); nothing answered on the port\n`);
    else {
      for (const p of d.problems) process.stderr.write(`self-test (debug-switch): ${p}\n`);
      code = Math.max(code, 1);
    }
    const l = launchSwitchRefused(argv[0]);
    if (l.ok) process.stdout.write(`self-test (launch-switch): --${LAUNCH_SWITCH} refused before ready (exit 1 in ${l.wallMs} ms); ${l.watched ? 'its launcher never ran' : 'its launcher not watched (a path with a space)'}. The app said: ${l.line}\n`);
    else {
      for (const p of l.problems) process.stderr.write(`self-test (launch-switch): ${p}\n`);
      code = Math.max(code, 1);
    }
  }
  process.exitCode = code;
}
