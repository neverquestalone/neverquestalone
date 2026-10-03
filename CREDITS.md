# Credits

NeverQuestAlone stands on other people’s work. Thank you to everyone below.

## wow-ai, the project NeverQuestAlone is built on

NeverQuestAlone began as a fork of **[chelinho139/wow-ai](https://github.com/chelinho139/wow-ai)** (MIT), which lets you chat with coding agents from inside World of Warcraft: Forever. wow-ai worked out the two ways an addon can talk to a program outside the game: a strip of colored pixels the addon draws (an idea it credits to wow-forever-codex, below), and addon files the program writes for the game to load. NeverQuestAlone keeps that design.

What NeverQuestAlone adds:

- a quest companion that knows your quests and gear, with a HUD beside the quest tracker and routes on your map;
- an app that talks to the AI you choose, with your own key or a model on your computer;
- keys kept in the macOS Keychain or Windows Credential Manager, a spending meter with an optional daily spend limit, and a list of every connection the app makes;
- a new way to send messages and replies, so each one arrives exactly once;
- no tools for the AI: it can only write text.

wow-ai is used under the MIT license. Its notice, as the license requires:

```
MIT License

Copyright (c) 2026 chelinho139

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

NeverQuestAlone’s own [LICENSE](LICENSE) carries this notice and the fork’s copyright line. It ships inside the installer and the addon download.

## Projects we learned from

- **[0xInuarashi’s wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex)** worked out how the game loads files (a file must exist when the game starts, and one that hasn’t loaded yet is read fresh the first time it’s used), and first had an addon draw colored pixels for a program to read. wow-ai and NeverQuestAlone rely on those rules, with small addons where wow-forever-codex used fonts.
- **[Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source)**, Blizzard’s interface code on its `forever` branch, used to check every game function the addon calls.
- **[Questie](https://github.com/Questie/Questie)** and **[QuestieDB](https://github.com/Questie/QuestieDB)**, whose notes on how the game’s maps work are what the routes and map pins rely on.

## Data

- **[models.dev](https://github.com/anomalyco/models.dev)** (MIT): the app’s price table uses its format, and the tool that updates the table reads its data.
- **[cMaNGOS](https://github.com/cmangos)** (its classic-db and mangos-classic) and **[wago.tools](https://wago.tools)**: the quest facts behind Quality of Life’s lists of quests that start something when you accept or hand them in (an escort, a fight, a flight), which Auto Accept Quests and Auto Turn In Quests leave to you.

## Third-party notices


Every open-source package inside the app is listed with its license in the app: Settings > Show more > About > Show legal and credits. Electron’s and Chromium’s notices ship beside the app as LICENSE.electron.txt and LICENSES.chromium.html.

---

World of Warcraft, Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries. NeverQuestAlone is unofficial and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter.
