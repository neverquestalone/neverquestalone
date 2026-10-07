#!/usr/bin/env node
// The open shell's boundary (open-shell PRD lane 1). The desktop app and its bridge are becoming two
// parts: the shell, which anyone can build an app on with their own AI key, and the World of Warcraft
// plugin built into it. This names each file's part and lists what still crosses between them.
//
//   node tools/shell-tree.mjs --list    each file's class: shell, plugin or exempt
//   node tools/shell-tree.mjs --check   the violations, one a line; exits 1 when there are any
//
// The violations:
//   (a) a shell file naming a plugin file: in an import, import(), require(), importBridge('…') or any
//       other path string ('./…', '../…', 'bridge/…', 'prompts/…') outside comments;
//   (b) a plugin file importing a network, process, thread or Electron module, or the shell's key
//       store, providers, spend (usage/), ledger or run queue;
//   (c) a shell file naming the game (TERMS: in any case, inside identifiers too, as in findWow), one
//       line a file with its count. NeverQuestAlone and NQA stay: the open project keeps the name.
// (a) and (b) read code (.mjs, .cjs, .js); (c) reads every text file but a lockfile, whose hashes hold
// the words by chance. A test belongs to the part it imports (exempt, then plugin, then shell), so an
// export can take its tests along. Tests aren't checked: a test may spawn processes, wire both parts
// together and name the game in its fixtures.
//
// Until the split lands, tests/shell_boundary_test.mjs holds the check as a ratchet: it passes only
// when the violations equal tests/fixtures/shell-boundary-ledger.json, so a new one fails it, and so
// does a fixed one left in the ledger. Each lane deletes the entries it fixes: lane 3 leaves only the
// capture helpers' entries, and lane 4 empties it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { PLUGIN_ID, identityProblems } from '../bridge/identity.mjs';

/** A path, or a folder when it ends in '/'. A file takes the class of its longest matching entry. */
export const PLUGIN = Object.freeze([
  'bridge/app/', 'bridge/byok/wow.mjs', 'bridge/byok/patchday.mjs', 'bridge/byok/runtime/pack.md', 'prompts/',
  'bridge/transport/savedvars.mjs', 'bridge/transport/luaenc.mjs', 'bridge/transport/slots.mjs',
  'bridge/transport/publisher.mjs', 'bridge/transport/records.mjs', 'bridge/transport/signals.mjs',
  'bridge/service.mjs', // mixed: lane 2c moves its transport host into the shell
  'plugins/', // each plugin's folder (lane 2a: the identities; the WoW plugin's files follow its later lanes)
]);
export const SHELL = Object.freeze(['bridge/', 'app/desktop/']);
export const EXEMPT = Object.freeze(['bridge/nqa.mjs']); // the developer command line, in neither part

/** Rule (b): the modules a plugin never imports (it reaches the world only through the shell)… */
export const PLUGIN_NEVER = Object.freeze(['net', 'http', 'https', 'http2', 'tls', 'dgram', 'child_process', 'worker_threads', 'vm', 'module', 'electron', 'undici']);
/** …and the shell's files it never imports: keys, providers, spend, and the ledger and queue turns run in. */
export const SHELL_ONLY = Object.freeze(['bridge/byok/security/keystore.mjs', 'bridge/byok/providers/', 'bridge/byok/usage/', 'bridge/byok/ledger.mjs', 'bridge/byok/runqueue.mjs']);
/** Rule (c): the game's words. */
export const TERMS = /world ?of ?warcraft|blizzard|wow|(?<!native )addon|savedvariables|flavor|\/bones|\bbones\b/gi;

const CLASSES = { shell: SHELL, plugin: PLUGIN, exempt: EXEMPT };
const matches = (file, p) => (p.endsWith('/') ? file.startsWith(p) : file === p);
const CODE = /\.(?:mjs|cjs|js)$/;
// Comments out and strings kept, in one pass, so a quote in a comment or a '//' in a string can't mislead it.
const TOKEN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g;
// A quoted path, relative to the file ('./x', '../x') or to the repo ('bridge/…', 'prompts/…').
const PATH_STRING = /['"`]((?:\.{1,2}|bridge|prompts)\/[\w./-]*)['"`]/g;
const IMPORT = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]/g;

const code = text => text.replace(TOKEN, t => (t[0] === '/' ? ' ' : t));
const resolve = (file, p) => (p.startsWith('.') ? path.posix.join(path.posix.dirname(file), p) : path.posix.normalize(p));

/** shell, plugin, exempt, or null for a file outside the boundary. */
export function classOf(file) {
  let best = null, len = 0;
  for (const [name, list] of Object.entries(CLASSES)) {
    for (const p of list) if (matches(file, p) && p.length > len) { best = name; len = p.length; }
  }
  return best;
}

/** The repo paths a code file names in its strings (imports included), outside comments. */
function pathsOf(file, text) {
  return [...new Set([...code(text).matchAll(PATH_STRING)].map(m => resolve(file, m[1])))];
}

/** What a code file imports: a module by its bare name (no "node:"), a relative one as a repo path. */
function importsOf(file, text) {
  const specs = [...code(text).matchAll(IMPORT)].map(m => m[1] ?? m[2] ?? m[3]);
  return [...new Set(specs.map(s => (s.startsWith('.') ? resolve(file, s) : s.replace(/^node:/, ''))))];
}

/** A test's class: the first of exempt, plugin and shell it imports a file of, else null. */
function testClass(file, text) {
  const reached = new Set(importsOf(file, text).map(classOf));
  return ['exempt', 'plugin', 'shell'].find(c => reached.has(c)) ?? null;
}

/** Every file in the boundary, with its class. → [[file, class]] */
export function classify(root = ROOT, files = trackedFiles(root)) {
  const classed = files.map(f => [f, f.startsWith('tests/') && CODE.test(f) ? testClass(f, fs.readFileSync(path.join(root, f), 'utf8')) : classOf(f)]);
  return classed.filter(([, c]) => c);
}

/** The violations under root, one line each, sorted. */
export function violations(root = ROOT, files = trackedFiles(root)) {
  const out = [];
  for (const f of files) {
    const cls = classOf(f);
    if (cls !== 'shell' && cls !== 'plugin') continue;
    const buf = fs.readFileSync(path.join(root, f));
    if (buf.includes(0)) continue; // a picture, a font, a built file
    const text = buf.toString('utf8');
    if (cls === 'plugin') {
      if (!CODE.test(f)) continue;
      for (const m of importsOf(f, text)) {
        if (PLUGIN_NEVER.includes(m.split('/')[0]) || SHELL_ONLY.some(p => matches(m, p))) out.push(`(b) ${f} → ${m}`);
      }
      continue;
    }
    if (CODE.test(f)) for (const p of pathsOf(f, text)) if (classOf(p) === 'plugin') out.push(`(a) ${f} → ${p}`);
    const n = f.endsWith('package-lock.json') ? 0 : text.match(TERMS)?.length;
    if (n) out.push(`(c) ${f}: ${n}`);
  }
  return out.sort();
}

function main([cmd, ...args]) {
  if (cmd === '--list') {
    for (const [f, c] of classify()) process.stdout.write(`${c.padEnd(6)} ${f}\n`);
    return 0;
  }
  if (cmd === '--check') {
    const found = violations();
    for (const v of found) process.stdout.write(`${v}\n`);
    return found.length ? 1 : 0;
  }
  if (Object.hasOwn(EXPORT_COMMANDS, cmd)) return EXPORT_COMMANDS[cmd](args);
  process.stderr.write(`usage: node tools/shell-tree.mjs --list | --check | ${Object.keys(EXPORT_COMMANDS).join(' | ')}\n`);
  return 2;
}


// ---------------------------------------------------------------- the export (open-shell PRD lane 5a; the whole product since 2026-10-05)
// The public repo's tree (tommygeoco/neverquestalone): NeverQuestAlone's source, the whole product, with the
// tests that test it, and the pages players read there. Until 2026-10-05 it was to be the shell alone, without
// the World of Warcraft plugin; the owner then asked for the codebase to be open source ("It's part of TOS"), so
// the code that touches the game goes too: the addon, the prompts' source, the game data and quest logic, and
// the files the app writes for the addon. release.yml commits it there, one bot commit a release, only when
// dispatched with export_source; docs.yml publishes the pages alone (--docs-only). test.yml exports it on
// every dispatch and runs its install and npm test, on Linux and Windows.
//
//   node tools/shell-tree.mjs --files               the files the export holds, as it names them
//   node tools/shell-tree.mjs --left                the files it leaves out of tests/, each with why
//   node tools/shell-tree.mjs --out <dir>           writes the export into <dir> (empty or absent)
//   node tools/shell-tree.mjs --docs-only <dir>     writes only the pages docs.yml publishes
//   node tools/shell-tree.mjs --check-export <dir> [--source]
//       checks a tree about to be published, as it is on disk: nothing in it that's never published, and
//       its code closed (nothing imports a file it doesn't hold). With --source (a tree holding source),
//       also that it's the whole product: the addon, the app, the bridge, the prompts and the tests are in
//       it, and the plugin its package.json names is too, with a valid identity (sourceProblems).
//
// What it holds:
// - EXPORT's paths, never NEVER's: the product (the addon, the desktop app, the bridge, the plugins, the
//   prompts' source), its tests, and the tools its build and its tests run. Every other path stays here, each
//   for the reason its list gives: this repo's notes and drafts, the landing page and the brand kit, the
//   signing setup, the release workflows and what publishes the export. This repo's own README, CONTRIBUTING and
//   CHANGELOG stay too: the export writes docs/public's README and CONTRIBUTING in their place, and each
//   release's notes go on its GitHub release.
// - The tests that test it. One that names a file the export doesn't hold (its path, a folder of it, or a
//   file name only such files have) can't run there, so it stays here, with every test file that imports
//   it. A helper goes when a test that goes imports it or npm test runs it, and a data file when a test file
//   that goes names it.
// - Its own package.json and lockfile, .github/workflows/test.yml written from this repo's (publicTestYml),
//   lane 7's .github/workflows/public-build.yml as it is here, the players' pages (tools/public-docs.mjs: the README and the pages it links, LICENSE and images/),
//   CONTRIBUTING.md (docs/public/CONTRIBUTING.md) and the builders' docs (docs/build/ as its docs/, unchanged).
// The shell's boundary above stays this repo's ratchet (tests/shell_boundary_test.mjs, which stays here): it
// no longer decides what's published.

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** What the export takes from this repo: a path, or a folder when it ends in '/'. */
export const EXPORT = Object.freeze([
  // What every checkout has: the editor's, git's and npm's settings, and the bug report form.
  '.github/ISSUE_TEMPLATE/', '.editorconfig', '.gitattributes', '.gitignore', '.npmrc',
  '.github/workflows/public-build.yml', // lane 7: each tag's unsigned build, attested (its only workflow but test.yml)
  // The product: the addon, the desktop app, the bridge it runs (bridge/nqa.mjs, the developer command line,
  // included), the plugins (the WoW plugin's identity and the example's) and the prompts' source; and the wire
  // between the addon and the app, the one spec its code cites most (docs/PROTOCOL.md, where it is here).
  'addon/', 'app/desktop/', 'bridge/', 'plugins/', 'prompts/', 'docs/PROTOCOL.md',
  // Its tests: exportPlan takes the ones that run from what the export holds.
  'tests/',
  // The tools its build runs: the prompt pack (gen-prompts), the addon's zip and the TOC a copy of it gets
  // (package-addon, stamp-toc), the Quality of Life lists and the quest chains with the facts each is made
  // from (qol-quests, quest-chains), and the price table (gen-prices).
  'tools/gen-prompts.mjs', 'tools/package-addon.mjs', 'tools/stamp-toc.mjs', 'tools/qol-quests/', 'tools/quest-chains/', 'tools/gen-prices.mjs',
  // The tools its tests run: the runner and CI's shards, the recorders of the request and game-files
  // recordings the parity test compares with, the strip replay, and the benchmarks (a publish, a typed turn,
  // an idle app).
  'tools/run-tests.mjs', 'tools/test-shard.mjs', 'tools/last-request-fixtures.mjs', 'tools/game-files-fixtures.mjs', 'tools/nqa-replay.mjs',
  'tools/bench-publish.mjs', 'tools/bench-turn.mjs', 'tools/bench-idle.mjs',
  // The checks a release runs, which a fork's release can run too: the build's identity, fuses and
  // signatures, the update's signature, the Mac release gate, the locked versions' age and advisories, the
  // keychain binding's tarball, the SBOM and the staged rollout's feeds. (Not this repo's own workflows'
  // helpers: CI's proof of a commit, the rollout's plan and the weekly Electron check run only here.)
  'tools/check-built-identity.mjs', 'tools/check-fuses.mjs', 'tools/check-signatures.ps1', 'tools/stage-trusted-signing.ps1',
  'tools/check-update-signature.mjs', 'tools/check-release.mjs', 'tools/check-release-age.mjs', 'tools/check-audit.mjs', 'tools/audit-allow.json',
  'tools/locked-tarball.mjs', 'tools/sbom.mjs', 'tools/stage-rollout.mjs',
  // The checks on what goes public, as this repo runs them: the scrub (no terms of its own: the example file
  // shows their format), its allowlists (not the private one: it's about the private terms), the names gate
  // and this file.
  'tools/scrub-scan.mjs', 'tools/scrub-allow.txt', 'tools/scrub-allow-unsigned.txt', 'tools/scrub-terms.example.txt', 'tools/names.mjs', 'tools/shell-tree.mjs',
]);

/**
 * EXPORT's entries for files still to come (none now: tools/quest-chains/ came with the quest chains). The
 * test that every entry matches a tracked file passes over these until they do.
 */
export const AWAITED = Object.freeze([]);

/** Never in the export, whatever EXPORT says, and never in a tree --check-export passes. */
export const NEVER = Object.freeze([
  // This repo's own: its agents' definitions, the landing page (its own package and deploy), the brand kit,
  // and its working notes (the verification log, the hand-off history, the build plan, the release notes'
  // drafts, the outreach drafts and the evidence). The public pages are docs/public's, rewritten to the root,
  // and docs/build's, as its docs/. docs/'s other files (ARCHITECTURE, PROTOCOL, ADDON, MAP, STYLE, …) are
  // references written for this repo's sessions, full of its internal ids: not in EXPORT, though not secret.
  '.claude/', 'site/', 'brand/', 'docs/public/', 'docs/outreach/', 'docs/evidence/', 'docs/byok/', 'docs/release-notes/',
  'docs/VERIFICATION.md', 'docs/PROGRESS.md', 'docs/companion-layout.md',
  // The signing setup; what publishes the export (it reads docs/public and the private scrub terms) and checks
  // its docs from a fresh clone (docs-walkthrough, whose test reads site/); the in-game screenshot experiment
  // (a second addon, docs/SHOT-INGAME.md); and the screenshot parity tool (it renders this repo's integrate
  // branch beside a lane's).
  'tools/signing/', 'tools/public-docs.mjs', 'tools/publish-gate.sh', 'tools/docs-walkthrough.mjs', 'tools/shotproof/',
  'tools/screenshot-parity.mjs', 'tools/screenshot-clock.mjs',
  // The scrub's allowlist for lines that hit a private term but name nothing private: each entry would point
  // a reader at the term, so it stays with the terms.
  'tools/scrub-allow-private.txt',
  '.github/dependabot.yml', // the private repo's Dependabot covers the same actions, and the public ruleset would never merge its pull requests
  // Tests of this repo's own files: the pages' (docs/public), the string lint's (it reads docs/STYLE.md), the
  // proof's, the screenshot parity's and this export's (release.yml, docs.yml and publish-gate.sh); and the shell
  // boundary's ratchet, a count of every file's crossings that only this repo's lanes keep (a contributor's
  // one-word change would fail it there).
  'tests/byok/public_docs_test.mjs', 'tests/string_lint_test.mjs', 'tests/fixtures/style/', 'tests/shotproof_test.mjs',
  'tests/screenshot_parity_test.mjs', 'tests/shell_export_test.mjs', 'tests/shell_boundary_test.mjs', 'tests/fixtures/shell-boundary-ledger.json',
  // The steward (docs/STEWARD.md): this repo's own operations, which watch the public repo from here. Its code reads
  // this repo's issues, Actions logs and secrets' purposes, its baseline names the public repo's guards, its corpus is
  // this repo's history, and its workflows run only here; a fork has no use for any of it.
  'tools/steward/', 'tests/steward_test.mjs', 'tests/fixtures/steward/', 'docs/STEWARD.md',
  '.github/workflows/steward.yml', '.github/workflows/steward-watch.yml',
]);

/** Test files that go although they name a path the export doesn't hold, each with why that's fine. */
export const GOES_ANYWAY = Object.freeze({
  'tests/byok/app_render_test.mjs': 'it compares the app\'s skull with the brand kit\'s only where brand/ is',
  'tests/byok/app_updater_test.mjs': 'it reads release.yml\'s rollout step only where release.yml is',
  'tests/check_built_identity_test.mjs': 'its test of release.yml\'s step skips where release.yml isn\'t',
  'tests/frozen_names_test.mjs': 'it holds release.yml\'s releases repo frozen only where release.yml is',
});

/** The workflows the public repo holds: test.yml, written from this repo's, and lane 7's public build. */
export const PUBLIC_WORKFLOWS = Object.freeze(['.github/workflows/test.yml', '.github/workflows/public-build.yml']);

const inList = (file, list) => list.some(p => matches(file, p));
/** Whether a path, as the public repo names it, must never be published. */
export const neverPublished = f => inList(f, NEVER) || (f.startsWith('.github/workflows/') && !PUBLIC_WORKFLOWS.includes(f));

/**
 * Every file git tracks under root, as repo-relative paths with forward slashes; outside a git checkout
 * (an exported tree before it's a repo), every file but installed and built ones.
 */
export function trackedFiles(root = ROOT) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch {
    const skip = /(^|\/)(node_modules|\.git|dist|\.build[\w-]*|build-public|build)(\/|$)/;
    return walkFiles(root, f => skip.test(f) && f !== 'app/desktop/build' && !f.startsWith('app/desktop/build/'));
  }
}

/** Every file under root, sorted, but a folder skip(path) is true for. */
function walkFiles(root, skip = () => false) {
  const out = [];
  const walk = rel => {
    for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const f = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) { if (!skip(f)) walk(f); } else if (d.isFile()) out.push(f);
    }
  };
  walk('');
  return out.sort();
}

// npm test's file names (tools/run-tests.mjs), and the strings in a code file (a template's text between its ${…}).
const TEST_FILE = /^tests\/(?:[^/]+\/)*[^/]+_test\.m?js$/;
function stringsOf(text) {
  const out = [];
  for (const t of text.match(TOKEN) ?? []) {
    if (t[0] === '/') continue;
    const body = t.slice(1, -1);
    for (const piece of t[0] === '`' ? body.split(/\$\{[^}]*\}/) : [body]) if (piece) out.push(piece);
  }
  return out;
}

/** The repo paths a string may name from a file: './x' and '../x' from its folder, 'a/b' from the root, a bare name as itself. */
const namedPaths = (file, s) => (s.startsWith('./') || s.startsWith('../') ? [path.posix.join(path.posix.dirname(file), s)] : [path.posix.normalize(s)]).map(p => p.replace(/\/$/, ''));

/**
 * The test files package.json's scripts run by name (`node tests/<file>`: npm test's order checks and codec
 * round trip), which go like a test that goes. A missing or unreadable package.json names none.
 */
export function scriptTests(read) {
  let scripts;
  try { scripts = JSON.parse(read('package.json')).scripts ?? {}; } catch { return []; }
  const out = new Set();
  for (const cmd of Object.values(scripts)) {
    for (const words of String(cmd).split('&&').map(c => c.trim().split(/\s+/))) {
      if (words[0] === 'node' && /^tests\/[\w./-]+\.m?js$/.test(words[1] ?? '')) out.add(path.posix.normalize(words[1]));
    }
  }
  return [...out].sort();
}

/**
 * The export's files from this repo's (tracked) files, named as here, and the test files it leaves out
 * with why. → { files, left: Map(file → why) }
 */
export function exportPlan(root = ROOT, tracked = trackedFiles(root), read = f => fs.readFileSync(path.join(root, f), 'utf8')) {
  const taken = tracked.filter(f => inList(f, EXPORT) && !inList(f, NEVER));
  const source = taken.filter(f => !f.startsWith('tests/'));
  const tests = taken.filter(f => f.startsWith('tests/'));
  // What the export holds, as named here (every test counted in, for now), and what only this repo holds.
  const written = ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'HOW-IT-WORKS.md', 'PRIVACY.md', 'SECURITY.md', 'CREDITS.md', 'CONTRIBUTING.md', '.github/workflows/test.yml'];
  const held = new Set([...source, ...tests, ...written, ...tracked.filter(f => f.startsWith('docs/build/'))]);
  const heldNames = new Set([...held].map(f => path.posix.basename(f)));
  const ownNames = new Set(tracked.filter(f => !held.has(f)).map(f => path.posix.basename(f)).filter(n => !heldNames.has(n)));
  const outside = p => {
    const under = tracked.filter(f => f === p || f.startsWith(`${p}/`));
    return under.length > 0 && !under.some(f => held.has(f));
  };
  const left = new Map();
  const codeFiles = tests.filter(f => CODE.test(f));
  for (const f of codeFiles) {
    if (Object.hasOwn(GOES_ANYWAY, f)) continue;
    for (const s of stringsOf(code(read(f)))) {
      const hit = namedPaths(f, s).find(outside) ?? (!s.includes('/') && ownNames.has(s) ? s : null);
      if (hit) { left.set(f, `names ${hit}, which the export doesn't hold`); break; }
    }
  }
  // A test file that imports one left out is left out too; a helper goes only with a test that imports it,
  // or when npm test runs it by name.
  const codeSet = new Set(codeFiles);
  const importsIn = new Map(codeFiles.map(f => [f, relativeImports(f, read(f)).map(d => resolveIn(d, codeSet)).filter(Boolean)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const f of codeFiles) {
      const dep = !left.has(f) && importsIn.get(f).find(d => left.has(d));
      if (dep) { left.set(f, `imports ${dep}`); changed = true; }
    }
  }
  const going = new Set();
  const take = f => { if (going.has(f) || left.has(f)) return; going.add(f); for (const d of importsIn.get(f)) take(d); };
  const run = new Set(scriptTests(read).filter(f => codeSet.has(f)));
  for (const f of codeFiles) if (TEST_FILE.test(f) || run.has(f)) take(f);
  // What a file that goes names: paths (a folder counts from tests/<a>/<b>/ down: naming tests/fixtures/ alone
  // would take every fixture), and bare file names. A bare name picks a file only when no other test file shares
  // it: identity.json or anthropic.json in two folders could sweep a private fixture in (2a critic 2A-01); those
  // need a path.
  const named = new Set(), bare = new Set(), scanned = new Set();
  const scan = () => {
    for (const f of going) {
      if (scanned.has(f) || !CODE.test(f)) continue;
      scanned.add(f);
      for (const s of stringsOf(code(read(f)))) {
        if (!s.includes('/')) { bare.add(s); continue; }
        for (const p of namedPaths(f, s)) named.add(p);
        bare.add(path.posix.basename(s));
      }
    }
  };
  const ancestors = f => { const parts = f.split('/'); const out = []; for (let k = 3; k < parts.length; k++) out.push(parts.slice(0, k).join('/')); return out; };
  const sameName = new Map();
  for (const f of tests) sameName.set(path.posix.basename(f), (sameName.get(path.posix.basename(f)) ?? 0) + 1);
  const isNamed = f => (bare.has(path.posix.basename(f)) && sameName.get(path.posix.basename(f)) === 1) || named.has(f) || ancestors(f).some(a => named.has(a));
  // A helper a test runs or reads by name, never importing it (a child process's script), goes as an import does.
  for (let changed = true; changed;) {
    changed = false;
    scan();
    for (const f of codeFiles) if (!going.has(f) && !left.has(f) && isNamed(f)) { take(f); changed = true; }
  }
  for (const f of codeFiles) if (!going.has(f) && !left.has(f)) left.set(f, 'no test that goes imports it');
  // Data (fixtures, the Lua stub, C and Python helpers): when a code file that goes names it, or a folder of it.
  for (const f of tests.filter(f => !CODE.test(f))) {
    if (isNamed(f)) going.add(f);
    else left.set(f, 'no test that goes names it');
  }
  return { files: [...source, ...going].sort(), left: new Map([...left].sort(([a], [b]) => (a < b ? -1 : 1))) };
}

// Relative specifiers a module loads: import/export … from, import(), require() and createRequire(…)(…),
// and files it reads beside itself through new URL('./x', import.meta.url) (pack.mjs's prompt pack,
// prices.mjs's prices.json), so an export that leaves such a file out fails here, not at run time.
const SPEC_RES = [
  /\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g,
  /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\brequire\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  /\)\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
  // (not inside import(…): a lazy import by URL, like this file's pagesBuilder, is how a tool loads a private
  // helper only when writing, so the export, which doesn't hold it, still loads)
  /(?<!\bimport\(\s*)\bnew URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g,
];

/** The repo paths a code file loads by relative specifiers, resolved (not ones in comments). */
export function relativeImports(file, text) {
  const out = new Set();
  const src = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  for (const re of SPEC_RES) {
    for (const m of src.matchAll(re)) out.add(path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])));
  }
  return [...out];
}

/** The file a specifier loads among held ones (require() may leave the extension off), or undefined. */
const resolveIn = (dep, held) => ['', '.js', '.cjs', '.mjs', '.json', '/index.js'].map(ext => `${dep}${ext}`).find(f => held.has(f));

/** The imports among files that don't resolve to one of them. → [{file, detail}] */
export function openImports(files, read) {
  const held = new Set(files);
  const open = [];
  for (const f of files.filter(f => CODE.test(f))) {
    for (const dep of relativeImports(f, read(f))) {
      if (dep.startsWith('../') || dep.includes('/node_modules/')) continue;
      if (!resolveIn(dep, held)) open.push({ file: f, detail: `imports ${dep}, which the tree doesn't hold` });
    }
  }
  return open;
}

/** The folders a source tree holds the whole product in: none of them may be missing or empty. */
export const PRODUCT = Object.freeze(['addon/', 'app/desktop/', 'bridge/', 'prompts/', 'tests/']);

/**
 * What keeps a source tree from being the whole product, as files on disk: a PRODUCT folder it lacks, or a
 * package.json that names no plugin it holds with a valid identity (bridge/identity.mjs's own checks, so
 * the tree's npm start and its build would refuse it too). → ['problem', …]
 */
export function sourceProblems(dir, files) {
  const problems = PRODUCT.filter(p => !files.some(f => f.startsWith(p))).map(p => `incomplete: no ${p}`);
  let plugin;
  try { ({ plugin } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))); } catch (e) { return [...problems, `incomplete: package.json (${e.code ?? e.message})`]; }
  if (typeof plugin !== 'string' || !PLUGIN_ID.test(plugin)) return [...problems, 'incomplete: package.json names no plugin'];
  let identity;
  try { identity = JSON.parse(fs.readFileSync(path.join(dir, 'plugins', plugin, 'identity.json'), 'utf8')); } catch (e) { return [...problems, `incomplete: plugins/${plugin}/identity.json (${e.code ?? e.message})`]; }
  return [...problems, ...identityProblems(identity).map(p => `incomplete: plugins/${plugin}/identity.json: ${p}`)];
}

/**
 * What's wrong with a tree about to be published (a folder, its files as on disk, .git left out): a file
 * that's never published, an open import, and with source: what keeps it from being the whole product
 * (sourceProblems). → ['problem', …]
 */
export function checkExport(dir, { source = false } = {}) {
  const files = walkFiles(dir, f => f === '.git' || f.endsWith('/.git') || f.split('/').includes('node_modules'));
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const problems = files.filter(neverPublished).map(f => `never published: ${f}`);
  for (const o of openImports(files, read)) problems.push(`open: ${o.file} ${o.detail}`);
  if (source) problems.push(...sourceProblems(dir, files));
  return problems;
}

/** app/desktop/package.json as exported: the exported plugin's identity names it (2a critic 2A-03). */
export function desktopPackage(deskPkg, identity) {
  return { ...deskPkg, ...(identity.name ? { name: identity.name } : {}), ...(identity.productName ? { productName: identity.productName } : {}) };
}

/**
 * The public package.json from this repo's: its own name and author line (LICENSE's two copyright holders),
 * the plugin this repo builds (the whole product: NeverQuestAlone), npm start runs the app, and each script
 * keeps only the commands whose files the tree holds (npm test without the screenshot experiment's order
 * check; a script left with none goes). capture:build stays this repo's: this computer's screen-reading helper,
 * where a run from source looks for it (bridge/capture/build.mjs; systems critic OS-05).
 */
export function publicPackage(pkg, files) {
  const inTree = new Set(files);
  const keep = cmd => {
    const words = cmd.trim().split(/\s+/);
    if (words[0] !== 'node') return cmd.trim();
    if (words[1] === '--test') {
      const flags = words.slice(2).filter(w => w.startsWith('--'));
      const tests = words.slice(2).filter(w => !w.startsWith('--') && inTree.has(w));
      return tests.length ? ['node', '--test', ...flags, ...tests].join(' ') : null;
    }
    // node <script> [args]: kept when the script and every path-like argument are in the tree.
    const paths = words.slice(1).filter(w => /[/.]/.test(w));
    return paths.every(p => inTree.has(p) || files.some(f => f.startsWith(`${p.replace(/\/$/, '')}/`))) ? cmd.trim() : null;
  };
  const filter = s => (s ? s.split('&&').map(keep).filter(Boolean).join(' && ') : '');
  const scripts = Object.fromEntries(Object.entries(pkg.scripts ?? {}).map(([k, v]) => [k, filter(v)]).filter(([, v]) => v));
  const mine = {
    name: 'neverquestalone',
    author: 'chelinho139 and The NeverQuestAlone authors',
    scripts: { start: 'npm --prefix app/desktop start', ...scripts },
  };
  // In the order this repo's has them, without bin (bridge/nqa.mjs runs as node bridge/nqa.mjs) or repository.
  const { bin: _bin, repository: _repo, ...rest } = pkg;
  return { ...Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, Object.hasOwn(mine, k) ? mine[k] : v])), ...mine };
}

/** The lockfile with the public name (its dependencies are the same, so npm ci stays in sync). */
export function publicLock(lock, name = 'neverquestalone') {
  const out = { ...lock, name };
  if (out.packages?.['']) {
    const { bin: _bin, ...rootPkg } = out.packages[''];
    out.packages = { ...out.packages, '': { ...rootPkg, name } };
  }
  return out;
}

// ---------------------------------------------------------------- the public test.yml
/**
 * Jobs the public test.yml leaves out: the plan (it spares this repo's trunks a second run of a commit), the
 * export (that repo is the export), the release dry run (it calls this repo's release.yml), the macOS suite
 * (by hand only) and the weekly drift check (it reads this repo).
 */
export const PRIVATE_JOBS = Object.freeze(['plan', 'public-tree', 'release-dry-run', 'macos', 'export-drift']);
const PATH_TOKEN = /(?<![\w./@$-])((?:\.github|addon|app|bridge|brand|docs|plugins|prompts|site|tests|tools)\/[\w./@-]*)/g;

/** An artifact step's artifact (its with: name), or null. */
const artifactOf = (step, kind) => (new RegExp(`uses: actions/${kind}-artifact@`).test(step) ? /\n {10}name: (\S+)/.exec(step)?.[1] ?? null : null);

/**
 * The public repo's test.yml, from this repo's: on push and pull_request, with no comment, no job above, no
 * step that reads a secret or the scrub terms, runs a script the public package.json hasn't, or names a file
 * this repo tracks and the export doesn't (a test file in a `node --test` list just leaves the list, and the
 * step goes when none is left), and no upload of an artifact no job there downloads: what's built there for
 * looking at (windows-smoke's CI-signed installer) would be built from any pull request's code, under the
 * product's name, on a public page. Throws when what's left still names a secret, an input, a write scope or
 * pull_request_target.
 */
export function publicTestYml(text, { tracked, files, scripts }) {
  const held = new Set(files);
  const outside = p => {
    const under = tracked.filter(f => f === p || f.startsWith(`${p}/`));
    return under.length > 0 && !under.some(f => held.has(f));
  };
  const lines = text.split('\n').filter(l => !/^\s*#/.test(l));
  const top = name => lines.findIndex(l => l.startsWith(`${name}:`));
  const section = name => { const i = top(name); const end = lines.findIndex((l, j) => j > i && /^\S/.test(l)); return lines.slice(i, end < 0 ? lines.length : end); };
  const jobLines = section('jobs').slice(1);
  const jobs = [];
  for (const l of jobLines) { if (/^ {2}[\w-]+:\s*$/.test(l)) jobs.push([l]); else if (jobs.length) jobs.at(-1).push(l); }
  const stepsOf = job => { const at = job.findIndex(l => /^ {4}steps:\s*$/.test(l)); const steps = []; for (const l of at < 0 ? [] : job.slice(at + 1)) { if (/^ {6}- /.test(l)) steps.push([l]); else if (steps.length) steps.at(-1).push(l); } return steps; };
  const downloaded = new Set(jobs.filter(j => !PRIVATE_JOBS.includes(j[0].trim().slice(0, -1))).flatMap(j => stepsOf(j).map(s => artifactOf(s.join('\n'), 'download')).filter(Boolean)));
  const out = [];
  for (const job of jobs) {
    const id = job[0].trim().slice(0, -1);
    if (PRIVATE_JOBS.includes(id)) continue;
    const at = job.findIndex(l => /^ {4}steps:\s*$/.test(l));
    if (at < 0) continue;
    const head = [];
    for (const l of job.slice(1, at)) {
      if (/^ {4}if: .*(inputs\.|needs\.plan|schedule)/.test(l)) continue;
      const needs = /^ {4}needs: (\[?)([^\]]*)\]?\s*$/.exec(l);
      if (needs) {
        const kept = needs[2].split(',').map(s => s.trim()).filter(n => n && !PRIVATE_JOBS.includes(n));
        if (kept.length) head.push(`    needs: ${kept.length > 1 ? `[${kept.join(', ')}]` : kept[0]}`);
        continue;
      }
      head.push(l);
    }
    const kept = [];
    for (let step of stepsOf(job)) {
      let s = step.join('\n');
      if (/secrets\.|SCRUB_TERMS|scrub-terms/.test(s)) continue;
      const upload = artifactOf(s, 'upload');
      if (upload && !downloaded.has(upload)) continue;
      if ([...s.matchAll(/\bnpm run ([\w:-]+)/g)].some(m => !Object.hasOwn(scripts, m[1]))) continue;
      const tokens = [...s.matchAll(PATH_TOKEN)].map(m => m[1].replace(/[.:]+$/, '').replace(/\/$/, ''));
      const gone = tokens.filter(outside);
      if (gone.some(t => !TEST_FILE.test(t))) continue;
      if (gone.length) {
        const lists = tokens.filter(t => TEST_FILE.test(t));
        if (lists.every(t => gone.includes(t))) continue;
        // Each line keeps its indent (a more-indented line in a folded `run: >-` keeps its line break).
        const edited = step.map(l => {
          const indent = /^ */.exec(l)[0];
          const words = l.slice(indent.length).split(/ +/).filter(w => w && !gone.includes(w));
          return words.length ? indent + words.join(' ') : '';
        });
        // A line left with nothing on it goes: in a folded `run: >-` it would end the command.
        step = edited.filter((l, i) => l.trim() !== '' || step[i].trim() === '');
        s = step.join('\n');
      }
      kept.push(s);
    }
    if (!kept.length) continue;
    out.push(job[0], ...head, '    steps:', ...kept.join('\n').split('\n'));
    out.push('');
  }
  const yml = [
    '# The tests, on every push and pull request: written by tools/shell-tree.mjs from the test.yml NeverQuestAlone',
    '# builds with, without its private jobs and without any secret. The token is read-only, and every action is',
    '# pinned to a commit SHA. Change it there, not here: each release rewrites this file.',
    ...section('name'), '',
    'on:', '  push:', '  pull_request:', '',
    // A newer push cancels the older one's run: there's no run by hand there to spare.
    ...section('concurrency').map(l => l.replace(/^( {2}cancel-in-progress:).*$/, '$1 true')), '',
    ...section('permissions'), '',
    'jobs:', ...out,
  ].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n');
  const wrong = [/secrets\./, /inputs\./, /^\s+[\w-]+: write\b/m, /pull_request_target/, /workflow_dispatch/].filter(re => re.test(yml.replace(/^\s*#.*$/gm, '')));
  if (wrong.length) throw new Error(`the public test.yml still has ${wrong.join(', ')}`);
  const ids = new Set([...yml.matchAll(/^ {2}([\w-]+):$/gm)].map(m => m[1]));
  for (const m of yml.matchAll(/^ {4}needs: \[?([^\]\n]*)\]?$/gm)) for (const n of m[1].split(',').map(x => x.trim())) if (!ids.has(n)) throw new Error(`the public test.yml needs ${n}, which it doesn't have`);
  return yml;
}

// ---------------------------------------------------------------- writing it
// The pages' builder reads docs/public/, which stays in this repo, so it's loaded only when a tree is written
// (by URL, so the export, which doesn't hold it, still loads this file).
const pagesBuilder = () => import(new URL('./public-docs.mjs', import.meta.url).href);

function emptyDir(out) {
  if (fs.existsSync(out) && fs.readdirSync(out).length) throw new Error(`${out} isn't empty`);
  fs.mkdirSync(out, { recursive: true });
}
function put(out, name, data, mode) {
  const to = path.join(out, name);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, data);
  if (mode) fs.chmodSync(to, mode & 0o777);
}

/** Writes the pages docs.yml publishes into out (empty or absent). → the names written, sorted */
export async function writeDocs(out, { root = ROOT, live } = {}) {
  emptyDir(out);
  const { buildPublicDocs } = await pagesBuilder();
  return buildPublicDocs(out, root, live).sort();
}

/** Writes the export into out (empty or absent). → the names written, sorted */
export async function writeExport(out, { root = ROOT, live } = {}) {
  emptyDir(out);
  const tracked = trackedFiles(root);
  const { files } = exportPlan(root, tracked);
  const names = [];
  for (const f of files) { put(out, f, fs.readFileSync(path.join(root, f)), fs.statSync(path.join(root, f)).mode); names.push(f); }
  const { buildPublicDocs, stripComments } = await pagesBuilder();
  // The builders' docs: docs/build/ is the public repo's docs/, unchanged (lane 6; site/tools/build-docs.mjs
  // renders the same files into /build/docs/).
  for (const f of tracked.filter(f => f.startsWith('docs/build/'))) {
    const name = `docs/${f.slice('docs/build/'.length)}`;
    put(out, name, fs.readFileSync(path.join(root, f)));
    names.push(name);
  }
  names.push(...buildPublicDocs(out, root, live));
  put(out, 'CONTRIBUTING.md', stripComments(fs.readFileSync(path.join(root, 'docs/public/CONTRIBUTING.md'), 'utf8')));
  const pkg = publicPackage(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')), files);
  put(out, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  // The desktop package carries the exported plugin's name and productName (Electron names an unpackaged run's
  // data folder and single-instance lock after them; 2a critic 2A-03). The export's plugin is this repo's, so
  // they're NeverQuestAlone's: a run from source shares an installed copy's (docs/build/get-started.md says so).
  const desk = 'app/desktop/package.json', idFile = pkg.plugin && `plugins/${pkg.plugin}/identity.json`;
  if (idFile && files.includes(desk) && files.includes(idFile)) {
    const id = JSON.parse(fs.readFileSync(path.join(root, idFile), 'utf8'));
    const deskPkg = JSON.parse(fs.readFileSync(path.join(root, desk), 'utf8'));
    put(out, desk, `${JSON.stringify(desktopPackage(deskPkg, id), null, 2)}\n`);
  }
  put(out, 'package-lock.json', `${JSON.stringify(publicLock(JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'))), null, 2)}\n`);
  put(out, '.github/workflows/test.yml', publicTestYml(fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8'), { tracked, files, scripts: pkg.scripts }));
  names.push('CONTRIBUTING.md', 'package.json', 'package-lock.json', '.github/workflows/test.yml');
  return names.sort();
}

/** The names the export holds, as written (the pages' and docs' too), without writing it. */
async function exportNames(root = ROOT) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'shell-export-'));
  try { return await writeExport(path.join(dir, 'tree'), { root }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const EXPORT_COMMANDS = {
  '--files': async () => { for (const f of await exportNames()) process.stdout.write(`${f}\n`); return 0; },
  '--left': () => { for (const [f, why] of exportPlan().left) process.stdout.write(`${f}: ${why}\n`); return 0; },
  '--out': async ([dir]) => {
    if (!dir) return usage('--out <dir>');
    const n = (await writeExport(path.resolve(dir))).length;
    process.stdout.write(`shell export: ${n} files written to ${dir}\n`);
    return 0;
  },
  '--docs-only': async ([dir]) => {
    if (!dir) return usage('--docs-only <dir>');
    for (const f of await writeDocs(path.resolve(dir))) process.stdout.write(`${f}\n`);
    return 0;
  },
  '--check-export': ([dir, flag]) => {
    if (!dir || (flag && flag !== '--source')) return usage('--check-export <dir> [--source]');
    const problems = checkExport(path.resolve(dir), { source: flag === '--source' });
    for (const p of problems) process.stderr.write(`shell export: ${p}\n`);
    process.stdout.write(`shell export: ${dir}: ${problems.length} problems${flag ? ' (with source)' : ''}\n`);
    return problems.length ? 1 : 0;
  },
};
function usage(what) { process.stderr.write(`usage: node tools/shell-tree.mjs ${what}\n`); return 2; }

// Run as a command only (imported, by a test or node -e with arguments of its own, it does nothing).
const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (runAsCommand()) {
  Promise.resolve(main(process.argv.slice(2))).then(code => { process.exitCode = code; }, e => { process.stderr.write(`shell-tree: ${e.message}\n`); process.exitCode = 1; });
}
