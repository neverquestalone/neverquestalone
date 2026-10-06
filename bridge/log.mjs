// The bridge log (PRD §7 "Observability"): JSON lines in <logDir>/bridge-YYYY-MM-DD.jsonl
// (the developer command line's <data>/logs), kept 7 days, with every known secret scrubbed.
// Only metadata is logged about chats (ids, sizes); other sessions' content never reaches the
// bridge's handlers at all.
// Every line (file and echo) passes through the BYOK redactor (public PRD
// §8.4 item 7, KY-9): the known secrets as exact matches, plus the provider
// key, auth-header, token and JWT patterns.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './byok/security/redact.mjs';

export function createLogger(logDir, { echo = false, secrets = [] } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  const known = new Set(secrets.filter(s => s && s.length >= 16));
  const scrub = (s) => redact(String(s), known);
  const file = () => path.join(logDir, `bridge-${new Date().toISOString().slice(0, 10)}.jsonl`);
  const rotate = () => {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      if (!/^bridge-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const p = path.join(logDir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p); } catch { /* gone */ }
    }
  };
  rotate();
  const timer = setInterval(rotate, 24 * 3600 * 1000);
  timer.unref?.();
  const log = (kind, data = {}) => {
    const line = scrub(JSON.stringify({ t: new Date().toISOString(), kind, ...data }));
    try { fs.appendFileSync(file(), line + '\n', { mode: 0o600 }); } catch { /* disk trouble: keep running */ }
    if (echo) {
      const brief = scrub(JSON.stringify(data));
      console.log(`${new Date().toISOString().slice(11, 19)} ${kind.padEnd(16)} ${brief.length > 200 ? brief.slice(0, 200) + '…' : brief}`);
    }
  };
  log.addSecret = (s) => { if (s && s.length >= 16) known.add(s); };
  log.scrub = scrub;
  log.file = file;
  return log;
}
