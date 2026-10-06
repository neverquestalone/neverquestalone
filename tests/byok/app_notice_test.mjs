// The model check's notice in the window (BYOK PRD §10 "Model not found", PV-3; BUILD-PLAN
// status().backend.notice): shown once, as a plain line with Okay, never a timed toast. The
// main process gives an unseen notice its id and leaves a seen one out of every status the page
// gets (IPC status and the pushes alike); Okay (dismissNotice) keeps the id in app-state.json,
// so it stays gone across restarts, and a new switch shows again. No Electron needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanNotice, noticeId, withNotice, addSeen, lastErrorId, MAX_SEEN, NOTICE_ID } from '../../app/desktop/src/model-notice.mjs';
import { createIpc, createKeyStager, HANDLERS, CONFIRMED } from '../../app/desktop/ipc.mjs';
import { createMockApi } from '../../app/desktop/src/mock-api.mjs';
import { wrapApi } from '../../app/desktop/src/api-loader.mjs';
import { createShellLedger } from '../../app/desktop/src/net-guard.mjs';
import { createAppState } from '../../app/desktop/src/app-state.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
const SWITCHED = { kind: 'model_switched', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: 1790400000000 };
const RETIRED = { kind: 'model_retired', model: 'claude-sonnet-5', at: 1790400000000 };
const RETIRING = { kind: 'model_retiring', model: 'claude-haiku-4-5', after: '2026-10-15', to: 'claude-sonnet-5-5', at: null };
const status = notice => ({ bridge: { running: true }, backend: { rt: { state: 'ready' }, provider: { id: 'anthropic' }, usage: null, ...(notice !== undefined ? { notice } : {}) }, capture: {}, wow: {} });

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bones-notice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('cleanNotice: the two kinds with model ids of the right shape; anything else is no notice', () => {
  assert.deepEqual(cleanNotice(SWITCHED), SWITCHED);
  assert.deepEqual(cleanNotice(RETIRED), RETIRED);
  assert.deepEqual(cleanNotice({ kind: 'model_retired', from: 'gpt-6-sol', at: 5 }), { kind: 'model_retired', model: 'gpt-6-sol', at: 5 }, 'from stands in for model');
  assert.deepEqual(cleanNotice({ kind: 'model_switched', from: 'a', to: 'b' }), { kind: 'model_switched', from: 'a', to: 'b', at: null });
  // The models' names from the bridge pass as plain text (UX-W35); markup, controls or a long name don't.
  assert.deepEqual(cleanNotice({ ...SWITCHED, fromName: 'Claude Sonnet 5', toName: 'Claude Haiku 4.5' }), { ...SWITCHED, fromName: 'Claude Sonnet 5', toName: 'Claude Haiku 4.5' });
  assert.deepEqual(cleanNotice({ ...RETIRED, name: 'Claude Sonnet 5' }), { ...RETIRED, name: 'Claude Sonnet 5' });
  for (const bad of ['<img src=x>', `a${String.fromCharCode(0x202e)}`, 'x'.repeat(61), 7, '']) assert.deepEqual(cleanNotice({ ...SWITCHED, fromName: bad }), SWITCHED, JSON.stringify(bad));
  assert.equal(noticeId({ ...SWITCHED, fromName: 'Claude Sonnet 5' }), noticeId(SWITCHED), 'a name never makes a new notice');
  for (const bad of [null, 'x', [], {}, { kind: 'toast' }, { kind: 'model_switched', from: 'a' }, { kind: 'model_switched', from: '<img src=x>', to: 'b' },
    { kind: 'model_retired' }, { kind: 'model_retired', model: 'x'.repeat(200) }, { kind: 'model_switched', from: `a${String.fromCharCode(0x202e)}`, to: 'b' }]) {
    assert.equal(cleanNotice(bad), null, JSON.stringify(bad));
  }
});

test('noticeId: 16 hex, stable for the same notice, different for a new switch', () => {
  const id = noticeId(SWITCHED);
  assert.match(id, NOTICE_ID);
  assert.equal(noticeId({ ...SWITCHED }), id);
  assert.notEqual(noticeId({ ...SWITCHED, at: SWITCHED.at + 1 }), id, 'the same switch again later is a new notice');
  assert.notEqual(noticeId({ ...SWITCHED, to: 'claude-haiku-5' }), id);
  assert.notEqual(noticeId(RETIRED), id);
  assert.equal(noticeId({ kind: 'nope' }), null);
});

test('withNotice: an unseen notice gets its id; a seen one, or a malformed one, is left out; nothing is mutated', () => {
  const st = status(SWITCHED);
  const frozen = JSON.stringify(st);
  const shown = withNotice(st, []);
  assert.deepEqual(shown.backend.notice, { ...SWITCHED, id: noticeId(SWITCHED) });
  assert.equal(JSON.stringify(st), frozen);
  const seen = withNotice(st, [noticeId(SWITCHED)]);
  assert.equal(Object.hasOwn(seen.backend, 'notice'), false);
  assert.equal(seen.backend.rt.state, 'ready', 'the rest of the status stays');
  assert.equal(Object.hasOwn(withNotice(status({ kind: 'toast', text: '<b>hi</b>' }), []).backend, 'notice'), false);
  assert.equal(withNotice(status(), []).backend.notice, undefined);
  const failure = { ok: false, error: 'bridge_unavailable' };
  assert.equal(withNotice(failure, []), failure, 'a failure passes through');
  // A retired model is a state, not news (D-01, D-05): it stays until a model is chosen.
  const retired = withNotice(status(RETIRED), [noticeId(RETIRED)]);
  assert.deepEqual(retired.backend.notice, { ...RETIRED, id: noticeId(RETIRED) });
});

// SY-102-5: a retiring model in use (the bridge says it from the manifest's retiresAfter and moveTo).
test('a retiring model\'s notice: cleaned like the others, its id over the model, the day and the model offered; Okay puts it away for good', () => {
  assert.deepEqual(cleanNotice(RETIRING), RETIRING);
  assert.deepEqual(cleanNotice({ ...RETIRING, at: 5, name: 'Claude Haiku 4.5', toName: 'Claude Sonnet 5.5', extra: 1 }), { ...RETIRING, name: 'Claude Haiku 4.5', toName: 'Claude Sonnet 5.5' }, 'no time of its own, nothing else carried');
  for (const bad of [{ ...RETIRING, after: 'Oct 15' }, { ...RETIRING, after: undefined }, { ...RETIRING, to: undefined }, { ...RETIRING, to: RETIRING.model }, { ...RETIRING, model: '<img src=x>' }, { ...RETIRING, to: 'x'.repeat(200) }]) {
    assert.equal(cleanNotice(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(cleanNotice({ ...RETIRING, name: '<b>x</b>' }), RETIRING, 'a name that isn\'t plain text is left out');
  const id = noticeId(RETIRING);
  assert.match(id, NOTICE_ID);
  assert.equal(noticeId({ ...RETIRING, name: 'Claude Haiku 4.5', at: 9 }), id, 'its names and any time make no new notice');
  assert.notEqual(noticeId({ ...RETIRING, after: '2026-11-15' }), id, 'a new day shows again');
  assert.notEqual(noticeId({ ...RETIRING, to: 'claude-opus-5-5' }), id);
  // The switch's and the retired card's ids are as they were: a notice put away before stays away.
  assert.equal(noticeId(SWITCHED), 'cbf04294b6433683');
  const shown = withNotice(status(RETIRING), []);
  assert.deepEqual(shown.backend.notice, { ...RETIRING, id });
  assert.equal(Object.hasOwn(withNotice(status(RETIRING), [id]).backend, 'notice'), false, 'news, not a state: Okay keeps it away');
});

test('addSeen: once, newest last, at most 20, ids only', () => {
  let list = [];
  for (let i = 0; i < 25; i++) list = addSeen(list, i.toString(16).padStart(16, '0'));
  assert.equal(list.length, MAX_SEEN);
  assert.equal(list.at(-1), (24).toString(16).padStart(16, '0'));
  assert.deepEqual(addSeen(['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'], 'aaaaaaaaaaaaaaaa'), ['bbbbbbbbbbbbbbbb', 'aaaaaaaaaaaaaaaa']);
  assert.deepEqual(addSeen(['../x', 7, 'aaaaaaaaaaaaaaaa'], 'nope'), ['aaaaaaaaaaaaaaaa']);
});

test('app-state keeps the seen ids across restarts, owner-only', (t) => {
  const dir = tmp(t);
  const a = createAppState(dir);
  assert.deepEqual(a.noticesSeen(), []);
  a.seeNotice(noticeId(SWITCHED));
  a.set({ onboarded: true });
  const b = createAppState(dir);
  assert.deepEqual(b.noticesSeen(), [noticeId(SWITCHED)]);
  assert.equal(b.get().onboarded, true);
  fs.writeFileSync(a.file, JSON.stringify({ noticesSeen: ['<script>', noticeId(RETIRED)] }));
  assert.deepEqual(createAppState(dir).noticesSeen(), [noticeId(RETIRED)], 'only ids survive a hand-edited file');
});

test('IPC: status carries the unseen notice with its id; dismissNotice takes only an id, needs no confirm, and the notice stays gone', async (t) => {
  const mock = createMockApi({ delayMs: 0, controllable: true });
  mock.control.reset({ notice: SWITCHED });
  const appState = createAppState(tmp(t));
  let pushed = 0;
  const ctx = { api: wrapApi(mock), keys: createKeyStager(), ledger: createShellLedger(), appState, confirm: async () => { throw new Error('no confirm'); }, onNoticeSeen: () => { pushed += 1; }, log: () => {} };
  const ipc = createIpc(ctx);
  const st = await ipc.call('status');
  assert.equal(st.backend.notice.kind, 'model_switched');
  const id = st.backend.notice.id;
  assert.match(id, NOTICE_ID);
  for (const bad of [undefined, {}, { id: '../../x' }, { id: id.toUpperCase() }, { id, extra: 1 }, { id: `${id}0` }]) {
    assert.equal((await ipc.call('dismissNotice', bad)).error, 'bad_input', JSON.stringify(bad));
  }
  assert.deepEqual(await ipc.call('dismissNotice', { id }), { ok: true });
  assert.equal(pushed, 1, 'main pushes the status again, without it');
  assert.equal((await ipc.call('status')).backend.notice, undefined);
  assert.ok(!CONFIRMED.includes('dismissNotice'));
  assert.ok(HANDLERS.dismissNotice);
  mock.control.reset({ notice: RETIRED });
  assert.equal((await ipc.call('status')).backend.notice.kind, 'model_retired', 'a new notice shows');
  // SY-102-5: the mock says a retiring model from the real manifest when a scene asks, as app-api does;
  // Okay keeps it away, and picking another model ends it.
  mock.control.reset({ retiring: true, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'low' } });
  const rs = (await ipc.call('status')).backend.notice;
  assert.deepEqual({ ...rs, id: undefined }, { ...RETIRING, name: 'Claude Haiku 4.5', toName: 'Claude Sonnet 5.5', id: undefined });
  assert.deepEqual(await ipc.call('dismissNotice', { id: rs.id }), { ok: true });
  assert.equal((await ipc.call('status')).backend.notice, undefined);
  assert.equal((await ipc.call('choose', { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' })).ok, true, 'the same AI: no confirm');
  mock.control.reset({ retiring: true, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low' } });
  assert.equal((await ipc.call('status')).backend.notice, undefined, 'another model: nothing to say');
});

test('main.mjs: the pushes and the status call give the window the same decorated status; the tray reads the bridge’s own', () => {
  const main = code(fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8'));
  assert.match(main, /const forWindow = s => withNotice\(s, appState\?\.noticesSeen\(\) \?\? \[\]\);/);
  const onStatus = /function onStatus\(s\) \{([\s\S]*?)\n\}/.exec(main)[1];
  assert.match(onStatus, /refreshTray\(\);/);
  assert.match(onStatus, /notifier\?\.update\(s\);/);
  assert.match(onStatus, /send\(STATUS_CHANNEL, forWindow\(s\)\);/);
  assert.match(main, /api\.onChange\(onStatus\);/, 'the bridge’s status pushes drive the tray and the window');
  assert.match(main, /onNoticeSeen: \(\) => \{ if \(lastStatus\) send\(STATUS_CHANNEL, forWindow\(lastStatus\)\); \}/);
});

test('the window: a switch is a plain notice with Okay; a retired model is the state card, which has no Okay; no timer; pushes repaint the bar and the banners', () => {
  const app = code(fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8'));
  const fn = /function modelNotice\(nt\) \{([\s\S]*?)\n  \}/.exec(app)[1];
  assert.match(fn, /var line = nt\.fromName \? T\('notices\.modelSwitched\.fromLine', fv\) : T\('notices\.modelSwitched\.line', \{ model: to \}\);/, 'the table’s words with the model’s name (UX-W35), and the old one’s when known (CL-words-44)');
  assert.match(fn, /return notice\('warn', line, function \(\) \{/, 'the Okay notice');
  assert.match(fn, /B\.dismissNotice\(\{ id: nt\.id \}\)/);
  assert.match(fn, /var to = nt\.toName \? F\.clean\(nt\.toName, 60\) : modelName\(nt\.to\);/, 'never a raw id');
  assert.doesNotMatch(fn, /setTimeout|setInterval|requestAnimationFrame/, 'never a timed toast');
  assert.match(app, /if \(mn && mn\.id && mn\.kind === 'model_switched' && !S\.noticeGone\[mn\.id\]\) list\.push\(modelNotice\(mn\)\);/);
  const card = /function stateModel\(\) \{([\s\S]*?)\n  \}\n/.exec(app)[1];
  assert.match(card, /case 'model_retired':[\s\S]*?line\('homeCard\.modelRetired'\)[\s\S]*?btn\(T\('homeCard\.modelRetired\.pickModelBtn'\), openModelCard/);
  // The card's words are the table's (renderer/strings.js homeCard).
  const strings = fs.readFileSync(path.join(APP, 'renderer', 'strings.js'), 'utf8');
  assert.match(strings, /modelRetired: \{\n\s*headline: 'Your model was retired\.',\n\s*detail: 'Pick another to keep playing\.',\n\s*pickModelBtn: 'Pick another model',/);
  assert.doesNotMatch(card, /'Okay'/, 'no Okay while the state holds');
  assert.doesNotMatch(app, /setTimeout|setInterval/, 'nothing in the window runs on a timer');
  // A push is drawn by applyStatus (the bar and the banners first), unless it's the same status
  // again or a press is under way (DU-02: then it's drawn once the click has run).
  const onStatus = /B\.onStatus\(function \(s\) \{([\s\S]*?)\n  \}\);/.exec(app)[1];
  assert.match(onStatus, /applyStatus\(s\);/);
  const apply = /function applyStatus\(s\) \{([\s\S]*?)\n  \}/.exec(app)[1];
  assert.match(apply, /S\.status = s;\s*paintPanel\(\);\s*paintBanners\(\);/);
  const preload = fs.readFileSync(path.join(APP, 'preload.cjs'), 'utf8');
  assert.match(preload, /'dismissNotice'/);
});

test('the window (SY-102-5): a retiring model is a notice on Home with the day, the model offered and its cost a day from Your AI\'s own figures, Use <model> (Your AI\'s pick) and Okay', () => {
  const app = code(fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8'));
  assert.match(app, /if \(home && mn && mn\.id && mn\.kind === 'model_retiring' && !S\.noticeGone\[mn\.id\]\) list\.push\(retiringNotice\(mn\)\);/, 'Home only: every other page keeps its word budget');
  const fn = /function retiringNotice\(nt\) \{([\s\S]*?)\n  \}/.exec(app)[1];
  // The cost a day is the one Your AI's row shows for that model (dayAt over the providers' levelDays), at the level the pick would use; never typed.
  assert.match(fn, /var to = modelById\(cur\.id, nt\.to\);/);
  assert.match(fn, /var day = to \? dayAt\(to, to\.effort \? nearestLevel\(levelsOf\(to\), cur\.effort \|\| 'low'\) : null\) : null;/);
  assert.match(fn, /dayCost: day \? T\('yourAi\.dayCostLine', \{ dayCost: day\.text \}\) : ''/, 'Your AI\'s row words for the cost, whole on one line');
  assert.match(fn, /date: F\.dayText\(nt\.after\)/, 'the manifest\'s day, as every date in the window (STYLE §8)');
  assert.match(fn, /model: nt\.name \? F\.clean\(nt\.name, 60\) : modelName\(nt\.model\)/, 'never a raw id');
  assert.doesNotMatch(fn, /pname\(/, 'the model retires; the line needs no company');
  assert.match(fn, /to: nt\.toName \? F\.clean\(nt\.toName, 60\) : modelName\(nt\.to\)/);
  assert.match(fn, /busyBtn\(T\('notices\.modelRetiring\.useBtn', \{ model: v\.to \}\), function \(\) \{ return useModel\(cur, nt\.to\); \}/);
  assert.match(fn, /B\.dismissNotice\(\{ id: nt\.id \}\)/);
  assert.match(fn, /dataLine\(id, v, \['model', 'date', 'to', 'dayCost'\]\)/, 'names, the day and the price are data, as Your AI\'s rows are');
  assert.doesNotMatch(fn, /setTimeout|setInterval|requestAnimationFrame/);
  // One pick: Your AI's model rows and the notice's Use go through chooseModel, then Your AI shows the result.
  assert.match(app, /function chooseModel\(cur, mid\) \{\n    var mm = modelById\(cur\.id, mid\) \|\| \{\};\n    return B\.choose\(\{ provider: cur\.id, model: mid, effort: mm\.effort \? \(nearestLevel\(levelsOf\(mm\), cur\.effort \|\| 'low'\) \|\| 'low'\) : null \}\);/);
  assert.equal((app.match(/B\.choose\(\{ provider: cur\.id, model: mid,/g) ?? []).length, 1, 'one model pick in the window');
  assert.match(app, /var pick = function \(mid\) \{\n          chooseModel\(cur, mid\)\.then/);
  assert.match(app, /function useModel\(cur, mid\) \{\n    return chooseModel\(cur, mid\)\.then\(function \(r\) \{\n      S\.ya = \{ view: 'main', modelOpen: true, chosen: stamp\(r \|\| \{ ok: false \}\) \};/);
  const strings = fs.readFileSync(path.join(APP, 'renderer', 'strings.js'), 'utf8');
  assert.match(strings, /modelRetiring: \{\n\s*line: '\{model\} may retire after \{date\}\. \{to\} costs about \{dayCost\}\.', \/\/ dayCost: Your AI's row cost, yourAi\.dayCostLine\n\s*noCostLine: '\{model\} may retire after \{date\}\.',\n\s*useBtn: 'Use \{model\}',/);
});

test('a one-off failure notice is kept put away in main like a model notice: its id, left out once seen, shown again for a new failure (D-35)', async (t) => {
  const le = { kind: 'bad_request', at: 1000, headline: 'h', detail: 'd', action: 'details', notice: true };
  const st = { backend: { rt: { state: 'ready' }, lastError: le } };
  const id = lastErrorId(le);
  assert.match(id, NOTICE_ID);
  assert.equal(withNotice(st, []).backend.lastError.id, id);
  assert.equal(Object.hasOwn(withNotice(st, [id]).backend, 'lastError'), false, 'seen: left out');
  assert.notEqual(lastErrorId({ ...le, at: 2000 }), id, 'a new failure is a new id');
  const state = { backend: { rt: { state: 'ready' }, lastError: { ...le, notice: undefined } } };
  assert.equal(withNotice(state, [id]).backend.lastError.kind, 'bad_request', 'a failure that is a state is never put away');
  assert.equal(withNotice(state, []).backend.lastError.id, undefined);
  // Through IPC and a real app-state file: dismissNotice keeps it across windows and restarts.
  const mock = createMockApi({ delayMs: 0, controllable: true });
  const { lastErrorView } = await import('../../bridge/byok/app-api.mjs');
  mock.control.useLastErrorView(lastErrorView);
  mock.control.reset({ keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }, lastError: { kind: 'unknown', at: 5, streak: 1 } });
  const dir = tmp(t);
  const ipc = createIpc({ api: wrapApi(mock), keys: createKeyStager(), ledger: createShellLedger(), appState: createAppState(dir), confirm: async () => true, log: () => {} });
  const s1 = await ipc.call('status');
  assert.equal(s1.backend.lastError.notice, true);
  assert.deepEqual(await ipc.call('dismissNotice', { id: s1.backend.lastError.id }), { ok: true });
  const again = createIpc({ api: wrapApi(mock), keys: createKeyStager(), ledger: createShellLedger(), appState: createAppState(dir), confirm: async () => true, log: () => {} });
  assert.equal((await again.call('status')).backend.lastError, undefined, 'still gone after a restart');
  mock.control.reset({ keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }, lastError: { kind: 'unknown', at: 6, streak: 1 } });
  assert.equal((await again.call('status')).backend.lastError.kind, 'unknown', 'the same kind at a new time shows again');
});

