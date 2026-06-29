import type { ThreadInfo } from '../shared/ipc'
import { WorkspaceAgentError } from './workspace-agent'
import type { ThreadRecord } from './persistence/metadata-store'

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

/** The minimal store surface for binding: re-target a Thread by id (upsert). */
export interface ThreadBindStore {
  upsertThread(input: {
    id: string
    workspaceId: string
    sessionId: string
  }): Promise<ThreadRecord>
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
 */
export async function ensureBoundSession(args: {
  agent: SessionBinder
  store: ThreadBindStore
  threadId: string
  workspaceId: string
  sessionId: string | null
}): Promise<BoundSession> {
  // (i) draft: mint a fresh session and bind it.
  if (!args.sessionId) return mintAndBind(args)

  // (iii) already hosted this run: reuse with no load/new.
  if (args.agent.hasSession(args.sessionId)) {
    return { sessionId: args.sessionId, minted: false, title: null, resumed: false, rebound: false }
  }

  // (ii) reopened: resume via session/load if advertised, else re-bind.
  if (args.agent.loadSessionAvailable) {
    try {
      const resumed = await args.agent.loadThread(args.sessionId)
      return { sessionId: resumed.sessionId, minted: false, title: null, resumed: true, rebound: false }
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

/** Mint a fresh `session/new` and bind it onto the Thread id (draft or re-bind). */
async function mintAndBind(args: {
  agent: SessionBinder
  store: ThreadBindStore
  threadId: string
  workspaceId: string
}): Promise<BoundSession> {
  const thread = await args.agent.openThread()
  await args.store.upsertThread({
    id: args.threadId,
    workspaceId: args.workspaceId,
    sessionId: thread.sessionId,
  })
  return { sessionId: thread.sessionId, minted: true, title: thread.title, resumed: false, rebound: false }
}
