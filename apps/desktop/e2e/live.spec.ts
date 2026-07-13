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
    // Clear through the editor's real keyboard path. `fill('')` can mutate the contenteditable DOM
    // without Lexical committing an empty controlled value before the next shell re-render.
    await followUpComposer.press('ControlOrMeta+A')
    await followUpComposer.press('Backspace')
    await expect(followUpComposer).toHaveText('')

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

test('live: ask about an agent Message selection in a new Side Thread', async () => {
  const userData = await seedProfile({ thread: false })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    await page.getByText('seeded-project').hover()
    await page.getByLabel('New thread in seeded-project').click()
    await expect(page.getByText('connected')).toBeVisible()

    const composer = page.getByRole('textbox', { name: 'Ask anything…' })
    await composer.fill('Hello fake agent')
    await page.getByLabel('Send message').click()
    await expect(page.getByLabel('Stop turn')).toBeHidden()
    await expect(page.getByText('Fake deterministic thread')).toHaveCount(2)

    // Select a stable substring inside one settled agent message. Building the DOM Range here
    // avoids coordinate-sensitive dragging while still crossing the browser's real Selection /
    // selectionchange boundary that owns the contextual action UI.
    const selectedText = 'This reply is fully deterministic'
    const response = page.getByText(
      'Hello from the fake agent. This reply is fully deterministic, so the visual smoke suite can pin it to the pixel.',
      { exact: true },
    )
    async function selectAgentReplyText(): Promise<void> {
      await response.evaluate((message, text) => {
        // This callback executes in the renderer, but the E2E source is checked by the
        // node tsconfig (no DOM globals). Keep the browser objects structural, matching
        // the other evaluate callbacks in this suite.
        const documentObject = Reflect.get(message, 'ownerDocument') as {
          createTreeWalker(root: unknown, whatToShow: number): {
            currentNode: unknown
            nextNode(): boolean
          }
          createRange(): {
            setStart(node: unknown, offset: number): void
            setEnd(node: unknown, offset: number): void
          }
        }
        const walker = documentObject.createTreeWalker(message, 4 /* NodeFilter.SHOW_TEXT */)
        let textNode: { data: string } | null = null
        while (walker.nextNode()) {
          const candidate = walker.currentNode as { data?: unknown }
          if (typeof candidate.data === 'string' && candidate.data.includes(text)) {
            // The narrowed structural object is still the real renderer Text node.
            const rendererTextNode = candidate as { data: string }
            textNode = rendererTextNode
            break
          }
        }
        if (!textNode) throw new Error(`Could not find selectable text: ${text}`)

        const start = textNode.data.indexOf(text)
        const range = documentObject.createRange()
        range.setStart(textNode, start)
        range.setEnd(textNode, start + text.length)
        const getSelection = Reflect.get(globalThis, 'getSelection') as
          | (() => {
              removeAllRanges(): void
              addRange(range: unknown): void
            } | null)
          | undefined
        const selection = getSelection?.call(globalThis) ?? null
        if (!selection) throw new Error('Window Selection is unavailable')
        selection.removeAllRanges()
        selection.addRange(range)
      }, selectedText)
    }

    const selectionActions = page.getByRole('toolbar', { name: 'Message selection actions' })
    await selectAgentReplyText()
    await expect(selectionActions).toBeVisible()
    await expect(selectionActions.getByRole('button')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(selectionActions).toBeHidden()

    // Escape clears the browser Selection as well as dismissing its toolbar. Recreating
    // the exact same range must be treated as a fresh user selection, not a stale reopen.
    await selectAgentReplyText()
    await expect(selectionActions).toBeVisible()
    await selectionActions.getByRole('button', { name: 'Ask in Side Thread' }).click()

    // Opening the Side Thread stages context but never changes the primary Thread or sends a
    // prompt. The new composer is empty and focused; the original two settled messages remain
    // the only transcript rows with message actions.
    const sidePanel = page.getByRole('complementary', { name: 'Side panel' })
    const sideThreadSurface = sidePanel.locator('[data-side-thread-surface]')
    const sideComposer = sidePanel.getByRole('textbox', { name: 'Ask anything…' })
    await expect(sidePanel.getByText('1 selection', { exact: true })).toBeVisible()
    await expect(sidePanel.getByRole('button', { name: 'Remove selection' })).toBeVisible()
    await expect(sideComposer).toHaveText('')
    await expect(sideComposer).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Ask for follow-up changes' })).toBeVisible()
    await expect(page.getByText('Fake deterministic thread')).toHaveCount(2)
    await expect(page.getByLabel('Copy message')).toHaveCount(2)
    await expect(page.getByLabel('Stop turn')).toBeHidden()

    // The tab strip remains full-bleed, while the Side Thread conversation carries
    // its own compact gutter (the primary conversation gets its gutter from the
    // central outlet instead). Guard the header and Composer against edge regressions.
    const surfaceBox = await sideThreadSurface.boundingBox()
    const headerBox = await sideThreadSurface.locator('.conv__head').boundingBox()
    const composerCardBox = await sideThreadSurface.locator('[data-slot="card"]').boundingBox()
    if (!surfaceBox || !headerBox || !composerCardBox) throw new Error('Side Thread layout unavailable')
    expect(headerBox.x - surfaceBox.x).toBeGreaterThanOrEqual(15)
    expect(composerCardBox.x - surfaceBox.x).toBeGreaterThanOrEqual(15)
    expect(surfaceBox.x + surfaceBox.width - (composerCardBox.x + composerCardBox.width)).toBeGreaterThanOrEqual(15)

    // The first Side Thread prompt crosses the real binding/persistence seam. Its staged
    // selection becomes a sent transcript chip, while the fake agent streams the same
    // deterministic reply into this independently scoped conversation.
    const sideQuestion = 'Why is this reply deterministic?'
    await sideComposer.fill(sideQuestion)
    await sidePanel.getByRole('button', { name: 'Send message' }).click()
    await expect(sidePanel.getByText('pin it to the pixel')).toBeVisible()
    await expect(sidePanel.getByLabel('Stop turn')).toBeHidden()
    await expect(sidePanel.getByText(sideQuestion, { exact: true })).toBeVisible()
    await expect(sidePanel.getByText('1 selection', { exact: true })).toBeVisible()
    await expect(sidePanel.getByRole('button', { name: 'Remove selection' })).toHaveCount(0)

    // The side turn receives its own title and durable Thread row. The primary title and
    // transcript are still present: two identical fake replies now exist, one in each
    // presentation, and neither Side Thread activity promoted the primary selection.
    // The generated title replaces the placeholder in both the Side Thread header and tab.
    await expect(sidePanel.getByText('Fake deterministic thread', { exact: true })).toHaveCount(2)
    const sidebar = page.locator('aside').first()
    await expect(sidebar.getByRole('button', { name: /Fake deterministic thread/ })).toHaveCount(2)
    await expect(
      page.getByText(
        'Hello from the fake agent. This reply is fully deterministic, so the visual smoke suite can pin it to the pixel.',
        { exact: true },
      ),
    ).toHaveCount(2)

    // Selecting the durable Side Thread from the sidebar atomically promotes that SAME
    // Thread to the primary conversation and removes only its alternate Surface. Target the
    // non-active row (both fake Threads deliberately receive the same deterministic title).
    const sideThreadRow = sidebar
      .locator('[data-slot="nav-item"]:not([data-active])')
      .filter({ hasText: 'Fake deterministic thread' })
    await expect(sideThreadRow).toHaveCount(1)
    await sideThreadRow.click()

    // No duplicate presentation is committed: the panel lands on its empty launcher,
    // exactly one central composer/transcript remains, and the promoted Thread retains its
    // existing turn without sending, cancelling, or showing a context-reset resume notice.
    await expect(sidePanel.getByText('Open a surface', { exact: true })).toBeVisible()
    await expect(sidebar.getByRole('button', { name: /Fake deterministic thread/ })).toHaveCount(2)
    await expect(page.getByRole('textbox', { name: 'Ask for follow-up changes' })).toHaveCount(1)
    await expect(page.getByText(sideQuestion, { exact: true })).toBeVisible()
    await expect(page.getByText('Agent context was reset', { exact: false })).toHaveCount(0)
    await expect(page.getByLabel('Stop turn')).toBeHidden()
    await expect(
      page.getByText(
        'Hello from the fake agent. This reply is fully deterministic, so the visual smoke suite can pin it to the pixel.',
        { exact: true },
      ),
    ).toHaveCount(1)
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
          const getStyles = Reflect.get(globalThis, 'getComputedStyle') as (
            target: unknown,
          ) => { backgroundColor: string; color: string }
          const styles = getStyles(element)
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
