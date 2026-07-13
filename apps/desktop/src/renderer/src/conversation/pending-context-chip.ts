import { pastedLabel, type PendingContext } from './pending-contexts'

/** A review chip's compact line-range suffix, e.g. `:10-12` / `:7`. */
function reviewRange(context: { startLine: number | null; endLine: number | null }): string {
  if (context.startLine === null || context.endLine === null) return ''
  return context.startLine === context.endLine
    ? `:${context.startLine}`
    : `:${context.startLine}-${context.endLine}`
}

/** A pending-context chip's compact visible label. */
export function pendingContextChipLabel(context: PendingContext): string {
  switch (context.kind) {
    case 'skill':
      return `/${context.name}`
    case 'file':
      return context.path
    case 'element':
      return context.selector ?? `<${context.tagName}>`
    case 'review':
      return `${context.filePath}${reviewRange(context)}`
    case 'pasted':
      return pastedLabel(context)
    case 'message-selection':
      return '1 selection'
  }
}

const TITLE_PREVIEW_CHARS = 400

function preview(text: string): string {
  return text.length > TITLE_PREVIEW_CHARS ? `${text.slice(0, TITLE_PREVIEW_CHARS)}…` : text
}

/** A pending-context chip's inspectable hover detail. */
export function pendingContextChipTitle(context: PendingContext): string | undefined {
  switch (context.kind) {
    case 'skill':
      return context.description
    case 'file':
      return context.path
    case 'element':
      return [
        `<${context.tagName}>`,
        context.selector ?? '',
        context.text.trim(),
        context.pageUrl,
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    case 'review':
      return [`${context.filePath}${reviewRange(context)}`, context.note, '', context.excerpt].join('\n')
    case 'pasted':
      return preview(context.text)
    case 'message-selection':
      return [
        `Source Thread: ${context.source.threadTitle}`,
        `Source role: ${context.source.role === 'agent' ? 'Agent' : 'User'}`,
        '',
        preview(context.text),
      ].join('\n')
  }
}

/** Accessible remove-button label; selection avoids the opaque count wording. */
export function pendingContextChipRemoveLabel(context: PendingContext): string {
  return context.kind === 'message-selection'
    ? 'Remove selection'
    : `Remove ${pendingContextChipLabel(context)}`
}
