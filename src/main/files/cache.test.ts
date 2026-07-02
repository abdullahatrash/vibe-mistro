import { describe, expect, it } from 'vitest'
import type { FilesListResult } from '../../shared/ipc'
import { FilesListCache, shouldInvalidateFilesCacheOnGitStatus } from './cache'

const RESULT: FilesListResult = { entries: [{ path: 'a.ts', kind: 'file' }], truncated: false }

describe('FilesListCache', () => {
  it('stores and serves per Workspace, isolated by dir', () => {
    const cache = new FilesListCache()
    expect(cache.get('/ws/a')).toBeUndefined()
    cache.set('/ws/a', RESULT)
    expect(cache.get('/ws/a')).toBe(RESULT)
    expect(cache.get('/ws/b')).toBeUndefined()
  })

  it('invalidate drops only the named Workspace', () => {
    const cache = new FilesListCache()
    cache.set('/ws/a', RESULT)
    cache.set('/ws/b', RESULT)
    cache.invalidate('/ws/a')
    expect(cache.get('/ws/a')).toBeUndefined()
    expect(cache.get('/ws/b')).toBe(RESULT)
  })

  it('clear empties everything', () => {
    const cache = new FilesListCache()
    cache.set('/ws/a', RESULT)
    cache.clear()
    expect(cache.get('/ws/a')).toBeUndefined()
  })
})

describe('shouldInvalidateFilesCacheOnGitStatus', () => {
  it('invalidates only on a local (working-tree) change', () => {
    expect(shouldInvalidateFilesCacheOnGitStatus('localUpdated')).toBe(true)
    expect(shouldInvalidateFilesCacheOnGitStatus('snapshot')).toBe(false)
    expect(shouldInvalidateFilesCacheOnGitStatus('remoteUpdated')).toBe(false)
  })
})
