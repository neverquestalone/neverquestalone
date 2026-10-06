// Copy and Paste (addon/NeverQuestAlone/Paste.lua, docs/ADDON-FIRST.md): the addon with
// no NeverQuestAlone app. A message goes to the player's own AI by copy and
// paste, and the reply pasted back is read as the app reads one.
//   - The reply reader matches the app's (bridge/app/render.mjs renderReply,
//     bridge/app/map-protocol.mjs validateMapCommand) on the same replies.
//   - The JSON reader reads what JSON.parse reads and refuses what it refuses.
//   - An install no app has answered draws nothing, loads nothing, and has no
//     red light; a message waits in the window; a pasted reply lands as a reply
//     (routes on the map, chips, refs, weights); the app's first beat links it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { renderReply } from '../bridge/app/render.mjs';
import { pasteLuaSource, FIRST_LINE, LAST_LINE } from './helpers/paste-lua.mjs';
import * as protocol from '../bridge/app/map-protocol.mjs';

const require = createRequire(import.meta.url);
const { newVM, reloadVM, lstr } = require('./helpers/nqa-vm.js');
const { byokSlot } = require('./helpers/byok-slots.js');

const fresh = () => newVM({ linked: false }).login().advance(4);
const parse = (vm, s) => vm.json(`NS.Paste.Parse(${lstr(s)})`);
const commands = (vm, s) => vm.json(`(function() local r, out = NS.Paste.Parse(${lstr(s)}), {}
	for i, c in ipairs(r.map) do out[i] = NS.Paste.MapCommand(c) or false end
	return out end)()`);
const asList = v => (Array.isArray(v) ? v : []);

// Replies as an AI page's Copy button gives them: markdown, a TL;DR, the blocks.
const ROUTE = '{"op":"set","layer":"route","title":"Westfall quests","ordered":true,"points":[{"m":1436,"x":56.3,"y":47.5,"label":"1. Sentinel Hill","kind":"turnin","note":"Turn in Westfall Stew","q":[36]},{"m":1436,"x":"52","y":31.25,"label":"2. Farm","kind":"kill"}]}';
// A reply that tries the game's escape codes: an item link, a texture, an atlas and a name.
const INJECT = 'A link |Hitem:19019::::::::60:::::|h[Thunderfury]|h, a texture |TInterface\\Icons\\INV_Misc_QuestionMark:0|t, an atlas |A:groupfinder-icon-friend:16:16|a and a name |Kq1|k.\nTLDR: none of |Hitem:1|h[it]|h goes live.';
const REPLIES = [
  'Head to Sentinel Hill first.\n\nTL;DR: Sentinel Hill, then the farms.',
  '## Your route\n\n- Turn in **Westfall Stew** at Sentinel Hill\n- Kill *Defias* at the farm\n  - then loot `the bandana`\n\n> Stay on the road.\n\n**TL;DR:** Hill, then farm.',
  'Pick the [Wowhead guide](https://example.com/guide) or <https://example.com/x>.\n\n## TL;DR\nRead the guide.',
  'Pipes | stay literal ||, and |cff00ff00 colours|r never go live.\nTLDR: pipes are safe.',
  'No marker here. Just two sentences! And a third?',
  'Code:\n```lua\nlocal x = 1 -- a | b\n```\nTL;DR: some code.',
  `Route drawn.\n\n\`\`\`wowmap\n${ROUTE}\n{"op":"clear","layer":"old"}\n\`\`\`\n\n\`\`\`wowchips\n- Route me there\n- What should I do next?\n- What should I do next?\n- A fourth one that is cut\n\`\`\`\n\n\`\`\`wowrefs\n{"q":[36,"37",0,-1],"items":[2140],"Spells":[8017]}\n\`\`\`\n\n\`\`\`wowweights\n{"STR":1,"sta":0.8,"luck":5,"agi":250}\n\`\`\`\n\nTL;DR: Follow the route.`,
  '```wowchips\n["One long suggestion that goes on well past sixty characters in total length", "Two"]\n```\n```wowrefs\nquests: 12, 13\nitems 99\n```\nTL;DR: refs by line.',
  `A list form.\n\`\`\`wowmap\n[${ROUTE}, {"op":"clearall"}]\n\`\`\`\nTL;DR: listed.`,
  INJECT,
];

test('a pasted reply reads as the app reads it: text, TL;DR, chips, refs, weights, map commands', () => {
  const vm = fresh();
  for (const reply of REPLIES) {
    const js = renderReply(reply);
    const lua = parse(vm, reply);
    assert.equal(lua.text, js.text, `text of ${JSON.stringify(reply.slice(0, 40))}`);
    assert.equal(lua.summary, js.summary, `summary of ${JSON.stringify(reply.slice(0, 40))}`);
    assert.deepEqual(lua.chips ?? null, js.chips, `chips of ${JSON.stringify(reply.slice(0, 40))}`);
    assert.deepEqual(lua.refs ?? null, js.refs, `refs of ${JSON.stringify(reply.slice(0, 40))}`);
    assert.deepEqual(lua.weights ?? null, js.weights, `weights of ${JSON.stringify(reply.slice(0, 40))}`);
    const want = js.mapCommands.map(c => protocol.validateMapCommand(c) || false);
    assert.deepEqual(asList(commands(vm, reply)), want, `map commands of ${JSON.stringify(reply.slice(0, 40))}`);
  }
});

test('a pasted reply can\'t make a link, a texture, an atlas or a name live: every pipe it brings is doubled', () => {
  const vm = fresh();
  const r = parse(vm, INJECT);
  for (const field of [r.text, r.summary]) {
    for (const code of ['Hitem:19019', 'TInterface', 'A:groupfinder', 'Kq1', 'Hitem:1|']) assert.ok(!new RegExp(`(^|[^|])\\|${code.replace(/[|\\]/g, m => `\\${m}`)}`).test(field), `${code} stays text in ${JSON.stringify(field)}`);
    assert.match(field, /\|\|H/, 'shown as the characters the AI wrote');
  }
});

test('map commands are held to the app\'s limits and never throw on odd input', () => {
  const vm = fresh();
  const odd = [
    '{"op":"set","layer":"__proto__","points":[{"m":1,"x":1,"y":1}]}',
    '{"op":"set","layer":"a b","points":[{"m":1,"x":1,"y":1}]}',
    '{"op":"set","layer":"x","points":"nope"}',
    '{"op":"set","layer":"x","points":[{"m":0,"x":1,"y":1},{"m":1.5,"x":1,"y":1},{"m":"12","x":-5,"y":250,"label":"a|b\\u0001c","kind":"dragon","q":[1,1,2,3,4,5,6,7,1e7]}]}',
    '{"op":"set","layer":"x","title":{"toString":1},"points":[{"m":1,"x":1,"y":1}]}',
    '{"op":"fly"}',
    '[1,2]',
  ];
  for (const s of odd) {
    const c = JSON.parse(s);
    const lua = vm.json(`(function() local ok, c = NS.Paste.JSON(${lstr(s)}); return NS.Paste.MapCommand(c) or false end)()`);
    assert.deepEqual(lua, protocol.validateMapCommand(c) || false, s);
  }
});

// [code health AD-13] Copy and Paste copied the app's limits, map limits and distance-claims list by
// hand, held to the app's only through fixtures. Paste.lua now carries a block made from the bridge's
// own exports (tests/helpers/paste-lua.mjs), checked here byte for byte.
test('Paste.lua carries the block made from the app\'s own limits, map limits and distance claims, byte for byte; a layer name or map id past the app\'s limit is refused as the app refuses it (code health AD-13)', () => {
  const src = fs.readFileSync(new URL('../addon/NeverQuestAlone/Paste.lua', import.meta.url), 'utf8');
  const want = pasteLuaSource();
  const start = src.indexOf(FIRST_LINE);
  assert.ok(start > 0, 'the generated block is in Paste.lua');
  assert.equal(src.indexOf(FIRST_LINE, start + 1), -1, 'once');
  assert.equal(src.slice(start, start + want.length), want, 'regenerate: node -e "import(\'./tests/helpers/paste-lua.mjs\').then(m => process.stdout.write(m.pasteLuaSource()))"');
  assert.ok(want.trimEnd().endsWith(LAST_LINE));
  const vm = fresh();
  for (const s of [
    `{"op":"set","layer":"${'a'.repeat(32)}","points":[{"m":1,"x":1,"y":1}]}`,
    `{"op":"set","layer":"${'a'.repeat(33)}","points":[{"m":1,"x":1,"y":1}]}`,
    '{"op":"set","layer":"x","points":[{"m":99999,"x":1,"y":1},{"m":100000,"x":2,"y":2}]}',
  ]) {
    const lua = vm.json(`(function() local ok, c = NS.Paste.JSON(${lstr(s)}); return NS.Paste.MapCommand(c) or false end)()`);
    assert.deepEqual(lua, protocol.validateMapCommand(JSON.parse(s)) || false, s.slice(0, 60));
  }
});

test('the JSON reader reads what JSON.parse reads and refuses what it refuses', () => {
  const vm = fresh();
  const good = ['{"a":1,"b":[1,2,3],"c":{"d":"e"}}', '[]', '{}', '"\\u00e9\\ud83d\\ude00\\n\\t\\"\\\\/"', '-12.5e2', '[true,false,{"x":[[[1]]]}]', ' { "k" : "v" } '];
  for (const s of good) {
    const ok = vm.bool(`(NS.Paste.JSON(${lstr(s)}))`);
    assert.ok(ok, s);
    const v = vm.json(`select(2, NS.Paste.JSON(${lstr(s)}))`);
    const want = JSON.parse(s);
    assert.deepEqual(Array.isArray(want) && want.length === 0 ? [] : v ?? null, Array.isArray(want) && want.length === 0 ? [] : want, s);
  }
  for (const s of ['{"a":1,}', '[1 2]', '{a:1}', '"open', '{"a":"line\nbreak"}', 'nope', '01x', '{"a":1} trailing']) {
    assert.equal(vm.bool(`(NS.Paste.JSON(${lstr(s)}))`), false, `refuses ${JSON.stringify(s.slice(0, 30))}`);
    assert.throws(() => JSON.parse(s), undefined, `JSON.parse refuses ${JSON.stringify(s.slice(0, 30))} too`);
  }
  // One limit of its own: 16 levels deep is plenty for anything an AI sends, and
  // pasted text can't run the reader out of stack.
  assert.equal(vm.bool(`(NS.Paste.JSON(${lstr('['.repeat(16) + ']'.repeat(16))}))`), true);
  assert.equal(vm.bool(`(NS.Paste.JSON(${lstr('['.repeat(40) + ']'.repeat(40))}))`), false);
  assert.ok(vm.bool('NS.Paste.IsArray(select(2, NS.Paste.JSON("[]")))'), 'an empty list is still a list');
});

test('an install no app has answered: no strip, no slot loads, no red light, nothing to fix', () => {
  const vm = fresh();
  assert.equal(vm.strip(), null, 'no hello on the strip');
  vm.advance(700); // past the 10-minute idle check and the red light's 2 minutes
  assert.equal(vm.strip(), null, 'still nothing drawn');
  assert.equal(vm.loads(), 0, 'no slot loaded');
  assert.equal(vm.evaluate('(NS.Transport.Light())'), 'paste');
  assert.equal(vm.evaluate('NQADB.linked'), null);
  const lines = vm.chatLines().join('\n');
  assert.doesNotMatch(lines, /slot|bridge|can't hear|Reload to keep going/i, 'no warning for a missing app');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('a message waits in Copy and Paste: the instructions, the game data without your name, realm or guild, your words', () => {
  const vm = fresh();
  vm.send('Plan me a route for my quests');
  const chat = vm.json('NS.Chats.Active()');
  assert.equal(chat.pending.length, 1);
  assert.equal(chat.pending[0].paste, true);
  assert.equal(vm.lastHistory().role, 'user');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'true', 'the window opens');
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  assert.ok(msg.startsWith(vm.evaluate('NS.Paste.MARK')), 'starts with the mark');
  assert.match(msg, /TL;DR:/);
  assert.match(msg, /wowmap/);
  assert.match(msg, /Game data, read from the game just now:\n/);
  assert.match(msg, /Character: level \d+ Night Elf Hunter/);
  assert.match(msg, /The player's message:\nPlan me a route for my quests$/);
  for (const secret of ['Testchar', 'Test Realm', 'Test Guild']) assert.ok(!msg.includes(secret), `no ${secret}`);
  assert.equal(vm.evaluate('STUB.focus == NQAPasteOut and "yes" or "no"'), 'yes', 'the message has the focus, selected');
  assert.equal(vm.strip(), null, 'nothing drawn for it');
  assert.equal(vm.loads(), 0, 'nothing loaded for it');
  // Unticked Game Data: no game data at all.
  vm.run('NS.Chats.Send("Just words", nil, { skipGameData = true })');
  const bare = vm.evaluate('NQAPasteOut:GetText()');
  assert.match(bare, /No game data came with this message\./);
  assert.doesNotMatch(bare, /Character:/);
});

test('a pasted reply lands like one from the app: history, chips, refs, weights, the route on the map, news', () => {
  const vm = fresh();
  vm.send('Route me through Westfall');
  vm.run(`NQAPasteIn:SetText(${lstr(REPLIES[6])})`);
  vm.run('NQAPasteIn:GetScript("OnTextChanged")(NQAPasteIn, true)');
  vm.advance(0.3); // a paste is read on its own, a moment after it lands
  const chat = vm.json('NS.Chats.Active()');
  assert.equal(asList(chat.pending).length, 0, 'nothing waits');
  const e = vm.lastHistory();
  assert.equal(e.role, 'assistant');
  assert.equal(e.summary, 'Follow the route.');
  assert.deepEqual(e.chips, ['Route me there', 'What should I do next?', 'A fourth one that is cut']);
  assert.deepEqual(e.refs, { q: [36, 37], i: [2140], s: [8017] });
  assert.deepEqual(e.drew, ['route']);
  const map = vm.json('NQAMapDB.map');
  assert.equal(map.epoch, 'paste');
  assert.equal(map.layers.length, 1);
  assert.equal(map.layers[0].name, 'route');
  assert.equal(map.layers[0].ordered, true);
  assert.deepEqual(map.layers[0].points[0], [1436, 56.3, 47.5, '1. Sentinel Hill', 'turnin', 'Turn in Westfall Stew', [36]]);
  assert.deepEqual(map.layers[0].points[1], [1436, 52, 31.25, '2. Farm', 'kill']);
  assert.equal(vm.evaluate('NQAMapDB.nav and NQAMapDB.nav.layer'), 'route', 'the navigator follows it');
  assert.deepEqual(vm.json('NQADB.weights[NS.CharKey()]'), { str: 1, sta: 0.8 });
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'false', 'the window closes');
  assert.ok(vm.evaluate('NS.HUD.View().mode') === 'news', 'the HUD shows it as news');
  // The route is already followed (a new route on your continent is), so the
  // reply's button is Okay, as with a reply from the app (C-100).
  assert.equal(vm.evaluate('NS.HUD.View().okLabel'), 'Okay');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('pasting the message back is caught; an empty paste waits; Stop ends the wait', () => {
  const vm = fresh();
  vm.send('What next?');
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  vm.run(`NQAPasteIn:SetText(${lstr(msg)})`);
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'false');
  assert.ok(vm.list('STUB.texts').includes("That's your message from step 1. Copy your AI's reply and paste it here."), 'says so');
  assert.equal(vm.json('NS.Chats.Active()').pending.length, 1, 'still waiting');
  vm.run('NQAPasteIn:SetText("   ")');
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'false');
  assert.ok(vm.list('STUB.texts').includes("Paste your AI's reply here first."));
  assert.equal(vm.json('NS.Chats.Active()').pending.length, 1, 'still waiting');
  vm.slash('stop');
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 0, 'Stop ends the wait');
  assert.equal(vm.lastHistory().kind, 'aborted');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'false');
  vm.slash('paste');
  assert.match(vm.chatLines().join('\n'), /Nothing is waiting for a pasted reply\. Send a message and Copy and Paste opens with it\./);
});

test('back to a waiting message: Close keeps it, and Paste Reply or /nqa paste reopens it at step 2, from any chat', () => {
  const vm = fresh();
  // An ask from the HUD goes to Quick questions, not the window's chat.
  vm.run('NS.Chats.Send("What next?", NS.QuickChat().id)');
  const quick = vm.evaluate('NS.QuickChat().id');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'true');
  assert.equal(vm.bool('STUB.focus == NQAPasteOut'), true, 'the first time, the message is selected to copy');
  vm.run('NS.Paste.Close()');
  assert.equal(asList(vm.json(`NS.Chats.Find(${lstr(quick)})`).pending).length, 1, 'Close keeps the message waiting');
  vm.run('if NS.Chats.Active().id == NS.QuickChat().id then NS.Chats.New("Another") end');
  vm.slash('paste');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'true', '/nqa paste finds it in Quick questions');
  assert.equal(vm.bool('STUB.focus == NQAPasteIn'), true, 'a reopen waits in step 2 for the reply');
  assert.ok(vm.list('STUB.texts').some(t => /^Press (Cmd|Ctrl)\+V to paste your AI's reply under step 2\.$/.test(t)));
  // The reply pasted into step 1 by mistake goes to step 2 and is read.
  const reply = 'Head to Sentinel Hill first, then take the road west to the farms.\nTL;DR: the Hill, then the farms.';
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  vm.run(`NQAPasteOut:SetText(${lstr(reply)}); NQAPasteOut.scripts.OnTextChanged(NQAPasteOut, true)`);
  assert.equal(vm.evaluate('NQAPasteOut:GetText()'), msg, 'step 1 keeps the message');
  vm.advance(0.5);
  assert.equal(asList(vm.json(`NS.Chats.Find(${lstr(quick)})`).pending).length, 0, 'the reply was read');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'false');
  // A reply that ends as the message does ("What next?") keeps its ending,
  // and one pasted at the cursor inside the message is taken out whole.
  vm.run('NS.Chats.Send("What next?", NS.QuickChat().id)');
  const reply2 = 'Kill boars south of the farm, then ask me What next?';
  vm.run(`NQAPasteOut:SetText(${lstr(reply2)}); NQAPasteOut.scripts.OnTextChanged(NQAPasteOut, true)`);
  assert.equal(vm.evaluate('NQAPasteIn:GetText()'), reply2);
  vm.advance(0.5);
  vm.run('NS.Chats.Send("And after that?", NS.QuickChat().id)');
  const m3 = vm.evaluate('NQAPasteOut:GetText()');
  const inside = m3.slice(0, 40) + reply + m3.slice(40);
  vm.run(`NQAPasteOut:SetText(${lstr(inside)}); NQAPasteOut.scripts.OnTextChanged(NQAPasteOut, true)`);
  assert.equal(vm.evaluate('NQAPasteIn:GetText()'), reply);
});

test('Close, Stop and Use Reply say what they do to the waiting message', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.run('function GameTooltip:AddLine(t) table.insert(STUB.tipLines, t) end');
  const tip = name => {
    vm.run(`STUB.tipLines = {}; local b; for _, c in ipairs(NQAPaste.children) do if c.text == ${lstr(name)} then b = c end end; b.scripts.OnEnter(b)`);
    return vm.list('STUB.tipLines').join(' | ');
  };
  assert.match(tip('Close'), /Your message keeps waiting for its reply/);
  assert.match(tip('Stop'), /Drops this message: it won't get a reply\./);
  assert.match(tip('Use Reply'), /Reads the reply under step 2\./);
});

test('with no app, the short help offers the way back and the app, not screen reading', () => {
  const vm = fresh();
  vm.slash('help');
  const help = vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text') || '';
  const [around, list] = help.split('\n\n');
  assert.match(around, /^Getting around:\n/, 'the Welcome\'s lessons first (G3)');
  assert.ok(list.split('\n').length <= 6, help);
  assert.match(help, /\/nqa paste.*Open Copy and Paste again/);
  assert.match(help, /\/nqa app.*Show the link to download the NeverQuestAlone app/);
  assert.doesNotMatch(help, /Screen Reading|mode reload/);
});

test('an app heard while a message waits: the message still takes a pasted reply, and says so', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.signal('ctl', 'bell_alive_a', false);
  vm.advance(2.5);
  vm.signal('ctl', 'bell_alive_a', true);
  assert.equal(vm.evaluate('NQADB.linked'), 'true');
  assert.match(vm.chatLines().join('\n'), /replies come back by themselves now\. The message already waiting still takes a pasted reply\./);
  vm.advance(15); // past the HUD's flash
  assert.equal(vm.evaluate('NS.HUD.View().detail'), 'paste', 'the HUD still offers Paste Reply for it');
});

test('the app\'s first beat links the install: the hello goes up, replies come back by themselves', () => {
  const vm = fresh();
  assert.equal(vm.strip(), null);
  vm.signal('ctl', 'bell_alive_a', false); // the app rings its beat
  vm.advance(2.5);
  vm.signal('ctl', 'bell_alive_a', true);
  assert.equal(vm.evaluate('NQADB.linked'), 'true');
  const wires = vm.stripWires();
  assert.ok(wires.some(w => w.split('\x1f')[3] === 'hello'), 'the hello is drawn');
  assert.match(vm.chatLines().join('\n'), /The NeverQuestAlone app is running, so replies come back by themselves now\./);
  // Messages go to the app from now on.
  vm.send('Hi');
  assert.notEqual(vm.json('NS.Chats.Active()').pending[0].paste, true);
});

test('an install from before Copy and Paste that ever sent is linked; Copy and Paste can still be picked', () => {
  const vm = newVM({ linked: false, db: 'NQADB = { sendCounter = 3, cursor = 10 }' }).login().advance(4);
  assert.equal(vm.evaluate('NQADB.linked'), 'true');
  assert.equal(vm.bool('NS.Paste.On()'), false);
  vm.slash('replies paste');
  assert.equal(vm.bool('NS.Paste.On()'), true);
  vm.send('Pasted anyway');
  assert.equal(vm.json('NS.Chats.Active()').pending[0].paste, true);
  vm.slash('replies auto');
  assert.equal(vm.bool('NS.Paste.On()'), false);
});

test('markdown tables become rows under one note, as the window can\'t draw them', () => {
  const vm = fresh();
  const r = parse(vm, '| Quest | Level |\n|---|:---:|\n| Stew | 10 |\n| Bandana | 12 |\nTL;DR: two quests.');
  assert.match(r.text, /A table doesn't fit here/);
  assert.match(r.text, /Stew · 10\nBandana · 12/);
});

test('/nqa app shows where to get the app, ready to copy (an addon can\'t open a browser)', () => {
  const vm = fresh();
  vm.slash('app');
  assert.equal(vm.evaluate('NQACopyBox:GetText()'), vm.evaluate('NS.Paste.APP_PAGE'));
  // [UX-W01] The one place with the Mac and Windows downloads once a release publishes, the app's own download page.
  assert.equal(vm.evaluate('NS.Paste.APP_PAGE'), 'https://github.com/tommygeoco/neverquestalone/releases');
  assert.match(vm.chatLines().join('\n'), /The link to the NeverQuestAlone app is selected\. Press (?:Cmd|Ctrl)\+C, then paste it into your browser to download the app\. Once it's set up, replies come back by themselves\./);
});

test('a reload inbox links the install only when the app wrote it just now, never from an app that has quit', () => {
  const inbox = age => `NQA_Inbox = { v = 2, ts = "x", now = time() - ${age}, token = "someoneelse", bridge = { ver = "1.4.5", push = 1, caps = {} }, records = {} }`;
  const stale = newVM({ linked: false, inbox: inbox(3600) }).login().advance(4);
  assert.equal(stale.evaluate('NQADB.linked'), null, 'an hour-old inbox links nothing');
  assert.equal(stale.bool('NS.Paste.On()'), true);
  const fresh2 = newVM({ linked: false, inbox: inbox(5) }).login().advance(4);
  assert.equal(fresh2.evaluate('NQADB.linked'), 'true', 'the app wrote it seconds ago: it runs');
  assert.equal(fresh2.bool('NS.Paste.On()'), false);
});

test('renaming or deleting a Copy and Paste chat tells no one and links nothing, even after a reload (UI critic C-01)', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.run('NS.Paste.Close()');
  const id = vm.evaluate('NS.Chats.Active().id');
  vm.run(`NS.Chats.Rename(${lstr(id)}, "Westfall")`);
  vm.run('NS.Chats.New("Another")');
  vm.run(`NS.Chats.Delete(${lstr(id)})`);
  assert.equal(vm.strip(), null, 'nothing drawn');
  assert.equal(vm.num('NQADB.sendCounter'), 0, 'no record made');
  assert.equal(vm.num('#NQADB.outbox'), 0);
  const again = reloadVM(vm, { linked: false }).login().advance(4);
  assert.equal(again.evaluate('NQADB.linked'), null, 'still no app after the reload');
  again.send('And now?');
  assert.equal(again.evaluate('NQAPaste:IsShown()'), 'true', 'the next ask opens Copy and Paste');
  assert.equal(again.strip(), null);
  // Stop works on a Copy and Paste wait in a chat that never sent to an app.
  again.slash('stop');
  assert.equal(asList(again.json('NS.Chats.Active()').pending).length, 0);
  assert.equal(again.lastHistory().text, "Stopped. That message won't get a reply.");
});

test('an ask in combat opens its window after the fight, and a fight takes the keys back (C-03)', () => {
  const vm = fresh();
  vm.run('STUB.combat = true');
  vm.send('What next?');
  assert.equal(vm.evaluate('NQAPaste and NQAPaste:IsShown()'), null, 'no window mid-fight');
  assert.ok(vm.list('STUB.errors').includes('Asked NeverQuestAlone: your message opens after the fight.'));
  vm.run('STUB.combat = false; STUB.FireEvent("PLAYER_REGEN_ENABLED")');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'true', 'it opens when the fight ends');
  assert.equal(vm.bool('STUB.focus == NQAPasteOut'), true);
  vm.run('STUB.combat = true; STUB.FireEvent("PLAYER_REGEN_DISABLED")');
  assert.equal(vm.evaluate('STUB.focus'), null, 'a new fight gives the keys back to the game');
});

test('one message waits per chat, and one left waiting an hour stops at login (C-04)', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.send('Actually, where do I train?');
  const chat = vm.json('NS.Chats.Active()');
  assert.equal(asList(chat.pending).length, 1);
  const texts = asList(chat.history).map(e => e.text);
  assert.ok(texts.includes('Replaced by your newer message.'));
  assert.equal(vm.lastHistory().queued, undefined, 'nothing is queued behind it');
  vm.run('NS.Chats.Active().pending[1].t = time() - 7200');
  const later = reloadVM(vm, { linked: false }).login().advance(4);
  assert.equal(asList(later.json('NS.Chats.Active()').pending).length, 0);
  assert.equal(later.lastHistory().text, 'No reply was pasted, so this stopped waiting. Ask again any time.');
});

test('Automatic falls back to Copy and Paste while the app is gone (C-05)', () => {
  const vm = newVM({}).login(); // linked, but no app has spoken this session
  vm.advance(200);
  assert.equal(vm.evaluate('(NS.Transport.Light())'), 'red');
  assert.equal(vm.bool('NS.Paste.On()'), true);
  vm.send('Anyone there?');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'true', 'the ask goes by Copy and Paste');
  assert.equal(vm.json('NS.Chats.Active()').pending[0].paste, true);
  // [C-133] It says why, not the first-run words.
  assert.equal(vm.evaluate('NS.Paste.FALLBACK'), "The NeverQuestAlone app hasn't answered for a while, so this message goes by Copy and Paste. Once it's back, replies come by themselves again.");
  assert.ok(vm.list('STUB.texts').includes(vm.evaluate('NS.Paste.FALLBACK')), 'the window says why');
  // A player who picked Copy and Paste gets the usual first line.
  const picked = newVM({}).login().advance(4);
  picked.slash('replies paste');
  picked.send('Pasted by choice');
  assert.ok(picked.list('STUB.texts').includes("Your AI's reply shows in the chat as soon as you paste it."));
  assert.ok(!picked.list('STUB.texts').includes(picked.evaluate('NS.Paste.FALLBACK')));
  // And with no app ever, the same.
  const none = fresh();
  none.send('What next?');
  assert.ok(!none.list('STUB.texts').includes(none.evaluate('NS.Paste.FALLBACK')));
});

test('with no app, the window shows no Thinking menu (C-06); with the app, the model and its menu', () => {
  const vm = fresh();
  vm.run('NS.UI.Toggle(true)');
  assert.deepEqual([vm.evaluate('NS.UI.ui.header.text'), vm.evaluate('NS.UI.ui.thinkArrow.shown')], ['', 'false'], 'no Thinking menu');
  const linked = newVM({}).login().advance(4);
  linked.run(`NS.Transport.HandleSlotData(${byokSlot()}, "slot")`);
  linked.run('NS.UI.Toggle(true)');
  assert.deepEqual([linked.evaluate('NS.UI.ui.header.text'), linked.evaluate('NS.UI.ui.thinkArrow.shown')], ['Haiku 4.5 · Low', 'true'], 'with the app, the menu is there');
  // No foot on the chat list (the app keeps the addon up to date): the app's link is /nqa app's.
  assert.equal(vm.evaluate('NQAUpdateButton'), null);
});

test('a stray paste isn\'t taken for the reply, a key typed in step 2 isn\'t either, part of the message is caught (C-07, C-08, C-130)', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.run('NS.Paste.Close(); NS.Paste.Open()');
  const paste = t => { vm.run(`NQAPasteIn:SetText(NQAPasteIn:GetText() .. ${lstr(t)}); NQAPasteIn.scripts.OnTextChanged(NQAPasteIn, true)`); vm.advance(0.5); };
  paste('w');
  // [C-140, UX-W15] A W meant for walking is not a reply: the read empties the box and says what it is for.
  assert.equal(vm.evaluate('NQAPasteIn:GetText()'), '', 'the W is cleared, not glued to the next paste');
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 1, 'a W is not a reply');
  assert.ok(vm.list('STUB.texts').includes("This box takes your AI's reply: paste it here. Press Esc to play."));
  assert.ok(!vm.list('STUB.texts').some(t => /^That doesn't look like/.test(t)), 'no Use Reply line for a stray key');
  // A reply pasted after the W is read whole, and its text starts with the reply.
  paste('The nearest forge is in Goldshire, past the bridge.\nTL;DR: Goldshire.');
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 0, 'the reply after a W was read');
  assert.match(vm.evaluate('NS.Chats.Active().history[#NS.Chats.Active().history].text'), /^The nearest forge/);
  vm.send('Where next?');
  vm.run('NS.Paste.Close(); NS.Paste.Open()');
  vm.run('NQAPasteIn:SetText("")');
  vm.run('STUB.texts = {}');
  paste('https://chatgpt.com/c/0123456789abcdef');
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 1, 'a link is not a reply');
  assert.ok(vm.list('STUB.texts').includes("That doesn't look like your AI's reply: it has no TL;DR line. Click Use Reply to use it anyway."));
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'true', 'Use Reply takes it anyway');
  vm.send('And after that?');
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  vm.run(`NQAPasteIn:SetText(${lstr(msg.split('\n').slice(1).join('\n'))})`);
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'false', 'the message without its first line is still the message');
  assert.ok(vm.list('STUB.texts').includes("That's your message from step 1. Copy your AI's reply and paste it here."));
});

// [code health AD-01] (KY-10) The auto-read refused a key, but Use Reply stored it as NeverQuestAlone's
// reply in saved data. Now a key in the reply box goes as one typed in the window does.
test('a key pasted into the reply box is refused, by Use Reply or read by itself: out of the box, the refusal said, nothing in history or saved data (code health AD-01)', () => {
  const vm = fresh();
  vm.send('Where do I go next?');
  const key = 'sk-ant-api03-CANARY' + 'abcdefghij'.repeat(8); // a fake canary, never a real key
  const refusal = vm.evaluate('NS.Chats.KeyRefused()');
  const before = vm.num('#NS.Chats.Active().history');
  const check = (how) => {
    assert.equal(vm.evaluate('NQAPasteIn:GetText()'), '', `${how}: the box is emptied`);
    assert.equal(vm.list('STUB.texts').at(-1), refusal, `${how}: the refusal's own words`);
    assert.equal(vm.num('#NS.Chats.Active().history'), before, `${how}: nothing in history`);
    assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 1, `${how}: the message still waits`);
    assert.ok(!vm.saved().includes('CANARY'), `${how}: nothing in saved data`);
  };
  // The audit's probe: Use Reply on a key with no TL;DR line.
  vm.run(`NQAPasteIn:SetText(${lstr(`Here is my key ${key}`)})`);
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'false');
  check('Use Reply');
  // Read by itself: a key that comes with a TL;DR line, pasted into step 2, then into step 1.
  vm.run(`NQAPasteIn:SetText(${lstr(`My key: ${key}\nTL;DR: my key.`)}); NQAPasteIn.scripts.OnTextChanged(NQAPasteIn, true)`);
  vm.advance(0.5);
  check('read by itself');
  vm.run(`NQAPasteIn:SetText(${lstr(key)}); NQAPasteIn.scripts.OnTextChanged(NQAPasteIn, true)`);
  vm.advance(0.5);
  check('a key alone, read by itself');
  vm.run(`NQAPasteOut:SetText(NQAPasteOut:GetText() .. ${lstr(key)}); NQAPasteOut.scripts.OnTextChanged(NQAPasteOut, true)`);
  vm.advance(0.5);
  check('pasted into step 1');
  // A reply still lands.
  vm.run(`NQAPasteIn:SetText(${lstr('Take the road north to the inn.\nTL;DR: the inn.')})`);
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'true');
  assert.equal(vm.lastHistory().summary, 'the inn.');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('a Copy and Paste wait loads no reply slots, even with the app linked (C-11)', () => {
  const vm = newVM({}).login().advance(4); // linked: the app has answered this install before
  vm.slash('replies paste');
  vm.send('What next?');
  vm.run('NS.Paste.Close(); NS.UI.Toggle(true)');
  assert.equal(vm.json('NS.Chats.Active()').pending[0].paste, true);
  const before = vm.num('NS.R.slots.reasons.progress or 0');
  vm.advance(300);
  assert.equal(vm.num('NS.R.slots.reasons.progress or 0'), before, 'no progress loads for a wait no slot can answer');
});

test('with the public build\'s name helper (ns.P), every line of Copy and Paste that names NeverQuestAlone takes the player\'s name; "NeverQuestAlone" stays', () => {
  const vm = fresh();
  // The companion renamed, as the app's persona does it (Store.lua's ns.P puts the name in).
  vm.run('NS.Chats.SetCompanionName("Nova")');
  vm.send('What next?');
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  assert.ok(msg.startsWith(vm.evaluate('NS.Paste.MARK')), 'the mark keeps the product\'s name');
  assert.match(msg, /You're Nova, a friendly guide/, 'the AI is told the companion\'s name');
  assert.ok(vm.list('STUB.texts').some(t => /how Nova should answer\. Press (Cmd|Ctrl)\+C/.test(t)));
  vm.run(`NQAPasteIn:SetText(${lstr(msg.split('\n').slice(1).join('\n'))})`);
  assert.equal(vm.evaluate('(NS.Paste.UseBox(false))'), 'false', 'the renamed message pasted back is still caught');
  assert.equal(vm.evaluate('NS.Paste.Named(NS.Paste.STARTER)').slice(0, 14), 'Ask anything. ', 'no name to put in');
  const welcome = vm.evaluate('NS.Paste.Named(NS.Paste.WELCOME)');
  assert.ok(welcome.startsWith("I'm Nova. ") && welcome.includes('The free NeverQuestAlone app skips the copying'), welcome);
  assert.equal(vm.evaluate('NS.Paste.Named("Get the NeverQuestAlone app; ask NeverQuestAlone.")'), 'Get the NeverQuestAlone app; ask Nova.');
  vm.run('NS.Paste.Close(); STUB.combat = true');
  vm.send('And in a fight?');
  assert.ok(vm.list('STUB.errors').includes('Asked Nova: your message opens after the fight.'));
});

test('a /reload after the update, before WoW restarts (Paste.lua not loaded yet): everything else runs clean, linked or not', () => {
  for (const linked of [true, false]) {
    const vm = newVM({ linked, skip: ['Paste.lua'] }).login().advance(4);
    assert.equal(vm.evaluate('NS.Paste'), null);
    vm.run('NS.UI.Toggle(true)');
    vm.send('What next?');
    const said = vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
    if (!linked) assert.equal(said, "Restart WoW to finish updating the addon; your message wasn't sent.");
    for (const cmd of ['paste', 'app', 'replies paste', 'replies auto', 'help', 'help all', 'stop', 'settings']) vm.slash(cmd);
    vm.run('NS.HUD.Render(); NS.Refresh("all")');
    vm.advance(200);
    assert.deepEqual(vm.list('STUB.forbidden'), [], `linked ${linked}`);
    if (linked) assert.equal(asList(vm.json('NS.Chats.Active()').pending).some(p => p.paste), false, 'sends go to the app as before');
    else {
      assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 0, 'with no app and no Copy and Paste yet, nothing is left waiting');
      assert.equal(vm.strip(), null, 'and nothing is drawn');
    }
  }
});

test('an old inbox from an app that has quit turns on no check-ins: nothing waits and nothing is drawn', () => {
  const inbox = `NQA_Inbox = { v = 2, ts = "x", now = time() - 3600, token = "someoneelse", bridge = { ver = "1.4.6", push = 1, caps = { "state", "evt" } }, records = {} }`;
  const vm = newVM({ linked: false, inbox }).login().advance(4);
  assert.equal(vm.evaluate('NQADB.linked'), null);
  vm.run('STUB.FireEvent("PLAYER_LEVEL_UP", 8)');
  vm.advance(10);
  assert.equal(vm.strip(), null);
  for (const c of asList(vm.json('NQADB.chats'))) assert.equal(asList(c.pending).length, 0, c.name);
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

// [C-130] A reply of about 1,200 characters, as an AI's Copy button gives one.
const LONG = (() => {
  let t = '';
  while (t.length < 1150) t += 'Head south from Sentinel Hill and follow the road to the farms, then turn in at the Hill. ';
  return `${t.slice(0, 1150)}\nTL;DR: the Hill, then the farms.`;
})();

test('a pasted reply fed in one character per OnTextChanged is read once, whole, after the box is still (C-130)', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.run('NS.Paste.Close(); NS.Paste.Open()');
  const before = vm.num('#NS.Chats.Active().history');
  assert.ok(LONG.length >= 1180, `a long reply (${LONG.length})`);
  vm.run(`local s = ${lstr(LONG)}
    for i = 1, #s do
      NQAPasteIn:SetText(NQAPasteIn:GetText() .. s:sub(i, i))
      NQAPasteIn.scripts.OnTextChanged(NQAPasteIn, true)
      if i % 100 == 0 then STUB.Advance(0.1) end
    end`);
  assert.equal(vm.evaluate('NQAPasteIn:GetText()'), LONG, 'every character stays in the box');
  vm.advance(0.25);
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 1, 'not read while it still arrives');
  vm.advance(0.1);
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 0, 'read once the box is still');
  assert.equal(vm.lastHistory().role, 'assistant');
  assert.equal(vm.lastHistory().summary, 'the Hill, then the farms.');
  assert.equal(vm.num('#NS.Chats.Active().history'), before + 1, 'one reply, read once');
  assert.equal(vm.evaluate('NQAPaste:IsShown()'), 'false');
  vm.advance(5);
  assert.equal(vm.num('#NS.Chats.Active().history'), before + 1, 'no second read');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});

test('the same reply pasted whole is read once, a moment after it lands (C-130)', () => {
  const vm = fresh();
  vm.send('What next?');
  vm.run('NS.Paste.Close(); NS.Paste.Open()');
  const before = vm.num('#NS.Chats.Active().history');
  vm.run(`NQAPasteIn:SetText(${lstr(LONG)}); NQAPasteIn.scripts.OnTextChanged(NQAPasteIn, true)`);
  vm.advance(0.35);
  assert.equal(asList(vm.json('NS.Chats.Active()').pending).length, 0, 'read');
  assert.equal(vm.lastHistory().summary, 'the Hill, then the farms.');
  assert.equal(vm.num('#NS.Chats.Active().history'), before + 1, 'one reply');
  vm.advance(5);
  assert.equal(vm.num('#NS.Chats.Active().history'), before + 1, 'no second read');
});

test('a key typed in step 1 is put back and the window says why (C-135); the AI is asked for about 1,200 characters (C-134)', () => {
  const vm = fresh();
  vm.send('What next?');
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  vm.run('NQAPasteOut:SetText(NQAPasteOut:GetText() .. "w"); NQAPasteOut.scripts.OnTextChanged(NQAPasteOut, true)');
  assert.equal(vm.evaluate('NQAPasteOut:GetText()'), msg, 'the message stays whole');
  assert.ok(vm.list('STUB.texts').includes('This box holds your message to copy. Press Esc to play; Paste Reply in the HUD brings it back.'));
  assert.match(msg, /Keep it under about 1,200 characters and plain, with no tables or images\./);
});

test('a stop note never says how far or how close the stop is: the instructions ask for none, and a pasted route loses such words as the app\'s does (the same list, the same answers)', () => {
  const vm = fresh();
  const notes = require('./fixtures/stop-notes.json');
  assert.deepEqual(vm.json('NS.Paste.DISTANCE_CLAIMS'), protocol.DISTANCE_CLAIMS, 'one list');
  const all = [notes.recording[0], ...notes.keep, ...notes.drop.map(d => d[0]), ...notes.mixed.map(d => d[0]),
    '', '(closest) hand in', 'odd ((nested (closest) parens))', 'x. y! closest? z', ' — ', 'Wow!! Nearest one?! Then loot.', "'Closest' stop, 'kill' them.",
    'Pay $5 (right here, $1 off).', 'Grab the “closest” crate, right here—then go.'];
  for (const s of all) assert.equal(vm.evaluate(`NS.Paste.DropDistanceClaims(${lstr(s)})`), protocol.dropDistanceClaims(s), s);
  assert.equal(vm.evaluate(`NS.Paste.DropDistanceClaims(${lstr(notes.recording[0])})`), 'Hand in the head.');
  // The message asks the AI for notes that say what to do, not how far.
  vm.send('Route me through the Barrens');
  const msg = vm.evaluate('NQAPasteOut:GetText()');
  assert.ok(msg.includes('"note" says what to do at the stop, never how far or how close it is or that it\'s the nearest: the game shows the live distance.'), 'the rule');
  // A reply whose stops make the claims anyway: the commands are the app's, and the HUD's stop has
  // what's left of its note.
  const route = { op: 'set', layer: 'barrens', title: 'Barrens quests', ordered: true, points: [
    { m: 1413, x: 52.1, y: 31.6, label: '1. Hezrul Bloodmark turn-in', kind: 'turnin', note: notes.recording[0] },
    { m: 1413, x: 49.3, y: 33.8, label: '2. Oozes', kind: 'kill', note: 'Closest stop, a few steps from you.', q: [1180] },
    { m: 1413, x: 51.5, y: 30.3, label: '3. The Crossroads', kind: 'turnin', note: 'West of the Crossroads.', q: [870] },
    { m: 1413, x: 50.2, y: 32.9, label: '4. Boars', kind: 'kill', note: 'Kill 8 boars 20yd away, then rest.' }] };
  const reply = `Route drawn.\n\n\`\`\`wowmap\n${JSON.stringify(route)}\n\`\`\`\n\nTL;DR: Hezrul first.`;
  assert.deepEqual(asList(commands(vm, reply)), renderReply(reply).mapCommands.map(c => protocol.validateMapCommand(c) || false));
  vm.run(`NQAPasteIn:SetText(${lstr(reply)})`);
  vm.run('NQAPasteIn:GetScript("OnTextChanged")(NQAPasteIn, true)');
  vm.advance(0.3);
  const points = vm.json('NQAMapDB.map').layers[0].points;
  assert.deepEqual(points.map(p => p[5]), ['Hand in the head.', '', 'West of the Crossroads.', 'Kill 8 boars, then rest.'], 'a note left with nothing is no note; an instruction stays');
  assert.equal(vm.evaluate('NS.MapShared.navView.label'), '1. Hezrul Bloodmark turn-in');
  assert.equal(vm.evaluate('NS.MapShared.navView.note'), 'Hand in the head.', 'what the HUD shows under the live distance');
  assert.deepEqual(vm.list('STUB.forbidden'), []);
});
