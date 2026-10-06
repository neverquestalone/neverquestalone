// A tiny local provider server for the provider-layer tests (PRD PV-8, B2.1,
// B2.2): replays the docs-derived fixtures in tests/fixtures/byok/providers
// on 127.0.0.1, records every request, and can split bodies into small
// chunks, stall, drop the connection, or redirect. No real network.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getManifest, createProvider, customManifest } from '../../../bridge/byok/providers/index.mjs';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/byok/providers');

// Canary keys (never real): the tests grep logs and errors for them.
export const CANARY = Object.freeze({
  anthropic: 'sk-ant-api03-CANARY' + 'x'.repeat(80),
  openai: 'sk-proj-CANARY' + 'x'.repeat(80),
  xai: 'xai-CANARY' + 'x'.repeat(80),
  openrouter: 'sk-or-v1-CANARY' + 'x'.repeat(64),
  google: 'AIza' + 'CANARY' + 'x'.repeat(29),
});

export function fixture(id, name) {
  const text = fs.readFileSync(path.join(FIXTURES, id, name), 'utf8');
  if (name.endsWith('.json')) {
    const env = JSON.parse(text);
    const headers = {};
    for (const [k, v] of Object.entries(env.headers || {})) {
      headers[k] = String(v).replace(/\{\{now\+(\d+)\}\}/g, (_, n) => String(Date.now() + Number(n)));
    }
    return { status: env.status, headers, body: typeof env.body === 'string' ? env.body : JSON.stringify(env.body) };
  }
  const type = name.endsWith('.ndjson') ? 'application/x-ndjson' : 'text/event-stream';
  return { status: 200, headers: { 'content-type': type }, body: text };
}

const tick = (ms) => new Promise(r => (ms ? setTimeout(r, ms) : setImmediate(r)));

async function serve(req, res, spec, rec) {
  res.on('close', () => { if (!res.writableFinished) rec.clientClosed = true; });
  if (spec.destroyBeforeHeaders) { req.socket.destroy(); return; }
  if (spec.redirect) { res.writeHead(spec.status || 302, { location: spec.redirect }); res.end(); return; }
  if (spec.hangBeforeHeaders) return;
  res.writeHead(spec.status ?? 200, spec.headers || {});
  if (spec.script) {
    for (const [delayMs, text] of spec.script) {
      await tick(delayMs);
      if (res.destroyed) return;
      res.write(text);
    }
    res.end();
    return;
  }
  const buf = Buffer.from(spec.body ?? '', 'utf8');
  const every = spec.splitEvery || buf.length || 1;
  for (let i = 0; i < buf.length; i += every) {
    if (res.destroyed) return;
    res.write(buf.subarray(i, i + every));
    if (spec.splitEvery || spec.chunkDelayMs) await tick(spec.chunkDelayMs || 0);
  }
  if (spec.destroyAfterBody) { await tick(5); req.socket.destroy(); return; }
  if (spec.hangAfterBody) return;
  res.end();
}

// startMock(handler): handler(rec) → spec | null. spec: {status, headers, body,
// splitEvery, chunkDelayMs, hangBeforeHeaders, hangAfterBody,
// destroyBeforeHeaders, destroyAfterBody, redirect, script}. `script` is a list
// of [delayMs, text] parts written in order after the headers.
//
// Every answer says Connection: close, so the client's socket ends with its answer, inside the test
// that asked (CI run 37150133957, windows 2/3). A socket kept alive arms Node 22's fetch (undici 6) a
// keep-alive timer with only a weak hold on its parser; when that socket closed later, while another
// test had node:test's mock timers on, the mock clearTimeout left the real timer running, the parser
// was collected, and the timer threw "Cannot destructure property 'socket' of 'parser.deref(...)'"
// after the test had ended (undici fixed it in 7.20, nodejs/undici#4758; Node 22 keeps 6.x).
export async function startMock(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (req, res) => {
    res.shouldKeepAlive = false;
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    const rec = { method: req.method, url: req.url, headers: req.headers, raw, body, clientClosed: false };
    requests.push(rec);
    const spec = (await handler(rec)) || { status: 404, headers: { 'content-type': 'application/json' }, body: '{"error":"no route"}' };
    await serve(req, res, spec, rec);
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    async close() {
      server.closeAllConnections();
      for (const s of sockets) s.destroy();
      await new Promise(r => server.close(r));
    },
  };
}

// A mock that serves one spec for every request.
export const serveOne = (spec) => startMock(() => spec);

// A provider for manifest `id` pointed at the mock, with a canary key and a
// log that records every line as JSON text.
export function mockProvider(id, url, opts = {}) {
  const m = getManifest(id);
  const base = new URL(m.baseUrl);
  const manifest = { ...m, baseUrl: url + (base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')) };
  const lines = [];
  const log = (kind, data) => lines.push(JSON.stringify({ kind, ...data }));
  const provider = createProvider(manifest, {
    getKey: async () => CANARY[id] ?? null,
    log,
    ...opts,
  });
  return { provider, manifest, lines };
}

/**
 * Other (custom) against the mock: the player's settings made into a manifest (customManifest).
 * baseUrl: the service's base URL as the player typed it; an https one (a service off this computer)
 * is sent to the mock by a fetch that swaps its origin, so the manifest is exactly the player's.
 * key: the key (null for a server on this computer). Returns {provider, manifest, lines}.
 */
export function mockCustom(mockUrl, { baseUrl = `${mockUrl}/v1`, model = 'test/model', key = null, ...opts } = {}) {
  const manifest = customManifest(getManifest('custom'), { baseUrl, model });
  if (!manifest) throw new Error(`not a custom base URL: ${baseUrl}`);
  const origin = new URL(manifest.baseUrl).origin;
  const lines = [];
  const log = (kind, data) => lines.push(JSON.stringify({ kind, ...data }));
  const fetch = (url, init) => globalThis.fetch(String(url).replace(origin, mockUrl), init);
  const provider = createProvider(manifest, { getKey: async () => key, log, fetch, ...opts });
  return { provider, manifest, lines };
}

export async function collect(iterable) {
  const out = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

export const textOf = (events) => events.filter(e => e.type === 'text').map(e => e.delta).join('');
export const last = (events) => events[events.length - 1];

export const REQ = Object.freeze({
  model: null,
  system: [{ text: 'You are NeverQuestAlone, a skeleton guide.', cache: true }, { text: 'Game data: level 12 warrior in Elwynn.' }],
  messages: [{ role: 'user', content: 'Where do I go next?' }],
  maxTokens: 300,
  effort: 'low',
  safetyId: '6f1c2a0e-1111-4222-8333-944455556666',
});

export const req = (model, extra = {}) => ({ ...REQ, model, ...extra });
