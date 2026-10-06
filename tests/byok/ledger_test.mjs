// The run ledger (PRD §6.5, RT-8, DB20, §10): an entry is on disk before a
// request goes out, or the turn isn't sent; a turn still 'sending' when the
// process dies comes back as 'interrupted' and is never resent; a turn still
// 'queued' comes back as never sent; final states stay final; metadata is an
// allowed list of flat, key-free values.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLedger, cleanMeta, LEDGER_STATES, META_KEYS } from '../../bridge/byok/ledger.mjs';

// chmod can't lock the owner out on Windows or as root.
const canLockOut = process.platform !== 'win32' && process.getuid?.() !== 0;
const lockOutSkip = canLockOut ? false : process.platform === 'win32'
  ? "chmod can't make a file unwritable to its owner on Windows (the file's ACL decides there)"
  : "running as root, whom chmod can't lock out";

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-ledger-')), 'byok', 'ledger.json');
const onDisk = file => JSON.parse(fs.readFileSync(file, 'utf8')).entries;

test('begin writes the entry before anything is sent', () => {
  const file = tmpFile();
  const ledger = createLedger(file);
  const { fresh, entry } = ledger.begin('3fa9c2d1:17', { chatId: 'c0ffee0', provider: 'anthropic', model: 'claude-haiku-4-5', kind: 'typed', estMicros: 13500 });
  assert.equal(fresh, true);
  assert.equal(entry.state, 'queued');
  assert.equal(onDisk(file)['3fa9c2d1:17'].state, 'queued');
  assert.deepEqual(onDisk(file)['3fa9c2d1:17'].meta, { chatId: 'c0ffee0', provider: 'anthropic', model: 'claude-haiku-4-5', kind: 'typed', estMicros: 13500 });
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['ledger.json'], 'no temp files left');
  assert.ok(ledger.set('3fa9c2d1:17', 'sending'));
  assert.equal(onDisk(file)['3fa9c2d1:17'].state, 'sending', 'sending is on disk before the fetch');
  assert.deepEqual(LEDGER_STATES, ['queued', 'sending', 'done', 'failed', 'interrupted']);
});

test('a crash mid-run: begin → sending → crash → interrupted at startup, and never twice', () => {
  const file = tmpFile();
  let t = 1_000_000;
  const now = () => t;
  const before = createLedger(file, { now });
  before.begin('k-sending', { chatId: 'a' });
  before.set('k-sending', 'sending');
  before.begin('k-done', { chatId: 'a' });
  before.set('k-done', 'sending');
  before.set('k-done', 'done', { outMicros: 9250 });
  before.begin('k-queued', { chatId: 'b' });
  // Simulated crash: `before` is dropped without another write.
  t += 5000;
  const after = createLedger(file, { now });
  const hit = after.interruptedAtStartup();
  assert.deepEqual(hit.map(e => [e.key, e.state, e.extra.reason ?? null, e.meta.chatId, e.neverSent ?? false]),
    [['k-sending', 'interrupted', 'restart', 'a', false], ['k-queued', 'queued', null, 'b', true]]);
  assert.equal(hit[0].updatedAt, t);
  assert.equal(after.get('k-done').state, 'done');
  assert.equal(after.get('k-done').extra.outMicros, 9250);
  assert.equal(after.get('k-queued').state, 'queued', 'a queued turn never left, so it stays sendable');
  assert.equal(after.get('k-queued').neverSent, undefined, 'the mark is on the report, not stored');
  assert.deepEqual(after.interruptedAtStartup(), [], 'reported once');
  assert.equal(after.set('k-sending', 'sending'), false, 'no automatic resend: interrupted is final');
  assert.equal(onDisk(file)['k-sending'].state, 'interrupted');
  // The runtime sends the never-sent turn (it never left, §10) and it completes normally.
  assert.equal(after.set('k-queued', 'sending'), true);
  assert.equal(after.set('k-queued', 'done', { outMicros: 4300 }), true);
  const third = createLedger(file, { now });
  assert.deepEqual(third.interruptedAtStartup(), []);
  assert.equal(third.interrupted, third.interruptedAtStartup, 'the BUILD-PLAN name is the same call');
});

test('a queued turn from an earlier process is reported even if the runtime ignores it, then marked failed', () => {
  const file = tmpFile();
  const a = createLedger(file);
  a.begin('q1', { chatId: 'c' });
  const b = createLedger(file);
  b.begin('mine', { chatId: 'c' }); // this process's own queued turn is live
  const hit = b.interrupted();
  assert.deepEqual(hit.map(e => [e.key, e.neverSent]), [['q1', true]]);
  assert.equal(b.set('q1', 'failed', { reason: 'stale' }), true);
  // The next process sees b's own turn, still queued, as left behind; q1 is final.
  assert.deepEqual(createLedger(file).interrupted().map(e => [e.key, e.neverSent]), [['mine', true]]);
});

test('runs this process is sending are live, not interrupted', () => {
  const ledger = createLedger(tmpFile());
  ledger.begin('live');
  ledger.set('live', 'sending');
  assert.deepEqual(ledger.interruptedAtStartup(), []);
  assert.equal(ledger.get('live').state, 'sending');
});

test('the idempotency key dedupes: a second begin returns the first entry', () => {
  const ledger = createLedger(null);
  assert.equal(ledger.begin('k', { chatId: 'a' }).fresh, true);
  ledger.set('k', 'sending');
  const again = ledger.begin('k', { chatId: 'zzz' });
  assert.equal(again.fresh, false);
  assert.equal(again.entry.state, 'sending');
  assert.equal(again.entry.meta.chatId, 'a');
  // Returned entries are copies.
  again.entry.meta.chatId = 'mutated';
  assert.equal(ledger.get('k').meta.chatId, 'a');
});

test('state rules: final stays final, sending may step back to queued, bad input refused', () => {
  const ledger = createLedger(null);
  ledger.begin('a');
  ledger.set('a', 'sending');
  assert.equal(ledger.set('a', 'queued', { reason: 'dns' }), true, 'the request provably never left');
  assert.equal(ledger.get('a').state, 'queued');
  ledger.set('a', 'sending');
  assert.equal(ledger.set('a', 'failed', { errorKind: 'auth_invalid', status: 401 }), true);
  assert.deepEqual(ledger.get('a').extra, { reason: 'dns', errorKind: 'auth_invalid', status: 401 });
  for (const s of LEDGER_STATES) assert.equal(ledger.set('a', s), false, `failed → ${s}`);
  assert.equal(ledger.set('missing', 'done'), false);
  assert.throws(() => ledger.set('a', 'exploded'), /unknown state/);
  assert.throws(() => ledger.begin(''), /non-empty string/);
  assert.throws(() => ledger.begin('x'.repeat(201)), /non-empty string/);
  assert.throws(() => ledger.begin(42), /non-empty string/);
  assert.equal(ledger.list({ state: 'failed' }).length, 1);
  assert.equal(ledger.list().length, 1);
});

test('metadata is an allowed list of flat values: no bodies, no messages, no keys', () => {
  const canary = 'sk-ant-api03-CANARY' + 'x'.repeat(80);
  const meta = cleanMeta(JSON.parse(`{"__proto__": {"polluted": true}, "chatId": "c1", "estMicros": 3, "status": 429, "code": null,
    "body": {"error": "${canary}"}, "list": [1, 2], "outMicros": 1e999, "reason": "${'y'.repeat(500)}", "message": "prompt text", "n": 3}`));
  assert.deepEqual(meta, { chatId: 'c1', estMicros: 3, status: 429, code: null });
  assert.equal({}.polluted, undefined);
  assert.deepEqual(META_KEYS, ['chatId', 'provider', 'model', 'kind', 'estMicros', 'outMicros', 'status', 'code', 'type', 'requestId', 'errorKind', 'reason',
    'replyT', 'inTokens', 'outTokens', 'exact']);
  // A key in an allowed field, whole or inside other text, is dropped.
  for (const key of [canary, 'sk-proj-CANARY' + 'x'.repeat(40), 'sk-or-v1-CANARY' + 'x'.repeat(40), 'AIza' + 'C'.repeat(35), 'xai-CANARY' + 'x'.repeat(30), 'AQ.' + 'C'.repeat(30)]) {
    assert.deepEqual(cleanMeta({ requestId: key, code: `bad key ${key.slice(0, 60)}` }), {}, key.slice(0, 12));
  }
  assert.deepEqual(cleanMeta({ reason: 'Bearer abc.def' }), {});
  // Real request ids and codes stay.
  assert.deepEqual(cleanMeta({ requestId: 'req_011CTg8pS2Ym5bNUWNqvPBhD', code: 'rate_limit_exceeded', type: 'rate_limit_error' }),
    { requestId: 'req_011CTg8pS2Ym5bNUWNqvPBhD', code: 'rate_limit_exceeded', type: 'rate_limit_error' });
  const file = tmpFile();
  const ledger = createLedger(file);
  ledger.begin('k', { chatId: 'c1', body: { error: canary }, model: canary });
  ledger.set('k', 'failed', { provider: { raw: canary }, message: `invalid x-api-key ${canary}`, requestId: canary, errorKind: 'auth_invalid' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(!text.includes('CANARY'), 'no provider data or key reaches disk');
  assert.deepEqual(ledger.get('k').extra, { errorKind: 'auth_invalid' });
  assert.deepEqual(cleanMeta(null), {});
});

// Code health BR-22 r1: the ledger's done says where its reply is (replyT) and what it cost, so a reply
// the core never published is found after a crash. An addition only: the build before it read this file
// with the list below, and its reader drops what it doesn't list, never failing on it.
const OLD_META_KEYS = Object.freeze(['chatId', 'provider', 'model', 'kind', 'estMicros', 'outMicros', 'status', 'code', 'type', 'requestId', 'errorKind', 'reason']);
test('code health BR-22: the done entry\'s reply time and cost are an addition an older build reads past: every field it knew stays as it was, the new ones are flat values its list leaves out', () => {
  const file = tmpFile();
  const ledger = createLedger(file);
  ledger.begin('nqa:3fa9c2d1:a3f1_1', { chatId: 'c3f9a1e', provider: 'anthropic', model: 'claude-sonnet-5-5', kind: 'typed' });
  ledger.set('nqa:3fa9c2d1:a3f1_1', 'sending', { provider: 'anthropic', model: 'claude-sonnet-5-5', estMicros: 9000 });
  ledger.set('nqa:3fa9c2d1:a3f1_1', 'done', { outMicros: 4800, requestId: 'req_011CTg8pS2Ym5bNUWNqvPBhD', replyT: 1790000000123, inTokens: 2000, outTokens: 80, exact: false });
  const entry = onDisk(file)['nqa:3fa9c2d1:a3f1_1'];
  assert.deepEqual(Object.keys(entry), ['key', 'state', 'meta', 'extra', 'createdAt', 'updatedAt'], 'the entry\'s shape as it was');
  assert.deepEqual(entry.extra, { provider: 'anthropic', model: 'claude-sonnet-5-5', estMicros: 9000, outMicros: 4800, requestId: 'req_011CTg8pS2Ym5bNUWNqvPBhD',
    replyT: 1790000000123, inTokens: 2000, outTokens: 80, exact: false });
  // As the older build's reader (its cleanMeta over OLD_META_KEYS) keeps it: every field it knew, nothing else.
  assert.deepEqual(META_KEYS.slice(0, OLD_META_KEYS.length), OLD_META_KEYS, 'only added, at the end');
  const oldRead = x => Object.fromEntries(Object.entries(x).filter(([k]) => OLD_META_KEYS.includes(k)));
  assert.deepEqual(oldRead(entry.extra), { provider: 'anthropic', model: 'claude-sonnet-5-5', estMicros: 9000, outMicros: 4800, requestId: 'req_011CTg8pS2Ym5bNUWNqvPBhD' });
  for (const k of META_KEYS.slice(OLD_META_KEYS.length)) assert.ok(['number', 'boolean'].includes(typeof entry.extra[k]), `${k}: a flat value`);
  // And this build reads an older build's done (no replyT, no cost) as it is.
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['replyT', 'inTokens', 'outTokens', 'exact']) delete raw.entries['nqa:3fa9c2d1:a3f1_1'].extra[k];
  fs.writeFileSync(file, JSON.stringify(raw));
  const again = createLedger(file);
  assert.equal(again.get('nqa:3fa9c2d1:a3f1_1').state, 'done');
  assert.equal(again.get('nqa:3fa9c2d1:a3f1_1').extra.replyT, undefined);
  assert.deepEqual(again.interruptedAtStartup(), [], 'a done entry is never reported');
});

test('an entry that can\'t reach disk stops the send', { skip: lockOutSkip }, () => {
  const file = tmpFile();
  const dir = path.dirname(file);
  const logs = [];
  const ledger = createLedger(file, { log: k => logs.push(k) });
  ledger.begin('before');
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => ledger.begin('k1', { chatId: 'a' }), e => e.code === 'LEDGER_WRITE_FAILED');
    assert.equal(ledger.get('k1'), null, 'nothing half-recorded');
    assert.throws(() => ledger.set('before', 'sending'), e => e.code === 'LEDGER_WRITE_FAILED');
    assert.equal(ledger.get('before').state, 'queued', "the 'sending' mark is rolled back");
    assert.deepEqual(ledger.interruptedAtStartup(), [], 'and it isn\'t live or interrupted');
    assert.ok(logs.includes('ledger_write_failed'));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  // The disk is back: the same key starts fresh, and a crash after 'sending' is caught.
  assert.equal(ledger.begin('k1').fresh, true);
  assert.equal(ledger.set('k1', 'sending'), true);
  const after = createLedger(file);
  const hit = after.interruptedAtStartup();
  assert.deepEqual(hit.map(e => [e.key, e.state]).sort(), [['before', 'queued'], ['k1', 'interrupted']]);
  assert.equal(after.begin('k1').fresh, false, 'never billed twice');
});

test('a final state that can\'t reach disk still holds in memory', { skip: lockOutSkip }, () => {
  const file = tmpFile();
  const ledger = createLedger(file);
  ledger.begin('k');
  ledger.set('k', 'sending');
  fs.chmodSync(path.dirname(file), 0o500);
  try {
    assert.equal(ledger.set('k', 'done', { outMicros: 1 }), true);
    assert.equal(ledger.get('k').state, 'done');
  } finally {
    fs.chmodSync(path.dirname(file), 0o700);
  }
  // On disk it is still 'sending', so a crash now reads as interrupted, never as a resend.
  assert.equal(createLedger(file).interruptedAtStartup()[0].state, 'interrupted');
});

test('old entries are pruned; a sending entry waits for the startup check', () => {
  const file = tmpFile();
  let t = Date.parse('2026-09-01T00:00:00Z');
  const ledger = createLedger(file, { now: () => t, maxAgeMs: 7 * 24 * 3600 * 1000, maxEntries: 3 });
  ledger.begin('old-done'); ledger.set('old-done', 'done');
  ledger.begin('old-sending'); ledger.set('old-sending', 'sending');
  t += 8 * 24 * 3600 * 1000;
  assert.equal(ledger.prune(), 1);
  assert.equal(ledger.get('old-done'), null);
  assert.equal(ledger.get('old-sending').state, 'sending');
  // Over maxEntries, the oldest final entries go first.
  for (const k of ['a', 'b', 'c']) { t += 1000; ledger.begin(k); ledger.set(k, 'done'); }
  assert.ok(ledger.size <= 3);
  assert.equal(ledger.get('old-sending').state, 'sending');
  assert.equal(ledger.get('a'), null);
  assert.equal(ledger.get('c').state, 'done');
  // After a restart the stale sending entry is reported, then ages out.
  const next = createLedger(file, { now: () => t, maxAgeMs: 7 * 24 * 3600 * 1000 });
  assert.deepEqual(next.interruptedAtStartup().map(e => e.key), ['old-sending']);
  t += 8 * 24 * 3600 * 1000;
  next.prune();
  assert.equal(next.size, 0);
});

// Code health BR-19: the age prune ran only at startup, so an app left running (a login item) kept
// every entry up to the count cap, rewritten whole 3 times a turn.
test('code health BR-19: a ledger that runs for weeks with no restart prunes by age in set(), at most once a day, in the write it makes anyway', () => {
  const file = tmpFile();
  const DAY = 24 * 3600 * 1000;
  const t0 = Date.parse('2026-09-01T00:00:00Z');
  let t = t0;
  const ledger = createLedger(file, { now: () => t });
  const turn = (k) => { ledger.begin(k); ledger.set(k, 'sending'); ledger.set(k, 'done'); };
  turn('a');
  t = t0 + 2 * 3600e3;
  turn('b');
  // A week and an hour on: the day's first set() prunes what's older than 7 days ('a'), on disk too.
  t = t0 + 7 * DAY + 3600e3;
  turn('c');
  assert.equal(ledger.get('a'), null);
  assert.equal(ledger.get('b').state, 'done');
  assert.deepEqual(Object.keys(onDisk(file)).sort(), ['b', 'c']);
  // Two hours later 'b' is past 7 days too, but a day hasn't gone by since the last prune: kept.
  t = t0 + 7 * DAY + 3 * 3600e3;
  turn('d');
  assert.equal(ledger.get('b').state, 'done');
  // A day after that prune: gone.
  t = t0 + 8 * DAY + 3600e3;
  turn('e');
  assert.equal(ledger.get('b'), null);
  assert.deepEqual(Object.keys(onDisk(file)).sort(), ['c', 'd', 'e']);
  // A month of play at 40 turns a day, never restarted: about a week of turns on disk, not 4,800.
  for (let day = 0; day < 30; day++) for (let i = 0; i < 40; i++) { t += DAY / 40; turn(`m${day}-${i}`); }
  assert.ok(ledger.size >= 7 * 40 && ledger.size <= 8 * 40 + 1, `${ledger.size} entries`);
  assert.equal(Object.keys(onDisk(file)).length, ledger.size);
});

test('a corrupt or foreign file is survived, not trusted', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"entries": {"k": {"state": "hacked"}, "j": {"state": "sending", "meta": {"x": {"deep": 1}}}}}');
  const logs = [];
  const ledger = createLedger(file, { log: (kind, data) => logs.push([kind, data]) });
  assert.equal(ledger.get('k'), null);
  assert.deepEqual(ledger.get('j').meta, {});
  fs.writeFileSync(file, 'garbage');
  const again = createLedger(file, { log: (kind, data) => logs.push([kind, data]) });
  assert.equal(again.size, 0);
  assert.deepEqual(logs, [['ledger_read_failed', { code: 'corrupt' }]]);
  // The unreadable file is kept aside, never overwritten.
  again.begin('new');
  const kept = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith('ledger.json.corrupt-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), kept[0]), 'utf8'), 'garbage');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).entries.new.state, 'queued');
});
