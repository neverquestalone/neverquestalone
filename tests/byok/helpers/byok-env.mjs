// Shared by the BYOK backend tests (backend_test.mjs, bridge_byok_e2e_test.mjs): a local backend
// on a temp data folder, pointed at the providers' mock server on 127.0.0.1 with canary keys, and
// the Anthropic SSE a reply is made of. Not a test file. No real network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadManifests } from '../../../bridge/byok/providers/index.mjs';
import { createKeyStore } from '../../../bridge/byok/security/keystore.mjs';
import { createLocalBackend } from '../../../bridge/byok/backend.mjs';
import { effectivePrice } from '../../../bridge/byok/usage/prices.mjs';
import { CANARY_KEYS } from './canary.mjs';

export { startMock } from './mock-provider.mjs';
export { CANARY_KEYS };

export const sleep = ms => new Promise(r => setTimeout(r, ms));
// One more look once the deadline has passed: a single long synchronous write (a bridge writing 201 slot
// files on a loaded runner's NTFS) can hold the event loop past the deadline, and the loop would stop
// without looking at what that write did (release dry run 36346784539's Windows npm test: "timed out
// waiting for ready"; transport_resilience's helper had the same, b9480ab).
export async function waitFor(pred, ms = 5000, label = 'condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await pred();
    if (v) return v;
    await sleep(15);
  }
  const v = await pred();
  if (v) return v;
  throw new Error(`timed out waiting for ${label}`);
}

export function tmpDir(prefix = 'nqa-byok-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sseEvent = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

/** The head of an Anthropic Messages stream (message_start, the text block's start). */
export function anthropicHead({ input = 1200, cacheRead = 0, cacheWrite = 0 } = {}) {
  return sseEvent('message_start', { message: { id: 'msg_01TEST', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null,
    usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite, output_tokens: 1 } } })
    + sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
}
/** The rest of it: the text, the stop reason and the output count. */
export function anthropicTail(text, { output = 40, stop = 'end_turn' } = {}) {
  return (text ? sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }) : '')
    + sseEvent('content_block_stop', { index: 0 })
    + sseEvent('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: output } })
    + sseEvent('message_stop', {});
}
export const anthropicSSE = (text, o = {}) => anthropicHead(o) + anthropicTail(text, o);

/** A mock spec for one Anthropic reply; delayMs holds the rest of the stream back (a slow model). */
export function reply(text, { delayMs = 0, status = 200, requestId = 'req_TEST', ...o } = {}) {
  const headers = { 'content-type': 'text/event-stream', 'request-id': requestId };
  if (!delayMs) return { status, headers, body: anthropicSSE(text, o) };
  return { status, headers, script: [[0, anthropicHead(o)], [delayMs, anthropicTail(text, o)]] };
}

/** An error answer: a JSON body, with headers (retry-after-ms keeps retries short in tests). */
export const errorReply = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

/** The bundled manifests, with Anthropic (and any others named) pointed at the mock. */
export function manifestsAt(url, ids = ['anthropic']) {
  return loadManifests().map((m) => {
    if (!ids.includes(m.id)) return m;
    const base = new URL(m.baseUrl);
    return { ...m, baseUrl: url + (base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')) };
  });
}

/** A price book with one flat price for every model (USD per 1M tokens), for cap arithmetic. */
export function flatPrices({ input = 0.1, output = 0.5 } = {}) {
  const p = (provider, model) => effectivePrice({ provider, model, input, output });
  return { priceFor: p, worstPriceFor: provider => p(provider, null) };
}

/** A key store in memory with canary keys for the providers named. */
export async function canaryKeystore(ids = ['anthropic']) {
  const ks = createKeyStore({ backend: 'memory' });
  for (const id of ids) await ks.set(id, CANARY_KEYS[id]);
  return ks;
}

/**
 * The backend's start-time network check (the model list, PV-3) is off in tests unless a test turns
 * it on (checks: {models: true}): with it on, a backend with no mock would reach the real providers,
 * and a mock's handler would see extra GETs.
 */
export const NO_CHECKS = Object.freeze({ models: false });

/**
 * A local backend on its own data folder, recording what it emits:
 * { backend, events, states, readies, resumes, changes, chats(state?), dataDir }. readies counts onReady.
 */
export function makeBackend({ url, dataDir = tmpDir(), config = {}, keystore = null, manifests = null, log = () => {}, ...opts } = {}) {
  const events = [];
  const states = [];
  const readies = [];
  const resumes = [];
  const changes = [];
  const backend = createLocalBackend({
    onReady: () => readies.push(Date.now()),
    onState: s => states.push(s),
    onEvent: e => events.push(e),
    onResume: () => resumes.push(Date.now()),
    onChange: o => changes.push({ at: Date.now(), push: o?.push === true }),
  }, {
    config: { provider: 'anthropic', ...config },
    dataDir, keystore, log,
    manifests: manifests ?? (url ? manifestsAt(url) : loadManifests()),
    providerOpts: { timeouts: { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 }, ...(opts.providerOpts || {}) },
    checks: NO_CHECKS,
    ...opts,
  });
  const chats = (state = null) => events.filter(e => e.event === 'chat' && (!state || e.payload.state === state)).map(e => e.payload);
  return { backend, events, states, readies, resumes, changes, chats, dataDir };
}

/** backend.send's args as service.mjs makes them: the chat, the turn's key and the raw turn (typed: the words as typed, for a msg). */
export function sendParams(chatId, key, text, { kind = 'msg', contextLines = null, state = null, event = null, thinking, token = '3fa9c2d1' } = {}) {
  const turn = { contextLines, useContext: true, kind };
  if (kind === 'msg') turn.typed = text;
  if (event) turn.event = event;
  if (state) turn.state = state;
  const p = { chatId, idem: `nqa:${token}:${key}`, turn };
  if (thinking) p.thinking = thinking;
  return p;
}
