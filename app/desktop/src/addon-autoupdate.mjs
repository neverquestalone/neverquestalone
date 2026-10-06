// The addon the app put in updates itself (2026-10-05: installs stayed at the version first
// installed, because only Update on Set up WoW ever updated them). The first Install's click is the
// consent, kept for its folder (onboarding spec §3.11, ipc.mjs's addonConsent): when setup's view
// says the app's copy there is older than the one this app ships, main arms the install, which goes
// in at once while WoW is closed or the moment it closes (app-api's armInstall).
//
// Once a session per folder: a failure stays on Set up WoW's row and never loops. A folder with no
// consent recorded (installed before the consent was kept) counts as the app's own. The store
// work's ownership check replaces that test, so a store's copy is never touched (store PRD 2.x).

/** The folder to update now, or null. addon: setup's view of it; consent: appState.addonConsent; tried: a Set. */
export function addonToUpdate(addon, consent, tried) {
  if (!addon || addon.state !== 'older' || typeof addon.path !== 'string' || !addon.path) return null;
  if (consent && typeof consent.path === 'string' && consent.path && consent.path !== addon.path) return null;
  if (tried && tried.has(addon.path)) return null;
  return addon.path;
}
