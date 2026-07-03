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

/**
 * A Browser Surface element pick staged as a chip (#231, upgrading #224/ADR-0016): the
 * picker's DOM metadata, plus `imageId` pairing it to its staged screenshot so removing
 * the chip removes the screenshot with it. `id` is minted by the composer (each pick is
 * its own chip — no dedupe; picking twice deliberately stages twice).
 */
export interface ElementContext {
  kind: 'element'
  id: string
  tagName: string
  selector: string | null
  text: string
  pageUrl: string
  imageId: string | null
}

/** A context chip staged in the composer awaiting send. */
export type PendingContext = SkillContext | FileContext | ElementContext

/** The stable identity of a chip — the React key, the remove handle, and the dedupe key. */
export function contextKey(context: PendingContext): string {
  switch (context.kind) {
    case 'skill':
      return `skill:${context.name}`
    case 'file':
      return `file:${context.path}`
    case 'element':
      return `element:${context.id}`
  }
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

/** The marker element fencing picked-element context in the wire text (#231) — descriptive
 *  prose the agent reads naturally (the former #224 draft-text annotation, relocated). */
const ELEMENT_CONTEXT_OPEN = '<element_context>'
const ELEMENT_CONTEXT_CLOSE = '</element_context>'

/** One element's lines inside the block — `Picked element <tag>` (the entry delimiter),
 *  optional `selector:`/`text:` lines (text whitespace-normalized so entries stay line-
 *  parseable), then the page URL. Mirrors the former `formatPickAnnotation` content. */
function formatElementEntry(element: ElementContext): string[] {
  const lines = [`Picked element <${element.tagName}>`]
  if (element.selector) lines.push(`selector: ${element.selector}`)
  const text = element.text.replace(/\s+/g, ' ').trim()
  if (text.length > 0) lines.push(`text: ${text}`)
  lines.push(element.pageUrl)
  return lines
}

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

/** One entry's parsed lines inside an `<element_context>` block — the extraction inverse
 *  of {@link formatElementEntry}. Returns null on a shape we didn't write. */
function parseElementEntry(lines: string[], index: number): ElementContext | null {
  const head = /^Picked element <([^>]+)>$/.exec(lines[0] ?? '')
  if (!head || lines.length < 2) return null
  const pageUrl = lines[lines.length - 1]
  let selector: string | null = null
  let text = ''
  for (const line of lines.slice(1, -1)) {
    if (line.startsWith('selector: ')) selector = line.slice('selector: '.length)
    else if (line.startsWith('text: ')) text = line.slice('text: '.length)
    else return null
  }
  return { kind: 'element', id: `el-extract:${index}`, tagName: head[1], selector, text, pageUrl, imageId: null }
}

/** The prose + recovered chips of a sent prompt — {@link extractPromptContexts}. */
export interface ExtractedPromptContexts {
  cleanText: string
  files: FileContext[]
  elements: ElementContext[]
}

/**
 * The FULL display mirror of {@link serializeForSend} (#230/#231): strip a trailing
 * `<element_context>` block, then a (now-)trailing `<attached_files>` block, recovering
 * the chips the prompt was sent with. Each stage passes text through untouched when its
 * marker is absent or malformed, so hand-typed prompts are never altered. Extracted
 * element ids are render-local (`el-extract:<n>`) — pairing to a live screenshot exists
 * only pre-send.
 */
export function extractPromptContexts(text: string): ExtractedPromptContexts {
  let working = text
  let elements: ElementContext[] = []
  const trimmed = working.trimEnd()
  if (trimmed.endsWith(ELEMENT_CONTEXT_CLOSE)) {
    const open = trimmed.lastIndexOf(ELEMENT_CONTEXT_OPEN)
    if (open !== -1) {
      const inner = trimmed.slice(open + ELEMENT_CONTEXT_OPEN.length, trimmed.length - ELEMENT_CONTEXT_CLOSE.length)
      const lines = inner.split('\n').filter((line) => line.trim().length > 0)
      // Split into entries on each `Picked element <…>` head line.
      const entries: string[][] = []
      for (const line of lines) {
        if (line.startsWith('Picked element <') || entries.length === 0) entries.push([line])
        else entries[entries.length - 1].push(line)
      }
      const parsed = entries.map((entry, i) => parseElementEntry(entry, i))
      if (parsed.length > 0 && parsed.every((p) => p !== null)) {
        elements = parsed
        working = trimmed.slice(0, open).replace(/\n+$/, '')
      }
    }
  }
  const { cleanText, files } = extractAttachedFiles(working)
  return { cleanText, files, elements }
}

/**
 * Flatten the staged contexts into the outgoing prompt text: a skill chip becomes the
 * leading `/name ` invocation (bare `/name` when there is no prose); file chips become
 * a TRAILING `<attached_files>` block of `@path` mentions the agent expands itself
 * (ADR-0002 — plain text, no client-side expansion); element chips become a final
 * `<element_context>` block of descriptive prose. The prose itself is trimmed exactly
 * like the send path trims the draft.
 */
export function serializeForSend(text: string, contexts: readonly PendingContext[]): string {
  const prose = text.trim()
  const skill = contexts.find((c) => c.kind === 'skill')
  const body = skill ? (prose.length > 0 ? `/${skill.name} ${prose}` : `/${skill.name}`) : prose
  const parts = [body]
  const files = contexts.filter((c) => c.kind === 'file')
  if (files.length > 0) {
    parts.push([ATTACHED_FILES_OPEN, ...files.map((f) => `@${f.path}`), ATTACHED_FILES_CLOSE].join('\n'))
  }
  const elements = contexts.filter((c) => c.kind === 'element')
  if (elements.length > 0) {
    parts.push(
      [ELEMENT_CONTEXT_OPEN, ...elements.flatMap(formatElementEntry), ELEMENT_CONTEXT_CLOSE].join('\n'),
    )
  }
  return parts.filter((p) => p.length > 0).join('\n\n')
}
