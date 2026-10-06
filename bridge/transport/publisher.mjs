// The publisher (PRD §9.5 transport, PROTOCOL §3.1, §4): builds the slot table
// from bridge state, writes the slots the addon can load next and the reload
// inbox, and rings the push doorbell by the rules of §3.1.
//
// - publish({ push: true }) for records, acks and hello answers: written at the
//   next tick (every publish asked for in the same tick is one write) and rung.
// - publish({ push: false }) for snapshots (busy, progress): these coalesce over
//   250 ms; a push asked for meanwhile takes them along.
// - Progress-only publishes are limited to one every 20 s (progressMs).
// - A ringing publish increments the push counter P (persisted) before the
//   slots are written, so their header carries it, and rings only after they
//   are written: a ring always finds a slot with that publish. A publish that
//   wrote no file at all takes its P back and rings nothing (a read-only AddOns
//   folder never counts as "reply sent"); pushOk is the last P written with no
//   error.
// - range({push}) (the service's slot window, slots.mjs slotWindow) says which
//   slots to write; null writes every one. push: whether this publish rings.
//   written(plan, res) hears what was written.
// - pushWithin(ms) for a turn's ack (audit PF-02): the ack is written with the next
//   snapshot, and push rings ms later unless a ringing publish comes first. Every
//   slot carries bridge.acked, so the turn's reply (or its error, or aborted line)
//   brings the ack with it, and a turn costs the addon one slot load instead of two.
// - worker (code health BR-04): the slot files are written by a worker thread (bridge/write-queue.mjs, the
//   same writeSlots), so the app's main thread spends no time on them: a publish to every slot is
//   201 files, 34 ms here and up to half a second on Windows. One write at a time: a publish asked
//   for while one is being written goes once that one is on disk (every publish asked for meanwhile
//   is one write), so the files and the push counter keep their order, and the ring still comes only
//   after the files are on disk. A worker that can't start or dies leaves the writes in place, as
//   before; flushNow writes in place too (shutdown, tests), after the write in flight.
//   true: a worker of its own; an object: the bridge's one write queue (BR-04, durable writes), shared
//   with the store's and the ledger's writes, which the bridge stops itself. Either way flushNow and
//   stop drain the whole queue, and an in-place write goes behind anything still in it.
// - heard() (BR-04): false while the addon reads no doorbell (the talking session's stream or reload
//   mode: it loads slots on its own timers), so a ringing publish counts P and pushAt as ever and
//   sounds no bell nobody hears.
// - What's on disk (the 1.4.1 revert, CI run 37127457103): while the worker writes a ringing publish,
//   its P is counted (persisted, in its slots' header) but not on disk yet. settledPush() is the newest
//   P whose files are, for what may ring (the core's re-rings) and what status says; and the ring an
//   ack is owed is paid by the slot BUILT after it: a ringing publish takes the owed ring when its
//   slot is built (it carries every ack so far), not when it's written, so an ack that comes during
//   the write keeps its own; one that reached no file gives it back, at the time it was due.
import { slotTable } from './luaenc.mjs';
import { writeSlots, SLOT_JOB } from './slots.mjs';
import { createSlotWorker } from '../write-queue.mjs';

const ms2 = v => Math.round(v * 100) / 100;

export function createPublisher({ store, signals, addonsDir, buildSlot, log = () => {}, coalesceMs = 250, progressMs = 20000, slotCount, now = () => Date.now(),
  range = null, written = null, worker = false, heard = null }) {
  let timer = null; // a snapshot waiting to coalesce
  let soon = null; // a push due at the next tick
  let wantPush = false;
  let lastProgressAt = 0;
  let publishes = 0;
  let lastBytes = 0;
  let lastFiles = 0;
  let lastErrors = 0;
  let lastMs = 0;
  let slotErrors = 0; // this session's, for Diagnostics
  let slotRetries = 0;
  let mapUntil = 0;
  let stopped = false; // after stop(), nothing more is written (a send settling late asks for a publish)
  let owed = null; // the ring an ack is owed (pushWithin): given by the first ringing publish, or at its time
  let owedAt = 0; // when that ring is due
  // BR-04: the worker (true: one of its own; an object with write-queue.mjs's surface: the bridge's queue, or
  // a test's), the publish it is writing, and whether another was asked for meanwhile.
  const writer = worker ? (typeof worker === 'object' ? worker : createSlotWorker({ log })) : null;
  writer?.use?.(SLOT_JOB); // what runs the slot tables, before the first is queued
  const ownWriter = worker === true;
  let writing = null;
  let again = false;
  let draining = false;
  const bells = () => { try { return heard ? heard() !== false : true; } catch { return true; } };

  // The store's P, unless a ringing publish is being written: then the P before it.
  const settledPush = () => (writing && writing.p !== null ? writing.before : store.state.push);

  function clear() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (soon) { clearImmediate(soon); soon = null; }
  }

  function flush({ inPlace = false } = {}) {
    clear();
    if (writing) { again = true; return; } // goes once the write in flight is on disk
    const t0 = performance.now();
    const push = wantPush;
    wantPush = false;
    let p = null;
    if (push) p = store.nextPush();
    const slot = buildSlot();
    const includeMap = now() < mapUntil || now() - (store.state.mapChangedAt || 0) < 180000;
    const { text, bytes, trimmed, mapIncluded } = slotTable('NQA_SlotData', slot, { includeMap });
    const inbox = text.replace(/^NQA_SlotData = /m, 'NQA_Inbox = ');
    let plan = null;
    try { plan = range ? range({ push }) : null; } catch (e) { log('slot-window-error', { error: String(e?.message || e).slice(0, 120) }); plan = null; }
    const opts = { count: slotCount, ...(plan ? { from: plan.from, to: plan.to, blank: plan.blank } : {}) };
    // The slot built now carries every ack so far: a ringing one takes the owed ring (given back if it reaches no file).
    const pub = { t0, push, p, before: p === null ? null : p - 1, plan, bytes, records: slot.records.length, trimmed, mapIncluded, main: null, owedAt: null };
    if (p !== null && owed) { clearTimeout(owed); owed = null; pub.owedAt = owedAt; }
    // In place only with nothing queued ahead of it (BR-04, durable writes): a drain that couldn't empty the
    // queue (a worker still writing a job when its time was up) leaves this publish behind what's queued.
    if (writer && (!inPlace || writer.busy?.())) {
      // Its answer always comes later (a message, or a drain), never inside write().
      const posted = writer.write({ addonsDir, text, inbox, opts }, (res) => {
        writing = null;
        let r = res;
        // The worker died first: written in place, unless the publisher has stopped since.
        if (!r && !stopped) {
          const t1 = performance.now();
          r = writeSlots(addonsDir, text, inbox, { ...opts, log });
          pub.main += performance.now() - t1;
        }
        settle(pub, r);
        if (again && !stopped && !draining) { again = false; flush(); }
      });
      if (posted) { pub.main = performance.now() - t0; writing = pub; return; }
    }
    settle(pub, writeSlots(addonsDir, text, inbox, { ...opts, log }));
  }

  // What a write did (its files on disk): the counts, P's fate, the window's bookkeeping, then the ring.
  function settle(pub, res) {
    const { push, plan } = pub;
    let { p } = pub;
    const r = res || { bytes: 0, errors: 0, files: 0, written: 0, retries: null };
    lastBytes = pub.bytes;
    lastFiles = r.files;
    lastErrors = r.errors;
    slotErrors += r.errors;
    slotRetries += r.retries?.retries || 0;
    publishes++;
    if (push && r.written === 0) {
      // Nothing reached the disk: no file carries P, so it's taken back (unless a newer number came
      // meanwhile: an addon's p= the store caught up to), and there's nothing to ring for.
      if (store.state.push === p) store.state.push = p - 1;
      p = null;
    } else if (push && !r.errors) store.state.pushOk = p;
    try { written?.(plan, r); } catch { /* the window's bookkeeping never stops a publish */ }
    // Nothing written: the ack's ring it took when its slot was built is owed again, due when it was.
    if (p === null && pub.owedAt !== null && !stopped && !owed) oweRing(pub.owedAt);
    if (p !== null) {
      // When this publish rang, for re-rings (§3): now, after the write, which a slow disk (a virus
      // scan of 201 new files) can stretch to seconds that the addon, not rung yet, can't have used
      // to hear it.
      store.state.pushAt = now();
      if (!stopped && bells()) signals.ringPush();
    }
    lastMs = ms2(performance.now() - pub.t0);
    log('publish', { bytes: pub.bytes, records: pub.records, trimmed: pub.trimmed, map: pub.mapIncluded, push: p ?? undefined, files: r.files,
      window: plan ? `${plan.from}-${plan.to}` : undefined, ms: lastMs, main: pub.main === null ? undefined : ms2(pub.main), errors: r.errors || undefined });
  }

  function oweRing(at) {
    owedAt = at;
    owed = setTimeout(() => { owed = null; publish({ push: true }); }, Math.max(0, at - now()));
  }

  /** Schedule a publish. push: at the next tick, and ring the push doorbell after it. progress: rate-limited. */
  function publish({ push = false, progress = false, map = false } = {}) {
    if (stopped) return false;
    if (progress && !push && !timer && !soon) {
      if (now() - lastProgressAt < progressMs) return false;
      lastProgressAt = now();
    }
    if (map) mapUntil = now() + 180000;
    if (push) {
      wantPush = true;
      if (!soon) soon = setImmediate(flush);
      return true;
    }
    if (!timer && !soon) timer = setTimeout(flush, coalesceMs);
    return true;
  }

  // The write in flight, on disk now (its answer handled; what was asked for meanwhile left to the caller).
  function drain() {
    if (!writer) return;
    draining = true;
    try { writer.drain(); } finally { draining = false; }
  }

  return {
    publish,
    /**
     * A snapshot now, and a ring within ms (a turn's ack, PF-02): the first ringing publish before
     * then rings for it; else it rings at ms. ms of 0 or less rings at the next tick, as publish({push}).
     */
    pushWithin(ms) {
      if (stopped) return false;
      if (!(ms > 0)) return publish({ push: true });
      if (!owed) oweRing(now() + ms);
      return publish({});
    },
    /** Whether an ack's ring is still owed (tests, diagnostics). */
    owesRing: () => owed !== null,
    /** Publish right now (used on shutdown and in tests): after the write in flight, in place. */
    flushNow() { drain(); again = false; flush({ inPlace: true }); },
    stats: () => ({ publishes, lastBytes, lastFiles, errors: lastErrors, ms: lastMs, push: settledPush(), pushOk: store.state.pushOk ?? 0, slotErrors, slotRetries,
      worker: writer ? writer.state() : 'off' }),
    /** The newest push counter whose slot files are on disk (a ringing publish being written isn't yet). */
    settledPush,
    /** Whether a publish is being written by the worker (tests). */
    writing: () => writing !== null,
    stop() {
      clear();
      if (owed) { clearTimeout(owed); owed = null; }
      drain(); // what's in flight lands, rung as it would have been
      stopped = true;
      again = false;
      if (ownWriter) writer?.stop(); // the bridge's shared queue goes when the bridge stops (BR-04)
    },
  };
}
