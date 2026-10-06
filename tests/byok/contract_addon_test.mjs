// The slot contract end to end (BUILD-PLAN "Contract: what the addon reads"; public BYOK PRD §9.4,
// §9.5, §10, §13.1, §16.4 UX-1…UX-6, PR-1, TH13): the real bridge as the app boots it (boot.mjs:
// the core, the local backend behind withPrivacy, the app API) on a temp WoW folder with the addon
// installed, the providers' mock server on 127.0.0.1 with canary keys, and the real addon in its
// Lua VM on the other side. The addon's strip goes to the core as the capture helper hands it
// over; the slot files the core writes are loaded into the addon as the game loads them. Every
// assertion that matters is on what the addon then shows (its light, HUD, header, bubbles,
// companion switch and chat frame), not only on the slot's JSON. No real network, no real keys.
// On main's 0.4.4 widget (the consolidation's commit 3): the header is main's Thinking control,
// the usage line sits in the window's title row. No limits (commit 4): the runaway fuse as the
// bridge says it at 8f9c1c2 (bridge.usage.autoPaused, the auto_paused line, held events ride along).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { bootByok } from '../../bridge/byok/boot.mjs';
import { encodeRecord } from '../../bridge/transport/records.mjs';
import { COMPANION_CHAT } from '../../bridge/service.mjs';
import { AUTO_FUSE, autoPausedLine } from '../../bridge/byok/usage/fuse.mjs';
import { installAddon } from '../../bridge/byok/wow.mjs';
import { createKeyStore } from '../../bridge/byok/security/keystore.mjs';
import { newLuaVM } from '../helpers/luavm.mjs';
import { fixture } from './helpers/mock-provider.mjs';
import { startMock, reply, anthropicHead, manifestsAt, flatPrices, waitFor, tmpDir, CANARY_KEYS, NO_CHECKS } from './helpers/byok-env.mjs';

const require = createRequire(import.meta.url);
const { newVM } = require('../helpers/nqa-vm.js');

const TIMEOUTS = { firstTokenMs: 3000, idleMs: 3000, runMs: 8000, requestMs: 3000 };
const NOT_RUNNING = () => ({ status: 1, stdout: '' });
const quick = async (ms, signal) => !signal?.aborted; // retries without their wait
const fx = name => fixture('anthropic', name);
const posts = mock => mock.requests.filter(r => r.method === 'POST');
const lastWords = r => String(r.body?.messages?.at(-1)?.content ?? '');
const PRIVACY = Object.freeze({ identity: false, otherNames: false, companion: false, echo: false, gameContext: true });

/** An Anthropic reply whose stream names a dated alias of the model (what a provider may answer with). */
function aliasReply(text, alias, o = {}) {
  const r = reply(text, o);
  return { ...r, body: r.body.replace('"model":"claude-haiku-4-5"', `"model":"${alias}"`) };
}

// ---------------------------------------------------------------- the two sides

const slotFile = s => path.join(s.addons, 'NQA_S001', 'Inbox.lua');
const ctlDir = s => path.join(s.addons, 'NeverQuestAlone', 'sig', 'ctl');
const BELLS = ['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act'];
// The doorbells ring for 0.6 s here (3 s in game) and the game's clock runs 6 times the wall
// clock, so a pulse is 3.6 s of game time: longer than the addon's 2 s poll and under its 10 s
// "this bell is dead" limit, as a 3 s pulse is in game.
const SIGNAL_TIMINGS = Object.freeze({ pulseMs: { push: 600, alive: 600, act: 150 }, actGapMs: 150 });
const PACE = 6;
const list = v => (Array.isArray(v) ? v : []);
function parseSlot(text) {
  const lvm = newLuaVM();
  lvm.run(text);
  const d = lvm.global('NQA_SlotData');
  if (!d) return null;
  return { ...d, records: list(d.records), chats: list(d.chats), bridge: { ...d.bridge, caps: list(d.bridge?.caps), acked: list(d.bridge?.acked) } };
}
// The strip as the capture helper reads it, handed to the core when it changed.
function feed(s) {
  const st = s.vm.strip();
  if (st && st.payload !== s.fed) {
    s.fed = st.payload;
    s.b.bridge.handlePayload(st.payload, 'strip');
  }
}
// The files as the client sees them: the doorbells the bridge's signals make and delete
// (PlaySoundFile plays one that's there), and what a slot addon holds when LoadAddOn loads it (the
// slot file as it is then). The addon reads a slot only when it loads one, which it does when its
// push doorbell rings (C3 review: a publish that doesn't ring never reaches the game).
function mirror(s) {
  for (const f of BELLS) s.vm.signal('ctl', f, fs.existsSync(path.join(ctlDir(s), `${f}.wav`)));
  let text = '';
  try { text = fs.readFileSync(slotFile(s), 'utf8'); } catch { /* not written yet */ }
  if (text && text !== s.offered) { s.offered = text; s.vm.slotText(text); }
}
// One step of both sides: the files mirrored, the game's clock advanced (the addon polls its
// doorbells and loads a slot when one rang), the strip handed over.
function tick(s) {
  const t = Date.now();
  const dt = Math.min(0.5, Math.max(0.005, ((t - s.at) / 1000) * PACE));
  s.at = t;
  mirror(s);
  s.vm.advance(dt);
  const n = s.vm.loads();
  if (n !== s.loads) { s.loads = n; s.text = s.offered; }
  feed(s);
}
// What the addon last loaded, for this session's token (or null).
function loaded(s) {
  const d = s.text ? parseSlot(s.text) : null;
  return d && d.token === s.vm.evaluate('NQADB.token') ? d : null;
}
/** Both sides run until pred(the slot the addon last loaded) holds; returns that data. */
function sync(s, pred = () => true, label = 'the slot') {
  return waitFor(() => {
    tick(s);
    const d = loaded(s);
    return d && pred(d) ? d : null;
  }, 15000, label);
}

async function session(t, { handler = () => reply('Here.\n\nTL;DR: here.'), byok = {}, manifests = null, priceBook = null, keys = ['anthropic'], backendOptions = {}, timeouts = {} } = {}) {
  const mock = await startMock(r => handler(r));
  t.after(() => mock.close());
  const root = tmpDir('bones-contract-');
  const flavorDir = path.join(root, 'wow', '_forever_');
  fs.mkdirSync(path.join(flavorDir, 'Interface', 'AddOns'), { recursive: true });
  assert.equal(installAddon({ flavorDir, running: false, slots: 3 }).ok, true);
  const keystore = createKeyStore({ backend: 'memory' });
  for (const id of keys) await keystore.set(id, CANARY_KEYS[id]);
  const lines = [];
  const log = (kind, data) => lines.push({ kind, ...(data ?? {}) });
  const b = await bootByok({
    paths: { userData: path.join(root, 'ud') }, home: path.join(root, 'home'), env: {}, log, keystore,
    config: { wow: { flavorDir }, transport: { slots: 3 }, byok: { provider: 'anthropic', effort: 'low', privacy: { ...PRIVACY }, ...byok } },
    capture: false, selfTest: false, control: false, egress: false, lockDir: path.join(root, 'locks'),
    manifests: manifests ?? manifestsAt(mock.url), ...(priceBook ? { priceBook } : {}), providerOpts: { timeouts: { ...TIMEOUTS, ...timeouts } },
    backendOptions: { checks: NO_CHECKS, ...backendOptions }, wow: { run: NOT_RUNNING, roots: [] }, signalTimings: SIGNAL_TIMINGS,
  });
  t.after(() => b.stop());
  assert.ok(b.bridge, 'the core runs on the temp AddOns folder');
  const vm = newVM({ db: 'NQADB = { hudIntro = true, firstReply = true }' }); // past the HUD's first-run intro and setup block
  vm.run(`STUB.epoch = ${Math.floor(Date.now() / 1000) - 1000}`); // the game's clock is the bridge's
  const s = { b, vm, mock, lines, addons: path.join(flavorDir, 'Interface', 'AddOns'), fed: null, text: '', offered: '', loads: vm.loads(), at: Date.now() };
  mirror(s); // the doorbells and slots as they are when the UI loads
  vm.login();
  const nonce = vm.evaluate('NS.R.nonce');
  await sync(s, d => d.bridge.nonce === nonce, 'the hello answered');
  vm.slash(''); // the window open, as a player has it
  return s;
}

const setPrivacy = (s, p) => s.b.api.setPrivacy({ ...PRIVACY, ...p });
const chatId = s => s.vm.evaluate('NS.Chats.Active().id');
const chatOf = (d, id) => d.chats.find(c => c.id === id);
const errs = (d, id) => d.records.filter(r => r.t === 'error' && r.chat === id);
/** Send words as the window's box does, and wait until the slot answers them (a reply or an error). */
async function say(s, words) {
  const id = chatId(s);
  const before = s.vm.list('NS.Chats.Active().history').length;
  s.vm.send(words);
  await sync(s, d => d.records.filter(r => r.chat === id && (r.t === 'reply' || r.t === 'error' || r.t === 'aborted')).length > 0
    && s.vm.list('NS.Chats.Active().history').slice(before).some(e => e.role === 'assistant' || e.err), `the answer to "${words}"`);
  await sync(s, d => chatOf(d, id)?.busy === false, 'the chat idle');
  return s.vm.lastHistory();
}
const light = s => s.vm.json('{ NS.Transport.Light() }');
function header(s) {
  s.vm.run('NS.Refresh("status")');
  return s.vm.evaluate('NS.UI.ui.header.text');
}
function hud(s) {
  s.vm.run('NS.HUD.Render()');
  return [s.vm.evaluate('NS.HUD.h.status.text'), s.vm.evaluate('NS.HUD.h.sub.text')];
}
const errBubble = vm => vm.evaluate('(function() for i = #NS.UI.ui.bubbles, 1, -1 do local b = NS.UI.ui.bubbles[i]; if b.shown and b.errEntry then return i end end end)()');
const acts = (vm, i) => vm.list(`(function() local out = {} for _, c in ipairs(NS.UI.ui.bubbles[${i}].acts) do if c.shown then out[#out + 1] = c.label.text end end return out end)()`);
const replyLines = (s, words) => s.vm.chatLines().filter(l => l.includes(words));

// ---------------------------------------------------------------- the tests

// The companion as the player sees it: this addon's switch and the app's (Companion.IsOn was only
// read here, so it's gone: code health AD-19).
const COMPANION_ON = '(NS.Companion.DB().on == true and NS.Companion.DesktopOn())';

test('contract: ready with a model and effort; usage.model is the id asked for, never the provider\'s alias; a /nqa think level and a /nqa model switch take, as the addon shows them', async (t) => {
  const s = await session(t, {
    byok: { model: 'claude-sonnet-5', effort: 'medium' },
    handler: r => aliasReply('Here.\n\nTL;DR: here.', `${r.body?.model}-20260101`, { input: 1500, output: 60 }),
  });
  const { vm } = s;
  const id = chatId(s);
  let d = await sync(s, x => !!x.bridge.provider, 'the provider');
  // What the slot says…
  assert.deepEqual(
    { model: d.bridge.provider.model, modelName: d.bridge.provider.modelName, effort: d.bridge.provider.effort, effortSupported: d.bridge.provider.effortSupported },
    { model: 'claude-sonnet-5', modelName: 'Claude Sonnet 5', effort: 'medium', effortSupported: true });
  assert.equal(d.rt.state, 'ready');
  assert.equal(d.gw.state, 'ready');
  assert.equal(d.bridge.warn, undefined, 'no version pin warning (the retired build\'s; it read "has a warning")');
  for (const cap of ['provider', 'usage', 'ekind', 'model', 'echo']) assert.ok(d.bridge.caps.includes(cap), cap);
  // …and what the addon makes of it: the light, the HUD, the header.
  const [color, tip] = light(s);
  assert.equal(color, 'green');
  assert.match(tip, /^Connected to Anthropic \(Claude Sonnet 5\)\. Last heard from the NeverQuestAlone app /);
  assert.equal(hud(s)[0], 'Ready');
  assert.equal(header(s), 'Claude Sonnet 5 · Medium');
  // The in-game Thinking list is the model's own levels, from bridge.provider.efforts (fix-102).
  assert.equal(d.bridge.provider.efforts, 'off low medium high xhigh max');
  assert.deepEqual(vm.list('NS.UI.ChatEfforts(NS.Chats.Active())'), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);

  // A reply: the provider answered with a dated alias; the reply's usage.model is the id asked for.
  let e = await say(s, 'where to?');
  assert.equal(posts(s.mock).at(-1).body.model, 'claude-sonnet-5');
  assert.equal(posts(s.mock).at(-1).body.output_config?.effort, 'medium');
  assert.equal(e.role, 'assistant');
  assert.equal(e.usage.model, 'claude-sonnet-5');
  d = parseSlot(s.text);
  assert.equal(d.records.find(r => r.t === 'reply').usage.model, 'claude-sonnet-5');
  assert.ok(!s.text.includes('20260101'), 'the alias never reaches the slot');
  assert.deepEqual({ effort: chatOf(d, id).effort, effortSupported: chatOf(d, id).effortSupported, model: chatOf(d, id).model },
    { effort: 'medium', effortSupported: true, model: undefined }, 'the chat\'s next turn: the player\'s effort, the provider\'s model');

  // /nqa think high: "(from your next message)" until the snapshot's effort says high.
  vm.slash('think high');
  assert.equal(header(s), 'Claude Sonnet 5 · High |cff9d9d9d(from your next message)|r');
  d = await sync(s, x => chatOf(x, id)?.effort === 'high', 'chats[].effort high');
  assert.equal(chatOf(d, id).think, 'high');
  assert.equal(header(s), 'Claude Sonnet 5 · High', 'the note clears on the bridge\'s word');
  await say(s, 'think harder');
  assert.equal(posts(s.mock).at(-1).body.output_config?.effort, 'high', 'the level the snapshot promised');

  // /nqa model: "(asked for …)" until chats[].model names it; then the chat's model, its name, its
  // own thinking levels (fix-102: Haiku 4.5's thinking budgets), and the turn goes to it at the chat's level.
  vm.slash('model claude-haiku-4-5');
  assert.equal(header(s), 'Claude Sonnet 5 · High |cff9d9d9d(asked for claude-haiku-4-5)|r');
  d = await sync(s, x => chatOf(x, id)?.model === 'claude-haiku-4-5', 'chats[].model');
  assert.deepEqual({ modelName: chatOf(d, id).modelName, effortSupported: chatOf(d, id).effortSupported, efforts: chatOf(d, id).efforts, effort: chatOf(d, id).effort },
    { modelName: 'Claude Haiku 4.5', effortSupported: true, efforts: 'off minimal low medium high xhigh max', effort: 'high' });
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").modelAsked`), null);
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").model`), 'claude-haiku-4-5');
  assert.equal(header(s), 'Claude Haiku 4.5 · High', 'the chat\'s level, which Haiku has now');
  assert.equal(vm.evaluate('NS.UI.NoEffort(NS.Chats.Active())'), 'false');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'true');
  assert.deepEqual(vm.list('NS.UI.ChatEfforts(NS.Chats.Active())'), ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], 'the chat\'s own model\'s levels');
  assert.equal(d.bridge.provider.model, 'claude-sonnet-5', 'the provider\'s model is unchanged');
  e = await say(s, 'on the small one');
  assert.equal(posts(s.mock).at(-1).body.model, 'claude-haiku-4-5');
  assert.equal(posts(s.mock).at(-1).body.output_config, undefined, 'Haiku takes no effort field');
  assert.deepEqual(posts(s.mock).at(-1).body.thinking, { type: 'enabled', budget_tokens: 8192 }, 'the chat\'s High: Haiku\'s budget for it');
  assert.equal(e.usage.model, 'claude-haiku-4-5');

  // A model the provider doesn't offer: the model_not_found line ends the "asked for"; nothing changes.
  vm.slash('model gpt-9');
  assert.match(header(s), /\(asked for gpt-9\)/);
  d = await sync(s, x => errs(x, id).some(r => r.kind === 'model_not_found'), 'the refusal');
  const refused = errs(d, id).find(r => r.kind === 'model_not_found');
  assert.equal(refused.action, 'none');
  assert.equal(refused.text, "gpt-9 isn't one of the Anthropic models you can pick. Nothing was changed. See them in the NeverQuestAlone app.");
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").modelAsked`), null);
  assert.equal(header(s), 'Claude Haiku 4.5 · High', 'still the chat\'s own');
  assert.equal(chatOf(d, id).model, 'claude-haiku-4-5');
  const i = errBubble(vm);
  assert.equal(acts(vm, i)[0], 'Okay');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), 'false', 'its own words say where the list is: no second desktop line');

  // /nqa model default: the provider's model again, with the chat's effort.
  vm.slash('model default');
  assert.match(header(s), /\(asked for the default model\)/);
  d = await sync(s, x => chatOf(x, id) && chatOf(x, id).model === undefined, 'chats[].model gone');
  assert.equal(chatOf(d, id).effort, 'high');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").model`), null);
  assert.equal(header(s), 'Claude Sonnet 5 · High');
  await say(s, 'back to the big one');
  assert.equal(posts(s.mock).at(-1).body.model, 'claude-sonnet-5');
  assert.ok(!s.text.includes('sk-ant-'), 'no key in the slot');
});

test('contract: with a daily cap the player set, usage.needs near_cap then cap, as the HUD, the usage lines and the light say them', async (t) => {
  let input = 8_200_000; // at a flat $0.10 per 1M: $0.82 of the player's $1.00 day, then over it
  const s = await session(t, {
    byok: { repair: { enabled: false }, caps: { dailyUsd: 1, setBy: 'player' } }, priceBook: flatPrices(),
    handler: () => reply('Noted.\n\nTL;DR: noted.', { input, output: 80 }),
  });
  const { vm } = s;
  await say(s, 'first');
  let d = await sync(s, x => x.bridge.usage.needs === 'near_cap', 'near_cap');
  assert.equal(d.bridge.usage.spentMicros, 820040);
  assert.equal(d.bridge.usage.capMicros, 1000000);
  assert.equal(d.rt.state, 'ready', 'near the cap is still ready');
  assert.equal(vm.evaluate('NS.HUD.SpendLine()'), 'You\'ve used $0.82 of your $1.00 daily spend limit.');
  vm.run('NS.UI.Toggle(false); NS.HUD.Render()'); // the HUD stands in for the window while it's closed
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'true', 'the HUD shows spend only when it needs the player');
  assert.equal(vm.evaluate('NS.HUD.h.spend.text'), 'You\'ve used $0.82 of your $1.00 daily spend limit.');
  vm.slash('');
  const lines = vm.list('NS.UI.UsageLines()');
  assert.ok(lines.includes('Today: ~$0.82 of $1.00 · 1 message'), JSON.stringify(lines));
  assert.ok(lines.includes('Your daily spend limit resets at midnight, in 12 hours.'), JSON.stringify(lines)); // the stub's date("*t") is 12:00
  assert.ok(lines.includes('Check-ins: off in the NeverQuestAlone app'), 'check-ins as information (off in the app until turned on), no allowance');
  assert.ok(!lines.some(l => /left today|a day/.test(l)), 'no automatic-turn allowance (usage.autoLeft is gone)');
  assert.equal(light(s)[0], 'green');
  input = 2_000_000;
  await say(s, 'second');
  d = await sync(s, x => x.bridge.usage.needs === 'cap' && x.rt.state === 'cap', 'cap');
  assert.equal(d.rt.reason, 'cap_spend');
  const [color, tip] = light(s);
  assert.equal(color, 'yellow');
  assert.ok(tip.startsWith('You\'ve reached your daily spend limit ($1.00). Raise it in the NeverQuestAlone app, or it resets at midnight.'), tip);
  assert.deepEqual(hud(s), ['You\'ve reached your daily spend limit ($1.00)', 'Raise it in the NeverQuestAlone app, or it resets at midnight.']);
  // A third message is refused at the cap: its line, "on your desktop".
  const e = await say(s, 'third');
  assert.equal(e.kind, 'cap_spend');
  assert.equal(e.action, 'desktop');
  assert.equal(posts(s.mock).length, 2, 'nothing sent past the cap');
});

test('contract: no limits of ours (the default): spend past the old $1.00 day is never a cap; no cap fields in the slot; the HUD shows no spend line', async (t) => {
  const s = await session(t, {
    byok: { repair: { enabled: false } }, priceBook: flatPrices(),
    handler: () => reply('Noted.\n\nTL;DR: noted.', { input: 12_000_000, output: 80 }), // $1.20 a reply at a flat $0.10 per 1M
  });
  const { vm } = s;
  await say(s, 'first');
  await say(s, 'second');
  const d = await sync(s, x => x.bridge.usage?.turns === 2, 'two turns');
  assert.ok(d.bridge.usage.spentMicros > 2_000_000, 'past what the old $1.00 day allowed');
  for (const k of ['capMicros', 'capTurns', 'autoLeft', 'needs', 'fuse']) assert.equal(d.bridge.usage[k], undefined, k);
  assert.equal(d.bridge.turnsLeft, undefined);
  assert.equal(d.rt.state, 'ready');
  assert.equal(posts(s.mock).length, 2);
  assert.equal(vm.evaluate('NS.HUD.SpendLine()'), null, 'nothing about spend needs the player');
  assert.equal(light(s)[0], 'green');
  const lines = vm.list('NS.UI.UsageLines()');
  assert.ok(lines.includes('Today: ~$2.40 · 2 messages'), JSON.stringify(lines));
  assert.ok(!lines.some(l => /limit(?!ed)|midnight|left today| of \$/.test(l)), `no limit of ours in the addon's words: ${JSON.stringify(lines)}`);
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.usage.label.text'), '~$2.40 today', 'the header: spend as information');
});

test('contract: automatic help paused as the addon loads it: one held line in the Companion chat, bridge.usage.autoPaused, never turnsLeft; held events ride along with the player\'s next typed message, which ends it', async (t) => {
  const LINE = autoPausedLine('NeverQuestAlone');
  const s = await session(t, { handler: () => reply('Noted.\n\nTL;DR: noted.') });
  const { vm } = s;
  assert.deepEqual(await setPrivacy(s, { companion: true }), { ok: true });
  let d = await sync(s, x => x.bridge.usage?.autoOn === true, 'the companion on');
  assert.equal(d.bridge.turnsLeft, undefined, 'no daily cap: left out');
  assert.equal(vm.evaluate('NS.R.bridgeTurnsLeft'), null);
  // A bug loop (a forged strip, or an addon that misfires): 12 events at once, straight into the core.
  for (let i = 0; i < 12; i++) {
    s.b.bridge.handlePayload(encodeRecord({ token: d.token, key: `f00d_${i}`, type: 'evt', chat: COMPANION_CHAT,
      args: { cur: 0, kind: 'route_done', layer: `loop${i}`, agent: 'main', name: 'Companion' }, body: '' }), 'strip');
  }
  // The slot carries the records past the addon's cursor: keep each one the addon loaded.
  const seen = new Map();
  const keep = x => { for (const r of x.records) seen.set(r.seq, r); return x; };
  d = await sync(s, x => keep(x).bridge.usage.autoPaused === true && [...seen.values()].filter(r => r.t === 'reply' && r.chat === COMPANION_CHAT).length === AUTO_FUSE.turns,
    'automatic help paused, and the ten replies');
  assert.equal(d.bridge.turnsLeft, undefined, 'turnsLeft never comes on BYOK');
  const lines = [...seen.values()].filter(r => r.kind === 'auto_paused');
  assert.equal(lines.length, 1);
  assert.deepEqual({ t: lines[0].t, chat: lines[0].chat, text: lines[0].text, action: lines[0].action, answers: lines[0].answers },
    { t: 'error', chat: COMPANION_CHAT, text: LINE, action: 'none', answers: 'none' });
  assert.equal(posts(s.mock).length, AUTO_FUSE.turns);
  // The addon: the line is held (gold, "Waits for your next message") with Okay and no resend; no
  // promise while it holds; the usage panel and /nqa companion say so.
  assert.equal(vm.evaluate('NS.Companion.Call("AutoPaused")'), 'true');
  const cc = `NS.Chats.Find("${COMPANION_CHAT}")`;
  const at = vm.num(`(function() local h = ${cc}.history for i = #h, 1, -1 do if h[i].kind == "auto_paused" then return i end end end)()`);
  const note = `${cc}.history[${at}]`;
  assert.equal(vm.evaluate(`${note}.text`), LINE);
  assert.equal(vm.evaluate(`${note}.info`), 'true', 'it answers no message');
  assert.equal(vm.evaluate(`NS.UI.ErrorLook(${note})`), 'Waits for your next message');
  assert.equal(vm.evaluate(`NS.Chats.ResendText(${cc}, ${note})`), null, 'nothing to send again');
  assert.equal(vm.list(`NS.Chats.Find("${COMPANION_CHAT}").history`).filter(e => e.err).length, 1, 'the one line: nothing else');
  assert.ok(vm.list('NS.UI.UsageLines()').includes('Check-ins: paused after a burst of them; your next message turns them back on'));
  const was = chatId(s);
  vm.run(`NS.Chats.Switch("${COMPANION_CHAT}"); NS.Refresh("all")`);
  assert.deepEqual(acts(vm, errBubble(vm)), ['Okay', 'Show Details']);
  vm.run(`NS.Chats.Switch("${was}"); NS.Refresh("all")`);
  // The player says anything: automatic help is on again, and the held events went with the message.
  const before = posts(s.mock).length;
  await say(s, 'what was that?');
  d = await sync(s, x => x.bridge.usage.autoPaused === undefined, 'automatic help back on');
  assert.equal(d.bridge.turnsLeft, undefined);
  assert.equal(vm.evaluate('NS.Companion.Call("AutoPaused")'), 'false', 'the addon\'s promise is back');
  const sent = posts(s.mock).slice(before).map(r => JSON.stringify(r.body?.messages ?? ''));
  assert.ok(sent.some(b => /Held while automatic help was paused/.test(b)), 'the held events rode along with the typed message');
});

test('contract: out_of_credit then key_invalid: the rt state, usage.needs, the error records and the addon\'s words', async (t) => {
  const s = await session(t, {
    handler: r => (lastWords(r).endsWith('credit?') ? fx('http-402-billing.json') : lastWords(r).endsWith('key?') ? fx('http-401-authentication.json') : reply('Fine.\n\nTL;DR: fine.')),
  });
  const { vm } = s;
  let e = await say(s, 'credit?');
  assert.deepEqual([e.kind, e.action], ['out_of_credit', 'desktop']);
  let d = await sync(s, x => x.rt.state === 'out_of_credit', 'rt out_of_credit');
  assert.equal(d.bridge.usage.needs, 'out_of_credit');
  let [color, tip] = light(s);
  assert.equal(color, 'red');
  assert.ok(tip.startsWith('Your Anthropic account is out of credit. Add credit at Anthropic, or pick another AI in the NeverQuestAlone app.'), tip);
  let i = errBubble(vm);
  assert.deepEqual(acts(vm, i), ['Retry', 'Okay', 'Show Details']);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), 'false', 'the line already says "on your desktop"');
  e = await say(s, 'key?');
  assert.deepEqual([e.kind, e.action], ['auth_invalid', 'desktop']);
  d = await sync(s, x => x.rt.state === 'key_invalid', 'rt key_invalid');
  assert.equal(d.bridge.usage.needs, 'key_invalid');
  assert.equal(d.bridge.provider.keyState, 'invalid');
  assert.equal(d.gw.state, 'key_invalid');
  [color, tip] = light(s);
  assert.equal(color, 'red');
  assert.ok(tip.startsWith('Your Anthropic key was rejected. Replace it in the NeverQuestAlone app.'), tip);
  assert.deepEqual(hud(s), ['Your Anthropic key was rejected', 'Replace it in the NeverQuestAlone app.']);
});

test('contract: slowed (a rate-limit bucket at 0): rt slowed with retryIn, usage.needs slowed, the countdown in the addon', async (t) => {
  const s = await session(t, {
    handler: () => {
      const r = reply('Sure.\n\nTL;DR: sure.');
      return { ...r, headers: { ...r.headers, 'anthropic-ratelimit-requests-limit': '50', 'anthropic-ratelimit-requests-remaining': '0',
        'anthropic-ratelimit-requests-reset': new Date(Date.now() + 90_000).toISOString() } };
    },
  });
  const e = await say(s, 'hi');
  assert.equal(e.role, 'assistant', 'the reply itself arrives');
  const d = await sync(s, x => x.rt.state === 'slowed', 'rt slowed');
  assert.ok(d.rt.retryIn > 60 && d.rt.retryIn <= 90, String(d.rt.retryIn));
  assert.equal(d.bridge.usage.needs, 'slowed');
  const [color, tip] = light(s);
  assert.equal(color, 'yellow');
  assert.match(tip, /^Anthropic asked NeverQuestAlone to slow down\. Trying again in \d+ (seconds?|minutes?)\./);
  assert.ok(s.vm.list('NS.UI.UsageLines()').some(l => l.startsWith('Anthropic asked NeverQuestAlone to slow down: trying again in ')));
});

test('contract: local_down: a local server that isn\'t running; the Retry line and the addon naming it', async (t) => {
  const probe = await startMock(() => null);
  const dead = probe.url;
  await probe.close();
  // Other at a server on this computer that isn't running (Ollama's OpenAI-compatible address, say).
  const host = new URL(dead).host;
  const s = await session(t, { byok: { provider: 'custom', model: 'qwen3:8b', custom: { baseUrl: `${dead}/v1`, model: 'qwen3:8b' } }, keys: [] });
  let d = await sync(s, x => x.bridge.provider?.id === 'custom', 'custom');
  assert.deepEqual([d.bridge.provider.auth, d.bridge.provider.privacy, d.bridge.provider.model], ['local', 'local', 'qwen3:8b']);
  const e = await say(s, 'hello?');
  assert.deepEqual([e.kind, e.action], ['local_unreachable', 'retry']);
  d = await sync(s, x => x.rt.state === 'local_down', 'rt local_down');
  const [color, tip] = light(s);
  assert.equal(color, 'red');
  assert.ok(tip.startsWith(`NeverQuestAlone can't reach ${host}. Start ${host}, then click Retry on your message.`), tip);
  assert.deepEqual(acts(s.vm, errBubble(s.vm)), ['Retry', 'Okay', 'Show Details']);
});

test('contract: an error with each action (none, desktop, send_again, retry): kind, action and request id as the addon offers them', async (t) => {
  const FAULTS = {
    'f-refuse': fx('refusal.sse'),
    'f-spend': fx('http-400-usage-limits.json'),
    'f-drop': { status: 200, headers: { 'content-type': 'text/event-stream' }, body: anthropicHead(), destroyAfterBody: true },
    'f-busy': fx('http-529-overloaded.json'),
  };
  const s = await session(t, {
    handler: (r) => { for (const [tag, spec] of Object.entries(FAULTS)) if (lastWords(r).endsWith(tag)) return spec; return reply('Fine.\n\nTL;DR: fine.'); },
    backendOptions: { sleep: quick },
  });
  const { vm } = s;
  const cases = [
    ['f-refuse', 'content_blocked', 'none', ['Okay', 'Show Details'], null],
    ['f-spend', 'spend_limit', 'desktop', ['Retry', 'Okay', 'Show Details'], 'Fix it in the NeverQuestAlone app.'],
    ['f-drop', 'network_after_send', 'send_again', ['Retry', 'Okay', 'Show Details'], null],
    ['f-busy', 'overloaded', 'retry', ['Retry', 'Okay', 'Show Details'], null],
  ];
  for (const [tag, kind, action, buttons, hint] of cases) {
    const e = await say(s, `please ${tag}`);
    const rec = errs(parseSlot(s.text), chatId(s)).at(-1);
    assert.deepEqual([rec.kind, rec.action], [kind, action], tag);
    assert.deepEqual([e.kind, e.action], [kind, action], `${tag} in the addon`);
    assert.equal(e.rid ?? null, rec.requestId ?? null, `${tag}: the request id as the record has it`);
    const i = errBubble(vm);
    assert.deepEqual(acts(vm, i), buttons, tag);
    assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), hint ? 'true' : 'false', `${tag} hint`);
    if (hint) assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.text`), hint);
  }
  assert.ok(errs(parseSlot(s.text), chatId(s)).some(r => typeof r.requestId === 'string' && r.requestId.length <= 64), 'a request id reaches the slot');
  // Still busy after the retries: rt provider_down until a turn goes through.
  await sync(s, x => x.rt.state === 'provider_down', 'rt provider_down');
  const [color, tip] = light(s);
  assert.equal(color, 'yellow');
  assert.ok(tip.startsWith('Anthropic is busy right now. Trying again…'), tip);
  // Retry sends the same words again, as a new message.
  const n = vm.outboxWires().length;
  const i = errBubble(vm);
  vm.run(`local b = NS.UI.ui.bubbles[${i}].acts[1]; b.scripts.OnClick(b, "LeftButton")`);
  assert.equal(vm.outboxWires().length, n + 1);
  assert.ok(vm.outboxWires().at(-1).wire.endsWith('please f-busy'));
});

test('contract: the companion switch (bridge.usage.autoOn) and echo (bridge.echo) follow the app\'s privacy page live, off then on', async (t) => {
  const s = await session(t);
  const { vm } = s;
  // Companion: off until the player turns it on in the app (§9.4).
  let d = await sync(s, x => !!x.bridge.usage, 'usage');
  assert.equal(d.bridge.usage.autoOn, false);
  assert.equal(vm.evaluate('NS.Companion.Call("DesktopOn")'), 'false');
  assert.equal(vm.evaluate(COMPANION_ON), 'false');
  assert.equal(vm.evaluate('NS.Companion.Active("evt")'), 'false', 'no events go while it\'s off on the desktop');
  assert.deepEqual(await setPrivacy(s, { companion: true }), { ok: true });
  d = await sync(s, x => x.bridge.usage.autoOn === true, 'autoOn true');
  assert.equal(s.b.config.byok.privacy.companion, true, 'the core\'s switch too: it reads byok.privacy (code health BR-28)');
  assert.equal(vm.evaluate(COMPANION_ON), 'true');
  assert.equal(vm.evaluate('NS.Companion.Active("evt")'), 'true');
  await setPrivacy(s, { companion: false });
  await sync(s, x => x.bridge.usage.autoOn === false, 'autoOn false');
  assert.equal(vm.evaluate(COMPANION_ON), 'false');

  // Echo: off for a new install (PR-1): no reply line in the chat frame, whatever /nqa echo says.
  assert.equal(d.bridge.echo, 'off');
  vm.slash('echo full');
  vm.run('STUB.chat = {}');
  vm.run('NS.UI.Toggle(false)'); // replies echo whether or not the window is open
  let e = await say(s, 'echo test one');
  assert.equal(e.role, 'assistant');
  assert.deepEqual(replyLines(s, 'Here.'), [], 'nothing in the chat frame');
  assert.equal(vm.evaluate('NS.Notify.EchoMode()'), 'off');
  vm.slash('echo');
  assert.ok(vm.chatLines().at(-1).endsWith('Replies in Your Chat Frame: Whole Reply. It\'s off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more.'), vm.chatLines().at(-1));
  // On in the app: this addon's own mode applies again.
  await setPrivacy(s, { echo: true });
  d = await sync(s, x => x.bridge.echo === 'on', 'echo on');
  assert.equal(vm.evaluate('NS.Notify.EchoMode()'), 'full');
  vm.run('STUB.chat = {}');
  e = await say(s, 'echo test two');
  assert.equal(e.role, 'assistant');
  assert.equal(replyLines(s, 'Here.').length, 1, 'the whole reply, line by line');
  vm.slash('echo summary');
  assert.ok(vm.chatLines().at(-1).endsWith('Replies in Your Chat Frame: TL;DR. Settings has it too.'), vm.chatLines().at(-1));
  // And off again.
  await setPrivacy(s, { echo: false });
  await sync(s, x => x.bridge.echo === 'off', 'echo off again');
  vm.run('STUB.chat = {}');
  await say(s, 'echo test three');
  assert.deepEqual(replyLines(s, 'here.'), []);
});

// The addon's half of a chat's own model the bridge drops (the provider answered model_not_found for
// it, or the app changed provider, or the bridge's state began again): the snapshot stops naming
// it, so the header, error lines and /nqa model go back to the provider's model (C3 review).
test('contract: a chat\'s own model the bridge drops (model_not_found) goes from the addon\'s header too', async (t) => {
  const s = await session(t, {
    byok: { model: 'claude-sonnet-5', effort: 'low' },
    handler: r => (r.body?.model === 'claude-haiku-4-5' ? fx('http-404-not-found.json') : reply('Fine.\n\nTL;DR: fine.')),
  });
  const id = chatId(s);
  s.vm.slash('model claude-haiku-4-5');
  await sync(s, x => chatOf(x, id)?.model === 'claude-haiku-4-5', 'chats[].model');
  assert.equal(header(s), 'Claude Haiku 4.5 · Low', 'the player\'s Low, which Haiku has (fix-102)');
  const e = await say(s, 'hi');
  assert.equal(e.kind, 'model_not_found');
  assert.equal(e.text, "Claude Haiku 4.5 isn't available on your Anthropic account. Switched to Claude Sonnet 5 for now. Change it in the NeverQuestAlone app.");
  await sync(s, x => chatOf(x, id) && chatOf(x, id).model === undefined, 'chats[].model dropped');
  assert.equal(header(s), 'Claude Sonnet 5 · Low');
  assert.equal(s.vm.evaluate(`NS.Chats.Find("${id}").model`), null, 'gone from the saved chat too');
  assert.equal(s.vm.evaluate('NS.UI.ChatModelName(NS.Chats.Active())'), 'Claude Sonnet 5', 'the name error lines and /nqa model use');
  const again = await say(s, 'and now?');
  assert.equal(again.role, 'assistant');
  assert.equal(posts(s.mock).at(-1).body.model, 'claude-sonnet-5');
});

test('contract: a /nqa think level the bridge doesn\'t have (its state began again) gives way to the bridge\'s word; one asked for waits for it', async (t) => {
  const s = await session(t, { byok: { model: 'claude-sonnet-5', effort: 'low' } });
  const { vm } = s;
  const id = chatId(s);
  await say(s, 'hello');
  // The saved chat says high, but the bridge has none for it (as after a new data folder).
  vm.run(`NS.Chats.Find("${id}").think = "high"`);
  assert.equal(header(s), 'Claude Sonnet 5 · High |cff9d9d9d(from your next message)|r');
  await say(s, 'which level?');
  assert.equal(posts(s.mock).at(-1).body.output_config?.effort, 'low', 'the bridge ran it at the player\'s level');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").think`), null, 'the bridge\'s word: none of its own');
  assert.equal(header(s), 'Claude Sonnet 5 · Low', 'no note that would never clear');
  // Asked for: "(from your next message)" until the snapshot names it, then the chat's own.
  vm.slash('think medium');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").thinkAsked`), 'medium');
  assert.equal(header(s), 'Claude Sonnet 5 · Medium |cff9d9d9d(from your next message)|r');
  await sync(s, x => chatOf(x, id)?.think === 'medium', 'chats[].think medium');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").thinkAsked`), null);
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").think`), 'medium');
  assert.equal(header(s), 'Claude Sonnet 5 · Medium');
  vm.slash('think default');
  await sync(s, x => chatOf(x, id) && chatOf(x, id).think === undefined, 'chats[].think gone');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").thinkAsked`), null);
  assert.equal(header(s), 'Claude Sonnet 5 · Low');
});

test('contract: a /nqa model the provider doesn\'t offer, while a message is still running, answers the command, not the message (C3 review)', async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const s = await session(t, {
    timeouts: { firstTokenMs: 20000, idleMs: 20000, runMs: 30000 },
    handler: async (r) => { if (lastWords(r).endsWith('slow one')) await gate; return reply('Done.\n\nTL;DR: done.'); },
  });
  t.after(() => release());
  const { vm } = s;
  const id = chatId(s);
  const pending = () => vm.json(`(function() local out = {} for _, p in ipairs(NS.Chats.Find("${id}").pending) do out[#out + 1] = { key = p.key, acked = p.acked and true or false } end return out end)()`);
  vm.send('a slow one');
  await sync(s, x => chatOf(x, id)?.busy === true && list(pending())[0]?.acked === true, 'the message acked and running');
  const [sent] = list(pending());
  vm.slash('model gpt-9');
  const d = await sync(s, x => errs(x, id).some(r => r.kind === 'model_not_found'), 'the refusal');
  assert.equal(errs(d, id).find(r => r.kind === 'model_not_found').answers, 'none');
  const refusal = vm.lastHistory();
  assert.equal(refusal.kind, 'model_not_found');
  assert.equal(refusal.sendKey, undefined, 'it answers no message');
  assert.deepEqual(list(pending()).map(p => p.key), [sent.key], 'the running message still waits for its answer');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").modelAsked`), null, 'and the "asked for" ends');
  release();
  await sync(s, x => x.records.some(r => r.chat === id && r.t === 'reply'), 'the reply');
  await sync(s, x => chatOf(x, id)?.busy === false && list(pending()).length === 0, 'the reply answered it');
  const answer = vm.lastHistory();
  assert.equal(answer.role, 'assistant');
  assert.match(answer.text, /^Done\./);
});
