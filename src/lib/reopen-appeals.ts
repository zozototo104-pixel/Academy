import { db } from './db'
import { getSemesterState } from './semester-lifecycle'
import { enqueueOutbox } from './outbox'

// التماسات إعادة الفتح (المرحلة 4) — نظام مستقل عن التماسات الدرجات:
// الطالب يطلب إعادة فتح تسليم وحدة انتهت نافذتها ما دام فصلها قائمًا
// وغير مغلق؛ الإدارة تبتّ؛ القبول منحةً تُقرأ في حارس النوافذ. لكل
// التماس مهلة بتّ وتصعيد إداري عند التأخر — لا رفض تلقائي أبدًا.
type AnyClient = any

export const REOPEN_APPEAL_DECISION_DAYS = 7

export type ReopenAppealResult =
  | { ok: true; appeal: any }
  | { ok: false; code: 'INVALID_INPUT' | 'ENROLLMENT_NOT_FOUND' | 'UNIT_NOT_FOUND' | 'SEMESTER_CLOSED' | 'APPEAL_ALREADY_PENDING' | 'APPEAL_NOT_FOUND' | 'APPEAL_ALREADY_DECIDED' | 'FORBIDDEN' }

export async function createReopenAppeal(
  client: AnyClient,
  args: { userId: string; unitId?: string | null; programId?: string | null; semester?: number | null; reason: string; supervisorUserId?: string | null },
): Promise<ReopenAppealResult> {
  const reason = String(args.reason || '').trim()
  if (!args.userId?.trim() || !reason) return { ok: false, code: 'INVALID_INPUT' }
  let programId = args.programId || null
  let semester = args.semester || null
  let unitId: string | null = args.unitId || null
  if (unitId) {
    const unit = await client.unit.findUnique({ where: { id: unitId }, select: { id: true, programId: true, semester: true } }).catch(() => null)
    if (!unit) return { ok: false, code: 'UNIT_NOT_FOUND' }
    programId = unit.programId
    semester = unit.semester
  }
  if (!programId || !semester || !Number.isInteger(semester) || semester < 1) return { ok: false, code: 'INVALID_INPUT' }
  const enrollment = await client.enrollment.findUnique({
    where: { userId_programId: { userId: args.userId, programId } },
    select: { id: true },
  }).catch(() => null)
  if (!enrollment) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  const state = await getSemesterState(client, enrollment.id, semester)
  if (state?.status === 'CLOSED') return { ok: false, code: 'SEMESTER_CLOSED' }
  const store = (client as AnyClient)?.reopenAppeal
  if (!store?.create) return { ok: false, code: 'INVALID_INPUT' }
  const existing = await store.findFirst({
    where: { enrollmentId: enrollment.id, unitId: unitId ?? undefined, status: 'PENDING' },
    select: { id: true },
  }).catch(() => null)
  if (existing) return { ok: false, code: 'APPEAL_ALREADY_PENDING' }
  const now = new Date()
  const appeal = await store.create({
    data: {
      enrollmentId: enrollment.id,
      userId: args.userId,
      programId,
      semester,
      unitId,
      reason: reason.slice(0, 2000),
      status: 'PENDING',
      decisionDeadline: new Date(now.getTime() + REOPEN_APPEAL_DECISION_DAYS * 86_400_000),
    },
  })
  await enqueueOutbox(client, {
    key: `reopen-appeal-created:${appeal.id}`,
    kind: 'REOPEN_APPEAL_CREATED',
    recipientRole: 'ADMINS',
    title: 'التماس إعادة فتح جديد',
    body: `قدّم طالب التماس إعادة فتح تسليم (الفصل ${semester}) — البتّ مطلوب قبل ${appeal.decisionDeadline.toISOString().slice(0, 10)}.`,
  }).catch(() => {})
  if (args.supervisorUserId) {
    await enqueueOutbox(client, {
      key: `reopen-appeal-created-sup:${appeal.id}`,
      kind: 'REOPEN_APPEAL_CREATED',
      recipientUserId: args.supervisorUserId,
      title: 'التماس إعادة فتح من طالبك',
      body: `قدّم أحد طلابك التماس إعادة فتح تسليم (الفصل ${semester}) — القرار للإدارة.`,
    }).catch(() => {})
  }
  return { ok: true, appeal }
}

export async function decideReopenAppeal(
  client: AnyClient,
  args: { appealId: string; actor: { id: string }; approve: boolean; note?: string | null },
): Promise<ReopenAppealResult> {
  const store = (client as AnyClient)?.reopenAppeal
  if (!store?.findUnique || !args.appealId?.trim() || !args.actor?.id?.trim()) return { ok: false, code: 'INVALID_INPUT' }
  const actor = await client.user.findUnique({ where: { id: args.actor.id }, select: { role: true } }).catch(() => null)
  if (actor?.role !== 'ADMIN') return { ok: false, code: 'FORBIDDEN' }
  const appeal = await store.findUnique({ where: { id: args.appealId } }).catch(() => null)
  if (!appeal) return { ok: false, code: 'APPEAL_NOT_FOUND' }
  if (appeal.status !== 'PENDING') return { ok: false, code: 'APPEAL_ALREADY_DECIDED' }
  // تحديث مشروط بالحالة: جلسة أخرى حسمت أولًا ⟸ count=0 ونرفض بأمانة.
  const updated = await store.updateMany({
    where: { id: args.appealId, status: 'PENDING' },
    data: {
      status: args.approve ? 'APPROVED' : 'REJECTED',
      decidedById: args.actor.id,
      decidedAt: new Date(),
      decisionNote: args.note ? String(args.note).slice(0, 1000) : null,
    },
  })
  if (!updated || updated.count !== 1) return { ok: false, code: 'APPEAL_ALREADY_DECIDED' }
  const decided = await store.findUnique({ where: { id: args.appealId } }).catch(() => null)
  await enqueueOutbox(client, {
    key: `reopen-appeal-decided:${args.appealId}:${args.approve ? 'APPROVED' : 'REJECTED'}`,
    kind: 'REOPEN_APPEAL_DECIDED',
    recipientUserId: appeal.userId,
    title: args.approve ? 'قُبل التماس إعادة الفتح' : 'رُفض التماس إعادة الفتح',
    body: args.approve
      ? `قُبل التماسك: يمكنك التسليم الآن ضمن فترة الفصل القائمة${args.note ? ` — ملاحظة الإدارة: ${String(args.note).slice(0, 300)}` : ''}.`
      : `رُفض التماس إعادة الفتح${args.note ? ` — السبب: ${String(args.note).slice(0, 300)}` : ''}.`,
  }).catch(() => {})
  return { ok: true, appeal: decided || appeal }
}

// تصعيد الالتماسات المتأخرة: تنبيه إداري واحد موثّق لكل التماس تجاوز
// مهلة البتّ وما زال معلّقًا — لا رفض تلقائي ولا إغلاق قسري أبدًا.
export async function escalateOverdueReopenAppeals(client: AnyClient, now = new Date()): Promise<number> {
  const store = (client as AnyClient)?.reopenAppeal
  if (!store?.findMany) return 0
  const overdue = await store.findMany({
    where: { status: 'PENDING', decisionDeadline: { lt: now }, escalatedAt: null },
    select: { id: true, semester: true, decisionDeadline: true },
    take: 100,
  }).catch(() => [])
  let count = 0
  for (const appeal of overdue as any[]) {
    const marked = await store.updateMany({
      where: { id: appeal.id, status: 'PENDING', escalatedAt: null },
      data: { escalatedAt: now },
    }).catch(() => null)
    if (marked?.count === 1) {
      count++
      await enqueueOutbox(client, {
        key: `reopen-appeal-escalated:${appeal.id}`,
        kind: 'REOPEN_APPEAL_ESCALATED',
        recipientRole: 'ADMINS',
        title: 'تصعيد: التماس إعادة فتح بلا بتّ',
        body: `تجاوز التماس إعادة فتح (الفصل ${appeal.semester}) مهلة البتّ دون قرار — يحتاج بتًّا إداريًا.`,
      }).catch(() => {})
    }
  }
  return count
}
