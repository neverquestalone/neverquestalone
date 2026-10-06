// A wowmap block that failed (public BYOK PRD §6.3; RT-3): bridge/byok/runtime/repair.mjs, with the
// real renderer and map validators. What's wrong, the player's line and the log's; the repair pass
// itself is cut (systems plan D6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as repair from '../../bridge/byok/runtime/repair.mjs';
import { renderReply } from '../../bridge/app/render.mjs';
import * as protocol from '../../bridge/app/map-protocol.mjs';

const { mapFences, mapFailures, mapFailureLine, mapFailureLog } = repair;
const GOOD = '{"op":"set","layer":"mulgore","title":"Mulgore","ordered":true,"points":[{"m":1412,"x":49.5,"y":67.5,"label":"1. Wolves","kind":"kill","note":"South of the village.","q":[748]}]}';
const BROKEN_REPLY = `Here's your route.\n\n\`\`\`wowmap\n{"op":"set","layer":"mulgore","points":[{"m":1412,"x":49.5,"y":67.5,,}]}\n\`\`\`\n\n\`\`\`wowchips\nRoute me there\n\`\`\`\n\nTL;DR:\nRoute drawn through Mulgore.`;

test('map check: a broken block is noticed; a good one or none is fine; the repair pass is gone (D6)', () => {
  assert.equal(renderReply(BROKEN_REPLY).mapErrors.length, 1);
  const f = mapFailures(BROKEN_REPLY);
  assert.equal(f.length, 1);
  assert.match(f[0], /^unreadable wowmap line: /);
  assert.deepEqual(mapFailures(`ok\n\`\`\`wowmap\n${GOOD}\n\`\`\`\nTL;DR:\nx`), []);
  assert.deepEqual(mapFailures('no map at all'), []);
  assert.equal(mapFailureLine(null), null);
  assert.equal(mapFailureLine([]), null);
  for (const gone of ['shouldRepair', 'buildRepairRequest', 'repairAsk', 'mergeRepair', 'extractMapBlock', 'REPAIR_MAX_TOKENS']) assert.equal(repair[gone], undefined, gone);
});

test('map check: blocks that parse but fail validation are failures too (the likeliest weak-model mistakes)', () => {
  // A layer name with a space, and a map name where the id goes: the validator drops the command.
  const reply = 'Route.\n\n```wowmap\n{"op":"set","layer":"Mulgore quests","ordered":true,"points":[{"m":1412,"x":49.5,"y":67.5,"label":"1"}]}\n{"op":"set","layer":"mulgore","ordered":true,"points":[{"m":"Mulgore","x":49.5,"y":67.5},{"m":0,"x":1,"y":2}]}\n{"op":"set","layer":"barrens","ordered":true,"points":[{"m":1413,"x":50,"y":50},{"m":1413,"x":"west","y":50},{"m":1413,"x":52,"y":51}]}\n{"op":"paint","layer":"x"}\n```\n\nTL;DR:\nDrawn.';
  const r = renderReply(reply);
  assert.deepEqual(r.mapErrors, [], 'every line parsed: the renderer alone saw nothing wrong');
  const f = mapFailures(reply);
  assert.deepEqual(f, [
    'bad layer name "Mulgore quests"',
    'layer mulgore: none of its 2 stops had a usable map id and position (m a whole number from 1 to 99999, x and y numbers)',
    'layer barrens: 1 of 3 stops had no usable map id or position (m a whole number from 1 to 99999, x and y numbers)',
    'unknown op "paint"',
  ]);
  assert.equal(mapFailureLine(r), mapFailureLine(f), 'renderReply\'s result works too: it holds the commands');
  assert.equal(mapFailureLine(renderReply(`ok\n\`\`\`wowmap\n${GOOD}\n\`\`\`\nTL;DR:\nx`)), null);
  assert.equal(mapFailureLine({ text: 'no map fields' }), null);
  assert.equal(mapFailureLine(f), 'Couldn\'t draw the map: 1 stop had no map position; 3 layers couldn\'t be used.');
  assert.match(mapFailureLog(f), /^map block failed: bad layer name "Mulgore quests"; layer mulgore: none of its 2 stops/);
  // Budget clamps are not failures: the 401st point, notes past the layer's allowance.
  const big = { op: 'set', layer: 'big', points: Array.from({ length: 405 }, (_, i) => ({ m: 1412, x: i % 100, y: 1, note: 'n'.repeat(200) })) };
  assert.deepEqual(mapFailures(`\`\`\`wowmap\n${JSON.stringify(big)}\n\`\`\``), []);
  assert.equal(mapFailureLine([]), null);
  assert.equal(mapFailureLog('fine'), null);
  assert.equal(mapFailureLine(BROKEN_REPLY), 'Couldn\'t draw the map: 1 line of it couldn\'t be read.');
});

test('map check: the wowmap fence is anchored (RT-3); inline and unclosed blocks are reported, not drawn', () => {
  // map-protocol.mjs reads only fences on lines of their own, and a body opens no other fence.
  const inline = 'Route: ```wowmap\n{"op":"clearall"}\n``` done';
  assert.deepEqual(protocol.extractMapBlocks(inline).cmds, [], 'an inline block is not drawn');
  const unclosed = 'Route.\n\n```wowmap\n{"op":"set",\n\n```wowchips\nRoute me there\n```\n\nTL;DR:\nx';
  assert.deepEqual(protocol.extractMapBlocks(unclosed).cmds, []);
  assert.deepEqual(renderReply(unclosed).chips, ['Route me there'], 'the unclosed block no longer eats the chips');
  assert.deepEqual(protocol.extractMapBlocks('ok\n   ```wowmap\n{"op":"clearall"}\n   ```  \nTL;DR:\nx').cmds, [{ op: 'clearall' }], 'up to 3 spaces in');
  assert.deepEqual(mapFailures(inline), ['a wowmap block was not on lines of its own (the opening fence must start a line)']);
  assert.deepEqual(mapFailures(unclosed), ['a wowmap block was never closed with a ``` line of its own']);
  assert.equal(mapFailureLine(unclosed), 'Couldn\'t draw the map: the block was cut off or out of place.');
  assert.deepEqual(mapFences(unclosed).map(f => [f.closed, f.inline, f.body]), [[false, false, '{"op":"set",']]);
  assert.equal(mapFailureLine(inline), 'Couldn\'t draw the map: the block was cut off or out of place.');
});

test('map check: JSON that shadows toString or valueOf (game data the model echoed) is a failure the player sees, never a throw', () => {
  const hostile = [
    '{"op":"set","layer":"a","title":{"toString":1},"points":[{"m":1412,"x":1,"y":1,"label":"ok"}]}',
    '{"op":"set","layer":{"toString":1},"points":[]}',
    '{"op":"set","layer":"b","points":[{"m":{"valueOf":1,"toString":1},"x":1,"y":1}]}',
    '{"op":{"toString":1},"layer":"c"}',
  ];
  for (const line of hostile) {
    const reply = `Here.\n\n\`\`\`wowmap\n${line}\n\`\`\`\n\nTL;DR: here.`;
    assert.deepEqual(mapFailures(reply), ['a map command could not be read'], line);
    assert.equal(mapFailureLine(reply), "Couldn't draw the map: 1 layer couldn't be used.");
    assert.match(mapFailureLog(reply), /could not be read/);
    const why = [];
    assert.equal(protocol.validateMapCommand(JSON.parse(line), why), null);
    assert.deepEqual(why, ['a map command could not be read']);
    const map = protocol.newMap('e');
    assert.deepEqual(protocol.applyMapCommands(map, [JSON.parse(line)]), { changed: false, notes: ['a map command could not be read'] });
    assert.equal(renderReply(reply).text, 'Here.\n\nTL;DR: here.');
  }
});
