import type { ToolItem } from './reducer'

/** A structured ACP file edit emitted by Vibe (`tool_call.content[type=diff]`). */
export interface FileChange {
  path: string
  oldText: string | null
  newText: string | null
  kind: 'created' | 'edited' | 'deleted'
  additions: number
  deletions: number
}

/** A bounded line view for the transcript's inline diff (large generated files stay cheap). */
export interface ChangeLinePreview {
  lines: string[]
  hiddenLineCount: number
}

export const MAX_CHANGE_PREVIEW_LINES = 80

/**
 * Interpret Vibe's structured ACP diff content. This is intentionally renderer-owned:
 * main forwards ACP updates raw (ADR-0001), while the conversation decides how they look.
 * Accept snake_case defensively even though ACP currently serializes camelCase.
 */
export function fileChanges(item: ToolItem): FileChange[] {
  const changes: FileChange[] = []
  for (const value of item.content) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    if (entry.type !== 'diff' || typeof entry.path !== 'string' || entry.path.length === 0) continue

    const oldText = textField(entry, 'oldText', 'old_text')
    const newText = textField(entry, 'newText', 'new_text')
    if (oldText === undefined && newText === undefined) continue

    const normalizedOld = oldText ?? null
    const normalizedNew = newText ?? null
    changes.push({
      path: entry.path,
      oldText: normalizedOld,
      newText: normalizedNew,
      kind: normalizedOld === null ? 'created' : normalizedNew === null ? 'deleted' : 'edited',
      additions: countLines(normalizedNew),
      deletions: countLines(normalizedOld),
    })
  }
  return changes
}

/** Aggregate copy for the card heading. */
export function fileChangeHeading(changes: readonly FileChange[]): string {
  const count = changes.length
  const noun = count === 1 ? 'file' : 'files'
  if (changes.every((change) => change.kind === 'created')) return `Created ${count} ${noun}`
  if (changes.every((change) => change.kind === 'deleted')) return `Deleted ${count} ${noun}`
  return `Changed ${count} ${noun}`
}

/** Sum replacement-line churn across every structured diff in one tool call. */
export function fileChangeStats(changes: readonly FileChange[]): {
  additions: number
  deletions: number
} {
  let additions = 0
  let deletions = 0
  for (const change of changes) {
    additions += change.additions
    deletions += change.deletions
  }
  return { additions, deletions }
}

/** Split text into display lines and cap the mounted transcript DOM. */
export function changeLinePreview(text: string | null, maxLines = MAX_CHANGE_PREVIEW_LINES): ChangeLinePreview {
  if (text === null || text.length === 0) return { lines: [], hiddenLineCount: 0 }
  const lines = splitLines(text)
  return {
    lines: lines.slice(0, maxLines),
    hiddenLineCount: Math.max(0, lines.length - maxLines),
  }
}

/**
 * Convert an ACP path to a Files-surface-relative path without Node's `path` module.
 * Absolute paths must sit under this Workspace; relative paths must not traverse upward.
 */
export function workspaceRelativePath(path: string, workspaceDir: string): string | null {
  const normalizedPath = normalizeSeparators(path)
  const normalizedRoot = trimTrailingSlash(normalizeSeparators(workspaceDir))
  const absolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath)

  let relative = normalizedPath
  if (absolute) {
    const caseInsensitive = /^[A-Za-z]:\//.test(normalizedRoot)
    const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
    const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
    const prefix = `${comparableRoot}/`
    if (!comparablePath.startsWith(prefix)) return null
    relative = normalizedPath.slice(normalizedRoot.length + 1)
  }

  while (relative.startsWith('./')) relative = relative.slice(2)
  const segments = relative.split('/')
  if (
    relative.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return null
  }
  return segments.join('/')
}

function textField(entry: Record<string, unknown>, camelKey: string, snakeKey: string): string | null | undefined {
  const value = entry[camelKey] !== undefined ? entry[camelKey] : entry[snakeKey]
  return typeof value === 'string' || value === null ? value : undefined
}

function countLines(text: string | null): number {
  return text === null || text.length === 0 ? 0 : splitLines(text).length
}

function splitLines(text: string): string[] {
  const lines = text.split(/\r\n|\r|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function normalizeSeparators(path: string): string {
  return path.replace(/\\/g, '/')
}

function trimTrailingSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}
