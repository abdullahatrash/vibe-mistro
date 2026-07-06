# Companion server: QR pairing, scoped revocable sessions, and a hard supervision-only capability cap

**Status: PROPOSED** (2026-07-06, #355)

## Context

The top failure mode of long agent runs is mundane: a 40-minute turn dies at minute 3 because a
Permission request blocks while the user makes coffee — or macOS suspends the laptop entirely.
The reference implementation answers this with a full client/server split, a native mobile app,
and a cloud relay. We are a desktop-first thin orchestrator (ADR-0002); our answer is a
**Companion server**: an opt-in HTTP listener inside the trusted main process serving one
self-contained page that shows live Workspace/Thread status, renders pending Permission requests
with Allow/Reject, tails a Thread's transcript read-only, and (opt-in) sends a prompt to an
existing Thread.

Every capability maps onto plumbing that already exists and is already tested:

- **Live status** — `ThreadStatusTracker` (`src/main/thread-status.ts`) is the single source of
  truth for `streaming`/`needsAttention`, keyed by durable `threadId`, already pushed on every
  change (`thread:status`) with a re-seed query (`thread:statuses`). The companion is one more
  subscriber.
- **Permission answers** — the renderer answers a Permission request via
  `WorkspaceAgent.respondPermission(requestId, optionId)` (`src/main/workspace-agent.ts`): a raw
  relay of the chosen `optionId` back by the agent's JSON-RPC request id, per ADR-0001. The
  companion answers through the **exact same method** — zero new agent capability.
- **Transcript tail** — `SqliteTranscriptStore` (ADR-0019) serves entries with NO agent spawned;
  the process-free reopen path already proves it.
- **Prompt send** — the bound-session prompt path (`runPromptTurn` / `ensureBoundSession`,
  ADR-0011) and the follow-up queue semantics (ADR-0009) are unchanged; the companion is another
  caller.

What does NOT exist yet, and what this ADR settles, is the security architecture: a network
listener inside the trusted main process is a genuine new attack surface, and it must be designed
up front — like the webview clamp got (ADR-0015) — not patched after. Threats considered: a LAN
attacker reaching the port; a leaked pairing URL (shoulder-surfed QR, chat-pasted link, server
logs); a stolen or exfiltrated session token (including via a read of `state.sqlite`); CSRF from
a hostile page in the phone browser; XSS via agent-authored transcript content rendered on the
companion page; request flooding; and scope creep — the quiet accretion of "just one more
endpoint" until the phone can touch the filesystem.

## Decision

1. **Placement: in main, in-process, OFF by default.** The server lives in `src/main/companion/`
   as a module group behind `registerIpc(deps)`-style dependency injection (stores, pool,
   status tracker), using only `node:http` + `node:crypto`. No separate helper process — the
   endpoints are capability-capped relays (Decision 2), so a process boundary would add IPC
   surface without meaningfully shrinking blast radius. The listener does not exist until the
   user enables it in Settings; disabling tears it down and drops all live connections.

2. **The hard capability cap — supervision relay only, enforced by a declarative table.** Every
   endpoint and event stream is registered in ONE declarative `channel → required scope` table
   (`companion-scopes.ts`, pure, unit-tested); a request whose channel is absent from the table
   is rejected before any handler runs — the table is the allowlist, not documentation. Exactly
   four scopes, ever:
   - `status:read` — Workspace/Thread list, live `streaming`/`needsAttention`, pending
     Permission request summaries.
   - `transcript:read` — read-only tail of a Thread's entries, served from
     `SqliteTranscriptStore`, agent-free.
   - `permission:respond` — answer a pending Permission request by request id.
   - `prompt:send` — send a prompt / queue a follow-up to an EXISTING Thread. Opt-in at pairing
     time, off by default.

   **The permanent negative list** (a cap, not a backlog): no filesystem endpoints (ADR-0004's
   confined writes and unconfined reads are desktop-only), no Terminal (ADR-0014's PTY is never
   networked), no git/gh, no Settings mutation, no Agent-controls changes (Mode/Model/Reasoning
   effort stay desktop-set, ADR-0007), no Workspace add/remove, no Thread create/delete, no
   pairing initiation from the page itself. Adding a fifth scope requires a new ADR.

3. **Pairing: QR with a single-consume fragment token.** Settings shows a QR encoding
   `<origin>/pair#token=<t>` — the token rides the URL **fragment**, which browsers never send
   over the wire, so it cannot land in access logs or proxies; the page's inline JS reads
   `location.hash` and exchanges it via `POST /pair`. Token properties: 256-bit
   `crypto.randomBytes`, 5-minute TTL, **single-consume** — invalidated on the first exchange
   attempt, success or failure — compared in constant time (`crypto.timingSafeEqual`). The
   `/pair` route is live ONLY while the Settings pairing dialog is open; closing the dialog
   revokes any un-consumed token. Five failed exchanges close pairing entirely until reopened
   from the desktop. The desktop side picks the granted scopes at pairing time (the
   `prompt:send` checkbox lives in the pairing dialog); scopes are pinned into the session and
   cannot be widened later — re-pair to widen.

4. **Sessions: scoped, revocable, hashed at rest.** A successful exchange mints a session token
   (256-bit random) returned once and stored by the phone (`localStorage`); the server keeps
   only its SHA-256 hash in a `companion_sessions` table in `state.sqlite` (forward-only
   migration per ADR-0019), with granted scopes, a user-agent-derived device label, created-at,
   and last-seen. Sessions expire after 30 idle days (rolling, refreshed on use) and are listed
   in Settings with per-device Revoke plus Revoke All; revocation kills live SSE connections
   immediately. Every request is rate-limited per session and per remote address (token-bucket,
   pure module, fake-clock tested). These are OUR tokens for OUR relay surface — Vibe
   credentials remain entirely Vibe's (ADR-0003); the companion can never see or trigger auth.

5. **Transport posture: loopback-only bind, Tailscale serve as THE remote path.** The listener
   binds `127.0.0.1` exclusively — we never bind a LAN or wildcard address, in any mode.
   Reaching it from a phone is an explicit second step: Settings offers a one-click **Tailscale
   assist** — detect the `tailscale` binary via the resolved shell-env PATH
   (`src/main/shell-env.ts`, same discipline as `vibe-acp` detection), then run
   `tailscale serve` scoped to the listener's lifetime (acquire on expose, release on disable
   and on quit — the acquire/release style the power policy and pool protection already use).
   This buys real TLS with a valid certificate, tailnet-ACL'd reachability, and the secure
   context Web Push requires — with zero certificate machinery of ours. The QR encodes the
   tailnet HTTPS origin when serve is active, the loopback origin otherwise (same-machine
   testing, or a user-managed tunnel at their own risk). **Spike-gated** (first companion
   slice): SSE event delivery through `tailscale serve` must be verified un-buffered; the
   pre-decided fallback is WebSocket transport behind the same scope table if SSE proves
   proxy-hostile. **Documented honestly**: no Tailscale on the phone → no remote access; we do
   not ship a plain-HTTP LAN mode (rejected below).

6. **Protocol shape: SSE out, authenticated POST in.** Server→phone is one Server-Sent-Events
   stream (status changes, Permission request arrivals/resolutions, transcript appends for the
   viewed Thread); phone→server commands are discrete `POST`s. Every request carries
   `Authorization: Bearer <session token>` — **no cookies**, which removes CSRF structurally
   (a hostile page cannot attach the header cross-origin). No CORS headers are ever emitted
   (same-origin page only). Every inbound body is validated by a hand-rolled strict schema
   (unknown fields rejected, sizes capped at 32 KB), the same validator discipline as the fs
   request handlers. The page is ONE self-contained HTML file (inline CSS/JS, no build
   pipeline, versioned with the app per ADR-0018) served with a strict CSP; transcript and
   Permission content is rendered as text, never as HTML — agent-authored strings cannot
   script the companion page.

7. **Permission relay semantics: first answer wins, everyone reconciles.** A companion answer
   flows through `pool.get(agentId).respondPermission(requestId, optionId)` — the identical
   seam the renderer uses; main still relays a chosen `optionId` by JSON-RPC request id without
   interpreting it (ADR-0001 intact; what changes is only WHICH trusted human surface picked
   the option). A Permission request is single-consume across surfaces: the first answer
   (renderer or companion) resolves it; the loser is told "already answered" and both surfaces
   converge via the existing `thread:status` push plus a companion SSE event. Companion-answered
   requests are attributed on the desktop ("answered from <device label>") so the user is never
   surprised at their desk.

8. **`prompt:send` is deliberately narrow**: existing, already-bound Threads only — no Draft
   Threads from the phone (a Draft is renderer-owned per ADR-0011 and has no durable identity
   to address), no new Threads, no Workspace selection side effects. Mid-turn sends follow the
   queue-or-interrupt semantics of ADR-0009 exactly as a desktop send would.

9. **Web Push, minimal-payload.** On first enable, main generates a VAPID keypair
   (`node:crypto` ES256; the `web-push` package is acceptable if hand-rolling the JWT proves
   error-prone — pre-decided, no native deps either way) and stores it beside a
   `push_subscriptions` table keyed by companion session (cascade on revoke). Push payloads are
   deliberately thin — Thread title + event kind ("Permission request in <Thread>"), NEVER
   transcript or tool content, because payloads transit third-party push services. A
   notification tap deep-links to the pending approval card. Push requires the page to have
   been served from a secure context — i.e. the Tailscale tier; loopback testing uses the
   open-page SSE path. Delivery is best-effort and must never block the live flow (the
   persistence discipline of ADR-0019 applies verbatim).

10. **Security-review gate.** Every slice that touches the listener (pairing, endpoints, push,
    Tailscale assist) passes a dedicated security review before merge — the same treatment the
    webview clamp received. The review checks against THIS document: table-enforced scopes, the
    negative list, loopback bind, token hygiene, schema strictness.

## Considered options

- **Cloud relay + native mobile app** (the reference implementation's shape) — rejected. A
  hosted broker means accounts, infrastructure, and a standing privacy liability for an app
  whose pitch is local-first; a native app is a second codebase. The one-page companion keeps
  the entire surface inside the artifact we already ship and sign.
- **Separate helper process for the listener** — rejected for now. The endpoints are relays
  onto four existing seams; a broker process would need those same seams re-exposed over IPC,
  growing the trusted surface it was meant to shrink. Revisit only if the capability cap is
  ever widened (which itself requires a new ADR).
- **LAN bind with plain HTTP** — rejected. Session tokens and transcript text in cleartext on
  shared Wi-Fi, no secure context so Web Push can never work, and a permanently-open LAN port
  on the trusted process. The convenience is not worth teaching users an insecure habit.
- **LAN bind with self-signed TLS** — rejected. The certificate-trust dance on iOS/Android is
  worse UX than installing Tailscale, browsers punish self-signed contexts unpredictably
  (service workers especially), and we would own certificate lifecycle forever. Tailscale
  serve delivers real TLS in one click; a user-managed reverse proxy remains possible against
  the loopback origin without our involvement.
- **WebSocket-first protocol** — rejected for v1. SSE + discrete authenticated POSTs is
  simpler to validate (every command is one schema-checked request), needs no upgrade
  handling, and degrades gracefully through proxies. Retained as the pre-decided fallback if
  the SSE-through-`tailscale serve` spike fails (Decision 5).
- **Cookie sessions + CSRF tokens** — rejected. Bearer-header auth removes the CSRF class
  outright instead of mitigating it, at the cost of a copy into `localStorage` the phone
  already protects at device level.
- **mDNS/Bonjour auto-discovery** — rejected. Discovery without the pairing secret is
  advertising the port; the QR already carries origin + secret in one scan.
- **Auto-relaxing Mode while away** (companion- or Away-mode-driven) — rejected as a default
  anywhere. Mode changes stay desktop-initiated, per-Thread, explicit, and visibly restored;
  the companion cannot touch Agent controls at all (Decision 2).

## Consequences

- Main gains its first network listener. Accepted knowingly, bounded by construction: OFF by
  default, loopback bind always, single-consume pairing, scoped hashed sessions, a
  table-enforced allowlist with a permanent negative list, and a review gate per slice. The
  worst-case remote capability — by design, not by diligence — is: read status, read
  transcripts, answer a Permission request, send a prompt.
- ADR-0001's "the renderer decides Permission requests" softens to "a paired human surface
  decides"; main remains an uninterpreting relay by request id. The renderer stays canonical
  for conversation state — the companion renders a projection and never writes one.
- Two new tables (`companion_sessions`, `push_subscriptions`) ride the ADR-0019 migration
  train; revocation cascades subscriptions. Backups (`VACUUM INTO`) now carry session hashes —
  acceptable, hashes are not tokens.
- The Tailscale assist introduces our first optional third-party runtime dependency posture:
  detected, never bundled, its absence degrades to loopback-only with honest Settings copy.
- Web Push honesty: closed-page phone alerts exist ONLY on the secure-context tier. The
  Settings copy must say so plainly rather than implying LAN push.
- The desktop must be awake for any of this to matter — the epic's power-policy slice
  (`powerSaveBlocker` held across in-flight-turn transitions, a pure module fed by
  `AgentActivity`, in the style of `agent-protection.ts`) is a hard prerequisite in spirit,
  and its lid-close limits must be stated plainly in the Away-mode UI.
- One more page to keep in sync with app versions (ADR-0018); being a single inline file, it
  ships inside the asar and cannot drift independently.
