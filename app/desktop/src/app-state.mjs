// The shell's own small settings file (<userData>/app-state.json, owner-only;
// RT-9): whether setup is done, desktop notifications on or off, the window's
// zoom level (src/zoom.mjs), the update preferences, and which model notices
// the player put away with Okay; for setup (onboarding spec §3.11): the saved
// screen ({v: 2, screen, path, provider}: no secrets), whether the defaults were
// seen, whether macOS was asked about notifications, and the addon install's consent
// (src/model-notice.mjs; ids only). Nothing secret lives here. A missing or damaged file reads as
// the defaults; writes are atomic (temp file, then rename).
import fs from 'node:fs';
import path from 'node:path';
import { addSeen } from './model-notice.mjs';
import { cleanZoom } from './zoom.mjs';

export const DEFAULT_STATE = Object.freeze({
  v: 1,
  onboarded: false,
  notifications: true,
  zoom: 0,
  updates: { mode: 'notify', auto: true, relaunchHidden: false, neverSince: null, lastReminder: null, lastCheck: null },
  noticesSeen: [],
  defaultsSeen: false,
  alertsAsked: false,
  addonConsent: null,
  setup: null,
});
const SCREENS = ['welcome', 'ai', 'connect', 'defaults', 'wow'];
const PATHS = ['key', 'custom'];
/** Setup's paths before Other (custom) took their place: OpenRouter's key, its free sign-in, a model on this computer. */
const LEGACY_PATHS = new Set(['openrouter-key', 'free', 'local']);
const ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The saved setup screen: v2 only (a v1 file has none), known screens and paths, no secrets. A screen
 * saved on OpenRouter's, the free or the local path reopens on Other (custom), where those now connect.
 */
function setupOf(v) {
  if (!isObj(v) || v.v !== 2 || !SCREENS.includes(v.screen)) return null;
  if (LEGACY_PATHS.has(v.path)) return { v: 2, screen: v.screen, path: 'custom', provider: 'custom' };
  return { v: 2, screen: v.screen, path: PATHS.includes(v.path) ? v.path : null, provider: typeof v.provider === 'string' && ID.test(v.provider) ? v.provider : null };
}
function consentOf(v) {
  if (!isObj(v) || !Number.isFinite(v.at)) return null;
  return { path: typeof v.path === 'string' && v.path.length <= 1024 ? v.path : null, at: v.at };
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const num = v => (Number.isFinite(v) ? v : null);

/** Keep only known fields with the right types. */
export function normalizeState(raw) {
  const r = isObj(raw) ? raw : {};
  const u = isObj(r.updates) ? r.updates : {};
  return {
    v: 1,
    onboarded: r.onboarded === true,
    notifications: r.notifications !== false,
    zoom: cleanZoom(r.zoom),
    updates: {
      mode: u.mode === 'never' ? 'never' : 'notify',
      auto: u.auto !== false, // Install updates automatically (Settings), on unless turned off (1.4.6)
      relaunchHidden: u.relaunchHidden === true, // a quiet install's relaunch opens no window (main.mjs)
      neverSince: num(u.neverSince),
      lastReminder: num(u.lastReminder),
      lastCheck: num(u.lastCheck),
    },
    noticesSeen: (Array.isArray(r.noticesSeen) ? r.noticesSeen : []).reduce(addSeen, []),
    defaultsSeen: r.defaultsSeen === true,
    alertsAsked: r.alertsAsked === true,
    addonConsent: consentOf(r.addonConsent),
    setup: setupOf(r.setup),
  };
}

export function createAppState(dir, { fsImpl = fs } = {}) {
  const file = path.join(dir, 'app-state.json');
  let state;
  try { state = normalizeState(JSON.parse(fsImpl.readFileSync(file, 'utf8'))); } catch { state = normalizeState(null); }
  const save = () => {
    try {
      fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      fsImpl.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
      fsImpl.renameSync(tmp, file);
    } catch {}
  };
  return {
    file,
    get: () => JSON.parse(JSON.stringify(state)),
    set(patch) {
      state = normalizeState({ ...state, ...patch, updates: patch.updates ? { ...state.updates, ...patch.updates } : state.updates });
      save();
      return this.get();
    },
    /** Okay on a model notice: its id, kept so the notice never shows again. */
    seeNotice(id) { state = normalizeState({ ...state, noticesSeen: addSeen(state.noticesSeen, id) }); save(); return this.get().noticesSeen; },
    noticesSeen: () => [...state.noticesSeen],
    updatesPrefs: () => ({ ...state.updates }),
    saveUpdatesPrefs(prefs) { state = normalizeState({ ...state, updates: { ...state.updates, ...prefs } }); save(); },
  };
}
