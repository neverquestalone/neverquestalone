// Redaction (PRD §8.4 items 6-7, KY-9, TH3): every log line, error text and
// diagnostic export passes through redact() before it is written anywhere.
//
// Two layers:
//   1. Exact matches: every configured key (and its JSON-escaped form), the
//      longest first, so a key that contains another is taken whole.
//   2. Patterns: the provider key shapes from keycheck.mjs, unanchored, then
//      auth headers, key-like query parameters and fields, JWTs and ya29.
//      Google OAuth tokens. Header and field names are kept; values go.
//
// Value classes never include a backslash or a quote, so redacting a JSON
// line (or JSON inside it) keeps it valid JSON. redact() is idempotent.
import { KEY_SHAPES, shapeSource, proseKeyPatterns } from './keycheck.mjs';

export const REDACTED = '<redacted>';
const MIN_EXTRA = 8; // shorter "secrets" would shred ordinary text

const KEYS = KEY_SHAPES.map(s => new RegExp(shapeSource(s), 'g'));

// Between a header or field name and its value: ':' or '=' (header, JSON,
// query, object literal) or '=>' (a Map as util.inspect prints it), each
// side's quote optionally escaped (JSON inside a JSON string, at any depth);
// or, when both are quoted, a comma: the rawHeaders array [ 'x-api-key', '…' ].
const Q = String.raw`\\*["']`;
const SEP = String.raw`(?:(?:${Q})?\s*(?:=>|[:=])\s*(?:${Q})?|${Q}\s*,\s*${Q})`;
const SEP_QUOTED = String.raw`(?:(?:${Q})?\s*(?:=>|[:=])\s*${Q}|${Q}\s*,\s*${Q})`;

// [pattern, replacement]; $1 keeps the name/prefix.
const RULES = [
  // Authorization: <anything> (Bearer, Basic, a raw key). JSON or header form.
  [new RegExp(String.raw`(\b(?:proxy-)?authorization${SEP})[^"'\\\r\n,;}]{4,}`, 'gi'), `$1${REDACTED}`],
  // Bearer tokens wherever they appear.
  [/(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`],
  // x-api-key, x-goog-api-key headers.
  [new RegExp(String.raw`(\bx-(?:goog-)?api-key${SEP})[^"'\\\s,;}]+`, 'gi'), `$1${REDACTED}`],
  // Quoted key-ish fields: "apiKey": "…", 'client_secret': '…', 'api-key' => '…'.
  [new RegExp(String.raw`(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|code[_-]?verifier|secret|password)${SEP_QUOTED})[^"'\\\r\n]+`, 'gi'), `$1${REDACTED}`],
  // Query parameters: ?key=, &api_key=, &code= (the OAuth code) …
  [/([?&](?:key|api[_-]?key|apikey|access[_-]?token|token|code|code[_-]?verifier)=)[^&#\s"'\\]+/gi, `$1${REDACTED}`],
  // Google OAuth access tokens.
  [/\bya29\.[0-9A-Za-z_-]{10,}/g, REDACTED],
  // JWTs: header.payload[.signature], both base64url JSON objects.
  [/\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, REDACTED],
];

function extrasOf(extraSecrets) {
  const out = new Set();
  if (!extraSecrets) return [];
  for (const s of extraSecrets) {
    if (typeof s !== 'string' || s.length < MIN_EXTRA) continue;
    out.add(s);
    const j = JSON.stringify(s).slice(1, -1);
    if (j !== s) out.add(j);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

// A configured secret cut or wrapped across a line (KB-07, code health) isn't whole to match: any run
// of key characters holding its first or last PART characters goes too, so both halves of a break do.
// Only for secrets of 2 * PART or more. Found with indexOf and widened by hand, so a long run costs its
// length, never its square (a regex with a * on each side took 1.9 s on 60,000 characters).
const PART = 12;
const KEY_CHAR = /[A-Za-z0-9_.-]/;
function takeRuns(t, part) {
  let out = '', from = 0, at;
  while ((at = t.indexOf(part, from)) >= 0) {
    let a = at, b = at + part.length;
    while (a > from && KEY_CHAR.test(t[a - 1])) a--;
    while (b < t.length && KEY_CHAR.test(t[b])) b++;
    out += t.slice(from, a) + REDACTED;
    from = b;
  }
  return out + t.slice(from);
}

// redact(text, extraSecrets?) → text with every known and key-shaped secret
// replaced by <redacted>. extraSecrets: any iterable of strings.
export function redact(text, extraSecrets) {
  let t = typeof text === 'string' ? text : String(text);
  const extras = extrasOf(extraSecrets);
  for (const s of extras) if (t.includes(s)) t = t.split(s).join(REDACTED);
  for (const s of extras) {
    if (s.length < 2 * PART) continue;
    for (const p of [s.slice(0, PART), s.slice(-PART)]) if (t.includes(p)) t = takeRuns(t, p);
  }
  for (const re of KEYS) t = t.replace(re, REDACTED);
  for (const [re, to] of RULES) t = t.replace(re, to);
  return t;
}

// The key shapes only, for what's kept (KA-02, code health): a transcript row or a history row loses
// any key it quotes and no other word (the header and field rules would take what follows "password:"
// or "Authorization:" in a sentence). Unanchored, as redact() is: what's kept never under-redacts.
export function redactKeys(text) {
  if (typeof text !== 'string') return text;
  let t = text;
  for (const re of KEYS) t = t.replace(re, REDACTED);
  return t;
}

// A model's reply on its way to the game (KA-02, its follow-up b): the key shapes as keycheck sees
// them (proseKeyPatterns: bounded, or glued at a real key's length), so "risk-or-reward-ratio" stays
// a word in what the player reads while a key the reply quotes, glued or not, goes.
const PROSE_KEYS = proseKeyPatterns();
export function redactKeysInProse(text) {
  if (typeof text !== 'string') return text;
  let t = text;
  for (const re of PROSE_KEYS) t = t.replace(re, REDACTED);
  return t;
}

// An Error (or anything thrown) as one redacted string: the stack when there
// is one (it includes the message), else the message, else String(value).
export function redactError(err, extraSecrets) {
  let text;
  try { text = err instanceof Error ? (err.stack || `${err.name}: ${err.message}`) : String(err); } catch { text = 'unprintable error'; }
  return redact(text, extraSecrets);
}

// Crash output (§8.4 item 6): diagnostic reports without the environment, and
// uncaught errors (unhandled rejections arrive here too, under Node's default
// --unhandled-rejections=throw) printed through the redactor, then exit 1 as
// Node would. secrets() is read at crash time. Returns an uninstaller.
export function guardCrashOutput({ secrets = () => [], write = (s) => process.stderr.write(s), exit = (c) => process.exit(c) } = {}) {
  try { if (process.report) process.report.excludeEnv = true; } catch { /* older Node: no report */ }
  const onFatal = (err, origin) => {
    let extra = [];
    try { extra = [...(secrets() || [])]; } catch { /* keep the patterns */ }
    const head = origin === 'unhandledRejection' ? 'Unhandled rejection' : 'Uncaught exception';
    try { write(`${head}: ${redactError(err, extra)}\n`); } catch { /* stderr gone */ }
    exit(1);
  };
  process.on('uncaughtException', onFatal);
  return () => process.off('uncaughtException', onFatal);
}
