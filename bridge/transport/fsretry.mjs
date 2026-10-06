// Retries for Windows file-sharing errors on the files the game reads (systems plan Batch 1,
// SY-08; PRD BW.2): the reply slots, NeverQuestAlone/Inbox.lua and the doorbell .wav files.
//
// On NTFS a rename over, a delete of, or a create in place of a file fails while another process
// holds it without the matching share mode: antivirus scanning a file it just saw written (Defender
// scans on open and close), the search indexer, or the game itself reading a slot. Node reports
// EPERM, EACCES or EBUSY, and the condition clears in milliseconds, which is why graceful-fs retries
// Windows renames for a minute. Here: 3 retries over about 150 ms (25, 50, 75 ms), synchronous like
// the writes themselves, and only on Windows. Elsewhere those codes mean a real permission problem
// that waiting won't fix, so nothing is retried.
//
// One retrier per publish (or per ring): once one file has used up its retries, later files in the
// same retrier are tried once, so a folder that stays locked or read-only costs one 150 ms wait per
// publish, never 150 ms for each of 201 files. stats() gives the counts Diagnostics shows
// (recovered after a retry, failed after all of them).
//
//   const r = createRetrier();
//   r.run(() => fs.renameSync(tmp, file));    // returns fn's value, or throws its last error
//   r.stats() → { retries, recovered, failed, gaveUp }
import fs from 'node:fs';

export const RETRY_CODES = Object.freeze(['EPERM', 'EACCES', 'EBUSY']);
export const RETRY_DELAYS_MS = Object.freeze([25, 50, 75]);

/**
 * Blocks this thread for ms (the writes it guards are synchronous already). Atomics.wait where the
 * thread may wait (Node, Electron's main process); a spin on the clock where it may not.
 */
export function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* wait */ }
  }
}

export function createRetrier({ platform = process.platform, delays = RETRY_DELAYS_MS, codes = RETRY_CODES, sleep = sleepSync, onRetry = null } = {}) {
  const retryable = new Set(platform === 'win32' ? codes : []);
  const counts = { retries: 0, recovered: 0, failed: 0, gaveUp: false };
  return {
    run(fn) {
      for (let attempt = 0; ; attempt++) {
        try {
          const v = fn();
          if (attempt > 0) counts.recovered += 1;
          return v;
        } catch (e) {
          const again = retryable.has(e?.code) && !counts.gaveUp && attempt < delays.length;
          if (!again) {
            if (retryable.has(e?.code)) { counts.failed += 1; counts.gaveUp = true; }
            throw e;
          }
          counts.retries += 1;
          try { onRetry?.(e, attempt + 1); } catch { /* a logger's problem */ }
          sleep(delays[attempt]);
        }
      }
    },
    stats: () => ({ ...counts }),
  };
}

/** The three operations the slot and doorbell writers use, each through a retrier. */
export const renameWithRetry = (r, from, to) => r.run(() => fs.renameSync(from, to));
export const unlinkWithRetry = (r, file) => r.run(() => fs.unlinkSync(file));
export const writeFileWithRetry = (r, file, data, opts) => r.run(() => fs.writeFileSync(file, data, opts));
