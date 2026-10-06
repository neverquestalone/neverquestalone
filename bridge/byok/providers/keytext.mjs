// What a paste is (onboarding spec §3.4.2, §9.3; plan §3.2): one click on Paste key reads the
// clipboard in the main process, and this decides, from the text's shape alone, whether it's an
// API key and for which AI. Pure and synchronous, so the dialog can show in well under 100 ms with
// no call to the bridge. Nothing here logs, and nothing that isn't a key leaves it: a result carries
// the key only when the text is one.
//
//   normalizeKey(text)             the key as a player's paste usually wraps it, unwrapped
//   pasteShape(text, manifests)    → { key, id, hidden, reason }
//
// reason (null for a key of a known shape):
//   clipboard_empty     nothing there, or only spaces
//   not_a_key           anything else, including text over MAX_PASTE_BYTES (never read further)
//   subscription_token  a Claude sign-in token (sk-ant-oat01-…), which apps can't use
//   admin_key           an Anthropic or OpenAI admin key, which can't send messages
//   custom_key          an OpenRouter key (sk-or-…): it connects through Other (custom), with
//                       OpenRouter's base URL, never by its shape
// id is the AI the key belongs to (a manifest id: a Google key, AIza…, is Gemini's, by the google
// manifest's keyPattern); hidden: that AI is hidden by the manifests (the window names it and offers
// the others).
import { pickProviderForKey } from './index.mjs';

/** Past this, a paste isn't read as a key at all (a key is under 300 bytes). */
export const MAX_PASTE_BYTES = 4096;

// Zero-width characters, text-direction marks, the BOM and every kind of space or line break: a
// key has none, and a paste from a chat or a PDF often does.
const INVISIBLE = /[\s\u00a0\u1680\u180e\u2000-\u200f\u2028-\u202f\u205f-\u206f\u3000\ufeff]/g;
const QUOTES = /^(["'`\u201c\u201d\u2018\u2019])([\s\S]*)(["'`\u201c\u201d\u2018\u2019])$/;
const KEY_CHARS = /^[A-Za-z0-9._~+/=-]+$/;

function unquote(s) {
  let out = s;
  for (let i = 0; i < 3; i++) {
    const m = QUOTES.exec(out);
    if (!m) break;
    out = m[2].trim();
  }
  return out;
}

/**
 * The key inside a paste as players copy it: surrounding quotes or backticks, "Bearer ", "export
 * NAME=" and "NAME=" (a line from a .env file or a shell), wrapped lines, zero-width characters and
 * a BOM go. Anything else is left as it is.
 */
export function normalizeKey(text) {
  let s = String(text ?? '').replace(/^\ufeff/, '').trim();
  s = unquote(s);
  s = s.replace(/^export\s+/i, '');
  s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*/, '');
  s = unquote(s.trim());
  s = s.replace(/^Bearer\s+/i, '');
  return s.replace(INVISIBLE, '');
}

// Look-alikes that aren't API keys an app can use, checked before the manifests' shapes.
//
// Any other sk-ant-<kind>- key goes to Anthropic, whose one test request decides (2026-10-05: a
// player's key began sk-ant-usr-, which the old sk-ant-api-only shape turned away as not a key).
const LOOKALIKES = [
  { re: /^sk-ant-(?:oat|ort|sid)\d{2}-/, id: 'anthropic', reason: 'subscription_token' },
  { re: /^sk-ant-admin\d{2}-/, id: 'anthropic', reason: 'admin_key' },
  { re: /^sk-admin-/, id: 'openai', reason: 'admin_key' },
  // carry: an OpenRouter key is no card's, but Other can use it: it is handed on (as carry, never as
  // key) so the hand-off to Other's form keeps it (DU-44).
  { re: /^sk-or-/, id: 'custom', reason: 'custom_key', carry: true },
];

/**
 * pasteShape(text, manifests) → { key, id, hidden, reason, carry? }. key is set only for a key of a
 * known shape; every other result has key null, so the text goes no further than this call, except an
 * OpenRouter key, handed on as carry for Other's form (DU-44).
 */
export function pasteShape(text, manifests) {
  const raw = typeof text === 'string' ? text : '';
  const none = reason => ({ key: null, id: null, hidden: false, reason });
  if (!raw.trim()) return none('clipboard_empty');
  if (Buffer.byteLength(raw, 'utf8') > MAX_PASTE_BYTES) return none('not_a_key');
  const key = normalizeKey(raw);
  if (!key) return none('clipboard_empty');
  for (const l of LOOKALIKES) {
    if (!l.re.test(key)) continue;
    const r = { key: null, id: l.id, hidden: false, reason: l.reason };
    if (l.carry && key.length >= 20 && key.length <= 512 && KEY_CHARS.test(key)) r.carry = key;
    return r;
  }
  if (key.length < 20 || key.length > 512 || !KEY_CHARS.test(key)) return none('not_a_key');
  const p = pickProviderForKey(key, manifests);
  if (p.id) return { key, id: p.id, hidden: !!p.hidden, reason: null };
  if (p.reason === 'admin_key') return { key: null, id: p.provider ?? null, hidden: false, reason: 'admin_key' };
  return none('not_a_key');
}
