// Key shapes (PRD §8.1 KY-10, §8.4 item 7): does this text look like a
// provider API key? The addon refuses to send such a message before it
// reaches history, and the bridge checks again with looksLikeKey().
//
// One table, KEY_SHAPES, feeds three consumers so they can't drift:
//   - looksLikeKey / keyShape here (a left word boundary, so "task-…" or
//     "desk-…" never trip it; GLUED_SHAPES then catch a real-length key glued
//     to the word before it);
//   - redact.mjs: redact() uses the same prefixes and lengths unanchored (it may
//     over-redact a log line; it must never under-redact), and so does
//     redactKeys() for what's kept; redactKeysInProse(), for a reply the player
//     reads, the bounded and glued shapes as here (proseKeyPatterns);
//   - the addon's Lua twin (LUA_KEY_PATTERNS / luaKeyCheckSource()).
//
// The Lua twin, for the addon (Lua 5.1, WoW's C locale):
//   Lua patterns have no alternation and no {n,} counts, so each shape is its
//   own pattern and a minimum length is the class written out n times. The
//   JS left boundary (?<![A-Za-z0-9]) is Lua's frontier %f[%w]. %w is
//   [A-Za-z0-9] in the C locale, [%w_%-] is [A-Za-z0-9_-]. Regenerate the
//   addon's copy with:
//     node -e "import('./bridge/byok/security/keycheck.mjs').then(m => console.log(m.luaKeyCheckSource()))"
//   tests/byok/keycheck_test.mjs runs the twin in fengari (and LuaJIT when
//   installed) against the same corpus as the JS and fails on any mismatch.

// cls: which characters may follow the prefix. min: how many at least.
const CLASSES = {
  alnum: { js: '[A-Za-z0-9]', lua: '%w' },
  word: { js: '[A-Za-z0-9_]', lua: '[%w_]' },
  alnumDash: { js: '[A-Za-z0-9-]', lua: '[%w%-]' },
  wordDash: { js: '[A-Za-z0-9_-]', lua: '[%w_%-]' },
};

// Order matters for keyShape(): the specific sk- prefixes before legacy sk-. OpenAI's keys made outside
// a project (sk-None-) and Groq's (gsk_, 52 letters and digits) went through Other unrefused and
// unredacted (code health BR-08).
export const KEY_SHAPES = Object.freeze([
  { provider: 'anthropic', prefix: 'sk-ant-', cls: 'wordDash', min: 10 },
  { provider: 'openai', prefix: 'sk-proj-', cls: 'wordDash', min: 10 },
  { provider: 'openai', prefix: 'sk-svcacct-', cls: 'wordDash', min: 10 },
  { provider: 'openai', prefix: 'sk-admin-', cls: 'wordDash', min: 10 },
  { provider: 'openai', prefix: 'sk-None-', cls: 'wordDash', min: 10 },
  { provider: 'openrouter', prefix: 'sk-or-', cls: 'alnumDash', min: 10 },
  { provider: 'openai', prefix: 'sk-', cls: 'alnum', min: 20 }, // legacy OpenAI
  { provider: 'google', prefix: 'AIza', cls: 'wordDash', min: 35 },
  { provider: 'google', prefix: 'AQ.', cls: 'wordDash', min: 20 },
  { provider: 'xai', prefix: 'xai-', cls: 'word', min: 20 },
  { provider: 'groq', prefix: 'gsk_', cls: 'alnum', min: 20 },
].map(Object.freeze));

const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
const luaEscape = (s) => s.replace(/[\^$()%.[\]*+\-?]/g, '%$&');

// The body of a shape's JS regex, without a boundary (redact.mjs adds none).
// Exact-length shapes (AIza…{35}) are still written {min,}: a longer run is
// at least as suspicious, and redaction must take the whole run.
export function shapeSource(shape) {
  return `${reEscape(shape.prefix)}${CLASSES[shape.cls].js}{${shape.min},}`;
}

const BOUNDED = KEY_SHAPES.map(s => ({ provider: s.provider, re: new RegExp(`(?<![A-Za-z0-9])${shapeSource(s)}`) }));

// Glued (KB-02, KA-02): a key pasted straight after a word or a digit ("my key is" + paste,
// "key2" + key) has no boundary before it. The distinctive prefixes are checked again with none,
// and with a real key's length after them (40 at least; AIza's is exactly 35). The legacy sk-
// ends too many words ("risk-", "task-") and stays bounded only. Prose can run that long after
// the prefixes that end ordinary words ("task-admin-panel-settings-…", a URL's "task-proj-…"
// slug, "FAQ." or "maxai-" before words joined by no-break spaces: the keys verifier's probe1),
// so those (`digit`) also need a digit in the run after the prefix, as every real key of that
// length has. The ones without come first: the Lua twin checks them in one list, then these.
export const GLUED_SHAPES = Object.freeze([
  { provider: 'anthropic', prefix: 'sk-ant-api', cls: 'wordDash', min: 40 },
  { provider: 'anthropic', prefix: 'sk-ant-admin', cls: 'wordDash', min: 40 },
  { provider: 'anthropic', prefix: 'sk-ant-oat', cls: 'wordDash', min: 40 },
  { provider: 'openrouter', prefix: 'sk-or-v1-', cls: 'alnum', min: 40 },
  { provider: 'google', prefix: 'AIza', cls: 'wordDash', min: 35 },
  { provider: 'groq', prefix: 'gsk_', cls: 'alnum', min: 40 },
  { provider: 'openai', prefix: 'sk-proj-', cls: 'wordDash', min: 40, digit: true },
  { provider: 'openai', prefix: 'sk-svcacct-', cls: 'wordDash', min: 40, digit: true },
  { provider: 'openai', prefix: 'sk-admin-', cls: 'wordDash', min: 40, digit: true },
  { provider: 'openai', prefix: 'sk-None-', cls: 'wordDash', min: 40, digit: true },
  { provider: 'google', prefix: 'AQ.', cls: 'wordDash', min: 40, digit: true },
  { provider: 'xai', prefix: 'xai-', cls: 'word', min: 40, digit: true },
].map(Object.freeze));

/** A glued shape's JS regex body: no boundary, and for a `digit` shape a digit somewhere in the run. */
export function gluedSource(shape) {
  const cls = CLASSES[shape.cls].js;
  return `${reEscape(shape.prefix)}${shape.digit ? `(?=${cls}*[0-9])` : ''}${cls}{${shape.min},}`;
}

const GLUED = GLUED_SHAPES.map(s => ({ provider: s.provider, re: new RegExp(gluedSource(s)) }));

/**
 * The key shapes for prose (redact.mjs redactKeysInProse): the bounded ones and the glued ones, as
 * looksLikeKey sees them, and the legacy sk- unanchored, so a reply's "risk-or-reward-ratio" stays
 * a word (the keys verifier's follow-up b) while a key, glued or not, goes. Fresh global regexes
 * each call.
 */
export function proseKeyPatterns() {
  return [
    ...KEY_SHAPES.map(s => new RegExp(`(?<![A-Za-z0-9])${shapeSource(s)}`, 'g')),
    ...GLUED_SHAPES.map(s => new RegExp(gluedSource(s), 'g')),
    // The legacy sk- glued too: 20 letters and digits with no dash after it is no word's ending.
    ...KEY_SHAPES.filter(s => s.prefix === 'sk-').map(s => new RegExp(shapeSource(s), 'g')),
  ];
}

// The provider whose key shape appears in text, or null.
export function keyShape(text) {
  if (typeof text !== 'string' || text.length < 13) return null;
  for (const { provider, re } of BOUNDED) if (re.test(text)) return provider;
  for (const { provider, re } of GLUED) if (re.test(text)) return provider;
  return null;
}

export function looksLikeKey(text) {
  return keyShape(text) !== null;
}

// One Lua pattern per shape: %f[%w] + escaped prefix + the class min times.
export const LUA_KEY_PATTERNS = Object.freeze(
  KEY_SHAPES.map(s => `%f[%w]${luaEscape(s.prefix)}${CLASSES[s.cls].lua.repeat(s.min)}`),
);

// The glued shapes' twins: the same, with no frontier; a `digit` shape's takes the whole run
// (the class once more with *), so the checker can look for a digit in it.
export const LUA_GLUED_PATTERNS = Object.freeze(
  GLUED_SHAPES.map(s => `${luaEscape(s.prefix)}${CLASSES[s.cls].lua.repeat(s.min)}${s.digit ? `${CLASSES[s.cls].lua}*` : ''}`),
);

// A Lua 5.1 chunk that defines the checker. `assign` is the left-hand side,
// e.g. 'local LooksLikeKey' or 'ns.LooksLikeKey'.
export function luaKeyCheckSource({ assign = 'local LooksLikeKey' } = {}) {
  const plain = GLUED_SHAPES.map((s, i) => (s.digit ? null : LUA_GLUED_PATTERNS[i])).filter(Boolean);
  const digit = GLUED_SHAPES.map((s, i) => (s.digit ? `{ "${LUA_GLUED_PATTERNS[i]}", ${s.prefix.length} }` : null)).filter(Boolean);
  return [
    '-- KY-10: generated from bridge/byok/security/keycheck.mjs (KEY_SHAPES, GLUED_SHAPES); do not edit by hand.',
    'local KEY_PATTERNS = {',
    [...LUA_KEY_PATTERNS, ...plain].map(p => `\t"${p}",`).join('\n'),
    '}',
    '-- Glued shapes that also need a digit in the run after the prefix: { pattern, prefix length }.',
    'local KEY_DIGIT_PATTERNS = {',
    digit.map(p => `\t${p},`).join('\n'),
    '}',
    `${assign} = function(s)`,
    '\tif type(s) ~= "string" or #s < 13 then return false end',
    '\tfor i = 1, #KEY_PATTERNS do',
    '\t\tif string.find(s, KEY_PATTERNS[i]) then return true end',
    '\tend',
    '\tfor i = 1, #KEY_DIGIT_PATTERNS do',
    '\t\tlocal p, n, init = KEY_DIGIT_PATTERNS[i][1], KEY_DIGIT_PATTERNS[i][2], 1',
    '\t\twhile true do',
    '\t\t\tlocal a, b = string.find(s, p, init)',
    '\t\t\tif not a then break end',
    '\t\t\tif string.find(string.sub(s, a + n, b), "%d") then return true end',
    '\t\t\tinit = a + 1',
    '\t\tend',
    '\tend',
    '\treturn false',
    'end',
    '',
  ].join('\n');
}
