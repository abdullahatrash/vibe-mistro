import { describe, expect, it } from 'vitest'
import type { AccountWhoamiResult } from '../../shared/ipc'
import {
  getAccountWhoami,
  MISTRAL_API_KEY,
  parseDotenvValue,
  parseWhoamiPayload,
  resolveMistralApiKey,
  WHOAMI_URL,
  type WhoamiDeps,
} from './whoami'

describe('parseDotenvValue', () => {
  it('reads a bare assignment', () => {
    expect(parseDotenvValue('MISTRAL_API_KEY=abc123\n', MISTRAL_API_KEY)).toBe('abc123')
  })

  it('strips single and double quotes (python-dotenv set_key writes quoted)', () => {
    expect(parseDotenvValue("MISTRAL_API_KEY='abc123'", MISTRAL_API_KEY)).toBe('abc123')
    expect(parseDotenvValue('MISTRAL_API_KEY="abc123"', MISTRAL_API_KEY)).toBe('abc123')
  })

  it('handles export prefix, surrounding whitespace, and other keys', () => {
    const content = '# creds\nexport OTHER=x\n  export MISTRAL_API_KEY = abc123  \n'
    expect(parseDotenvValue(content, MISTRAL_API_KEY)).toBe('abc123')
  })

  it('ignores comments and takes the LAST assignment (dotenv semantics)', () => {
    const content = '# MISTRAL_API_KEY=commented\nMISTRAL_API_KEY=first\nMISTRAL_API_KEY=second\n'
    expect(parseDotenvValue(content, MISTRAL_API_KEY)).toBe('second')
  })

  it('returns null for a missing key or an empty value', () => {
    expect(parseDotenvValue('OTHER=x\n', MISTRAL_API_KEY)).toBeNull()
    expect(parseDotenvValue('MISTRAL_API_KEY=\n', MISTRAL_API_KEY)).toBeNull()
    expect(parseDotenvValue('MISTRAL_API_KEY=""\n', MISTRAL_API_KEY)).toBeNull()
  })

  it('does not match keys that merely start with the wanted name', () => {
    expect(parseDotenvValue('MISTRAL_API_KEY_OLD=x\n', MISTRAL_API_KEY)).toBeNull()
  })
})

describe('parseWhoamiPayload', () => {
  it('parses the documented shape', () => {
    expect(
      parseWhoamiPayload({ plan_type: 'CHAT', plan_name: 'INDIVIDUAL', prompt_switching_to_pro_plan: false }),
    ).toEqual({ planType: 'CHAT', planName: 'INDIVIDUAL' })
  })

  it('normalises case/whitespace and degrades unknown plan types to UNKNOWN (Vibe parity)', () => {
    expect(parseWhoamiPayload({ plan_type: ' chat ', plan_name: ' Free ' })).toEqual({
      planType: 'CHAT',
      planName: 'Free',
    })
    expect(parseWhoamiPayload({ plan_type: 'SOMETHING_NEW', plan_name: 'X' })).toEqual({
      planType: 'UNKNOWN',
      planName: 'X',
    })
  })

  it('rejects payloads where plan_type/plan_name are not both strings', () => {
    expect(parseWhoamiPayload({ plan_type: 'CHAT' })).toBeNull()
    expect(parseWhoamiPayload({ plan_type: 1, plan_name: 'x' })).toBeNull()
    expect(parseWhoamiPayload(null)).toBeNull()
    expect(parseWhoamiPayload('nope')).toBeNull()
  })
})

function deps(overrides: Partial<WhoamiDeps>): WhoamiDeps {
  return {
    env: {},
    readEnvFile: async () => null,
    readKeyring: async () => null,
    fetchFn: async () => {
      throw new Error('fetch not expected')
    },
    ...overrides,
  }
}

describe('resolveMistralApiKey', () => {
  it('prefers process env over dotenv over keyring (Vibe active-credential order)', async () => {
    const all = deps({
      env: { MISTRAL_API_KEY: 'from-env' },
      readEnvFile: async () => 'MISTRAL_API_KEY=from-dotenv',
      readKeyring: async () => 'from-keyring',
    })
    expect(await resolveMistralApiKey(all)).toBe('from-env')
    expect(await resolveMistralApiKey({ ...all, env: {} })).toBe('from-dotenv')
    expect(await resolveMistralApiKey({ ...all, env: {}, readEnvFile: async () => null })).toBe(
      'from-keyring',
    )
  })

  it('treats an empty env value as absent', async () => {
    const d = deps({ env: { MISTRAL_API_KEY: '' }, readKeyring: async () => 'from-keyring' })
    expect(await resolveMistralApiKey(d)).toBe('from-keyring')
  })

  it('returns null when signed out of every store', async () => {
    expect(await resolveMistralApiKey(deps({}))).toBeNull()
  })
})

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

describe('getAccountWhoami', () => {
  it('returns no-key without touching the network when nothing is stored', async () => {
    const result = await getAccountWhoami(deps({}))
    expect(result).toEqual<AccountWhoamiResult>({
      ok: false,
      reason: 'no-key',
      error: 'No Mistral API key found.',
    })
  })

  it('sends the resolved key as a Bearer token to the whoami URL and parses the plan', async () => {
    let seenUrl: string | undefined
    let seenAuth: string | null | undefined
    const result = await getAccountWhoami(
      deps({
        env: { MISTRAL_API_KEY: 'sk-test' },
        fetchFn: async (url, init) => {
          seenUrl = String(url)
          seenAuth = new Headers(init?.headers).get('Authorization')
          return jsonResponse(200, { plan_type: 'CHAT', plan_name: 'INDIVIDUAL' })
        },
      }),
    )
    expect(seenUrl).toBe(WHOAMI_URL)
    expect(seenAuth).toBe('Bearer sk-test')
    expect(result).toEqual({ ok: true, plan: { planType: 'CHAT', planName: 'INDIVIDUAL' } })
  })

  it('classifies 401/403 as unauthorized (Vibe gateway parity)', async () => {
    for (const status of [401, 403]) {
      const result = await getAccountWhoami(
        deps({
          env: { MISTRAL_API_KEY: 'sk-test' },
          fetchFn: async () => jsonResponse(status, {}),
        }),
      )
      expect(result).toMatchObject({ ok: false, reason: 'unauthorized' })
    }
  })

  it('classifies other failures as error: bad status, network throw, non-JSON, bad shape', async () => {
    const cases: Array<WhoamiDeps['fetchFn']> = [
      async () => jsonResponse(500, {}),
      async () => {
        throw new Error('offline')
      },
      async () => new Response('<html>', { status: 200 }),
      async () => jsonResponse(200, { plan_type: 'CHAT' }),
    ]
    for (const fetchFn of cases) {
      const result = await getAccountWhoami(deps({ env: { MISTRAL_API_KEY: 'sk-test' }, fetchFn }))
      expect(result).toMatchObject({ ok: false, reason: 'error' })
    }
  })
})
