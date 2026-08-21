/**
 * The bounds of a **Mistro Bot** record's editable fields (#445/#447, ADR-0027) —
 * shared because BOTH sides need them and they must agree.
 *
 * Main is the validator (`main/bots/validate-bot-profile.ts`): Vibe validates
 * nothing we write, so the record is refused there before a profile is projected.
 * The renderer's form needs the SAME numbers to say "too long" while you type
 * instead of after a round trip — a form whose limit disagrees with the validator
 * is a form that lets you write something it then refuses.
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
