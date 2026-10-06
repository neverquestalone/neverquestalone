// The run ledger (PRD §6.5, RT-8, DB20): crash safety without a gateway.
// Each turn's idempotency key maps to
//   queued → sending → done | failed | interrupted
// and the entry is on disk before the request goes out: begin() and
// set(key, 'sending') throw (code LEDGER_WRITE_FAILED) when the write fails,
// so the runtime never sends a turn the ledger couldn't record. At startup a
// turn an earlier process left 'sending' may already have been billed, so it
// becomes 'interrupted' and the player decides whether to send it again;
// nothing is ever resent automatically. A turn it left 'queued' never went out,
// so it is reported too (neverSent: true): the runtime may send it (§10 allows
// that under 10 minutes) or mark it failed, so no message goes unanswered.
// 'sending' may step back to 'queued' when the request provably never left
// (DNS, connect or TLS failure; §10 "Network down"). done, failed and
// interrupted are final.
//
// Entries hold metadata only, from an allowed list of keys (META_KEYS): flat
// strings, numbers and booleans. Never prompt text, provider bodies or
// messages (§10: only status, type, code and request id are logged), and a
// string shaped like an API key (§8.4) or longer than 128 characters is
// dropped. The file is written atomically, 0600 (RT-9), and old entries are
// pruned (7 days, like the bridge's dedupe window). A file that can't be read
// or parsed is kept aside (<file>.corrupt-<ms>), never overwritten. Only the
// 'sending' mark is fsynced (files.mjs writeFileDurable); the rest is
// written with a rename alone.
//
// A 'done' entry also says where its reply is and what it cost (code health
// BR-22): replyT, the reply row's time in the chat's transcript, and inTokens,
// outTokens and exact beside outMicros and model, so a reply the core never
// published (a crash between the backend's done and the core's publish) is
// found again by backend.outcomes(), with its cost. An addition only: an older
// build reads these files as before, its cleanMeta leaving the new keys out;
// a 'done' entry an older build wrote has none of them (see backend.mjs
// outcomes for that one reply).
//
// With a writer (code health BR-04, durable writes: the bridge's one ordered
// queue on the slot worker's thread, write-queue.mjs), every write of
// the file is a job in it, in the order made, off the main thread. The 'sending'
// mark is still on disk, fsynced, before anything is sent: set(key, 'sending')
// returns a promise the backend awaits, settled by the write's answer (refused:
// rejected with LEDGER_WRITE_FAILED and the turn as it was, as in place). begin()
// and the other states don't wait: the 'sending' mark that follows them in the
// queue is the write that must land (a refused begin is logged; its turn then
// fails at the mark, before it is sent). The startup report (interruptedAtStartup)
// is written in place, after whatever the queue holds, before it returns: the
// backend books those turns right after, and a crash must never find them booked
// and still 'sending' (booked twice at the next start).
import fs from 'node:fs';
import path from 'node:path';
import { writeFileDurable, writeFileQuick } from '../files.mjs';

export const LEDGER_STATES = Object.freeze(['queued', 'sending', 'done', 'failed', 'interrupted']);
export const META_KEYS = Object.freeze(['chatId', 'provider', 'model', 'kind', 'estMicros', 'outMicros', 'status', 'code', 'type', 'requestId', 'errorKind', 'reason',
  'replyT', 'inTokens', 'outTokens', 'exact']);
const FINAL = new Set(['done', 'failed', 'interrupted']);
// Code health BR-19: the age prune ran only at startup (interruptedAtStartup), so an app left running
// as a login item kept every entry up to the count cap (5,000, about 1 MB rewritten whole 3 times a
// turn). set() prunes by age too, at most once a day, in the write it makes anyway.
export const PRUNE_EVERY_MS = 24 * 3600 * 1000;
const KEY_MAX = 200;
const META_STRING_MAX = 128;
// §8.4's key and token shapes (security/redact.mjs is the full redactor).
const KEY_SHAPES = [
  /sk-ant-[A-Za-z0-9_-]{10,}/, /sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{10,}/, /sk-or-[A-Za-z0-9-]{10,}/, /sk-[A-Za-z0-9]{20,}/,
  /AIza[0-9A-Za-z_-]{35}/, /AQ\.[A-Za-z0-9_-]{20,}/, /xai-[0-9A-Za-z_]{20,}/,
  /\bBearer\s+\S/i, /\bey[A-Za-z0-9_-]{8,}\.ey[A-Za-z0-9_-]{8,}\./, /\bya29\./,
];
const keyShaped = s => KEY_SHAPES.some(re => re.test(s));

/** Keep only allowed metadata keys with flat values: short, key-free strings, finite numbers, booleans, null. */
export function cleanMeta(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const k of META_KEYS) {
    if (!Object.hasOwn(meta, k)) continue;
    const v = meta[k];
    if (typeof v === 'string') {
      if (v.length <= META_STRING_MAX && !keyShaped(v)) out[k] = v;
    } else if (typeof v === 'boolean' || v === null || (typeof v === 'number' && Number.isFinite(v))) out[k] = v;
  }
  return out;
}

function checkKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > KEY_MAX) throw new TypeError('ledger: the key must be a non-empty string');
  return key;
}

// fsCode: the file system's code for why (ENOSPC, EACCES, EROFS…), for the player's line.
function writeFailed(what, fsCode = null) {
  const e = new Error(`ledger: ${what} could not be written to disk, so the turn is not sent`);
  e.code = 'LEDGER_WRITE_FAILED';
  if (fsCode) e.fsCode = fsCode;
  return e;
}

const copy = e => (e ? { ...e, meta: { ...e.meta }, extra: { ...e.extra } } : null);

/**
 * createLedger(file, {now, maxAgeMs, maxEntries, log, pruneEveryMs, writer}) →
 *   begin(key, meta) → {fresh, entry}   fresh:false means the key was seen before; throws if not on disk
 *                                       (with a writer: queued, see above)
 *   set(key, state, extra) → bool       throws for 'sending' if not on disk; with a writer, 'sending'
 *                                       returns a promise of true, rejected if not on disk
 *   get(key) · list({state}) · prune() → removed count
 *   interruptedAtStartup() (alias interrupted()) → entries an earlier process left:
 *     'sending' ones, now 'interrupted'; 'queued' ones, still queued, with neverSent: true
 * file null keeps entries in memory only.
 */
export function createLedger(file, { now = Date.now, maxAgeMs = 7 * 24 * 3600 * 1000, maxEntries = 5000, log = () => {}, pruneEveryMs = PRUNE_EVERY_MS, writer = null } = {}) {
  const clock = () => +now();
  const entries = new Map();
  let persist = !!file;
  if (file) {
    let raw = null;
    let failed = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!raw || typeof raw !== 'object') throw new Error('not an object');
    } catch (e) {
      if (e.code !== 'ENOENT') failed = e.code || 'corrupt';
      raw = null;
    }
    for (const [key, e] of Object.entries(raw?.entries ?? {})) {
      if (!e || !LEDGER_STATES.includes(e.state) || key.length > KEY_MAX) continue;
      entries.set(key, {
        key,
        state: e.state,
        meta: cleanMeta(e.meta),
        extra: cleanMeta(e.extra),
        createdAt: Number.isFinite(e.createdAt) ? e.createdAt : 0,
        updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : 0,
      });
    }
    if (failed) {
      log('ledger_read_failed', { code: failed });
      try {
        fs.renameSync(file, `${file}.corrupt-${clock()}`);
      } catch {
        persist = false; // never overwrite a ledger we could neither read nor move aside
      }
    }
  }
  const mine = new Set(); // keys this process began: never "left by an earlier process"
  const live = new Set(); // keys this process moved to 'sending'
  const reported = new Set(); // earlier 'queued' entries already reported

  // durable: fsynced (the 'sending' mark, on disk before a request that may be billed leaves);
  // everything else is written without (systems plan Batch 4): lost to a power cut, a 'queued' or
  // 'done' reads as it was before, and a turn left 'sending' is reported, never resent.
  let lastWriteCode = null; // why the last write failed (for writeFailed's fsCode)
  // → true (written now), false (not: lastWriteCode says why), or null: queued in the writer, and
  // answered(ok, code) hears it. inPlace: now, after whatever the writer still holds.
  function save({ durable = false, inPlace = false, answered = null } = {}) {
    if (!file) return true;
    if (!persist) { lastWriteCode = null; return false; }
    const data = JSON.stringify({ v: 1, entries: Object.fromEntries(entries) }) + '\n';
    if (writer && !inPlace) {
      const queued = writer.writeFile?.({ file, data, durable, mode: 0o600, mkdir: true }, (res) => {
        if (!res?.ok) log('ledger_write_failed', { code: res?.code || 'error' });
        answered?.(!!res?.ok, res?.code ?? null);
      });
      if (queued) return null;
    }
    if (writer && inPlace) writer.drain?.();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      (durable ? writeFileDurable : writeFileQuick)(file, data, 0o600);
      return true;
    } catch (e) {
      lastWriteCode = e.code || null;
      log('ledger_write_failed', { code: e.code || 'error' });
      return false;
    }
  }

  let prunedAt = clock(); // the last prune (startup's: interruptedAtStartup)
  function prune() {
    prunedAt = clock();
    const cutoff = prunedAt - maxAgeMs;
    let removed = 0;
    for (const [key, e] of entries) {
      // A 'sending' entry waits for interruptedAtStartup(); live ones are running now.
      if (e.state === 'sending') continue;
      if (e.updatedAt < cutoff) { entries.delete(key); live.delete(key); removed++; }
    }
    if (entries.size > maxEntries) {
      const oldest = [...entries.values()].filter(e => FINAL.has(e.state)).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const e of oldest) {
        if (entries.size <= maxEntries) break;
        entries.delete(e.key);
        removed++;
      }
    }
    return removed;
  }

  function begin(key, meta = {}) {
    checkKey(key);
    const seen = entries.get(key);
    if (seen) return { fresh: false, entry: copy(seen) };
    const t = clock();
    const entry = { key, state: 'queued', meta: cleanMeta(meta), extra: {}, createdAt: t, updatedAt: t };
    entries.set(key, entry);
    if (entries.size > maxEntries) prune();
    if (save() === false) {
      entries.delete(key);
      throw writeFailed('the turn', lastWriteCode);
    }
    mine.add(key);
    return { fresh: true, entry: copy(entry) };
  }

  function set(key, state, extra = {}) {
    if (!LEDGER_STATES.includes(state)) throw new TypeError(`ledger: unknown state ${state}`);
    const e = entries.get(checkKey(key));
    if (!e || FINAL.has(e.state)) return false;
    const before = { state: e.state, updatedAt: e.updatedAt, extra: e.extra };
    const wasLive = live.has(key);
    e.state = state;
    e.updatedAt = clock();
    e.extra = cleanMeta({ ...e.extra, ...cleanMeta(extra) });
    if (state === 'sending') live.add(key);
    else live.delete(key);
    if (clock() - prunedAt >= pruneEveryMs) prune(); // once a day, with this write (BR-19)
    const stamp = e.updatedAt;
    const stepBack = () => {
      // Unless it changed since (only when the mark was queued): as it was before.
      if (e.state !== 'sending' || e.updatedAt !== stamp) return;
      Object.assign(e, before);
      if (!wasLive) live.delete(key);
    };
    if (state === 'sending') {
      let heard;
      const answer = new Promise((resolve) => { heard = resolve; });
      const r = save({ durable: true, answered: (ok, code) => heard({ ok, code }) });
      if (r === null) {
        return answer.then(({ ok, code }) => {
          if (ok) return true;
          stepBack();
          throw writeFailed("the turn's 'sending' mark", code);
        });
      }
      if (!r) {
        stepBack();
        throw writeFailed("the turn's 'sending' mark", lastWriteCode);
      }
      return true;
    }
    // Any other state that fails to reach disk stays right in memory; after a
    // crash the turn reads as interrupted, which never double-bills.
    save();
    return true;
  }

  /** What an earlier process left: 'sending' entries become 'interrupted'; 'queued' ones come back neverSent. Each once. */
  function interruptedAtStartup() {
    const t = clock();
    const out = [];
    let changed = false;
    for (const e of entries.values()) {
      if (mine.has(e.key) || live.has(e.key) || reported.has(e.key)) continue;
      if (e.state === 'sending') {
        e.state = 'interrupted';
        e.updatedAt = t;
        e.extra = cleanMeta({ ...e.extra, reason: 'restart' });
        out.push(copy(e));
        changed = true;
      } else if (e.state === 'queued') {
        reported.add(e.key);
        out.push({ ...copy(e), neverSent: true });
      }
    }
    const removed = prune();
    if (changed || removed) save({ inPlace: true });
    return out;
  }

  return {
    begin,
    set,
    get: key => copy(entries.get(key)),
    list: ({ state } = {}) => [...entries.values()].filter(e => !state || e.state === state).map(copy),
    interruptedAtStartup,
    interrupted: interruptedAtStartup, // BUILD-PLAN name
    prune() { const n = prune(); if (n) save(); return n; },
    get size() { return entries.size; },
  };
}
