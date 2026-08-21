import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { BotProfileFs } from './write-bot-profile'

/**
 * The real `BotProfileFs` (#445) — the ONLY binding of the Bot profile writer to
 * `node:fs`. It lives alone in this file so `write-bot-profile.ts` stays
 * seam-only and every test injects a fake instead of touching `~/.vibe/`.
 *
 * `rm` uses `force: true` so deleting an already-absent file is a success, not
 * an ENOENT — a Bot whose profile was removed by hand still deletes cleanly.
 */
export const nodeProfileFs: BotProfileFs = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  writeFile: (path, contents) => writeFile(path, contents, 'utf8'),
  rm: (path) => rm(path, { force: true }),
}
