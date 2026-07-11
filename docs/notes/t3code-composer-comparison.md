# t3code vs vibe-mistro composer research

Compared on 2026-07-11 from primary source code:

- `t3code` at `f61fa9499d96fee825492aba204593c37b27e0cb`
- `vibe-mistro` at `9c027a3` in worktree branch `codex/t3code-composer-research`

> Follow-up status: the baseline comparison below led directly to an implementation on this
> branch. Per-Thread sent-prompt recall, debounced draft writes, image drag/drop, and user-message
> Copy are now implemented and tested; the comparison sections intentionally preserve what existed
> at the two inspected revisions.

The comparison targets t3code's Electron/web composer in
`/Users/abdullahatrash/mistral/t3code/apps/web` and vibe-mistro's desktop renderer composer in
`apps/desktop/src/renderer/src/conversation`.

## Executive answer

**Neither app currently implements Codex-style Up/Down recall of previously sent prompts.** Both
use Up/Down for autocomplete navigation while a suggestion menu is open and otherwise leave the
keys to normal editor caret movement. Both separately persist the *current unsent draft* per
Thread.

vibe-mistro already matches or exceeds several t3code behaviors: per-Thread draft persistence,
failure-safe draft restoration, structured context, image drafts, `/` and `@` completion, and an
explicit multi-message follow-up queue. The most useful ideas to borrow from t3code are drag/drop
images, richer Lexical inline nodes, debounced draft persistence, broader composer shortcuts, and
the adjacent user-message Copy/Revert actions. Sent-prompt recall would be a new feature for both
apps, not something to port from t3code.

## Feature matrix

| Capability | t3code | vibe-mistro | Finding |
|---|---|---|---|
| Unsent text survives Thread switches/restart | Yes | Yes | Parity |
| Structured draft survives restart | Images, terminal/element/review context, provider/model/modes | Slash/terminal tokens, file/element/review/paste context, bounded images | Different strengths |
| Up/Down recalls sent prompts | **No** | **No** | Gap in both |
| Arrow keys in open completion menu | Yes | Yes | Parity |
| Mid-turn follow-up UX | Hidden Enter steering; visible action is Stop | Explicit removable FIFO queue, auto-drained | vibe-mistro is clearer |
| Image input | Picker, paste, drag/drop | Picker, paste, Browser Surface insertion | t3code has drag/drop |
| Completion triggers | `@` paths, `$` skills, `/` built-ins/provider commands | `@` paths, `/` Vibe commands/skills | t3code separates skills |
| Rich editor tokens | Atomic mention, skill, terminal nodes | Plain-text Lexical editor plus external chips/metadata | t3code is richer inline |
| Long text paste | Remains editor content | Becomes a removable chip over 1,000 chars or over 10 lines | vibe-mistro is more compact |
| Send failure | Restores snapshot unless user typed newer content | Same policy | Parity |
| Copy sent messages | User and assistant | Assistant only | t3code is broader |
| Revert to prior turn | Implemented checkpoint action | Proposed in ADR-0022, not implemented | t3code is ahead |

## Important distinction: draft stash vs sent-message history

These are different mechanisms:

1. A **draft stash** preserves the one message currently being composed, keyed by Thread. Both apps
   have this.
2. A **sent-message history** is a list/cursor over earlier submitted prompts. Up moves backward,
   Down moves forward, and returning past the newest item restores the scratch draft. Neither app
   has this.

Lexical undo/redo is a third, unrelated history: it reverses edits inside the current editor value.

## t3code findings

### Direct answer: sent-prompt history

**No: t3code does not implement Codex-style Up/Down recall of previously sent prompts.** Its composer key handler uses `ArrowUp` and `ArrowDown` only while the `@` / `$` / `/` suggestion menu is active, where they cycle the highlighted item. With no active menu, the handler returns `false`, so the editor receives normal cursor movement. The draft state contains one current `prompt`, not a sent-prompt history array. Lexical's `HistoryPlugin` supplies ordinary editor undo/redo, which is different from shell-style sent-message recall.

Primary evidence:

- `/Users/abdullahatrash/mistral/t3code/apps/web/src/components/chat/ChatComposer.tsx:1727-1757` — complete composer command-key handler; arrows only act on an active menu.
- `/Users/abdullahatrash/mistral/t3code/apps/web/src/components/ComposerPromptEditor.tsx:927-945` — Lexical registers Up, Down, Enter, and Tab and delegates them to that handler.
- `/Users/abdullahatrash/mistral/t3code/apps/web/src/components/ComposerPromptEditor.tsx:1631-1638` — editor installs Lexical `HistoryPlugin` (undo/redo), not sent-prompt recall.
- `/Users/abdullahatrash/mistral/t3code/apps/web/src/composerDraftStore.ts:246-278` — the per-target composer state has a single `prompt` plus attachments/settings; no prompt-history field.

### Unsent draft stashing and scope

t3code does robustly stash the *current unsent composer*, independently from sent-message history:

- Every edit immediately writes the current prompt to a Zustand store (`ChatComposer.tsx:1419-1453`; `composerDraftStore.ts:2551-2569`).
- The store is persisted to `localStorage` under `t3code:composer-drafts:v1`, debounced by 300 ms and force-flushed on `beforeunload` (`composerDraftStore.ts:59-78`, `3341-3347`).
- Drafts are scoped by `DraftId` before a server Thread exists, or by `ScopedThreadRef` afterward. A scoped Thread includes environment identity, preventing collisions between environments/workspaces (`composerDraftStore.ts:246-249`, `311-326`, `1245-1269`). Pre-Thread draft metadata also retains project, environment, branch, worktree path, execution mode, and interaction mode (`composerDraftStore.ts:280-299`).
- Switching Threads/Drafts restores that target's prompt and resets the cursor to the end; cursor/selection itself is not persisted (`ChatComposer.tsx:1291-1300`; `composerDraftStore.ts:250-278`).
- On successful dispatch, text and contextual attachments are cleared, while model/mode selections survive because `clearComposerContent` only resets content fields (`composerDraftStore.ts:3314-3337`).

### Submission, recovery, running turns, and editing

- `Enter` submits; `Shift+Enter` falls through to insert a newline. `Shift+Tab` toggles interaction mode. When a suggestion menu is open, Up/Down navigates and Enter/Tab accepts (`ChatComposer.tsx:1727-1757`). IME composition Enter is consumed safely (`ComposerPromptEditor.tsx:914-923`).
- A send may contain text, images, live terminal context, picked DOM-element context, preview annotations, or review comments; context/image-only sends are valid (`ChatView.logic.ts:212-242`). The send path snapshots the draft, appends contexts, creates an optimistic user row, clears the composer, and dispatches the turn (`ChatView.tsx:3983-4055`, `4070-4072`, `4165-4187`).
- If dispatch fails and the user has not typed new content meanwhile, the complete snapshot—text, images, terminal/element contexts, annotations, and review comments—is restored. This avoids overwriting a newer draft (`ChatView.tsx:4191-4225`).
- While a turn runs, the visible primary action becomes **Stop generation** (`ComposerPrimaryActions.tsx:126-139`), which calls the Thread interrupt operation (`ChatView.tsx:4241-4254`). There is no client-side queued-message list in the composer.
- A subtle behavior: the editor is not disabled merely because `phase === "running"` (`ChatComposer.tsx:2420-2424`), and `onSend` does not reject solely on running phase (`ChatView.tsx:3878-3893`). Therefore Enter can send during a running turn even though the visible button is Stop. Provider adapters treat this as steering/queuing into the same live turn—for example Claude (`apps/server/src/provider/Layers/ClaudeAdapter.ts:3641-3654`) and OpenCode (`apps/server/src/provider/Layers/OpenCodeAdapter.ts:1169-1175`). This is hidden keyboard UX rather than an explicit queue UI.
- No classic “edit sent message and resend” control was found. A user-message row exposes only **Revert to this message** (when a checkpoint exists) and Copy (`MessagesTimeline.tsx:910-953`). Revert requires stopping current work, asks for confirmation, and discards newer messages and turn diffs (`ChatView.tsx:3819-3854`).

### Attachments and context

- Direct file paste/drop accepts **images only**; non-images are rejected. Limits are eight images, 10 MB each (`ChatComposer.tsx:1763-1806`, `1813-1855`; `packages/contracts/src/orchestration.ts:142-143`). There is no general file-upload control; source files/folders are referenced with `@` mentions instead.
- Images render as removable/expandable thumbnails. Failed local persistence is visibly warned (`ChatComposer.tsx:2305-2377`). Draft images are converted to data URLs, stored with the draft, and rehydrated after reload (`ChatComposer.tsx:1348-1404`; `composerDraftStore.ts:2106-2135`). This preserves images but can consume significant `localStorage` quota.
- The in-app preview can attach a picked DOM element plus its screenshot directly to the same composer draft (`components/preview/PreviewView.tsx:460-490`). Terminal selections, element picks, preview annotations, and review comments are first-class removable context chips/cards, not flattened into text until submission (`ChatComposer.tsx:2280-2303`; `ChatView.tsx:3991-4002`).

### Autocomplete, commands, mentions, and notable UX

- Trigger grammar is cursor-aware: `/` commands only at a line start, `$` searches provider skills, and `@` searches workspace files/folders (`packages/shared/src/composerTrigger.ts:52-124`). Workspace path search is debounced 120 ms and capped at 80 results (`apps/web/src/state/queries.ts:26-27`, `184-214`).
- Built-ins are `/model`, `/plan`, and `/default`, combined with provider-supplied slash commands; skills and paths are provider/workspace-derived (`ChatComposer.tsx:939-1008`). Selecting a path inserts a Markdown file link, selecting a skill inserts `$skill`, `/model` opens the picker, and plan/default switch modes immediately (`ChatComposer.tsx:1548-1633`). Mentions, skills, and terminal contexts render as atomic Lexical chips rather than fragile plain text (`ComposerPromptEditor.tsx:131-206`, `240-418`, `1631-1638`).
- Printable typing anywhere in the chat focuses the composer and appends the character, unless focus is already in an editable/interactive/floating layer (`ChatView.tsx:310-320`, `3674-3699`). The default model-picker shortcut is Mod+Shift+M; Mod+1..9 selects picker entries while it is open (`packages/shared/src/keybindings.ts:37-53`).
- Pending agent questions temporarily turn the composer into a guided answer flow with previous/next/submit actions; number keys 1-9 select options when focus is outside editable fields (`ComposerPrimaryActions.tsx:75-123`; `ComposerPendingUserInputPanel.tsx:119-144`). Plan mode similarly changes the primary action to Refine or Implement, including “Implement in a new thread” (`ComposerPrimaryActions.tsx:142-193`).

## vibe-mistro findings

### Current unsent draft stash

vibe-mistro persists a structured draft per durable `threadId` in `localStorage` under
`vibe-mistro:composer-drafts:v2`. The shape contains the prompt, Inline tokens, Context
attachments, images, and ids of images that could not be persisted. It tolerates missing, corrupt,
blocked, or quota-exhausted storage, and migrates the old text-only v1 map
(`apps/desktop/src/renderer/src/conversation/composer-draft-store.ts:6-29`, `38-74`, `176-285`).

Every editor change writes through to the store immediately. Empty drafts are pruned rather than
left as blank map entries, and send/delete clears the Thread's entry
(`composer-draft-store.ts:292-337`, `349-445`; `Composer.tsx:169-175`, `222-233`). The draft is
strictly renderer-owned ephemeral UI state; it does not enter IPC, SQLite, or the transcript.

Image draft persistence is deliberately bounded: at most four previews, each no larger than
1,500,000 data-URL characters, survive reload. Extra/large images remain usable during the current
renderer lifetime
and are labeled “Session only” (`composer-draft-store.ts:28-29`, `111-148`;
`Composer.tsx:591-623`). This is a more explicit quota-degradation UX than silently losing the
attachment.

### No sent-prompt recall

vibe-mistro's complete composer key handler delegates first to autocomplete, handles removal of a
leading slash-command token, and sends on unmodified Enter. It has no Up/Down history branch
(`Composer.tsx:471-487`). The autocomplete hook consumes Up/Down only while a completion popover is
open; when closed it returns `false` and lets the editor handle the key normally
(`use-composer-autocomplete.tsx:81-87`, `165-191`). No sent-prompt array or history cursor exists in
the composer draft store.

### Submission and follow-up queue

When idle, vibe-mistro snapshots structured composer state, clears optimistically, and restores the
pre-send snapshot only if the send fails and the user has not begun a newer draft. This matches
t3code's valuable no-clobber recovery policy (`Composer.tsx:428-468`;
`composer-send-lifecycle.ts:34-85`).

When a turn is already streaming, vibe-mistro does something t3code's visible UI does not: it puts
the whole outgoing payload into a per-Thread FIFO, clears the composer for another message, renders
each queued item with a remove action, and auto-drains exactly one item after each turn ends
(`Composer.tsx:440-447`, `498-526`; `follow-up-queue.ts:1-16`, `46-79`, `148-175`, `205-222`;
`Conversation.tsx:353-376`). The queue is process-local and survives React remounts, but is not
durable across an app restart.

### Context, paste, and completion

vibe-mistro has one autocomplete state machine for `/` commands and `@` paths. The path list is
loaded lazily once per composer mount, and selected paths are inserted inline. A selected slash
command becomes a structured token and is serialized at send
(`Composer.tsx:199-220`, `262-281`; `composer-sources.tsx:17-50`, `53-95`). Unlike t3code, it does
not use a separate `$` trigger because Vibe exposes skills through its command list.

It accepts images through paste, a file picker, and sibling surfaces such as the Browser Surface.
No composer drag/drop handler was found (`Composer.tsx:334-421`, `654-675`). Long text paste is
treated specially: over 1,000 characters or over 10 lines becomes a removable Context chip instead of
expanding the editor, then serializes in a fenced `<pasted_text>` block
(`Composer.tsx:391-414`; `pending-contexts.ts:151-168`, `225-228`).

The editor itself is a plain-text Lexical surface. Structured slash/terminal metadata and most
Context attachments are managed outside the editor and shown as chips above it
(`ComposerPromptEditor.tsx:25-37`, `95-170`; `Composer.tsx:529-589`). t3code invests much more in
atomic rich inline nodes and selection-aware editing.

### Adjacent sent-message UX

vibe-mistro currently shows Copy only under settled assistant messages; user rows have no Copy or
revert action (`items/message-rows.tsx:11-119`, `122-159`). t3code supports Copy on both roles and
checkpoint-backed “Revert to this message.” vibe-mistro has a detailed proposed checkpoint/Rewind &
Fork design, but ADR-0022 is explicitly marked `PROPOSED` and there is no corresponding renderer
implementation (`docs/adr/0022-turn-checkpoints-hidden-refs-rewind-fork.md:1-4`, `101-147`).

## Architecture comparison

t3code centralizes a very broad composer domain in a persisted Zustand store. It uses a 300 ms
debounced storage adapter, flushes before unload, versions/migrates the envelope, and persists
model/mode state alongside content (`/Users/abdullahatrash/mistral/t3code/apps/web/src/composerDraftStore.ts:59-78`,
`128-150`, `1818-1910`, `3341-3372`). This reduces hot-path storage churn and gives pre-Thread drafts a rich
identity, but the store is large and couples many composer concerns.

vibe-mistro uses smaller focused modules: one draft store, one autocomplete machine, one follow-up
queue, and separate agent-control state. This is easier to test and navigate, but the draft store
serializes the full draft map synchronously on every edit. t3code's debounced write plus unload
flush is the cleaner hot-path persistence pattern worth borrowing without adopting its monolithic
store.

## Follow-up implementation on this branch

The concrete P0/P1 recommendations were implemented after the source comparison:

- `composer-history.ts` owns visible-prompt cleanup, consecutive deduplication, bounds, and scratch
  restoration. `Conversation.tsx` derives entries from durable user transcript items and preserves
  the history-array reference across assistant streaming.
- `ComposerPromptEditor.tsx` reports collapsed-selection visual-line position from DOM geometry;
  `Composer.tsx` gives autocomplete arrow priority, recalls at the first/last visual line, and exits
  history only when the editor value genuinely changes.
- `composer-draft-store.ts` now keeps synchronous in-memory read-your-writes behavior while
  deferring the full-map serialization and `localStorage` write by 300 ms. It flushes on
  `beforeunload`; failed writes retain the live draft, log the failure, and show a renderer warning.
- The composer accepts dropped images through the existing accepted-image/FileReader path, and user
  rows share the settled-message Copy control.
- Pure tests cover history (including edit/send resets), deferred serialization, failure feedback,
  and marker-free chip-only Copy payloads; `e2e/live.spec.ts` verifies Up/Down scratch restoration,
  both Copy actions, and image drop/remove in the built Electron app.

## Original recommended next steps for vibe-mistro

### P0 — add per-Thread sent-prompt recall

This is the direct user-facing gap, and t3code does not solve it. Build it as a small pure
`composer-history.ts` module rather than adding another concern to `composer-draft-store.ts`.

Recommended behavior:

- Source entries from the Thread's user transcript items, so restart/reopen works without a second
  persistence system.
- Keep a transient `index` plus a `scratchDraft`; first Up saves the current unsent draft, and Down
  past the newest history entry restores it.
- Intercept Up only at the first visual line and Down only at the last visual line, with a collapsed
  selection and no autocomplete open. Otherwise preserve normal multiline caret behavior.
- Start with text-only recall. Do not silently reattach old images, terminal selections, browser
  elements, or review comments. Those may be stale, large, or destructive to resend.
- Strip app-generated trailing Context marker blocks before recall, but retain the visible slash
  command and ordinary inline `@path` text.
- Skip consecutive duplicate prompts and reset navigation when the user edits a recalled value.
- Add pure tests for scratch restoration, bounds, duplicates, multiline gates, Thread isolation,
  autocomplete precedence, and send/reset behavior.

### P1 — borrow targeted t3code polish

1. Debounce draft persistence (roughly t3code's 300 ms) and flush on `beforeunload`; keep the live
   external store synchronous so typing still updates React immediately.
2. Add drag/drop images with the same validation path as picker/paste.
3. Add Copy to user-message rows. It is a simpler fallback for reuse and useful even after history
   recall ships.
4. Consider selection auto-wrap for backticks/brackets and richer atomic inline nodes only after
   history recall; those are higher-complexity editor changes.

### Keep vibe-mistro's existing advantages

- Keep the explicit visible follow-up queue rather than t3code's hidden Enter steering.
- Keep long-paste chips; they prevent giant pasted payloads from swallowing the composer.
- Keep draft modules separated from agent controls and the queue.
- Keep the visible “Session only” degradation when image persistence exceeds safe bounds.
