'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, useAppStore } from '@/lib/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useAdminActionDialog } from '@/components/aact/AdminActionDialog'
import { SemesterTrackingCard, type StudentTrackingView } from '@/components/aact/SemesterTrackingCard'
import {
  AlertTriangle,
  ArrowRight,
  Award,
  Banknote,
  BookOpen,
  Bot,
  CheckCircle2,
  ClipboardCheck,
  FileSignature,
  GraduationCap,
  Loader2,
  MessageSquareText,
  ShieldCheck,
  UserRound,
} from 'lucide-react'

interface PreviewData {
  previewMode: string
  note: string
  student: {
    id: string
    name: string
    email: string
    phone?: string | null
    country?: string | null
    role: string
    status: string
    createdAt: string
    academicMemory?: {
      profileDigest?: string | null
      strengths: string[]
      weaknesses: string[]
      conceptsToReview: string[]
      recommendedNextActions: string[]
      lastConversationSummary?: string | null
      lastFileAnalysis?: string | null
      lastInteractionAt?: string | null
      lastExamAt?: string | null
      lastDefenseAt?: string | null
      interactionsCount: number
    } | null
  }
  overview: {
    admissions: number
    enrollments: number
    activeEnrollments: number
    completedEnrollments: number
    programExamAttempts: number
    unitExamAttempts: number
    assignments: number
    theses: number
    certificates: number
    microCredentials: number
    averageScore: number | null
    paidTotal: number
    unpaidTotal: number
    aiInteractions: number
    atRiskSignals: string[]
    examsSat: number
    assignmentsSolved: number
    assignmentsPublishedTotal: number
  }
  admissions: any[]
  enrollments: any[]
  programAttempts: any[]
  unitAttempts: any[]
  assignments: any[]
  theses: any[]
  payments: any[]
  certificates: any[]
  microCredentials: any[]
  recentChats: any[]
  enrollmentDetails: EnrollmentDetail[]
  absence: (FollowUpInfo & { programTitle: string }) | null
  pendingReview: {
    needsReviewCount: number
    pendingAppealsCount: number
    items: Array<{
      attemptId: string
      kind: 'UNIT' | 'PROGRAM'
      examTitle: string
      programTitle: string
      needsReview: boolean
      appealPending: boolean
      createdAt: string
    }>
  }
  correspondence: {
    aiSupervisor: { total: number; capped: boolean; cap: number; messages: any[] }
    admin: { total: number; capped: boolean; cap: number; messages: any[] }
  }
}

interface FollowUpInfo {
  daysAbsent: number
  followUpCount: number
  needsIntervention: boolean
  lastActivityAt: string | null
}

interface EnrollmentDetail {
  enrollmentId: string
  programId: string
  programTitle: string
  category?: string | null
  status: string
  followUp: FollowUpInfo
  cumulative: {
    score: number | null
    earnedScore: number
    progressScore: number
    weightSource: string
    components: Array<{ key: string; label: string; weight: number; score: number | null; ready: boolean; exempt?: boolean; weighted?: number }>
  } | null
  tracking?: StudentTrackingView | null
  counts: {
    unitsTotal: number
    unitsCompleted: number
    unitExamsTotal: number
    unitExamsPassed: number
    assignmentsTotal: number
    assignmentsSubmitted: number
    programExamsTotal: number
    programExamsPassed: number
  }
  units: Array<{
    unitId: string
    title: string
    semester: number
    order: number
    examTitle: string | null
    passScore: number | null
    attemptsCount: number
    bestScore: number | null
    passed: boolean | null
    videosCount: number
    watch: 'COMPLETED' | 'STARTED' | 'NONE' | null
    state: 'COMPLETED' | 'IN_PROGRESS' | 'NOT_STARTED'
  }>
  programExams: Array<{ examId: string; title: string; semester: number; attemptsCount: number; passed: boolean }>
  assignments: Array<{ assignmentId: string; title: string; semester: number; submitted: boolean; status: string | null; score: number | null }>
  remaining: {
    unitsNotCompleted: string[]
    unitExamsNotPassed: string[]
    assignmentsNotSubmitted: string[]
    programExamsNotPassed: string[]
    thesisPending: boolean
    daysLeft: number | null
    gradeMissing: string[]
  }
}

type PreviewTab = 'overview' | 'units' | 'exams' | 'remaining' | 'ai' | 'admin' | 'finance' | 'profile'

const STATUS_AR: Record<string, string> = {
  AWAITING_FEE: 'بانتظار رسوم التقديم',
  UNDER_REVIEW: 'قيد الدراسة',
  AWAITING_TUITION: 'مقبول — بانتظار الرسوم',
  SUPERVISOR_ASSIGNED: 'تم تعيين مشرف',
  THESIS: 'قيد بحث التخرج',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد النتيجة',
  CERTIFIED: 'تم إصدار الشهادة',
  REJECTED: 'مرفوض',
  DISABLED: 'معطّل',
  ARCHIVED: 'مؤرشف',
  ACTIVE: 'نشط',
  COMPLETED: 'مكتمل',
  PAID: 'مدفوع',
  UNPAID: 'غير مدفوع',
  SUBMITTED: 'مسلّم',
  GRADED: 'مصَحّح',
  NEEDS_REVISION: 'يحتاج مراجعة',
}

function arStatus(value?: string | null) {
  return STATUS_AR[value || ''] || value || '—'
}

function dateAr(value?: string | null) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('ar-EG')
}

function score(value: unknown) {
  return typeof value === 'number' ? `${Math.round(value)}%` : '—'
}

// Display only: preserve decimal precision so 19.6% is not presented as 20%.
function formatGradeValue(value: number) {
  return Number(value.toFixed(2)).toString()
}

const UNIT_STATE_AR: Record<string, string> = {
  COMPLETED: 'مكتملة',
  IN_PROGRESS: 'جارية',
  NOT_STARTED: 'لم تبدأ',
}

const WATCH_AR: Record<string, string> = {
  COMPLETED: 'شاهد فيديوهات الوحدة كاملة',
  STARTED: 'بدأ مشاهدة فيديوهات الوحدة',
  NONE: 'لم يشاهد فيديوهات الوحدة بعد',
}

const SENDER_AR: Record<string, string> = {
  STUDENT: 'الطالب',
  ADMIN: 'الإدارة',
  SUPERVISOR: 'المشرف البشري',
  AI: 'المشرف الذكي',
  SYSTEM: 'النظام',
}

function FollowUpBadges({ f }: { f: FollowUpInfo }) {
  return (
    <>
      {f.needsIntervention && <Badge className="bg-red-600 text-white hover:bg-red-600">يحتاج تدخل</Badge>}
      {f.needsIntervention || f.daysAbsent >= 3 ? (
        <Badge className={f.needsIntervention ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>غائب منذ {f.daysAbsent} أيام</Badge>
      ) : f.daysAbsent <= 0 ? (
        <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">نشط اليوم</Badge>
      ) : f.daysAbsent === 1 ? (
        <Badge variant="outline">آخر نشاط أمس</Badge>
      ) : (
        <Badge variant="outline">غائب منذ يومين</Badge>
      )}
    </>
  )
}

function cumulativeLabel(d: EnrollmentDetail) {
  if (d.cumulative == null) return 'غير متاح'
  if (d.cumulative.score != null) return `${Math.round(d.cumulative.score)}%`
  return `لم يكتمل بعد — المحقَّق حتى الآن ${Math.round(d.cumulative.progressScore)}%`
}

function Section({ title, icon: Icon, children }: { title: string; icon: any; children: ReactNode }) {
  return (
    <Card className="border-[#0f2b46]/10">
      <CardContent className="p-4 sm:p-5">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
          <Icon className="h-4 w-4 text-[#a8841a]" /> {title}
        </h3>
        {children}
      </CardContent>
    </Card>
  )
}

export function AdminStudentPreview() {
  const { studentPreviewId, navigate } = useAppStore()
  const [data, setData] = useState<PreviewData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [tab, setTab] = useState<PreviewTab>('overview')
  const { confirmAction, dialog } = useAdminActionDialog()

  const id = useMemo(() => {
    if (studentPreviewId) return studentPreviewId
    if (typeof window === 'undefined') return ''
    return new URLSearchParams(window.location.search).get('studentId') || ''
  }, [studentPreviewId])

  const load = useCallback(() => {
    if (!id) {
      setLoading(false)
      setError('لم يتم تحديد الطالب')
      return
    }
    setLoading(true)
    setError(null)
    api<PreviewData>(`/api/admin/students/preview?studentId=${encodeURIComponent(id)}`)
      .then(setData)
      .catch((e: any) => setError(e?.message || 'تعذر تحميل معاينة الطالب'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    const timer = window.setTimeout(load, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  // الانتقال إلى «مراجعة التصحيح»: نعود للوحة الإدارة ثم نطلب تبويب المراجعة
  // بنفس حدث aact-admin-tab الذي تستعمله روابط الإشعارات (AdminView يستمع له).
  const goToReview = () => {
    navigate('admin')
    ;[80, 250, 600, 1100].forEach((delay) => {
      window.setTimeout(() => window.dispatchEvent(new CustomEvent('aact-admin-tab', { detail: { tab: 'grading-review' } })), delay)
    })
  }

  const changeAccountStatus = async (status: 'ACTIVE' | 'DISABLED') => {
    if (!id || !data || updatingStatus || data.student.status === status) return
    const disabling = status === 'DISABLED'
    const confirmed = await confirmAction({
      title: disabling ? 'تأكيد تعطيل حساب الطالب' : 'تأكيد إعادة تفعيل حساب الطالب',
      description: disabling
        ? `تعطيل حساب ${data.student.name}؟ سيتم تسجيل خروجه من جميع الأجهزة فورًا، مع الاحتفاظ ببياناته الأكاديمية.`
        : `إعادة تفعيل حساب ${data.student.name}؟ سيتمكن من تسجيل الدخول مجددًا، ولن تعود جلساته الملغاة.`,
      confirmLabel: disabling ? 'تعطيل الحساب' : 'إعادة التفعيل',
      cancelLabel: 'إلغاء',
      tone: disabling ? 'danger' : 'success',
    })
    if (!confirmed) return
    setUpdatingStatus(true)
    setStatusMessage(null)
    try {
      await api('/api/admin/students', {
        method: 'PATCH',
        body: JSON.stringify({ action: 'setStatus', userId: id, status }),
      })
      setData((current) => current ? { ...current, student: { ...current.student, status } } : current)
      setStatusMessage(disabling ? 'تم تعطيل الحساب وإنهاء جلساته.' : 'تم إعادة تفعيل الحساب. يستطيع الطالب تسجيل الدخول مجددًا.')
    } catch (err: unknown) {
      setStatusMessage(err instanceof Error ? err.message : 'تعذر تحديث حالة الحساب')
    } finally {
      setUpdatingStatus(false)
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-10">
        <Card className="border-[#0f2b46]/10">
          <CardContent className="flex h-56 flex-col items-center justify-center gap-3 text-center">
            <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
            <p className="text-sm font-black text-[#0f2b46]">جاري تحميل معاينة الطالب...</p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <Card className="border-red-100 bg-red-50">
          <CardContent className="p-6 text-center">
            <AlertTriangle className="mx-auto mb-3 h-9 w-9 text-red-500" />
            <h1 className="text-lg font-black text-red-700">تعذر فتح معاينة الطالب</h1>
            <p className="mt-2 text-sm font-bold text-red-600">{error || 'بيانات غير متاحة'}</p>
            <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
              <Button onClick={load} className="bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#12365c]">إعادة المحاولة</Button>
              <Button variant="outline" onClick={() => navigate('admin')}>العودة للوحة الإدارة</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const s = data.student
  const memory = s.academicMemory
  const pendingTotal = data.pendingReview.needsReviewCount + data.pendingReview.pendingAppealsCount
  const metrics = [
    { label: 'طلبات الالتحاق', value: data.overview.admissions, icon: ClipboardCheck },
    { label: 'برامج نشطة', value: data.overview.activeEnrollments, icon: GraduationCap },
    { label: 'متوسط الدرجات', value: data.overview.averageScore == null ? '—' : `${data.overview.averageScore}%`, icon: CheckCircle2 },
    { label: 'امتحانات مقدّمة', value: data.overview.examsSat, icon: ClipboardCheck },
    { label: 'واجبات محلولة', value: `${data.overview.assignmentsSolved}/${data.overview.assignmentsPublishedTotal}`, icon: BookOpen },
    { label: 'أبحاث التخرج', value: data.overview.theses, icon: FileSignature },
    { label: 'شهادات', value: data.overview.certificates, icon: Award },
    { label: 'تفاعلات المشرف', value: data.overview.aiInteractions, icon: Bot },
  ]
  const tabs: Array<{ key: PreviewTab; label: string }> = [
    { key: 'overview', label: 'نظرة شاملة' },
    { key: 'units', label: 'الوحدات' },
    { key: 'exams', label: 'الامتحانات والواجبات' },
    { key: 'remaining', label: 'المتبقي عليه' },
    { key: 'ai', label: `مراسلات المشرف الذكي (${data.correspondence.aiSupervisor.total})` },
    { key: 'admin', label: `مراسلات الإدارة (${data.correspondence.admin.total})` },
    { key: 'finance', label: 'الالتحاق والماليات' },
    { key: 'profile', label: 'الملف الأكاديمي' },
  ]

  return (
    <div className="mx-auto max-w-7xl space-y-5 px-4 py-6 sm:py-8">
      {dialog}
      <div className="flex flex-col gap-3 rounded-3xl bg-[#0f2b46] p-5 text-[#f5f0e1] shadow-lg sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Badge className="mb-3 bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">معاينة السجل الأكاديمي — قراءة فقط</Badge>
          <span className="mb-3 mr-2 inline-block rounded-full border border-white/40 px-3 py-1 text-xs font-bold">حالة الحساب: {arStatus(s.status)}</span>
          <h1 className="flex items-center gap-2 text-2xl font-black sm:text-3xl">
            <UserRound className="h-6 w-6 text-[#c9a227]" /> {s.name}
          </h1>
          <p className="mt-2 text-sm font-bold text-[#f5f0e1]/75" dir="ltr">{s.email}</p>
          {s.phone && <p className="mt-1 text-sm font-bold text-[#f5f0e1]/75" dir="ltr">{s.phone}</p>}
          <p className="mt-1 text-xs font-bold text-[#f5f0e1]/60">{s.country || 'الدولة غير محددة'} — حسابه منذ {dateAr(s.createdAt)}</p>
          {data.enrollmentDetails.length > 0 && (
            <p className="mt-1 text-xs font-bold text-[#f5f0e1]/60">
              {data.enrollmentDetails.map((d) => `${d.programTitle} — المعدل التراكمي: ${cumulativeLabel(d)}`).join(' · ')}
            </p>
          )}
          {(data.absence || pendingTotal > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {data.absence && <FollowUpBadges f={data.absence} />}
              {pendingTotal > 0 && (
                <Badge className="bg-red-600 text-white hover:bg-red-600">بانتظار مراجعة: {pendingTotal}</Badge>
              )}
            </div>
          )}
        </div>
        <div className="grid gap-2 sm:w-52">
          <Button onClick={() => navigate('admin')} variant="outline" className="border-[#c9a227]/50 bg-white/5 text-[#f5f0e1] hover:bg-white/10">
            <ArrowRight className="ml-1 h-4 w-4" /> العودة للإدارة
          </Button>
          <Button onClick={load} disabled={updatingStatus} className="bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]">تحديث المعاينة</Button>
          {(s.status === 'ACTIVE' || s.status === 'DISABLED') && (
            <Button
              type="button"
              disabled={updatingStatus}
              onClick={() => void changeAccountStatus(s.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')}
              variant="outline"
              className={s.status === 'ACTIVE' ? 'border-red-300 bg-red-50 text-red-800 hover:bg-red-100' : 'border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}
            >
              {updatingStatus ? 'جارٍ تحديث الحساب...' : s.status === 'ACTIVE' ? 'تعطيل حساب الطالب' : 'إعادة تفعيل حساب الطالب'}
            </Button>
          )}
          {statusMessage && <p role="status" className="text-xs font-bold text-[#f5f0e1]">{statusMessage}</p>}
        </div>
      </div>

      <Card className="border-[#c9a227]/30 bg-[#fff8e6]">
        <CardContent className="flex flex-col gap-2 p-4 text-xs font-bold leading-6 text-[#5c4d1a] sm:flex-row sm:items-center">
          <ShieldCheck className="h-5 w-5 shrink-0 text-[#a8841a]" />
          {data.note}
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
        {metrics.map((m) => (
          <Card key={m.label} className="border-[#0f2b46]/10">
            <CardContent className="p-4 text-center">
              <m.icon className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" />
              <div className="text-xl font-black text-[#0f2b46]">{m.value}</div>
              <div className="mt-1 text-[10px] font-bold text-slate-500">{m.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="أقسام معاينة الطالب">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={tab === t.key
              ? 'rounded-full bg-[#0f2b46] px-4 py-2 text-xs font-black text-[#f5f0e1]'
              : 'rounded-full border border-[#0f2b46]/20 bg-white px-4 py-2 text-xs font-black text-[#0f2b46] hover:bg-[#fff7df]'}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-5">
          {pendingTotal > 0 && (
            <Section title="بانتظار البتّ البشري" icon={AlertTriangle}>
              <div className="flex flex-wrap items-center gap-2">
                {data.pendingReview.needsReviewCount > 0 && (
                  <Badge className="bg-red-600 text-white hover:bg-red-600">محاولات بانتظار مراجعة بشرية: {data.pendingReview.needsReviewCount}</Badge>
                )}
                {data.pendingReview.pendingAppealsCount > 0 && (
                  <Badge className="bg-amber-500 text-white hover:bg-amber-500">التماسات قيد الانتظار: {data.pendingReview.pendingAppealsCount}</Badge>
                )}
                <Button size="sm" onClick={goToReview} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">الانتقال إلى صفحة المراجعة</Button>
              </div>
              <p className="mt-2 text-[11px] font-bold text-slate-400">قائمة المحاولات بالتفصيل في تبويب «الامتحانات والواجبات».</p>
            </Section>
          )}

          <Section title="بيانات الطالب وبرامجه" icon={UserRound}>
            <div className="grid gap-2 text-xs sm:grid-cols-2">
              <p className="rounded-xl bg-slate-50 p-3 font-bold text-slate-600">الاسم: <b className="text-[#0f2b46]">{s.name}</b></p>
              <p className="rounded-xl bg-slate-50 p-3 font-bold text-slate-600">البريد: <b className="text-[#0f2b46]" dir="ltr">{s.email}</b></p>
              <p className="rounded-xl bg-slate-50 p-3 font-bold text-slate-600">رقم الهاتف: <b className="text-[#0f2b46]" dir="ltr">{s.phone || 'غير مسجل'}</b></p>
              <p className="rounded-xl bg-slate-50 p-3 font-bold text-slate-600">الدولة: <b className="text-[#0f2b46]">{s.country || 'غير محددة'}</b> — حالة الحساب: <b className="text-[#0f2b46]">{arStatus(s.status)}</b></p>
            </div>
            {data.enrollmentDetails.length === 0 ? (
              <p className="mt-3 text-sm text-slate-400">لا توجد تسجيلات نشطة — تفاصيل التقدم والمعدل التراكمي تظهر هنا عند وجود تسجيل نشط.</p>
            ) : (
              <div className="mt-3 space-y-3">
                {data.enrollmentDetails.map((d) => (
                  <div key={d.enrollmentId} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">التخصص: {d.programTitle}</p>
                      <Badge className="bg-blue-100 text-blue-700 hover:bg-blue-100">{arStatus(d.status)}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge className="bg-[#0f2b46] text-[#f5f0e1] hover:bg-[#0f2b46]">المعدل التراكمي: {cumulativeLabel(d)}</Badge>
                      <Badge variant="outline">إجمالي البرنامج — وحدات مكتملة: {d.counts.unitsCompleted}/{d.counts.unitsTotal}</Badge>
                      <Badge variant="outline">إجمالي البرنامج — اختبارات وحدات ناجحة: {d.counts.unitExamsPassed}/{d.counts.unitExamsTotal}</Badge>
                      <Badge variant="outline">إجمالي البرنامج — واجبات مسلّمة: {d.counts.assignmentsSubmitted}/{d.counts.assignmentsTotal}</Badge>
                      <Badge variant="outline">إجمالي البرنامج — امتحانات برنامج ناجحة: {d.counts.programExamsPassed}/{d.counts.programExamsTotal}</Badge>
                      {d.remaining.daysLeft != null && (
                        <Badge className={d.remaining.daysLeft <= 0 ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-blue-100 text-blue-700 hover:bg-blue-100'}>
                          {d.remaining.daysLeft > 0 ? `متبقٍّ من مدة الدراسة: ${d.remaining.daysLeft} يوم` : 'انتهت مدة الدراسة المقررة'}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-bold text-slate-500">
                      <span>آخر نشاط: {d.followUp.lastActivityAt ? dateAr(d.followUp.lastActivityAt) : 'لا نشاط مسجل بعد'}</span>
                      <span>أيام الغياب الحالية: {d.followUp.daysAbsent}</span>
                      <span>رسائل المتابعة في الحلقة الحالية: {d.followUp.followUpCount}/3</span>
                      <FollowUpBadges f={d.followUp} />
                    </div>
                    {d.cumulative && d.cumulative.components.length > 0 && (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {d.cumulative.components.map((c) => (
                          <div key={c.key} className="rounded-xl bg-white p-3 font-bold text-slate-600">
                            <p>{c.label} (الوزن {c.weight}%)</p>
                            <p className="mt-1 text-slate-800">
                              {c.exempt ? 'معفى' : c.score != null
                                ? `${c.ready ? 'النتيجة' : 'النتيجة الحالية'}: ${formatGradeValue(c.score)}%${c.ready ? '' : ' — لم يكتمل بعد'}`
                                : 'غير مكتمل'}
                            </p>
                            {!c.exempt && c.score != null && typeof c.weighted === 'number' && Number.isFinite(c.weighted) && (
                              <p className="mt-1 text-[11px] font-medium text-slate-500">
                                المساهمة في المعدل: {formatGradeValue(c.weighted)} نقطة مئوية
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    <SemesterTrackingCard tracking={d.tracking} />
                  </div>
                ))}
              </div>
            )}
          </Section>

          {data.overview.atRiskSignals.length > 0 && (
            <Section title="إشارات متابعة عاجلة" icon={AlertTriangle}>
              <div className="grid gap-2 md:grid-cols-2">
                {data.overview.atRiskSignals.map((x, i) => (
                  <p key={i} className="rounded-xl bg-red-50 p-3 text-xs font-bold leading-6 text-red-700">• {x}</p>
                ))}
              </div>
            </Section>
          )}

          <Section title="البرامج والتسجيلات" icon={BookOpen}>
            {data.enrollments.length === 0 ? <p className="text-sm text-slate-400">لا توجد تسجيلات مفعّلة.</p> : (
              <div className="space-y-2">
                {data.enrollments.map((e) => (
                  <div key={e.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{e.program.titleAr}</p>
                      <Badge className={e.status === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-blue-100 text-blue-700 hover:bg-blue-100'}>{arStatus(e.status)}</Badge>
                    </div>
                    <p className="mt-1 text-slate-500">وحدات مكتملة: {e.completedUnitsCount}/{e.program._count.units} — كتب {e.program._count.books} — امتحانات {e.program._count.programExams}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {tab === 'units' && (
        <div className="space-y-5">
          {data.enrollmentDetails.length === 0 ? (
            <Section title="الوحدات بالتفصيل" icon={BookOpen}>
              <p className="text-sm text-slate-400">لا توجد تسجيلات نشطة لعرض وحداتها.</p>
            </Section>
          ) : data.enrollmentDetails.map((d) => (
            <Section key={d.enrollmentId} title={`الوحدات بالتفصيل — ${d.programTitle}`} icon={BookOpen}>
              {d.units.length === 0 ? <p className="text-sm text-slate-400">لا توجد وحدات في هذا البرنامج.</p> : (
                <div className="space-y-2">
                  {d.units.map((u) => (
                    <div key={u.unitId} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-black text-[#0f2b46]">{u.order + 1}. {u.title}</p>
                        <Badge className={u.state === 'COMPLETED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : u.state === 'IN_PROGRESS' ? 'bg-blue-100 text-blue-700 hover:bg-blue-100' : 'bg-slate-200 text-slate-600 hover:bg-slate-200'}>
                          {UNIT_STATE_AR[u.state]}
                        </Badge>
                      </div>
                      <p className="mt-1 font-bold text-slate-500">الفصل {u.semester}{u.watch ? ` — ${WATCH_AR[u.watch]}` : u.videosCount === 0 ? ' — لا فيديوهات منشورة لهذه الوحدة' : ''}</p>
                      <p className="mt-1 text-slate-500">
                        {u.examTitle
                          ? <>اختبار الوحدة «{u.examTitle}»: {u.passed === true ? 'ناجح' : u.attemptsCount > 0 ? 'لم يُجتز بعد' : 'لم يُقدَّم بعد'} — أفضل نتيجة {score(u.bestScore)} — محاولات {u.attemptsCount} — حد النجاح {u.passScore ?? '—'}%</>
                          : 'لا يوجد اختبار مرتبط بهذه الوحدة'}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </Section>
          ))}
        </div>
      )}

      {tab === 'exams' && (
        <div className="space-y-5">
          {pendingTotal > 0 && (
            <Section title="محاولات بانتظار البتّ البشري" icon={AlertTriangle}>
              <div className="space-y-2">
                {data.pendingReview.items.map((it) => (
                  <div key={it.attemptId} className="rounded-xl bg-red-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{it.examTitle}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {it.needsReview && <Badge className="bg-red-600 text-white hover:bg-red-600">بانتظار مراجعة بشرية</Badge>}
                        {it.appealPending && <Badge className="bg-amber-500 text-white hover:bg-amber-500">التماس قيد الانتظار</Badge>}
                      </div>
                    </div>
                    <p className="mt-1 font-bold text-slate-500">{it.kind === 'UNIT' ? 'اختبار وحدة' : 'امتحان برنامج'} — {it.programTitle} — {dateAr(it.createdAt)}</p>
                  </div>
                ))}
              </div>
              <Button onClick={goToReview} className="mt-3 bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">الانتقال إلى صفحة المراجعة</Button>
            </Section>
          )}

          <Section title="الامتحانات" icon={CheckCircle2}>
            {[...data.programAttempts, ...data.unitAttempts].length === 0 ? <p className="text-sm text-slate-400">لا توجد محاولات امتحان بعد.</p> : (
              <div className="space-y-2">
                {data.programAttempts.slice(0, 8).map((a) => (
                  <div key={a.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                    <p className="font-black text-[#0f2b46]">{a.exam.title}</p>
                    <p className="mt-1 text-slate-500">{a.exam.program.titleAr} — النتيجة {score(a.finalScore ?? a.score)} — {a.passed === true ? 'ناجح' : a.passed === false ? 'راسب' : arStatus(a.status)}</p>
                  </div>
                ))}
                {data.unitAttempts.slice(0, 5).map((a) => (
                  <div key={a.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                    <p className="font-black text-[#0f2b46]">{a.exam.title}</p>
                    <p className="mt-1 text-slate-500">{a.exam.unit.program.titleAr} — النتيجة {score(a.score)}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {data.enrollmentDetails.map((d) => (
            (d.programExams.length > 0 || d.assignments.length > 0) && (
              <Section key={d.enrollmentId} title={`امتحانات البرنامج والواجبات — ${d.programTitle}`} icon={ClipboardCheck}>
                <div className="grid gap-3 md:grid-cols-2">
                  {d.programExams.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-black text-[#0f2b46]">امتحانات البرنامج</p>
                      <div className="space-y-2">
                        {d.programExams.map((x) => (
                          <p key={x.examId} className="rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
                            {x.title} (فصل {x.semester}) — {x.passed ? 'ناجح' : x.attemptsCount > 0 ? 'قُدّم ولم يُجتز' : 'لم يُقدَّم بعد'}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                  {d.assignments.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-black text-[#0f2b46]">الواجبات</p>
                      <div className="space-y-2">
                        {d.assignments.map((a) => (
                          <p key={a.assignmentId} className="rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
                            {a.title} (فصل {a.semester}) — {a.submitted ? `${arStatus(a.status)}${typeof a.score === 'number' ? ` — الدرجة ${a.score}` : ''}` : 'لم يُسلَّم بعد'}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Section>
            )
          ))}

          <Section title="واجبات مسلّمة (أحدث التسليمات)" icon={FileSignature}>
            {data.assignments.length === 0 ? <p className="text-sm text-slate-400">لا توجد واجبات مسلّمة بعد.</p> : (
              <div className="space-y-2">
                {data.assignments.slice(0, 10).map((a) => (
                  <div key={a.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{a.assignment.title}</p>
                      <Badge variant="outline">{arStatus(a.status)}</Badge>
                    </div>
                    <p className="mt-1 text-slate-500">{a.assignment.program.titleAr} — الدرجة {typeof a.score === 'number' ? a.score : '—'} — سُلّم {dateAr(a.submittedAt)}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {tab === 'remaining' && (
        <div className="space-y-5">
          {data.enrollmentDetails.length === 0 ? (
            <Section title="ما تبقّى على الطالب" icon={AlertTriangle}>
              <p className="text-sm text-slate-400">لا توجد تسجيلات نشطة لحساب المتبقّي.</p>
            </Section>
          ) : data.enrollmentDetails.map((d) => (
            <Section key={d.enrollmentId} title={`ما تبقّى على الطالب — ${d.programTitle}`} icon={AlertTriangle}>
              {d.remaining.unitsNotCompleted.length === 0 && d.remaining.unitExamsNotPassed.length === 0 && d.remaining.assignmentsNotSubmitted.length === 0 && d.remaining.programExamsNotPassed.length === 0 && !d.remaining.thesisPending ? (
                <p className="text-xs font-bold text-emerald-700">لا شيء متبقٍّ — أكمل الطالب كل مكوّنات هذا البرنامج.</p>
              ) : (
                <ul className="list-inside list-disc space-y-1 text-xs font-bold leading-6 text-amber-800">
                  {d.remaining.unitsNotCompleted.length > 0 && <li>وحدات غير مكتملة ({d.remaining.unitsNotCompleted.length}): {d.remaining.unitsNotCompleted.join('، ')}</li>}
                  {d.remaining.unitExamsNotPassed.length > 0 && <li>اختبارات وحدات لم تُجتز ({d.remaining.unitExamsNotPassed.length}): {d.remaining.unitExamsNotPassed.join('، ')}</li>}
                  {d.remaining.assignmentsNotSubmitted.length > 0 && <li>واجبات لم تُسلَّم ({d.remaining.assignmentsNotSubmitted.length}): {d.remaining.assignmentsNotSubmitted.join('، ')}</li>}
                  {d.remaining.programExamsNotPassed.length > 0 && <li>امتحانات برنامج لم تُجتز ({d.remaining.programExamsNotPassed.length}): {d.remaining.programExamsNotPassed.join('، ')}</li>}
                  {d.remaining.thesisPending && <li>بحث التخرج/المناقشة لم يكتمل بعد</li>}
                  {d.remaining.gradeMissing.length > 0 && <li>مكوّنات ناقصة في حساب المعدل: {d.remaining.gradeMissing.join('، ')}</li>}
                </ul>
              )}
              {d.remaining.daysLeft != null && (
                <p className="mt-3 text-xs font-bold text-slate-500">{d.remaining.daysLeft > 0 ? `متبقٍّ من مدة الدراسة المقررة: ${d.remaining.daysLeft} يوم` : 'انتهت مدة الدراسة المقررة لهذا التسجيل'}</p>
              )}
            </Section>
          ))}
        </div>
      )}

      {tab === 'ai' && (
        <Section title="مراسلات المشرف الذكي" icon={Bot}>
          {data.correspondence.aiSupervisor.capped && (
            <p className="mb-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
              يظهر هنا آخر {data.correspondence.aiSupervisor.cap} رسالة من أصل {data.correspondence.aiSupervisor.total} — السجل الكامل في تبويب «المشرف الذكي» بلوحة الإدارة.
            </p>
          )}
          {data.correspondence.aiSupervisor.messages.length === 0 ? <p className="text-sm text-slate-400">لا توجد محادثات مع المشرف الذكي.</p> : (
            <div className="space-y-3">
              {data.correspondence.aiSupervisor.messages.map((m) => {
                const isStudent = m.role === 'user'
                return (
                  <div key={m.id} className={`flex ${isStudent ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-6 ${isStudent ? 'rounded-br-sm bg-[#0f2b46] text-white' : 'rounded-bl-sm bg-[#f7edd0] text-[#0f2b46]'}`}>
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className={isStudent ? 'border-white/30 text-white/80' : ''}>{isStudent ? 'الطالب' : 'المشرف الذكي'}{m.mode === 'VOICE' ? ' — صوتية (مفرّغة)' : ''}{m.kind === 'THESIS_REVIEW' ? ' — تحليل مسودة بحث' : ''}</Badge>
                        <span className={`text-[10px] font-bold ${isStudent ? 'text-white/50' : 'text-slate-400'}`}>{dateAr(m.createdAt)}</span>
                      </div>
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      )}

      {tab === 'admin' && (
        <Section title="مراسلات الإدارة" icon={MessageSquareText}>
          {data.correspondence.admin.capped && (
            <p className="mb-3 rounded-xl bg-amber-50 p-3 text-xs font-bold text-amber-700">
              يظهر هنا أول {data.correspondence.admin.cap} رسالة — السجل الكامل في تبويب «مراسلات الإدارة» بلوحة الإدارة.
            </p>
          )}
          {data.correspondence.admin.messages.length === 0 ? <p className="text-sm text-slate-400">لا توجد مراسلات مع الإدارة.</p> : (
            <div className="space-y-3">
              {data.correspondence.admin.messages.map((m) => {
                const isStudent = m.senderRole === 'STUDENT'
                return (
                  <div key={m.id} className={`flex ${isStudent ? 'justify-start' : 'justify-end'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-6 ${isStudent ? 'rounded-br-sm bg-[#0f2b46] text-white' : 'rounded-bl-sm bg-[#f7edd0] text-[#0f2b46]'}`}>
                      <div className="mb-1 flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className={isStudent ? 'border-white/30 text-white/80' : ''}>{SENDER_AR[m.senderRole] || m.senderRole}{m.mode === 'VOICE' ? ' — صوتية' : ''}</Badge>
                        <span className={`text-[10px] font-bold ${isStudent ? 'text-white/50' : 'text-slate-400'}`}>{dateAr(m.createdAt)}</span>
                      </div>
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      )}

      {tab === 'finance' && (
        <div className="space-y-5">
          <Section title="طلبات الالتحاق" icon={ClipboardCheck}>
            {data.admissions.length === 0 ? <p className="text-sm text-slate-400">لا توجد طلبات التحاق مرتبطة.</p> : (
              <div className="space-y-2">
                {data.admissions.map((a) => (
                  <div key={a.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{a.reference}</p>
                      <Badge variant="outline">{arStatus(a.status)}</Badge>
                    </div>
                    <p className="mt-1 font-bold text-slate-600">{a.program}</p>
                    <p className="mt-1 text-slate-500">المشرف: {a.supervisor?.name || 'لم يعين بعد'} — الملفات: {a.files?.length || 0}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="الدفعات والفواتير" icon={Banknote}>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <p className="rounded-xl bg-emerald-50 p-3 text-xs font-black text-emerald-700">مدفوع: ${data.overview.paidTotal}</p>
              <p className="rounded-xl bg-amber-50 p-3 text-xs font-black text-amber-700">غير مدفوع: ${data.overview.unpaidTotal}</p>
            </div>
            {data.payments.length === 0 ? <p className="text-sm text-slate-400">لا توجد فواتير.</p> : (
              <div className="space-y-2">
                {data.payments.slice(0, 8).map((p) => (
                  <div key={p.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]" dir="ltr">{p.invoiceNo}</p>
                      <Badge className={p.status === 'PAID' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{arStatus(p.status)}</Badge>
                    </div>
                    <p className="mt-1 text-slate-500">{p.description} — ${p.amount}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      )}

      {tab === 'profile' && (
        <div className="space-y-5">
          <Section title="بحث التخرج والمناقشة" icon={FileSignature}>
            {data.theses.length === 0 ? <p className="text-sm text-slate-400">لا يوجد بحث تخرج مسلّم.</p> : (
              <div className="space-y-2">
                {data.theses.map((t) => (
                  <div key={t.id} className="rounded-xl border border-slate-100 bg-slate-50 p-3 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-black text-[#0f2b46]">{t.title}</p>
                      <Badge variant="outline">{arStatus(t.status)}</Badge>
                    </div>
                    <p className="mt-1 line-clamp-2 text-slate-500">{t.abstract}</p>
                    <p className="mt-1 text-slate-500">تقييم AI: {score(t.aiScore)} — نتيجة اللجنة: {score(t.resultScore)} — رسائل المناقشة: {t._count?.defenseMessages || 0}</p>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <Section title="الشهادات والمهارات الصغيرة" icon={Award}>
            <div className="space-y-2">
              {data.certificates.map((c) => (
                <div key={c.id} className="rounded-xl bg-slate-50 p-3 text-xs">
                  <p className="font-black text-[#0f2b46]">{c.program}</p>
                  <p className="mt-1 text-slate-500">{c.serial} — {c.valid ? 'صالحة' : 'غير صالحة'} — {dateAr(c.issuedAt)}</p>
                </div>
              ))}
              {data.microCredentials.map((m) => (
                <div key={m.id} className="rounded-xl bg-[#fff8e6] p-3 text-xs">
                  <p className="font-black text-[#0f2b46]">{m.microCredential.titleAr}</p>
                  <p className="mt-1 text-slate-500">{m.microCredential.badgeCode} — {m.microCredential.program.titleAr}</p>
                </div>
              ))}
              {data.certificates.length === 0 && data.microCredentials.length === 0 && <p className="text-sm text-slate-400">لا توجد شهادات أو مهارات صغيرة.</p>}
            </div>
          </Section>

          <Section title="ذاكرة المشرف الذكي" icon={Bot}>
            {!memory ? <p className="text-sm text-slate-400">لا توجد ذاكرة أكاديمية محفوظة بعد.</p> : (
              <div className="space-y-3 text-xs leading-6 text-slate-600">
                {memory.profileDigest && <p className="rounded-xl bg-slate-50 p-3 font-bold">{memory.profileDigest}</p>}
                {memory.weaknesses.length > 0 && <p><b className="text-[#0f2b46]">نقاط ضعف:</b> {memory.weaknesses.join('، ')}</p>}
                {memory.conceptsToReview.length > 0 && <p><b className="text-[#0f2b46]">مفاهيم للمراجعة:</b> {memory.conceptsToReview.join('، ')}</p>}
                {memory.recommendedNextActions.length > 0 && <p><b className="text-[#0f2b46]">إجراءات مقترحة:</b> {memory.recommendedNextActions.join('، ')}</p>}
                {memory.lastConversationSummary && <p><b className="text-[#0f2b46]">آخر محادثة:</b> {memory.lastConversationSummary}</p>}
                {memory.lastFileAnalysis && <p><b className="text-[#0f2b46]">آخر تحليل ملف:</b> {memory.lastFileAnalysis}</p>}
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  )
}
