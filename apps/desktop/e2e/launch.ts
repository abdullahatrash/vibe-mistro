import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

/** The built main-process entry the suite drives (run `bun run build` first). */
export const MAIN_ENTRY = resolve(import.meta.dirname, '../out/main/index.js')

/** The fake `vibe-acp` bin dir — prepend to PATH (with the shell-env probe skipped). */
export const FAKE_AGENT_BIN = resolve(import.meta.dirname, 'fake-agent')

/** Fixed window size so screenshots are comparable across runs. */
export const WINDOW = { width: 1400, height: 900 }

export function assertBuilt(): void {
  if (!existsSync(MAIN_ENTRY)) {
    throw new Error('out/main/index.js is missing — run `bun run build` before `bun run test:e2e`.')
  }
}

/**
 * Launch the built app with its persisted profile pointed at `userData` (the
 * `VIBE_MISTRO_USER_DATA` seam) at a fixed window size. `extraEnv` layers on the
 * inherited env — the live suite uses it to route `vibe-acp` to the fake agent.
 */
export async function launch(
  userData: string,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [MAIN_ENTRY],
    env: { ...process.env, VIBE_MISTRO_USER_DATA: userData, ...extraEnv } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 50, y: 50, ...bounds })
  }, WINDOW)
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/**
 * A throwaway userData profile seeded with one Workspace (+ optionally one
 * Thread). Timestamps are recent-but-fixed-offset: old enough that the
 * relative-time label ("5m") is stable for the duration of a run, recent enough
 * that it can't drift between runs the way a hardcoded epoch would.
 */
export async function seedProfile(options: {
  thread: boolean
  files?: Readonly<Record<string, string>>
}): Promise<string> {
  const userData = await mkdtemp(join(tmpdir(), 'vibe-mistro-e2e-'))
  // A STABLE basename inside the random temp dir: a connect re-upserts the
  // Workspace with `basename(dir)` as its display name, so a random basename
  // would leak run-varying text into the sidebar (and the screenshots).
  const fakeProjectDir = join(await mkdtemp(join(tmpdir(), 'vibe-mistro-e2e-project-')), 'seeded-project')
  await mkdir(fakeProjectDir)
  for (const [relativePath, contents] of Object.entries(options.files ?? {})) {
    const absolutePath = join(fakeProjectDir, relativePath)
    await mkdir(dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, contents)
  }
  const now = Date.now()
  await writeFile(
    join(userData, 'metadata.json'),
    JSON.stringify({
      schemaVersion: 1,
      workspaces: [
        { id: 'ws-1', dir: fakeProjectDir, displayName: 'seeded-project', lastOpenedAt: now - 5 * 60_000 },
      ],
      threads: options.thread
        ? [
            {
              id: 'th-1',
              workspaceId: 'ws-1',
              sessionId: 'sess-stale',
              title: 'Sum two numbers',
              createdAt: now - 10 * 60_000,
              lastActiveAt: now - 5 * 60_000,
            },
          ]
        : [],
    }),
  )
  return userData
}
