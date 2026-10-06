// Windows smoke tests on a real Windows machine (systems plan Batch 1 and section 4, "What CI can
// prove, with no PC"; SY-01, SY-07, SY-08). test.yml's windows-smoke job runs this on
// windows-latest against the release build of nqa-capture.exe (zig, the same bytes the release
// ships). Everywhere else every test skips.
//
//   - the real helper runs (its DLL imports load), reports 0.2.0 / protocol 2, and decodes strips
//     the addon's own Codec.lua drew; it reads the input desktop as its lock rule does (DR-26) and
//     says it isn't locked right after it starts;
//   - it speaks over stdout to the real bridge code (createWindowsCapture), and exits by itself when
//     the bridge quits (stdin ends) or crashes (the process holding its pipes dies);
//   - which window is the game's, on this desktop (display DR-05, the audit's D-03): a stand-in
//     window program (helpers/stripwin.c, built here with the runner's MinGW-w64 gcc) runs as
//     "Programs\WowUp\WowUp.exe" and as "World of Warcraft\_forever_\Wow.exe", each showing a strip;
//     the helper, configured as boot configures it, never takes WowUp for the game and reads the
//     game's strip through Desktop Duplication. A runner whose display can't be duplicated skips the
//     read, with the helper's typed error as the reason;
//   - the capture watchdog on that real helper and screen (display DR-25, SY-09): a window over the strip's
//     corner (topmost, click-through, non-activating, the shape of Discord's overlay) gives frames and no
//     decode and publishes nothing; the game's SavedVariables write after it (the player's Reload) is
//     R4' (one restart of the real helper, no_signal); the cover gone, the strip is read and ok is
//     published (tests/byok/helpers/covered-corner.mjs, the same steps tests/capture_loop_test.mjs runs
//     with a stand-in helper on every OS);
//   - NTFS: real sharing violations (a file held open with no sharing by another process) on rename
//     over, delete and create, ridden out by bridge/transport/fsretry.mjs;
//   - Credential Manager through the pinned @napi-rs/keyring, under the names the uninstaller deletes;
//   - the app's folders under %APPDATA% and %LOCALAPPDATA%.
//
// NQA_CAPTURE_EXE names another helper; NQA_REQUIRE_HELPER=1 fails (not skips) without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { REPO, encodeWithCodec, renderRgb, ppm } from './helpers/strip-fixtures.mjs';
import { createWindowsCapture, createCaptureForPlatform } from '../../bridge/transport/capture.mjs';
import { coveredCornerScenario } from './helpers/covered-corner.mjs';
import { FOREVER_FLAVORS, NOT_GAME } from '../../bridge/byok/wow.mjs';
import { createRetrier, RETRY_CODES, renameWithRetry, unlinkWithRetry, writeFileWithRetry } from '../../bridge/transport/fsretry.mjs';

const WIN = process.platform === 'win32';
const EXE = process.env.NQA_CAPTURE_EXE || path.join(REPO, 'bridge', 'capture', 'windows', 'build', 'nqa-capture.exe');
const HAVE_EXE = fs.existsSync(EXE);
const onlyWin = WIN ? false : 'Windows only';
const needExe = !WIN ? 'Windows only' : (HAVE_EXE || process.env.NQA_REQUIRE_HELPER === '1') ? false : `no helper at ${EXE} (bridge/capture/windows/build.sh)`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcap-winsmoke-'));
const holders = new Set(); // lock holders still running (holdLock), ended before their folder goes
test.after(() => { for (const c of holders) endHolder(c); fs.rmSync(TMP, { recursive: true, force: true }); });

const US = '\x1F';
const record = (i, body) => ['a1b2c3d4', 'c3f9a1', String(i), '', '', 'Hyjal route', body].join(US);
const POWERSHELL = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const until = async (cond, ms, what = 'a condition') => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise(r => setTimeout(r, 20));
  }
};

/**
 * First stdout line of a child that matches re (resolves with the line). However the wait ends (the
 * line, the child's exit or error, or ms passing) its timer is cleared and its listeners go.
 */
function lineFrom(child, re, ms = 20000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let timer = null;
    const end = (error, line) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error); else resolve(line);
    };
    const onData = (d) => {
      buf += String(d);
      const hit = buf.split(/\r?\n/).find(l => re.test(l));
      if (hit) end(null, hit);
    };
    const onExit = code => end(new Error(`exited (${code}) before a line matching ${re}; got: ${buf.slice(-400)}`));
    const onError = e => end(new Error(`${e?.code || e?.message || e} before a line matching ${re}`));
    timer = setTimeout(() => end(new Error(`no line matching ${re} within ${ms} ms; got: ${buf.slice(-400)}`)), ms);
    child.stdout.on('data', onData);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ---------------------------------------------------------------- the helper itself

test('the release helper runs here: --version says 0.2.0, protocol 2; the pipe flags are refused', { skip: needExe }, () => {
  const v = spawnSync(EXE, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(v.status, 0, `exit ${v.status} ${v.error?.message ?? ''} ${v.stderr}`);
  assert.match(v.stdout, /^nqa-capture 0\.2\.0 \(protocol 2\)/);
  const old = spawnSync(EXE, ['--pipe', '\\\\.\\pipe\\x', '--token', '-'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(old.status, 2);
  assert.match(old.stderr, /gone: the helper writes to stdout/);
});

test('DR-26: the helper reads which desktop has the input as the lock rule does: this runner\'s, unlocked, is "Default"', { skip: needExe }, () => {
  const r = spawnSync(EXE, ['--test-desktop'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { inputDesktop: 'Default', verdict: 'default' });
});

test('DR-26: the helper says it isn\'t locked, on its own line, right after it starts', { skip: needExe }, async () => {
  const c = spawn(EXE, ['--process-name', 'nqa-ci-no-such-game'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  try {
    // Both lines may come in one read: one reader for both.
    const got = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`no away line within 20 s; got: ${buf.slice(-400)}`)), 20000);
      c.stdout.on('data', (d) => {
        buf += String(d);
        const lines = buf.split(/\r?\n/);
        const start = lines.findIndex(l => /nqa-capture 0\.2\.0 started/.test(l));
        const away = lines.findIndex(l => /"away"/.test(l));
        if (start >= 0 && away >= 0) { clearTimeout(timer); resolve({ start, away, line: lines[away] }); }
      });
    });
    assert.ok(got.away > got.start, 'after the start line');
    assert.equal(got.line, '{"away":null}');
  } finally {
    c.stdin.end();
  }
});

test('--test-image decodes strips the addon\'s Codec.lua drew (4, 5 and 6.5 px), and says so when there is none', { skip: needExe }, () => {
  const text = record(41, 'fastest way to Hyjal from here? ✓ Mulgore → Hyjal');
  for (const pitch of [4, 5, 6.5]) {
    const file = path.join(TMP, `strip-${pitch}.ppm`);
    fs.writeFileSync(file, ppm(renderRgb(encodeWithCodec('NeverQuestAlone', 41, text), { pitch, width: 1400, height: 400 })));
    const r = spawnSync(EXE, ['--test-image', file], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.id, 41, JSON.stringify(out));
    assert.equal(out.text, text);
    assert.ok(Math.abs(out.geometry.pitch - pitch) < 0.05, `pitch ${out.geometry.pitch} vs ${pitch}`);
  }
  const empty = path.join(TMP, 'empty.ppm');
  fs.writeFileSync(empty, ppm(renderRgb([], { pitch: 4, busyBackground: true })));
  const none = JSON.parse(spawnSync(EXE, ['--test-image', empty], { encoding: 'utf8', windowsHide: true }).stdout.trim());
  assert.equal(none.error, 'no valid strip in image');
});

test('over stdout to the real bridge code: the start line and a typed error arrive, and with no game nothing more (SY-30); stop() ends it', { skip: needExe }, async () => {
  const lines = [];
  const errors = [];
  const games = [];
  let child = null;
  const cap = createWindowsCapture({
    exe: EXE, processNames: ['nqa-ci-no-such-game'], statsSec: 1,
    log: (tag, d) => lines.push([tag, d]), onError: e => errors.push(e), onGame: g => games.push(g),
    spawnImpl: (cmd, args, opts) => (child = spawn(cmd, args, opts)),
  });
  cap.start();
  await until(() => errors.some(e => e.kind === 'window_not_found'), 20000, 'window_not_found');
  assert.ok(lines.some(([tag, d]) => tag === 'capture-info' && /^nqa-capture 0\.2\.0 started$/.test(d.info) && d.process === 'nqa-ci-no-such-game.exe'), JSON.stringify(lines.slice(0, 5)));
  assert.deepEqual(games[0], { state: 'absent', pid: null });
  assert.equal(cap.status().connected, true);
  assert.equal(cap.status().error.kind, 'window_not_found');
  // No idle work while the game is closed (SY-30): no stats line (every second here while a game
  // window is found; the end-to-end test below waits for one) and the error isn't said again (it
  // was every minute), so nothing wakes the bridge; the helper only looks for the window, every 2 s.
  const heard = lines.length;
  await new Promise(r => setTimeout(r, 4500));
  assert.equal(cap.status().stats, null, 'no stats line with no game');
  assert.equal(errors.filter(e => e.kind === 'window_not_found').length, 1, 'said once');
  assert.deepEqual(lines.slice(heard), [], 'nothing at all from the helper meanwhile');
  const exited = new Promise(r => child.once('exit', r));
  cap.stop();
  await exited;
  assert.equal(alive(child.pid), false);
});

test('the helper exits by itself when stdin ends (the bridge quit)', { skip: needExe }, async () => {
  const c = spawn(EXE, ['--process-name', 'nqa-ci-no-such-game'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  await lineFrom(c, /nqa-capture 0\.2\.0 started/);
  const t0 = Date.now();
  const exited = new Promise(r => c.once('exit', (code) => r(code)));
  c.stdin.end();
  assert.equal(await exited, 0);
  // At once, not at the next look for the game's window (SY-30: a thread reads stdin, and the wait
  // for a window ends with it).
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test('the helper exits by itself when the process holding its pipes dies (the bridge crashed)', { skip: needExe }, async () => {
  // A stand-in bridge: spawns the helper the way createWindowsCapture does, prints its pid, waits.
  const bridge = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const h = spawn(process.argv[1], ['--process-name', 'nqa-ci-no-such-game'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    h.stdout.once('data', () => process.stdout.write('helper ' + h.pid + '\\n'));
    setInterval(() => {}, 1000);
  `, EXE], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const line = await lineFrom(bridge, /^helper \d+$/);
  const helperPid = Number(line.split(' ')[1]);
  assert.ok(alive(helperPid));
  bridge.kill(); // TerminateProcess: no clean-up runs in the stand-in
  await until(() => !alive(helperPid), 8000, 'the orphaned helper to exit');
});

// ---------------------------------------------------------------- which window is the game's (DR-05)

/** The stand-ins' sources in helpers/, each named whole so the source export takes it (tools/shell-tree.mjs). */
const STAND_INS = Object.freeze({ stripwin: 'stripwin.c', coverwin: 'coverwin.c' });
/** helpers/<name>.c (stripwin: a stand-in game window showing a PPM; coverwin: a window over its corner), built with the runner's MinGW-w64 gcc (CC). */
function buildStandIn(t, name = 'stripwin') {
  const cc = process.env.CC || 'gcc';
  const exe = path.join(TMP, `${name}.exe`);
  if (fs.existsSync(exe)) return exe;
  const r = spawnSync(cc, ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-mwindows', '-o', exe,
    path.join(REPO, 'tests', 'byok', 'helpers', STAND_INS[name]), '-lgdi32'], { encoding: 'utf8', windowsHide: true });
  if (r.status === 0) return exe;
  const why = `the stand-in window (${name}) didn't build with ${cc}: ${r.error?.message ?? ''} ${r.stderr ?? ''}`.trim();
  if (process.env.NQA_REQUIRE_HELPER === '1') assert.fail(why);
  t.skip(why);
  return null;
}

/** The stand-in copied to file, showing image at x, y, w x h for 90 s; resolves with the child once it's up. */
async function standIn(built, file, image, [x, y, w, h]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(built, file);
  const c = spawn(file, [String(x), String(y), String(w), String(h), image, '90'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await lineFrom(c, /^shown \d+/, 30000);
  return c;
}

test('DR-05, D-03: WowUp.exe is never the game, even open first and larger; the helper takes _forever_\\Wow.exe beside it, says its DPI awareness, and reads its strip', { skip: needExe }, async (t) => {
  const built = buildStandIn(t);
  if (!built) return;
  const gameText = record(7, 'hello from the game window');
  const upText = record(8, 'the addon manager\'s window');
  const gameImage = path.join(TMP, 'game.ppm');
  const upImage = path.join(TMP, 'wowup.ppm');
  fs.writeFileSync(gameImage, ppm(renderRgb(encodeWithCodec('NeverQuestAlone', 7, gameText), { pitch: 4, width: 900, height: 300 })));
  fs.writeFileSync(upImage, ppm(renderRgb(encodeWithCodec('NeverQuestAlone', 8, upText), { pitch: 4, width: 900, height: 300 })));
  // The WoW folder exists before the app starts (boot passes only an existing one as --exe-dir); on
  // this runner it's under %TEMP%, which is in 8.3 short names (RUNNER~1), as the helper must handle.
  const gameDir = path.join(TMP, 'World of Warcraft', '_forever_');
  fs.mkdirSync(gameDir, { recursive: true });
  const upExe = path.join(TMP, 'AppData', 'Local', 'Programs', 'WowUp', 'WowUp.exe');
  const payloads = [], errors = [], games = [], lines = [];
  let cap = null, up = null, game = null;
  try {
    // WowUp first and larger, as a player has it: update the addons, then click Play.
    up = await standIn(built, upExe, upImage, [8, 390, 1000, 370]);
    cap = createWindowsCapture({
      exe: EXE, statsSec: 2, flavorDirs: FOREVER_FLAVORS, notGame: NOT_GAME, exeDir: gameDir,
      onPayload: p => payloads.push(p), onError: e => errors.push(e), onGame: g => games.push(g), log: (tag, d) => lines.push([tag, d]),
    });
    cap.start();
    await until(() => errors.some(e => e.kind === 'window_not_found'), 20000, 'window_not_found while only WowUp is open');
    assert.match(errors.find(e => e.kind === 'window_not_found').message, /looking for Wow\*\.exe in a _forever_ or _classic_beta_ folder/);
    game = await standIn(built, path.join(gameDir, 'Wow.exe'), gameImage, [16, 16, 960, 360]);
    await until(() => games.some(g => g.pid === game.pid), 20000, 'the game found');
    const attached = lines.find(([tag, d]) => tag === 'capture-info' && d.window && d.window.pid === game.pid);
    assert.ok(attached, JSON.stringify(lines.filter(([tag]) => tag === 'capture-info').slice(0, 6)));
    t.diagnostic(`the window line: ${JSON.stringify(attached[1])}; the WoW folder: ${gameDir}`);
    assert.equal(attached[1].window.image, 'Wow.exe');
    assert.equal(attached[1].window.underExeDir, true, 'in the WoW folder the bridge serves');
    assert.equal(attached[1].window.dpiAwareness, 'system', 'the stand-in is System DPI aware (SetProcessDPIAware)');
    // The read, through Desktop Duplication: the game's strip, never WowUp's.
    const t0 = Date.now();
    while (!payloads.length && Date.now() - t0 < 25000) {
      const fatal = errors.find(e => ['capture_unsupported', 'access_lost', 'capture_blocked_by_app'].includes(e.kind));
      if (fatal && Date.now() - t0 > 8000) break;
      await new Promise(r => setTimeout(r, 100));
    }
    t.diagnostic(`helper said: ${JSON.stringify(lines.filter(([tag]) => /^capture-(info|warn|error)$/.test(tag)).map(([, d]) => d.info ?? d.warn ?? d.error).slice(0, 12))}`);
    t.diagnostic(`stats: ${JSON.stringify(cap.status().stats ?? null)}`);
    assert.ok(!games.some(g => g.pid === up.pid), 'WowUp is never the game');
    assert.ok(!payloads.some(p => p.id === 8), 'WowUp\'s strip is never read');
    if (!payloads.length) {
      const why = errors.filter(e => e.kind !== 'window_not_found').at(-1);
      t.skip(`the game was found, but nothing decoded on this runner's display${why ? `: ${why.kind} (${why.message})` : ''}`);
      return;
    }
    assert.equal(payloads[0].id, 7);
    assert.equal(payloads[0].text, gameText);
    // While a game window is found the helper says its numbers every --stats-sec (SY-30 keeps them
    // for then only).
    await until(() => cap.status().stats, 5000, 'a stats line while the window is found');
    assert.ok(cap.status().stats.decoded >= 1, JSON.stringify(cap.status().stats));
  } finally {
    cap?.stop();
    for (const c of [game, up]) { try { c?.kill(); } catch { /* gone */ } }
  }
});

test('a game window shown after the helper started is found at once: a shown-window event wakes it, no look every second (SY-30)', { skip: needExe }, async (t) => {
  const built = buildStandIn(t);
  if (!built) return;
  const text = record(9, 'hello from a window shown later');
  const image = path.join(TMP, 'later.ppm');
  fs.writeFileSync(image, ppm(renderRgb(encodeWithCodec('NeverQuestAlone', 9, text), { pitch: 4, width: 900, height: 300 })));
  // The WoW folder exists before the helper starts (boot passes only an existing one as --exe-dir).
  const gameDir = path.join(TMP, 'WoW shown later', '_forever_');
  fs.mkdirSync(gameDir, { recursive: true });
  const payloads = [], errors = [], games = [], lines = [];
  let cap = null, win = null;
  try {
    cap = createWindowsCapture({
      exe: EXE, statsSec: 2, flavorDirs: FOREVER_FLAVORS, notGame: NOT_GAME, exeDir: gameDir,
      onPayload: p => payloads.push(p), onError: e => errors.push(e), onGame: g => games.push(g), log: (tag, d) => lines.push([tag, d]),
    });
    cap.start();
    await until(() => games.length > 0, 10000, 'the helper\'s first look (no game)');
    assert.deepEqual(games[0], { state: 'absent', pid: null });
    // Long enough for a helper that polled every second or two to have looked again; this one sleeps.
    await new Promise(r => setTimeout(r, 3000));
    win = await standIn(built, path.join(gameDir, 'Wow.exe'), image, [16, 16, 960, 360]);
    const shownAt = Date.now();
    // Found within seconds of being shown: the event, not the 30 s look that backs it up.
    await until(() => games.some(g => g.state === 'launched' && g.pid === win.pid), 10000, 'the window found after it was shown');
    const tookMs = Date.now() - shownAt;
    t.diagnostic(`found ${tookMs} ms after the window was shown`);
    assert.ok(tookMs < 10000);
    assert.ok(lines.some(([tag, d]) => tag === 'capture-info' && d.window && d.window.pid === win.pid), 'attached to the window shown later');
    const t0 = Date.now();
    while (!payloads.length && Date.now() - t0 < 20000) {
      const fatal = errors.find(e => ['capture_unsupported', 'access_lost', 'capture_blocked_by_app'].includes(e.kind));
      if (fatal && Date.now() - t0 > 8000) break;
      await new Promise(r => setTimeout(r, 100));
    }
    if (!payloads.length) {
      const why = errors.filter(e => e.kind !== 'window_not_found').at(-1);
      t.skip(`found, but nothing decoded on this runner's display${why ? `: ${why.kind} (${why.message})` : ''}`);
      return;
    }
    assert.equal(payloads[0].id, 9);
    assert.equal(payloads[0].text, text);
  } finally {
    cap?.stop();
    try { win?.kill(); } catch { /* gone */ }
  }
});

// ---------------------------------------------------------------- the watchdog on a real helper (DR-25)

/**
 * The scenario's scene on this machine: the stand-in game window (stripwin) showing the strip as a PPM it
 * looks at again four times a second, a cover over its corner (coverwin) that comes and goes, and the real
 * helper (through boot's createCapture, statsSec 2, a relaunch after 0.5 s).
 */
function realScene(built) {
  const kids = [];
  let cover = null;
  let imageFile = null;
  const draw = (id, text) => {
    const tmp = `${imageFile}.tmp`;
    fs.writeFileSync(tmp, ppm(renderRgb(encodeWithCodec('NeverQuestAlone', id, text), { pitch: 4, width: 900, height: 300 })));
    renameWithRetry(createRetrier(), tmp, imageFile);
  };
  return {
    async start({ flavorDir, root, text }) {
      imageFile = path.join(root, 'strip.ppm');
      fs.writeFileSync(imageFile, ppm(renderRgb(encodeWithCodec('NeverQuestAlone', 51, text), { pitch: 4, width: 900, height: 300 })));
      kids.push(await standIn(built.strip, path.join(flavorDir, 'Wow.exe'), imageFile, [16, 16, 960, 360]));
    },
    async cover() {
      // Over the strip's top-left, after the game's window (a topmost window made later is in front of it).
      cover = spawn(built.cover, ['16', '16', '520', '340', '120'], { stdio: ['ignore', 'pipe', 'pipe'] });
      kids.push(cover);
      await lineFrom(cover, /^shown \d+/, 30000);
    },
    async uncover() {
      const gone = new Promise(r => (cover.exitCode === null ? cover.once('exit', r) : r()));
      cover.kill();
      await gone;
    },
    async showStrip(text) { draw(52, text); },
    makeCapture: o => createCaptureForPlatform({ ...o, windows: { ...o.windows, exe: EXE, relaunchMs: 500 } }),
    async stop() { for (const c of kids) { try { c.kill(); } catch { /* gone */ } } },
  };
}

test('DR-25, SY-09: on the real helper and a real screen, a covered corner reads nothing and publishes nothing; the Reload after it is R4\' (one restart of the helper, no_signal); the cover gone, the strip is read and ok is published', { skip: needExe }, async (t) => {
  const strip = buildStandIn(t, 'stripwin');
  const cover = strip && buildStandIn(t, 'coverwin');
  if (!strip || !cover) return;
  const r = await coveredCornerScenario(t, realScene({ strip, cover }));
  if (r?.skipped) t.skip(r.skipped);
});

// ---------------------------------------------------------------- NTFS sharing violations

// Holds $env:LOCK_PATH open with the given sharing ('None', or 'Delete' so it can be deleted but
// stays "delete pending"), says "locked", and lets go once $env:RELEASE_PATH exists, writing
// $env:CLOSED_PATH once it has.
const LOCK_HOLDER = `
$ErrorActionPreference = 'Stop'
$f = [System.IO.File]::Open($env:LOCK_PATH, 'OpenOrCreate', 'ReadWrite', $env:LOCK_SHARE)
[Console]::Out.WriteLine('locked'); [Console]::Out.Flush()
while (-not (Test-Path -LiteralPath $env:RELEASE_PATH)) { Start-Sleep -Milliseconds 5 }
$f.Close()
[System.IO.File]::WriteAllText($env:CLOSED_PATH, '')
[Console]::Out.WriteLine('released'); [Console]::Out.Flush()
`;

/** Blocks this thread until file exists (or ms pass): the retrier's onRetry is synchronous. */
function waitForFileSync(file, ms) {
  const end = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < end) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

// A lock holder has LOCK_WAIT_MS to say "locked". One that hasn't (a stalled runner: run 37138262262's
// first PowerShell said nothing for 30 s) is ended with every process under it, and its test fails
// then. Left running, it held the test file's process open (its pipes, its handle) and windows-smoke
// hung until the job's 45-minute limit. A holder a failed test leaves locked is ended after the file.
const LOCK_WAIT_MS = 30000;

/** Ends a lock holder and its process tree (taskkill /T /F), and lets go of its pipes and handle. */
function endHolder(c) {
  holders.delete(c);
  if (c.pid && c.exitCode === null && c.signalCode === null) {
    spawnSync(path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(c.pid), '/T', '/F'],
      { windowsHide: true, timeout: 10000 });
    try { c.kill(); } catch { /* gone */ }
  }
  c.stdout?.destroy();
  c.stderr?.destroy();
  c.unref();
}

async function holdLock(file, share = 'None') {
  const script = path.join(TMP, 'lock-holder.ps1');
  fs.writeFileSync(script, LOCK_HOLDER);
  const release = `${file}.release`;
  const closed = `${file}.closed`;
  fs.rmSync(release, { force: true });
  fs.rmSync(closed, { force: true });
  const c = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, LOCK_PATH: file, LOCK_SHARE: share, RELEASE_PATH: release, CLOSED_PATH: closed } });
  holders.add(c);
  c.once('exit', () => holders.delete(c));
  const done = lineFrom(c, /^released$/, 60000).catch(() => null);
  let locked = false;
  try {
    await lineFrom(c, /^locked$/, LOCK_WAIT_MS); // its timer is cleared however the wait ends
    locked = true;
  } finally {
    if (!locked) endHolder(c); // the test fails now, with nothing left running
  }
  return {
    // Synchronous, from inside a blocking retry: asks the holder to let go and waits until it has.
    // The retrier's own waits (150 ms in all) are for antivirus and the game, not for how soon a
    // PowerShell on a busy runner gets to its next poll, which is what failed here before.
    release: () => { fs.writeFileSync(release, ''); waitForFileSync(closed, 20000); },
    done: async () => { await done; await new Promise(r => (c.exitCode === null ? c.once('exit', r) : r())); fs.rmSync(release, { force: true }); fs.rmSync(closed, { force: true }); },
  };
}

test('NTFS: a slot renamed over a file another process holds with no sharing: fails once, recovers through the retrier', { skip: onlyWin }, async () => {
  const slot = path.join(TMP, 'NQA_Slot001.lua');
  fs.writeFileSync(slot, 'old');
  const tmp = `${slot}.tmp`;
  fs.writeFileSync(tmp, 'new');
  const lock = await holdLock(slot);
  // Without the retrier it really fails, with a code the retrier knows.
  assert.throws(() => fs.renameSync(tmp, slot), e => RETRY_CODES.includes(e.code), 'a real sharing violation');
  // With it: the holder lets go as the first retry starts, and a later try succeeds.
  const r = createRetrier({ onRetry: () => lock.release() });
  renameWithRetry(r, tmp, slot);
  assert.equal(fs.readFileSync(slot, 'utf8'), 'new');
  const s = r.stats();
  assert.ok(s.retries >= 1 && s.retries <= 3, JSON.stringify(s));
  assert.equal(s.recovered, 1);
  await lock.done();
});

test('NTFS: a doorbell deleted while another process holds it: fails once, recovers through the retrier', { skip: onlyWin }, async () => {
  const bell = path.join(TMP, 'bell-1.wav');
  fs.writeFileSync(bell, '');
  const lock = await holdLock(bell);
  assert.throws(() => fs.unlinkSync(bell), e => RETRY_CODES.includes(e.code));
  const r = createRetrier({ onRetry: () => lock.release() });
  unlinkWithRetry(r, bell);
  assert.equal(fs.existsSync(bell), false);
  assert.equal(r.stats().recovered, 1);
  await lock.done();
});

test('NTFS: a doorbell re-created while its old name is still "delete pending": recovers through the retrier', { skip: onlyWin }, async (t) => {
  const bell = path.join(TMP, 'bell-2.wav');
  fs.writeFileSync(bell, '');
  const lock = await holdLock(bell, 'Delete');
  fs.unlinkSync(bell); // allowed (the holder shares delete), but the name lingers until it closes
  let pending = false;
  try { fs.writeFileSync(bell, '', { flag: 'wx' }); } catch (e) { pending = RETRY_CODES.includes(e.code); if (!pending) throw e; }
  if (!pending) {
    // POSIX delete semantics freed the name at once: nothing to retry here.
    t.diagnostic('the name was free at once (POSIX delete semantics)');
    fs.rmSync(bell, { force: true });
    lock.release();
    await lock.done();
    return;
  }
  const r = createRetrier({ onRetry: () => lock.release() });
  writeFileWithRetry(r, bell, '', { flag: 'wx' });
  assert.equal(fs.existsSync(bell), true);
  assert.equal(r.stats().recovered, 1);
  await lock.done();
});

// ---------------------------------------------------------------- Credential Manager and folders

test('Credential Manager: the pinned @napi-rs/keyring saves, reads, lists and deletes a key as "<provider>.<service>"', { skip: onlyWin }, async () => {
  const { createKeyStore } = await import('../../bridge/byok/security/keystore.mjs');
  const { CANARY_KEYS } = await import('./helpers/canary.mjs');
  const service = `NeverQuestAlone CI ${process.pid}`;
  const ks = createKeyStore({ backend: 'os', service });
  assert.deepEqual(await ks.probe(), { ok: true });
  try {
    await ks.set('anthropic', CANARY_KEYS.anthropic);
    assert.equal(await ks.get('anthropic'), CANARY_KEYS.anthropic);
    assert.deepEqual(await ks.list(['anthropic', 'openai']), ['anthropic']);
    // The generic credential's target is what the NSIS uninstaller's CredDeleteW calls name. The
    // whole list: cmdkey can't parse a /list:<target> argument with spaces in it as Node quotes it.
    const listed = spawnSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true });
    assert.match(listed.stdout, new RegExp(`anthropic\\.${service}`), listed.stdout);
    assert.ok(!listed.stdout.includes('CANARY'), 'cmdkey never shows the secret');
  } finally {
    await ks.delete('anthropic');
  }
  assert.equal(await ks.get('anthropic'), null);
  const nsis = fs.readFileSync(path.join(REPO, 'app', 'desktop', 'build', 'installer.nsh'), 'utf8');
  assert.match(nsis, /CredDeleteW\(w "\$\{PROVIDER\}\.NeverQuestAlone"/);
});

test('folders: config and data under %APPDATA%\\NeverQuestAlone (Electron\'s userData too), logs under %LOCALAPPDATA%', { skip: onlyWin }, async () => {
  const { publicPaths } = await import('../../bridge/byok/paths.mjs');
  const p = publicPaths();
  assert.equal(p.config.toLowerCase(), path.win32.join(process.env.APPDATA, 'NeverQuestAlone').toLowerCase());
  assert.equal(p.logs.toLowerCase(), path.win32.join(process.env.LOCALAPPDATA, 'NeverQuestAlone', 'logs').toLowerCase());
  // The same writes the bridge makes, in a scratch folder under %LOCALAPPDATA% (real NTFS, real Defender).
  const dir = fs.mkdtempSync(path.join(process.env.LOCALAPPDATA, 'bones-ci-'));
  try {
    const r = createRetrier();
    for (let i = 0; i < 50; i++) {
      const f = path.join(dir, `slot${i}.lua`);
      writeFileWithRetry(r, `${f}.tmp`, `-- ${i}\n`);
      renameWithRetry(r, `${f}.tmp`, f);
    }
    assert.equal(fs.readdirSync(dir).length, 50);
    const s = r.stats();
    assert.equal(s.failed, 0, JSON.stringify(s));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// icacls lines: the folder's path, then "<principal>:(flags)(rights)" per grant, one to a line.
function icaclsGrants(dir, out) {
  const grants = [];
  for (const raw of String(out).split(/\r?\n/)) {
    let line = raw.trim();
    if (line.toLowerCase().startsWith(dir.toLowerCase())) line = line.slice(dir.length).trim();
    const m = /^(.+?):((?:\([^)]*\))+)$/.exec(line);
    if (m) grants.push({ who: m[1], rights: m[2] });
  }
  return grants;
}

test('folders: %APPDATA%\\NeverQuestAlone, made as the app makes it, is readable only by this account (and SYSTEM and Administrators), as a 0700 folder is on POSIX (SY-23)', { skip: onlyWin }, async () => {
  const { publicPaths } = await import('../../bridge/byok/paths.mjs');
  const dir = publicPaths().data;
  const existed = fs.existsSync(dir);
  // bootByok's own call; mode is a POSIX thing, so on Windows the folder takes its parent's ACL.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const r = spawnSync(path.win32.join(sys, 'System32', 'icacls.exe'), [dir], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, r.stderr);
    const me = spawnSync(path.win32.join(sys, 'System32', 'whoami.exe'), [], { encoding: 'utf8', windowsHide: true }).stdout.trim().toLowerCase();
    assert.match(me, /\\/, `whoami: ${me}`);
    const grants = icaclsGrants(dir, r.stdout);
    assert.ok(grants.length > 0, r.stdout);
    const owner = new Set([me, 'nt authority\\system', 'builtin\\administrators']);
    // CREATOR OWNER, inherit-only, grants nothing on this folder: it names whoever creates a child.
    const others = grants.filter(g => !owner.has(g.who.toLowerCase()) && !(g.who.toUpperCase() === 'CREATOR OWNER' && g.rights.includes('(IO)')));
    assert.deepEqual(others, [], `only the owner, SYSTEM and Administrators may read it:\n${r.stdout}`);
    assert.ok(grants.some(g => g.who.toLowerCase() === me), `this account has its own grant:\n${r.stdout}`);
  } finally {
    if (!existed) fs.rmSync(dir, { recursive: true, force: true });
  }
});
