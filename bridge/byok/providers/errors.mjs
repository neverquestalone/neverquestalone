// Provider errors (PRD §10, ER-1 to ER-3, §7.5): classify() turns an HTTP
// status, headers, a body, an error inside a 200 stream, or a network failure
// into one ProviderError; userLine() turns that into the fixed in-game line.
//
// Classification order (ER-1): the provider's error code first (including the
// structural ones: Anthropic error.details.error_code, OpenRouter
// error.metadata.error_type), then the few documented message
// strings the manifest lists, then the error type, then the HTTP status.
// Message text is never used otherwise.
//
// The provider's body stays on the error object only as a non-enumerable
// `body` property: in memory for the app's error view, never in
// JSON.stringify(err), never in a log line. Logs get status, type, code and
// request id (errorLogFields).
//
// Three kinds beyond the PRD §10 table, all raised by the bridge, not a provider:
// - `no_key`: no usable key, so nothing was sent. Code `missing_key` (none
//   stored) or `keystore_error` (the keychain couldn't be read: locked, or no
//   Secret Service). The backend maps it to its `no_key` state and never marks
//   the keychain entry invalid; only `auth_invalid` (the provider rejected the
//   key) does that (§10).
// - `egress_blocked`: the egress guard (KY-7) refused the host, code
//   EGRESS_BLOCKED, or EGRESS_STOPPED when the guard itself had stopped (the
//   bridge stopped while the app ran on, fix-102). A fixed decision, so never
//   retried. The line points to Connections, except where the guard refused
//   the AI's own host (a stopped guard, or an allowlist that lost it:
//   needsRestart): that's the app's own fault, never the player's internet,
//   and a restart builds both again.
// - `empty_reply`: the AI finished with no text, and the one more try the
//   backend gave it in the same turn came back empty too. Code `length` (the
//   output ceiling: most often a thinking model that thought its whole room
//   away) or `stop`. Never retried here; the line says to ask again or lower
//   Thinking (names.thinking false: a model with no levels, so another model).
// And two codes under `unknown`, neither retryable: `bad_request_shape` (the
// request couldn't be built, nothing was sent) and `redirect_refused` (the
// provider answered with a redirect, which is never followed, §7.1).

import { looksLikeKey } from '../security/keycheck.mjs';

export const KINDS = Object.freeze([
  'auth_invalid', 'out_of_credit', 'spend_limit', 'cap_spend', 'rate_limited',
  'rate_limited_daily', 'overloaded', 'model_not_found', 'context_too_long', 'content_blocked',
  'network_before_send', 'network_after_send', 'local_unreachable', 'region_blocked',
  'identifier_blocked', 'oauth_expired', 'interrupted', 'timeout', 'bad_request', 'no_key',
  'egress_blocked', 'tls', 'empty_reply', 'unknown',
]);
const KIND_SET = new Set(KINDS);

// Transient kinds the bridge may retry (§7.5). Never billing, auth, content or caps.
export const RETRYABLE_KINDS = Object.freeze(['rate_limited', 'overloaded', 'network_before_send']);
const RETRYABLE = new Set(RETRYABLE_KINDS);

// Codes shared by OpenAI-style APIs (OpenAI, xAI, OpenRouter's upstream codes,
// LM Studio). Provider-specific codes live in each manifest's errorMap.
const GENERIC_CODES = {
  invalid_api_key: 'auth_invalid',
  insufficient_quota: 'out_of_credit',
  rate_limit_exceeded: 'rate_limited',
  server_is_overloaded: 'overloaded',
  server_error: 'overloaded',
  model_not_found: 'model_not_found',
  context_length_exceeded: 'context_too_long',
};
const GENERIC_TYPES = {
  authentication_error: 'auth_invalid',
  // A key without access to one model or resource is still a good key (§10
  // lists only the 401 as a rejected key), so it's never auth_invalid.
  permission_error: 'bad_request',
  insufficient_quota: 'out_of_credit',
  rate_limit_error: 'rate_limited',
  server_error: 'overloaded',
  overloaded_error: 'overloaded',
  not_found_error: 'model_not_found',
  invalid_request_error: 'bad_request',
};

function statusKind(status) {
  if (!status || status < 400) return null;
  if (status >= 500) return 'overloaded';
  return ({
    400: 'bad_request', 401: 'auth_invalid', 402: 'out_of_credit', 403: 'auth_invalid',
    404: 'model_not_found', 408: 'overloaded', 409: 'overloaded', 413: 'context_too_long',
    422: 'bad_request', 429: 'rate_limited',
  })[status] ?? 'unknown';
}

// Connect-phase failures: the request never reached the provider, so a resend
// can't pay twice (DB20). Anything else after fetch() started counts as sent.
const BEFORE_SEND_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'EHOSTDOWN', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);

// Certificate failures (SY-12): the request never left, but the network isn't down, so holding
// the turn for it (network_before_send) would wait 10 minutes for nothing. Its own kind: a clock
// that's wrong (expired, not yet valid), or something on this computer or network that inspects
// secure connections (antivirus HTTPS scanning, a corporate proxy: a certificate it signed).
const TLS_CLOCK_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID']);
const TLS_CODES = new Set([...TLS_CLOCK_CODES, 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

// The egress guard's refusal (security/egress.mjs). The request never left
// either, but it's a policy decision, not an outage: its own kind, no retry.
export const EGRESS_BLOCKED = 'EGRESS_BLOCKED';
// The same refusal from a guard that had stopped (boot's stop uninstalls it): nothing can go until
// the app starts again (fix-102).
export const EGRESS_STOPPED = 'EGRESS_STOPPED';
const EGRESS_CODES = new Set([EGRESS_BLOCKED, EGRESS_STOPPED]);

/**
 * An egress_blocked the app caused itself (fix-102): its guard had stopped, or it refused the AI's
 * own host (which the allowlist always holds for the AI in use or under test). A restart is the fix.
 */
export function needsRestart(err) {
  return err?.kind === 'egress_blocked' && (err.code === EGRESS_STOPPED || err.ownHost === true);
}

export function networkErrorCode(err) {
  let e = err;
  for (let i = 0; e && i < 4; i++) {
    if (typeof e.code === 'string' && e.code !== 'ABORT_ERR') return e.code;
    e = e.cause;
  }
  return null;
}

export function fetchErrorPhase(err) {
  const code = networkErrorCode(err);
  return BEFORE_SEND_CODES.has(code) || EGRESS_CODES.has(code) ? 'before_send' : 'after_send';
}

/** The host a guard's refusal names (its cause's host), or null. */
function refusedHost(err) {
  let e = err;
  for (let i = 0; e && i < 4; i++) {
    if (EGRESS_CODES.has(e.code) && typeof e.host === 'string') return e.host.toLowerCase();
    e = e.cause;
  }
  return null;
}

// ---- headers -------------------------------------------------------------

function headerGetter(headers) {
  if (!headers) return () => null;
  if (typeof headers === 'function') return headers;
  if (typeof headers.get === 'function') return (n) => headers.get(n);
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  return (n) => lower[n.toLowerCase()] ?? null;
}

// Go-style durations as OpenAI sends them: "6m0s", "1s", "20ms", "1h2m3.5s".
export function parseDuration(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!/^(\d+(\.\d+)?(ms|h|m|s))+$/.test(t)) return null;
  let ms = 0;
  for (const [, n, unit] of t.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    ms += Number(n) * ({ ms: 1, s: 1000, m: 60000, h: 3600000 })[unit];
  }
  return Math.round(ms);
}

// retry-after-ms, then retry-after (seconds or an HTTP date).
export function parseRetryAfter(headers, now = Date.now()) {
  const h = headerGetter(headers);
  const ms = h('retry-after-ms');
  if (ms != null && /^\d+(\.\d+)?$/.test(String(ms).trim())) return Math.round(Number(ms));
  const ra = h('retry-after');
  if (ra == null) return null;
  const v = String(ra).trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function parseReset(value, format, now) {
  if (value == null || value === '') return null;
  const v = String(value).trim();
  if (format === 'duration') { const d = parseDuration(v); return d == null ? null : now + d; }
  if (format === 'rfc3339') { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (format === 'epoch_ms') {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n; // tolerate seconds
  }
  if (format === 'seconds') { const n = Number(v); return Number.isFinite(n) ? now + n * 1000 : null; }
  return null;
}

// The rate-limit headers a manifest names, as {bucket: {limit, remaining, resetAt}}
// plus retryAfterMs. Null when the provider sends none (US-3).
export function parseRateLimit(headers, manifest, now = Date.now()) {
  const spec = manifest?.rateLimitHeaders;
  if (!spec) return null;
  const h = headerGetter(headers);
  const out = {};
  let any = false;
  for (const [bucket, names] of Object.entries(spec.buckets || {})) {
    const numOf = (n) => { const v = n ? h(n) : null; const x = v == null ? NaN : Number(v); return Number.isFinite(x) ? x : null; };
    const b = { limit: numOf(names.limit), remaining: numOf(names.remaining), resetAt: parseReset(names.reset ? h(names.reset) : null, spec.resetFormat, now) };
    if (b.limit != null || b.remaining != null || b.resetAt != null) { out[bucket] = b; any = true; }
  }
  const retryAfterMs = parseRetryAfter(h, now);
  if (retryAfterMs != null) { out.retryAfterMs = retryAfterMs; any = true; }
  return any ? out : null;
}

// Earliest reset among exhausted buckets (or among all, if none reads 0).
function resetFromBuckets(rl, now) {
  if (!rl) return null;
  const buckets = Object.values(rl).filter(b => b && typeof b === 'object' && b.resetAt != null);
  const exhausted = buckets.filter(b => b.remaining === 0);
  const pool = exhausted.length ? exhausted : buckets;
  if (!pool.length) return null;
  return Math.max(0, Math.min(...pool.map(b => b.resetAt)) - now);
}

// ---- bodies ----------------------------------------------------------------

function asObject(body) {
  if (body == null) return null;
  if (typeof body === 'string') { try { return JSON.parse(body); } catch { return null; } }
  if (body instanceof Uint8Array) { try { return JSON.parse(new TextDecoder().decode(body)); } catch { return null; } }
  return typeof body === 'object' ? body : null;
}

// One shape out of every provider's error format: Anthropic
// {type:'error', error:{type, message, details}}, OpenAI {error:{type, code}},
// OpenAI stream `error` events {type:'error', code}, Responses `response.failed`
// {response:{error:{code}}}, xAI {code, error:'…'}, OpenRouter
// {error:{code:<http>, metadata}} (sometimes wrapped in an array), Ollama
// {error:'…'}.
export function extractError(body) {
  let o = asObject(body);
  if (Array.isArray(o)) o = o[0];
  if (!o || typeof o !== 'object') return {};
  if (o.response && typeof o.response === 'object' && o.response.error) o = { error: o.response.error };
  const out = { code: null, type: null, httpCode: null, message: '', metadata: null, details: null, requestId: null };
  const e = o.error;
  if (e && typeof e === 'object') {
    if (typeof e.code === 'string') out.code = e.code;
    else if (typeof e.code === 'number') out.httpCode = e.code;
    if (typeof e.type === 'string') out.type = e.type;
    if (typeof e.message === 'string') out.message = e.message;
    if (e.metadata && typeof e.metadata === 'object') out.metadata = e.metadata;
    if (e.details != null) out.details = e.details;
  } else if (typeof e === 'string') {
    out.message = e;
    if (typeof o.code === 'string') out.code = o.code;
  } else if (o.type === 'error' || typeof o.code === 'string') {
    if (typeof o.code === 'string') out.code = o.code;
    if (typeof o.message === 'string') out.message = o.message;
  }
  if (typeof o.request_id === 'string') out.requestId = o.request_id;
  return out;
}

// ---- time helpers ------------------------------------------------------------

// The next midnight in an IANA zone (a manifest's dailyResetZone). Off by up
// to an hour on a DST change day; it's a display hint.
export function nextMidnight(zone, now = Date.now()) {
  if (!zone || zone === 'UTC') {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(now));
  const get = (t) => Number(parts.find(p => p.type === t)?.value ?? 0);
  const since = ((get('hour') * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000);
  return now - since + 24 * 3600 * 1000;
}

function firstOfNextMonthUTC(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

// ---- the error object ----------------------------------------------------------

/**
 * A provider's request id as the bridge keeps it (the old audit's KB-09): id-shaped (letters, digits,
 * _ . : -) and at most 64 characters, and never shaped like a key (a proxy that echoes the key there),
 * tested whole, never a cut of it. Anything else is undefined.
 */
export function cleanRequestId(v) {
  return typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v) && !looksLikeKey(v) ? v : undefined;
}

export function makeError(fields, body = undefined) {
  const err = {};
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) err[k] = v;
  // A request id from a header, a body or a stream's start goes in only when it's one (KB-09).
  if ('requestId' in err) { const id = cleanRequestId(err.requestId); if (id) err.requestId = id; else delete err.requestId; }
  if (!KIND_SET.has(err.kind)) err.kind = 'unknown';
  if (typeof err.retryable !== 'boolean') err.retryable = RETRYABLE.has(err.kind);
  Object.defineProperty(err, 'body', { value: body, enumerable: false, writable: false, configurable: false });
  return err;
}

// The only fields a log line may carry about a provider error (§10). The kind
// goes out as `errorKind`, since the bridge logger's own `kind` names the line.
export function errorLogFields(err) {
  if (!err) return {};
  const out = {};
  if (err.kind !== undefined) out.errorKind = err.kind;
  for (const k of ['provider', 'status', 'type', 'code', 'requestId', 'retryable', 'retryAfterMs', 'phase']) {
    if (err[k] !== undefined) out[k] = err[k];
  }
  return out;
}

function lookup(table, key) {
  if (!table || key == null) return null;
  if (Object.prototype.hasOwnProperty.call(table, key)) return table[key];
  const low = String(key).toLowerCase();
  for (const [k, v] of Object.entries(table)) if (k.toLowerCase() === low) return v;
  return null;
}

// classify(manifestOrId, {status, headers, body, streamEvent, networkPhase,
//   networkError, auth, now}) → ProviderError. Pass the manifest to get its
// errorMap; a bare id gets only the generic tables.
export function classify(provider, input = {}) {
  const manifest = provider && typeof provider === 'object' ? provider : null;
  const id = manifest ? manifest.id : String(provider ?? 'unknown');
  const map = manifest?.errorMap || {};
  const { status = null, headers = null, body = null, streamEvent = null, networkPhase = null, networkError = null, auth = 'key', now = Date.now() } = input;
  const h = headerGetter(headers);
  const headerRequestId = h('request-id') || h('x-request-id') || null;

  if (networkPhase) {
    const netCode = networkErrorCode(networkError);
    if (EGRESS_CODES.has(netCode)) {
      // The AI's own host refused: the app's own fault (needsRestart), never the player's network.
      const host = refusedHost(networkError);
      const own = !!host && (manifest?.hosts ?? []).some(h => String(h).toLowerCase() === host);
      return makeError({ kind: 'egress_blocked', provider: id, code: netCode, retryable: false, ...(own ? { ownHost: true } : {}) });
    }
    if (TLS_CODES.has(netCode)) return makeError({ kind: 'tls', provider: id, code: netCode, retryable: false });
    const before = networkPhase === 'before_send';
    return makeError({
      kind: before ? (manifest?.local ? 'local_unreachable' : 'network_before_send') : 'network_after_send',
      provider: id,
      code: netCode,
      retryable: before && !manifest?.local,
      requestId: headerRequestId,
    });
  }

  const raw = streamEvent ?? body;
  const x = extractError(raw);
  const effectiveStatus = status && status !== 200 ? status : (x.httpCode || status);
  const meta = x.metadata || {};
  const extra = {};
  let kind = null;
  let code = x.code;

  // 1. Structural codes.
  const detailCode = x.details && !Array.isArray(x.details) && typeof x.details.error_code === 'string' ? x.details.error_code : null;
  const candidates = [];
  if (detailCode) candidates.push(detailCode);
  if (typeof meta.error_type === 'string') candidates.push(meta.error_type);
  if (x.code) candidates.push(x.code);

  // 2. Codes: the manifest's exact codes, its substrings, then the generic table.
  for (const c of candidates) {
    let k = lookup(map.codes, c);
    if (!k && map.codeContains) {
      for (const [needle, v] of Object.entries(map.codeContains)) if (String(c).includes(needle)) { k = v; break; }
    }
    k = k || lookup(GENERIC_CODES, c);
    if (k) { kind = k; code = c; break; }
  }

  // 3. The documented message strings the manifest lists (e.g. Anthropic's
  // "credit balance is too low"), scoped to the statuses it names.
  if (!kind && x.message && Array.isArray(map.messages)) {
    const text = x.message.toLowerCase();
    for (const m of map.messages) {
      if (!m || typeof m.text !== 'string') continue;
      if (Array.isArray(m.status) && effectiveStatus && !m.status.includes(effectiveStatus)) continue;
      if (text.includes(m.text.toLowerCase())) { kind = m.kind; extra.matched = 'message'; break; }
    }
  }

  // 4. The error type (Anthropic's error.type, OpenAI's type).
  if (!kind && x.type) kind = lookup(map.types, x.type) || lookup(GENERIC_TYPES, x.type);

  // 5. The HTTP status. A 200 never classifies by status. A 403 that says nothing (no code, type or
  // message: a CDN's, a firewall's or a proxy's page) is bad_request, never a rejected key, on every AI
  // (code health BR-10: it marked a good OpenAI, xAI or Other key rejected); only a provider's own words
  // reject a key on a 403.
  if (!kind && effectiveStatus === 403 && !candidates.length && !x.type && !x.message) kind = 'bad_request';
  if (!kind && effectiveStatus && effectiveStatus !== 200) kind = lookup(map.status, String(effectiveStatus)) || statusKind(effectiveStatus);
  if (!kind || !KIND_SET.has(kind)) kind = 'unknown';

  // Refinements.
  if (kind === 'auth_invalid' && auth === 'oauth') kind = 'oauth_expired';
  let retryAfterMs = parseRetryAfter(h, now);
  let resetAt = null;
  // No retry-after: the earliest reset of the rate-limit buckets the manifest names (US-3).
  if (kind === 'rate_limited' && retryAfterMs == null) retryAfterMs = resetFromBuckets(parseRateLimit(h, manifest, now), now);
  if (kind === 'rate_limited_daily') {
    retryAfterMs = null;
    resetAt = nextMidnight(map.dailyResetZone || 'UTC', now);
  }
  if (kind === 'spend_limit' && code === 'enforced_spend_limit_reached') resetAt = firstOfNextMonthUTC(now);

  return makeError({
    kind,
    provider: id,
    status: status ?? undefined,
    type: x.type ?? undefined,
    code: code ?? undefined,
    retryAfterMs: retryAfterMs ?? undefined,
    resetAt: resetAt ?? undefined,
    requestId: headerRequestId || x.requestId || undefined,
    ...extra,
  }, raw);
}

// ---- retries (§7.5) ----------------------------------------------------------------

// Whether to retry after `attempt` failed tries (0-based), and after how long:
// transient kinds only, at most `maxRetries`, honoring retry-after, with jitter.
// A wait over two minutes isn't retried automatically.
export function retryPlan(err, attempt, { maxRetries = 2, random = Math.random, baseMs = 2000, maxWaitMs = 120000 } = {}) {
  if (!err || !err.retryable || !RETRYABLE.has(err.kind) || attempt >= maxRetries) return { retry: false, delayMs: null };
  const base = err.retryAfterMs != null ? err.retryAfterMs : baseMs * 2 ** attempt;
  if (base > maxWaitMs) return { retry: false, delayMs: null };
  return { retry: true, delayMs: Math.round(base + random() * Math.min(1000, 250 + base * 0.25)) };
}

// ---- in-game lines (§10) -------------------------------------------------------------

function usd(micros) {
  const n = Number(micros);
  if (!Number.isFinite(n)) return null;
  return `$${(n / 1e6).toFixed(2)}`;
}

// A time of day as Intl gives it ("5:00 PM"), with the one change STYLE §8 makes for the game: the
// narrow space before AM or PM becomes a plain one, because the game's fonts lack it.
function clock(ms, timeZone) {
  const opts = { hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) };
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(ms)).replace(/[  ]/g, ' ');
}

function day(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) }).format(new Date(ms));
}

function localDate(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
    .formatToParts(new Date(ms));
  const get = (t) => Number(parts.find(p => p.type === t)?.value);
  return { ymd: `${get('year')}-${get('month')}-${get('day')}`, midnight: get('hour') % 24 === 0 && get('minute') === 0 };
}

// A reset time as the player reads it: "5:00 PM" today, "Oct 1" at a local
// midnight, else "Sep 30 at 5:00 PM" (Anthropic's cap resets at 00:00 UTC,
// which is the afternoon before in the Americas).
function when(ms, now, timeZone) {
  if (ms == null) return null;
  const at = localDate(ms, timeZone);
  if (at.ymd === localDate(now, timeZone).ymd) return clock(ms, timeZone);
  return at.midnight ? day(ms, timeZone) : `${day(ms, timeZone)} at ${clock(ms, timeZone)}`;
}

// A duration in a sentence, spelled out with the plural rule (STYLE §8, §12): "18 seconds",
// "1 second", "3 minutes". null for none. The desktop's lines use it too (app-api.mjs desktopLine).
const PLURAL = new Intl.PluralRules('en-US');
export function durWords(ms) {
  if (ms == null) return null;
  const [n, one, many] = ms >= 120000 ? [Math.round(ms / 60000), 'minute', 'minutes'] : [Math.max(1, Math.ceil(ms / 1000)), 'second', 'seconds'];
  return `${n} ${PLURAL.select(n) === 'one' ? one : many}`;
}

const act = (id, label, desktop = false) => ({ id, label, desktop });
/**
 * The second action on the busy and out-of-credit lines (systems plan D7): open Your AI in the app
 * to pick another one. One click, never an automatic switch (the PRD rules out a surprise bill or a
 * change of privacy class). In game its label is Title Case, as the game's buttons are.
 */
export const PICK_ANOTHER_AI = Object.freeze(act('pick_provider', 'Pick Another AI', true));

// userLine(err, names) → {headline, detail, action, alt?}. names: provider (display
// name, <P>), model (<M>), companion (<Name>), product ("NeverQuestAlone"),
// fallbackModel (<M2>), capMicros (the daily spend cap the player set), final (no retries left), now,
// timeZone, thinking (false: the model has no thinking levels, so no Thinking to lower). Provider
// text never appears; these lines are the whole message.
export function userLine(err, names = {}) {
  // [UX-W07] With no name, "Your AI company" ("provider" is never a player's word).
  const P = names.provider || err?.provider || 'Your AI company';
  const M = names.model || 'This model';
  const N = names.companion || 'NeverQuestAlone';
  const product = names.product || 'NeverQuestAlone';
  const now = names.now ?? Date.now();
  const tz = names.timeZone;
  const final = !!names.final;
  const unnamed = P === 'Your AI company';
  const fit = t => (unnamed ? t.replace(/([Yy])our Your AI company/g, '$1our AI company').replace(/([^.!?] )Your AI company/g, '$1your AI company') : t);
  const line = (headline, detail, action) => ({ headline: fit(headline), detail: fit(detail), action });
  // In game the fix is named where it is, "the NeverQuestAlone app" (STYLE §2.1), and a button
  // is clicked (§3); labels are Title Case verbs (§2.3, §6), Retry for every resend. [PUI-01]
  const app = `the ${product} app`;
  switch (err?.kind) {
    case 'no_key':
      return err.code === 'keystore_error'
        ? line(`Couldn't read your ${P} key.`, `Check it in ${app}.`, act('keys', 'Open Your AI', true))
        : line(`No ${P} key is set up.`, `Add one in ${app}.`, act('add_key', 'Add Key', true));
    case 'egress_blocked':
      // Its own guard refusing the AI's own host is the app's fault, never the player's internet (fix-102).
      if (needsRestart(err)) return line(`${product} needs a restart.`, `Quit and reopen ${app}.`, act('restart', 'Quit and Reopen', true));
      return line(`${product} blocked the connection to ${P}.`, `Check Connections in ${app}.`, act('connections', 'Open Connections', true));
    case 'auth_invalid':
      return line(`Your ${P} key was rejected.`, `Replace it in ${app}.`, act('replace_key', 'Replace Key', true));
    case 'out_of_credit': // D7: another AI one click away (alt), never an automatic switch. The HUD's own words for the state (UX-W31).
      return { ...line(`Your ${P} account is out of credit.`, `Add credit at ${P}, or pick another AI in ${app}.`, act('add_credit', 'Add Credit', true)), alt: PICK_ANOTHER_AI };
    case 'spend_limit': {
      const until = names.resetText || when(err.resetAt, now, tz) || 'it resets';
      // "Reached", setup's and the daily spend limit's word for a limit (bones-ux-writer r4, UX-W41).
      return line(`You've reached the spend limit you set at ${P}.`, `Raise it there, or wait until ${until}.`, act('provider_limits', 'Open Limits', true));
    }
    case 'cap_spend': { // only ever the player's own daily cap: the public build has no limits of its own
      // Held because today's spend couldn't be read (code health BR-09; capHeld, the caps snapshot's held), not
      // reached: Home's card's words, and its fix (bones-ux-writer UX-W02).
      if ((names.capHeld ?? err.capHeld) === 'load_error') return line(`Today's spend couldn't be read, so ${N} rests.`, `Set your limit again in ${app}.`, act('caps', 'Set Limit', true));
      const cap = usd(names.capMicros ?? err.capMicros);
      // The HUD's, the card's and the notification's words for the same state (UX-W31).
      return line(cap ? `You've reached your daily spend limit (${cap}).` : "You've reached your daily spend limit.", `Raise it or turn it off in ${app}, or it resets at midnight.`, act('caps', 'Raise Limit', true));
    }
    case 'rate_limited': {
      const wait = durWords(names.retryInMs ?? err.retryAfterMs);
      if (final) return line(`${P} asked ${N} to slow down.`, wait ? `Try again in ${wait}.` : 'Try again in a minute.', act('retry', 'Retry'));
      return line(`${P} asked ${N} to slow down.`, wait ? `Trying again in ${wait}.` : 'Trying again shortly.', act('wait', null));
    }
    case 'rate_limited_daily': {
      const at = err.resetAt != null ? clock(err.resetAt, tz) : null;
      return line(`${P}'s daily limit is used up.`, at ? `It resets at ${at}.` : 'It resets tomorrow.', act('wait', null));
    }
    case 'overloaded': { // D7: another AI one click away (alt) once the retries are done
      if (final) return { ...line(`${P} is busy right now.`, 'Still busy. Try again in a minute.', act('retry', 'Retry')), alt: PICK_ANOTHER_AI };
      const wait = durWords(names.retryInMs);
      return line(`${P} is busy right now.`, wait ? `Trying again in ${wait}.` : 'Trying again…', act('wait', null));
    }
    case 'model_not_found':
      return names.fallbackModel
        ? line(`${M} isn't available on your ${P} account.`, `Switched to ${names.fallbackModel} for now. Change it in ${app}.`, act('pick_model', 'Pick Another Model', true))
        : line(`${M} was retired.`, `Pick another model in ${app}.`, act('pick_model', 'Pick Another Model', true));
    case 'context_too_long':
      if (err.reason === 'num_ctx') {
        return line("This model's context is too small.", `Raise the context size for ${M}, or pick another model in ${app}.`, act('pick_model', 'Pick Another Model', true));
      }
      return line(`This chat is too long for ${M}.`, 'Start a new chat.', act('new_chat', 'New Chat'));
    case 'content_blocked':
      return line(`${M} declined to answer that.`, 'Try asking another way.', act('rephrase', null));
    case 'empty_reply': // no text, twice in one turn: Thinking is in the window (the chat's) and the app
      return names.thinking === false
        ? line(`${N} couldn't finish a reply.`, `Ask again, or pick another model in ${app}.`, act('retry', 'Retry'))
        : line(`${N} couldn't finish a reply.`, 'Ask again, or lower Thinking.', act('retry', 'Retry'));
    case 'network_before_send':
      return line(`Can't reach ${P}. Check your internet.`, "Your message will send when it's back.", act('cancel', 'Cancel'));
    case 'network_after_send':
      return line('No answer: the connection dropped.', '', act('send_again', 'Retry'));
    case 'local_unreachable':
      return line(`${N} can't reach ${P}.`, `Start ${P}, then click Retry.`, act('retry', 'Retry', true));
    case 'oauth_expired':
      return line(`Your ${P} sign-in ended.`, `Sign in again in ${app}.`, act('sign_in', 'Sign In', true));
    case 'region_blocked':
      return line(`${P} isn't available where you are.`, `Pick another AI in ${app}.`, act('pick_provider', 'Pick Another AI', true));
    case 'identifier_blocked':
      return line(`${P} has blocked this install.`, `See the details in ${app}.`, act('details', 'Open Diagnostics', true));
    case 'interrupted':
      if (err.aborted) return line('Stopped.', '', act('send_again', 'Retry'));
      return line(`${product} restarted before ${N} answered.`, '', act('send_again', 'Retry'));
    case 'timeout':
      return line(`No answer from ${P} after ${durWords(err.afterMs) ?? '60 seconds'}.`, '', act('retry', 'Retry'));
    case 'bad_request':
      return line(`${P} couldn't take that message.`, `See the details in ${app}.`, act('details', 'Open Diagnostics', true));
    case 'tls': // a certificate failure (SY-12): this computer's clock, or something inspecting secure connections
      return TLS_CLOCK_CODES.has(err.code)
        ? line(`Couldn't make a secure connection to ${P}.`, "Check your computer's date and time, then click Retry.", act('retry', 'Retry'))
        : line(`Couldn't make a secure connection to ${P}.`, 'Turn off HTTPS scanning in your antivirus, then click Retry.', act('retry', 'Retry'));
    case 'local_write': // the bridge couldn't write on this computer (the ledger, a total; SY-12): never the AI's fault
      return err.code === 'ENOSPC'
        ? line('Your disk is full, so nothing was sent.', 'Free up space, then click Retry.', act('retry', 'Retry'))
        : line(`${product} couldn't save on this computer, so nothing was sent.`, 'Click Retry. Restart your computer if it keeps happening.', act('retry', 'Retry'));
    default:
      return line(`Something went wrong with ${P}.`, `See the details in ${app}.`, act('details', 'Open Diagnostics', true));
  }
}
