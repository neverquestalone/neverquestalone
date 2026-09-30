<!--
DRAFT for the public privacy page (PRD §13.1, §13.3, §13.4; PR-1 to PR-5; B6.4).
AI companies' terms were read on 2026-09-26; re-read every linked page before publishing and update the dates.
Words follow docs/STYLE.md. The AI company cards fold in the fact-checker's corrections (research record §B, provider-privacy and google-xai checks).
Links assume the public files sit side by side at the public repo's root.
Setup offers five AIs: Claude, ChatGPT, Grok, Gemini, and Other (any OpenAI-compatible service at its own address).
Other's service is the player's choice: its card below says so, and names no service's rules as ours.
-->
# Privacy in NeverQuestAlone

NeverQuestAlone runs on your computer and talks to the AI company you choose. There is no NeverQuestAlone server, so we never receive your messages, your game data or your key.

This page lists everything that leaves your computer, what each setting changes, and what each AI company says it does with what it receives. For how the parts fit together, see [How NeverQuestAlone works](HOW-IT-WORKS.md).

## What leaves your computer, and to whom

“Your AI company” means the company behind the AI you picked: Anthropic, OpenAI, xAI or Google, or the service you connected with Other (such as OpenRouter, Groq or Together). A model on your own computer (Other at a `localhost` address, such as Ollama or LM Studio) keeps what you ask on your computer, unless you pick one of Ollama’s cloud models.

| What | Default | Where you change it |
|---|---|---|
| **What you type** | Sent to your AI company | — |
| **Your character’s name, realm and guild** | **Not sent.** The AI sees “your character” instead | Privacy page: “Your character’s name, realm and guild” |
| **Your character’s game data:** level, class, race, zone and position, money, experience, talents, professions, and your quest log: every quest’s ID and title, and which are ready to turn in | Sent with each message while game data is on | Privacy page: “Game data”; or for one message, the Game Data box above the window’s message box |
| **Check-in data:** quest objectives and levels, gear and item levels, nearby points of interest | Sent only if you turn check-ins on (they’re **off** by default) | Privacy page: “Check-ins” |
| **Items you link** | The item’s tooltip text. For now that can include a line another addon adds to the tooltip, such as a bag addon naming your other characters <!-- CV-03: back to “never lines other addons add” when the Chats.lua fix ships --> | — |
| **Other players’ names from the game:** your target, player links you shift-click, “Made by” lines on items | **Replaced** with stand-ins such as “Player A” before sending; the stand-in stays the same until you quit, and is swapped back in the reply on your computer | Privacy page: “Other players’ names from the game” (off) |
| **Names you type yourself** | Sent as you typed them (the app can’t tell a name from any other word) | — |
| **Other players’ chat** | **Never read.** The addon doesn’t listen to chat at all | — |
| **Memory:** short notes the app keeps about your character’s progress | Sent as a labeled summary with each message | Memory page: view or forget them |
| **Your chat history** | **Stays on your computer**, deleted after 30 days | Privacy page: “Keep chat history for”; Memory page: Delete all chat history |
| **A random install ID**, only if you use OpenAI | Sent to OpenAI as its “safety identifier”, so abuse is handled per install rather than per key. It’s random, not based on your hardware | Your AI page: Replace ID |
| **Anything to us** | **Nothing.** No telemetry, analytics or crash reports | — |
| **Update checks** | GitHub sees your IP address and the app’s version, as with any download | Updates page: “No checks” |
| **Spell-check dictionaries** | Never downloaded: spell check is off in every window | — |

**You can see exactly what was sent.** The app’s Last request page shows the whole last request for each chat, with your key hidden.

**On your computer,** the app keeps your chat history, memory notes, usage totals and logs in a folder only your user account can read. Logs never contain your key, and the diagnostics you copy for a bug report hold no messages, replies or error text from your AI company. Uninstalling removes all of it, your saved keys included, and the addon’s folders in WoW if you choose. On Windows, removing the app in Settings > Apps also removes the chat history the addon keeps in WoW’s own folder. On a Mac it doesn’t yet: to remove it, delete the addon’s file in `WTF/Account/<your account>/SavedVariables` (inside your WoW folder’s `_forever_` folder). <!-- CV-07: the Windows uninstaller removes it (SY-01); back to “removes all of it” when the Mac does too -->

**On your screen,** the app reads only the small corner the addon draws in WoW’s window, so your messages go at once. It doesn’t look at the rest of your screen. If you’d rather nothing is read, turn off **Screen Reading** in the addon’s Settings (under What Bones Knows): nothing is drawn, your messages wait for a reload, and replies still come in. [How it works](HOW-IT-WORKS.md#no-screen-reading) has the details.

## Why these defaults

- Character names can identify real people, so they count as personal data in many places. A stand-in name that the AI company can’t link back to anyone lowers that risk; it doesn’t make the data anonymous, and it can’t cover names you type.
- When you use NeverQuestAlone privately, for yourself, you’re the one choosing to send your messages. The defaults decide how much of *other* players’ information goes along, so they send as little as possible: no chat, no names from game data, nothing to us.
- This is how we read the rules, not legal advice.

## Your AI company’s rules

With your own key, **you are your AI company’s customer**, under its terms and privacy policy. When you connect an AI, the app shows its company’s card below and asks you to confirm you meet its age and use rules.

These cards summarize each AI company’s own pages as read on **2026-09-26**. AI companies change their terms; the linked pages are what counts.

### Anthropic (Claude)

- **Kept:** API data is deleted within 30 days by default. For the models Anthropic calls “Covered Models” (Fable 5 and 5.1, Mythos 5 and 5.1) messages and replies are kept **at least** 30 days, and longer during a safety investigation or where the law requires. Content flagged for policy violations can be kept up to 2 years.
- **Used for training:** no, unless you send Anthropic feedback.
- **Zero retention:** by arrangement with Anthropic’s sales team, per organization; not available for the Covered Models without Anthropic’s authorization.
- **What NeverQuestAlone sets:** nothing extra; it sends only the request.
- **Age:** Anthropic expects products that minors use to have extra safeguards.
- **Sources:** [API data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention) · [How long do you store my organization’s data?](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data) · [Covered Models retention](https://support.claude.com/en/articles/15425695) · [Guidelines for organizations serving minors](https://support.claude.com/en/articles/9307344-responsible-use-of-anthropic-s-models-guidelines-for-organizations-serving-minors)

### OpenAI

- **Kept:** abuse-monitoring logs up to 30 days (longer if the law requires or to prevent harm). Responses are stored for 30 days **unless** the request says not to, and NeverQuestAlone always does (`store: false`).
- **Used for training:** no, unless your OpenAI organization has opted in to data sharing. NeverQuestAlone can’t see that setting; check it in your OpenAI account.
- **Zero retention:** by OpenAI’s approval.
- **What NeverQuestAlone sets:** `store: false` on every request, and a random install ID as the safety identifier (see the table above).
- **Age:** OpenAI publishes guidance for apps that under-18s may use.
- **Sources:** [Your data](https://developers.openai.com/api/docs/guides/your-data) · [Conversation state](https://developers.openai.com/api/docs/guides/conversation-state) · [Under-18 guidance](https://developers.openai.com/api/docs/guides/safety-checks/under-18-api-guidance)

### xAI (Grok)

- **Kept:** requests and replies are stored for 30 days, encrypted, to check for abuse, then deleted.
- **Used for training:** no, without your permission.
- **Zero retention:** a team-wide switch in the xAI console (xAI says it doesn’t recommend it for most customers).
- **What NeverQuestAlone sets:** `store: false`.
- **Source:** [xAI security FAQ](https://docs.x.ai/developers/faq/security)

### Google (Gemini)

Google’s Gemini API terms require users to be 18 or older, say the Gemini API is for professional or business use, and allow it for users in the EEA, Switzerland and the UK only on paid plans. When you connect Gemini, the app asks you to confirm that you meet Google’s rules. As read on 2026-09-29:

- **Kept:** messages and replies are logged for 55 days to check for abuse. The Gemini API offers no guaranteed zero retention (Google points to Vertex AI for that).
- **Used for training:** on the paid tier, no. On the free tier, **yes, and people may read it**, except for users in the EEA, Switzerland and the UK, who get the paid-tier terms.
- **Paid tier:** set up billing on your Google AI Studio project.
- **What NeverQuestAlone sets:** nothing extra. It sends only your message, to Google’s OpenAI-compatible address (`generativelanguage.googleapis.com`).
- **Sources:** [Gemini API Additional Terms](https://ai.google.dev/gemini-api/terms) · [Usage policies](https://ai.google.dev/gemini-api/docs/usage-policies) · [Zero data retention](https://ai.google.dev/gemini-api/docs/zdr) · [OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

### Other (any OpenAI-compatible service)

Other connects any service that speaks the OpenAI chat format, at the address you give it: OpenRouter, Groq, Together, or a model on your computer with Ollama or LM Studio.

- **Kept, and used for training:** whatever that service’s own rules say. Read its privacy policy before you connect it. OpenRouter, for example, doesn’t store messages by default, and routes to AI companies with rules of their own.
- **On your computer:** an address on `localhost` (`127.0.0.1`) keeps your messages here. Keep your model server listening only on this computer, as Ollama and LM Studio do unless you change it. Ollama’s “cloud” models (their names end in “cloud”) run on Ollama’s servers, so your messages leave your computer.
- **What NeverQuestAlone sets:** nothing extra. It sends only your message, with your key if you gave one, and connects only to the one host of the address you gave it: https for a service, http only for this computer.
- **Sources:** [OpenRouter data collection](https://openrouter.ai/docs/guides/privacy/data-collection) · [Ollama privacy](https://ollama.com/privacy) · [LM Studio privacy](https://lmstudio.ai/app-privacy)

## Age

World of Warcraft is rated T, and each AI company sets its own age and use rules for the people using its service. When you connect an AI, the app asks you to confirm that you meet its company’s rules. If you’re under an AI company’s minimum age, don’t use its AI.

## Questions

Open an issue on the project’s GitHub page. Don’t include your key, the code that links the addon to the app, or anything from Last request you’d rather keep private.

A security problem? Report it privately on the Security tab (Report a vulnerability), never in a public issue.

---

World of Warcraft, Warcraft and Blizzard Entertainment are trademarks or registered trademarks of Blizzard Entertainment, Inc. in the U.S. and/or other countries. NeverQuestAlone is unofficial and is not affiliated with or endorsed by Blizzard Entertainment, Anthropic, OpenAI, Google, xAI or OpenRouter. Other names are the trademarks of their owners and are used only to say which service you can connect.
