import { describe, expect, it } from 'vitest'
import { discoverDevServers, parseLsofListeners } from './discover-servers'

// A realistic `lsof -iTCP -sTCP:LISTEN -P -n -F pcn` capture: a Vite server on bun
// (5173) and a node server (3000) are real dev servers; postgres (5432), rapportd
// (ephemeral 59913), Raycast (7265) and an Electron app (3773) are noise.
const REAL = `p601
crapportd
f8
n*:59913
p904
cpostgres
f7
n[::1]:5432
f8
n127.0.0.1:5432
p5436
cT3 Code (Alpha)
f17
n127.0.0.1:3773
p8335
cRaycast
f33
n127.0.0.1:7265
p23797
cbun
f30
n[::1]:5173
p32203
cnode
f22
n127.0.0.1:3000
f23
n[::1]:3000
`

describe('parseLsofListeners', () => {
  it('keeps only dev-runtime processes in a sane port range', () => {
    const servers = parseLsofListeners(REAL)
    expect(servers.map((s) => s.port)).toEqual([3000, 5173])
    expect(servers.map((s) => s.processName)).toEqual(['node', 'bun'])
  })

  it('normalizes loopback/unspecified hosts to a localhost URL', () => {
    const servers = parseLsofListeners(REAL)
    expect(servers.find((s) => s.port === 5173)?.url).toBe('http://localhost:5173/')
  })

  it('dedupes a process listening on the same port over IPv4 and IPv6', () => {
    // node above binds 3000 on both 127.0.0.1 and [::1] — one entry, not two.
    const threes = parseLsofListeners(REAL).filter((s) => s.port === 3000)
    expect(threes).toHaveLength(1)
  })

  it('tolerates garbage / empty input without throwing', () => {
    expect(parseLsofListeners('')).toEqual([])
    expect(parseLsofListeners('total nonsense\n???\nnf\n')).toEqual([])
  })
})

describe('discoverDevServers (injected exec)', () => {
  it('returns the parsed servers from the injected lsof output', async () => {
    const servers = await discoverDevServers(async () => REAL)
    expect(servers.map((s) => s.port)).toEqual([3000, 5173])
  })

  it('swallows an lsof failure and returns an empty list (never rejects)', async () => {
    const servers = await discoverDevServers(async () => {
      throw new Error('lsof: command not found')
    })
    expect(servers).toEqual([])
  })
})
