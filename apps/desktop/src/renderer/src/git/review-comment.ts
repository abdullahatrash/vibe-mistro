/**
 * The excerpt locator (#239, PRD #233): map a diff selection back to the patch's own
 * lines. Two entry points share ONE `parseBodyLines` core so both stage byte-identical
 * comments (#388): `locateExcerptInPatch` maps a NATIVE text selection (normalizing the
 * gutter numbers and blank rows the DOM picks up), and `locateRangeInPatch` maps the
 * `@pierre/diffs` viewer's structured `SelectedLineRange` (additions/deletions side +
 * line number) once the Review surface renders through the virtualized `CodeView`.
 * Either way the result carries the VERBATIM +/-/space excerpt (what the agent sees)
 * and the new-file line range (deleted lines anchor to where their deletion applied).
 * Pure, DOM-free.
 */

export interface LocatedExcerpt {
  /** The matched patch lines verbatim, +/-/space prefixes intact. */
  excerpt: string
  startLine: number
  endLine: number
}

/**
 * A viewer line selection — the structural subset of `@pierre/diffs`' `SelectedLineRange`
 * this module needs. `start`/`end` are line numbers on their `side` (additions = new-file,
 * deletions = old-file); `side` defaults to additions (context + added lines).
 */
export interface PatchLineRange {
  start: number
  side?: 'additions' | 'deletions'
  end: number
  endSide?: 'additions' | 'deletions'
}

interface BodyLine {
  raw: string
  content: string
  /** New-file line number ('+' and context lines), null for deletions. */
  newLine: number | null
  /** Old-file line number ('-' and context lines), null for additions. */
  oldLine: number | null
  /** The new-file position this line anchors to — for a deletion, where it applied. */
  anchor: number
  hunk: number
}

/** Parse the patch's hunk bodies into content-addressable lines with old/new numbers. */
function parseBodyLines(patch: string): BodyLine[] {
  const body: BodyLine[] = []
  let newCounter = 0
  let oldCounter = 0
  let hunk = -1
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      oldCounter = Number(header[1])
      newCounter = Number(header[2])
      hunk++
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      body.push({ raw, content: raw.slice(1).trim(), newLine: newCounter, oldLine: null, anchor: newCounter, hunk })
      newCounter++
    } else if (raw.startsWith('-')) {
      body.push({ raw, content: raw.slice(1).trim(), newLine: null, oldLine: oldCounter, anchor: newCounter, hunk })
      oldCounter++
    } else if (raw.startsWith(' ')) {
      body.push({ raw, content: raw.slice(1).trim(), newLine: newCounter, oldLine: oldCounter, anchor: newCounter, hunk })
      newCounter++
      oldCounter++
    }
    // Anything else (`\ No newline at end of file`, a stray header) is skipped.
  }
  return body
}

/** Build the `{excerpt, startLine, endLine}` result for a contiguous body-line run. */
function excerptFromRun(run: BodyLine[]): LocatedExcerpt {
  return {
    excerpt: run.map((l) => l.raw).join('\n'),
    startLine: run[0].newLine ?? run[0].anchor,
    endLine: run[run.length - 1].newLine ?? run[run.length - 1].anchor,
  }
}

/** Find a body line by its viewer coordinate, mirroring the library's side fallback. */
function findBodyIndex(body: BodyLine[], lineNumber: number, side: 'additions' | 'deletions' | undefined): number {
  const preferred: keyof Pick<BodyLine, 'oldLine' | 'newLine'> = side === 'deletions' ? 'oldLine' : 'newLine'
  const primary = body.findIndex((line) => line[preferred] === lineNumber)
  if (primary >= 0) return primary
  const fallback = preferred === 'oldLine' ? 'newLine' : 'oldLine'
  return body.findIndex((line) => line[fallback] === lineNumber)
}

/**
 * Map the viewer's structured `SelectedLineRange` to the patch excerpt (#388). The range
 * endpoints resolve to body-line indices (additions→new number, deletions→old number,
 * with a side fallback); the inclusive run between them yields the SAME verbatim excerpt
 * and new-file range the native-selection path produces, so staged comments are byte-
 * identical on the wire. Returns null when an endpoint can't be located.
 */
export function locateRangeInPatch(patch: string, range: PatchLineRange): LocatedExcerpt | null {
  const body = parseBodyLines(patch)
  if (body.length === 0) return null
  const startIndex = findBodyIndex(body, range.start, range.side)
  const endIndex = findBodyIndex(body, range.end, range.endSide ?? range.side)
  if (startIndex < 0 || endIndex < 0) return null
  const lo = Math.min(startIndex, endIndex)
  const hi = Math.max(startIndex, endIndex)
  return excerptFromRun(body.slice(lo, hi + 1))
}

export function locateExcerptInPatch(patch: string, selectedText: string): LocatedExcerpt | null {
  // Normalize the selection: trim lines, drop blanks and pure-number gutter artifacts.
  const wanted = selectedText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\d+$/.test(line))
  if (wanted.length === 0) return null

  const body = parseBodyLines(patch)
  for (let i = 0; i + wanted.length <= body.length; i++) {
    let matched = true
    for (let j = 0; j < wanted.length; j++) {
      // Contiguous in the SAME hunk — a selection can't meaningfully span the gap
      // between hunks (the rendered views separate them).
      if (body[i + j].content !== wanted[j] || body[i + j].hunk !== body[i].hunk) {
        matched = false
        break
      }
    }
    if (!matched) continue
    return excerptFromRun(body.slice(i, i + wanted.length))
  }
  return null
}
