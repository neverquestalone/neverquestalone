// Release builds (BYOK PRD §11.1 signing, §11.5 updates, DB13). Runs
// electron-builder with signing taken only from the environment:
//   macOS   CSC_LINK + CSC_KEY_PASSWORD (Developer ID); APPLE_* to notarize
//   Windows Azure Artifact Signing: NQA_AZURE_ENDPOINT, NQA_AZURE_ACCOUNT,
//           NQA_AZURE_PROFILE, NQA_PUBLISHER_NAME, with the credential
//           either this machine's Azure sign-in (NQA_AZURE_OIDC=1: release.yml
//           signs in with the job's OIDC token, so CI holds no secret; audit
//           CV-08) or AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET
//           (or AZURE_CLIENT_CERTIFICATE_PATH), and the pinned TrustedSigning
//           module tools/stage-trusted-signing.ps1 stages
//           (NQA_TRUSTED_SIGNING_MODULE): each file is signed by
//           scripts/sign-azure.cjs with that copy, never a module
//           electron-builder installs (systems critic SY-31); or an OV
//           certificate in WIN_CSC_LINK / CSC_LINK with NQA_PUBLISHER_NAME
// NQA_PUBLISHER_NAME is pinned into app-update.yml, so electron-updater
// refuses an installer from any other publisher. A signed build under names
// that aren't the app's own is refused (scripts/plugin-config.mjs
// signedRefusal). Nothing is published unless --publish is passed
// explicitly. Values are never printed, only names.
// A macOS build first builds the capture app when it isn't there
// (bridge/capture/mac/build-app.sh --universal --adhoc --public; the signing step re-signs it with
// the Developer ID), and scripts/fuses.cjs fails any build without its helper.
//   node scripts/dist.mjs --mac        node scripts/dist.mjs --win --x64
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDENTITY } from '../../../bridge/identity.mjs';
import { signedRefusal } from './plugin-config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = process.env;
const set = (...names) => names.every(n => typeof env[n] === 'string' && env[n].length > 0);
const args = process.argv.slice(2);
const extra = [];

// A build that names no Mac identity never looks in the keychain (electron-builder signs with any
// Developer ID it finds there otherwise).
const childEnv = { ...env };
if (!set('CSC_LINK') && !set('CSC_NAME')) childEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

// A signed build goes out under names of its own (plugins/<plugin>/identity.json), judged as
// electron-builder will run it.
const refused = signedRefusal({ env: childEnv });
if (refused) {
  console.error(`a signed build needs names of its own: ${refused}`);
  process.exit(1);
}

// The credential: this machine's Azure sign-in when NQA_AZURE_OIDC=1 (release.yml's azure/login with
// the job's OIDC token: no secret in CI, audit CV-08), else an app's secret or certificate.
const azureCredential = env.NQA_AZURE_OIDC === '1'
  || (set('AZURE_TENANT_ID', 'AZURE_CLIENT_ID') && (set('AZURE_CLIENT_SECRET') || set('AZURE_CLIENT_CERTIFICATE_PATH')));
const azure = set('NQA_AZURE_ENDPOINT', 'NQA_AZURE_ACCOUNT', 'NQA_AZURE_PROFILE', 'NQA_PUBLISHER_NAME') && azureCredential;
if (azure) {
  // Never win.azureSignOptions: with it, electron-builder runs Install-Module TrustedSigning (any
  // version from 0.5.0) in the job that holds the sign-in. The hook signs with the pinned copy, and
  // reads the endpoint, account and profile from NQA_AZURE_* itself (SY-31).
  if (!set('NQA_TRUSTED_SIGNING_MODULE')) {
    console.error('Azure Artifact Signing signs with the pinned TrustedSigning module: run tools/stage-trusted-signing.ps1 first (it sets NQA_TRUSTED_SIGNING_MODULE; SY-31)');
    process.exit(1);
  }
  extra.push(
    '-c.win.signtoolOptions.sign=./scripts/sign-azure.cjs',
    `-c.win.signtoolOptions.publisherName=${env.NQA_PUBLISHER_NAME}`,
  );
} else if (set('NQA_PUBLISHER_NAME') && (set('WIN_CSC_LINK') || set('CSC_LINK'))) {
  extra.push(`-c.win.signtoolOptions.publisherName=${env.NQA_PUBLISHER_NAME}`);
}

if (!args.some(a => a === '--publish' || a.startsWith('--publish=') || a === '-p')) args.push('--publish', 'never');

console.log(`${IDENTITY.productName} release build`);
console.log(`  macOS signing:   ${set('CSC_LINK') || set('CSC_NAME') ? 'CSC_LINK/CSC_NAME set' : 'none (unsigned; keychain discovery off)'}`);
console.log(`  notarization:    ${set('APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER') || set('APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID') ? 'APPLE_* set' : 'none'}`);
console.log(`  Windows signing: ${azure ? 'Azure Artifact Signing (the pinned TrustedSigning module)' : set('WIN_CSC_LINK') || set('CSC_LINK') ? 'certificate' : 'none (unsigned)'}${set('NQA_PUBLISHER_NAME') ? ', publisher pinned' : ''}`);

// The capture helper goes in Resources (electron-builder.yml); a Mac build without it is refused.
const { macCaptureBuild } = createRequire(import.meta.url)('./fuses.cjs');
const capture = macCaptureBuild(args);
if (capture) {
  console.log('  capture app:     not built yet; building it ad hoc (a Developer ID build re-signs it)');
  const b = spawnSync(capture.cmd, capture.args, { cwd: ROOT, stdio: 'inherit', env });
  if (b.status !== 0) { console.error('the capture app did not build, so neither does the app'); process.exit(b.status || 1); }
}

// electron-builder's own CLI under this Node, with no shell: spawning npx.cmd
// without shell:true throws EINVAL on Windows since the CVE-2024-27980 fix,
// and a shell would re-parse the Azure arguments.
const cli = createRequire(path.join(ROOT, 'package.json')).resolve('electron-builder/cli.js');
const r = spawnSync(process.execPath, [cli, ...args, ...extra], { cwd: ROOT, stdio: 'inherit', env: childEnv });
if (r.error) console.error(`electron-builder didn't start: ${r.error.code ?? ''} ${r.error.message}`.trim());
process.exit(r.status ?? 1);
