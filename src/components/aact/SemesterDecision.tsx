'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Hourglass, RotateCcw, Send, X } from 'lucide-react'

// قرار الطالب بشأن إنهاء الفصل: نافذة الخيارين عند «جاهز للامتحان»
// وزر الرفع المستقل، ولوحة حالة الطلب. كل الوقائع المعروضة تأتي من
// موجز الخادم الوحيد (decisionBrief) — لا حسابات محلية هنا.

export type SemesterDecisionBrief = {
  decision: {
    intent: string | null
    status: string
    raiseSource: string | null
    raisedAt: string | null
    scoreAtIntent: number | null
    scoreAtRaise: number | null
  } | null
  periodEndAt: string | null
  periodEnded: boolean
  closure: { allowed: boolean; source: 'STUDENT' | 'DEADLINE' | null; reason: string }
  examTaken: boolean
  examPublished: boolean
  pendingCount: number
  provisionalAverage: number | null
  scoreAtRaise: number | null
  changedSinceRaise: boolean
  units: { graded: number; total: number; missingTitles: string[] }
  assignments: { submitted: number; total: number; missingTitles: string[] }
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('ar', { year: 'numeric', month: 'long', day: 'numeric' })
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${Math.round(value * 100) / 100}%`
}

function missingLine(titles: string[]): string {
  if (!titles.length) return ''
  const shown = titles.slice(0, 3).join('، ')
  return titles.length > 3 ? `${shown}، وغيرها (${titles.length - 3})` : shown
}

export function SemesterDecisionDialog({
  brief,
  examTitle,
  semester,
  mode,
  busy,
  onConfirm,
  onClose,
}: {
  brief: SemesterDecisionBrief
  examTitle: string
  semester: number
  mode: 'ready' | 'raise'
  busy: boolean
  onConfirm: (intent: 'EARLY_FINISH' | 'CONTINUE') => void
  onClose: () => void
}) {
  // تُركَّب النافذة بمفتاح (فصل × وضع) من الأب، فتبدأ كل مرة بحالة
  // نظيفة: الاختيار الافتراضي «استكمال» وبلا موافقة صفر مسبقة.
  const [choice, setChoice] = useState<'EARLY_FINISH' | 'CONTINUE'>('CONTINUE')
  const [consent, setConsent] = useState(false)

  const unsubmittedUnits = Math.max(0, brief.units.total - brief.units.graded)
  const unsubmittedAssignments = Math.max(0, brief.assignments.total - brief.assignments.submitted)
  const canConfirm = choice === 'CONTINUE' || consent

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" dir="rtl" role="dialog" aria-modal="true" aria-label="قرار إنهاء الفصل">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-white p-5 shadow-2xl sm:rounded-3xl">
        <div className="mb-3 flex items-start justify-between gap-3">
          <h3 className="text-base font-black text-[#0f2b46]">
            {mode === 'ready' ? 'كيف تريد متابعة الفصل الدراسي؟' : 'رفع نتيجة الفصل للإدارة'}
          </h3>
          <button type="button" onClick={onClose} disabled={busy} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100" aria-label="إغلاق">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="text-xs font-bold leading-6 text-slate-500">
          {examTitle} — الفصل {semester}. يمكنك تقديم امتحان الفصل دون إنهاء جميع اختبارات الوحدات والواجبات؛ ما لم يُقدَّم يؤثر في المعدل فقط ولا يمنعك من الامتحان.
        </p>

        <div className="mt-3 space-y-1.5 rounded-2xl bg-slate-50 p-3 text-[11px] font-bold leading-5 text-slate-600">
          <p>اختبارات الوحدات المصحّحة: {brief.units.graded}/{brief.units.total}{unsubmittedUnits > 0 ? ` — غير المقدَّمة: ${missingLine(brief.units.missingTitles)}` : ''}</p>
          <p>الواجبات المسلّمة: {brief.assignments.submitted}/{brief.assignments.total}{unsubmittedAssignments > 0 ? ` — غير المسلّمة: ${missingLine(brief.assignments.missingTitles)}` : ''}</p>
          <p>امتحان الفصل: {brief.examTaken ? 'تم تقديمه' : brief.examPublished ? 'لم يُقدَّم بعد' : 'غير منشور بعد'}</p>
          {brief.pendingCount > 0 ? <p className="text-amber-700">أعمال مقدَّمة قيد التصحيح أو المراجعة: {brief.pendingCount} — لا تُحتسب صفرًا أبدًا وتنتهي باكتمال تصحيحها.</p> : null}
          {brief.provisionalAverage != null ? <p>معدّلك المؤقت الحالي في هذا الفصل: <b className="text-[#0f2b46]">{fmtScore(brief.provisionalAverage)}</b> (تقديري — غير معتمد)</p> : null}
          <p>فترة هذا الفصل تنتهي بتاريخ: <b className="text-[#0f2b46]">{fmtDate(brief.periodEndAt)}</b></p>
        </div>

        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => setChoice('EARLY_FINISH')}
            className={`w-full rounded-2xl border p-3 text-right ${choice === 'EARLY_FINISH' ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-white hover:border-emerald-300'}`}
          >
            <p className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Send className="h-4 w-4 text-emerald-600" /> أريد إنهاء الفصل مبكرًا</p>
            <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">
              أقدّم امتحان الفصل، وبعد اكتمال تصحيحه وتصحيح درجاتي تُرفع نتيجتي للإدارة للاعتماد. الأعمال التي لم أقدّمها تُحتسب صفرًا في المعدل. إذا نجحت واستوفيت شروط الانتقال، يُفتح الفصل التالي بعد اعتماد الإدارة.
            </p>
          </button>
          {choice === 'EARLY_FINISH' ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-2xl bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-800">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0" />
              أوافق على احتساب الأعمال غير المقدَّمة صفرًا وإغلاق الفصل عند الاعتماد، وأعلم أنني أتنازل عن استكمالها داخل هذا الفصل بعد الاعتماد.
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => setChoice('CONTINUE')}
            className={`w-full rounded-2xl border p-3 text-right ${choice === 'CONTINUE' ? 'border-[#0f2b46] bg-[#f0ead2]' : 'border-slate-200 bg-white hover:border-[#0f2b46]/40'}`}
          >
            <p className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Hourglass className="h-4 w-4 text-[#a8841a]" /> أريد استكمال أعمال الفصل</p>
            <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">
              أقدّم امتحان الفصل الآن، وأواصل اختبارات الوحدات والواجبات ضمن مواعيدها. لا تُرفع نتيجة فصلي للاعتماد إلا بطلبي لاحقًا أو عند انتهاء فترة الفصل.
            </p>
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <Button type="button" onClick={() => onConfirm(choice)} disabled={busy || !canConfirm} className="flex-1 bg-emerald-600 font-black text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy ? 'جارٍ الحفظ...' : mode === 'ready' ? 'تأكيد وفتح الامتحان' : 'تأكيد القرار'}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy} className="font-black">
            إلغاء
          </Button>
        </div>
        {!canConfirm ? <p className="mt-2 text-center text-[11px] font-bold text-amber-700">لإنهاء الفصل مبكرًا فعّل موافقة احتساب الأعمال غير المقدَّمة صفرًا أولًا.</p> : null}
      </div>
    </div>
  )
}

export function SemesterDecisionPanel({
  brief,
  busy,
  onRaise,
  onWithdraw,
}: {
  brief: SemesterDecisionBrief
  busy: boolean
  onRaise: () => void
  onWithdraw: () => void
}) {
  const decision = brief.decision
  const status = decision?.status ?? 'NONE'

  if (status === 'DECIDED') return null

  if (brief.periodEnded) {
    return (
      <div className="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-800">
        انتهت فترة هذا الفصل — تُرفع نتيجتك للإدارة تلقائيًا عند اكتمال تصحيح الأعمال التي قدّمتها، والأعمال غير المقدَّمة تُحتسب صفرًا وفق القواعد.
      </div>
    )
  }

  if (status === 'RAISED') {
    return (
      <div className="mt-3 rounded-xl bg-emerald-50 p-3 text-[11px] font-bold leading-5 text-emerald-800">
        <p className="flex items-center gap-1.5 font-black"><CheckCircle2 className="h-4 w-4" /> نتيجتك مرفوعة للإدارة بانتظار الاعتماد</p>
        <p className="mt-1">
          رُفعت بتاريخ {fmtDate(decision?.raisedAt)}
          {brief.scoreAtRaise != null ? ` — نتيجتك وقت الرفع: ${fmtScore(brief.scoreAtRaise)}` : ''}
        </p>
        {brief.changedSinceRaise ? (
          <p className="mt-1 text-amber-700">تنبيه: درجاتك تغيّرت منذ الرفع — الإدارة سترى نتيجتك المحدّثة عند الاعتماد، ولن يعتمد أحد رقمًا قديمًا.</p>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={onWithdraw} disabled={busy} className="mt-2 font-black">
          <RotateCcw className="ml-1 h-3.5 w-3.5" /> سحب طلب الرفع
        </Button>
      </div>
    )
  }

  if (status === 'INTENT') {
    const waiting: string[] = []
    if (!brief.examTaken) waiting.push('تقديم امتحان الفصل وتصحيحه')
    if (brief.pendingCount > 0) waiting.push(`اكتمال تصحيح ${brief.pendingCount} من الأعمال المقدَّمة`)
    return (
      <div className="mt-3 rounded-xl bg-blue-50 p-3 text-[11px] font-bold leading-5 text-blue-900">
        <p className="font-black">طلب الإنهاء المبكر محفوظ — لم يُرفع بعد</p>
        <p className="mt-1">
          {waiting.length ? `بانتظار: ${waiting.join('، ')}. ` : ''}يُرفع تلقائيًا فور اكتمال الشروط، والأعمال غير المقدَّمة تُحتسب صفرًا عند الرفع.
        </p>
        <Button type="button" size="sm" variant="outline" onClick={onWithdraw} disabled={busy} className="mt-2 font-black">
          <RotateCcw className="ml-1 h-3.5 w-3.5" /> سحب الطلب
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-xl bg-slate-50 p-3 text-[11px] font-bold leading-5 text-slate-600">
      <p>
        {status === 'WITHDRAWN'
          ? 'سحبت طلب الرفع — ما زال بإمكانك استكمال أعمالك، والرفع مجددًا في أي وقت قبل انتهاء فترة الفصل.'
          : 'لم تطلب إنهاء الفصل مبكرًا — تُرفع نتيجتك عند انتهاء فترة الفصل أو بطلبك في أي وقت.'}
      </p>
      <Button type="button" size="sm" onClick={onRaise} disabled={busy} className="mt-2 bg-emerald-600 font-black text-white hover:bg-emerald-700">
        <Send className="ml-1 h-3.5 w-3.5" /> ارفع نتيجة فصلي للاعتماد
      </Button>
    </div>
  )
}
