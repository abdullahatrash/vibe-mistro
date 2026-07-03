import { describe, expect, it } from 'vitest'
import { firstAvailableEditor, openFailureMessage } from './open-in-editor'

describe('firstAvailableEditor', () => {
  it('picks the first available editor in TABLE order, not wire order', () => {
    expect(firstAvailableEditor(['zed', 'cursor'])).toEqual({ id: 'cursor', label: 'Cursor' })
  })

  it('falls through to a lone detected editor', () => {
    expect(firstAvailableEditor(['file-manager'])).toEqual({
      id: 'file-manager',
      label: 'File Manager',
    })
  })

  it('returns null when nothing is detected', () => {
    expect(firstAvailableEditor([])).toBeNull()
  })
})

describe('openFailureMessage', () => {
  it('names the editor in CLI/launch failures', () => {
    expect(openFailureMessage('command-not-found', 'Zed')).toBe('Zed CLI not found on PATH')
    expect(openFailureMessage('spawn-failed', 'Zed')).toBe("Couldn't launch Zed")
  })

  it('covers the workspace/editor identity failures', () => {
    expect(openFailureMessage('unknown-workspace', 'Zed')).toBe('Project not found')
    expect(openFailureMessage('unknown-editor', 'Zed')).toBe('Unknown editor')
  })
})
