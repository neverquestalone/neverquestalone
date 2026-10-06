---
title: Get started
description: Build NeverQuestAlone from its source, run its tests and start the app, in about 10 minutes.
status: ready
---

# Get started

Build NeverQuestAlone from its source, run its tests and start the app. About 10 minutes.

## What you need

- A Mac with macOS 14 or later, or a PC with Windows 10 or 11. Linux runs it from source too, with no installer and no updates.
- Node.js 22.19 or later, and Git.

You don’t need an API key, a signing certificate or World of Warcraft to build it and run its tests.

## 1 Get the code

```sh walkthrough
git clone https://github.com/tommygeoco/neverquestalone.git
cd neverquestalone
```

## 2 Install

```sh walkthrough
npm ci
npm ci --prefix app/desktop
```

The first command installs what the tests need, and the second the app’s own packages. Electron downloads itself the first time the app starts.

## 3 Run the tests

```sh
npm test
```

They test the addon, the app and everything between them, with stand-ins for the game and the AI. A few run only on the system they test, and say so when they skip.

## 4 Start the app

```sh walkthrough app
npm start
```

It opens at **Connect your AI**, as a NeverQuestAlone you download does, because it’s the same app:

- It keeps its key and its data where an installed NeverQuestAlone does, so quit an installed copy first.
- When you set up WoW, it installs the addon from your copy of the code.
- It never updates itself.

## 5 Screen reading from source

The app reads the top of the game’s window with its capture helper, a small program you build on your computer:

- Mac: make a code-signing certificate named “NeverQuestAlone Local Code Signing” in your login keychain once. A self-signed one is enough, and Keychain Access’s Certificate Assistant makes it. If your Mac then says it isn’t trusted, open it in Keychain Access and set **Code Signing** to **Always Trust** under **Trust**. Then run `npm run capture:build`, and allow Screen Recording for “NeverQuestAlone Capture” when your Mac asks.
- Windows: in Git Bash, with MinGW-w64’s `gcc` on your PATH, run `npm run capture:build`.

Until you do, turn off **Screen reading** on the app’s **Your data** page: your messages wait for a `/reload` in game, and replies still come in.

## Next

- [How it’s built](architecture.md): where each part lives, and how a message travels.
- [Release your own](releasing.md): your name, your signature and your updates.
