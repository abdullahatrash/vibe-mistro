import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { assertBuilt, launch, seedProfile } from './launch'

/**
 * Visual smoke suite (slice 1): launch the BUILT app against a throwaway
 * userData profile and pin the cold UI states with screenshots — the layer the
 * vitest suite deliberately can't see (pure modules, node env, no DOM). This is
 * the net for the layout-regression class of bug: composer not pinned, control
 * rows overflowing, the side panel not stretching.
 *
 * Deliberately NO agent interaction here: nothing clicks a Workspace or Thread
 * row, so no `vibe-acp` is ever spawned and the suite runs the same on a
 * machine without Vibe installed. The LIVE states run against the scripted
 * fake agent in `live.spec.ts` (slice 2).
 */

test.beforeAll(() => {
  assertBuilt()
})

test('first run: shell chrome + empty state render', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'vibe-mistro-e2e-'))
  const { app, page } = await launch(userData)
  try {
    await expect(page.getByText('New chat')).toBeVisible()
    await expect(page.getByText('Projects')).toBeVisible()
    await expect(page).toHaveScreenshot('first-run.png')
  } finally {
    await app.close()
  }
})

test('seeded profile: sidebar lists the persisted Workspace and its Thread', async () => {
  const userData = await seedProfile({ thread: true })
  const { app, page } = await launch(userData)
  try {
    await expect(page.getByText('seeded-project')).toBeVisible()
    // Expanding the project is SAFE: the header row is the fold trigger and
    // folding is peek-only — it never connects. But do NOT click the thread row
    // itself: since #203 that auto-continues, which would spawn a real
    // `vibe-acp` here.
    await page.getByText('seeded-project').click()
    await expect(page.getByText('Sum two numbers')).toBeVisible()
    // Settle: confirm the fold HOLDS open (a transient auto-wait pass right after
    // the click would mask a state reset re-collapsing the project).
    await page.waitForTimeout(300)
    await expect(page.getByText('Sum two numbers')).toBeVisible()
    await expect(page).toHaveScreenshot('seeded-sidebar.png')
  } finally {
    await app.close()
  }
})
