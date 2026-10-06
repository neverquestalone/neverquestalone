---
title: How it’s built
description: Where each part of NeverQuestAlone lives in the source, and how a message travels from the game to your AI and back.
status: ready
---

# How it’s built

NeverQuestAlone is two programs on one computer: an addon inside World of Warcraft: Forever, and the NeverQuestAlone app beside it. The game gives an addon no network and no way to call another program, so the two talk through the screen and through addon files.

## How a message travels

1. You type in game. The addon draws your message as a colored bar at the top of the game’s window, with the game data you allowed.
2. The capture helper, a small program the app runs, reads only the top of the game’s window and hands the message to the app. It keeps no pictures and has no network code.
3. The app sends the message to the AI you picked, with your own API key, and counts what it cost.
4. The app checks the reply, writes it into one of 200 small addons that hold replies, and changes a short sound file the addon listens for. The addon loads the reply and shows it.

[How NeverQuestAlone works](https://github.com/tommygeoco/neverquestalone/blob/main/HOW-IT-WORKS.md) tells the same story for players, with what leaves the computer and how to check it.

## Where each part lives

- `addon/NeverQuestAlone/`: the addon, in Lua, on the game’s own functions. The HUD by the quest tracker, the chat window, routes and pins on the map, Quality of Life, Copy and Paste, and the colored bar.
- `app/desktop/`: the app’s window, tray, setup, updates and installers, on Electron.
- `bridge/`: the app’s core, which runs inside the app.
  - `bridge/transport/`: how messages and replies cross between the game and the app: reading the colored bar, the 200 small addons, the sound files and the addon’s saved file.
  - `bridge/app/`: the game’s side: your character, quests and routes, and replies made ready for the game.
  - `bridge/byok/`: everything about your AI: the AI companies the app knows, keys, the addresses the app may reach, what’s spent and what the AI is told.
  - `bridge/capture/` and `bridge/capture_x11.py`: the capture helpers, in Swift for macOS, C for Windows and Python for Linux.
- `prompts/`: what the AI is told. `node tools/gen-prompts.mjs` builds the copy the app sends from `prompts/companion.md`.
- `plugins/`: what makes a build one app and not another, in `identity.json`: `plugins/wow/` is NeverQuestAlone’s, and `plugins/example/` is a start for your own. `"plugin"` in `package.json` picks one.
- `tools/`: the test runner, the addon’s zip (`npm run package:addon`), the price table, the quest lists Quality of Life checks, and the checks a release runs.
- `tests/`: everything `npm test` runs.

## The quest lists

Auto Accept Quests and Auto Turn In Quests leave you the quests that start something, like an escort, a fight or a flight. Their lists in `addon/NeverQuestAlone/QoL.lua` are generated, never written by hand: `tools/qol-quests/` reads the cMaNGOS project’s quest data and scripts and two of the game’s own tables, and `npm test` fails when the lists and their source disagree. Its `README.md` says how to refresh them.

## Rules the code keeps

- The addon calls none of the game’s protected functions: it can’t move, cast, target or trade, and it never presses a key or clicks. Tests check it.
- The AI has no tools. It can only write text, and the routes and pins the app checks before the game gets them.
- Your key stays in the app: the macOS Keychain, Windows Credential Manager or, on Linux, the Secret Service.

[Security model](security.md) says what protects what.
