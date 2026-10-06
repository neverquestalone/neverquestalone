// Paste key, the connect dialog and what Agree does (app/desktop/ipc.mjs; onboarding spec §3.4;
// plan §3.2, §7.2), through createIpc over a fake ctx and the controllable mock API: main reads the
// clipboard (the page never does), the dialog comes before any request, the terms are recorded
// before the first test, a key is saved only when its company accepts it (or documents no credit on
// a first key, T1), and a failure fixed away from the app holds it 30 minutes. Canary keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIpc, createKeyStager, SAVE_FIRST_KEY_WITHOUT_CREDIT, PASTE_MIN_MS, st as mainString } from '../../app/desktop/ipc.mjs';
import { createMockApi } from '../../app/desktop/src/mock-api.mjs';
import { wrapApi, API_METHODS } from '../../app/desktop/src/api-loader.mjs';
import { createShellLedger } from '../../app/desktop/src/net-guard.mjs';
import { idleUpdater } from '../../app/desktop/updater.mjs';
import { STRINGS } from '../../app/desktop/src/strings.mjs';
import { canaryNeedles } from './helpers/canary.mjs';

const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'desktop');
const ANT = `sk-ant-api03-CANARY${'x'.repeat(80)}`;
const ANT2 = `sk-ant-api03-CANARY${'y'.repeat(80)}`;
const BAD = `sk-ant-api03-CANARY${'x'.repeat(74)}BADKEY`;
const NOCREDIT = `sk-ant-api03-CANARY${'x'.repeat(70)}NOCREDIT`;
const OAI = `sk-proj-CANARY${'x'.repeat(60)}`;
const XAI_NOCREDIT = `xai-CANARY${'x'.repeat(30)}NOCREDIT`;
const OR = `sk-or-v1-CANARY${'x'.repeat(56)}`;

/** createIpc over the controllable mock, a fake clipboard and focus, recording calls and dialogs. */
function rig({ state = {}, confirm = true, focused = true, platform = 'darwin', appState = {} } = {}) {
  const mock = createMockApi({ delayMs: 0, controllable: true, platform });
  mock.control.reset(state);
  const base = wrapApi(mock);
  const calls = [];
  const api = {};
  for (const m of [...API_METHODS, 'onChange', 'stop']) api[m] = (...a) => { calls.push([m, ...a]); return base[m](...a); };
  const confirms = [];
  const clip = { text: '', writes: [] };
  let app = { onboarded: false, notifications: true, defaultsSeen: false, alertsAsked: false, ...appState };
  const notified = [];
  const logins = [];
  const ctx = {
    api, keys: createKeyStager(), ledger: createShellLedger(), updater: idleUpdater({ pkg: {}, prefs: {}, current: '0.1.0' }),
    appState: { get: () => ({ ...app }), set: v => { app = { ...app, ...v }; return { ...app }; } },
    platform,
    confirm: async spec => { confirms.push(spec); return typeof confirm === 'function' ? confirm(spec) : confirm; },
    links: { open: () => ({ ok: true }) },
    clipboard: { writeText: t => { clip.writes.push(t); clip.text = t; }, readText: async () => clip.text },
    isFocused: () => focused,
    loginItem: { set: o => { logins.push(o); return { ok: true, supported: true, openAtLogin: o }; }, get: () => ({ supported: true, openAtLogin: false }) },
    notify: n => notified.push(n),
    info: () => ({ platform }), notices: () => [], companion: () => 'NeverQuestAlone', releasesUrl: () => null, log: () => {},
  };
  const ipc = createIpc(ctx);
  let t = 10_000;
  ctx.now = () => t;
  const paste = async (text, provider = 'anthropic') => { clip.text = text; t += PASTE_MIN_MS + 1; return ipc.call('pasteKey', { provider }); };
  return { ipc, ctx, mock, calls, confirms, clip, paste, notified, logins, app: () => app, tick: ms => { t += ms; } };
}
const count = (calls, name) => calls.filter(c => c[0] === name).length;
const noCanary = (label, ...values) => {
  const text = JSON.stringify(values);
  for (const n of canaryNeedles()) assert.ok(!text.includes(n.needle), `${label}: carries a key (${n.provider})`);
  assert.ok(!text.includes('CANARY'), `${label}: carries a key`);
};

test('Paste key: refused (silently) while the window isn’t focused and past one read a second; main reads the clipboard, the page never sends a key', async () => {
  const r = rig({ focused: false });
  r.clip.text = ANT;
  assert.deepEqual(await r.ipc.call('pasteKey', { provider: 'anthropic' }), { ok: false, error: 'ignored' });
  assert.equal(r.confirms.length, 0);
  const f = rig();
  assert.equal((await f.paste(ANT)).ok, true);
  f.clip.text = ANT;
  assert.deepEqual(await f.ipc.call('pasteKey', { provider: 'anthropic' }), { ok: false, error: 'ignored' }, 'a second read within the second');
  assert.equal((await f.ipc.call('pasteKey', { provider: 'anthropic', key: ANT })).error, 'bad_input', 'the page can’t hand main a key this way');
  // Over 4 KB: not read as a key at all.
  const big = rig();
  assert.equal((await big.paste(`${ANT} ${'x'.repeat(5000)}`)).error, 'not_a_key');
  assert.equal(big.ctx.keys.size, 0);
  assert.equal(big.confirms.length, 0);
});

test('the dialog comes before any request; Cancel sends and saves nothing, and keeps the key staged', async () => {
  let release;
  const gate = new Promise(res => { release = res; });
  const r = rig({ confirm: () => gate });
  const pending = r.paste(ANT);
  await new Promise(res => setImmediate(res));
  assert.equal(r.confirms.length, 1);
  assert.equal(count(r.calls, 'testStagedKey'), 0, 'no request while the dialog is up');
  assert.equal(count(r.calls, 'recordTerms'), 0);
  release(false);
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  assert.equal(count(r.calls, 'testStagedKey') + count(r.calls, 'connect') + count(r.calls, 'recordTerms'), 0);
  assert.equal(r.ctx.keys.size, 1, 'still staged');
});

test('Agree: the terms are recorded, then one test, then the save; the key leaves the clipboard (only while it’s still there); only a mask comes back', async () => {
  const r = rig();
  const res = await r.paste(ANT);
  assert.equal(res.ok, true, JSON.stringify(res));
  const order = r.calls.map(c => c[0]).filter(n => ['recordTerms', 'testStagedKey', 'connect'].includes(n));
  assert.deepEqual(order, ['recordTerms', 'testStagedKey', 'connect']);
  assert.deepEqual(r.calls.find(c => c[0] === 'testStagedKey')[3], { context: 'setup' });
  assert.equal(res.cleared, true);
  assert.equal(r.clip.text, '');
  assert.equal(res.ai, 'Claude');
  assert.equal(res.masked, 'sk-ant-…xxxx');
  assert.equal(r.ctx.keys.size, 0, 'dropped once saved');
  noCanary('ok', res, r.confirms);
  // Typed into the field (a paste there is Paste key, code health AP-05): nothing to clear.
  const f = rig();
  f.clip.text = 'something the player copied';
  const staged = await f.ipc.call('stageKey', { key: `  ${ANT}\n` });
  const fres = await f.ipc.call('connectKey', { provider: 'anthropic', stageId: staged.stageId });
  assert.equal(fres.ok, true);
  assert.equal(fres.cleared, false);
  assert.equal(f.clip.text, 'something the player copied');
  // The clipboard changed since the paste: left alone.
  const c = rig();
  c.clip.text = ANT;
  c.ctx.api.testStagedKey = async (...a) => { c.clip.text = 'copied meanwhile'; return c.mock.testStagedKey(...a); };
  c.ctx.lastPasteAt = 0;
  const cres = await c.ipc.call('pasteKey', { provider: 'anthropic' });
  assert.equal(cres.cleared, false);
  assert.equal(c.clip.text, 'copied meanwhile');
});

test('a key its company doesn’t accept saves nothing; on a Replace the saved key stays (kept) and the dialog says Replace', async () => {
  const r = rig();
  const res = await r.paste(BAD);
  assert.equal(res.error, 'auth_invalid');
  assert.equal(count(r.calls, 'connect'), 0);
  assert.equal(r.ctx.keys.size, 0, 'dropped');
  const rep = rig({ state: { keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null } } });
  const out = await rep.paste(BAD);
  assert.equal(rep.confirms[0].message, mainString('pasteDialog.replace.message', { co: 'Anthropic' }));
  assert.equal(rep.confirms[0].okLabel, STRINGS.pasteDialog.replace.okLabel);
  assert.equal(out.error, 'auth_invalid');
  assert.equal(out.kept, true);
  assert.equal(count(rep.calls, 'connect'), 0);
});

test('T1: a first key with documented no credit is saved as no_credit; never on a guess (xAI) or a Replace; the NoCredit body only then', async () => {
  assert.equal(SAVE_FIRST_KEY_WITHOUT_CREDIT, true);
  const r = rig();
  const res = await r.paste(NOCREDIT);
  assert.equal(res.error, 'out_of_credit');
  assert.equal(res.saved, true);
  assert.equal(count(r.calls, 'connect'), 1);
  assert.deepEqual(r.calls.find(c => c[0] === 'connect')[3], { noCredit: true });
  assert.match(r.confirms[0].detail, /accepts the key/);
  assert.equal((await r.ipc.call('providers')).find(p => p.id === 'anthropic').key.state, 'no_credit');
  const x = rig();
  const xres = await x.paste(XAI_NOCREDIT, 'xai');
  assert.equal(xres.error, 'out_of_credit');
  assert.equal(xres.inferred, true);
  assert.equal(xres.held, true, 'held 30 minutes for Test again');
  assert.equal(count(x.calls, 'connect'), 0, 'never saved on a guess');
  assert.doesNotMatch(x.confirms[0].detail, /accepts the key/);
  const rep = rig({ state: { keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } } } });
  const rres = await rep.paste(NOCREDIT);
  assert.equal(rres.saved, undefined);
  assert.equal(count(rep.calls, 'connect'), 0, 'a Replace never saves an unproven key');
});

test('retryConnect: only a key held after its dialog, for that AI, within 30 minutes; no second dialog; after the key store failed, only the write', async () => {
  const r = rig({ state: { results: { testStagedKey: { ok: false, error: 'rate_limited' } } } });
  const res = await r.paste(ANT);
  assert.equal(res.error, 'rate_limited');
  assert.equal(res.held, true);
  assert.match(res.stageId, /^[0-9a-f]{32}$/, 'the stage’s id, never the key');
  r.mock.control.reset({ terms: { anthropic: 1 } });
  const n = r.confirms.length;
  const again = await r.ipc.call('retryConnect', { provider: 'anthropic', stageId: res.stageId });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(r.confirms.length, n, 'no second dialog');
  assert.equal(count(r.calls, 'recordTerms'), 1, 'the terms were recorded once, at the dialog');
  // Refused: another AI, an unknown stage, an unapproved one.
  const u = rig();
  const staged = await u.ipc.call('stageKey', { key: ANT });
  assert.equal((await u.ipc.call('retryConnect', { provider: 'anthropic', stageId: staged.stageId })).error, 'needs_confirm', 'never agreed to');
  assert.equal((await u.ipc.call('retryConnect', { provider: 'anthropic', stageId: 'f'.repeat(32) })).error, 'stage_expired');
  const o = rig({ state: { results: { testStagedKey: { ok: false, error: 'overloaded' } } } });
  const ores = await o.paste(ANT);
  assert.equal((await o.ipc.call('retryConnect', { provider: 'openai', stageId: ores.stageId })).error, 'needs_confirm', 'only for the AI it was agreed for');
  // The stager's clock: held 30 minutes, for its AI only.
  let t = 0;
  const s = createKeyStager({ now: () => t });
  const id = s.stage(ANT);
  assert.equal(s.hold(id), false, 'hold only after approve');
  s.approve(id, 'anthropic');
  assert.equal(s.hold(id), true);
  t += 29 * 60_000;
  assert.equal(s.peek(id, 'anthropic'), ANT, 'held within 30 minutes');
  assert.equal(s.peek(id, 'openai'), null, 'never for another AI');
  t += 2 * 60_000;
  assert.equal(s.peek(id), null, 'gone after 30');
  const s2 = createKeyStager({ now: () => t });
  const id2 = s2.stage(ANT);
  t += 5 * 60_000 + 1;
  assert.equal(s2.peek(id2), null, 'an unheld stage lasts 5 minutes');
  s2.stage(ANT);
  s2.clear();
  assert.equal(s2.size, 0, 'lock, sleep and quit clear it');
  // The key store failed after a pass: Save again writes, with no second test.
  const k = rig({ state: { results: { connect: { ok: false, error: 'keystore_error' } } } });
  const kres = await k.paste(ANT);
  assert.equal(kres.error, 'keystore_error');
  k.mock.control.reset({ terms: { anthropic: 1 } });
  const tests = count(k.calls, 'testStagedKey');
  const saved = await k.ipc.call('retryConnect', { provider: 'anthropic', stageId: kres.stageId });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(count(k.calls, 'testStagedKey'), tests, 'no second test');
});

test('useSavedKey: the dialog only when the terms aren’t recorded; the result is setup’s', async () => {
  const noTerms = rig({ state: { keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, terms: {} } });
  const a = await noTerms.ipc.call('useSavedKey', { provider: 'anthropic' });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(noTerms.confirms.length, 1);
  assert.equal(noTerms.confirms[0].message, mainString('pasteDialog.useSaved.message', { co: 'Anthropic' }));
  assert.equal(noTerms.confirms[0].okLabel, STRINGS.pasteDialog.useSaved.okLabel);
  assert.equal(count(noTerms.calls, 'recordTerms'), 1);
  const terms = rig({ state: { keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, terms: { anthropic: 1 } } });
  assert.equal((await terms.ipc.call('useSavedKey', { provider: 'anthropic' })).ok, true);
  assert.equal(terms.confirms.length, 0, 'no dialog: the terms are recorded');
  assert.equal((await rig().ipc.call('useSavedKey', { provider: 'anthropic' })).error, 'no_key');
});

test('a key for another AI: no dialog, the key stays staged, and Use <AI> instead connects it with the same stage', async () => {
  const r = rig();
  const res = await r.paste(OAI, 'anthropic');
  assert.equal(res.error, 'key_mismatch');
  assert.equal(res.guess, 'openai');
  assert.match(res.stageId, /^[0-9a-f]{32}$/);
  assert.equal(r.confirms.length, 0);
  const use = await r.ipc.call('connectKey', { provider: 'openai', stageId: res.stageId });
  assert.equal(use.ok, true, JSON.stringify(use));
  assert.equal(r.confirms[0].message, mainString('pasteDialog.connect.message', { ai: 'ChatGPT' }));
  assert.equal(r.clip.text, '', 'it came from the clipboard, so it leaves it');
  assert.equal((await r.ipc.call('connectKey', { provider: 'anthropic', stageId: res.stageId })).error, 'stage_expired', 'used up');
});

const GEM = `AIza${'C'.repeat(35)}`;

test('a Google key: Gemini, with the connect dialog and Google’s terms, then Gemini 3.8 Flash', async () => {
  const r = rig();
  const res = await r.paste(GEM, null);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.confirms[0].message, mainString('pasteDialog.connect.message', { ai: 'Gemini' }));
  assert.match(r.confirms[0].detail, /Google’s age requirement/);
  const st = await r.ipc.call('status');
  assert.deepEqual([st.backend.provider.id, st.backend.provider.model], ['google', 'gemini-3.8-flash']);
});

test('an OpenRouter key: no dialog; it is staged for Other’s form, which connects with it and OpenRouter’s address (DU-44)', async () => {
  const r = rig();
  const res = await r.paste(OR, null);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'custom_key');
  assert.equal(res.guess, 'openrouter');
  assert.match(res.stageId, /^[0-9a-f]{32}$/);
  assert.equal(res.masked, 'sk-or-…xxxx');
  assert.ok(!JSON.stringify(res).includes('CANARY'), 'the key never goes back to the page');
  assert.equal(r.confirms.length, 0);
  assert.equal(r.ctx.keys.size, 1, 'held for Other’s form');
  const got = await r.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', stageId: res.stageId });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.masked, 'sk-or-…xxxx', 'the staged key was the one tested and saved');
  assert.match(r.confirms[0].detail, /your key is saved in your macOS Keychain/, 'the dialog says a key goes');
  assert.equal(r.ctx.keys.size, 0, 'dropped once connected');
  // A stage that is gone (timed out, or dropped) says so before any dialog.
  const again = await r.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', stageId: res.stageId });
  assert.deepEqual(again, { ok: false, error: 'key_expired' });
  assert.equal(r.confirms.length, 1);
  // Typed into the field it is staged the same way.
  const typed = await r.ipc.call('stageKey', { key: OR });
  assert.equal(typed.error, 'custom_key');
  assert.match(typed.stageId, /^[0-9a-f]{32}$/);
});

test('Other: connectCustom asks first (the dialog names the address; a key is kept in the key store; a server here keeps messages here), then tests and saves; the key never comes back', async () => {
  const r = rig();
  const res = await r.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini', key: OR });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(r.confirms[0].message, 'Connect NeverQuestAlone to openrouter.ai?');
  assert.match(r.confirms[0].detail, /to https:\/\/openrouter\.ai\/api\/v1\. If it answers, your key is saved in your macOS Keychain/);
  assert.match(r.confirms[0].detail, /under its own terms/);
  assert.ok(!JSON.stringify(r.confirms).includes('CANARY') && !JSON.stringify(res).includes('CANARY'));
  const local = rig();
  const l = await local.ipc.call('connectCustom', { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' });
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.match(local.confirms[0].detail, /localhost:11434\/v1\. Your messages stay on this Mac\./);
  assert.doesNotMatch(local.confirms[0].detail, /terms/);
  // Refused in main before any dialog: an address off this computer over http, a key with spaces.
  const bad = rig();
  assert.deepEqual(await bad.ipc.call('connectCustom', { baseUrl: 'http://openrouter.ai/api/v1', model: 'm' }), { ok: false, error: 'https_required' });
  assert.deepEqual(await bad.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'm', key: 'two words' }), { ok: false, error: 'not_a_key' });
  assert.equal(bad.confirms.length, 0);
  // Cancel at the dialog: nothing is sent or saved.
  const no = rig({ confirm: false });
  assert.equal((await no.ipc.call('connectCustom', { baseUrl: 'https://openrouter.ai/api/v1', model: 'm', key: OR })).error, 'cancelled');
  assert.equal((await no.ipc.call('providers')).find(p => p.id === 'custom').custom, null);
});

test('Other’s API key field: a paste is read in main, never matched to a card’s shape, and staged for the form with no dialog; Connect saves it and it leaves the clipboard, only while it’s still there (code health AP-05)', async () => {
  const URL_ = 'https://api.example.com/v1';
  const KEY = `exk_CANARY${'x'.repeat(40)}`; // a service no card knows: any key the typed field takes
  const r = rig();
  const res = await r.paste(`  ${KEY}\n`, 'custom');
  assert.deepEqual(Object.keys(res).sort(), ['error', 'masked', 'ok', 'stageId'], JSON.stringify(res));
  assert.equal(res.error, 'custom_key', 'staged for Other’s form, as an OpenRouter key pasted on a card is (DU-44)');
  assert.match(res.stageId, /^[0-9a-f]{32}$/);
  assert.equal(res.masked, '…xxxx');
  assert.equal(r.confirms.length, 0, 'no dialog: Connect asks');
  assert.equal(r.ctx.keys.peek(res.stageId), KEY, 'trimmed, as a typed key is');
  assert.equal(r.ctx.keys.entry(res.stageId).source, 'clipboard');
  noCanary('staged', res);
  const got = await r.ipc.call('connectCustom', { baseUrl: URL_, model: 'm', stageId: res.stageId });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(r.calls.filter(c => c[0] === 'connectCustom').at(-1)[1].key, KEY, 'the staged key is the one connected');
  assert.equal(r.confirms.length, 1, 'one dialog, at Connect');
  assert.equal(r.clip.text, '', 'off the clipboard once saved');
  assert.equal(r.ctx.keys.size, 0);
  noCanary('connected', got, r.confirms);
  // A card's shape is Other's all the same (a compatible service's key may look like OpenAI's), and
  // the clipboard changed since the paste is left alone.
  const o = rig();
  const oai = await o.paste(OAI, 'custom');
  assert.equal(oai.error, 'custom_key');
  o.clip.text = 'copied meanwhile';
  assert.equal((await o.ipc.call('connectCustom', { baseUrl: URL_, model: 'm', stageId: oai.stageId })).ok, true);
  assert.equal(o.clip.text, 'copied meanwhile');
  // A key the service refuses stays staged (Connect again) and on the clipboard.
  const b = rig();
  const bad = await b.paste(`${KEY}BADKEY`, 'custom');
  assert.equal((await b.ipc.call('connectCustom', { baseUrl: URL_, model: 'm', stageId: bad.stageId })).error, 'auth_invalid');
  assert.equal(b.clip.text, `${KEY}BADKEY`);
  assert.equal(b.ctx.keys.size, 1);
  // Not a key there: an empty clipboard, text with spaces, past 1,024 characters. Nothing is staged.
  const n = rig();
  assert.deepEqual(await n.paste('  \n', 'custom'), { ok: false, error: 'clipboard_empty' });
  assert.deepEqual(await n.paste('two words', 'custom'), { ok: false, error: 'not_a_key' });
  assert.deepEqual(await n.paste('k'.repeat(1025), 'custom'), { ok: false, error: 'not_a_key' });
  assert.equal(n.ctx.keys.size, 0);
  assert.equal(n.confirms.length, 0);
  // Typed into the form: sent as it was, never staged; nothing to clear.
  const t = rig();
  t.clip.text = 'something the player copied';
  assert.equal((await t.ipc.call('connectCustom', { baseUrl: URL_, model: 'm', key: KEY })).ok, true);
  assert.equal(t.clip.text, 'something the player copied');
});

test('every dialog variant is main’s table, filled; none carries a key', async () => {
  const connect = rig();
  await connect.paste(ANT);
  const c = connect.confirms[0];
  assert.equal(c.message, 'Connect Claude with this key?');
  assert.equal(c.okLabel, 'Agree and connect');
  assert.equal(c.cancelLabel, 'Cancel');
  assert.equal(c.detail.split('\n\n').length, 3, 'the mask, the body, the terms');
  assert.equal(c.detail.split('\n\n')[1], mainString('pasteDialog.connect.body.clipboardNoCredit', { co: 'Anthropic', testCost: 'under $0.0001', store: 'your macOS Keychain', name: 'NeverQuestAlone', model: 'Claude Sonnet 5.5' }), 'the model a new AI starts on: Claude\'s default (fix-102)');
  assert.equal(c.detail.split('\n\n')[2], mainString('pasteDialog.connect.terms', { co: 'Anthropic' }));
  const sw = rig({ state: { keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }, terms: { anthropic: 1, openai: 1 } } });
  await sw.paste(OAI, 'openai');
  assert.equal(sw.confirms[0].message, 'Switch NeverQuestAlone to ChatGPT with this key?');
  assert.equal(sw.confirms[0].okLabel, STRINGS.pasteDialog.switch.okLabelTermsRecorded, 'terms recorded: the verb alone');
  assert.match(sw.confirms[0].detail, /Your messages go to OpenAI instead of Anthropic\./);
  const win = rig({ platform: 'win32' });
  await win.paste(ANT);
  assert.match(win.confirms[0].detail, /Windows Credential Manager/);
  for (const r of [connect, sw, win]) noCanary('dialog', r.confirms);
});

test('a deep scan of every result finds no key', async () => {
  const results = [];
  for (const [text, provider, state] of [[ANT, 'anthropic', {}], [BAD, 'anthropic', {}], [NOCREDIT, 'anthropic', {}], [OAI, 'anthropic', {}], [OR, null, {}], ['not a key at all', 'anthropic', {}], [ANT, 'anthropic', { results: { testStagedKey: { ok: false, error: 'network' } } }]]) {
    const r = rig({ state });
    results.push(await r.paste(text, provider));
  }
  noCanary('results', results);
});

test('Continue on Check your defaults (finishDefaults): the login item once; on a Mac with notifications on, one notification the first time; defaults seen', async () => {
  const r = rig();
  const res = await r.ipc.call('finishDefaults', { loginItem: true, notifications: true });
  assert.equal(res.ok, true);
  assert.deepEqual(r.logins, [true], 'written exactly once');
  assert.equal(r.notified.length, 1);
  assert.deepEqual(r.notified[0], { title: STRINGS.notifications.alertsOn.title, body: mainString('notifications.alertsOn.body', { name: 'NeverQuestAlone' }) });
  assert.equal(r.app().alertsAsked, true);
  assert.equal(r.app().defaultsSeen, true);
  await r.ipc.call('finishDefaults', { loginItem: false, notifications: true });
  assert.equal(r.notified.length, 1, 'macOS was asked once');
  const off = rig();
  await off.ipc.call('finishDefaults', { loginItem: false, notifications: false });
  assert.equal(off.notified.length, 0);
  assert.equal(off.app().notifications, false);
  const win = rig({ platform: 'win32' });
  await win.ipc.call('finishDefaults', { loginItem: true, notifications: true });
  assert.equal(win.notified.length, 0, 'Windows posts none');
  assert.equal((await r.ipc.call('finishDefaults', { loginItem: 'yes', notifications: true })).error, 'bad_input');
});

test('static: main reads the clipboard only in Paste key and before clearing a saved key; onboarded is written by the addon’s hello, the first reply or Finish later', () => {
  const ipc = fs.readFileSync(path.join(APP, 'ipc.mjs'), 'utf8');
  const reads = [...ipc.matchAll(/clipboard\.readText\(\)/g)].length;
  assert.equal(reads, 2, 'Paste key, and the clear after a save (setKey’s own read went with it, code health AP-14)');
  assert.match(ipc, /pasteKey: \{[\s\S]*?await ctx\.clipboard\.readText\(\)/);
  const main = fs.readFileSync(path.join(APP, 'main.mjs'), 'utf8');
  assert.match(main, /if \(\(s\?\.setup\?\.firstReplyAt \|\| s\?\.setup\?\.game\?\.hello\) && appState && !appState\.get\(\)\.onboarded\) \{ appState\.set\(\{ onboarded: true \}\)/);
  assert.match(main, /for \(const ev of \['lock-screen', 'suspend'\]\) powerMonitor\.on\(ev, \(\) => keys\?\.clear\(\)\);/);
  const app = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
  assert.doesNotMatch(app.replace(/\/\/.*$/gm, ''), /clipboardData/, 'the page never reads a paste’s clipboard, in a key field or anywhere (code health AP-05)');
});
