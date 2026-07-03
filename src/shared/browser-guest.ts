/**
 * The Browser Surface's guest (webview) configuration, shared by BOTH sides (#216,
 * ADR-0015): the renderer declares these on the `<webview>` tag; main's
 * `will-attach-webview` clamp independently verifies/enforces them. Pure TS — no Node,
 * no DOM — so it compiles under both tsconfig projects and tests in the node env.
 *
 * The partition scheme is t3code's: a `persist:` partition per SCOPE (our Workspace
 * directory), so preview cookies/storage survive restarts but never mix across
 * Workspaces or with the app's own session. The hash is FNV-1a (no `crypto` — this
 * module must load in the renderer): partitions need stable UNIQUENESS, not
 * collision-resistance against an adversary who already controls the input.
 */

/** Every Browser-Surface guest partition starts with this; the clamp rejects the rest. */
export const BROWSER_PARTITION_PREFIX = 'persist:vibe-browser-'

/** 32-bit FNV-1a over UTF-16 code units, hex-encoded. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The Workspace's isolated, persisted guest partition. */
export function deriveBrowserPartition(workspaceDir: string): string {
  return `${BROWSER_PARTITION_PREFIX}${fnv1a(workspaceDir)}`
}

/**
 * The `<webview webpreferences>` attribute value. Electron splits on `,` WITHOUT
 * trimming and treats non-boolean-literal values as truthy strings (the t3code
 * gotcha), so this is built as one exact, space-free string of `key=true|false`
 * pairs and locked by test. Stricter than t3code: contextIsolation stays ON — we
 * inject no preload, so nothing needs the guest's globals.
 */
export function buildWebviewPreferencesAttribute(): string {
  return 'sandbox=true,contextIsolation=true,nodeIntegration=false,nodeIntegrationInSubFrames=false'
}

/**
 * Strip the `Electron/x` and `vibe-mistro/x` product tokens from a User-Agent (t3code
 * precedent) so dev servers and sites treat the preview as the ordinary Chrome it is.
 */
export function stripElectronUserAgent(userAgent: string): string {
  return userAgent
    .replace(/\s?\b(?:Electron|vibe-mistro)\/\S+/g, '')
    .replace(/ {2,}/g, ' ')
    .trim()
}
