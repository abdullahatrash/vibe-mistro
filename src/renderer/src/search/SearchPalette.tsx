import { useEffect, useRef, useState, type JSX } from 'react'
import { MessageSquare } from 'lucide-react'
import type { SearchHit } from '../../../shared/ipc'
import { formatRelativeTime } from '../shell/relative-time'
import { Badge } from '../ui/badge'
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandInput,
  CommandList,
  CommandItem,
} from '../ui/command'

/** Debounce for non-empty queries; the resting (empty) query fires immediately. */
const QUERY_DEBOUNCE_MS = 120

/**
 * The Search palette (#174, CONTEXT.md "Search palette"): the ⌘K / sidebar-Search
 * modal for finding past conversations. UI-only — matching and ranking live in
 * main behind `search:query`; this component debounces keystrokes, drops stale
 * replies (invoke can't cancel, so a sequence stamp keeps a slow older response
 * from clobbering a newer one), and renders ranked Thread rows. An empty query
 * shows the resting recents, so the palette doubles as a quick Thread switcher.
 * Selecting a row closes the palette and opens the Thread via App's existing
 * cross-Workspace select (cold auto-continue included).
 */
export function SearchPalette({
  open,
  onOpenChange,
  onSelectThread,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelectThread: (workspaceId: string, threadId: string) => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  // Monotonic stamp for stale-drop: only the LATEST issued query may apply.
  const seq = useRef(0)

  // Clear on close so a reopen starts at the resting recents, not a stale query.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    if (!open) return
    const stamp = ++seq.current
    const run = (): void => {
      void window.api.searchQuery({ query }).then((results) => {
        if (seq.current === stamp) setHits(results)
      })
    }
    if (query.trim() === '') {
      run() // resting state: no debounce, the palette fills the instant it opens
      return
    }
    const timer = setTimeout(run, QUERY_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [open, query])

  function selectHit(hit: SearchHit): void {
    onOpenChange(false)
    onSelectThread(hit.workspaceId, hit.threadId)
  }

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup>
        <Command
          aria-label="Search threads"
          items={hits}
          itemToStringValue={(hit: SearchHit) => hit.title ?? 'Untitled'}
          value={query}
          onValueChange={setQuery}
        >
          <CommandInput placeholder="Search threads…" />
          <CommandList>
            <CommandEmpty>
              {query.trim() === '' ? 'No threads yet.' : 'No matching threads.'}
            </CommandEmpty>
            <CommandCollection>
              {(hit: SearchHit) => (
                <CommandItem
                  key={hit.threadId}
                  value={hit}
                  // Keep focus in the input (t3code pattern): select on click only.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectHit(hit)}
                >
                  <MessageSquare className="size-4 shrink-0 text-muted" aria-hidden />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-text-strong">{hit.title ?? 'Untitled'}</span>
                      {hit.archived && (
                        <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">
                          Archived
                        </Badge>
                      )}
                    </span>
                    <span className="truncate text-[11px] text-faint">{hit.workspaceName}</span>
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-faint">
                    {formatRelativeTime(hit.lastActiveAt, Date.now())}
                  </span>
                </CommandItem>
              )}
            </CommandCollection>
          </CommandList>
          <CommandFooter>
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
            <span>Esc Close</span>
          </CommandFooter>
        </Command>
      </CommandDialogPopup>
    </CommandDialog>
  )
}
