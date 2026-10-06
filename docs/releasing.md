---
title: Release your own
description: Give your build its own name and IDs, sign it as yourself, and publish signed updates.
status: ready
---

# Release your own

The code is MIT-licensed, but the name NeverQuestAlone and its artwork aren’t: a build you release carries your own name, icons, signature and updates.

## 1 Name it

A build takes its name and IDs from one file, `plugins/<id>/identity.json`, in the folder that `"plugin"` names in `package.json`. Copy `plugins/example/` to a folder of your own, set `"plugin"` to that folder’s name, and fill in every field:

| Field | What it is |
|---|---|
| `appId` | Your app’s ID on macOS and Windows, for example `com.example.questhelper`. |
| `productName` | Your app’s name, on its installer and its folders for data and logs. |
| `name` | Its package name, in lowercase: its update cache, and its data folder on Linux. |
| `keychainService` | The name your users’ keys are saved under. Windows and Linux don’t keep apps’ saved passwords apart, so this name is all that does. |
| `captureHelper` | The capture helper’s `bundleId` and `app` name on a Mac, or `null` for an app without one. |
| `nsisGuid` | Your Windows installer’s ID. Make a new one: Windows finds an installed app by it. |
| `releases` | The GitHub repository updates come from, as `{ "owner": "…", "repo": "…" }`, or `null` for no updates. |
| `copyright` | Your app’s copyright line. |

The build refuses to sign an app that has NeverQuestAlone’s `appId` or `keychainService` under another name, or another plugin’s.

`identity.json` renames what the system sees. Change these too:

- `name` and `productName` in `app/desktop/package.json`: a run from source takes its data folder from them.
- The Mac capture helper’s own ID, in `app/desktop/build/bridge/capture/mac/BUNDLE_ID`, and the app ID it expects, your `appId`, in `bridge/capture/mac/Sources/NQACapture/PeerCheck.swift`.
- The icons in `app/desktop/build/`, and the words in the app and the addon, which say NeverQuestAlone.

`tests/frozen_names_test.mjs` holds NeverQuestAlone’s own names, so rewrite it for yours.

## 2 Sign it as yourself

Your users’ computers warn about, or refuse, apps nobody signed. A signed release needs Apple’s Developer Program ($99 a year) and a Windows code-signing certificate:

- Mac: a Developer ID Application certificate. The release signs the app and sends it to Apple for notarization with an App Store Connect API key.
- Windows: a code-signing certificate. Set the repository variable `WINDOWS_PUBLISHER` to the name it’s issued to, exactly: the build pins it, and your app refuses updates signed by anyone else.

Keep your certificates and keys in your repository’s protected release environment, never in the code.

## 3 Publish a release

1. Copy `docs/release-template.yml` to `.github/workflows/release.yml`. Its first lines list the secrets and variables it needs.
2. Set `releases` in your `identity.json` to your repository.
3. Set the version in `app/desktop/package.json` and push it to your default branch.
4. Start the workflow from the Actions tab, or run `gh workflow run release.yml`.

It builds, signs and notarizes both apps, adds checksums and a package list (SBOM), records where it was built, and publishes a GitHub release that’s also your update feed.

## 4 Check your release

Before you tell anyone:

- Mac: `spctl --assess --verbose "/Applications/<Your App>.app"` says it’s accepted and notarized.
- Windows: the installer’s Properties > Digital Signatures shows your publisher.
- `shasum -a 256 <file>` on a Mac, or `certutil -hashfile <file> SHA256` on Windows, matches its line in `SHA256SUMS.txt`.
- In a public repository, `gh attestation verify <file> --repo <owner>/<repo> --signer-workflow <owner>/<repo>/.github/workflows/release.yml` says your release workflow built it.
- Install the previous version, publish a new one, and check that the app updates itself.

## Check NeverQuestAlone’s public build

Each NeverQuestAlone release tag is also built in public, unsigned, by `public-build.yml` in tommygeoco/neverquestalone, which records where each file was built. Download a run’s files from that repository’s Actions tab, or with `gh run download <run id> -R tommygeoco/neverquestalone -p 'public-build-*'`, then check one:

```sh
gh attestation verify <file> -R tommygeoco/neverquestalone
```

It passes only for a file built by a workflow in that repository. Add `--signer-workflow tommygeoco/neverquestalone/.github/workflows/public-build.yml --source-ref refs/tags/v<version>` to check the workflow and the tag too.

NeverQuestAlone’s own downloads are signed and built privately, so they aren’t these files: check them as in step 4. Each release also carries its package list (SBOM).
