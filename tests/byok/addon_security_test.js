'use strict';
// Security (the consolidation plan's commit 2, B-1 to B-5): text
// shaped like a provider's API key (KY-10), with
// invisible characters pasted in too (L5-2), is refused before any command runs
// and before it reaches history, a draft, a chat's name or the wire, and the box
// it came from is cleared; a key saved as a draft before the fix is dropped at
// load (L1-1); asking about your target when it's yourself says "myself" (L5-3).
// Run on a slot with none of the new caps (its provider part failed, or an app
// from before them) and on the app's full slot: the same refusal either way.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { newVM, reloadVM, lstr, ADDON } = require('../helpers/nqa-vm');
const { PUBLIC, ring, byokSlot, confirmHello, apply } = require('../helpers/byok-slots');
const HAVE_JIT = spawnSync('luajit', ['-v'], { encoding: 'utf8' }).status === 0;

const notice = vm => vm.evaluate('(NS.R.notices[NQADB.activeChat] or {}).text');
const activeId = vm => vm.evaluate('NQADB.activeChat');
const type = (vm, text) => vm.run(`NS.UI.ui.input:SetText(${lstr(text)}); NS.UI.SendFromInput()`);
const sentText = (vm, t) => vm.outboxWires().some(e => e.wire.endsWith('\x1f' + t) || e.wire.includes('\x1d' + t));
// A slot with none of the new caps.
const capless = (opts = {}) => confirmHello(newVM(opts).login());
// The app's slot, on an install it made.
function byok(opts = {}) {
  const vm = confirmHello(newVM({ ...opts, extra: PUBLIC + (opts.extra || '') }).login());
  apply(vm, byokSlot());
  return vm;
}
// The bridge's own refusal, word for word, as one string (bones-ux-writer round 2, UX-W08).
const REFUSED = 'That looks like an API key, so it wasn\'t sent. Keys go in the NeverQuestAlone app, never in game.';

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

for (const [build, make, words] of [['a slot with none of the new caps', capless, REFUSED], ['the app\'s slot', byok, REFUSED]]) {
  test(`KY-10 (${build}): text shaped like an API key is refused before history: nothing saved, nothing in the outbox, the box and the draft cleared`, () => {
    const vm = make();
    vm.slash('');
    const id = activeId(vm);
    const n0 = vm.outboxWires().length;
    for (const key of KEYS) {
      const before = vm.history().length;
      type(vm, `here is my key ${key} thanks`);
      assert.equal(vm.history().length, before, key);
      assert.equal(vm.outboxWires().length, n0, key);
      assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '', 'the box is cleared');
      assert.equal(notice(vm), words);
    }
    // Switching chats saves no draft of it.
    vm.run(`NS.UI.ui.input:SetText(${lstr(KEYS[0])}); NS.UI.SendFromInput()`);
    vm.slash('new Other');
    vm.run(`NS.Chats.Switch("${id}")`);
    assert.equal(vm.evaluate(`NS.Chats.Find("${id}").draft`), null);
    assert.ok(!vm.saved().includes('CANARY'), 'nowhere in the saved data');
    // The HUD's box (main's H.SubmitAsk) and /nqa <text> with the window closed.
    vm.slash('');
    vm.run('NS.HUD.OpenReply(NS.Chats.Active())');
    vm.run(`local b = NS.HUD.h.replyBox; b:SetText(${lstr(KEYS[1])}); NS.HUD.SubmitAsk()`);
    assert.equal(vm.evaluate('NS.HUD.h.replyBox:GetText()'), '', 'the HUD box is cleared');
    vm.slash(`my key is ${KEYS[2]}`);
    assert.equal(vm.list('STUB.errors').at(-1), `error: ${words}`);
    vm.reply(KEYS[3]);
    assert.equal(vm.outboxWires().length, n0);
    assert.ok(!vm.saved().includes('CANARY'));
    // Ordinary words that start like one go through.
    for (const t of ['sk-8 is my guild rank', 'risk-assessment-for-the-whole-guild-raid-tonight-please', 'AIza is a name', 'xai-ish', 'task-proj-abcdefghijklmnopqrstuvwxyz']) {
      vm.send(t);
      assert.ok(sentText(vm, t), t);
    }
  });

  test(`KY-10 (${build}): no command keeps key-shaped text: /nqa rename|new|chat <key>, a typed /<key>, the rename dialog and the HUD's box refuse it before anything runs`, () => {
    const vm = make({ db: 'NQADB = { hudIntro = true }' });
    vm.slash('');
    const id = activeId(vm);
    const key = 'sk-or-v1-' + '0123456789abcdef'.repeat(4);
    const n = vm.outboxWires().length;
    for (const cmd of [`rename ${key}`, `new ${key}`, `chat ${key}`, `model ${key}`, key]) {
      vm.run('NS.R.notices[NQADB.activeChat] = nil');
      vm.slash(cmd);
      assert.equal(notice(vm), words, cmd.slice(0, 12));
    }
    for (const typed of [`/nqa rename ${key}`, `/${key}`, `/br ${key}`]) {
      vm.run('NS.R.notices[NQADB.activeChat] = nil');
      type(vm, typed);
      assert.equal(notice(vm), words, typed.slice(0, 12));
      assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '', 'the box is cleared');
    }
    vm.run(`NS.Chats.Rename("${id}", ${lstr(key)})`);
    assert.equal(notice(vm), words, 'the rename dialog');
    assert.equal(vm.outboxWires().length, n, 'nothing sent');
    assert.equal(vm.num('#NQADB.chats'), 1, 'no chat named after it');
    // With the window closed: the game's error line, from /nqa and from the HUD's box.
    vm.slash('');
    vm.slash(`rename ${key}`);
    assert.equal(vm.list('STUB.errors').at(-1), `error: ${words}`);
    vm.run('NS.HUD.OpenReply(NS.Chats.Active())');
    vm.run(`table.insert(STUB.errors, "-"); local b = NS.HUD.h.replyBox; b:SetText(${lstr('/nqa rename ' + key)}); NS.HUD.SubmitAsk()`);
    assert.equal(vm.list('STUB.errors').at(-1), `error: ${words}`);
    assert.equal(vm.evaluate('NS.HUD.h.replyBox:GetText()'), '');
    assert.equal(vm.outboxWires().length, n);
    assert.ok(!vm.saved().includes('0123456789abcdef0123'), 'nowhere in the saved data');
  });
}

// ---------------------------------------------------------------- KY-10: the bridge's own key check

// The corpus of tests/byok/keycheck_test.mjs, and the review's samples: shorter
// tails, and a boundary that is only "no letter or digit right before it". The
// addon's block must be exactly keycheck.mjs's luaKeyCheckSource() and agree with
// its looksLikeKey().
const fill = n => 'x'.repeat(n);
const CANARY = {
  anthropic: 'sk-ant-api03-CANARY' + fill(80), openai: 'sk-proj-CANARY' + fill(60) + 'T3BlbkFJ' + fill(20),
  openaiLegacy: 'sk-CANARY' + fill(39), google: 'AIzaCANARY' + fill(29), googleAuth: 'AQ.CANARY7' + fill(39),
  xai: 'xai-CANARY7' + fill(75), openrouter: 'sk-or-v1-CANARY' + fill(58), // AQ. and xai- with a digit, as real ones (keycheck GLUED_SHAPES)
};
// KB-02, KA-02: a key pasted straight after a word or a digit, with no space (keycheck_test.mjs's GLUED).
const TAIL = 'CANARY' + 'aB3'.repeat(25);
const GLUED = [
  `my key is${CANARY.anthropic}`, `key2${CANARY.openai}`, `apikey${CANARY.openrouter}`, `mykey${CANARY.xai}`, `gkey${CANARY.google}`,
  `token${CANARY.googleAuth}`, `key1sk-proj-${TAIL}`, `adminsk-svcacct-${TAIL}`, `adminsk-admin-${TAIL}`, `mykeysk-ant-admin01-${TAIL}`,
  `mykeysk-ant-oat01-${TAIL}`, `abcsk-or-v1-${'0123456789abcdef'.repeat(4)}`, `xAIzaSy${'CANARYaB3'.repeat(3)}012345`,
];
const KEY_POSITIVE = [
  ...Object.values(CANARY), ...GLUED,
  `my key is ${CANARY.anthropic}, right?`, `(${CANARY.openai})`, `"${CANARY.google}"`, `key=${CANARY.xai}`, `${CANARY.openrouter}\n`,
  'sk-ant-admin01-abcdefghijklmnop', 'sk-svcacct-ABCDEFGHIJ1234', 'sk-admin-ABCDEFGHIJ1234',
  'sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD', 'AIzaFAKE-not-a-real-google-key-00000000', 'AQ.Ab8RN6abcdefghijklmnopqrstuv', // gitleaks:allow (made-up keys: the detector's cases)
  'xai-abcdefghijklmnopqrstuvwxyz', 'sk-or-v1-0123456789abcdef0123456789abcdef', '_sk-ant-api03-abcdefghijklmn',
  'sk-proj-abcdefghijklmno', 'sk-abcdefghijklmnopqrstuvwx12', 'key_sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
  'x.sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-api03-abcdefghijklmnopq',
  // code health BR-08: OpenAI's keys made outside a project and Groq's, bounded and glued.
  `sk-None-${'aB3dE5fG7h'.repeat(5)}Kq`, `gsk_${'aB3dE5fG7h'.repeat(5)}Kq`, `key2sk-None-${'aB3dE5fG7h'.repeat(5)}Kq`, `apikeygsk_${'aB3dE5fG7h'.repeat(5)}Kq`,
];
const KEY_NEGATIVE = [
  '', 'hello there, where is the Deadmines?', 'what does sk-ant mean?', 'sk-ant-short',
  'the task-managementframeworkthingamajig is fine', 'desk-ant-api03-abcdefghijklmnopqrstuv', 'risk-abcdefghijklmnopqrstuvwxyz0123',
  'AIza is a prefix', 'AIzaSyShort', 'AQ.quest', 'xai-short', 'sk-or- is OpenRouter', 'Kill 10 Defias Pillagers (sk-5)', 'I sold 20 sk-items',
  'sk-this-is-a-very-long-hyphenated-sentence-fragment', 'sk-8 is my guild rank', 'task-proj-abcdefghijklmnopqrstuvwxyz',
  // Words that end like a key's prefix begins, glued to what follows (keycheck_test.mjs): under a
  // real key's length, or as long but with no digit after a prefix that ends ordinary words.
  'brisk-admin-panel-open-now-please-thanks', 'risk-proj-plan-for-the-raid-tonight-ok', 'whisk-proj-thing is done',
  'desk-ant-colony-members-are-many-here', 'the task-admin-dashboard is down for the whole guild raid tonight sorry',
  'desk-or-countertop-and-a-chair', 'the maxai-bot said hi', 'FAQ.readme first',
  'the task-admin-panel-settings-page-is-broken-again-for-everyone-in-the-guild',
  'see https://example.com/guides/task-proj-management-for-raid-leaders-and-officers-guide',
  'FAQ.pleasereadthefaqbeforeaskingquestionsinguildchat', 'maxai-bot_says_hello_to_everyone_in_the_guild_today_ok',
  'adminsk-svcacct-pleasereadthefaqbeforeaskingquestionsinguildchat',
  'sk-None of these work', 'gsk_short', 'abcsk-None-pleasereadthefaqbeforeaskingquestionsinguildchat',
];
const KEY_SAMPLES = [...KEY_POSITIVE.map(s => [s, true]), ...KEY_NEGATIVE.map(s => [s, false])];
// The generated block in Chats.lua, from its first line to the refusal's words.
function keyBlock() {
  const src = fs.readFileSync(path.join(ADDON, 'Chats.lua'), 'utf8');
  const start = src.indexOf('-- KY-10: generated from bridge/byok/security/keycheck.mjs');
  const end = src.indexOf('C.KEY_REFUSED = ', start);
  assert.ok(start > 0 && end > start, 'the generated block is in Chats.lua');
  return src.slice(start, end);
}

test('KY-10: the addon\'s key check is the bridge\'s: every sample of its corpus and the review\'s comes out the same (fengari)', () => {
  const vm = newVM().login();
  for (const [s, want] of KEY_SAMPLES) {
    assert.equal(vm.evaluate(`NS.Chats.LooksLikeKey(${lstr(s)})`), String(want), `${want ? 'should flag' : 'should pass'}: ${s.slice(0, 40)}`);
  }
  assert.equal(vm.evaluate('NS.Chats.LooksLikeKey(nil)'), 'false');
  assert.equal(vm.evaluate('NS.Chats.LooksLikeKey(42)'), 'false');
});

test('KY-10: the same verdicts in real Lua 5.1 (LuaJIT)', { skip: HAVE_JIT ? false : 'luajit is not installed (brew install luajit)' }, () => {
  const prog = `local C = {}\n${keyBlock()}\n` + KEY_SAMPLES.map(([s]) => `io.write(C.LooksLikeKey(${lstr(s)}) and "1" or "0")`).join('\n') + '\n';
  const r = spawnSync('luajit', ['-'], { input: prog, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, KEY_SAMPLES.map(([, want]) => (want ? '1' : '0')).join(''));
});

const KEYCHECK = path.join(__dirname, '..', '..', 'bridge', 'byok', 'security', 'keycheck.mjs');
test('KY-10: Chats.lua carries keycheck.mjs\'s generated Lua exactly, and the JS agrees on the corpus', { skip: fs.existsSync(KEYCHECK) ? false : 'no bridge/byok/security/keycheck.mjs here' }, async () => {
  const { luaKeyCheckSource, looksLikeKey } = await import(pathToFileURL(KEYCHECK).href); // a file URL: a Windows path isn't one
  assert.equal(keyBlock(), luaKeyCheckSource({ assign: 'C.LooksLikeKey' }), 'regenerate: node -e "import(\'./bridge/byok/security/keycheck.mjs\').then(m => console.log(m.luaKeyCheckSource({ assign: \'C.LooksLikeKey\' })))"');
  for (const [s, want] of KEY_SAMPLES) assert.equal(looksLikeKey(s), want, s.slice(0, 40));
});

// The second generated block (KA-02, KA-04): C.Visible, C.StripEscapes and C.KeyShaped, made by
// sanitize.mjs's luaKeyShapedSource() with the bridge's typedLooksLikeKey (runtime_sanitize_test
// compares their verdicts in fengari and LuaJIT).
const SANITIZE = path.join(__dirname, '..', '..', 'bridge', 'byok', 'runtime', 'sanitize.mjs');
test('KY-10: Chats.lua carries sanitize.mjs\'s generated C.Visible, C.StripEscapes and C.KeyShaped exactly', { skip: fs.existsSync(SANITIZE) ? false : 'no bridge/byok/runtime/sanitize.mjs here' }, async () => {
  const { luaKeyShapedSource } = await import(pathToFileURL(SANITIZE).href); // a file URL: a Windows path isn't one
  const want = luaKeyShapedSource();
  const src = fs.readFileSync(path.join(ADDON, 'Chats.lua'), 'utf8');
  const start = src.indexOf('-- KY-10: generated from bridge/byok/runtime/sanitize.mjs');
  assert.ok(start > 0, 'the generated block is in Chats.lua');
  assert.equal(src.slice(start, start + want.length), want, 'regenerate: node -e "import(\'./bridge/byok/runtime/sanitize.mjs\').then(m => process.stdout.write(m.luaKeyShapedSource()))"');
});

// What can hide a key typed into the window (KB-02, KA-02, KA-04): glued to a word or a digit, a
// hidden character inside it, a no-break space where its dash was, right after an item link. Each
// is refused before history on either slot; ordinary words still go.
const KY_KEY = 'sk-ant-api03-CANARY' + 'x'.repeat(80);
const KY_SHORT = 'sk-ant-api03-CANARYshortxxxxxxx';
const KY_LINK = '|cffa335ee|Hitem:19019::::::::60:::::|h[Thunderfury]|h|r';
const KY_HIDING = [
  ['glued to a word', `my key is${KY_KEY}`],
  ['glued to a digit', `2${KY_KEY}`],
  ['U+2066 inside', KY_KEY.slice(0, 12) + String.fromCodePoint(0x2066) + KY_KEY.slice(12)],
  ['U+FE0F inside', KY_KEY.slice(0, 12) + String.fromCodePoint(0xfe0f) + KY_KEY.slice(12)],
  ['U+E0020 inside', KY_KEY.slice(0, 12) + String.fromCodePoint(0xe0020) + KY_KEY.slice(12)],
  ['a no-break space for the dash', 'sk-ant-api03' + String.fromCodePoint(0xa0) + KY_KEY.slice(13)],
  ['right after an item link', KY_LINK + KY_SHORT],
];
for (const [build, make] of [['a slot with none of the new caps', capless], ['the app\'s slot', byok]]) {
  test(`KY-10 (${build}): a key glued to a word, with a hidden character or a no-break space in it, or after an item link, is refused before history; ordinary words still go`, () => {
    const vm = make();
    vm.slash('');
    const n0 = vm.outboxWires().length;
    for (const [name, text] of KY_HIDING) {
      const before = vm.history().length;
      type(vm, text);
      assert.equal(vm.history().length, before, name);
      assert.equal(vm.outboxWires().length, n0, name);
      assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '', `${name}: the box is cleared`);
    }
    assert.ok(!vm.saved().includes('CANARY'), 'nowhere in the saved data');
    for (const t of ['the task-proj-board is down', 'brisk-admin-panel-open-now-please-thanks', `${KY_LINK} is the best`, 'hello' + String.fromCodePoint(0xa0) + 'there',
      'the task-admin-panel-settings-page-is-broken-again-for-everyone-in-the-guild']) {
      const n = vm.outboxWires().length;
      type(vm, t);
      assert.equal(vm.outboxWires().length, n + 1, t);
    }
  });
}

// ---------------------------------------------------------------- L1-1, L5-2, L5-3

test('L1-1: a key left in the box is never kept as a draft: closing (the binding, U.Close) or switching chats clears it and says so; one already saved is dropped at load and never put back', () => {
  const KEY = 'sk-ant-api03-CANARY' + 'x'.repeat(80);
  const box = vm => vm.evaluate('NS.UI.ui.input:GetText()');
  const vm = byok();
  vm.slash('');
  const id = activeId(vm);
  vm.run(`NS.UI.ui.input:SetText(${lstr('my key: ' + KEY)})`);
  vm.run('NS.UI.Close()');
  assert.equal(vm.evaluate('NS.UI.IsOpen()'), 'false');
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").draft`), null, 'no draft');
  assert.equal(box(vm), '', 'the box is empty');
  assert.ok(!vm.saved().includes('CANARY'), 'nowhere in the saved data');
  assert.equal(vm.list('STUB.errors').at(-1), `error: ${REFUSED}`, 'said on the game\'s error line: the window is closing');
  vm.slash('');
  assert.equal(box(vm), '', 'nothing comes back when it opens');
  // The key binding: it opens the window, and closes it again.
  const kb = capless();
  kb.run('NS.UI.OpenAndType()');
  assert.equal(kb.evaluate('NS.UI.IsOpen()'), 'true');
  kb.run(`NS.UI.ui.input:SetText(${lstr(KEY)})`);
  kb.run('NS.UI.OpenAndType()');
  assert.equal(kb.evaluate('NS.UI.IsOpen()'), 'false');
  assert.equal(box(kb), '');
  assert.ok(!kb.saved().includes('CANARY'));
  assert.equal(kb.list('STUB.errors').at(-1), `error: ${REFUSED}`);
  // Switching chats with it in the box: the chat you land on says so, in the window.
  const sw = byok();
  sw.slash('');
  const first = activeId(sw);
  sw.slash('new Other');
  const other = activeId(sw);
  sw.run(`NS.Chats.Switch("${first}")`);
  sw.run(`NS.UI.ui.input:SetText(${lstr('here ' + KEY + ' thanks')})`);
  sw.run(`NS.Chats.Switch("${other}")`);
  assert.equal(activeId(sw), other);
  assert.equal(sw.evaluate(`NS.Chats.Find("${first}").draft`), null);
  assert.equal(box(sw), '');
  assert.equal(notice(sw), REFUSED, 'in the chat you switched to');
  assert.ok(!sw.saved().includes('CANARY'));
  sw.run(`NS.Chats.Switch("${first}")`);
  assert.equal(box(sw), '', 'and not back in the box');
  // An ordinary draft is still kept and comes back.
  sw.run('NS.UI.ui.input:SetText("half a thought")');
  sw.run(`NS.Chats.Switch("${other}")`);
  assert.equal(sw.evaluate(`NS.Chats.Find("${first}").draft`), 'half a thought');
  sw.run(`NS.Chats.Switch("${first}")`);
  assert.equal(box(sw), 'half a thought');
  // One saved before this fix: dropped at load, never put back in the box.
  const old = capless({ db: `NQADB = { chats = { { id = "c0a0b0c", name = "Chat 1", history = {}, draft = ${lstr(KEY)} }, { id = "c0a0b0d", name = "Two", history = {}, draft = "keep me" } }, activeChat = "c0a0b0d" }` });
  assert.ok(!old.saved().includes('CANARY'), 'gone from the saved data at load');
  // An ordinary one is kept: back in the box at login, as drafts now come through a reload.
  assert.equal(box(old), 'keep me');
  old.run('NS.Chats.Find("c0a0b0c").draft = ' + lstr(KEY));
  old.slash('');
  old.run('NS.Chats.Switch("c0a0b0c")');
  assert.equal(box(old), '', 'RestoreDraft never puts one back');
});

test('L5-2: a key with invisible characters pasted in (zero-width, word joiner, soft hyphen, BOM) is still refused before history, and never becomes a chat\'s name', () => {
  const vm = capless();
  vm.slash('');
  const id = activeId(vm);
  const KEY = 'sk-ant-api03-CANARY' + 'x'.repeat(60);
  for (const inv of ['​', '‌', '‍', '‎', '‏', '⁠', '⁣', '­', '﻿']) {
    const text = 'my key ' + KEY.slice(0, 12) + inv + KEY.slice(12, 30) + inv + KEY.slice(30);
    assert.equal(vm.evaluate(`NS.Chats.LooksLikeKey(${lstr(text)})`), 'false', 'the case: the shape check alone misses it');
    const before = vm.history().length;
    type(vm, text);
    assert.equal(vm.history().length, before, JSON.stringify(inv));
    assert.equal(vm.outboxWires().length, 0, JSON.stringify(inv));
    assert.equal(vm.evaluate('NS.UI.ui.input:GetText()'), '');
    assert.equal(notice(vm), REFUSED);
  }
  vm.run(`NS.Chats.Rename("${id}", ${lstr(KEY.slice(0, 14) + '​' + KEY.slice(14))})`);
  assert.equal(vm.evaluate(`NS.Chats.Find("${id}").name`), 'Chat 1');
  assert.ok(!vm.saved().includes('CANARY'));
  vm.send('sk-8 is my ​ guild rank');
  assert.equal(vm.outboxWires().length, 1, 'words with an invisible character in them still go');
});

test('L5-2: every invisible character the bridge strips (bidi controls, variation selectors, U+034F, U+180E, a tag) is out here too, keys being ASCII: refused before history, the outbox and the saved data; words with accents still go', async () => {
  const { typedLooksLikeKey } = await import(pathToFileURL(path.join(__dirname, '..', '..', 'bridge', 'byok', 'runtime', 'sanitize.mjs')).href);
  const KEY = 'sk-ant-api03-CANARYabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH';
  for (const [vm, refused] of [[capless(), REFUSED], [byok(), REFUSED]]) {
    vm.slash('');
    for (const inv of ['\u202c', '\u2066', '\u200e\u202a', '\ufe0f', '\u034f', '\u180e', '\u061c', '\u{e0041}', '\u3164']) {
      const text = KEY.slice(0, 9) + inv + KEY.slice(9);
      assert.equal(typedLooksLikeKey(text), true, `the bridge calls it a key: ${JSON.stringify(inv)}`);
      assert.equal(vm.evaluate(`NS.Chats.KeyShaped(${lstr(text)})`), 'true', JSON.stringify(inv));
      const before = vm.history().length;
      type(vm, text);
      assert.equal(vm.history().length, before, JSON.stringify(inv));
      assert.equal(notice(vm), refused);
    }
    assert.equal(vm.outboxWires().length, 0);
    assert.ok(!vm.saved().includes('CANARY'), 'nothing saved');
    vm.send('Grüße aus Sturmwind: où est le maître d\'armes?');
    assert.equal(vm.outboxWires().length, 1, 'accented words go');
  }
  // The same strip in real Lua 5.1.
  if (HAVE_JIT) {
    const r = spawnSync('luajit', ['-'], { input: `io.write(((${lstr(KEY.slice(0, 9) + '\u202c' + KEY.slice(9))}):gsub("[\\128-\\255]", "")))`, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, KEY);
  }
});

test('L5-3: asking about your target when it\'s yourself says "myself", never your character\'s name (either slot)', () => {
  const SELF = `
function UnitExists(u) return u == "target" end
function UnitIsUnit(a, b) return a == "target" and b == "player" end
local realName = UnitName
function UnitName(u) if u == "target" then return "Testchar" end return realName(u) end
function UnitIsPlayer(u) return true end
function UnitReaction(a, b) return 5 end
`;
  for (const vm of [capless({ extra: SELF }), byok({ extra: SELF })]) {
    assert.equal(vm.evaluate('NeverQuestAlone.QuickAsk("target")'), 'true');
    const wire = vm.outboxWires().at(-1).wire;
    assert.ok(wire.includes('What do you know about my target: myself ('), wire);
    assert.ok(!wire.includes('my target: Testchar'), 'not the character\'s name');
  }
});
