import { expect, test } from '@playwright/test'
import { assertBuilt, FAKE_AGENT_BIN, launch, seedProfile } from './launch'

/**
 * Visual smoke suite (slice 2): the LIVE conversation states, driven against the
 * scripted fake `vibe-acp` (`e2e/fake-agent/vibe-acp` — deterministic ACP over
 * stdio, shapes verbatim from `docs/acp-capture.md`). Routing to the fake needs
 * BOTH env seams: `VIBE_MISTRO_SKIP_SHELL_ENV` (else the probed login-shell PATH
 * wins and finds the real agent) and the fake-bin dir prepended to PATH.
 *
 * Everything on screen is pinned deterministic: fixed session ids, fixed reply
 * text, fixed usage numbers, a fixed thread title pushed by the fake's
 * `session_info_update`, and screenshots taken only AFTER the turn ends (no
 * "Working for Ns" timer in frame).
 */

const FAKE_ENV = {
  VIBE_MISTRO_SKIP_SHELL_ENV: '1',
  PATH: `${FAKE_AGENT_BIN}:${process.env.PATH ?? ''}`,
}

test.beforeAll(() => {
  assertBuilt()
})

test('live: connect on the fake agent, stream a turn, open the side panel', async () => {
  const userData = await seedProfile({ thread: false })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    // Connect by starting a thread in the seeded project (the sidebar ＋ —
    // hover-revealed, so hover the row first). This spawns `vibe-acp` —
    // resolved to the fake via FAKE_ENV — and lands on a connected draft.
    await page.getByText('seeded-project').hover()
    await page.getByLabel('New thread in seeded-project').click()
    await expect(page.getByText('connected')).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Ask anything…' })
    await expect(composer).toBeVisible()
    // Agent controls seeded from the fake's session/new: Default / model / High.
    await expect(page.getByLabel('Mode', { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot('live-draft.png')

    // One deterministic turn: echo + streamed markdown reply + usage footer.
    await composer.fill('Hello fake agent')
    await page.getByLabel('Send message').click()
    await expect(page.getByText('pin it to the pixel')).toBeVisible()
    // Turn end: the stop affordance leaves and the fake's fixed title lands in
    // BOTH the header and the sidebar row (count 2) — the sidebar rename arrives
    // via an async metadata refresh after the turn, so gating on the header alone
    // raced the screenshot against the row flipping from "New thread (draft)".
    await expect(page.getByLabel('Stop turn')).toBeHidden()
    await expect(page.getByText('Fake deterministic thread')).toHaveCount(2)
    await expect(page.getByText('now', { exact: true })).toBeVisible()
    await expect(page).toHaveScreenshot('live-conversation.png')

    // Side panel over the conversation: launcher grid, and the chat column
    // narrows under the composer's compact breakpoints (icon-only chips,
    // 32px send) — pinning the #203 adaptivity work.
    await page.getByLabel('Open side panel').click()
    await expect(page.getByText('Open a surface')).toBeVisible()
    await expect(page).toHaveScreenshot('live-panel-launcher.png')
  } finally {
    await app.close()
  }
})

test('live: reopening an old thread resumes on the fake agent with history intact', async () => {
  // A profile with a persisted Thread whose session is stale: clicking it must
  // auto-continue (#203) — connect the Workspace seeded with THIS Thread — and
  // NOT show the old Continue/history chrome.
  const userData = await seedProfile({ thread: true })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    await page.getByText('seeded-project').click()
    await page.getByText('Sum two numbers').click()
    await expect(page.getByText('connected')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Ask anything…' })).toBeVisible()
    // The Continue-era chrome must NOT be present (resume is first-prompt-lazy).
    await expect(page.getByRole('button', { name: 'Continue' })).toHaveCount(0)
    await expect(page.getByText('history', { exact: true })).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('live: terminal keeps readable colors in the built renderer', async () => {
  const userData = await seedProfile({ thread: false })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    await page.getByText('seeded-project').hover()
    await page.getByLabel('New thread in seeded-project').click()
    await expect(page.getByText('connected')).toBeVisible()

    await page.getByLabel('Open side panel').click()
    await page.getByText('Terminal', { exact: true }).click()

    const terminalMount = page.locator('.xterm').locator('..')
    await expect(terminalMount).toBeVisible()
    await expect
      .poll(() =>
        terminalMount.evaluate((element) => {
          const styles = element.ownerDocument.defaultView?.getComputedStyle(element)
          return { background: styles.backgroundColor, foreground: styles.color }
        }),
      )
      .toEqual({ background: 'rgb(28, 27, 26)', foreground: 'rgb(216, 210, 202)' })
  } finally {
    await app.close()
  }
})

test('live: opened files render numbered code rows', async () => {
  const userData = await seedProfile({
    thread: false,
    files: { 'numbered.ts': 'const first = 1\nconst second = 2\n' },
  })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    await page.getByText('seeded-project').hover()
    await page.getByLabel('New thread in seeded-project').click()
    await expect(page.getByText('connected')).toBeVisible()

    await page.getByLabel('Open side panel').click()
    await page.getByRole('button', { name: /Files/ }).click()
    const fileTree = page.locator('file-tree-container')
    await expect
      .poll(() =>
        fileTree.evaluate(
          (tree) => tree.shadowRoot?.querySelector('[data-item-path="numbered.ts"]') !== null,
        ),
      )
      .toBe(true)
    await fileTree.evaluate((tree) => {
      const row = tree.shadowRoot?.querySelector('[data-item-path="numbered.ts"]') as {
        click(): void
      } | null
      row?.click()
    })

    const preview = page.locator('diffs-container')
    await expect(preview.locator('[data-column-number="1"]')).toBeVisible()
    await expect(preview.locator('[data-column-number="2"]')).toBeVisible()
  } finally {
    await app.close()
  }
})
