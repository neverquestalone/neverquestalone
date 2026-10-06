'use strict';
// The addon's half of the slot window (systems critic SY-03, D5's first items): the addon says
// where its next slot load is, slot=<R.slots.nextIndex>, on its hello and on a seen it draws after
// every load (a load that brought nothing newer included), and its hello says the way its records go
// out, mode=pixel|stream|reload. The bridge then writes only the slots from there on and guesses at
// nothing (tests/transport_resilience_test.mjs has both sides together).
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM } = require('../helpers/nqa-vm');
const { PUBLIC, ring, oldSlot, byokSlot } = require('../helpers/byok-slots');

const US = '\x1f';
// A wire's args as a map ("cur=0;slot=2" → { cur: '0', slot: '2' }).
function argsOf(wire) {
  const f = wire.split(US);
  return Object.fromEntries(f[5].split(';').filter(Boolean).map(kv => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
}
const typeOf = wire => wire.split(US)[3];
const onStrip = (vm, type) => vm.stripWires().filter(w => typeOf(w) === type);
const inOutbox = (vm, type) => vm.outboxWires().map(e => e.wire).filter(w => typeOf(w) === type);
const publicVM = (db = null) => newVM({ extra: PUBLIC, ...(db ? { db } : {}) }).login();

test('the hello says where its next slot load is (slot=1) and the way out (mode=pixel, stream or reload), whatever installed the addon', () => {
  const vm = publicVM();
  vm.advance(3.1);
  const [hello] = onStrip(vm, 'hello');
  assert.ok(hello, 'the hello is on the strip');
  assert.deepEqual([argsOf(hello).slot, argsOf(hello).mode], ['1', 'pixel']);
  assert.equal(vm.num('NS.R.slots.reported'), 1, 'what it said is kept, so the next seen says only what moved');
  // Stream and reload modes send it through the reload path, and say so.
  for (const [settings, mode] of [['{ stream = true }', 'stream'], ['{ mode = "reload" }', 'reload']]) {
    const other = publicVM(`NQADB = { settings = ${settings} }`);
    other.advance(3.1);
    const [h] = inOutbox(other, 'hello');
    assert.ok(h, `${mode}: the hello waits in the outbox`);
    assert.deepEqual([argsOf(h).slot, argsOf(h).mode], ['1', mode]);
  }
  const plain = newVM().login();
  plain.advance(3.1);
  const [plainHello] = onStrip(plain, 'hello');
  assert.ok(plainHello);
  assert.deepEqual([argsOf(plainHello).slot, argsOf(plainHello).mode], ['1', 'pixel'], 'no TOC stamp: the same hello');
});

test('after every slot load the addon draws a seen with its next slot, even for a load that brought nothing newer, whatever the slot lists in its caps', () => {
  const vm = publicVM();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  // The hello's answer, with no push counter yet: the load brings nothing newer, and still gets a seen.
  vm.slot(byokSlot({ nonce, push: 0 }));
  ring(vm);
  assert.equal(vm.num('NS.R.slots.nextIndex'), 2, 'slot 1 loaded');
  let [seen] = onStrip(vm, 'seen');
  assert.ok(seen, 'a seen after the load');
  assert.deepEqual(argsOf(seen), { cur: '0', slot: '2' }, 'no p= (nothing read yet), the next slot');
  // One seen on the strip at a time: a second load while it's up is said when it's gone (5 s),
  // at the 2-second tick after that.
  vm.advance(1.6);
  ring(vm);
  assert.equal(vm.num('NS.R.slots.nextIndex'), 3);
  assert.equal(argsOf(onStrip(vm, 'seen')[0]).slot, '2', 'still the first one up');
  vm.advance(7);
  [seen] = onStrip(vm, 'seen');
  assert.ok(seen, 'the next seen, once the first is gone');
  assert.deepEqual(argsOf(seen), { cur: '0', slot: '3' });
  // A load that reads a newer push counter: p= as before, and the slot after it.
  vm.advance(6);
  vm.slot(byokSlot({ nonce, push: 4 }));
  ring(vm);
  [seen] = onStrip(vm, 'seen');
  assert.deepEqual(argsOf(seen), { cur: '0', p: '4', slot: '4' });
  assert.equal(vm.num('NS.R.seen.p'), 4, 'the push counter it reports is still the one it read');
  vm.advance(6);
  assert.equal(vm.num('NS.R.push.reported'), 4, 'counted as reported when the seen goes');
  // The bridge missed that seen and rings again for the same publish: the load brings nothing newer,
  // and the seen after it says p=4 again, so one missed seen costs one load (the transport review's
  // bug 3; main's T.Poll rule, which this build doesn't need: TRF-SYS-04).
  vm.slot(byokSlot({ nonce, push: 4 }));
  ring(vm);
  [seen] = onStrip(vm, 'seen');
  assert.deepEqual(argsOf(seen), { cur: '0', p: '4', slot: '5' }, 'the push counter it read, said again');

  // A slot with none of the new caps (its provider part failed, or an app from before them): the same.
  const capless = newVM().login();
  capless.advance(3.1);
  capless.slot(oldSlot({ nonce: capless.evaluate('NS.R.nonce'), push: 0 }));
  ring(capless);
  assert.equal(capless.num('NS.R.slots.nextIndex'), 2);
  assert.deepEqual(onStrip(capless, 'seen').map(argsOf), [{ cur: '0', slot: '2' }], 'nothing newer read, and still a seen');
});

test('one slot load per turn when the ack rides the reply (audit PF-02): the reply\'s slot clears the pending message and its outbox entry, and applies the reply', () => {
  const { replyRec } = require('../helpers/byok-slots');
  const vm = publicVM();
  vm.advance(3.1);
  const nonce = vm.evaluate('NS.R.nonce');
  vm.slot(byokSlot({ nonce, push: 1 }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(2);
  const chat = vm.evaluate('NS.Chats.Active().id');
  vm.send('hi');
  vm.advance(0.5);
  const key = vm.evaluate('NS.Chats.Active().pending[1].key');
  assert.ok(key, 'the message is pending');
  assert.equal(vm.outboxWires().filter(e => e.key === key).length, 1, 'and in the outbox');
  const before = vm.loads();
  // The bridge rang once, for the reply; that slot carries the ack too (bridge.acked).
  vm.slot(byokSlot({ nonce, push: 2, records: [replyRec(1, chat, 'r')] }).replace('acked = {}', `acked = { "${key}" }`));
  ring(vm);
  vm.advance(1.6);
  assert.equal(vm.loads() - before, 1, 'one load for the ack and the reply');
  assert.equal(vm.num('#NS.Chats.Active().pending'), 0, 'nothing pending');
  assert.equal(vm.outboxWires().filter(e => e.key === key).length, 0, 'no keyed entry left in the outbox');
  assert.equal(vm.num('NQADB.cursor'), 1, 'the reply applied');
  assert.equal(vm.lastHistory().text, 'r');
});
