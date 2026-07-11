/**
 * Pending-context chips (#229, PRD #228) — the PURE core of the composer's structured
 * attachments. A context is a chip the user staged BESIDE the draft text (never inline
 * in it); it flattens into plain prompt text only at send, so the wire stays a plain
 * `session/prompt` text block (ADR-0002 — the agent parses a leading `/name` itself).
 * No DOM, no IPC: list operations + the serialize transform, unit-tested as plain data.
 */

import type { MessageSelection } from './message-selection'

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

/**
 * A Review Surface diff comment staged as a chip (#239, PRD #233): the user selected
 * lines in a diff and wrote a note. `excerpt` is the selected diff lines VERBATIM
 * (with their +/-/space prefixes) so the agent sees exactly which code the note points
 * at; `startLine`/`endLine` are new-file line numbers (null when the selection
 * couldn't be located — the excerpt still pins the code). `id` is composer-minted —
 * each comment is its own chip, several accumulate into one prompt.
 */
export interface ReviewCommentContext {
  kind: 'review'
  id: string
  filePath: string
  startLine: number | null
  endLine: number | null
  note: string
  excerpt: string
}

/**
 * A LONG clipboard paste staged as a chip instead of splicing into the draft (mirrors
 * t3code's inline-token treatment of big text blobs): the composer stays compact — the
 * chip shows a bracketed placeholder — and the full text rides a trailing
 * `<pasted_text>` block only at send. `id` is composer-minted; several pastes accumulate.
 */
export interface PastedTextContext {
  kind: 'pasted'
  id: string
  text: string
}

/**
 * A verbatim excerpt selected from one user or agent Message. The source is kept with
 * the chip so the user can inspect where it came from before send. Transport encoding
 * is deliberately owned by the next tracer bullet; this slice only stages the context.
 */
export interface MessageSelectionContext extends MessageSelection {
  kind: 'message-selection'
  id: string
}

/** A context chip staged in the composer awaiting send. */
export type PendingContext =
  | SkillContext
  | FileContext
  | ElementContext
  | ReviewCommentContext
  | PastedTextContext
  | MessageSelectionContext

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function coercePendingContext(value: unknown): PendingContext | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const context = value as Record<string, unknown>
  switch (context.kind) {
    case 'skill': {
      if (typeof context.name !== 'string' || context.name.length === 0) return null
      return {
        kind: 'skill',
        name: context.name,
        description: typeof context.description === 'string' ? context.description : undefined,
      }
    }
    case 'file':
      return typeof context.path === 'string' && context.path.length > 0
        ? { kind: 'file', path: context.path }
        : null
    case 'element': {
      const id = stringOrNull(context.id)
      const tagName = stringOrNull(context.tagName)
      const text = stringOrNull(context.text)
      const pageUrl = stringOrNull(context.pageUrl)
      if (!id || !tagName || text === null || !pageUrl) return null
      return {
        kind: 'element',
        id,
        tagName,
        selector: stringOrNull(context.selector),
        text,
        pageUrl,
        imageId: stringOrNull(context.imageId),
      }
    }
    case 'review': {
      const id = stringOrNull(context.id)
      const filePath = stringOrNull(context.filePath)
      const note = stringOrNull(context.note)
      const excerpt = stringOrNull(context.excerpt)
      if (!id || !filePath || note === null || excerpt === null) return null
      return {
        kind: 'review',
        id,
        filePath,
        startLine: numberOrNull(context.startLine),
        endLine: numberOrNull(context.endLine),
        note,
        excerpt,
      }
    }
    case 'pasted': {
      const id = stringOrNull(context.id)
      const text = stringOrNull(context.text)
      return id && text !== null ? { kind: 'pasted', id, text } : null
    }
    case 'message-selection': {
      const id = stringOrNull(context.id)
      const text = stringOrNull(context.text)
      if (!id || text === null || text.trim().length === 0) return null
      if (typeof context.source !== 'object' || context.source === null || Array.isArray(context.source)) {
        return null
      }
      const source = context.source as Record<string, unknown>
      const messageId = stringOrNull(source.messageId)
      const threadId = stringOrNull(source.threadId)
      const threadTitle = stringOrNull(source.threadTitle)
      const role = source.role
      if (!messageId || !threadId || threadTitle === null || (role !== 'user' && role !== 'agent')) {
        return null
      }
      return {
        kind: 'message-selection',
        id,
        text,
        source: { messageId, role, threadId, threadTitle },
      }
    }
    default:
      return null
  }
}

export function coercePendingContexts(values: unknown[]): PendingContext[] {
  const contexts: PendingContext[] = []
  for (const value of values) {
    const context = coercePendingContext(value)
    if (context) contexts.push(context)
  }
  return contexts
}

/** A paste is compressed into a chip past EITHER bound — enough characters to balloon
 *  the textarea, or enough lines to push the controls off-screen. */
export const LONG_PASTE_CHARS = 1000
export const LONG_PASTE_LINES = 10

/** Whether a clipboard text paste should stage as a chip instead of entering the draft. */
export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split('\n').length > LONG_PASTE_LINES
}

/** The bracketed placeholder a pasted-text chip displays, in the composer and on the
 *  echoed user turn — sized in lines (or characters for a single long line). */
export function pastedLabel(context: PastedTextContext): string {
  const lines = context.text.split('\n').length
  return lines > 1
    ? `[pasted text · ${lines} lines]`
    : `[pasted text · ${context.text.length} chars]`
}

/** The stable identity of a chip — the React key, the remove handle, and the dedupe key. */
export function contextKey(context: PendingContext): string {
  switch (context.kind) {
    case 'skill':
      return `skill:${context.name}`
    case 'file':
      return `file:${context.path}`
    case 'element':
      return `element:${context.id}`
    case 'review':
      return `review:${context.id}`
    case 'pasted':
      return `pasted:${context.id}`
    case 'message-selection':
      return `message-selection:${context.id}`
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

/** The marker element fencing review comments in the wire text (#239). */
const REVIEW_COMMENTS_OPEN = '<review_comments>'
const REVIEW_COMMENTS_CLOSE = '</review_comments>'

/** The marker element fencing one long paste's VERBATIM text in the wire — one block
 *  per chip (pastes are opaque blobs; there is no entry shape to pack several into one). */
const PASTED_TEXT_OPEN = '<pasted_text>'
const PASTED_TEXT_CLOSE = '</pasted_text>'

/**
 * One deterministic trailing block for every staged Message selection. Its JSON
 * string escapes HTML framing characters, so selected text containing these marker
 * names can never masquerade as the app-owned outer boundary.
 */
const MESSAGE_SELECTIONS_OPEN = '<message_selections>'
const MESSAGE_SELECTIONS_CLOSE = '</message_selections>'
const MESSAGE_SELECTIONS_VERSION = 1

interface MessageSelectionsPayload {
  version: typeof MESSAGE_SELECTIONS_VERSION
  selections: Array<Pick<MessageSelectionContext, 'text' | 'source'>>
}

function htmlSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[<>&]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c'
      case '>':
        return '\\u003e'
      default:
        return '\\u0026'
    }
  })
}

function formatMessageSelections(selections: readonly MessageSelectionContext[]): string {
  const payload: MessageSelectionsPayload = {
    version: MESSAGE_SELECTIONS_VERSION,
    selections: selections.map(({ text, source }) => ({
      text,
      source: {
        messageId: source.messageId,
        role: source.role,
        threadId: source.threadId,
        threadTitle: source.threadTitle,
      },
    })),
  }
  return `${MESSAGE_SELECTIONS_OPEN}\n${htmlSafeJson(payload)}\n${MESSAGE_SELECTIONS_CLOSE}`
}

function extractMessageSelections(text: string): {
  cleanText: string
  selections: MessageSelectionContext[]
} | null {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith(MESSAGE_SELECTIONS_CLOSE)) return null
  const open = trimmed.lastIndexOf(MESSAGE_SELECTIONS_OPEN)
  if (open === -1) return null
  const block = trimmed.slice(open)
  const payloadStart = MESSAGE_SELECTIONS_OPEN.length + 1
  const payloadEnd = block.length - MESSAGE_SELECTIONS_CLOSE.length - 1
  if (
    block[MESSAGE_SELECTIONS_OPEN.length] !== '\n' ||
    block[payloadEnd] !== '\n' ||
    payloadEnd < payloadStart
  ) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(block.slice(payloadStart, payloadEnd))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const payload = parsed as Partial<MessageSelectionsPayload>
  if (payload.version !== MESSAGE_SELECTIONS_VERSION || !Array.isArray(payload.selections)) return null
  if (payload.selections.length === 0) return null

  const selections: MessageSelectionContext[] = []
  for (const [index, entry] of payload.selections.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null
    const context = coercePendingContext({
      ...entry,
      kind: 'message-selection',
      id: `message-selection-extract:${index}`,
    })
    if (context?.kind !== 'message-selection') return null
    selections.push(context)
  }

  // Only consume the exact canonical shape this app emits. A malformed or merely
  // marker-shaped hand-written suffix remains ordinary prompt text.
  if (formatMessageSelections(selections) !== block) return null
  return {
    cleanText: trimmed.slice(0, open).replace(/\n+$/, ''),
    selections,
  }
}

/** One review comment's lines inside the block (#239): a head line naming the file +
 *  line range, a single-line `note:` (whitespace-normalized, like element text), then
 *  the selected diff lines verbatim inside a ```diff fence. Line-parseable — the
 *  extraction inverse is {@link parseReviewEntries}. */
function formatReviewEntry(comment: ReviewCommentContext): string[] {
  const range =
    comment.startLine !== null && comment.endLine !== null
      ? comment.startLine === comment.endLine
        ? ` (line ${comment.startLine})`
        : ` (lines ${comment.startLine}-${comment.endLine})`
      : ''
  return [
    `Review comment on ${comment.filePath}${range}`,
    `note: ${comment.note.replace(/\s+/g, ' ').trim()}`,
    '```diff',
    ...comment.excerpt.split('\n'),
    '```',
  ]
}

/** Parse a `<review_comments>` block's inner lines back into comments (#239) — a
 *  line-by-line state machine (NOT a head-line split: excerpt lines inside the ```diff
 *  fences may contain anything, including our own head shape). Null on any shape we
 *  didn't write, so hand-typed text is never mangled. */
function parseReviewEntries(lines: string[]): ReviewCommentContext[] | null {
  const comments: ReviewCommentContext[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].trim().length === 0) {
      i++
      continue
    }
    const head = /^Review comment on (.+?)(?: \((?:line (\d+)|lines (\d+)-(\d+))\))?$/.exec(lines[i])
    if (!head) return null
    const note = lines[i + 1]
    if (note === undefined || !note.startsWith('note: ') || lines[i + 2] !== '```diff') return null
    const close = lines.indexOf('```', i + 3)
    if (close === -1) return null
    const single = head[2] ? Number(head[2]) : null
    comments.push({
      kind: 'review',
      id: `rc-extract:${comments.length}`,
      filePath: head[1],
      startLine: single ?? (head[3] ? Number(head[3]) : null),
      endLine: single ?? (head[4] ? Number(head[4]) : null),
      note: note.slice('note: '.length),
      excerpt: lines.slice(i + 3, close).join('\n'),
    })
    i = close + 1
  }
  return comments.length > 0 ? comments : null
}

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
  reviews: ReviewCommentContext[]
  pasted: PastedTextContext[]
  selections: MessageSelectionContext[]
}

/**
 * The FULL display mirror of {@link serializeForSend} (#230/#231): strip a trailing
 * Message-selection JSON, `<pasted_text>`, `<review_comments>`, `<element_context>`,
 * then `<attached_files>` in reverse serialization order, recovering the chips the
 * prompt was sent with. Each stage passes text through untouched when its marker is
 * absent or malformed, so hand-typed prompts are never altered. Extracted ids are
 * render-local — pairing to original live UI state exists only pre-send.
 */
export function extractPromptContexts(text: string): ExtractedPromptContexts {
  let working = text
  let elements: ElementContext[] = []
  let reviews: ReviewCommentContext[] = []
  const pasted: PastedTextContext[] = []
  let selections: MessageSelectionContext[] = []
  // Message selections serialize last, so their injection-safe JSON block strips
  // first. A malformed lookalike deliberately blocks deeper extraction: it is user
  // prose, not app framing, and must pass through byte-for-byte.
  const extractedSelections = extractMessageSelections(working)
  if (extractedSelections) {
    working = extractedSelections.cleanText
    selections = extractedSelections.selections
  }
  // Pasted-text blocks serialize LAST of all, so they strip FIRST — one block per
  // chip, back-to-front (unshift keeps staged order). The inner slice drops exactly
  // the one newline we added on each side of the verbatim text, so the paste
  // round-trips byte-for-byte (including its own trailing newline, if any).
  for (;;) {
    const pasteTrimmed = working.trimEnd()
    if (!pasteTrimmed.endsWith(PASTED_TEXT_CLOSE)) break
    const open = pasteTrimmed.lastIndexOf(PASTED_TEXT_OPEN)
    if (open === -1) break
    const inner = pasteTrimmed.slice(
      open + PASTED_TEXT_OPEN.length,
      pasteTrimmed.length - PASTED_TEXT_CLOSE.length,
    )
    pasted.unshift({
      kind: 'pasted',
      id: `paste-extract:${open}`,
      text: inner.replace(/^\n/, '').replace(/\n$/, ''),
    })
    working = pasteTrimmed.slice(0, open).replace(/\n+$/, '')
  }
  // Re-key extracted pastes in document order (the loop keys by offset while stripping).
  pasted.forEach((chip, i) => (chip.id = `paste-extract:${i}`))
  // Reviews serialize LAST of the entry-shaped blocks (#239), so they strip next.
  const reviewTrimmed = working.trimEnd()
  if (reviewTrimmed.endsWith(REVIEW_COMMENTS_CLOSE)) {
    const open = reviewTrimmed.lastIndexOf(REVIEW_COMMENTS_OPEN)
    if (open !== -1) {
      const inner = reviewTrimmed.slice(
        open + REVIEW_COMMENTS_OPEN.length,
        reviewTrimmed.length - REVIEW_COMMENTS_CLOSE.length,
      )
      const parsed = parseReviewEntries(inner.split('\n'))
      if (parsed) {
        reviews = parsed
        working = reviewTrimmed.slice(0, open).replace(/\n+$/, '')
      }
    }
  }
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
  return { cleanText, files, elements, reviews, pasted, selections }
}

/**
 * Build reusable clipboard text from a rendered user prompt. Unlike the transport payload, this
 * omits marker tags while retaining the full contents represented by context chips. This also
 * gives chip-only prompts (especially long pastes) something meaningful to copy.
 */
export function buildPromptCopyText(contexts: ExtractedPromptContexts): string {
  const parts: string[] = []
  if (contexts.cleanText.trim().length > 0) parts.push(contexts.cleanText)
  if (contexts.files.length > 0) parts.push(contexts.files.map((file) => `@${file.path}`).join('\n'))
  for (const element of contexts.elements) parts.push(formatElementEntry(element).join('\n'))
  for (const review of contexts.reviews) parts.push(formatReviewEntry(review).join('\n'))
  for (const paste of contexts.pasted) parts.push(paste.text)
  for (const selection of contexts.selections) {
    const role = selection.source.role === 'agent' ? 'Agent' : 'User'
    parts.push(
      `Selection from ${role} in Thread "${selection.source.threadTitle}":\n${selection.text}`,
    )
  }
  return parts.join('\n\n')
}

/**
 * Flatten the staged contexts into the outgoing prompt text: a skill chip becomes the
 * leading `/name ` invocation (bare `/name` when there is no prose); file chips become
 * a TRAILING `<attached_files>` block of `@path` mentions the agent expands itself
 * (ADR-0002 — plain text, no client-side expansion); element chips become a final
 * `<element_context>` block of descriptive prose; long pastes become trailing
 * `<pasted_text>` blocks, one per chip; Message selections become the final HTML-safe
 * JSON block with exact text + full provenance. The prose itself is trimmed exactly
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
  const reviews = contexts.filter((c) => c.kind === 'review')
  if (reviews.length > 0) {
    parts.push(
      [REVIEW_COMMENTS_OPEN, ...reviews.flatMap(formatReviewEntry), REVIEW_COMMENTS_CLOSE].join('\n'),
    )
  }
  // Long pastes go LAST, one block each, text VERBATIM (an opaque blob — normalizing
  // or entry-shaping it would corrupt code/log pastes). Extraction strips these first.
  for (const paste of contexts) {
    if (paste.kind !== 'pasted') continue
    parts.push(`${PASTED_TEXT_OPEN}\n${paste.text}\n${PASTED_TEXT_CLOSE}`)
  }
  const selections = contexts.filter(
    (context): context is MessageSelectionContext => context.kind === 'message-selection',
  )
  if (selections.length > 0) parts.push(formatMessageSelections(selections))
  return parts.filter((p) => p.length > 0).join('\n\n')
}
