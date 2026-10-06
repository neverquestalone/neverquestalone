// The model check's notice in the window (BYOK PRD §10 "Model not found", PV-3; BUILD-PLAN
// "Contract: the app API": status().backend.notice).
//
// At start the bridge checks the chosen model against the provider's list. When it's gone, the
// backend switches to an equal or cheaper one ({kind: 'model_switched', from, to, at}) or stops
// ({kind: 'model_retired', model, at}). A switch is said once: a plain line with Okay, never a
// timed toast. Okay records the notice's id in the shell's settings file (app-state.json), and
// from then on the status the window gets has no notice for it, across restarts; a new switch
// is a new id and shows again. A retired model is a state, not news: Bones can't answer until
// the player picks another model, so it's never put away (the window's state card, D-01); the
// backend drops it once a model is chosen.
//
// A model whose company announced its retirement (systems critic SY-102-5; the manifest's
// retiresAfter and moveTo) is news before the day: {kind: 'model_retiring', model, after, to}, said
// by the bridge while that model is the one in use. It's put away with Okay like a switch (its id
// is over the model, the day and the model offered, so a new day shows again), and it goes by
// itself once another model is picked.
//
// The main process decorates every status it hands the page: an unseen notice gets its id, a
// seen one is removed. The page never computes ids, so it can only dismiss what it was shown.
// A one-off failure notice (backend.lastError with notice: true; D-33) is kept the same way, so
// its Okay survives the window closing (D-35).
import crypto from 'node:crypto';
import { importBridge } from './bridge-module.mjs';

// The one vocabulary (bridge/byok/status-view.mjs): a status that comes without its view (the
// development mock, the "couldn't start" stand-in) gets it here, so every status the window gets
// carries one.
const { statusView } = await importBridge('bridge/byok/status-view.mjs');

export const NOTICE_KINDS = Object.freeze(['model_switched', 'model_retired', 'model_retiring']);
export const NOTICE_ID = /^[0-9a-f]{16}$/;
export const MAX_SEEN = 20;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const model = v => (typeof v === 'string' && MODEL.test(v) ? v : null);
// A model's name from the bridge (the manifest's label): short plain text, or nothing (UX-W35).
const NAME_BAD = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>]/;
const name = v => (typeof v === 'string' && v.length > 0 && v.length <= 60 && !NAME_BAD.test(v) ? v : null);

/** The notice as the window may show it (known kind, model ids of the right shape, names as plain text), or null. */
export function cleanNotice(n) {
  if (!isObj(n) || !NOTICE_KINDS.includes(n.kind)) return null;
  const at = Number.isFinite(n.at) ? n.at : null;
  if (n.kind === 'model_switched') {
    const from = model(n.from);
    const to = model(n.to);
    if (!from || !to) return null;
    const out = { kind: n.kind, from, to, at };
    if (name(n.fromName)) out.fromName = name(n.fromName);
    if (name(n.toName)) out.toName = name(n.toName);
    return out;
  }
  if (n.kind === 'model_retiring') {
    const m = model(n.model);
    const to = model(n.to);
    if (!m || !to || m === to || typeof n.after !== 'string' || !DAY.test(n.after)) return null;
    const out = { kind: n.kind, model: m, after: n.after, to, at: null };
    if (name(n.name)) out.name = name(n.name);
    if (name(n.toName)) out.toName = name(n.toName);
    return out;
  }
  const retired = model(n.model) ?? model(n.from);
  if (!retired) return null;
  return name(n.name) ? { kind: n.kind, model: retired, at, name: name(n.name) } : { kind: n.kind, model: retired, at };
}

/** A notice's id: the first 16 hex of sha256 over what it says (kind, models, time; a retirement's day). */
export function noticeId(n) {
  const c = cleanNotice(n);
  if (!c) return null;
  const text = JSON.stringify(c.kind === 'model_retiring' ? [c.kind, c.model, c.after, c.to] : [c.kind, c.from ?? null, c.to ?? null, c.model ?? null, c.at]);
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * A one-off failure notice's id (desktop UI critic D-33, D-35): the first 16 hex of sha256 over its
 * kind and time, so Okay on it is kept like a model notice's, and a new failure (a new time) shows.
 */
export function lastErrorId(le) {
  if (!isObj(le) || typeof le.kind !== 'string' || !/^[a-z_]{1,40}$/.test(le.kind)) return null;
  const at = Number.isFinite(le.at) ? le.at : null;
  return crypto.createHash('sha256').update(JSON.stringify(['last_error', le.kind, at])).digest('hex').slice(0, 16);
}

/**
 * The status the window gets: backend.notice with its id when it hasn't been seen, and no
 * notice at all when it has (or when it isn't one the window knows). A retired model's notice
 * stays whatever was seen: it holds until a model is chosen. A one-off failure (backend.lastError
 * with notice: true) gets its id the same way and is left out once seen (D-35); a failure that's a
 * state (no notice flag) always stays. A status without a view (status-view.mjs) gets one; putting a
 * notice away never changes it (a switch or a one-off failure is never the view's key). Never
 * mutates status.
 */
export function withNotice(status, seen = [], { platform = process.platform } = {}) {
  if (!isObj(status) || !isObj(status.backend)) return status;
  const out = noticed(status, seen);
  return isObj(out.view) ? out : { ...out, view: statusView(out, { platform }) };
}

function noticed(status, seen) {
  let out = status;
  const le = status.backend.lastError;
  if (isObj(le) && le.notice === true) {
    const id = lastErrorId(le);
    const { lastError, ...rest } = out.backend;
    out = { ...out, backend: id && !seen.includes(id) ? { ...rest, lastError: { ...lastError, id } } : rest };
  }
  if (!Object.hasOwn(out.backend, 'notice')) return out;
  const { notice, ...backend } = out.backend;
  const c = cleanNotice(notice);
  const id = c ? noticeId(c) : null;
  if (!c || (c.kind !== 'model_retired' && seen.includes(id))) return { ...out, backend };
  return { ...out, backend: { ...backend, notice: { ...c, id } } };
}

/** Add an id to the seen list: once, newest last, at most MAX_SEEN kept. */
export function addSeen(list, id) {
  const cur = Array.isArray(list) ? list.filter(x => typeof x === 'string' && NOTICE_ID.test(x) && x !== id) : [];
  if (NOTICE_ID.test(String(id))) cur.push(id);
  return cur.slice(-MAX_SEEN);
}
