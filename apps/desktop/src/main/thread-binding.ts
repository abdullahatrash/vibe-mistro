import type { ThreadAgentControls, ThreadInfo } from '../shared/ipc'
import { WorkspaceAgentError } from './workspace-agent'
import type { ThreadRecord } from './persistence/metadata-store'

/**
 * Project a `session/new` / `session/load` `ThreadInfo` onto its agent-controls
 * bundle (#70) — the per-Thread Mode/Model/Reasoning-effort the renderer sources
 * its picker from. Each axis stays null when the agent advertises none.
 */
export function controlsOf(thread: ThreadInfo): ThreadAgentControls {
  return { modes: thread.modes, models: thread.models, reasoningEffort: thread.reasoningEffort }
}

/**
 * The minimal agent surface for binding: open a new ACP session (`session/new`).
 * One `vibe-acp` agent can host many sessions, so each call mints a distinct one —
 * letting several Threads coexist under a single Workspace agent (ADR-0005).
 */
export interface SessionOpener {
  openThread(): Promise<ThreadInfo>
}

/**
 * The fuller agent surface needed to bind a REOPENED Thread (TB4 #33): besides
 * minting a fresh session, the binder must report whether it already hosts a given
 * session (`hasSession`), resume one it doesn't (`loadThread` -> `session/load`),
 * and expose whether resume is even advertised (`loadSessionAvailable`). `WorkspaceAgent`
 * satisfies this; tests inject a fake.
 */
export interface SessionBinder extends SessionOpener {
  /** Whether this agent currently hosts (opened or loaded) the given session. */
  hasSession(sessionId: string): boolean
  /** Resume a prior session via `session/load`; rejects (typed) on a load failure. */
  loadThread(sessionId: string): Promise<ThreadInfo>
  /** Whether the agent advertised `loadSession` (gates the resume path). */
  readonly loadSessionAvailable: boolean
}

/**
 * The minimal store surface for binding: re-target a Thread by id (upsert), plus
 * the two reads/writes the RESERVATION needs (#417) — `snapshot` to tell a row this
 * bind created from one that was already there, and `deleteThread` to roll a
 * reservation back when the mint it was reserved for fails.
 */
export interface ThreadBindStore {
  upsertThread(input: {
    id: string
    workspaceId: string
    sessionId?: string
  }): Promise<ThreadRecord>
  snapshot(): { threads: ThreadRecord[] }
  deleteThread(id: string): Promise<void>
}

/** The seed needed to connect to a CONTINUED (already-persisted) Thread (TB4 #33). */
export interface ContinueTarget {
  threadId: string
  workspaceId: string
  /** The stored ACP session cursor to resume on first prompt (null = a fresh draft). */
  sessionId: string | null
  title: string | null
}

/** The minimal store surface for resolving a continue target: read the index. */
export interface ContinueLookupStore {
  snapshot(): { threads: ThreadRecord[] }
}

/**
 * Resolve the persisted Thread to seed a continue-start connection (TB4 #33) — the
 * cold-launch "Continue" path spawns the agent but opens NO new Thread, so it
 * READS (never writes) the existing record's ids + stored session cursor. Returns
 * `null` when the record can't be found, so the caller falls back to opening a
 * fresh Thread (degraded / no store) and connect never wedges.
 */
export function resolveContinueTarget(
  store: ContinueLookupStore,
  threadId: string,
): ContinueTarget | null {
  const record = store.snapshot().threads.find((t) => t.id === threadId)
  if (!record) return null
  return {
    threadId: record.id,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    title: record.title,
  }
}

export interface BoundSession {
  /** The ACP session this Thread is now bound to. */
  sessionId: string
  /** True when THIS call minted a session (`session/new` ran) — a draft OR a re-bind. */
  minted: boolean
  /** The title `session/new` returned, when binding (null on reuse/resume). */
  title: string | null
  /** True when a prior session was resumed via `session/load` (case ii success). */
  resumed: boolean
  /**
   * True when a resume FAILED and we re-bound the SAME Thread to a fresh
   * `session/new` (case ii -> fail). The caller tees the "context reset" notice
   * and re-emits `thread:bound` with the NEW sessionId; `minted` is also true.
   */
  rebound: boolean
  /**
   * The bound session's agent-controls (#70), so the renderer's `thread:bound`
   * handler can seed THIS Thread's picker with its OWN Mode/Model/effort. Carried
   * from the fresh `session/new` (mint/re-bind) or `session/load` (resume) result;
   * null on a plain reuse of an already-hosted session (case iii — no fresh result).
   */
  controls: ThreadAgentControls | null
}

/**
 * Ensure a Thread has a usable ACP session before prompting (ADR-0005; TB5 #34,
 * TB4 #33). Three cases, distinguished here:
 *
 *  (i)   DRAFT (`sessionId === null`): exactly ONE `session/new`, bound onto the
 *        SAME Thread id (`upsertThread` by id, preserving `createdAt`) — `minted`.
 *  (ii)  REOPENED (stored `sessionId`, NOT hosted by this freshly-spawned agent):
 *        `session/load` to resume the agent's context (gated on `loadSessionAvailable`).
 *        On success the turn proceeds on the SAME session (`resumed`). On a resume
 *        FAILURE (or when resume isn't advertised) we RE-BIND a fresh `session/new`
 *        under the same Thread id and update the stored cursor (`rebound` + `minted`),
 *        keeping the visible JSONL history attached. A `-32000` auth expiry is NOT a
 *        resume failure — it propagates so the caller routes to sign-in.
 *  (iii) ALREADY HOSTED (the agent already opened/loaded this session this run):
 *        reuse it, NO `session/load` and NO `session/new`.
 *
 * This is the fix for the reopened-Thread bug: before TB4, case (ii) returned the
 * stored sessionId untouched, so `agent.prompt` threw `No open Thread` because the
 * fresh agent's session map was empty (it never resumed the session).
 *
 * `preopened` (ADR-0012) is the Workspace's unconsumed PRIMARY session — opened
 * eagerly at connect. When a draft (case i) has one, the first prompt BINDS to it
 * instead of minting a second `session/new` (the eager session IS this Thread's
 * session). Only case (i) reads it; the caller passes it only for a draft and only
 * once (it claims it via `consumePrimarySession`).
 */
export async function ensureBoundSession(args: {
  agent: SessionBinder
  store: ThreadBindStore
  threadId: string
  workspaceId: string
  sessionId: string | null
  preopened?: ThreadInfo
}): Promise<BoundSession> {
  // (i) draft: bind the Workspace's unconsumed primary session if one was opened at
  // connect (ADR-0012 — no second session/new), else mint a fresh one. Either way
  // the session is bound onto THIS Thread id.
  if (!args.sessionId) {
    return args.preopened ? bindThread(args, args.preopened) : mintAndBind(args)
  }

  // (iii) already hosted this run: reuse with no load/new — no fresh result, so no
  // controls to hand the renderer (it keeps whatever it already holds for this Thread).
  if (args.agent.hasSession(args.sessionId)) {
    return { sessionId: args.sessionId, minted: false, title: null, resumed: false, rebound: false, controls: null }
  }

  // (ii) reopened: resume via session/load if advertised, else re-bind.
  if (args.agent.loadSessionAvailable) {
    try {
      const resumed = await args.agent.loadThread(args.sessionId)
      return { sessionId: resumed.sessionId, minted: false, title: null, resumed: true, rebound: false, controls: controlsOf(resumed) }
    } catch (err) {
      // A mid-session auth expiry (-32000) isn't a resume failure — let the caller
      // route to sign-in rather than re-binding (which would just fail the same way).
      if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') throw err
      // Any other load rejection (the captured -32602, or anything — fail-safe):
      // fall through to a fresh re-bind, keeping the JSONL history attached.
    }
  }
  return { ...(await mintAndBind(args)), rebound: true }
}

/**
 * Mint a fresh `session/new` and bind it onto the Thread id (draft or re-bind).
 *
 * The `threads` row is RESERVED before the round-trip (#417): `transcript_entries`
 * carries `thread_id ... REFERENCES threads(id)`, and the caller points the
 * transcript bridge at this Thread BEFORE prompting, so every agent event teed
 * while `session/new` is in flight used to hit the foreign key and be dropped —
 * silent loss in the very log the search index and fold snapshots derive from. The
 * reservation writes the id + Workspace with a NULL `session_id`; `bindThread`
 * fills the cursor in when the round-trip returns.
 *
 * A mint that FAILS releases a row it reserved, so a failed first prompt still
 * leaves no residue (the cascade takes any entry teed inside the window with it).
 * A row that was already there — every re-bind (case ii), and a retry after an
 * earlier failure — is left alone. Both halves are best-effort (ADR-0005): a store
 * failure logs and never gates the turn.
 */
async function mintAndBind(args: {
  agent: SessionBinder
  store: ThreadBindStore
  threadId: string
  workspaceId: string
}): Promise<BoundSession> {
  const reserved = await reserveThread(args)
  try {
    return await bindThread(args, await args.agent.openThread())
  } catch (err) {
    if (reserved) await releaseThread(args)
    throw err
  }
}

/**
 * Insert the Thread's row up front so the transcript FK is satisfied for the whole
 * `session/new` window. Returns whether THIS call created it (the only case a
 * failed mint may roll back); false when the row already existed or the write
 * failed — the mint proceeds either way.
 */
async function reserveThread(args: {
  store: ThreadBindStore
  threadId: string
  workspaceId: string
}): Promise<boolean> {
  try {
    if (args.store.snapshot().threads.some((t) => t.id === args.threadId)) return false
    await args.store.upsertThread({ id: args.threadId, workspaceId: args.workspaceId })
    return true
  } catch (err) {
    console.error(
      `[vibe-mistro:metadata] reserveThread failed (${args.threadId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
    return false
  }
}

/** Drop a reserved row (and, by cascade, anything teed into it) after a failed mint. */
async function releaseThread(args: { store: ThreadBindStore; threadId: string }): Promise<void> {
  try {
    await args.store.deleteThread(args.threadId)
  } catch (err) {
    console.error(
      `[vibe-mistro:metadata] releaseThread failed (${args.threadId}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Bind an ALREADY-OPEN session (a fresh `session/new`, or ADR-0012's reused primary
 * session) onto the Thread id: upsert the record by id (preserving `createdAt`) and
 * report the bind as `minted` with the session's reported controls. No agent call —
 * the session/new already ran (at mint or eagerly at connect).
 */
async function bindThread(
  args: { store: ThreadBindStore; threadId: string; workspaceId: string },
  thread: ThreadInfo,
): Promise<BoundSession> {
  await args.store.upsertThread({
    id: args.threadId,
    workspaceId: args.workspaceId,
    sessionId: thread.sessionId,
  })
  return { sessionId: thread.sessionId, minted: true, title: thread.title, resumed: false, rebound: false, controls: controlsOf(thread) }
}
