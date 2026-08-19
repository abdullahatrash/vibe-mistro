import { describe, it, expect } from 'vitest'
import {
  isSubagentTool,
  readSubagentMeta,
  subagentSteps,
  subagentHeading,
  subagentTurnLabel,
  subagentDetail,
} from './subagent'
import type { ToolItem } from './reducer'

/**
 * Seam 2: the pure Subagent interpreter. Fed the verbatim `_meta` / content
 * shapes captured in docs/acp-capture.md §15 — snake_case on `_meta`,
 * camelCase inside `rawOutput`.
 */

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool',
    id: 'tool:8FuX35f6u',
    toolCallId: '8FuX35f6u',
    toolKind: 'think',
    status: 'in_progress',
    title: 'Running subagent',
    locations: [],
    rawInput: undefined,
    rawOutput: undefined,
    content: [],
    ...overrides,
  }
}

/** A step line exactly as it arrives on the wire (§15 finding D). */
function step(text: string): unknown {
  return { type: 'content', content: { type: 'text', text } }
}

describe('isSubagentTool', () => {
  it('detects the bare FIRST frame, which has no identity yet', () => {
    // §15 finding A: the opening tool_call carries only these two keys.
    expect(isSubagentTool(tool({ meta: { tool_name: 'task', effect_kind: 'subagent' } }))).toBe(true)
  })

  it('accepts camelCase effectKind defensively', () => {
    expect(isSubagentTool(tool({ meta: { effectKind: 'subagent' } }))).toBe(true)
  })

  it('is false for an ordinary tool call', () => {
    expect(isSubagentTool(tool({ toolKind: 'read', meta: undefined }))).toBe(false)
  })

  it('is false for a think-kind tool that is NOT a subagent', () => {
    // `kind: "think"` alone must never imply a subagent — real reasoning tools share it.
    expect(isSubagentTool(tool({ toolKind: 'think', meta: { effect_kind: 'reasoning' } }))).toBe(
      false,
    )
  })

  it('never keys on the title', () => {
    // The placeholder title is present on a frame with no meta at all.
    expect(isSubagentTool(tool({ title: 'Running subagent', meta: undefined }))).toBe(false)
  })

  it('survives a malformed meta without throwing', () => {
    expect(isSubagentTool(tool({ meta: 'nonsense' }))).toBe(false)
    expect(isSubagentTool(tool({ meta: null }))).toBe(false)
    expect(isSubagentTool(tool({ meta: ['effect_kind'] }))).toBe(false)
  })
})

describe('readSubagentMeta', () => {
  it('reads the snake_case wire shape', () => {
    const meta = readSubagentMeta(
      tool({
        meta: {
          tool_name: 'task',
          effect_kind: 'subagent',
          agent: 'explore',
          task: 'Summarise what this project does',
          child_session_id: '178132b8-aaaa-bbbb-cccc-ddddeeeeffff',
          turn_count: 5,
          response: 'It is a desktop app.',
        },
      }),
    )
    expect(meta).toEqual({
      agent: 'explore',
      task: 'Summarise what this project does',
      childSessionId: '178132b8-aaaa-bbbb-cccc-ddddeeeeffff',
      turnCount: 5,
      response: 'It is a desktop app.',
    })
  })

  it('accepts camelCase spellings too', () => {
    const meta = readSubagentMeta(
      tool({ meta: { effectKind: 'subagent', childSessionId: 'c1', turnCount: 2 } }),
    )
    expect(meta.childSessionId).toBe('c1')
    expect(meta.turnCount).toBe(2)
  })

  it('falls back to rawInput and rawOutput', () => {
    // rawOutput is camelCase while _meta is snake_case — both in one tool call.
    const meta = readSubagentMeta(
      tool({
        meta: { effect_kind: 'subagent' },
        rawInput: { task: 'Read the README', agent: 'explore' },
        rawOutput: { response: 'Done.', turnsUsed: 3, completed: true },
      }),
    )
    expect(meta.agent).toBe('explore')
    expect(meta.task).toBe('Read the README')
    expect(meta.response).toBe('Done.')
    expect(meta.turnCount).toBe(3)
  })

  it('prefers _meta over rawOutput when both are present', () => {
    const meta = readSubagentMeta(
      tool({ meta: { effect_kind: 'subagent', turn_count: 9 }, rawOutput: { turnsUsed: 1 } }),
    )
    expect(meta.turnCount).toBe(9)
  })

  it('returns all-null for the bare first frame', () => {
    const meta = readSubagentMeta(tool({ meta: { tool_name: 'task', effect_kind: 'subagent' } }))
    expect(meta).toEqual({
      agent: null,
      task: null,
      childSessionId: null,
      turnCount: null,
      response: null,
    })
  })

  it('ignores wrong-typed and empty values rather than surfacing them', () => {
    const meta = readSubagentMeta(
      tool({ meta: { effect_kind: 'subagent', agent: '', turn_count: 'five', response: 42 } }),
    )
    expect(meta.agent).toBeNull()
    expect(meta.turnCount).toBeNull()
    expect(meta.response).toBeNull()
  })
})

describe('subagentSteps', () => {
  it('derives the ledger from wire content entries', () => {
    const item = tool({
      content: [step('read_file: Read 3 lines from alpha.py'), step('grep: 2 matches')],
    })
    expect(subagentSteps(item)).toEqual([
      'read_file: Read 3 lines from alpha.py',
      'grep: 2 matches',
    ])
  })

  it('is empty before anything has streamed', () => {
    expect(subagentSteps(tool())).toEqual([])
  })

  it('skips entries that are not text content', () => {
    const item = tool({
      content: [
        { type: 'diff', path: 'a.ts' },
        step('read_file: ok'),
        { type: 'content', content: { type: 'image' } },
        null,
        'garbage',
      ],
    })
    expect(subagentSteps(item)).toEqual(['read_file: ok'])
  })

  it('exposes no count — the ledger is a sample, not an inventory', () => {
    // §15 finding D: only SUCCEEDED child tool calls emit a line (a captured run
    // logged succeeded:3 failed:9 and streamed 3). Nothing here may be presented
    // as "what the subagent did", so the module offers no count helper at all.
    const module = { isSubagentTool, readSubagentMeta, subagentSteps }
    expect(Object.keys(module)).not.toContain('subagentStepCount')
  })
})

describe('subagentHeading / subagentTurnLabel', () => {
  it('names the agent once known', () => {
    expect(subagentHeading(readSubagentMeta(tool({ meta: { agent: 'explore' } })))).toBe(
      'explore subagent',
    )
  })

  it('shows a starting placeholder while the first frame is bare', () => {
    expect(subagentHeading(readSubagentMeta(tool({ meta: { effect_kind: 'subagent' } })))).toBe(
      'Subagent starting…',
    )
  })

  it('pluralises turns and stays silent when unknown', () => {
    expect(subagentTurnLabel(readSubagentMeta(tool({ meta: { turn_count: 1 } })))).toBe('1 turn')
    expect(subagentTurnLabel(readSubagentMeta(tool({ meta: { turn_count: 5 } })))).toBe('5 turns')
    expect(subagentTurnLabel(readSubagentMeta(tool({ meta: {} })))).toBeNull()
  })
})

describe('subagentDetail', () => {
  const meta = { agent: 'explore', task: 'Summarise the project', childSessionId: null, turnCount: null, response: null }

  it('shows the latest step while running, so a long run visibly progresses', () => {
    expect(subagentDetail(meta, ['read_file: a.py', 'grep: 2 matches'], true)).toBe('grep: 2 matches')
  })

  it('falls back to the task when running but nothing has streamed yet', () => {
    // Only SUCCEEDED child tool calls emit a line — an early run has an empty ledger.
    expect(subagentDetail(meta, [], true)).toBe('Summarise the project')
  })

  it('returns to the task once settled', () => {
    expect(subagentDetail(meta, ['grep: 2 matches'], false)).toBe('Summarise the project')
  })

  it('is null when there is neither task nor step', () => {
    expect(subagentDetail({ ...meta, task: null }, [], true)).toBeNull()
  })
})
