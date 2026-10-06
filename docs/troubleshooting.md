---
title: Troubleshooting
description: Fixes for the problems you’re most likely to hit building NeverQuestAlone, from installing to signing and updates.
status: ready
---

# Troubleshooting

Fixes for the problems you’re most likely to hit, from installing to signing and updates.

## `npm ci` fails

Check that `node --version` says 22.19 or later. Delete `node_modules` and run `npm ci` again; never `npm install`, which can change the lockfile.

## The app quits as soon as it starts

Another copy of NeverQuestAlone is running, often an installed one. A run from source is the same app, and only one copy runs at a time: a second one quits. Quit the other copy first.

## Linux: the app stops at once, about the “SUID sandbox helper”

Ubuntu 23.10 and later keep apps from making the user namespaces Electron’s sandbox uses, so Electron falls back to its helper and asks for it to be set up. Do what it asks, once after each install:

```sh
sudo chown root:root app/desktop/node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 app/desktop/node_modules/electron/dist/chrome-sandbox
```

Never start the app without its sandbox.

## The app opens, but connecting an AI fails

- “Anthropic didn’t accept that key.” (with your AI company’s name): copy the key again from that company’s site. A missing character is the usual cause.
- “Your account at Anthropic has no credit.”: add credit there, then click **Test again**.
- A model on your computer: start Ollama or LM Studio first, and check the address, for example `http://localhost:11434/v1` for Ollama.

## NeverQuestAlone can’t see the game

A run from source has no capture helper until you build one: [Screen reading from source](get-started.md#5-screen-reading-from-source) says how, on a Mac and on Windows. Until then, turn off **Screen reading** on the app’s **Your data** page: your messages wait for a `/reload` in game, and replies still come in.

## Windows keeps your key only until you quit

Smart App Control blocked the part of the app that saves keys, because a build from source isn’t signed. Until you sign it, the app keeps your key only until you quit.

## The Mac says the app is damaged or can’t be checked

The app isn’t signed and notarized, or a file changed after signing. Sign and notarize it (see [Release your own](releasing.md#2-sign-it-as-yourself)), then check it with `spctl --assess --verbose "/Applications/<Your App>.app"`.

## Windows says “Windows protected your PC”

Your installer isn’t signed, or its certificate is new. Sign it. With a new certificate, the warning fades as more people install it.

## The app doesn’t update

A run from source never updates itself. For a release, check that `releases` in `identity.json` names the repository you publish to, and that `WINDOWS_PUBLISHER` is the name your certificate is issued to. An update signed by anyone else is refused on purpose.

## Still stuck

[Search the issues on GitHub](https://github.com/tommygeoco/neverquestalone/issues), then open one with what you ran, what you expected and what happened. Never paste an API key. Security problems go to the [private report](security.md#report-a-problem), never a public issue.
