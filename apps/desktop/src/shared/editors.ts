/**
 * The curated external-editor table for Open in IDE (#252, epic #178), ported from
 * t3code's contract shape: ONE static list drives detection (main probes each
 * `commands` alias on the shell-env PATH), launch-arg building (`launchStyle`),
 * and the renderer's labels — the renderer never re-declares ids or labels.
 * Node/DOM-free (like `shared/ipc`) so both tsconfig projects can consume it.
 */

/**
 * How an editor's CLI takes a file target with a position (t3code): `goto` is the
 * VS Code family's `--goto path:line:col`; `line-column` is the JetBrains launchers'
 * `--line N [--column M] path`; `direct-path` editors (Zed, the file manager) take
 * the bare path. Slice 1 (#252) only ever passes a bare directory — the mapping is
 * exercised by the open-file-at-line slice (#254) — but it ships (and is tested) here
 * so the table is complete from the start.
 */
export type EditorLaunchStyle = 'direct-path' | 'goto' | 'line-column'

export interface EditorDefinition {
  readonly id: string
  readonly label: string
  /**
   * CLI aliases probed IN ORDER on the shell-env PATH (e.g. Zed installs `zed` or
   * `zeditor` depending on channel). `null` marks the platform file manager, whose
   * command is per-platform (`open` / `explorer` / `xdg-open`), not a fixed alias.
   */
  readonly commands: readonly string[] | null
  /** Args prepended before the target (e.g. a subcommand), rarely needed. */
  readonly baseArgs?: readonly string[]
  readonly launchStyle: EditorLaunchStyle
}

/**
 * Table order is PREFERENCE order: detection reports available editors in this
 * order, and slice 1's header button opens the first available one (slice 2's
 * stored preference falls back to the same order).
 */
export const EDITORS = [
  { id: 'cursor', label: 'Cursor', commands: ['cursor'], launchStyle: 'goto' },
  { id: 'vscode', label: 'VS Code', commands: ['code'], launchStyle: 'goto' },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    commands: ['code-insiders'],
    launchStyle: 'goto',
  },
  { id: 'vscodium', label: 'VSCodium', commands: ['codium'], launchStyle: 'goto' },
  { id: 'windsurf', label: 'Windsurf', commands: ['windsurf'], launchStyle: 'goto' },
  { id: 'zed', label: 'Zed', commands: ['zed', 'zeditor'], launchStyle: 'direct-path' },
  { id: 'antigravity', label: 'Antigravity', commands: ['agy'], launchStyle: 'goto' },
  { id: 'idea', label: 'IntelliJ IDEA', commands: ['idea'], launchStyle: 'line-column' },
  { id: 'pycharm', label: 'PyCharm', commands: ['pycharm'], launchStyle: 'line-column' },
  { id: 'webstorm', label: 'WebStorm', commands: ['webstorm'], launchStyle: 'line-column' },
  { id: 'phpstorm', label: 'PhpStorm', commands: ['phpstorm'], launchStyle: 'line-column' },
  { id: 'goland', label: 'GoLand', commands: ['goland'], launchStyle: 'line-column' },
  { id: 'clion', label: 'CLion', commands: ['clion'], launchStyle: 'line-column' },
  { id: 'rider', label: 'Rider', commands: ['rider'], launchStyle: 'line-column' },
  { id: 'rubymine', label: 'RubyMine', commands: ['rubymine'], launchStyle: 'line-column' },
  { id: 'rustrover', label: 'RustRover', commands: ['rustrover'], launchStyle: 'line-column' },
  { id: 'datagrip', label: 'DataGrip', commands: ['datagrip'], launchStyle: 'line-column' },
  { id: 'file-manager', label: 'File Manager', commands: null, launchStyle: 'direct-path' },
] as const satisfies ReadonlyArray<EditorDefinition>

/** The closed id union the IPC contract speaks — literal ids extracted from the table. */
export type EditorId = (typeof EDITORS)[number]['id']

export function findEditor(id: string): (typeof EDITORS)[number] | null {
  return EDITORS.find((editor) => editor.id === id) ?? null
}

/** A `path:line[:col]` target split for per-`launchStyle` arg building. */
export interface TargetPosition {
  path: string
  line: string
  column: string | null
}

const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/

/**
 * Split a `path:line[:col]` target. A bare path (no trailing `:digits`) returns
 * null — including Windows drive prefixes (`C:\x` — the segment after the first
 * `:` isn't digits) and paths whose colon-suffix isn't a position.
 */
export function parseTargetPosition(target: string): TargetPosition | null {
  const match = TARGET_WITH_POSITION_PATTERN.exec(target)
  if (!match?.[1] || !match[2]) return null
  return { path: match[1], line: match[2], column: match[3] ?? null }
}

/**
 * Build the CLI args (after the command) that open `target` in `editor`, per its
 * `launchStyle`. `target` may carry a `:line[:col]` suffix; a bare path passes
 * through untouched for every style. Not meaningful for the file-manager entry
 * (`commands: null`) — its launch is the platform opener with the bare path.
 */
export function resolveEditorArgs(editor: EditorDefinition, target: string): string[] {
  const position = parseTargetPosition(target)
  const base = editor.baseArgs ? [...editor.baseArgs] : []
  switch (editor.launchStyle) {
    case 'direct-path':
      return [...base, position?.path ?? target]
    case 'goto':
      return position ? [...base, '--goto', target] : [...base, target]
    case 'line-column':
      return position
        ? [
            ...base,
            '--line',
            position.line,
            ...(position.column ? ['--column', position.column] : []),
            position.path,
          ]
        : [...base, target]
  }
}

/** The platform opener backing the `file-manager` entry (t3code's mapping). */
export function fileManagerCommandForPlatform(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'open'
    case 'win32':
      return 'explorer'
    default:
      return 'xdg-open'
  }
}
