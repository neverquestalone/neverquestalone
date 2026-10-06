// Map layers: validation, versioned application, stop notes, reply blocks, and what a slot carries.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

let P; // bridge/app/map-protocol.mjs, an ES module this CommonJS file loads before its tests
test.before(async () => { P = await import('../bridge/app/map-protocol.mjs'); });

const pt = (x, y, extra = {}) => ({ m: 1429, x, y, label: `p${x}`, kind: 'ore', ...extra });

test('validateMapCommand sanitizes points, labels, kinds and layer names', () => {
  const why = [];
  const c = P.validateMapCommand({ op: 'set', layer: 'mining', title: 'A|cff00ff00b', points: [
    pt(10, 20, { label: 'x|Hitem:1|h\ny', kind: 'nonsense' }), { m: 'no', x: 1, y: 2 }, pt(150, -3),
  ] }, why);
  assert.equal(c.points.length, 2);
  assert.equal(c.points[0].kind, 'poi');
  assert.ok(!c.points[0].label.includes('|') && !c.points[0].label.includes('\n'));
  assert.deepEqual([c.points[1].x, c.points[1].y], [100, 0]);
  assert.ok(!c.title.includes('|'));
  assert.ok(why.some(w => /dropped invalid/.test(w)));
  assert.equal(P.validateMapCommand({ op: 'set', layer: 'bad name!', points: [pt(1, 1)] }), null);
  assert.equal(P.validateMapCommand({ op: 'set', layer: 'empty', points: [] }), null);
  assert.deepEqual(P.validateMapCommand({ op: 'clear', layer: 'mining' }), { op: 'clear', layer: 'mining' });
  assert.equal(P.validateMapCommand({ op: 'explode' }), null);
});

test('applyMapCommands bumps the version only on change and keeps the budget', () => {
  const map = P.newMap('e1');
  let r = P.applyMapCommands(map, [{ op: 'set', layer: 'a', points: [pt(1, 1)] }]);
  assert.ok(r.changed); assert.equal(map.version, 1);
  r = P.applyMapCommands(map, [{ op: 'clear', layer: 'nope' }]);
  assert.ok(!r.changed); assert.equal(map.version, 1);
  r = P.applyMapCommands(map, [{ op: 'set', layer: 'b', points: [pt(2, 2)] }, { op: 'clear', layer: 'a' }]);
  assert.equal(map.version, 2);
  assert.deepEqual(Object.keys(map.layers), ['b']);
  // Too many layers: the oldest go first.
  const many = [];
  for (let i = 0; i < P.MAP_LIMITS.layers + 3; i++) many.push({ op: 'set', layer: 'l' + i, points: [pt(i, i)] });
  P.applyMapCommands(map, many.map((c, i) => c), 0);
  assert.equal(Object.keys(map.layers).length, P.MAP_LIMITS.layers);
  // Too many points in total.
  const big = n => ({ op: 'set', layer: 'big' + n, points: Array.from({ length: 400 }, (_, i) => pt(i % 100, n)) });
  P.applyMapCommands(map, [big(1), big(2), big(3), big(4)]);
  const total = Object.values(map.layers).reduce((s, l) => s + l.points.length, 0);
  assert.ok(total <= P.MAP_LIMITS.totalPoints);
  r = P.applyMapCommands(map, [{ op: 'clearall' }]);
  assert.ok(r.changed); assert.equal(Object.keys(map.layers).length, 0);
});

test('validateMapCommand never throws: JSON that shadows toString is a command it can\'t read, not a lost reply (SY-03); "__proto__" is no layer name, and clearing a name no layer has changes nothing (SY-05)', () => {
  for (const c of [{ op: 'set', layer: { toString: 1 }, points: [pt(1, 1)] }, { op: 'set', layer: 'a', title: { toString: 1 }, points: [pt(1, 1)] },
    { op: 'set', layer: 'a', points: [{ m: 1429, x: { valueOf: 1 }, y: 2, label: 'x', kind: 'ore' }] }, { op: { toString: 1 } }]) {
    const why = [];
    assert.doesNotThrow(() => P.validateMapCommand(c, why));
  }
  const why = [];
  assert.equal(P.validateMapCommand({ op: 'set', layer: { toString: 1 }, points: [pt(1, 1)] }, why), null);
  assert.deepEqual(why, ['a map command could not be read']);
  const map = P.newMap('e1');
  assert.doesNotThrow(() => P.applyMapCommands(map, [{ op: 'set', layer: 'a', title: { toString: 1 }, points: [pt(1, 1)] }, { op: 'set', layer: 'b', points: [pt(2, 2)] }]));
  assert.deepEqual(Object.keys(map.layers), ['b'], 'the readable one is drawn');
  assert.equal(P.validateMapCommand({ op: 'set', layer: '__proto__', points: [pt(1, 1)] }), null);
  const v = map.version;
  assert.equal(P.applyMapCommands(map, [{ op: 'clear', layer: 'toString' }]).changed, false);
  assert.equal(map.version, v);
});

test('a stop note says what to do there, never how far or how close the stop is: the HUD shows the live distance, so dropDistanceClaims takes the claim\'s own words out, a clause only when nothing else is in it, and leaves the rest as written', () => {
  const notes = require('./fixtures/stop-notes.json');
  // The owner's recording: under "1. Hezrul Bloodmark turn-in / 175 yd · ahead" the note said this.
  assert.deepEqual(notes.recording, ['Closest stop, a few steps from you. Hand in the head.', 'Hand in the head.']);
  assert.equal(P.dropDistanceClaims(notes.recording[0]), notes.recording[1]);
  // Places, landmarks, compass points and instructions stay, byte for byte.
  for (const note of notes.keep) assert.equal(P.dropDistanceClaims(note), note, note);
  for (const note of ['West of the Crossroads.', 'Kill the oozes around the pond.']) assert.ok(notes.keep.includes(note), note);
  // A claim goes by its sentence or clause when nothing else is in it; the next clause starts the sentence.
  for (const [note, left] of notes.drop) assert.equal(P.dropDistanceClaims(note), left, note);
  // An instruction is never lost: in a clause that holds one, only the claim's own words go.
  for (const [note, left] of notes.mixed) assert.equal(P.dropDistanceClaims(note), left, note);
  for (const [note, left] of [['Kill 8 boars 20yd away, then rest.', 'Kill 8 boars, then rest.'], ['Hand in the head right here.', 'Hand in the head.'],
    ['Turn in to Hezrul, a few steps from you.', 'Turn in to Hezrul.'], ['Loot the chest just around the corner.', 'Loot the chest.']]) {
    assert.ok(notes.mixed.some(([n, l]) => n === note && l === left), note);
  }
  assert.equal(P.dropDistanceClaims(''), '');
  // The list is small and says what it is.
  assert.ok(P.DISTANCE_CLAIMS.length <= 36, `${P.DISTANCE_CLAIMS.length} entries`);
  for (const e of ['closest/nearest$', 'from you', 'next to you', 'few steps~', '# yd/yds/yard/yards~', 'right here', 'just ahead~']) assert.ok(P.DISTANCE_CLAIMS.includes(e), e);
  // Every map command's notes go through it: a note left with nothing is no note, and the stop
  // keeps its label and quests.
  const c = P.validateMapCommand({ op: 'set', layer: 'barrens', title: 'Barrens quests', ordered: true, points: [
    { m: 1413, x: 52.1, y: 31.6, label: '1. Hezrul Bloodmark turn-in', kind: 'turnin', note: notes.recording[0], q: [852] },
    { m: 1413, x: 49.3, y: 33.8, label: '2. Oozes', kind: 'kill', note: 'Closest stop, a few steps from you.', q: [1180] },
    { m: 1413, x: 51.5, y: 30.3, label: '3. The Crossroads', kind: 'turnin', note: 'West of the Crossroads.', q: [870] },
    { m: 1413, x: 50.2, y: 32.9, label: '4. Boars', kind: 'kill', note: 'Kill 8 boars 20yd away, then rest.' },
  ] });
  assert.deepEqual(c.points.map(p => p.note), ['Hand in the head.', undefined, 'West of the Crossroads.', 'Kill 8 boars, then rest.']);
  assert.ok(!('note' in c.points[1]));
  assert.deepEqual(c.points[1].q, [1180]);
  const map = P.newMap('e1');
  P.applyMapCommands(map, [{ op: 'set', layer: 'barrens', ordered: true, points: [{ m: 1413, x: 52.1, y: 31.6, label: '1. Hezrul Bloodmark turn-in', kind: 'turnin', note: notes.recording[0] }] }]);
  assert.equal(map.layers.barrens.points[0].note, 'Hand in the head.');
});

test('drawnLayers: the layers a reply drew that are on the map after it, in its order, once each (the reply record\'s `drew`, for the game\'s Okay)', async () => {
  const { drawnLayers } = await import('../bridge/app/map.mjs');
  const map = P.newMap('e1');
  P.applyMapCommands(map, [{ op: 'set', layer: 'old', points: [pt(1, 1)] }]);
  const cmds = [
    { op: 'set', layer: 'loop', ordered: true, points: [pt(2, 2), pt(3, 3)] },
    { op: 'set', layer: 'pin', points: [pt(4, 4)] },
    { op: 'set', layer: 'gone', points: [pt(5, 5)] },
    { op: 'clear', layer: 'gone' }, // drawn, then taken off in the same reply
    { op: 'set', layer: 'old', points: [] }, // not valid: the old layer isn't this reply's
    { op: 'set', layer: 'bad name!', points: [pt(6, 6)] },
    { op: 'set', layer: 'loop', ordered: true, points: [pt(2, 2)] }, // drawn again: once
  ];
  P.applyMapCommands(map, cmds);
  assert.deepEqual(drawnLayers(map, cmds), ['loop', 'pin']);
  assert.equal(drawnLayers(map, [{ op: 'clearall' }]), null, 'nothing drawn: no field');
  assert.equal(drawnLayers(map, []), null);
  // A name that is a property of every object is never taken for a layer on the map.
  assert.equal(drawnLayers({ layers: {} }, [{ op: 'set', layer: 'constructor', points: [pt(1, 1)] }]), null);
  // The budget takes the oldest off, so a reply that sets 14 drew the last 12 (SY-02).
  const many = Array.from({ length: 14 }, (_, i) => ({ op: 'set', layer: 'L' + i, points: [pt(i, i)] }));
  const big = P.newMap('e2'); P.applyMapCommands(big, many);
  assert.deepEqual(drawnLayers(big, many), many.slice(2).map(c => c.layer));
  // A layer already there, drawn again, is this reply's.
  const again = [{ op: 'set', layer: 'L5', points: [pt(9, 9)] }]; P.applyMapCommands(big, again);
  assert.deepEqual(drawnLayers(big, again), ['L5']);
  // "__proto__" is never an own layer, so never drawn.
  const proto = [{ op: 'set', layer: '__proto__', points: [pt(1, 1)] }];
  const m3 = P.newMap('e3'); P.applyMapCommands(m3, proto);
  assert.equal(drawnLayers(m3, proto), null);
});

test('drawnLayers: a reply that sets a layer and clears it again drew only what stays on the map (DREW-SY-06)', async () => {
  const { drawnLayers } = await import('../bridge/app/map.mjs');
  const cmds = [
    { op: 'set', layer: 'loop', ordered: true, points: [pt(2, 2), pt(3, 3)] },
    { op: 'set', layer: 'gone', points: [pt(5, 5)] },
    { op: 'clear', layer: 'gone' },
    { op: 'set', layer: 'old', points: [] }, // not valid
    { op: 'set', layer: 'bad name!', points: [pt(6, 6)] },
    { op: 'set', layer: 'loop', points: [pt(2, 2)] },
  ];
  const map = P.newMap('e1'); P.applyMapCommands(map, cmds);
  assert.deepEqual(drawnLayers(map, cmds), ['loop'], 'what it drew is those still on the map');
});

test('fitMapBytes (DREW-SY-04): the map stays within what a slot always carries: the oldest layers go first, then the newest one\'s notes, then its last stops; drew never names what went', async () => {
  const { fitMapBytes, mapBytes, drawnLayers, MAP_BYTES_MAX } = await import('../bridge/app/map.mjs');
  const { slotTable, SLOT_BYTES_MAX } = await import('../bridge/transport/luaenc.mjs');
  const { toSlotMap } = await import('../bridge/app/map.mjs');
  assert.equal(MAP_BYTES_MAX, 40 * 1024);
  const ore = (layer, n, t) => ({ op: 'set', layer, title: `Copper ${layer}`, points: Array.from({ length: n }, (_, i) => ({ m: 1412, x: 10 + (i % 80) * 0.97, y: 10 + (i % 70) * 1.13, label: 'Copper Vein', kind: 'ore' })) });
  const route = n => ({ op: 'set', layer: 'route', title: 'Mulgore quests', ordered: true, points: Array.from({ length: n }, (_, i) => ({ m: 1412, x: 40 + (i % 50) * 0.37, y: 60 + (i % 30) * 0.51, label: `${i + 1}. Wolves and plainstriders`, kind: 'kill', note: 'The plains around Bloodhoof Village; the paws drop from the wolves near the lake shore.', q: [761] })) });
  // Inside the prompt's limits (1,230 points, 4 layers), far past a slot's room: the critic's case, 60 KB.
  const map = P.newMap('e1');
  P.applyMapCommands(map, [ore('a', 400)], 1000);
  P.applyMapCommands(map, [ore('b', 400)], 2000);
  P.applyMapCommands(map, [ore('c', 400)], 3000);
  const cmds = [route(30)];
  P.applyMapCommands(map, cmds, 4000);
  assert.ok(mapBytes(map) > 55 * 1024, `${mapBytes(map)} bytes before`);
  const before = structuredClone(map);
  const without = names => { const m = structuredClone(before); for (const n of names) delete m.layers[n]; return mapBytes(m); };
  const v = map.version;
  const fit = fitMapBytes(map);
  assert.ok(mapBytes(map) <= MAP_BYTES_MAX, `${mapBytes(map)} bytes after`);
  assert.ok(without(['a']) > MAP_BYTES_MAX, 'the oldest alone isn\'t enough here');
  assert.deepEqual(fit.dropped.map(d => d.name), ['a', 'b'], 'the oldest first, and no more than needed');
  assert.deepEqual(fit.dropped.map(d => d.title), ['Copper a', 'Copper b']);
  assert.deepEqual([fit.notes, fit.stops, fit.changed, map.version], [null, null, true, v + 1]);
  assert.deepEqual(Object.keys(map.layers).sort(), ['c', 'route']);
  assert.deepEqual(drawnLayers(map, cmds), ['route']);
  assert.equal(drawnLayers(map, [ore('a', 1)]), null, 'a layer that went is never named');
  // The slot now carries it, beside a header and a reply.
  const slot = { v: 2, ts: 'x', now: 1, token: 't', bridge: {}, records: [{ seq: 1, t: 'reply', chat: 'c3f9a1e', text: 'Marked.', summary: 'Marked.' }], map: toSlotMap(map) };
  const out = slotTable('NQA_SlotData', slot, { includeMap: true });
  assert.equal(out.mapIncluded, true);
  assert.ok(out.bytes <= SLOT_BYTES_MAX);
  // Within the budget already: nothing changes.
  assert.deepEqual(fitMapBytes(map), { changed: false, dropped: [], notes: null, stops: null });
  // One layer alone past it (a long route of long labels): its notes go, then its last stops.
  const one = P.newMap('e2');
  const long = { op: 'set', layer: 'long', title: 'The long way', ordered: true, points: Array.from({ length: 400 }, (_, i) => ({ m: 1412, x: (i % 90) + 0.5, y: (i % 80) + 0.5, label: `${i + 1}. ${'Through the canyon and past the ridge '.repeat(2)}`.slice(0, 80), kind: 'explore', note: 'n'.repeat(15) })) };
  P.applyMapCommands(one, [long], 5000);
  assert.ok(mapBytes(one) > MAP_BYTES_MAX);
  const f2 = fitMapBytes(one);
  assert.ok(mapBytes(one) <= MAP_BYTES_MAX);
  assert.deepEqual(f2.dropped, [], 'the newest layer is never dropped');
  assert.equal(f2.notes, 'long');
  assert.equal(f2.stops.name, 'long');
  assert.equal(f2.stops.of, 400);
  assert.equal(f2.stops.kept, one.layers.long.points.length);
  assert.ok(f2.stops.kept > 300 && f2.stops.kept < 400, `${f2.stops.kept} kept`);
  // Adding one more stop would pass the budget: it keeps the most that fit.
  assert.equal(one.layers.long.points[0].label.startsWith('1. '), true, 'the route\'s start is kept');
});

test('extractMapBlocks takes objects, arrays and JSON lines out of the reply', () => {
  const text = 'Here is your route.\n\n```wowmap\n{"op":"set","layer":"a","points":[{"m":1429,"x":1,"y":2}]}\n```\n\nAnd more:\n```wowmap\n[{"op":"clear","layer":"b"}]\n```\n```wowmap\n{"op":"clearall"}\nnot json\n```\nBye.';
  const r = P.extractMapBlocks(text);
  assert.equal(r.cmds.length, 3);
  assert.equal(r.errors.length, 1);
  assert.ok(!r.text.includes('wowmap'));
  assert.ok(r.text.startsWith('Here is your route.') && r.text.endsWith('Bye.'));
  assert.deepEqual(P.extractMapBlocks('no blocks').cmds, []);
});

test('routeNow: the newest ordered layer, its first stop and how many (CL-design-41); none without an ordered layer', async () => {
  const { routeNow } = await import('../bridge/app/map.mjs');
  const map = P.newMap('ep0ch');
  assert.equal(routeNow(map), null, 'an empty map');
  P.applyMapCommands(map, [{ op: 'set', layer: 'ore', title: 'Copper', points: [pt(10, 10)] }], 1000);
  assert.equal(routeNow(map), null, 'pins only: no route');
  P.applyMapCommands(map, [{ op: 'set', layer: 'old', title: 'Old route', ordered: true, points: [pt(1, 1, { label: 'Old stop' })] }], 2000);
  P.applyMapCommands(map, [{ op: 'set', layer: 'quests', title: 'Camp Narache', ordered: true, points: [pt(20, 20, { label: 'The Hunt Begins', kind: 'quest' }), pt(30, 30), pt(40, 40)] }], 3000);
  assert.deepEqual(routeNow(map), { title: 'Camp Narache', next: 'The Hunt Begins', stops: 3, at: 3000 });
  assert.equal(routeNow(null), null);
});
