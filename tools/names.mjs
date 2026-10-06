// tools/names.mjs (rename spec §4.12): the project's and the product's earlier names, the owner's
// personal handle and the retired gateway's name, for the gate (tests/names_test.mjs). Each is written
// here in ROT13, so no tracked file spells one.
//
// The same gate on what a publish is about to push (open-shell lane 5a: tools/publish-gate.sh, from
// release.yml and docs.yml), where every file is one a visitor gets, so the handle counts in all of them:
//   node tools/names.mjs --dir <dir>    every path and file under dir (.git left out)
//   node tools/names.mjs --stdin        the text on standard input (a commit's message and identity)
// Each hit prints where it is and which name, never the text around it. Exit 1 on a hit, 0 on none, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const rot13 = s => s.replace(/[a-z]/gi, c => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode((c.charCodeAt(0) - b + 13) % 26 + b); });
// ONE separator between the two words of an earlier name, the gate's:
// blanks; one line break, with the next line's comment leader (-- // # ; *); one of _ + . - * ?
// (the last two are glob wildcards); an encoded space; a Unicode space or zero-width mark
// (U+00A0, U+2000-U+200D, U+202F, U+205F, U+2060, U+3000, U+FEFF). A blank line or ". " is two
// separators: never a name.
export const SEP = String.raw`(?:[ \t]+|[ \t]*\r?\n[ \t]*(?:(?:-{2,}|\/{2,}|#+|;+|\*)[ \t]*)?|[_+.\-*?]|%20|&nbsp;|&#160;|&#xa0;|&#32;|&#x20;|[\u00A0\u2000-\u200D\u202F\u205F\u2060\u3000\uFEFF])`;
export const WORDS = { p1: rot13('jbj'), p2: rot13('pynj'), b1: rot13('obarf'), b2: rot13('pbzcnavba') };
export const PROJECT = new RegExp(`${WORDS.p1}${SEP}?${WORDS.p2}`, 'gi');
export const PRODUCT = new RegExp(`${WORDS.b1}${SEP}?${WORDS.b2}`, 'gi');
// The owner's personal GitHub login: no file a player or visitor gets may carry it (update A).
export const HANDLE = new RegExp(rot13('gbzzltrbpb'), 'gi');
// Except as the public repo's owner: the owner moved neverquestalone to his own account (2026-10-05), so the
// login is public there. Its address (<login>/neverquestalone, also .git or \/ as a regex writes it) and an owner
// field naming it (owner: <login>, "owner": "<login>") are masked letter for letter before a scan, so no column
// moves. The login anywhere else is still a hit: a home path, another repo, a bundle id, an email, prose.
export const PUBLIC_HOME = new RegExp(String.raw`(?<![\w.-])${rot13('gbzzltrbpb')}(?=\\?\/neverquestalone(?:\.git)?(?![\w-]|\.\w))|(?<=\bowner["']?[ \t]*:[ \t]*["']?)${rot13('gbzzltrbpb')}(?![\w.-])`, 'gi');
export const maskPublicHome = text => text.replace(PUBLIC_HOME, m => '#'.repeat(m.length));
// "/bones companion on|off" is the check-ins command, not the product.
export const isCommand = (text, at, m) => m === `${WORDS.b1} ${WORDS.b2}` && text[at - 1] === '/';
// Lua and regex spellings like "[Xx][Yy]" fold to plain letters before a scan.
export const fold = t => t.replace(/\[([A-Za-z])([A-Za-z])\]/g, (m, a, b) => (a.toLowerCase() === b.toLowerCase() ? a : m));
const BIN_EXT = /\.(png|jpe?g|gif|webp|avif|ico|icns|tga|blp|woff2?|ttf|otf|zip|gz|dmg|exe|dll|wav|ogg|mp3|mp4|pdf)$/i;
export const isBinary = (file, buf) => BIN_EXT.test(file) || buf.subarray(0, 8000).includes(0);
// What a file is scanned as: UTF-8 text; a binary file as latin1 and as UTF-16LE at both alignments.
// The odd alignment is decoded from a copy: Node 26.4.0 on Apple silicon kills the process (SIGBUS,
// SIGSEGV or SIGTRAP, after the tests passed) when toString('utf16le') reads a view that starts at an
// odd byte offset. Measured over the renamed tree's binaries: 8 crashes in 60 runs of the gate test
// before this, 0 in 60 after (and 0 in 60 runs of the rename codemod's --check). Node 22 (CI) wasn't tried.
export const decodings = (file, buf) => isBinary(file, buf)
  ? [buf.toString('latin1'), buf.toString('utf16le'), Buffer.from(buf.subarray(1)).toString('utf16le')]
  : [buf.toString('utf8')];
export function hits(text) {
  const t = fold(text), out = [];
  for (const [id, re] of [['project', PROJECT], ['product', PRODUCT]])
    for (const m of t.matchAll(re)) if (!(id === 'product' && isCommand(t, m.index, m[0]))) out.push({ id, at: m.index, m: m[0] });
  return out;
}
export const handleHits = text => [...maskPublicHome(text).matchAll(HANDLE)].map(m => ({ id: 'handle', at: m.index, m: m[0] }));
// The retired gateway's name, the build NeverQuestAlone replaced (2026-09-27): history in this repo's notes,
// never in a file a player or visitor gets, the source export's among them (its own guard, with the handle's).
export const RETIRED = new RegExp(`${rot13('bcra')}${SEP}?${rot13('pynj')}`, 'gi');
export const retiredHits = text => [...fold(text).matchAll(RETIRED)].map(m => ({ id: 'retired', at: m.index, m: m[0] }));

/** Every hit in a text or a file: an earlier name, the handle, or the retired gateway's name. → ['project', 'handle', …] */
const idsIn = (texts) => texts.flatMap(t => [...hits(t), ...handleHits(t), ...retiredHits(t)].map(h => h.id));

/** The gate on a folder: each path and file with a hit, and the names it holds (counts only). → ['<file> (<n> × <id>)', …] */
export function scanDir(dir) {
  const out = [];
  const walk = rel => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const f = rel ? `${rel}/${d.name}` : d.name;
      if (d.name === '.git') continue;
      if (d.isDirectory()) { walk(f); continue; }
      if (!d.isFile()) continue;
      const counts = {};
      for (const id of [...idsIn([f]).map(id => `${id} in its path`), ...idsIn(decodings(f, fs.readFileSync(path.join(dir, f))))]) counts[id] = (counts[id] || 0) + 1;
      for (const [id, n] of Object.entries(counts)) out.push(`${f} (${n} × ${id})`);
    }
  };
  walk('');
  return out.sort();
}

const runAsCommand = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (runAsCommand()) {
  const [cmd, dir] = process.argv.slice(2);
  let found = null;
  if (cmd === '--dir' && dir) found = scanDir(dir);
  else if (cmd === '--stdin') found = [...new Set(idsIn([fs.readFileSync(0, 'utf8')]))].map(id => `standard input (${id})`);
  if (!found) { console.error('usage: node tools/names.mjs --dir <dir> | --stdin'); process.exitCode = 2; }
  else {
    for (const f of found) console.log(`names: ${f}`);
    console.log(`names: ${found.length ? `${found.length} hit(s): an earlier name, the personal handle or the retired gateway's name` : 'clean'}`);
    process.exitCode = found.length ? 1 : 0;
  }
}
