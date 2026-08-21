import type { RoutineOutcome, SendPromptResult } from '../../shared/ipc'
import type { BotStoreApi } from '../persistence/bot-store-api'
import type { MetadataStoreApi } from '../persistence/metadata-store-api'
import type { RoutineStoreApi } from '../persistence/routine-store-api'
import type { PromptTurnAgent, PromptTurnGate } from '../prompt-turn'
import { refusalMessage } from './allowed-commands'
import { createRoutinePermissionGate } from './routine-permission-gate'
import type { RoutineProfileSource } from './routine-profile'
import type { RoutineGateResult } from './write-routine-profile'

/**
 * **Run one Routine's turn with nobody watching** (#468, ADR-0028) — the single
 * main-side entry point the scheduler (#470) calls, and the only place the pieces
 * of a headless run are put together.
 *
 * It resolves the Routine to its Bot's Thread and Workspace, CLAIMS the Thread,
 * warms the agent, runs the prompt through the headless delivery of
 * `runPromptTurn`, and records how it went on the Routine. Nothing here decides
 * *when* — a Routine is due, or late, or missed, by arithmetic that lives in
 * `shared/schedule` and is read by the scheduler; this function is told to run and
 * runs.
 *
 * Three rules it exists to hold:
 *
 *  - **The busy signal is the per-THREAD streaming flag, claimed atomically.** Not
 *    the per-agent in-flight count: one `vibe-acp` child legitimately hosts
 *    concurrent turns across sessions (#456), so the per-agent count would defer a
 *    Routine because an unrelated Thread in the same Workspace is streaming. The
 *    acquire and the claim are one synchronous step, so two ticks cannot both find
 *    the Bot idle.
 *  - **A defer is recorded on the Routine, never written into the conversation**
 *    (ADR-0028 part 5) — otherwise a Bot gets chattier the more you use it.
 *  - **The agent is protected for the WHOLE run**, not just the streaming half:
 *    acquire, spawn, resume and persona re-select all happen before the first token,
 *    and that is exactly the window the minute-ly cap sweep could bite in.
 *
 * Every dependency is injected, so the whole flow is exercised without Electron,
 * a pool, or a database.
 */

/** How a headless run ended, in the vocabulary the Routine record stores. */
export interface RoutineTurnResult {
  outcome: RoutineOutcome
  /** The fixable message behind a non-`ok` run; null when it succeeded. */
  error: string | null
  /** The session the turn ran in, when it got that far. */
  sessionId?: string
  /** The JSON-RPC / app error code, when the failure carried one (e.g. -31004). */
  code?: number
  /**
   * The exact invocation the **allowed commands** gate refused, when the outcome
   * is `blocked` (#469). STRUCTURED rather than dug back out of `error`, because
   * slice 5's "add this command" offer has to hand back the same bytes the agent
   * asked for — a message is prose, and prose is where an extra backtick or a
   * truncation gets in. Null when the request named no command at all.
   */
  blockedCommand?: string | null
}

/**
 * The agent surface a GATED turn drives. `PromptTurnAgent` plus the four calls the
 * permission gate needs (#469) — the raw event stream it reads tool calls from,
 * the answer, the cancel, and the mode setter that puts the Bot's own persona back
 * afterwards. Structural, like everything else here: `WorkspaceAgent` satisfies it
 * already, and a test satisfies it with an object literal.
 */
export interface RoutineTurnAgent extends PromptTurnAgent {
  on(event: 'event', listener: (payload: unknown) => void): unknown
  off(event: 'event', listener: (payload: unknown) => void): unknown
  /** Answer a `session/request_permission` by its JSON-RPC request id. */
  respondPermission(requestId: number | string, optionId: string): void
  /** `session/cancel` — the in-flight prompt resolves `stopReason:"cancelled"`. */
  cancel(sessionId: string): void
}

/** The pool half: warm-or-reuse a Workspace's agent, wiring its events if fresh. */
export interface AcquiredRoutineAgent {
  agentId: string
  agent: RoutineTurnAgent
}

export interface RoutineTurnDeps {
  routines: Pick<RoutineStoreApi, 'get' | 'recordRun'>
  /** A Routine reports into a **Bot**'s conversation; anything else is refused. */
  bots: Pick<BotStoreApi, 'get'>
  /** The Thread + Workspace index: the Bot's session cursor and its Workspace dir. */
  threads: Pick<MetadataStoreApi, 'snapshot'>
  /**
   * Warm-or-reuse the Workspace's agent and wire its event tee when this call
   * spawned it. SYNCHRONOUS, so it and the claim below form one uninterruptible
   * step; the child itself does not start until the turn asks it to.
   */
  acquireAgent(workspaceDir: string): AcquiredRoutineAgent
  /** Take the Thread for this turn, or refuse because it is already streaming. */
  claimThread(agentId: string, threadId: string): boolean
  /** Release the claim, however the run ended. */
  releaseThread(agentId: string, threadId: string): void
  /** Shield the agent from idle/cap eviction for the whole run. */
  beginProtection(agentId: string): void
  endProtection(agentId: string): void
  /**
   * Put this Bot's routine-only permission gate on disk and CONFIRM it is there
   * (#469). Called before every run, never trusted from a previous one: a profile
   * key Vibe does not recognise is ignored in silence, so only a read-back can
   * tell a gated routine from one that merely looks configured.
   */
  ensureGate(source: RoutineProfileSource): Promise<RoutineGateResult>
  /**
   * Write a failure into the Bot's OWN conversation through the turn-error tee,
   * and touch the Thread so the unread dot appears. `prompt` is teed first when
   * the turn never got far enough to tee it itself, so the entry pair still reads
   * as "what was asked, then why it did not happen" (ADR-0028 part 5: a routine
   * turn always writes an entry).
   */
  reportFailure(args: { threadId: string; message: string; prompt?: string }): void
  /** Run the turn itself — production passes `runPromptTurn` with headless delivery. */
  runTurn(agent: RoutineTurnAgent, args: RoutineTurnPrompt, gate: PromptTurnGate): Promise<SendPromptResult>
  /** Epoch-ms clock, injected so a run's recorded timestamp is deterministic in tests. */
  now(): number
}

/** What the runner hands the turn — a `SendPromptArgs` with no renderer intent on it. */
export interface RoutineTurnPrompt {
  agentId: string
  threadId: string
  workspaceId: string
  sessionId: string | null
  text: string
}

/**
 * Run the Routine named by `routineId` now, and record the outcome on it.
 *
 * Deliberately does NOT check `active`: pausing decides what the scheduler
 * considers due (#470), and a "run now" from the authoring surface (#471) must work
 * on a paused Routine — the two questions are asked in different places on purpose.
 *
 * Never rejects. Every failure is an outcome, because the caller is a timer.
 */
export async function runRoutineTurn(
  deps: RoutineTurnDeps,
  routineId: string,
): Promise<RoutineTurnResult> {
  const routine = deps.routines.get(routineId)
  // No row means nothing to record against either — the only failure this function
  // can answer with and nothing else.
  if (!routine) return { outcome: 'failed', error: `No routine ${routineId}.` }

  const record = (result: RoutineTurnResult): RoutineTurnResult => {
    deps.routines.recordRun(routineId, {
      lastRunAt: deps.now(),
      lastOutcome: result.outcome,
      lastError: result.error,
      // Additive and optional (#469): a run that was not blocked carries null,
      // which clears whatever the previous block left behind.
      lastBlockedCommand: result.blockedCommand ?? null,
    })
    return result
  }

  const bot = deps.bots.get(routine.threadId)
  if (!bot) {
    return record({ outcome: 'failed', error: 'This routine is not attached to a Bot any more.' })
  }

  const snapshot = deps.threads.snapshot()
  const thread = snapshot.threads.find((candidate) => candidate.id === routine.threadId)
  const workspace = thread
    ? snapshot.workspaces.find((candidate) => candidate.id === thread.workspaceId)
    : undefined
  // A Bot's Thread and its Workspace both cascade with the Bot, so missing either
  // means the record is mid-removal or the store is locked. Refuse rather than
  // guess a directory to run somebody's shell commands in.
  if (!thread || !workspace) {
    return record({ outcome: 'failed', error: "This routine's project could not be found." })
  }

  // THE GATE, before anything is claimed or spawned (#469, ADR-0028 part 4).
  //
  // A routine whose permission gate cannot be CONFIRMED refuses to run and says
  // why. It is checked here, first, for two reasons: there is nothing to release
  // if it refuses, and a run that cannot be gated must never reach the point of
  // warming an agent — the failure is durable, so the cheapest possible refusal is
  // also the most honest one.
  const gate = await deps.ensureGate({ botProfileId: bot.profileId, botName: bot.name })
  if (!gate.ok) {
    const message =
      `"${routine.name}" did not run: its permission gate could not be confirmed, so it was ` +
      `refused rather than run unguarded. ${gate.problems.join(' ')}`
    deps.reportFailure({ threadId: routine.threadId, message, prompt: routine.prompt })
    return record({ outcome: 'failed', error: message })
  }

  // The critical section: acquire and claim with no `await` between them, so two
  // ticks arriving in the same turn of the event loop cannot both take the Bot.
  const { agentId, agent } = deps.acquireAgent(workspace.dir)
  if (!deps.claimThread(agentId, routine.threadId)) {
    // Recorded on the Routine, NOT written into the conversation (ADR-0028 part 5).
    return record({ outcome: 'deferred', error: 'The Bot was busy, so this run was skipped.' })
  }
  deps.beginProtection(agentId)

  // We are the permission SERVER for this turn (the ADR-0001 amendment): main
  // answers, from the Routine's allowed commands, with no renderer in the loop.
  const permissions = createRoutinePermissionGate({
    allowedCommands: routine.allowedCommands,
    seams: {
      respond: (requestId, optionId) => agent.respondPermission(requestId, optionId),
      cancel: (sessionId) => agent.cancel(sessionId),
    },
  })
  // A holder rather than a `let`, because the assignment happens inside a callback
  // and the `finally` below has to see it.
  const bound: { sessionId: string | null } = { sessionId: null }
  const observe = (payload: unknown): void => permissions.observe(payload)
  agent.on('event', observe)

  try {
    const result = await deps.runTurn(
      agent,
      {
        agentId,
        threadId: routine.threadId,
        workspaceId: thread.workspaceId,
        sessionId: thread.sessionId,
        text: routine.prompt,
      },
      {
        profileId: gate.profileId,
        onSessionBound: (sessionId) => {
          bound.sessionId = sessionId
          permissions.armSession(sessionId)
        },
      },
    )
    const blocked = permissions.blocked
    if (blocked) {
      // The cancel already resolved the turn through the normal turn-complete
      // path, so `result` reads as an ordinary cancelled turn. The Routine's
      // outcome is decided by the gate, not by the stop reason.
      const message = refusalMessage(routine.name, blocked.command, blocked.reason)
      deps.reportFailure({ threadId: routine.threadId, message })
      return record({ outcome: 'blocked', error: message, blockedCommand: blocked.command })
    }
    return record(outcomeOf(result))
  } finally {
    agent.off('event', observe)
    // Put the Bot's OWN persona back on the session. The gate profile is this
    // turn's posture, not the Bot's: leaving it selected would make the Bot
    // refuse to write files and ask about every command the next time a PERSON
    // talked to it on this same live session — which is exactly what ADR-0028
    // rejected when it chose a second profile over rewriting the first.
    // Best-effort: the next bind re-selects the persona anyway.
    if (bound.sessionId) {
      try {
        await agent.setMode(bound.sessionId, bot.profileId)
      } catch (err) {
        console.error(
          `[vibe-mistro:routines] could not restore ${bot.profileId} after a routine turn: ${String(err)}`,
        )
      }
    }
    deps.endProtection(agentId)
    deps.releaseThread(agentId, routine.threadId)
  }
}

/**
 * Map a turn's result onto the Routine vocabulary.
 *
 * `blocked` is absent HERE on purpose, and still is: a denial cancels the turn, so
 * the wire result of a blocked run is an ordinary cancelled one and only the gate
 * knows better. The caller reads `permissions.blocked` and overrides — mapping a
 * stop reason to `blocked` would put the decision in the one place that cannot see
 * it. Every other failure is durable — sign-in expired, context exhausted, profile
 * missing, agent binary gone — which is why ADR-0028 part 5 has no retry.
 */
function outcomeOf(result: SendPromptResult): RoutineTurnResult {
  if (result.ok) return { outcome: 'ok', error: null, sessionId: result.sessionId }
  if (result.kind === 'not-signed-in') {
    return {
      outcome: 'failed',
      error: 'Sign-in expired — open the project and sign in, then this routine can run again.',
    }
  }
  return { outcome: 'failed', error: result.error, ...(result.code === undefined ? {} : { code: result.code }) }
}
