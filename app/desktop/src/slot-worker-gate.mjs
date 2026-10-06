// The packaged self-test's check of the bridge's slot worker (code health BR-04): the bridge writes its
// slot files from a worker thread (bridge/transport/slot-worker.mjs), which a packaged app starts from
// inside app.asar. A worker that can't start there leaves every write on the main thread, which still
// works, so nothing else would notice; this check fails then. It loads the module the publisher loads,
// from the same bridge root through the loader's importer (src/api-loader.mjs, the self-test's
// sandboxReport), has its worker write one slot table into a temp AddOns folder of 200 slots inside
// the self-test's sandbox, and asks the worker for its state.
//
//   slotWorkerGate({ root, importer, dir, waitMs }) → Promise<{ ok, state, written, errors, failed }>
//   ok: the worker answered (no slot-worker-failed line, its state 'running'), and all 201 files (the
//   200 slots and the reload inbox) were written with no error. failed: each slot-worker-failed line's
//   why ('error', 'exit', 'timeout' …). Never throws: a module that won't load is { ok: false, error }.
import fs from 'node:fs';
import path from 'node:path';

/** The bridge files the check loads, relative to the bridge root. */
export const SLOT_WORKER_FILE = 'bridge/write-queue.mjs';
export const SLOTS_FILE = 'bridge/transport/slots.mjs';
/** How long the worker may take to answer (its start included) before the check calls it failed. */
export const GATE_WAIT_MS = 10_000;

export async function slotWorkerGate({ root, importer, dir, waitMs = GATE_WAIT_MS, url = null }) {
  const failed = [];
  const out = { ok: false, state: null, written: 0, errors: 0, failed };
  const gateDir = path.join(dir, 'slot-worker-gate');
  let writer = null;
  try {
    const { createSlotWorker } = await importer(path.join(root, ...SLOT_WORKER_FILE.split('/')));
    const { installSlots, SLOT_COUNT, SLOT_JOB } = await importer(path.join(root, ...SLOTS_FILE.split('/')));
    const addons = path.join(gateDir, 'AddOns');
    installSlots(addons, { count: SLOT_COUNT });
    fs.mkdirSync(path.join(addons, 'NeverQuestAlone'), { recursive: true });
    // waitMs 1: a drain (below, when no answer came) gives up at once instead of holding the main thread.
    writer = createSlotWorker({ log: (kind, data) => { if (kind === 'slot-worker-failed') failed.push(String(data?.why ?? 'failed')); }, waitMs: 1, ...(url ? { url } : {}) });
    writer.use(SLOT_JOB); // the plugin's runner for its slot tables, which the worker loads from inside the app
    const res = await new Promise((resolve) => {
      let timer = null;
      const done = (r) => { clearTimeout(timer); resolve(r); };
      const posted = writer.write({ addonsDir: addons, text: 'NQA_SlotData = nil\n', inbox: 'NQA_Inbox = nil\n', opts: { count: SLOT_COUNT } }, done);
      if (!posted) { done(null); return; }
      // No answer in time: the drain gives up on it (slot-worker-failed: timeout) and settles it.
      timer = setTimeout(() => writer.drain(), waitMs);
    });
    out.state = writer.state();
    out.written = res?.written ?? 0;
    out.errors = res?.errors ?? 0;
    out.ok = !!res && out.state === 'running' && failed.length === 0 && out.written === SLOT_COUNT + 1 && out.errors === 0;
  } catch (e) {
    out.error = String(e?.message ?? e).slice(0, 160);
  } finally {
    try { writer?.stop(); } catch { /* ended */ }
    try { fs.rmSync(gateDir, { recursive: true, force: true }); } catch { /* the sandbox goes with the self-test */ }
  }
  return out;
}
