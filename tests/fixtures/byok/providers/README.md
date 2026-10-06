# Provider fixtures (docs-derived, UNVERIFIED)

Replayed by the mock provider server in `tests/byok/helpers/mock-provider.mjs` for the provider-layer conformance suite (PRD §18.2 PV-8, acceptance B0.4, B2.1, B2.2, B2.11).

**Every file here is written from the providers' documentation and the fact-checked research notes of 2026-09-26, not captured from a live API.** Treat each as UNVERIFIED until it is replaced by a live capture with the key redacted (B0.4). Where a file rests on a single field report or on general knowledge rather than a doc, its `source` says so. No file contains a real key; the test keys are canaries built in the tests.

## Formats

- `*.sse`: a raw server-sent-events body, served with status 200 and `content-type: text/event-stream`.
- `*.json`: an HTTP envelope, `{status, headers, body, source}`. `body` is sent as JSON. A header value `{{now+N}}` is replaced at load time with `Date.now() + N` (milliseconds), for reset times that must be in the future.

## Notable cases

| Provider | File | What it pins down |
|---|---|---|
| Anthropic | `http-400-credit-low.json` | Low credit as a 400 with "credit balance is too low" (field report), beside the documented 402 `billing_error` |
| Anthropic | `http-429-spend-limit.json` | Tier spend cap: 429 with `error.details.error_code: enforced_spend_limit_reached` and no `retry-after` |
| Anthropic | `error-overloaded-midstream.sse` | An `error` event after a 200 |
| OpenAI | `failed-*.sse`, `error-event-misalignment.sse` | Errors inside the 200 stream (`response.failed`, `error`) |
| OpenAI | `http-400-identifier-blocked.json` | "identifier blocked"; the body shape is a guess |
| xAI | `http-403-spending-limit.json` | One third-party capture; xAI's docs only say "rejected" |
| OpenRouter (through Other) | `error-in-200.json`, `error-midstream.sse` | Errors under HTTP 200, with and without streaming |
| OpenRouter (through Other) | `http-403-moderation.json` | A body that quotes the player's prompt: it must never reach a log |
| Google (Gemini) | `http-400-invalid-key.json` | A bad key is a 400 whose message says so, in a list-wrapped body, never a 401 |

The `openrouter/` and `lmstudio/` files are what those services send; since 2026-09-29 players reach them through Other (custom), and the tests replay them through its manifest.
