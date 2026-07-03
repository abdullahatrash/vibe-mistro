/**
 * Local dev-server discovery for the Browser Surface's empty state (#218). Parses
 * `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` field output into loadable dev-server
 * candidates. The parse + filtering are PURE (unit-tested against real fixtures); the
 * exec boundary is injected so the native `lsof` stays out of the test import graph
 * (the terminal-manager `spawnPty`-seam precedent).
 *
 * On a real dev machine lsof reports dozens of listeners (databases, menubar apps,
 * IPC helpers), so filtering by PORT alone is hopeless. The reliable signal is the
 * OWNING PROCESS: a web dev server is run by a known runtime/tooling command. We keep
 * ports owned by a dev runtime in a sane range and drop everything else — false
 * negatives are recoverable (the user can still type a URL), false positives are noise.
 */
import type { DevServer } from '../../shared/ipc'

/** Commands that host a web dev server (case-insensitive substring of the lsof `c` field). */
const DEV_RUNTIME_HINTS = [
  'node',
  'bun',
  'deno',
  'python',
  'ruby',
  'php',
  'rails',
  'vite',
  'next',
  'webpack',
  'dotnet',
  'http-server',
  'serve',
]

/** Sane dev-server port window: above privileged ports, below the ephemeral/dynamic range. */
const MIN_DEV_PORT = 1024
const MAX_DEV_PORT = 49151

function isDevRuntime(command: string): boolean {
  const lower = command.toLowerCase()
  return DEV_RUNTIME_HINTS.some((hint) => lower.includes(hint))
}

/** Pull the trailing `:<port>` off an lsof name field (`127.0.0.1:5173`, `[::1]:5173`, `*:8000`). */
function portOf(name: string): number | null {
  const match = /:(\d+)$/.exec(name)
  if (!match) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/**
 * Parse `lsof -F pcn` field output into deduped, filtered, sorted dev-server candidates.
 * Field lines: `p<pid>` starts a process record, `c<command>` names it, `n<addr:port>`
 * is a listening address (many per process); `f<fd>` and anything else is ignored.
 */
export function parseLsofListeners(output: string): DevServer[] {
  const byPort = new Map<number, DevServer>()
  let command = ''
  for (const raw of output.split('\n')) {
    const field = raw[0]
    const value = raw.slice(1)
    if (field === 'p') command = '' // new process record — reset until its `c` line
    else if (field === 'c') command = value
    else if (field === 'n') {
      const port = portOf(value)
      if (port === null || byPort.has(port)) continue
      if (port < MIN_DEV_PORT || port > MAX_DEV_PORT || !isDevRuntime(command)) continue
      byPort.set(port, { port, url: `http://localhost:${port}/`, processName: command })
    }
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port)
}

/**
 * Discover listening dev servers via the injected `runLsof` exec. Best-effort: a missing
 * `lsof` (non-macOS/Linux) or any exec failure resolves to an empty list — NEVER rejects,
 * so the empty state degrades to "type a URL" rather than an error.
 */
export async function discoverDevServers(runLsof: () => Promise<string>): Promise<DevServer[]> {
  try {
    return parseLsofListeners(await runLsof())
  } catch (err) {
    console.error(`[vibe-mistro:discover-servers] lsof failed: ${String(err)}`)
    return []
  }
}
