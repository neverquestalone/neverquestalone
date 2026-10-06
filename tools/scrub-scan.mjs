#!/usr/bin/env node
// The scrub scanner (PRD §15 SL-7 and DB18; gates B3.0 and B6.1; §22 Q8).
// Finds personal and infrastructure details in a tree before anything leaves
// the private repo: every file committed at a ref (HEAD by default; what
// `git archive` would ship, not the working tree), or every file under a
// directory (a release staging folder, an unpacked installer), and with
// --history every blob, every path, commit message and author line reachable
// from any ref.
//
// Two kinds of pattern:
//   built in  Tailscale addresses (100.64/10 and the IPv6 prefix), email
//             addresses (noreply@anthropic.com and reserved example domains
//             are fine), certificate hashes (designated-requirement H"…",
//             CDHash, thumbprints, colon-hex fingerprints) and SSH key
//             fingerprints. None of them names anyone.
//   terms     This project's own hostnames, ssh alias, home paths, bundle-id
//             prefix, names, character and vault paths. They live in a private
//             terms file that is never in the repo (tools/scrub-terms.example.txt
//             shows the format with made-up values): pass --terms <file> or set
//             SCRUB_TERMS=<file>, and in CI pass the text of a secret with
//             --terms-env <VAR>. The scanner reads no terms file by default, so
//             it can go public without naming what it looks for. A term with a
//             \b, or a space between words, also has a joined twin,
//             <pattern>-joined, for the term glued to other letters in text
//             (EX-06).
//
// Nothing is skipped silently. A file that holds the private marker line, or
// the loaded terms themselves, is a terms-file hit wherever the scan reaches
// it. Files over 64 MB are read in overlapping chunks. An Electron asar
// archive (app.asar) is read as the files it holds, each at <archive>/<path>,
// as a folder would be, so a hit names the file inside. Compressed files (and
// binaries under --no-binary, and a --dir scan's .git folders) can't be read;
// they're listed, and --strict makes each one a hit unless the allowlist or
// --unscanned-ok names its path. Inside a binary, compressed bytes (4 KB
// blocks over 7.5 bits a byte) aren't read as text, short runs in them being
// noise; they're counted and listed by file in every mode (code health AP-06).
// A signature region (a PE's certificate table, a Mach-O's code signature) is
// read whatever its entropy, so the signer's lines show in every build (code
// health EX-06 / signature regions).
// A text line with escapes or percent-encoding is also read decoded (EX-06).
// A binary's runs are ASCII, UTF-16LE and UTF-8 (code health EX-06).
//
// Output never contains a matched value: each hit prints where it is (paths
// masked), the pattern's name, the match length and a line id. With an
// "id-key" line in the terms file the id is HMAC-SHA256(key, line), so a
// printed id can't be brute-forced back to a short line; without one it's a
// plain SHA-256. Known-OK lines go in tools/scrub-allow.txt by path, pattern
// and id, so an allowed line that changes shows up again.
//
//   node tools/scrub-scan.mjs [--repo <dir>] [--ref <rev>] [--history]
//   node tools/scrub-scan.mjs --dir <dir>
//     --terms <file> | --terms-env <VAR> | --no-terms    (or SCRUB_TERMS=<file>)
//     --allow <file>          the allowlist (default: next to this script); repeat it to
//                             use several (the default is then used only if named)
//     --strict                unscanned files are hits
//     --unscanned-ok <glob>   with --strict: a path that may stay unscanned (repeatable)
//     --summary   counts only      --json   machine-readable, still redacted
//     --no-binary skip binaries    --list   the pattern names
//   exit 0 clean · 1 hits · 2 usage, git or terms error
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskPublicHome } from './names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ALLOW = path.join(HERE, 'scrub-allow.txt');
export const TERMS_ENV = 'SCRUB_TERMS';
export const TERMS_MARKER = 'scrub-terms: private';
const MARKER_LINE = /^\s*#\s*scrub-terms:\s*private\b/i;
const RESERVED = new Set(['terms-file', 'unscanned', 'id-key']);
export const MAX_FILE = 64 * 1024 * 1024;
export const CHUNK = 16 * 1024 * 1024;
export const OVERLAP = 64 * 1024;
const BATCH_BYTES = 128 * 1024 * 1024;
const MIN_STRING = 6;
const MIN_ID_KEY = 32;

// ---------------------------------------------------------------- patterns

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

// Addresses that name no one: our own trailer, GitHub's ssh user, RFC 2606
// and RFC 6761 names. Anything else that looks like an email is a hit.
const EMAIL_OK = [
  /^noreply@anthropic\.com$/i,
  /^git@github\.com$/i,
  /@(?:[\w-]+\.)*example\.(?:com|org|net)$/i,
  /\.(?:example|invalid|test|localhost)$/i,
];
// "icon@2x.png" and friends are file names, not addresses.
const FILE_TLD = /\.(?:png|jpe?g|gif|svg|webp|ico|tga|blp|wav|ogg|mp3|js|mjs|cjs|ts|json|lua|toc|xml|md|txt|css|html?|zip|exe|dll|so|dylib)$/i;

export function emailOk(value) {
  return FILE_TLD.test(value) || EMAIL_OK.some(re => re.test(value));
}

export const BUILTIN = [
  { name: 'tailscale-ip', what: 'Tailscale IPv4 (100.64/10, the CGNAT range)',
    re: new RegExp(`(?<![\\w.])100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.${OCTET}\\.${OCTET}(?![\\w]|\\.\\d)`, 'g') },
  { name: 'tailscale-ipv6', what: "Tailscale IPv6 (the tailnet's fd7a ULA prefix)",
    re: /(?<![\w:])fd7a:115c:a1e[0](?::[0-9a-f]{0,4}){1,5}/gi },
  { name: 'email', what: 'email addresses other than noreply@anthropic.com and reserved example domains',
    re: /(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,24}(?![\w-])/g,
    keep: m => !emailOk(m) },
  { name: 'cert-hash', what: 'code-signing certificate hashes (H"…", CDHash, thumbprints, colon-hex fingerprints)',
    re: /\bH"[0-9A-Fa-f]{8,}|\b[Cc][Dd][Hh]ash\b[^0-9A-Fa-f\n]{0,12}[0-9A-Fa-f]{8,}|\b(?:[Tt]humbprint|[Ff]ingerprint|[Cc]ert(?:ificate)?[ -](?:root |leaf )?hash)\b[^0-9A-Fa-f\n]{0,16}(?:[0-9A-Fa-f]{2}[: ]?){8,}|(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{2}:){15,31}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:])/g },
  { name: 'ssh-fingerprint', what: 'SSH key fingerprints (SHA256:…)',
    re: /\bSHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])/g },
];

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An ssh alias is usually an ordinary word, so it only counts in host
// contexts: an ssh command line, a host setting, user@alias, an ssh_config
// Host line, a quoted alias on a line about ssh or tunnels, and the
// capitalized alias mid-sentence, as a machine's name ("on the X", "X's").
// Errors never repeat the value: they end up in CI logs.
export function aliasRules(word) {
  if (!/^[\w.-]+$/.test(word)) throw new Error('ssh-alias takes one word (letters, digits, . _ -)');
  const w = escapeRe(word);
  const cap = escapeRe(word[0].toUpperCase() + word.slice(1));
  const q = `['"\`]`;
  const rule = (re, guard) => ({ name: 'ssh-alias', what: 'the ssh alias of a build machine, in host contexts', re, guard });
  return [
    rule(new RegExp(`\\bssh\\b(?:\\s+-{1,2}[\\w-]+(?:[= ](?!${w}\\b)[^\\s'"\`]+)?)*\\s+(?:[\\w.-]+@)?${w}(?![\\w.-])`, 'gi')),
    rule(new RegExp(`\\b(?:host|hostname|sshHost|alias|remote)\\b[^\\n]{0,24}?${q}${w}${q}`, 'gi')),
    rule(new RegExp(`(?<![\\w.-])[\\w.-]+@${w}(?![\\w.-])`, 'gi')),
    rule(new RegExp(`^\\s*Host\\s+(?:\\S+\\s+)*?${w}(?!\\S)`, 'gim')),
    rule(new RegExp(`${q}${w}${q}`, 'gi'), /\b(?:ssh|scp|rsync|tunnel|token|spawn|execFile)/i),
    rule(new RegExp(`(?<=[a-z,;:'’)] )${cap}\\b(?! bar)|\\b${cap}'s\\b`, 'g')),
  ];
}

// V8 says "Invalid regular expression: /<source>/<flags>: <reason>"; keep the reason only.
function regexReason(e, source) {
  const reason = String(e.message).split(': ').pop();
  return reason && !reason.includes(source) && reason.length <= 60 ? reason : 'invalid pattern';
}

// Joined terms (code health EX-06). A term bounded by \b misses the same word
// glued to other letters: a name in "quentinsmith" or "QuentinSmith", a
// character in "MyYzzq" or "yzzq_alt" (\b counts _ as a letter), a full name
// written "quentin.example". So each term with a \b, or with a space between its
// words, gets a twin, "<pattern>-joined": its regex and flags without the \b
// (a lookaround keeps its own), each space or \s also matching ".", "_", "-",
// "+" or nothing. A twin that can't match fewer than JOIN_MIN characters
// matches anywhere. A shorter one is a word ordinary words hold by chance
// ("sequel" holds a 4-letter "quel"), so, as the ssh alias counts only in host
// contexts, it counts only where an identifier joins it (joinShape): written all
// lower-case, all capitals or Capitalized, with an identifier's seam on each
// side: the text's edge, a non-letter (_ too), a letter next to a digit, or a
// camelCase step ("myQuel", "QuelBot", "NQAQuel"). Each alternative at the
// top of a term (through a group that holds all of it, "\b(?:a|bb)\b") is its
// own twin, so a long name and a short nickname on one line keep their own
// rule. A twin counts only on a line its own pattern didn't hit, so nothing
// counts twice, and an allow entry names it like any pattern. Twins read text:
// a file's lines (and their decoded forms), file names and paths, commit and
// tag text. A binary's string runs have no words to join: a run's neighbours
// are whatever bytes lie there, and in 1.4.0's own binaries that meant a twin
// hit in each signed Mach-O (the Developer ID certificate's name, glued to the
// next DER field) and two in Electron's Windows exe (inside Chromium's own
// strings, in .rdata), against none in any text. The ssh alias, context-bound
// already, has none; a term with backreferences isn't split.
export const JOIN_MIN = 5;
export const JOINED = '-joined';
const SPACES = new Set([' ', '\\s', '\\x20', '\\u0020', '[ ]', '[\\s]']);

// A regex source as tokens ({ t, kind }): enough of its syntax to drop a \b, loosen a space and find its shortest match.
function reTokens(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    const rest = src.slice(i);
    let m, kind = 'atom', unwrap = false;
    if ((m = /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|c[A-Za-z]|[pP]\{[^}]*\}|k<[^>]*>|[1-9]\d*|[\s\S])/.exec(rest))) {
      kind = m[0] === '\\b' ? 'boundary' : m[0] === '\\B' ? 'anchor' : /^\\(?:[1-9]|k<)/.test(m[0]) ? 'backref' : 'atom';
    } else if ((m = /^\[\^?(?:\\[\s\S]|[^\]\\])*\]/.exec(rest))) kind = 'atom';
    else if ((m = /^\(\?<?[=!]/.exec(rest))) kind = 'look';
    else if ((m = /^\((?:\?:|\?<[^>]+>|\?[a-z-]*:)?/.exec(rest))) { kind = 'open'; unwrap = !/^\(\?[a-z-]/.test(m[0]); }
    else if ((m = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(rest))) kind = 'quant';
    else if ((m = /^[)|^$]/.exec(rest))) kind = m[0] === ')' ? 'close' : m[0] === '|' ? 'alt' : 'anchor';
    else m = [rest[0]];
    out.push({ t: m[0], kind, unwrap });
    i += m[0].length;
  }
  return out;
}

// The fewest characters tokens match: an atom is 1; \b, anchors, lookarounds and backreferences 0.
function shortest(toks) {
  const stack = [{ alts: [], cur: 0, last: 0, look: false }];
  for (const k of toks) {
    const f = stack.at(-1);
    if (k.kind === 'open' || k.kind === 'look') stack.push({ alts: [], cur: 0, last: 0, look: k.kind === 'look' });
    else if (k.kind === 'close' && stack.length > 1) {
      const g = stack.pop(), p = stack.at(-1), n = g.look ? 0 : Math.min(g.cur, ...g.alts);
      p.cur += n; p.last = n;
    } else if (k.kind === 'alt') { f.alts.push(f.cur); f.cur = f.last = 0; }
    else if (k.kind === 'quant') {
      const n = /^[*?]/.test(k.t) ? 0 : k.t[0] === '+' ? 1 : Number(/\d+/.exec(k.t)[0]);
      f.cur += f.last * (n - 1); f.last *= n;
    } else if (k.kind === 'atom') { f.cur++; f.last = 1; }
    else f.last = 0;
  }
  return Math.min(stack[0].cur, ...stack[0].alts);
}

// The alternatives at the top of tokens, through groups that hold all of it: [{ toks, outer }], outer = a \b around them was dropped.
function alternatives(toks, outer = false) {
  const top = [];
  let depth = 0;
  toks.forEach((k, i) => {
    if (k.kind === 'close') depth--;
    if (depth === 0) top.push(i);
    if (k.kind === 'open' || k.kind === 'look') depth++;
  });
  const bounded = top.some(i => toks[i].kind === 'boundary');
  const rest = top.filter(i => toks[i].kind !== 'boundary');
  if (rest.length === 2 && toks[rest[0]].kind === 'open' && toks[rest[0]].unwrap && toks[rest[1]].kind === 'close') {
    return alternatives(toks.slice(rest[0] + 1, rest[1]), outer || bounded);
  }
  const out = [];
  let from = 0;
  for (const i of [...top.filter(j => toks[j].kind === 'alt'), toks.length]) { out.push({ toks: toks.slice(from, i), outer }); from = i + 1; }
  return out;
}

// One alternative without its \b, its spaces loosened (outside lookarounds): { toks, changed }.
function loosen(toks) {
  const out = [], open = [];
  let changed = false;
  for (let i = 0; i < toks.length; i++) {
    const k = toks[i];
    if (k.kind === 'open' || k.kind === 'look') open.push(k.kind);
    else if (k.kind === 'close') open.pop();
    const look = open.includes('look');
    if (!look && k.kind === 'boundary') { changed = true; continue; }
    if (!look && k.kind === 'atom' && SPACES.has(k.t)) {
      changed = true;
      out.push({ t: '[\\s._+-]', kind: 'atom' }, { t: '*', kind: 'quant' });
      if (toks[i + 1]?.kind === 'quant') i++;
      continue;
    }
    out.push(k);
  }
  return { toks: out, changed };
}

const LETTER = /\p{L}/u, UPPER = /\p{Lu}/u, LOWER = /\p{Ll}/u, DIGIT = /\p{N}/u;
// An identifier's seam between a and b (c follows b): the text's edge, a
// non-letter, a letter next to a digit, a lower-case letter then a capital, or
// capitals then a capital starting a lower-case word ("NQA|Quel").
function seam(a, b, c) {
  if (!a || !b) return true;
  const word = x => LETTER.test(x) || DIGIT.test(x);
  if (!word(a) || !word(b) || DIGIT.test(a) !== DIGIT.test(b)) return true;
  return (LOWER.test(a) && UPPER.test(b)) || (UPPER.test(a) && UPPER.test(b) && !!c && LOWER.test(c));
}

/** A short twin's match counts only as an identifier's part: a word's case (lower, CAPITALS, Capitalized) and a seam on each side. */
export function joinShape(value, text, index) {
  const l = value.replace(/\P{L}/gu, '');
  const cased = l === l.toLowerCase() || l === l.toUpperCase() || (l[0] === l[0].toUpperCase() && l.slice(1) === l.slice(1).toLowerCase());
  const end = index + value.length;
  return cased && seam(text[index - 1], text[index], text[index + 1]) && seam(text[end - 1], text[end], text[end + 1]);
}

/** A term's joined twins: one per top-level alternative that a \b or a space bounded, none when there's nothing to join. */
export function joinTwins(name, source, flags, at = 'terms') {
  const toks = reTokens(source);
  if (toks.some(k => k.kind === 'backref')) return [];
  const twins = [];
  for (const alt of alternatives(toks)) {
    const { toks: t, changed } = loosen(alt.toks);
    const min = shortest(t);
    if ((!changed && !alt.outer) || min === 0) continue;
    let re;
    try { re = new RegExp(t.map(k => k.t).join(''), flags); } catch { continue; }
    twins.push({ name: name + JOINED, what: `a ${name} term joined to other letters or words (${at})`, re, joinOf: name, ...(min < JOIN_MIN ? { keep: joinShape } : {}) });
  }
  return twins;
}

// terms file: "<name> <regex>" (case-insensitive), "<name> /<regex>/<flags>",
// "ssh-alias <word>", and "id-key <32+ characters>". Blank lines and #
// comments are skipped. Errors name the line, never its value. Each regex
// term's joined twins (above) follow the terms, named "<name>-joined".
export function parseTerms(text, file = 'terms') {
  const patterns = [];
  const twins = [];
  let idKey = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    const at = `${file}:${i + 1}`;
    if (!line || line.startsWith('#')) return;
    const m = line.match(/^([a-z][a-z0-9-]*)\s+(.+)$/);
    if (!m) throw new Error(`${at}: expected "<pattern> <regex>"`);
    const [, name, rest] = m;
    if (name === 'id-key') {
      if (idKey) throw new Error(`${at}: a second id-key`);
      if (rest.trim().length < MIN_ID_KEY) throw new Error(`${at}: id-key needs at least ${MIN_ID_KEY} characters`);
      idKey = Buffer.from(rest.trim(), 'utf8');
      return;
    }
    if (RESERVED.has(name) || name.endsWith(JOINED)) throw new Error(`${at}: "${name}" is a reserved pattern name`);
    if (name === 'ssh-alias') {
      try { patterns.push(...aliasRules(rest.trim())); } catch (e) { throw new Error(`${at}: ${e.message}`); }
      return;
    }
    const lit = rest.match(/^\/(.+)\/([dimsuy]*)$/);
    const source = lit ? lit[1] : rest;
    const flags = (lit ? lit[2] : 'i').replace('g', '') + 'g';
    let re;
    try { re = new RegExp(source, flags); } catch (e) { throw new Error(`${at}: bad regex (${regexReason(e, source)})`); }
    patterns.push({ name, what: `a personal term (${at})`, re });
    twins.push(...joinTwins(name, source, flags, at));
  });
  return { patterns: patterns.concat(twins), idKey };
}

// The terms' content digest: a copy is found by content wherever it sits,
// whatever its name, line endings or trailing whitespace.
export const termsDigest = text => crypto.createHash('sha256')
  .update(text.replace(/\r\n?/g, '\n').split('\n').map(l => l.trimEnd()).join('\n').trim()).digest('hex');

// { file } or { text, label }. real is the file's real path, for --dir scans.
export function loadTerms({ file = null, text = null, label = null }) {
  const body = file ? fs.readFileSync(file, 'utf8') : text;
  const name = label || (file ? path.basename(file) : 'terms');
  const t = parseTerms(body, name);
  // A terms file with no patterns is a mistake (a wrong path, an empty secret), not a clean scan.
  if (!t.patterns.length) throw new Error(`${name} defines no patterns`);
  return { ...t, label: name, real: file ? fs.realpathSync(file) : null, digest: termsDigest(body) };
}

// ---------------------------------------------------------------- matching

// A line's id: the first 12 hex of HMAC-SHA256(idKey, trimmed line), or of
// plain SHA-256 when there's no key.
export function lineId(line, idKey = null) {
  const h = idKey ? crypto.createHmac('sha256', idKey) : crypto.createHash('sha256');
  return h.update(line.trim()).digest('hex').slice(0, 12);
}

// keep(value, text, index) may turn a match down; a joined twin's next try then
// starts one character on, so "quelquel" still finds its second "quel".
// The public repo's address and owner field are masked first (tools/names.mjs:
// the owner moved it to his account, 2026-10-05), letter for letter.
function* matches(text, patterns) {
  text = maskPublicHome(text);
  for (const p of patterns) {
    if (p.guard && !p.guard.test(text)) continue;
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text))) {
      if (m[0].length === 0) { p.re.lastIndex++; continue; }
      if (!p.keep || p.keep(m[0], text, m.index)) yield { name: p.name, index: m.index, length: m[0].length, joinOf: p.joinOf };
      else if (p.joinOf) p.re.lastIndex = m.index + 1;
    }
  }
}

// A joined twin's hit where its own pattern hit too says nothing more (EX-06).
const dropJoined = hits => hits.filter(m => !m.joinOf || !hits.some(o => o.name === m.joinOf));

// One hit per pattern per line (the first match), so counts are lines.
export function scanLine(text, patterns) {
  const seen = new Map();
  for (const m of matches(text, patterns)) if (!seen.has(m.name)) seen.set(m.name, m);
  return dropJoined([...seen.values()]);
}

// A line as code or a URL would mean it (audit EX-06): JS/JSON escapes (\uXXXX,
// \u{…}, \xXX, \n and the like, \\) decoded, control characters as spaces,
// then percent-encoded runs (%2F…); null when nothing changes. A term behind
// "\n" or in "%2FUsers%2F…" hides from \b and from a literal separator otherwise.
export function decodeLine(line) {
  if (!/[\\%]/.test(line)) return null;
  const ctl = s => s.replace(/[\x00-\x1f\x7f]/g, ' ');
  let s = line.replace(/\\(u\{[0-9a-fA-F]{1,6}\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[nrtbfv0]|\\)/g, (m, e) => {
    if (e === '\\') return '\\';
    if (e[0] !== 'u' && e[0] !== 'x') return ' ';
    const code = parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16);
    return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? m : ctl(String.fromCodePoint(code));
  });
  s = s.replace(/(?:%[0-9a-fA-F]{2})+/g, seq => { try { return ctl(decodeURIComponent(seq)); } catch { return seq; } });
  return s === line ? null : s;
}

// Each line, and its decoded form when it has escapes: a pattern the line
// itself didn't hit counts once from the decoded form, at the line's id. A
// term behind "\n" is joined to the "n" as written, and itself decoded: the
// term counts, not its twin.
export function scanText(text, { patterns, path: p = '', source = 'tree', idKey = null }) {
  const hits = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const found = scanLine(line, patterns);
    const decoded = decodeLine(line);
    const more = decoded ? scanLine(decoded, patterns).filter(m => !found.some(f => f.name === m.name)) : [];
    for (const m of dropJoined(found.concat(more))) {
      hits.push({ source, kind: 'line', path: p, line: i + 1, col: m.index + 1, pattern: m.name, length: m.length, id: lineId(line, idKey) });
    }
  });
  return hits;
}

// Compressed bytes (code health AP-06): LZMA, deflate, PNG and font data read
// as strings is noise, and over a 112 MB installer it spells a short private
// term by chance in about one Windows build in eight (1.3.1's first release
// run: a 4-letter "character" hit 29 MB into the LZMA payload) and an
// address-shaped run several times in every build (the 1.3.2 installer: 8). So
// a 4 KB block above 7.5 bits per byte is compressed bytes (the installer's
// LZMA blocks measure 7.75 to 8), and a printable run that lies wholly in such
// blocks isn't scanned as text, unless it's 20 characters or longer: random
// bytes don't make one that long (1.1 GB of them: 1.76 M runs of 6-7
// characters, 282 k of 8-11, 5.6 k of 12-15, 106 of 16-19, none longer; the
// 57 address-shaped ones all under 16), while real text in a high-entropy
// block does (an embedded URL, a stored file's name), and stays read. Blocks
// count from the start of what's scanned (a file, an asar member, a 64 MB
// chunk, which starts on a block). The skipped bytes are counted, and listed
// per file in every mode, --strict too. A signature region is never skipped
// (signatureRanges, below).
export const ENTROPY_BLOCK = 4096;
export const ENTROPY_MAX = 7.5;
export const LONG_RUN = 20;

/** Shannon entropy of bytes, in bits per byte (0 to 8). */
export function entropy(buf) {
  if (!buf.length) return 0;
  const counts = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) counts[buf[i]]++;
  let h = 0;
  for (const n of counts) if (n) { const p = n / buf.length; h -= p * Math.log2(p); }
  return h;
}

/** Which ENTROPY_BLOCK-byte blocks of buf (from its start) are compressed bytes: a Uint8Array of 0 and 1. */
export function compressedBlocks(buf) {
  const out = new Uint8Array(Math.ceil(buf.length / ENTROPY_BLOCK));
  for (let b = 0; b < out.length; b++) out[b] = entropy(buf.subarray(b * ENTROPY_BLOCK, (b + 1) * ENTROPY_BLOCK)) > ENTROPY_MAX ? 1 : 0;
  return out;
}

// A run from byte start to end (exclusive) lies wholly in compressed blocks.
function inCompressed(blocks, start, end) {
  for (let b = Math.floor(start / ENTROPY_BLOCK); b <= Math.floor((end - 1) / ENTROPY_BLOCK); b++) if (!blocks[b]) return false;
  return true;
}

// Signature regions (code health EX-06 / signature regions). A signed binary
// carries its signer's certificate: a PE in the certificate table its Security
// data directory names (a file offset and a size), a Mach-O in the code
// signature its LC_CODE_SIGNATURE names (each slice of a fat file has its
// own). The certificate's subject, the signer's public name, sits at the same
// place in every table, but the table doesn't sit at the same place in every
// build, so the 4 KB blocks above cut it differently each time. In 1.4.0's exe
// (its table at 0xEA68E00) the name's two runs (+0x74C, +0x762) lay in a block
// of certificate bytes alone, over 7.5 bits a byte, and were skipped; in
// 1.4.2's (at 0xEA6A600) their block took in 1,536 bytes before the table,
// measured under 7.5, and was read, so the signed release scan failed (release
// run 37155436296) on two lines the build before never showed. So a run with a
// byte in a signature region is read whatever its block's entropy: the
// signer's lines show in every build, and are allowed by id like any line.
// One part stays gated: a Mach-O CodeDirectory's hash slots, a hash of every
// page (16 KB on arm64, 4 KB on x86_64: 384 KB of random bytes in 1.4.1's arm64
// Electron framework alone), which spell short runs by chance as compressed
// bytes do (AP-06's 1.1 GB of random bytes held 57 address-shaped runs). A
// header or signature that doesn't parse (cut short, out of bounds, the wrong
// magic) gives no region, and the gate applies as before; a region only ever
// adds runs to what's read, never takes one away.
const LC_CODE_SIGNATURE = 0x1d;
const CSMAGIC_EMBEDDED_SIGNATURE = 0xfade0cc0;
const CSMAGIC_CODEDIRECTORY = 0xfade0c02;
const MACHO_HEADER = new Map([[0xfeedface, 28], [0xfeedfacf, 32]]); // magic → the header's size
const FAT_MAX = 20; // file(1)'s line: 0xCAFEBABE then 20 or more is a Java class, not a fat file

// n bytes at offset o of a buffer, or of a file ({ fd, size }) read in place: null when they're not all there.
function byteReader(src) {
  const size = Buffer.isBuffer(src) ? src.length : src.size;
  const fits = (o, n) => Number.isSafeInteger(o) && Number.isSafeInteger(n) && o >= 0 && n >= 0 && o + n <= size;
  if (Buffer.isBuffer(src)) return { size, get: (o, n) => (fits(o, n) ? src.subarray(o, o + n) : null) };
  return { size, get: (o, n) => { if (!fits(o, n)) return null; const b = Buffer.alloc(n); return fs.readSync(src.fd, b, 0, n, o) === n ? b : null; } };
}

// A PE's certificate table: [[start, end]], or [] when a header doesn't hold together.
function peRegions(get, size) {
  const lfanew = get(0x3c, 4)?.readUInt32LE(0);
  const coff = lfanew === undefined ? null : get(lfanew, 24); // "PE\0\0", then the COFF file header
  if (!coff || coff.readUInt32LE(0) !== 0x4550) return [];
  const opt = lfanew + 24, optSize = coff.readUInt16LE(20);
  const magic = get(opt, 2)?.readUInt16LE(0);
  const dirs = magic === 0x10b ? 96 : magic === 0x20b ? 112 : 0; // PE32, PE32+: where the data directories start
  if (!dirs || optSize < dirs + 40) return []; // the Security directory, the fifth, lies inside the optional header
  const count = get(opt + dirs - 4, 4)?.readUInt32LE(0);
  const dir = get(opt + dirs + 32, 8);
  if (!dir || !(count > 4)) return [];
  const off = dir.readUInt32LE(0), len = dir.readUInt32LE(4); // a file offset, not an RVA
  const first = len >= 8 && off >= opt + optSize && off + len <= size ? get(off, 8) : null; // the first WIN_CERTIFICATE
  const dwLength = first?.readUInt32LE(0);
  return dwLength >= 8 && dwLength <= len ? [[off, off + len]] : [];
}

// A code signature (a big-endian SuperBlob) at [s, e): the region less each CodeDirectory's hash slots, or null.
function codeSignatureRegions(get, s, e) {
  const head = get(s, 12);
  if (!head || head.readUInt32BE(0) !== CSMAGIC_EMBEDDED_SIGNATURE) return null;
  const len = head.readUInt32BE(4), count = head.readUInt32BE(8);
  if (len < 12 + 8 * count || s + len > e) return null;
  const index = get(s + 12, 8 * count);
  if (!index) return null;
  const holes = [];
  for (let i = 0; i < count; i++) {
    const off = index.readUInt32BE(8 * i + 4);
    const blob = off >= 12 + 8 * count && off + 8 <= len ? get(s + off, 8) : null;
    const blen = blob?.readUInt32BE(4);
    if (!blob || blen < 8 || off + blen > len) return null;
    if (blob.readUInt32BE(0) !== CSMAGIC_CODEDIRECTORY) continue;
    const cd = blen >= 44 ? get(s + off, 44) : null;
    if (!cd) return null;
    // hashOffset is code slot 0's; nSpecialSlots hashes come before it, nCodeSlots after, each hashSize bytes.
    const hashOffset = cd.readUInt32BE(16), special = cd.readUInt32BE(24), slots = cd.readUInt32BE(28), hashSize = cd[36];
    const from = hashOffset - special * hashSize, to = hashOffset + slots * hashSize;
    if (from < 44 || to > blen) return null;
    holes.push([s + off + from, s + off + to]);
  }
  const out = [];
  let at = s;
  for (const [a, b] of holes.sort((x, y) => x[0] - y[0])) { if (a > at) out.push([at, a]); at = Math.max(at, b); }
  if (at < e) out.push([at, e]);
  return out;
}

// A Mach-O at [base, end) (a whole file or a fat file's slice): its code signature's regions, or [].
function machoRegions(get, base, end) {
  const m = get(base, 4);
  if (!m) return [];
  const le = MACHO_HEADER.has(m.readUInt32LE(0));
  const header = MACHO_HEADER.get(le ? m.readUInt32LE(0) : m.readUInt32BE(0));
  if (!header) return [];
  const u32 = o => { const b = get(o, 4); return b ? (le ? b.readUInt32LE(0) : b.readUInt32BE(0)) : null; };
  const ncmds = u32(base + 16), sizeofcmds = u32(base + 20);
  if (ncmds === null || sizeofcmds === null) return [];
  const cmdsEnd = base + header + sizeofcmds;
  if (cmdsEnd > end) return [];
  const out = [];
  for (let p = base + header, i = 0; i < ncmds && p + 8 <= cmdsEnd; i++) {
    const cmd = u32(p), size = u32(p + 4);
    if (size === null || size < 8 || p + size > cmdsEnd) return [];
    if (cmd === LC_CODE_SIGNATURE) {
      const off = size >= 16 ? u32(p + 8) : null, len = size >= 16 ? u32(p + 12) : null; // dataoff, datasize: from the slice's start
      const s = base + off, r = off === null || !len || s < cmdsEnd || s + len > end ? null : codeSignatureRegions(get, s, s + len);
      if (!r) return [];
      out.push(...r);
    }
    p += size;
  }
  return out;
}

// A fat (universal) file: each slice's regions; a slice that doesn't fit in the file gives none.
function fatRegions(get, size) {
  const head = get(0, 8);
  if (!head) return [];
  const wide = head.readUInt32BE(0) === 0xcafebabf, n = head.readUInt32BE(4), w = wide ? 32 : 20; // fat_arch_64 or fat_arch
  if (n === 0 || n >= FAT_MAX) return [];
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = get(8 + i * w, w);
    if (!a) return [];
    const off = wide ? Number(a.readBigUInt64BE(8)) : a.readUInt32BE(8), len = wide ? Number(a.readBigUInt64BE(16)) : a.readUInt32BE(12);
    if (off >= 8 + n * w && off + len <= size) out.push(...machoRegions(get, off, off + len));
  }
  return out;
}

/**
 * A binary's signature regions: sorted, disjoint [start, end) byte ranges (a PE's certificate table, each
 * Mach-O slice's code signature less its CodeDirectories' hash slots), or [] when src is neither or a header
 * doesn't parse. src is a Buffer, or { fd, size } for a file too big to hold. Never throws.
 */
export function signatureRanges(src) {
  try {
    const { size, get } = byteReader(src);
    const m = get(0, 4);
    if (!m) return [];
    const found = m[0] === 0x4d && m[1] === 0x5a ? peRegions(get, size)
      : (m.readUInt32BE(0) | 1) >>> 0 === 0xcafebabf ? fatRegions(get, size)
        : machoRegions(get, 0, size);
    const out = [];
    for (const [s, e] of found.sort((a, b) => a[0] - b[0])) {
      if (e <= s) continue;
      const last = out.at(-1);
      if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
    }
    return out;
  } catch { return []; }
}

// How many of the bytes from start to end (exclusive) lie in signature regions.
const inSignature = (sig, start, end) => sig.reduce((n, [s, e]) => n + Math.max(0, Math.min(end, e) - Math.max(start, s)), 0);

// A well-formed UTF-8 character of 2 to 4 bytes at buf[i], or 0: no overlong
// form, surrogate, code point past U+10FFFF or C1 control (U+0080 to U+009F).
function utf8Len(buf, i) {
  const b = buf[i], c = k => i + k < buf.length && (buf[i + k] & 0xc0) === 0x80;
  if (b >= 0xc2 && b <= 0xdf) return c(1) && !(b === 0xc2 && buf[i + 1] < 0xa0) ? 2 : 0;
  if (b >= 0xe0 && b <= 0xef) return c(1) && c(2) && !(b === 0xe0 && buf[i + 1] < 0xa0) && !(b === 0xed && buf[i + 1] >= 0xa0) ? 3 : 0;
  if (b >= 0xf0 && b <= 0xf4) return c(1) && c(2) && c(3) && !(b === 0xf0 && buf[i + 1] < 0x90) && !(b === 0xf4 && buf[i + 1] >= 0x90) ? 4 : 0;
  return 0;
}

// Printable runs in a binary: build paths and signing details hide in Mach-O,
// PE and asar files. Each is { offset, bytes, chars, text, wide, utf8 }, offset
// and bytes in bytes, chars the run's characters (MIN_STRING and LONG_RUN count
// them):
//   ASCII     printable ASCII;
//   UTF-16LE  the same, two bytes a character (wide);
//   UTF-8     printable ASCII and well-formed multi-byte characters, the runs
//             that hold one (code health EX-06): a term with a letter past
//             ASCII ("ö"), or a short one in curly quotes, is read whole. They
//             come after the others and add to them: an ASCII run inside one
//             is still read on its own, so its hits and ids are as they were,
//             and a hit both find, at one offset, is the ASCII run's.
export function extractStrings(buf, min = MIN_STRING) {
  const out = [];
  const printable = b => (b >= 0x20 && b <= 0x7e) || b === 0x09;
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && printable(buf[i])) { if (start < 0) start = i; continue; }
    if (start >= 0 && i - start >= min) out.push({ offset: start, bytes: i - start, chars: i - start, text: buf.toString('latin1', start, i), wide: false, utf8: false });
    start = -1;
  }
  for (let par = 0; par < 2; par++) {
    let s = -1, chars = [];
    for (let i = par; i <= buf.length; i += 2) {
      const ok = i + 1 < buf.length && printable(buf[i]) && buf[i + 1] === 0;
      if (ok) { if (s < 0) s = i; chars.push(String.fromCharCode(buf[i])); continue; }
      if (s >= 0 && chars.length >= min) out.push({ offset: s, bytes: 2 * chars.length, chars: chars.length, text: chars.join(''), wide: true, utf8: false });
      s = -1; chars = [];
    }
  }
  let s = -1, n = 0, multi = false;
  for (let i = 0; i <= buf.length;) {
    const len = i >= buf.length ? 0 : printable(buf[i]) ? 1 : buf[i] >= 0xc2 ? utf8Len(buf, i) : 0;
    if (len) { if (s < 0) { s = i; n = 0; multi = false; } n++; multi ||= len > 1; i += len; continue; }
    if (s >= 0 && multi && n >= min) out.push({ offset: s, bytes: i - s, chars: n, text: buf.toString('utf8', s, i), wide: false, utf8: true });
    s = -1; i++;
  }
  return out;
}

const isBinary = buf => buf.subarray(0, 8000).includes(0);
const COMPRESSED_EXT = /\.(?:zip|gz|tgz|xz|bz2|7z|zst|dmg|blockmap|appimage|deb|rpm|msi|msix|nupkg|jar)$/i;
const COMPRESSED_MAGIC = [[0x50, 0x4b, 0x03, 0x04], [0x1f, 0x8b], [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], [0x42, 0x5a, 0x68], [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0x28, 0xb5, 0x2f, 0xfd]];
export const isCompressed = (name, buf) => COMPRESSED_EXT.test(name) || COMPRESSED_MAGIC.some(sig => sig.every((b, i) => buf[i] === b));

const newStats = () => ({ files: 0, text: 0, binary: 0, chunked: 0, unscanned: 0, unscannedPaths: [], compressedBytes: 0, compressedRuns: 0, compressedPaths: [] });

// A binary's signature regions (EX-06 / signature regions), counted: the files and bytes read whatever their entropy.
function noteSigned(stats, sig) {
  if (stats && sig.length) {
    stats.signed = (stats.signed || 0) + 1;
    stats.signedBytes = (stats.signedBytes || 0) + sig.reduce((n, [s, e]) => n + e - s, 0);
  }
  return sig;
}

// A file's compressed bytes (bytes of high-entropy blocks) and the short runs
// skipped in them, added to its entry (one per path, a chunked file's chunks summed).
function noteCompressed(stats, rel, bytes, runs) {
  if (!stats || (!bytes && !runs)) return;
  stats.compressedBytes = (stats.compressedBytes || 0) + bytes;
  stats.compressedRuns = (stats.compressedRuns || 0) + runs;
  stats.compressedPaths ??= [];
  const last = stats.compressedPaths.at(-1);
  if (last && last.path === rel) { last.bytes += bytes; last.runs += runs; } else stats.compressedPaths.push({ path: rel, bytes, runs });
}

// A file the scanner couldn't read: counted and listed always, a hit under --strict.
function unscanned(rel, reason, { source = 'tree', strict = false, idKey = null, stats = null }) {
  if (stats) { stats.unscanned++; stats.unscannedPaths.push({ path: rel, reason, source }); }
  return strict ? [{ source, kind: 'file', path: rel, line: 0, col: 0, pattern: 'unscanned', reason, length: 0, id: lineId(rel, idKey) }] : [];
}

function nameHits(rel, { patterns, source = 'tree', idKey = null, nameScanned = false }) {
  if (nameScanned) return [];
  return scanLine(rel, patterns).map(m => ({ source, kind: 'name', path: rel, line: 0, col: m.index + 1, pattern: m.name, length: m.length, id: lineId(rel, idKey) }));
}

/**
 * The files an Electron asar archive holds: [{ path, start, end }] (byte ranges in buf), or null when
 * buf isn't one. The format: a 4-byte size (4), the header's pickle size, then the header pickle
 * (its payload size, the JSON's length, the JSON), whose "files" tree gives each file's offset from
 * the end of the header and its size; files marked unpacked are in app.asar.unpacked, beside it.
 */
export function asarFiles(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) return null;
  const base = 8 + buf.readUInt32LE(4);
  const len = buf.readUInt32LE(12);
  if (16 + len > base || base > buf.length) return null;
  let header;
  try { header = JSON.parse(buf.toString('utf8', 16, 16 + len)); } catch { return null; }
  const out = [];
  let bad = !header?.files;
  const walk = (node, prefix) => {
    for (const [name, e] of Object.entries(node?.files ?? {})) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (e?.files) walk(e, p);
      else if (e && !e.unpacked && e.link == null) {
        const start = base + Number(e.offset), end = start + Number(e.size);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < base || end > buf.length) bad = true;
        else out.push({ path: p, start, end });
      }
    }
  };
  walk(header, '');
  return bad ? null : out; // a header that doesn't fit: read as a binary, as before
}

// Scans one file's bytes. rel is the path printed; the path itself is scanned
// too unless nameScanned. terms = { real, digest } of the loaded terms, and
// real = this file's real path (--dir): a copy of the terms is a terms-file hit.
export function scanBuffer(buf, rel, opts) {
  const { patterns, source = 'tree', binary = true, idKey = null, terms = null, real = null, stats = null } = opts;
  const hits = nameHits(rel, opts);
  // An asar archive: each file it holds, as its own file (a folder's walk).
  const members = /\.asar$/i.test(rel) ? asarFiles(buf) : null;
  if (members) {
    if (stats) stats.archived = (stats.archived || 0) + members.length;
    for (const m of members) hits.push(...scanBuffer(buf.subarray(m.start, m.end), `${rel}/${m.path}`, { ...opts, real: null }));
    return hits;
  }
  if (!isBinary(buf)) {
    const text = buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    const marker = lines.findIndex(l => MARKER_LINE.test(l));
    const same = terms && ((real && terms.real && real === terms.real) || termsDigest(text) === terms.digest);
    if (marker >= 0 || same) {
      const at = Math.max(marker, 0);
      hits.push({ source, kind: 'line', path: rel, line: at + 1, col: 1, pattern: 'terms-file', length: (lines[at] || '').length, id: lineId(lines[at] || '', idKey) });
    }
    if (stats) stats.text++;
    return hits.concat(scanText(text, { patterns, path: rel, source, idKey }));
  }
  if (isCompressed(rel, buf)) return hits.concat(unscanned(rel, 'compressed', opts));
  if (!binary) return hits.concat(unscanned(rel, 'binary (--no-binary)', opts));
  if (terms && real && terms.real && real === terms.real) hits.push({ source, kind: 'file', path: rel, line: 0, col: 0, pattern: 'terms-file', length: 0, id: lineId(rel, idKey) });
  if (stats) stats.binary++;
  return hits.concat(stringHits(buf, 0, rel, opts, { sig: noteSigned(stats, signatureRanges(buf)) }));
}

// The printable runs' hits. A short run wholly in compressed blocks is skipped
// (ENTROPY_MAX, above), a UTF-8 run as any (EX-06): random bytes spell
// multi-byte characters too. The skipped-run count stays the ASCII and UTF-16
// runs' (a UTF-8 run there holds the ASCII runs counted, and bytes no run
// would take), so each file's count reads as it did before UTF-8 runs. countTo:
// the bytes whose blocks and runs this call counts (a chunk's overlap is the
// next chunk's to count). seen: hits already found, by pattern and offset (a
// chunk's overlap, and the UTF-8 run around an ASCII run). sig: the file's
// signature regions, by file offset; a run with a byte in one is read whatever
// its blocks (EX-06 / signature regions), and their bytes aren't counted as
// compressed. Joined twins read text only (above), so a run is scanned without them.
function stringHits(buf, base, rel, { patterns, source = 'tree', idKey = null, stats = null }, { seen = new Set(), countTo = buf.length, sig = [] } = {}) {
  const hits = [];
  const blocks = compressedBlocks(buf);
  const runPatterns = patterns.filter(p => !p.joinOf);
  let skipped = 0;
  for (const s of extractStrings(buf)) {
    if (s.chars < LONG_RUN && inCompressed(blocks, s.offset, s.offset + s.bytes) && !inSignature(sig, base + s.offset, base + s.offset + s.bytes)) {
      if (s.offset < countTo && !s.utf8) skipped++;
      continue;
    }
    for (const m of scanLine(s.text, runPatterns)) {
      const offset = base + s.offset + (s.wide ? m.index * 2 : s.utf8 ? Buffer.byteLength(s.text.slice(0, m.index), 'utf8') : m.index);
      const k = `${m.name}@${offset}`;
      if (seen.has(k)) continue;
      seen.add(k);
      hits.push({ source, kind: 'offset', path: rel, line: -1, offset, col: 0, pattern: m.name, length: m.length, id: lineId(s.text, idKey) });
    }
  }
  let bytes = 0;
  for (let b = 0; b < blocks.length && b * ENTROPY_BLOCK < countTo; b++) {
    if (!blocks[b]) continue;
    const at = base + b * ENTROPY_BLOCK, n = Math.min(ENTROPY_BLOCK, buf.length - b * ENTROPY_BLOCK);
    bytes += n - inSignature(sig, at, at + n);
  }
  noteCompressed(stats, rel, bytes, skipped);
  return hits;
}

// A file too big to hold (over 64 MB: a Node single executable, an Electron
// framework): its printable runs, read in chunks that overlap by 64 KB so no
// match is cut in two. Chunk starts stay even so UTF-16 runs stay aligned.
export function scanLargeFile(file, rel, opts) {
  const { binary = true, stats = null } = opts;
  const hits = nameHits(rel, opts);
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(8000, size));
    fs.readSync(fd, head, 0, head.length, 0);
    if (isCompressed(rel, head)) return hits.concat(unscanned(rel, 'compressed', opts));
    if (!binary && isBinary(head)) return hits.concat(unscanned(rel, 'binary (--no-binary)', opts));
    if (stats) stats.chunked++;
    const seen = new Set();
    // The signature regions, from the headers read in place (a fat file's slices start anywhere in it).
    const sig = noteSigned(stats, signatureRanges({ fd, size }));
    const buf = Buffer.alloc(Math.min(CHUNK + OVERLAP, size));
    for (let at = 0; at < size; at += CHUNK) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK + OVERLAP, size - at), at);
      // Chunks start on a block (CHUNK is a multiple of ENTROPY_BLOCK); each counts its own CHUNK bytes.
      hits.push(...stringHits(buf.subarray(0, n), at, rel, opts, { seen, countTo: Math.min(CHUNK, n), sig }));
    }
    return hits;
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- sources

const git = (repo, args, opts = {}) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'], ...opts });

// A file on disk: symlinks as their target text, big files in chunks.
function scanDiskFile(abs, rel, opts) {
  let st;
  try { st = fs.lstatSync(abs); } catch { return unscanned(rel, 'unreadable', opts); }
  if (st.isSymbolicLink()) return scanBuffer(Buffer.from(fs.readlinkSync(abs)), rel, opts);
  if (!st.isFile()) return nameHits(rel, opts).concat(unscanned(rel, 'not a regular file', opts));
  if (st.size > MAX_FILE) return scanLargeFile(abs, rel, opts);
  return scanBuffer(fs.readFileSync(abs), rel, { ...opts, real: fs.realpathSync(abs) });
}

export function scanDir({ dir, ...opts }) {
  const stats = newStats();
  const o = { ...opts, source: 'tree', stats };
  const hits = [];
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const a = path.join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      // A git folder holds the history, which a copy or a zip of this tree carries along: listed as
      // not scanned (a hit under --strict), never skipped silently (audit EX-06).
      if (e.name === '.git' && e.isDirectory()) { stats.files++; hits.push(...unscanned(r, 'a git folder: its history rides along in a copy or a zip', o)); continue; }
      if (e.isDirectory()) { walk(a, r); continue; }
      stats.files++;
      hits.push(...scanDiskFile(a, r, o));
    }
  };
  walk(dir, '');
  return { hits, stats };
}

function objectInfo(repo, shas) {
  const info = new Map();
  if (!shas.length) return info;
  const out = git(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: shas.join('\n') + '\n' }).toString('utf8');
  for (const l of out.split('\n')) {
    const [sha, type, size] = l.split(' ');
    if (!sha || type === 'missing' || size === undefined) continue;
    info.set(sha, { type, size: Number(size) });
  }
  return info;
}

// Objects through `git cat-file --batch`, in batches of at most 500 objects
// or 128 MB. Callers send only objects up to MAX_FILE.
function* catObjects(repo, items) {
  const batches = [];
  let cur = [], bytes = 0;
  for (const { sha, size } of items) {
    if (cur.length && (cur.length >= 500 || bytes + size > BATCH_BYTES)) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(sha); bytes += size;
  }
  if (cur.length) batches.push(cur);
  for (const shas of batches) {
    const buf = git(repo, ['cat-file', '--batch'], { input: shas.join('\n') + '\n' });
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      const [sha, type, size] = buf.toString('latin1', pos, nl).split(' ');
      if (type === 'missing' || size === undefined) { pos = nl + 1; continue; }
      const n = Number(size);
      yield [sha, { type, buf: buf.subarray(nl + 1, nl + 1 + n) }];
      pos = nl + 1 + n + 1;
    }
  }
}

// A blob over MAX_FILE goes to a private temp file and is read in chunks.
function withBlobFile(repo, sha, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-scan-'));
  try {
    const file = path.join(dir, 'blob');
    const fd = fs.openSync(file, 'w', 0o600);
    try { execFileSync('git', ['-C', repo, 'cat-file', 'blob', sha], { stdio: ['ignore', fd, 'pipe'] }); } finally { fs.closeSync(fd); }
    return fn(file);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Scans blobs; paths maps sha → the paths to report its content under.
function scanBlobs(repo, blobs, paths, opts, tag = () => ({})) {
  const hits = [];
  const small = blobs.filter(b => b.size <= MAX_FILE);
  for (const [sha, o] of catObjects(repo, small)) {
    for (const rel of paths.get(sha)) hits.push(...scanBuffer(o.buf, rel, opts).map(h => ({ ...h, ...tag(sha) })));
  }
  for (const b of blobs.filter(x => x.size > MAX_FILE)) {
    withBlobFile(repo, b.sha, file => {
      for (const rel of paths.get(b.sha)) hits.push(...scanLargeFile(file, rel, opts).map(h => ({ ...h, ...tag(b.sha) })));
    });
  }
  return hits;
}

const checkRef = ref => { if (!ref || ref.startsWith('-')) throw new Error('--ref needs a revision'); return ref; };

// The files committed at ref (HEAD by default), read from git's objects: a
// file changed or deleted on disk is scanned as committed. dirty says the
// working tree differs from what was scanned.
export function scanTree({ repo, ref = 'HEAD', ...opts }) {
  const stats = newStats();
  const o = { ...opts, source: 'tree', stats };
  let commit;
  try { commit = git(repo, ['rev-parse', '--verify', '--quiet', `${checkRef(ref)}^{commit}`]).toString('utf8').trim(); }
  catch { throw new Error(`${ref} is not a commit in this repo`); }
  const entries = git(repo, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean).map(e => {
    const tab = e.indexOf('\t');
    const [mode, type, sha] = e.slice(0, tab).split(' ');
    return { mode, type, sha, path: e.slice(tab + 1) };
  });
  const hits = [];
  const paths = new Map();
  for (const e of entries) {
    stats.files++;
    if (e.type !== 'blob') { hits.push(...nameHits(e.path, o), ...unscanned(e.path, e.type === 'commit' ? 'submodule' : e.type, o)); continue; }
    if (!paths.has(e.sha)) paths.set(e.sha, []);
    paths.get(e.sha).push(e.path);
  }
  const info = objectInfo(repo, [...paths.keys()]);
  hits.push(...scanBlobs(repo, [...paths.keys()].map(sha => ({ sha, size: info.get(sha)?.size ?? 0 })), paths, o));
  let dirty = false;
  try { dirty = git(repo, ['status', '--porcelain', '--untracked-files=no']).toString('utf8').trim() !== '' || commit !== git(repo, ['rev-parse', 'HEAD']).toString('utf8').trim(); } catch { dirty = true; }
  stats.commit = commit;
  stats.dirty = dirty;
  // The paths whose names this scan covered, with their folders.
  const named = new Set();
  for (const e of entries) for (let i = e.path.indexOf('/'); ; i = e.path.indexOf('/', i + 1)) { named.add(i < 0 ? e.path : e.path.slice(0, i)); if (i < 0) break; }
  return { hits, stats, shas: new Set(paths.keys()), paths: named };
}

// Commit and tag objects: the author, committer and tagger lines and the
// message. Signatures and other headers are skipped.
export function scanObjectText(text, { patterns, label, idKey = null }) {
  const hits = [];
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split + 2);
  for (const line of head.split('\n')) {
    const k = line.match(/^(author|committer|tagger) /);
    if (!k) continue;
    for (const m of scanLine(line, patterns)) hits.push({ source: 'commit', kind: 'line', path: `${label} ${k[1]}`, line: 0, col: m.index + 1, pattern: m.name, length: m.length, id: lineId(line, idKey) });
  }
  body.split('\n').forEach((line, i) => {
    for (const m of scanLine(line, patterns)) hits.push({ source: 'commit', kind: 'line', path: `${label} message`, line: i + 1, col: m.index + 1, pattern: m.name, length: m.length, id: lineId(line, idKey) });
  });
  return hits;
}

// Every path any commit ever had, renames split into both names, merges
// against each parent: file names that were renamed away, a second path with
// the same content and the folders along the way are all scanned.
function historyPaths(repo) {
  return git(repo, ['log', '--all', '--format=', '--name-only', '--no-renames', '-m', '-z'])
    .toString('utf8').split('\0').map(s => s.replace(/^\n+/, '')).filter(Boolean);
}

// Every blob, commit and annotated tag reachable from any ref, and every path
// in their history. Blobs whose content the tree scan read (skipShas) and
// paths it named (skipPaths) aren't scanned twice.
export function scanHistory({ repo, skipShas = new Set(), skipPaths = new Set(), ...opts }) {
  const stats = { ...newStats(), commits: 0, tags: 0, blobs: 0, paths: 0 };
  const o = { ...opts, source: 'history', stats };
  const hits = [];
  const listed = git(repo, ['rev-list', '--all', '--objects']).toString('utf8').split('\n').filter(Boolean);
  const firstPath = new Map();
  const names = new Set();
  for (const l of listed) {
    const sp = l.indexOf(' ');
    const sha = sp < 0 ? l : l.slice(0, sp);
    const p = sp < 0 ? '' : l.slice(sp + 1);
    if (p) names.add(p);
    if (!firstPath.has(sha)) firstPath.set(sha, p);
  }
  for (const p of historyPaths(repo)) names.add(p);
  for (const p of [...names].sort()) {
    if (skipPaths.has(p)) continue;
    stats.paths++;
    hits.push(...nameHits(p, o));
  }
  const info = objectInfo(repo, [...firstPath.keys()]);
  const tags = git(repo, ['for-each-ref', '--format=%(objectname) %(objecttype)', 'refs/tags']).toString('utf8').split('\n').filter(l => l.endsWith(' tag')).map(l => l.split(' ')[0]);
  const texts = [...new Set([...[...info].filter(([, v]) => v.type === 'commit' || v.type === 'tag').map(([sha]) => sha), ...tags])];
  for (const [sha, obj] of catObjects(repo, texts.map(sha => ({ sha, size: info.get(sha)?.size ?? 0 })))) {
    stats[obj.type === 'commit' ? 'commits' : 'tags']++;
    hits.push(...scanObjectText(obj.buf.toString('utf8'), { patterns: o.patterns, label: `${obj.type} ${sha.slice(0, 7)}`, idKey: o.idKey }));
  }
  const blobs = [...info].filter(([sha, v]) => v.type === 'blob' && !skipShas.has(sha)).map(([sha, v]) => ({ sha, size: v.size }));
  stats.blobs = blobs.length;
  const paths = new Map(blobs.map(b => [b.sha, [firstPath.get(b.sha) || '(unnamed)']]));
  hits.push(...scanBlobs(repo, blobs, paths, { ...o, nameScanned: true }, sha => ({ blob: sha.slice(0, 7) })));
  return { hits, stats };
}

// ---------------------------------------------------------------- allowlist

const globRe = glob => new RegExp('^' + glob.split(/(\*\*\/|\*\*|\*)/).map(t => t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : escapeRe(t)).join('') + '$');

// "<path-glob> <pattern|*> <id|*>" per line. * matches within a path segment,
// ** across segments, and **/ also matches no folder at all. A commit hit's
// path is "commit" (or "tag").
// label names a second allowlist's lines (an entry's line is "<label>:<n>"; the first list's is n).
export function parseAllow(text, label = null) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const [glob, pattern, id, extra] = line.split(/\s+/);
    if (!id || extra !== undefined) throw new Error(`${label ?? 'scrub-allow'}:${i + 1}: expected "<path> <pattern> <id>"`);
    out.push({ line: label ? `${label}:${i + 1}` : i + 1, glob, re: globRe(glob), pattern, id, used: 0 });
  });
  return out;
}

// --unscanned-ok <glob>: an allow entry for unscanned files only.
export const unscannedOk = (glob, n) => ({ line: `--unscanned-ok #${n}`, glob, re: globRe(glob), pattern: 'unscanned', id: '*', used: 0 });

export function allowedBy(hit, entries) {
  const p = hit.source === 'commit' ? hit.path.split(' ')[0] : hit.path;
  return entries.find(e => e.re.test(p) && (e.pattern === '*' || e.pattern === hit.pattern) && (e.id === '*' || e.id === hit.id)) || null;
}

// ---------------------------------------------------------------- output

// Every match, merged where they overlap, and widened to whole words so a
// mask never leaves half a name showing.
export function maskText(s, patterns) {
  const word = c => /[A-Za-z0-9_]/.test(c || '');
  const spans = [...matches(s, patterns)].map(m => {
    let start = m.index, end = m.index + m.length;
    while (start > 0 && word(s[start - 1]) && word(s[start])) start--;
    while (end < s.length && word(s[end]) && word(s[end - 1])) end++;
    return { start, end, names: [m.name] };
  }).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const sp of spans) {
    const last = merged.at(-1);
    if (last && sp.start < last.end) {
      last.end = Math.max(last.end, sp.end);
      for (const n of sp.names) if (!last.names.includes(n)) last.names.push(n);
    } else merged.push({ ...sp, names: [...sp.names] });
  }
  let out = '', pos = 0;
  for (const m of merged) { out += s.slice(pos, m.start) + `[${m.names.join('+')}]`; pos = m.end; }
  return out + s.slice(pos);
}

export function where(hit, patterns) {
  const p = maskText(hit.path, patterns);
  if (hit.source === 'commit') return hit.line ? `history ${p}:${hit.line}:${hit.col}` : `history ${p}`;
  const pos = hit.kind === 'name' ? `${p} (name)` : hit.kind === 'offset' ? `${p}@0x${hit.offset.toString(16)}` : hit.kind === 'file' ? p : `${p}:${hit.line}:${hit.col}`;
  if (hit.source === 'history') return hit.blob ? `history blob ${hit.blob} ${pos}` : `history ${pos}`;
  return pos;
}

export const formatHit = (hit, patterns) => hit.pattern === 'unscanned'
  ? `${where(hit, patterns)}  unscanned  [not scanned: ${hit.reason}]  id=${hit.id}`
  : `${where(hit, patterns)}  ${hit.pattern}  [redacted, ${hit.length} chars]  id=${hit.id}`;

export function countBy(hits) {
  const c = {};
  for (const h of hits) {
    const k = h.source === 'tree' ? 'tree' : h.source === 'history' ? 'history' : 'commits';
    c[h.pattern] ??= { tree: 0, history: 0, commits: 0 };
    c[h.pattern][k]++;
  }
  return c;
}

// lists: what allowed hits (each allowlist loaded, and --unscanned-ok when given), as printed.
function summaryLines(counts, names, allowedCount, unused, lists) {
  const rows = [['pattern', 'tree', 'history', 'commits']];
  const tot = { tree: 0, history: 0, commits: 0 };
  for (const n of names) {
    const c = counts[n] || { tree: 0, history: 0, commits: 0 };
    rows.push([n, c.tree, c.history, c.commits]);
    for (const k in tot) tot[k] += c[k];
  }
  rows.push(['total', tot.tree, tot.history, tot.commits]);
  const w = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)));
  const out = rows.map(r => r.map((v, i) => i === 0 ? String(v).padEnd(w[i]) : String(v).padStart(w[i] + 2)).join(''));
  out.push(`allowed by ${lists.length ? lists.join(' and ') : 'nothing (no allowlist)'}: ${allowedCount}`);
  if (unused.length) out.push(`unused allow entries (lines): ${unused.map(e => e.line).join(', ')}`);
  return out;
}

// ---------------------------------------------------------------- cli

const sizeOf = n => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

export function parseArgs(argv) {
  const o = { repo: null, ref: 'HEAD', dir: null, history: false, terms: null, termsEnv: null, noTerms: false, allow: [],
    strict: false, unscannedOk: [], summary: false, json: false, binary: true, list: false };
  const need = (i, flag) => { if (i >= argv.length || argv[i].startsWith('--')) throw new Error(`${flag} needs a value`); return argv[i]; };
  let refSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = need(++i, a);
    else if (a === '--ref') { o.ref = checkRef(need(++i, a)); refSet = true; }
    else if (a === '--dir') o.dir = need(++i, a);
    else if (a === '--terms') o.terms = need(++i, a);
    else if (a === '--terms-env') o.termsEnv = need(++i, a);
    else if (a === '--allow') o.allow.push(need(++i, a));
    else if (a === '--unscanned-ok') o.unscannedOk.push(need(++i, a));
    else if (a === '--history') o.history = true;
    else if (a === '--no-terms') o.noTerms = true;
    else if (a === '--strict') o.strict = true;
    else if (a === '--summary') o.summary = true;
    else if (a === '--json') o.json = true;
    else if (a === '--no-binary') o.binary = false;
    else if (a === '--list') o.list = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.dir && o.history) throw new Error('--history reads git objects; it works with --repo, not --dir');
  if (o.dir && o.repo) throw new Error('use --repo or --dir, not both');
  if (o.dir && refSet) throw new Error('--ref works with --repo, not --dir');
  if ([o.terms, o.termsEnv, o.noTerms || null].filter(Boolean).length > 1) throw new Error('use one of --terms, --terms-env and --no-terms');
  if (o.unscannedOk.length && !o.strict) throw new Error('--unscanned-ok works with --strict');
  if (!o.allow.length) o.allow = [DEFAULT_ALLOW];
  return o;
}

// The terms to load: --terms, then --terms-env, then SCRUB_TERMS. There is no
// default file: the gate never runs on the built-ins alone by accident.
export function termsSource(o, env) {
  if (o.noTerms) return null;
  if (o.terms) return { file: o.terms };
  if (o.termsEnv) {
    if (!env[o.termsEnv]) throw new Error(`$${o.termsEnv} is empty or unset, so there are no terms to scan for`);
    return { text: env[o.termsEnv], label: `$${o.termsEnv}` };
  }
  if (env[TERMS_ENV]) return { file: env[TERMS_ENV] };
  throw new Error(`no terms. Pass --terms <file> or set ${TERMS_ENV}=<file> (keep it outside the scanned tree), use --terms-env <VAR> in CI, or --no-terms for the built-in patterns only`);
}

const inside = (child, parent) => { const r = path.relative(parent, child); return !r.startsWith('..') && !path.isAbsolute(r); };

export function run(argv, { stdout = s => process.stdout.write(s + '\n'), stderr = s => process.stderr.write(s + '\n'), env = process.env } = {}) {
  let o, terms = null;
  try { o = parseArgs(argv); } catch (e) { stderr(`scrub-scan: ${e.message}`); return 2; }
  try {
    const src = termsSource(o, env);
    if (src) {
      if (src.file && !fs.statSync(src.file, { throwIfNoEntry: false })?.isFile()) throw new Error(`no terms file at ${path.basename(src.file)} (from ${o.terms ? '--terms' : TERMS_ENV})`);
      terms = loadTerms(src);
    }
  } catch (e) { stderr(`scrub-scan: ${e.message}`); return 2; }
  const patterns = [...BUILTIN, ...(terms ? terms.patterns : [])];
  const idKey = terms?.idKey || null;
  const mask = s => maskText(String(s), patterns);
  const names = [...new Set([...patterns.map(p => p.name), 'terms-file', 'unscanned'])];
  if (o.list) {
    const seen = new Set();
    for (const p of patterns) if (!seen.has(p.name)) { seen.add(p.name); stdout(`${p.name.padEnd(16)} ${p.what}`); }
    stdout(`${'terms-file'.padEnd(16)} a copy of the private terms (its marker line or its content)`);
    stdout(`${'unscanned'.padEnd(16)} with --strict: a file the scanner couldn't read (compressed, --no-binary, a submodule)`);
    return 0;
  }
  let allow = [];
  const lists = [];
  for (const [n, file] of o.allow.entries()) {
    if (!fs.existsSync(file)) continue;
    try { allow = allow.concat(parseAllow(fs.readFileSync(file, 'utf8'), n ? path.basename(file) : null)); } catch (e) { stderr(`scrub-scan: ${e.message}`); return 2; }
    lists.push(file === DEFAULT_ALLOW ? 'tools/scrub-allow.txt' : mask(file));
  }
  allow = allow.concat(o.unscannedOk.map((g, i) => unscannedOk(g, i + 1)));
  if (o.unscannedOk.length) lists.push('--unscanned-ok');

  const common = { patterns, idKey, binary: o.binary, strict: o.strict, terms: terms && { real: terms.real, digest: terms.digest } };
  let hits = [], stats = {}, hstats = null;
  try {
    if (o.dir) {
      if (!fs.statSync(o.dir, { throwIfNoEntry: false })?.isDirectory()) { stderr(`scrub-scan: not a directory: ${mask(o.dir)}`); return 2; }
      const dir = fs.realpathSync(o.dir);
      if (terms?.real && inside(terms.real, dir)) stderr('scrub-scan: note: the terms file is inside the scanned folder, so it is reported like any copy. Keep it outside.');
      ({ hits, stats } = scanDir({ dir, ...common }));
    } else {
      const repo = git(o.repo || process.cwd(), ['rev-parse', '--show-toplevel']).toString('utf8').trim();
      const t = scanTree({ repo, ref: o.ref, ...common });
      hits = t.hits; stats = t.stats;
      if (o.history) {
        const h = scanHistory({ repo, skipShas: t.shas, skipPaths: t.paths, ...common });
        hits = hits.concat(h.hits); hstats = h.stats;
      }
    }
  } catch (e) { stderr(`scrub-scan: ${mask(String(e.stderr || e.message).trim().split('\n')[0])}`); return 2; }

  const shown = [], allowed = [];
  for (const h of hits) {
    const e = allowedBy(h, allow);
    if (e) { e.used++; allowed.push(h); } else shown.push(h);
  }
  const unused = allow.filter(e => e.used === 0);
  const counts = countBy(shown);
  const notScanned = [...stats.unscannedPaths, ...(hstats?.unscannedPaths || [])];
  // Compressed bytes (code health AP-06): never hits, always counted, and listed in every mode.
  const compressed = [...(stats.compressedPaths || []), ...(hstats?.compressedPaths || []).map(c => ({ ...c, history: true }))];
  const compressedBytes = (stats.compressedBytes || 0) + (hstats?.compressedBytes || 0);
  const pub = s => { const { unscannedPaths, compressedPaths = [], ...rest } = s; return { ...rest, unscannedPaths: unscannedPaths.map(u => ({ ...u, path: mask(u.path) })), compressedPaths: compressedPaths.map(c => ({ ...c, path: mask(c.path) })) }; };

  if (o.json) {
    stdout(JSON.stringify({ ok: shown.length === 0, strict: o.strict, stats: pub(stats), history: hstats && pub(hstats), counts, allowed: allowed.length,
      unusedAllow: unused.map(e => e.line), hits: shown.map(h => ({ where: where(h, patterns), pattern: h.pattern, length: h.length, id: h.id, source: h.source, ...(h.reason ? { reason: h.reason } : {}) })) }, null, 1));
    return shown.length ? 1 : 0;
  }
  if (!o.summary) {
    for (const h of shown) stdout(formatHit(h, patterns));
    if (!o.strict) for (const u of notScanned) stdout(`not scanned (${u.reason}): ${u.source === 'history' ? 'history ' : ''}${mask(u.path)}`);
  }
  // Each file's skipped-run count, in every mode (--strict and --summary too), so a jump shows in a log.
  for (const c of compressed) stdout(`compressed bytes, not scanned as text: ${c.history ? 'history ' : ''}${mask(c.path)} (${sizeOf(c.bytes)}, ${c.runs} short runs)`);
  const scanned = o.dir ? `${stats.files} files under ${mask(o.dir)}` : `${stats.files} files at ${o.ref} (${stats.commit.slice(0, 7)})`;
  stdout(`scrub-scan: ${scanned} (${stats.binary} binary read as strings, ${stats.chunked} over 64 MB read in chunks, ${stats.unscanned} not scanned${stats.archived ? `; ${stats.archived} more inside asar archives` : ''})` +
    (hstats ? `; history: ${hstats.commits} commits, ${hstats.tags} tags, ${hstats.blobs} blobs and ${hstats.paths} paths not in the tree (${hstats.unscanned} not scanned)` : ''));
  const compressedRuns = (stats.compressedRuns || 0) + (hstats?.compressedRuns || 0);
  if (compressed.length) stdout(`compressed bytes, not scanned as text: ${sizeOf(compressedBytes)} in ${compressed.length} file${compressed.length === 1 ? '' : 's'}, ${compressedRuns} short runs skipped (blocks over ${ENTROPY_MAX} bits a byte; runs of ${LONG_RUN} characters or more in them are still read)`);
  // Signature regions (code health EX-06 / signature regions): read whatever their entropy, so a jump or a drop shows in a log.
  const signed = (stats.signed || 0) + (hstats?.signed || 0);
  if (signed) stdout(`signature regions, read as text whatever their entropy: ${sizeOf((stats.signedBytes || 0) + (hstats?.signedBytes || 0))} in ${signed} file${signed === 1 ? '' : 's'} (a PE's certificate table, a Mach-O's code signature less its page hashes)`);
  if (stats.dirty) stdout('note: the working tree differs from what was scanned; uncommitted changes are not scanned.');
  if (!o.strict && notScanned.length) stdout(`note: ${notScanned.length} files were not scanned; --strict fails on them.`);
  for (const l of summaryLines(counts, names, allowed.length, unused, lists)) stdout(l);
  stdout(shown.length ? `FAIL: ${shown.length} hits. Values are redacted; id = ${idKey ? 'HMAC-SHA256 with the id-key' : 'SHA-256'} of the line, first 12 hex. Find a blob's commits with: git log --all --find-object=<blob>`
    : 'PASS: no hits.');
  return shown.length ? 1 : 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
