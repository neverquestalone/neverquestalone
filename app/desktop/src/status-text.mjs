// Words for the bridge's state in the tray and in desktop notifications (BYOK PRD UX-1 vocabulary,
// §10 lines, ER-5). The words, tones and view keys are the bridge's one table
// (bridge/byok/status-view.mjs, systems plan SY-06/D5): a status carries them as status.view, and
// one without them (a stand-in status) gets them from the same module. The notifications' words are
// main's table (src/strings.mjs notifications). Nothing here keeps a table.
import { importBridge } from './bridge-module.mjs';
import { STRINGS } from './strings.mjs';

const { statusView, STATE_WORDS } = await importBridge('bridge/byok/status-view.mjs');
export { STATE_WORDS };

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, n);
const viewOf = status => (status?.view && typeof status.view === 'object' ? status.view : statusView(status ?? {}, { platform: process.platform }));

export function parts(status) {
  const b = status?.backend ?? {};
  return { rt: b.rt ?? {}, provider: b.provider ?? null, usage: b.usage ?? null, notice: b.notice ?? null, wow: status?.wow ?? {}, capture: status?.capture ?? {} };
}

/** The view key the bridge gave this status (status-view.mjs viewKey). */
export function viewKey(status) {
  return viewOf(status).key ?? null;
}

/** True while the player has something to fix: the tray shows its attention icon. */
export function needsPlayer(status) {
  return viewOf(status).needsPlayer === true;
}

/**
 * "Ready · Anthropic · Claude Haiku 4.5", "Slowed down · retrying in 18 s", "No key", "Couldn’t start".
 * setup: until setup is done (not onboarded), the tray tells the setup story as the window's bar
 * does: "Setting up" while nothing needs fixing, else the state's word alone (UX-W25, DU-08).
 */
export function trayLine(status, { setup = false } = {}) {
  const { provider } = parts(status);
  const v = viewOf(status);
  if (setup) return !v.key || v.key === 'ready' ? STRINGS.tray.setupLine : v.words;
  if (!provider || v.key === 'no_key' || v.key === 'not_running' || v.key === 'slowed') return v.words;
  return `${v.words} · ${clip(provider.name, 24)} · ${clip(provider.modelName ?? provider.model, 40)}`;
}

/**
 * One desktop notification for a state that needs the player on the desktop
 * (ER-5): key rejected, sign-in ended, out of credit, the daily spend limit the
 * player set reached (the public build has no limits of its own, so never
 * without one), local server down, a failure the game sends to the desktop
 * (last_error); and, through notify(), one-off notices
 * such as "an update is available". Held while the player is in combat; all
 * off with one setting. A click opens Home, the one page that shows the state and its fix (the app
 * trim keeps state cards there; CL-player-55).
 */
export function createNotifier({ show, enabled = () => true }) {
  let lastKind = null;
  let held = null;
  let combat = false;
  let pending = null; // the latest one-off notice, waiting for combat to end
  // The words are main's table's (src/strings.mjs notifications; bones-ux-writer onboarding r1,
  // UX-W12): whole sentences with named placeholders, the AI company for a key and its credit.
  const N = STRINGS.notifications;
  const fill = (t, v) => String(t).replace(/\{([A-Za-z]+)\}/g, (m, k) => (v[k] != null ? String(v[k]) : m));
  const usd = micros => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(micros / 1e6);
  const noticeFor = status => {
    const { provider, usage } = parts(status);
    const named = clip(provider?.name, 24);
    const v = { co: named || N.someCompany, app: named || N.someApp, name: clip(provider?.companion, 24) || 'NeverQuestAlone' };
    const title = t => fill(named ? t.title : t.titleNoCo, v);
    // Patch day (SY-29): WoW runs without the addon until it restarts, or the app couldn't set the
    // addon up for the new version. The player is likely in the game: this is how the app reaches them.
    const gu = viewOf(status).gameUpdate;
    if (gu && gu.ok === false) return { kind: `game_update:${clip(gu.id, 24)}`, title: clip(gu.headline, 120), body: clip(gu.detail, 200), page: 'home' };
    switch (viewKey(status)) {
      case 'key_invalid': return { kind: 'key_invalid', title: title(N.keyInvalid), body: N.keyInvalid.body, page: 'home' };
      case 'signed_out': return { kind: 'signed_out', title: title(N.signedOut), body: N.signedOut.body, page: 'home' };
      case 'out_of_credit': return { kind: 'out_of_credit', title: title(N.outOfCredit), body: fill(N.outOfCredit.body, v), page: 'home' };
      case 'cap': {
        // Held because today's spend couldn't be read (code health BR-09): Home's card's words, never "reached"
        // (bones-ux-writer UX-W02); its own kind, so a limit reached later is said too.
        if (status?.backend?.rt?.reason === 'load_error') return { kind: 'cap_unread', title: fill(N.capUnread.title, v), body: N.capUnread.body, page: 'home' };
        const amount = Number.isFinite(usage?.capMicros) ? usd(usage.capMicros) : null;
        return { kind: 'cap', title: amount ? fill(N.cap.title, { amount }) : N.cap.titleNoAmount, body: N.cap.body, page: 'home' };
      }
      case 'local_down': return { kind: 'local_down', title: fill(N.localDown.title, v), body: fill(N.localDown.body, v), page: 'home' };
      case 'sending_paused': {
        const sp = viewOf(status).sending ?? {};
        return { kind: 'sending_paused', title: clip(sp.headline, 120) || N.sendingPaused.title, body: clip(sp.detail, 200), page: 'home' };
      }
      case 'last_error': {
        const le = status?.backend?.lastError ?? {};
        return { kind: `last_error:${clip(le.kind, 40)}`, title: clip(le.headline, 120) || N.lastError.title, body: N.lastError.body, page: 'home' };
      }
      default: return null;
    }
  };
  return {
    /** A one-off notice (updates): shown now, or when combat ends; nothing when notifications are off. */
    notify(n) {
      if (!n || !enabled()) return null;
      if (combat) { pending = n; return null; }
      show(n);
      return n;
    },
    update(status) {
      combat = !!status?.wow?.combat;
      if (!combat && pending) {
        const p = pending;
        pending = null;
        if (enabled()) show(p);
      }
      const n = noticeFor(status);
      if (!n) { lastKind = null; held = null; return null; }
      if (n.kind !== lastKind) { lastKind = n.kind; held = n; } // a new condition: pending until shown
      if (!held) return null;                                    // already shown for this condition
      if (!enabled()) { held = null; return null; }
      if (status?.wow?.combat) return null;                      // hold until combat ends
      const out = held;
      held = null;
      show(out);
      return out;
    },
  };
}
