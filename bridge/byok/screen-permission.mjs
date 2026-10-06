// Screen Recording on macOS, asked and checked from the app (onboarding spec §3.8 row 2, §9.3,
// §9.4; plan §5.2). The capture helper owns the grant (it's the "responsible" app LaunchServices
// starts), so both the check and the request run the helper itself, as a new instance beside the
// socket helper that may already be up and idle:
//
//   open -n -g -W -a <helper> --stdout <file> --stderr <file> --args --check-permission
//   open -n -g -W -a <helper> --stdout <file> --stderr <file> --args --request-permission
//
// -n: a new instance (without it, open hands the arguments to the running copy, which drops them,
// and -W waits for that copy to exit). -W: wait until it exits. The helper handles both modes
// before its socket and its instance lock (main.swift), prints one {"permission": bool} line and
// exits; --request-permission shows macOS's own box once and waits up to 120 s for the answer.
// The helper is checked against the app's code requirement first, the way the socket launch is
// (transport/capture.mjs checkCaptureApp): a helper that fails it never runs.
//
//   createScreenPermission({ app, verify, run, tmpdir, fs }) → { probe(), request() }
//   each → Promise<{ permission: true|false|null, error?: 'helper_missing'|'signature_invalid'|'failed' }>
import fsDefault from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const PROBE_TIMEOUT_MS = 10_000;
export const REQUEST_TIMEOUT_MS = 130_000;
/** How long row 2 reads "asked" after a request (the request helper's own lifetime). */
export const ASKED_MS = 120_000;

/** execFile as a promise: {status, stdout, stderr}; never throws. */
export function runFile(cmd, args, { timeout } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
      resolve({ status: err ? (Number.isInteger(err.code) ? err.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), timedOut: !!err?.killed });
    });
  });
}

/** The last {"permission": bool} line the helper printed, or null. */
export function parsePermission(text) {
  const lines = String(text ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(lines[i]);
      if (o && typeof o === 'object' && typeof o.permission === 'boolean') return o.permission;
    } catch { /* not a JSON line */ }
  }
  return null;
}

/** The open(1) arguments for a mode ('--check-permission' or '--request-permission'). */
export function openArgs(app, mode, out, err) {
  return ['-n', '-g', '-W', '-a', app, '--stdout', out, '--stderr', err, '--args', mode];
}

export function createScreenPermission({ app, verify = null, run = runFile, tmpdir = os.tmpdir, fs = fsDefault } = {}) {
  async function once(mode, timeout) {
    if (typeof app !== 'string' || !app || !fs.existsSync(app)) return { permission: null, error: 'helper_missing' };
    if (typeof verify === 'function') {
      let ok = false;
      try { ok = !!(await verify(app)); } catch { ok = false; }
      if (!ok) return { permission: null, error: 'signature_invalid' };
    }
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'bones-perm-'));
    const tag = crypto.randomBytes(4).toString('hex');
    const out = path.join(dir, `out-${tag}.txt`);
    const errFile = path.join(dir, `err-${tag}.txt`);
    try {
      const r = await run('/usr/bin/open', openArgs(app, mode, out, errFile), { timeout });
      let text = '';
      try { text = fs.readFileSync(out, 'utf8'); } catch { text = ''; }
      const permission = parsePermission(text);
      if (permission === null) return { permission: null, error: 'failed', ...(r?.timedOut ? { timedOut: true } : {}) };
      return { permission };
    } catch {
      return { permission: null, error: 'failed' };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
    }
  }
  return {
    probe: () => once('--check-permission', PROBE_TIMEOUT_MS),
    request: () => once('--request-permission', REQUEST_TIMEOUT_MS),
  };
}
