/**
 * Turning a failed turn's JSON-RPC/app error code into something a user can ACT on
 * (#433, #100).
 *
 * Vibe's `-31xxx` application codes carry meanings its raw messages do not make
 * actionable — "context too long" does not tell you that `/compact` exists. Every
 * code we understand gets a sentence naming the way out; everything else falls
 * through to the agent's own message, which is still better than inventing one.
 *
 * Extracted from `Conversation.tsx` so the mapping is testable without rendering,
 * and so the next code we learn about has an obvious home.
 */

/** Vibe's app code for "this model can't ingest images" (acp-capture §11, #100). */
export const IMAGES_UNSUPPORTED_CODE = -31008
/** The conversation no longer fits the model's context window (acp-capture §8). */
export const CONTEXT_TOO_LONG_CODE = -31004
/**
 * Compaction ran and could not produce a summary (acp-capture §8). Only reachable
 * when `raise_on_compaction_failure` is ON — with Vibe's default (off) the same
 * failure is SILENT: the turn continues having quietly dropped everything that was
 * not a user message (#433). So seeing this error is the lucky case.
 */
export const COMPACTION_FAILED_CODE = -31006

/**
 * The message to show for a failed turn. `code` is the preserved JSON-RPC/app code
 * (null when the failure carried none) and `fallback` is the agent's own message.
 */
export function turnErrorNotice(code: number | null | undefined, fallback: string): string {
  switch (code) {
    case IMAGES_UNSUPPORTED_CODE:
      // The staged images are kept, so switching model and resending just works.
      return "This model can't see images. Switch to a vision-capable model (e.g. mistral-medium-3.5) and resend."
    case CONTEXT_TOO_LONG_CODE:
      return 'This conversation no longer fits the model\'s context. Run /compact to summarise the history, or start a new Thread to keep going.'
    case COMPACTION_FAILED_CODE:
      return 'Vibe could not compact this conversation\'s history, so the turn was stopped. Starting a new Thread is the reliable way forward — this one may be too large to recover.'
    default:
      return fallback
  }
}
