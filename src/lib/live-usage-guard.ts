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
  // الزائر لا يحصل على دقائق صوت حي مجانية — مساعد الاجتماع له
  // مساره المحكوم بدعوة الاجتماع، لا هذا الاحتياطي الافتراضي.
  if (r === 'VISITOR') return 0
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
    // عند نفاد الرصيد (ok=false) يكون سقف الجلسة صفراً حقيقياً — لا السقف
    // الكامل. القيمة المموّهة كانت فخاً لأي مستهلك مستقبلي يثق بالسقف
    // دون فحص ok فيصدر توكناً بحد كامل لمستخدم بلا رصيد.
    sessionLimitMinutes: cappedSessionLimit,
    usedFreeMinutes,
    usedPaidMinutes,
    paidRemainingMinutes,
    totalRemainingMinutes,
    sessionsUsed: usage?.sessionsCount || 0,
  }
}

// E01 — دفتر التخصيص: دمج سحب إضافي (شحن التسوية فوق الحجز) في صف
// تخصيص الجلسة من المصدر نفسه، أو إنشاء الصف إن كان المصدر جديدًا على
// الجلسة. الشحن الإضافي مستهلَك بتعريفه فيُوسم مستخدمًا فورًا.
async function mergeAllocation(tx: any, liveSessionId: string, creditId: string | null, minutes: number, markUsed: boolean) {
  if (minutes <= 0) return
  const existing = await tx.aiLiveCreditAllocation.findFirst({ where: { sessionId: liveSessionId, creditId } })
  if (existing) {
    await tx.aiLiveCreditAllocation.update({
      where: { id: existing.id },
      data: {
        minutesReserved: { increment: minutes },
        ...(markUsed ? { minutesUsed: { increment: minutes } } : {}),
      },
    })
  } else {
    await tx.aiLiveCreditAllocation.create({
      data: { sessionId: liveSessionId, creditId, minutesReserved: minutes, minutesUsed: markUsed ? minutes : 0 },
    })
  }
}

// إقفال تخصيصات جلسة مُحاسَبة على حجزها كاملًا بلا استرداد (الكنس
// الليلي، ومسار الحجز المنتهي داخل الحجز نفسه): كل محجوز = مستخدم.
async function closeAllocationsAsFullyUsed(tx: any, liveSessionId: string) {
  const rows = await tx.aiLiveCreditAllocation.findMany({ where: { sessionId: liveSessionId } })
  for (const row of rows) {
    if (row.minutesUsed !== row.minutesReserved || row.minutesRefunded !== 0) {
      await tx.aiLiveCreditAllocation.update({
        where: { id: row.id },
        data: { minutesUsed: row.minutesReserved, minutesRefunded: 0 },
      })
    }
  }
}

// E01: تسوية جلسة لها صفوف تخصيص — المستعمل يُنسب بترتيب السحب
// (المجاني أولًا ثم المدفوع بأقرب انتهاء ثم الأقدم إنشاءً، مرآة ترتيب
// الحجز)، وكل جزء غير مستعمل يعود إلى مصدره بعينه: المجاني إلى عدّاد
// الشهر، والمدفوع إلى رصيده الأصلي نفسه بذات انتهائه — يُعاد تفعيله إن
// كان حيًّا، ويستقبل الدقائق منتهيًا (EXPIRED) إن انتهى أثناء الجلسة،
// فلا تتحول دقيقة مؤقتة إلى دائمة ولا يُولد رصيد REFUND تخميني.
async function settleAllocations(tx: any, session: any, refund: number, allocations: any[]) {
  const ordered = [...allocations].sort((a, b) => {
    if (!a.creditId && b.creditId) return -1
    if (a.creditId && !b.creditId) return 1
    if (a.creditId && b.creditId) {
      const ea = a.credit?.expiresAt ? new Date(a.credit.expiresAt).getTime() : Number.POSITIVE_INFINITY
      const eb = b.credit?.expiresAt ? new Date(b.credit.expiresAt).getTime() : Number.POSITIVE_INFINITY
      if (ea !== eb) return ea - eb
      const ca = a.credit?.createdAt ? new Date(a.credit.createdAt).getTime() : 0
      const cb = b.credit?.createdAt ? new Date(b.credit.createdAt).getTime() : 0
      if (ca !== cb) return ca - cb
    }
    return String(a.id).localeCompare(String(b.id))
  })
  let remainingUsed = Math.max(0, (session.reservedMinutes || 0) - refund)
  let freeRefund = 0
  let paidRefund = 0
  const now = new Date()
  for (const row of ordered) {
    const open = Math.max(0, row.minutesReserved - row.minutesUsed)
    const usedShare = Math.min(open, remainingUsed)
    remainingUsed -= usedShare
    const refunded = open - usedShare
    await tx.aiLiveCreditAllocation.update({
      where: { id: row.id },
      data: { minutesUsed: row.minutesUsed + usedShare, minutesRefunded: refunded },
    })
    if (refunded <= 0) continue
    if (!row.creditId) {
      freeRefund += refunded
      continue
    }
    paidRefund += refunded
    const expired = row.credit?.expiresAt ? new Date(row.credit.expiresAt).getTime() <= now.getTime() : false
    await tx.aiLiveCredit.update({
      where: { id: row.creditId },
      data: {
        remainingMinutes: { increment: refunded },
        status: expired ? 'EXPIRED' : 'ACTIVE',
      },
    })
  }
  if (freeRefund > 0 || paidRefund > 0) {
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
  }
  return { freeRefund, paidRefund }
}

async function refundReserved(tx: any, session: any, minutes: number) {
  const refund = Math.max(0, Math.min(Math.floor(minutes || 0), session.reservedMinutes || 0))
  // E01: جلسة لها صفوف تخصيص تُسوّى دفتريًا ولو كان المسترد صفرًا
  // (إقفال الصفوف نفسها جزء من التسوية). بلا صفوف: جلسة سابقة للدفتر.
  const allocations = await tx.aiLiveCreditAllocation
    .findMany({ where: { sessionId: session.id }, include: { credit: true } })
    .catch(() => [])
  if (allocations.length > 0) return settleAllocations(tx, session, refund, allocations)
  // LEGACY_APPROXIMATE: جلسة محجوزة قبل دفتر التخصيص (E01) — تُسترد
  // بالمسار التقديري التالي كما هو: رصيد REFUND واحد يرث أقرب انتهاء
  // من مجموعة السحب المحتملة. لا يُستخدم لأي جلسة لها صفوف تخصيص.
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
    // الدقائق المدفوعة المستردة كانت مشتراةً منتهية الصلاحية بطبيعتها:
    // الحجز يسحب المدفوع بأقرب انتهاء أولاً (FIFO)، فيرث الرصيد المسترد
    // أقرب انتهاء بين أرصدة المستخدم التي كانت موجودة عند بدء الجلسة —
    // وهي مجموعة السحب نفسها — بدل أن يولد بلا expiresAt فيتحوّل رصيد
    // مؤقت إلى رصيد دائم لا ينتهي أبداً. بلا أي انتهاء في المجموعة
    // (أرصدة دائمة أصلاً) يبقى المسترد بلا انتهاء وفاءً لمصدره.
    const poolAnchor = new Date(session.startedAt || session.createdAt || new Date())
    const pool = await tx.aiLiveCredit.findMany({
      where: {
        userId: session.userId,
        createdAt: { lte: poolAnchor },
        status: { in: ['ACTIVE', 'CONSUMED'] },
        // A credit that expired BEFORE this session started could not have
        // funded the reservation, even if it still exists as a historical row.
        OR: [{ expiresAt: null }, { expiresAt: { gt: poolAnchor } }],
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
      take: 1,
    })
    // The pool is an approximation for legacy sessions without per-credit
    // allocation records. Never turn a missing expiring source into unlimited
    // credit: if no eligible source survives, the refund remains expired.
    const inheritedExpiry = pool.length ? pool[0].expiresAt : poolAnchor
    await tx.aiLiveCredit.create({
      data: {
        userId: session.userId,
        minutes: paidRefund,
        remainingMinutes: paidRefund,
        source: 'REFUND',
        expiresAt: inheritedExpiry,
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
          startedAt: now,
          expiresAt: new Date(now.getTime() + hardSessionLimit * 60 * 1000),
        },
      })
    })
    return adminLiveDecision(input.role, purpose, month, sessionId)
  }

  const freeMonthlyLimitMinutes = await freeMonthlyLiveMinutes(input.userId, input.role)
  const maxSession = Math.max(1, Math.min(input.requestedMinutes || 2, hardSessionLimit))

  return db.$transaction(async (tx) => {
    // Paid credits are shared across SUPERVISOR and DISCUSSION. A user-row
    // lock serializes all reservations for this account, across purposes,
    // before reading the common credit pool.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`
    // معرّف جلسة وارد من العميل لا يُقبل على عماه: جلسة غيرك = تعارض،
    // وجلستك المنتهية/المسوّاة لا تُبعث من جديد — تُحجز جلسة جديدة بمعرّف جديد.
    let effectiveSessionId = sessionId
    const existing = await tx.aiLiveSession.findUnique({ where: { sessionId } }).catch(() => null)
    if (existing) {
      if (existing.userId !== input.userId) {
        return {
          ok: false,
          status: 409,
          message: 'معرّف الجلسة هذا مستخدم من حساب آخر.',
          purpose,
          month,
          freeMonthlyLimitMinutes,
          sessionLimitMinutes: maxSession,
          usedFreeMinutes: 0,
          usedPaidMinutes: 0,
          paidRemainingMinutes: 0,
          totalRemainingMinutes: 0,
          sessionsUsed: 0,
          sessionId,
        }
      }
      const unexpired = existing.expiresAt ? new Date(existing.expiresAt).getTime() > now.getTime() : false
      if (existing.status === 'RESERVED' && unexpired) {
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
      if (existing.status === 'RESERVED' && !unexpired) {
        // حجز منتهٍ لم يُسوَّ أبداً: يُحاسَب على محجوزه كاملاً — لا يُسترد —
        // بنفس سياسة كنس الجلسات المنتهية (refundExpiredGeminiLiveSessions).
        // الحجز دقيقتان كحد أقصى فكلفة جلسة تعطّلت فعلاً محدودة، أما
        // الاسترداد الكامل فكان يجعل كل جلسة صوت بلا تسوية مجانية تماماً.
        const staleClaim = await tx.aiLiveSession.updateMany({
          where: { id: existing.id, status: 'RESERVED', expiresAt: { lt: now } },
          data: { status: 'SETTLED', settledAt: now, actualMinutes: existing.reservedMinutes },
        })
        // E01: جلسة مُحاسَبة على حجزها كاملًا تُقفل تخصيصاتها مستخدمةً كلها.
        if (staleClaim.count === 1) await closeAllocationsAsFullyUsed(tx, existing.id)
      }
      effectiveSessionId = sessionIdValue(null)
    }

    const usageRecord = await tx.aiLiveUsage.upsert({
      where: { userId_month_purpose: { userId: input.userId, month, purpose } },
      create: { userId: input.userId, month, purpose },
      update: {},
    })
    // Two simultaneous session reservations must not both spend the same
    // free or paid balance. Lock the per-user/month ledger, then READ its
    // freshly committed counters before allocating credits.
    await tx.$queryRaw`SELECT "id" FROM "AiLiveUsage" WHERE "id" = ${usageRecord.id} FOR UPDATE`
    const usage = await tx.aiLiveUsage.findUnique({
      where: { userId_month_purpose: { userId: input.userId, month, purpose } },
    })
    if (!usage) throw new Error('LIVE_USAGE_LEDGER_MISSING_AFTER_LOCK')

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
        sessionId: effectiveSessionId,
      }
    }

    const freeTake = Math.min(reserve, freeRemaining)
    let paidTake = reserve - freeTake
    // E01: كل سحب مدفوع يُسجَّل بحصته ورصيده حتى تُبنى صفوف التخصيص
    // بعد إنشاء الجلسة — الاسترداد عند التسوية يعود لهذه الأرصدة بعينها.
    const paidAllocations: Array<{ creditId: string; minutes: number }> = []

    for (const credit of credits) {
      if (paidTake <= 0) break
      const take = Math.min(paidTake, credit.remainingMinutes)
      const remaining = credit.remainingMinutes - take
      await tx.aiLiveCredit.update({
        where: { id: credit.id },
        data: { remainingMinutes: remaining, status: remaining <= 0 ? 'CONSUMED' : 'ACTIVE' },
      })
      if (take > 0) paidAllocations.push({ creditId: credit.id, minutes: take })
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

    const sessionRow = await tx.aiLiveSession.create({
      data: {
        sessionId: effectiveSessionId,
        userId: input.userId,
        month,
        purpose,
        reservedMinutes: reserve,
        freeReserved: freeTake,
        paidReserved: paidUsed,
        startedAt: now,
        // سجل الجلسة يعيش حتى سقف جلستها الحقيقي (طالب 10 / مشرف 20 /
        // نقاش 30) لا 10 دقائق مسطّحة — حتى لا «ينتهي» سجل جلسة مشرف
        // أو نقاش وهي ما زالت جارية بتوكن حي فيُسترد حجزها منتصف المكالمة.
        expiresAt: new Date(now.getTime() + hardSessionLimit * 60 * 1000),
      },
    })

    // E01: صفوف تخصيص هذا الحجز بترتيب السحب نفسه (المجاني أولًا ثم
    // المدفوع بأقرب انتهاء) — تُقفل عند التسوية/الكنس بتحقق
    // محجوز = مستخدم + مسترد لكل صف.
    if (freeTake > 0) {
      await tx.aiLiveCreditAllocation.create({
        data: { sessionId: sessionRow.id, creditId: null, minutesReserved: freeTake },
      })
    }
    for (const alloc of paidAllocations) {
      await tx.aiLiveCreditAllocation.create({
        data: { sessionId: sessionRow.id, creditId: alloc.creditId, minutesReserved: alloc.minutes },
      })
    }

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
      sessionId: effectiveSessionId,
    }
  })
}

// خصم الدقائق المنقضية فوق الحجز المسبق من رصيد الطالب المتبقي (مجاني أولاً
// ثم مدفوع بترتيب انتهاء الرصيد — نفس ترتيب الحجز). توكن Google يعيش حتى
// سقف الجلسة/الرصيد بينما الحجز دقيقتان فقط؛ بلا هذا الخصم يحكي الطالب
// أطول مما يُحاسَب عليه وتدفع الأكاديمية الفرق. يُخصم المتاح فقط — لا
// رصيد سالب أبدًا — والباقي المنقضي فوق كل رصيده يبقى غير محاسَب (سقفه
// عمر التوكن نفسه المربوط برصيده عند الإصدار).
async function chargeExtraLiveMinutes(tx: any, session: any, wantedMinutes: number): Promise<number> {
  const wanted = Math.max(0, Math.floor(wantedMinutes || 0))
  if (!wanted) return 0
  const user = await tx.user.findUnique({ where: { id: session.userId }, select: { role: true } }).catch(() => null)
  const freeMonthlyLimitMinutes = await freeMonthlyLiveMinutes(session.userId, user?.role)
  const now = new Date()
  const usage = await tx.aiLiveUsage.findUnique({ where: { userId_month_purpose: { userId: session.userId, month: session.month, purpose: session.purpose } } })
  if (!usage) return 0
  const credits = await tx.aiLiveCredit.findMany({
    where: {
      userId: session.userId,
      status: 'ACTIVE',
      remainingMinutes: { gt: 0 },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
  })
  const freeRemaining = Math.max(0, freeMonthlyLimitMinutes - (usage.freeMinutesUsed || 0))
  const freeTake = Math.min(wanted, freeRemaining)
  let paidTake = Math.min(wanted - freeTake, credits.reduce((sum: number, c: any) => sum + Math.max(0, c.remainingMinutes), 0))
  const paidWanted = paidTake
  // E01: سحوبات الشحن الإضافي تُنسب لمصادرها في دفتر تخصيص الجلسة
  // (مدموجة في صفوف الحجز إن وُجدت) وتُوسم مستخدمة فورًا.
  const extraAllocations: Array<{ creditId: string; minutes: number }> = []
  for (const credit of credits) {
    if (paidTake <= 0) break
    const take = Math.min(paidTake, credit.remainingMinutes)
    const remaining = credit.remainingMinutes - take
    await tx.aiLiveCredit.update({
      where: { id: credit.id },
      data: { remainingMinutes: remaining, status: remaining <= 0 ? 'CONSUMED' : 'ACTIVE' },
    })
    if (take > 0) extraAllocations.push({ creditId: credit.id, minutes: take })
    paidTake -= take
  }
  const paidCharged = paidWanted - paidTake
  if (freeTake > 0) await mergeAllocation(tx, session.id, null, freeTake, true)
  for (const alloc of extraAllocations) {
    await mergeAllocation(tx, session.id, alloc.creditId, alloc.minutes, true)
  }
  if (freeTake > 0 || paidCharged > 0) {
    await tx.aiLiveUsage.update({
      where: { id: usage.id },
      data: {
        freeMinutesUsed: { increment: freeTake },
        paidMinutesUsed: { increment: paidCharged },
      },
    })
  }
  return freeTake + paidCharged
}

// سماح تسوية صغير فوق نهاية الجلسة المصرّح بها: يغطي انحراف ساعة الخادم
// عن ساعة إصدار التوكن وزمن رحلة طلب التسوية الأخير، ولا يفتح باب محاسبة
// مفتوحة — دقيقتان فقط فوق سقف جلسة أقصاه 30 دقيقة.
const LIVE_SETTLE_GRACE_MINUTES = 2

// نهاية الاحتساب عند التسوية (إصلاح U10/M8): ساعة الخادم تبقى مصدر حقيقة
// الاستهلاك ضد ادعاء العميل، لكن لا جلسة تُحاسَب أبعد من نهايتها المصرّح
// بها. التوكن يموت عند انتهاء الجلسة، فتسوية تصل بعد ساعات (طابور إعادة
// محاولة عند العميل بعد انقطاع) كانت تُحمّل الطالب من رصيده ساعاتٍ لم
// يعشها أصلًا. النهاية المخزّنة عند الحجز (expiresAt = البدء + حدّ
// الجلسة) هي المرجع؛ ولسجل قديم بلا expiresAt يُبنى السقف من مصدر مسار
// الإصدار نفسه — حدّ الجلسة liveSessionLimitMinutes للدور والغرض — لا من
// تخمين جديد.
async function settleChargeEndMs(tx: any, session: any, anchor: unknown): Promise<number> {
  const nowMs = Date.now()
  if (session.expiresAt) {
    return Math.min(nowMs, new Date(session.expiresAt).getTime() + LIVE_SETTLE_GRACE_MINUTES * 60000)
  }
  if (!anchor) return nowMs
  const owner = await tx.user.findUnique({ where: { id: session.userId }, select: { role: true } }).catch(() => null)
  const limitMinutes = liveSessionLimitMinutes(owner?.role, purposeName(session.purpose))
  return Math.min(nowMs, new Date(anchor as any).getTime() + (limitMinutes + LIVE_SETTLE_GRACE_MINUTES) * 60000)
}

export async function settleGeminiLiveUsage(input: { userId: string; sessionId: string; actualSeconds?: number; actualMinutes?: number }) {
  const claimedMinutes = Math.max(0, Math.ceil(input.actualMinutes ?? ((Number(input.actualSeconds || 0) || 0) / 60)))
  return db.$transaction(async (tx) => {
    // Lock the owner first (same order as reservation), because paid credit
    // is shared across all live-voice purposes. Then lock the session.
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`
    // Serialize settlements of the same session BEFORE checking RESERVED.
    // A second request must observe the first committed SETTLED state, not
    // refund or charge an identical reservation twice.
    await tx.$queryRaw`SELECT "id" FROM "AiLiveSession" WHERE "sessionId" = ${input.sessionId} FOR UPDATE`
    const session = await tx.aiLiveSession.findUnique({ where: { sessionId: input.sessionId } })
    if (!session) return { ok: false, status: 404, message: 'جلسة الصوت غير موجودة' }
    // التسوية مقيدة بصاحب الجلسة فقط — لا أحد ينهي جلسة غيره أو يعبث برصيده.
    if (session.userId !== input.userId) return { ok: false, status: 403, message: 'هذه الجلسة ليست جلستك' }
    if (session.status !== 'RESERVED') return { ok: true, status: 200, idempotent: true, session }
    // Serialize settlement credit changes against simultaneous reservations
    // for this account, month, and purpose; the actual counters are read
    // only AFTER this ledger lock has been acquired.
    if (session.reservedMinutes > 0) {
      await tx.$queryRaw`SELECT "id" FROM "AiLiveUsage" WHERE "userId" = ${session.userId} AND "month" = ${session.month} AND "purpose" = ${session.purpose} FOR UPDATE`
    }
    // المستهلك يُحسب من ساعة الخادم (startedAt) لا من ادعاء العميل؛ ادعاء
    // «صفر دقائق» بعد جلسة كاملة لا يسترجع شيئاً. الجلسات غير المعدودة
    // (أدمن، reservedMinutes=0) لا مال فيها فيبقى الادعاء سجلاً معلوماتياً.
    let recordedMinutes: number
    let extraChargedMinutes = 0
    if (session.reservedMinutes === 0) {
      recordedMinutes = claimedMinutes
    } else {
      const anchor = session.startedAt || session.createdAt
      // المنقضي المحاسَب يُقاس حتى نهاية الاحتساب المسقوفة (settleChargeEndMs)
      // لا حتى لحظة وصول التسوية مهما تأخرت.
      const elapsedMinutes = anchor ? Math.max(0, Math.ceil(((await settleChargeEndMs(tx, session, anchor)) - new Date(anchor).getTime()) / 60000)) : claimedMinutes
      const coveredByReserve = Math.min(session.reservedMinutes, elapsedMinutes)
      // ما تجاوز الحجز يُخصم من الرصيد المتبقي داخل نفس المعاملة (انظر
      // chargeExtraLiveMinutes) — كان يُعفى كاملاً قبل هذا الإصلاح.
      if (elapsedMinutes > session.reservedMinutes) {
        extraChargedMinutes = await chargeExtraLiveMinutes(tx, session, elapsedMinutes - session.reservedMinutes)
      }
      recordedMinutes = coveredByReserve + extraChargedMinutes
    }
    const refund = Math.max(0, session.reservedMinutes - recordedMinutes)
    await refundReserved(tx, session, refund)
    const updated = await tx.aiLiveSession.update({
      where: { id: session.id },
      data: { status: 'SETTLED', actualMinutes: recordedMinutes, settledAt: new Date() },
    })
    return { ok: true, status: 200, refundMinutes: refund, extraChargedMinutes, session: updated }
  })
}

// اسم الدالة تاريخي: كانت «تسترد» الجلسات المنتهية كاملة. السياسة الآن
// (إصلاح تدقيق 2026-11-06): الجلسة المنتهية التي لم تُسوَّ أبداً تُحاسَب
// على حجزها كاملاً — status SETTLED وactualMinutes = المحجوز، بلا أي
// استرداد — لأن العميل الذي لا يتصل بالتسوية يجب ألا يكون أوفر من الذي
// يتصل. الحجز دقيقتان كحد أقصى (min(2, سقف الجلسة)) فخسارة جلسة تعطّلت
// فعلاً محدودة بها. عدّاد الاستخدام رُفع أصلاً عند الحجز فالمحاسبة هنا
// مجرد عدم التراجع عنه؛ refunded تبقى في النتيجة صفراً لتوافق المستهلكين.
export async function refundExpiredGeminiLiveSessions(now = new Date()) {
  return db.$transaction(async (tx) => {
    const sessions = await tx.aiLiveSession.findMany({ where: { status: 'RESERVED', expiresAt: { lt: now } }, take: 50 })
    let charged = 0
    let settled = 0
    for (const session of sessions) {
      // CAS protects a session settled by another worker between findMany
      // and this update. In particular, never overwrite its actual minutes.
      const claim = await tx.aiLiveSession.updateMany({
        where: { id: session.id, status: 'RESERVED', expiresAt: { lt: now } },
        data: { status: 'SETTLED', settledAt: now, actualMinutes: session.reservedMinutes },
      })
      if (claim.count !== 1) continue
      // E01: إقفال دفتري مطابق للمحاسبة الكاملة — كل محجوز مستخدم.
      await closeAllocationsAsFullyUsed(tx, session.id)
      settled++
      charged += session.reservedMinutes
    }
    return { sessions: settled, refunded: 0, charged }
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
  const data = {
    userId: input.userId,
    minutes,
    remainingMinutes: minutes,
    source: input.source || 'ADMIN_GRANT',
    paymentId: input.paymentId || null,
    note: input.note || null,
    expiresAt: input.expiresAt || null,
  }

  if (!input.paymentId) {
    const credit = await db.aiLiveCredit.create({ data })
    return { ...credit, newlyGranted: true }
  }
  // A payment row lock serializes manual confirmation, webhook and PAID replay.
  // The existence check and grant MUST be within the SAME transaction.
  try {
    return await db.$transaction(async (tx) => {
      const payments = await tx.$queryRaw<Array<{ id: string; userId: string | null; status: string }>>`
        SELECT "id", "userId", "status" FROM "Payment" WHERE "id" = ${input.paymentId} FOR UPDATE
      `
      const payment = payments[0]
      if (!payment || payment.status !== 'PAID' || payment.userId !== input.userId) {
        throw new Error('LIVE_CREDIT_PAYMENT_NOT_SETTLED_OR_OWNER_MISMATCH')
      }
      const existing = await tx.aiLiveCredit.findFirst({ where: { paymentId: payment.id } })
      if (existing) return { ...existing, newlyGranted: false }
      const credit = await tx.aiLiveCredit.create({ data })
      return { ...credit, newlyGranted: true }
    })
  } catch (error: any) {
    // The paymentId unique index fired: a concurrent settle already
    // granted this payment. PostgreSQL ABORTS the whole transaction on
    // a unique violation, so the winning credit can only be read in a
    // FRESH query here — never inside the aborted transaction. The
    // already-granted outcome is not a failure.
    if (error?.code !== 'P2002') throw error
    const granted = await db.aiLiveCredit.findFirst({ where: { paymentId: input.paymentId } })
    if (!granted) throw error
    return { ...granted, newlyGranted: false }
  }
}
