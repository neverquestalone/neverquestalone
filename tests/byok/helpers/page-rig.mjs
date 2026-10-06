// The settings page over the real IPC layer (app/desktop/ipc.mjs) and the mock API, in the mini
// DOM (helpers/mini-dom.mjs): a click in the page goes through the same schema checks, confirms and
// redaction as in the app. confirm answers the native confirms (recorded in confirms).
import { createIpc, createKeyStager } from '../../../app/desktop/ipc.mjs';
import { createMockApi } from '../../../app/desktop/src/mock-api.mjs';
import { wrapApi } from '../../../app/desktop/src/api-loader.mjs';
import { createShellLedger } from '../../../app/desktop/src/net-guard.mjs';
import { idleUpdater } from '../../../app/desktop/updater.mjs';
import { loadPage } from './mini-dom.mjs';
import { lastErrorView, playerCard } from '../../../bridge/byok/app-api.mjs';
import { loadManifests } from '../../../bridge/byok/providers/index.mjs';

// The bridge's own view of the backend's last failure and the real manifests' player text, as the
// screenshot mode uses them (main.mjs), so the page sees what a player would.
const PLAYER_TEXT = Object.fromEntries(loadManifests().map(m => [m.id, playerCard(m)]));

/**
 * welcome: stay on the welcome a first setup opens on; by default the rig clicks its Set up NeverQuestAlone,
 * as a player does, so a test starts at Connect your AI.
 * store: the shell's settings as main keeps them across windows ({seen: [...]}, like app-state.json);
 * pass the same one to a second rig to open the window again after closing it.
 */
export async function pageRig({ state = {}, onboarded = true, welcome = false, hash = '', confirm = true, apiMode = 'real', apiReason = null, pickFolder = null, platform = 'darwin', store = { seen: [] }, appState: initialAppState = {}, info = {}, clipboard = '', updater = null, releases = null } = {}) {
  const mock = createMockApi({ delayMs: 0, controllable: true, platform });
  mock.control.useLastErrorView(lastErrorView);
  mock.control.usePlayerText(PLAYER_TEXT);
  mock.control.reset(state);
  const api = wrapApi(mock);
  const confirms = [];
  const calls = [];
  let appState = { onboarded, notifications: true, noticesSeen: [], zoom: 0, defaultsSeen: false, alertsAsked: false, addonConsent: null, setup: null, ...initialAppState };
  // The clipboard main reads on Paste key (never the page): a test sets it with setClipboard.
  const clip = { text: clipboard, writes: [] };
  const notified = [];
  const loginSets = [];
  const opened = [];
  const ctx = {
    api: new Proxy(api, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { calls.push([k, ...a]); return t[k](...a); } : t[k]) }),
    keys: createKeyStager(),
    ledger: createShellLedger(),
    updater: updater ?? idleUpdater({ pkg: {}, prefs: {}, current: '0.1.0' }),
    appState: {
      get: () => ({ ...appState, noticesSeen: [...store.seen] }), set: v => { appState = { ...appState, ...v }; return { ...appState }; },
      seeNotice: id => { if (!store.seen.includes(id)) store.seen.push(id); return [...store.seen]; }, noticesSeen: () => [...store.seen],
    },
    platform,
    confirm: async spec => { confirms.push(spec); return typeof confirm === 'function' ? confirm(spec) : confirm; },
    links: { open: url => { opened.push(url); return { ok: true }; } },
    clipboard: { writeText: (t) => { clip.writes.push(String(t)); clip.text = String(t); }, readText: async () => clip.text },
    isFocused: () => true,
    loginItem: { set: (open) => { loginSets.push(open); return { ok: true, supported: true, openAtLogin: open }; }, get: () => ({ supported: true, openAtLogin: false }) },
    notify: n => notified.push(n),
    openGame: () => { calls.push(['openGame']); return { ok: true }; },
    moveToApplications: () => ({ ok: false, error: 'move_failed', headline: 'Couldn’t move it.', detail: 'Drag NeverQuestAlone into Applications, then open it from there.' }),
    info: () => ({ name: 'NeverQuestAlone', version: '0.1.0', electron: '44', chrome: '152', node: '24', platform, arch: 'arm64', packaged: false, apiMode, apiReason, loginItem: { supported: true, openAtLogin: false }, license: 'MIT', osRelease: '24.1.0', appleSilicon: true, inApplications: null, workPc: false, ...info }),
    notices: () => [],
    companion: () => 'NeverQuestAlone',
    releasesUrl: () => releases,
    uninstallShell: r => ({ ...r, quitting: true, finish: 'To finish, drag NeverQuestAlone from Applications to the Trash.' }),
    pickFolder: async () => (typeof pickFolder === 'function' ? pickFolder() : pickFolder),
    relaunch: () => { calls.push(['relaunch']); return { ok: true }; },
    quitApp: () => { calls.push(['quitApp']); return { ok: true }; },
    shellLog: () => [],
    log: () => {},
  };
  const subs = { status: [], navigate: [], updates: [], agreed: [] };
  // main's onAgreed (DU-03): the player agreed in a dialog, so the page may say "Checking with …".
  ctx.onAgreed = (call, provider) => { for (const cb of subs.agreed) cb({ call, provider: provider ?? null }); };
  const ipc = createIpc(ctx);
  const bones = {};
  // Like Electron's IPC, a payload arrives as a structured clone in the main process's realm.
  for (const name of ipc.calls) bones[name] = payload => ipc.call(name, payload === undefined ? undefined : structuredClone(payload));
  bones.onStatus = cb => { subs.status.push(cb); return () => {}; };
  bones.onNavigate = cb => { subs.navigate.push(cb); return () => {}; };
  bones.onUpdates = cb => { subs.updates.push(cb); return () => {}; };
  bones.onAgreed = cb => { subs.agreed.push(cb); return () => {}; };
  const page = loadPage(bones, { hash });
  await page.settle(30);
  /** Push the mock's status to the page, like main does on api.onChange. */
  const push = async () => { const s = await ipc.call('status'); for (const cb of subs.status) cb(s); await page.settle(); };
  // main's onNoticeSeen: the status again, without what was put away.
  ctx.onNoticeSeen = () => { push(); };
  /** What Paste key reads next; the rate limit is reset so the next click reads it. */
  const setClipboard = (t) => { clip.text = String(t ?? ''); ctx.lastPasteAt = 0; };
  const start = page.document.querySelector('[data-fk="start-setup"]');
  if (!welcome && start) { await page.press(start); await page.settle(); }
  return { ...page, mock, api, ipc, ctx, confirms, calls, opened, subs, push, store, appState: () => appState, clip, setClipboard, notified, loginSets };
}
