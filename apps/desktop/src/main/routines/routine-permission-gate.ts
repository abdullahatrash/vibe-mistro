import { matchAllowedCommand, type AllowedCommandRefusal } from './allowed-commands'

/**
 * **We answer the agent's permission requests for a scheduled turn** (#469,
 * ADR-0028 part 4 — the amendment to ADR-0001).
 *
 * ADR-0001 says the renderer owns conversation state and answers permission
 * requests. That stays true for every turn a person started. It cannot be true
 * for a routine: an unanswered request hangs the turn forever (Vibe waits on the
 * client with no timeout), and there is no client to ask. So for scheduler-raised
 * turns, and only those, main answers — from the Routine's **allowed commands**.
 *
 * ## Recovering what is being asked about
 *
 * The request itself is almost empty. Captured verbatim at vibe-acp 2.24.3
 * (`docs/acp-capture.md` §17, and §6/§15F before it), `params.toolCall` is
 * `{toolCallId}` and NOTHING else — no tool name, no path, no command. So the
 * gate keeps a ledger of the session's `tool_call` / `tool_call_update` frames and
 * looks the id up in it:
 *
 *  - **tool identity** is `_meta.tool_name` / `_meta.effect_kind` (snake_case, on
 *    the update object);
 *  - **the command text** is `rawInput.command`, which arrives on an EARLIER
 *    update than the one immediately before the request — hence a ledger that
 *    merges frames by id rather than a look at the last frame.
 *
 * ### The trap, and why the ledger is the only source of the command
 *
 * The permission request *does* carry an `invocation_pattern` inside its
 * allow-always options' `_meta`, and using it would be the obvious implementation.
 * It is also wrong in the one way that matters. For `echo hello > probe.txt` the
 * pattern reads **`echo hello <redirect>`** — Vibe's shell parser tokenises the
 * redirect into a placeholder, which is precisely the mechanism that let a write
 * through a command allowlist in #458. A matcher fed that string authorises a
 * command that writes a file it never names. We therefore match `rawInput.command`
 * and treat the option metadata only as a scope check.
 *
 * ## What it does with the answer
 *
 * Allowed → `allow_once`, never either allow-always option: those are a session
 * grant and a PERMANENT config write (#464), and an unattended run must not widen
 * anything for the human who was not there.
 *
 * Refused → `reject_once` **and cancel the turn**. Not deny-and-continue: #458
 * measured what continuing produces — fourteen different routes attempted on a
 * one-file task until one was allowed. Stopping on the first denial is what turns
 * an evasion loop into a message a person can fix.
 */

/** How the gate reaches the agent. Both calls are fire-and-forget by nature. */
export interface RoutinePermissionSeams {
  /** Answer a `session/request_permission` by its JSON-RPC request id. */
  respond(requestId: number | string, optionId: string): void
  /** `session/cancel` — the in-flight prompt then resolves `stopReason:"cancelled"`. */
  cancel(sessionId: string): void
}

/** What the ledger knows about one tool call, merged across its frames. */
export interface ToolCallFacts {
  /** `_meta.tool_name`, e.g. `bash`. */
  toolName: string | null
  /** `_meta.effect_kind`, e.g. `shell` — Vibe's own vocabulary for what it does. */
  effectKind: string | null
  /** `rawInput.command` — the WHOLE invocation, the only trustworthy copy of it. */
  command: string | null
}

/** The blocked invocation, kept as structure so slice 5 can offer to add it. */
export interface BlockedInvocation {
  /** The exact command text, or null when none was ever readable. */
  command: string | null
  reason: AllowedCommandRefusal
}

export type RoutinePermissionDecision =
  | { kind: 'allow'; optionId: string; command: string }
  | { kind: 'deny'; optionId: string; blocked: BlockedInvocation }

/** One `options[]` entry of a `session/request_permission`. */
interface PermissionOption {
  optionId?: unknown
  kind?: unknown
  _meta?: { required_permissions?: { scope?: unknown }[] }
}

/** The fallback option ids, used only when the request offers no matching `kind`. */
const ALLOW_ONCE = 'allow_once'
const REJECT_ONCE = 'reject_once'

/**
 * Decide one permission request. PURE — the whole policy in one function over
 * (what was asked, what we know about the tool call, what the user allowed), so
 * every rule below is a unit test rather than a wire behaviour.
 *
 * It denies on every uncertainty, and the uncertainties are not hypothetical:
 * a subagent's tool calls raise permission requests on the ROOT session carrying
 * a `toolCallId` that never appeared in any `tool_call` frame (acp-capture §15F),
 * so "unknown tool call" is a case that happens in normal operation. Unattended,
 * the only defensible answer to *something I cannot identify* is no.
 */
export function decideRoutinePermission(input: {
  options: readonly PermissionOption[]
  facts: ToolCallFacts | null
  allowedCommands: readonly string[]
}): RoutinePermissionDecision {
  const allowOption = optionIdOfKind(input.options, 'allow_once') ?? ALLOW_ONCE
  const denyOption = optionIdOfKind(input.options, 'reject_once') ?? REJECT_ONCE
  const deny = (blocked: BlockedInvocation): RoutinePermissionDecision => ({
    kind: 'deny',
    optionId: denyOption,
    blocked,
  })

  // (1) An id we have never seen a tool call for — a subagent's tool, or a frame
  // we missed. Nothing to match, nothing to report but the refusal itself.
  if (!input.facts) return deny({ command: null, reason: 'unidentified' })

  // (2) Only shell invocations are expressible on an allowed-commands list. Vibe
  // has no effect-level notion of read versus write, so `effect_kind` is as close
  // as the protocol gets to "this runs a command" — and anything else (a file
  // write that reached us despite the gate, a web fetch, an MCP tool) has no entry
  // that could authorise it.
  if (input.facts.effectKind !== 'shell') return deny({ command: null, reason: 'unidentified' })

  // (3) A scope we do not understand is a permission about something other than a
  // command pattern (a path outside the workdir, say). The command text cannot
  // stand for it, so it is refused whatever the list says.
  if (!everyScopeIsCommandPattern(input.options)) {
    return deny({ command: input.facts.command, reason: 'unidentified' })
  }

  // (4) Shell, but no readable command. Refuse: answering "yes" to a command we
  // cannot name is the one thing an unattended gate must never do.
  const command = input.facts.command?.trim() ?? ''
  if (!command) return deny({ command: null, reason: 'blank' })

  const match = matchAllowedCommand(command, input.allowedCommands)
  if (!match.allowed) return deny({ command, reason: match.reason })
  return { kind: 'allow', optionId: allowOption, command }
}

/** The live half: a ledger, an armed session, and the first denial it took. */
export interface RoutinePermissionGate {
  /**
   * Start answering for this session. Called the moment the turn binds, which is
   * before any permission request can arrive (they only occur during
   * `session/prompt`). Until then every payload is ignored — an agent hosts many
   * sessions and a Routine answers for exactly one.
   */
  armSession(sessionId: string): void
  /** Feed one raw ACP payload. Never throws. */
  observe(payload: unknown): void
  /** The first refusal, or null. Set once: a cancelled turn cannot be blocked twice. */
  readonly blocked: BlockedInvocation | null
}

export function createRoutinePermissionGate(deps: {
  allowedCommands: readonly string[]
  seams: RoutinePermissionSeams
}): RoutinePermissionGate {
  const ledger = new Map<string, ToolCallFacts>()
  let sessionId: string | null = null
  let blocked: BlockedInvocation | null = null

  const remember = (update: Record<string, unknown>): void => {
    const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null
    if (!toolCallId) return
    const meta = asRecord(update._meta)
    const rawInput = asRecord(update.rawInput)
    const previous = ledger.get(toolCallId) ?? { toolName: null, effectKind: null, command: null }
    // MERGE, never replace: `rawInput.command` arrives on one frame and the frame
    // immediately before the permission request carries only a status.
    ledger.set(toolCallId, {
      toolName: stringOr(meta?.tool_name, previous.toolName),
      effectKind: stringOr(meta?.effect_kind, previous.effectKind),
      command: stringOr(rawInput?.command, previous.command),
    })
  }

  const answer = (requestId: number | string, params: Record<string, unknown>): void => {
    const toolCall = asRecord(params.toolCall)
    const toolCallId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : null
    const options = Array.isArray(params.options) ? (params.options as PermissionOption[]) : []
    const decision = decideRoutinePermission({
      options,
      facts: toolCallId ? (ledger.get(toolCallId) ?? null) : null,
      allowedCommands: deps.allowedCommands,
    })
    deps.seams.respond(requestId, decision.optionId)
    if (decision.kind === 'allow') return
    // The FIRST denial cancels; a later one (the turn takes a moment to unwind)
    // is still refused, but must not overwrite the invocation being reported or
    // re-cancel a session that is already stopping.
    if (blocked) return
    blocked = decision.blocked
    if (sessionId) deps.seams.cancel(sessionId)
  }

  return {
    armSession(id: string) {
      sessionId = id
    },
    observe(payload: unknown) {
      if (!sessionId) return
      const message = asRecord(payload)
      const params = asRecord(message?.params)
      if (!message || !params || params.sessionId !== sessionId) return
      if (message.method === 'session/update') {
        const update = asRecord(params.update)
        const kind = update?.sessionUpdate
        if (update && (kind === 'tool_call' || kind === 'tool_call_update')) remember(update)
        return
      }
      if (message.method === 'session/request_permission' && message.id !== undefined) {
        answer(message.id as number | string, params)
      }
    },
    get blocked() {
      return blocked
    },
  }
}

/** The `optionId` of the first option declaring this `kind`, or null. */
function optionIdOfKind(options: readonly PermissionOption[], kind: string): string | null {
  for (const option of options) {
    if (option?.kind === kind && typeof option.optionId === 'string') return option.optionId
  }
  return null
}

/**
 * Every `required_permissions` entry the request carries is about a command
 * pattern. An option with no `_meta` contributes nothing (the plain `allow_once`
 * and `reject_once` options never carry one).
 */
function everyScopeIsCommandPattern(options: readonly PermissionOption[]): boolean {
  for (const option of options) {
    for (const required of option?._meta?.required_permissions ?? []) {
      if (required?.scope !== 'command_pattern') return false
    }
  }
  return true
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringOr(value: unknown, fallback: string | null): string | null {
  return typeof value === 'string' ? value : fallback
}
