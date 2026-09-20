'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertTriangle,
  Award,
  BarChart3,
  BookMarked,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  Clock,
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

interface StrongProgram {
  id: string
  titleAr: string
  category: string
  qualityScore: number
  band: QualityProgram['band']
  enrollments: number
  admissions: number
  readyExams: number
  books: number
  sourceCoverage: number
  metadataCoverage: number
}

interface DemandSpecialty {
  id: string
  titleAr: string
  category: string
  demandScore: number
  enrollments: number
  admissions: number
}

interface WeakSupervisorReply {
  id: string
  supervisor: string
  student: string
  email: string
  reason: string
  mode?: string | null
  kind?: string | null
  excerpt: string
  createdAt: string
}

interface ChatReviewItem {
  id: string
  messageId: string
  reason?: string | null
  note?: string | null
  status: 'NEW' | 'IN_REVIEW' | 'REVIEWED' | 'IGNORED'
  createdAt: string
  student: { id: string; name: string; email: string }
  program?: { id: string; titleAr: string; category: string } | null
  question?: string | null
  answer: string
}

interface CurriculumUnitReviewItem {
  id: string
  title: string
  summary?: string | null
  objectives: string[]
  content: { heading: string; body: string }[]
  order: number
}

interface QuestionBankReviewItem {
  id: string
  type: string
  text: string
  options?: string | null
  correctAnswer?: string | null
  modelAnswer?: string | null
  sourceEvidence?: string | null
  sourceBookTitle?: string | null
  difficulty?: string | null
  cognitiveSkill?: string | null
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'ARCHIVED'
  createdAt: string
}

interface QuestionBankStats {
  total: number
  pending: number
  approved: number
  rejected: number
  byDifficulty: Record<string, number>
  byType: Record<string, number>
}

interface ProgramReadinessItem {
  id: string
  titleAr: string
  category: string
  demandCount: number
  enrollments: number
  admissions: number
  registrationStatus: 'OPEN' | 'CLOSED'
  academicReadinessStatus: 'NEEDS_PREPARATION' | 'IN_PREPARATION' | 'READY_FOR_REVIEW' | 'APPROVED'
  academicApproved: boolean
  curriculumDueAt?: string | null
  semestersCount: number
  counts: { books: number; units: number; unitsWithObjectives: number; knowledgeItems: number; exams: number; readyExams: number; assignments: number; assessments: number }
  targets: { books: number; units: number; knowledgeItems: number; assessments: number }
  checks: Record<string, boolean>
  missing: string[]
  readyWithoutManualApproval: boolean
  isCurriculumReady: boolean
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
    successRate: number
    appealRate: number
    averageResponseSeconds: number | null
    responsePairs: number
    weakSupervisorReplies: number
    weakSupervisorReplyRate: number
    supervisorMemoryCoverage: number
    microCredentials: number
    microCredentialAwards: number
    avgAttemptScore: number | null
    avgAdmissionFit: number | null
    avgThesisScore: number | null
  }
  programs: QualityProgram[]
  strongPrograms: StrongProgram[]
  topDemandSpecialties: DemandSpecialty[]
  weakBooks: WeakBook[]
  duplicateQuestions: DuplicateQuestion[]
  atRiskStudents: AtRiskStudent[]
  weakSupervisorReplies: WeakSupervisorReply[]
  supervisor: {
    totalUserMessages: number
    totalAssistantMessages: number
    voiceMessages: number
    memoryCoverage: number
    avgMemoryInteractions: number
    studentsWithMemory: number
    averageResponseSeconds: number | null
    responsePairs: number
    weakReplyRate: number
  }
  recommendations: string[]
}

const BAND_META: Record<QualityProgram['band'], { label: string; cls: string }> = {
  STRONG: { label: 'قوي', cls: 'bg-emerald-100 text-emerald-700' },
  GOOD: { label: 'جيد', cls: 'bg-blue-100 text-blue-700' },
  NEEDS_ATTENTION: { label: 'يحتاج تحسين', cls: 'bg-amber-100 text-amber-700' },
  CRITICAL: { label: 'حرج', cls: 'bg-red-100 text-red-700' },
}

const FEEDBACK_REASON_LABEL: Record<string, string> = {
  TOO_GENERAL: 'الرد عام جدًا',
  NOT_RELATED: 'غير مرتبط بالمنهج أو السؤال',
  UNCLEAR: 'غير واضح',
  WRONG: 'يحتوي خطأ',
  DID_NOT_ANSWER: 'لم يجب عن السؤال',
  WEAK_SOURCE: 'مصدره غير كافٍ',
  OTHER: 'سبب آخر',
}

const REVIEW_STATUS_LABEL: Record<ChatReviewItem['status'], string> = {
  NEW: 'جديد',
  IN_REVIEW: 'قيد المراجعة',
  REVIEWED: 'تمت المراجعة',
  IGNORED: 'تم التجاهل',
}

const CURRICULUM_STATUS_LABEL: Record<ProgramReadinessItem['academicReadinessStatus'], string> = {
  NEEDS_PREPARATION: 'معتمد وبحاجة لتجهيز',
  IN_PREPARATION: 'قيد تجهيز المنهج',
  READY_FOR_REVIEW: 'جاهز للمراجعة',
  APPROVED: 'منهج جاهز ومعتمد',
}

const READINESS_CHECK_LABEL: Record<string, string> = {
  description: 'الوصف الأكاديمي',
  admissionRules: 'قواعد القبول',
  semesters: 'عدد الفصول',
  booksPerSemester: 'كتاب لكل فصل',
  units: 'الوحدات المنظمة',
  unitObjectives: 'أهداف كل وحدة',
  knowledge: 'بنك المعرفة',
  assessments: 'اختبار أو واجب',
  manualApproval: 'اعتماد الإدارة',
}

function metricValue(value: number | null | undefined, suffix = '') {
  return value == null ? '—' : `${value}${suffix}`
}

function formatSeconds(value: number | null | undefined) {
  if (value == null) return '—'
  if (value < 60) return `${value}ث`
  const minutes = Math.floor(value / 60)
  const seconds = value % 60
  return seconds ? `${minutes}د ${seconds}ث` : `${minutes}د`
}

export function AdminQualityTab() {
  const [data, setData] = useState<AcademicQualityData | null>(null)
  const [reviewItems, setReviewItems] = useState<ChatReviewItem[]>([])
  const [readinessItems, setReadinessItems] = useState<ProgramReadinessItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reviewBusyId, setReviewBusyId] = useState<string | null>(null)
  const [readinessBusyId, setReadinessBusyId] = useState<string | null>(null)
  const [unitBusyId, setUnitBusyId] = useState<string | null>(null)
  const [unitReviewOpen, setUnitReviewOpen] = useState(false)
  const [unitReviewProgram, setUnitReviewProgram] = useState<ProgramReadinessItem | null>(null)
  const [unitReviewItems, setUnitReviewItems] = useState<CurriculumUnitReviewItem[]>([])
  const [questionBankOpen, setQuestionBankOpen] = useState(false)
  const [questionBankProgram, setQuestionBankProgram] = useState<ProgramReadinessItem | null>(null)
  const [questionBankItems, setQuestionBankItems] = useState<QuestionBankReviewItem[]>([])
  const [questionBankStats, setQuestionBankStats] = useState<QuestionBankStats | null>(null)
  const [questionBankBusyId, setQuestionBankBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [res, reviews, readiness] = await Promise.all([
        api<AcademicQualityData>('/api/admin/academic-quality'),
        api<{ items: ChatReviewItem[] }>('/api/chat-feedback').catch(() => ({ items: [] })),
        api<{ items: ProgramReadinessItem[] }>('/api/admin/program-readiness').catch(() => ({ items: [] })),
      ])
      setData(res)
      setReviewItems(reviews.items || [])
      setReadinessItems(readiness.items || [])
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل مركز الجودة الأكاديمي')
    } finally {
      setLoading(false)
    }
  }, [])

  const updateReviewStatus = async (id: string, status: ChatReviewItem['status']) => {
    setReviewBusyId(id)
    try {
      await api('/api/chat-feedback', { method: 'PATCH', body: JSON.stringify({ id, status }) })
      setReviewItems((prev) => prev.map((item) => item.id === id ? { ...item, status } : item))
    } finally {
      setReviewBusyId(null)
    }
  }

  const updateProgramReadiness = async (programId: string, body: Record<string, any>) => {
    setReadinessBusyId(programId)
    try {
      const res = await api<{ item: ProgramReadinessItem }>('/api/admin/program-readiness', {
        method: 'PATCH',
        body: JSON.stringify({ programId, ...body }),
      })
      setReadinessItems((prev) => prev.map((item) => item.id === programId ? res.item : item))
    } finally {
      setReadinessBusyId(null)
    }
  }

  const suggestUnits = async (program: ProgramReadinessItem) => {
    setReadinessBusyId(program.id)
    try {
      try {
        await api('/api/admin/program-units/suggest', { method: 'POST', body: JSON.stringify({ programId: program.id }) })
      } catch (e: any) {
        if (String(e?.message || '').includes('توجد وحدات') && confirm('توجد وحدات حالية. هل تريد استبدالها بخطة مقترحة جديدة من الكتب؟')) {
          await api('/api/admin/program-units/suggest', { method: 'POST', body: JSON.stringify({ programId: program.id, replace: true }) })
        } else {
          throw e
        }
      }
      const readiness = await api<{ items: ProgramReadinessItem[] }>('/api/admin/program-readiness')
      setReadinessItems(readiness.items || [])
      await openUnitReview(program)
    } finally {
      setReadinessBusyId(null)
    }
  }

  const openUnitReview = async (program: ProgramReadinessItem) => {
    setUnitReviewProgram(program)
    setUnitReviewOpen(true)
    setUnitBusyId('loading')
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>(`/api/admin/program-units?programId=${program.id}`)
      setUnitReviewItems(res.units || [])
    } finally {
      setUnitBusyId(null)
    }
  }

  const patchUnit = async (unit: CurriculumUnitReviewItem, data: Partial<CurriculumUnitReviewItem>) => {
    if (!unitReviewProgram) return
    setUnitBusyId(unit.id)
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>('/api/admin/program-units', {
        method: 'PATCH',
        body: JSON.stringify({ programId: unitReviewProgram.id, unitId: unit.id, ...data }),
      })
      setUnitReviewItems(res.units || [])
    } finally {
      setUnitBusyId(null)
    }
  }

  const addUnit = async () => {
    if (!unitReviewProgram) return
    setUnitBusyId('new')
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>('/api/admin/program-units', {
        method: 'POST',
        body: JSON.stringify({
          programId: unitReviewProgram.id,
          title: 'وحدة جديدة قابلة للمراجعة',
          summary: 'أضف ملخص الوحدة هنا.',
          objectives: ['هدف تعلم قابل للقياس'],
          content: [{ heading: 'محتوى الوحدة', body: 'أضف محاور ومحتوى الوحدة هنا.' }],
        }),
      })
      setUnitReviewItems(res.units || [])
    } finally {
      setUnitBusyId(null)
    }
  }

  const deleteUnit = async (unitId: string) => {
    if (!unitReviewProgram || !confirm('حذف هذه الوحدة من خطة المنهج؟')) return
    setUnitBusyId(unitId)
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>(`/api/admin/program-units?programId=${unitReviewProgram.id}&unitId=${unitId}`, { method: 'DELETE' })
      setUnitReviewItems(res.units || [])
    } finally {
      setUnitBusyId(null)
    }
  }

  const openQuestionBank = async (program: ProgramReadinessItem) => {
    setQuestionBankProgram(program)
    setQuestionBankOpen(true)
    setQuestionBankBusyId('loading')
    try {
      const res = await api<{ items: QuestionBankReviewItem[]; stats: QuestionBankStats }>(`/api/admin/question-bank?programId=${program.id}`)
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
    } finally {
      setQuestionBankBusyId(null)
    }
  }

  const generateQuestionBank = async (program: ProgramReadinessItem) => {
    setQuestionBankProgram(program)
    setQuestionBankOpen(true)
    setQuestionBankBusyId('generate')
    try {
      const res = await api<{ items: QuestionBankReviewItem[]; stats: QuestionBankStats }>('/api/admin/question-bank', {
        method: 'POST',
        body: JSON.stringify({ programId: program.id, count: 12 }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
    } finally {
      setQuestionBankBusyId(null)
    }
  }

  const updateQuestionBankStatus = async (question: QuestionBankReviewItem, status: QuestionBankReviewItem['status']) => {
    if (!questionBankProgram) return
    setQuestionBankBusyId(question.id)
    try {
      const res = await api<{ item: QuestionBankReviewItem }>('/api/admin/question-bank', {
        method: 'PATCH',
        body: JSON.stringify({ id: question.id, status }),
      })
      setQuestionBankItems((prev) => prev.map((q) => q.id === question.id ? res.item : q))
      const fresh = await api<{ stats: QuestionBankStats }>(`/api/admin/question-bank?programId=${questionBankProgram.id}`)
      setQuestionBankStats(fresh.stats || null)
    } finally {
      setQuestionBankBusyId(null)
    }
  }

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
    { icon: CheckCircle2, label: 'نسبة النجاح', value: `${data.overview.successRate}%`, hint: 'كل الاختبارات المصححة' },
    { icon: AlertTriangle, label: 'نسبة الاعتراضات', value: `${data.overview.appealRate}%`, hint: `${data.overview.pendingAppeals} قيد المراجعة` },
    { icon: Clock, label: 'متوسط زمن الرد', value: formatSeconds(data.overview.averageResponseSeconds), hint: `${data.overview.responsePairs} رد محسوب` },
    { icon: Bot, label: 'ردود مشرف ضعيفة', value: data.overview.weakSupervisorReplies, hint: `${data.overview.weakSupervisorReplyRate}% من الردود` },
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

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
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

      <Card className="border-amber-200 bg-amber-50/50">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-black text-[#0f2b46]">تجهيز واعتماد المناهج للبرامج المسجل بها</h3>
              <p className="mt-1 text-[11px] font-bold text-slate-500">تظهر هنا فقط البرامج التي عليها طلبات أو طلاب فعلياً وتحتاج تجهيزاً أو اعتماداً أكاديمياً.</p>
            </div>
            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">{readinessItems.length} برنامج</Badge>
          </div>

          {readinessItems.length === 0 ? (
            <p className="rounded-xl bg-emerald-50 p-4 text-center text-xs font-bold text-emerald-700">لا توجد برامج مطلوبة تحتاج تجهيزاً حالياً.</p>
          ) : (
            <div className="space-y-4">
              {readinessItems.map((item) => {
                const busy = readinessBusyId === item.id
                const due = item.curriculumDueAt ? new Date(item.curriculumDueAt) : null
                return (
                  <article key={item.id} className="rounded-2xl border border-amber-100 bg-white p-4 text-xs shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <h4 className="text-sm font-black text-[#0f2b46]">{item.titleAr}</h4>
                        <p className="mt-1 font-bold text-slate-500">طلاب/طلبات: {item.demandCount} · تسجيلات {item.enrollments} · طلبات قبول {item.admissions}</p>
                        {due && <p className="mt-1 font-bold text-amber-700">موعد التجهيز المتوقع: {due.toLocaleString('ar-EG')}</p>}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{CURRICULUM_STATUS_LABEL[item.academicReadinessStatus]}</Badge>
                        <Badge className={item.registrationStatus === 'OPEN' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-700 hover:bg-slate-100'}>
                          التسجيل: {item.registrationStatus === 'OPEN' ? 'مفتوح' : 'مغلق'}
                        </Badge>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="rounded-xl bg-[#f8fafc] p-3 font-black text-slate-600">الكتب: {item.counts.books}/{item.targets.books}</div>
                      <div className="rounded-xl bg-[#f8fafc] p-3 font-black text-slate-600">الوحدات: {item.counts.units}/{item.targets.units}</div>
                      <div className="rounded-xl bg-[#f8fafc] p-3 font-black text-slate-600">بنك المعرفة: {item.counts.knowledgeItems > 0 ? 'جاهز' : 'غير جاهز'} ({item.counts.knowledgeItems})</div>
                      <div className="rounded-xl bg-[#f8fafc] p-3 font-black text-slate-600">الاختبارات/الواجبات: {item.counts.assessments}/{item.targets.assessments}</div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {Object.entries(item.checks).map(([key, ok]) => (
                        <span key={key} className={`rounded-full px-2 py-1 text-[10px] font-black ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                          {ok ? '✓' : '×'} {READINESS_CHECK_LABEL[key] || key}
                        </span>
                      ))}
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" className="border-[#c9a227] text-xs font-black text-[#a8841a]" onClick={() => window.dispatchEvent(new CustomEvent('aact-admin-tab', { detail: { tab: 'books', programId: item.id, section: 'books', subSection: 'add' } }))}>رفع كتب البرنامج</Button>
                      <Button size="sm" variant="outline" className="border-[#c9a227] text-xs font-black text-[#a8841a]" onClick={() => window.dispatchEvent(new CustomEvent('aact-admin-tab', { detail: { tab: 'books', programId: item.id, section: 'knowledge' } }))}>بناء بنك المعرفة</Button>
                      <Button size="sm" variant="outline" className="text-xs font-black" disabled={busy} onClick={() => suggestUnits(item)}>
                        {busy ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                        اقتراح وحدات من الكتب
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => openUnitReview(item)}>مراجعة الوحدات</Button>
                      <Button size="sm" variant="outline" className="text-xs font-black" disabled={questionBankBusyId === 'generate'} onClick={() => generateQuestionBank(item)}>
                        {questionBankBusyId === 'generate' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                        توليد أسئلة للبنك
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => openQuestionBank(item)}>مراجعة بنك الأسئلة</Button>
                      <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => window.dispatchEvent(new CustomEvent('aact-admin-tab', { detail: { tab: 'books', programId: item.id, section: 'exams' } }))}>توليد/مراجعة الاختبارات</Button>
                      <Button
                        size="sm"
                        disabled={busy || !item.readyWithoutManualApproval}
                        onClick={() => updateProgramReadiness(item.id, { approve: true })}
                        className="bg-emerald-700 text-xs font-black text-white hover:bg-emerald-800 disabled:opacity-50"
                      >
                        {busy ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : <CheckCircle2 className="ml-1 h-3 w-3" />}
                        اعتماد المنهج
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => updateProgramReadiness(item.id, { registrationStatus: item.registrationStatus === 'OPEN' ? 'CLOSED' : 'OPEN' })}
                        className="text-xs font-black"
                      >
                        {item.registrationStatus === 'OPEN' ? 'إغلاق التسجيل' : 'فتح التسجيل'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => updateProgramReadiness(item.id, { reopenPreparation: true, setDue24h: true })}
                        className="text-xs font-black"
                      >
                        بدء تجهيز 24 ساعة
                      </Button>
                    </div>
                    {!item.readyWithoutManualApproval && (
                      <p className="mt-3 rounded-xl bg-amber-50 p-3 font-bold leading-6 text-amber-700">
                        لا يمكن اعتماد المنهج بعد: أكمل العناصر الناقصة أولاً، ثم عُد للاعتماد اليدوي.
                      </p>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border-red-100 bg-red-50/40">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-black text-[#0f2b46]">ردود المشرف الذكي التي تحتاج مراجعة</h3>
              <p className="mt-1 text-[11px] font-bold text-slate-500">بلاغات الطلاب المباشرة على الردود غير المفيدة أو غير الدقيقة.</p>
            </div>
            <Badge className="bg-red-100 text-red-700 hover:bg-red-100">{reviewItems.filter((i) => i.status !== 'REVIEWED' && i.status !== 'IGNORED').length} مفتوحة</Badge>
          </div>

          {reviewItems.length === 0 ? (
            <p className="rounded-xl bg-emerald-50 p-4 text-center text-xs font-bold text-emerald-700">لا توجد ردود مبلغ عنها من الطلاب حالياً.</p>
          ) : (
            <div className="space-y-3">
              {reviewItems.slice(0, 8).map((item) => (
                <article key={item.id} className="rounded-2xl border border-red-100 bg-white p-4 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-black text-[#0f2b46]">{item.student.name}</p>
                      <p className="mt-0.5 text-[10px] text-slate-400" dir="ltr">{item.student.email}</p>
                      {item.program && <p className="mt-1 font-bold text-slate-500">{item.program.titleAr}</p>}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-red-100 text-red-700 hover:bg-red-100">{FEEDBACK_REASON_LABEL[item.reason || 'OTHER'] || 'يحتاج مراجعة'}</Badge>
                      <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">{REVIEW_STATUS_LABEL[item.status]}</Badge>
                    </div>
                  </div>
                  {item.question && (
                    <div className="mt-3 rounded-xl bg-slate-50 p-3">
                      <p className="mb-1 font-black text-slate-500">سؤال الطالب</p>
                      <p className="line-clamp-3 leading-6 text-slate-700">{item.question}</p>
                    </div>
                  )}
                  <div className="mt-2 rounded-xl bg-[#fffaf0] p-3">
                    <p className="mb-1 font-black text-[#a8841a]">رد المشرف الذكي</p>
                    <p className="line-clamp-4 leading-6 text-slate-700">{item.answer}</p>
                  </div>
                  {item.note && (
                    <p className="mt-2 rounded-xl bg-red-50 p-3 font-bold leading-6 text-red-700">ملاحظة الطالب: {item.note}</p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(['NEW', 'IN_REVIEW', 'REVIEWED', 'IGNORED'] as ChatReviewItem['status'][]).map((s) => (
                      <Button
                        key={s}
                        size="sm"
                        variant={item.status === s ? 'default' : 'outline'}
                        disabled={reviewBusyId === item.id}
                        onClick={() => updateReviewStatus(item.id, s)}
                        className={item.status === s ? 'bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]' : 'text-xs font-bold'}
                      >
                        {reviewBusyId === item.id && item.status !== s ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                        {REVIEW_STATUS_LABEL[s]}
                      </Button>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-black text-[#0f2b46]">أي البرامج قوية؟</h3>
            {data.strongPrograms.length === 0 ? (
              <p className="rounded-xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا يوجد برنامج وصل لمؤشر قوة كافٍ بعد.</p>
            ) : (
              <div className="space-y-2">
                {data.strongPrograms.slice(0, 5).map((p) => {
                  const meta = BAND_META[p.band]
                  return (
                    <div key={p.id} className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-3 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-black text-[#0f2b46]">{p.titleAr}</p>
                        <Badge className={`${meta.cls} hover:bg-inherit text-[10px]`}>{p.qualityScore}/100</Badge>
                      </div>
                      <p className="mt-1 font-bold text-emerald-700">كتب {p.books} · امتحانات جاهزة {p.readyExams} · توثيق {p.sourceCoverage}% · قياس {p.metadataCoverage}%</p>
                    </div>
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-black text-[#0f2b46]">أي تخصص عليه طلب عالي؟</h3>
            {data.topDemandSpecialties.length === 0 ? (
              <p className="rounded-xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا توجد طلبات أو تسجيلات كافية بعد.</p>
            ) : (
              <div className="space-y-2">
                {data.topDemandSpecialties.slice(0, 5).map((p, index) => (
                  <div key={p.id} className="rounded-xl border border-slate-100 bg-[#f8fafc] p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{index + 1}. {p.titleAr}</p>
                      <span className="rounded-full bg-[#0f2b46] px-2 py-1 text-[10px] font-black text-[#e0b83a]">{p.demandScore}</span>
                    </div>
                    <p className="mt-1 font-bold text-slate-500">طلبات قبول {p.admissions} · تسجيلات {p.enrollments}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-[#0f2b46]/10">
          <CardContent className="p-5">
            <h3 className="mb-3 text-sm font-black text-[#0f2b46]">أي مشرف ذكي أعطى إجابات ضعيفة؟</h3>
            {data.weakSupervisorReplies.length === 0 ? (
              <p className="rounded-xl bg-emerald-50 p-4 text-center text-xs font-bold text-emerald-700">لا توجد ردود ضعيفة مرصودة في آخر السجل.</p>
            ) : (
              <div className="space-y-2">
                {data.weakSupervisorReplies.slice(0, 5).map((r) => (
                  <div key={r.id} className="rounded-xl border border-amber-100 bg-amber-50/50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{r.supervisor}</p>
                      <Badge className="bg-amber-100 text-[10px] text-amber-700 hover:bg-amber-100">يحتاج مراجعة</Badge>
                    </div>
                    <p className="mt-1 font-bold text-amber-700">{r.reason}</p>
                    <p className="mt-1 line-clamp-2 text-[10px] leading-5 text-slate-500">{r.excerpt}</p>
                    <p className="mt-1 text-[10px] text-slate-400">الطالب: {r.student}</p>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

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
                <div className="rounded-xl bg-[#f8fafc] p-3">متوسط زمن الرد: <b className="text-[#0f2b46]">{formatSeconds(data.supervisor.averageResponseSeconds)}</b></div>
                <div className="rounded-xl bg-[#f8fafc] p-3">نسبة الردود الضعيفة: <b className="text-[#0f2b46]">{data.supervisor.weakReplyRate}%</b></div>
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
                <p className="rounded-xl bg-slate-50 p-3">نسبة النجاح: {metricValue(data.overview.successRate, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">نسبة الاعتراضات: {metricValue(data.overview.appealRate, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">متوسط درجات الامتحانات: {metricValue(data.overview.avgAttemptScore, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">متوسط توافق القبول الذكي: {metricValue(data.overview.avgAdmissionFit, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">متوسط درجات الأبحاث/المناقشة: {metricValue(data.overview.avgThesisScore, '%')}</p>
                <p className="rounded-xl bg-slate-50 p-3">متوسط زمن الرد: {formatSeconds(data.overview.averageResponseSeconds)}</p>
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

      <Dialog open={unitReviewOpen} onOpenChange={setUnitReviewOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">مراجعة وحدات المنهج</DialogTitle>
            <DialogDescription>
              {unitReviewProgram ? `مراجعة بشرية لخطة وحدات: ${unitReviewProgram.titleAr}` : 'مراجعة وحدات البرنامج'}
            </DialogDescription>
          </DialogHeader>

          {unitBusyId === 'loading' ? (
            <div className="flex h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap justify-between gap-2 rounded-2xl bg-amber-50 p-3 text-xs font-bold text-amber-800">
                <span>عدّل العناوين، الملخصات، أهداف التعلم ومحاور المحتوى قبل اعتماد المنهج.</span>
                <Button size="sm" variant="outline" disabled={unitBusyId === 'new'} onClick={addUnit} className="bg-white text-xs font-black">
                  {unitBusyId === 'new' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                  إضافة وحدة
                </Button>
              </div>

              {unitReviewItems.length === 0 ? (
                <p className="rounded-xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد وحدات بعد. استخدم زر اقتراح وحدات من الكتب أو أضف وحدة يدوياً.</p>
              ) : unitReviewItems.map((unit, index) => (
                <article key={unit.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">وحدة {index + 1}</Badge>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={unitBusyId === unit.id}
                        onClick={() => patchUnit(unit, { order: Math.max(1, unit.order - 1) })}
                        className="text-xs font-bold"
                      >رفع الترتيب</Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={unitBusyId === unit.id}
                        onClick={() => patchUnit(unit, { order: unit.order + 1 })}
                        className="text-xs font-bold"
                      >خفض الترتيب</Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={unitBusyId === unit.id}
                        onClick={() => deleteUnit(unit.id)}
                        className="border-red-200 text-xs font-bold text-red-700"
                      >حذف</Button>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-2">
                      <label className="text-xs font-black text-slate-500">عنوان الوحدة</label>
                      <input
                        defaultValue={unit.title}
                        onBlur={(e) => e.target.value !== unit.title && patchUnit(unit, { title: e.target.value })}
                        className="h-10 w-full rounded-xl border border-slate-200 px-3 text-sm font-bold outline-none focus:border-[#c9a227]"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-xs font-black text-slate-500">أهداف التعلم — هدف في كل سطر</label>
                      <Textarea
                        defaultValue={(unit.objectives || []).join('\n')}
                        onBlur={(e) => patchUnit(unit, { objectives: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) as any })}
                        className="min-h-24 text-xs leading-6"
                      />
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <label className="text-xs font-black text-slate-500">ملخص الوحدة</label>
                    <Textarea
                      defaultValue={unit.summary || ''}
                      onBlur={(e) => e.target.value !== (unit.summary || '') && patchUnit(unit, { summary: e.target.value })}
                      className="min-h-20 text-sm leading-7"
                    />
                  </div>

                  <div className="mt-3 space-y-2">
                    <label className="text-xs font-black text-slate-500">محاور المحتوى — صيغة مبسطة: العنوان: الشرح</label>
                    <Textarea
                      defaultValue={(unit.content || []).map((c) => `${c.heading}: ${c.body}`).join('\n')}
                      onBlur={(e) => {
                        const content = e.target.value.split('\n').map((line) => {
                          const [heading, ...rest] = line.split(':')
                          return { heading: heading?.trim() || 'محور', body: rest.join(':').trim() || line.trim() }
                        }).filter((x) => x.body)
                        patchUnit(unit, { content: content as any })
                      }}
                      className="min-h-28 text-xs leading-6"
                    />
                  </div>

                  {unitBusyId === unit.id && <p className="mt-2 text-xs font-bold text-amber-700">جاري حفظ تعديلات الوحدة...</p>}
                </article>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
