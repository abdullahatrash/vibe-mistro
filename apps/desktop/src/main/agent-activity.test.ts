import { describe, expect, it } from 'vitest'
import { AgentActivity } from './agent-activity'

describe('AgentActivity', () => {
  it('protects the active agent and releases it when the selection moves on', () => {
    const a = new AgentActivity()
    a.setActive('a1')
    expect(a.isProtected('a1')).toBe(true)
    a.setActive('a2')
    expect(a.isProtected('a1')).toBe(false)
    a.setActive(null)
    expect(a.isProtected('a2')).toBe(false)
  })

  it('counts overlapping turns — protected until EVERY turn ends, never below zero', () => {
    const a = new AgentActivity()
    a.beginTurn('a1')
    a.beginTurn('a1')
    a.endTurn('a1')
    expect(a.isProtected('a1')).toBe(true) // one turn still open
    a.endTurn('a1')
    expect(a.isProtected('a1')).toBe(false)
    a.endTurn('a1') // unbalanced end must not corrupt the count
    a.beginTurn('a1')
    expect(a.isProtected('a1')).toBe(true)
  })

  it('protects an agent for the whole sign-in flow', () => {
    const a = new AgentActivity()
    a.beginAuth('a1')
    expect(a.isProtected('a1')).toBe(true)
    a.endAuth('a1')
    expect(a.isProtected('a1')).toBe(false)
  })

  it('protects an agent for the whole Routine run, counting overlapping runs (#468)', () => {
    const a = new AgentActivity()
    a.beginRoutine('a1')
    a.beginRoutine('a1') // two Bots in one Workspace, both due
    expect(a.isProtected('a1')).toBe(true)
    a.endRoutine('a1')
    expect(a.isProtected('a1')).toBe(true) // one run still open
    a.endRoutine('a1')
    expect(a.isProtected('a1')).toBe(false)
    a.endRoutine('a1') // unbalanced end must not corrupt the count
    a.beginRoutine('a1')
    expect(a.isProtected('a1')).toBe(true)
  })

  it('evict clears the turn AND Routine counts so a disposed agent leaves no stale protection', () => {
    const a = new AgentActivity()
    a.beginTurn('a1')
    a.beginRoutine('a1')
    a.evict('a1')
    expect(a.isProtected('a1')).toBe(false)
  })
})
