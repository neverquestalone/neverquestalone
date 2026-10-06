#!/usr/bin/env node
// The packaged app's memory on Windows, as private bytes (systems critic SY-11). Runs the app's
// `--self-test --show-window` (the settings window shown in the self-test's sandbox for 5 s, then
// closed; the app prints a line at each phase) and samples every process of that executable
// (main, renderer, GPU, utility) about every 250 ms with one PowerShell, summing their
// PrivateMemorySize64. Prints the median and the peak while the window is shown, and with the
// tray alone after it has closed. test.yml's windows-smoke job runs it on the packaged app; the
// Mac figures were taken the same way with phys_footprint (the fix pass for SY-11).
//
//   node scripts/footprint.mjs "dist/win-unpacked/NeverQuestAlone.exe"
//   exit 0 measured · 1 the self-test failed, or a phase has no samples · 2 usage, or not Windows
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resultLine } from './self-test.mjs';

export const SAMPLE_MS = 250;
/** The tray phase starts this long after the window closes, once its renderer has gone. */
export const SETTLE_MS = 1000;
const MB = 1024 * 1024;

// One PowerShell for the whole run: a line "<ms since 1970> <processes> <private bytes>" per sample.
const SAMPLER = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $ps = @(Get-Process -Name $env:NQA_FOOTPRINT_NAME | Where-Object { $_.Path -eq $env:NQA_FOOTPRINT_EXE })
  $sum = 0
  foreach ($p in $ps) { $sum += $p.PrivateMemorySize64 }
  [Console]::Out.WriteLine("$t $($ps.Count) $sum")
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds ${SAMPLE_MS}
}
`;

/** The self-test's phase lines in its stdout: { 'window-shown': at, 'window-closing': at, 'after-close': at }. */
export function phases(stdout) {
  const out = {};
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.startsWith('{"selfTestPhase"')) continue;
    try { const p = JSON.parse(line); if (typeof p.selfTestPhase === 'string' && Number.isFinite(p.at)) out[p.selfTestPhase] = p.at; } catch { /* not one */ }
  }
  return out;
}

/** The sampler's lines → [{ at, count, bytes }]. */
export function samples(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^(\d{12,}) (\d+) (\d+)$/.exec(line.trim());
    if (m) out.push({ at: Number(m[1]), count: Number(m[2]), bytes: Number(m[3]) });
  }
  return out;
}

const mb = n => Math.round((n / MB) * 10) / 10;

/** The samples from..to that saw the app: { samples, medianMB, peakMB, processes }, or null. */
export function summarize(list, from, to) {
  const inside = list.filter(s => s.at >= from && s.at <= to && s.count > 0);
  if (!inside.length) return null;
  const sorted = inside.map(s => s.bytes).sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { samples: inside.length, medianMB: mb(median), peakMB: mb(sorted.at(-1)), processes: Math.max(...inside.map(s => s.count)) };
}

/** Both phases: the window shown (shown..closing) and the tray alone (closing + SETTLE_MS..after-close). */
export function footprint(ph, list) {
  const has = (...k) => k.every(n => Number.isFinite(ph[n]));
  return {
    shown: has('window-shown', 'window-closing') ? summarize(list, ph['window-shown'], ph['window-closing']) : null,
    tray: has('window-closing', 'after-close') ? summarize(list, ph['window-closing'] + SETTLE_MS, ph['after-close']) : null,
  };
}

const line = (what, s) => `footprint: ${what.padEnd(13)} ${s ? `${s.medianMB.toFixed(1)} MB median, ${s.peakMB.toFixed(1)} MB peak (${s.processes} processes, ${s.samples} samples)` : 'no samples'}`;

export async function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`), platform = process.platform, env = process.env } = {}) {
  if (argv.length !== 1 || argv[0].startsWith('-')) { stderr('usage: node scripts/footprint.mjs <NeverQuestAlone.exe>'); return 2; }
  if (platform !== 'win32') { stderr('footprint: Windows only (PrivateMemorySize64 through Get-Process)'); return 2; }
  const exe = path.resolve(argv[0]);
  if (!fs.existsSync(exe)) { stderr(`footprint: no app at ${exe}`); return 2; }
  const powershell = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // -EncodedCommand (UTF-16LE, base64): the script's own quotes never meet the command line's.
  const sampler = spawn(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SAMPLER, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, NQA_FOOTPRINT_EXE: exe, NQA_FOOTPRINT_NAME: path.basename(exe, '.exe') },
  });
  let sampled = '';
  sampler.stdout.on('data', (d) => { sampled += String(d); });
  const up = await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => { if (samples(sampled).length || Date.now() - t0 > 30_000) { clearInterval(tick); resolve(samples(sampled).length > 0); } }, 50);
  });
  if (!up) { sampler.kill(); stderr('footprint: the PowerShell sampler never answered'); return 1; }
  const app = spawn(exe, ['--self-test', '--show-window', '--use-mock-keychain'], { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  app.stdout.on('data', (d) => { out += String(d); });
  app.stderr.on('data', (d) => { err += String(d); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { app.kill(); }, 90_000);
    app.once('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  await new Promise(r => setTimeout(r, SAMPLE_MS * 2));
  sampler.kill();
  const result = resultLine(out);
  const ph = phases(out);
  const fp = footprint(ph, samples(sampled));
  stdout(line('window shown', fp.shown));
  stdout(line('tray only', fp.tray));
  stdout(`footprint: ${JSON.stringify({ metric: 'PrivateMemorySize64', ...fp, selfTest: result?.ok ?? null })}`);
  if (env.GITHUB_STEP_SUMMARY) {
    const row = (what, s) => `| ${what} | ${s ? `${s.medianMB.toFixed(1)} MB` : '-'} | ${s ? `${s.peakMB.toFixed(1)} MB` : '-'} | ${s?.processes ?? '-'} |`;
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, ['### Memory on Windows (private bytes, every process of the app)', '', '| Phase | Median | Peak | Processes |', '|---|---|---|---|', row('Window shown', fp.shown), row('Tray only', fp.tray), ''].join('\n'));
    } catch { /* no summary */ }
  }
  if (result?.ok !== true || code !== 0) {
    stderr(`footprint: the self-test ${result ? `said ok=${result.ok}` : 'printed no result'} (exit ${code})`);
    const tail = `${out}\n${err}`.trim().split(/\r?\n/).slice(-10).join('\n');
    if (tail) stderr(tail);
    return 1;
  }
  if (!fp.shown || !fp.tray) { stderr(`footprint: a phase has no samples (phases seen: ${Object.keys(ph).join(', ') || 'none'})`); return 1; }
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
