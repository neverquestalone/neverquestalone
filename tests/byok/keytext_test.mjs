// What a paste is (bridge/byok/providers/keytext.mjs; onboarding spec §3.4.2, §9.3): one click on
// Paste key reads the clipboard in main, and the text's shape alone says whether it's a key and for
// which AI. Keys are canaries; nothing here touches a key store or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, pasteShape, MAX_PASTE_BYTES } from '../../bridge/byok/providers/keytext.mjs';
import { loadManifests } from '../../bridge/byok/providers/index.mjs';
import { CANARY_KEYS } from './helpers/byok-env.mjs';

const MS = loadManifests();
const ANT = `sk-ant-api03-CANARY${'x'.repeat(80)}`;
const ZW = ['​', '‌', '‍', '⁠', '﻿', '‮'];

test('normalizeKey: quotes, backticks, Bearer, export NAME=, NAME=, wrapped lines, zero-width characters and a BOM go', () => {
  const cases = [
    [ANT, 'as is'],
    [` ${ANT}  `, 'spaces'],
    [`"${ANT}"`, 'double quotes'],
    [`'${ANT}'`, 'single quotes'],
    [`\`${ANT}\``, 'backticks'],
    [`“${ANT}”`, 'curly quotes'],
    [`Bearer ${ANT}`, 'Bearer'],
    [`export ANTHROPIC_API_KEY=${ANT}`, 'export NAME='],
    [`ANTHROPIC_API_KEY="${ANT}"`, 'NAME="…"'],
    [`ANTHROPIC_API_KEY: ${ANT}`, 'NAME: (YAML)'],
    [`${ANT.slice(0, 30)}\n${ANT.slice(30, 60)}\r\n${ANT.slice(60)}`, 'wrapped lines'],
    [`﻿${ANT}`, 'a BOM'],
    ...ZW.map(z => [`${ANT.slice(0, 20)}${z}${ANT.slice(20)}`, `U+${z.charCodeAt(0).toString(16)}`]),
  ];
  for (const [text, why] of cases) assert.equal(normalizeKey(text), ANT, why);
});

test('pasteShape: every manifest’s key shape picks its AI; the key comes back only then', () => {
  for (const [id, key] of Object.entries(CANARY_KEYS)) {
    const m = MS.find(x => x.id === id);
    if (!m || !m.keyPattern) continue;
    const r = pasteShape(key, MS);
    assert.equal(r.id, id, id);
    assert.equal(r.reason, null, id);
    assert.equal(r.key, key, id);
  }
  assert.equal(pasteShape(ANT, MS).id, 'anthropic');
  assert.equal(pasteShape(`sk-proj-CANARY${'x'.repeat(60)}`, MS).id, 'openai');
  assert.equal(pasteShape(`xai-CANARY${'x'.repeat(40)}`, MS).id, 'xai');
  assert.equal(pasteShape(`AIza${'C'.repeat(35)}`, MS).id, 'google', 'a Google key is Gemini’s');
  assert.equal(pasteShape(CANARY_KEYS.google, MS).key, CANARY_KEYS.google);
});

test('pasteShape: the look-alikes (a Claude sign-in token, admin keys, an OpenRouter key) are named and never returned', () => {
  const look = [
    [`sk-ant-oat01-CANARY${'x'.repeat(60)}`, 'subscription_token', 'anthropic'],
    [`sk-ant-admin01-CANARY${'x'.repeat(60)}`, 'admin_key', 'anthropic'],
    [`sk-admin-CANARY${'x'.repeat(40)}`, 'admin_key', 'openai'],
    // An OpenRouter key connects through Other (custom), with OpenRouter's address: never by its shape.
    [`sk-or-v1-CANARY${'x'.repeat(56)}`, 'custom_key', 'custom'],
  ];
  for (const [text, reason, id] of look) {
    const r = pasteShape(text, MS);
    assert.equal(r.reason, reason, text.slice(0, 16));
    assert.equal(r.id, id);
    assert.equal(r.key, null, 'never returned');
    // [DU-44] Only the OpenRouter key is handed on (as carry, for Other's form); the others go no further.
    assert.equal(r.carry, reason === 'custom_key' ? text : undefined);
  }
});

test('pasteShape: empty, not a key, and over 4 KB (not read as a key at all)', () => {
  assert.equal(pasteShape('', MS).reason, 'clipboard_empty');
  assert.equal(pasteShape('   \n\t', MS).reason, 'clipboard_empty');
  assert.equal(pasteShape(undefined, MS).reason, 'clipboard_empty');
  for (const t of ['where do I turn in this quest', 'short', '<script>alert(1)</script>', 'sk-ant-nope', `sk-ant-${'‮'}abcdefghijklmnopqrstuvwxyz`]) {
    const r = pasteShape(t, MS);
    assert.equal(r.reason, 'not_a_key', t.slice(0, 20));
    assert.equal(r.key, null);
    assert.equal(r.id, null);
  }
  const big = `${ANT} ${'x'.repeat(MAX_PASTE_BYTES)}`;
  assert.equal(pasteShape(big, MS).reason, 'not_a_key', 'over 4 KB');
  assert.equal(pasteShape(big, MS).key, null);
});

test('keytext never logs and never echoes text that isn’t a key', () => {
  const seen = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => seen.push(a.join(' '));
  try {
    const secretish = 'my password is hunter2 and my bank pin is 1234';
    const r = pasteShape(secretish, MS);
    assert.ok(!JSON.stringify(r).includes('hunter2'), 'the result carries none of it');
    pasteShape(ANT, MS);
  } finally { Object.assign(console, orig); }
  assert.deepEqual(seen, [], 'nothing logged');
});
