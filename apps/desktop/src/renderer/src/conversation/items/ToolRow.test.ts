import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ToolItem } from '../reducer'
import {
  TimelineActivityProvider,
  TimelineHandlersProvider,
  type TimelineHandlers,
} from '../timeline-context'
import { ToolRow } from './ToolRow'

const handlers: TimelineHandlers = {
  onPermission: () => {},
  availableCommands: [],
  onOpenToolFile: () => {},
  onRevealToolFile: () => {},
}

function render(item: ToolItem): string {
  return renderToStaticMarkup(
    createElement(
      TimelineHandlersProvider,
      { value: handlers },
      createElement(
        TimelineActivityProvider,
        { value: { isProcessing: false, lastUserIndex: -1 } },
        createElement(ToolRow, { item, index: 0 }),
      ),
    ),
  )
}

describe('ToolRow — structured Vibe file changes', () => {
  it('renders write_file diff content as a dedicated created-file card with local actions', () => {
    const html = render({
      kind: 'tool',
      id: 'tool:write-1',
      toolCallId: 'write-1',
      toolKind: 'edit',
      status: 'completed',
      title: 'Write src/new.ts',
      locations: [{ path: '/workspace/src/new.ts' }],
      rawInput: undefined,
      rawOutput: { bytesWritten: 12 },
      content: [{ type: 'diff', path: 'src/new.ts', oldText: null, newText: 'export {}\n' }],
    })

    expect(html).toContain('data-file-change-card')
    expect(html).toContain('Created 1 file')
    expect(html).toContain('src/new.ts')
    expect(html).toContain('View changes')
    expect(html).toContain('Open new.ts in file preview')
    expect(html).toContain('Reveal new.ts in Finder')
  })

  it('keeps non-diff tool content on the compact generic row', () => {
    const html = render({
      kind: 'tool',
      id: 'tool:read-1',
      toolCallId: 'read-1',
      toolKind: 'read',
      status: 'completed',
      title: 'Read README.md',
      locations: [{ path: 'README.md' }],
      rawInput: undefined,
      rawOutput: undefined,
      content: [],
    })

    expect(html).not.toContain('data-file-change-card')
    expect(html).toContain('Read README.md')
  })
})
