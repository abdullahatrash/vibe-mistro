import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_THEME_PREFERENCE,
  parseThemeFile,
  ThemePreferenceStore,
  themePath,
} from './theme-store'

describe('parseThemeFile', () => {
  it('reads valid preferences', () => {
    expect(parseThemeFile('{"preference":"light"}')).toBe('light')
    expect(parseThemeFile('{"preference":"dark"}')).toBe('dark')
    expect(parseThemeFile('{"preference":"system"}')).toBe('system')
  })

  it('defaults malformed or invalid data to light', () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe('light')
    expect(parseThemeFile('not json')).toBe('light')
    expect(parseThemeFile('null')).toBe('light')
    expect(parseThemeFile('[]')).toBe('light')
    expect(parseThemeFile('{"preference":"solarized"}')).toBe('light')
    expect(parseThemeFile('{}')).toBe('light')
  })
})

describe('ThemePreferenceStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vibe-mistro-theme-'))
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(dir, { recursive: true, force: true })
  })

  it('loads light when no preference is persisted', async () => {
    expect(await new ThemePreferenceStore(dir).load()).toBe('light')
  })

  it('round-trips a preference', async () => {
    const store = new ThemePreferenceStore(dir)
    await store.save('dark')
    expect(await store.load()).toBe('dark')
    expect(JSON.parse(await readFile(themePath(dir), 'utf8'))).toEqual({ preference: 'dark' })
  })

  it('loads light from a corrupt preference file', async () => {
    await writeFile(themePath(dir), '{{{', 'utf8')
    expect(await new ThemePreferenceStore(dir).load()).toBe('light')
  })

  it('logs and resolves when persistence fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(new ThemePreferenceStore(join(dir, 'missing')).save('dark')).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledOnce()
  })

  it('serializes rapid saves so the latest confirmed preference wins', async () => {
    const releases: Array<() => void> = []
    const persisted: string[] = []
    const store = new ThemePreferenceStore(dir, {
      read: async () => persisted.at(-1) ?? '',
      write: async (_path, contents) => {
        await new Promise<void>((resolve) => releases.push(resolve))
        persisted.push(contents)
      },
    })

    const dark = store.save('dark')
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const light = store.save('light')
    await Promise.resolve()
    expect(releases).toHaveLength(1)

    releases[0]?.()
    await dark
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    releases[1]?.()
    await light

    expect(persisted.map(parseThemeFile)).toEqual(['dark', 'light'])
    expect(await store.load()).toBe('light')
  })

  it('logs non-missing read failures while still defaulting to light', async () => {
    const failure = new Error('permission denied')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new ThemePreferenceStore(dir, {
      read: () => Promise.reject(failure),
      write: () => Promise.resolve(),
    })

    await expect(store.load()).resolves.toBe('light')
    expect(error).toHaveBeenCalledWith('[theme] failed to read preference:', failure)
  })
})
