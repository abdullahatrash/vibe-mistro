import { describe, expect, it } from 'vitest'
import {
  EDITORS,
  findEditor,
  fileManagerCommandForPlatform,
  parseTargetPosition,
  resolveEditorArgs,
  type EditorDefinition,
} from './editors'

describe('EDITORS table', () => {
  it('has unique ids', () => {
    const ids = EDITORS.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('only the file-manager entry has null commands', () => {
    for (const editor of EDITORS) {
      if (editor.id === 'file-manager') expect(editor.commands).toBeNull()
      else expect(editor.commands?.length).toBeGreaterThan(0)
    }
  })

  it('findEditor resolves a known id and rejects an unknown one', () => {
    expect(findEditor('zed')?.label).toBe('Zed')
    expect(findEditor('emacs-brain-implant')).toBeNull()
  })
})

describe('parseTargetPosition', () => {
  it('splits path:line', () => {
    expect(parseTargetPosition('/a/b.ts:12')).toEqual({ path: '/a/b.ts', line: '12', column: null })
  })

  it('splits path:line:col', () => {
    expect(parseTargetPosition('/a/b.ts:12:4')).toEqual({ path: '/a/b.ts', line: '12', column: '4' })
  })

  it('returns null for a bare path', () => {
    expect(parseTargetPosition('/a/b.ts')).toBeNull()
  })

  it('returns null for a Windows drive path with no position', () => {
    expect(parseTargetPosition('C:\\proj\\x.ts')).toBeNull()
  })

  it('keeps a drive prefix inside the path when a position follows', () => {
    expect(parseTargetPosition('C:\\proj\\x.ts:3')).toEqual({
      path: 'C:\\proj\\x.ts',
      line: '3',
      column: null,
    })
  })
})

describe('resolveEditorArgs', () => {
  const goto: EditorDefinition = { id: 'x', label: 'X', commands: ['x'], launchStyle: 'goto' }
  const lineColumn: EditorDefinition = {
    id: 'y',
    label: 'Y',
    commands: ['y'],
    launchStyle: 'line-column',
  }
  const directPath: EditorDefinition = {
    id: 'z',
    label: 'Z',
    commands: ['z'],
    launchStyle: 'direct-path',
  }

  it('passes a bare directory through untouched for every style', () => {
    expect(resolveEditorArgs(goto, '/proj')).toEqual(['/proj'])
    expect(resolveEditorArgs(lineColumn, '/proj')).toEqual(['/proj'])
    expect(resolveEditorArgs(directPath, '/proj')).toEqual(['/proj'])
  })

  it('goto style forwards the positioned target via --goto', () => {
    expect(resolveEditorArgs(goto, '/a/b.ts:12:4')).toEqual(['--goto', '/a/b.ts:12:4'])
  })

  it('line-column style splits the position into flags', () => {
    expect(resolveEditorArgs(lineColumn, '/a/b.ts:12:4')).toEqual([
      '--line',
      '12',
      '--column',
      '4',
      '/a/b.ts',
    ])
    expect(resolveEditorArgs(lineColumn, '/a/b.ts:12')).toEqual(['--line', '12', '/a/b.ts'])
  })

  it('direct-path style strips the position down to the path', () => {
    expect(resolveEditorArgs(directPath, '/a/b.ts:12:4')).toEqual(['/a/b.ts'])
  })

  it('prepends baseArgs', () => {
    const withBase: EditorDefinition = { ...goto, baseArgs: ['ide'] }
    expect(resolveEditorArgs(withBase, '/proj')).toEqual(['ide', '/proj'])
  })
})

describe('fileManagerCommandForPlatform', () => {
  it('maps the three platforms', () => {
    expect(fileManagerCommandForPlatform('darwin')).toBe('open')
    expect(fileManagerCommandForPlatform('win32')).toBe('explorer')
    expect(fileManagerCommandForPlatform('linux')).toBe('xdg-open')
  })
})
