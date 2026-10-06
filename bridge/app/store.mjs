// Bridge state (PRD §9.5 "State"): state.json, records.json and outbox.jsonl
// in the bridge's state folder (0700; files 0600). Every write is
// temp file + rename (upstream issue #13). Only a new message in the outbox is
// fsynced (writeFileDurable), since the addon forgets it once acked; the rest is
// written without (writeFileQuick, systems plan Batch 4), and state.json once per
// tick however many times a turn changes it (flush() writes it now; an outbox
// write and a push counter flush it first, so the order on disk stays the order
// of the changes).
//
// state.json   counters (seq, push), per-token cursors and nonces, chats,
//              runs in flight, published message ids, map, dedupe keys.
// records.json the ring of published records (last 500) with their seq, and when each was made
//              (_at, ms; kept here only, never published): the bridge forgets a chat's with the
//              chat and prunes them by the transcript retention (final review L5-1).
// outbox.jsonl sends the backend hasn't acknowledged yet (one JSON per line).
//
// A file that can't be read or parsed is kept aside (<file>.corrupt-<ms>) and logged, never read as
// empty in silence. A file that can't be written (a full disk) never throws out of the store: what it
// holds stays in memory, health() says so (writeError), and retryWrites() writes it again (code health
// BR-11: an outbox or records write that threw left a message unsent or a billed reply unshown). The store's epoch is random, made once and never reused: a new epoch means a new
// store (a reinstall, a file moved aside), and the slot carries it (bridge.epoch). The addon's cursor
// and push counter above the store's own (a store that started over while SavedVariables kept the
// addon's) move the store's up to them (catchUp), so the next reply is numbered past what the addon
// has read and is shown, with any addon.
//
// With a writer (code health BR-04, durable writes: the bridge's one ordered queue on the slot worker's
// thread, bridge/write-queue.mjs), every write of state.json and the outbox is a job in it, behind the
// slot writes and the ledger's, so they reach the disk in the order asked for and off the main thread:
// the outbox's new message (fsynced) before the slot that acks it, state.json (the chat, the dedupe mark,
// P, a run in flight) just before the outbox write that follows it, as in place. What a write did is
// booked when its answer comes (owed, writeError, the host told), as it was when it returned; an outbox
// write queued while a durable one is unanswered is durable too (if that one is refused, this may be the
// first to hold its message, as an outbox write owed since a failure is). records.json is written in
// place as before: nothing a crash leaves depends on its order with these (openStore makes the numbering
// and the published marks catch up with whatever records it finds).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureStateDir, writeFileDurable, writeFileQuick } from '../files.mjs';

export const RECORDS_MAX = 500;
// Code health BR-13: records.json was rewritten whole for every record (2-3 times a turn), 0.8-3 MB
// once the 500-record ring held long replies. The ring is held to RECORDS_BYTES as well, its oldest
// records going first as at RECORDS_MAX, but never one that a token seen in the last DEDUPE_MS hasn't
// read: a slot carries at most 40 KB of records anyway (luaenc.mjs RECORD_BYTES_MAX), and the
// published ids and runs (PUBLISHED_MAX) are what keeps a reply to one showing.
export const RECORDS_BYTES = 256 * 1024;
export const DEDUPE_MS = 7 * 24 * 3600 * 1000;
export const DEDUPE_MAX = 20000;
// How many published message ids and runs the store keeps (SY-14): a run's reply is published once,
// whichever comes first of its live final and the backend's outcomes() (code health BR-22), and a run
// in flight is never older than the last 500 published. 500 keeps state.json small (it's rewritten
// several times a turn).
export const PUBLISHED_MAX = 500;
// The most catchUp moves a counter to: 2^31 - 1, since the addon writes cur= and p= with %d, a C
// long, 32 bits on Windows (the parser's 12 digits, SY-19, allow more). This holds for any other
// caller too, so one bad number can't stop the numbering counting in ones.
export const COUNTER_MAX = 2 ** 31 - 1;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
export const newEpoch = () => crypto.randomBytes(8).toString('hex');
export const EPOCH_RE = /^[0-9a-f]{16}$/;

/**
 * Read a JSON file: {value} when it parsed and `ok(value)`, {missing: true} when there's none, else
 * {bad: <code>} and the file is moved aside to <file>.corrupt-<ms> (keptAs; null if it couldn't be).
 */
function readJson(file, ok, now) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    return { bad: e.code || 'unreadable', keptAs: keepAside(file, now) };
  }
  try {
    const value = JSON.parse(text);
    if (ok(value)) return { value };
  } catch { /* below */ }
  return { bad: 'corrupt', keptAs: keepAside(file, now) };
}
function keepAside(file, now) {
  const to = `${file}.corrupt-${now()}`;
  try { fs.renameSync(file, to); return to; } catch { return null; }
}

export function emptyState() {
  return {
    v: 1,
    epoch: null,          // this store's random id (made at open when missing, never reused)
    seq: 0,               // last record seq
    push: 0,              // last push counter (push/<P>.wav)
    pushOk: 0,            // the last push counter a publish wrote with no error
    lastToken: null,      // the token that said hello most recently
    tokens: {},           // token -> { nonce, nonces[], lastReported, maxReported, ctx, sendCounter, firstSeen, lastSeen, ver, build, iface, sig }
    chats: {},            // chatId -> { id, key, agent, label, started, created, token }
    inflight: {},         // runId -> { chat, key (send key), token, sentAt, actions, kind, msg?, intro? }
    published: {},        // backend message id -> seq (bounded)
    publishedRuns: {},    // runId -> seq: a run's reply, published once (its live final, or the backend's outcomes())
    dedupe: {},           // "<token>:<key>" -> first seen ms (7 days, bounded)
    map: null,            // bridge map state (upstream shape)
    mapChangedAt: 0,
    lastOnlineAt: 0,
  };
}

/**
 * openStore(dir, {log, now, onWriteError, writer}). log(kind, fields) hears what was kept aside ('store-corrupt'),
 * a store that started over under an addon that had read more ('store-behind') and a write that failed
 * ('store-write-error'); onWriteError() hears when writeError comes or goes. PUBLISHED_MAX published ids
 * and runs are kept. writer: the bridge's write queue (BR-04), else every write is made in place.
 */
export function openStore(dir, { log = () => {}, now = Date.now, onWriteError = () => {}, writer = null } = {}) {
  ensureStateDir(dir);
  const files = {
    state: path.join(dir, 'state.json'),
    records: path.join(dir, 'records.json'),
    outbox: path.join(dir, 'outbox.jsonl'),
  };
  // What couldn't be read at open, for status(): [{file, error, keptAs}].
  const problems = [];
  const note = (name, r) => {
    if (!r.bad) return;
    problems.push({ file: name, error: r.bad, keptAs: r.keptAs ? path.basename(r.keptAs) : null });
    log('store-corrupt', { file: name, error: r.bad, keptAs: r.keptAs ? path.basename(r.keptAs) : null });
  };
  const st = readJson(files.state, isObj, now);
  note('state.json', st);
  const state = { ...emptyState(), ...(st.value || {}) };
  const rec = readJson(files.records, Array.isArray, now);
  note('records.json', rec);
  let records = (rec.value || []).filter(r => isObj(r) && Number.isInteger(r.seq));
  let outbox = [];
  let text = null;
  try { text = fs.readFileSync(files.outbox, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') note('outbox.jsonl', { bad: e.code || 'unreadable', keptAs: keepAside(files.outbox, now) }); }
  if (text !== null) {
    let bad = 0;
    for (const l of text.split('\n')) {
      if (!l) continue;
      try { const o = JSON.parse(l); if (isObj(o)) outbox.push(o); else bad++; } catch { bad++; }
    }
    // A line that doesn't parse is logged and the file kept aside as it was; the rest still goes.
    if (bad) {
      const to = `${files.outbox}.corrupt-${now()}`;
      try { fs.copyFileSync(files.outbox, to); } catch { /* the log still says */ }
      note('outbox.jsonl', { bad: `corrupt (${bad} line${bad === 1 ? '' : 's'})`, keptAs: fs.existsSync(to) ? to : null });
    }
  }
  // A new store (or one kept aside) gets a new epoch; the numbering can't be behind its own records.
  let dirty = false;
  if (!EPOCH_RE.test(String(state.epoch ?? ''))) { state.epoch = newEpoch(); dirty = true; }
  const top = records.reduce((m, r) => Math.max(m, r.seq), 0);
  if (!Number.isInteger(state.seq) || state.seq < top) { state.seq = Math.max(Number.isInteger(state.seq) ? state.seq : 0, top); dirty = true; }
  // A kept reply counts as published: a crash between its record (records.json, written at once) and
  // its marks (state.json, saved on the next tick; neither fsynced) must not publish it again.
  state.published ||= {};
  state.publishedRuns ||= {};
  for (const r of records) {
    if (r.mid && !(state.published[r.mid] >= r.seq)) state.published[r.mid] = r.seq;
    if (r.run && !(state.publishedRuns[r.run] >= r.seq)) state.publishedRuns[r.run] = r.seq;
  }
  if (!Number.isInteger(state.push) || state.push < 0) { state.push = 0; dirty = true; }
  // When the store last found the addon ahead of it (catchUp): {at, seq, push} for status().
  let behind = null;
  let stateDirty = false;
  let tick = null;
  let batch = null; // while batchOutbox runs: { dirty, durable }, the one write owed at its end
  // Files whose last write failed (BR-11): the store's name for each, and the first failure still open.
  const owed = new Set();
  let writeError = null; // { file, code, at }
  const tell = () => { try { onWriteError(); } catch { /* a listener never breaks the store */ } };
  /** What one file's write did: a failure is kept (owed, writeError, the log), never thrown. → whether it was written. */
  function booked(name, res) {
    if (!res?.ok) {
      owed.add(name);
      const code = res?.code || 'error';
      if (!writeError) { writeError = { file: name, code, at: now() }; tell(); }
      log('store-write-error', { file: name, error: code });
      return false;
    }
    owed.delete(name);
    if (writeError && !owed.size) { writeError = null; tell(); }
    return true;
  }
  /**
   * Replace one of the store's files: a job in the writer's queue when there is one (its answer books it, and
   * then(ok)), else now. → whether it was written (now), or null (queued).
   */
  function write(name, file, data, { durable = false, then = null, queue = true } = {}) {
    const answer = (res) => { const ok = booked(name, res); then?.(ok); return ok; };
    if (queue && writer?.writeFile?.({ file, data, durable }, answer)) return null;
    try {
      (durable ? writeFileDurable : writeFileQuick)(file, data);
    } catch (e) { return answer({ ok: false, code: typeof e?.code === 'string' ? e.code : 'error' }); }
    return answer({ ok: true });
  }
  let durableOutbox = 0; // durable outbox writes queued and not yet answered

  const store = {
    dir, files, state,
    get records() { return records; },
    get outbox() { return outbox; },
    /**
     * What couldn't be read at open (moved aside), when the addon was last found ahead, and a write that
     * failed and hasn't been made since: { file, code, at, diskFull } (BR-11; status().store).
     */
    health: () => ({ problems: problems.map(p => ({ ...p })), behind: behind ? { ...behind } : null,
      writeError: writeError ? { ...writeError, diskFull: writeError.code === 'ENOSPC' } : null }),

    /** state.json at the next tick (once, however many changes come before it). */
    saveState() {
      stateDirty = true;
      if (!tick) { tick = setImmediate(() => { tick = null; store.flush(); }); tick.unref?.(); }
    },
    /** Write state.json now if it has changes waiting (stop, and before an outbox write). */
    flush() {
      if (tick) { clearImmediate(tick); tick = null; }
      if (!stateDirty) return;
      stateDirty = false;
      // A write that fails stays due (the next change, flush or retry tries again), and is logged.
      write('state.json', files.state, JSON.stringify(state) + '\n', { then: (ok) => { if (!ok) stateDirty = true; } });
    },
    saveRecords() {
      let text = JSON.stringify(records);
      if (Buffer.byteLength(text) > RECORDS_BYTES) {
        // The oldest read records go until the ring fits (BR-13); the newest always stays. In memory too,
        // whether the write below goes or is owed (BR-11), so a retry writes the ring as it is then.
        const seen = Object.values(state.tokens).filter(t => (t?.lastSeen ?? 0) >= now() - DEDUPE_MS).map(t => t?.lastReported ?? 0);
        const upTo = seen.length ? Math.min(...seen) : state.seq;
        let over = Buffer.byteLength(text) - RECORDS_BYTES;
        let k = 0;
        while (over > 0 && k < records.length - 1 && records[k].seq <= upTo) over -= Buffer.byteLength(JSON.stringify(records[k++])) + 1;
        if (k) { records = records.slice(k); text = JSON.stringify(records); }
      }
      write('records.json', files.records, text + '\n', { queue: false });
    },
    /** durable: a new message, which the addon forgets once it's acked. Inside batchOutbox: owed to its end. */
    saveOutbox({ durable = false } = {}) {
      if (batch) { batch.dirty = true; batch.durable ||= durable; return; }
      store.flush();
      // One owed since a failed write is written durably: it may hold a new message. So is one queued while a
      // durable one is unanswered (BR-04).
      const sure = durable || owed.has('outbox.jsonl') || durableOutbox > 0;
      if (sure) durableOutbox += 1;
      write('outbox.jsonl', files.outbox, outbox.map(o => JSON.stringify(o)).join('\n') + (outbox.length ? '\n' : ''),
        { durable: sure, then: sure ? () => { durableOutbox -= 1; } : null });
    },
    /**
     * Write again what a failed write left owed (the 30-second flush, BR-11). → true when something was
     * owed and is written now (the caller publishes again: a reply kept only in memory goes out). Written in
     * the writer's queue (BR-04), it's known once the queue answers: then onWritten() hears it, if it was.
     */
    retryWrites(onWritten = null) {
      if (!owed.size && !stateDirty) return false;
      const had = owed.size > 0;
      if (owed.has('records.json')) store.saveRecords();
      if (owed.has('outbox.jsonl')) store.saveOutbox({ durable: true });
      store.flush();
      if (had && owed.size && writer?.busy?.()) {
        writer.after?.(() => { if (!owed.size) onWritten?.(); });
        return false;
      }
      return had && !owed.size;
    },
    /**
     * fn(), with the outbox written once at its end (code health BR-02: a SavedVariables write's new
     * messages were one durable write each, 50 fsyncs for 50 of them): what fn adds, changes or removes
     * waits in memory until then, and the one write is durable when a new message came in. Its acks
     * still come after it: a slot that carries one is written at a later tick (publisher.mjs). Nested,
     * the outer one writes. Returns fn's result.
     */
    batchOutbox(fn) {
      if (batch) return fn();
      batch = { dirty: false, durable: false };
      try { return fn(); } finally {
        const b = batch;
        batch = null;
        if (b.dirty) store.saveOutbox({ durable: b.durable });
      }
    },

    /** Append a record with the next seq; persists state and records before returning it (without _at). */
    addRecord(rec, at = Date.now()) {
      state.seq += 1;
      const r = { seq: state.seq, ...rec };
      records.push({ ...r, _at: at });
      if (records.length > RECORDS_MAX) records = records.slice(-RECORDS_MAX);
      store.saveRecords();
      store.saveState();
      return r;
    },

    /** Drop the records pred says (a forgotten chat's, "delete all"); persisted. Returns how many. */
    forgetRecords(pred) {
      const before = records.length;
      records = records.filter(r => !pred(r));
      if (records.length !== before) store.saveRecords();
      return before - records.length;
    },

    /**
     * Drop records made before `cutoff` (ms) that every token seen since then has already read (seq
     * at or below each one's lastReported), so a reply the addon hasn't read yet stays; a token not
     * seen since the cutoff (an old install's) holds nothing back. A record from before records
     * carried a time counts as old. Returns how many.
     */
    pruneRecords(cutoff) {
      const read = Object.values(state.tokens).filter(t => (t?.lastSeen ?? 0) >= cutoff).map(t => t?.lastReported ?? 0);
      const upTo = read.length ? Math.min(...read) : state.seq;
      return store.forgetRecords(r => (r._at ?? 0) < cutoff && r.seq <= upTo);
    },

    /** The next push counter, persisted before the push file is raised (PROTOCOL §3.1). */
    nextPush() {
      state.push += 1;
      store.saveState();
      store.flush(); // on disk before a slot carries it: a restart never numbers another publish the same
      return state.push;
    },

    /** Dedupe of keyed records by (token, key) for 7 days. Returns true the first time. */
    firstTime(token, key, now = Date.now()) {
      const k = `${token}:${key}`;
      if (state.dedupe[k]) return false;
      state.dedupe[k] = now;
      store.pruneDedupe(now);
      return true;
    },
    pruneDedupe(now = Date.now()) {
      const entries = Object.entries(state.dedupe);
      if (entries.length <= DEDUPE_MAX && !entries.some(([, t]) => now - t > DEDUPE_MS)) return;
      state.dedupe = Object.fromEntries(entries.filter(([, t]) => now - t <= DEDUPE_MS).sort((a, b) => b[1] - a[1]).slice(0, DEDUPE_MAX));
    },

    /** Remember a published backend message id (dedupe of finals). */
    markPublished(messageId, seq) {
      state.published[messageId] = seq;
      const keys = Object.keys(state.published);
      if (keys.length > PUBLISHED_MAX) for (const k of keys.slice(0, keys.length - PUBLISHED_MAX)) delete state.published[k];
    },
    isPublished(messageId) { return messageId != null && Object.hasOwn(state.published, messageId); },

    /** Remember a run whose reply was published (its final, or what the backend's outcomes() found). */
    markRun(runId, seq) {
      if (!runId) return;
      state.publishedRuns ||= {};
      state.publishedRuns[runId] = seq;
      const keys = Object.keys(state.publishedRuns);
      if (keys.length > PUBLISHED_MAX) for (const k of keys.slice(0, keys.length - PUBLISHED_MAX)) delete state.publishedRuns[k];
    },
    isRunPublished(runId) { return !!runId && !!state.publishedRuns && Object.hasOwn(state.publishedRuns, runId); },

    token(token) {
      return state.tokens[token] || null;
    },

    /** Records to put in the slot file for a token: seq above its last reported cursor. A reply's run stays on the bridge. */
    recordsFor(token) {
      const t = state.tokens[token];
      if (!t) return [];
      return records.filter(r => r.seq > t.lastReported).map(({ _at, run: _run, ...r }) => (r.seq <= t.maxReported ? { ...r, replay: 1 } : r));
    },

    /**
     * A cursor report from the addon (`cur` on any record). A lower value after a crash is honoured.
     * One above the store's own seq means the store started over (or lost its last writes) while the
     * addon kept its cursor: the store catches up first, so nothing it numbers next is at or below it.
     */
    reportCursor(token, cur) {
      const t = state.tokens[token];
      if (!t) return false;
      const c = Number(cur);
      if (!Number.isInteger(c) || c < 0) return false;
      store.catchUp({ seq: c });
      // A cursor from before this token existed on the bridge (a fresh token says cur=0): ignore.
      if (c < t.startSeq) return false;
      const changed = c !== t.lastReported;
      t.lastReported = Math.min(c, state.seq);
      t.maxReported = Math.max(t.maxReported, t.lastReported);
      return changed;
    },

    /**
     * The addon has read up to seq (its cursor) or push (its push counter) from some store: when that's
     * past this store's own, this one moves up to it (logged, and in health()). Returns true if it did.
     */
    catchUp({ seq = null, push = null } = {}) {
      const fits = v => Number.isSafeInteger(v) && v <= COUNTER_MAX;
      const s = fits(seq) && seq > state.seq ? seq : null;
      const p = fits(push) && push > state.push ? push : null;
      if (s === null && p === null) return false;
      const from = { seq: state.seq, push: state.push };
      if (s !== null) state.seq = s;
      if (p !== null) state.push = p;
      behind = { at: now(), from, seq: state.seq, push: state.push };
      log('store-behind', { seqFrom: from.seq, seq: state.seq, pushFrom: from.push, push: state.push, epoch: state.epoch });
      store.saveState();
      store.flush();
      return true;
    },

    addOutbox(item) { outbox.push(item); store.saveOutbox({ durable: true }); },
    updateOutbox(key, patch) {
      const it = outbox.find(o => o.key === key && o.token === patch.token);
      if (it) Object.assign(it, patch);
      store.saveOutbox();
    },
    removeOutbox(token, key) {
      const before = outbox.length;
      outbox = outbox.filter(o => !(o.token === token && o.key === key));
      if (outbox.length !== before) store.saveOutbox();
    },
  };
  if (dirty) { store.saveState(); store.flush(); }
  return store;
}
