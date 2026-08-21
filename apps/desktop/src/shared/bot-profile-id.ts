/**
 * The Mistro Bot profile id (#445, ADR-0027) — the one thing that makes a
 * generated Vibe agent profile mechanically OURS.
 *
 * A profile id is `mistro-bot-<uuid>`:
 *
 * - **Generated once and immutable.** It becomes the file stem of both
 *   `~/.vibe/agents/<id>.toml` and `~/.vibe/prompts/<id>.md`, AND the mode id a
 *   live session has selected — so a rename must never touch it.
 * - **Prefixed, so it can never shadow a builtin.** Vibe's registry lets a
 *   custom profile whose stem equals a builtin name OVERRIDE that builtin
 *   (`docs/acp-capture.md` §14.7); `mistro-bot-<uuid>` cannot collide with
 *   `ask` / `plan` / `accept-edits` / `auto-approve` / `explore` / `lean`, nor
 *   with anything a human would plausibly hand-write.
 * - **The whole ownership test.** A profile whose id does not match this shape
 *   is FOREIGN — a hand-written profile the user owns — and we never read,
 *   rewrite or delete it. The prefix + uuid shape is a mechanical check, not a
 *   heuristic, so there is nothing to get wrong at the boundary.
 *
 * It lives in `shared/` (Node- and DOM-free, like `thread-control-intent.ts`)
 * because BOTH sides ask the ownership question: main gates every profile-file
 * read, write and delete on it, and the renderer uses it to keep Bot profiles out
 * of ordinary Threads' Mode pickers (#448). One regex, two consumers — a second
 * copy in the renderer is exactly the drift this shape exists to prevent.
 */

/** The reserved prefix. Everything after it is a uuid. */
export const MISTRO_BOT_PROFILE_PREFIX = 'mistro-bot-'

/**
 * The prefix of a Bot's SECOND profile — the routine-only gate (#469, ADR-0028
 * part 4).
 *
 * A Bot has two generated profiles that share one uuid: `mistro-bot-<uuid>` is
 * its persona, worn whenever a person is talking to it, and
 * `mistro-routine-<uuid>` is that same persona with the permission gate bolted
 * on, worn ONLY by a scheduled turn. They are two files rather than one rewritten
 * file on purpose: a Bot must not become read-only when you talk to it, and a
 * rewrite would leave a window where a crash strands the wrong posture.
 *
 * Sharing the uuid means the routine profile is derivable from the Bot's id
 * (`routineProfileIdFor`) and never has to be stored, and it keeps the pair
 * adjacent in `~/.vibe/agents/` for anyone reading the directory by hand.
 */
export const MISTRO_ROUTINE_PROFILE_PREFIX = 'mistro-routine-'

/**
 * Exactly `mistro-bot-` + a canonical lowercase uuid. Deliberately strict: a
 * near-miss (uppercase, a truncated uuid, a nested path) is treated as foreign
 * rather than as one of ours, so the failure direction is always "leave it alone".
 */
const MISTRO_BOT_PROFILE_ID =
  /^mistro-bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The same shape for the routine-only gate profile. Equally strict, same reason. */
const MISTRO_ROUTINE_PROFILE_ID =
  /^mistro-routine-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Mint a profile id from a freshly generated uuid (`randomUUID()`). */
export function mintBotProfileId(uuid: string): string {
  return `${MISTRO_BOT_PROFILE_PREFIX}${uuid.toLowerCase()}`
}

/**
 * Whether this profile id is one WE generated — the gate every read, write and
 * delete of a profile file passes through. False for every hand-written profile,
 * every builtin, and every malformed id.
 */
export function isMistroBotProfileId(profileId: string): boolean {
  return MISTRO_BOT_PROFILE_ID.test(profileId)
}

/** Whether this id names a Bot's routine-only gate profile (#469). */
export function isMistroRoutineProfileId(profileId: string): boolean {
  return MISTRO_ROUTINE_PROFILE_ID.test(profileId)
}

/**
 * Whether this id is one WE generated at all — a Bot's persona OR its routine
 * gate. The question every consumer that asks "is this profile ours?" for
 * PRESENTATION should ask: both are published over ACP as selectable modes, so a
 * filter that knows only about personas would leak the gate profile into every
 * ordinary Thread's Mode picker.
 *
 * The file-ownership gates deliberately do NOT use this: each writer refuses
 * anything that is not the exact shape it owns, so a Bot writer can never touch a
 * routine profile and vice versa.
 */
export function isMistroProfileId(profileId: string): boolean {
  return isMistroBotProfileId(profileId) || isMistroRoutineProfileId(profileId)
}

/**
 * The routine-gate profile id that belongs with this Bot profile id, or null when
 * the argument is not one of ours.
 *
 * Derived, never stored: the pair shares a uuid, so there is no second id to keep
 * in sync and no way for the record to name a gate that belongs to another Bot.
 */
export function routineProfileIdFor(botProfileId: string): string | null {
  if (!isMistroBotProfileId(botProfileId)) return null
  return `${MISTRO_ROUTINE_PROFILE_PREFIX}${botProfileId.slice(MISTRO_BOT_PROFILE_PREFIX.length)}`
}
