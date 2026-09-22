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

export async function reserveGeminiLiveUsage(input: {
  userId: string
  role: unknown
  purpose?: LivePurpose | string
  requestedMinutes?: number
}): Promise<LiveUsageDecision> {
  const purpose = purposeName(input.purpose)
  const month = monthKey()
  const now = new Date()
  const freeMonthlyLimitMinutes = await freeMonthlyLiveMinutes(input.userId, input.role)
  const maxSession = Math.max(1, Math.min(input.requestedMinutes || liveSessionLimitMinutes(input.role, purpose), liveSessionLimitMinutes(input.role, purpose)))

  return db.$transaction(async (tx) => {
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
        data: {
          remainingMinutes: remaining,
          status: remaining <= 0 ? 'CONSUMED' : 'ACTIVE',
        },
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
    }
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
