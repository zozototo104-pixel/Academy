/// <reference types="bun-types" />
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

// Step 8 — monitoring dashboard API: admin-only GET that composes
// EXISTING readers and makes ZERO live provider calls.
// - non-admin -> 403
// - payload shape: mode, per-purpose rankings (top + why chosen/excluded
//   + honest cost), health / router state / diagnostics, last refresh,
//   last capability check (honest null when nothing recorded), transitions
//   newest-first, failover history from AiPipelineOperationLog
//   fallbackUsed rows (never the migration-only AiAutoFailoverEvent).
// - ZERO provider calls on GET: a fetch stub counts every call; the
//   route must never touch the network.
const values = new Map<string, string>()
let failoverRows: Array<Record<string, unknown>> = []
let adminAllowed = true
let fetchCalls = 0
const originalFetch = globalThis.fetch

const db: any = {
  setting: {
    findMany: async (args?: any) => {
      const whereKey = args?.where?.key || {}
      let rows = [...values.entries()].map(([key, value]) => ({ key, value }))
      if (Array.isArray(whereKey.in)) {
        const allowed = new Set<string>(whereKey.in)
        rows = rows.filter((row) => allowed.has(row.key))
      } else if (typeof whereKey.startsWith === 'string') {
        rows = rows.filter((row) => row.key.startsWith(whereKey.startsWith))
      }
      return typeof args?.take === 'number' ? rows.slice(0, args.take) : rows
    },
    findUnique: async ({ where }: any) =>
      values.has(where.key) ? { key: where.key, value: values.get(where.key) } : null,
    upsert: async ({ where, create, update }: any) => {
      const key = where.key
      const value = String(update?.value ?? create?.value ?? '')
      values.set(key, value)
      return { key, value }
    },
    deleteMany: async ({ where }: any) => {
      const key = where?.key
      let count = 0
      if (typeof key === 'string') {
        if (values.delete(key)) count = 1
      } else if (typeof key?.startsWith === 'string') {
        for (const k of [...values.keys()]) {
          if (k.startsWith(key.startsWith)) { values.delete(k); count++ }
        }
      }
      return { count }
    },
  },
  aiPipelineOperationLog: {
    findMany: async () => failoverRows,
  },
}
mock.module('@/lib/db', () => ({ db }))
// Sandbox note: the Prisma client is NOT generated here (node_modules
// has no .prisma/client), so any route importing '@prisma/client' at
// runtime fails to load — the pre-existing alborihi-admin-system test
// fails identically. The system route uses Prisma only for the
// TransactionIsolationLevel enum value (POST paths) and type positions,
// so the test stubs that one runtime value. CI (generated client) is
// the arbiter for the real import.
mock.module('@prisma/client', () => ({
  Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
}))
mock.module('@/lib/auth', () => ({
  requireAdmin: async () => {
    if (!adminAllowed) throw new Error('UNAUTHORIZED')
    return { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' }
  },
}))
mock.module('@/lib/settings', () => ({ getSetting: async (key: string) => values.get(key) || '' }))

const textAi = await import('../../src/lib/text-ai')
const { GET, POST } = await import('../../src/app/api/admin/ai-monitoring/route')

function makeStore(backing: Map<string, string>) {
  return {
    async read(keys: string[]) { return Object.fromEntries(keys.map((key) => [key, backing.get(key) || ''])) },
    async write(key: string, value: string) { backing.set(key, value) },
    async delete(key: string) { backing.delete(key) },
    async scan(prefix: string) { return Object.fromEntries([...backing.entries()].filter(([key]) => key.startsWith(prefix))) },
    async increment(key: string, amount: number) {
      const next = (Number(backing.get(key) || 0) || 0) + amount
      backing.set(key, String(next))
      return next
    },
  }
}
const store = makeStore(values)

function seedDashboard() {
  values.set('AI_AUTO_MODE_ENABLED', '1')
  values.set('AI_PROVIDER_TIERS', 'GROQ:FREE,ALBORIHI:PAID')
  values.set('AI_AUTO_RANKING:CHAT', JSON.stringify({
    purpose: 'CHAT',
    computedAt: '2026-11-24T17:00:00.000Z',
    candidates: [
      {
        provider: 'GROQ', model: 'llama-3.3-70b-versatile', score: 0.9,
        components: { quality: 0.9, recentSuccess: 0.95, adherence: 0.9, latency: 0.8, quota: 1, cost: 1 },
      },
      { provider: 'GEMINI', model: 'gemini-3.5-flash-lite', score: 0.4, excludedReason: 'QUOTA_COOLDOWN' },
    ],
  }))
  values.set('AI_AUTO_RANKING:REVIEW', JSON.stringify({
    purpose: 'REVIEW',
    computedAt: '2026-11-24T17:00:00.000Z',
    candidates: [{ provider: 'ALBORIHI', model: 'claude-sonnet-5', score: 0.8 }],
  }))
  values.set('AI_AUTO_RANKING:VISION', JSON.stringify({ purpose: 'VISION', computedAt: '2026-11-24T17:00:00.000Z', candidates: [] }))
  values.set('AI_AUTO_LAST_REFRESH', JSON.stringify({
    lastProvider: 'GROQ',
    lastRunAt: 1793775600000,
    results: { GROQ: { discoveryOk: true, models: 2, at: 1793775600000 } },
  }))
  values.set('AI_AUTO_CAPABILITY_PROBES:GROQ', JSON.stringify({
    probedAt: '2026-11-24T10:00:00.000Z',
    source: 'probe',
  }))
  values.set('AI_AUTO_MODE_TRANSITIONS', JSON.stringify([
    { at: '2026-11-24T18:00:00.000Z', from: 'manual', to: 'auto' },
    { at: '2026-11-24T09:00:00.000Z', from: 'auto', to: 'manual' },
  ]))
  values.set('AI_MODEL_HEALTH:GROQ:llama-3.3-70b-versatile', JSON.stringify({ ok: true, latencyMs: 120, checkedAt: '2026-11-24T17:00:00.000Z' }))
  values.set('AI_MODEL_STATS:GROQ:llama-3.3-70b-versatile', JSON.stringify({ success: 10, fail: {}, avgMs: 800, jsonOk: 9, jsonTotal: 10, evidenceOk: 10, evidenceTotal: 10 }))
  values.set('AI_COOLDOWN:GEMINI:0:gemini-3.5-flash-lite', JSON.stringify({ until: '2099-01-01T00:00:00.000Z', reason: 'quota', status: 429 }))
  failoverRows = [
    {
      id: 'log-1', createdAt: new Date('2026-11-24T16:00:00.000Z'), stage: 'GENERATION',
      provider: 'GROQ', model: 'llama-3.3-70b-versatile', success: true,
      failureCategory: 'RATE_LIMIT', fallbackUsed: true, latencyMs: 1200, bookId: 'book-1', unitId: null,
    },
    {
      id: 'log-2', createdAt: new Date('2026-11-24T15:00:00.000Z'), stage: 'READING',
      provider: 'GEMINI', model: 'gemini-3.5-flash-lite', success: false,
      failureCategory: 'PROVIDER_ERROR', fallbackUsed: true, latencyMs: 3000, bookId: 'book-1', unitId: null,
    },
  ]
}

beforeEach(() => {
  values.clear()
  failoverRows = []
  adminAllowed = true
  fetchCalls = 0
  globalThis.fetch = mock(async () => {
    fetchCalls += 1
    throw new Error('provider call forbidden on dashboard GET')
  }) as any
  textAi.__resetTextAiStateForTests()
  textAi.__setTextAiSettingStoreForTests(store)
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

afterAll(() => {
  textAi.__setTextAiSettingStoreForTests(null)
  globalThis.fetch = originalFetch
})

describe('ai-monitoring GET auth', () => {
  test('non-admin gets 403 and no payload', async () => {
    adminAllowed = false
    const response = await GET()
    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body.error).toBeTruthy()
    expect(fetchCalls).toBe(0)
  })
})

describe('ai-monitoring GET payload shape', () => {
  test('returns mode, all purposes, health, router state, diagnostics, refresh, capability check, transitions and failovers', async () => {
    seedDashboard()
    const response = await GET()
    expect(response.status).toBe(200)
    const body = await response.json()

    expect(body.mode).toEqual({ auto: true, value: '1' })
    // One ranking per purpose, even when a purpose has no stored row.
    expect(body.rankings.map((r: any) => r.purpose)).toEqual(
      ['CHAT', 'ANALYSIS', 'GENERATION', 'GRADING', 'VISION', 'LONG_CONTEXT', 'REVIEW'],
    )
    const chat = body.rankings.find((r: any) => r.purpose === 'CHAT')
    expect(chat.computedAt).toBe('2026-11-24T17:00:00.000Z')
    expect(chat.top).toMatchObject({ provider: 'GROQ', model: 'llama-3.3-70b-versatile', score: 0.9 })
    expect(chat.top.components).toEqual({ quality: 0.9, recentSuccess: 0.95, adherence: 0.9, latency: 0.8, quota: 1, cost: 1 })
    expect(chat.top.excludedReason).toBeNull()
    const excluded = chat.candidates.find((c: any) => c.provider === 'GEMINI')
    expect(excluded.excludedReason).toBe('QUOTA_COOLDOWN')
    const vision = body.rankings.find((r: any) => r.purpose === 'VISION')
    expect(vision.top).toBeNull()
    expect(vision.candidates).toEqual([])

    // Health / router state / diagnostics come from the existing readers.
    expect(body.health.some((h: any) => h.provider === 'GROQ' && h.model === 'llama-3.3-70b-versatile')).toBe(true)
    expect(body.routerState.some((s: any) => s.provider === 'GEMINI' && s.type === 'MODEL_COOLDOWN')).toBe(true)
    expect(body.diagnostics).toBeTruthy()
    expect(typeof body.diagnostics.message).toBe('string')

    expect(body.lastRefresh.lastProvider).toBe('GROQ')
    expect(body.lastRefresh.lastRunAt).toBe(1793775600000)
    expect(body.lastCapabilityCheck.at).toBe('2026-11-24T10:00:00.000Z')
    expect(body.lastCapabilityCheck.providers).toEqual([{ provider: 'GROQ', probedAt: '2026-11-24T10:00:00.000Z' }])

    // Transitions newest-first, exactly as stored.
    expect(body.transitions).toEqual([
      { at: '2026-11-24T18:00:00.000Z', from: 'manual', to: 'auto' },
      { at: '2026-11-24T09:00:00.000Z', from: 'auto', to: 'manual' },
    ])

    // Failover history: the two fallbackUsed pipeline rows, newest first.
    expect(body.failovers).toHaveLength(2)
    expect(body.failovers[0].id).toBe('log-1')
    expect(body.failovers[0].failureCategory).toBe('RATE_LIMIT')
    expect(body.failovers[0].createdAt).toBe('2026-11-24T16:00:00.000Z')
    expect(body.voiceNote).toContain('voice')
    expect(fetchCalls).toBe(0)
  })

  test('cost honesty: documented FREE/PAID vs undocumented unknown; balance always unknown', async () => {
    seedDashboard()
    const body = await (await GET()).json()
    const chat = body.rankings.find((r: any) => r.purpose === 'CHAT')
    const groq = chat.candidates.find((c: any) => c.provider === 'GROQ')
    const gemini = chat.candidates.find((c: any) => c.provider === 'GEMINI')
    const review = body.rankings.find((r: any) => r.purpose === 'REVIEW')
    const alborihi = review.candidates.find((c: any) => c.provider === 'ALBORIHI')
    // GROQ is documented FREE in AI_PROVIDER_TIERS; ALBORIHI documented
    // PAID; GEMINI has NO tier entry so it must be 'unknown', never free.
    expect(groq.costTier).toBe('free')
    expect(alborihi.costTier).toBe('paid')
    expect(gemini.costTier).toBe('unknown')
    for (const ranking of body.rankings) {
      for (const candidate of ranking.candidates) {
        expect(candidate.balance).toBe('unknown')
        if (candidate.provider === 'GEMINI') expect(candidate.costTier).toBe('unknown')
      }
    }
    expect(fetchCalls).toBe(0)
  })

  test('mode OFF reads manual and empty rankings stay honest', async () => {
    const body = await (await GET()).json()
    expect(body.mode).toEqual({ auto: false, value: '0' })
    for (const ranking of body.rankings) {
      expect(ranking.top).toBeNull()
      expect(ranking.candidates).toEqual([])
      expect(ranking.computedAt).toBeNull()
    }
    expect(body.lastRefresh).toEqual({})
    expect(body.lastCapabilityCheck).toBeNull()
    expect(body.transitions).toEqual([])
    expect(body.failovers).toEqual([])
    expect(body.health).toEqual([])
    expect(body.routerState).toEqual([])
    expect(fetchCalls).toBe(0)
  })

  test('last capability check is null when no probe row was ever recorded', async () => {
    seedDashboard()
    values.delete('AI_AUTO_CAPABILITY_PROBES:GROQ')
    const body = await (await GET()).json()
    // Honest "not recorded yet": no timestamp is invented.
    expect(body.lastCapabilityCheck).toBeNull()
    expect(fetchCalls).toBe(0)
  })

  test('a malformed ranking row is dropped, never invented', async () => {
    values.set('AI_AUTO_MODE_ENABLED', '1')
    values.set('AI_AUTO_RANKING:CHAT', 'not-json{{{')
    values.set('AI_AUTO_RANKING:VISION', JSON.stringify({ candidates: [{ provider: 'GROQ', model: 'llama-3.3-70b-versatile' }, { provider: '', model: 'x' }] }))
    const body = await (await GET()).json()
    const chat = body.rankings.find((r: any) => r.purpose === 'CHAT')
    expect(chat.candidates).toEqual([])
    expect(chat.computedAt).toBeNull()
    const vision = body.rankings.find((r: any) => r.purpose === 'VISION')
    expect(vision.candidates).toEqual([
      { provider: 'GROQ', model: 'llama-3.3-70b-versatile', score: null, components: null, excludedReason: null, costTier: 'unknown', balance: 'unknown' },
    ])
    expect(fetchCalls).toBe(0)
  })

  test('noQualifiedModel is null when nothing is pending, and lists pending events otherwise', async () => {
    seedDashboard()
    expect((await (await GET()).json()).noQualifiedModel).toBeNull()
    values.set('AI_AUTO_NO_MODEL_PENDING:CHAT', JSON.stringify({
      at: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T12:00:00.000Z',
      purpose: 'CHAT', status: 'PENDING_CHOICE', cause: 'PROVEN_EMPTY',
      excludedReasons: ['AUTO_NO_QUALIFIED_CANDIDATES'], rankingComputedAt: null,
      bootstrap: { claimed: true, scanned: ['GEMINI'], ranked: [], failed: [] },
      choice: null, choiceAt: null,
    }))
    values.set('AI_AUTO_NO_MODEL_PENDING:VISION', JSON.stringify({
      at: '2026-11-24T09:00:00.000Z', updatedAt: '2026-11-24T11:00:00.000Z',
      purpose: 'VISION', status: 'PENDING_CHOICE', cause: 'NEVER_COMPUTED',
      excludedReasons: [], rankingComputedAt: null, bootstrap: null,
      choice: null, choiceAt: null,
    }))
    // A malformed pending row is dropped, never invented.
    values.set('AI_AUTO_NO_MODEL_PENDING:REVIEW', 'garbage{{{')
    const body = await (await GET()).json()
    expect(body.noQualifiedModel.pending).toBe(true)
    expect(body.noQualifiedModel.purposes).toEqual(['CHAT', 'VISION'])
    expect(body.noQualifiedModel.firstSeenAt).toBe('2026-11-24T09:00:00.000Z')
    expect(body.noQualifiedModel.lastSeenAt).toBe('2026-11-24T12:00:00.000Z')
    expect(body.noQualifiedModel.lastPurpose).toBe('CHAT')
    expect(body.noQualifiedModel.events).toHaveLength(2)
    expect(body.noQualifiedModel.events[0]).toMatchObject({
      purpose: 'CHAT', at: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T12:00:00.000Z',
      cause: 'PROVEN_EMPTY', excludedReasons: ['AUTO_NO_QUALIFIED_CANDIDATES'], choice: null, choiceAt: null,
    })
    expect(body.noQualifiedModel.events[1]).toMatchObject({ purpose: 'VISION', cause: 'NEVER_COMPUTED' })
    expect(fetchCalls).toBe(0)
  })
})

describe('ai-monitoring POST (decision 3 choices)', () => {
  function postRequest(body: unknown) {
    return { json: async () => body } as any
  }

  function seedPendingChat() {
    values.set('AI_AUTO_NO_MODEL_PENDING:CHAT', JSON.stringify({
      at: '2026-11-24T10:00:00.000Z', updatedAt: '2026-11-24T10:00:00.000Z',
      purpose: 'CHAT', status: 'PENDING_CHOICE', cause: 'PROVEN_EMPTY',
      excludedReasons: ['AUTO_NO_QUALIFIED_CANDIDATES'], rankingComputedAt: null,
      bootstrap: null, choice: null, choiceAt: null,
    }))
  }

  test('non-admin gets 403 on POST', async () => {
    adminAllowed = false
    const response = await POST(postRequest({ action: 'stay-auto', purpose: 'CHAT' }))
    expect(response.status).toBe(403)
  })

  test('unknown action and unknown purpose get 400', async () => {
    expect((await POST(postRequest({ action: 'nope' }))).status).toBe(400)
    expect((await POST(postRequest({ action: 'stay-auto', purpose: 'NOPE' }))).status).toBe(400)
    expect((await POST(postRequest({ action: 'stay-auto' }))).status).toBe(400)
    expect((await POST(postRequest({ action: 'resolve', purpose: 'NOPE' }))).status).toBe(400)
  })

  test('stay-auto records the choice WITHOUT clearing pending', async () => {
    seedPendingChat()
    const response = await POST(postRequest({ action: 'stay-auto', purpose: 'CHAT' }))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    const event = JSON.parse(values.get('AI_AUTO_NO_MODEL_PENDING:CHAT') || 'null')
    expect(event).toMatchObject({
      purpose: 'CHAT', status: 'PENDING_CHOICE', cause: 'PROVEN_EMPTY',
      choice: 'STAY_AUTO', at: '2026-11-24T10:00:00.000Z',
    })
    expect(typeof event.choiceAt).toBe('string')
    // The banner stays pending: GET still lists the event.
    const body = await (await GET()).json()
    expect(body.noQualifiedModel.purposes).toEqual(['CHAT'])
    expect(body.noQualifiedModel.events[0].choice).toBe('STAY_AUTO')
  })

  test('stay-auto on a purpose with no pending event gets 404', async () => {
    const response = await POST(postRequest({ action: 'stay-auto', purpose: 'CHAT' }))
    expect(response.status).toBe(404)
  })

  test('resolve deletes one purpose, or all pending when no purpose is given', async () => {
    seedPendingChat()
    values.set('AI_AUTO_NO_MODEL_PENDING:VISION', JSON.stringify({
      at: '2026-11-24T09:00:00.000Z', updatedAt: '2026-11-24T09:00:00.000Z',
      purpose: 'VISION', status: 'PENDING_CHOICE', cause: 'NEVER_COMPUTED',
      excludedReasons: [], rankingComputedAt: null, bootstrap: null, choice: null, choiceAt: null,
    }))
    expect((await POST(postRequest({ action: 'resolve', purpose: 'CHAT' }))).status).toBe(200)
    expect(values.has('AI_AUTO_NO_MODEL_PENDING:CHAT')).toBe(false)
    expect(values.has('AI_AUTO_NO_MODEL_PENDING:VISION')).toBe(true)
    const response = await POST(postRequest({ action: 'resolve' }))
    expect(response.status).toBe(200)
    expect(values.has('AI_AUTO_NO_MODEL_PENDING:VISION')).toBe(false)
    expect((await (await GET()).json()).noQualifiedModel).toBeNull()
  })
})
