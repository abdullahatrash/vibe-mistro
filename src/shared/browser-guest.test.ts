import { describe, expect, it } from 'vitest'
import {
  BROWSER_PARTITION_PREFIX,
  buildWebviewPreferencesAttribute,
  deriveBrowserPartition,
  stripElectronUserAgent,
} from './browser-guest'

const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) vibe-mistro/1.0.0 Chrome/134.0.0.0 Electron/35.1.0 Safari/537.36'

describe('deriveBrowserPartition', () => {
  it('derives a persist: partition stable for the same Workspace directory', () => {
    const a = deriveBrowserPartition('/Users/me/projects/app')
    expect(a).toBe(deriveBrowserPartition('/Users/me/projects/app'))
    expect(a.startsWith(BROWSER_PARTITION_PREFIX)).toBe(true)
    expect(BROWSER_PARTITION_PREFIX.startsWith('persist:')).toBe(true)
  })

  it('isolates different Workspace directories into different partitions', () => {
    expect(deriveBrowserPartition('/Users/me/projects/app')).not.toBe(
      deriveBrowserPartition('/Users/me/projects/other'),
    )
  })
})

describe('buildWebviewPreferencesAttribute', () => {
  // Electron parses this attribute by splitting on `,` WITHOUT trimming, and a value
  // that isn't a recognised boolean literal coerces to a truthy STRING (the t3code
  // WebviewPreferences gotcha) — so a stray space or a `yes`/`no` value silently
  // weakens the sandbox. This test locks the exact grammar, not just the intent.
  it('locks the guest security prefs: sandboxed, no Node, isolated, no spaces', () => {
    const attr = buildWebviewPreferencesAttribute()
    expect(attr).toContain('sandbox=true')
    expect(attr).toContain('nodeIntegration=false')
    expect(attr).toContain('nodeIntegrationInSubFrames=false')
    expect(attr).toContain('contextIsolation=true')
    expect(attr).not.toMatch(/\s/)
    for (const pair of attr.split(',')) {
      expect(pair).toMatch(/^[A-Za-z]+=(true|false)$/)
    }
  })
})

describe('stripElectronUserAgent', () => {
  it('removes the Electron and app-name tokens so the guest reads as a normal browser', () => {
    const stripped = stripElectronUserAgent(ELECTRON_UA)
    expect(stripped).not.toContain('Electron/')
    expect(stripped).not.toContain('vibe-mistro/')
    expect(stripped).toContain('Chrome/134.0.0.0')
    expect(stripped).not.toMatch(/ {2}/)
  })

  it('leaves an already-ordinary UA untouched', () => {
    const plain =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    expect(stripElectronUserAgent(plain)).toBe(plain)
  })
})
