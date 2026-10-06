#!/usr/bin/env node
// The request parity fixtures (open-shell PRD §2, §3; lane 2a). Until the shell and the WoW plugin
// are split, NeverQuestAlone must send the AI exactly what it sends today. Each case here is game
// state, a message (or a check-in) and settings in, and the exact lastRequest() out: the app API's
// "Last request" view of the turn, with its time and the data block's random id normalized.
//
// The harness is bench-turn's (tools/bench-turn.mjs): the app's own assembly (bridge/byok/boot.mjs
// bootByok) on a temp WoW folder with the addon and its slot folders installed, a reporting addon's
// hello and state, then the case's turn, answered by a stand-in AI on 127.0.0.1 (no network: a
// fetch that swaps the provider's origin for the stand-in's, so the URL is the real one). Each step
// waits until the bridge's publishes and file writes are still, and the stand-in answers only then,
// so a case publishes the same tables in the same order on any machine. tools/game-files-fixtures.mjs
// plays the same cases for the files the game gets, and tools/nqa-replay.mjs replays each case's
// records (a fixture's `records` is a strip it reads).
//
//   node tools/last-request-fixtures.mjs           record tests/fixtures/last-request-1.4/<case>.json
//   node tools/last-request-fixtures.mjs --check   compare instead; exits 1 when any differs
//
// Re-record (in a commit of its own) only when a change is meant to change what the AI gets.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootByok } from '../bridge/byok/boot.mjs';
import { installAddon } from '../bridge/byok/wow.mjs';
import { loadManifests } from '../bridge/byok/providers/index.mjs';
import { createKeyStore } from '../bridge/byok/security/keystore.mjs';
import { encodeRecord } from '../bridge/transport/records.mjs';
import { startMock, anthropicSSE, waitFor, sleep, CANARY_KEYS, NO_CHECKS } from '../tests/byok/helpers/byok-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DIR = path.join(ROOT, 'tests', 'fixtures', 'last-request-1.4');

const TOKEN = '3fa9c2d1', NONCE = 'a3f1', SID = 'a1b2c3d4e5f60718';
const CHAT = 'c3f9a1e', COMPANION = 'c0ffee0';

// The game as a level 8 Tauren in Bloodhoof Village shows it: the addon's context lines and its state.
const CONTEXT = [
  'Game: World of Warcraft: Forever (client 1.60.1.70009, interface 16001)',
  'Character: Testy on Testrealm, level 8 Tauren Shaman (Horde), guild <Hoof and Horn>',
  'Location: Mulgore - Bloodhoof Village',
  'Position: 49.6, 66.3 on Mulgore (map 1412)',
  'Money: 1g 18s 0c; XP: 300/1400',
  'Talents: Elemental 0 / Enhancement 0 / Restoration 0',
  'Professions: Mining 8/75',
  'Quest log (id, * = ready to turn in): 748,761',
].join('\n');
const STATE = Object.freeze({
  v: 1, sid: SID, seq: 3, t: 1790000000,
  char: { name: 'Testy', realm: 'Testrealm', class: 'SHAMAN', race: 'Tauren', level: 8, xp: 300, xpMax: 1400, money: 11800 },
  loc: { map: 1412, zone: 'Mulgore', sub: 'Bloodhoof Village', x: 49.6, y: 66.3 },
  quests: [
    { id: 748, title: 'Poison Water', level: 5, trivial: false, complete: false, obj: [{ text: 'Prairie Wolf Paw', have: 3, need: 6 }, { text: 'Plainstrider Talon', have: 6, need: 6 }] },
    { id: 761, title: 'Swoop Hunting', level: 8, trivial: false, complete: false, obj: [{ text: 'Trophy Swoop Quill', have: 2, need: 8 }] },
  ],
  prof: [{ name: 'Mining', rank: 8, max: 75 }],
  pending: [], omitted: [],
});

// What the character's memory holds when it has some (written by the logbook from earlier states,
// plus a note of the player's own outside the markers), and an earlier exchange in the chat.
const MEMORY = {
  'character.md': '# Character\n\n## Facts (from the game)\n\n<!-- nqa:facts:start -->\nUpdated 2026-09-21 12:26 from game data (session a1b2c3, seq 2). Written by NeverQuestAlone from game data: edit outside the markers.\n\n- Character: Testy on Testrealm, level 7 Tauren Shaman\n- XP: 40 / 1,400 (2%)\n- Money: 90s 0c\n- Location: Mulgore, Bloodhoof Village (map 1412, 44.2, 76.1)\n- Professions: Mining 8/75\n<!-- nqa:last {"who":"Testy-Testrealm","sid":"a1b2c3d4e5f60718","seq":2,"t":1789993600,"level":7} -->\n<!-- nqa:facts:end -->\n\n## My notes\n\n- Saving up for my first mount.\n',
  'quests.md': '# Quests\n\n## Active quests (from the game)\n\n<!-- nqa:facts:start -->\nUpdated 2026-09-21 12:26 from game data (seq 2). 1 active quest. Written by NeverQuestAlone from game data: edit outside the markers.\n\n- 748 Poison Water (L5): Prairie Wolf Paw 3/6\n<!-- nqa:facts:end -->\n',
  'log.md': '# Log\n\nMilestones and sessions, written by NeverQuestAlone from game data.\n- 2026-09-21 11:50 · First visit: Mulgore <!-- nqa:m zone:Testy-Testrealm:Mulgore -->\n- 2026-09-21 12:26 · Reached level 7 <!-- nqa:m level:Testy-Testrealm:7 -->\n',
};
const EARLIER = [
  { role: 'user', text: 'where do I turn in Poison Water?' },
  { role: 'assistant', text: 'Back to Mull Thunderhorn in Bloodhoof Village, once you have all six paws.\n\nTL;DR: Mull, Bloodhoof.' },
];

// Where the addon's message lists its links' tooltips (Chats.lua ExpandLinks), as it sends it.
const LINKED = '\n\n--- Linked from the game ---\n';
const MAP_BROKEN = 'Head east from the village to the well.\n\n```wowmap\n{"op":"set","layer":"Route!","ordered":true,"points":[{"map":1412,"x":53.1,"y":65.8,"label":"Well"}]}\nnot json\n```\n\nTL;DR: the well, east.';

/**
 * The cases (PRD §3). Each: {id, about, byok (config.byok as the player set it), message (typed) or
 * event (a check-in: {kind, args}), reply (the stand-in AI's text), memory (seed the character's
 * memory and the chat's earlier exchange)}. Every case starts from the same game: CONTEXT and STATE.
 */
export const CASES = Object.freeze([
  { id: 'defaults', about: 'A first message on the defaults: Claude, its default model, low effort, every privacy switch as installed.',
    byok: {}, message: 'what should I do next?', reply: 'Finish Poison Water: three more Prairie Wolf Paws east of the village.\n\nTL;DR: three more paws.' },
  { id: 'identity', about: 'Name, realm and guild on (privacy.identity): the character\'s own names go as they are.',
    byok: { privacy: { identity: true } }, message: 'is Hoof and Horn a good guild for Testy?', reply: 'It suits a new Shaman well.\n\nTL;DR: yes.' },
  { id: 'pseudonyms', about: 'Other players pseudonymized (privacy.otherNames off): a target ask, a player link and a crafter become Player A, B and C; the reply names them back.',
    byok: {}, message: `What do you know about my target: Thokk (level 9 Orc Warrior, a player)? Mirabel sent me this sword.${LINKED}[Mirabel] player\n[Fine Longsword] item 2140 (Uncommon)\n  Main Hand Sword\n  <Made by Grimbold>`,
    reply: 'Player A is a level 9 Warrior, likely questing nearby. Player B sent you a sword Player C made: a solid upgrade.\n\nTL;DR: equip it.' },
  { id: 'memory', about: 'Memory and logbook present: the character\'s memory folder (facts, quests, log, a note of the player\'s) and an earlier exchange in the chat.',
    byok: {}, memory: true, message: 'what was I saving up for?', reply: 'Your first mount. Mining sells well for it.\n\nTL;DR: the mount.' },
  { id: 'repair', about: 'A repair turn: the reply\'s map block fails validation (a bad layer name, a line that isn\'t JSON), so the player gets the reply and the one line saying the map couldn\'t be drawn.',
    byok: {}, message: 'show me the way to the well', reply: MAP_BROKEN },
  { id: 'checkins', about: 'Check-ins on (privacy.companion): a level-up the addon sends on its own, in the Companion chat, with the state it names.',
    byok: { privacy: { companion: true } }, event: { kind: 'level_up', args: { from: '7', to: '8' } }, reply: 'Level 8! Swoop Hunting is yours now.\n\nTL;DR: level 8.' },
  { id: 'custom', about: 'A custom OpenAI-compatible provider (Other) off this computer, with its own key.',
    byok: { provider: 'custom', model: 'example/chat-1', custom: { baseUrl: 'https://llm.example.test/v1', model: 'example/chat-1' } }, message: 'where are the swoops?', reply: 'South-west of the village, on the plains.\n\nTL;DR: south-west.' },
  { id: 'anthropic', about: 'An Anthropic provider with a model and a thinking level the player chose.',
    byok: { provider: 'anthropic', model: 'claude-haiku-4-5', effort: 'high' }, message: 'plan my next hour', reply: 'Paws, then quills, then Thunder Bluff.\n\nTL;DR: paws first.' },
  { id: 'local', about: 'A local model (Other on 127.0.0.1): no key, and game text datamarked.',
    byok: { provider: 'custom', model: 'qwen3:8b', custom: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } }, message: 'where is the well?', reply: 'East of Bloodhoof Village.\n\nTL;DR: east.' },
]);

/** A case's records, as the addon draws them: its hello, its state, then the message or the check-in. */
export function records(c) {
  const hello = encodeRecord({ token: TOKEN, key: NONCE, type: 'hello', args: { cur: 0, ver: '1.4.0', build: '70009', iface: '16001', n: 0, ctx: 1, sig: 'ok', slots: 200, sid: SID, slot: 1, mode: 'pixel' }, body: CONTEXT });
  const state = encodeRecord({ token: TOKEN, key: NONCE, type: 'state', args: { cur: 0, sid: SID, seq: STATE.seq }, body: JSON.stringify(STATE) });
  const turn = c.event
    ? encodeRecord({ token: TOKEN, key: `${NONCE}_1`, type: 'evt', chat: COMPANION, args: { cur: 0, kind: c.event.kind, agent: 'main', name: 'Companion', ...c.event.args, sid: SID, st: STATE.seq } })
    : encodeRecord({ token: TOKEN, key: `${NONCE}_1`, type: 'msg', chat: CHAT, args: { cur: 0, agent: 'main', name: 'Route', ctx: 1 }, text: c.message, context: CONTEXT });
  return [hello, state, turn];
}

/** The chat a case's turn is in. */
export const chatOf = c => (c.event ? COMPANION : CHAT);

// The stand-in AI's answer in the provider's own wire format: Anthropic's SSE, or OpenAI's chat
// completions stream for Other.
function answer(provider, text) {
  const headers = { 'content-type': 'text/event-stream' };
  if (provider !== 'custom') return { status: 200, headers: { ...headers, 'request-id': 'req_PARITY' }, body: anthropicSSE(text, { input: 2000, output: 80 }) };
  const chunk = o => `data: ${JSON.stringify({ id: 'chatcmpl-parity', object: 'chat.completion.chunk', model: 'parity', ...o })}\n\n`;
  return { status: 200, headers, body: chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + chunk({ choices: [], usage: { prompt_tokens: 2000, completion_tokens: 80, total_tokens: 2080 } }) + 'data: [DONE]\n\n' };
}

const NOT_RUNNING = () => ({ status: 1, stdout: '' }); // the process list: the game isn't running

/**
 * Play one case on the app's own assembly, and hand `collect` what it left before it's torn down:
 * collect({app, chatId, addonsDir, stateDir}) → its result (or its promise's), returned.
 */
export async function runCase(c, collect) {
  process.env.TZ = 'UTC'; // the logbook writes local times; every machine writes these the same
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  const userData = path.join(root, 'ud');
  const flavorDir = path.join(root, 'wow', '_forever_');
  const addonsDir = path.join(flavorDir, 'Interface', 'AddOns');
  const provider = c.byok.provider ?? 'anthropic';
  let app = null, mock = null, still = null;
  try {
    fs.mkdirSync(addonsDir, { recursive: true });
    const installed = installAddon({ flavorDir, running: false, run: NOT_RUNNING });
    if (!installed.ok) throw new Error(`the addon didn't install: ${JSON.stringify(installed.steps ?? installed)}`);
    if (c.memory) {
      const dir = path.join(userData, 'memory', 'Testy-Testrealm');
      fs.mkdirSync(dir, { recursive: true });
      for (const [f, text] of Object.entries(MEMORY)) fs.writeFileSync(path.join(dir, f), text);
      fs.mkdirSync(path.join(userData, 'transcripts'), { recursive: true });
      const t = Date.now() - 60_000; // inside the transcripts' retention whenever this runs
      fs.writeFileSync(path.join(userData, 'transcripts', `${CHAT}.jsonl`), EARLIER.map((r, i) => JSON.stringify({ t: t + i, ...r })).join('\n') + '\n');
    }
    // It answers only once the bridge is still: the message's ack is published apart from the reply.
    mock = await startMock(async () => { await still(); return answer(provider, c.reply); });
    const keystore = createKeyStore({ backend: 'memory' });
    if (provider === 'anthropic') await keystore.set('anthropic', CANARY_KEYS.anthropic);
    else if (!c.byok.custom.baseUrl.startsWith('http://127.0.0.1')) await keystore.set('custom', CANARY_KEYS.openrouter);
    const origin = new URL(provider === 'custom' ? c.byok.custom.baseUrl : 'https://api.anthropic.com').origin;
    const fetch = (url, init) => globalThis.fetch(String(url).replace(origin, mock.url), init);
    const publishes = [];
    app = await bootByok({
      paths: { userData }, home: path.join(root, 'home'), env: {}, log: k => { if (k === 'publish') publishes.push(k); },
      keystore, config: { wow: { flavorDir }, byok: c.byok }, capture: false, egress: false, lockDir: path.join(root, 'locks'),
      fetch, manifests: loadManifests(), backendOptions: { checks: NO_CHECKS }, wow: { roots: [], run: NOT_RUNNING },
    });
    const bridge = app.bridge;
    if (!bridge) throw new Error('the bridge didn\'t start on the temp WoW folder');
    // Still: no publish for 300 ms (a publish is coalesced 250 ms), none being written, no write queued.
    still = async () => {
      let n = -1;
      for (let i = 0; i < 100; i++) {
        if (n === publishes.length && !bridge.publisher.writing?.() && !bridge.writesQueued?.()) return;
        n = publishes.length;
        await sleep(300);
      }
      throw new Error('the bridge never went still');
    };
    await waitFor(() => bridge.status().gateway.state === 'ready', 10000, 'the backend ready');
    const [hello, state, turn] = records(c);
    for (const r of [hello, state]) { bridge.handlePayload(r, 'strip'); await still(); }
    bridge.handlePayload(turn, 'strip');
    await waitFor(() => bridge.buildSlot().records.some(r => r.t === 'reply'), 20000, 'the reply');
    await still();
    return await collect({ app, chatId: chatOf(c), addonsDir, stateDir: path.join(userData, 'bridge') });
  } finally {
    try { await app?.stop(); } catch { /* stopping */ }
    try { await mock?.close(); } catch { /* closing */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Every string in a JSON value through fn. */
const mapStrings = (v, fn) => (typeof v === 'string' ? fn(v) : Array.isArray(v) ? v.map(x => mapStrings(x, fn))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)])) : v);

/** The "Last request" view, with its time and the data block's random id normalized. */
export async function lastRequest({ app, chatId }) {
  const view = await app.api.lastRequest(chatId);
  return mapStrings({ ...view, at: view.at == null ? null : '<time>' }, s => s.replace(/(<\/?game_data id=")[0-9a-f]{4,32}(")/g, '$1<nonce>$2'));
}

/**
 * What tools/nqa-replay.mjs prints for a case's records: each send the core hands the backend (the
 * raw turn), parsed, in order.
 */
export function replay(c) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-replay-'));
  try {
    const file = path.join(dir, 'strip.json');
    fs.writeFileSync(file, JSON.stringify({ about: c.about, records: records(c) }));
    const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'nqa-replay.mjs'), file, '--dry-run'], { encoding: 'utf8' });
    return out.split(/^(?=\{$)/m).map(s => JSON.parse(s));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** A case's fixture: what goes in (settings, records, the AI's reply), the request out, and the core's sends. */
export const requestFixture = (c, request) => ({ about: c.about, byok: c.byok, records: records(c), reply: c.reply, lastRequest: request, replay: replay(c) });

export const text = v => `${JSON.stringify(v, null, 2)}\n`;

/**
 * Record or check one fixture set: make(c) → the fixture of each case, in dir/<id>.json. Returns the
 * ids that differ (check) or were written (record).
 */
export async function recordOrCheck(dir, make, { check = false, log = () => {} } = {}) {
  const out = [];
  if (!check) fs.mkdirSync(dir, { recursive: true });
  for (const c of CASES) {
    const file = path.join(dir, `${c.id}.json`);
    const want = text(await make(c));
    let have = null;
    try { have = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
    if (have === want) { log(`same      ${path.relative(ROOT, file)}`); continue; }
    out.push(c.id);
    if (check) { log(`DIFFERS   ${path.relative(ROOT, file)}`); continue; }
    fs.writeFileSync(file, want);
    log(`recorded  ${path.relative(ROOT, file)}`);
  }
  return out;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const differ = await recordOrCheck(DIR, async c => requestFixture(c, await runCase(c, lastRequest)), { check, log: l => console.log(l) });
  process.exitCode = check && differ.length ? 1 : 0;
}
