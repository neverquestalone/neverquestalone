// First zone visits and the day's automatic turns (PROTOCOL §2.6). DC9's zone sub-limit and the
// daily cap were the retired build's (the owner, 2026-09-25/26), and went with it: the product has no
// daily, zone or typed limits (the owner, 2026-09-26), only the runaway fuse
// (tests/byok/bridge_byok_e2e_test.mjs, tests/byok/usage_fuse_test.mjs). What stays is shown here:
// every first visit takes its turn, the visit reaches NeverQuestAlone as the state's pending milestone, and the
// day's count of automatic turns survives a restart and starts over at local midnight.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRealBackend } from './helpers/real-backend.mjs';
import { createBridge } from '../bridge/service.mjs';
import { installSlots } from '../bridge/transport/slots.mjs';
import { encodeRecord } from '../bridge/transport/records.mjs';
import { newLuaVM } from './helpers/luavm.mjs';

const TOKEN = '3fa9c2d1';
const CHAT = 'c3f9a1e';
const SID = 'a1b2c3d4e5f60718';
const nonce = 'd2c4';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 5000, label = 'condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(20); }
  throw new Error(`timed out waiting for ${label}`);
}

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-zonecap-'));
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 3, iface: '16001' });
  return { tmp, addons, state: path.join(tmp, 'state') };
}
// On the product's backend, its turns answered by the providers' mock server (tests/helpers/real-backend.mjs).
function makeBridge(env, be, { companion, now }) {
  const log = () => {};
  return createBridge({ transport: { slots: 3 }, companion }, {
    stateDir: env.state, addonsDir: env.addons, log, ...(now ? { now } : {}),
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
  return { ...d, records: list(d.records), bridge: { ...d.bridge, acked: list(d.bridge?.acked) } };
}
const sends = be => be.sends();
const turns = be => sends(be).filter(s => s.chatId === 'c0ffee0').length;

let n = 0;
const key = () => `${nonce}_${++n}`;
const hello = () => encodeRecord({ token: TOKEN, key: nonce, type: 'hello', chat: '', args: { cur: 0, ver: '1.2.0', ctx: 0, sid: SID }, body: '' });
const evt = (kind, args, k = key()) => encodeRecord({ token: TOKEN, key: k, type: 'evt', chat: 'c0ffee0', args: { cur: 0, kind, agent: 'main', name: 'Companion', sid: SID, ...args }, body: '' });
const zone = z => evt('zone_first', { zone: z });

async function withBridge({ companion, now }, fn, env = setup()) {
  const be = await startRealBackend();
  const bridge = makeBridge(env, be, { companion, now });
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state === 'ready', 5000, 'backend ready');
    bridge.handlePayload(hello());
    await fn({ bridge, be, env });
  } finally {
    await bridge.stop();
    await be.close();
  }
}

test('zone visits: every first visit takes its turn, with no zone or daily limit and no error line; its milestone still reaches NeverQuestAlone with the next typed turn; a level-up gets its turn', async () => {
  await withBridge({ companion: { enabled: true } }, async ({ bridge, be, env }) => {
    for (const z of ['Mulgore', 'Thunder Bluff', 'The Barrens', 'Stonetalon Mountains']) bridge.handlePayload(zone(z));
    await waitFor(() => turns(be) === 4, 3000, 'four zone turns');
    assert.equal(bridge.status().companion.today, 4);
    assert.ok(!readSlot(env).records.some(r => r.t === 'error'), 'no error line');

    // The visit reaches NeverQuestAlone as the pending milestone of the next typed turn, with nothing riding along.
    const st = { v: 1, sid: SID, seq: 5, t: 1, char: { name: 'Tavi', realm: 'Testrealm', level: 12 }, quests: [], pending: [{ kind: 'zone', zone: 'Stonetalon Mountains', t: 1 }], omitted: [] };
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: nonce, type: 'state', chat: '', args: { cur: 0, sid: SID, seq: 5 }, body: JSON.stringify(st) }));
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: key(), type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Route', ctx: 0, q: 'followup', st: 5 }, text: 'where next?' }));
    const typed = await waitFor(() => sends(be).find(s => s.chatId === CHAT), 3000, 'the typed turn');
    assert.deepEqual(typed.turn.state.pending, [{ kind: 'zone', zone: 'Stonetalon Mountains', t: 1 }], 'the state the backend builds from');
    assert.equal(typed.turn.notes, undefined, 'nothing held rides along');

    bridge.handlePayload(evt('level_up', { from: 11, to: 12 }));
    await waitFor(() => turns(be) === 5, 3000, 'the level-up turn');
    assert.equal(bridge.status().companion.today, 5);
  });
});

test('zone visits: the day\'s count survives a bridge restart and starts over at local midnight', async () => {
  let clock = new Date(2026, 8, 25, 23, 58, 0).getTime();
  const env = setup();
  const opts = { companion: { enabled: true }, now: () => clock };
  // Run 1: one zone turn today. (Each run gets a fresh backend, so its turn count starts at 0.)
  await withBridge(opts, async ({ bridge, be }) => {
    bridge.handlePayload(zone('Mulgore'));
    await waitFor(() => turns(be) === 1, 3000, 'the day\'s zone turn');
    // Its answer is in (the outbox is empty): stopping before that would leave the
    // turn in the outbox, and run 2's fresh backend would get it again.
    await waitFor(() => bridge.status().outbox === 0, 3000, 'the send is through');
  }, env);
  // Run 2 (a restart): the count goes on from companion-events.json, then midnight starts it over.
  await withBridge(opts, async ({ bridge, be }) => {
    bridge.handlePayload(zone('Thunder Bluff'));
    await waitFor(() => turns(be) === 1, 3000, 'another zone turn today');
    assert.equal(bridge.status().companion.today, 2, 'the count came back from companion-events.json');
    clock += 3 * 60 * 1000; // past local midnight
    bridge.handlePayload(zone('The Barrens'));
    await waitFor(() => turns(be) === 2, 3000, 'a new day\'s zone turn');
    assert.equal(bridge.status().companion.today, 1, 'the count started over');
  }, env);
});

test('zone visits: an old config\'s zone and daily limits (maxZoneTurnsPerDay, maxTurnsPerDay) don\'t apply', async () => {
  await withBridge({ companion: { enabled: true, maxTurnsPerDay: 2, maxZoneTurnsPerDay: 1 } }, async ({ bridge, be, env }) => {
    for (const z of ['Mulgore', 'Thunder Bluff', 'The Barrens', 'Durotar', 'Orgrimmar']) bridge.handlePayload(zone(z));
    await waitFor(() => turns(be) === 5, 3000, 'five zone turns');
    await sleep(100);
    assert.ok(!readSlot(env).records.some(r => r.t === 'error'), 'no cap line');
    assert.equal(readSlot(env).bridge.turnsLeft, undefined, 'no count of turns left in the slot');
  });
});

test('zone visits: a config that names no companion settings takes every visit too', async () => {
  await withBridge({ companion: undefined }, async ({ bridge, be }) => {
    for (const z of ['Mulgore', 'Thunder Bluff', 'The Barrens', 'Durotar']) bridge.handlePayload(zone(z));
    await waitFor(() => turns(be) === 4, 3000, 'four zone turns');
    assert.equal(bridge.status().companion.today, 4);
  });
});
