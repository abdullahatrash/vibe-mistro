/**
 * Guard for the `openExternal` IPC (ADR-0014): a URL clicked in terminal output is
 * UNTRUSTED (a command can print any text). We open it in the system browser ONLY
 * when it parses AND its scheme is `http`/`https` — never a `file:` (disclose/open a
 * local file), `vscode:`/custom scheme (launch a registered handler), or `javascript:`.
 * Pure so it's unit-tested without Electron; the registrar calls `shell.openExternal`
 * only on a truthy return.
 */
export function safeExternalUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null // not an absolute, parseable URL
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
}
