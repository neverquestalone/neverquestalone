// What the shell removes on uninstall (BYOK PRD §16.3 "Uninstall", OB-3,
// B3.5 "leaves nothing behind"). The bridge's uninstall (app-api) removes the
// saved keys and, when asked, the addon; the shell then removes:
//   - the app's data folder (userData), and the logs folder where the OS keeps
//     it apart (macOS: ~/Library/Logs/NeverQuestAlone, which holds shell.log
//     and the bridge's logs); elsewhere logs sit inside userData;
//   - electron-updater's download cache (<cache>/neverquestalone-updater, the
//     updaterCacheDirName electron-builder writes into app-update.yml) and, on
//     macOS, Squirrel.Mac's (~/Library/Caches/com.neverquestalone.app.ShipIt),
//     plus what macOS keeps under the bundle id (HTTP storage, saved window
//     state, the preferences file);
//   - the login item (src/login-item.mjs), and on Windows the NSIS uninstaller
//     removes it again with the keys (build/installer.nsh);
//   - on macOS, the Screen Recording (TCC) entries of the app and of the
//     capture helper, which runs under its own bundle id (the packaged app's
//     bridge/capture/mac/BUNDLE_ID, from app/desktop/build/bridge/capture/mac/
//     BUNDLE_ID) and so holds the permission itself. Only ids this app ships
//     (com.neverquestalone.*): never another build's helper, a checkout's
//     included, whose grant is someone else's to keep (final review L3-4).
// Every path is checked against its exact expected name before it's deleted,
// so a wrong or empty path can never take a parent folder with it. The names
// are the app's identity's (src/identity.mjs; NeverQuestAlone's in the examples
// above).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IDENTITY } from './identity.mjs';

export const APP_ID = IDENTITY.appId;
/** Electron's data and logs folders, named after the product (macOS, Windows). */
export const PRODUCT_DIR = IDENTITY.productName;
/** electron-updater's download cache: the updaterCacheDirName electron-builder derives from the package name. */
export const UPDATER_CACHE_DIR = `${IDENTITY.name}-updater`;
/** The packaged app's bridge/capture/mac/BUNDLE_ID (app/desktop/build/…), when the file isn't in this build. */
export const DEFAULT_CAPTURE_BUNDLE_ID = IDENTITY.captureHelper?.bundleId ?? null;
/**
 * The ids this app ships (the app's and its helper's) share the app id's prefix (com.neverquestalone.
 * for com.neverquestalone.app): uninstall resets no other Screen Recording grant, and never the
 * checkout build's helper (<helper id>.dev, rename spec H31).
 */
const OURS = APP_ID.slice(0, APP_ID.lastIndexOf('.') + 1);
const CHECKOUT_HELPER = DEFAULT_CAPTURE_BUNDLE_ID ? `${DEFAULT_CAPTURE_BUNDLE_ID}.dev` : null;
export const isOurs = id => id.startsWith(OURS) && id !== CHECKOUT_HELPER;
export const BUNDLE_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** The per-user cache root electron-updater uses (its getAppCacheDir). */
export function cacheBase({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const abs = v => (typeof v === 'string' && path.isAbsolute(v) ? v : null);
  if (platform === 'win32') return abs(env.LOCALAPPDATA) ?? path.join(home, 'AppData', 'Local');
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches');
  return abs(env.XDG_CACHE_HOME) ?? path.join(home, '.cache');
}

function inside(dir, p) {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The folders and files to delete, each with the one name it may have. */
export function uninstallTargets({ platform = process.platform, env = process.env, home = os.homedir(), userData, logs }) {
  const out = [];
  const add = (p, name, kind = 'dir') => {
    if (typeof p === 'string' && path.isAbsolute(p) && path.basename(p) === name && path.dirname(p) !== p) out.push({ path: p, kind });
  };
  add(userData, PRODUCT_DIR);
  if (logs && !(userData && inside(userData, logs))) add(logs, PRODUCT_DIR);
  const cache = cacheBase({ platform, env, home });
  add(path.join(cache, UPDATER_CACHE_DIR), UPDATER_CACHE_DIR);
  if (platform === 'darwin') {
    const lib = path.join(home, 'Library');
    add(path.join(cache, `${APP_ID}.ShipIt`), `${APP_ID}.ShipIt`);
    add(path.join(cache, APP_ID), APP_ID);
    add(path.join(lib, 'HTTPStorages', APP_ID), APP_ID);
    add(path.join(lib, 'Saved Application State', `${APP_ID}.savedState`), `${APP_ID}.savedState`);
    add(path.join(lib, 'Preferences', `${APP_ID}.plist`), `${APP_ID}.plist`, 'file');
  }
  const seen = new Set();
  return out.filter(t => (seen.has(t.path) ? false : seen.add(t.path)));
}

export function removeTargets(targets, { fsImpl = fs } = {}) {
  const removed = [];
  for (const t of targets) {
    try {
      if (!fsImpl.existsSync(t.path)) continue;
      fsImpl.rmSync(t.path, { recursive: t.kind === 'dir', force: true });
      removed.push(t.path);
    } catch {}
  }
  return removed;
}

/** The capture helper's bundle id: its one source file, read only from inside the app when packaged. */
export function readCaptureBundleId(roots, { fsImpl = fs } = {}) {
  for (const root of roots) {
    try {
      const id = fsImpl.readFileSync(path.join(root, 'bridge', 'capture', 'mac', 'BUNDLE_ID'), 'utf8').trim();
      if (BUNDLE_ID_RE.test(id)) return id;
    } catch {}
  }
  return null;
}

/** Bundle ids whose Screen Recording entry uninstall resets: the app, the capture helper, and any the bridge names. */
export function tccBundleIds({ fromBridge = [], fromFile = null } = {}) {
  const ids = [APP_ID, fromFile ?? DEFAULT_CAPTURE_BUNDLE_ID, ...(Array.isArray(fromBridge) ? fromBridge : [])];
  return [...new Set(ids.filter(id => typeof id === 'string' && id.length <= 155 && BUNDLE_ID_RE.test(id) && isOurs(id)))];
}
