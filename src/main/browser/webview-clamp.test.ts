import { describe, expect, it } from 'vitest'
import { BROWSER_PARTITION_PREFIX, deriveBrowserPartition } from '../../shared/browser-guest'
import { clampWebviewAttachment, type ClampableWebPreferences } from './webview-clamp'

const PARTITION = deriveBrowserPartition('/Users/me/app')

describe('clampWebviewAttachment', () => {
  it('rejects an attachment whose partition is not a Browser-Surface partition', () => {
    expect(clampWebviewAttachment({ partition: 'persist:something-else', src: 'http://x/' }, {})).toBe(false)
    expect(clampWebviewAttachment({ partition: undefined, src: 'http://x/' }, {})).toBe(false)
    expect(clampWebviewAttachment({ src: 'http://x/' }, {})).toBe(false)
  })

  it('rejects a prefix-matching partition with an attacker-chosen suffix (exact grammar)', () => {
    const traversal = `${BROWSER_PARTITION_PREFIX}../../Partitions/other`
    expect(clampWebviewAttachment({ partition: traversal, src: 'http://x/' }, {})).toBe(false)
  })

  it('rejects a non-http(s) initial src — the URL policy enforced main-side', () => {
    expect(clampWebviewAttachment({ partition: PARTITION, src: 'file:///etc/passwd' }, {})).toBe(false)
    expect(clampWebviewAttachment({ partition: PARTITION, src: 'javascript:alert(1)' }, {})).toBe(false)
    expect(clampWebviewAttachment({ partition: PARTITION, src: undefined }, {})).toBe(false)
    expect(clampWebviewAttachment({ partition: PARTITION }, {})).toBe(false)
  })

  it('allows a derived partition with an http(s) src (about:blank tolerated pre-navigation)', () => {
    expect(clampWebviewAttachment({ partition: PARTITION, src: 'http://localhost:5173/' }, {})).toBe(true)
    expect(clampWebviewAttachment({ partition: PARTITION, src: 'https://example.com/' }, {})).toBe(true)
    expect(clampWebviewAttachment({ partition: PARTITION, src: 'about:blank' }, {})).toBe(true)
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
    const allowed = clampWebviewAttachment({ partition: PARTITION, src: 'http://x/' }, webPreferences)
    expect(allowed).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
    expect(webPreferences.nodeIntegration).toBe(false)
    expect(webPreferences.nodeIntegrationInSubFrames).toBe(false)
    expect(webPreferences.contextIsolation).toBe(true)
    expect('preload' in webPreferences).toBe(false)
    expect('preloadURL' in webPreferences).toBe(false)
  })

  it('locks down every other security pref Electron consults, not just the headline four', () => {
    const webPreferences: ClampableWebPreferences = {
      webSecurity: false,
      allowRunningInsecureContent: true,
      experimentalFeatures: true,
      enableBlinkFeatures: 'DangerousFeature',
      nodeIntegrationInWorker: true,
      webviewTag: true,
    }
    expect(clampWebviewAttachment({ partition: PARTITION, src: 'http://x/' }, webPreferences)).toBe(true)
    expect(webPreferences.webSecurity).toBe(true)
    expect(webPreferences.allowRunningInsecureContent).toBe(false)
    expect(webPreferences.experimentalFeatures).toBe(false)
    expect('enableBlinkFeatures' in webPreferences).toBe(false)
    expect(webPreferences.nodeIntegrationInWorker).toBe(false)
    expect(webPreferences.webviewTag).toBe(false)
  })
})
