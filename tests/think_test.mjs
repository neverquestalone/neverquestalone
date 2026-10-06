// How hard NeverQuestAlone thinks in WoW (the owner, 2026-09-25; PROTOCOL §2.4 patch, §4.1):
// the bridge sends each turn of a chat with /nqa think's level as its
// `thinking`, and none for a chat without one (the player's effort; code health
// BR-28: no bridge default, sessions.thinking, any more); the addon's
// /nqa think sends a patch record with `think`, only when the bridge lists
// the `think` cap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startRealBackend } from './helpers/real-backend.mjs';
import { createBridge } from '../bridge/service.mjs';
import { installSlots } from '../bridge/transport/slots.mjs';
import { encodeRecord, parseRecord } from '../bridge/transport/records.mjs';
import { newLuaVM } from './helpers/luavm.mjs';

const require = createRequire(import.meta.url);
const { newVM } = require('./helpers/nqa-vm.js');

const TOKEN = '3fa9c2d1';
const CHAT = 'c3f9a1e';
const SID = 'a1b2c3d4e5f60718';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 5000, label = 'condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(20); }
  throw new Error(`timed out waiting for ${label}`);
}

// ------------------------------------------------------------------ bridge

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-think-'));
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 3, iface: '16001' });
  return { tmp, addons, state: path.join(tmp, 'state') };
}

// On the product's backend, its turns answered by the providers' mock server (tests/helpers/real-backend.mjs).
function makeBridge(env, be, config = {}) {
  const log = () => {};
  return createBridge({ transport: { slots: 3 }, ...config }, {
    stateDir: env.state, addonsDir: env.addons, log,
    publisherOpts: { coalesceMs: 5, progressMs: 0 },
    signalsOpts: { pulseMs: { push: 30, alive: 25, act: 5 }, actGapMs: 5 },
    gatewayFactory: be.factory,
  });
}

const list = v => (Array.isArray(v) ? v : []);
function readSlot(env) {
  const vm = newLuaVM();
  vm.run(fs.readFileSync(path.join(env.addons, 'NQA_S001', 'Inbox.lua'), 'utf8'));
  const d = vm.global('NQA_SlotData');
  return { ...d, chats: list(d.chats), bridge: { ...d.bridge, caps: list(d.bridge?.caps), acked: list(d.bridge?.acked) } };
}
const sends = mock => mock.sends();

let n = 0;
const nonce = 'b7e1';
const rec = (type, chat, args = {}, extra = {}) => encodeRecord({ token: TOKEN, key: type === 'hello' ? nonce : `${nonce}_${++n}`, type, chat: type === 'hello' ? '' : chat, args: { cur: 0, ...args }, ...extra });
const hello = () => rec('hello', '', { ver: '1.2.0', ctx: 0, sid: SID });
const msg = (chat, text, agent = 'main') => rec('msg', chat, { agent, name: 'Route', ctx: 0, q: 'followup' }, { text });
const think = (chat, level, agent = 'main') => rec('patch', chat, { agent, think: level });

async function withBridge(opts, fn) {
  const mock = await startRealBackend();
  const env = setup();
  const bridge = makeBridge(env, mock, opts);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', 5000, 'backend ready');
    bridge.handlePayload(hello());
    await fn({ bridge, mock, env });
  } finally {
    await bridge.stop();
    await mock.close();
  }
}

test('think (bridge): turns go with no level by default (the player\'s effort); /nqa think changes one chat from its next turn; default goes back; junk is ignored', async () => {
  await withBridge({}, async ({ bridge, mock, env }) => {
    await waitFor(() => readSlot(env).bridge.caps.includes('think'), 2000, 'the think cap in the slot');
    bridge.handlePayload(msg(CHAT, 'what is next?'));
    const first = await waitFor(() => sends(mock)[0], 3000, 'the first send');
    assert.equal(first.thinking, undefined, 'no bridge default');
    await waitFor(() => readSlot(env).chats.find(c => c.id === CHAT), 2000, 'the chat in the slot');
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT).think, undefined);

    bridge.handlePayload(think(CHAT, 'high'));
    await waitFor(() => readSlot(env).chats.find(c => c.id === CHAT)?.think === 'high', 2000, 'the chat shows high');
    assert.ok(readSlot(env).bridge.acked.includes(`${nonce}_${n}`), 'the patch is acked');
    bridge.handlePayload(msg(CHAT, 'write me a macro'));
    const second = await waitFor(() => sends(mock)[1], 3000, 'the second send');
    assert.equal(second.thinking, 'high');

    bridge.handlePayload(think(CHAT, 'ludicrous')); // not a level: logged, acked, nothing changes
    bridge.handlePayload(msg(CHAT, 'and now?'));
    assert.equal((await waitFor(() => sends(mock)[2], 3000, 'the third send')).thinking, 'high');

    bridge.handlePayload(think(CHAT, 'default'));
    bridge.handlePayload(msg(CHAT, 'back to normal'));
    assert.equal((await waitFor(() => sends(mock)[3], 3000, 'the fourth send')).thinking, undefined, 'back to the player\'s effort');
    assert.equal(sends(mock).filter(s => s.chatId === CHAT).length, 4, 'one chat throughout');
  });
});

test('think (bridge): a patch before the chat\'s first msg makes the chat with its agent and level; a Companion turn goes at the player\'s effort', async () => {
  await withBridge({}, async ({ bridge, mock, env }) => {
    const other = 'c0a1b2c';
    bridge.handlePayload(think(other, 'low', 'coder'));
    await sleep(100);
    assert.equal(sends(mock).length, 0, 'a patch sends nothing');
    bridge.handlePayload(msg(other, 'refactor this', 'coder'));
    const s = await waitFor(() => sends(mock)[0], 3000, 'the send');
    assert.equal(s.chatId, other, 'the chat\'s turn');
    await waitFor(() => readSlot(env).chats.find(c => c.id === other)?.agent === 'coder', 2000, 'the chat with its own agent');
    assert.equal(s.thinking, 'low');
    // An event turn in the Companion chat, which has no level of its own: none.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: `${nonce}_${++n}`, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind: 'level_up', from: 7, to: 8, agent: 'main', name: 'Companion', sid: SID }, body: '' }));
    const e = await waitFor(() => sends(mock).find(x => x.chatId === 'c0ffee0'), 3000, 'the event turn');
    assert.equal(e.thinking, undefined);
  });
});

test('think (bridge, code health BR-28): an old config\'s sessions.thinking is read by nothing: no level, no bridge.think; a chat\'s own level still applies', async () => {
  await withBridge({ sessions: { thinking: 'medium' } }, async ({ bridge, mock, env }) => {
    bridge.handlePayload(msg(CHAT, 'hello'));
    const s = await waitFor(() => sends(mock)[0], 3000, 'the send');
    assert.equal(s.thinking, undefined);
    await waitFor(() => readSlot(env).chats.find(c => c.id === CHAT), 2000, 'the chat in the slot');
    assert.equal(readSlot(env).chats.find(c => c.id === CHAT).think, undefined);
    assert.equal(readSlot(env).bridge.think, undefined);
    bridge.handlePayload(think(CHAT, 'high'));
    bridge.handlePayload(msg(CHAT, 'again'));
    assert.equal((await waitFor(() => sends(mock)[1], 3000, 'the second send')).thinking, 'high');
  });
});

// ------------------------------------------------------------------ addon

function slotLua({ nonce: nn, caps = ['state', 'evt', 'think'], chats = '{}', bthink = null } = {}) {
  const c = caps.length ? `, caps = { ${caps.map(x => `"${x}"`).join(', ')} }` : '';
  const t = bthink ? `, think = "${bthink}"` : '';
  return `{ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.2.0", push = 0, nonce = ${nn ? `"${nn}"` : 'nil'}, acked = {}${c}${t} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = ${chats}, records = {} }`;
}
function answered(caps, think = null, bthink = null) {
  const vm = newVM().login();
  vm.advance(3.1);
  const id = vm.evaluate('NS.Chats.Active().id');
  const chats = think ? `{ { id = "${id}", key = "wow:${id}", agent = "main", label = "", think = "${think}", busy = false, queued = 0 } }` : '{}';
  vm.run(`NS.Transport.HandleSlotData(${slotLua({ nonce: vm.evaluate('NS.R.nonce'), caps, chats, bthink })}, "slot")`);
  return { vm, id };
}
const patches = vm => vm.outboxWires().map(e => parseRecord(e.wire)).filter(r => r.ok && r.record.type === 'patch').map(r => r.record);

test('think (addon): /nqa think high sends a patch for this chat with its agent; the chat keeps it; default clears it', () => {
  const { vm, id } = answered(undefined, 'medium');
  const last = () => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
  vm.slash('think');
  assert.match(last(), /^Thinking in .*: medium \(NeverQuestAlone's default\)\. .*; \/nqa think default goes back to NeverQuestAlone's\.$/);
  vm.slash('think high');
  assert.equal(last(), 'Thinking in this chat: high, from your next message.');
  const p = patches(vm);
  assert.equal(p.length, 1);
  assert.equal(p[0].chat, id);
  assert.deepEqual({ think: p[0].args.think, agent: p[0].args.agent }, { think: 'high', agent: 'main' });
  assert.equal(vm.evaluate('NS.Chats.Active().think'), 'high');
  vm.slash('think default');
  assert.equal(patches(vm).at(-1).args.think, 'default');
  assert.equal(vm.evaluate('NS.Chats.Active().think'), null);
  // fix-102: an app from before each model had its own levels knows low, medium and high; a newer
  // level asks it for the nearest one it knows.
  vm.slash('think max');
  assert.equal(patches(vm).at(-1).args.think, 'high');
  assert.equal(last(), 'Thinking in this chat: high, from your next message.');
  vm.slash('think off');
  assert.equal(patches(vm).at(-1).args.think, 'low');
});

test('think (addon): without the bridge\'s think cap nothing is sent; free text that starts with "think" is a message', () => {
  const { vm } = answered(['state', 'evt']);
  const last = () => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
  vm.slash('think low');
  assert.equal(last(), 'NeverQuestAlone doesn\'t take thinking levels yet. Nothing was changed.', 'the app by its name');
  assert.equal(patches(vm).length, 0);
  assert.equal(vm.evaluate('NS.Chats.Active().think'), null);
  vm.slash('think about the route');
  assert.ok(vm.outboxWires().some(e => e.wire.endsWith('\x1fthink about the route')), 'sent to NeverQuestAlone as typed');
  vm.slash('think harder');
  assert.ok(vm.outboxWires().some(e => e.wire.endsWith('\x1fthink harder')), 'not a level: a message');
});

test('think (bridge): the slot header carries no default level (bridge.think): a chat\'s own is its chats[].think', async () => {
  await withBridge({}, async ({ bridge, env }) => {
    await waitFor(() => readSlot(env).bridge.caps.includes('think'), 2000, 'a slot');
    assert.equal(readSlot(env).bridge.think, undefined);
    bridge.handlePayload(think(CHAT, 'low'));
    await waitFor(() => readSlot(env).chats.find(c => c.id === CHAT)?.think === 'low', 2000, 'the chat\'s own level');
    assert.equal(readSlot(env).bridge.think, undefined);
  });
});

test('think (addon): a chat the bridge doesn\'t know yet shows the bridge\'s default, not "the default"', () => {
  const { vm } = answered(undefined, null, 'medium');
  vm.slash('think');
  assert.match(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), /^Thinking in .*: medium \(NeverQuestAlone's default\)\. .*; \/nqa think default goes back to NeverQuestAlone's\.$/);
  const old = answered(['state', 'evt']);
  old.vm.slash('think');
  assert.match(old.vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'), /^Thinking in .*: the default\. /, 'an old bridge: no level known');
});
