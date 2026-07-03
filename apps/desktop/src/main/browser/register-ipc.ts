import { ipcMain } from 'electron'
import { execFile } from 'node:child_process'
import { IPC, type DiscoverDevServersResult } from '../../shared/ipc'
import { discoverDevServers } from './discover-servers'

/** Run `lsof` for listening TCP sockets in `-F pcn` field format; reject if it's missing/errors. */
function runLsof(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'lsof',
      ['-iTCP', '-sTCP:LISTEN', '-P', '-n', '-F', 'pcn'],
      { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        // lsof exits non-zero when it finds nothing OR when denied some entries, but still
        // prints usable field output — trust stdout and only reject on a spawn failure
        // (missing binary / non-macOS-Linux), where stdout is empty.
        if (err && !stdout) reject(err)
        else resolve(stdout)
      },
    )
  })
}

/**
 * The dev-server discovery IPC handler (#218). One-shot, machine-wide (listening ports
 * aren't Workspace-scoped) so it needs no `pool`/agent. Best-effort: `discoverDevServers`
 * swallows an lsof failure to an empty list, so the invoke never rejects.
 */
export function registerBrowserIpc(): void {
  ipcMain.handle(IPC.discoverDevServers, async (): Promise<DiscoverDevServersResult> => {
    return { servers: await discoverDevServers(runLsof) }
  })
}
