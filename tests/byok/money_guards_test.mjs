// The money guards and the local failures around a turn (systems plan D4, SY-05, SY-12, D7): the
// check-ins fuse's hour through the bridge, a turn held back while a rate limit is still in force
// (sent after a short one, not at all after a daily one), a write on this computer that fails
// (its own line, never the AI's), and Pick Another AI beside the busy and out-of-credit lines.
// Against the providers' mock server on 127.0.0.1 with canary keys; no real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBridge } from '../../bridge/service.mjs';
import { installSlots } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { fixture } from './helpers/mock-provider.mjs';
import { startMock, reply, errorReply, makeBackend, manifestsAt, canaryKeystore, sendParams, waitFor, tmpDir, NO_CHECKS } from './helpers/byok-env.mjs';

const TOKEN = '3fa9c2d1';
const NONCE = 'a3f1';
const CHAT = 'c3f9a1e';
const COMP = 'c0ffee0';
const SID = 'a1b2c3d4e5f60718';
const posts = mock => mock.requests.filter(r => r.method === 'POST');
const quick = async (ms, signal) => !signal?.aborted; // waits without the wait

function core({ url, keystore, byok = {}, deps = {}, providers = ['anthropic'] }) {
  const tmp = tmpDir('nqa-guards-');
  const addons = path.join(tmp, 'AddOns');
  installSlots(addons, { count: 2, iface: '16001' });
  const logs = [];
  const log = (k, f) => logs.push({ k, ...f });
  const env = { tmp, addons, logs };
  env.bridge = createBridge({ transport: { slots: 2 } }, {
    stateDir: path.join(tmp, 'state'), addonsDir: addons, log, publisherOpts: { coalesceMs: 5, progressMs: 0 },
    signalsOpts: { pulseMs: { push: 20, alive: 20, act: 5 }, actGapMs: 5 },
    gatewayFactory: h => (env.backend = createLocalBackend(h, { config: { byok: { provider: providers[0], ...byok } }, dataDir: path.join(tmp, 'data'), keystore, log,
      manifests: manifestsAt(url, providers), providerOpts: { timeouts: { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 } }, checks: NO_CHECKS, sleep: quick })),
    ...deps,
  });
  return env;
}
const records = (bridge, t) => bridge.buildSlot().records.filter(r => !t || r.t === t);

test('check-ins, the hour (D4): a loop slower than the minute (one every 7 s by the game\'s clock) takes 60 turns; the 61st pauses them, with the one line, and status says which window', async () => {
  const mock = await startMock(() => reply('Noted.\n\nTL;DR: noted.'));
  // The core's clock is the test's (as the runaway-fuse e2e tests' is): the fuse's windows and the
  // events' send times never move with the machine's clock or its load, and the first event is an
  // hour and a minute before it, never at the hour's edge.
  const clock = { t: Date.UTC(2026, 8, 27, 12, 0, 0) };
  const env = core({ url: mock.url, keystore: await canaryKeystore(), deps: { now: () => clock.t } });
  const b = env.bridge;
  try {
    b.start();
    await waitFor(() => b.status().gateway.state === 'ready', 3000, 'ready');
    b.handlePayload(encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200, sid: SID } }));
    const at0 = Math.floor(clock.t / 1000) - 3660;
    let n = 0;
    const evt = i => encodeRecord({ token: TOKEN, key: `${NONCE}_${++n}`, type: 'evt', chat: COMP, args: { cur: 0, kind: 'route_done', agent: 'main', name: 'Companion', sid: SID, layer: `r${i}`, at: at0 + i * 7 }, body: '' });
    for (let i = 0; i < 61; i++) b.handlePayload(evt(i));
    await waitFor(() => records(b, 'reply').length === 60, 20000, 'the 60 that went');
    assert.equal(posts(mock).length, 60, 'the 61st took no turn');
    const paused = records(b, 'error').filter(r => r.kind === 'auto_paused');
    assert.equal(paused.length, 1);
    assert.equal(paused[0].text, 'NeverQuestAlone paused check-ins: your next message turns them back on.', 'the in-game line is one line whatever window tripped (PUI-01)');
    assert.deepEqual(b.status().companion.autoPausedBy, { turns: 60, windowMs: 3_600_000 });
    assert.equal(b.buildSlot().bridge.usage.autoPaused, true);
  } finally { await b.stop(); await mock.close(); }
});

// A provider's daily limit (rate_limited_daily). No bundled manifest maps one now (code health BR-23
// took OpenRouter's free daily cap with its test-only manifest), so these map a code to it: the
// backend's rule for the kind is the same whichever manifest names it.
const DAILY_CODE = 'daily_limit_reached';
const withDaily = (manifests, id) => manifests.map(m => (m.id === id ? { ...m, errorMap: { ...m.errorMap, codes: { ...m.errorMap.codes, [DAILY_CODE]: 'rate_limited_daily' } } } : m));
const dailyReply = id => errorReply(429, id === 'anthropic' ? { type: 'error', error: { type: 'rate_limit_error', code: DAILY_CODE, message: 'Daily limit reached.' } }
  : { error: { code: DAILY_CODE, type: 'requests', message: 'Daily limit reached.' } });

test('slowed (SY-05): after a daily limit, the next turn isn\'t sent: the same line, nothing counted, no request', async () => {
  const mock = await startMock(() => dailyReply('anthropic'));
  const env = makeBackend({ url: mock.url, keystore: await canaryKeystore(), manifests: withDaily(manifestsAt(mock.url), 'anthropic'), sleep: quick });
  try {
    await env.backend.start();
    await env.backend.send(sendParams(CHAT, 'k1', 'first'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'the daily limit');
    const first = env.chats('error')[0];
    assert.equal(first.errorKind, 'rate_limited_daily');
    assert.match(first.errorMessage, /^Anthropic's daily limit is used up\. It resets at \d{1,2}:\d{2} (AM|PM)\.$/);
    const sent = posts(mock).length;
    const counted = env.backend.caps.details().turns; // the refused request itself answered
    await env.backend.send(sendParams(CHAT, 'k2', 'second'));
    await waitFor(() => env.chats('error').length === 2, 5000, 'the second answered');
    const second = env.chats('error')[1];
    assert.equal(second.errorKind, 'rate_limited_daily');
    assert.equal(second.errorMessage, first.errorMessage, 'the line that limit got');
    assert.equal(posts(mock).length, sent, 'nothing sent');
    assert.equal(env.backend.caps.details().turns, counted, 'nothing more counted');
    assert.equal(env.backend.status().rt.state, 'slowed');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('slowed (SY-17): after a daily limit, Pick Another AI reaches the new AI at once; the old limit isn\'t inherited', async () => {
  const mock = await startMock(rec => (rec.url.includes('/responses') ? dailyReply('openai') : reply('Here.\n\nTL;DR: here.')));
  const env = makeBackend({ url: mock.url, keystore: await canaryKeystore(['openai', 'anthropic']), manifests: withDaily(manifestsAt(mock.url, ['openai', 'anthropic']), 'openai'), config: { provider: 'openai' }, sleep: quick });
  try {
    await env.backend.start();
    await env.backend.send(sendParams(CHAT, 'k1', 'first'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'the daily limit');
    assert.equal(env.chats('error')[0].errorKind, 'rate_limited_daily');
    assert.equal(env.backend.status().rt.state, 'slowed');
    await env.backend.setConfig({ provider: 'anthropic' });
    assert.notEqual(env.backend.status().rt.state, 'slowed', 'the new AI isn\'t slowed by the old one\'s limit');
    const before = posts(mock).length;
    await env.backend.send(sendParams(CHAT, 'k2', 'second'));
    await waitFor(() => env.chats('final').length === 1 || env.chats('error').length === 2, 5000, 'the second answered');
    assert.equal(env.chats('error').length, 1, 'not refused with the old limit\'s line');
    assert.equal(env.chats('final').length, 1, 'Anthropic replied');
    assert.deepEqual(posts(mock).slice(before).map(r => r.url), ['/v1/messages'], 'one request, to the new AI');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('slowed (SY-05): a short rate limit is waited out, then the turn goes', async () => {
  let limited = true;
  const mock = await startMock(() => (limited ? fixture('anthropic', 'http-429-rate-limit.json') : reply('Here.\n\nTL;DR: here.')));
  const logs = [];
  const env = makeBackend({ url: mock.url, keystore: await canaryKeystore(), sleep: quick, log: (k, f) => logs.push({ k, ...f }) });
  try {
    await env.backend.start();
    await env.backend.send(sendParams(CHAT, 'k1', 'first'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'the rate limit, after its retries');
    assert.equal(env.chats('error')[0].errorKind, 'rate_limited');
    limited = false;
    const before = posts(mock).length;
    await env.backend.send(sendParams(CHAT, 'k2', 'second'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'the reply');
    assert.equal(posts(mock).length, before + 1);
    assert.ok(logs.some(l => l.k === 'byok-slowed' && l.sent === true), 'it waited for the reset first');
    assert.ok(env.events.some(e => e.event === 'agent' && e.payload.data?.name === 'retry' && /^Anthropic asked NeverQuestAlone to slow down\. Trying again in \d+ seconds?\.$/.test(e.payload.data.title)), 'and the chat said so, in the retry\'s words (PUI-01)');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('local_write (SY-12): a disk that\'s full or read-only is said as such, never "Something went wrong with Anthropic"; nothing is sent', async () => {
  const mock = await startMock(() => reply('Here.\n\nTL;DR: here.'));
  const env = makeBackend({ url: mock.url, keystore: await canaryKeystore() });
  const write = fs.writeFileSync;
  try {
    await env.backend.start();
    let code = 'ENOSPC';
    fs.writeFileSync = function (f, ...a) { if (String(f).includes('ledger.json')) throw Object.assign(new Error('no space'), { code }); return write.call(this, f, ...a); };
    await env.backend.send(sendParams(CHAT, 'k1', 'first'));
    await waitFor(() => env.chats('error').length === 1, 5000, 'the line');
    let e = env.chats('error')[0];
    assert.deepEqual([e.errorKind, e.action, e.errorMessage], ['local_write', 'retry', 'Your disk is full, so nothing was sent. Free up space, then click Retry.']);
    code = 'EROFS';
    await env.backend.send(sendParams(CHAT, 'k2', 'second'));
    await waitFor(() => env.chats('error').length === 2, 5000, 'the line');
    e = env.chats('error')[1];
    assert.deepEqual([e.errorKind, e.errorMessage], ['local_write', "NeverQuestAlone couldn't save on this computer, so nothing was sent. Click Retry. Restart your computer if it keeps happening."]);
    assert.equal(posts(mock).length, 0);
  } finally { fs.writeFileSync = write; await env.backend.stop(); await mock.close(); }
});

test('D7: out of credit carries Pick Another AI (alt) beside its fix, to the core\'s error record; other lines carry none', async () => {
  let credit = false;
  const mock = await startMock(() => (credit ? reply('Fine.\n\nTL;DR: fine.') : fixture('anthropic', 'http-402-billing.json')));
  const env = core({ url: mock.url, keystore: await canaryKeystore() });
  const b = env.bridge;
  try {
    b.start();
    await waitFor(() => b.status().gateway.state === 'ready', 3000, 'ready');
    b.handlePayload(encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '1.4.0', sig: 'ok', slots: 200 } }));
    b.handlePayload(encodeRecord({ token: TOKEN, key: `${NONCE}_1`, type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Q' }, text: 'hello?' }));
    const r = await waitFor(() => records(b, 'error')[0], 5000, 'the out-of-credit line');
    assert.deepEqual([r.kind, r.action, r.alt], ['out_of_credit', 'desktop', 'pick_provider']);
    // The slot's rt says it too, with its words (Batch 3b).
    const rt = b.buildSlot().rt;
    assert.deepEqual([rt.state, rt.line, rt.tone, rt.action, rt.alt], ['out_of_credit', 'Out of credit', 'bad', 'desktop', 'pick_provider']);
  } finally { await b.stop(); await mock.close(); }
});

test('SY-14: the core keeps 500 published ids (its replies carry their seq), whatever backend object it\'s given', async () => {
  const mock = await startMock(() => reply('Fine.\n\nTL;DR: fine.'));
  const env = core({ url: mock.url, keystore: await canaryKeystore() });
  const b = env.bridge;
  try {
    b.start();
    await waitFor(() => b.status().gateway.state === 'ready', 3000, 'ready');
    for (let i = 0; i < 700; i++) b.store.markPublished(`byok:c3f9a1e:${i}`, i);
    assert.equal(Object.keys(b.store.state.published).length, 500);
  } finally { await b.stop(); await mock.close(); }
  // A stand-in that names no kind: 500 too.
  const tmp = tmpDir('nqa-guards-any-');
  const addons = path.join(tmp, 'AddOns');
  installSlots(addons, { count: 2, iface: '16001' });
  const any = createBridge({ transport: { slots: 2 } }, { stateDir: path.join(tmp, 'state'), addonsDir: addons, log: () => {},
    gatewayFactory: () => ({ start() {}, stop() {} }) });
  try {
    any.start();
    for (let i = 0; i < 700; i++) any.store.markPublished(`x:${i}`, i);
    assert.equal(Object.keys(any.store.state.published).length, 500);
  } finally { await any.stop(); }
});
