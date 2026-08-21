import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { vibeProfileDirs } from './profile-dirs'

describe('vibeProfileDirs', () => {
  it('defaults to ~/.vibe/agents + ~/.vibe/prompts', () => {
    expect(vibeProfileDirs({}, '/home/u')).toEqual({
      agentsDir: join('/home/u', '.vibe', 'agents'),
      promptsDir: join('/home/u', '.vibe', 'prompts'),
    })
  })

  it('honours VIBE_HOME, the same resolution the spawned agent sees', () => {
    expect(vibeProfileDirs({ VIBE_HOME: '/opt/vibe' }, '/home/u')).toEqual({
      agentsDir: join('/opt/vibe', 'agents'),
      promptsDir: join('/opt/vibe', 'prompts'),
    })
  })

  it('ignores an empty VIBE_HOME rather than resolving to a bare "agents"', () => {
    expect(vibeProfileDirs({ VIBE_HOME: '' }, '/home/u').agentsDir).toBe(
      join('/home/u', '.vibe', 'agents'),
    )
  })
})
