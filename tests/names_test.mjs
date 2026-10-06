// The name gate (rename spec §4.12): no tracked path or file may carry the project's or the
// product's earlier names, and no file a player or visitor gets may carry the owner's personal
// GitHub login or the retired gateway's name. The words, the login and the one separator live in tools/names.mjs, in ROT13. The
// allowlist is empty; an entry needs a critic's written OK in the commit that adds it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rot13, hits, handleHits, retiredHits, decodings } from '../tools/names.mjs';
import { exportPlan } from '../tools/shell-tree.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW = []; // { path, id, count, why }
// What a player or visitor gets: the source export (the whole product, its tests and tools;
// tools/shell-tree.mjs), the pages and docs it carries (docs/public, docs/build), the workflows and the
// issue template, the addon, the landing page and the store listing.
const shipped = files => { const pub = new Set(exportPlan(ROOT, files).files); return files.filter(f => pub.has(f) || /^(docs\/public|docs\/build|\.github|addon|site|brand\/listing)\//.test(f)); };
const tracked = () => execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const read = f => { const st = fs.lstatSync(path.join(ROOT, f), { throwIfNoEntry: false }); return st?.isFile() ? fs.readFileSync(path.join(ROOT, f)) : null; };

test('the gate still sees every spelling (planted, ROT13)', () => {
  const flag = ['[Jj][Bb][Jj][Pp][Yy][Nn][Jj]', 'jbj_pynj', 'nqqba/JbJPynj/HV.yhn', 'Obarf%20Pbzcnavba', 'Obarf Pbzcnavba',
    'Obarf&aofc;Pbzcnavba', 'Obarf\u00a0Pbzcnavba', 'Obarf\u200bPbzcnavba', 'Obarf\n-- Pbzcnavba', 'Obarf\n// Pbzcnavba\'f', 'Obarf\n * Pbzcnavba', 'Obarf\n# Pbzcnavba',
    'Obarf.Pbzcnavba-0.1.0.qzt', '**/jva-hacnpxrq/Obarf*Pbzcnavba.rkr', 'Obarf?Pbzcnavba', 'JbJ*Pynj',
    'obarf-pbzcnavba', 'ObarfPbzcnavba', 'JBJPYNJ_BCRA', 'pbz.obarfpbzcnavba.ncc', 'Obarf pbzcnavba'].map(rot13);
  for (const s of flag) assert.ok(hits(s).length, `not flagged: ${JSON.stringify(s)}`);
  const utf16 = Buffer.from(rot13('JbJPynj pncgher urycre'), 'utf16le');
  assert.ok(decodings('x.exe', Buffer.concat([Buffer.from([0]), utf16])).some(d => hits(d).length), 'UTF-16LE at an odd offset');
  const pass = ['/obarf pbzcnavba ba', '\\/obarf pbzcnavba', 'Obarf\n\nPbzcnavba', 'nfx Obarf. Pbzcnavba', 'Obarf**Pbzcnavba', 'ArireDhrfgNybar', 'Obarf', 'jbj, pynj'].map(rot13);
  for (const s of pass) assert.deepEqual(hits(s), [], `flagged: ${JSON.stringify(s)}`);
  assert.equal(handleHits(rot13('uggcf://tvguho.pbz/GbzzlTrbpb/arirerdhrfgnybar')).length, 1, 'the login, any case');
  assert.equal(handleHits(rot13('Gbzzl Trbpb')).length, 0, 'the legal name is not the login');
  for (const s of ['BcraPynj', 'bcra-pynj', 'BCRAPYNJ_TNGRJNL', '[Bb][Cc][Rr][Aa]pynj'].map(rot13)) assert.equal(retiredHits(s).length, 1, `the retired gateway's name: ${JSON.stringify(s)}`);
  for (const s of ['bcra n pynjf', 'ArireDhrfgNybar'].map(rot13)) assert.deepEqual(retiredHits(s), [], `not the retired name: ${JSON.stringify(s)}`);
});

test('no tracked path or file carries an earlier name', () => {
  const found = [];
  for (const f of tracked()) {
    for (const h of hits(f)) found.push(`${f} (path, ${h.id})`);
    const buf = read(f);
    if (!buf) continue;
    const counts = {};
    for (const d of decodings(f, buf)) for (const h of hits(d)) counts[h.id] = (counts[h.id] || 0) + 1;
    for (const [id, n] of Object.entries(counts)) {
      const a = ALLOW.find(x => x.path === f && x.id === id);
      if (!a || a.count !== n) found.push(`${f} (${n} × ${id})`);
    }
  }
  assert.deepEqual(found.slice(0, 50), [], `${found.length} hit(s): an earlier name is back; write NeverQuestAlone's (rename spec §4)`);
});

test('no file a player or visitor gets carries the retired gateway\'s name: the source export\'s own guard (the publish gate runs it too)', () => {
  const found = [];
  for (const f of shipped(tracked())) {
    const buf = read(f);
    if (retiredHits(f).length || (buf && decodings(f, buf).some(d => retiredHits(d).length))) found.push(f);
  }
  assert.deepEqual(found.slice(0, 50), [], `${found.length} file(s): "the retired build" or "the retired gateway" instead`);
});

test('no file a player or visitor gets carries the personal handle', () => {
  const found = [];
  for (const f of shipped(tracked())) {
    const buf = read(f);
    if (buf && decodings(f, buf).some(d => handleHits(d).length)) found.push(f);
  }
  assert.deepEqual(found.slice(0, 50), [], `${found.length} file(s): the handle only as the public repo's address or owner field (tools/names.mjs PUBLIC_HOME)`);
});

test('the handle as the public repo\'s owner (moved to the owner\'s account, 2026-10-05) is fine; anywhere else it is a hit', () => {
  const login = rot13('gbzzltrbpb');
  for (const fine of [`https://github.com/${login}/neverquestalone/releases`, `-R ${login}/neverquestalone --clobber`, `https://github.com/${login}/neverquestalone.git`,
    `the latest release of ${login}/neverquestalone.`, `/github\\.com\\/${login}\\/neverquestalone\\/blob/`, `          owner: ${login}`, `"owner": "${login}",`]) {
    assert.deepEqual(handleHits(fine), [], fine);
  }
  for (const leak of [`/Users/${login}/code`, `${login}/another-repo`, `com.${login}.app`, `by ${login}`, `1+${login}@users.noreply.github.com`,
    `${login}/neverquestalone-private`, `${login}.github.io/neverquestalone`, `x${login}/neverquestalone`, `owner: ${login}x`]) {
    assert.equal(handleHits(leak).length, 1, leak);
  }
});

test('every allowlist entry is still needed', () => {
  for (const a of ALLOW) assert.ok(fs.existsSync(path.join(ROOT, a.path)), `stale allowlist entry: ${a.path}`);
});
