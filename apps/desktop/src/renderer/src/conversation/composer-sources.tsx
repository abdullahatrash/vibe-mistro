import { File, Folder } from 'lucide-react'
import type { FileEntry } from '../../../shared/ipc'
import type { AcpCommand } from './reducer'
import { filterCommands, getCommandQuery, removeCommandToken } from './command-autocomplete'
import { applyPath, filterPaths, getPathQuery, removePathToken } from './path-autocomplete'
import type { CompletionSource } from './use-composer-autocomplete'
import { createSlashCommandInlineToken } from './composer-inline-tokens'

/**
 * The two concrete completion sources (quality-review slice 4a): thin configs over the pure
 * cores (command-autocomplete.ts / path-autocomplete.ts). Each is a `CompletionSource` that
 * `useComposerAutocomplete` drives — the `/` command source ranks the Vibe-streamed
 * `availableCommands`, the `@` path source ranks the cached `files:list` listing. They close
 * over the live data, so the composer rebuilds them when that data changes.
 */

/**
 * The `/` slash-command source (#95/#309): prompt-start anchored, always closes on accept.
 * Accepting stages the command as the single structured Inline token; the typed trigger
 * text is removed from the prompt body and the command is serialized back at send.
 */
export function createCommandSource(commands: readonly AcpCommand[]): CompletionSource<AcpCommand> {
  return {
    id: 'command',
    label: 'Slash commands',
    rowClassName: 'flex cursor-pointer items-baseline gap-2.5 rounded-lg px-2 py-1.5',
    detect(value, caret) {
      const trigger = getCommandQuery(value, caret)
      return trigger.active ? { start: trigger.start, query: trigger.query } : null
    },
    rows(query) {
      return filterCommands(commands as AcpCommand[], query)
    },
    rowKey: (command) => command.name,
    apply: (value, start, caret, command) => ({
      ...removeCommandToken(value, start, caret),
      inlineToken: createSlashCommandInlineToken(command),
    }),
    closeOnAccept: () => true,
    renderRow: (command) => (
      <>
        <span className="text-[13px] font-semibold whitespace-nowrap text-accent-text">
          /{command.name}
        </span>
        {command.description && (
          <span className="truncate text-xs text-muted">{command.description}</span>
        )}
      </>
    ),
  }
}

/**
 * The `@` file-path source (#190): mid-sentence. Accepting a FILE stages it as a
 * pending-context CHIP (#230) — token removed, chip rides back through `apply`'s
 * `context`, the `@path` mention re-serialized at send. Accepting a DIRECTORY keeps
 * today's in-text drill-down (trailing slash re-derives the trigger into it). `onOpen`
 * kicks the lazy `files:list` fetch on first trigger. Rows show a dir/file icon + path.
 */
export function createPathSource({
  entries,
  onFirstOpen,
}: {
  entries: readonly FileEntry[]
  onFirstOpen: () => void
}): CompletionSource<FileEntry> {
  return {
    id: 'path',
    label: 'File paths',
    rowClassName: 'flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5',
    detect(value, caret) {
      const trigger = getPathQuery(value, caret)
      return trigger.active ? { start: trigger.start, query: trigger.query } : null
    },
    rows(query) {
      return filterPaths(entries, query)
    },
    rowKey: (entry) => entry.path,
    apply: (value, start, caret, entry) =>
      entry.kind === 'directory'
        ? applyPath(value, start, caret, entry)
        : { ...removePathToken(value, start, caret), context: { kind: 'file', path: entry.path } },
    closeOnAccept: (entry) => entry.kind !== 'directory',
    onOpen: onFirstOpen,
    renderRow: (entry) => (
      <>
        {entry.kind === 'directory' ? (
          <Folder className="size-3.5 shrink-0 text-muted" aria-hidden />
        ) : (
          <File className="size-3.5 shrink-0 text-muted" aria-hidden />
        )}
        <span className="truncate text-[13px] text-text-body">
          {entry.path}
          {entry.kind === 'directory' && '/'}
        </span>
      </>
    ),
  }
}
