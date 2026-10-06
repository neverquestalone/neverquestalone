// The local backend's money and run rules (bridge/byok/backend.mjs; public BYOK PRD §6.3, §7.5,
// §9.1–§9.4, US-3, PV-7; systems plan D6), from the C1 review: what a turn counts when
// something throws after its request went out, a stop or a forget during the request, a stop with a
// call out (booked at the next start) or one that never went, no second paid call for a broken map
// block, rt's cap state (only at a cap the player set: the public build has no limits of its own),
// one run limit across retries, rate-limit headers, and a ledger that can't be written.
// Against the providers' mock server on 127.0.0.1 with canary keys. No real network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {
  startMock, reply, errorReply, anthropicHead, makeBackend, canaryKeystore, sendParams, waitFor, sleep, tmpDir, flatPrices,
} from './helpers/byok-env.mjs';
import { fixture } from './helpers/mock-provider.mjs';
import { spendOf } from '../../bridge/byok/backend.mjs';

const CHAT = 'c3f9a1e';
const CHAT2 = 'c4b2d0f';
const chatCalls = mock => mock.requests.filter(r => r.method === 'POST' && r.url.endsWith('/messages'));
const hang = () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, hangBeforeHeaders: true });
const isRepair = r => String(r.body?.messages?.at(-1)?.content || '').startsWith('The app could not draw');
// A route whose stops have no map id: the validator drops the layer (the core says it couldn't draw it).
const BROKEN = 'Route.\n\n```wowmap\n{"op":"set","layer":"mulgore","title":"Route","ordered":true,"points":[{"x":49.5,"y":67.5,"label":"Wolves"}]}\n```\n\nTL;DR: route.';
// Game data the model echoed into its block: JSON that shadows toString.
const HOSTILE = 'Here.\n\n```wowmap\n{"op":"set","layer":"a","title":{"toString":1},"points":[{"m":1412,"x":1,"y":1,"label":"ok"}]}\n```\n\nTL;DR: here.';

async function started(opts) {
  const env = makeBackend(opts);
  await env.backend.start();
  return env;
}
// The slot's rt as today's addon reads it (state, reason); its words (line, tone, action) are the one addon's.
const rtOf = x => ({ state: x.rt.state, ...(x.rt.reason ? { reason: x.rt.reason } : {}) });
const estOf = (env, key) => env.backend.ledger.get(key).extra?.estMicros ?? env.backend.ledger.get(key).meta?.estMicros;

test('money: spendOf: an unknown outcome or a request still out counts at least its estimate; nothing that left counts nothing', () => {
  const base = { micros: 0, in: 0, out: 0, exact: true, metered: false, answered: false, unknown: false, inFlight: false };
  assert.equal(spendOf(base, 900), null, 'nothing left the machine: released');
  assert.deepEqual(spendOf({ ...base, inFlight: true }, 900), { micros: 900, exact: false }, 'out, outcome unread');
  assert.deepEqual(spendOf({ ...base, unknown: true, metered: true, micros: 120 }, 900), { micros: 900, exact: false }, 'input metered, output may be billed');
  assert.deepEqual(spendOf({ ...base, unknown: true, metered: true, micros: 1500 }, 900), { micros: 1500, exact: false });
  assert.deepEqual(spendOf({ ...base, answered: true, metered: true, micros: 140 }, 900), { micros: 140, exact: true });
  assert.deepEqual(spendOf({ ...base, answered: true }, 900), { micros: 0, exact: true }, 'answered and unbilled (a 429): a turn at $0');
});

test('money: a reply whose map block shadows toString is published as the model wrote it: one call, counted once (no repair pass: systems plan D6)', async () => {
  const mock = await startMock(() => reply(HOSTILE, { input: 5000, output: 400 }));
  const lines = [];
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), log: (k, d) => lines.push([k, d]) });
  try {
    await env.backend.send(sendParams(CHAT, 'm_1', 'draw it'));
    const fin = await waitFor(() => env.chats('final')[0], 5000, 'the final');
    assert.match(fin.message.content[0].text, /^Here\./);
    assert.equal(chatCalls(mock).length, 1, 'no second paid call');
    const d = env.backend.caps.details();
    assert.equal(d.spentMicros, 5000 * 0.1 + 400 * 0.5, 'the call, at what it cost');
    assert.equal(d.typed, 1);
    assert.equal(env.backend.ledger.get('nqa:3fa9c2d1:m_1').state, 'done');
    assert.equal(lines.filter(([k]) => k === 'byok-turn-crash').length, 0);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money: a throw after the provider billed an attempt still counts it: settled at what it cost, the ledger failed, the player told', async () => {
  const dataDir = tmpDir();
  // As the call is answered, the transcripts become unwritable (a file where their folder goes).
  const mock = await startMock(() => {
    fs.rmSync(path.join(dataDir, 'transcripts'), { recursive: true, force: true });
    fs.writeFileSync(path.join(dataDir, 'transcripts'), 'not a folder');
    return reply(BROKEN, { input: 5000, output: 400 });
  });
  const lines = [];
  const env = await started({
    url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), dataDir,
    // Anything that throws after the call: here the logger, as it tells of a transcript it couldn't write.
    log: (k, d) => { lines.push([k, d]); if (k === 'byok-transcript-error') throw new Error('the log broke'); },
  });
  try {
    await env.backend.send(sendParams(CHAT, 'm_2', 'draw it'));
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(err.errorKind, 'unknown');
    assert.equal(err.errorMessage, 'Something went wrong with Anthropic. See the details in the NeverQuestAlone app.');
    assert.equal(env.chats('final').length, 0);
    assert.equal(chatCalls(mock).length, 1);
    const d = env.backend.caps.details();
    assert.equal(d.spentMicros, 5000 * 0.1 + 400 * 0.5, 'the billed call, never $0');
    assert.equal(d.typed, 1, 'and it counts as a turn');
    assert.equal(env.backend.ledger.get('nqa:3fa9c2d1:m_2').state, 'failed');
    assert.ok(lines.some(([k]) => k === 'byok-turn-crash'));
  } finally { await env.backend.stop(); await mock.close(); }

  // A throw after the final went out ends nothing twice: no error after the reply.
  const ok = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const b = await started({ url: ok.url, keystore: await canaryKeystore(), log: (k) => { if (k === 'byok-turn') throw new Error('the log broke'); } });
  try {
    await b.backend.send(sendParams(CHAT, 'm_2b', 'hi'));
    await waitFor(() => b.chats('final').length === 1, 5000, 'the final');
    await sleep(50);
    assert.deepEqual(b.chats().map(c => c.state), ['final']);
    assert.equal(b.backend.ledger.get('nqa:3fa9c2d1:m_2b').state, 'done');
  } finally { await b.backend.stop(); await ok.close(); }
});

test('money: a connection that drops after the input was metered counts the turn at its estimate (the output may be billed)', async () => {
  const mock = await startMock(() => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicHead({ input: 1200 }), destroyAfterBody: true }));
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    await env.backend.send(sendParams(CHAT, 'm_3', 'hello'));
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the error');
    assert.equal(err.errorKind, 'network_after_send');
    const est = estOf(env, 'nqa:3fa9c2d1:m_3');
    assert.ok(est > 1200 * 0.1 + 1 * 0.5, 'the estimate is above what was metered');
    assert.equal(env.backend.caps.details().spentMicros, est);
    assert.equal(env.backend.caps.details().exact, false);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money: /nqa stop or a forget during the request ends the turn aborted: nothing published or written, the chat not brought back, the call counted at its estimate', async () => {
  for (const how of ['forget', 'stop']) {
    const mock = await startMock(() => hang());
    const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
    try {
      const p = sendParams(CHAT, `m_4${how}`, 'draw it');
      await env.backend.send(p);
      await waitFor(() => chatCalls(mock).length === 1, 5000, 'the call out');
      if (how === 'forget') env.backend.forget(p.chatId);
      else assert.equal(env.backend.abort(p.chatId).aborted, true);
      await waitFor(() => env.chats().length === 1, 3000, 'the run ends');
      await sleep(50);
      assert.deepEqual(env.chats().map(c => c.state), ['aborted'], how);
      assert.equal(env.backend.ledger.get(p.idem).state, 'failed');
      assert.equal(fs.existsSync(path.join(env.dataDir, 'transcripts', `${CHAT}.jsonl`)), false, 'nothing written');
      const side = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'byok-chats.json'), 'utf8'));
      assert.equal(side.chats[CHAT], undefined, how === 'forget' ? 'the forgotten chat stays forgotten' : 'nothing recorded');
      const d = env.backend.caps.details();
      assert.equal(d.spentMicros, estOf(env, p.idem), 'out when stopped: its outcome unknown, so its estimate');
      assert.equal(d.typed, 1);
    } finally { await env.backend.stop(); await mock.close(); }
  }
});

test('money: no limit of ours: two chats at once both go and count; a broken map block takes no second call', async () => {
  // Two chats at once: both go.
  const slow = await startMock(async () => { await sleep(300); return reply('ok.\n\nTL;DR: ok.'); });
  const env = await started({ url: slow.url, keystore: await canaryKeystore() });
  try {
    await env.backend.send(sendParams(CHAT, 'm_5', 'one'));
    await sleep(50);
    await env.backend.send(sendParams(CHAT2, 'm_6', 'two'));
    await waitFor(() => env.chats().length === 2, 5000, 'both answered');
    assert.deepEqual(env.chats().map(c => c.state), ['final', 'final']);
    assert.equal(env.backend.caps.snapshot().turns, 2);
  } finally { await env.backend.stop(); await slow.close(); }

  const mock = await startMock(() => reply(BROKEN));
  const b = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    for (let i = 0; i < 3; i++) {
      await b.backend.send(sendParams(CHAT, `m_7${i}`, 'draw it'));
      await waitFor(() => b.chats('final').length === i + 1, 5000, `final ${i + 1}`);
    }
    assert.equal(chatCalls(mock).length, 3, 'one call a turn');
    assert.equal(chatCalls(mock).filter(isRepair).length, 0);
    assert.equal(b.backend.caps.details().turns, 3);
  } finally { await b.backend.stop(); await mock.close(); }
});

test('money: a stop counts only what went: a request out counts at its estimate at the next start, once; a turn waiting to retry after its request never left, nothing', async () => {
  // Stopped mid-request: the turn counts at its estimate at the next start (from the ledger), once.
  const mock = await startMock(() => hang());
  const dataDir = tmpDir();
  const a = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  const p = sendParams(CHAT, 'm_8', 'hi');
  await a.backend.send(p);
  await waitFor(() => chatCalls(mock).length === 1, 5000, 'out');
  const est = estOf(a, p.idem);
  await a.backend.stop();
  assert.equal(a.backend.caps.details().typed, 0, 'not booked by the stopping backend');
  const b = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  try {
    const d = b.backend.caps.details();
    assert.equal(d.spentMicros, est);
    assert.equal(d.typed, 1);
    assert.equal(d.exact, false);
    assert.equal(b.chats().length, 0, 'nothing said at the start: the core asks (code health BR-22)');
    assert.equal(b.backend.outcomes([p.idem])[0].state, 'interrupted', 'outcomes() says it was interrupted');
  } finally { await b.backend.stop(); }
  const again = await started({ url: mock.url, keystore: await canaryKeystore(), dataDir, priceBook: flatPrices() });
  try {
    assert.equal(again.backend.caps.details().spentMicros, est, 'booked once');
  } finally { await again.backend.stop(); await mock.close(); }

  // Nothing listening: the request never leaves (network_before_send), and the turn waits to retry when the stop comes.
  const closed = http.createServer();
  await new Promise(r => closed.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(r => closed.close(r));
  const dir2 = tmpDir();
  let waiting = false;
  const c = await started({ url, keystore: await canaryKeystore(), dataDir: dir2, priceBook: flatPrices(),
    sleep: (ms, signal) => new Promise((resolve) => { waiting = true; signal.addEventListener('abort', () => resolve(false), { once: true }); }) });
  await c.backend.send(sendParams(CHAT, 'm_9', 'hi'));
  await waitFor(() => waiting, 5000, 'the retry wait');
  await c.backend.stop();
  const e = await started({ url, keystore: await canaryKeystore(), dataDir: dir2, priceBook: flatPrices() });
  try {
    const d = e.backend.caps.details();
    assert.equal(d.spentMicros, 0, 'nothing left the machine');
    assert.equal(d.typed, 0);
  } finally { await e.backend.stop(); }
});

test('money: a cap the player set: a turn whose estimate would pass it is refused and rt says cap while one like it would be; raising the cap ends it', async () => {
  const mock = await startMock(async () => { await sleep(50); return reply('ok.\n\nTL;DR: ok.'); });
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
  try {
    await env.backend.send(sendParams(CHAT, 'm_10', 'one'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'A answered');
    const spent = env.backend.caps.snapshot().spentMicros;
    const est = estOf(env, 'nqa:3fa9c2d1:m_10');
    // A cap with room for less than one more turn's estimate: B is refused, nothing sent.
    await env.backend.setConfig({ caps: { dailyUsd: (spent + est / 2) / 1e6 } });
    await env.backend.send(sendParams(CHAT2, 'm_11', 'two'));
    await waitFor(() => env.chats('error').length === 1, 3000, 'B refused');
    assert.equal(env.chats('error')[0].errorKind, 'cap_spend');
    assert.equal(chatCalls(mock).length, 1);
    assert.deepEqual(rtOf(env.backend.slotExtras()), { state: 'cap', reason: 'cap_spend' });
    assert.deepEqual([env.backend.slotExtras().rt.line, env.backend.slotExtras().rt.tone, env.backend.slotExtras().rt.action], ['Daily spend limit reached', 'bad', 'desktop']);
    assert.equal(env.backend.slotExtras().bridge.usage.needs, 'cap');
    // Room for it again: not the cap, and B goes.
    await env.backend.setConfig({ caps: { dailyUsd: (spent + 10 * est) / 1e6 } });
    const s = env.backend.slotExtras();
    assert.deepEqual(rtOf(s), { state: 'ready' }, 'room again: not the cap');
    await env.backend.send(sendParams(CHAT2, 'm_12', 'two again'));
    await waitFor(() => env.chats('final').length === 2, 5000, 'B goes now');
    // With no cap set nothing is ever 'cap'; a cap the player sets below today's spend says so at
    // once, and turning it off ends it at once.
    const t = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices() });
    try {
      await t.backend.send(sendParams(CHAT, 'm_13', 'one'));
      await waitFor(() => t.chats('final').length === 1, 5000, 'the one');
      assert.deepEqual(rtOf(t.backend.slotExtras()), { state: 'ready' }, 'no cap of ours');
      assert.equal(t.backend.slotExtras().bridge.usage.capMicros, undefined);
      await t.backend.setConfig({ caps: { dailyUsd: 0.0001 } });
      assert.deepEqual(rtOf(t.backend.slotExtras()), { state: 'cap', reason: 'cap_spend' });
      assert.equal(t.backend.slotExtras().bridge.usage.needs, 'cap');
      await t.backend.setConfig({ caps: { dailyUsd: null } });
      assert.deepEqual(rtOf(t.backend.slotExtras()), { state: 'ready' });
      assert.equal(t.backend.slotExtras().bridge.usage.needs, undefined);
      assert.equal(t.backend.slotExtras().bridge.usage.capMicros, undefined);
    } finally { await t.backend.stop(); }
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money: one 3-minute limit covers the whole run (PV-7): retries and their waits count, and the turn ends as timeout', async () => {
  const mock = await startMock(() => errorReply(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after-ms': '600' }));
  // A clock of the test's own (code health): a request takes no time on it, a retry's wait moves it, and
  // the run's limit fires the moment it passes. On the real clock a loaded machine could spend the
  // whole limit on the first attempt and its wait, so only one was made (Windows CI run 37069536135:
  // 1 !== 2); here the count is the rule's, every time.
  const clock = { t: 0, timers: [] };
  const deadline = (ms) => { const c = new AbortController(); clock.timers.push({ at: clock.t + ms, c }); return c.signal; };
  const sleep = async (ms, signal) => {
    if (signal?.aborted) return false;
    const until = clock.t + ms;
    const due = clock.timers.filter(x => !x.c.signal.aborted && x.at <= until).sort((a, b) => a.at - b.at)[0];
    if (due) { clock.t = due.at; due.c.abort(new DOMException('The run limit passed', 'TimeoutError')); return false; }
    clock.t = until;
    return true;
  };
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), random: () => 0, runMs: 1000, priceBook: flatPrices(), deadline, sleep });
  try {
    await env.backend.send(sendParams(CHAT, 'm_14', 'hi'));
    const err = await waitFor(() => env.chats('error')[0], 5000, 'the timeout');
    assert.equal(err.errorKind, 'timeout');
    assert.equal(err.errorMessage, 'No answer from Anthropic after 1 second.');
    assert.equal(err.action, 'retry');
    assert.equal(clock.t, 1000, 'at the run limit, not after every retry: the second 600 ms wait was cut at 1,000');
    assert.equal(chatCalls(mock).length, 2, 'the second wait was cut: no third attempt');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money: a reply\'s rate-limit headers with a bucket at 0 put rt in slowed until its reset (US-3)', async () => {
  const resetAt = new Date(Date.now() + 30000).toISOString();
  const mock = await startMock(() => {
    const r = reply('ok.\n\nTL;DR: ok.');
    return { ...r, headers: { ...r.headers, 'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '0', 'anthropic-ratelimit-requests-reset': resetAt,
      'anthropic-ratelimit-tokens-remaining': '9000', 'anthropic-ratelimit-tokens-reset': resetAt } };
  });
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    assert.equal(env.backend.slotExtras().rt.state, 'ready');
    await env.backend.send(sendParams(CHAT, 'm_15', 'hi'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'final');
    const s = env.backend.slotExtras();
    assert.equal(s.rt.state, 'slowed');
    assert.ok(s.rt.retryIn > 25 && s.rt.retryIn <= 30, String(s.rt.retryIn));
    assert.equal(s.bridge.usage.needs, 'slowed');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money: a ledger that can\'t be written answers the message with its line at once, and sends nothing', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    const begin = env.backend.ledger.begin;
    env.backend.ledger.begin = () => { throw Object.assign(new Error('ledger: not on disk'), { code: 'LEDGER_WRITE_FAILED' }); };
    const res = await env.backend.send(sendParams(CHAT, 'm_16', 'hi'));
    assert.equal(res.status, 'started');
    const err = await waitFor(() => env.chats('error')[0], 3000, 'the line');
    // Its own kind and line (SY-12): a write on this computer, never the AI's fault.
    assert.equal(err.errorKind, 'local_write');
    assert.equal(err.errorMessage, "NeverQuestAlone couldn't save on this computer, so nothing was sent. Click Retry. Restart your computer if it keeps happening.");
    assert.equal(err.action, 'retry');
    await sleep(50);
    assert.equal(chatCalls(mock).length, 0);
    assert.deepEqual([env.backend.status().lastError.kind, env.backend.status().lastError.code], ['local_write', 'write_failed']);
    env.backend.ledger.begin = begin;
    await env.backend.send(sendParams(CHAT, 'm_17', 'hi again'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'fine again');
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money: automatic turns have no cap of ours: more than the old 20 a day all run, counted apart from typed ones', async () => {
  const mock = await startMock(() => reply('Noted.\n\nTL;DR: noted.'));
  const env = await started({ url: mock.url, keystore: await canaryKeystore() });
  try {
    assert.equal(env.backend.autoTurns, undefined, 'no automatic-turn cap for the core to hold events at');
    for (let i = 1; i <= 25; i++) {
      await env.backend.send(sendParams('c0ffee0', `e_${i}`, '', { kind: 'evt', event: { kind: 'route_done', args: {} } }));
      await waitFor(() => env.chats('final').length === i, 5000, `event reply ${i}`);
    }
    assert.equal(env.chats('error').length, 0);
    const u = env.backend.slotExtras().bridge.usage;
    assert.deepEqual([u.auto, u.turns, u.capMicros, u.autoLeft, u.capTurns], [25, 0, undefined, undefined, undefined]);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money (code health BR-09): an unreadable usage history with a cap set holds the cap, and the status says why; the player setting the cap in the app acknowledges it, and paid turns go again', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'usage-history.json'), '{"v":1,"days":{');
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), dataDir, config: { caps: { dailyUsd: 1 } } });
  try {
    assert.deepEqual(rtOf(env.backend.slotExtras()), { state: 'cap', reason: 'load_error' }, 'held, and why');
    assert.equal(env.backend.slotExtras().bridge.usage.held, 'load_error');
    await env.backend.send(sendParams(CHAT, 'm_l1', 'hi'));
    const err = await waitFor(() => env.chats('error')[0], 3000, 'refused');
    assert.equal(err.errorKind, 'cap_spend');
    assert.equal(chatCalls(mock).length, 0, 'nothing sent while held');
    // The app's setCaps (the player at Daily limit, where the status says why): acknowledged.
    await env.backend.setConfig({ caps: { dailyUsd: 1 } });
    assert.deepEqual(rtOf(env.backend.slotExtras()), { state: 'ready' });
    assert.equal(env.backend.slotExtras().bridge.usage.held, undefined);
    await env.backend.send(sendParams(CHAT, 'm_l2', 'hi again'));
    await waitFor(() => env.chats('final').length === 1, 5000, 'the turn goes');
    assert.equal(chatCalls(mock).length, 1);
  } finally { await env.backend.stop(); await mock.close(); }
});

test('money (code health BR-09, bones-ux-writer UX-W02): the game hears a held cap as held, never "reached": the refusal says today\'s spend couldn\'t be read, and the slot\'s status line is the app\'s word for it', async () => {
  const mock = await startMock(() => reply('ok.\n\nTL;DR: ok.'));
  const dataDir = tmpDir();
  fs.writeFileSync(path.join(dataDir, 'usage-history.json'), '{"v":1,"days":{');
  const env = await started({ url: mock.url, keystore: await canaryKeystore(), priceBook: flatPrices(), dataDir, config: { caps: { dailyUsd: 1 } } });
  try {
    assert.deepEqual([env.backend.slotExtras().rt.line, env.backend.slotExtras().rt.action], ['Today\'s spend unknown', 'desktop'], 'straight apostrophes in game');
    await env.backend.send(sendParams(CHAT, 'm_h1', 'hi'));
    const err = await waitFor(() => env.chats('error')[0], 3000, 'refused');
    assert.deepEqual([err.errorKind, err.errorMessage, err.action], ['cap_spend', 'Today\'s spend couldn\'t be read, so NeverQuestAlone rests. Set your limit again in the NeverQuestAlone app.', 'desktop']);
    // Acknowledged: a limit reached later is said as before.
    await env.backend.setConfig({ caps: { dailyUsd: 1 } });
    assert.equal(env.backend.slotExtras().rt.line, 'Ready');
  } finally { await env.backend.stop(); await mock.close(); }
});
