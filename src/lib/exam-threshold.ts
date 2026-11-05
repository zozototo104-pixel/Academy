// حدّ نجاح الامتحان الواحد — قاعدة دورة الحياة (قرار المالك 2026-11-05):
// قبل نشر الامتحان الحدّ تشغيلي وقابل للتعديل بحرية؛ بعد النشر (READY)
// يُثبّت لهذا الإصدار ولا يتغيّر على الطلاب الذين يخضعون له؛ إصدار جديد
// (صفّ امتحان جديد) يجوز أن يحمل حدًّا مختلفًا دون أثر رجعي؛ وإعادة
// المحاولة تُحسب بحدّ إصدار الامتحان المقدَّمة عليه — وهو نفس الصفّ،
// فتبقى محاولاته السابقة وتصنيفها (ناجح/راسب) ثابتة ما دام الحدّ مثبّتًا.
// التنفيذ: كل مسار كتابة يحدّث امتحانًا قائمًا يمرّر بياناته عبر
// pinThresholdIfPublished قبل الحفظ.
export const PUBLISHED_EXAM_STATUS = 'READY'

export function isPublishedExamStatus(status: string | null | undefined): boolean {
  return status === PUBLISHED_EXAM_STATUS
}

export type ThresholdPinResult<T extends { passScore?: number | null }> = {
  data: T
  pinned: boolean
}

// إن كان الامتحان القائم منشورًا وجاءت البيانات بحدّ مختلف، تُستبدل قيمة
// الحدّ بالقيمة الحالية المثبّتة (يبقى شكل البيانات ثابتًا) ويُعلَّم التثبيت.
// غير المنشور أو غير الموجود بعد: البيانات كما هي.
export function pinThresholdIfPublished<T extends { passScore?: number | null }>(
  existing: { status?: string | null; passScore?: number | null } | null | undefined,
  data: T,
): ThresholdPinResult<T> {
  if (!existing || !isPublishedExamStatus(existing.status)) return { data, pinned: false }
  if (data.passScore == null || existing.passScore == null) return { data, pinned: false }
  if (Number(data.passScore) === Number(existing.passScore)) return { data, pinned: false }
  return { data: { ...data, passScore: existing.passScore }, pinned: true }
}
