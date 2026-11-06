import { db } from './db'
import { getSemesterState } from './semester-lifecycle'
import { storedSemesterApproval } from './semester-approval'
import { calculateSemesterAverages } from './semester-grade'
import { enqueueOutbox } from './outbox'

// مسار الاسترحام والنشاط العلاجي (المرحلة 4، مبدأ 6) — بعد إغلاق فصل
// بنتيجة «راسب» معتمدة فقط. نشاط عملي حقيقي واحد لكل فصل: يُسند بوزن
// (1–50%) ومهلة لا تتجاوز 7 أيام تقويمية من الإسناد (يفرضها الخادم)،
// يُسلَّم ويُصحَّح بدرجة حقيقية، ثم يُعاد احتساب المعدل بالصيغة
// newAvg = (oldAvg×(100−w) + score×w)/100 وتُعاد مصادقة النتيجة رسميًا
// عبر مسار اعتماد الفصل نفسه. لا فتح لوحدات، لا محاولات إضافية، لا
// رفع مباشر لدرجة، ولا ضمان نجاح. انقضاء المهلة دون تسليم = انقضاء
// الطلب وبقاء الرسوب.
type AnyClient = any

export const MERCY_MAX_DEADLINE_DAYS = 7

export type MercyResult =
  | { ok: true; mercy: any }
  | { ok: false; code: 'INVALID_INPUT' | 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_NOT_FAILED' | 'MERCY_ALREADY_EXISTS' | 'MERCY_NOT_FOUND' | 'MERCY_WRONG_STATE' | 'FORBIDDEN' | 'MERCY_DEADLINE_TOO_LONG' | 'MERCY_WEIGHT_INVALID' | 'MERCY_DEADLINE_PASSED' }

async function actorScope(client: AnyClient, actorId: string, studentUserId: string, programId: string): Promise<'ADMIN' | 'SUPERVISOR' | null> {
  const actor = await client.user.findUnique({ where: { id: actorId }, select: { role: true } }).catch(() => null)
  if (actor?.role === 'ADMIN') return 'ADMIN'
  if (actor?.role === 'SUPERVISOR') {
    const assigned = await client.admissionApplication.findFirst({
      where: { userId: studentUserId, programId, supervisorId: actorId },
      select: { id: true },
    }).catch(() => null)
    if (assigned) return 'SUPERVISOR'
  }
  return null
}

export async function requestMercy(
  client: AnyClient,
  args: { userId: string; programId: string; semester: number; initiatedBy?: 'STUDENT' | 'ADMIN'; supervisorUserId?: string | null },
): Promise<MercyResult> {
  if (!args.userId?.trim() || !args.programId?.trim() || !Number.isInteger(args.semester) || args.semester < 1) {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  const enrollment = await client.enrollment.findUnique({
    where: { userId_programId: { userId: args.userId, programId: args.programId } },
    select: { id: true },
  }).catch(() => null)
  if (!enrollment) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  const state = await getSemesterState(client, enrollment.id, args.semester)
  const approval = await storedSemesterApproval(client, enrollment.id, args.semester)
  if (state?.status !== 'CLOSED' || state?.result !== 'FAILED' || !approval) {
    return { ok: false, code: 'SEMESTER_NOT_FAILED' }
  }
  const store = (client as AnyClient)?.mercyRequest
  if (!store?.create) return { ok: false, code: 'INVALID_INPUT' }
  const existing = await store.findUnique({
    where: { enrollmentId_semester: { enrollmentId: enrollment.id, semester: args.semester } },
  }).catch(() => null)
  if (existing) return { ok: false, code: 'MERCY_ALREADY_EXISTS' }
  const mercy = await store.create({
    data: {
      enrollmentId: enrollment.id,
      userId: args.userId,
      programId: args.programId,
      semester: args.semester,
      status: 'REQUESTED',
      initiatedBy: args.initiatedBy || 'STUDENT',
    },
  })
  await enqueueOutbox(client, {
    key: `mercy-requested:${mercy.id}`,
    kind: 'MERCY_REQUESTED',
    recipientRole: 'ADMINS',
    title: 'طلب استرحام لرفع المعدل',
    body: `قدّم طالب طلب استرحام لفصل مغلق بنتيجة راسب (الفصل ${args.semester}) — بانتظار إسناد نشاط علاجي أو رفض الطلب.`,
  }).catch(() => {})
  if (args.supervisorUserId) {
    await enqueueOutbox(client, {
      key: `mercy-requested-sup:${mercy.id}`,
      kind: 'MERCY_REQUESTED',
      recipientUserId: args.supervisorUserId,
      title: 'طلب استرحام من طالبك',
      body: `قدّم أحد طلابك طلب استرحام لفصل مغلق بنتيجة راسب (الفصل ${args.semester}).`,
    }).catch(() => {})
  }
  return { ok: true, mercy }
}

export async function assignMercyActivity(
  client: AnyClient,
  args: { mercyId: string; actor: { id: string }; title: string; instructions?: string | null; weightPercent: number; dueAt?: Date | string | null },
): Promise<MercyResult> {
  const store = (client as AnyClient)?.mercyRequest
  if (!store?.findUnique || !args.mercyId?.trim()) return { ok: false, code: 'INVALID_INPUT' }
  const mercy = await store.findUnique({ where: { id: args.mercyId } }).catch(() => null)
  if (!mercy) return { ok: false, code: 'MERCY_NOT_FOUND' }
  const scope = await actorScope(client, args.actor?.id || '', mercy.userId)
  if (!scope) return { ok: false, code: 'FORBIDDEN' }
  if (mercy.status !== 'REQUESTED') return { ok: false, code: 'MERCY_WRONG_STATE' }
  const title = String(args.title || '').trim()
  if (!title) return { ok: false, code: 'INVALID_INPUT' }
  const w = Number(args.weightPercent)
  if (!Number.isInteger(w) || w < 1 || w > 50) return { ok: false, code: 'MERCY_WEIGHT_INVALID' }
  const now = new Date()
  const dueAt = args.dueAt ? new Date(args.dueAt) : new Date(now.getTime() + MERCY_MAX_DEADLINE_DAYS * 86_400_000)
  if (Number.isNaN(dueAt.getTime()) || dueAt.getTime() <= now.getTime()) return { ok: false, code: 'INVALID_INPUT' }
  if (dueAt.getTime() - now.getTime() > MERCY_MAX_DEADLINE_DAYS * 86_400_000) {
    return { ok: false, code: 'MERCY_DEADLINE_TOO_LONG' }
  }
  const updated = await store.updateMany({
    where: { id: args.mercyId, status: 'REQUESTED' },
    data: {
      status: 'ACTIVITY_ASSIGNED',
      activityTitle: title.slice(0, 300),
      activityInstructions: args.instructions ? String(args.instructions).slice(0, 4000) : null,
      assignedById: args.actor.id,
      assignedAt: now,
      dueAt,
      weightPercent: w,
    },
  })
  if (!updated || updated.count !== 1) return { ok: false, code: 'MERCY_WRONG_STATE' }
  const fresh = await store.findUnique({ where: { id: args.mercyId } }).catch(() => null)
  await enqueueOutbox(client, {
    key: `mercy-assigned:${args.mercyId}`,
    kind: 'MERCY_ACTIVITY_ASSIGNED',
    recipientUserId: mercy.userId,
    title: 'أُسند إليك نشاط علاجي (استرحام)',
    body: `نشاط «${title.slice(0, 120)}» بوزن ${w}% من معدل الفصل — آخر موعد للتسليم: ${dueAt.toISOString().slice(0, 10)}.`,
  }).catch(() => {})
  return { ok: true, mercy: fresh || mercy }
}

export async function submitMercyActivity(
  client: AnyClient,
  args: { mercyId: string; userId: string; text: string },
): Promise<MercyResult> {
  const store = (client as AnyClient)?.mercyRequest
  if (!store?.findUnique || !args.mercyId?.trim()) return { ok: false, code: 'INVALID_INPUT' }
  const mercy = await store.findUnique({ where: { id: args.mercyId } }).catch(() => null)
  if (!mercy) return { ok: false, code: 'MERCY_NOT_FOUND' }
  if (mercy.userId !== args.userId) return { ok: false, code: 'FORBIDDEN' }
  if (mercy.status !== 'ACTIVITY_ASSIGNED') return { ok: false, code: 'MERCY_WRONG_STATE' }
  const text = String(args.text || '').trim()
  if (!text) return { ok: false, code: 'INVALID_INPUT' }
  const now = new Date()
  if (mercy.dueAt && now.getTime() > new Date(mercy.dueAt).getTime()) {
    await store.updateMany({ where: { id: args.mercyId, status: 'ACTIVITY_ASSIGNED' }, data: { status: 'LAPSED' } }).catch(() => {})
    return { ok: false, code: 'MERCY_DEADLINE_PASSED' }
  }
  const updated = await store.updateMany({
    where: { id: args.mercyId, status: 'ACTIVITY_ASSIGNED' },
    data: { status: 'SUBMITTED', submissionText: text.slice(0, 12000), submittedAt: now },
  })
  if (!updated || updated.count !== 1) return { ok: false, code: 'MERCY_WRONG_STATE' }
  const fresh = await store.findUnique({ where: { id: args.mercyId } }).catch(() => null)
  return { ok: true, mercy: fresh || mercy }
}

export async function gradeMercyActivity(
  client: AnyClient,
  args: { mercyId: string; actor: { id: string }; score: number },
): Promise<MercyResult> {
  const store = (client as AnyClient)?.mercyRequest
  if (!store?.findUnique || !args.mercyId?.trim()) return { ok: false, code: 'INVALID_INPUT' }
  const mercy = await store.findUnique({ where: { id: args.mercyId } }).catch(() => null)
  if (!mercy) return { ok: false, code: 'MERCY_NOT_FOUND' }
  const scope = await actorScope(client, args.actor?.id || '', mercy.userId)
  if (!scope) return { ok: false, code: 'FORBIDDEN' }
  if (mercy.status !== 'SUBMITTED') return { ok: false, code: 'MERCY_WRONG_STATE' }
  const score = Number(args.score)
  if (!Number.isFinite(score) || score < 0 || score > 100) return { ok: false, code: 'INVALID_INPUT' }
  // المعدل قبل النشاط (الطلب ليس GRADED بعد فلا يدخل الحساب) يُوثَّق
  // هنا حتى يبقى الرسوب الأصلي ظاهرًا بجانب النتيجة الجديدة دائمًا.
  let previousAverage: number | null = null
  try {
    const averages = await calculateSemesterAverages({ userId: mercy.userId, programId: mercy.programId, client })
    previousAverage = averages.semesters.find((s) => s.semester === mercy.semester)?.average ?? null
  } catch { previousAverage = null }
  const updated = await store.updateMany({
    where: { id: args.mercyId, status: 'SUBMITTED' },
    data: { status: 'GRADED', score, gradedById: args.actor.id, gradedAt: new Date(), previousAverage },
  })
  if (!updated || updated.count !== 1) return { ok: false, code: 'MERCY_WRONG_STATE' }
  const fresh = await store.findUnique({ where: { id: args.mercyId } }).catch(() => null)
  await enqueueOutbox(client, {
    key: `mercy-graded:${args.mercyId}:${score}`,
    kind: 'MERCY_ACTIVITY_GRADED',
    recipientUserId: mercy.userId,
    title: 'صُحّح نشاطك العلاجي',
    body: `درجة النشاط العلاجي: ${score}. تُعاد مصادقة نتيجة الفصل رسميًا بالمعدل الجديد من الإدارة.`,
  }).catch(() => {})
  await enqueueOutbox(client, {
    key: `mercy-graded-admins:${args.mercyId}:${score}`,
    kind: 'MERCY_ACTIVITY_GRADED',
    recipientRole: 'ADMINS',
    title: 'نشاط علاجي مصحَّح بانتظار إعادة المصادقة',
    body: `صُحّح نشاط استرحام (الفصل ${mercy.semester}) بدرجة ${score} — إعادة مصادقة نتيجة الفصل مطلوبة ليصبح المعدل الجديد رسميًا.`,
  }).catch(() => {})
  return { ok: true, mercy: fresh || mercy }
}

// انقضاء مهلة التسليم دون تسليم: الطلب ينقضي والرسوب الأصلي يبقى.
export async function lapseOverdueMercy(client: AnyClient, now = new Date()): Promise<number> {
  const store = (client as AnyClient)?.mercyRequest
  if (!store?.findMany) return 0
  const overdue = await store.findMany({
    where: { status: 'ACTIVITY_ASSIGNED', dueAt: { lt: now } },
    select: { id: true, userId: true, semester: true },
    take: 100,
  }).catch(() => [])
  let count = 0
  for (const mercy of overdue as any[]) {
    const marked = await store.updateMany({
      where: { id: mercy.id, status: 'ACTIVITY_ASSIGNED' },
      data: { status: 'LAPSED' },
    }).catch(() => null)
    if (marked?.count === 1) {
      count++
      await enqueueOutbox(client, {
        key: `mercy-lapsed:${mercy.id}`,
        kind: 'MERCY_LAPSED',
        recipientUserId: mercy.userId,
        title: 'انقضت مهلة النشاط العلاجي',
        body: `انتهت مهلة تسليم النشاط العلاجي (الفصل ${mercy.semester}) دون تسليم؛ تبقى نتيجة الفصل كما اعتُمدت.`,
      }).catch(() => {})
    }
  }
  return count
}
