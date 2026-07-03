// Restore the execute bit on node-pty's darwin `spawn-helper` prebuilds (ADR-0014).
// npm preserves the tarball's file modes; BUN does not — a bun install leaves
// spawn-helper 0644, and every PTY spawn then dies with `posix_spawnp failed`.
// Runs as OUR postinstall (bun runs the workspace's own lifecycle scripts even
// while blocking dependencies'). node-pty is resolved through the module graph,
// not a literal `../node_modules`, because the workspace root hoists it.
// Best-effort + silent on absence: non-darwin platforms and a not-yet-installed
// node-pty are no-ops, never a failed install.
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

let ptyRoot
try {
  ptyRoot = dirname(require.resolve('node-pty/package.json'))
} catch {
  process.exit(0)
}

for (const arch of ['darwin-arm64', 'darwin-x64']) {
  const helper = join(ptyRoot, 'prebuilds', arch, 'spawn-helper')
  try {
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    // Best-effort — a read-only store is the packager's problem, not install's.
  }
}
