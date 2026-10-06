// The slot encoder: what the bridge writes is exactly what the addon reads,
// nothing escapes a string (fuzzed across the byte range), and the budget holds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { luaStr, luaValue, slotTable, fitRecords, SLOT_BYTES_MAX } from '../bridge/transport/luaenc.mjs';
import { newLuaVM } from './helpers/luavm.mjs';

const V = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'protocol-v2.json'), 'utf8'));

function roundTrip(value) {
  const vm = newLuaVM();
  const before = new Set(vm.globalNames());
  vm.run(`X = ${luaValue(value)}`);
  const added = vm.globalNames().filter(n => !before.has(n));
  return { got: vm.global('X'), added };
}

test('luaenc: the shared slot vector loads in Lua as written', () => {
  const { text } = slotTable('NQA_SlotData', V.slot);
  const vm = newLuaVM();
  vm.run(text);
  const got = vm.global('NQA_SlotData');
  assert.equal(got.v, 2);
  assert.equal(got.token, V.slot.token);
  assert.deepEqual(got.bridge, V.slot.bridge);
  assert.deepEqual(got.agents, V.slot.agents);
  assert.equal(got.chats[0].run.last, V.slot.chats[0].run.last);
  assert.deepEqual(got.records.map(r => r.seq), [512, 513, 514]);
  assert.equal(got.records[0].text, V.slot.records[0].text);
  assert.equal(got.records[2].replay, 1);
});

test('luaenc: fuzz — any text survives exactly and nothing escapes the string', () => {
  const specials = ['"', '\\', '\n', '\r', '\t', '\0', ']]', '[[', '--', '"; os.exit() --', '\\"', '\x1b', '\x7f', '|', '||', '|cff00ff00', 'é', '🐉', ' ', '\ud800', 'end', '}', '{'];
  let seed = 1234567;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 400; i++) {
    let s = '';
    const len = rnd(60);
    for (let j = 0; j < len; j++) {
      const pick = rnd(10);
      if (pick < 3) s += specials[rnd(specials.length)];
      else if (pick < 6) s += String.fromCharCode(rnd(256));
      else s += String.fromCharCode(0x20 + rnd(0x5f));
    }
    const value = { text: s, [s.slice(0, 8) || 'k']: s, list: [s, i] };
    const { got, added } = roundTrip(value);
    const wf = v => (typeof v === 'string' ? v.toWellFormed() : Array.isArray(v) ? v.map(wf) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.toWellFormed(), wf(x)])) : v);
    const want = wf(value);
    assert.deepEqual(got, want, `case ${i}: ${JSON.stringify(s)}`);
    assert.deepEqual(added, ['X'], `case ${i}: only X was defined`);
  }
});

test('luaenc: every single byte value survives in a string', () => {
  let all = '';
  for (let c = 0; c < 256; c++) all += String.fromCharCode(c);
  assert.equal(roundTrip(all).got, all);
  assert.doesNotMatch(luaStr(all), /[\x00-\x1f\x7f]/, 'no raw control bytes in the literal');
});

test('luaenc: keys that are not identifiers are quoted; keywords too', () => {
  const { got } = roundTrip({ end: 1, 'a b': 2, '1x': 3, ok_1: 4 });
  assert.deepEqual(got, { end: 1, 'a b': 2, '1x': 3, ok_1: 4 });
});

test('luaenc: the records budget trims the oldest reply bodies first, never drops a record', () => {
  const big = 'x'.repeat(15000);
  const records = [1, 2, 3, 4].map(seq => ({ seq, t: 'reply', chat: 'c3f9a1e', text: big, summary: `sum ${seq}`, more: 0 }));
  const fit = fitRecords(records, 40960);
  assert.equal(fit.records.length, 4);
  assert.equal(fit.trimmed, 2);
  assert.deepEqual(fit.records.map(r => r.text.length), [5, 5, 15000, 15000]);
  assert.deepEqual(fit.records.map(r => r.more), [15000, 15000, 0, 0]);
  const { bytes } = slotTable('NQA_SlotData', { ...V.slot, records });
  assert.ok(bytes <= SLOT_BYTES_MAX, `${bytes} bytes`);
});

test('luaenc (DREW-SY-04): while the map rides, the records take what it leaves: the oldest reply bodies are cut to their summary, and the map goes in (it was left out)', () => {
  // A 38 KB map (within map.mjs MAP_BYTES_MAX, 40 KB) and three unread 13 KB replies: 78 KB in all.
  const points = Array.from({ length: 850 }, (_, i) => [1412, 10 + (i % 80) * 0.97, 10 + (i % 70) * 1.13, 'Copper Vein', 'ore']);
  const map = { epoch: 'e1', version: 3, layers: [{ name: 'ore', title: 'Copper', ordered: false, loop: false, points }] };
  const mapLine = `\tmap = ${luaValue(map)},`;
  assert.ok(Buffer.byteLength(mapLine) > 36 * 1024 && Buffer.byteLength(mapLine) <= 40 * 1024, `${Buffer.byteLength(mapLine)} bytes`);
  const records = [1, 2, 3].map(seq => ({ seq, t: 'reply', chat: 'c3f9a1e', text: 'y'.repeat(13000), summary: `sum ${seq}`, more: 0 }));
  // Alone, the records fit their 40 KB whole; beside the map they didn't fit the file, and the map was left out.
  assert.equal(slotTable('NQA_SlotData', { ...V.slot, records, map }).trimmed, 0);
  const out = slotTable('NQA_SlotData', { ...V.slot, records, map }, { includeMap: true });
  assert.equal(out.mapIncluded, true, 'the map goes in');
  assert.ok(out.bytes <= SLOT_BYTES_MAX, `${out.bytes} bytes`);
  assert.equal(out.trimmed, 2, 'the two oldest bodies are cut to their summary');
  assert.match(out.text, /sum 1/);
  assert.match(out.text, /sum 2/);
  assert.ok(out.text.includes('y'.repeat(13000)), 'the newest reply whole');
  assert.match(out.text, /more = 13000/);
});

test('luaenc: the map goes in only when asked for and when it fits', () => {
  const map = { epoch: 'e1', version: 3, layers: [{ name: 'route', title: 'Hyjal', ordered: true, loop: false, points: [[1412, 44.1, 76.3, 'start', 'poi']] }] };
  assert.equal(slotTable('S', { ...V.slot, map }).mapIncluded, false);
  assert.equal(slotTable('S', { ...V.slot, map }, { includeMap: true }).mapIncluded, true);
  const base = slotTable('S', V.slot).bytes;
  assert.equal(slotTable('S', { ...V.slot, map }, { includeMap: true, maxBytes: base + 5 }).mapIncluded, false);
});
