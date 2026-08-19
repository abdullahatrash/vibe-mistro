import type { ToolItem } from './reducer'

/**
 * Interpret a Subagent tool call — Vibe's `task` tool on the wire
 * (docs/acp-capture.md §15).
 *
 * A Subagent is NOT a distinct `sessionUpdate` kind: it arrives as an ordinary
 * `tool_call` whose ACP `kind` is `think`, tagged only by `_meta.effect_kind`.
 * Everything that identifies it rides in `_meta`, which the reducer carries
 * through opaquely — all interpretation lives here so it stays testable without
 * rendering a row (tests run in `node`, there is no DOM).
 *
 * `_meta` is snake_case ON THE WIRE (`child_session_id`, `turn_count`) while
 * `rawOutput` is camelCase (`turnsUsed`) — two conventions in one tool call. We
 * accept either spelling everywhere, the same defensiveness `file-change.ts`
 * applies to diffs, so a serializer change can't silently blank the row.
 */

/** `_meta.effect_kind` value that marks a tool call as a Subagent run. */
const SUBAGENT_EFFECT_KIND = 'subagent'

/** What a Subagent tool call tells us about itself. Every field may be absent. */
export interface SubagentMeta {
  /** The subagent profile that ran, e.g. `explore`. */
  agent: string | null
  /** The task it was handed. */
  task: string | null
  /** Vibe's child session id — correlation only; we never read that session. */
  childSessionId: string | null
  /** Turns the subagent used. NOT a step count — see `subagentSteps`. */
  turnCount: number | null
  /** Its final answer, authored prose. */
  response: string | null
}

/**
 * Is this tool call a Subagent run?
 *
 * Keyed on `_meta.effect_kind` and NEVER on the title: the first `tool_call`
 * frame carries the bare placeholder title `"Running subagent"` with no
 * identity at all (§15 finding A), and the real title only arrives a frame
 * later. Anything unrecognized falls through to the generic tool row.
 */
export function isSubagentTool(item: ToolItem): boolean {
  return readString(metaOf(item), 'effect_kind', 'effectKind') === SUBAGENT_EFFECT_KIND
}

/**
 * Pull the Subagent's identity out of `_meta`, falling back to `rawInput` /
 * `rawOutput` where the same value appears in both.
 *
 * All fields are nullable by design: the first frame has only `tool_name` +
 * `effect_kind`, `agent`/`task` land on the next frame, and `child_session_id`
 * on the one after. The row renders each state as it comes.
 */
export function readSubagentMeta(item: ToolItem): SubagentMeta {
  const meta = metaOf(item)
  const input = asRecord(item.rawInput)
  const output = asRecord(item.rawOutput)

  return {
    agent: readString(meta, 'agent') ?? readString(input, 'agent'),
    task: readString(meta, 'task') ?? readString(input, 'task'),
    childSessionId: readString(meta, 'child_session_id', 'childSessionId'),
    turnCount: readNumber(meta, 'turn_count', 'turnCount') ?? readNumber(output, 'turnsUsed'),
    response: readString(meta, 'response') ?? readString(output, 'response'),
  }
}

/**
 * The step ledger — one line per subagent tool call, streamed live as
 * `{type:'content',content:{type:'text',text:'read_file: Read 3 lines'}}`.
 *
 * DELIBERATELY UNCOUNTED. Vibe emits a line only for a SUCCEEDED child tool
 * call: a captured run with `succeeded:3, failed:9` streamed three lines, and
 * `turn_count` matched neither number (§15 finding D). These lines are
 * therefore a sample of the work, never an inventory of it — never present
 * `steps.length` as "what the Subagent did".
 */
export function subagentSteps(item: ToolItem): string[] {
  const steps: string[] = []
  for (const value of item.content) {
    const entry = asRecord(value)
    if (!entry || entry.type !== 'content') continue
    const inner = asRecord(entry.content)
    if (!inner || inner.type !== 'text') continue
    if (typeof inner.text !== 'string' || inner.text.length === 0) continue
    steps.push(inner.text)
  }
  return steps
}

/**
 * Heading for the collapsed row. Falls back while `_meta` is still filling in,
 * so the row is never blank and never claims an identity it doesn't have yet.
 */
export function subagentHeading(meta: SubagentMeta): string {
  return meta.agent ? `${meta.agent} subagent` : 'Subagent starting…'
}

/** `"5 turns"` for the row's detail line, or null when Vibe hasn't said. */
export function subagentTurnLabel(meta: SubagentMeta): string | null {
  if (meta.turnCount === null) return null
  return `${meta.turnCount} ${meta.turnCount === 1 ? 'turn' : 'turns'}`
}

/**
 * The dimmed line beside the heading in the COLLAPSED row.
 *
 * While the Subagent runs it shows its latest step, so a long delegation
 * visibly progresses instead of sitting frozen on its task for minutes. Once
 * settled the task returns — that is what you want to read afterwards, and the
 * steps are a fold away.
 *
 * Falls back to the task whenever no step has arrived yet: Vibe emits a line
 * only for a SUCCEEDED child tool call, so an early or unlucky run can be
 * several turns in with an empty ledger.
 */
export function subagentDetail(
  meta: SubagentMeta,
  steps: readonly string[],
  running: boolean,
): string | null {
  if (running && steps.length > 0) return steps[steps.length - 1]
  return meta.task
}

function metaOf(item: ToolItem): Record<string, unknown> | null {
  return asRecord(item.meta)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** First non-empty string among `keys`, or null. */
function readString(source: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!source) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

/** First finite number among `keys`, or null. */
function readNumber(source: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!source) return null
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}
