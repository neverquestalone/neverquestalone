// Parity (open-shell PRD §2, §3; lane 2a): until the shell and the WoW plugin are split, NeverQuestAlone
// sends the AI and writes the game exactly what it did before the split began. For each case of
// tools/last-request-fixtures.mjs (game state, a message or a check-in, and settings in), byte for
// byte, with only times and random ids normalized:
//   - the request the AI gets (the app's "Last request" view), and the sends tools/nqa-replay.mjs
//     prints for the case's records (the turn the core hands the backend):
//     tests/fixtures/last-request-1.4/<case>.json;
//   - the files its reply leaves for the game (every slot folder, the outbox and the reload inbox):
//     tests/fixtures/game-files-1.4/<case>.json (tools/game-files-fixtures.mjs), read through the
//     normalizer the run's files go through (renormalized), so a recording and a run differ only where
//     the game's files do.
// A change that's meant to change one re-records it with those tools, in a commit of its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CASES, DIR as REQUESTS, runCase, lastRequest, requestFixture, text } from '../tools/last-request-fixtures.mjs';
import { DIR as FILES, gameFiles, filesFixture, renormalized } from '../tools/game-files-fixtures.mjs';

const recorded = (dir, c) => fs.readFileSync(path.join(dir, `${c.id}.json`), 'utf8');

for (const c of CASES) {
  test(`parity, ${c.id}: the request, the core's sends and the game's files are the recorded ones`, async () => {
    const played = await runCase(c, async ctx => ({ request: await lastRequest(ctx), files: gameFiles(ctx) }));
    assert.equal(text(requestFixture(c, played.request)), recorded(REQUESTS, c), `tests/fixtures/last-request-1.4/${c.id}.json (re-record: node tools/last-request-fixtures.mjs)`);
    assert.equal(text(filesFixture(c, played.files)), text(renormalized(JSON.parse(recorded(FILES, c)))), `tests/fixtures/game-files-1.4/${c.id}.json (re-record: node tools/game-files-fixtures.mjs)`);
  });
}

test('parity: every case has both fixtures, and no fixture is left without its case', () => {
  const ids = CASES.map(c => `${c.id}.json`).sort();
  assert.deepEqual(fs.readdirSync(REQUESTS).sort(), ids);
  assert.deepEqual(fs.readdirSync(FILES).sort(), ids);
});

test('parity: a recording is read through today\'s normalizer: a publish count in it reads as <push>, with its id, and slots that now match share a line again', () => {
  const at = n => `NQA_SlotData = {\n\tbridge = { ver = "<version>", push = ${n}, epoch = "<epoch>" },\n}\n`;
  const ids = { a: 'aaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbb', nil: 'cccccccccccccccc', inbox: 'dddddddddddddddd' };
  const old = {
    about: 'a recording made before the rule',
    files: { 'NQA_S###/Inbox.lua [001-004]': ids.a, 'NQA_S###/Inbox.lua [005-009]': ids.b, 'NQA_S###/Inbox.lua [010-200]': ids.nil, 'NeverQuestAlone/Inbox.lua': ids.inbox, '<bridge state>/outbox.jsonl': null },
    texts: { [ids.a]: at(2), [ids.b]: at(3), [ids.nil]: 'NQA_SlotData = nil\n', [ids.inbox]: `NQA_Inbox = { push = 3 }\n` },
  };
  const read = renormalized(old);
  const slot = Object.keys(read.texts).find(id => read.texts[id].includes('NQA_SlotData = {'));
  assert.deepEqual(Object.keys(read.files), ['NQA_S###/Inbox.lua [001-009]', 'NQA_S###/Inbox.lua [010-200]', 'NeverQuestAlone/Inbox.lua', '<bridge state>/outbox.jsonl']);
  assert.equal(read.files['NQA_S###/Inbox.lua [001-009]'], slot);
  assert.match(read.texts[slot], /push = <push>,/);
  assert.equal(read.texts[read.files['NeverQuestAlone/Inbox.lua']], 'NQA_Inbox = { push = <push> }\n');
  assert.equal(read.files['<bridge state>/outbox.jsonl'], null);
  assert.equal(Object.keys(read.texts).length, 3, 'the two slot tables are one text now');
  assert.deepEqual(renormalized(read), read, 'today\'s recordings read as they are');
});
