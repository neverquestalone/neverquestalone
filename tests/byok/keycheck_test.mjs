// KY-10: key-shaped text is recognised by the bridge (looksLikeKey) and by the
// addon's Lua twin, and the two agree on every sample (fengari, plus LuaJIT
// as real Lua 5.1 when it's installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { looksLikeKey, keyShape, KEY_SHAPES, LUA_KEY_PATTERNS, luaKeyCheckSource } from '../../bridge/byok/security/keycheck.mjs';
import * as keycheck from '../../bridge/byok/security/keycheck.mjs';
import { CANARY_KEYS } from './helpers/canary.mjs';
import { newLuaVM } from '../helpers/luavm.mjs';

// KB-02, KA-02: a key pasted straight after a word or a digit, with no space ("my key is" + paste).
const TAIL = 'CANARY' + 'aB3'.repeat(25); // 81 characters, as long as a real key's tail
const GLUED = [
  [`my key is${CANARY_KEYS.anthropic}`, 'anthropic'],
  [`key2${CANARY_KEYS.openai}`, 'openai'],
  [`apikey${CANARY_KEYS.openrouter}`, 'openrouter'],
  [`mykey${CANARY_KEYS.xai}`, 'xai'],
  [`gkey${CANARY_KEYS.google}`, 'google'],
  [`token${CANARY_KEYS.googleAuth}`, 'google'],
  [`key1sk-proj-${TAIL}`, 'openai'],
  [`adminsk-svcacct-${TAIL}`, 'openai'],
  [`adminsk-admin-${TAIL}`, 'openai'],
  [`mykeysk-ant-admin01-${TAIL}`, 'anthropic'],
  [`mykeysk-ant-oat01-${TAIL}`, 'anthropic'],
  [`abcsk-or-v1-${'0123456789abcdef'.repeat(4)}`, 'openrouter'],
  [`xAIzaSy${'CANARYaB3'.repeat(3)}012345`, 'google'],
];

const POSITIVE = [
  ...GLUED.map(([s]) => s),
  ...Object.values(CANARY_KEYS),
  `my key is ${CANARY_KEYS.anthropic}, right?`,
  `(${CANARY_KEYS.openai})`,
  `"${CANARY_KEYS.google}"`,
  `key=${CANARY_KEYS.xai}`,
  `${CANARY_KEYS.openrouter}\n`,
  'sk-ant-admin01-abcdefghijklmnop',
  'sk-svcacct-ABCDEFGHIJ1234',
  'sk-admin-ABCDEFGHIJ1234',
  'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD',
  'AIzaFAKE-not-a-real-google-key-00000000', // gitleaks:allow (a fake key)
  'AQ.Ab8RN6abcdefghijklmnopqrstuv',
  'xai-abcdefghijklmnopqrstuvwxyz',
  'sk-or-v1-0123456789abcdef0123456789abcdef',
  '_sk-ant-api03-abcdefghijklmn',
];

const NEGATIVE = [
  '',
  'hello there, where is the Deadmines?',
  'what does sk-ant mean?',
  'sk-ant-short',
  'the task-managementframeworkthingamajig is fine',
  'desk-ant-api03-abcdefghijklmnopqrstuv',
  'risk-abcdefghijklmnopqrstuvwxyz0123',
  'AIza is a prefix',
  'AIzaSyShort',
  'AQ.quest',
  'xai-short',
  'sk-or- is OpenRouter',
  'Kill 10 Defias Pillagers (sk-5)',
  'I sold 20 sk-items',
  // Words that end like a key's prefix begins, glued to what follows: under a real key's length.
  'brisk-admin-panel-open-now-please-thanks',
  'risk-proj-plan-for-the-raid-tonight-ok',
  'whisk-proj-thing is done',
  'desk-ant-colony-members-are-many-here',
  'the task-admin-dashboard is down for the whole guild raid tonight sorry',
  'task-proj-abcdefghijklmnopqrstuvwxyz',
  'desk-or-countertop-and-a-chair',
  'the maxai-bot said hi',
  'FAQ.readme first',
  // Long ones (the keys verifier's probe1): prose runs a key's length, but a key has a digit in it.
  'the task-admin-panel-settings-page-is-broken-again-for-everyone-in-the-guild',
  'see https://example.com/guides/task-proj-management-for-raid-leaders-and-officers-guide',
  'FAQ.pleasereadthefaqbeforeaskingquestionsinguildchat',
  'maxai-bot_says_hello_to_everyone_in_the_guild_today_ok',
  'adminsk-svcacct-pleasereadthefaqbeforeaskingquestionsinguildchat',
];

test('keycheck: every provider shape is caught, in context too', () => {
  for (const s of POSITIVE) assert.equal(looksLikeKey(s), true, `should flag: ${s.slice(0, 30)}`);
});

test('keycheck: ordinary chat is not a key', () => {
  for (const s of NEGATIVE) assert.equal(looksLikeKey(s), false, `should pass: ${s}`);
  assert.equal(looksLikeKey(null), false);
  assert.equal(looksLikeKey(42), false);
});

test('keycheck: keyShape names the provider, specific sk- prefixes first', () => {
  assert.equal(keyShape(CANARY_KEYS.anthropic), 'anthropic');
  assert.equal(keyShape(CANARY_KEYS.openai), 'openai');
  assert.equal(keyShape(CANARY_KEYS.openaiLegacy), 'openai');
  assert.equal(keyShape(CANARY_KEYS.openrouter), 'openrouter');
  assert.equal(keyShape(CANARY_KEYS.google), 'google');
  assert.equal(keyShape(CANARY_KEYS.googleAuth), 'google');
  assert.equal(keyShape(CANARY_KEYS.xai), 'xai');
  assert.equal(keyShape('nothing here'), null);
});

test('keycheck: one Lua pattern per shape, 5.1-safe (no alternation, no counts)', () => {
  assert.equal(LUA_KEY_PATTERNS.length, KEY_SHAPES.length);
  for (const p of LUA_KEY_PATTERNS) {
    assert.ok(p.startsWith('%f[%w]'), p);
    assert.doesNotMatch(p, /[|{}\\]/, p);
  }
});

test('keycheck (KB-02, KA-02): a key glued to the word or digit before it is still a key, and names its provider', () => {
  for (const [s, provider] of GLUED) {
    assert.equal(looksLikeKey(s), true, `should flag: ${s.slice(0, 24)}`);
    assert.equal(keyShape(s), provider, s.slice(0, 24));
  }
});

test('keycheck (KB-02): the glued patterns have no boundary, a real key\'s length, and are 5.1-safe; the Lua list is the bounded ones, then these', () => {
  const glued = keycheck.LUA_GLUED_PATTERNS;
  assert.ok(Array.isArray(glued) && glued.length === keycheck.GLUED_SHAPES.length, 'one Lua pattern per glued shape');
  for (const p of glued) {
    assert.ok(!p.startsWith('%f'), p);
    assert.doesNotMatch(p, /[|{}\\]/, p);
  }
  for (const s of keycheck.GLUED_SHAPES) assert.ok(s.min >= 35, `${s.prefix}: a real key's length`);
  const src = luaKeyCheckSource();
  const at = p => src.indexOf(`"${p}"`);
  assert.ok([...LUA_KEY_PATTERNS, ...glued].every((p, i, all) => at(p) > 0 && (i === 0 || at(p) > at(all[i - 1]))), 'every pattern, in order');
});

// code health BR-08: two shapes that went through "Other" unrefused and unredacted: OpenAI's keys
// made outside a project (sk-None-…) and Groq's (gsk_ and 52 letters and digits).
const NONE_KEY = `sk-None-${'aB3dE5fG7h'.repeat(5)}Kq`;
const GROQ_KEY = `gsk_${'aB3dE5fG7h'.repeat(5)}Kq`;
const BR08_POSITIVE = [
  [NONE_KEY, 'openai'], [GROQ_KEY, 'groq'], [`my key is ${NONE_KEY}, ok?`, 'openai'], [`(${GROQ_KEY})`, 'groq'],
  [`key2${NONE_KEY}`, 'openai'], [`apikey${GROQ_KEY}`, 'groq'],
];
const BR08_NEGATIVE = ['sk-None of these work', 'gsk_short', 'the gsk_ prefix is Groq\'s', 'abcsk-None-pleasereadthefaqbeforeaskingquestionsinguildchat'];

test('keycheck (code health BR-08): OpenAI sk-None- and Groq gsk_ keys are keys, bounded or glued; their prose look-alikes aren\'t', () => {
  for (const [s, provider] of BR08_POSITIVE) {
    assert.equal(looksLikeKey(s), true, `should flag: ${s.slice(0, 24)}`);
    assert.equal(keyShape(s), provider, s.slice(0, 24));
  }
  for (const s of BR08_NEGATIVE) assert.equal(looksLikeKey(s), false, `should pass: ${s}`);
  const vm = newLuaVM();
  vm.run(luaKeyCheckSource({ assign: 'LooksLikeKey' }));
  const samples = [...BR08_POSITIVE.map(([s]) => s), ...BR08_NEGATIVE];
  const lua = luaVerdicts(vm, samples);
  samples.forEach((s, i) => assert.equal(lua[i], looksLikeKey(s), `Lua and JS disagree on: ${s.slice(0, 40)}`));
});

function luaVerdicts(vm, samples) {
  return samples.map((s, i) => {
    vm.run(`R_${i} = LooksLikeKey(${JSON.stringify(s).replace(/\\u([0-9a-f]{4})/g, (_, h) => `\\${parseInt(h, 16)}`)})`);
    return vm.global(`R_${i}`);
  });
}

test('keycheck: the Lua twin agrees with the JS on every sample (fengari)', () => {
  const vm = newLuaVM();
  vm.run(luaKeyCheckSource({ assign: 'LooksLikeKey' }));
  const samples = [...POSITIVE, ...NEGATIVE];
  const lua = luaVerdicts(vm, samples);
  samples.forEach((s, i) => assert.equal(lua[i], looksLikeKey(s), `Lua and JS disagree on: ${s.slice(0, 40)}`));
});

const luajit = spawnSync('luajit', ['-v'], { encoding: 'utf8' });
test('keycheck: the Lua twin agrees in real Lua 5.1 (LuaJIT)', { skip: luajit.status === 0 ? false : 'luajit is not installed (brew install luajit)' }, () => {
  const samples = [...POSITIVE, ...NEGATIVE];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-keycheck-'));
  const file = path.join(dir, 'check.lua');
  const lines = samples.map(s => `io.write(LooksLikeKey(${JSON.stringify(s)}) and "1" or "0")`);
  fs.writeFileSync(file, `${luaKeyCheckSource({ assign: 'LooksLikeKey' })}\n${lines.join('\n')}\n`);
  const r = spawnSync('luajit', [file], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, samples.map(s => (looksLikeKey(s) ? '1' : '0')).join(''));
});
