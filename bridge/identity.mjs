// The identity of the app a build is (open-shell PRD lane 2a): what makes it one app and not another
// app built from the same shell. It's one file, plugins/<plugin>/identity.json, of the plugin the
// package.json at the root names ("plugin"). The root is this folder's parent: the repo in a
// checkout, app.asar in a packaged app, where the build writes the plugin's name into the app's
// package.json and packs its identity.json (app/desktop/scripts/plugin-config.mjs). Read once, here,
// and checked: nothing at run time decides it, neither the environment nor a file outside the app.
// The app's own modules take this one (app/desktop/src/identity.mjs imports it).
//
//   appId                the bundle id (macOS), and the app user model id and Run value (Windows)
//   productName          the app's name: its window and installer, and its data and logs folders on
//                        macOS and Windows (Electron names them after it)
//   name                 the package name: the Linux data folders, and the update cache
//                        (<name>-updater, as electron-builder names it)
//   keychainService      the key store's service: on Windows and Linux, where the OS store isn't per
//                        app, all that keeps two apps' keys apart
//   captureHelper        {bundleId, app}: the screen-reading helper's, or null for an app without one
//   nsisGuid             the Windows installer's id (an install is found by it)
//   releases             {owner, repo}: the GitHub releases updates come from, or null (no updates)
//   copyright            the app's copyright line
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RDNS = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9 ._-]{0,62}[A-Za-z0-9])?$/; // a file name on every OS
const str = re => v => typeof v === 'string' && re.test(v);
const orNull = ok => v => v === null || ok(v);
const shape = fields => v => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).sort().join() === Object.keys(fields).sort().join() && Object.entries(fields).every(([k, ok]) => ok(v[k]));

/** A plugin's id: its folder under plugins/. */
export const PLUGIN_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** Each field's check. */
export const FIELDS = Object.freeze({
  appId: str(RDNS),
  productName: str(NAME),
  name: str(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  keychainService: str(NAME),
  captureHelper: orNull(shape({ bundleId: str(RDNS), app: str(NAME) })),
  nsisGuid: str(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
  releases: orNull(shape({ owner: str(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/), repo: str(/^[A-Za-z0-9._-]{1,100}$/) })),
  copyright: str(/^[^\x00-\x1f\x7f]{1,200}$/),
});

/** What's wrong with an identity, one line a field ([] when nothing is). */
export function identityProblems(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['not an object'];
  return [
    ...Object.keys(v).filter(k => !Object.hasOwn(FIELDS, k)).map(k => `${k}: not an identity field`),
    ...Object.keys(FIELDS).filter(k => !FIELDS[k](v[k])).map(k => `${k}: ${Object.hasOwn(v, k) ? 'not valid' : 'missing'}`),
  ];
}

const deepFreeze = (v) => {
  if (v && typeof v === 'object') { for (const x of Object.values(v)) deepFreeze(x); Object.freeze(v); }
  return v;
};

/** The plugin root's package.json names, and its identity, checked and frozen: {plugin, identity}. */
export function readIdentity(root) {
  const json = (...f) => JSON.parse(fs.readFileSync(path.join(root, ...f), 'utf8'));
  const { plugin } = json('package.json');
  if (typeof plugin !== 'string' || !PLUGIN_ID.test(plugin)) throw new Error(`${path.join(root, 'package.json')}: "plugin" names no plugin folder`);
  const identity = json('plugins', plugin, 'identity.json');
  const problems = identityProblems(identity);
  if (problems.length) throw new Error(`plugins/${plugin}/identity.json: ${problems.join('; ')}`);
  return { plugin, identity: deepFreeze(identity) };
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const { plugin: PLUGIN, identity: IDENTITY } = readIdentity(ROOT);
