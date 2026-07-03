/**
 * URL policy for the Browser Surface (#216, ADR-0015): everything the webview is asked
 * to load passes through here first. Accepts what a user would naturally type into a
 * URL bar (`localhost:5173`, `example.com/path`) by inferring `http://`, but blesses
 * ONLY `http:`/`https:` results — `file:`, `javascript:`, `vscode:` and friends are
 * refused (`null`), mirroring `safeExternalUrl`'s posture for the opposite direction.
 */
export function normalizeBrowserUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  // A leading `scheme:` means the user MEANT a scheme — parse as-is so a non-http(s)
  // one is refused rather than laundered into `http://file:...`. The one ambiguity is
  // `host:port` (`localhost:5173`), which the scheme grammar also matches: a colon
  // followed by digits reads as a port, so it takes the infer-http path instead.
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-z][a-z0-9+.-]*:\d+(\/|$)/i.test(raw)
  return parseHttpUrl(hasScheme ? raw : `http://${raw}`)
}

function parseHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}
