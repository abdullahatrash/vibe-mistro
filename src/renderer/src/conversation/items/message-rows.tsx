import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy, File, MousePointerClick, RotateCcw, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react'
import { IconButton } from '../../ui/icon-button'
import { Response } from '../Response'
import { matchInvokedCommand } from '../command-autocomplete'
import { extractPromptContexts } from '../pending-contexts'
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
  const { cleanText, files, elements } = extractPromptContexts(item.text)
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
      {(command || files.length > 0 || elements.length > 0) && (
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
        </div>
      )}
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
      {/* Actions bar (#116): a hover-reveal row under the answer. Copy is the only
          FUNCTIONAL action (clipboard + anchored toast); thumbs up/down + retry are
          designed affordances from the mockup — present + styled but not yet wired to
          any backend (no feedback store, no re-submit) so we don't invent behavior.
          Hidden while the answer streams (a half-written reply isn't copyable) and for
          an empty item. `focus-within` also reveals it for keyboard users. */}
      {!streaming && item.text.trim().length > 0 && (
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <MessageCopyButton text={item.text} />
          <IconButton size="icon-xs" className="text-muted hover:text-text" aria-label="Good response" title="Good response">
            <ThumbsUp className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton size="icon-xs" className="text-muted hover:text-text" aria-label="Bad response" title="Bad response">
            <ThumbsDown className="size-3.5" aria-hidden />
          </IconButton>
          <IconButton size="icon-xs" className="text-muted hover:text-text" aria-label="Retry" title="Retry">
            <RotateCcw className="size-3.5" aria-hidden />
          </IconButton>
        </div>
      )}
    </div>
  )
}

/**
 * The copy control on the assistant actions bar (#116, mirrors t3code `MessageCopyButton`).
 * Writes the answer to the clipboard, flips the icon to a check, and floats an ANCHORED
 * "Copied!" toast above the button (a popover positioned on the button, NOT an inline
 * label) that clears after a beat. Self-contained: no toast manager, just local state +
 * a positioned span. The timer is cleared on unmount so a fast switch-away can't set
 * state on a dead component.
 */
function MessageCopyButton({ text }: { text: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timeoutRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  useEffect(
    () => () => {
      mountedRef.current = false
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    },
    [],
  )
  function onCopy(): void {
    void navigator.clipboard.writeText(text).then(() => {
      // The clipboard write is async — bail if we unmounted between click and resolve.
      if (!mountedRef.current) return
      setCopied(true)
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <span className="relative inline-flex">
      <IconButton
        size="icon-xs"
        className="text-muted hover:text-text"
        aria-label="Copy message"
        title="Copy"
        onClick={onCopy}
      >
        {copied ? (
          <Check className="size-3.5 text-accent-text" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </IconButton>
      {copied && (
        <span
          role="status"
          className="pointer-events-none absolute bottom-full left-1/2 mb-1 -translate-x-1/2 rounded-sm bg-text px-2 py-1 text-xs whitespace-nowrap text-bg shadow-md"
        >
          Copied!
        </span>
      )}
    </span>
  )
}
