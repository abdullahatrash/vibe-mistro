import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { EDITORS, fileManagerCommandForPlatform, type EditorId } from '../../shared/editors'

/**
 * Which-on-PATH editor detection (#252) — the t3code model: an editor is
 * "installed" iff one of its CLI aliases resolves to an executable on the
 * shell-env PATH. No macOS app-bundle scanning, no icon extraction. The PATH
 * must be the RESOLVED shell env (`getShellEnv()`), not bare `process.env` —
 * a Finder/Dock launch drops the rc-file PATH where `code`/`cursor` live.
 */

/**
 * The absolute candidate paths a command may resolve to, one per PATH dir —
 * pure so the PATH-splitting/PATHEXT logic is unit-testable without fs. On
 * win32, each dir fans out per PATHEXT extension (a bare `code` on Windows is
 * really `code.cmd`); elsewhere it's a straight dir join.
 */
export function candidateCommandPaths(
  command: string,
  pathVar: string,
  platform: string,
  pathExt?: string,
): string[] {
  // The delimiter follows the `platform` PARAMETER (not the host's `node:path`)
  // so the win32 fan-out is exercisable from the posix-run test suite.
  const dirs = pathVar.split(platform === 'win32' ? ';' : ':').filter(Boolean)
  if (platform === 'win32') {
    const exts = (pathExt ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    return dirs.flatMap((dir) => exts.map((ext) => join(dir, command + ext)))
  }
  return dirs.map((dir) => join(dir, command))
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The ABSOLUTE path `command` resolves to on `env`'s PATH, or null. Returning
 * the resolved path (not the bare alias) lets the launcher spawn exactly the
 * executable the probe found, instead of re-trusting `spawn`'s own PATH lookup
 * against a custom env.
 */
export async function resolveCommandPath(
  command: string,
  env: NodeJS.ProcessEnv,
  platform: string,
): Promise<string | null> {
  for (const candidate of candidateCommandPaths(command, env.PATH ?? '', platform, env.PATHEXT)) {
    if (await isExecutable(candidate)) return candidate
  }
  return null
}

/** The resolved path of the FIRST of `commands` found on PATH, or null. */
export async function resolveAvailableCommand(
  commands: readonly string[],
  env: NodeJS.ProcessEnv,
  platform: string,
): Promise<string | null> {
  for (const command of commands) {
    const resolved = await resolveCommandPath(command, env, platform)
    if (resolved !== null) return resolved
  }
  return null
}

/**
 * The installed subset of the curated `EDITORS` table, in table (= preference)
 * order. The `file-manager` entry probes the platform opener instead of a fixed
 * alias. Probes are fs `access` checks — cheap, but callers should still cache
 * the result per session (the installed set doesn't change mid-run).
 */
export async function detectAvailableEditors(
  env: NodeJS.ProcessEnv,
  platform: string,
): Promise<EditorId[]> {
  const available: EditorId[] = []
  for (const editor of EDITORS) {
    const commands = editor.commands ?? [fileManagerCommandForPlatform(platform)]
    if ((await resolveAvailableCommand(commands, env, platform)) !== null) {
      available.push(editor.id)
    }
  }
  return available
}
