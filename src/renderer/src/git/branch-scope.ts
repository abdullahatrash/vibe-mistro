import type { GitBranch } from '../../../shared/ipc'

/**
 * Pure seams for the Branch-changes scope's base-ref picker (#237, PRD #233). The
 * picker offers the #87 branches list minus the CURRENT branch (a branch diffed
 * against itself is empty), ordered default-first (the overwhelmingly common base),
 * then locals, then remotes — with a simple case-insensitive substring filter
 * (client-side: the list is already fetched and deduped by the branches read).
 */

export function buildBaseRefChoices(branches: readonly GitBranch[], currentBranch: string | null): GitBranch[] {
  const rank = (b: GitBranch): number => (b.isDefault ? 0 : b.isRemote ? 2 : 1)
  return branches
    .filter((b) => b.name !== currentBranch)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function filterRefChoices(choices: readonly GitBranch[], query: string): GitBranch[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...choices]
  return choices.filter((b) => b.name.toLowerCase().includes(q))
}
