// Usage history (public BYOK PRD §9.2 "Totals": per day in local time and per provider, with a
// 30-day history in the app; US-1, US-7; BUILD-PLAN app API usage({days})): the one store of daily
// totals (systems plan D6), which the app shows and caps.mjs checks a cap the player set against.
//
// One row per turn that counted (a reply, or a failure the provider may have billed), kept in
// <dataDir>/usage-history.json: per local day {micros, turns, auto, estimated, byProvider: {<id>:
// {micros, turns, auto}}} (a day's turns are the typed ones and auto the automatic ones; estimated,
// how many were counted at an estimate, not a price the provider reported; a provider's turns are all
// of its turns and auto the automatic ones among them), and the last 50 turns {at, chatId, provider,
// model, in, out, micros, exact[, error]}.
// Numbers and ids only: never prompt, reply or error text. Written with a rename (0600), pruned to 90
// days. A file that can't be read or parsed is kept aside (<file>.corrupt-<ms>) and history starts
// over (loadError and keptAs say so: today's spend isn't known then, which caps.mjs holds to).
// "Delete usage history" keeps today's totals, which a cap the player set counts against.
//
//   createUsageHistory({file, now, log}) → { record(row), view({days}), day(d), days(), prune(),
//                                            clear(), loadError, keptAs }
import fs from 'node:fs';
import path from 'node:path';
import { writeFileQuick } from '../../files.mjs';

const pad2 = n => String(n).padStart(2, '0');
/** "YYYY-MM-DD" for the local calendar day holding `ms`. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export const KEEP_DAYS = 90;
export const RECENT_MAX = 50;
export const DEFAULT_DAYS = 30;
const DAY_MS = 86400000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,99}$/; // provider and model ids (OpenRouter's have / and :)
const CHAT_ID_RE = /^c[0-9a-f]{6}$/;
const KIND_RE = /^[a-z_]{1,32}$/;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const count = v => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
const id = v => (typeof v === 'string' && ID_RE.test(v) ? v : null);

/** A row as stored: whole numbers and checked ids only (anything else is dropped). */
export function cleanRow(r = {}) {
  const at = Number.isFinite(r.at) && r.at > 0 ? Math.floor(r.at) : null;
  if (at === null) return null;
  const out = {
    at,
    chatId: typeof r.chatId === 'string' && CHAT_ID_RE.test(r.chatId) ? r.chatId : null,
    provider: id(r.provider) ?? 'unknown',
    model: id(r.model) ?? '',
    in: count(r.in),
    out: count(r.out),
    micros: count(r.micros),
    exact: r.exact === true,
  };
  if (r.auto === true) out.auto = true;
  if (typeof r.error === 'string' && KIND_RE.test(r.error)) out.error = r.error;
  return out;
}

// byProvider maps have no prototype: a provider id like "constructor" is a key, never Object's own.
function zeroDay() { return { micros: 0, turns: 0, auto: 0, estimated: 0, byProvider: Object.create(null) }; }

function parseDays(raw) {
  const days = {};
  if (!isObj(raw)) return days;
  for (const [day, d] of Object.entries(raw)) {
    if (!DAY_RE.test(day) || !isObj(d)) continue;
    const z = { micros: count(d.micros), turns: count(d.turns), auto: count(d.auto), estimated: count(d.estimated), byProvider: Object.create(null) };
    if (isObj(d.byProvider)) {
      for (const [pid, v] of Object.entries(d.byProvider)) {
        if (id(pid) && isObj(v)) z.byProvider[pid] = { micros: count(v.micros), turns: count(v.turns), auto: Math.min(count(v.auto), count(v.turns)) };
      }
    }
    days[day] = z;
  }
  return days;
}

/** The local calendar days from `n - 1` days before `ms` to its own, oldest first. */
export function dayRange(ms, n) {
  const out = [];
  const d = new Date(ms);
  d.setHours(12, 0, 0, 0); // noon: a daylight-saving shift never skips or repeats a day
  for (let i = n - 1; i >= 0; i--) out.push(localDay(d.getTime() - i * DAY_MS));
  return out;
}

/**
 * createUsageHistory({file, now, log}). file null keeps it in memory only.
 *   record({at?, chatId, provider, model, in, out, micros, exact, auto?, error?}) → the row kept
 *   view({days = 30}) → { days: [{day, micros, turns, auto, byProvider}], recent: [row, …] }
 *     days: every local day of the window, oldest first (0 where nothing counted), at most 90;
 *     recent: the last 50 turns, newest first
 */
export function createUsageHistory({ file = null, now = Date.now, log = () => {} } = {}) {
  const clock = () => +now();
  let days = {};
  let recent = [];
  let persist = !!file;
  let loadError = null;
  let keptAs = null;
  if (file) {
    let text = null;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') loadError = e.code || 'unreadable'; }
    if (text !== null) {
      try {
        const raw = JSON.parse(text);
        if (!isObj(raw)) throw new Error('not an object');
        days = parseDays(raw.days);
        recent = (Array.isArray(raw.recent) ? raw.recent : []).map(cleanRow).filter(Boolean).slice(0, RECENT_MAX);
      } catch {
        loadError = 'corrupt';
      }
    }
    if (loadError) {
      log('usage-history-read-failed', { code: loadError });
      try { keptAs = `${file}.corrupt-${clock()}`; fs.renameSync(file, keptAs); } catch { keptAs = null; persist = false; }
    }
  }

  function prune() {
    const cutoff = localDay(clock() - KEEP_DAYS * DAY_MS);
    let n = 0;
    for (const day of Object.keys(days)) if (day < cutoff) { delete days[day]; n += 1; }
    const oldest = clock() - KEEP_DAYS * DAY_MS;
    const before = recent.length;
    recent = recent.filter(r => r.at >= oldest);
    return n + (before - recent.length);
  }

  function save() {
    if (!file || !persist) return false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileQuick(file, JSON.stringify({ v: 1, days, recent }) + '\n', 0o600);
      return true;
    } catch (e) {
      log('usage-history-write-failed', { code: e.code || 'error' });
      return false;
    }
  }

  function dayView(d) {
    const x = days[d] ?? zeroDay();
    return { ...x, byProvider: Object.fromEntries(Object.entries(x.byProvider).map(([k, v]) => [k, { ...v }])) };
  }

  return {
    record(r = {}) {
      const row = cleanRow({ at: clock(), ...r });
      if (!row) return null;
      const day = localDay(row.at);
      const d = (days[day] ??= zeroDay());
      d.micros += row.micros;
      if (row.auto) d.auto += 1; else d.turns += 1;
      if (!row.exact) d.estimated += 1;
      const bp = (d.byProvider[row.provider] ??= { micros: 0, turns: 0, auto: 0 });
      bp.micros += row.micros;
      bp.turns += 1;
      if (row.auto) bp.auto = (bp.auto || 0) + 1;
      recent = [row, ...recent].slice(0, RECENT_MAX);
      prune();
      save();
      return { ...row };
    },
    view({ days: n = DEFAULT_DAYS } = {}) {
      const want = Math.max(1, Math.min(KEEP_DAYS, Number.isInteger(n) ? n : DEFAULT_DAYS));
      const list = dayRange(clock(), want).map((day) => {
        const d = days[day] ?? zeroDay();
        return { day, micros: d.micros, turns: d.turns, auto: d.auto,
          byProvider: Object.fromEntries(Object.entries(d.byProvider).map(([k, v]) => [k, { ...v }])) };
      });
      return { days: list, recent: recent.map(r => ({ ...r })) };
    },
    /** One local day's totals ({micros, turns, auto, estimated, byProvider}), zeros for a day with none. */
    day: (d = localDay(clock())) => dayView(d),
    /** Every day kept, newest first: [{day, micros, turns, auto, estimated, byProvider}]. */
    days: () => Object.keys(days).sort((a, b) => (a < b ? 1 : -1)).map(d => ({ day: d, ...dayView(d) })),
    prune() { const n = prune(); if (n) save(); return n; },
    /** Forget it (the app's "delete usage history"): every row, and every day but today's totals, which a cap counts against. */
    clear() {
      const today = localDay(clock());
      days = days[today] ? { [today]: days[today] } : {};
      recent = [];
      save();
      return true;
    },
    /** Why the file couldn't be read at start (today's spend isn't known), until acknowledged. */
    get loadError() { return loadError; },
    get keptAs() { return keptAs; },
    acknowledgeLoadError() { const had = loadError !== null; loadError = null; return had; },
  };
}
