// Strip v2 records against the shared vectors (tests/fixtures/protocol-v2.json).
import test from 'node:test';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseRecord, parsePayload, encodeRecord, encodeArg, decodeArg, parseArgs, inflateBody, deflateBody } from '../bridge/transport/records.mjs';

const V = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol-v2.json'), 'utf8'));

test('records: every shared vector parses to its expected form', () => {
  for (const r of V.records) {
    const got = parseRecord(r.wire);
    assert.equal(got.ok, true, `${r.name}: ${got.reason}`);
    for (const [k, v] of Object.entries(r.parsed)) assert.deepEqual(got.record[k], v, `${r.name}: ${k}`);
  }
});

test('records: invalid vectors are rejected with a reason', () => {
  const reasons = V.invalid.map(r => parseRecord(r.wire));
  assert.deepEqual(reasons.map(r => r.ok), V.invalid.map(() => false));
  assert.deepEqual(reasons.map(r => r.reason), ['version', 'token', 'key', 'chat', 'type', 'cur', 'key', 'chat']);
});

test('records: a keyed record rejected for its chat or cursor carries its token and key, so the bridge can ack it; others carry none', () => {
  const US = '\x1f';
  const noCur = ['2', '7d63a4fb', '11b2_102', 'upd', '', 'a=check', ''].join(US);
  assert.deepEqual(parseRecord(noCur), { ok: false, reason: 'cur', token: '7d63a4fb', key: '11b2_102' });
  const badChat = ['2', '7d63a4fb', '11b2_103', 'msg', 'not a chat', 'cur=0', 'hi'].join(US);
  assert.deepEqual(parseRecord(badChat), { ok: false, reason: 'chat', token: '7d63a4fb', key: '11b2_103' });
  const badKey = ['2', '7d63a4fb', 'nope', 'msg', 'c3f9a1e', 'cur=0', 'hi'].join(US);
  assert.deepEqual(parseRecord(badKey), { ok: false, reason: 'key' });
  const helloNoCur = ['2', '7d63a4fb', '11b2', 'hello', '', 'ver=1.4.4', ''].join(US);
  assert.deepEqual(parseRecord(helloNoCur), { ok: false, reason: 'cur' }, 'unkeyed: nothing to ack');
  const { rejected } = parsePayload(noCur);
  assert.deepEqual([rejected[0].reason, rejected[0].token, rejected[0].key], ['cur', '7d63a4fb', '11b2_102']);
});

test('records: a payload with several records keeps their order', () => {
  const { records, rejected } = parsePayload(V.payload.wire);
  assert.deepEqual(records.map(r => r.key), V.payload.keys);
  assert.equal(rejected.length, 0);
});

test('records: encode is the inverse of parse for the vectors', () => {
  for (const r of V.records) {
    const p = r.parsed;
    const wire = encodeRecord({ token: p.token, key: p.key, type: p.type, chat: p.chat, args: p.args, body: p.body });
    assert.equal(wire, r.wire, r.name);
  }
});

test('records: args percent-encoding round-trips every byte that matters', () => {
  const nasty = '50% off; a=b\x01\x1f\x7f end';
  assert.equal(decodeArg(encodeArg(nasty)), nasty);
  assert.doesNotMatch(encodeArg(nasty), /[;=\x00-\x1f\x7f]/);
  assert.deepEqual(parseArgs('cur=1;;x;=y;name=a%3Db'), { cur: '1', name: 'a=b' });
});

test('records: a z=1 body (cap z) inflates from base64 of raw deflate, zlib or gzip to the exact text; one that isn\'t base64 or deflate, or would pass the limit, is refused with a reason', () => {
  const vec = V.records.find(r => r.parsed.args.z === '1');
  assert.deepEqual(inflateBody(vec.parsed.body, 2800), { ok: true, text: vec.json }, 'the shared vector');
  assert.equal(vec.json, V.records.find(r => r.parsed.type === 'state' && !r.parsed.args.z).parsed.body, 'the plain state vector\'s JSON');
  const json = JSON.stringify({ v: 1, sid: 'a1b2c3d4e5f60718', seq: 3, char: { name: 'Tävï ✓', realm: 'Testrealm' } });
  assert.deepEqual(inflateBody(deflateBody(json), 2800), { ok: true, text: json }, 'multibyte text survives');
  for (const pack of [zlib.deflateSync, zlib.gzipSync]) assert.equal(inflateBody(pack(json).toString('base64'), 2800).text, json, pack.name);
  // A client that wraps its base64, or uses the URL-safe alphabet, is read too.
  assert.equal(inflateBody(deflateBody(json).replace(/.{16}/g, '$&\n'), 2800).text, json);
  assert.equal(inflateBody(zlib.deflateRawSync(json).toString('base64url'), 2800).text, json);
  // The limit holds for the text and for the body: 2,800 bytes pass, one more doesn't, and a bomb stops early.
  assert.equal(inflateBody(deflateBody('a'.repeat(2800)), 2800).ok, true);
  assert.deepEqual(inflateBody(deflateBody('a'.repeat(2801)), 2800), { ok: false, reason: 'z: too large' });
  const bomb = zlib.deflateRawSync(Buffer.alloc(1 << 20)).toString('base64'); // 1 MB of zeros
  assert.ok(bomb.length < 2800, `${bomb.length} bytes of body`);
  assert.deepEqual(inflateBody(bomb, 2800), { ok: false, reason: 'z: too large' });
  assert.deepEqual(inflateBody('A'.repeat(2804), 2800), { ok: false, reason: 'z: too large' });
  // The bridge's own limits (cap qlog): a body of up to 16,384 bytes inflating to up to 12,000,
  // checked apart: a short body can't inflate past maxText, and a long one is refused unread.
  const LIM = { maxBody: 16384, maxText: 12000 };
  const full = JSON.stringify({ v: 1, quests: Array.from({ length: 40 }, (_, i) => ({ id: 1488 + i, title: `Quest number ${i} of the whole log`, complete: i % 3 === 0 })) });
  assert.ok(Buffer.byteLength(full) > 2800, `${Buffer.byteLength(full)} bytes: past the old limit`);
  assert.deepEqual(inflateBody(deflateBody(full), LIM), { ok: true, text: full }, 'a whole 40-quest log');
  assert.equal(inflateBody(deflateBody('a'.repeat(12000)), LIM).ok, true);
  assert.deepEqual(inflateBody(deflateBody('a'.repeat(12001)), LIM), { ok: false, reason: 'z: too large' });
  assert.deepEqual(inflateBody(bomb, LIM), { ok: false, reason: 'z: too large' });
  const random = [...crypto.randomBytes(12000)].map(b => String.fromCharCode(33 + (b % 94))).join(''); // 12,000 printable bytes, near random
  const incompressible = deflateBody(random);
  assert.ok(incompressible.length > 12000 && incompressible.length <= 16384, `${incompressible.length}: 12,000 bytes that don't deflate fit the body limit`);
  assert.equal(inflateBody(incompressible, LIM).ok, true);
  assert.deepEqual(inflateBody('A'.repeat(16388), LIM), { ok: false, reason: 'z: too large' });
  assert.deepEqual(inflateBody(deflateBody(full), { maxBody: 100, maxText: 12000 }), { ok: false, reason: 'z: too large' }, 'the body limit on its own');
  // Not base64, or not deflate.
  for (const bad of [json, '', '====', 'abc=d']) assert.deepEqual(inflateBody(bad, 2800), { ok: false, reason: 'z: not base64' }, bad);
  assert.deepEqual(inflateBody(Buffer.from('plain words, never deflated').toString('base64'), 2800), { ok: false, reason: 'z: not deflate' });
  assert.deepEqual(inflateBody(deflateBody(json).slice(0, 24), 2800), { ok: false, reason: 'z: not deflate' }, 'cut short');
});

test('records: msg text with separators is cleaned the way the addon does it', () => {
  const wire = encodeRecord({ token: '3fa9c2d1', key: 'a3f1_9', type: 'msg', chat: 'c3f9a1e', args: { cur: 0, ctx: 1 }, context: 'ctx\x1dline', text: 'a\x1eb\x1fc' });
  const { record } = parseRecord(wire);
  assert.equal(record.context, 'ctx line');
  assert.equal(record.text, 'a b c');
});
