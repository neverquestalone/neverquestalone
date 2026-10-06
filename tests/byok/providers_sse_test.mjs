// SSE and NDJSON readers (PRD §7.5; bridge/byok/providers/sse.mjs): events
// survive being split at every byte, CR/LF pairs split across chunks, UTF-8
// split mid-character, comments, multi-line data, and a stream cut off
// mid-event is never dispatched as complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSSE, readNDJSON, readLines } from '../../bridge/byok/providers/sse.mjs';

async function* chunks(parts) { for (const p of parts) yield typeof p === 'string' ? Buffer.from(p, 'utf8') : p; }
const bytewise = (text) => [...Buffer.from(text, 'utf8')].map(b => Uint8Array.of(b));
async function all(it) { const out = []; for await (const x of it) out.push(x); return out; }

const STREAM = 'event: message_start\ndata: {"a":1}\n\n: keep-alive comment\n\nevent: delta\ndata: {"text":"héllo 🦴"}\n\ndata: line one\ndata: line two\n\ndata: [DONE]\n\n';
const EXPECT = [
  { event: 'message_start', data: '{"a":1}', id: null },
  { event: 'delta', data: '{"text":"héllo 🦴"}', id: null },
  { event: 'message', data: 'line one\nline two', id: null },
  { event: 'message', data: '[DONE]', id: null },
];

test('readSSE parses events, skips comments, joins multi-line data', async () => {
  assert.deepEqual(await all(readSSE(chunks([STREAM]))), EXPECT);
});

test('readSSE: identical result when split at every byte (mid-UTF-8 included)', async () => {
  assert.deepEqual(await all(readSSE(bytewise(STREAM))), EXPECT);
});

test('readSSE: CRLF and bare CR line endings, with the CR/LF pair split across chunks', async () => {
  const crlf = STREAM.replace(/\n/g, '\r\n');
  assert.deepEqual(await all(readSSE(chunks([crlf]))), EXPECT);
  assert.deepEqual(await all(readSSE(bytewise(crlf))), EXPECT);
  const cut = crlf.indexOf('\r\n') + 1; // chunk ends between \r and \n
  assert.deepEqual(await all(readSSE(chunks([crlf.slice(0, cut), crlf.slice(cut)]))), EXPECT);
  assert.deepEqual(await all(readSSE(chunks([crlf.slice(0, cut), '', crlf.slice(cut)]))), EXPECT, 'an empty chunk between CR and LF');
  assert.deepEqual(await all(readSSE(chunks([STREAM.replace(/\n/g, '\r')]))), EXPECT);
});

test('readSSE: field without a space after the colon, and id', async () => {
  const evs = await all(readSSE(chunks(['id: 7\nevent:x\ndata:{"b":2}\n\n'])));
  assert.deepEqual(evs, [{ event: 'x', data: '{"b":2}', id: '7' }]);
});

test('readSSE: a stream cut mid-event never dispatches the partial event', async () => {
  const evs = await all(readSSE(chunks(['data: {"ok":1}\n\ndata: {"partial":'])));
  assert.deepEqual(evs.map(e => e.data), ['{"ok":1}']);
  const evs2 = await all(readSSE(chunks(['data: {"ok":1}\n\ndata: {"a":1}\ndata: {"b"'])));
  assert.deepEqual(evs2.map(e => e.data), ['{"ok":1}'], 'a complete line of an unfinished event is dropped too');
});

test('readSSE: a final event without the trailing blank line still dispatches when its line is complete', async () => {
  const evs = await all(readSSE(chunks(['data: [DONE]\n'])));
  assert.deepEqual(evs.map(e => e.data), ['[DONE]']);
});

test('readSSE accepts a string body and a web ReadableStream', async () => {
  assert.deepEqual((await all(readSSE('data: x\n\n'))).map(e => e.data), ['x']);
  const rs = new ReadableStream({ start(c) { for (const b of bytewise('data: y\n\n')) c.enqueue(b); c.close(); } });
  assert.deepEqual((await all(readSSE(rs))).map(e => e.data), ['y']);
});

test('readNDJSON parses lines split anywhere; a final line without newline still counts', async () => {
  const text = '{"a":1}\n\n{"b":"ü"}\n{"done":true}';
  assert.deepEqual(await all(readNDJSON(bytewise(text))), [{ a: 1 }, { b: 'ü' }, { done: true }]);
});

test('readNDJSON throws on a malformed or truncated line without echoing its content', async () => {
  await assert.rejects(all(readNDJSON(chunks(['{"a":1}\n{"secret": "sk-ant-api03-zzz"\n']))), (e) => e.code === 'ERR_STREAM_MALFORMED' && !e.message.includes('sk-ant'));
  await assert.rejects(all(readNDJSON(chunks(['{"a":1}\n{"trunc']))), (e) => e.code === 'ERR_STREAM_TRUNCATED');
});

test('readLines refuses a runaway line', async () => {
  await assert.rejects(all(readLines(chunks(['x'.repeat(64)]), { maxLine: 16 })), (e) => e.code === 'ERR_STREAM_LINE_TOO_LONG');
});
