# Browser element picker: injected via executeJavaScript in the guest's isolated world

**Status: ACCEPTED** (2026-07-03). Builds on **ADR-0015** (Browser Surface webview embed +
guest security posture — this preserves it) and **ADR-0002** (thin orchestrator — the picker is
a USER affordance, not an agent tool). PRD #223; slice #224. Reference implementation: t3code's
"pick to chat" (`apps/desktop/src/preview/PickPreload.ts`), whose approach we deliberately do NOT
copy — see below.

## Context

The Browser Surface previews a dev server. When the user spots something to change, describing it
in words ("the blue button top-right") is slow and imprecise. "Pick to chat" lets them click the
element in the preview and hand it to the agent as a screenshot + metadata.

t3code implements this with a **guest preload running at `contextIsolation=false`**, so
react-grab/bippy can read the page's `__REACT_DEVTOOLS_GLOBAL_HOOK__` and attribute a React
component name + source frames to the picked element. That is exactly the posture ADR-0015 and its
adversarial security review locked DOWN: our guest runs `contextIsolation=true`, sandboxed, with
**no preload**, and the `will-attach-webview` clamp force-strips any preload from an attaching
guest. Matching t3code would mean reopening that attack surface.

## Decision

1. **Inject via the webview element's `executeJavaScript`, which runs in the guest's ISOLATED
   WORLD** — a separate JS context that shares the page's DOM but not its JS globals. The injected
   picker draws a highlight overlay, hit-tests with `elementsFromPoint`, reads
   `getBoundingClientRect`/`textContent`, and builds a best-effort CSS selector — all DOM
   operations, all it needs. It CANNOT read the page's `__REACT_DEVTOOLS_GLOBAL_HOOK__`, so there
   is **no React component-name / source-frame attribution**. That capability is the price of the
   sandbox, and we pay it: the guest security posture is UNCHANGED — no preload, no isolation
   relaxation, no clamp change.

2. **One round-trip through the return value.** `executeJavaScript` resolves with the injected
   script's last expression and awaits it if it's a Promise. The picker is a single IIFE that
   returns a Promise resolving with the picked-element payload on click (or null on Esc / page
   navigation). No new IPC channel, no `ipc-message` (needs a preload we don't ship), no
   `console-message` hack. The injected-script string is built by a pure, tested module; config
   values are JSON-encoded, never raw-interpolated, so a hostile page/accent can't break out.

3. **Screenshot in the renderer via `capturePage(rect)`** on the webview element, cropped to the
   picked element's padded, viewport-clamped bounding rect (a pure crop-rect helper; coords stay
   in CSS px, which `capturePage` expects). The overlay is torn down before capture, so the shot
   is the page, not the picker chrome. A capture failure is non-fatal — the text annotation still
   lands. No main-process involvement and no `browser:*` IPC: the guest webContents is not needed.

4. **Result lands in the composer via the existing sibling→composer pub/sub.** A picked screenshot
   is staged as a pending image through a new `emitComposerInsertImage` channel (symmetric to the
   `emitComposerInsertText` / `@path` channels); the annotation (tag, selector, text snippet, URL)
   reuses the existing text channel verbatim. The send path and the ACP image-block boundary
   (snake_case `mime_type`, bare base64, images before text) are UNCHANGED — a picked shot is
   byte-identical in shape to a pasted one.

5. **DOM-level payload, defensively coerced.** The untrusted JSON the guest returns is validated by
   a pure coercion module (the `coerceSurface` / `safe-external-url` pattern) — requires a string
   `pageUrl`/`tagName` and a numeric `rect`, lowercases the tag, tolerates a null selector / empty
   text, truncates the snippet; a malformed return drops the pick rather than crashing.

## Consequences

- The entire feature is renderer-only and adds ZERO to the guest's attack surface — the reason it's
  a small, contained slice rather than a security re-litigation.
- No React component names (the deliberate deviation from t3code). If a future "trusted preview"
  posture is ever introduced, component attribution could return — but that is its own ADR, not a
  quiet relaxation here.
- The picker is single-element, one pick at a time; t3code's annotation studio (multi-select,
  draw, region, live-CSS-edit, comment box) is out of scope (PRD #223).
- Capture uses CSS-px coordinates end to end; if a future need arises for device-pixel-accurate
  crops the helper is the single place to adjust.
