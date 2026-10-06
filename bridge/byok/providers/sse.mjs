// SSE and NDJSON readers over a fetch Response body (PRD §7.5: stream
// internally, publish whole). Robust to chunks split anywhere: mid-line, between
// "\r" and "\n", and inside a multi-byte UTF-8 character. The body can be a web
// ReadableStream, any async iterable of Uint8Array/string chunks, or a string.
//
// An event or line cut off by the end of the stream is never dispatched as if
// it were complete (the SSE spec's rule), so a dropped connection can't hand
// the adapters half a JSON object.

const MAX_LINE = 4 * 1024 * 1024;

async function* chunksOf(body) {
  if (body == null) return;
  if (typeof body === 'string' || body instanceof Uint8Array) { yield body; return; }
  for await (const chunk of body) yield chunk;
}

// Yields [line, terminated] pairs. `terminated` is false only for a final line
// that the stream ended in the middle of.
async function* rawLines(body, { maxLine = MAX_LINE } = {}) {
  const dec = new TextDecoder('utf-8');
  let buf = '';
  let skipLF = false;
  const take = function* (text) {
    if (!text) return;
    if (skipLF) {
      skipLF = false;
      if (text.charCodeAt(0) === 10) text = text.slice(1);
      if (!text) return;
    }
    const from = buf.length;
    buf += text;
    let start = 0;
    for (let i = from; i < buf.length; i++) {
      const ch = buf.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      yield buf.slice(start, i);
      if (ch === 13) {
        if (i + 1 < buf.length) { if (buf.charCodeAt(i + 1) === 10) i += 1; }
        else skipLF = true;
      }
      start = i + 1;
    }
    buf = buf.slice(start);
    if (buf.length > maxLine) {
      const err = new Error('stream line too long');
      err.code = 'ERR_STREAM_LINE_TOO_LONG';
      throw err;
    }
  };
  for await (const chunk of chunksOf(body)) {
    const text = typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
    for (const line of take(text)) yield [line, true];
  }
  for (const line of take(dec.decode())) yield [line, true];
  if (buf.length) yield [buf, false];
}

// Every line, the unterminated tail included.
export async function* readLines(body, opts) {
  for await (const [line] of rawLines(body, opts)) yield line;
}

// Server-sent events: {event, data, id}. Comments (":" lines) are skipped;
// multiple data lines join with "\n"; an event completes at a blank line, or at
// the end of the stream when its last line was complete.
export async function* readSSE(body, opts) {
  let data = [];
  let event = '';
  let id = null;
  let complete = true;
  const flush = () => {
    const ev = data.length ? { event: event || 'message', data: data.join('\n'), id } : null;
    data = [];
    event = '';
    return ev;
  };
  for await (const [line, terminated] of rawLines(body, opts)) {
    if (!terminated) { complete = false; break; }
    if (line === '') {
      const ev = flush();
      if (ev) yield ev;
      continue;
    }
    if (line.charCodeAt(0) === 58) continue; // ":" comment, e.g. OpenRouter's keep-alives
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }
  if (complete) {
    const ev = flush();
    if (ev) yield ev;
  }
}

// Newline-delimited JSON (Ollama's native API). Blank lines are skipped. A line
// that isn't JSON throws, and the error never carries the line's text.
export async function* readNDJSON(body, opts) {
  for await (const [line, terminated] of rawLines(body, opts)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch {
      const err = new Error(terminated ? 'malformed NDJSON line' : 'stream ended mid-line');
      err.code = terminated ? 'ERR_STREAM_MALFORMED' : 'ERR_STREAM_TRUNCATED';
      throw err;
    }
    yield obj;
  }
}
