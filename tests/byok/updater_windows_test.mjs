// The Windows installer check (app/desktop/updater.mjs strictSignatureVerifier) against a real
// Windows PowerShell (systems critic SY-21). Its unit tests (app_updater_test.mjs) hand it made-up
// answers; this runs it on real files. npm test runs it on the Windows runner; test.yml's
// windows-smoke runs it again after packaging, with the installer that run signed with its
// throwaway certificate and the publisher app-update.yml pins (NQA_SIGNED_FILE,
// NQA_SIGNED_PUBLISHER). Everywhere else every test skips.
//
//   - a Valid signed file, copied into a folder named "Jürgen 测试" (a player's profile folder with
//     non-ASCII characters in it), is accepted for its publisher, and refused for another: the
//     answer comes back in UTF-8 and names that very file;
//   - the same with PowerShell 7's PSModulePath in the environment (the app started from a
//     PowerShell 7 prompt): still accepted;
//   - the unsigned capture helper (CI's release build of it) is refused.
//
// NQA_REQUIRE_UPDATER=1 fails (not skips) when there's no signed file to check or no
// PowerShell 7; NQA_REQUIRE_HELPER=1 fails when there's no helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { strictSignatureVerifier, windowsPowerShell, powerShellEnv, POWERSHELL_PREAMBLE } from '../../app/desktop/updater.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WIN = process.platform === 'win32';
const REQUIRE = process.env.NQA_REQUIRE_UPDATER === '1';
const HELPER = path.join(REPO, 'bridge', 'capture', 'windows', 'build', 'nqa-capture.exe');
const PWSH = WIN ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe') : null;
const JURGEN = 'Jürgen 测试';
// A long-form folder under the profile (where electron-updater's own cache is), never %TEMP%, which
// can be an 8.3 short name (C:\Users\RUNNER~1\...).
const ROOT = WIN ? fs.mkdtempSync(path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'bones-ci-updater-')) : null;
test.after(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

/** Get-AuthenticodeSignature's status, signer and kind for a file, or null (asked the fixed way). */
function signatureOf(file) {
  const literal = file.replace(/'/g, "''");
  const r = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command',
    `${POWERSHELL_PREAMBLE}$s = Get-AuthenticodeSignature -LiteralPath '${literal}'; [pscustomobject]@{ Status = [string]$s.Status; Subject = $s.SignerCertificate.Subject; Kind = [string]$s.SignatureType } | ConvertTo-Json -Compress`],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: powerShellEnv() });
  if (r.status !== 0) return null;
  try { return JSON.parse(String(r.stdout).replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * Signed files to check: the one the workflow names (its pinned publisher), then the first Valid
 * one of PowerShell 7, the system's d3dcompiler_47.dll and this Node, pinned by their full subject.
 */
function signedFiles() {
  if (!WIN) return [];
  const out = [];
  const given = process.env.NQA_SIGNED_FILE ? path.resolve(process.env.NQA_SIGNED_FILE) : null;
  if (given) {
    const sig = signatureOf(given);
    out.push({ file: given, publisher: process.env.NQA_SIGNED_PUBLISHER || sig?.Subject, sig, given: true });
  }
  for (const file of [PWSH, path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'd3dcompiler_47.dll'), process.execPath]) {
    if (!fs.existsSync(file)) continue;
    const sig = signatureOf(file);
    if (sig?.Status === 'Valid' && sig.Subject) { out.push({ file, publisher: sig.Subject, sig }); break; }
  }
  return out;
}
const SIGNED = signedFiles();
const noSigned = !WIN ? 'Windows only (Get-AuthenticodeSignature)' : (SIGNED.length || REQUIRE) ? false : 'no Valid signed file on this machine to check';

/** A copy of file in <ROOT>\<n>\Jürgen 测试\, as a player's profile would hold a downloaded installer. */
function inJurgen(file, n) {
  const dir = path.join(ROOT, String(n), JURGEN);
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, path.basename(file));
  fs.copyFileSync(file, to);
  return to;
}

/** What electron-updater's bare command (no UTF-8, the inherited environment) answers for file: a diagnostic. */
function oldWay(file) {
  return new Promise((resolve) => {
    const command = `Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}' | ConvertTo-Json -Compress -Depth 3`;
    execFile(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', command], { windowsHide: true, timeout: 60_000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return resolve(`didn't run (${err.code ?? 'error'})`);
      let data = null;
      try { data = JSON.parse(stdout); } catch { return resolve(`unreadable${String(stderr).trim() ? ', with stderr' : ''}`); }
      resolve(data?.Path === file ? 'named this file' : `named another path (${JSON.stringify(String(data?.Path ?? '').slice(-40))})`);
    });
  });
}

test('a Valid signed file in a folder named "Jürgen 测试" is accepted for its publisher and refused for another', { skip: noSigned }, async (t) => {
  assert.ok(SIGNED.length > 0, 'a signed file to check');
  for (const [i, s] of SIGNED.entries()) {
    assert.equal(s.sig?.Status, 'Valid', `${s.file}: ${JSON.stringify(s.sig)}`);
    t.diagnostic(`${path.basename(s.file)}: ${s.sig.Kind} signature by ${parseSubjectCn(s.sig.Subject)}; pinned ${JSON.stringify(s.publisher)}`);
    const copy = inJurgen(s.file, i);
    const logs = [];
    const verify = strictSignatureVerifier({ log: l => logs.push(l) });
    assert.equal(await verify([s.publisher], copy), null, `${copy}: ${logs.join(' | ')}`);
    assert.match(await verify(['CN=Someone Else, O=Someone Else'], copy), /signed by another publisher/);
    t.diagnostic(`electron-updater's bare command on the same copy: ${await oldWay(copy)}`);
  }
  if (process.env.NQA_SIGNED_FILE) assert.ok(SIGNED.some(s => s.given), 'the workflow\'s signed file was checked');
});

test('with PowerShell 7\'s PSModulePath in the environment, a Valid signed file is still accepted', { skip: noSigned || ((!PWSH || !fs.existsSync(PWSH)) && !REQUIRE ? 'no PowerShell 7 here' : false) }, async (t) => {
  const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write($env:PSModulePath)'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const ps7 = r.stdout.trim();
  assert.match(ps7, /PowerShell[\\/]7/i, `PowerShell 7's module path: ${ps7}`);
  const s = SIGNED[0];
  const copy = inJurgen(s.file, 'ps7');
  const logs = [];
  const verify = strictSignatureVerifier({ env: { ...process.env, PSModulePath: ps7 }, log: l => logs.push(l) });
  assert.equal(await verify([s.publisher], copy), null, logs.join(' | '));
  // The same query with PowerShell 7's path left in place, for the log: what the fix is for.
  const bare = spawnSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command',
    `${POWERSHELL_PREAMBLE}(Get-AuthenticodeSignature -LiteralPath '${copy.replace(/'/g, "''")}').Status`],
  { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, PSModulePath: ps7 } });
  t.diagnostic(`with PowerShell 7's PSModulePath inherited: exit ${bare.status}, ${String(bare.stdout).trim() || '(no answer)'}${String(bare.stderr).trim() ? `; stderr: ${String(bare.stderr).trim().split(/\r?\n/)[0].slice(0, 160)}` : ''}`);
});

test('the unsigned capture helper is refused (NotSigned)', { skip: !WIN ? 'Windows only (Get-AuthenticodeSignature)' : (fs.existsSync(HELPER) || process.env.NQA_REQUIRE_HELPER === '1') ? false : `no helper at ${HELPER} (bridge/capture/windows/build.sh)` }, async () => {
  const copy = inJurgen(HELPER, 'helper');
  const pinned = SIGNED[0]?.publisher ?? 'CN=NeverQuestAlone CI, O=NeverQuestAlone contributors';
  const logs = [];
  const verdict = await strictSignatureVerifier({ log: l => logs.push(l) })([pinned], copy);
  assert.match(verdict ?? '', /couldn't verify the installer: status 2/, 'SignatureStatus.NotSigned');
  assert.ok(logs.some(l => /refused the installer's signature \(status 2\)/.test(l)), logs.join(' | '));
});

function parseSubjectCn(subject) {
  return (/(?:^|,\s*)CN=("(?:[^"]|"")*"|[^,]*)/.exec(String(subject ?? '')) || [])[1] ?? String(subject);
}
