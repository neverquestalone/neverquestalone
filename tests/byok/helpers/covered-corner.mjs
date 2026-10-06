// The watchdog's three cases on a helper that reads a real screen (display DR-25, systems critic SY-09),
// as one scenario with the helper and the game's window behind a "scene", so the same steps and the same
// assertions run twice:
//   - on the windows-smoke job, with the real nqa-capture.exe, Desktop Duplication, a stand-in game
//     window showing the addon's strip and a window over its corner (tests/byok/windows_smoke_test.mjs);
//   - everywhere, with a stand-in helper that reads what the scene shows unless it is covered
//     (tests/capture_loop_test.mjs), so the steps themselves, the SavedVariables the game writes, boot's
//     wiring and the watchdog's numbers are proven on every OS, and a change to the scenario is tried on
//     a Mac before it costs a CI run.
// Both go through bootByok (boot's own wiring of the capture supervisor and the watchdog), with the
// watchdog's thresholds injected so the case runs in about 20 s. Not a test file.
//
//   1. The covered corner. A topmost, click-through, non-activating window (the shape of Discord's overlay)
//      sits over the strip's corner. Frames arrive, nothing decodes, and the watchdog says and does
//      nothing: no state published, no restart (a covered corner alone is not evidence: nothing was sent).
//   2. R4'. The game's SavedVariables file exists, written before the helper attached, and the bridge's
//      first read of it (a record from an older session) is no evidence. With the cover still on, the game
//      writes it again carrying a keyed record the strip never carried (the player's Reload, after a message
//      that stayed "Sending..."). The watchdog restarts the helper once and publishes no_signal (blind), rung.
//      The restarted helper is covered too, so it stays no_signal and is not started over again.
//   3. The clear. The strip now shows a hello (the new UI session) and, once the cover is gone, the helper
//      reads it: R6 publishes ok, rung, and the bridge has the hello.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { bootByok } from '../../../bridge/byok/boot.mjs';
import { installAddon } from '../../../bridge/byok/wow.mjs';
import { createKeyStore } from '../../../bridge/byok/security/keystore.mjs';
import { encodeRecord, RS } from '../../../bridge/transport/records.mjs';
import { createRetrier, renameWithRetry } from '../../../bridge/transport/fsretry.mjs';
import { waitFor, sleep, tmpDir, NO_CHECKS } from './byok-env.mjs';

const TOKEN = '3fa9c2d1';
const CHAT = 'c3f9a1b';
const OLD = 'd0d0';   // an earlier UI session
const LIVE = 'a1b2';  // the session that sent the message and clicked Reload
const NEXT = 'b2b2';  // the session after that Reload

const msgWire = (nonce, n, text) => encodeRecord({ token: TOKEN, key: `${nonce}_${n}`, type: 'msg', chat: CHAT, args: { cur: 0, ctx: 0 }, text });
const helloWire = nonce => encodeRecord({ token: TOKEN, key: nonce, type: 'hello', args: { cur: 0, ver: '1.5.4', ctx: 0, mode: 'pixel', sid: '0123456789abcdef', slots: 200 } });
const entry = wire => ({ key: wire.split('\x1F')[2], wire });

/** What the strip carries at each step, as a payload the helper decodes (records joined by RS). */
export const PAYLOADS = Object.freeze({
  live: msgWire(LIVE, 1, 'where do I turn this in?'),
  next: helloWire(NEXT),
});
export const NONCES = Object.freeze({ old: OLD, live: LIVE, next: NEXT });

const retrier = createRetrier();
/** The game's write of SavedVariables (its own layout), through a temp file so a poll never reads half of it. */
function writeSavedVariables(flavorDir, entries, { ageMs = 0 } = {}) {
  const dir = path.join(flavorDir, 'WTF', 'Account', 'TESTACCOUNT', 'SavedVariables');
  fs.mkdirSync(dir, { recursive: true });
  const rows = entries.map(e => `\t\t{\n\t\t\t["key"] = "${e.key}",\n\t\t\t["hex"] = "${Buffer.from(e.wire, 'utf8').toString('hex')}",\n\t\t},\n`).join('');
  const file = path.join(dir, 'NeverQuestAlone.lua');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `NQADB = {\n\t["token"] = "${TOKEN}",\n\t["outbox"] = {\n${rows}\t},\n}\n`);
  if (ageMs) { const at = new Date(Date.now() - ageMs); fs.utimesSync(tmp, at, at); }
  renameWithRetry(retrier, tmp, file);
  return file;
}

/**
 * The scene: what the scenario asks of the helper and the game's window.
 *   scene.start({ flavorDir, root, text })   the game's window is up in flavorDir, its strip showing text
 *   scene.cover() / scene.uncover()          a window over the strip's corner, or not
 *   scene.showStrip(text)                    the strip shows this now
 *   scene.makeCapture(o)                     boot's createCapture: the helper (o is what boot hands it)
 *   scene.stop()
 * Returns { skipped: reason } when the machine can't show what the case needs, else undefined.
 */
export async function coveredCornerScenario(t, scene, { fatal = ['capture_unsupported', 'access_lost', 'capture_blocked_by_app'], readyMs = 40_000 } = {}) {
  const root = tmpDir('bones-cover-');
  const flavorDir = path.join(root, 'World of Warcraft', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  const inst = installAddon({ flavorDir, running: false });
  assert.equal(inst.ok, true, JSON.stringify(inst.steps));
  // The game wrote SavedVariables an earlier session ago: before this bridge and its helper start.
  const older = entry(msgWire(OLD, 1, 'an older question'));
  writeSavedVariables(flavorDir, [older], { ageMs: 120_000 });

  const logs = [];
  const payloads = [];
  const statsLines = [];
  let capture = null;
  const log = (tag, d) => logs.push({ tag, ...(d && typeof d === 'object' ? d : {}) });
  const count = (tag, f = () => true) => logs.filter(l => l.tag === tag && f(l)).length;
  const connects = () => count('capture-conn', l => l.connected === true);
  const watchdogRestarts = () => count('capture-restart', l => l.rule !== undefined);
  const helperRestarts = () => count('capture-restart', l => l.rule === undefined);

  try {
    // The game's window is up and its corner already covered when the bridge starts, as an overlay that
    // was there from launch: the helper's first look at the strip is a covered one.
    await scene.start({ flavorDir, root, text: PAYLOADS.live });
    await scene.cover();
    const b = await bootByok({
      paths: { userData: path.join(root, 'ud') }, home: path.join(root, 'home'), env: {}, log,
      keystore: createKeyStore({ backend: 'memory' }),
      config: { wow: { flavorDir }, byok: { provider: 'anthropic' } },
      capture: true, lockDir: path.join(root, 'locks'), egress: false,
      wow: { run: () => ({ status: 1, stdout: '' }), roots: [] }, backendOptions: NO_CHECKS,
      signalTimings: { pulseMs: { push: 20, alive: 20, act: 5 }, actGapMs: 5 },
      // The rules' numbers, shorter (capture-health.mjs HEALTH): a restart settles for 1 s, and the next
      // one for the same rule is far off, so "one restart" is not a matter of how fast the runner is.
      captureThresholds: { settleMs: 1000, backoffMs: [0, 300_000, 600_000] },
      createCapture: o => (capture = scene.makeCapture({
        ...o, statsSec: 2,
        onPayload: p => { payloads.push(p); o.onPayload(p); },
        onStatus: s => { if (s?.stats) statsLines.push(s.stats); o.onStatus(s); },
      })),
    });
    t.after(() => b.stop());
    assert.ok(b.bridge && capture, 'the bridge runs for the folder, with its capture helper');
    const health = b.bridge.captureHealth;
    const slotState = () => b.bridge.buildSlot().bridge.capture;

    // ---------------------------------------------------------------- 1. the covered corner
    const t0 = Date.now();
    while (!(statsLines.at(-1)?.frames > 0)) {
      const bad = logs.find(l => l.tag === 'capture-error' && fatal.includes(l.kind));
      if (bad && Date.now() - t0 > 8000) return { skipped: `this machine's display can't be read by the helper: ${bad.kind} (${bad.error ?? bad.message ?? ''})`.trim() };
      if (Date.now() - t0 > readyMs) throw new Error(`no frame within ${readyMs} ms; the helper said: ${JSON.stringify(logs.filter(l => /^capture-(info|warn|error)$/.test(l.tag)).map(l => l.info ?? l.warn ?? l.error).slice(0, 12))}`);
      await sleep(100);
    }
    // Two stats lines after the first frames, so a rule that judges a line has had its chance.
    const mark = statsLines.length;
    await waitFor(() => statsLines.length >= mark + 2, 20_000, 'two more stats lines');
    const first = statsLines.at(-1);
    t.diagnostic(`covered: stats ${JSON.stringify({ frames: first.frames, decoded: first.decoded, rejected: first.rejected, attached: first.attached })}`);
    assert.ok(first.frames > 0, 'frames arrive: the helper is attached and the desktop is read');
    assert.equal(first.decoded, 0, 'nothing decodes under the cover');
    assert.equal(first.attached, true);
    assert.equal(payloads.length, 0, 'no strip payload reached the bridge');
    assert.equal(health.state(), 'ok', 'nothing sent, nothing judged: the covered corner alone publishes nothing');
    assert.equal(slotState().state, 'ok');
    assert.equal(watchdogRestarts(), 0);
    assert.equal(helperRestarts(), 0);
    assert.equal(count('capture-typed'), 0);
    assert.equal(count('capture-blind'), 0, 'the older write, from before the attach, is no evidence');
    assert.equal(health.info().ringsLeft, 6, 'no rung publish yet');
    assert.equal(connects(), 1);

    // ---------------------------------------------------------------- 2. R4' at the player's Reload
    const push = b.bridge.status().push;
    await sleep(50); // the write's mtime is after the attach, by more than a clock's grain
    const carried = entry(PAYLOADS.live.split(RS)[0]);
    writeSavedVariables(flavorDir, [older, carried]);
    b.bridge.pollSavedVariables(); // the bridge's own timer would find it; the same call
    await waitFor(() => health.state() === 'no_signal', 5000, 'R4\' at once');
    assert.deepEqual([slotState().state, slotState().cause], ['no_signal', 'blind']);
    assert.equal(count('capture-blind'), 1);
    assert.equal(watchdogRestarts(), 1, 'one restart, asked at once');
    assert.equal(logs.find(l => l.tag === 'capture-restart' && l.rule !== undefined).rule, 'R4');
    await waitFor(() => helperRestarts() === 1, 5000, 'the supervisor started the helper over');
    await waitFor(() => b.bridge.status().push > push, 5000, 'the no_signal publish rung');
    assert.equal(health.info().ringsLeft, 5, 'rung once');
    assert.equal(health.pausesRering(), true);
    // The helper is back, and covered too: it reads nothing, stays no_signal, and is not started over again.
    await waitFor(() => connects() >= 2, 30_000, 'the helper connected again');
    const mark2 = statsLines.length;
    await waitFor(() => statsLines.length > mark2, 20_000, 'a stats line from the new helper');
    const again = statsLines.at(-1);
    t.diagnostic(`after the restart: stats ${JSON.stringify({ frames: again.frames, decoded: again.decoded, attached: again.attached })}`);
    assert.ok(again.frames > 0 && again.decoded === 0);
    assert.equal(payloads.length, 0);
    assert.equal(health.state(), 'no_signal');
    assert.equal(watchdogRestarts(), 1);

    // ---------------------------------------------------------------- 3. the clear
    // The new UI session's hello is what the strip shows. Under the cover it is still not read.
    await scene.showStrip(PAYLOADS.next);
    const mark3 = statsLines.length;
    await waitFor(() => statsLines.length >= mark3 + 2, 20_000, 'stats while the strip changes under the cover');
    assert.equal(payloads.length, 0, 'still covered: nothing read');
    assert.equal(health.state(), 'no_signal');
    const push2 = b.bridge.status().push;
    await scene.uncover();
    await waitFor(() => health.state() === 'ok', 30_000, 'R6: the strip is read once the cover is gone');
    assert.ok(payloads.length >= 1, 'a strip payload reached the bridge');
    assert.ok(payloads.some(p => p.text.includes(NEXT)), JSON.stringify(payloads.map(p => p.text.slice(0, 40))));
    assert.equal(slotState().state, 'ok');
    await waitFor(() => b.bridge.status().token?.nonce === NEXT, 5000, 'the new session\'s hello heard');
    await waitFor(() => b.bridge.status().push > push2, 5000, 'the ok publish rung');
    assert.equal(health.view().seen, true, 'the app can say the game is seen');
    assert.equal(health.pausesRering(), false);
    assert.equal(health.info().ringsLeft, 5, 'the new session has rung once (its ok)');
    assert.equal(watchdogRestarts(), 1, 'one restart in all');
    assert.equal(count('capture-typed'), 0);
    t.diagnostic(`R4' restarts: ${watchdogRestarts()}, helper connects: ${connects()}, payloads read: ${payloads.length}`);
    return undefined;
  } catch (e) {
    // What the bridge and the helper said, for a CI log that can't be reproduced by hand.
    const say = logs.filter(l => !/^(capture-stats|publish|gateway-state)$/.test(l.tag)).slice(-40).map(l => JSON.stringify(l).slice(0, 300));
    t.diagnostic(`failed: ${e?.message}; the last log lines:\n${say.join('\n')}`);
    throw e;
  } finally {
    await scene.stop();
  }
}

// ---------------------------------------------------------------- a stand-in helper for every OS

/**
 * A scene with a helper that reads whatever the game's window shows unless it is covered: a stand-in for the
 * real one (its lines are the ones capture.mjs takes: connected, game, window, stats, payload). It says
 * one frame in every stats line, whether the desktop changed or not, since the Mac's stall rule (R3)
 * would call a stream with none a stalled one on a Mac, and this runs there too. Its restart() closes the
 * connection and starts a new process 150 ms later, as the Windows supervisor does.
 */
export function standInScene() {
  const st = { text: null, covered: false, seq: 0, cap: null, gen: 0 };
  const scene = {
    async start({ text }) { st.text = text; },
    async cover() { st.covered = true; },
    async uncover() { st.covered = false; },
    async showStrip(text) { st.text = text; },
    async stop() { st.cap?.stop(); },
    makeCapture(o) {
      let timer = null;
      let stopped = false;
      let run = null;
      const pid = process.pid; // a live one: the core asks the OS about it every 10 s (checkGamePid)
      const begin = () => {
        if (stopped) return;
        const me = run = { frames: 0, decoded: 0, last: null, statsAt: Date.now(), sent: 0 };
        o.onStatus({ connected: true });
        o.log?.('capture-conn', { connected: true });
        o.onGame({ state: 'running', pid });
        o.onStatus({ window: { pid, width: 960, height: 360, dpi: 96 } });
        timer = setInterval(() => {
          if (run !== me) return;
          me.frames += 1;
          const shown = st.covered ? null : st.text;
          if (shown && shown !== me.last) {
            me.last = shown;
            me.decoded += 1;
            o.onPayload({ id: ++st.seq, text: shown });
          }
          if (Date.now() - me.statsAt >= 200) {
            me.statsAt = Date.now();
            o.onStatus({ stats: { interval: { frames: 1, decoded: 0, rejected: 0 }, frames: me.frames, decoded: me.decoded, rejected: 0, attached: true } });
          }
        }, 50);
      };
      const end = () => {
        clearInterval(timer);
        if (run) { o.onStatus({ connected: false }); o.log?.('capture-conn', { connected: false }); run = null; }
      };
      const cap = st.cap = {
        kind: 'windows-helper',
        start() { begin(); },
        stop() { stopped = true; end(); },
        restart(reason) {
          if (stopped) return false;
          o.log?.('capture-restart', { reason });
          end();
          setTimeout(begin, 150).unref?.();
          return true;
        },
        retryNow: () => false,
        probe() {},
        status: () => ({ kind: 'windows-helper', connected: !!run, stats: run ? { frames: run.frames, decoded: run.decoded } : null }),
      };
      return cap;
    },
  };
  return scene;
}
