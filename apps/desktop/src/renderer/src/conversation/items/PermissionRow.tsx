import type { JSX } from 'react'
import { Check, ShieldAlert } from 'lucide-react'
import { Button } from '../../ui/button'
import { isRejectOption } from '../permission-option'
import { useTimelineHandlers } from '../timeline-context'
import type { PermissionItem } from '../reducer'

/**
 * The " · …" suffix naming where a request came from.
 *
 * An ORPHAN request — one whose `toolCallId` matches no tool call in the
 * conversation — is the signature of a Subagent asking: those ids belong to a
 * child session the client never sees (docs/acp-capture.md §15 finding F). Say
 * so in words rather than printing an id that means nothing to the user.
 *
 * We deliberately do NOT name WHICH subagent. No child identifier reaches the
 * client on a permission callback, and during a parallel fan-out the request
 * corresponds to neither visible row — so naming one would be a guess.
 */
function permissionSource(item: PermissionItem): string {
  if (item.orphan) return ' · from a Subagent'
  return item.toolCallId ? ` · ${item.toolCallId}` : ''
}

export function PermissionRow({ item }: { item: PermissionItem }): JSX.Element {
  // The answer relay (context, #386) — identity-stable so the memoized Item bails.
  const { onPermission } = useTimelineHandlers()
  // Permission request (#116): kept INLINE in the transcript (not the composer footer),
  // restyled onto the Button primitive over the accent-tint card. Allow actions read as
  // the primary (default) Button; reject actions (kind starts with `reject`) as an
  // outline — the same classification `recover()` uses to auto-deny a wedged turn. The
  // settled "You chose: …" state is unchanged; the wiring (`onPermission`, `item.options`,
  // `chosenName`) is behaviour-identical to the retired BEM version.
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-primary/30 bg-primary/10 p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-primary">
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        <span>Permission request{permissionSource(item)}</span>
      </div>
      {item.chosenName ? (
        <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <Check className="size-3.5 shrink-0" aria-hidden />
          <span>You chose: {item.chosenName}</span>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {item.options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={isRejectOption(option) ? 'outline' : 'default'}
              onClick={() => onPermission(item, option)}
            >
              {option.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
