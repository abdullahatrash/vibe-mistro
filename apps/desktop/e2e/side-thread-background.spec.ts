import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { assertBuilt, FAKE_AGENT_BIN, launch, seedProfile } from './launch'

interface FakeLogEntry {
  at: number
  event: string
  method?: string | null
  sessionId?: string | null
  promptText?: string
}

const FAKE_REPLY =
  'Hello from the fake agent. This reply is fully deterministic, so the visual smoke suite can pin it to the pixel.'

test.beforeAll(() => {
  assertBuilt()
})

function fakeEnv(logPath: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    VIBE_MISTRO_SKIP_SHELL_ENV: '1',
    PATH: `${FAKE_AGENT_BIN}:${process.env.PATH ?? ''}`,
    VIBE_MISTRO_FAKE_LOG_PATH: logPath,
    VIBE_MISTRO_FAKE_DISTINCT_TITLES: '1',
    ...extra,
  }
}

async function readFakeLog(logPath: string): Promise<FakeLogEntry[]> {
  try {
    return (await readFile(logPath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as FakeLogEntry)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return []
    throw error
  }
}

async function selectAgentText(message: Locator, text: string): Promise<void> {
  await message.evaluate((element, selectedText) => {
    // E2E is checked by the node tsconfig. Keep renderer DOM capabilities structural,
    // as in live.spec, while exercising the browser's real Selection boundary.
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
    const walker = documentObject.createTreeWalker(element, 4 /* NodeFilter.SHOW_TEXT */)
    let textNode: { data: string } | null = null
    while (walker.nextNode()) {
      const candidate = walker.currentNode as { data?: unknown }
      if (typeof candidate.data === 'string' && candidate.data.includes(selectedText)) {
        textNode = candidate as { data: string }
        break
      }
    }
    if (!textNode) throw new Error(`Could not find selectable text: ${selectedText}`)

    const start = textNode.data.indexOf(selectedText)
    const range = documentObject.createRange()
    range.setStart(textNode, start)
    range.setEnd(textNode, start + selectedText.length)
    const getSelection = Reflect.get(globalThis, 'getSelection') as
      | (() => { removeAllRanges(): void; addRange(range: unknown): void } | null)
      | undefined
    const selection = getSelection?.call(globalThis) ?? null
    if (!selection) throw new Error('Window Selection is unavailable')
    selection.removeAllRanges()
    selection.addRange(range)
  }, text)
}

async function establishPrimary(page: Page): Promise<Locator> {
  await page.getByText('seeded-project').hover()
  await page.getByLabel('New thread in seeded-project').click()
  await expect(page.getByText('connected')).toBeVisible()

  const composer = page.getByRole('textbox', { name: 'Ask anything…' })
  await composer.fill('Establish a source Message')
  await page.getByLabel('Send message').click()
  await expect(page.getByLabel('Stop turn')).toBeHidden()
  await expect(page.getByText('Fake fake-session-1')).toHaveCount(2)
  return page.getByText(FAKE_REPLY, { exact: true })
}

async function openSideThread(
  page: Page,
  sourceMessage: Locator,
  selectedText = 'This reply is fully deterministic',
): Promise<Locator> {
  await selectAgentText(sourceMessage, selectedText)
  const toolbar = page.getByRole('toolbar', { name: 'Message selection actions' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Ask in Side Thread' }).click()
  const sidePanel = page.getByRole('complementary', { name: 'Side panel' })
  await expect(sidePanel.getByText('1 selection', { exact: true })).toBeVisible()
  return sidePanel
}

function promptTurnOverlapped(
  entries: FakeLogEntry[],
  firstPrompt: string,
  secondPrompt: string,
): boolean {
  const first = entries.find(
    (entry) => entry.event === 'prompt:start' && entry.promptText?.startsWith(firstPrompt),
  )
  const second = entries.find(
    (entry) => entry.event === 'prompt:start' && entry.promptText?.startsWith(secondPrompt),
  )
  if (!first?.sessionId || !second?.sessionId || first.sessionId === second.sessionId) return false

  const firstEnd = entries.find(
    (entry) =>
      entry.event === 'prompt:end' &&
      entry.sessionId === first.sessionId &&
      entry.at >= first.at,
  )
  const secondEnd = entries.find(
    (entry) =>
      entry.event === 'prompt:end' &&
      entry.sessionId === second.sessionId &&
      entry.at >= second.at,
  )
  return Math.max(first.at, second.at) < Math.min(firstEnd?.at ?? Infinity, secondEnd?.at ?? Infinity)
}

test('Side Thread work survives tab, panel, and Surface lifecycle changes', async () => {
  const userData = await seedProfile({ thread: false })
  const logPath = join(userData, 'fake-agent.jsonl')
  const { app, page } = await launch(
    userData,
    fakeEnv(logPath, { VIBE_MISTRO_FAKE_TURN_HOLD_MS: '700' }),
  )
  try {
    const sourceMessage = await establishPrimary(page)
    const sidePanel = await openSideThread(page, sourceMessage)

    const sidePrompt = 'Explain this while I keep working'
    const sideComposer = sidePanel.getByRole('textbox', { name: 'Ask anything…' })
    await sideComposer.fill(sidePrompt)
    await sidePanel.getByRole('button', { name: 'Send message' }).click()
    await expect(sidePanel.getByRole('tab', { name: /Streaming/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Fake fake-session-2.*Streaming/ })).toBeVisible()

    // Primary and Side Threads share one agent process but own distinct ACP sessions.
    // Starting a primary follow-up while the held Side turn is live must overlap it.
    const primaryPrompt = 'Primary work overlaps the Side Thread'
    const primaryComposer = page.getByRole('textbox', { name: 'Ask for follow-up changes' }).first()
    await primaryComposer.fill(primaryPrompt)
    await primaryComposer.press('Enter')
    await expect(page.getByRole('button', { name: /Fake fake-session-1.*Streaming/ })).toBeVisible()
    await expect
      .poll(async () => promptTurnOverlapped(await readFakeLog(logPath), sidePrompt, primaryPrompt))
      .toBe(true)

    // Activating Files unmounts the Side conversation view. The tab and normal Thread
    // row still project main's authoritative streaming state.
    await sidePanel.getByLabel('Open a surface').click()
    await page.getByRole('menuitem', { name: /Files/ }).click()
    const backgroundSideTab = sidePanel.getByRole('tab', {
      name: /Fake fake-session-2.*Streaming/,
    })
    await expect(backgroundSideTab).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByRole('button', { name: /Fake fake-session-2.*Streaming/ })).toBeVisible()

    // Hiding the whole panel also unmounts its body. Main keeps the turn and transcript
    // alive; reopening and returning to the tab catches up through normal replay once.
    await page.getByLabel('Close side panel').click()
    await expect(sidePanel).toBeHidden()
    await expect
      .poll(async () => {
        const entries = await readFakeLog(logPath)
        return entries.filter((entry) => entry.event === 'prompt:end').length
      })
      .toBeGreaterThanOrEqual(3)
    await page.getByLabel('Open side panel').click()
    await sidePanel.getByRole('tab', { name: 'Fake fake-session-2' }).click()
    await expect(sidePanel.getByText(sidePrompt, { exact: true })).toBeVisible()
    await expect(sidePanel.getByText(FAKE_REPLY, { exact: true })).toHaveCount(1)
    await expect
      .poll(async () => {
        const entries = await readFakeLog(logPath)
        return entries.filter(
          (entry) => entry.event === 'prompt:start' && entry.promptText?.startsWith(sidePrompt),
        ).length
      })
      .toBe(1)

    // Explicitly closing the durable Surface during another turn is presentation-only.
    const closePrompt = 'Keep running after the Surface closes'
    const followUp = sidePanel.getByRole('textbox', { name: 'Ask for follow-up changes' })
    await followUp.fill(closePrompt)
    await followUp.press('Enter')
    await expect(sidePanel.getByRole('tab', { name: /Fake fake-session-2.*Streaming/ })).toBeVisible()
    await sidePanel.getByRole('button', { name: 'Close Fake fake-session-2' }).click()
    await expect(page.getByRole('button', { name: /Fake fake-session-2.*Streaming/ })).toBeVisible()
    await expect
      .poll(async () => {
        const entries = await readFakeLog(logPath)
        const start = entries.find(
          (entry) => entry.event === 'prompt:start' && entry.promptText?.startsWith(closePrompt),
        )
        return Boolean(
          start &&
            entries.some(
              (entry) =>
                entry.event === 'prompt:end' &&
                entry.sessionId === start.sessionId &&
                entry.at >= start.at,
            ),
        )
      })
      .toBe(true)
    await expect(page.getByRole('button', { name: /Fake fake-session-2/ })).toBeVisible()

    // Bulk close has the same presentation-only contract. A fresh Side Thread plus
    // the still-open Files Surface are removed together while its turn keeps running.
    const bulkSidePanel = await openSideThread(
      page,
      page.getByText('Establish a source Message', { exact: true }),
      'Establish a source',
    )
    const bulkPrompt = 'Keep running after all Surfaces close'
    const bulkComposer = bulkSidePanel.getByRole('textbox', { name: 'Ask anything…' })
    await bulkComposer.fill(bulkPrompt)
    await bulkComposer.press('Enter')
    const bulkTab = bulkSidePanel.getByRole('tab', {
      name: /Fake fake-session-3.*Streaming/,
    })
    await expect(bulkTab).toBeVisible()
    await bulkTab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close all', exact: true }).click()
    await expect(bulkSidePanel).toBeHidden()
    await expect(page.getByLabel('Open side panel')).toBeVisible()
    await expect(page.getByRole('button', { name: /Fake fake-session-3.*Streaming/ })).toBeVisible()
    await expect
      .poll(async () => {
        const log = await readFakeLog(logPath)
        const start = log.find(
          (entry) => entry.event === 'prompt:start' && entry.promptText?.startsWith(bulkPrompt),
        )
        return Boolean(
          start &&
            log.some(
              (entry) =>
                entry.event === 'prompt:end' &&
                entry.sessionId === start.sessionId &&
                entry.at >= start.at,
            ),
        )
      })
      .toBe(true)
    await expect(page.getByRole('button', { name: /Fake fake-session-3/ })).toBeVisible()

    const entries = await readFakeLog(logPath)
    expect(entries.filter((entry) => entry.method === 'session/cancel')).toEqual([])
  } finally {
    await app.close()
  }
})

test('Permission attention follows an inactive Side Thread and clears when answered', async () => {
  const userData = await seedProfile({ thread: false })
  const logPath = join(userData, 'fake-agent.jsonl')
  const { app, page } = await launch(
    userData,
    fakeEnv(logPath, { VIBE_MISTRO_FAKE_PERMISSION_TRIGGER: '[permission]' }),
  )
  try {
    const sourceMessage = await establishPrimary(page)
    const sidePanel = await openSideThread(page, sourceMessage)
    const sideComposer = sidePanel.getByRole('textbox', { name: 'Ask anything…' })

    // Side Threads start in read-only Chat Mode; Permission-producing work is only
    // possible after the user deliberately switches this Thread to a tool-capable Mode.
    await sidePanel.getByLabel('Mode', { exact: true }).click()
    await page.getByRole('menuitem', { name: 'Default', exact: true }).click()
    await expect(sidePanel.getByLabel('Mode', { exact: true })).toContainText('Default')
    await sideComposer.fill('Please pause for [permission]')
    await sideComposer.press('Enter')

    await expect(sidePanel.getByText(/Permission request/)).toBeVisible()
    const attentionTab = sidePanel.getByRole('tab', { name: /Needs attention/ })
    await expect(attentionTab).toBeVisible()
    const sideRow = page.getByRole('button', { name: /Fake fake-session-2/ })
    await expect(sideRow.getByTitle('Awaiting your response')).toBeVisible()

    // The Permission row unmounts on another Surface, while authoritative attention
    // remains on both the inactive tab and normal durable Thread row.
    await sidePanel.getByLabel('Open a surface').click()
    await page.getByRole('menuitem', { name: /Files/ }).click()
    await expect(attentionTab).toHaveAttribute('aria-selected', 'false')
    await expect(sideRow.getByTitle('Awaiting your response')).toBeVisible()

    await attentionTab.click()
    await expect(sidePanel.getByText(/Permission request/)).toBeVisible()
    await sidePanel.getByRole('button', { name: 'Allow once' }).click()
    await expect(sidePanel.getByRole('tab', { name: /Needs attention/ })).toHaveCount(0)
    await expect(sideRow.getByTitle('Awaiting your response')).toHaveCount(0)
    await expect(sidePanel.getByText(FAKE_REPLY, { exact: true })).toBeVisible()

    // Closing a durable Side Thread with a second unanswered request removes only
    // its presentation. The normal Thread row remains the recovery affordance and
    // continues to expose both the live turn and its required attention.
    const followUp = sidePanel.getByRole('textbox', { name: 'Ask for follow-up changes' })
    await followUp.fill('Keep [permission] visible after close')
    await followUp.press('Enter')
    await expect(sidePanel.getByRole('tab', { name: /Needs attention/ })).toBeVisible()
    await sidePanel.getByRole('button', { name: 'Close Fake fake-session-2' }).click()
    await expect(sideRow.getByTitle('Awaiting your response')).toBeVisible()
    await expect(page.getByRole('button', { name: /Fake fake-session-2.*Streaming/ })).toBeVisible()

    const entries = await readFakeLog(logPath)
    expect(entries.filter((entry) => entry.method === 'session/cancel')).toEqual([])
  } finally {
    await app.close()
  }
})
