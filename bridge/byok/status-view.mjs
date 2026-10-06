// The words for the bridge's state (BYOK PRD UX-1, §10; systems plan SY-06/D5 "one vocabulary"):
// one table here, which the bridge publishes (app-api status().view) and the desktop app reads (the
// window's bar and cards through renderer/format.js, the tray and notifications through
// src/status-text.mjs). Neither keeps a table of its own. The addon's copy moves here when the one
// addon lands (D5; its lines are listed in docs/byok/BUILD-PLAN.md "One vocabulary").
//
//   statusView(status, {platform}) → {
//     key,          the view: rt.state, or not_running | paused | sending_paused | signed_out |
//                   model_retired | last_error (viewKey)
//     words, tone,  the bar's and the tray's words for it, and 'ok' | 'warn' | 'bad' | 'muted'
//     needsPlayer,  the tray's attention icon: something only the player can fix
//     sending,      the typed guard's card, while it holds: {headline, detail, action: 'resume_sending'}
//     checkIns,     the check-ins fuse's line, while it holds: {line}
//     screen,       screen reading: {state, mode: 'screen'|'none', ok, headline, detail?, action?}; ok false
//                   is a problem the tray asks about while WoW runs (a minimized WoW is ok: no alarm)
//     settingsReset, this start couldn't read the settings and began on the defaults: {headline, detail}
//     gameUpdate,   patch day (SY-29): the app set the addon's TOCs to a new World of Warcraft's
//                   interface number: {state: 'ok'|'restart'|'failed', id, ok, headline, detail?, to}
//     saving,       chats that can't be saved (code health BR-11): a write the disk refused,
//                   status().store.writeError: {diskFull, headline, detail}, until it's made again
//   }
//
// Player words follow docs/STYLE.md (on the ux-copy branch): "AI", never "provider"; "check-ins"
// for the messages Bones sends on its own; "screen reading", never capture, strip, signal or
// pixel; sentence case; durations spelled out in a sentence ("in 12 seconds"), "12 s" in a compact
// line; whole sentences with named placeholders (template literals here). The app is named by its
// identity (APP: bridge/identity.mjs productName).
import { IDENTITY } from '../identity.mjs';

const APP = IDENTITY.productName;

export const STATE_WORDS = Object.freeze({
  ready: 'Ready',
  no_key: 'No key',
  key_invalid: 'Key rejected',
  slowed: 'Slowed down',
  out_of_credit: 'Out of credit',
  cap: 'Daily spend limit reached',
  provider_down: 'AI not answering',
  local_down: 'Model app stopped',
  paused: 'Paused',
  sending_paused: 'Sending paused',
  not_running: 'Couldn’t start',
  signed_out: 'Signed out',
  model_retired: 'Model retired',
  last_error: 'Last message failed',
});
export const STATE_TONE = Object.freeze({
  ready: 'ok', no_key: 'warn', key_invalid: 'bad', slowed: 'warn', out_of_credit: 'bad',
  cap: 'bad', provider_down: 'bad', local_down: 'bad', paused: 'warn', sending_paused: 'bad',
  not_running: 'bad', signed_out: 'bad', model_retired: 'bad', last_error: 'bad',
});
/** no_key with no AI picked at all: the setup story's words, as the home card says it (bones-ux-writer r2, UX-W25). */
export const NO_AI_WORDS = 'No AI yet';
/**
 * not_running for a bridge that stopped while the app ran on (rt.reason app_stopped; fix-102): the
 * app started fine and needs a restart, which the window's card says with Quit and reopen.
 */
export const RESTART_WORDS = 'Needs a restart';
/** The views that need the player: the tray's attention icon, the window's state card. */
export const NEEDS_PLAYER = Object.freeze(['no_key', 'key_invalid', 'signed_out', 'out_of_credit', 'cap', 'provider_down', 'local_down', 'sending_paused', 'not_running', 'model_retired', 'last_error']);

/**
 * The one sentence for no screen reading: the addon's Screen Reading switch turned off (stream mode,
 * `/nqa stream on`; bones-ux-writer onboarding r1, UX-W02), the way setup and the landing page say it.
 */
export const NO_SCREEN_READING = 'Nothing is drawn, so your messages wait for a reload, and replies still come in.';
export const NO_SCREEN_READING_COMMAND = '/nqa stream on';

/** Settings that couldn't be read, so this start began on the defaults (SY-12). Keys are in the OS store. */
export const SETTINGS_RESET = Object.freeze({ headline: 'Your settings couldn’t be read and were reset.', detail: 'Your keys are kept. Check your AI and spend limit.' });

/**
 * Patch day (systems critic SY-29): a new version of World of Warcraft, and what the app did about it.
 * The game won't load an addon whose TOCs name an older interface number, so the app sets them to the
 * game's (wow.mjs retargetAddon); a game that was running then loads it at its next start.
 */
export const PATCH_WORDS = Object.freeze({
  updated: `${APP} updated the addon for the new version of World of Warcraft.`,
  restart: 'Restart WoW to load it.',
  failed: `${APP} couldn’t update the addon for the new version of World of Warcraft.`,
  failedRunning: `Quit WoW, and ${APP} tries again.`,
  failedClosed: 'In Settings, click Show more, then Run setup again.', // the button is behind Show more (CL-words-84)
});

/**
 * Chats that can't be saved (code health BR-11): a write the disk refused, status().store.writeError
 * ({file, code, at, diskFull}). The store keeps what the file would hold and writes it again by itself
 * (the 30-second flush), so the next step is the player's alone, outside the app: a disk with room.
 */
export const SAVE_WORDS = Object.freeze({
  diskFull: Object.freeze({ headline: 'Your disk is full, so chats aren’t saved.', detail: `Free up space, and ${APP} saves them.` }),
  // Not a full disk (the store says which), so the step isn't one the app has ruled out (bones-ux-writer UX-W03).
  failed: Object.freeze({ headline: `${APP} can’t save your chats.`, detail: 'Restart your computer if it keeps happening.' }),
});
/**
 * The cap held because today's spend couldn't be read (rt.reason load_error, code health BR-09): the tray's
 * word says so, never that the limit was reached (bones-ux-writer UX-W02). Home's card has the fix.
 */
export const SPEND_UNKNOWN_WORDS = 'Today’s spend unknown';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').slice(0, n);

/**
 * A span of time in a sentence: "a minute", "an hour", "5 minutes", "12 seconds" (whole units; the
 * fuse windows are whole minutes or hours).
 */
export function spanText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'a short time';
  if (n % 3_600_000 === 0) return n === 3_600_000 ? 'an hour' : `${n / 3_600_000} hours`;
  if (n % 60_000 === 0) return n === 60_000 ? 'a minute' : `${n / 60_000} minutes`;
  const s = Math.max(1, Math.round(n / 1000));
  return s === 1 ? '1 second' : `${s} seconds`;
}

/**
 * The view key: the bridge's rt.state, except a start that failed (not_running), everything paused
 * (paused), the typed guard holding (sending_paused), an OpenRouter sign-in that ended
 * (signed_out), a retired model (model_retired) and, while rt is ready, the last failure the game
 * sends to the desktop (last_error: app-api lastErrorView), which each need a different fix. null
 * while nothing is known yet.
 */
export function viewKey(status) {
  const b = isObj(status?.backend) ? status.backend : {};
  const rt = isObj(b.rt) ? b.rt : {};
  const st = rt.state;
  if (!st) return null;
  if (st === 'not_running' || (st === 'provider_down' && (rt.reason === 'bridge_unavailable' || rt.reason === 'no_backend'))) return 'not_running';
  if (st === 'paused') return 'paused';
  if (isObj(b.sendingPaused)) return 'sending_paused';
  if (st === 'signed_out' || (st === 'key_invalid' && (rt.reason === 'sign-in ended' || b.provider?.keyState === 'expired'))) return 'signed_out';
  if (st === 'no_key' || st === 'key_invalid') return st;
  if (st === 'model_retired' || rt.reason === 'model_retired' || b.notice?.kind === 'model_retired') return 'model_retired';
  if (st === 'ready' && b.lastError?.kind && !b.lastError.notice) return 'last_error';
  return st;
}

/** The typed guard's card (systems plan D4): more than `turns` typed messages within `windowMs`. */
export function sendingLines(sp) {
  if (!isObj(sp)) return null;
  const n = Number.isInteger(sp.turns) && sp.turns > 0 ? sp.turns : 20;
  return {
    headline: 'Sending is paused.',
    detail: `More than ${n} messages went in ${spanText(sp.windowMs ?? 60_000)}, which normal play doesn’t do.`,
    action: 'resume_sending',
  };
}

/** The check-ins fuse's line (spec §9.9; systems plan D4): the window that tripped, the companion's name. */
export function checkInsLine(fuse, name = 'NeverQuestAlone') {
  if (!isObj(fuse)) return null;
  const n = Number.isInteger(fuse.turns) && fuse.turns > 0 ? fuse.turns : 10;
  const who = clip(name, 24) || 'NeverQuestAlone';
  return { line: `${who} paused check-ins: more than ${n} came in ${spanText(fuse.windowMs ?? 60_000)}, which normal play doesn’t do. Your next message turns them back on.` };
}

/**
 * Screen reading as the player needs to know it (systems plan SY-04), from status().capture
 * ({state, mode, ...}): one headline and at most one next step per state. mode 'none' is no screen
 * reading (the app's own switch, a platform with no helper, or the addon's `/bones mode reload`).
 * null before there's a game folder (nothing to read yet).
 *
 * The states (display DR-06): the capture watchdog's published ones (ok, off, no_permission,
 * no_signal, blocked, damaged, unsupported; bridge/transport/capture-health.mjs) and the app's own:
 * no_game (no WoW folder yet), waiting (WoW closed, or the helper not started yet), watching (the
 * helper follows WoW, and nothing was read since it attached: no claim either way, SY-27) and
 * window_minimized (WoW minimized while nothing is published: said, never an alarm). no_signal's one
 * action is Restart screen reading (restart_capture); its Windows words name the top-left corner,
 * where an overlay covers the corner Bones reads; a Mac has no such cover, so its words name the button.
 */
export function screenView(capture, { platform = 'darwin', name = 'NeverQuestAlone' } = {}) {
  if (!isObj(capture) || capture.state === 'no_game') return null;
  if (capture.mode === 'reload' || capture.state === 'off') {
    return { state: capture.state === 'off' ? 'off' : 'reload', mode: 'none', ok: true, headline: 'No screen reading', detail: NO_SCREEN_READING, command: NO_SCREEN_READING_COMMAND };
  }
  // The companion's own name (STYLE §11; bones-ux-writer r2, UX-W26), as checkInsLine takes it.
  const who = clip(name, 24) || 'NeverQuestAlone';
  // The app reads the screen, not the companion (STYLE §9; UX-W10): "{name} can’t see the game." only for the failure.
  const cant = `${who} can’t see the game.`;
  const corner = 'Keep the top of WoW’s window on screen.';
  switch (capture.state) {
    case 'ok': return { state: 'ok', mode: 'screen', ok: true, headline: 'The app can see WoW.' };
    case 'waiting': return { state: 'waiting', mode: 'screen', ok: true, headline: 'The app looks for WoW when it starts.' };
    case 'watching': return { state: 'watching', mode: 'screen', ok: true, headline: 'Screen reading is on.' };
    case 'window_minimized':
      return { state: 'window_minimized', mode: 'screen', ok: true, headline: 'WoW is minimized.', detail: 'The app can see WoW again when you bring it back.' };
    case 'no_signal':
      return { state: 'no_signal', mode: 'screen', ok: false, headline: cant, detail: platform === 'win32' ? corner : 'Click Restart screen reading.', action: 'restart_capture' };
    case 'blocked': return { state: 'blocked', mode: 'screen', ok: false, headline: cant, detail: 'Close what blocks screen reading.' };
    case 'no_permission':
      return platform === 'darwin'
        ? { state: 'no_permission', mode: 'screen', ok: false, headline: cant, detail: 'Allow Screen Recording in System Settings.', action: 'screen_recording' }
        : { state: 'no_permission', mode: 'screen', ok: false, headline: cant, detail: corner };
    case 'unsupported': case 'capture_unsupported':
      return { state: capture.state, mode: 'screen', ok: false, headline: `${who} can’t read this screen.`, detail: `Turn off screen reading to play without it: your messages then wait for a /reload.`, action: 'no_screen_reading' };
    case 'damaged': case 'signature_invalid': case 'helper_missing': case 'helper_failed':
      return { state: capture.state, mode: 'screen', ok: false, headline: cant, detail: `Download ${APP} again.`, action: 'download' };
    default:
      return { state: String(capture.state ?? 'error').slice(0, 40), mode: 'screen', ok: false, headline: cant, detail: corner };
  }
}

/**
 * The patch-day line (SY-29) from status().wow: {patch: {to, restart, failed?}, running}. One headline
 * and at most one next step: none when the addon is ready (WoW closed, or the addon heard since),
 * "Restart WoW" while a WoW that read the old TOCs runs, and the fix when the TOCs couldn't be
 * written. id tells one update's state from another (Okay puts one away). null with no update.
 */
export function patchView(wow) {
  const pd = isObj(wow?.patch) ? wow.patch : null;
  if (!pd) return null;
  const to = clip(pd.to, 8);
  const running = wow.running === true;
  if (pd.failed) return { state: 'failed', id: `${to}:failed`, ok: false, headline: PATCH_WORDS.failed, detail: running ? PATCH_WORDS.failedRunning : PATCH_WORDS.failedClosed, to };
  if (pd.restart === true && running) return { state: 'restart', id: `${to}:restart`, ok: false, headline: PATCH_WORDS.updated, detail: PATCH_WORDS.restart, to };
  return { state: 'ok', id: `${to}:ok`, ok: true, headline: PATCH_WORDS.updated, to };
}

/** The card for chats that can't be saved (BR-11), from status().store.writeError; null while every write goes. */
export function savingLines(we) {
  if (!isObj(we)) return null;
  const diskFull = we.diskFull === true;
  return { diskFull, ...(diskFull ? SAVE_WORDS.diskFull : SAVE_WORDS.failed) };
}

/** Everything the app shows about the state, from one status() result (see the header). */
export function statusView(status, { platform = 'darwin' } = {}) {
  const b = isObj(status?.backend) ? status.backend : {};
  const rt = isObj(b.rt) ? b.rt : {};
  const key = viewKey(status);
  let words = STATE_WORDS[key] ?? (key ? 'Working' : 'Starting');
  if (key === 'no_key' && !isObj(b.provider)) words = NO_AI_WORDS;
  if (key === 'not_running' && rt.reason === 'app_stopped') words = RESTART_WORDS;
  if (key === 'cap' && rt.reason === 'load_error') words = SPEND_UNKNOWN_WORDS;
  if (key === 'slowed' && Number.isFinite(rt.retryIn)) words = `Slowed down · retrying in ${Math.max(0, Math.round(rt.retryIn))}\u00a0s`; // a number and its unit stay together (STYLE §8, §13; UX-W37)
  const screen = screenView(status?.capture, { platform, name: b.provider?.companion });
  const wowRunning = status?.wow?.running === true;
  const usage = isObj(b.usage) ? b.usage : {};
  const gameUpdate = patchView(status?.wow);
  const saving = savingLines(status?.store?.writeError);
  return {
    key,
    words,
    tone: STATE_TONE[key] ?? 'muted',
    // The tray's attention: a state only the player can fix, the spend limit nearly used, screen
    // reading failing while WoW runs, a new World of Warcraft that needs a restart or a fix, or chats
    // that can't be saved (BR-11).
    needsPlayer: NEEDS_PLAYER.includes(key) || usage.needs === 'near_cap' || (!!screen && screen.ok === false && wowRunning) || (!!gameUpdate && !gameUpdate.ok) || !!saving,
    sending: sendingLines(b.sendingPaused),
    checkIns: usage.autoPaused === true ? checkInsLine(usage.fuse ?? {}, b.provider?.companion) : null,
    screen,
    settingsReset: status?.settings?.reset === true ? { ...SETTINGS_RESET } : null,
    gameUpdate,
    saving,
  };
}
