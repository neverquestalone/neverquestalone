// The screenshot mode for the desktop-app UI critic (app/desktop/src/screenshots.mjs): development
// runs only (a packaged app refuses it, with --self-test or without), every state the critic asked
// for is a scene (setup steps 1–8, key empty/saved/invalid/testing, sign-in waiting/done/failed,
// usage with no limit (the default), with a limit the player set, near it and at it, the daily
// spend limit's confirms as previews, connections, last request, privacy, memory, diagnostics, the
// model notice, the runaway fuse's line, one line per §10 kind group), in light and dark, with an
// index of captions; canary keys only. The runner is driven here with a recording driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { screenshotsDir, screenshotsAllowed, scenes, runScenes, indexText, judge, ERROR_GROUPS, STATE_CARDS, THEMES, BUDGETS, SCREEN_OF, TIMER_SCENES, FAKE_KEY, FAKE_BAD_KEY } from '../../app/desktop/src/screenshots.mjs';
import { CANARY_KEYS, canaryNeedles } from './helpers/canary.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');

test('--screenshots <dir>: parsed, and refused in a packaged app, --self-test or not (C3 review)', () => {
  assert.equal(screenshotsDir(['electron', '.']), null);
  assert.equal(screenshotsDir(['electron', '.', '--screenshots', '/tmp/shots']), path.resolve('/tmp/shots'));
  assert.equal(screenshotsDir(['electron', '.', '--screenshots=/tmp/s2']), path.resolve('/tmp/s2'));
  assert.equal(screenshotsDir(['electron', '.', '--screenshots']), '');
  assert.equal(screenshotsDir(['electron', '.', '--screenshots', '--self-test']), '');
  assert.deepEqual(screenshotsAllowed({ packaged: false, selfTest: false, dir: '/tmp/x' }), { ok: true });
  assert.equal(screenshotsAllowed({ packaged: true, selfTest: false, dir: '/tmp/x' }).ok, false);
  assert.equal(screenshotsAllowed({ packaged: true, selfTest: true, dir: '/tmp/x' }).ok, false, 'it answers every confirm yes and writes anywhere');
  assert.match(screenshotsAllowed({ packaged: false, selfTest: false, dir: '' }).reason, /usage/);
  // main.mjs imports this module only in an unpackaged run (it isn't in the package, systems plan
  // Batch 5); a packaged app refuses --screenshots without loading it.
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /if \(!app\.isPackaged\) \{\n\s+shotsKit = await import\('\.\/src\/screenshots\.mjs'\);/);
  assert.match(main, /shotsKit \? shotsKit\.screenshotsAllowed\(\{ packaged: false, dir: SHOTS_DIR \}\) : \{ ok: false, reason: '--screenshots is for development runs; a packaged app refuses it' \}/);
  assert.equal(screenshotsAllowed({ packaged: true, dir: '/tmp/x' }).reason, '--screenshots is for development runs; a packaged app refuses it', 'the same words either way');
  assert.doesNotMatch(main, /^import .*screenshots\.mjs';$/m);
  assert.match(main, /app\.exit\(2\)/);
});

test('every state the critic asked for is a scene, ids unique and file-safe; every §6.1 key result has one; dark only', () => {
  const setupIds = scenes().map(s => s.id);
  for (const kind of ['cancelled', 'clipboard-empty', 'not-a-key', 'mismatch', 'openrouter-key', 'subscription', 'admin', 'mismatch-gemini', 'terms-required', 'auth-invalid', 'out-of-credit', 'out-of-credit-held',
    'spend-limit', 'spend-limit-tier', 'workspace', 'model-access', 'key-restricted', 'org-verification', 'region', 'rate-limited', 'overloaded', 'network', 'keystore', 'read-failed', 'stage-expired', 'busy', 'failed']) {
    assert.ok(setupIds.includes(`setup-s2-${kind}`), kind);
  }
  // Still waiting? shows once rows 1 and 2 are done, so Screen Recording is never its cause.
  for (const cause of ['no-decode', 'minimized', 'blocked', 'no-window']) assert.ok(setupIds.includes(`setup-s4-why-${cause}`), cause);
  assert.equal(scenes().filter(s => /^setup-/.test(s.id) && s.platform === 'win32').length >= 5, true, 'Windows copy through the mock’s platform');
  assert.ok(scenes().filter(s => Array.isArray(s.size)).every(s => s.size[0] === 760 && s.size[1] === 540), 'the narrow shots are 760×540');
  const customSet = scenes().find(s => s.id === 'setup-s2-custom-set');
  assert.deepEqual(customSet.appState, { setup: { v: 2, screen: 'ai', path: 'key', provider: null } });
  const list = scenes();
  const ids = list.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9-]+$/);
  for (const want of [
    // Setup (the redesign's spec §6.1): every screen and state.
    'setup-s2-fresh', 'setup-s2-narrow', 'setup-s2-zoom15', 'setup-s2-zoom3', 'setup-s2-details', 'setup-s2-details-narrow', 'setup-s2-move', 'setup-s2-saved-key', 'setup-s2-engine-error', 'setup-s2-custom-set',
    'setup-s2-grok-hidden', 'setup-s2-hidden-resume', 'setup-s2-checking', 'setup-s2-ok', 'setup-s2-ok-narrow-zoom1', 'setup-s2-gemini-ok', 'setup-s2-returning', 'setup-s2-returning-no-credit', 'setup-s2-rejected-key', 'setup-s2-windows',
    'setup-dialog-connect', 'setup-dialog-replace', 'setup-dialog-switch', 'setup-dialog-use-saved', 'setup-dialog-custom', 'setup-dialog-custom-local',
    'setup-custom-empty', 'setup-custom-details', 'setup-custom-from-openrouter-key', 'setup-custom-ok', 'setup-custom-ok-local', 'setup-custom-https', 'setup-custom-network', 'setup-custom-auth', 'setup-custom-model', 'setup-custom-windows',
    'setup-s4-fresh', 'setup-s4-details', 'setup-s4-narrow', 'setup-s4-wow-open', 'setup-s4-armed', 'setup-s4-waiting', 'setup-s4-no-credit', 'setup-s4-windows',
    'setup-s4-done', 'setup-s4-done-no-quote', 'setup-s4-done-no-login', 'setup-s4-done-windows',
    'home-finish-no-ai', 'home-finish-no-addon', 'home-finish-no-screen',
    'home-in-game', 'home-wow-closed', 'home-paused', 'home-limit',
    'provider-empty', 'provider-saved', 'provider-invalid', 'provider-replace-testing', 'provider-custom', 'provider-custom-form', 'provider-change', 'provider-details', 'provider-model-open',
    'usage-normal', 'usage-limit-open', 'usage-limit-set', 'usage-near-cap', 'usage-cap', 'usage-details',
    'caps-confirm-preview', 'caps-raise-confirm-preview', 'caps-off-confirm-preview', 'caps-saved', 'caps-off', 'notice-fuse',
    'connections', 'last-request', 'settings', 'settings-more', 'privacy', 'diagnostics', 'about', 'uninstall',
    'notice-model-switched', 'notice-model-retired',
    // SY-102-5: a retiring model's notice on Home, and its Use <model> landing on Your AI.
    'notice-model-retiring', 'notice-model-retiring-used',
  ]) assert.ok(ids.includes(want), want);
  for (const id of ['notice-model-retiring', 'notice-model-retiring-used']) {
    const sc = list.find(x => x.id === id);
    assert.equal(sc.state.retiring, true, `${id}: the mock says it from the real manifest, as app-api does`);
    assert.equal(sc.state.choice.model, 'claude-haiku-4-5', id);
  }
  // The screens the redesign removed have no scenes: S1's welcome, Connect <AI>, Check your defaults.
  for (const gone of ids.filter(id => /^setup-(s1|s3)-|^setup-s2-(claude|chatgpt-cost|field)$/.test(id))) assert.fail(gone);
  assert.equal(ERROR_GROUPS.length, 15);
  for (const gone of ids.filter(id => /^setup-(free|local)-|sign-in|mismatch-openrouter/.test(id))) assert.fail(gone);
  for (const [kind] of ERROR_GROUPS) assert.ok(ids.includes(`error-${kind.replace(/_/g, '-')}`), kind);
  assert.deepEqual([...THEMES], ['dark'], 'one theme, dark (the redesign’s spec §1)');
  for (const s of list.filter(x => !/^(setup-|home-finish-)/.test(x.id) && x.id !== 'state-not-running-setup')) assert.equal(s.appState?.onboarded, true, s.id);
  assert.equal(list.find(x => x.id === 'setup-s2-fresh').appState?.onboarded, undefined, 'setup’s scenes start before it');
  for (const s of list) {
    assert.equal(typeof s.caption, 'string');
    assert.ok(s.caption.length > 10);
    assert.equal(typeof s.run, 'function');
  }
});

test('the acceptance checks (spec §8): each screen’s word budget, and judge() turns a scene’s measures into what failed', () => {
  // The app trim: no screen over 45 visible words. Your AI is 45 (it was 77: the model and Thinking are
  // behind Pick a model), step 2 and step 3 45 (55 and 52), Your data 45 (60), Settings 30 (72), Home 35 (50),
  // Last request 30 (40), Connections 30. The pages the trim folded into others have none: Memory, Updates.
  assert.deepEqual({ ...BUDGETS }, { welcome: 45, step2: 45, other: 40, step3: 50, done: 40, home: 35, yourAi: 45, usage: 45, connections: 30, lastRequest: 30, settings: 30, yourData: 45, diagnostics: 45, about: 40, uninstall: 40 });
  assert.ok(Object.values(BUDGETS).every(n => n <= 50), 'no screen over 50 words (the owner’s bar; step 3 carries the in-game steps and Windows’s reading row since 2026-10-05)');
  assert.equal(SCREEN_OF['setup-welcome'], 'welcome');
  assert.equal(SCREEN_OF['page-privacy'], 'yourData');
  const at = (x = {}) => ({ screen: 'step2', mode: 'setup', sheetOpen: false, words: 40, fit: { doc: true, page: true, pageOver: 0 }, overflowX: [], panelClipped: 0, contrast: [], edges: [], faintText: [], primaries: ['Paste Anthropic key'], bonesOnStage: 0, firstPerson: [], size: [1000, 720], ...x });
  const scene = { id: 'setup-s2-fresh' };
  assert.deepEqual(judge(scene, { at: at(), other: at({ size: [760, 540] }), hover: { targets: 9, moves: [] }, reducedMotion: 0, focus: { stops: 12, bad: [], order: true } }), []);
  assert.deepEqual(judge(scene, { at: at({ words: 46 }) }), ['words 46 over 45']);
  assert.deepEqual(judge(scene, { at: at({ sheetOpen: true, words: 200 }) }), [], 'with the sheet open, the screen’s budget doesn’t apply');
  assert.deepEqual(judge(scene, { at: at(), other: at({ size: [760, 540], fit: { doc: true, page: false, pageOver: 28 } }) }), ['setup scrolls at 760×540 (28 px)']);
  assert.deepEqual(judge({ id: 'setup-s2-zoom3', appState: { zoom: 3 } }, { at: at({ fit: { doc: true, page: false, pageOver: 90 } }) }), [], 'zoomed, the stage may scroll');
  assert.deepEqual(judge({ id: 'setup-s2-zoom3', appState: { zoom: 3 } }, { at: at({ overflowX: ['page+4'] }) }), ['sideways at 1000×720: page+4'], 'never sideways');
  assert.deepEqual(judge(scene, { at: at({ primaries: ['A', 'B'] }) }), ['2 primaries: A | B']);
  assert.deepEqual(judge(scene, { at: at({ bonesOnStage: 1 }) }), ['the skull on the stage']);
  assert.deepEqual(judge(scene, { at: at({ classLeak: ['set-tall'] }) }), ['a class name shown as text: set-tall'], 'CL-design-01: a class name that leaked into the text');
  assert.deepEqual(judge(scene, { at: at(), hover: { targets: 3, moves: ['x (2)'] }, timer: 4, reducedMotion: 1, focus: { stops: 3, bad: ['BUTTON|x [none 0px]'], order: false } }),
    ['hover moved: x (2)', '4 boxes changed in 5 s', '1 animations run with reduced motion', 'no focus ring: BUTTON|x [none 0px]', 'tab order isn’t panel, top bar, content']);
  assert.deepEqual(judge({ id: 'home-in-game' }, { at: at({ screen: 'home', words: 36, fit: { doc: true, page: false, pageOver: 300 } }) }), ['words 36 over 35'], 'app pages may scroll in the stage');
  for (const id of TIMER_SCENES) assert.ok(scenes().some(s => s.id === id), id);
  assert.equal(SCREEN_OF['setup-pick'], 'step2');
  const idx = indexText([{ file: '001-a-dark.png', caption: 'A (dark)', words: 44, budget: 50, fails: [] }, { file: '002-b-dark.png', caption: 'B (dark)', words: 60, budget: 50, fails: ['words 60 over 50'] }], { when: new Date(0) });
  assert.match(idx, /001-a-dark\.png\s+A \(dark\)\s+\[words 44\/50\]\n/);
  assert.match(idx, /002-b-dark\.png\s+B \(dark\)\s+\[words 60\/50\] \[CHECK FAILED: words 60 over 50\]\n/);
  const driver = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8'); // the driver (code health AP-15)
  assert.match(driver, /check\.at = |const check = \{ at: await js\(CHECK_JS\) \};/);
  assert.match(driver, /Input\.dispatchMouseEvent', \{ type: 'mouseMoved'/, 'a real mouse move for the hover check');
  assert.match(driver, /Emulation\.setEmulatedMedia', \{ features: \[\{ name: 'prefers-reduced-motion', value: 'reduce' \}\] \}/);
  assert.match(driver, /Input\.dispatchKeyEvent', \{ type: 'rawKeyDown', key: 'Tab'/, 'focus by the keyboard');
  assert.match(driver, /fs\.writeFileSync\(path\.join\(outDir, 'manifest\.json'\)/);
  assert.match(driver, /app\.exit\(failed\.length \|\| failing\.length \? 1 : 0\);/, 'a check that fails fails the run');
});

test('the §10 scenes carry the bridge’s desktop line for each kind (lineFor), falling back to the kind', () => {
  const list = scenes({ lineFor: (k, names) => ({ headline: `HEAD ${k}`, detail: `NEXT ${names.provider ?? ''}`, action: 'x', line: `LINE ${k}` }) });
  const err = list.find(s => s.id === 'error-out-of-credit');
  assert.deepEqual(err.state.results.testKey, { ok: false, error: 'out_of_credit', headline: 'HEAD out_of_credit', detail: 'NEXT ', action: 'x', line: 'LINE out_of_credit' });
  assert.equal(err.state.rt.state, 'out_of_credit');
  assert.equal(list.find(s => s.id === 'error-rate-limited').state.rt.retryIn, 18);
  assert.equal(list.find(s => s.id === 'error-oauth-expired'), undefined, 'no sign-in to end');
  const local = list.find(s => s.id === 'error-local-unreachable');
  assert.equal(local.state.results.testKey.detail, 'NEXT localhost:11434', 'a server on this computer, by its host');
  // D-01: kinds no rt state covers come from the backend's last failure (the real path), never a forced rt.
  const region = list.find(s => s.id === 'error-region-blocked');
  assert.equal(region.state.rt, undefined);
  assert.equal(region.state.lastError.kind, 'region_blocked');
  assert.equal(list.find(s => s.id === 'error-model-not-found').state.notice.kind, 'model_retired');
  const fallback = scenes({ lineFor: () => { throw new Error('x'); } }).find(s => s.id === 'error-timeout');
  assert.equal(fallback.state.results.testKey.line, 'timeout');
});

test('the round-2 states are scenes: a state card for each state, Find WoW with several installs and installed, Done with something skipped, a rejected key that keeps the old one', () => {
  const ids = scenes().map(s => s.id);
  for (const want of [
    'state-not-running', 'state-no-key', 'state-key-invalid', 'state-slowed', 'state-out-of-credit', 'state-cap-spend',
    'state-near-cap', 'state-provider-down', 'state-local-down', 'state-model-retired', 'state-paused',
    'setup-s4-several', 'setup-s4-installed', 'setup-s4-not-found', 'provider-replace-rejected', 'general',
    'setup-s4-others-can-write', 'setup-s4-eperm', 'privacy-retention-saved', 'privacy-openai-regenerate',
  ]) assert.ok(ids.includes(want), want);
  assert.equal(STATE_CARDS.length, 14, 'the one-off notice has no scene: it has no UI (the app trim)');
  for (const id of ['state-repeated-error', 'diagnostics-permissions-fixed', 'diagnostics-permissions-copied', 'diagnostics-permissions-copied-windows', 'diagnostics-permissions-windows-no-sid']) assert.ok(ids.includes(id), id);
  // The app trim: the screens and notices it removed have no scenes.
  for (const gone of ['memory', 'updates', 'provider-keys', 'connections-details', 'general-screen-reading', 'state-one-off-error', 'state-ready-again', 'state-ready-again-credit', 'state-ready-again-local', 'home-finish-usage-banner', 'state-key-invalid-banner', 'setup-s4-sound-off', 'setup-s4-login-item-held', 'setup-s4-fit-iface-login-held', 'setup-s4-fit-no-credit-login-held']) assert.ok(!ids.includes(gone), gone);
  assert.equal(scenes().find(x => x.id === 'diagnostics-permissions-copied-windows').platform, 'win32');
  // The driver (src/screenshots.mjs since code health AP-15) shows main the scene's platform through its hooks.
  const driver = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8');
  assert.match(driver, /show\.platform\(scene\?\.platform \?\? null\);/);
  assert.match(fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8'), /platform: \(p\) => \{ platformShown = p; \},/);
  for (const id of ['state-region-blocked', 'state-identifier-blocked', 'state-spend-limit']) assert.ok(ids.includes(id), id);
  assert.match(driver, /mock\.control\.useLastErrorView\(lastErrorView\)/, 'the bridge’s own lastErrorView');
  assert.match(driver, /mock\.control\.usePlayerText\(/, 'the real manifests’ player text (D-22)');
});

test('no limits of ours in the scenes (the owner, 2026-09-26): no limits step, no typed-message cap; every limit state is one the player set', () => {
  const list = scenes();
  const ids = list.map(s => s.id);
  for (const gone of ['setup-6-cap', 'state-cap-turns']) assert.ok(!ids.includes(gone), gone);
  const src = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8');
  assert.doesNotMatch(src, /cap_turns|typedPerDay|autoPerDay|Set a daily limit|Save limits/);
  // The default has no limit; every scene that shows one sets it, as a player would.
  assert.equal(list.find(s => s.id === 'usage-normal').state.caps, undefined);
  for (const id of ['usage-limit-set', 'usage-near-cap', 'usage-cap', 'caps-raise-confirm-preview', 'caps-off-confirm-preview', 'caps-off', 'state-cap-spend', 'state-near-cap', 'error-cap-spend']) {
    assert.equal(list.find(s => s.id === id).state.caps?.dailyUsd, 1, id);
  }
  assert.equal(list.find(s => s.id === 'notice-fuse').state.fuse, true);
  assert.equal(ERROR_GROUPS.find(g => g[0] === 'cap_spend')[2], 'Your daily spend limit');
});

test('keys in the scenes are canaries: the tests’ shape, caught by the canary scan', () => {
  assert.ok(FAKE_KEY.startsWith(CANARY_KEYS.anthropic.slice(0, 24)));
  const needles = canaryNeedles();
  for (const k of [FAKE_KEY, FAKE_BAD_KEY]) assert.ok(needles.some(n => k.includes(n.needle)), 'a canary needle matches');
  const src = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8');
  assert.doesNotMatch(src.replace(/sk-ant-api03-CANARY/g, ''), /sk-(?:ant|proj|or)-[A-Za-z0-9]{8,}/, 'no other key-shaped text');
});

test('runScenes: each scene in each theme, reset first, captured, cleaned up; a failing scene is reported, the rest still run', async () => {
  const log = [];
  const driver = {
    setTheme: async th => log.push(`theme ${th}`),
    reset: async (state, sc) => log.push(`reset ${sc.id}`),
    capture: async f => log.push(`capture ${f}`),
    afterScene: async () => log.push('after'),
    go: async id => log.push(`run ${id}`),
  };
  const list = [
    { id: 'a', caption: 'A', state: {}, run: d => d.go('a') },
    { id: 'b', caption: 'B', state: {}, run: async () => { throw new Error('no button "X" to click'); } },
  ];
  const shots = await runScenes(driver, list, { themes: ['light', 'dark'] });
  assert.deepEqual(shots.map(s => s.file), ['001-a-light.png', '002-b-light.png', '003-a-dark.png', '004-b-dark.png'], 'the runner still takes any themes it’s given');
  assert.equal(shots[1].error, 'no button "X" to click');
  assert.equal(shots[0].error, undefined);
  assert.deepEqual(log.slice(0, 5), ['theme light', 'reset a', 'run a', 'capture 001-a-light.png', 'after']);
  assert.equal(log.filter(l => l === 'after').length, 4, 'cleanup after every scene, failed or not');
  const idx = indexText(shots, { when: new Date(0), note: 'note' });
  assert.match(idx, /^NeverQuestAlone desktop app: window states \(4 PNGs, 1970-01-01T00:00:00\.000Z\)/);
  assert.match(idx, /001-a-light\.png\s+A \(light\)/);
  assert.match(idx, /002-b-light\.png\s+B \(light\)\s+\[FAILED: no button "X" to click\]/);
});

test('main.mjs: the screenshot mode runs on the controllable mock in a hidden window, answers its own confirms, opens nothing, copies nothing', () => {
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /mock = createMockApi\(\{ controllable: true, delayMs: 0 \}\);/);
  assert.match(main, /const HEADLESS = SELF_TEST \|\| SHOTS;/);
  assert.match(main, /if \(SHOTS\) return shotsConfirm \? shotsConfirm\(spec\) : true;/);
  // The clipboard: never the real one in a headless run; the screenshot mode has its own, which Paste key reads.
  assert.match(main, /clipboard: \{ writeText: t => \{ if \(SHOTS\) shotsClipboard = String\(t\); else if \(!HEADLESS\) clipboard\.writeText\(String\(t\)\); \}, readText: async \(\) => \(SHOTS \? shotsClipboard : HEADLESS \? '' : clipboard\.readText\(\)\) \}/);
  assert.match(main, /if \(HEADLESS\) return \{ ok: true \};/, 'links never open');
  // The driver is src/screenshots.mjs's (code health AP-15): main hands it its window, state and mock,
  // and what a scene shows main's confirm, folder dialog, appInfo, updater and clipboard comes back by
  // the hooks' setters.
  assert.match(main, /if \(SHOTS\) \{\n    return shotsKit\.screenshots\(\{\n/);
  for (const hook of ['confirm: (fn) => { shotsConfirm = fn; }', 'folder: (dir) => { shotsFolder = dir; }', 'apiMode: (mode) => { apiModeShown = mode; }',
    'platform: (p) => { platformShown = p; }', 'info: (facts) => { infoShown = facts; }', 'updater: (status) => { updaterShown = status; }', 'clipboard: (text) => { shotsClipboard = text; }']) {
    assert.ok(main.includes(hook), hook);
  }
  assert.doesNotMatch(main, /capturePage|insertCSS|async function screenshots/, 'no driver left in the shipped file');
  const driver = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8');
  assert.match(driver, /capturePage\(undefined, \{ stayHidden: true \}\)/);
  assert.match(driver, /nativeTheme\.themeSource = theme/);
  assert.match(driver, /export async function screenshots\(hooks\) \{\n  const \{ outDir, argv, app, nativeTheme, openWindow, appState, mock, log, selfTestDir, roots, show \} = hooks;/);
});

test('a call held for a shot is abandoned when its scene ends: it never writes into the next scene', async () => {
  const { createMockApi } = await import('../../app/desktop/src/mock-api.mjs');
  const mock = createMockApi({ delayMs: 0, controllable: true });
  mock.control.reset({});
  mock.control.hold('testStagedKey');
  const pending = mock.testStagedKey('anthropic', () => FAKE_KEY).then(r => (r.ok ? mock.setKey('anthropic', FAKE_KEY) : r));
  await new Promise(r => setImmediate(r)); // "Checking…" is on screen: the call waits at its hold
  mock.control.abandon();
  await assert.rejects(pending, /reset while held/);
  mock.control.reset({});
  assert.deepEqual((await mock.providers()).find(p => p.id === 'anthropic').key, { saved: false });
  const driver = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8');
  assert.match(driver, /after\.push\(\(\) => mock\.control\.abandon\(\)\)/);
});

test('the probe measures the type too (desktop UI critic r3, DU-27, DU-28): weights, size and leading, what’s set bold, the blocks with the most characters on a line; it compiles', async () => {
  const { PROBE_JS } = await import('../../app/desktop/src/shot-probe.mjs');
  assert.doesNotThrow(() => new Function(`return ${PROBE_JS}`), 'the page-side probe parses');
  assert.match(PROBE_JS, /typo: \{ weights, sizeLh, bold: \[\.\.\.bold\]\.slice\(0, 12\), longest: measure\.slice\(0, 6\) \}/);
  assert.match(PROBE_JS, /querySelectorAll\('p, li, blockquote, dd, figcaption'\)/, 'the measure covers the privacy card’s answers and the quote');
});

test('desktop UI critic r3 (DU-05, DU-04): S4’s combinations and the way its key card leaves setup are scenes, so the probe’s slack and primaries guard them', () => {
  const ids = scenes().map(s => s.id);
  for (const id of [
    'setup-s4-fit-no-credit-fresh', 'setup-s4-fit-local-down-fresh', 'setup-s4-fit-rejected-fresh', 'setup-s4-fit-no-credit-several', 'setup-s4-fit-no-credit-eperm',
    'setup-s4-fit-installed-no-reading-open', 'setup-s4-fit-no-credit-installed-no-reading-open', 'setup-s4-fit-local-down-installed-no-reading-open',
    'setup-s4-fit-no-credit-test-failed', 'setup-s4-fit-no-credit-waiting-why', 'setup-s4-fit-narrow-zoom3-no-credit', 'setup-s4-armed-asked', 'setup-your-ai-replace-key',
  ]) assert.ok(ids.includes(id), id);
});

test('the critics’ options (desktop UI critic r2, T-1, T-2): one size, themes, a DOM probe and axe from a local file per state; INDEX.txt says axe per shot; the scenes wait for today’s words', () => {
  const driver = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8'); // the driver (code health AP-15)
  for (const flag of ['--screenshots-size', '--screenshots-themes', '--screenshots-probe', '--screenshots-axe']) assert.ok(driver.includes(`'${flag}'`), flag);
  assert.match(driver, /const \{ PROBE_JS, AXE_RUN_JS \} = PROBE \? await import\('\.\/shot-probe\.mjs'\) : \{\};/, 'the probe loads only when asked for');
  assert.match(driver, /fs\.readFileSync\(path\.resolve\(axeFile\), 'utf8'\)/, 'axe comes from a local file: nothing is downloaded');
  assert.match(driver, /\.fold\.png/, 'the window as the player sees it, before it grows');
  const idx = indexText([
    { file: '001-a-light.png', caption: 'A (light)', axe: [], fits: true },
    { file: '002-b-light.png', caption: 'B (light)', axe: ['region×1'], fits: false, notes: [{ clicks: 1 }] },
    { file: '003-c-light.png', caption: 'C (light)' },
  ], { when: new Date(0) });
  assert.match(idx, /001-a-light\.png\s+A \(light\)\s+\[axe: clean\]\n/);
  assert.match(idx, /002-b-light\.png\s+B \(light\)\s+\[scrolls\] \[axe: region×1\] \[notes: \[\{"clicks":1\}\]\]\n/);
  assert.match(idx, /003-c-light\.png\s+C \(light\)\n/, 'no probe: the line as before');
  // T-1: the six scenes whose waits the copy change had made stale wait for today's words.
  const src = fs.readFileSync(path.join(APP, 'src', 'screenshots.mjs'), 'utf8');
  for (const stale of ['every free model keeps logs', "'owes credit'", "'Canceled. Nothing changed.'", "'Another model'", 'couldn’t write to WoW’s AddOns folder', "'other accounts on this Mac'"]) assert.ok(!src.includes(stale), stale);
  const ids = scenes().map(s => s.id);
  for (const id of ['setup-s4-allow-press-push']) assert.ok(ids.includes(id), id);
});
