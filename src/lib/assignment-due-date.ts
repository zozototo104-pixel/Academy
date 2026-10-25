// موعد تسليم الواجب: تاريخ ثابت يحدده الأدمن يُقدَّم دائمًا على المدة بالأيام.
// المدة بالأيام احتياط للواجبات القديمة فقط (تاريخ تسجيل الطالب + الأيام).
export function assignmentDueAt(
  enrolledAt: Date,
  dueDays?: number | null,
  dueAtFixed?: Date | string | null,
): Date | null {
  if (dueAtFixed) return new Date(dueAtFixed)
  if (!dueDays) return null
  const d = new Date(enrolledAt)
  d.setDate(d.getDate() + dueDays)
  return d
}
