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

interface ExamQuestionImportItem {
  id: string
  order: number
  type: string
  text: string
  options?: string | null
  correctAnswer?: string | null
  modelAnswer?: string | null
  difficulty?: string | null
  status?: string | null
}

interface ExamImportItem {
  id: string
  title: string
  status: string
  semester: number
  createdAt: string
  questions: ExamQuestionImportItem[]
}

interface StorageSafetyReport {
  generatedAt: string
  mode: string
  deletionEnabled: boolean
  storageConfig: {
    s3Configured: boolean
    bucket: string | null
    publicBaseUrlConfigured: boolean
    note: string
  }
  summary: {
    booksTotal: number
    linkedR2Objects: number
    linkedLocalObjects: number
    externalLinks: number
    legacyBase64Books: number
    linkedStorageBytes: number
    linkedR2Bytes: number
    legacyBase64Bytes: number
    uploadChunks: number
    uploadChunkBytes: number
    heavyDbFileRows: number
    heavyDbFileBytes: number
    heavyDbFileHighRisk: number
    heavyDbFileWarnings: number
    externallyStoredAssignments: number
    externallyStoredAssignmentBytes: number
    externallyStoredDefenseRecordings: number
    externallyStoredDefenseRecordingBytes: number
    suspiciousBooks: number
    orphanUploadChunks: number
    questionBankBookRefsMissing: number
    questionBankUnitRefsMissing: number
    examDraftsTotal: number
    orphanExamDrafts: number
    reviewExams: number
  }
  recommendations: string[]
  samples: {
    suspiciousBooks: { id: string; title: string; program?: string | null; fileName?: string | null; size?: number | null; storageProvider?: string | null; storageKey?: string | null; fileUrl?: string | null; hasLegacyData: boolean; hasLink: boolean }[]
    orphanDrafts: { id: string; examId: string; examType: string; updatedAt: string }[]
    reviewExams: { id: string; title: string; questions: number; createdAt: string }[]
    externallyStoredAssignments: { id: string; fileName?: string | null; size?: number | null; storageProvider?: string | null; storageKey?: string | null; fileUrl?: string | null; submittedAt: string }[]
    externallyStoredDefenseRecordings: { id: string; recordingMime?: string | null; recordingSize?: number | null; storageProvider?: string | null; storageKey?: string | null; recordingUrl?: string | null; updatedAt: string }[]
    heavyDbFiles: { key: string; label: string; table: string; column: string; rows: number; chars: number; approxBytes: number; status: 'SAFE' | 'WATCH' | 'WARNING' | 'HIGH_RISK'; note: string }[]
  }
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
  const [storageReport, setStorageReport] = useState<StorageSafetyReport | null>(null)
  const [storageReportLoading, setStorageReportLoading] = useState(false)
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null)
  const [catalogImportOpen, setCatalogImportOpen] = useState(false)
  const [catalogImportText, setCatalogImportText] = useState('')
  const [thesisTopicDialogOpen, setThesisTopicDialogOpen] = useState(false)
  const [thesisTopicMode, setThesisTopicMode] = useState<'manual' | 'generate'>('manual')
  const [thesisProgramId, setThesisProgramId] = useState('')
  const [thesisTopicTitle, setThesisTopicTitle] = useState('')
  const [thesisTopicDescription, setThesisTopicDescription] = useState('')
  const [thesisGenerateCount, setThesisGenerateCount] = useState(6)
  const [thesisTopicBusy, setThesisTopicBusy] = useState(false)
  const [thesisTopicList, setThesisTopicList] = useState<any[]>([])
  const [thesisTopicRequests, setThesisTopicRequests] = useState<any[]>([])
  const [thesisTopicLoading, setThesisTopicLoading] = useState(false)
  const [studentsOpen, setStudentsOpen] = useState(false)
  const [students, setStudents] = useState<any[]>([])
  const [selectedStudent, setSelectedStudent] = useState<any | null>(null)
  const [studentSearch, setStudentSearch] = useState('')
  const [studentStatus, setStudentStatus] = useState('ALL')
  const [studentsLoading, setStudentsLoading] = useState(false)
  const [studentBusyId, setStudentBusyId] = useState<string | null>(null)
  const [studentPreviewOpen, setStudentPreviewOpen] = useState(false)
  const [studentPreviewPrograms, setStudentPreviewPrograms] = useState<any[]>([])
  const [studentPreviewProgramId, setStudentPreviewProgramId] = useState('')
  const [studentPreview, setStudentPreview] = useState<any | null>(null)
  const [studentPreviewLoading, setStudentPreviewLoading] = useState(false)
  const [mailStatusOpen, setMailStatusOpen] = useState(false)
  const [mailStatus, setMailStatus] = useState<any | null>(null)
  const [mailStatusLoading, setMailStatusLoading] = useState(false)
  const [mailTestEmail, setMailTestEmail] = useState('')
  const [mailTestSending, setMailTestSending] = useState(false)
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
  const [manualQuestionOpen, setManualQuestionOpen] = useState(false)
  const [importQuestionsOpen, setImportQuestionsOpen] = useState(false)
  const [manualQuestion, setManualQuestion] = useState({
    type: 'MCQ', text: '', options: 'خيار أول\nخيار ثان\nخيار ثالث\nخيار رابع', correctAnswer: '0', modelAnswer: '', difficulty: 'MEDIUM', sourceEvidence: '', approveNow: false,
  })
  const [importText, setImportText] = useState('')
  const [importApproveNow, setImportApproveNow] = useState(false)
  const [examImportOpen, setExamImportOpen] = useState(false)
  const [examImportItems, setExamImportItems] = useState<ExamImportItem[]>([])
  const [selectedExamId, setSelectedExamId] = useState('')
  const [selectedExamQuestionIds, setSelectedExamQuestionIds] = useState<string[]>([])
  const [examImportApproveNow, setExamImportApproveNow] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [res, reviews, readiness, storage] = await Promise.all([
        api<AcademicQualityData>('/api/admin/academic-quality'),
        api<{ items: ChatReviewItem[] }>('/api/chat-feedback').catch(() => ({ items: [] })),
        api<{ items: ProgramReadinessItem[] }>('/api/admin/program-readiness').catch(() => ({ items: [] })),
        api<StorageSafetyReport>('/api/admin/storage-safety').catch(() => null),
      ])
      setData(res)
      setReviewItems(reviews.items || [])
      setReadinessItems(readiness.items || [])
      setStorageReport(storage)
    } catch (e: any) {
      setError(e?.message || 'تعذر تحميل مركز الجودة الأكاديمي')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshStorageReport = async () => {
    setStorageReportLoading(true)
    try {
      const report = await api<StorageSafetyReport>('/api/admin/storage-safety')
      setStorageReport(report)
    } finally {
      setStorageReportLoading(false)
    }
  }

  const exportProgramCatalog = async () => {
    setCatalogBusy('export')
    try {
      const catalog = await api<any>('/api/admin/program-catalog')
      const blob = new Blob([JSON.stringify(catalog, null, 2)], { type: 'application/json;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `aact-program-catalog-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      alert(e?.message || 'تعذر تصدير كتالوج البرامج')
    } finally {
      setCatalogBusy(null)
    }
  }

  const importProgramCatalog = async () => {
    if (!catalogImportText.trim()) return
    if (!confirm('سيتم استيراد كتالوج البرامج إلى قاعدة البيانات الحالية. الطلاب والمدفوعات والمحاولات ليست ضمن هذا الملف. هل تريد المتابعة؟')) return
    setCatalogBusy('import')
    try {
      const catalog = JSON.parse(catalogImportText)
      const res = await api<{ stats: Record<string, number> }>('/api/admin/program-catalog', {
        method: 'POST',
        body: JSON.stringify({ catalog, confirmRestore: 'YES' }),
      })
      alert(`تم الاستيراد بنجاح. البرامج: ${res.stats.programs || 0}، الوحدات: ${res.stats.units || 0}، الكتب: ${res.stats.books || 0}`)
      setCatalogImportOpen(false)
      setCatalogImportText('')
      await load()
    } catch (e: any) {
      alert(e?.message || 'تعذر استيراد كتالوج البرامج')
    } finally {
      setCatalogBusy(null)
    }
  }

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

  const addManualQuestion = async () => {
    if (!questionBankProgram) return
    setQuestionBankBusyId('manual')
    try {
      const res = await api<{ items: QuestionBankReviewItem[]; stats: QuestionBankStats }>('/api/admin/question-bank', {
        method: 'POST',
        body: JSON.stringify({
          programId: questionBankProgram.id,
          source: 'MANUAL',
          approveNow: manualQuestion.approveNow,
          question: {
            type: manualQuestion.type,
            text: manualQuestion.text,
            options: manualQuestion.options.split('\n').map((x) => x.trim()).filter(Boolean),
            correctAnswer: manualQuestion.correctAnswer,
            modelAnswer: manualQuestion.modelAnswer,
            difficulty: manualQuestion.difficulty,
            sourceEvidence: manualQuestion.sourceEvidence,
          },
        }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
      setManualQuestionOpen(false)
      setManualQuestion((prev) => ({ ...prev, text: '', modelAnswer: '', sourceEvidence: '' }))
    } finally {
      setQuestionBankBusyId(null)
    }
  }

  const importQuestions = async () => {
    if (!questionBankProgram) return
    setQuestionBankBusyId('import')
    try {
      const res = await api<{ items: QuestionBankReviewItem[]; stats: QuestionBankStats }>('/api/admin/question-bank', {
        method: 'POST',
        body: JSON.stringify({
          programId: questionBankProgram.id,
          source: 'IMPORT',
          text: importText,
          approveNow: importApproveNow,
        }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
      setImportQuestionsOpen(false)
      setImportText('')
    } finally {
      setQuestionBankBusyId(null)
    }
  }

  const openExamImport = async () => {
    if (!questionBankProgram) return
    setExamImportOpen(true)
    setQuestionBankBusyId('exam-load')
    try {
      const res = await api<{ exams: ExamImportItem[] }>(`/api/admin/question-bank/from-exam?programId=${questionBankProgram.id}`)
      setExamImportItems(res.exams || [])
      const first = (res.exams || []).find((exam) => exam.questions?.length)
      setSelectedExamId(first?.id || '')
      setSelectedExamQuestionIds(first?.questions?.map((q) => q.id) || [])
    } finally {
      setQuestionBankBusyId(null)
    }
  }

  const selectedExam = examImportItems.find((exam) => exam.id === selectedExamId) || null

  const copyExamQuestionsToBank = async () => {
    if (!questionBankProgram || !selectedExamId || selectedExamQuestionIds.length === 0) return
    setQuestionBankBusyId('exam-copy')
    try {
      const res = await api<{ items: QuestionBankReviewItem[]; stats: QuestionBankStats }>('/api/admin/question-bank/from-exam', {
        method: 'POST',
        body: JSON.stringify({
          programId: questionBankProgram.id,
          examId: selectedExamId,
          questionIds: selectedExamQuestionIds,
          approveNow: examImportApproveNow,
        }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
      setExamImportOpen(false)
    } finally {
      setQuestionBankBusyId(null)
    }
  }

  const generateExamFromQuestionBank = async (program: ProgramReadinessItem, semester: number) => {
    const rawCount = window.prompt('كم عدد الأسئلة المطلوب في الامتحان؟', '30')
    if (rawCount === null) return
    const count = Math.max(5, Math.min(80, Number(rawCount || 30)))
    const easy = Number(window.prompt('نسبة/وزن الأسئلة السهلة؟', '25') || 25)
    const medium = Number(window.prompt('نسبة/وزن الأسئلة المتوسطة؟', '50') || 50)
    const advanced = Number(window.prompt('نسبة/وزن الأسئلة المتقدمة؟', '25') || 25)
    const mcq = Number(window.prompt('نسبة/وزن أسئلة الاختيار المتعدد؟', '50') || 50)
    const tf = Number(window.prompt('نسبة/وزن أسئلة الصح والخطأ؟', '20') || 20)
    const short = Number(window.prompt('نسبة/وزن الأسئلة القصيرة؟', '20') || 20)
    const essay = Number(window.prompt('نسبة/وزن الأسئلة المقالية؟', '10') || 10)
    let unitId: string | null = null
    if (confirm('هل تريد تقييد الامتحان بوحدة محددة؟')) {
      try {
        const res = await api<{ units: { id: string; title: string }[] }>(`/api/admin/program-units?programId=${program.id}`)
        const units = res.units || []
        if (units.length > 0) {
          const choice = window.prompt(`اختر رقم الوحدة:\n${units.map((u, i) => `${i + 1}. ${u.title}`).join('\n')}`, '1')
          unitId = units[Number(choice || 0) - 1]?.id || null
        }
      } catch {}
    }
    const payloadBase = { programId: program.id, semester, count, unitId, difficultyPlan: { EASY: easy, MEDIUM: medium, ADVANCED: advanced }, typePlan: { MCQ: mcq, TF: tf, SHORT: short, ESSAY: essay } }
    const doGenerate = async (replaceExistingReview = false) => api('/api/admin/program-exams/from-question-bank', {
      method: 'POST',
      body: JSON.stringify({ ...payloadBase, replaceExistingReview }),
    })

    setReadinessBusyId(program.id)
    try {
      try {
        await doGenerate(false)
      } catch (e: any) {
        if (String(e?.message || '').includes('بانتظار المراجعة') && confirm('يوجد امتحان بانتظار المراجعة لهذا الفصل. هل تريد استبداله بامتحان جديد من بنك الأسئلة؟')) {
          await doGenerate(true)
        } else {
          throw e
        }
      }
      window.dispatchEvent(new CustomEvent('aact-admin-tab', { detail: { tab: 'books', programId: program.id, section: 'exams' } }))
    } finally {
      setReadinessBusyId(null)
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

  const thesisProgramOptions = data.programs.map((p: any) => ({ id: p.id, titleAr: p.titleAr, category: p.category }))

  const loadStudents = async (q = studentSearch, status = studentStatus) => {
    setStudentsLoading(true)
    try {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      if (status !== 'ALL') params.set('status', status)
      const res = await api<{ students: any[] }>(`/api/admin/students?${params.toString()}`)
      setStudents(res.students || [])
    } catch (e: any) {
      alert(e?.message || 'تعذر تحميل الطلاب')
    } finally {
      setStudentsLoading(false)
    }
  }

  const loadStudentDetails = async (studentId: string) => {
    setStudentBusyId(studentId)
    try {
      const res = await api<{ student: any }>(`/api/admin/students?userId=${encodeURIComponent(studentId)}`)
      setSelectedStudent(res.student)
    } catch (e: any) {
      alert(e?.message || 'تعذر تحميل تفاصيل الطالب')
    } finally {
      setStudentBusyId(null)
    }
  }

  const updateStudentAction = async (studentId: string, action: string, payload: any = {}) => {
    setStudentBusyId(studentId)
    try {
      await api('/api/admin/students', { method: 'PATCH', body: JSON.stringify({ userId: studentId, action, ...payload }) })
      await loadStudents()
      if (selectedStudent?.id === studentId) await loadStudentDetails(studentId)
    } catch (e: any) {
      alert(e?.message || 'تعذر تنفيذ الإجراء')
    } finally {
      setStudentBusyId(null)
    }
  }

  const openStudentsManager = () => {
    setStudentsOpen(true)
    void loadStudents()
  }

  const loadStudentPreview = async (programId = studentPreviewProgramId) => {
    setStudentPreviewLoading(true)
    try {
      const url = programId ? `/api/admin/student-preview?programId=${encodeURIComponent(programId)}` : '/api/admin/student-preview'
      const res = await api<{ programs: any[]; preview: any | null }>(url)
      setStudentPreviewPrograms(res.programs || [])
      setStudentPreview(res.preview || null)
      const selectedId = res.preview?.program?.id || programId || res.programs?.[0]?.id || ''
      setStudentPreviewProgramId(selectedId)
    } catch (e: any) {
      alert(e?.message || 'تعذر تحميل معاينة الطالب')
    } finally {
      setStudentPreviewLoading(false)
    }
  }

  const openStudentPreview = () => {
    setStudentPreviewOpen(true)
    void loadStudentPreview()
  }

  const loadMailStatus = async () => {
    setMailStatusLoading(true)
    try {
      const res = await api<any>('/api/admin/mail-status')
      setMailStatus(res)
    } catch (e: any) {
      alert(e?.message || 'تعذر تحميل حالة البريد')
    } finally {
      setMailStatusLoading(false)
    }
  }

  const openMailStatus = () => {
    setMailStatusOpen(true)
    void loadMailStatus()
  }

  const sendMailTest = async () => {
    const to = mailTestEmail.trim()
    if (!to || !to.includes('@')) return alert('اكتب بريدًا صحيحًا لإرسال رسالة الاختبار')
    setMailTestSending(true)
    try {
      const res = await api<{ ok: boolean; to: string }>('/api/admin/mail-status', {
        method: 'POST',
        body: JSON.stringify({ to }),
      })
      alert(res.ok ? `تم إرسال رسالة اختبار إلى ${res.to}` : 'تمت محاولة الإرسال، راجع حالة البريد والسجل')
      await loadMailStatus()
    } catch (e: any) {
      alert(e?.message || 'تعذر إرسال رسالة الاختبار')
    } finally {
      setMailTestSending(false)
    }
  }

  const loadThesisTopics = async (programId = thesisProgramId) => {
    if (!programId) return
    setThesisTopicLoading(true)
    try {
      const res = await api<{ topics: any[]; requests: any[] }>(`/api/admin/thesis-topics?programId=${encodeURIComponent(programId)}`)
      setThesisTopicList(res.topics || [])
      setThesisTopicRequests(res.requests || [])
    } catch {
      setThesisTopicList([])
      setThesisTopicRequests([])
    } finally {
      setThesisTopicLoading(false)
    }
  }

  const updateThesisTopicStatus = async (id: string, status: string) => {
    setThesisTopicBusy(true)
    try {
      await api('/api/admin/thesis-topics', {
        method: 'PATCH',
        body: JSON.stringify({ id, status }),
      })
      await loadThesisTopics()
    } catch (e: any) {
      alert(e?.message || 'تعذر تحديث حالة العنوان')
    } finally {
      setThesisTopicBusy(false)
    }
  }

  const updateThesisTopicRequestStatus = async (requestId: string, status: string) => {
    const adminNote = status === 'NEEDS_REVISION' || status === 'REJECTED' ? window.prompt('اكتب ملاحظة للطالب', '') || '' : ''
    setThesisTopicBusy(true)
    try {
      await api('/api/admin/thesis-topics', {
        method: 'PATCH',
        body: JSON.stringify({ requestId, status, adminNote }),
      })
      await loadThesisTopics()
    } catch (e: any) {
      alert(e?.message || 'تعذر تحديث طلب الطالب')
    } finally {
      setThesisTopicBusy(false)
    }
  }

  const openThesisTopicDialog = (mode: 'manual' | 'generate') => {
    const selectedProgramId = thesisProgramId || thesisProgramOptions[0]?.id || ''
    setThesisTopicMode(mode)
    setThesisProgramId(selectedProgramId)
    setThesisTopicTitle('')
    setThesisTopicDescription('')
    setThesisGenerateCount(6)
    setThesisTopicDialogOpen(true)
    if (selectedProgramId) void loadThesisTopics(selectedProgramId)
  }

  const submitThesisTopicAction = async () => {
    if (!thesisProgramId) return alert('اختر البرنامج أولًا')
    setThesisTopicBusy(true)
    try {
      if (thesisTopicMode === 'generate') {
        const res = await api<{ created: any[] }>('/api/admin/thesis-topics', {
          method: 'POST',
          body: JSON.stringify({ action: 'generate', programId: thesisProgramId, count: thesisGenerateCount }),
        })
        setThesisTopicList(res.created || [])
        alert(`تم توليد ${res.created?.length || 0} مقترح عنوان. راجعها أسفل النافذة واعتمد المناسب قبل ظهورها للطلاب.`)
      } else {
        if (!thesisTopicTitle.trim()) return alert('اكتب عنوان البحث')
        await api('/api/admin/thesis-topics', {
          method: 'POST',
          body: JSON.stringify({ action: 'create', programId: thesisProgramId, title: thesisTopicTitle, description: thesisTopicDescription, status: 'APPROVED' }),
        })
        alert('تمت إضافة عنوان بحث التخرج واعتماده للطلاب.')
        await loadThesisTopics(thesisProgramId)
        setThesisTopicDialogOpen(false)
      }
    } catch (e: any) {
      alert(e?.message || 'تعذر تنفيذ العملية')
    } finally {
      setThesisTopicBusy(false)
    }
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
        <div className="flex flex-wrap gap-2">
          <Button onClick={openStudentsManager} variant="outline" className="border-[#0f2b46] font-black text-[#0f2b46] hover:bg-slate-50">
            إدارة الطلاب
          </Button>
          <Button onClick={openStudentPreview} variant="outline" className="border-emerald-300 font-black text-emerald-700 hover:bg-emerald-50">
            معاينة تجربة الطالب
          </Button>
          <Button onClick={openMailStatus} variant="outline" className="border-sky-300 font-black text-sky-700 hover:bg-sky-50">
            حالة البريد
          </Button>
          <Button onClick={load} variant="outline" className="border-[#c9a227] font-black text-[#a8841a] hover:bg-[#f7edd0]">
            <RefreshCw className="ml-1.5 h-4 w-4" /> تحديث المؤشرات
          </Button>
        </div>
      </div>

      <Card className="border-[#c9a227]/30 bg-[#fffaf0]">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-[#0f2b46]">إدارة عناوين بحث التخرج</h3>
              <p className="mt-1 text-[11px] font-bold leading-6 text-slate-600">
                أضف عناوين يدوية أو ولّد مقترحات بالذكاء حسب البرنامج والكتب والوحدات. الطالب يختار أو يقترح، والاعتماد يبقى للإدارة/المشرف.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => openThesisTopicDialog('manual')} className="bg-white text-xs font-black">إضافة عنوان يدوي</Button>
              <Button size="sm" onClick={() => openThesisTopicDialog('generate')} className="bg-[#0f2b46] text-xs font-black text-[#f5f0e1] hover:bg-[#183c5f]">توليد عناوين بالذكاء</Button>
            </div>
          </div>
        </CardContent>
      </Card>

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

      <Card className="border-[#c9a227]/30 bg-[#fffaf0]">
        <CardContent className="p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-[#0f2b46]">حفظ كتالوج البرامج قبل تنظيف قاعدة البيانات</h3>
              <p className="mt-1 text-[11px] font-bold leading-6 text-slate-600">
                هذه الأداة تحفظ تفاصيل البرامج والوحدات والكتب وبنك المعرفة وبنك الأسئلة والاختبارات، ولا تحفظ الطلاب أو الطلبات أو المدفوعات.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={catalogBusy === 'export'} onClick={exportProgramCatalog} className="bg-white text-xs font-black">
                {catalogBusy === 'export' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                تنزيل نسخة البرامج
              </Button>
              <Button size="sm" variant="outline" disabled={catalogBusy === 'import'} onClick={() => setCatalogImportOpen(true)} className="bg-white text-xs font-black">
                استيراد نسخة محفوظة
              </Button>
            </div>
          </div>
          <div className="mt-3 rounded-xl bg-white/80 p-3 text-[11px] font-bold leading-6 text-[#8a6d16]">
            استخدم زر التنزيل قبل تفريغ Neon. بعد التفريغ وإنشاء القاعدة النظيفة، تستطيع استيراد نفس الملف لإرجاع تفاصيل البرامج فقط.
          </div>
        </CardContent>
      </Card>

      <Card className="border-blue-100 bg-blue-50/40">
        <CardContent className="p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-black text-[#0f2b46]">تقرير سلامة التخزين</h3>
              <p className="mt-1 text-[11px] font-bold text-slate-500">مراقبة فقط: لا يحذف أي ملف ولا يمس الكتب أو بيانات الطلاب.</p>
            </div>
            <Button size="sm" variant="outline" disabled={storageReportLoading} onClick={refreshStorageReport} className="bg-white text-xs font-black">
              {storageReportLoading ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
              تحديث التقرير
            </Button>
          </div>

          {!storageReport ? (
            <p className="rounded-xl bg-white p-4 text-center text-xs font-bold text-slate-500">لم يتم تحميل تقرير التخزين بعد.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600">كتب مرتبطة بـ R2<br /><span className="text-lg text-[#0f2b46]">{storageReport.summary.linkedR2Objects}</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600">حجم R2 المرتبط<br /><span className="text-lg text-[#0f2b46]">{Math.round(storageReport.summary.linkedR2Bytes / 1024 / 1024)}MB</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-amber-700">كتب تحتاج مراجعة<br /><span className="text-lg">{storageReport.summary.suspiciousBooks}</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-red-700">مسودات اختبار يتيمة<br /><span className="text-lg">{storageReport.summary.orphanExamDrafts}</span></div>
              </div>

              <div className="grid gap-2 md:grid-cols-3">
                <div className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">ملفات Base64 قديمة: <b>{storageReport.summary.legacyBase64Books}</b><br />الحجم التقريبي: {Math.round(storageReport.summary.legacyBase64Bytes / 1024 / 1024)}MB</div>
                <div className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">قطع رفع مؤقتة: <b>{storageReport.summary.uploadChunks}</b><br />حجمها التقريبي: {Math.round(storageReport.summary.uploadChunkBytes / 1024 / 1024)}MB</div>
                <div className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">ملفات طلاب داخل Neon: <b>{storageReport.summary.heavyDbFileRows}</b><br />حجمها التقريبي: {Math.round(storageReport.summary.heavyDbFileBytes / 1024 / 1024)}MB</div>
                <div className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-emerald-700">واجبات محفوظة خارج Neon: <b>{storageReport.summary.externallyStoredAssignments}</b><br />حجمها التقريبي: {Math.round(storageReport.summary.externallyStoredAssignmentBytes / 1024 / 1024)}MB</div>
                <div className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-emerald-700">تسجيلات محفوظة خارج Neon: <b>{storageReport.summary.externallyStoredDefenseRecordings}</b><br />حجمها التقريبي: {Math.round(storageReport.summary.externallyStoredDefenseRecordingBytes / 1024 / 1024)}MB</div>
                <div className="rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">اختبارات REVIEW محفوظة: <b>{storageReport.summary.reviewExams}</b><br />للمراقبة فقط، لا حذف تلقائي.</div>
              </div>

              {(storageReport.samples?.heavyDbFiles || []).length > 0 && (
                <div className="rounded-2xl bg-white p-4">
                  <h4 className="mb-2 text-xs font-black text-[#0f2b46]">فحص الملفات الثقيلة داخل قاعدة البيانات</h4>
                  <div className="grid gap-2 md:grid-cols-2">
                    {storageReport.samples.heavyDbFiles.map((item) => (
                      <div key={item.key} className={`rounded-xl p-3 text-xs font-bold leading-6 ${item.status === 'SAFE' ? 'bg-emerald-50 text-emerald-700' : item.status === 'HIGH_RISK' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
                        <b>{item.label}</b><br />
                        السجلات: {item.rows} · الحجم التقريبي: {Math.round(item.approxBytes / 1024 / 1024)}MB<br />
                        <span className="text-[11px]">{item.note}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="rounded-2xl bg-white p-4">
                <h4 className="mb-2 text-xs font-black text-[#0f2b46]">توصيات التقرير</h4>
                <div className="grid gap-2 md:grid-cols-2">
                  {storageReport.recommendations.map((r, i) => <p key={i} className="rounded-xl bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">• {r}</p>)}
                </div>
              </div>

              {storageReport.samples.suspiciousBooks.length > 0 && (
                <div className="rounded-2xl bg-white p-4">
                  <h4 className="mb-2 text-xs font-black text-amber-700">نماذج كتب تحتاج مراجعة</h4>
                  <div className="space-y-2">
                    {storageReport.samples.suspiciousBooks.slice(0, 5).map((b) => (
                      <p key={b.id} className="rounded-xl bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-800">
                        {b.title} — {b.program || 'بدون برنامج'} — المزود: {b.storageProvider || 'غير محدد'} — مفتاح التخزين: {b.storageKey ? 'موجود' : 'غير موجود'}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              <p className="rounded-xl bg-blue-50 p-3 text-[11px] font-bold leading-6 text-blue-700">{storageReport.storageConfig.note}</p>
            </div>
          )}
        </CardContent>
      </Card>

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
                      <Button size="sm" variant="outline" className="text-xs font-black" disabled={busy} onClick={() => generateExamFromQuestionBank(item, 1)}>
                        {busy ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                        امتحان فصل 1 من البنك
                      </Button>
                      <Button size="sm" variant="outline" className="text-xs font-black" disabled={busy} onClick={() => generateExamFromQuestionBank(item, 2)}>
                        {busy ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                        امتحان فصل 2 من البنك
                      </Button>
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

      <Dialog open={mailStatusOpen} onOpenChange={setMailStatusOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-4xl sm:p-6" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">حالة البريد والتنبيهات</DialogTitle>
            <DialogDescription>تعرض هذه النافذة جاهزية SMTP / Resend وآخر رسائل البريد المسجلة في النظام.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button onClick={loadMailStatus} disabled={mailStatusLoading} className="bg-[#0f2b46] font-black text-[#f5f0e1]">
                {mailStatusLoading ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-1 h-4 w-4" />}
                تحديث حالة البريد
              </Button>
            </div>

            {mailStatusLoading ? (
              <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">جاري تحميل حالة البريد...</div>
            ) : mailStatus ? (
              <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center">
                    <p className="text-xs font-black text-slate-500">SMTP</p>
                    <p className={`mt-1 text-sm font-black ${mailStatus.config?.smtpConfigured ? 'text-emerald-700' : 'text-amber-700'}`}>{mailStatus.config?.smtpConfigured ? 'مفعّل' : 'غير مفعّل'}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center">
                    <p className="text-xs font-black text-slate-500">Resend</p>
                    <p className={`mt-1 text-sm font-black ${mailStatus.config?.resendEnabled ? 'text-emerald-700' : 'text-amber-700'}`}>{mailStatus.config?.resendEnabled ? 'مفعّل' : 'غير مفعّل'}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center">
                    <p className="text-xs font-black text-slate-500">مرسلة</p>
                    <p className="mt-1 text-lg font-black text-[#0f2b46]">{mailStatus.stats?.sent || 0}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-100 bg-white p-4 text-center">
                    <p className="text-xs font-black text-slate-500">فاشلة / متخطاة</p>
                    <p className="mt-1 text-lg font-black text-[#0f2b46]">{(mailStatus.stats?.failed || 0) + (mailStatus.stats?.skipped || 0)}</p>
                  </div>
                </div>

                <div className="rounded-2xl bg-slate-50 p-4 text-xs font-bold leading-6 text-slate-600">
                  <p><b>المرسل:</b> {mailStatus.config?.mailFrom || 'غير محدد'}</p>
                  <p><b>مفتاح Resend:</b> {mailStatus.config?.resendKey || 'غير موجود'}</p>
                </div>

                <div className="rounded-2xl border border-sky-100 bg-sky-50 p-4">
                  <h4 className="mb-2 text-sm font-black text-[#0f2b46]">إرسال رسالة اختبار</h4>
                  <div className="grid gap-2 md:grid-cols-[1fr_160px]">
                    <input
                      value={mailTestEmail}
                      onChange={(e) => setMailTestEmail(e.target.value)}
                      className="h-11 rounded-xl border border-sky-100 bg-white px-3 text-sm font-bold text-[#0f2b46]"
                      placeholder="اكتب بريدك لتجربة الإرسال"
                    />
                    <Button onClick={sendMailTest} disabled={mailTestSending} className="h-11 bg-sky-700 font-black text-white hover:bg-sky-800">
                      {mailTestSending ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : null}
                      إرسال اختبار
                    </Button>
                  </div>
                  <p className="mt-2 text-[11px] font-bold leading-5 text-sky-700">ستظهر نتيجة الرسالة في سجل البريد أسفل هذه النافذة.</p>
                </div>

                {mailStatus.warnings?.length ? (
                  <div className="rounded-2xl bg-amber-50 p-4 text-xs font-bold leading-6 text-amber-700">
                    {mailStatus.warnings.map((warning: string, index: number) => <div key={index}>• {warning}</div>)}
                  </div>
                ) : (
                  <div className="rounded-2xl bg-emerald-50 p-4 text-xs font-bold leading-6 text-emerald-700">لا توجد تحذيرات بريد حالية.</div>
                )}

                <div className="rounded-2xl border border-slate-100 bg-white p-4">
                  <h4 className="mb-3 text-sm font-black text-[#0f2b46]">آخر رسائل البريد</h4>
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {mailStatus.recent?.length ? mailStatus.recent.map((log: any) => (
                      <div key={log.id} className="rounded-xl bg-slate-50 p-3 text-xs font-bold leading-5 text-slate-600">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-black text-[#0f2b46]">{log.subject}</span>
                          <Badge className={log.status === 'SENT' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : log.status === 'FAILED' ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{log.status}</Badge>
                        </div>
                        <p className="mt-1 text-[11px] text-slate-500">إلى: {log.to} · الحدث: {log.event || 'غير محدد'}</p>
                        {log.error ? <p className="mt-1 text-[11px] text-red-600">{log.error}</p> : null}
                      </div>
                    )) : <div className="rounded-xl bg-slate-50 p-4 text-center text-xs font-bold text-slate-500">لا توجد سجلات بريد بعد.</div>}
                  </div>
                </div>
              </>
            ) : (
              <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">اضغط تحديث حالة البريد للتحميل.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={studentPreviewOpen} onOpenChange={setStudentPreviewOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-5xl sm:p-6" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">معاينة تجربة الطالب</DialogTitle>
            <DialogDescription>معاينة قراءة فقط لما سيظهر للطالب في البرنامج، بدون إنشاء طالب أو تسجيل أو بيانات تجريبية.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-2 md:grid-cols-[1fr_120px]">
              <select
                value={studentPreviewProgramId}
                onChange={(e) => {
                  setStudentPreviewProgramId(e.target.value)
                  void loadStudentPreview(e.target.value)
                }}
                className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-[#0f2b46]"
              >
                {studentPreviewPrograms.map((p) => <option key={p.id} value={p.id}>{p.titleAr}</option>)}
              </select>
              <Button onClick={() => loadStudentPreview()} disabled={studentPreviewLoading} className="h-11 bg-[#0f2b46] font-black text-[#f5f0e1]">
                {studentPreviewLoading ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : null}
                تحديث
              </Button>
            </div>

            {studentPreviewLoading ? (
              <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">جاري بناء معاينة الطالب...</div>
            ) : studentPreview ? (
              <div className="space-y-4">
                <div className="rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-4">
                  <h3 className="text-base font-black text-[#0f2b46]">{studentPreview.program.titleAr}</h3>
                  <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{studentPreview.program.description || 'لا يوجد وصف مختصر لهذا البرنامج.'}</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">الكتب<br /><span className="text-lg text-[#0f2b46]">{studentPreview.counts.books}</span></div>
                    <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">الوحدات<br /><span className="text-lg text-[#0f2b46]">{studentPreview.counts.units}</span></div>
                    <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">بنك المعرفة<br /><span className="text-lg text-[#0f2b46]">{studentPreview.counts.knowledgeItems}</span></div>
                    <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">الاختبارات<br /><span className="text-lg text-[#0f2b46]">{studentPreview.counts.readyProgramExams}</span></div>
                    <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">الواجبات<br /><span className="text-lg text-[#0f2b46]">{studentPreview.counts.publishedAssignments}</span></div>
                    <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">عناوين البحث<br /><span className="text-lg text-[#0f2b46]">{studentPreview.counts.thesisTopics}</span></div>
                  </div>
                </div>

                {studentPreview.warnings?.length ? (
                  <div className="rounded-2xl bg-amber-50 p-4 text-xs font-bold leading-6 text-amber-700">
                    {studentPreview.warnings.map((w: string, i: number) => <div key={i}>• {w}</div>)}
                  </div>
                ) : null}

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h4 className="mb-2 text-sm font-black text-[#0f2b46]">ما سيراه الطالب في الكتب</h4>
                    <div className="max-h-56 space-y-2 overflow-y-auto">
                      {studentPreview.program.books?.length ? studentPreview.program.books.map((b: any) => (
                        <div key={b.id} className="rounded-xl bg-slate-50 p-3 text-xs font-bold leading-5 text-slate-600">
                          <b className="text-[#0f2b46]">{b.title}</b><br />الفصل: {b.semester || '-'} · التخزين: {b.storageProvider || 'غير محدد'}
                        </div>
                      )) : <p className="text-xs font-bold text-slate-500">لا توجد كتب.</p>}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h4 className="mb-2 text-sm font-black text-[#0f2b46]">ما سيراه الطالب في الوحدات</h4>
                    <div className="max-h-56 space-y-2 overflow-y-auto">
                      {studentPreview.program.units?.length ? studentPreview.program.units.map((u: any) => (
                        <div key={u.id} className="rounded-xl bg-slate-50 p-3 text-xs font-bold leading-5 text-slate-600">
                          <b className="text-[#0f2b46]">{u.title}</b><br />الفصل: {u.semester || '-'} · {u.objectives ? 'الأهداف موجودة' : 'الأهداف غير مكتملة'}
                        </div>
                      )) : <p className="text-xs font-bold text-slate-500">لا توجد وحدات.</p>}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h4 className="mb-2 text-sm font-black text-[#0f2b46]">الاختبارات والواجبات الظاهرة</h4>
                    <div className="max-h-56 space-y-2 overflow-y-auto">
                      {[...(studentPreview.program.programExams || []), ...(studentPreview.program.assignments || [])].length ? (
                        <>
                          {studentPreview.program.programExams?.map((e: any) => <div key={`e-${e.id}`} className="rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-600">اختبار: <b>{e.title}</b> · الأسئلة: {e._count?.questions || 0}</div>)}
                          {studentPreview.program.assignments?.map((a: any) => <div key={`a-${a.id}`} className="rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-600">واجب: <b>{a.title}</b></div>)}
                        </>
                      ) : <p className="text-xs font-bold text-slate-500">لا توجد اختبارات أو واجبات منشورة.</p>}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <h4 className="mb-2 text-sm font-black text-[#0f2b46]">عناوين بحث التخرج المعتمدة</h4>
                    <div className="max-h-56 space-y-2 overflow-y-auto">
                      {studentPreview.thesisTopics?.length ? studentPreview.thesisTopics.map((t: any) => (
                        <div key={t.id} className="rounded-xl bg-slate-50 p-3 text-xs font-bold leading-5 text-slate-600"><b className="text-[#0f2b46]">{t.title}</b>{t.description ? <><br />{t.description}</> : null}</div>
                      )) : <p className="text-xs font-bold text-slate-500">لا توجد عناوين معتمدة بعد.</p>}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">لا توجد برامج متاحة للمعاينة.</div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={studentsOpen} onOpenChange={setStudentsOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto p-4 sm:max-w-5xl sm:p-6" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">إدارة الطلاب</DialogTitle>
            <DialogDescription>بحث وتعطيل وتفعيل وأرشفة الطلاب، مع حذف آمن للطلاب التجريبيين فقط إذا لم يكن لديهم سجلات حقيقية.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2 md:grid-cols-[1fr_180px_120px]">
              <input value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} className="h-11 rounded-xl border border-slate-200 px-3 text-sm font-bold" placeholder="بحث بالاسم أو البريد أو الدولة" />
              <select value={studentStatus} onChange={(e) => setStudentStatus(e.target.value)} className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold">
                <option value="ALL">كل الحالات</option>
                <option value="ACTIVE">نشط</option>
                <option value="DISABLED">معطل</option>
                <option value="ARCHIVED">مؤرشف</option>
              </select>
              <Button onClick={() => loadStudents()} disabled={studentsLoading} className="h-11 bg-[#0f2b46] font-black text-[#f5f0e1]">
                {studentsLoading ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : null} بحث
              </Button>
            </div>

            {selectedStudent ? (
              <div className="rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-black text-[#0f2b46]">ملف الطالب: {selectedStudent.name || 'طالب'}</h4>
                    <p className="mt-1 text-[11px] font-bold text-slate-600">{selectedStudent.email} · الحالة: {selectedStudent.status === 'DISABLED' ? 'معطل' : selectedStudent.status === 'ARCHIVED' ? 'مؤرشف' : 'نشط'}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setSelectedStudent(null)} className="text-xs font-black">إغلاق التفاصيل</Button>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">التسجيلات<br /><span className="text-lg text-[#0f2b46]">{selectedStudent.enrollments?.length || 0}</span></div>
                  <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">المدفوعات<br /><span className="text-lg text-[#0f2b46]">{selectedStudent.payments?.length || 0}</span></div>
                  <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">الاختبارات<br /><span className="text-lg text-[#0f2b46]">{(selectedStudent.examAttempts?.length || 0) + (selectedStudent.programExamAttempts?.length || 0)}</span></div>
                  <div className="rounded-xl bg-white p-3 text-center text-xs font-black text-slate-600">الشهادات<br /><span className="text-lg text-[#0f2b46]">{selectedStudent.certificates?.length || 0}</span></div>
                </div>
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div className="rounded-xl bg-white p-3">
                    <p className="mb-2 text-xs font-black text-[#0f2b46]">آخر التسجيلات والمدفوعات</p>
                    <div className="max-h-44 space-y-2 overflow-y-auto">
                      {selectedStudent.enrollments?.length ? selectedStudent.enrollments.map((e: any) => <div key={e.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">{e.program?.titleAr || 'برنامج'} · {e.status} · مدفوعات: {e.payments?.length || 0}</div>) : <p className="text-[11px] font-bold text-slate-400">لا توجد تسجيلات.</p>}
                      {selectedStudent.payments?.slice(0, 6).map((p: any) => <div key={p.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">فاتورة: {p.invoiceNo || '-'} · {p.status} · {p.amount}</div>)}
                    </div>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="mb-2 text-xs font-black text-[#0f2b46]">آخر النشاط الأكاديمي</p>
                    <div className="max-h-44 space-y-2 overflow-y-auto">
                      {selectedStudent.programExamAttempts?.slice(0, 5).map((a: any) => <div key={a.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">اختبار: {a.exam?.title || '-'} · {a.score ?? '-'} · {a.status}</div>)}
                      {selectedStudent.assignmentSubmissions?.slice(0, 5).map((s: any) => <div key={s.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">واجب: {s.assignment?.title || '-'} · {s.score ?? '-'} · {s.status}</div>)}
                      {selectedStudent.theses?.slice(0, 3).map((t: any) => <div key={t.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">بحث: {t.title || '-'} · {t.status}</div>)}
                    </div>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="mb-2 text-xs font-black text-[#0f2b46]">طلبات الالتحاق</p>
                    <div className="max-h-44 space-y-2 overflow-y-auto">
                      {selectedStudent.ownedAdmissions?.length ? selectedStudent.ownedAdmissions.map((a: any) => <div key={a.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">{a.programRef?.titleAr || a.program || 'طلب'} · {a.status} · {a.reference || '-'}</div>) : <p className="text-[11px] font-bold text-slate-400">لا توجد طلبات التحاق.</p>}
                    </div>
                  </div>
                  <div className="rounded-xl bg-white p-3">
                    <p className="mb-2 text-xs font-black text-[#0f2b46]">عناوين البحث والشهادات</p>
                    <div className="max-h-44 space-y-2 overflow-y-auto">
                      {selectedStudent.thesisTopicRequests?.slice(0, 5).map((r: any) => <div key={r.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">عنوان بحث: {r.topic?.title || r.proposedTitle || '-'} · {r.status}</div>)}
                      {selectedStudent.certificates?.slice(0, 5).map((c: any) => <div key={c.id} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold text-slate-600">شهادة: {c.program || '-'} · {c.serial || '-'} · {c.valid ? 'صالحة' : 'ملغاة'}</div>)}
                      {!selectedStudent.thesisTopicRequests?.length && !selectedStudent.certificates?.length ? <p className="text-[11px] font-bold text-slate-400">لا توجد عناوين بحث أو شهادات.</p> : null}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="max-h-[62dvh] space-y-3 overflow-y-auto pr-1">
              {studentsLoading ? (
                <div className="rounded-2xl bg-slate-50 p-6 text-center text-xs font-bold text-slate-500">جاري تحميل الطلاب...</div>
              ) : students.length === 0 ? (
                <div className="rounded-2xl bg-slate-50 p-6 text-center text-xs font-bold text-slate-500">لا يوجد طلاب مطابقون للبحث الحالي.</div>
              ) : students.map((s: any) => (
                <div key={s.id} className="rounded-2xl border border-slate-200 bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h4 className="text-sm font-black text-[#0f2b46]">{s.name || 'طالب'} <span className="text-xs text-slate-400">({s.email})</span></h4>
                      <p className="mt-1 text-[11px] font-bold text-slate-500">الحالة: {s.status === 'DISABLED' ? 'معطل' : s.status === 'ARCHIVED' ? 'مؤرشف' : 'نشط'} · الدولة: {s.country || 'غير محددة'} · التسجيلات: {s.enrollments?.length || 0}</p>
                      <p className="mt-1 text-[11px] font-bold text-slate-500">محاولات: {s._count?.examAttempts || 0} · واجبات: {s._count?.assignmentSubmissions || 0} · طلبات بحث: {s._count?.thesisTopicRequests || 0}</p>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="outline" disabled={studentBusyId === s.id} onClick={() => loadStudentDetails(s.id)} className="text-xs font-black">تفاصيل</Button>
                      {s.status !== 'ACTIVE' ? <Button size="sm" disabled={studentBusyId === s.id} onClick={() => updateStudentAction(s.id, 'setStatus', { status: 'ACTIVE' })} className="bg-emerald-600 text-xs font-black text-white">تفعيل</Button> : null}
                      {s.status !== 'DISABLED' ? <Button size="sm" variant="outline" disabled={studentBusyId === s.id} onClick={() => updateStudentAction(s.id, 'setStatus', { status: 'DISABLED' })} className="text-xs font-black">تعطيل</Button> : null}
                      {s.status !== 'ARCHIVED' ? <Button size="sm" variant="outline" disabled={studentBusyId === s.id} onClick={() => updateStudentAction(s.id, 'setStatus', { status: 'ARCHIVED' })} className="text-xs font-black">أرشفة</Button> : null}
                      <Button size="sm" variant="outline" disabled={studentBusyId === s.id} onClick={() => confirm('الحذف الآمن يعمل فقط للطالب التجريبي بلا مدفوعات أو شهادات أو سجلات أكاديمية. متابعة؟') && updateStudentAction(s.id, 'safeDelete')} className="border-red-200 text-xs font-black text-red-700">حذف آمن</Button>
                    </div>
                  </div>
                  {s.enrollments?.length ? (
                    <div className="mt-3 space-y-2">
                      {s.enrollments.map((e: any) => (
                        <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-slate-50 p-2 text-[11px] font-bold text-slate-600">
                          <span>{e.program?.titleAr || 'برنامج'} · {e.status}</span>
                          <Button size="sm" variant="outline" disabled={studentBusyId === s.id} onClick={() => confirm('إلغاء التسجيل متاح فقط إذا لا توجد مدفوعات مدفوعة مرتبطة. متابعة؟') && updateStudentAction(s.id, 'cancelEnrollment', { enrollmentId: e.id })} className="h-7 px-2 text-[10px] font-black">إلغاء التسجيل</Button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={thesisTopicDialogOpen} onOpenChange={setThesisTopicDialogOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden p-4 sm:max-w-2xl sm:p-6" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">{thesisTopicMode === 'generate' ? 'توليد عناوين بحث التخرج' : 'إضافة عنوان بحث تخرج'}</DialogTitle>
            <DialogDescription>
              اختر البرنامج من القائمة بدل إدخال رقم. تظهر كل البرامج المتاحة، وليس أول 30 برنامج فقط.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-black text-slate-600">البرنامج / التخصص</label>
              <select
                value={thesisProgramId}
                onChange={(e) => {
                  setThesisProgramId(e.target.value)
                  void loadThesisTopics(e.target.value)
                }}
                className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-[#0f2b46]"
              >
                <option value="">اختر البرنامج</option>
                {thesisProgramOptions.map((program) => (
                  <option key={program.id} value={program.id}>{program.titleAr}</option>
                ))}
              </select>
            </div>
            {thesisTopicMode === 'generate' ? (
              <div>
                <label className="mb-1 block text-xs font-black text-slate-600">عدد العناوين المقترحة</label>
                <input
                  type="number"
                  min={3}
                  max={12}
                  value={thesisGenerateCount}
                  onChange={(e) => setThesisGenerateCount(Math.max(3, Math.min(12, Number(e.target.value || 6))))}
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-[#0f2b46]"
                />
                <div className="mt-2 rounded-xl bg-amber-50 p-3 text-[11px] font-bold leading-6 text-amber-700">
                  سيقترح النظام عناوين حسب وصف البرنامج والكتب والوحدات وبنك المعرفة، وتبقى بحاجة لمراجعة واعتماد قبل ظهورها للطلاب.
                </div>
              </div>
            ) : (
              <>
                <div>
                  <label className="mb-1 block text-xs font-black text-slate-600">عنوان البحث</label>
                  <input
                    value={thesisTopicTitle}
                    onChange={(e) => setThesisTopicTitle(e.target.value)}
                    className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold text-[#0f2b46]"
                    placeholder="مثال: أثر التحول الرقمي على كفاءة المؤسسات الصغيرة"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-black text-slate-600">وصف مختصر / مجال البحث</label>
                  <Textarea
                    value={thesisTopicDescription}
                    onChange={(e) => setThesisTopicDescription(e.target.value)}
                    className="min-h-28 text-sm leading-7"
                    placeholder="اكتب الهدف العام أو نطاق البحث..."
                  />
                </div>
              </>
            )}
            <div className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h4 className="text-xs font-black text-[#0f2b46]">العناوين الحالية لهذا البرنامج</h4>
                <Button size="sm" variant="outline" className="h-8 text-[11px] font-black" disabled={!thesisProgramId || thesisTopicLoading} onClick={() => loadThesisTopics()}>
                  {thesisTopicLoading ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                  تحديث
                </Button>
              </div>
              {thesisTopicLoading ? (
                <div className="rounded-xl bg-white p-4 text-center text-xs font-bold text-slate-500">جاري تحميل العناوين...</div>
              ) : thesisTopicList.length ? (
                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                  {thesisTopicList.map((topic: any) => (
                    <div key={topic.id} className="rounded-xl border border-slate-100 bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-black leading-6 text-[#0f2b46]">{topic.title}</p>
                          {topic.description ? <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">{topic.description}</p> : null}
                          <p className="mt-1 text-[11px] font-black text-slate-400">الحالة: {topic.status === 'APPROVED' ? 'معتمد للطلاب' : topic.status === 'NEEDS_REVIEW' ? 'بانتظار مراجعة الإدارة' : topic.status === 'DISABLED' ? 'معطل' : topic.status}</p>
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {topic.status !== 'APPROVED' ? (
                            <Button size="sm" className="h-8 bg-emerald-600 px-2 text-[11px] font-black text-white hover:bg-emerald-700" disabled={thesisTopicBusy} onClick={() => updateThesisTopicStatus(topic.id, 'APPROVED')}>اعتماد</Button>
                          ) : null}
                          {topic.status !== 'DISABLED' ? (
                            <Button size="sm" variant="outline" className="h-8 px-2 text-[11px] font-black" disabled={thesisTopicBusy} onClick={() => updateThesisTopicStatus(topic.id, 'DISABLED')}>تعطيل</Button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl bg-white p-4 text-center text-xs font-bold text-slate-500">لا توجد عناوين لهذا البرنامج بعد.</div>
              )}
            </div>

            <div className="rounded-2xl border border-amber-100 bg-amber-50 p-3">
              <h4 className="mb-2 text-xs font-black text-[#0f2b46]">طلبات الطلاب على عناوين البحث</h4>
              {thesisTopicRequests.length ? (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                  {thesisTopicRequests.map((request: any) => (
                    <div key={request.id} className="rounded-xl bg-white p-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-black leading-6 text-[#0f2b46]">{request.proposedTitle}</p>
                          <p className="text-[11px] font-bold leading-5 text-slate-500">الطالب: {request.user?.name || request.user?.email || 'غير محدد'} · الحالة: {request.status === 'APPROVED' ? 'معتمد' : request.status === 'REJECTED' ? 'مرفوض' : request.status === 'NEEDS_REVISION' ? 'يحتاج تعديل' : 'بانتظار الاعتماد'}</p>
                          {request.rationale ? <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">سبب الاختيار: {request.rationale}</p> : null}
                          {request.adminNote ? <p className="mt-1 text-[11px] font-bold leading-5 text-amber-700">ملاحظة الإدارة: {request.adminNote}</p> : null}
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-1">
                          {request.status !== 'APPROVED' ? <Button size="sm" className="h-8 bg-emerald-600 px-2 text-[11px] font-black text-white hover:bg-emerald-700" disabled={thesisTopicBusy} onClick={() => updateThesisTopicRequestStatus(request.id, 'APPROVED')}>اعتماد</Button> : null}
                          <Button size="sm" variant="outline" className="h-8 px-2 text-[11px] font-black" disabled={thesisTopicBusy} onClick={() => updateThesisTopicRequestStatus(request.id, 'NEEDS_REVISION')}>طلب تعديل</Button>
                          <Button size="sm" variant="outline" className="h-8 border-red-200 px-2 text-[11px] font-black text-red-700" disabled={thesisTopicBusy} onClick={() => updateThesisTopicRequestStatus(request.id, 'REJECTED')}>رفض</Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl bg-white p-4 text-center text-xs font-bold text-slate-500">لا توجد طلبات طلاب على عناوين البحث لهذا البرنامج.</div>
              )}
            </div>

            <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-slate-100 bg-white/95 p-3 backdrop-blur sm:-mx-6 sm:px-6">
              <Button variant="outline" className="h-11 flex-1" onClick={() => setThesisTopicDialogOpen(false)}>إلغاء</Button>
              <Button className="h-11 flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={thesisTopicBusy || !thesisProgramId} onClick={submitThesisTopicAction}>
                {thesisTopicBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                {thesisTopicMode === 'generate' ? 'توليد العناوين' : 'حفظ العنوان'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={catalogImportOpen} onOpenChange={setCatalogImportOpen}>
        <DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overflow-x-hidden p-4 sm:max-w-3xl sm:p-6" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">استيراد نسخة كتالوج البرامج</DialogTitle>
            <DialogDescription>
              الصق محتوى ملف JSON الذي نزلته من زر تنزيل نسخة البرامج. هذا يرجع تفاصيل البرامج فقط ولا يرجع طلاباً أو مدفوعات.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-2xl border border-dashed border-[#c9a227]/50 bg-[#fffaf0] p-3">
              <label className="block text-xs font-black text-[#0f2b46]">اختيار ملف النسخة من الجهاز</label>
              <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">الأفضل اختيار ملف JSON مباشرة بدل لصقه، خصوصًا من الجوال حتى لا تظهر لوحة المفاتيح وتغطي الشاشة.</p>
              <input
                type="file"
                accept=".json,application/json,text/json,text/plain"
                className="mt-3 w-full rounded-xl border border-slate-200 bg-white p-2 text-xs font-bold"
                onChange={async (e) => {
                  const file = e.currentTarget.files?.[0]
                  if (!file) return
                  setCatalogImportText(await file.text())
                  e.currentTarget.value = ''
                }}
              />
            </div>
            <Textarea
              value={catalogImportText}
              onChange={(e) => setCatalogImportText(e.target.value)}
              className="max-h-56 min-h-32 w-full max-w-full overflow-x-auto whitespace-pre-wrap break-all text-xs leading-6 sm:max-h-80 sm:min-h-64"
              dir="ltr"
              placeholder='{ "format": "AACT_PROGRAM_CATALOG_V1", "programs": [...] }'
            />
            <div className="rounded-xl bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-700">
              لا تستخدم الاستيراد إلا بعد التأكد أن الملف صحيح. الاستيراد يحدث تحديثاً/إنشاءً للبرامج حسب slug والـ id، ولا يحذف الطلاب أو الطلبات.
            </div>
            <div className="sticky bottom-0 -mx-4 flex gap-2 border-t border-slate-100 bg-white/95 p-3 backdrop-blur sm:-mx-6 sm:px-6">
              <Button variant="outline" className="h-11 flex-1" onClick={() => setCatalogImportOpen(false)}>إلغاء</Button>
              <Button className="h-11 flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={catalogBusy === 'import' || catalogImportText.trim().length < 20} onClick={importProgramCatalog}>
                {catalogBusy === 'import' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                استيراد الكتالوج
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={questionBankOpen} onOpenChange={setQuestionBankOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">مراجعة بنك الأسئلة المركزي</DialogTitle>
            <DialogDescription>
              {questionBankProgram ? `أسئلة برنامج: ${questionBankProgram.titleAr}` : 'مراجعة الأسئلة المركزية قبل استخدامها في الامتحانات'}
            </DialogDescription>
          </DialogHeader>

          {questionBankBusyId === 'loading' || questionBankBusyId === 'generate' ? (
            <div className="flex h-44 flex-col items-center justify-center gap-3 text-sm font-bold text-slate-500">
              <Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" />
              {questionBankBusyId === 'generate' ? 'جاري توليد أسئلة من بنك المعرفة...' : 'جاري تحميل بنك الأسئلة...'}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2 sm:grid-cols-4">
                <div className="rounded-xl bg-slate-50 p-3 text-xs font-black text-slate-600">الإجمالي: {questionBankStats?.total || 0}</div>
                <div className="rounded-xl bg-amber-50 p-3 text-xs font-black text-amber-700">بانتظار مراجعة: {questionBankStats?.pending || 0}</div>
                <div className="rounded-xl bg-emerald-50 p-3 text-xs font-black text-emerald-700">معتمدة: {questionBankStats?.approved || 0}</div>
                <div className="rounded-xl bg-red-50 p-3 text-xs font-black text-red-700">مرفوضة: {questionBankStats?.rejected || 0}</div>
              </div>

              <div className="flex flex-wrap gap-2 rounded-2xl bg-slate-50 p-3">
                <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => setManualQuestionOpen(true)}>إضافة سؤال يدوي</Button>
                <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => setImportQuestionsOpen(true)}>استيراد أسئلة</Button>
                <Button size="sm" variant="outline" className="text-xs font-black" disabled={questionBankBusyId === 'exam-load'} onClick={openExamImport}>
                  {questionBankBusyId === 'exam-load' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                  نسخ من اختبار موجود
                </Button>
                <Button size="sm" variant="outline" className="text-xs font-black" disabled={questionBankBusyId === 'generate'} onClick={() => questionBankProgram && generateQuestionBank(questionBankProgram)}>
                  {questionBankBusyId === 'generate' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                  توليد أسئلة إضافية من بنك المعرفة
                </Button>
              </div>

              {questionBankItems.length === 0 ? (
                <p className="rounded-xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد أسئلة في البنك بعد. استخدم زر توليد أسئلة للبنك من لوحة تجهيز المنهج.</p>
              ) : questionBankItems.map((question) => {
                let options: string[] = []
                try { options = question.options ? JSON.parse(question.options) : [] } catch {}
                return (
                  <article key={question.id} className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap gap-2">
                        <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{question.type}</Badge>
                        <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">{question.difficulty || 'MEDIUM'}</Badge>
                        <Badge className={question.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : question.status === 'REJECTED' ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                          {question.status === 'APPROVED' ? 'معتمد' : question.status === 'REJECTED' ? 'مرفوض' : 'بانتظار المراجعة'}
                        </Badge>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" disabled={questionBankBusyId === question.id} onClick={() => updateQuestionBankStatus(question, 'APPROVED')} className="bg-emerald-700 text-xs font-black text-white hover:bg-emerald-800">اعتماد</Button>
                        <Button size="sm" variant="outline" disabled={questionBankBusyId === question.id} onClick={() => updateQuestionBankStatus(question, 'REJECTED')} className="border-red-200 text-xs font-black text-red-700">رفض</Button>
                        <Button size="sm" variant="outline" disabled={questionBankBusyId === question.id} onClick={() => updateQuestionBankStatus(question, 'ARCHIVED')} className="text-xs font-black">أرشفة</Button>
                      </div>
                    </div>
                    <p className="rounded-xl bg-slate-50 p-3 text-sm font-bold leading-7 text-[#0f2b46]">{question.text}</p>
                    {options.length > 0 && (
                      <div className="mt-2 grid gap-2 md:grid-cols-2">
                        {options.map((o, i) => (
                          <p key={i} className={`rounded-xl p-2 font-bold ${String(i) === String(question.correctAnswer) ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-600'}`}>{i + 1}. {o}</p>
                        ))}
                      </div>
                    )}
                    {question.modelAnswer && <p className="mt-2 rounded-xl bg-blue-50 p-3 font-bold leading-6 text-blue-700">الإجابة النموذجية: {question.modelAnswer}</p>}
                    {question.sourceEvidence && <p className="mt-2 rounded-xl bg-[#fffaf0] p-3 font-bold leading-6 text-[#8a6d16]">الدليل العلمي: {question.sourceEvidence}</p>}
                    {question.sourceBookTitle && <p className="mt-2 text-[11px] font-bold text-slate-400">المصدر: {question.sourceBookTitle}</p>}
                    {questionBankBusyId === question.id && <p className="mt-2 text-xs font-bold text-amber-700">جاري تحديث حالة السؤال...</p>}
                  </article>
                )
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={examImportOpen} onOpenChange={setExamImportOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">نسخ أسئلة من اختبار موجود إلى بنك الأسئلة</DialogTitle>
            <DialogDescription>
              اختر اختباراً من نفس البرنامج، ثم حدد الأسئلة التي تريد نقلها إلى بنك الأسئلة المركزي. لن تُنسخ الأسئلة المكررة.
            </DialogDescription>
          </DialogHeader>

          {questionBankBusyId === 'exam-load' ? (
            <div className="flex h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div>
          ) : examImportItems.length === 0 ? (
            <p className="rounded-xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد اختبارات تحتوي أسئلة لهذا البرنامج بعد.</p>
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                <select
                  value={selectedExamId}
                  onChange={(e) => {
                    const nextId = e.target.value
                    const next = examImportItems.find((exam) => exam.id === nextId)
                    setSelectedExamId(nextId)
                    setSelectedExamQuestionIds(next?.questions?.map((q) => q.id) || [])
                  }}
                  className="h-11 rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold outline-none focus:border-[#c9a227]"
                >
                  {examImportItems.map((exam) => (
                    <option key={exam.id} value={exam.id}>{exam.title} — فصل {exam.semester} — {exam.questions.length} سؤال</option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => setSelectedExamQuestionIds(selectedExam?.questions?.map((q) => q.id) || [])}>تحديد الكل</Button>
                  <Button size="sm" variant="outline" className="text-xs font-black" onClick={() => setSelectedExamQuestionIds([])}>إلغاء التحديد</Button>
                </div>
              </div>

              <label className="flex items-center gap-2 text-xs font-black text-slate-600">
                <input type="checkbox" checked={examImportApproveNow} onChange={(e) => setExamImportApproveNow(e.target.checked)} /> اعتماد الأسئلة المنسوخة مباشرة
              </label>

              <div className="space-y-2">
                {(selectedExam?.questions || []).map((q) => {
                  const checked = selectedExamQuestionIds.includes(q.id)
                  let options: string[] = []
                  try { options = q.options ? JSON.parse(q.options) : [] } catch {}
                  return (
                    <label key={q.id} className={`block cursor-pointer rounded-2xl border p-3 text-xs ${checked ? 'border-[#c9a227] bg-[#fffaf0]' : 'border-slate-200 bg-white'}`}>
                      <div className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) => {
                            setSelectedExamQuestionIds((prev) => e.target.checked ? Array.from(new Set([...prev, q.id])) : prev.filter((id) => id !== q.id))
                          }}
                          className="mt-1"
                        />
                        <div className="flex-1">
                          <div className="mb-2 flex flex-wrap gap-2">
                            <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{q.type}</Badge>
                            <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">{q.difficulty || 'MEDIUM'}</Badge>
                          </div>
                          <p className="text-sm font-black leading-7 text-[#0f2b46]">{q.text}</p>
                          {options.length > 0 && <p className="mt-1 font-bold text-slate-500">الخيارات: {options.join(' — ')}</p>}
                          {q.modelAnswer && <p className="mt-1 font-bold text-blue-700">إجابة نموذجية: {q.modelAnswer}</p>}
                        </div>
                      </div>
                    </label>
                  )
                })}
              </div>

              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setExamImportOpen(false)}>إلغاء</Button>
                <Button
                  className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]"
                  disabled={questionBankBusyId === 'exam-copy' || selectedExamQuestionIds.length === 0}
                  onClick={copyExamQuestionsToBank}
                >
                  {questionBankBusyId === 'exam-copy' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                  نسخ {selectedExamQuestionIds.length} سؤال إلى البنك
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={manualQuestionOpen} onOpenChange={setManualQuestionOpen}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">إضافة سؤال يدوي إلى بنك الأسئلة</DialogTitle>
            <DialogDescription>أدخل السؤال مباشرة، وسيُحفظ في بنك الأسئلة المركزي للبرنامج الحالي.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">نوع السؤال</label>
                <select value={manualQuestion.type} onChange={(e) => setManualQuestion((p) => ({ ...p, type: e.target.value }))} className="h-10 w-full rounded-xl border px-3 text-sm font-bold">
                  <option value="MCQ">اختيار متعدد</option><option value="TF">صح/خطأ</option><option value="SHORT">قصير</option><option value="ESSAY">مقالي</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">الصعوبة</label>
                <select value={manualQuestion.difficulty} onChange={(e) => setManualQuestion((p) => ({ ...p, difficulty: e.target.value }))} className="h-10 w-full rounded-xl border px-3 text-sm font-bold">
                  <option value="EASY">سهل</option><option value="MEDIUM">متوسط</option><option value="ADVANCED">متقدم</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">الإجابة الصحيحة</label>
                <input value={manualQuestion.correctAnswer} onChange={(e) => setManualQuestion((p) => ({ ...p, correctAnswer: e.target.value }))} className="h-10 w-full rounded-xl border px-3 text-sm font-bold" placeholder="0" />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-black text-slate-500">نص السؤال</label>
              <Textarea value={manualQuestion.text} onChange={(e) => setManualQuestion((p) => ({ ...p, text: e.target.value }))} className="min-h-20 text-sm leading-7" />
            </div>
            {(manualQuestion.type === 'MCQ' || manualQuestion.type === 'TF') && (
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">الخيارات — خيار في كل سطر، والإجابة الصحيحة رقمها يبدأ من 0</label>
                <Textarea value={manualQuestion.options} onChange={(e) => setManualQuestion((p) => ({ ...p, options: e.target.value }))} className="min-h-24 text-sm leading-7" />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs font-black text-slate-500">الإجابة النموذجية / التعليل</label>
              <Textarea value={manualQuestion.modelAnswer} onChange={(e) => setManualQuestion((p) => ({ ...p, modelAnswer: e.target.value }))} className="min-h-20 text-sm leading-7" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-black text-slate-500">الدليل العلمي أو المصدر</label>
              <Textarea value={manualQuestion.sourceEvidence} onChange={(e) => setManualQuestion((p) => ({ ...p, sourceEvidence: e.target.value }))} className="min-h-16 text-sm leading-7" />
            </div>
            <label className="flex items-center gap-2 text-xs font-black text-slate-600"><input type="checkbox" checked={manualQuestion.approveNow} onChange={(e) => setManualQuestion((p) => ({ ...p, approveNow: e.target.checked }))} /> اعتماد السؤال مباشرة</label>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setManualQuestionOpen(false)}>إلغاء</Button>
              <Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={questionBankBusyId === 'manual' || manualQuestion.text.trim().length < 8} onClick={addManualQuestion}>
                {questionBankBusyId === 'manual' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ السؤال
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={importQuestionsOpen} onOpenChange={setImportQuestionsOpen}>
        <DialogContent className="max-w-3xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">استيراد أسئلة إلى بنك الأسئلة</DialogTitle>
            <DialogDescription>الصق JSON أو CSV/TSV. الأعمدة المقترحة: type, question, option1, option2, option3, option4, correctAnswer, modelAnswer, difficulty, sourceEvidence</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='[{"type":"MCQ","text":"نص السؤال","options":["أ","ب","ج","د"],"correctAnswer":"0"}]' className="min-h-72 text-xs leading-6" dir="ltr" />
            <label className="flex items-center gap-2 text-xs font-black text-slate-600"><input type="checkbox" checked={importApproveNow} onChange={(e) => setImportApproveNow(e.target.checked)} /> اعتماد الأسئلة المستوردة مباشرة</label>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setImportQuestionsOpen(false)}>إلغاء</Button>
              <Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={questionBankBusyId === 'import' || importText.trim().length < 10} onClick={importQuestions}>
                {questionBankBusyId === 'import' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} استيراد
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
