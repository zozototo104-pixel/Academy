import { db } from '@/lib/db'

type AdmissionForAiAccess = {
  id: string
  status: string
  supervisionMode: string
  supervisorAt: Date | null
  payments: Array<{ purpose: string; status: string }>
}

const AI_ENABLED_STATUSES = new Set(['AWAITING_TUITION', 'SUPERVISOR_ASSIGNED', 'THESIS', 'SCHEDULED', 'RESULT_APPROVED', 'CERTIFIED'])
const AI_SUPERVISION_MODES = new Set(['AI', 'HYBRID'])

function applicationFeePaid(app: AdmissionForAiAccess) {
  return app.payments.some((p) => p.purpose === 'APPLICATION_FEE' && p.status === 'PAID')
}

function reasonForBlockedStudentAi(app?: AdmissionForAiAccess | null): string {
  if (!app) return 'لا يوجد طلب دراسة مفعل لربط المشرف الذكي به.'
  if (!applicationFeePaid(app)) return 'يتاح المشرف الذكي بعد تأكيد الإدارة لسداد رسوم التقديم وحجز المقعد.'
  if (!AI_ENABLED_STATUSES.has(app.status)) return 'يتاح المشرف الذكي بعد قبول الإدارة للطلب وتفعيل مسار الإشراف الأكاديمي.'
  if (!app.supervisorAt) return 'يتاح المشرف الذكي بعد أن تضبط الإدارة نوع الإشراف لهذا الطالب.'
  if (!AI_SUPERVISION_MODES.has(app.supervisionMode)) return 'المشرف الذكي غير مفعل لهذا الطلب حالياً؛ راجع الإدارة إذا كنت تحتاج تفعيله.'
  return 'المشرف الذكي غير متاح حالياً لهذا الحساب.'
}

export async function getStudentAiSupervisorAccess(userId: string): Promise<{ allowed: boolean; reason: string | null; admissionId: string | null }> {
  const app = await db.admissionApplication.findFirst({
    where: {
      userId,
      requestKind: { not: 'SERVICE' },
      status: { notIn: ['REJECTED'] },
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      supervisionMode: true,
      supervisorAt: true,
      payments: { select: { purpose: true, status: true } },
    },
  })
  if (!app) return { allowed: false, reason: reasonForBlockedStudentAi(null), admissionId: null }
  const allowed = applicationFeePaid(app)
    && AI_ENABLED_STATUSES.has(app.status)
    && !!app.supervisorAt
    && AI_SUPERVISION_MODES.has(app.supervisionMode)
  return { allowed, reason: allowed ? null : reasonForBlockedStudentAi(app), admissionId: app.id }
}

export async function requireStudentAiSupervisorAccess(user: { id: string; role: string }) {
  if (user.role !== 'STUDENT') return { allowed: true, reason: null, admissionId: null }
  const access = await getStudentAiSupervisorAccess(user.id)
  if (!access.allowed) {
    const err: any = new Error('AI_SUPERVISOR_LOCKED')
    err.status = 403
    err.reason = access.reason
    throw err
  }
  return access
}
