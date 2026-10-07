// Price lookup for BYOK metering and caps (PRD §9.2, §9.4, US-2). The bundled
// table is prices.json: a dated snapshot in USD per 1M tokens, pruned to the
// manifests' models (tools/gen-prices.mjs rebuilds it from models.dev). A
// refreshed table can come from the signed data file (§11.5), and a bad one
// can't turn the cap off:
//   - the cap uses the higher of the two prices for every model both list;
//   - a model only the refresh lists is priced no lower than its provider's
//     cheapest bundled model (a typo can't make it nearly free);
//   - the provider flags that lower a cost (local, exact, reasoningInOutput)
//     come from the bundled table only;
//   - validateTable refuses a cloud model priced $0/$0 (OpenRouter's :free
//     models and openrouter/free excepted).
// A model with no known price counts at its provider's most expensive listed
// model and is marked known:false (the HUD labels it an estimate). OpenRouter
// replies carry their exact cost (usage.cost), so its prices only size
// reservations: they come from our tables for the vendors we know, and an
// explicit high ceiling ("unlisted") for anything else.
//
// A resolved price is flat and explicit, which is what meter.mjs expects:
//   { provider, model, input, output, cacheRead, cacheWrite, cacheWrite1h,
//     reasoning, known, local, exact, reasoningInOutput, blockedRequestFee }
// Long-context tiers (a table's `tiers`, from minInput prompt tokens up) never apply: no request
// reaches them, since the per-turn ceiling (caps.mjs, at most TIER_REACH input tokens) trims every
// request first, and the dearest real tier starts at 128k (systems plan D6). A tier that starts at
// or below TIER_REACH could be reached, so it's folded into the base price, field by field at the
// higher of the two: a price only ever errs high.
// cacheWrite is the default-TTL write (Anthropic 5 min, OpenAI's only write
// price); a missing read or write price bills at the input price and a missing
// reasoning price at the output price, so gaps never make a turn cheaper.
// blockedRequestFee is USD per request (xAI charges $0.05 for a request it
// blocks before generation).
import fs from 'node:fs';

export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite5m', 'cacheWrite1h', 'reasoning'];
/** The most input tokens a turn can send (caps.mjs CAP_DEFAULTS.perTurnInput's ceiling): tiers past it can't apply. */
export const TIER_REACH = 20000;
const OUT_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning'];
// OpenRouter model ids are "<vendor>/<model>"; these vendors map to our tables.
const OPENROUTER_VENDORS = { anthropic: 'anthropic', openai: 'openai', google: 'google', 'x-ai': 'xai', xai: 'xai' };
// Used only if the bundled table names no OpenRouter ceiling: well above the
// dearest first-party models we know ($10/$50: Fable 5.1, gpt-6-astra).
const DEFAULT_UNLISTED = Object.freeze({ input: 15, output: 75 });
const BUNDLED = new URL('./prices.json', import.meta.url);

const isPrice = v => Number.isFinite(v) && v >= 0;
const own = (o, k) => o != null && typeof o === 'object' && Object.hasOwn(o, k);
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v);

/** OpenRouter's legitimately free models: the :free variants and the openrouter/free router. */
export const isOpenRouterFreeId = id => typeof id === 'string' && (id === 'openrouter/free' || id.endsWith(':free'));

function checkFields(o, where) {
  for (const f of PRICE_FIELDS) {
    if (o[f] !== undefined && !isPrice(o[f])) throw new Error(`price table: ${where}.${f} is not a price`);
  }
}

function checkTiers(tiers, where) {
  if (tiers === undefined) return;
  if (!Array.isArray(tiers)) throw new Error(`price table: ${where}.tiers is not a list`);
  for (const t of tiers) {
    if (!t || !Number.isInteger(t.minInput) || t.minInput <= 0) throw new Error(`price table: ${where} has a tier without minInput`);
    checkFields(t, `${where}.tiers[${t.minInput}]`);
  }
}

function checkProvider(pid, p) {
  for (const f of ['local', 'exact', 'reasoningInOutput']) {
    if (p[f] !== undefined && typeof p[f] !== 'boolean') throw new Error(`price table: ${pid}.${f} is not true or false`);
  }
  if (p.blockedRequestFee !== undefined && !isPrice(p.blockedRequestFee)) throw new Error(`price table: ${pid}.blockedRequestFee is not a price`);
  if (p.unlisted !== undefined) {
    if (!isObj(p.unlisted) || !isPrice(p.unlisted.input) || !isPrice(p.unlisted.output) || p.unlisted.input + p.unlisted.output <= 0) {
      throw new Error(`price table: ${pid}.unlisted needs input and output prices above $0`);
    }
    checkFields(p.unlisted, `${pid}.unlisted`);
  }
  if (p.writeMultipliers !== undefined) {
    if (!isObj(p.writeMultipliers)) throw new Error(`price table: ${pid}.writeMultipliers is not an object`);
    for (const [k, v] of Object.entries(p.writeMultipliers)) {
      if (!['cacheWrite', 'cacheWrite5m', 'cacheWrite1h'].includes(k) || !Number.isFinite(v) || v < 1) throw new Error(`price table: ${pid}.writeMultipliers.${k} is not a multiplier of at least 1`);
    }
  }
}

/** Throws if a cloud model is ever $0/$0: at base, in a tier, or after a scheduled change. */
function checkNotFree(m, where) {
  const zero = (i, o) => i === 0 && o === 0;
  if (zero(m.input, m.output)) throw new Error(`price table: ${where} is priced $0 but isn't a local or free model`);
  for (const t of m.tiers ?? []) {
    if (zero(t.input ?? m.input, t.output ?? m.output)) throw new Error(`price table: ${where}.tiers[${t.minInput}] is priced $0`);
  }
  let input = m.input;
  let output = m.output;
  for (const c of [...(m.changes ?? [])].sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    input = c.input ?? input;
    output = c.output ?? output;
    if (zero(input, output)) throw new Error(`price table: ${where}.changes[${c.from}] is priced $0`);
  }
}

/**
 * Throws unless `t` is a usable price table; returns it. `localProviders`
 * (a Set) says which providers are local; by default the table's own flags do.
 */
export function validateTable(t, { localProviders = null } = {}) {
  if (!t || typeof t !== 'object' || !isObj(t.providers)) throw new Error('price table: no providers');
  for (const [pid, p] of Object.entries(t.providers)) {
    if (!isObj(p)) throw new Error(`price table: provider ${pid} is not an object`);
    checkProvider(pid, p);
    const local = localProviders ? localProviders.has(pid) : p.local === true;
    const models = p.models ?? {};
    if (!isObj(models)) throw new Error(`price table: ${pid}.models is not an object`);
    for (const [mid, m] of Object.entries(models)) {
      const where = `${pid}/${mid}`;
      if (!isObj(m)) throw new Error(`price table: ${where} is not an object`);
      if (!isPrice(m.input) || !isPrice(m.output)) throw new Error(`price table: ${where} needs input and output prices`);
      checkFields(m, where);
      checkTiers(m.tiers, where);
      if (m.changes !== undefined) {
        if (!Array.isArray(m.changes)) throw new Error(`price table: ${where}.changes is not a list`);
        for (const c of m.changes) {
          if (!c || !Number.isFinite(Date.parse(c.from))) throw new Error(`price table: ${where} has a change without a valid "from"`);
          checkFields(c, `${where}.changes[${c.from}]`);
          checkTiers(c.tiers, `${where}.changes[${c.from}]`);
        }
      }
      if (!local && !(pid === 'openrouter' && isOpenRouterFreeId(mid))) checkNotFree(m, where);
    }
  }
  return t;
}

/** Read and validate a price table (default: the bundled prices.json). */
export function loadPriceTable(file = BUNDLED) {
  return validateTable(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const toMs = at => {
  const ms = at == null ? Date.now() : +(at instanceof Date ? at : new Date(at));
  if (!Number.isFinite(ms)) throw new TypeError('prices: bad date');
  return ms;
};

/** Make every price explicit: defaults for missing read/write/reasoning; a reachable tier folded in. Idempotent. */
export function effectivePrice(p) {
  if (!p || !isPrice(p.input) || !isPrice(p.output)) throw new TypeError('prices: a price needs input and output');
  const flat = q => {
    const cacheWrite = q.cacheWrite5m ?? q.cacheWrite ?? q.input;
    return {
      input: q.input,
      output: q.output,
      cacheRead: q.cacheRead ?? q.input,
      cacheWrite,
      cacheWrite1h: q.cacheWrite1h ?? cacheWrite,
      reasoning: q.reasoning ?? q.output,
    };
  };
  const base = flat(p);
  for (const t of p.tiers ?? []) {
    if (!(Number.isFinite(t?.minInput) && t.minInput <= TIER_REACH)) continue;
    const q = flat({ ...t, input: t.input ?? p.input, output: t.output ?? p.output });
    for (const f of OUT_FIELDS) base[f] = Math.max(base[f], q[f]);
  }
  return {
    provider: p.provider ?? null,
    model: p.model ?? null,
    ...base,
    known: p.known !== false,
    local: !!p.local,
    exact: !!p.exact,
    reasoningInOutput: p.reasoningInOutput === true,
    blockedRequestFee: isPrice(p.blockedRequestFee) ? p.blockedRequestFee : 0,
  };
}

/** A table entry as it stands at `atMs`: scheduled changes applied in order. */
function resolveEntry(entry, atMs) {
  const out = {};
  for (const f of PRICE_FIELDS) if (entry[f] !== undefined) out[f] = entry[f];
  if (entry.tiers) out.tiers = entry.tiers;
  const changes = [...(entry.changes ?? [])].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  for (const c of changes) {
    if (Date.parse(c.from) > atMs) break;
    for (const f of PRICE_FIELDS) if (c[f] !== undefined) out[f] = c[f];
    if (c.tiers) out.tiers = c.tiers;
  }
  return out;
}

/** Fill cache-write prices a model doesn't list from its provider's multipliers (Anthropic 1.25x and 2x). */
function fillWrites(e, mult) {
  if (!mult) return e;
  const fill = (q, input) => {
    const out = { ...q };
    if (out.cacheWrite5m === undefined && out.cacheWrite === undefined && mult.cacheWrite5m) out.cacheWrite5m = input * mult.cacheWrite5m;
    if (out.cacheWrite === undefined && out.cacheWrite5m === undefined && mult.cacheWrite) out.cacheWrite = input * mult.cacheWrite;
    if (out.cacheWrite1h === undefined && mult.cacheWrite1h) out.cacheWrite1h = input * mult.cacheWrite1h;
    return out;
  };
  const out = fill(e, e.input);
  if (e.tiers) out.tiers = e.tiers.map(t => fill(t, t.input ?? e.input));
  return out;
}

/** Exact id, else the id without a date suffix ("claude-haiku-4-5-20251001"). */
function findModel(models, model) {
  if (!models || model == null) return null;
  const id = String(model);
  if (own(models, id)) return { id, entry: models[id] };
  const bare = id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '').replace(/-latest$/, '');
  if (bare !== id && own(models, bare)) return { id: bare, entry: models[bare] };
  return null;
}

const zeroPrice = (provider, model, extra) => effectivePrice({ provider, model, input: 0, output: 0, ...extra });
// Other speaks Chat Completions, whose completion_tokens already hold the reasoning (OpenAI's usage shape:
// completion_tokens_details.reasoning_tokens is a part of it, as DeepSeek, OpenRouter and LM Studio report
// it), so its reasoning never counts on top. A flag that lowers a cost, set here in code, never by a table.
const REASONING_IN_OUTPUT = new Set(['custom']);
/** A model on a server on this computer (Other at localhost): $0, marked local, whatever its provider id. */
export const localPrice = (provider, model) => zeroPrice(provider, model ?? null, { local: true, reasoningInOutput: REASONING_IN_OUTPUT.has(provider) });

/** The higher of two resolved prices, field by field; null-safe. */
export function higherOf(a, b) {
  if (!a || !b) return a || b ? effectivePrice(a || b) : null;
  const x = effectivePrice(a);
  const y = effectivePrice(b);
  const out = { ...x };
  for (const f of OUT_FIELDS) out[f] = Math.max(x[f], y[f]);
  out.known = x.known && y.known;
  out.local = x.local && y.local;
  out.exact = x.exact || y.exact;
  out.reasoningInOutput = x.reasoningInOutput && y.reasoningInOutput;
  out.blockedRequestFee = Math.max(x.blockedRequestFee, y.blockedRequestFee);
  return out;
}

/** The lower of the base prices, field by field. */
function lowerOf(prices) {
  let low = null;
  for (const p of prices) {
    const x = effectivePrice(p);
    if (!low) { low = { input: x.input, output: x.output, cacheRead: x.cacheRead, cacheWrite: x.cacheWrite, cacheWrite1h: x.cacheWrite1h, reasoning: x.reasoning }; continue; }
    for (const f of OUT_FIELDS) low[f] = Math.min(low[f], x[f]);
  }
  return low;
}

function maxOver(prices, provider, model) {
  let worst = null;
  for (const p of prices) worst = higherOf(worst, p);
  return worst ? { ...worst, provider, model, known: false } : null;
}

/**
 * A price book over the bundled table and an optional refreshed one.
 * priceFor(provider, model, at) · worstPriceFor(provider, at) · setRefreshed(table) → bool · isLocal(provider)
 */
export function createPriceBook({ bundled = loadPriceTable(), refreshed = null } = {}) {
  validateTable(bundled);
  const bundledProvider = id => (own(bundled.providers, id) ? bundled.providers[id] : null);
  const LOCAL = new Set(Object.entries(bundled.providers).filter(([, p]) => p.local === true).map(([id]) => id));
  const unlisted = bundledProvider('openrouter')?.unlisted ?? DEFAULT_UNLISTED;
  let fresh = null;
  const setRefreshed = t => {
    if (!t) { fresh = null; return true; }
    try { fresh = validateTable(t, { localProviders: LOCAL }); return true; } catch { fresh = null; return false; }
  };
  setRefreshed(refreshed);
  const freshProvider = id => (fresh && own(fresh.providers, id) ? fresh.providers[id] : null);
  const isLocal = provider => LOCAL.has(provider);

  // Flags that lower a cost come from the bundled table only; the xAI fee can only go up.
  function flags(provider) {
    const b = bundledProvider(provider) ?? {};
    const f = freshProvider(provider) ?? {};
    return {
      local: LOCAL.has(provider),
      exact: b.exact === true,
      reasoningInOutput: b.reasoningInOutput === true || REASONING_IN_OUTPUT.has(provider),
      blockedRequestFee: Math.max(isPrice(b.blockedRequestFee) ? b.blockedRequestFee : 0, isPrice(f.blockedRequestFee) ? f.blockedRequestFee : 0),
    };
  }
  const withFlags = (p, fl) => ({
    ...p,
    local: false,
    exact: fl.exact,
    reasoningInOutput: fl.reasoningInOutput,
    blockedRequestFee: Math.max(p.blockedRequestFee ?? 0, fl.blockedRequestFee),
  });

  const entryPrice = (provider, entry, atMs, model) =>
    effectivePrice({ ...fillWrites(resolveEntry(entry, atMs), bundledProvider(provider)?.writeMultipliers), provider, model });

  const nonZero = p => p.input > 0 || p.output > 0;
  function bundledListed(provider, atMs) {
    const p = bundledProvider(provider);
    return Object.entries(p?.models ?? {}).map(([id, e]) => entryPrice(provider, e, atMs, id));
  }
  function cloudProviders() {
    const ids = new Set();
    for (const t of fresh ? [bundled, fresh] : [bundled]) for (const id of Object.keys(t.providers)) if (!isLocal(id) && id !== 'openrouter') ids.add(id);
    return [...ids];
  }

  /** The floor for a model only the refresh lists: its provider's cheapest bundled model, else the cheapest cloud one. */
  function floorFor(provider, atMs) {
    let pool = bundledListed(provider, atMs).filter(nonZero);
    if (!pool.length) pool = cloudProviders().flatMap(id => bundledListed(id, atMs)).filter(nonZero);
    return pool.length ? lowerOf(pool) : { ...unlisted };
  }

  /** Prices for provider/model from both tables (the refresh floored when the bundle lacks the model). */
  function direct(provider, model, atMs) {
    const out = [];
    const b = findModel(bundledProvider(provider)?.models, model);
    if (b) out.push(entryPrice(provider, b.entry, atMs, b.id));
    const f = findModel(freshProvider(provider)?.models, model);
    if (f) {
      const p = entryPrice(provider, f.entry, atMs, f.id);
      out.push(b ? p : higherOf(p, floorFor(provider, atMs)));
    }
    return out;
  }

  function listed(provider, atMs) {
    const out = bundledListed(provider, atMs);
    const b = bundledProvider(provider)?.models ?? {};
    for (const [id, e] of Object.entries(freshProvider(provider)?.models ?? {})) {
      const p = entryPrice(provider, e, atMs, id);
      out.push(own(b, id) ? p : higherOf(p, floorFor(provider, atMs)));
    }
    return out;
  }

  // "anthropic/claude-haiku-4.5" is our "claude-haiku-4-5"; Google and xAI keep their dots.
  const vendorIds = bare => [...new Set([bare, bare.replace(/(\d)\.(?=\d)/g, '$1-')])];

  function openRouterPrices(model, atMs) {
    const id = String(model);
    if (isOpenRouterFreeId(id)) return [zeroPrice('openrouter', id)];
    const out = [];
    const slash = id.indexOf('/');
    const vendor = slash > 0 ? OPENROUTER_VENDORS[id.slice(0, slash)] : null;
    if (vendor) {
      const bare = id.slice(slash + 1).replace(/:[a-z0-9-]+$/, '');
      const fee = flags(vendor).blockedRequestFee;
      for (const vid of vendorIds(bare)) {
        const hits = direct(vendor, vid, atMs);
        for (const p of hits) out.push({ ...p, blockedRequestFee: Math.max(p.blockedRequestFee, fee) });
        if (hits.length) break;
      }
    }
    return out;
  }

  /** The provider's most expensive listed model, field by field; OpenRouter's explicit ceiling; every cloud model for a provider we don't know. */
  function worstPriceFor(provider, at) {
    const atMs = toMs(at);
    const fl = flags(provider);
    if (fl.local) return zeroPrice(provider, null, { local: true, known: false });
    if (provider === 'openrouter') return withFlags(effectivePrice({ ...unlisted, provider, model: null, known: false }), fl);
    const mine = listed(provider, atMs).filter(nonZero);
    const pool = mine.length ? mine : cloudProviders().flatMap(id => listed(id, atMs));
    const worst = maxOver(pool, provider, null) ?? effectivePrice({ ...unlisted, provider, model: null, known: false });
    return withFlags({ ...worst, known: false }, fl);
  }

  function priceFor(provider, model, at) {
    const atMs = toMs(at);
    const fl = flags(provider);
    if (fl.local) return zeroPrice(provider, model ?? null, { local: true });
    let found = model == null ? [] : direct(provider, model, atMs);
    if (provider === 'openrouter' && model != null) found = found.concat(openRouterPrices(model, atMs));
    let best = null;
    for (const p of found) best = higherOf(best, p);
    if (best) return withFlags({ ...best, provider, model: provider === 'openrouter' ? String(model) : best.model ?? model ?? null }, fl);
    return { ...worstPriceFor(provider, atMs), model: model ?? null, known: false };
  }

  return {
    priceFor,
    worstPriceFor,
    setRefreshed,
    isLocal,
    date: bundled.date ?? null,
    refreshedDate: () => fresh?.date ?? null,
  };
}

let defaultBook = null;
const book = () => (defaultBook ??= createPriceBook());

/** priceFor over the bundled table (see createPriceBook). */
export const priceFor = (provider, model, at) => book().priceFor(provider, model, at);
/** worstPriceFor over the bundled table (see createPriceBook). */
export const worstPriceFor = (provider, at) => book().worstPriceFor(provider, at);
