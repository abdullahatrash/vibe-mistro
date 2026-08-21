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
 */

/** The reserved prefix. Everything after it is a uuid. */
export const MISTRO_BOT_PROFILE_PREFIX = 'mistro-bot-'

/**
 * Exactly `mistro-bot-` + a canonical lowercase uuid. Deliberately strict: a
 * near-miss (uppercase, a truncated uuid, a nested path) is treated as foreign
 * rather than as one of ours, so the failure direction is always "leave it alone".
 */
const MISTRO_BOT_PROFILE_ID =
  /^mistro-bot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

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
