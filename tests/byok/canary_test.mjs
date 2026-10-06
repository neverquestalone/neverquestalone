// B2.6's tools: the canary keys are key-shaped (so every guard treats them as
// keys), and scanDirForCanaries finds a whole, truncated or base64 canary
// (at any offset inside a larger base64 blob) anywhere under a folder, and
// nothing in a clean one. A URL-encoded canary is the canary itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CANARY_KEYS, canaryNeedles, scanDirForCanaries } from './helpers/canary.mjs';
import { keyShape } from '../../bridge/byok/security/keycheck.mjs';
import { redact } from '../../bridge/byok/security/redact.mjs';

test('canary: one per provider shape, each recognised as that provider\'s key and redacted', () => {
  const expect = { anthropic: 'anthropic', openai: 'openai', openaiLegacy: 'openai', google: 'google', googleAuth: 'google', xai: 'xai', openrouter: 'openrouter' };
  for (const [name, key] of Object.entries(CANARY_KEYS)) {
    assert.equal(keyShape(key), expect[name], name);
    assert.equal(redact(key), '<redacted>', name);
    assert.ok(key.includes('CANARY'));
  }
  assert.ok(canaryNeedles().length >= Object.keys(CANARY_KEYS).length * 5);
});

test('canary: URL-encoding leaves every canary unchanged, so the full needle covers that form', () => {
  for (const [name, key] of Object.entries(CANARY_KEYS)) {
    assert.equal(encodeURIComponent(key), key, name);
    assert.equal(new URLSearchParams({ key }).toString(), `key=${key}`, name);
  }
});

test('canary: base64 at every byte offset: Basic auth, a base64\'d JSON body, base64url', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-canary-b64-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = (rel, data) => { fs.writeFileSync(path.join(dir, rel), data); return rel; };
  const want = [];
  for (const [name, key] of Object.entries(CANARY_KEYS)) {
    for (const [i, prefix] of ['', 'u', 'us', 'user:', '{"apiKey":"'].entries()) {
      want.push([w(`${name}-${i}.txt`, `Authorization: Basic ${Buffer.from(`${prefix}${key}"}`).toString('base64')}`), name]);
      want.push([w(`${name}-${i}-url.txt`, Buffer.from(`${prefix}${key}`).toString('base64url')), name]);
    }
  }
  w('clean.txt', `Authorization: Basic ${Buffer.from('user:not-a-canary-0123456789abcdef0123456789').toString('base64')}`);
  const hits = scanDirForCanaries(dir).map(h => [path.relative(dir, h.file), h.provider, h.form]);
  for (const [f, name] of want) assert.ok(hits.some(([hf, p, form]) => hf === f && p === name && form === 'base64'), `${f}: ${name} not found`);
  // The canaries share 'CANARY' + 'xxx…', so one blob may also match another canary's needle.
  assert.ok(hits.every(([, , form]) => form === 'base64'));
  assert.deepEqual(new Set(hits.map(([f]) => f)), new Set(want.map(([f]) => f)), 'the clean file has no hit');
});

test('canary: the scan finds whole, truncated, base64 and URL-encoded canaries, nested and in binary files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-canary-'));
  const w = (rel, data) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
  w('clean/log.jsonl', '{"kind":"start"}\n{"kind":"provider_error","message":"401 <redacted>"}\n');
  const full = w('logs/bridge.jsonl', `{"k":"${CANARY_KEYS.anthropic}"}`);
  const cut = w('deep/a/b/slot.lua', `NQA_SlotData = { x = "${CANARY_KEYS.xai.slice(0, 30)}…" }`);
  const b64 = w('diag/export.txt', Buffer.from(CANARY_KEYS.google).toString('base64'));
  const url = w('state/last-request.json', `https://x.test/?key=${encodeURIComponent(CANARY_KEYS.googleAuth)}`);
  const bin = w('SavedVariables/NeverQuestAlone.bin', Buffer.concat([Buffer.from([0, 1, 2, 255]), Buffer.from(CANARY_KEYS.openrouter), Buffer.from([0])]));
  const hits = scanDirForCanaries(dir);
  const got = hits.map(h => [path.relative(dir, h.file), h.provider, h.form]).sort();
  assert.deepEqual(got, [
    [path.relative(dir, bin), 'openrouter', 'full'],
    [path.relative(dir, cut), 'xai', 'head'],
    [path.relative(dir, b64), 'google', 'base64'],
    [path.relative(dir, full), 'anthropic', 'full'],
    [path.relative(dir, url), 'googleAuth', 'full'],
  ].sort());
  assert.deepEqual(scanDirForCanaries(path.join(dir, 'clean')), []);
  assert.deepEqual(scanDirForCanaries(dir, { skip: ['logs', 'deep', 'diag', 'state', 'SavedVariables'] }), []);
  assert.deepEqual(scanDirForCanaries(path.join(dir, 'missing')), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
