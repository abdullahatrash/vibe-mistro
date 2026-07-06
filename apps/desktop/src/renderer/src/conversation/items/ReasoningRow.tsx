import { useEffect, useState, type JSX } from 'react'
import { Brain } from 'lucide-react'
import { Response } from '../Response'
import { useRowStreaming } from '../timeline-context'
import { FoldChevron, FoldableRow } from './foldable-row'
import type { ReasoningItem } from '../reducer'

export function ReasoningRow({ item, index }: { item: ReasoningItem; index: number }): JSX.Element {
  // Reasoning (#115): a foldable "thinking" block, auto-open while THIS Thread's
  // turn streams and collapsed once it settles (ADR-0010). Kept toggleable in
  // between — the effect only re-syncs `open` when `streaming` itself flips, so a
  // manual toggle mid-turn isn't fought. Body flows through the Response primitive.
  // Header-zone fold (#386): only the trigger line toggles — selecting body text
  // must never collapse the block.
  const streaming = useRowStreaming(index)
  const [open, setOpen] = useState(streaming)
  useEffect(() => setOpen(streaming), [streaming])
  return (
    <FoldableRow
      open={open}
      onOpenChange={setOpen}
      toggleZone="header"
      headerClassName="flex items-center gap-1.5 rounded-md px-0.5 py-0.5 text-[12px] text-muted outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10"
      header={
        <>
          <Brain className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium">Thinking</span>
          <FoldChevron open={open} />
        </>
      }
    >
      <Response
        className="mt-1 ms-2 border-s border-border ps-3 text-[13px] leading-relaxed text-muted"
        text={item.text}
      />
    </FoldableRow>
  )
}
