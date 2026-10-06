// electron-builder afterPack hook (BYOK PRD §11.2 SC-9, §11.1 signing).
//
// 1. Says plainly whether this build will be signed, from environment
//    variables only. On macOS with no CSC_LINK/CSC_NAME it also turns off
//    electron-builder's keychain auto-discovery, so a build never signs with
//    whatever identity this Mac's keychain happens to hold.
// 2. Fails the build when this OS's capture helper isn't in Resources
//    (CAPTURE_HELPERS, as src/api-loader.mjs names them): electron-builder
//    skips a missing extraResources source, and the app would ship unable to
//    hear the game (C3 review). On macOS it also fails when any Mach-O file
//    carries a debug map or a build path (tools/check-release.mjs; audit LS-06).
// 3. Drops Electron's own default_app.asar from Resources (the audit's cross-lens
//    note for the release lane, W(d)): the app loads only app.asar, and the
//    stock default app is code the build shouldn't carry. tools/check-fuses.mjs
//    fails a build that still has it.
// 4. Flips Electron's fuses before signing (once per app: a universal build's
//    x64 and arm64 halves are left alone and the merged app is flipped; see
//    universalHalf): no running as plain Node, no
//    NODE_OPTIONS, no --inspect, the app loads only from its asar and checks
//    the asar's integrity, file: pages get no extra privileges. Without these,
//    a same-user program could run the signed app as Node or attach a
//    debugger and read the Keychain item under the app's identity. All six of
//    PRD §11.2's list are in their hardened state (tools/check-fuses.mjs checks
//    a packaged app against this plan), and cookies are encrypted.
'use strict';

const path = require('node:path');

/** Fuse name (FuseV1Options) → the value this app ships with. */
const FUSE_PLAN = Object.freeze({
  RunAsNode: false,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  OnlyLoadAppFromAsar: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  // Off. The settings page is served from the app's own privileged scheme
  // (nqa://app/, src/scheme.mjs: protocol.handle over the renderer folder
  // inside app.asar), so the app never loads a file: page, and file: gets no
  // extra privileges; the webRequest guard refuses file: outright
  // (src/net-guard.mjs). The packaged --self-test checks the page loads from
  // the scheme with this fuse off.
  GrantFileProtocolExtraPrivileges: false,
  EnableCookieEncryption: true,
});

/** Each OS's capture helper in Resources (src/api-loader.mjs CAPTURE_HELPERS; a test checks they agree). */
const CAPTURE_HELPERS = Object.freeze({
  darwin: 'NeverQuestAlone Capture.app/Contents/MacOS/NQACapture',
  mas: 'NeverQuestAlone Capture.app/Contents/MacOS/NQACapture',
  win32: 'capture/nqa-capture.exe',
  linux: 'capture/capture_x11.py',
});

/** Resources inside a packed app (the folder app.asar is in). */
function resourcesDir(platform, appOutDir, productFilename) {
  return platform === 'darwin' || platform === 'mas'
    ? path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources');
}

/** The capture helper this build must carry, or an Error naming what's missing and how to build it. */
function checkCaptureHelper(platform, resources, exists = require('node:fs').existsSync) {
  const rel = CAPTURE_HELPERS[platform];
  if (!rel) return null;
  const file = path.join(resources, ...rel.split('/'));
  if (exists(file)) return null;
  const how = { darwin: 'bridge/capture/mac/build-app.sh (scripts/dist.mjs runs it)', mas: 'bridge/capture/mac/build-app.sh', win32: 'bridge/capture/windows/build.sh', linux: 'nothing: it is bridge/capture_x11.py' }[platform];
  return new Error(`the capture helper is missing from this build (${rel}): build it first with ${how}. An app without it can't hear the game.`);
}

/**
 * A Mac build's icon (electron-builder.yml mac): the asset catalog in Resources and CFBundleIconName =
 * AppIcon in Info.plist, so macOS 26+ draws the small sizes full-bleed instead of plating the .icns.
 * electron-builder skips a missing extraResources source, so a build without the catalog would pass
 * with the plated icon. Null when both are there, else an Error naming what's missing.
 */
function checkMacIcon(platform, resources, fs = require('node:fs')) {
  if (platform !== 'darwin' && platform !== 'mas') return null;
  if (!fs.existsSync(path.join(resources, 'Assets.car'))) return new Error('the icon\'s asset catalog is missing from this build (Contents/Resources/Assets.car): electron-builder.yml mac.extraResources copies it from build/Assets.car (scripts/make-icons.mjs).');
  let info = '';
  try { info = fs.readFileSync(path.join(resources, '..', 'Info.plist'), 'utf8'); } catch { /* read below */ }
  if (!/<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/.test(info)) return new Error('Info.plist has no CFBundleIconName = AppIcon (electron-builder.yml mac.extendInfo), so macOS 26+ would plate the icon.');
  return null;
}

/**
 * NeverQuestAlone's Mac capture app, where build-app.sh --public leaves it and electron-builder.yml
 * takes it from: its own bundle id and folder, never a checkout's build/ (final review L3-4).
 */
const MAC_CAPTURE_APP = path.join(__dirname, '..', '..', '..', 'bridge', 'capture', 'mac', 'build-public', 'NeverQuestAlone Capture.app');

/**
 * scripts/dist.mjs: whether this build targets macOS (--mac/-m, or no platform flag on a Mac) and the
 * capture app isn't built yet; then the command that builds it, ad hoc (the signing step re-signs it
 * with the app's Developer ID; an unsigned build's helper can't pass the capture check), else null.
 */
function macCaptureBuild(args, platform = process.platform, exists = require('node:fs').existsSync) {
  const flags = new Set(args);
  const other = ['--win', '-w', '--windows', '--linux', '-l'].some(f => flags.has(f));
  const mac = ['--mac', '-m', '-o', '--macos'].some(f => flags.has(f)) || (platform === 'darwin' && !other);
  if (!mac || exists(path.join(MAC_CAPTURE_APP, 'Contents', 'MacOS', 'NQACapture'))) return null;
  // Both architectures (SY-16): the universal DMG and the x64 update zip need an x86_64 slice.
  return { cmd: path.join(__dirname, '..', '..', '..', 'bridge', 'capture', 'mac', 'build-app.sh'), args: ['--universal', '--adhoc', '--public'] };
}

/** Electron's stock default app, which electron-builder leaves in Resources. */
const DEFAULT_APP = 'default_app.asar';

/** Remove Resources/default_app.asar if it's there; true when it was. */
function dropDefaultApp(resources, fs = require('node:fs')) {
  const file = path.join(resources, DEFAULT_APP);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

const has = (env, ...names) => names.every(n => typeof env[n] === 'string' && env[n].length > 0);

/** Which signing the environment provides. Reports names only, never values. */
function signingPlan(platform, env = process.env) {
  if (platform === 'darwin' || platform === 'mas') {
    const cert = has(env, 'CSC_LINK') || has(env, 'CSC_NAME');
    const notarize = has(env, 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER')
      || has(env, 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID')
      || has(env, 'APPLE_KEYCHAIN', 'APPLE_KEYCHAIN_PROFILE');
    return { signed: cert, notarized: cert && notarize, via: cert ? 'CSC_LINK/CSC_NAME (Developer ID)' : null };
  }
  if (platform === 'win32') {
    // The credential: the Azure sign-in (NQA_AZURE_OIDC=1, release.yml's OIDC; audit CV-08), else a secret or certificate.
    const credential = env.NQA_AZURE_OIDC === '1'
      || (has(env, 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID') && (has(env, 'AZURE_CLIENT_SECRET') || has(env, 'AZURE_CLIENT_CERTIFICATE_PATH')));
    const azure = has(env, 'NQA_AZURE_ENDPOINT', 'NQA_AZURE_ACCOUNT', 'NQA_AZURE_PROFILE', 'NQA_PUBLISHER_NAME') && credential;
    const cert = has(env, 'WIN_CSC_LINK') || has(env, 'CSC_LINK');
    return { signed: azure || cert, notarized: false, via: azure ? 'Azure Artifact Signing' : cert ? 'CSC_LINK (certificate)' : null };
  }
  return { signed: false, notarized: false, via: null };
}

function signingLine(platform, plan) {
  if (platform === 'linux') return 'Linux builds are not code-signed, and none is released: Linux runs from source (systems plan D6); a local build is for trying it.';
  if (!plan.signed) {
    return platform === 'win32'
      ? 'UNSIGNED BUILD: no Azure Artifact Signing or CSC_LINK variables are set. Fine for a local test; never ship it (SmartScreen and Smart App Control block it).'
      : 'UNSIGNED BUILD: CSC_LINK/CSC_NAME is not set, and keychain discovery is off. Fine for a local test; never ship it (Gatekeeper blocks it, and Keychain items would not be tied to a stable identity).';
  }
  return `signed with ${plan.via}${platform === 'darwin' ? (plan.notarized ? ', notarized with APPLE_* credentials' : '; NOT notarized (no APPLE_* credentials)') : ''}.`;
}

function fuseConfig(FuseV1Options, FuseVersion, platform) {
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: platform === 'darwin' || platform === 'mas' };
  const applied = {};
  const missing = [];
  for (const [name, value] of Object.entries(FUSE_PLAN)) {
    if (typeof FuseV1Options[name] !== 'number') { missing.push(name); continue; }
    config[FuseV1Options[name]] = value;
    applied[name] = value;
  }
  return { config, applied, missing };
}

/**
 * A universal build packs its x64 and arm64 halves into <out>-x64-temp and <out>-arm64-temp, merges
 * them with @electron/universal, then calls afterPack again on the merged app. The halves must keep
 * identical non-binary files for the merge, and flipping the fuses re-signs a Mac app ad hoc, which
 * writes a _CodeSignature/CodeResources that differs per architecture ("Expected all non-binary files
 * to have identical SHAs"). So the halves are left alone and the merged app gets the fuses, in both
 * of its slices, and one ad hoc signature (systems plan Batch 5: the universal DMG).
 */
function universalHalf(context) {
  return /-(?:x64|arm64)-temp$/.test(String(context?.appOutDir ?? ''));
}

async function afterPack(context) {
  const platform = context.electronPlatformName;
  const plan = signingPlan(platform);
  console.log(`  • NeverQuestAlone signing: ${signingLine(platform, plan)}`);
  if ((platform === 'darwin' || platform === 'mas') && !plan.signed) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

  const resources = resourcesDir(platform, context.appOutDir, context.packager.appInfo.productFilename);
  const noHelper = checkCaptureHelper(platform, resources);
  if (noHelper) throw noHelper;
  console.log('  • NeverQuestAlone capture helper: in Resources');
  const noIcon = checkMacIcon(platform, resources);
  if (noIcon) throw noIcon;
  if (platform === 'darwin' || platform === 'mas') console.log('  • NeverQuestAlone icon: Assets.car in Resources, CFBundleIconName AppIcon');

  // Both halves of a universal build and the merged app alike, so the halves stay identical.
  if (dropDefaultApp(resources)) console.log(`  • Electron's ${DEFAULT_APP}: removed from Resources`);

  // No Mach-O file ships a debug map or a build path (audit LS-06): an unstripped helper names the
  // build machine's home folder and checkout in every object path. Read only, so both halves of a
  // universal build and the merged app are checked alike.
  if (platform === 'darwin' || platform === 'mas') {
    const { checkMacBinaries } = await import(require('node:url').pathToFileURL(path.join(__dirname, '..', '..', '..', 'tools', 'check-release.mjs')).href);
    const problems = checkMacBinaries(path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`), { buildRoot: path.resolve(__dirname, '..', '..', '..') });
    if (problems.length) throw new Error(`debug maps or build paths in this build's Mach-O files: ${problems.join('; ')}. Rebuild the capture helper with bridge/capture/mac/build-app.sh, which strips it.`);
    console.log('  • NeverQuestAlone binaries: no debug stabs or build paths');
  }

  if (universalHalf(context)) {
    console.log('  • NeverQuestAlone fuses: not on this half of a universal build; flipped on the merged app');
    return;
  }
  const ext = { darwin: '.app', mas: '.app', win32: '.exe', linux: '' }[platform];
  const name = platform === 'linux' ? context.packager.executableName : context.packager.appInfo.productFilename;
  const target = path.join(context.appOutDir, `${name}${ext}`);
  const { flipFuses, FuseV1Options, FuseVersion } = await import('@electron/fuses');
  const { config, applied, missing } = fuseConfig(FuseV1Options, FuseVersion, platform);
  await flipFuses(target, config);
  const words = Object.entries(applied).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(', ');
  console.log(`  • NeverQuestAlone fuses: ${words}${missing.length ? ` (not in this Electron: ${missing.join(', ')})` : ''}`);
}

module.exports = afterPack;
module.exports.default = afterPack;
module.exports.FUSE_PLAN = FUSE_PLAN;
module.exports.signingPlan = signingPlan;
module.exports.signingLine = signingLine;
module.exports.checkMacIcon = checkMacIcon;
module.exports.fuseConfig = fuseConfig;
module.exports.CAPTURE_HELPERS = CAPTURE_HELPERS;
module.exports.resourcesDir = resourcesDir;
module.exports.checkCaptureHelper = checkCaptureHelper;
module.exports.macCaptureBuild = macCaptureBuild;
module.exports.MAC_CAPTURE_APP = MAC_CAPTURE_APP;
module.exports.universalHalf = universalHalf;
module.exports.dropDefaultApp = dropDefaultApp;
module.exports.DEFAULT_APP = DEFAULT_APP;
