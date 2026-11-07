/// <reference types="bun-types" />
// حراس ربط جلسات Gemini Live بصاحبها (فحص 2026-10-30، بند الدقائق):
// - التسوية لصاحب الجلسة فقط، والمستهلك من ساعة الخادم لا من ادعاء العميل.
// - معرّف جلسة من العميل لا يُبعث بعد انتهائه ولا يُستعمل من حساب آخر.
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type UsageRow = { id: string; userId: string; month: string; purpose: string; freeMinutesUsed: number; paidMinutesUsed: number; sessionsCount: number; lastSessionAt?: Date | null }
type CreditRow = { id: string; userId: string; minutes?: number; remainingMinutes: number; status: string; source?: string; paymentId?: string | null; expiresAt?: Date | null; createdAt?: Date }
type SessionRow = {
  id: string; sessionId: string; userId: string; month: string; purpose: string; status: string
  reservedMinutes: number; freeReserved: number; paidReserved: number
  actualMinutes?: number | null; settledAt?: Date | null; startedAt?: Date; createdAt?: Date; expiresAt: Date
}

type AllocationRow = { id: string; sessionId: string; creditId: string | null; minutesReserved: number; minutesUsed: number; minutesRefunded: number; createdAt?: Date }

const month = () => new Date().toISOString().slice(0, 7)
const usageKey = (userId: string, m: string, purpose: string) => `${userId}:${m}:${purpose}`
const usages = new Map<string, UsageRow>()
const sessions = new Map<string, SessionRow>()
let credits: CreditRow[] = []
let allocations: AllocationRow[] = []
const paidInvoices = new Map<string, { id: string; userId: string; status: string }>()
let transactionQueue: Promise<void> = Promise.resolve()
const queriedRowLocks: string[] = []

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
  $queryRaw: async (strings: TemplateStringsArray, paymentId: string) => {
    const query = strings.join(' ')
    if (query.includes('FOR UPDATE')) queriedRowLocks.push(query)
    if (!query.includes('"Payment"')) return []
    const payment = paidInvoices.get(paymentId)
    return payment ? [{ ...payment }] : []
  },
  enrollment: { count: async () => 0 },
  user: { findUnique: async () => ({ role: 'STUDENT' }) },
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
    // محاكاة مشروطة بالاستعلام: تطبّق فقط الشروط الموجودة في where فعلاً
    // (الحالة/المتبقي لاستعلامات الرصيد النشط، وcreatedAt/expiresAt لبحث
    // مسبح الاسترداد) مع orderBy وtake — حتى تُختبَر وراثة الانتهاء بصدق.
    findMany: async ({ where, orderBy, take }: any) => {
      let rows = credits.filter((row) => {
        if (where.userId && row.userId !== where.userId) return false
        if (where.status && (typeof where.status === 'string'
          ? row.status !== where.status : !where.status.in?.includes(row.status))) return false
        if (where.remainingMinutes?.gt !== undefined && !(row.remainingMinutes > where.remainingMinutes.gt)) return false
        if (where.createdAt?.lte && !(row.createdAt && new Date(row.createdAt).getTime() <= new Date(where.createdAt.lte).getTime())) return false
        if (where.expiresAt?.not === null && (row.expiresAt === null || row.expiresAt === undefined)) return false
        if (where.expiresAt?.gt && !(row.expiresAt && new Date(row.expiresAt).getTime() > new Date(where.expiresAt.gt).getTime())) return false
        if (where.OR && !where.OR.some((part: any) =>
          (part.expiresAt === null && (row.expiresAt === null || row.expiresAt === undefined))
          || (part.expiresAt?.gt && row.expiresAt && new Date(row.expiresAt).getTime() > new Date(part.expiresAt.gt).getTime()))) return false
        return true
      })
      if (Array.isArray(orderBy)) {
        rows = [...rows].sort((a, b) => {
          for (const o of orderBy) {
            if (o?.expiresAt === 'asc') {
              const av = a.expiresAt ? new Date(a.expiresAt).getTime() : Number.POSITIVE_INFINITY
              const bv = b.expiresAt ? new Date(b.expiresAt).getTime() : Number.POSITIVE_INFINITY
              if (av !== bv) return av - bv
            }
            if (o?.createdAt === 'asc') {
              const av = a.createdAt ? new Date(a.createdAt).getTime() : 0
              const bv = b.createdAt ? new Date(b.createdAt).getTime() : 0
              if (av !== bv) return av - bv
            }
          }
          return 0
        })
      }
      return take ? rows.slice(0, take) : rows
    },
    findFirst: async ({ where }: any) => credits.find((row) => row.paymentId === where.paymentId) || null,
    update: async ({ where, data }: any) => {
      const row = credits.find((item) => item.id === where.id)
      if (!row) throw new Error('credit not found')
      // E01: استرداد التخصيص يزيد المتبقي بـ increment — المحاكاة تطبّقه
      // رقميًا كما يفعل العميل الحقيقي (بقية الحقول تعيين مباشر).
      const { remainingMinutes, ...rest } = data
      if (remainingMinutes !== undefined) row.remainingMinutes = updateNumber(row.remainingMinutes, remainingMinutes)
      Object.assign(row, rest)
      return row
    },
    create: async ({ data }: any) => {
      const row: CreditRow = { id: `credit-${credits.length + 1}`, status: 'ACTIVE', createdAt: new Date(), ...data }
      credits.push(row)
      return row
    },
  },
  aiLiveSession: {
    findUnique: async ({ where }: any) => sessions.get(where.sessionId) || [...sessions.values()].find((row) => row.id === where.id) || null,
    // كنس الجلسات المنتهية يبحث بـ status + expiresAt { lt } مع take.
    findMany: async ({ where, take }: any) => {
      let rows = [...sessions.values()]
      if (where?.status) rows = rows.filter((row) => row.status === where.status)
      if (where?.expiresAt?.lt) rows = rows.filter((row) => new Date(row.expiresAt).getTime() < new Date(where.expiresAt.lt).getTime())
      return take ? rows.slice(0, take) : rows
    },
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
    updateMany: async ({ where, data }: any) => {
      let count = 0
      for (const row of sessions.values()) {
        if (where.id && row.id !== where.id) continue
        if (where.status && row.status !== where.status) continue
        if (where.expiresAt?.lt && !(row.expiresAt < where.expiresAt.lt)) continue
        Object.assign(row, data)
        count++
      }
      return { count }
    },
  },
  // E01: دفتر التخصيص — محاكاة كاملة (إنشاء/دمج/قراءة مع ربط الرصيد/
  // تحديث رقمي) حتى تُختبَر نسبة كل دقيقة لمصدرها بصدق.
  aiLiveCreditAllocation: {
    create: async ({ data }: any) => {
      const row: AllocationRow = { id: `alloc-${allocations.length + 1}`, creditId: null, minutesUsed: 0, minutesRefunded: 0, createdAt: new Date(), ...data }
      allocations.push(row)
      return row
    },
    findFirst: async ({ where }: any) =>
      allocations.find((row) => row.sessionId === where.sessionId && (row.creditId ?? null) === (where.creditId ?? null)) || null,
    findMany: async ({ where, include }: any) => {
      let rows = allocations.filter((row) => !where?.sessionId || row.sessionId === where.sessionId)
      if (include?.credit) {
        rows = rows.map((row) => ({ ...row, credit: row.creditId ? credits.find((c) => c.id === row.creditId) || null : null } as any))
      }
      return rows
    },
    update: async ({ where, data }: any) => {
      const row = allocations.find((item) => item.id === where.id)
      if (!row) throw new Error('allocation not found')
      for (const key of ['minutesReserved', 'minutesUsed', 'minutesRefunded'] as const) {
        if (data[key] !== undefined) row[key] = updateNumber(row[key], data[key])
      }
      return row
    },
  },
}

mock.module('@/lib/db', () => ({ db }))

const { reserveGeminiLiveUsage, settleGeminiLiveUsage, grantGeminiLiveCredit, getGeminiLiveAllowance, refundExpiredGeminiLiveSessions } = await import('../../src/lib/live-usage-guard')

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
  allocations = []
  paidInvoices.clear()
  transactionQueue = Promise.resolve()
  queriedRowLocks.length = 0
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

describe('حماية محاسبة الصوت من التزامن', () => {
  test('تسويتان متزامنتان لنفس الجلسة: استرداد واحد وتصبح الثانية idempotent', async () => {
    seedUsage('stu-1', { paidMinutesUsed: 2, sessionsCount: 1 })
    seedSession({ sessionId: 'concurrent-settle', freeReserved: 0, paidReserved: 2, startedAt: new Date(Date.now() - 20_000) })
    const [first, second]: any[] = await Promise.all([
      settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 'concurrent-settle', actualMinutes: 0 }),
      settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 'concurrent-settle', actualMinutes: 0 }),
    ])
    expect(first.ok && second.ok).toBe(true)
    expect([first, second].filter((result) => result.idempotent)).toHaveLength(1)
    expect(credits.filter((row) => row.source === 'REFUND')).toHaveLength(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.paidMinutesUsed).toBe(1)
    expect(queriedRowLocks.some((sql) => sql.includes('"AiLiveSession"'))).toBe(true)
    expect(queriedRowLocks.some((sql) => sql.includes('"User"'))).toBe(true)
  })

  test('حجزان متزامنان لا يتجاوزان آخر دقيقة مجانية', async () => {
    process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT = '1'
    const [first, second]: any[] = await Promise.all([
      reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 }),
      reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 }),
    ])
    expect([first, second].filter((result) => result.ok)).toHaveLength(1)
    expect([first, second].find((result) => result.ok)?.sessionLimitMinutes).toBe(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(1)
    expect(sessions.size).toBe(1)
    expect(queriedRowLocks.some((sql) => sql.includes('"AiLiveUsage"'))).toBe(true)
  })

  test('الكنس لا يستبدل نتيجة تسوية تمت بعد قراءة قائمة الجلسات', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 1, sessionsCount: 1 })
    const session = seedSession({ sessionId: 'stale-sweep-candidate', expiresAt: new Date(Date.now() - 1000) })
    const originalFindMany = db.aiLiveSession.findMany
    db.aiLiveSession.findMany = async (args: any) => {
      const candidate = await originalFindMany(args)
      session.status = 'SETTLED'
      session.actualMinutes = 1
      return candidate
    }
    try {
      const result: any = await refundExpiredGeminiLiveSessions(new Date())
      expect(result.sessions).toBe(0)
      expect(result.charged).toBe(0)
      expect(session.actualMinutes).toBe(1)
    } finally {
      db.aiLiveSession.findMany = originalFindMany
    }
  })
})

describe('تسوية الجلسة: تجاوز الحجز يُخصم من الرصيد المتبقي', () => {
  test('مكالمة أطول من الحجز تُخصم كاملة من الرصيد المجاني المتبقي', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    // بدأت قبل 12.5 دقيقة: المنقضي بساعة الخادم 13 دقيقة والحجز دقيقتان فقط
    seedSession({ sessionId: 's-over', startedAt: new Date(Date.now() - 12.5 * 60 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-over', actualMinutes: 0 })
    expect(res.ok).toBe(true)
    expect(res.extraChargedMinutes).toBe(11)
    expect(res.refundMinutes).toBe(0)
    expect(res.session.actualMinutes).toBe(13)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(13)
  })

  test('الخصم الإضافي يقف عند حدود الرصيد ولا يخلق رصيدًا سالبًا', async () => {
    process.env.AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT = '5'
    seedUsage('stu-1', { freeMinutesUsed: 2, paidMinutesUsed: 0, sessionsCount: 1 })
    credits.push({ id: 'credit-cap', userId: 'stu-1', remainingMinutes: 4, status: 'ACTIVE' })
    seedSession({ sessionId: 's-capped', startedAt: new Date(Date.now() - 12.5 * 60 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-capped', actualMinutes: 0 })
    // المتاح فوق الحجز: 3 مجاني (5-2) + 4 مدفوع = 7 من أصل 11 دقيقة متجاوزة
    expect(res.extraChargedMinutes).toBe(7)
    expect(res.session.actualMinutes).toBe(9)
    const usage = usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))
    expect(usage?.freeMinutesUsed).toBe(5)
    expect(usage?.paidMinutesUsed).toBe(4)
    const credit = credits.find((c) => c.id === 'credit-cap')
    expect(credit?.remainingMinutes).toBe(0)
    expect(credit?.status).toBe('CONSUMED')
  })
})

describe('إصلاح U10/M8: التسوية لا تُحاسَب أبعد من نهاية الجلسة المصرّح بها', () => {
  test('تسوية تصل بعد 3 ساعات على جلسة حدّها 10 دقائق تُحاسَب حتى الانتهاء + السماح فقط', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
    // نهاية الجلسة المصرّح بها كما يخزّنها الحجز = بدايتها + حدّ الطالب (10 دقائق)
    seedSession({ sessionId: 's-late-cap', startedAt, createdAt: startedAt, expiresAt: new Date(startedAt.getTime() + 10 * 60 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-late-cap', actualMinutes: 0 })
    expect(res.ok).toBe(true)
    // المنقضي المحاسَب = 10 (حتى الانتهاء) + 2 (سماح التسوية) = 12، لا ساعات الجدار كاملة
    expect(res.session.actualMinutes).toBe(12)
    expect(res.extraChargedMinutes).toBe(10)
    expect(res.refundMinutes).toBe(0)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(12)
  })

  test('تسوية داخل النافذة المصرّح بها تبقى كما هي بالدقيقة', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    const startedAt = new Date(Date.now() - 7.5 * 60 * 1000)
    seedSession({ sessionId: 's-in-window', startedAt, createdAt: startedAt, expiresAt: new Date(startedAt.getTime() + 10 * 60 * 1000) })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-in-window', actualMinutes: 0 })
    expect(res.ok).toBe(true)
    expect(res.session.actualMinutes).toBe(8)
    expect(res.extraChargedMinutes).toBe(6)
    expect(res.refundMinutes).toBe(0)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(8)
  })

  test('جلسة بلا expiresAt مخزّن ترجع إلى حدّ الجلسة من مسار الإصدار نفسه', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    const startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000)
    seedSession({ sessionId: 's-null-expiry', startedAt, createdAt: startedAt, expiresAt: null as any })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-null-expiry', actualMinutes: 0 })
    expect(res.ok).toBe(true)
    // السقف يُبنى من حدّ مسار الإصدار لدور الطالب وغرض المشرف (10) + السماح (2)
    expect(res.session.actualMinutes).toBe(12)
    expect(res.extraChargedMinutes).toBe(10)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(12)
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

  test('جلسة محجوزة منتهية الصلاحية تُحاسَب على حجزها ثم يُحجز بمعرّف جديد', async () => {
    // تغيّرت السياسة بإصلاح تدقيق 2026-11-06: الجلسة المنتهية التي لم
    // تُسوَّ لا تُسترد — تُحاسَب على محجوزها كاملاً (status SETTLED)
    // حتى لا تكون جلسة «بلا تسوية» مجانية. قصد الحارس الأصلي محفوظ:
    // لا حجز مزدوج لنفس المعرّف، والحجز الجديد بمعرّف جديد وبخصم جديد.
    seedUsage('stu-1', { freeMinutesUsed: 2, sessionsCount: 1 })
    const old = seedSession({ sessionId: 's-stale', expiresAt: new Date(Date.now() - 60 * 1000) })
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2, sessionId: 's-stale' })
    expect(res.ok).toBe(true)
    expect(res.sessionId).not.toBe('s-stale')
    expect(old.status).toBe('SETTLED')
    expect(old.actualMinutes).toBe(2)
    // المحاسبة على القديم (تبقى 2 محسوبة) + الحجز الجديد (+2) = 4
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.freeMinutesUsed).toBe(4)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.sessionsCount).toBe(2)
  })
})

describe('إصلاحات تدقيق 2026-11-06: محاسبة المنتهي + وراثة الانتهاء + سقف الرصيد الصفري', () => {
  test('كنس الجلسات المنتهية: غير المُسوّاة تُحاسَب على حجزها ولا يُسترد منها شيء', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 2, paidMinutesUsed: 2, sessionsCount: 2 })
    const freeExpired = seedSession({ sessionId: 's-exp-free', expiresAt: new Date(Date.now() - 5 * 60 * 1000) })
    const paidExpired = seedSession({ sessionId: 's-exp-paid', freeReserved: 0, paidReserved: 2, expiresAt: new Date(Date.now() - 5 * 60 * 1000) })
    const stillLive = seedSession({ sessionId: 's-still-live' })
    const alreadyDone = seedSession({ sessionId: 's-done-old', status: 'SETTLED', actualMinutes: 2, expiresAt: new Date(Date.now() - 5 * 60 * 1000) })
    const res: any = await refundExpiredGeminiLiveSessions(new Date())
    expect(res.sessions).toBe(2)
    expect(res.refunded).toBe(0)
    expect(res.charged).toBe(4)
    expect(freeExpired.status).toBe('SETTLED')
    expect(freeExpired.actualMinutes).toBe(2)
    expect(paidExpired.status).toBe('SETTLED')
    expect(paidExpired.actualMinutes).toBe(2)
    expect(stillLive.status).toBe('RESERVED')
    expect(alreadyDone.actualMinutes).toBe(2)
    // لا أرصدة استرداد تولد، وعدّاد الاستخدام لا يتراجع عن المحجوز.
    expect(credits.filter((c) => c.source === 'REFUND')).toHaveLength(0)
    const usage = usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))
    expect(usage?.freeMinutesUsed).toBe(2)
    expect(usage?.paidMinutesUsed).toBe(2)
  })

  test('الاسترداد المدفوع يرث أقرب انتهاء من مسبح ما قبل بدء الجلسة', async () => {
    const startedAt = new Date(Date.now() - 20 * 1000)
    const earliest = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000)
    const later = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const afterStartEarlier = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
    seedUsage('stu-1', { freeMinutesUsed: 0, paidMinutesUsed: 2, sessionsCount: 1 })
    // رصيدان قبل بدء الجلسة بانتهاءين مختلفين + رصيد أبكر انتهاءً لكنه
    // وُلد بعد بدء الجلسة فلا يدخل المسبح (مرساة بدء الجلسة).
    credits.push({ id: 'pool-late', userId: 'stu-1', remainingMinutes: 10, status: 'ACTIVE', createdAt: new Date(startedAt.getTime() - 48 * 60 * 60 * 1000), expiresAt: later })
    credits.push({ id: 'pool-early', userId: 'stu-1', remainingMinutes: 10, status: 'ACTIVE', createdAt: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000), expiresAt: earliest })
    credits.push({ id: 'pool-after', userId: 'stu-1', remainingMinutes: 10, status: 'ACTIVE', createdAt: new Date(startedAt.getTime() + 60 * 1000), expiresAt: afterStartEarlier })
    seedSession({ sessionId: 's-paid-expiry', freeReserved: 0, paidReserved: 2, startedAt })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-paid-expiry', actualMinutes: 0 })
    expect(res.refundMinutes).toBe(1)
    const refund = credits.find((c) => c.source === 'REFUND')
    expect(refund?.remainingMinutes).toBe(1)
    expect(refund?.expiresAt?.getTime()).toBe(earliest.getTime())
  })

  test('رصيد تاريخي انتهى قبل بدء الجلسة لا يحدد تاريخ انتهاء الاسترداد', async () => {
    const startedAt = new Date(Date.now() - 20 * 1000)
    const validExpiry = new Date(Date.now() + 12 * 24 * 60 * 60 * 1000)
    seedUsage('stu-1', { freeMinutesUsed: 0, paidMinutesUsed: 2, sessionsCount: 1 })
    credits.push({ id: 'historical-expired', userId: 'stu-1', remainingMinutes: 0, status: 'CONSUMED',
      createdAt: new Date(startedAt.getTime() - 90 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(startedAt.getTime() - 30 * 24 * 60 * 60 * 1000) })
    credits.push({ id: 'real-source', userId: 'stu-1', remainingMinutes: 1, status: 'ACTIVE',
      createdAt: new Date(startedAt.getTime() - 2 * 24 * 60 * 60 * 1000), expiresAt: validExpiry })
    seedSession({ sessionId: 's-exclude-expired', freeReserved: 0, paidReserved: 2, startedAt })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-exclude-expired', actualMinutes: 0 })
    expect(res.refundMinutes).toBe(1)
    const refund = credits.find((c) => c.source === 'REFUND')
    expect(refund?.expiresAt?.getTime()).toBe(validExpiry.getTime())
  })

  test('بلا أي انتهاء في مسبح الشراء يبقى الاسترداد بلا انتهاء وفاءً لمصدره الدائم', async () => {
    const startedAt = new Date(Date.now() - 20 * 1000)
    seedUsage('stu-1', { freeMinutesUsed: 0, paidMinutesUsed: 2, sessionsCount: 1 })
    credits.push({ id: 'pool-forever', userId: 'stu-1', remainingMinutes: 10, status: 'ACTIVE', createdAt: new Date(startedAt.getTime() - 24 * 60 * 60 * 1000), expiresAt: null })
    seedSession({ sessionId: 's-paid-forever', freeReserved: 0, paidReserved: 2, startedAt })
    const res: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: 's-paid-forever', actualMinutes: 0 })
    expect(res.refundMinutes).toBe(1)
    const refund = credits.find((c) => c.source === 'REFUND')
    expect(refund?.expiresAt ?? null).toBeNull()
  })

  test('رصيد صفري: قرار السماح يرفض وسقف الجلسة صفر لا السقف الكامل', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30, sessionsCount: 3 })
    const decision: any = await getGeminiLiveAllowance({ userId: 'stu-1', role: 'STUDENT' })
    expect(decision.ok).toBe(false)
    expect(decision.status).toBe(402)
    expect(decision.totalRemainingMinutes).toBe(0)
    expect(decision.sessionLimitMinutes).toBe(0)
  })

  test('رصيد جزئي: سقف الجلسة هو المتبقي لا السقف الكامل', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 28, sessionsCount: 3 })
    const decision: any = await getGeminiLiveAllowance({ userId: 'stu-1', role: 'STUDENT' })
    expect(decision.ok).toBe(true)
    expect(decision.sessionLimitMinutes).toBe(2)
  })
})

describe('دفتر تخصيص الدقائق E01: كل دقيقة تعود لمصدرها', () => {
  const day = 24 * 60 * 60 * 1000
  function ageSession(sessionId: string, msAgo: number) {
    const row = [...sessions.values()].find((s) => s.sessionId === sessionId)
    if (!row) throw new Error('session missing')
    row.startedAt = new Date(Date.now() - msAgo)
    return row
  }

  test('حالة القبول المسماة: رصيد مستهلَك ينتهي غدًا لا يقصّر استرداد دقيقة موّلها رصيد 30 يومًا', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30 })
    credits = [
      { id: 'c-old', userId: 'stu-1', minutes: 5, remainingMinutes: 0, status: 'CONSUMED', source: 'PURCHASE', expiresAt: new Date(Date.now() + day), createdAt: new Date(Date.now() - 10 * day) },
      { id: 'c-30', userId: 'stu-1', minutes: 10, remainingMinutes: 10, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30 * day), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    expect(res.ok).toBe(true)
    expect(credits.find((c) => c.id === 'c-30')?.remainingMinutes).toBe(8)
    expect(allocations).toHaveLength(1)
    expect(allocations[0].creditId).toBe('c-30')
    expect(allocations[0].minutesReserved).toBe(2)
    ageSession(res.sessionId, 20_000)
    const settled: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    expect(settled.ok).toBe(true)
    expect(settled.refundMinutes).toBe(1)
    // الدقيقة عادت إلى رصيد الثلاثين يومًا نفسه — لا رصيد REFUND مولّد،
    // والرصيد المستهلَك المنتهي غدًا لم يُلمس ولم يقصّر شيئًا.
    expect(credits.find((c) => c.id === 'c-30')?.remainingMinutes).toBe(9)
    expect(credits.find((c) => c.id === 'c-30')?.status).toBe('ACTIVE')
    expect(credits.find((c) => c.id === 'c-old')?.remainingMinutes).toBe(0)
    expect(credits.filter((c) => c.source === 'REFUND')).toHaveLength(0)
    expect(credits).toHaveLength(2)
    expect(allocations[0].minutesUsed).toBe(1)
    expect(allocations[0].minutesRefunded).toBe(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.paidMinutesUsed).toBe(1)
  })

  test('تمويل مشترك من رصيدين: المسترد يعود ذيلًا لكل مصدر بحصته', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30 })
    credits = [
      { id: 'c-a', userId: 'stu-1', minutes: 1, remainingMinutes: 1, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 5 * day), createdAt: new Date(Date.now() - 2 * day) },
      { id: 'c-b', userId: 'stu-1', minutes: 5, remainingMinutes: 5, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30 * day), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    expect(res.ok).toBe(true)
    expect(allocations).toHaveLength(2)
    ageSession(res.sessionId, 20_000)
    const settled: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    expect(settled.refundMinutes).toBe(1)
    // المستعمل نُسب للأقدم سحبًا (A) والمسترد عاد إلى B وحده.
    const allocA = allocations.find((a) => a.creditId === 'c-a')
    const allocB = allocations.find((a) => a.creditId === 'c-b')
    expect(allocA?.minutesUsed).toBe(1)
    expect(allocA?.minutesRefunded).toBe(0)
    expect(allocB?.minutesUsed).toBe(0)
    expect(allocB?.minutesRefunded).toBe(1)
    expect(credits.find((c) => c.id === 'c-a')?.remainingMinutes).toBe(0)
    expect(credits.find((c) => c.id === 'c-b')?.remainingMinutes).toBe(5)
    expect(credits.filter((c) => c.source === 'REFUND')).toHaveLength(0)
  })

  test('تكرار تسوية نفس الجلسة لا يسترد مرتين', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30 })
    credits = [
      { id: 'c-30', userId: 'stu-1', minutes: 10, remainingMinutes: 10, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30 * day), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    ageSession(res.sessionId, 20_000)
    const first: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    const second: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    expect(first.refundMinutes).toBe(1)
    expect(second.idempotent).toBe(true)
    expect(credits.find((c) => c.id === 'c-30')?.remainingMinutes).toBe(9)
    expect(allocations[0].minutesRefunded).toBe(1)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.paidMinutesUsed).toBe(1)
  })

  test('شحن إضافي فوق الحجز يُنسب لمصدره ويُوسم مستخدمًا بالكامل', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30 })
    credits = [
      { id: 'c-b', userId: 'stu-1', minutes: 10, remainingMinutes: 10, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30 * day), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    ageSession(res.sessionId, 3.5 * 60 * 1000)
    const settled: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    expect(settled.extraChargedMinutes).toBe(2)
    expect(settled.session.actualMinutes).toBe(4)
    expect(settled.refundMinutes).toBe(0)
    expect(credits.find((c) => c.id === 'c-b')?.remainingMinutes).toBe(6)
    expect(allocations).toHaveLength(1)
    expect(allocations[0].minutesReserved).toBe(4)
    expect(allocations[0].minutesUsed).toBe(4)
    expect(allocations[0].minutesRefunded).toBe(0)
    expect(usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))?.paidMinutesUsed).toBe(4)
  })

  test('رصيد ينتهي أثناء الجلسة يستقبل مسترده منتهيًا — لا دائمًا ولا جديدًا', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30 })
    credits = [
      { id: 'c-x', userId: 'stu-1', minutes: 3, remainingMinutes: 3, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30_000), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    expect(credits.find((c) => c.id === 'c-x')?.remainingMinutes).toBe(1)
    // الوقت مرّ: الرصيد انتهى والجلسة عمرها 20 ثانية.
    credits[0].expiresAt = new Date(Date.now() - 1000)
    ageSession(res.sessionId, 20_000)
    const settled: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    expect(settled.refundMinutes).toBe(1)
    expect(credits.find((c) => c.id === 'c-x')?.remainingMinutes).toBe(2)
    expect(credits.find((c) => c.id === 'c-x')?.status).toBe('EXPIRED')
    expect(credits.filter((c) => c.source === 'REFUND')).toHaveLength(0)
  })

  test('كنس جلسة منتهية بلا تسوية يُقفل تخصيصها مستخدمًا كاملًا بلا استرداد', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 30 })
    credits = [
      { id: 'c-b', userId: 'stu-1', minutes: 10, remainingMinutes: 10, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30 * day), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    const row = [...sessions.values()].find((s) => s.sessionId === res.sessionId)
    if (!row) throw new Error('session missing')
    row.expiresAt = new Date(Date.now() - 1000)
    const sweep: any = await refundExpiredGeminiLiveSessions(new Date())
    expect(sweep.sessions).toBe(1)
    expect(sweep.charged).toBe(2)
    expect(row.status).toBe('SETTLED')
    expect(allocations[0].minutesUsed).toBe(2)
    expect(allocations[0].minutesRefunded).toBe(0)
    expect(credits.find((c) => c.id === 'c-b')?.remainingMinutes).toBe(8)
  })

  test('حجز مختلط مجاني+مدفوع: صفّان، والمجاني يُستهلك أولًا عند التسوية', async () => {
    seedUsage('stu-1', { freeMinutesUsed: 29 })
    credits = [
      { id: 'c-b', userId: 'stu-1', minutes: 5, remainingMinutes: 5, status: 'ACTIVE', source: 'PURCHASE', expiresAt: new Date(Date.now() + 30 * day), createdAt: new Date(Date.now() - day) },
    ]
    const res: any = await reserveGeminiLiveUsage({ userId: 'stu-1', role: 'STUDENT', requestedMinutes: 2 })
    expect(res.ok).toBe(true)
    expect(allocations).toHaveLength(2)
    expect(allocations.find((a) => a.creditId === null)?.minutesReserved).toBe(1)
    expect(allocations.find((a) => a.creditId === 'c-b')?.minutesReserved).toBe(1)
    ageSession(res.sessionId, 20_000)
    const settled: any = await settleGeminiLiveUsage({ userId: 'stu-1', sessionId: res.sessionId, actualMinutes: 0 })
    expect(settled.refundMinutes).toBe(1)
    // الدقيقة المستعملة من المجاني، والمستردة عادت إلى الرصيد المدفوع.
    expect(allocations.find((a) => a.creditId === null)?.minutesUsed).toBe(1)
    expect(allocations.find((a) => a.creditId === 'c-b')?.minutesRefunded).toBe(1)
    expect(credits.find((c) => c.id === 'c-b')?.remainingMinutes).toBe(5)
    const usage = usages.get(usageKey('stu-1', month(), 'SUPERVISOR'))
    expect(usage?.freeMinutesUsed).toBe(30)
    expect(usage?.paidMinutesUsed).toBe(0)
  })
})
