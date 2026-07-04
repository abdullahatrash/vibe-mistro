import type { AcpCommand } from './reducer'

export interface SlashCommandInlineToken {
  kind: 'slashCommand'
  name: string
  description?: string
}

export type ComposerInlineToken = SlashCommandInlineToken

function isSlashCommandInlineToken(value: unknown): value is SlashCommandInlineToken {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const token = value as Partial<SlashCommandInlineToken>
  return token.kind === 'slashCommand' && typeof token.name === 'string' && token.name.length > 0
}

export function coerceInlineTokens(values: unknown[]): ComposerInlineToken[] {
  const tokens: ComposerInlineToken[] = []
  let hasSlashCommand = false
  for (const value of values) {
    if (!isSlashCommandInlineToken(value)) continue
    if (hasSlashCommand) continue
    hasSlashCommand = true
    tokens.push({
      kind: 'slashCommand',
      name: value.name,
      description: typeof value.description === 'string' ? value.description : undefined,
    })
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

export function serializeInlineTokensForSend(
  prompt: string,
  tokens: readonly ComposerInlineToken[],
): string {
  const slash = getSlashCommandInlineToken(tokens)
  if (!slash) return prompt
  const commandText = `/${slash.name}`
  const trimmedPrompt = prompt.trimStart()
  if (trimmedPrompt.length === 0) return commandText
  if (trimmedPrompt.toLowerCase().startsWith(`${commandText.toLowerCase()} `)) {
    return trimmedPrompt
  }
  if (trimmedPrompt.toLowerCase() === commandText.toLowerCase()) return trimmedPrompt
  return `${commandText} ${trimmedPrompt}`
}
