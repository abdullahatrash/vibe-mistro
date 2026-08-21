import { randomUUID } from 'node:crypto'
import {
  IPC,
  type AuthMethod,
  type PromptImage,
  type PromptResult,
  type SendPromptArgs,
  type SendPromptResult,
  type ThreadAgentControls,
  type ThreadConfigAxis,
  type ThreadInfo,
  type TranscriptEntry,
  type TranscriptImageRef,
  type TranscriptRoutineRef,
} from '../shared/ipc'
import { controlsWithCurrentValue } from '../shared/thread-control-intent'
import type { AttachmentStore } from './persistence/attachment-store'
import type { BotStoreApi } from './persistence/bot-store-api'
import type { MetadataStoreApi } from './persistence/metadata-store-api'
import {
  agentReboundEntry,
  turnCompleteEntry,
  turnErrorEntry,
  userPromptEntry,
} from './persistence/transcript'
import type { TranscriptBridge } from './persistence/transcript-bridge'
import { applyBotProfile, mayClaimPreopenedSession, planBotProfileSelection } from './bots/select-bot-profile'
import { applyPendingThreadControls, type PendingThreadControlAgent } from './pending-thread-controls'
import { ensureBoundSession, type SessionBinder } from './thread-binding'
import { WorkspaceAgentError } from './workspace-agent'

/**
 * ONE prompt turn: bind-on-first-prompt, tee the input, send `session/prompt`,
 * and map the outcome. Lifted out of the `sendPrompt` IPC handler in `index.ts`
 * (#468) so the handler stays a thin eviction-protection wrapper — and so this,
 * the piece a **Routine** reuses wholesale, can be tested without Electron.
 *
 * The turn is the same turn either way. What differs is who is watching, which is
 * the {@link PromptTurnDelivery} discriminator:
 *
 *  - **renderer** — a user at the composer. `thread:bound` goes to their window,
 *    and a failure BEFORE the bind is returned and rendered there, deliberately
 *    leaving no transcript residue: nothing was logged yet, so a failed first
 *    prompt should not leave a half-turn behind, and a teed copy would duplicate
 *    what the composer already shows.
 *  - **headless** — a Routine (ADR-0028). Nobody holds the result, so that same
 *    pre-bind failure is SILENT: #456 found an agent that will not spawn, a failed
 *    `session/new` and a failed resume all wrote nothing and did not even move
 *    `lastActiveAt`, so the Bot showed no unread dot and the conversation showed no
 *    reason. Headless delivery closes that: the attempted prompt and the failure are
 *    teed into the Bot's own conversation and the Thread is touched, which is
 *    ADR-0028's one rule — **a routine turn always writes an entry, success or
 *    failure**.
 *
 * Nothing else about the turn is conditional. In particular the tee, the persona
 * selection and the turn-error path already worked with nobody watching (#456);
 * this module only stops requiring a window to reach them.
 */

/** The half of Electron's `WebContents` this needs — keeps the module Electron-free. */
export interface ThreadBoundSender {
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * The permission gate a scheduled turn wears (#469, ADR-0028 part 4).
 *
 * A Bot's own profile is its persona and is shared with interactive use, so the
 * gate lives in a SECOND profile selected for this turn alone. Two properties
 * make it a gate rather than a preference:
 *
 *  - it is selected on EVERY gated turn, including one that merely reuses a
 *    session bound earlier — a reuse reports no controls, which the ordinary
 *    persona plan reads as "already selected", and for a routine that reading
 *    would mean running ungated;
 *  - a selection failure is FATAL. `setMode` routes through the validating
 *    `session/set_config_option`, so a rejection means the session does not offer
 *    the profile — the gate is not on, and a routine whose gate cannot be
 *    confirmed must not run.
 */
export interface PromptTurnGate {
  /** The routine-only profile id to select on the mode axis. */
  profileId: string
  /**
   * The session this turn bound to, reported the instant it is known and always
   * before `session/prompt` — which is the only time a permission request can
   * arrive, and so the moment the answerer must be listening by.
   */
  onSessionBound(sessionId: string): void
}

/**
 * Who receives this turn's out-of-band signals. `headless` carries no sender
 * because a Routine has no window: `thread:bound` has no consumer, and the
 * conversation itself becomes the reporting surface.
 */
export type PromptTurnDelivery =
  | { kind: 'renderer'; sender: ThreadBoundSender }
  | {
      kind: 'headless'
      gate?: PromptTurnGate
      /**
       * The Routine that raised this turn (#470), stamped onto the teed prompt so
       * the bubble wears a chip naming it. It rides the DELIVERY rather than
       * `SendPromptArgs` because no renderer can ever set it: a prompt is a routine
       * prompt because the scheduler sent it, not because someone said so.
       */
      routine?: TranscriptRoutineRef
      /**
       * TEE this turn's own entries **and** push them to whatever windows exist
       * (#471) — it replaces the plain tee, it does not run beside it.
       *
       * Without it a Bot open while its Routine fires shows the reply streaming in
       * with nothing above it: the prompt, its chip and the "late" notice are
       * written durably and reach a live view only on the next reopen.
       *
       * Optional, and absent means "tee only": every entry still lands in the log,
       * which is what the run's correctness rests on. See `routine-echo.ts` for
       * which entries are pushed and why the streamed ones must not be.
       */
      echo?: (threadId: string, entry: TranscriptEntry) => void
    }

/** The agent surface one turn drives — structural, so tests never spawn `vibe-acp`. */
export interface PromptTurnAgent extends SessionBinder, PendingThreadControlAgent {
  /**
   * Spawn + handshake the child, or no-op when it is already running. Idempotent,
   * and only awaited on the headless path — see the call site.
   */
  start(): Promise<void>
  readonly authMethods: AuthMethod[]
  /** The eager primary session's controls (ADR-0012), or null when none is open. */
  readonly primarySessionControls: ThreadAgentControls | null
  /** Take the eager primary session, once — null when already consumed or never opened. */
  consumePrimarySession(): ThreadInfo | null
  prompt(sessionId: string, text: string, images?: PromptImage[]): Promise<PromptResult>
}

export interface PromptTurnDeps {
  store: Pick<MetadataStoreApi, 'upsertThread' | 'snapshot' | 'deleteThread' | 'touchThread'>
  bridge: Pick<TranscriptBridge, 'bind' | 'tee' | 'isTombstoned'>
  /** Read-only Bot access: which persona (if any) this Thread owns. */
  bots: Pick<BotStoreApi, 'get'>
  /** Null when the attachments dir could not be created — image persistence no-ops. */
  attachments: Pick<AttachmentStore, 'saveAll'> | null
}

export async function runPromptTurn(
  deps: PromptTurnDeps,
  delivery: PromptTurnDelivery,
  agent: PromptTurnAgent,
  args: SendPromptArgs,
): Promise<SendPromptResult> {
  // Bind on first prompt (ADR-0005, TB5): a draft (sessionId null) mints its
  // session via `session/new` NOW and binds it onto this Thread id; a reopened
  // Thread whose stored session isn't hosted resumes via `session/load` (re-binding
  // fresh on a resume failure); an already-bound Thread reuses its session — no
  // second `session/new`. A binding failure surfaces WITHOUT teeing for a renderer
  // turn (see the delivery note above) and WITH a teed entry for a headless one —
  // and the draft's mint RESERVES its `threads` row before the `session/new`
  // round-trip (#417), releasing it again if the mint fails, so the bridge below is
  // never pointed at a Thread whose row doesn't exist yet.
  let sessionId: string
  let rebound: boolean
  // The routine gate (#469), when this turn is a scheduled one. Present ONLY on
  // the headless path — every user-initiated turn keeps the Bot's own persona and
  // the renderer's own answering (ADR-0001).
  const gate = delivery.kind === 'headless' ? delivery.gate : undefined
  try {
    // A Routine warms a Workspace nobody selected, so the child may not be running
    // yet — the renderer path always arrives here on an agent `startThread` already
    // handshook. Idempotent (a warm agent early-returns), and INSIDE the try, so
    // "the agent will not spawn" — one of the three silent pre-bind failures #456
    // found — reports like any other rather than escaping as a rejected promise.
    if (delivery.kind === 'headless') await agent.start()
    // Point the bridge at the Thread being prompted, so a session-less lifecycle
    // event tees to the ACTIVE Thread when several share an agent — refreshed every
    // prompt (last-write-wins, and only the active Thread prompts at a time).
    deps.bridge.bind(args.agentId, args.threadId)
    // Is this Thread a Mistro Bot, and which persona does it own? Resolved BEFORE
    // the bind, because it decides which session the bind may use (#448).
    const botProfileId = deps.bots.get(args.threadId)?.profileId ?? null
    // A draft's first prompt (sessionId null) claims the Workspace's eager primary
    // session (ADR-0012), so it binds to that instead of minting a SECOND
    // `session/new`; consumed once, so a second concurrent draft mints its own.
    // Never claimed for a reopened/already-bound Thread (those aren't case (i)).
    //
    // A Bot declines that session unless it ADVERTISES the Bot's persona (#448): a
    // Bot created after the Workspace connected is absent from the primary
    // session's registry scan, so binding to it would give the Bot a session that
    // can never wear its persona — silently, for the rest of the run (every later
    // turn reuses that session and re-selection is skipped). Minting a fresh
    // `session/new` re-scans and costs one extra session in that case alone.
    //
    // A GATED turn asks the same question about the GATE profile instead: the
    // primary session must be able to wear the gate, not merely the persona, or
    // the selection below fails and the routine refuses to run.
    const preopened =
      args.sessionId === null &&
      mayClaimPreopenedSession(gate?.profileId ?? botProfileId, agent.primarySessionControls)
        ? (agent.consumePrimarySession() ?? undefined)
        : undefined
    const bound = await ensureBoundSession({
      agent,
      store: deps.store,
      threadId: args.threadId,
      workspaceId: args.workspaceId,
      sessionId: args.sessionId,
      preopened,
    })
    sessionId = bound.sessionId
    rebound = bound.rebound
    const reportedControls = bound.controls
    let actualControls = reportedControls
    let controlFailures: ThreadConfigAxis[] = []
    /** A Bot whose persona could not be selected on this session (#446) — surfaced below. */
    let botProfileError: string | undefined
    if (reportedControls && args.controlIntent) {
      const applied = await applyPendingThreadControls(
        agent,
        sessionId,
        args.controlIntent,
        reportedControls,
        (axis, error) => {
          console.error(
            `[vibe-mistro:controls] pre-prompt ${axis} apply failed (${args.threadId}): ` +
              `${error instanceof Error ? error.message : String(error)}`,
          )
        },
      )
      actualControls = applied.controls
      controlFailures = applied.failedAxes
    }
    // A Mistro Bot's persona is a Vibe agent profile selected on the MODE axis
    // (#446, ADR-0027), and it must be re-selected on EVERY bind: Mode does not
    // survive `session/load` and ADR-0007's re-assert cache is in-memory, so a Bot
    // reopened after a restart would otherwise answer as a nameless agent. It runs
    // AFTER any pending control intent so the Bot's profile always wins the axis.
    //
    // `setMode` routes through the VALIDATING `session/set_config_option` (a bogus
    // id is rejected with -32602), never `session/set_mode`, which answers a bad id
    // with `{}` — a silent no-op indistinguishable from success (#427) — on every
    // 2.24.x binary, all of which advertise the `mode` config option. A failure is
    // reported, never swallowed: a Bot that quietly answers with no persona is the
    // one failure ADR-0027 forbids.
    //
    // For a GATED turn the plan is not a plan at all: select the routine profile,
    // unconditionally, and treat a failure as the end of the turn. See
    // {@link PromptTurnGate} for why "the session already has a mode selected" is
    // not an acceptable answer here.
    const profileOutcome = await applyBotProfile(
      agent,
      sessionId,
      gate ? { kind: 'select', profileId: gate.profileId } : planBotProfileSelection(botProfileId, reportedControls),
    )
    if (gate && !profileOutcome.ok) {
      // Thrown, so it lands in the catch below with every other pre-prompt
      // failure: the attempted prompt and the reason are teed into the Bot's own
      // conversation and NOTHING is sent to the agent.
      throw new Error(
        `${profileOutcome.message} A routine will not run without its permission gate.`,
      )
    }
    // The answerer must be listening before `session/prompt`, and this is the
    // first moment the session id exists. Ordered after the gate selection so a
    // turn that never runs never arms anything.
    if (gate) gate.onSessionBound(sessionId)
    if (profileOutcome.ok) {
      if (profileOutcome.selected && actualControls) {
        actualControls = controlsWithCurrentValue(actualControls, 'mode', profileOutcome.selected)
      }
    } else {
      botProfileError = profileOutcome.message
      console.error(`[vibe-mistro:bots] ${args.threadId}: ${profileOutcome.message}`)
    }
    // Tell the renderer this Thread is now bound after any validated pending Side
    // Draft controls have been awaited, and BEFORE `agent.prompt` streams below
    // (same webContents, so ordered ahead of those `acp:event`s). This binds the
    // Thread's live view to its OWN session up front, so it never infers a
    // session from an arbitrary (possibly sibling) event. `rebound` (TB4 #33)
    // carries a NEW session for a reopened Thread whose resume failed — the
    // renderer rebinds its live view to it AND renders the "context reset" notice.
    //
    // We emit whenever the bind produced a fresh result with `controls` (#70) — a
    // mint, a re-bind, OR a successful resume — so the Thread's picker sources its
    // OWN Mode/Model/effort from THIS session (the #66 single-Thread limitation this
    // removes). A plain reuse of an already-hosted session brings null controls and
    // no re-emit (the renderer keeps what it holds). We hand the renderer the
    // session's REPORTED controls only; the renderer caches the user's prior
    // non-default selection and RE-ASSERTS it after a `session/load` resume (#72,
    // ADR-0007). For a Side Draft's first bind, `actualControls` instead reflects
    // only successfully applied ids that this newly bound session advertised.
    //
    // A headless turn skips this entirely: the signal exists for a live view, and a
    // Routine has none. Its persona failure still reaches the conversation, because
    // `applyBotProfile` logs it and the turn itself is teed either way.
    if (actualControls && delivery.kind === 'renderer' && !delivery.sender.isDestroyed()) {
      delivery.sender.send(IPC.threadBound, {
        threadId: args.threadId,
        sessionId,
        rebound,
        controls: actualControls,
        controlFailures: controlFailures.length > 0 ? controlFailures : undefined,
        botProfileError,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // The pre-bind hole (#456, ADR-0028 part 5): with a renderer this returns and
    // the composer renders it; headless, the return value has no reader, so the
    // Bot's own conversation is where it has to land.
    if (delivery.kind === 'headless') reportPreBindFailure(deps, delivery, args, message)
    if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
      return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
    }
    return { ok: false, kind: 'error', error: message }
  }

  // A prompt is Thread ACTIVITY: bump the persisted `lastActiveAt` so the sidebar's
  // timestamp + order reflect the last prompt, not the first bind. Without this a
  // continued Thread (successful resume) or any later prompt on an already-hosted
  // session never re-wrote the store — the record kept its bind-time timestamp
  // forever. Best-effort + fire-and-forget (ADR-0005): a persist failure logs and
  // never gates the turn.
  touchThread(deps, args.threadId)

  // Tee the user's prompt (the conversation INPUT) to THIS Thread's log before
  // sending it, so it precedes the streamed events it triggers. We hold the
  // Thread id, so no bridge lookup — a draft's first prompt can't misroute to
  // another Thread. Main has no renderer item id, so mint an opaque replay key.
  //
  // Image attachments persist FIRST (awaited: the refs must exist when the entry
  // is appended, and the entry must precede the turn's `acp-event` tees — the
  // TranscriptStore chain serializes in CALL order). `saveAll` never rejects; a
  // failed/oversized image drops out of the refs and the prompt replays
  // text-only. Skipped for a tombstoned Thread so a removeWorkspace racing this
  // in-flight prompt can't re-create the attachments dir after its delete.
  let imageRefs: TranscriptImageRef[] | undefined
  if (deps.attachments && args.images?.length && !deps.bridge.isTombstoned(args.threadId)) {
    imageRefs = await deps.attachments.saveAll(args.threadId, args.images)
    if (imageRefs.length === 0) imageRefs = undefined
  }
  teeEntry(
    deps,
    delivery,
    args.threadId,
    userPromptEntry(randomUUID(), args.text, imageRefs, routineRefOf(delivery)),
  )
  // On a re-bind (TB4 #33), persist the "context reset" notice right AFTER the
  // user's prompt and BEFORE the turn's events — so a later reopen replays it
  // in the same position the live view rendered it (`thread:bound` -> notice).
  if (rebound) teeEntry(deps, delivery, args.threadId, agentReboundEntry())
  try {
    const result = await agent.prompt(sessionId, args.text, args.images)
    // Tee the clean turn end: this signal lives ONLY in this IPC response
    // (never an `acp:event`), so without it a replay leaves `isProcessing`
    // stuck true. Serialized after the turn's events (TranscriptStore chain).
    teeEntry(deps, delivery, args.threadId, turnCompleteEntry())
    return { ok: true, result, sessionId }
  } catch (err) {
    // Mid-session expiry (-32000): keep the agent alive so the renderer can
    // re-auth in place on the same agent; don't stop it. This is a re-auth
    // flow, NOT a conversation error — tee `turn-complete` (the renderer
    // synthesizes no ErrorItem here either), so replay isn't left processing.
    if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
      teeEntry(deps, delivery, args.threadId, turnCompleteEntry())
      return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
    }
    const message = err instanceof Error ? err.message : String(err)
    teeEntry(deps, delivery, args.threadId, turnErrorEntry(message))
    // Carry the JSON-RPC/app code (e.g. -31008 for an unsupported/oversized image,
    // #100) so the renderer can special-case it rather than show a generic error.
    return {
      ok: false,
      kind: 'error',
      error: message,
      code: err instanceof WorkspaceAgentError ? err.code ?? undefined : undefined,
    }
  }
}

/**
 * Write a HEADLESS turn's pre-bind failure into the Bot's own conversation, and
 * touch the Thread so the unread dot appears (ADR-0028 part 5).
 *
 * The prompt is teed alongside the failure so the entry pair reads exactly like
 * every other failed turn — what was asked, then why it did not happen. Without the
 * prompt the reader would find an error with no question attached to it.
 *
 * Best-effort throughout: a tee to a tombstoned or unknown Thread is dropped by the
 * bridge, and the touch cannot reject. The turn already failed; reporting it must
 * not fail louder.
 */
function reportPreBindFailure(
  deps: PromptTurnDeps,
  delivery: PromptTurnDelivery,
  args: SendPromptArgs,
  message: string,
): void {
  const prompt = userPromptEntry(randomUUID(), args.text, undefined, routineRefOf(delivery))
  teeEntry(deps, delivery, args.threadId, prompt)
  teeEntry(deps, delivery, args.threadId, turnErrorEntry(message))
  touchThread(deps, args.threadId)
}

/**
 * Write one of THIS TURN's entries to the Thread's log — and, for a headless turn
 * that was given an echo, push it to any live view as well (#471).
 *
 * Every tee in this module goes through here, so the two cannot drift: a headless
 * turn's live view sees exactly what its log records, in the order the log records
 * it. The echo is strictly additive — a renderer turn takes the tee it always took,
 * and a headless turn with no echo still writes everything it always wrote.
 */
function teeEntry(
  deps: PromptTurnDeps,
  delivery: PromptTurnDelivery,
  threadId: string,
  entry: TranscriptEntry,
): void {
  if (delivery.kind === 'headless' && delivery.echo) {
    delivery.echo(threadId, entry)
    return
  }
  deps.bridge.tee(threadId, entry)
}

/** The Routine marker to stamp on the teed prompt — never set for a renderer turn. */
function routineRefOf(delivery: PromptTurnDelivery): TranscriptRoutineRef | undefined {
  return delivery.kind === 'headless' ? delivery.routine : undefined
}

/** Bump `lastActiveAt`, fire-and-forget: a persist failure logs and gates nothing. */
function touchThread(deps: PromptTurnDeps, threadId: string): void {
  void deps.store.touchThread(threadId).catch((err) => {
    console.error(
      `[vibe-mistro:metadata] touchThread failed (${threadId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  })
}
