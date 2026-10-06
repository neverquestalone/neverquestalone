# Quest lists for Quality of Life

`addon/NeverQuestAlone/QoL.lua` keeps two lists that Auto Accept Quests and Auto Turn In Quests check first:

- `STARTS`: quests whose acceptance starts an escort, a fight, a flight, a teleport, an event or a timer. Auto Accept Quests leaves them to the player.
- `HANDIN`: quests whose hand-in starts a fight, a flight or a teleport. Auto Turn In Quests leaves them to the player.

Nobody edits them by hand. They're generated from the server emulator's own quest scripts, which record what each quest does when it's accepted or handed in. `tests/qol_test.mjs` fails if QoL.lua's block differs from what `generate.mjs` writes.

## Files

| File | What it is |
|---|---|
| `extract.mjs` | Reads the sources below and writes `cmangos.json`. Run it by hand when a source moves. |
| `cmangos.json` | The facts, one quest a line: each start script's and end script's effects (relay scripts followed), the spells the game casts on accepting (`SrcSpell`) and on the reward (`RewSpellCast`), each C++ accept and rewarded hook, and each time limit. A cast is marked `teleports` when it, or a spell it triggers, moves the player. Written by `extract.mjs`; never edited. |
| `reviewed.json` | What a script can't show, checked on Wowhead Classic (the quest page and its players' comments), each with its reason. |
| `generate.mjs` | Applies the rules to the facts and the review, and writes the block between QoL.lua's `-- BEGIN generated` and `-- END generated` markers. `--check` exits 1 when the block is out of date. |

## Sources

- **cmangos/classic-db** `Full_DB/ClassicDB_1_12_1_z2815.sql.gz` at `28ef625`: `quest_template` (titles, time limits, races), `dbscripts_on_quest_start`, `dbscripts_on_quest_end`, `dbscripts_on_relay`, `dbscript_random_templates`, `creature_template`, and who starts and ends each quest.
- **cmangos/mangos-classic** at `8ec338a`: `src/game/AI/ScriptDevAI/scripts`, the C++ hooks registered as `pQuestAcceptNPC`, `pQuestRewardedNPC` and `pQuestRewardedGO`. A hook that checks no quest ID covers every quest its NPC starts or ends.
- **wago.tools** `FactionTemplate` (build 1.15.9.69722, `product=wow_classic_era`): whether a summoned creature attacks a player who can do the quest. Only the races the quest allows count, less those its quest giver (or, for a hand-in, whoever takes it) would attack. A Stormwind guard summoned for an Alliance quest isn't a fight.
- **wago.tools** `SpellEffect` (the same build): which spells teleport the player (effects 5, 43 and 252, following triggered spells). Only effect types are used: the table's creature ids for summons don't match the classic data.

## The rules

Accepting starts:

- **an escort**: an accept hook that starts an escort or a follower;
- **a fight**: an accept hook that attacks or summons, or a start script that summons a hostile creature, attacks, or turns a creature hostile;
- **a flight**: a start script's taxi;
- **a teleport** (`moves`): a start script's teleport, or a spell that teleports you (the start script's, or the quest's own on accepting);
- **an event**: a start script's spawn group, or any other accept hook;
- **a timer**: a time limit (`LimitTime`).

When a quest shows several, the first in that order wins.

Handing in starts **a fight** when an end script summons a hostile creature, attacks or turns one hostile, or a rewarded hook attacks or summons. It starts **a flight** when an end script sends the player on a taxi, and **a teleport** (`moves`) when an end script teleports them or a spell does (the end script's, or the quest's own on the reward).

`reviewed.json` corrects what the rules can't see:

- a hook that uses the escort code for a walk that ends in a fight;
- a walk and a talk that start an event;
- a hostile creature in a scene that never attacks.

`generate.mjs` refuses:

- a review that only repeats the rules;
- a review for a quest the facts no longer have;
- a review without its reason;
- a quest title with a line break or other control character, which would end its Lua comment and run the rest as code.

## Refresh

1. Download the four sources:
   - the classic-db dump from its `Full_DB/` folder;
   - a checkout of mangos-classic;
   - the FactionTemplate and SpellEffect CSVs from `https://wago.tools/db2/FactionTemplate/csv?product=wow_classic_era` and `https://wago.tools/db2/SpellEffect/csv?product=wow_classic_era`.
2. Extract the facts, pinning each source:

   ```
   node tools/qol-quests/extract.mjs --db ClassicDB_1_12_1_z2815.sql.gz \
     --scripts mangos-classic/src/game/AI/ScriptDevAI/scripts --factions FactionTemplate.csv --spells SpellEffect.csv \
     --pinDb "cmangos/classic-db Full_DB/ClassicDB_1_12_1_z2815.sql.gz@<commit>" \
     --pinScripts "cmangos/mangos-classic@<commit>" --pinFactions "wago.tools FactionTemplate <build>" \
     --pinSpells "wago.tools SpellEffect <build>"
   ```
3. Read `git diff tools/qol-quests/cmangos.json`, and check each new or changed quest on Wowhead Classic.
4. Write what the rules get wrong into `reviewed.json`.
5. Run `node tools/qol-quests/generate.mjs`, then `npm test`.

## What the lists don't cover

- Quests the classic data doesn't have. For example, Tomb of the Lightbringer (9446) came later and isn't on Wowhead Classic. For those, Auto Accept Quests still checks the game's escort tag (84), "escort" in the objectives and a timer the game reports on the offer page.
- A spell's other effects. A cast that doesn't teleport is most often a salute or a glow; `reviewed.json` judges any that matters.
