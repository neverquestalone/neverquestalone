#!/usr/bin/env node
// Replays strip records through the real bridge and prints the turns it would
// send, without any AI (companion PRD C2.2):
//
//   node tools/nqa-replay.mjs tests/fixtures/event-level-up.json --dry-run
//
// The fixture is { about, records: ["<v2 record>", …] }, the same wires the
// addon draws. The bridge runs in a temporary folder against a stand-in
// backend that records the core's sends: what's printed is each send as the core
// makes it ({chatId, idem, turn, thinking}; turn is the raw turn: the kind, the
// typed words, the event, the state, the context lines, the notes that ride
// along), which the backend builds its model's request from. Nothing leaves this
// machine: --dry-run is the only mode, and it's required so the intent is explicit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../bridge/service.mjs';
import { installSlots } from '../bridge/transport/slots.mjs';
import { RS } from '../bridge/transport/records.mjs';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file || !args.includes('--dry-run')) {
  console.error('usage: node tools/nqa-replay.mjs <fixture.json> --dry-run');
  process.exit(2);
}
const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
const records = Array.isArray(fixture.records) ? fixture.records : [];
if (!records.length) { console.error(`${file}: no records`); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-replay-'));
const addonsDir = path.join(tmp, 'AddOns');
installSlots(addonsDir, { count: 2, iface: '16001' });
const sent = [];
const backend = (handlers) => ({
  kind: 'byok',
  displayName: 'Replay',
  persona: 'Bones',
  start() {
    handlers.onState({ state: 'ready', since: Math.floor(Date.now() / 1000) });
    handlers.onReady();
  },
  stop() {},
  send(args) { sent.push(args); return { runId: args.idem, status: 'started' }; },
  abort: () => ({ aborted: false }),
  forget: () => ({ ok: true }),
  outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
});
const logs = [];
const bridge = createBridge({ transport: { slots: 2 } }, {
  stateDir: path.join(tmp, 'state'), addonsDir,
  log: (kind, data) => logs.push({ kind, ...data }),
  publisherOpts: { coalesceMs: 1 },
  gatewayFactory: backend,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
let code = 0;
try {
  bridge.start();
  await sleep(50);
  bridge.handlePayload(records.join(RS));
  for (let i = 0; i < 60 && !sent.length; i++) await sleep(50);
  await sleep(100);
  if (!sent.length) {
    console.error('No send. Bridge log:');
    for (const l of logs) if (!/^(publish|bells|legacy)/.test(l.kind)) console.error(' ', JSON.stringify(l));
    code = 1;
  }
  for (const p of sent) console.log(JSON.stringify({ send: p }, null, 2));
} finally {
  await bridge.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(code);
