# Browser Surface: a sandboxed `<webview>` embed, renderer-driven, clamped by main

**Status: ACCEPTED** (2026-07-03). Builds on **ADR-0002** (thin orchestrator — no agent-facing
browser automation), **ADR-0013** (the Surface/tab model the Browser Surface slots into),
**ADR-0014** (the feature-registrar / pure-module-seam precedents). PRD #215; slice ladder
#216/#217/#218. Reference implementation: t3code's "Preview" (`apps/web/src/browser/` +
`apps/desktop/src/preview/`) — an Electron `<webview>` driven per-scope, security-clamped at
attach time.

## Context

The side panel has reserved a Browser card ("Preview a local dev server") since #187/#193. The
question that decides everything else is the EMBEDDING MECHANISM. Three candidates:

- **`<iframe>`** — pure renderer, but blocked twice over: our CSP (`default-src 'self'`, no
  `frame-src`) and `X-Frame-Options`/`frame-ancestors` on real sites. Widening the app CSP to
  un-block it is backwards: the page would also share the renderer's origin-ish context.
- **`WebContentsView`/`BrowserView`** — Electron's headline recommendation, but it floats ABOVE
  the DOM in main-owned pixel coordinates: it doesn't clip to flex containers, so the panel's
  drag-resize, tab switching, the narrow-viewport Sheet, and background-Workspace hiding all
  become manual bounds-sync IPC. t3code evaluated the same trade and chose the webview tag;
  their workaround inventory for it (a rect-tracking overlay store) exists precisely because
  even THEY needed webview's DOM behavior, just with a root-mounted host.
- **`<webview>` tag** — a real DOM node: composites, clips, and resizes with CSS inside the
  panel like any other Surface. Electron's docs caution about the tag mostly concern its
  historical default prefs; every knob it warns about is clampable at attach time.

## Decision

1. **The embed is the `<webview>` tag** (t3code's production-proven choice), declared by
   `BrowserSurface` with `partition` / `webpreferences` / `useragent` computed by the pure,
   tested `src/shared/browser-guest.ts`. The `webpreferences` attribute string is locked by
   test because Electron splits it on `,` WITHOUT trimming and coerces non-boolean-literal
   values to truthy STRINGS — a malformed string silently weakens the sandbox (t3code's
   `WebviewPreferences` gotcha).

2. **The view is DISPOSABLE; no root-mounted overlay.** t3code mounts one global webview host
   over an in-layout slot (rect-tracking store) so the page survives their panel unmounting. We
   deliberately skip that machinery: the webview lives inside the Surface; unmounting (tab
   close, Workspace backgrounded) discards the page and the persisted URL (slice 2, #217)
   reloads it on return. Dev-server pages are cheap to reload; the overlay pattern is the known
   upgrade path if that assumption fails.

3. **Guest security posture, three layers, stricter than t3code where possible.**
   (a) Per-Workspace persisted partition `persist:vibe-browser-<fnv1a(workspaceDir)>` — preview
   cookies/storage survive restarts, never mix across Workspaces or with the app session.
   (b) Tag prefs: `sandbox=true`, `contextIsolation=true`, `nodeIntegration=false`,
   `nodeIntegrationInSubFrames=false`, NO preload. (t3code runs `contextIsolation=false` for
   their element-picker preload; we ship no guest preload, so isolation stays ON.)
   (c) Main's `will-attach-webview` clamp (`src/main/browser/webview-clamp.ts`, pure +
   unit-tested): an attachment is REJECTED unless its partition matches the derived grammar
   EXACTLY (`persist:vibe-browser-` + 8 hex — never a prefix test; `persist:` names map onto
   storage directories, so an attacker-chosen suffix could alias another session) AND its
   initial `src` is http(s)/about:blank (the URL policy re-enforced where a compromised
   renderer can't reach). The FULL set of security prefs Electron consults is then
   force-overridden — sandbox/contextIsolation/nodeIntegration(±SubFrames/Worker)/webSecurity/
   allowRunningInsecureContent/experimentalFeatures/webviewTag, enableBlinkFeatures and any
   preload stripped — regardless of what the renderer declared. Enabling `webviewTag: true`
   on the host window is compensated by this gate.

4. **Navigation is RENDERER-DRIVEN; main stays thin.** The component drives the element
   directly (`loadURL`/`goBack`/`reload`/DOM events). No per-navigation IPC, no main-side tab
   registry — t3code's `webContents.fromId` control plane exists to serve agent automation
   (CDP click/type/screencast), which ADR-0002 rules out here: browser automation is an agent
   capability and belongs to Vibe, not the orchestrator. Everything the webview is asked to
   load passes the pure URL policy (`side-panel/browser-url.ts`): scheme-less input infers
   `http://`, but only `http:`/`https:` results are blessed — `file:`/`javascript:`/custom
   schemes refuse rather than launder.

5. **Guests never spawn windows — and never leave http/https.** On `did-attach-webview`, main
   installs a window-open handler on the guest (deny everything, route http/https targets to
   the system browser via the existing `safeExternalUrl` guard — the terminal-link posture)
   AND a `will-navigate` guard blocking page-initiated navigation to any non-http(s) scheme
   (an external-protocol link in untrusted page content must not launch an OS handler). The
   renderer's URL policy gates what the URL bar submits; these gates cover where the page
   tries to go on its own.

6. **Singleton per Workspace** (`browser:main`) this slice; the reserved `browser:${resourceId}`
   descriptor shape keeps multi-tab additive. The Electron/app UA tokens are stripped from the
   guest so dev tooling treats it as ordinary Chrome.

## Consequences

- The panel gains a live Browser card with zero layout special-casing; all Surface chrome
  (resize, tabs, Sheet) works unmodified.
- Backgrounding a Workspace or switching tabs reloads the page on return (accepted; see
  decision 2). Long-lived page state (e.g. a signed-in preview) survives via the partition,
  not the DOM.
- `webviewTag: true` is a widened surface on the host window; the attach clamp is the
  compensating control and is the piece that must never regress (its test file + an
  adversarial review gate slice 1).
- Slices 2 (#217: states/persistence/⌘T/DevTools/open-external) and 3 (#218: dev-server
  discovery over a new `browser` IPC domain) build on this without revisiting the embed.
