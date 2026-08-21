import type {
  BotRecord,
  BotsCreateArgs,
  BotsDeleteArgs,
  BotsDeleteResult,
  BotsUpdateArgs,
  BotWriteResult,
} from '../../shared/ipc'
import type { BotStoreApi } from '../persistence/bot-store-api'
import type { BotProfileSource } from './bot-profile'
import type { WriteBotProfileResult } from './write-bot-profile'
import { collectProblems, describeProblems, validateBotProfileSource } from './validate-bot-profile'

/**
 * Create / edit / delete a Mistro Bot (#445, ADR-0027) — the orchestration the
 * `bots:*` handlers are thin wrappers around, with every dependency injected so
 * the whole lifecycle is testable without Electron, SQLite or a home directory.
 *
 * The invariant these three functions exist to hold: **the record and the
 * profile files never disagree.** So the order is always
 * *validate -> write the files -> persist the record*, and a failure at any step
 * leaves nothing behind that would show up as a Bot with no persona (the one
 * failure ADR-0027 says must never be silent).
 *
 * Best-effort per ADR-0005/0019: every step is guarded and every outcome is a
 * typed result. Nothing here rejects into the live flow.
 */

/** The Thread operations a Bot needs. A subset of `MetadataStoreApi`. */
export interface BotLifecycleThreads {
  /** Mint the Bot's durable Thread. A Bot IS one continuing Thread (ADR-0027). */
  upsertThread(input: { workspaceId: string }): Promise<{ id: string }>
  /** Archive the conversation when the Bot is deleted — the history survives. */
  setThreadFlags(id: string, flags: { pinned?: boolean; archived?: boolean }): Promise<void>
}

/** The profile-file operations, behind the writer's injected fs seam. */
export interface BotLifecycleProfiles {
  write(source: BotProfileSource): Promise<WriteBotProfileResult>
  remove(profileId: string): Promise<boolean>
}

export interface BotLifecycleDeps {
  bots: BotStoreApi
  threads: BotLifecycleThreads
  profiles: BotLifecycleProfiles
  /** Mint the immutable `mistro-bot-<uuid>` — injected so tests are deterministic. */
  mintProfileId: () => string
}

/**
 * Create a Bot: mint its profile id and its Thread, project + write the profile
 * files, insert the record.
 *
 * The profile id is minted HERE and never again — a rename rewrites
 * `display_name` in the same file, because the live session has this id selected
 * as its mode.
 */
export async function createBot(
  deps: BotLifecycleDeps,
  args: BotsCreateArgs,
): Promise<BotWriteResult> {
  const source: BotProfileSource = {
    profileId: deps.mintProfileId(),
    name: args.name ?? '',
    description: args.description ?? '',
    instructions: args.instructions ?? '',
  }

  // 1. Refuse a record that would produce a dud profile BEFORE anything is
  //    minted or written — Vibe would accept it and silently ignore it (#424).
  const invalid = describeProblems(collectProblems(validateBotProfileSource(source)))
  if (invalid.length) return { ok: false, reason: 'invalid', problems: invalid }
  if (!args.workspaceId) {
    return { ok: false, reason: 'invalid', problems: ['workspaceId: a Bot needs a Project.'] }
  }

  // 2. The files first, so a write failure leaves NOTHING persisted.
  const written = await deps.profiles.write(source)
  if (!written.ok) return { ok: false, reason: profileFailureReason(written), problems: written.problems }

  // 3. The Thread, then the record. From here on a failure has to clean up the
  //    files it already wrote, or they would linger as a mode with no Bot.
  let threadId: string
  try {
    threadId = (await deps.threads.upsertThread({ workspaceId: args.workspaceId })).id
  } catch (err) {
    console.error('[vibe-mistro:bots] could not create the Bot Thread:', err)
    await removeQuietly(deps, source.profileId)
    return { ok: false, reason: 'io', problems: [`Could not create the Bot's conversation: ${String(err)}`] }
  }

  const record = deps.bots.insert({
    threadId,
    workspaceId: args.workspaceId,
    profileId: source.profileId,
    name: source.name.trim(),
    colour: args.colour,
    description: source.description.trim(),
    instructions: source.instructions,
  })
  if (!record) {
    await removeQuietly(deps, source.profileId)
    return { ok: false, reason: 'io', problems: ['Could not save the Bot.'] }
  }
  return { ok: true, bot: record }
}

/**
 * Edit a Bot in place: rewrite the profile files from the merged record, then
 * persist. `profileId` is carried over untouched — it is the mode id the live
 * session selected, so changing it would strip the persona from a running Bot.
 */
export async function updateBot(
  deps: BotLifecycleDeps,
  args: BotsUpdateArgs,
): Promise<BotWriteResult> {
  const existing = deps.bots.get(args.threadId)
  if (!existing) return { ok: false, reason: 'notFound', problems: ['No such Bot.'] }

  const source: BotProfileSource = {
    profileId: existing.profileId, // immutable — see ADR-0027
    name: args.name ?? existing.name,
    description: args.description ?? existing.description,
    instructions: args.instructions ?? existing.instructions,
  }
  const invalid = describeProblems(collectProblems(validateBotProfileSource(source)))
  if (invalid.length) return { ok: false, reason: 'invalid', problems: invalid }

  // Files first again: if the rewrite fails the record still describes what is
  // actually on disk, so the Bot keeps the persona it had rather than claiming
  // a new one it never got.
  const written = await deps.profiles.write(source)
  if (!written.ok) return { ok: false, reason: profileFailureReason(written), problems: written.problems }

  const record = deps.bots.update(args.threadId, {
    name: source.name.trim(),
    ...(args.colour === undefined ? {} : { colour: args.colour }),
    description: source.description.trim(),
    instructions: source.instructions,
  })
  if (!record) return { ok: false, reason: 'io', problems: ['Could not save the Bot.'] }
  return { ok: true, bot: record }
}

/**
 * Delete a Bot: drop the record, destroy the two profile files, and ARCHIVE the
 * Thread. Destruction is honest but bounded (ADR-0027) — the identity goes, the
 * conversation stays as an archived Thread, because weeks of history is
 * irreplaceable and a deleted teammate is not.
 */
export async function deleteBot(
  deps: BotLifecycleDeps,
  args: BotsDeleteArgs,
): Promise<BotsDeleteResult> {
  const existing = deps.bots.get(args.threadId)
  if (!existing) return { ok: false }

  const removed = deps.bots.delete(args.threadId)
  // The files come down even if the row didn't, so a half-failed delete can
  // never leave a profile that keeps appearing as a mode for a Bot that is gone.
  await removeQuietly(deps, existing.profileId)
  try {
    await deps.threads.setThreadFlags(args.threadId, { archived: true })
  } catch (err) {
    console.error('[vibe-mistro:bots] could not archive the deleted Bot Thread:', err)
  }
  return { ok: removed }
}

/** Every Bot, for `bots:list`. */
export function listBots(deps: Pick<BotLifecycleDeps, 'bots'>): BotRecord[] {
  return deps.bots.list()
}

/** Best-effort profile-file removal used by the failure paths — never throws. */
async function removeQuietly(deps: BotLifecycleDeps, profileId: string): Promise<void> {
  try {
    await deps.profiles.remove(profileId)
  } catch (err) {
    console.error(`[vibe-mistro:bots] could not clean up ${profileId}:`, err)
  }
}

/** A refused (foreign id) or invalid write is a validation failure to the caller. */
function profileFailureReason(result: Extract<WriteBotProfileResult, { ok: false }>): 'invalid' | 'io' {
  return result.reason === 'io' ? 'io' : 'invalid'
}
