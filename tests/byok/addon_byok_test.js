'use strict';
// The addon on a BYOK bridge, on main's 0.4.4 widget (the consolidation's
// commit 3; BUILD-PLAN "Contract: what the addon reads";
// PRD §9.5, §10, §16.4 UX-1 to UX-8, KY-10): the provider's words on the light,
// the HUD and the header; error bubbles by kind with Okay, Retry, Send again and
// details a click away; the usage line, its panel and the HUD's one spend line;
// the model in the header; the companion's name; /nqa, /nqa usage|model|setup|
// cost; diag without the install token; the setup checklist. Ported from byok-int 79985cb onto main's frames: the header is main's
// Thinking control, the usage line sits in the title row, the bar is main's
// NQAHUDBar. Security is tests/byok/addon_security_test.js; the words,
// addon_public_words_test.js.
// Same VM as tests/nqa_addon_test.js: the real addon in fengari on the stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { newVM, reloadVM, lstr, STUB_METHODS, EXTRA, TRAPS, tocFiles, ADDON, SIG } = require('../helpers/nqa-vm');
const HAVE_JIT = spawnSync('luajit', ['-v'], { encoding: 'utf8' }).status === 0;

// ---------------------------------------------------------------- helpers
const { PUBLIC, ring, oldSlot, provider, usage, capped, byokSlot, confirmHello, apply, replyRec, errorRec } = require('../helpers/byok-slots');
const { PRIVATE_SKIP, privateTerms } = require('../helpers/private-terms');
// The addon's version, as Store.lua says it (main's, at each merge).
const VERSION = fs.readFileSync(path.join(ADDON, 'Store.lua'), 'utf8').match(/ns\.VERSION = "([^"]+)"/)[1];
// An install an earlier desktop app made (its TOC says X-Backend: byok, which the addon doesn't read: one build).
const appVM = (opts = {}) => newVM({ ...opts, extra: PUBLIC + (opts.extra || '') }).login();
const light = vm => vm.json('{ NS.Transport.Light() }');
const activeId = vm => vm.evaluate('NQADB.activeChat');
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
const type = (vm, text) => vm.run(`NS.UI.ui.input:SetText(${lstr(text)}); NS.UI.SendFromInput()`);
const sentText = (vm, t) => vm.outboxWires().some(e => e.wire.endsWith('\x1f' + t) || e.wire.includes('\x1d' + t));
const click = (vm, expr, button = 'LeftButton') => vm.run(`local b = ${expr}; b.scripts.OnClick(b, "${button}")`);
// A BYOK install, window open, the hello answered.
function byok(opts = {}) {
  const vm = confirmHello(newVM(opts.vm || {}).login());
  apply(vm, byokSlot(opts.slot || {}));
  return vm;
}
// The bubble drawing an error entry (the newest with errEntry).
const errBubble = vm => vm.evaluate('(function() for i = #NS.UI.ui.bubbles, 1, -1 do local b = NS.UI.ui.bubbles[i]; if b.shown and b.errEntry then return i end end end)()');
function acts(vm, i) {
  return vm.list(`(function() local out = {} for _, c in ipairs(NS.UI.ui.bubbles[${i}].acts) do if c.shown then out[#out + 1] = c.label.text end end return out end)()`);
}
// Never the retired build's words, nor a private term (read from SCRUB_TERMS, below).
const NO_OC = /pairing/;
// A public install whose very first slot is BYOK's.
function byokFirst(slot = {}, vmOpts = {}) {
  const vm = appVM(vmOpts);
  vm.advance(3.1);
  vm.slot(byokSlot({ ...slot, nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}
const plain = t => String(t ?? '').replace(/\|H[^|]*\|h/g, '').replace(/\|c[0-9a-fA-F]{8}/g, '').replace(/\|r/g, '').replace(/\|A:[^|]*\|a/g, '');

// ---------------------------------------------------------------- the helpers in Store.lua

// The companion as the player sees it: this addon's switch and the app's (Companion.IsOn was only
// read here, so it's gone: code health AD-19).
const COMPANION_ON = '(NS.Companion.DB().on == true and NS.Companion.DesktopOn())';

test('money arrives as whole micro-dollars and is shown with care, as the desktop says it; cents; durations spelled out; the game\'s clock', () => {
  const vm = newVM().login();
  const f = (fn, v) => vm.evaluate(`NS.${fn}(${v})`);
  assert.equal(f('Dollars', 180000), '$0.18');
  assert.equal(f('Dollars', 1000000), '$1.00');
  assert.equal(f('Dollars', 4120000), '$4.12');
  assert.equal(f('Dollars', 4129999), '$4.12', 'floored, never rounded up');
  assert.equal(f('Dollars', 0), '$0');
  // Under a cent, as the desktop's usdMicros (bones-ux-writer round 2, UX-W20): one decimal from 0.1¢, two below, then "under".
  assert.equal(f('Dollars', 5000), '0.5¢');
  assert.equal(f('Dollars', 4321), '0.4¢');
  assert.equal(f('Dollars', 400), '0.04¢');
  assert.equal(f('Dollars', 99), 'under $0.0001');
  assert.equal(f('Dollars', 1234567890), '$1,234.56');
  assert.equal(f('Dollars', -3), '$0');
  assert.equal(f('Dollars', 'nil'), '$0');
  assert.equal(f('Cents', 4000), '0.4¢');
  assert.equal(f('Cents', 12000), '1.2¢');
  assert.equal(f('Cents', 120000), '12¢');
  assert.equal(f('Cents', 10000), '1¢');
  assert.equal(f('Cents', 500), '<0.1¢');
  assert.equal(f('Cents', 1050000), '$1.05');
  assert.equal(vm.evaluate('NS.Tokens'), null, 'no token counts in the player\'s words (STYLE §10)');
  // A duration inside a sentence, spelled out (STYLE §8); the compact form stays for compact lines.
  assert.equal(f('DurWords', 1), '1 second');
  assert.equal(f('DurWords', 45), '45 seconds');
  assert.equal(f('DurWords', 179), '2 minutes');
  assert.equal(f('DurWords', 3600), '1 hour');
  assert.equal(f('DurWords', 11520), '3 hours 12 minutes');
  assert.equal(vm.evaluate('NS.Fill("{a} and {b}", { a = 1 })'), '1 and {b}', 'a place with no value stays as written');
  assert.equal(vm.evaluate('NS.Plural(1, "1 message waits.", "{n} messages wait.")'), '1 message waits.');
  assert.equal(vm.evaluate('NS.Plural(3, "1 message waits.", "{n} messages wait.")'), '3 messages wait.');
  // The game's clock setting: 12-hour with 24-hour time off, 24-hour when it's on or the client can't say.
  assert.equal(vm.evaluate('NS.Clock(time())'), '12:00');
  vm.run('STUB.cvars.timeMgrUseMilitaryTime = "0"');
  assert.equal(vm.evaluate('NS.Clock(time())'), '12:00 PM');
  vm.run('STUB.cvars.timeMgrUseMilitaryTime = "1"');
  assert.equal(vm.evaluate('NS.Clock(time())'), '12:00');
});

// ---------------------------------------------------------------- an older bridge

test('a slot with none of the new caps (no provider, usage, ekind or model: its provider part failed, or an app from before them): nothing of theirs is drawn, and the commands say the app hasn\'t answered', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, firstReply = true }' }).login());
  vm.slash('');
  const id = activeId(vm);
  assert.match(light(vm)[1], /^Connected to your AI\. Last heard from the NeverQuestAlone app \d+ seconds? ago\.$/);
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'No model yet');
  assert.equal(vm.evaluate('NS.UI.ui.usage'), null, 'no usage line');
  assert.equal(vm.evaluate('NS.UI.ui.thinkArrow.shown'), 'false', 'no model: no Thinking menu');
  // An error renders without its kind's parts: no buttons, and a click on it does nothing.
  apply(vm, oldSlot({ records: [errorRec(1, id, 'gateway', 'retry', 'Your AI isn\'t reachable right now.')] }));
  const last = vm.lastHistory();
  assert.equal(last.action, undefined);
  assert.equal(errBubble(vm), null, 'no error parts');
  // No spend line in the HUD; the flash still says what it said.
  vm.slash('');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false');
  vm.run('NS.Transport.Warn("t", "The whole story.", "Replies come slower")');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click for the details.');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true', 'main\'s 0.4.9: the lines are a click away');
  // The commands: usage and model answer that the app hasn't, and the old roadmap's words are messages.
  const NOT_YET = 'The NeverQuestAlone app hasn\'t answered yet. Is it running?';
  vm.slash('');
  vm.slash('usage');
  assert.equal(notice(vm), NOT_YET);
  vm.slash('model gpt');
  assert.equal(notice(vm), NOT_YET);
  vm.slash('attach sponsor thread');
  assert.ok(sentText(vm, 'attach sponsor thread'), 'a message');
  assert.equal(vm.evaluate('SLASH_BONES1'), '/nqa');
  vm.slash('help all');
  assert.ok(notice(vm).includes('/nqa|r  Open or close the window\n'), notice(vm));
  assert.ok(notice(vm).includes('/nqa usage|r  Show today\'s spend and messages\n'));
  // The empty chat: the setup checklist, until the app names your AI.
  vm.slash('new Fresh');
  assert.match(vm.evaluate('NS.UI.ui.bubbles[1].body.text'), /^Setting up NeverQuestAlone:\n[\s\S]*Connect your AI in the app\./);
});

// ---------------------------------------------------------------- UX-1

test('UX-1: the light, the HUD and the header speak the provider\'s words for each rt state, never the retired build\'s', async (t) => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  vm.run('NS.HUD.Render()');
  let [state, tip] = light(vm);
  assert.equal(state, 'green');
  assert.match(tip, /^Connected to Anthropic \(Haiku 4\.5\)\. Last heard from the NeverQuestAlone app \d+ seconds? ago\.$/);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  const cases = [
    ['no_key', 'grey', 'No key yet', 'Add your Anthropic key in the NeverQuestAlone app.'],
    ['key_invalid', 'red', 'Your Anthropic key was rejected', 'Replace it in the NeverQuestAlone app.'],
    ['slowed', 'yellow', 'Anthropic asked NeverQuestAlone to slow down', 'Trying again in 18 seconds.'],
    ['out_of_credit', 'red', 'Your Anthropic account is out of credit', 'Add credit at Anthropic, or pick another AI in the NeverQuestAlone app.'],
    ['cap', 'yellow', 'You\'ve reached your daily spend limit ($1.00)', 'Raise it in the NeverQuestAlone app, or it resets at midnight.'],
    ['provider_down', 'yellow', 'Anthropic is busy right now', 'Trying again…'],
    ['paused', 'grey', 'NeverQuestAlone is paused', 'Messages wait until you resume it in the app.'],
  ];
  vm.slash('');
  const tips = [];
  for (const [st, color, head, sub] of cases) {
    // Without bridge.usage.needs, so the HUD's connection line says it (the spend line says it otherwise).
    // The cap only ever with a daily limit the player set (usage.capMicros): no limits of ours.
    apply(vm, byokSlot({ rt: `{ state = "${st}", retryIn = 18 }`, ...(st === 'cap' ? { u: capped() } : {}) }));
    [state, tip] = light(vm);
    assert.equal(state, color, st);
    assert.ok(tip.startsWith(`${head}. ${sub}`), `${st}: ${tip}`);
    assert.doesNotMatch(tip, NO_OC, st);
    tips.push(tip);
    vm.run('NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), head, `HUD ${st}`);
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), sub, `HUD sub ${st}`);
    vm.run('NS.Refresh("status")');
    assert.ok(vm.evaluate('NS.UI.ui.status.text').includes(`${head}. ${sub}`), `header ${st}`);
  }
  // The retry counts down from the slot.
  apply(vm, byokSlot({ rt: '{ state = "slowed", retryIn = 18 }' }));
  vm.advance(5);
  assert.ok(light(vm)[1].startsWith('Anthropic asked NeverQuestAlone to slow down. Trying again in 13 seconds.'));
  // A local model that isn't running: the companion names it; the failed message waits for Retry on its bubble (C-12, PRD §10).
  apply(vm, byokSlot({ p: provider({ id: 'ollama', name: 'Ollama', auth: 'local', privacy: 'local', modelName: 'qwen3:8b', model: 'qwen3:8b' }), rt: '{ state = "local_down" }' }));
  assert.deepEqual(light(vm).map(String).slice(0, 1), ['red']);
  assert.ok(light(vm)[1].startsWith('NeverQuestAlone can\'t reach Ollama. Start Ollama, then click Retry on your message.'), light(vm)[1]);
  apply(vm, byokSlot({ p: provider({ id: 'lmstudio', name: 'LM Studio', auth: 'local', privacy: 'local', modelName: 'qwen3-8b', model: 'qwen3-8b' }), rt: '{ state = "local_down" }' }));
  assert.ok(light(vm)[1].startsWith('NeverQuestAlone can\'t reach LM Studio. Start LM Studio, then click Retry on your message.'), light(vm)[1]);
  // Slower replies, from the addon's own self-test: game sound off (no "slow mode" in the player's words).
  apply(vm, byokSlot());
  vm.run('STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest()');
  assert.match(light(vm)[1], /\nReplies are slow with game sound off: keep Enable Sound on in WoW's sound settings \(the volume can be 0\)\.$/);
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), 'Replies are slow with game sound off. Keep Enable Sound on in WoW\'s sound settings (the volume can be 0).');
  // No session key in the light's tooltip.
  assert.equal(vm.evaluate('NS.UI.ui.light.session'), null);
  tips.push(light(vm)[1]);
  await t.test('no private term in any tooltip (SCRUB_TERMS)', { skip: PRIVATE_SKIP }, async () => {
    assert.deepEqual((await privateTerms()).hits(tips), []);
  });
});

test('UX-1: a silent BYOK bridge is "NeverQuestAlone", before and after a reload; the gw fallback names the provider', () => {
  const vm = byok();
  assert.equal(vm.evaluate('NQADB.backend'), null, 'nothing kept of which build a slot came from: there is one');
  vm.advance(200);
  const [state, tip] = light(vm);
  assert.equal(state, 'red');
  assert.match(tip, /^No word from the NeverQuestAlone app for 3 minutes\. Is it running\?/);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Can\'t reach the NeverQuestAlone app');
  // After a reload, before any slot: what the last one said.
  const vm2 = reloadVM(vm).login();
  assert.equal(vm2.evaluate('SLASH_BONES1'), '/nqa', '/nqa from load');
  assert.match(light(vm2)[1], /^Waiting to hear from the NeverQuestAlone app…$/);
  // A BYOK slot without rt: the gw words name the provider.
  confirmHello(vm2);
  apply(vm2, byokSlot({ rt: 'nil' }).replace('gw = { state = "ready"', 'gw = { state = "connecting"'));
  assert.equal(light(vm2)[1].split('\n')[0], 'The NeverQuestAlone app is running but can\'t reach Anthropic: connecting.');
});

// ---------------------------------------------------------------- UX-2

test('UX-2: error kinds: Okay on every error, Retry resends (the fix first: Retry, Okay, Show Details), "the NeverQuestAlone app" says where, Retry after an interruption; details a click away', () => {
  const vm = byok();
  vm.slash('');
  const id = activeId(vm);
  type(vm, 'where is the forge');
  const first = vm.outboxWires().length;
  apply(vm, byokSlot({ records: [errorRec(1, id, 'overloaded', 'retry', 'Anthropic is busy right now. Still busy. Try again in a minute.')] }));
  let e = vm.lastHistory();
  assert.deepEqual([e.kind, e.action, e.provider, e.model], ['overloaded', 'retry', 'Anthropic', 'Haiku 4.5']);
  let i = errBubble(vm);
  assert.ok(i, 'the error bubble has its parts');
  assert.deepEqual(acts(vm, i), ['Retry', 'Okay', 'Show Details']);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].details.shown`), 'false', 'details only on a click');
  // A plain click on the bubble does nothing new (it brings the window forward, C-22); Show Details opens them.
  vm.run(`local b = NS.UI.ui.bubbles[${i}]; b.scripts.OnMouseUp(b, "LeftButton")`);
  i = errBubble(vm);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].details.shown`), 'false', 'a plain click opens nothing');
  click(vm, `NS.UI.ui.bubbles[${i}].acts[3]`);
  i = errBubble(vm);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].details.shown`), 'true');
  assert.match(vm.evaluate(`NS.UI.ui.bubbles[${i}].details.text`), /^What happened: your AI company is busy\.\nWhere: Anthropic · Haiku 4\.5\.\nWhen: 12:00\.\nRetry sends your message again\.$/);
  assert.deepEqual(acts(vm, i), ['Retry', 'Okay', 'Hide Details']);
  // Retry: the same words, as a new message; the error is put away.
  click(vm, `NS.UI.ui.bubbles[${i}].acts[1]`);
  assert.equal(vm.outboxWires().length, first + 1);
  assert.ok(vm.outboxWires()[first].wire.endsWith('\x1fwhere is the forge') || vm.outboxWires()[first].wire.includes('where is the forge'));
  e = vm.json(`(function() for i = #NS.Chats.Active().history, 1, -1 do local x = NS.Chats.Active().history[i]; if x.err then return x end end end)()`);
  assert.equal(e.okay, true);
  // In the app: a line that says so, Retry for after the fix (C-09), Okay and Show Details.
  apply(vm, byokSlot({ records: [errorRec(2, id, 'region_blocked', 'desktop', 'Anthropic isn\'t available where you are.')] }));
  i = errBubble(vm);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.text`), 'Fix it in the NeverQuestAlone app.');
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), 'true');
  assert.deepEqual(acts(vm, i), ['Retry', 'Okay', 'Show Details']);
  // Okay: the buttons and the line go; the bubble stays in the chat.
  const before = vm.history().length;
  click(vm, `NS.UI.ui.bubbles[${i}].acts[2]`);
  assert.equal(vm.lastHistory().okay, true);
  assert.equal(vm.history().length, before);
  i = errBubble(vm);
  assert.deepEqual(acts(vm, i), []);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), 'false');
  // Interrupted by a restart: Retry, whatever the action says (one resend label).
  type(vm, 'plan my evening');
  apply(vm, byokSlot({ records: [errorRec(3, id, 'interrupted', 'none', 'NeverQuestAlone restarted before NeverQuestAlone answered.')] }));
  i = errBubble(vm);
  assert.equal(vm.lastHistory().action, 'send_again');
  assert.deepEqual(acts(vm, i), ['Retry', 'Okay', 'Show Details']);
  const n = vm.outboxWires().length;
  click(vm, `NS.UI.ui.bubbles[${i}].acts[1]`);
  assert.equal(vm.outboxWires().length, n + 1);
  assert.ok(vm.outboxWires()[n].wire.includes('plan my evening'));
  // Nothing acked to answer, and the turn before it the game's: nothing of yours to send again.
  apply(vm, byokSlot({ records: [errorRec(4, id, 'network_after_send', 'send_again', 'No answer: the connection dropped.')] }));
  vm.run(`local c = NS.Chats.Active(); table.insert(c.history, #c.history, { role = "user", event = "level_up", text = "Level 8", t = time() }); NS.R.rev[c.id] = 99; NS.Refresh()`);
  assert.deepEqual(acts(vm, errBubble(vm)), ['Okay', 'Show Details']);
  // An error whose own words already name the app (the bridge's), or say "on your desktop" (an older bridge's), doesn't get the line too.
  apply(vm, byokSlot({ records: [errorRec(5, id, 'out_of_credit', 'desktop', 'Anthropic is out of credit. Add credit, or pick another provider on your desktop.')] }));
  i = errBubble(vm);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), 'false', 'said once');
  assert.deepEqual(acts(vm, i), ['Okay', 'Show Details']);
  apply(vm, byokSlot({ records: [errorRec(6, id, 'auth_invalid', 'desktop', 'Your Anthropic key was rejected. Replace it in the NeverQuestAlone app.')] }));
  i = errBubble(vm);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].hint.shown`), 'false', 'one next step, not two (UX-W21)');
});

test('UX-2: the light\'s reasons and a warning\'s details are a click away (cap ekind); the flash says so', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  vm.run('NS.Transport.Warn("t", "The whole long story about the doorbells.", "Replies come slower this session")');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Replies come slower this session');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click to see it all in the window.', 'where the click goes (UX-W23)');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true');
  vm.run('NS.Chats.DismissNotice(NQADB.activeChat)');
  click(vm, 'NS.HUD.h.statusBtn');
  assert.equal(vm.evaluate('NS.UI.IsOpen()'), 'true', 'the window opens on it');
  assert.equal(notice(vm), 'The whole long story about the doorbells.');
  // The light: click, and its reasons are in the window.
  apply(vm, byokSlot({ rt: '{ state = "key_invalid" }' }));
  vm.run('NS.Refresh("status")');
  vm.run('local l = NS.UI.ui.light; l.scripts.OnMouseUp(l, "LeftButton")');
  assert.match(notice(vm), /^Your Anthropic key was rejected\. Replace it in the NeverQuestAlone app\. Last heard from the NeverQuestAlone app /);
  // Its tooltip says where the click goes (UX-W23, STYLE §4's action line).
  vm.run('STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; local l = NS.UI.ui.light; l.scripts.OnEnter(l)');
  assert.ok(vm.list('STUB.tip').includes('<Click to see this in the window>'), vm.list('STUB.tip').join('|'));
  // The HUD's connection line opens the same.
  vm.advance(13);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Your Anthropic key was rejected');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true');
  // Ready: the warning is still said, with its Okay (C-13: a state line, never a timer).
  apply(vm, byokSlot());
  vm.advance(60);
  vm.run('NS.UI.Close(); NS.HUD.Render()'); // the whole panel (with the window open it's one line)
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Replies come slower this session');
  assert.equal(vm.evaluate('NS.HUD.h.warnOk.shown'), 'true');
  click(vm, 'NS.HUD.h.warnOk');
  // Put away: nothing to open, and the status line lets clicks reach the world.
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'false');
  assert.equal(vm.evaluate('NS.HUD.h.warnOk.shown'), 'false');
});

// ---------------------------------------------------------------- UX-3

test('UX-3: the usage line in the header: today\'s spend (no limit of ours), against a limit only when the player set one, a key balance, free models and a local model; hidden without the cap', () => {
  const vm = byok();
  vm.slash('');
  vm.run('NS.Refresh("status")');
  const line = () => vm.evaluate('NS.UI.ui.usage ~= nil and NS.UI.ui.usage.shown') === 'true' ? vm.evaluate('NS.UI.ui.usage.label.text') : null;
  assert.equal(line(), '$0.18 today', 'no limit of ours: spend as information');
  apply(vm, byokSlot({ u: capped() }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), '$0.18 of $1.00 today', 'the daily limit the player set');
  // Cap words only with a limit: a near_cap with no limit set (never sent) colours nothing and says nothing.
  apply(vm, byokSlot({ u: usage({ needs: 'near_cap' }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), '$0.18 today');
  assert.equal(vm.evaluate('NS.HUD.SpendLine()'), null);
  apply(vm, byokSlot({ u: usage({ keyLeftMicros: 4120000 }), p: provider({ id: 'openrouter', name: 'OpenRouter' }) }));
  vm.run('NS.Refresh("status")');
  // [ingame-clarity] Under 480 wide (the window opens at 420) the line's first part, so the chat's name
  // keeps its room; the rest is in the usage panel. Wider (the chat list shown), all of it.
  assert.equal(line(), '$0.18 today');
  assert.equal(vm.evaluate('NS.UI.UsageLine()'), '$0.18 today · $4.12 left on your key', 'the line itself');
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b); NS.Refresh("status")');
  assert.equal(line(), '$0.18 today · $4.12 left on your key', 'wider: all of it');
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b); NS.Refresh("status")');
  apply(vm, byokSlot({ u: usage({ freeUsed: 12, freeLimit: 50, spentMicros: 0 }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), 'Free: 12 of 50 requests today');
  // A local model: named once, in the header beside it (C-17), with no effort it can't honour.
  apply(vm, byokSlot({ p: provider({ id: 'ollama', name: 'Ollama', auth: 'local', privacy: 'local', modelName: 'qwen3:8b', effortSupported: false, effort: null }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), 'On this computer · Ollama');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'qwen3:8b');
  apply(vm, byokSlot({ u: usage({ exact: false }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), '~$0.18 today', 'an estimate says so');
  apply(vm, byokSlot({ u: capped({ spentMicros: 1000000, needs: 'cap' }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), '|cffff5555$1.00 of $1.00 today|r', 'red when spend needs you');
  // Without the usage cap: no line.
  apply(vm, byokSlot({ caps: '"state", "evt", "think", "provider", "ekind", "model"' }));
  vm.run('NS.Refresh("status")');
  assert.equal(line(), null);
});

test('UX-3: a click on the usage line opens a small panel (provider, model, today\'s spend, messages and the companion\'s remarks as information, no limits of ours; a limit and when it resets only with one the player set; rate limit, last reply); Okay closes it', () => {
  const vm = byok({ slot: { u: usage({ autoOn: true }) } });
  vm.slash('');
  const id = activeId(vm);
  apply(vm, byokSlot({ u: usage({ autoOn: true }), records: [replyRec(1, id, 'Head north.', ', usage = { ["in"] = 1100, out = 134, micros = 4000, model = "claude-haiku-4-5", exact = true }')] }));
  vm.run('NS.Refresh("status")');
  click(vm, 'NS.UI.ui.usage');
  assert.equal(vm.evaluate('NQAUsage.shown'), 'true');
  assert.equal(vm.evaluate('NQAUsage.title.text'), 'Usage Today');
  const body = () => vm.evaluate('NQAUsage.body.text');
  assert.equal(body(), [
    'Anthropic · Haiku 4.5 · Thinking: Low',
    'Today: $0.18 · 23 messages',
    'Check-ins: 4 today',
    'Last reply: 0.4¢',
  ].join('\n'));
  assert.doesNotMatch(body(), /limit|left today|allow|a day| of \d| of \$|tokens|effort|remark/i, 'no limit of ours, no allowance; the glossary\'s words');
  apply(vm, byokSlot({ u: usage({ autoOn: true, auto: 1, turns: 1 }) }));
  vm.run('NS.Refresh("status")');
  assert.ok(body().includes('Today: $0.18 · 1 message\nCheck-ins: 1 today\n'), body());
  // The companion off in the app: said, with no count.
  apply(vm, byokSlot({ u: usage({ autoOn: false }) }));
  vm.run('NS.Refresh("status")');
  assert.ok(body().includes('\nCheck-ins: off in the NeverQuestAlone app\n'), body());
  // A daily limit the player set: spend against it, and when it resets; near it, then at it.
  apply(vm, byokSlot({ u: capped({ autoOn: true, spentMicros: 820000, needs: 'near_cap' }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(body(), [
    'Anthropic · Haiku 4.5 · Thinking: Low',
    'Today: $0.82 of $1.00 · 23 messages',
    'Check-ins: 4 today',
    'Your daily spend limit resets at midnight, in 12 hours.',
    'Last reply: 0.4¢',
  ].join('\n'));
  apply(vm, byokSlot({ u: capped({ autoOn: true, spentMicros: 1000000, needs: 'cap' }), rt: '{ state = "cap" }' }));
  vm.run('NS.Refresh("status")');
  assert.ok(body().includes('Today: $1.00 of $1.00 · 23 messages\n'), body());
  assert.ok(body().includes('\nYour daily spend limit resets at midnight, in 12 hours.\n'), body());
  // Slowed: the panel says by whom and for how long.
  apply(vm, byokSlot({ rt: '{ state = "slowed", retryIn = 18 }', u: usage({ needs: 'slowed' }) }));
  vm.run('NS.Refresh("status")');
  assert.ok(body().includes('Anthropic asked NeverQuestAlone to slow down: trying again in 18 seconds.'), body());
  click(vm, 'NQAUsage.okay');
  assert.equal(vm.evaluate('NQAUsage.shown'), 'false');
  // /nqa usage says the same lines.
  apply(vm, byokSlot({ u: usage({ autoOn: true }) }));
  vm.slash('usage');
  assert.ok(notice(vm).startsWith('Anthropic · Haiku 4.5 · Thinking: Low\nToday: $0.18 · 23 messages\nCheck-ins: 4 today'), notice(vm));
  assert.equal(vm.outboxWires().some(e => e.wire.includes('usage')), false, 'a command, not a message');
});

test('UX-3: the HUD says nothing about spend while all is well; one spend line with Okay when usage.needs is set, until it changes', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'all is well: nothing about spend');
  apply(vm, byokSlot({ u: capped({ spentMicros: 820000, needs: 'near_cap' }) }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.spend.text'), 'You\'ve used $0.82 of your $1.00 daily spend limit.');
  assert.equal(vm.evaluate('NS.HUD.h.spendOk.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready', 'one line, not the header too');
  click(vm, 'NS.HUD.h.spendOk');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'Okay puts it away');
  assert.equal(vm.evaluate('NQADB.spendOkay'), '2026-09-26:near_cap');
  apply(vm, byokSlot({ u: capped({ spentMicros: 820000, needs: 'near_cap' }) }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'still put away: nothing changed');
  // It changes: the cap is reached and holds the backend. The status line is the
  // state, in red, with what to do under it (C-02); no second line says it again.
  apply(vm, byokSlot({ u: capped({ spentMicros: 1000000, needs: 'cap' }), rt: '{ state = "cap" }' }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'You\'ve reached your daily spend limit ($1.00)');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.13, 0.13]);
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Raise it in the NeverQuestAlone app, or it resets at midnight.');
  assert.equal(vm.evaluate('NS.HUD.h.dot.shown'), 'true', 'the red dot');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'said once');
  assert.equal(vm.evaluate('NS.HUD.h.spendOk.shown'), 'false', 'no Okay for a state: it stays until it changes');
  // A held backend on the free models, the next day: its own words.
  apply(vm, byokSlot({ u: usage({ day: '2026-09-27', freeUsed: 50, freeLimit: 50, needs: 'cap', spentMicros: 0 }), rt: '{ state = "cap" }' }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'You\'ve used today\'s 50 free requests');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false');
  // The provider's day isn't ours: no midnight guess. With the backend's countdown, its clock time.
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Pick another model in the NeverQuestAlone app, or wait until it resets.');
  apply(vm, byokSlot({ u: usage({ day: '2026-09-27', freeUsed: 50, freeLimit: 50, needs: 'cap', spentMicros: 0 }), rt: '{ state = "cap", retryIn = 3600 }' }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'It resets at 12:00.', 'the stub\'s date() says 12:00');
  // Out of credit and a bad key, in red; the free tier's own words.
  for (const [needs, text] of [['out_of_credit', 'Your Anthropic account is out of credit. Add credit at Anthropic, or pick another AI in the NeverQuestAlone app.'],
    ['key_invalid', 'Your Anthropic key was rejected. Replace it in the NeverQuestAlone app.']]) {
    apply(vm, byokSlot({ u: usage({ needs }) }));
    vm.run('NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.spend.text'), text);
    assert.deepEqual(vm.json('NS.HUD.h.spend.textColor'), [1, 0.13, 0.13]);
  }
  apply(vm, byokSlot({ u: usage({ day: '2026-09-28', freeUsed: 50, freeLimit: 50, needs: 'cap' }) }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.spend.text'), 'You\'ve used today\'s 50 free requests. It resets tomorrow.');
  // Back to normal: gone.
  apply(vm, byokSlot());
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false');
});

test('UX-3: a reply\'s cost shows under it only with the setting on (off by default); the Settings switch and /nqa cost', () => {
  const vm = byok();
  vm.slash('');
  const id = activeId(vm);
  assert.equal(vm.evaluate('NQADB.settings.replyCost'), 'false');
  apply(vm, byokSlot({ records: [replyRec(1, id, 'Head north.', ', usage = { ["in"] = 1100, out = 134, micros = 4000, model = "claude-haiku-4-5", exact = true }')] }));
  assert.deepEqual(vm.lastHistory().usage, { tin: 1100, tout: 134, micros: 4000, model: 'claude-haiku-4-5', exact: true });
  const cost = () => vm.evaluate('NS.UI.ui.bubbles[1].cost.shown') === 'true' ? vm.evaluate('NS.UI.ui.bubbles[1].cost.text') : null;
  assert.equal(cost(), null, 'no cost by default');
  vm.slash('cost on');
  assert.equal(cost(), '0.4¢', 'the cost alone (STYLE §10: no tokens)');
  apply(vm, byokSlot({ records: [replyRec(2, id, 'Then east.', ', usage = { ["in"] = 300, out = 12, micros = 400, exact = false }')] }));
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[2].cost.text'), '~<0.1¢', 'an estimate says so');
  vm.slash('cost off');
  assert.equal(cost(), null);
  // The Settings page has the switch once a slot said BYOK (it registers at login).
  const vm2 = reloadVM(vm).login();
  const MAIN_LABELS = '(function() local out = {} for _, sw in ipairs(NS.Settings.SWITCHES) do if not sw.when or sw.when() then out[#out + 1] = sw[2] end end return out end)()';
  const labels = vm2.list(MAIN_LABELS);
  assert.ok(labels.includes('Reply Cost'), 'a toggle names its setting (UX-W05)');
});

// ---------------------------------------------------------------- UX-4

test('UX-4: the model and its thinking level in the header ("Haiku 4.5 · Low"); no menu when the model has none', () => {
  const vm = byok();
  vm.slash('');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · Low');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'true');
  assert.equal(vm.evaluate('NS.UI.ui.thinkArrow.shown'), 'true');
  vm.slash('think high');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · High |cff9d9d9d(from your next message)|r');
  apply(vm, byokSlot({ p: provider({ modelName: 'GPT-5 mini', model: 'gpt-5-mini', effortSupported: false, effort: null, id: 'openai', name: 'OpenAI' }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'GPT-5 mini');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'false', 'no menu');
  assert.equal(vm.evaluate('NS.UI.ui.thinkArrow.shown'), 'false');
  const n = vm.outboxWires().length;
  vm.slash('think medium');
  assert.equal(notice(vm), 'GPT-5 mini has no thinking levels. Nothing changed.');
  assert.equal(vm.outboxWires().length, n, 'nothing sent');
});

// ---------------------------------------------------------------- UX-5

test('UX-6: /nqa model <id> (a patch with model=) and /nqa usage are commands; the old roadmap\'s words are messages', () => {
  const vm = byok();
  vm.slash('');
  const id = activeId(vm);
  // /nqa model <id>: a patch record carrying model=.
  vm.slash('model claude-sonnet-4-5');
  const wire = vm.outboxWires().at(-1).wire;
  assert.ok(wire.includes('\x1fpatch\x1f' + id + '\x1f'), wire);
  assert.ok(wire.includes('model=claude-sonnet-4-5'), wire);
  // Asked for, not in effect (C-11): the header keeps the model in use and says what's asked.
  assert.equal(notice(vm), 'Asked for claude-sonnet-4-5 in this chat, from your next message (if your AI company offers it).');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · Low |cff9d9d9d(asked for claude-sonnet-4-5)|r');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").model`), null, 'not the chat\'s model until the bridge says so');
  vm.slash('model');
  assert.match(notice(vm), /^Model: Haiku 4\.5\. You asked for claude-sonnet-4-5: it starts with your next message, if your AI company offers it\. \/nqa model <id> changes it for this chat \(\/nqa model default goes back\); the NeverQuestAlone app lists the IDs\.$/);
  // A reply from that model (its usage.model) says it took.
  apply(vm, byokSlot({ records: [replyRec(1, id, 'Hi.', ', usage = { ["in"] = 10, out = 2, micros = 100, model = "claude-sonnet-4-5", exact = true }')] }));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'claude-sonnet-4-5 · Low');
  vm.slash('model');
  assert.match(notice(vm), /^Model in this chat: claude-sonnet-4-5\. \/nqa model <id> changes it/);
  vm.slash('model default');
  assert.ok(vm.outboxWires().at(-1).wire.includes('model=default'));
  assert.equal(notice(vm), 'The model in this chat goes back to the default from your next message.');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'claude-sonnet-4-5 · Low |cff9d9d9d(asked for the default model)|r');
  // The chats snapshot without a model of its own: the default is in effect.
  apply(vm, byokSlot().replace('chats = {}', `chats = { { id = "${id}", busy = false, queued = 0 } }`));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · Low');
  vm.slash('model');
  assert.match(notice(vm), /^Model: Haiku 4\.5\. \/nqa model <id> changes it/);
  const n = vm.outboxWires().length;
  vm.slash('model bad;id');
  assert.equal(notice(vm), 'That isn\'t a model ID (letters, digits and . _ : / - only). Nothing changed.');
  assert.equal(vm.outboxWires().length, n);
  // The old roadmap (M2): words for the companion.
  for (const w of ['attach sponsor thread', 'steer go left', 'inbox', 'more']) {
    vm.slash(w);
    assert.ok(sentText(vm, w), w);
  }
});

test('UX-7: /nqa diag hides the install token; /nqa diag full shows it; the backend in its own words', () => {
  const vm = byok();
  vm.slash('');
  const token = vm.evaluate('NQADB.token');
  vm.slash('diag');
  let d = notice(vm);
  assert.ok(!d.includes(token), 'no token');
  assert.match(d, /token hidden \(\/nqa diag full shows it\)/);
  assert.match(d, /\nProvider: Anthropic; model Haiku 4\.5; key, key ok; cloud-no-train\n/);
  assert.match(d, /\nBackend: ready; queued 0\n/);
  assert.match(d, /\nUsage: Anthropic · Haiku 4\.5 · Thinking: Low; Today: \$0\.18 · 23 messages/);
  assert.doesNotMatch(d, /Gateway:/);
  vm.slash('diag full');
  d = notice(vm);
  assert.ok(d.includes(`token ${token}`));
  vm.slash('diag nostics');
  assert.ok(sentText(vm, 'diag nostics'), 'diag takes only "full"');
  // Before the app names its provider: no gateway line, the app's own words.
  const early = confirmHello(newVM().login());
  early.slash('diag');
  const ed = early.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
  assert.match(ed, /\nProvider: no report from NeverQuestAlone yet\n/);
  assert.doesNotMatch(ed, /Gateway:|bridge/);
});

// ---------------------------------------------------------------- UX-8

test('UX-8: the setup checklist, filled from the slots, in an empty chat and at /nqa setup; a copy box for what to type; no key asked for', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  apply(vm, byokSlot({ rt: '{ state = "no_key" }', p: provider({ keyState: 'missing' }) }));
  const body = () => vm.evaluate('NS.UI.ui.bubbles[1].body.text');
  const READY = '|A:UI-LFG-ReadyMark:14:14|a', TODO = '|A:UI-LFG-PendingMark:14:14|a';
  // STYLE §1's order and words (UX-W01): the app, your AI, then the game read.
  assert.equal(body(), [
    'Setting up NeverQuestAlone:',
    `${READY} The addon is loaded (${VERSION}).`,
    `${READY} The NeverQuestAlone app is running.`,
    `${TODO} Add your Anthropic key in the app.`,
    `${READY} The app can see WoW.`,
    `${TODO} Say hi once the steps above are done.`,
  ].join('\n'));
  assert.ok(vm.evaluate('NS.UI.StatusText()').includes('No key yet. Add your Anthropic key in the NeverQuestAlone app.'), 'the status line and the list say the same');
  assert.doesNotMatch(body(), /enter|paste|type your key/i, 'nothing asks for a key in game');
  // Say hi is offered once it can work (C-26): not before a key.
  const chip = () => vm.evaluate('NS.UI.ui.bubbles[1].chips[1] and NS.UI.ui.bubbles[1].chips[1].shown and NS.UI.ui.bubbles[1].chips[1].label.text or nil');
  assert.equal(chip(), null);
  // A key: the row fills in at the next slot, and the one ask is one click (C-06): Say hi sends "hi".
  apply(vm, byokSlot());
  assert.ok(body().includes(`${READY} Connected to Haiku 4.5.`), body());
  assert.ok(body().endsWith(`${TODO} Say hi: click Say Hi, or type hi below.`));
  assert.equal(chip(), 'Say Hi', 'Title Case, as the HUD\'s red button (spec §3.10 G2)');
  assert.equal(vm.outboxWires().length, 0);
  vm.run('local c = NS.UI.ui.bubbles[1].chips[1]; c.scripts.OnClick(c)');
  assert.ok(sentText(vm, 'hi'), 'the chip sends hi');
  vm.run(`local c = NS.Chats.Active(); c.history = {}; c.pending = {}; NS.R.rev[c.id] = 77; NS.Refresh()`);
  // A rejected key says where to fix it.
  apply(vm, byokSlot({ rt: '{ state = "key_invalid" }', p: provider({ keyState: 'invalid' }) }));
  assert.ok(body().includes(`${TODO} Replace your Anthropic key in the app.`), body());
  // Game sound off: slower replies, and what to do.
  vm.run('STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest(); NS.Refresh()');
  assert.ok(body().endsWith('|cffffd100Replies are slow with game sound off: keep Enable Sound on in WoW\'s sound settings (the volume can be 0).|r'), body());
  // /nqa setup: the same rows.
  vm.slash('setup');
  assert.match(notice(vm), /^Setting up NeverQuestAlone:\n/);
  // A first reply, everything works: the empty chat's usual hint.
  vm.run('STUB.cvars.Sound_EnableAllSound = "1"; STUB.sounds["Interface\\\\AddOns\\\\NeverQuestAlone\\\\sig\\\\ctl\\\\present.wav"] = true; NS.Transport.SelfTest()');
  apply(vm, byokSlot());
  vm.run('NQADB.firstReply = true');
  vm.slash('new Fresh');
  assert.equal(body(), 'Shift-click an item, spell or quest to link it into your message. Click the portrait for Settings and key bindings.');
  vm.slash('setup');
  assert.ok(notice(vm).endsWith('\nAll set.'));
});

// ---------------------------------------------------------------- KY-10

const KEYS = [
  'sk-ant-api03-CANARYabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP',
  'sk-proj-CANARYabcdefghijklmnopqrstuvwxyz0123',
  'sk-svcacct-CANARYabcdefghijklmnopqrstuv',
  'sk-admin-CANARYabcdefghijklmnopqrstuvwx',
  'sk-CANARYabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ',
  'sk-or-v1-CANARY0123456789abcdef0123456789abcdef',
  'AIzaSyCANARY_abcdefghijklmnopqrstuvwxyz0',
  'AQ.CANARYabcdefghijklmnopqrstuvwxyz0123',
  'xai-CANARYabcdefghijklmnopqrstuvwxyz0123456789',
];

test('UX-3: Okay on the spend line holds only while the usage says the same; once it clears or changes, the same words later that day show again', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  const shown = () => { vm.run('NS.HUD.Render()'); return vm.evaluate('NS.HUD.h.spend.shown') === 'true'; };
  apply(vm, byokSlot({ u: usage({ needs: 'key_invalid' }) }));
  assert.ok(shown());
  click(vm, 'NS.HUD.h.spendOk');
  assert.ok(!shown());
  apply(vm, byokSlot({ u: usage({ needs: 'key_invalid' }) }));
  assert.ok(!shown(), 'the same state: still put away');
  apply(vm, byokSlot());
  assert.equal(vm.evaluate('NQADB.spendOkay'), null, 'the key was fixed: the Okay is spent');
  apply(vm, byokSlot({ u: usage({ needs: 'key_invalid' }) }));
  assert.ok(shown(), 'rejected again the same day: said again');
  // Near the cap, put away; the key rejected: said; near the cap again: said again.
  apply(vm, byokSlot({ u: capped({ needs: 'near_cap', spentMicros: 820000 }) }));
  vm.advance(1); // main's guard: a second click within 0.4 s of the last Okay passes (C-72)
  click(vm, 'NS.HUD.h.spendOk');
  assert.ok(!shown());
  apply(vm, byokSlot({ u: usage({ needs: 'key_invalid' }) }));
  assert.ok(shown());
  apply(vm, byokSlot({ u: capped({ needs: 'near_cap', spentMicros: 820000 }) }));
  assert.ok(shown(), 'near the cap a second time');
  // Slowed passes on its own: no spend line and no Okay for it (C-03).
  apply(vm, byokSlot({ u: usage({ needs: 'slowed' }) }));
  assert.ok(!shown(), 'slowed: nothing to put away');
});

test('UX-4, C-16: the header in main\'s Thinking control stops short of the Game data label: a long model name is cut on one line, the effort kept; a pending note goes to the status line', () => {
  const METRICS = fs.readFileSync(path.join(__dirname, '..', 'render_ui.js'), 'utf8').match(/const METRICS = `([\s\S]*?)`;/)[1];
  const vm = confirmHello(newVM({ extra: METRICS }).login());
  apply(vm, byokSlot({ p: provider({ modelName: 'Claude Sonnet 4.5', model: 'claude-sonnet-4-5' }) }));
  vm.slash('');
  // The context row at the window's narrowest (the stub doesn't size a frame from two anchors).
  vm.run('NS.UI.ui.ctx:SetWidth(260)');
  vm.slash('think high');
  vm.run('NS.Refresh("status")');
  const n = expr => Number(vm.evaluate(expr));
  const avail = () => n('NS.UI.ui.ctx:GetWidth()') - (n('NS.UI.ui.ctx.toggle:GetWidth()') - 3 + 2) - n('NS.UI.ui.ctx.text:GetStringWidth()') - 12
    - (vm.evaluate('NS.UI.ui.thinkArrow.shown') === 'true' ? 3 + n('NS.UI.ui.thinkArrow:GetWidth()') : 0);
  assert.doesNotMatch(vm.evaluate('NS.UI.ui.header.text'), /from your next message/, 'the note never where the cut would land');
  assert.match(vm.evaluate('NS.UI.ui.header.text'), /^Claude Sonn.*… · High$/, 'the name gives way, the level stays');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), '|cff9d9d9dThinking: High, from your next message.|r', 'the note as a sentence on the status line');
  assert.ok(n('NS.UI.ui.header:GetWidth()') <= avail(), `the header (${n('NS.UI.ui.header:GetWidth()')}) fits the row (${avail()})`);
  assert.equal(vm.evaluate('NS.UI.ui.header.wordWrap'), 'false', 'one line, cut');
  assert.equal(vm.evaluate('NS.UI.ui.thinkArrow.shown'), 'true', 'its arrow after it');
  // Once the effort is in effect (the chats snapshot says so), the note goes; a short name keeps its width.
  const id = vm.evaluate('NQADB.activeChat');
  apply(vm, byokSlot().replace('chats = {}', `chats = { { id = "${id}", busy = false, queued = 0, effort = "high" } }`));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · High');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), '', 'nothing pending: nothing on the status line');
  assert.equal(n('NS.UI.ui.header:GetWidth()'), Math.ceil(n('NS.UI.ui.header:GetStringWidth()')) + 1);
});

test('UX-3: the Settings page has a "Usage Today" row with NeverQuestAlone, one click from today\'s usage in the chat frame; no search tags', () => {
  const SETTINGS = `
STUB.inits = {}
Settings = {
	RegisterVerticalLayoutCategory = function(name) STUB.category = { name = name, GetID = function() return 42 end }; return STUB.category, {} end,
	RegisterInitializer = function(cat, i) table.insert(STUB.inits, i) end,
	RegisterProxySetting = function(cat, var, vt, name, def, get, set) return { var = var, name = name } end,
	CreateCheckbox = function() end, CreateDropdown = function() end,
	CreateControlTextContainer = function() local c = { data = {} }; function c:Add(v, l) table.insert(self.data, { value = v, label = l }) end; function c:GetData() return self.data end; return c end,
	CreateSliderOptions = function() return {} end, CreateSlider = function() end,
	RegisterAddOnCategory = function() end, OpenToCategory = function() end,
}
function CreateSettingsListSectionHeaderInitializer(name) return { header = name } end
function CreateSettingsButtonInitializer(name, text, click, tip, tags) return { name = name, button = text, click = click, tags = tags, tip = tip } end
`;
  const row = v => v.json('(function() for _, i in ipairs(STUB.inits) do if i.name == "Usage Today" then return { button = i.button, tags = i.tags, tip = i.tip } end end end)()');
  const headers = v => v.list('(function() local o = {} for _, i in ipairs(STUB.inits) do if i.header then o[#o + 1] = i.header end end return o end)()');
  // An app install: the page is made at its first slot (C-18).
  const vm = byokFirst({ u: capped({ spentMicros: 1000000, needs: 'cap' }) }, { extra: SETTINGS });
  assert.equal(vm.evaluate('STUB.category.name'), 'NeverQuestAlone');
  assert.deepEqual(row(vm), { button: 'Show Usage', tags: false,
    tip: 'Shows today\'s spend and messages in your chat frame; you can set a daily spend limit in the NeverQuestAlone app.' });
  assert.deepEqual(headers(vm).slice(-2), ['Usage', 'Keys and Places'], 'its own header, before main\'s last one');
  vm.run('for _, i in ipairs(STUB.inits) do if i.name == "Usage Today" then i.click() end end');
  assert.ok(vm.chatLines().some(l => l.endsWith('Today: $1.00 of $1.00 · 23 messages')), vm.chatLines().join('|'));
});

test('UX-2 and UX-1: BYOK lines point at the click (cap ekind), and slow mode is named on the header and the HUD in the public build\'s words; the bridge\'s warnings are NeverQuestAlone\'s', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  // A backend that can't reach its provider (no rt): the details are a click on the line.
  apply(vm, byokSlot({ rt: 'nil' }).replace('gw = { state = "ready"', 'gw = { state = "unreachable"'));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Can\'t reach Anthropic');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Click to see why in the window.', 'the line above names what; the click, where it goes (UX-W23)');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true');
  // Slower replies for a reason other than sound: its own words, on the header and the HUD's second line.
  apply(vm, byokSlot());
  vm.run('STUB.cvars.Sound_EnableAllSound = "1"; STUB.sounds = {}; NS.Transport.SelfTest()');
  vm.run('NS.UI.Toggle(true); NS.Refresh("status"); NS.HUD.Render()'); // the window's status line, drawn while it shows (code health AD-18)
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), 'Replies come a little slower for now.');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Replies come a little slower for now.');
  assert.equal(vm.evaluate('NS.HUD.h.statusBtn.shown'), 'true', 'the rest a click away');
  assert.doesNotMatch(vm.evaluate('NS.UI.ui.light.tip'), /Slot-only|doorbell/);
  vm.run('STUB.cvars.Sound_EnableAllSound = "0"; NS.Transport.SelfTest(); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Replies are slow with game sound off.');
  // The bridge's warning, a note from the app by its name.
  apply(vm, byokSlot().replace('bridge = { ver = "1.4.0",', 'bridge = { ver = "1.4.0", warn = "the model list is old",'));
  assert.equal(notice(vm), 'A note from the NeverQuestAlone app: the model list is old');
  assert.match(vm.evaluate('NS.UI.ui.light.tip'), /\nA note from the NeverQuestAlone app: the model list is old$/);
  vm.run('NS.Transport.Warn("t2", "Something.")');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'A note from the app');
  // A slot with none of the new caps: main's line, the same words since ux-copy-addon.
  const old = confirmHello(newVM().login());
  old.run('STUB.cvars.Sound_EnableAllSound = "1"; STUB.sounds = {}; NS.Transport.SelfTest(); NS.UI.Toggle(true); NS.Refresh("status")');
  assert.equal(old.evaluate('NS.UI.ui.status.text'), 'Replies come a little slower for now.');
});

test('patch day (SY-29): the app couldn\'t update the addon for a new World of Warcraft (bridge.patch "failed"): the addon\'s own line, once a session, names the one fix; nothing while the app could', () => {
  const LINE = "The NeverQuestAlone app couldn't update the addon for the new version of World of Warcraft. See the fix in the app.";
  const failed = () => byokSlot().replace('backend = "byok",', 'backend = "byok", patch = "failed",');
  const vm = byok();
  assert.equal(notice(vm), null, 'no line while the app could');
  apply(vm, failed());
  assert.equal(notice(vm), LINE);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'See the fix in the app');
  // Once a session: the next slots don't say it again.
  vm.run('NS.R.notices[NQADB.activeChat] = nil');
  apply(vm, failed());
  assert.equal(notice(vm), null);
});

test('SY-27: /nqa perf says the addon\'s memory and frame time in two lines: the game\'s own profiler at once; without it, the addon\'s checks and its corner timed for 5 seconds; nothing is timed before it\'s typed', () => {
  // The game's own addon profiler (the retail engine's C_AddOnProfiler).
  const vm = byok();
  vm.run(`
    STUB.memUpdates = 0
    function UpdateAddOnMemoryUsage() STUB.memUpdates = STUB.memUpdates + 1 end
    function GetAddOnMemoryUsage(name) if name == "NeverQuestAlone" then return 1843.2 end return 1.5 end
    C_AddOnProfiler = { IsEnabled = function() return true end, GetAddOnMetric = function(name, m) if name ~= "NeverQuestAlone" then return 99 end return m == 1 and 0.043 or 0.61 end }
    Enum.AddOnProfilerMetric = { SessionAverageTime = 0, RecentAverageTime = 1, EncounterAverageTime = 2, LastTime = 3, PeakTime = 4 }
  `);
  vm.slash('perf');
  assert.equal(notice(vm), 'The addon uses 1.8 MB of memory.\nIt takes 0.04 ms a frame on average, and 0.61 ms at most.');
  assert.equal(vm.num('STUB.memUpdates'), 1, 'memory read once, on the command');
  assert.equal(vm.evaluate('NS.R.perf'), null, 'nothing armed: the game measured it');
  // Without it: the addon's own busiest parts, timed only once the command arms them.
  const own = byok();
  own.run(`
    function UpdateAddOnMemoryUsage() end
    function GetAddOnMemoryUsage(name) if name == "NeverQuestAlone" then return 512 end return 0 end
    STUB.clockCalls = 0
    function debugprofilestop() STUB.clockCalls = STUB.clockCalls + 1; return STUB.clockCalls * 0.05 end
  `);
  own.advance(2);
  assert.equal(own.num('STUB.clockCalls'), 0, 'nothing timed before the command (the 0.25 s checks ran 8 times)');
  own.run('NS.R.notices[NQADB.activeChat] = nil');
  own.slash('perf');
  assert.equal(notice(own), null, 'the lines come when the time is up');
  for (let i = 0; i < 50; i++) { own.run('local f = NS.R.perfFrame; f.scripts.OnUpdate(f, 0.1)'); own.advance(0.1); }
  const lines = String(notice(own)).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'The addon uses 512 KB of memory.');
  const m = /^Over 5 seconds, its checks and what it draws for screen reading took (\d+\.\d\d) ms a frame on average, and (\d+\.\d\d) ms at most\.$/.exec(lines[1]);
  assert.ok(m, lines[1]);
  assert.ok(Number(m[1]) > 0 && Number(m[1]) <= Number(m[2]), lines[1]);
  assert.equal(own.evaluate('NS.R.perf'), null, 'disarmed');
  assert.equal(own.evaluate('NS.R.perfFrame.scripts.OnUpdate'), null, 'the frame counter is gone');
  const calls = own.num('STUB.clockCalls');
  own.advance(2);
  assert.equal(own.num('STUB.clockCalls'), calls, 'nothing timed after it');
  // In /nqa help all, in STYLE's shape.
  vm.slash('help all');
  assert.match(notice(vm), /\|cffffd100\/nqa perf\|r {2}Show the addon's memory and frame time\n/);
});

test('UX-3: the usage panel says a daily limit resets at midnight only when the player set one, and a free limit only when the bridge says when; UX-7: diag hides the other install\'s token too; UX-8: a hello by the reload path isn\'t capture', () => {
  const vm = byok();
  vm.slash('');
  apply(vm, byokSlot({ u: usage({ freeUsed: 50, freeLimit: 50, needs: 'cap' }), rt: '{ state = "cap" }' }));
  let lines = vm.list('NS.UI.UsageLines()');
  assert.ok(!lines.some(l => /midnight/.test(l)), `no limit of ours to reset: ${lines.join('|')}`);
  assert.ok(!lines.some(l => /reset at/.test(l)), 'no guess');
  apply(vm, byokSlot({ u: capped({ freeUsed: 50, freeLimit: 50, needs: 'cap' }), rt: '{ state = "cap" }' }));
  lines = vm.list('NS.UI.UsageLines()');
  assert.ok(lines.includes('Your daily spend limit resets at midnight, in 12 hours.'), lines.join('|'));
  apply(vm, byokSlot({ u: usage({ freeUsed: 50, freeLimit: 50, needs: 'cap' }), rt: '{ state = "cap", retryIn = 5400 }' }));
  lines = vm.list('NS.UI.UsageLines()');
  assert.ok(lines.includes('Free requests reset at 12:00.'), lines.join('|'));
  // Another install's slots: its token is hidden unless you ask for it.
  apply(vm, byokSlot().replace('token = NQADB.token', 'token = "0badc0de"'));
  vm.slash('diag');
  assert.ok(!notice(vm).includes('0badc0de'));
  assert.match(notice(vm), /written for another install \(token hidden\)/);
  vm.slash('diag full');
  assert.ok(notice(vm).includes('(token 0badc0de)'));
  // The reload path: the hello went by the saved outbox, so capture isn't proven.
  const rl = confirmHello(newVM({ db: 'NQADB = { settings = { mode = "reload" } }' }).login());
  rl.slash('');
  apply(rl, byokSlot());
  assert.equal(rl.evaluate('NS.R.hello.viaOutbox'), 'true');
  // Nor a guess at why (DR-09): "checking" until the app names a cause.
  assert.ok(rl.list('NS.UI.ChecklistLines()').some(l => l.includes('Checking the app can see WoW…')), 'a hello by the reload path isn\'t capture');
});

test('UX-3: a $0 daily limit the player set (free models only) is a limit like any other: capMicros present means one is set (the header in red, the panel with "of $0" and its reset, the HUD\'s and the status line\'s words; reviews of the no-limits change)', () => {
  const zero = (o = {}) => usage({ capMicros: 0, spentMicros: 0, ...o });
  const vm = byok({ slot: { u: zero({ needs: 'cap' }), rt: '{ state = "cap", reason = "cap_spend" }' } });
  vm.slash('');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.usage.label.text'), '|cffff5555$0 of $0 today|r', 'red: a paid turn is refused');
  const lines = vm.list('NS.UI.UsageLines()');
  assert.ok(lines.includes('Today: $0 of $0 · 23 messages'), lines.join('|'));
  assert.ok(lines.some(l => l.startsWith('Your daily spend limit resets at midnight')), lines.join('|'));
  assert.equal(vm.json('(function() local w = NS.Transport.RTWords(); return { head = w.head } end)()').head, 'You\'ve reached your daily spend limit ($0)');
  // The HUD's spend line, when the state line isn't already saying it.
  apply(vm, byokSlot({ u: zero({ needs: 'cap' }) }));
  const spend = vm.evaluate('(NS.HUD.SpendLine and NS.HUD.SpendLine()) or "nil"');
  assert.equal(spend, 'You\'ve reached your daily spend limit ($0). Raise it in the NeverQuestAlone app, or it resets at midnight.');
  // Without a limit (capMicros left out) none of it: spend as information.
  apply(vm, byokSlot({ u: usage({ spentMicros: 0, needs: 'cap' }) }));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.usage.label.text'), '$0 today');
  assert.ok(!vm.list('NS.UI.UsageLines()').some(l => /of \$|midnight/.test(l)));
  assert.equal(vm.evaluate('(NS.HUD.SpendLine and NS.HUD.SpendLine()) or "nil"'), 'nil');
});

test('C-01: a fresh install (no slot yet) has the app\'s words from load, the checklist from the first rows, and usage|cost|setup|model are commands, never paid messages', () => {
  const vm = appVM();
  assert.equal(vm.evaluate('SLASH_BONES1'), '/nqa');
  vm.slash('');
  // The checklist in the empty chat: the addon's row done, then the app, your AI and the game read, and Say hi (STYLE §1).
  const READY = '|A:UI-LFG-ReadyMark:14:14|a', TODO = '|A:UI-LFG-PendingMark:14:14|a';
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].body.text'), [
    'Setting up NeverQuestAlone:',
    `${READY} The addon is loaded (${VERSION}).`,
    `${TODO} Looking for the NeverQuestAlone app…`,
    `${TODO} Checking your AI…`,
    `${TODO} Checking the app can see WoW…`,
    `${TODO} Say hi once the steps above are done.`,
  ].join('\n'));
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].chips[1] and NS.UI.ui.bubbles[1].chips[1].shown'), null, 'no Say hi before it can work (C-26)');
  // No model yet: the header says so, with no effort and no menu.
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'No model yet');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'false');
  // The commands answer, and nothing goes out as a message.
  const NOT_YET = 'The NeverQuestAlone app hasn\'t answered yet. Is it running?';
  vm.slash('usage');
  assert.equal(notice(vm), NOT_YET);
  vm.slash('model claude-sonnet-4-5');
  assert.equal(notice(vm), NOT_YET);
  vm.slash('cost on');
  assert.equal(notice(vm), `Reply Cost: on. /nqa cost on||off changes it. ${NOT_YET}`);
  vm.slash('setup');
  assert.match(notice(vm), /^Setting up NeverQuestAlone:\n.*The addon is loaded.*\n.*Looking for the NeverQuestAlone app…/);
  assert.equal(vm.outboxWires().length, 0, 'no message was sent for a command word');
  assert.deepEqual(vm.history(), []);
  // Two minutes of silence: the light, the window's status line and the HUD say so, in the app's name.
  vm.advance(130);
  vm.run('NS.Refresh("status"); NS.HUD.Render()');
  assert.equal(light(vm)[0], 'red');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), '|cffff5555No word from the NeverQuestAlone app for 2 minutes. Is it running?|r');
  // Saved data from 0.5.3, which kept which of its two builds the last slot came from: the same
  // words from load, and the key goes.
  const was = newVM({ db: 'NQADB = { backend = "legacy" }' }).login();
  assert.equal(was.evaluate('NQADB.backend'), null, 'dropped at load');
  assert.equal(light(was)[1], 'Waiting to hear from the NeverQuestAlone app…');
  was.slash('');
  was.slash('usage');
  assert.equal(notice(was), NOT_YET, 'a command, never a paid message');
  assert.equal(was.outboxWires().length, 0);
});

test('C-01, C-05: command routing: usage|cost|setup|model are commands with or without the caps; the old roadmap\'s words are messages', () => {
  const vm = byokFirst();
  const isCmd = (c, r = '') => vm.evaluate(`NS.IsCommand(${lstr(c)}, ${lstr(r)})`);
  for (const [c, r] of [['usage', ''], ['cost', 'on'], ['setup', ''], ['model', ''], ['model', 'gpt-5-mini']]) assert.equal(isCmd(c, r), 'true', `${c} ${r}`);
  assert.equal(isCmd('model', 'gpt 5'), 'false', 'two words: a message');
  assert.equal(isCmd('attach', 'x'), 'false', 'the roadmap words are words');
  const fresh = appVM();
  for (const [c, r] of [['usage', ''], ['cost', 'off'], ['setup', ''], ['model', 'x']]) assert.equal(fresh.evaluate(`NS.IsCommand("${c}", "${r}")`), 'true', `fresh ${c}`);
  for (const c of ['steer', 'reset', 'agent', 'main', 'attach', 'detach', 'inbox', 'watch', 'quiet', 'more', 'rhook']) assert.equal(isCmd(c, ''), 'false', `${c}: a word for NeverQuestAlone`);
  // The help (PUI-22): "Getting around", then main's short list (commands-ux: the Screen Reading switch,
  // then /nqa mode reload); /nqa help all is the every-command list (HELP_ALL): thinking, the app's
  // commands, no daily limit on check-ins, no diagnostics but /nqa diag and no updates from the game. As the window shows it: || is one |, the commands' gold gone.
  const shown = t => String(t ?? '').replace(/\|\|/g, '\x00').replace(/\|c[0-9a-fA-F]{8}|\|r/g, '').replace(/\x00/g, '|');
  vm.slash('');
  vm.slash('help');
  const short = shown(notice(vm));
  assert.ok(short.includes('\n/nqa settings  Open Settings to turn off Screen Reading\n/nqa mode reload  Hold messages and replies for a reload\n'), short);
  vm.slash('help all');
  const help = shown(notice(vm));
  assert.ok(help.includes('\n/nqa reading on|off  Turn Screen Reading on or off\n'), help);
  assert.ok(help.includes('\n/nqa mode reload  Hold messages and replies for a reload\n'), help);
  assert.ok(help.includes('\n/nqa think [level|default]  Set Thinking\n'), help); // fix-102: each model's own levels (/nqa think lists them)
  assert.ok(help.includes('\n/nqa companion on|off  Turn all check-ins on or off\n'), help);
  assert.ok(help.includes('\n/nqa usage  Show today\'s spend and messages\n'), 'no limits of ours to measure against');
  for (const c of ['model [id]', 'cost on|off', 'setup', 'text small|medium|large|xlarge', 'diag']) assert.ok(help.includes(`\n/nqa ${c}  `), c);
  assert.doesNotMatch(help, /\/nqa (state|apicheck|slots|probe|update)\b/, 'no diagnostics but /nqa diag, no updates from the game');
  assert.doesNotMatch(help, /provider|effort|tokens|on your desktop|\bme\b|\bmy\b/, 'the glossary; the product\'s voice');
  assert.doesNotMatch(help, /a day by default|against your limits/);
  // Every command there is, in it (commands_ux_test's check), but the unlisted ones.
  const words = vm.list('(function() local o = {} for k in pairs(NS.COMMAND_ARGS) do o[#o + 1] = k end table.sort(o) return o end)()');
  const unlisted = new Set(['chats', 'options', 'config', '?', 'update', 'slots', 'probe', 'state', 'apicheck', 'stream']); // stream: /nqa reading's other way round
  assert.deepEqual(words.filter(w => !unlisted.has(w) && !new RegExp(`/nqa (\\w+\\|)*${w}\\b`).test(help)), [], 'every command word is in /nqa help all');
});

test('the public build\'s help lines each fit one drawn line of the notice at the window\'s old default size, 560 (commands_ux_test\'s measure, BOARD §6 item 10; narrower, each command takes a line of its own): /nqa help, its Copy and Paste list and /nqa help all, with main\'s paste, replies and app lines', () => {
  // The chat font (14 at Medium) and the notice's text width, as commands_ux_test measures main's.
  const vm = byok({ vm: { extra: 'STUB.metrics = true; function ChatFontNormal:GetFont() return "Fonts\\\\ARIALN.TTF", 14, "" end' } });
  vm.slash('');
  const BODY = 454; // 560 less the transcript's 62 and the notice's 44
  const width = l => vm.num(`(function() local fs = NS.UI.ui.notice.body; fs:SetText(${JSON.stringify(l)}); return fs:GetStringWidth() end)()`);
  const strip = t => t.replace(/\|\|/g, '\x00').replace(/\|c[0-9a-fA-F]{8}|\|r/g, '').replace(/\x00/g, '|');
  const measured = [];
  for (const [which, setup] of [['help', ''], ['help all', ''], ['help', 'NQADB.settings.replies = "paste"']]) {
    vm.run(setup || 'NQADB.settings.replies = "auto"');
    vm.slash(which);
    const raw = notice(vm).split('\n');
    // "Getting around" is a paragraph the notice wraps; every other line is one line of the list.
    const lines = raw.filter(l => !/^Getting around|^Click Ask to ask/.test(strip(l)) && l !== '');
    assert.ok(lines.length > 4, which);
    for (const l of lines) measured.push([strip(l), width(l)]);
  }
  assert.ok(measured.some(([l]) => l === '/nqa app  Show the link to download the NeverQuestAlone app'), 'main\'s Copy and Paste lines, in the public build\'s help too');
  assert.ok(measured.some(([l]) => l === '/nqa replies auto|paste  Pick how replies come'));
  assert.ok(measured.some(([l]) => l === '/nqa paste  Open Copy and Paste again'));
  const wide = measured.filter(([, w]) => w > BODY).map(([l, w]) => `${Math.round(w)}: ${l}`);
  assert.deepEqual(wide, [], `lines wider than ${BODY} units`);
  for (const [l] of measured) assert.ok(l.length <= 62, `${l.length} characters: ${l}`);
});

test('C-07: the new text is 12 pt and follows the text-size setting, never under 11 (details, the desktop line, a reply\'s cost, the usage line and panel)', () => {
  const FONTS = `
GameFontDisable = { GetFont = function() return "Fonts\\\\FRIZQT__.TTF", 12, "" end }
GameFontNormal = { GetFont = function() return "Fonts\\\\FRIZQT__.TTF", 12, "" end }
ChatFontNormal = { GetFont = function() return "Fonts\\\\ARIALN.TTF", 14, "" end }
`;
  const vm = byok({ vm: { extra: FONTS } });
  vm.slash('');
  vm.slash('cost on');
  const id = activeId(vm);
  apply(vm, byokSlot({ records: [replyRec(1, id, 'Head north.', ', usage = { ["in"] = 100, out = 10, micros = 400, exact = true }')] }));
  type(vm, 'and then?');
  apply(vm, byokSlot({ records: [errorRec(2, id, 'region_blocked', 'desktop', 'Anthropic isn\'t available where you are.')] }));
  const i = errBubble(vm);
  click(vm, `NS.UI.ui.bubbles[${i}].acts[3]`);
  vm.run('NS.UI.ToggleUsage(); NS.Refresh("all")');
  const size = expr => vm.num(`STUB.FontSize(${expr})`);
  const PARTS = { details: `NS.UI.ui.bubbles[${i}].details`, hint: `NS.UI.ui.bubbles[${i}].hint`, cost: 'NS.UI.ui.bubbles[1].cost' };
  for (const [name, expr] of Object.entries(PARTS)) {
    assert.doesNotMatch(vm.evaluate(`${expr}.font`), /Small$/, name);
    assert.equal(size(expr), 12, `${name} at medium`);
  }
  // Main's status line and small bar keep main's type; the public build's new text is 12 pt.
  for (const expr of ['NS.UI.ui.usage.label', 'NQAUsage.body']) {
    assert.doesNotMatch(vm.evaluate(`${expr}.font`), /Small$/, expr);
    assert.ok(size(expr) >= 12, `${expr}: ${size(expr)}`);
  }
  vm.slash('text small');
  for (const [name, expr] of Object.entries(PARTS)) assert.equal(size(expr), 11, `${name} at small: the floor`);
  assert.equal(vm.num('NS.UI.ui.bubbles[1].body.fontSize'), 12, 'the chat text itself: 14 - 2');
  vm.slash('text large');
  for (const [name, expr] of Object.entries(PARTS)) assert.equal(size(expr), 15, `${name} at large`);
});

test('C-10: error kinds look like what they are, in the window and the HUD: gold "Didn\'t go through", red "Needs you", grey "Declined"', () => {
  const GOLD = [1, 0.82, 0], RED = [1, 0.44, 0.44], GREY = [0.7, 0.7, 0.7];
  const HUD_RED = [1, 0.13, 0.13], HUD_GREY = [0.6, 0.6, 0.6];
  const CASES = [
    ...['overloaded', 'rate_limited', 'timeout', 'network_after_send', 'interrupted'].map(k => [k, 'Didn\'t go through', GOLD, GOLD]),
    ...['auth_invalid', 'out_of_credit', 'spend_limit', 'cap_spend'].map(k => [k, 'Needs you', RED, HUD_RED]),
    ['content_blocked', 'Declined', GREY, HUD_GREY],
    // Automatic help paused itself (the public build's runaway fuse): held, in gold.
    ['auto_paused', 'Waits for your next message', GOLD, GOLD],
  ];
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  const id = activeId(vm);
  let seq = 0;
  for (const [kind, label, color, hud] of CASES) {
    // The HUD's headline: the window closed, so it's news.
    apply(vm, byokSlot({ records: [errorRec(++seq, id, kind, 'none', 'It went wrong.')] }));
    vm.run('NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), label, `HUD ${kind}`);
    assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), hud, `HUD ${kind}`);
    vm.run('NS.HUD.Okay()');
    // The window's bubble.
    vm.slash('');
    const i = errBubble(vm);
    assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].who.text`), label, kind);
    assert.deepEqual(vm.json(`NS.UI.ui.bubbles[${i}].who.textColor`), color, kind);
    assert.deepEqual(vm.json(`NS.UI.ui.bubbles[${i}].accent.color`).slice(0, 3), color, `${kind}: its edge`);
    vm.slash('');
  }
  // An older bridge's error: "Error", red, as today.
  const old = confirmHello(newVM().login());
  old.slash('');
  apply(old, oldSlot({ records: [errorRec(1, old.evaluate('NQADB.activeChat'), 'gateway', null, 'Your AI isn\'t reachable right now.')] }));
  assert.equal(old.evaluate('NS.UI.ui.bubbles[1].who.text'), 'Error');
});

test('C-02: out of credit mid-session is said once, with one Okay: the error as news; its Okay puts the state away too (named in grey); the spend line goes with the news\'s Okay', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  const id = activeId(vm);
  vm.send('plan my evening');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  const OOC = 'Anthropic is out of credit. Add credit, or pick another provider on your desktop.';
  apply(vm, byokSlot({ rt: '{ state = "out_of_credit" }', u: usage({ needs: 'out_of_credit' }), records: [errorRec(1, id, 'out_of_credit', 'desktop', OOC)] }));
  vm.run('NS.HUD.Render()');
  const okays = () => ['okBtn', 'spendOk', 'warnOk', 'stateOk'].filter(b => vm.evaluate(`NS.HUD.h.${b}.shown`) === 'true');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Needs you');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), OOC);
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'not a second time');
  assert.deepEqual(okays(), ['okBtn'], 'one Okay');
  // The news's Okay is the state's too (one Okay for one thing): named calmly, grey and alone, until it changes (C-23).
  click(vm, 'NS.HUD.h.okBtn');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Your Anthropic account is out of credit');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [0.6, 0.6, 0.6]);
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false');
  assert.deepEqual(okays(), [], 'put away: nothing more to say Okay to');
  assert.equal(vm.evaluate('NQADB.spendOkay'), '2026-09-26:out_of_credit', 'the news\'s Okay put the state and the spend line away');
  // Without rt (the usage alone says it): the spend line would say it, but the news does, so it goes; Okay puts both away.
  const u = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  const uid = activeId(u);
  apply(u, byokSlot({ u: usage({ needs: 'out_of_credit' }), records: [errorRec(1, uid, 'out_of_credit', 'desktop', OOC)] }));
  u.run('NS.HUD.Render()');
  assert.equal(u.evaluate('NS.HUD.h.spend.shown'), 'false');
  u.run('local b = NS.HUD.h.okBtn; b.scripts.OnClick(b)');
  assert.equal(u.evaluate('NS.HUD.h.spend.shown'), 'false', 'put away with the news');
  // News and near the cap: the spend line after the block, never between the label and the words, and no second Okay.
  const n = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  apply(n, byokSlot({ u: capped({ spentMicros: 820000, needs: 'near_cap' }), records: [replyRec(1, activeId(n), 'In Ironforge: the Great Forge.')] }));
  n.run('NS.HUD.Render()');
  assert.equal(n.evaluate('NS.HUD.h.spend.shown'), 'true');
  assert.equal(n.evaluate('NS.HUD.h.spendOk.shown'), 'false', 'the news has the Okay');
  assert.ok(n.num('-NS.HUD.h.spend.y') > n.num('-NS.HUD.h.okBtn.y'), 'under the news and its Okay');
  n.run('NS.HUD.Okay()');
  assert.equal(n.evaluate('NS.HUD.h.spendOk.shown'), 'true', 'its own Okay once the news is read');
});

test('C-03: slowed while working says so, with the countdown; no spend line and no Okay for something that passes on its own', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, byokSlot({ rt: '{ state = "slowed", retryIn = 18 }', u: usage({ needs: 'slowed' }) }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Anthropic asked NeverQuestAlone to slow down');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Trying again in 18 seconds.');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.shown'), 'true', 'still working: Stop');
  vm.advance(5);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Trying again in 13 seconds.');
  assert.equal(vm.evaluate('NS.HUD.SpendLine()'), null);
});

test('C-05: the companion is off until the app says it\'s on (bridge.usage.autoOn), with no daily limit (only the runaway fuse, said while it holds)', () => {
  const vm = byok();
  vm.slash('');
  assert.equal(vm.evaluate(COMPANION_ON), 'false');
  assert.equal(vm.evaluate('NS.Companion.Active("evt")'), 'false', 'no events go while it\'s off on the desktop');
  vm.slash('companion');
  assert.match(notice(vm), /^Check-ins are off in the NeverQuestAlone app: turn them on there, and they come to your Check-ins chat\.\n/);
  // The Settings switch is this addon's own and stays as you set it (C-25); its tooltip says the app's is off, while it is.
  const sw = 'NS.Settings.SWITCHES[6]';
  assert.equal(vm.evaluate(`${sw}[2]`), 'Check-Ins');
  assert.equal(vm.evaluate(`${sw}[3]()`), 'true', 'ticked: this addon\'s side is on');
  vm.run(`${sw}[4](false)`);
  assert.equal(vm.evaluate(`${sw}[3]()`), 'false');
  vm.run(`${sw}[4](true)`);
  assert.equal(vm.evaluate(`${sw}[3]()`), 'true', 'stays ticked after the click although the app\'s is off');
  assert.match(vm.chatLines().at(-1), /Check-ins are also off in the NeverQuestAlone app: turn them on there too\.$/);
  assert.equal(vm.evaluate(`${sw}[5]()`), 'NeverQuestAlone checks in on level-ups, finished routes, quests no route covers and first visits to a zone. They\'re off in the NeverQuestAlone app right now; turn them on there too.');
  apply(vm, byokSlot({ u: usage({ autoOn: true }) }));
  assert.equal(vm.evaluate(`${sw}[5]()`), 'NeverQuestAlone checks in on level-ups, finished routes, quests no route covers and first visits to a zone.', 'read when shown: on there now');
  assert.equal(vm.evaluate(COMPANION_ON), 'true');
  vm.slash('companion');
  assert.match(notice(vm), /^Check-Ins: On\. NeverQuestAlone checks in on level-ups, finished routes, quests no route covers and first visits to a zone \(\d+ today\)\. Settings has it too\.\n  level-ups: on/);
  assert.doesNotMatch(notice(vm), /a day|left today|allow|limit/, 'no daily limit of ours');
  // A bridge that says nothing of the app's switch (no usage cap): off, as the app hasn't said it's on.
  const quiet = confirmHello(newVM().login());
  assert.equal(quiet.evaluate(COMPANION_ON), 'false');
  assert.doesNotMatch(quiet.evaluate('NS.Settings.SWITCHES[6][5]()'), /a day/, 'no daily limit in its words');
});

test('the state a typed message carries: Game Data with Messages decides, and the app\'s companion switch what it holds (the critic\'s r3 QL-F-14): off, the quest log alone, every quest with its id, title and ready flag (PRIVACY.md\'s game information); Check-Ins doesn\'t (the breaker\'s r2: with it off, the bridge\'s old state read as the whole log)', async () => {
  const { QLOG_STUB, entriesLua, fullLog } = await import('../helpers/quest-log.mjs');
  const LOG = fullLog();
  const caps = '"state", "evt", "think", "z", "ctx", "qlog", "provider", "usage", "ekind", "model"';
  const vm = byok({ vm: { extra: QLOG_STUB + entriesLua(LOG) }, slot: { caps } });
  vm.slash('');
  const may = forMessage => vm.evaluate(`tostring(NS.Companion.Call("StateMayGo", ${forMessage}))`);
  const state = () => JSON.parse(vm.evaluate('NS.Companion.Build().json'));
  const ids = LOG.filter(e => !e.header && !e.hidden).map(e => e.id);
  assert.deepEqual([may(true), may(false)], ['true', 'false'], 'the app\'s switch off: a message carries its state; no events, no state on its own');
  const off = state();
  assert.deepEqual(off.quests.map(q => q.id), ids, 'every quest, in log order');
  assert.ok(off.quests.every(q => Object.keys(q).join() === 'id,title,complete' && q.title.length > 10), 'each its id, whole title and ready flag, nothing else');
  assert.deepEqual(off.quests.at(-1), { id: 1527, title: 'Call of Fire', complete: true });
  assert.deepEqual(['gear', 'poi', 'prof', 'pending'].filter(k => k in off), [], 'no gear, points, professions or milestones');
  assert.deepEqual([off.questCount, off.questMax, off.omitted], [40, 40, []], 'nothing named as left out to fit');
  assert.ok(off.char && off.loc, 'the character and the place');
  assert.match(vm.evaluate('NS.Settings.SWITCHES[5][5]()'), /^Sends your character, where you are and your quests, so NeverQuestAlone knows what you know\. Your gear and quest objectives go too once check-ins are on in the app\.$/, 'the switch says what goes');
  const box = () => { vm.run('NS.UI.Toggle(true); NS.UI.RenderContext()'); return vm.list('NS.UI.ui.ctx.lines')[0]; };
  assert.match(box(), / · 40 quests$/, 'the Game Data box: no gear');
  apply(vm, byokSlot({ caps, u: usage({ autoOn: true }) }));
  assert.match(box(), / · 40 quests · gear$/, 'on: the gear too');
  assert.deepEqual([may(true), may(false)], ['true', 'true']);
  const on = state();
  assert.deepEqual(on.quests.map(q => q.id), ids);
  assert.ok(on.quests.some(q => Array.isArray(q.obj) && q.obj.length) && on.quests.every(q => 'level' in q), 'on: objectives and levels too');
  assert.equal(vm.evaluate('NS.Settings.SWITCHES[5][5]()'), 'Sends your character, where you are, your quests and gear, so NeverQuestAlone knows what you know.');
  vm.slash('companion off');
  assert.deepEqual([may(true), may(false)], ['true', 'false'], 'Check-Ins off: no events or state on its own; a message still carries its state');
  vm.slash('context off');
  assert.equal(may(true), 'false', 'Game Data with Messages off: none');
});

test('the quest log alone doesn\'t stand for the professions (the critic\'s r4 QL-F-15): with the app\'s companion switch off, a rank change sends the message\'s context, so the bridge\'s Professions line is the new one; on, the state carries it', async () => {
  const { parseRecord, inflateBody } = await import('../../bridge/transport/records.mjs');
  const { withState } = await import('../../bridge/app/context.mjs');
  const { listOnlyState } = await import('../../bridge/byok/runtime/context.mjs');
  const { QLOG_STUB, entriesLua, fullLog } = await import('../helpers/quest-log.mjs');
  const SKILLS = `STUB.skills = { { "Professions", true }, { "Mining", false, 45, 75 } }
function GetNumSkillLines() return #STUB.skills end
function GetSkillLineInfo(i) local s = STUB.skills[i]; return s[1], s[2] or nil, false, s[3], 0, 0, s[4] end`;
  const caps = '"state", "evt", "think", "z", "ctx", "qlog", "provider", "usage", "ekind", "model"';
  for (const autoOn of [false, true]) {
    const vm = confirmHello(newVM({ extra: QLOG_STUB + entriesLua(fullLog()) + '\n' + SKILLS }).login());
    apply(vm, byokSlot({ caps, u: usage({ autoOn }) }));
    vm.advance(3);
    const recs = () => [...vm.stripWires().map(w => parseRecord(w)), ...vm.outboxWires().map(e => parseRecord(e.wire))].filter(r => r.ok).map(r => r.record);
    const sent = text => { vm.send(text); return recs().find(r => r.type === 'msg' && String(r.text).endsWith(text)); };
    const label = autoOn ? 'the switch on' : 'the switch off';
    const stored = vm.evaluate('NS.R.contextSent');
    assert.match(stored, /\nProfessions: Mining 45\/75\n/, label);
    assert.equal(sent('first').args.ctx, '0', `${label}: nothing the state leaves out changed`);
    vm.advance(10);
    vm.run('STUB.skills[2] = { "Mining", false, 60, 75 }; STUB.FireEvent("SKILL_LINES_CHANGED")');
    vm.advance(3);
    const m = sent('second');
    const st = recs().filter(r => r.type === 'state').at(-1);
    const state = JSON.parse(st.args.z === '1' ? inflateBody(st.body, 100000).text : st.body);
    if (!autoOn) {
      assert.equal('prof' in state, false, 'the quest log alone');
      assert.equal(m.args.ctx, '1', 'the rank changed: the context goes');
      assert.match(m.context, /\nProfessions: Mining 60\/75\n/);
      assert.match(withState(m.context, listOnlyState(state)), /\nProfessions: Mining 60\/75\n/, 'what the bridge builds for the turn');
    } else {
      assert.deepEqual(state.prof, [{ name: 'Mining', rank: 60, max: 75 }], label);
      assert.equal(m.args.ctx, '0', `${label}: the state carries the rank`);
      assert.match(withState(stored, state), /\nProfessions: Mining 60\/75\n/, label);
    }
  }
});

test('C-11: the model and effort shown are the bridge\'s: asked-for stays "asked for" until confirmed; effort only from the chat\'s snapshot or bridge.provider.effort; the menu names the chat\'s model', () => {
  const vm = byok({ slot: { p: provider({ effort: 'low' }) } });
  vm.slash('');
  const id = activeId(vm);
  // bridge.think (the bridge's own default, from its config) is not the model's effort.
  apply(vm, byokSlot().replace('think = "medium"', 'think = "high"'));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · Low');
  vm.slash('think high');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · High |cff9d9d9d(from your next message)|r');
  assert.equal(notice(vm), 'Thinking in this chat: High, from your next message.');
  vm.slash('think');
  assert.equal(notice(vm), 'Thinking in ' + vm.evaluate('NS.Chats.Active().name') + ': Low. You asked for High: it starts with your next message. /nqa think low||medium||high sets it for this chat; /nqa think default goes back to the model\'s default.');
  apply(vm, byokSlot().replace('chats = {}', `chats = { { id = "${id}", busy = false, queued = 0, effort = "high" } }`));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Haiku 4.5 · High', 'in effect');
  // A model of the chat's own, confirmed by the snapshot, with no effort control there: no menu, no effort.
  vm.slash('model gpt-5-mini');
  apply(vm, byokSlot().replace('chats = {}', `chats = { { id = "${id}", busy = false, queued = 0, model = "gpt-5-mini", modelName = "GPT-5 mini", effortSupported = false } }`));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'GPT-5 mini');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'false');
  vm.slash('think medium');
  assert.equal(notice(vm), 'GPT-5 mini has no thinking levels. Nothing changed.');
  // One that takes it: the menu's title names it, and its default is the model's.
  apply(vm, byokSlot().replace('chats = {}', `chats = { { id = "${id}", busy = false, queued = 0, model = "gpt-5-mini", modelName = "GPT-5 mini", effortSupported = true, effort = "medium" } }`));
  vm.run(`STUB.menu = {}; MenuUtil = { CreateContextMenu = function(owner, fn) local root = {} function root:CreateTitle(t) table.insert(STUB.menu, t) end function root:CreateButton(t) table.insert(STUB.menu, t) end function root:CreateRadio(t) table.insert(STUB.menu, t) end fn(owner, root) end }`);
  vm.run('NS.Refresh("status"); local t = NS.UI.ui.thinkBtn; t.scripts.OnClick(t)');
  const effort = vm.evaluate('NS.Provider().effort');
  assert.deepEqual(vm.list('STUB.menu'), ['Thinking for GPT-5 mini', 'Low', 'Medium', 'High', effort ? `Default (${effort[0].toUpperCase() + effort.slice(1)})` : 'Default']);
  // A model the provider doesn't have: no longer "asked for".
  vm.slash('model gpt-9');
  apply(vm, byokSlot({ records: [errorRec(1, id, 'model_not_found', 'desktop', 'gpt-9 isn\'t available on your OpenAI account.')] }));
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").modelAsked`), null);
});

// fix-102 (the owner, 2026-09-30: "we need more model options nad thinking levels"): the in-game
// Thinking list is the model's own levels, cheapest first (bridge.provider.efforts; a chat's own
// model's chats[].efforts). /nqa think names them, the menu lists them (Extra High for xhigh; Off
// only where the model has it), and a level the model hasn't runs as its nearest, said so.
test('fix-102: the Thinking list is each model\'s own levels: /nqa think and the menu name them; one the model hasn\'t runs as its nearest, said so', async () => {
  const { parseRecord } = await import('../../bridge/transport/records.mjs');
  const SONNET = { model: 'claude-sonnet-5-5', modelName: 'Claude Sonnet 5.5', effort: 'low', efforts: 'off low medium high xhigh max' };
  const vm = byok({ slot: { p: provider(SONNET) } });
  const patches = () => vm.outboxWires().map(e => parseRecord(e.wire)).filter(r => r.ok && r.record.type === 'patch').map(r => r.record);
  vm.slash('');
  const id = activeId(vm);
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Claude Sonnet 5.5 · Low');
  assert.deepEqual(vm.list('NS.UI.ChatEfforts(NS.Chats.Active())'), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);
  vm.slash('think');
  assert.equal(notice(vm), 'Thinking in ' + vm.evaluate('NS.Chats.Active().name') + ': Low (the model\'s default). /nqa think off||low||medium||high||xhigh||max sets it for this chat; /nqa think default goes back to the model\'s default.');
  vm.slash('think xhigh');
  assert.equal(notice(vm), 'Thinking in this chat: Extra High, from your next message.', 'xhigh\'s label');
  assert.equal(vm.evaluate('NS.Chats.Active().think'), 'xhigh');
  assert.equal(patches().at(-1).args.think, 'xhigh');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'Claude Sonnet 5.5 · Extra High |cff9d9d9d(from your next message)|r');
  // A level this model hasn't: its nearest (the next one up), said as such; the patch asks for that one.
  vm.slash('think minimal');
  assert.equal(notice(vm), 'Claude Sonnet 5.5 has no Minimal level. Thinking in this chat: Low, from your next message.');
  assert.equal(vm.evaluate('NS.Chats.Active().think'), 'low');
  assert.equal(patches().at(-1).args.think, 'low', 'the patch asks for the level the model runs');
  // The menu: the model's levels, cheapest first, then its default.
  const MENU = 'STUB.menu = {}; MenuUtil = { CreateContextMenu = function(owner, fn) local root = {} function root:CreateTitle(t) table.insert(STUB.menu, t) end function root:CreateButton(t) table.insert(STUB.menu, t) end fn(owner, root) end }';
  vm.run(MENU);
  vm.run('NS.Refresh("status"); local t = NS.UI.ui.thinkBtn; t.scripts.OnClick(t)');
  assert.deepEqual(vm.list('STUB.menu'), ['Thinking for Claude Sonnet 5.5', 'Off', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Default (Low)']);
  // A chat's own model that always thinks (Claude Opus 5.5): its own list, no Off; Off runs as its lowest.
  vm.slash('model claude-opus-5-5');
  apply(vm, byokSlot({ p: provider(SONNET) }).replace('chats = {}', `chats = { { id = "${id}", busy = false, queued = 0, model = "claude-opus-5-5", modelName = "Claude Opus 5.5", effortSupported = true, efforts = "low medium high xhigh max", effort = "low" } }`));
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").model`), 'claude-opus-5-5');
  assert.deepEqual(vm.list('NS.UI.ChatEfforts(NS.Chats.Active())'), ['low', 'medium', 'high', 'xhigh', 'max']);
  vm.slash('think off');
  assert.equal(notice(vm), 'Claude Opus 5.5 always thinks. Thinking in this chat: Low, from your next message.');
  vm.run(MENU);
  vm.run('NS.Refresh("status"); local t = NS.UI.ui.thinkBtn; t.scripts.OnClick(t)');
  assert.deepEqual(vm.list('STUB.menu'), ['Thinking for Claude Opus 5.5', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Default (Low)']);
  // Without a menu, each click moves to the next of the model's levels, then back to the default.
  vm.run('MenuUtil = nil');
  vm.run(`NS.Chats.Find("${id}").think = "max"`);
  vm.run('local t = NS.UI.ui.thinkBtn; t.scripts.OnClick(t)');
  assert.equal(vm.evaluate('NS.Chats.Active().think'), null, 'past Max: the default');
  vm.run('local t = NS.UI.ui.thinkBtn; t.scripts.OnClick(t)');
  assert.equal(vm.evaluate('NS.Chats.Active().think'), 'low', 'then the model\'s first level');
});

test('C-13, C-19: with cap ekind a warning stays as a state line with Okay; the one-line HUD shows the spend line in gold with Okay, and not in a fight', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true, settings = { hudMin = true } }' } });
  vm.run('NS.Transport.Warn("w", "The whole story.", "Replies come slower this session")');
  vm.advance(30);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Replies come slower this session', 'no 6 s flash: it stays');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true');
  click(vm, 'NQAHUDBar.okBtn');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Ready');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'false');
  // Near the cap on the one line: its words in gold, its Okay.
  apply(vm, byokSlot({ u: capped({ spentMicros: 820000, needs: 'near_cap' }) }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Near your daily limit');
  assert.deepEqual(vm.json('NQAHUDBar.status.textColor'), [1, 0.82, 0]);
  assert.equal(vm.evaluate('NS.HUD.h.tip'), 'You\'ve used $0.82 of your $1.00 daily spend limit.', 'the whole line in its tooltip');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true');
  // In a fight it waits, like every line that can.
  vm.run('NS.R.inCombat = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Ready');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'false');
  vm.run('NS.R.inCombat = false; NS.HUD.Render()');
  vm.advance(1); // main's double-click guard on the bar's Okay (C-109)
  click(vm, 'NQAHUDBar.okBtn');
  assert.equal(vm.evaluate('NQADB.spendOkay'), '2026-09-26:near_cap');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Ready');
});

// The bridge holds the player's limit as reached when today's spend couldn't be read (code health BR-09: rt cap,
// reason load_error, usage.held). The game says so in the app's words, never that the limit was reached (UX-W02).
test('BR-09: a limit held because today\'s spend couldn\'t be read is never "reached" in game: the light, the HUD, the header, the usage line, its panel, /nqa usage and the small bar say so, in the companion\'s name; with the app gone quiet, the HUD\'s spend line too', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  vm.slash('');
  const held = (companion = 'NeverQuestAlone') => byokSlot({ p: provider({ companion }), companion, rt: '{ state = "cap", reason = "load_error" }', u: capped({ spentMicros: 1000000, needs: 'cap', held: 'load_error' }) });
  apply(vm, held());
  const [state, tip] = light(vm);
  assert.equal(state, 'yellow', 'the cap\'s light');
  assert.ok(tip.startsWith('Today\'s spend couldn\'t be read, so NeverQuestAlone rests. Set your limit again in the NeverQuestAlone app.'), tip);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Today\'s spend couldn\'t be read, so NeverQuestAlone rests');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Set your limit again in the NeverQuestAlone app.');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'said once: the spend line leaves it to the status line');
  vm.run('NS.Refresh("status")');
  assert.ok(vm.evaluate('NS.UI.ui.status.text').includes('Today\'s spend couldn\'t be read, so NeverQuestAlone rests. Set your limit again in the NeverQuestAlone app.'), 'the header');
  apply(vm, held('Nyx'));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Today\'s spend couldn\'t be read, so Nyx rests', 'the companion\'s own name (STYLE §11)');
  // The window's usage line, its panel and /nqa usage: the spend is unknown, never "~$1.00 of $1.00" (UX-W05).
  apply(vm, held());
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.usage.label.text'), '|cffff5555Today\'s spend unknown|r', 'red, as the cap is: NeverQuestAlone rests');
  click(vm, 'NS.UI.ui.usage');
  assert.ok(vm.evaluate('NQAUsage.body.text').includes('\nToday: spend unknown · 23 messages\n'), vm.evaluate('NQAUsage.body.text'));
  click(vm, 'NQAUsage.okay');
  vm.slash('usage');
  assert.ok(notice(vm).includes('\nToday: spend unknown · 23 messages\n'), notice(vm));
  assert.doesNotMatch(`${vm.evaluate('NS.UI.ui.usage.label.text')} ${notice(vm)}`, /\$1\.00 of|~\$/, 'no limit as if spent');
  vm.slash('hud off');
  vm.run('NS.Refresh("status")');
  assert.ok(vm.evaluate('NS.UI.ui.miniBadge.text').includes('Spend unknown'), 'the small bar');
  // A limit reached is still said as reached.
  apply(vm, byokSlot({ rt: '{ state = "cap" }', u: capped({ spentMicros: 1000000, needs: 'cap' }) }));
  vm.run('NS.Refresh("status")');
  assert.ok(vm.evaluate('NS.UI.ui.miniBadge.text').includes('Daily limit reached'));
  assert.equal(vm.evaluate('NS.UI.ui.usage.label.text'), '|cffff5555$1.00 of $1.00 today|r');
  // With the app gone quiet, the HUD's spend line says it from the last usage (UX-W06), in red (the whole
  // panel: with the window open it's one line).
  vm.slash('hud on');
  apply(vm, held());
  vm.advance(200);
  vm.run('NS.UI.Close(); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Can\'t reach the NeverQuestAlone app');
  assert.equal(vm.evaluate('NS.HUD.h.spend.text'), 'Today\'s spend couldn\'t be read, so NeverQuestAlone rests. Set your limit again in the NeverQuestAlone app.');
  assert.deepEqual(vm.json('NS.HUD.h.spend.textColor'), [1, 0.13, 0.13]);
});

test('C-14, C-15: the HUD\'s X speaks in the companion\'s name; with the HUD off the small bar names a rejected key, not "idle"', () => {
  const vm = byok({ slot: { p: provider({ companion: 'Nyx' }), companion: 'Nyx' } });
  vm.run('NS.HUD.Close()');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[Nyx]|r The HUD is closed; replies still show as they come, and a route you follow keeps its bar. Nyx HUD, in Settings, or Show More in that bar\'s right-click menu brings it back.');
  vm.slash('hud off');
  apply(vm, byokSlot({ p: provider({ companion: 'Nyx', keyState: 'invalid' }), companion: 'Nyx', rt: '{ state = "key_invalid" }' }));
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NQAMini.shown'), 'true');
  assert.equal(vm.evaluate('NS.UI.ui.miniBadge.text'), '|cffff5555Key rejected|r', 'a status, in sentence case');
  for (const [st, words] of [['out_of_credit', 'Out of credit'], ['cap', 'Daily limit reached']]) {
    apply(vm, byokSlot({ rt: `{ state = "${st}" }` }));
    vm.run('NS.Refresh("status")');
    assert.ok(vm.evaluate('NS.UI.ui.miniBadge.text').includes(words), st);
  }
  apply(vm, byokSlot());
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.miniBadge.text'), '|cff999999Idle|r', 'main\'s status, capitalized (ux-copy-addon)');
});

test('C-17: a local model is named once (the header), and no model means no effort and no menu', () => {
  const vm = byok({ slot: { p: provider({ id: 'ollama', name: 'Ollama', auth: 'local', privacy: 'local', model: 'qwen3:8b', modelName: 'qwen3:8b', effortSupported: false, effort: null }), u: usage({ spentMicros: 0 }) } });
  vm.slash('');
  vm.run('NS.Refresh("status")');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'qwen3:8b');
  assert.equal(vm.evaluate('NS.UI.ui.usage.label.text'), 'On this computer · Ollama');
  apply(vm, byokSlot({ p: provider({ id: null, name: null, keyState: 'missing', model: null, modelName: null }), rt: '{ state = "no_key" }' }));
  vm.run('NS.Refresh("status"); NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.UI.ui.header.text'), 'No model yet');
  assert.equal(vm.evaluate('NS.UI.ui.thinkBtn.shown'), 'false');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), '|cffffd100No key yet. Connect your AI in the NeverQuestAlone app.|r', 'no key for a provider nobody chose');
  assert.equal(vm.evaluate('NS.ProviderName(true)'), 'Your AI');
});

test('C-20: one clock format, the game\'s own (24-hour when the client can\'t say); diag joins the usage lines cleanly; check-ins in the panel', () => {
  const vm = byok({ slot: { u: usage({ autoOn: true }) } });
  vm.slash('');
  assert.equal(vm.evaluate('NS.Clock(time())'), '12:00');
  vm.slash('diag');
  assert.match(notice(vm), /\nUsage: Anthropic · Haiku 4\.5 · Thinking: Low; Today: \$0\.18 · 23 messages; Check-ins: 4 today\.\n/);
  assert.doesNotMatch(notice(vm), /\.;/);
  assert.ok(vm.list('NS.UI.UsageLines()').includes('Check-ins: 4 today'));
  // With a daily limit the player set: spend against it, and when it resets.
  apply(vm, byokSlot({ u: capped({ autoOn: true }) }));
  vm.slash('diag');
  assert.match(notice(vm), /\nUsage: Anthropic · Haiku 4\.5 · Thinking: Low; Today: \$0\.18 of \$1\.00 · 23 messages; Check-ins: 4 today; Your daily spend limit resets at midnight, in 12 hours\.\n/);
  // With the game's 24-hour time off, every time the public build shows is 12-hour (STYLE §8).
  vm.run('STUB.cvars.timeMgrUseMilitaryTime = "0"');
  assert.equal(vm.evaluate('NS.Clock(time())'), '12:00 PM');
});

test('C-31: an error record that answers no message (map_block after a reply) pops nothing, and a map line isn\'t news', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  const id = activeId(vm);
  vm.send('where is the forge');
  vm.send('and the bank?');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  const pending = () => vm.num(`#NS.Chats.Find("${id}").pending`);
  assert.equal(pending(), 2);
  apply(vm, byokSlot({ records: [replyRec(1, id, 'In Ironforge.'), errorRec(2, id, 'map_block', 'none', 'The map in that reply didn\'t draw.')] }));
  assert.equal(pending(), 1, 'the reply answered the first; the map line answered nothing');
  assert.equal(vm.evaluate(`NS.Chats.IsBusy(NS.Chats.Find("${id}"))`), 'true', 'the second still waits for its answer');
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'the reply is the news, not the map line');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'In Ironforge.');
  assert.equal(vm.num(`NS.Chats.Find("${id}").unread`), 1, 'one new: the reply');
});

// ---------------------------------------------------------------- C: no limits (the bridge's contract at 8f9c1c2)

test('C: automatic help paused (the bridge\'s runaway fuse): its one line is held, gold "Waits for your next message", with Okay and no resend, in the Companion chat, the HUD, the bar, the chat frame and the banner; it pops no send; events still go (they ride along); no promise while it holds', () => {
  const LINE = 'NeverQuestAlone paused check-ins: your next message turns them back on.';
  const GOLD = [1, 0.82, 0];
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' }, slot: { u: usage({ autoOn: true }) } });
  vm.run('STUB.chat = {}');
  const cc = vm.evaluate('NS.Companion.CHAT_ID');
  const chat = `NS.Chats.Find("${cc}")`;
  // An event the bridge acked and held (it rides along with the next typed message: no answer comes).
  vm.run('local c = NS.Companion.Call("EnsureChat"); table.insert(c.pending, { key = "k-evt", t = time(), acked = true, ackedAt = GetTime() }); table.insert(c.history, { role = "user", event = "route_done", text = "Route done: Elwynn loop", key = "k-evt", t = time() })');
  const rec = seq => `{ seq = ${seq}, t = "error", chat = "${cc}", kind = "auto_paused", action = "none", answers = "none", text = ${lstr(LINE)} }`;
  const snap = busy => `chats = { { id = "${cc}", busy = ${busy}, queued = 0 } }`;
  const paused = (records, busy) => byokSlot({ u: usage({ autoOn: true, autoPaused: true }), records }).replace('chats = {}', snap(busy));
  // The line arrives while the chat still runs the turns before it: it answers nothing.
  apply(vm, paused([rec(1)], true));
  assert.equal(vm.evaluate('NS.Companion.Call("AutoPaused")'), 'true');
  assert.equal(vm.evaluate('NS.R.bridgeTurnsLeft'), null, 'turnsLeft never comes on BYOK');
  const last = `${chat}.history[#${chat}.history]`;
  assert.equal(vm.evaluate(`${last}.kind`), 'auto_paused');
  assert.equal(vm.evaluate(`${last}.info`), 'true', 'it answers no message');
  assert.equal(vm.evaluate(`${last}.sendKey`), null);
  assert.equal(vm.evaluate(`${last}.provider`), null, 'no provider\'s doing: no "Where"');
  assert.equal(vm.evaluate(`NS.UI.ErrorLook(${last})`), 'Waits for your next message', 'the held look');
  assert.deepEqual(vm.json(`{ select(2, NS.UI.ErrorLook(${last})) }`)[0], GOLD);
  assert.equal(vm.evaluate(`NS.Chats.ResendText(${chat}, ${last})`), null, 'nothing to send again');
  assert.equal(vm.evaluate(`NS.UI.ErrorDetails(${last}, ${chat})`),
    'What happened: check-ins paused themselves because too many came at once; your next message turns them back on.\nWhen: 12:00.\nOkay puts it away; it stays in the chat.');
  assert.equal(vm.num(`#${chat}.pending`), 1, 'popping no pending send: the running turn waits');
  // The chat goes idle while it holds: the event the bridge held is done here, so nothing says "working".
  apply(vm, paused([], false));
  assert.equal(vm.num(`#${chat}.pending`), 0);
  assert.equal(vm.evaluate(`NS.Chats.IsBusy(${chat})`), 'false');
  // The HUD: the held label in gold, the words, Okay and Open Chat; the bar: the words, with Okay.
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Waits for your next message');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), GOLD);
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), LINE);
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', 'no spend line: it isn\'t a limit');
  assert.equal(vm.evaluate('NS.HUD.h.view.ring'), 'news', 'news, not an error');
  assert.equal(light(vm)[0], 'green', 'the light stays green');
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), LINE);
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true');
  vm.run('NQADB.settings.hudMin = false; NS.HUD.Render()');
  // The chat frame: its one line in the held gold, not an error's red.
  const echo = vm.chatLines().filter(l => l.includes(LINE));
  assert.equal(echo.length, 1);
  assert.ok(echo[0].includes('|cffffd100' + LINE), echo[0]);
  // The window's bubble: gold, Okay and Show Details, no Retry.
  vm.run(`NS.Chats.Switch("${cc}"); NS.UI.Toggle(true); NS.Refresh("all")`);
  const i = errBubble(vm);
  assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].who.text`), 'Waits for your next message');
  assert.deepEqual(vm.json(`NS.UI.ui.bubbles[${i}].who.textColor`), GOLD);
  assert.deepEqual(acts(vm, i), ['Okay', 'Show Details']);
  vm.run('NS.UI.Toggle(false); NS.HUD.Okay()');
  // /nqa companion, the usage lines and diag say it while it holds.
  vm.slash('companion');
  assert.match(notice(vm), /\nCheck-ins paused after a burst of them: your next message turns them back on\.\n/);
  assert.ok(vm.list('NS.UI.UsageLines()').includes('Check-ins: paused after a burst of them; your next message turns them back on'));
  vm.slash('diag');
  assert.match(notice(vm), /\nCompanion: paused by the runaway fuse until the next typed message; caps /);
  // No "NeverQuestAlone is on it." while it holds; an event still goes (the bridge holds it to ride along), with its send time.
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 12)');
  assert.equal(vm.evaluate('NS.R.dingQueued'), null, 'no promise');
  vm.run('NS.Companion.Queue("zone_first", { zone = "Duskwood" }, "zone_first:test:Duskwood"); NS.Companion.Flush()');
  assert.equal(vm.evaluate(`${chat}.history[#${chat}.history].event`), 'zone_first', 'sent: the bridge holds it');
  assert.match(vm.outboxWires().at(-1).wire, /\x1fevt\x1f.*at=\d+/, 'with its send time');
  // No turn is coming for it while the fuse holds: nothing shows as work (no "Sending…", no "From the game:").
  assert.equal(vm.evaluate(`#${chat}.pending`), '0', 'not pending');
  vm.run('NS.HUD.Render()');
  assert.notEqual(vm.evaluate('NS.HUD.View().mode'), 'working');
  // With the HUD in its compass form, the line is the top-middle banner, its title in gold.
  vm.run('NS.UI.Toggle(false); NQADB.settings.hudMin = true; NQADB.settings.hudCompass = true; NS.HUD.Render()');
  apply(vm, paused([rec(2)], false));
  assert.deepEqual(vm.json('NS.UI.ui.toastOrder[1].title.textColor'), GOLD, 'a gold title, not an error\'s');
  // Its two lines keep what to do (the whole of it is in the window).
  assert.equal(vm.evaluate('NS.UI.ui.toastOrder[1].line.text'), 'NeverQuestAlone paused check-ins: your next message turns them back on.');
  // The player's next typed message ends it (the bridge's word): the promise is back.
  apply(vm, byokSlot({ u: usage({ autoOn: true }) }));
  assert.equal(vm.evaluate('NS.Companion.Call("AutoPaused")'), 'false');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 13)');
  assert.equal(vm.evaluate('NS.R.dingQueued'), '13');
});

test('C: no automatic turns count against a limit: the 91st event of a day goes, with its send time', () => {
  const vm = byok({ slot: { u: usage({ autoOn: true }) } });
  const cc = vm.evaluate('NS.Companion.CHAT_ID');
  vm.run('local c = NS.Companion.Call("DB"); c.day, c.count, c.lastAt = date("%Y-%m-%d"), 90, nil');
  vm.run('NS.Companion.Queue("zone_first", { zone = "Redridge" }, "zone_first:test:Redridge"); NS.Companion.Flush()');
  assert.equal(vm.evaluate(`NS.Chats.Find("${cc}").history[#NS.Chats.Find("${cc}").history].event`), 'zone_first', 'sent: no count of 90 in the public build');
  assert.equal(vm.num('NS.Companion.Call("DB").count'), 91, 'still counted, as information (/nqa companion: sent today)');
  vm.run('NS.Companion.Call("DB").count = 500');
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 12)');
  assert.equal(vm.evaluate('NS.R.dingQueued'), '12', 'the promise: nothing counts against it');
  vm.slash('companion');
  assert.match(notice(vm), /\(\d+ today\)\./);
  const evt = vm.outboxWires().filter(e => e.wire.includes('\x1fevt\x1f')).at(-1);
  assert.match(evt.wire, /;at=\d{9,}[;\x1f]/, 'its send time, for the bridge\'s runaway fuse (SL-4)');
  // A bridge.turnsLeft (the retired build's daily cap) changes nothing.
  apply(vm, byokSlot({ u: usage({ autoOn: true }) }).replace('bridge = { ver = "1.4.0",', 'bridge = { ver = "1.4.0", turnsLeft = 0,'));
  vm.run('NS.Companion.Call("DB").lastAt = nil; STUB.FireEvent("PLAYER_LEVEL_UP", 13)');
  assert.equal(vm.evaluate('NS.R.dingQueued'), '13');
  // Help: the check-ins lines, with no daily limit.
  vm.slash('');
  vm.slash('help all');
  assert.ok(notice(vm).includes('/nqa companion on||off|r  Turn all check-ins on or off\n'), notice(vm));
  assert.ok(notice(vm).includes('/nqa companion <kind> on||off|r  Turn one kind on or off\n'), notice(vm));
  assert.doesNotMatch(notice(vm), /a day by default/);
});

test('C-23: a spend state the HUD names (the cap, out of credit, a rejected key) has an Okay under its second line; Okay names it calmly in grey until it changes; the one-line HUD too', () => {
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  const CAP = byokSlot({ u: capped({ spentMicros: 1000000, needs: 'cap' }), rt: '{ state = "cap" }' });
  apply(vm, CAP);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'You\'ve reached your daily spend limit ($1.00)');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.13, 0.13]);
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Raise it in the NeverQuestAlone app, or it resets at midnight.');
  assert.equal(vm.evaluate('NS.HUD.h.stateOk.shown'), 'true');
  assert.equal(vm.num('NS.HUD.h.stateOk.x'), 12, 'at the panel\'s edge (PAD)');
  assert.ok(vm.num('-NS.HUD.h.stateOk.y') >= vm.num('NS.HUD.h.mainY'), 'under the second line');
  click(vm, 'NS.HUD.h.stateOk');
  assert.equal(vm.evaluate('NQADB.spendOkay'), '2026-09-26:cap');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'You\'ve reached your daily spend limit ($1.00)', 'still named');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [0.6, 0.6, 0.6], 'calmly, in grey');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), '', 'alone');
  assert.equal(vm.evaluate('NS.HUD.h.dot.shown'), 'false');
  assert.equal(vm.evaluate('NS.HUD.h.stateOk.shown'), 'false');
  // The same state at the next slot: still put away. Once it changes, the Okay is spent.
  apply(vm, CAP);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.stateOk.shown'), 'false');
  apply(vm, byokSlot());
  assert.equal(vm.evaluate('NQADB.spendOkay'), null);
  // A rejected key without usage.needs (rt alone): the same, keyed on the state.
  apply(vm, byokSlot({ rt: '{ state = "key_invalid" }' }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.stateOk.shown'), 'true');
  // The one-line HUD: the state in red with its Okay; Okay puts it away there too.
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Key rejected', 'a few words beside its Okay; the whole line is the tooltip');
  assert.match(vm.evaluate('NS.HUD.h.tip'), /^Your Anthropic key was rejected\. Replace it in the NeverQuestAlone app\./);
  assert.deepEqual(vm.json('NQAHUDBar.status.textColor'), [1, 0.13, 0.13]);
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true');
  vm.advance(1); // main's double-click guard on the bar's Okay (C-109)
  click(vm, 'NQAHUDBar.okBtn');
  assert.equal(vm.evaluate('NQADB.spendOkay'), '2026-09-26:key_invalid');
  assert.deepEqual(vm.json('NQAHUDBar.status.textColor'), [0.6, 0.6, 0.6]);
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'false');
  // Not a spend state (the local server is down, slowed): no Okay; it passes, or the message's Retry answers it.
  vm.run('NQADB.settings.hudMin = false');
  for (const st of ['local_down', 'slowed', 'provider_down']) {
    apply(vm, byokSlot({ rt: `{ state = "${st}", retryIn = 18 }` }));
    vm.run('NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.stateOk.shown'), 'false', st);
  }
});

test('C-27: a spend state on top of unread news: the news keeps the header and its one Okay, the state is the spend row after it; once read, the state takes the header (and the one-line HUD) with its own Okay', () => {
  // The critic's render4 probe: the reply that reaches the cap, in one slot.
  const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  const REPLY = 'In Ironforge: the Great Forge, in the middle of the city.';
  apply(vm, byokSlot({ rt: '{ state = "cap" }', u: capped({ spentMicros: 1000000, needs: 'cap' }), records: [replyRec(1, activeId(vm), REPLY)] }));
  vm.run('NS.HUD.Render()');
  const okays = () => ['okBtn', 'spendOk', 'warnOk', 'stateOk'].filter(b => vm.evaluate(`NS.HUD.h.${b}.shown`) === 'true');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says', 'the news keeps the header');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.82, 0]);
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), REPLY);
  assert.equal(vm.evaluate('NS.HUD.h.spend.text'), 'You\'ve reached your daily spend limit ($1.00). Raise it in the NeverQuestAlone app, or it resets at midnight.');
  assert.deepEqual(vm.json('NS.HUD.h.spend.textColor'), [1, 0.13, 0.13]);
  assert.ok(vm.num('-NS.HUD.h.spend.y') > vm.num('-NS.HUD.h.okBtn.y'), 'after the block');
  assert.deepEqual(okays(), ['okBtn'], 'one Okay: the news\'s');
  click(vm, 'NS.HUD.h.okBtn');
  assert.equal(vm.evaluate('NQADB.spendOkay'), null, 'the news\'s Okay is the news\'s only');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'You\'ve reached your daily spend limit ($1.00)');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Raise it in the NeverQuestAlone app, or it resets at midnight.');
  assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false');
  assert.deepEqual(okays(), ['stateOk'], 'then the state\'s own');
  // A state already said Okay to, under new news: the spend row names it in grey.
  vm.advance(1); // main's guard after the last Okay (C-72)
  click(vm, 'NS.HUD.h.stateOk');
  apply(vm, byokSlot({ rt: '{ state = "cap" }', u: capped({ spentMicros: 1000000, needs: 'cap' }), records: [replyRec(2, activeId(vm), 'The bank is by the gate.')] }));
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone says');
  assert.equal(vm.evaluate('NS.HUD.h.spend.text'), 'You\'ve reached your daily spend limit ($1.00).');
  assert.deepEqual(vm.json('NS.HUD.h.spend.textColor'), [0.6, 0.6, 0.6]);
  assert.deepEqual(okays(), ['okBtn']);
  // A line that isn't a spend state stays as HUD v4 has it: a silent app still takes the header over the news.
  vm.advance(200);
  vm.run('NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Can\'t reach the NeverQuestAlone app');

  // The critic's p5 probe: an unread reply, then the key is rejected, on the one-line HUD.
  const b = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true, settings = { hudMin = true } }' } });
  b.send('where is the forge');
  b.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  const bid = activeId(b);
  apply(b, byokSlot({ records: [replyRec(1, bid, 'In Ironforge: the Great Forge.')] }));
  apply(b, byokSlot({ rt: '{ state = "key_invalid" }', u: usage({ needs: 'key_invalid' }) }));
  b.run('NS.HUD.Render()');
  const bar = () => [b.evaluate('NQAHUDBar.status.text'), b.evaluate('NQAHUDBar.okBtn.shown')];
  assert.deepEqual(bar(), ['In Ironforge: the Great Forge.', 'true'], 'the news\'s words, with their Okay');
  b.run('local o = NQAHUDBar.okBtn; o.scripts.OnClick(o)');
  assert.equal(b.num(`NS.Chats.Find("${bid}").unread`), 0, 'the Okay read the reply');
  assert.equal(b.evaluate('NQADB.spendOkay'), null, 'and only the reply');
  assert.deepEqual(bar(), ['Key rejected', 'true'], 'then the state, with its own Okay');
  assert.deepEqual(b.json('NQAHUDBar.status.textColor'), [1, 0.13, 0.13]);
  b.advance(1); // main's double-click guard on the bar's Okay (C-109)
  b.run('local o = NQAHUDBar.okBtn; o.scripts.OnClick(o)');
  assert.equal(b.evaluate('NQADB.spendOkay'), '2026-09-26:key_invalid');
  assert.deepEqual(bar(), ['Key rejected', 'false']);
  assert.deepEqual(b.json('NQAHUDBar.status.textColor'), [0.6, 0.6, 0.6]);
});

// ---------------------------------------------------------------- UI critic round 4 (C-28)

test('C-28: states that aren\'t spend states (a local server down, no key, paused, the provider busy) keep the header, in their colour with their second line, over an unread reply, as HUD v4 has them', () => {
  const ollama = provider({ id: 'ollama', name: 'Ollama', auth: 'local', privacy: 'local', modelName: 'qwen3:8b', model: 'qwen3:8b' });
  const WHITE = [1, 1, 1], RED = [1, 0.13, 0.13];
  const CASES = [
    [{ rt: '{ state = "local_down" }', p: ollama }, 'NeverQuestAlone can\'t reach Ollama', 'Start Ollama, then click Retry on your message.', RED],
    [{ rt: '{ state = "no_key" }', p: provider({ keyState: 'missing' }) }, 'No key yet', 'Add your Anthropic key in the NeverQuestAlone app.', WHITE],
    [{ rt: '{ state = "paused" }' }, 'NeverQuestAlone is paused', 'Messages wait until you resume it in the app.', WHITE],
    [{ rt: '{ state = "provider_down" }' }, 'Anthropic is busy right now', 'Trying again…', WHITE],
  ];
  for (const [slot, head, sub, color] of CASES) {
    const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
    vm.send('where is the forge');
    vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    apply(vm, byokSlot({ records: [replyRec(1, activeId(vm), 'In Ironforge: the Great Forge.')] }));
    apply(vm, byokSlot(slot));
    vm.run('NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), head, head);
    assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), color, `${head}: its colour, never the grey of a state said Okay to`);
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), sub, `${head}: its second line`);
    assert.equal(vm.evaluate('NS.HUD.h.spend.shown'), 'false', `${head}: not a spend row`);
    assert.equal(vm.evaluate('NS.HUD.h.stateOk.shown'), 'false', `${head}: no Okay of its own`);
    assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'In Ironforge: the Great Forge.', `${head}: the reply under it`);
    assert.equal(vm.evaluate('NS.HUD.h.okBtn.shown'), 'true', `${head}: the reply's Okay`);
    vm.run('NS.HUD.Okay()');
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), head, `${head}: after the reply's Okay`);
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), sub);
  }
});

// ---------------------------------------------------------------- UI critic round 5 (C-29)

test('C-31: a refused /nqa model (answers none) while a message runs is a Note with Okay and Show Details only: no Retry, so nothing you typed goes out twice', () => {
  for (const action of ['none', 'desktop']) {
    const vm = byok({ vm: { db: 'NQADB = { hudIntro = true, firstReply = true }' } });
    vm.slash('');
    const id = activeId(vm);
    type(vm, 'plan my evening');
    vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    vm.slash('model gpt-9');
    const before = vm.outboxWires().length;
    const text = action === 'none'
      ? 'gpt-9 isn\'t one of the Anthropic models you can pick. Nothing was changed. See them in the NeverQuestAlone app.'
      : 'gpt-9 isn\'t one of the Anthropic models you can pick. Nothing was changed.';
    apply(vm, byokSlot({ records: [`{ seq = 2, t = "error", chat = "${id}", kind = "model_not_found", action = "${action}", answers = "none", text = ${lstr(text)} }`] }));
    assert.equal(vm.evaluate(`NS.Chats.IsBusy(NS.Chats.Find("${id}"))`), 'true', `${action}: the running message still waits for its own answer`);
    const i = errBubble(vm);
    assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${i}].who.text`), 'Note', action);
    assert.deepEqual(vm.json(`NS.UI.ui.bubbles[${i}].who.textColor`), [0.7, 0.7, 0.7]);
    assert.deepEqual(acts(vm, i), ['Okay', 'Show Details'], `${action}: no Retry`);
    const entry = `NS.Chats.Find("${id}").history[#NS.Chats.Find("${id}").history]`;
    assert.equal(vm.evaluate(`NS.Chats.ResendText(NS.Chats.Find("${id}"), ${entry})`), null, 'never the last thing you typed');
    click(vm, `NS.UI.ui.bubbles[${i}].acts[2]`);
    assert.match(vm.evaluate(`NS.UI.ui.bubbles[${errBubble(vm)}].details.text`), /\nOkay puts it away; it stays in the chat\.$/);
    vm.run(`NS.Chats.ResendError(NS.Chats.Find("${id}"), ${entry})`);
    assert.equal(vm.outboxWires().length, before, `${action}: the outbox doesn't grow`);
    // With action none the bridge's own words say where the list is: no second desktop line.
    assert.equal(vm.evaluate(`NS.UI.ui.bubbles[${errBubble(vm)}].hint.shown`), action === 'none' ? 'false' : 'true');
  }
});

// ---------------------------------------------------------------- Lua 5.1

// The BYOK paths in a real Lua 5.1 runtime (LuaJIT), as tests/lua51_runtime_test.mjs
// runs the companion's: the money and token formats, the usage line and panel,
// the header, the light, the checklist, the HUD's spend line, an error's details,
// a reply's cost and the key check come out byte for byte as in the test VM.
// Skipped, with a note, when luajit isn't installed (brew install luajit).
const OUT_KEYS = ['money', 'line', 'lines', 'header', 'light', 'check', 'spend', 'details', 'cost', 'keys', 'refused', 'history'];
const BYOK_SCENARIO = `
OUT = {}
STUB.FireEvent("ADDON_LOADED", "NeverQuestAlone")
STUB.FireEvent("PLAYER_LOGIN")
STUB.Advance(3.1)
NS.UI.Toggle(true)
local id = NQADB.activeChat
NS.Chats.Send("where is the forge")
-- The records' chat is this install's (the slot's Lua reads the local id).
NS.Transport.HandleSlotData(${byokSlot({
  u: capped({ spentMicros: 820000, needs: 'near_cap', keyLeftMicros: 4120000 }),
  p: provider({ companion: 'Nova' }), companion: 'Nova',
  records: [replyRec(1, '" .. id .. "', 'Head north.', ', usage = { ["in"] = 1100, out = 134, micros = 4000, exact = false }'),
    errorRec(2, '" .. id .. "', 'overloaded', 'retry', 'Anthropic is busy right now.')],
})}, "slot")
OUT.money = table.concat({ NS.Dollars(180000), NS.Dollars(4129999), NS.Dollars(1234567890), NS.Dollars(5000), NS.Dollars(400), NS.Dollars(0), NS.Dollars(50), NS.Cents(4000), NS.Cents(120000), NS.Cents(500), NS.DurWords(11520), NS.Plural(1, "1 message waits.", "{n} messages wait.") }, ",")
OUT.line = NS.UI.UsageLine()
OUT.lines = table.concat(NS.UI.UsageLines(), "|")
OUT.header = NS.UI.HeaderText(NS.Chats.Active())
OUT.light = (select(2, NS.Transport.Light()):gsub("%d+ seconds? ago", "N seconds ago"))
OUT.check = NS.UI.Checklist().text
OUT.spend = NS.HUD.SpendLine()
local h = NS.Chats.Active().history
OUT.details = NS.UI.ErrorDetails(h[#h])
OUT.cost = NS.UI.CostText(h[#h - 1].usage)
local keys = {}
for _, t in ipairs({ "sk-ant-api03-CANARYabcdefghijklmnopqrstuvwxyz", "sk-8 is my rank", "AIzaSyCANARY_abcdefghijklmnopqrstuvwxyz0", "risk-assessment-for-the-whole-guild-raid" }) do
	keys[#keys + 1] = NS.Chats.LooksLikeKey(t) and "1" or "0"
end
OUT.keys = table.concat(keys)
local _, why, refused = NS.Chats.Send("my key xai-CANARYabcdefghijklmnopqrstuvwxyz0123456789")
OUT.refused = tostring(refused) .. ":" .. tostring(why)
OUT.history = tostring(#h)
`;

function byokProgram() {
  const bracket = src => { let eq = ''; while (src.includes(`]${eq}]`)) eq += '='; return `[${eq}[\n${src}]${eq}]`; };
  return [
    'local WRITE = io.write',
    fs.readFileSync(path.join(__dirname, '..', 'wow_stub.lua'), 'utf8') + STUB_METHODS,
    EXTRA,
    'math.randomseed(7)',
    ...['present', 'bell_push_a', 'bell_push_b', 'bell_alive_a', 'bell_alive_b', 'bell_act'].map(f => `STUB.sounds[${JSON.stringify(SIG + 'ctl\\' + f + '.wav')}] = true`),
    'NS = {}',
    ...tocFiles().map(f => `assert(loadstring(${bracket(fs.readFileSync(path.join(ADDON, f), 'utf8'))}, "@NeverQuestAlone/${f}"))("NeverQuestAlone", NS)`),
    TRAPS,
    BYOK_SCENARIO,
    `for _, k in ipairs({ ${OUT_KEYS.map(k => `"${k}"`).join(', ')} }) do WRITE(k, "\\t", (tostring(OUT[k] or "<nil>"):gsub("\\n", "\\\\n")), "\\n") end`,
  ].join('\n');
}

test('Lua 5.1 (LuaJIT): the BYOK paths come out byte for byte as in the test VM', { skip: HAVE_JIT ? false : 'luajit is not installed (brew install luajit)' }, () => {
  const r = spawnSync('luajit', ['-'], { input: byokProgram(), encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, `luajit failed:\n${r.stderr}`);
  const jit = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map(l => { const i = l.indexOf('\t'); return [l.slice(0, i), l.slice(i + 1)]; }));
  const vm = newVM();
  vm.run(BYOK_SCENARIO, 'scenario');
  for (const k of OUT_KEYS) assert.equal(jit[k], (vm.evaluate(`OUT.${k}`) ?? '<nil>').replace(/\n/g, '\\n'), `${k} differs between LuaJIT and fengari`);
  assert.equal(jit.money, '$0.18,$4.12,$1,234.56,0.5¢,0.04¢,$0,under $0.0001,0.4¢,12¢,<0.1¢,3 hours 12 minutes,1 message waits.');
  assert.equal(jit.line, '|cffffd100$0.82 today · $4.12 left on your key|r', 'gold: near the cap');
  assert.equal(jit.header, 'Haiku 4.5 · Low');
  assert.equal(jit.spend, 'You\'ve used $0.82 of your $1.00 daily spend limit.');
  assert.equal(jit.cost, '~0.4¢');
  assert.equal(jit.keys, '1010');
  assert.equal(jit.refused, 'key:That looks like an API key, so it wasn\'t sent. Keys go in the NeverQuestAlone app, never in game.');
  assert.ok(jit.check.startsWith('Setting up NeverQuestAlone:'), jit.check);
  assert.ok(jit.details.startsWith('What happened: your AI company is busy.'), jit.details);
});

test('C-OFF: /nqa companion off tells the bridge to forget the state it holds (a state record with off=1 and no body), drawn until a slot says it holds none; again after a hello while off', () => {
  const US = '\x1f';
  const argsOf = w => Object.fromEntries(w.split(US)[5].split(';').filter(Boolean).map(kv => kv.split('=')));
  const states = vm => vm.stripWires().filter(w => w.split(US)[3] === 'state');
  // A slot whose bridge holds state seq 4 (bridge.stateSeq), or none.
  const holding = (vm, push, seq) => byokSlot({ nonce: vm.evaluate('NS.R.nonce'), push }).replace('acked = {}', `acked = {}${seq ? `, stateSeq = ${seq}, stateSid = "a1b2c3d4e5f60718"` : ''}`);
  const vm = appVM();
  vm.advance(3.1);
  vm.slot(holding(vm, 1, 4));
  ring(vm);
  vm.advance(2);
  assert.equal(vm.num('NS.R.bridgeStateSeq'), 4);
  assert.deepEqual(states(vm), [], 'nothing about the state on the strip yet');
  vm.slash('companion off');
  let [off] = states(vm);
  assert.ok(off, 'the off record is on the strip');
  assert.deepEqual(argsOf(off), { cur: '0', off: '1' });
  assert.equal(off.split(US).slice(6).join(US), '', 'no body: nothing of the game goes');
  // Still drawn while the bridge holds a state; gone once a slot says it holds none.
  vm.advance(1.6);
  vm.slot(holding(vm, 2, 4));
  ring(vm);
  assert.equal(states(vm).length, 1, 'still there: the bridge holds one');
  vm.advance(1.6);
  vm.slot(holding(vm, 3, null));
  ring(vm);
  assert.equal(vm.evaluate('NS.R.stateRec'), null, 'heard');
  assert.deepEqual(states(vm), []);
  // A /reload while off, with a bridge that holds one again (it was away, or missed the record): told once after the hello.
  const again = reloadVM(vm, { extra: PUBLIC });
  again.login();
  again.advance(3.1);
  again.slot(holding(again, 4, 5));
  ring(again);
  [off] = states(again);
  assert.ok(off && argsOf(off).off === '1', 'told again after the hello');
  // On again: the off record goes, and states go as before.
  again.slash('companion on');
  assert.equal(again.evaluate('NS.R.stateRec and NS.R.stateRec.off'), null);
  // A bridge that doesn't take states (no state cap): nothing to tell it.
  const none = newVM().login();
  none.advance(3.1);
  none.slot(oldSlot({ nonce: none.evaluate('NS.R.nonce'), push: 1, caps: '"evt", "think"' }).replace('acked = {}', 'acked = {}, stateSeq = 4, stateSid = "a1b2c3d4e5f60718"'));
  ring(none);
  none.slash('companion off');
  assert.deepEqual(none.stripWires().filter(w => w.split(US)[3] === 'state'), []);
});
