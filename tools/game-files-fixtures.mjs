#!/usr/bin/env node
// The game-files parity fixtures (open-shell PRD §2; lane 2a): for each request parity case's reply
// (tools/last-request-fixtures.mjs, on bench-turn's harness), the files the game gets: every slot
// folder, the outbox and the reload inbox, as paths and bytes, with times, the bridge's random
// epochs and its version normalized. Until the shell and the WoW plugin are split, NeverQuestAlone
// must write the game exactly these.
//
// A fixture is {about, files, texts}: files maps each path to the sha256 (first 16 hex) of its
// normalized bytes, and texts holds the bytes of each. Paths are relative to the AddOns folder, or
// to the bridge's state folder for the outbox. In a file named for its slot (the TOC), "###" stands
// for the slot's own number, in its name and its bytes (lossless: the path holds it), so slots that
// hold the same bytes share one line: "NQA_S###/Inbox.lua [010-200]" is slots 10 to 200.
//
//   node tools/game-files-fixtures.mjs           record tests/fixtures/game-files-1.4/<case>.json
//   node tools/game-files-fixtures.mjs --check   compare instead; exits 1 when any differs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, recordOrCheck } from './last-request-fixtures.mjs';
import { SLOT_PREFIX } from '../bridge/transport/slots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIR = path.join(ROOT, 'tests', 'fixtures', 'game-files-1.4');

// What changes from run to run in the tables the bridge writes: times (the table's, the gateway's,
// a reply's id, the usage day), the bridge's and the map's random epochs, the bridge's version, and how
// many times it has published by then (a slower machine folds two status publishes into one: the
// anthropic case wrote push = 2 on a Windows runner against 3 here, test.yml run 37251830006).
const NORMALIZE = [
  [/\bts = "[^"]*"/g, 'ts = "<time>"'],
  [/\b(now|since) = \d+/g, '$1 = <time>'],
  [/\bmid = "byok:(c[0-9a-f]{6}):\d+"/g, 'mid = "byok:$1:<time>"'],
  [/\bday = "\d{4}-\d\d-\d\d"/g, 'day = "<day>"'],
  [/\bepoch = "[0-9a-z]+"/g, 'epoch = "<epoch>"'],
  [/\bver = "\d+\.\d+\.\d+"/g, 'ver = "<version>"'],
  [/\bpush = \d+/g, 'push = <push>'],
];
const normalize = s => NORMALIZE.reduce((t, [re, to]) => t.replace(re, to), s);
const idOf = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The files the game gets, after a case's reply: {files, texts}. Slot folders in order, each file
 * with the folder's own number as "###", runs of slots with the same bytes on one line.
 */
export function gameFiles({ addonsDir, stateDir }) {
  const texts = {};
  const files = {};
  const keep = s => { const id = idOf(s); texts[id] = s; return id; };
  const SLOT = new RegExp(`^${SLOT_PREFIX}(\\d{3})$`);
  const runs = new Map(); // "NQA_S###/<file>" → [[from, to, id]]
  for (const dir of fs.readdirSync(addonsDir).filter(d => SLOT.test(d)).sort()) {
    const n = dir.match(SLOT)[1];
    for (const f of fs.readdirSync(path.join(addonsDir, dir)).sort()) {
      // A file named for its slot (the TOC) names it inside too, as a number of its own ("Part 001",
      // never the "001" in "16001"); the slot tables never do.
      const own = s => (f.includes(n) ? s.replace(new RegExp(`(?<!\\d)${n}(?!\\d)`, 'g'), '###') : s);
      const key = `${SLOT_PREFIX}###/${own(f)}`;
      const id = keep(normalize(own(fs.readFileSync(path.join(addonsDir, dir, f), 'utf8'))));
      const list = runs.get(key) ?? [];
      const last = list.at(-1);
      if (last && last[2] === id && Number(last[1]) + 1 === Number(n)) last[1] = n;
      else list.push([n, n, id]);
      runs.set(key, list);
    }
  }
  for (const [key, list] of [...runs].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [from, to, id] of list) files[`${key} [${from}-${to}]`] = id;
  }
  const one = (name, file) => { files[name] = fs.existsSync(file) ? keep(normalize(fs.readFileSync(file, 'utf8'))) : null; };
  one('NeverQuestAlone/Inbox.lua', path.join(addonsDir, 'NeverQuestAlone', 'Inbox.lua'));
  one('<bridge state>/outbox.jsonl', path.join(stateDir, 'outbox.jsonl'));
  return { files, texts: Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a.localeCompare(b))) };
}

/** A case's fixture: the files its reply leaves for the game (gameFiles). */
export const filesFixture = (c, files) => ({ about: c.about, ...files });

/**
 * A recorded fixture as this normalizer reads it today: each text normalized again, with its id, and
 * slots that hold the same bytes now on one line again, so a rule added after a recording (the publish
 * count) applies to it as it does to a run. The parity test reads every recording through this.
 */
export function renormalized(fixture) {
  const now = {}; // the recorded id → today's
  const texts = {};
  for (const [id, t] of Object.entries(fixture.texts ?? {})) { const n = normalize(t); now[id] = idOf(n); texts[now[id]] = n; }
  const files = {};
  const RUN = /^(.*) \[(\d{3})-(\d{3})\]$/;
  let last = null; // the run written last: {key, from, to, id, name}
  for (const [name, id] of Object.entries(fixture.files ?? {})) {
    const m = name.match(RUN);
    const nid = id === null ? null : now[id] ?? id;
    if (m && last && last.key === m[1] && last.id === nid && Number(last.to) + 1 === Number(m[2])) {
      delete files[last.name];
      last = { ...last, to: m[3], name: `${m[1]} [${last.from}-${m[3]}]` };
    } else {
      last = m ? { key: m[1], from: m[2], to: m[3], id: nid, name } : null;
      if (!m) { files[name] = nid; continue; }
    }
    files[last.name] = nid;
  }
  return { ...fixture, files, texts: Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a.localeCompare(b))) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const differ = await recordOrCheck(DIR, async c => filesFixture(c, await runCase(c, gameFiles)), { check, log: l => console.log(l) });
  process.exitCode = check && differ.length ? 1 : 0;
}
