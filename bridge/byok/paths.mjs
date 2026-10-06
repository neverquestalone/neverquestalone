// Per-OS folders for the app (public BYOK PRD §8.1, §11.1, RT-9, SL-6; BUILD-PLAN "paths.mjs"),
// never an older build's "nqa" folders.
//
//   publicPaths({ platform, env, home }) → {
//     config,      the folder holding config.json (configFile)
//     data,        the backend's data: transcripts/, memory/, ledger.json, caps.json (0700)
//     state,       run-time state: the per-AddOns bridge lock
//     bridgeState, <state>/bridge: the core's store (outbox, records, companion state)
//     logs,        the bridge's log folder
//   }
//   macOS    ~/Library/Application Support/NeverQuestAlone (logs ~/Library/Logs/NeverQuestAlone)
//   Windows  %APPDATA%\NeverQuestAlone (logs %LOCALAPPDATA%\NeverQuestAlone\logs)
//   Linux    $XDG_CONFIG_HOME/neverquestalone (state and data $XDG_STATE_HOME/neverquestalone,
//            logs under state)
// The desktop app keeps its data in Electron's userData (the same folder on macOS and Windows),
// but its locks always come from here, so the developer command line (bridge/nqa.mjs) finds
// them. There is no control pipe (systems plan D6).
//
// The folder names are the app's identity's (bridge/identity.mjs, which reads it once, at load): its
// productName on macOS and Windows (Electron names userData after it), its package name on Linux.
//
// Pure: nothing here touches the disk (lockFileFor, re-exported from lock.mjs, resolves links).
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { IDENTITY } from '../identity.mjs';

export const PRODUCT_DIR = IDENTITY.productName;
export const LINUX_DIR = IDENTITY.name;
export const CONFIG_NAME = 'config.json';

// An environment folder only when it's absolute (XDG says a relative one is ignored).
const absIn = (p, v) => (typeof v === 'string' && v && p.isAbsolute(v) ? v : null);

/** The folders of the public app on this OS. */
export function publicPaths({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  let config, state, logs;
  if (platform === 'darwin') {
    config = p.join(home, 'Library', 'Application Support', PRODUCT_DIR);
    state = config;
    logs = p.join(home, 'Library', 'Logs', PRODUCT_DIR);
  } else if (platform === 'win32') {
    const roaming = absIn(p, env.APPDATA) ?? p.join(home, 'AppData', 'Roaming');
    const local = absIn(p, env.LOCALAPPDATA) ?? p.join(home, 'AppData', 'Local');
    config = p.join(roaming, PRODUCT_DIR);
    state = config;
    logs = p.join(local, PRODUCT_DIR, 'logs');
  } else {
    config = p.join(absIn(p, env.XDG_CONFIG_HOME) ?? p.join(home, '.config'), LINUX_DIR);
    state = p.join(absIn(p, env.XDG_STATE_HOME) ?? p.join(home, '.local', 'state'), LINUX_DIR);
    logs = p.join(state, 'logs');
  }
  return {
    platform,
    config,
    configFile: p.join(config, CONFIG_NAME),
    data: state,
    state,
    bridgeState: p.join(state, 'bridge'),
    logs,
  };
}

// The longest Unix socket path the Mac capture socket may have (audit PF-07, LS-07): macOS listen()
// takes 104 bytes and refuses 105, and the Swift helper refuses 104 (Emitter.swift), so 103.
export const SOCKET_PATH_MAX = 103;

/**
 * The Mac capture socket: <state>/capture.sock, or, when that path would be too long for a socket
 * (a long account name or a deep home folder), capture-<hash of state>.sock in the per-user temp
 * folder ($TMPDIR, mode 0700 on macOS; os.tmpdir() when it isn't absolute), which one install
 * always maps to the same name.
 */
export function captureSocketPath(state, { env = process.env, tmpdir = os.tmpdir() } = {}) {
  const inState = path.join(state, 'capture.sock');
  if (Buffer.byteLength(inState) <= SOCKET_PATH_MAX) return inState;
  const dir = absIn(path, env.TMPDIR) ?? tmpdir;
  return path.join(dir, `capture-${crypto.createHash('sha256').update(state).digest('hex').slice(0, 16)}.sock`);
}

// The lock file that says which bridge serves an AddOns folder lives in lock.mjs (it resolves
// symlinks, so it reads the disk); named here too for the callers that already look for it.
export { lockFileFor } from './lock.mjs';
