/**
 * The excerpt locator (#239, PRD #233): map the user's NATIVE text selection over a
 * rendered diff back to the patch's own lines. The renderer can't ask `@pierre/diffs`
 * which lines were selected, but it HAS the raw patch — so we normalize the selected
 * text (dropping gutter line numbers and blank rows the DOM selection picks up) and
 * find the matching contiguous run of patch body lines. The result carries the
 * VERBATIM +/-/space excerpt (what the agent sees) and the new-file line range
 * (deleted lines anchor to the position their deletion applies to). Pure, DOM-free.
 */

export interface LocatedExcerpt {
  /** The matched patch lines verbatim, +/-/space prefixes intact. */
  excerpt: string
  startLine: number
  endLine: number
}

interface BodyLine {
  raw: string
  content: string
  /** New-file line number ('+' and context lines), null for deletions. */
  newLine: number | null
  /** The new-file position this line anchors to — for a deletion, where it applied. */
  anchor: number
  hunk: number
}

/** Parse the patch's hunk bodies into content-addressable lines with new-file numbers. */
function parseBodyLines(patch: string): BodyLine[] {
  const body: BodyLine[] = []
  let newCounter = 0
  let hunk = -1
  let inHunk = false
  for (const raw of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (header) {
      newCounter = Number(header[1])
      hunk++
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      body.push({ raw, content: raw.slice(1).trim(), newLine: newCounter, anchor: newCounter, hunk })
      newCounter++
    } else if (raw.startsWith('-')) {
      body.push({ raw, content: raw.slice(1).trim(), newLine: null, anchor: newCounter, hunk })
    } else if (raw.startsWith(' ')) {
      body.push({ raw, content: raw.slice(1).trim(), newLine: newCounter, anchor: newCounter, hunk })
      newCounter++
    }
    // Anything else (`\ No newline at end of file`, a stray header) is skipped.
  }
  return body
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
    const run = body.slice(i, i + wanted.length)
    return {
      excerpt: run.map((l) => l.raw).join('\n'),
      startLine: run[0].newLine ?? run[0].anchor,
      endLine: run[run.length - 1].newLine ?? run[run.length - 1].anchor,
    }
  }
  return null
}
