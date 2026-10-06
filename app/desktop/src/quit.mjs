// The quit lifecycle (fix-102): what main runs when NeverQuestAlone quits, and the log lines that
// say how far a quit got.
//
// Electron's before-quit is a request, not a quit: after it, a window can still stay open or the
// quit can be called off, and the process lives on. Main used to stop the bridge right there (the
// boot's full stop, which uninstalls the egress guard) and then ask to quit again, so a quit that
// didn't finish left the app serving its window on a stopped bridge: every key test was refused
// before it was sent, and setup said "Can't reach Anthropic. Check your internet" to a player
// whose key and internet were fine (2026-09-30, 06:44 to 06:59 UTC). Now nothing stops until the
// quit is committed:
//
//   before-quit  'quit-requested'; nothing stops. A request that isn't committed within stallMs is
//                logged ('quit-stalled') and forgotten: the app runs on, whole.
//   will-quit    Every window has closed, so the quit is committed: preventDefault, 'quit-committed',
//                onCommit() (main takes the tray away and opens no window from here on), the
//                stop, awaited at most stopMs ('quit-stalled' when it runs over), beforeExit() (the
//                uninstall's removal), then exit(0). app.exit emits no second will-quit, and 'quit'
//                still fires with code 0, so an update installs on quit and a relaunch happens.
//   exitMs on    Still running after exit: the quit stays committed and nothing boots again in this
//                process (src/api-loader.mjs createLiveApi: a commit is final). Electron's exit had
//                begun ('quit' fires inside app.exit: its shutdown runs and the single-instance lock
//                is let go), it only ends slowly: 'quit: still ending'. An exit that never began (no
//                'quit'; never seen) is 'quit-stalled' and asked again.
//
// Why (quit-race; CI run 37107199251): on a busy Windows runner, 'quit' fires inside app.exit(0) and
// the process still takes seconds to end (CI's timelines: up to 9 s, the main thread blocked up to
// 2 s right after the exit); in that run its main loop still ran JS 5 s after it. The flow took
// that for an exit that failed: it went back to 'running' and onExitFailed booted the bridge again
// (and brought the tray back) in a process that ended with exit 0 seconds later. A player's PC
// could do the same after Quit, beside a second launch that already holds the lock and runs its
// own bridge; and back at 'running', a launch or a Dock click would open a window in the dying
// process. A relaunch, if one was asked, is the only way back.
//
// A launch while the quit is committed (systems critic SY-102-3): no window can open then, and
// the launch was lost (macOS's activate returned no window; on Windows the new copy quit, since
// the exiting one still held the single-instance lock). The owner reopened 1.8 s after Cmd+Q.
// reopen() asks app.relaunch() once, so the exiting process comes back, and logs 'quit: reopened
// during the quit'. One relaunch per process, whoever asks (Quit and reopen, a launch during the
// quit): Electron starts a copy for every call. Never while an update installs at this quit
// (canRelaunch() false): its installer replaces the app as it exits.
//
// createQuitFlow({ app, stop, log, onCommit, beforeExit, exit?, relaunch?,
//                  canRelaunch?, stopMs?, stallMs?, exitMs?, timers?, now? }) →
//   { state() → 'running' | 'requested' | 'committed', committed(), relaunchOnce() → bool,
//     reopen() → bool (true: the quit took the launch, so open nothing) }

/** The longest the bridge's stop may hold a committed quit. */
export const QUIT_STOP_MS = 3000;
/** How long a requested quit may go without being committed before the log says so. */
export const QUIT_STALL_MS = 10_000;
/** How long after exit(0) a process that's still running says so (and asks again if the exit never began). */
export const QUIT_EXIT_MS = 5000;

const secs = ms => `${Math.round(ms / 100) / 10} s`;

export function createQuitFlow({
  app, stop = async () => {}, log = () => {}, onCommit = () => {}, beforeExit = () => {},
  exit = code => app.exit(code), relaunch = () => app.relaunch(), canRelaunch = () => true,
  stopMs = QUIT_STOP_MS, stallMs = QUIT_STALL_MS, exitMs = QUIT_EXIT_MS, timers = globalThis, now = Date.now,
} = {}) {
  if (!app || typeof app.on !== 'function') throw new TypeError('createQuitFlow needs the app');
  let state = 'running';
  let requestedAt = 0;
  let stallTimer = null;
  let relaunched = false;
  let ending = false; // Electron's 'quit' fired: its shutdown has begun, and the process ends
  app.on('quit', () => { ending = true; });
  const quietly = (what, fn) => { try { fn(); } catch (e) { log(`quit: ${what} failed: ${e?.message ?? e}`); } };
  const clearStall = () => {
    if (stallTimer) timers.clearTimeout(stallTimer);
    stallTimer = null;
  };

  app.on('before-quit', () => {
    if (state !== 'running') return;
    state = 'requested';
    requestedAt = now();
    log('quit-requested');
    clearStall();
    stallTimer = timers.setTimeout(() => {
      stallTimer = null;
      if (state !== 'requested') return;
      state = 'running';
      log(`quit-stalled (requested ${secs(now() - requestedAt)} ago and never committed: a window stayed open or the quit was called off; the bridge kept running)`);
    }, stallMs);
    stallTimer?.unref?.();
  });

  app.on('will-quit', (e) => {
    if (state === 'committed') return;
    e?.preventDefault?.();
    clearStall();
    state = 'committed';
    const t0 = now();
    log('quit-committed');
    quietly('onCommit', onCommit);
    let bound = null;
    const over = new Promise(r => { bound = timers.setTimeout(() => r('over'), stopMs); });
    const stopped = Promise.resolve()
      .then(() => stop())
      .then(() => 'stopped', (err) => { log(`quit: the bridge's stop failed: ${err?.message ?? err}`); return 'failed'; });
    Promise.race([stopped, over]).then((how) => {
      timers.clearTimeout(bound);
      if (how === 'over') log(`quit-stalled (the bridge took over ${secs(stopMs)} to stop; quitting anyway)`);
      else log(`quit: the bridge stopped in ${secs(now() - t0)}`);
      quietly('beforeExit', beforeExit);
      // Still running a while after exit: the quit stays committed, and nothing starts again here.
      const still = timers.setTimeout(() => {
        if (ending) { log(`quit: still ending ${secs(exitMs)} after exit (the exit began; nothing starts again)`); return; }
        log(`quit-stalled (the exit hadn't begun ${secs(exitMs)} after exit; asking again)`);
        quietly('exit', () => exit(0));
      }, exitMs);
      still?.unref?.();
      exit(0);
    });
  });

  /** app.relaunch(), once per process: the exit under way starts the app again. → whether this call asked for it. */
  function relaunchOnce() {
    if (relaunched) return false;
    relaunched = true;
    try { relaunch(); return true; } catch (e) { log(`quit: the relaunch failed: ${e?.message ?? e}`); return false; }
  }

  /** A second launch or macOS's reopen: while the quit is committed, the exiting process comes back. */
  function reopen() {
    if (state !== 'committed') return false;
    if (relaunched) log('quit: reopened during the quit (it reopens already)');
    else if (!canRelaunch()) log('quit: reopened during the quit (an update installs at this quit, so it stays closed)');
    else if (relaunchOnce()) log('quit: reopened during the quit');
    return true;
  }

  return { state: () => state, committed: () => state === 'committed', relaunchOnce, reopen };
}
