#!/usr/bin/env node
// The staged rollout of an update (PRD §11.5: 10%, then 50%, then everyone; audit CV-09): writes
// stagingPercentage into the update feeds (latest.yml, latest-mac.yml) electron-updater reads.
// Each install compares the percentage with its own random staging id, so a bad update reaches that
// share of players only; raising it (or 100) offers it to more, and 0 stops offering it at all.
//
//   node tools/stage-rollout.mjs --percent <0-100> [--sums <SHA*SUMS.txt>]... <latest*.yml> [...]            write
//   node tools/stage-rollout.mjs --percent <0-100> [--sums <SHA*SUMS.txt>]... --dry-run <latest*.yml> [...]  say, write nothing
//
// --sums: a release's checksum files (SHA256SUMS.txt, SHA512SUMS.txt) list the feeds too, so a feed
// this edits gets its line there refreshed, in the format release.yml's sha256sum and sha512sum wrote
// ("<hash>  <name>"; code health AP-10); every other line stays byte for byte. A sums file that doesn't
// list a feed it's given is an error.
//
// release.yml's attest job runs it with the dispatch's `staged` input (25 by default) before the
// checksums, so the bundle's feeds carry it. .github/workflows/rollout.yml raises the newest stable
// release to 100 once it has been out for a day (code health AP-10). To change a published release by
// hand (50, or 0 to pull it): download its latest*.yml and SHA*SUMS.txt, run this on them with --sums,
// and upload them over the old ones (gh release upload --clobber); the players' next update check reads
// the new share. 100 removes the field: everyone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELD = /^stagingPercentage:.*(?:\r?\n|$)/m;

/** A feed's text with the share set: the field replaced or added at the end; 100 removes it. */
export function stageFeed(text, percent) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error(`the percent must be a whole number from 0 to 100, not ${percent}`);
  const body = String(text).replace(FIELD, '');
  if (percent === 100) return body;
  return `${body}${body.endsWith('\n') || !body ? '' : '\n'}stagingPercentage: ${percent}\n`;
}

/** The share a feed sets (0-100), or 100 when it sets none. */
export function stagedPercent(text) {
  const m = String(text).match(/^stagingPercentage:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : 100;
}

const SUM_LINE = /^([0-9a-f]{64}|[0-9a-f]{128})( [ *])(.+?)(\r?)$/;

/**
 * A checksum file's text with the lines for `files` ({ name: bytes }) refreshed: the same algorithm the
 * line's hash length says (64 hex SHA-256, 128 SHA-512), the rest of the line as it was. Returns
 * { text, changed: [names], missing: [names it doesn't list] }.
 */
export function refreshSums(text, files) {
  const listed = new Set();
  const changed = [];
  const out = String(text).split('\n').map((line) => {
    const m = SUM_LINE.exec(line);
    if (!m || !Object.hasOwn(files, m[3])) return line;
    listed.add(m[3]);
    const hash = crypto.createHash(m[1].length === 64 ? 'sha256' : 'sha512').update(files[m[3]]).digest('hex');
    if (hash !== m[1]) changed.push(m[3]);
    return `${hash}${m[2]}${m[3]}${m[4]}`;
  }).join('\n');
  return { text: out, changed, missing: Object.keys(files).filter(n => !listed.has(n)) };
}

export function run(argv, { stdout = s => process.stdout.write(`${s}\n`), stderr = s => process.stderr.write(`${s}\n`) } = {}) {
  const usage = () => { stderr('usage: node tools/stage-rollout.mjs --percent <0-100> [--sums <SHA*SUMS.txt>]... [--dry-run] <latest*.yml> [...]'); return 2; };
  let percent = NaN;
  let dry = false;
  const sums = [], files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--percent' || a === '--sums') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return usage();
      if (a === '--percent') percent = Number(v); else sums.push(v);
    } else if (a === '--dry-run') dry = true;
    else if (a.startsWith('--')) return usage();
    else files.push(a);
  }
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 || !files.length) return usage();
  const next = {};
  for (const f of files) {
    if (!/^latest(?:-[a-z0-9]+)?\.yml$/.test(path.basename(f))) { stderr(`stage-rollout: ${f} is no update feed (latest*.yml)`); return 2; }
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { stderr(`stage-rollout: can't read ${f}: ${e.code || e.message}`); return 1; }
    if (!/^version:\s*\S/m.test(text)) { stderr(`stage-rollout: ${f} has no version: not an update feed`); return 1; }
    const was = stagedPercent(text);
    const what = percent === 100 ? 'offered to every install' : percent === 0 ? 'offered to no install (stopped)' : `offered to ${percent}% of installs`;
    stdout(`${f}: ${what}${was !== percent ? ` (was ${was}%)` : ''}${dry ? ' [dry run: not written]' : ''}`);
    next[f] = { text, staged: stageFeed(text, percent) };
  }
  // The checksum files first (read, refreshed in memory), so a sums file that can't list a feed stops
  // the run before any feed is written.
  const sumsNext = [];
  for (const s of sums) {
    let text;
    try { text = fs.readFileSync(s, 'utf8'); } catch (e) { stderr(`stage-rollout: can't read ${s}: ${e.code || e.message}`); return 1; }
    const r = refreshSums(text, Object.fromEntries(files.map(f => [path.basename(f), Buffer.from(next[f].staged, 'utf8')])));
    if (r.missing.length) { stderr(`stage-rollout: ${s} doesn't list ${r.missing.join(', ')}`); return 1; }
    stdout(`${s}: ${r.changed.length ? `${r.changed.join(', ')} ${dry ? 'would get' : 'gets'} ${r.changed.length === 1 ? 'its new line' : 'their new lines'}` : 'already matches the feeds'}${dry ? ' [dry run: not written]' : ''}`);
    sumsNext.push([s, text, r.text]);
  }
  if (dry) return 0;
  for (const f of files) if (next[f].staged !== next[f].text) fs.writeFileSync(f, next[f].staged);
  for (const [s, text, now] of sumsNext) if (now !== text) fs.writeFileSync(s, now);
  return 0;
}

// Run as a command (not imported): the same file whatever case Windows gives its drive letter.
const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) process.exitCode = run(process.argv.slice(2));
