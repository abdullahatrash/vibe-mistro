import { describe, expect, it } from 'vitest'
import type { WorkspacePanelState } from '../side-panel/side-panel-store'
import { planPrimaryThreadPromotion } from './side-thread-promotion'

function panel(): WorkspacePanelState {
  return {
    isOpen: true,
    activeSurfaceId: 'thread:side-a',
    surfaces: [
      { id: 'review', kind: 'review' },
      { id: 'thread:side-a', kind: 'thread', threadId: 'side-a', lifecycle: 'durable' },
      { id: 'thread:side-b', kind: 'thread', threadId: 'side-b', lifecycle: 'durable' },
      { id: 'files', kind: 'files' },
    ],
  }
}

describe('planPrimaryThreadPromotion', () => {
  it('removes only the matching Side Surface and preserves sibling order and activation', () => {
    const current = panel()

    const promotion = planPrimaryThreadPromotion(current, 'side-a', new Set(['side-a']))

    expect(promotion.panel).toEqual({
      isOpen: true,
      activeSurfaceId: 'thread:side-b',
      surfaces: [
        { id: 'review', kind: 'review' },
        { id: 'thread:side-b', kind: 'thread', threadId: 'side-b', lifecycle: 'durable' },
        { id: 'files', kind: 'files' },
      ],
    })
    expect(promotion.view).toBe('live')
  })

  it('keeps the exact panel reference when the selected Thread owns no Side Surface', () => {
    const current = panel()

    expect(planPrimaryThreadPromotion(current, 'ordinary-thread', new Set()).panel).toBe(current)
  })

  it('isolates matching by Thread id even when sibling Side Surfaces share a lifecycle', () => {
    const current = panel()

    const promotion = planPrimaryThreadPromotion(current, 'side-b', new Set(['side-b']))

    expect(promotion.panel.surfaces).toEqual([
      { id: 'review', kind: 'review' },
      { id: 'thread:side-a', kind: 'thread', threadId: 'side-a', lifecycle: 'durable' },
      { id: 'files', kind: 'files' },
    ])
    expect(promotion.panel.activeSurfaceId).toBe('thread:side-a')
  })

  it('routes a currently hosted Thread live and an unhosted Thread cold', () => {
    const current = panel()

    expect(planPrimaryThreadPromotion(current, 'side-a', new Set(['side-a'])).view).toBe('live')
    expect(planPrimaryThreadPromotion(current, 'side-a', new Set()).view).toBe('cold')
  })
})
