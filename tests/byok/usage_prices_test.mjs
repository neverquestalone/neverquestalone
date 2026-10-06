// Price lookups (PRD §9.2, US-2): the bundled dated table, the Gemini 3.8
// Flash date switch, unknown models at the provider's most expensive, local $0,
// OpenRouter's exact-cost flag and ceiling, and a refreshed table
// that can only raise a price the cap uses and can't switch the cap off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, worstPriceFor, createPriceBook, higherOf, loadPriceTable, validateTable, effectivePrice } from '../../bridge/byok/usage/prices.mjs';
import { estimateMicros } from '../../bridge/byok/usage/meter.mjs';
import { getManifest } from '../../bridge/byok/providers/index.mjs';

const pick = p => ({ input: p.input, output: p.output, cacheRead: p.cacheRead, cacheWrite: p.cacheWrite, cacheWrite1h: p.cacheWrite1h });

test('the bundled table is dated, validated and prices every model the manifests list (fix-102: the whole lineups)', () => {
  const t = loadPriceTable();
  assert.equal(t.date, '2026-09-30');
  assert.match(t.source, /each AI company's own pricing page, read 2026-09-30/);
  assert.equal(t.unit, 'USD per 1M tokens');
  for (const p of ['anthropic', 'openai', 'google', 'xai']) {
    const m = getManifest(p);
    assert.ok(t.providers[p].models[m.models.default], `${p}: its default, ${m.models.default}`);
    for (const e of m.models.list) assert.ok(t.providers[p].models[e.id], `${p}/${e.id}: a model setup offers has a price`);
  }
  assert.equal(t.providers.ollama.local, true);
  assert.equal(t.providers.lmstudio.local, true);
  assert.equal(t.providers.openrouter.exact, true);
  assert.equal(t.providers.anthropic.reasoningInOutput, true);
  assert.equal(t.providers.openai.reasoningInOutput, true);
  assert.equal(t.providers.google.reasoningInOutput, undefined, 'Gemini counts thinking apart from output');
  assert.equal(t.providers.xai.blockedRequestFee, 0.05);
});

// Each AI company's own pricing page, read 2026-09-30 (fix-102; the manifests' sources name them):
// Anthropic's cache hits are 0.1x input (0.05x on Opus 5.5, 0.025x on Fable 5.1), writes 1.25x and 2x;
// OpenAI's and Google's prompts past 272K and 200K, and xAI's from 200K, are tiers no turn reaches.
test('prices per 1M tokens match each AI company\'s pricing page (fix-102, 2026-09-30)', () => {
  const at = '2026-09-26T12:00:00Z';
  const want = {
    anthropic: {
      'claude-sonnet-5-5': [2, 10, 0.2, 2.5, 4], 'claude-opus-5-5': [4, 20, 0.2, 5, 8], 'claude-fable-5-1': [10, 50, 0.25, 12.5, 20],
      'claude-sonnet-5': [2, 10, 0.2, 2.5, 4], 'claude-haiku-4-5': [1, 5, 0.1, 1.25, 2],
    },
    openai: {
      'gpt-6.1-sol': [2, 10, 0.1, 2.5, 2.5], 'gpt-6-sol': [2, 10, 0.2, 2.5, 2.5], 'gpt-6-luna': [0.1, 0.5, 0.01, 0.125, 0.125], 'gpt-6-astra': [10, 50, 1, 12.5, 12.5],
      'gpt-5.6-sol': [4, 20, 0.4, 5, 5], 'gpt-5.6-terra': [2, 12, 0.2, 2.5, 2.5], 'gpt-5.6-luna': [0.2, 1.2, 0.02, 0.25, 0.25],
    },
    // No cache write price: writes bill at the input price, never cheaper.
    xai: {
      'grok-4.7': [2, 6, 0.5, 2, 2], 'grok-4.6': [2, 6, 0.5, 2, 2], 'grok-4.5': [2, 6, 0.3, 2, 2], 'grok-4.3': [1.25, 2.5, 0.2, 1.25, 1.25],
      'grok-4.20-0309-reasoning': [1.25, 2.5, 0.2, 1.25, 1.25], 'grok-4.20-0309-non-reasoning': [1.25, 2.5, 0.2, 1.25, 1.25],
    },
    google: {
      'gemini-3.8-flash': [0.75, 3.75, 0.075, 0.75, 0.75], 'gemini-3.7-flash': [0.75, 3.75, 0.075, 0.75, 0.75], 'gemini-3.6-flash': [0.75, 3.75, 0.075, 0.75, 0.75],
      'gemini-3.5-flash-lite': [0.3, 2.5, 0.03, 0.3, 0.3], 'gemini-3.5-flash': [1.5, 9, 0.15, 1.5, 1.5], 'gemini-3.1-flash-lite': [0.25, 1.5, 0.025, 0.25, 0.25],
      'gemini-3.1-pro-preview': [2, 12, 0.2, 2, 2], 'gemini-3-flash-preview': [0.5, 3, 0.05, 0.5, 0.5],
    },
  };
  for (const [p, models] of Object.entries(want)) {
    for (const [id, [input, output, cacheRead, cacheWrite, cacheWrite1h]] of Object.entries(models)) {
      assert.deepEqual(pick(priceFor(p, id, at)), { input, output, cacheRead, cacheWrite, cacheWrite1h }, `${p}/${id}`);
    }
  }
  // No documented cache price: reads bill at the input price, never cheaper.
  assert.deepEqual(pick(effectivePrice({ input: 0.3, output: 2.5 })), { input: 0.3, output: 2.5, cacheRead: 0.3, cacheWrite: 0.3, cacheWrite1h: 0.3 });
  const h = priceFor('anthropic', 'claude-haiku-4-5', at);
  assert.equal(h.known, true);
  assert.equal(h.local, false);
  assert.equal(h.exact, false);
  assert.equal(h.reasoning, 5, 'thinking bills as output');
  assert.equal(h.reasoningInOutput, true);
  assert.equal(h.blockedRequestFee, 0);
  assert.equal(priceFor('xai', 'grok-4.7', at).blockedRequestFee, 0.05);
  assert.equal(priceFor('google', 'gemini-3.8-flash', at).reasoningInOutput, false);
});

test('a dated model id resolves to its alias', () => {
  const p = priceFor('anthropic', 'claude-haiku-4-5-20251001');
  assert.equal(p.model, 'claude-haiku-4-5');
  assert.equal(p.known, true);
  assert.equal(p.input, 1);
});

test('Gemini 3.8 Flash switches from $0.75/$3.75 to $1.50/$7.50 on 2027-01-01', () => {
  const before = priceFor('google', 'gemini-3.8-flash', '2026-12-31T23:59:59.999Z');
  const after = priceFor('google', 'gemini-3.8-flash', '2027-01-01T00:00:00Z');
  assert.deepEqual([before.input, before.output], [0.75, 3.75]);
  assert.deepEqual([after.input, after.output], [1.5, 7.5]);
  assert.deepEqual([priceFor('google', 'gemini-3.8-flash', new Date('2026-09-26')).input], [0.75]);
  assert.equal(priceFor('google', 'gemini-3.8-flash', Date.parse('2027-06-01')).output, 7.5);
  // No date (or null) means now, never 1970.
  assert.equal(priceFor('google', 'gemini-3.8-flash', null).output, priceFor('google', 'gemini-3.8-flash', Date.now()).output);
  assert.throws(() => priceFor('google', 'gemini-3.8-flash', 'not a date'), /bad date/);
  // The other model has no schedule.
  assert.equal(priceFor('google', 'gemini-3.1-flash-lite', '2027-06-01').input, 0.25);
});

test('an unknown model counts at its provider\'s most expensive listed model, marked unknown', () => {
  const p = priceFor('anthropic', 'claude-mystery-9');
  assert.equal(p.known, false);
  assert.equal(p.model, 'claude-mystery-9');
  // fix-102: the whole lineups are listed, so the dearest is Fable 5.1 (Anthropic) and GPT-6 Astra (OpenAI).
  assert.deepEqual(pick(p), pick(priceFor('anthropic', 'claude-fable-5-1')));
  assert.deepEqual(pick(worstPriceFor('anthropic')), pick(priceFor('anthropic', 'claude-fable-5-1')));
  assert.deepEqual([priceFor('openai', 'gpt-7').input, priceFor('openai', 'gpt-7').output], [10, 50]);
  assert.deepEqual([priceFor('xai', 'grok-9').input, priceFor('xai', 'grok-9').output], [2, 6]);
  // Google's worst is Gemini 3.1 Pro Preview's, dearer than 3.8 Flash before and after its date switch.
  assert.deepEqual([priceFor('google', 'gemini-9', '2026-10-01').output, priceFor('google', 'gemini-9', '2027-02-01').output], [12, 12]);
  const g = priceFor('google', 'gemini-9', '2027-02-01');
  assert.ok(g.output >= priceFor('google', 'gemini-3.8-flash', '2027-02-01').output && g.input >= priceFor('google', 'gemini-3.8-flash', '2027-02-01').input, 'never below the switched price');
  // An unknown provider counts at the most expensive cloud price we know, field by field.
  const u = priceFor('custom', 'whatever');
  assert.equal(u.known, false);
  assert.equal(u.input, 10);
  assert.equal(u.output, 50);
  assert.equal(u.cacheWrite1h, 20, 'Fable 5.1\'s 1-hour write, the dearest');
  // Prototype keys are just unknown names.
  assert.equal(priceFor('anthropic', '__proto__').known, false);
  assert.equal(priceFor('constructor', 'toString').known, false);
});

test('local models are $0, whatever the model', () => {
  for (const [prov, model] of [['ollama', 'qwen3:8b'], ['lmstudio', 'granite4.1:8b'], ['ollama', null]]) {
    const p = priceFor(prov, model);
    assert.equal(p.local, true);
    assert.equal(p.input + p.output + p.cacheRead + p.cacheWrite + p.reasoning, 0);
  }
  assert.equal(worstPriceFor('ollama').output, 0);
});

test('OpenRouter: exact-cost flag, free models at $0, vendor ids priced from our tables for reservations', () => {
  const free = priceFor('openrouter', 'openrouter/free');
  assert.equal(free.exact, true);
  assert.equal(free.input + free.output, 0);
  assert.equal(priceFor('openrouter', 'meta-llama/llama-4:free').output, 0);
  const s = priceFor('openrouter', 'anthropic/claude-sonnet-5');
  assert.equal(s.exact, true);
  assert.equal(s.known, true);
  assert.deepEqual([s.input, s.output], [2, 10]);
  assert.equal(priceFor('openrouter', 'x-ai/grok-4.3').input, 1.25);
  assert.equal(priceFor('openrouter', 'x-ai/grok-4.3').blockedRequestFee, 0.05, 'the vendor\'s fee sizes the reservation too');
  assert.equal(priceFor('openrouter', 'anthropic/claude-haiku-4-5:nitro').input, 1);
  // OpenRouter spells versions with dots: "claude-haiku-4.5" is our "claude-haiku-4-5"; Google keeps its dots.
  const dotted = priceFor('openrouter', 'anthropic/claude-haiku-4.5');
  assert.deepEqual([dotted.known, dotted.input, dotted.output, dotted.model], [true, 1, 5, 'anthropic/claude-haiku-4.5']);
  assert.equal(priceFor('openrouter', 'google/gemini-3.8-flash', '2026-10-01').known, true);
  assert.equal(priceFor('openrouter', 'google/gemini-3.8-flash', '2026-10-01').input, 0.75);
});

test('OpenRouter: a model it hasn\'t priced for us reserves at the explicit ceiling, not $2/$10', () => {
  for (const id of ['someone/some-model', 'openai/gpt-7-nova', 'openrouter/auto']) {
    const p = priceFor('openrouter', id);
    assert.equal(p.known, false, id);
    assert.equal(p.exact, true, id);
    assert.deepEqual([p.input, p.output], [15, 75], id);
  }
  assert.deepEqual([worstPriceFor('openrouter').input, worstPriceFor('openrouter').output], [15, 75]);
  // gpt-6-astra is $10/$50 (fix-102: in our own table now): a 7,500/1,200 turn costs about $0.135, and the ceiling reserves more.
  const astraCost = 7500 * 10 + 1200 * 50;
  assert.ok(estimateMicros({ inputTokens: 7500, maxOutputTokens: 1200 }, priceFor('openrouter', 'openai/gpt-7-nova')) >= astraCost);
  const astra = priceFor('openrouter', 'openai/gpt-6-astra');
  assert.deepEqual([astra.known, astra.exact, astra.input, astra.output], [true, true, 10, 50], 'a vendor model we price: our table');
});

test('higherOf takes the higher price field by field (a tier out of reach plays no part), and is null-safe', () => {
  const a = { input: 1, output: 5, cacheRead: 0.1, tiers: [{ minInput: 200000, input: 2, output: 10 }] };
  const b = { input: 0.5, output: 6, cacheRead: 0.2 };
  const h = higherOf(a, b);
  assert.deepEqual([h.input, h.output, h.cacheRead], [1, 6, 0.2]);
  assert.equal(h.tiers, undefined);
  assert.deepEqual(higherOf(null, b), effectivePrice(b));
  assert.deepEqual(higherOf(a, null), effectivePrice(a));
  assert.equal(higherOf(null, null), null);
  assert.equal(higherOf({ input: 1, output: 1, known: false }, { input: 1, output: 1 }).known, false);
});

test('a refreshed table can raise a price but never lower the one the cap uses', () => {
  const bundled = loadPriceTable();
  const refreshed = structuredClone(bundled);
  refreshed.date = '2026-10-15';
  refreshed.providers.anthropic.models['claude-haiku-4-5'] = { input: 0.01, output: 0.01 }; // a bad file
  refreshed.providers.anthropic.models['claude-sonnet-5'].output = 12; // a real rise
  refreshed.providers.anthropic.models['claude-haiku-5'] = { input: 1.5, output: 7 }; // a new model
  refreshed.providers.anthropic.models['claude-typo-5'] = { input: 0.001, output: 0.002 }; // a new model, mistyped
  const bookA = createPriceBook({ bundled, refreshed });
  assert.equal(bookA.refreshedDate(), '2026-10-15');
  assert.equal(bookA.priceFor('anthropic', 'claude-haiku-4-5').output, 5);
  assert.equal(bookA.priceFor('anthropic', 'claude-sonnet-5').output, 12);
  const nu = bookA.priceFor('anthropic', 'claude-haiku-5');
  assert.equal(nu.known, true);
  assert.deepEqual([nu.input, nu.output], [1.5, 7]);
  // A model only the refresh lists is priced no lower than the provider's cheapest bundled model (Haiku 4.5).
  const typo = bookA.priceFor('anthropic', 'claude-typo-5');
  assert.deepEqual([typo.input, typo.output, typo.cacheRead, typo.cacheWrite, typo.cacheWrite1h], [1, 5, 0.1, 1.25, 2]);
  assert.equal(bookA.worstPriceFor('anthropic').output, 50, 'Fable 5.1 stays the dearest');
  const risen = structuredClone(bundled);
  risen.date = '2026-10-15';
  risen.providers.anthropic.models['claude-fable-5-1'].output = 60;
  assert.equal(createPriceBook({ bundled, refreshed: risen }).worstPriceFor('anthropic').output, 60, 'a rise of the dearest raises the worst');
  // An invalid refresh is ignored whole.
  const broken = structuredClone(bundled);
  broken.providers.openai.models['gpt-6-luna'].input = -1;
  assert.equal(bookA.setRefreshed(broken), false);
  assert.equal(bookA.refreshedDate(), null);
  assert.equal(bookA.priceFor('anthropic', 'claude-sonnet-5').output, 10);
  assert.equal(bookA.setRefreshed(null), true);
});

test('a refreshed table can\'t switch the cap off: flags that lower a cost come from the bundle only', () => {
  const bundled = loadPriceTable();
  const bad = structuredClone(bundled);
  bad.providers.anthropic.local = true; // would make every Anthropic price $0
  bad.providers.google.reasoningInOutput = true; // would drop Gemini's thinking
  bad.providers.xai.exact = true;
  bad.providers.xai.blockedRequestFee = 0; // can't lower the fee either
  bad.providers.openrouter.unlisted = { input: 0.1, output: 0.1 };
  bad.providers.anthropic.writeMultipliers = { cacheWrite5m: 1, cacheWrite1h: 1 };
  const book = createPriceBook({ bundled, refreshed: bad });
  assert.equal(book.refreshedDate(), bundled.date, 'the refresh itself is valid');
  const sonnet = book.priceFor('anthropic', 'claude-sonnet-5');
  assert.deepEqual([sonnet.local, sonnet.input, sonnet.output], [false, 2, 10]);
  assert.ok(estimateMicros({ inputTokens: 7500, maxOutputTokens: 1200 }, sonnet) > 0);
  assert.equal(book.isLocal('anthropic'), false);
  assert.equal(book.priceFor('google', 'gemini-3.8-flash').reasoningInOutput, false);
  assert.equal(book.priceFor('xai', 'grok-4.3').exact, false);
  assert.equal(book.priceFor('xai', 'grok-4.3').blockedRequestFee, 0.05);
  assert.equal(book.priceFor('openrouter', 'someone/x').output, 75);
  // A refresh may raise the fee.
  const dearer = structuredClone(bundled);
  dearer.providers.xai.blockedRequestFee = 0.08;
  assert.equal(createPriceBook({ bundled, refreshed: dearer }).priceFor('xai', 'grok-4.3').blockedRequestFee, 0.08);
  // A $0 cloud model is refused, even under a provider the refresh calls local.
  const zero = structuredClone(bundled);
  zero.providers.anthropic.local = true;
  zero.providers.anthropic.models['claude-haiku-5'] = { input: 0, output: 0 };
  assert.equal(book.setRefreshed(zero), false);
  assert.equal(book.priceFor('anthropic', 'claude-haiku-5').known, false, 'counts at the provider\'s worst instead');
  assert.equal(book.priceFor('anthropic', 'claude-haiku-5').output, 50, 'Fable 5.1\'s, the provider\'s dearest');
  // Local providers stay local whatever a refresh says.
  const notLocal = structuredClone(bundled);
  notLocal.providers.ollama.local = false;
  const b2 = createPriceBook({ bundled, refreshed: notLocal });
  assert.equal(b2.priceFor('ollama', 'qwen3:8b').local, true);
});

test('validateTable refuses tables the cap can\'t trust', () => {
  const ok = loadPriceTable();
  assert.throws(() => validateTable(null), /no providers/);
  const neg = structuredClone(ok);
  neg.providers.xai.models['grok-4.3'].cacheRead = -0.2;
  assert.throws(() => validateTable(neg), /cacheRead is not a price/);
  const noOut = structuredClone(ok);
  delete noOut.providers.openai.models['gpt-6-sol'].output;
  assert.throws(() => validateTable(noOut), /needs input and output/);
  const badDate = structuredClone(ok);
  badDate.providers.google.models['gemini-3.8-flash'].changes[0].from = 'soon';
  assert.throws(() => validateTable(badDate), /valid "from"/);
  const badTier = structuredClone(ok);
  badTier.providers.xai.models['grok-4.7'].tiers[0].minInput = 0;
  assert.throws(() => validateTable(badTier), /tier without minInput/);
  assert.throws(() => effectivePrice({ input: 1 }), /needs input and output/);
  // A cloud model can't be $0/$0: not at base, in a tier, or after a scheduled change.
  const zero = structuredClone(ok);
  zero.providers.openai.models['gpt-6-luna'] = { input: 0, output: 0 };
  assert.throws(() => validateTable(zero), /priced \$0/);
  const zeroTier = structuredClone(ok);
  zeroTier.providers.xai.models['grok-4.3'].tiers[0] = { minInput: 200000, input: 0, output: 0 };
  assert.throws(() => validateTable(zeroTier), /tiers\[200000\] is priced \$0/);
  const zeroLater = structuredClone(ok);
  zeroLater.providers.google.models['gemini-3.8-flash'].changes.push({ from: '2027-06-01T00:00:00Z', input: 0 }, { from: '2027-07-01T00:00:00Z', output: 0 });
  assert.throws(() => validateTable(zeroLater), /changes\[2027-07-01T00:00:00Z\] is priced \$0/);
  // OpenRouter's free models and local providers may be $0; so may a model that is only half free.
  const frees = structuredClone(ok);
  frees.providers.openrouter.models['google/gemma-4-31b-it:free'] = { input: 0, output: 0 };
  frees.providers.ollama.models['qwen3:8b'] = { input: 0, output: 0 };
  frees.providers.openai.models['gpt-6-odd'] = { input: 0, output: 1 };
  assert.equal(validateTable(frees), frees);
  const orPaid = structuredClone(ok);
  orPaid.providers.openrouter.models['vendor/paid'] = { input: 0, output: 0 };
  assert.throws(() => validateTable(orPaid), /vendor\/paid is priced \$0/);
  // Provider fields are checked too.
  for (const [field, value, re] of [['local', 'yes', /local is not true or false/], ['blockedRequestFee', -1, /blockedRequestFee is not a price/],
    ['unlisted', { input: 0, output: 0 }, /unlisted needs/], ['writeMultipliers', { cacheWrite1h: 0.5 }, /at least 1/], ['writeMultipliers', { bogus: 2 }, /writeMultipliers\.bogus/]]) {
    const t = structuredClone(ok);
    t.providers.anthropic[field] = value;
    assert.throws(() => validateTable(t), re, field);
  }
});

test('a model without cache-write prices gets its provider\'s multipliers, a tier within reach too', () => {
  const bundled = loadPriceTable();
  bundled.providers.anthropic.models['claude-bare'] = { input: 4, output: 20, tiers: [{ minInput: 200000, input: 8, output: 30 }] };
  const p = createPriceBook({ bundled }).priceFor('anthropic', 'claude-bare');
  assert.deepEqual([p.cacheWrite, p.cacheWrite1h], [5, 8]);
  assert.equal(p.tiers, undefined, 'the 200k tier is out of reach');
  bundled.providers.anthropic.models['claude-near'] = { input: 4, output: 20, tiers: [{ minInput: 16000, input: 8, output: 30 }] };
  const q = createPriceBook({ bundled }).priceFor('anthropic', 'claude-near');
  assert.deepEqual([q.input, q.output, q.cacheWrite, q.cacheWrite1h], [8, 30, 10, 16], 'within reach: folded in, with its multiplied writes');
  // Providers without multipliers keep the input-price default.
  bundled.providers.openai.models['gpt-bare'] = { input: 4, output: 20 };
  assert.equal(createPriceBook({ bundled }).priceFor('openai', 'gpt-bare').cacheWrite, 4);
});
