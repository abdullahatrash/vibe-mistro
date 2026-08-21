import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  IPC,
  type BotsCreateArgs,
  type BotsDeleteArgs,
  type BotsDeleteResult,
  type BotsListResult,
  type BotsStartOverArgs,
  type BotsStartOverResult,
  type BotsUpdateArgs,
  type BotWriteResult,
} from '../../shared/ipc'
import type { BotStoreApi } from '../persistence/bot-store-api'
import { getShellEnv } from '../shell-env'
import { createBot, deleteBot, listBots, updateBot, type BotLifecycleDeps } from './bot-lifecycle'
import { startOverBot, type StartOverThreads } from './start-over'
import { mintBotProfileId } from './profile-id'
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

export interface BotsIpcDeps {
  bots: BotStoreApi
  /** The Thread half: a Bot's conversation is an ordinary Thread record. */
  threads: BotLifecycleDeps['threads'] & StartOverThreads
  /** Overridable for tests; production uses the real `node:fs` binding. */
  fs?: BotProfileFs
  /**
   * Whether a turn is in flight on a Thread — main's `thread-status` registry,
   * injected because it lives in `index.ts` beside the pool. Guards "Start over".
   */
  isStreaming: (threadId: string) => boolean
  /**
   * Best-effort close of a Thread's live ACP session on the warm agent hosting it
   * (`bestEffortCloseFor` in `index.ts`, which owns the pool). Returns undefined
   * when there is nothing to close.
   */
  closeThreadSession: (threadId: string) => (() => Promise<void>) | undefined
}

/**
 * Assemble the lifecycle deps (also used by main's Workspace/Thread cleanup
 * paths). The dirs are resolved LAZILY, per call: `getShellEnv` probes a login
 * shell on its first use, and registration runs before the first window — a Bot
 * write is never on the launch path, so the probe should not be either.
 */
export function createBotLifecycleDeps(
  deps: Pick<BotsIpcDeps, 'bots' | 'threads' | 'fs'>,
): BotLifecycleDeps {
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

export function registerBotsIpc(deps: BotsIpcDeps): void {
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

  ipcMain.handle(
    IPC.botsStartOver,
    (_event, args: BotsStartOverArgs): Promise<BotsStartOverResult> =>
      startOverBot(
        {
          bots: deps.bots,
          threads: deps.threads,
          isStreaming: deps.isStreaming,
          // Resolved per call: the hosting agent (and whether there is one at all)
          // is live state, so it can only be read when the user actually asks.
          closeSession: deps.closeThreadSession(args.threadId),
        },
        args,
      ),
  )
}
