#!/usr/bin/env node
// The developer command line: the product's own installer and service, from a checkout, with no app.
//
//   node bridge/nqa.mjs install --wow <flavor folder>
//       this checkout's addon, its 200 slot folders and the doorbells into <flavor folder>/Interface/AddOns,
//       as the desktop app installs them (bridge/byok/wow.mjs installAddon). World of Warcraft must be quit.
//   node bridge/nqa.mjs start --wow <flavor folder> [--data <folder>] [--provider <id>] [--model <id>] [--no-capture] [--no-checks]
//       the service, headless, on the BYOK backend: the app's own assembly (bridge/byok/boot.mjs) with a
//       key store in memory. The key comes from NQA_API_KEY (never saved or logged); without one, only a
//       local model (ollama, lmstudio) answers. The app's lock folder, so the app and this never serve one
//       AddOns folder at once. --no-checks skips the start-time model and balance checks (nothing is
//       asked of the AI until a turn). Ctrl-C (or SIGTERM) stops it.
//   node bridge/nqa.mjs status [--data <folder>]
//       what a running start last wrote (<data>/status.json).
//
// <data> (default: the app's data folder's dev/) holds this command line's config.json (the app's shape:
// wow, byok), the backend's transcripts, usage and ledger, the core's state and the logs. The verb is
// the first argument that isn't a flag; with none, this help.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, configWithDefaults } from './config.mjs';
import { createLogger } from './log.mjs';
import { publicPaths } from './byok/paths.mjs';
import { redact, guardCrashOutput } from './byok/security/redact.mjs';

const KEY_ENV = 'NQA_API_KEY';
const readKey = () => process.env[KEY_ENV] || null;

// Crash output goes through the redactor, with no environment in diagnostic reports (public PRD §8.4
// item 6).
guardCrashOutput({ secrets: () => [readKey()] });

const args = process.argv.slice(2);
const cmdAt = args.findIndex(a => !a.startsWith('-'));
const cmd = cmdAt >= 0 ? args[cmdAt] : 'help';
const has = f => args.includes(f);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

/** This command line's data folder: --data, else the app's data folder's dev/. */
function dataDir(given = opt('data')) {
  return path.resolve(given || path.join(publicPaths().data, 'dev'));
}

/**
 * The WoW flavor folder: --wow, else the one the data folder's config.json itself names. Never a
 * default: a folder nobody named may be a real game's (the retired build's default was one).
 */
function flavorDir(dir) {
  let named = null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    if (typeof raw?.wow?.flavorDir === 'string' && raw.wow.flavorDir) named = raw.wow.flavorDir;
  } catch { /* none */ }
  const d = opt('wow') || named;
  if (!d) fail(2, 'Name the World of Warcraft flavor folder: --wow <folder> (the one holding Interface/AddOns, e.g. .../World of Warcraft/_classic_beta_).');
  const abs = path.resolve(d);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) fail(2, `No World of Warcraft folder at ${abs}.`);
  return abs;
}

function fail(code, message) {
  console.error(message);
  process.exit(code);
}

function readConfig(dir) {
  try { return loadConfig(path.join(dir, 'config.json')); } catch (e) { return fail(2, redact(String(e?.message ?? e))); }
}

async function install() {
  const dir = dataDir();
  readConfig(dir); // a config.json that can't be read is said before anything is written
  const flavor = flavorDir(dir);
  const { installAddon } = await import('./byok/wow.mjs');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const r = installAddon({ flavorDir: flavor, configFile: path.join(dir, 'config.json') });
  for (const s of r.steps ?? []) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.error ? ` (${s.error})` : ''}`);
  if (!r.ok) fail(1, r.detail || `Install failed (${r.error}).`);
  console.log(`Installed into ${r.addonsDir} (interface ${r.iface}).${r.partsFold ? ` Parts row: ${r.partsFold}.` : ''}`);
  console.log(r.restartLine);
}

async function start() {
  const dir = dataDir();
  const saved = readConfig(dir);
  const flavor = flavorDir(dir);
  if (!fs.existsSync(path.join(flavor, 'Interface', 'AddOns', 'NeverQuestAlone', 'NeverQuestAlone.toc'))) {
    fail(2, `No addon in ${flavor}: run node bridge/nqa.mjs install --wow "${flavor}" first (with World of Warcraft quit).`);
  }
  const config = configWithDefaults(saved);
  config.wow = { ...(config.wow || {}), flavorDir: flavor };
  config.byok = { ...(config.byok || {}) };
  if (opt('provider')) config.byok.provider = opt('provider');
  if (opt('model')) config.byok.model = opt('model');
  if (has('--no-capture')) config.capture = { ...(config.capture || {}), enabled: false };

  const { createKeyStore } = await import('./byok/security/keystore.mjs');
  const keystore = createKeyStore({ backend: 'memory' });
  const key = readKey();
  if (key) {
    try { await keystore.set(config.byok.provider, key); } catch (e) { fail(2, `${KEY_ENV}: ${e.message}`); }
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = createLogger(path.join(dir, 'logs'), { echo: process.stdout.isTTY, secrets: [key] });
  const { bootByok } = await import('./byok/boot.mjs');
  let boot;
  try {
    boot = await bootByok({ paths: { userData: dir }, config, keystore, capture: !has('--no-capture'), log,
      ...(has('--no-checks') ? { backendOptions: { checks: { models: false } } } : {}) });
  } catch (e) {
    fail(e?.code === 'BRIDGE_RUNNING' ? 3 : 1, redact(String(e?.message ?? e), [key]));
  }
  if (!boot.bridge) {
    await boot.stop();
    fail(1, `The bridge didn't start for ${flavor} (see ${log.file()}).`);
  }
  const statusFile = path.join(dir, 'status.json');
  const writeStatus = () => {
    const s = { at: new Date().toISOString(), pid: process.pid, flavorDir: flavor, provider: config.byok.provider, bridge: boot.bridge?.status() ?? null, capture: boot.capture?.status?.() ?? null };
    try { fs.writeFileSync(statusFile, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); } catch { /* status is best effort */ }
  };
  writeStatus();
  const timer = setInterval(writeStatus, 10000);
  console.log(`Serving ${path.join(flavor, 'Interface', 'AddOns')} on ${config.byok.provider}${key ? '' : ` (no ${KEY_ENV}: a local model only)`}; log ${log.file()}. Ctrl-C stops it.`);
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log('stop', { signal });
    try { await boot.stop(); } catch (e) { console.error(redact(String(e?.message ?? e), [key])); }
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

function status() {
  const file = path.join(dataDir(), 'status.json');
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { console.log(`No status yet at ${file}: nothing has run there (node bridge/nqa.mjs start).`); return; }
  let alive = false;
  try { process.kill(s.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  const b = s.bridge || {};
  console.log(`bridge ${b.version ?? '?'}: ${alive ? `running (pid ${s.pid})` : 'NOT running'}; status ${Math.round((Date.now() - Date.parse(s.at)) / 1000)} s old`);
  console.log(`serving ${s.flavorDir} on ${s.provider}; backend ${b.gateway?.state ?? '?'}${b.gateway?.reason ? ` (${b.gateway.reason})` : ''}`);
  if (s.capture) console.log(`capture: ${s.capture.connected ? 'connected' : 'not connected'}`);
  console.log(`records: seq ${b.seq}, push ${b.push}; outbox ${b.outbox}; turns in flight ${b.inflight}; chats ${b.chats}`);
  if (b.token) console.log(`addon: token ${b.token.id}, v${b.token.ver || '?'}, cursor ${b.token.lastReported}`);
  if (b.warn) console.log(`WARNING: ${b.warn}`);
}

// The header's comment, as help.
function help() {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
  const end = lines.findIndex(l => !l.startsWith('//'));
  console.log(lines.slice(0, end).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

const commands = { install, start, status, help };
Promise.resolve().then(() => (commands[cmd] || help)()).catch((e) => { console.error(redact(e?.message ?? String(e), [readKey()])); process.exit(1); });
