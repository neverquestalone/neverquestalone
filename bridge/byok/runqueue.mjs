// The run queue (PRD §6.5, RT-7): a chat's next message waits behind the
// running one. One run at a time per chat, in arrival order, and at most
// `concurrency` runs at once across chats (default 2; upstream had
// maxParallel 3). A waiting run starts as soon as its chat is free and a slot
// opens, earliest arrival first.
//
// run(chatId, fn) calls fn(signal) and settles with fn's result. abort(chatId)
// aborts the running fn's signal and drops the chat's waiting runs (their
// promises reject with the abort reason). The slot frees only when the
// running fn settles, so fn must honor its signal (the adapters pass it to
// fetch).
function abortError() {
  return new DOMException('The run was aborted', 'AbortError');
}

/** createRunQueue({concurrency}) → {run, abort, abortAll, busy, queued, stats} */
export function createRunQueue({ concurrency = 2 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('runqueue: concurrency must be a positive integer');
  const waiting = []; // {chatId, fn, resolve, reject}, arrival order
  const running = new Map(); // chatId -> AbortController

  function start(job) {
    const controller = new AbortController();
    running.set(job.chatId, controller);
    const finish = () => {
      if (running.get(job.chatId) === controller) running.delete(job.chatId);
      pump();
    };
    let result;
    try {
      result = Promise.resolve(job.fn(controller.signal));
    } catch (e) {
      result = Promise.reject(e);
    }
    // Free the slot before the caller's continuation runs, so busy() reads false there.
    result.then(v => { finish(); job.resolve(v); }, e => { finish(); job.reject(e); });
  }

  function pump() {
    for (let i = 0; i < waiting.length && running.size < concurrency;) {
      const job = waiting[i];
      if (running.has(job.chatId)) { i++; continue; }
      waiting.splice(i, 1);
      start(job);
    }
  }

  function run(chatId, fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('runqueue: fn must be a function'));
    return new Promise((resolve, reject) => {
      waiting.push({ chatId, fn, resolve, reject });
      pump();
    });
  }

  function abort(chatId, reason = abortError()) {
    let dropped = 0;
    for (let i = 0; i < waiting.length;) {
      if (waiting[i].chatId !== chatId) { i++; continue; }
      const [job] = waiting.splice(i, 1);
      job.reject(reason);
      dropped++;
    }
    const controller = running.get(chatId);
    const aborted = !!controller && !controller.signal.aborted;
    if (aborted) controller.abort(reason);
    return { aborted, dropped };
  }

  return {
    run,
    abort,
    abortAll(reason = abortError()) {
      const chats = new Set([...running.keys(), ...waiting.map(j => j.chatId)]);
      for (const chatId of chats) abort(chatId, reason);
      return chats.size;
    },
    busy: chatId => running.has(chatId),
    queued: chatId => waiting.reduce((n, j) => n + (j.chatId === chatId ? 1 : 0), 0),
    stats: () => ({ running: running.size, queued: waiting.length, concurrency }),
  };
}
