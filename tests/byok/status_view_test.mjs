// The one vocabulary (bridge/byok/status-view.mjs; systems plan SY-06/D5, D4, SY-04): the view keys
// and their order, the words, the typed guard's card, the check-ins line and screen reading, in the
// player's words (docs/STYLE.md: "AI", never "provider"; "check-ins"; "screen reading", never
// capture, strip, signal or pixel; durations spelled out in a sentence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { statusView, viewKey, spanText, sendingLines, checkInsLine, screenView, savingLines, STATE_WORDS, STATE_TONE, NEEDS_PLAYER, NO_SCREEN_READING, SAVE_WORDS, SPEND_UNKNOWN_WORDS } from '../../bridge/byok/status-view.mjs';
import { IDENTITY } from '../../bridge/identity.mjs';

const APP = IDENTITY.productName; // the app's name in its own sentences

const st = (rt, b = {}, extra = {}) => ({ backend: { rt, ...b }, ...extra });

test('spanText spells a window out for a sentence', () => {
  assert.equal(spanText(60_000), 'a minute');
  assert.equal(spanText(3_600_000), 'an hour');
  assert.equal(spanText(300_000), '5 minutes');
  assert.equal(spanText(7_200_000), '2 hours');
  assert.equal(spanText(12_000), '12 seconds');
  assert.equal(spanText(1_000), '1 second');
  assert.equal(spanText(null), 'a short time');
});

test('viewKey: a failed start, the player\'s pause and the typed guard come first; then the fixes that differ', () => {
  assert.equal(viewKey(null), null);
  assert.equal(viewKey(st({ state: 'provider_down', reason: 'bridge_unavailable' })), 'not_running');
  assert.equal(viewKey(st({ state: 'paused' }, { sendingPaused: { turns: 20 } })), 'paused');
  assert.equal(viewKey(st({ state: 'ready' }, { sendingPaused: { turns: 20 } })), 'sending_paused');
  assert.equal(viewKey(st({ state: 'key_invalid' }, { sendingPaused: { turns: 20 } })), 'sending_paused', 'nothing sends until Resume sending, whatever else is wrong');
  assert.equal(viewKey(st({ state: 'key_invalid', reason: 'sign-in ended' })), 'signed_out');
  assert.equal(viewKey(st({ state: 'ready' }, { notice: { kind: 'model_retired' } })), 'model_retired');
  assert.equal(viewKey(st({ state: 'ready' }, { lastError: { kind: 'bad_request' } })), 'last_error');
  assert.equal(viewKey(st({ state: 'ready' }, { lastError: { kind: 'bad_request', notice: true } })), 'ready', 'a one-off is a notice, not a state');
});

test('the table: every key has words and a tone; the words are the player\'s', () => {
  for (const k of Object.keys(STATE_WORDS)) assert.ok(STATE_TONE[k], k);
  for (const k of NEEDS_PLAYER) assert.ok(STATE_WORDS[k], k);
  const all = Object.values(STATE_WORDS).join(' ') + NO_SCREEN_READING;
  assert.doesNotMatch(all, /provider|capture|strip|signal|pixel|bridge/i);
});

test('the typed guard\'s card and the check-ins line: whole sentences with the numbers filled in', () => {
  assert.deepEqual(sendingLines({ turns: 20, windowMs: 60_000 }), { headline: 'Sending is paused.', detail: 'More than 20 messages went in a minute, which normal play doesn’t do.', action: 'resume_sending' });
  assert.equal(sendingLines(null), null);
  assert.deepEqual(checkInsLine({ turns: 60, windowMs: 3_600_000 }, 'Nova'), { line: 'Nova paused check-ins: more than 60 came in an hour, which normal play doesn’t do. Your next message turns them back on.' });
  assert.equal(checkInsLine({ turns: 10, windowMs: 60_000 }).line.startsWith('NeverQuestAlone paused check-ins: more than 10 came in a minute'), true);
  const v = statusView(st({ state: 'ready' }, { usage: { autoPaused: true, fuse: { turns: 60, windowMs: 3_600_000 } }, provider: { companion: 'Nova' } }));
  assert.match(v.checkIns.line, /^Nova paused check-ins/);
  assert.equal(v.needsPlayer, false, 'check-ins pausing needs nothing from the player: their next message ends it');
  assert.equal(statusView(st({ state: 'ready' }, { usage: {} })).checkIns, null);
});

test('screen reading: one headline and at most one next step per state; no screen reading is its own mode', () => {
  const s = (state, mode = 'capture', platform = 'darwin') => screenView({ state, mode }, { platform });
  assert.equal(screenView({ state: 'no_game' }), null);
  // The app reads the screen, not the companion (STYLE §9): the ok and waiting lines say the app.
  assert.deepEqual(s('ok'), { state: 'ok', mode: 'screen', ok: true, headline: 'The app can see WoW.' });
  assert.equal(s('waiting').headline, 'The app looks for WoW when it starts.');
  assert.equal(s('no_permission').detail, 'Allow Screen Recording in System Settings.');
  assert.equal(s('no_permission').action, 'screen_recording');
  assert.equal(s('no_permission', 'capture', 'win32').detail, 'Keep the top of WoW’s window on screen.', 'no Screen Recording on Windows');
  for (const k of ['window_not_found', 'access_lost', 'capture_blocked_by_app', 'something_new']) {
    assert.deepEqual([s(k).headline, s(k).detail, s(k).ok], ['NeverQuestAlone can’t see the game.', 'Keep the top of WoW’s window on screen.', false], k);
  }
  // No screen reading is the addon's Screen Reading switch (stream mode), in setup's words.
  assert.equal(s('capture_unsupported').detail, 'Turn off screen reading to play without it: your messages then wait for a /reload.');
  // The companion's own name (STYLE §11; UX-W26): a renamed companion's section is "What Mira Knows".
  const mira = screenView({ state: 'capture_unsupported', mode: 'capture' }, { name: 'Mira' });
  assert.deepEqual([mira.headline, mira.detail], ['Mira can’t read this screen.', 'Turn off screen reading to play without it: your messages then wait for a /reload.']);
  assert.equal(screenView({ state: 'no_signal', mode: 'capture' }, { name: 'Mira' }).headline, 'Mira can’t see the game.');
  assert.equal(statusView({ backend: { rt: { state: 'window_minimized' }, provider: { companion: 'Mira' } }, capture: { state: 'unsupported', mode: 'capture' } }).screen.headline, 'Mira can’t read this screen.', 'statusView passes the name');
  assert.equal(s('capture_unsupported').action, 'no_screen_reading');
  assert.equal(s('helper_missing').detail, `Download ${APP} again.`);
  // The capture watchdog's published keys (display DR-04): unsupported keeps its own words and action
  // (SY-24: never "keep the corner on screen"), damaged is a helper to download again.
  for (const platform of ['darwin', 'win32']) {
    const u = s('unsupported', 'capture', platform);
    assert.deepEqual([u.headline, u.action, u.ok], ['NeverQuestAlone can’t read this screen.', 'no_screen_reading', false], platform);
    assert.equal(u.detail, 'Turn off screen reading to play without it: your messages then wait for a /reload.', 'no screen reading in setup’s words');
  }
  assert.deepEqual([s('damaged').detail, s('damaged').action], [`Download ${APP} again.`, 'download']);
  for (const none of [s('ok', 'reload'), s('off', 'reload')]) {
    assert.equal(none.mode, 'none');
    assert.equal(none.detail, 'Nothing is drawn, so your messages wait for a reload, and replies still come in.');
    assert.equal(none.command, '/nqa stream on');
  }
  for (const k of ['ok', 'no_permission', 'window_not_found', 'capture_unsupported', 'helper_missing']) {
    const v = s(k);
    assert.doesNotMatch(`${v.headline} ${v.detail ?? ''}`, /capture|strip|signal|pixel|provider|bridge/i, k);
    assert.ok(!v.detail || /\.$/.test(v.detail), `${k}: a whole sentence`);
  }
  // The tray asks only while WoW runs.
  const failing = { capture: { state: 'window_not_found', mode: 'capture' } };
  assert.equal(statusView(st({ state: 'ready' }, {}, { ...failing, wow: { running: true } })).needsPlayer, true);
  assert.equal(statusView(st({ state: 'ready' }, {}, { ...failing, wow: { running: false } })).needsPlayer, false);
});

// The screen card's states (display DR-06's bridge half, SY-27): the watchdog's published keys and the
// app's own. One headline and at most one next step each; a minimized WoW and "watching" are no alarm.
test('screen reading (DR-06): no_signal\'s one action is Restart screen reading, its words the corner on Windows and the button on a Mac; blocked names what to close; watching and a minimized WoW are said without an alarm', () => {
  const s = (state, platform = 'darwin') => screenView({ state, mode: 'capture' }, { platform });
  assert.deepEqual(s('no_signal', 'win32'), { state: 'no_signal', mode: 'screen', ok: false, headline: 'NeverQuestAlone can’t see the game.', detail: 'Keep the top of WoW’s window on screen.', action: 'restart_capture' });
  assert.deepEqual(s('no_signal', 'darwin'), { state: 'no_signal', mode: 'screen', ok: false, headline: 'NeverQuestAlone can’t see the game.', detail: 'Click Restart screen reading.', action: 'restart_capture' });
  assert.deepEqual([s('blocked').detail, s('blocked').action, s('blocked').ok], ['Close what blocks screen reading.', undefined, false]);
  assert.deepEqual(s('watching'), { state: 'watching', mode: 'screen', ok: true, headline: 'Screen reading is on.' });
  const min = s('window_minimized', 'win32');
  assert.deepEqual([min.headline, min.ok, min.action], ['WoW is minimized.', true, undefined]);
  // The tray: a minimized WoW, watching or waiting ask nothing while WoW runs; a published problem does.
  const tray = state => statusView(st({ state: 'ready' }, {}, { capture: { state, mode: 'capture' }, wow: { running: true } }), { platform: 'win32' }).needsPlayer;
  for (const k of ['window_minimized', 'watching', 'waiting', 'ok']) assert.equal(tray(k), false, k);
  for (const k of ['no_signal', 'blocked', 'no_permission', 'damaged', 'unsupported']) assert.equal(tray(k), true, k);
  // Every state the app can be in: one headline, at most one action, whole sentences, and the words
  // screen reading uses (never capture, strip, signal or pixel).
  const states = ['ok', 'off', 'no_permission', 'no_signal', 'blocked', 'damaged', 'unsupported', 'waiting', 'watching', 'window_minimized'];
  for (const platform of ['darwin', 'win32']) {
    for (const k of states) {
      const v = s(k, platform);
      assert.equal(typeof v.headline, 'string', k);
      assert.ok(!v.action || typeof v.action === 'string', k);
      assert.ok(!v.detail || /\.$/.test(v.detail), `${k}: a whole sentence`);
      assert.doesNotMatch(`${v.headline} ${v.detail ?? ''}`, /capture|strip|signal|pixel|provider|bridge/i, k);
    }
  }
});

// Chats that can't be saved (code health BR-11): the core's status().store.writeError, which app-api passes on.
test('chats that can’t be saved (code health BR-11): a write the disk refused is a card of its own, disk full or not, in a card’s few words; the tray asks; nothing while every write goes', () => {
  const we = (diskFull, code = diskFull ? 'ENOSPC' : 'EACCES') => ({ file: 'records.json', code, at: 1, diskFull });
  assert.equal(savingLines(null), null);
  assert.equal(savingLines(undefined), null);
  assert.deepEqual(savingLines(we(true)), { diskFull: true, headline: 'Your disk is full, so chats aren’t saved.', detail: `Free up space, and ${APP} saves them.` });
  assert.deepEqual(savingLines(we(false)), { diskFull: false, headline: `${APP} can’t save your chats.`, detail: 'Restart your computer if it keeps happening.' });
  assert.deepEqual(savingLines({ code: 'ENOSPC' }), savingLines(we(false)), 'the store says which is a full disk (diskFull), never the window');
  const v = statusView(st({ state: 'ready' }, {}, { store: { writeError: we(true) } }));
  assert.deepEqual(v.saving, savingLines(we(true)));
  assert.equal(v.needsPlayer, true, 'only the player can make room: the tray asks');
  assert.deepEqual([v.key, v.words], ['ready', 'Ready'], 'never a state of its own: NeverQuestAlone still answers');
  for (const s of [st({ state: 'ready' }), st({ state: 'ready' }, {}, { store: { writeError: null } })]) {
    assert.deepEqual([statusView(s).saving, statusView(s).needsPlayer], [null, false]);
  }
  // A card's budget (a headline and one line of 8 words at most, as renderer/strings.js homeCard's are linted),
  // whole sentences with curly apostrophes, and the player's words: no plumbing.
  for (const w of Object.values(SAVE_WORDS)) {
    for (const line of [w.headline, w.detail]) {
      assert.ok(line.split(/\s+/).length <= 8, `${line}: 8 words at most`);
      assert.match(line, /^[A-Z][^']*\.$/, `${line}: a whole sentence`);
      assert.doesNotMatch(line, /provider|capture|strip|signal|pixel|bridge|store|write|file|record|outbox|ENOSPC|error/i, line);
    }
  }
});

// The limit held because today's spend couldn't be read (code health BR-09: rt cap, reason load_error).
test('a limit held because today’s spend couldn’t be read (code health BR-09): the tray’s word says so, never “reached”; a limit reached is still said as before', () => {
  const held = statusView(st({ state: 'cap', reason: 'load_error' }, { usage: { held: 'load_error', needs: 'cap' } }));
  assert.deepEqual([held.key, held.words, held.tone, held.needsPlayer], ['cap', 'Today’s spend unknown', 'bad', true]);
  assert.equal(SPEND_UNKNOWN_WORDS, 'Today’s spend unknown', 'a status: a short phrase, no period (STYLE §3)');
  assert.equal(statusView(st({ state: 'cap', reason: 'cap_spend' })).words, STATE_WORDS.cap);
  assert.equal(statusView(st({ state: 'cap' })).words, 'Daily spend limit reached');
});

test('statusView: the slowed line is a compact "12 s"; unknown is "Starting"', () => {
  assert.equal(statusView(st({ state: 'slowed', retryIn: 12.4 })).words, 'Slowed down · retrying in 12\u00a0s', 'a non-breaking space before the unit (UX-W37)');
  assert.equal(statusView(null).words, 'Starting');
  assert.equal(statusView(st({ state: 'something_new' })).words, 'Working');
});
