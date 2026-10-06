// Metering (PRD §9.2, §9.4, US-1): what one reply cost, and what a turn may
// cost before it is sent (what caps.mjs checks against a cap the player set). Money is integer
// micro-dollars everywhere, because the addon's ns.Int floors and fractional
// cents would read as 0. Prices are USD per 1M tokens, so price × tokens is
// already micro-dollars.
//
// usage, as the adapters report it (TurnEvent 'usage', BUILD-PLAN):
//   input         input tokens billed at the base rate (not cache reads or writes)
//   cacheRead     cache hits
//   cacheWrite    cache writes, all TTLs
//   cacheWrite1h  the part of cacheWrite written with the 1-hour TTL. Absent
//                 means all of it: §7.3 uses the 1-hour TTL while a game
//                 session is active, and it's the dearer write
//   output        output tokens
//   reasoning     thinking tokens; billed on top of output unless the price
//                 says the provider's output count already holds them
//                 (reasoningInOutput, from prices.json: Anthropic, OpenAI)
//   costUsd       the provider's exact cost (OpenRouter usage.cost); wins
// A request xAI blocks before generation costs its blockedRequestFee
// (errorKind 'content_blocked'). Estimates round up to the next micro-dollar;
// exact costs round to nearest.
import { effectivePrice } from './prices.mjs';
import { loadPack } from '../runtime/pack.mjs';

export const MICROS_PER_USD = 1_000_000;
// Turning request text into tokens before the provider counts it: UTF-8 bytes
// over 3. That's §9.3's 4 characters a token less the 30% newer Claude
// tokenizers add, and about a token a character for CJK text, so it errs high.
export const BYTES_PER_TOKEN = 3;
export const BLOCK_OVERHEAD_TOKENS = 8; // role and framing tokens per message or system block

const tokens = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const count = v => (Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0);
const ceilMicros = x => Math.max(0, Math.ceil(x - 1e-6)); // float noise (750.0000001) isn't a micro-dollar
const PRICE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'reasoning'];

/** Usage with every count a non-negative integer (a missing cacheWrite1h means every write was 1-hour). */
export function normalizeUsage(u = {}) {
  const cacheWrite = tokens(u?.cacheWrite);
  return {
    input: tokens(u?.input),
    output: tokens(u?.output),
    cacheRead: tokens(u?.cacheRead),
    cacheWrite,
    cacheWrite1h: Number.isFinite(u?.cacheWrite1h) ? Math.min(tokens(u.cacheWrite1h), cacheWrite) : cacheWrite,
    reasoning: tokens(u?.reasoning),
  };
}

const exactUsd = u => (u && Number.isFinite(u.costUsd) && u.costUsd >= 0 ? u.costUsd : null);

/** True for a price that can't cost anything: a local model, or $0 everywhere with no fees. */
export function isFreePrice(price) {
  const p = effectivePrice(price);
  if (p.local) return true;
  return PRICE_KEYS.every(k => p[k] === 0) && p.blockedRequestFee === 0;
}

/** What a reply cost, in integer micro-dollars: the exact cost when the provider gave one. */
export function costMicros(usage, price, { errorKind = null } = {}) {
  const p = effectivePrice(price);
  const exact = exactUsd(usage);
  if (exact !== null) return Math.round(exact * MICROS_PER_USD);
  const u = normalizeUsage(usage);
  // One price whatever the prompt's size: no tier is reachable under the per-turn ceiling (prices.mjs).
  const sum =
    u.input * p.input +
    u.cacheRead * p.cacheRead +
    (u.cacheWrite - u.cacheWrite1h) * p.cacheWrite +
    u.cacheWrite1h * p.cacheWrite1h +
    u.output * p.output +
    (p.reasoningInOutput ? 0 : u.reasoning * p.reasoning);
  const fee = errorKind === 'content_blocked' ? p.blockedRequestFee * MICROS_PER_USD : 0;
  return ceilMicros(sum + fee);
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(textOf).join('');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (v.content !== undefined) return textOf(v.content);
  }
  return JSON.stringify(v) ?? '';
}

/**
 * The token counts a turn is sized by. Takes the BUILD-PLAN request
 * ({system:[{text}], messages:[{content}], maxTokens, replyTokens, effort}) or explicit
 * counts ({inputTokens, maxOutputTokens, reasoningTokens}); an explicit count
 * wins (the runtime's calibrated figure, §9.3), else the text is measured.
 * maxOutputTokens is the whole output ceiling (the reply's and its thinking room);
 * replyTokens the reply's own part (the per-turn ceiling's, caps.mjs), else the same.
 */
export function turnTokens(req) {
  const r = req && typeof req === 'object' ? req : {};
  let inputTokens = count(r.inputTokens);
  if (!inputTokens) {
    const blocks = [...(Array.isArray(r.system) ? r.system : r.system != null ? [r.system] : []), ...(Array.isArray(r.messages) ? r.messages : [])];
    let bytes = 0;
    for (const b of blocks) bytes += Buffer.byteLength(textOf(b), 'utf8');
    if (blocks.length) inputTokens = Math.ceil(bytes / BYTES_PER_TOKEN) + BLOCK_OVERHEAD_TOKENS * blocks.length;
  }
  const maxOutputTokens = count(r.maxOutputTokens) || count(r.maxTokens);
  return {
    inputTokens,
    maxOutputTokens,
    replyTokens: Math.min(count(r.replyTokens) || maxOutputTokens, maxOutputTokens || Infinity),
    reasoningTokens: count(r.reasoningTokens),
    effort: r.effort ?? null,
  };
}

const thinks = effort => effort != null && effort !== false && effort !== 'none';

/**
 * The most a turn can cost before it is sent, which is what the cap is checked with:
 * every input token at the dearest input-side price (base, cache read, either
 * cache write), the full output ceiling, and thinking where the provider bills
 * it outside the output count (reasoningTokens, or the output ceiling again
 * when an effort is set). A request xAI may block costs its fee instead of
 * the output. A local or $0 price is 0; otherwise a request with no input or
 * no output ceiling throws, so a forgotten field is never a free turn.
 */
export function estimateMicros(req, price) {
  const p = effectivePrice(price);
  if (isFreePrice(p)) return 0;
  const t = turnTokens(req);
  if (!t.inputTokens) throw new TypeError('meter: estimateMicros needs the input (inputTokens, or system and messages)');
  if (!t.maxOutputTokens) throw new TypeError('meter: estimateMicros needs the output ceiling (maxOutputTokens or maxTokens)');
  const inputPrice = Math.max(p.input, p.cacheRead, p.cacheWrite, p.cacheWrite1h);
  const thinking = p.reasoningInOutput ? 0 : t.reasoningTokens || (thinks(t.effort) ? t.maxOutputTokens : 0);
  const generated = t.maxOutputTokens * p.output + thinking * p.reasoning;
  return ceilMicros(t.inputTokens * inputPrice + Math.max(generated, p.blockedRequestFee * MICROS_PER_USD));
}

// §7.3's typed turn: the prompt pack as its cacheable prefix, 2,000 tokens more, and 350 out; 40 a day.
// The prefix is the pack's own estimate as it goes with the default persona's name (loadPack().tokens:
// 6,377 now), so the figures follow the pack (code health BR-18: a hard-coded 5,500 sat under the pack
// alone). The window's "about $X a day" for every model (app-api.mjs priceHint), the docs' cost example
// (tests/byok/public_docs_test.mjs) and the development mock's figures come from it.
export const TYPICAL_PREFIX = loadPack().tokens;
export const TYPICAL_TURN = Object.freeze({
  cached: { input: 2000, cacheRead: TYPICAL_PREFIX, output: 350 }, uncached: { input: TYPICAL_PREFIX + 2000, output: 350 }, perDay: 40,
});

// The thinking a typical turn is priced with (SY-102-1): this share of the room its model thinks in at
// its start level (providers/util.mjs startThinkRoom: Low's 2,048, so 1,024 tokens; a model that always
// thinks, its thinkRoom's share). Every AI here bills thinking as output, and every default model
// thinks at Low, so a figure without it is a floor, not a typical day. Half the room is a stated
// allowance, not a measurement: it errs high for a short reply, and a measured median at Low per
// default replaces it when the live runs record one.
export const TYPICAL_THINK_SHARE = 0.5;

/** The thinking tokens a typical turn is priced with for a model's start-level room (thinkRoom). */
export function typicalThink(thinkRoom = 0) {
  return Number.isFinite(thinkRoom) && thinkRoom > 0 ? Math.round(thinkRoom * TYPICAL_THINK_SHARE) : 0;
}

/**
 * A model's cost at the typical turn with its thinking (typicalThink of the room it thinks in at its
 * start level, billed as the company bills it: inside output, or at its reasoning price): a reply's
 * cents, cached to uncached, and a day's dollars at TYPICAL_TURN.perDay replies, each rounded to
 * hundredths. → { replyCents: [lo, hi], dayUsd: [lo, hi], at, think }
 */
export function typicalCost(price, { thinkRoom = 0 } = {}) {
  const r2 = n => Math.round(n * 100) / 100;
  const think = typicalThink(thinkRoom);
  const inOutput = effectivePrice(price).reasoningInOutput;
  const withThink = t => (think ? (inOutput ? { ...t, output: t.output + think, reasoning: think } : { ...t, reasoning: think }) : t);
  const lo = costMicros(withThink(TYPICAL_TURN.cached), price);
  const hi = costMicros(withThink(TYPICAL_TURN.uncached), price);
  return { replyCents: [r2(lo / 1e4), r2(hi / 1e4)], dayUsd: [r2(lo * TYPICAL_TURN.perDay / 1e6), r2(hi * TYPICAL_TURN.perDay / 1e6)], at: TYPICAL_TURN.perDay, think };
}

/** What caps.check takes: {estMicros, free}. free only for a local or $0 price. */
export function estimateTurn(req, price) {
  const free = isFreePrice(price);
  return { estMicros: free ? 0 : estimateMicros(req, price), free };
}

/**
 * One reply's meter reading: the slot's per-reply usage {in, out, micros,
 * model, exact} plus the tokens by kind (US-1). `exact` is true only for a
 * provider-reported cost or a local ($0) model.
 */
export function meterReply(usage, price, opts = {}) {
  const u = normalizeUsage(usage);
  const p = effectivePrice(price);
  return {
    in: u.input + u.cacheRead + u.cacheWrite,
    out: u.output + (p.reasoningInOutput ? 0 : u.reasoning),
    micros: costMicros(usage, p, opts),
    model: p.model,
    exact: exactUsd(usage) !== null || p.local,
    known: p.known,
    tokens: { input: u.input, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheWrite1h: u.cacheWrite1h, output: u.output, reasoning: u.reasoning },
  };
}
