// Small shared helpers for the provider layer (PRD §7.1): request-body merging,
// the effort lookup (§7.4), URL joining and system-prompt flattening. Pure
// functions only; no network, no keys.

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Deep-merges plain objects left to right; later scalars and arrays win.
// Never copies prototype-polluting keys.
export function mergeDeep(...parts) {
  const out = {};
  for (const part of parts) {
    if (!isPlain(part)) continue;
    for (const [k, v] of Object.entries(part)) {
      if (UNSAFE_KEYS.has(k) || v === undefined) continue;
      if (isPlain(v)) out[k] = mergeDeep(isPlain(out[k]) ? out[k] : {}, v);
      else if (Array.isArray(v)) out[k] = v.map(x => (isPlain(x) ? mergeDeep(x) : x));
      else out[k] = v;
    }
  }
  return out;
}

// The body every adapter sends: the effort fragment first, the manifest's
// defaults over it (so an effort map can never undo store:false,
// data_collection:'deny' or num_ctx), then the app's own options (the
// player's ZDR switch, a context size they raised), then the adapter's core
// fields.
export function requestBody(defaults, effort, requestOptions, core) {
  return mergeDeep(effort, defaults, requestOptions, core);
}

// Sets one query parameter on a relative route, keeping the others:
// "/models?limit=1000" + after_id → "/models?limit=1000&after_id=b", and
// "/models" + after_id → "/models?after_id=b". A second call replaces the value.
export function withQuery(route, key, value) {
  const s = String(route);
  const i = s.indexOf('?');
  const params = new URLSearchParams(i < 0 ? '' : s.slice(i + 1));
  params.set(key, String(value));
  return `${i < 0 ? s : s.slice(0, i)}?${params}`;
}

// The thinking levels (§7.4, the player's word; "effort" is the AI companies'), cheapest first.
// A model's effort map lists the ones its AI company documents for it, each as the request fields
// that ask for it: "off" only where the model can answer without thinking at all, "minimal" to "max"
// by the company's own names (xhigh is the window's "Extra high").
export const EFFORT_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

// The output room each level adds to a reply's own ceiling (1,200 tokens, §7.5). Every AI here
// counts thinking as output, inside the request's output ceiling, so a level without room would
// think its reply away. It's also the thinking budget a budget-only model is given (Claude Haiku 4.5's
// budget_tokens, which the API needs below max_tokens: the reply's ceiling stays on top), where its
// output ceiling leaves room for that. Extra high and Max (SY-102-6): 32,768 and 65,536, since
// Anthropic advises far more than 16,384 and 32,768 there, and a Max turn with less could stop
// before any text, paid and empty. A request never asks for more than the model's own output
// ceiling (outputCeiling).
export const THINK_ROOM = Object.freeze({ off: 0, minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 32768, max: 65536 });

/**
 * The most a model writes in one reply, thinking included: its list entry's outputTokens (its AI
 * company's documented maximum output), or Infinity where the manifest doesn't say. A request's output
 * ceiling (the reply's and its level's room) is held to it (SY-102-6: Max's room is past Claude Haiku
 * 4.5's 64K).
 */
export function outputCeiling(manifest, model) {
  const list = manifest && typeof manifest === 'object' && Array.isArray(manifest.models?.list) ? manifest.models.list : [];
  const n = list.find(m => m?.id === model)?.outputTokens;
  return Number.isInteger(n) && n > 0 ? n : Infinity;
}

// The effort map is keyed by model id or id prefix ("*" is the fallback);
// the longest matching key wins, so "gpt-6-luna" beats "gpt-6".
export function effortEntry(manifest, model) {
  const map = manifest.effort || {};
  let best = null;
  for (const key of Object.keys(map)) {
    if (key === '*') continue;
    if (model === key || String(model).startsWith(key)) {
      if (!best || key.length > best.length) best = key;
    }
  }
  if (best) return map[best];
  return map['*'] ?? null;
}

// The request fragment for an effort level, or {} when the model has no control.
export function effortFragment(manifest, model, effort) {
  if (!effort) return {};
  const entry = effortEntry(manifest, model);
  return (entry && isPlain(entry[effort])) ? entry[effort] : {};
}

export function hasEffortControl(manifest, model) {
  return effortLevels(manifest, model).length > 0;
}

/** The thinking levels a model offers, cheapest first ([] when it has no control). */
export function effortLevels(manifest, model) {
  const entry = manifest ? effortEntry(manifest, model) : null;
  return entry ? EFFORT_LEVELS.filter(l => isPlain(entry[l])) : [];
}

/**
 * The level a turn goes at when `want` isn't one of the model's (a level saved for another model, a
 * chat's /bones think): the nearest one above it, else the model's highest. So "off" on a model that
 * always thinks is its lowest level, and "max" on one without it is its highest. null with no levels.
 */
export function nearestEffort(levels, want) {
  if (!Array.isArray(levels) || !levels.length) return null;
  if (levels.includes(want)) return want;
  const at = EFFORT_LEVELS.indexOf(want);
  return levels.find(l => EFFORT_LEVELS.indexOf(l) > at) ?? levels[levels.length - 1];
}

/**
 * The output room a turn thinks in on top of its reply's ceiling: its level's (THINK_ROOM), or, for a
 * model that always thinks with no levels, its list entry's thinkRoom; 0 otherwise.
 */
export function thinkRoom(effort, manifest, model) {
  if (effort) return THINK_ROOM[effort] ?? 0;
  const list = manifest && typeof manifest === 'object' && Array.isArray(manifest.models?.list) ? manifest.models.list : [];
  const listed = list.find(m => m?.id === model);
  return Number.isInteger(listed?.thinkRoom) && listed.thinkRoom > 0 ? listed.thinkRoom : 0;
}

// The level a model starts at when the player picks it (DB22; runtime/context.mjs DEFAULT_EFFORT).
export const START_EFFORT = 'low';

/**
 * The thinking room a model turns at when the player picks it: its start level's (Low, or its nearest),
 * or its list entry's thinkRoom for one that always thinks with no levels. The typical cost's thinking
 * allowance is a share of it (usage/meter.mjs typicalCost).
 */
export function startThinkRoom(manifest, model) {
  const listed = (Array.isArray(manifest?.models?.list) ? manifest.models.list : []).find(m => m?.id === model);
  const level = listed?.effort === true ? nearestEffort(effortLevels(manifest, model), START_EFFORT) : null;
  return thinkRoom(level, manifest, model);
}

export function joinUrl(base, path) {
  if (!path) return base;
  return base.replace(/\/+$/, '') + '/' + String(path).replace(/^\/+/, '');
}

export function systemText(system) {
  return (system || []).map(b => (typeof b === 'string' ? b : b?.text)).filter(Boolean).join('\n\n');
}

export function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

// Roughly 4 characters a token (PRD §9.3), plus a few tokens a message for the
// chat template. Used only for the local truncation check.
export function estimateTokens(req) {
  let chars = systemText(req.system).length;
  let msgs = 0;
  for (const m of req.messages || []) { chars += String(m.content ?? '').length; msgs += 1; }
  return Math.ceil(chars / 4) + msgs * 4;
}

export function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
