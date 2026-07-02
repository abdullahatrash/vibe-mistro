/**
 * Shared `git status --porcelain=2` line grammar (#84/#86). The changed-entry shapes
 * (verified against real git — see status.test.ts):
 *  - `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` — ordinary changed entry (8 fields).
 *  - `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<orig>` — rename/copy (9).
 * `parseGitStatus` (status.ts) and `collectRenameOrigins` (commit.ts) both consume it;
 * this module is the single home for the field-splitting so the two can't drift.
 */

/** Split off the first `n` space-delimited fields, keeping the remainder (the path) intact. */
export function splitLeading(line: string, n: number): { fields: string[]; rest: string } {
  const fields: string[] = []
  let i = 0
  for (let f = 0; f < n; f++) {
    const sp = line.indexOf(' ', i)
    if (sp < 0) {
      fields.push(line.slice(i))
      return { fields, rest: '' }
    }
    fields.push(line.slice(i, sp))
    i = sp + 1
  }
  return { fields, rest: line.slice(i) }
}

/**
 * Both halves of a `2` (rename/copy) entry's `<new>\t<orig>` path pair, or null when
 * the line isn't a well-formed rename entry.
 */
export function renamePaths(line: string): { newPath: string; orig: string } | null {
  const { fields, rest } = splitLeading(line, 9)
  if (fields.length < 9) return null
  const tab = rest.indexOf('\t')
  if (tab < 0) return null
  const newPath = rest.slice(0, tab)
  const orig = rest.slice(tab + 1)
  return newPath && orig ? { newPath, orig } : null
}
