import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { Popover as BasePopover } from '@base-ui/react/popover'
import { MessagesSquare } from 'lucide-react'
import { Button } from '../ui/button'
import {
  clearMessageSelection,
  deriveMessageSelection,
  type MessageSelection,
  type MessageSelectionBoundary,
  type MessageSelectionRole,
} from './message-selection'

interface SelectionSnapshot {
  messageSelection: MessageSelection
  range: Range
}

/**
 * One selection-scoped action for eligible conversation Messages. The popup is
 * portalled and anchored to the actual browser Range, so Base UI can flip/shift
 * it at scroll-container and viewport edges instead of clipping it inside the
 * transcript.
 */
export function MessageSelectionToolbar({
  conversationRef,
  thread,
  onAskInSideThread,
}: {
  conversationRef: RefObject<HTMLDivElement | null>
  thread: { id: string; title: string }
  onAskInSideThread: (selection: MessageSelection) => void
}): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<SelectionSnapshot | null>(null)
  const snapshotRef = useRef<SelectionSnapshot | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const threadId = thread.id
  const threadTitle = thread.title

  const readSelection = useCallback((): SelectionSnapshot | null => {
    const root = conversationRef.current
    const browserSelection = window.getSelection()
    if (!root || !browserSelection || browserSelection.isCollapsed || browserSelection.rangeCount === 0) {
      return null
    }

    const messageSelection = deriveMessageSelection({
      text: browserSelection.toString(),
      anchor: findBoundary(browserSelection.anchorNode, root),
      focus: findBoundary(browserSelection.focusNode, root),
      thread: { id: threadId, title: threadTitle },
    })
    if (!messageSelection) return null

    return {
      messageSelection,
      // Keep an independent Range as the positioning anchor. Preventing default on
      // pointer-down below keeps the visible browser selection intact as well.
      range: browserSelection.getRangeAt(0).cloneRange(),
    }
  }, [conversationRef, threadId, threadTitle])

  const updateSnapshot = useCallback((next: SelectionSnapshot | null): void => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])
  const refresh = useCallback((): void => updateSnapshot(readSelection()), [readSelection, updateSnapshot])
  const dismiss = useCallback((): void => {
    // Only the Conversation that owns the visible toolbar may clear the global
    // Selection. Background Conversations also listen at document scope, but their
    // null snapshot must never disturb a selection elsewhere in the app.
    if (!snapshotRef.current) return
    clearMessageSelection(window.getSelection())
    updateSnapshot(null)
  }, [updateSnapshot])

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const target = event.target
      if (target instanceof Node && toolbarRef.current?.contains(target)) return
      dismiss()
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') dismiss()
    }

    // `selectionchange` covers keyboard expansion as well as pointer selection.
    // pointerup/keyup are retained as final-state reads for browsers that coalesce
    // selectionchange while a drag or Shift+Arrow gesture is active.
    document.addEventListener('selectionchange', refresh)
    document.addEventListener('pointerup', refresh)
    document.addEventListener('keyup', refresh)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('selectionchange', refresh)
      document.removeEventListener('pointerup', refresh)
      document.removeEventListener('keyup', refresh)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [dismiss, refresh])

  if (!snapshot) return null

  return (
    // Dismissal is owned by the document listeners above. Letting Base UI close an
    // externally opened popup on outside press would treat the pointer-up that
    // completes the source text drag as an outside interaction and erase the new
    // Selection before the user can act on it.
    <BasePopover.Root open>
      <BasePopover.Portal>
        <BasePopover.Positioner
          anchor={snapshot.range}
          positionMethod="fixed"
          side="top"
          sideOffset={6}
          align="center"
          collisionPadding={8}
          collisionAvoidance={{ side: 'flip', align: 'shift', fallbackAxisSide: 'none' }}
          className="z-50"
        >
          <BasePopover.Popup
            ref={toolbarRef}
            role="toolbar"
            aria-label="Message selection actions"
            initialFocus={false}
            finalFocus={false}
            className="rounded-md border border-border bg-panel p-1 shadow-lg outline-none"
          >
            <Button
              type="button"
              variant="ghost"
              size="xs"
              // Do not let pointer activation move focus and collapse the source
              // selection before its verbatim text reaches the callback.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                // Preserve the Selection through the handoff, then clear it so a
                // later global refresh cannot reopen the source action.
                onAskInSideThread(snapshot.messageSelection)
                dismiss()
              }}
            >
              <MessagesSquare className="size-3.5" aria-hidden />
              Ask in Side Thread
            </Button>
          </BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  )
}

function findBoundary(node: Node | null, root: HTMLElement): MessageSelectionBoundary | null {
  const element = node instanceof Element ? node : node?.parentElement
  const boundary = element?.closest<HTMLElement>('[data-message-selection-content]')
  if (!boundary || !root.contains(boundary)) return null

  const messageId = boundary.dataset.messageId
  const role = boundary.dataset.messageRole
  if (!messageId || !isMessageSelectionRole(role)) return null
  return { messageId, role }
}

function isMessageSelectionRole(value: string | undefined): value is MessageSelectionRole {
  return value === 'user' || value === 'agent'
}
