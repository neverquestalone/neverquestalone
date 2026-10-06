#!/usr/bin/env node
// The addon's TOC as a player gets it, stamped into a COPY of the addon: release.yml's addon zip, and
// the CurseForge package when it lands. It is the same function the app runs when it installs the
// addon (bridge/byok/wow.mjs stampToc: the product's Title and Notes), so every copy a player can get
// has the TOC an app install has. The repo's own TOC is never stamped (each copy is, never the
// source): the tool refuses the repo's addon folder.
//
//   node tools/stamp-toc.mjs <addon folder>   (a copy of addon/NeverQuestAlone; its NeverQuestAlone.toc is rewritten)
//
// Exits 0 when the TOC is stamped (or already was), 2 on a wrong argument or the repo's own folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampToc, ADDON_NAME, ADDON_SOURCE } from '../bridge/byok/wow.mjs';

/** Stamp <dir>/NeverQuestAlone.toc in place; returns the stamped text. */
export function stampAddonCopy(dir) {
  if (typeof dir !== 'string' || !dir) throw Object.assign(new Error('no addon folder given'), { code: 'usage' });
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (real(dir) === real(ADDON_SOURCE)) throw Object.assign(new Error('that is the repo\'s own addon folder: stamp a copy'), { code: 'repo' });
  const toc = path.join(dir, `${ADDON_NAME}.toc`);
  if (!fs.lstatSync(toc, { throwIfNoEntry: false })?.isFile()) throw Object.assign(new Error(`no ${ADDON_NAME}.toc in ${dir}`), { code: 'usage' });
  const text = stampToc(fs.readFileSync(toc, 'utf8'));
  fs.writeFileSync(toc, text);
  return text;
}

// Run as a command (not imported): the same file whatever case Windows gives its drive letter.
const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) {
  try {
    const text = stampAddonCopy(process.argv[2]);
    const title = (text.match(/^## Title: (.*)$/m) || [])[1];
    console.log(`stamped ${path.join(process.argv[2], `${ADDON_NAME}.toc`)}: Title "${title}"`);
  } catch (e) {
    console.error(`stamp-toc: ${e.message}`);
    process.exit(2);
  }
}

