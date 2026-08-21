import type { BotProfileStatus } from '../../shared/ipc'
import type { ModeDiscovery } from '../acp/agent-controls'

/**
 * Is a Mistro Bot's persona still there? (#448, ADR-0027 "failure is loud")
 *
 * This is the OPEN-path half of the persona check. Slice 2 decides the same
 * question on a bind (`select-bot-profile.ts`), but a bind only happens on a
 * prompt — and a Bot whose profile file was hand-deleted must be told on OPEN,
 * before the user has typed anything into what looks like their teammate.
 *
 * The question is answered by DIFFING the expected `profileId` against the mode
 * ids the agent last advertised, never by sending something and reading the
 * error. Vibe drops an unreadable or malformed profile at registry scan with a
 * log line and no wire signal (#424, acp-capture §14.6), so a broken profile and
 * an absent one look identical from here: the absence IS the evidence.
 *
 * The decision is pure so that the genuinely hard part — *when does absence mean
 * broken, and when does it merely mean "not scanned yet"?* — is settled in a unit
 * test rather than against a live binary.
 */

/**
 * Why a profile the agent does not list is absent — ONE wording for both paths.
 *
 * The bind-time check (`select-bot-profile.ts`) and this open-time one answer the
 * same question about the same file, and the notice one raises now also raises the
 * other's banner. Two descriptions of one broken profile would read as two
 * different problems.
 */
export const BOT_PROFILE_ABSENT_REASON =
  'Vibe does not list it as an agent profile — the file under ~/.vibe/agents/ is ' +
  'missing, unreadable, or malformed.'

export interface BotProfileAssessment {
  /** The `mistro-bot-<uuid>` the Bot record names. */
  profileId: string
  /** When the profile files were last written — the record's `updatedAt`. */
  profileWrittenAt: number
  /** The agent's latest registry reading, or null when it has none yet. */
  discovery: ModeDiscovery | null
}

/**
 * Decide what to tell the user about a Bot's persona.
 *
 * Three answers, and the third is the one that keeps the banner honest:
 *
 * - **healthy** — the agent lists the profile as a mode; it will be selected on
 *   the next bind.
 * - **unknown** — we have no reading, or none NEWER than the last write to the
 *   profile files. Creating a Bot on an already-warm agent lands here (the
 *   registry was scanned before the file existed), and so does the instant after
 *   a rebuild. Saying nothing is correct: the next session re-scans, and slice
 *   2's bind-time check is the backstop.
 * - **missing** — the agent scanned AFTER we wrote, and still does not list it.
 *   The file is gone, unreadable, or malformed.
 *
 * Ties (`observedAt === profileWrittenAt`) read as `unknown`: both stamps are
 * coarse epoch-ms and a scan in the same millisecond as the write cannot be
 * ordered, so the failure direction is the quiet one.
 */
export function assessBotProfile(input: BotProfileAssessment): BotProfileStatus {
  const { profileId, profileWrittenAt, discovery } = input
  // An agent that has advertised no modes at all arrives here as a null reading and
  // reads as `unknown` — DELIBERATELY unlike the bind-time check, which calls the
  // same condition `missing`. The asymmetry is what each side holds: a bind has a
  // session result in hand and is about to prompt it, while this may be asking
  // before any session ever reported anything. Both comments point at each other so
  // a later edit to one is not read as a bug against the other.
  if (!discovery) return { kind: 'unknown' }
  if (discovery.observedAt <= profileWrittenAt) return { kind: 'unknown' }
  if (discovery.modeIds.includes(profileId)) return { kind: 'healthy' }
  return { kind: 'missing', profileId, reason: BOT_PROFILE_ABSENT_REASON }
}
