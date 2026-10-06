// The local backend when the network or the provider fails part way (bridge/byok/backend.mjs; public
// BYOK PRD §7.5, §9.2, §9.4, §10 "Network down", DB20, RT-8): a turn held while nothing could leave
// and sent when the network is back, a stop or the 10 minutes ending it; the resume hook when the
// backend is usable again; and what a turn counts when the provider fails after it began generating
// (max(metered, estimate)). Against the providers' mock on 127.0.0.1 with canary keys; a fetch
// wrapper plays the network going down (a refused connection: nothing left the machine).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  startMock, reply, makeBackend, canaryKeystore, sendParams, waitFor, sleep, tmpDir, flatPrices, anthropicHead, CANARY_KEYS,
} from './helpers/byok-env.mjs';
import { fixture } from './helpers/mock-provider.mjs';
import { spendOf, failedMidReply } from '../../bridge/byok/backend.mjs';

const CHAT = 'c3f9a1e';
const CHAT2 = 'c4b2d0f';
const posts = mock => mock.requests.filter(r => r.method === 'POST');
const heads = mock => mock.requests.filter(r => r.method === 'HEAD');
const HELD = "Can't reach Anthropic. Check your internet. Your message will send when it's back.";

// A network that can go down: while `down`, every request fails to connect (ECONNREFUSED, before
// anything left); `downFor(r)` narrows it to some requests.
function flakyNet() {
  const net = { down: false, downFor: null, refused: 0 };
  net.fetch = async (url, init) => {
    if (net.down && (!net.downFor || net.downFor(url, init))) {
      net.refused += 1;
      const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      throw Object.assign(new TypeError('fetch failed'), { cause });
    }
    return fetch(url, init);
  };
  return net;
}
const items = env => env.events.filter(e => e.event === 'agent' && e.payload.stream === 'item').map(e => e.payload.data);

async function started(opts) {
  const env = makeBackend(opts);
  await env.backend.start();
  return env;
}

// ------------------------------------------------------------------------------ held turns (§10)

test('network down before anything left: the turn is held with the §10 line, the host probed, and sent once when it\'s back (a fresh run limit)', async () => {
  const mock = await startMock(() => reply('Back.\n\nTL;DR: back.', { input: 1000, output: 20 }));
  const net = flakyNet();
  net.down = true;
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), fetch: net.fetch, priceBook: flatPrices(),
    holdProbeMs: { first: 30, max: 60 }, runMs: 400, log: (k, d) => lines.push([k, d]) });
  try {
    const p = sendParams(CHAT, 'n_1', 'still there?');
    await env.backend.send(p);
    await waitFor(() => items(env).some(d => d.name === 'held'), 3000, 'the held line');
    assert.equal(items(env).find(d => d.name === 'held').title, HELD);
    assert.equal(env.backend.ledger.get(p.idem).state, 'queued', 'stepped back: it provably never left');
    assert.equal(env.backend.ledger.get(p.idem).extra.reason, 'held');
    assert.deepEqual(env.backend.status().held.map(h => h.chatId), [CHAT]);
    await sleep(600); // past the 400 ms run limit: a held turn isn't timed out by it
    assert.ok(net.refused >= 3, 'probed while down');
    assert.equal(env.chats().length, 0, 'no error while held');
    net.down = false;
    const fin = await waitFor(() => env.chats('final')[0], 3000, 'sent when back');
    assert.equal(fin.message.content[0].text, 'Back.\n\nTL;DR: back.');
    assert.equal(posts(mock).length, 1, 'one request reached the provider');
    assert.ok(heads(mock).length >= 1, 'the probe that found it back');
    assert.equal(heads(mock)[0].headers['x-api-key'], undefined, 'the probe carries no key');
    assert.equal(env.backend.ledger.get(p.idem).state, 'done');
    assert.deepEqual(env.backend.status().held, []);
    const d = env.backend.caps.details();
    assert.equal(d.spentMicros, 1000 * 0.1 + 20 * 0.5, 'counted once, at what it cost');
    assert.equal(d.typed, 1);
    assert.ok(lines.some(([k]) => k === 'byok-held') && lines.some(([k]) => k === 'byok-resend'));
    assert.equal(lines.filter(([k]) => k === 'byok-retry').length, 0, 'not a retry');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('a held turn goes at once when another request gets an answer (no wait for its probe); one held turn per chat, the next waits behind it', async () => {
  const mock = await startMock(r => reply(`Re: ${String(r.body?.messages?.at(-1)?.content).slice(-5)}\n\nTL;DR: ok.`));
  const net = flakyNet();
  net.down = true;
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), fetch: net.fetch, holdProbeMs: { first: 60_000, max: 60_000 } });
  try {
    await env.backend.send(sendParams(CHAT, 'w_1', 'first'));
    await waitFor(() => env.backend.status().held.length === 1, 3000, 'held');
    await env.backend.send(sendParams(CHAT, 'w_2', 'second'));
    await sleep(50);
    assert.equal(env.backend.status().held.length, 1, 'the chat\'s next message waits behind its held turn');
    net.down = false;
    await env.backend.send(sendParams(CHAT2, 'w_3', 'other'));
    await waitFor(() => env.chats('final').length === 3, 3000, 'all three answered');
    assert.deepEqual(env.chats('final').map(c => c.runId), ['nqa:3fa9c2d1:w_3', 'nqa:3fa9c2d1:w_1', 'nqa:3fa9c2d1:w_2']);
    assert.equal(heads(mock).length, 0, 'woken by the other chat\'s answer, not its probe');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('a held turn: /nqa stop and a forget end it (aborted, nothing counted); past 10 minutes from the message, the Retry line', async () => {
  const mock = await startMock(() => reply('never'));
  const net = flakyNet();
  net.down = true;
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), fetch: net.fetch, priceBook: flatPrices(), holdProbeMs: { first: 20, max: 20 } });
  try {
    const p = sendParams(CHAT, 's_1', 'hi');
    await env.backend.send(p);
    await waitFor(() => env.backend.status().held.length === 1, 3000, 'held');
    assert.equal(env.backend.abort(p.chatId).aborted, true);
    await waitFor(() => env.chats('aborted').length === 1, 3000, 'stopped');
    assert.equal(env.backend.ledger.get(p.idem).state, 'failed');
    const q = sendParams(CHAT2, 's_2', 'hi');
    await env.backend.send(q);
    await waitFor(() => env.backend.status().held.length === 1, 3000, 'held again');
    env.backend.forget(q.chatId);
    await waitFor(() => env.chats('aborted').length === 2, 3000, 'forgotten');
    const d = env.backend.caps.details();
    assert.deepEqual([d.spentMicros, d.typed, d.auto], [0, 0, 0], 'nothing left the machine: nothing counted');
    assert.equal(posts(mock).length, 0);
    assert.deepEqual(env.backend.usageHistory({ days: 1 }).recent, []);
  } finally { await env.backend.stop(); }

  // The 10 minutes: a clock that moves fast, and a hold that ends with the Retry line.
  let t = Date.now();
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), fetch: net.fetch, now: () => t, holdProbeMs: { first: 5, max: 5 },
    sleep: async (ms, signal) => { t += 61_000; await new Promise(r => setTimeout(r, 2)); return !signal?.aborted; } });
  try {
    await b.backend.send(sendParams(CHAT, 's_3', 'hi'));
    const e = await waitFor(() => b.chats('error')[0], 5000, 'the Retry line');
    assert.equal(e.errorKind, 'network_before_send');
    assert.equal(e.action, 'retry');
    assert.equal(e.errorMessage, "Can't reach Anthropic. Check your internet. Nothing was sent. Click Retry when you're back online.");
    assert.equal(posts(mock).length, 0);
    assert.equal(b.backend.caps.details().spentMicros, 0);
  } finally { await b.backend.stop(); await mock.close(); }
});

test('a held turn waits while paused (no probe), and after a restart while it is held, outcomes() says interrupted (never sent, never resent, nothing counted)', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const net = flakyNet();
  net.down = true;
  const dataDir = tmpDir();
  const a = await started({ url: mock.url, keystore: await canaryKeystore(), fetch: net.fetch, dataDir, holdProbeMs: { first: 20, max: 20 } });
  const p = sendParams(CHAT, 'p_1', 'hi');
  await a.backend.send(p);
  await waitFor(() => a.backend.status().held.length === 1, 3000, 'held');
  a.backend.pause(true);
  net.down = false;
  await sleep(150);
  assert.equal(heads(mock).length + posts(mock).length, 0, 'paused: no probe, no send');
  await a.backend.stop();
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), fetch: net.fetch, dataDir });
  try {
    const [o] = b.backend.outcomes([p.idem]);
    assert.deepEqual([o.state, o.errorKind, o.action], ['interrupted', 'interrupted', 'send_again'], 'the core hears it through outcomes() (code health BR-22)');
    assert.equal(b.chats().length, 0, 'nothing said at the start itself');
    assert.equal(b.backend.ledger.get(p.idem).state, 'failed');
    await sleep(100);
    assert.equal(posts(mock).length, 0, 'never resent');
    assert.equal(b.backend.caps.details().spentMicros, 0);
  } finally { await b.backend.stop(); await mock.close(); }
});

// ------------------------------------------------------------------------------ the resume hook

test('onResume: the state coming back to ready after start (a key added, unpaused) calls it; start and other states don\'t', async () => {
  const keystore = await canaryKeystore([]);
  const env = await started({ keystore });
  try {
    assert.equal(env.resumes.length, 0, 'the first ready comes with onReady');
    assert.equal(env.states.at(-1).state, 'no_key');
    await keystore.set('anthropic', CANARY_KEYS.anthropic);
    await env.backend.refresh({ keyChanged: true });
    assert.equal(env.states.at(-1).state, 'ready');
    assert.equal(env.resumes.length, 1, 'key added');
    env.backend.pause(true);
    assert.equal(env.resumes.length, 1, 'pausing is no resume');
    env.backend.pause(false);
    assert.equal(env.resumes.length, 2, 'unpaused');
    env.backend.pause(false);
    assert.equal(env.resumes.length, 2, 'ready already: nothing');
  } finally { await env.backend.stop(); }
  const ready = await started({ keystore: await canaryKeystore() });
  try { assert.deepEqual([ready.states.map(s => s.state), ready.resumes.length], [['ready'], 0]); } finally { await ready.backend.stop(); }
});

// ------------------------------------------------------------- failures after generation began

test('failedMidReply and spendOf: a failure after generation began counts at least its estimate; one with a full count or nothing generated counts what it reported', () => {
  const err = { kind: 'overloaded' };
  assert.equal(failedMidReply({ error: err, started: true, usage: { input: 10, partial: true }, text: '' }), true);
  assert.equal(failedMidReply({ error: err, started: true, usage: null, text: 'Hel' }), true, 'text streamed with no count');
  assert.equal(failedMidReply({ error: err, started: true, usage: { input: 10 }, text: 'Hel' }), false, 'a full count (a context-window stop)');
  assert.equal(failedMidReply({ error: err, started: true, usage: null, text: '' }), false, 'an error inside a 200, nothing generated');
  assert.equal(failedMidReply({ error: err, started: false, usage: null, text: '' }), false, 'an HTTP error');
  assert.equal(failedMidReply({ error: null, started: true, usage: { partial: true }, text: 'x' }), false);
  const base = { micros: 0, in: 0, out: 0, exact: true, metered: true, answered: false, unknown: true, inFlight: false };
  assert.deepEqual(spendOf({ ...base, micros: 130 }, 900), { micros: 900, exact: false });
});

test('Anthropic overloaded mid-stream on every try: the turn counts max(metered, estimate), never $0; the usage history says so', async () => {
  const mock = await startMock(() => fixture('anthropic', 'error-overloaded-midstream.sse'));
  // Output dear next to input: the estimate (the full 1,200 output tokens) is above what the tries metered.
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices({ input: 0.1, output: 5 }), sleep: async (ms, s) => !s?.aborted });
  try {
    const p = sendParams(CHAT, 'o_1', 'hi');
    await env.backend.send(p);
    const e = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(e.errorKind, 'overloaded');
    assert.equal(posts(mock).length, 3, 'tried and retried twice');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    const metered = 3 * ((1200 + 4100) * 0.1 + 1 * 5);
    assert.ok(est > metered, `${est} > ${metered}`);
    const d = env.backend.caps.details();
    assert.equal(d.spentMicros, est, 'max(metered, estimate)');
    assert.equal(d.exact, false);
    assert.equal(d.typed, 1);
    const [row] = env.backend.usageHistory({ days: 1 }).recent;
    assert.deepEqual([row.error, row.micros, row.exact, row.in], ['overloaded', est, false, 3 * (1200 + 4100)]);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('a mid-stream failure then a success: the turn counts at least its estimate (the failed try may have been billed); a plain success counts what it cost', async () => {
  let n = 0;
  const mock = await startMock(() => (++n === 1 ? fixture('anthropic', 'error-overloaded-midstream.sse') : reply('ok.\n\nTL;DR: ok.', { input: 1000, output: 20 })));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), sleep: async (ms, s) => !s?.aborted });
  try {
    const p = sendParams(CHAT, 'o_2', 'hi');
    await env.backend.send(p);
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the reply');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    const metered = (1200 + 4100) * 0.1 + 0.5 + 1000 * 0.1 + 20 * 0.5;
    assert.equal(fin.usage.micros, Math.max(Math.ceil(metered), est));
    assert.equal(fin.usage.exact, false);
    assert.equal(fin.usage.in, 1200 + 4100 + 1000, 'both tries\' input');
    assert.equal(env.backend.caps.details().spentMicros, fin.usage.micros);
    n = 10;
    await env.backend.send(sendParams(CHAT, 'o_3', 'again'));
    const f2 = await waitFor(() => env.chats('final')[1], 5000, 'the second reply');
    assert.equal(f2.usage.micros, Math.ceil(1000 * 0.1 + 20 * 0.5), 'a clean success: its cost');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('a context-window stop reports its full count: the turn counts what it reported, not the estimate', async () => {
  const mock = await startMock(() => fixture('anthropic', 'context-window-exceeded.sse'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices({ input: 0.1, output: 5 }) });
  try {
    // No history to trim: one try, which ends in context_too_long after message_stop with its full count.
    const p = sendParams(CHAT, 'x_1', 'hi');
    await env.backend.send(p);
    const e = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(e.errorKind, 'context_too_long');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    const spent = env.backend.caps.details().spentMicros;
    assert.ok(spent < est, `metered (${spent}) under the estimate (${est})`);
    assert.ok(spent > 0);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('a connection cut after message_start still counts its estimate (network_after_send), and the partial input is metered', async () => {
  const mock = await startMock(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicHead({ input: 1200 }), destroyAfterBody: true }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    const p = sendParams(CHAT, 'x_2', 'hi');
    await env.backend.send(p);
    const e = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(e.errorKind, 'network_after_send');
    const est = env.backend.ledger.get(p.idem).extra.estMicros;
    assert.equal(env.backend.caps.details().spentMicros, est);
    assert.equal(env.backend.usageHistory({ days: 1 }).recent[0].in, 1200, 'what was metered is kept beside the cost');
  } finally { await env.backend.stop(); await mock.close(); }
});
