/// <reference types="bun-types" />
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type UsageRow = { userId?: string | null; costCents: number; createdAt?: Date }
type LiveUsageRow = { id: string; userId: string; month: string; purpose: string; freeMinutesUsed: number; paidMinutesUsed: number; sessionsCount: number; lastSessionAt?: Date | null }
type LiveCreditRow = { id: string; userId: string; minutes: number; remainingMinutes: number; status: string; expiresAt?: Date | null; createdAt?: Date; source?: string; note?: string | null }
type LiveSessionRow = { id: string; sessionId: string; userId: string; month: string; purpose: string; status: string; reservedMinutes: number; freeReserved: number; paidReserved: number; actualMinutes?: number | null; expiresAt: Date; settledAt?: Date | null }

const settings = new Map<string, string>()
let usageLogs: UsageRow[] = []
let currentRole = 'STUDENT'
const liveUsages = new Map<string, LiveUsageRow>()
let liveCredits: LiveCreditRow[] = []
const liveSessions = new Map<string, LiveSessionRow>()
let chatDeleteWhere: any = null
let whatsappDeleteWhere: any = null

function liveUsageKey(userId: string, month: string, purpose: string) {
  return `${userId}:${month}:${purpose}`
}

function applyNumberMutation(current: number, mutation: any) {
  if (typeof mutation === 'number') return mutation
  if (mutation?.increment != null) return current + Number(mutation.increment || 0)
  if (mutation?.decrement != null) return Math.max(0, current - Number(mutation.decrement || 0))
  return current
}

function firstLiveUsage() {
  const row = [...liveUsages.values()][0]
  if (!row) throw new Error('no live usage row')
  return row
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  setting: {
    findUnique: async ({ where }: any) => settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null,
    findMany: async () => [],
  },
  user: {
    findUnique: async ({ where }: any) => ({ id: where.id, role: currentRole }),
  },
  aiUsageLog: {
    findMany: async ({ where }: any) => usageLogs.filter((row) => (!where?.userId || row.userId === where.userId) && (!where?.createdAt?.gte || !row.createdAt || row.createdAt >= where.createdAt.gte)),
    create: async ({ data }: any) => { const row = { ...data, createdAt: new Date() }; usageLogs.push(row); return row },
  },
  enrollment: {
    count: async () => 1,
  },
  aiLiveUsage: {
    upsert: async ({ where, create }: any) => {
      const key = liveUsageKey(where.userId_month_purpose.userId, where.userId_month_purpose.month, where.userId_month_purpose.purpose)
      if (!liveUsages.has(key)) liveUsages.set(key, { id: `usage-${liveUsages.size + 1}`, userId: create.userId, month: create.month, purpose: create.purpose, freeMinutesUsed: 0, paidMinutesUsed: 0, sessionsCount: 0, lastSessionAt: null })
      return liveUsages.get(key)
    },
    findUnique: async ({ where }: any) => {
      const w = where.userId_month_purpose
      return liveUsages.get(liveUsageKey(w.userId, w.month, w.purpose)) || null
    },
    update: async ({ where, data }: any) => {
      const row = [...liveUsages.values()].find((item) => item.id === where.id)
      if (!row) throw new Error('usage not found')
      if (data.freeMinutesUsed !== undefined) row.freeMinutesUsed = applyNumberMutation(row.freeMinutesUsed, data.freeMinutesUsed)
      if (data.paidMinutesUsed !== undefined) row.paidMinutesUsed = applyNumberMutation(row.paidMinutesUsed, data.paidMinutesUsed)
      if (data.sessionsCount !== undefined) row.sessionsCount = applyNumberMutation(row.sessionsCount, data.sessionsCount)
      if (data.lastSessionAt !== undefined) row.lastSessionAt = data.lastSessionAt
      return row
    },
  },
  aiLiveCredit: {
    findMany: async ({ where }: any) => liveCredits.filter((row) => row.userId === where.userId && row.status === 'ACTIVE' && row.remainingMinutes > 0),
    update: async ({ where, data }: any) => {
      const row = liveCredits.find((item) => item.id === where.id)
      if (!row) throw new Error('credit not found')
      Object.assign(row, data)
      return row
    },
    create: async ({ data }: any) => {
      const row = { id: `credit-${liveCredits.length + 1}`, createdAt: new Date(), status: 'ACTIVE', ...data }
      liveCredits.push(row)
      return row
    },
  },
  aiLiveSession: {
    findUnique: async ({ where }: any) => liveSessions.get(where.sessionId) || [...liveSessions.values()].find((row) => row.id === where.id) || null,
    create: async ({ data }: any) => {
      const row = { id: `session-${liveSessions.size + 1}`, status: 'RESERVED', actualMinutes: null, settledAt: null, ...data }
      liveSessions.set(row.sessionId, row)
      return row
    },
    findMany: async ({ where, take }: any) => [...liveSessions.values()].filter((row) => row.status === where.status && row.expiresAt < where.expiresAt.lt).slice(0, take || 50),
    update: async ({ where, data }: any) => {
      const row = [...liveSessions.values()].find((item) => item.id === where.id)
      if (!row) throw new Error('session not found')
      Object.assign(row, data)
      return row
    },
  },
  chatMessage: {
    deleteMany: async ({ where }: any) => { chatDeleteWhere = where; return { count: 3 } },
  },
  whatsAppConversationMessage: {
    deleteMany: async ({ where }: any) => { whatsappDeleteWhere = where; return { count: 2 } },
  },
}

mock.module('@/lib/db', () => ({ db }))

const { __testFetchWithTimeout } = await import('../../src/lib/text-ai')
const { enforceAiUserDailyCostCap } = await import('../../src/lib/ai-usage-accounting')
const { reserveGeminiLiveUsage, settleGeminiLiveUsage } = await import('../../src/lib/live-usage-guard')
const { transcribeAudioBase64 } = await import('../../src/lib/asr')
const { cleanupOldAiConversations } = await import('../../src/lib/ai-retention')

beforeEach(() => {
  settings.clear()
  settings.set('AI_USER_DAILY_COST_CAP_CENTS', '1')
  settings.set('CHAT_RETENTION_DAYS', '180')
  usageLogs = []
  currentRole = 'STUDENT'
  liveUsages.clear()
  liveCredits = []
  liveSessions.clear()
  chatDeleteWhere = null
  whatsappDeleteWhere = null
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.GROQ_API_KEY
})

describe('AI D1 behavior', () => {
  test('provider timeout aborts fetch at the network signal level', async () => {
    const originalFetch = globalThis.fetch
    const captured: { signal: AbortSignal | null } = { signal: null }
    globalThis.fetch = ((_: any, init: any) => new Promise<Response>((_resolve, reject) => {
      captured.signal = init.signal
      init.signal.addEventListener('abort', () => {
        const error: any = new Error('aborted')
        error.name = 'AbortError'
        reject(error)
      })
    })) as any
    try {
      await expect(__testFetchWithTimeout('TEST', 'https://example.test/slow', {}, 5)).rejects.toMatchObject({ status: 504, code: 'AI_PROVIDER_TIMEOUT' })
      expect(captured.signal?.aborted).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('daily AI cost cap returns 429 for students while admins are exempt', async () => {
    usageLogs = [{ userId: 'student-1', costCents: 1, createdAt: new Date() }]
    currentRole = 'STUDENT'
    await expect(enforceAiUserDailyCostCap({ userId: 'student-1', estimatedCostCents: 1 })).rejects.toMatchObject({ status: 429, code: 'AI_USER_DAILY_COST_CAP_EXCEEDED' })
    currentRole = 'ADMIN'
    await expect(enforceAiUserDailyCostCap({ userId: 'student-1', estimatedCostCents: 100 })).resolves.toBeUndefined()
  })

  test('live audio reservation charges actual minutes and refund is idempotent', async () => {
    const reserved = await reserveGeminiLiveUsage({ userId: 'student-1', role: 'STUDENT', purpose: 'SUPERVISOR', requestedMinutes: 2, sessionId: 'live-session-1' })
    expect(reserved.ok).toBe(true)
    expect(reserved.sessionLimitMinutes).toBe(2)
    expect(firstLiveUsage().freeMinutesUsed).toBe(2)

    // The server settles against its own startedAt timestamp, not client-reported seconds.
    const session = liveSessions.get('live-session-1')
    if (!session) throw new Error('reserved session missing')
    ;(session as LiveSessionRow & { startedAt: Date }).startedAt = new Date(Date.now() - 30_000)
    const settled = await settleGeminiLiveUsage({ userId: 'student-1', sessionId: 'live-session-1', actualSeconds: 30 })
    expect(settled).toMatchObject({ ok: true, refundMinutes: 1 })
    expect(firstLiveUsage().freeMinutesUsed).toBe(1)

    const retried = await settleGeminiLiveUsage({ userId: 'student-1', sessionId: 'live-session-1', actualSeconds: 30 })
    expect(retried).toMatchObject({ ok: true, idempotent: true })
    expect(firstLiveUsage().freeMinutesUsed).toBe(1)
  })

  test('OGG voice falls back to Whisper-compatible provider when Gemini is unavailable', async () => {
    const originalFetch = globalThis.fetch
    process.env.OPENAI_API_KEY = 'openai-test-key'
    let calledUrl = ''
    globalThis.fetch = (async (url: any, init: any) => {
      calledUrl = String(url)
      expect(init?.signal).toBeTruthy()
      return new Response(JSON.stringify({ text: 'مرحبا من الصوت' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as any
    try {
      const text = await transcribeAudioBase64(Buffer.from('fake ogg').toString('base64'), { mimeType: 'audio/ogg; codecs=opus', allowZaiFallback: true })
      expect(text).toBe('مرحبا من الصوت')
      expect(calledUrl).toContain('/audio/transcriptions')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('retention cleanup excludes defense and protected conversation records', async () => {
    const result = await cleanupOldAiConversations(new Date('2026-10-16T00:00:00.000Z'))
    expect(result.chatDeleted).toBe(3)
    expect(chatDeleteWhere.OR).toEqual(expect.arrayContaining([{ kind: null }, { kind: { notIn: expect.arrayContaining(['DEFENSE', 'THESIS_DEFENSE']) } }]))
    expect(whatsappDeleteWhere.NOT).toEqual(expect.arrayContaining([{ rawType: { in: expect.arrayContaining(['DEFENSE', 'EXAM', 'APPEAL']) } }]))
  })
})
