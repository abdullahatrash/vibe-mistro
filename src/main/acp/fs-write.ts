import { realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Serve the agent's `fs/write_text_file` request (agent → client). Like reads,
 * Vibe delegates the actual write to us, so an approved write turn stalls until
 * we reply `{}` (docs/acp-capture.md §5, §7). The write only reaches us *after*
 * the user has approved the `session/request_permission` for the same tool call.
 *
 * Pure over an injected writer (Seam C): the WorkspaceAgent wires the real
 * `node:fs` writer; tests pass a fake or a temp dir.
 *
 * Confinement (ADR-0004): writes are confined to the Workspace — the user opened
 * *this* Workspace and approved a write they believe lands in it, so honoring an
 * arbitrary path is the wrong default. The check is **symlink-resolved**: it
 * compares the real path of the nearest existing ancestor of the target (the
 * file itself may not exist yet) against the real path of the Workspace root, so
 * a symlink *inside* the Workspace pointing out cannot escape, and a symlinked
 * Workspace root isn't falsely rejected. Reads stay UNCONFINED for parity with
 * the `vibe` CLI — see fs-read.ts and ADR-0004.
 */

/** Writes text to a file. Injectable for testing. */
export type WriteTextFn = (path: string, content: string) => Promise<void>

const defaultWrite: WriteTextFn = (path, content) => writeFile(path, content, 'utf8')

/** A JSON-RPC-shaped outcome: either a result or an error, never both. */
export type FsWriteOutcome =
  | { result: Record<string, never> }
  | { error: { code: number; message: string } }

export interface FsWriteDeps {
  /** Override the writer (testing). */
  write?: WriteTextFn
  /** When set, reject writes that resolve outside this directory. */
  workspaceDir?: string
}

/**
 * Write `params.content` to `params.path` and reply `{}`. Returns an error
 * result (never throws) on a bad request, a path that escapes the Workspace, or
 * a filesystem failure so the agent's turn can fail cleanly rather than hang.
 */
export async function handleFsWriteTextFile(
  params: unknown,
  deps: FsWriteDeps = {},
): Promise<FsWriteOutcome> {
  const write = deps.write ?? defaultWrite
  const path = (params as { path?: unknown } | null)?.path
  const content = (params as { content?: unknown } | null)?.content

  if (typeof path !== 'string' || path.length === 0) {
    return { error: { code: -32602, message: 'fs/write_text_file: missing or invalid `path`' } }
  }
  if (typeof content !== 'string') {
    return { error: { code: -32602, message: 'fs/write_text_file: missing or invalid `content`' } }
  }
  if (deps.workspaceDir && !(await isWriteWithinWorkspace(deps.workspaceDir, path))) {
    return {
      error: {
        code: -32602,
        message: `fs/write_text_file: path escapes the Workspace directory: ${path}`,
      },
    }
  }

  try {
    await write(path, content)
    return { result: {} }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: { code: -32603, message } }
  }
}

/**
 * True when `target`'s real path resolves to the Workspace's real path or a
 * descendant — symlink-resolved confinement (ADR-0004). Both sides are
 * realpath-resolved before the lexical comparison, so a symlink inside the
 * Workspace pointing out cannot escape and a symlinked Workspace root isn't
 * falsely rejected. The target may not exist yet, so we realpath the nearest
 * existing ancestor and re-append the non-existent tail.
 */
export async function isWriteWithinWorkspace(workspaceDir: string, target: string): Promise<boolean> {
  const realRoot = await realpath(workspaceDir).catch(() => resolve(workspaceDir))
  const realTarget = await realpathNearest(target)
  return isPathWithin(realRoot, realTarget)
}

/**
 * Resolve the real path of `target` by realpath-ing its nearest existing
 * ancestor and re-appending the not-yet-existing tail. Falls back to a lexical
 * resolve if nothing along the path exists.
 */
async function realpathNearest(target: string): Promise<string> {
  let current = resolve(target)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(target) // reached the root, nothing exists
      tail.push(basename(current))
      current = parent
    }
  }
}

/**
 * True when `target` resolves to `dir` or a descendant of it — a pure lexical
 * comparison. Callers pass realpath-resolved paths (see `isWriteWithinWorkspace`)
 * so symlinks are already resolved; on raw paths this rejects `..`/absolute
 * escapes only.
 */
export function isPathWithin(dir: string, target: string): boolean {
  const rel = relative(resolve(dir), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
