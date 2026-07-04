import type { AcpCommand } from './reducer'

export interface SlashCommandInlineToken {
  kind: 'slashCommand'
  name: string
  description?: string
}

export interface TerminalInlineToken {
  kind: 'terminal'
  id: string
  source: string
  reference: string
  output: string
}

export type ComposerInlineToken = SlashCommandInlineToken | TerminalInlineToken

const TERMINAL_CONTEXT_OPEN = '<terminal_context>'
const TERMINAL_CONTEXT_CLOSE = '</terminal_context>'

function isSlashCommandInlineToken(value: unknown): value is SlashCommandInlineToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const token = value as Partial<SlashCommandInlineToken>
  return token.kind === 'slashCommand' && typeof token.name === 'string' && token.name.length > 0
}

function isTerminalInlineToken(value: unknown): value is TerminalInlineToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const token = value as Partial<TerminalInlineToken>
  return (
    token.kind === 'terminal' &&
    typeof token.id === 'string' &&
    token.id.length > 0 &&
    typeof token.source === 'string' &&
    token.source.length > 0 &&
    typeof token.reference === 'string' &&
    token.reference.length > 0 &&
    typeof token.output === 'string' &&
    token.output.length > 0
  )
}

export function coerceInlineTokens(values: unknown[]): ComposerInlineToken[] {
  const tokens: ComposerInlineToken[] = []
  let hasSlashCommand = false
  for (const value of values) {
    if (isSlashCommandInlineToken(value)) {
      if (hasSlashCommand) continue
      hasSlashCommand = true
      tokens.push({
        kind: 'slashCommand',
        name: value.name,
        description: typeof value.description === 'string' ? value.description : undefined,
      })
      continue
    }
    if (isTerminalInlineToken(value)) {
      tokens.push({
        kind: 'terminal',
        id: value.id,
        source: value.source,
        reference: value.reference,
        output: value.output,
      })
    }
  }
  return tokens
}

export function createSlashCommandInlineToken(command: AcpCommand): SlashCommandInlineToken {
  return {
    kind: 'slashCommand',
    name: command.name,
    description: command.description,
  }
}

export function getSlashCommandInlineToken(
  tokens: readonly ComposerInlineToken[],
): SlashCommandInlineToken | null {
  return tokens.find((token) => token.kind === 'slashCommand') ?? null
}

export function setSlashCommandInlineToken(
  tokens: readonly ComposerInlineToken[],
  command: AcpCommand | null,
): ComposerInlineToken[] {
  const rest = tokens.filter((token) => token.kind !== 'slashCommand')
  return command ? [createSlashCommandInlineToken(command), ...rest] : rest
}

export function createTerminalInlineToken({
  id,
  source,
  output,
}: {
  id: string
  source: string
  output: string
}): TerminalInlineToken {
  const suffix = id.startsWith('terminal:') ? id.slice('terminal:'.length) : id
  return {
    kind: 'terminal',
    id,
    source,
    reference: `[terminal:${source}:${suffix}]`,
    output,
  }
}

export function insertTerminalInlineTokenAt(
  prompt: string,
  caret: number,
  token: TerminalInlineToken,
): { value: string; caret: number } {
  const start = Math.max(0, Math.min(caret, prompt.length))
  const before = prompt.slice(0, start)
  const after = prompt.slice(start)
  const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const suffix = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const insert = `${prefix}${token.reference}${suffix}`
  return {
    value: `${before}${insert}${after}`,
    caret: before.length + prefix.length + token.reference.length + suffix.length,
  }
}

export function pruneInactiveInlineTokens(
  prompt: string,
  tokens: readonly ComposerInlineToken[],
): ComposerInlineToken[] {
  return tokens.filter((token) => token.kind !== 'terminal' || prompt.includes(token.reference))
}

function serializeTerminalContext(prompt: string, tokens: readonly ComposerInlineToken[]): string[] {
  const lines: string[] = []
  for (const token of tokens) {
    if (token.kind !== 'terminal' || !prompt.includes(token.reference)) continue
    lines.push(`Terminal output for ${token.reference} from ${token.source}:`)
    lines.push(...token.output.split('\n'))
  }
  return lines.length > 0 ? [TERMINAL_CONTEXT_OPEN, ...lines, TERMINAL_CONTEXT_CLOSE] : []
}

export function serializeInlineTokensForSend(
  prompt: string,
  tokens: readonly ComposerInlineToken[],
): string {
  const slash = getSlashCommandInlineToken(tokens)
  const terminalContext = serializeTerminalContext(prompt, tokens).join('\n')
  if (!slash) return [prompt, terminalContext].filter((part) => part.length > 0).join('\n\n')
  const commandText = `/${slash.name}`
  const trimmedPrompt = prompt.trimStart()
  if (trimmedPrompt.length === 0) {
    return [commandText, terminalContext].filter((part) => part.length > 0).join('\n\n')
  }
  if (trimmedPrompt.toLowerCase().startsWith(`${commandText.toLowerCase()} `)) {
    return [trimmedPrompt, terminalContext].filter((part) => part.length > 0).join('\n\n')
  }
  if (trimmedPrompt.toLowerCase() === commandText.toLowerCase()) {
    return [trimmedPrompt, terminalContext].filter((part) => part.length > 0).join('\n\n')
  }
  return [`${commandText} ${trimmedPrompt}`, terminalContext].filter((part) => part.length > 0).join('\n\n')
}
