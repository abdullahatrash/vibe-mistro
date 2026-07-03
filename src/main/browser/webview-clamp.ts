/**
 * The `will-attach-webview` clamp (#216, ADR-0015; t3code `DesktopWindow` precedent):
 * defense-in-depth behind the renderer's own `<webview>` attributes. Enabling
 * `webviewTag` widens the window's attack surface, so main independently gates EVERY
 * attachment — only guests carrying an exact Browser-Surface partition AND an
 * http(s) initial URL may attach, and the full set of security prefs Electron
 * consults is force-overridden no matter what the renderer asked for. Pure (no
 * Electron in the import graph) so it's unit-tested like `terminal-manager`.
 */
import { isBrowserPartition } from '../../shared/browser-guest'

/** The slice of Electron's `WebPreferences` the clamp rules on (structural, no import). */
export interface ClampableWebPreferences {
  sandbox?: boolean
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  nodeIntegrationInWorker?: boolean
  contextIsolation?: boolean
  webSecurity?: boolean
  allowRunningInsecureContent?: boolean
  experimentalFeatures?: boolean
  enableBlinkFeatures?: string
  webviewTag?: boolean
  preload?: string
  preloadURL?: string
}

/** Whether an attachment's initial URL is one the Browser Surface may load. */
function isAllowedSrc(src: unknown): boolean {
  if (typeof src !== 'string') return false
  // Electron may attach before the first real navigation lands.
  if (src === 'about:blank') return true
  try {
    const url = new URL(src)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Gate + clamp one attachment: returns whether to allow it (`false` → the caller
 * `event.preventDefault()`s), and — Electron's contract — MUTATES `webPreferences`
 * in place to the locked-down posture. Gates: the partition must match the derived
 * grammar EXACTLY (never a prefix test — a `persist:` suffix maps onto storage
 * directories), and the initial `src` must be http(s) — the renderer's URL policy,
 * re-enforced where a compromised renderer can't reach.
 */
export function clampWebviewAttachment(
  params: { partition?: unknown; src?: unknown },
  webPreferences: ClampableWebPreferences,
): boolean {
  if (typeof params.partition !== 'string' || !isBrowserPartition(params.partition)) return false
  if (!isAllowedSrc(params.src)) return false
  webPreferences.sandbox = true
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.contextIsolation = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.experimentalFeatures = false
  webPreferences.webviewTag = false
  delete webPreferences.enableBlinkFeatures
  // The Browser Surface ships NO guest preload — anything asking for one is hostile.
  delete webPreferences.preload
  delete webPreferences.preloadURL
  return true
}
