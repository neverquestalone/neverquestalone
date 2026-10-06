// The core's tests on the product's own backend (code health BR-22): bridge/byok/backend.mjs, made by
// the core's deps.gatewayFactory as the app makes it, on a data folder of its own that outlives a
// backend (as the player's does), its turns answered by the providers' mock server on 127.0.0.1 with a
// canary key (tests/byok/helpers/mock-provider.mjs). It took the place of the backend's test double: no
// stand-in of the backend's calls is left to drift from it. No real network, no real keys.
//
//   const be = await startRealBackend(opts)
//   createBridge(config, { ..., gatewayFactory: be.factory })
//
// opts: respond({typed, kind, event, state, notes, contextLines, chatId, turn, body}) → {text, retries?}
// (default: defaultResponder; retries: the AI is busy that many times first, a 529 with a 1 ms
// retry-after), noKey (no key until addKey()), backendOpts (more createLocalBackend options).
// What a test can hold, as the double's gates did: holdAt('start') holds the first turn whose request
// reaches the AI (its run is going: lifecycle start, the ledger's 'sending') until release(), or until
// the turn is stopped; holdAt('queued') holds every turn before its run starts (the backend's own hold,
// holdRuns) until release(). reached resolves with {point, chatId, runId} once one is there.
//
// be.sends(): what the core handed the backend, one entry a send: {chatId, idem, turn (the raw turn:
// kind, typed, contextLines, useContext, state, event, notes…), thinking, at}. be.aborts(): the core's
// stops, by chat. be.calls(): the requests that reached the AI. be.rows(chatId): the chat's transcript
// as kept. be.knows(chatId): whether the backend keeps anything of the chat; be.side(chatId): its entry
// in byok-chats.json. be.ledger(runId): the turn's ledger entry. be.runEnded(runId): resolves once that
// turn is over in the ledger. be.backend: the backend made last. be.addKey(): the player adds a key in
// the app. be.loseSideFile(): byok-chats.json lost before the next start.
import fs from 'node:fs';
import path from 'node:path';
import { createLocalBackend } from '../../bridge/byok/backend.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { readDataBlock } from '../../bridge/byok/runtime/context.mjs';
import { startMock, reply, errorReply, manifestsAt, tmpDir, CANARY_KEYS, NO_CHECKS } from '../byok/helpers/byok-env.mjs';

/** The zone from the core's context lines ("Location: Mulgore - Red Cloud Mesa" → "Mulgore, Red Cloud Mesa"). */
export function zoneOf(contextLines) {
  const line = String(contextLines ?? '').split('\n').find(l => l.startsWith('Location: '));
  return line ? line.slice('Location: '.length).replace(/ - /, ', ').trim() : null;
}

/** "zone" in the words: where the context lines say; exactly: <word> → that word; else OK. */
export function defaultResponder({ typed, contextLines }) {
  const m = String(typed ?? '');
  if (/zone/i.test(m)) {
    const zone = zoneOf(contextLines) || 'somewhere unknown';
    return { text: `You're in ${zone}.\n\nTL;DR: ${zone}.` };
  }
  const exact = m.match(/exactly:?\s*"?([\w-]+)"?/i);
  if (exact) return { text: exact[1] };
  return { text: 'OK' };
}

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function startRealBackend(opts = {}) {
  const o = { respond: defaultResponder, noKey: false, backendOpts: {}, ...opts };
  const dataDir = tmpDir('nqa-real-backend-');
  const keystore = createKeyStore({ backend: 'memory' });
  if (!o.noKey) await keystore.set('anthropic', CANARY_KEYS.anthropic);
  const sends = [];
  const aborts = [];
  const instances = new Set();
  let latest = null;
  const holds = { start: [], queued: null };
  const decided = new Map(); // a request's body (JSON) → {answer, tries}: a retry asks again with the same body

  // The send a request to the AI is for: the chat whose last request (the backend's KY-8 view, kept
  // just before it's sent) is this one, and that chat's latest send.
  function sendFor(body) {
    for (const b of [...instances].reverse()) {
      for (const s of [...sends].reverse()) {
        if (sameJson(b.lastRequest(s.chatId)?.body, body)) return s;
      }
    }
    return null;
  }

  const mock = await startMock(async (req) => {
    if (req.method !== 'POST') return null;
    const key = req.raw;
    let d = decided.get(key);
    const s = sendFor(req.body);
    if (!d) {
      const turn = s?.turn ?? {};
      const last = req.body?.messages?.at(-1);
      const content = typeof last?.content === 'string' ? last.content : '';
      const block = readDataBlock(content);
      const typed = turn.kind === 'msg' || turn.kind === undefined ? (turn.typed ?? content.split('\n\n').at(-1)) : undefined;
      const contextLines = turn.useContext === false ? null : (turn.contextLines ?? (Array.isArray(block?.data?.game?.context) ? block.data.game.context.join('\n') : null));
      const answer = await o.respond({ typed, kind: turn.kind ?? 'msg', event: turn.event, state: turn.state, notes: turn.notes, contextLines, chatId: s?.chatId ?? null, turn, body: req.body });
      d = { answer: answer ?? { text: 'OK' }, tries: 0 };
      decided.set(key, d);
    }
    // A hold on a running turn ('start'): the first request of a turn to reach it waits.
    const h = holds.start.find(x => !x.used);
    if (h && d.tries === 0) {
      h.used = true;
      h.arrive({ point: 'start', chatId: s?.chatId ?? null, runId: s?.idem ?? null });
      await h.released;
    }
    d.tries += 1;
    if (d.tries <= (d.answer.retries || 0)) return errorReply(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after-ms': '1' });
    return reply(String(d.answer.text ?? ''), isObj(d.answer.usage) ? d.answer.usage : {});
  });

  const log = (kind, data) => {
    // The backend's own hold (holdRuns): a turn reached it before its run started.
    if (kind === 'byok-turn-held' && holds.queued && !holds.queued.used) {
      holds.queued.used = true;
      const chatId = data?.chat ?? null;
      const s = [...sends].reverse().find(x => x.chatId === chatId);
      holds.queued.arrive({ point: 'queued', chatId, runId: s?.idem ?? null });
    }
  };

  // What the core calls, recorded on the way in; everything else passes through as the backend has it.
  function recorded(backend) {
    const out = Object.defineProperties({}, Object.getOwnPropertyDescriptors(backend));
    if (typeof backend.send === 'function') {
      out.send = (p) => {
        sends.push({ chatId: p?.chatId ?? null, idem: p?.idem ?? null, turn: isObj(p?.turn) ? p.turn : {}, thinking: p?.thinking, at: Date.now() });
        return backend.send(p);
      };
    }
    if (typeof backend.abort === 'function') out.abort = (chatId) => { aborts.push({ chatId, at: Date.now() }); return backend.abort(chatId); };
    return out;
  }

  /** The backend the core's deps.gatewayFactory(handlers, shared) returns: one per bridge, on this data folder. */
  function factory(handlers = {}, shared = null) {
    const b = createLocalBackend(handlers, {
      config: { byok: { provider: 'anthropic' } }, dataDir, keystore, log, manifests: manifestsAt(mock.url),
      providerOpts: { timeouts: { firstTokenMs: 5000, idleMs: 5000, runMs: 10000, requestMs: 5000 } },
      checks: NO_CHECKS, random: () => 0,
      ...(shared?.writer ? { writer: shared.writer } : {}),
      ...o.backendOpts,
    });
    if (holds.queued && !holds.queued.done) b.holdRuns(true);
    instances.add(b);
    latest = b;
    const stop = b.stop;
    return recorded(Object.defineProperties(b, { stop: { value: async () => { try { return await stop(); } finally { instances.delete(b); } } } }));
  }

  const ledgerFile = path.join(dataDir, 'ledger.json');
  function ledgerEntry(runId) {
    if (latest && instances.has(latest)) return latest.ledger.get(runId);
    try { return JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).entries?.[runId] ?? null; } catch { return null; }
  }

  return {
    factory,
    dataDir,
    mock,
    sends: () => sends,
    aborts: () => aborts,
    calls: () => mock.requests.filter(r => r.method === 'POST'),
    get backend() { return latest; },
    ledger: ledgerEntry,
    /** Resolves once the turn is over in the ledger (done, failed or interrupted). */
    async runEnded(runId, ms = 5000) {
      const until = Date.now() + ms;
      for (;;) {
        const e = ledgerEntry(runId);
        if (e && ['done', 'failed', 'interrupted'].includes(e.state)) return e;
        if (Date.now() > until) throw new Error(`timed out waiting for ${runId} to end`);
        await new Promise(r => setTimeout(r, 15));
      }
    },
    /** The chat's transcript as the backend keeps it: [{role, text, t, …}], oldest first. */
    rows(chatId) {
      const file = path.join(dataDir, 'transcripts', `${chatId}.jsonl`);
      try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; }
    },
    /** Does the backend keep anything of this chat (its transcript, or its entry beside the transcripts)? */
    knows(chatId) {
      if (fs.existsSync(path.join(dataDir, 'transcripts', `${chatId}.jsonl`))) return true;
      try { return Object.hasOwn(JSON.parse(fs.readFileSync(path.join(dataDir, 'byok-chats.json'), 'utf8')).chats ?? {}, chatId); } catch { return false; }
    },
    /** The chat's entry beside the transcripts (byok-chats.json), or null. */
    side(chatId) {
      try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'byok-chats.json'), 'utf8')).chats?.[chatId] ?? null; } catch { return null; }
    },
    /** A hold: 'start' (a running turn's reply) or 'queued' (every turn before its run starts). */
    holdAt(point) {
      let release, arrive;
      const released = new Promise(r => { release = r; });
      const reached = new Promise(r => { arrive = r; });
      if (point === 'start') {
        const h = { used: false, arrive, released, release: () => release() };
        holds.start.push(h);
        return { reached, release: h.release };
      }
      if (point !== 'queued') throw new Error(`no hold at ${point}`);
      const h = { used: false, done: false, arrive };
      holds.queued = h;
      for (const b of instances) b.holdRuns(true);
      return {
        reached,
        release: () => {
          if (h.done) return;
          h.done = true;
          if (holds.queued === h) holds.queued = null;
          for (const b of instances) b.holdRuns(false);
          release();
        },
      };
    },
    /** The backend's byok-chats.json lost (read at the next start). */
    loseSideFile() { fs.rmSync(path.join(dataDir, 'byok-chats.json'), { force: true }); },
    /** The player adds a key in the app: every backend running looks at the key store again. */
    async addKey() {
      await keystore.set('anthropic', CANARY_KEYS.anthropic);
      for (const b of instances) await b.refresh({ keyChanged: true });
    },
    async close() {
      for (const h of holds.start) h.release(); // nothing left waiting on a hold
      holds.queued = null;
      for (const b of [...instances]) await b.stop();
      await mock.close();
      // A temp folder: one Windows still holds a moment after the backend stopped is left to the OS.
      try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* a temp folder */ }
    },
  };
}
