import { describe, expect, it } from 'vitest'
import { planLabel } from './plan-label'

describe('planLabel', () => {
  it('maps chat plans (Vibe plan_title parity)', () => {
    expect(planLabel({ planType: 'CHAT', planName: 'FREE' })).toBe('Free')
    expect(planLabel({ planType: 'CHAT', planName: 'INDIVIDUAL' })).toBe('Pro')
    expect(planLabel({ planType: 'CHAT', planName: 'EDU' })).toBe('Pro')
    expect(planLabel({ planType: 'CHAT', planName: 'TEAM' })).toBe('Pro')
    expect(planLabel({ planType: 'CHAT', planName: 'SOMETHING_ELSE' })).toBeNull()
  })

  it('is case-insensitive on plan names', () => {
    expect(planLabel({ planType: 'CHAT', planName: 'individual' })).toBe('Pro')
  })

  it('maps API plans: FREE substring is free, anything else is Scale', () => {
    expect(planLabel({ planType: 'API', planName: 'FREE_TIER' })).toBe('Free')
    expect(planLabel({ planType: 'API', planName: 'STANDARD' })).toBe('Scale plan')
  })

  it('maps Mistral Code single-letter plan names', () => {
    expect(planLabel({ planType: 'MISTRAL_CODE', planName: 'F' })).toBe('Mistral Code Free')
    expect(planLabel({ planType: 'MISTRAL_CODE', planName: 'E' })).toBe('Mistral Code Enterprise')
    expect(planLabel({ planType: 'MISTRAL_CODE', planName: 'X' })).toBeNull()
  })

  it('returns null for unknown/unauthorized tiers and a missing plan', () => {
    expect(planLabel({ planType: 'UNKNOWN', planName: 'FREE' })).toBeNull()
    expect(planLabel({ planType: 'UNAUTHORIZED', planName: '' })).toBeNull()
    expect(planLabel(null)).toBeNull()
  })
})
