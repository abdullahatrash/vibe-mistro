/**
 * Pending-context chips (#229, PRD #228) — the PURE core of the composer's structured
 * attachments. A context is a chip the user staged BESIDE the draft text (never inline
 * in it); it flattens into plain prompt text only at send, so the wire stays a plain
 * `session/prompt` text block (ADR-0002 — the agent parses a leading `/name` itself).
 * No DOM, no IPC: list operations + the serialize transform, unit-tested as plain data.
 */

/** A skill invocation staged as a chip — at most one (the agent parses only a LEADING `/name`). */
export interface SkillContext {
  kind: 'skill'
  name: string
  description?: string
}

/** A context chip staged in the composer awaiting send. File/element kinds follow (#230/#231). */
export type PendingContext = SkillContext

/** The stable identity of a chip — the React key and the remove handle. */
export function contextKey(context: PendingContext): string {
  return `${context.kind}:${context.name}`
}

/** Drop the chip whose {@link contextKey} matches; a miss returns the list unchanged. */
export function removeContext(
  contexts: readonly PendingContext[],
  key: string,
): PendingContext[] {
  return contexts.filter((c) => contextKey(c) !== key)
}

/**
 * Stage a context, returning the new list. A skill REPLACES any staged skill — the
 * agent parses only the leading `/name`, so the composer never stages an invocation
 * it can't honor.
 */
export function addContext(
  contexts: readonly PendingContext[],
  context: PendingContext,
): PendingContext[] {
  return [...contexts.filter((c) => c.kind !== context.kind), context]
}

/**
 * Flatten the staged contexts into the outgoing prompt text: a skill chip becomes the
 * leading `/name ` invocation (bare `/name` when there is no prose). The prose itself
 * is trimmed exactly like the send path trims the draft.
 */
export function serializeForSend(text: string, contexts: readonly PendingContext[]): string {
  const prose = text.trim()
  const skill = contexts.find((c) => c.kind === 'skill')
  if (!skill) return prose
  return prose.length > 0 ? `/${skill.name} ${prose}` : `/${skill.name}`
}
