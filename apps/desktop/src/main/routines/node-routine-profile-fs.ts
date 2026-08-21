import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { RoutineProfileFs } from './write-routine-profile'

/**
 * The real `RoutineProfileFs` (#469) — the ONLY binding of the routine-gate
 * writer to `node:fs`. It lives alone in this file, exactly like
 * `bots/node-profile-fs.ts`, so `write-routine-profile.ts` stays seam-only and
 * every test injects a fake instead of touching `~/.vibe/`.
 *
 * `readFile` deliberately has no `force`-style tolerance: an absent file must
 * REJECT, because "there is nothing to read" is the one answer that must never be
 * mistaken for a confirmed gate.
 */
export const nodeRoutineProfileFs: RoutineProfileFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
  readFile: (path) => readFile(path, 'utf8'),
}
