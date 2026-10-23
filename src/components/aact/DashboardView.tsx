'use client'

import { useAppStore, api, getToken } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { cleanAcademicOutput, looksLikeBrokenGeneratedArabic, sanitizeAcademicList } from '@/lib/academic-output-quality'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { PaymentsTab, ThesisTab, CertificatesTab, TranscriptTab } from '@/components/aact/DashboardExtras'
import { StudentSupervisionTab } from '@/components/aact/StudentSupervisionTab'
import { StudentLectures } from '@/components/aact/StudentLectures'
import {
  BookOpen, ClipboardCheck, ChevronLeft, Loader2, Lock,
  Award, Bot, CheckCircle2, CircleDashed, Trophy, Banknote, FileText,
  BookMarked, Hourglass, ScrollText, MessageCircle, Bell, ListChecks, Download, ExternalLink, Video,
} from 'lucide-react'

const STUDENT_STATUS_LABEL: Record<string, string> = {
  AWAITING_FEE: 'بانتظار رسوم التقديم',
  UNDER_REVIEW: 'قيد مراجعة الإدارة',
  AWAITING_TUITION: 'مقبول — بانتظار الرسوم',
  SUPERVISOR_ASSIGNED: 'تم تفعيل التسجيل',
  THESIS: 'قيد الدراسة والبحث',
  SCHEDULED: 'مجدول للمناقشة',
  RESULT_APPROVED: 'تم اعتماد النتيجة',
  CERTIFIED: 'تم إصدار الشهادة',
  REJECTED: 'غير مقبول',
  PENDING: 'تم التقديم',
}
const studentStatusLabel = (status?: string | null) => (status ? STUDENT_STATUS_LABEL[status] || status : 'قيد المتابعة')

async function openDashboardPdf(path: string, filename: string) {
  const popup = window.open('', '_blank')
  if (popup) {
    popup.document.write('<p style="font-family:Arial;padding:24px;text-align:center">Preparing PDF...</p>')
    try { popup.opener = null } catch (error) { console.warn('Unable to detach dashboard PDF popup opener.', error) }
  }
  try {
    const token = getToken()
    const res = await fetch(path, { cache: 'no-store', headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw new Error(data?.error || `HTTP ${res.status}`)
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    if (popup) {
      popup.location.href = url
    } else {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch (e: any) {
    try { popup?.close() } catch (closeError) { console.warn('Unable to close dashboard PDF popup after failure.', closeError) }
    toast({ title: 'تعذر فتح PDF', description: e.message || 'حدث خطأ أثناء تجهيز الملف', variant: 'destructive' })
  }
}

function openBookResource(book: { id?: string; title?: string; fileName?: string | null; hasFile?: boolean; hasLink?: boolean }) {
  if (!book.id) return
  const path = `/api/books/${encodeURIComponent(book.id)}/download`
  if (book.hasFile) {
    openDashboardPdf(path, book.fileName || `${book.title || 'aact-book'}.pdf`)
    return
  }
  const popup = window.open(path, '_blank', 'noopener,noreferrer')
  if (!popup) window.location.href = path
}

function playStudentPulseTone() {
  if (typeof window === 'undefined') return
  try {
    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext
    if (!AudioContextCtor) return
    const ctx = new AudioContextCtor()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, ctx.currentTime)
    oscillator.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.16)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22)
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start()
    oscillator.stop(ctx.currentTime + 0.24)
    window.setTimeout(() => ctx.close().catch(() => {}), 360)
  } catch {
    // المتصفحات قد تمنع الصوت قبل أول تفاعل؛ التنبيه البصري يبقى هو الأساس.
  }
}

interface UnitInfo {
  id: string
  order: number
  title: string
  summary?: string
  hasExam: boolean
  examId: string | null
  examTitle: string | null
  examPassScore: number | null
  bestScore: number | null
  examPassed: boolean
  completed: boolean
}

interface ProgressData {
  program: {
    id: string
    slug: string
    titleAr: string
    titleEn?: string
    description: string
    category?: string | null
    hours?: number | null
    price?: number | null
    unitsCount?: number | null
    units?: { id?: string; order?: number; title?: string }[]
    books?: { id?: string; title?: string; titleEn?: string | null; semester?: number | null; source?: string | null; fileName?: string | null; hasFile?: boolean; hasLink?: boolean }[]
    assignments?: { id?: string; title?: string; semester?: number | null; points?: number | null; status?: string | null }[]
    exams?: { id?: string; title?: string; semester?: number | null; status?: string | null; questionCount?: number | null }[]
    academicProfile?: any
    curriculumReadiness?: {
      status: string
      registrationStatus: string
      approved: boolean
      dueAt?: string | null
      note?: string | null
      counts?: {
        books: number
        units: number
        unitsWithObjectives: number
        knowledgeItems: number
        readyExams: number
        reviewExams: number
      }
      message: string
    }
  }
  progress: number
  status: string
  finalScore: number | null
  completedUnits: string[]
  booksCount?: number
  finalExam?: {
    id: string
    title: string
    durationMin: number
    passScore: number
    questionCount: number
    bestScore: number | null
    passed: boolean
  } | null
  pendingReviewExams?: number
  semesterExams?: {
    id: string
    title: string
    semester: number
    durationMin: number
    passScore: number
    questionCount: number
    bestScore: number | null
    passed: boolean
    readiness?: {
      semester: number
      readyMarked: boolean
      complete: boolean
      maxExamScore: number
      assignmentWeight: number
      missingAssignmentWeight: number
      unitExamsCount: number
      passedUnitExamsCount: number
      assignmentsCount: number
      passedAssignmentsCount: number
      missingUnitExams: { id: string; title: string }[]
      missingAssignments: { id: string; title: string; weight: number }[]
    } | null
    tuitionGate?: {
      allowed: boolean
      code: string | null
      totalTuition: number
      paidTuition: number
      requiredAmount: number
      remainingTuition: number
      message: string | null
    }
  }[]
  units: UnitInfo[]
}

interface MyEnrollment {
  id: string
  programId: string
  status: string
  certificateNo?: string | null
  program?: { titleAr?: string }
}

interface ServiceDeliverableRow {
  id: string
  type: string
  typeLabel: string
  title: string
  description?: string | null
  fileName?: string | null
  externalUrl?: string | null
  certificateId?: string | null
  verificationUrl?: string | null
  meetingAt?: string | null
  expiresAt?: string | null
  createdAt: string
  downloadUrl: string
  application?: { id: string; reference: string; program: string }
}

interface StudentAssignment {
  id: string
  programId: string
  programTitle?: string
  title: string
  description: string
  semester: number
  type: string
  points: number
  weight: number
  dueDays?: number | null
  dueAt?: string | null
  rubric?: string | null
  status: string
  submitted: boolean
  submission?: {
    id: string
    answerText?: string | null
    fileName?: string | null
    fileUrl?: string | null
    downloadUrl?: string | null
    mimeType?: string | null
    size?: number | null
    status: string
    score?: number | null
    feedback?: string | null
    submittedAt?: string
    gradedAt?: string | null
  } | null
}

interface StudentStudyGuide {
  id: string
  programId: string
  semester: number
  title: string
  overview: string
  objectives: string[]
  keyTerms: string[]
  sections: { title: string; summary: string; outcomes?: string[]; sourceTitles?: string[] }[]
  activities: string[]
  discussionQuestions: string[]
  updatedAt: string
}

interface StudentStudyScheduleItem {
  id: string
  programId: string
  semester: number
  week: number
  dayOffset?: number | null
  title: string
  description?: string | null
  type: 'READING' | 'UNIT' | 'STUDY_GUIDE' | 'ASSIGNMENT' | 'EXAM' | 'REVIEW'
  unitId?: string | null
  studyGuideId?: string | null
  assignmentId?: string | null
  examId?: string | null
  durationMin?: number | null
  order: number
  targetDate?: string | null
}

interface ChatMsg { id: string; role: string; content: string; createdAt: string }

const STUDY_SCHEDULE_TYPE_LABEL: Record<StudentStudyScheduleItem['type'], string> = {
  READING: 'قراءة',
  UNIT: 'وحدة',
  STUDY_GUIDE: 'دليل دراسة',
  ASSIGNMENT: 'واجب',
  EXAM: 'امتحان',
  REVIEW: 'مراجعة',
}

interface AcademicMemorySnapshot {
  exists: boolean
  profileDigest: string | null
  strengths: string[]
  weaknesses: string[]
  conceptsToReview: string[]
  recommendedNextActions: string[]
  lastConversationSummary: string | null
  examSignals: string[]
  thesisSignals: string[]
  lastFileAnalysis: string | null
  interactionsCount: number
  lastInteractionAt: string | null
  lastExamAt: string | null
  lastDefenseAt: string | null
  updatedAt: string | null
}

interface StudentDashboardSummary {
  admissions: any[]
  studyAdmissions?: any[]
  serviceAdmissions?: any[]
  serviceDeliverables?: any[]
  aiSupervisorAccess?: { allowed: boolean; reason: string | null; admissionId: string | null }
  payments: any[]
  enrollments: any[]
  notifications: { id: string; type: string; title: string; body: string; link?: string | null; read: boolean; createdAt: string }[]
  unread: number
  assignmentSubmissions: any[]
  thesis: any | null
  summary: {
    latestAdmission: any | null
    latestStudy?: any | null
    latestService?: any | null
    activeEnrollment: any | null
    studyRequests?: number
    serviceRequests?: number
    serviceDeliverables?: number
    unpaidPayments: number
    paidPayments: number
    requiredAction: { title: string; body: string; target: string } | null
  }
}

interface MicroCredentialCard {
  id: string
  credentialId: string
  titleAr: string
  skillArea: string
  description: string
  learningOutcome: string
  badgeCode: string
  programTitle: string
  issuedAt?: string | null
  evidence?: any
}

function microSkillLabel(value?: string | null): string {
  const raw = String(value || '').trim()
  const map: Record<string, string> = {
    PROFESSIONAL_FOUNDATIONS: 'أساسيات مهنية',
    FOUNDATIONS: 'أساسيات مهنية',
    APPLIED_ANALYSIS: 'التحليل والتطبيق المهني',
    CAPSTONE_PROJECT: 'المشروع أو البحث التطبيقي',
    CAPSTONE_READY: 'المشروع أو البحث التطبيقي',
  }
  if (!raw) return 'مهارة مهنية'
  return map[raw] || raw.replace(/_/g, ' ')
}

export function DashboardView() {
  const { user, navigate, openUnit, openExam, openProgramDetails } = useAppStore()
  const { toast } = useToast()
  const [enrollments, setEnrollments] = useState<MyEnrollment[]>([])
  const [programs, setPrograms] = useState<any[]>([])
  const [active, setActive] = useState<ProgressData | null>(null)
  const [studyGuides, setStudyGuides] = useState<StudentStudyGuide[]>([])
  const [studyScheduleItems, setStudyScheduleItems] = useState<StudentStudyScheduleItem[]>([])
  const [assignments, setAssignments] = useState<StudentAssignment[]>([])
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string>>({})
  const [assignmentFiles, setAssignmentFiles] = useState<Record<string, File | null>>({})
  const [submittingAssignmentId, setSubmittingAssignmentId] = useState<string | null>(null)
  const [loadingActive, setLoadingActive] = useState(false)
  const [lastChats, setLastChats] = useState<ChatMsg[]>([])
  const [academicMemory, setAcademicMemory] = useState<AcademicMemorySnapshot | null>(null)
  const [earnedMicroCredentials, setEarnedMicroCredentials] = useState<MicroCredentialCard[]>([])
  const [availableMicroCredentials, setAvailableMicroCredentials] = useState<MicroCredentialCard[]>([])
  const [studentSummary, setStudentSummary] = useState<StudentDashboardSummary | null>(null)
  const [serviceDeliverables, setServiceDeliverables] = useState<ServiceDeliverableRow[]>([])
  const [serviceDeliverablesLoading, setServiceDeliverablesLoading] = useState(true)
  const [dashboardTab, setDashboardTab] = useState('programs')
  const [lecturesVisible, setLecturesVisible] = useState(false)
  const [programSection, setProgramSection] = useState('academic')
  const dashboardContentRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const requestedTab = new URLSearchParams(window.location.search).get('tab')
    const allowedTabs = ['programs', 'supervision', 'lectures', 'payments', 'deliverables', 'notifications', 'thesis', 'transcript', 'certs']
    if (requestedTab && allowedTabs.includes(requestedTab)) setDashboardTab(requestedTab)
  }, [])

  // تبويب المحاضرات يظهر فقط إذا كانت الميزة متاحة لبرامج الطالب فعليًا على
  // السيرفر (القائمة ترجع 404 عند الإطفاء أو غياب برنامج مفعّل).
  useEffect(() => {
    let cancelled = false
    fetch('/api/my/lectures', { cache: 'no-store' })
      .then((res) => {
        if (!cancelled) setLecturesVisible(res.ok)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const displayStudyGuides = useMemo(() => studyGuides.map((guide) => ({
    ...guide,
    title: cleanAcademicOutput(guide.title, 220),
    overview: cleanAcademicOutput(guide.overview, 5000),
    objectives: sanitizeAcademicList(guide.objectives, ['فهم محاور البرنامج وربطها بالتطبيق المهني'], 10, 220),
    keyTerms: sanitizeAcademicList(guide.keyTerms, [], 18, 90),
    activities: sanitizeAcademicList(guide.activities, ['اقرأ المحاور المحددة واكتب ملخصاً تطبيقياً قصيراً.'], 8, 300),
    discussionQuestions: sanitizeAcademicList(guide.discussionQuestions, ['كيف يمكن توظيف هذا المحور في حالة مهنية؟'], 10, 320),
    sections: (guide.sections || []).map((section, i) => ({
      ...section,
      title: cleanAcademicOutput(section.title || `محور دراسي ${i + 1}`, 180),
      summary: cleanAcademicOutput(section.summary || 'محور منظم من الكتب المقررة.', 1600),
      outcomes: sanitizeAcademicList(section.outcomes || [], ['شرح المحور وربطه بالتطبيق المهني'], 5, 180),
      sourceTitles: sanitizeAcademicList(section.sourceTitles || [], ['بنك المعرفة'], 5, 160),
    })).filter((section) => section.title && section.summary && !looksLikeBrokenGeneratedArabic(`${section.title}. ${section.summary}`)).slice(0, 8),
  })).filter((guide) => guide.title && guide.overview && !looksLikeBrokenGeneratedArabic(`${guide.title}. ${guide.overview}`)), [studyGuides])

  // Load my programs
  const loadList = useCallback(async () => {
    try {
      // الأولوية لظهور البرامج المسجلة بسرعة؛ لا ننتظر الشات والذاكرة والشارات حتى تظهر قائمة «برامجي».
      const [p, e] = await Promise.all([
        api<{ programs: any[] }>('/api/programs?summary=1'),
        api<{ enrollments: MyEnrollment[] }>('/api/my/enrollments').catch(() => ({ enrollments: [] as any[] })),
      ])
      setPrograms(p.programs)
      setEnrollments(e.enrollments || [])

      setServiceDeliverablesLoading(true)
      Promise.all([
        api<{ messages: ChatMsg[] }>('/api/chat').catch(() => ({ messages: [] as ChatMsg[] })),
        api<{ memory: AcademicMemorySnapshot | null }>('/api/my/academic-memory').catch(() => ({ memory: null })),
        api<{ earned: MicroCredentialCard[]; available: MicroCredentialCard[] }>('/api/my/micro-credentials').catch(() => ({ earned: [], available: [] })),
        api<StudentDashboardSummary>('/api/my/dashboard-summary').catch(() => null),
        api<{ deliverables: ServiceDeliverableRow[] }>('/api/service-deliverables').catch(() => ({ deliverables: [] as ServiceDeliverableRow[] })),
      ]).then(([c, m, mc, summary, deliverablesRes]) => {
        setLastChats(c.messages.slice(-2))
        setAcademicMemory(m.memory || null)
        setEarnedMicroCredentials(mc.earned || [])
        setAvailableMicroCredentials(mc.available || [])
        if (summary) setStudentSummary(summary)
        setServiceDeliverables(deliverablesRes.deliverables || [])
      }).catch(() => {}).finally(() => setServiceDeliverablesLoading(false))

      return e.enrollments || []
    } catch {
      setServiceDeliverablesLoading(false)
      return []
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const enrolls = await loadList()
      if (cancelled) return
      // Prefer the requested enrolled program on return from a learning item.
      const requestedProgramId = useAppStore.getState().activeProgramId
      const selected = enrolls.find((x) => x.programId === requestedProgramId && x.status !== 'PENDING_PAYMENT')
        || enrolls.find((x) => x.status !== 'PENDING_PAYMENT')
      if (selected) await open(selected.programId)
    })()
    return () => { cancelled = true }
  }, [loadList])

  const open = async (programId: string) => {
    setLoadingActive(true)
    try {
      const d = await api<ProgressData>(`/api/progress?programId=${programId}`)
      setActive(d)
      setAssignments([])
      setStudyGuides([])
      setStudyScheduleItems([])
      const returningToSchedule = useAppStore.getState().activeProgramId === programId
        && new URLSearchParams(window.location.search).get('section') === 'schedule'
      setProgramSection(returningToSchedule ? 'schedule' : 'academic')
      Promise.all([
        api<{ assignments: StudentAssignment[] }>(`/api/assignments?programId=${programId}`).catch(() => ({ assignments: [] as StudentAssignment[] })),
        api<{ guides: StudentStudyGuide[] }>(`/api/study-guides?programId=${programId}`).catch(() => ({ guides: [] as StudentStudyGuide[] })),
        api<{ items: StudentStudyScheduleItem[] }>(`/api/study-schedule?programId=${programId}`).catch(() => ({ items: [] as StudentStudyScheduleItem[] })),
      ])
        .then(([a, g, schedule]) => {
          setAssignments(a.assignments || [])
          setStudyGuides(g.guides || [])
          setStudyScheduleItems(schedule.items || [])
        })
        .catch(() => null)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setLoadingActive(false)
    }
  }

  const markReadyForSemesterExam = async (semester: number) => {
    if (!active) return
    try {
      const res = await api<{ ok: boolean; message: string }>(`/api/progress`, {
        method: 'POST',
        body: JSON.stringify({ action: 'READY_FOR_EXAM', programId: active.program.id, semester }),
      })
      toast({ title: 'تم تحديث جاهزية الامتحان', description: res.message })
      await open(active.program.id)
    } catch (e: any) {
      toast({ title: 'تعذر تفعيل الامتحان', description: e.message, variant: 'destructive' })
    }
  }

  const submitAssignment = async (assignmentId: string) => {
    const scrollBeforeSubmit = typeof window !== 'undefined' ? window.scrollY : 0
    const answerText = (assignmentDrafts[assignmentId] || '').trim()
    const file = assignmentFiles[assignmentId]
    if (!answerText && !file) {
      toast({ title: 'تنبيه', description: 'اكتب إجابتك أو أرفق ملف الواجب قبل التسليم', variant: 'destructive' })
      return
    }
    setSubmittingAssignmentId(assignmentId)
    try {
      const fd = new FormData()
      fd.append('assignmentId', assignmentId)
      fd.append('answerText', answerText)
      if (file) fd.append('file', file)
      await api('/api/assignments', { method: 'POST', body: fd })
      setAssignmentDrafts((prev) => ({ ...prev, [assignmentId]: '' }))
      setAssignmentFiles((prev) => ({ ...prev, [assignmentId]: null }))
      if (active) await open(active.program.id)
      window.setTimeout(() => window.scrollTo({ top: scrollBeforeSubmit, behavior: 'smooth' }), 80)
      toast({ title: 'تم تسليم الواجب', description: 'سيظهر في لوحة الإدارة للتصحيح والمراجعة' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSubmittingAssignmentId(null)
    }
  }

  // توجيه غير المسجل لصفحة الدخول — داخل useEffect لا أثناء الرسم (منع side-effect في render)
  useEffect(() => {
    if (!user) navigate('auth')
  }, [user, navigate])

  useEffect(() => {
    if (!user) return
    const academicTabs = ['programs', 'supervision', 'thesis', 'transcript', 'certs']
    if (!studentSummary && serviceDeliverablesLoading) return
    const hasStudySummary = (studentSummary?.summary?.studyRequests || 0) > 0 || !!studentSummary?.summary?.latestStudy
    const hasServiceSummary = (studentSummary?.summary?.serviceRequests || 0) > 0 || serviceDeliverables.length > 0
    if (enrollments.length === 0 && !hasStudySummary && !hasServiceSummary) {
      navigate('programs')
      return
    }
    if (enrollments.length === 0 && academicTabs.includes(dashboardTab)) {
      setDashboardTab(hasServiceSummary && !hasStudySummary ? 'deliverables' : 'payments')
    }
    if (hasStudySummary && !hasServiceSummary && dashboardTab === 'deliverables') {
      setDashboardTab('payments')
    }
  }, [user, enrollments.length, serviceDeliverables.length, serviceDeliverablesLoading, dashboardTab, studentSummary, navigate])

  if (!user) {
    return null
  }

  const hasStudyApplication = (studentSummary?.summary?.studyRequests || 0) > 0 || !!studentSummary?.summary?.latestStudy
  const hasServiceApplication = (studentSummary?.summary?.serviceRequests || 0) > 0 || serviceDeliverables.length > 0
  const hasProgramDashboard = enrollments.length > 0
  const hasStudyIdentity = hasProgramDashboard || hasStudyApplication
  const showDeliverablesTab = !hasStudyIdentity || hasServiceApplication
  const myProgramIds = new Set(enrollments.map((e) => e.programId))
  const available = hasProgramDashboard ? programs.filter((p) => !myProgramIds.has(p.id)) : []
  const activeAcademicProfile = active ? buildAcademicProgramProfile(active.program) : null
  const curriculumReady = !!active?.program.curriculumReadiness?.approved
  const curriculumMessage = active?.program.curriculumReadiness?.message || 'جاري تجهيز المنهج الأكاديمي لهذا التخصص. سيتم تجهيز الكتب والوحدات خلال 24 ساعة.'
  const academicNextAction = academicMemory?.recommendedNextActions?.slice(-1)[0]
  const memoryUpdatedAt = academicMemory?.updatedAt || academicMemory?.lastInteractionAt
  const formatMemoryDate = (value?: string | null) => {
    if (!value) return 'لم تُحدّث بعد'
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? 'لم تُحدّث بعد' : date.toLocaleDateString('ar-EG')
  }

  const currentStudentAction = (() => {
    if (studentSummary?.summary?.requiredAction) {
      const a = studentSummary.summary.requiredAction
      return { title: a.title, text: a.body, tab: a.target }
    }
    if (!active) return null
    const pendingAssignment = assignments.find((a) => !a.submission || a.submission.status === 'NEEDS_REVISION')
    if (pendingAssignment) return { title: 'واجب مطلوب الآن', text: `أكمل واجب «${pendingAssignment.title}» قبل الامتحان النهائي للفصل.`, tab: 'programs' }
    const unitExam = active.units.find((u) => u.examId && !u.examPassed)
    if (unitExam) return { title: 'اختبار فصلي مطلوب', text: `اجتز اختبار وحدة «${unitExam.title}» لاستكمال متطلبات الفصل.`, tab: 'programs' }
    const nextExam = (active.semesterExams || []).find((e: any) => !e.passed)
    if (nextExam) {
      const r = nextExam.readiness
      const tuitionGate = nextExam.tuitionGate
      const tuitionLocked = Boolean(tuitionGate && !tuitionGate.allowed)
      return {
        title: tuitionLocked ? 'سداد الرسوم مطلوب قبل الامتحان' : r?.readyMarked ? 'ابدأ الامتحان النهائي للفصل' : 'أكد جاهزيتك للامتحان النهائي',
        text: tuitionLocked
          ? tuitionGate?.message || 'أكمل سداد الرسوم المطلوبة لفتح امتحان الفصل.'
          : r?.readyMarked
          ? `زر بدء امتحان ${nextExam.title} أصبح متاحًا.`
          : `راجع المتطلبات ثم اضغط «جاهز للامتحان» لتفعيل زر البدء.`,
        tab: 'programs',
      }
    }
    return { title: 'تابع بحث التخرج أو شهادتك', text: 'أكملت متطلبات الدراسة الأساسية لهذا البرنامج. انتقل إلى بحث التخرج أو الشهادات حسب حالتك.', tab: 'thesis' }
  })()

  const semesterStudyPlans = active?.semesterExams?.map((exam: any) => {
    const semester = exam.semester
    const semesterBooks = (active.program.books || []).filter((b) => !b.semester || b.semester === semester)
    const semesterUnits = (active.program.units || []).filter((u) => active.units.some((au) => au.id === u.id))
    const semesterAssignments = assignments.filter((a) => a.semester === semester)
    const hours = Math.max(20, Number(active.program.hours || 60))
    const booksHours = Math.max(4, Math.round(hours * 0.45))
    const unitsHours = Math.max(4, Math.round(hours * 0.3))
    const assignmentsHours = Math.max(2, Math.round(hours * 0.15))
    const revisionHours = Math.max(2, hours - booksHours - unitsHours - assignmentsHours)
    return { semester, exam, semesterBooks, semesterUnits, semesterAssignments, hours, booksHours, unitsHours, assignmentsHours, revisionHours }
  }) || []

  const publishedScheduleGrouped = studyScheduleItems.reduce<Record<number, StudentStudyScheduleItem[]>>((acc, item) => {
    acc[item.week] = acc[item.week] || []
    acc[item.week].push(item)
    return acc
  }, {})
  const publishedScheduleWeeks = Object.entries(publishedScheduleGrouped)
    .map(([week, weekItems]) => ({ week: Number(week), items: weekItems.sort((a, b) => (a.dayOffset || 0) - (b.dayOffset || 0) || a.order - b.order) }))
    .sort((a, b) => a.week - b.week)

  const formatScheduleDate = (value?: string | null) => {
    if (!value) return ''
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('ar-EG')
  }

  const handleSemesterExamAction = (exam: any) => {
    if (!active) return
    const sem1 = (active.semesterExams || []).find((e: any) => e.semester === 1)
    const readiness = exam.readiness
    const tuitionGate = exam.tuitionGate
    const tuitionLocked = Boolean(tuitionGate && !tuitionGate.allowed)
    const prereqLocked = exam.semester === 2 && sem1 && !sem1.passed
    const locked = prereqLocked || tuitionLocked || !readiness?.readyMarked
    if (locked) return
    return openExam(exam.id, 'final')
  }

  const openStudyScheduleItem = (item: StudentStudyScheduleItem) => {
    if (item.unitId) return openUnit(item.unitId)
    if (item.examId) {
      const exam = (active?.semesterExams || []).find((candidate: any) => candidate.id === item.examId)
      if (exam) return handleSemesterExamAction(exam)
      setProgramSection('content')
      toast({ title: 'هذا الامتحان غير متاح بعد' })
      return
    }
    if (item.assignmentId || item.studyGuideId) {
      setProgramSection('content')
      return
    }
  }

  const aiSupervisorAccess = studentSummary?.aiSupervisorAccess
  const aiSupervisorAllowed = !!aiSupervisorAccess?.allowed
  const aiSupervisorBlockedReason = aiSupervisorAccess?.reason || 'يتاح المشرف الذكي بعد سداد رسوم التقديم وتفعيل الإشراف من الإدارة.'
  const openAiSupervisor = () => {
    if (!aiSupervisorAllowed) {
      toast({ title: 'المشرف الذكي غير مفعل بعد', description: aiSupervisorBlockedReason, variant: 'destructive' })
      return
    }
    navigate('chat')
  }

  const scrollToDashboardContent = () => {
    if (typeof window === 'undefined') return
    window.setTimeout(() => {
      dashboardContentRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 0)
  }

  const selectDashboardTab = (tab: string) => {
    setDashboardTab(tab)
    scrollToDashboardContent()
  }

  const openProgramWorkspace = (section: string) => {
    setDashboardTab('programs')
    setProgramSection(section)
    scrollToDashboardContent()
  }

  const dashboardTabOptions = [
    { value: 'programs', label: 'الرئيسية والمقرر والكتاب', show: hasProgramDashboard },
    { value: 'supervision', label: 'المشرف الذكي وحواراته ونقاط القوة', show: hasProgramDashboard },
    { value: 'lectures', label: 'المحاضرات واللقاءات', show: hasProgramDashboard && lecturesVisible },
    { value: 'payments', label: 'المدفوعات والرسوم', show: true },
    { value: 'deliverables', label: 'المخرجات والخدمات', show: showDeliverablesTab },
    { value: 'notifications', label: 'الإشعارات والتنبيهات', show: true },
    { value: 'thesis', label: 'بحث التخرج والمناقشة', show: hasProgramDashboard },
    { value: 'transcript', label: 'السجل الأكاديمي', show: hasProgramDashboard },
    { value: 'certs', label: 'الشهادات', show: hasProgramDashboard },
  ].filter((item) => item.show)

  const primaryStudentCards = [
    {
      key: 'book',
      title: 'المقرر والكتاب',
      text: `${(active?.program.books || []).length} كتاب/مصدر · افتح المواد المقررة`,
      icon: <BookOpen className="h-8 w-8 text-rose-500" />,
      action: () => openProgramWorkspace('schedule'),
      show: hasProgramDashboard,
      tone: 'from-rose-50 to-white border-rose-100',
    },
    {
      key: 'units',
      title: 'الوحدات والواجبات',
      text: `${active?.units.length || 0} وحدة · ${assignments.length} واجب`,
      icon: <ClipboardCheck className="h-8 w-8 text-emerald-600" />,
      action: () => openProgramWorkspace('content'),
      show: hasProgramDashboard,
      tone: 'from-emerald-50 to-white border-emerald-100',
    },
    {
      key: 'lectures',
      title: 'المحاضرات واللقاءات',
      text: lecturesVisible ? 'افتح اللقاءات والمحاضرات من هنا' : 'تظهر عند تفعيل اللقاءات',
      icon: <Video className="h-8 w-8 text-blue-600" />,
      action: () => selectDashboardTab('lectures'),
      show: hasProgramDashboard && lecturesVisible,
      tone: 'from-blue-50 to-white border-blue-100',
    },
    {
      key: 'exams',
      title: 'الامتحانات',
      text: `${active?.semesterExams?.length || 0} امتحان نهائي · اختبارات الوحدات داخل الوحدات`,
      icon: <ListChecks className="h-8 w-8 text-violet-600" />,
      action: () => openProgramWorkspace('progress'),
      show: hasProgramDashboard,
      tone: 'from-violet-50 to-white border-violet-100',
    },
    {
      key: 'schedule',
      title: 'الجدول الدراسي',
      text: publishedScheduleWeeks.length ? `${publishedScheduleWeeks.length} أسبوع منشور` : 'خطة الفصول والمواد',
      icon: <ScrollText className="h-8 w-8 text-sky-600" />,
      action: () => openProgramWorkspace('schedule'),
      show: hasProgramDashboard,
      tone: 'from-sky-50 to-white border-sky-100',
    },
    {
      key: 'payments',
      title: 'المدفوعات والرسوم',
      text: `${studentSummary?.summary.unpaidPayments || 0} دفعة تحتاج متابعة`,
      icon: <Banknote className="h-8 w-8 text-amber-600" />,
      action: () => selectDashboardTab('payments'),
      show: true,
      tone: 'from-amber-50 to-white border-amber-100',
    },
  ].filter((item) => item.show)

  const pulseNotice = currentStudentAction || (studentSummary?.unread
    ? { title: 'إشعارات جديدة تحتاج قراءة', text: `لديك ${studentSummary.unread} إشعار غير مقروء داخل المنصة.`, tab: 'notifications' }
    : lecturesVisible && hasProgramDashboard
      ? { title: 'تابع اللقاءات والمحاضرات', text: 'عند نشر لقاء مباشر أو محاضرة ستجدها في قسم المحاضرات واللقاءات.', tab: 'lectures' }
      : null)

  return (
    <div className="aact-fade-in mx-auto max-w-[1600px] px-3 py-5 sm:px-4 sm:py-8">
      <div className="mb-5 rounded-[2rem] border border-white/80 bg-white/90 p-3 shadow-sm backdrop-blur">
        <div className="grid gap-3 lg:grid-cols-[1fr_520px_auto] lg:items-center">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0f2b46] via-[#1f4f86] to-[#2f6df6] text-lg font-black text-white shadow-sm">
              {(user.name || 'ط')[0]}
            </div>
            <div>
              <h1 className="text-xl font-black text-[#0f2b46] sm:text-2xl">أهلاً {user.name}</h1>
              <p className="mt-0.5 text-xs font-bold text-slate-500">{hasStudyIdentity ? (hasProgramDashboard ? `${active?.program.titleAr || 'رحلتك التدريبية'} في مكان واحد` : 'طلبك الدراسي قيد المتابعة حتى تفعيل التسجيل') : 'طلباتك وخدماتك ومخرجاتك في مكان واحد'}</p>
            </div>
          </div>
          <div className="hidden rounded-2xl border border-[#0f2b46]/10 bg-slate-50 px-4 py-3 text-xs font-bold text-slate-400 lg:flex lg:items-center lg:justify-between">
            <span>ابحث في محاضراتك وكتبك وواجباتك...</span>
            <span className="rounded-lg border border-slate-200 bg-white px-2 py-1 font-mono text-[10px] text-slate-400">Ctrl + K</span>
          </div>
          <div className="flex flex-wrap justify-start gap-2 lg:justify-end">
            <Button type="button" variant="outline" onClick={() => selectDashboardTab('notifications')} className="relative h-11 rounded-2xl border-slate-200 bg-white px-3 text-[#0f2b46] hover:bg-slate-50">
              <Bell className="h-4 w-4" />
              {!!studentSummary?.unread && <span className="absolute -right-1 -top-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-black text-white">{studentSummary.unread}</span>}
            </Button>
            <Button type="button" variant="outline" onClick={openAiSupervisor} className="h-11 rounded-2xl border-[#c9a227]/40 bg-white px-3 text-xs font-black text-[#a8841a] hover:bg-[#fffaf0]">
              <Bot className="ml-1.5 h-4 w-4" /> المشرف الذكي
            </Button>
          </div>
        </div>
      </div>

      {studentSummary && (
        <details className="mb-6 rounded-[2rem] border border-[#0f2b46]/10 bg-white/90 p-3 shadow-sm">
          <summary className="cursor-pointer rounded-2xl px-2 py-1 text-sm font-black text-[#0f2b46] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a227]">
            حالة الطلبات والدفع والوثائق — محفوظة هنا بدون تكدس
          </summary>
          <section className="mt-3 grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-3xl border border-[#c9a227]/30 bg-[#fffaf0] p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[11px] font-black text-[#a8841a]">{hasStudyIdentity ? 'المسار المختصر للطالب' : 'المسار المختصر للعميل'}</p>
                <h2 className="mt-1 text-lg font-black text-[#0f2b46]">{hasStudyIdentity ? (currentStudentAction?.title || (hasProgramDashboard ? 'تابع برنامجك من هنا' : 'طلبك الدراسي قيد الإجراء')) : 'تابع طلباتك ومخرجاتك من هنا'}</h2>
                <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{hasStudyIdentity ? (currentStudentAction?.text || (hasProgramDashboard ? 'اختر برنامجك النشط وتابع الكتب والاختبارات والواجبات والإشعارات.' : 'بعد مراجعة الإدارة وسداد المتطلبات ستُفتح بوابة الدراسة والكتب والاختبارات.')) : 'هذه بوابة خدماتك العابرة: الدفعات، حالة الطلب، وروابط التحميل أو الشهادات التي تنشرها الإدارة.'}</p>
              </div>
              {currentStudentAction?.tab && currentStudentAction.tab !== dashboardTab ? (
                <Button onClick={() => selectDashboardTab(currentStudentAction.tab)} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">
                  انتقل الآن
                </Button>
              ) : null}
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-4">
              {hasStudyIdentity ? (
                <>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">طلبات دراسة<br /><span className="text-lg text-[#0f2b46]">{studentSummary.summary.studyRequests || 0}</span></div>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">دفعات مطلوبة<br /><span className="text-lg text-[#0f2b46]">{studentSummary.summary.unpaidPayments}</span></div>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">حالة القبول<br /><span className="text-sm text-[#0f2b46]">{studentStatusLabel(studentSummary.summary.latestStudy?.status || studentSummary.summary.latestAdmission?.status)}</span></div>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">التسجيل الدراسي<br /><span className="text-sm text-[#0f2b46]">{hasProgramDashboard ? 'مفعل' : 'بانتظار الاعتماد'}</span></div>
                </>
              ) : (
                <>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">طلبات خدمة<br /><span className="text-lg text-[#0f2b46]">{studentSummary.summary.serviceRequests || 0}</span></div>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">دفعات مطلوبة<br /><span className="text-lg text-[#0f2b46]">{studentSummary.summary.unpaidPayments}</span></div>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">مخرجات منشورة<br /><span className="text-lg text-[#0f2b46]">{studentSummary.summary.serviceDeliverables || serviceDeliverables.length}</span></div>
                  <div className="rounded-2xl bg-white p-3 text-center text-xs font-black text-slate-600">إشعارات جديدة<br /><span className="text-lg text-[#0f2b46]">{studentSummary.unread}</span></div>
                </>
              )}
            </div>
          </div>
          <div className="rounded-3xl border border-[#0f2b46]/10 bg-white p-5">
            <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Banknote className="h-5 w-5 text-[#c9a227]" /> حالة الطلبات والدفع</h3>
            <div className="mt-3 space-y-2 text-xs font-bold leading-6 text-slate-600">
              <p><b>آخر طلب:</b> {studentSummary.summary.latestAdmission ? `${studentSummary.summary.latestAdmission.requestType === 'SERVICE' ? 'خدمة' : 'دراسة'} · ${studentSummary.summary.latestAdmission.reference || '-'} · ${studentStatusLabel(studentSummary.summary.latestAdmission.status)}` : 'لا يوجد طلب حديث'}</p>
              <p><b>الدفع:</b> {studentSummary.summary.unpaidPayments ? `يوجد ${studentSummary.summary.unpaidPayments} دفعة تحتاج متابعة` : 'لا توجد دفعات معلقة'}</p>
              <p><b>التسجيل الدراسي:</b> {studentSummary.summary.activeEnrollment ? `مسجل في ${studentSummary.summary.activeEnrollment.program?.titleAr || 'برنامج'}` : 'لا يوجد تسجيل دراسي نشط'}</p>
            </div>
            {studentSummary.summary.latestAdmission?.documents?.length ? (
              <div className="mt-3 rounded-2xl border border-[#c9a227]/20 bg-[#fffaf0] p-3">
                <p className="mb-2 text-xs font-black text-[#0f2b46]">وثائق الطلب</p>
                <div className="flex flex-wrap gap-2">
                  {studentSummary.summary.latestAdmission.documents.map((doc: any) => (doc.fileUrl || doc.downloadUrl) ? (
                    <a key={doc.id || doc.fileName} href={doc.fileUrl || doc.downloadUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center rounded-lg border border-[#c9a227]/40 bg-white px-3 py-1.5 text-[11px] font-black text-[#a8841a] hover:bg-[#f7edd0]">
                      <FileText className="ml-1 h-3.5 w-3.5" /> {doc.fileName || doc.docType || 'وثيقة'}
                    </a>
                  ) : null)}
                </div>
              </div>
            ) : null}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button size="sm" variant="outline" onClick={() => selectDashboardTab('payments')} className="border-[#c9a227] font-black text-[#a8841a] hover:bg-[#f7edd0]">
                الدفعات
              </Button>
              <Button size="sm" onClick={() => navigate('apply')} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">
                طلب جديد
              </Button>
            </div>
          </div>
          </section>
        </details>
      )}

      <section className="mb-6 grid gap-4 xl:grid-cols-[210px_minmax(0,1fr)_340px]">
        <aside className="hidden rounded-[2rem] border border-[#0f2b46]/10 bg-white/95 p-3 shadow-sm xl:block" aria-label="قائمة خدمات بوابة الطالب">
          <div className="mb-3 rounded-2xl bg-gradient-to-br from-[#f8fbff] to-[#eef4ff] p-3">
            <p className="text-[10px] font-black text-slate-400">القائمة الكاملة</p>
            <p className="mt-1 text-sm font-black text-[#0f2b46]">كل خدماتك محفوظة هنا</p>
          </div>
          <div className="space-y-1.5">
            {dashboardTabOptions.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => selectDashboardTab(item.value)
                className={`flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-right text-[11px] font-black transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a227] ${dashboardTab === item.value ? 'bg-[#2f6df6] text-white shadow-sm' : 'text-[#0f2b46] hover:bg-slate-50'}`}
              >
                <span>{item.label}</span>
                <ChevronLeft className="h-3.5 w-3.5 opacity-70" />
              </button>
            ))}
          </div>
        </aside>

        <div className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_320px]">
            <div className="relative overflow-hidden rounded-[2rem] border border-blue-100 bg-gradient-to-br from-[#0f2b46] via-[#2856d6] to-[#6d5dfc] p-5 text-white shadow-sm sm:p-6">
              <div className="absolute -right-16 -top-16 h-44 w-44 rounded-full bg-white/10 blur-2xl" />
              <div className="absolute -bottom-20 left-8 h-56 w-56 rounded-full bg-[#c9a227]/20 blur-3xl" />
              <div className="relative grid gap-5 md:grid-cols-[1fr_250px] md:items-center">
                <div>
                  <p className="text-[11px] font-black text-white/70">بوصلتك الدراسية</p>
                  <h2 className="mt-2 text-2xl font-black leading-10 sm:text-3xl">مرحبًا مجددًا {user.name}</h2>
                  <p className="mt-2 text-sm font-bold leading-7 text-white/85">واصل رحلتك نحو التميز. أهم ما تحتاجه اليوم ظاهر أمامك: الكتاب، الوحدات، اللقاءات، الواجبات، الامتحانات والجدول.</p>
                  <div className="mt-4 rounded-2xl border border-white/20 bg-white/10 p-3 text-xs font-bold leading-6 text-white/85 backdrop-blur">
                    العلم لا يكتمل إلا بالعمل المستمر، وأنت تسير في الطريق الصحيح.
                  </div>
                </div>
                <div className="rounded-3xl border border-white/30 bg-white/95 p-4 text-[#0f2b46] shadow-lg">
                  <p className="text-[11px] font-black text-slate-500">مستواك الأكاديمي الحالي</p>
                  <p className="mt-2 text-sm font-black">{active?.program.titleAr || 'برنامجك الدراسي'}</p>
                  <div className="mt-4 flex items-center gap-4">
                    <div className="flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-blue-100 to-violet-100 text-xl font-black text-[#2f6df6] ring-8 ring-blue-50">
                      {active?.progress ?? 0}%
                    </div>
                    <div className="min-w-0 flex-1">
                      <Progress value={active?.progress || 0} className="h-2 bg-slate-100" />
                      <p className="mt-2 text-[11px] font-bold text-slate-500">{active ? `${active.completedUnits.length} وحدة مكتملة من ${active.units.length}` : 'يظهر التقدم بعد تفعيل البرنامج'}</p>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-3 divide-x divide-x-reverse divide-slate-100 rounded-2xl bg-slate-50 p-2 text-center text-[11px] font-black text-slate-500">
                    <div><b className="block text-base text-[#0f2b46]">{active?.units.length || 0}</b>وحدات</div>
                    <div><b className="block text-base text-[#0f2b46]">{assignments.length}</b>واجبات</div>
                    <div><b className="block text-base text-[#0f2b46]">{active?.semesterExams?.length || 0}</b>امتحانات</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-[2rem] border border-red-100 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-base font-black text-[#0f2b46]">المهام العاجلة</h3>
                <span className="rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-black text-white">{(pulseNotice ? 1 : 0) + assignments.filter((a) => !a.submitted).slice(0, 3).length}</span>
              </div>
              {pulseNotice ? (
                <div className="mb-3 rounded-2xl border border-red-100 bg-red-50 p-3">
                  <div className="flex items-start gap-3">
                    <span className="relative mt-1 flex h-3 w-3">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-70" />
                      <span className="relative inline-flex h-3 w-3 rounded-full bg-red-500" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-black text-[#0f2b46]">{pulseNotice.title}</p>
                      <p className="mt-1 text-xs font-bold leading-6 text-red-700">{pulseNotice.text}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button type="button" size="sm" variant="outline" onClick={playStudentPulseTone} className="border-red-200 bg-white text-[11px] font-black text-red-600 hover:bg-red-50">
                      <Bell className="ml-1 h-3.5 w-3.5" /> صوت التنبيه
                    </Button>
                    {pulseNotice.tab && (
                      <Button type="button" size="sm" onClick={() => selectDashboardTab(pulseNotice.tab) className="bg-red-600 text-[11px] font-black text-white hover:bg-red-700">
                        فتح المطلوب
                      </Button>
                    )}
                  </div>
                </div>
              ) : null}
              <div className="space-y-2">
                {assignments.filter((a) => !a.submitted).slice(0, 3).map((assignment) => (
                  <button key={assignment.id} type="button" onClick={() => openProgramWorkspace('content')} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-right hover:bg-white">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-black text-[#0f2b46]">{assignment.title}</p>
                      <p className="mt-0.5 text-[11px] font-bold text-slate-500">{assignment.dueAt ? `آخر موعد ${new Date(assignment.dueAt).toLocaleDateString('ar-EG')}` : 'واجب مطلوب'}</p>
                    </div>
                    <FileText className="h-4 w-4 shrink-0 text-rose-500" />
                  </button>
                ))}
                {!pulseNotice && assignments.filter((a) => !a.submitted).length === 0 && (
                  <div className="rounded-2xl bg-emerald-50 p-3 text-center text-xs font-black text-emerald-700">لا توجد مهام عاجلة الآن</div>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
            {primaryStudentCards.map((card) => (
              <button
                key={card.key}
                type="button"
                onClick={card.action}
                className={`group min-h-[150px] rounded-3xl border bg-gradient-to-br ${card.tone} p-4 text-right shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c9a227] focus-visible:ring-offset-2`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="rounded-2xl bg-white p-3 shadow-sm">{card.icon}</div>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-[#2f6df6] shadow-sm transition group-hover:-translate-x-1">
                    <ChevronLeft className="h-4 w-4" />
                  </span>
                </div>
                <p className="mt-4 text-base font-black text-[#0f2b46]">{card.title}</p>
                <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{card.text}</p>
              </button>
            ))}
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            <div className="rounded-[1.75rem] border border-[#0f2b46]/10 bg-white p-4 shadow-sm lg:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-black text-[#0f2b46]">الوحدات الأقرب لك</h3>
                <Button type="button" variant="ghost" size="sm" onClick={() => openProgramWorkspace('content')} className="text-xs font-black text-[#2f6df6]">عرض الكل</Button>
              </div>
              <div className="space-y-2">
                {(active?.units || []).slice(0, 4).map((unit, index) => {
                  const done = active?.completedUnits.includes(unit.id)
                  return (
                    <button key={unit.id} type="button" onClick={() => openUnit(unit.id)} className="flex w-full items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-right hover:bg-white">
                      <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-black ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>{index + 1}</span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-black text-[#0f2b46]">{unit.title}</p>
                        <Progress value={done ? 100 : 0} className="mt-2 h-1.5 bg-slate-200" />
                      </div>
                      {done ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <ChevronLeft className="h-4 w-4 text-slate-400" />}
                    </button>
                  )
                })}
                {!active?.units?.length && <p className="rounded-2xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">تظهر الوحدات بعد تفعيل البرنامج.</p>}
              </div>
            </div>
            <div className="rounded-[1.75rem] border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-black text-[#0f2b46]">نصيحة اليوم</h3>
              <p className="mt-3 rounded-2xl bg-[#fffaf0] p-3 text-xs font-bold leading-6 text-[#5c4d1a]">خصص وقتًا يوميًا للمراجعة. المعرفة تقوى بالممارسة المستمرة، والمشرف الذكي جاهز لمساعدتك عند الحاجة.</p>
              <Button type="button" onClick={openAiSupervisor} className="mt-3 w-full rounded-2xl bg-[#2f6df6] text-xs font-black text-white hover:bg-[#1e55d6]">
                ابدأ محادثة جديدة
              </Button>
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-4 shadow-sm xl:hidden">
            <p className="mb-2 text-[11px] font-black text-[#a8841a]">كل التبويبات</p>
            <select
              aria-label="القائمة الكاملة لتبويبات بوابة الطالب"
              value={dashboardTab}
              onChange={(event) => setDashboardTab(event.target.value)}
              className="h-11 w-full rounded-2xl border border-[#0f2b46]/15 bg-slate-50 px-3 text-xs font-black text-[#0f2b46] outline-none focus:border-[#c9a227] focus:ring-2 focus:ring-[#c9a227]/30"
            >
              {dashboardTabOptions.map((item) => (
                <option key={item.value} value={item.value}>{item.label}</option>
              ))}
            </select>
          </div>
          <div className="rounded-[2rem] border border-blue-100 bg-gradient-to-br from-blue-50 to-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-black text-blue-500">المشرف الذكي</p>
                <h3 className="mt-1 text-sm font-black text-[#0f2b46]">مساعدتك الفورية في دراستك</h3>
              </div>
              <Bot className="h-9 w-9 text-blue-600" />
            </div>
            <Button type="button" onClick={openAiSupervisor} className="mt-4 w-full rounded-2xl bg-[#2f6df6] text-xs font-black text-white hover:bg-[#1e55d6]">
              ابدأ محادثة جديدة
            </Button>
          </div>
          <div className="rounded-[2rem] border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-black text-[#0f2b46]">إشعارات مهمة</h3>
            <div className="mt-3 space-y-2 text-xs font-bold text-slate-600">
              <button type="button" onClick={() => setDashboardTab('notifications')} className="flex w-full items-center justify-between rounded-2xl bg-slate-50 p-3 text-right hover:bg-slate-100">
                <span>إشعارات غير مقروءة</span>
                <Badge className="bg-red-100 text-red-700 hover:bg-red-100">{studentSummary?.unread || 0}</Badge>
              </button>
              <button type="button" onClick={() => setDashboardTab('payments')} className="flex w-full items-center justify-between rounded-2xl bg-slate-50 p-3 text-right hover:bg-slate-100">
                <span>دفعات تحتاج متابعة</span>
                <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">{studentSummary?.summary.unpaidPayments || 0}</Badge>
              </button>
            </div>
          </div>
        </aside>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Main: tabs */}
        <div>
          <Tabs value={dashboardTab} onValueChange={setDashboardTab} dir="rtl">
            <TabsList className="hidden">
              {hasProgramDashboard && (
                <TabsTrigger value="programs" className="text-[11px] font-bold sm:text-sm">
                  <BookOpen className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> برامجي
                </TabsTrigger>
              )}
              {hasProgramDashboard && (
                <TabsTrigger value="supervision" className="text-[11px] font-bold sm:text-sm">
                  <MessageCircle className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> إشرافي
                </TabsTrigger>
              )}
              {hasProgramDashboard && lecturesVisible && (
                <TabsTrigger value="lectures" className="text-[11px] font-bold sm:text-sm">
                  <Video className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> المحاضرات واللقاءات
                </TabsTrigger>
              )}
              <TabsTrigger value="payments" className="text-[11px] font-bold sm:text-sm">
                <Banknote className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> الدفعات
              </TabsTrigger>
              {showDeliverablesTab && (
                <TabsTrigger value="deliverables" className="text-[11px] font-bold sm:text-sm">
                  <Award className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> مخرجاتي {serviceDeliverables.length ? `(${serviceDeliverables.length})` : ''}
                </TabsTrigger>
              )}
              <TabsTrigger value="notifications" className="text-[11px] font-bold sm:text-sm">
                <Bell className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> الإشعارات {studentSummary?.unread ? `(${studentSummary.unread})` : ''}
              </TabsTrigger>
              {hasProgramDashboard && (
                <TabsTrigger value="thesis" className="text-[11px] font-bold sm:text-sm">
                  <FileText className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> بحث التخرج
                </TabsTrigger>
              )}
              {hasProgramDashboard && (
                <TabsTrigger value="transcript" className="text-[11px] font-bold sm:text-sm">
                  <ScrollText className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> سجلي الأكاديمي
                </TabsTrigger>
              )}
              {hasProgramDashboard && (
                <TabsTrigger value="certs" className="text-[11px] font-bold sm:text-sm">
                  <Award className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> شهاداتي
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="programs" className="mt-6 space-y-6">
          {/* Enrolled programs tabs — يظهر فقط عند عدم وجود برنامج أو عند تعدد البرامج */}
          {enrollments.length !== 1 && (
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h2 className="mb-4 flex items-center gap-2 text-base font-black text-[#0f2b46]">
                <BookOpen className="h-5 w-5 text-[#c9a227]" /> برامجي المسجل بها
              </h2>
              {enrollments.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-6 text-center text-sm text-slate-500">
                  لم تسجل في أي برنامج بعد — اختر برنامجك من القائمة أدناه
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {enrollments.map((e) => {
                    const prog = programs.find((p) => p.id === e.programId)
                    const pending = e.status === 'PENDING_PAYMENT'
                    return (
                      <button
                        key={e.id}
                        onClick={() => (pending ? toast({ title: 'التسجيل غير مفعل بعد', description: `أكمل سداد فاتورة «${prog?.titleAr || 'البرنامج'}» من تبويب «الدفعات» بالأسفل لفتح المحتوى` }) : open(e.programId))}
                        className={`rounded-full border px-4 py-2 text-xs font-extrabold transition-colors ${
                          pending
                            ? 'border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100'
                            : active?.program.id === e.programId
                              ? 'border-[#c9a227] bg-[#c9a227] text-[#0f2b46]'
                              : 'border-[#0f2b46]/15 bg-white text-[#0f2b46] hover:border-[#c9a227]'
                        }`}
                      >
                        {prog?.titleAr || 'برنامج'}{' '}
                        {e.status === 'COMPLETED' && '✓'}
                        {pending && <Banknote className="mr-1 inline h-3.5 w-3.5" />}
                      </button>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>
          )}

          {/* Active program */}
          {loadingActive ? (
            <div className="flex h-48 items-center justify-center rounded-2xl bg-slate-50">
              <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
            </div>
          ) : active ? (
            <Card className="border-[#0f2b46]/10">
              <CardContent className="p-5 sm:p-6">
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-black text-[#0f2b46]">{active.program.titleAr}</h2>
                  {active.status === 'COMPLETED' && (
                    <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                      <Trophy className="ml-1 h-3 w-3" /> مكتمل
                    </Badge>
                  )}
                </div>
                <p className="text-xs font-bold text-[#a8841a]">{active.program.titleEn}</p>

                {/* Progress */}
                <div className="mt-4 rounded-xl bg-[#f7edd0]/50 p-4">
                  <div className="mb-2 flex items-center justify-between text-xs font-extrabold text-[#0f2b46]">
                    <span>تقدمك في البرنامج</span>
                    <span className="text-[#a8841a]">{active.progress}%</span>
                  </div>
                  <Progress value={active.progress} className="h-2.5 bg-white" />
                </div>

                {currentStudentAction && (
                  <div className="mt-4 rounded-2xl border border-[#c9a227]/40 bg-[#fffaf0] p-4">
                    <p className="text-[11px] font-black text-[#a8841a]">ماذا عليّ الآن؟</p>
                    <h3 className="mt-1 text-base font-black text-[#0f2b46]">{currentStudentAction.title}</h3>
                    <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{currentStudentAction.text}</p>
                    {currentStudentAction.tab !== dashboardTab && (
                      <Button size="sm" onClick={() => setDashboardTab(currentStudentAction.tab)} className="mt-3 bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">
                        انتقل للخطوة المطلوبة
                      </Button>
                    )}
                  </div>
                )}

                {active.finalScore != null && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-sm font-bold text-emerald-700">
                    <Award className="h-5 w-5" />
                    النتيجة النهائية: {active.finalScore}% — رقم الشهادة سيصدر تلقائياً (خلال 30 يوماً وفق اللوائح)
                  </div>
                )}

                <div className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-slate-50 p-2">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      ['academic', 'ملفك الأكاديمي'],
                      ['schedule', 'جدول الدراسة'],
                      ['progress', 'خطة التقدم'],
                      ['content', 'المحتوى والواجبات'],
                    ].map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setProgramSection(key)}
                        className={`rounded-xl px-3 py-2 text-[11px] font-black transition-colors ${programSection === key ? 'bg-[#0f2b46] text-[#e0b83a] shadow-sm' : 'bg-white text-[#0f2b46] hover:bg-[#f7edd0]'}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {!curriculumReady && (
                  <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-bold leading-7 text-amber-800">
                    <div className="flex items-start gap-2">
                      <Hourglass className="mt-1 h-5 w-5 shrink-0" />
                      <div>
                        <p className="font-black text-[#0f2b46]">المنهج قيد التجهيز الأكاديمي</p>
                        <p>{curriculumMessage}</p>
                        {active.program.curriculumReadiness?.dueAt && (
                          <p className="mt-1 text-xs text-amber-700">الموعد المتوقع: {new Date(active.program.curriculumReadiness.dueAt).toLocaleString('ar-EG')}</p>
                        )}
                        {active.program.curriculumReadiness?.counts && (
                          <div className="mt-3 grid gap-2 sm:grid-cols-3">
                            <div className="rounded-xl bg-white/75 p-2 text-[11px] text-amber-800">الكتب الجاهزة: <b>{active.program.curriculumReadiness.counts.books}</b></div>
                            <div className="rounded-xl bg-white/75 p-2 text-[11px] text-amber-800">الوحدات: <b>{active.program.curriculumReadiness.counts.units}</b></div>
                            <div className="rounded-xl bg-white/75 p-2 text-[11px] text-amber-800">بنك المعرفة: <b>{active.program.curriculumReadiness.counts.knowledgeItems}</b></div>
                            <div className="rounded-xl bg-white/75 p-2 text-[11px] text-amber-800">اختبارات منشورة: <b>{active.program.curriculumReadiness.counts.readyExams}</b></div>
                            <div className="rounded-xl bg-white/75 p-2 text-[11px] text-amber-800">اختبارات قيد المراجعة: <b>{active.program.curriculumReadiness.counts.reviewExams}</b></div>
                            <div className="rounded-xl bg-white/75 p-2 text-[11px] text-amber-800">أهداف الوحدات: <b>{active.program.curriculumReadiness.counts.unitsWithObjectives}</b></div>
                          </div>
                        )}
                        <p className="mt-3 rounded-xl bg-white/70 p-2 text-[11px] leading-5 text-amber-700">يمكنك متابعة بوابة الطالب هنا، وسيظهر المحتوى تلقائيًا فور اعتماد الإدارة للمنهج. لا تحتاج لاتخاذ إجراء إضافي.</p>
                      </div>
                    </div>
                  </div>
                )}

                {programSection === 'academic' && activeAcademicProfile && (
                  <section className="mt-4 rounded-2xl border border-[#c9a227]/35 bg-[#fffaf0] p-4">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <p className="text-[11px] font-black text-[#a8841a]">ملفك الأكاديمي في هذا البرنامج</p>
                        <h3 className="mt-1 text-base font-black leading-snug text-[#0f2b46]">{activeAcademicProfile.academicTitle}</h3>
                        <p className="mt-1 text-xs leading-6 text-slate-600">{activeAcademicProfile.durationLabel} · {activeAcademicProfile.creditHoursLabel}</p>
                      </div>
                      <Badge className="w-fit bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{activeAcademicProfile.degreeLabel}</Badge>
                    </div>
                    <div className="mt-4 grid gap-3 lg:grid-cols-3">
                      <div className="rounded-xl bg-white p-3 shadow-sm">
                        <p className="mb-2 text-xs font-black text-[#0f2b46]">أهداف التعلم القريبة</p>
                        <ul className="space-y-1.5 text-[11px] font-bold leading-5 text-slate-600">
                          {activeAcademicProfile.learningOutcomes.slice(0, 3).map((item, i) => <li key={i}>• {item}</li>)}
                        </ul>
                      </div>
                      <div className="rounded-xl bg-white p-3 shadow-sm">
                        <p className="mb-2 text-xs font-black text-[#0f2b46]">خطة الدراسة</p>
                        <ul className="space-y-1.5 text-[11px] font-bold leading-5 text-slate-600">
                          {activeAcademicProfile.studyPlan.map((s, i) => <li key={s.title}>{i + 1}. {s.title}</li>)}
                        </ul>
                      </div>
                      <div className="rounded-xl bg-white p-3 shadow-sm">
                        <p className="mb-2 text-xs font-black text-[#0f2b46]">متطلبات التخرج</p>
                        <ul className="space-y-1.5 text-[11px] font-bold leading-5 text-slate-600">
                          {activeAcademicProfile.graduationRequirements.slice(0, 4).map((item, i) => <li key={i}>• {item}</li>)}
                        </ul>
                      </div>
                    </div>
                  </section>
                )}

                {programSection === 'schedule' && (
                  publishedScheduleWeeks.length > 0 ? (
                    <section className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
                      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-sm font-black text-[#0f2b46]">جدول الدراسة المنشور</h3>
                        <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">حسب تاريخ التسجيل</Badge>
                      </div>
                      <div className="space-y-3">
                        {publishedScheduleWeeks.map((week) => (
                          <div key={week.week} className="rounded-2xl border border-slate-100 bg-[#f8fafc] p-3">
                            <p className="mb-2 text-xs font-black text-[#0f2b46]">الأسبوع {week.week}</p>
                            <div className="space-y-2">
                              {week.items.map((item) => {
                                const canOpen = Boolean(item.unitId || item.examId || item.assignmentId || item.studyGuideId)
                                const itemDate = formatScheduleDate(item.targetDate)
                                return (
                                  <div key={item.id} className="rounded-xl bg-white p-3 text-[11px] font-bold leading-5 text-slate-600">
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                      <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{STUDY_SCHEDULE_TYPE_LABEL[item.type] || item.type}</Badge>
                                          {item.durationMin ? <Badge variant="outline">{item.durationMin} دقيقة</Badge> : null}
                                          {itemDate ? <Badge variant="outline">{itemDate}</Badge> : null}
                                        </div>
                                        <p className="mt-2 font-black text-[#0f2b46]">{item.title}</p>
                                        {item.description && <p className="mt-1 leading-6 text-slate-500">{item.description}</p>}
                                      </div>
                                      {canOpen && (
                                        <Button type="button" size="sm" variant="outline" onClick={() => openStudyScheduleItem(item)} className="h-9 shrink-0 border-[#c9a227]/40 text-[11px] font-black text-[#a8841a]">
                                          فتح العنصر
                                        </Button>
                                      )}
                                    </div>
                                  </div>
                                )
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  ) : semesterStudyPlans.length > 0 ? (
                    <section className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-black text-[#0f2b46]">جدول الدراسة للفصول والمواد المطلوبة</h3>
                      <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">بعد التسجيل مباشرة</Badge>
                    </div>
                    <div className="space-y-3">
                      {semesterStudyPlans.map((plan) => (
                        <div key={plan.exam.id} className="rounded-2xl border border-slate-100 bg-[#f8fafc] p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-xs font-black text-[#0f2b46]">الفصل {plan.semester} · {plan.exam.title}</p>
                              <p className="mt-1 text-[11px] font-bold text-slate-500">إجمالي ساعات مقترحة: {plan.hours} ساعة موزعة على الكتب والوحدات والواجبات والمراجعة.</p>
                            </div>
                            <Badge className="bg-white text-[#a8841a] hover:bg-white">{plan.exam.readiness?.complete ? 'متطلبات مكتملة' : 'قيد الاستكمال'}</Badge>
                          </div>
                          <div className="mt-3 grid gap-2 md:grid-cols-4">
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600"><b className="text-[#0f2b46]">الكتب</b><br />{plan.booksHours} ساعة · {plan.semesterBooks.length || 'كل'} كتاب/مصدر</div>
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600"><b className="text-[#0f2b46]">الوحدات والمحاضرات</b><br />{plan.unitsHours} ساعة · {active.units.length} وحدة</div>
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600"><b className="text-[#0f2b46]">الواجبات</b><br />{plan.assignmentsHours} ساعة · {plan.semesterAssignments.length} واجب</div>
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600"><b className="text-[#0f2b46]">المراجعة قبل الامتحان</b><br />{plan.revisionHours} ساعة · بعد استكمال المتطلبات</div>
                          </div>
                          <div className="mt-3 rounded-xl bg-white p-3 text-[11px] font-bold leading-5 text-slate-600">
                            <p className="font-black text-[#0f2b46]">المواد المطلوبة لهذا الفصل</p>
                            {plan.semesterBooks.length ? (
                              <div className="mt-2 grid gap-2">
                                {plan.semesterBooks.slice(0, 6).map((book) => {
                                  const canOpen = Boolean(book.id && (book.hasFile || book.hasLink))
                                  return (
                                    <div key={book.id || book.title} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 px-3 py-2">
                                      <span className="min-w-0 flex-1 truncate font-black text-[#0f2b46]">{book.title}</span>
                                      {canOpen ? (
                                        <Button type="button" size="sm" variant="outline" onClick={() => openBookResource(book)} className="h-8 shrink-0 border-[#c9a227]/40 text-[11px] font-black text-[#a8841a]">
                                          {book.hasFile ? <Download className="ml-1 h-3.5 w-3.5" /> : <ExternalLink className="ml-1 h-3.5 w-3.5" />}
                                          {book.hasFile ? 'تحميل الكتاب' : 'فتح الرابط'}
                                        </Button>
                                      ) : (
                                        <Badge className="shrink-0 bg-slate-100 text-slate-500 hover:bg-slate-100">غير مرفوع</Badge>
                                      )}
                                    </div>
                                  )
                                })}
                              </div>
                            ) : (
                              <p className="mt-1">تظهر الكتب والمواد هنا بعد اعتماد الإدارة للمنهج.</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                  ) : (
                    <section className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-6 text-center text-sm font-bold text-slate-500 shadow-sm">
                      جدول الدراسة قيد التجهيز وسيظهر هنا قريباً
                    </section>
                  )
                )}

                {programSection === 'progress' && (activeAcademicProfile?.termPlans?.length || 0) > 0 && (
                  <section className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-black text-[#0f2b46]">خطة تقدمك الفصلية</h3>
                      <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">درجة نهائية موزونة</Badge>
                    </div>
                    <div className="space-y-3">
                      {activeAcademicProfile!.termPlans.map((term) => {
                        const passedExam = term.exams.some((te) => (active.semesterExams || []).some((se) => se.semester === te.semester && se.passed))
                        const hasPublishedExam = term.exams.some((te) => te.status === 'READY' || (te.questionCount || 0) > 0)
                        return (
                          <div key={term.id} className="rounded-2xl border border-slate-100 bg-[#f8fafc] p-3">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <div className="flex flex-wrap items-center gap-2">
                                  {passedExam ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleDashed className="h-4 w-4 text-slate-300" />}
                                  <p className="text-xs font-black text-[#0f2b46]">{term.title}</p>
                                  <Badge variant="outline" className="text-[9px] font-black">{term.weight}%</Badge>
                                </div>
                                <p className="mt-1 text-[11px] font-bold leading-5 text-slate-600">{term.statusHint}</p>
                              </div>
                              <span className={`rounded-full px-2 py-1 text-[10px] font-black ${passedExam ? 'bg-emerald-100 text-emerald-700' : hasPublishedExam ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                                {passedExam ? 'منجز' : hasPublishedExam ? 'جاهز للتقييم' : 'قيد الإعداد'}
                              </span>
                            </div>
                            <div className="mt-3 grid gap-2 md:grid-cols-3">
                              <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600">
                                <p className="mb-1 font-black text-[#0f2b46]">الكتب</p>
                                {term.requiredBooks.length ? term.requiredBooks.slice(0, 3).map((b) => <p key={`${term.id}-${b.title}`}>• {b.title}</p>) : <p>تُضاف من الإدارة أو الروابط المقررة.</p>}
                              </div>
                              <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600">
                                <p className="mb-1 font-black text-[#0f2b46]">المهارات</p>
                                <p>{term.requiredSkills.slice(0, 4).join(' · ')}</p>
                              </div>
                              <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600">
                                <p className="mb-1 font-black text-[#0f2b46]">الواجبات/التقييم</p>
                                <p>{term.assignments[0]}</p>
                                <p className="mt-1 text-[#a8841a]">{term.finalEvaluation}</p>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>
                )}

                {programSection === 'content' && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setProgramSection('schedule')} className="mt-4 border-[#c9a227]/40 font-bold text-[#0f2b46]">
                    <ChevronLeft className="ml-1 h-4 w-4" /> العودة إلى جدول الدراسة
                  </Button>
                )}

                {/* تنظيم محتوى البرنامج داخل تبويبات فرعية حتى لا تتكدس أدلة الدراسة والواجبات والوحدات في صفحة واحدة */}
                {programSection === 'content' && (!curriculumReady ? (
                  <section className="mt-5 rounded-2xl border border-amber-200 bg-white p-6 text-center text-sm font-bold leading-7 text-slate-600">
                    <Hourglass className="mx-auto mb-2 h-8 w-8 text-amber-600" />
                    <p className="text-base font-black text-[#0f2b46]">الكتب والوحدات قيد التجهيز</p>
                    <p className="mt-1">{curriculumMessage}</p>
                    <p className="mt-2 text-xs text-slate-400">سيتم إظهار الكتب، الوحدات، الواجبات والاختبارات هنا فور اعتماد الإدارة للمنهج.</p>
                  </section>
                ) : (
                <Tabs defaultValue="guides" dir="rtl" className="mt-5 space-y-4">
                  <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-slate-50 p-1">
                    <TabsTrigger value="guides" className="text-[10px] font-black sm:text-xs"><BookMarked className="ml-1 h-3.5 w-3.5" /> أدلة الدراسة ({displayStudyGuides.length})</TabsTrigger>
                    <TabsTrigger value="assignments" className="text-[10px] font-black sm:text-xs"><ClipboardCheck className="ml-1 h-3.5 w-3.5" /> الواجبات ({assignments.length})</TabsTrigger>
                    <TabsTrigger value="units" className="text-[10px] font-black sm:text-xs"><BookOpen className="ml-1 h-3.5 w-3.5" /> الوحدات ({active.units.length})</TabsTrigger>
                  </TabsList>

                  <TabsContent value="guides" className="mt-0">
                {displayStudyGuides.length > 0 ? (
                  <section className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><BookMarked className="h-4 w-4 text-[#a8841a]" /> أدلة الدراسة والمحاضرات</h3>
                        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">محاور مذاكرة مولدة من كتبك وبنك المعرفة، لتجهيزك للواجبات والامتحانات والمناقشة.</p>
                      </div>
                      <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">{displayStudyGuides.length} دليل</Badge>
                    </div>
                    <div className="space-y-3">
                      {displayStudyGuides.map((guide) => (
                        <article key={guide.id} className="rounded-2xl border border-slate-100 bg-[#f8fafc] p-3">
                          <div className="mb-2 flex flex-wrap items-center gap-2">
                            <Badge className="bg-[#0f2b46] text-[9px] font-black text-[#e0b83a] hover:bg-[#0f2b46]">
                              {guide.semester === 2 ? 'الفصل الثاني' : guide.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول'}
                            </Badge>
                            <h4 className="text-sm font-black leading-6 text-[#0f2b46]">{guide.title}</h4>
                          </div>
                          <p className="text-xs font-bold leading-6 text-slate-600">{guide.overview}</p>
                          <div className="mt-3 grid gap-2 md:grid-cols-3">
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600">
                              <p className="mb-1 font-black text-[#0f2b46]">أهداف التعلم</p>
                              {guide.objectives.slice(0, 4).map((x, i) => <p key={i}>• {x}</p>)}
                            </div>
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600">
                              <p className="mb-1 font-black text-[#0f2b46]">محاور رئيسية</p>
                              {guide.sections.slice(0, 4).map((s, i) => <p key={i}>• {s.title}</p>)}
                            </div>
                            <div className="rounded-xl bg-white p-2 text-[11px] font-bold leading-5 text-slate-600">
                              <p className="mb-1 font-black text-[#0f2b46]">أسئلة نقاش</p>
                              {guide.discussionQuestions.slice(0, 3).map((x, i) => <p key={i}>• {x}</p>)}
                            </div>
                          </div>
                          {guide.keyTerms.length > 0 && (
                            <div className="mt-3 flex flex-wrap gap-1">
                              {guide.keyTerms.slice(0, 12).map((x, i) => <span key={i} className="rounded-full bg-[#f7edd0] px-2 py-1 text-[10px] font-black text-[#a8841a]">{x}</span>)}
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  </section>
                ) : (
                  <section className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-xs font-bold leading-6 text-slate-500">
                    لا توجد أدلة دراسة منشورة لهذا البرنامج بعد.
                  </section>
                )}
                  </TabsContent>

                  <TabsContent value="assignments" className="mt-0">
                {assignments.length > 0 ? (
                  <section className="rounded-2xl border border-[#c9a227]/35 bg-[#fffaf0] p-4">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-black text-[#0f2b46]">واجباتي وتكليفاتي</h3>
                        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">سلّم الواجبات المطلوبة لكل فصل؛ التصحيح يظهر هنا ويدخل في ملفك الأكاديمي.</p>
                      </div>
                      <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{assignments.length} واجب</Badge>
                    </div>
                    <div className="space-y-3">
                      {assignments.map((a) => {
                        const submission = a.submission
                        const graded = submission?.status === 'GRADED'
                        const needsRevision = submission?.status === 'NEEDS_REVISION'
                        const submitted = !!submission && !needsRevision
                        return (
                          <article key={a.id} className="rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  {graded ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <CircleDashed className="h-4 w-4 text-slate-300" />}
                                  <h4 className="text-sm font-black text-[#0f2b46]">{a.title}</h4>
                                  <Badge variant="outline" className="text-[9px] font-black">{a.semester === 2 ? 'الفصل الثاني' : a.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول'}</Badge>
                                  <Badge className="bg-[#f7edd0] text-[9px] font-black text-[#a8841a] hover:bg-[#f7edd0]">{a.points} نقاط</Badge>
                                  {a.weight > 0 && <Badge className="bg-emerald-50 text-[9px] font-black text-emerald-700 hover:bg-emerald-50">وزن {a.weight}%</Badge>}
                                </div>
                                <p className="mt-2 text-xs font-bold leading-6 text-slate-600">{a.description}</p>
                                {a.rubric && <p className="mt-2 rounded-xl bg-slate-50 p-2 text-[11px] font-bold leading-5 text-slate-500">معايير التصحيح: {a.rubric}</p>}
                                {a.dueAt && <p className="mt-1 text-[11px] font-bold text-amber-700">آخر موعد مقترح: {new Date(a.dueAt).toLocaleDateString('ar-EG')}</p>}
                              </div>
                              <span className={`rounded-full px-2.5 py-1 text-[10px] font-black ${graded ? 'bg-emerald-100 text-emerald-700' : needsRevision ? 'bg-amber-100 text-amber-700' : submitted ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                                {graded ? `مصحح ${submission?.score ?? '-'}/${a.points}` : needsRevision ? 'يحتاج تعديل' : submitted ? 'تم التسليم' : 'لم يسلّم بعد'}
                              </span>
                            </div>

                            {submission && (
                              <div className="mt-3 rounded-xl bg-[#f8fafc] p-3 text-[11px] font-bold leading-5 text-slate-600">
                                <p className="font-black text-[#0f2b46]">تسليمك الحالي</p>
                                {submission.answerText && <p className="mt-1 rounded-lg bg-white p-2 ring-1 ring-slate-100">{submission.answerText}</p>}
                                {submission.fileName && <p className="mt-1 text-[#a8841a]">ملف مرفق: {submission.fileName} {submission.size ? `(${Math.ceil(submission.size / 1024)} ك.ب)` : ''}</p>}
                                {(submission.fileUrl || submission.downloadUrl) && (
                                  <a className="mt-2 inline-flex rounded-lg border border-[#d6bb6e]/60 bg-white px-3 py-1.5 text-[11px] font-black text-[#0f2b46] hover:bg-[#fff7df]" href={submission.fileUrl || submission.downloadUrl || '#'} target="_blank" rel="noopener noreferrer">
                                    تحميل ملفي
                                  </a>
                                )}
                                {submission.feedback && <p className={`mt-1 ${needsRevision ? 'text-amber-700' : 'text-emerald-700'}`}>ملاحظة التصحيح: {submission.feedback}</p>}
                              </div>
                            )}

                            {!graded && (
                              <div className="mt-3 grid gap-2 md:grid-cols-[1fr_220px]">
                                <Textarea
                                  rows={3}
                                  value={assignmentDrafts[a.id] || ''}
                                  onChange={(e) => setAssignmentDrafts((prev) => ({ ...prev, [a.id]: e.target.value }))}
                                  placeholder={needsRevision ? 'أعد كتابة/تعديل إجابتك هنا...' : 'اكتب إجابتك أو ملخص واجبك هنا...'}
                                  className="text-xs"
                                />
                                <div className="space-y-2">
                                  <Input type="file" onChange={(e) => setAssignmentFiles((prev) => ({ ...prev, [a.id]: e.target.files?.[0] || null }))} className="text-xs" />
                                  {assignmentFiles[a.id] && <p className="text-[10px] font-bold text-slate-500">الملف المختار: {assignmentFiles[a.id]?.name}</p>}
                                  <Button onClick={() => submitAssignment(a.id)} disabled={submittingAssignmentId === a.id} className="w-full bg-[#0f2b46] text-xs font-black text-[#e0b83a] hover:bg-[#12365c]">
                                    {submittingAssignmentId === a.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="ml-1 h-3.5 w-3.5" />}
                                    {submission ? 'إعادة التسليم' : 'تسليم الواجب'}
                                  </Button>
                                </div>
                              </div>
                            )}
                          </article>
                        )
                      })}
                    </div>
                  </section>
                ) : (
                  <section className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-xs font-bold leading-6 text-slate-500">
                    لا توجد واجبات منشورة لهذا البرنامج بعد.
                  </section>
                )}
                  </TabsContent>

                  <TabsContent value="units" className="mt-0">
                {/* Units */}
                <div className="space-y-3">
                  {active.units.map((u) => (
                    <div
                      key={u.id}
                      className="flex flex-col gap-3 rounded-xl border border-slate-100 bg-white p-4 shadow-sm transition-colors hover:border-[#c9a227]/50 sm:flex-row sm:items-center"
                    >
                      <div
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-black ${
                          u.completed ? 'bg-emerald-100 text-emerald-700' : 'bg-[#0f2b46] text-[#e0b83a]'
                        }`}
                      >
                        {u.order}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-extrabold text-[#0f2b46]">{u.title}</h3>
                          {u.completed ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          ) : (
                            <CircleDashed className="h-4 w-4 text-slate-300" />
                          )}
                        </div>
                        <p className="mt-0.5 line-clamp-1 text-xs text-slate-500">{u.summary}</p>
                        {u.bestScore != null && (
                          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-black ${
                            u.examPassed ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                          }`}>
                            أفضل نتيجة: {u.bestScore}% {u.examPassed ? '— ناجح ✓' : `(النجاح ${u.examPassScore}%)`}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button size="sm" onClick={() => openUnit(u.id)} className="bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]">
                          <BookOpen className="ml-1 h-3.5 w-3.5" /> المحتوى
                        </Button>
                        {u.examId && (
                          <Button size="sm" variant="outline" onClick={() => openExam(u.examId!)} className="border-[#c9a227] font-bold text-[#a8841a] hover:bg-[#f7edd0]">
                            <ClipboardCheck className="ml-1 h-3.5 w-3.5" /> الاختبار
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                  </TabsContent>
                </Tabs>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {/* 12.2: امتحانا الفصلين من الكتب المقررة */}
          {active?.semesterExams && active.semesterExams.length > 0 && curriculumReady && (
            active.semesterExams.map((exam: any, idx: number) => {
              // بوابة التسلسل: امتحان الفصل الثاني يفتح بعد اجتياز الفصل الأول
              const sem1 = (active.semesterExams || []).find((e: any) => e.semester === 1)
              const readiness = exam.readiness
              const tuitionGate = exam.tuitionGate
              const tuitionLocked = Boolean(tuitionGate && !tuitionGate.allowed)
              const prereqLocked = exam.semester === 2 && sem1 && !sem1.passed
              const locked = prereqLocked || tuitionLocked || !readiness?.readyMarked
              return (
                <Card key={exam.id} className={`border-[#0f2b46]/15 bg-[#0f2b46] text-[#f5f0e1] ${locked ? 'opacity-80' : ''}`}>
                  <CardContent className="p-5 sm:p-6">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <BookMarked className="h-5 w-5 text-[#e0b83a]" />
                          <h2 className="text-base font-black">{exam.title}</h2>
                          {locked && (
                            <Badge className="bg-amber-500/20 text-[9px] font-black text-amber-300 hover:bg-amber-500/20">
                              {prereqLocked ? 'مقفل — اجتز امتحان الفصل الأول أولاً' : 'مقفل — اضغط جاهز للامتحان أولاً'}
                            </Badge>
                          )}
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-[#e0b83a]/90">
                          {exam.questionCount} سؤالاً متنوعاً · المدة {exam.durationMin} دقيقة (لا تقل عن ساعتين وفق اللوائح) · حد النجاح {exam.passScore}%
                          {active.booksCount ? ` · مبني على الكتب المقررة` : ''}
                        </p>
                        {exam.bestScore != null && (
                          <div className="mt-2.5 inline-flex items-center gap-2 rounded-lg bg-white/10 px-3 py-1.5 text-xs font-black">
                            {exam.passed ? '✓' : '⟳'} أفضل نتيجة: {exam.bestScore}%
                          </div>
                        )}
                        {readiness && (
                          <div className="mt-3 rounded-xl bg-white/10 p-3 text-[11px] font-bold leading-5 text-[#f5f0e1]">
                            <p>اختبارات الوحدات: {readiness.passedUnitExamsCount}/{readiness.unitExamsCount} · الواجبات: {readiness.passedAssignmentsCount}/{readiness.assignmentsCount}</p>
                            {readiness.missingAssignmentWeight > 0 ? <p className="mt-1 text-amber-200">تنبيه: عدم استكمال الواجبات/التقييمات سيجعل أعلى نتيجة ممكنة الآن {readiness.maxExamScore}% فقط.</p> : null}
                          </div>
                        )}
                        {tuitionLocked && tuitionGate?.message ? (
                          <div className="mt-3 rounded-xl bg-amber-100/15 p-3 text-[11px] font-extrabold leading-5 text-amber-100">
                            {tuitionGate.message}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 flex-col gap-2">
                        {!prereqLocked && !tuitionLocked && !readiness?.readyMarked ? (
                          <Button
                            onClick={() => markReadyForSemesterExam(exam.semester)}
                            className="bg-emerald-600 font-extrabold text-white hover:bg-emerald-700"
                          >
                            <CheckCircle2 className="ml-1 h-4 w-4" /> جاهز للامتحان
                          </Button>
                        ) : null}
                        <Button
                          onClick={() => handleSemesterExamAction(exam)}
                          disabled={locked}
                          className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a] disabled:opacity-50"
                        >
                          <Hourglass className="ml-1 h-4 w-4" />
                          {tuitionLocked ? 'مغلق لحين السداد' : exam.bestScore != null ? 'إعادة الامتحان' : 'ابدأ امتحان الفصل'}
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}

          {(active?.pendingReviewExams || 0) > 0 && (
            <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/50 p-4 text-xs font-bold leading-relaxed text-[#5c4d1a]">
              امتحان مولّد بالذكاء الاصطناعي لهذا التخصص يقرأه المشرف الذكي الآن — بانتظار مراجعة الإدارة واعتماد أسئلته قبل نشره لك. ستصلك إشعار عند نشره.
            </div>
          )}

          {/* Available programs */}
          {available.length > 0 && (
            <Card className="border-[#0f2b46]/10">
              <CardContent className="p-5">
                <h2 className="mb-4 text-base font-black text-[#0f2b46]">برامج متاحة للتسجيل</h2>
                <div className="grid gap-3 sm:grid-cols-2">
                  {available.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => openProgramDetails(p.id)}
                      className="flex items-center justify-between rounded-xl border border-slate-100 bg-white p-4 text-right shadow-sm transition-colors hover:border-[#c9a227]"
                    >
                      <div>
                        <div className="text-sm font-extrabold text-[#0f2b46]">{p.titleAr}</div>
                        <div className="text-[11px] text-slate-400">{p.unitsCount > 0 ? `${p.unitsCount} وحدات تدريبية` : 'اعتماد مباشر'}</div>
                      </div>
                      <ChevronLeft className="h-4 w-4 text-[#c9a227]" />
                    </button>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
            </TabsContent>

            <TabsContent value="supervision" className="mt-6">
              {dashboardTab === 'supervision' ? <StudentSupervisionTab /> : null}
            </TabsContent>

            <TabsContent value="lectures" className="mt-6">
              {dashboardTab === 'lectures' ? <StudentLectures /> : null}
            </TabsContent>

            <TabsContent value="payments" className="mt-6">
              {dashboardTab === 'payments' ? <PaymentsTab /> : null}
            </TabsContent>

            <TabsContent value="deliverables" className="mt-6">
              <Card className="border-[#0f2b46]/10 bg-white">
                <CardContent className="p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="flex items-center gap-2 text-base font-black text-[#0f2b46]"><Award className="h-5 w-5 text-[#c9a227]" /> مخرجاتي وخدماتي</h2>
                      <p className="mt-1 text-xs font-bold text-slate-500">هنا تظهر الشهادات، المعادلات، روابط تحميل الحقائب، تقارير الاستشارة أو أي مخرج تنشره الإدارة لطلبك.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">{serviceDeliverables.length} مخرج</Badge>
                      <Button size="sm" onClick={() => navigate('apply')} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">طلب خدمة/برنامج جديد</Button>
                    </div>
                  </div>
                  {serviceDeliverablesLoading ? (
                    <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-6 text-sm font-black text-slate-500">
                      <Loader2 className="h-4 w-4 animate-spin" /> جاري تحميل المخرجات...
                    </div>
                  ) : serviceDeliverables.length ? (
                    <div className="grid gap-3">
                      {serviceDeliverables.map((d) => (
                        <div key={d.id} className="rounded-2xl border border-[#0f2b46]/10 bg-slate-50 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <Badge className="mb-2 bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{d.typeLabel || d.type}</Badge>
                              <h3 className="text-sm font-black text-[#0f2b46]">{d.title}</h3>
                              <p className="mt-1 text-[11px] font-bold text-slate-400">الطلب: {d.application?.program || 'طلب خدمة'} — {d.application?.reference}</p>
                              {d.description && <p className="mt-2 text-xs font-bold leading-6 text-slate-600">{d.description}</p>}
                              {d.meetingAt && <p className="mt-1 text-[11px] font-bold text-[#a8841a]">موعد الجلسة: {new Date(d.meetingAt).toLocaleString('ar-EG')}</p>}
                              {d.certificateId && <p className="mt-1 text-[11px] font-bold text-emerald-700">رقم الشهادة/الاعتماد: {d.certificateId}</p>}
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                              <a href={d.downloadUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-lg bg-[#0f2b46] px-3 text-xs font-black text-white hover:bg-[#1b3a5d]">
                                <FileText className="ml-1 h-3.5 w-3.5" /> فتح/تحميل
                              </a>
                              <button type="button" onClick={() => openDashboardPdf(`/api/pdf/service-deliverables/${encodeURIComponent(d.id)}`, `AACT-DELIVERABLE-${d.id}.pdf`)} className="inline-flex h-9 items-center rounded-lg border border-[#c9a227] bg-white px-3 text-xs font-black text-[#a8841a] hover:bg-[#f7edd0]">
                                <ScrollText className="ml-1 h-3.5 w-3.5" /> PDF
                              </button>
                              {d.verificationUrl && (
                                <a href={d.verificationUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center rounded-lg border border-[#c9a227] px-3 text-xs font-black text-[#a8841a] hover:bg-[#f7edd0]">
                                  تحقق
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm font-bold leading-7 text-slate-500">
                      <p>لا توجد مخرجات منشورة بعد. عندما تعتمد الإدارة شهادة أو معادلة أو رابط حقيبة أو تقرير استشارة سيظهر هنا مباشرة.</p>
                      <Button size="sm" onClick={() => navigate('apply')} className="mt-4 bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">تقديم طلب جديد</Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="notifications" className="mt-6">
              <Card className="border-[#0f2b46]/10 bg-white">
                <CardContent className="p-5">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                    <h2 className="flex items-center gap-2 text-base font-black text-[#0f2b46]"><Bell className="h-5 w-5 text-[#c9a227]" /> إشعاراتي داخل المنصة</h2>
                    <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">{studentSummary?.unread || 0} غير مقروء</Badge>
                  </div>
                  <div className="space-y-3">
                    {studentSummary?.notifications?.length ? studentSummary.notifications.map((n) => (
                      <div key={n.id} className={`rounded-2xl border p-4 ${n.read ? 'border-slate-100 bg-slate-50' : 'border-[#c9a227]/40 bg-[#fffaf0]'}`}>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div>
                            <p className="text-sm font-black text-[#0f2b46]">{n.title}</p>
                            <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{n.body}</p>
                            <p className="mt-1 text-[11px] font-bold text-slate-400">{new Date(n.createdAt).toLocaleString('ar-EG')}</p>
                          </div>
                          {!n.read ? <Badge className="bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">جديد</Badge> : null}
                        </div>
                      </div>
                    )) : <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">لا توجد إشعارات بعد.</div>}
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="thesis" className="mt-6">
              {dashboardTab === 'thesis' ? <ThesisTab /> : null}
            </TabsContent>

            <TabsContent value="transcript" className="mt-6">
              {dashboardTab === 'transcript' ? <TranscriptTab /> : null}
            </TabsContent>

            <TabsContent value="certs" className="mt-6">
              {dashboardTab === 'certs' ? <CertificatesTab /> : null}
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          {!hasProgramDashboard ? (
            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5">
                <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Award className="h-5 w-5 text-[#c9a227]" /> {hasStudyIdentity ? 'بوابة المتقدم للدراسة' : 'بوابة خدماتك'}</h2>
                <p className="mt-2 text-xs font-bold leading-6 text-slate-600">
                  {hasStudyIdentity
                    ? 'هذا حساب متقدم لبرنامج دراسي. تبقى الدفعات والإشعارات ظاهرة هنا إلى أن تعتمد الإدارة الطلب وتفعّل التسجيل الدراسي، ثم تظهر تبويبات الكتب والاختبارات والسجل الأكاديمي.'
                    : 'أنت حالياً في مسار خدمة عابرة، لذلك لا تظهر لك تبويبات البرامج، بحث التخرج أو السجل الأكاديمي. تابع الدفع والمخرجات والإشعارات فقط.'}
                </p>
                <div className="mt-3 grid gap-2 text-[11px] font-bold text-slate-600">
                  <div className="rounded-xl bg-slate-50 p-3">الدفعات المعلقة: <b className="text-[#0f2b46]">{studentSummary?.summary.unpaidPayments || 0}</b></div>
                  <div className="rounded-xl bg-slate-50 p-3">طلبات الدراسة: <b className="text-[#0f2b46]">{studentSummary?.summary.studyRequests || 0}</b></div>
                  {!hasStudyIdentity && <div className="rounded-xl bg-slate-50 p-3">المخرجات المتاحة: <b className="text-[#0f2b46]">{serviceDeliverables.length}</b></div>}
                </div>
                <Button size="sm" onClick={() => setDashboardTab('payments')} className="mt-3 w-full bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]">فتح الدفعات</Button>
                {!hasStudyIdentity && <Button size="sm" variant="outline" onClick={() => setDashboardTab('deliverables')} className="mt-2 w-full border-[#c9a227] font-black text-[#a8841a] hover:bg-[#f7edd0]">فتح المخرجات</Button>}
                <Button size="sm" variant="outline" onClick={() => navigate('apply')} className="mt-2 w-full border-[#0f2b46]/20 font-black text-[#0f2b46] hover:bg-slate-50">تقديم خدمة أو برنامج جديد</Button>
              </CardContent>
            </Card>
          ) : (
          <>
          {/* Academic memory */}
          <Card className="border-[#0f2b46]/10 bg-white">
            <CardContent className="p-5">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <Bot className="h-5 w-5 text-[#c9a227]" /> ملف المشرف الأكاديمي
                  </h2>
                  <p className="mt-1 text-[11px] font-bold text-slate-400">ذاكرة تعليمية مبنية من محادثاتك وامتحاناتك ومناقشتك</p>
                </div>
                <Badge className="bg-[#f7edd0] text-[10px] font-black text-[#a8841a] hover:bg-[#f7edd0]">
                  {academicMemory?.interactionsCount || 0} تفاعل
                </Badge>
              </div>

              <div className="rounded-2xl bg-[#f8fafc] p-3 text-xs font-bold leading-6 text-slate-600">
                {academicMemory?.profileDigest || academicMemory?.lastConversationSummary || 'لم تتكوّن ذاكرة كافية بعد. ابدأ محادثة مع المشرف أو اجتز أول امتحان ليبني النظام ملفك الأكاديمي.'}
              </div>

              {academicNextAction && (
                <div className="mt-3 rounded-2xl border border-[#c9a227]/35 bg-[#fffaf0] p-3">
                  <p className="text-[11px] font-black text-[#a8841a]">الخطوة التعليمية التالية</p>
                  <p className="mt-1 text-xs font-bold leading-6 text-[#0f2b46]">{academicNextAction}</p>
                </div>
              )}

              {(academicMemory?.conceptsToReview?.length || 0) > 0 && (
                <div className="mt-3">
                  <p className="mb-1.5 text-[11px] font-black text-[#0f2b46]">مفاهيم يراجعها معك المشرف</p>
                  <div className="flex flex-wrap gap-1.5">
                    {academicMemory!.conceptsToReview.slice(-6).map((item, i) => (
                      <span key={`${item}-${i}`} className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-600">{item}</span>
                    ))}
                  </div>
                </div>
              )}

              {((academicMemory?.strengths?.length || 0) > 0 || (academicMemory?.weaknesses?.length || 0) > 0) && (
                <div className="mt-3 grid gap-2">
                  {(academicMemory?.strengths?.length || 0) > 0 && (
                    <div className="rounded-xl bg-emerald-50 p-2 text-[11px] font-bold leading-5 text-emerald-700">
                      <p className="mb-1 font-black">نقاط قوة مرصودة</p>
                      {academicMemory!.strengths.slice(-3).map((item, i) => <p key={`${item}-${i}`}>• {item}</p>)}
                    </div>
                  )}
                  {(academicMemory?.weaknesses?.length || 0) > 0 && (
                    <div className="rounded-xl bg-amber-50 p-2 text-[11px] font-bold leading-5 text-amber-700">
                      <p className="mb-1 font-black">تحتاج متابعة</p>
                      {academicMemory!.weaknesses.slice(-3).map((item, i) => <p key={`${item}-${i}`}>• {item}</p>)}
                    </div>
                  )}
                </div>
              )}

              <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] font-black text-slate-500">
                <div className="rounded-xl bg-slate-50 p-2">آخر امتحان: {formatMemoryDate(academicMemory?.lastExamAt)}</div>
                <div className="rounded-xl bg-slate-50 p-2">آخر تحديث: {formatMemoryDate(memoryUpdatedAt)}</div>
              </div>
            </CardContent>
          </Card>

          {/* Micro credentials */}
          <Card className="border-[#0f2b46]/10 bg-white">
            <CardContent className="p-5">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <Award className="h-5 w-5 text-[#c9a227]" /> شهادات المهارات الصغيرة
                  </h2>
                  <p className="mt-1 text-[11px] font-bold text-slate-400">وحدات مهارية تتجمع داخل برنامجك الأكاديمي</p>
                </div>
                <Badge className="bg-emerald-100 text-[10px] font-black text-emerald-700 hover:bg-emerald-100">
                  {earnedMicroCredentials.length} مكتسبة
                </Badge>
              </div>

              {earnedMicroCredentials.length > 0 ? (
                <div className="space-y-2">
                  {earnedMicroCredentials.slice(0, 3).map((mc) => (
                    <div key={mc.id} className="rounded-2xl border border-emerald-100 bg-emerald-50/60 p-3">
                      <p className="text-xs font-black leading-5 text-[#0f2b46]">{mc.titleAr}</p>
                      <p className="mt-1 text-[10px] font-bold leading-4 text-emerald-700">{mc.learningOutcome}</p>
                      <p className="mt-1 font-mono text-[9px] font-bold text-slate-400" dir="ltr">{mc.badgeCode}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-2xl bg-[#f8fafc] p-3 text-xs font-bold leading-6 text-slate-600">
                  لم تُمنح لك شهادة مهارة صغيرة بعد. اجتز امتحاناً موثقاً وقدم واجباً/مشروعاً تطبيقياً لتبدأ الشارات بالظهور هنا.
                </div>
              )}

              {availableMicroCredentials.length > 0 && (
                <div className="mt-3 rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-3">
                  <p className="text-[11px] font-black text-[#a8841a]">متاحة عند الاستحقاق</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {availableMicroCredentials.slice(0, 4).map((mc) => (
                      <span key={mc.credentialId} className="rounded-full bg-white px-2 py-1 text-[10px] font-black text-[#0f2b46]">{microSkillLabel(mc.skillArea)}</span>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* AI chat latest */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <Bot className="h-5 w-5 text-[#c9a227]" /> آخر رسائل المشرف الذكي
              </h2>
              {lastChats.length === 0 ? (
                <div className="rounded-xl bg-[#f7edd0]/50 p-4 text-center">
                  <p className="text-xs leading-relaxed text-slate-600">
                    {aiSupervisorAllowed ? 'لم تبدأ محادثتك مع المشرف الذكي بعد. اسأله أي سؤال عن دوراتك — صوتاً أو كتابة!' : aiSupervisorBlockedReason}
                  </p>
                  <Button size="sm" className={aiSupervisorAllowed ? 'mt-3 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]' : 'mt-3 border-slate-200 bg-slate-100 font-extrabold text-slate-500 hover:bg-slate-100'} onClick={openAiSupervisor}>
                    {aiSupervisorAllowed ? 'ابدأ المحادثة' : 'غير مفعل بعد'}
                  </Button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {lastChats.map((m) => (
                    <div
                      key={m.id}
                      className={`rounded-xl px-3.5 py-2.5 text-xs leading-relaxed ${
                        m.role === 'user'
                          ? 'mr-8 bg-[#0f2b46] text-white'
                          : 'ml-8 bg-[#f7edd0] text-[#0f2b46]'
                      }`}
                    >
                      <span className="line-clamp-3">{m.content}</span>
                    </div>
                  ))}
                  <Button size="sm" variant="outline" className="w-full border-[#0f2b46]/20 text-[#0f2b46]" onClick={openAiSupervisor}>
                    {aiSupervisorAllowed ? 'متابعة المحادثة' : 'المشرف الذكي غير مفعل'}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Certificate info */}
          <Card className="border-[#c9a227]/40 bg-[#f7edd0]/40">
            <CardContent className="p-5">
              <h2 className="mb-2 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <Award className="h-5 w-5 text-[#a8841a]" /> معلومات الشهادة
              </h2>
              <ul className="space-y-2 text-xs leading-relaxed text-slate-600">
                <li>• أكمل جميع الوحدات واجتز اختباراتها بنسبة 60% فأعلى</li>
                <li>• تُصدر الشهادة المعتمدة خلال 30 يوماً من استلام كشوف الدرجات والرسوم</li>
                <li>• شهادتك صادرة عن الأكاديمية الأمريكية للاستشارات والتدريب</li>
                <li>• يمكن ترشيحك للاعتماد كاستشاري في مجال عملك بعد التخرج</li>
              </ul>
            </CardContent>
          </Card>
          </>
          )}
        </div>
      </div>
    </div>
  )
}
