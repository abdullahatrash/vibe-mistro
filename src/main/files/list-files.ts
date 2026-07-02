import { readdir, readFile, realpath } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import type { FileEntry, FilesListResult } from '../../shared/ipc'
import { compileGitignore, isIgnored, type GitignoreLayer } from './gitignore'

/**
 * The Workspace file lister (#188, ADR-0013 decisions 3-4). Walks the Workspace root and
 * returns a flat, deterministically-ordered list of relative `{ path, kind }` entries for
 * the Files Surface tree, honoring `.gitignore` (root + nested), hard-skipping `.git`,
 * including dotfiles, and capping at {@link FILES_LIST_CAP} entries with `truncated:true`.
 *
 * CONFINEMENT (the security core, deliberately STRICTER than ADR-0004's unconfined agent
 * reads):
 *   - The root is realpath-resolved once; every emitted path is built by CONCATENATING
 *     child names onto the (relative) accumulator, so a path can never be absolute or
 *     contain `..`.
 *   - The walk NEVER follows a symlink. `readdir(withFileTypes)` reports link-vs-target
 *     from an `lstat`, so a symlinked directory is LISTED as a leaf entry but NOT
 *     descended into. That single rule prevents BOTH out-of-tree escapes (a link to
 *     `/etc`, `~/.ssh`, `../sibling`) AND directory cycles (a link back to an ancestor).
 *   - `.git` is skipped at every depth.
 *
 * Pure over an injectable fs boundary (default: `node:fs/promises`); the colocated tests
 * exercise the DEFAULT boundary against real tmpdir fixtures (symlinks, cycles, caps).
 */

/** Hard cap on emitted entries; hitting it sets `truncated` and stops the walk. */
export const FILES_LIST_CAP = 20_000

/** The `Dirent` surface the walk needs — link-vs-target from an lstat (no follow). */
export interface DirentLike {
  name: string
  isDirectory(): boolean
  isFile(): boolean
  isSymbolicLink(): boolean
}

/** Injectable fs boundary (Seam). The default wires `node:fs/promises`. */
export interface ListFilesFs {
  realpath(path: string): Promise<string>
  readdir(path: string): Promise<DirentLike[]>
  readFile(path: string): Promise<string>
}

const nodeFs: ListFilesFs = {
  realpath: (p) => realpath(p),
  readdir: (p) => readdir(p, { withFileTypes: true }) as Promise<Dirent[]>,
  readFile: (p) => readFile(p, 'utf8'),
}

/** A directory is a REAL (descendable) directory: not a symlink, reports as a dir. */
function isRealDir(d: DirentLike): boolean {
  return !d.isSymbolicLink() && d.isDirectory()
}

/** Deterministic order: directories first, then files, each name-sorted by code unit. */
function compareDirents(a: DirentLike, b: DirentLike): number {
  const rankA = isRealDir(a) ? 0 : 1
  const rankB = isRealDir(b) ? 0 : 1
  if (rankA !== rankB) return rankA - rankB
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/** Read + compile a directory's `.gitignore`, or `[]` when there is none / it is unreadable. */
async function readGitignoreRules(fs: ListFilesFs, dirAbs: string): Promise<GitignoreLayer['rules']> {
  try {
    return compileGitignore(await fs.readFile(join(dirAbs, '.gitignore')))
  } catch {
    return []
  }
}

export interface ListFilesOptions {
  fs?: ListFilesFs
  cap?: number
}

export async function listFiles(workspaceDir: string, opts: ListFilesOptions = {}): Promise<FilesListResult> {
  const fs = opts.fs ?? nodeFs
  const cap = opts.cap ?? FILES_LIST_CAP

  let root: string
  try {
    root = await fs.realpath(workspaceDir)
  } catch {
    return { entries: [], truncated: false } // missing / unreadable root — degrade quietly
  }

  const entries: FileEntry[] = []
  let truncated = false

  const rootRules = await readGitignoreRules(fs, root)
  const rootLayers: GitignoreLayer[] = rootRules.length ? [{ base: '', rules: rootRules }] : []

  async function walk(dirRel: string, layers: GitignoreLayer[]): Promise<void> {
    const dirAbs = dirRel === '' ? root : join(root, dirRel)
    let dirents: DirentLike[]
    try {
      dirents = await fs.readdir(dirAbs)
    } catch {
      return // unreadable directory — skip (best-effort, never throws)
    }

    for (const dirent of [...dirents].sort(compareDirents)) {
      if (truncated) return
      const name = dirent.name
      if (name === '.git') continue // hard-skip at every depth

      const rel = dirRel === '' ? name : `${dirRel}/${name}`
      const descendable = isRealDir(dirent)
      if (isIgnored(layers, rel, descendable)) continue

      if (entries.length >= cap) {
        truncated = true
        return
      }
      // A symlink (never descended) is reported as a `file` leaf — see the module doc.
      entries.push({ path: rel, kind: descendable ? 'directory' : 'file' })

      if (descendable) {
        const childRules = await readGitignoreRules(fs, join(root, rel))
        const childLayers = childRules.length ? [...layers, { base: rel, rules: childRules }] : layers
        await walk(rel, childLayers)
      }
    }
  }

  await walk('', rootLayers)
  return { entries, truncated }
}
