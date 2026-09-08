'use client'

import { useAppStore, api } from '@/lib/store'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  ArrowLeft, ArrowRight, Loader2, ClipboardCheck, Bot, Sparkles,
  CheckCircle2, XCircle, AlertTriangle, Trophy, FileQuestion, Timer,
  BookMarked, Hourglass, ShieldAlert, Camera, CameraOff, MessageSquareWarning,
  GraduationCap,
} from 'lucide-react'

type QType = 'MCQ' | 'TF' | 'SHORT' | 'ESSAY'

interface Question {
  id: string
  order: number
  type: QType
  text: string
  options: string[] | null
  points: number
}

interface ExamData {
  exam: {
    id: string
    title: string
    passScore: number
    unitTitle?: string
    programId: string
    programTitle: string
    totalPoints?: number
    durationMin?: number
    booksCount?: number
    programCategory?: string
    books?: { id: string; title: string; author?: string | null }[]
  }
  questions: Question[]
  previousAttempts: {
    id: string
    score: number | null
    passed: boolean | null
    durationUsedMin?: number | null
    submittedAt: string
    feedback?: any
  }[]
}

interface SubmitResult {
  attemptId: string
  score: number
  rawScore: number
  maxTotal: number
  passScore: number
  passed: boolean
  overall: { summary: string; strengths: string[]; improvements: string[] }
  certificateNo?: string | null
  results: {
    questionId: string
    type: string
    text: string
    isCorrect: boolean | null
    points: number
    maxPoints: number
    aiFeedback: string
    studentAnswer: string
    correctAnswerText?: string
  }[]
}

const TYPE_AR: Record<string, string> = {
  MCQ: 'اختيار من متعدد',
  TF: 'صح أو خطأ',
  SHORT: 'إجابة قصيرة — يصححها الذكاء الاصطناعي',
  ESSAY: 'سؤال مقالي — يصححه الذكاء الاصطناعي',
}

function fmtTime(totalSec: number): string {
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export function ExamView() {
  const { activeExamId, activeExamKind, navigate, openProgram } = useAppStore()
  const { toast } = useToast()
  const [data, setData] = useState<ExamData | null>(null)
  const [loading, setLoading] = useState(true)
  const [current, setCurrent] = useState(0)
  const [mcqAnswers, setMcqAnswers] = useState<Record<string, number>>({})
  const [essayAnswers, setEssayAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<SubmitResult | null>(null)
  const [startedAt, setStartedAt] = useState<number>(Date.now())
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const submittedRef = useRef(false)

  // ===== 12.2: المراقبة الإلكترونية الاختيارية (AI Proctoring) =====
  const [proctorConsent, setProctorConsent] = useState(false)
  const [proctorEnabled, setProctorEnabled] = useState(false)
  const [proctorActive, setProctorActive] = useState(false)
  const [examStarted, setExamStarted] = useState(activeExamKind !== 'final') // امتحانات الوحدات تبدأ مباشرة
  const [violationCount, setViolationCount] = useState(0)
  const violationsRef = useRef<{ t: number; type: string }[]>([])
  const proctorVideoRef = useRef<HTMLVideoElement>(null)
  const proctorStreamRef = useRef<MediaStream | null>(null)
  const snapshotRef = useRef<string | null>(null)

  // ===== 12.2: الاعتراض على النتيجة =====
  const [appealOpen, setAppealOpen] = useState(false)
  const [appealReason, setAppealReason] = useState('')
  const [appealSent, setAppealSent] = useState(false)
  const [appealBusy, setAppealBusy] = useState(false)

  useEffect(() => {
    if (!activeExamId) return
    setLoading(true)
    setResult(null)
    setCurrent(0)
    setMcqAnswers({})
    setEssayAnswers({})
    setStartedAt(Date.now())
    setSecondsLeft(null)
    submittedRef.current = false
    // تصفير حالة المراقبة والاعتراض لكل امتحان جديد
    setProctorConsent(false)
    setProctorEnabled(false)
    setProctorActive(false)
    setExamStarted(activeExamKind !== 'final')
    setViolationCount(0)
    violationsRef.current = []
    snapshotRef.current = null
    setAppealOpen(false)
    setAppealSent(false)
    setAppealReason('')
    const url =
      activeExamKind === 'final'
        ? `/api/program-exam/detail?examId=${activeExamId}`
        : `/api/exam/detail?examId=${activeExamId}`
    api<ExamData>(url)
      .then((d) => setData(d))
      .catch((e) => toast({ title: 'خطأ', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))
  }, [activeExamId, activeExamKind])

  const answeredCount = useMemo(() => {
    if (!data) return 0
    return data.questions.filter((q) =>
      q.type === 'MCQ' || q.type === 'TF'
        ? mcqAnswers[q.id] !== undefined
        : (essayAnswers[q.id] || '').trim().length > 0
    ).length
  }, [data, mcqAnswers, essayAnswers])

  const submit = useCallback(
    async (auto: boolean = false) => {
      if (!data || submittedRef.current) return
      const unanswered = data.questions.length - answeredCount
      if (unanswered > 0 && !auto) {
        const ok = confirm(`لديك ${unanswered} سؤال بدون إجابة. هل تريد التسليم على أي حال؟`)
        if (!ok) return
      }
      submittedRef.current = true
      setSubmitting(true)
      try {
        // لقطة كاميرا أخيرة عند التسليم إن كانت المراقبة مفعلة
        let snap = snapshotRef.current
        if (proctorEnabled && proctorVideoRef.current && proctorVideoRef.current.videoWidth) {
          try {
            const cv = document.createElement('canvas')
            cv.width = 320
            cv.height = 240
            const cx = cv.getContext('2d')
            if (cx) {
              cx.drawImage(proctorVideoRef.current, 0, 0, 320, 240)
              snap = cv.toDataURL('image/jpeg', 0.55)
            }
          } catch {}
        }
        const answers = data.questions.map((q) => ({
          questionId: q.id,
          selectedOption: q.type === 'MCQ' || q.type === 'TF' ? mcqAnswers[q.id] : undefined,
          answerText: q.type === 'SHORT' || q.type === 'ESSAY' ? (essayAnswers[q.id] || '') : undefined,
        }))
        const durationUsedMin = Math.max(1, Math.round((Date.now() - startedAt) / 60000))
        const isFinal = activeExamKind === 'final'
        const d = await api<SubmitResult>(
          isFinal ? '/api/program-exam/submit' : '/api/exam/submit',
          {
            method: 'POST',
            body: JSON.stringify(
              isFinal
                ? {
                    examId: data.exam.id,
                    answers,
                    durationUsedMin,
                    proctoring: { enabled: proctorEnabled, log: violationsRef.current, snapshot: snap },
                  }
                : { examId: data.exam.id, answers }
            ),
          }
        )
        setResult(d)
        setSecondsLeft(null)
        toast({ title: 'تم التصحيح!', description: `نتيجتك: ${d.score}%` })
        window.scrollTo({ top: 0, behavior: 'smooth' })
      } catch (e: any) {
        submittedRef.current = false
        toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
      } finally {
        setSubmitting(false)
      }
    },
    [data, answeredCount, mcqAnswers, essayAnswers, startedAt, activeExamKind, proctorEnabled]
  )

  // المؤقت التنازلي للاختبارات الشاملة — تسليم تلقائي عند انتهاء الوقت
  useEffect(() => {
    if (secondsLeft === null || result || submitting) return
    if (secondsLeft <= 0) {
      toast({ title: 'انتهى الوقت', description: 'تم تسليم إجاباتك تلقائياً للتصحيح' })
      submit(true)
      return
    }
    const t = setTimeout(() => setSecondsLeft((s) => (s !== null ? s - 1 : null)), 1000)
    return () => clearTimeout(t)
  }, [secondsLeft, result, submitting, submit])

  // ===== 12.2: بدء الامتحان (بعد شاشة الموافقة على المراقبة) =====
  const startExam = async () => {
    const enable = activeExamKind === 'final' && proctorConsent
    setProctorEnabled(enable)
    setExamStarted(true)
    setStartedAt(Date.now())
    if (data?.exam.durationMin) setSecondsLeft(data.exam.durationMin * 60)
    if (enable) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        proctorStreamRef.current = stream
        setProctorActive(true)
        setTimeout(() => {
          if (proctorVideoRef.current) {
            proctorVideoRef.current.srcObject = stream
            proctorVideoRef.current.play().catch(() => {})
            // لقطة أولى لتوثيق هوية الممتحن
            try {
              const cv = document.createElement('canvas')
              cv.width = 320
              cv.height = 240
              const cx = cv.getContext('2d')
              if (cx && proctorVideoRef.current?.videoWidth) {
                cx.drawImage(proctorVideoRef.current, 0, 0, 320, 240)
                snapshotRef.current = cv.toDataURL('image/jpeg', 0.55)
              }
            } catch {}
          }
        }, 300)
      } catch {
        toast({ title: 'تعذر تشغيل الكاميرا', description: 'سيمرّ الامتحان بمراقبة تبديل النوافذ فقط', variant: 'destructive' })
      }
    }
  }

  // تتبّع مخالفات المراقبة: الخروج من الشاشة وتبديل النوافذ
  useEffect(() => {
    if (!examStarted || !proctorEnabled || result) return
    const logViolation = (type: string) => {
      if (violationsRef.current.length < 200) {
        violationsRef.current.push({ t: Date.now(), type })
        setViolationCount(violationsRef.current.length)
      }
    }
    const onVis = () => { if (document.hidden) logViolation('TAB_SWITCH') }
    const onBlur = () => logViolation('WINDOW_BLUR')
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('blur', onBlur)
    }
  }, [examStarted, proctorEnabled, result])

  // إيقاف الكاميرا عند الانتهاء أو الخروج
  useEffect(() => {
    if (result || !examStarted) {
      proctorStreamRef.current?.getTracks().forEach((t) => t.stop())
      proctorStreamRef.current = null
    }
  }, [result, examStarted])

  // ===== تقديم الاعتراض على النتيجة =====
  const submitAppeal = async () => {
    if (!result || appealReason.trim().length < 10) {
      toast({ title: 'تنبيه', description: 'اكتب سبب اعتراضك بوضوح (10 أحرف على الأقل)', variant: 'destructive' })
      return
    }
    setAppealBusy(true)
    try {
      await api('/api/program-exam/appeal', {
        method: 'POST',
        body: JSON.stringify({ attemptId: result.attemptId, reason: appealReason }),
      })
      setAppealSent(true)
      setAppealOpen(false)
      toast({ title: 'تم تقديم الاعتراض', description: 'نقلك المشرف البشري/الإدارة — ستصل النتيجة النهائية عبر الإشعارات' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setAppealBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex h-72 items-center justify-center">
        <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
      </div>
    )
  }
  if (!data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-slate-500">
        الاختبار غير متاح —{' '}
        <button className="font-bold text-[#a8841a] underline" onClick={() => navigate('dashboard')}>
          العودة للبوابة
        </button>
      </div>
    )
  }

  const q = data.questions[current]
  const elapsedMin = Math.floor((Date.now() - startedAt) / 60000)
  const isObjective = q.type === 'MCQ' || q.type === 'TF'
  const lowTime = secondsLeft !== null && secondsLeft <= 600

  // ===== 12.2: شاشة الإشعار المسبق والموافقة على المراقبة الإلكترونية (للامتحانات الشاملة) =====
  if (!result && activeExamKind === 'final' && !examStarted) {
    return (
      <div className="aact-fade-in mx-auto max-w-2xl px-4 py-10">
        <Card className="border-[#c9a227]/50 shadow-xl">
          <CardContent className="p-7">
            <div className="mb-4 flex items-center gap-2.5">
              <div className="rounded-xl bg-[#0f2b46] p-2.5 text-[#e0b83a]"><ShieldAlert className="h-6 w-6" /></div>
              <h1 className="text-lg font-black text-[#0f2b46]">قبل بدء الامتحان — إشعار مسبق</h1>
            </div>
            <div className="space-y-2.5 rounded-xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
              <p className="flex items-start gap-2"><Hourglass className="mt-0.5 h-4 w-4 shrink-0 text-[#a8841a]" /> مدة هذا الامتحان <strong>{data.exam.durationMin} دقيقة</strong> على الأقل (امتحان فصل دراسي لمستوى {data.exam.programCategory === 'DOCTORATE' ? 'الدكتوراة' : data.exam.programCategory === 'MASTERS' ? 'الماجستير' : 'الدبلوم'}) — بمجرد البدء يبدأ المؤقت ولا يتوقف.</p>
              <p className="flex items-start gap-2"><BookMarked className="mt-0.5 h-4 w-4 shrink-0 text-[#a8841a]" /> الأسئلة مبنية على الكتب المقررة ({data.exam.booksCount} كتاباً) وتشمل مقالية وتحليلية وحالات عملية — التسليم تلقائي عند انتهاء الوقت.</p>
              <p className="flex items-start gap-2"><Bot className="mt-0.5 h-4 w-4 shrink-0 text-[#a8841a]" /> يصحح المشرف الذكي إجاباتك فور التسليم ويمنحك تقريراً تحليلياً، ولحقاً اعتراض على النتيجة لمراجعتها يدوياً من المشرف البشري.</p>
            </div>

            <div className="mt-5 rounded-xl border-2 border-dashed border-[#c9a227]/60 bg-[#f7edd0]/40 p-4">
              <label className="flex cursor-pointer items-start gap-3">
                <input type="checkbox" checked={proctorConsent} onChange={(e) => setProctorConsent(e.target.checked)} className="mt-1 h-4 w-4 accent-emerald-600" />
                <span className="text-xs leading-relaxed text-[#0f2b46]">
                  <strong className="flex items-center gap-1"><Camera className="inline h-3.5 w-3.5 text-[#a8841a]" /> أوافق على تفعيل المراقبة الإلكترونية أثناء الامتحان</strong>
                  <span className="mt-1 block text-[11px] font-bold text-slate-600">
                    ستُشغّل الكاميرا في نافذة صغيرة أثناء الامتحان، ويُرصد خروجك من الشاشة أو تبديل النوافذ تلقائياً، وتُرفق لقطة توثيقية بامتحانك للإدارة (الحفاظ على نزاهة الامتحانات الطويلة). المراقبة اختيارية ويمكنك عدم تفعيلها، لكن تفعيلها يعزز اعتماد شهادتك.
                  </span>
                </span>
              </label>
            </div>

            <Button onClick={startExam} className="mt-6 w-full bg-emerald-600 py-5 font-extrabold text-white hover:bg-emerald-700">
              <ClipboardCheck className="ml-2 h-5 w-5" />
              بدء الامتحان {proctorConsent ? 'مع المراقبة الإلكترونية' : 'بدون مراقبة'} ({data.exam.durationMin} دقيقة)
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ===== Result screen =====
  if (result) {
    const pct = result.score
    return (
      <div className="aact-fade-in mx-auto max-w-4xl px-4 py-10">
        {/* Score header */}
        <Card className={`overflow-hidden border-0 text-white ${result.passed ? 'bg-emerald-600' : 'bg-amber-600'}`}>
          <CardContent className="p-7 text-center sm:p-9">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-white/15">
              {result.passed ? <Trophy className="h-9 w-9" /> : <AlertTriangle className="h-9 w-9" />}
            </div>
            <h1 className="text-2xl font-black sm:text-3xl">
              {result.passed ? 'مبروك! اجتزت الاختبار' : 'لم تجتز هذه المرة — لا تستسلم'}
            </h1>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-6">
              <div>
                <div className="text-4xl font-black sm:text-5xl">{pct}%</div>
                <div className="mt-1 text-xs font-bold opacity-85">النسبة المئوية</div>
              </div>
              <div className="h-12 w-px bg-white/25" />
              <div>
                <div className="text-4xl font-black sm:text-5xl">
                  {result.rawScore}<span className="text-xl">/{result.maxTotal}</span>
                </div>
                <div className="mt-1 text-xs font-bold opacity-85">من مجموع النقاط</div>
              </div>
              <div className="h-12 w-px bg-white/25" />
              <div>
                <div className="text-4xl font-black sm:text-5xl">{result.passScore}%</div>
                <div className="mt-1 text-xs font-bold opacity-85">حد النجاح</div>
              </div>
            </div>
            {result.certificateNo && (
              <div className="mx-auto mt-5 max-w-md rounded-xl bg-white/15 p-4 text-sm font-extrabold">
                🎓 تم إصدار رقم شهادتك: <span dir="ltr">{result.certificateNo}</span>
              </div>
            )}
          </CardContent>
        </Card>

        {/* AI feedback */}
        <Card className="mt-6 border-[#c9a227]/40">
          <CardContent className="p-5 sm:p-6">
            <h2 className="mb-3 flex items-center gap-2 text-base font-black text-[#0f2b46]">
              <span className="rounded-lg bg-[#0f2b46] p-1.5 text-[#e0b83a]"><Bot className="h-4 w-4" /></span>
              تقييم المشرف الذكي
            </h2>
            <p className="text-sm leading-relaxed text-slate-700">{result.overall.summary}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {result.overall.strengths.length > 0 && (
                <div className="rounded-xl bg-emerald-50 p-4">
                  <h3 className="mb-2 text-xs font-black text-emerald-700">نقاط القوة</h3>
                  <ul className="space-y-1.5">
                    {result.overall.strengths.map((s, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-emerald-800">
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" /> {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.overall.improvements.length > 0 && (
                <div className="rounded-xl bg-amber-50 p-4">
                  <h3 className="mb-2 text-xs font-black text-amber-700">توصيات للتحسين</h3>
                  <ul className="space-y-1.5">
                    {result.overall.improvements.map((s, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-amber-800">
                        <Sparkles className="mt-0.5 h-3 w-3 shrink-0" /> {s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* 12.2: الاعتراض على النتيجة */}
        {activeExamKind === 'final' && (
          <div className="mt-4 rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/40 p-4">
            {appealSent ? (
              <p className="flex items-center gap-2 text-xs font-black text-[#0f2b46]">
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                اعتراضك قيد المراجعة اليدوية من المشرف البشري/الإدارة — ستصل النتيجة النهائية عبر الإشعارات
              </p>
            ) : (
              <>
                <p className="text-xs font-bold leading-relaxed text-[#0f2b46]">
                  <MessageSquareWarning className="ml-1 inline h-4 w-4 text-[#a8841a]" />
                  غير مقتنع بنتيجتك؟ يحق لك الاعتراض — تُوقف نتيجتك الآلية ويُعيد المشرف البشري أو الإدارة تقييم إجاباتك يدوياً وإصدار درجة نهائية.
                </p>
                <Button size="sm" onClick={() => setAppealOpen(true)} className="mt-2.5 bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                  <MessageSquareWarning className="ml-1.5 h-3.5 w-3.5" /> اعتراض على النتيجة
                </Button>
              </>
            )}
          </div>
        )}

        {/* الخطوة التالية وفق مسار المنصة الرسمي: الامتحانات ← البحث ← مناقشة الفيديو */}
        {result.passed && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/60 p-4">
            <p className="text-xs font-bold leading-relaxed text-emerald-800">
              <GraduationCap className="ml-1 inline h-4 w-4" />
              {result.passed && result.certificateNo
                ? 'أكملت متطلبات برنامجك بالكامل!'
                : 'خطوة واحدة أقرب لبحث التخرج: عند اجتياز جميع امتحانات البرنامج تُفتح لك تلقائياً صفحة تسليم بحث التخرج، ثم تُجدول مناقشتك عبر غرفة الفيديو كونفرنس أمام اللجنة ومع الخبير الذكي.'}
            </p>
            <Button size="sm" onClick={() => navigate('dashboard')} className="mt-2.5 bg-emerald-700 font-black text-white hover:bg-emerald-800">
              <GraduationCap className="ml-1.5 h-3.5 w-3.5" /> متابعة مساري (البحث والمناقشة)
            </Button>
          </div>
        )}

        {/* Question-by-question */}
        <h2 className="mb-3 mt-8 text-lg font-black text-[#0f2b46]">تصحيح تفصيلي لكل سؤال</h2>
        <div className="space-y-4">
          {result.results.map((r, i) => (
            <Card key={r.questionId} className="border-slate-100">
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs font-black text-[#0f2b46]">
                      {i + 1}
                    </span>
                    <h3 className="text-sm font-extrabold leading-relaxed text-[#0f2b46]">{r.text}</h3>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      className={
                        r.isCorrect === true
                          ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'
                          : r.isCorrect === false
                          ? 'bg-red-100 text-red-700 hover:bg-red-100'
                          : 'bg-amber-100 text-amber-700 hover:bg-amber-100'
                      }
                    >
                      {r.points}/{r.maxPoints} نقطة
                    </Badge>
                    {r.isCorrect === true ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    ) : r.isCorrect === false ? (
                      <XCircle className="h-5 w-5 text-red-500" />
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-600">
                  <strong className="text-[#0f2b46]">إجابتك: </strong>
                  {r.studentAnswer === '(لم يجب)' ? (
                    <em className="text-slate-400">لم يجب</em>
                  ) : (
                    <span className="whitespace-pre-wrap">{r.studentAnswer}</span>
                  )}
                </div>
                {r.correctAnswerText && (
                  <div className="mt-2 rounded-lg bg-emerald-50 p-3 text-xs leading-relaxed text-emerald-800">
                    <strong>الإجابة الصحيحة: </strong>{r.correctAnswerText}
                  </div>
                )}
                <div className="mt-2 rounded-lg bg-[#f7edd0]/60 p-3 text-xs leading-relaxed text-[#5c4d1a]">
                  <strong className="flex items-center gap-1.5">
                    <Bot className="h-3.5 w-3.5" /> تقييم المشرف الذكي:
                  </strong>
                  <span className="mt-1 block">{r.aiFeedback}</span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button onClick={() => openProgram(data.exam.programId)} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
            <ArrowRight className="ml-1 h-4 w-4" /> العودة للبرنامج
          </Button>
          <Button variant="outline" onClick={() => navigate('chat')} className="border-[#c9a227] font-bold text-[#a8841a]">
            <Bot className="ml-1 h-4 w-4" /> ناقش نتيجتك مع المشرف الذكي
          </Button>
        </div>

        {/* نافذة تقديم الاعتراض */}
        <Dialog open={appealOpen} onOpenChange={setAppealOpen}>
          <DialogContent className="max-w-md" dir="rtl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
                <MessageSquareWarning className="h-5 w-5 text-[#a8841a]" /> اعتراض على نتيجة الامتحان
              </DialogTitle>
              <DialogDescription>
                يراجع اعتراضك المشرف الأكاديمي البشري أو الإدارة يدوياً — وضّح أين ترى خطأ التقييم أو ما الذي يجب إعادة النظر فيه
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3.5">
              <div className="rounded-lg bg-slate-50 p-3 text-xs font-bold text-slate-600">
                نتيجتك الآلية الحالية: {result.score}% ({result.rawScore}/{result.maxTotal} نقطة) — حد النجاح {result.passScore}%
              </div>
              <Textarea
                value={appealReason}
                onChange={(e) => setAppealReason(e.target.value)}
                placeholder="اكتب سبب الاعتراض بالتفصيل: مثل أسئلة إجابتها صحيحة قُيّمت خطأً، أو مراجع تدعم إجابتك..."
                className="min-h-28 text-sm"
              />
              <Button onClick={submitAppeal} disabled={appealBusy} className="w-full bg-emerald-600 font-extrabold text-white hover:bg-emerald-700">
                {appealBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <MessageSquareWarning className="ml-2 h-4 w-4" />}
                إرسال الاعتراض للمراجعة اليدوية
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    )
  }

  // ===== Exam taking screen =====
  return (
    <div className="aact-fade-in mx-auto max-w-3xl px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="mb-2 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">
            <ClipboardCheck className="ml-1 h-3 w-3" /> {data.exam.programTitle}
          </Badge>
          {activeExamKind === 'final' && (
            <Badge className="mb-2 bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">
              <BookMarked className="ml-1 h-3 w-3" /> اختبار شامل من الكتب المقررة
            </Badge>
          )}
        </div>
        <h1 className="text-xl font-black leading-snug text-[#0f2b46] sm:text-2xl">{data.exam.title}</h1>
        <div className="mt-2 flex flex-wrap gap-3 text-xs font-bold text-slate-500">
          <span className="flex items-center gap-1"><FileQuestion className="h-3.5 w-3.5" /> {data.questions.length} أسئلة متنوعة</span>
          <span className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> حد النجاح: {data.exam.passScore}%</span>
          {activeExamKind === 'final' && data.exam.durationMin ? (
            <span className="flex items-center gap-1"><Hourglass className="h-3.5 w-3.5" /> مدة الاختبار: {data.exam.durationMin} دقيقة</span>
          ) : (
            <span className="flex items-center gap-1"><Timer className="h-3.5 w-3.5" /> الوقت المنقضي: {elapsedMin} دقيقة</span>
          )}
          {data.exam.books && data.exam.books.length > 0 && (
            <span className="flex items-center gap-1"><BookMarked className="h-3.5 w-3.5" /> مبني على {data.exam.books.length} كتاب مقرر</span>
          )}
        </div>

        {/* شريط العد التنازلي للاختبارات الشاملة */}
        {secondsLeft !== null && (
          <div
            className={`mt-4 flex items-center justify-between rounded-xl border p-3.5 ${
              lowTime ? 'animate-pulse border-red-300 bg-red-50' : 'border-[#c9a227]/40 bg-[#f7edd0]/50'
            }`}
          >
            <div className="flex items-center gap-2 text-xs font-black text-[#0f2b46]">
              <Hourglass className={`h-4 w-4 ${lowTime ? 'text-red-600' : 'text-[#a8841a]'}`} />
              {lowTime ? 'الوقت المتبقي أقل من 10 دقائق — أكمل الإجابات والتسليم!' : 'الوقت المتبقي'}
            </div>
            <span
              dir="ltr"
              className={`font-mono text-2xl font-black tabular-nums ${lowTime ? 'text-red-600' : 'text-[#0f2b46]'}`}
            >
              {fmtTime(secondsLeft)}
            </span>
          </div>
        )}

        {/* شريط المراقبة الإلكترونية النشطة */}
        {proctorEnabled && examStarted && !result && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50 p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-black text-red-700">
              <ShieldAlert className="h-3.5 w-3.5" /> المراقبة الإلكترونية مفعلة — {violationCount} مخالفة (خروج/تبديل نوافذ)
            </p>
            <span className="text-[10px] font-bold text-red-400">تبديل النوافذ يُسجل تلقائياً ويرفق بتقرير امتحانك</span>
          </div>
        )}

        {data.previousAttempts.length > 0 && (
          <div className="mt-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
            لديك {data.previousAttempts.length} محاولة سابقة — أفضل نتيجة:{' '}
            {Math.max(...data.previousAttempts.map((a) => a.score || 0))}%
          </div>
        )}
      </div>

      {/* Progress */}
      <div className="mb-4">
        <div className="mb-1.5 flex justify-between text-xs font-extrabold text-[#0f2b46]">
          <span>السؤال {current + 1} من {data.questions.length}</span>
          <span>أجبت {answeredCount}/{data.questions.length}</span>
        </div>
        <Progress value={((current + 1) / data.questions.length) * 100} className="h-2" />
      </div>

      {/* Question navigator grid — للامتحانات الكبيرة */}
      {data.questions.length > 10 && (
        <div className="aact-scroll mb-4 max-h-28 overflow-y-auto rounded-xl border border-slate-100 bg-white p-3">
          <div className="flex flex-wrap gap-1.5" dir="rtl">
            {data.questions.map((qq, i) => {
              const answered = qq.type === 'MCQ' || qq.type === 'TF' ? mcqAnswers[qq.id] !== undefined : (essayAnswers[qq.id] || '').trim().length > 0
              return (
                <button
                  key={qq.id}
                  onClick={() => setCurrent(i)}
                  className={`h-7 w-7 rounded-md text-[10px] font-black transition-colors ${
                    i === current
                      ? 'bg-[#0f2b46] text-[#e0b83a]'
                      : answered
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {i + 1}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Question card */}
      <Card className="border-[#0f2b46]/15 shadow-lg">
        <CardContent className="p-5 sm:p-7">
          <div className="mb-4 flex items-center justify-between">
            <Badge variant="outline" className="border-[#c9a227]/50 text-[11px] font-bold text-[#a8841a]">
              {TYPE_AR[q.type] || q.type} · {q.points} نقاط
            </Badge>
          </div>
          <h2 className="mb-5 text-base font-black leading-relaxed text-[#0f2b46] sm:text-lg">{q.text}</h2>

          {isObjective && q.options && (
            <RadioGroup
              value={mcqAnswers[q.id]?.toString() ?? ''}
              onValueChange={(v) => setMcqAnswers({ ...mcqAnswers, [q.id]: Number(v) })}
              className="gap-3"
            >
              {q.options.map((opt, i) => (
                <Label
                  key={i}
                  htmlFor={`opt-${q.id}-${i}`}
                  className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 text-sm leading-relaxed transition-colors ${
                    mcqAnswers[q.id] === i
                      ? 'border-[#c9a227] bg-[#f7edd0]/60 font-bold text-[#0f2b46]'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-[#c9a227]/50'
                  }`}
                >
                  <RadioGroupItem value={i.toString()} id={`opt-${q.id}-${i}`} className="mt-0.5" />
                  <span>{opt}</span>
                </Label>
              ))}
            </RadioGroup>
          )}

          {(q.type === 'SHORT' || q.type === 'ESSAY') && (
            <div>
              <Textarea
                placeholder={
                  q.type === 'SHORT'
                    ? 'اكتب إجابتك التحليلية المركزة هنا... سيقوم المشرف الذكي بتصحيحها وفق الإجابة النموذجية من الكتب المقررة.'
                    : 'اكتب إجابتك التفصيلية هنا... سيقوم المشرف الذكي بتصحيحها فوراً بعد التسليم مع تغذية راجعة بنّاءة.'
                }
                className={`text-sm leading-relaxed ${q.type === 'ESSAY' ? 'min-h-44' : 'min-h-28'}`}
                value={essayAnswers[q.id] || ''}
                onChange={(e) => setEssayAnswers({ ...essayAnswers, [q.id]: e.target.value })}
              />
              <div className="mt-2 flex items-center justify-between text-[11px] font-bold text-slate-400">
                <span>{q.type === 'ESSAY' ? 'الحد الأدنى الموصى به: 5-8 أسطر — أعرّف، حلّل، واستشهد من الكتب' : 'إجابة مركزة من 3-5 جمل'}</span>
                <span>{(essayAnswers[q.id] || '').length} حرف</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* نافذة كاميرا المراقبة (PIP) */}
      {proctorEnabled && proctorActive && !result && (
        <div className="fixed bottom-24 left-4 z-40 overflow-hidden rounded-xl border-2 border-[#b22234]/60 shadow-2xl lg:bottom-8">
          <video ref={proctorVideoRef} muted playsInline className="h-28 w-20 object-cover sm:h-36 sm:w-28 [transform:scaleX(-1)]" />
          <span className="absolute inset-x-0 bottom-0 bg-black/60 py-0.5 text-center text-[8px] font-black text-white">مراقبة إلكترونية</span>
        </div>
      )}

      {/* Nav */}
      <div className="mt-5 flex items-center justify-between gap-3">
        <Button
          variant="outline"
          disabled={current === 0}
          onClick={() => setCurrent(current - 1)}
          className="border-[#0f2b46]/20 font-bold text-[#0f2b46]"
        >
          <ArrowRight className="ml-1 h-4 w-4" /> السابق
        </Button>

        {current < data.questions.length - 1 ? (
          <Button onClick={() => setCurrent(current + 1)} className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
            التالي <ArrowLeft className="mr-1 h-4 w-4" />
          </Button>
        ) : (
          <Button
            onClick={() => submit(false)}
            disabled={submitting}
            className="bg-emerald-600 font-extrabold text-white hover:bg-emerald-700"
          >
            {submitting ? (
              <>
                <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                المشرف الذكي يصحح إجاباتك...
              </>
            ) : (
              <>
                <Sparkles className="ml-2 h-4 w-4" />
                تسليم وتصحيح آلي
              </>
            )}
          </Button>
        )}
      </div>

      {/* Submit hint */}
      {current === data.questions.length - 1 && (
        <p className="mt-4 text-center text-xs leading-relaxed text-slate-400">
          {activeExamKind === 'final'
            ? 'الاختبار الشامل مبني على الكتب المقررة للتخصص — عند التسليم يصحح خبير الذكاء الاصطناعي الأسئلة التحليلية وفق الإجابات النموذجية'
            : 'عند التسليم يقوم المشرف الذكي بتصحيح الأسئلة المقالية وفق الإجابة النموذجية ومنحك تغذية راجعة تفصيلية'}
        </p>
      )}
    </div>
  )
}
