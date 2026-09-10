'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  AlertTriangle,
  Award,
  BarChart3,
  BookMarked,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  RefreshCw,
  UserCheck,
} from 'lucide-react'

interface QualityProgram {
  id: string
  titleAr: string
  category: string
  enrollments: number
  admissions: number
  books: number
  knowledgeItems: number
  studyGuides: number
  assignments: number
  exams: number
  readyExams: number
  questions: number
  sourceCoverage: number
  metadataCoverage: number
  examPassRate: number
  qualityScore: number
  band: 'STRONG' | 'GOOD' | 'NEEDS_ATTENTION' | 'CRITICAL'
  warnings: string[]
}

interface WeakBook {
  id: string
  title: string
  program: string
  semester?: number | null
  knowledgeItems: number
  hasText: boolean
  reason: string
}

interface DuplicateQuestion {
  text: string
  count: number
  exams: string[]
  programs: string[]
}

interface AtRiskStudent {
  userId: string
  student: string
  email: string
  reason: string
  program: string
  score: number | null
  nextAction: string
}

interface AcademicQualityData {
  generatedAt: string
  overview: {
    activePrograms: number
    strongPrograms: number
    programsNeedingAttention: number
    booksNeedingKnowledge: number
    readyExams: number
    totalQuestions: number
    questionSourceCoverage: number
    assessmentMetadataCoverage: number
    duplicateQuestionGroups: number
    atRiskStudents: number
    pendingAppeals: number
    supervisorMemoryCoverage: number
    microCredentials: number
    microCredentialAwards: number
    avgAttemptScore: number | null
    avgAdmissionFit: number | null
    avgThesisScore: number | null
  }
  programs: QualityProgram[]
  weakBooks: WeakBook[]
  duplicateQuestions: DuplicateQuestion[]
  atRiskStudents: AtRiskStudent[]
  supervisor: {
    totalUserMessages: number
    totalAssistantMessages: number
    voiceMessages: number
    memoryCoverage: number
    avgMemoryInteractions: number
    studentsWithMemory: number
  }
  recommendations: string[]
}

const BAND_META: Record<QualityProgram['band'], { label: string; cls: string }> = {
  STRONG: { label: 'قوي', cls: 'bg-emerald-100 text-emerald-700' },
  GOOD: { label: 'جيد', cls: 'bg-blue-100 text-blue-700' },
  NEEDS_ATTENTION: { label: 'يحتاج تحسين', cls: 'bg-amber-100 text-amber-700' },
  CRITICAL: { label: 'حرج', cls: 'bg-red-100 text-red-700' },
}

function metricValue(value: number | null | undefined, suffix = '') {
  return value == null ? '—' : `${value}${suffix}`
}

export function AdminQualityTab() {
  const [data, setData] = useState<AcademicQualityData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api<AcademicQualityData>('/api/admin/academic-quality')
      setData(res)
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل مركز الجودة الأكاديمي')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="mt-4 flex h-56 items-center justify-center rounded-2xl bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
      </div>
    )
  }

  if (error || !data) {
    return (
      <Card className="mt-4 border-red-100 bg-red-50">
        <CardContent className="p-6 text-center">
          <AlertTriangle className="mx-auto mb-2 h-8 w-8 text-red-500" />
          <p className="text-sm font-bold text-red-700">{error || 'لا توجد بيانات جودة حالياً'}</p>
          <Button onClick={load} className="mt-4 bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#183c5f]">
            إعادة التحميل
          </Button>
        </CardContent>
      </Card>
    )
  }

  const overviewCards = [
    { icon: BookMarked, label: 'برامج نشطة', value: data.overview.activePrograms, hint: `${data.overview.strongPrograms} قوية` },
    { icon: AlertTriangle, label: 'تحتاج تحسين', value: data.overview.programsNeedingAttention, hint: 'برامج أو مسارات ضعيفة' },
    { icon: ClipboardCheck, label: 'امتحانات جاهزة', value: data.overview.readyExams, hint: `${data.overview.totalQuestions} سؤال منشور` },
    { icon: BarChart3, label: 'توثيق مصادر الأسئلة', value: `${data.overview.questionSourceCoverage}%`, hint: 'sourceEvidence' },
    { icon: ClipboardCheck, label: 'اكتمال القياس', value: `${data.overview.assessmentMetadataCoverage}%`, hint: 'مهارة/صعوبة/تعليل' },
    { icon: UserCheck, label: 'طلاب متعثرون', value: data.overview.atRiskStudents, hint: `${data.overview.pendingAppeals} اعتراض قيد المراجعة` },
    { icon: Bot, label: 'تغطية ذاكرة المشرف', value: `${data.overview.supervisorMemoryCoverage}%`, hint: `${data.supervisor.studentsWithMemory} طالب` },
    { icon: Award, label: 'مهارات صغيرة', value: data.overview.microCredentials, hint: `${data.overview.microCredentialAwards} منحة` },
  ]

  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-black text-[#0f2b46]">مركز الجودة الأكاديمي</h2>
          <p className="mt-1 text-xs font-bold leading-6 text-slate-500">
            مؤشرات تشغيلية تربط البرامج والكتب وبنك المعرفة والامتحانات وذاكرة المشرف الذكي بسلوك الطلاب الفعلي.
          </p>
        </div>
        <Button onClick={load} variant="outline" className="border-[#c9a227] font-black text-[#a8841a] hover:bg-[#f7edd0]">
          <RefreshCw className="ml-1.5 h-4 w-4" /> تحديث المؤشرات
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
        {overviewCards.map((m) => (
          <Card key={m.label} className="border-[#0f2b46]/10">
            <CardContent className="p-4 text-center">
              <div className="mx-auto mb-2 w-fit rounded-xl bg-[#f7edd0] p-2 text-[#a8841a]">
                <m.icon className="h-5 w-5" />
              </div>
              <div className="text-2xl font-black text-[#0f2b46]">{m.value}</div>
              <p className="mt-1 text-[10px] font-black text-slate-500">{m.label}</p>
              <p className="mt-1 text-[10px] font-bold text-slate-400">{m.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {data.recommendations.length > 0 && (
        <Card className="border-[#c9a227]/35 bg-[#fffaf0]">
          <CardContent className="p-4">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
              <CheckCircle2 className="h-4 w-4 text-[#a8841a]" /> توصيات تشغيل الجودة هذا الأسبوع
            </h3>
            <div className="grid gap-2 md:grid-cols-2">
              {data.recommendations.map((r, i) => (
                <p key={i} className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">• {r}</p>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-[1.4fr_1fr]">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-black text-[#0f2b46]">جودة البرامج حسب المحتوى والتقييم والدعم</h3>
              <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">الأضعف أولاً</Badge>
            </div>
            <div className="space-y-3">
              {data.programs.slice(0, 12).map((p) => {
                const meta = BAND_META[p.band]
                return (
                  <article key={p.id} className="rounded-2xl border border-slate-100 bg-[#f8fafc] p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-black text-[#0f2b46]">{p.titleAr}</h4>
                        <p className="mt-1 text-[11px] font-bold text-slate-500">
                          كتب {p.books} · معرفة {p.knowledgeItems} · أدلة {p.studyGuides} · امتحانات جاهزة {p.readyExams}/{p.exams}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={`${meta.cls} hover:bg-inherit`}>{meta.label}</Badge>
                        <span className="rounded-lg bg-white px-2 py-1 text-xs font-black text-[#0f2b46]">{p.qualityScore}/100</span>
                      </div>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-4">
                      <div className="rounded-xl bg-white p-2 text-[10px] font-black text-slate-500">توثيق الأسئلة: {p.sourceCoverage}%</div>
                      <div className="rounded-xl bg-white p-2 text-[10px] font-black text-slate-500">اكتمال القياس: {p.metadataCoverage}%</div>
                      <div className="rounded-xl bg-white p-2 text-[10px] font-black text-slate-500">نجاح الامتحانات: {p.examPassRate}%</div>
                      <div className="rounded-xl bg-white p-2 text-[10px] font-black text-slate-500">طلب/تسجيل: {p.admissions + p.enrollments}</div>
                    </div>
                    {p.warnings.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {p.warnings.map((w, i) => (
                          <span key={i} className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-black text-amber-700">{w}</span>
                        ))}
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h3 className="mb-3 text-sm font-black text-[#0f2b46]">مؤشرات المشرف الذكي</h3>
              <div className="grid grid-cols-2 gap-2 text-xs font-bold text-slate-600">
                <div className="rounded-xl bg-[#f8fafc] p-3">رسائل الطلاب: <b className="text-[#0f2b46]">{data.supervisor.totalUserMessages}</b></div>
                <div className="rounded-xl bg-[#f8fafc] p-3">ردود المشرف: <b className="text-[#0f2b46]">{data.supervisor.totalAssistantMessages}</b></div>
                <div className="rounded-xl bg-[#f8fafc] p-3">رسائل صوتية: <b className="text-[#0f2b46]">{data.supervisor.voiceMessages}</b></div>
                <div className="rounded-xl bg-[#f8fafc] p-3">متوسط التفاعلات: <b className="text-[#0f2b46]">{data.supervisor.avgMemoryInteractions}</b></div>
              </div>
              <p className="mt-3 rounded-xl bg-[#f7edd0]/60 p-3 text-xs font-bold leading-6 text-[#5c4d1a]">
                تغطية الذاكرة الأكاديمية: {data.supervisor.memoryCoverage}% — كلما ارتفعت، أصبحت ردود المشرف أكثر ارتباطاً بسجل الطالب وامتحاناته وبحثه.
              </p>
            </CardContent>
          </Card>

          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h3 className="mb-3 text-sm font-black text-[#0f2b46]">متوسطات أكاديمية</h3>
              <div className="space-y-2 text-xs font-bold text-slate-600">
                <p className="rounded-xl bg-slate-50 p-3">متوسط درجات الامتحانات: {metricValue(data.overview.avgAttemptScore, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">متوسط توافق القبول الذكي: {metricValue(data.overview.avgAdmissionFit, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">متوسط درجات الأبحاث/المناقشة: {metricValue(data.overview.avgThesisScore, '%')}</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-black text-[#0f2b46]">كتب تحتاج تقوية بنك المعرفة</h3>
            {data.weakBooks.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 p-4 text-center text-xs font-bold text-emerald-700">كل الكتب المقروءة لديها معرفة كافية حالياً.</p>
            ) : (
              <div className="space-y-2">
                {data.weakBooks.map((b) => (
                  <div key={b.id} className="rounded-xl border border-slate-100 bg-[#f8fafc] p-3 text-xs">
                    <p className="font-black text-[#0f2b46]">{b.title}</p>
                    <p className="mt-1 font-bold text-slate-500">{b.program} · الفصل {b.semester || 'عام'}</p>
                    <p className="mt-1 font-bold text-amber-700">{b.reason} — عناصر معرفة: {b.knowledgeItems}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-black text-[#0f2b46]">تكرار محتمل في الأسئلة</h3>
            {data.duplicateQuestions.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 p-4 text-center text-xs font-bold text-emerald-700">لا توجد مجموعات تكرار واضحة في آخر الأسئلة.</p>
            ) : (
              <div className="space-y-2">
                {data.duplicateQuestions.map((q, i) => (
                  <div key={i} className="rounded-xl border border-amber-100 bg-amber-50/50 p-3 text-xs">
                    <p className="font-bold leading-6 text-[#0f2b46]">{q.text}</p>
                    <p className="mt-1 font-black text-amber-700">تكرر {q.count} مرات — {q.programs.join('، ') || q.exams.join('، ')}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-black text-[#0f2b46]">طلاب يحتاجون متابعة</h3>
            {data.atRiskStudents.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 p-4 text-center text-xs font-bold text-emerald-700">لا توجد إشارات تعثر واضحة حالياً.</p>
            ) : (
              <div className="space-y-2">
                {data.atRiskStudents.map((s, i) => (
                  <div key={`${s.userId}-${i}`} className="rounded-xl border border-slate-100 bg-[#f8fafc] p-3 text-xs">
                    <p className="font-black text-[#0f2b46]">{s.student}</p>
                    <p className="mt-0.5 text-[10px] text-slate-400" dir="ltr">{s.email}</p>
                    <p className="mt-1 font-bold leading-5 text-amber-700">{s.reason}{s.score != null ? ` — ${s.score}%` : ''}</p>
                    <p className="mt-1 font-bold leading-5 text-slate-600">الإجراء: {s.nextAction}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
