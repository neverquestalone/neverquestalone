// The core's part of setup (bridge/service.mjs; onboarding spec §9.3): the first message heard
// (firstMsgAt), the first reply to one (firstReplyAt, persisted; its first words in memory only),
// and the hello's locale and fr=1. A bridge on the local backend (the BYOK e2e harness): strip
// records in, the providers' mock server on 127.0.0.1 with a canary key, slot files in a temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBridge } from '../../bridge/service.mjs';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { installSlots } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { startMock, reply, manifestsAt, canaryKeystore, NO_CHECKS, waitFor, sleep, tmpDir } from './helpers/byok-env.mjs';

const TOKEN = '3fa9c2d1';
const CHAT = 'c3f9a1e';
let n = 0;
const nonce = 'b4e2';
const rec = (type, args = {}, extra = {}) => encodeRecord({ token: TOKEN, key: type === 'hello' ? nonce : `${nonce}_${++n}`, type, chat: type === 'hello' ? '' : CHAT, args: { cur: 0, ...args }, ...extra });

function env() {
  const tmp = tmpDir('bones-setup-core-');
  const addons = path.join(tmp, 'AddOns');
  fs.mkdirSync(addons, { recursive: true });
  installSlots(addons, { count: 2, iface: '16001' });
  return { tmp, addons, state: path.join(tmp, 'state'), data: path.join(tmp, 'data') };
}
function bridgeOn(e, url, keystore) {
  return createBridge({ transport: { slots: 2 } }, {
    stateDir: e.state, addonsDir: e.addons, log: () => {},
    publisherOpts: { coalesceMs: 5, progressMs: 0 },
    signalsOpts: { pulseMs: { push: 30, alive: 25, act: 5 }, actGapMs: 5 },
    gatewayFactory: handlers => createLocalBackend(handlers, {
      config: { byok: { provider: 'anthropic' } }, dataDir: e.data, keystore, log: () => {}, manifests: manifestsAt(url),
      providerOpts: { timeouts: { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 } }, checks: NO_CHECKS,
    }),
  });
}

test('setup in the core: a hello is no message; the first msg sets firstMsgAt; the reply to it sets firstReplyAt and its first words; the hello’s loc and fr', async () => {
  const mock = await startMock(() => reply('Well met. Turn in The Hunt Begins to Baine first.\n\nTL;DR: Baine first.', { input: 900, output: 40 }));
  const e = env();
  const keystore = await canaryKeystore();
  const bridge = bridgeOn(e, mock.url, keystore);
  try {
    bridge.start();
    await waitFor(() => bridge.status().gateway.state !== 'connecting', 3000, 'the backend');
    bridge.handlePayload(rec('hello', { ver: '1.4.0', build: '70009', iface: '16001', n: 0, sig: 'ok', slots: 200, loc: 'deDE', fr: '1' }));
    await waitFor(() => bridge.status().token?.helloAt, 2000, 'the hello');
    let st = bridge.status();
    assert.equal(st.token.loc, 'deDE');
    assert.equal(st.token.fr, true);
    assert.equal(st.firstReplyBefore, true, 'the addon already had a first reply (fr=1)');
    assert.equal(st.firstMsgAt, null, 'a hello is no message');
    assert.equal(st.firstReplyAt, null, 'and fr=1 never claims a reply this app never saw');
    // A locale of the wrong shape is dropped.
    bridge.handlePayload(encodeRecord({ token: TOKEN, key: 'c0de', type: 'hello', chat: '', args: { cur: 0, ver: '1.4.0', iface: '16001', n: 0, loc: 'de-DE"; x' } }));
    await sleep(40);
    assert.equal(bridge.status().token.loc, undefined);
    // The first message, then the reply to it.
    bridge.handlePayload(rec('msg', { agent: 'main', name: 'Hi', ctx: 0, q: 'followup' }, { text: 'hi' }));
    await waitFor(() => bridge.status().firstMsgAt, 2000, 'firstMsgAt');
    st = await waitFor(() => { const s = bridge.status(); return s.firstReplyAt ? s : null; }, 8000, 'firstReplyAt');
    assert.ok(st.firstReplyAt >= st.firstMsgAt);
    assert.equal(typeof st.firstWords, 'string');
    assert.ok(st.firstWords.length > 0 && st.firstWords.length <= 200);
    const first = st.firstReplyAt;
    await bridge.stop();
    // It persists; the first words don't.
    const again = bridgeOn(e, mock.url, keystore);
    const st2 = again.status();
    assert.equal(st2.firstReplyAt, first, 'saved with the state');
    assert.equal(st2.firstWords, null, 'memory only');
    await again.stop();
  } finally {
    await mock.close?.();
    fs.rmSync(e.tmp, { recursive: true, force: true });
  }
});
