<!--
DRAFT for the public "How NeverQuestAlone works" page (PRD §14.1 PO-6, §8.4, §13.1, B6.4).
Before publishing: check every statement against the shipped build, replace each <…> placeholder,
and run tools/scrub-scan.mjs over the published copy. Links assume the public files sit side by side at the public repo's root.
Words follow docs/STYLE.md. This page may name what's usually hidden (the strip, the capture helper, the parts, tokens): explaining them is its job (STYLE.md §10).
Setup offers five AIs: Claude, ChatGPT, Grok, Gemini, and Other (any OpenAI-compatible service at its own address).
PENDING B0.6: "the volume can be 0" (One message, start to finish) is not yet checked. B0.6 tests whether replies
still arrive quickly with Enable Sound on and the master volume at 0. If they don't, say "keep the game's sound on and audible" instead.
-->
# How NeverQuestAlone works

NeverQuestAlone brings Bones, an AI companion, into World of Warcraft®: Forever. You ask Bones questions in a chat window inside the game (“where do I turn this in?”, “which ring is better for me?”), and the reply shows up there. Bones thinks with the AI you pick: by Copy and Paste with any AI, or through the NeverQuestAlone app with your own API key.

This page explains exactly what NeverQuestAlone does, what leaves your computer, and how you can check all of it yourself. It’s written so you can point to it, for example in a support ticket.

> **Unofficial.** NeverQuestAlone is not made, reviewed or endorsed by Blizzard Entertainment, and it isn’t affiliated with Anthropic, OpenAI, Google, xAI or OpenRouter. It reads a small area of your screen that its addon draws, and writes addon files. It never controls your character. Use it at your own risk.

## What it’s made of

- **The addon**, inside the game. It draws the chat window, the HUD beside your quest tracker, and map pins. Like every addon, it can’t reach the network or read other files while the game runs. Its folder is named `NeverQuestAlone`.
- **The parts**, 200 small addons named NeverQuestAlone Part 001 to NeverQuestAlone Part 200 (folders NQA_S001 to NQA_S200). The app installs them next to the addon, and each holds one reply at a time. The AddOns list folds them under NeverQuestAlone Parts; leave them checked.
- **The app**, NeverQuestAlone, which sits in your menu bar or system tray. It holds your settings and your key, talks to your AI company, and keeps your chat history on your computer.
- **The capture helper**, a small program the app starts only while the game runs. It reads the message strip the addon draws (below) and nothing else. It has no network code.
- **Your AI:** Claude, ChatGPT, Grok or Gemini with your own key from Anthropic, OpenAI, xAI or Google; or Other: any OpenAI-compatible service at its own address (OpenRouter, Groq, Together, or Ollama or LM Studio on your own computer), with its key if it takes one.

There’s no NeverQuestAlone server. The app talks to your AI company directly.

## One message, start to finish

1. You type a message in Bones’s window and press Enter.
2. The addon draws the message as a strip of small colored squares in the top-left corner of the game window, with your own character’s game data (level, class, zone, quests) if game data is on.
3. The capture helper reads only that corner of the game window (at most 900 by 300 points, a few times a second) and decodes the strip. It doesn’t look at the rest of your screen.
4. The app builds the request (checking it against your daily spend limit, if you set one) and sends it to your AI company over HTTPS. Your key goes only in that request’s header, only to that AI company.
5. When the reply comes back, the app checks it (it takes out anything that could imitate game text or links), writes it into one of the parts, and changes a short sound file the addon listens for as its “ready” signal.
6. The addon loads that file and shows the reply in its window. Nothing is posted to chat.

The strip is drawn only while a message is waiting to be picked up. Replies arrive whole, usually a few seconds after the AI finishes. The “ready” signal needs the game’s sound switched on (the volume can be 0).<!-- PENDING B0.6 --> With Enable Sound off, the addon checks for replies on a timer instead (after 5, 12, 25 and 45 seconds), and the app tells you when that happens.

## What it never does

These are fixed rules. The addon’s side is checked by tests that run on every build (for example, that it never calls the game’s movement, casting, macro or chat-sending functions).

1. **No input to the game.** No key presses, mouse or controller events, ever.
2. **No memory reads or writes, no injection.** Nothing hooks into the game process or changes the game’s own files. The app only reads its strip (or, with no screen reading, the addon’s saved data) and writes its own addon files.
3. **Nothing happens without you.** Every message starts with your click or key press. Nothing is ever posted to chat, mail or other players. The addon has no secure action buttons and calls no protected functions, so it can’t move, cast, target or trade.
4. **No combat data.** The strip carries only what you typed and your own character’s state. Check-ins never fire in combat.

It also never reads other players’ chat, your guild roster or your friends list.

**The AI can’t act either.** It has no tools. It can’t run commands, read or write files, browse the web, send messages or spend money. All it can do is write text into Bones’s window. Web addresses in a reply show as plain text you can’t click, and item and quest links are rebuilt by the addon from numbers only.

## No screen reading

If you’d rather nothing on your screen is read, turn off **Screen Reading** in the addon’s Settings (under What Bones Knows), or type `/bones stream on`. Nothing is drawn: your messages wait in the addon’s saved data and go when you reload the game’s interface (click Reload above the chat window; a short loading screen, never in combat), and replies still come in. The app reads the saved data after the reload. Turning Screen Reading back on, or `/bones stream off`, switches back. With Screen Reading off, the addon draws no strip.

`/bones mode reload` is stricter still: replies also wait for a reload. `/bones mode pixel` switches back.

## What leaves your computer

In short: your messages and, by your choice, your own character’s game data go to the AI company you picked, and nothing goes to us. The full table, with every setting and each AI company’s retention and training rules, is in [PRIVACY.md](PRIVACY.md).

- **By default,** your character’s name, realm and guild are left out (the AI sees “your character”). Other players’ names that come from the game (your target, player links you shift-click, “Made by” lines) are replaced with stand-ins like “Player A” before anything is sent, and put back in the reply on your computer. Names you type yourself are sent as you typed them.
- **Your chat history** stays on your computer, in a folder only your user account can read, and is deleted after 30 days (you can change that, or delete it all).
- **Nothing is sent to us.** No telemetry, no analytics, no crash reports. The only other traffic is the update check to GitHub, which you can turn off.

## Your key

- **It goes in through the app only,** never the game. If you paste something that looks like a key into Bones’s window in the game by mistake, the addon refuses to send it, and so does the app: “That looks like an API key, so it wasn’t sent. Keys go in the NeverQuestAlone app, never in game.”
- **It’s saved where your system keeps passwords:** your macOS Keychain, or Windows Credential Manager.
- **It’s read only when a request is made,** and sent only in the header of requests to that AI company.
- **It never goes into** the game, the game’s saved data, the strip, the parts, the app’s settings file, its logs, crash output or any other program.

What that protects, honestly:

| Who | Can they read your key? |
|---|---|
| Other people with their own login on this computer | No. |
| Other programs you run, on Windows | **Yes**, like any saved password: that’s how Windows keeps them. Keep a spend limit on your key at your AI company. |
| Other programs you run, on macOS | macOS asks you before another app reads it. |
| Other game addons | No. The key never enters the game. |
| Us, the developers | No. There’s no server, and the app’s traffic goes only to the hosts listed in Connections. |
| Someone reading a bug report you shared | No. Logs and diagnostics take keys out automatically. |

A spend limit set at your AI company is the real backstop, because a stolen key can be used anywhere. The app links to each AI company’s limit settings.

## What it costs

NeverQuestAlone sets no limits on how much you use it: no daily spend limit unless you set one, no limit on the messages you type, none on check-ins. It counts tokens (the units AI companies bill by) and the cost of every reply, so you always see what you spent. What controls spending:

- **Your AI company’s limits.** The spend limit you set there (the real backstop), and its rate limits. The app shows the line your AI company’s limit leads to and never works around it.
- **Your own daily spend limit, if you want one.** There’s none unless you set it on the app’s Usage page (the app asks you to confirm a higher limit, or turning it off). Before each request the app then reserves its estimated cost, so even with two chats running at once the limit is overshot by at most one reply’s estimation error. It resets at local midnight.
- **A model on your own computer** costs $0.
- **A service you connect with Other** bills you at its own prices. The app doesn’t know them, so it shows the exact cost only when the service reports it with each reply (OpenRouter does), and otherwise counts each reply at the price of the dearest model it knows.

One request and one reply are at most 20,000 tokens in and 1,200 out; that’s the size of a request, not a limit on how many. Prices come from a dated price table shipped with the app (exact figures from a service that reports them). The chat window’s header shows what you’ve spent today, for example `$0.18 today` (or `$0.18 of $5.00 today` with a $5.00 limit).

One safety catch that normal play never reaches: if something went wrong and the game sent a burst of check-ins (more than 10 in a minute, or 60 in an hour), Bones pauses them and says so once in the Check-ins chat: “Bones paused check-ins: your next message turns them back on.” Your next message starts them again, and the check-ins it held go along with that message. Each one counts at the time the game sent it, so check-ins that arrive together, such as the ones sent at a reload with no screen reading, aren’t a burst.

When something goes wrong (a rejected key, no credit, a busy AI, your AI company’s limit or your own daily spend limit reached) you see one plain line in the game with the next step, and the fix is in the app. The app never switches to another AI on its own.

## Connections and Last request

- **Connections** lists every host the app connected to: the host, port, how many times, first and last time, and why (your AI company, a key test, the update check, a model on your computer). The app can connect only to the AI company you chose (with Other, the one host of the address you gave it), GitHub (for updates) and a model server on this computer, if you use one. Every request is checked before it’s sent: anything else is refused, before even its name lookup, and listed as refused.
- **Last request** shows exactly what was sent for the last message in each chat, with the key shown as `sk-ant-…A1b2 (redacted)`.

Connections shows what the app’s own code connected to. A program that bypassed the app couldn’t be seen there, which is why you can also check from outside, below. The app ships nothing that does its own networking: the capture helper has no network code, and the keychain component makes no network calls.

In normal use the app has no listening network port. There is one short exception, on your own computer only (127.0.0.1, a random port):

- **Installing an update on macOS:** the updater hands the downloaded update to macOS’s installer through a local port protected by a random password, and closes it once the installer has read the file.

## What other addons can see

Everything inside the game is readable by every addon you run: that’s how the game works, and no addon can change it. So other addons can read the replies and history Bones’s window shows, and the spending line in its header. Your key is never there. “Replies in your chat frame” is off by default, because chat-logging addons keep copies of the chat frame.

## Updates

- Updates come from NeverQuestAlone’s GitHub Releases page. The app checks each installer’s signature and publisher, and refuses one that isn’t newer than what you run.
- By default the app tells you an update is ready and installs it when you quit. It never restarts while the game is running.
- Model names and prices ship with the app. When an AI company changes them, an app update brings the new ones.
- “Never check for updates” is on the app’s Updates page; the app then reminds you monthly, on your computer, never in game.

## Check it yourself

You don’t have to take any of this on trust.

**Watch the network.** While you play and send a few messages:

- **Windows:** [TCPView](https://learn.microsoft.com/en-us/sysinternals/downloads/tcpview) (free, from Microsoft Sysinternals). Filter by the NeverQuestAlone processes. You should see connections only to your AI company (for example `api.anthropic.com`) and, at startup, GitHub. Apart from an update installing on macOS, you should see no listening ports.
- **macOS:** [LuLu](https://objective-see.org/products/lulu.html) (free and open source) or Little Snitch. Both ask before a program connects anywhere, and show you where.

Compare what you see with the app’s Connections page. They should match.

**Find your key where it’s saved.**

- **Windows:** Control Panel > Credential Manager > Windows Credentials. Look for an entry for NeverQuestAlone with your AI company’s name (for example `anthropic.NeverQuestAlone`). On a work PC with a roaming profile, that entry roams with your profile.
- **macOS:** Keychain Access > login keychain. Search for NeverQuestAlone; the account is your AI company’s name.

**Check the download.**

- Every release lists SHA-256 checksums. Compare with `shasum -a 256 <file>` (macOS) or `Get-FileHash <file> -Algorithm SHA256` (Windows PowerShell).
- On macOS, `spctl --assess --verbose "/Applications/NeverQuestAlone.app"` shows Apple’s notarization check. On Windows, the installer’s Properties > Digital Signatures tab shows the publisher.


**Look at what was sent.** Open Last request in the app after any message.

## Credits

NeverQuestAlone is built on [chelinho139/wow-ai](https://github.com/chelinho139/wow-ai) (MIT). Full credits and licenses: [CREDITS.md](CREDITS.md).

---

World of Warcraft, Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries. NeverQuestAlone is unofficial and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter. Other names are the trademarks of their owners and are used only to say which service you can connect.
