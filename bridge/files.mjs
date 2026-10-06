// Two ways to replace a file whole (systems plan Batch 4, SY-03):
//
//   writeFileDurable  temp file, fsync, rename, fsync the folder: only where money or a message
//                     would be lost with the last write, the run ledger's 'sending' entry (before a
//                     request may be billed) and the outbox's new message (before its ack lets the
//                     host forget it).
//   writeFileQuick    temp file and rename, no fsync: everything derived. It survives the app
//                     crashing (the data is in the OS's cache); a power cut or an OS crash may lose
//                     the last moments of it, which the store's epoch and catch-up and the ledger
//                     are there for.
//
// Both write 0600 and never leave a partial copy behind. ensureStateDir makes a state folder 0700.
//
// A temp file's name is its file's, this process's, the time, a count and, off the main thread, the
// thread's id (code health BR-04, durable writes: the bridge's write worker and the main thread, when it
// takes the writes over, never share one).
import fs from 'node:fs';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

let n = 0; // two writes of one file in the same millisecond get their own temp names
const tmpFor = (file) => {
  n = (n + 1) % 1e9;
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now().toString(36)}-${n.toString(36)}${threadId ? `-w${threadId}` : ''}.tmp`);
};

/** A state folder, made if missing, 0700. */
export function ensureStateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** Write a file atomically with mode 0600: temp file, fsync, rename, fsync the folder. */
export function writeFileDurable(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  const tmp = tmpFor(file);
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // never leave a partial copy
    throw e;
  }
  try {
    const dfd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
  } catch { /* some filesystems refuse directory fsync */ }
}

export function writeFileQuick(file, data, mode = 0o600) {
  const tmp = tmpFor(file);
  try {
    fs.writeFileSync(tmp, data, { mode, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
