// The bridge's own modules, for the shell's one copy of each thing the bridge already has (systems
// plan SY-13, SY-14, SY-15: one redactor, one status vocabulary, one list of AIs). The bridge ships
// inside the app at <app>/bridge (electron-builder.yml `files`), and sits at the repo's root in a
// development run; a packaged app looks only inside its asar, as api-loader's bridgeRoots does, so
// OnlyLoadAppFromAsar and the asar's integrity check cover what the shell imports from here too.
//
//   BRIDGE_ROOT                   the folder holding bridge/ (null: this build has no bridge)
//   importBridge('bridge/…')      import one of its modules (throws when there's no bridge)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN_ASAR = /\.asar(?:[\\/]|$)/.test(APP_DIR);
const MARK = path.join('bridge', 'byok', 'security', 'redact.mjs');

export const BRIDGE_ROOT = [APP_DIR, ...(IN_ASAR ? [] : [path.resolve(APP_DIR, '..', '..')])]
  .find(root => fs.existsSync(path.join(root, MARK))) ?? null;

export function importBridge(rel) {
  if (!BRIDGE_ROOT) throw new Error('this build of NeverQuestAlone is missing its bridge');
  const file = path.resolve(BRIDGE_ROOT, ...String(rel).split('/'));
  const inside = path.relative(BRIDGE_ROOT, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('refused bridge code from outside the app');
  return import(pathToFileURL(file).href);
}
