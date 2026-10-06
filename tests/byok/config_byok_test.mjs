// The config and folders (bridge/config.mjs, bridge/byok/paths.mjs; public BYOK PRD §8.1, §9.4,
// §13.1, §11.1, RT-9, SL-6): the defaults (the byok section's, and no WoW folder, gateway or caps),
// loadConfig passing byok through, saveConfig atomic and 0600, the per-OS folders, and the lock files.
// Temp folders only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, loadConfigOrReset, saveConfig, configWithDefaults, migrateByokCaps, migrateLegacyProvider, LEGACY_CUSTOM, DEFAULTS } from '../../bridge/config.mjs';
import { publicPaths, lockFileFor, PRODUCT_DIR } from '../../bridge/byok/paths.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bones-cfg-'));

test('config: the byok section carries the PRD defaults (DB7, DB8, DB14, DB22, RT-6)', () => {
  const b = DEFAULTS.byok;
  assert.equal(b.provider, 'anthropic', 'no AI chosen yet: Claude with no key, so setup opens on its first screen');
  assert.equal(b.model, null, 'the manifest\'s pinned model');
  assert.equal(b.effort, 'low', 'DB22');
  assert.equal(b.persona.name, 'NeverQuestAlone');
  assert.deepEqual(b.caps, { dailyUsd: null }, 'no limits of the build\'s own (the owner, 2026-09-26): no spend cap unless the player sets one');
  assert.deepEqual(b.privacy, { identity: false, otherNames: false, companion: false, echo: false, gameContext: true }, 'automatic turns off until the player opts in');
  assert.equal(b.transcripts.retentionDays, 30);
  assert.equal(b.dataFile, undefined, 'no signed data file: manifests and prices ship with the app');
  assert.equal(b.extraHosts, undefined, 'no "allow a host": local models are loopback only (D6)');
});

test('config: the defaults are the product\'s: no backend key (there is one), no WoW folder, no gateway or owner, no daily or zone caps, the player\'s effort', () => {
  assert.equal(DEFAULTS.backend, undefined);
  assert.deepEqual(DEFAULTS.wow, { flavorDir: null, account: '' }, 'no folder is a default: the app finds one, the command line is told');
  assert.equal(DEFAULTS.gateway, undefined);
  assert.equal(DEFAULTS.owner, undefined);
  assert.deepEqual(DEFAULTS.transport, { slots: 200, deflate: true });
  // Code health BR-28: no knob nothing reads (logLevel), no default thinking level (a turn runs at the
  // player's effort unless its chat says), and the privacy switches only in byok.privacy (companion, no
  // daily or zone cap: the owner, 2026-09-26; game context).
  for (const k of ['logLevel', 'sessions', 'gameContext', 'companion']) assert.equal(Object.hasOwn(DEFAULTS, k), false, k);
  assert.deepEqual(DEFAULTS.byok.privacy, { identity: false, otherNames: false, companion: false, echo: false, gameContext: true });
});

test('code health BR-28: an old config.json\'s logLevel, sessions, gameContext and companion load to nothing; saving keeps them in the file, unread', () => {
  const dir = tmp();
  const f = path.join(dir, 'config.json');
  const old = { logLevel: 'debug', sessions: { thinking: 'high', labels: { main: 'NeverQuestAlone' } }, gameContext: false, companion: { enabled: true, maxTurnsPerDay: 3 },
    byok: { provider: 'anthropic', privacy: { companion: false, gameContext: true } } };
  fs.writeFileSync(f, JSON.stringify(old));
  for (const c of [loadConfig(f), configWithDefaults(loadConfig(f))]) {
    for (const k of ['logLevel', 'sessions', 'gameContext', 'companion']) assert.equal(Object.hasOwn(c, k), false, k);
    assert.deepEqual([c.byok.privacy.companion, c.byok.privacy.gameContext], [false, true], 'the switches are the privacy section\'s');
  }
  saveConfig({ byok: loadConfig(f).byok }, f);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual([saved.logLevel, saved.sessions, saved.gameContext, saved.companion], [old.logLevel, old.sessions, old.gameContext, old.companion], 'a file keeps what it had');
});

test('loadConfig passes byok through, merged over the defaults; other sections as before', () => {
  const dir = tmp();
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ backend: 'byok', byok: { provider: 'anthropic', caps: { v: 2, dailyUsd: 2.5 }, privacy: { companion: true } }, wow: { flavorDir: '/x/_forever_' } }));
  const c = loadConfig(f);
  assert.equal(c.backend, undefined, 'a file\'s backend key is read by nothing');
  assert.equal(c.byok.provider, 'anthropic');
  assert.deepEqual(c.byok.caps, { v: 2, dailyUsd: 2.5 });
  assert.equal(c.byok.privacy.companion, true);
  assert.equal(c.byok.privacy.gameContext, true);
  assert.equal(c.companion, undefined, 'the core reads byok.privacy itself (code health BR-28)');
  const none = loadConfig(path.join(dir, 'missing.json'));
  assert.equal(none.byok.provider, 'anthropic');
  const c2 = configWithDefaults({ byok: { provider: 'ollama' } });
  assert.equal(c2.byok.provider, 'ollama');
  c2.byok.caps.dailyUsd = 99;
  assert.equal(DEFAULTS.byok.caps.dailyUsd, null, 'a fresh copy: changing it never changes the defaults');
});

test('migrateByokCaps (spec §9.9, PRD §9.4): a section with no v: 2 loses typedPerDay, autoPerDay and the old $1.00 default; any other amount the player chose stays; then v: 2 (the owner, 2026-09-26)', () => {
  // The capped build pre-filled $1.00 and saved the whole byok section on any change, so a $1.00
  // there is the old default: dropped. Any other amount the player typed, so it stays, $0 included.
  assert.deepEqual(migrateByokCaps({ dailyUsd: 1, typedPerDay: 200, autoPerDay: 20 }), { v: 2, dailyUsd: null });
  assert.deepEqual(migrateByokCaps({ dailyUsd: 5, typedPerDay: 50, autoPerDay: 5 }), { v: 2, dailyUsd: 5 });
  assert.deepEqual(migrateByokCaps({ dailyUsd: 0.5, typedPerDay: 200, autoPerDay: 20 }), { v: 2, dailyUsd: 0.5 });
  assert.deepEqual(migrateByokCaps({ dailyUsd: 0, typedPerDay: 200, autoPerDay: 20 }), { v: 2, dailyUsd: 0 }, 'a $0 limit was the player\'s too');
  assert.deepEqual(migrateByokCaps({ dailyUsd: 3, setBy: 'app' }), { v: 2, dailyUsd: 3 }, 'any amount but the old default stays, whatever else the section says');
  // A section with v: 2 is as the player left it: a $1.00 there is one they set.
  assert.deepEqual(migrateByokCaps({ v: 2, dailyUsd: 1 }), { v: 2, dailyUsd: 1 });
  assert.deepEqual(migrateByokCaps({ v: 2, dailyUsd: null }), { v: 2, dailyUsd: null });
  assert.deepEqual(migrateByokCaps(migrateByokCaps({ dailyUsd: 2.5, typedPerDay: 200 })), { v: 2, dailyUsd: 2.5 }, 'runs once: the result migrates to itself');
  // A build between the two marked the player's own with setBy: 'player': kept, $1.00 included.
  assert.deepEqual(migrateByokCaps({ dailyUsd: 1, setBy: 'player' }), { v: 2, dailyUsd: 1 });
  assert.deepEqual(migrateByokCaps({ dailyUsd: null, setBy: 'player' }), { v: 2, dailyUsd: null });
  for (const bad of [{ dailyUsd: -1 }, { dailyUsd: '5' }, { dailyUsd: Infinity, v: 2 }, { dailyUsd: -1, setBy: 'player' }, null, undefined, 'x', []]) {
    assert.deepEqual(migrateByokCaps(bad), { v: 2, dailyUsd: null }, JSON.stringify(bad));
  }
  assert.deepEqual(migrateByokCaps({ perTurnInput: 30000, perTurnOutput: -1 }), { v: 2, dailyUsd: null, perTurnInput: 30000 }, 'the per-turn ceiling is kept when valid');
  // Through loadConfig and configWithDefaults as boot does it: the old saved section loses its $1.00.
  // The defaults carry no v: 2, so an old section merged with them never passes for a migrated one.
  assert.equal(Object.hasOwn(DEFAULTS.byok.caps, 'v'), false);
  const dir = tmp();
  const f = path.join(dir, 'config.json');
  fs.writeFileSync(f, JSON.stringify({ backend: 'byok', byok: { provider: 'anthropic', caps: { dailyUsd: 1, typedPerDay: 200, autoPerDay: 20 } } }));
  assert.deepEqual(migrateByokCaps(configWithDefaults(loadConfig(f)).byok.caps), { v: 2, dailyUsd: null });
  fs.writeFileSync(f, JSON.stringify({ backend: 'byok', byok: { provider: 'anthropic', caps: { dailyUsd: 3, typedPerDay: 200, autoPerDay: 20 } } }));
  assert.deepEqual(migrateByokCaps(configWithDefaults(loadConfig(f)).byok.caps), { v: 2, dailyUsd: 3 });
});

test('saveConfig: atomic, 0600, keeps the file\'s other keys, writes wow and byok (never a key)', () => {
  const dir = tmp();
  const f = path.join(dir, 'sub', 'config.json');
  fs.mkdirSync(path.dirname(f));
  fs.writeFileSync(f, JSON.stringify({ capture: { intervalMs: 500 }, sessions: { thinking: 'high' }, wow: { account: 'ACCT' } }));
  const c = configWithDefaults({ wow: { flavorDir: '/games/_forever_' }, byok: { provider: 'xai' } });
  saveConfig({ wow: c.wow, byok: c.byok }, f);
  const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(saved.capture.intervalMs, 500, 'untouched sections stay');
  assert.equal(saved.sessions.thinking, 'high');
  assert.equal(saved.wow.flavorDir, '/games/_forever_');
  assert.equal(saved.byok.provider, 'xai');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['config.json'], 'no temp file left behind');
  const fresh = path.join(dir, 'new', 'config.json');
  saveConfig({ byok: { provider: 'anthropic' } }, fresh);
  assert.equal(JSON.parse(fs.readFileSync(fresh, 'utf8')).byok.provider, 'anthropic');
  assert.throws(() => { fs.writeFileSync(f, '{broken'); saveConfig({ byok: {} }, f); }, /config\.json/);
});

test('a config.json that can\'t be read (SY-12): the app moves it aside and starts on the defaults; loadConfig (the developer command line\'s) refuses it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bones-cfg-'));
  const f = path.join(dir, 'config.json');
  for (const [i, text] of ['{"byok": {"provider": "openai"', 'null', '[1,2]'].entries()) {
    fs.writeFileSync(f, text);
    assert.throws(() => loadConfig(f), /config\.json/, `loadConfig refuses ${text}`);
    const r = loadConfigOrReset(f, { now: () => 1000 + i });
    assert.deepEqual(r.config, loadConfig(path.join(dir, 'none.json')), 'the defaults');
    assert.equal(r.reset.keptAs, `${f}.corrupt-${1000 + i}`);
    assert.equal(fs.readFileSync(r.reset.keptAs, 'utf8'), text, 'kept, never overwritten');
    assert.equal(fs.existsSync(f), false);
  }
  saveConfig({ byok: { provider: 'anthropic' } }, f);
  assert.deepEqual(loadConfigOrReset(f).reset, null, 'a good file is read as is');
  assert.equal(loadConfigOrReset(f).config.byok.provider, 'anthropic');
});

test('publicPaths: macOS, Windows and Linux folders (separate from "nqa"), named after the app\'s identity', () => {
  const { productName: P, name: L } = IDENTITY; // macOS and Windows: the product name; Linux: the package name
  assert.equal(PRODUCT_DIR, P);
  const mac = publicPaths({ platform: 'darwin', home: '/Users/p', env: {} });
  assert.equal(mac.config, `/Users/p/Library/Application Support/${PRODUCT_DIR}`);
  assert.equal(mac.configFile, `/Users/p/Library/Application Support/${PRODUCT_DIR}/config.json`);
  assert.equal(mac.data, mac.config);
  assert.equal(mac.bridgeState, `/Users/p/Library/Application Support/${PRODUCT_DIR}/bridge`);
  assert.equal(mac.logs, `/Users/p/Library/Logs/${PRODUCT_DIR}`);
  assert.equal(mac.control, undefined, 'no control pipe (systems plan D6)');

  const win = publicPaths({ platform: 'win32', home: 'C:\\Users\\p', env: { APPDATA: 'C:\\Users\\p\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\p\\AppData\\Local' } });
  assert.equal(win.config, `C:\\Users\\p\\AppData\\Roaming\\${P}`);
  assert.equal(win.logs, `C:\\Users\\p\\AppData\\Local\\${P}\\logs`);
  const winNoEnv = publicPaths({ platform: 'win32', home: 'C:\\Users\\p', env: { APPDATA: 'relative' } });
  assert.equal(winNoEnv.config, `C:\\Users\\p\\AppData\\Roaming\\${P}`, 'a relative APPDATA is ignored');

  const lin = publicPaths({ platform: 'linux', home: '/home/p', env: { XDG_CONFIG_HOME: '/home/p/.cfg', XDG_STATE_HOME: '/home/p/.st' } });
  assert.equal(lin.config, `/home/p/.cfg/${L}`);
  assert.equal(lin.state, `/home/p/.st/${L}`);
  assert.equal(lin.data, lin.state);
  assert.equal(lin.logs, `/home/p/.st/${L}/logs`);
  const linDefault = publicPaths({ platform: 'linux', home: '/home/p', env: {} });
  assert.equal(linDefault.config, `/home/p/.config/${L}`);
  assert.equal(linDefault.state, `/home/p/.local/state/${L}`);
});

test('the lock file: one per AddOns folder', () => {
  const a = lockFileFor('/s', '/games/wow/_forever_/Interface/AddOns', 'darwin');
  assert.match(a, /^\/s\/bridge-[0-9a-f]{16}\.lock$/);
  assert.equal(lockFileFor('/s', '/GAMES/wow/_forever_/Interface/AddOns', 'darwin'), a, 'macOS folders compare without case');
  assert.notEqual(lockFileFor('/s', '/games/wow/_classic_beta_/Interface/AddOns', 'darwin'), a);
});

test('migrateLegacyProvider: OpenRouter, Ollama and LM Studio as Other with their address; OpenRouter only with a key; anything else as it was', () => {
  const or = migrateLegacyProvider({ provider: 'openrouter', model: 'meta-llama/llama-4-scout:free', auth: 'oauth', authBy: { openrouter: 'oauth', anthropic: 'key' }, terms: { openrouter: { v: 1 }, anthropic: { v: 1 } }, keyState: { openrouter: { state: 'no_credit' } }, effort: 'low' }, { openRouterKey: true });
  assert.equal(or.from, 'openrouter');
  assert.deepEqual(or.byok, {
    provider: 'custom', model: 'meta-llama/llama-4-scout:free', auth: 'key', effort: 'low',
    authBy: { anthropic: 'key' }, terms: { anthropic: { v: 1 } }, keyState: {},
    custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-4-scout:free' },
  });
  assert.deepEqual(migrateLegacyProvider({ provider: 'openrouter', model: null }, { openRouterKey: true }).byok.custom, { baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free' }, 'the old default model');
  const none = migrateLegacyProvider({ provider: 'openrouter', model: null });
  assert.deepEqual([none.from, none.byok.provider, none.byok.model, none.byok.custom], ['openrouter', DEFAULTS.byok.provider, null, undefined], 'the old no-key default: no key, no Other');
  assert.deepEqual(migrateLegacyProvider({ provider: 'ollama', model: null }).byok.custom, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' });
  assert.deepEqual(migrateLegacyProvider({ provider: 'ollama', model: 'granite4.1:8b' }).byok.custom, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'granite4.1:8b' });
  assert.deepEqual(migrateLegacyProvider({ provider: 'lmstudio', model: 'qwen/qwen3-8b' }).byok.custom, { baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen/qwen3-8b' });
  for (const b of [{ provider: 'anthropic', model: 'claude-haiku-4-5' }, { provider: 'custom', custom: { baseUrl: 'https://x.example/v1', model: 'm' } }, {}, null]) {
    const r = migrateLegacyProvider(b);
    assert.equal(r.from, null);
    assert.deepEqual(r.byok, b ?? {});
  }
  assert.deepEqual(Object.keys(LEGACY_CUSTOM), ['openrouter', 'ollama', 'lmstudio']);
});
