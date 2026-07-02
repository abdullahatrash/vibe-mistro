import { useEffect, useState, type JSX } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../../ui/collapsible'
import { cn } from '../../lib/utils'
import { Response } from '../Response'
import type { ReasoningItem } from '../reducer'

export function ReasoningRow({ item, streaming }: { item: ReasoningItem; streaming: boolean }): JSX.Element {
  // Reasoning (#115): a Collapsible "thinking" block, auto-open while THIS Thread's
  // turn streams and collapsed once it settles (ADR-0010). Kept toggleable in
  // between — the effect only re-syncs `open` when `streaming` itself flips, so a
  // manual toggle mid-turn isn't fought. Body flows through the Response primitive.
  const [open, setOpen] = useState(streaming)
  useEffect(() => setOpen(streaming), [streaming])
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md px-0.5 py-0.5 text-[12px] text-muted outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10">
        <Brain className="size-3.5 shrink-0" aria-hidden />
        <span className="font-medium">Thinking</span>
        <ChevronDown
          className={cn('size-3.5 shrink-0 opacity-70 transition-transform duration-200', open && 'rotate-180')}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Response
          className="mt-1 ms-2 border-s border-border ps-3 text-[13px] leading-relaxed text-muted"
          text={item.text}
        />
      </CollapsibleContent>
    </Collapsible>
  )
}
