import { describe, expect, it } from 'vitest'
import { updateReadyLabel } from './app-update-view'
import type { AppUpdateStatusEvent } from '../../../shared/ipc'

describe('updateReadyLabel', () => {
  it('renders nothing for every non-ready phase — the affordance is passive', () => {
    for (const phase of ['idle', 'checking', 'downloading', 'error'] as const) {
      const status: AppUpdateStatusEvent = { phase, version: '0.2.0', error: null }
      expect(updateReadyLabel(status)).toBeNull()
    }
  })

  it('labels a ready download with its Release version', () => {
    expect(updateReadyLabel({ phase: 'ready', version: '0.2.0', error: null })).toBe(
      'Update ready · v0.2.0',
    )
  })

  it('falls back to a plain label when the feed carried no version', () => {
    expect(updateReadyLabel({ phase: 'ready', version: null, error: null })).toBe('Update ready')
  })
})
