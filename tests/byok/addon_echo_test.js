'use strict';
// The addon's half of the desktop echo switch (BUILD-PLAN "Contract: what the addon reads",
// bridge.echo; PRD PR-1, TH13, B4): with the bridge's echo cap, bridge.echo "off" keeps every
// reply line out of the chat frame whatever /nqa echo says, "on" lets /nqa echo decide;
// without the cap (an app from before it) /nqa echo alone decides, as before. /nqa echo and the
// Settings row say where the switch is while the desktop's is off; nothing appears by itself.
// Same VM as tests/byok/addon_byok_test.js: the real addon in fengari on the stub; the
// Settings row is main's CHOICES entry, its tooltip a function read when shown.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM, lstr } = require('../helpers/nqa-vm');
const { oldSlot, CAPS, byokSlot, confirmHello, apply } = require('../helpers/byok-slots');

const ECHO_CAPS = `${CAPS}, "echo"`;
// A BYOK slot with the echo cap and the desktop's switch (echo = nil: the field left out).
const echoSlot = (echo, o = {}) => byokSlot({ caps: ECHO_CAPS, ...o }).replace('think = "medium"', echo ? `think = "medium", echo = "${echo}"` : 'think = "medium"');
let seq = 0;
const replyRec = (chat, text, summary = '') => `{ seq = ${++seq}, t = "reply", chat = "${chat}", mid = "m${seq}", agent = "main", text = ${lstr(text)}, summary = ${lstr(summary)}, more = 0 }`;
const errorRec = (chat, text) => `{ seq = ${++seq}, t = "error", chat = "${chat}", kind = "overloaded", action = "retry", text = ${lstr(text)} }`;
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');

function setup(slot) {
  seq = 0;
  const vm = confirmHello(newVM({ db: 'NQADB = { hudIntro = true }' }).login());
  apply(vm, slot);
  return { vm, id: vm.evaluate('NS.Chats.Active().id') };
}
// What one reply (or error) puts in the chat frame.
function arrive(vm, slotFor, rec) {
  vm.run('STUB.chat = {}');
  apply(vm, slotFor([rec]));
  return vm.chatLines();
}

test('echo: bridge.echo "off" keeps replies and errors out of the chat frame in every /nqa echo mode; the window and the sound still have them', () => {
  const { vm, id } = setup(echoSlot('off'));
  const slot = records => echoSlot('off', { records });
  for (const mode of ['summary', 'full', 'short', 'off']) {
    vm.slash(`echo ${mode}`);
    assert.equal(vm.evaluate('NQADB.settings.echo'), mode, 'this addon keeps its own choice');
    assert.equal(vm.evaluate('NS.Notify.EchoMode()'), 'off');
    assert.deepEqual(arrive(vm, slot, replyRec(id, `Reply in ${mode} mode.\n\nTL;DR: ${mode}.`, `${mode}.`)), [], mode);
    assert.equal(vm.lastHistory().text, `Reply in ${mode} mode.\n\nTL;DR: ${mode}.`, 'in the window all the same');
  }
  vm.slash('echo full');
  assert.deepEqual(arrive(vm, slot, errorRec(id, 'Anthropic is busy right now.')), [], 'an error line neither');
  assert.ok(vm.num('#STUB.played') > 0, 'the note sound still plays');
  // Replies that waited out a fight, collapsed into one line: none either.
  vm.run('NS.R.inCombat = true; STUB.combat = true; STUB.chat = {}');
  const recs = [1, 2, 3, 4].map(k => replyRec(id, `Held ${k}.`));
  apply(vm, slot(recs));
  assert.equal(vm.num('#NS.R.dndQueue'), 4, 'held for the fight: more than 3 collapse into one line');
  vm.run('NS.R.inCombat = false; STUB.combat = false; NS.Notify.Flush()');
  assert.deepEqual(vm.chatLines(), [], 'no "4 replies arrived during combat" line');
  assert.equal(vm.lastHistory().text, 'Held 4.');
});

test('echo: bridge.echo "on" lets /nqa echo decide (summary, full, short, off); a bridge with the cap but no word is off', () => {
  const { vm, id } = setup(echoSlot('on'));
  const slot = records => echoSlot('on', { records });
  assert.equal(vm.evaluate('NS.Notify.EchoMode()'), 'summary');
  let lines = arrive(vm, slot, replyRec(id, 'Line one\nLine two\n\nTL;DR: two lines.', 'Two lines.'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('|cff7ec8ff[NeverQuestAlone · Chat 1]|r Two lines.'), lines[0]);
  vm.slash('echo full');
  lines = arrive(vm, slot, replyRec(id, 'A\nB'));
  assert.deepEqual(lines.slice(0, 2), ['|cff7ec8ff[NeverQuestAlone · Chat 1]|r A', '    B']);
  vm.slash('echo off');
  assert.deepEqual(arrive(vm, slot, replyRec(id, 'quiet')), []);
  // The desktop's switch turned off in the app: the next reply stays out, and on again brings it back.
  vm.slash('echo short');
  assert.deepEqual(arrive(vm, records => echoSlot('off', { records }), replyRec(id, 'now off')), []);
  assert.equal(arrive(vm, slot, replyRec(id, 'now on')).length, 1);
  // The cap without a word for it (not "on"): off, the privacy default for a new install (PR-1).
  assert.deepEqual(arrive(vm, records => echoSlot(null, { records }), replyRec(id, 'no word')), []);
});

test('echo: without the cap (an app from before it) /nqa echo alone decides, as before', () => {
  // A slot with none of the new caps: a stray echo field changes nothing.
  const oc = setup(oldSlot({ records: [] }).replace('think = "medium"', 'think = "medium", echo = "off"'));
  const ocSlot = records => oldSlot({ records }).replace('think = "medium"', 'think = "medium", echo = "off"');
  assert.equal(oc.vm.evaluate('NS.Notify.DesktopEchoOff()'), 'false');
  assert.equal(arrive(oc.vm, ocSlot, replyRec(oc.id, 'Hello.\n\nTL;DR: hello.', 'Hello.')).length, 1);
  oc.vm.slash('echo');
  assert.equal(oc.vm.chatLines().at(-1), '|cff7ec8ff[NeverQuestAlone]|r Replies in Your Chat Frame: TL;DR. Settings has it too.');
  // A public bridge without the echo cap.
  const pub = setup(byokSlot());
  assert.equal(arrive(pub.vm, records => byokSlot({ records }).replace('think = "medium"', 'think = "medium", echo = "off"'), replyRec(pub.id, 'Hi.\n\nTL;DR: hi.', 'Hi.')).length, 1);
});

test('echo: /nqa echo and the Settings row say plainly that the desktop\'s switch is off, only when asked; on, today\'s words', () => {
  const { vm } = setup(echoSlot('off'));
  vm.slash('echo');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[NeverQuestAlone]|r Replies in Your Chat Frame: TL;DR. It\'s off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more.');
  vm.slash('echo full');
  assert.equal(vm.chatLines().at(-1), '|cff7ec8ff[NeverQuestAlone]|r Replies in Your Chat Frame: Whole Reply. It\'s off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more.');
  assert.equal(vm.evaluate('NQADB.settings.echo'), 'full');
  // In the window, the answer is its notice (as every command's).
  vm.slash('');
  vm.slash('echo');
  assert.equal(notice(vm), 'Replies in Your Chat Frame: Whole Reply. It\'s off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more.');
  // The Settings row's tooltip in the public build, read when shown (as the companion switch's): its
  // pubTip, which the list gets there (Settings.lua AddSteps); main's row keeps its string (E-047's slider).
  const tip = '(function() for _, c in ipairs(NS.Settings.CHOICES) do if c[3] == "echo" then return c.pubTip() end end end)()';
  assert.equal(vm.evaluate(tip), 'Sets how much of each reply also shows in your chat frame; the window always has all of it. It\'s off in the NeverQuestAlone app right now, so none show: turn on Replies in chat frame under Settings, Show more.');
  apply(vm, echoSlot('on'));
  assert.equal(vm.evaluate(tip), 'Sets how much of each reply also shows in your chat frame; the window always has all of it.');
  vm.slash('echo');
  assert.equal(notice(vm), 'Replies in Your Chat Frame: Whole Reply. Settings has it too.');
  // Nothing appears by itself when the desktop's switch changes: no line, no notice, no toast.
  vm.slash('');
  vm.run('STUB.chat = {}');
  const toasts = vm.num('NS.UI.ui.toastOrder and #NS.UI.ui.toastOrder or 0');
  apply(vm, echoSlot('off'));
  apply(vm, echoSlot('on'));
  vm.advance(5);
  assert.deepEqual(vm.chatLines(), []);
  assert.equal(vm.num('NS.UI.ui.toastOrder and #NS.UI.ui.toastOrder or 0'), toasts);
  // Without the cap, the row: main's words.
  const oc = setup(oldSlot({ records: [] }));
  assert.equal(oc.vm.evaluate('(function() for _, c in ipairs(NS.Settings.CHOICES) do if c[3] == "echo" then return c[5] end end end)()'), 'Sets how much of each reply also shows in your chat frame; the window always has all of it.');
});
