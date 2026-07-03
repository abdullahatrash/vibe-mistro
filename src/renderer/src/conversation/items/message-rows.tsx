import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Clipboard, Copy, File, MessageSquareText, MousePointerClick, Sparkles } from 'lucide-react'
import { IconButton } from '../../ui/icon-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../ui/tooltip'
import { Response } from '../Response'
import { matchInvokedCommand } from '../command-autocomplete'
import { extractPromptContexts, pastedLabel } from '../pending-contexts'
import type { AcpCommand, AssistantItem, UserItem } from '../reducer'

export function UserRow({
  item,
  availableCommands,
}: {
  item: UserItem
  /** The session's slash commands/skills — a leading `/name` match renders a chip. */
  availableCommands?: readonly AcpCommand[]
}): JSX.Element {
  // Context extraction (#230/#231): a prompt sent with pending chips carries trailing
  // `<attached_files>` / `<element_context>` marker blocks; strip them back into chips at
  // RENDER time so the bubble shows the clean prose — live and on JSONL replay, which
  // ride the same text. User-typed inline `@path` mentions pass through untouched.
  const { cleanText, files, elements, reviews, pasted } = extractPromptContexts(item.text)
  // Skill/command chip: vibe-acp invokes a skill when the prompt opens with a
  // known `/name`, but gives NO wire-level acknowledgment — so we surface the
  // match ourselves. Matched at RENDER time against the CURRENT list (not stamped
  // at send): a draft's first prompt is sent before `available_commands_update`
  // streams, so the chip appears retroactively once the list arrives.
  const command = matchInvokedCommand(cleanText, availableCommands ?? [])
  // User turn (#114): a right-aligned rounded bubble, capped so long prose wraps
  // instead of spanning the pane. Echoed attachments (#100) re-home into the bubble.
  return (
    <div className="flex flex-col items-end gap-1.5">
      {(command || files.length > 0 || elements.length > 0 || reviews.length > 0 || pasted.length > 0) && (
        <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
          {command && (
            <span
              data-command-chip
              title={command.description}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-xs leading-none text-accent-text"
            >
              <Sparkles className="size-3 shrink-0" aria-hidden />/{command.name}
            </span>
          )}
          {files.map((file) => (
            <span
              key={file.path}
              data-file-chip
              title={file.path}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-xs leading-none text-accent-text"
            >
              <File className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{file.path}</span>
            </span>
          ))}
          {elements.map((element) => (
            <span
              key={element.id}
              data-element-chip
              title={[`<${element.tagName}>`, element.selector ?? '', element.text, element.pageUrl]
                .filter((line) => line.length > 0)
                .join('\n')}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-xs leading-none text-accent-text"
            >
              <MousePointerClick className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{element.selector ?? `<${element.tagName}>`}</span>
            </span>
          ))}
          {reviews.map((review) => (
            // Review-comment chips (#239): the sent-turn mirror of the composer's
            // staged comments — path + line range, note + excerpt in the tooltip.
            <span
              key={review.id}
              data-review-chip
              title={[review.note, '', review.excerpt].join('\n')}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-xs leading-none text-accent-text"
            >
              <MessageSquareText className="size-3 shrink-0" aria-hidden />
              <span className="truncate">
                {review.filePath}
                {review.startLine !== null && review.endLine !== null
                  ? review.startLine === review.endLine
                    ? `:${review.startLine}`
                    : `:${review.startLine}-${review.endLine}`
                  : ''}
              </span>
            </span>
          ))}
          {pasted.map((paste) => (
            // Pasted-text chips: the sent-turn mirror of the composer's compressed long
            // pastes — the bracketed placeholder, full text (capped) in the tooltip.
            <span
              key={paste.id}
              data-pasted-chip
              title={paste.text.length > 400 ? `${paste.text.slice(0, 400)}…` : paste.text}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-xs leading-none text-accent-text"
            >
              <Clipboard className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{pastedLabel(paste)}</span>
            </span>
          ))}
        </div>
      )}
      {/* Chip-only prompts (e.g. a bare long paste) skip the bubble — an empty pill reads broken. */}
      {(cleanText.length > 0 || (item.images && item.images.length > 0)) && (
        <div className="max-w-[80%] rounded-2xl border border-border bg-surface px-3.5 py-2.5 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-text-body">
          {item.images && item.images.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  className="max-h-[200px] max-w-[200px] rounded-lg border border-border"
                  src={img.previewUrl}
                  alt="attachment"
                />
              ))}
            </div>
          )}
          {cleanText}
        </div>
      )}
    </div>
  )
}

export function AssistantRow({ item, streaming }: { item: AssistantItem; streaming: boolean }): JSX.Element {
  // Assistant turn (#114): no bubble — full-width flowing markdown via the Response
  // primitive (streamdown), so tables/code/lists get room to breathe. Wrapped in a
  // `group` so the #116 actions bar reveals on hover of the whole answer.
  return (
    <div className="group flex flex-col gap-1.5">
      <Response className="text-[15px] leading-relaxed text-text-body" text={item.text} />
      {/* Actions bar (#116): a hover-reveal row under the answer, holding the Copy
          control (clipboard + anchored toast). Hidden while the answer streams (a
          half-written reply isn't copyable) and for an empty item. `focus-within`
          also reveals it for keyboard users. */}
      {!streaming && item.text.trim().length > 0 && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <MessageCopyButton text={item.text} />
        </div>
      )}
    </div>
  )
}

/** How long the click feedback ("Copied!" / "Failed to copy") stays up — t3code's 1s. */
const COPY_FEEDBACK_MS = 1000

/**
 * The copy control on the assistant actions bar (#116, mirrors t3code `MessageCopyButton`):
 * a hover tooltip ("Copy to clipboard"), and on click an ANCHORED tooltip-style label —
 * "Copied!" with the icon flipped to a check (button disabled for the beat), or
 * "Failed to copy" when the clipboard write rejects (never silent). The hover tooltip
 * yields while the click feedback shows so the two chips don't stack. Self-contained:
 * no toast manager, just local state + a positioned span; the timer is cleared on
 * unmount so a fast switch-away can't set state on a dead component.
 */
function MessageCopyButton({ text }: { text: string }): JSX.Element {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  const timeoutRef = useRef<number | null>(null)
  // Set true in SETUP, not just the initializer — StrictMode's dev-only
  // mount→cleanup→remount rehearsal otherwise leaves this false forever and every
  // click silently bails (no feedback in dev, fine in prod — the worst kind of bug).
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    }
  }, [])
  function showFeedback(next: 'copied' | 'failed'): void {
    // The clipboard write is async — bail if we unmounted between click and settle.
    if (!mountedRef.current) return
    setFeedback(next)
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => setFeedback(null), COPY_FEEDBACK_MS)
  }
  function onCopy(): void {
    navigator.clipboard.writeText(text).then(
      () => showFeedback('copied'),
      () => showFeedback('failed'),
    )
  }
  return (
    <span className="relative inline-flex">
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <IconButton
                size="icon-xs"
                className="text-muted hover:text-text"
                aria-label="Copy message"
                disabled={feedback === 'copied'}
                onClick={onCopy}
              />
            }
          >
            {feedback === 'copied' ? (
              <Check className="size-3.5 text-accent-text" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
          </TooltipTrigger>
          {feedback === null && <TooltipContent>Copy to clipboard</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
      {feedback && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 rounded-sm bg-text px-2 py-1 text-xs whitespace-nowrap text-bg shadow-md"
        >
          {feedback === 'copied' ? 'Copied!' : 'Failed to copy'}
        </span>
      )}
    </span>
  )
}
