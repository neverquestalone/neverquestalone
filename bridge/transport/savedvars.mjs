// The reload path's file (PROTOCOL §5, systems plan Batch 2, SY-04): which NeverQuestAlone.lua the game
// wrote last. A player may have two WoW accounts on one Battle.net login, a folder left from an old
// account, or none yet (never logged in): the game writes WTF/Account/<account>/SavedVariables/
// NeverQuestAlone.lua for whichever account played, so the newest one is the one to read, looked up at each
// poll rather than once at start.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'NeverQuestAlone.lua';

/** The newest WTF/Account/<account>/SavedVariables/NeverQuestAlone.lua under wtfDir, or null. */
export function newestSavedVariables(wtfDir) {
  const root = path.join(wtfDir, 'Account');
  let names;
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  let best = null;
  let bestAt = -1;
  for (const d of names) {
    if (!d.isDirectory() || d.name.startsWith('.') || d.name === 'SavedVariables') continue;
    const file = path.join(root, d.name, 'SavedVariables', FILE);
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    if (st.isFile() && st.mtimeMs > bestAt) { best = file; bestAt = st.mtimeMs; }
  }
  return best;
}
