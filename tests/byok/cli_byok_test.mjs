// The developer command line (bridge/nqa.mjs): the product's installer and its service, headless on
// the BYOK backend, from a checkout. The real CLI in a child process with HOME, its data folder and the
// WoW folder in a temp folder; no capture, no key but a canary, and nothing sent anywhere (--no-checks,
// and no turn: the core's own publishes, its locks and its status are all this looks at).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockFileFor, publicPaths } from '../../bridge/byok/paths.mjs';
import { folderLockFile } from '../../bridge/byok/lock.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(REPO, 'bridge', 'nqa.mjs');
const CANARY = `sk-ant-api03-CANARY${'x'.repeat(80)}`; // gitleaks:allow (a fake key)
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(pred, ms = 8000, label = 'condition') {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await pred(); if (v) return v; await sleep(50); }
  throw new Error(`timed out waiting for ${label}`);
}

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bones-cli-'));
  const flavorDir = path.join(home, 'World of Warcraft', '_forever_');
  fs.mkdirSync(flavorDir, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, SystemRoot: process.env.SystemRoot, TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return { home, flavorDir, addonsDir: path.join(flavorDir, 'Interface', 'AddOns'), data: path.join(home, 'data'), env };
}
function run(sb, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env: { ...sb.env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('install: the product\'s addon, its slot folders and the doorbells into the named WoW folder, as the app installs them; nothing without a folder', (t) => {
  const sb = sandbox();
  t.after(() => fs.rmSync(sb.home, { recursive: true, force: true }));
  const none = run(sb, ['install', '--data', sb.data]);
  assert.equal(none.code, 2, none.out);
  assert.match(none.out, /Name the World of Warcraft flavor folder: --wow <folder>/);
  assert.equal(fs.existsSync(sb.addonsDir), false, 'nothing written without a folder');
  const r = run(sb, ['install', '--wow', sb.flavorDir, '--data', sb.data]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /New addon files only load after a full restart of World of Warcraft/);
  const toc = fs.readFileSync(path.join(sb.addonsDir, 'NeverQuestAlone', 'NeverQuestAlone.toc'), 'utf8');
  assert.match(toc, /^## Title: NeverQuestAlone$/m, 'the app\'s TOC: the product\'s Title');
  assert.doesNotMatch(toc, /X-Backend/, 'and no build\'s mark');
  assert.equal(fs.readdirSync(sb.addonsDir).filter(n => /^NQA_S\d{3}$/.test(n)).length, 200);
  assert.ok(fs.existsSync(path.join(sb.addonsDir, 'NeverQuestAlone', 'sig', 'ctl', 'present.wav')), 'the doorbells');
});

test('start: the service headless on the BYOK backend: it publishes, holds the folder\'s lock (its one lock: code health BR-27), writes its status, and lets go of it on SIGTERM; the key from NQA_API_KEY reaches neither the log nor the status', { skip: process.platform === 'win32' ? 'SIGTERM is a kill on Windows' : false }, async (t) => {
  const sb = sandbox();
  t.after(() => fs.rmSync(sb.home, { recursive: true, force: true }));
  const noAddon = run(sb, ['start', '--wow', sb.flavorDir, '--data', sb.data, '--no-capture']);
  assert.equal(noAddon.code, 2, noAddon.out);
  assert.match(noAddon.out, /No addon in .*: run node bridge\/nqa\.mjs install/);
  assert.equal(run(sb, ['install', '--wow', sb.flavorDir, '--data', sb.data]).code, 0);
  const child = spawn(process.execPath, [CLI, 'start', '--wow', sb.flavorDir, '--data', sb.data, '--no-capture', '--no-checks', '--provider', 'anthropic'],
    { env: { ...sb.env, NQA_API_KEY: CANARY }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const closed = new Promise(r => child.on('close', code => r(code)));
  const pub = publicPaths({ platform: process.platform, env: sb.env, home: sb.home });
  try {
    const inbox = path.join(sb.addonsDir, 'NQA_S001', 'Inbox.lua');
    await waitFor(() => fs.existsSync(inbox) && /Written by the NeverQuestAlone app/.test(fs.readFileSync(inbox, 'utf8')), 15000, `the first publish (${out})`);
    assert.match(fs.readFileSync(inbox, 'utf8'), /backend = "byok"/, 'the slot names the BYOK backend');
    assert.equal(JSON.parse(fs.readFileSync(folderLockFile(sb.addonsDir), 'utf8')).pid, child.pid, 'the folder\'s lock is its');
    assert.equal(fs.existsSync(lockFileFor(pub.state, sb.addonsDir)), false, 'and its state folder holds none');
    const status = JSON.parse(await waitFor(() => { try { return fs.readFileSync(path.join(sb.data, 'status.json'), 'utf8'); } catch { return null; } }, 5000, 'the status'));
    assert.equal(status.pid, child.pid);
    assert.equal(status.provider, 'anthropic');
    assert.equal(typeof status.bridge.version, 'string');
    assert.match(out, /Serving .* on anthropic; log /);
  } finally {
    child.kill('SIGTERM');
  }
  assert.equal(await closed, 0, out);
  assert.equal(fs.existsSync(folderLockFile(sb.addonsDir)), false, 'the folder\'s lock is let go');
  const logs = path.join(sb.data, 'logs');
  const logged = fs.readdirSync(logs).map(f => fs.readFileSync(path.join(logs, f), 'utf8')).join('\n');
  assert.ok(logged.length > 0, 'it logged');
  for (const text of [logged, fs.readFileSync(path.join(sb.data, 'status.json'), 'utf8'), out]) assert.ok(!text.includes('CANARY'), 'the key never shows');
  assert.match(run(sb, ['status', '--data', sb.data]).out, /NOT running/);
});

test('the verbs the app owns aren\'t here: key, login, usage and connections print the help and touch nothing', () => {
  const sb = sandbox();
  try {
    for (const verb of [['key', 'set', 'anthropic', '--stdin'], ['login', 'openrouter'], ['usage'], ['connections'], ['pair'], ['service', 'install'], ['setup']]) {
      const r = run(sb, verb);
      assert.equal(r.code, 0, `${verb[0]}: ${r.out}`);
      assert.match(r.out, /node bridge\/nqa\.mjs start --wow/, verb[0]);
      assert.doesNotMatch(r.out, /control pipe|Start NeverQuestAlone first/i, verb[0]);
    }
    const help = run(sb, ['help']).out;
    for (const gone of ['key set', 'login openrouter', 'connections', 'pair', 'service install', 'tunnel', 'gateway']) assert.ok(!help.includes(gone), gone);
    assert.deepEqual(fs.readdirSync(sb.home).sort(), ['World of Warcraft'], 'nothing written');
  } finally { fs.rmSync(sb.home, { recursive: true, force: true }); }
});
