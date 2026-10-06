'use strict';
// Display P0's addon half (display design rev 5, Layer 3, Layer 4 and Layer 5 §6; the systems critic's
// round 5): the public build's addon on main's widget, in the fengari VM.
//   DR-07  the stuck send: "Sending…" says it hasn't been read once the record has 15 s of the strip on
//          screen (Alt+Z, a cinematic or a loading screen pause it), and the row's own button becomes its
//          one action, Reload; slot-only mode too, once a load 10 s or more after the send lacks the ack;
//          after a Reload that didn't deliver it (15 s on screen from the new session's first slot load,
//          SY-29), "didn't go through" and Discard, which drops it from the outbox and the strip.
//   DR-08  the hello's mode (SY-12); a mode seen on the strip and in the outbox when the mode changes
//          (SY-17b); the 60 s self-probe while no_signal is published (SY-14e); the strip ignores its
//          parent's alpha and is shown again when another addon hides it.
//   DR-09  the public words from the contract: a published cause after 8 s on screen, an unknown key
//          names none (SY-20), unsupported has its own words (SY-24), the setup row never latches (D-28).
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM, reloadVM } = require('../helpers/nqa-vm');
const { PUBLIC, byokSlot, confirmHello, apply } = require('../helpers/byok-slots');

const WELCOMED = 'NQADB = { hudIntro = true, firstReply = true, qolAsked = true }';
const WINDOWS = '\nfunction IsMacClient() return false end';
// Records the strip's alpha setting (the stub's frames accept any method and keep nothing).
const ALPHA = `
do local cf = CreateFrame
CreateFrame = function(kind, name, ...) local f = cf(kind, name, ...)
  if name == "NQAStrip" then f.SetIgnoreParentAlpha = function(self, on) self.ignoresParentAlpha = on end end
  return f end end`;

// A public session, welcomed, its hello answered, a BYOK app beating. The companion's state record is
// taken as read (the bridge has its seq), so the strip carries only what a test puts there.
function pub({ extra = '', db = WELCOMED } = {}) {
  const vm = confirmHello(newVM({ extra: PUBLIC + ALPHA + extra, db }).login());
  apply(vm, byokSlot());
  vm.run('NS.R.stateRec = nil; NS.Transport.RefreshStrip()');
  return vm;
}
// Time passes with the app beating (its presence bell), a few seconds at a step.
function wait(vm, sec) {
  let left = sec;
  while (left > 1e-9) {
    const step = Math.min(5, left);
    vm.advance(step);
    vm.run('NS.Transport.Beat()');
    left -= step;
  }
  return vm;
}
const hud = vm => { vm.run('NS.HUD.Render()'); return vm; };
const cap = (state, o = {}) => byokSlot(o).replace('caps = { ', 'caps = { "capture", ').replace('provider = {', `capture = { state = "${state}" }, provider = {`);
const click = (vm, expr) => vm.run(`local b = ${expr}; b.scripts.OnClick(b, "LeftButton")`);
// A wire's type and args (2 US token US key US type US chat US args US body).
function rec(wire) {
  const f = wire.split('\x1f');
  const args = {};
  for (const pair of (f[5] || '').split(';')) { const i = pair.indexOf('='); if (i > 0) args[pair.slice(0, i)] = pair.slice(i + 1); }
  return { key: f[2], type: f[3], args };
}
const stripRecs = vm => vm.stripWires().map(rec);
const outboxRecs = vm => vm.outboxWires().map(e => rec(e.wire));
const keyed = vm => vm.list('NQADB.outbox').map(e => e.key).filter(k => /_\d+$/.test(k));

// ---------------------------------------------------------------- DR-07

test('DR-07: "Sending…" says it hasn\'t been read once the record has 15 s of the strip on screen, not before; the row\'s Stop becomes Reload (its text, not its place); the window\'s line and the banner say it; Reload reloads; the ack ends it', () => {
  const vm = hud(pub());
  vm.send('where is the forge');
  hud(vm);
  const y = vm.num('NS.HUD.h.stopBtn.y');
  wait(vm, 14);
  hud(vm);
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text'), vm.evaluate('NS.HUD.h.stopBtn.text')], ['Sending…', '14 s', 'Stop']);
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null);
  wait(vm, 1.5);
  hud(vm);
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text'), vm.evaluate('NS.HUD.h.sub.maxLines')], ['Sending…', '15 s · not read yet', '1']);
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Reload');
  assert.equal(vm.num('NS.HUD.h.stopBtn.y'), y, 'the button where Stop was: nothing moves');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.disabled'), 'false');
  assert.deepEqual(vm.json('NS.HUD.h.stopBtn.tip'), { title: 'Reload', text: 'Reloads WoW\'s interface, which sends your message.' });
  assert.equal(vm.evaluate('NS.HUD.h.view.detail'), 'NeverQuestAlone hasn\'t read your message yet. Click Reload to send it.', 'the whole of it a click on the line away');
  // The window: its one line, and the working line's Stop is Reload (so no banner over it).
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  assert.equal(vm.evaluate('NS.UI.StatusText()'), '|cffffd100NeverQuestAlone hasn\'t read your message yet.|r');
  assert.match(vm.evaluate('NS.UI.ui.work.text.text'), /^Sending · 1\d s · not read yet$/);
  assert.equal(vm.evaluate('NS.UI.ui.work.stop.text'), 'Reload');
  assert.equal(vm.evaluate('NQABanner and NQABanner.shown'), 'false', 'one button: the working line has it');
  // Another chat in the window: the banner above it, with the words and the one button.
  vm.run('NS.Chats.New("Other"); NS.Refresh("all")');
  assert.equal(vm.evaluate('NQABanner.shown'), 'true');
  assert.equal(vm.evaluate('NQABanner.text.text'), 'NeverQuestAlone hasn\'t read your message yet. Click Reload to send it.');
  assert.equal(vm.evaluate('NQABanner.reload.text'), 'Reload');
  // No cause guessed, no Screen Recording.
  assert.doesNotMatch(vm.evaluate('NS.HUD.h.view.detail'), /Screen Recording|corner|permission/);
  // Reload is the click.
  vm.run('NS.UI.Toggle(false); NS.HUD.Render()');
  vm.advance(1);
  click(vm, 'NS.HUD.h.stopBtn');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  // The ack (by the slot) ends it: Sending, then Working.
  const key = keyed(vm)[0];
  vm.run(`STUB.reloaded = false; NS.Transport.Acked(${JSON.stringify(key)}, "slot")`);
  hud(vm);
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null);
  assert.notEqual(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Reload');
});

test('DR-07: the clock counts only while the strip is on screen: Alt+Z (UIParent hidden) for 60 s doesn\'t move it; a hitch counts at most 1 s', () => {
  const vm = hud(pub());
  vm.send('where is the forge');
  wait(vm, 5);
  vm.run('UIParent.shown = false');
  wait(vm, 60);
  hud(vm);
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null, 'Alt+Z: paused');
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Stop');
  vm.run('UIParent.shown = true');
  wait(vm, 9);
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null, '14 s on screen');
  wait(vm, 1.5);
  assert.ok(vm.num('NS.Transport.StuckSend()') >= 15);
  // The app silent for 2 minutes: the connection line says it instead (nothing stuck without the app).
  vm.advance(125);
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null);
});

test('DR-07: slot-only mode (game sound off) is stuck only once a slot load taken 10 s or more after the send came back without its ack', () => {
  const vm = pub();
  vm.run('STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest()');
  assert.equal(vm.evaluate('NS.Transport.SlotOnly()'), 'true');
  vm.slot(byokSlot()); // every load reads a slot without the ack
  vm.send('where is the forge');
  const key = keyed(vm)[0];
  vm.run('NS.R.sched = {}'); // no scheduled loads: nothing proves it went unread
  vm.advance(20);
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null, '20 s on screen, but no load says so');
  vm.run('NS.Transport.LoadSlot("idle")');
  assert.equal(vm.bool(`NS.R.missed[${JSON.stringify(key)}]`), true);
  assert.ok(vm.num('NS.Transport.StuckSend()') >= 15, 'the load lacked the ack');
  hud(vm);
  assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Reload');
  // Its own schedule: the 5 s load is too early to prove anything; the 12 s one does.
  const s = pub();
  s.run('STUB.cvars.Sound_EnableAllSound = "0"; STUB.sounds = {}; NS.Transport.SelfTest()');
  s.slot(byokSlot());
  s.send('and the forge?');
  const k2 = keyed(s)[0];
  s.advance(6);
  assert.equal(s.bool(`NS.R.missed[${JSON.stringify(k2)}]`), false, 'the 5 s load proves nothing');
  s.advance(7);
  assert.equal(s.bool(`NS.R.missed[${JSON.stringify(k2)}]`), true, 'the 12 s load does');
  assert.equal(s.evaluate('NS.Transport.StuckSend()'), null, '13 s on screen');
  s.advance(2.5);
  assert.ok(s.num('NS.Transport.StuckSend()') >= 15);
});

test('DR-07 (SY-11, SY-29): after a Reload that didn\'t deliver, a blind strip included: 15 s on screen after the new session\'s first slot load, the message didn\'t go through and the button is Discard, which drops it from the outbox and the strip', () => {
  let vm = pub();
  vm.send('where is the forge');
  wait(vm, 16);
  const key = keyed(vm)[0];
  assert.ok(key);
  // The player clicks Reload. Capture is still blind: the new hello is never answered.
  vm = reloadVM(vm, { extra: PUBLIC + ALPHA }).login();
  wait(vm, 20);
  hud(vm);
  assert.equal(vm.bool('NS.R.helloAnswered'), false, 'blind: the hello is never read');
  assert.equal(vm.evaluate('NS.Transport.StuckSend()'), null, 'a carried record is judged by the Reload, not stuck again');
  assert.equal(vm.evaluate('NS.Transport.Undelivered()'), null, 'no slot load yet: nothing judged');
  // The session's first slot load (the app rang, or its live check): no ack for the key.
  apply(vm, byokSlot());
  wait(vm, 14);
  assert.equal(vm.evaluate('NS.Transport.Undelivered()'), null, '14 s on screen after the load');
  wait(vm, 1.5);
  assert.deepEqual(vm.list('NS.Transport.Undelivered()'), [key]);
  hud(vm);
  assert.deepEqual([vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text'), vm.evaluate('NS.HUD.h.stopBtn.text')], ['Sending…', 'Didn\'t go through', 'Discard']);
  assert.deepEqual(vm.json('NS.HUD.h.stopBtn.tip'), { title: 'Discard', text: 'Drops the message that didn\'t go through. Nothing is sent.' });
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].who.text'), 'You · didn\'t go through');
  assert.equal(vm.evaluate('NS.UI.StatusText()'), '|cffffd100Your message didn\'t go through.|r');
  assert.equal(vm.evaluate('NS.UI.ui.work.text.text'), 'Didn\'t go through');
  assert.equal(vm.evaluate('NS.UI.ui.work.stop.text'), 'Discard');
  // The small bar (HUD off, window closed): the banner under it says it, with Discard.
  vm.run('NS.UI.Toggle(false)'); vm.slash('hud off'); vm.run('NS.Refresh("all")');
  assert.equal(vm.evaluate('NQABanner.shown'), 'true');
  assert.equal(vm.evaluate('NQABanner.text.text'), 'Your message didn\'t go through. Click Discard, then send it again.');
  assert.equal(vm.evaluate('NQABanner.reload.text'), 'Discard');
  // Discard (the banner's, here): the outbox, the strip and the send let go of it.
  vm.advance(1);
  click(vm, 'NQABanner.reload');
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  assert.deepEqual(keyed(vm), []);
  assert.equal(vm.evaluate('next(NS.R.out)'), null);
  assert.ok(!stripRecs(vm).some(r => r.key === key), 'the strip stops carrying it');
  assert.equal(vm.evaluate('#NS.Chats.Active().pending'), '0');
  assert.equal(vm.evaluate('NS.UI.ui.bubbles[1].who.text'), 'You · not sent');
  assert.equal(vm.evaluate('NQABanner.shown'), 'false');
  assert.equal(vm.evaluate('STUB.reloaded'), 'false');
  // And after the next /reload it's gone for good.
  const again = reloadVM(vm, { extra: PUBLIC }).login();
  assert.deepEqual(keyed(again), []);
});

test('DR-07: a Reload that delivered: the ack comes with the new session\'s first load, and nothing more is said; the HUD\'s own Discard works too', () => {
  let vm = pub();
  vm.send('where is the forge');
  wait(vm, 16);
  const key = keyed(vm)[0];
  vm = reloadVM(vm, { extra: PUBLIC + ALPHA }).login();
  apply(vm, byokSlot().replace('acked = {}', `acked = { ${JSON.stringify(key)} }`));
  wait(vm, 20);
  assert.equal(vm.evaluate('NS.Transport.Undelivered()'), null);
  assert.deepEqual(keyed(vm), []);
  // Refused: the HUD's row button discards.
  let r = pub();
  r.send('where is the forge');
  wait(r, 16);
  r = reloadVM(r, { extra: PUBLIC + ALPHA }).login();
  apply(r, byokSlot());
  wait(r, 16);
  hud(r);
  assert.equal(r.evaluate('NS.HUD.h.stopBtn.text'), 'Discard');
  r.advance(1);
  click(r, 'NS.HUD.h.stopBtn');
  hud(r);
  assert.deepEqual(keyed(r), []);
  assert.notEqual(r.evaluate('NS.HUD.h.view.mode'), 'working');
});

test('DR-07: the HUD\'s bar has the same one action beside its line; the banner stays away while the HUD shows the button, and comes for the window and the small bar', () => {
  const vm = hud(pub());
  vm.send('where is the forge');
  wait(vm, 16);
  vm.run('NQADB.settings.hudMin = true; NS.HUD.Render()');
  assert.equal(vm.evaluate('NQAHUDBar.status.text'), 'Not read yet');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.shown'), 'true');
  assert.equal(vm.evaluate('NQAHUDBar.okBtn.text'), 'Reload');
  vm.run('NS.UI.RenderBanner()');
  assert.equal(vm.evaluate('NQABanner and NQABanner.shown'), 'false', 'the bar has the button: no second one');
  vm.advance(1);
  vm.run('local b = NQAHUDBar.okBtn; b.scripts.OnClick(b)');
  assert.equal(vm.evaluate('STUB.reloaded'), 'true');
  // The window open on another chat: the banner above it.
  vm.run('STUB.reloaded = false; NQADB.settings.hudMin = false; NS.UI.Toggle(true); NS.Chats.New("Other"); NS.Refresh("all")');
  assert.equal(vm.evaluate('NQABanner.shown'), 'true');
  // In combat the banner hides, as every banner does.
  vm.run('STUB.combat = true; NS.R.inCombat = true; NS.UI.RenderBanner()');
  assert.equal(vm.evaluate('NQABanner.shown'), 'false');
});

test('DR-07: a published cause, once it has held 8 s on screen, is named in the stuck line (its one line), and the action stays Reload; Windows words name the corner, a Mac\'s don\'t', () => {
  for (const mac of [true, false]) {
    const vm = hud(pub({ extra: mac ? '' : WINDOWS }));
    apply(vm, cap('no_signal'));
    vm.send('where is the forge');
    wait(vm, 16);
    hud(vm);
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'NeverQuestAlone can\'t see the game');
    assert.equal(vm.evaluate('NS.HUD.h.stopBtn.text'), 'Reload');
    assert.equal(vm.evaluate('NS.HUD.h.view.detail'), 'NeverQuestAlone can\'t see the game. Click Reload to send your message.');
    vm.run('NS.UI.Toggle(true); NS.Chats.New("Other"); NS.Refresh("all")');
    assert.equal(vm.evaluate('NQABanner.text.text'), 'NeverQuestAlone can\'t see the game. Click Reload to send your message.');
    // Idle again (the message acked by the Reload's write): the warn line names the fix per system.
    vm.run('NS.UI.Toggle(false); for k in pairs(NS.R.out) do NS.Transport.Acked(k, "slot") end');
    vm.run('for _, c in ipairs(NQADB.chats) do c.pending = {} end');
    hud(vm);
    assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'warn');
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), mac ? 'See why in the NeverQuestAlone app.' : 'Keep the top of WoW\'s window on screen.');
  }
});

// ---------------------------------------------------------------- DR-08

test('DR-08 (SY-12): the hello says its mode: pixel on the strip, stream and reload in the outbox', () => {
  const px = newVM({ extra: PUBLIC }).login();
  px.advance(3.1);
  assert.equal(stripRecs(px).find(r => r.type === 'hello').args.mode, 'pixel');
  for (const [db, mode] of [['NQADB = { settings = { stream = true } }', 'stream'], ['NQADB = { settings = { mode = "reload" } }', 'reload']]) {
    const vm = newVM({ extra: PUBLIC, db }).login();
    vm.advance(3.1);
    assert.equal(vm.strip(), null);
    assert.equal(outboxRecs(vm).find(r => r.type === 'hello').args.mode, mode);
  }
});

test('DR-08 (SY-17b, H8b): a mode change draws a seen with mode= at once, on the strip (switching away, it stays its 5 s, then the strip goes) and in the outbox, both ways; no change, no seen', () => {
  const vm = pub();
  vm.advance(6);
  assert.equal(vm.strip(), null, 'nothing on the strip');
  vm.slash('stream on');
  let seen = stripRecs(vm).find(r => r.type === 'seen');
  assert.equal(seen?.args.mode, 'stream', 'the strip says it, for its last few seconds');
  assert.equal(outboxRecs(vm).find(r => r.type === 'seen')?.args.mode, 'stream', 'the outbox says it too');
  vm.advance(4);
  assert.ok(vm.strip(), 'still up at 4 s');
  vm.advance(1.5);
  assert.equal(vm.strip(), null, 'then the strip goes (stream mode draws nothing)');
  // A message in stream mode waits for a reload: its Reload isn't blindness (the bridge knows the mode).
  vm.send('where is the forge');
  assert.equal(vm.strip(), null);
  // Back to pixel: said on the strip (the way out again) and in the outbox, in case the strip is blind.
  vm.slash('stream off');
  seen = stripRecs(vm).find(r => r.type === 'seen');
  assert.equal(seen?.args.mode, 'pixel');
  assert.equal(outboxRecs(vm).filter(r => r.type === 'seen').length, 1, 'one seen of this session\'s in the outbox, the newest');
  assert.equal(outboxRecs(vm).find(r => r.type === 'seen').args.mode, 'pixel');
  // The same mode again: nothing new said.
  vm.advance(6);
  vm.run('NS.Transport.ModeChanged()');
  assert.ok(!stripRecs(vm).some(r => r.type === 'seen'));
  // /nqa mode reload says reload.
  vm.slash('mode reload');
  assert.equal(outboxRecs(vm).find(r => r.type === 'seen').args.mode, 'reload');
});

test('DR-08 (SY-14e, H15): while no_signal is published the addon draws a seen for 5 s every 60 s of visible time (none while hidden); never for blocked, no_permission or damaged; it stops on ok', () => {
  const vm = pub();
  apply(vm, cap('no_signal'));
  vm.advance(6);
  assert.equal(vm.strip(), null);
  vm.advance(52);
  assert.equal(vm.strip(), null, '58 s');
  vm.advance(2.5);
  const s = stripRecs(vm);
  assert.deepEqual(s.map(r => r.type), ['seen'], 'the probe at 60 s');
  assert.ok(s[0].args.cur !== undefined && s[0].args.slot !== undefined);
  vm.advance(5.5);
  assert.equal(vm.strip(), null, 'up for its 5 s');
  // Hidden (Alt+Z): the time doesn't count.
  vm.run('UIParent.shown = false');
  vm.advance(120);
  vm.run('UIParent.shown = true');
  assert.equal(vm.num('NS.R.probes'), 1);
  vm.advance(56);
  assert.equal(vm.num('NS.R.probes'), 2, 'the next after 60 s on screen');
  // ok: no more.
  apply(vm, cap('ok'));
  vm.advance(130);
  assert.equal(vm.num('NS.R.probes'), 2);
  for (const state of ['blocked', 'no_permission', 'damaged', 'unsupported', 'minimized']) {
    const o = pub();
    apply(o, cap(state));
    o.advance(130);
    assert.equal(o.evaluate('NS.R.probes'), null, `${state}: the helper's "cleared" ends it`);
  }
});

test('DR-08 (D-21, D-37): the strip ignores its parent\'s alpha; hidden by another addon, it\'s shown again within 2 s, still carrying the message', () => {
  const vm = pub();
  vm.send('where is the forge');
  assert.equal(vm.evaluate('NQAStrip.ignoresParentAlpha'), 'true');
  const key = keyed(vm)[0];
  vm.advance(3);
  vm.run('NQAStrip:Hide()');
  assert.equal(vm.strip(), null);
  vm.advance(2.1);
  assert.ok(stripRecs(vm).some(r => r.key === key), 'shown again');
});

// ---------------------------------------------------------------- DR-09

test('DR-09 (SY-20, SY-24): the warn line names a published cause only after 8 s on screen (a quick heal never shows); a key the addon doesn\'t know names none; unsupported has its own words and no Mac words on Windows', () => {
  for (const mac of [true, false]) {
    const vm = hud(pub({ extra: mac ? '' : WINDOWS }));
    apply(vm, cap('no_signal'));
    wait(vm, 5);
    apply(vm, cap('ok'));
    wait(vm, 20);
    hud(vm);
    assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', 'healed in 5 s: never shown');
    for (const key of ['minimized', 'unknown', 'sleepy']) {
      apply(vm, cap(key));
      wait(vm, 20);
      hud(vm);
      assert.equal(vm.evaluate('NS.HUD.h.view.mode'), 'idle', `${key}: no cause`);
      assert.equal(vm.evaluate('NS.UI.SetupRows().rows[3]'), 'Checking the app can see WoW…');
    }
    apply(vm, cap('unsupported'));
    wait(vm, 9);
    hud(vm);
    assert.equal(vm.evaluate('NS.HUD.h.status.text'), 'NeverQuestAlone can\'t read this screen');
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Type /nqa mode reload to use NeverQuestAlone with no screen reading.');
    assert.equal(vm.evaluate('NS.UI.SetupRows().rows[3]'), 'Type /nqa mode reload for this screen.');
    apply(vm, cap('no_permission'));
    wait(vm, 9);
    hud(vm);
    const words = [vm.evaluate('NS.HUD.h.status.text'), vm.evaluate('NS.HUD.h.sub.text')].join(' ');
    if (mac) assert.equal(words, 'macOS stopped screen reading Allow it on your Mac.');
    else assert.doesNotMatch(words, /Screen Recording|macOS|Mac/);
    apply(vm, cap('damaged'));
    wait(vm, 9);
    hud(vm);
    assert.equal(vm.evaluate('NS.HUD.h.sub.text'), 'Reinstall the app.');
  }
});

test('DR-09 (D-28): the setup row reads the published state and never latches: a hello seen earlier doesn\'t hold "The app can see WoW." while a message is stuck; no Screen Recording guess on a Mac', () => {
  const vm = hud(pub({ db: 'NQADB = { hudIntro = true }' }));
  assert.equal(vm.evaluate('NS.UI.SetupRows().rows[3]'), 'The app can see WoW.', 'the hello came off the strip');
  vm.send('hi');
  wait(vm, 16);
  assert.equal(vm.evaluate('NS.UI.SetupRows().rows[3]'), 'Checking the app can see WoW…', 'stuck: it can\'t see now');
  assert.equal(vm.evaluate('NS.UI.SetupRows().ok[3]'), 'false');
  // The app's own state wins once it says one, after 8 s on screen.
  apply(vm, cap('blocked'));
  wait(vm, 9);
  assert.equal(vm.evaluate('NS.UI.SetupRows().rows[3]'), 'Close what blocks screen reading.');
  // A fresh install on a Mac before the app says anything: checking, never "Allow Screen Recording".
  const fresh = newVM({ extra: PUBLIC, db: 'NQADB = nil' }).login();
  fresh.advance(3.1);
  apply(fresh, byokSlot());
  assert.equal(fresh.evaluate('NS.UI.SetupRows().rows[3]'), 'Checking the app can see WoW…');
});
