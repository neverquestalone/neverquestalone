# NeverQuestAlone desktop app

The tray app players run (BYOK PRD §11.2 DB10, §11.5 DB12, §16; BUILD-PLAN "Desktop app"). One Electron process runs the bridge in-process behind the app API, a tray (status, Open, Pause, Quit) and one settings window made on demand: setup (§16.1's steps less the limits step: 8 in all), Provider & keys, Usage, Connections, Last request, Privacy, Memory, Diagnostics, Updates, About. The tray and the window follow the bridge's status pushes (`api.onChange`, debounced 150 ms).

No usage limits of its own (maintainer, 2026-09-26): Usage shows spend and message counts as information, and the one limit is a daily spend limit the player may set there (`setCaps({dailyUsd})`, null for none, the default; never pre-filled). Main asks before a limit is set, raised or turned off, not when it's lowered. The runaway fuse's pause (`usage.fuse`) shows as one line with Okay; nothing else about it appears in the window.

## Run

```bash
cd app/desktop
npm ci                      # then npx install-electron --no (Electron 44 fetches its binary on first run)
npm start                   # the real bridge (bridge/byok/boot.mjs from the repo)
npm run start:mock          # always demo data
npx electron . --self-test  # hidden window; prints one JSON line, then quits through the real quit (< 20 s)
npx electron . --self-test --no-relaunch  # the window alone, then quits as Quit and reopen does (app.relaunch skipped)
npx electron . --screenshots <dir>   # every window state as PNGs, light and dark, with INDEX.txt
```

The tests live in `tests/byok/app_*_test.mjs` and run under plain `node --test` (no Electron, no `app/desktop/node_modules`).

## The window

The settings page is served from the app's own scheme, `nqa://app/` (`src/scheme.mjs`): registered as privileged (standard, secure) before ready and served with `protocol.handle` from the `renderer/` folder only (inside `app.asar` when packaged). The handler resolves and prefix-checks every path (links too), serves only regular `.html`, `.js`, `.css` and `.png` files, answers GET and HEAD only, never lists a folder, and sends the page's CSP as a header (`default-src 'none'`; `nqa://app` the only script, style and image source; no connections). The app never loads a `file:` page.

What Chromium may request is decided by `session.webRequest.onBeforeRequest` on the default session and electron-updater's own partition (`src/net-guard.mjs`): the app's scheme (renderer-file paths only), https to the update feed's hosts (GitHub releases, its API and asset CDNs) only while update checks are on in a packaged app, devtools in an unpackaged run, and nothing else: no `file:`, no provider (those are the bridge's, through Node and its own egress guard), and never the OpenRouter sign-in page, which only opens in the player's browser through `shell.openExternal`. Connections shows what the guard allowed and refused.

The model check's notice (`status().backend.notice`, PV-3) shows once as a plain line with Okay; Okay keeps its id in `app-state.json`, and the main process leaves a seen notice out of every status the page gets (`src/model-notice.mjs`). A model whose AI company announced its retirement (the manifest entry's `retiresAfter`, the earliest day, and `moveTo`, the model offered instead; systems critic SY-102-5) is the same path's `model_retiring` notice while it's the model in use: on Home, the day, the model offered and its cost a day from Your AI's own figures, with Use <model> (Your AI's pick) and Okay.

## Package

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir   # unsigned local build in dist/; the log says UNSIGNED BUILD
"dist/mac-arm64/NeverQuestAlone.app/Contents/MacOS/NeverQuestAlone" --self-test
node scripts/self-test.mjs "dist/mac-arm64/NeverQuestAlone.app"     # both runs, checked: the JSON line, the quit's lines, exit 0
node ../../tools/check-fuses.mjs "dist/mac-arm64/NeverQuestAlone.app" # every fuse of the plan (the release gate)
node scripts/dist.mjs --mac        # release build; signing only from environment variables
```

Signing comes only from the environment: `CSC_LINK`/`CSC_KEY_PASSWORD` (Developer ID, or a Windows OV certificate), `APPLE_*` for notarization, and Azure Artifact Signing through `scripts/dist.mjs` (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `NQA_AZURE_ENDPOINT`, `NQA_AZURE_ACCOUNT`, `NQA_AZURE_PROFILE`, `NQA_PUBLISHER_NAME`). Azure signing needs the pinned TrustedSigning module staged first: `pwsh tools/stage-trusted-signing.ps1` checks it and its three packages by SHA-256 and sets `NQA_TRUSTED_SIGNING_MODULE`, and `scripts/sign-azure.cjs` signs each file with that copy, so electron-builder never installs a module itself (systems critic SY-31). With none set the build is unsigned, and on macOS keychain discovery is off, so a build never signs with whatever identity the machine holds.

`scripts/fuses.cjs` (afterPack) flips the fuses before signing, all six of PRD §11.2's list hardened: RunAsNode, `NODE_OPTIONS` and `--inspect` off; load only from the asar, with its integrity checked; and `GrantFileProtocolExtraPrivileges` off, since the page comes from `nqa://app/`. Cookies are encrypted. `tools/check-fuses.mjs` (release.yml's gate) checks every wire of a packaged app against that plan, and fails if the plan ever asks for less than the PRD.

The package carries the bridge boot imports (an explicit list in `electron-builder.yml`, checked against boot's real import graph by `app_build_test`), its manifests, prices and prompt pack, and the addon, all inside `app.asar`, plus `@napi-rs/keyring` for the OS key store (its `.node` unpacked, so outside the asar's integrity hash: on a signed Mac app the code signature covers it; on a per-user Windows or Linux install the player's own account could replace it, which crosses no boundary there). The bridge is ES modules only, so it needs no `package.json` of its own. Each OS's capture helper goes in Resources beside `app.asar` (`src/api-loader.mjs` `CAPTURE_HELPERS`): `NeverQuestAlone Capture.app` (built for arm64 and x86_64 by `bridge/capture/mac/build-app.sh --universal`; `npm run dist` builds it ad hoc when it's missing, and `scripts/sign-mac.cjs`, electron-builder's sign hook, re-signs it with the app's Developer ID, the hardened runtime and no entitlements, SR-06), `capture/nqa-capture.exe` (`bridge/capture/windows/build.sh`) and `capture/capture_x11.py`. `scripts/fuses.cjs` fails a build whose helper is missing.

Updates come from the releases of the public repository `tommygeoco/neverquestalone`, which also holds the source: the releases in the app's identity (`plugins/<plugin>/identity.json`, the plugin the root package.json names), which the updater reads and `scripts/plugin-config.mjs` turns into electron-builder's `publish`.

## The app API

`main.mjs` → `src/api-loader.mjs` → `bridge/byok/boot.mjs` `bootByok({ paths, platform, log, openExternal, importer })`, which makes the key store, config, egress guard, the core with `createLocalBackend`, the capture helper and `createAppApi`; there is no control pipe (BUILD-PLAN "boot.mjs"). A packaged app imports bridge code only from inside `app.asar`; boot's own lazy imports go through the same importer. A missing call answers `{ ok: false, error: 'unsupported' }`; a module that fails to load or start is an error state in the window, never demo data.

Capture (fork PRD §9.10): boot starts the helper itself once there's a WoW folder holding the addon; on macOS through the capture app. A packaged app passes its helper's path in Resources (`paths.captureApp`, `captureExe` or `captureScript`; boot's defaults, the repo's, in a development run) and its own signer, which the helper must be signed by: the Mac app's Developer ID team (`ownTeamId`, from its code signature; none for an ad hoc build, whose helper then can't pass the check) and the Windows app's pinned publisher (`ownPublisher`, from `app-update.yml`).

The packaged self-test also boots the real bridge from inside the asar in a sandbox (`selfTestBridge`): a memory key store, the WoW folder pinned to a path inside the sandbox that doesn't exist, nothing searched for, no capture, no control pipe, no egress hooks, no network checks. It checks the capture helper is in Resources and that the shell's log redacts a key of no known shape (staged, or registered by the bridge).

The self-test ends through the app's real quit, never `app.exit` (systems critic SY-102-2): `app.quit()` as the tray's Quit asks it, so before-quit, will-quit's `preventDefault`, the bridge's stop and `app.exit(0)` all run (`src/quit.mjs`), and the quit flow's lines go to stdout as `{"selfTestQuit": …}`. `--no-relaunch` quits as Quit and reopen does instead, with `app.relaunch` skipped and a second launch during the committed quit (SY-102-3). `scripts/self-test.mjs` runs both, wherever CI runs the packaged self-test, and needs quit-requested, quit-committed and "the bridge stopped", in order, nothing stalled, and exit code 0.

## Screenshots

`npx electron . --screenshots <dir>` (development runs; a packaged app refuses it, `--self-test` or not) opens the window hidden against the controllable mock (`src/mock-api.mjs` `control`), puts it in each state in `src/screenshots.mjs` by clicking through the page as a player would, and writes `webContents.capturePage` PNGs, the window grown to each page's height, in light and dark, with `INDEX.txt`. Native confirms and the "Choose folder…" dialog are answered by the scene; the daily spend limit's confirms are drawn as previews of their text. Keys are canaries. The driver is `src/screenshots.mjs`'s too (`screenshots(hooks)`, code health AP-15), so the shipped `main.mjs` holds none of it: main hands it the window, the app state and the mock, and reads back only what a scene shows main's confirm, folder dialog, app info, updater and clipboard.

## Uninstall

In the app (General → Uninstall): the bridge's `uninstall` removes the keys and, when asked, the addon; the shell turns off the login item, resets Screen Recording for the app and the capture helper on macOS, shows the last step (drag the app to the Trash, …) in a dialog that stays until Okay, then quits and deletes the data folder, the logs folder, electron-updater's cache and Squirrel.Mac's (`src/uninstall.mjs`). The Windows uninstaller (`build/installer.nsh`) also removes the Run value, the `NeverQuestAlone` credentials (and the `NeverQuestAlone` ones earlier alpha builds saved) and the update cache, except when it runs as part of an update.
