// Doorbells (docs/PROTOCOL.md §3, C-8). On 70009 the client fixes which files
// exist when the UI loads: a file created later reads as missing until the
// next /reload, while a file that was there at load is checked live, so
// deleting it reads missing and recreating it reads present again (E-015).
//
// So the bridge's signals are a few 0-byte files in NeverQuestAlone/sig/ctl, made at
// setup (or at start) and never renamed. A ring deletes one for a short pulse
// and then recreates it. A bell that happens to be missing when the UI loads
// is invisible for that session, so bells come in pairs (push, alive) and the
// two of a pair are never missing at the same time.
import fs from 'node:fs';
import path from 'node:path';
import { createRetrier, writeFileWithRetry } from './fsretry.mjs';

export const BELLS = ['push_a', 'push_b', 'alive_a', 'alive_b', 'act'];
export const PULSE_MS = { push: 3000, alive: 2500, act: 500 };
export const ACT_GAP_MS = 500;     // present between two act pulses, so a 4 Hz reader sees both
export const ALIVE_EVERY_MS = 10000; // alive_a and alive_b take turns
export const ACT_QUEUE_MAX = 8;
// A push pulse a later ring cuts short still lasts this long (audit PF-03): 4 of the addon's 0.25 s
// reads while a send is pending. A lone ring keeps its whole pulse, for a reader on the 2 s tick.
export const PUSH_MIN_MS = 1000;
// The v2.0 families: signals raised by creating files, never seen in game (C-8).
const LEGACY_FAMILIES = ['ack', 'push', 'act', 'presence'];

export function signalPaths(addonsDir) {
  const root = path.join(addonsDir, 'NeverQuestAlone', 'sig');
  return {
    root,
    dir: (family) => path.join(root, family),
    bell: name => path.join(root, 'ctl', `bell_${name}.wav`),
    present: () => path.join(root, 'ctl', 'present.wav'),
  };
}

// lstat never follows a link (or a Windows junction, which lstat reports as a link).
const lstat = (f) => { try { return fs.lstatSync(f); } catch { return null; } };
const realDir = (d) => lstat(d)?.isDirectory() === true;
const regular = (f) => lstat(f)?.isFile() === true;
const fail = (code) => Object.assign(new Error(code), { code });
// Remove a regular file, or a link itself (never what it points to); anything else is left.
// Windows sharing violations are retried (fsretry.mjs); one already gone is fine.
function drop(file, retry) {
  const st = lstat(file);
  if (!st) return;
  if (!st.isFile() && !st.isSymbolicLink()) throw fail('not_a_file');
  retry.run(() => fs.rmSync(file, { force: true })); // not recursive: on a link, removes the link
}

/**
 * signals(addonsDir) → doorbell helpers. The ctl folder is made by setup; if
 * it's missing, rings fail loudly (the client only sees files that exist when
 * the UI loads). opts.pulseMs, opts.actGapMs and opts.timers are for tests.
 *
 * No write or removal follows a link another account planted in AddOns (TH12): NeverQuestAlone/, sig/
 * and sig/ctl must be real folders (a link there counts as a missing ctl, which setup replaces),
 * a link at a bell's path is removed (the link itself) and the bell made with O_EXCL, and only
 * regular files and links are ever removed.
 */
export function createSignals(addonsDir, { log = () => {}, pulseMs = PULSE_MS, actGapMs = ACT_GAP_MS, timers = { setTimeout, clearTimeout }, retrier = null } = {}) {
  const p = signalPaths(addonsDir);
  const ctlReal = () => realDir(path.dirname(p.root)) && realDir(p.root) && realDir(p.dir('ctl'));
  let errors = 0; // signal-error this session, for Diagnostics
  let retried = 0;
  const report = (file, e) => { errors += 1; log('signal-error', { file: path.relative(p.root, file), error: e.code || e.message }); };
  // One retrier per bell operation: a bell that stays locked costs its own 150 ms at most (Windows).
  const retry = () => retrier || createRetrier({ onRetry: () => { retried += 1; } });
  // A bell (or present.wav): a regular file stays; a link planted there is removed and the bell
  // made with O_EXCL, so one planted after the check fails the write instead of being followed.
  const create = (file) => {
    try {
      if (!ctlReal()) throw fail('ctl_not_a_folder');
      if (regular(file)) return true;
      const r = retry();
      drop(file, r);
      writeFileWithRetry(r, file, '', { flag: 'wx' });
      return true;
    } catch (e) { report(file, e); return false; }
  };
  const remove = (file, { inCtl = true } = {}) => {
    try {
      if (inCtl && !ctlReal()) throw fail('ctl_not_a_folder');
      drop(file, retry());
      return true;
    } catch (e) { report(file, e); return false; }
  };

  const pending = new Set();
  const later = (ms, fn) => {
    const t = timers.setTimeout(() => { pending.delete(t); fn(); }, ms);
    pending.add(t);
  };
  const rings = Object.fromEntries(BELLS.map(b => [b, 0]));
  // Delete a bell, recreate it ms later, then call done.
  function pulse(bell, ms, done) {
    rings[bell] += 1;
    if (!remove(p.bell(bell))) { if (done) done(); return; }
    later(ms, () => { create(p.bell(bell)); if (done) done(); });
  }

  const push = { next: 'a', busy: false, again: false, cur: null };
  const alive = { next: 'a' };
  const act = { queue: 0, busy: false };

  // A ring asked for during a pulse follows it on the other bell. Once the pulse has lasted
  // PUSH_MIN_MS, that ring cuts it short (PF-03): a reply published during its ack's pulse rang 3 s
  // after the ack, now at most 1 s. The cut runs at the next tick, so rings asked for in one tick
  // still fold into one follow-up, and the bell comes back before the other goes, so the two of the
  // pair are never missing together.
  function ringPush() {
    if (push.busy) {
      const first = !push.again;
      push.again = true;
      if (first && push.cur?.min) later(0, push.cur.end);
      return;
    }
    push.busy = true;
    const bell = `push_${push.next}`;
    push.next = push.next === 'a' ? 'b' : 'a';
    const cur = { min: false, ended: false, end: null };
    const done = () => {
      push.busy = false;
      push.cur = null;
      if (push.again) { push.again = false; ringPush(); }
    };
    cur.end = () => {
      if (cur.ended) return;
      cur.ended = true;
      create(p.bell(bell));
      done();
    };
    rings[bell] += 1;
    if (!remove(p.bell(bell))) { cur.ended = true; done(); return; }
    push.cur = cur;
    later(pulseMs.push, cur.end);
    if (PUSH_MIN_MS < pulseMs.push) later(PUSH_MIN_MS, () => { cur.min = true; if (push.again) cur.end(); });
  }

  function nextAct() {
    if (act.busy || act.queue <= 0) return;
    act.busy = true;
    act.queue -= 1;
    pulse('act', pulseMs.act, () => later(actGapMs, () => { act.busy = false; nextAct(); }));
  }

  return {
    paths: p,
    /** ['ctl'] when sig/ctl (or a folder above it) is missing or isn't a real folder: run setup. */
    missingFolders() { return ctlReal() ? [] : ['ctl']; },

    /**
     * Make present.wav and every bell that isn't a regular file (missing, or a link planted there,
     * which is replaced). Nothing when sig/ctl isn't a real folder. Returns the names made.
     */
    ensure() {
      const made = [];
      if (!ctlReal()) return made;
      if (!regular(p.present()) && create(p.present())) made.push('present');
      for (const b of BELLS) if (!regular(p.bell(b)) && create(p.bell(b))) made.push(b);
      return made;
    },
    /** Tell the addon to read a slot: a 3 s pulse, alternating between the two push bells. */
    ringPush,
    /** A beat for the light: alive_a and alive_b take turns. */
    beat() {
      const bell = `alive_${alive.next}`;
      alive.next = alive.next === 'a' ? 'b' : 'a';
      pulse(bell, pulseMs.alive);
    },
    /** One tool action of a run started from WoW (queued; extras past 8 are dropped). */
    act() {
      if (act.queue < ACT_QUEUE_MAX) act.queue += 1;
      nextAct();
    },
    isArmed: bell => ctlReal() && regular(p.bell(bell)),
    stats: () => ({ rings: { ...rings }, errors, retried }),

    /**
     * Remove the v2.0 signal files (create-to-raise), which the client never saw. Only regular files
     * in real folders: a link (or a Windows junction) planted where sig/ or one of its folders goes
     * is never followed, so no file outside the addon's folder is removed (TH12; final review L3-3).
     */
    cleanupLegacy() {
      if (!realDir(path.dirname(p.root)) || !realDir(p.root)) return 0;
      let removed = 0;
      const sweep = (dir, match) => {
        if (!realDir(dir)) return;
        let names = [];
        try { names = fs.readdirSync(dir); } catch { return; }
        // Its own folders are checked above, so the sweep works whatever state ctl is in.
        for (const f of names) if (match(f) && regular(path.join(dir, f)) && remove(path.join(dir, f), { inCtl: false })) removed++;
      };
      for (const fam of LEGACY_FAMILIES) sweep(p.dir(fam), f => f.endsWith('.wav'));
      sweep(p.dir('ctl'), f => /^(live|probe)_\w+\.wav$/.test(f));
      return removed;
    },

    /** Stop pulsing and leave every bell in place, so none is missing at the next load. */
    stop() {
      for (const t of pending) timers.clearTimeout(t);
      pending.clear();
      push.busy = false; push.again = false; push.cur = null;
      act.busy = false; act.queue = 0;
      for (const b of BELLS) create(p.bell(b));
    },
  };
}
