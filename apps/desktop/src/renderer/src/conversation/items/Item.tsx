import { memo, type JSX } from 'react'
import type { ConversationItem } from '../reducer'
import { AssistantRow, UserRow } from './message-rows'
import { ReasoningRow } from './ReasoningRow'
import { ToolRow } from './ToolRow'
import { PermissionRow } from './PermissionRow'
import { ErrorRow, FallbackRow, NoticeRow } from './status-rows'

/**
 * One transcript row: the per-kind dispatch plus the `data-item-id` jump anchor
 * (#174 slice 3). MEMOIZED on the item's object identity (#386): the reducer's
 * copy-on-write updates preserve every untouched item's reference across streamed
 * chunks, so a token appended to the newest assistant message re-renders exactly
 * that row — settled rows bail here. Cross-cutting inputs (permission handler,
 * command list, live-turn flags) ride the timeline contexts, NOT props, so their
 * churn can't defeat this memo; `index` is append-stable for a given item.
 */
export const Item = memo(function Item({
  item,
  index,
  selectable = false,
}: {
  item: ConversationItem
  /** The row's position — the live-turn `streaming` flag derives from it. */
  index: number
  /** Whether eligible Message content should expose a browser-selection boundary. */
  selectable?: boolean
}): JSX.Element {
  return (
    <div data-item-id={item.id} className="rounded-lg">
      {renderRow(item, index, selectable)}
    </div>
  )
})

function renderRow(item: ConversationItem, index: number, selectable: boolean): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} selectable={selectable} />
    case 'reasoning':
      return <ReasoningRow item={item} index={index} />
    case 'assistant':
      return <AssistantRow item={item} index={index} selectable={selectable} />
    case 'tool':
      return <ToolRow item={item} index={index} />
    case 'permission':
      return <PermissionRow item={item} />
    case 'error':
      return <ErrorRow item={item} />
    case 'fallback':
      return <FallbackRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
  }
}
