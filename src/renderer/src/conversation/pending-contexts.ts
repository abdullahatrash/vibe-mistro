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

/** A Workspace-relative file mention staged as a chip — sent as an `@path` the agent expands. */
export interface FileContext {
  kind: 'file'
  path: string
}

/** A context chip staged in the composer awaiting send. The element kind follows (#231). */
export type PendingContext = SkillContext | FileContext

/** The stable identity of a chip — the React key, the remove handle, and the dedupe key. */
export function contextKey(context: PendingContext): string {
  return context.kind === 'skill' ? `skill:${context.name}` : `file:${context.path}`
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
 * it can't honor. Files ACCUMULATE, deduped by path (re-selecting is a no-op).
 */
export function addContext(
  contexts: readonly PendingContext[],
  context: PendingContext,
): PendingContext[] {
  const kept =
    context.kind === 'skill'
      ? contexts.filter((c) => c.kind !== 'skill')
      : contexts.filter((c) => contextKey(c) !== contextKey(context))
  return [...kept, context]
}

/** The marker element fencing chip-staged `@path` mentions in the wire text (#230). It keeps
 *  the display-side extraction unambiguous against user-TYPED inline mentions; the agent reads
 *  it as plain prose and expands the `@path` tokens inside it like any others. */
const ATTACHED_FILES_OPEN = '<attached_files>'
const ATTACHED_FILES_CLOSE = '</attached_files>'

/** The prose + recovered file chips of a sent prompt — {@link extractAttachedFiles}. */
export interface ExtractedAttachedFiles {
  cleanText: string
  files: FileContext[]
}

/**
 * The display mirror of {@link serializeForSend} (#230): detect (and strip) a TRAILING
 * `<attached_files>` block so the user-turn row renders the original prose and the file
 * chips separately — live and on JSONL replay, since both ride the same prompt text.
 * Anything else — no block, a block mid-text, user-typed inline `@path` mentions —
 * passes through untouched. Non-`@` lines inside a candidate block disqualify it (it
 * wasn't ours).
 */
export function extractAttachedFiles(text: string): ExtractedAttachedFiles {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith(ATTACHED_FILES_CLOSE)) return { cleanText: text, files: [] }
  const open = trimmed.lastIndexOf(ATTACHED_FILES_OPEN)
  if (open === -1) return { cleanText: text, files: [] }
  const inner = trimmed.slice(open + ATTACHED_FILES_OPEN.length, trimmed.length - ATTACHED_FILES_CLOSE.length)
  const lines = inner.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0 || !lines.every((line) => line.trim().startsWith('@'))) {
    return { cleanText: text, files: [] }
  }
  return {
    cleanText: trimmed.slice(0, open).replace(/\n+$/, ''),
    files: lines.map((line) => ({ kind: 'file', path: line.trim().slice(1) })),
  }
}

/**
 * Flatten the staged contexts into the outgoing prompt text: a skill chip becomes the
 * leading `/name ` invocation (bare `/name` when there is no prose); file chips become
 * a TRAILING `<attached_files>` block of `@path` mentions the agent expands itself
 * (ADR-0002 — plain text, no client-side expansion). The prose itself is trimmed
 * exactly like the send path trims the draft.
 */
export function serializeForSend(text: string, contexts: readonly PendingContext[]): string {
  const prose = text.trim()
  const skill = contexts.find((c) => c.kind === 'skill')
  const body = skill ? (prose.length > 0 ? `/${skill.name} ${prose}` : `/${skill.name}`) : prose
  const files = contexts.filter((c) => c.kind === 'file')
  if (files.length === 0) return body
  const block = [ATTACHED_FILES_OPEN, ...files.map((f) => `@${f.path}`), ATTACHED_FILES_CLOSE].join('\n')
  return body.length > 0 ? `${body}\n\n${block}` : block
}
