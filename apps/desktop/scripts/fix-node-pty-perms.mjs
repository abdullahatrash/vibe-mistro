// Restore the execute bit on @lydell/node-pty's darwin `spawn-helper` prebuild (ADR-0014).
// npm preserves the tarball's file modes; BUN does not — a bun install leaves
// spawn-helper 0644, and every PTY spawn then dies with `posix_spawnp failed`.
// Runs as OUR postinstall (bun runs the workspace's own lifecycle scripts even
// while blocking dependencies').
//
// @lydell/node-pty ships each platform's binary as a SEPARATE package
// (`@lydell/node-pty-<platform>-<arch>`); bun installs only the one matching this
// host. Just the darwin prebuilds carry a `spawn-helper` — the linux prebuild is a
// bare `pty.node` (no helper), so this is darwin-only. Each package is resolved
// through the module graph (root-hoisted), not a literal `../node_modules`.
// Best-effort + silent on absence: a non-darwin host, or an arch whose prebuild
// isn't installed, is a no-op — never a failed install.
import { chmodSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

for (const arch of ['darwin-arm64', 'darwin-x64']) {
  let mainEntry
  try {
    // Resolve the bare specifier, NOT `<pkg>/package.json`: @lydell's platform
    // packages declare a string `exports` ("./lib/index.js") that blocks the
    // package.json subpath. The main entry is `<root>/lib/index.js`, so the
    // package root is two directories up.
    mainEntry = require.resolve(`@lydell/node-pty-${arch}`)
  } catch {
    continue // that platform's prebuild isn't installed on this host — skip it.
  }
  const pkgRoot = dirname(dirname(mainEntry))
  const helper = join(pkgRoot, 'prebuilds', arch, 'spawn-helper')
  try {
    if (existsSync(helper)) chmodSync(helper, 0o755)
  } catch {
    // Best-effort — a read-only store is the packager's problem, not install's.
  }
}
