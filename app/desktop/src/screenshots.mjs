// Screenshots of every window state, for the desktop-app UI critic (BYOK PRD §16 onboarding and
// flows, §10 errors, §9.5 usage, §8.4 Connections and Last request, §13 privacy; the UI critic
// loop, the maintainer's 10/10 bar). Development runs only:
//
//   npx electron . --screenshots <dir>
//
// main.mjs opens the settings window hidden against the mock API (src/mock-api.mjs with its
// control) and hands it to screenshots() below, which puts the fake bridge in each state below,
// drives the page the way a player would (clicks, a paste, a checkbox; through
// webContents.executeJavaScript from main, never through anything the page itself exposes), and
// writes webContents.capturePage PNGs plus INDEX.txt, in
// light and in dark. The window grows to the page's height for each shot, so nothing is cut off.
// Native confirms are answered by the scene; the daily spend limit's confirms are drawn in the
// window as previews (the real ones are system dialogs that capturePage can't see). The folder dialog behind
// "Choose folder…" is answered by the scene too (driver.setFolder).
//
// A packaged app refuses --screenshots, with --self-test or without (screenshotsAllowed): it
// answers every native confirm yes and writes PNGs wherever it's pointed (C3 review). Keys are
// canaries (the tests' shape), never real ones.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const FLAG = '--screenshots';
export const THEMES = Object.freeze(['dark']);
export const FAKE_KEY = `sk-ant-api03-CANARY${'x'.repeat(80)}`;
export const FAKE_BAD_KEY = `sk-ant-api03-CANARY${'x'.repeat(74)}BADKEY`;
export const MAX_HEIGHT = 3200;

/** The folder after --screenshots (or --screenshots=<dir>), or null. */
export function screenshotsDir(argv = process.argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === FLAG) return argv[i + 1] && !argv[i + 1].startsWith('-') ? path.resolve(argv[i + 1]) : '';
    if (a.startsWith(`${FLAG}=`)) return path.resolve(a.slice(FLAG.length + 1));
  }
  return null;
}

/** Development runs only: a packaged app refuses --screenshots, --self-test or not. */
export function screenshotsAllowed({ packaged, dir }) {
  if (dir === '') return { ok: false, reason: 'usage: --screenshots <folder>' };
  if (packaged) return { ok: false, reason: '--screenshots is for development runs; a packaged app refuses it' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The mock's states.

const HAIKU = { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null };
const SAVED = { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } };
const READY = { keys: SAVED, choice: HAIKU, addonInstalled: true };
// A daily spend limit the player set: the public build has none of its own (maintainer, 2026-09-26).
const LIMIT = { caps: { dailyUsd: 1 } };
const LOOSE = { ok: false, fixable: true, fixed: [], paths: ['/Applications/World of Warcraft/_forever_/Interface/AddOns'], detail: 'Other accounts on this Mac can change /Applications/World of Warcraft/_forever_/Interface/AddOns, so they could run addon code in your game.' };
const OPENAI_READY = { keys: { openai: { masked: 'sk-proj-…xxxx', state: 'ok' } }, choice: { provider: 'openai', model: 'gpt-6-luna', effort: 'low' }, addonInstalled: true };
/** An installed app's updater, as About reads it (the screenshot mode's fixture; nothing is fetched). */
const UPDATER = Object.freeze({ supported: true, configured: true, mode: 'notify', notifyOnly: false, current: '1.2.0', state: 'none', available: null, progress: null, lastCheck: Date.UTC(2026, 9, 2, 9), error: null });
const CAPTURE_WAITING = { state: 'waiting', mode: 'capture', signals: 'unknown', steps: { game: false, strip: false, message: false, reply: false } };
const CAPTURE_HALF = { state: 'ok', mode: 'capture', signals: 'sound_off', steps: { game: true, strip: true, message: false, reply: false } };

/**
 * §10's kinds, one per row of its table: the kind, the rt state the backend sets for it (and its
 * reason), the row's name. null: the backend sets no rt state for that kind; the window learns of
 * it from the backend's last failure (lastError, through the bridge's lastErrorView), as a player
 * would. model_not_found is the start-time check's retired-model notice.
 */
export const ERROR_GROUPS = Object.freeze([
  ['auth_invalid', 'key_invalid', 'Invalid key', 'key rejected'],
  ['out_of_credit', 'out_of_credit', 'No credit'],
  ['spend_limit', null, 'Provider spend limit hit'],
  ['cap_spend', 'cap', 'Your daily spend limit', 'cap_spend'],
  ['rate_limited', 'slowed', 'Rate limited'],
  ['overloaded', 'provider_down', 'Overloaded or server error'],
  ['model_not_found', null, 'Model not found'],
  ['context_too_long', null, 'Context too long'],
  ['content_blocked', null, 'Content filtered or refused'],
  ['network_before_send', null, 'Network down'],
  ['local_unreachable', 'local_down', 'Local server down'],
  ['region_blocked', null, 'Region blocked'],
  ['identifier_blocked', null, 'Identifier blocked'],
  ['interrupted', null, 'Interrupted by a restart'],
  ['timeout', 'provider_down', 'Stall or run timeout'],
]);

/**
 * The window's state card (D-01) for each state the bar can show: the mock's state, what the
 * card says (to wait for), and the page it's shown over.
 */
// Other (custom) connected to a service off this computer (OpenRouter's address, a key), and to a
// server on this computer (Ollama's OpenAI-compatible address, no key).
const CUSTOM_REMOTE = { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }, keys: { custom: { masked: 'sk-or-…m0ck', state: 'ok' } }, choice: { provider: 'custom', model: 'openai/gpt-5-mini', effort: null }, addonInstalled: true };
const CUSTOM_LOCAL = { custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' }, choice: { provider: 'custom', model: 'qwen3:8b', effort: null }, addonInstalled: true };
export const STATE_CARDS = Object.freeze([
  ['no-key', 'No key: Add key, or Pick another AI', { choice: HAIKU_CHOICE(), addonInstalled: true }, 'No key from Anthropic yet'],
  ['key-invalid', 'Key invalid: Replace key, Open Anthropic keys', { ...READY_STATE(), keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } }, 'rejected your key'],
  ['slowed', 'Slowed: the retry countdown, nothing to click', { ...READY_STATE(), rt: { state: 'slowed', retryIn: 18 } }, 'to slow down'],
  ['out-of-credit', 'Out of credit: Test key (a pass clears it), Add credit at Anthropic', { ...READY_STATE(), rt: { state: 'out_of_credit' } }, 'out of credit'],
  ['cap-spend', 'Daily limit reached (the $1.00 a day the player set): Raise limit', { ...READY_STATE(), caps: { dailyUsd: 1 }, spentMicros: 1_000_000 }, 'reached your daily spend limit'],
  ['near-cap', 'Near the daily limit the player set (86% of $1.00): a warning, Raise limit', { ...READY_STATE(), caps: { dailyUsd: 1 }, spentMicros: 860_000 }, 'near your limit'],
  ['provider-down', 'The AI isn’t answering: Test key, Pick another AI', { ...READY_STATE(), rt: { state: 'provider_down' } }, 'isn’t answering'],
  ['local-down', 'The server on this Mac stopped (Other at localhost): Check again', { ...CUSTOM_LOCAL, rt: { state: 'local_down' } }, 'Can’t reach localhost:11434'],
  ['model-retired', 'Pick another model (a retired model): no Okay while it holds', { ...READY_STATE(), choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: Date.UTC(2026, 8, 26, 9) } }, 'was retired'],
  ['paused', 'Paused: NeverQuestAlone is paused, Resume; no card', { ...READY_STATE(), paused: true }, 'is paused'],
  ['region-blocked', 'Last message failed (region blocked, no rt state; from the backend’s last failure): Pick another AI', { ...OPENAI_STATE(), lastError: { kind: 'region_blocked', at: Date.UTC(2026, 8, 26, 9) } }, 'One thing needs you'],
  ['identifier-blocked', 'Last message failed (OpenAI blocked this install): why, Pick another AI, Open Diagnostics', { ...OPENAI_STATE(), lastError: { kind: 'identifier_blocked', at: Date.UTC(2026, 8, 26, 9) } }, 'One thing needs you'],
  ['spend-limit', 'Last message failed (the spend limit set at Anthropic): Open Anthropic’s limits page, Test key (a pass clears it)', { ...READY_STATE(), lastError: { kind: 'spend_limit', at: Date.UTC(2026, 8, 26, 9) } }, 'One thing needs you'],
  ['repeated-error', 'The same failure twice in a row: the card, Open Last request', { ...READY_STATE(), lastError: { kind: 'bad_request', at: Date.UTC(2026, 8, 26, 9), streak: 2 } }, 'One thing needs you'],
]);
function OPENAI_STATE() { return { keys: { openai: { masked: 'sk-proj-…xxxx', state: 'ok' } }, choice: { provider: 'openai', model: 'gpt-6-luna', effort: 'low' }, addonInstalled: true }; }
function HAIKU_CHOICE() { return { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null }; }
function READY_STATE() { return { keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } }, choice: HAIKU_CHOICE(), addonInstalled: true }; }

// ---------------------------------------------------------------------------
// The scenes. Each: id, caption, the mock state, then what a player does (d is the driver).

// ---------------------------------------------------------------------------
// Setup's scenes (the redesign's spec §6.1): step 2 "Connect your AI" with every key result, Other's
// form, step 3 "Set up WoW" with every objective state, and "You're set". Keys are canaries; a
// result a test can't reach with a canary is the mock's forced result for that call, through the
// real IPC.

export const FAKE_OPENAI_KEY = `sk-proj-CANARY${'x'.repeat(60)}`;
export const FAKE_XAI_KEY = `xai-CANARY${'x'.repeat(40)}`;
export const FAKE_OPENROUTER_KEY = `sk-or-v1-CANARY${'x'.repeat(56)}`;
export const FAKE_GOOGLE_KEY = `AIzaCANARY${'x'.repeat(29)}`;
const NOCREDIT_KEY = `sk-ant-api03-CANARY${'x'.repeat(70)}NOCREDIT`;
const NOCREDIT_XAI = `xai-CANARY${'x'.repeat(30)}NOCREDIT`;
const SUB_TOKEN = `sk-ant-oat01-CANARY${'x'.repeat(60)}`;
const ADMIN_KEY = `sk-ant-admin01-CANARY${'x'.repeat(60)}`;
const SAVED_ANTHROPIC = { anthropic: { masked: 'sk-ant-…xxxx', state: 'ok' } };
const REJECTED_ANTHROPIC = { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } };
const HAIKU_CHOSEN = { provider: 'anthropic', model: 'claude-haiku-4-5', effort: null };
/** A player who connected Claude: setup opens on Set up WoW. */
const AT_WOW = { keys: SAVED_ANTHROPIC, choice: HAIKU_CHOSEN, terms: { anthropic: 1 } };
const WOW_APP = { defaultsSeen: true, setup: { v: 2, screen: 'wow', path: 'key', provider: 'anthropic' } };
/** A player who set up: the window's own settings once setup is done (onboarded, the defaults seen). */
const ONBOARDED = Object.freeze({ onboarded: true, defaultsSeen: true });
/** Run setup again: step 2, with an AI already connected. */
const AT_AI = { setup: { v: 2, screen: 'ai', path: 'key', provider: null } };
const INSTALLED = { addonInstalled: true };
const HELLO = { at: Date.UTC(2026, 8, 27, 9), sig: 'ok', mode: 'pixel', via: 'strip', iface: '11507', loc: 'enUS', fr: false };
const FIRST_WORDS = 'Well met. Turn in The Hunt Begins to Baine Bloodhoof first, then take the kodo quest before you leave Camp Narache.';
const RUNNING = { wow: { found: true, running: true } };
// The route on the map (CL-design-41): Home in game leads with its next stop.
const ROUTE = { next: 'The Hunt Begins', stops: 7, title: 'Camp Narache' };

/** The press-and-push scenes: mark the control, count its clicks, and say where to press it. */
const PRESS_WATCH = fk => `(() => { const b = document.querySelector('[data-fk="${fk}"]'); b.__pressed = 1; window.__pressClicks = 0; document.addEventListener('click', e => { if (e.target && e.target.closest && e.target.closest('[data-fk="${fk}"]')) window.__pressClicks += 1; }, true); const q = b.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; })()`;
const PRESS_KEPT = fk => `(() => { const b = document.querySelector('[data-fk="${fk}"]'); return b ? b.__pressed === 1 : 'gone'; })()`;
/** Where ‹ Back to setup is on arrival at a page setup opened, and how far the page scrolled. */
// The sheet's Where-it-goes picture, scrolled to the sheet's top edge (APP-D-45's proof at zoom 3).
const FLOW_IN_VIEW = `(() => { const f = document.querySelector('#sheet-host .sheet-flow'); if (!f) return null; f.scrollIntoView({ block: 'start' }); const r = f.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), stacked: getComputedStyle(f).display !== 'grid' || getComputedStyle(f).gridTemplateColumns.split(' ').length < 3 }; })()`;
const BACK_IN_VIEW = `(() => { const b = document.querySelector('[data-fk="back-to-setup"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), inView: r.top >= 0 && r.bottom <= innerHeight, scroll: Math.round(document.getElementById('page').scrollTop) }; })()`;

async function toStep2(d) { await d.load('setup'); await d.clickFkIf('start-setup'); await d.waitText('Connect your AI'); }
/** The welcome a first setup opens on. */
async function toWelcome(d) { await d.load('setup'); await d.waitText('Set up'); }
async function pick(d, id) { await toStep2(d); if (id && id !== 'anthropic') await d.clickFk(`card-${id}`); }
async function pasteOn(d, key) { d.setClipboard(key); await d.clickFk('paste-key'); }
async function toStep3(d) { await d.load('setup'); await d.waitText('Set up WoW'); }
/** Other's form (step 2's fifth row). */
async function toCustom(d) { await pick(d, 'custom'); await d.clickFk('set-up-other'); await d.waitText('Base URL'); }
/** Other's form filled in the way a player types it (the key field only when a key is given). */
async function fillCustom(d, url, model, key = null) { await d.input('custom-url', url); await d.input('custom-model', model); if (key) await d.input('custom-key', key); }
/** Show details: the sheet, scoped to what's picked. */
async function details(d) { await d.clickFk('details'); await d.waitSel('#sheet-title'); }

/** A forced test result (the mock's testStagedKey), then Paste on step 2 for provider. */
function testResult(id, caption, res, { provider = 'anthropic', key = null, wait, extra = {} } = {}) {
  return {
    id: `setup-s2-${id}`, caption: `Connect your AI, ${provider === 'openai' ? 'ChatGPT' : provider === 'xai' ? 'Grok' : 'Claude'}: ${caption}`,
    state: { results: { testStagedKey: { ok: false, documented: false, inferred: false, tier: false, ...res } }, ...extra },
    run: async (d) => { await pick(d, provider); await pasteOn(d, key ?? (provider === 'openai' ? FAKE_OPENAI_KEY : provider === 'xai' ? FAKE_XAI_KEY : FAKE_KEY)); await d.waitText(wait); },
  };
}

export function setupScenes() {
  const list = [];
  // Step 2: "Connect your AI".
  list.push(
    { id: 'setup-welcome', caption: 'The welcome (a first run): Meet NeverQuestAlone, what he does for your questing, his window in WoW with a priority route, Set up NeverQuestAlone', state: {}, run: toWelcome },
    { id: 'setup-welcome-narrow', caption: 'The welcome at 760×540', size: [760, 540], state: {}, run: toWelcome },
    { id: 'setup-s2-no-key', caption: 'Step 2, No key yet? open: the picked AI’s key in four numbered steps', state: {}, run: async (d) => { await toStep2(d); await d.clickFk('no-key'); await d.waitText('Come back to this window'); } },
    { id: 'setup-s2-fresh', caption: 'Step 2 Connect your AI: the tracker, five rows (Claude picked), Paste Anthropic key ⌘V, Open Anthropic’s key page, Show details', state: {}, run: toStep2 },
    { id: 'setup-s2-narrow', caption: 'Step 2 at 760×540', size: [760, 540], state: {}, run: toStep2 },
    { id: 'setup-s2-zoom15', caption: 'Step 2 at the app’s zoom level 1.5 (131%)', state: {}, appState: { zoom: 1.5 }, run: toStep2 },
    { id: 'setup-s2-zoom3', caption: 'Step 2 at the app’s largest zoom (level 3, 173%): no sideways scroll', state: {}, appState: { zoom: 3 }, run: toStep2 },
    { id: 'setup-s2-narrow-zoom', caption: 'Step 2 at 760×540 and zoom level 1.5', size: [760, 540], state: {}, appState: { zoom: 1.5 }, run: toStep2 },
    { id: 'setup-s2-narrow-zoom3', caption: 'Step 2 at 760×540 and zoom level 3', size: [760, 540], state: {}, appState: { zoom: 3 }, run: toStep2 },
    { id: 'setup-s2-details', caption: 'Step 2, Show details: the sheet “Claude, in detail” over the stage (cost, your key, what leaves your Mac, where it’s kept, terms, the fine print)', state: {}, run: async d => { await toStep2(d); await details(d); } },
    { id: 'setup-s2-details-narrow', caption: 'Step 2’s sheet at 760×540: it scrolls inside itself, the page doesn’t', size: [760, 540], state: {}, run: async d => { await toStep2(d); await details(d); } },
    { id: 'setup-s2-details-narrow-zoom3', caption: 'Step 2’s sheet at 760×540 and zoom level 3: the picture’s ends stack, nothing cut (APP-D-45; scrolled to the picture)', size: [760, 540], state: {}, appState: { zoom: 3 }, run: async d => { await toStep2(d); await details(d); d.note({ flow: await d.evalJs(FLOW_IN_VIEW) }); } },
    { id: 'setup-s2-chatgpt', caption: 'Step 2 with ChatGPT picked: ChatGPT needs an API key and credit at OpenAI.', state: {}, run: d => pick(d, 'openai') },
    { id: 'setup-s2-chatgpt-details', caption: 'Step 2, ChatGPT’s sheet: its extras (credit first)', state: {}, run: async d => { await pick(d, 'openai'); await details(d); } },
    { id: 'setup-s2-grok-details', caption: 'Step 2, Grok’s sheet: its note on refused requests', state: {}, run: async d => { await pick(d, 'xai'); await details(d); } },
    { id: 'setup-s2-gemini-details', caption: 'Step 2, Gemini’s sheet: billing and the 18+ note', state: {}, run: async d => { await pick(d, 'google'); await details(d); } },
    { id: 'setup-s2-other', caption: 'Step 2 with Other picked: Price varies, Set up Other', state: {}, run: d => pick(d, 'custom') },
    { id: 'setup-s2-windows', platform: 'win32', caption: 'Step 2 on Windows: Ctrl+V', state: {}, run: toStep2 },
    { id: 'setup-s2-windows-details', platform: 'win32', info: { workPc: true }, caption: 'Step 2’s sheet on Windows, a work PC: Windows Credential Manager and the roaming line', state: {}, run: async d => { await toStep2(d); await details(d); } },
    { id: 'setup-s2-move', caption: 'Step 2 with Move NeverQuestAlone to Applications above the title (the app runs from Downloads)', state: {}, info: { inApplications: false }, run: toStep2 },
    { id: 'setup-s2-engine-error', caption: 'Step 2 when another copy is open: the banner above, Quit this copy', state: {}, apiMode: 'error', run: async (d) => { await d.load('setup'); await d.waitText('Quit this copy'); } },
    { id: 'setup-s2-saved-key', caption: 'Step 2 returning with a key saved: the row’s Key saved, Use saved key, Paste new key', state: { keys: SAVED_ANTHROPIC, terms: { anthropic: 1 } }, run: toStep2 },
    { id: 'setup-s2-returning', caption: 'Step 2 returning, Claude in use: Use saved key first, Paste new key second', state: { keys: SAVED_ANTHROPIC, terms: { anthropic: 1 }, choice: HAIKU_CHOSEN }, appState: AT_AI, run: toStep2 },
    { id: 'setup-s2-rejected-key', caption: 'Step 2 with a saved key Anthropic rejected: the row’s Key rejected, Paste new key is the primary', state: { keys: REJECTED_ANTHROPIC, terms: { anthropic: 1 } }, run: async (d) => { await toStep2(d); await d.waitText('Key rejected'); } },
    { id: 'setup-s2-returning-no-credit', caption: 'Step 2 returning with a key saved while the account had no credit: No credit, Add credit (the fix, first), Test again', state: { keys: SAVED_ANTHROPIC, terms: { anthropic: 1 }, keyState: { anthropic: 'no_credit' } }, run: async (d) => { await toStep2(d); await d.waitText('No credit'); } },
    { id: 'setup-s2-custom-set', caption: 'Step 2 with Other connected to openrouter.ai: its row says the service, Connected, Continue', state: { ...CUSTOM_REMOTE_STATE() }, appState: AT_AI, run: async (d) => { await toStep2(d); await d.waitText('openrouter.ai'); } },
    { id: 'setup-s2-grok-hidden', caption: 'Step 2 with Grok hidden by the data file: four rows', state: { hidden: ['xai'] }, run: toStep2 },
    { id: 'setup-s2-hidden-resume', caption: 'Step 2 on a reopen whose saved AI was Grok, now hidden: the line says so', state: { hidden: ['xai'] }, appState: { setup: { v: 2, screen: 'connect', path: 'key', provider: 'xai' } }, run: async (d) => { await toStep2(d); await d.waitText('isn’t available right now'); } },
    { id: 'setup-s2-checking', caption: 'Step 2, Paste agreed, the one test request running: Checking with Anthropic…', state: {}, run: async (d) => { await toStep2(d); d.hold('testStagedKey'); d.setClipboard(FAKE_KEY); await d.clickFk('paste-key'); await d.waitText('Checking with Anthropic…'); } },
    { id: 'setup-s2-ok', caption: 'After a good key: Set up WoW opens with “Claude is connected.” under its title', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_KEY); await d.waitText('is connected'); } },
    { id: 'setup-s2-ok-narrow', caption: 'Step 2, Claude is connected, at 760×540', size: [760, 540], state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_KEY); await d.waitText('is connected'); } },
    { id: 'site-setup-picture', caption: 'The landing page’s and the README’s Set up picture (site/tools/make-app-scene.mjs): step 2, Claude is connected, at 760×540 and 100%, the version in the foot hidden so the picture never shows an old one', size: [760, 540], state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_KEY); await d.waitText('is connected'); await d.evalJs("document.styleSheets[0].insertRule('.foot-ver { visibility: hidden; }', document.styleSheets[0].cssRules.length), true"); } },
    { id: 'setup-s2-ok-narrow-zoom1', caption: 'Step 2, Claude is connected, at 760×540 and the app’s 120% zoom (level 1)', size: [760, 540], state: {}, appState: { zoom: 1 }, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_KEY); await d.waitText('is connected'); } },
    { id: 'setup-s2-gemini-ok', caption: 'Step 2, a key from Google pasted with Claude picked: Paste detects it, Gemini’s row is picked, ✓ Gemini is connected', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_GOOGLE_KEY); await d.waitText('Gemini is connected'); } },
    { id: 'setup-s2-mismatch', caption: 'Step 2, a key from OpenAI with Claude picked: Paste detects it, ChatGPT is connected (no “Use ChatGPT instead” step)', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_OPENAI_KEY); await d.waitText('ChatGPT is connected'); } },
    { id: 'setup-s2-openrouter-key', caption: 'Step 2, an OpenRouter key: Other’s form opens with OpenRouter’s address and the key filled in', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_OPENROUTER_KEY); await d.waitText('Base URL'); } },
    { id: 'setup-s2-not-a-key', caption: 'Step 2, text that isn’t a key: what a key from Anthropic starts with', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, 'where do I turn in this quest'); await d.waitText('keys start with'); } },
    { id: 'setup-s2-clipboard-empty', caption: 'Step 2, an empty clipboard', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, ''); await d.waitText('Your clipboard is empty'); } },
    { id: 'setup-s2-cancelled', caption: 'Step 2, the dialog cancelled: Nothing was sent or saved (focus back on Paste)', state: {}, run: async (d) => { await toStep2(d); d.setClipboard(FAKE_KEY); const spec = d.nextConfirm(); await d.clickFk('paste-key'); await spec.shown; spec.answer(false); await d.waitText('Not connected'); } },
    { id: 'setup-s2-subscription', caption: 'Step 2, a Claude sign-in token: not an API key, Paste Anthropic key', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, SUB_TOKEN); await d.waitText('not an API key'); } },
    { id: 'setup-s2-admin', caption: 'Step 2, an admin key', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, ADMIN_KEY); await d.waitText('account admins'); } },
    { id: 'setup-s2-mismatch-gemini', caption: 'Step 2, a key from Google with ChatGPT picked: Gemini’s row picked, connected', state: {}, run: async (d) => { await pick(d, 'openai'); await pasteOn(d, FAKE_GOOGLE_KEY); await d.waitText('Gemini is connected'); } },
    { id: 'setup-s2-auth-invalid', caption: 'Step 2, Anthropic didn’t accept the key: Paste new key', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_BAD_KEY); await d.waitText('didn’t accept that key'); } },
    { id: 'setup-s2-out-of-credit', caption: 'Step 2, the key works but the account has no credit (saved, T1): Add credit (the fix, first), Test again, Continue anyway', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, NOCREDIT_KEY); await d.waitText('Your account has no credit'); } },
    ...[['still-no-credit', 'out_of_credit', 'Still no credit', 'still no credit'],
      ['overloaded', 'overloaded', 'is busy', 'Anthropic busy'],
      ['network', 'network_before_send', 'Can’t reach', 'the connection dropped'],
      ['rejected', 'auth_invalid', 'didn’t accept that key', 'the key was revoked: Paste new key'],
    ].map(([id, error, wait, caption]) => ({ id: `setup-s2-retest-${id}`, caption: `Step 2, no credit, then Test again: ${caption} (never “no credit” for another kind)`, state: {}, run: async (d) => {
      await toStep2(d); await pasteOn(d, NOCREDIT_KEY); await d.waitText('Your account has no credit');
      await d.patch({ results: { testKey: { ok: false, error } } });
      await d.clickFk('test-again'); await d.waitText(wait);
    } })),
    { id: 'setup-s2-out-of-credit-held', caption: 'Step 2, Grok: no credit, inferred (held 30 minutes): Add credit, Test again', state: {}, run: async (d) => { await pick(d, 'xai'); await pasteOn(d, NOCREDIT_XAI); await d.waitText('has no credit'); } },
    testResult('terms-required', 'the terms need agreeing again: Connect', { error: 'terms_required' }, { wait: 'Agree to' }),
    testResult('spend-limit', 'the spend limit set at Anthropic: Open Anthropic’s limits page, Test again', { error: 'spend_limit' }, { wait: 'spend limit' }),
    testResult('spend-limit-tier', 'the account’s monthly tier cap', { error: 'spend_limit', tier: true, resetAt: Date.UTC(2026, 9, 1) }, { wait: 'monthly limit' }),
    testResult('workspace', 'a key with no workspace', { error: 'workspace_required' }, { wait: 'Make a new key on' }),
    testResult('model-access', 'a key that can’t use the model', { error: 'model_access', model: 'Claude Haiku 4.5' }, { wait: 'can’t use that model' }),
    testResult('key-restricted', 'ChatGPT: a key not allowed to send messages', { error: 'key_restricted' }, { provider: 'openai', wait: 'can’t send messages' }),
    testResult('org-verification', 'ChatGPT: OpenAI wants the organization verified: Open OpenAI’s settings page, Test again', { error: 'org_verification', model: 'GPT-6 Luna' }, { provider: 'openai', wait: 'verify your account' }),
    testResult('region', 'Anthropic’s API isn’t available here: Pick another AI, no Paste', { error: 'region_blocked' }, { wait: 'where you are' }),
    testResult('rate-limited', 'Anthropic is limiting this key: Test again in a minute', { error: 'rate_limited' }, { wait: 'is limiting this key' }),
    testResult('overloaded', 'Anthropic is busy: Test again', { error: 'overloaded' }, { wait: 'is busy' }),
    testResult('network', 'can’t reach Anthropic: check your internet, Test again', { error: 'network' }, { wait: 'Can’t reach' }),
    testResult('failed', 'something went wrong with Anthropic (the unknown case): Test again', { error: 'failed' }, { wait: 'Something went wrong' }),
    testResult('stage-expired', 'the pasted key was cleared from memory', { error: 'stage_expired' }, { wait: 'expired' }),
    testResult('busy', 'another dialog is open', { error: 'busy' }, { wait: 'Finish the open dialog first' }),
    { id: 'setup-s2-keystore', caption: 'Step 2, the key works but the Keychain didn’t save it: Save again', state: { results: { connect: { ok: false, error: 'keystore_error' } } }, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_KEY); await d.waitText('wasn’t saved'); } },
    { id: 'setup-s2-read-failed', caption: 'Step 2 returning: Use saved key, the Keychain wouldn’t read it', state: { keys: SAVED_ANTHROPIC, terms: { anthropic: 1 }, results: { useSavedKey: { ok: false, error: 'read_failed' } } }, run: async (d) => { await toStep2(d); await d.clickFk('use-saved'); await d.waitText('couldn’t be read'); } },
    { id: 'setup-s2-windows-ok', platform: 'win32', caption: 'Step 2 on Windows: Claude is connected', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_KEY); await d.waitText('is connected'); } },
    { id: 'setup-s2-fit-windows-work-pc-no-credit', platform: 'win32', info: { workPc: true }, caption: 'Step 2 fit on Windows: no credit (Add credit, Test again, Continue anyway)', size: [760, 540], state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, NOCREDIT_KEY); await d.waitText('Your account has no credit'); } },
  );
  // The dialogs, drawn over the page as previews (the real ones are macOS sheets).
  const dialog = (id, caption, state, go, appState = null) => ({
    id: `setup-dialog-${id}`, caption: `Dialog: ${caption} (main’s native confirm, its words drawn as a preview)`, state, ...(appState ? { appState } : {}),
    run: async (d) => { const spec = d.nextConfirm(); await go(d); await d.drawConfirm(await spec.shown); d.afterShot(() => { spec.answer(false); return d.clearConfirm(); }); },
  });
  list.push(
    dialog('connect', 'Connect Claude with this key? (first key, from the clipboard)', {}, async (d) => { await toStep2(d); d.setClipboard(FAKE_KEY); await d.clickFk('paste-key'); }),
    dialog('replace', 'Replace your Anthropic key?', { keys: SAVED_ANTHROPIC, terms: { anthropic: 1 }, choice: HAIKU_CHOSEN }, async (d) => { await toStep2(d); d.setClipboard(FAKE_KEY); await d.clickFk('paste-key'); }, AT_AI),
    dialog('switch', 'Switch NeverQuestAlone to ChatGPT with this key? (Claude in use)', { keys: SAVED_ANTHROPIC, terms: { anthropic: 1 }, choice: HAIKU_CHOSEN }, async (d) => { await pick(d, 'openai'); d.setClipboard(FAKE_OPENAI_KEY); await d.clickFk('paste-key'); }, AT_AI),
    dialog('use-saved', 'Use your saved Anthropic key? (no terms recorded)', { keys: SAVED_ANTHROPIC, terms: {} }, async (d) => { await toStep2(d); await d.clickFk('use-saved'); }),
    dialog('custom', 'Connect NeverQuestAlone to openrouter.ai? (Other, with a key)', {}, async (d) => { await toCustom(d); await fillCustom(d, 'https://openrouter.ai/api/v1', 'openai/gpt-5-mini', FAKE_OPENROUTER_KEY); await d.clickFk('custom-go'); }),
    dialog('custom-local', 'Connect NeverQuestAlone to localhost:11434? (Other, a server on this Mac)', {}, async (d) => { await toCustom(d); await fillCustom(d, 'http://localhost:11434/v1', 'qwen3:8b'); await d.clickFk('custom-go'); }),
  );
  // 6.1.2 Other: any OpenAI-compatible service at its own address.
  const custom = (id, caption, url, model, key, wait, state = {}) => ({ id: `setup-custom-${id}`, caption: `Connect another AI: ${caption}`, state, run: async (d) => { await toCustom(d); await fillCustom(d, url, model, key); await d.clickFk('custom-go'); await d.waitText(wait); } });
  list.push(
    { id: 'setup-custom-empty', caption: 'Connect another AI: Base URL, API key (optional), Model, Connect, Show details', state: {}, run: toCustom },
    { id: 'setup-custom-narrow', caption: 'Connect another AI at 760×540', size: [760, 540], state: {}, run: toCustom },
    { id: 'setup-custom-details', caption: 'Connect another AI, Show details: what works with it, the key, what leaves', state: {}, run: async d => { await toCustom(d); await details(d); } },
    { id: 'setup-custom-from-openrouter-key', caption: 'Connect another AI after an OpenRouter key: OpenRouter’s address and the key filled in', state: {}, run: async (d) => { await toStep2(d); await pasteOn(d, FAKE_OPENROUTER_KEY); await d.waitText('Base URL'); } },
    custom('ok', '✓ Connected to openrouter.ai, Continue', 'https://openrouter.ai/api/v1', 'openai/gpt-5-mini', FAKE_OPENROUTER_KEY, 'Connected to openrouter.ai'),
    custom('ok-local', '✓ localhost:11434 is running with qwen3:8b', 'http://localhost:11434/v1', 'qwen3:8b', null, 'localhost:11434 is running with'),
    custom('https', 'http off this computer: Use an https address', 'http://192.168.1.20:11434/v1', 'qwen3:8b', null, 'https address'),
    custom('network', 'the service can’t be reached', 'https://down.example.com/v1', 'qwen3:8b', null, 'Can’t reach'),
    custom('auth', 'the service rejected the key', 'https://openrouter.ai/api/v1', 'openai/gpt-5-mini', `${FAKE_OPENROUTER_KEY}BADKEY`, 'didn’t accept that key'),
    custom('model', 'the service doesn’t offer the model', 'https://openrouter.ai/api/v1', 'missing', FAKE_OPENROUTER_KEY, 'doesn’t offer that model'),
    { id: 'setup-custom-windows', platform: 'win32', caption: 'Connect another AI on Windows', state: {}, run: toCustom },
  );
  // Step 3: "Set up WoW", each objective's states.
  const wow = (id, caption, state, wait, { platform = null, extraRun = null, info = null, size = null } = {}) => ({
    id: `setup-s4-${id}`, caption: `Step 3 Set up WoW: ${caption}`, state: { ...AT_WOW, ...state }, appState: WOW_APP, ...(platform ? { platform } : {}), ...(info ? { info } : {}), ...(size ? { size } : {}),
    run: async (d) => { await toStep3(d); if (extraRun) await extraRun(d); if (wait) await d.waitText(wait); },
  });
  list.push(
    wow('fresh', 'WoW found and closed: Install is the one primary', {}, 'Found World of Warcraft: Forever'),
    wow('details', 'Show details: what the addon does, what Screen Recording is for, saying hi', {}, null, { extraRun: details }),
    wow('allow-press-push', 'Allow pressed while an unrelated push comes in (notes: the click counts, the node stays)', INSTALLED, null, { extraRun: async (d) => {
      await d.waitText('Never keeps or sends pictures');
      const at = await d.evalJs(PRESS_WATCH('row-primary'));
      await d.mouse('mousePressed', at[0], at[1]);
      await d.push({ game: { facts: { frames: 41 } } });
      await d.wait(400);
      const kept = await d.evalJs(PRESS_KEPT('row-primary'));
      await d.mouse('mouseReleased', at[0], at[1]);
      await d.wait(400);
      d.note({ pressAcrossPush: { sameNodeDuringPress: kept, clicks: await d.evalJs('window.__pressClicks') } });
    } }),
    wow('narrow', 'at 760×540', {}, 'Found World of Warcraft: Forever', { size: [760, 540] }),
    wow('wow-open', 'WoW open on arrival: Install when WoW closes', RUNNING, 'WoW is open.'),
    wow('armed', 'armed: installs when you quit WoW, Cancel; Allow is the current row', { ...RUNNING, armed: '/Applications/World of Warcraft/_forever_' }, 'Installs when you quit WoW'),
    wow('armed-granted', 'armed with Screen Recording on: the install stays the current row, row 3 its title alone (ON-22)', { ...RUNNING, armed: '/Applications/World of Warcraft/_forever_', permission: 'granted' }, 'Installs when you quit WoW'),
    wow('windows-armed', 'on Windows, armed: the install the current row, row 3 says Start WoW again once it closes (ON-22)', { ...RUNNING, armed: 'C:\\Program Files (x86)\\World of Warcraft\\_forever_' }, 'once it closes', { platform: 'win32' }),
    wow('windows-waiting', 'on Windows, the addon in, WoW running: the reading row its title alone (ON-21)', { ...INSTALLED, ...RUNNING }, 'Waiting for the addon', { platform: 'win32' }),
    wow('armed-asked', 'armed and Screen Recording asked: Open System Settings is the one primary', { ...RUNNING, armed: '/Applications/World of Warcraft/_forever_', permission: 'asked' }, 'then turn on NeverQuestAlone'),
    wow('installing', 'installing', { addonState: 'installing' }, 'Installing…'),
    wow('installed', 'the addon in; Allow is the current row', INSTALLED, 'Never keeps or sends pictures'),
    wow('installed-narrow', 'the addon in at 760×540: Allow’s line (what screen reading reads) fits', INSTALLED, 'Never keeps or sends pictures', { size: [760, 540] }),
    wow('installed-narrow-zoom3', 'the addon in at 760×540 and zoom level 3: Allow’s line wraps, nothing scrolls sideways', INSTALLED, 'Never keeps or sends pictures', { size: [760, 540] }),
    wow('several', 'two copies of WoW: Forever: the folder and Install on one line', { wow: { found: true, installs: [{ path: '/Applications/World of Warcraft/_forever_', version: '1.60.1.70009' }, { path: '/Volumes/Games/World of Warcraft/_forever_', version: '1.60.1.70009' }] } }, 'copies of WoW: Forever found'),
    wow('not-found', 'WoW not found: Choose WoW folder…, Check again', { wow: { found: false, running: false } }, 'Couldn’t find World of Warcraft: Forever'),
    wow('bad-folder', 'a folder that isn’t WoW', { addonState: 'bad_folder' }, 'isn’t WoW: Forever'),
    wow('race', 'WoW started while the addon installed', { addonState: 'race' }, 'mid-install'),
    wow('older', 'the addon needs an update: Update', { addonState: 'older' }, 'needs an update'),
    wow('eperm', 'the AddOns folder isn’t writable (Mac): Choose another folder…; what to ask an administrator for is in Show details', { addonState: 'eperm' }, 'can’t write to AddOns'),
    wow('eperm-details', 'the AddOns folder isn’t writable: Show details says what to ask for', { addonState: 'eperm' }, null, { extraRun: details }),
    wow('eperm-windows', 'the AddOns folder isn’t writable (Windows): the icacls command in Show details', { addonState: 'eperm', setup: { addon: { admin: { command: 'icacls "C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns" /inheritance:d /grant:r *S-1-5-32-545:(OI)(CI)RX *S-1-5-21-1111111111-2222222222-3333333333-1001:(OI)(CI)M', explanation: 'Stops other accounts from changing the AddOns folder; yours still can.' } } } }, null, { platform: 'win32', extraRun: details }),
    wow('eperm-no-sid', 'the AddOns folder isn’t writable and no command can be made (Windows)', { addonState: 'eperm' }, 'can’t write to AddOns', { platform: 'win32' }),
    wow('disk-full', 'no free space for the addon: Install again', { addonState: 'disk_full' }, 'No free space'),
    wow('install-failed', 'the install failed: Install again, Copy diagnostics', { addonState: 'failed' }, 'didn’t install'),
    wow('others-can-write', 'installed, other accounts can change WoW’s addons (Open Diagnostics)', { ...INSTALLED, setup: { addon: { othersCanWrite: true } } }, 'Other accounts can change'),
    wow('permission-asked', 'Screen Recording asked: Open System Settings', { ...INSTALLED, permission: 'asked' }, 'then turn on NeverQuestAlone'),
    wow('permission-denied', 'Screen Recording denied', { ...INSTALLED, permission: 'denied' }, 'Screen Recording is off.'),
    wow('permission-denied-mac14', 'Screen Recording denied on macOS 14 (the pane’s path in Show details)', { ...INSTALLED, permission: 'denied' }, null, { info: { osRelease: '23.6.0' }, extraRun: details }),
    wow('no-reading-open', 'Skip screen reading? open (after macOS said no): Turn off screen reading, one click', { ...INSTALLED, permission: 'denied' }, 'messages then wait', { extraRun: d => d.clickFk('no-reading') }),
    wow('granted', 'Screen Recording on; row 3: the steps in game, Open Battle.net', { ...INSTALLED, permission: 'granted' }, 'Log in.'),
    wow('waiting', 'WoW running, no hello yet: Waiting for the addon…, Still waiting?', { ...INSTALLED, permission: 'granted', ...RUNNING }, 'Waiting for the addon'),
  );
  for (const [cause, facts, wait, onlyOn] of [
    ['no-decode', { permission: 'granted', setup: { game: { facts: { window: true, frames: 40, decoded: 0 } } } }, 'starts once you’re in the world'],
    ['minimized', { permission: 'granted', setup: { game: { facts: { typedError: 'window_minimized' } } } }, 'WoW is minimized', 'win32'],
    ['blocked', { permission: 'granted', setup: { game: { facts: { typedError: 'capture_blocked_by_app' } } } }, 'blocks screen reading'],
    ['no-window', { permission: 'granted', setup: { game: { facts: { window: false, frames: 0 } } } }, 'can’t find WoW’s window'],
  ]) {
    list.push(wow(`why-${cause}`, `Still waiting? open: ${cause.replace(/-/g, ' ')}`, { ...INSTALLED, ...RUNNING, ...facts }, wait, { extraRun: d => d.clickFk('still-waiting'), platform: onlyOn ?? null }));
  }
  list.push(
    wow('hello', 'the hello came: You’re set (NeverQuestAlone is in your game)', { ...INSTALLED, permission: 'granted', ...RUNNING, setup: { game: { hello: HELLO } } }, 'is in your game'),
    wow('iface-mismatch', 'WoW updated and the addon needs one too: the banner, its fix', { ...INSTALLED, permission: 'granted', ...RUNNING, setup: { game: { ifaceMismatch: true } } }, 'out of date'),
    wow('damaged', 'a file damaged or unsigned: the banner, Open download page', { ...INSTALLED, permission: 'granted', setup: { captureState: 'damaged' } }, 'is damaged'),
    wow('no-credit', 'the key saved with no credit: the banner above the list (Add credit, Test again), the tracker says it', { ...INSTALLED, keyState: { anthropic: 'no_credit' } }, 'No credit at'),
    wow('windows', 'on Windows: no Screen Recording row; Open Battle.net tucks the window away', INSTALLED, 'Log in.', { platform: 'win32' }),
    wow('windows-fresh', 'on Windows, WoW found: Install', {}, 'Found World of Warcraft: Forever', { platform: 'win32' }),
    wow('no-reading-done', 'Skip screen reading? then Turn off screen reading: the row is done, Screen reading off.', { ...INSTALLED, permission: 'denied' }, 'Screen reading off', { extraRun: async d => { await d.clickFk('no-reading'); await d.clickFk('reading-off'); } }),
    wow('windows-no-reading-open', 'on Windows, before the addon is in: Skip screen reading? open', {}, 'messages then wait', { platform: 'win32', extraRun: d => d.clickFk('no-reading') }),
    wow('card-key-rejected', 'the saved key rejected: the banner above the list (Replace key)', INSTALLED, 'rejected your key', { extraRun: d => d.patch({ keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } }) }),
    wow('card-local-down', 'the server on this Mac stopped: the banner (Check again)', { ...INSTALLED, ...CUSTOM_LOCAL_STATE(), keys: {}, rt: { state: 'local_down' } }, 'Can’t reach localhost:11434'),
    wow('reopen-rejected', 'reopened after the key was rejected: Set up WoW with the banner (Replace key is the primary)', { keys: REJECTED_ANTHROPIC }, 'rejected your key'),
    wow('card-passed-credit', 'the no-credit banner’s Test again passes: ✓ Claude is connected. in its place, focus on Install', { keyState: { anthropic: 'no_credit' }, creditLanded: true }, 'Claude is connected', { extraRun: async d => { await d.waitText('No credit at'); await d.clickFk('card-test'); } }),
    wow('card-passed-local', 'the local server’s banner: Check again finds it running', { ...INSTALLED, ...CUSTOM_LOCAL_STATE(), keys: {}, rt: { state: 'local_down' } }, 'localhost:11434 is running with', { extraRun: async d => { await d.waitText('Can’t reach localhost:11434'); await d.clickFk('card-check'); } }),
  );
  // The fit combinations: a banner over the list × row 1's state × an open ghost. The fit check
  // measures each at 1000×720 and 760×540.
  const NOCREDIT = { keyState: { anthropic: 'no_credit' } };
  const LOCAL_DOWN = { ...CUSTOM_LOCAL_STATE(), keys: {}, rt: { state: 'local_down' } };
  const TWO = { wow: { found: true, installs: [{ path: '/Applications/World of Warcraft/_forever_', version: '1.60.1.70009' }, { path: '/Volumes/Games/World of Warcraft/_forever_', version: '1.60.1.70009' }] } };
  const HELD = { loginItem: { supported: true, openAtLogin: true, status: 'requires-approval' } };
  const OPEN = { extraRun: d => d.clickFk('no-reading') };
  const EPERM = { addonState: 'eperm' };
  const FAILED = { addonState: 'failed' };
  const TEST_FAILED = async d => { await d.clickFk('card-test'); await d.waitText('Still no credit'); };
  list.push(
    wow('fit-no-credit-fresh', 'fit: no credit, nothing installed yet', NOCREDIT, 'No credit at'),
    wow('fit-local-down-fresh', 'fit: the model app down, nothing installed yet', LOCAL_DOWN, 'Can’t reach localhost:11434'),
    wow('fit-rejected-fresh', 'fit: the key rejected, nothing installed yet', { keys: REJECTED_ANTHROPIC }, 'rejected your key'),
    wow('fit-no-credit-not-found', 'fit: no credit, WoW not found', { ...NOCREDIT, wow: { found: false, running: false } }, 'Couldn’t find World of Warcraft: Forever'),
    wow('fit-no-credit-several', 'fit: no credit, two copies of WoW', { ...NOCREDIT, ...TWO }, 'copies of WoW: Forever found'),
    wow('fit-no-credit-eperm', 'fit: no credit, the AddOns folder can’t be written', { ...NOCREDIT, ...EPERM }, 'can’t write to AddOns'),
    wow('fit-installed-no-reading-open', 'fit: Screen Recording denied, Skip screen reading? open', { ...INSTALLED, permission: 'denied' }, 'messages then wait', OPEN),
    wow('fit-no-credit-installed-no-reading-open', 'fit: no credit, Screen Recording denied, Skip screen reading? open', { ...NOCREDIT, ...INSTALLED, permission: 'denied' }, 'messages then wait', OPEN),
    wow('fit-local-down-installed-no-reading-open', 'fit: the model app down, Screen Recording denied, Skip screen reading? open', { ...LOCAL_DOWN, ...INSTALLED, permission: 'denied' }, 'messages then wait', OPEN),
    wow('fit-rejected-installed-no-reading-open', 'fit: the key rejected, Screen Recording denied, Skip screen reading? open', { keys: REJECTED_ANTHROPIC, ...INSTALLED, permission: 'denied' }, 'messages then wait', OPEN),
    wow('fit-no-credit-failed-copied', 'fit: no credit, the install failed with diagnostics copied', { ...NOCREDIT, ...FAILED }, 'Diagnostics copied', { extraRun: d => d.clickFk('copy-diagnostics') }),
    wow('fit-no-credit-test-failed', 'fit: no credit, the banner’s Test again failed (its still line)', NOCREDIT, null, { extraRun: TEST_FAILED }),
    wow('fit-no-credit-waiting-why', 'fit: no credit, WoW running: row 3 waits behind the card', { ...NOCREDIT, ...INSTALLED, permission: 'granted', ...RUNNING, setup: { game: { facts: { window: true, frames: 40, decoded: 0 } } } }, 'No credit at'),
    wow('fit-narrow-zoom3-no-credit', 'fit: 760×540 and zoom level 3 with no credit: no sideways scroll', NOCREDIT, 'No credit at', { size: [760, 540] }),
  );
  list[list.length - 1].appState = { ...WOW_APP, zoom: 3 };
  list.find(x => x.id === 'setup-s4-installed-narrow-zoom3').appState = { ...WOW_APP, zoom: 3 };
  // You're set, in place.
  // The real finish is the addon's hello alone (since 1.4.8); doneReplied is the rarer one with a first reply.
  const done = { ...INSTALLED, permission: 'granted', ...RUNNING, setup: { game: { hello: HELLO } } };
  const doneReplied = { ...done, setup: { ...done.setup, firstMsgAt: Date.UTC(2026, 8, 27, 9, 1), firstReplyAt: Date.UTC(2026, 8, 27, 9, 1, 8), firstWords: FIRST_WORDS } };
  list.push(
    wow('done-no-credit', 'The hello with no credit: Almost set up, the card above it with Add credit the primary, Open Home quiet, the skull dark', { ...NOCREDIT, ...done }, 'Almost set up'),
    wow('done-replied', 'You’re set after a first reply: ask for a route (Say Hi is gone)', doneReplied, 'for a route', { info: { loginItem: { supported: true, openAtLogin: true, status: 'enabled' } } }),
    wow('done-home', 'Open Home from You’re set (the hello alone): Home, no Finish setup in the nav', done, 'is in game', { info: { loginItem: { supported: true, openAtLogin: true, status: 'enabled' } }, extraRun: d => d.clickFk('home') }),
    wow('done', 'You’re set: in game, Say Hi, then ask for a route; NeverQuestAlone stays in your menu bar, Open Home', done, 'You’re set', { info: { loginItem: { supported: true, openAtLogin: true, status: 'enabled' } } }),
    wow('done-narrow', 'You’re set at 760×540', done, 'You’re set', { size: [760, 540], info: { loginItem: { supported: true, openAtLogin: true, status: 'enabled' } } }),
    wow('done-no-quote', 'You’re set after a restart (no first words kept): the same screen', { ...doneReplied, setup: { ...doneReplied.setup, firstWords: null } }, 'You’re set', { info: { loginItem: { supported: true, openAtLogin: true, status: 'enabled' } } }),
    wow('done-no-login', 'You’re set with start at login off: start it yourself when you play', done, 'Start NeverQuestAlone yourself', { info: { loginItem: { supported: true, openAtLogin: false } } }),
    wow('done-windows', 'You’re set on Windows: the system tray line', done, 'system tray', { platform: 'win32', info: { loginItem: { supported: true, openAtLogin: true } } }),
  );
  // Home after Finish later.
  list.push(
    { id: 'home-finish-no-ai', caption: 'Home after Finish later with no AI: Finish setup, NeverQuestAlone can’t answer yet', state: {}, appState: { onboarded: true, setup: { v: 2, screen: 'ai', path: 'key', provider: null } }, run: async (d) => { await d.load('home'); await d.waitText('can’t answer yet'); } },
    { id: 'home-finish-no-addon', caption: 'Home after Finish later with the AI connected, no addon: The addon isn’t in WoW yet, Finish setup', state: { ...AT_WOW }, appState: { ...WOW_APP, onboarded: true }, run: async (d) => { await d.load('home'); await d.waitText('isn’t in WoW yet'); } },
    { id: 'home-finish-no-screen', caption: 'Home after Finish later, no Screen Recording: NeverQuestAlone can’t see the game yet', state: { ...AT_WOW, ...INSTALLED }, appState: { ...WOW_APP, onboarded: true }, run: async (d) => { await d.load('home'); await d.waitText('can’t see the game yet'); } },
  );
  return list;
}
function CUSTOM_REMOTE_STATE() { return { custom: { baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5-mini' }, keys: { custom: { masked: 'sk-or-…m0ck', state: 'ok' } }, choice: { provider: 'custom', model: 'openai/gpt-5-mini', effort: null }, addonInstalled: true }; }
function CUSTOM_LOCAL_STATE() { return { custom: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b' }, choice: { provider: 'custom', model: 'qwen3:8b', effort: null }, addonInstalled: true }; }

/**
 * lineFor(kind, names) → the desktop §10 line for a kind ({headline, detail, action, line}: the
 * bridge's desktopLine, bridge/byok/app-api.mjs), else the fallback.
 */
export function scenes({ lineFor = null } = {}) {
  const line = (kind, fallback, names = {}, extra = {}) => {
    try { return lineFor?.(kind, names, extra) ?? fallback; } catch { return fallback; }
  };
  const IN_GAME = { ...READY, wow: { ...RUNNING.wow, route: ROUTE } };
  const list = [
    ...setupScenes(),

    // Home (spec §6.2): NeverQuestAlone's condition as the title.
    { id: 'home-in-game', caption: 'Home, in game and all good: NeverQuestAlone is in game, Pause, the route’s next stop (live), the AI and today’s spend', state: IN_GAME, run: async d => { await d.load('home'); await d.waitText('is in game'); } },
    { id: 'home-in-game-narrow', caption: 'Home in game at 760×540', size: [760, 540], state: IN_GAME, run: async d => { await d.load('home'); await d.waitText('is in game'); } },
    { id: 'home-in-game-no-route', caption: 'Home in game before NeverQuestAlone has drawn a route: NeverQuestAlone is in game, Pause, the AI row', state: { ...READY, ...RUNNING }, run: async d => { await d.load('home'); await d.waitText('is in game'); } },
    { id: 'home-wow-closed', caption: 'Home with WoW closed: WoW is closed, Open Battle.net; NeverQuestAlone’s eye dark', state: READY, run: async d => { await d.load('home'); await d.waitText('WoW is closed'); } },
    { id: 'home-limit', caption: 'Home with a daily limit the player set: the spend’s XP bar, of $1.00', state: { ...IN_GAME, ...LIMIT, spentMicros: 420_000 }, run: async d => { await d.load('home'); await d.waitText('is in game'); } },
    { id: 'home-paused', caption: 'Home paused: NeverQuestAlone is paused, Resume is the one primary; NeverQuestAlone’s eye dark', state: { ...READY, paused: true }, run: async d => { await d.load('home'); await d.waitText('is paused'); } },
    { id: 'home-connecting', caption: 'Home while WoW starts and the app looks for what the addon draws at the top of WoW’s window: NeverQuestAlone is joining the game', state: { ...IN_GAME, capture: { state: 'waiting', mode: 'capture', signals: 'unknown', steps: { game: true, strip: false, message: false, reply: false } } }, run: async d => { await d.load('home'); await d.waitText('is joining the game'); } },
    { id: 'home-no-ai', caption: 'Home with no AI and no setup saved', state: {}, run: async d => { await d.load('home'); } },

    { id: 'diagnostics-permissions-fixed', caption: 'Diagnostics: Fix permissions while WoW is open (no reinstall): only your account can change the addon folder now', state: { ...READY, wow: { found: true, running: true }, permissions: LOOSE }, run: async d => { await d.load('diagnostics'); await d.click('Fix permissions'); await d.waitText('Only your account can change the addon folder now'); } },
    { id: 'diagnostics-permissions-copied', caption: 'Diagnostics: the command for an administrator, copied; the command and what it does in Show details', state: { ...READY, permissions: { ...LOOSE, fixable: false } }, run: async d => { await d.load('diagnostics'); await d.click('Copy the command'); await d.waitText('Copied.'); await d.clickFk('perm-details'); await d.waitText('nothing else changes'); } },
    { id: 'diagnostics-permissions-copied-windows', platform: 'win32', caption: 'Diagnostics on Windows: the icacls command, copied; the command and the bridge’s sentence in Show details', state: { ...READY, permissions: { ...LOOSE, paths: ['C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns'], detail: 'Every account on this PC can change the AddOns folder, so another account could run addon code in your game.' } }, run: async d => { await d.load('diagnostics'); await d.click('Copy the command'); await d.waitText('Copied.'); await d.clickFk('perm-details'); await d.waitText('yours still can'); } },
    { id: 'diagnostics-permissions-windows-no-sid', platform: 'win32', caption: 'Diagnostics on Windows when this account’s SID can’t be read: only what to ask an administrator for', state: { ...READY, noSid: true, permissions: { ...LOOSE, paths: ['C:\\Program Files (x86)\\World of Warcraft\\_forever_\\Interface\\AddOns'], detail: 'Every account on this PC can change the AddOns folder, so another account could run addon code in your game.' } }, run: async d => { await d.load('diagnostics'); await d.clickFk('perm-details'); await d.waitText('remove write access for Users'); } },
    { id: 'diagnostics-permissions', caption: 'Diagnostics: the addon folder’s permissions, checked when the page opens', state: { ...READY, permissions: { ...LOOSE, fixable: false } }, run: async d => { await d.load('diagnostics'); await d.waitText('can change your addons'); } },

    // Your AI (spec §6.3).
    { id: 'provider-empty', caption: 'Your AI: no AI yet, Pick an AI', state: {}, run: async d => { await d.load('provider'); await d.waitText('No AI yet'); } },
    { id: 'provider-saved', caption: 'Your AI: Claude, the key saved (Test key, Replace key, Delete key), the Model row (model, thinking, cost a day; Pick a model), today’s spend and the daily limit', state: READY, run: async d => { await d.load('provider'); await d.waitText('Test key'); } },
    { id: 'provider-saved-narrow', caption: 'Your AI at 760×540', size: [760, 540], state: READY, run: async d => { await d.load('provider'); await d.waitText('Test key'); } },
    { id: 'provider-details', caption: 'Your AI, Show details: the same sheet as step 2 for the AI in use, and how spending is counted', state: READY, run: async d => { await d.load('provider'); await details(d); } },
    { id: 'provider-model-open', caption: 'Your AI, Pick a model: the models and Thinking, inside the Model card, behind a click', state: READY, run: async d => { await d.load('provider'); await d.clickFk('model-change'); await d.waitText('Minimal'); } },
    { id: 'provider-model-smarter', caption: 'Your AI: another model picked, its thinking levels with their cost (saves on change: Saved.)', state: READY, run: async d => { await d.load('provider'); await d.clickFk('model-change'); await d.clickSel('[data-fk^="model-"][aria-checked="false"]'); await d.waitText('Saved.'); } },
    { id: 'provider-all-models', caption: 'Your AI with ChatGPT: Show all models open, each model with its one chip (Recommended, Older, Cheapest, Smartest) and its cost a day', state: OPENAI_READY, run: async d => { await d.load('provider'); await d.clickFk('model-change'); await d.clickFk('all-models'); await d.waitText('Show fewer models'); } },
    { id: 'provider-all-models-narrow', caption: 'Your AI with ChatGPT at 760×540: Show all models open', size: [760, 540], state: OPENAI_READY, run: async d => { await d.load('provider'); await d.clickFk('model-change'); await d.clickFk('all-models'); await d.waitText('Show fewer models'); } },
    { id: 'provider-openai-thinking', caption: 'Your AI with ChatGPT: every thinking level GPT-6 Luna has, in one track', state: OPENAI_READY, run: async d => { await d.load('provider'); await d.clickFk('model-change'); await d.waitText('Extra high'); } },
    { id: 'provider-invalid', caption: 'Your AI: the saved key was rejected (Replace key is the primary; Test key says it still is)', state: { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } }, run: async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitText('rejects'); } },
    { id: 'provider-replace-open', caption: 'Your AI, Replace key: Paste key ⌘V or the key field, in the Key row', state: READY, run: async d => { await d.load('provider'); await d.clickFk('key-anthropic'); await d.waitSel('#key-field'); } },
    { id: 'provider-replace-testing', caption: 'Your AI, Replace key, a new key agreed and testing: Checking with Anthropic…; the saved key stays until it passes', state: READY, run: async d => { await d.load('provider'); await d.clickFk('key-anthropic'); await d.waitSel('#key-field'); d.hold('testStagedKey'); d.setClipboard(FAKE_KEY); await d.clickFk('paste-key'); await d.waitText('Checking with Anthropic…'); } },
    { id: 'provider-replace-rejected', caption: 'Your AI, Replace key with a key Anthropic doesn’t accept: Your saved key is unchanged', state: READY, run: async d => { await d.load('provider'); await d.clickFk('key-anthropic'); await d.waitSel('#key-field'); d.setClipboard(FAKE_BAD_KEY); await d.clickFk('paste-key'); await d.waitText('Your saved key is unchanged'); } },
    { id: 'provider-test-ok', caption: 'Your AI: Test key passed, with its cost', state: READY, run: async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitText('That test cost'); } },
    { id: 'provider-change', caption: 'Your AI, Switch: step 2’s rows here, with ‹ Back', state: READY, run: async d => { await d.load('provider'); await d.clickFk('change-ai'); await d.waitSel('.choices'); } },
    { id: 'setup-your-ai-replace-key', caption: 'Your AI from step 3’s banner (Replace key): ‹ Back to setup at the top, Replace key open', state: { ...AT_WOW, keys: REJECTED_ANTHROPIC }, appState: { ...WOW_APP, onboarded: false }, run: async d => { await toStep3(d); await d.waitText('rejected your key'); await d.clickFk('replace-key'); await d.waitText('Back to setup'); d.note({ back: await d.evalJs(BACK_IN_VIEW) }); } },
    {
      id: 'provider-test-keystore', caption: 'Your AI: Test key when the Keychain won’t read the key: unlock your login keychain, then test again',
      state: { ...READY, results: { testKey: { ok: false, error: 'no_key', ...line('no_key', { headline: 'no_key', detail: '', action: null, line: 'no_key' }, {}, { code: 'keystore_error' }) } } },
      run: async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitResult(); },
    },
    { id: 'provider-custom', caption: 'Your AI with Other connected to openrouter.ai: its model as text', state: CUSTOM_REMOTE_STATE(), run: async d => { await d.load('provider'); await d.waitText('openrouter.ai'); } },
    { id: 'provider-custom-form', caption: 'Your AI, Other’s Replace key: Other’s form filled from the saved service', state: CUSTOM_REMOTE_STATE(), run: async d => { await d.load('provider'); await d.clickFk('key-custom'); await d.waitText('Base URL'); } },
    { id: 'state-check-still-credit', caption: 'Out of credit, Your AI’s Test key fails for that reason: only that nothing changed', state: { ...READY, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'nocredit' } }, rt: { state: 'out_of_credit' } }, run: async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitText('Still no credit'); } },
    { id: 'state-check-still-keystore', caption: 'The Keychain won’t read the key (its banner above), and Test key fails the same way: the still line', state: { ...READY, rt: { state: 'no_key', reason: 'key store unreadable' }, results: { testKey: { ok: false, error: 'no_key', ...line('no_key', { headline: 'no_key', detail: '', action: null, line: 'no_key' }, {}, { code: 'keystore_error' }) } } }, run: async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitText('Still can’t read'); } },
    { id: 'state-check-still-local', caption: 'The server on this Mac stopped, Check again fails: still can’t reach it', state: { ...CUSTOM_LOCAL_STATE(), rt: { state: 'local_down' }, results: { testKey: { ok: false, error: 'local_unreachable', headline: 'Can’t reach localhost:11434.', detail: 'Start localhost:11434, then click Check again.', action: 'retry', line: 'Can’t reach localhost:11434.' } } }, run: async d => { await d.load('provider'); await d.click('Check again'); await d.waitText('Still can’t reach'); } },

    // Usage (spec §6.4): information, with no limits of ours; the daily spend limit is the player's own.
    { id: 'usage-normal', caption: 'Your AI’s spending group (the old Usage): today, Daily limit, Set a limit', state: READY, run: async d => { await d.load('usage'); await d.waitText('Set a limit'); } },
    { id: 'usage-narrow', caption: 'Your AI’s spending group at 760×540', size: [760, 540], state: READY, run: async d => { await d.load('usage'); await d.waitText('Set a limit'); } },
    { id: 'usage-limit-open', caption: 'Usage: Set a limit clicked: an empty amount (never pre-filled), Save limit (the one primary) and Cancel', state: READY, run: async d => { await d.load('usage'); await d.click('Set a limit'); await d.waitSel('#cap-dailyUsd'); } },
    { id: 'usage-limit-set', caption: 'Usage with a daily spend limit the player set: the XP bar, Save limit, Turn off limit', state: { ...READY, ...LIMIT }, run: async d => { await d.load('usage'); await d.waitText('Turn off limit'); } },
    { id: 'usage-near-cap', caption: 'Usage near the limit the player set ($0.86 of $1.00): the bar goes warn', state: { ...READY, ...LIMIT, spentMicros: 860_000 }, run: async d => { await d.load('usage'); await d.waitText('Turn off limit'); } },
    { id: 'usage-cap', caption: 'Usage at the limit the player set: the bar goes bad', state: { ...READY, ...LIMIT, spentMicros: 1_000_000 }, run: async d => { await d.load('usage'); await d.waitText('Turn off limit'); } },
    { id: 'usage-details', caption: 'Usage, Show details: how it’s counted, the limit (no tables)', state: { ...READY, ...LIMIT }, run: async d => { await d.load('usage'); await details(d); } },
    { id: 'usage-bad-amount', caption: 'Usage: an amount out of range: the field’s edge goes bad, one line under it', state: READY, run: async d => { await d.load('usage'); await d.click('Set a limit'); await d.input('cap-dailyUsd', '500'); await d.click('Save limit'); await d.waitText('from $0.01 to $100'); } },
    {
      id: 'caps-confirm-preview', caption: 'Setting a daily spend limit of $5.00 when the saved one couldn’t be read: main’s native confirm, drawn as a preview', state: { ...READY, results: { caps: { ok: false, error: 'failed' } } },
      run: async d => { await d.load('usage'); await d.click('Set a limit'); await d.input('cap-dailyUsd', '5.00'); const spec = d.nextConfirm(); await d.click('Save limit'); await d.drawConfirm(await spec.shown); d.afterShot(() => { spec.answer(false); return d.clearConfirm(); }); },
    },
    {
      id: 'caps-raise-confirm-preview', caption: 'Raising the daily spend limit from $1.00 to $5.00: main’s native confirm (lowering it asks nothing)', state: { ...READY, ...LIMIT },
      run: async d => { await d.load('usage'); await d.waitText('Turn off limit'); await d.input('cap-dailyUsd', '5.00'); const spec = d.nextConfirm(); await d.click('Save limit'); await d.drawConfirm(await spec.shown); d.afterShot(() => { spec.answer(false); return d.clearConfirm(); }); },
    },
    {
      id: 'caps-off-confirm-preview', caption: 'Turn off limit: main’s native confirm', state: { ...READY, ...LIMIT },
      run: async d => { await d.load('usage'); await d.waitText('Turn off limit'); const spec = d.nextConfirm(); await d.click('Turn off limit'); await d.drawConfirm(await spec.shown); d.afterShot(() => { spec.answer(false); return d.clearConfirm(); }); },
    },
    { id: 'caps-saved', caption: 'A first daily spend limit of $2.50: saved at once, with no confirm: Saved.', state: READY, run: async d => { await d.load('usage'); await d.click('Set a limit'); await d.input('cap-dailyUsd', '2.50'); await d.click('Save limit'); await d.waitText('Saved.'); } },
    { id: 'caps-off', caption: 'The limit turned off after the confirm: No limit again, and one line says so', state: { ...READY, ...LIMIT }, run: async d => { await d.load('usage'); await d.click('Turn off limit'); await d.waitText('Your daily limit is off'); } },

    // Connections, Last request (spec §6.5, §6.6).
    { id: 'connections', caption: 'Connections: every address this app talked to, one row each, and that other programs aren’t listed', state: READY, run: async d => { await d.load('connections'); await d.waitText('Every address'); } },
    { id: 'connections-refused', caption: 'Connections: a refused host, with its Blocked chip', state: { ...READY, blocked: [{ host: 'telemetry.example.com', port: 443, count: 2, first: Date.now() - 600e3, last: Date.now() - 60e3, feature: 'refused' }] }, run: async d => { await d.load('connections'); await d.waitText('telemetry.example.com'); } },
    { id: 'last-request', caption: 'Last request: what you asked, the game data as chips, sent to; Show raw request one click away', state: READY, run: async d => { await d.load('last-request'); await d.waitText('You asked'); } },
    { id: 'last-request-raw', caption: 'Last request, Show raw request: the exact JSON, key redacted, hostile text shown as text, scrolling inside itself', state: READY, run: async d => { await d.load('last-request'); await d.clickFk('raw-request'); await d.waitText('x-api-key'); } },
    { id: 'last-request-narrow', caption: 'Last request at 760×540', size: [760, 540], state: READY, run: async d => { await d.load('last-request'); await d.waitText('You asked'); } },

    // Settings (spec §6.7) and its sub-pages.
    { id: 'settings', caption: 'Settings: Start at login, Notifications, Check-ins, Show more', state: READY, run: async d => { await d.load('settings'); await d.waitText('Start at login'); } },
    { id: 'settings-more', caption: 'Settings, Show more open: Chat history (days kept, Delete all), Memory (Forget all), Replies in chat frame, Run setup again, Diagnostics, About, Uninstall', state: READY, run: async d => { await d.load('settings'); await d.clickFk('more'); await d.waitText('Run setup again'); } },
    { id: 'general', caption: 'Settings, the switches saved on change: Saved.', state: READY, run: async d => { await d.load('settings'); await d.clickFk('sw-notifications'); await d.waitText('Saved.'); } },
    { id: 'settings-narrow', caption: 'Settings at 760×540', size: [760, 540], state: READY, run: async d => { await d.load('settings'); await d.waitText('Start at login'); } },
    { id: 'privacy', caption: 'Your data: the three switches, under who they’re sent to; Screen reading, on; Connections and Last request', state: READY, run: async d => { await d.load('privacy'); await d.waitText('Last request'); } },
    { id: 'site-safety-picture', caption: 'The Safety page’s share card (site/tools/og/): Your data at 760×540, Screen reading on, the version in the foot hidden so the picture never shows an old one', size: [760, 540], state: READY, run: async d => { await d.load('privacy'); await d.waitText('Last request'); await d.evalJs("document.styleSheets[0].insertRule('.foot-ver { visibility: hidden; }', document.styleSheets[0].cssRules.length), true"); } },
    { id: 'privacy-game-data-off', caption: 'Your data with Game data off: Off: no route or quest picks.', state: { ...READY, privacy: { identity: false, otherNames: false, companion: false, echo: false, gameContext: false, screenReading: true } }, run: async d => { await d.load('privacy'); await d.waitText('no route or quest picks'); } },
    { id: 'privacy-screen-reading-off', caption: 'Your data with Screen reading off (one click): Off: your messages wait for a /reload.', state: { ...READY, privacy: { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: false } }, run: async d => { await d.load('privacy'); await d.waitText('wait for a /reload'); } },
    { id: 'privacy-screen-reading-off-narrow', caption: 'Your data with Screen reading off at 760×540', size: [760, 540], state: { ...READY, privacy: { identity: false, otherNames: false, companion: false, echo: false, gameContext: true, screenReading: false } }, run: async d => { await d.load('privacy'); await d.waitText('wait for a /reload'); } },
    { id: 'privacy-screen-reading-addon-off', caption: 'Your data, Screen reading on here but off in the addon’s Settings: said', state: { ...READY, setup: { game: { hello: { at: 1, sig: 'ok', mode: 'stream' } } } }, run: async d => { await d.load('privacy'); await d.waitText('Off in the addon'); } },
    { id: 'privacy-windows', platform: 'win32', caption: 'Your data on Windows: Screen reading says what’s over the top of WoW’s window is read too (ON-23)', state: READY, run: async d => { await d.load('privacy'); await d.waitText('anything over it'); } },
    { id: 'privacy-details', caption: 'Your data, Show details: where it goes (the picture), what Anthropic keeps, whether it trains, its policy', state: READY, run: async d => { await d.load('privacy'); await details(d); } },
    { id: 'privacy-retention-saved', caption: 'Settings: chat history kept 90 days (more days asks nothing): Saved.', state: READY, run: async d => { await d.load('settings'); await d.clickFk('more'); await d.select('retention-days', '90'); await d.waitText('Saved.'); } },
    {
      id: 'privacy-retention-confirm-preview', caption: 'Settings: keeping chat history for fewer days asks first (the native confirm drawn as a preview)', state: READY,
      run: async d => { await d.load('settings'); await d.clickFk('more'); const spec = d.nextConfirm(); await d.select('retention-days', '7'); await d.drawConfirm(await spec.shown); d.afterShot(() => { spec.answer(false); return d.clearConfirm(); }); },
    },
    { id: 'privacy-openai-regenerate', caption: 'Your data’s Show details with OpenAI: its safety ID, Replace ID pressed', state: OPENAI_READY, run: async d => { await d.load('privacy'); await d.clickFk('details'); await d.click('Replace ID'); await d.waitText('OpenAI gets the new ID'); } },
    { id: 'diagnostics', caption: 'Diagnostics: the card says what the copy leaves out, then Copy diagnostics', state: READY, run: async d => { await d.load('diagnostics'); await d.waitText('Nothing is uploaded'); } },
    { id: 'diagnostics-copied', caption: 'Diagnostics: after Copy diagnostics (one line; what was copied one click away)', state: READY, run: async d => { await d.load('diagnostics'); await d.click('Copy diagnostics'); await d.waitText('Show what was copied'); } },
    { id: 'about', caption: 'About in a development run: updates work in the installed app; the panel foot shows the version alone', state: READY, updater: { ...UPDATER, supported: false, state: 'off', error: 'not_packaged' }, run: async d => { await d.load('about'); await d.waitText('Show legal and credits'); } },
    // An installed app's About (CL-design-58, CL-words-79): the update line, its one action, the Update checks switch.
    { id: 'about-installed', caption: 'About, installed and up to date: Check for updates, Update checks on', state: READY, updater: UPDATER, info: { releases: true }, run: async d => { await d.load('about'); await d.waitText('NeverQuestAlone is up to date.'); } },
    { id: 'about-available', caption: 'About, installed, a new version found: Download (the one primary)', state: READY, updater: { ...UPDATER, state: 'available', available: { version: '1.2.1', date: null } }, info: { releases: true }, run: async d => { await d.load('about'); await d.waitText('is available'); } },
    { id: 'about-ready', caption: 'About, installed, the update downloaded, WoW closed: Restart to update', state: READY, updater: { ...UPDATER, state: 'ready', available: { version: '1.2.1', date: null }, progress: 100 }, info: { releases: true }, run: async d => { await d.load('about'); await d.waitText('Restart to update'); } },
    { id: 'about-checks-off', caption: 'About, installed, Update checks off: Update checks are off, Open download page (quiet)', state: READY, updater: { ...UPDATER, mode: 'never', state: 'idle' }, info: { releases: true }, run: async d => { await d.load('about'); await d.waitText('Update checks are off'); } },
    { id: 'foot-checked', caption: 'The panel foot after Check for updates: Up to date, until the window closes', state: IN_GAME, run: async d => { await d.load('home'); await d.clickFk('foot'); await d.waitText('Up to date'); } },
    { id: 'foot-available', caption: 'The panel foot with an update found: Download v1.3.1 (gold)', state: IN_GAME, updater: { ...UPDATER, state: 'available', available: { version: '1.3.1', date: null } }, run: async d => { await d.load('home'); await d.waitText('Download v1.3.1'); } },
    { id: 'foot-ready', caption: 'The panel foot with an update downloaded and WoW closed: Restart to update (gold)', state: READY, updater: { ...UPDATER, state: 'ready', available: { version: '1.3.1', date: null }, progress: 100 }, run: async d => { await d.load('home'); await d.waitText('Restart to update'); } },
    { id: 'foot-ready-in-game', caption: 'The panel foot with an update downloaded while WoW runs: Update ready (Restart to update once WoW is closed)', state: IN_GAME, updater: { ...UPDATER, state: 'ready', available: { version: '1.3.1', date: null }, progress: 100 }, run: async d => { await d.load('home'); await d.waitText('Update ready'); } },
    { id: 'status-hover', caption: 'The pointer over NeverQuestAlone: his state in a word beside the portrait (In game)', state: IN_GAME, run: async d => { await d.load('home'); await d.hover('#bones-btn'); } },
    { id: 'status-hover-closed', caption: 'The pointer over NeverQuestAlone with WoW closed: WoW closed', state: READY, run: async d => { await d.load('home'); await d.hover('#bones-btn'); } },
    { id: 'status-hover-needs', caption: 'The pointer over NeverQuestAlone on Settings while a card waits on Home: Needs you, and the Home dot', state: { ...IN_GAME, keys: { anthropic: { masked: 'sk-ant-…xxxx', state: 'invalid' } } }, run: async d => { await d.load('settings'); await d.hover('#bones-btn'); } },
    { id: 'about-legal', caption: 'About, Legal and credits open: disclaimers, credits, license, notices', state: READY, run: async d => { await d.load('about'); await d.clickFk('legal'); await d.waitText('wow-ai'); } },
    { id: 'uninstall', caption: 'Uninstall: what it removes, the addon switch, Uninstall (main confirms first)', state: READY, run: async d => { await d.load('uninstall'); await d.waitText('Removes NeverQuestAlone'); } },

    // Notices (spec §4.14): one line with Okay.
    { id: 'notice-model-switched', caption: 'Notice: the old model isn’t offered, so an equal or cheaper one (Okay puts it away for good)', state: { ...READY, notice: { kind: 'model_switched', from: 'claude-sonnet-5', to: 'claude-haiku-4-5', at: Date.UTC(2026, 8, 26, 9) } }, run: async d => { await d.load('home'); await d.waitText('same price or less'); } },
    // A retiring model in use (SY-102-5): the manifest's day, the model it offers and that model's cost a day; Use <model> picks it as Your AI does.
    { id: 'notice-model-retiring', caption: 'Notice: Claude Haiku 4.5 may retire after the manifest’s day; Claude Sonnet 5.5 and its cost a day, Use Claude Sonnet 5.5, Okay', state: { ...READY, retiring: true }, run: async d => { await d.load('home'); await d.waitText('may retire'); } },
    { id: 'notice-model-retiring-used', caption: 'Use Claude Sonnet 5.5 on that notice: picked as on Your AI, which opens at its models with Saved. under them; the notice is gone', state: { ...READY, retiring: true }, run: async d => { await d.load('home'); await d.waitText('may retire'); await d.clickFk('use-model'); await d.waitText('Saved.'); } },
    { id: 'notice-fuse', caption: 'Notice: the runaway fuse paused check-ins after a burst of game events', state: { ...READY, fuse: true }, run: async d => { await d.load('home'); await d.waitText('Too many check-ins'); } },
    { id: 'notice-model-retired', caption: 'A retired model: the card (Pick another model; no Okay while it holds)', state: { ...READY, choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: Date.UTC(2026, 8, 26, 9) } }, run: async d => { await d.load('home'); await d.waitText('was retired'); } },
    { id: 'state-not-running', caption: 'Home when the app couldn’t start: the card (Quit and reopen, Copy diagnostics)', state: READY, apiMode: 'error', run: async d => { await d.load('home'); await d.waitText('couldn’t start'); } },
    { id: 'state-not-running-setup', caption: 'The not-running banner over setup: Another copy’s open, Quit this copy (the one state setup can’t fix)', state: {}, apiMode: 'error', run: async d => { await d.load('setup'); await d.waitText('Quit this copy'); } },
  ];
  // The card on Home for each state (spec §6.2's table).
  for (const [id, caption, state, wait] of STATE_CARDS) {
    list.push({ id: `state-${id}`, caption: `Home, state card: ${caption}`, state, run: async d => { await d.load('home'); await d.waitText(wait); } });
  }
  // §10: one line per kind group, as Your AI's Test key shows it.
  for (const [kind, rt, name, reason] of ERROR_GROUPS) {
    const openai = kind === 'identifier_blocked' || kind === 'region_blocked';
    const local = kind === 'local_unreachable';
    const base = openai ? OPENAI_READY : local ? CUSTOM_LOCAL_STATE() : READY;
    const l = line(kind, { headline: kind, detail: '', action: null, line: kind }, openai ? { provider: 'OpenAI', model: 'GPT-6 Luna' } : local ? { provider: 'localhost:11434', model: 'qwen3:8b' } : {});
    const how = rt ? `the view is ${rt}${reason ? ` (${reason})` : ''}` : kind === 'model_not_found' ? 'the retired-model card' : 'no rt state: the backend’s last failure';
    const never = ['context_too_long', 'content_blocked', 'interrupted'].includes(kind) ? '; a key test never returns this kind: the line only, as it would show' : '';
    list.push({
      id: `error-${kind.replace(/_/g, '-')}`, caption: `§10 ${name} (${kind}): the desktop line under Your AI’s Key row, as Test key shows it; ${how}${never}`,
      state: {
        ...base,
        ...(rt ? { rt: { state: rt, ...(reason ? { reason } : {}), ...(rt === 'slowed' ? { retryIn: 18 } : {}) } } : {}),
        ...(!rt && kind !== 'model_not_found' ? { lastError: { kind, at: Date.UTC(2026, 8, 26, 9) } } : {}),
        ...(kind === 'model_not_found' ? { choice: { provider: 'anthropic', model: 'claude-sonnet-5', effort: 'low' }, notice: { kind: 'model_retired', model: 'claude-sonnet-5', at: Date.UTC(2026, 8, 26, 9) } } : {}),
        ...(kind === 'cap_spend' ? { ...LIMIT, spentMicros: 1_000_000 } : {}),
        results: { testKey: { ok: false, error: kind, ...l } },
      },
      // A model on this computer that's down: the page's own Check again (the banner is Home's), its line under it.
      run: local ? async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitText('Still can’t reach'); }
        : async d => { await d.load('provider'); await d.clickFk('now-test'); await d.waitResult(); },
    });
  }
  // Every page, card and notice past setup is the window of a player who set up.
  for (const s of list) {
    if (/^(setup-|home-finish-)/.test(s.id) || s.id === 'state-not-running-setup' || (s.appState && 'onboarded' in s.appState)) continue;
    s.appState = { ...ONBOARDED, ...(s.appState ?? {}) };
  }
  return list;
}

/**
 * What each scene is measured against (spec §8.1): its screen, by the page the window shows. The
 * word budgets count the visible words (the panel's too) and leave out data (JSON, hosts, key
 * masks, NeverQuestAlone's quoted first words, stat values). On app pages the nav's fixed labels and the
 * wordmark are left out: they're the same on every page, and the spec's Last request budget (20)
 * can't hold them with its title and line.
 */
// The app trim (the owner: "a tiny bit simpler, a little too verbose"): no screen over 45 visible words, and
// the pages the trim made small say so: Home 35, Settings 30, Connections 30, Last request 30. Your AI fell from 77
// to 45 (the model and Thinking are behind Pick a model); step 2 from 55, step 3 from 52, Your data from 60.
export const BUDGETS = Object.freeze({ welcome: 45, step2: 45, other: 40, step3: 50, done: 40, home: 35, yourAi: 45, usage: 45, connections: 30, lastRequest: 30, settings: 30, yourData: 45, diagnostics: 45, about: 40, uninstall: 40 });
export const SCREEN_OF = Object.freeze({ 'setup-pick': 'step2', 'setup-other': 'other', 'setup-say': 'step3', 'setup-done': 'done', 'page-home': 'home', 'page-yourai': 'yourAi', 'page-usage': 'usage', 'page-connections': 'connections', 'page-last': 'lastRequest', 'page-settings': 'settings', 'setup-welcome': 'welcome', 'page-privacy': 'yourData', 'page-pick': 'step2', 'page-other': 'other', 'page-diagnostics': 'diagnostics', 'page-about': 'about', 'page-uninstall': 'uninstall' });
/** The scenes the timer check watches for 5 s (spec §8.7): the waiting, slowed and Listening ones. */
export const TIMER_SCENES = Object.freeze(['setup-s4-waiting', 'setup-s4-installing', 'state-slowed', 'setup-s4-fresh']);

// ---------------------------------------------------------------------------
// The run.

/** A probed shot's extras for its INDEX line (--screenshots-probe, --screenshots-axe), and its checks. */
function probeText(s) {
  const out = [];
  if (s.words != null) out.push(`[words ${s.words}${s.budget != null ? `/${s.budget}` : ''}]`);
  if (s.fits === false) out.push('[scrolls]');
  if (Array.isArray(s.axe)) out.push(`[axe: ${s.axe.length ? s.axe.join(', ') : 'clean'}]`);
  if (Array.isArray(s.notes) && s.notes.length) out.push(`[notes: ${JSON.stringify(s.notes).slice(0, 400)}]`);
  if (Array.isArray(s.fails) && s.fails.length) out.push(`[CHECK FAILED: ${s.fails.join('; ').slice(0, 600)}]`);
  return out.length ? `  ${out.join(' ')}` : '';
}

/**
 * A scene's acceptance checks (spec §8) → what failed, in words. check: what the driver measured
 * (the driver's capture below: shot-probe.mjs checkJs at the scene's size and, for setup, the other size; the
 * timer, hover, reduced-motion and focus passes).
 */
export function judge(scene, check) {
  const fails = [];
  const at = check?.at;
  if (!at) return fails;
  const zoom = Number(scene?.appState?.zoom) > 0;
  const budget = at.screen && !at.sheetOpen ? BUDGETS[at.screen] ?? null : null;
  if (budget != null && at.words > budget) fails.push(`words ${at.words} over ${budget}`);
  const setupScreen = /^(welcome|step2|other|step3|done)$/.test(at.screen ?? '');
  for (const m of [at, check.other].filter(Boolean)) {
    const tag = `${m.size[0]}×${m.size[1]}`;
    if (m.overflowX.length) fails.push(`sideways at ${tag}: ${m.overflowX.join(' ')}`);
    if (setupScreen && !zoom && !m.fit.page) fails.push(`setup scrolls at ${tag} (${m.fit.pageOver} px)`);
    if (!m.fit.doc) fails.push(`the window scrolls at ${tag}`);
    if (!zoom && m.panelClipped > 0) fails.push(`the panel is cut at ${tag} (${m.panelClipped} px)`);
  }
  if (at.contrast.length) fails.push(`contrast: ${at.contrast.map(c => `"${c.text}" ${c.ratio}`).join(', ')}`);
  if (at.edges.length) fails.push(`control edges: ${at.edges.map(c => `${c.el} ${c.ratio}`).join(', ')}`);
  if (at.faintText.length) fails.push(`faint text: ${at.faintText.join(', ')}`);
  if (at.primaries.length > 1) fails.push(`${at.primaries.length} primaries: ${at.primaries.join(' | ')}`);
  if (Array.isArray(at.dragUnder) && at.dragUnder.length) fails.push(`a control on a drag region: ${at.dragUnder.join(', ')}`);
  if (at.bonesOnStage) fails.push('the skull on the stage');
  if (at.firstPerson.length) fails.push(`first person on the stage: ${at.firstPerson.join(' | ')}`);
  if (Array.isArray(at.classLeak) && at.classLeak.length) fails.push(`a class name shown as text: ${at.classLeak.join(', ')}`);
  if (check.hover && check.hover.moves.length) fails.push(`hover moved: ${check.hover.moves.join(', ')}`);
  if (check.timer) fails.push(`${check.timer} boxes changed in 5 s`);
  if (check.reducedMotion) fails.push(`${check.reducedMotion} animations run with reduced motion`);
  if (check.focus && check.focus.bad.length) fails.push(`no focus ring: ${check.focus.bad.join(', ')}`);
  if (check.focus && !check.focus.order) fails.push('tab order isn’t panel, top bar, content');
  return fails;
}

/** INDEX.txt: one line per PNG, "file  caption", with the probe's axe summary when it ran. */
export function indexText(shots, { when = new Date(), note = '' } = {}) {
  const w = Math.max(...shots.map(s => s.file.length), 10);
  return [
    `NeverQuestAlone desktop app: window states (${shots.length} PNGs, ${when.toISOString()})`,
    'Rendered by `electron . --screenshots <dir>` against the mock API (src/mock-api.mjs), in a hidden window grown to each page’s height.',
    note,
    '',
    ...shots.map(s => `${s.file.padEnd(w)}  ${s.caption}${s.error ? `  [FAILED: ${s.error}]` : ''}${probeText(s)}`),
    '',
  ].filter(l => l !== null).join('\n');
}

/**
 * Run every scene in each theme. driver = { reset(state, scene), setTheme(theme), capture(file),
 * ...page actions } (screenshots() below builds it). Returns [{file, caption, theme, error?}].
 */
export async function runScenes(driver, list, { themes = THEMES, log = () => {} } = {}) {
  const shots = [];
  let n = 0;
  for (const theme of themes) {
    await driver.setTheme(theme);
    for (const sc of list) {
      n += 1;
      const file = `${String(n).padStart(3, '0')}-${sc.id}-${theme}.png`;
      const shot = { id: sc.id, file, caption: `${sc.caption} (${theme})`, theme };
      try {
        await driver.reset(sc.state ?? {}, sc);
        await sc.run(driver);
        const probed = await driver.capture(file, sc);
        if (probed && typeof probed === 'object') {
          Object.assign(shot, { axe: probed.axe, notes: probed.notes, fits: probed.fits });
          if (probed.check) {
            shot.check = probed.check;
            shot.words = probed.check.at?.words ?? null;
            shot.screen = probed.check.at?.screen ?? null;
            shot.budget = shot.screen && !probed.check.at?.sheetOpen ? BUDGETS[shot.screen] ?? null : null;
            shot.fails = judge(sc, probed.check);
          }
        }
      } catch (e) {
        shot.error = String(e?.message ?? e).slice(0, 200);
        log(`screenshot ${file} failed: ${shot.error}`);
        try { await driver.capture(file); } catch { /* nothing to show */ }
      } finally {
        try { await driver.afterScene(); } catch { /* next scene resets */ }
      }
      shots.push(shot);
    }
  }
  return shots;
}

// ---------------------------------------------------------------------------
// The driver: --screenshots <dir> (development runs), every window state. It lived in main.mjs; it's
// here so the shipped main.mjs keeps only what production and the packaged self-test need (code health
// AP-15). main.mjs calls it once its window, app state and controllable mock exist, with hooks: what
// the driver uses of main's, and setters for what main's window and IPC read while it runs.

/**
 * screenshots(hooks): every scene, then INDEX.txt, manifest.json and one JSON line; exits the app.
 * hooks = { outDir, argv, app, nativeTheme, openWindow, appState, mock, log, selfTestDir, roots, show }
 *   outDir       the folder (screenshotsDir)          argv     process.argv (the --screenshots-* options)
 *   app, nativeTheme   Electron's                     openWindow  main's window (hidden in this mode)
 *   appState     src/app-state.mjs's store            mock     the controllable mock API main runs on
 *   log          main's log                           selfTestDir  the temp data folder, removed at the end
 *   roots        the bridge roots (src/api-loader.mjs bridgeRoots): its §10 lines and the manifests' player text
 *   show         { confirm(fn|null), folder(dir|null), apiMode(mode), platform(p|null), info(facts),
 *                  updater(status), clipboard(text) }: what a scene shows main's confirm, folder dialog,
 *                  appInfo, updater and clipboard
 */
export async function screenshots(hooks) {
  const { outDir, argv, app, nativeTheme, openWindow, appState, mock, log, selfTestDir, roots, show } = hooks;
  fs.mkdirSync(outDir, { recursive: true });
  // The critics' options (desktop UI critic r2, T-2): --screenshots-size=WxH renders every scene at
  // one size; --screenshots-themes=light,dark picks the themes; --screenshots-probe writes, beside
  // each PNG, what the window showed before it grew (<shot>.fold.png) and a DOM probe
  // (<shot>.json; src/shot-probe.mjs); --screenshots-axe=<file> also runs axe-core from that local
  // copy on every state, into the same JSON and INDEX.txt (nothing is downloaded).
  const argOf = name => { const a = argv.find(x => x.startsWith(`${name}=`)); return a ? a.slice(name.length + 1) : null; };
  const sizeArg = /^(\d{3,4})x(\d{3,4})$/.exec(argOf('--screenshots-size') ?? '');
  const themesArg = (argOf('--screenshots-themes') ?? '').split(',').filter(t => THEMES.includes(t));
  const axeFile = argOf('--screenshots-axe');
  const PROBE = !!axeFile || argv.includes('--screenshots-probe');
  const { PROBE_JS, AXE_RUN_JS } = PROBE ? await import('./shot-probe.mjs') : {};
  // The redesign's acceptance checks (spec §8) run on every scene: the page side is shot-probe.mjs.
  const checks = await import('./shot-probe.mjs');
  const CHECK_JS = checks.checkJs(SCREEN_OF);
  const axeSrc = axeFile ? fs.readFileSync(path.resolve(axeFile), 'utf8') : null;
  let notes = [];
  const w = openWindow();
  await new Promise(r => w.webContents.once('did-finish-load', r));
  const wc = w.webContents;
  // A stand-in for macOS's traffic lights (capturePage draws the page only), where the window puts
  // them (trafficLightPosition 20, 20), so a shot shows the wordmark where a player sees it.
  const LIGHTS_CSS = '.app[data-os="darwin"]::after { content: ""; position: fixed; left: 20px; top: 20px; width: 52px; height: 12px; z-index: 99; pointer-events: none; background: radial-gradient(circle at 6px 6px, #ff5f57 5.5px, transparent 6px), radial-gradient(circle at 26px 6px, #febc2e 5.5px, transparent 6px), radial-gradient(circle at 46px 6px, #28c840 5.5px, transparent 6px); }';
  await wc.insertCSS(LIGHTS_CSS);
  wc.on('did-finish-load', () => { wc.insertCSS(LIGHTS_CSS).catch(() => {}); });
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const js = code => wc.executeJavaScript(code, true);
  const q = JSON.stringify;
  // §10 lines the desktop way, from the bridge's own table (app-api.mjs desktopLine over
  // providers/errors.mjs, in the app or the repo), else the kind.
  let lineFor = null;
  try {
    const apiFile = roots.map(r => path.join(r, 'bridge', 'byok', 'app-api.mjs')).find(f => fs.existsSync(f));
    if (!apiFile) throw new Error('no bridge in this build');
    const { desktopLine } = await import(pathToFileURL(apiFile).href);
    // The real manifests' player text on the privacy cards and key notes (D-22), not the mock's.
    const { playerCard, lastErrorView } = await import(pathToFileURL(apiFile).href);
    mock.control.useLastErrorView(lastErrorView); // the last-failure card from the real path (D-01)
    const { loadManifests } = await import(pathToFileURL(path.join(path.dirname(apiFile), 'providers', 'index.mjs')).href);
    mock.control.usePlayerText(Object.fromEntries(loadManifests().map(m => [m.id, playerCard(m)])));
    lineFor = (kind, names = {}, extra = {}) => desktopLine(
      { kind, provider: names.provider ?? 'Anthropic', retryAfterMs: 18_000, resetAt: Date.now() + 5 * 3600e3, ...extra },
      { provider: 'Anthropic', model: 'Claude Haiku 4.5', companion: 'NeverQuestAlone', product: 'NeverQuestAlone', platform: process.platform, capMicros: 1_000_000, ...names },
    );
  } catch (e) { log(`screenshots: no §10 lines (${e?.message ?? e})`); }

  // Every scene shows an installed app's updater unless it names its own (scene.updater): the panel's
  // foot and About read it through ipcUpdater, and nothing is fetched.
  const UPDATER_INSTALLED = { supported: true, configured: true, mode: 'notify', notifyOnly: false, state: 'idle', available: null, progress: null, error: null };
  let pendingConfirm = null;
  let after = [];
  let shotSize = [1000, 720];
  const waitFor = async (code, what, ms = 6000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await js(code)) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const settle = async () => { await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))'); await sleep(120); };
  const clickWhere = async (finder, what) => {
    const ok = await js(`(() => { const el = (${finder})(); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
    if (!ok) throw new Error(`no ${what} to click`);
    await settle();
  };
  const byText = (text, sel = 'button') => `() => [...document.querySelectorAll(${q(sel)})].find(b => !b.disabled && b.textContent.trim() === ${q(text)})`;
  const driver = {
    async reset(state, scene) {
      after = [];
      show.confirm(null);
      pendingConfirm = null;
      show.folder(null);
      show.apiMode(scene?.apiMode ?? 'real');
      show.platform(scene?.platform ?? null);
      // A packaged app's login item unless the scene says otherwise (a development run has none).
      show.info({ loginItem: { supported: true, openAtLogin: false }, ...(scene?.info ?? {}) });
      show.updater({ ...(scene?.updater ?? UPDATER_INSTALLED) });
      show.clipboard(scene?.clipboard ?? '');
      shotSize = sizeArg ? [Number(sizeArg[1]), Number(sizeArg[2])] : Array.isArray(scene?.size) ? scene.size : [1000, 720];
      notes = [];
      // The window's own settings for the scene (setup's saved screen, onboarded, the defaults seen).
      // The zoom too: a scene at the app's own zoom level (DU-30) sets it, and the next starts at 100%.
      appState.set({ onboarded: false, defaultsSeen: false, alertsAsked: false, addonConsent: null, setup: null, notifications: true, zoom: 0, ...(scene?.appState ?? {}) });
      mock.control.usePlatform(scene?.platform ?? process.platform);
      mock.control.reset(state);
    },
    /** What the "Choose folder…" dialog answers next. */
    setFolder(dir) { show.folder(dir); },
    /** What Paste key reads next (a canary key, or text that isn't one). */
    setClipboard(text) { show.clipboard(String(text ?? '')); },
    /** A status push mid-scene (a row is checked off in place): the mock's setup block patched. */
    async push(setupPatch) { mock.control.patchSetup(setupPatch); await settle(); },
    /** The fake bridge's facts changed mid-scene (a key rejected, the model app stopped): then a push. */
    async patch(fields) { mock.control.patch(fields); await settle(); },
    async setTheme(theme) { nativeTheme.themeSource = theme; await sleep(200); },
    async load(page) {
      w.setContentSize(shotSize[0], shotSize[1]);
      // A fresh page each time (the window's own state starts over): the hash names the page, then a reload.
      const loadedPage = new Promise(r => wc.once('did-finish-load', r));
      await js(`location.hash = ${q(`#${page}`)}`);
      wc.reload();
      await loadedPage;
      await waitFor('document.getElementById("page").childElementCount > 0', `the ${page} page`);
      await settle();
    },
    click: text => clickWhere(byText(text), `button "${text}"`),
    /** A control by its focus key (data-fk): the AI cards, Paste key, a row's action. */
    /** The control with this focus key, when it's there (the welcome a first setup opens on). */
    /** The pointer over an element (a real mouse move, as the hover check makes): its hover state shows in the shot. */
    async hover(sel) {
      const at = await js(`(() => { const r = document.querySelector(${q(sel)})?.getBoundingClientRect(); return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } : null; })()`);
      if (!at) throw new Error(`no ${sel} to hover`);
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
      await settle();
      await sleep(260);
    },
    async clickFkIf(fk) { if (await js(`!![...document.querySelectorAll('[data-fk]')].find(e => e.getAttribute('data-fk') === ${q(fk)})`)) await driver.clickFk(fk); },
    clickFk: fk => clickWhere(`() => [...document.querySelectorAll('[data-fk]')].find(e => e.getAttribute('data-fk') === ${q(fk)})`, `[data-fk=${fk}]`),
    async clickAny(texts) {
      for (const t of texts) { if (await js(`!!(${byText(t)})()`)) return driver.click(t); }
      throw new Error(`none of ${texts.join(', ')} to click`);
    },
    clickChoice: title => clickWhere(`() => [...document.querySelectorAll('button.choice')].find(b => b.querySelector('.choice-title') && b.querySelector('.choice-title').firstChild && b.querySelector('.choice-title').firstChild.textContent.trim() === ${q(title)})`, `choice "${title}"`),
    clickLabel: id => clickWhere(`() => document.getElementById(${q(id)})`, `#${id}`),
    /** The first element a selector finds. */
    clickSel: sel => clickWhere(`() => document.querySelector(${q(sel)})`, sel),
    /** A select's option, picked the way a player picks it (a change event). */
    async select(id, value) {
      const ok = await js(`(() => { const el = document.getElementById(${q(id)}); if (!el) return false; el.value = ${q(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      if (!ok) throw new Error(`no select #${id}`);
      await settle();
    },
    waitSel: sel => waitFor(`!!document.querySelector(${q(sel)})`, sel).then(settle),
    async check(id, on) {
      const ok = await js(`(() => { const el = document.getElementById(${q(id)}); if (!el) return false; if (el.checked !== ${on}) el.click(); return true; })()`);
      if (!ok) throw new Error(`no checkbox #${id}`);
      await settle();
    },
    async input(id, value) {
      const ok = await js(`(() => { const el = document.getElementById(${q(id)}); if (!el) return false; el.value = ${q(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      if (!ok) throw new Error(`no field #${id}`);
      await settle();
    },
    async paste(id, text) {
      const ok = await js(`(() => { const el = document.getElementById(${q(id)}); if (!el) return false; const dt = new DataTransfer(); dt.setData('text', ${q(text)}); el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
      if (!ok) throw new Error(`no field #${id}`);
      await settle();
    },
    waitText: text => waitFor(`document.body.innerText.includes(${q(text)})`, `"${text}"`).then(settle),
    waitResult: () => waitFor('!!document.querySelector("#page .result, #page .set-line")', 'a result').then(settle),
    // A call held for a shot is abandoned when the scene ends, so it never writes into the next one.
    hold(name) { const release = mock.control.hold(name); after.push(() => mock.control.abandon()); return release; },
    nextConfirm() {
      let shown;
      let answer;
      // A confirm that never comes fails its scene after 15 s instead of holding the run forever
      // (a first daily spend limit stopped asking, and caps-confirm-preview waited on it for good).
      let timer = null;
      const specP = Promise.race([
        new Promise(r => { shown = spec => { clearTimeout(timer); r(spec); }; }),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error('no native confirm was shown')), 15_000); }),
      ]);
      specP.catch(() => {}); // a scene that ends before awaiting it leaves no unhandled rejection
      const answerP = new Promise(r => { answer = r; });
      after.push(() => clearTimeout(timer));
      pendingConfirm = { shown: specP, answer };
      show.confirm((spec) => { shown(spec); show.confirm(null); return answerP; });
      after.push(() => answer(false));
      return pendingConfirm;
    },
    async drawConfirm(spec) {
      // The native dialog's words (message, detail, buttons) as a card over the page: a preview
      // drawn with the page's own classes; the real dialog is macOS's and capturePage can't see it.
      await js(`(() => {
        const spec = ${q({ message: spec.message, detail: spec.detail, ok: spec.okLabel || 'Okay', destructive: !!spec.destructive })};
        const back = document.createElement('div');
        back.id = 'confirm-preview';
        Object.assign(back.style, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.28)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '120px', zIndex: '99' });
        const box = document.createElement('section');
        // A dialog, as the native one is (and axe's region rule counts a dialog as a region).
        box.setAttribute('role', 'dialog');
        box.setAttribute('aria-label', spec.message);
        // Its own panel (the card class it once used is gone): the sheet's surface, edge and radius.
        Object.assign(box.style, { width: '372px', margin: '0', padding: '18px 20px', background: 'var(--raised)', border: '1px solid var(--line)', borderRadius: '12px', color: 'var(--text)', boxShadow: '0 12px 40px rgba(0,0,0,0.35)', textAlign: 'left' });
        const h = document.createElement('p'); h.textContent = spec.message; h.style.fontWeight = '650'; h.style.margin = '0 0 8px';
        const d = document.createElement('p'); d.textContent = spec.detail; d.style.whiteSpace = 'pre-line'; d.className = 'small'; d.style.margin = '0 0 16px';
        const row = document.createElement('div'); row.className = 'row'; row.style.justifyContent = 'flex-end';
        const cancel = document.createElement('button'); cancel.className = 'btn'; cancel.textContent = 'Cancel';
        const ok = document.createElement('button'); ok.className = spec.destructive ? 'btn btn-danger' : 'btn btn-primary'; ok.textContent = spec.ok;
        row.append(cancel, ok);
        const note = document.createElement('p'); note.className = 'small muted'; note.style.margin = '12px 0 0';
        note.textContent = 'Preview of the native confirm (a macOS dialog in the app).';
        box.append(h, d, row, note);
        back.append(box);
        document.body.append(back);
      })()`);
      await settle();
    },
    clearConfirm: () => js('document.getElementById("confirm-preview")?.remove()'),
    afterShot(fn) { after.push(fn); },
    async capture(file, scene = null) {
      await settle();
      // The window as the player sees it, probed before it grows (--screenshots-probe).
      let probed = null;
      if (PROBE) {
        const fold = await wc.capturePage(undefined, { stayHidden: true });
        fs.writeFileSync(path.join(outDir, file.replace(/\.png$/, '.fold.png')), fold.toPNG());
        probed = { probe: null, axe: null, notes: notes.length ? notes : null };
        try { probed.probe = await js(PROBE_JS); } catch (e) { probed.probe = { error: String(e?.message ?? e) }; }
        if (axeSrc) {
          try {
            if (!(await js('!!window.axe'))) await js(axeSrc);
            probed.axe = await js(AXE_RUN_JS);
          } catch (e) { probed.axe = { error: String(e?.message ?? e) }; }
        }
        fs.writeFileSync(path.join(outDir, file.replace(/\.png$/, '.json')), JSON.stringify(probed, null, 1));
      }
      // The acceptance checks (spec §8): words, fit, contrast, primaries and NeverQuestAlone, at the scene's size;
      // a setup screen's fit at the other size too (1000×720 and 760×540).
      const check = { at: await js(CHECK_JS) };
      if (/^setup-/.test(scene?.id ?? '') && String(check.at?.screen ?? '').match(/^(step2|other|step3|done)$/)) {
        const other = shotSize[0] === 1000 && shotSize[1] === 720 ? [760, 540] : shotSize[0] === 760 && shotSize[1] === 540 ? [1000, 720] : null;
        if (other) {
          w.setContentSize(other[0], other[1]);
          await sleep(120); await settle();
          check.other = await js(CHECK_JS);
          w.setContentSize(shotSize[0], shotSize[1]);
          await sleep(120); await settle();
        }
      }
      const height = await js('(() => { const p = document.getElementById("page"); const top = p.getBoundingClientRect().top; return Math.ceil(top + p.scrollHeight); })()');
      const h = Math.min(Math.max(shotSize[1], height), MAX_HEIGHT);
      w.setContentSize(shotSize[0], h);
      await sleep(150);
      await settle();
      const img = await wc.capturePage(undefined, { stayHidden: true });
      fs.writeFileSync(path.join(outDir, file), img.toPNG());
      w.setContentSize(shotSize[0], shotSize[1]);
      await sleep(120);
      await settle();
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      const cdp = (m, p) => wc.debugger.sendCommand(m, p);
      // No layout change on a timer (spec §8.7): the waiting, slowed and Listening scenes, 5 s apart.
      if (TIMER_SCENES.includes(scene?.id)) {
        const a = await js(checks.SNAP_JS);
        await sleep(5000);
        const b = await js(checks.SNAP_JS);
        check.timer = a.filter((x, i) => x !== b[i]).length + Math.abs(a.length - b.length);
      }
      // No layout change on hover (spec §8.6): a real mouse move over each control; boxes and visibility stay.
      const targets = await js(checks.HOVER_TARGETS_JS);
      const hoverMoves = [];
      let base = await js(checks.SNAP_JS);
      for (const t of targets) {
        await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: t.x, y: t.y });
        await js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
        const now = await js(checks.SNAP_JS);
        const diff = now.length !== base.length ? 1 : now.filter((x, i) => x !== base[i]).length;
        if (diff) hoverMoves.push(`${t.what} (${diff})`);
        base = now;
      }
      await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
      check.hover = { targets: targets.length, moves: hoverMoves };
      // Reduced motion (spec §8.10): nothing runs after 1 s.
      const running = await js('document.getAnimations().filter(a => a.playState === "running").length');
      if (running) {
        await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
        await sleep(1000);
        check.reducedMotion = await js('document.getAnimations().filter(a => a.playState === "running").length');
        await cdp('Emulation.setEmulatedMedia', { features: [] });
      } else check.reducedMotion = 0;
      // Visible focus and the tab order (spec §8.5): Tab through the window by keyboard.
      await js('(() => { const a = document.activeElement; if (a && a.blur) a.blur(); })()');
      const tabs = [];
      const regions = [];
      const bad = [];
      let order = true;
      let last = -1;
      for (let i = 0; i < 60; i++) {
        await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
        const f = await js(checks.FOCUS_JS);
        if (!f) break;
        if (tabs.includes(f.key)) break;
        tabs.push(f.key);
        regions.push(f.region);
        if (f.visible && !f.ok) bad.push(`${f.key} [${f.ring}]`);
      }
      // The order over one full cycle, from wherever Tab started: panel, top bar, banners, page (then
      // the sheet), so going round it steps back to the start once at most.
      const cyc = regions.filter(x => x !== 4);
      order = cyc.filter((x, i) => x < cyc[(i + cyc.length - 1) % cyc.length]).length <= 1;
      void last;
      check.focus = { stops: tabs.length, bad, order, regions: regions.join('') };
      const axe = probed && probed.axe && Array.isArray(probed.axe.violations) ? probed.axe.violations.map(v => `${v.id}×${v.nodes.length}`) : null;
      return { axe: axeSrc ? (axe ?? ['error']) : null, notes: probed ? probed.notes : (notes.length ? notes : null), fits: probed ? probed.probe?.fits ?? null : null, check };
    },
    /** For a scene that measures (the press-and-push scenes): run code in the page. */
    evalJs: code => js(code).then(async v => { await settle(); return v; }),
    /** A scene's finding, kept in its JSON and INDEX.txt line. */
    note(x) { notes.push(x); },
    wait: ms => sleep(ms),
    /** A real mouse event through the DevTools protocol (a press and a release are separate). */
    async mouse(type, x, y) {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
    },
    async afterScene() {
      for (const fn of after.splice(0)) { try { await fn(); } catch {} }
      show.confirm(null);
    },
  };
  // --screenshots-only=<regex>: only the scenes whose ids match (a round on one screen).
  const onlyArg = argv.find(a => a.startsWith('--screenshots-only='));
  const only = onlyArg ? new RegExp(onlyArg.slice('--screenshots-only='.length)) : null;
  const list = scenes({ lineFor }).filter(sc => !only || only.test(sc.id));
  const shots = await runScenes(driver, list, { log, ...(themesArg.length ? { themes: themesArg } : {}) });
  fs.writeFileSync(path.join(outDir, 'INDEX.txt'), indexText(shots, {
    note: [
      'The fake bridge is put in each state through the mock’s control; the page is driven by clicks, a paste and checkboxes. Keys are canaries. §10 error lines are the bridge’s desktop wording (bridge/byok/app-api.mjs desktopLine over providers/errors.mjs); privacy cards and key notes are the real manifests’ player text (playerCard).',
      'First-run step 0 (PRD §16.1) is the release page’s download notes, not a window of the app, so the setup shots start at step 1. The daily spend limit’s confirms are macOS dialogs in the app; their shots draw each dialog’s exact text over the page. "Choose folder…" opens a native folder dialog in the app; its scene answers it with a folder.',
    ].join('\n'),
  }));
  // The manifest (spec §8): each scene's words against its budget and every check it failed.
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({ when: new Date().toISOString(), budgets: BUDGETS, shots: shots.map(s => ({ id: s.id, file: s.file, caption: s.caption, screen: s.screen ?? null, words: s.words ?? null, budget: s.budget ?? null, fails: s.fails ?? [], error: s.error ?? null, check: s.check ?? null })) }, null, 1)}\n`);
  const failed = shots.filter(s => s.error);
  const failing = shots.filter(s => s.fails && s.fails.length);
  process.stdout.write(`${JSON.stringify({ screenshots: outDir, count: shots.length, failed: failed.map(s => `${s.file}: ${s.error}`), checksFailed: failing.map(s => `${s.file}: ${s.fails.join('; ')}`) })}\n`);
  try { fs.rmSync(selfTestDir, { recursive: true, force: true }); } catch {}
  app.exit(failed.length || failing.length ? 1 : 0);
}
