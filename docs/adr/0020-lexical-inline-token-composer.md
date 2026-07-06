# Lexical composer for inline tokens and structured renderer drafts

**Status: ACCEPTED** (2026-07-04). Supersedes ADR-0017's "no Lexical/contentEditable"
consequence while preserving its thin-orchestrator wire decision: the agent still receives plain
prompt text plus image blocks, and any context markers are prose fences, not protocol.

We will replace the plain textarea composer with a Lexical-based prompt editor for **Inline tokens**
whose position is part of the user's prompt: file/folder mentions, skill invocations, and Terminal
context placeholders. Whole-prompt **Context attachments** remain staged outside the editor: browser
element picks, review comments, long pasted text, and images.

Composer draft state becomes a structured renderer-owned localStorage record rather than text-only:
prompt text, Inline-token source text, staged Context attachments, and restorable image previews where
feasible. This does not create Thread metadata, transcript entries, ACP sessions, or SQLite rows; the
first prompt remains the single durability boundary for a Draft Thread (ADR-0011/ADR-0012).
The store is targeted to composer drafts and implemented with `useSyncExternalStore` plus versioned
localStorage persistence, not Zustand or a general app-wide UI store.

Migration from the old text-only draft key is one-way and lazy. On first composer load, the renderer
may read `vibe-mistro:composer-drafts:v1`, write equivalent structured drafts with empty Inline-token,
Context attachment, and image arrays, then remove the old key only after the new write succeeds. If
migration fails, the old text can be used for that session and left in place. Because the app has no
external user base yet, this migration stays intentionally narrow: legacy `<attached_files>` or other
marker text is preserved as plain prompt text rather than rehydrated into structured draft state.

Unsent image drafts follow the same renderer-draft rule: store data URLs in localStorage on a
best-effort basis under explicit size/count caps, mark images that could not be persisted as
current-session-only, and clear persisted image draft data on send, image removal, Thread deletion, or
Workspace removal. Sent image attachments remain owned by the existing main-side attachment store.

`/` remains the canonical trigger and wire syntax for skill/command Inline tokens; they are
start-anchored and single-select because Vibe parses a leading slash command, not arbitrary inline
commands. `@file` and `@folder` Inline tokens serialize as plain inline `@path` text exactly where
the user placed them; accepted file mentions no longer move into a trailing `<attached_files>` block,
which remains only for legacy display parsing or future non-positional bulk attach flows.

Terminal context follows the same positional rule for the visible reference but carries its full
selected text as supporting context: the Inline token marks the reference location, and send-time
serialization may append a trailing `<terminal_context>` block with the selected output.

Lexical is chosen over a custom contentEditable layer because atomic token deletion, cursor movement,
selection restore, paste handling, undo/redo, and keyboard command interception are editor-model
concerns. The stored and sent representation remains plain text so ADR-0002's thin-orchestrator
boundary and ADR-0001's renderer-owned conversation fold are unchanged.
