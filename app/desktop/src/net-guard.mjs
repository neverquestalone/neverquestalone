// The shell's network guard (BYOK PRD §11.2 "Network", KY-6, KY-7, SC-9).
//
// The bridge's own traffic goes through Node and has its own ledger and
// allowlist (bridge/byok/security/egress.mjs). What Chromium may request is
// decided here, by session.webRequest.onBeforeRequest on every session:
//   - the settings page and its files from the app's own scheme (nqa://app/,
//     src/scheme.mjs), and only paths that can name a renderer file;
//   - https to the update feed's hosts (GitHub's release pages, its API and its
//     asset CDNs), and only while update checks are on (electron-updater's net
//     requests can't be routed elsewhere: its executor is readonly);
//   - devtools in an unpackaged run;
// and nothing else: file: (the fuse that gave it extra privileges is off),
// data:, blob:, every other scheme and host, and the providers' hosts (those are the
// bridge's, in Node). What was allowed and refused goes to a ledger the
// Connections page shows (a refused request keeps its scheme and host only).
//
// electron-updater makes its requests on its own partition ("electron-updater",
// electronHttpExecutor.js), not the default session, so the guard is installed
// on both. checkShellRequest is pure so it can be tested without Electron.
import { SCHEME, checkSchemeUrl } from './scheme.mjs';

/**
 * GitHub's release pages and the two asset CDNs a release download redirects to. Not its API:
 * electron-updater's GitHubProvider reads github.com/<owner>/<repo>/releases/latest for a public
 * github.com feed and uses api.github.com only for GitHub Enterprise or a custom host (SY-14).
 */
export const UPDATE_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
/** electron-updater's session partition (electron-updater/out/electronHttpExecutor.js). */
export const UPDATER_PARTITION = 'electron-updater';

const deny = (kind, scheme = null, host = null) => ({ allow: false, kind, scheme, host });

/**
 * Decide one request. Returns { allow, kind, scheme, host[, port] } where kind
 * is 'page' (the app's own page and its files), 'update' (https to an update
 * host, while checks are on), 'devtools' (unpackaged runs only), or why it was
 * refused: 'file', 'scheme', 'host', 'port', 'credentials', 'updates_off',
 * 'page_path', 'bad_url'.
 */
export function checkShellRequest(rawUrl, { allowUpdates = false, allowDevtools = false } = {}) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return deny('bad_url'); }
  const scheme = u.protocol.replace(/:$/, '');
  if (scheme === SCHEME) {
    const c = checkSchemeUrl(u.href);
    return c.ok ? { allow: true, kind: 'page', scheme, host: u.host } : deny('page_path', scheme, u.host || null);
  }
  if (scheme === 'file') return deny('file', scheme, u.host || null);
  if (scheme === 'devtools' && allowDevtools) return { allow: true, kind: 'devtools', scheme, host: u.host };
  if (scheme !== 'https') return deny('scheme', scheme, u.hostname || null);
  if (u.username || u.password) return deny('credentials', scheme, u.hostname);
  if (u.port !== '' && u.port !== '443') return deny('port', scheme, u.hostname);
  if (!UPDATE_HOSTS.includes(u.hostname)) return deny('host', scheme, u.hostname);
  if (!allowUpdates) return deny('updates_off', scheme, u.hostname);
  return { allow: true, kind: 'update', scheme, host: u.hostname, port: 443 };
}

/** What an allowed update request was for, from its path. */
export function updateFeature(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const cdn = u.hostname.endsWith('.githubusercontent.com');
    return cdn || /\/releases\/download\/|\/releases\/assets\//.test(u.pathname) ? 'update download' : 'update check';
  } catch { return 'update check'; }
}

/** The shell's side of Connections: allowed hosts with counts and times, blocked ones, and page loads. */
export function createShellLedger({ now = Date.now, maxHosts = 64 } = {}) {
  const allowed = new Map();
  const blocked = new Map();
  let pages = 0;
  const bump = (map, key, fields) => {
    const t = now();
    const row = map.get(key);
    if (row) { row.count += 1; row.last = t; return; }
    if (map.size >= maxHosts) return;
    map.set(key, { ...fields, count: 1, first: t, last: t });
  };
  return {
    record(verdict, url) {
      if (verdict.allow && (verdict.kind === 'page' || verdict.kind === 'devtools')) { pages += 1; return; }
      if (verdict.allow) { bump(allowed, `${verdict.host}:${verdict.port ?? 443}`, { host: verdict.host, port: verdict.port ?? 443, feature: updateFeature(url), by: 'app' }); return; }
      // Only the scheme and host are kept for a refused request, never its path or query.
      bump(blocked, `${verdict.scheme ?? '?'}://${verdict.host ?? ''}`, { scheme: verdict.scheme, host: verdict.host, reason: verdict.kind });
    },
    snapshot() {
      return { pages, allowed: [...allowed.values()].map(r => ({ ...r })), blocked: [...blocked.values()].map(r => ({ ...r })) };
    },
  };
}

/**
 * Install the guard on each session. allowUpdates() is read on every request, so turning
 * update checks off closes the feed's hosts at once. Returns the sessions it was installed on.
 */
export function installShellGuard(sessions, { ledger, allowUpdates = () => false, allowDevtools = false, onBlocked = null }) {
  for (const ses of sessions) {
    ses.webRequest.onBeforeRequest((details, callback) => {
      let updates = false;
      try { updates = allowUpdates() === true; } catch { updates = false; }
      const verdict = checkShellRequest(details.url, { allowUpdates: updates, allowDevtools });
      ledger?.record(verdict, details.url);
      if (!verdict.allow && onBlocked) onBlocked(verdict);
      callback({ cancel: !verdict.allow });
    });
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// The environment Node reads for its own connections (final review L2-1; SR-05; §8.1, TH22). The
// fuses turn off NODE_OPTIONS, --inspect and ELECTRON_RUN_AS_NODE, but Node still reads these two from
// the environment in the app's main process, where the bridge sends a provider's key with Node's own
// fetch (bridge/byok/boot.mjs: globalThis.fetch, never Electron's net):
//   NODE_TLS_REJECT_UNAUTHORIZED=0 turns certificate checks off; Node reads it at every TLS
//     connect, so removing it before the first connection is enough;
//   NODE_USE_ENV_PROXY sends every request through HTTP(S)_PROXY, a local proxy that the egress
//     guard sees only as loopback; Node applies it when it starts, so it can't be undone later and
//     the app refuses to start.
// A same-user process that relaunches the app with them would otherwise have the app's own
// identity read the key and hand it to that proxy.
export const TLS_OFF_ENV = 'NODE_TLS_REJECT_UNAUTHORIZED';
export const ENV_PROXY_ENV = 'NODE_USE_ENV_PROXY';
export const EXTRA_CA_ENV = 'NODE_EXTRA_CA_CERTS';

/**
 * What stops a start: NODE_USE_ENV_PROXY. Two that change what Node trusts are not here, on purpose
 * (SR-05):
 *   NODE_EXTRA_CA_CERTS (certificates from a file, beside Node's own) never reaches a packaged app:
 *     Electron's SetNodeOptions (shell/common/node_bindings.cc) unsets it before Node reads it while
 *     the EnableNodeOptionsEnvironmentVariable fuse is off (scripts/fuses.cjs), so there is nothing
 *     here to refuse; the packaged self-test starts with it naming a CA file and checks it's gone and
 *     Node added no certificate. Removing it in JavaScript couldn't help: Node reads it as it starts
 *     (tests/byok/app_net_test.mjs). A development run's Electron keeps that fuse on, so it honours
 *     NODE_EXTRA_CA_CERTS: a dev-run test that sees it trusted says nothing about a packaged app.
 *   NODE_USE_SYSTEM_CA only adds the operating system's trust store, which takes a new root only when
 *     the person approves a trust change, and which Chromium's own network stack (the update feed)
 *     already trusts; and Claude Code exports it in every shell it runs, so refusing it would stop
 *     every packaged app an agent's shell starts.
 */
export const REFUSED_ENV = Object.freeze([ENV_PROXY_ENV]);

/** Remove what can be removed from env (in place); returns { removed: [names], refuse: name|null }. */
export function guardNetworkEnv(env = process.env) {
  const removed = [];
  if (Object.hasOwn(env, TLS_OFF_ENV)) { delete env[TLS_OFF_ENV]; removed.push(TLS_OFF_ENV); }
  const refuse = REFUSED_ENV.find(name => typeof env[name] === 'string' && env[name] !== '') ?? null;
  return { removed, refuse };
}

/** The one line the app shows, logs and writes to stderr when it won't start because of the environment. */
export const refuseLine = name => `NeverQuestAlone won’t start while ${name} is set, because it would send your API key through a proxy. Start it again without that variable.`;

// ---------------------------------------------------------------------------
// What a dependency's loader reads to choose the code it loads (SR-05). The key store's binding
// loader, @napi-rs/keyring's index.js (requireNative), which keystore.mjs imports the first time the
// key store is used, require()s NAPI_RS_NATIVE_LIBRARY_PATH instead of its own binding whenever it's
// set: a same-user process that relaunched the app with it naming a .js file had that file run in the
// main process, as the app, where it could read every saved key (a .js file needs no library
// validation, and no fuse limits what require() loads). Its WASI switches (NAPI_RS_FORCE_WASI and the
// one naming a WASI build) send the same loader to a build the app doesn't ship, which only a file
// planted in the app's own folder could answer, and NAPI_RS_ENFORCE_VERSION_CHECK only adds a check.
// The app ships its binding and needs none of them, so every NAPI_RS_* variable leaves, in every run:
// the loader reads them from process.env when it runs, so removing them before any of the app's
// modules load (src/launch-guard.mjs) is enough.
//   Read and left alone, in the other production dependencies app.asar ships: electron-updater's
// LOCALAPPDATA and XDG_CACHE_HOME (its download folder, the same user's either way; it reads no
// ELECTRON_UPDATER_* variable), APPIMAGE, SNAP and ELECTRON_BUILDER_LINUX_PACKAGE_MANAGER (Linux
// updaters the app doesn't ship), GH_TOKEN and GITHUB_TOKEN (a private feed's only; this one is
// public), TEST_UPDATER_ARCH (another architecture's file from the same signed feed) and
// DIFFERENTIAL_DOWNLOAD_PLAN_BUILDER_VALIDATE_RANGES (one more check); debug's DEBUG and DEBUG_* (log
// lines); graceful-fs's GRACEFUL_FS_PLATFORM, TEST_GRACEFUL_FS_GLOBAL_PATCH and NODE_DEBUG; semver's
// NODE_DEBUG; argparse's COLUMNS. None of them uses node-gyp-build, bindings, prebuild-install,
// process.dlopen or an npm_config_* variable. NODE_PATH does nothing here (Electron's main process
// ignores it), and DYLD_* is the hardened runtime's (the Mac app's only entitlement is allow-jit).
export const LOADER_ENV_PREFIX = 'NAPI_RS_';

/** Whether a variable is one LOADER_ENV_PREFIX names (in any case: Windows' variable names have none). */
export const loaderVariable = name => String(name).toUpperCase().startsWith(LOADER_ENV_PREFIX);

/** Remove every NAPI_RS_* variable from env (in place); returns { removed: [names] }. */
export function guardLoaderEnv(env = process.env) {
  const removed = Object.keys(env).filter(loaderVariable);
  for (const name of removed) delete env[name];
  return { removed };
}

// ---------------------------------------------------------------------------
// What a packaged app may be started with (SR-05; code health AP-04; the 2026-09-26 audit's LA-01,
// KB-04, KA-06; TH22). The fuses (scripts/fuses.cjs) cover Node's side only: no running as Node, no
// NODE_OPTIONS, no --inspect or --inspect-brk. Chromium reads its own switches from the command line,
// and a same-user process that relaunched the packaged app with one changed what the app does as
// itself: --remote-debugging-port or -pipe gave DevTools on the window, where the key field reads a
// pasted key; --js-flags handed V8 flags to the main process, where keys are read; --no-sandbox undid
// the renderer's sandbox; --renderer-cmd-prefix, --utility-cmd-prefix, --gpu-launcher and
// --browser-subprocess-path ran a program of its choosing as each child process started. A list of
// what to refuse kept missing some, so a packaged app starts only with what its own launchers pass:
//   --hidden        the Windows login item (src/login-item.mjs); the app reads it on every OS (main.mjs)
//   --updated       electron-builder's NSIS installer starting the app after an update (its
//                   templates/nsis/common.nsh StartApp; electron-updater runs the installer with
//                   --updated --force-run: updater.mjs quitAndInstall(false, true))
//   --self-test     scripts/self-test.mjs and scripts/footprint.mjs, and with it only, the self-test's
//                   --show-window, --show-window-ms=<n>, --no-relaunch and Chromium's --use-mock-keychain
//   -Embedding      Windows only: COM adds it when a notification's click starts the app (Electron 44
//                   registers the exe, with no arguments, as its toast activator's LocalServer32)
//   -psn_<n>_<n>    macOS only: a process serial number LaunchServices may pass
// Nothing else passes any: the installer's Start-menu and desktop shortcuts and Electron's own
// Start-menu shortcut carry no arguments; macOS's login item, Squirrel.Mac's relaunch after an update
// (ShipIt's launchApplicationAtURL, no arguments) and Move to Applications (/usr/bin/open <app>) pass
// none; app.relaunch passes this launch's own (main.mjs relaunchApp); and the app registers no
// protocol or file type. An argument that isn't a switch is left alone: neither Chromium nor a
// packaged main.mjs reads one, and documents and links reach a Mac app as Apple Events, not
// arguments. Chromium starts its child processes (renderers, the GPU and utility processes, and their
// restarts) itself, from the browser's own command line, which is the one this checks. DEBUG_SWITCHES
// and LAUNCH_SWITCHES are also asked of Chromium's own parser, in case it reads one that argv hides.
// A development run keeps every switch.
export const DEBUG_SWITCHES = Object.freeze([
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-allow-origins',
  'js-flags', 'no-sandbox', 'disable-web-security',
]);
/** Chromium's switches that run a program of the caller's choosing as a child process starts. */
export const LAUNCH_SWITCHES = Object.freeze(['renderer-cmd-prefix', 'browser-subprocess-path', 'utility-cmd-prefix', 'gpu-launcher']);
/** What a packaged app starts with on every OS (see above). */
export const ALLOWED_SWITCHES = Object.freeze(['hidden', 'updated', 'self-test']);
/** The self-test's own, allowed only beside --self-test. */
export const SELF_TEST_SWITCHES = Object.freeze(['show-window', 'show-window-ms', 'no-relaunch', 'use-mock-keychain']);

/**
 * The debugging switches a packaged app was started with, in DEBUG_SWITCHES order; [] for a
 * development run. Asked of hasSwitch (Electron's app.commandLine.hasSwitch, Chromium's own parser:
 * --x, -x and, on Windows, /x) and looked for in argv the same way, in any case, so either one
 * seeing it is enough; a hasSwitch that throws counts as a yes. Pure: main.mjs passes Electron's.
 */
export function debugSwitches({ packaged = true, hasSwitch = () => false, argv = [] } = {}) {
  if (!packaged) return [];
  const named = new Set();
  for (const a of argv) {
    const m = /^(?:--?|\/)([^=]+)(?:=|$)/.exec(String(a));
    if (m) named.add(m[1].toLowerCase());
  }
  return DEBUG_SWITCHES.filter(s => {
    if (named.has(s)) return true;
    try { return hasSwitch(s) === true; } catch { return true; }
  });
}

/**
 * The switches some arguments name, in order, the way Chromium's parser reads them: each argument
 * trimmed, then --x, -x or, on Windows, /x, the name up to any '=', in lower case. A lone - or -- names
 * none. The trim takes every character Chromium's or JavaScript's takes (and U+0085), so nothing
 * Chromium reads as a switch passes here as a plain argument.
 */
export function switchNames(args, { platform = process.platform } = {}) {
  const prefixes = platform === 'win32' ? ['--', '-', '/'] : ['--', '-'];
  const names = [];
  for (const a of args) {
    const arg = String(a).replace(/^[\s\u0085]+|[\s\u0085]+$/g, '');
    // Chromium's order: the first prefix that fits, and nothing after it means no switch (-- itself).
    const p = prefixes.find(x => arg.startsWith(x));
    if (p && arg.length > p.length) names.push(arg.slice(p.length).split('=')[0].toLowerCase());
  }
  return names;
}

/** Whether a packaged app starts with this switch (a name as switchNames gives it). */
export function allowedSwitch(name, { platform = process.platform, selfTest = false } = {}) {
  if (ALLOWED_SWITCHES.includes(name) || (selfTest && SELF_TEST_SWITCHES.includes(name))) return true;
  if (platform === 'win32') return name === 'embedding';
  if (platform === 'darwin') return /^psn_\d+_\d+$/.test(name);
  return false;
}

/**
 * The switches a packaged app won't start with, each once; [] for a development run. First every
 * switch argv names that isn't allowed, in argv's order; then those of DEBUG_SWITCHES and
 * LAUNCH_SWITCHES that Chromium's own parser sees (hasSwitch) where argv didn't, a hasSwitch that
 * throws counting as a yes. argv is process.argv's shape, the executable first; --self-test counts
 * only as main.mjs reads it (exactly). Pure: main.mjs passes Electron's hasSwitch.
 */
export function launchSwitches({ packaged = true, hasSwitch = () => false, argv = [], platform = process.platform } = {}) {
  if (!packaged) return [];
  const args = argv.slice(1).map(String);
  const selfTest = args.includes('--self-test');
  const seen = s => { try { return hasSwitch(s) === true; } catch { return true; } };
  return [...new Set([
    ...switchNames(args, { platform }).filter(s => !allowedSwitch(s, { platform, selfTest })),
    ...debugSwitches({ packaged, hasSwitch, argv }),
    ...LAUNCH_SWITCHES.filter(seen),
  ])];
}

/** The one line a packaged app writes to stderr when it won't start with a switch (shown in plain ASCII, at most 64 characters). */
export const switchLine = name => `NeverQuestAlone won’t start with --${String(name).replace(/[^\x21-\x7e]/g, '?').slice(0, 64)}. Start it again without it.`;
