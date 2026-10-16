import { db } from '@/lib/db'

export type LivePurpose = 'SUPERVISOR' | 'DISCUSSION'

export interface LiveUsageDecision {
  ok: boolean
  status: number
  message?: string
  purpose: LivePurpose
  month: string
  freeMonthlyLimitMinutes: number
  sessionLimitMinutes: number
  usedFreeMinutes: number
  usedPaidMinutes: number
  paidRemainingMinutes: number
  totalRemainingMinutes: number
  sessionsUsed: number
  sessionId?: string
}

function envNum(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback
}

function monthKey(date = new Date()): string {
  return date.toISOString().slice(0, 7)
}

function roleName(role: unknown): string {
  return String(role || 'STUDENT').toUpperCase()
}

function purposeName(value: unknown): LivePurpose {
  const p = String(value || '').toUpperCase()
  return p === 'DISCUSSION' || p === 'DEFENSE' ? 'DISCUSSION' : 'SUPERVISOR'
}

function sessionIdValue(input?: string | null) {
  const v = String(input || '').trim()
  return v || `live_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}

async function hasActiveEnrollment(userId: string): Promise<boolean> {
  try {
    const count = await db.enrollment.count({ where: { userId, status: 'ACTIVE' } })
    return count > 0
  } catch {
    return false
  }
}

export async function freeMonthlyLiveMinutes(userId: string, role: unknown): Promise<number> {
  const r = roleName(role)
  if (r === 'ADMIN') return envNum('AACT_LIVE_FREE_MONTHLY_MINUTES_ADMIN', 1000)
  if (r === 'SUPERVISOR') return envNum('AACT_LIVE_FREE_MONTHLY_MINUTES_SUPERVISOR', 300)
  const active = await hasActiveEnrollment(userId)
  if (active) return envNum('AACT_LIVE_FREE_MONTHLY_MINUTES_ACTIVE_STUDENT', 60)
  return envNum('AACT_LIVE_FREE_MONTHLY_MINUTES_STUDENT', 30)
}

export function liveSessionLimitMinutes(role: unknown, purpose: LivePurpose): number {
  const r = roleName(role)
  if (purpose === 'DISCUSSION') return envNum('AACT_LIVE_DISCUSSION_SESSION_MAX_MINUTES', 30)
  if (r === 'ADMIN') return envNum('AACT_LIVE_SESSION_MAX_MINUTES_ADMIN', 30)
  if (r === 'SUPERVISOR') return envNum('AACT_LIVE_SESSION_MAX_MINUTES_SUPERVISOR', 20)
  return envNum('AACT_LIVE_SESSION_MAX_MINUTES_STUDENT', envNum('AACT_LIVE_SESSION_MAX_MINUTES', 10))
}

const ADMIN_UNLIMITED_LIVE_MINUTES = 999999

function adminLiveDecision(role: unknown, purpose: LivePurpose, month: string, sessionId?: string): LiveUsageDecision {
  return {
    ok: true,
    status: 200,
    purpose,
    month,
    freeMonthlyLimitMinutes: ADMIN_UNLIMITED_LIVE_MINUTES,
    sessionLimitMinutes: liveSessionLimitMinutes(role, purpose),
    usedFreeMinutes: 0,
    usedPaidMinutes: 0,
    paidRemainingMinutes: 0,
    totalRemainingMinutes: ADMIN_UNLIMITED_LIVE_MINUTES,
    sessionsUsed: 0,
    ...(sessionId ? { sessionId } : {}),
  }
}

async function activePaidCredits(userId: string, now: Date) {
  return db.aiLiveCredit.findMany({
    where: {
      userId,
      status: 'ACTIVE',
      remainingMinutes: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
  })
}

export async function getGeminiLiveAllowance(input: {
  userId: string
  role: unknown
  purpose?: LivePurpose | string
}): Promise<LiveUsageDecision> {
  const purpose = purposeName(input.purpose)
  const month = monthKey()
  if (roleName(input.role) === 'ADMIN') return adminLiveDecision(input.role, purpose, month)

  const freeMonthlyLimitMinutes = await freeMonthlyLiveMinutes(input.userId, input.role)
  const sessionLimitMinutes = liveSessionLimitMinutes(input.role, purpose)
  const now = new Date()

  const [usage, credits] = await Promise.all([
    db.aiLiveUsage.findUnique({ where: { userId_month_purpose: { userId: input.userId, month, purpose } } }).catch(() => null),
    activePaidCredits(input.userId, now).catch(() => []),
  ])

  const usedFreeMinutes = usage?.freeMinutesUsed || 0
  const usedPaidMinutes = usage?.paidMinutesUsed || 0
  const paidRemainingMinutes = credits.reduce((sum, c) => sum + Math.max(0, c.remainingMinutes), 0)
  const freeRemaining = Math.max(0, freeMonthlyLimitMinutes - usedFreeMinutes)
  const totalRemainingMinutes = freeRemaining + paidRemainingMinutes
  const cappedSessionLimit = Math.min(sessionLimitMinutes, totalRemainingMinutes)

  return {
    ok: totalRemainingMinutes > 0 && cappedSessionLimit > 0,
    status: totalRemainingMinutes > 0 ? 200 : 402,
    message: totalRemainingMinutes > 0
      ? undefined
      : 'انتهت دقائق Gemini Live المجانية والإضافية لهذا الشهر. يمكنك استخدام المشرف النصي أو شراء دقائق صوت إضافية عند تفعيل الباقات.',
    purpose,
    month,
    freeMonthlyLimitMinutes,
    sessionLimitMinutes: cappedSessionLimit || sessionLimitMinutes,
    usedFreeMinutes,
    usedPaidMinutes,
    paidRemainingMinutes,
    totalRemainingMinutes,
    sessionsUsed: usage?.sessionsCount || 0,
  }
}

async function refundReserved(tx: any, session: any, minutes: number) {
  const refund = Math.max(0, Math.min(Math.floor(minutes || 0), session.reservedMinutes || 0))
  if (!refund) return { freeRefund: 0, paidRefund: 0 }
  const paidRefund = Math.min(session.paidReserved || 0, refund)
  const freeRefund = Math.min(session.freeReserved || 0, refund - paidRefund)
  const usage = await tx.aiLiveUsage.findUnique({ where: { userId_month_purpose: { userId: session.userId, month: session.month, purpose: session.purpose } } })
  if (usage) {
    await tx.aiLiveUsage.update({
      where: { id: usage.id },
      data: {
        freeMinutesUsed: { decrement: Math.min(freeRefund, usage.freeMinutesUsed || 0) },
        paidMinutesUsed: { decrement: Math.min(paidRefund, usage.paidMinutesUsed || 0) },
      },
    })
  }
  if (paidRefund > 0) {
    await tx.aiLiveCredit.create({
      data: {
        userId: session.userId,
        minutes: paidRefund,
        remainingMinutes: paidRefund,
        source: 'REFUND',
        note: `Auto refund for live session ${session.sessionId}`,
      },
    })
  }
  return { freeRefund, paidRefund }
}

export async function reserveGeminiLiveUsage(input: {
  userId: string
  role: unknown
  purpose?: LivePurpose | string
  requestedMinutes?: number
  sessionId?: string | null
}): Promise<LiveUsageDecision> {
  const purpose = purposeName(input.purpose)
  const month = monthKey()
  const now = new Date()
  const hardSessionLimit = liveSessionLimitMinutes(input.role, purpose)
  const sessionId = sessionIdValue(input.sessionId)

  if (roleName(input.role) === 'ADMIN') {
    await db.$transaction(async (tx) => {
      const existing = await tx.aiLiveSession.findUnique({ where: { sessionId } })
      if (existing) {
        if (existing.userId !== input.userId || existing.reservedMinutes !== 0 || existing.purpose !== purpose) {
          throw new Error('LIVE_SESSION_ID_CONFLICT')
        }
        return
      }
      await tx.aiLiveSession.create({
        data: {
          sessionId,
          userId: input.userId,
          month,
          purpose,
          reservedMinutes: 0,
          freeReserved: 0,
          paidReserved: 0,
          expiresAt: new Date(now.getTime() + hardSessionLimit * 60 * 1000),
        },
      })
    })
    return adminLiveDecision(input.role, purpose, month, sessionId)
  }

  const freeMonthlyLimitMinutes = await freeMonthlyLiveMinutes(input.userId, input.role)
  const maxSession = Math.max(1, Math.min(input.requestedMinutes || 2, hardSessionLimit))

  return db.$transaction(async (tx) => {
    const existing = await tx.aiLiveSession.findUnique({ where: { sessionId } }).catch(() => null)
    if (existing) {
      const usage = await tx.aiLiveUsage.findUnique({ where: { userId_month_purpose: { userId: existing.userId, month: existing.month, purpose: existing.purpose } } }).catch(() => null)
      return {
        ok: true,
        status: 200,
        purpose: purposeName(existing.purpose),
        month: existing.month,
        freeMonthlyLimitMinutes,
        sessionLimitMinutes: existing.reservedMinutes,
        usedFreeMinutes: usage?.freeMinutesUsed || 0,
        usedPaidMinutes: usage?.paidMinutesUsed || 0,
        paidRemainingMinutes: 0,
        totalRemainingMinutes: 0,
        sessionsUsed: usage?.sessionsCount || 0,
        sessionId,
      }
    }

    const usage = await tx.aiLiveUsage.upsert({
      where: { userId_month_purpose: { userId: input.userId, month, purpose } },
      create: { userId: input.userId, month, purpose },
      update: {},
    })

    const credits = await tx.aiLiveCredit.findMany({
      where: {
        userId: input.userId,
        status: 'ACTIVE',
        remainingMinutes: { gt: 0 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    })

    const freeRemaining = Math.max(0, freeMonthlyLimitMinutes - usage.freeMinutesUsed)
    const paidRemainingMinutes = credits.reduce((sum, c) => sum + Math.max(0, c.remainingMinutes), 0)
    const totalRemainingMinutes = freeRemaining + paidRemainingMinutes
    const reserve = Math.min(maxSession, totalRemainingMinutes)

    if (reserve <= 0) {
      return {
        ok: false,
        status: 402,
        message: 'انتهت دقائق Gemini Live المجانية والإضافية لهذا الشهر. يمكنك استخدام المشرف النصي أو شراء دقائق صوت إضافية عند تفعيل الباقات.',
        purpose,
        month,
        freeMonthlyLimitMinutes,
        sessionLimitMinutes: maxSession,
        usedFreeMinutes: usage.freeMinutesUsed,
        usedPaidMinutes: usage.paidMinutesUsed,
        paidRemainingMinutes,
        totalRemainingMinutes: 0,
        sessionsUsed: usage.sessionsCount,
        sessionId,
      }
    }

    const freeTake = Math.min(reserve, freeRemaining)
    let paidTake = reserve - freeTake

    for (const credit of credits) {
      if (paidTake <= 0) break
      const take = Math.min(paidTake, credit.remainingMinutes)
      const remaining = credit.remainingMinutes - take
      await tx.aiLiveCredit.update({
        where: { id: credit.id },
        data: { remainingMinutes: remaining, status: remaining <= 0 ? 'CONSUMED' : 'ACTIVE' },
      })
      paidTake -= take
    }

    const paidUsed = reserve - freeTake
    const updated = await tx.aiLiveUsage.update({
      where: { id: usage.id },
      data: {
        freeMinutesUsed: { increment: freeTake },
        paidMinutesUsed: { increment: paidUsed },
        sessionsCount: { increment: 1 },
        lastSessionAt: now,
      },
    })

    await tx.aiLiveSession.create({
      data: {
        sessionId,
        userId: input.userId,
        month,
        purpose,
        reservedMinutes: reserve,
        freeReserved: freeTake,
        paidReserved: paidUsed,
        expiresAt: new Date(now.getTime() + 10 * 60 * 1000),
      },
    })

    return {
      ok: true,
      status: 200,
      purpose,
      month,
      freeMonthlyLimitMinutes,
      sessionLimitMinutes: reserve,
      usedFreeMinutes: updated.freeMinutesUsed,
      usedPaidMinutes: updated.paidMinutesUsed,
      paidRemainingMinutes: Math.max(0, paidRemainingMinutes - paidUsed),
      totalRemainingMinutes: Math.max(0, totalRemainingMinutes - reserve),
      sessionsUsed: updated.sessionsCount,
      sessionId,
    }
  })
}

export async function settleGeminiLiveUsage(input: { sessionId: string; actualSeconds?: number; actualMinutes?: number }) {
  const actualMinutes = Math.max(0, Math.ceil(input.actualMinutes ?? ((Number(input.actualSeconds || 0) || 0) / 60)))
  return db.$transaction(async (tx) => {
    const session = await tx.aiLiveSession.findUnique({ where: { sessionId: input.sessionId } })
    if (!session) return { ok: false, status: 404, message: 'جلسة الصوت غير موجودة' }
    if (session.status !== 'RESERVED') return { ok: true, status: 200, idempotent: true, session }
    const refund = Math.max(0, session.reservedMinutes - Math.min(session.reservedMinutes, actualMinutes))
    await refundReserved(tx, session, refund)
    const updated = await tx.aiLiveSession.update({
      where: { id: session.id },
      data: { status: 'SETTLED', actualMinutes: Math.min(session.reservedMinutes, actualMinutes), settledAt: new Date() },
    })
    return { ok: true, status: 200, refundMinutes: refund, session: updated }
  })
}

export async function refundExpiredGeminiLiveSessions(now = new Date()) {
  return db.$transaction(async (tx) => {
    const sessions = await tx.aiLiveSession.findMany({ where: { status: 'RESERVED', expiresAt: { lt: now } }, take: 50 })
    let refunded = 0
    for (const session of sessions) {
      await refundReserved(tx, session, session.reservedMinutes)
      await tx.aiLiveSession.update({ where: { id: session.id }, data: { status: 'REFUNDED', settledAt: now, actualMinutes: 0 } })
      refunded += session.reservedMinutes
    }
    return { sessions: sessions.length, refunded }
  })
}

export async function grantGeminiLiveCredit(input: {
  userId: string
  minutes: number
  source?: string
  paymentId?: string
  note?: string
  expiresAt?: Date | null
}) {
  const minutes = Math.max(0, Math.floor(input.minutes || 0))
  if (!minutes) throw new Error('LIVE_CREDIT_MINUTES_REQUIRED')
  return db.aiLiveCredit.create({
    data: {
      userId: input.userId,
      minutes,
      remainingMinutes: minutes,
      source: input.source || 'ADMIN_GRANT',
      paymentId: input.paymentId || null,
      note: input.note || null,
      expiresAt: input.expiresAt || null,
    },
  })
}
