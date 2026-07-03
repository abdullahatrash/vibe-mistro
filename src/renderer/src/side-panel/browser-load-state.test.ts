import { describe, expect, it } from 'vitest'
import { INITIAL_LOAD, onFailLoad, onStartLoad, onStopLoad } from './browser-load-state'

describe('browser load-state machine', () => {
  it('starts idle', () => {
    expect(INITIAL_LOAD).toEqual({ status: 'idle' })
  })

  it('a start → stop is a normal successful load', () => {
    expect(onStopLoad(onStartLoad())).toEqual({ status: 'loaded' })
  })

  it('a failure records the url + code and enters failed', () => {
    const s = onFailLoad(onStartLoad(), 'http://localhost:9999/', -102)
    expect(s).toEqual({ status: 'failed', url: 'http://localhost:9999/', code: -102 })
  })

  it('the trailing did-stop-loading does NOT clobber a failure (the ordering gotcha)', () => {
    const failed = onFailLoad(onStartLoad(), 'http://localhost:9999/', -102)
    expect(onStopLoad(failed)).toEqual(failed)
  })

  it('a fresh start always yields loading — so a retry clears a prior failure', () => {
    expect(onStartLoad()).toEqual({ status: 'loading' })
  })

  it('ignores ERR_ABORTED (-3) — a superseded load is not a failure', () => {
    const loading = onStartLoad()
    expect(onFailLoad(loading, 'http://x/', -3)).toBe(loading)
  })
})
