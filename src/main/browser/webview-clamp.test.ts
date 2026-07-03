import { describe, expect, it } from 'vitest'
import { deriveBrowserPartition } from '../../shared/browser-guest'
import { clampWebviewAttachment, type ClampableWebPreferences } from './webview-clamp'

describe('clampWebviewAttachment', () => {
  it('rejects an attachment whose partition is not a Browser-Surface partition', () => {
    expect(clampWebviewAttachment({ partition: 'persist:something-else' }, {})).toBe(false)
    expect(clampWebviewAttachment({ partition: undefined }, {})).toBe(false)
    expect(clampWebviewAttachment({}, {})).toBe(false)
  })

  it('allows a derived Workspace partition', () => {
    const params = { partition: deriveBrowserPartition('/Users/me/app') }
    expect(clampWebviewAttachment(params, {})).toBe(true)
  })

  it('force-overrides hostile renderer prefs and strips any preload', () => {
    const webPreferences: ClampableWebPreferences = {
      sandbox: false,
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      preload: '/tmp/evil.js',
      preloadURL: 'file:///tmp/evil.js',
    }
    const allowed = clampWebviewAttachment(
      { partition: deriveBrowserPartition('/Users/me/app') },
      webPreferences,
    )
    expect(allowed).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false)
    expect(webPreferences.contextIsolation).toBe(true)
    expect('preload' in webPreferences).toBe(false)
    expect('preloadURL' in webPreferences).toBe(false)
  })
})
