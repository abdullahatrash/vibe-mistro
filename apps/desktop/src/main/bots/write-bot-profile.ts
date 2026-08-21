import { join } from 'node:path'
import { projectBotProfile, type BotProfileSource } from './bot-profile'
import { isMistroBotProfileId } from '../../shared/bot-profile-id'
import type { VibeProfileDirs } from './profile-dirs'
import {
  collectProblems,
  describeProblems,
  validateBotProfile,
  type BotProfileProblem,
} from './validate-bot-profile'

/**
 * The only thing in the Bots feature that touches disk (#445, ADR-0027) — and it
 * does so through an INJECTED seam, so no test ever writes into the real
 * `~/.vibe/`. Everything it decides is decided by the pure modules beside it:
 * `projectBotProfile` renders, `validateBotProfile` refuses, this writes.
 *
 * Three rules it enforces, in order:
 *
 * 1. **Ours only.** A profile id that is not `mistro-bot-<uuid>` is FOREIGN —
 *    a profile the user hand-wrote — and is never written, rewritten or deleted.
 * 2. **Validate first.** Vibe silently ignores what it does not understand, so a
 *    record that would produce a dud profile never reaches disk at all.
 * 3. **`mkdir -p` both dirs.** Vibe creates neither `agents/` nor `prompts/`
 *    (verified, §14.3) — a first-run write into a machine that has never had a
 *    custom profile must create them.
 *
 * The prompt `.md` is written BEFORE the TOML: `system_prompt_id` naming a
 * missing `.md` makes Vibe drop the whole profile, so the ordering means a
 * half-failed write leaves an orphan prompt (harmless, invisible) rather than a
 * profile that appears in every Mode picker and cannot load.
 */

/** The fs operations the writer needs. Injected — `node-profile-fs.ts` is the real one. */
export interface BotProfileFs {
  /** Recursive `mkdir -p`. */
  mkdir(dir: string): Promise<void>
  /** Write (or overwrite) a UTF-8 text file. */
  writeFile(path: string, contents: string): Promise<void>
  /** Delete a file. Must resolve when it was already absent. */
  rm(path: string): Promise<void>
}

export interface WriteBotProfileArgs {
  source: BotProfileSource
  dirs: VibeProfileDirs
  fs: BotProfileFs
}

/**
 * `refused` = a foreign profile id we will not touch; `invalid` = the record
 * would produce a profile Vibe silently ignores; `io` = the files could not be
 * written. All three are LOUD (ADR-0027: a broken persona is never silent).
 */
export type WriteBotProfileResult =
  | { ok: true; profileId: string }
  | { ok: false; reason: 'refused' | 'invalid' | 'io'; problems: string[] }

export async function writeBotProfile(args: WriteBotProfileArgs): Promise<WriteBotProfileResult> {
  const { source, dirs, fs } = args

  if (!isMistroBotProfileId(source.profileId)) {
    // Rule 1, checked before anything else so a foreign id can't even be rendered.
    const message = `refusing to write a profile we do not own: ${source.profileId}`
    console.error(`[vibe-mistro:bots] ${message}`)
    return { ok: false, reason: 'refused', problems: [message] }
  }

  const files = projectBotProfile(source)
  const problems: BotProfileProblem[] = collectProblems(validateBotProfile(source, files))
  if (problems.length) {
    const described = describeProblems(problems)
    console.error(
      `[vibe-mistro:bots] refusing to write ${files.agentFileName}: ${described.join('; ')}`,
    )
    return { ok: false, reason: 'invalid', problems: described }
  }

  try {
    await fs.mkdir(dirs.promptsDir)
    await fs.mkdir(dirs.agentsDir)
    await fs.writeFile(join(dirs.promptsDir, files.promptFileName), files.promptMarkdown)
    await fs.writeFile(join(dirs.agentsDir, files.agentFileName), files.agentToml)
  } catch (err) {
    console.error(`[vibe-mistro:bots] failed to write ${files.agentFileName}: ${String(err)}`)
    return { ok: false, reason: 'io', problems: [`Could not write the Bot's profile: ${String(err)}`] }
  }

  return { ok: true, profileId: files.profileId }
}

export interface RemoveBotProfileArgs {
  profileId: string
  dirs: VibeProfileDirs
  fs: BotProfileFs
}

/**
 * Destroy a Bot's two generated files. Refuses a foreign id outright — the whole
 * point of the `mistro-bot-` prefix is that this can never reach a profile the
 * user wrote. Best-effort otherwise: the TOML is removed FIRST so a half-failed
 * delete leaves an orphan prompt rather than a mode with no persona, and each
 * removal is attempted independently.
 */
export async function removeBotProfile(args: RemoveBotProfileArgs): Promise<boolean> {
  const { profileId, dirs, fs } = args
  if (!isMistroBotProfileId(profileId)) {
    console.error(`[vibe-mistro:bots] refusing to delete a profile we do not own: ${profileId}`)
    return false
  }
  let ok = true
  for (const path of [
    join(dirs.agentsDir, `${profileId}.toml`),
    join(dirs.promptsDir, `${profileId}.md`),
  ]) {
    try {
      await fs.rm(path)
    } catch (err) {
      // Never fatal — a Bot's record comes down either way; an orphan file is
      // logged so it can be cleaned by hand.
      console.error(`[vibe-mistro:bots] failed to delete ${path}: ${String(err)}`)
      ok = false
    }
  }
  return ok
}
