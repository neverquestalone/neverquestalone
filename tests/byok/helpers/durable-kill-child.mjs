// A bridge that is killed in the middle of its write queue (code health BR-04, durable writes; ordering
// test (a) in tests/byok/durable_queue_test.mjs). Run as its own process:
//
//   node durable-kill-child.mjs <root> <fifo|reordered> <before|after>
//
// The bridge (the real core, its store and publisher on one write worker, tests/byok/helpers/hooked-writer.mjs)
// answers a hello, then takes a typed message: the message's durable outbox write, then its ack's ringing
// publish. The worker kills this whole process at that outbox write: 'before' it is written (after 300 ms,
// time for the main thread to queue the ack's slot behind it), or right 'after' (300 ms after it, the
// same). The test reads what is on disk then. A backend that can't take the send (NOT_READY) keeps the
// message in the outbox, so the outbox is where it is or isn't.
//
// reordered: a deliberately wrong queue (the outbox's writes go behind the next slot write), which the
// test must catch: an ack on disk for a message that isn't.
// Exit 3: nothing killed it within 10 s (the test fails).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createBridge } from '../../../bridge/service.mjs';
import { createSlotWorker } from '../../../bridge/write-queue.mjs';
import { installSlots } from '../../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../../bridge/transport/records.mjs';

const [root, order, point] = process.argv.slice(2);
const addons = path.join(root, 'AddOns');
installSlots(addons, { count: 3, iface: '16001' });
fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true });
const rule = { match: { kind: 'file', base: 'outbox.jsonl', durable: true }, at: point, then: 'kill', marker: path.join(root, 'killed.json'),
  ...(point === 'after' ? { delayAfterMs: 300 } : { delayMs: 300 }) };
const real = createSlotWorker({ url: pathToFileURL(path.join(import.meta.dirname, 'hooked-writer.mjs')), data: { serve: false, hooks: [rule] } });

// The wrong queue: a write of the outbox is held until the next slot write has been queued, then queued.
function reorder(w) {
  const held = [];
  return {
    ...w,
    writeFile(job, done) {
      if (path.basename(job.file) === 'outbox.jsonl') { held.push([job, done]); return true; }
      return w.writeFile(job, done);
    },
    write(job, done) {
      const r = w.write(job, done);
      while (held.length) { const [j, d] = held.shift(); w.writeFile(j, d); }
      return r;
    },
    busy: () => held.length > 0 || w.busy(),
  };
}
const writer = order === 'reordered' ? reorder(real) : real;

const bridge = createBridge({ transport: { slots: 3, ackRingMs: 0 } }, {
  stateDir: path.join(root, 'state'), addonsDir: addons, log: () => {},
  publisherOpts: { coalesceMs: 1, progressMs: 0, worker: writer },
  gatewayFactory: h => ({
    start() { h.onState({ state: 'ready', since: Date.now() }); h.onReady(); },
    stop() {},
    send: () => { throw new Error('NOT_READY: held for this test'); },
  }),
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function settled() {
  for (let i = 0; i < 500; i++) { await sleep(10); if (!writer.busy() && !bridge.publisher.writing()) return; }
  throw new Error('the hello\'s writes never settled');
}
setTimeout(() => process.exit(3), 10000);
bridge.start();
bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200 } }));
await settled();
await sleep(50);
await settled();
bridge.handlePayload(encodeRecord({ token: '3fa9c2d1', key: 'a3f1_1', type: 'msg', chat: 'c3f9a1e', args: { cur: 0, agent: 'main', name: 'Q' }, text: 'where next?' }));
