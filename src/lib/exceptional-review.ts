import { db } from './db'
import { getSemesterState } from './semester-lifecycle'
import { enqueueOutbox } from './outbox'

// قناة المراجعة الأكاديمية الاستثنائية (المرحلة 4، بند 8): مسار مستقل
// لقرار إداري موثّق بعد إغلاق فصل — الأول أو الثاني، دون اشتراط إغلاق
// الآخر — لحالات الخطأ المثبت التي لا يعالجها الاسترحام ولا الالتماسات.
// القناة نفسها لا تعيد فتح الفصل ولا تغيّر درجة تلقائيًا: التعديل
// الرسمي يجري بمساراته القائمة (تصحيح الدرجات ⟹ إبطال الاعتماد
// المتأثر ⟹ إعادة مصادقة النتيجة)، وقرار القناة يوثّق القضية وحكمها.
type AnyClient = any

export type ExceptionalReviewResult =
  | { ok: true; review: any }
  | { ok: false; code: 'INVALID_INPUT' | 'ENROLLMENT_NOT_FOUND' | 'SEMESTER_NOT_CLOSED' | 'REVIEW_ALREADY_OPEN' | 'REVIEW_NOT_FOUND' | 'REVIEW_ALREADY_DECIDED' | 'FORBIDDEN' }

export async function openExceptionalReview(
  client: AnyClient,
  args: { userId: string; programId: string; semester: number; reason: string },
): Promise<ExceptionalReviewResult> {
  const reason = String(args.reason || '').trim()
  if (!args.userId?.trim() || !args.programId?.trim() || !Number.isInteger(args.semester) || args.semester < 1 || !reason) {
    return { ok: false, code: 'INVALID_INPUT' }
  }
  const enrollment = await client.enrollment.findUnique({
    where: { userId_programId: { userId: args.userId, programId: args.programId } },
    select: { id: true },
  }).catch(() => null)
  if (!enrollment) return { ok: false, code: 'ENROLLMENT_NOT_FOUND' }
  const state = await getSemesterState(client, enrollment.id, args.semester)
  if (state?.status !== 'CLOSED') return { ok: false, code: 'SEMESTER_NOT_CLOSED' }
  const store = (client as AnyClient)?.exceptionalReview
  if (!store?.create) return { ok: false, code: 'INVALID_INPUT' }
  const open = await store.findFirst({
    where: { enrollmentId: enrollment.id, semester: args.semester, status: 'OPEN' },
    select: { id: true },
  }).catch(() => null)
  if (open) return { ok: false, code: 'REVIEW_ALREADY_OPEN' }
  const review = await store.create({
    data: {
      enrollmentId: enrollment.id,
      userId: args.userId,
      programId: args.programId,
      semester: args.semester,
      reason: reason.slice(0, 2000),
      status: 'OPEN',
    },
  })
  await enqueueOutbox(client, {
    key: `exceptional-review-opened:${review.id}`,
    kind: 'EXCEPTIONAL_REVIEW_OPENED',
    recipientRole: 'ADMINS',
    title: 'طلب مراجعة أكاديمية استثنائية',
    body: `فُتح طلب مراجعة استثنائية لفصل مغلق (الفصل ${args.semester}) — بانتظار قرار إداري موثّق.`,
  }).catch(() => {})
  return { ok: true, review }
}

export async function decideExceptionalReview(
  client: AnyClient,
  args: { reviewId: string; actor: { id: string }; note: string },
): Promise<ExceptionalReviewResult> {
  const store = (client as AnyClient)?.exceptionalReview
  const note = String(args.note || '').trim()
  if (!store?.findUnique || !args.reviewId?.trim() || !note) return { ok: false, code: 'INVALID_INPUT' }
  const actor = await client.user.findUnique({ where: { id: args.actor?.id || '' }, select: { role: true } }).catch(() => null)
  if (actor?.role !== 'ADMIN') return { ok: false, code: 'FORBIDDEN' }
  const review = await store.findUnique({ where: { id: args.reviewId } }).catch(() => null)
  if (!review) return { ok: false, code: 'REVIEW_NOT_FOUND' }
  if (review.status !== 'OPEN') return { ok: false, code: 'REVIEW_ALREADY_DECIDED' }
  const updated = await store.updateMany({
    where: { id: args.reviewId, status: 'OPEN' },
    data: { status: 'DECIDED', decidedById: args.actor.id, decidedAt: new Date(), decisionNote: note.slice(0, 2000) },
  })
  if (!updated || updated.count !== 1) return { ok: false, code: 'REVIEW_ALREADY_DECIDED' }
  const fresh = await store.findUnique({ where: { id: args.reviewId } }).catch(() => null)
  await enqueueOutbox(client, {
    key: `exceptional-review-decided:${args.reviewId}`,
    kind: 'EXCEPTIONAL_REVIEW_DECIDED',
    recipientUserId: review.userId,
    title: 'قرار المراجعة الأكاديمية الاستثنائية',
    body: `صدر قرار إداري موثّق بشأن مراجعة الفصل ${review.semester}: ${note.slice(0, 300)}`,
  }).catch(() => {})
  return { ok: true, review: fresh || review }
}
