import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { assertBuilt, FAKE_AGENT_BIN, launch, seedProfile } from './launch'

const FAKE_ENV = {
  VIBE_MISTRO_SKIP_SHELL_ENV: '1',
  PATH: `${FAKE_AGENT_BIN}:${process.env.PATH ?? ''}`,
}

const AGENT_REPLY =
  'Hello from the fake agent. This reply is fully deterministic, so the visual smoke suite can pin it to the pixel.'

test.beforeAll(() => assertBuilt())

async function establishConversation(page: Page): Promise<{
  user: Locator
  agent: Locator
  composer: Locator
}> {
  await page.getByText('seeded-project').hover()
  await page.getByLabel('New thread in seeded-project').click()
  await expect(page.getByText('connected')).toBeVisible()

  const composer = page.getByRole('textbox', { name: 'Ask anything…' })
  await composer.fill('User source words alpha beta\n\n```ts\nconst answer = 42\n```')
  await page.getByLabel('Send message').click()
  await expect(page.getByLabel('Stop turn')).toBeHidden()

  return {
    user: page.locator('[data-message-selection-content][data-message-role="user"]'),
    agent: page
      .locator('[data-message-selection-content][data-message-role="agent"]')
      .filter({ hasText: AGENT_REPLY }),
    composer: page.getByRole('textbox', { name: 'Ask for follow-up changes' }),
  }
}

async function textRangePoints(
  boundary: Locator,
  text: string,
): Promise<{ start: { x: number; y: number }; end: { x: number; y: number } }> {
  return boundary.evaluate((element, selectedText) => {
    const documentObject = Reflect.get(element, 'ownerDocument') as {
      createTreeWalker(root: unknown, whatToShow: number): {
        currentNode: unknown
        nextNode(): boolean
      }
      createRange(): {
        setStart(node: unknown, offset: number): void
        setEnd(node: unknown, offset: number): void
        getBoundingClientRect(): { left: number; top: number; width: number; height: number }
      }
    }
    const walker = documentObject.createTreeWalker(element, 4)
    while (walker.nextNode()) {
      const node = walker.currentNode as { data?: unknown }
      if (typeof node.data !== 'string') continue
      const start = node.data.indexOf(selectedText)
      if (start < 0) continue
      const range = documentObject.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + selectedText.length)
      const rect = range.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      return {
        start: { x: rect.left + 1, y },
        end: { x: rect.left + Math.max(2, rect.width - 1), y },
      }
    }
    throw new Error(`Could not locate text: ${selectedText}`)
  }, text)
}

async function selectText(boundary: Locator, text: string): Promise<void> {
  await boundary.evaluate((element, selectedText) => {
    const documentObject = Reflect.get(element, 'ownerDocument') as {
      createTreeWalker(root: unknown, whatToShow: number): {
        currentNode: unknown
        nextNode(): boolean
      }
      createRange(): {
        setStart(node: unknown, offset: number): void
        setEnd(node: unknown, offset: number): void
      }
    }
    const walker = documentObject.createTreeWalker(element, 4)
    while (walker.nextNode()) {
      const node = walker.currentNode as { data?: unknown }
      if (typeof node.data !== 'string') continue
      const start = node.data.indexOf(selectedText)
      if (start < 0) continue
      const range = documentObject.createRange()
      range.setStart(node, start)
      range.setEnd(node, start + selectedText.length)
      const selection = (
        Reflect.get(globalThis, 'getSelection') as
          | (() => { removeAllRanges(): void; addRange(range: unknown): void } | null)
          | undefined
      )?.call(globalThis)
      if (!selection) throw new Error('Window Selection is unavailable')
      selection.removeAllRanges()
      selection.addRange(range)
      return
    }
    throw new Error(`Could not locate text: ${selectedText}`)
  }, text)
}

async function selectAcrossMessages(startBoundary: Locator, endBoundary: Locator): Promise<void> {
  const start = await startBoundary.elementHandle()
  const end = await endBoundary.elementHandle()
  if (!start || !end) throw new Error('Message boundary unavailable')
  await startBoundary.page().evaluate(
    ([startElement, endElement]) => {
      const documentObject = Reflect.get(startElement, 'ownerDocument') as {
        createTreeWalker(root: unknown, whatToShow: number): {
          currentNode: unknown
          nextNode(): boolean
        }
        createRange(): {
          setStart(node: unknown, offset: number): void
          setEnd(node: unknown, offset: number): void
        }
      }
      const firstWalker = documentObject.createTreeWalker(startElement, 4)
      const lastWalker = documentObject.createTreeWalker(endElement, 4)
      if (!firstWalker.nextNode() || !lastWalker.nextNode()) throw new Error('Message text unavailable')
      let lastNode = lastWalker.currentNode as { data?: unknown }
      while (lastWalker.nextNode()) lastNode = lastWalker.currentNode as { data?: unknown }
      const range = documentObject.createRange()
      range.setStart(firstWalker.currentNode, 0)
      range.setEnd(lastNode, typeof lastNode.data === 'string' ? lastNode.data.length : 0)
      const selection = (
        Reflect.get(globalThis, 'getSelection') as
          | (() => { removeAllRanges(): void; addRange(range: unknown): void } | null)
          | undefined
      )?.call(globalThis)
      if (!selection) throw new Error('Window Selection is unavailable')
      selection.removeAllRanges()
      selection.addRange(range)
    },
    [start, end],
  )
}

async function collapseSelection(page: Page): Promise<void> {
  await page.evaluate(() => {
    const selection = (
      Reflect.get(globalThis, 'getSelection') as
        | (() => { removeAllRanges(): void } | null)
        | undefined
    )?.call(globalThis)
    selection?.removeAllRanges()
  })
}

async function resize(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, nextWidth) => {
    const window = BrowserWindow.getAllWindows()[0]
    const bounds = window?.getBounds()
    if (window && bounds) window.setBounds({ ...bounds, width: nextWidth })
  }, width)
}

test('Message selection eligibility, dismissal, and activation preserve user-visible context', async () => {
  const userData = await seedProfile({ thread: false })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    const { user, agent, composer } = await establishConversation(page)
    const toolbar = page.getByRole('toolbar', { name: 'Message selection actions' })

    // A real pointer drag inside agent prose exposes the sole action.
    const pointerTarget = await textRangePoints(agent, 'fully deterministic')
    await page.mouse.move(pointerTarget.start.x, pointerTarget.start.y)
    await page.mouse.down()
    await page.mouse.move(pointerTarget.end.x, pointerTarget.end.y, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(() =>
        page.evaluate(() => {
          const getSelection = Reflect.get(globalThis, 'getSelection') as
            | (() => { toString(): string } | null)
            | undefined
          return getSelection?.call(globalThis)?.toString() ?? ''
        }),
      )
      .toContain('fully deterministic')
    await expect(toolbar).toBeVisible()
    await expect(toolbar.getByRole('button')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(toolbar).toBeHidden()

    // User Message text and fenced-code source content share the eligible boundary.
    await selectText(user, 'User source words')
    await expect(toolbar).toBeVisible()
    await collapseSelection(page)
    await expect(toolbar).toBeHidden()
    await selectText(user, 'const answer = 42')
    await expect(toolbar).toBeVisible()
    await page.keyboard.press('Escape')

    // Whitespace and cross-Message ranges are rejected at the visible toolbar seam.
    await selectText(user, ' ')
    await expect(toolbar).toBeHidden()
    await selectAcrossMessages(user, agent)
    await expect(toolbar).toBeHidden()

    // Outside interaction, transcript scroll, and collapse dismiss stale actions.
    await selectText(agent, 'fully deterministic')
    await expect(toolbar).toBeVisible()
    await composer.click()
    await expect(toolbar).toBeHidden()

    await selectText(agent, 'fully deterministic')
    await expect(toolbar).toBeVisible()
    await page.locator('.messages').first().evaluate((element) => {
      const EventCtor = Reflect.get(globalThis, 'Event') as new (
        type: string,
        init: { bubbles: boolean },
      ) => { type: string }
      element.dispatchEvent(new EventCtor('scroll', { bubbles: true }) as never)
    })
    await expect(toolbar).toBeHidden()

    // Pointer activation keeps the exact Selection alive through capture; the staged
    // chip's inspectable title proves the excerpt/provenance survived the handoff.
    const selectedText = 'This reply is fully deterministic'
    await selectText(agent, selectedText)
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Ask in Side Thread' }).click()
    const sidePanel = page.getByRole('complementary', { name: 'Side panel' })
    const chip = sidePanel.locator('[data-pending-context-chip]')
    await expect(chip).toContainText('1 selection')
    await expect(chip).toHaveAttribute('title', new RegExp(`Source role: Agent[\\s\\S]*${selectedText}`))
  } finally {
    await app.close()
  }
})

test('keyboard-notified selection action remains reachable in the narrow Sheet presentation', async () => {
  const userData = await seedProfile({ thread: false })
  const { app, page } = await launch(userData, FAKE_ENV)
  try {
    await resize(app, 820)
    const { agent } = await establishConversation(page)
    const toolbar = page.getByRole('toolbar', { name: 'Message selection actions' })

    // selectionchange creates the range; keyup is the keyboard final-state path the
    // controller listens to after a Shift gesture.
    await selectText(agent, 'fully deterministic')
    await expect(toolbar).toBeVisible()
    await page.keyboard.press('Shift')
    await expect(toolbar).toBeVisible()
    await toolbar.getByRole('button', { name: 'Ask in Side Thread' }).click()

    await expect(page.locator('[data-slot="sheet-popup"][aria-label="Side panel"]')).toBeVisible()
    await expect(
      page.getByRole('complementary', { name: 'Side panel' }).getByText('1 selection', { exact: true }),
    ).toBeVisible()
  } finally {
    await app.close()
  }
})
