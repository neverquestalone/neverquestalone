// "Start NeverQuestAlone when I log in" (BYOK PRD §11.1 "Background", PF-2,
// §16.1 step 9, §16.3 "Uninstall").
//   macOS, Windows  Electron's setLoginItemSettings: a login item, or the
//                   HKCU Run value named after the app id (so the NSIS
//                   uninstaller can find it) that starts the app with --hidden.
// Linux runs from source only (systems plan D6: no AppImage or .deb, so no
// installed binary an autostart entry could name), anything else, and an
// unpackaged run report supported:false, and the window greys the checkbox out
// with a line saying why.

import { IDENTITY } from './identity.mjs';

/** The Run value's name on Windows: the app id (the app's identity's), which the NSIS uninstaller removes. */
export const APP_ID = IDENTITY.appId;

/**
 * createLoginItem({ app, packaged, platform })
 * → { get() → {supported, openAtLogin, reason?}, set(open) → {ok, ...get()} | {ok:false, error} }
 */
export function createLoginItem({ app, packaged, platform = process.platform }) {
  const winArgs = platform === 'win32' ? { args: ['--hidden'] } : {};

  function get() {
    if (!packaged) return { supported: false, openAtLogin: false, reason: 'dev_build' };
    if (platform === 'darwin' || platform === 'win32') {
      const out = { supported: true, openAtLogin: !!app.getLoginItemSettings(winArgs).openAtLogin };
      // macOS 13+: whether the system lets it open ('enabled', 'requires-approval', …): setup's
      // Say hi screen names the Login Items pane while it's held (onboarding spec §3.8).
      if (platform === 'darwin') {
        try {
          const st = app.getLoginItemSettings({ type: 'mainAppService' })?.status;
          if (typeof st === 'string' && st) out.status = st;
        } catch { /* older macOS: no status */ }
      }
      return out;
    }
    return { supported: false, openAtLogin: false, reason: 'unsupported_os' };
  }

  function set(open) {
    const now = get();
    if (!now.supported) return { ok: false, error: now.reason === 'dev_build' ? 'dev_build' : 'unsupported' };
    app.setLoginItemSettings({ openAtLogin: !!open, ...winArgs, ...(platform === 'win32' ? { name: APP_ID } : {}) });
    return { ok: true, ...get() };
  }

  return { get, set };
}
