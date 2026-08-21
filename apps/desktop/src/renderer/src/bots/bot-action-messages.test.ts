import { describe, it, expect } from 'vitest'
import type { BotStartOverFailure } from '../../../shared/ipc'
import { deleteBotFailureMessage, startOverFailureMessage } from './bot-action-messages'

const REASONS: BotStartOverFailure[] = ['streaming', 'notFound', 'io']

describe('startOverFailureMessage', () => {
  it('has a message for every typed reason, naming the Bot', () => {
    for (const reason of REASONS) {
      const message = startOverFailureMessage(reason, 'Rex')
      expect(message).toContain('Rex')
      expect(message.length).toBeGreaterThan(20)
    }
  })

  it('tells the user what to do about the reachable one (a mid-turn click race)', () => {
    expect(startOverFailureMessage('streaming', 'Rex')).toMatch(/wait/i)
  })

  it('admits the Bot kept its old conversation when the write failed', () => {
    // The one case where nothing on screen would otherwise differ from success.
    expect(startOverFailureMessage('io', 'Rex')).toMatch(/still has its old conversation/i)
  })
})

describe('deleteBotFailureMessage', () => {
  it('says the Bot is untouched, so the user does not re-delete or assume it half-happened', () => {
    const message = deleteBotFailureMessage('Rex')
    expect(message).toContain('Rex')
    expect(message).toMatch(/nothing was changed/i)
  })
})
