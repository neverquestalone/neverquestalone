// The launch's own checks, before anything else of the app's runs (SR-05; code health AP-04; final
// review L2-1). main.mjs imports this module before any other of its own: every import is evaluated
// before main.mjs's first line, and ipc.mjs and src/redact.mjs load bridge modules (keystore.mjs among
// them) with top-level await, so a check in main.mjs's body would come after them. This one comes
// before all of them, and long before 'ready': no window, renderer, GPU or utility process exists yet.
//   1. What a dependency's loader would load instead of its own code leaves the environment
//      (src/net-guard.mjs guardLoaderEnv: every NAPI_RS_* variable, NAPI_RS_NATIVE_LIBRARY_PATH first among them).
//   2. The environment Node reads for the bridge's connections (guardNetworkEnv): NODE_TLS_REJECT_UNAUTHORIZED
//      leaves now; NODE_USE_ENV_PROXY, which stops the start, is acted on in main.mjs's start(), with
//      its native error box, before the bridge starts. (NODE_EXTRA_CA_CERTS never gets this far in a
//      packaged app: Electron unsets it before Node starts; net-guard.mjs REFUSED_ENV says why.)
//   3. A packaged app starts only with the switches its own launchers pass (launchSwitches): anything
//      else comes off Chromium's command line, then one line on stderr (and the self-test's line on
//      stdout under --self-test), and exit 1. Before ready, app.exit ends the process at once, so the
//      lines are written synchronously, never left in a stream's queue.
// scripts/self-test.mjs checks all three on every packaged build. A development run keeps its switches.
import fs from 'node:fs';
import { app } from 'electron';
import { guardLoaderEnv, guardNetworkEnv, launchSwitches, switchLine, DEBUG_SWITCHES } from './net-guard.mjs';

/** The loader variables this launch had, now removed ({ removed }). */
export const LOADER_FOUND = guardLoaderEnv(process.env);
/** { removed, refuse }: main.mjs logs the first and acts on the second. */
export const NET_ENV = guardNetworkEnv(process.env);

const refused = launchSwitches({ packaged: app.isPackaged, hasSwitch: s => app.commandLine.hasSwitch(s), argv: process.argv });
if (refused.length) {
  for (const s of refused) { try { app.commandLine.removeSwitch(s); } catch {} }
  try { fs.writeSync(2, `${switchLine(refused[0])}\n`); } catch {}
  if (process.argv.includes('--self-test')) {
    const error = DEBUG_SWITCHES.includes(refused[0]) ? 'debug_switch' : 'launch_switch';
    try { fs.writeSync(1, `${JSON.stringify({ selfTest: 'neverquestalone', ok: false, error, switch: refused[0] })}\n`); } catch {}
  }
  app.exit(1);
}
