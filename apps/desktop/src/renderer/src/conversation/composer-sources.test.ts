import { describe, expect, it } from 'vitest'
import { createPathSource } from './composer-sources'
import type { FileEntry } from '../../../shared/ipc'

const ENTRIES: FileEntry[] = [
  { path: 'src/reducer.ts', kind: 'file' },
  { path: 'src', kind: 'directory' },
]

describe('createPathSource', () => {
  it('accepts a file as inline @path text at the trigger position', () => {
    const source = createPathSource({ entries: ENTRIES, onFirstOpen: () => {} })

    expect(source.apply('see @re now', 4, 7, ENTRIES[0])).toEqual({
      value: 'see @src/reducer.ts  now',
      caret: 20,
    })
  })

  it('accepts a folder as inline @path/ text at the trigger position', () => {
    const source = createPathSource({ entries: ENTRIES, onFirstOpen: () => {} })

    expect(source.apply('open @sr next', 5, 8, ENTRIES[1])).toEqual({
      value: 'open @src/ next',
      caret: 10,
    })
  })

  it('closes the popover for both files and folders once the reference is inserted', () => {
    const source = createPathSource({ entries: ENTRIES, onFirstOpen: () => {} })

    expect(source.closeOnAccept(ENTRIES[0])).toBe(true)
    expect(source.closeOnAccept(ENTRIES[1])).toBe(true)
  })
})
