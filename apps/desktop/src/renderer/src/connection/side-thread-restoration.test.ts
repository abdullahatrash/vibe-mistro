import { describe, expect, it, vi } from 'vitest'
import type { ListMetadataResult } from '../../../shared/ipc'
import { reconcileRestoredSideThreadPlacement } from './side-thread-restoration'

const METADATA: ListMetadataResult = []

describe('reconcileRestoredSideThreadPlacement', () => {
  it('does nothing while metadata is loading instead of treating it as an empty result', () => {
    const reconcile = vi.fn()
    reconcileRestoredSideThreadPlacement(null, reconcile)
    expect(reconcile).not.toHaveBeenCalled()
  })

  it('validates restored metadata without starting or consulting any live Thread state', () => {
    const reconcile = vi.fn()
    reconcileRestoredSideThreadPlacement(METADATA, reconcile)
    expect(reconcile).toHaveBeenCalledWith(METADATA, {})
  })
})
