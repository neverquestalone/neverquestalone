// What NeverQuestAlone promises players and Blizzard's UI Add-On Development Policy, held in code
// (the trust and compliance plan, item 8; the owner, 2026-10-03). Each test reads the source the
// release builds from, so a change that breaks a promise fails CI before it can ship:
// - the addon never acts for the player: no chat or addon messages, no casting, targeting, movement,
//   key bindings, macros or loaded code, and no ad or donation asks;
// - the app, the bridge and the capture helpers never press a key or move the mouse, and the helpers
//   have no network code;
// - screen reading reads a band at the top-left of the game window: about 300 points tall, as wide
//   as one strip row, never past the window;
// - a public build keeps no pictures: the Mac helper refuses a probe (the flag and the socket
//   command alike), the bridge never asks for one, and the Windows helper writes only its text log.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const list = (dir, re) => (exists(dir) ? fs.readdirSync(path.join(ROOT, dir), { recursive: true }) : [])
  .map(f => path.join(dir, String(f))).filter(f => re.test(f) && !f.includes('node_modules') && fs.statSync(path.join(ROOT, f)).isFile());

/** Lua without its comments (--[[ ]], --[=[ ]=] and -- lines); strings stay, so _G["Name"] still counts. */
const luaCode = s => s.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, ' ').replace(/--[^\n]*/g, ' ');
/** C, Swift and JavaScript without their comments. */
const cCode = s => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1 ');

const ADDON = 'addon/NeverQuestAlone';
const addonFiles = () => list(ADDON, /\.lua$/);

test('the addon never acts for the player: no chat or addon messages, casting, targeting, movement, bindings, macros or loaded code', { skip: !exists(ADDON) && 'no addon in this tree' }, () => {
  const FORBIDDEN = [
    // Sending anything: chat, whispers, emotes, addon messages.
    'SendChatMessage', 'SendAddonMessage', 'SendAddonMessageLogged', 'BNSendWhisper', 'BNSendGameData', 'DoEmote',
    // Acting: casting, using, targeting, fighting, following, interacting.
    'CastSpell', 'CastSpellByName', 'CastSpellByID', 'CastShapeshiftForm', 'UseAction', 'UseItemByName', 'UseContainerItem',
    'TargetUnit', 'TargetNearest', 'TargetNearestEnemy', 'TargetLastTarget', 'AssistUnit', 'AttackTarget', 'StartAttack',
    'FollowUnit', 'InteractUnit',
    // Moving.
    'MoveForwardStart', 'MoveBackwardStart', 'StrafeLeftStart', 'StrafeRightStart', 'TurnLeftStart', 'TurnRightStart',
    'JumpOrAscendStart', 'ToggleAutoRun', 'ToggleRun', 'CameraOrSelectOrMoveStart',
    // Bindings, macros, secure buttons and code loaded at run time.
    'SetBinding', 'SetBindingClick', 'SetBindingSpell', 'SetBindingItem', 'SetBindingMacro', 'CreateMacro', 'EditMacro',
    'RunMacro', 'RunMacroText', 'RunScript', 'loadstring', 'SecureActionButtonTemplate', 'SecureHandlerBaseTemplate',
  ];
  const re = new RegExp(`\\b(${FORBIDDEN.join('|')})\\b`);
  const hits = [];
  for (const f of addonFiles()) luaCode(read(f)).split('\n').forEach((l, i) => { const m = l.match(re); if (m) hits.push(`${f}:${i + 1} ${m[1]}`); });
  assert.deepEqual(hits, [], 'Blizzard\'s add-on policy and the promise on the landing: it never moves, targets, fights or posts to chat for you');
  assert.ok(addonFiles().length > 5, 'the addon\'s files were read');
});

test('the addon asks for no money: no ads, donations or paid features (Blizzard\'s add-on policy)', { skip: !exists(ADDON) && 'no addon in this tree' }, () => {
  const re = /\b(donat\w*|patreon|ko-?fi|buymeacoffee|paypal|venmo|cash ?app|sponsor\w*|subscribe now|premium version)\b/i;
  const hits = [];
  for (const f of [...addonFiles(), ...list(ADDON, /\.toc$/)]) read(f).split('\n').forEach((l, i) => { const m = l.match(re); if (m) hits.push(`${f}:${i + 1} ${m[1]}`); });
  assert.deepEqual(hits, []);
});

test('nothing NeverQuestAlone runs presses a key or moves the mouse, and the capture helpers have no network code', () => {
  const INPUT = /\b(CGEventPost|CGEventCreateKeyboardEvent|CGEventCreateMouseEvent|CGEventCreateScrollWheelEvent|AXUIElementPerformAction|SendInput|keybd_event|mouse_event|SetCursorPos|sendInputEvent|XTestFake\w*|xdotool|robotjs|nut-tree|nutjs)\b/;
  const files = [
    ...list('app/desktop', /\.(mjs|cjs|js)$/).filter(f => !f.includes(`${path.sep}dist${path.sep}`) && !f.includes(`${path.sep}scripts${path.sep}`)),
    ...list('bridge', /\.(mjs|cjs|js|py|swift|c|h)$/),
  ];
  const hits = [];
  for (const f of files) cCode(read(f)).split('\n').forEach((l, i) => { const m = l.match(INPUT); if (m) hits.push(`${f}:${i + 1} ${m[1]}`); });
  assert.deepEqual(hits, [], 'no synthetic input anywhere');
  for (const pkg of ['package.json', 'app/desktop/package.json'].filter(exists)) {
    const deps = Object.keys({ ...JSON.parse(read(pkg)).dependencies });
    assert.deepEqual(deps.filter(d => /robotjs|nut-tree|nutjs|iohook|uiohook|node-key-sender|keysender/i.test(d)), [], `${pkg}: no input library`);
  }
  // The helpers read pixels and print lines; the network is the bridge's alone.
  const NET = /\b(URLSession|NWConnection|NWListener|CFStream\w*|WSAStartup|WinHttp\w*|InternetOpen\w*|getaddrinfo|connect\s*\(\s*sock)\b|import Network\b/;
  for (const f of [...list('bridge/capture/mac/Sources', /\.swift$/), ...list('bridge/capture/windows', /\.(c|h)$/)]) {
    const m = cCode(read(f)).match(NET);
    assert.equal(m, null, `${f}: ${m?.[0]}`);
  }
});

test('screen reading reads only a band at the top-left of the game window: about 300 points tall, one strip row wide, never past the window', { skip: !exists('bridge/capture/mac') && 'no capture helpers in this tree' }, () => {
  // Mac (Capture.swift): the region starts at the window's top-left, is 300 pt tall by default, and is
  // one 200-cell row at the widest pitch wide plus the 32 pt search margin, each clamped to the window;
  // once the strip is measured, also to its own area (fit: one more term in each min, so only narrower).
  const cap = cCode(read('bridge/capture/mac/Sources/NQACapture/Capture.swift'));
  assert.match(cap, /let \(wPt, hPt\) = regionPt\([^)]*\)\s*cfg\.sourceRect = CGRect\(x: 0, y: 0, width: wPt, height: hPt\)/);
  assert.match(cap, /let wPt = min\(regionWidthPt\(scale: scale, opts\), widthPt, fit\.width\)/);
  assert.match(cap, /let hPt = min\(opts\.regionHeightPt, heightPt, fit\.height\)/);
  // A new stream and a region change in place (updateConfiguration) take the one configuration built there.
  assert.equal((cap.match(/SCStreamConfiguration\(\)/g) || []).length, 1, 'one place builds a stream configuration');
  assert.match(cap, /opts\.regionWidthPt \?\? \(Double\(opts\.spec\.cells\) \* opts\.spec\.maxPitch \/ scale \+ 32\)/);
  const opt = cCode(read('bridge/capture/mac/Sources/NQACapture/Options.swift'));
  assert.match(opt, /var regionHeightPt = 300\.0/);
  // A public build refuses any flag that would aim it elsewhere or make it bigger.
  assert.match(opt, /static let aiming = \[[^\]]*"--region-pt"[^\]]*"--probe"[^\]]*\]/);
  // Windows (main.c, decoder.c): 900 x 300 px at the client's top-left, grown only to hold a whole strip
  // at a pitch no wider than the decoder's widest, never past the window's client area.
  const win = cCode(read('bridge/capture/windows/main.c'));
  assert.match(win, /o->width = 900;\s*o->height = 300;/);
  assert.match(win, /w = client\.right < want_w \? client\.right : want_w;\s*h = client\.bottom < want_h \? client\.bottom : want_h;/);
  assert.match(win, /crop\.left = tl\.x;\s*crop\.top = tl\.y;\s*crop\.right = tl\.x \+ w;\s*crop\.bottom = tl\.y \+ h;/);
  const dec = cCode(read('bridge/capture/windows/decoder.c'));
  assert.match(dec, /measured->pitch <= spec->max_pitch \+ 0\.5/, 'a measured pitch can\'t grow the crop past the widest strip');
});

test('a public build keeps no pictures: the Mac helper refuses a probe by flag or by socket command, the bridge never asks, and the Windows helper writes only its text log', { skip: !exists('bridge/capture/mac') && 'no capture helpers in this tree' }, () => {
  const main = read('bridge/capture/mac/Sources/NQACapture/main.swift');
  const handler = main.slice(main.indexOf('out.onCommand = {'), main.indexOf('controller.start()'));
  assert.ok(handler.length > 0, 'the socket command handler');
  // Under NQA_PUBLIC_ID the handler only refuses; the probe call sits in its #else.
  assert.match(handler, /#if NQA_PUBLIC_ID\n[^#]*probe refused: a public build keeps no pictures[^#]*#else\n[\s\S]*controller\.probeNow[\s\S]*#endif\n/);
  assert.equal((handler.match(/probeNow/g) || []).length, 1);
  // probeNow and --probe are the only ways to a PNG; --probe is an aiming flag a public build refuses (above).
  const writers = list('bridge/capture/mac/Sources', /\.swift$/).filter(f => /writePNG\(/.test(cCode(read(f))));
  assert.deepEqual(writers.sort(), ['bridge/capture/mac/Sources/NQACapture/Capture.swift', 'bridge/capture/mac/Sources/NQACapture/Images.swift'].map(p => p.split('/').join(path.sep)).sort(), 'writePNG: defined in Images.swift, called only by the probe in Capture.swift');
  // The bridge has no way to ask for one.
  const bridgeHits = list('bridge', /\.(mjs|js)$/).filter(f => /JSON\.stringify\(\{\s*probe:/.test(read(f)));
  assert.deepEqual(bridgeHits, []);
  // Windows: the only file it opens is its own text log (open_log: to append, or to start over), and no
  // file anywhere in the helper is opened to write (a --test-image PPM is only read).
  const win = cCode(read('bridge/capture/windows/main.c'));
  assert.equal((win.match(/\bCreateFileW\(/g) || []).length, 2, 'the log, opened to append or to start over');
  for (const f of list('bridge/capture/windows', /\.c$/)) {
    const c = cCode(read(f));
    for (const m of c.matchAll(/\b_?w?fopen(?:_s)?\s*\(([^;]*)\)/g)) assert.match(m[1], /"rb?"|L"rb?"/, `${f}: a file opened to write: ${m[0]}`);
    if (!f.endsWith('main.c')) assert.doesNotMatch(c, /\bCreateFile[AW]?\(/, `${f}: opens a file`);
  }
});
