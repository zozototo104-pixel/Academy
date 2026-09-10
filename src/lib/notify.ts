import { db } from '@/lib/db'

// ===== مساعدات الإشعارات وسجل التدقيق =====

export async function notify(
  userId: string | null | undefined,
  type: string,
  title: string,
  body: string,
  link?: string
) {
  if (!userId) return
  try {
    await db.notification.create({ data: { userId, type, title, body, link } })
  } catch (e) {
    console.error('notify error', e)
  }
}

export async function audit(
  actor: { id?: string | null; name: string } | null,
  action: string,
  entity: string,
  entityId?: string | null,
  details?: string
) {
  try {
    await db.auditLog.create({
      data: {
        actorId: actor?.id || null,
        actorName: actor?.name || 'النظام',
        action,
        entity,
        entityId: entityId || null,
        details: details || null,
      },
    })
  } catch (e) {
    console.error('audit error', e)
  }
}

// تسميات عربية لسجل التدقيق
export const AUDIT_ACTIONS: Record<string, string> = {
  APPROVE_ADMISSION: 'قبول طلب التحاق',
  REJECT_ADMISSION: 'رفض طلب التحاق',
  REVIEW_ADMISSION: 'بدء دراسة طلب التحاق',
  UPDATE_ADMISSION_STATUS: 'تحديث حالة طلب التحاق',
  ASSIGN_SUPERVISOR: 'تعيين مشرف أكاديمي',
  APPROVE_AGENT: 'قبول طلب وكالة/اعتماد',
  REJECT_AGENT: 'رفض طلب وكالة/اعتماد',
  ISSUE_CERTIFICATE: 'إصدار شهادة',
  PAYMENT_RECEIVED: 'تسجيل دفعة مالية',
  CONFIRM_PAYMENT: 'تأكيد دفعة يدوياً',
  SCHEDULE_DEFENSE: 'جدولة مناقشة بحث',
  APPROVE_RESULT: 'اعتماد نتيجة مناقشة',
  SUBMIT_THESIS: 'تسليم بحث تخرج',
  CREATE_ASSIGNMENT: 'إنشاء واجب أكاديمي',
  UPDATE_ASSIGNMENT: 'تعديل واجب أكاديمي',
  DELETE_ASSIGNMENT: 'حذف واجب أكاديمي',
  GRADE_ASSIGNMENT: 'تصحيح واجب طالب',
  UPDATE_SETTINGS: 'تحديث إعدادات/رسوم المنصة',
  ADD_REVENUE_SHARE: 'تسجيل مستحق وكيل',
  MARK_SHARE_PAID: 'تأكيد تحويل مستحقات وكيل',
  RESOLVE_MESSAGE: 'معالجة رسالة تواصل',
}
