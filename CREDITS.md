<!--
DRAFT for the public Credits page and the app's Credits screen (PRD §14.4, PO-9, B6.4).
The third-party notices section is a placeholder the release build fills in. Links assume the public files sit side by side at the public repo's root.
Words follow docs/STYLE.md. This page may name the techniques it credits (the strip, load-on-demand addons): that's its job (STYLE.md §10).
-->
# Credits

## wow-ai, the project NeverQuestAlone is built on

NeverQuestAlone began as a fork of **[chelinho139/wow-ai](https://github.com/chelinho139/wow-ai)** (MIT), which chats with coding agents from inside World of Warcraft: Forever. wow-ai built the two paths an addon can use to talk to a program outside the game: a strip of colored pixels the addon draws (an idea it credits to wow-forever-codex, below), and load-on-demand addons the program writes. NeverQuestAlone keeps that design.

What NeverQuestAlone changes:

- a new strip and reply format, with exactly-once delivery and a “ready” signal made of sound files;
- an app that talks to the AI you choose, with your own key or a model on your computer, instead of driving coding-agent command-line tools;
- keys in the macOS Keychain or Windows Credential Manager, a spending meter with an optional daily spend limit, and a list of every connection the app makes;
- a companion who knows your quests and gear, with a HUD beside the quest tracker and routes on your map;
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

## Credited by wow-ai, and so by us

- **[0xInuarashi’s wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex)** measured how the Forever client loads files on a live build (files must exist when the game starts; a file that hasn’t loaded yet is read fresh the first time it’s used), and pioneered the pixel-out channel. wow-ai, and so NeverQuestAlone, rely on those same rules, with load-on-demand addons in place of fonts.
- **[Gethe/wow-ui-source](https://github.com/Gethe/wow-ui-source)**, Blizzard’s interface code on its `forever` branch, used to check every game function the addon calls.
- **[Questie](https://github.com/Questie/Questie)** and **[QuestieDB](https://github.com/Questie/QuestieDB)**, whose documentation of how Forever’s maps work the routes and map pins rely on.

## Data

- **[models.dev](https://github.com/anomalyco/models.dev)** (MIT): the price table the app ships with is generated from its data at build time. Its license notice is included in the third-party notices below.

## Third-party notices

<!-- THIRD_PARTY_NOTICES: generated at build. The release build lists every package bundled into the
app and the addon zip (name, version, license, copyright and license text) and writes it here and to
THIRD-PARTY-NOTICES.txt inside the installer. Until that build step exists, this section stays a placeholder
and no build goes to anyone outside the project. -->

The full list of open-source components in each release, with their licenses, is generated when the release is built and ships inside the app as `THIRD-PARTY-NOTICES.txt`.

---

World of Warcraft, Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries. NeverQuestAlone is unofficial and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter.
