import { describe, expect, it } from 'vitest'
import { parseSkillFrontmatter, skillBody } from './parse-skill'

function skillMd(frontmatter: string, body = 'Do the thing.'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`
}

describe('parseSkillFrontmatter', () => {
  it('parses the required fields with the user-invocable default (true)', () => {
    expect(parseSkillFrontmatter(skillMd('name: review-pr\ndescription: Review a PR'))).toEqual({
      name: 'review-pr',
      description: 'Review a PR',
      userInvocable: true,
    })
  })

  it('honors quotes, hyphenated keys, comments, and an explicit user-invocable: false', () => {
    const content = skillMd(
      `# a comment\nname: "deploy"\ndescription: 'Ship it safely'\nuser-invocable: false\nlicense: MIT`,
    )
    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'deploy',
      description: 'Ship it safely',
      userInvocable: false,
    })
  })

  it('ignores nested structures (metadata dicts) without breaking scalar fields', () => {
    const content = skillMd('name: x1\ndescription: has metadata\nmetadata:\n  type: user\n  extra: 1')
    expect(parseSkillFrontmatter(content)).toMatchObject({ name: 'x1', description: 'has metadata' })
  })

  it('folds block-scalar descriptions (>- / |) — the shape real skills use', () => {
    const folded = skillMd('name: caveman\ndescription: >-\n  Ultra-compressed mode.\n  Cuts tokens.\nuser-invocable: true')
    expect(parseSkillFrontmatter(folded)).toMatchObject({
      description: 'Ultra-compressed mode. Cuts tokens.',
    })
    const literal = skillMd('name: lit\ndescription: |\n  Line one.\n  Line two.')
    expect(parseSkillFrontmatter(literal)).toMatchObject({ description: 'Line one. Line two.' })
  })

  it('joins plain-scalar continuation lines (multi-line description without a block marker)', () => {
    const content = skillMd(
      'name: clerk\ndescription: Clerk authentication router. Use when user asks\n  about Clerk CLI operations,\n  or setting up Clerk.',
    )
    expect(parseSkillFrontmatter(content)).toMatchObject({
      description: 'Clerk authentication router. Use when user asks about Clerk CLI operations, or setting up Clerk.',
    })
    // continuation must not leak into the NEXT field
    const twoFields = skillMd('name: x2\ndescription: first\n  continued\nuser-invocable: false')
    expect(parseSkillFrontmatter(twoFields)).toEqual({
      name: 'x2',
      description: 'first continued',
      userInvocable: false,
    })
  })

  it("rejects files that don't start with a fence, lack a closing fence, or miss required fields", () => {
    expect(parseSkillFrontmatter('name: x\ndescription: y')).toBeNull()
    expect(parseSkillFrontmatter('---\nname: x\ndescription: y')).toBeNull()
    expect(parseSkillFrontmatter(skillMd('name: solo'))).toBeNull() // no description
    expect(parseSkillFrontmatter(skillMd('description: no name'))).toBeNull()
  })

  it("rejects names outside Vibe's shape (lowercase alnum + hyphens, ≤64)", () => {
    expect(parseSkillFrontmatter(skillMd('name: Bad Name\ndescription: d'))).toBeNull()
    expect(parseSkillFrontmatter(skillMd('name: -lead\ndescription: d'))).toBeNull()
    expect(parseSkillFrontmatter(skillMd(`name: ${'a'.repeat(65)}\ndescription: d`))).toBeNull()
    expect(parseSkillFrontmatter(skillMd('name: ok-2\ndescription: d'))).not.toBeNull()
  })
})

describe('skillBody', () => {
  it('returns the trimmed markdown after the frontmatter', () => {
    expect(skillBody('---\nname: x\ndescription: d\n---\n\n# Title\n\nDo things.\n')).toBe(
      '# Title\n\nDo things.',
    )
  })

  it('is defensive: content without valid fences comes back as-is (trimmed)', () => {
    expect(skillBody('just markdown, no fences\n')).toBe('just markdown, no fences')
    expect(skillBody('---\nnever closed')).toBe('---\nnever closed')
  })

  it('keeps --- horizontal rules INSIDE the body (only the first fence pair is frontmatter)', () => {
    expect(skillBody('---\nname: x\ndescription: d\n---\nabove\n\n---\n\nbelow')).toBe(
      'above\n\n---\n\nbelow',
    )
  })
})
