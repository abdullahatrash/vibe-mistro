import { describe, expect, it } from 'vitest'
import { changeLinePreview, fileChangeHeading, fileChanges, workspaceRelativePath } from './file-change'
import type { ToolItem } from './reducer'

function tool(content: unknown[]): ToolItem {
  return {
    kind: 'tool',
    id: 'tool:1',
    toolCallId: '1',
    toolKind: 'edit',
    status: 'completed',
    title: 'Edit',
    locations: [],
    rawInput: undefined,
    rawOutput: undefined,
    content,
  }
}

describe('fileChanges', () => {
  it('recognizes a Vibe-created file and counts its added lines', () => {
    const changes = fileChanges(
      tool([
        {
          type: 'diff',
          path: 'src/new.ts',
          oldText: null,
          newText: 'one\ntwo\n',
        },
      ]),
    )
    expect(changes).toEqual([
      {
        path: 'src/new.ts',
        oldText: null,
        newText: 'one\ntwo\n',
        kind: 'created',
        additions: 2,
        deletions: 0,
      },
    ])
    expect(fileChangeHeading(changes)).toBe('Created 1 file')
  })

  it('recognizes edits/deletes and accepts defensive snake_case fields', () => {
    const changes = fileChanges(
      tool([
        {
          type: 'diff',
          path: 'src/edit.ts',
          old_text: 'before',
          new_text: 'after\nnow',
        },
        { type: 'diff', path: 'src/gone.ts', oldText: 'gone', newText: null },
      ]),
    )
    expect(changes.map((change) => change.kind)).toEqual(['edited', 'deleted'])
    expect(changes[0]).toMatchObject({ additions: 2, deletions: 1 })
    expect(fileChangeHeading(changes)).toBe('Changed 2 files')
  })

  it('ignores generic tool content and malformed diff entries', () => {
    expect(fileChanges(tool([{ type: 'content', content: { text: 'hello' } }, { type: 'diff' }, null]))).toEqual([])
  })
})

describe('changeLinePreview', () => {
  it('caps mounted lines and reports the hidden remainder', () => {
    expect(changeLinePreview('a\nb\nc\n', 2)).toEqual({
      lines: ['a', 'b'],
      hiddenLineCount: 1,
    })
  })

  it('treats null and empty replacements as no lines', () => {
    expect(changeLinePreview(null)).toEqual({ lines: [], hiddenLineCount: 0 })
    expect(changeLinePreview('')).toEqual({ lines: [], hiddenLineCount: 0 })
  })
})

describe('workspaceRelativePath', () => {
  it('keeps safe relative paths and strips dot-relative prefixes', () => {
    expect(workspaceRelativePath('./src/app.ts', '/repo/project')).toBe('src/app.ts')
  })

  it('strips the current Workspace from absolute POSIX and Windows paths', () => {
    expect(workspaceRelativePath('/repo/project/src/app.ts', '/repo/project')).toBe('src/app.ts')
    expect(workspaceRelativePath('C:\\Repo\\App\\src\\app.ts', 'c:\\repo\\app')).toBe('src/app.ts')
  })

  it('refuses traversal and absolute paths outside the Workspace', () => {
    expect(workspaceRelativePath('../secret', '/repo/project')).toBeNull()
    expect(workspaceRelativePath('/repo/other/file.ts', '/repo/project')).toBeNull()
  })
})
