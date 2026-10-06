// Redaction for anything the desktop shell hands to the renderer, the clipboard or its log (BYOK
// PRD §8.4 item 7, KY-9, SL-7). One redactor (systems plan SY-13): the bridge's redact()
// (bridge/byok/security/redact.mjs: every key shape in keycheck.mjs KEY_SHAPES, auth headers
// whatever their scheme, key-like query parameters and fields, the OAuth code and verifier, JWTs),
// then the home folder as "~". The shell keeps no patterns of its own, so shell.log can't be
// weaker than the bridge's log. Pure functions, once the bridge's module is loaded.
import os from 'node:os';
import { importBridge } from './bridge-module.mjs';

const { redact, REDACTED } = await importBridge('bridge/byok/security/redact.mjs');
const { maskKey: bridgeMaskKey } = await importBridge('bridge/byok/security/keystore.mjs');

export { REDACTED };

// Object keys whose values are credentials whatever they look like.
const SECRET_NAMES = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api[-_]?key|apikey|token|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|code[-_]?verifier|secret|password|install[-_]?token)$/i;
// A value that's already a mask ("sk-ant-…A1b2 (redacted)", "[redacted]", "<redacted>").
const ALREADY_MASKED = /…|\(redacted\)|\[redacted\]|<redacted>/;

/** Redact key shapes, credential headers and fields, exact extras (the bridge's redact), then the home folder. */
export function redactText(text, { extra = [], home = os.homedir() } = {}) {
  let s = redact(String(text ?? ''), extra);
  if (home && home.length > 1) s = s.split(home).join('~');
  return s;
}

/**
 * Deep-copy a JSON-like value with every string redacted and every
 * credential-named field replaced (unless it is already a mask such as
 * "sk-ant-…A1b2 (redacted)"). Functions and symbols are dropped; depth is capped.
 */
export function redactDeep(value, opts = {}, depth = 0) {
  if (depth > 12) return REDACTED;
  if (typeof value === 'string') return redactText(value, opts);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 5000).map(v => redactDeep(v, opts, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      if (SECRET_NAMES.test(k) && typeof v === 'string' && !ALREADY_MASKED.test(v)) out[k] = REDACTED;
      else out[k] = redactDeep(v, opts, depth + 1);
    }
    return out;
  }
  return undefined;
}

/**
 * The keys a log line must never carry, whatever their shape (a key stageKey took that matches no
 * pattern, in an exception message): ones added by value (the bridge registers every key it reads or
 * stores; bridgeLogger forwards them) and ones read from a source when a line is written (the key
 * stager's staged keys). list() never throws.
 */
export function secretSet() {
  const known = new Set();
  const sources = [];
  return {
    add(s) { if (typeof s === 'string' && s.length >= 8) known.add(s); },
    from(fn) { if (typeof fn === 'function') sources.push(fn); },
    list() {
      const out = [...known];
      for (const fn of sources) {
        try { for (const s of fn() ?? []) if (typeof s === 'string' && s.length >= 8) out.push(s); } catch { /* the patterns still apply */ }
      }
      return out;
    },
  };
}

/** "sk-ant-…A1b2": the key store's own mask (bridge/byok/security/keystore.mjs maskKey). */
export function maskKey(key) {
  return bridgeMaskKey(key);
}
