import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  IPC,
  type BotProfileStatus,
  type BotsCreateArgs,
  type BotsDeleteArgs,
  type BotsDeleteResult,
  type BotsListResult,
  type BotsProfileStatusArgs,
  type BotsRebuildProfileArgs,
  type BotsStartOverArgs,
  type BotsStartOverResult,
  type BotsUpdateArgs,
  type BotWriteResult,
} from '../../shared/ipc'
import { mintBotProfileId } from '../../shared/bot-profile-id'
import type { ModeDiscovery } from '../acp/agent-controls'
import type { BotStoreApi } from '../persistence/bot-store-api'
import { getShellEnv } from '../shell-env'
import { assessBotProfile } from './assess-bot-profile'
import {
  createBot,
  deleteBot,
  listBots,
  rebuildBotProfile,
  updateBot,
  type BotLifecycleDeps,
} from './bot-lifecycle'
import { startOverBot, type StartOverThreads } from './start-over'
import { vibeProfileDirs } from './profile-dirs'
import { nodeProfileFs } from './node-profile-fs'
import { removeBotProfile, writeBotProfile, type BotProfileFs } from './write-bot-profile'

/**
 * The Bot CRUD handlers (#445, ADR-0027), registered beside their modules like
 * the git / files / skills registrars. Thin wrappers: every decision lives in
 * `bot-lifecycle.ts` and the pure modules under it.
 *
 * The shell env supplies `VIBE_HOME` — the same resolution the spawned agent
 * sees, so the profiles land where Vibe will look for them.
 */

/**
 * What the Bot LIFECYCLE needs — no agent, so main's Workspace/Thread cleanup
 * paths can build the same profile-file seam without one.
 */
export interface BotsIpcDeps {
  bots: BotStoreApi
  /**
   * The Thread half: a Bot's conversation is an ordinary Thread record. "Start
   * over" (#447) reaches one step further — it clears the session cursor — so the
   * store passed here has to serve both.
   */
  threads: BotLifecycleDeps['threads'] & StartOverThreads
  /** Overridable for tests; production uses the real `node:fs` binding. */
  fs?: BotProfileFs
}

/**
 * What REGISTERING the handlers additionally needs. `discoverModes` is required
 * rather than optional on purpose (#448): it is the only evidence the loud-failure
 * check has, so wiring that could be forgotten would turn the whole feature into a
 * permanent `unknown` — the app failing silently about failing silently. A missing
 * source must be a type error at the call site, not a shrug at runtime.
 */
export interface BotsRegistrarDeps extends BotsIpcDeps {
  /**
   * The Workspace agent's latest agent-profile registry reading, by `agentId` —
   * the wire evidence the open-path persona check diffs against. Injected because
   * the pool lives in `index.ts`; it awaits the Workspace's eager primary session
   * (ADR-0012) so a Bot opened the instant its Project connects gets a real answer
   * rather than a shrug. Null when the agent is gone or never opened a session —
   * the one legitimate "nothing to report".
   */
  discoverModes: (agentId: string) => Promise<ModeDiscovery | null>
  /**
   * Whether a turn is in flight on a Thread — main's `thread-status` registry,
   * injected because it lives in `index.ts` beside the pool. Guards "Start over"
   * (#447): retiring a session under a running turn would strand it.
   */
  isStreaming: (threadId: string) => boolean
  /**
   * Best-effort close of a Thread's live ACP session on the warm agent hosting it
   * (`bestEffortCloseFor` in `index.ts`, which owns the pool). Returns undefined
   * when there is nothing to close. Required for the same reason `discoverModes`
   * is: optional wiring for a feature's only live seam is wiring that gets
   * forgotten.
   */
  closeThreadSession: (threadId: string) => (() => Promise<void>) | undefined
}

/**
 * Assemble the lifecycle deps (also used by main's Workspace/Thread cleanup
 * paths). The dirs are resolved LAZILY, per call: `getShellEnv` probes a login
 * shell on its first use, and registration runs before the first window — a Bot
 * write is never on the launch path, so the probe should not be either.
 */
export function createBotLifecycleDeps(deps: BotsIpcDeps): BotLifecycleDeps {
  const fs = deps.fs ?? nodeProfileFs
  const dirs = () => vibeProfileDirs(getShellEnv(), homedir())
  return {
    bots: deps.bots,
    threads: deps.threads,
    profiles: {
      write: (source) => writeBotProfile({ source, dirs: dirs(), fs }),
      remove: (profileId) => removeBotProfile({ profileId, dirs: dirs(), fs }),
    },
    mintProfileId: () => mintBotProfileId(randomUUID()),
  }
}

export function registerBotsIpc(deps: BotsRegistrarDeps): void {
  const lifecycle = createBotLifecycleDeps(deps)

  ipcMain.handle(IPC.botsList, (): BotsListResult => ({ bots: listBots(lifecycle) }))

  ipcMain.handle(
    IPC.botsCreate,
    (_event, args: BotsCreateArgs): Promise<BotWriteResult> => createBot(lifecycle, args),
  )

  ipcMain.handle(
    IPC.botsUpdate,
    (_event, args: BotsUpdateArgs): Promise<BotWriteResult> => updateBot(lifecycle, args),
  )

  ipcMain.handle(
    IPC.botsDelete,
    (_event, args: BotsDeleteArgs): Promise<BotsDeleteResult> => deleteBot(lifecycle, args),
  )

  // "Start over" (#447): retire the session and keep everything else. The decision
  // (and every refusal) is `start-over.ts`; this only resolves the live seams.
  ipcMain.handle(
    IPC.botsStartOver,
    (_event, args: BotsStartOverArgs): Promise<BotsStartOverResult> =>
      startOverBot(
        {
          bots: deps.bots,
          threads: deps.threads,
          isStreaming: deps.isStreaming,
          // Resolved per call: which agent hosts the session (and whether one does
          // at all) is live state, so it can only be read when the user asks.
          closeSession: deps.closeThreadSession(args.threadId),
        },
        args,
      ),
  )

  // The OPEN-path persona check (#448). Slice 2 decides the same question on a
  // bind, but a bind needs a prompt — and ADR-0027's "failure is loud" means the
  // user is told when the Bot OPENS, before typing into what looks like their
  // teammate. Thin by design: the answer is `assessBotProfile`'s.
  ipcMain.handle(
    IPC.botsProfileStatus,
    async (_event, args: BotsProfileStatusArgs): Promise<BotProfileStatus> => {
      const bot = deps.bots.get(args.threadId)
      if (!bot) return { kind: 'unknown' } // an ordinary Thread, or a deleted Bot
      const discovery = await deps.discoverModes(args.agentId)
      const status = assessBotProfile({
        profileId: bot.profileId,
        profileWrittenAt: bot.updatedAt,
        discovery,
      })
      if (status.kind === 'missing') {
        console.error(
          `[vibe-mistro:bots] ${bot.name} (${args.threadId}): persona ${status.profileId} ` +
            `is not among the agent's modes — ${status.reason}`,
        )
      }
      return status
    },
  )

  ipcMain.handle(
    IPC.botsRebuildProfile,
    (_event, args: BotsRebuildProfileArgs): Promise<BotWriteResult> =>
      rebuildBotProfile(lifecycle, args),
  )
}
