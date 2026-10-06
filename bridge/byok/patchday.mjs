// Patch day (systems critic SY-29). When World of Warcraft updates, its interface number moves past
// the one the installed addon's TOCs name, and the game won't load an addon it calls out of date:
// Bones is simply gone, and before this nothing said why. The app now notices, sets the TOCs'
// Interface line to the game's number (wow.mjs retargetAddon) and says so; the game loads them at
// its next start.
//
//   createPatchDay({ flavorDir, addonsDir, platform, run, log, now, onChange, gameRunning }) → {
//     check({ reason, client? })  the game's interface number against the addon TOC's, and a retarget
//                                 when they differ. The number comes from the install's own files
//                                 (.build.info, which Battle.net rewrites when an update lands; on macOS
//                                 the client app's Info.plist, except at the slow check): they name
//                                 what the game's next start runs. client, a hello's number, only
//                                 when they name nothing: a hello read from SavedVariables can be from
//                                 before the update
//     gameUp()                    the game started (an update may have landed just before): check
//     gameDown()                  it exited: no restart is owed any more, and files a running game
//                                 held are free, so check again
//     heard(iface)                an addon's hello: it's loaded (so no restart is owed): check
//     tick()                      the core's slow check while WoW is closed: a stat of .build.info, and
//                                 a check only when it changed or a retarget is owed
//     notice()                    what the app says: { from, to, version, at, restart, failed?, error? }
//                                 | null. restart: the game that runs may have read the old TOCs (a
//                                 retarget while it could be running, and no hello since); failed:
//                                 the TOCs couldn't be written (retried at each check)
//   }
// Every check is synchronous and small: a stat, and reads of two short files; the TOCs are written
// only when the numbers differ.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { clientInterface, installedInterfaces, retargetAddon } from './wow.mjs';

export function createPatchDay({
  flavorDir, addonsDir, platform = process.platform, run = spawnSync, log = () => {}, now = Date.now,
  onChange = () => {}, gameRunning = () => null,
} = {}) {
  const buildInfo = path.join(path.dirname(flavorDir), '.build.info');
  let seen = null;        // .build.info's mtime and size when last read
  let client = null;      // { iface, version, from } as last read
  let notice = null;
  let owed = false;       // a retarget failed: try again at every check
  const changed = () => { try { onChange(notice); } catch { /* the host's business */ } };

  const stamp = () => { try { const st = fs.statSync(buildInfo); return `${st.mtimeMs}:${st.size}`; } catch { return 'none'; } };
  function readClient({ plist }) {
    seen = stamp();
    client = clientInterface(flavorDir, { platform, run, plist }) ?? client;
    return client;
  }

  function check({ reason = 'check', client: said = null } = {}) {
    let game = readClient({ plist: reason !== 'tick' });
    if (!game && /^\d{5,6}$/.test(String(said ?? ''))) game = { iface: String(said), version: null, from: 'hello' };
    if (!game?.iface) return notice;
    const have = installedInterfaces(addonsDir);
    if (!have.addon) return notice; // no addon here (uninstalled, or not yet): nothing to retarget
    // In step: the addon's TOC and the first slot's name the game's number. After a failed retarget
    // every TOC is looked at again (one that failed may be any of them).
    const inStep = have.addon === game.iface && (have.slot === null || have.slot === game.iface);
    if (inStep && !owed) return notice;
    const r = retargetAddon({ addonsDir, iface: game.iface });
    if (inStep && r.changed === 0 && r.errors === 0) {
      // Fixed some other way (an install from the app writes every TOC): nothing left to say.
      owed = false;
      if (notice?.failed) { notice = null; changed(); }
      return notice;
    }
    // The game that runs read its TOCs when it started: after a retarget while it may be running,
    // it loads the addon only once it restarts, unless the retarget came from its own hello.
    const restart = reason !== 'hello' && gameRunning() !== false;
    const version = game.version ?? null;
    log('patch-day', { reason, from: have.addon, to: game.iface, version, changed: r.changed, kept: r.kept, errors: r.errors, ...(r.error ? { error: r.error } : {}) });
    owed = r.errors > 0;
    const was = notice;
    notice = {
      from: was?.to === game.iface ? was.from : have.addon, to: game.iface, version: version ?? was?.version ?? null, at: now(),
      restart: owed ? false : restart || (was?.to === game.iface && was.restart === true),
      ...(owed ? { failed: true, error: r.error ?? 'failed' } : {}),
    };
    changed();
    return notice;
  }

  // No restart owed any more: the addon said hello (it's loaded), or the game exited (its next start
  // reads the new TOCs).
  const settle = () => {
    if (!notice?.restart) return;
    notice = { ...notice, restart: false };
    changed();
  };

  return {
    check,
    gameUp: () => check({ reason: 'up' }),
    gameDown() {
      settle();
      check({ reason: 'down' });
    },
    heard(iface) {
      settle();
      check({ reason: 'hello', client: iface });
    },
    tick() {
      if (!owed && stamp() === seen) return;
      check({ reason: 'tick' });
    },
    notice: () => (notice ? { ...notice } : null),
  };
}
