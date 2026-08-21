import { describe, it, expect } from 'vitest'
import {
  conversationReducer,
  initialConversationState,
  REBOUND_NOTICE,
  routineLateNotice,
  type AssistantItem,
  type ConversationState,
  type ErrorItem,
  type FallbackItem,
  type NoticeItem,
  type PermissionItem,
  type ReasoningItem,
  type ToolItem,
} from './reducer'

/**
 * Seam A: the pure reducer. We feed the captured read-turn `session/update`
 * sequence (verbatim shapes from docs/acp-capture.md §3–4) and assert the
 * ordered items, streamed reasoning + answer (accumulated by messageId), the
 * title, usage/cost, and the never-dropped generic fallback.
 */

const SESSION_ID = '8b7044cf-19d1-7a23-8da1-929c81b23170'

/** Wrap an `update` object in the `session/update` notification frame. */
function update(u: Record<string, unknown>): unknown {
  return { jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION_ID, update: u } }
}

function feed(state: ConversationState, payload: unknown): ConversationState {
  return conversationReducer(state, { type: 'acp-event', payload })
}

/** The verbatim read-turn stream: title, reasoning x2, answer x2, a read tool
 *  (a tool card since TB3), then usage. */
const READ_TURN: unknown[] = [
  update({ sessionUpdate: 'session_info_update', title: 'Read the README' }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Let me ' },
    messageId: 'r1',
  }),
  update({
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'check the file.' },
    messageId: 'r1',
  }),
  update({
    sessionUpdate: 'tool_call',
    toolCallId: 'EcjzekVw0',
    kind: 'read',
    status: 'pending',
    title: 'Read README.md',
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'The README ' },
    messageId: 'a1',
  }),
  update({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'describes vibe-mistro.' },
    messageId: 'a1',
  }),
  update({
    sessionUpdate: 'usage_update',
    used: 21047,
    size: 128000,
    cost: { amount: 0.0123, currency: 'USD' },
  }),
]

describe('conversationReducer (Seam A)', () => {
  it('reduces the captured read-turn stream into ordered items, title, and usage/cost', () => {
    const state = READ_TURN.reduce<ConversationState>(feed, initialConversationState)

    // Title from session_info_update.
    expect(state.title).toBe('Read the README')

    // Usage + cost from usage_update.
    expect(state.usage).toEqual({ used: 21047, size: 128000 })
    expect(state.cost).toEqual({ amount: 0.0123, currency: 'USD' })

    // Ordered items: reasoning (1, accumulated), tool card, assistant (1, accumulated).
    expect(state.items.map((i) => i.kind)).toEqual(['reasoning', 'tool', 'assistant'])

    const reasoning = state.items[0] as ReasoningItem
    expect(reasoning.messageId).toBe('r1')
    expect(reasoning.text).toBe('Let me check the file.')

    const assistant = state.items[2] as AssistantItem
    expect(assistant.messageId).toBe('a1')
    expect(assistant.text).toBe('The README describes vibe-mistro.')
  })

  it('accumulates deltas by messageId and keeps reasoning separate from the answer', () => {
    const state = READ_TURN.reduce<ConversationState>(feed, initialConversationState)
    const reasoning = state.items.filter((i) => i.kind === 'reasoning')
    const assistant = state.items.filter((i) => i.kind === 'assistant')
    // Each messageId collapses to exactly one item, regardless of chunk count.
    expect(reasoning).toHaveLength(1)
    expect(assistant).toHaveLength(1)
  })

  it('keeps interleaved messageIds as distinct items in first-arrival order, each accumulated', () => {
    // thoughtA, thoughtB, thoughtA — proves findIndex-by-(kind+messageId) routes
    // deltas to the right item rather than the most recent one.
    const state = [
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A1 ' }, messageId: 'a' }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'B1 ' }, messageId: 'b' }),
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'A2' }, messageId: 'a' }),
      // Two assistant messages in sequence → two assistant items.
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first' }, messageId: 'm1' }),
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second' }, messageId: 'm2' }),
    ].reduce<ConversationState>(feed, initialConversationState)

    const reasoning = state.items.filter((i): i is ReasoningItem => i.kind === 'reasoning')
    expect(reasoning.map((r) => r.messageId)).toEqual(['a', 'b']) // first-arrival order
    expect(reasoning[0].text).toBe('A1 A2') // accumulated despite the interleaved 'b'
    expect(reasoning[1].text).toBe('B1 ')

    const assistant = state.items.filter((i): i is AssistantItem => i.kind === 'assistant')
    expect(assistant.map((a) => a.messageId)).toEqual(['m1', 'm2'])
    expect(assistant.map((a) => a.text)).toEqual(['first', 'second'])
  })

  it('renders an unknown sessionUpdate as a generic fallback item (never dropped)', () => {
    const state = feed(
      initialConversationState,
      update({ sessionUpdate: 'some_future_kind', payloadField: 42 }),
    )
    expect(state.items).toHaveLength(1)
    const fallback = state.items[0] as FallbackItem
    expect(fallback.kind).toBe('fallback')
    expect(fallback.sessionUpdate).toBe('some_future_kind')
    expect(fallback.raw).toMatchObject({ sessionUpdate: 'some_future_kind', payloadField: 42 })
  })

  it('echoes the user prompt immediately and tracks turn lifecycle', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'read the readme',
    })
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'read the readme' })
    expect(state.isProcessing).toBe(true)

    state = conversationReducer(state, { type: 'turn-complete' })
    expect(state.isProcessing).toBe(false)
  })

  it('echoes image attachments on the sent user item (#100)', () => {
    const state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'what is in this image?',
      images: [{ previewUrl: 'data:image/png;base64,aGVsbG8=' }],
    })
    expect(state.items[0]).toMatchObject({
      kind: 'user',
      text: 'what is in this image?',
      images: [{ previewUrl: 'data:image/png;base64,aGVsbG8=' }],
    })
  })

  it('ignores non-session/update payloads (lifecycle, server requests)', () => {
    const before = initialConversationState
    const after = [
      { type: 'stderr', text: 'warning' },
      { jsonrpc: '2.0', id: 0, method: 'fs/read_text_file', params: { path: '/x' } },
      { method: 'session/update', params: {} }, // malformed: no update
    ].reduce<ConversationState>(feed, before)
    expect(after.items).toHaveLength(0)
    expect(after).toEqual(before)
  })

  it('available_commands_update is stored, not rendered', () => {
    const state = feed(
      initialConversationState,
      update({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'init', description: 'Initialize' }, { name: 'compact' }],
      }),
    )
    expect(state.items).toHaveLength(0)
    expect(state.availableCommands).toEqual([
      { name: 'init', description: 'Initialize' },
      { name: 'compact', description: undefined },
    ])
  })
})

/**
 * TB3 Seam A: the captured write-with-permission turn (docs/acp-capture.md §7).
 * Order: tool_call (pending edit) → request_permission → tool_call_update
 * (completed, rawOutput) → usage. We assert one tool item keyed by toolCallId
 * transitions pending → completed (merging rawOutput), and that the permission
 * server request becomes a permission item linked to that toolCallId.
 */

const TOOL_CALL_ID = 'EcjzekVw0'

/** Wrap a `session/request_permission` server request (agent → client). */
function permissionRequest(id: number | string): unknown {
  return {
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId: SESSION_ID,
      toolCall: { toolCallId: TOOL_CALL_ID },
      options: [
        { kind: 'allow_once', name: 'Allow once', optionId: 'allow_once' },
        { kind: 'allow_always', name: 'Allow for remainder of this session', optionId: 'allow_always' },
        { kind: 'allow_always', name: 'Always allow', optionId: 'allow_always_permanent' },
        { kind: 'reject_once', name: 'Deny', optionId: 'reject_once' },
      ],
    },
  }
}

const WRITE_TURN: unknown[] = [
  update({
    sessionUpdate: 'tool_call',
    toolCallId: TOOL_CALL_ID,
    kind: 'edit',
    status: 'pending',
    title: 'Write note.txt',
    locations: [{ path: '/abs/workspace/note.txt' }],
    content: [{ type: 'diff', path: '/abs/workspace/note.txt', newText: 'vibe-mistro works.' }],
  }),
  permissionRequest(0),
  update({
    sessionUpdate: 'tool_call_update',
    toolCallId: TOOL_CALL_ID,
    status: 'completed',
    rawOutput: { bytes_written: 19 },
  }),
  update({ sessionUpdate: 'usage_update', used: 21047, size: 128000 }),
]

describe('conversationReducer — write + permission (TB3 Seam A)', () => {
  it('reduces the captured write turn into one tool item that transitions pending → completed', () => {
    const state = WRITE_TURN.reduce<ConversationState>(feed, initialConversationState)

    // Exactly one tool item, keyed by toolCallId across tool_call + tool_call_update.
    const tools = state.items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    const tool = tools[0]
    expect(tool.toolCallId).toBe(TOOL_CALL_ID)
    expect(tool.id).toBe(`tool:${TOOL_CALL_ID}`)
    // tool_call_update merged: status advanced and rawOutput captured…
    expect(tool.status).toBe('completed')
    expect(tool.rawOutput).toEqual({ bytes_written: 19 })
    // …while fields only the original tool_call carried are preserved.
    expect(tool.toolKind).toBe('edit')
    expect(tool.title).toBe('Write note.txt')
    expect(tool.locations).toEqual([{ path: '/abs/workspace/note.txt' }])
    expect(tool.content).toHaveLength(1)
  })

  it('turns the request_permission server request into a permission item linked by toolCallId', () => {
    const state = WRITE_TURN.reduce<ConversationState>(feed, initialConversationState)
    const perms = state.items.filter((i): i is PermissionItem => i.kind === 'permission')
    expect(perms).toHaveLength(1)
    const perm = perms[0]
    expect(perm.requestId).toBe(0) // JSON-RPC id we must answer by (0 is valid)
    expect(perm.toolCallId).toBe(TOOL_CALL_ID)
    expect(perm.options.map((o) => o.optionId)).toEqual([
      'allow_once',
      'allow_always',
      'allow_always_permanent',
      'reject_once',
    ])
    expect(perm.chosenOptionId).toBeNull()
  })

  it('records the chosen option on resolve-permission so the prompt stops asking', () => {
    let state = WRITE_TURN.reduce<ConversationState>(feed, initialConversationState)
    state = conversationReducer(state, {
      type: 'resolve-permission',
      requestId: 0,
      optionId: 'allow_once',
      name: 'Allow once',
    })
    const perm = state.items.find((i): i is PermissionItem => i.kind === 'permission')!
    expect(perm.chosenOptionId).toBe('allow_once')
    expect(perm.chosenName).toBe('Allow once')
  })

  it('does not create a second tool item if tool_call_update arrives first (defensive merge)', () => {
    const state = [
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'X', status: 'completed', rawOutput: { ok: true } }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'X', kind: 'edit', status: 'pending', title: 'T' }),
    ].reduce<ConversationState>(feed, initialConversationState)
    const tools = state.items.filter((i): i is ToolItem => i.kind === 'tool')
    expect(tools).toHaveLength(1)
    // A later pending tool_call must not clobber an already-captured rawOutput.
    expect(tools[0].rawOutput).toEqual({ ok: true })
    expect(tools[0].title).toBe('T')
  })
})

describe('conversationReducer — hung-turn recovery (TB3)', () => {
  it('clears isProcessing and surfaces an error when the agent exits mid-turn', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'write a file',
    })
    expect(state.isProcessing).toBe(true)

    state = feed(state, { type: 'exit', info: { code: 1, signal: null } })
    expect(state.isProcessing).toBe(false)
    const err = state.items.find((i): i is ErrorItem => i.kind === 'error')
    expect(err?.message).toMatch(/exited/i)
  })

  it('ignores an agent exit when no turn is in flight (no phantom error)', () => {
    const state = feed(initialConversationState, { type: 'exit', info: { code: 0, signal: null } })
    expect(state.items).toHaveLength(0)
    expect(state.isProcessing).toBe(false)
  })

  it('the recover action re-enables input for a wedged (e.g. dismissed-permission) turn', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'write a file',
    })
    state = conversationReducer(state, { type: 'recover' })
    expect(state.isProcessing).toBe(false)
    expect(state.items.some((i) => i.kind === 'error')).toBe(true)
  })

  it('surfaces a failed turn (turn-error) as an item and ends processing', () => {
    let state = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'user:0',
      text: 'do thing',
    })
    state = conversationReducer(state, { type: 'turn-error', message: 'boom' })
    expect(state.isProcessing).toBe(false)
    const err = state.items.find((i): i is ErrorItem => i.kind === 'error')
    expect(err?.message).toBe('boom')
  })
})

/**
 * Transcript replay contract (TB2 #31, S2). The main process tees the turn
 * OUTCOME — which lives only in the `sendPrompt` IPC response, never an
 * `acp:event` — as `{t:'turn-complete'}` / `{t:'turn-error',message}` entries
 * (src/main/persistence/transcript.ts). This pins the renderer side of the
 * contract TB3 will exercise on reopen: those captured entries map 1:1 to the
 * `turn-complete` / `turn-error` actions and fold to the right state. The entry
 * shapes are declared as literals here — the composite project boundary blocks
 * importing the main-process constructors into a renderer test.
 */
describe('transcript replay contract: turn-outcome entries (TB2 S2)', () => {
  // The 1:1 entry -> action map TB3 replays the captured turn outcome through.
  type TurnOutcomeEntry = { t: 'turn-complete' } | { t: 'turn-error'; message: string }
  const asAction = (e: TurnOutcomeEntry) =>
    e.t === 'turn-complete' ? ({ type: 'turn-complete' } as const) : ({ type: 'turn-error', message: e.message } as const)

  it('a captured turn-complete entry replays to isProcessing=false (no stuck spinner)', () => {
    const entry: TurnOutcomeEntry = { t: 'turn-complete' }
    const next = conversationReducer({ ...initialConversationState, isProcessing: true }, asAction(entry))
    expect(next.isProcessing).toBe(false)
  })

  it('a captured turn-error entry replays to an ErrorItem and clears processing', () => {
    const entry: TurnOutcomeEntry = { t: 'turn-error', message: 'kaboom' }
    const next = conversationReducer({ ...initialConversationState, isProcessing: true }, asAction(entry))
    expect(next.isProcessing).toBe(false)
    expect(next.items.some((i): i is ErrorItem => i.kind === 'error' && i.message === 'kaboom')).toBe(true)
  })
})

/**
 * Switching to a live Thread (TB5 #34) seeds its reducer from the replayed JSONL
 * history before live events resume, via a `hydrate` action that REPLACES state
 * wholesale. This lets one mounted Conversation show a Thread's saved history and
 * then continue live, without a separate read-only view.
 */
describe('hydrate (TB5 switch-to-live seeding)', () => {
  it('replaces the whole state with the provided (replayed) state', () => {
    const replayed: ConversationState = {
      ...initialConversationState,
      title: 'Earlier thread',
      items: [{ kind: 'user', id: 'u1', text: 'hi from before' }],
    }
    const next = conversationReducer(
      { ...initialConversationState, title: 'stale', items: [{ kind: 'user', id: 'x', text: 'stale' }] },
      { type: 'hydrate', state: replayed },
    )
    expect(next).toEqual(replayed)
  })
})

/**
 * Agent context-reset notice (TB4 #33): a failed `session/load` resume re-binds a
 * fresh session, and the reducer weaves an honest "context reset" notice into the
 * conversation — NOT a turn error, so the composer stays usable.
 */
describe('agent-rebound (TB4 context reset notice)', () => {
  it('appends a notice item with the reset copy without disabling input', () => {
    const start: ConversationState = {
      ...initialConversationState,
      items: [{ kind: 'user', id: 'u1', text: 'continue please' }],
    }
    const next = conversationReducer(start, { type: 'agent-rebound' })

    const notice = next.items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.message).toBe(REBOUND_NOTICE)
    // The notice follows the user's prompt and is NOT an error item.
    expect(next.items.map((i) => i.kind)).toEqual(['user', 'notice'])
    expect(next.isProcessing).toBe(false)
    expect(next.items.some((i) => i.kind === 'error')).toBe(false)
  })
})

/**
 * A Routine's turn (#470, ADR-0028 part 5): the prompt is real input the agent
 * received which nobody typed, so it stays an ordinary user bubble and wears a
 * chip naming the Routine — and a run that started late says so, twice.
 */
describe('a routine turn', () => {
  it('keeps the prompt an ordinary user item, marked with the Routine that sent it', () => {
    const next = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'u1',
      text: 'Triage this repo and say what changed.',
      routine: { name: 'Morning triage' },
    })
    const user = next.items[0]
    expect(user).toMatchObject({ kind: 'user', routine: { name: 'Morning triage' } })
    // Still a normal turn in every other respect.
    expect(next.isProcessing).toBe(true)
  })

  it('leaves a prompt somebody typed unmarked', () => {
    const next = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'u1',
      text: 'hello',
    })
    expect(next.items[0]).toMatchObject({ kind: 'user', routine: undefined })
  })

  it('appends the late notice with BOTH timestamps, without ending the turn', () => {
    const dueAt = Date.UTC(2026, 7, 21, 7, 0)
    const lastRunAt = Date.UTC(2026, 7, 20, 7, 0)
    const next = conversationReducer(initialConversationState, {
      type: 'routine-late',
      dueAt,
      lastRunAt,
    })
    const notice = next.items.find((i): i is NoticeItem => i.kind === 'notice')
    expect(notice?.message).toBe(routineLateNotice(dueAt, lastRunAt))
    expect(notice?.message).toContain('covers the period since then')
    expect(next.items.some((i) => i.kind === 'error')).toBe(false)
  })

  it('says a Routine that NEVER ran never ran — not that it found nothing', () => {
    const message = routineLateNotice(Date.UTC(2026, 7, 21, 7, 0), null)
    expect(message).toContain('never run before')
    expect(message).not.toContain('covers the period since then')
  })
})

describe('system-notice', () => {
  it('surfaces a recoverable condition without ending the active turn', () => {
    const start: ConversationState = {
      ...initialConversationState,
      isProcessing: true,
      items: [{ kind: 'user', id: 'u1', text: 'continue with fallback settings' }],
    }

    const next = conversationReducer(start, {
      type: 'system-notice',
      message: 'Mode could not be applied.',
    })

    expect(next.items.map((item) => item.kind)).toEqual(['user', 'notice'])
    expect((next.items[1] as NoticeItem).message).toBe('Mode could not be applied.')
    expect(next.isProcessing).toBe(true)
  })
})

/**
 * Seam A — Subagents (#430). Frames are verbatim from docs/acp-capture.md §15,
 * a live capture against vibe-acp 2.24.1. These assert the conversation state a
 * user would see, never how it was computed.
 */
describe('conversationReducer — subagents (§15)', () => {
  const TOOL_ID = '8FuX35f6u'

  /** The bare opening frame: no agent, no task, no rawInput (§15 finding A). */
  const OPEN = update({
    sessionUpdate: 'tool_call',
    toolCallId: TOOL_ID,
    title: 'Running subagent',
    kind: 'think',
    status: 'in_progress',
    _meta: { tool_name: 'task', effect_kind: 'subagent' },
  })

  /** Identity lands one frame later. */
  const IDENTIFY = update({
    sessionUpdate: 'tool_call_update',
    toolCallId: TOOL_ID,
    kind: 'think',
    status: 'in_progress',
    title: 'Running explore agent: Summarise what this project does',
    rawInput: { task: 'Summarise what this project does', agent: 'explore' },
    _meta: {
      tool_name: 'task',
      effect_kind: 'subagent',
      agent: 'explore',
      task: 'Summarise what this project does',
    },
  })

  function progress(text: string): unknown {
    return update({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'text', text } }],
    })
  }

  function feedAll(frames: unknown[]): ConversationState {
    return frames.reduce<ConversationState>(feed, initialConversationState)
  }

  function toolItem(state: ConversationState, toolCallId = TOOL_ID): ToolItem {
    const item = state.items.find(
      (i): i is ToolItem => i.kind === 'tool' && i.toolCallId === toolCallId,
    )
    if (!item) throw new Error(`no tool item ${toolCallId}`)
    return item
  }

  it('carries _meta through and merges it across frames', () => {
    const state = feedAll([OPEN, IDENTIFY])
    expect(state.items).toHaveLength(1)
    expect(toolItem(state).meta).toMatchObject({
      effect_kind: 'subagent',
      agent: 'explore',
      task: 'Summarise what this project does',
    })
  })

  it('keeps the subagent tag when a later frame omits _meta entirely', () => {
    const bare = update({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
    })
    const state = feedAll([OPEN, bare])
    expect(toolItem(state).meta).toMatchObject({ effect_kind: 'subagent' })
  })

  it('ACCUMULATES the step ledger — the bug this slice fixes', () => {
    // §15 finding C: each frame carries ONE new entry, not the running list.
    const state = feedAll([
      OPEN,
      IDENTIFY,
      progress('read_file: Read 3 lines from alpha.py'),
      progress('read_file: Read 4 lines from beta.js'),
      progress('grep: 2 matches'),
    ])
    expect(toolItem(state).content).toHaveLength(3)
  })

  it('still REPLACES content for a non-subagent tool', () => {
    // The regression guard: appending blindly would duplicate diffs in the
    // file-change row, the most-used row in the app.
    const edit = (path: string) =>
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'edit-1',
        kind: 'edit',
        status: 'in_progress',
        content: [{ type: 'diff', path, oldText: 'a', newText: 'b' }],
      })
    const state = feedAll([
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit-1', kind: 'edit', status: 'pending' }),
      edit('one.ts'),
      edit('two.ts'),
    ])
    expect(toolItem(state, 'edit-1').content).toHaveLength(1)
  })

  it('surfaces the final response and turn count on completion', () => {
    const done = update({
      sessionUpdate: 'tool_call_update',
      toolCallId: TOOL_ID,
      status: 'completed',
      rawOutput: { response: 'It is a desktop app.', turnsUsed: 5, completed: true },
      _meta: { effect_kind: 'subagent', turn_count: 5, response: 'It is a desktop app.' },
    })
    const state = feedAll([OPEN, IDENTIFY, done])
    const item = toolItem(state)
    expect(item.status).toBe('completed')
    expect(item.meta).toMatchObject({ turn_count: 5, response: 'It is a desktop app.' })
  })

  it('surfaces an interrupted subagent as failed', () => {
    // §15: completed:false maps to ACP "failed" even though the effect finished.
    const state = feedAll([
      OPEN,
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: TOOL_ID,
        status: 'failed',
        rawOutput: { response: 'partial', turnsUsed: 2, completed: false },
      }),
    ])
    expect(toolItem(state).status).toBe('failed')
  })

  it('keeps a parallel fan-out as two independent items', () => {
    // §15 finding G: distinct toolCallIds, freely interleaved, one finishing
    // early must not make the other look finished.
    const openTwo = (id: string) =>
      update({
        sessionUpdate: 'tool_call',
        toolCallId: id,
        kind: 'think',
        status: 'in_progress',
        _meta: { tool_name: 'task', effect_kind: 'subagent', agent: 'explore' },
      })
    const state = feedAll([
      openTwo('6CjZc36Mi'),
      openTwo('nUL83qaSJ'),
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: '6CjZc36Mi',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'grep: done' } }],
      }),
    ])
    expect(state.items.filter((i) => i.kind === 'tool')).toHaveLength(2)
    expect(toolItem(state, '6CjZc36Mi').status).toBe('completed')
    expect(toolItem(state, 'nUL83qaSJ').status).toBe('in_progress')
    expect(toolItem(state, 'nUL83qaSJ').content).toHaveLength(0)
  })

  it('leaves a malformed _meta as an ordinary tool item', () => {
    const state = feedAll([
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'plain-1',
        kind: 'read',
        status: 'pending',
        _meta: 'nonsense',
      }),
    ])
    const item = toolItem(state, 'plain-1')
    expect(item.kind).toBe('tool')
    expect(item.meta).toBe('nonsense')
  })
})

describe('conversationReducer — orphan permission requests (§15 finding F)', () => {
  function permission(toolCallId: string | null): unknown {
    return {
      jsonrpc: '2.0',
      id: 7,
      method: 'session/request_permission',
      params: {
        sessionId: SESSION_ID,
        ...(toolCallId === null ? {} : { toolCall: { toolCallId } }),
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
      },
    }
  }

  function permissionItem(state: ConversationState): PermissionItem {
    const item = state.items.find((i): i is PermissionItem => i.kind === 'permission')
    if (!item) throw new Error('no permission item')
    return item
  }

  it('flags a request whose toolCallId matches nothing — a subagent asking', () => {
    // The child session's tool call id; the client never received a tool_call for it.
    const state = feed(initialConversationState, permission('v1KK2WmAn'))
    expect(permissionItem(state).orphan).toBe(true)
  })

  it('does NOT flag a request that matches a tool call we have', () => {
    const withTool = feed(
      initialConversationState,
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'EcjzekVw0',
        kind: 'edit',
        status: 'pending',
      }),
    )
    const state = feed(withTool, permission('EcjzekVw0'))
    expect(permissionItem(state).orphan).toBe(false)
  })

  it('does NOT flag a request carrying no toolCallId at all', () => {
    // A session-level prompt is not mis-attributed, just unlinked.
    const state = feed(initialConversationState, permission(null))
    expect(permissionItem(state).orphan).toBe(false)
  })

  it('still answers by requestId, orphan or not', () => {
    const asked = feed(initialConversationState, permission('v1KK2WmAn'))
    const answered = conversationReducer(asked, {
      type: 'resolve-permission',
      requestId: 7,
      optionId: 'allow',
      name: 'Allow',
    })
    expect(permissionItem(answered).chosenOptionId).toBe('allow')
    expect(permissionItem(answered).orphan).toBe(true)
  })
})

describe('conversationReducer — user_message_chunk echo (#438)', () => {
  it('ignores the echo instead of adding a fallback row under every message', () => {
    const state = feed(
      initialConversationState,
      update({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Summarise this project' },
        messageId: 'u1',
      }),
    )
    expect(state.items).toHaveLength(0)
  })

  it('leaves an optimistic user message untouched — no duplicate', () => {
    const sent = conversationReducer(initialConversationState, {
      type: 'send-prompt',
      id: 'local-1',
      text: 'Summarise this project',
    })
    const state = feed(
      sent,
      update({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Summarise this project' },
        messageId: 'u1',
      }),
    )
    expect(state.items.filter((i) => i.kind === 'user')).toHaveLength(1)
  })

  it('still falls back for genuinely unknown kinds — nothing else is silenced', () => {
    const state = feed(initialConversationState, update({ sessionUpdate: 'some_future_kind' }))
    expect(state.items.map((i) => i.kind)).toEqual(['fallback'])
  })
})
