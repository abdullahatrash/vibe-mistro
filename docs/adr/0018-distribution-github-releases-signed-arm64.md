# Distribution: signed arm64 DMG + App updates via GitHub Releases

**Status: ACCEPTED** (2026-07-03). Builds on **ADR-0002** (thin orchestrator — distribution is
app-shell concern, no agent involvement). Reference implementation: t3code's release pipeline
(`.github/workflows/release.yml`, `scripts/build-desktop-artifact.ts`, `electron-updater`), minus
its nightly channel and custom manifest merging.

## Context

The app is unreleased. We want a marketing page (one page, one macOS download button) on Vercel,
a GitHub Actions release pipeline, and self-updating installs — while the repo becomes a Bun-
workspaces monorepo (`apps/desktop` + `apps/web`). The load-bearing constraint is macOS
Gatekeeper: an unsigned, un-notarized download is blocked outright on modern macOS, and
`electron-updater` refuses to auto-update unsigned apps — so signing is not optional for either
stated goal. An Apple Developer account exists.

## Decision

1. **Artifacts and the update feed live on GitHub Releases** (public repo), single **stable
   channel**. `electron-builder --publish` uploads DMG + ZIP + `latest-mac.yml` on release;
   `electron-updater`'s GitHub provider reads the same feed. No buckets, no update server, no
   nightlies — that machinery (t3code's) earns its keep only with private repos or multiple
   channels.
2. **Apple Silicon (arm64) only** for the beta. Every Mac since 2020 is arm64, the audience
   (developers running Vibe agents) skews recent, and one arch avoids universal-binary
   native-module (node-pty) merging in CI. Intel only if demand appears.
3. **Two mac targets per Release**: DMG (what humans download) and ZIP (what `electron-updater`
   actually consumes on macOS — it does not update from DMGs).
4. **Versionless asset name** (`Vibe-Mistro-arm64.dmg` via `artifactName`) so the marketing
   page's button is the permanent `releases/latest/download/…` redirect — the page never
   redeploys per release and needs no API-querying redirect function.
5. **Trigger**: push a `v*.*.*` tag → build, sign (Developer ID), notarize, publish;
   `workflow_dispatch` as the re-run escape hatch. A guard step asserts tag == `package.json`
   version so the feed can never disagree with the binary.
6. **App-update UX is passive**: check on launch + periodically, download in the background,
   show a quiet "restart to apply" affordance, install on quit. Never auto-restart — the app
   supervises live `vibe-acp` processes and a forced restart would kill in-flight turns (same
   rule as "no Vibe upgrade mid-turn").
7. **Packager is electron-builder** — it is what `electron-updater` pairs with, what
   electron-vite integrates with, and what t3code ships with. The packaged app gets a real
   `appId` (`com.abdullahatrash.vibe-mistro`); the dev-time "don't touch CFBundleIdentifier"
   rule (TCC) concerned patching the dev Electron binary and does not apply to the packaged app.

## Consequences

- **The feed URL ships inside every installed app.** Once installs exist in the wild pointing at
  GitHub Releases, moving hosts requires shipping a migration update from the old feed first —
  this is the hard-to-reverse edge of the decision. Making the repo private would break both
  downloads and updates for existing users.
- Build order: monorepo conversion first (CI paths, builder config, Vercel root directory all
  bake in the layout), then a locally-proven signed DMG, then the release workflow, then the
  in-app App-update UI, with the Astro marketing page in parallel.
- Signing secrets (`CSC_LINK`, `APPLE_ID`, app-specific password / API key) live only in GitHub
  Actions secrets — consistent with ADR-0003's "we never store credentials" posture.
