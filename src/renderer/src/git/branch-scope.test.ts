import { describe, it, expect } from 'vitest'
import { buildBaseRefChoices, filterRefChoices } from './branch-scope'
import type { GitBranch } from '../../../shared/ipc'

/** Pure seams for the Branch-changes scope's base-ref picker (#237). */

function branch(partial: Partial<GitBranch> & { name: string }): GitBranch {
  return { isRemote: false, current: false, isDefault: false, ...partial }
}

describe('buildBaseRefChoices', () => {
  const branches = [
    branch({ name: 'zeta' }),
    branch({ name: 'feat/x', current: true }),
    branch({ name: 'main', isDefault: true }),
    branch({ name: 'origin/alpha', isRemote: true }),
    branch({ name: 'alpha' }),
  ]

  it('excludes the CURRENT branch (comparing a branch against itself is empty)', () => {
    const names = buildBaseRefChoices(branches, 'feat/x').map((b) => b.name)
    expect(names).not.toContain('feat/x')
  })

  it('orders: default first, then locals alphabetical, then remotes', () => {
    expect(buildBaseRefChoices(branches, 'feat/x').map((b) => b.name)).toEqual([
      'main',
      'alpha',
      'zeta',
      'origin/alpha',
    ])
  })

  it('a null current branch (detached) excludes nothing', () => {
    expect(buildBaseRefChoices(branches, null).map((b) => b.name)).toContain('feat/x')
  })
})

describe('filterRefChoices', () => {
  const choices = [branch({ name: 'main' }), branch({ name: 'feat/alpha' }), branch({ name: 'origin/alpha' })]

  it('case-insensitive substring match; empty query returns all', () => {
    expect(filterRefChoices(choices, 'ALPHA').map((b) => b.name)).toEqual(['feat/alpha', 'origin/alpha'])
    expect(filterRefChoices(choices, '')).toEqual(choices)
  })
})
