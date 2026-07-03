# vibe-mistro docs

Reference material gathered before/while building, so the implementation stays clean and
consistent. Read these before adding a feature.

| Doc | What it's for |
|---|---|
| [opencode-electron-patterns.md](./opencode-electron-patterns.md) | **How to build it cleanly.** Electron architecture patterns mined from opencode's desktop app (same stack as us): process model, sidecar, typed IPC, persistence, updates, logging, packaging. |
| [vibe-acp-protocol.md](./vibe-acp-protocol.md) | **The backend contract (narrative).** Mistral Vibe's `vibe-acp` ACP server — method flow, streaming, tool-permission model. Our `AcpClient` implements this. |
| [acp-capture.md](./acp-capture.md) | **The backend contract (authoritative).** Verbatim JSON-RPC captured from live `vibe-acp` 2.18.0: real `initialize`/`session/new`/`session/prompt`/`session/update`/`session/request_permission`/`fs/*` shapes. Build against this. |
| [conventions.md](./conventions.md) | **Our decisions.** The conventions and architecture choices for vibe-mistro, synthesized from the references above. When the references disagree, this doc is the tiebreaker. |

## TL;DR of the strategy

- **Copy proven *concepts*, not code** — the frontend patterns we studied (feature-sliced design,
  thread reducer, event routing) translate directly; the backend responsibilities map to our
  Electron main process.
- **Copy the *Electron mechanics* from opencode** — typed IPC, lazy `electron-store`, shell-env
  PATH resolution, logging, updater, packaging. This is our clean-code template.
- **The backend is Vibe's `vibe-acp`**: JSON-RPC-over-stdio, so the standard *transport pattern*
  carries over but the *methods* are Vibe-specific
  (see [vibe-acp-protocol.md](./vibe-acp-protocol.md)).
