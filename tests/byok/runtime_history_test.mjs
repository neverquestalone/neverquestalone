// Per-chat transcripts and the history window (public BYOK PRD §6.4, RT-6, RT-9):
// bridge/byok/runtime/history.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTranscripts, estimateTokens, exchanges, compactText, rowUsage, HISTORY_BUDGET, RETENTION_DAYS, ROW_TOKENS } from '../../bridge/byok/runtime/history.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-history-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
const newDir = () => fs.mkdtempSync(path.join(tmp, 'data-'));
const DAY = 86400000;
const mode = p => fs.statSync(p).mode & 0o777;

test('history: rows are stored raw, one JSON line each, owner-only', () => {
  const dataDir = newDir();
  let t = 1_790_000_000_000;
  const tr = createTranscripts(dataDir, { now: () => t });
  assert.equal(tr.dir, path.join(dataDir, 'transcripts'));
  const raw = 'Here you go:\n\n```wowmap\n{"op":"clearall"}\n```\n\nTL;DR:\nCleared. | pipes stay';
  tr.append('c0ffee0', { role: 'user', text: 'clear my map' });
  t += 1000;
  tr.append('c0ffee0', { role: 'assistant', text: raw, kind: 'reply' });
  const file = path.join(dataDir, 'transcripts', 'c0ffee0.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]), { t: 1_790_000_001_000, role: 'assistant', text: raw, kind: 'reply' });
  assert.deepEqual(tr.rows('c0ffee0').map(r => r.text), ['clear my map', raw]);
  assert.deepEqual(tr.rows('c0ffee0', 1).map(r => r.role), ['assistant']);
  assert.deepEqual(tr.chats(), ['c0ffee0']);
  if (process.platform !== 'win32') {
    assert.equal(mode(path.join(dataDir, 'transcripts')), 0o700);
    assert.equal(mode(file), 0o600);
  }
  assert.throws(() => tr.append('c0ffee0', { role: 'system', text: 'x' }), /role/);
  // The addon's chat ids only (records.mjs): never a path, never a Windows device name.
  for (const bad of ['../escape', 'a/b', '', 'x'.repeat(65), 'c0ffee0.jsonl\0', 'CON', 'nul', 'AUX', 'com1', 'c1', 'C0FFEE0', 'c0ffee00', 'cgggggg']) {
    assert.throws(() => tr.append(bad, { role: 'user', text: 'x' }), /bad chat id/, JSON.stringify(bad));
  }
  assert.equal(fs.readdirSync(dataDir).join(), 'transcripts', 'nothing written outside the transcripts folder');
});

test('history (code health BR-22): a reply\'s row names its turn (run) and keeps its cost (usage), as whole numbers; a player\'s row keeps neither; the window sends neither', () => {
  const dataDir = newDir();
  let t = 1_790_000_000_000;
  const tr = createTranscripts(dataDir, { now: () => t });
  tr.append('c3f9a1e', { role: 'user', text: 'where now?', run: 'nqa:3fa9c2d1:a3f1_1', usage: { in: 1, out: 1, micros: 1 } });
  t += 1;
  tr.append('c3f9a1e', { role: 'assistant', text: 'East.', run: 'nqa:3fa9c2d1:a3f1_1', usage: { in: 2000.7, out: 80, micros: 4800, model: 'claude-sonnet-5-5', exact: false } });
  t += 1;
  tr.append('c3f9a1e', { role: 'assistant', text: 'No cost.', run: 'x'.repeat(201), usage: { in: 1 } });
  const rows = tr.rows('c3f9a1e', 10);
  assert.deepEqual([rows[0].run, rows[0].usage], [undefined, undefined], 'the player\'s row: neither');
  assert.deepEqual([rows[1].run, rows[1].usage], ['nqa:3fa9c2d1:a3f1_1', { in: 2000, out: 80, micros: 4800, model: 'claude-sonnet-5-5', exact: false }]);
  assert.deepEqual([rows[2].run, rows[2].usage], [undefined, undefined], 'a key past 200 characters, a cost with no out or micros: left off');
  assert.ok(tr.window('c3f9a1e', 1500).every(m => !('run' in m) && !('usage' in m)), 'what goes to the model has neither');
  assert.equal(rowUsage(null), null);
  assert.deepEqual(rowUsage({ in: 1, out: 2, micros: 3, model: 7, exact: 'yes' }), { in: 1, out: 2, micros: 3, model: '', exact: false });
});

test('history: an existing folder and file are tightened to owner-only', { skip: process.platform === 'win32' ? 'POSIX modes (0700, 0600): on Windows the data folder\'s ACL decides who reads it, which windows_smoke_test checks with icacls' : false }, () => {
  const dataDir = newDir();
  const dir = path.join(dataDir, 'transcripts');
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  fs.writeFileSync(path.join(dir, 'c1a2b3c.jsonl'), '', { mode: 0o644 });
  fs.chmodSync(path.join(dir, 'c1a2b3c.jsonl'), 0o644);
  createTranscripts(dataDir).append('c1a2b3c', { role: 'user', text: 'hi' });
  assert.equal(mode(dir), 0o700);
  assert.equal(mode(path.join(dir, 'c1a2b3c.jsonl')), 0o600);
});

test('history: the window is whole exchanges, newest first within the budget, returned oldest first', () => {
  const tr = createTranscripts(newDir(), { now: () => Date.now() });
  // Ten exchanges; each costs 100 + 100 tokens (400 characters each side).
  for (let i = 0; i < 10; i++) {
    tr.append('c000001', { role: 'user', text: `${i}`.padEnd(400, 'q') });
    tr.append('c000001', { role: 'assistant', text: `${i}`.padEnd(400, 'a') });
  }
  assert.equal(HISTORY_BUDGET, 1500);
  const w = tr.window('c000001');
  assert.equal(w.length, 14, '7 exchanges of 200 tokens fit 1,500; the 8th would not');
  assert.deepEqual(w.map(m => m.content[0]).join(''), '33445566778899');
  assert.deepEqual([...new Set(w.map((m, i) => (i % 2 ? m.role === 'assistant' : m.role === 'user')))], [true]);
  assert.equal(w.reduce((n, m) => n + estimateTokens(m.content), 0), 1400);
  assert.equal(tr.window('c000001', 400).length, 4, 'exactly the budget fits');
  assert.equal(tr.window('c000001', 399).length, 2);
  assert.equal(tr.window('c000001', 199).length, 0, 'the newest exchange alone is over budget: nothing, not half');
  assert.deepEqual(tr.window('c000001', 0), []);
  assert.deepEqual(tr.window('cabcdef'), []);
});

test('history: turns with no reply are left out, and a torn last line loses only itself', () => {
  const dataDir = newDir();
  const tr = createTranscripts(dataDir);
  tr.append('c000002', { role: 'user', text: 'q1' });
  tr.append('c000002', { role: 'assistant', text: 'a1' });
  tr.append('c000002', { role: 'user', text: 'this one errored' });
  tr.append('c000002', { role: 'user', text: 'q2' });
  tr.append('c000002', { role: 'assistant', text: 'a2' });
  tr.append('c000002', { role: 'assistant', text: 'a late second reply' });
  tr.append('c000002', { role: 'user', text: 'in flight' });
  assert.deepEqual(tr.window('c000002').map(m => m.content), ['q1', 'a1', 'q2', 'a2']);
  assert.deepEqual(exchanges([{ role: 'assistant' }, { role: 'user' }]), []);
  // A crash mid-append: half a JSON line, no newline.
  const file = path.join(dataDir, 'transcripts', 'c000002.jsonl');
  fs.appendFileSync(file, '{"t":1,"role":"user","te');
  tr.append('c000002', { role: 'assistant', text: 'after the crash' });
  const rows = tr.rows('c000002');
  assert.equal(rows.length, 8);
  assert.equal(rows[7].text, 'after the crash');
  assert.ok(fs.readFileSync(file, 'utf8').includes('"te\n{"t":'), 'the new row starts on its own line');
});

test('history: a long transcript is read from its end', () => {
  const tr = createTranscripts(newDir());
  // The file as 1,500 appends would leave it, written at once (the appends took 26 s under load).
  const t = Date.now();
  const row = (role, text) => JSON.stringify({ t, role, text });
  tr.append('c000003', { role: 'user', text: 'question 0 '.padEnd(60, '.') });
  tr.append('c000003', { role: 'assistant', text: 'answer 0 '.padEnd(60, '.') });
  const lines = [];
  for (let i = 1; i < 1500; i++) lines.push(row('user', `question ${i} `.padEnd(60, '.')), row('assistant', `answer ${i} `.padEnd(60, '.')));
  fs.appendFileSync(path.join(tr.dir, 'c000003.jsonl'), `${lines.join('\n')}\n`);
  assert.ok(fs.statSync(path.join(tr.dir, 'c000003.jsonl')).size > 64 * 1024);
  const w = tr.window('c000003');
  assert.equal(w.length, 100, '50 exchanges of 30 tokens (60 characters a side) fill 1,500');
  assert.match(w[w.length - 1].content, /^answer 1499 /);
  assert.match(w[0].content, /^question 1450 /);
  // A budget bigger than the tail read first still gets the whole file.
  assert.equal(tr.window('c000003', 1e6).length, 3000);
  // A tail with no whole exchange in it (a run of failed turns): the window reads further back.
  fs.appendFileSync(path.join(tr.dir, 'c000003.jsonl'), `${Array.from({ length: 1200 }, (_, i) => row('user', `failed ${i} `.padEnd(60, '.'))).join('\n')}\n`);
  // rows() reads the end too, and gets the same last rows as a whole read would.
  const last = tr.rows('c000003', 3);
  assert.deepEqual(last.map(r => r.text.split(' ')[0] + ' ' + r.text.split(' ')[1]), ['failed 1197', 'failed 1198', 'failed 1199']);
  assert.equal(tr.rows('c000003', 0).length, 3000 + 1200, 'limit 0: every row');
  const back = tr.window('c000003');
  assert.equal(back.length, 100);
  assert.match(back[back.length - 1].content, /^answer 1499 /);
});

test('history: 30-day retention, forget and delete all', () => {
  const dataDir = newDir();
  let now = 1_790_000_000_000;
  const tr = createTranscripts(dataDir, { now: () => now });
  assert.equal(RETENTION_DAYS, 30);
  tr.append('c000004', { role: 'user', text: 'old q', t: now - 40 * DAY });
  tr.append('c000004', { role: 'assistant', text: 'old a', t: now - 40 * DAY });
  tr.append('c000004', { role: 'user', text: 'new q' });
  tr.append('c000004', { role: 'assistant', text: 'new a' });
  tr.append('c000005', { role: 'user', text: 'ancient', t: now - 90 * DAY });
  tr.append('c000006', { role: 'user', text: 'keep' });
  assert.deepEqual(tr.window('c000004').map(m => m.content), ['new q', 'new a'], 'old turns never go back to the model');
  assert.deepEqual(tr.prune(), { files: 2, removed: 3 });
  assert.deepEqual(tr.rows('c000004').map(r => r.text), ['new q', 'new a']);
  assert.deepEqual(tr.chats().sort(), ['c000004', 'c000006'], 'an emptied transcript is deleted');
  assert.deepEqual(tr.prune(), { files: 0, removed: 0 });
  if (process.platform !== 'win32') assert.equal(mode(path.join(tr.dir, 'c000004.jsonl')), 0o600, 'a rewrite stays owner-only');
  now += 31 * DAY;
  assert.deepEqual(tr.prune(7), { files: 2, removed: 3 });
  tr.append('c000007', { role: 'user', text: 'x' });
  tr.append('c000008', { role: 'user', text: 'y' });
  assert.equal(tr.forget('c000007'), true);
  assert.equal(tr.forget('c000007'), false);
  assert.equal(tr.forgetAll(), 1);
  assert.deepEqual(tr.chats(), []);
  assert.deepEqual(createTranscripts(newDir()).chats(), [], 'no folder yet');
  assert.throws(() => createTranscripts(''), /data folder/);
});

// Code health BR-20: the retention prune read every transcript whole, twice, at start and daily.
test('history (code health BR-20): the prune reads a transcript whole only when its first row is past the retention; pruneAsync does the same with async reads, to the same files and rows', async () => {
  let now = 1_790_000_000_000;
  const seed = () => {
    const tr = createTranscripts(newDir(), { now: () => now });
    tr.append('c000004', { role: 'user', text: 'old q', t: now - 40 * DAY });
    tr.append('c000004', { role: 'assistant', text: 'old a', t: now - 40 * DAY });
    tr.append('c000004', { role: 'user', text: 'new q' });
    tr.append('c000004', { role: 'assistant', text: 'new a' });
    tr.append('c000005', { role: 'user', text: 'ancient', t: now - 90 * DAY });
    // A transcript with nothing old: a first row longer than the head's first read, and a torn line
    // in the middle (a crash), which every read skips and the prune leaves until its head ages.
    tr.append('c000006', { role: 'user', text: 'k'.repeat(10_000) });
    fs.appendFileSync(path.join(tr.dir, 'c000006.jsonl'), '{"t": 1, "role": "us\n');
    tr.append('c000006', { role: 'assistant', text: 'keep' });
    return tr;
  };
  const reads = [];
  const readFileSync = fs.readFileSync;
  fs.readFileSync = function (f, ...a) { reads.push(path.basename(String(f))); return readFileSync.call(this, f, ...a); };
  let sync;
  let syncReads;
  try {
    const tr = seed();
    sync = { result: tr.prune(), files: Object.fromEntries(tr.chats().sort().map(c => [c, fs.readFileSync(path.join(tr.dir, `${c}.jsonl`), 'utf8')])) };
    syncReads = reads.splice(0);
  } finally { fs.readFileSync = readFileSync; }
  assert.deepEqual(sync.result, { files: 2, removed: 3 });
  assert.deepEqual(syncReads.slice(0, 2).sort(), ['c000004.jsonl', 'c000005.jsonl'], 'only the transcripts with old rows are read whole');
  assert.deepEqual(Object.keys(sync.files), ['c000004', 'c000006']);
  assert.deepEqual(sync.files.c000004.trim().split('\n').map(l => JSON.parse(l).text), ['new q', 'new a']);
  assert.match(sync.files.c000006, /"role": "us\n/, 'a transcript with nothing old is left as it is');
  const atr = seed();
  assert.deepEqual(await atr.pruneAsync(), sync.result);
  assert.deepEqual(Object.fromEntries(atr.chats().sort().map(c => [c, fs.readFileSync(path.join(atr.dir, `${c}.jsonl`), 'utf8')])), sync.files, 'the same files, byte for byte');
  assert.deepEqual(await atr.pruneAsync(), { files: 0, removed: 0 });
  assert.deepEqual(atr.rows('c000006').map(r => r.text.slice(0, 4)), ['kkkk', 'keep']);
  // A month on, the first row of every transcript is past the retention: each read whole, pruned.
  now += 31 * DAY;
  assert.deepEqual(await atr.pruneAsync(), { files: 2, removed: 4 });
  assert.deepEqual(atr.chats(), []);
  assert.deepEqual(await createTranscripts(newDir()).pruneAsync(), { files: 0, removed: 0 }, 'no folder yet');
});

test('history (code health BR-20): a row appended while pruneAsync reads is never lost: a transcript written since its read is left for the next prune', async () => {
  let now = 1_790_000_000_000;
  for (let round = 0; round < 12; round++) {
    const tr = createTranscripts(newDir(), { now: () => now });
    for (let i = 0; i < 400; i++) tr.append('c000007', { role: i % 2 ? 'assistant' : 'user', text: `old ${i} `.padEnd(200, '.'), t: now - 40 * DAY });
    tr.append('c000007', { role: 'user', text: 'new 0' });
    // Rows go in, a tick apart, from before the prune starts until after it ends.
    let n = 0;
    let done = false;
    const pruning = tr.pruneAsync().finally(() => { done = true; });
    const appending = (async () => {
      for (let i = 0; i < round; i++) await new Promise(r => setImmediate(r));
      while (!done) { tr.append('c000007', { role: 'user', text: `live ${n++}` }); await new Promise(r => setImmediate(r)); }
    })();
    const r = await pruning;
    await appending;
    const texts = tr.rows('c000007', 0).map(x => x.text);
    for (let i = 0; i < n; i++) assert.ok(texts.includes(`live ${i}`), `round ${round}: live ${i} kept (${JSON.stringify(r)})`);
    assert.ok(texts.includes('new 0'));
    // Pruned or left whole, never half: the next prune finishes the job.
    if (r.removed) assert.equal(texts.filter(t => t.startsWith('old')).length, 0);
    await tr.pruneAsync();
    assert.equal(tr.rows('c000007', 0).filter(x => x.text.startsWith('old')).length, 0);
  }
});

test('history: user rows keep only the text, and rows carry their other players\' names', () => {
  const dataDir = newDir();
  const tr = createTranscripts(dataDir);
  const row = tr.append('c0ffee0', { role: 'user', text: '<game_data id="ab12">\n{"source":"game","game":{"state":{}}}\n</game_data id="ab12">\n\nwho made [Ring]?', names: ['Tavi', 'the', 'Tavi', 42, 'Arthas-Stormrage'] });
  assert.equal(row.text, 'who made [Ring]?', 'a data block that slips in is taken off');
  assert.deepEqual(row.names, ['Tavi', 'Arthas-Stormrage'], 'checked names, each once');
  const reply = tr.append('c0ffee0', { role: 'assistant', text: 'Tavi made it.', names: ['Tavi'] });
  assert.deepEqual(reply.names, ['Tavi']);
  assert.equal(tr.append('c0ffee0', { role: 'user', text: 'no names' }).names, undefined, 'no names, no field');
  tr.append('c0ffee0', { role: 'assistant', text: 'ok' });
  assert.deepEqual(tr.window('c0ffee0'), [
    { role: 'user', content: 'who made [Ring]?', names: ['Tavi', 'Arthas-Stormrage'] },
    { role: 'assistant', content: 'Tavi made it.', names: ['Tavi'] },
    { role: 'user', content: 'no names', names: [] },
    { role: 'assistant', content: 'ok', names: [] },
  ]);
  // A hand-edited row's names are checked on the way back too.
  fs.appendFileSync(path.join(tr.dir, 'c0ffee0.jsonl'), `${JSON.stringify({ t: Date.now(), role: 'user', text: 'x', names: ['ok', 'Bread', { a: 1 }] })}\n`);
  assert.deepEqual(tr.rows('c0ffee0').at(-1).names, ['Bread']);
});

test('history: rows are shortened for the window, so a route or a pasted error doesn\'t empty it', () => {
  const pts = Array.from({ length: 14 }, (_, i) => ({ m: 1412, x: 40 + i, y: 60, label: `${i + 1}. Some stop label here`, kind: 'kill', note: 'On the ridge north of the tents; pull them one at a time, they cast from range and flee.', q: [761, 766] }));
  const route = `Here is your route through Mulgore.\n\n\`\`\`wowmap\n${JSON.stringify({ op: 'set', layer: 'mulgore', title: 'Mulgore', ordered: true, points: pts })}\n{"op":"clear","layer":"old"}\nnot json\n\`\`\`\n\n\`\`\`wowchips\nRoute me there\n\`\`\`\n\nTL;DR:\nRoute drawn.`;
  assert.ok(estimateTokens(route) > 600, `${estimateTokens(route)} tokens stored`);
  const short = compactText(route);
  assert.equal(short, 'Here is your route through Mulgore.\n\n(wowmap block left out of the history: set layer mulgore, 14 stops; clear layer old; 1 line that couldn\'t be read)\n\n```wowchips\nRoute me there\n```\n\nTL;DR:\nRoute drawn.');
  assert.equal(compactText('```wowmap\n{"op":"clearall"}\n```'), '(wowmap block left out of the history: clear all layers)');
  // A pasted Lua error: the start and the end stay, around a marked cut.
  const paste = `My addon broke:\n${'Interface/AddOns/X/x.lua:12: attempt to index nil\n'.repeat(120)}What now?`;
  const cut = compactText(paste);
  assert.ok(estimateTokens(cut) <= ROW_TOKENS, `${estimateTokens(cut)} tokens`);
  assert.ok(cut.startsWith('My addon broke:\n'));
  assert.ok(cut.endsWith('What now?'));
  assert.match(cut, /\n\[… \d+ characters left out of the history …\]\n/);
  assert.equal(compactText('short'), 'short');
  // A cut never splits an emoji into a lone surrogate.
  for (let pad = 0; pad < 4; pad++) {
    const emoji = compactText('x'.repeat(pad) + '😀'.repeat(2000));
    assert.ok(!/[\u{d800}-\u{dfff}]/u.test(emoji), `pad ${pad}`);
  }

  const tr = createTranscripts(newDir());
  for (let i = 0; i < 5; i++) {
    tr.append('c0ffee0', { role: 'user', text: `question ${i}` });
    tr.append('c0ffee0', { role: 'assistant', text: `answer ${i} `.repeat(20) });
  }
  tr.append('c0ffee0', { role: 'user', text: paste });
  tr.append('c0ffee0', { role: 'assistant', text: `That's a nil index in x.lua line 12. ${'Here is why. '.repeat(60)}\n\nTL;DR:\nFix line 12.` });
  tr.append('c0ffee0', { role: 'user', text: '[NeverQuestAlone event] The route is finished. Sent by the addon, not typed by the player.' });
  tr.append('c0ffee0', { role: 'assistant', text: route });
  const w = tr.window('c0ffee0');
  assert.ok(w.length >= 8, `${w.length / 2} exchanges in the window (the stored rows alone would fit 0 or 1)`);
  assert.equal(w.at(-1).content, short);
  assert.ok(w.reduce((n, m) => n + estimateTokens(m.content), 0) <= HISTORY_BUDGET);
  assert.equal(tr.rows('c0ffee0').at(-1).text, route, 'the transcript itself keeps the whole reply');
});
