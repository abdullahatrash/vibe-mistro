/**
 * Browser domain of the shared IPC contract (#218): local dev-server discovery for the
 * Browser Surface's empty state. One-shot, machine-wide (listening TCP ports are not
 * Workspace-scoped), NO polling — the renderer invokes it on mount and on an explicit
 * Refresh. Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The browser channel entries, merged into the single `IPC` const in `./index`. */
export const browserChannels = {
  /** Renderer -> main: list listening local dev servers for the empty-state suggestions. */
  discoverDevServers: 'browser:discover-servers',
} as const

/**
 * One discovered dev server. `port` is the listening TCP port; `url` is the loadable
 * `http://localhost:<port>/` (loopback/unspecified hosts normalized to localhost);
 * `processName` is the owning command (e.g. `node`, `bun`) for a human-readable chip.
 */
export interface DevServer {
  port: number
  url: string
  processName: string
}

/**
 * The `discoverDevServers` reply (#218). `servers` is filtered to likely dev servers
 * (owned by a known dev runtime, sane port range), deduped by port, and sorted. An empty
 * list also covers "nothing listening" AND a swallowed lsof failure (missing binary,
 * non-macOS/Linux) — the invoke NEVER rejects.
 */
export interface DiscoverDevServersResult {
  servers: DevServer[]
}
