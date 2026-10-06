'use strict';
// The /nqa commands, condensed (the owner, 2026-09-27: "make the /nqa commands a
// better more condensed UX. The user really shouldn't have to use them often"):
// every common action is a click in the window, the HUD or Settings; /nqa help
// is the few lines a player might type, /nqa help all the rest; every old
// command and alias still works. Same VM as tests/nqa_addon_test.js: the
// real addon in fengari on the stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const { newVM, lstr } = require('./helpers/nqa-vm');

function ring(vm, bell = null) {
  if (!bell) bell = vm.pushBell = vm.pushBell === 'push_a' ? 'push_b' : 'push_a';
  vm.signal('ctl', `bell_${bell}`, false);
  vm.run('NS.Transport.Poll()');
  vm.signal('ctl', `bell_${bell}`, true);
  vm.run('NS.Transport.Poll()');
  return vm;
}
function slotLua({ push = 0, nonce = null } = {}) {
  return `{ v = 2, ts = "2026-09-25T18:04:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.3.0", push = ${push}, nonce = ${nonce ? `"${nonce}"` : 'nil'}, acked = {} }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {}, records = {} }`;
}
function confirmHello(vm) {
  vm.advance(3.1);
  vm.slot(slotLua({ nonce: vm.evaluate('NS.R.nonce'), push: 0 }));
  ring(vm);
  vm.run('STUB.onLoadAddOn = nil');
  vm.advance(0.3);
  return vm;
}
const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
const sentText = (vm, t) => vm.outboxWires().some(e => e.wire.endsWith('\x1f' + t) || e.wire.includes('\x1d' + t));
// A notice as the player reads it: the escapes the window shows as one | undone.
const shown = t => (t || '').replace(/\|\|/g, '\x00').replace(/\|c[0-9a-f]{8}|\|r/g, '').replace(/\x00/g, '|');
const menuItems = vm => vm.json('(function() local o = {} for _, b in ipairs(NQAPopupMenu.items) do if b.shown then o[#o + 1] = b.label.text end end return o end)()');
const menuTitle = vm => vm.evaluate('NQAPopupMenu.title.text');
// A control's tooltip: its title, then its lines.
const tipOf = (vm, lua) => {
  vm.run(`STUB.tip = {}; function GameTooltip:AddLine(t) table.insert(STUB.tip, t) end; ${lua}`);
  return [vm.evaluate('GameTooltip.text')].concat(vm.list('STUB.tip')).join('\n');
};
// A command's answer: a notice in the open window, else a line in the chat frame.
const answer = vm => (vm.evaluate('NQAFrame.shown') === 'true' ? notice(vm) : vm.chatLines().pop()) || '';
const pick = (vm, label) => vm.run(`for _, b in ipairs(NQAPopupMenu.items) do if b.shown and b.label.text == ${JSON.stringify(label)} then b.scripts.OnClick(b) end end`);

// Every command word and argument main took before this change (COMMAND_ARGS at
// 3fae333): each must still run as a command, not go to NeverQuestAlone as a message.
const OLD = [
  'help', 'diag', 'slots', 'probe', 'delete', 'stop', 'reload', 'copy', 'state', 'apicheck',
  'new', 'new Recap', 'rename', 'rename Recap', 'chat', 'chat 1', 'chats', 'chats 1', 'pin', 'pin 1', 'unpin', 'unpin 1',
  'echo', 'echo summary', 'echo full', 'echo short', 'echo off',
  'context', 'context on', 'context off', 'dnd', 'dnd combat on', 'dnd combat off', 'dnd instance on', 'dnd boss off',
  'map', 'map ore on', 'map herb off', 'map minimap', 'map filter all', 'map filter skill', 'map show x', 'map hide x', 'map nav', 'map nav route 2', 'map next', 'map prev', 'map stop',
  'stream', 'stream on', 'stream off', 'mode', 'mode reload', 'mode pixel', 'window reset',
  'companion', 'companion on', 'companion off', 'companion level on', 'companion route off', 'companion stale on', 'companion zone off', 'companion recap on',
  'think', 'think low', 'think medium', 'think high', 'think default',
  'ask next', 'ask target', 'ask item',
  'hud', 'hud on', 'hud off', 'hud reset', 'hud min', 'hud compass', 'hud full',
  'update', 'update install', 'text', 'text small', 'text medium', 'text large',
  'waypoint', 'waypoint on', 'waypoint off', 'tooltips', 'tooltips on', 'tooltips off', 'quips', 'quips on', 'quips off', 'roll', 'settings',
  'model', 'model gpt',
];
// The old roadmap's words (M2), which only ever answered "comes in a later version": words for NeverQuestAlone now.
const ROADMAP = ['steer go left', 'reset', 'agent', 'agent coder', 'main', 'main on', 'attach sponsor', 'detach', 'inbox', 'watch cron on', 'quiet', 'quiet 30', 'quiet off', 'more', 'rhook', 'rhook on'];

test('every old command and alias still runs as a command: nothing a player, a doc or the owner types stops working', () => {
  const vm = newVM().login();
  const isCmd = line => {
    const [, cmd, rest] = line.match(/^(\S+)\s*(.*)$/);
    return vm.evaluate(`NS.IsCommand(${lstr(cmd.toLowerCase())}, ${lstr(rest)})`);
  };
  const broken = OLD.filter(l => isCmd(l) !== 'true');
  assert.deepEqual(broken, [], 'no longer commands');
  assert.deepEqual(ROADMAP.filter(l => isCmd(l) === 'true'), [], 'the old roadmap\'s words go to NeverQuestAlone as messages');
  assert.deepEqual([vm.evaluate('SLASH_BONES1'), vm.evaluate('SLASH_BONES2'), vm.evaluate('SLASH_BONESREPLY1')], ['/nqa', '/bones', '/br'], 'the slash words: /nqa, and /bones as its silent alias');
});

test('/nqa alone still opens and closes the window (the thing a player wants), never a wall of text', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true');
  assert.equal(notice(vm), null, 'no text');
  vm.slash('');
  assert.equal(vm.evaluate('NQAFrame.shown'), 'false');
});

test('/nqa help: "Getting around" (the Welcome\'s lessons), then at most six lines, only what a player types; each "/command  Verb phrase" with no period; mode (no screen reading) listed', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('help');
  const raw = notice(vm);
  const help = shown(raw);
  // "Getting around" first: the setup block stands in main's Welcome's place, so its lessons live here (G3).
  const [around, list] = help.split('\n\n');
  assert.match(around, /^Getting around:\nClick Ask to ask anything, or click the portrait for all your chats\./);
  const lines = list.split('\n');
  // Each command in gold, as the game's own /help shows them; the words after it plain.
  assert.ok(raw.split('\n\n')[1].split('\n').every(l => l.startsWith('|cffffd100/')), raw);
  assert.ok(lines.length <= 6, `${lines.length} lines:\n${help}`);
  for (const l of lines) {
    assert.match(l, /^\/\S.*?\S  [A-Z][a-z]+ /, `"/command  Verb …": ${l}`);
    assert.doesNotMatch(l, /\.$/, `no period: ${l}`);
  }
  for (const want of [/^\/nqa  Open or close the window$/m, /^\/nqa <message>  Ask anything$/m, /^\/br <message>  Reply to your latest notification$/m,
    /^\/nqa settings  Open Settings to turn off Screen Reading$/m, /^\/nqa mode reload  Hold messages and replies for a reload$/m, /^\/nqa help all  Show every command$/m]) {
    assert.match(help, want);
  }
  // No screen reading: the Settings switch first (the orchestrator's ruling), then the stricter command.
  assert.ok(help.indexOf('Screen Reading') < help.indexOf('/nqa mode reload'), help);
  assert.equal(vm.evaluate('NQAFrame.shown'), 'true', 'shown in the window, as every command answer');
  // /nqa ? is the same; the window's box takes /help and /? too.
  vm.slash('?');
  assert.equal(shown(notice(vm)), help);
  vm.run(`NS.UI.ui.input:SetText("/?"); NS.UI.SendFromInput()`);
  assert.equal(shown(notice(vm)), help);
});

test('/nqa help all: every command there is, grouped by the lines the public build swaps; hidden aliases stay out', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('help all');
  const all = shown(notice(vm));
  // Every command word there is.
  const words = vm.list('(function() local o = {} for k in pairs(NS.COMMAND_ARGS) do o[#o + 1] = k end table.sort(o) return o end)()');
  assert.ok(words.length >= 30, `${words.length} command words`);
  const hidden = new Set(['chats', 'options', 'config', '?']);
  // Left out, though they still answer: /nqa update (the app keeps the addon up to date) and the
  // diagnostics but /nqa diag.
  const leftOut = new Set(['update', 'slots', 'probe', 'state', 'apicheck', 'stream']); // stream: /nqa reading's other way round
  const missing = words.filter(w => !hidden.has(w) && !leftOut.has(w) && !new RegExp(`/nqa (\\w+\\|)*${w}\\b`).test(all));
  assert.deepEqual(missing, [], 'every command word is in /nqa help all');
  for (const w of hidden) assert.doesNotMatch(all, new RegExp(`/nqa ${w.replace('?', '\\?')}(\\s|$)`), `${w} stays a hidden alias`);
  for (const w of leftOut) assert.doesNotMatch(all, new RegExp(`/nqa (\\w+\\|)*${w}\\b`), `${w} is left out`);
  // The lines found by their start.
  for (const start of ['/nqa  ', '/nqa delete', '/nqa companion', '/nqa think', '/nqa reading', '/nqa mode', '/nqa tooltips', '/nqa settings', 'Keys', '/nqa diag', '/nqa text', '/nqa usage', '/nqa cost', '/nqa setup', '/nqa model']) {
    assert.ok(all.split('\n').some(l => l.startsWith(start)), `a line starts "${start}"`);
  }
  assert.match(all, /^\/nqa hud full\|bar\|compass  /m, 'the HUD\'s three forms by their names');
  assert.match(all, /^\/nqa hud on\|off  /m);
  assert.match(all, /^\/nqa hud reset  /m);
  // C-125: the waypoint line in its Settings row's words ("Next Stop as a Waypoint"): only the next stop gets one.
  const waypoint = all.split('\n').find(l => l.startsWith('/nqa waypoint '));
  assert.equal(waypoint, '/nqa waypoint on|off  Show the next stop as a waypoint');
  assert.ok(waypoint.toLowerCase().endsWith(vm.evaluate('NS.Settings.LABELS.waypoint').toLowerCase()), 'the row\'s own words');
  assert.match(all, /^Keys: click the window's portrait, then Bind Keys/m, 'keys are bound from a click');
  // Still messages: help followed by anything but "all".
  vm.slash('help me with this macro');
  assert.ok(sentText(vm, 'help me with this macro'));
  vm.slash('help all of my alts');
  assert.ok(sentText(vm, 'help all of my alts'));
});

test('help in the notice keeps the gold commands a column at any window width (text metrics on): one line each where every line fits, else each command on a line of its own and its words under it', () => {
  // The chat font (14 at Medium), as tests/render_ui.js sets it up.
  const vm = confirmHello(newVM({ extra: 'STUB.metrics = true; function ChatFontNormal:GetFont() return "Fonts\\\\ARIALN.TTF", 14, "" end' }).login());
  vm.slash('');
  // The notice's text width: the window's width less the transcript's 62 and the notice's 44.
  const body = w => w - 62 - 44;
  const at = w => vm.run(`NS.UI.ui.scroll.width = ${w - 62}`);
  const width = l => vm.num(`(function() local fs = NS.UI.ui.notice.body; local was = fs.text; fs:SetText(${JSON.stringify(l)}); local w = fs:GetStringWidth(); fs:SetText(was); return w end)()`);
  const drawn = () => vm.evaluate('NS.UI.ui.notice.body.text').split('\n');
  for (const which of ['help', 'help all']) {
    // At the old default, 560 wide: every "/command  what it does" on one line, as written.
    at(560);
    vm.slash(which);
    const raw = drawn().filter(l => l.startsWith('|cffffd100/'));
    assert.ok(raw.length > 3, which);
    assert.deepEqual(raw.filter(l => !/^\|cffffd100\/(?:[^|]|\|\|)*\|r  \S/.test(l)), [], `${which}: one line each`);
    assert.deepEqual(raw.filter(l => width(l) > body(560)).map(shown), [], `${which}: each fits 560's notice`);
    // At today's default (420) and the narrowest (400): each command on a line of its own, its words under it.
    for (const w of [420, 400]) {
      at(w);
      vm.slash(which);
      const lines = drawn();
      const commands = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith('|cffffd100/'));
      assert.equal(commands.length, raw.length, `${which} at ${w}: every command`);
      for (const [l, i] of commands) {
        assert.match(l, /^\|cffffd100\/(?:[^|]|\|\|)*\|r$/, `${which} at ${w}: a command alone on its line`);
        assert.ok(width(l) <= body(w), `${which} at ${w}: ${shown(l)}`);
        assert.match(lines[i + 1], /^    \S/, `${which} at ${w}: its words under it, indented: ${lines[i + 1]}`);
      }
    }
    assert.equal(vm.num('NS.UI.ui.notice.body.fontSize'), 14, 'measured at the chat font\'s size');
  }
  // What the notice copies is the list as written.
  assert.ok(!vm.evaluate('NS.UI.ui.notice.text').includes('\n    '));
  // At the narrowest and the largest text (Large, Extra Large: 17 and 20 pt) the words under a
  // command wrap here, so every one of their lines keeps the indent and fits.
  for (const size of ['large', 'xlarge']) {
    vm.run(`NQADB.settings.textSize = "${size}"`);
    at(400);
    for (const which of ['help', 'help all']) {
      vm.slash(which);
      const lines = drawn();
      // The list's own lines that aren't commands (the keys line, the / line) stay as written.
      const plain = new Set(notice(vm).split('\n').filter(l => !l.startsWith('|cffffd100/')));
      const first = lines.findIndex(l => l.startsWith('|cffffd100/'));
      assert.ok(first >= 0, `${which} at ${size}`);
      for (const l of lines.slice(first)) {
        if (l.startsWith('|cffffd100/') || plain.has(l)) continue;
        assert.match(l, /^    \S/, `${which} at ${size}: under a command, indented: ${l}`);
        assert.ok(width(l) <= body(400), `${which} at ${size}: ${l}`);
      }
    }
  }
  // Every word measures as itself, "size" too (UI critic C-10: the cache once kept the text size
  // under that key, so a line ending in "size" came out too wide and the game wrapped it unindented).
  vm.run('NQADB.settings.textSize = "xlarge"');
  at(400);
  vm.run('NS.Chats.Notice(NS.Chats.Active(), "|cffffd100/nqa x|r  Set the a a a a a a a size"); NS.Refresh("all")');
  const lines = drawn();
  assert.equal(lines[0], '|cffffd100/nqa x|r');
  assert.ok(lines.length >= 3, `wrapped: ${lines.join(' / ')}`);
  for (const l of lines.slice(1)) {
    assert.match(l, /^    \S/, l);
    assert.ok(width(l) <= body(400), `${Math.round(width(l))}: ${l}`);
  }
});

test('aliases: /nqa options and /nqa config open Settings; /nqa hud bar is the HUD\'s bar; the HUD answer prints its words, not a colour code', () => {
  const vm = confirmHello(newVM().login());
  for (const w of ['options', 'config']) {
    vm.run('if NQASettings then NQASettings:Hide() end');
    vm.slash(w);
    assert.equal(vm.evaluate('NQASettings.shown'), 'true', w);
  }
  vm.slash('options for my warrior');
  assert.ok(sentText(vm, 'options for my warrior'), 'with more words, a message');
  vm.slash('hud bar');
  assert.deepEqual([vm.evaluate('NQADB.settings.hudMin'), vm.evaluate('NQADB.settings.hudCompass')], ['true', 'false']);
  vm.slash('hud full');
  vm.slash('hud');
  const said = (vm.chatLines().pop() || '').replace(/^\|c[0-9a-f]{8}\[NeverQuestAlone\]\|r /, '');
  // || shows as one |; a lone | followed by r would be a colour reset and eat the letter.
  assert.doesNotMatch(said.replace(/\|\|/g, ''), /\|[a-zA-Z]/, `no stray escape: ${said}`);
  assert.match(said, /^The HUD is on\. Change it with \/nqa hud on, off, full, bar, compass or reset\.$/, said);
});

test('the window\'s portrait: a click opens its menu (Open Settings, Bind Keys), as the HUD\'s portrait does; a drag still moves the window', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('');
  const p = 'local p = NS.UI.ui.portraitBtn;';
  assert.equal(vm.evaluate('NS.UI.ui.portraitBtn ~= nil'), 'true', 'a button over the portrait');
  assert.ok(vm.num('NS.UI.ui.portraitBtn:GetFrameLevel()') >= 510, 'over PortraitFrameTemplate\'s portrait (level 510+)');
  vm.run(`${p} p.scripts.OnClick(p, "LeftButton")`);
  assert.deepEqual(menuItems(vm), ['Open Settings', 'Bind Keys']);
  assert.equal(menuTitle(vm), 'NeverQuestAlone');
  pick(vm, 'Open Settings');
  assert.equal(vm.evaluate('NQASettings.shown'), 'true');
  vm.run('NQASettings:Hide()');
  vm.run(`${p} p.scripts.OnClick(p, "RightButton")`);
  assert.deepEqual(menuItems(vm), ['Open Settings', 'Bind Keys'], 'right-click, the same');
  pick(vm, 'Bind Keys');
  assert.ok(vm.chatLines().some(l => l.includes('Options > Keybindings > NeverQuestAlone')), 'no Settings API here: it says where (the keys\' own section, C-127)');
  // Its tooltip: NeverQuestAlone, and what a click and a drag do.
  const tip = tipOf(vm, `${p} p.scripts.OnEnter(p)`);
  assert.match(tip, /^NeverQuestAlone\n/, tip);
  assert.match(tip, /Click for Settings and key bindings/, tip);
  assert.equal(vm.evaluate('NS.UI.ui.portraitBtn.glow.layer'), 'HIGHLIGHT', 'the round glow a bag\'s portrait shows under the pointer');
  assert.match(tip, /Drag to move the window/, tip);
  vm.run(`${p} p.scripts.OnLeave(p)`);
  // A drag from the portrait moves the window, and the click that ends it opens no menu.
  vm.run('NQAPopupMenu:Hide()');
  vm.run(`${p} p.scripts.OnDragStart(p); p.scripts.OnDragStop(p)`);
  vm.run(`${p} p.scripts.OnClick(p, "LeftButton")`);
  assert.equal(vm.evaluate('NQAPopupMenu.shown'), 'false', 'a drag is not a click');
});

test('the HUD\'s menu says Open Settings, as the window\'s does, and has Ask What\'s Next (a click, no key needed)', () => {
  const vm = confirmHello(newVM().login());
  vm.run('local p = NS.HUD.h.portraitBtn; p.scripts.OnClick(p, "RightButton")');
  const items = menuItems(vm);
  assert.equal(items[items.length - 1], 'Open Settings');
  assert.deepEqual(items.slice(0, 2), ['Open Your Chats', "Ask What's Next"]);
  pick(vm, 'Open Settings');
  assert.equal(vm.evaluate('NQASettings.shown'), 'true');
  vm.run('local p = NS.HUD.h.portraitBtn; p.scripts.OnClick(p, "RightButton")');
  vm.run('STUB.asked = nil; local q = NS.QuickAsk; NS.QuickAsk = function(kind) STUB.asked = kind end');
  pick(vm, "Ask What's Next");
  assert.equal(vm.evaluate('STUB.asked'), 'next');
  // With a target: Ask About Your Target, after it.
  vm.run('UnitExists = function(u) return u == "target" end; local p = NS.HUD.h.portraitBtn; p.scripts.OnClick(p, "RightButton")');
  assert.deepEqual(menuItems(vm).slice(0, 3), ['Open Your Chats', "Ask What's Next", 'Ask About Your Target']);
  pick(vm, 'Ask About Your Target');
  assert.equal(vm.evaluate('STUB.asked'), 'target');
});

test('Settings: Screen Reading off is stream mode (nothing drawn, messages wait for a reload, replies still come in); the status line and answers name the switch', () => {
  const vm = confirmHello(newVM().login());
  vm.slash('settings');
  const idx = vm.num('(function() for i, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == "Screen Reading" then return i end end end)()');
  assert.ok(idx > 0, 'a Screen Reading switch');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][1]`), 'What NeverQuestAlone Knows');
  assert.match(vm.evaluate(`NS.Settings.SWITCHES[${idx - 1}][2]`), /^Check-Ins$/, 'right after the Check-Ins row (the fallback window lists them in order)');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][6]`), 'true', 'on by default');
  // The tooltip is a function (its line changes while the app's switch is off).
  const tip = vm.evaluate(`(function() local t = NS.Settings.SWITCHES[${idx}][5]; if type(t) == 'function' then return t() end return t end)()`);
  assert.match(tip, /nothing is drawn/, 'what stops');
  assert.match(tip, /your messages wait for a reload/, 'what stops');
  assert.match(tip, /replies still come in/, 'what still works');
  const cb = `local cb = NS.Settings.page.checks[${idx}];`;
  const checked = () => vm.evaluate(`NS.Settings.page.checks[${idx}]:GetChecked()`);
  const T = () => [vm.evaluate('NQADB.settings.mode'), vm.evaluate('NQADB.settings.stream'), vm.evaluate('NS.Transport.StripOut()'), vm.evaluate('NS.Transport.SlotsIn()')];
  assert.equal(checked(), 'true');
  assert.deepEqual(T(), ['pixel', 'false', 'true', 'true']);
  // Off: stream mode. No strip; replies still load.
  vm.run(`${cb} cb.GetChecked = function() return false end; cb.scripts.OnClick(cb)`);
  assert.deepEqual(T(), ['pixel', 'true', 'false', 'true'], 'off: nothing drawn, replies still come in');
  vm.slash('');
  const [status, statusTip] = [vm.evaluate('NS.UI.ui.status.text') || '', vm.evaluate('NS.UI.ui.statusHit.shown')];
  assert.equal(status, 'No screen reading: your messages wait for a reload, and replies still come in.');
  assert.equal(statusTip, 'true', 'the line is a button while it has more to say (C-115)');
  const hover = tipOf(vm, 'local h = NS.UI.ui.statusHit; h.scripts.OnEnter(h)');
  assert.match(hover, /^Details\n.*Click to see all of it/s, hover);
  vm.run('NS.R.notices[NQADB.activeChat] = nil; local h = NS.UI.ui.statusHit; h.scripts.OnClick(h, "LeftButton")');
  assert.match(vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text') || '', /Screen Reading, in Settings, turns it back on/, 'a click gives the words');
  // /nqa mode and /nqa stream answer in the same words.
  vm.slash('stream');
  assert.match(answer(vm), /Screen reading is off: nothing is drawn on your screen, so your messages wait for a reload, and replies still come in\. Screen Reading, in Settings, turns it back on\./);
  // On again: the strip, and stream mode ends.
  vm.run(`${cb} cb.GetChecked = function() return true end; cb.scripts.OnClick(cb)`);
  assert.deepEqual(T(), ['pixel', 'false', 'true', 'true']);
  assert.equal(vm.evaluate('NS.UI.ui.statusHit.shown'), 'false', 'no button when the line has nothing more to say');
  // /nqa mode reload is stricter (replies wait too): the switch reads off, and on ends it.
  vm.slash('mode reload');
  assert.match(answer(vm), /Screen reading is off: nothing is drawn on your screen, and your messages and replies wait for a reload\./);
  assert.deepEqual(T(), ['reload', 'false', 'false', 'false']);
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'false', 'the switch reads off');
  assert.equal(vm.evaluate('NS.UI.StatusText()'), 'No screen reading: your messages and replies wait for a reload.');
  vm.run(`${cb} cb.GetChecked = function() return true end; cb.scripts.OnClick(cb)`);
  assert.deepEqual(T(), ['pixel', 'false', 'true', 'true'], 'on ends reload mode too');
  vm.slash('stream on');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'false', '/nqa stream on is the switch off');
  vm.slash('mode pixel');
  vm.slash('stream off');
  assert.match(answer(vm), /^Screen reading is on: only the top of WoW's window is read/);
  // /nqa reading off|on: the same switch in its own word (the app's command).
  vm.slash('reading off');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'false', '/nqa reading off is the switch off');
  assert.match(answer(vm), /^Screen reading is off: nothing is drawn on your screen, so your messages wait for a reload/);
  vm.slash('reading on');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'true', '/nqa reading on is the switch on');
  // From /nqa mode reload too, as the switch (CL-player-32): the app gives this one command.
  vm.slash('mode reload');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'false');
  vm.slash('reading on');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'true', '/nqa reading on ends reload mode');
  assert.match(answer(vm), /^Screen reading is on/);
});

// The desktop app's Screen Reading switch (its Your data page; the orchestrator's trust plan, 2026-10-03):
// off there wins over this addon's own, which is kept; the slot says it (bridge.reading, cap reading).
test('Screen Reading off in the NeverQuestAlone app: nothing is drawn, the player\'s own switch and mode word are kept, and every line names the app; on again draws again', () => {
  const vm = confirmHello(newVM().login());
  const slot = reading => `NS.Transport.HandleSlotData({ v = NS.PROTOCOL, token = NQADB.token, now = time(), bridge = { caps = { "reading" }, reading = "${reading}" }, records = {} }, "slot")`;
  const T = () => [vm.evaluate('NQADB.settings.mode'), vm.evaluate('NQADB.settings.stream'), vm.evaluate('NS.Transport.StripOut()'), vm.evaluate('NS.Transport.ModeWord()'), vm.evaluate('NS.Transport.DesktopReadingOff()')];
  vm.run(slot('on'));
  assert.deepEqual(T(), ['pixel', 'false', 'true', 'pixel', 'false'], 'on in the app: as before');
  vm.run(slot('off'));
  assert.deepEqual(T(), ['pixel', 'false', 'false', 'pixel', 'true'], 'off in the app: nothing drawn; the mode word stays this addon\'s own (the app knows its switch, SY-02)');
  // Every line names where it's off: the Settings tooltip, the status line, /nqa reading, diag.
  vm.slash('settings');
  const idx = vm.num('(function() for i, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == "Screen Reading" then return i end end end)()');
  assert.equal(vm.evaluate(`NS.Settings.SWITCHES[${idx}][3]()`), 'true', 'the box keeps the player\'s own choice, as Check-Ins does');
  assert.match(vm.evaluate(`NS.Settings.SWITCHES[${idx}][5]()`), /It's off on the NeverQuestAlone app's Your data page right now, so your messages wait for a reload; turn it back on there too\.$/);
  assert.equal(vm.evaluate('NS.UI.StatusText()'), 'No screen reading: your messages wait for a reload, and replies still come in.');
  vm.slash('reading');
  assert.match(answer(vm), /Screen reading is off in the NeverQuestAlone app: nothing is drawn on your screen, so your messages wait for a reload, and replies still come in\. Screen reading, on the app's Your data page, turns it back on\.$/);
  // Off here too: both switches have to go back on, and every line says so (SRS-W-01).
  vm.slash('reading off');
  assert.match(answer(vm), /Screen reading is off here and in the NeverQuestAlone app: .* Turn it back on in Settings and on the app's Your data page\.$/);
  assert.equal(vm.evaluate('select(2, NS.UI.StatusText()).note'), "Turn it back on in Settings and on the NeverQuestAlone app's Your data page.");
  vm.slash('reading on');
  // Off here while the app's own switch was off: its helper was stopped, nobody heard, so nothing waits
  // for a reload (SY-17); the app's on again says this addon's mode afresh.
  assert.equal(vm.evaluate('NS.R.toldOff'), null);
  assert.equal(vm.evaluate('NS.Transport.ModeLabel()'), 'stream (off in the NeverQuestAlone app)');
  // On again in the app: drawn again, said as pixel.
  vm.run(slot('on'));
  assert.deepEqual(T(), ['pixel', 'false', 'true', 'pixel', 'false'], 'on again: drawn again');
  // An app from before the switch (no cap): only this addon's switch decides.
  vm.run(`NS.Transport.HandleSlotData({ v = NS.PROTOCOL, token = NQADB.token, now = time(), bridge = { reading = "off" }, records = {} }, "slot")`);
  assert.equal(vm.evaluate('NS.Transport.DesktopReadingOff()'), 'false', 'no cap, no say');
  assert.equal(vm.evaluate('NS.Transport.StripOut()'), 'true');
});

// SY-01: the app's switch, both ways, reaches the game by the push bell alone (no /reload, no idle
// check): off, the strip goes but the bell is still heard; on again, the next ring draws again.
test('Screen Reading in the NeverQuestAlone app reaches the game by the push bell, off and on again', () => {
  const vm = confirmHello(newVM().login());
  const nonce = vm.evaluate('NS.R.nonce');
  const lua = (reading, push) => `{ v = 2, ts = "2026-10-03T20:00:00Z", now = time(), token = NQADB.token, bridge = { ver = "1.4.2", push = ${push}, nonce = "${nonce}", acked = {}, caps = { "reading" }, reading = "${reading}" }, gw = { state = "ready", ver = "2026.9.6", proto = 4, queued = 0 }, agents = { { id = "main", name = "NeverQuestAlone" } }, chats = {}, records = {} }`;
  const at = () => [vm.evaluate('NS.Transport.DesktopReadingOff()'), vm.evaluate('NS.Transport.StripOut()')];
  vm.advance(1.6); // a push ring loads at most one slot per 1.5 s
  vm.slot(lua('off', 1));
  ring(vm);
  assert.deepEqual(at(), ['true', 'false'], 'off: heard at the ring');
  vm.advance(1.6);
  vm.slot(lua('on', 2));
  ring(vm);
  assert.deepEqual(at(), ['false', 'true'], 'on again: heard at the next ring, the strip back');
  // SY-17: this addon's own off while the app read nothing (its switch off): not "told"; when the app is
  // on again, the mode is said again for its new helper (a mode seen with mode stream).
  vm.advance(1.6);
  vm.slot(lua('off', 3));
  ring(vm);
  vm.slash('reading off');
  assert.equal(vm.evaluate('NS.R.toldOff'), null, 'the app wasn\'t reading: nobody heard');
  vm.advance(1.6);
  vm.slot(lua('on', 4));
  ring(vm);
  assert.equal(vm.evaluate('NS.R.saidMode'), 'stream', 'said again for the app\'s new helper');
  assert.equal(vm.evaluate('NS.R.toldOff'), 'true', 'now told');
  vm.slash('reading on');
  vm.run('NS.R.toldOff = nil'); // the reload that tells the app
  // This addon's own off told the app (SF-01: it stops reading); back on in game, nothing is drawn until
  // the reload that tells the app, and the lines say so (SY-13).
  vm.slash('reading off');
  assert.equal(vm.evaluate('NS.R.toldOff'), 'true', 'the mode seen said stream');
  vm.slash('reading on');
  assert.equal(vm.evaluate('NS.Transport.StripOut()'), 'false', 'nothing drawn for a stopped helper');
  assert.match(answer(vm), /Screen reading starts at your next reload: until then, your messages wait for it\.$/);
  assert.equal(vm.evaluate('NS.UI.StatusText()'), 'Screen reading starts at your next reload: until then, your messages wait for it.');
});

test('status lines fit the window\'s status line, two lines at most, at its default width (text metrics on), each fix in the line or its tooltip', () => {
  const METRICS = 'STUB.metrics = true';
  const vm = confirmHello(newVM({ extra: METRICS }).login());
  vm.slash('');
  // The status line at the window's default width (420: the header's words from 64 in, 14 short of
  // the right edge), 10 pt; two lines when one doesn't hold it, the panes a line lower meanwhile.
  const WIDTH = 420 - 64 - 14;
  assert.equal(vm.num('NS.UI.ui.frame:GetWidth()'), 420);
  const cases = {
    stream: 'NQADB.settings.stream = true',
    reload: 'NQADB.settings.stream = false; NQADB.settings.mode = "reload"',
  };
  const lines = [];
  for (const [name, lua] of Object.entries(cases)) {
    vm.run(lua);
    lines.push([name, vm.evaluate('NS.UI.StatusText()')]);
  }
  vm.run('NQADB.settings.mode = "pixel"');
  // A message stuck on the strip (DR-07): on screen, unread, well past its 15 s.
  vm.run('NS.R.out = { k = true }; NS.R.sentAt = { k = GetTime() - 3599 }; NS.R.vis = { k = 3599 }; NS.Transport.OutboxDepth = function() return 1 end; NS.Transport.BridgeAlive = function() return true end; NS.Transport.SlotOnly = function() return false end');
  lines.push(['unseen', vm.evaluate('NS.UI.StatusText()')]);
  assert.equal(lines[2][1], '|cffffd100NeverQuestAlone hasn\'t read your message yet.|r', 'what\'s wrong, in the line itself (the banner has its Reload)');
  // C-115: a button only while the line has more to say: this one says it all.
  vm.run('NS.UI.RenderStatus()');
  assert.equal(vm.evaluate('NS.UI.ui.statusHit.kind'), 'Button');
  assert.equal(vm.evaluate('NS.UI.ui.statusHit.shown'), 'false');
  assert.equal(vm.json('select(2, NS.UI.StatusText())'), null, 'no tooltip to point at');
  assert.ok(vm.evaluate('(function() for _, t in ipairs(NS.UI.ui.statusHit.textures) do if t.layer == "HIGHLIGHT" then return "lit" end end end)()') === 'lit', 'it lights under the pointer');
  for (const [name, text] of lines) {
    const h = vm.num(`(function() local fs = NS.UI.ui.status; fs:SetWidth(${WIDTH}); fs:SetText(${JSON.stringify(text)}); return fs:GetStringHeight() end)()`);
    assert.ok(h <= 2 * 12, `${name}: ${h / 12} lines of ${WIDTH} units: ${text}`);
  }
  // The working line (one line, 12 pt) at the window's narrowest: 220 units (MIN_W 400 less the
  // transcript's 62 and the working line's 118, its Stop's room).
  const chat = 'NS.Chats.Active()';
  for (const combat of [false, true]) {
    const line = vm.evaluate(`(function() local P, T, C = NS.Chats.Progress, NS.Transport.StripOut, NS.InCombat
      NS.Chats.Progress = function() return { acked = false } end; NS.Transport.StripOut = function() return false end; NS.InCombat = function() return ${combat} end
      local t = NS.UI.WorkingText(${chat}); NS.Chats.Progress, NS.Transport.StripOut, NS.InCombat = P, T, C; return t end)()`);
    // One wording in and out of a fight (UXC-UI-15): it names no button, so the Reload the banner hides in combat is never pointed at.
    assert.equal(line, 'Waiting for a reload to go out');
    assert.doesNotMatch(line, /click Reload/i);
    const w = vm.num(`(function() local fs = NS.UI.ui.work.text; fs:SetText(${JSON.stringify(line)}); return fs:GetStringWidth() end)()`);
    assert.ok(w <= 400 - 62 - 118, `${Math.round(w)} units: ${line}`);
  }
});

test('a status line two lines long moves the panes down a line while it is (the window opens narrower now), and they go back when one line holds it', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.metrics = true' }).login());
  vm.slash('');
  const top = () => [vm.num('NS.UI.ui.list.points.TOPLEFT.y'), vm.num('NS.UI.ui.edge.points.TOPRIGHT.y')];
  assert.deepEqual(top(), [-64, -64], 'no status line: under the header');
  vm.slash('stream on');
  vm.run('NS.UI.RenderStatus()');
  assert.equal(vm.evaluate('NS.UI.StatusText()'), 'No screen reading: your messages wait for a reload, and replies still come in.');
  assert.equal(vm.num('NS.UI.ui.status.width'), 420 - 64 - 14, 'its width set outright, so it measures before it is drawn');
  assert.equal(vm.num('NS.UI.ui.status:GetStringHeight()'), 24, 'two lines of 10 pt');
  assert.deepEqual(top(), [-76, -76], 'the panes start 12 lower');
  // The chat list opened: the window 226 wider, so one line holds it and the panes go back up, on the
  // click itself (never at the next tick, by themselves); the conversation follows the list's top.
  // Folded again: two lines, and 12 lower again.
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b)');
  assert.equal(vm.num('NS.UI.ui.status.width'), 420 + 226 - 64 - 14);
  assert.equal(vm.num('NS.UI.ui.list.points.TOPLEFT.y'), -64);
  assert.equal(vm.evaluate('NS.UI.ui.edge.points.TOPRIGHT.rel == NS.UI.ui.list'), 'true');
  vm.run('local b = NS.UI.ui.listBtn; b.scripts.OnClick(b)');
  assert.deepEqual(top(), [-76, -76]);
  vm.slash('stream off');
  vm.run('NS.UI.RenderStatus()');
  assert.deepEqual(top(), [-64, -64], 'one line or none: back under the header');
});

test('a status line taking two lines, or one again, keeps the reader\'s place in the transcript (the pane 12 shorter or taller); only a new width draws it again on the newest', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.metrics = true' }).login());
  vm.run(`local sf = NS.UI.ui.scroll; sf.width, sf.height = 358, 208
    function sf:GetVerticalScrollRange() return math.max(0, (NS.UI.ui.content.height or 0) - (self.height or 0)) end`);
  vm.run('local c = NS.Chats.Active(); for i = 1, 12 do NS.Chats.AddHistory(c, { role = i % 2 == 1 and "user" or "assistant", text = "line " .. i .. " " .. string.rep("word ", 30) }) end');
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  vm.advance(0.1);
  // The engine's OnSizeChanged, as the pane gets its size.
  const size = (w, h) => { vm.run(`local sf = NS.UI.ui.scroll; sf.width, sf.height = ${w}, ${h}; for _, f in ipairs(sf.hooks.OnSizeChanged) do f(sf, ${w}, ${h}) end`); vm.advance(0.1); };
  const at = () => vm.num('NS.UI.ui.scroll.vscroll'), range = () => vm.num('NS.UI.ui.scroll:GetVerticalScrollRange()');
  size(358, 208);
  assert.ok(range() > 400, `a long chat (${range()})`);
  // Reading from the middle: the status line takes two lines (the pane 12 shorter), then one again.
  vm.run('NS.UI.ui.scroll:SetVerticalScroll(200)');
  size(358, 196);
  assert.equal(at(), 200, 'the place kept');
  size(358, 208);
  assert.equal(at(), 200, 'and kept again');
  // At the bottom: still at the bottom.
  vm.run('local sf = NS.UI.ui.scroll; sf:SetVerticalScroll(sf:GetVerticalScrollRange())');
  size(358, 196);
  assert.equal(at(), range(), 'the bottom kept');
  // A new width wraps every bubble again: drawn again, on the newest.
  vm.run('NS.UI.ui.scroll:SetVerticalScroll(200)');
  size(500, 196);
  assert.notEqual(at(), 200, 'redrawn on the newest');
  // A width that changed while the window was closed counts as seen: opening draws it at that width,
  // and the first status flip after keeps the reader's place.
  vm.run('NS.UI.Toggle(false)');
  size(358, 196);
  vm.run('NS.UI.Toggle(true)');
  vm.advance(0.1);
  vm.run('NS.UI.ui.scroll:SetVerticalScroll(200)');
  size(358, 208);
  assert.equal(at(), 200, 'kept after a reopen');
});

test('a new notice taller than the pane lands on its start (/nqa help all), a short one at the bottom', () => {
  const vm = confirmHello(newVM({ extra: 'STUB.metrics = true' }).login());
  vm.run(`local sf = NS.UI.ui.scroll; sf.width, sf.height = 510, 364
    function sf:GetVerticalScrollRange() return math.max(0, (NS.UI.ui.content.height or 0) - 364) end`);
  vm.run('local c = NS.Chats.Active(); for i = 1, 4 do NS.Chats.AddHistory(c, { role = i % 2 == 1 and "user" or "assistant", text = "hello there line " .. i }) end');
  vm.run('NS.UI.Toggle(true); NS.Refresh("all")');
  vm.advance(0.1);
  vm.slash('help all');
  vm.advance(0.1);
  const [top, h, at, range] = ['-NS.UI.ui.notice.points.TOPLEFT.y', 'NS.UI.ui.notice.height', 'NS.UI.ui.scroll.vscroll', 'NS.UI.ui.scroll:GetVerticalScrollRange()'].map(e => vm.num(e));
  assert.ok(h > 364, `help all is taller than the pane (${h})`);
  assert.ok(Math.abs(at - (top - 4)) < 1, `lands on the notice's start: at ${at}, notice at ${top}, range ${range}`);
  // A short answer: the bottom, as before.
  vm.slash('help');
  vm.advance(0.1);
  assert.equal(vm.num('NS.UI.ui.scroll.vscroll'), vm.num('NS.UI.ui.scroll:GetVerticalScrollRange()'));
  // From a closed window too.
  vm.run('NS.UI.Toggle(false)');
  vm.slash('help all');
  vm.advance(0.1);
  assert.ok(Math.abs(vm.num('NS.UI.ui.scroll.vscroll') - (vm.num('-NS.UI.ui.notice.points.TOPLEFT.y') - 4)) < 1, 'opened by the answer, on its start');
});

test('notices follow the chat text size', () => {
  const vm = confirmHello(newVM().login());
  vm.run('function ChatFontNormal:GetFont() return "Fonts\\\\ARIALN.TTF", 14, "" end');
  vm.slash('text large');
  vm.slash('help');
  const large = vm.num('NS.UI.ui.notice.body.fontSize');
  vm.slash('text small');
  vm.slash('help');
  assert.ok(vm.num('NS.UI.ui.notice.body.fontSize') < large, 'smaller with small text');
});

test('each answer names its own row: a command that flips a setting quotes the label of the Settings row that reads it (P.LABELS is by position)', () => {
  const vm = confirmHello(newVM().login());
  const row = key => `(function() for _, sw in ipairs(NS.Settings.SWITCHES) do if sw[2] == NS.Settings.LABELS.${key} then return sw[3]() and "on" or "off" end end return "no row" end)()`;
  const flips = {
    hud: ['hud off', 'hud on'], waypoint: ['waypoint off', 'waypoint on'], dnd: ['dnd combat off', 'dnd combat on'],
    context: ['context off', 'context on'], checkins: ['companion off', 'companion on'], screen: ['stream on', 'stream off'], tooltips: ['tooltips off', 'tooltips on'], quips: ['quips on', 'quips off'],
  };
  for (const [key, [first, second]] of Object.entries(flips)) {
    const before = vm.evaluate(row(key));
    assert.notEqual(before, 'no row', key);
    vm.slash(first);
    const after = vm.evaluate(row(key));
    assert.notEqual(after, before, `${key}: /nqa ${first} flips the row labelled ${vm.evaluate(`NS.Settings.LABELS.${key}`)}`);
    vm.slash(second);
    assert.equal(vm.evaluate(row(key)), before, `${key}: /nqa ${second} flips it back`);
  }
});

test('ways back name a click first: the small bar\'s X and the Game Data box', () => {
  const vm = confirmHello(newVM({ extra: 'AddonCompartmentFrame = { RegisterAddon = function(self, d) STUB.compartment = d end }' }).login());
  vm.slash('hud off');
  vm.slash('');
  vm.slash('');
  vm.run('local b = NS.UI.ui.miniClose; b.scripts.OnClick(b)');
  const line = vm.chatLines().pop();
  assert.match(line, /NeverQuestAlone is hidden\. Click NeverQuestAlone in the minimap's addon menu, or type \/nqa, to bring it back\./, line);
  assert.match(tipOf(vm, 'local b = NS.UI.ui.miniClose; b.scripts.OnEnter(b)'), /Click NeverQuestAlone in the minimap's addon menu, or type \/nqa, to bring it back\./);
  assert.match(tipOf(vm, 'STUB.compartment.funcOnEnter({})'), /Right-click for Settings/);
  vm.slash('context off');
  vm.run('NS.UI.RenderContext()');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.note'), 'Game Data with Messages, in Settings, turns it back on.');
  assert.equal(vm.evaluate('NS.Settings.SWITCHES[5][2]'), 'Game Data with Messages', 'the row the note names');
  // Every label another file names is a row's own.
  assert.deepEqual(vm.json('NS.Settings.LABELS'), { hud: 'NeverQuestAlone HUD', waypoint: 'Next Stop as a Waypoint', dnd: 'Quiet in Combat', context: 'Game Data with Messages', checkins: 'Check-Ins', screen: 'Screen Reading', tooltips: 'Upgrade Verdicts in Item Tooltips', quips: "One-Liners" });
  assert.doesNotMatch(vm.evaluate('NS.UI.ui.ctx.note'), /\/nqa/);
  vm.slash('context on');
  vm.run('NS.UI.RenderContext()');
  assert.equal(vm.evaluate('NS.UI.ui.ctx.note'), 'Game Data with Messages, in Settings, turns it off in every chat.');
});
