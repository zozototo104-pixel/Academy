// ثوابت طالب فحص جاهزية الإطلاق وحارس اكتماله ومساعدات الميزانية الزمنية
// الموحدة لمسار /api/admin/launch-quality. تعيش هنا لا في ملف المسار حتى
// تكون قابلة لاختبار الوحدة (ملفات المسارات في Next لا تصدّر إلا المعالجات
// وإعدادات المسار)، وحتى يبقى فحص الاكتمال دالة نقية تُراجَع بمعزل عن
// سلسلة التجهيز.

export const LAUNCH_QUALITY_EMAIL = 'launch.quality.student@aact.test'
export const LAUNCH_QUALITY_PROGRAM_SLUG = 'launch-quality-diagnostic-program'
export const LAUNCH_QUALITY_REFERENCE = 'AACT-LAUNCH-QUALITY'

// ميزانية كلية واحدة لطلب فحص الجودة، محسوبة من بداية الطلب ومقاسه يترك
// هامشاً لإرجاع استجابة HTTP قبل مهلة عميل الفحص (80 ثانية).
export const LAUNCH_QUALITY_REQUEST_BUDGET_MS = 70_000

// اكتمال الطالب التشخيصي: لا تُقرأ بياناته كما هي إلا إذا وُجدت كل علاقة
// تستهلكها المجسات فعلاً (تسجيل فعّال في برنامج التشخيص بوحدتين وكتاب
// ودليل دراسة على الأقل، وطلب قبول بالمرجع الثابت، وبحث بعنوان وحالة،
// وذاكرة أكاديمية مكتملة الحقول). أي نقص يعني المرور بسلسلة التجهيز
// الحالية المستقرة (idempotent) لاستكماله — لا إعادة بناء ولا ثقة عمياء
// بمجرد وجود الحساب.
export function diagnosticStudentIsComplete(student: any): boolean {
  if (!student || student.role !== 'STUDENT' || student.email !== LAUNCH_QUALITY_EMAIL) return false
  if (student.name !== 'طالب فحص جاهزية الإطلاق') return false
  const enrollment = (student.enrollments || []).find((entry: any) =>
    entry.status === 'ACTIVE' && entry.program?.slug === LAUNCH_QUALITY_PROGRAM_SLUG
      && entry.program?.units?.length >= 2
      && entry.program?.books?.length >= 1
      && entry.program?.studyGuides?.length >= 1)
  if (!enrollment) return false
  if (!(student.ownedAdmissions || []).some((entry: any) => entry.reference === LAUNCH_QUALITY_REFERENCE)) return false
  if (!(student.theses || []).some((entry: any) => !!entry.title && !!entry.status)) return false
  const memory = student.academicMemory
  return !!(memory?.profileDigest && memory?.lastConversationSummary && memory?.examSignals && memory?.thesisSignals && memory?.lastFileAnalysis)
}

// اسم خطأ صريح يحدد المرحلة التي استنفدت الميزانية. لا يُحوَّل أبداً إلى
// نجاح أو تخطٍّ: حامله يرجع دائماً فشلاً مسمّى المرحلة.
export function launchQualityDeadlineError(stage: string) {
  return `LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_${stage.replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`
}

export function isLaunchQualityDeadlineError(error: unknown): boolean {
  return String((error as any)?.message || error).startsWith('LAUNCH_QUALITY_DEADLINE_EXCEEDED_AT_')
}

export function remainingLaunchQualityBudget(deadline: number, stage: string): number {
  const remaining = Math.floor(deadline - performance.now())
  if (remaining <= 0) throw new Error(launchQualityDeadlineError(stage))
  return remaining
}
