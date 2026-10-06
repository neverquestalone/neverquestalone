// electron-builder's Windows sign hook for Azure Artifact Signing (systems critic SY-31), which
// scripts/dist.mjs sets (win.signtoolOptions.sign) when the Azure variables are set. Each file is
// signed by Invoke-TrustedSigning from the module tools/stage-trusted-signing.ps1 staged, pinned and
// checked before the Azure sign-in (NQA_TRUSTED_SIGNING_MODULE, its .psd1), so electron-builder
// never runs Install-Module while the job holds the sign-in. The module is imported by its path and
// the command taken from it, never looked up on PSModulePath.
//
// The parameters are electron-builder 26.16.1's own Azure signer's (windowsSignAzureManager.js, the
// same file as 26.15.3's): a SHA-256 file digest, Microsoft's RFC 3161 timestamp with a SHA-256
// digest. The endpoint, the account and the certificate profile (NQA_AZURE_*) and the file reach
// PowerShell as environment variables, never on its command line, so nothing is quoted or re-parsed.
// PowerShell 7 (pwsh) when there is one, else Windows PowerShell, as electron-builder picks. Artifact
// Signing signs SHA-256 only: electron-builder asks this hook once per hash (sha1, then sha256), and
// the sha1 call signs nothing.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Invoke-TrustedSigning's fixed parameters, as electron-builder's Azure signer passes them. */
const PARAMS = Object.freeze({ FileDigest: 'SHA256', TimestampRfc3161: 'http://timestamp.acs.microsoft.com', TimestampDigest: 'SHA256' });

/** The PowerShell script: the staged module by its path, its Invoke-TrustedSigning, values from the environment. */
const SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '$m = Import-Module -Name $env:NQA_TRUSTED_SIGNING_MODULE -PassThru -Force',
  "$sign = $m.ExportedCommands['Invoke-TrustedSigning']",
  'if (-not $sign) { throw "$env:NQA_TRUSTED_SIGNING_MODULE has no Invoke-TrustedSigning" }',
  `& $sign -Endpoint $env:NQA_AZURE_ENDPOINT -CodeSigningAccountName $env:NQA_AZURE_ACCOUNT -CertificateProfileName $env:NQA_AZURE_PROFILE -Files $env:NQA_SIGN_FILE ${Object.entries(PARAMS).map(([k, v]) => `-${k} '${v}'`).join(' ')}`,
].join('; ');

/**
 * What to run for one file: { args, env }, or { skip } for a hash other than SHA-256. Throws when the
 * module isn't staged, a value is missing or the path can't be passed. Runs nothing.
 */
function signCommand(configuration, env = process.env, exists = fs.existsSync) {
  const hash = configuration?.hash ?? 'sha256';
  if (hash !== 'sha256') return { skip: `Artifact Signing signs SHA-256 only (this is the ${hash} call)` };
  const module = env.NQA_TRUSTED_SIGNING_MODULE;
  if (!module || !path.isAbsolute(module) || !module.endsWith('.psd1') || !exists(module)) {
    throw new Error('Azure Artifact Signing signs with the pinned TrustedSigning module: run tools/stage-trusted-signing.ps1 first (it sets NQA_TRUSTED_SIGNING_MODULE; SY-31)');
  }
  for (const name of ['NQA_AZURE_ENDPOINT', 'NQA_AZURE_ACCOUNT', 'NQA_AZURE_PROFILE']) {
    if (!env[name]) throw new Error(`Azure Artifact Signing needs ${name}`);
  }
  if (!configuration?.path) throw new Error('nothing to sign');
  const file = path.resolve(String(configuration.path));
  // Invoke-TrustedSigning's -Files is a comma-separated list.
  if (file.includes(',')) throw new Error(`can't sign ${file}: Invoke-TrustedSigning reads a comma as a second file`);
  return { args: ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], env: { ...env, NQA_SIGN_FILE: file } };
}

/** Signs one file (the work behind the hook; spawn and log injectable for the tests). */
async function signWith(configuration, { env = process.env, spawn = spawnSync, log = s => console.log(s) } = {}) {
  const c = signCommand(configuration, env);
  if (c.skip) return false;
  log(`  • NeverQuestAlone signing: ${path.basename(c.env.NQA_SIGN_FILE)} with Azure Artifact Signing (the pinned module at ${c.env.NQA_TRUSTED_SIGNING_MODULE})`);
  const opts = { env: c.env, stdio: 'inherit', windowsHide: true };
  let r = spawn('pwsh', c.args, opts);
  if (r.error?.code === 'ENOENT') r = spawn('powershell.exe', c.args, opts);
  if (r.error) throw new Error(`PowerShell didn't start (${r.error.code ?? r.error.message})`);
  if (r.status !== 0) throw new Error(`Invoke-TrustedSigning failed on ${c.env.NQA_SIGN_FILE} (exit ${r.status})`);
  return true;
}

/** The hook electron-builder calls (with its task configuration and the packager, which this ignores). */
async function sign(configuration) {
  await signWith(configuration);
}

module.exports = sign;
module.exports.sign = sign;
module.exports.signWith = signWith;
module.exports.signCommand = signCommand;
module.exports.PARAMS = PARAMS;
module.exports.SCRIPT = SCRIPT;
