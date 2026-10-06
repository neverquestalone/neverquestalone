// Patch day (systems critic SY-29): World of Warcraft updates, its interface number moves past the
// one the installed addon's TOCs name, and the game won't load an addon it calls out of date. The
// app notices (the install's .build.info at start, at the game's launch and exit, at each hello and,
// while WoW is closed, at the slow check), sets the TOCs' Interface line to the game's number, and
// says so: a line in the window and, while a WoW that read the old files runs, a notification that
// names the one action (restart WoW). When it can't write them, the addon's own line in game names
// the fix. Temp folders stand in for the game; nothing here touches a real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  clientFits, clientInterface, installedInterfaces, retargetAddon, installAddon, findWow, stampToc, ADDON_SOURCE, PUBLIC_NOTES,
} from '../../bridge/byok/wow.mjs';
import { createPatchDay } from '../../bridge/byok/patchday.mjs';
import { createBridge } from '../../bridge/service.mjs';
import { installSlots, slotToc } from '../../bridge/transport/slots.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { bootByok } from '../../bridge/byok/boot.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { statusView, PATCH_WORDS } from '../../bridge/byok/status-view.mjs';
import { tmpDir, waitFor } from './helpers/byok-env.mjs';

const NO_LINKS = process.platform === 'win32' ? 'a link planted in the AddOns folder is TH12\'s POSIX case (a symlink on Windows takes an administrator or Developer Mode)' : false;
const buildInfo = version => [
  'Branch!STRING:0|Active!DEC:1|Build Key!HEX:16|CDN Key!HEX:16|Install Key!HEX:16|IM Size!DEC:4|CDN Path!STRING:0|CDN Hosts!STRING:0|CDN Servers!STRING:0|Tags!STRING:0|Armadillo!STRING:0|Last Activated!STRING:0|Version!STRING:0|KeyRing!HEX:16|Product!STRING:0',
  `us|1|aa|bb|cc||tpr/wow|h|s|t|||${version}||wow_forever`,
].join('\n');
const iface = file => /^## Interface: (.*)$/m.exec(fs.readFileSync(file, 'utf8'))?.[1];
const NO_PLIST = () => ({ status: 1, stdout: '' });

/** A WoW install with the app's addon in it (3 slots), its .build.info at `version`. */
function gameWith(version = '1.60.1.70009', { slots = 3 } = {}) {
  const root = tmpDir('bones-patch-');
  const flavorDir = path.join(root, 'World of Warcraft', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  fs.writeFileSync(path.join(root, 'World of Warcraft', '.build.info'), buildInfo(version));
  const r = installAddon({ flavorDir, running: false, slots, run: NO_PLIST });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  const addons = path.join(flavorDir, 'Interface', 'AddOns');
  return { root, flavorDir, addons, update: v => fs.writeFileSync(path.join(root, 'World of Warcraft', '.build.info'), buildInfo(v)),
    tocs: () => [path.join(addons, 'NeverQuestAlone', 'NeverQuestAlone.toc'), ...[1, 2, 3].slice(0, slots).map(i => path.join(addons, `NQA_S00${i}`, `NQA_S00${i}.toc`))] };
}

// ---------------------------------------------------------------- wow.mjs

test('clientFits: the same major version; in _forever_ any line of it (a newer one is patch day), elsewhere only the TOC\'s line or a newer one', () => {
  assert.equal(clientFits('16100', '16001'), true, 'Forever 1.61 against a 1.60 TOC: patch day');
  assert.equal(clientFits('16002', '16001'), true, 'a patch of the same line');
  assert.equal(clientFits('16001', '16100'), true, 'a game not yet updated to the line a newer app targets');
  assert.equal(clientFits('110205', '16001'), false, 'a retail-engine client');
  assert.equal(clientFits('16100', '16001', '_classic_beta_'), true);
  assert.equal(clientFits('11507', '16001', '_classic_beta_'), false, 'Classic Era\'s beta');
  assert.equal(clientFits('16001', '16100', '_classic_beta_'), false);
  assert.equal(clientFits(null, '16001'), false);
});

test('findWow still finds a Forever install a patch moved to a newer line (it skipped it before, so patch day hid the game)', () => {
  const g = gameWith('1.60.1.70009');
  g.update('1.61.0.71000');
  const found = findWow({ platform: process.platform, roots: [path.dirname(g.flavorDir)], run: NO_PLIST });
  assert.deepEqual(found.map(w => [w.flavorDir, w.version, w.iface]), [[g.flavorDir, '1.61.0.71000', '16100']]);
});

test('clientInterface: the install\'s .build.info; on macOS the client app\'s Info.plist (PlistBuddy, an argument list) when asked; else nothing', () => {
  const g = gameWith('1.61.0.71000');
  assert.deepEqual(clientInterface(g.flavorDir, { run: NO_PLIST }), { iface: '16100', version: '1.61.0.71000', from: 'build.info' });
  fs.rmSync(path.join(g.root, 'World of Warcraft', '.build.info'));
  fs.mkdirSync(path.join(g.flavorDir, 'World of Warcraft Classic.app'), { recursive: true });
  const calls = [];
  const plist = (cmd, argv) => { calls.push([cmd, argv]); return { status: 0, stdout: '1.61.1\n' }; };
  assert.deepEqual(clientInterface(g.flavorDir, { platform: 'darwin', run: plist }), { iface: '16101', version: '1.61.1', from: 'app' });
  assert.equal(calls[0][0], '/usr/libexec/PlistBuddy');
  assert.equal(clientInterface(g.flavorDir, { platform: 'darwin', run: plist, plist: false }), null, 'the slow check never spawns');
  assert.equal(clientInterface(g.flavorDir, { platform: 'win32', run: plist }), null);
});

test('the install writes the game\'s own interface number into every TOC, the addon\'s too, so a newer client loads it; the rest of the TOC is the stamp\'s', () => {
  const g = gameWith('1.61.0.71000');
  for (const f of g.tocs()) assert.equal(iface(f), '16100', f);
  const installed = fs.readFileSync(g.tocs()[0], 'utf8');
  const stamped = stampToc(fs.readFileSync(path.join(ADDON_SOURCE, 'NeverQuestAlone.toc'), 'utf8'));
  assert.equal(installed, stamped.replace(/^## Interface: .*$/m, '## Interface: 16100'), 'only the Interface line differs from the release zip\'s stamp');
  assert.deepEqual(installedInterfaces(g.addons), { addon: '16100', slot: '16100' });
});

test('one install path writes each TOC once, the product\'s words and the game\'s number together (the integration merge: SY-29 with main 0.5.3\'s TOCs), and patch day then changes only the number', () => {
  const g = gameWith('1.61.0.71000');
  const [addonToc, ...slots] = g.tocs();
  const text = fs.readFileSync(addonToc, 'utf8');
  const field = k => new RegExp(`^## ${k}:[ \\t]*(.*)$`, 'm').exec(text)?.[1];
  // One build (2026-09-29): no X-Backend line; the TOC is the repo's with the game's number.
  assert.deepEqual([field('Interface'), field('Title'), field('X-Backend'), field('Notes')], ['16100', 'NeverQuestAlone', undefined, PUBLIC_NOTES]);
  // Each slot TOC is slotToc's with the game's number: its title and notes, the parts' Category, its own
  // Group and the addon's icon (E-047), never the older public words.
  slots.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), slotToc(i + 1, '16100'), f));
  // The next patch day: the number moves, the words stay.
  g.update('1.62.0.72000');
  assert.deepEqual(retargetAddon({ addonsDir: g.addons, iface: '16200' }), { changed: 4, kept: 0, errors: 0 });
  assert.equal(fs.readFileSync(addonToc, 'utf8'), text.replace('## Interface: 16100', '## Interface: 16200'));
  slots.forEach((f, i) => assert.equal(fs.readFileSync(f, 'utf8'), slotToc(i + 1, '16200'), f));
});

test('retargetAddon sets only the Interface line of the addon\'s TOC and every slot TOC (CRLF kept), and keeps what already says it', () => {
  const g = gameWith('1.60.1.70009');
  const before = g.tocs().map(f => fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(g.tocs()[2], before[2].replace(/\n/g, '\r\n')); // someone's editor
  const r = retargetAddon({ addonsDir: g.addons, iface: '16100' });
  assert.deepEqual(r, { changed: 4, kept: 0, errors: 0 });
  g.tocs().forEach((f, i) => {
    const want = before[i].replace('## Interface: 16001', '## Interface: 16100');
    assert.equal(fs.readFileSync(f, 'utf8'), i === 2 ? want.replace(/\n/g, '\r\n') : want, f);
  });
  assert.deepEqual(retargetAddon({ addonsDir: g.addons, iface: '16100' }), { changed: 0, kept: 4, errors: 0 });
  assert.equal(retargetAddon({ addonsDir: g.addons, iface: '1.61' }).error, 'bad_input');
  assert.deepEqual(fs.readdirSync(path.join(g.addons, 'NQA_S001')).sort(), ['Inbox.lua', 'NQA_S001.toc'], 'no temp file left');
});

test('retargetAddon never writes through a link planted in AddOns (TH12): that TOC is an error, the rest are set', { skip: NO_LINKS }, () => {
  const g = gameWith('1.60.1.70009');
  const elsewhere = tmpDir('bones-elsewhere-');
  fs.writeFileSync(path.join(elsewhere, 'NQA_S002.toc'), '## Interface: 16001\n');
  fs.rmSync(path.join(g.addons, 'NQA_S002'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(g.addons, 'NQA_S002'));
  const r = retargetAddon({ addonsDir: g.addons, iface: '16100' });
  assert.deepEqual(r, { changed: 3, kept: 0, errors: 1, error: 'not_a_folder' });
  assert.equal(fs.readFileSync(path.join(elsewhere, 'NQA_S002.toc'), 'utf8'), '## Interface: 16001\n', 'untouched');
});

// ---------------------------------------------------------------- patchday.mjs

function patchDay(g, over = {}) {
  const logs = [];
  const seen = [];
  const world = { running: false };
  const p = createPatchDay({
    flavorDir: g.flavorDir, addonsDir: g.addons, run: NO_PLIST, log: (k, d) => logs.push([k, d]),
    gameRunning: () => world.running, onChange: n => seen.push(n), ...over,
  });
  return { p, logs, seen, world };
}

test('in step, nothing is written or said; an update that lands while WoW is closed is taken at the slow check, with nothing owed (its next start reads the new TOCs)', () => {
  const g = gameWith('1.60.1.70009');
  const { p, logs, seen } = patchDay(g);
  assert.equal(p.check({ reason: 'start' }), null);
  p.tick();
  assert.deepEqual([logs.length, seen.length], [0, 0]);
  g.update('1.61.0.71000'); // Battle.net's update lands
  p.tick();
  assert.deepEqual(p.notice(), { from: '16001', to: '16100', version: '1.61.0.71000', at: p.notice().at, restart: false });
  for (const f of g.tocs()) assert.equal(iface(f), '16100');
  assert.deepEqual(logs.map(([k, d]) => [k, d.reason, d.changed, d.errors]), [['patch-day', 'tick', 4, 0]]);
  assert.equal(seen.length, 1, 'the window hears of it once');
  p.tick();
  p.gameUp();
  assert.equal(logs.length, 1, 'nothing more: in step');
});

test('an update found at the game\'s launch owes a restart (the game read the old TOCs) until the addon says hello or the game exits', () => {
  const g = gameWith('1.60.1.70009');
  const { p, world } = patchDay(g);
  g.update('1.61.0.71000');
  world.running = true;
  p.gameUp();
  assert.equal(p.notice().restart, true);
  p.heard('16100'); // it loaded anyway ("Load out of date AddOns"): nothing owed
  assert.equal(p.notice().restart, false);
  // Again, and this time the game quits without a hello.
  const h = gameWith('1.60.1.70009');
  const q = patchDay(h);
  h.update('1.61.0.71000');
  q.world.running = true;
  q.p.check({ reason: 'start' }); // the app started with WoW already running
  assert.equal(q.p.notice().restart, true);
  q.world.running = false;
  q.p.gameDown();
  assert.equal(q.p.notice().restart, false);
  assert.equal(q.p.notice().to, '16100');
});

test('the install\'s files name the version, not a hello: a hello read from SavedVariables can be from before the update; with no files a hello\'s number is used', () => {
  const g = gameWith('1.61.0.71000');
  const { p } = patchDay(g);
  p.heard('16001'); // an old session's hello
  for (const f of g.tocs()) assert.equal(iface(f), '16100', 'not set back');
  fs.rmSync(path.join(g.root, 'World of Warcraft', '.build.info'));
  const bare = gameWith('1.60.1.70009');
  fs.rmSync(path.join(bare.root, 'World of Warcraft', '.build.info'));
  const b = patchDay(bare);
  b.p.heard('16100');
  assert.equal(iface(bare.tocs()[0]), '16100');
  assert.deepEqual([b.p.notice().to, b.p.notice().restart], ['16100', false], 'its own hello: it runs');
});

test('a TOC that can\'t be written: failed (the window names the fix, the slot carries bridge.patch), retried at every check until it works', { skip: NO_LINKS }, () => {
  const g = gameWith('1.60.1.70009');
  const elsewhere = tmpDir('bones-elsewhere-');
  fs.rmSync(path.join(g.addons, 'NQA_S003'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(g.addons, 'NQA_S003'));
  const { p, logs } = patchDay(g);
  g.update('1.61.0.71000');
  p.tick();
  assert.equal(p.notice().failed, true);
  assert.equal(p.notice().error, 'not_a_folder');
  p.tick(); // .build.info unchanged, but a retarget is owed
  assert.equal(logs.length, 2);
  // The player reinstalls (the app's install removes the link): the next check finds everything in step.
  fs.rmSync(path.join(g.addons, 'NQA_S003'));
  assert.equal(installAddon({ flavorDir: g.flavorDir, running: false, slots: 3, run: NO_PLIST }).ok, true);
  p.tick();
  assert.equal(p.notice(), null, 'fixed some other way: nothing left to say');
});

// ---------------------------------------------------------------- the words

test('the window\'s line: the update said once, "Restart WoW to load it." only while a WoW that read the old files runs, the fix when the files couldn\'t be written', () => {
  const view = (wow) => statusView({ backend: { rt: { state: 'ready' } }, wow }).gameUpdate;
  assert.equal(view({ found: true, running: false }), null);
  assert.deepEqual(view({ running: false, patch: { to: '16100', restart: true } }), { state: 'ok', id: '16100:ok', ok: true, headline: PATCH_WORDS.updated, to: '16100' });
  assert.deepEqual(view({ running: true, patch: { to: '16100', restart: true } }), { state: 'restart', id: '16100:restart', ok: false, headline: PATCH_WORDS.updated, detail: 'Restart WoW to load it.', to: '16100' });
  assert.equal(view({ running: true, patch: { to: '16100', restart: false } }).state, 'ok', 'the addon said hello: it runs');
  assert.equal(view({ running: true, patch: { to: '16100', restart: false, failed: true } }).detail, 'Quit WoW, and NeverQuestAlone tries again.');
  assert.equal(view({ running: false, patch: { to: '16100', restart: false, failed: true } }).detail, 'In Settings, click Show more, then Run setup again.');
  assert.equal(PATCH_WORDS.updated, 'NeverQuestAlone updated the addon for the new version of World of Warcraft.');
  const needs = wow => statusView({ backend: { rt: { state: 'ready' } }, wow }).needsPlayer;
  assert.deepEqual([needs({ running: true, patch: { to: '16100', restart: true } }), needs({ running: false, patch: { to: '16100', restart: true } })], [true, false]);
  // STYLE: curly apostrophes in the app, sentences that end with a period, no plumbing words.
  for (const w of Object.values(PATCH_WORDS)) {
    assert.match(w, /^[A-Z].*\.$/);
    assert.doesNotMatch(w, /'|\b(TOC|interface|slot|bridge|backend)\b/i, w);
  }
});

// ---------------------------------------------------------------- the core

function coreWith(deps = {}) {
  const root = tmpDir('bones-patch-core-');
  const addons = path.join(root, 'AddOns');
  installSlots(addons, { count: 3, iface: '16001' });
  fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true });
  const warns = [];
  const bridge = createBridge({ transport: { slots: 3 }, sessions: { labels: { main: 'NeverQuestAlone' } } }, {
    stateDir: path.join(root, 'state'), addonsDir: addons, log: (k, d) => { if (k === 'version-warn') warns.push(d.warn); },
    slotInterface: () => '16001',
    gatewayFactory: handlers => ({
      kind: 'byok',
      persona: 'NeverQuestAlone',
      start() { handlers.onState({ state: 'ready', since: Date.now() }); handlers.onReady(); },
      stop() {},
      send: args => ({ runId: args.idem, status: 'started' }),
      outcomes: ids => ids.map(runId => ({ runId, state: 'running' })),
    }),
    ...deps,
  });
  return { bridge, warns };
}
const HELLO = (iface) => encodeRecord({ token: '3fa9c2d1', key: 'a3f1', type: 'hello', args: { cur: 0, ver: '1.5.3', build: '71000', iface, n: 0, ctx: 0, sig: 'ok', slots: 3 } });

test('the core: a hello\'s interface goes to the host before the version check, the public build has no plumbing interface line, and bridge.patch says "failed" while the host says so', async (t) => {
  const heard = [];
  let state = null;
  const pub = coreWith({ onClientInterface: i => heard.push(i), patchState: () => state });
  pub.bridge.start();
  t.after(() => pub.bridge.stop());
  pub.bridge.handlePayload(HELLO('16100'), 'strip');
  assert.deepEqual(heard, ['16100']);
  assert.deepEqual(pub.warns, [], 'no "slot addons are for interface …" in the public build');
  assert.equal(pub.bridge.buildSlot().bridge.patch, undefined);
  state = 'failed';
  assert.equal(pub.bridge.buildSlot().bridge.patch, 'failed');
  state = 'anything else';
  assert.equal(pub.bridge.buildSlot().bridge.patch, undefined);
  // A host without the hook keeps the line.
  const oc = coreWith({});
  oc.bridge.start();
  t.after(() => oc.bridge.stop());
  oc.bridge.handlePayload(HELLO('16100'), 'strip');
  assert.match(oc.warns[0] ?? '', /slot addons are for interface 16001, the client is 16100/);
});

// ---------------------------------------------------------------- boot: the app's wiring

// The process list: WoW not running, or running as the test runner's parent (a live pid that isn't ours).
const RUNNING = cmd => (/pgrep$/.test(cmd) ? { status: 0, stdout: `${process.ppid}\n` }
  : /tasklist/i.test(cmd) ? { status: 0, stdout: `"WowClassicB.exe","${process.ppid}","Console","1","900,000 K"\r\n` } : { status: 1, stdout: '' });
async function bootOn(t, g, run) {
  const lines = [];
  const b = await bootByok({
    paths: { userData: path.join(g.root, 'ud') }, home: path.join(g.root, 'home'), env: {}, log: (k, d) => lines.push([k, d]),
    keystore: createKeyStore({ backend: 'memory' }), config: { wow: { flavorDir: g.flavorDir }, transport: { slots: 3 }, byok: { provider: 'anthropic' } },
    capture: false, egress: false, lockDir: path.join(g.root, 'locks'),
    backendOptions: { checks: { models: false } }, wow: { run, roots: [] },
  });
  t.after(() => b.stop());
  return { b, lines };
}

test('boot, WoW closed: the app started after an update landed sets the TOCs at once and says so, with nothing owed (the game\'s next start reads them); the slot carries no failure', async (t) => {
  const g = gameWith('1.60.1.70009');
  g.update('1.61.0.71000');
  const { b, lines } = await bootOn(t, g, NO_PLIST);
  for (const f of g.tocs()) assert.equal(iface(f), '16100', f);
  assert.ok(lines.some(([k, d]) => k === 'patch-day' && d.reason === 'start' && d.to === '16100'));
  // The process list says WoW isn't running: nothing is owed.
  await waitFor(() => b.bridge.status().game?.state === 'down', 3000, 'the process list\'s answer');
  const st = await b.api.status();
  assert.deepEqual(st.wow.patch, { to: '16100', version: '1.61.0.71000', restart: false });
  assert.deepEqual([st.view.gameUpdate.state, st.view.gameUpdate.ok, st.view.gameUpdate.headline, st.view.gameUpdate.detail], ['ok', true, PATCH_WORDS.updated, undefined]);
  assert.equal(b.bridge.buildSlot().bridge.patch, undefined);
});

test('boot, WoW running: the TOCs are set, and "Restart WoW to load it." (the tray\'s attention: the words test) until the addon says hello (it loaded after all)', async (t) => {
  const g = gameWith('1.60.1.70009');
  g.update('1.61.0.71000');
  const { b, lines } = await bootOn(t, g, RUNNING);
  await waitFor(() => b.bridge.status().game?.state === 'up', 3000, 'the process list finds WoW');
  let st = await b.api.status();
  assert.equal(st.wow.running, true);
  assert.deepEqual(st.wow.patch, { to: '16100', version: '1.61.0.71000', restart: true });
  assert.deepEqual([st.view.gameUpdate.state, st.view.gameUpdate.ok, st.view.gameUpdate.detail], ['restart', false, 'Restart WoW to load it.']);
  // The game loaded it anyway ("Load out of date AddOns"): its hello leaves nothing owed.
  b.bridge.handlePayload(HELLO('16100'), 'strip');
  await waitFor(async () => (await b.api.status()).wow.patch.restart === false, 2000, 'the hello settles it');
  st = await b.api.status();
  assert.deepEqual([st.view.gameUpdate.state, st.view.gameUpdate.ok], ['ok', true]);
  assert.equal(lines.filter(([k]) => k === 'patch-day').length, 1, 'set once');
});
