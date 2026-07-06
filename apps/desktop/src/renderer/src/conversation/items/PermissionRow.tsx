import type { JSX } from 'react'
import { Check, ShieldAlert } from 'lucide-react'
import { Button } from '../../ui/button'
import { isRejectOption } from '../permission-option'
import { useTimelineHandlers } from '../timeline-context'
import type { PermissionItem } from '../reducer'

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
    <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] p-3">
      <div className="flex items-center gap-1.5 text-[13px] font-semibold text-accent-text">
        <ShieldAlert className="size-4 shrink-0" aria-hidden />
        <span>Permission request{item.toolCallId ? ` · ${item.toolCallId}` : ''}</span>
      </div>
      {item.chosenName ? (
        <div className="flex items-center gap-1.5 text-[13px] text-muted">
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
