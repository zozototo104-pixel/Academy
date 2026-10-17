/// <reference types="bun-types" />
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { NextRequest } from 'next/server'

type UsageRow = {
  id: string
  userId: string
  month: string
  purpose: string
  freeMinutesUsed: number
  paidMinutesUsed: number
  sessionsCount: number
  lastSessionAt?: Date | null
}
type CreditRow = { id: string; userId: string; remainingMinutes: number; status: string; expiresAt?: Date | null; createdAt?: Date }
type SessionRow = {
  id: string
  sessionId: string
  userId: string
  month: string
  purpose: string
  status: string
  reservedMinutes: number
  freeReserved: number
  paidReserved: number
  actualMinutes?: number | null
  settledAt?: Date | null
  expiresAt: Date
}

const month = () => new Date().toISOString().slice(0, 7)
const usageKey = (userId: string, m: string, purpose: string) => `${userId}:${m}:${purpose}`
const usages = new Map<string, UsageRow>()
const sessions = new Map<string, SessionRow>()
let credits: CreditRow[] = []
let currentUser = { id: 'student-1', role: 'STUDENT' }
let studentAiAllowed = true
let latestThesisStatus: string | null = null
const operations = { usageReads: 0, usageWrites: 0, creditReads: 0, creditWrites: 0 }

function updateNumber(current: number, change: any): number {
  if (typeof change === 'number') return change
  if (change?.increment !== undefined) return current + Number(change.increment)
  if (change?.decrement !== undefined) return current - Number(change.decrement)
  return current
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => work(db),
  enrollment: { count: async () => 0 },
  thesisSubmission: { findFirst: async () => latestThesisStatus ? { id: 'thesis-1', status: latestThesisStatus, createdAt: new Date() } : null },
  setting: { findUnique: async () => null, findMany: async () => [] },
  auditLog: { create: async () => ({}) },
  aiLiveUsage: {
    findUnique: async ({ where }: any) => {
      operations.usageReads++
      const w = where.userId_month_purpose
      return usages.get(usageKey(w.userId, w.month, w.purpose)) || null
    },
    upsert: async ({ where, create }: any) => {
      operations.usageWrites++
      const w = where.userId_month_purpose
      const key = usageKey(w.userId, w.month, w.purpose)
      if (!usages.has(key)) usages.set(key, { id: `usage-${usages.size + 1}`, userId: create.userId, month: create.month, purpose: create.purpose, freeMinutesUsed: 0, paidMinutesUsed: 0, sessionsCount: 0 })
      return usages.get(key)
    },
    update: async ({ where, data }: any) => {
      operations.usageWrites++
      const row = [...usages.values()].find((item) => item.id === where.id)
      if (!row) throw new Error('usage not found')
      if (data.freeMinutesUsed !== undefined) row.freeMinutesUsed = updateNumber(row.freeMinutesUsed, data.freeMinutesUsed)
      if (data.paidMinutesUsed !== undefined) row.paidMinutesUsed = updateNumber(row.paidMinutesUsed, data.paidMinutesUsed)
      if (data.sessionsCount !== undefined) row.sessionsCount = updateNumber(row.sessionsCount, data.sessionsCount)
      if (data.lastSessionAt !== undefined) row.lastSessionAt = data.lastSessionAt
      return row
    },
  },
  aiLiveCredit: {
    findMany: async ({ where }: any) => {
      operations.creditReads++
      return credits.filter((row) => row.userId === where.userId && row.status === 'ACTIVE' && row.remainingMinutes > 0)
    },
    update: async ({ where, data }: any) => {
      operations.creditWrites++
      const row = credits.find((item) => item.id === where.id)
      if (!row) throw new Error('credit not found')
      Object.assign(row, data)
      return row
    },
    create: async ({ data }: any) => {
      operations.creditWrites++
      const row = { id: `credit-${credits.length + 1}`, status: 'ACTIVE', ...data }
      credits.push(row)
      return row
    },
  },
  aiLiveSession: {
    findUnique: async ({ where }: any) => sessions.get(where.sessionId) || [...sessions.values()].find((row) => row.id === where.id) || null,
    create: async ({ data }: any) => {
      const row: SessionRow = { id: `session-${sessions.size + 1}`, status: 'RESERVED', actualMinutes: null, settledAt: null, ...data }
      sessions.set(row.sessionId, row)
      return row
    },
    update: async ({ where, data }: any) => {
      const row = [...sessions.values()].find((item) => item.id === where.id)
      if (!row) throw new Error('session not found')
      Object.assign(row, data)
      return row
    },
  },
}

// Keep the database entirely in-memory; all other module mocks retain real exports.
mock.module('@/lib/db', () => ({ db }))

const realAuth = await import('../../src/lib/auth')
mock.module('@/lib/auth', () => ({ ...realAuth, requireUser: async () => currentUser }))

const realGemini = await import('../../src/lib/gemini')
mock.module('@/lib/gemini', () => ({ ...realGemini, ensureGeminiKey: async () => {}, geminiApiKey: async () => 'test-gemini-key' }))

const realRateLimit = await import('../../src/lib/rate-limit')
mock.module('@/lib/rate-limit', () => ({ ...realRateLimit, enforceApiRateLimit: () => null }))

const realAccess = await import('../../src/lib/student-ai-access')
mock.module('@/lib/student-ai-access', () => ({
  ...realAccess,
  requireStudentAiSupervisorAccess: async (user: any) => {
    if (user.role !== 'STUDENT' || studentAiAllowed) return { allowed: true, reason: null, admissionId: 'adm-1' }
    const err: any = new Error('AI_SUPERVISOR_LOCKED')
    err.status = 403
    err.code = 'AI_SUPERVISOR_LOCKED'
    err.reason = 'يتاح المشرف الذكي بعد قبول الإدارة للطلب'
    throw err
  },
}))

const { getGeminiLiveAllowance, liveSessionLimitMinutes, reserveGeminiLiveUsage, settleGeminiLiveUsage } = await import('../../src/lib/live-usage-guard')
const { isLiveMinutesExhausted } = await import('../../src/lib/voice/geminiLiveAgent')

const realSupervisorAi = await import('../../src/lib/supervisor-ai')
mock.module('@/lib/supervisor-ai', () => ({ ...realSupervisorAi, buildSupervisorContext: async () => '' }))
const realTextAi = await import('../../src/lib/text-ai')
mock.module('@/lib/text-ai', () => ({ ...realTextAi, geminiKeysForLive: async () => [], reportGeminiLiveKeyFailure: async () => {}, reportGeminiLiveKeySuccess: () => {} }))

const { POST } = await import('../../src/app/api/ai/gemini-live/session/route')

const previousStudentLimit = process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT
const previousAdminSessionLimit = process.env.AACT_LIVE_SESSION_MAX_MINUTES_ADMIN
beforeEach(() => {
  usages.clear()
  sessions.clear()
  credits = []
  currentUser = { id: 'student-1', role: 'STUDENT' }
  studentAiAllowed = true
  latestThesisStatus = null
  operations.usageReads = 0
  operations.usageWrites = 0
  operations.creditReads = 0
  operations.creditWrites = 0
  process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT = '30'
  process.env.AACT_LIVE_SESSION_MAX_MINUTES_ADMIN = '30'
})
afterAll(() => {
  if (previousStudentLimit === undefined) delete process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT
  else process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT = previousStudentLimit
  if (previousAdminSessionLimit === undefined) delete process.env.AACT_LIVE_SESSION_MAX_MINUTES_ADMIN
  else process.env.AACT_LIVE_SESSION_MAX_MINUTES_ADMIN = previousAdminSessionLimit
})

describe('Admin Gemini Live minutes and classified errors', () => {
  test('admin at 5000 used minutes reserves at 200 without reading or changing usage/credits, and settles real duration', async () => {
    const oldUsage: UsageRow = {
      id: 'usage-admin', userId: 'admin-1', month: month(), purpose: 'SUPERVISOR',
      freeMinutesUsed: 5000, paidMinutesUsed: 12, sessionsCount: 200,
    }
    usages.set(usageKey(oldUsage.userId, oldUsage.month, oldUsage.purpose), oldUsage)
    credits = [{ id: 'credit-admin', userId: 'admin-1', status: 'ACTIVE', remainingMinutes: 25 }]
    const originalUsage = { ...oldUsage }
    const originalCredits = credits.map((row) => ({ ...row }))

    const allowance = await getGeminiLiveAllowance({ userId: 'admin-1', role: 'ADMIN', purpose: 'SUPERVISOR' })
    expect(allowance).toMatchObject({ ok: true, status: 200, totalRemainingMinutes: 999999 })
    expect(allowance.sessionLimitMinutes).toBe(liveSessionLimitMinutes('ADMIN', 'SUPERVISOR'))

    const reserved = await reserveGeminiLiveUsage({ userId: 'admin-1', role: 'ADMIN', purpose: 'SUPERVISOR', requestedMinutes: 2, sessionId: 'admin-unmetered-1' })
    expect(reserved).toMatchObject({ ok: true, status: 200, sessionId: 'admin-unmetered-1', totalRemainingMinutes: 999999 })
    expect(reserved.sessionLimitMinutes).toBe(liveSessionLimitMinutes('ADMIN', 'SUPERVISOR'))
    expect(sessions.get('admin-unmetered-1')).toMatchObject({ reservedMinutes: 0, freeReserved: 0, paidReserved: 0, status: 'RESERVED' })
    expect(oldUsage).toEqual(originalUsage)
    expect(credits).toEqual(originalCredits)
    expect(operations).toEqual({ usageReads: 0, usageWrites: 0, creditReads: 0, creditWrites: 0 })

    const settled = await settleGeminiLiveUsage({ sessionId: 'admin-unmetered-1', actualSeconds: 90 })
    expect(settled).toMatchObject({ ok: true, status: 200, refundMinutes: 0, session: { actualMinutes: 2, status: 'SETTLED' } })
    expect(oldUsage).toEqual(originalUsage)
    expect(credits).toEqual(originalCredits)
    expect(operations).toEqual({ usageReads: 0, usageWrites: 0, creditReads: 0, creditWrites: 0 })
  })

  test('student with exhausted minutes gets HTTP 402 and LIVE_MINUTES_EXHAUSTED from session endpoint', async () => {
    usages.set(usageKey('student-1', month(), 'SUPERVISOR'), {
      id: 'usage-student', userId: 'student-1', month: month(), purpose: 'SUPERVISOR',
      freeMinutesUsed: 30, paidMinutesUsed: 0, sessionsCount: 15,
    })
    const rejected = await reserveGeminiLiveUsage({ userId: 'student-1', role: 'STUDENT', requestedMinutes: 2, sessionId: 'student-no-credit' })
    expect(rejected).toMatchObject({ ok: false, status: 402, totalRemainingMinutes: 0 })
    expect(sessions.has('student-no-credit')).toBe(false)

    const response = await POST(new NextRequest('http://localhost/api/ai/gemini-live/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'SUPERVISOR' }),
    }))
    expect(response.status).toBe(402)
    expect(await response.json()).toMatchObject({ code: 'LIVE_MINUTES_EXHAUSTED', liveUsage: { ok: false, status: 402 } })
  })

  test('student without supervisor AI access is blocked before reserving live minutes', async () => {
    studentAiAllowed = false

    const response = await POST(new NextRequest('http://localhost/api/ai/gemini-live/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'SUPERVISOR' }),
    }))
    const payload = await response.json()

    expect(response.status).toBe(403)
    expect(payload.code).toBe('AI_SUPERVISOR_LOCKED')
    expect(sessions.size).toBe(0)
    expect(operations.usageWrites).toBe(0)
  })

  test('student without supervisor AI access can start discussion voice when latest thesis is scheduled', async () => {
    studentAiAllowed = false
    latestThesisStatus = 'SCHEDULED'

    const response = await POST(new NextRequest('http://localhost/api/ai/gemini-live/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'DISCUSSION', testOnly: true }),
    }))

    expect(response.status).not.toBe(403)
  })

  test('student whose latest thesis is not scheduled cannot start discussion voice', async () => {
    latestThesisStatus = 'DRAFT'

    const response = await POST(new NextRequest('http://localhost/api/ai/gemini-live/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose: 'DISCUSSION' }),
    }))
    const payload = await response.json()

    expect(response.status).toBe(403)
    expect(payload.code).toBe('DEFENSE_NOT_SCHEDULED')
  })

  test('other Gemini failures do not classify as a minutes purchase case', () => {
    expect(isLiveMinutesExhausted({ status: 402 })).toBe(true)
    expect(isLiveMinutesExhausted({ code: 'LIVE_MINUTES_EXHAUSTED' })).toBe(true)
    expect(isLiveMinutesExhausted({ status: 429, code: 'RESOURCE_EXHAUSTED' })).toBe(false)
    expect(isLiveMinutesExhausted({ status: 502, code: 'GEMINI_LIVE_UNAVAILABLE' })).toBe(false)
  })

  test('supervisor still reserves paid/free minutes normally', async () => {
    const reserved = await reserveGeminiLiveUsage({ userId: 'supervisor-1', role: 'SUPERVISOR', requestedMinutes: 2, sessionId: 'supervisor-metered-1' })
    expect(reserved).toMatchObject({ ok: true, status: 200, sessionLimitMinutes: 2 })
    expect(usages.get(usageKey('supervisor-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(2)
    expect(sessions.get('supervisor-metered-1')?.reservedMinutes).toBe(2)
    const settled = await settleGeminiLiveUsage({ sessionId: 'supervisor-metered-1', actualSeconds: 60 })
    expect(settled).toMatchObject({ ok: true, refundMinutes: 1 })
    expect(usages.get(usageKey('supervisor-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(1)
  })
})
