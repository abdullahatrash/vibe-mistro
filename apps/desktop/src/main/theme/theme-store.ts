import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isThemePreference, type ThemePreference } from '../../shared/ipc'

export const THEME_FILENAME = 'theme.json'
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light'

export function themePath(userDataDir: string): string {
  return join(userDataDir, THEME_FILENAME)
}

export interface ThemeFileAccess {
  read: (filePath: string) => Promise<string>
  write: (filePath: string, contents: string) => Promise<void>
}

const NODE_THEME_FILE_ACCESS: ThemeFileAccess = {
  read: (filePath) => readFile(filePath, 'utf8'),
  write: async (filePath, contents) => {
    await writeFile(filePath, contents, 'utf8')
  },
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Parse a persisted theme file tolerantly; malformed data uses the default. */
export function parseThemeFile(raw: string): ThemePreference {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_THEME_PREFERENCE
  }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_THEME_PREFERENCE
  const preference = (parsed as Record<string, unknown>).preference
  return isThemePreference(preference) ? preference : DEFAULT_THEME_PREFERENCE
}

/**
 * Small, early-loading persistence seam independent of the state database.
 * Theme writes are best-effort so a disk failure never blocks a live theme flip.
 */
export class ThemePreferenceStore {
  private readonly filePath: string
  private saveTail: Promise<void> = Promise.resolve()

  constructor(
    userDataDir: string,
    private readonly fileAccess: ThemeFileAccess = NODE_THEME_FILE_ACCESS,
  ) {
    this.filePath = themePath(userDataDir)
  }

  async load(): Promise<ThemePreference> {
    try {
      return parseThemeFile(await this.fileAccess.read(this.filePath))
    } catch (error) {
      if (!isMissingFile(error)) console.error('[theme] failed to read preference:', error)
      return DEFAULT_THEME_PREFERENCE
    }
  }

  save(preference: ThemePreference): Promise<void> {
    // IPC transitions can arrive faster than filesystem writes. A per-store tail
    // preserves click order so the last confirmed preference is also last on disk.
    const pending = this.saveTail.then(() =>
      this.fileAccess.write(this.filePath, `${JSON.stringify({ preference }, null, 2)}\n`),
    )
    this.saveTail = pending.catch((error: unknown) => {
      console.error('[theme] failed to persist preference:', error)
    })
    return this.saveTail
  }
}
