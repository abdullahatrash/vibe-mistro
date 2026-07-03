import { describe, expect, it, vi } from 'vitest'
import {
  commandsFromEvent,
  foldCommandsEvent,
  getWorkspaceCommands,
  subscribeWorkspaceCommands,
  WORKSPACE_COMMANDS_STORAGE_KEY,
  type CommandsStorage,
} from './workspace-commands'

/** An in-memory CommandsStorage double. */
function fakeStorage(seed: Record<string, string> = {}): CommandsStorage & { data: Record<string, string> } {
  const data = { ...seed }
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value
    },
  }
}

/** A wire-shaped `available_commands_update` (acp-capture §4). */
function commandsEvent(commands: unknown): unknown {
  return {
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
    },
  }
}

describe('commandsFromEvent', () => {
  it('extracts the commands list from an available_commands_update payload', () => {
    const payload = commandsEvent([
      { name: 'teach', description: 'Teach mode' },
      { name: 'review' },
    ])
    expect(commandsFromEvent(payload)).toEqual([
      { name: 'teach', description: 'Teach mode' },
      { name: 'review', description: undefined },
    ])
  })

  it('returns null for any other payload', () => {
    expect(
      commandsFromEvent({
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } },
      }),
    ).toBeNull()
    expect(commandsFromEvent({ method: 'exit' })).toBeNull()
    expect(commandsFromEvent(null)).toBeNull()
  })

  it('drops malformed entries but keeps the well-formed rest', () => {
    const payload = commandsEvent([{ name: 'ok' }, { description: 'no name' }, 'junk', null])
    expect(commandsFromEvent(payload)).toEqual([{ name: 'ok', description: undefined }])
  })
})

describe('foldCommandsEvent / getWorkspaceCommands', () => {
  it('folds an update into the live cache and serves it back', () => {
    const storage = fakeStorage()
    foldCommandsEvent(storage, 'ws-live', commandsEvent([{ name: 'teach' }]))
    expect(getWorkspaceCommands(storage, 'ws-live')).toEqual([{ name: 'teach', description: undefined }])
  })

  it('ignores non-command events entirely (no write, no notify)', () => {
    const storage = fakeStorage()
    const listener = vi.fn()
    const off = subscribeWorkspaceCommands(listener)
    foldCommandsEvent(storage, 'ws-noop', { method: 'exit' })
    expect(getWorkspaceCommands(storage, 'ws-noop')).toEqual([])
    expect(listener).not.toHaveBeenCalled()
    off()
  })

  it('persists the folded list and seeds a fresh read from storage (cold reopen)', () => {
    const storage = fakeStorage()
    foldCommandsEvent(storage, 'ws-persist', commandsEvent([{ name: 'plan', description: 'Plan' }]))
    // Simulate a restart: a NEW storage carrying the old blob, an unseen workspace key
    // in the live cache is impossible to fake here, so use a distinct workspace id whose
    // entry exists ONLY in storage.
    const blob = storage.getItem(WORKSPACE_COMMANDS_STORAGE_KEY)!
    const restarted = fakeStorage({ [WORKSPACE_COMMANDS_STORAGE_KEY]: blob.replace('ws-persist', 'ws-cold') })
    expect(getWorkspaceCommands(restarted, 'ws-cold')).toEqual([{ name: 'plan', description: 'Plan' }])
  })

  it('returns a STABLE empty list and tolerates malformed storage', () => {
    const storage = fakeStorage({ [WORKSPACE_COMMANDS_STORAGE_KEY]: '{not json' })
    const first = getWorkspaceCommands(storage, 'ws-broken')
    expect(first).toEqual([])
    expect(getWorkspaceCommands(storage, 'ws-broken')).toBe(first) // useSyncExternalStore-stable
  })

  it('a later update replaces the list and notifies subscribers', () => {
    const storage = fakeStorage()
    foldCommandsEvent(storage, 'ws-replace', commandsEvent([{ name: 'old' }]))
    const listener = vi.fn()
    const off = subscribeWorkspaceCommands(listener)
    foldCommandsEvent(storage, 'ws-replace', commandsEvent([{ name: 'new' }]))
    expect(getWorkspaceCommands(storage, 'ws-replace')).toEqual([{ name: 'new', description: undefined }])
    expect(listener).toHaveBeenCalled()
    off()
  })
})
