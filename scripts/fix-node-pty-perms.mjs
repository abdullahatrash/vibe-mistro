// Restore the execute bit on node-pty's darwin `spawn-helper` prebuilds (ADR-0014).
// npm preserves the tarball's file modes; BUN does not — a bun install leaves
// spawn-helper 0644, and every PTY spawn then dies with `posix_spawnp failed`.
// Runs as OUR postinstall (bun runs the project's own lifecycle scripts even
// while blocking dependencies'). Best-effort + silent on absence: non-darwin
// platforms and a not-yet-installed node-pty are no-ops, never a failed install.
import { chmodSync, existsSync } from 'node:fs'

for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = new URL(`../node_modules/node-pty/prebuilds/${arch}/spawn-helper`, import.meta.url)
  try {
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    // Best-effort — a read-only store is the packager's problem, not install's.
  }
}
