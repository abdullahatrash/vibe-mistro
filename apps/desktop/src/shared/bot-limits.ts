/**
 * The field rules of a **Mistro Bot** record (#445/#447, ADR-0027) — the bounds and
 * the character rule, shared because BOTH sides apply them and they must agree.
 *
 * Main is the validator (`main/bots/validate-bot-profile.ts`): Vibe validates
 * nothing we write, so the record is refused there before a profile is projected.
 * The renderer's form applies the SAME rules while you type, so it can never let
 * you write something the validator then refuses. Anything both sides check lives
 * here rather than in two copies that nothing prevents from drifting.
 *
 * Node/DOM-free like everything under `shared/`.
 */

/** Long enough for any real teammate name; short enough to stay one sidebar line. */
export const BOT_NAME_MAX_LENGTH = 60
/** The mode `description` is one line in a picker, not prose. */
export const BOT_DESCRIPTION_MAX_LENGTH = 200
/** The persona proper. Generous — it is the whole personality — but not unbounded. */
export const BOT_INSTRUCTIONS_MAX_LENGTH = 100_000
/** A hex colour or a short token name; nothing legitimate needs more. */
export const BOT_COLOUR_MAX_LENGTH = 32

/**
 * Whether a value carries a C0 control character (line breaks included) or DEL.
 *
 * The rule behind the rule: `name` and `description` are ONE-LINE values on the
 * wire — `display_name` and the mode `description` Vibe renders in a picker — so a
 * newline in either breaks the line that renders it. `instructions` is prose and
 * is deliberately not checked against this.
 */
export function hasBotControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
