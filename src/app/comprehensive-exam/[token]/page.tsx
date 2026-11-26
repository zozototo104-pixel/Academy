'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'

type DisplayQuestion = {
  questionId: string
  order: number
  type: string
  text: string
  displayOptions: string[]
  displayToReal: number[]
}

type ExamState = {
  attemptId: string
  questions: DisplayQuestion[]
  remainingSeconds: number
  durationMin: number
  passScore: number
  examTitle: string
  programTitle: string
}

type ResultState = {
  score: number
  passed: boolean
  qualified: boolean
  certificateSerial: string | null
  qualificationError: string | null
}

function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function ComprehensiveExamPage() {
  const params = useParams()
  const token = String(params?.token || '')
  const [loading, setLoading] = useState(!!token)
  const [error, setError] = useState(token ? '' : 'رابط الدعوة غير صحيح')
  const [exam, setExam] = useState<ExamState | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const [answers, setAnswers] = useState<Record<string, number | null>>({})
  const [remaining, setRemaining] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const submittedRef = useRef(false)

  const submit = useCallback(
    async (currentAnswers: Record<string, number | null>) => {
      if (submittedRef.current || !token) return
      submittedRef.current = true
      setSubmitting(true)
      try {
        const r = await fetch('/api/comprehensive-exams/attempt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            answers: Object.entries(currentAnswers).map(([questionId, selectedOption]) => ({ questionId, selectedOption })),
          }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok) {
          if (d?.code === 'ALREADY_SUBMITTED') {
            setResult({ score: d?.score ?? 0, passed: !!d?.passed, qualified: false, certificateSerial: null, qualificationError: null })
            return
          }
          throw new Error(d?.error || 'تعذر تسليم الامتحان')
        }
        setResult({
          score: d?.score ?? 0,
          passed: !!d?.passed,
          qualified: !!d?.qualified,
          certificateSerial: d?.certificateSerial || null,
          qualificationError: d?.qualificationError || null,
        })
      } catch (err: any) {
        setError(err?.message || 'تعذر تسليم الامتحان')
        submittedRef.current = false
      } finally {
        setSubmitting(false)
      }
    },
    [token],
  )

  useEffect(() => {
    if (!token) return
    fetch(`/api/comprehensive-exams/attempt?token=${encodeURIComponent(token)}`)
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d?.error || 'تعذر فتح الامتحان')
        if (d?.status === 'GRADED') {
          setResult({
            score: d?.score ?? 0,
            passed: !!d?.passed,
            qualified: !!d?.certificateSerial,
            certificateSerial: d?.certificateSerial || null,
            qualificationError: null,
          })
          return
        }
        setExam({
          attemptId: d?.attemptId,
          questions: Array.isArray(d?.questions) ? d.questions : [],
          remainingSeconds: d?.remainingSeconds ?? 0,
          durationMin: d?.durationMin ?? 0,
          passScore: d?.passScore ?? 60,
          examTitle: d?.examTitle || 'الامتحان الشامل',
          programTitle: d?.programTitle || '',
        })
        setRemaining(d?.remainingSeconds ?? 0)
      })
      .catch((err: any) => setError(err?.message || 'تعذر فتح الامتحان'))
      .finally(() => setLoading(false))
  }, [token])

  // Countdown — at zero the exam submits itself with the answers given.
  useEffect(() => {
    if (!exam || result) return
    if (remaining <= 0) {
      submit(answers)
      return
    }
    const t = setTimeout(() => setRemaining((v) => v - 1), 1000)
    return () => clearTimeout(t)
  }, [exam, result, remaining, answers, submit])

  if (loading) {
    return (
      <div dir="rtl" className="mx-auto max-w-2xl px-4 py-16 text-center text-sm font-bold text-slate-600">
        جاري فتح الامتحان…
      </div>
    )
  }

  if (error && !exam) {
    return (
      <div dir="rtl" className="mx-auto max-w-2xl px-4 py-16">
        <div className="rounded-2xl border border-red-300 bg-red-50 p-6 text-center">
          <h1 className="text-lg font-black text-red-900">تعذر فتح الامتحان</h1>
          <p className="mt-2 text-sm font-bold leading-relaxed text-red-800">{error}</p>
          <p className="mt-3 text-xs leading-relaxed text-slate-600">
            إن انتهت صلاحية الدعوة أو أُلغيت، تواصل مع إدارة الأكاديمية لتجديدها — التجديد قرار الإدارة فقط.
          </p>
        </div>
      </div>
    )
  }

  if (result) {
    return (
      <div dir="rtl" className="mx-auto max-w-2xl px-4 py-16">
        <div className={`rounded-2xl border p-6 text-center ${result.passed ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
          <h1 className={`text-xl font-black ${result.passed ? 'text-emerald-900' : 'text-red-900'}`}>
            {result.passed ? 'مبارك — نجحت في الامتحان الشامل' : 'لم تنجح هذه المرة'}
          </h1>
          <p className="mt-3 text-lg font-black text-slate-900">النتيجة: {result.score}%</p>
          {result.passed && result.qualified && result.certificateSerial && (
            <p className="mt-3 text-sm font-bold leading-relaxed text-emerald-900">
              صدرت لك شهادة معادلة من الأكاديمية — الرقم التسلسلي: <span dir="ltr">{result.certificateSerial}</span>
            </p>
          )}
          {result.passed && !result.qualified && (
            <p className="mt-3 text-sm font-bold leading-relaxed text-amber-800">
              نجحت بالامتحان، لكن إصدار الشهادة توقف: {result.qualificationError || 'راجع الإدارة'} — لن تضيع نتيجتك،
              وستكمل الإدارة التأهيل.
            </p>
          )}
          {!result.passed && (
            <p className="mt-3 text-sm font-bold leading-relaxed text-slate-700">
              لم يُسجَّل أي رصيد — إعادة الدعوة قرار الإدارة فقط.
            </p>
          )}
        </div>
      </div>
    )
  }

  if (!exam) return null

  const answeredCount = Object.values(answers).filter((v) => v !== null && v !== undefined).length

  return (
    <div dir="rtl" className="mx-auto max-w-3xl px-4 py-8">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div>
          <h1 className="text-base font-black text-slate-900">{exam.examTitle}</h1>
          <p className="text-xs font-bold text-slate-500">{exam.programTitle}</p>
        </div>
        <div className="text-left">
          <div className={`text-xl font-black tabular-nums ${remaining < 300 ? 'text-red-700' : 'text-teal-700'}`} dir="ltr">
            {formatTime(remaining)}
          </div>
          <div className="text-[11px] font-bold text-slate-500">
            أجبت عن {answeredCount} من {exam.questions.length} — النجاح {exam.passScore}%
          </div>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        محاولة واحدة فقط — لا تغلق الصفحة ولا تعيد تحميلها. عند انتهاء الوقت يُرسَل الامتحان تلقائياً بما أجبت عنه.
      </p>

      <div className="mt-4 space-y-4">
        {exam.questions.map((q, idx) => (
          <div key={q.questionId} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm font-black leading-relaxed text-slate-900">
              {idx + 1}. {q.text}
            </p>
            <div className="mt-3 space-y-2">
              {q.displayOptions.map((opt, oi) => (
                <label
                  key={oi}
                  className={`flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm font-bold ${
                    answers[q.questionId] === oi ? 'border-teal-600 bg-teal-50 text-teal-900' : 'border-slate-200 text-slate-800'
                  }`}
                >
                  <input
                    type="radio"
                    name={q.questionId}
                    checked={answers[q.questionId] === oi}
                    onChange={() => setAnswers((prev) => ({ ...prev, [q.questionId]: oi }))}
                    className="mt-1 accent-teal-700"
                  />
                  <span>{opt}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      {error && <p className="mt-4 rounded-xl border border-red-300 bg-red-50 px-3 py-2 text-sm font-bold text-red-800">{error}</p>}

      <button
        onClick={() => submit(answers)}
        disabled={submitting}
        className="mt-6 w-full rounded-xl bg-teal-700 px-4 py-3 text-sm font-black text-white disabled:opacity-50"
      >
        {submitting ? 'جاري التسليم…' : 'تسليم الامتحان'}
      </button>
    </div>
  )
}
