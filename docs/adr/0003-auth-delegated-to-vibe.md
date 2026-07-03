# Authentication is delegated to the `vibe` binary; vibe-mistro never stores credentials

vibe-mistro does not implement authentication or store any credentials. Vibe owns auth: it keeps the
credential in the **OS keyring** (`authState: "os_keyring"`) and exposes the whole surface over ACP
extension methods, which vibe-mistro merely drives and reflects:

- **Detect** with `_auth/status` → `{ authenticated, authState, signOutAvailable }`. Auth state is NOT
  derivable from `initialize` (its `authMethods` list is always present), so `auth/status` is the
  source of truth. A mid-session `UnauthenticatedError` (JSON-RPC code **-32000**, which Vibe reserves
  exclusively for unauthenticated — see `docs/acp-capture.md` §8) is treated as expiry.
- **Sign in** via the **`browser-auth-delegated`** method (`authenticate(start)` → `signInUrl` → open in
  the system browser → `authenticate(complete, attemptId)`) — the standard
  `start → open authUrl → complete` shape. The blocking agent-driven `browser-auth` is the fallback.
- **Sign out** via `_auth/signOut` (gated on `signOutAvailable`); it clears the keyring entry.

This is the auth-specific application of ADR-0002's thin-orchestrator stance: agent capabilities
(including credential storage) belong to Vibe, not the shell.

## Considered options

- **Store/manage credentials in vibe-mistro** (e.g. our own keychain entry or token cache) — rejected.
  It would duplicate secrets insecurely, diverge from Vibe's source of truth, and break the moment Vibe
  rotates/relocates them. Vibe already owns the keyring entry.
- **Delegate entirely to the `vibe` binary** (chosen) — we only trigger sign-in/out and read
  `auth/status`. We never see a token.

## Consequences

- vibe-mistro has no credential storage and no secrets at rest. Signing out is Vibe's keyring removal;
  we just call `_auth/signOut`.
- We depend on Vibe's ACP auth extension methods (`_auth/status`, `_auth/signOut`, `authenticate`).
  These are `_`-prefixed extension methods (unstable surface) — pin behavior against the captured
  shapes in `docs/acp-capture.md` §8 and re-verify on Vibe upgrades.
- BYOK (a `MISTRAL_API_KEY` env var or `~/.vibe/.env`) authenticates without our sign-in flow; we treat
  any `authenticated: true` from `auth/status` as signed in regardless of `authState`.

## Amendment (2026-07-03): read-only credential access for plan display

The sidebar account chip and Settings Account section show the account's **plan tier** (e.g. "Pro").
Vibe cannot supply it over ACP — its sign-in ends with a bare `MISTRAL_API_KEY` and `_auth/status`
reports only `{authenticated, authState, signOutAvailable}`; the plan lives behind Mistral's console
`GET /api/vibe/whoami`, which Vibe's own TUI calls directly with the key as a Bearer token. There is
no email/name/user-id anywhere in Vibe's surfaces — plan is the ceiling of account identity.

So main (`src/main/auth/whoami.ts`, the `auth:account-whoami` IPC) **reads** the key exactly where
Vibe keeps it — resolved shell env → `$VIBE_HOME/.env` → OS keychain (`ai.mistral.vibe`), the same
active-credential precedence as Vibe's `assess_auth_state` — and makes that one whoami request.

Boundaries that keep the original decision intact:

- **Read-only, transient.** The key is never persisted, logged, or sent over IPC/to the renderer;
  only the parsed `{planType, planName}` crosses the bridge. Vibe still owns storage and rotation.
- **Display-only.** Failures (no key, rejected key, network) are typed results the UI silently
  degrades on — never an auth gate. Sign-in/out remain exclusively Vibe's ACP methods.
- The whoami endpoint is unversioned console surface; treat it like the `_auth/*` extensions —
  pinned against Vibe's `http_whoami_gateway.py` and re-verified on Vibe upgrades.
