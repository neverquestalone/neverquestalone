// Canary keys (public PRD §8.4 item 5, B2.6): one fake key per provider, in
// each provider's real shape, so the redactor and keycheck treat them as keys.
// The integrator's gate runs the whole suite with these configured, then
// scanDirForCanaries() over everything the bridge wrote (logs, state, slots,
// SavedVariables fixtures, diagnostics, crash output): zero hits or CI fails.
//
// A hit is reported for the whole key, for its first 24 characters (a
// truncated log line still leaks), and for its base64 and base64url forms at
// any byte offset: base64 encodes 3 bytes as 4 characters, so a key inside a
// larger blob (Basic base64('user:' + key), a base64'd JSON body) encodes
// one of three ways, depending on its offset mod 3. One needle per offset,
// minus the leading characters the preceding bytes affect.
// No URL-encoded needle: every canary (like every real key shape) is made of
// characters encodeURIComponent leaves alone, so its URL-encoded form is the
// key itself, which the full and head needles already find.
// The canaries share 'CANARY' + 'xxx…', so a hit can also name a canary
// other than the one written; the gate only needs zero hits.
import fs from 'node:fs';
import path from 'node:path';

const fill = (n) => 'x'.repeat(n);

export const CANARY_KEYS = Object.freeze({
  anthropic: 'sk-ant-api03-CANARY' + fill(80),
  openai: 'sk-proj-CANARY' + fill(60) + 'T3BlbkFJ' + fill(20),
  openaiLegacy: 'sk-CANARY' + fill(39),
  google: 'AIzaCANARY' + fill(29),
  googleAuth: 'AQ.CANARY7' + fill(39), // a digit, as a real token has: a glued AQ. or xai- needs one (keycheck GLUED_SHAPES)
  xai: 'xai-CANARY7' + fill(75),
  openrouter: 'sk-or-v1-CANARY' + fill(58),
});

const HEAD = 24;
const B64_LEN = 40; // 30 bytes of the key

// The base64 of `key` preceded by `pad` bytes (0, 1 or 2), without the first
// 4 characters when pad > 0 (they mix the preceding bytes in) and without
// the tail (it mixes in what follows).
function base64Needles(key) {
  const out = [];
  for (const pad of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(pad), Buffer.from(key)]).toString('base64');
    const needle = b64.slice(pad ? 4 : 0, (pad ? 4 : 0) + B64_LEN);
    out.push({ form: 'base64', needle });
    const url = needle.replace(/\+/g, '-').replace(/\//g, '_');
    if (url !== needle) out.push({ form: 'base64', needle: url });
  }
  return out;
}

function needlesFor(provider, key) {
  return [
    { provider, form: 'full', needle: key },
    { provider, form: 'head', needle: key.slice(0, HEAD) },
    ...base64Needles(key).map(n => ({ provider, ...n })),
  ];
}

export function canaryNeedles(keys = CANARY_KEYS) {
  return Object.entries(keys).flatMap(([p, k]) => needlesFor(p, k));
}

// Every file under dir (symlinks not followed), as absolute paths.
function walk(dir, out = []) {
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, out);
    else if (d.isFile()) out.push(p);
  }
  return out;
}

// → [{ file, provider, form }] for every canary (or fragment) found; [] is a pass.
export function scanDirForCanaries(dir, { keys = CANARY_KEYS, skip = [] } = {}) {
  const needles = canaryNeedles(keys);
  const hits = [];
  for (const file of walk(dir)) {
    if (skip.some(s => file.includes(s))) continue;
    let buf;
    try { buf = fs.readFileSync(file); } catch { continue; }
    const seen = new Set();
    for (const { provider, form, needle } of needles) {
      const id = `${provider}:${form === 'full' ? 'head' : form}`;
      if (seen.has(id)) continue;
      if (buf.includes(needle)) {
        hits.push({ file, provider, form });
        seen.add(id);
      }
    }
  }
  return hits;
}
