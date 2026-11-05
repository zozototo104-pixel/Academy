import { getSemesterWindows, unitWindowFor } from './semester-lifecycle'
import { enqueueOutbox } from './outbox'

// ===== مسح تحذيرات المواعيد النهائية (المرحلة 6) =====
// تحذير واحد لكل موعد: قبل يومين من نهاية نافذة وحدة أو فصل قائم
// (حالة مفتوحة في دورة الحياة) يُسجَّل حدث صادر للطالب بمفتاح عدم
// تكرار مربوط بالموعد نفسه — إعادة المسح لا تكرّر التحذير أبدًا.
// النوافذ من نفس تقسيم المدة القائم، بلا نظام مواعيد موازٍ.
type AnyClient = any

const WARNING_HORIZON_MS = 2 * 24 * 60 * 60 * 1000

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function scanDeadlineWarnings(
  client: AnyClient,
  now = new Date(),
): Promise<{ warned: number; scanned: number }> {
  const stateStore = client?.enrollmentSemesterState
  if (!stateStore?.findMany) return { warned: 0, scanned: 0 }
  const states = await stateStore.findMany({
    where: { status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    take: 200,
    select: { enrollmentId: true, semester: true, submissionDeadline: true },
  }).catch(() => [])
  let warned = 0
  for (const state of states as any[]) {
    const enrollment = await client.enrollment.findUnique({
      where: { id: state.enrollmentId },
      select: { id: true, userId: true, programId: true, createdAt: true, extensionDays: true },
    }).catch(() => null)
    if (!enrollment) continue
    const program = await client.program.findUnique({
      where: { id: enrollment.programId },
      select: { category: true, maxStudyDays: true, semestersCount: true },
    }).catch(() => null)
    if (!program) continue
    const units = await client.unit.findMany({
      where: { programId: enrollment.programId },
      select: { id: true, title: true, semester: true, order: true },
    }).catch(() => [])
    const createdAt = new Date(enrollment.createdAt)
    const ext = enrollment.extensionDays || 0
    const inHorizon = (end: Date | null | undefined) =>
      !!end && end.getTime() > now.getTime() && end.getTime() - now.getTime() <= WARNING_HORIZON_MS

    // نهاية الفصل: الموعد المحفوظ عند الإنشاء، وإلا نهاية النافذة.
    const semesterWindow = getSemesterWindows(createdAt, program, units, ext).find((w) => w.semester === state.semester)
    const semesterEnd = state.submissionDeadline ? new Date(state.submissionDeadline) : semesterWindow?.endAt
    if (inHorizon(semesterEnd)) {
      const row = await enqueueOutbox(client, {
        key: `deadline:${enrollment.id}:semester:${state.semester}:${dateKey(semesterEnd as Date)}`,
        kind: 'DEADLINE_WARNING',
        recipientUserId: enrollment.userId,
        title: `اقتراب نهاية الفصل ${state.semester}`,
        body: `تنتهي فترة الفصل ${state.semester} بتاريخ ${(semesterEnd as Date).toISOString().slice(0, 10)} — أكمل محاولاتك وتسليماتك قبل انتهائها؛ بعد الإغلاق لا تُقبل محاولات عادية.`,
        link: '/dashboard',
      }).catch(() => null)
      // enqueue يعيد الصف القائم عند التكرار أيضًا؛ العدّ تقريبي تشغيلي.
      if (row) warned++
    }

    // نهايات وحدات هذا الفصل.
    for (const unit of (units as any[]).filter((u) => u.semester === state.semester)) {
      const w = unitWindowFor(createdAt, program, units, unit.id, ext)
      if (inHorizon(w?.endAt)) {
        const row = await enqueueOutbox(client, {
          key: `deadline:${enrollment.id}:unit:${unit.id}:${dateKey(w!.endAt)}`,
          kind: 'DEADLINE_WARNING',
          recipientUserId: enrollment.userId,
          title: 'اقتراب نهاية نافذة وحدة',
          body: `تنتهي نافذة الوحدة «${unit.title || ''}» بتاريخ ${w!.endAt.toISOString().slice(0, 10)} — أكمل محاولاتك فيها قبل انتهائها.`,
          link: '/dashboard',
        }).catch(() => null)
        if (row) warned++
      }
    }
  }
  return { warned, scanned: (states as any[]).length }
}
