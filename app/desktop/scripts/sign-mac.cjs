// electron-builder's macOS sign hook (mac.sign in electron-builder.yml; security review SR-06).
//
// electron-builder signs all the code nested in the app with one set of entitlements
// (mac.entitlementsInherit: allow-jit, which Electron's own helpers need for V8), and 26.16.1 has no
// option for one nested app. The capture helper (NeverQuestAlone Capture.app in Resources, the Swift
// program that reads the strip) runs no JIT, so it gets no entitlements: the hardened runtime alone.
// So electron-builder.yml's mac.signIgnore leaves the helper out of electron-builder's own signing,
// and this hook, which electron-builder calls in its place with the same options, signs the helper
// first: the same identity and keychain, the hardened runtime, a secure timestamp, and no
// --entitlements at all. Then it runs electron-builder's own signing (@electron/osx-sign, with its
// retries) over the rest of the app, whose signature seals the signed helper in; electron-builder
// notarizes after. tools/check-release.mjs (release.yml's Release gate) fails a build whose helper has
// any entitlement, or whose app has any but build/entitlements.mac.plist's.
//
// A build with no signing identity never calls it (electron-builder signs nothing, and the helper
// keeps build-app.sh's ad hoc signature, also with no entitlements).
'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
// macOS paths, as electron-builder hands them over (and as signIgnore matches them), on any host.
const path = require('node:path').posix;

/** The capture helper in an app's Resources (scripts/fuses.cjs CAPTURE_HELPERS; a test checks they agree). */
const HELPER_APP = 'NeverQuestAlone Capture.app';
const HELPER_EXE = path.join('Contents', 'MacOS', 'NQACapture');

const helperPath = app => path.join(app, 'Contents', 'Resources', HELPER_APP);

/** codesign's arguments for the helper: the app's identity and keychain, the hardened runtime, a secure timestamp, no entitlements. */
function helperSignArgs(opts, helper) {
  if (!opts?.identity) throw new Error('no signing identity for the capture helper');
  return ['--sign', opts.identity, '--force', '--timestamp', '--options', 'runtime', ...(opts.keychain ? ['--keychain', opts.keychain] : []), helper];
}

// The error names the step and codesign's own words, never the command line (it holds the identity).
const codesign = args => new Promise((resolve, reject) => {
  execFile('codesign', args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => (err ? reject(new Error(`codesign ${args[0]} failed on the capture helper: ${String(stderr ?? '').trim() || `exit ${err.code}`}`)) : resolve(stdout)));
});
// electron-builder's own signing, as it runs it with no hook (lazy: the tests run without electron-builder).
const builderSign = opts => require('app-builder-lib/out/codeSign/macCodeSign').sign(opts);

/** The hook's work: the helper with no entitlements, then everything else as electron-builder signs it. */
async function signWith(opts, { run = codesign, signRest = builderSign, exists = fs.existsSync, log = s => console.log(s) } = {}) {
  const helper = helperPath(opts.app);
  if (!exists(path.join(helper, HELPER_EXE))) throw new Error(`the capture helper is missing: ${helper} (bridge/capture/mac/build-app.sh builds it)`);
  if (typeof opts.ignore !== 'function' || !opts.ignore(helper) || !opts.ignore(path.join(helper, HELPER_EXE))) {
    throw new Error("electron-builder.yml's mac.signIgnore must leave the capture helper to scripts/sign-mac.cjs, or electron-builder signs it again with the app's allow-jit (SR-06)");
  }
  log(`  • NeverQuestAlone signing: ${HELPER_APP} with no entitlements (the hardened runtime only; SR-06)`);
  await run(helperSignArgs(opts, helper));
  await run(['--verify', '--strict', helper]);
  await signRest(opts);
}

/** electron-builder calls this with osx-sign's options (opts.app, identity, keychain, ignore, optionsForFile) and its packager. */
async function sign(opts) {
  return signWith(opts);
}

module.exports = sign;
module.exports.sign = sign;
module.exports.signWith = signWith;
module.exports.helperSignArgs = helperSignArgs;
module.exports.helperPath = helperPath;
module.exports.HELPER_APP = HELPER_APP;
