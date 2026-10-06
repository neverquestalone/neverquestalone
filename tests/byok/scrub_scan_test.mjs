// The scrub scanner (tools/scrub-scan.mjs; PRD §15, DB18, gates B3.0 and
// B6.1). Every value here is synthetic, and the ones a scanner would flag are
// built at runtime, so this file itself scans clean. No network: the git
// cases use throwaway repos under os.tmpdir(). The checks against the private
// terms run only when SCRUB_TERMS names the terms file, and say so when they skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN, parseTerms, loadTerms, aliasRules, scanLine, scanText, scanBuffer, scanLargeFile, extractStrings, lineId,
  parseAllow, allowedBy, formatHit, maskText, run, scanDir, TERMS_MARKER, TERMS_ENV, isCompressed, MAX_FILE, CHUNK, asarFiles,
  decodeLine, entropy, compressedBlocks, ENTROPY_BLOCK, LONG_RUN, JOIN_MIN, joinTwins, joinShape, signatureRanges,
} from '../../tools/scrub-scan.mjs';
import { rot13 } from '../../tools/names.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = path.join(ROOT, 'tools', 'scrub-scan.mjs');
const PRIVATE_TERMS = process.env[TERMS_ENV] || null;
const NO_PRIVATE = `${TERMS_ENV} is not set, so the private terms aren't checked here (set ${TERMS_ENV}=<the private terms file> to run it)`;

// Synthetic values, assembled so no literal appears in this file.
const ip = (...o) => o.join('.');
const TS_IP = ip(100, 64, 0, 1);
const TS_IP_TOP = ip(100, 127, 255, 254);
const EMAIL = ['player.one', 'mailhost.dev'].join('@');
const HEX40 = 'ab12'.repeat(10);
const HOST = 'example' + 'forge';
const ID_KEY = 'k'.repeat(40);
const TERMS_BODY = [
  `hostname   ${HOST}(?:-box)?`,
  'home-path  [\\\\/]Users[\\\\/]somebody\\b',
  'bundle-id  com\\.somebody\\.',
  'name       /\\bQuentin\\b/',
  'ssh-alias  tiny',
].join('\n');
const TERMS_TEXT = `# ${TERMS_MARKER}. Synthetic terms for the tests.\n${TERMS_BODY}`;
const { patterns: TERMS } = parseTerms(TERMS_TEXT);
const ALL = [...BUILTIN, ...TERMS];
const names = (line, pats = ALL) => scanLine(line, pats).map(h => h.name).sort();

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-scan-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// The CLI with an empty environment unless a test passes one, so a
// developer's own SCRUB_TERMS never changes a result.
function capture(argv, env = {}) {
  const out = [], err = [];
  const code = run(argv, { stdout: s => out.push(s), stderr: s => err.push(s), env });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

function writeTree(dir, files) {
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

// An empty global config and an empty hooks folder of our own: os.devNull is '\\.\nul' on Windows,
// which Git for Windows can't open as a config file ("unable to access").
const GIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-git-'));
fs.writeFileSync(path.join(GIT_HOME, 'gitconfig'), '');
fs.mkdirSync(path.join(GIT_HOME, 'hooks'));
test.after(() => fs.rmSync(GIT_HOME, { recursive: true, force: true }));
const GIT_ENV = {
  ...process.env, GIT_CONFIG_GLOBAL: path.join(GIT_HOME, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: EMAIL,
};
const g = (repo, ...args) => execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=' + path.join(GIT_HOME, 'hooks'), ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
function newRepo(d, name = 'repo') {
  const repo = path.join(d, name);
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  return repo;
}
const commitAll = (repo, msg) => { g(repo, 'add', '-A'); g(repo, 'commit', '-q', '-m', msg); };

// ------------------------------------------------------------ built-ins

test('tailscale-ip: the whole 100.64/10 range and nothing around it', () => {
  assert.deepEqual(names(`host = ${TS_IP}`), ['tailscale-ip']);
  assert.deepEqual(names(`from="${TS_IP_TOP}",`), ['tailscale-ip']);
  assert.deepEqual(names(`at the end: ${TS_IP}.`), ['tailscale-ip']);
  for (const other of [ip(100, 63, 255, 255), ip(100, 128, 0, 1), ip(10, 0, 0, 1), ip(127, 0, 0, 1), '1' + TS_IP, TS_IP + '.5', ip(100, 64, 300, 1), 'v' + TS_IP]) {
    assert.deepEqual(names(`x ${other} y`), [], other);
  }
});

test('tailscale-ipv6: the tailnet prefix only', () => {
  const v6 = ['fd7a', '115c', 'a1e0', '', '1'].join(':');
  assert.deepEqual(names(`addr ${v6}`), ['tailscale-ipv6']);
  assert.deepEqual(names('addr fd00::1 and fe80::1'), []);
});

test('email: personal addresses flagged; our trailer, git@github and reserved domains are not', () => {
  assert.deepEqual(names(`Author: ${EMAIL}`), ['email']);
  assert.deepEqual(names(`<${['someone+tag', 'users.noreply.github.com'].join('@')}>`), ['email']);
  for (const fine of [['noreply', 'anthropic.com'], ['git', 'github.com'], ['user', 'example.com'], ['a', 'sub.example.org'], ['a', 'box.test'], ['a', 'x.invalid']]) {
    assert.deepEqual(names(`see ${fine.join('@')} here`), [], fine.join('@'));
  }
  assert.deepEqual(names('icon@2x.png, "@napi-rs/keyring": "2.1.0", ws@8.21.3, x@y.z'), []);
});

test('cert-hash and ssh-fingerprint: signing details, not git ids or checksums', () => {
  assert.deepEqual(names(`certificate root = H"${HEX40}"`), ['cert-hash']);
  assert.deepEqual(names(`produced CDHash \`${HEX40.slice(0, 16)}…\``), ['cert-hash']);
  assert.deepEqual(names(`Thumbprint: ${HEX40.toUpperCase()}`), ['cert-hash']);
  assert.deepEqual(names(`SHA1 ${Array(20).fill('3F').join(':')}`), ['cert-hash']);
  assert.deepEqual(names(`key (\`SHA256:${'Ab1+'.repeat(10)}xyz\`, mode 0600)`), ['ssh-fingerprint']);
  // Commit ids, short ids, a MAC address, a package-lock integrity and a bare checksum aren't hits.
  assert.deepEqual(names(`pinned at ${HEX40} (${HEX40.slice(0, 7)}); mac 00:1a:2b:3c:4d:5e; "integrity": "sha512-${'Ab1+'.repeat(20)}=="; sha256 ${'cd'.repeat(32)}`), []);
  // Case matters for H"…": Lua hyperlink code isn't a certificate.
  assert.deepEqual(names(`out:gsub("|H([^|]+)|h", Take) h"${HEX40}"`), []);
});

// ------------------------------------------------------------ terms

test('parseTerms: regex lines, /regex/flags, comments, id-key; errors name the line, never the value', () => {
  assert.deepEqual(names(`on ${HOST}-box now`), ['hostname']);
  assert.deepEqual(names(`on ${HOST.toUpperCase()} now`), ['hostname'], 'bare regexes are case-insensitive');
  assert.deepEqual(names('path C:\\Users\\somebody\\build and /Users/somebody/Dev'), ['home-path']);
  assert.deepEqual(names('label com.somebody.app.capture'), ['bundle-id']);
  assert.deepEqual(names('by Quentin'), ['name']);
  assert.deepEqual(names('by quentin'), [], '/…/ with no i flag is case-sensitive');
  const secret = 'zyxsecret';
  assert.throws(() => parseTerms(`hostname ${secret}(unclosed`, 'terms'), e => /^terms:1: bad regex \(.+\)$/.test(e.message) && !e.message.includes(secret));
  assert.throws(() => parseTerms(`# ok\nssh-alias ${secret} two`, 'terms'), e => /^terms:2: ssh-alias takes one word/.test(e.message) && !e.message.includes(secret));
  assert.throws(() => aliasRules(`${secret} words`), e => !e.message.includes(secret));
  assert.throws(() => parseTerms('# ok\nJustOneWord', 'terms'), /terms:2: expected/);
  assert.throws(() => parseTerms('id-key short', 'terms'), e => /terms:1: id-key needs at least 32/.test(e.message) && !e.message.includes('short'));
  assert.throws(() => parseTerms(`id-key ${ID_KEY}\nid-key ${ID_KEY}`, 'terms'), /terms:2: a second id-key/);
  assert.throws(() => parseTerms('unscanned x', 'terms'), /reserved/);
  const t = parseTerms(`id-key ${ID_KEY}\n${TERMS_BODY}`);
  assert.equal(t.idKey.toString(), ID_KEY);
  assert.equal(t.patterns.length, TERMS.length);
  assert.equal(parseTerms(TERMS_TEXT).idKey, null);
});

test('the public repo on the owner\'s account (moved 2026-10-05): its address and owner field never hit a term; his login anywhere else does', () => {
  const login = rot13('gbzzltrbpb');
  // Shaped like the real terms: a name matching the login's first part, a home path with the login.
  const { patterns } = parseTerms(`name ${login.slice(0, 5)}|\\b${login.slice(5)}\\b\nhome-path [\\\\/]Users[\\\\/]${login}(?![\\w.-])`);
  for (const fine of [`https://github.com/${login}/neverquestalone/releases`, `RELEASES_REPO: ${login}/neverquestalone`, `https://github.com/${login}/neverquestalone.git`,
    `          owner: ${login}`, `"owner": "${login}",`, `/github\\.com\\/${login}\\/neverquestalone\\/blob/`, `the latest release of ${login}/neverquestalone.`]) {
    assert.deepEqual(scanLine(fine, patterns), [], fine);
  }
  for (const leak of [`/Users/${login}/code`, `${login}/another-repo`, `by ${login}`, `${login}/neverquestalone-private`, `${login}.github.io/neverquestalone`]) {
    assert.ok(scanLine(leak, patterns).length, leak);
  }
  const line = `${login}/neverquestalone by ${login}`;
  assert.deepEqual(scanLine(line, patterns).map(h => h.index), [line.lastIndexOf(login)], 'the mask keeps every column');
});

test('ssh-alias: only in host contexts', () => {
  const hit = [
    'the tunnel uses the normal `ssh tiny` alias',
    'ssh -tt tiny \'uptime\'',
    'ssh -o BatchMode=yes -o ConnectTimeout=10 tiny whoami',
    "tunnel: { enabled: true, host: 'tiny', localPort: 1 }",
    "const h = cfg.tunnel.host === 'tiny' ? 'x' : 'y';",
    'gateway.tunnel.host set to player@tiny',
    'Host tiny',
    "spawn('ssh', [...(tty ? ['-tt'] : []), 'tiny', cmd])",
    'it runs on the Tiny, next to the skill',
    "the Tiny's local time",
    '// The companion\'s Tiny scripts',
  ];
  for (const line of hit) assert.deepEqual(names(line), ['ssh-alias'], line);
  const miss = [
    'collapse it to the tiny bar',
    'if ui.tiny then ui.tiny:Show() end',
    'elseif cmd == "tiny" or cmd == "min" then',
    'anchor = "tiny"',
    '-- Tiny bar: what the window shows',
    'Tiny windows are hidden',
    'function U.Minimize(tiny)',
    'tinyurl and tinyfont',
  ];
  for (const line of miss) assert.deepEqual(names(line), [], line);
});

// ------------------------------------------------------------ text, binaries, output

test('scanText: one hit per pattern per line, with line, column and a line id', () => {
  const text = `ok\nssh tiny and ${TS_IP} and ${TS_IP_TOP}\r\nby Quentin\n`;
  const hits = scanText(text, { patterns: ALL, path: 'notes.md' });
  assert.deepEqual(hits.map(h => [h.line, h.pattern]), [[2, 'tailscale-ip'], [2, 'ssh-alias'], [3, 'name']]);
  const ipHit = hits[0];
  assert.equal(ipHit.col, text.split('\n')[1].indexOf(TS_IP) + 1);
  assert.equal(ipHit.length, TS_IP.length);
  assert.equal(ipHit.id, lineId(`ssh tiny and ${TS_IP} and ${TS_IP_TOP}\r`));
  assert.match(ipHit.id, /^[0-9a-f]{12}$/);
});

test('line ids: keyed with the id-key (HMAC), so a short line cannot be looked up', () => {
  const line = `host: 'user@${TS_IP}'`;
  const key = Buffer.from(ID_KEY);
  assert.notEqual(lineId(line, key), lineId(line));
  assert.equal(lineId(line, key), lineId(`  ${line}  `, key), 'trimmed');
  assert.equal(lineId(line, key), execFileSync(process.execPath, ['-e', `process.stdout.write(require('crypto').createHmac('sha256', ${JSON.stringify(ID_KEY)}).update(${JSON.stringify(line)}).digest('hex').slice(0, 12))`]).toString());
  const [h] = scanText(line, { patterns: ALL, path: 'x.md', idKey: key });
  assert.equal(h.id, lineId(line, key));
});

test('formatHit and maskText never print the value', () => {
  const line = `mail ${EMAIL} via ${TS_IP}`;
  const hits = scanText(line, { patterns: ALL, path: `docs/${HOST}-notes.md` });
  const printed = hits.map(h => formatHit(h, ALL)).join('\n');
  assert.equal(hits.length, 2);
  assert.ok(!printed.includes(EMAIL) && !printed.includes(TS_IP) && !printed.includes(HOST), printed);
  assert.match(printed, /docs\/\[hostname\]-notes\.md:1:\d+ {2}email {2}\[redacted, \d+ chars\] {2}id=[0-9a-f]{12}/);
  assert.equal(maskText(`a ${TS_IP} b ${EMAIL}`, ALL), 'a [tailscale-ip] b [email]');
});

test('maskText: overlapping matches merge into one label, and a mask never leaves half a word', () => {
  const pats = parseTerms([
    'home-path  [\\\\/]Users[\\\\/]quentinsmith(?![\\w.-])',
    'bundle-id  com\\.quentinsmith\\.',
    'name       quentin',
  ].join('\n')).patterns;
  const surname = 'smith';
  for (const [input, want] of [
    ['bridge/com.quentinsmith.app.plist', 'bridge/[bundle-id+name]app.plist'],
    ['/Users/quentinsmith/Dev/x', '[home-path+name]/Dev/x'],
    ['notes/quentinsmith-todo.md', 'notes/[name]-todo.md'],
    ['a quentin b', 'a [name] b'],
  ]) {
    const got = maskText(input, pats);
    assert.equal(got, want, input);
    assert.ok(!got.includes(surname), got);
  }
  const hit = { source: 'tree', kind: 'name', path: 'cfg/com.quentinsmith.app.plist', line: 0, col: 1, pattern: 'bundle-id', length: 17, id: 'x' };
  assert.ok(!formatHit(hit, pats).includes(surname));
});

test('binaries: ASCII and UTF-16LE strings are scanned; compressed files are listed, and hits with --strict', () => {
  const macho = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]),
    Buffer.from('/Users/somebody/build/capture.o\0', 'latin1'),
    Buffer.from([1, 2, 3, 0]),
    Buffer.from(`C:\\Users\\somebody\\x\0`, 'utf16le'),
  ]);
  const strings = extractStrings(macho).map(s => s.text);
  assert.ok(strings.includes('/Users/somebody/build/capture.o'));
  assert.ok(strings.some(s => s.startsWith('C:\\Users\\somebody')), 'UTF-16LE run found');
  const stats = { files: 0, text: 0, binary: 0, chunked: 0, unscanned: 0, unscannedPaths: [] };
  const hits = scanBuffer(macho, 'helper', { patterns: ALL, stats });
  assert.equal(hits.length, 2);
  assert.ok(hits.every(h => h.pattern === 'home-path' && h.line === -1 && h.offset >= 8));
  const wide = hits.find(h => h.offset > 40);
  assert.equal(macho.toString('utf16le', wide.offset, wide.offset + 2 * wide.length), 'C:\\Users\\somebody'.slice(2), 'UTF-16 offsets are in bytes');
  assert.match(formatHit(hits[0], ALL), /^helper@0x[0-9a-f]+ {2}home-path/);
  assert.equal(stats.binary, 1);
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), Buffer.from('/Users/somebody/x')]);
  assert.ok(isCompressed('a.bin', zip) && isCompressed('app.dmg', Buffer.from([0])));
  assert.deepEqual(scanBuffer(zip, 'a.bin', { patterns: ALL, stats }), []);
  assert.deepEqual(scanBuffer(macho, 'helper', { patterns: ALL, binary: false, stats }), []);
  assert.equal(stats.unscanned, 2);
  assert.deepEqual(stats.unscannedPaths.map(u => u.reason), ['compressed', 'binary (--no-binary)']);
  const strict = scanBuffer(zip, 'a.bin', { patterns: ALL, strict: true });
  assert.deepEqual(strict.map(h => [h.pattern, h.reason, h.kind]), [['unscanned', 'compressed', 'file']]);
  assert.match(formatHit(strict[0], ALL), /^a\.bin {2}unscanned {2}\[not scanned: compressed\]/);
  // The path is scanned too, once.
  assert.deepEqual(scanBuffer(Buffer.from('clean'), `${HOST}/readme.txt`, { patterns: ALL }).map(h => [h.line, h.pattern]), [[0, 'hostname']]);
  assert.deepEqual(scanBuffer(Buffer.from('clean'), `${HOST}/readme.txt`, { patterns: ALL, nameScanned: true }), []);
});

test('files over 64 MB are read in overlapping chunks, not skipped (the single-executable case)', (t) => {
  const d = tmpdir(t);
  const big = path.join(d, 'tree', 'neverquestalone');
  fs.mkdirSync(path.dirname(big));
  const size = MAX_FILE + 1024 * 1024;
  const fd = fs.openSync(big, 'w');
  const put = (s, at, enc = 'latin1') => { const b = Buffer.from(s, enc); fs.writeSync(fd, b, 0, b.length, at); };
  fs.ftruncateSync(fd, size); // sparse: zeros everywhere else
  const across = CHUNK - 8; // straddles the first chunk boundary
  put('xx /Users/somebody/build xx', across);
  put(`host ${HOST}-box`, size - 100);
  put('C:\\Users\\somebody\\wide', 3 * CHUNK + 1001, 'utf16le');
  fs.closeSync(fd);
  const { hits, stats } = scanDir({ dir: path.join(d, 'tree'), patterns: ALL });
  assert.equal(stats.chunked, 1);
  assert.equal(stats.unscanned, 0);
  assert.deepEqual(hits.map(h => [h.pattern, h.offset]).sort((a, b) => a[1] - b[1]), [
    ['home-path', across + 3],
    ['home-path', 3 * CHUNK + 1001 + 4],
    ['hostname', size - 95],
  ]);
  // The same bytes under a compressed name: not readable, so listed (and a hit with --strict).
  const zip = path.join(d, 'tree.zip');
  fs.renameSync(big, zip);
  const st = { files: 0, text: 0, binary: 0, chunked: 0, unscanned: 0, unscannedPaths: [] };
  assert.deepEqual(scanLargeFile(zip, 'tree.zip', { patterns: ALL, stats: st }), []);
  assert.equal(st.unscanned, 1);
  assert.deepEqual(scanLargeFile(zip, 'tree.zip', { patterns: ALL, strict: true }).map(h => h.pattern), ['unscanned']);
});

// ---------------------------------------------------------------- compressed bytes (code health AP-06)

// A 4-letter "character" term, made up and assembled here, and the runs compressed bytes spell by
// chance: short printable runs between bytes no run takes.
const CHAR = ['Y', 'z', 'z', 'q'].join('');
const CHAR_TERMS = `# ${TERMS_MARKER}. Synthetic.\ncharacter /\\b${CHAR}\\b/i\n`;
const SHORT_ADDRESS = ['q', 'x.io'].join('@');
const plant = (buf, at, text) => { buf[at - 1] = 0; Buffer.from(text, 'latin1').copy(buf, at); buf[at + text.length] = 0; return at; };

test('compressed bytes: 4 KB blocks over 7.5 bits a byte, by their entropy (code health AP-06)', () => {
  const random = crypto.randomBytes(2 * ENTROPY_BLOCK);
  assert.ok(entropy(random) > 7.9, 'random bytes, as LZMA writes');
  assert.ok(entropy(Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(100))) < 4.5, 'text');
  assert.equal(entropy(Buffer.alloc(ENTROPY_BLOCK)), 0);
  assert.equal(entropy(Buffer.alloc(0)), 0);
  const mixed = Buffer.concat([Buffer.alloc(ENTROPY_BLOCK), random, Buffer.from('a short readable tail')]);
  assert.deepEqual([...compressedBlocks(mixed)], [0, 1, 1, 0]);
  assert.equal(LONG_RUN, 20);
});

test('compressed bytes: the 4-letter term and the address-shaped run an installer\'s LZMA payload spells by chance aren\'t hits, with the real allowlist and no line for them; the same runs in readable bytes are, and a long run in compressed bytes is still read (code health AP-06)', (t) => {
  const d = tmpdir(t);
  const terms = path.join(d, 'terms.txt');
  fs.writeFileSync(terms, CHAR_TERMS);
  const pats = [...BUILTIN, ...parseTerms(CHAR_TERMS).patterns];
  assert.deepEqual(names(` ${CHAR}.x`, pats), ['character']);
  assert.deepEqual(names(SHORT_ADDRESS, pats), ['email']);
  // An installer: a PE stub, then 512 KB of compressed bytes with both runs planted.
  const payload = crypto.randomBytes(512 * 1024);
  plant(payload, 100_000, ` ${CHAR}.x`);
  plant(payload, 300_000, SHORT_ADDRESS);
  const dist = path.join(d, 'dist');
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(dist, 'NeverQuestAlone-Setup-9.9.9.exe'), Buffer.concat([Buffer.from('MZ\0\0'), Buffer.alloc(ENTROPY_BLOCK - 4), payload]));
  // As release.yml's Windows job scans it: --strict, tools/scrub-allow.txt, which no longer turns a pattern off for the installer.
  assert.ok(!parseAllow(fs.readFileSync(path.join(ROOT, 'tools', 'scrub-allow.txt'), 'utf8')).some(e => /Setup/.test(e.glob) && e.id === '*'), 'no blanket line for the installer');
  let r = capture(['--dir', dist, '--terms', terms, '--strict', '--unscanned-ok', '*.blockmap']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^PASS: no hits\.$/m);
  // Not silent: counted in the summary and listed by file, under --strict too.
  assert.match(r.out, /^compressed bytes, not scanned as text: NeverQuestAlone-Setup-9\.9\.9\.exe \(512\.0 KB, \d+ short runs\)$/m);
  assert.match(r.out, /^compressed bytes, not scanned as text: 512\.0 KB in 1 file, \d+ short runs skipped \(blocks over 7\.5 bits a byte; runs of 20 characters or more in them are still read\)$/m);
  const json = JSON.parse(capture(['--dir', dist, '--terms', terms, '--strict', '--json']).out);
  assert.deepEqual(json.stats.compressedPaths.map(c => [c.path, c.bytes]), [['NeverQuestAlone-Setup-9.9.9.exe', 512 * 1024]]);
  assert.equal(json.stats.compressedBytes, 512 * 1024);
  assert.ok(json.stats.compressedRuns >= 2, 'the planted runs among the skipped');
  // The same runs in readable bytes (a binary of zeros): both hits, so nothing else changed.
  const zeros = Buffer.alloc(512 * 1024);
  plant(zeros, 100_000, ` ${CHAR}.x`);
  plant(zeros, 300_000, SHORT_ADDRESS);
  assert.deepEqual(scanBuffer(zeros, 'NeverQuestAlone-Setup-9.9.9.exe', { patterns: pats }).map(h => [h.pattern, h.offset]), [['email', 300_000], ['character', 100_001]].sort((a, b) => a[0] < b[0] ? -1 : 1));
  // Real text in compressed bytes, a run of 20 or more characters, is still read.
  const stored = crypto.randomBytes(64 * 1024);
  const at = plant(stored, 9_000, `a stored file says ${CHAR} hi`);
  assert.deepEqual(scanBuffer(stored, 'x.bin', { patterns: pats }).filter(h => h.pattern === 'character').map(h => h.offset), [at + 19]);
});

test('compressed bytes under --strict: each file\'s line names how many short runs were skipped, and the summary the total, in --summary too, so a jump shows in a release log (code health AP-06)', (t) => {
  const d = tmpdir(t);
  // 512 KB of compressed-looking bytes that are the same on every run (SHA-256 in counter mode), as an installer.
  const bytes = Buffer.concat(Array.from({ length: (512 * 1024) / 32 }, (_, i) => crypto.createHash('sha256').update(`nqa-${i}`).digest()));
  fs.mkdirSync(path.join(d, 'dist'));
  fs.writeFileSync(path.join(d, 'dist', 'NeverQuestAlone-Setup-9.9.9.exe'), bytes);
  fs.writeFileSync(path.join(d, 'dist', 'notes.txt'), 'clean\n');
  for (const extra of [[], ['--summary']]) {
    const r = capture(['--dir', path.join(d, 'dist'), '--no-terms', '--strict', ...extra]);
    assert.equal(r.code, 0, r.out);
    // The line a release log shows for the installer: its compressed bytes and the runs skipped in them.
    assert.match(r.out, /^compressed bytes, not scanned as text: NeverQuestAlone-Setup-9\.9\.9\.exe \(512\.0 KB, 939 short runs\)$/m, extra.join(' '));
    assert.match(r.out, /^compressed bytes, not scanned as text: 512\.0 KB in 1 file, 939 short runs skipped \(/m, extra.join(' '));
    assert.doesNotMatch(r.out, /notes\.txt \(/, 'a text file has none');
  }
});

test('compressed bytes in a file over 64 MB: counted once across the chunks\' overlap, and a short run on a chunk boundary is skipped there as anywhere (code health AP-06)', (t) => {
  const d = tmpdir(t);
  const big = path.join(d, 'tree', 'NeverQuestAlone.exe');
  fs.mkdirSync(path.dirname(big));
  const size = MAX_FILE + 1024 * 1024;
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, size); // sparse: zeros everywhere else
  // 1 MB of compressed bytes across the first chunk's end, its 64 KB overlap included, with the term in a short run in that overlap.
  const random = crypto.randomBytes(1024 * 1024);
  plant(random, 512 * 1024 + 4000, ` ${CHAR}.x`);
  fs.writeSync(fd, random, 0, random.length, CHUNK - 512 * 1024);
  // The same run in readable bytes, near the end: a hit.
  const tail = Buffer.alloc(64);
  plant(tail, 8, ` ${CHAR}.x`);
  fs.writeSync(fd, tail, 0, tail.length, size - 1000);
  fs.closeSync(fd);
  const pats = [...BUILTIN, ...parseTerms(CHAR_TERMS).patterns];
  const { hits, stats } = scanDir({ dir: path.join(d, 'tree'), patterns: pats });
  assert.equal(stats.chunked, 1);
  assert.deepEqual(hits.map(h => [h.pattern, h.offset]), [['character', size - 1000 + 9]]);
  assert.equal(stats.compressedBytes, 1024 * 1024, 'the overlap counted once');
  assert.deepEqual(stats.compressedPaths.map(c => [c.path, c.bytes]), [['NeverQuestAlone.exe', 1024 * 1024]]);
});

test('escapes and percent-encoding are read decoded too (audit EX-06): a term behind \\uXXXX, \\xXX or %XX is a hit at its line\'s own id, once per pattern', () => {
  assert.equal(decodeLine('plain text'), null);
  assert.equal(decodeLine('a\\u0041\\x42\\n\\u{43}%44'), 'aAB CD');
  assert.equal(decodeLine('%2FUsers%2Fsomebody'), '/Users/somebody');
  assert.equal(decodeLine('\\\\u0041'), '\\u0041', 'an escaped backslash stays one');
  assert.equal(decodeLine('100% sure'), null, 'a lone % stays');
  assert.equal(decodeLine('%E0%A4 ok %41'), '%E0%A4 ok A', 'bytes that aren\'t UTF-8 stay as they were');
  assert.equal(decodeLine('\\ud800 x'), null, 'a lone surrogate stays escaped');
  const json = '"cwd": "\\u002FUsers\\u002Fsomebody\\u002Fx"';
  const url = 'GET /open?f=%2FUsers%2Fsomebody%2Fdoc';
  assert.deepEqual(names(json), [], 'raw, the escapes hide it');
  const hits = scanText(`${json}\n${url}\nclean\n`, { patterns: ALL });
  assert.deepEqual(hits.map(h => [h.line, h.pattern]), [[1, 'home-path'], [2, 'home-path']]);
  assert.equal(hits[0].id, lineId(json), 'the line as it is in the file names it, so an allow entry still can');
  assert.equal(scanText(`/Users/somebody and %2FUsers%2Fsomebody`, { patterns: ALL }).length, 1, 'once per pattern per line');
});

test('a .git folder in a --dir scan is listed as not scanned, never skipped silently; --strict fails on it unless named (audit EX-06)', (t) => {
  const d = tmpdir(t);
  const tree = path.join(d, 'tree');
  writeTree(tree, { 'a.txt': 'clean\n', '.git/config': '[user]\n', 'sub/.git': 'gitdir: ../x\n' });
  const none = path.join(d, 'none');
  let r = capture(['--dir', tree, '--no-terms', '--allow', none]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^not scanned \(a git folder: its history rides along in a copy or a zip\): \.git$/m);
  assert.doesNotMatch(r.out, /^not scanned .*sub\/\.git$/m, 'a .git file (a worktree\'s pointer) is read like any file');
  r = capture(['--dir', tree, '--no-terms', '--allow', none, '--strict']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^\.git {2}unscanned {2}\[not scanned: a git folder/m);
  assert.equal(capture(['--dir', tree, '--no-terms', '--allow', none, '--strict', '--unscanned-ok', '.git']).code, 0);
});

// ---------------------------------------------------------------- joined terms and UTF-8 runs (code health EX-06)

// Made-up terms, assembled here: a two-word name, the case-sensitive Quentin (above), and a character
// with a 4-letter name and a 7-letter one. The terms without their twins are what the scanner had before.
const FULL = ['zan' + 'na', 'or' + 'vik'];
const SHORT = 'qu' + 'el', LONG = 'brak' + 'kal';
const cap = s => s[0].toUpperCase() + s.slice(1);
const JOIN_TEXT = [
  `name       \\b${FULL.join(' ')}\\b`,
  'name       /\\bQuentin\\b/',
  `character  \\b(?:${SHORT}|${LONG})\\b`,
  `hostname   ${HOST}(?:-box)?`,
  'home-path  [\\\\/]Users[\\\\/]somebody(?![\\w.-])',
  'ssh-alias  tiny',
].join('\n');
const JOIN = [...BUILTIN, ...parseTerms(JOIN_TEXT).patterns];
const UNJOINED = JOIN.filter(p => !p.joinOf);
// Raw bytes between NULs, as a binary holds a string.
const plantBytes = (buf, at, bytes) => { buf[at - 1] = 0; bytes.copy(buf, at); buf[at + bytes.length] = 0; return at; };

test('joined terms (code health EX-06): a term with a \\b or a space gets a <pattern>-joined twin per alternative, a short one bound to an identifier\'s shape; the ssh alias, a guarded path and an unbounded term get none; --list names them', (t) => {
  assert.equal(JOIN_MIN, 5);
  assert.deepEqual(JOIN.filter(p => p.joinOf).map(p => [p.name, p.re.source, p.re.flags, p.keep === joinShape]), [
    ['name-joined', `${FULL[0]}[\\s._+-]*${FULL[1]}`, 'gi', false],
    ['name-joined', 'Quentin', 'g', false],
    ['character-joined', SHORT, 'gi', true],
    ['character-joined', LONG, 'gi', false],
  ]);
  // A lookaround keeps its \b; with a backreference, a term isn't split and has no twin.
  assert.deepEqual(joinTwins('name', '\\bfoo(?!\\bbar)\\b', 'gi').map(p => p.re.source), ['foo(?!\\bbar)']);
  assert.deepEqual(joinTwins('name', '\\b(ab)\\1\\b', 'gi'), []);
  assert.deepEqual(joinTwins('name', '\\bx\\b|\\b(?=y)', 'gi').map(p => p.re.source), ['x'], 'an alternative that matches nothing has none');
  assert.throws(() => parseTerms('name-joined x'), /"name-joined" is a reserved pattern name/);
  const d = tmpdir(t);
  fs.writeFileSync(path.join(d, 'terms.txt'), JOIN_TEXT);
  const r = capture(['--list', '--terms', path.join(d, 'terms.txt')]);
  assert.match(r.out, /^name-joined +a name term joined to other letters or words \(terms\.txt:1\)$/m);
  assert.match(r.out, /^character-joined a character term joined to other letters or words \(terms\.txt:3\)$/m);
  assert.doesNotMatch(r.out, /^(?:hostname|home-path|ssh-alias)-joined/m);
});

test('joined terms (code health EX-06): a term glued to other letters, which the terms alone missed, is a hit in text and file names; a 4-letter one only where an identifier joins it, never inside an ordinary word; a binary\'s runs are read without twins', () => {
  for (const [line, want] of [
    [`${FULL.join('.')}@example.com`, 'name-joined'], // the email pattern lets a reserved domain through
    [FULL.map(cap).join(''), 'name-joined'],
    [`${FULL.join('_')}_notes`, 'name-joined'],
    [`/Users/${FULL.join('')}/Dev`, 'name-joined'],
    ['QuentinSmith', 'name-joined'],
    ['myQuentin', 'name-joined'],
    [`${LONG}son`, 'character-joined'],
    [`${cap(SHORT)}Bot`, 'character-joined'],
    [`my_${SHORT}`, 'character-joined'],
    [`My${cap(SHORT)}`, 'character-joined'],
    [`${SHORT}2`, 'character-joined'],
    [`${SHORT.toUpperCase()}_HOME`, 'character-joined'],
    [`NQA${cap(SHORT)}`, 'character-joined'],
  ]) {
    assert.deepEqual(names(line, UNJOINED), [], `the terms alone miss ${line}`);
    assert.deepEqual(names(line, JOIN), [want], line);
  }
  // Near misses: the short term inside ordinary words, in a case no identifier is written in; Quentin
  // (case-sensitive) in another case; the full name's words apart.
  for (const line of [`the se${SHORT}`, `${SHORT}led`, `${cap(SHORT)}ling`, `${SHORT.toUpperCase()}L`, `${SHORT[0]}${SHORT.slice(1, 3).toUpperCase()}${SHORT[3]}_x`, 'quentinsmith', FULL.join(' and ')]) {
    assert.deepEqual(names(line, JOIN), [], line);
  }
  // Where the term itself hits, its twin adds nothing (one hit a line); behind "\n" it's the term.
  assert.deepEqual(names(FULL.join(' '), JOIN), ['name']);
  assert.deepEqual(names('Quentin and QuentinSmith', JOIN), ['name']);
  assert.deepEqual(scanText('"hi\\nQuentin"', { patterns: JOIN }).map(h => h.pattern), ['name']);
  // Allowed by id like any hit, under its own name.
  const line = 'const QuentinSmith = 1;';
  const [h] = scanText(line, { patterns: JOIN, path: 'src/a.js' });
  assert.equal(h.pattern, 'name-joined');
  assert.equal(allowedBy(h, parseAllow(`src/a.js name-joined ${lineId(line)}`))?.line, 1);
  assert.equal(allowedBy(h, parseAllow(`src/a.js name ${lineId(line)}`)), null, 'the term\'s own entry doesn\'t allow its twin');
  // A file's name; a path's mask hides the joined word.
  assert.deepEqual(scanBuffer(Buffer.from('ok'), `notes/${FULL.join('')}-todo.md`, { patterns: JOIN }).map(x => [x.kind, x.pattern]), [['name', 'name-joined']]);
  assert.equal(maskText(`notes/${FULL.join('')}-todo.md`, JOIN), 'notes/[name-joined]-todo.md');
  // A binary's run has no words to join: its neighbours are whatever bytes lie there, as the DER
  // field after a certificate's name in every signed binary of 1.4.0. The term itself still hits.
  const bin = Buffer.concat([Buffer.alloc(8), Buffer.from('\x0c\x0dQuentinSmith1\x0b\0 signed by Quentin\0', 'latin1')]);
  assert.deepEqual(scanBuffer(bin, 'helper', { patterns: JOIN }).map(x => [x.pattern, x.offset]), [['name', 36]]);
});

test('binaries: UTF-8 runs (code health EX-06): a term with a letter past ASCII, or a short one in curly quotes, is read whole at its byte offset, where the ASCII and UTF-16 runs held neither; bytes that aren\'t UTF-8 still end a run', () => {
  const ACCENT = 'zö' + 'brin';
  const pats = [...BUILTIN, ...parseTerms(`name \\b${ACCENT}\\b\ncharacter \\b${SHORT}\\b`).patterns];
  const blob = Buffer.concat([
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]),
    Buffer.from(`by ${cap(ACCENT)} ok`, 'utf8'), Buffer.from([0, 0]),
    Buffer.from(`“${cap(SHORT)}”`, 'utf8'), Buffer.from([0, 0]),
  ]);
  assert.deepEqual(extractStrings(blob).filter(s => !s.utf8).flatMap(s => scanLine(s.text, pats)), [], 'what the scanner read before: nothing');
  const hits = scanBuffer(blob, 'helper', { patterns: pats });
  assert.deepEqual(hits.map(h => h.pattern), ['name', 'character']);
  assert.equal(blob.toString('utf8', hits[0].offset, hits[0].offset + Buffer.byteLength(ACCENT)), cap(ACCENT), 'offsets are bytes: the term\'s first');
  assert.equal(blob.toString('utf8', hits[1].offset, hits[1].offset + SHORT.length), cap(SHORT));
  // Near misses: the same letters in Latin-1 (0xF6 alone isn't UTF-8), split by an overlong form, or
  // quoted with a C1 control inside: no run holds the term, so no hit.
  for (const bad of [
    Buffer.from(`by ${cap(ACCENT)} ok`, 'latin1'),
    Buffer.concat([Buffer.from('by Z'), Buffer.from([0xc1, 0xb6]), Buffer.from('brin ok')]),
    Buffer.concat([Buffer.from('“'), Buffer.from([0xc2, 0x85]), Buffer.from(`${cap(SHORT)}”`)]),
  ]) {
    assert.deepEqual(scanBuffer(Buffer.concat([Buffer.alloc(4), bad, Buffer.alloc(4)]), 'helper', { patterns: pats }), [], bad.toString('hex'));
  }
  // A run counts characters: six here, in seven bytes; ASCII alone is the ASCII run's.
  assert.deepEqual(extractStrings(Buffer.from([0, 0x61, 0xc3, 0xa9, 0x62, 0x63, 0x64, 0x65, 0, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0])).map(s => [s.text, s.chars, s.bytes, s.utf8]),
    [['abcdef', 6, 6, false], ['aébcde', 6, 7, true]]);
});

test('UTF-8 runs in compressed bytes (code health EX-06, AP-06): a short one is skipped there like any, a long one read; the skipped-run counts stay the ASCII and UTF-16 runs\', and a hit an ASCII run makes keeps its id', () => {
  const pats = [...BUILTIN, ...parseTerms(CHAR_TERMS).patterns];
  const random = crypto.randomBytes(64 * 1024);
  plantBytes(random, 9_000, Buffer.from(`“${CHAR}”`));
  const at = plantBytes(random, 20_000, Buffer.from(`a stored file says “${CHAR}” hi`));
  assert.deepEqual(scanBuffer(random, 'x.bin', { patterns: pats }).filter(h => h.pattern === 'character').map(h => h.offset), [at + 22], 'only the long one');
  // The AP-06 bytes above (SHA-256 in counter mode) hold UTF-8 runs; the count of short runs skipped is still 939.
  const bytes = Buffer.concat(Array.from({ length: (512 * 1024) / 32 }, (_, i) => crypto.createHash('sha256').update(`nqa-${i}`).digest()));
  assert.ok(extractStrings(bytes).filter(s => s.utf8).length > 0);
  const stats = { files: 0, text: 0, binary: 0, chunked: 0, unscanned: 0, unscannedPaths: [] };
  scanBuffer(bytes, 'NeverQuestAlone-Setup-9.9.9.exe', { patterns: BUILTIN, stats });
  assert.equal(stats.compressedRuns, 939);
  // An ASCII run inside a UTF-8 one: one hit, at the ASCII run's id, as before.
  const zeros = Buffer.alloc(256);
  plantBytes(zeros, 16, Buffer.from('build by Quentiné', 'utf8'));
  assert.deepEqual(scanBuffer(zeros, 'x.bin', { patterns: ALL }).map(h => [h.pattern, h.offset, h.id]), [['name', 25, lineId('build by Quentin')]]);
});

// ---------------------------------------------------------------- signature regions (code health EX-06 / signature regions)

// A made-up signer (Quentin, the name term above) and the two runs a certificate's subject leaves in a
// signature, at +0x74C and +0x762 as in 1.4.x's Windows tables: the O value and the next SET's tag ("1"),
// the CN value and the public key's SEQUENCE tag ("0"). Both under 20 characters, so the gate could skip them.
const SIGNER = ['Quentin', 'Example'].join(' ');
const SIGNER_RUNS = [[0x74c, `${SIGNER}1`], [0x762, `${SIGNER}0`]];
const SIGNER_IDS = SIGNER_RUNS.map(([, run]) => lineId(run));
const SIG_TERMS = `# ${TERMS_MARKER}. Synthetic.\nname /\\bQuentin\\b/\ncharacter /\\b${CHAR}\\b/i\n`;
const SIG_PATTERNS = [...BUILTIN, ...parseTerms(SIG_TERMS).patterns];
// [pattern, offset, id] of the signer's two lines, its runs' offsets counted from at.
const signerLines = (at = 0) => SIGNER_RUNS.map(([off], i) => ['name', at + off, SIGNER_IDS[i]]);
const blankStats = () => ({ files: 0, text: 0, binary: 0, chunked: 0, unscanned: 0, unscannedPaths: [] });
// Bytes as compressed or signed data look (near 8 bits a byte), the same on every run: SHA-256 in counter mode.
const noise = (n, seed) => Buffer.concat(Array.from({ length: Math.ceil(n / 32) }, (_, i) => crypto.createHash('sha256').update(`${seed}-${i}`).digest())).subarray(0, n);
// 64 KB of compressed bytes (an installer's LZMA, an exe's packed data) holding a chance run of the made-up character.
const COMPRESSED = noise(0x10000, 'lzma');
plant(COMPRESSED, 0x8000, ` ${CHAR}.x`);

// A PE as the linker and the signer leave one, its headers padded to 0x400: the MZ header, "PE\0\0" at 0x80,
// the COFF header, the optional header (PE32+, or PE32) and its 16 data directories, the fifth of them
// (Security) naming the certificate table by file offset and size.
function peHeaders(at, len, pe32 = false) {
  const h = Buffer.alloc(0x400);
  const opt = 0x98, dirs = pe32 ? 96 : 112;
  h.write('MZ', 0, 'latin1');
  h.writeUInt32LE(0x80, 0x3c);
  h.write('PE\0\0', 0x80, 'latin1');
  h.writeUInt16LE(pe32 ? 0x14c : 0x8664, 0x84); // Machine
  h.writeUInt16LE(dirs + 16 * 8, 0x94); // SizeOfOptionalHeader
  h.writeUInt16LE(pe32 ? 0x102 : 0x22, 0x96); // Characteristics
  h.writeUInt16LE(pe32 ? 0x10b : 0x20b, opt); // Magic
  h.writeUInt32LE(16, opt + dirs - 4); // NumberOfRvaAndSizes
  h.writeUInt32LE(at, opt + dirs + 32); // the Security directory: a file offset
  h.writeUInt32LE(len, opt + dirs + 36);
  return h;
}

// A certificate table: a WIN_CERTIFICATE (its length, revision 2.0, PKCS#7 signed data) of signed-data bytes
// holding the signer's two runs.
function certTable(n = 0x2000) {
  const t = noise(n, 'pkcs7');
  t.writeUInt32LE(n, 0);
  t.writeUInt16LE(0x0200, 4);
  t.writeUInt16LE(0x0002, 6);
  for (const [off, run] of SIGNER_RUNS) plant(t, off, run);
  return t;
}

// What lies between the compressed bytes and the table, so the table starts at one of three places against the
// 4 KB blocks: on a block (the signer's runs in a block of certificate bytes alone, as 1.4.0's and 1.4.1's exe,
// the table at 0xEA68E00), 1,536 bytes of zeros (1.4.2's exe, at 0xEA6A600) or 0x2B0 compressed bytes (1.4.1's
// installer, at 0x6B2D2B0).
const PE_GAPS = { aligned: Buffer.alloc(0), zeros: Buffer.alloc(0x600), compressed: noise(0x2b0, 'lzma-tail') };

// A signed PE: the headers, zeros to 0x1000, the compressed bytes, the gap, the table, which ends the file.
function signedPE(gap, { pe32 = false } = {}) {
  const table = certTable();
  const at = 0x1000 + COMPRESSED.length + PE_GAPS[gap].length;
  return { pe: Buffer.concat([peHeaders(at, table.length, pe32), Buffer.alloc(0xc00), COMPRESSED, PE_GAPS[gap], table]), at };
}

// A Mach-O's code signature, a big-endian SuperBlob: a CodeDirectory (its identifier, then 2 special and 512 code
// hash slots, with a chance run of the made-up character among them), requirements, entitlements (1,536 bytes,
// mostly indentation) and the CMS blob, whose certificate holds the signer's two runs.
// → { sig, cms: where the CMS bytes start in sig, hashes: [start, end) of the hash slots in sig }
function codeSignature() {
  const blob = (magic, body) => { const h = Buffer.alloc(8); h.writeUInt32BE(magic, 0); h.writeUInt32BE(8 + body.length, 4); return Buffer.concat([h, body]); };
  const ident = Buffer.from('com.example.signed\0', 'latin1');
  const special = 2, slots = 512;
  const hashes = noise((special + slots) * 32, 'pages');
  plant(hashes, 0x2000, ` ${CHAR}.x`);
  const cd = Buffer.alloc(44);
  cd.writeUInt32BE(0xfade0c02, 0);
  cd.writeUInt32BE(44 + ident.length + hashes.length, 4);
  cd.writeUInt32BE(0x20001, 8); // version
  cd.writeUInt32BE(44 + ident.length + special * 32, 16); // hashOffset: code slot 0
  cd.writeUInt32BE(44, 20); // identOffset
  cd.writeUInt32BE(special, 24);
  cd.writeUInt32BE(slots, 28);
  cd.writeUInt32BE(slots * 0x4000, 32); // codeLimit
  cd[36] = 32; cd[37] = 2; cd[39] = 14; // SHA-256 hashes of 16 KB pages
  const ent = Buffer.alloc(0x600, '\t');
  ent.write('<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n');
  const cms = noise(0x2000, 'cms');
  for (const [off, run] of SIGNER_RUNS) plant(cms, off, run);
  const blobs = [[0, Buffer.concat([cd, ident, hashes])], [2, blob(0xfade0c01, Buffer.alloc(4))], [5, blob(0xfade7171, ent)], [0x10000, blob(0xfade0b01, cms)]];
  const head = Buffer.alloc(12 + 8 * blobs.length);
  let end = head.length;
  blobs.forEach(([type, b], i) => { head.writeUInt32BE(type, 12 + 8 * i); head.writeUInt32BE(end, 16 + 8 * i); end += b.length; });
  head.writeUInt32BE(0xfade0cc0, 0);
  head.writeUInt32BE(end, 4);
  head.writeUInt32BE(blobs.length, 8);
  const from = head.length + 44 + ident.length;
  return { sig: Buffer.concat([head, ...blobs.map(([, b]) => b)]), cms: end - cms.length, hashes: [from, from + hashes.length] };
}
const CODESIG = codeSignature();

// A 64-bit Mach-O: its header, an LC_UUID, the LC_CODE_SIGNATURE naming the signature (dataoff, datasize, from
// the slice's start), code bytes (with a chance run of the character) up to dataoff, then the signature.
function machO(dataoff, cputype = 0x0100000c) {
  const m = Buffer.alloc(dataoff + CODESIG.sig.length);
  m.writeUInt32LE(0xfeedfacf, 0);
  m.writeUInt32LE(cputype, 4);
  m.writeUInt32LE(6, 12); // MH_DYLIB
  m.writeUInt32LE(2, 16); // ncmds
  m.writeUInt32LE(24 + 16, 20); // sizeofcmds
  m.writeUInt32LE(0x1b, 32); // LC_UUID
  m.writeUInt32LE(24, 36);
  m.writeUInt32LE(0x1d, 56); // LC_CODE_SIGNATURE
  m.writeUInt32LE(16, 60);
  m.writeUInt32LE(dataoff, 64);
  m.writeUInt32LE(CODESIG.sig.length, 68);
  noise(dataoff - 0x100, 'text').copy(m, 0x100);
  plant(m, 0x1200, ` ${CHAR}.x`);
  CODESIG.sig.copy(m, dataoff);
  return m;
}

// Two places for the signature against the 4 KB blocks: its CMS bytes starting a block (the signer's runs in a
// block of certificate bytes alone), and starting 1,536 bytes into one, after the entitlements' indentation.
const ALIGNED = Math.ceil((0x1000 + CODESIG.cms) / ENTROPY_BLOCK) * ENTROPY_BLOCK - CODESIG.cms;
const MACHO_AT = { aligned: ALIGNED, entitlements: ALIGNED + 0x600 };

// A fat file of slices ({ cputype, buf }), each at a 16 KB boundary: fat_arch entries, or fat_arch_64 when wide.
function makeFat(slices, wide = false) {
  const w = wide ? 32 : 20, at = [];
  let end = 0x4000;
  for (const s of slices) { at.push(end); end = Math.ceil((end + s.buf.length) / 0x4000) * 0x4000; }
  const fat = Buffer.alloc(end);
  fat.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  fat.writeUInt32BE(slices.length, 4);
  slices.forEach((s, i) => {
    const p = 8 + w * i;
    fat.writeUInt32BE(s.cputype, p);
    if (wide) { fat.writeBigUInt64BE(BigInt(at[i]), p + 8); fat.writeBigUInt64BE(BigInt(s.buf.length), p + 16); fat.writeUInt32BE(14, p + 24); }
    else { fat.writeUInt32BE(at[i], p + 8); fat.writeUInt32BE(s.buf.length, p + 12); fat.writeUInt32BE(14, p + 16); }
    s.buf.copy(fat, at[i]);
  });
  return { fat, at };
}

// Whether the signer's first run sits in a 4 KB block over 7.5 bits a byte: what the gate alone decided.
const gatedAt = (buf, off) => compressedBlocks(buf)[Math.floor(off / ENTROPY_BLOCK)];

test('signature regions (code health EX-06): a PE\'s certificate table gives the signer\'s two lines at the same ids wherever it sits against the 4 KB blocks, where the gate alone skipped them in two layouts and read them in one (1.4.0 against 1.4.2); the compressed bytes before it stay skipped and counted', () => {
  const seen = Object.keys(PE_GAPS).map(gap => {
    const { pe, at } = signedPE(gap);
    assert.deepEqual(signatureRanges(pe), [[at, pe.length]], gap);
    const stats = blankStats();
    const hits = scanBuffer(pe, 'win-unpacked/NeverQuestAlone.exe', { patterns: SIG_PATTERNS, stats });
    return { gap, pe, at, stats, lines: hits.map(h => [h.pattern, h.offset - at, h.id]) };
  });
  // The layouts are what they say: the runs' block over 7.5 bits a byte on a block and after compressed bytes, under it after zeros.
  assert.deepEqual(seen.map(s => gatedAt(s.pe, s.at + SIGNER_RUNS[0][0])), [1, 0, 1]);
  // The same two lines, at the same places in the table, with the same ids, in every layout; the chance run in the compressed bytes isn't one.
  for (const s of seen) assert.deepEqual(s.lines, signerLines(), s.gap);
  // The gate alone (the same files with "PE\0\0" broken, so no region): two lines in one layout, none in the others.
  assert.deepEqual(seen.map(s => { const b = Buffer.from(s.pe); b.write('PX', 0x80, 'latin1'); return scanBuffer(b, 'x.exe', { patterns: SIG_PATTERNS }).length; }), [0, 2, 0]);
  // Counted: one file's region, whose bytes aren't compressed bytes; every compressed byte outside it still is, its short runs skipped.
  assert.deepEqual(seen.map(s => [s.stats.signed, s.stats.signedBytes, s.stats.compressedBytes]), [[1, 0x2000, 0x10000], [1, 0x2000, 0x10000], [1, 0x2000, 0x10000 + 0x2b0]]);
  assert.ok(seen.every(s => s.stats.compressedRuns > 0));
  // Allowed by exact id, as tools/scrub-allow.txt allows the real signer's two lines; another line still fails.
  const allow = parseAllow(SIGNER_IDS.map(id => `**/win-unpacked/*.exe name ${id}`).join('\n'));
  for (const s of seen) assert.ok(scanBuffer(s.pe, 'dist/win-unpacked/NeverQuestAlone.exe', { patterns: SIG_PATTERNS }).every(h => allowedBy(h, allow)), s.gap);
  const other = signedPE('aligned');
  plant(other.pe, other.at + 0x900, `by ${SIGNER}`);
  assert.deepEqual(scanBuffer(other.pe, 'dist/win-unpacked/NeverQuestAlone.exe', { patterns: SIG_PATTERNS }).filter(h => !allowedBy(h, allow)).map(h => [h.offset - other.at, h.id]), [[0x900 + 'by '.length, lineId(`by ${SIGNER}`)]]);
  // A PE32 header reads the same.
  const pe32 = signedPE('zeros', { pe32: true });
  assert.deepEqual(signatureRanges(pe32.pe), [[pe32.at, pe32.pe.length]]);
});

test('signature regions (code health EX-06): a Mach-O\'s code signature, thin and fat, gives the signer\'s two lines at the same ids at either place against the blocks; its CodeDirectory\'s page hashes and the code before it stay gated', () => {
  const thin = Object.entries(MACHO_AT).map(([where, dataoff]) => {
    const m = machO(dataoff);
    // The region, less the CodeDirectory's hash slots.
    assert.deepEqual(signatureRanges(m), [[dataoff, dataoff + CODESIG.hashes[0]], [dataoff + CODESIG.hashes[1], m.length]], where);
    return { where, m, dataoff };
  });
  assert.deepEqual(thin.map(({ m, dataoff }) => gatedAt(m, dataoff + CODESIG.cms + SIGNER_RUNS[0][0])), [1, 0]);
  // The chance runs in the hash slots and the code lie in blocks the gate skips, at both places.
  assert.ok(thin.every(({ m, dataoff }) => gatedAt(m, dataoff + CODESIG.hashes[0] + 0x2000) && gatedAt(m, 0x1200)));
  for (const { where, m, dataoff } of thin) {
    const hits = scanBuffer(m, 'NeverQuestAlone.app/Contents/MacOS/NeverQuestAlone', { patterns: SIG_PATTERNS });
    assert.deepEqual(hits.map(h => [h.pattern, h.offset, h.id]), signerLines(dataoff + CODESIG.cms), where);
  }
  // The gate alone (the SuperBlob's magic broken, so no region) flapped here too.
  assert.deepEqual(thin.map(({ m, dataoff }) => { const b = Buffer.from(m); b.writeUInt32BE(0xfade0cc1, dataoff); return scanBuffer(b, 'x', { patterns: SIG_PATTERNS }).length; }), [0, 2]);
  // Fat (fat_arch and fat_arch_64): two slices at 16 KB boundaries, each with its own signature, one at each place.
  for (const wide of [false, true]) {
    const { fat, at } = makeFat(thin.map(({ m }, i) => ({ cputype: i ? 0x0100000c : 0x01000007, buf: m })), wide);
    assert.deepEqual(signatureRanges(fat), thin.flatMap(({ m, dataoff }, i) => [[at[i] + dataoff, at[i] + dataoff + CODESIG.hashes[0]], [at[i] + dataoff + CODESIG.hashes[1], at[i] + m.length]]), `wide ${wide}`);
    const hits = scanBuffer(fat, 'NeverQuestAlone Capture.app/Contents/MacOS/NQACapture', { patterns: SIG_PATTERNS });
    assert.deepEqual(hits.map(h => [h.pattern, h.offset, h.id]), thin.flatMap(({ dataoff }, i) => signerLines(at[i] + dataoff + CODESIG.cms)), `wide ${wide}`);
  }
});

test('signature regions (code health EX-06): a header or a signature cut short, out of bounds or with the wrong magic gives no region, so the gate applies as before; nothing throws, and a region found always lies in the file', () => {
  const inFile = (r, size) => Array.isArray(r) && r.every(([s, e], i) => Number.isSafeInteger(s) && Number.isSafeInteger(e) && s >= 0 && s < e && e <= size && (i === 0 || r[i - 1][1] < s));
  const { pe, at } = signedPE('aligned');
  const D = MACHO_AT.aligned;
  const m = machO(D);
  const { fat, at: slices } = makeFat([{ cputype: 0x01000007, buf: m }, { cputype: 0x0100000c, buf: m }]);
  const fatFull = signatureRanges(fat);
  // Cut short anywhere: the table and the signature end their files, so a cut gives none; a fat file keeps the slices before the cut.
  for (const [what, buf] of [['pe', pe], ['macho', m], ['fat', fat]]) {
    for (let n = 0; n < buf.length; n += 37) {
      const want = what === 'fat' ? fatFull.filter(([s]) => slices.some(o => s >= o && o + m.length <= n && s < o + m.length)) : [];
      assert.deepEqual(signatureRanges(buf.subarray(0, n)), want, `${what} cut at ${n}`);
    }
  }
  for (let n = 0; n < pe.length; n += 4099) assert.ok(Array.isArray(scanBuffer(pe.subarray(0, n), 'x.exe', { patterns: SIG_PATTERNS })));
  // Each field out of line: no region, and the signer's runs (in a block of certificate bytes alone) stay skipped, as before.
  const broken = (buf, f) => { const b = Buffer.from(buf); f(b); return b; };
  const cases = [
    ['pe: e_lfanew past the end', pe, b => b.writeUInt32LE(0xfffffff0, 0x3c)],
    ['pe: no "PE\\0\\0"', pe, b => b.write('PE\0\x01', 0x80, 'latin1')],
    ['pe: an optional header neither PE32 nor PE32+', pe, b => b.writeUInt16LE(0x107, 0x98)],
    ['pe: four data directories', pe, b => b.writeUInt32LE(4, 0x98 + 108)],
    ['pe: an optional header too short for the Security directory', pe, b => b.writeUInt16LE(112 + 4 * 8, 0x94)],
    ['pe: the table past the end', pe, b => b.writeUInt32LE(b.length, 0x98 + 144)],
    ['pe: the table inside the headers', pe, b => b.writeUInt32LE(0x10, 0x98 + 144)],
    ['pe: no table', pe, b => b.writeUInt32LE(0, 0x98 + 148)],
    ['pe: a table longer than the file', pe, b => b.writeUInt32LE(b.length, 0x98 + 148)],
    ['pe: a WIN_CERTIFICATE shorter than its header', pe, b => b.writeUInt32LE(4, at)],
    ['pe: a WIN_CERTIFICATE longer than the table', pe, b => b.writeUInt32LE(0x2008, at)],
    ['macho: the wrong magic', m, b => b.writeUInt32LE(0xfeedfacd, 0)],
    ['macho: load commands past the end', m, b => b.writeUInt32LE(0xfffffff0, 20)],
    ['macho: a load command of size 0', m, b => b.writeUInt32LE(0, 36)],
    ['macho: a load command running past the others', m, b => b.writeUInt32LE(0x1000, 36)],
    ['macho: an LC_CODE_SIGNATURE too short for its fields', m, b => b.writeUInt32LE(8, 60)],
    ['macho: the signature past the end', m, b => b.writeUInt32LE(b.length, 64)],
    ['macho: the signature inside the load commands', m, b => b.writeUInt32LE(0x20, 64)],
    ['macho: an empty signature', m, b => b.writeUInt32LE(0, 68)],
    ['macho: a signature longer than the file', m, b => b.writeUInt32LE(b.length, 68)],
    ['macho: no SuperBlob magic', m, b => b.writeUInt32BE(0xfade0cc1, D)],
    ['macho: a SuperBlob longer than its region', m, b => b.writeUInt32BE(CODESIG.sig.length + 1, D + 4)],
    ['macho: a SuperBlob counting more blobs than it holds', m, b => b.writeUInt32BE(0x10000000, D + 8)],
    ['macho: a blob inside the index', m, b => b.writeUInt32BE(12, D + 16)],
    ['macho: a blob past the SuperBlob', m, b => b.writeUInt32BE(CODESIG.sig.length, D + 16)],
    ['macho: a CodeDirectory whose hashes run past it', m, b => b.writeUInt32BE(0xffffff, D + 44 + 28)],
    ['macho: a CodeDirectory whose hashes start in its header', m, b => b.writeUInt32BE(8, D + 44 + 16)],
    ['fat: no slices', fat, b => b.writeUInt32BE(0, 4)],
    ['fat: 20 slices (file(1) calls that a Java class)', fat, b => b.writeUInt32BE(20, 4)],
    ['fat: 2^32 - 1 slices', fat, b => b.writeUInt32BE(0xffffffff, 4)],
    ['fat: both slices past the end', fat, b => { b.writeUInt32BE(b.length, 16); b.writeUInt32BE(b.length, 36); }],
  ];
  for (const [what, buf, f] of cases) {
    const b = broken(buf, f);
    assert.deepEqual(signatureRanges(b), [], what);
    if (buf !== fat) assert.deepEqual(scanBuffer(b, 'x', { patterns: SIG_PATTERNS }).filter(h => h.pattern === 'name'), [], what);
  }
  // A fat slice that doesn't fit gives none; the other keeps its own.
  assert.deepEqual(signatureRanges(broken(fat, b => b.writeUInt32BE(b.length, 8 + 12))), fatFull.filter(([s]) => s >= slices[1]));
  // Bytes changed at random (a fixed seed) in the headers, the load commands and the signature's head: never a throw, a region always in the file.
  let x = 0x2545f491;
  const rnd = n => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
  for (const [buf, spots] of [[pe, [[0, 0x200], [at, at + 16]]], [m, [[0, 72], [D, D + 120]]], [fat, [[0, 48], [slices[1], slices[1] + 72]]]]) {
    for (let i = 0; i < 400; i++) {
      const b = Buffer.from(buf);
      for (let k = 1 + rnd(3); k > 0; k--) { const [s, e] = spots[rnd(spots.length)]; b[s + rnd(e - s)] = rnd(256); }
      const r = signatureRanges(b);
      assert.ok(inFile(r, b.length), JSON.stringify(r));
    }
  }
  // Read in place from a file ({ fd, size }), the same.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'scrub-sig-'));
  try {
    for (const [name, buf] of [['a.exe', pe], ['b', m], ['c', fat], ['d', pe.subarray(0, 0x300)]]) {
      fs.writeFileSync(path.join(d, name), buf);
      const fd = fs.openSync(path.join(d, name), 'r');
      try { assert.deepEqual(signatureRanges({ fd, size: buf.length }), signatureRanges(buf), name); } finally { fs.closeSync(fd); }
    }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('signature regions in a file read in chunks (code health EX-06): a table across a chunk\'s end is found from the headers read in place, its two lines count once, and none of its bytes count as compressed', (t) => {
  const d = tmpdir(t);
  const file = path.join(d, 'NeverQuestAlone.exe');
  const table = certTable();
  const at = CHUNK - 0x700; // the signer's runs just past the first chunk's end, in its 64 KB overlap too
  const write = (head) => {
    const fd = fs.openSync(file, 'w');
    try { fs.writeSync(fd, head, 0, head.length, 0); fs.writeSync(fd, table, 0, table.length, at); } finally { fs.closeSync(fd); }
  };
  write(peHeaders(at, table.length));
  const fd = fs.openSync(file, 'r');
  try { assert.deepEqual(signatureRanges({ fd, size: fs.fstatSync(fd).size }), [[at, at + table.length]]); } finally { fs.closeSync(fd); }
  const stats = blankStats();
  assert.deepEqual(scanLargeFile(file, 'win-unpacked/NeverQuestAlone.exe', { patterns: SIG_PATTERNS, stats }).map(h => [h.pattern, h.offset, h.id]), signerLines(at));
  assert.deepEqual([stats.signed, stats.signedBytes, stats.compressedBytes ?? 0], [1, table.length, 0]);
  // The gate alone (no region) skipped both: their block is certificate bytes alone.
  const broken = peHeaders(at, table.length);
  broken.write('PX', 0x80, 'latin1');
  write(broken);
  assert.deepEqual(scanLargeFile(file, 'win-unpacked/NeverQuestAlone.exe', { patterns: SIG_PATTERNS }), []);
});

test('signature regions under --strict (code health EX-06): a release folder passes with the signer\'s two ids allowed by exact id, fails on them without, and the summary says how much it read as signature regions', (t) => {
  const d = tmpdir(t);
  const dist = path.join(d, 'dist');
  const files = {
    'win-unpacked/NeverQuestAlone.exe': signedPE('zeros').pe,
    'NeverQuestAlone-Setup-9.9.9.exe': signedPE('compressed').pe,
    'mac/NeverQuestAlone.app/Contents/MacOS/NeverQuestAlone': machO(MACHO_AT.aligned),
  };
  writeTree(dist, files);
  const terms = path.join(d, 'terms.txt');
  fs.writeFileSync(terms, SIG_TERMS);
  const allow = path.join(d, 'allow.txt');
  fs.writeFileSync(allow, ['**/win-unpacked/*.exe', '**/NeverQuestAlone-Setup*.exe', '**/NeverQuestAlone.app/Contents/MacOS/*'].flatMap(g => SIGNER_IDS.map(id => `${g} name ${id}`)).join('\n') + '\n');
  const bytes = Object.values(files).reduce((n, b) => n + signatureRanges(b).reduce((k, [s, e]) => k + e - s, 0), 0);
  const r = capture(['--dir', dist, '--terms', terms, '--strict', '--allow', allow]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^PASS: no hits\.$/m);
  const said = /^signature regions, read as text whatever their entropy: ([\d.]+) KB in 3 files \(a PE's certificate table, a Mach-O's code signature less its page hashes\)$/m.exec(r.out);
  assert.ok(said, r.out);
  assert.equal(said[1], (bytes / 1024).toFixed(1));
  const j = JSON.parse(capture(['--dir', dist, '--terms', terms, '--strict', '--allow', path.join(d, 'none'), '--json']).out);
  assert.equal(j.ok, false);
  assert.deepEqual(j.hits.map(h => `${h.pattern} ${h.id}`).sort(), SIGNER_IDS.flatMap(id => Array(3).fill(`name ${id}`)).sort());
  assert.deepEqual([j.stats.signed, j.stats.signedBytes], [3, bytes]);
});

// An asar archive as Electron's @electron/asar writes one: a size pickle, the header pickle (its
// payload size, the JSON's length, the JSON, padded to 4), then the files, at offsets from there.
function makeAsar(files, { unpacked = [] } = {}) {
  const tree = { files: {} };
  const datas = [];
  let offset = 0;
  for (const [rel, body] of Object.entries(files)) {
    const parts = rel.split('/');
    let node = tree;
    for (const dir of parts.slice(0, -1)) node = (node.files[dir] ??= { files: {} });
    const data = Buffer.from(body);
    if (unpacked.includes(rel)) { node.files[parts.at(-1)] = { size: data.length, unpacked: true }; continue; }
    node.files[parts.at(-1)] = { size: data.length, offset: String(offset) };
    datas.push(data);
    offset += data.length;
  }
  const json = Buffer.from(JSON.stringify(tree));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4)]);
  const headerPickle = Buffer.alloc(8 + padded.length);
  headerPickle.writeUInt32LE(4 + padded.length, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  padded.copy(headerPickle, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([size, headerPickle, ...datas]);
}

test('an asar archive is read as the files it holds (app.asar/<path>), so a hit names the file and an allow entry can; a malformed one is read as a binary', (t) => {
  const asar = makeAsar({
    'package.json': '{"name":"app"}',
    'src/main.mjs': `// by ${EMAIL}\nexport {};\n`,
    'node_modules/pkg/package.json': `{"author":"${EMAIL}"}`,
    'node_modules/pkg/big.bin': Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(`\0${TS_IP}\0`, 'latin1')]),
    'native/binding.node': 'unpacked beside it',
  }, { unpacked: ['native/binding.node'] });
  assert.deepEqual(asarFiles(asar).map(f => f.path), ['package.json', 'src/main.mjs', 'node_modules/pkg/package.json', 'node_modules/pkg/big.bin'], 'an unpacked file is in app.asar.unpacked, not here');
  const stats = { files: 0, text: 0, binary: 0, chunked: 0, unscanned: 0, unscannedPaths: [] };
  const hits = scanBuffer(asar, 'resources/app.asar', { patterns: BUILTIN, stats });
  assert.deepEqual(hits.map(h => [h.path, h.pattern, h.line]), [
    ['resources/app.asar/src/main.mjs', 'email', 1],
    ['resources/app.asar/node_modules/pkg/package.json', 'email', 1],
    ['resources/app.asar/node_modules/pkg/big.bin', 'tailscale-ip', -1],
  ]);
  assert.equal(stats.archived, 4);
  // The build outputs' entry allows the npm package's address, never our own file's.
  const allow = parseAllow('**/app.asar/node_modules/** email *');
  assert.deepEqual(hits.filter(h => !allowedBy(h, allow)).map(h => [h.path, h.pattern]), [['resources/app.asar/src/main.mjs', 'email'], ['resources/app.asar/node_modules/pkg/big.bin', 'tailscale-ip']]);
  // Not an asar (or a header whose files run past the end): the bytes, read as a binary, as before.
  const cut = asar.subarray(0, asar.length - 3);
  assert.equal(asarFiles(cut), null);
  assert.deepEqual(scanBuffer(cut, 'resources/app.asar', { patterns: BUILTIN }).map(h => [h.path, h.pattern]), [['resources/app.asar', 'email'], ['resources/app.asar', 'email']]);
  assert.equal(asarFiles(Buffer.from('not an archive at all')), null);
  assert.deepEqual(scanBuffer(asar, 'resources/app.bin', { patterns: BUILTIN }).map(h => h.path).filter(p => p !== 'resources/app.bin'), [], 'only a file named .asar');
  // The cli, on a folder holding one.
  const d = tmpdir(t);
  writeTree(d, { 'dist/win-unpacked/resources/app.asar': asar });
  const r = capture(['--dir', path.join(d, 'dist'), '--no-terms', '--allow', path.join(d, 'none'), '--summary']);
  assert.equal(r.code, 1);
  assert.match(r.out, /1 files under .*; 4 more inside asar archives\)/);
  assert.match(r.out, /^allowed by nothing \(no allowlist\): 0$/m, 'a list that isn\'t there allows nothing, and the summary says so');
});

// ------------------------------------------------------------ allowlist

test('allowlist: path globs, pattern, line id; an edited line is a hit again', () => {
  const line = 'Copyright (c) 2026 Quentin Example';
  const allow = parseAllow([
    '# comment', '',
    `LICENSE name ${lineId(line)}   # the copyright line`,
    'docs/**/*.md hostname *',
    'commit email *',
  ].join('\n'));
  const [h] = scanText(line, { patterns: ALL, path: 'LICENSE' });
  assert.equal(allowedBy(h, allow)?.line, 3);
  const [edited] = scanText(line + ' and friends', { patterns: ALL, path: 'LICENSE' });
  assert.equal(allowedBy(edited, allow), null);
  const [deep] = scanText(`on ${HOST}`, { patterns: ALL, path: 'docs/a/b/c.md' });
  assert.equal(allowedBy(deep, allow)?.line, 4);
  const [shallow] = scanText(`on ${HOST}`, { patterns: ALL, path: 'docs/c.md' });
  assert.equal(allowedBy(shallow, allow)?.line, 4, '**/ matches no folder too');
  const [other] = scanText(`on ${HOST}`, { patterns: ALL, path: 'docs/a/b/c.txt' });
  assert.equal(allowedBy(other, allow), null);
  const [copied] = scanText(line, { patterns: ALL, path: 'stage/NeverQuestAlone/LICENSE.txt' });
  assert.equal(allowedBy(copied, parseAllow(`** name ${lineId(line)}`))?.line, 1, 'a line allowed anywhere');
  assert.equal(allowedBy(copied, parseAllow(`LICENSE name ${lineId(line)}`)), null);
  assert.equal(allowedBy({ source: 'commit', path: 'commit abc1234 author', pattern: 'email', id: 'x' }, allow)?.line, 5);
  const [keyed] = scanText(line, { patterns: ALL, path: 'LICENSE', idKey: Buffer.from(ID_KEY) });
  assert.equal(allowedBy(keyed, allow), null, 'an unkeyed id does not match a keyed scan');
  assert.throws(() => parseAllow('LICENSE name'), /scrub-allow:1/);
  assert.throws(() => parseAllow('a b c d'), /scrub-allow:1/);
  // A second list's lines are named by its file.
  assert.equal(parseAllow('# x\ncommit email *', 'extra.txt')[0].line, 'extra.txt:2');
  assert.throws(() => parseAllow('a b', 'extra.txt'), /extra\.txt:1/);
});

test('--allow repeats: every list named is used, the default only when named; each list\'s unused lines are named by it', (t) => {
  const d = tmpdir(t);
  writeTree(d, { 'tree/a.txt': `mail ${EMAIL}\n`, 'tree/b.txt': `on ${TS_IP}\n` });
  const one = path.join(d, 'one.txt'), two = path.join(d, 'two.txt');
  fs.writeFileSync(one, 'a.txt email *\n');
  fs.writeFileSync(two, 'b.txt tailscale-ip *\nnowhere.txt email *\n');
  const tree = path.join(d, 'tree');
  assert.equal(capture(['--dir', tree, '--no-terms', '--allow', one]).code, 1, 'one list: b.txt still hits');
  const both = capture(['--dir', tree, '--no-terms', '--allow', one, '--allow', two, '--summary']);
  assert.equal(both.code, 0, both.out);
  assert.ok(both.out.includes(`allowed by ${one} and ${two}: 2`), `the summary names both lists: ${both.out}`);
  assert.match(both.out, /unused allow entries \(lines\): two\.txt:2/);
  assert.equal(capture(['--dir', tree, '--no-terms', '--allow', two]).code, 1, 'the first list is used only when named');
});

// ------------------------------------------------------------ the cli

test('cli --dir: exit 0 when clean, 1 with hits, values redacted; --json and --summary', (t) => {
  const d = tmpdir(t);
  const terms = path.join(d, 'terms.txt');
  const allow = path.join(d, 'allow.txt');
  fs.writeFileSync(terms, TERMS_TEXT);
  fs.writeFileSync(allow, '');
  const tree = path.join(d, 'tree');
  writeTree(tree, { 'README.md': 'nothing personal\n', 'src/a.mjs': 'export const x = 1;\n' });
  let r = capture(['--dir', tree, '--terms', terms, '--allow', allow]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /PASS: no hits/);

  writeTree(tree, { 'docs/setup.md': `ssh tiny\nmail ${EMAIL}\nsafe\nfrom ${TS_IP}\n` });
  r = capture(['--dir', tree, '--terms', terms, '--allow', allow]);
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(EMAIL) && !r.out.includes(TS_IP), r.out);
  assert.match(r.out, /^docs\/setup\.md:1:1 {2}ssh-alias/m);
  assert.match(r.out, /^docs\/setup\.md:4:6 {2}tailscale-ip {2}\[redacted, \d+ chars\]/m);
  assert.match(r.out, /^email +1 +0 +0$/m, 'counts are tree hits in --dir mode');
  assert.match(r.out, /^total +3 /m);
  assert.match(r.out, /FAIL: 3 hits/);

  const s = capture(['--dir', tree, '--terms', terms, '--allow', allow, '--summary']);
  assert.ok(!/docs\/setup\.md:/.test(s.out), 'summary prints counts only');

  const j = capture(['--dir', tree, '--terms', terms, '--allow', allow, '--json']);
  const data = JSON.parse(j.out);
  assert.equal(data.ok, false);
  assert.deepEqual(data.hits.map(h => h.pattern).sort(), ['email', 'ssh-alias', 'tailscale-ip']);
  assert.ok(!j.out.includes(EMAIL) && !j.out.includes(TS_IP));

  // Allow one of them by id; the unused entry is reported, not fatal.
  const emailId = lineId(`mail ${EMAIL}`);
  fs.writeFileSync(allow, `docs/setup.md email ${emailId}\nnowhere.md name *\n`);
  r = capture(['--dir', tree, '--terms', terms, '--allow', allow]);
  assert.match(r.out, /FAIL: 2 hits/);
  assert.ok(r.out.includes(`allowed by ${allow}: 1`), `the summary names the list it used: ${r.out}`);
  assert.match(r.out, /unused allow entries \(lines\): 2/);
});

test('cli: terms are required (no default file), from --terms, SCRUB_TERMS or --terms-env; bad arguments exit 2', (t) => {
  const d = tmpdir(t);
  const tree = path.join(d, 'tree');
  writeTree(tree, { 'a.txt': `x ${TS_IP}\non ${HOST}\n` });
  const terms = path.join(d, 'terms.txt');
  fs.writeFileSync(terms, TERMS_TEXT);
  const none = path.join(d, 'none.txt');
  let r = capture(['--dir', tree, '--allow', none]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no terms\. Pass --terms <file> or set SCRUB_TERMS=<file>/);
  r = capture(['--dir', tree, '--terms', path.join(d, 'missing.txt')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /no terms file at missing\.txt/);
  r = capture(['--dir', tree, '--no-terms', '--allow', none]);
  assert.equal(r.code, 1);
  assert.match(r.out, /a\.txt:1:3 {2}tailscale-ip/);
  assert.ok(!/hostname {2}\[/.test(r.out), 'built-ins only');
  for (const [argv, env] of [[['--dir', tree, '--allow', none], { [TERMS_ENV]: terms }], [['--dir', tree, '--allow', none, '--terms-env', 'CI_TERMS'], { CI_TERMS: TERMS_TEXT }]]) {
    r = capture(argv, env);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.out, /a\.txt:2:4 {2}hostname/, argv.join(' '));
  }
  r = capture(['--dir', tree, '--terms-env', 'CI_TERMS'], { CI_TERMS: '' });
  assert.equal(r.code, 2);
  assert.match(r.err, /\$CI_TERMS is empty or unset/);
  r = capture(['--dir', tree, '--terms-env', 'CI_TERMS'], { CI_TERMS: `# only comments\nid-key ${ID_KEY}\n` });
  assert.equal(r.code, 2, 'terms with no patterns are a mistake, not a pass');
  assert.match(r.err, /\$CI_TERMS defines no patterns/);
  for (const bad of [['--bogus'], ['--dir'], ['--dir', d, '--history'], ['--dir', d, '--repo', d], ['--dir', d, '--ref', 'HEAD'], ['--dir', path.join(d, 'nope'), '--no-terms'],
    ['--dir', d, '--terms', terms, '--no-terms'], ['--dir', d, '--terms', terms, '--terms-env', 'X'], ['--dir', d, '--no-terms', '--unscanned-ok', '*.zip'], ['--ref', '--bad']]) {
    assert.equal(capture(bad).code, 2, bad.join(' '));
  }
  const secret = 'zyxsecret';
  fs.writeFileSync(path.join(d, 'bad-terms.txt'), `# x\nhostname ${secret}(\n`);
  r = capture(['--dir', tree, '--terms', path.join(d, 'bad-terms.txt')]);
  assert.equal(r.code, 2);
  assert.match(r.err, /bad-terms\.txt:2: bad regex/);
  assert.ok(!r.err.includes(secret), 'a bad term is never printed');
  r = capture(['--dir', tree, '--terms-env', 'CI_TERMS'], { CI_TERMS: `ssh-alias ${secret} x` });
  assert.match(r.err, /\$CI_TERMS:1: ssh-alias takes one word/);
  assert.ok(!r.err.includes(secret));
});

test('the loaded terms are never skipped: a copy anywhere a scan reaches is a terms-file hit', (t) => {
  const d = tmpdir(t);
  const tree = path.join(d, 'tree');
  const body = TERMS_BODY + '\n';
  writeTree(tree, { 'tools/terms.txt': TERMS_TEXT, 'public/ok.md': 'fine\n', 'copy/unmarked.txt': `\r\n${body.replace(/\n/g, '\r\n')}  \r\n` });
  // Loaded from inside the tree: reported, content and all, with a note.
  const r = capture(['--dir', tree, '--terms', path.join(tree, 'tools', 'terms.txt'), '--allow', path.join(d, 'none'), '--json']);
  assert.equal(r.code, 1);
  assert.match(r.err, /the terms file is inside the scanned folder/);
  const hits = JSON.parse(r.out).hits;
  assert.ok(hits.some(h => h.pattern === 'terms-file' && h.where === 'tools/terms.txt:1:1'), JSON.stringify(hits));
  assert.ok(hits.some(h => h.pattern === 'hostname' && h.where.startsWith('tools/terms.txt:')), 'its lines are scanned too');
  // A copy without the marker line is found by content (line endings and blank edges don't matter).
  const unmarked = path.join(d, 'unmarked-terms.txt');
  fs.writeFileSync(unmarked, body);
  const r2 = JSON.parse(capture(['--dir', tree, '--terms', unmarked, '--allow', path.join(d, 'none'), '--json']).out);
  assert.ok(r2.hits.some(h => h.pattern === 'terms-file' && h.where === 'copy/unmarked.txt:1:1'), JSON.stringify(r2.hits));
  assert.ok(r2.hits.some(h => h.pattern === 'terms-file' && h.where === 'tools/terms.txt:1:1'), 'the marker line still counts');
  assert.ok(!r2.hits.some(h => h.where.startsWith('public/')));
});

test('the reviewer case: a squashed public repo that still holds the terms file fails, with --history too', (t) => {
  const d = tmpdir(t);
  const terms = path.join(d, 'private-terms.txt');
  fs.writeFileSync(terms, TERMS_TEXT);
  const repo = newRepo(d, 'public');
  writeTree(repo, { 'README.md': 'clean\n', 'tools/scrub-terms.txt': TERMS_TEXT, 'tools/scrub-scan.mjs': '// scanner\n' });
  commitAll(repo, 'Initial public release');
  for (const extra of [[], ['--history']]) {
    const r = capture(['--repo', repo, '--terms', terms, '--allow', path.join(d, 'none'), '--json', ...extra]);
    assert.equal(r.code, 1, extra.join(' '));
    const hits = JSON.parse(r.out).hits.filter(h => h.source !== 'commit');
    assert.ok(hits.some(h => h.pattern === 'terms-file' && h.where === 'tools/scrub-terms.txt:1:1'), JSON.stringify(hits));
  }
});

test('--strict: unscanned files fail unless the allowlist or --unscanned-ok names them', (t) => {
  const d = tmpdir(t);
  const tree = path.join(d, 'dist');
  writeTree(tree, { 'app/readme.txt': 'fine\n', 'Bones-1.0.dmg': Buffer.from([0x78, 0x01, 0, 1]), 'inner/payload.gz': Buffer.from([0x1f, 0x8b, 8, 0]) });
  const none = path.join(d, 'none');
  let r = capture(['--dir', tree, '--no-terms', '--allow', none]);
  assert.equal(r.code, 0, 'without --strict they are listed, not failed');
  assert.match(r.out, /^not scanned \(compressed\): Bones-1\.0\.dmg$/m);
  assert.match(r.out, /note: 2 files were not scanned; --strict fails on them/);
  r = capture(['--dir', tree, '--no-terms', '--allow', none, '--strict']);
  assert.equal(r.code, 1);
  assert.match(r.out, /^Bones-1\.0\.dmg {2}unscanned {2}\[not scanned: compressed\]/m);
  assert.match(r.out, /^inner\/payload\.gz {2}unscanned/m);
  r = capture(['--dir', tree, '--no-terms', '--allow', none, '--strict', '--unscanned-ok', '*.dmg']);
  assert.equal(r.code, 1, 'the glob is anchored: only top-level dmgs');
  assert.match(r.out, /FAIL: 1 hits/);
  r = capture(['--dir', tree, '--no-terms', '--allow', none, '--strict', '--unscanned-ok', '*.dmg', '--unscanned-ok', 'inner/*.gz', '--unscanned-ok', '*.zip']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /unused allow entries \(lines\): --unscanned-ok #3/);
  fs.writeFileSync(path.join(d, 'allow.txt'), '** unscanned *\n');
  assert.equal(capture(['--dir', tree, '--no-terms', '--allow', path.join(d, 'allow.txt'), '--strict']).code, 0);
});

test('cli entry point: runs as a script with the documented exit codes', (t) => {
  const d = tmpdir(t);
  writeTree(d, { 'clean.txt': 'nothing\n' });
  const env = { ...process.env };
  delete env[TERMS_ENV];
  let r = spawnSync(process.execPath, [SCANNER, '--dir', d, '--no-terms', '--allow', path.join(d, 'x')], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  writeTree(d, { 'leak.txt': `x ${EMAIL}\n` });
  r = spawnSync(process.execPath, [SCANNER, '--dir', d, '--no-terms', '--allow', path.join(d, 'x')], { encoding: 'utf8', env });
  assert.equal(r.status, 1);
  assert.ok(!r.stdout.includes(EMAIL));
  r = spawnSync(process.execPath, [SCANNER, '--dir', d], { encoding: 'utf8', env });
  assert.equal(r.status, 2, 'no terms, no default');
  r = spawnSync(process.execPath, [SCANNER, '--nope'], { encoding: 'utf8', env });
  assert.equal(r.status, 2);
});

// ------------------------------------------------------------ git: tree and history

test('git mode: what is committed at HEAD (or --ref), not the working tree', (t) => {
  const d = tmpdir(t);
  const repo = newRepo(d);
  const terms = path.join(d, 'terms.txt');
  fs.writeFileSync(terms, TERMS_TEXT);
  const none = path.join(d, 'none');
  writeTree(repo, { 'a.md': 'clean\n', 'b.md': `from ${TS_IP}\n` });
  commitAll(repo, 'one');
  const first = g(repo, 'rev-parse', 'HEAD').trim();
  writeTree(repo, { 'b.md': 'clean now\n' });
  commitAll(repo, 'two');
  // On disk: a.md gains a hit (uncommitted), b.md is deleted (uncommitted), c.md is untracked.
  writeTree(repo, { 'a.md': `from ${TS_IP_TOP}\n`, 'c.md': `from ${TS_IP_TOP}\n` });
  fs.rmSync(path.join(repo, 'b.md'));
  let r = capture(['--repo', repo, '--terms', terms, '--allow', none, '--json']);
  let data = JSON.parse(r.out);
  assert.equal(r.code, 0, r.out);
  assert.equal(data.stats.files, 2, 'the deleted b.md is still read, from its blob');
  assert.equal(data.stats.dirty, true);
  r = capture(['--repo', repo, '--terms', terms, '--allow', none]);
  assert.match(r.out, /note: the working tree differs from what was scanned/);
  r = capture(['--repo', repo, '--terms', terms, '--allow', none, '--ref', first, '--json']);
  data = JSON.parse(r.out);
  assert.equal(r.code, 1);
  assert.deepEqual(data.hits.map(h => `${h.where} ${h.pattern}`), ['b.md:1:6 tailscale-ip']);
  assert.equal(capture(['--repo', repo, '--terms', terms, '--ref', 'no-such-ref']).code, 2);
});

test('--history: old blobs, every old path (renamed away, same content, folders), messages and author lines', (t) => {
  const d = tmpdir(t);
  const repo = newRepo(d);
  writeTree(repo, {
    'README.md': 'clean\n',
    'docs/old.md': `tunnel over ssh tiny\nfrom ${TS_IP}\n`,
    [`notes/${HOST}.md`]: 'v1\n',
    [`setup/${HOST}-guide.md`]: 'guide\n',
    'a/same.md': 'same\n',
    [`b/${HOST}.md`]: 'same\n',
    [`${HOST}-dir/file.md`]: 'dir\n',
  });
  commitAll(repo, `first: set up the tunnel to ${HOST}`);
  fs.rmSync(path.join(repo, 'docs'), { recursive: true });
  fs.rmSync(path.join(repo, 'b'), { recursive: true });
  fs.rmSync(path.join(repo, `${HOST}-dir`), { recursive: true });
  g(repo, 'mv', `setup/${HOST}-guide.md`, 'setup/guide.md');
  writeTree(repo, { [`notes/${HOST}.md`]: 'v2\n', 'LICENSE': 'Copyright (c) 2026 Quentin\n' });
  commitAll(repo, 'second');
  g(repo, 'tag', '-a', 'v0.1', '-m', 'tagged by Quentin');
  writeTree(repo, { 'untracked.md': `from ${TS_IP_TOP}\n` });
  const terms = path.join(d, 'terms.txt');
  fs.writeFileSync(terms, `id-key ${ID_KEY}\n${TERMS_TEXT}`);
  const allow = path.join(d, 'allow.txt');
  fs.writeFileSync(allow, `LICENSE name ${lineId('Copyright (c) 2026 Quentin', Buffer.from(ID_KEY))}\n`);

  // Tree: the untracked file and the deleted docs/old.md aren't read; LICENSE is allowed (keyed id).
  let r = capture(['--repo', repo, '--terms', terms, '--allow', allow, '--json']);
  let data = JSON.parse(r.out);
  assert.equal(r.code, 1);
  assert.deepEqual(data.hits.map(h => h.where), ['notes/[hostname].md (name)']);
  assert.equal(data.allowed, 1);

  r = capture(['--repo', repo, '--terms', terms, '--allow', allow, '--history', '--json']);
  data = JSON.parse(r.out);
  const got = data.hits.map(h => `${h.source} ${h.pattern} ${h.where.replace(/\b[0-9a-f]{7}\b/g, 'SHA')}`).sort();
  assert.deepEqual(got, [
    'commit email history commit SHA author',
    'commit email history commit SHA author',
    'commit email history commit SHA committer',
    'commit email history commit SHA committer',
    'commit email history tag SHA tagger',
    'commit hostname history commit SHA message:1:29',
    'commit name history tag SHA message:1:11',
    'history hostname history [hostname]-dir (name)',
    'history hostname history [hostname]-dir/file.md (name)',
    'history hostname history b/[hostname].md (name)',
    'history hostname history setup/[hostname]-guide.md (name)',
    'history ssh-alias history blob SHA docs/old.md:1:13',
    'history tailscale-ip history blob SHA docs/old.md:2:6',
    'tree hostname notes/[hostname].md (name)',
  ]);
  assert.equal(data.history.commits, 2);
  assert.equal(data.history.tags, 1);
  assert.ok(!r.out.includes(EMAIL) && !r.out.includes(TS_IP) && !r.out.includes(HOST));
  // Its old versions: a terms file once committed is found in history too.
  writeTree(repo, { 'tools/terms.txt': TERMS_TEXT });
  commitAll(repo, 'oops');
  fs.rmSync(path.join(repo, 'tools'), { recursive: true });
  commitAll(repo, 'removed');
  data = JSON.parse(capture(['--repo', repo, '--terms', terms, '--allow', allow, '--history', '--json']).out);
  assert.ok(data.hits.some(h => h.pattern === 'terms-file' && /^history blob [0-9a-f]{7} tools\/terms\.txt:1:1$/.test(h.where)), JSON.stringify(data.hits));
});

// ------------------------------------------------------------ hygiene

const OWN = ['tools/scrub-scan.mjs', 'tools/scrub-allow.txt', 'tools/scrub-allow-unsigned.txt', 'tools/scrub-terms.example.txt', 'tools/check-fuses.mjs', 'tests/byok/scrub_scan_test.mjs', 'tests/byok/check_fuses_test.mjs'];

test('the private terms file is not tracked; the example is synthetic and parses', () => {
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files', '--', 'tools/scrub-terms.txt', '**/scrub-terms.txt']).toString().trim();
  assert.equal(tracked, '', 'tools/scrub-terms.txt must never be committed');
  assert.match(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'), /^tools\/scrub-terms\.txt$/m);
  const example = fs.readFileSync(path.join(ROOT, 'tools/scrub-terms.example.txt'), 'utf8');
  assert.ok(!example.split('\n').some(l => /^\s*#\s*scrub-terms:\s*private\b/i.test(l)), 'the example carries no private marker');
  const t = parseTerms(example, 'example');
  assert.ok(t.idKey && t.patterns.length >= 8);
});

test('the scanner, its allowlist, the example and these tests carry nothing the built-in patterns flag', () => {
  for (const rel of OWN) {
    const hits = scanBuffer(fs.readFileSync(path.join(ROOT, rel)), rel, { patterns: BUILTIN });
    assert.deepEqual(hits.map(h => `${h.line}:${h.pattern}`), [], rel);
  }
});

test('the same files carry none of the private terms', { skip: PRIVATE_TERMS ? false : NO_PRIVATE }, () => {
  const terms = loadTerms({ file: PRIVATE_TERMS });
  const pats = [...BUILTIN, ...terms.patterns];
  for (const rel of OWN) {
    const hits = scanBuffer(fs.readFileSync(path.join(ROOT, rel)), rel, { patterns: pats, terms: { real: terms.real, digest: terms.digest } });
    assert.deepEqual(hits.map(h => `${h.line}:${h.pattern}`), [], rel);
  }
});
