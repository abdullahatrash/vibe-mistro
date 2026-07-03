/**
 * The `will-attach-webview` clamp (#216, ADR-0015; t3code `DesktopWindow` precedent):
 * defense-in-depth behind the renderer's own `<webview>` attributes. Enabling
 * `webviewTag` widens the window's attack surface, so main independently gates EVERY
 * attachment — only guests carrying a Browser-Surface partition may attach, and their
 * security prefs are force-overridden no matter what the renderer asked for. Pure
 * (no Electron in the import graph) so it's unit-tested like `terminal-manager`.
 */
import { BROWSER_PARTITION_PREFIX } from '../../shared/browser-guest'

/** The slice of Electron's `WebPreferences` the clamp rules on (structural, no import). */
export interface ClampableWebPreferences {
  sandbox?: boolean
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  contextIsolation?: boolean
  preload?: string
  preloadURL?: string
}

/**
 * Gate + clamp one attachment: returns whether to allow it (`false` → the caller
 * `event.preventDefault()`s), and — Electron's contract — MUTATES `webPreferences`
 * in place to the locked-down posture.
 */
export function clampWebviewAttachment(
  params: { partition?: unknown },
  webPreferences: ClampableWebPreferences,
): boolean {
  if (typeof params.partition !== 'string' || !params.partition.startsWith(BROWSER_PARTITION_PREFIX)) {
    return false
  }
  webPreferences.sandbox = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  // The Browser Surface ships NO guest preload — anything asking for one is hostile.
  delete webPreferences.preload
  delete webPreferences.preloadURL
  return true
}
