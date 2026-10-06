// KY-9, §8.4 items 6-7: every pattern is redacted, no canary survives in any
// context, JSON lines stay JSON, the bridge log goes through the redactor, and
// crash output does too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redact, redactError, redactKeys, redactKeysInProse, REDACTED } from '../../bridge/byok/security/redact.mjs';
import { createLogger } from '../../bridge/log.mjs';
import { CANARY_KEYS, scanDirForCanaries } from './helpers/canary.mjs';

const REDACT = fileURLToPath(new URL('../../bridge/byok/security/redact.mjs', import.meta.url));
const CANARIES = Object.values(CANARY_KEYS);
const leaks = (text) => CANARIES.filter(k => text.includes(k.slice(0, 16)));

const CONTEXTS = [
  (k) => k,
  (k) => `key ${k} end`,
  (k) => JSON.stringify({ apiKey: k, nested: { k } }),
  (k) => `Authorization: Bearer ${k}`,
  (k) => `{"authorization":"Bearer ${k}"}`,
  (k) => `x-api-key: ${k}`,
  (k) => `x-goog-api-key: ${k}`,
  (k) => `https://generativelanguage.googleapis.com/v1beta/models?key=${k}&alt=sse`,
  (k) => `error: 401 invalid x-api-key ${k}.`,
  (k) => `'${k}'`,
  (k) => `${k}\n${k}`,
];

test('redact: no canary key survives any context', () => {
  for (const k of CANARIES) {
    for (const ctx of CONTEXTS) {
      const out = redact(ctx(k));
      assert.deepEqual(leaks(out), [], `leaked from: ${ctx('KEY')}`);
      assert.ok(out.includes(REDACTED));
    }
  }
});

test('redact: the PRD §8.4 item 7 patterns, one by one', () => {
  const cases = [
    'sk-ant-api03-abcdefghijk',
    'sk-proj-abcdefghijk',
    'sk-svcacct-abcdefghijk',
    'sk-admin-abcdefghijk',
    'sk-abcdefghijklmnopqrstuvwx',
    'sk-or-v1-abcdef0123',
    'AIza' + 'b'.repeat(35),
    'AQ.' + 'c'.repeat(24),
    'xai-' + 'd'.repeat(24),
    'ya29.a0AfH6SMBabcdefghijk',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', // gitleaks:allow (a made-up token)
  ];
  for (const secret of cases) {
    const out = redact(`before ${secret} after`);
    assert.equal(out, `before ${REDACTED} after`, secret);
  }
  assert.equal(redact('Authorization: Bearer abc.def-ghi_jkl'), `Authorization: ${REDACTED}`);
  assert.equal(redact('authorization: Basic dXNlcjpwYXNz'), `authorization: ${REDACTED}`);
  assert.equal(redact('sent Bearer abcdefgh12345678 upstream'), `sent Bearer ${REDACTED} upstream`);
  assert.equal(redact('x-api-key: abc123456'), `x-api-key: ${REDACTED}`);
  assert.equal(redact('X-Goog-Api-Key: abc123456'), `X-Goog-Api-Key: ${REDACTED}`);
  assert.equal(redact('GET /v1/models?key=zzz999&alt=sse'), `GET /v1/models?key=${REDACTED}&alt=sse`);
  assert.equal(redact('http://127.0.0.1:5555/cb/x?code=abc-123'), `http://127.0.0.1:5555/cb/x?code=${REDACTED}`);
  assert.equal(redact('{"client_secret":"s3cr3t-value"}'), `{"client_secret":"${REDACTED}"}`);
});

test('redact: header and field forms with a key of no known shape (a Map, rawHeaders, JSON inside JSON)', () => {
  const v = 'customsecretvalue123'; // no provider shape: only the name rules can catch it
  assert.equal(redact(v), v);
  const forms = [
    util.inspect(new Map([['x-api-key', v]])),
    util.inspect(new Map([['authorization', `Token ${v}`], ['x-goog-api-key', v], ['apiKey', v]])),
    util.inspect(['content-type', 'application/json', 'x-api-key', v, 'authorization', v, 'api-key', v]),
    util.inspect(new Headers({ 'x-api-key': v, authorization: `Token ${v}` })),
    JSON.stringify({ line: JSON.stringify({ 'x-api-key': v, authorization: `Token ${v}`, client_secret: v }) }),
    JSON.stringify({ line: JSON.stringify({ line: JSON.stringify({ 'x-api-key': v }) }) }),
    `x-api-key=${v}`,
    `authorization = ${v}`,
  ];
  for (const f of forms) {
    const out = redact(f);
    assert.ok(!out.includes(v), `leaked from: ${f}`);
    assert.equal(redact(out), out, 'idempotent');
  }
  assert.equal(redact(`Map(1) { 'x-api-key' => '${v}' }`), `Map(1) { 'x-api-key' => '${REDACTED}' }`);
  assert.equal(redact(`[ 'x-api-key', '${v}' ]`), `[ 'x-api-key', '${REDACTED}' ]`);
  const nested = JSON.stringify({ line: JSON.stringify({ 'x-api-key': v, authorization: `Token ${v}` }) });
  const once = redact(nested);
  assert.deepEqual(JSON.parse(JSON.parse(once).line), { 'x-api-key': REDACTED, authorization: REDACTED }, 'both layers stay JSON');
  // A comma needs quotes on both sides, so prose keeps its words.
  assert.equal(redact('missing x-api-key, please set it'), 'missing x-api-key, please set it');
  // Escaped quotes at any depth cost linear time: long runs of backslashes stay fast.
  const t0 = performance.now();
  redact(`${'\\'.repeat(200000)}apiKey${('x-api-key' + '\\'.repeat(50000)).repeat(4)}`);
  assert.ok(performance.now() - t0 < 1500, 'no quadratic backtracking');
});

test('redact: exact-match extras, longest first, JSON-escaped too, short ones ignored', () => {
  const token = 'plain-device-token-0123456789';
  assert.equal(redact(`t=${token};`, [token]), `t=${REDACTED};`);
  const long = token + '-and-more';
  assert.equal(redact(`${long} ${token}`, [token, long]), `${REDACTED} ${REDACTED}`);
  const quoted = 'pass"with\\odd';
  assert.equal(redact(JSON.stringify({ v: quoted }), [quoted]), `{"v":"${REDACTED}"}`);
  assert.equal(redact('a short one', ['short']), 'a short one');
  assert.equal(redact('abc', new Set(['xyzxyzxyz'])), 'abc');
});

test('redact: ordinary text and ids are left alone', () => {
  const plain = [
    'chat c1 run r-42 finished in 812 ms (usage 1200/340)',
    'the task-management framework',
    'authorization failed: token expired',
    'Kill 10 Defias Pillagers',
    '{"sessionKey":"wow:c1","seq":17}',
    'sk-ant-…A1b2 (redacted)',
  ];
  for (const s of plain) assert.equal(redact(s), s);
});

test('redact: a redacted JSON line is still JSON, and redact is idempotent', () => {
  const obj = {
    headers: { authorization: `Bearer ${CANARY_KEYS.anthropic}`, 'x-api-key': CANARY_KEYS.openai, note: 'q"uote\\slash' },
    url: `https://x.test/?key=${CANARY_KEYS.google}&a=1`,
    body: { apiKey: CANARY_KEYS.xai, text: `say "${CANARY_KEYS.openrouter}"` },
  };
  const once = redact(JSON.stringify(obj));
  assert.doesNotThrow(() => JSON.parse(once));
  assert.deepEqual(leaks(once), []);
  assert.equal(redact(once), once);
});

test('redact (KA-02, code health): redactKeys takes the key shapes out of what\'s kept (a transcript row, a history row), glued ones too, and leaves every other word as it was', () => {
  for (const k of CANARIES) {
    assert.equal(redactKeys(`Your key is ${k}, keep it safe.`), `Your key is ${REDACTED}, keep it safe.`, k.slice(0, 8));
    assert.equal(redactKeys(`mykey${k}`), `mykey${REDACTED}`, k.slice(0, 8));
  }
  const prose = 'The password: the one on the door. Authorization: ask the guild master. Bearer of the api_key field, key=value?';
  assert.equal(redactKeys(prose), prose, 'the header and field rules are not applied to prose');
  assert.equal(redactKeys(redactKeys(`a ${CANARY_KEYS.xai} b`)), `a ${REDACTED} b`, 'idempotent');
  assert.equal(redactKeys(undefined), undefined);
});

test('redact (KA-02 follow-up b, code health): redactKeysInProse, for a reply the player reads, leaves a word that ends like a key\'s prefix begins alone, and takes a key bounded or glued', () => {
  for (const s of [
    'Weigh the risk-or-reward-ratio before you pull.', 'It is a brisk-or-leisurely-pace kind of route.', 'The flask-or-elixir-choice matters here.',
    'Use your desk-or-countertop-and-a-chair.', 'Read the FAQ.It_explains_everything_about_quests_ok', 'Ask in /2 or check the FAQ. Then go.',
    'the task-admin-panel-settings-page-is-broken-again-for-everyone-in-the-guild', 'see https://example.com/guides/task-proj-management-for-raid-leaders-and-officers-guide',
    'maxai-bot_says_hello_to_everyone_in_the_guild_today_ok', 'FAQ.pleasereadthefaqbeforeaskingquestionsinguildchat',
  ]) assert.equal(redactKeysInProse(s), s, s);
  assert.equal(redactKeys('Weigh the risk-or-reward-ratio before you pull.'), `Weigh the ri${REDACTED} before you pull.`, 'what\'s kept on disk errs strict');
  for (const k of CANARIES) {
    assert.equal(redactKeysInProse(`risk${k} and more`), `risk${REDACTED} and more`, k.slice(0, 8));
    assert.equal(redactKeysInProse(`here: ${k}.`), `here: ${REDACTED}.`, k.slice(0, 8));
  }
  assert.equal(redactKeysInProse(undefined), undefined);
});

test('redact (KB-07, code health): a registered key cut or wrapped across a line loses its head and its tail, a key of no known shape too', () => {
  const key = 'sk-ant-api03-CANARY' + 'aB3dE5fG7h'.repeat(8);
  const opaque = 'CANARYopq' + 'Zy9Xw8Vu7T'.repeat(4);
  for (const s of [key, opaque]) {
    for (const at of [14, 20, 30, s.length - 14]) {
      const out = redact(`401 from the provider: ${s.slice(0, at)}\n${s.slice(at)} (end)`, [s]);
      assert.ok(!out.includes(s.slice(at, at + 12)), `${s.slice(0, 6)} cut at ${at}: the tail`);
      assert.ok(!out.includes(s.slice(Math.max(0, at - 12), at)), `${s.slice(0, 6)} cut at ${at}: the head`);
      assert.match(out, /^401 from the provider: /);
      assert.match(out, / \(end\)$/);
    }
    const once = redact(`a ${s.slice(0, 25)}\n${s.slice(25)} b`, [s]);
    assert.equal(redact(once, [s]), once, 'still idempotent');
  }
  assert.equal(redact('the shape is sk-ant-api03 and nothing else', ['short-secret-1']), 'the shape is sk-ant-api03 and nothing else', 'short secrets: exact matches only');
});

test('redact (KB-07, e8b4f1b follow-up c): the cut-key rule is linear: a long run of key characters costs milliseconds, not seconds; the same takes', () => {
  const key = 'sk-ant-api03-VERIFY' + 'Qw7Er8Ty9U'.repeat(8);
  const t0 = performance.now();
  const out = redact('x'.repeat(60_000) + ' sk-ant-api03 end', [key]);
  const ms = performance.now() - t0;
  assert.ok(ms < 250, `60,000 key characters: ${ms.toFixed(0)} ms`);
  assert.equal(out, `${'x'.repeat(60_000)} ${REDACTED} end`, 'the key\'s head goes, the long run stays');
  assert.equal(redact(`a ${key.slice(0, 30)}\nb`, [key]), `a ${REDACTED}\nb`);
  assert.equal(redact(`x.${key.slice(0, 12)}_y z ${key.slice(-12)}`, [key]), `${REDACTED} z ${REDACTED}`);
  assert.equal(redact(`${key.slice(0, 12)}${key.slice(0, 12)} ${key.slice(0, 12)}`, [key]), `${REDACTED} ${REDACTED}`);
  const long = `${key.slice(0, 12)}${'y'.repeat(60_000)}`;
  const t1 = performance.now();
  assert.equal(redact(long, [key]), REDACTED);
  assert.ok(performance.now() - t1 < 250, 'a part at the start of a long run too');
});

test('redact (code health BR-08): OpenAI sk-None- and Groq gsk_ keys are redacted everywhere a key shape is', () => {
  const none = `sk-None-${'aB3dE5fG7h'.repeat(5)}Kq`;
  const groq = `gsk_${'aB3dE5fG7h'.repeat(5)}Kq`;
  for (const k of [none, groq]) {
    assert.equal(redact(`401 from the service: ${k}`), `401 from the service: ${REDACTED}`, k.slice(0, 8));
    assert.equal(redact(`Authorization: Bearer ${k}`).includes(k.slice(0, 12)), false);
    assert.equal(redactKeys(`kept ${k}.`), `kept ${REDACTED}.`);
    assert.equal(redactKeysInProse(`said ${k}.`), `said ${REDACTED}.`);
    assert.equal(redactKeysInProse(`glued${k}`), `glued${REDACTED}`);
  }
});

test('redact: redactError keeps the stack shape and drops the key', () => {
  const e = new Error(`upstream said: invalid key ${CANARY_KEYS.anthropic}`);
  const out = redactError(e);
  assert.match(out, /^Error: upstream said: invalid key <redacted>/);
  assert.deepEqual(leaks(out), []);
  assert.equal(redactError('plain'), 'plain');
});

test('log.mjs: every file line and echo line goes through the redactor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-log-'));
  const printed = [];
  const orig = console.log;
  console.log = (...a) => printed.push(a.join(' '));
  try {
    const device = 'device-token-abcdefghijklmnop';
    const log = createLogger(dir, { echo: true, secrets: [device] });
    log('provider_error', { provider: 'anthropic', message: `401 invalid x-api-key ${CANARY_KEYS.anthropic}` });
    log('request', { headers: { authorization: `Bearer ${CANARY_KEYS.openrouter}` }, url: `https://g.test/?key=${CANARY_KEYS.google}` });
    log('xai', { body: CANARY_KEYS.xai, legacy: CANARY_KEYS.openaiLegacy, auth: CANARY_KEYS.googleAuth, proj: CANARY_KEYS.openai });
    log('device', { token: device });
    const added = 'added-later-secret-0123456789';
    log.addSecret(added);
    log('later', { v: added });
    assert.equal(log.scrub(`x ${CANARY_KEYS.anthropic}`), `x ${REDACTED}`);
    const lines = fs.readFileSync(log.file(), 'utf8').trim().split('\n');
    assert.equal(lines.length, 5);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));
    const all = lines.join('\n') + printed.join('\n');
    assert.ok(!all.includes(device) && !all.includes(added));
    assert.deepEqual(leaks(all), []);
    assert.deepEqual(scanDirForCanaries(dir), []);
  } finally {
    console.log = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function crashChild(body) {
  // A file URL, not a path: import() reads a Windows path's drive letter as a URL scheme.
  const code = `import { guardCrashOutput } from ${JSON.stringify(pathToFileURL(REDACT).href)};\n`
    + `guardCrashOutput({ secrets: () => ['extra-secret-0123456789'] });\n${body}\n`;
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20000 });
}

test('crash output: an uncaught exception prints redacted and exits 1', () => {
  const r = crashChild(`setTimeout(() => { throw new Error('boom ${CANARY_KEYS.anthropic} extra-secret-0123456789'); }, 0);`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Uncaught exception: Error: boom <redacted> <redacted>/);
  assert.deepEqual(leaks(r.stderr), []);
  assert.ok(!r.stderr.includes('extra-secret-0123456789'));
});

test('crash output: an unhandled rejection prints redacted and exits 1; reports exclude env', () => {
  const r = crashChild(`if (process.report && process.report.excludeEnv !== true) process.exit(7);\nPromise.reject(new Error('nope ${CANARY_KEYS.xai}'));`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /nope <redacted>/);
  assert.deepEqual(leaks(r.stderr), []);
});
