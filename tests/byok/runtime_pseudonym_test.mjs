// Other players' names from game data (public BYOK PRD §13.1, §13.2, RT-12, DB14):
// bridge/byok/runtime/pseudonym.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPseudonymizer, labelFor, normalizeName, namesFromMessage, namesFromLinked, replaceWords, wordsRegex, DATAMARK } from '../../bridge/byok/runtime/pseudonym.mjs';

test('pseudonym: labels run A to Z, then AA', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52, 701, 702].map(labelFor),
    ['Player A', 'Player B', 'Player Z', 'Player AA', 'Player AB', 'Player AZ', 'Player BA', 'Player ZZ', 'Player AAA']);
});

test('pseudonym: stable for the session, and each session starts fresh', () => {
  const p = createPseudonymizer();
  assert.equal(p.mask('Arthas crafted this', ['Arthas']), 'Player A crafted this');
  assert.equal(p.mask('Jaina and Arthas', ['Jaina']), 'Player B and Player A');
  assert.equal(p.mask('Arthas again, no names passed'), 'Player A again, no names passed', 'known names stay masked');
  assert.equal(p.labelOf('Arthas'), 'Player A');
  assert.equal(p.size, 2);
  assert.deepEqual(p.known(), [{ label: 'Player A', name: 'Arthas' }, { label: 'Player B', name: 'Jaina' }]);
  const q = createPseudonymizer();
  assert.equal(q.mask('Jaina', ['Jaina']), 'Player A', 'another session, another mapping');
  // Masking is idempotent: a label is never taken for a name.
  const once = p.mask('Arthas and Jaina');
  assert.equal(p.mask(once), once);
});

test('pseudonym: only names passed in, whole words, exact case', () => {
  const p = createPseudonymizer();
  assert.equal(p.mask('Tavi went home'), 'Tavi went home', 'nothing registered, nothing masked');
  p.mask('', ['Bread']);
  assert.equal(p.mask('Bread said: buy bread, Breadcrumbs, Bread\'s pie, [Bread]'),
    'Player A said: buy bread, Breadcrumbs, Player A\'s pie, [Player A]');
  // Names in other scripts and with accents, bounded by letters in any script.
  const u = createPseudonymizer();
  assert.equal(u.mask('Thrâll met Zoë and Thrâllson', ['Thrâll', 'Zoë']), 'Player A met Player B and Thrâllson');
  assert.equal(u.mask('Мирон и Мирона', ['Мирон']), 'Player C и Мирона');
});

test('pseudonym: a Name-Realm masks the bare name too, and unmask gives the name back', () => {
  const p = createPseudonymizer();
  assert.equal(p.mask('Arthas-Stormrage whispers; Arthas waves', ['Arthas-Stormrage']), 'Player A whispers; Player A waves');
  assert.equal(p.mask('Arthas-Kazzak', ['Arthas-Kazzak']), 'Player B', 'the same name on another realm is another player');
  assert.equal(p.mask('Arthas'), 'Player A', 'the bare name stays with the first');
  assert.equal(p.unmask('Ask Player A, then Player B. Player AB and Player Q are unknown; PlayerA is not a label.'),
    'Ask Arthas-Stormrage, then Arthas-Kazzak. Player AB and Player Q are unknown; PlayerA is not a label.');
  assert.equal(p.unmask(p.mask('Trade with Arthas-Kazzak')), 'Trade with Arthas-Kazzak');
});

test('pseudonym: only WoW-shaped names are names; things that can\'t be are refused', () => {
  for (const bad of ['', 'A', '12345', 'x'.repeat(49), 'Player', 'player b', 'Player AB', null, undefined,
    'the', 'wolves', 'Hogger killers', 'the Defias', 'Abcdefghijklm', 'TAVI', 'tAvi', 'Ta vi', 'Arthas-', '-Realm', 'Ta2vi', '[Arthas]']) {
    assert.equal(normalizeName(bad), null, JSON.stringify(bad));
  }
  for (const ok of ['Ta', 'Tavi', 'Abcdefghijkl', 'Thrâll', 'Zoë', 'Мирон', '李小龍', 'Arthas-Stormrage', 'Arthas-Aerie Peak', "Ta-Kel'thuzad"]) {
    assert.equal(normalizeName(ok), ok, ok);
  }
  assert.equal(normalizeName(' Ta\u{200B}vi|  '), 'Tavi');
  assert.equal(normalizeName('Ta\u{3164}vi'), 'Tavi', 'a Hangul filler is invisible, not a letter');
  const p = createPseudonymizer();
  assert.equal(p.mask('Player one', ['Player']), 'Player one');
  assert.equal(p.mask('where is the quest giver for the wolves?', ['the', 'wolves']), 'where is the quest giver for the wolves?', 'common words never become names');
  assert.equal(p.size, 0);
});

test('pseudonym: labels this session didn\'t hand out are reserved, never reused for someone new', () => {
  const p = createPseudonymizer();
  p.mask('', ['Jaina']);
  assert.deepEqual(p.reserveLabelsIn('Player A and Player B and Player B, PlayerC, Player AB'), ['Player B', 'Player AB'], 'Player A is Jaina, this session\'s own');
  assert.deepEqual(p.reserveLabelsIn('Player B again'), [], 'once');
  assert.equal(p.labelOf('Bread'), 'Player C', 'B is skipped');
  assert.equal(p.labelOf('Tavi'), 'Player D');
  assert.equal(p.unmask('Player A, Player B, Player C, Player D'), 'Jaina, Player B, Bread, Tavi', 'a reserved label stays unknown');
  assert.equal(p.size, 3);
});

test('pseudonym: namesIn finds the known names in real text, for a transcript row', () => {
  const p = createPseudonymizer();
  p.mask('', ['Arthas-Stormrage', 'Jaina']);
  assert.deepEqual(p.namesIn('Ask Jaina, then Arthas; Jaina again. Thrall is unknown.'), ['Jaina', 'Arthas']);
  assert.deepEqual(p.namesIn('Arthas-Stormrage'), ['Arthas-Stormrage']);
  assert.deepEqual(p.namesIn('nobody here'), []);
  assert.deepEqual(createPseudonymizer().namesIn('Jaina'), [], 'nothing known, nothing found');
  // A label the model copied with the datamark still maps back.
  assert.equal(p.unmask(`Player${DATAMARK}B and Player A`), 'Jaina and Arthas-Stormrage');
});

test('pseudonym: the names the addon puts in a message from game data', () => {
  const msg = [
    'What do you know about my target: Arthas (level 60, elite, humanoid, a player, hostile)?',
  ].join('\n');
  assert.deepEqual(namesFromMessage(msg), ['Arthas']);
  assert.deepEqual(namesFromMessage('What do you know about my target: Hogger (level 11, elite, humanoid, hostile)?'), [], 'an NPC keeps its name');
  const linked = 'is this good? [Fine Longsword] [Jaina]\n\n--- Linked from the game ---\n[Fine Longsword] item 2140 (Uncommon)\n  Fine Longsword\n  <Made by Thrall>\n[Jaina] player';
  assert.deepEqual(namesFromMessage(linked), ['Thrall', 'Jaina']);
  assert.deepEqual(namesFromMessage('just typing Arthas'), []);
  // The link and "Made by" patterns read only the linked part: typed text can't register a name.
  assert.deepEqual(namesFromMessage('[Hogger] player killers keep camping me'), []);
  assert.deepEqual(namesFromMessage('he signed it <Made by Arthas>'), []);
  assert.deepEqual(namesFromMessage('x\n\n--- Linked from the game ---\n[Ring] item 1\n  <Made by the>'), [], 'a forged common word is no name');
  assert.deepEqual(namesFromMessage('What do you know about my target: the wolves (a player)?'), []);
});

test('pseudonym: names from linked tooltips however they arrive', () => {
  assert.deepEqual(namesFromLinked([
    { head: '[Arthas] player', lines: [] },
    { head: '[Worn Staff] item 5776', lines: ['Two-Hand', '<Made by Jaina>'] },
    '[Thrall-Stormrage] player',
    { head: '[Arthas] player' },
    { head: '[Hogger] player killers', lines: [42, null] },
    null, 7,
  ]), ['Arthas', 'Jaina', 'Thrall-Stormrage']);
  assert.deepEqual(namesFromLinked(null), []);
  assert.deepEqual(namesFromLinked('[Arthas] player'), [], 'a list, not a string');
});

test('pseudonym: replaceWords and wordsRegex', () => {
  assert.equal(replaceWords('Al went to Alterac with Al.', [['Al', 'your character']]), 'your character went to Alterac with your character.');
  assert.equal(replaceWords('on Lantern Moor PvE 3, not Classic', [['Lantern Moor PvE 3', 'your realm'], ['Classic', 'X']]), 'on your realm, not X');
  assert.equal(replaceWords('same', []), 'same');
  assert.equal(wordsRegex([]), null);
  assert.equal(wordsRegex(['a.b']).test('axb'), false, 'names are literal, not patterns');
});
