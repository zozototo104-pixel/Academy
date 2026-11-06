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

const month = () => new Date().toISOString().slice(0, 7)
const usageKey = (userId: string, m: string, purpose: string) => `${userId}:${m}:${purpose}`
const usages = new Map<string, UsageRow>()
const sessions = new Map<string, SessionRow>()
let credits: CreditRow[] = []
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
      Object.assign(row, data)
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
