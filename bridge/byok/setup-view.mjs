// status().setup (onboarding spec §9.3; plan §5.2): the one block the setup screens and the tray
// read, built from what the bridge knows now. Pure, so the tests build it from fixtures, and
// nothing in it is a timer: every field is a fact the core, the capture helper or a click on the
// player's side made true. The Say hi rows tick from it, in place.
//
//   setupView({ platform, now, core, cs, captureOn, captureError, requestedAt, probe, addon,
//               wowRunning, launcher }) → setup
//
// core: the bridge core's status() (token: the last hello; firstMsgAt, firstReplyAt,
// firstReplyBefore, firstWords; warn; lastPayloadAt). cs: the capture helper's status()
// ({connected, permission, window, stats, error}). captureError: app-api's last typed helper error
// ({kind, at}). requestedAt: config.capture.permissionRequestedAt. probe: the last Screen Recording
// check ({permission, at}). addon: the install row, built by app-api (installView).
import { ASKED_MS } from './screen-permission.mjs';

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const num = v => (Number.isFinite(v) ? v : null);
const str = (v, re) => (typeof v === 'string' && (!re || re.test(v)) ? v : null);
const TYPED = new Set(['window_minimized', 'capture_blocked_by_app', 'signature_invalid', 'helper_missing', 'window_not_found', 'access_lost']);

/** The last hello, as the rows read it: when, the addon's interface, its sound check, locale, fr, mode, how it came. */
export function helloView(token) {
  if (!isObj(token) || !num(token.helloAt)) return null;
  return {
    at: token.helloAt,
    iface: str(token.iface),
    sig: str(token.sig),
    loc: str(token.loc, /^[a-z]{2}[A-Z]{2}$/),
    fr: token.fr === true || token.fr === '1',
    mode: ['pixel', 'stream', 'reload'].includes(token.mode) ? token.mode : null,
    via: str(token.helloVia),
  };
}

/**
 * Row 2 (macOS): not_asked until the player clicks Allow; asked for ASKED_MS after the request
 * (the request helper's own lifetime), then denied while a check says no; granted once a check
 * says yes or a frame was read (a decoded frame outranks any check).
 */
export function permissionOf({ platform, now, requestedAt, probe, cs, decoded }) {
  if (platform !== 'darwin') return 'n/a';
  if (decoded || probe?.permission === true || cs?.permission === true) return 'granted';
  if (num(requestedAt)) {
    if (now - requestedAt < ASKED_MS) return 'asked';
    if (probe?.permission === false || cs?.permission === false) return 'denied';
    return 'asked';
  }
  return 'not_asked';
}

/** What screen reading does now, in one word (the D-01 card after setup, [Not ticking?]). */
export function captureStateOf({ platform, mode, captureOn, typedError, permission, cs, decoded, readingOff = false }) {
  // Off in the app (its Screen Reading switch) or in the addon (its session's mode): nothing to allow.
  if (readingOff || mode === 'stream' || mode === 'reload') return 'off';
  if (typedError === 'signature_invalid' || typedError === 'helper_missing') return 'damaged';
  if (typedError === 'window_minimized') return 'minimized';
  if (typedError === 'capture_blocked_by_app') return 'blocked';
  if (!captureOn) return 'unknown';
  if (platform === 'darwin' && permission !== 'granted') return 'no_permission';
  if (decoded && cs?.connected !== false) return 'ok';
  if (cs?.window) return 'no_signal';
  return 'unknown';
}

export function setupView({
  platform = process.platform, now = Date.now(), core = null, cs = null, captureOn = false, captureError = null, readingOff = false,
  requestedAt = null, probe = null, addon = null, wowRunning = false, launcher = false,
} = {}) {
  const c = isObj(core) ? core : {};
  const hello = helloView(c.token);
  const stats = isObj(cs?.stats) ? cs.stats : {};
  const decoded = (Number(stats.decoded) || 0) > 0 || !!num(c.lastPayloadAt);
  const typedError = str(cs?.error?.kind) ?? str(captureError?.kind);
  const permission = permissionOf({ platform, now, requestedAt: num(requestedAt), probe, cs, decoded });
  const mode = hello?.mode ?? null;
  const warn = typeof c.warn === 'string' ? c.warn : '';
  return {
    addon: isObj(addon) ? addon : { state: 'looking', path: null, candidates: [], admin: null, consent: false },
    permission,
    launcher: !!launcher,
    game: {
      running: !!wowRunning,
      hello,
      ifaceMismatch: /slot addons are for interface/.test(warn),
      facts: {
        permission: platform === 'darwin' ? (permission === 'granted' ? true : cs?.permission ?? null) : null,
        window: !!cs?.window,
        frames: Number(stats.frames) || 0,
        decoded: Number(stats.decoded) || 0,
        typedError: typedError && TYPED.has(typedError) ? typedError : null,
      },
    },
    captureState: captureStateOf({ platform, mode, captureOn, typedError, permission, cs, decoded, readingOff }),
    firstMsgAt: num(c.firstMsgAt),
    firstReplyAt: num(c.firstReplyAt),
    firstReplyBefore: c.firstReplyBefore === true || hello?.fr === true,
    firstWords: typeof c.firstWords === 'string' && c.firstWords ? c.firstWords.slice(0, 200) : null,
  };
}
