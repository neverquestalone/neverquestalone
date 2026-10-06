// KY-2, KY-3: the key store round-trips on both backends (the OS store and
// memory; the file stores and the old-name migration are gone, systems plan
// D6), Linux fails closed with no Secret Service, list() never returns values
// and defaults to the manifests' ids, and nothing logs a key. The
// 'os' backend runs against an injected fake binding; the real keychain is
// touched only with NQA_TEST_REAL_KEYCHAIN=1 (the identity's service with -test after it).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { createKeyStore, maskKey, normalizeKey, SERVICE } from '../../bridge/byok/security/keystore.mjs';
import { providerIds } from '../../bridge/byok/providers/index.mjs';
import { CANARY_KEYS } from './helpers/canary.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-keys-'));

// A stand-in for @napi-rs/keyring: records constructor options, stores in a Map.
function fakeKeyring({ failConstruct = null, failOp = null } = {}) {
  const store = new Map();
  const calls = [];
  class AsyncEntry {
    constructor(service, account, options) {
      calls.push({ service, account, options });
      if (failConstruct) throw new Error(failConstruct);
      this.id = `${service}/${account}`;
    }
    async getPassword() { if (failOp) throw new Error(failOp); return store.get(this.id); }
    async setPassword(v) { if (failOp) throw new Error(failOp); store.set(this.id, v); }
    async deleteCredential() { if (failOp) throw new Error(failOp); return store.delete(this.id); }
  }
  return { mod: { AsyncEntry }, store, calls };
}

async function roundTrip(ks) {
  assert.equal(await ks.get('anthropic'), null);
  await ks.set('anthropic', `  ${CANARY_KEYS.anthropic}\n`);
  await ks.set('custom', CANARY_KEYS.openrouter); // Other's key: an OpenRouter key, say
  assert.equal(await ks.get('anthropic'), CANARY_KEYS.anthropic, 'trimmed on the way in');
  assert.deepEqual(await ks.list(), ['anthropic', 'custom']);
  await ks.set('anthropic', CANARY_KEYS.openai);
  assert.equal(await ks.get('anthropic'), CANARY_KEYS.openai, 'replace');
  assert.equal(await ks.delete('anthropic'), true);
  assert.equal(await ks.delete('anthropic'), false);
  assert.equal(await ks.get('anthropic'), null);
  assert.deepEqual(await ks.list(['anthropic', 'custom']), ['custom']);
}

test('keystore: memory backend round trip; values never in list()', async () => {
  const ks = createKeyStore({ backend: 'memory' });
  assert.equal(ks.persistent, false);
  await roundTrip(ks);
  for (const id of await ks.list()) assert.ok(providerIds().includes(id));
  assert.throws(() => createKeyStore({ backend: 'file-plaintext', file: '/tmp/x' }), { code: 'bad_backend' }, 'no file stores');
  assert.throws(() => createKeyStore({ backend: 'file-encrypted', file: '/tmp/x', passphrase: 'long enough passphrase' }), { code: 'bad_backend' });
});

test('keystore: input checks (provider ids, empty, spaces inside, too long)', async () => {
  const ks = createKeyStore({ backend: 'memory' });
  await assert.rejects(ks.set('Anthropic', 'k'.repeat(20)), { code: 'bad_provider' });
  await assert.rejects(ks.set('../x', 'k'.repeat(20)), { code: 'bad_provider' });
  await assert.rejects(ks.set('__proto__', 'k'.repeat(20)), { code: 'bad_provider' });
  await assert.rejects(ks.set('openai', '   '), { code: 'bad_key' });
  await assert.rejects(ks.set('openai', 'sk-abc def'), { code: 'bad_key' });
  await assert.rejects(ks.set('openai', 'x'.repeat(2000)), { code: 'bad_key' });
  await assert.rejects(ks.set('openai', 42), { code: 'bad_key' });
  assert.equal(normalizeKey('\tabc\r\n'), 'abc');
  assert.throws(() => createKeyStore({ backend: 'keyutils' }), { code: 'bad_backend' });
});

test('keystore: os backend uses the identity\'s service, account = provider (macOS/Windows: no Linux pin)', async () => {
  const fake = fakeKeyring();
  const ks = createKeyStore({ backend: 'os', platform: 'darwin', keyring: fake.mod });
  assert.equal(ks.label, 'macOS Keychain');
  await roundTrip(ks);
  assert.equal(SERVICE, IDENTITY.keychainService);
  assert.ok(fake.calls.every(c => c.service === SERVICE && c.options === undefined));
  assert.deepEqual([...fake.store.keys()], [`${SERVICE}/custom`]);
  assert.equal(createKeyStore({ backend: 'os', platform: 'win32', keyring: fake.mod }).label, 'Windows Credential Manager');
});

test('keystore: a key saved under the identity\'s service is found on every OS (a released app\'s service is frozen, so its players\' keys stay where they are: frozen_names_test)', async () => {
  const fake = fakeKeyring();
  fake.store.set(`${IDENTITY.keychainService}/anthropic`, CANARY_KEYS.anthropic); // as an earlier release wrote it
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(await createKeyStore({ backend: 'os', platform, keyring: fake.mod }).get('anthropic'), CANARY_KEYS.anthropic, platform);
  }
});

test('keystore: Linux is pinned to the Secret Service and fails closed without one', async () => {
  const ok = fakeKeyring();
  const ks = createKeyStore({ backend: 'os', platform: 'linux', keyring: ok.mod });
  await ks.set('openai', CANARY_KEYS.openai);
  assert.deepEqual(ok.calls[0].options, { linux: { store: 'secret-service' } });
  assert.deepEqual(await ks.probe(), { ok: true });

  const none = fakeKeyring({ failConstruct: 'Platform secure storage failure: org.freedesktop.DBus.Error.ServiceUnknown' });
  const closed = createKeyStore({ backend: 'os', platform: 'linux', keyring: none.mod });
  await assert.rejects(closed.set('openai', CANARY_KEYS.openai), { code: 'no_secret_service' });
  await assert.rejects(closed.get('openai'), { code: 'no_secret_service' });
  assert.deepEqual(await closed.probe(), { ok: false, code: 'no_secret_service' });
  // The caller's fallback: this session only.
  const session = createKeyStore({ backend: 'memory' });
  await session.set('openai', CANARY_KEYS.openai);
  assert.equal(session.persistent, false);
});

test('keystore: os errors are typed and never carry the key', async () => {
  const denied = createKeyStore({ backend: 'os', platform: 'darwin', keyring: fakeKeyring({ failOp: 'User canceled the operation (-128)' }).mod });
  await assert.rejects(denied.set('anthropic', CANARY_KEYS.anthropic), (e) => e.code === 'keystore_denied' && !e.message.includes('CANARY'));
  const broken = createKeyStore({ backend: 'os', platform: 'win32', keyring: fakeKeyring({ failOp: 'Platform secure storage failure' }).mod });
  await assert.rejects(broken.get('anthropic'), { code: 'keystore_unavailable' });
  const lost = createKeyStore({ backend: 'os', platform: 'linux', keyring: fakeKeyring({ failOp: 'D-Bus: org.freedesktop.secrets went away' }).mod });
  await assert.rejects(lost.get('anthropic'), { code: 'no_secret_service' });
});

test('keystore: Linux: a dismissed or locked prompt over D-Bus is a refusal, not a missing Secret Service', async () => {
  const linux = (failOp) => createKeyStore({ backend: 'os', platform: 'linux', keyring: fakeKeyring({ failOp }).mod });
  const cases = [
    ['Couldn\'t access platform secure storage: SS error: prompt dismissed', 'keystore_denied'],
    ['Couldn\'t access platform secure storage: SS Error: object locked', 'keystore_denied'],
    ['D-Bus error: org.freedesktop.DBus.Error.AccessDenied: Rejected send message', 'keystore_denied'],
    ['org.freedesktop.Secret.Error.IsLocked: Cannot get secret of a locked object (dbus)', 'keystore_denied'],
    ['Platform secure storage failure: org.freedesktop.DBus.Error.ServiceUnknown: The name org.freedesktop.secrets was not provided by any .service files', 'no_secret_service'],
    ['Couldn\'t access platform secure storage: no secret service provider or dbus session found', 'no_secret_service'],
    ['org.freedesktop.DBus.Error.NameHasNoOwner: Could not get owner of name: no such name', 'no_secret_service'],
    ['Platform secure storage failure: D-Bus error: org.freedesktop.DBus.Error.NoReply: Did not receive a reply', 'keystore_unavailable'],
    ['dbus: invalid UTF-8 in reply', 'keystore_unavailable'],
    ['Platform secure storage failure: blocked by a D-Bus policy', 'keystore_unavailable'],
    ['Couldn\'t access platform secure storage: the collection could not be unlocked', 'keystore_denied'],
  ];
  for (const [msg, code] of cases) await assert.rejects(linux(msg).get('anthropic'), { code }, msg);
  // Off Linux the Secret Service words never apply.
  const mac = createKeyStore({ backend: 'os', platform: 'darwin', keyring: fakeKeyring({ failOp: 'no secret service provider or dbus session found' }).mod });
  await assert.rejects(mac.get('anthropic'), { code: 'keystore_unavailable' });
});

test('keystore: the log sees operations and provider ids, never a key', async () => {
  const lines = [];
  const ks = createKeyStore({ backend: 'memory', log: (k, d) => lines.push(JSON.stringify([k, d])) });
  await ks.set('google', CANARY_KEYS.google);
  await ks.delete('google');
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => !l.includes('AIza')));
  assert.match(lines[0], /"op":"set","provider":"google"/);
});

test('keystore: maskKey shows a prefix and at most four characters', () => {
  assert.equal(maskKey('sk-ant-api03-' + 'z'.repeat(80) + 'A1b2'), 'sk-ant-…A1b2');
  assert.equal(maskKey(CANARY_KEYS.openrouter), 'sk-or-…xxxx');
  assert.equal(maskKey(CANARY_KEYS.google), 'AIza…xxxx');
  assert.equal(maskKey(CANARY_KEYS.googleAuth), 'AQ.…xxxx');
  assert.equal(maskKey(CANARY_KEYS.xai), 'xai-…xxxx');
  assert.equal(maskKey(CANARY_KEYS.openaiLegacy), 'sk-…xxxx');
  assert.equal(maskKey('sk-ant-shortkey'), 'sk-ant-…', 'too short to show a tail');
  assert.equal(maskKey('ollama-local'), '…');
  assert.equal(maskKey(''), '…');
  assert.equal(maskKey(null), '…');
});

test('keystore: the pinned @napi-rs/keyring binding loads here (no keychain access)', async () => {
  const mod = await import('@napi-rs/keyring');
  assert.equal(typeof mod.AsyncEntry, 'function');
  const probe = await createKeyStore({ backend: 'os', service: `${SERVICE}-test` }).probe();
  if (process.platform === 'linux') assert.ok(probe.ok || probe.code === 'no_secret_service', JSON.stringify(probe));
  else assert.deepEqual(probe, { ok: true });
});

test('keystore: the real OS keychain (opt-in: NQA_TEST_REAL_KEYCHAIN=1)', { skip: process.env.NQA_TEST_REAL_KEYCHAIN === '1' ? false : 'set NQA_TEST_REAL_KEYCHAIN=1 to touch the real keychain' }, async () => {
  const ks = createKeyStore({ backend: 'os', service: `${SERVICE}-test` });
  const probe = await ks.probe();
  if (!probe.ok) { assert.equal(process.platform, 'linux', `probe failed: ${probe.code}`); return; }
  try {
    await ks.set('anthropic', CANARY_KEYS.anthropic);
    assert.equal(await ks.get('anthropic'), CANARY_KEYS.anthropic);
    assert.deepEqual(await ks.list(['anthropic']), ['anthropic']);
  } finally {
    await ks.delete('anthropic');
  }
  assert.equal(await ks.get('anthropic'), null);
});

// D-06: keys an earlier alpha build saved under the service "NeverQuestAlone" move to "NeverQuestAlone"
// once: read, write, delete; a key already under the new name wins; the first refusal stops it
// (the player is asked at most once), and nothing ever reaches the log.
