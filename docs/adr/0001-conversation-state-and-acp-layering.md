# Conversation state lives in the renderer; Workspace/Thread/ACP-session layering

The renderer owns the canonical conversation state (a reducer of typed conversation items, keyed by
Thread); the main process is a thin protocol layer that spawns/​supervises `vibe-acp` and forwards
raw ACP `session/update` events without interpreting them. We layer the domain as **Workspace** (a
directory + its one `vibe-acp` process) → **Thread** (a user-facing conversation = one **ACP
session**, the protocol handle from `session/new`). Agent-initiated **permission requests**
(`request_permission`) are queued in the renderer and answered back through main by their JSON-RPC
**request id**.

## Considered options

- **Main owns state, renderer mirrors** — rejected. More robust for multi-window, persistence, and a
  future remote backend, but heavier and unnecessary now; production orchestrator GUIs prove a
  renderer-owned reducer scales for this class of app.
- **Renderer owns state** (chosen) — simplest, least IPC, a proven model in production apps.

## Consequences

- Conversation state is lost on window reload and cannot be shared across windows. Acceptable for
  now; revisit if/when we add multiple windows, durable thread history, or the remote-backend slice —
  any of those may require promoting main to the source of truth (supersede this ADR then).
- "ACP session" stays out of the UI vocabulary; the UI speaks "Thread" (see CONTEXT.md).

## Amendment — main answers permission requests for a scheduled turn (ADR-0028, #469)

A **Routine** runs a turn with nobody at the keyboard, and an unanswered permission request hangs that
turn forever — `vibe-acp` waits on the client with no timeout. There is no renderer to queue it in.

So for turns raised by the scheduler, and only those, **main answers** `request_permission` itself,
from the Routine's **allowed commands** (`src/main/routines/routine-permission-gate.ts`). The first
refusal cancels the turn. The renderer remains the only answerer for every user-initiated turn, and
nothing else about the layering changes: the answer is still by JSON-RPC request id, main still
forwards the raw event, and the renderer still owns conversation state.

The departure is narrow and deliberate. ADR-0028 part 4 carries the reasoning and the alternatives it
rejected (auto-deny-everything, and leaving the request pending until somebody opens the Bot).
