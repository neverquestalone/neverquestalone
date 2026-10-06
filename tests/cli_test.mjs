// The developer command line's pure parts: its config (loadConfig) and the install's slot helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, DEFAULTS } from '../bridge/config.mjs';
import { interfaceFromVersion } from '../bridge/byok/wow.mjs';
import { installSlots, slotInterface, countSlots } from '../bridge/transport/slots.mjs';

test('config: defaults fill in, the M0 spike\'s and the retired build\'s keys are ignored, user values win', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-cfg-'));
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ addonDir: '/x', slots: 400, agent: 'claude', backend: 'legacy', owner: 'Ada',
    gateway: { url: 'ws://127.0.0.1:1', tunnel: { enabled: true } }, sessions: { labels: { main: 'Mortimer' } }, capture: { intervalMs: 500 } }));
  const c = loadConfig(f);
  assert.equal(c.transport.slots, 200, 'the spike\'s top-level slots is not ours');
  assert.equal(c.gateway, undefined, 'no gateway section');
  assert.equal(c.owner, undefined, 'no owner (audit EX-05\'s key went with the retired build)');
  assert.equal(c.backend, undefined, 'no backend key: there is one backend, whatever a file says');
  assert.equal(c.sessions, undefined, 'no sessions section (code health BR-28): no thinking level of its own, and the persona\'s name is the backend\'s (byok.persona)');
  assert.equal(c.capture.intervalMs, 500, 'user values win');
  assert.equal(c.capture.enabled, true, 'nested defaults survive a partial section');
  const none = loadConfig(path.join(dir, 'missing.json'));
  assert.deepEqual(none, JSON.parse(JSON.stringify({ ...DEFAULTS })), 'no file: the defaults');
  assert.equal(none.wow.flavorDir, null, 'no WoW folder unless one is named');
});

test('install: interface number from the client version; slot TOCs rewritten when it changes', () => {
  assert.equal(interfaceFromVersion('1.60.1'), '16001');
  assert.equal(interfaceFromVersion('1.60.12'), '16012');
  assert.equal(interfaceFromVersion('bad'), null);
  const addons = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-slots-'));
  assert.deepEqual(installSlots(addons, { count: 3, iface: '16001' }), { created: 3, rewritten: 0, kept: 0 });
  assert.equal(slotInterface(addons), '16001');
  assert.deepEqual(installSlots(addons, { count: 3, iface: '16002' }), { created: 0, rewritten: 3, kept: 0 });
  assert.equal(slotInterface(addons), '16002');
  assert.equal(countSlots(addons), 3);
  for (const f of ['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act']) {
    assert.ok(fs.existsSync(path.join(addons, 'NeverQuestAlone', 'sig', 'ctl', `${f}.wav`)), `doorbell ${f} made at setup`);
  }
});
