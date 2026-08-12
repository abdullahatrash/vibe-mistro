import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { assertBuilt, launch } from './launch'

test.beforeAll(() => {
  assertBuilt()
})

test('dark theme persists and System follows the OS without overriding explicit choices', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'vibe-mistro-theme-e2e-'))
  await writeFile(join(userData, 'theme.json'), JSON.stringify({ preference: 'dark' }))

  const first = await launch(userData)
  try {
    await expect(first.page.locator('html')).toHaveClass(/\bdark\b/)
    await expect
      .poll(
        () =>
          first.page.evaluate<string>(
            "getComputedStyle(document.documentElement).getPropertyValue('--background').trim()",
          ),
      )
      .toBe('#151524')

    await first.page.getByText('Your account').click()
    await first.page.getByRole('menuitem', { name: 'Settings' }).click()
    await expect(first.page.getByRole('heading', { name: 'Appearance' })).toBeVisible()

    await first.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await first.page.getByRole('button', { name: 'System' }).click()
    await expect(first.page.locator('html')).not.toHaveClass(/\bdark\b/)

    await first.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect(first.page.locator('html')).toHaveClass(/\bdark\b/)

    await first.page.getByRole('button', { name: 'Light' }).click()
    await expect(first.page.locator('html')).not.toHaveClass(/\bdark\b/)
    await first.app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect(first.page.locator('html')).not.toHaveClass(/\bdark\b/)

    await first.page.getByRole('button', { name: 'Dark' }).click()
    await expect(first.page.locator('html')).toHaveClass(/\bdark\b/)
    await expect
      .poll(async () => JSON.parse(await readFile(join(userData, 'theme.json'), 'utf8')).preference)
      .toBe('dark')
  } finally {
    await first.app.close()
  }

  const relaunched = await launch(userData)
  try {
    await expect(relaunched.page.locator('html')).toHaveClass(/\bdark\b/)
  } finally {
    await relaunched.app.close()
  }
})
