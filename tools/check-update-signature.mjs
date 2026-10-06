#!/usr/bin/env node
// The players' own check, run on a signed Windows build's installer (code health AP-07; TH18,
// SY-13). Before an installed app runs an update it downloaded, it checks the installer with
// app/desktop/updater.mjs's strictSignatureVerifier against the publisherName its app-update.yml
// pins: Get-AuthenticodeSignature must say Valid, for that very file, signed by that publisher
// (every attribute of a full DN, else the CN). tools/check-signatures.ps1 proves every file is
// Valid and release.yml that app-update.yml pins a name; this runs the players' check itself, on
// this build's installer against this build's own pin, so a certificate whose subject no longer
// matches the pin fails the release instead of stranding every install on the version before it.
//
//   node tools/check-update-signature.mjs <dist>
//     dist: electron-builder's output, holding one NeverQuestAlone-Setup-<version>.exe and
//     win-unpacked/resources/app-update.yml. Windows only (it runs Windows PowerShell).
//   exit 0 the players' check accepts the installer · 1 it refuses it, or nothing is pinned
//   · 2 usage, a missing file, or not Windows
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strictSignatureVerifier } from '../app/desktop/updater.mjs';

// One YAML scalar as electron-builder's js-yaml dump writes it: plain, 'single' ('' for a quote)
// or "double" (JSON's escapes).
function scalar(raw) {
  const s = raw.trim();
  if (s.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(s)) throw new Error('an unclosed quoted publisherName');
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { throw new Error('a double-quoted publisherName JSON can\'t read'); }
  }
  return s.replace(/\s+#.*$/, '');
}

/**
 * app-update.yml's publisherName as electron-updater reads it: the list electron-builder writes
 * ("publisherName:" then "  - <name>" lines), or one name on the key's line. [] when it pins none.
 */
export function publisherNames(text) {
  const lines = String(text).split(/\r?\n/);
  const at = lines.findIndex(l => /^publisherName:/.test(l));
  if (at < 0) return [];
  const inline = lines[at].slice('publisherName:'.length).trim();
  if (inline) {
    if (inline.startsWith('[')) throw new Error('a flow-style publisherName list, which electron-builder never writes');
    return [scalar(inline)].filter(Boolean);
  }
  const names = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^(\s*)- (.*)$/.exec(l);
    if (!m) break;
    names.push(scalar(m[2]));
  }
  return names.filter(Boolean);
}

export async function run(argv, {
  stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`),
  platform = process.platform, verifier = strictSignatureVerifier,
} = {}) {
  if (argv.length !== 1 || argv[0].startsWith('--')) { stderr('usage: node tools/check-update-signature.mjs <dist>'); return 2; }
  if (platform !== 'win32') { stderr('check-update-signature: Windows only: the players\' check runs Windows PowerShell\'s Get-AuthenticodeSignature'); return 2; }
  const dist = argv[0];
  let installers;
  try { installers = fs.readdirSync(dist).filter(f => /^NeverQuestAlone-Setup-.+\.exe$/i.test(f)); } catch (e) { stderr(`check-update-signature: can't read ${dist}: ${e.code || e.message}`); return 2; }
  if (installers.length !== 1) { stderr(`check-update-signature: want one NeverQuestAlone-Setup-<version>.exe in ${dist}, found ${installers.length}${installers.length ? ` (${installers.join(', ')})` : ''}`); return 2; }
  const installer = path.resolve(dist, installers[0]);
  const feed = path.join(dist, 'win-unpacked', 'resources', 'app-update.yml');
  let names;
  try { names = publisherNames(fs.readFileSync(feed, 'utf8')); } catch (e) { stderr(`check-update-signature: ${e.code === 'ENOENT' ? `no app-update.yml at ${path.relative(dist, feed)}` : `app-update.yml: ${e.message}`}`); return 2; }
  if (!names.length) {
    stdout(`::error::check-update-signature: app-update.yml pins no publisherName: the players' apps would only be told about this update, never install it`);
    return 1;
  }
  // The verifier the app sets as NsisUpdater's verifyUpdateCodeSignature (updater.mjs startUpdater):
  // null to install, else the reason it refuses.
  const logs = [];
  const reason = await verifier({ log: l => logs.push(l) })(names, installer);
  for (const l of logs) stdout(l);
  if (reason !== null) {
    stdout(`::error::check-update-signature: ${installers[0]}: the players' apps would refuse this update: ${reason}`);
    return 1;
  }
  stdout(`check-update-signature: ${installers[0]}: the players' check accepts it (signed and Valid, by the publisher app-update.yml pins; ${names.length} name${names.length === 1 ? '' : 's'} pinned)`);
  return 0;
}

// Run as a command (not imported): the same file whatever case Windows gives its drive letter.
const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) run(process.argv.slice(2)).then(code => { process.exitCode = code; });
