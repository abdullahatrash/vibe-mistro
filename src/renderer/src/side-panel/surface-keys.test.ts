import { describe, expect, it } from 'vitest'
import { surfaceForChord, type KeyChord } from './surface-keys'

/** A chord with everything up (no modifiers), overridden per case. */
function chord(over: Partial<KeyChord>): KeyChord {
  return { key: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over }
}

describe('surfaceForChord — ⌘P → Files', () => {
  it('matches meta+p (either case)', () => {
    expect(surfaceForChord(chord({ key: 'p', metaKey: true }))).toBe('files')
    expect(surfaceForChord(chord({ key: 'P', metaKey: true }))).toBe('files')
  })

  it('does not match ⌃P, ⌘⇧P, or ⌘⌥P', () => {
    expect(surfaceForChord(chord({ key: 'p', ctrlKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'p', metaKey: true, shiftKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'p', metaKey: true, altKey: true }))).toBeNull()
  })

  it('does not match bare p (plain typing)', () => {
    expect(surfaceForChord(chord({ key: 'p' }))).toBeNull()
  })
})

describe('surfaceForChord — ⌃⇧G → Review', () => {
  it('matches ctrl+shift+g (either case)', () => {
    expect(surfaceForChord(chord({ key: 'g', ctrlKey: true, shiftKey: true }))).toBe('review')
    expect(surfaceForChord(chord({ key: 'G', ctrlKey: true, shiftKey: true }))).toBe('review')
  })

  it('does not match ⌃G, ⇧G, or ⌘⇧G', () => {
    expect(surfaceForChord(chord({ key: 'g', ctrlKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'g', shiftKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'g', metaKey: true, shiftKey: true }))).toBeNull()
  })
})

describe('surfaceForChord — ⌘T → Browser (#217)', () => {
  it('matches meta+t (either case)', () => {
    expect(surfaceForChord(chord({ key: 't', metaKey: true }))).toBe('browser')
    expect(surfaceForChord(chord({ key: 'T', metaKey: true }))).toBe('browser')
  })

  it('does not match ⌃T, ⇧T, ⌘⇧T, or bare t', () => {
    expect(surfaceForChord(chord({ key: 't', ctrlKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 't', metaKey: true, shiftKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 't' }))).toBeNull()
  })
})

describe('surfaceForChord — ⌘J → Terminal', () => {
  it('matches meta+j (either case)', () => {
    expect(surfaceForChord(chord({ key: 'j', metaKey: true }))).toBe('terminal')
    expect(surfaceForChord(chord({ key: 'J', metaKey: true }))).toBe('terminal')
  })

  it('does not match ⌃J, ⌘⇧J, or bare j', () => {
    expect(surfaceForChord(chord({ key: 'j', ctrlKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'j', metaKey: true, shiftKey: true }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'j' }))).toBeNull()
  })
})

describe('surfaceForChord — unbound chords', () => {
  it('ignores plain typing and unrelated keys', () => {
    expect(surfaceForChord(chord({ key: 'a' }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'Enter' }))).toBeNull()
    expect(surfaceForChord(chord({ key: 'Escape' }))).toBeNull()
  })
})
