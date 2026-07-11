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

    // Shell-style per-Thread prompt recall: first Up captures the unsent scratch and recalls the
    // latest sent prompt; Down past the newest history entry restores that scratch. The user row
    // now shares the settled-message Copy action with the assistant row.
    const followUpComposer = page.getByRole('textbox', { name: 'Ask for follow-up changes' })
    await followUpComposer.fill('unfinished scratch')
    await followUpComposer.press('ArrowUp')
    await expect(followUpComposer).toHaveText('Hello fake agent')
    await followUpComposer.press('ArrowDown')
    await expect(followUpComposer).toHaveText('unfinished scratch')
    await expect(page.getByLabel('Copy message')).toHaveCount(2)
    await followUpComposer.evaluate((editor) => {
      const card = editor.closest('[data-slot="card"]')
      if (!card) throw new Error('Composer card not found')
      const DataTransferCtor = Reflect.get(globalThis, 'DataTransfer') as new () => {
        items: { add(file: File): void }
      }
      const DragEventCtor = Reflect.get(globalThis, 'DragEvent') as new (
        type: string,
        init: { bubbles: boolean; dataTransfer: unknown },
      ) => Event
      const transfer = new DataTransferCtor()
      transfer.items.add(new File(['fake png'], 'drop.png', { type: 'image/png' }))
      card.dispatchEvent(new DragEventCtor('drop', { bubbles: true, dataTransfer: transfer }))
    })
    await expect(page.getByAltText('drop.png')).toBeVisible()
    await page.getByLabel('Remove drop.png').click()
    await followUpComposer.fill('')

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
