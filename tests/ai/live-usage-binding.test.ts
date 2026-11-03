/// <reference types="bun-types" />
// حراس ربط جلسات Gemini Live بصاحبها (فحص 2026-10-30، بند الدقائق):
// - التسوية لصاحب الجلسة فقط، والمستهلك من ساعة الخادم لا من ادعاء العميل.
// - معرّف جلسة من العميل لا يُبعث بعد انتهائه ولا يُستعمل من حساب آخر.
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type UsageRow = { id: string; userId: string; month: string; purpose: string; freeMinutesUsed: number; paidMinutesUsed: number; sessionsCount: number; lastSessionAt?: Date | null }
type CreditRow = { id: string; userId: string; minutes?: number; remainingMinutes: number; status: string; source?: string; paymentId?: string | null; expiresAt?: Date | null }
type SessionRow = {
  id: string; sessionId: string; userId: string; month: string; purpose: string; status: string
  reservedMinutes: number; freeReserved: number; paidReserved: number
  actualMinutes?: number | null; settledAt?: Date | null; startedAt?: Date; createdAt?: Date; expiresAt: Date
}

const month = () => new Date().toISOString().slice(0, 7)
const usageKey = (userId: string, m: string, purpose: string) => `${userId}:${m}:${purpose}`
const usages = new Map<string, UsageRow>()
const sessions = new Map<string, SessionRow>()
let credits: CreditRow[] = []
const paidInvoices = new Map<string, { id: string; userId: string; status: string }>()
let transactionQueue: Promise<void> = Promise.resolve()

function updateNumber(current: number, change: any): number {
  if (typeof change === 'number') return change
  if (change?.increment !== undefined) return current + Number(change.increment)
  if (change?.decrement !== undefined) return current - Number(change.decrement)
  return current
}

const db: any = {
  $transaction: async (work: (tx: any) => Promise<any>) => {
    // Mimic the ordering guarantee of PostgreSQL FOR UPDATE for concurrent grant callers.
    const previous = transactionQueue
    let release!: () => void
    transactionQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await work(db) } finally { release() }
  },
  $queryRaw: async (_strings: TemplateStringsArray, paymentId: string) => {
    const payment = paidInvoices.get(paymentId)
    return payment ? [{ ...payment }] : []
  },
  enrollment: { count: async () => 0 },
  aiLiveUsage: {
    findUnique: async ({ where }: any) => {
      const w = where.userId_month_purpose
      return usages.get(usageKey(w.userId, w.month, w.purpose)) || null
    },
    upsert: async ({ where, create }: any) => {
      const w = where.userId_month_purpose
      const key = usageKey(w.userId, w.month, w.purpose)
      if (!usages.has(key)) usages.set(key, { id: `usage-${usages.size + 1}`, userId: create.userId, month: create.month, purpose: create.purpose, freeMinutesUsed: 0, paidMinutesUsed: 0, sessionsCount: 0 })
      return usages.get(key)
    },
    update: async ({ where, data }: any) => {
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
    findMany: async ({ where }: any) => credits.filter((row) => row.userId === where.userId && row.status === 'ACTIVE' && row.remainingMinutes > 0),
    findFirst: async ({ where }: any) => credits.find((row) => row.paymentId === where.paymentId) || null,
    update: async ({ where, data }: any) => {
      const row = credits.find((item) => item.id === where.id)
      if (!row) throw new Error('credit not found')
      Object.assign(row, data)
      return row
    },
    create: async ({ data }: any) => {
      const row: CreditRow = { id: `credit-${credits.length + 1}`, status: 'ACTIVE', ...data }
      credits.push(row)
      return row
    },
  },
  aiLiveSession: {
    findUnique: async ({ where }: any) => sessions.get(where.sessionId) || [...sessions.values()].find((row) => row.id === where.id) || null,
    findMany: async () => [],
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

mock.module('@/lib/db', () => ({ db }))

const { reserveGeminiLiveUsage, settleGeminiLiveUsage, grantGeminiLiveCredit } = await import('../../src/lib/live-usage-guard')

function seedUsage(userId: string, patch: Partial<UsageRow> = {}) {
  const row: UsageRow = { id: `usage-${userId}`, userId, month: month(), purpose: 'SUPERVISOR', freeMinutesUsed: 0, paidMinutesUsed: 0, sessionsCount: 0, ...patch }
  usages.set(usageKey(userId, row.month, row.purpose), row)
  return row
}

function seedSession(patch: Partial<SessionRow> & { sessionId: string }): SessionRow {
  const row: SessionRow = {
    id: `session-${sessions.size + 1}`, userId: 'stu-1', month: month(), purpose: 'SUPERVISOR', status: 'RESERVED',
    reservedMinutes: 2, freeReserved: 2, paidReserved: 0, actualMinutes: null, settledAt: null,
    startedAt: new Date(), createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ...patch,
  }
  sessions.set(row.sessionId, row)
  return row
}

beforeEach(() => {
  usages.clear()
  sessions.clear()
  credits = []
  paidInvoices.clear()
  transactionQueue = Promise.resolve()
  process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT = '30'
})

describe('تسوية الجلسة: ملكية + ساعة الخادم', () => {
  test('غير صاحب الجلسة لا يستطيع تسويتها', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    const s = seedSession({ sessionId: 's-owner' })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-2', sessionId: 's-owner', actualMinutes: 0 })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    expect(s.status).toBe('RESERVED')
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(2)
    expect(credits.length).toBe(0)
  })

  test('ادعاء «صفر دقائق» بعد جلسة كاملة لا يسترجع شيئاً', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 's-full', startedAt: new Date(Date.now() - 90 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-full', actualMinutes: 0 })
    expect(res.ok).toBe(true)
    expect(res.refundMinutes).toBe(0)
    expect(res.session.actualMinutes).toBe(2)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(2)
  })

  test('إنهاء مبكر يسترجع الباقي بساعة الخادم لا بادعاء العميل', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 's-early', startedAt: new Date(Date.now() - 20 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-early', actualMinutes: 2 })
    expect(res.ok).toBe(true)
    expect(res.session.actualMinutes).toBe(1)
    expect(res.refundMinutes).toBe(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(1)
  })

  test('الاسترجاع المدفوع يعود كرصيد بمقدار ساعة الخادم فقط', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 0, paidMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 's-paid', freeReserved: 0, paidReserved: 2, startedAt: new Date(Date.now() - 20 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-paid', actualMinutes: 0 })
    expect(res.refundMinutes).toBe(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.paidMinutesUsed).toBe(1)
    const refund = credits.find((c) => c.source === 'REFUND')
    expect(refund?.remainingMinutes).toBe(1)
  })
})

describe('منح دقائق الصوت المشتراة لا يتكرر عند الدفع المتزامن أو الإعادة', () => {
  test('محاولتان متزامنتان على فاتورة واحدة تمنحان رصيداً واحداً فقط', async () => {
    paidInvoices.set('invoice-1', { id: 'invoice-1', userId: 'stu-1', status: 'PAID' })
    const [first, second] = await Promise.all([
      grantGeminiLiveCredit({ userId: 'stu-1', minutes: 30, paymentId: 'invoice-1', source: 'PURCHASE' }),
      grantGeminiLiveCredit({ userId: 'stu-1', minutes: 30, paymentId: 'invoice-1', source: 'PURCHASE' }),
    ])
    expect([first.newlyGranted, second.newlyGranted].sort()).toEqual([false, true])
    expect(credits.filter((credit) => credit.paymentId === 'invoice-1')).toHaveLength(1)
    expect(credits[0].remainingMinutes).toBe(30)
    const replay = await grantGeminiLiveCredit({ userId: 'stu-1', minutes: 30, paymentId: 'invoice-1', source: 'PURCHASE' })
    expect(replay.newlyGranted).toBe(false)
    expect(credits).toHaveLength(1)
  })

  test('فاتورة غير مدفوعة أو مملوكة لحساب آخر لا تمنح أي دقيقة', async () => {
    paidInvoices.set('invoice-2', { id: 'invoice-2', userId: 'stu-1', status: 'UNPAID' })
    await expect(grantGeminiLiveCredit({ userId: 'stu-1', minutes: 30, paymentId: 'invoice-2', source: 'PURCHASE' }))
      .rejects.toThrow('LIVE_CREDIT_PAYMENT_NOT_SETTLED_OR_OWNER_MISMATCH')
    paidInvoices.set('invoice-2', { id: 'invoice-2', userId: 'stu-1', status: 'PAID' })
    await expect(grantGeminiLiveCredit({ userId: 'stu-2', minutes: 30, paymentId: 'invoice-2', source: 'PURCHASE' }))
      .rejects.toThrow('LIVE_CREDIT_PAYMENT_NOT_SETTLED_OR_OWNER_MISMATCH')
    expect(credits).toHaveLength(0)
  })

  test('منحة إدارية مستقلة بلا فاتورة تبقى مسموحة', async () => {
    const grant = await grantGeminiLiveCredit({ userId: 'stu-1', minutes: 5, source: 'ADMIN_GRANT' })
    expect(grant.newlyGranted).toBe(true)
    expect(grant.remainingMinutes).toBe(5)
  })
})

describe('حجز الجلسة: معرّف العميل لا يُبعث ولا يُسرق', () => {
  test('إعادة استعمال معرّف جلسة مسوّاة = حجز جديد بمعرّف جديد وبخصم جديد', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 's-done', status: 'SETTLED', actualMinutes: 2 })
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2, sessionId: 's-done' })
    expect(res.ok).toBe(true)
    expect(res.sessionId).not.toBe('s-done')
    expect(sessions.get(res.sessionId)?.status).toBe('RESERVED')
    expect(sessions.get('s-done')?.status).toBe('SETTLED')
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.sessionsCount).toBe(2)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(4)
  })

  test('معرّف جلسة طالب آخر = تعارض 409 وبلا أي أثر', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 's-victim' })
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-2', role: 'STUDENT', requestedMinutes: 2, sessionId: 's-victim' })
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(sessions.size).toBe(1)
    expect(usages.has(usageKey('stu-2', month(), 'SUPERVISOR'))).toBe(false)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(2)
  })

  test('استئناف نفس الجلسة المحجوزة غير المنتهية يبقى مسموحاً وبلا خصم إضافي', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 's-live' })
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2, sessionId: 's-live' })
    expect(res.ok).toBe(true)
    expect(res.sessionId).toBe('s-live')
    expect(sessions.size).toBe(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.sessionsCount).toBe(1)
  })

  test('جلسة محجوزة منتهية الصلاحية تُسترد ثم يُحجز بمعرّف جديد', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    const old = seedSession({ sessionId: 's-stale', expiresAt: new Date(Date.now() - 60 * 1000) })
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2, sessionId: 's-stale' })
    expect(res.ok).toBe(true)
    expect(res.sessionId).not.toBe('s-stale')
    expect(old.status).toBe('REFUNDED')
    // الاسترداد (‎-2) ثم الحجز الجديد (+2): المحصلة 2 لا 4 — لا حجز مزدوج
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(2)
  })
})
