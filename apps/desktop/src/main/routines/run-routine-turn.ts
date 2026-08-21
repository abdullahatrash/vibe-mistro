import type { RoutineOutcome, SendPromptResult } from '../../shared/ipc'
import type { BotStoreApi } from '../persistence/bot-store-api'
import type { MetadataStoreApi } from '../persistence/metadata-store-api'
import type { RoutineStoreApi } from '../persistence/routine-store-api'
import type { PromptTurnAgent } from '../prompt-turn'

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
}

/** The pool half: warm-or-reuse a Workspace's agent, wiring its events if fresh. */
export interface AcquiredRoutineAgent {
  agentId: string
  agent: PromptTurnAgent
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
  /** Run the turn itself — production passes `runPromptTurn` with headless delivery. */
  runTurn(agent: PromptTurnAgent, args: RoutineTurnPrompt): Promise<SendPromptResult>
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
    })
    return result
  }

  if (!deps.bots.get(routine.threadId)) {
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

  // The critical section: acquire and claim with no `await` between them, so two
  // ticks arriving in the same turn of the event loop cannot both take the Bot.
  const { agentId, agent } = deps.acquireAgent(workspace.dir)
  if (!deps.claimThread(agentId, routine.threadId)) {
    // Recorded on the Routine, NOT written into the conversation (ADR-0028 part 5).
    return record({ outcome: 'deferred', error: 'The Bot was busy, so this run was skipped.' })
  }
  deps.beginProtection(agentId)

  try {
    const result = await deps.runTurn(agent, {
      agentId,
      threadId: routine.threadId,
      workspaceId: thread.workspaceId,
      sessionId: thread.sessionId,
      text: routine.prompt,
    })
    return record(outcomeOf(result))
  } finally {
    deps.endProtection(agentId)
    deps.releaseThread(agentId, routine.threadId)
  }
}

/**
 * Map a turn's result onto the Routine vocabulary.
 *
 * `blocked` is absent on purpose: it belongs to the allowed-commands gate (#469),
 * which is the only thing that can block a turn rather than fail it. Every failure
 * reachable today is durable — sign-in expired, context exhausted, profile missing,
 * agent binary gone — which is why ADR-0028 part 5 has no retry.
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
