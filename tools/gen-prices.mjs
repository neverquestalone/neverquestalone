#!/usr/bin/env node
// Rebuild bridge/byok/usage/prices.json from a models.dev api.json (PRD §9.2,
// US-2). Never fetches: download https://models.dev/api.json yourself (MIT)
// and pass its path, so the build stays offline and reviewable.
//
//   node tools/gen-prices.mjs <api.json> [--base <prices.json>] [--out <file>]
//                             [--date YYYY-MM-DD] [--manifests <dir>] [--check]
//
// The model list is the base table's models plus any model named in the
// provider manifests (bridge/byok/providers/manifests/*.json, when present).
// models.dev supplies input, output, cache_read, cache_write (the 5-minute
// write), reasoning and context_over_200k. It can't express what the base
// table keeps: scheduled price changes (Gemini 3.8 Flash from 2027-01-01),
// Anthropic's cache writes (derived here when missing: 5-minute 1.25x and
// 1-hour 2x input, in every tier too), provider flags, and long-context tiers
// it lacks. Local providers stay $0 and OpenRouter keeps its exact-cost flag.
// A cloud model models.dev prices at $0/$0 is skipped, not shipped free.
// --check exits 1 when the output would differ from --out (for CI).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTable } from '../bridge/byok/usage/prices.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE = path.join(ROOT, 'bridge/byok/usage/prices.json');
const DEFAULT_MANIFESTS = path.join(ROOT, 'bridge/byok/providers/manifests');
// Our provider id → models.dev provider id.
const MODELS_DEV_ID = { anthropic: 'anthropic', openai: 'openai', google: 'google', xai: 'xai' };
const round = x => Math.round(x * 1e6) / 1e6;
// JSON with sorted keys, so --check ignores key order in a hand-edited file.
const canonical = v => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

function parseArgs(argv) {
  const args = { api: null, base: DEFAULT_BASE, out: null, date: null, manifests: DEFAULT_MANIFESTS, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') args.check = true;
    else if (['--base', '--out', '--date', '--manifests'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      args[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (!args.api) args.api = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (!args.api) throw new Error('usage: node tools/gen-prices.mjs <models.dev api.json> [--base f] [--out f] [--date YYYY-MM-DD] [--manifests dir] [--check]');
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Error('--date must be YYYY-MM-DD');
  args.out ??= args.base;
  return args;
}

/** Model ids named in the provider manifests, by provider id (tolerant of shape). */
export function manifestModels(dir) {
  const out = {};
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    let m;
    try { m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const id = typeof m?.id === 'string' ? m.id : path.basename(f, '.json');
    const ids = new Set();
    const take = v => {
      if (typeof v === 'string') ids.add(v);
      else if (Array.isArray(v)) v.forEach(take);
      else if (v && typeof v === 'object' && typeof v.id === 'string') ids.add(v.id);
    };
    take(m?.models);
    take(m?.defaults?.model);
    take(m?.defaults?.smarter);
    take(m?.default);
    take(m?.smarter);
    if (ids.size) out[id] = [...ids];
  }
  return out;
}

/** Anthropic's writes: models.dev's cache_write is the 5-minute one (else 1.25x input); 1-hour is 2x input. */
function anthropicWrites(e, cost) {
  e.cacheWrite5m = round(Number.isFinite(cost.cache_write) ? cost.cache_write : 1.25 * cost.input);
  e.cacheWrite1h = round(2 * cost.input);
}

/** One table entry from a models.dev model, keeping what models.dev can't say. */
export function entryFromModelsDev(provider, cost, base = {}) {
  const e = { input: round(cost.input), output: round(cost.output) };
  if (Number.isFinite(cost.cache_read)) e.cacheRead = round(cost.cache_read);
  if (provider === 'anthropic') anthropicWrites(e, cost);
  else if (Number.isFinite(cost.cache_write)) e.cacheWrite = round(cost.cache_write);
  if (Number.isFinite(cost.reasoning) && cost.reasoning !== cost.output) e.reasoning = round(cost.reasoning);
  const over = cost.context_over_200k;
  if (over && Number.isFinite(over.input) && Number.isFinite(over.output)) {
    const t = { minInput: 200000, input: round(over.input), output: round(over.output) };
    if (Number.isFinite(over.cache_read)) t.cacheRead = round(over.cache_read);
    if (provider === 'anthropic') anthropicWrites(t, over);
    else if (Number.isFinite(over.cache_write)) t.cacheWrite = round(over.cache_write);
    e.tiers = [t];
  } else if (base.tiers) e.tiers = base.tiers;
  if (base.changes) e.changes = base.changes;
  return e;
}

const stripDate = id => id.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, '');

function findInModelsDev(mdModels, id) {
  if (!mdModels) return null;
  if (Object.hasOwn(mdModels, id)) return mdModels[id];
  // models.dev may list only the dated id ("claude-haiku-4-5-20251001").
  for (const [k, v] of Object.entries(mdModels)) if (stripDate(k) === id) return v;
  return null;
}

/** Build the new table and a list of what changed. Pure apart from its inputs. */
export function buildTable(api, base, { date, manifests = {}, apiName = 'api.json' } = {}) {
  const providers = {};
  const report = [];
  for (const [pid, bp] of Object.entries(base.providers)) {
    const out = { ...bp, models: {} };
    const ids = [...new Set([...Object.keys(bp.models ?? {}), ...(manifests[pid] ?? [])])];
    const mdId = MODELS_DEV_ID[pid];
    for (const id of ids) {
      const prev = bp.models && Object.hasOwn(bp.models, id) ? bp.models[id] : undefined;
      const md = mdId && api && Object.hasOwn(api, mdId) ? findInModelsDev(api[mdId]?.models, id) : null;
      const cost = md?.cost;
      if (bp.local || bp.exact) { // $0, or priced by the provider's exact usage.cost
        if (prev) out.models[id] = prev;
        continue;
      }
      const priced = cost && Number.isFinite(cost.input) && Number.isFinite(cost.output) && cost.input >= 0 && cost.output >= 0;
      if (!priced || (cost.input === 0 && cost.output === 0)) {
        const why = priced ? `$0 in ${apiName}` : cost ? `no usable price in ${apiName}` : `not in ${apiName}`;
        if (prev) { out.models[id] = prev; report.push(`${pid}/${id}: kept (${why})`); }
        else report.push(`${pid}/${id}: skipped (${priced ? why : 'no price anywhere'}; counts at the provider's worst)`);
        continue;
      }
      const next = entryFromModelsDev(pid, cost, prev);
      out.models[id] = next;
      const was = prev ? `${prev.input}/${prev.output}` : 'new';
      if (!prev || canonical(prev) !== canonical(next)) report.push(`${pid}/${id}: ${was} -> ${next.input}/${next.output}`);
    }
    providers[pid] = out;
  }
  const table = {
    v: 1,
    date: date ?? base.date,
    source: `models.dev ${apiName}, pruned to the manifests' models; provider pricing pages for scheduled changes and Anthropic 1-hour writes`,
    unit: 'USD per 1M tokens',
    fields: base.fields,
    ...(base.providerFields ? { providerFields: base.providerFields } : {}),
    providers,
  };
  validateTable(table);
  return { table, report };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = JSON.parse(fs.readFileSync(args.api, 'utf8'));
  const base = validateTable(JSON.parse(fs.readFileSync(args.base, 'utf8')));
  const { table, report } = buildTable(api, base, {
    date: args.date ?? new Date().toISOString().slice(0, 10),
    manifests: manifestModels(args.manifests),
    apiName: path.basename(args.api),
  });
  const text = JSON.stringify(table, null, 2) + '\n';
  if (args.check) {
    let have = null;
    try { have = fs.readFileSync(args.out, 'utf8'); } catch { /* missing counts as different */ }
    let same = false;
    try { same = have !== null && canonical({ ...JSON.parse(have), date: null, source: null }) === canonical({ ...table, date: null, source: null }); } catch { /* unreadable counts as different */ }
    console.log(same ? 'prices: up to date' : `prices: out of date\n${report.join('\n')}`);
    process.exitCode = same ? 0 : 1;
    return;
  }
  fs.writeFileSync(args.out, text);
  console.log(`prices: wrote ${path.relative(process.cwd(), args.out) || args.out} (${table.date})`);
  for (const line of report) console.log(`  ${line}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(`gen-prices: ${e.message}`); process.exitCode = 2; }
}
