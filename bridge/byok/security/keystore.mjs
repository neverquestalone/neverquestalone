// The key store (PRD §8.1 DB5, KY-2, KY-3, TH2/TH3): where provider keys live.
//
//   createKeyStore({ backend, service: 'NeverQuestAlone', platform })
//     → { backend, persistent, label, get(provider), set(provider, key),
//         delete(provider), list(providers?), probe() }
//
// Backends (two; the file stores and the old-name key migration are gone, systems plan D6):
//   'os'              the OS credential store through @napi-rs/keyring's
//                     AsyncEntry (service 'NeverQuestAlone', account '<provider>').
//                     Linux is pinned to the Secret Service; without one the
//                     binding throws and so do we, with code
//                     'no_secret_service' (fail closed: the caller keeps the
//                     key in a 'memory' store for this session and asks again
//                     next launch). Never keyutils: it forgets at reboot.
//   'memory'          this process only: boot's fallback when the OS store
//                     can't be used (Linux without a Secret Service, Windows
//                     without Credential Manager or its binding), and tests.
//
// Values never reach a log, an error message or list(): list() returns
// provider ids. maskKey() is the only way a key is ever shown ('sk-ant-…A1b2').
import { providerIds } from '../providers/index.mjs';
import { IDENTITY } from '../../identity.mjs';

/**
 * The service name keys are saved under: what the player sees in Keychain Access or Credential
 * Manager. The app's identity's (bridge/identity.mjs), so every app built from the shell has its own.
 */
export const SERVICE = IDENTITY.keychainService;
export const KEY_MAX = 1024; // Windows stores a string key as UTF-16 in 2,560 bytes (about 1,280 chars)
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function keyStoreError(code, message, cause) {
  const e = new Error(message, cause ? { cause } : undefined);
  e.code = code;
  return e;
}

function checkProvider(provider) {
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) throw keyStoreError('bad_provider', 'provider id must be lowercase letters, digits, - or _');
  return provider;
}

// Pasted keys often carry a trailing newline or spaces; anything inside the
// key that isn't printable ASCII is a paste accident, not a key.
export function normalizeKey(key) {
  if (typeof key !== 'string') throw keyStoreError('bad_key', 'the key must be text');
  const k = key.trim();
  if (!k) throw keyStoreError('bad_key', 'the key is empty');
  if (k.length > KEY_MAX) throw keyStoreError('bad_key', `the key is longer than ${KEY_MAX} characters`);
  if (!/^[\x21-\x7e]+$/.test(k)) throw keyStoreError('bad_key', 'the key has spaces or characters a key never has');
  return k;
}

const MASK_PREFIXES = ['sk-ant-', 'sk-or-', 'sk-proj-', 'sk-svcacct-', 'sk-admin-', 'xai-', 'AIza', 'AQ.', 'sk-'];

// 'sk-ant-api03-…xyz9A1b2' → 'sk-ant-…A1b2'. The last four only when at least
// 16 other characters stay hidden; never more than prefix + four.
export function maskKey(key) {
  if (typeof key !== 'string' || !key) return '…';
  const k = key.trim();
  const prefix = MASK_PREFIXES.find(p => k.startsWith(p)) || '';
  const tail = k.length >= prefix.length + 20 ? k.slice(-4) : '';
  return `${prefix}…${tail}`;
}

// ---- memory ------------------------------------------------------------------

function memoryBackend() {
  const map = new Map();
  return {
    persistent: false,
    label: 'this session only',
    get: async (p) => map.get(p) ?? null,
    set: async (p, k) => { map.set(p, k); },
    delete: async (p) => map.delete(p),
    has: async (p) => map.has(p),
    probe: async () => ({ ok: true }),
  };
}

// ---- os (@napi-rs/keyring) ----------------------------------------------------

// Tested in this order: a denied, dismissed or locked prompt reported over
// D-Bus is a refusal, not a missing Secret Service. NO_SERVICE_RE names only a
// Secret Service that isn't there (nothing owns org.freedesktop.secrets, or
// there's no session bus), not every error that mentions D-Bus.
const DENIED_RE = /denied|cancel|dismissed|\b(?:un)?locked\b|not allowed|user interaction|-25293|-128\b|errSecAuthFailed|authorization/i;
const NO_SERVICE_RE = /ServiceUnknown|NameHasNoOwner|org\.freedesktop\.secrets|no such name|no secret service|dbus session|DBUS_SESSION_BUS_ADDRESS|autolaunch/i;

function osBackend({ service, platform, keyring }) {
  let mod = keyring || null;
  const load = async () => {
    if (mod) return mod;
    try { mod = await import('@napi-rs/keyring'); } catch (e) { throw keyStoreError('keystore_unavailable', 'the OS credential store binding could not load on this system', e); }
    return mod;
  };
  const linux = platform === 'linux';
  const options = linux ? { linux: { store: 'secret-service' } } : undefined;
  const entry = async (provider) => {
    const { AsyncEntry } = await load();
    try { return new AsyncEntry(service, provider, options); } catch (e) {
      if (linux) throw keyStoreError('no_secret_service', 'no Secret Service is running (gnome-keyring, KWallet or KeePassXC); the key is kept for this session only', e);
      throw keyStoreError('keystore_unavailable', 'the OS credential store is not available', e);
    }
  };
  const mapOpError = (e) => {
    const msg = String(e?.message || e);
    if (DENIED_RE.test(msg)) return keyStoreError('keystore_denied', 'the OS credential store refused access (a denied prompt or a locked keychain)', e);
    if (linux && NO_SERVICE_RE.test(msg)) return keyStoreError('no_secret_service', 'the Secret Service stopped answering; the key is kept for this session only', e);
    return keyStoreError('keystore_unavailable', 'the OS credential store failed', e);
  };
  const run = async (provider, fn) => {
    const en = await entry(provider);
    try { return await fn(en); } catch (e) { throw mapOpError(e); }
  };
  return {
    persistent: true,
    label: platform === 'darwin' ? 'macOS Keychain' : platform === 'win32' ? 'Windows Credential Manager' : 'Secret Service',
    get: (p) => run(p, async en => (await en.getPassword()) ?? null),
    set: (p, k) => run(p, en => en.setPassword(k)),
    delete: (p) => run(p, en => en.deleteCredential()),
    has: (p) => run(p, async en => (await en.getPassword()) != null),
    probe: async () => {
      try { await entry('__probe__'); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
    },
  };
}

// ---- the store -------------------------------------------------------------------

export function createKeyStore({ backend = 'os', service = SERVICE, platform = process.platform, keyring, log } = {}) {
  let impl;
  if (backend === 'os') impl = osBackend({ service, platform, keyring });
  else if (backend === 'memory') impl = memoryBackend();
  else throw keyStoreError('bad_backend', `unknown key store backend: ${String(backend).slice(0, 40)}`);
  const note = (op, provider, extra) => { try { log?.('keystore', { op, provider, backend, ...extra }); } catch { /* logging never breaks the store */ } };
  return {
    backend,
    persistent: impl.persistent,
    label: impl.label,
    async get(provider) { return impl.get(checkProvider(provider)); },
    async set(provider, key) {
      checkProvider(provider);
      await impl.set(provider, normalizeKey(key));
      note('set', provider);
    },
    async delete(provider) {
      const gone = await impl.delete(checkProvider(provider));
      note('delete', provider, { deleted: !!gone });
      return !!gone;
    },
    // The ids (never the keys) of the providers in `providers` (default: every manifest's) that have one.
    async list(providers = providerIds()) {
      const out = [];
      for (const p of providers) if (await impl.has(checkProvider(p))) out.push(p);
      return out;
    },
    probe: () => impl.probe(),
  };
}
