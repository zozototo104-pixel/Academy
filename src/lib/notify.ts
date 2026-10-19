import { db } from '@/lib/db'
import { isAactTestEmail } from '@/lib/prod-safety'

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
    const user = await db.user.findUnique({ where: { id: userId }, select: { email: true } }).catch(() => null)
    if (isAactTestEmail(user?.email)) return
    await db.notification.create({ data: { userId, type, title, body, link } })
  } catch (e) {
    console.error('notify error', e)
  }
}

export async function notifyAdmins(type: string, title: string, body: string, link?: string) {
  try {
    const admins = await db.user.findMany({ where: { role: 'ADMIN', status: 'ACTIVE' }, select: { id: true, email: true } })
    const targets = admins.filter((admin) => !isAactTestEmail(admin.email))
    if (!targets.length) return
    await db.notification.createMany({ data: targets.map((admin) => ({ userId: admin.id, type, title, body, link })) })
  } catch (e) {
    console.error('notifyAdmins error', e)
  }
}

export async function notifyProgramNeedsQualityApproval(programId: string, reason: string) {
  try {
    const program = await db.program.findUnique({ where: { id: programId }, select: { titleAr: true } })
    const title = program?.titleAr || 'برنامج'
    await notifyAdmins(
      'GENERAL',
      'برنامج يحتاج اعتماد الإدارة',
      `تم تعديل «${title}» ويحتاج مراجعة واعتماداً من مركز الجودة قبل ظهوره كجاهز للطلاب. السبب: ${reason}`,
      `/?view=admin&tab=quality&programId=${encodeURIComponent(programId)}`
    )
  } catch (e) {
    console.error('notifyProgramNeedsQualityApproval error', e)
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
  REBUILD_BOOK_KNOWLEDGE: 'تحليل كتاب لبنك المعرفة',
  REBUILD_PROGRAM_KNOWLEDGE: 'بناء بنك معرفة البرنامج',
  GENERATE_STUDY_GUIDE: 'توليد دليل دراسة',
  UPDATE_STUDY_GUIDE: 'تعديل دليل دراسة',
  DELETE_STUDY_GUIDE: 'حذف دليل دراسة',
  GENERATE_CURRICULUM_UNITS: 'اقتراح وحدات المنهج من الكتب',
  UPDATE_CURRICULUM_UNIT: 'تعديل وحدة منهج',
  DELETE_CURRICULUM_UNIT: 'حذف وحدة منهج',
  UPDATE_PROGRAM_READINESS: 'تحديث جاهزية/اعتماد منهج برنامج',
  GENERATE_QUESTION_BANK: 'توليد أسئلة لبنك الأسئلة',
  ADD_QUESTION_BANK_ITEM: 'إضافة سؤال يدوي لبنك الأسئلة',
  IMPORT_QUESTION_BANK: 'استيراد أسئلة إلى بنك الأسئلة',
  COPY_EXAM_TO_QUESTION_BANK: 'نسخ أسئلة اختبار إلى بنك الأسئلة',
  REVIEW_QUESTION_BANK_ITEM: 'مراجعة سؤال في بنك الأسئلة',
  GENERATE_PROGRAM_EXAM_FROM_QUESTION_BANK: 'توليد امتحان من بنك الأسئلة',
  IMPORT_PROGRAM_CATALOG: 'استيراد كتالوج البرامج',
  UPDATE_SETTINGS: 'تحديث إعدادات/رسوم المنصة',
  SYSTEM_UPDATE: 'تحديث نظام/صلاحيات',
  ADD_REVENUE_SHARE: 'تسجيل مستحق وكيل',
  MARK_SHARE_PAID: 'تأكيد تحويل مستحقات وكيل',
  RESOLVE_MESSAGE: 'معالجة رسالة تواصل',
}
