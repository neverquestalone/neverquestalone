// No code path cuts the quest log below the game's cap (PROTOCOL §2.6): a
// source scan of the addon and the bridge for the shapes a
// quest cap has taken before (LIMITS.quests = 25, arr(s.quests, 25), a
// math.min on GetNumQuestLogEntries, a .slice on a quest list, the stale
// MAX_QUESTS global). tests/quest_log_full_test.mjs checks the behaviour; this
// keeps a new cap from creeping back in by the same door. No VM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function files(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    // A / path on every OS, as ALLOW names files (Windows CI 36645719445: addon\\NeverQuestAlone\\Paste.lua missed its allowance).
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory() && e.name !== 'node_modules') out.push(...files(rel, ext));
    else if (e.isFile() && e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}
// Comments blanked out (line numbers kept), so prose that names a cap doesn't count.
const code = (file, src) => (file.endsWith('.lua')
  ? src.replace(/--\[\[[\s\S]*?\]\]|--[^\n]*/g, m => m.replace(/[^\n]/g, ' '))
  : src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, a) => a + ' '.repeat(m.length - a.length)));

const SOURCES = [...files('addon', '.lua'), ...files('bridge', '.mjs')];
// Lines a rule may match that aren't a quest log cap, each with its file and why.
const ALLOW = [
  // MAP_LIMITS.quests (6) is the quest ids one map stop names, not the log: where it's set and where a
  // stop's q list is held to it (bridge/app/map-protocol.mjs), and Copy and Paste's copy (a pasted
  // route is held to what a route from the app is).
  ['bridge/app/map-protocol.mjs', /^export const MAP_LIMITS = \{ .*\bquests: 6\b/],
  ['bridge/app/map-protocol.mjs', /^const q = Array\.isArray\(p\.q\) .*\.slice\(0, MAP_LIMITS\.quests\) : \[\];$/],
  ['addon/NeverQuestAlone/Paste.lua', /^local MAP = \{ .*\bquests = 6\b/],
];
const allowed = (file, line) => ALLOW.some(([f, re]) => f === file && re.test(line.trim()));

// Each rule: what it catches, and a test on one file's lines (comments out) giving the bad lines' numbers.
const RULES = [
  ['LIMITS.quests', (lines) => lines.flatMap((l, i) => (/LIMITS\.quests\b/.test(l) ? [i] : []))],
  ['a quests field set to a number under 40', (lines) => lines.flatMap((l, i) => [...l.matchAll(/[{,]\s*quests\s*[:=]\s*(\d+)/g)].some(m => Number(m[1]) < 40) ? [i] : [])],
  ['arr(<x>.quests, N): a quest list cut to N', (lines) => lines.flatMap((l, i) => (/arr\(\s*\w*\.?quests\s*,/.test(l) ? [i] : []))],
  ['math.min on the quest log\'s entry count', (lines) => lines.flatMap((l, i) => (/math\.min\(\s*(qn|n)\s*,\s*\d+\s*\)/.test(l)
    && lines.slice(Math.max(0, i - 5), i + 6).some(x => x.includes('GetNumQuestLogEntries')) ? [i] : []))],
  // A quest list, then (in the same chain of calls) .slice(0, N).
  ['.slice(0, N) on a quest list', (lines) => lines.flatMap((l, i) => (/\bquests\b[\w$.?()[\]'"=>|&, ]*?\.slice\(0,\s*\d+\)/.test(l) ? [i] : []))],
];

test('quest caps: no addon or bridge code keeps fewer quests than the log holds', () => {
  assert.ok(SOURCES.length > 30, `${SOURCES.length} files scanned`);
  const found = [];
  for (const file of SOURCES) {
    const lines = code(file, fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n');
    for (const [what, rule] of RULES) for (const i of rule(lines)) if (!allowed(file, lines[i])) found.push(`${file}:${i + 1}: ${what}: ${lines[i].trim()}`);
  }
  assert.deepEqual(found, []);
  // Each allowance still matches a line, so a stale one goes.
  for (const [f, re] of ALLOW) assert.ok(code(f, fs.readFileSync(path.join(ROOT, f), 'utf8')).split('\n').some(l => re.test(l.trim())), `${f}: ${re} matches no line`);
});

test('quest caps: MAX_QUESTS (a stale 25 on WoW: Forever, whose log holds 40) is read only by /nqa apicheck, to show it; the cap is ns.QuestLogMax', () => {
  const found = [];
  for (const file of SOURCES.filter(f => f.endsWith('.lua'))) {
    let src = code(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    if (file.endsWith('Companion.lua')) src = src.replace(/function P\.ApiCheck\(\)[\s\S]*?\nend\n/, m => m.replace(/[^\n]/g, ' '));
    src.split('\n').forEach((l, i) => { if (/(?<![\w"])MAX_QUESTS(?![\w"])/.test(l)) found.push(`${file}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(found, []);
  const store = fs.readFileSync(path.join(ROOT, 'addon/NeverQuestAlone/Store.lua'), 'utf8');
  assert.match(store, /function ns\.QuestLogMax\(/);
  for (const file of ['addon/NeverQuestAlone/QoL.lua', 'addon/NeverQuestAlone/Chats.lua', 'addon/NeverQuestAlone/Companion.lua', 'addon/NeverQuestAlone/Map.lua']) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /ns\.QuestLog(Max)?\(/, `${file} reads the log or its cap through Store.lua`);
  }
});

test('the addon reads every quest without opening a header (PROTOCOL §2.6): no Lua calls ExpandQuestHeader or CollapseQuestHeader, so it fires no QUEST_LOG_UPDATE of its own and needs no filter for one', () => {
  const found = [];
  for (const file of SOURCES.filter(f => f.endsWith('.lua'))) {
    code(file, fs.readFileSync(path.join(ROOT, file), 'utf8')).split('\n').forEach((l, i) => {
      if (/\b(Expand|Collapse)QuestHeader\b|QuestLogOwnUpdate/.test(l)) found.push(`${file}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(found, []);
});

test('quest caps: the scan catches each shape it looks for', () => {
  const hits = (src, file = 'x.lua') => RULES.filter(([, rule]) => rule(code(file, src).split('\n')).length).map(([what]) => what);
  assert.deepEqual(hits('local LIMITS = { quests = 25, obj = 5 }\nif #out >= LIMITS.quests then break end'), ['LIMITS.quests', 'a quests field set to a number under 40']);
  assert.deepEqual(hits('const quests = arr(s.quests, 25);', 'x.mjs'), ['arr(<x>.quests, N): a quest list cut to N']);
  assert.deepEqual(hits('local qn = C_QuestLog.GetNumQuestLogEntries()\nfor i = 1, math.min(qn, 40) do end'), ['math.min on the quest log\'s entry count']);
  assert.deepEqual(hits('const lines = quests.slice(0, 25).map(q => q.id);', 'x.mjs'), ['.slice(0, N) on a quest list']);
  assert.deepEqual(hits('out.quests = (doc.quests || []).filter(q => q.id).slice(0, 25);', 'x.mjs'), ['.slice(0, N) on a quest list']);
  assert.deepEqual(hits('say(ok, `the quest file (${quests})`, err.split(\'\\n\').slice(0, 3).join(\' | \'));', 'x.mjs'), [], 'another list on a line that names quests');
  assert.deepEqual(hits('-- LIMITS.quests = 25 was the old cap\nlocal quests = 0'), [], 'comments and a counter are fine');
});
