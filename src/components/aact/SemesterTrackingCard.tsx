'use client'

// بطاقة متابعة الفصول المشتركة — تُعرض بنفس الشكل والمسميات في معاينة
// الإدارة وفي لوحة الطالب، وتتغذى من مصدر البيانات الواحد
// (lib/student-tracking) حتى لا يوجد حسابان منفصلان للفصل أبدًا.
// قرار المالك 2026-11-07: المعدل الفصلي يُسمّى «مؤقت — غير معتمد» ما لم
// يوجد اعتماد مخزّن سارٍ؛ ونتائج فصل لاحق قبل الانتقال «محفوظة».

export interface SemesterTrackingView {
  semester: number
  unitExamsTotal: number
  unitExamsGraded: number
  unitAverage: number | null
  unitExempt: boolean
  semesterAverage: number | null
  semesterPassed: boolean | null
  approval: 'APPROVED' | 'PROVISIONAL'
  approvedScore: number | null
  preserved: boolean
}

export interface StudentTrackingView {
  programme: {
    earnedScore: number
    score: number | null
    progressScore: number
    weightSource: string
  } | null
  semesters: SemesterTrackingView[]
}

const SEMESTER_NAMES: Record<number, string> = {
  1: 'الفصل الأول',
  2: 'الفصل الثاني',
  3: 'الفصل الثالث',
  4: 'الفصل الرابع',
}

function fmt(value: number) {
  return Number(value.toFixed(2)).toString()
}

export function SemesterTrackingCard({ tracking }: { tracking: StudentTrackingView | null | undefined }) {
  if (!tracking || tracking.semesters.length === 0) return null
  return (
    <div className="mt-3 rounded-xl border border-[#0f2b46]/15 bg-white p-4" dir="rtl">
      <p className="text-sm font-black text-[#0f2b46]">متابعة الفصول الدراسية</p>
      <div className="mt-3 space-y-3">
        {tracking.semesters.map((s) => (
          <div key={s.semester} className="rounded-xl bg-slate-50 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-black text-[#0f2b46]">{SEMESTER_NAMES[s.semester] || `الفصل ${s.semester}`}</p>
              {s.preserved && (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-black text-amber-800">
                  نتائج سابقة محفوظة — قبل اعتماد الانتقال
                </span>
              )}
            </div>
            <div className="mt-2 space-y-1 text-xs font-bold text-slate-600">
              <p>
                {s.preserved ? 'اختبارات مصححة سابقًا' : 'اختبارات الوحدات المصححة'}: {s.unitExamsGraded} من {s.unitExamsTotal}
              </p>
              {!s.unitExempt && s.unitAverage != null && (
                <p>متوسط اختبارات وحدات الفصل: {fmt(s.unitAverage)}%</p>
              )}
              {s.semesterAverage != null && (
                <p className="flex flex-wrap items-center gap-2">
                  <span>المعدل الفصلي الشامل: {fmt(s.semesterAverage)}%</span>
                  {s.approval === 'APPROVED' ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-black text-emerald-700">معتمد</span>
                  ) : (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-black text-amber-800">مؤقت — غير معتمد</span>
                  )}
                </p>
              )}
              {s.preserved && (
                <p className="text-[11px] font-bold leading-5 text-amber-800">
                  نتائج هذا الفصل محفوظة ولا تدخل في تقدم الفصل الحالي؛ تظهر ضمن تقدم الفصل تلقائيًا عند اعتماد الفصل السابق والانتقال رسميًا، دون حذف أو إعادة تصحيح.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
      {tracking.programme && (
        <p className="mt-3 border-t border-slate-100 pt-2 text-xs font-bold text-slate-600">
          المحصّل من كامل البرنامج حتى الآن: {fmt(tracking.programme.earnedScore)}%
          <span className="mr-1 text-[11px] font-medium text-slate-500">(وفق محرك الدرجات الحالي — يشمل كل فصول البرنامج)</span>
        </p>
      )}
    </div>
  )
}
