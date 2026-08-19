import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from '@playwright/test'
import { assertBuilt, launch, seedProfile } from './launch'

/**
 * PROTOTYPE CAPTURE (#422) — throwaway, lives with `bots-prototype/`.
 *
 * Not an assertion suite: it drives the BUILT app into each Bots-view variant and
 * writes raw PNGs so the variants can be looked at without anyone running Electron.
 * The floating switcher is dev-gated (a stray merge must not ship it), so the
 * variant is selected through the same `localStorage` keys the switcher writes.
 *
 * No agent is spawned: the prototype is stub data and nothing clicks a Thread row.
 */

const OUT = resolve(import.meta.dirname, '../src/renderer/src/bots-prototype/captures')

const SHOTS = [
  { file: 'A-roster.png', variant: 'A', empty: '0', many: '0', create: false },
  { file: 'B-gallery.png', variant: 'B', empty: '0', many: '0', create: false },
  { file: 'C-sidebar-native.png', variant: 'C', empty: '0', many: '0', create: false },
  { file: 'A-empty.png', variant: 'A', empty: '1', many: '0', create: false },
  { file: 'B-empty.png', variant: 'B', empty: '1', many: '0', create: false },
  // D — the chosen hybrid, and the three cases C could not answer (#442).
  { file: 'D-conversation.png', variant: 'D', empty: '0', many: '0', create: false },
  { file: 'D-empty.png', variant: 'D', empty: '1', many: '0', create: false },
  { file: 'D-create.png', variant: 'D', empty: '0', many: '0', create: true },
  { file: 'D-scale-20.png', variant: 'D', empty: '0', many: '1', create: false },
]

test.beforeAll(async () => {
  assertBuilt()
  await mkdir(OUT, { recursive: true })
})

for (const shot of SHOTS) {
  test(`capture ${shot.file}`, async () => {
    const userData = await seedProfile({ thread: true })
    const { app, page } = await launch(userData)
    try {
      await page.evaluate(
        ([variant, empty, many]) => {
          localStorage.setItem('proto:422:variant', variant)
          localStorage.setItem('proto:422:empty', empty)
          localStorage.setItem('proto:422:many', many)
        },
        [shot.variant, shot.empty, shot.many],
      )
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await page.getByText('Bots', { exact: true }).first().click()
      await page.waitForTimeout(300)
      if (shot.create) {
        // D's create flow: the sidebar's + is the affordance that works in EVERY
        // state (the empty-outlet CTA only exists when there are no Bots).
        await page.getByRole('button', { name: 'New Bot' }).first().click()
      }
      // Let the outlet settle before capturing.
      await page.waitForTimeout(400)
      await page.screenshot({ path: resolve(OUT, shot.file) })
    } finally {
      await app.close()
    }
  })
}
