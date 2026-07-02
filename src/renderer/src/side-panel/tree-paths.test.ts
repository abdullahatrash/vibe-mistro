import { describe, expect, it } from 'vitest'
import type { FileEntry } from '../../../shared/ipc'
import { indexEntryKinds, selectedFilePath, toTreePaths } from './tree-paths'

const ENTRIES: FileEntry[] = [
  { path: 'src', kind: 'directory' },
  { path: 'src/app.ts', kind: 'file' },
  { path: 'README.md', kind: 'file' },
]

describe('toTreePaths', () => {
  it('suffixes directories with a trailing slash, leaves files bare', () => {
    expect(toTreePaths(ENTRIES)).toEqual(['src/', 'src/app.ts', 'README.md'])
  })

  it('handles an empty listing', () => {
    expect(toTreePaths([])).toEqual([])
  })
})

describe('selectedFilePath', () => {
  const kinds = indexEntryKinds(ENTRIES)

  it('returns the relative path for a selected file', () => {
    expect(selectedFilePath(['src/app.ts'], kinds)).toBe('src/app.ts')
  })

  it('strips the trailing slash and returns null for a directory', () => {
    expect(selectedFilePath(['src/'], kinds)).toBeNull()
  })

  it('uses only the last selected path', () => {
    expect(selectedFilePath(['src/', 'README.md'], kinds)).toBe('README.md')
  })

  it('returns null for an empty or unknown selection', () => {
    expect(selectedFilePath([], kinds)).toBeNull()
    expect(selectedFilePath(['does/not/exist.ts'], kinds)).toBeNull()
  })
})
