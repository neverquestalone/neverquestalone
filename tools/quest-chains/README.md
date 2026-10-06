# Quest chains

`addon/NeverQuestAlone/Chains.lua` knows where a quest leads. When a quest is a step of a chain that leads to a dungeon, a raid or a rare (or better) reward, the game's quest page shows one line under its title, on the page a quest giver offers it on and in the quest log's details:

```game
Leads to The Deadmines · step 1 of 7
Leads to [Whirlwind Axe] or 2 more · step 1 of 6
```

NeverQuestAlone gets the same facts with the game data: for each quest in the log that has them, and for up to 3 chains the character can start near their level.

Nobody edits the chains by hand. They're generated from the server emulator's quest data, worked out for each of the 72 races and classes. `tests/quest_chains_test.mjs` fails if Chains.lua's block differs from what `generate.mjs` writes.

## Files

| File | What it is |
|---|---|
| `extract.mjs` | Reads the sources below and writes `cmangos.json`. Run it by hand when a source moves. |
| `dump.mjs` | Reads tables out of the SQL dump and the CSVs (`extract.mjs`'s; the tuple reader is `tools/qol-quests/extract.mjs`'s). |
| `cmangos.json` | The facts, one quest, item, instance or zone a line: each quest's links (`prev`, `next`, `ex`, `nic`, `crumb`), type, zone, levels, who can take it (`races`, `classes`, and `takers`: the races its quest givers offer it to), whether anyone can (`disabled`, `noStarter`, `repeatable`, `event`), its rare or better rewards, and the maps its objectives are found on (`where`, with `unknown` for those found nowhere). Only the sets of linked quests that could end in a payoff. Each reward's item class and subclass, `proficiencies`: which classes can equip each weapon and armor subclass, and `combos`: the classes each race can be. Written by `extract.mjs`; never edited. |
| `reviewed.json` | What the rules can't see, each with its reason: the area that names an instance whose map has none, a quest's dungeon, or a quest left out. Empty today. |
| `generate.mjs` | Applies the rules to the facts and the review, and writes the block between Chains.lua's `-- BEGIN generated` and `-- END generated` markers. `--check` exits 1 when the block is out of date; `--show <quest>` prints a quest's record for each race and class. |

## Sources

- **cmangos/classic-db** `Full_DB/ClassicDB_1_12_1_z2815.sql.gz` at `28ef625` (the same dump `tools/qol-quests` reads): `quest_template` (`PrevQuestId`, `NextQuestId`, `ExclusiveGroup`, `NextQuestInChain`, `BreadcrumbForQuestId`, `Type`, `ZoneOrSort`, `QuestLevel`, `MinLevel`, `RequiredRaces`, `RequiredClasses`, `Method`, `SpecialFlags`, the reward items and the objectives), `item_template` (`name`, `Quality`, `AllowableClass`, `startquest`), who starts each quest (`creature_questrelation`, `gameobject_questrelation`), `game_event_quest`, `instance_template`, and where objectives are found: `creature`, `gameobject`, `creature_template` (`LootId`, `KillCredit1`, `KillCredit2`), `gameobject_template` and the loot tables (`creature_loot_template`, `gameobject_loot_template`, `reference_loot_template`).
- **wago.tools** `Map` and `AreaTable` (build 1.15.9.69722, `product=wow_classic_era`): each instance's map name, kind (party or raid) and area, and the areas the quest log files quests under. The addon names an instance by its area, as the client has it (`C_Map.GetAreaInfo`), and falls back on the English name.
- **wago.tools** `FactionTemplate` (the same build): whether a quest giver would attack a race, so a quest only one faction's givers offer never counts toward the other's chains (as `tools/qol-quests` reads it).
- **wago.tools** `SkillLine`, `SkillLineAbility` and `SpellEquippedItems` (the same build): which classes can equip each weapon and armor subclass. A weapon (category 6) or armor (8) skill's ability learned with it equips one subclass and names the classes that get it (Two-Handed Swords: warriors, paladins and hunters; Plate Mail: warriors and paladins).
- **wago.tools** `CharBaseInfo` (the same build): the classes each race can be, the 40 pairs the game has (no orc paladin, no gnome hunter).

## The rules

A quest a player can do:
- is enabled (`Method` isn't 1), started by a creature, an object or an item, not repeatable, and not a world event's;
- is open to their race and class (`RequiredRaces`, `RequiredClasses`);
- and is offered to their race by a quest giver that wouldn't attack them (an object or an item offers it to anyone).

Each race and class pair the game has is worked out on its own, so a step count is never another faction's or class's.

**Steps.** A quest needs its `PrevQuestId` and every quest whose `NextQuestId` is it. Any one of them opens it (the emulator's `SatisfyPreviousQuest`), but a quest in an each-from-all group (`ExclusiveGroup` below 0) counts only with the whole group done. A quest that needs nothing is step 1; else its step is one past the quest it needs, or past the group's last: quests done side by side are one step. A breadcrumb, or a quest a giver only offers next (`NextQuestInChain` with no need of it), is no step: the chain starts without it.

**Payoffs.**
- A dungeon or raid quest: tagged Dungeon or Raid (`Type` 81 or 62) and filed under a party or raid instance (an area inside its map, its map's own area, or an area outside with the instance's name: the quest log's header for Uldaman in the Badlands); or untagged with every objective found only on one party or raid instance's map. A battleground isn't one.
- A reward: an item of quality 3 (rare) or better, fixed or a choice, that the class can equip (`AllowableClass`, and the proficiency its weapon or armor subclass needs). A choice says how many other rare or better picks the class could take instead ("or 2 more"). A reward the class can't equip, fixed or picked, is no payoff for it: the chain leads to the next best, or gets no line.

Why these: the type is the tag the game shows ("Dungeon", "Raid") and the zone is where the quest log files it, so a quest the game calls a dungeon quest names the dungeon the player sees in their log; the objectives catch the dungeon quests the game left untagged, and only when every objective is in that one instance. The tag alone isn't enough: raid-tagged quests in Silithus and Alterac Valley are done outdoors or in a battleground.

**What a quest leads to.** The nearest dungeon or raid among it and the quests after it, else the best reward among them (the highest quality, then the nearest). A chain's first step never leads to itself. When the nearest dungeons are two instances at the same distance, neither is named.

**Of M.** The step of that payoff's quest, counted along this quest's way to it; for a dungeon or raid, of the last quest after it in that instance (a chain with three Uldaman quests in a row is "of" the third).

**Saying less.** Two ways into a quest at different steps leave its step unknown, and every step after it: the line says "Leads to ...". Ways of different lengths from a quest to its payoff leave the count unknown: "Leads to ... · step 9". A quest whose record differs by class (or by race) gets one per class (or race), and a class or race it leads to nothing for gets none: a record is everyone's only when everyone who can take the quest has it. One that differs by both says only what every race and class agrees on, names a payoff only when they all name one, and says nothing when it leads to nothing for some.

**Breadcrumbs.** A breadcrumb (`BreadcrumbForQuestId`) is no step, but it's the errand that sends you to one: it says where the quest it points at leads, with no step ("Leads to Wailing Caverns").

**Chains to start.** A chain's first step the character hasn't done (`C_QuestLog.IsQuestFlaggedCompleted`) and doesn't have, that their race and class can take and their level allows (from 5 levels under theirs to 3 over), and that no quest of an exclusive group (`ExclusiveGroup` above 0) can stand in for; those the quest log files under the zone they're in first, then the nearest in level.

`generate.mjs` refuses:
- a review without its reason, one that only repeats the rules, or one for a quest the facts no longer have;
- a quest whose objectives are all on an instance no area names (add the area to `reviewed.json`);
- a name with a quote, a backslash, a control character, a `|` or a bracket, which would end its Lua string or break the link the addon makes of it.

## Refresh

1. Download the sources:
   - the classic-db dump from its `Full_DB/` folder;
   - `https://wago.tools/db2/Map/csv?product=wow_classic_era&build=<build>`, and `AreaTable`, `FactionTemplate`, `SkillLine`, `SkillLineAbility`, `SpellEquippedItems` and `CharBaseInfo` the same way.
2. Extract the facts, pinning each source:

   ```
   node tools/quest-chains/extract.mjs --db ClassicDB_1_12_1_z2815.sql.gz \
     --maps Map.csv --areas AreaTable.csv --factions FactionTemplate.csv \
     --skills SkillLine.csv --abilities SkillLineAbility.csv --equips SpellEquippedItems.csv \
     --combos CharBaseInfo.csv \
     --pinDb "cmangos/classic-db Full_DB/ClassicDB_1_12_1_z2815.sql.gz@<commit>" \
     --pinMaps "wago.tools Map <build>" --pinAreas "wago.tools AreaTable <build>" \
     --pinFactions "wago.tools FactionTemplate <build>" \
     --pinSkills "wago.tools SkillLine, SkillLineAbility and SpellEquippedItems <build>" \
     --pinCombos "wago.tools CharBaseInfo <build>"
   ```
3. Read `git diff tools/quest-chains/cmangos.json`, and check new or changed chains on Wowhead Classic.
4. Write what the rules get wrong into `reviewed.json`.
5. Run `node tools/quest-chains/generate.mjs`, then `npm test`.

## What the chains don't cover

- Quests the classic data doesn't have, or that WoW: Forever changed. The line follows the data at `28ef625`.
- A race and class pair Classic Era doesn't have, if WoW: Forever adds one: a record kept by class or by race still applies to it.
- A step another requirement gates (a reputation, a profession, a condition): the step counts as the data links it.
- Breadcrumbs: only those the data marks (`BreadcrumbForQuestId`) say where their quest leads, with no step; an older errand that only sends you on (a giver's `NextQuestInChain`) gets no line.
