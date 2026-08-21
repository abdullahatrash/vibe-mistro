import { describe, expect, it } from 'vitest'
import {
  createRoutinePermissionGate,
  decideRoutinePermission,
  type RoutinePermissionGate,
} from './routine-permission-gate'

/**
 * The answerer (#469, ADR-0028 part 4 — the ADR-0001 amendment): main answers a
 * scheduled turn's `session/request_permission` from the Routine's allowed
 * commands, and the first refusal cancels the turn.
 *
 * The frames below are VERBATIM from `scripts/spike-routine-gate.ts` against
 * vibe-acp 2.24.3 (`docs/acp-capture.md` §17) — including the one that decides the
 * whole design: for `echo hello > probe.txt` the request's own
 * `invocation_pattern` reads `echo hello <redirect>`, with the redirect erased.
 * A gate that matched on that string would authorise a command that writes a file
 * the string never mentions.
 */

const SESSION = '7f2a997d-b167-df48-29e8-0d5e578bfa87'
const TOOL_CALL = 'sbjyDUwlc'

/** The `tool_call` frame, exactly as captured: a title, no command yet. */
const toolCall = (toolCallId = TOOL_CALL): unknown => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: SESSION,
    update: {
      toolCallId,
      title: 'bash',
      kind: 'execute',
      status: 'in_progress',
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
      sessionUpdate: 'tool_call',
    },
  },
})

/** The update that carries `rawInput.command` — the only trustworthy copy. */
const toolCallCommand = (command: string, toolCallId = TOOL_CALL): unknown => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: SESSION,
    update: {
      toolCallId,
      kind: 'execute',
      status: 'in_progress',
      title: `bash: ${command}`,
      rawInput: { command },
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
      sessionUpdate: 'tool_call_update',
    },
  },
})

/** The status-only update that immediately precedes the request — no rawInput. */
const toolCallTick = (toolCallId = TOOL_CALL): unknown => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: SESSION,
    update: {
      toolCallId,
      kind: 'execute',
      status: 'in_progress',
      _meta: { tool_name: 'bash', effect_kind: 'shell' },
      sessionUpdate: 'tool_call_update',
    },
  },
})

/** The request itself: a tool-call id, four options, and a tokenised pattern. */
const permissionRequest = (
  invocationPattern: string,
  { id = 0, toolCallId = TOOL_CALL, sessionId = SESSION, scope = 'command_pattern' } = {},
): unknown => ({
  jsonrpc: '2.0',
  id,
  method: 'session/request_permission',
  params: {
    sessionId,
    toolCall: { toolCallId },
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      {
        optionId: 'allow_always',
        name: 'Allow for remainder of this session',
        kind: 'allow_always',
        _meta: {
          required_permissions: [
            { scope, invocation_pattern: invocationPattern, session_pattern: 'echo *', label: 'echo *' },
          ],
        },
      },
      {
        optionId: 'allow_always_permanent',
        name: 'Always allow',
        kind: 'allow_always',
        _meta: {
          required_permissions: [
            { scope, invocation_pattern: invocationPattern, session_pattern: 'echo *', label: 'echo *' },
          ],
        },
      },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
    ],
  },
})

interface Harness {
  gate: RoutinePermissionGate
  answers: { requestId: number | string; optionId: string }[]
  cancels: string[]
}

function harness(allowedCommands: string[] = []): Harness {
  const answers: { requestId: number | string; optionId: string }[] = []
  const cancels: string[] = []
  const gate = createRoutinePermissionGate({
    allowedCommands,
    seams: {
      respond: (requestId, optionId) => void answers.push({ requestId, optionId }),
      cancel: (sessionId) => void cancels.push(sessionId),
    },
  })
  gate.armSession(SESSION)
  return { gate, answers, cancels }
}

describe('decideRoutinePermission', () => {
  const options = (permissionRequest('x') as { params: { options: [] } }).params.options

  it('allows a listed command with allow_once — never either allow-always option', () => {
    const decision = decideRoutinePermission({
      options,
      facts: { toolName: 'bash', effectKind: 'shell', command: 'ls -la' },
      allowedCommands: ['ls -la'],
    })
    // "Allow for remainder of this session" is a session grant and "Always allow"
    // is a PERMANENT config write (#464). An unattended run widens nothing.
    expect(decision).toEqual({ kind: 'allow', optionId: 'allow_once', command: 'ls -la' })
  })

  it('denies a tool call it has never seen — a subagent’s, for instance', () => {
    // acp-capture §15F: a subagent's tool calls raise requests on the ROOT session
    // with ids that never appear in any `tool_call` frame. Unattended, the only
    // answer to something unidentifiable is no.
    expect(decideRoutinePermission({ options, facts: null, allowedCommands: ['ls'] })).toEqual({
      kind: 'deny',
      optionId: 'reject_once',
      blocked: { command: null, reason: 'unidentified' },
    })
  })

  it('denies anything that is not a shell effect, whatever the list says', () => {
    const decision = decideRoutinePermission({
      options,
      facts: { toolName: 'write_file', effectKind: 'file_write', command: 'ls' },
      allowedCommands: ['ls'],
    })
    expect(decision).toMatchObject({ kind: 'deny', blocked: { reason: 'unidentified' } })
  })

  it('denies when the request is about a scope other than a command pattern', () => {
    const other = permissionRequest('/tmp/scratch/*', { scope: 'outside_directory' }) as {
      params: { options: [] }
    }
    const decision = decideRoutinePermission({
      options: other.params.options,
      facts: { toolName: 'bash', effectKind: 'shell', command: 'ls' },
      allowedCommands: ['ls'],
    })
    expect(decision).toMatchObject({ kind: 'deny', blocked: { reason: 'unidentified' } })
  })

  it('denies a shell call whose command text was never readable', () => {
    const decision = decideRoutinePermission({
      options,
      facts: { toolName: 'bash', effectKind: 'shell', command: null },
      allowedCommands: ['ls'],
    })
    expect(decision).toMatchObject({ kind: 'deny', blocked: { command: null, reason: 'blank' } })
  })

  it('falls back to the standard option ids when the request offers no kinds', () => {
    expect(
      decideRoutinePermission({
        options: [{ optionId: 'weird' }],
        facts: { toolName: 'bash', effectKind: 'shell', command: 'ls' },
        allowedCommands: ['ls'],
      }),
    ).toMatchObject({ kind: 'allow', optionId: 'allow_once' })
  })
})

describe('createRoutinePermissionGate', () => {
  it('recovers the command from an EARLIER frame than the one before the request', () => {
    // The captured order: tool_call, then the update carrying rawInput, then a
    // status-only tick, then the request. A gate that read the last frame would
    // find no command and deny a command the user had allowed.
    const { gate, answers, cancels } = harness(['ls -la'])
    gate.observe(toolCall())
    gate.observe(toolCallCommand('ls -la'))
    gate.observe(toolCallTick())
    gate.observe(permissionRequest('ls -la'))
    expect(answers).toEqual([{ requestId: 0, optionId: 'allow_once' }])
    expect(cancels).toEqual([])
    expect(gate.blocked).toBeNull()
  })

  it('THE REDIRECT: denies and cancels, and reports the RAW command, not the pattern', () => {
    const { gate, answers, cancels } = harness(['echo hello'])
    gate.observe(toolCall())
    gate.observe(toolCallCommand('echo hello > probe.txt'))
    gate.observe(permissionRequest('echo hello <redirect>'))
    expect(answers).toEqual([{ requestId: 0, optionId: 'reject_once' }])
    expect(cancels).toEqual([SESSION])
    // The reported command is what would have RUN — `echo hello > probe.txt` —
    // not the tokenised `echo hello <redirect>` the request carried, and not the
    // listed `echo hello` it would otherwise have been mistaken for.
    expect(gate.blocked).toEqual({ command: 'echo hello > probe.txt', reason: 'shell-operator' })
  })

  it('cancels ONCE: a second refusal is still answered, but nothing is overwritten', () => {
    const { gate, answers, cancels } = harness([])
    gate.observe(toolCall('one'))
    gate.observe(toolCallCommand('ls', 'one'))
    gate.observe(permissionRequest('ls', { id: 0, toolCallId: 'one' }))
    gate.observe(toolCall('two'))
    gate.observe(toolCallCommand('pwd', 'two'))
    gate.observe(permissionRequest('pwd', { id: 1, toolCallId: 'two' }))
    expect(answers).toEqual([
      { requestId: 0, optionId: 'reject_once' },
      { requestId: 1, optionId: 'reject_once' },
    ])
    expect(cancels).toEqual([SESSION])
    expect(gate.blocked).toEqual({ command: 'ls', reason: 'not-listed' })
  })

  it('ignores another session on the same agent, and everything before it is armed', () => {
    // One `vibe-acp` child hosts many sessions, and a person may be talking to
    // another Thread in the same Workspace while a routine runs. Answering their
    // permission request would be answering for a user who is right there.
    const { gate, answers, cancels } = harness(['ls'])
    gate.observe(permissionRequest('ls', { sessionId: 'someone-elses-session' }))
    expect(answers).toEqual([])
    expect(cancels).toEqual([])

    const cold = createRoutinePermissionGate({
      allowedCommands: ['ls'],
      seams: { respond: () => expect.unreachable(), cancel: () => expect.unreachable() },
    })
    cold.observe(permissionRequest('ls'))
    expect(cold.blocked).toBeNull()
  })

  it('survives malformed payloads without throwing', () => {
    const { gate, answers } = harness(['ls'])
    for (const payload of [null, undefined, 42, 'text', {}, { method: 'session/update' }]) {
      expect(() => gate.observe(payload)).not.toThrow()
    }
    // A permission with no id is a notification we cannot answer; it must not
    // silently look answered either.
    gate.observe({ method: 'session/request_permission', params: { sessionId: SESSION } })
    expect(answers).toEqual([])
  })
})
