import { describe, expect, it } from 'vitest'
import { createRoutineThreads } from './routine-threads'

describe('createRoutineThreads', () => {
  it('knows nothing until a run begins', () => {
    const threads = createRoutineThreads()
    expect(threads.has('t1')).toBe(false)
  })

  it('brackets one run', () => {
    const threads = createRoutineThreads()
    threads.begin('t1')
    expect(threads.has('t1')).toBe(true)
    threads.end('t1')
    expect(threads.has('t1')).toBe(false)
  })

  it('counts rather than flags, so a nested run does not clear the outer one', () => {
    const threads = createRoutineThreads()
    threads.begin('t1')
    threads.begin('t1')
    threads.end('t1')
    expect(threads.has('t1')).toBe(true)
    threads.end('t1')
    expect(threads.has('t1')).toBe(false)
  })

  it('tolerates an unmatched end rather than going negative', () => {
    const threads = createRoutineThreads()
    threads.end('t1')
    expect(threads.has('t1')).toBe(false)
    threads.begin('t1')
    expect(threads.has('t1')).toBe(true)
  })

  it('keeps Threads apart', () => {
    const threads = createRoutineThreads()
    threads.begin('t1')
    expect(threads.has('t2')).toBe(false)
  })
})
