// The app's own addon updates itself (2026-10-05): which folder, when, and only once a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addonToUpdate } from '../../app/desktop/src/addon-autoupdate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const R = path.join(HERE, '..', '..');

test('addonToUpdate: an older copy in the consented folder (or one installed before consent was kept) updates once a session; never a current one, never another folder', () => {
  const tried = new Set();
  const older = { state: 'older', path: '/wow/_classic_beta_' };
  assert.equal(addonToUpdate(older, { path: '/wow/_classic_beta_', at: 1 }, tried), '/wow/_classic_beta_');
  assert.equal(addonToUpdate(older, null, tried), '/wow/_classic_beta_', 'an install from before the consent was kept');
  assert.equal(addonToUpdate(older, { path: '/other', at: 1 }, tried), null, 'consent for another folder');
  for (const state of ['current', 'found', 'running', 'armed', 'installing', 'failed', 'eperm']) assert.equal(addonToUpdate({ state, path: '/wow/x' }, null, tried), null, state);
  assert.equal(addonToUpdate(null, null, tried), null);
  tried.add('/wow/_classic_beta_');
  assert.equal(addonToUpdate(older, null, tried), null, 'once a session: a failure stays on its row');
});

test('main arms the update from each status push, never in the self-test or screenshots, and the bridge calls a copy older only by version', () => {
  const main = fs.readFileSync(path.join(R, 'app', 'desktop', 'main.mjs'), 'utf8');
  assert.match(main, /const upd = HEADLESS \? null : addonToUpdate\(s\?\.setup\?\.addon, appState\?\.get\(\)\.addonConsent, addonTried\);/);
  assert.match(main, /api\.armInstall\(\{ flavorDir: upd \}\)/);
  const appApi = fs.readFileSync(path.join(R, 'bridge', 'byok', 'app-api.mjs'), 'utf8');
  assert.match(appApi, /for \(let i = 0; i < 3; i\+\+\) if \(a\[i\] !== b\[i\]\) return a\[i\] < b\[i\];/, 'older, never just different');
  assert.doesNotMatch(appApi, /return !!have && !!ship && have !== ship;/);
});
