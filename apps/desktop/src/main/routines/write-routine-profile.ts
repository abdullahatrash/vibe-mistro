import { join } from 'node:path'
import { isMistroBotProfileId } from '../../shared/bot-profile-id'
import type { VibeProfileDirs } from '../bots/profile-dirs'
import {
  confirmRoutineGate,
  describeGateProblems,
  gateProblems,
  validateRoutineProfileFile,
} from './confirm-routine-gate'
import { projectRoutineProfile, type RoutineProfileSource } from './routine-profile'

/**
 * Put a Bot's routine gate on disk and PROVE it is there (#469, ADR-0028 part 4).
 *
 * The only thing in the Routines feature that touches the filesystem, and — like
 * the Bot profile writer it is modelled on — it does so through an INJECTED seam,
 * so no test ever writes into the real `~/.vibe/`.
 *
 * Four steps, and the fourth is the one the slice is about:
 *
 * 1. **Ours only.** A Bot profile id that is not `mistro-bot-<uuid>` is foreign;
 *    nothing is derived from it and nothing is written.
 * 2. **Validate the projection** — refuse our own typo before it reaches disk.
 * 3. **Write it**, `mkdir -p` first (Vibe creates `agents/` for nobody).
 * 4. **Read it back and confirm the gate.** Not a paranoid flourish: a profile key
 *    Vibe does not recognise is ignored in silence, so "the write returned" is
 *    evidence of nothing at all. This is the step that lets the caller refuse to
 *    run rather than run and hope.
 *
 * Called before EVERY routine run rather than once at Bot-creation time. It costs
 * one small write and one read, it heals a file deleted or edited by hand, and it
 * means the confirmation is about the file that is there NOW instead of about a
 * write that happened three weeks ago. Rewriting cannot disturb a live session:
 * Vibe resolves a session's profile when the session opens (acp-capture §14.6).
 */

/** The fs operations this needs. Injected — `node-routine-profile-fs.ts` is the real one. */
export interface RoutineProfileFs {
  /** Recursive `mkdir -p`. */
  mkdir(dir: string): Promise<void>
  /** Write (or overwrite) a UTF-8 text file. */
  writeFile(path: string, contents: string): Promise<void>
  /** Read a UTF-8 text file. Must reject when it is absent. */
  readFile(path: string): Promise<string>
}

export interface EnsureRoutineGateArgs {
  source: RoutineProfileSource
  dirs: VibeProfileDirs
  fs: RoutineProfileFs
}

/**
 * `refused` = a Bot profile id we do not own; `invalid` = the gate we rendered or
 * read back is not the gate (the silent-ignore case); `io` = it could not be
 * written or read. All three refuse the run, and all three carry the reason —
 * ADR-0028 is explicit that a routine which cannot confirm its gate must say why.
 */
export type RoutineGateResult =
  | { ok: true; profileId: string }
  | { ok: false; reason: 'refused' | 'invalid' | 'io'; problems: string[] }

export async function ensureRoutineGate(args: EnsureRoutineGateArgs): Promise<RoutineGateResult> {
  const { source, dirs, fs } = args

  if (!isMistroBotProfileId(source.botProfileId)) {
    const message = `refusing to derive a routine profile from a Bot we do not own: ${source.botProfileId}`
    console.error(`[vibe-mistro:routines] ${message}`)
    return { ok: false, reason: 'refused', problems: [message] }
  }

  const file = projectRoutineProfile(source)
  if (!file) {
    // Unreachable while the ownership check above holds; kept because the
    // projection's null is a real branch and silently `!`-ing it away is how a
    // gate stops existing.
    return { ok: false, reason: 'refused', problems: [`No routine profile for ${source.botProfileId}.`] }
  }

  const rendered = gateProblems(validateRoutineProfileFile(file))
  if (rendered.length) {
    const described = describeGateProblems(rendered)
    console.error(`[vibe-mistro:routines] refusing to write ${file.agentFileName}: ${described.join('; ')}`)
    return { ok: false, reason: 'invalid', problems: described }
  }

  const path = join(dirs.agentsDir, file.agentFileName)
  let readBack: string
  try {
    await fs.mkdir(dirs.agentsDir)
    await fs.writeFile(path, file.agentToml)
    readBack = await fs.readFile(path)
  } catch (err) {
    const message = `Could not write the routine's permission gate: ${String(err)}`
    console.error(`[vibe-mistro:routines] ${message}`)
    return { ok: false, reason: 'io', problems: [message] }
  }

  const confirmed = gateProblems(
    confirmRoutineGate(readBack, { profileId: file.profileId, botProfileId: file.botProfileId }),
  )
  if (confirmed.length) {
    const described = describeGateProblems(confirmed)
    console.error(`[vibe-mistro:routines] ${file.agentFileName} is not gated: ${described.join('; ')}`)
    return { ok: false, reason: 'invalid', problems: described }
  }

  return { ok: true, profileId: file.profileId }
}
