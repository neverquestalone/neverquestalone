'use strict';
// The onboarding's in-game pieces on main's widget (onboarding spec §3.10 G1 to G3,
// §9.7; the consolidation's commit 3): the HUD's setup block in main's Welcome's place,
// its three rows shared with the window's checklist, Say Hi and its Okay as main's red
// buttons, "Setting up · n of 3 done" in the header, the intro mark on Say hi's "hi",
// and "Getting around" heading /nqa help.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newVM, reloadVM, lstr } = require('../helpers/nqa-vm');
const { PUBLIC, ring, provider, usage, byokSlot, confirmHello, apply, replyRec } = require('../helpers/byok-slots');

const appVM = (opts = {}) => newVM({ ...opts, extra: PUBLIC + (opts.extra || '') }).login();
const READY = '|A:UI-LFG-ReadyMark:14:14|a', TODO = '|A:UI-LFG-PendingMark:14:14|a';
const hud = vm => { vm.run('NS.HUD.Render()'); return vm; };
const shown = (vm, part) => vm.evaluate(`NS.HUD.h.${part}.shown`) === 'true';
const rows = vm => [1, 2, 3].map(i => vm.evaluate(`NS.HUD.h.setupRows[${i}].text`));
const click = (vm, expr) => vm.run(`local b = ${expr}; b.scripts.OnClick(b, "LeftButton")`);
// The app's first slot, as a fresh app install gets it.
function firstSlot(vm, slot = {}) {
  vm.advance(3.1);
  vm.slot(byokSlot({ ...slot, nonce: vm.evaluate('NS.R.nonce') }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}

test('G1: a fresh public install\'s HUD shows the setup block in main\'s Welcome\'s place: its label, body, three rows, Say Hi (greyed until the rows are done, with why) and Okay; the header counts', () => {
  const vm = hud(appVM());
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'setup');
  assert.equal(vm.evaluate('NS.HUD.h.label.text'), 'Welcome');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'I\'m NeverQuestAlone. I\'ll answer anything you ask, right here.');
  // The first seconds: nothing to act on yet, so nothing to do.
  // STYLE §1's order and words (UX-W01, CF-UX-04): the app, your AI, then the game read.
  assert.deepEqual(rows(vm), [`${TODO} Looking for the NeverQuestAlone app…`, `${TODO} Checking your AI…`, `${TODO} Checking the app can see WoW…`]);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Connecting…', 'a connection line comes first in the header');
  assert.ok(shown(vm, 'sayHiBtn') && shown(vm, 'setupOk'));
  assert.equal(vm.evaluate('NS.HUD.h.sayHiBtn.disabled'), 'true', 'Say Hi waits for the rows');
  assert.equal(vm.evaluate('NS.HUD.h.setupWhy.text'), 'Say Hi works once all three are done.');
  assert.deepEqual([vm.evaluate('NS.HUD.h.gotItBtn'), vm.evaluate('NS.HUD.h.bindBtn')], [null, null], 'main\'s Welcome\'s buttons went with it');
  // Main's red buttons, whose tips say only what the click does.
  assert.equal(vm.evaluate('NS.HUD.h.sayHiBtn.template'), vm.evaluate('NS.HUD.h.okBtn.template'));
  assert.deepEqual(vm.json('NS.HUD.h.setupOk.tip'), { title: 'Okay', text: 'Puts this away until you next log in or reload.' });
  // The app answers with a key that works: the three done, Say Hi on, the body says what to do.
  firstSlot(vm);
  hud(vm);
  assert.deepEqual(rows(vm), [`${READY} The NeverQuestAlone app is running.`, `${READY} Connected to Haiku 4.5.`, `${READY} The app can see WoW.`]);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Setting up · 3 of 3 done');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'I\'m NeverQuestAlone. Click Say Hi, then ask me anything.', 'the button beside it (CF-UX-05)');
  assert.equal(vm.evaluate('NS.HUD.h.sayHiBtn.disabled'), 'false');
  assert.ok(!shown(vm, 'setupWhy'));
  // Every row fits its 40 characters.
  for (const r of rows(vm)) assert.ok(r.replace(/^\|A:[^|]*\|a /, '').length <= 40, r);
});

test('the first step is unmistakable (a player, 2026-10-05: "Confusing about what to do at first"): the row to do now is white on a faint gold band, the others grey; once all three are done Say Hi has a gold ring, the line above it is the block\'s primary one, and a grey line says what the colored bar at the top is', () => {
  const WHITE = [1, 1, 1], GREY = [0.6, 0.6, 0.6];
  const colors = vm => [1, 2, 3].map(i => vm.json(`NS.HUD.h.setupRows[${i}].textColor`));
  const band = vm => vm.json('{ NS.HUD.h.setupNow.shown, NS.HUD.h.setupNow.color }');
  const ring = vm => [1, 2, 3, 4].map(i => vm.evaluate(`NS.HUD.h.sayHiRing[${i}].shown`) === 'true');
  // The first seconds: looking for the app is the step now.
  const vm = hud(appVM());
  assert.deepEqual(colors(vm), [WHITE, GREY, GREY]);
  assert.deepEqual(band(vm), [true, [1, 0.82, 0, 0.12]], 'a faint gold band');
  assert.equal(vm.evaluate('NS.HUD.h.setupNow.points.TOPLEFT.rel == NQAHUD'), 'true', 'behind the row');
  assert.deepEqual(ring(vm), [false, false, false, false], 'no ring while Say Hi waits');
  assert.ok(!shown(vm, 'setupBar') && shown(vm, 'setupWhy'), 'why Say Hi waits, one grey line under the buttons');
  // The app answers, no key yet: the AI's row is the step now; the app's row is done, in grey.
  const key = hud(firstSlot(appVM(), { rt: '{ state = "no_key" }', p: provider({ keyState: 'missing' }) }));
  assert.equal(rows(key)[1], `${TODO} Add your Anthropic key in the app.`);
  assert.deepEqual(colors(key), [GREY, WHITE, GREY]);
  const rowY = key.num('NS.HUD.h.setupRows[2].points.TOPLEFT.y');
  assert.equal(key.num('NS.HUD.h.setupNow.points.TOPLEFT.y'), rowY + 2, 'the band 2 above the row it marks');
  assert.equal(key.evaluate('NS.HUD.h.body.style'), 'B');
  // All three done: Say Hi is the step now, ringed in gold: 2 thick, 3 out from it, on all four sides.
  const ready = hud(firstSlot(appVM()));
  assert.deepEqual(colors(ready), [GREY, GREY, GREY], 'done, and out of the way');
  assert.equal(ready.evaluate('NS.HUD.h.body.style'), 'P', 'the line that says to click Say Hi: the primary style, white');
  assert.ok(!shown(ready, 'setupNow'), 'no band: the ring marks Say Hi');
  assert.deepEqual(ring(ready), [true, true, true, true]);
  assert.deepEqual(ready.json('{ NS.HUD.h.sayHiRing[1].color, NS.HUD.h.sayHiRing[1].height, NS.HUD.h.sayHiRing[3].width }'), [[1, 0.82, 0, 1], 2, 2]);
  assert.deepEqual(ready.json('{ NS.HUD.h.sayHiRing[1].points.TOPLEFT.rel == NS.HUD.h.sayHiBtn, NS.HUD.h.sayHiRing[1].points.TOPLEFT.x, NS.HUD.h.sayHiRing[1].points.TOPLEFT.y, NS.HUD.h.sayHiRing[2].points.BOTTOMRIGHT.x, NS.HUD.h.sayHiRing[2].points.BOTTOMRIGHT.y }'), [true, -5, 5, 5, -5]);
  assert.equal(ready.num('NS.HUD.h.setupOk.points.LEFT.x'), 12, 'Okay clear of the ring');
  assert.ok(shown(ready, 'setupBar') && !shown(ready, 'setupWhy'));
  const bar = ready.evaluate('NS.HUD.h.setupBar.text');
  assert.equal(bar, 'Sending shows a colored bar up top.', 'what the label beside the bar says too: sending');
  assert.ok(bar.length <= 37, 'one line at the meta style, with STYLE §12\'s room to grow');
  assert.ok(ready.num('NS.HUD.h.setupBar.points.TOPLEFT.y') <= ready.num('NS.HUD.h.sayHiBtn.points.TOPLEFT.y') - 22 - 8, 'under the ring');
  // With no screen reading nothing is drawn, so no bar is promised: the reload the messages wait for.
  const appOff = byokSlot().replace('caps = { ', 'caps = { "reading", "capture", ').replace('provider = {', 'reading = "off", capture = { state = "off" }, provider = {');
  for (const [why, setup] of [['the app\'s switch off', vm => { apply(vm, appOff); vm.advance(8.5); }], ['stream mode', vm => vm.slash('stream on')], ['reload mode', vm => vm.slash('mode reload')]]) {
    const off = firstSlot(appVM());
    setup(off);
    hud(off);
    assert.equal(off.evaluate('NS.Transport.StripOut()'), 'false', why);
    assert.deepEqual([off.evaluate('NS.HUD.h.view.mode'), off.evaluate('NS.HUD.h.sayHiBtn.disabled')], ['setup', 'false'], `${why}: ready`);
    assert.equal(off.evaluate('NS.HUD.h.setupBar.text'), 'Your messages wait for a reload.', why);
  }
  // Say Hi clicked: the block, its ring and its line go with it.
  click(ready, 'NS.HUD.h.sayHiBtn');
  hud(ready);
  assert.notEqual(ready.evaluate('NS.HUD.h.view.mode'), 'setup');
  assert.ok(!shown(ready, 'setupNow') && !shown(ready, 'setupBar'));
  assert.deepEqual(ring(ready), [false, false, false, false]);
});

test('G1: the rows name what to do for each state, in 40 characters or fewer; the gold line when game sound is off', () => {
  const CASES = [
    [{ rt: '{ state = "no_key" }', p: provider({ keyState: 'missing' }) }, 'Add your Anthropic key in the app.'],
    [{ rt: '{ state = "key_invalid" }', p: provider({ keyState: 'invalid' }) }, 'Replace your Anthropic key in the app.'],
    [{ rt: '{ state = "out_of_credit" }' }, 'Anthropic needs credit: open the app.'],
    [{ p: provider({ id: 'openrouter', name: 'OpenRouter', auth: 'oauth', keyState: 'expired' }) }, 'Sign in to OpenRouter again in the app.'],
    [{ rt: '{ state = "local_down" }', p: provider({ id: 'ollama', name: 'Ollama', auth: 'local', privacy: 'local', model: 'qwen3:8b', modelName: 'qwen3:8b' }) }, 'Start Ollama on your computer.'],
    [{ rt: '{ state = "no_key" }', p: provider({ id: null, name: null, keyState: 'missing', model: null, modelName: null }) }, 'Connect your AI in the app.'],
  ];
  for (const [slot, words] of CASES) {
    const vm = hud(firstSlot(appVM(), slot));
    assert.equal(rows(vm)[1], `${TODO} ${words}`, words);
    assert.doesNotMatch(words, /desktop/, 'the app, named in the row above (STYLE §2.1)');
    assert.ok(words.length <= 40, words);
    // The header counts the steps: the row says what the key or credit needs, so the header
    // doesn't say it again (spec §3.10); only a connection problem takes it (a local server down).
    const status = vm.evaluate('NS.HUD.h.status.text');
    if (/local_down/.test(slot.rt || '')) assert.notEqual(status, 'Setting up · 2 of 3 done', `${words}: ${status}`);
    else assert.equal(status, 'Setting up · 2 of 3 done', words);
  }
  // The bridge's capture state names the fix (cap capture) once it has held 8 s on screen (DR-09);
  // no screen reading counts as done; a state the addon doesn't know names nothing ("checking").
  const cap = state => byokSlot().replace('caps = { ', 'caps = { "capture", ').replace('provider = {', `capture = { state = "${state}" }, provider = {`);
  for (const mac of [true, false]) {
    const vm = confirmHello(newVM({ extra: PUBLIC + (mac ? '' : '\nfunction IsMacClient() return false end'), db: 'NQADB = { settings = { mode = "reload" } }' }).login());
    for (const [state, words] of [['no_signal', mac ? 'The app can\'t see WoW: see why there.' : 'Keep the top of WoW\'s window on screen.'],
      ['minimized', 'Checking the app can see WoW…'], ['unknown', 'Checking the app can see WoW…'],
      ['blocked', 'Close what blocks screen reading.'], ['damaged', 'Reinstall the NeverQuestAlone app.'],
      ['unsupported', 'Type /nqa mode reload for this screen.'], ['no_permission', mac ? 'Allow Screen Recording on your Mac.' : 'Keep the top of WoW\'s window on screen.'],
      ['off', 'Screen reading is off.']]) {
      apply(vm, cap(state));
      vm.advance(0.3);
      hud(vm);
      if (state !== 'off') assert.equal(rows(vm)[2], `${TODO} Checking the app can see WoW…`, `${state}: nothing named before 8 s`);
      vm.advance(8);
      hud(vm);
      assert.equal(rows(vm)[2], `${state === 'off' ? READY : TODO} ${words}`, state);
      assert.ok(words.length <= 40, words);
      assert.ok(mac || !/Screen Recording|Mac/.test(rows(vm)[2]), 'no Mac words on Windows');
    }
  }
  // Game sound off: slow, and what to do, in gold.
  const slow = hud(firstSlot(appVM()));
  slow.run('STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest()');
  hud(slow);
  assert.equal(slow.evaluate('NS.HUD.h.setupSlow.text'), 'Replies are slow with game sound off: keep Enable Sound on.');
  assert.deepEqual(slow.json('NS.HUD.h.setupSlow.textColor'), [1, 0.82, 0]);
});

test('G1: with Screen Reading off (stream mode) no doorbell is rung, so nothing says replies are slow, game sound off or not: not the setup block, the checklist or the light; the status line names the mode, as main\'s does', () => {
  const vm = hud(firstSlot(appVM()));
  vm.run('STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest()');
  hud(vm);
  assert.equal(shown(vm, 'setupSlow'), true, 'Screen Reading on: the sound-off line');
  vm.slash('stream on');
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.View().mode'), 'setup');
  assert.equal(shown(vm, 'setupSlow'), false, 'no doorbells in stream mode: no slow line');
  assert.doesNotMatch(vm.evaluate('select(2, NS.Transport.Light())'), /slow/i);
  assert.doesNotMatch(vm.evaluate('NS.UI.Checklist().text'), /slow/i);
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  assert.equal(vm.evaluate('NS.UI.ui.status.text'), 'No screen reading: your messages wait for a reload, and replies still come in.');
  vm.run('NS.UI.Toggle(false)'); // the open window folds the HUD to its bar
  vm.slash('stream off');
  hud(vm);
  assert.equal(shown(vm, 'setupSlow'), true, 'on again: the sound-off line again');
});

test('G2: Say Hi sends "hi" marked as the first meeting; the HUD works on it, the reply is news with Okay and Open Chat, and the block is gone for good', () => {
  const vm = hud(firstSlot(appVM()));
  click(vm, 'NS.HUD.h.sayHiBtn');
  const wire = vm.outboxWires().at(-1).wire;
  assert.ok(wire.includes('intro=1') && wire.endsWith('\x1fhi'), wire);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'working');
  assert.match(vm.evaluate('NS.HUD.h.body.text'), /You asked:.* hi$/);
  const chat = vm.evaluate('NS.QuickChat().id');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, byokSlot({ records: [replyRec(1, chat, 'There you are! A level 12 mage in Westfall with three quests open.')] }));
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'news');
  assert.ok(shown(vm, 'okBtn') && shown(vm, 'openBtn'));
  assert.equal(vm.evaluate('NQADB.firstReply'), 'true');
  assert.equal(vm.evaluate('NQADB.hudIntro'), 'true', 'main\'s Welcome never shows by itself afterward');
  vm.run('NS.HUD.Okay()');
  hud(vm);
  // G4: main's Quality of Life step (0.5.2) waits for a later UI session than the first reply's, as it
  // waits after main's Welcome is put away (R.qolHold): no card right after the first meeting.
  assert.equal(vm.evaluate('NS.R.qolHold'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', 'the HUD rests idle this session');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  // The next UI session (a /reload): the step, until answered.
  const next = hud(confirmHello(reloadVM(vm).login()));
  assert.equal(next.evaluate('NS.R.qolHold'), null);
  assert.equal(next.evaluate('NS.HUD.h.view.mode'), 'qol', 'then the step, as after main\'s Welcome');
  next.run('NS.QoL.Skip()');
  hud(next);
  assert.equal(next.evaluate('NS.HUD.h.view.mode'), 'idle', 'the HUD rests idle');
  // Once there's been a reply, "hi" is just a word, and its reply is no first reply: it holds nothing.
  next.slash('hi');
  assert.ok(!next.outboxWires().at(-1).wire.includes('intro='));
  next.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(next, byokSlot({ records: [replyRec(2, next.evaluate('NQADB.activeChat'), 'Still here.')] }));
  assert.ok(next.history().some(h => JSON.stringify(h).includes('Still here.')), 'the reply came');
  assert.equal(next.evaluate('NS.R.qolHold'), null);
});

test('G1: the block\'s Okay puts it away for this session only; news, work and a warning come first; folded (the window open, the bar), it waits', () => {
  const vm = hud(firstSlot(appVM()));
  vm.advance(1);
  click(vm, 'NS.HUD.h.setupOk');
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Ready');
  const again = hud(firstSlot(reloadVM(vm).login()));
  assert.equal(again.evaluate('NS.HUD.h.view.mode'), 'setup', 'back after a reload: no reply yet');
  // A warning (cap ekind) comes first; its Okay, then the block again.
  again.run('NS.Transport.Warn("w", "The whole story.", "Replies come slower this session")');
  hud(again);
  assert.equal(again.evaluate('NS.HUD.h.view.mode'), 'warn');
  again.advance(1);
  click(again, 'NS.HUD.h.warnOk');
  assert.equal(again.evaluate('NS.HUD.h.view.mode'), 'setup');
  // The window open: the HUD is one bar, and the window's checklist stands in, with its Say hi chip.
  again.slash('');
  hud(again);
  assert.equal(again.evaluate('NQAHUD.shown'), 'false');
  assert.equal(again.evaluate('NQAHUDBar.status.text'), 'Setting up · 3 of 3 done');
  const chip = again.evaluate('NS.UI.ui.bubbles[1].chips[1].label.text');
  assert.equal(chip, 'Say Hi', 'Title Case, as the HUD\'s button (spec §3.10 G2)');
  again.run('local c = NS.UI.ui.bubbles[1].chips[1]; c.scripts.OnClick(c)');
  assert.ok(again.outboxWires().at(-1).wire.includes('intro=1'), 'the chip marks it too');
});

test('G1: the block fits main\'s panel: 300 wide, and under the header no taller than main\'s Welcome it stands in for', () => {
  const METRICS = fs.readFileSync(path.join(__dirname, '..', 'render_ui.js'), 'utf8').match(/const METRICS = `([\s\S]*?)`;/)[1];
  // Main's Welcome's block under the header at 0.5.3, measured with these metrics before it went
  // with the retired build (d231b6e: 245 tall, the block from 61).
  const WELCOME_BLOCK = 184;
  const block = vm => vm.num('NQAHUD:GetHeight()') - vm.num('NS.HUD.h.mainY');
  const vm = hud(firstSlot(appVM({ extra: METRICS }), { rt: '{ state = "no_key" }', p: provider({ keyState: 'missing' }) }));
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'setup');
  assert.equal(vm.num('NQAHUD:GetWidth()'), 300);
  assert.ok(block(vm) <= WELCOME_BLOCK, `the setup block (${block(vm)}) against main's Welcome (${WELCOME_BLOCK})`);
  // Ready (Say Hi's ring, the primary line, the colored bar's line): no taller.
  const ready = hud(firstSlot(appVM({ extra: METRICS })));
  assert.equal(ready.evaluate('NS.HUD.h.view.mode'), 'setup');
  assert.ok(block(ready) <= WELCOME_BLOCK, `the ready block (${block(ready)}) against main's Welcome (${WELCOME_BLOCK})`);
});

test('G2, G3: /nqa hi before the first reply is Say hi\'s; /nqa help opens with "Getting around"', () => {
  const vm = firstSlot(appVM());
  vm.slash('hi');
  assert.ok(vm.outboxWires().at(-1).wire.includes('intro=1'));
  vm.slash('HI');
  assert.ok(vm.outboxWires().at(-1).wire.includes('intro=1'), 'any case');
  vm.slash('hi there');
  assert.ok(!vm.outboxWires().at(-1).wire.includes('intro='), 'exactly hi');
  vm.slash('');
  vm.slash('help');
  // As the window shows it: || is one |, the commands' gold gone.
  const shown = t => String(t ?? '').replace(/\|\|/g, '\x00').replace(/\|c[0-9a-fA-F]{8}|\|r/g, '').replace(/\x00/g, '|');
  const help = shown(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text'));
  assert.match(help, /^Getting around:\nClick Ask to ask anything, or click the portrait for all your chats\./, 'the product\'s voice, and click for anything on screen');
  assert.ok(help.includes('\n\n/nqa  Open or close the window\n/nqa <message>  Ask anything\n'), `then main\'s short list: ${help}`);
  vm.slash('help all');
  assert.ok(shown(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text')).includes('\n/nqa  Open or close the window\n'), 'every command, /nqa with them');
  // The hello says the client's language, and a first reply once there's been one.
  const hello = vm.outboxWires().find(e => e.wire.includes('\x1fhello\x1f')) || null;
  if (hello) assert.ok(hello.wire.includes('loc=enUS') || hello.wire.includes('loc='), hello.wire);
  // After the first reply, "hi" is a message like any other: no intro mark.
  const after = confirmHello(newVM({ db: 'NQADB = { hudIntro = true, firstReply = true }' }).login());
  after.slash('hi');
  assert.ok(!after.outboxWires().at(-1).wire.includes('intro='));
});

test('G1: without word from the app for 2 minutes, row 1 says what to do: "Open the NeverQuestAlone app."; saved data from 0.5.3 with no slot yet shows the setup block from load', () => {
  const vm = hud(appVM());
  assert.equal(rows(vm)[0], `${TODO} Looking for the NeverQuestAlone app…`);
  vm.advance(130);
  hud(vm);
  assert.equal(rows(vm)[0], `${TODO} Open the NeverQuestAlone app.`);
  // Saved data from 0.5.3 (its saved backend, no reply yet), whatever installed it: the setup block from load.
  const older = hud(newVM({ db: 'NQADB = { backend = "byok" }' }).login());
  assert.equal(older.evaluate('NS.HUD.h.view.mode'), 'setup');
  assert.deepEqual(rows(older), [`${TODO} Looking for the NeverQuestAlone app…`, `${TODO} Checking your AI…`, `${TODO} Checking the app can see WoW…`]);
});

test('G1 (gap 12): after the first reply, the app losing sight of the game is a warn line (the bridge\'s capture state), with its Okay, until it can see again; under "Sending…" it says why; the setup block never shows it', () => {
  const cap = (state, o = {}) => byokSlot(o).replace('caps = { ', 'caps = { "capture", ').replace('provider = {', `capture = { state = "${state}" }, provider = {`);
  const vm = hud(confirmHello(newVM({ extra: PUBLIC, db: 'NQADB = { hudIntro = true, firstReply = true, qolAsked = true }' }).login()));
  apply(vm, cap('ok'));
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle');
  // macOS took the permission away: its own words, in gold, with Okay, once it has held 8 s on
  // screen (DR-09: a restart's quick heal never shows).
  apply(vm, cap('no_permission'));
  vm.advance(7);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', 'not before 8 s');
  vm.advance(1.5);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'warn');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'macOS stopped screen reading');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Allow it on your Mac.');
  assert.deepEqual(vm.json('NS.HUD.h.status.textColor'), [1, 0.82, 0]);
  assert.ok(shown(vm, 'warnOk'));
  // The bar: its head, as a warning's, with the same Okay.
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'macOS stopped screen reading');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true');
  vm.advance(1);
  vm.run('local b = NQAHUDBar.okBtn; b.scripts.OnClick(b)');
  vm.run('NQADB.settings.hudMin = false; NS.HUD.Render()');
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', 'Okay puts it away');
  apply(vm, cap('no_permission'));
  vm.advance(9);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', 'the same state stays put away');
  // It ends, then another starts: said again. A key the addon doesn't know names nothing (SY-20).
  apply(vm, cap('ok'));
  apply(vm, cap('minimized'));
  vm.advance(9);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', '"minimized" is no cause');
  apply(vm, cap('no_signal'));
  vm.advance(9);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'warn');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone can\'t see the game');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'See why in the NeverQuestAlone app.', 'a Mac\'s words: its corner can\'t be covered');
  // A message waiting on the strip: "Sending…", and why it doesn't go, in the line's one line (nothing moves).
  vm.send('where next?');
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Sending…');
  assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'NeverQuestAlone can\'t see the game');
  assert.equal(vm.evaluate('NS.HUD.h.sub.maxLines'), '1');
  assert.equal(vm.evaluate('NS.HUD.h.view.detail'), 'NeverQuestAlone can\'t see the game: see why in the NeverQuestAlone app.', 'the whole of it a click away');
  // The persona's name, when the app named another.
  apply(vm, cap('blocked', { companion: 'Skully', p: provider({ companion: 'Skully' }) }));
  vm.advance(9);
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.view.detail'), 'Skully can\'t see the game: close what blocks screen reading.');
  // No capture cap (an older bridge): a message the strip hasn't carried for 15 s on screen says so, and
  // the row's button is Reload (DR-07).
  const old = hud(confirmHello(newVM({ extra: PUBLIC, db: 'NQADB = { hudIntro = true, firstReply = true }' }).login()));
  apply(old, byokSlot());
  old.send('where next?');
  hud(old);
  assert.equal(old.evaluate('NS.HUD.h.sub.text'), '0 s', 'main\'s "Sending…" says how long (0.4.7)');
  for (let i = 0; i < 4; i++) { old.advance(8); old.run('NS.Transport.Beat()'); }
  hud(old);
  assert.equal(old.evaluate('NS.HUD.h.status.text'), 'Sending…');
  assert.equal(old.evaluate('NS.HUD.h.sub.text'), '32 s · not read yet');
  assert.equal(old.evaluate('NS.HUD.h.stopBtn.text'), 'Reload');
  // Before the first reply the setup block's row says it instead.
  const early = hud(firstSlot(appVM()));
  apply(early, cap('no_signal'));
  early.advance(9);
  hud(early);
  assert.equal(early.evaluate('NS.HUD.h.view.mode'), 'setup');
  assert.equal(rows(early)[2], `${TODO} The app can't see WoW: see why there.`);
});
