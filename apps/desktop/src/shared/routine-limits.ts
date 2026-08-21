/**
 * The field rules of a **Routine** record (#467, ADR-0028) — the bounds BOTH
 * sides apply, kept here for the same reason `bot-limits.ts` exists: main is the
 * validator (`main/routines/validate-routine.ts`) and the authoring form (slice
 * 5) applies the same rules while you type, so neither can let through something
 * the other refuses.
 *
 * Node/DOM-free like everything under `shared/`.
 */

/**
 * How many Routines one Mistro Bot may hold (ADR-0028 part 1).
 *
 * NOT a resource bound. A Bot is a single continuing conversation, so Routines
 * due at the same moment defer against one another — the cap bounds the deferral
 * queue that forms, and the queue is the thing that gets unreadable, not the
 * rows.
 */
export const MAX_ROUTINES_PER_BOT = 5

/** A Routine is NAMED (ADR-0028 part 7); long enough to say what it does. */
export const ROUTINE_NAME_MAX_LENGTH = 60

/**
 * The prompt the headless turn sends. Generous — it is a whole instruction, and
 * a Routine's prompt carries the context nobody is there to supply — but bounded
 * so a runaway paste cannot become a row nothing can render.
 */
export const ROUTINE_PROMPT_MAX_LENGTH = 20_000

/** One **allowed command** is a literal invocation, not a script. */
export const ALLOWED_COMMAND_MAX_LENGTH = 500

/**
 * How many allowed commands one Routine may list. A list past this is not a
 * permission answer any more; it is a posture, and ADR-0028 part 4 has no
 * postures.
 */
export const MAX_ALLOWED_COMMANDS = 50
