import { SEMESTER_DECISION_ACTIVE, getSemesterDecision } from '@/lib/semester-decision'
import { matureSemesterRaiseIfReady } from '@/lib/semester-raise'

// ===== ربط النضج بأحداث التصحيح (الخطوة 5) =====
// طلب الإنهاء المبكر المحفوظ (INTENT) لا ينضج من تلقاء نفسه: كل حدث
// يُنهي تصحيحًا (مراجعة إدارة، تصحيح مشرف، حسم اعتراض، تصحيح واجب،
// تسليم امتحان بمصحح آلي) يستدعي هذا الربط بعد نجاحه، فيُعاد اشتقاق
// النضج على الخادم ويرتفع الطلب إن اكتملت شروطه. الربط لا يرمي أبدًا:
// فشله لا يجوز أن يُسقط تصحيحًا ناجحًا. ولا يعمل إلا على الفصول التي
// لها طلب INTENT قائم — غير ذلك يخرج فورًا.

type AnyClient = any

export async function matureSemesterRaisesAfterGrading(
  client: AnyClient,
  input: { enrollmentId?: string | null; userId?: string | null; programId?: string | null },
): Promise<void> {
  try {
    if (!SEMESTER_DECISION_ACTIVE) return
    let enrollment: any = null
    if (input.enrollmentId) {
      enrollment = await client.enrollment.findUnique({
        where: { id: input.enrollmentId },
        select: {
          id: true,
          userId: true,
          programId: true,
          createdAt: true,
          status: true,
          extensionDays: true,
          program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
        },
      })
    } else if (input.userId && input.programId) {
      enrollment = await client.enrollment.findUnique({
        where: { userId_programId: { userId: input.userId, programId: input.programId } },
        select: {
          id: true,
          userId: true,
          programId: true,
          createdAt: true,
          status: true,
          extensionDays: true,
          program: { select: { category: true, maxStudyDays: true, semestersCount: true } },
        },
      })
    }
    if (!enrollment?.id || !enrollment.program) return
    const semestersCount = Math.min(6, Math.max(1, Number(enrollment.program.semestersCount || 2)))
    for (let semester = 1; semester <= semestersCount; semester++) {
      const decision = await getSemesterDecision(client, enrollment.id, semester).catch(() => null)
      if (decision?.status !== 'INTENT') continue
      await matureSemesterRaiseIfReady(client, {
        enrollmentId: enrollment.id,
        userId: enrollment.userId,
        programId: enrollment.programId,
        semester,
        enrollment: {
          createdAt: enrollment.createdAt,
          status: enrollment.status,
          extensionDays: enrollment.extensionDays,
        },
        program: enrollment.program,
      })
    }
  } catch {
    // ربط النضج مساعد صامت: لا يُسقط حدث تصحيح ناجحًا أبدًا.
  }
}
