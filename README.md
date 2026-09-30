# NeverQuestAlone

**An AI companion for World of Warcraft®: Forever.** Ask Bones in a chat window inside the game (“where do I turn this in?”, “is this ring better than mine?”, “what should I do next?”), and the reply shows up right there, with a route on your map when it helps. Bones knows your character, your quests and your gear, and thinks with an AI you choose: Claude, ChatGPT or Grok with your own API key, or a model on your own computer.

- **Your key, your account.** You pay your AI company directly, as you go. There’s no NeverQuestAlone account, server or subscription.
- **You see what you spend.** NeverQuestAlone sets no limits of its own. What you spend shows in the chat window, you can set a daily spend limit if you want one, and when something needs you, you get one plain line in game.
- **It never plays for you.** No key presses or mouse clicks, no memory reading, nothing posted to chat. The AI can only write text into Bones’s window.

> **Unofficial.** NeverQuestAlone is not made, reviewed or endorsed by Blizzard. It reads a small area of your screen that its addon draws, and writes addon files. It never controls your character. Use it at your own risk. [How it works](HOW-IT-WORKS.md) explains exactly what it does.


## What you need

- **World of Warcraft: Forever**, in Windowed or Windowed (Fullscreen) mode.
- **macOS 14 or later, or Windows 10 or 11.**
- **An AI:** an API key from Anthropic (Claude), OpenAI (ChatGPT), xAI (Grok) or Google (Gemini); or any OpenAI-compatible service, such as OpenRouter, Groq or Together with its own key, or Ollama or LM Studio on your computer with a model already downloaded (best with 16 GB or more of graphics memory, since the model shares your graphics card with the game).

## Set up in three steps

Setup takes about 5 minutes with an API key in hand, or about 10 if you make one.

### 1 Download

Download NeverQuestAlone from https://github.com/neverquestalone/neverquestalone/releases. On a Mac, open the `.dmg`, drag NeverQuestAlone to Applications, then open it from Applications; macOS asks whether you’re sure, so click **Open**. It’s signed and notarized by Apple. On Windows, open `NeverQuestAlone-Setup-<version>.exe`: it installs and opens by itself. To check a download first, its SHA-256 (`shasum -a 256` on a Mac, `certutil -hashfile <file> SHA256` on Windows) should match SHA256SUMS.txt on the release page.

### 2 Connect your AI

NeverQuestAlone asks which AI Bones should use.

- **Claude, ChatGPT, Grok or Gemini:** pick one, and the app shows you how to get an API key from its AI company. Copy the key, then click **Paste key**. The app tests the key with one tiny request and saves it in your macOS Keychain (Windows Credential Manager on Windows).
- **Other:** any service that speaks the OpenAI chat format. Paste its base URL (for example `https://openrouter.ai/api/v1`, or `http://localhost:11434/v1` for Ollama on this Mac), your key (leave it empty for a server on this Mac) and the model’s name, then click **Connect**. The app tests it with one tiny request and saves it.

Then check your defaults: the model (with what a typical day costs on it), what Bones sends with your messages, and whether the app starts when you sign in to your Mac. The defaults send the least that works: your character’s name, realm and guild stay out, other players’ names from the game are replaced with stand-ins, and check-ins are off. [Details](PRIVACY.md). There’s no spend limit unless you set one later, on the app’s Usage page.

### 3 Say hi in game

1. **The app installs its addon in WoW.** If WoW is open, click **Install when WoW closes**, and it installs the moment you quit. New addon files load only when the game starts, not on a `/reload`.
2. **On a Mac, allow Screen Recording** when the app asks. It reads only the small corner its addon draws in the game window. About once a month macOS may ask again; that’s macOS, not a problem with the app. If you’d rather allow no screen reading at all, see [No screen reading](#no-screen-reading).
3. **Start WoW and log in.** Bones meets you by your quest tracker.
4. **Say hi.** Click **Say Hi** in Bones’s welcome, or type `/bones hi`. Bones answers in game, and setup is done.

NeverQuestAlone lives in your menu bar (on Windows, the system tray by the clock). Open it for your AI and keys, what you spend, Connections (every host it talks to) and Last request (exactly what was sent).

## Your AI

| | What you need | Cost | Privacy |
|---|---|---|---|
| **Claude, ChatGPT, Grok or Gemini** | An API key from Anthropic, OpenAI, xAI or Google, with a few dollars of credit | The AI company’s prices. For example, Claude Haiku 4.5 is about 0.4–0.9¢ a reply, about $0.17–0.37 a day at 40 replies, so $5 of credit lasts about 2–4 weeks (estimates; the app shows real figures) | Each AI company’s card in [PRIVACY.md](PRIVACY.md). Google’s terms for Gemini say you must be 18 or older |
| **Other: an OpenAI-compatible service** | Its base URL, a key if it takes one, and a model’s name: OpenRouter, Groq, Together and others | The service’s prices, paid to it directly; the app shows the exact cost only when the service reports it | The service’s own rules |
| **Other: a model on your computer** | Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`) with a model downloaded | $0 | What you ask stays on your computer. The model shares your graphics card with the game and can lower your frame rate |

**A Claude Pro or Max subscription isn’t an API key** and doesn’t include API credit; the same goes for ChatGPT, Gemini and Grok subscriptions. Only API keys work: that’s the only way these AI companies let apps like this one connect.

**Your key goes in the app, never the game.** It’s saved in your macOS Keychain (Windows Credential Manager on Windows) and sent only to its own AI company. If you paste something that looks like a key into the game by mistake, it isn’t sent or saved.

**Set a spend limit at your AI company.** The app links to the right page. NeverQuestAlone has no spend limit of its own, so the one at your AI company is what stops a runaway bill or a leaked key.

## What it costs

NeverQuestAlone sets no limits: not on what you spend, not on the messages you type, not on check-ins (what Bones says on its own after a level-up, a new zone or a finished route; they’re off until you turn them on). The one exception is a safety catch that normal play never reaches: if something goes wrong and more than 10 check-ins come in a minute, Bones pauses check-ins until you send a message ([details](HOW-IT-WORKS.md#what-it-costs)). What you spend is up to you and your AI company:

| | |
|---|---|
| **Your AI company’s limits** | The spend limit you set there, and its rate limits. When one is reached, you get one line in game, for example “You’ve reached the spend limit you set at Anthropic.” |
| **Your own daily spend limit, if you want one** | None unless you set it, on the app’s Usage page. With a $5.00 limit, for example, you’d see: “You’ve reached your daily spend limit ($5.00). Raise it in the NeverQuestAlone app, or it resets at midnight.” |
| **A model on your computer** | $0 |

The app never switches to another AI on its own. When something goes wrong, you get one line in game (for example “Your Anthropic account is out of credit.”), and the fix is one click away in the app.

## In game

| Command | What it does |
|---|---|
| `/bones` | Opens or closes the window |
| `/bones <question>` | Asks in the open chat |
| `/bones hi` | Says hi (the first time, it finishes setup) |
| `/bones stream on` | No screen reading, as the Screen Reading switch in Settings: see below. `/bones stream off` goes back |
| `/bones mode reload` | Stricter: replies wait for a reload too. `/bones mode pixel` goes back |
| `/bones diag` | Diagnostics for a bug report |
| `/bones help` | The main commands; `/bones help all` lists every one |

**Keep the game’s sound on.** Replies arrive a few seconds after the AI finishes, and the addon hears about them through a sound file. The volume can be 0, but with Enable Sound off the addon checks on a timer instead, and replies can take up to a minute. The app tells you when this happens.
### No screen reading

Turn off **Screen Reading** in the addon’s Settings (under What Bones Knows). Nothing is drawn: your messages wait for a reload (click Reload above the chat window; a short loading screen, never in combat), and replies still come in. `/bones stream on` does the same; turning Screen Reading back on, or `/bones stream off`, switches back. `/bones mode reload` is stricter still: replies also wait for a reload.

## Check it yourself

- **Connections** in the app lists every host it contacted. Compare it with [LuLu](https://objective-see.org/products/lulu.html) or Little Snitch on macOS, [TCPView](https://learn.microsoft.com/en-us/sysinternals/downloads/tcpview) on Windows. You should see only your AI company and GitHub.
- **Last request** shows exactly what went to your AI company.
- **Your key** is in Keychain Access under NeverQuestAlone, with your AI company as the account.
- **Every release** lists SHA-256 checksums.

More in [How it works](HOW-IT-WORKS.md#check-it-yourself).

## Troubleshooting

- **The addon isn’t in the game.** Quit the game completely and start it again: new addon files don’t load on `/reload`.
- **Replies are slow.** Check that Enable Sound is on in the game’s sound settings (the volume can be 0).- **Nothing happens when you send.** Open the app: its setup screen shows which step stopped. On macOS, check System Settings > Privacy & Security > Screen & System Audio Recording (Screen Recording on macOS 14). macOS full screen (the green button, which moves the game to its own Space) is untested; use the game’s own display modes.
- **An error line in game.** It names the fix, usually in the app: a new key, credit or a higher spend limit at your AI company, or starting the model server on your computer.

## Report a bug

Open an issue and attach the diagnostics from the app (Diagnostics > Copy diagnostics). They hold the app and addon versions, your system, whether screen reading works, how many replies fit before your next reload, the kinds of errors, and the last 200 log lines. Keys, your install token (the code that links the addon to the app) and your home folder’s paths are taken out, and there are no messages, replies or error text from your AI company. **Never paste an API key**, and don’t paste `/bones diag full` output, which shows your install token.

A security problem? Report it privately on the Security tab (Report a vulnerability), never in a public issue.

## Credits and license

NeverQuestAlone is built on [chelinho139/wow-ai](https://github.com/chelinho139/wow-ai) and credits [0xInuarashi’s wow-forever-codex](https://github.com/0xinuarashi/wow-forever-codex) as wow-ai does. Full credits and third-party notices: [CREDITS.md](CREDITS.md). Licensed under the [MIT license](LICENSE).

---

World of Warcraft, Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries. NeverQuestAlone is unofficial and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter. Other names are the trademarks of their owners and are used only to say which service you can connect.
