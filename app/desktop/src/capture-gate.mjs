// The packaged Mac app's check of its capture helper's peer check, for the self-test (main.mjs; code
// health BR-01), and of the app's own check the other way round (code health LS-03 / peer check): the
// helper NeverQuestAlone ships serves nothing but this app, and this app hears nothing but that helper.
// Four launches of it, each through LaunchServices with boot's arguments (transport/capture.mjs
// launchApp: open -n -g -a), with -W to wait for it to exit and its stdout and stderr in files (open's
// exit code isn't the helper's, so its lines say which exit it took), each on a socket of its own in a
// temp folder:
//   own       this process listens, as the bridge does (in the app's main process): the handshake is
//             the helper's first line, the permission line it sends only once its check has passed;
//   stranger  /usr/bin/nc listens, another program in another process: the helper refuses it, one
//             stderr line ("refused:", exit 6), and sends it nothing;
//   aimed     the stranger again, with --window-name: refused before anything else, one typed stdout
//             line (args_refused, exit 7), in any public build;
//   listener  the app's own listener, transport/capture.mjs createCapture as boot runs it (the app's
//             team, the launch check, the peer check of every connection), given by main.mjs from
//             app.asar: /usr/bin/nc connects first and must be closed unread, one capture-peer-refused
//             line, never counted as connected; then boot's launch of the helper must get through the
//             same check (connected, and its permission line read). Only for an app with a team: one
//             without has no team to ask for and checks no peer, as the helper's own check.
// A helper with no team (ad hoc: an unsigned internal build) has none to ask for and serves the
// stranger, so main.mjs asks for that refusal only of an app with a team; scripts/self-test.mjs, told
// the build is signed (NQA_SELF_TEST_SIGNED=true), asks for the team and every check.
//
//   captureGate({ helper, team, createCapture })
//     → Promise<{ handshake, strangerRefused, argsRefused, connectRefused, connectAccepted, lines }>
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** How long each launch may take; the four run at once. */
export const GATE_MS = 10_000;
/** The stranger: a program that isn't NeverQuestAlone, listening (or connecting) in a process of its own. */
export const STRANGER = '/usr/bin/nc';
/**
 * How long the listener's stranger may stay connected before it's called served: longer than the app's
 * own check of it may take (transport/capture.mjs PEER_CHECK_MS, 5 s; it takes ~0.2 s), so the app
 * always answers it first.
 */
export const STRANGER_MS = 6000;

/** The helper's arguments as boot gives them (transport/capture.mjs launchApp), on `sock`. */
export function helperArgs(sock) {
  return ['--socket', sock, '--magic', 'C72C', '--interval-ms', '250', '--stats-sec', '10'];
}

/** The open(1) arguments for one launch: boot's, plus -W and the two files. */
export function openArgs(helper, dir, extra = []) {
  return ['-n', '-g', '-W', '-a', helper, '--stdout', path.join(dir, 'out.txt'), '--stderr', path.join(dir, 'err.txt'),
    '--args', ...helperArgs(path.join(dir, 'c.sock')), ...extra];
}

const jsonLines = text => String(text ?? '').split('\n').flatMap((l) => { try { const v = JSON.parse(l); return v && typeof v === 'object' ? [v] : []; } catch { return []; } });
const firstLine = text => String(text ?? '').split('\n').map(l => l.trim()).find(Boolean)?.slice(0, 160) ?? null;
const readOr = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

async function until(cond, ms) {
  const t = Date.now();
  while (!cond()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 25)); }
  return true;
}

/** One launch; settles with open's exit code, or null at timeoutMs (the helper still runs). */
function launch(helper, dir, extra, { spawnImpl, timeoutMs }) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    const done = (code) => { clearTimeout(t); resolve(code); };
    let child;
    try { child = spawnImpl('/usr/bin/open', openArgs(helper, dir, extra), { stdio: 'ignore' }); } catch { done(-1); return; }
    child.on('error', () => done(-1));
    child.on('exit', code => done(code ?? -1));
  });
}

/** own: this process listens; the handshake is the helper's permission line. */
async function own(helper, dir, o) {
  const sock = path.join(dir, 'c.sock');
  const conns = new Set();
  let handshake = false;
  let heard;
  const heardIt = new Promise((r) => { heard = r; });
  const server = net.createServer((s) => {
    conns.add(s);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      const nl = buf.lastIndexOf('\n');
      if (nl < 0) return;
      if (jsonLines(buf.slice(0, nl)).some(ev => typeof ev.permission === 'boolean')) { handshake = true; heard(); }
      buf = buf.slice(nl + 1);
    });
    s.on('close', () => conns.delete(s));
    s.on('error', () => {});
  });
  const up = await new Promise((resolve) => { server.once('error', () => resolve(false)); server.listen(sock, () => resolve(true)); });
  if (!up) return { handshake: false, open: null, err: 'this process could not listen' };
  try { fs.chmodSync(sock, 0o600); } catch { /* 0600 as the bridge's socket; its folder is 0700 anyway */ }
  const exited = launch(helper, dir, [], o);
  const code = await Promise.race([heardIt.then(() => undefined), exited]);
  // Its socket closed, the helper exits (main.swift), and open -W with it.
  for (const s of conns) s.destroy();
  server.close();
  return { handshake, open: code === undefined ? await exited : code, err: readOr(path.join(dir, 'err.txt')) };
}

/** stranger (and aimed, with extra): nc listens; whatever reaches it was served to it. */
async function stranger(helper, dir, extra, o) {
  const sock = path.join(dir, 'c.sock');
  let nc;
  let served = false;
  const stop = () => { try { nc?.kill(); } catch { /* gone */ } };
  try { nc = o.spawnImpl(STRANGER, ['-d', '-l', '-U', sock], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return { listened: false }; }
  nc.on('error', () => {});
  // Served: the stranger goes, its socket closes, and the helper exits with it.
  nc.stdout?.on('data', () => { served = true; stop(); });
  if (!await until(() => fs.existsSync(sock), 3000)) { stop(); return { listened: false }; }
  const code = await launch(helper, dir, extra, o);
  stop();
  return { listened: true, served, open: code, out: readOr(path.join(dir, 'out.txt')), err: readOr(path.join(dir, 'err.txt')) };
}

/**
 * listener (code health LS-03 / peer check): the app's own listener and peer check. Boot's launch, held
 * until the stranger has connected and gone: nc connects first (nothing of it may be read, and it may
 * never count as connected), then the helper is launched as the other three are and must get through.
 */
async function listener(helper, dir, { team, createCapture }, o) {
  const sock = path.join(dir, 'c.sock');
  const refusals = [];
  const errors = [];
  const st = { connected: false, permission: null };
  let gone = null; // the stranger, once it's done: { code (null: it had to be stopped), heard, early }
  let opened;      // open's exit code (null at the gate's time), once the launch settles
  let launched = null;
  const cap = createCapture({
    app: helper, socketPath: sock, teamId: team, certRoots: [], connectWaitMs: 60_000, relaunchMs: 60_000, retryMs: [60_000],
    log: (kind, d) => { if (kind === 'capture-peer-refused') refusals.push(String(d?.why ?? '')); },
    onError: e => errors.push(String(e?.message ?? e?.kind ?? 'error')),
    onStatus: (s) => { if (s?.connected === true) st.connected = true; if (typeof s?.permission === 'boolean') st.permission = s.permission; },
    // Boot's launch, once (its arguments are helperArgs on this socket): the stranger first, then the helper.
    spawnOpen: () => {
      launched ??= (async () => {
        let nc;
        let heard = false;
        try { nc = o.spawnImpl(STRANGER, ['-d', '-U', sock], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { gone = { code: null, heard, early: st.connected }; }
        if (nc) {
          nc.on('error', () => {});
          nc.stdout?.on('data', () => { heard = true; });
          const code = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), Math.min(STRANGER_MS, o.timeoutMs));
            nc.on('exit', (c) => { clearTimeout(t); resolve(c ?? -1); });
          });
          if (code === null) { try { nc.kill(); } catch { /* gone */ } }
          gone = { code, heard, early: st.connected };
        }
        opened = await launch(helper, dir, [], o);
        return opened;
      })();
      return null;
    },
  });
  try {
    cap.start();
    // The helper's permission line through the app's check, the launch's end, or the gate's time.
    await until(() => st.permission !== null || opened !== undefined || (!launched && errors.length > 0), o.timeoutMs + STRANGER_MS);
  } finally {
    // Its socket closed, the helper exits (main.swift), and open -W with it.
    cap.stop();
  }
  if (launched) await launched;
  return { gone, refusals, errors, connected: st.connected, handshake: st.permission !== null, err: readOr(path.join(dir, 'err.txt')) };
}

export async function captureGate({ helper, team = null, createCapture = null, timeoutMs = GATE_MS, tmpdir = os.tmpdir(), spawnImpl = spawn } = {}) {
  // Short: a socket's path has 104 bytes at most.
  const root = fs.mkdtempSync(path.join(tmpdir, 'nqa-gate-'));
  const sub = (name) => { const d = path.join(root, name); fs.mkdirSync(d, { mode: 0o700 }); return d; };
  const o = { spawnImpl, timeoutMs };
  const asks = !!team && typeof createCapture === 'function';
  try {
    const [a, b, c, d] = await Promise.all([
      own(helper, sub('own'), o),
      stranger(helper, sub('str'), [], o),
      stranger(helper, sub('aim'), ['--window-name', 'World of Warcraft'], o),
      asks ? listener(helper, sub('lis'), { team, createCapture }, o).catch(e => ({ gone: null, refusals: [], errors: [String(e?.message ?? e)], connected: false, handshake: false, err: '' })) : null,
    ]);
    return {
      handshake: a.handshake,
      strangerRefused: !!b.listened && !b.served && /^NeverQuestAlone Capture: refused: /m.test(b.err),
      argsRefused: !!c.listened && !c.served && jsonLines(c.out).some(ev => ev.kind === 'args_refused'),
      // The other way round: nc, connecting first, closed by the app's listener (it went by itself, nothing
      // reached it, it never counted as connected, and the listener said why); then the helper got through.
      connectRefused: !!d?.gone && d.gone.code !== null && !d.gone.heard && !d.gone.early && d.refusals.length > 0,
      connectAccepted: !!d?.gone && d.connected && d.handshake,
      // What each launch said first, for a failure's report.
      lines: {
        own: firstLine(a.err) ?? (a.open !== null ? null : a.handshake ? 'still running after its socket closed' : 'no answer'),
        stranger: b.listened ? (b.served ? 'served' : firstLine(b.err)) : 'nc did not listen',
        aimed: c.listened ? (c.served ? 'served' : firstLine(c.out) ?? firstLine(c.err)) : 'nc did not listen',
        listener: !asks ? (team ? 'no listener to check' : 'no team: the app checks no peer')
          : !d.gone ? (firstLine(d.errors.join('\n')) ?? 'the helper was never launched')
            : d.gone.code === null ? 'the stranger stayed connected'
              : d.handshake ? (d.refusals[0] ?? null) : (firstLine(d.err) ?? d.refusals.at(-1) ?? 'no answer'),
      },
    };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
}
