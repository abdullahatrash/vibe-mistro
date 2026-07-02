import type { JSX } from 'react'
import type { AcpCommand, ConversationItem, PermissionItem, PermissionOption } from '../reducer'
import { AssistantRow, UserRow } from './message-rows'
import { ReasoningRow } from './ReasoningRow'
import { ToolRow } from './ToolRow'
import { PermissionRow } from './PermissionRow'
import { ErrorRow, FallbackRow, NoticeRow } from './status-rows'

export function Item({
  item,
  streaming,
  onPermission,
  availableCommands,
}: {
  item: ConversationItem
  /** True while this Thread's turn is in flight (#115) — drives reasoning auto-open. */
  streaming: boolean
  onPermission: (item: PermissionItem, option: PermissionOption) => void
  /** The session's slash commands/skills — user rows chip a leading `/name` match. */
  availableCommands?: readonly AcpCommand[]
}): JSX.Element {
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} availableCommands={availableCommands} />
    case 'reasoning':
      return <ReasoningRow item={item} streaming={streaming} />
    case 'assistant':
      return <AssistantRow item={item} streaming={streaming} />
    case 'tool':
      return <ToolRow item={item} streaming={streaming} />
    case 'permission':
      return <PermissionRow item={item} onPermission={onPermission} />
    case 'error':
      return <ErrorRow item={item} />
    case 'fallback':
      return <FallbackRow item={item} />
    case 'notice':
      return <NoticeRow item={item} />
  }
}
