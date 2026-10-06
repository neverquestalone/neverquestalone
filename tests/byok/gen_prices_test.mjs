// tools/gen-prices.mjs (PRD §9.2, US-2): rebuilds prices.json from a
// models.dev api.json given on the command line, pruned to our models, keeping
// what models.dev can't express. Runs on a fixture; nothing is fetched.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildTable, manifestModels, entryFromModelsDev } from '../../tools/gen-prices.mjs';
import { loadPriceTable, createPriceBook } from '../../bridge/byok/usage/prices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOL = path.join(ROOT, 'tools', 'gen-prices.mjs');
const FIXTURE = path.join(ROOT, 'tests', 'byok', 'fixtures', 'models-dev-api.json');
const BUNDLED = path.join(ROOT, 'bridge', 'byok', 'usage', 'prices.json');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nqa-genprices-'));

test('the CLI rebuilds the table from a local api.json, pruned to our models', () => {
  const dir = tmp();
  const out = path.join(dir, 'prices.json');
  const emptyManifests = path.join(dir, 'manifests');
  fs.mkdirSync(emptyManifests);
  const stdout = execFileSync(process.execPath, [TOOL, FIXTURE, '--out', out, '--date', '2026-10-01', '--manifests', emptyManifests], { encoding: 'utf8' });
  assert.match(stdout, /wrote .*\(2026-10-01\)/);
  assert.match(stdout, /anthropic\/claude-sonnet-5: 2\/10 -> 3\/15/);
  assert.match(stdout, /xai\/grok-4\.7: kept \(not in models-dev-api\.json\)/);
  const t = loadPriceTable(out);
  assert.equal(t.date, '2026-10-01');
  assert.match(t.source, /models\.dev/);
  // Pruned: only the models we ship (the base table's: fix-102, every model the manifests list).
  const shipped = loadPriceTable(BUNDLED);
  for (const p of ['anthropic', 'openai', 'google', 'xai']) assert.deepEqual(Object.keys(t.providers[p].models).sort(), Object.keys(shipped.providers[p].models).sort(), p);
  assert.ok(Object.keys(t.providers.anthropic.models).includes('claude-sonnet-5-5'));
  assert.equal(t.providers.xai.models['grok-build-0.1'], undefined, 'a model models.dev lists and we don\'t ship stays out');
  assert.equal(t.providers.mistral, undefined);
  // The dated models.dev id fills our alias; Anthropic's 1-hour write is derived (2x input).
  assert.deepEqual(t.providers.anthropic.models['claude-haiku-4-5'], { input: 1, output: 5, cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 });
  assert.deepEqual(t.providers.anthropic.models['claude-sonnet-5'], { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 });
  // The base's long-context tier (prompts past 272K, fix-102) survives: models.dev can't say it.
  assert.deepEqual(t.providers.openai.models['gpt-6-luna'], { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, tiers: [{ minInput: 272001, input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 }] });
  // The scheduled Gemini change survives; models.dev can't say it.
  assert.deepEqual(t.providers.google.models['gemini-3.8-flash'].changes, [{ from: '2027-01-01T00:00:00Z', input: 1.5, output: 7.5, cacheRead: 0.15 }]);
  assert.equal(t.providers.google.models['gemini-3.8-flash'].reasoning, undefined, 'a reasoning price equal to output adds nothing');
  // context_over_200k becomes a tier; a model missing upstream keeps its entry.
  assert.deepEqual(t.providers.xai.models['grok-4.3'].tiers, [{ minInput: 200000, input: 2.5, output: 5, cacheRead: 0.4 }]);
  assert.deepEqual(t.providers.xai.models['grok-4.7'], loadPriceTable(BUNDLED).providers.xai.models['grok-4.7']);
  // Local stays $0 and OpenRouter keeps its exact flag.
  assert.equal(t.providers.ollama.local, true);
  assert.equal(t.providers.openrouter.exact, true);
  // The result drives a price book like the bundled one does.
  const b = createPriceBook({ bundled: t });
  assert.equal(b.priceFor('google', 'gemini-3.8-flash', '2027-03-01').output, 7.5);
  assert.equal(b.priceFor('anthropic', 'claude-sonnet-5').cacheWrite1h, 6);
});

test('--check passes on a fresh build and fails when prices moved', () => {
  const dir = tmp();
  const out = path.join(dir, 'prices.json');
  const manifests = path.join(dir, 'none');
  execFileSync(process.execPath, [TOOL, FIXTURE, '--out', out, '--manifests', manifests], { encoding: 'utf8' });
  const same = spawnSync(process.execPath, [TOOL, FIXTURE, '--out', out, '--manifests', manifests, '--check'], { encoding: 'utf8' });
  assert.equal(same.status, 0, same.stdout + same.stderr);
  const copy = path.join(dir, 'bundled-copy.json');
  fs.copyFileSync(BUNDLED, copy);
  const before = fs.readFileSync(copy, 'utf8');
  const moved = spawnSync(process.execPath, [TOOL, FIXTURE, '--out', copy, '--base', copy, '--manifests', manifests, '--check'], { encoding: 'utf8' });
  assert.equal(moved.status, 1);
  assert.match(moved.stdout, /out of date/);
  assert.match(moved.stdout, /claude-sonnet-5: 2\/10 -> 3\/15/);
  assert.equal(fs.readFileSync(copy, 'utf8'), before, '--check never writes');
});

test('bad invocations fail with a message, not a stack', () => {
  const out = path.join(tmp(), 'never.json'); // never the bundled file, even if a check broke
  const none = spawnSync(process.execPath, [TOOL], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: node tools\/gen-prices\.mjs/);
  const badDate = spawnSync(process.execPath, [TOOL, FIXTURE, '--out', out, '--date', 'tomorrow'], { encoding: 'utf8' });
  assert.equal(badDate.status, 2);
  assert.match(badDate.stderr, /--date must be YYYY-MM-DD/);
  const unknown = spawnSync(process.execPath, [TOOL, FIXTURE, '--out', out, '--fetch'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown option --fetch/);
  const missing = spawnSync(process.execPath, [TOOL, path.join(tmp(), 'no-api.json'), '--out', out], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /^gen-prices: ENOENT/);
  assert.equal(fs.existsSync(out), false);
});

test('manifest models join the list; a model priced nowhere is reported, not invented', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'google.json'), JSON.stringify({ id: 'google', models: [{ id: 'gemini-3.6-flash' }, 'gemini-3.8-flash', { id: 'gemini-imaginary' }] }));
  fs.writeFileSync(path.join(dir, 'ollama.json'), JSON.stringify({ id: 'ollama', models: ['qwen3:8b'] }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  const manifests = manifestModels(dir);
  assert.deepEqual(manifests, { google: ['gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-imaginary'], ollama: ['qwen3:8b'] });
  const api = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // A base table without the manifest's model (the bundled one lists every model since fix-102).
  const base = loadPriceTable(BUNDLED);
  delete base.providers.google.models['gemini-3.6-flash'];
  const { table, report } = buildTable(api, base, { date: '2026-10-02', manifests });
  assert.deepEqual(table.providers.google.models['gemini-3.6-flash'], { input: 0.5, output: 3 });
  assert.equal(table.providers.google.models['gemini-imaginary'], undefined);
  assert.ok(report.some(l => /gemini-imaginary: skipped/.test(l)));
  assert.deepEqual(table.providers.ollama.models, {}, 'local models need no price');
  assert.deepEqual(manifestModels(path.join(dir, 'missing')), {});
});

test('a cloud model models.dev lists at $0 is skipped, never shipped free; provider flags carry over', () => {
  const api = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  api.openai.models['gpt-6-luna'].cost = { input: 0, output: 0 };
  api.google.models['gemini-3.6-flash'].cost = { input: 0, output: 0 };
  // A base table without the manifest's model (the bundled one lists every model since fix-102).
  const base = loadPriceTable(BUNDLED);
  delete base.providers.google.models['gemini-3.6-flash'];
  const { table, report } = buildTable(api, base, { date: '2026-10-03', manifests: { google: ['gemini-3.6-flash'] } });
  assert.deepEqual(table.providers.openai.models['gpt-6-luna'], loadPriceTable(BUNDLED).providers.openai.models['gpt-6-luna'], 'the known price is kept');
  assert.ok(report.includes('openai/gpt-6-luna: kept ($0 in api.json)'), report.join('\n'));
  assert.equal(table.providers.google.models['gemini-3.6-flash'], undefined);
  assert.ok(report.some(l => /gemini-3\.6-flash: skipped \(\$0 in api\.json; counts at the provider's worst\)/.test(l)));
  assert.equal(table.providers.anthropic.reasoningInOutput, true);
  assert.equal(table.providers.xai.blockedRequestFee, 0.05);
  assert.deepEqual(table.providers.openrouter.unlisted, { input: 15, output: 75 });
  assert.deepEqual(table.providerFields, loadPriceTable(BUNDLED).providerFields);
});

test('entryFromModelsDev maps the fields and never fetches anything', () => {
  assert.deepEqual(entryFromModelsDev('openai', { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5, reasoning: 12 }),
    { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, reasoning: 12 });
  // Anthropic without a cache_write: 5-minute writes are 1.25x input, never 1x; every tier gets both writes.
  assert.deepEqual(entryFromModelsDev('anthropic', { input: 1, output: 5, context_over_200k: { input: 2, output: 7.5, cache_write: 2.5 } }),
    { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, tiers: [{ minInput: 200000, input: 2, output: 7.5, cacheWrite5m: 2.5, cacheWrite1h: 4 }] });
  assert.deepEqual(entryFromModelsDev('anthropic', { input: 4, output: 20, cache_read: 0.2, context_over_200k: { input: 8, output: 30 } }),
    { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, tiers: [{ minInput: 200000, input: 8, output: 30, cacheWrite5m: 10, cacheWrite1h: 16 }] });
  // Other providers keep a single write price, in tiers too.
  assert.deepEqual(entryFromModelsDev('xai', { input: 1, output: 2, context_over_200k: { input: 2, output: 4, cache_write: 3 } }).tiers,
    [{ minInput: 200000, input: 2, output: 4, cacheWrite: 3 }]);
  const src = fs.readFileSync(TOOL, 'utf8');
  assert.doesNotMatch(src, /\bfetch\(|node:https?|node:net/, 'the generator reads a local file only');
});
