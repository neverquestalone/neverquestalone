// electron-builder's config for the plugin the app is built with (open-shell PRD lane 2a), which
// electron-builder.yml extends, so every build, however it's started (scripts/dist.mjs, release.yml's
// Mac job, npm run pack), takes its names from the plugin's identity.json (bridge/identity.mjs reads
// and checks it): the app id, product name, copyright, installer id, update feed and capture helper.
// It packs that file and names the plugin in the app's package.json, where src/identity.mjs reads
// them, and refuses a signed build under names that aren't the app's own (signedRefusal).
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, IDENTITY, ROOT } from '../../../bridge/identity.mjs';

const reEscape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What electron-builder.yml takes from a plugin's identity. */
export function pluginConfig(plugin = PLUGIN, identity = IDENTITY) {
  const helper = identity.captureHelper && `${identity.captureHelper.app}.app`;
  return {
    appId: identity.appId,
    productName: identity.productName,
    copyright: identity.copyright,
    // The app's package.json: its name and product name (Electron names its folders after them), and
    // its plugin, whose identity.json goes in beside the bridge.
    extraMetadata: { name: identity.name, productName: identity.productName, plugin },
    files: [{ from: `../../plugins/${plugin}`, to: `plugins/${plugin}`, filter: ['identity.json'] }],
    nsis: { guid: identity.nsisGuid },
    // The capture helper bridge/capture/mac/build-app.sh --public makes, in Resources beside app.asar,
    // signed by scripts/sign-mac.cjs alone (signIgnore leaves it, and everything in it, to the hook: SR-06).
    ...(helper ? { mac: { extraResources: [{ from: `../../bridge/capture/mac/build-public/${helper}`, to: helper }], signIgnore: [`/Contents/Resources/${reEscape(helper)}(/|$)`] } } : {}),
    // Updates from the identity's releases: public, releases only, never a token. None, no feed.
    publish: identity.releases ? [{ provider: 'github', owner: identity.releases.owner, repo: identity.releases.repo, private: false, releaseType: 'release' }] : null,
  };
}

/**
 * NeverQuestAlone's own names, a two-entry list: a signed build under either is NeverQuestAlone's or
 * none. Another app signed under its app id replaces its installs, and under its key store service reads
 * its players' saved keys on Windows and Linux (the OS store isn't per app there). Keyed on the product
 * name, not on a plugin's folder name (which a fork may keep): a fork renames, as it must, and one that
 * keeps either of these is refused, whatever its plugins are called and whether or not this repo's
 * plugins are beside it.
 */
export const RESERVED = Object.freeze([['appId', 'com.neverquestalone.app'], ['keychainService', 'NeverQuestAlone']]);
const RESERVED_FOR = 'NeverQuestAlone';

/** Whether this environment names a signing identity: a Mac one, a Windows certificate, or Azure Artifact Signing (scripts/dist.mjs). */
const namesSigning = env => ['CSC_LINK', 'CSC_NAME', 'WIN_CSC_LINK', 'NQA_AZURE_ENDPOINT'].some(n => typeof env[n] === 'string' && env[n] !== '');

/**
 * Whether a build with this environment is signed: an identity it names, or on a Mac whatever Developer
 * ID the login keychain holds, which electron-builder signs with unless CSC_IDENTITY_AUTO_DISCOVERY is
 * "false" (scripts/dist.mjs sets it for a build that names none; npm run pack and electron-builder run by
 * hand don't: critic round 2, 2A-13).
 */
export const signs = (env, platform = process.platform) => namesSigning(env) || (platform === 'darwin' && env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false');

/**
 * Why a signed build can't go out under this identity, or null (an unsigned build always can): its app
 * id or key store service is NeverQuestAlone's (RESERVED) in an app with another name, another plugin's
 * beside it, or the example plugin's, which every app made from the shell starts with. Two apps with one
 * app id replace each other's installs, and with one service they read each other's keys on Windows and
 * Linux.
 */
export function signedRefusal({ plugin = PLUGIN, identity = IDENTITY, env = process.env, root = ROOT, platform = process.platform } = {}) {
  if (!signs(env, platform)) return null;
  for (const [field, value] of RESERVED) {
    if (identity[field] === value && identity.productName !== RESERVED_FOR) return `the ${field === 'appId' ? 'app id' : 'key store service'} "${value}" is ${RESERVED_FOR}'s`;
  }
  const dir = path.join(root, 'plugins');
  for (const other of fs.readdirSync(dir).filter(p => p !== plugin || p === 'example').sort()) {
    let theirs;
    try { theirs = JSON.parse(fs.readFileSync(path.join(dir, other, 'identity.json'), 'utf8')); } catch { continue; }
    if (theirs.appId === identity.appId) return `the app id ${identity.appId} is plugins/${other}'s`;
    if (theirs.keychainService === identity.keychainService) return `the key store service "${identity.keychainService}" is plugins/${other}'s`;
  }
  return null;
}

/** electron-builder.yml's extends: the identity's config, once the signing check passes. */
export default function config() {
  const why = signedRefusal();
  const unsigned = namesSigning(process.env) ? '' : '; on a Mac, CSC_IDENTITY_AUTO_DISCOVERY=false builds it unsigned';
  if (why) throw new Error(`a signed build needs names of its own: ${why} (plugins/${PLUGIN}/identity.json)${unsigned}`);
  return pluginConfig();
}
