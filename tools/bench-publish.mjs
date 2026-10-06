#!/usr/bin/env node
// What one publish costs on this machine's disk (systems critic SY-03): the real bridge's publisher
// writing a typical slot table (a hello, a message and five replies of play's length) once the
// session is set up, timed over many publishes.
//   window  the slots a reporting addon can load next (its slot= report and the margin) and the
//           reload inbox: what a publish writes in play
//   full    every slot and the reload inbox (transport.slotWindow false): what a publish wrote before
//           the window, and still writes with no anchor
// windows-smoke runs both on the runner's NTFS, with whatever real-time scanning it has on, so there
// is a Windows number beside the Mac's.
//
//   node tools/bench-publish.mjs [--mode window|full] [--runs 60] [--dir <folder for the temp AddOns>]
//
// Prints one JSON line: { mode, runs, p50, p90, max (ms a publish), files, bytes, errors, window,
// platform, node }.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../bridge/service.mjs';
import { installSlots, SLOT_COUNT } from '../bridge/transport/slots.mjs';
import { encodeRecord } from '../bridge/transport/records.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const MODE = arg('mode', 'window');
const RUNS = Number(arg('runs', 60));
if (!['window', 'full'].includes(MODE) || !Number.isInteger(RUNS) || RUNS < 1) {
  console.error('usage: node tools/bench-publish.mjs [--mode window|full] [--runs N] [--dir <folder>]');
  process.exit(2);
}

const root = fs.mkdtempSync(path.join(arg('dir', os.tmpdir()), 'bench-publish-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let bridge = null;
try {
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: SLOT_COUNT, iface: '16001' });
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true }); // the addon's own folder, for the reload inbox
  const gw = {};
  const logs = [];
  bridge = createBridge({ transport: { slots: SLOT_COUNT, slotWindow: MODE === 'window' } }, {
    stateDir: path.join(root, 'state'), addonsDir: addons, log: (kind, f) => logs.push({ kind, ...f }),
    publisherOpts: { coalesceMs: 5, progressMs: 0 }, signalsOpts: { pulseMs: { push: 5, alive: 5, act: 5 }, actGapMs: 5 },
    gatewayFactory: (handlers) => {
      gw.handlers = handlers;
      return {
        persona: 'Bones',
        start() { handlers.onState({ state: 'ready', since: Date.now() }); handlers.onReady(); },
        stop() {},
        send: args => ({ runId: args.idem, status: 'started' }),
        abort: () => ({ aborted: false }),
        forget: () => ({ ok: true }),
        outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
      };
    },
  });
  bridge.start();
  const token = '3fa9c2d1', nonce = 'a3f1', chat = 'c3f9a1e';
  // A reporting addon's hello (the public build's: its next slot is 1) and a message; five replies.
  bridge.handlePayload(encodeRecord({ token, key: nonce, type: 'hello', args: { cur: 0, ver: '0.4.9', build: '70009', iface: '16001', n: 0, ctx: 0, sig: 'ok', slots: SLOT_COUNT, slot: 1, mode: 'pixel' } }));
  await sleep(30);
  bridge.handlePayload(encodeRecord({ token, key: `${nonce}_1`, type: 'msg', chat, args: { cur: 0, agent: 'main', name: 'Route' }, body: 'Where do I hand in this quest?' }));
  await sleep(30);
  for (let i = 0; i < 5; i++) {
    gw.handlers.onEvent({ event: 'chat', payload: { state: 'final', chatId: chat, runId: `run-${i}`,
      message: { role: 'assistant', content: [{ type: 'text', text: 'A reply of the length play has, with a route and a tip. '.repeat(10) }], __nqa: { id: `byok:${chat}:${i + 1}`, seq: i + 1 } } } });
  }
  await sleep(30);
  bridge.publisher.flushNow(); // the window's first write empties what's outside it, once
  const ms = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    bridge.publisher.flushNow();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const q = f => Math.round(ms[Math.floor(f * (ms.length - 1))] * 100) / 100;
  const last = logs.filter(l => l.kind === 'publish').at(-1) || {};
  console.log(JSON.stringify({ mode: MODE, runs: RUNS, p50: q(0.5), p90: q(0.9), max: q(1), files: last.files ?? null, bytes: last.bytes ?? null,
    errors: last.errors ?? 0, window: last.window ?? 'all', platform: `${process.platform}-${process.arch}`, node: process.version }));
} finally {
  await bridge?.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
