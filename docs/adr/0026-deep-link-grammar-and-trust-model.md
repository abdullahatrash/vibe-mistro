# Deep links: the `vibemistro://` grammar, external-navigation ingress, and trust model

**Status: PROPOSED** (2026-07-06, #361). Builds on **ADR-0006** (shell navigation is a
pure reducer; deep-linking was explicitly deferred there as the trigger for revisiting routing —
that trigger has now fired), **ADR-0001/0002** (layering: main validates and forwards, the renderer
owns navigation state; the app orchestrates, never acts for the agent), **ADR-0011/0019** (Threads
reopen process-free from our own stores, which is what makes Thread links cheap), and **ADR-0018**
(packaging — the scheme is registered in the bundle the release pipeline signs).

## Context

There is currently no way to reach a specific Workspace or Thread from outside the app: no URL
scheme, no CLI shim, no Open Recent, no single-instance lock (a second launch today starts a second
app instance). The onboarding epic (#361) adds all four — `vibemistro://` protocol
handling, second-instance argv parsing, a `vibemistro` terminal command, and File > Open Recent /
Dock recents — and several future features (notification and tray click-through, Scheduled-run
surfacing, Thread links pasted into PR descriptions) want the same "navigate the app from outside"
capability.

This is a genuinely new kind of input. Until now every navigation event originated from a click
inside our own renderer; a protocol URL is an **untrusted, attacker-constructible string** — any web
page can trigger `vibemistro://open?path=/` — arriving at a main process that can open directories
and (indirectly, once the user prompts) spawn agent processes in them. The reference implementation
registers a custom scheme but uses it only as internal transport, and takes the single-instance lock
while ignoring second-instance argv; OS-level deep links are absent there too, so there is no shape
to copy. Two questions must be settled before any slice ships: (1) how external navigation events
enter the pure nav reducer without compromising its purity or ADR-0001's ownership split, and
(2) what trust/confirmation policy applies to each link source and target.

## Decision

1. **One frozen, navigation-only URL grammar with exactly two forms.**
   - `vibemistro://open?path=<absolute-dir>` — open (adding if necessary) a Workspace at that
     directory, then select it.
   - `vibemistro://thread/<threadId>` — select an existing Thread (and its Workspace).

   Parsed with the WHATWG `URL` parser; the **host is the verb** (`open`, `thread`), which survives
   the parser's host lowercasing because verbs are lowercase by construction. `path` is
   percent-decoded exactly once by the parser and must be absolute (no `~`, no relative paths — the
   CLI shim resolves those *before* building the URL, so the protocol layer never guesses a base
   dir). `threadId` must match `[A-Za-z0-9-]{1,64}` (our ids are UUIDs) before any store lookup.
   Anything else — unknown verb, extra query params, malformed URL, relative/`~` path — is
   **rejected whole**, logged, and surfaced as a quiet non-blocking notice; there is no partial or
   fuzzy interpretation. The grammar is deliberately closed: **it can express navigation and nothing
   else** — no prompt text, no Agent-controls changes, no Permission answers, no file targets.
   Extending it requires amending this ADR (see the rejected `?prompt=` option below).

2. **All external sources funnel through one main-side ingress into a typed `NavIntent`.** A pure
   parser module (`src/main/deep-link/parse-link.ts`, unit-tested; house pattern per
   `docs/conventions.md`) maps a raw URL string to
   `NavIntent = { kind: 'open-path'; path: string } | { kind: 'focus-thread'; threadId: string }`
   or a typed rejection. The four external producers all feed it:
   - macOS `open-url` app event (scheme registered via `CFBundleURLTypes` in the electron-builder
     config for packaged builds and `app.setAsDefaultProtocolClient` for dev — dev registration on
     macOS needs the execPath+args form when unpackaged);
   - **single-instance lock**: `requestSingleInstanceLock()` is taken; `second-instance` argv is
     scanned for `vibemistro://`-prefixed args (the Windows/Linux delivery path, and the shim's
     fallback), and the second launch focuses the existing window instead of spawning a new app;
   - first-launch argv (cold start via a link) — same scan;
   - the `vibemistro` CLI shim, which is deliberately **dumb**: it realpath-resolves its directory
     argument and execs the OS opener on the resulting URL. All validation lives in-app; the shim
     carries no secrets and gets no trust bypass (its URLs are indistinguishable from a web page's,
     so pretending otherwise would be theater).

   Internal producers (File > Open Recent, Dock recents, and future tray/notification click-through)
   **construct `NavIntent` directly** from our own store — they never round-trip through a URL
   string and never re-enter the parser.

3. **A three-tier trust model, keyed by source and by whether we already know the target.**
   - **Tier 0 — internal producers**: no confirmation. The intent was minted in main from
     `MetadataStoreApi.snapshot()`; there is nothing to distrust.
   - **Tier 1 — external URL, known target**: no confirmation. `thread/<id>` resolving to a stored
     Thread, or `open?path=` whose realpath-resolved directory **exactly matches an existing
     Workspace's stored path** (compared post-`realpath`, using the `isWithinDir`-style
     trailing-separator discipline from `open-target.ts` — equality only, no subtree matching, so a
     link cannot select a parent Workspace for an arbitrary child path). Worst case for the user: a
     web page focuses a Workspace they already added. Navigation is view-only — a deep-linked Thread
     renders process-free from the fold snapshot (ADR-0019) and **no ACP session is created or
     resumed until the user's first prompt** (ADR-0011); a deep-linked Workspace select follows the
     normal lazy-spawn path (ADR-0006), same as a sidebar click.
   - **Tier 2 — external URL, never-before-seen path**: **confirm-gated.** Main first checks (with
     the resolved shell env, symlinks collapsed via realpath) that the path exists and is a
     directory; then shows a modal confirmation displaying the **exact resolved path**, default
     button **Cancel**. Filesystem roots (`/`, a bare drive root) and the home directory itself are
     **hard-refused** — no dialog, just the notice — because "open `$HOME` as a Workspace" is never
     a legitimate link and reads are unconfined once an agent runs there (ADR-0004). Only on
     explicit confirmation does main run the same `upsertWorkspace` flow the Open-project dialog
     handler uses. **Dialog anti-fatigue**: at most one pending external confirmation at a time;
     further external `open-path` intents arriving while one is showing are dropped and logged, so
     a hostile page cannot stack dialogs until the user misclicks.

   Pre-decided escalation (not built now): if Tier-2 confirmation proves annoying for the shim's
   `vibemistro .` flow, the shim mints a single-use nonce file under `userData` (mode 0600) and
   appends its name to the URL; main verifies-and-deletes it to grant Tier-1 treatment. This is the
   only forgery-resistant shim channel — a static marker in the URL is copyable and therefore
   worthless — and it is spike-gated on real usage friction, not built speculatively.

4. **Validated intents cross to the renderer as resolved ids on one typed streaming channel;
   the nav reducer gains no new action types.** After validation, main emits
   `nav:navigate { workspaceId, threadId? }` — a `send`-shaped channel in `shared/ipc` (core
   domain), the same main-proposes/renderer-disposes shape as the existing `menu:action` channel.
   **Raw paths never cross the IPC boundary for navigation**; by the time the renderer hears about
   a link, the target is a Workspace/Thread id that exists in the metadata store. The shell
   subscribes once (mirroring the conversation event-router pattern) and maps each event onto the
   existing `NavAction` vocabulary — `select-workspace` / `select-thread` dispatches into the pure
   `nav-reducer`. External navigation is thus expressed in exactly the words a user click uses: the
   reducer stays pure and closed, its invariants (a selected Thread always belongs to the selected
   Workspace; same-target selects are referential no-ops) apply unmodified, and `nav-history`
   back/forward records deep-link jumps like any other navigation. Any accepted intent also
   restores/focuses the window first (main-side, before emitting).

5. **Readiness queueing.** Intents can arrive before the renderer exists (cold launch via a link)
   or before it has subscribed. Main keeps a small FIFO of validated intents, flushed in order when
   the renderer signals ready (the existing window-ready choreography), with consecutive duplicates
   coalesced. Tier-2 confirmation happens at dequeue time, never against a window that isn't
   showing. The queue is bounded (drop-oldest, logged) so a link storm cannot grow memory.

6. **Failure is soft and specific.** A `thread/<id>` whose Thread was deleted, a Workspace whose
   directory no longer exists, a locked store (`isLocked()`, ADR-0019 fail-closed) — each yields a
   non-blocking notice naming what was stale, never a modal error and never a crash. Log, don't
   swallow (`docs/conventions.md`): every rejection is logged with the offending (redacted-to-verb)
   URL shape.

7. **Recents ride the same rails.** Workspace adds call `app.addRecentDocument` (and the Dock menu
   is rebuilt from `MetadataStoreApi.snapshot()`), and File > Open Recent entries dispatch Tier-0
   intents. Recents for since-removed Workspaces re-enter as Tier-2 (the store no longer knows the
   path — same rule, no special case).

## Considered options

- **A renderer-side router (URL-driven state) instead of the intent channel** — rejected.
  ADR-0006 already rejected router libraries for a single-window app; deep links do not change
  that calculus because the OS delivers them to *main*, not to a browsing context. Mapping them
  onto the existing reducer keeps one navigation vocabulary and zero new state systems.
- **Forwarding raw URLs (or raw paths) to the renderer and validating there** — rejected. The
  renderer has no fs and no store authority; validation must sit where realpath, the metadata
  store, and the dialog live (main), and ADR-0001's split says the renderer owns *state*, not
  OS-input laundering. Resolved-ids-only across IPC is the narrowest possible surface.
- **A richer grammar now** (`?prompt=` to prefill the composer, `workspace/<id>`, file/line
  targets, action verbs) — rejected. URL-supplied prompt text is a textbook injection vector
  (a page could stage a malicious prompt one Enter away from an agent with write access);
  workspace-by-id is redundant with `thread/` + `open?path=`; file targets belong to the Files
  browser's confined world (ADR-0013), not to an unauthenticated OS input. Navigation-only is the
  invariant that makes the trust model small enough to hold.
- **Trusting the CLI shim more than web-originated URLs** (skip Tier-2 confirmation for shim
  links) — rejected as unimplementable-as-stated: the app cannot distinguish the two without an
  unforgeable channel. The nonce-file escalation in Decision 3 is the pre-decided design if the
  friction is real; shipping a forgeable "from-the-shim" URL flag would be security theater.
- **Confirming every external link, known targets included** — rejected. Focusing an
  already-added Workspace or Thread discloses nothing and executes nothing; confirming it would
  train users to click through the one dialog that matters (Tier 2).
- **No single-instance lock (per-launch instances, links delivered to the newest)** — rejected.
  Two instances mean two agent pools and two SQLite writers on one `state.sqlite` (ADR-0019 assumes
  a single main-process writer); the lock is load-bearing for persistence, not just for links.

## Consequences

- The nav reducer acquires its first non-user-click event source with **zero reducer changes** —
  the cost lands in three new, individually testable seams: the pure URL parser, the main-side
  trust/queue dispatcher, and the thin renderer intent-mapper. Each follows the pure-module +
  thin-wrapper house pattern with colocated tests.
- Second launches now focus the running instance instead of starting a second app — a behavior
  change for anyone who (accidentally) relied on multiple instances. This is also a correctness
  fix (single SQLite writer).
- Every future "take me there" feature (notification/tray click-through, Scheduled surfacing,
  Thread links in PR descriptions) becomes a one-line Tier-0 `NavIntent` producer instead of a
  bespoke navigation path — the compounding win that motivated deciding this carefully now.
- The grammar's smallness is a public commitment: once links are in the wild (PR descriptions,
  docs), `open` and `thread` semantics cannot change meaning. Additions are possible; mutations
  are not. New verbs must state their trust tier in an amendment to this ADR.
- Tier-2 confirmation adds one click to `vibemistro .` in a brand-new project — accepted friction,
  with the nonce escalation pre-decided (Decision 3) if it proves noisy in practice.
- The scheme registration touches the packaged bundle's Info.plist (via electron-builder config,
  ADR-0018); per the branding lessons, `CFBundleIdentifier` itself is never touched. Dev-mode
  protocol registration is best-effort and may require the patched dev bundle; e2e coverage
  exercises the parser + dispatcher seams directly rather than OS delivery.
