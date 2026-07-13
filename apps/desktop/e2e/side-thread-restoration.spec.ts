import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { assertBuilt, FAKE_AGENT_BIN, launch, seedProfile } from './launch'

interface FakeLogEntry {
  event: string
  method?: string | null
  sessionId?: string | null
  promptText?: string
}

const FAKE_REPLY =
  'Hello from the fake agent. This reply is fully deterministic, so the visual smoke suite can pin it to the pixel.'

test.beforeAll(() => assertBuilt())

function fakeEnv(logPath: string): Record<string, string> {
  return {
    VIBE_MISTRO_SKIP_SHELL_ENV: '1',
    PATH: `${FAKE_AGENT_BIN}:${process.env.PATH ?? ''}`,
    VIBE_MISTRO_FAKE_LOG_PATH: logPath,
    VIBE_MISTRO_FAKE_DISTINCT_TITLES: '1',
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

async function openSideDraft(page: Page, source: Locator, text: string): Promise<void> {
  await selectAgentText(source, text)
  const toolbar = page.getByRole('toolbar', { name: 'Message selection actions' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: 'Ask in Side Thread' }).click()
}

test('restart restores only valid durable Side placement and lazily resumes its stored cursor', async () => {
  const userData = await seedProfile({ thread: false })
  const firstLog = join(userData, 'fake-agent-first.jsonl')
  const first = await launch(userData, fakeEnv(firstLog))
  let durableThreadId: string
  try {
    await first.page.getByText('seeded-project').hover()
    await first.page.getByLabel('New thread in seeded-project').click()
    await expect(first.page.getByText('connected')).toBeVisible()
    const primaryComposer = first.page.getByRole('textbox', { name: 'Ask anything…' })
    await primaryComposer.fill('Create restart source material')
    await first.page.getByLabel('Send message').click()
    await expect(first.page.getByLabel('Stop turn')).toBeHidden()

    const source = first.page.getByText(FAKE_REPLY, { exact: true })
    await openSideDraft(first.page, source, 'fully deterministic')
    await openSideDraft(first.page, source, 'pin it to the pixel')

    const sidePanel = first.page.getByRole('complementary', { name: 'Side panel' })
    await expect(sidePanel.getByRole('tab')).toHaveCount(2)
    const durablePrompt = 'Persist this Side Thread across restart'
    const sideComposer = sidePanel.getByRole('textbox', { name: 'Ask anything…' })
    await sideComposer.fill(durablePrompt)
    await sideComposer.press('Enter')
    await expect(sidePanel.getByLabel('Stop turn')).toBeHidden()
    await expect(sidePanel.getByRole('tab', { name: 'Fake fake-session-2' })).toBeVisible()

    // Drafts never enter the persisted projection. Inject stale/malformed/duplicate
    // descriptors beside the genuine durable one so the restart exercises metadata
    // reconciliation and active-neighbour fallback, not just a clean round-trip.
    durableThreadId = await first.page.evaluate(() => {
      const storage = Reflect.get(globalThis, 'localStorage') as {
        getItem(key: string): string | null
        setItem(key: string, value: string): void
      }
      const key = 'vibe-mistro:side-panel:v2'
      const map = JSON.parse(storage.getItem(key) ?? '{}') as Record<
        string,
        { isOpen: boolean; activeSurfaceId: string | null; surfaces: unknown[] }
      >
      const state = map['ws-1']
      const durable = state?.surfaces.find(
        (surface) =>
          typeof surface === 'object' &&
          surface !== null &&
          (surface as { kind?: unknown }).kind === 'thread',
      ) as { id: string; kind: 'thread'; threadId: string; lifecycle: 'durable' } | undefined
      if (!state || !durable) throw new Error('Durable Side descriptor was not persisted')
      state.activeSurfaceId = 'thread:stale'
      state.surfaces = [
        durable,
        { id: 'thread:stale', kind: 'thread', threadId: 'stale', lifecycle: 'durable' },
        { id: 'thread:wrong', kind: 'thread', threadId: 'malformed', lifecycle: 'durable' },
        durable,
        { id: 'thread:draft', kind: 'thread', threadId: 'draft', lifecycle: 'draft' },
        { id: 'files', kind: 'files' },
      ]
      map['ws-gone'] = {
        isOpen: true,
        activeSurfaceId: 'review',
        surfaces: [{ id: 'review', kind: 'review' }],
      }
      storage.setItem(key, JSON.stringify(map))
      return durable.threadId
    })
  } finally {
    await first.app.close()
  }

  const secondLog = join(userData, 'fake-agent-second.jsonl')
  const second = await launch(userData, fakeEnv(secondLog))
  try {
    await expect(second.page.getByText('Fake fake-session-2')).toBeVisible()
    // Reading metadata and reconciling local placement is process-free.
    expect(await readFakeLog(secondLog)).toEqual([])

    await second.page.getByText('seeded-project').hover()
    await second.page.getByLabel('New thread in seeded-project').click()
    await expect(second.page.getByText('connected')).toBeVisible()

    const sidePanel = second.page.getByRole('complementary', { name: 'Side panel' })
    await expect(sidePanel).toBeVisible()
    await expect(sidePanel.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true')
    await expect(sidePanel.getByRole('tab', { name: 'Fake fake-session-2' })).toBeVisible()
    await expect(sidePanel.getByRole('tab', { name: 'Side Thread' })).toHaveCount(0)

    const restored = await second.page.evaluate(() => {
      const storage = Reflect.get(globalThis, 'localStorage') as { getItem(key: string): string | null }
      return JSON.parse(storage.getItem('vibe-mistro:side-panel:v2') ?? '{}') as Record<
        string,
        { activeSurfaceId: string | null; surfaces: Array<{ id: string; lifecycle?: string }> }
      >
    })
    expect(Object.keys(restored)).toEqual(['ws-1'])
    expect(restored['ws-1']?.activeSurfaceId).toBe('files')
    expect(restored['ws-1']?.surfaces.map((surface) => surface.id)).toEqual([
      `thread:${durableThreadId}`,
      'files',
    ])
    expect(restored['ws-1']?.surfaces.some((surface) => surface.lifecycle === 'draft')).toBe(false)

    await sidePanel.getByRole('tab', { name: 'Fake fake-session-2' }).click()
    await expect(sidePanel.getByText('Persist this Side Thread across restart', { exact: true })).toBeVisible()
    await expect(sidePanel.getByText(FAKE_REPLY, { exact: true })).toBeVisible()
    expect((await readFakeLog(secondLog)).some((entry) => entry.method === 'session/load')).toBe(false)

    const resumedPrompt = 'Resume from the stored cursor'
    const resumedComposer = sidePanel.getByRole('textbox', { name: 'Ask for follow-up changes' })
    await resumedComposer.fill(resumedPrompt)
    await resumedComposer.press('Enter')
    await expect(sidePanel.getByLabel('Stop turn')).toBeHidden()
    await expect(sidePanel.getByText(resumedPrompt, { exact: true })).toBeVisible()
    await expect
      .poll(async () => {
        const entries = await readFakeLog(secondLog)
        return {
          loaded: entries.some(
            (entry) => entry.method === 'session/load' && entry.sessionId === 'fake-session-2',
          ),
          promptedOnStoredCursor: entries.some(
            (entry) =>
              entry.event === 'prompt:start' &&
              entry.sessionId === 'fake-session-2' &&
              entry.promptText?.startsWith(resumedPrompt),
          ),
        }
      })
      .toEqual({ loaded: true, promptedOnStoredCursor: true })
    await expect(sidePanel.getByText('Agent context was reset', { exact: false })).toHaveCount(0)
  } finally {
    await second.app.close()
  }
})
