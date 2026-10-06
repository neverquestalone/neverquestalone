'use strict';
// Bugs real in main's own 0.4.4 code (the consolidation's commit 6, E), fixed since addon
// 0.4.9 (E-039); the addon's code for them is main's. Run on a slot with none of the new
// caps, main's frames (NQAHUDBar, its okBtn).
//   E-1 the bar's Okay acts on what its row shows (C-29, C-30);
//   E-2 the window's X says where the reply will show;
//   E-3 a /nqa stop's answer pops no pending send;
//   E-4 the /nqa hud and /nqa text answers print whole words (main's, with no "|" since 0.5.x).
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM } = require('../helpers/nqa-vm');
const { oldSlot, confirmHello, apply, replyRec, errorRec } = require('../helpers/byok-slots');

const activeId = vm => vm.evaluate('NQADB.activeChat');
const bar = vm => [vm.evaluate('NQAHUDBar.status.text'), vm.evaluate('NQAHUDBar.okBtn.shown')];
const unread = (vm, id) => vm.num(`NS.Chats.Find("${id}").unread`);
const click = (vm, expr) => vm.run(`local b = ${expr}; b.scripts.OnClick(b, "LeftButton")`);
const BAR_DB = 'NQADB = { hudIntro = true, settings = { hudMin = true } }';
// The HUD as its bar, with an unread reply.
function withReply() {
  const vm = confirmHello(newVM({ db: BAR_DB, extra: 'STUB.tipLines = {}; function GameTooltip:AddLine(t) table.insert(STUB.tipLines, t) end' }).login());
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, oldSlot({ records: [replyRec(1, activeId(vm), 'In Ironforge: the Great Forge.')] }));
  vm.run('NS.HUD.Render()');
  return vm;
}
const tip = vm => { vm.run('STUB.tipLines = {}; local b = NQAHUDBar.okBtn; b.scripts.OnEnter(b)'); return vm.list('STUB.tipLines').at(-1); };

test('E-1 (C-30): on the bar, a ding, a finished route, a flash or a quip over an unread reply: Okay ends that line first (its tooltip says so) and the reply stays unread; then the same Okay puts the reply away', () => {
  for (const [label, trigger, head] of [
    ['ding', 'STUB.FireEvent("PLAYER_LEVEL_UP", 24)', 'Ding! Level 24'],
    ['route done', 'NS.HUD.RouteDone("Copper veins", 6)', 'Route finished'],
    ['flash', 'NS.HUD.Flash("Not sent", "Too long.")', 'Not sent'],
  ]) {
    const vm = withReply();
    const id = activeId(vm);
    assert.deepEqual(bar(vm), ['In Ironforge: the Great Forge.', 'true'], 'the reply, with its Okay');
    vm.run(`${trigger}; NS.HUD.Render()`);
    assert.deepEqual(bar(vm), [head, 'true'], label);
    assert.equal(tip(vm), 'Puts it away; nothing is sent.', `${label}: the tooltip says what it does`);
    click(vm, 'NQAHUDBar.okBtn');
    assert.equal(unread(vm, id), 1, `${label}: the reply is still unread (main read it here)`);
    assert.deepEqual(bar(vm), ['In Ironforge: the Great Forge.', 'true'], `${label}: the row falls back to the reply`);
    assert.equal(tip(vm), 'Marks the reply read and puts it away; nothing is sent.');
    vm.advance(1); // main's guard after an Okay (C-72)
    click(vm, 'NQAHUDBar.okBtn');
    assert.equal(unread(vm, id), 0, `${label}: the second Okay reads the reply`);
  }
});

test('E-1 (C-30): a pending re-plan over an unread reply: the bar\'s Okay sends it now, once, and leaves the reply alone', () => {
  const vm = withReply();
  const id = activeId(vm);
  // A route to re-plan.
  vm.run(`NS.Transport.HandleSlotData(${oldSlot().replace('records = {  }', 'records = {  }').replace(/chats = \{\}/, 'chats = {}')}, "slot")`);
  const sent = vm.outboxWires().length;
  vm.run('NS.HUD.Replan(); NS.HUD.Render()');
  assert.match(bar(vm)[0], /^Asking: /);
  assert.equal(bar(vm)[1], 'true');
  assert.equal(tip(vm), 'Sends it now, without the 3 s wait.'); // main's words (0.4.9)
  click(vm, 'NQAHUDBar.okBtn');
  assert.equal(vm.outboxWires().length, sent + 1, 'sent now, not after the 3 s');
  assert.equal(unread(vm, id), 1, 'the reply untouched');
  vm.advance(4);
  assert.equal(vm.outboxWires().length, sent + 1, 'once: the wait\'s own send doesn\'t follow');
});

test('E-1 (C-29): "Can\'t reach the NeverQuestAlone app" over an unread reply on the bar: no Okay (it would read a reply you haven\'t seen); Show More, and the reply\'s Okay is under its words', () => {
  const vm = withReply();
  const id = activeId(vm);
  vm.advance(200);
  vm.run('NS.HUD.Render()');
  assert.deepEqual(bar(vm), ['Can\'t reach the NeverQuestAlone app', 'false']);
  vm.run('NS.HUD.BarOkay()');
  assert.equal(unread(vm, id), 1, 'still unread');
  vm.run('NS.HUD.SetForm("full")');
  assert.equal(vm.evaluate('NQAHUD.shown'), 'true');
  assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Can\'t reach the NeverQuestAlone app');
  assert.equal(vm.evaluate('NS.HUD.h.body.text'), 'In Ironforge: the Great Forge.');
  assert.equal(vm.evaluate('NS.HUD.h.okBtn.shown'), 'true');
  click(vm, 'NS.HUD.h.okBtn');
  assert.equal(unread(vm, id), 0, 'read there');
  // Plain news on the bar keeps main's Okay.
  const n = withReply();
  assert.deepEqual(bar(n), ['In Ironforge: the Great Forge.', 'true']);
  assert.equal(tip(n), 'Marks the reply read and puts it away; nothing is sent.');
});

test('E-2: the window\'s X says where the reply will show: the HUD while it shows news; else (its compass form, closed, off) the banner at the top of the screen', () => {
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true }', extra: 'STUB.tipLines = {}; function GameTooltip:AddLine(t) table.insert(STUB.tipLines, t) end' }).login());
  vm.slash('');
  const get = () => {
    vm.run('STUB.tipLines = {}; local c = NS.UI.ui.closeBtn; c.scripts.OnEnter(c)');
    return vm.list('STUB.tipLines').at(-1);
  };
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the HUD shows the reply when it lands.', 'the HUD shows news: main\'s words');
  vm.slash('hud compass');
  vm.slash('');
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands.', 'the compass: the banner');
  vm.slash('hud full');
  vm.run('NS.HUD.Close()');
  vm.slash('');
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands.', 'closed: the banner, never "the small bar"');
  vm.slash('hud off');
  vm.slash('');
  assert.equal(get(), 'Closes the window. NeverQuestAlone keeps working, and the reply shows at the top of the screen when it lands.', 'off: the small bar badges it, the banner shows it');
});

test('E-3: a /nqa stop\'s answer ("Nothing was running.", kind stop; "Couldn\'t stop: …", kind gateway after a stop) pops no pending send: the running message stays busy and its own reply answers it', () => {
  for (const [kind, text] of [['gateway', 'Couldn\'t stop: the gateway is unreachable.'], ['stop', 'Nothing was running.']]) {
    const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true }' }).login());
    const id = activeId(vm);
    vm.send('where is the forge');
    vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    const pending = () => vm.num(`#NS.Chats.Find("${id}").pending`);
    assert.equal(pending(), 1);
    vm.slash('stop');
    apply(vm, oldSlot({ records: [errorRec(1, id, kind, null, text)] }));
    assert.equal(pending(), 1, `${kind}: the running message still waits for its answer`);
    assert.equal(vm.evaluate(`NS.Chats.IsBusy(NS.Chats.Find("${id}"))`), 'true');
    // Shown as main shows an error: red news, not a note (skeptic C1).
    const e = `NS.Chats.Find("${id}").history[#NS.Chats.Find("${id}").history]`;
    assert.equal(vm.evaluate(`${e}.info`), null);
    vm.run('NS.HUD.Render()');
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'Something went wrong');
    apply(vm, oldSlot({ records: [replyRec(2, id, 'The forge is in the middle of the city.')] }));
    assert.equal(pending(), 0, `${kind}: its own reply answers it`);
  }
  // An ordinary gateway error (no stop asked) still answers the message, as main.
  const vm = confirmHello(newVM().login());
  const id = activeId(vm);
  vm.send('where is the forge');
  vm.run('for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
  apply(vm, oldSlot({ records: [errorRec(1, id, 'gateway', null, 'Your AI isn\'t reachable right now.')] }));
  assert.equal(vm.num(`#NS.Chats.Find("${id}").pending`), 0);
});

test('E-4: the /nqa hud and /nqa text answers print whole words (main\'s commands-ux answers name the forms with no "|"), never the colour reset that made "fulleset"', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('hud');
  const hud = vm.chatLines().at(-1);
  assert.ok(hud.endsWith('The HUD is on. Change it with /nqa hud on, off, full, bar, compass or reset.'), hud);
  vm.slash('text');
  assert.ok(vm.chatLines().at(-1).endsWith('Chat Text Size: Medium. Settings has it too.'), vm.chatLines().at(-1));
  // As the chat frame shows it: no |r or |c escape is left in the words.
  assert.doesNotMatch(hud.replace(/\|\|/g, '').replace(/^\|cff7ec8ff\[NeverQuestAlone\]\|r /, ''), /\|[rc]/, 'no escape left in the words');
  // The preview renderer draws it as the game does ("||" in tests/helpers/ui-render.js).
  const { renderTree } = require('../helpers/ui-render');
  const html = renderTree({ id: 1, kind: 'Frame', w: 900, h: 40, children: [{ id: 2, kind: 'FontString', text: hud, w: 880, points: [{ point: 'TOPLEFT', rel: 1, relPoint: 'TOPLEFT', x: 0, y: 0 }] }] });
  assert.ok(html.includes('/nqa hud on, off, full, bar, compass or reset.'), html);
  assert.ok(!html.includes('fulleset') && !html.includes('||'), html);
});
