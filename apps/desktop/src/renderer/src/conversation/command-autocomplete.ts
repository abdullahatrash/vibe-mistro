/**
 * `/` slash-command autocomplete logic (#95): the pure core of the composer's
 * command popover. The commands themselves are Vibe-owned — they arrive on the
 * `available_commands_update` stream and are already folded into the reducer's
 * `state.availableCommands` (reducer.ts). This module owns ONLY the derivation:
 * trigger detection, filtering, the insertion transform, and selection wrapping.
 * It is deliberately DOM-free and side-effect-free so it unit-tests as plain data
 * (command-autocomplete.test.ts) while `Conversation.tsx` keeps the thin JSX +
 * keyboard wiring.
 *
 * Trigger rule: the popover is active only for a `/`-prefixed token at the START
 * of the prompt, with the caret inside or after that token. A closed token — one
 * the caret has moved past a whitespace of — does not qualify, matching a shell's
 * "first word" feel.
 */

import type { AcpCommand } from './reducer'

/**
 * The result of probing the composer value + caret for an active `/` trigger.
 * `active` gates the popover; `query` is the text after the `/` up to the caret
 * (lower-cased matching happens in `filterCommands`); `start` is the index of the
 * `/` so `removeCommandToken` knows where the token begins.
 */
export interface CommandTrigger {
  active: boolean
  query: string
  start: number
}

/** An inactive probe result — the single shape returned when no trigger qualifies. */
const NO_TRIGGER: CommandTrigger = { active: false, query: '', start: -1 }

/** Whitespace closes a `/`-token: a caret past one of these is no longer inside it. */
const TOKEN_WHITESPACE = /\s/

/**
 * Detect a `/`-command trigger at the caret. Active only when the `/` sits at index
 * 0 and the text from the `/` up to the caret contains no whitespace (the token is
 * still open). Returns the query (text after `/`, up to the caret) and the `/`'s
 * index on a hit.
 *
 * `caret` is clamped defensively — a caller may hand us a DOM `selectionStart` that
 * a controlled re-render has momentarily desynced from `value`.
 */
export function getCommandQuery(value: string, caret: number): CommandTrigger {
  const pos = Math.max(0, Math.min(caret, value.length))
  // The token must open with a `/` at prompt start, and the caret must sit AFTER
  // that `/` (a caret resting on the `/` itself isn't inside the token yet).
  if (value[0] !== '/' || pos <= 0) return NO_TRIGGER
  const query = value.slice(1, pos)
  // A whitespace before the caret means the token closed — the caret is on a later
  // word (e.g. `/init ` with the caret past the space), so the popover must not show.
  if (TOKEN_WHITESPACE.test(query)) return NO_TRIGGER
  return { active: true, query, start: 0 }
}

/**
 * Filter commands by name against a query, case-insensitively: prefix matches first
 * (in their original order), then the remaining substring matches (also in order),
 * with non-matches dropped. An empty query keeps every command (all are prefixed by
 * ''), so the popover opens showing the full list right after a bare `/`.
 */
export function filterCommands(commands: AcpCommand[], query: string): AcpCommand[] {
  const needle = query.toLowerCase()
  const prefix: AcpCommand[] = []
  const substring: AcpCommand[] = []
  for (const command of commands) {
    const name = command.name.toLowerCase()
    if (name.startsWith(needle)) prefix.push(command)
    else if (name.includes(needle)) substring.push(command)
  }
  return [...prefix, ...substring]
}

/** The value + caret produced by accepting a completion, applied to the composer. */
export interface CommandInsertion {
  value: string
  caret: number
}

/**
 * Remove the `/query` token (from `start` up to `caret`) outright — the chip-accept
 * transform (#229): the accepted skill becomes a pending-context chip BESIDE the text,
 * so nothing is spliced in. Text after the caret is kept; the caret rests where the
 * token began.
 */
export function removeCommandToken(value: string, start: number, caret: number): CommandInsertion {
  return { value: value.slice(0, start) + value.slice(caret), caret: start }
}

/**
 * Match a SENT message against the commands list, mirroring vibe-acp's own
 * server-side parse (`SkillManager.parse_skill_command` + the builtin-command
 * normalization): the whole text, after trim, must open with `/`, and the first
 * whitespace-delimited word (lowercased, leading whitespace after the `/`
 * tolerated — Python's `split(None)` semantics) must equal a command name.
 * Returns the matched command or null. This is how the user-message row knows a
 * prompt invoked a skill/command — the agent gives no wire-level signal.
 */
export function matchInvokedCommand(
  text: string,
  commands: readonly AcpCommand[],
): AcpCommand | null {
  const stripped = text.trim()
  if (!stripped.startsWith('/')) return null
  const name = stripped.slice(1).trimStart().split(TOKEN_WHITESPACE, 1)[0]?.toLowerCase()
  if (!name) return null
  return commands.find((command) => command.name.toLowerCase() === name) ?? null
}

/**
 * Move a wrapping selection index by `delta` (typically ±1 for ↑/↓) over a list of
 * `length` rows, wrapping past either end. An empty list clamps to 0 so callers can
 * pass the result back without a special case.
 */
export function moveSelection(current: number, length: number, delta: number): number {
  if (length <= 0) return 0
  return (((current + delta) % length) + length) % length
}
