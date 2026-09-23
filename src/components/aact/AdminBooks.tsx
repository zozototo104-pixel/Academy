'use client'

import { api } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { cleanAcademicOutput, looksLikeBrokenGeneratedArabic, sanitizeAcademicList, sanitizeAcademicLabelList, conciseAcademicLabel } from '@/lib/academic-output-quality'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  BookMarked, Loader2, Plus, Sparkles, Trash2, FileText, Bot,
  Hourglass, RefreshCw, Upload, CheckCircle2, AlertTriangle, XCircle, ClipboardList,
  Layers, FileCheck2, Link2, StopCircle,
} from 'lucide-react'
import { QuestionReviewDialog, AdminAppealsSection } from '@/components/aact/AdminExamReview'

const FULL_EXAM_TARGET = 80
const MAX_BOOK_FILE_SIZE = 10 * 1024 * 1024
// أي ملف أكبر من هذا الحد يرفع مجزأ حتى لا يصطدم بحد Vercel 4.5MB لطلبات Functions.
const DIRECT_BOOK_UPLOAD_LIMIT = 850 * 1024
const BOOK_UPLOAD_CHUNK_SIZE = 384 * 1024

function makeUploadId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result || '')
      resolve(value.includes(',') ? value.split(',').pop() || '' : value)
    }
    reader.onerror = () => reject(reader.error || new Error('تعذر قراءة جزء الملف'))
    reader.readAsDataURL(blob)
  })
}

async function uploadBookFileInChunks(bookId: string, file: File, onProgress?: (progress: number) => void): Promise<BookRow> {
  if (file.size > MAX_BOOK_FILE_SIZE) throw new Error('حجم الملف يتجاوز 10 ميجابايت')
  const uploadId = makeUploadId()
  const total = Math.max(1, Math.ceil(file.size / BOOK_UPLOAD_CHUNK_SIZE))
  try {
    for (let index = 0; index < total; index++) {
      const start = index * BOOK_UPLOAD_CHUNK_SIZE
      const end = Math.min(file.size, start + BOOK_UPLOAD_CHUNK_SIZE)
      const chunk = await blobToBase64(file.slice(start, end))
      await api('/api/admin/books/upload-chunk', {
        method: 'POST',
        body: JSON.stringify({
          bookId,
          uploadId,
          index,
          total,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          chunk,
        }),
      })
      onProgress?.(Math.max(1, Math.min(95, Math.round(((index + 1) / total) * 95))))
    }

    const done = await api<{ book: BookRow }>('/api/admin/books/upload-chunk', {
      method: 'POST',
      body: JSON.stringify({ action: 'complete', bookId, uploadId }),
    })
    onProgress?.(100)
    return done.book
  } catch (e) {
    await api('/api/admin/books/upload-chunk', {
      method: 'POST',
      body: JSON.stringify({ action: 'abort', bookId, uploadId }),
    }).catch(() => {})
    throw e
  }
}

interface ProgramOption {
  id: string
  titleAr: string
  titleEn?: string | null
  category: string
  categoryLabel?: string
  specialty?: string
}

interface BookRow {
  id: string
  title: string
  titleEn?: string | null
  author?: string | null
  year?: string | null
  description?: string | null
  fileName?: string | null
  size?: number | null
  link?: string | null
  source: string
  semester?: number | null
  levelPolicy?: string | null
  readingDepth?: string | null
  assessmentOrientation?: string | null
  linkReadStatus?: string | null
  linkReadNote?: string | null
  hasFile: boolean
}

interface Suggestion {
  title: string
  titleEn: string
  author: string
  year: string
  reason: string
  /** رابط قراءة مباشر فقط؛ أما Google Books فيظهر كمرجع ولا يُرسل كبنك معرفة */
  link: string
  referenceLink?: string
  linkType?: 'DIRECT_READABLE' | 'CATALOG_SEARCH' | 'UNKNOWN' | 'MISSING_DIRECT_LINK'
  linkReadHint?: string
  semester?: number | null
  levelPolicy?: string
  readingDepth?: string
  assessmentOrientation?: string
  added?: boolean
}

interface ExamRow {
  id: string
  title: string
  status: string
  semester: number
  errorNote?: string | null
  durationMin: number
  passScore: number
  booksUsed?: string | null
  questionCount: number
  byType: Record<string, number>
  totalPoints: number
  pendingReview: number
  rejectedCount: number
  attemptsCount: number
  createdAt: string
}

interface AssignmentSubmissionRow {
  id: string
  studentName?: string
  studentEmail?: string
  answerText?: string | null
  fileName?: string | null
  mimeType?: string | null
  size?: number | null
  status: string
  score?: number | null
  feedback?: string | null
  submittedAt: string
  gradedAt?: string | null
}

interface AssignmentRow {
  id: string
  programId: string
  title: string
  description: string
  semester: number
  type: string
  points: number
  weight: number
  dueDays?: number | null
  rubric?: string | null
  status: string
  submissionsCount: number
  submissions: AssignmentSubmissionRow[]
}

interface AssignmentSuggestion {
  title: string
  description: string
  type: string
  semester: number
  points: number
  weight: number
  dueDays: number
  rubric: string
  sourceKnowledgeTitles: string[]
  added?: boolean
}

interface KnowledgeItemRow {
  id: string
  bookId?: string | null
  bookTitle?: string | null
  semester?: number | null
  category: string
  title: string
  summary: string
  excerpt?: string | null
  keywords?: string[]
  importance: number
  sourceNote?: string | null
  createdAt: string
}

type KnowledgeStats = Record<string, { count: number; avgImportance: number }>

type QuestionBankStats = {
  total: number
  pending: number
  approved: number
  rejected: number
  byDifficulty?: Record<string, number>
  byType?: Record<string, number>
}

interface QuestionBankItemRow {
  id: string
  type: string
  text: string
  options?: string | null
  correctAnswer?: string | null
  modelAnswer?: string | null
  sourceEvidence?: string | null
  difficulty?: string | null
  status: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'ARCHIVED'
}

interface ExamImportQuestionRow {
  id: string
  order: number
  type: string
  text: string
  options?: string | null
  correctAnswer?: string | null
  modelAnswer?: string | null
  difficulty?: string | null
}

interface ExamImportRow {
  id: string
  title: string
  status: string
  semester: number
  questions: ExamImportQuestionRow[]
}

interface CurriculumUnitReviewItem {
  id: string
  title: string
  summary?: string | null
  objectives: string[]
  content: { heading: string; body: string }[]
  order: number
  semester: number
  status: 'DRAFT' | 'APPROVED' | 'NEEDS_REVISION'
}

interface ProgramReadinessSnapshot {
  registrationStatus: 'OPEN' | 'CLOSED'
  academicReadinessStatus: 'NEEDS_PREPARATION' | 'IN_PREPARATION' | 'READY_FOR_REVIEW' | 'APPROVED'
  academicApproved: boolean
  semestersCount: number
  counts: { books: number; units: number; unitsWithObjectives: number; knowledgeItems: number; exams: number; readyExams: number; assignments: number; assessments: number }
  targets: { books: number; units: number; knowledgeItems: number; assessments: number }
  checks: Record<string, boolean>
  missing: string[]
  readyWithoutManualApproval: boolean
  isCurriculumReady: boolean
}

interface StudyGuideSection {
  title: string
  summary: string
  outcomes?: string[]
  sourceTitles?: string[]
}

interface StudyGuideRow {
  id: string
  programId: string
  semester: number
  title: string
  overview: string
  objectives: string[]
  keyTerms: string[]
  sections: StudyGuideSection[]
  activities: string[]
  discussionQuestions: string[]
  status: string
  updatedAt: string
}

const TYPE_AR: Record<string, string> = { MCQ: 'اختيار', TF: 'صح/خطأ', SHORT: 'إجابة قصيرة', ESSAY: 'مقالي' }
const KNOWLEDGE_CATEGORY_AR: Record<string, string> = {
  CONCEPT: 'مفاهيم',
  THEORY: 'نظريات وأطر',
  METHOD: 'منهجيات وأساليب',
  CASE: 'حالات تطبيقية',
  DEFINITION: 'تعريفات',
  QUESTION_SEED: 'بذور أسئلة',
  SUMMARY: 'ملخصات محورية',
}
const knowledgeCategoryLabel = (category: string) => KNOWLEDGE_CATEGORY_AR[String(category || '').toUpperCase()] || category
const ASSIGNMENT_TYPE_AR: Record<string, string> = {
  REPORT: 'تقرير تحليلي',
  CASE_STUDY: 'دراسة حالة',
  SUMMARY: 'تلخيص/خريطة مفاهيم',
  PROJECT: 'مشروع تطبيقي',
  REFLECTION: 'تأمل مهني',
}
const assignmentTypeLabel = (type: string) => ASSIGNMENT_TYPE_AR[String(type || '').toUpperCase()] || type
const CAT_AR: Record<string, string> = { DOCTORATE: 'الدكتوراه المهنية', MASTERS: 'الماجستير المهني', DIPLOMA: 'الدبلومات المهنية', INTL_CERT: 'الشهادات الدولية', ACCREDITATION: 'اعتماد' }
const CAT_ORDER = ['MASTERS', 'DOCTORATE', 'DIPLOMA', 'INTL_CERT', 'ACCREDITATION']
const LINK_READ_META: Record<string, { label: string; cls: string }> = {
  FILE_UPLOADED: { label: 'ملف محفوظ', cls: 'bg-blue-100 text-blue-700' },
  FILE_EXTRACTED: { label: 'مقروء من ملف', cls: 'bg-emerald-100 text-emerald-700' },
  TEXT_EXTRACTED: { label: 'مقروء من رابط مباشر', cls: 'bg-emerald-100 text-emerald-700' },
  SEARCH_LINK_ONLY: { label: 'رابط بحث فقط', cls: 'bg-amber-100 text-amber-700' },
  FAILED: { label: 'لم يُقرأ آلياً', cls: 'bg-red-100 text-red-700' },
  UNSUPPORTED: { label: 'نوع غير مدعوم', cls: 'bg-red-100 text-red-700' },
  NOT_ATTEMPTED: { label: 'لم تُجر قراءة', cls: 'bg-slate-100 text-slate-600' },
}
const SUGGESTION_LINK_META: Record<string, { label: string; cls: string }> = {
  DIRECT_READABLE: { label: 'رابط قراءة مباشر', cls: 'bg-emerald-100 text-emerald-700' },
  UNKNOWN: { label: 'سيُختبر عند الإضافة', cls: 'bg-blue-100 text-blue-700' },
  CATALOG_SEARCH: { label: 'رابط تحقق فقط', cls: 'bg-amber-100 text-amber-700' },
  MISSING_DIRECT_LINK: { label: 'بلا رابط مباشر', cls: 'bg-red-100 text-red-700' },
}

function isCatalogLikeUiLink(raw?: string | null): boolean {
  if (!raw) return false
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase()
    const path = u.pathname.toLowerCase()
    const query = u.search.toLowerCase()
    return host === 'books.google.com' || host.startsWith('books.google.') ||
      ((host === 'google.com' || host.endsWith('.google.com')) && (path.includes('/books') || path.includes('/search') || query.includes('q=') || query.includes('tbm=bks'))) ||
      host.includes('goodreads.com') || host.includes('worldcat.org') ||
      (host.includes('openlibrary.org') && (path.includes('/search') || query.includes('q=')))
  } catch {
    return false
  }
}

function bookNeedsReadableSource(book: BookRow): boolean {
  const status = book.linkReadStatus || 'NOT_ATTEMPTED'
  const alreadyReadable = status === 'FILE_UPLOADED' || status === 'FILE_EXTRACTED' || status === 'TEXT_EXTRACTED' || !!book.hasFile
  if (alreadyReadable) return false
  return status === 'SEARCH_LINK_ONLY' || status === 'FAILED' || status === 'UNSUPPORTED' || status === 'NOT_ATTEMPTED' || (!!book.link && isCatalogLikeUiLink(book.link))
}

export function AdminBooksTab() {
  const { toast } = useToast()
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [programId, setProgramId] = useState<string>('')
  const [workspaceTab, setWorkspaceTab] = useState('overview')
  const [booksSubTab, setBooksSubTab] = useState('current')
  const [books, setBooks] = useState<BookRow[]>([])
  const [exams, setExams] = useState<ExamRow[]>([])
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [assignmentSuggestions, setAssignmentSuggestions] = useState<AssignmentSuggestion[]>([])
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItemRow[]>([])
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>({})
  const [programReadiness, setProgramReadiness] = useState<ProgramReadinessSnapshot | null>(null)
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [curriculumUnits, setCurriculumUnits] = useState<CurriculumUnitReviewItem[]>([])
  const [unitBusyId, setUnitBusyId] = useState<string | null>(null)
  const [questionBankStats, setQuestionBankStats] = useState<QuestionBankStats | null>(null)
  const [questionBankItems, setQuestionBankItems] = useState<QuestionBankItemRow[]>([])
  const [questionBankBusy, setQuestionBankBusy] = useState<string | null>(null)
  const [questionBankOpen, setQuestionBankOpen] = useState(false)
  const [questionBankFilter, setQuestionBankFilter] = useState({ search: '', status: 'ALL', type: 'ALL', difficulty: 'ALL' })
  const [editingBankQuestion, setEditingBankQuestion] = useState<QuestionBankItemRow | null>(null)
  const [editingBankQuestionForm, setEditingBankQuestionForm] = useState({ type: 'MCQ', text: '', options: '', correctAnswer: '0', modelAnswer: '', sourceEvidence: '', difficulty: 'MEDIUM' })
  const [examImportOpen, setExamImportOpen] = useState(false)
  const [examImportItems, setExamImportItems] = useState<ExamImportRow[]>([])
  const [selectedImportExamId, setSelectedImportExamId] = useState('')
  const [selectedImportQuestionIds, setSelectedImportQuestionIds] = useState<string[]>([])
  const [examImportApproveNow, setExamImportApproveNow] = useState(false)
  const [manualQuestionOpen, setManualQuestionOpen] = useState(false)
  const [manualQuestion, setManualQuestion] = useState({ type: 'MCQ', text: '', options: 'خيار أول\nخيار ثان\nخيار ثالث\nخيار رابع', correctAnswer: '0', modelAnswer: '', difficulty: 'MEDIUM', sourceEvidence: '', approveNow: false })
  const [importQuestionsOpen, setImportQuestionsOpen] = useState(false)
  const [importQuestionsText, setImportQuestionsText] = useState('')
  const [importApproveNow, setImportApproveNow] = useState(false)
  const [bankExamDialogOpen, setBankExamDialogOpen] = useState(false)
  const [bankExamUnits, setBankExamUnits] = useState<{ id: string; title: string; order: number }[]>([])
  const [bankExamForm, setBankExamForm] = useState({
    semester: '1', count: '30', unitId: '', easy: '25', medium: '50', advanced: '25', mcq: '50', tf: '20', short: '20', essay: '10',
  })
  const [studyGuides, setStudyGuides] = useState<StudyGuideRow[]>([])
  const [generatingGuideSemester, setGeneratingGuideSemester] = useState<string | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [adding, setAdding] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [suggestingAssignments, setSuggestingAssignments] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [stoppingExamId, setStoppingExamId] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', titleEn: '', author: '', year: '', description: '', semester: '', link: '' })
  const [assignmentForm, setAssignmentForm] = useState({ id: '', title: '', description: '', semester: '1', type: 'REPORT', points: '10', weight: '0', dueDays: '', rubric: '', status: 'PUBLISHED' })
  const [savingAssignment, setSavingAssignment] = useState(false)
  const [gradingSubmissionId, setGradingSubmissionId] = useState<string | null>(null)
  const [gradingStatusFilter, setGradingStatusFilter] = useState('PENDING')
  const [gradingSemesterFilter, setGradingSemesterFilter] = useState('ALL')
  const [gradingSearch, setGradingSearch] = useState('')
  const [gradingDialog, setGradingDialog] = useState<null | { mode: 'GRADE' | 'REVISION'; submission: AssignmentSubmissionRow; assignment: AssignmentRow; score: string; feedback: string }>(null)
  const [confirmDialog, setConfirmDialog] = useState<null | { title: string; description: string; confirmLabel?: string; danger?: boolean }>(null)
  const confirmResolveRef = useRef<((ok: boolean) => void) | null>(null)
  const [rebuildingKnowledge, setRebuildingKnowledge] = useState(false)
  const [sanitizingKnowledge, setSanitizingKnowledge] = useState(false)
  const [rebuildingBookId, setRebuildingBookId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [bookUploadProgress, setBookUploadProgress] = useState<number | null>(null)
  const [sourceLinks, setSourceLinks] = useState<Record<string, string>>({})
  const [sourceFiles, setSourceFiles] = useState<Record<string, File | null>>({})
  const [updatingSourceBookId, setUpdatingSourceBookId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const advanceRef = useRef(false)
  const [genSemester, setGenSemester] = useState('1')
  const [reviewingExam, setReviewingExam] = useState<{ id: string; title: string } | null>(null)

  const askAdminConfirm = useCallback((dialog: { title: string; description: string; confirmLabel?: string; danger?: boolean }) => {
    return new Promise<boolean>((resolve) => {
      confirmResolveRef.current = resolve
      setConfirmDialog(dialog)
    })
  }, [])

  const closeAdminConfirm = (ok: boolean) => {
    confirmResolveRef.current?.(ok)
    confirmResolveRef.current = null
    setConfirmDialog(null)
  }

  useEffect(() => {
    api<{ programs: ProgramOption[] }>('/api/programs?summary=1&public=1')
      .then((d) => setPrograms(d.programs))
      .catch(() => {})
      .finally(() => setLoading(false))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail
      if (!detail?.programId) return
      const target = programs.find((p) => p.id === detail.programId)
      if (target?.category) setSelectedCategory(target.category)
      setProgramId(detail.programId)
      const section = String(detail.section || 'overview')
      setWorkspaceTab(section === 'add' ? 'books' : section)
      if (section === 'books' || detail.subSection) setBooksSubTab(String(detail.subSection || 'current'))
      if (section === 'knowledge') setBooksSubTab('current')
      window.setTimeout(() => document.getElementById('admin-books-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
    }
    window.addEventListener('aact-admin-books-target', handler as EventListener)
    return () => window.removeEventListener('aact-admin-books-target', handler as EventListener)
  }, [programs])

  const availableCategories = useMemo(() => {
    const set = new Set(programs.map((p) => p.category).filter(Boolean))
    return CAT_ORDER.filter((c) => set.has(c)).concat([...set].filter((c) => !CAT_ORDER.includes(c)))
  }, [programs])

  const filteredPrograms = useMemo(
    () => selectedCategory ? programs.filter((p) => p.category === selectedCategory) : [],
    [programs, selectedCategory]
  )

  const selectedProgram = useMemo(
    () => programs.find((p) => p.id === programId) || null,
    [programs, programId]
  )

  useEffect(() => {
    if (selectedProgram?.category && selectedCategory !== selectedProgram.category) {
      setSelectedCategory(selectedProgram.category)
    }
  }, [selectedProgram, selectedCategory])

  const displayKnowledgeItems = useMemo(() => {
    return knowledgeItems
      .map((item) => {
        const title = cleanAcademicOutput(item.title, 220)
        const summary = cleanAcademicOutput(item.summary, 1600)
        const excerpt = item.excerpt ? cleanAcademicOutput(item.excerpt, 1200) : null
        const keywords = sanitizeAcademicList(item.keywords || [], [], 10, 60)
        return { ...item, title, summary, excerpt, keywords }
      })
      .filter((item) => item.title && item.summary && !looksLikeBrokenGeneratedArabic(`${item.title}. ${item.summary}`) && (!item.excerpt || !looksLikeBrokenGeneratedArabic(item.excerpt)))
  }, [knowledgeItems])

  const displayKnowledgeStats = useMemo(() => {
    const stats: KnowledgeStats = {}
    for (const item of displayKnowledgeItems) {
      const cur = stats[item.category] || { count: 0, avgImportance: 0 }
      cur.count += 1
      cur.avgImportance += item.importance || 0
      stats[item.category] = cur
    }
    Object.keys(stats).forEach((key) => {
      stats[key].avgImportance = Math.round(stats[key].avgImportance / Math.max(1, stats[key].count))
    })
    return stats
  }, [displayKnowledgeItems])

  const selectedImportExam = useMemo(
    () => examImportItems.find((exam) => exam.id === selectedImportExamId) || null,
    [examImportItems, selectedImportExamId]
  )

  const filteredQuestionBankItems = useMemo(() => {
    const search = questionBankFilter.search.trim().toLowerCase()
    return questionBankItems.filter((q) => {
      const statusOk = questionBankFilter.status === 'ALL' || q.status === questionBankFilter.status
      const typeOk = questionBankFilter.type === 'ALL' || q.type === questionBankFilter.type
      const difficultyOk = questionBankFilter.difficulty === 'ALL' || (q.difficulty || 'MEDIUM') === questionBankFilter.difficulty
      const searchOk = !search || `${q.text} ${q.modelAnswer || ''} ${q.sourceEvidence || ''}`.toLowerCase().includes(search)
      return statusOk && typeOk && difficultyOk && searchOk
    })
  }, [questionBankItems, questionBankFilter])

  const displayStudyGuides = useMemo(() => studyGuides.map((guide) => ({
    ...guide,
    title: cleanAcademicOutput(guide.title, 220),
    overview: cleanAcademicOutput(guide.overview, 5000),
    objectives: sanitizeAcademicList(guide.objectives, ['فهم محاور البرنامج وربطها بالتطبيق المهني'], 10, 220),
    keyTerms: sanitizeAcademicLabelList(guide.keyTerms, [], 14, 72),
    activities: sanitizeAcademicList(guide.activities, ['اقرأ المحاور المحددة واكتب ملخصاً تطبيقياً قصيراً.'], 8, 300),
    discussionQuestions: sanitizeAcademicList(guide.discussionQuestions, ['كيف يمكن توظيف هذا المحور في حالة مهنية؟'], 10, 320),
    sections: (guide.sections || []).map((section, i) => ({
      ...section,
      title: conciseAcademicLabel(section.title || `محور دراسي ${i + 1}`, `محور دراسي ${i + 1}`, 120),
      summary: cleanAcademicOutput(section.summary || 'محور منظم من الكتب المقررة.', 1600),
      outcomes: sanitizeAcademicList(section.outcomes || [], ['شرح المحور وربطه بالتطبيق المهني'], 5, 180),
      sourceTitles: sanitizeAcademicList(section.sourceTitles || [], ['بنك المعرفة'], 5, 160),
    })).filter((section) => section.title && section.summary && !looksLikeBrokenGeneratedArabic(`${section.title}. ${section.summary}`)).slice(0, 8),
  })).filter((guide) => guide.title && guide.overview && !looksLikeBrokenGeneratedArabic(`${guide.title}. ${guide.overview}`)), [studyGuides])

  const hiddenKnowledgeItemsCount = Math.max(0, knowledgeItems.length - displayKnowledgeItems.length)
  const hiddenStudyGuidesCount = Math.max(0, studyGuides.length - displayStudyGuides.length)

  const academicPlanPreview = useMemo(() => {
    if (!selectedProgram) return null
    return buildAcademicProgramProfile({
      titleAr: selectedProgram.titleAr,
      titleEn: selectedProgram.titleEn,
      category: selectedProgram.category,
      books: books.map((b) => ({ title: b.title, titleEn: b.titleEn, semester: b.semester })),
      exams: exams.map((e) => ({ title: e.title, semester: e.semester, status: e.status, questionCount: e.questionCount })),
      assignments: assignments.map((a) => ({ title: a.title, semester: a.semester, points: a.points, status: a.status })),
    })
  }, [selectedProgram, books, exams, assignments])

  const gradingQueue = useMemo(() => assignments.flatMap((assignment) => assignment.submissions.map((submission) => ({ assignment, submission }))), [assignments])
  const pendingGradingCount = gradingQueue.filter(({ submission }) => submission.status !== 'GRADED').length
  const gradedCount = gradingQueue.filter(({ submission }) => submission.status === 'GRADED').length
  const revisionCount = gradingQueue.filter(({ submission }) => submission.status === 'NEEDS_REVISION').length
  const filteredGradingQueue = useMemo(() => {
    const q = gradingSearch.trim().toLowerCase()
    return gradingQueue.filter(({ assignment, submission }) => {
      const statusOk = gradingStatusFilter === 'ALL'
        || (gradingStatusFilter === 'PENDING' && submission.status !== 'GRADED')
        || submission.status === gradingStatusFilter
      const semesterOk = gradingSemesterFilter === 'ALL' || String(assignment.semester) === gradingSemesterFilter
      const text = `${assignment.title} ${submission.studentName || ''} ${submission.studentEmail || ''} ${submission.answerText || ''}`.toLowerCase()
      return statusOk && semesterOk && (!q || text.includes(q))
    })
  }, [gradingQueue, gradingSearch, gradingSemesterFilter, gradingStatusFilter])

  const loadProgramData = useCallback(async (pid: string, silent = false) => {
    if (!pid) return
    if (!silent) setLoadingBooks(true)
    try {
      const [b, e, a, k, readiness, units, qb, g] = await Promise.all([
        api<{ books: BookRow[] }>(`/api/admin/books?programId=${pid}`),
        api<{ exams: ExamRow[] }>(`/api/admin/program-exams?programId=${pid}`),
        api<{ assignments: AssignmentRow[] }>(`/api/admin/assignments?programId=${pid}`),
        api<{ items: KnowledgeItemRow[]; stats: KnowledgeStats }>(`/api/admin/knowledge-bank?programId=${pid}`).catch(() => ({ items: [] as KnowledgeItemRow[], stats: {} as KnowledgeStats })),
        api<{ item: ProgramReadinessSnapshot }>(`/api/admin/program-readiness?programId=${pid}`).catch(() => ({ item: null as any })),
        api<{ units: CurriculumUnitReviewItem[] }>(`/api/admin/program-units?programId=${pid}`).catch(() => ({ units: [] as CurriculumUnitReviewItem[] })),
        api<{ items: QuestionBankItemRow[]; stats: QuestionBankStats }>(`/api/admin/question-bank?programId=${pid}`).catch(() => ({ items: [] as QuestionBankItemRow[], stats: null as any })),
        api<{ guides: StudyGuideRow[] }>(`/api/admin/study-guides?programId=${pid}`).catch(() => ({ guides: [] as StudyGuideRow[] })),
      ])
      setBooks(b.books)
      setExams(e.exams)
      setAssignments(a.assignments)
      setKnowledgeItems(k.items || [])
      setKnowledgeStats(k.stats || {})
      setProgramReadiness(readiness.item || null)
      setCurriculumUnits(units.units || [])
      setQuestionBankItems(qb.items || [])
      setQuestionBankStats(qb.stats || null)
      setStudyGuides(g.guides || [])
    } catch (err: any) {
      if (!silent) toast({ title: 'خطأ', description: err.message, variant: 'destructive' })
    } finally {
      if (!silent) setLoadingBooks(false)
    }
  }, [toast])

  // استطلاع دوري أثناء وجود اختبار قيد التوليد
  useEffect(() => {
    const anyGenerating = exams.some((e) => e.status === 'GENERATING')
    if (anyGenerating && programId && !pollRef.current) {
      pollRef.current = setInterval(() => loadProgramData(programId, true), 5000)
    } else if (!anyGenerating && pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
      // تحديث نهائي بعد اكتمال التوليد
      if (programId) loadProgramData(programId, true)
    }
  }, [exams, programId, loadProgramData])

  // تحريك التوليد تلقائياً دفعة بعد دفعة طالما الإدارة فاتحة الصفحة.
  // هذا يلغي الاعتماد على خلفية Vercel التي كانت تسبب بقاء الامتحان على 20 سؤالاً فقط.
  useEffect(() => {
    if (!programId || advanceRef.current || stoppingExamId) return
    const generatingExam = exams.find((e) => e.status === 'GENERATING')
    if (!generatingExam) return

    const timer = setTimeout(async () => {
      if (advanceRef.current) return
      advanceRef.current = true
      try {
        const d = await api<{ status?: string; questionCount?: number; inserted?: number; done?: boolean }>('/api/admin/program-exams/generate', {
          method: 'POST',
          body: JSON.stringify({ examId: generatingExam.id, action: 'kick' }),
        })
        await loadProgramData(programId, true)
        if (d.done || d.status === 'REVIEW') {
          toast({ title: 'اكتمل توليد الامتحان', description: `تم إنشاء ${d.questionCount || generatingExam.questionCount} سؤالاً وتحويلها إلى مراجعة الإدارة` })
        }
      } catch (err: any) {
        await loadProgramData(programId, true)
        // لا نزعج الإدارة بتوست كل عدة ثوانٍ؛ تظهر التفاصيل داخل بطاقة الامتحان.
        console.error('auto exam generation step failed:', err)
      } finally {
        advanceRef.current = false
      }
    // يجب أن يكون أقل من فترة الاستطلاع 5 ثوانٍ؛ وإلا كان الاستطلاع يلغي المؤقت قبل تنفيذ دفعة جديدة فيتوقف الامتحان عند 40 سؤالاً.
    }, generatingExam.questionCount === 0 ? 1200 : 2200)

    return () => clearTimeout(timer)
  }, [exams, programId, stoppingExamId, loadProgramData, toast])

  const addBook = async (payload?: Partial<Suggestion>) => {
    if (!programId) return
    const title = payload?.title ?? form.title
    if (!title.trim()) {
      toast({ title: 'تنبيه', description: 'اكتب اسم الكتاب أولاً', variant: 'destructive' })
      return
    }
    const selectedFile = !payload ? file : null
    if (selectedFile && selectedFile.size > MAX_BOOK_FILE_SIZE) {
      toast({ title: 'حجم الملف كبير', description: 'الحد الحالي لملف الكتاب 10 ميجابايت.', variant: 'destructive' })
      return
    }
    const shouldChunkUpload = !!selectedFile && selectedFile.size > DIRECT_BOOK_UPLOAD_LIMIT
    setAdding(true)
    setBookUploadProgress(shouldChunkUpload ? 1 : null)
    try {
      const fd = new FormData()
      fd.append('programId', programId)
      fd.append('title', title)
      fd.append('titleEn', payload?.titleEn ?? form.titleEn)
      fd.append('author', payload?.author ?? form.author)
      fd.append('year', payload?.year ?? form.year)
      fd.append('description', payload?.reason ?? form.description)
      fd.append('semester', payload ? String(payload.semester || '') : form.semester)
      fd.append('link', payload ? payload.link || '' : form.link)
      fd.append('levelPolicy', payload?.levelPolicy || '')
      fd.append('readingDepth', payload?.readingDepth || '')
      fd.append('assessmentOrientation', payload?.assessmentOrientation || '')
      fd.append('source', payload ? 'AI' : 'ADMIN')
      if (selectedFile && !shouldChunkUpload) fd.append('file', selectedFile)
      const d = await api<{ book: BookRow; textExtracted: boolean; linkReadStatus?: string; linkNote?: string | null; knowledgeItemsInserted?: number }>('/api/admin/books', { method: 'POST', body: fd })

      let finalBook: BookRow = d.book
      let finalStatus = d.linkReadStatus
      if (selectedFile && shouldChunkUpload) {
        finalBook = await uploadBookFileInChunks(d.book.id, selectedFile, setBookUploadProgress)
        finalStatus = finalBook.linkReadStatus || 'FILE_UPLOADED'
      }

      setBooks((prev) => [...prev, { ...finalBook, hasFile: !!finalBook.fileName, source: finalBook.source || 'ADMIN' }])
      if (!payload) {
        setForm({ title: '', titleEn: '', author: '', year: '', description: '', semester: '', link: '' })
        setFile(null)
        if (fileRef.current) fileRef.current.value = ''
      }
      await loadProgramData(programId, true)
      toast({
        title: 'تمت إضافة الكتاب',
        description: payload && !payload.link
          ? 'أُضيف الكتاب المقترح كمرجع مقرر دون رابط قراءة مباشر. لن يدخل بنك المعرفة أو الامتحانات حتى ترفع ملفه أو تضيف رابط PDF/TXT/HTML مفتوح.'
          : finalStatus === 'SEARCH_LINK_ONLY'
          ? 'أُضيف الرابط كفهرس/بحث فقط. لكي يقرأه المشرف والامتحانات فعلياً ارفع ملف الكتاب أو ضع رابط PDF/نص مباشر.'
          : finalStatus === 'FILE_UPLOADED'
          ? 'تم حفظ ملف الكتاب. اضغط بناء/تحديث بنك المعرفة ليبدأ التحليل والاستخراج.'
          : d.knowledgeItemsInserted && (finalStatus === 'FILE_EXTRACTED' || finalStatus === 'TEXT_EXTRACTED')
            ? `تمت قراءة الكتاب وبناء ${d.knowledgeItemsInserted} عنصر معرفة للامتحانات والمشرف الذكي`
            : d.textExtracted
              ? 'تمت قراءة محتوى الملف/الرابط — ويمكنك تحديث بنك المعرفة عند الحاجة'
              : d.linkNote || 'أُضيف إلى الكتب المقررة للتخصص',
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setAdding(false)
      setBookUploadProgress(null)
    }
  }

  const updateBookSource = async (book: BookRow) => {
    const link = (sourceLinks[book.id] || '').trim()
    const selectedFile = sourceFiles[book.id]
    if (!link && !selectedFile) {
      toast({ title: 'مصدر القراءة مطلوب', description: 'ارفع ملف الكتاب أو أدخل رابط PDF/TXT/HTML رسمي مفتوح.', variant: 'destructive' })
      return
    }
    if (selectedFile && selectedFile.size > MAX_BOOK_FILE_SIZE) {
      toast({ title: 'حجم الملف كبير', description: 'الحد الحالي لملف الكتاب 10 ميجابايت.', variant: 'destructive' })
      return
    }
    const shouldChunkUpload = !!selectedFile && selectedFile.size > DIRECT_BOOK_UPLOAD_LIMIT
    setUpdatingSourceBookId(book.id)
    setBookUploadProgress(shouldChunkUpload ? 1 : null)
    try {
      let d: { book: BookRow; textExtracted: boolean; linkReadStatus?: string; linkNote?: string | null; knowledgeItemsInserted?: number } = {
        book,
        textExtracted: false,
        linkReadStatus: book.linkReadStatus || 'NOT_ATTEMPTED',
        linkNote: book.linkReadNote || null,
        knowledgeItemsInserted: 0,
      }

      if (link || (selectedFile && !shouldChunkUpload)) {
        const fd = new FormData()
        fd.append('bookId', book.id)
        if (link) fd.append('link', link)
        if (selectedFile && !shouldChunkUpload) fd.append('file', selectedFile)
        d = await api<{ book: BookRow; textExtracted: boolean; linkReadStatus?: string; linkNote?: string | null; knowledgeItemsInserted?: number }>('/api/admin/books', { method: 'PATCH', body: fd })
      }

      if (selectedFile && shouldChunkUpload) {
        const uploadedBook = await uploadBookFileInChunks(book.id, selectedFile, setBookUploadProgress)
        d = { ...d, book: { ...d.book, ...uploadedBook }, linkReadStatus: uploadedBook.linkReadStatus || 'FILE_UPLOADED', linkNote: uploadedBook.linkReadNote || d.linkNote }
      }

      setBooks((prev) => prev.map((b) => b.id === book.id ? { ...b, ...d.book, hasFile: !!d.book.fileName } : b))
      setSourceLinks((prev) => ({ ...prev, [book.id]: '' }))
      setSourceFiles((prev) => ({ ...prev, [book.id]: null }))
      await loadProgramData(programId, true)
      toast({
        title: d.linkReadStatus === 'FILE_UPLOADED' ? 'تم حفظ ملف الكتاب' : d.textExtracted ? 'تمت قراءة الكتاب وتحديث بنك المعرفة' : 'تم تحديث مصدر الكتاب',
        description: d.knowledgeItemsInserted
          ? `استخرج النظام النص وبنى ${d.knowledgeItemsInserted} عنصر معرفة جديداً.`
          : d.linkReadStatus === 'FILE_UPLOADED'
            ? 'تم حفظ الملف. اضغط بناء/تحديث بنك المعرفة ليتم التحليل والاستخراج دون تعطيل الرفع.'
            : d.linkReadStatus === 'SEARCH_LINK_ONLY'
              ? 'الرابط المضاف ما زال رابط معاينة/فهرس، ولن يستخدمه بنك المعرفة حتى ترفع ملفاً أو رابطاً مباشراً.'
              : d.linkNote || 'تم حفظ المصدر، ويمكنك مراجعة حالة القراءة داخل بطاقة الكتاب.',
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setUpdatingSourceBookId(null)
      setBookUploadProgress(null)
    }
  }

  const deleteBook = async (id: string) => {
    if (!(await askAdminConfirm({ title: 'حذف كتاب مقرر', description: 'سيتم حذف هذا الكتاب من الكتب المقررة وإزالة عناصر المعرفة المرتبطة به من واجهة البرنامج.', confirmLabel: 'حذف الكتاب', danger: true }))) return
    try {
      await api(`/api/admin/books?bookId=${id}`, { method: 'DELETE' })
      setBooks((prev) => prev.filter((b) => b.id !== id))
      setKnowledgeItems((prev) => prev.filter((k) => k.bookId !== id))
      if (programId) await loadProgramData(programId, true)
      toast({ title: 'تم الحذف' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const rebuildKnowledge = async () => {
    if (!programId) return
    setRebuildingKnowledge(true)
    try {
      const d = await api<{ count: number; items: KnowledgeItemRow[]; stats: KnowledgeStats; result?: { totalInserted?: number; results?: { sourceNote?: string; inserted?: number }[] } }>('/api/admin/knowledge-bank', {
        method: 'POST',
        body: JSON.stringify({ programId, action: 'rebuild' }),
      })
      setKnowledgeItems(d.items || [])
      setKnowledgeStats(d.stats || {})
      const firstNote = d.result?.results?.find((r) => r.sourceNote)?.sourceNote
      toast({ title: 'تم بناء بنك المعرفة', description: firstNote || `بنى النظام ${d.result?.totalInserted || d.count || 0} عنصر معرفة من الكتب المقررة` })
    } catch (e: any) {
      toast({ title: 'تعذر بناء بنك المعرفة', description: e.message, variant: 'destructive' })
    } finally {
      setRebuildingKnowledge(false)
    }
  }

  const sanitizeKnowledge = async () => {
    if (!programId) return
    setSanitizingKnowledge(true)
    try {
      const d = await api<{ count: number; items: KnowledgeItemRow[]; stats: KnowledgeStats; deleted?: number; updated?: number }>('/api/admin/knowledge-bank', {
        method: 'POST',
        body: JSON.stringify({ programId, action: 'sanitize' }),
      })
      setKnowledgeItems(d.items || [])
      setKnowledgeStats(d.stats || {})
      toast({ title: 'تم تنظيف بنك المعرفة', description: `حُذف ${d.deleted || 0} عنصر مشوه، وتحدّث ${d.updated || 0} عنصر. العناصر النظيفة الآن: ${d.count || 0}` })
    } catch (e: any) {
      toast({ title: 'تعذر تنظيف بنك المعرفة', description: e.message, variant: 'destructive' })
    } finally {
      setSanitizingKnowledge(false)
    }
  }

  const refreshCurriculumUnits = async (pid = programId) => {
    if (!pid) return
    const res = await api<{ units: CurriculumUnitReviewItem[] }>(`/api/admin/program-units?programId=${pid}`)
    setCurriculumUnits(res.units || [])
  }

  const patchCurriculumUnit = async (unit: CurriculumUnitReviewItem, data: Partial<CurriculumUnitReviewItem>) => {
    if (!programId) return
    setUnitBusyId(unit.id)
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>('/api/admin/program-units', {
        method: 'PATCH',
        body: JSON.stringify({ programId, unitId: unit.id, ...data }),
      })
      setCurriculumUnits(res.units || [])
      await refreshProgramReadiness()
    } catch (e: any) {
      toast({ title: 'تعذر تعديل الوحدة', description: e.message, variant: 'destructive' })
    } finally {
      setUnitBusyId(null)
    }
  }

  const addCurriculumUnit = async () => {
    if (!programId) return
    setUnitBusyId('new')
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>('/api/admin/program-units', {
        method: 'POST',
        body: JSON.stringify({
          programId,
          semester: 1,
          status: 'DRAFT',
          title: 'وحدة جديدة قابلة للمراجعة',
          summary: 'أضف ملخص الوحدة هنا.',
          objectives: ['هدف تعلم قابل للقياس'],
          content: [{ heading: 'محتوى الوحدة', body: 'أضف محاور ومحتوى الوحدة هنا.' }],
        }),
      })
      setCurriculumUnits(res.units || [])
      await refreshProgramReadiness()
    } catch (e: any) {
      toast({ title: 'تعذر إضافة الوحدة', description: e.message, variant: 'destructive' })
    } finally {
      setUnitBusyId(null)
    }
  }

  const deleteCurriculumUnit = async (unitId: string) => {
    if (!programId || !(await askAdminConfirm({ title: 'حذف وحدة من المنهج', description: 'سيتم حذف هذه الوحدة من خطة المنهج لهذا التخصص. يمكن إعادة توليد الوحدات لاحقاً من الكتب.', confirmLabel: 'حذف الوحدة', danger: true }))) return
    setUnitBusyId(unitId)
    try {
      const res = await api<{ units: CurriculumUnitReviewItem[] }>(`/api/admin/program-units?programId=${programId}&unitId=${unitId}`, { method: 'DELETE' })
      setCurriculumUnits(res.units || [])
      await refreshProgramReadiness()
    } catch (e: any) {
      toast({ title: 'تعذر حذف الوحدة', description: e.message, variant: 'destructive' })
    } finally {
      setUnitBusyId(null)
    }
  }

  const refreshQuestionBank = async (pid = programId) => {
    if (!pid) return
    const res = await api<{ items: QuestionBankItemRow[]; stats: QuestionBankStats }>(`/api/admin/question-bank?programId=${pid}`)
    setQuestionBankItems(res.items || [])
    setQuestionBankStats(res.stats || null)
  }

  const refreshProgramReadiness = async () => {
    if (!programId) return
    setReadinessLoading(true)
    try {
      const res = await api<{ item: ProgramReadinessSnapshot }>(`/api/admin/program-readiness?programId=${programId}`)
      setProgramReadiness(res.item || null)
    } catch (e: any) {
      toast({ title: 'تعذر تحديث جاهزية البرنامج', description: e.message, variant: 'destructive' })
    } finally {
      setReadinessLoading(false)
    }
  }

  const generateQuestionsForBank = async () => {
    if (!programId) return
    setQuestionBankBusy('generate')
    try {
      const res = await api<{ items: QuestionBankItemRow[]; stats: QuestionBankStats }>('/api/admin/question-bank', {
        method: 'POST',
        body: JSON.stringify({ programId, count: 12 }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
      toast({ title: 'تم توليد أسئلة للبنك', description: 'تمت إضافة أسئلة بانتظار المراجعة من بنك المعرفة.' })
    } catch (e: any) {
      toast({ title: 'تعذر توليد أسئلة للبنك', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const addManualQuestionToBank = async () => {
    if (!programId) return
    setQuestionBankBusy('manual')
    try {
      const res = await api<{ items: QuestionBankItemRow[]; stats: QuestionBankStats }>('/api/admin/question-bank', {
        method: 'POST',
        body: JSON.stringify({
          programId,
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
      toast({ title: 'تم حفظ السؤال في بنك الأسئلة' })
    } catch (e: any) {
      toast({ title: 'تعذر حفظ السؤال', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const importQuestionsToBank = async () => {
    if (!programId) return
    setQuestionBankBusy('import')
    try {
      const res = await api<{ items: QuestionBankItemRow[]; stats: QuestionBankStats }>('/api/admin/question-bank', {
        method: 'POST',
        body: JSON.stringify({ programId, source: 'IMPORT', text: importQuestionsText, approveNow: importApproveNow }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
      setImportQuestionsOpen(false)
      setImportQuestionsText('')
      toast({ title: 'تم استيراد الأسئلة إلى البنك' })
    } catch (e: any) {
      toast({ title: 'تعذر استيراد الأسئلة', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const openExamImport = async () => {
    if (!programId) return
    setExamImportOpen(true)
    setQuestionBankBusy('exam-load')
    try {
      const res = await api<{ exams: ExamImportRow[] }>(`/api/admin/question-bank/from-exam?programId=${programId}`)
      setExamImportItems(res.exams || [])
      const first = (res.exams || []).find((exam) => exam.questions?.length)
      setSelectedImportExamId(first?.id || '')
      setSelectedImportQuestionIds(first?.questions?.map((q) => q.id) || [])
    } catch (e: any) {
      toast({ title: 'تعذر تحميل أسئلة الاختبارات', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const copyExamQuestionsToBank = async () => {
    if (!programId || !selectedImportExamId || selectedImportQuestionIds.length === 0) return
    setQuestionBankBusy('exam-copy')
    try {
      const res = await api<{ items: QuestionBankItemRow[]; stats: QuestionBankStats }>('/api/admin/question-bank/from-exam', {
        method: 'POST',
        body: JSON.stringify({ programId, examId: selectedImportExamId, questionIds: selectedImportQuestionIds, approveNow: examImportApproveNow }),
      })
      setQuestionBankItems(res.items || [])
      setQuestionBankStats(res.stats || null)
      setExamImportOpen(false)
      toast({ title: 'تم نسخ أسئلة الاختبار إلى بنك الأسئلة' })
    } catch (e: any) {
      toast({ title: 'تعذر نسخ الأسئلة', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const updateQuestionBankStatus = async (id: string, status: QuestionBankItemRow['status']) => {
    setQuestionBankBusy(id)
    try {
      const res = await api<{ item: QuestionBankItemRow }>('/api/admin/question-bank', { method: 'PATCH', body: JSON.stringify({ id, status }) })
      setQuestionBankItems((prev) => prev.map((q) => q.id === id ? res.item : q))
      if (programId) await refreshQuestionBank(programId)
    } catch (e: any) {
      toast({ title: 'تعذر تحديث حالة السؤال', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const openEditBankQuestion = (q: QuestionBankItemRow) => {
    let options: string[] = []
    try { options = q.options ? JSON.parse(q.options) : [] } catch {}
    setEditingBankQuestion(q)
    setEditingBankQuestionForm({
      type: q.type || 'MCQ',
      text: q.text || '',
      options: options.join('\n'),
      correctAnswer: q.correctAnswer || '0',
      modelAnswer: q.modelAnswer || '',
      sourceEvidence: q.sourceEvidence || '',
      difficulty: q.difficulty || 'MEDIUM',
    })
  }

  const saveEditedBankQuestion = async () => {
    if (!editingBankQuestion) return
    setQuestionBankBusy(editingBankQuestion.id)
    try {
      const res = await api<{ item: QuestionBankItemRow }>('/api/admin/question-bank', {
        method: 'PATCH',
        body: JSON.stringify({
          id: editingBankQuestion.id,
          type: editingBankQuestionForm.type,
          text: editingBankQuestionForm.text,
          options: editingBankQuestionForm.options.split('\n').map((x) => x.trim()).filter(Boolean),
          correctAnswer: editingBankQuestionForm.correctAnswer,
          modelAnswer: editingBankQuestionForm.modelAnswer,
          sourceEvidence: editingBankQuestionForm.sourceEvidence,
          difficulty: editingBankQuestionForm.difficulty,
        }),
      })
      setQuestionBankItems((prev) => prev.map((q) => q.id === editingBankQuestion.id ? res.item : q))
      setEditingBankQuestion(null)
      toast({ title: 'تم تعديل السؤال' })
      if (programId) await refreshQuestionBank(programId)
    } catch (e: any) {
      toast({ title: 'تعذر تعديل السؤال', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const openBankExamDialog = async (semester: number) => {
    if (!programId) return
    setBankExamForm((prev) => ({ ...prev, semester: String(semester), unitId: '' }))
    setBankExamDialogOpen(true)
    setQuestionBankBusy('units-load')
    try {
      const res = await api<{ units: { id: string; title: string; order: number }[] }>(`/api/admin/program-units?programId=${programId}`)
      setBankExamUnits(res.units || [])
    } catch {
      setBankExamUnits([])
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const generateExamFromQuestionBank = async () => {
    if (!programId) return
    const semester = Number(bankExamForm.semester || 1) === 2 ? 2 : 1
    const count = Math.max(5, Math.min(80, Number(bankExamForm.count || 30)))
    const payloadBase = {
      programId,
      semester,
      count,
      unitId: bankExamForm.unitId || null,
      difficultyPlan: {
        EASY: Number(bankExamForm.easy || 25),
        MEDIUM: Number(bankExamForm.medium || 50),
        ADVANCED: Number(bankExamForm.advanced || 25),
      },
      typePlan: {
        MCQ: Number(bankExamForm.mcq || 50),
        TF: Number(bankExamForm.tf || 20),
        SHORT: Number(bankExamForm.short || 20),
        ESSAY: Number(bankExamForm.essay || 10),
      },
    }
    const createExam = (replaceExistingReview = false) => api('/api/admin/program-exams/from-question-bank', { method: 'POST', body: JSON.stringify({ ...payloadBase, replaceExistingReview }) })
    setQuestionBankBusy(`exam-${semester}`)
    try {
      try {
        await createExam(false)
      } catch (e: any) {
        if (String(e?.message || '').includes('بانتظار المراجعة') && await askAdminConfirm({ title: 'استبدال اختبار قيد المراجعة', description: 'يوجد امتحان بانتظار المراجعة لهذا الفصل. هل تريد استبداله وإنشاء نسخة جديدة من بنك الأسئلة؟', confirmLabel: 'استبدال الاختبار', danger: true })) {
          await createExam(true)
        } else {
          throw e
        }
      }
      setBankExamDialogOpen(false)
      setWorkspaceTab('exams')
      await loadProgramData(programId, true)
      toast({ title: 'تم إنشاء امتحان من بنك الأسئلة', description: 'الامتحان الآن بانتظار المراجعة قبل النشر.' })
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء امتحان من البنك', description: e.message, variant: 'destructive' })
    } finally {
      setQuestionBankBusy(null)
    }
  }

  const rebuildBookKnowledge = async (bookId: string) => {
    if (!programId) return
    setRebuildingBookId(bookId)
    try {
      const d = await api<{ count: number; items: KnowledgeItemRow[]; stats: KnowledgeStats; result?: { inserted?: number; sourceNote?: string } }>('/api/admin/knowledge-bank', {
        method: 'POST',
        body: JSON.stringify({ bookId, action: 'rebuild-book' }),
      })
      setKnowledgeItems(d.items || [])
      setKnowledgeStats(d.stats || {})
      toast({ title: 'تم تحليل الكتاب', description: d.result?.sourceNote || `تم استخراج ${d.result?.inserted || 0} عنصر معرفة من هذا الكتاب` })
    } catch (e: any) {
      toast({ title: 'تعذر تحليل الكتاب', description: e.message, variant: 'destructive' })
    } finally {
      setRebuildingBookId(null)
    }
  }

  const generateStudyGuide = async (semester: number) => {
    if (!programId) return
    setGeneratingGuideSemester(String(semester))
    try {
      const d = await api<{ guide: StudyGuideRow }>('/api/admin/study-guides', {
        method: 'POST',
        body: JSON.stringify({ programId, semester, status: 'PUBLISHED' }),
      })
      setStudyGuides((prev) => [d.guide, ...prev.filter((g) => !(g.programId === d.guide.programId && g.semester === d.guide.semester))].sort((a, b) => a.semester - b.semester))
      toast({ title: 'تم توليد دليل الدراسة', description: d.guide.title })
    } catch (e: any) {
      toast({ title: 'تعذر توليد دليل الدراسة', description: e.message, variant: 'destructive' })
    } finally {
      setGeneratingGuideSemester(null)
    }
  }

  const updateStudyGuideStatus = async (guide: StudyGuideRow, status: string) => {
    if (!programId) return
    try {
      const d = await api<{ guide: StudyGuideRow }>('/api/admin/study-guides', {
        method: 'PATCH',
        body: JSON.stringify({ id: guide.id, status }),
      })
      setStudyGuides((prev) => prev.map((g) => g.id === guide.id ? d.guide : g))
      toast({ title: status === 'PUBLISHED' ? 'تم نشر دليل الدراسة' : 'تم تحديث حالة الدليل' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const deleteStudyGuide = async (id: string) => {
    if (!programId || !(await askAdminConfirm({ title: 'حذف دليل الدراسة', description: 'سيتم حذف دليل الدراسة من هذا التخصص. يمكن توليده من جديد لاحقاً من بنك المعرفة.', confirmLabel: 'حذف الدليل', danger: true }))) return
    try {
      await api(`/api/admin/study-guides?id=${id}`, { method: 'DELETE' })
      setStudyGuides((prev) => prev.filter((g) => g.id !== id))
      toast({ title: 'تم حذف دليل الدراسة' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const resetAssignmentForm = () => setAssignmentForm({ id: '', title: '', description: '', semester: '1', type: 'REPORT', points: '10', weight: '0', dueDays: '', rubric: '', status: 'PUBLISHED' })

  const suggestAssignments = async () => {
    if (!programId) return
    const semester = Number(assignmentForm.semester || genSemester || 1) || 1
    setSuggestingAssignments(true)
    setAssignmentSuggestions([])
    try {
      const d = await api<{ suggestions: AssignmentSuggestion[] }>('/api/admin/assignments/suggest', {
        method: 'POST',
        body: JSON.stringify({ programId, semester }),
      })
      setAssignmentSuggestions(d.suggestions || [])
      toast({ title: 'اقتراحات الواجبات جاهزة', description: `تم اقتراح ${d.suggestions?.length || 0} تكليفاً من بنك المعرفة والكتب` })
    } catch (e: any) {
      toast({ title: 'تعذر اقتراح الواجبات', description: e.message, variant: 'destructive' })
    } finally {
      setSuggestingAssignments(false)
    }
  }

  const useAssignmentSuggestionInForm = (s: AssignmentSuggestion) => {
    setAssignmentForm({
      id: '',
      title: s.title,
      description: s.description,
      semester: String(s.semester || 1),
      type: s.type || 'CASE_STUDY',
      points: String(s.points || 15),
      weight: String(s.weight || 0),
      dueDays: String(s.dueDays || ''),
      rubric: s.rubric || '',
      status: 'PUBLISHED',
    })
  }

  const addAssignmentSuggestion = async (s: AssignmentSuggestion) => {
    if (!programId) return
    setSavingAssignment(true)
    try {
      await api('/api/admin/assignments', {
        method: 'POST',
        body: JSON.stringify({
          programId,
          title: s.title,
          description: s.description,
          semester: s.semester,
          type: s.type,
          points: s.points,
          weight: s.weight,
          dueDays: s.dueDays,
          rubric: s.rubric,
          status: 'PUBLISHED',
        }),
      })
      setAssignmentSuggestions((prev) => prev.map((x) => x.title === s.title ? { ...x, added: true } : x))
      await loadProgramData(programId, true)
      toast({ title: 'تم إضافة الواجب المقترح', description: s.title })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSavingAssignment(false)
    }
  }

  const addAllAssignmentSuggestions = async () => {
    const list = assignmentSuggestions.filter((s) => !s.added)
    for (const s of list) await addAssignmentSuggestion(s)
    if (list.length) toast({ title: 'تمت إضافة الواجبات المقترحة' })
  }

  const editAssignment = (a: AssignmentRow) => {
    setAssignmentForm({
      id: a.id,
      title: a.title,
      description: a.description,
      semester: String(a.semester || 1),
      type: a.type || 'REPORT',
      points: String(a.points || 10),
      weight: String(a.weight || 0),
      dueDays: a.dueDays ? String(a.dueDays) : '',
      rubric: a.rubric || '',
      status: a.status || 'PUBLISHED',
    })
  }

  const saveAssignment = async () => {
    if (!programId) return
    if (!assignmentForm.title.trim() || !assignmentForm.description.trim()) {
      toast({ title: 'تنبيه', description: 'اكتب عنوان الواجب ووصفه قبل الحفظ', variant: 'destructive' })
      return
    }
    setSavingAssignment(true)
    try {
      await api('/api/admin/assignments', {
        method: 'POST',
        body: JSON.stringify({ ...assignmentForm, programId }),
      })
      resetAssignmentForm()
      await loadProgramData(programId, true)
      toast({ title: 'تم حفظ الواجب', description: 'ظهر الواجب ضمن خطة الطالب الفصلية ويمكن للطلاب تسليمه من بوابتهم' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSavingAssignment(false)
    }
  }

  const deleteAssignment = async (id: string) => {
    if (!programId || !(await askAdminConfirm({ title: 'حذف واجب وتسليماته', description: 'سيتم حذف هذا الواجب وكل تسليمات الطلاب المرتبطة به. هذا الإجراء نهائي.', confirmLabel: 'حذف الواجب', danger: true }))) return
    try {
      await api(`/api/admin/assignments?id=${id}`, { method: 'DELETE' })
      await loadProgramData(programId, true)
      toast({ title: 'تم حذف الواجب' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const gradeSubmission = (submission: AssignmentSubmissionRow, assignment: AssignmentRow) => {
    setGradingDialog({
      mode: 'GRADE',
      submission,
      assignment,
      score: submission.score != null ? String(submission.score) : '',
      feedback: submission.feedback || '',
    })
  }

  const requestAssignmentRevision = (submission: AssignmentSubmissionRow, assignment?: AssignmentRow) => {
    const ownerAssignment = assignment || assignments.find((a) => a.submissions.some((s) => s.id === submission.id))
    if (!ownerAssignment) return
    setGradingDialog({
      mode: 'REVISION',
      submission,
      assignment: ownerAssignment,
      score: submission.score != null ? String(submission.score) : '',
      feedback: submission.feedback || '',
    })
  }

  const submitGradingDialog = async () => {
    if (!programId || !gradingDialog) return
    const { mode, submission, assignment } = gradingDialog
    const score = mode === 'GRADE' ? Number(gradingDialog.score) : null
    const feedback = gradingDialog.feedback.trim()
    if (mode === 'GRADE' && (!Number.isFinite(score) || score < 0 || score > assignment.points)) {
      toast({ title: 'درجة غير صالحة', description: `أدخل درجة بين 0 و ${assignment.points}.`, variant: 'destructive' })
      return
    }
    if (mode === 'REVISION' && feedback.length < 8) {
      toast({ title: 'ملاحظة التعديل مطلوبة', description: 'اكتب سبباً واضحاً للطالب قبل طلب التعديل.', variant: 'destructive' })
      return
    }
    setGradingSubmissionId(submission.id)
    try {
      await api('/api/admin/assignments', {
        method: 'PATCH',
        body: JSON.stringify({
          submissionId: submission.id,
          score: mode === 'GRADE' ? String(score) : undefined,
          feedback,
          status: mode === 'GRADE' ? 'GRADED' : 'NEEDS_REVISION',
        }),
      })
      await loadProgramData(programId, true)
      toast({ title: mode === 'GRADE' ? 'تم تصحيح الواجب' : 'تم طلب تعديل الواجب', description: mode === 'GRADE' ? `${submission.studentName || 'الطالب'} — ${score}/${assignment.points}` : undefined })
      setGradingDialog(null)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setGradingSubmissionId(null)
    }
  }

  const suggest = async () => {
    if (!programId) return
    setSuggesting(true)
    setSuggestions([])
    try {
      const d = await api<{ suggestions: Suggestion[] }>('/api/admin/books/suggest', {
        method: 'POST',
        body: JSON.stringify({ programId }),
      })
      setSuggestions(d.suggestions)
      const directCount = d.suggestions.filter((s) => s.linkType === 'DIRECT_READABLE' || (s.link && s.linkType !== 'CATALOG_SEARCH')).length
      toast({
        title: 'اقتراحات خبير الذكاء الاصطناعي جاهزة',
        description: `${d.suggestions.length} كتاباً مقترحاً وفق واقع التخصص — ${directCount} منها تحمل رابط قراءة مباشر قابل للاختبار`,
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSuggesting(false)
    }
  }

  const suggestAll = async () => {
    const pending = suggestions.filter((x) => !x.added)
    const withoutDirect = pending.filter((x) => !x.link || x.linkType === 'CATALOG_SEARCH' || x.linkType === 'MISSING_DIRECT_LINK')
    if (withoutDirect.length > 0) {
      const ok = await askAdminConfirm({
        title: 'كتب بلا رابط قراءة مباشر',
        description: `يوجد ${withoutDirect.length} كتاباً بلا رابط قراءة مباشر. ستُضاف كمراجع مقررة فقط ولن تدخل بنك المعرفة أو الامتحانات حتى ترفع ملفاتها أو تضيف روابط PDF/TXT/HTML مفتوحة.`,
        confirmLabel: 'إضافة كمراجع فقط',
      })
      if (!ok) return
    }
    for (const s of pending) {
      await addBook(s)
      setSuggestions((prev) => prev.map((x) => (x.title === s.title ? { ...x, added: true } : x)))
    }
    toast({ title: 'تمت إضافة كل الكتب المقترحة' })
  }

  const generateExam = async () => {
    if (!programId) return
    if (books.length === 0) {
      toast({ title: 'لا يمكن التوليد', description: 'أضف كتباً مقررة للتخصص أولاً — يدوياً أو من اقتراحات خبير الذكاء الاصطناعي', variant: 'destructive' })
      return
    }
    const sem = genSemester === '2' ? 2 : 1
    const semLabel = sem === 2 ? 'الفصل الثاني' : 'الفصل الأول'
    const generatingExam = exams.find((e) => e.semester === sem && e.status === 'GENERATING') || exams.find((e) => e.status === 'GENERATING')
    const failedExam = exams.find((e) => e.semester === sem && e.status === 'FAILED')
    const confirmText = generatingExam
      ? `يوجد امتحان عالق حالياً وفيه ${generatingExam.questionCount} سؤالاً. سأحرك التوليد الآن، وإذا كان صفر أسئلة سيتم إنشاء دفعة أولية فوراً ثم يكمل من حيث توقف. متابعة؟`
      : failedExam
        ? `يوجد امتحان فاشل سابقاً لهذا الفصل وفيه ${failedExam.questionCount} سؤالاً محفوظاً. سيستكمل خبير الذكاء الاصطناعي التوليد من حيث توقف دون حذف الأسئلة السابقة. متابعة؟`
        : `سيولّد خبير الذكاء الاصطناعي امتحان ${semLabel} (${books.length} كتاب مقرر متاح) بعدد كبير من الأسئلة المتنوعة ومدة لا تقل عن ساعتين، ثم تمرّ الأسئلة على مراجعتك قبل النشر. التوليد يستغرق عدة دقائق. متابعة؟`
    if (!(await askAdminConfirm({ title: `توليد امتحان ${semLabel}`, description: confirmText, confirmLabel: 'بدء التوليد' }))) return
    setGenerating(true)
    try {
      const d = await api<{ examId: string; booksCount: number; resumed?: boolean; existingQuestions?: number }>('/api/admin/program-exams/generate', {
        method: 'POST',
        body: JSON.stringify({ programId, semester: sem }),
      })
      toast({
        title: d.resumed ? 'تم استكمال التوليد' : 'بدأ التوليد',
        description: d.resumed
          ? `سيكمل من السؤال ${(d.existingQuestions || failedExam?.questionCount || 0) + 1} دون حذف الأسئلة السابقة — تابع الحالة بالأسفل`
          : `خبير الذكاء الاصطناعي يقرأ ${d.booksCount} كتاباً ويحللها لتوليد أسئلة ${semLabel} — تابع الحالة بالأسفل`,
      })
      await loadProgramData(programId, true)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setGenerating(false)
    }
  }

  const resumeExam = async (exam: ExamRow) => {
    if (!programId) return
    const semLabel = exam.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'
    if (!(await askAdminConfirm({ title: `استكمال توليد ${semLabel}`, description: `سيستكمل خبير الذكاء الاصطناعي التوليد من حيث توقف، وسيحافظ على ${exam.questionCount} سؤالاً موجوداً حالياً.`, confirmLabel: 'استكمال التوليد' }))) return
    setGenerating(true)
    try {
      const d = await api<{ examId: string; booksCount: number; existingQuestions?: number; requiredQuestions?: number; resumed?: boolean }>('/api/admin/program-exams/generate', {
        method: 'POST',
        body: JSON.stringify({ examId: exam.id }),
      })
      toast({
        title: d.resumed ? 'تم استكمال التوليد' : 'بدأ التوليد',
        description: `سيكمل من السؤال ${(d.existingQuestions || exam.questionCount) + 1} دون حذف الأسئلة السابقة — تابع الحالة بالأسفل`,
      })
      await loadProgramData(programId, true)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setGenerating(false)
    }
  }

  const stopExam = async (exam: ExamRow) => {
    if (!programId) return
    const msg = exam.questionCount > 0
      ? `سيتم إيقاف التوليد الآن، وستبقى ${exam.questionCount} سؤالاً محفوظة وتتحول مباشرة إلى مراجعة الإدارة للتعديل/الاعتماد/الحذف. متابعة؟`
      : 'سيتم إيقاف التوليد الآن. لم تُحفظ أي أسئلة بعد، ويمكنك استكماله لاحقاً من زر الاستكمال. متابعة؟'
    if (!confirm(msg)) return
    setStoppingExamId(exam.id)
    try {
      const d = await api<{ ok: boolean; status: string; questionCount: number; totalPoints: number }>('/api/admin/program-exams/generate', {
        method: 'POST',
        body: JSON.stringify({ examId: exam.id, action: 'stop' }),
      })
      toast({
        title: 'تم إيقاف التوليد',
        description: d.questionCount > 0
          ? `تم حفظ ${d.questionCount} سؤالاً وتحويل الامتحان إلى مراجعة الإدارة`
          : 'تم إيقاف التوليد قبل حفظ أي سؤال',
      })
      await loadProgramData(programId, true)
      if (d.questionCount > 0) setReviewingExam({ id: exam.id, title: exam.title })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message || 'تعذر إيقاف التوليد', variant: 'destructive' })
    } finally {
      setStoppingExamId(null)
    }
  }

  const deleteExam = async (id: string) => {
    if (!confirm('حذف هذا الاختبار الشامل وكل أسئلته ومحاولاته؟ هذا الحذف نهائي.')) return
    try {
      await api(`/api/admin/program-exams?id=${id}`, { method: 'DELETE' })
      setExams((prev) => prev.filter((e) => e.id !== id))
      toast({ title: 'تم حذف الاختبار' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const hasGeneratingExam = exams.some((e) => e.status === 'GENERATING')

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
      </div>
    )
  }

  return (
    <div className="mt-4 space-y-5">
      {/* اختيار البرنامج */}
      <Card className="border-[#0f2b46]/10">
        <CardContent className="p-5">
          <Label className="mb-3 block text-xs font-black text-[#0f2b46]">اختر الدرجة ثم التخصص لإدارة الكتب والاختبارات</Label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-[10px] font-black text-slate-500">نوع البرنامج / الدرجة</Label>
              <Select
                value={selectedCategory}
                onValueChange={(v) => {
                  setSelectedCategory(v)
                  setProgramId('')
                  setBooks([])
                  setExams([])
                  setAssignments([])
                  setAssignmentSuggestions([])
                  setKnowledgeItems([])
                  setKnowledgeStats({})
                  setProgramReadiness(null)
                  setCurriculumUnits([])
                  setQuestionBankStats(null)
                  setQuestionBankItems([])
                  setStudyGuides([])
                  setSuggestions([])
                }}
              >
                <SelectTrigger className="h-11 text-sm font-bold">
                  <SelectValue placeholder="اختر: ماجستير / دكتوراه / دبلوم" />
                </SelectTrigger>
                <SelectContent>
                  {availableCategories.map((c) => (
                    <SelectItem key={c} value={c}>{CAT_AR[c] || c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[10px] font-black text-slate-500">
                {selectedCategory === 'MASTERS' || selectedCategory === 'DOCTORATE' ? 'التخصص' : 'البرنامج / الدبلوم'}
              </Label>
              <Select
                value={programId}
                disabled={!selectedCategory}
                onValueChange={(v) => { setProgramId(v); setSuggestions([]); loadProgramData(v) }}
              >
                <SelectTrigger className="h-11 text-sm font-bold">
                  <SelectValue placeholder={selectedCategory ? 'اختر التخصص...' : 'اختر الدرجة أولاً'} />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {filteredPrograms.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {(p.category === 'MASTERS' || p.category === 'DOCTORATE') ? (p.specialty || p.titleAr) : p.titleAr}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          {selectedProgram && (
            <div className="mt-3 rounded-xl border border-[#c9a227]/30 bg-[#f7edd0]/40 p-3 text-[11px] font-bold leading-relaxed text-[#0f2b46]">
              الكتب والامتحانات ستُربط تحديداً بـ «{selectedProgram.titleAr}». عند اقتراح الكتب سيستخدم الذكاء هذا التخصص، وليس برنامجاً عاماً باسم كافة التخصصات.
            </div>
          )}
        </CardContent>
      </Card>

      {programId && (
        <>
        {programReadiness && (
          <Card className="border-emerald-100 bg-emerald-50/40">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-sm font-black text-[#0f2b46]">جاهزية البرنامج الأكاديمية</h2>
                  <p className="mt-1 text-xs font-bold text-slate-500">بطاقة دائمة للبرنامج المحدد، سواء ظهر في مركز الجودة أم كان معتمداً وجاهزاً.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Badge className={programReadiness.isCurriculumReady ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                    {programReadiness.isCurriculumReady ? 'جاهز ومعتمد' : 'يحتاج متابعة'}
                  </Badge>
                  <Badge className={programReadiness.registrationStatus === 'OPEN' ? 'bg-blue-100 text-blue-700 hover:bg-blue-100' : 'bg-slate-100 text-slate-700 hover:bg-slate-100'}>
                    التسجيل: {programReadiness.registrationStatus === 'OPEN' ? 'مفتوح' : 'مغلق'}
                  </Badge>
                  <Button size="sm" variant="outline" disabled={readinessLoading} onClick={refreshProgramReadiness} className="bg-white text-xs font-black">
                    {readinessLoading ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                    تحديث الجاهزية
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600 ring-1 ring-emerald-100">الكتب<br /><span className="text-lg text-[#0f2b46]">{programReadiness.counts.books}/{programReadiness.targets.books}</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600 ring-1 ring-emerald-100">الوحدات<br /><span className="text-lg text-[#0f2b46]">{programReadiness.counts.units}/{programReadiness.targets.units}</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600 ring-1 ring-emerald-100">أهداف الوحدات<br /><span className="text-lg text-[#0f2b46]">{programReadiness.counts.unitsWithObjectives}/{programReadiness.counts.units || 0}</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600 ring-1 ring-emerald-100">بنك المعرفة<br /><span className="text-lg text-[#0f2b46]">{programReadiness.counts.knowledgeItems}</span></div>
                <div className="rounded-xl bg-white p-3 text-xs font-black text-slate-600 ring-1 ring-emerald-100">الاختبارات/الواجبات<br /><span className="text-lg text-[#0f2b46]">{programReadiness.counts.assessments}/{programReadiness.targets.assessments}</span></div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {Object.entries(programReadiness.checks).map(([key, ok]) => (
                  <span key={key} className={`rounded-full px-2 py-1 text-[10px] font-black ${ok ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {ok ? '✓' : '×'} {key === 'description' ? 'الوصف الأكاديمي' : key === 'admissionRules' ? 'قواعد القبول' : key === 'semesters' ? 'عدد الفصول' : key === 'booksPerSemester' ? 'كتاب لكل فصل' : key === 'units' ? 'الوحدات' : key === 'unitObjectives' ? 'أهداف الوحدات' : key === 'knowledge' ? 'بنك المعرفة' : key === 'assessments' ? 'اختبار/واجب' : key === 'manualApproval' ? 'اعتماد الإدارة' : key}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
        <Tabs id="admin-books-workspace" value={workspaceTab} onValueChange={setWorkspaceTab} dir="rtl" className="space-y-4">
          <div className="sticky top-2 z-20 rounded-2xl border border-[#0f2b46]/10 bg-white/95 p-3 shadow-sm backdrop-blur">
            <p className="mb-2 text-[10px] font-black text-slate-500">مساحة العمل الأكاديمية — اختر الباب المطلوب بدل التمرير الطويل</p>
            <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-transparent p-0">
              <TabsTrigger value="overview" className="text-[10px] font-black sm:text-xs"><ClipboardList className="ml-1 h-3.5 w-3.5" /> نظرة عامة</TabsTrigger>
              <TabsTrigger value="books" className="text-[10px] font-black sm:text-xs"><BookMarked className="ml-1 h-3.5 w-3.5" /> الكتب/الإضافة/AI ({books.length})</TabsTrigger>
              <TabsTrigger value="knowledge" className="text-[10px] font-black sm:text-xs"><Layers className="ml-1 h-3.5 w-3.5" /> بنك المعرفة ({displayKnowledgeItems.length})</TabsTrigger>
              <TabsTrigger value="units" className="text-[10px] font-black sm:text-xs"><Layers className="ml-1 h-3.5 w-3.5" /> الوحدات ({curriculumUnits.length})</TabsTrigger>
              <TabsTrigger value="guides" className="text-[10px] font-black sm:text-xs"><FileText className="ml-1 h-3.5 w-3.5" /> أدلة الدراسة ({displayStudyGuides.length})</TabsTrigger>
              <TabsTrigger value="assignments" className="text-[10px] font-black sm:text-xs"><FileCheck2 className="ml-1 h-3.5 w-3.5" /> الواجبات ({assignments.length})</TabsTrigger>
              <TabsTrigger value="grading" className="text-[10px] font-black sm:text-xs"><CheckCircle2 className="ml-1 h-3.5 w-3.5" /> مركز التصحيح ({pendingGradingCount})</TabsTrigger>
              <TabsTrigger value="exams" className="text-[10px] font-black sm:text-xs"><ClipboardList className="ml-1 h-3.5 w-3.5" /> الامتحانات ({exams.length})</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-0 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center"><BookMarked className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{books.length}</p><p className="text-[10px] font-bold text-slate-500">كتب مقررة</p></CardContent></Card>
              <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center"><Layers className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{displayKnowledgeItems.length}</p><p className="text-[10px] font-bold text-slate-500">عناصر معرفة نظيفة</p></CardContent></Card>
              <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center"><FileText className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{displayStudyGuides.length}</p><p className="text-[10px] font-bold text-slate-500">أدلة دراسة نظيفة</p></CardContent></Card>
              <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center"><FileCheck2 className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{assignments.length}</p><p className="text-[10px] font-bold text-slate-500">واجبات</p></CardContent></Card>
              <Card className="border-[#0f2b46]/10"><CardContent className="p-4 text-center"><ClipboardList className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{exams.length}</p><p className="text-[10px] font-bold text-slate-500">امتحانات</p></CardContent></Card>
            </div>

          {academicPlanPreview && (
            <Card className="border-[#c9a227]/35 bg-[#fffaf0]">
              <CardContent className="p-5 sm:p-6">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <ClipboardList className="h-4.5 w-4.5 text-[#a8841a]" />
                    مصفوفة الخطة الدراسية لهذا التخصص
                  </h2>
                  <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{academicPlanPreview.academicTitle}</Badge>
                </div>
                <div className="grid gap-3 lg:grid-cols-3">
                  {academicPlanPreview.termPlans.map((term) => (
                    <div key={term.id} className="rounded-2xl bg-white p-3 text-[11px] font-bold leading-5 text-slate-600 shadow-sm ring-1 ring-[#0f2b46]/10">
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <p className="font-black text-[#0f2b46]">{term.title}</p>
                        <span className="rounded-full bg-[#f7edd0] px-2 py-0.5 font-black text-[#a8841a]">{term.weight}%</span>
                      </div>
                      <p className="mb-2">{term.description}</p>
                      <div className="rounded-xl bg-slate-50 p-2">
                        <p className="font-black text-[#0f2b46]">كتب الفصل</p>
                        {term.requiredBooks.length ? term.requiredBooks.slice(0, 3).map((b) => <p key={`${term.id}-${b.title}`}>• {b.title}</p>) : <p>لم تُربط كتب لهذا الفصل بعد.</p>}
                      </div>
                      <div className="mt-2 rounded-xl bg-slate-50 p-2">
                        <p className="font-black text-[#0f2b46]">مخرجات/مهارات/واجبات</p>
                        <p>{term.learningOutcomes.slice(0, 2).join(' ')}</p>
                        <p className="text-[#a8841a]">{term.requiredSkills.slice(0, 4).join(' · ')}</p>
                        <p>{term.assignments.slice(0, 2).join(' · ')}</p>
                      </div>
                      <div className="mt-2 rounded-xl bg-slate-50 p-2">
                        <p className="font-black text-[#0f2b46]">امتحانات وتقييم</p>
                        {term.exams.length ? term.exams.map((e) => <p key={`${term.id}-${e.title}`} className="text-emerald-700">• {e.title} {e.questionCount ? `(${e.questionCount} سؤال)` : ''}</p>) : <p className="text-amber-700">لا يوجد امتحان لهذا الفصل بعد.</p>}
                        <p className="mt-1 text-[#0f2b46]">{term.finalEvaluation}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
          </TabsContent>

          <TabsContent value="knowledge" className="mt-0 space-y-4">
          {/* بنك المعرفة الأكاديمي */}
          <Card className="border-[#c9a227]/35 bg-gradient-to-br from-white to-[#fffaf0]">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <Layers className="h-4.5 w-4.5 text-[#a8841a]" />
                    بنك المعرفة الأكاديمي ({displayKnowledgeItems.length})
                  </h2>
                  <p className="mt-1 max-w-3xl text-[11px] font-bold leading-5 text-slate-500">
                    هذه هي المرحلة الثانية: تحويل الكتب إلى مفاهيم ونظريات وحالات ومنهجيات وبذور أسئلة. الامتحانات والمشرف الذكي يستخدمون هذه المعرفة بدلاً من الاعتماد على نص خام أو أسئلة عامة.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={sanitizeKnowledge} disabled={sanitizingKnowledge || knowledgeItems.length === 0} variant="outline" className="border-amber-300 text-xs font-black text-amber-700">
                    {sanitizingKnowledge ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <AlertTriangle className="ml-2 h-4 w-4" />}
                    تنظيف العناصر المشوهة
                  </Button>
                  <Button onClick={rebuildKnowledge} disabled={rebuildingKnowledge || books.length === 0} className="bg-[#0f2b46] text-xs font-black text-[#e0b83a] hover:bg-[#12365c]">
                    {rebuildingKnowledge ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}
                    بناء/تحديث بنك المعرفة
                  </Button>
                </div>
              </div>

              {hiddenKnowledgeItemsCount > 0 && (
                <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-800">
                  تم إخفاء {hiddenKnowledgeItemsCount} عنصر معرفة يبدو مشوهاً أو مختلط اللغة من العرض. اضغط «تنظيف العناصر المشوهة» لحذفه من قاعدة البيانات، ثم أعد بناء بنك المعرفة.
                </div>
              )}

              <div className="grid gap-2 sm:grid-cols-4">
                {Object.entries(displayKnowledgeStats).length ? Object.entries(displayKnowledgeStats).slice(0, 8).map(([cat, stat]) => (
                  <div key={cat} className="rounded-2xl bg-white p-3 text-center ring-1 ring-[#c9a227]/20">
                    <p className="text-[10px] font-black text-[#a8841a]">{knowledgeCategoryLabel(cat)}</p>
                    <p className="text-lg font-black text-[#0f2b46]">{stat.count}</p>
                    <p className="text-[10px] font-bold text-slate-400">أهمية {stat.avgImportance}%</p>
                  </div>
                )) : (
                  <div className="rounded-2xl bg-white p-4 text-center text-xs font-bold text-slate-500 ring-1 ring-[#c9a227]/20 sm:col-span-4">
                    لم يتم بناء بنك معرفة لهذا البرنامج بعد. أضف كتاباً ثم اضغط بناء/تحديث بنك المعرفة.
                  </div>
                )}
              </div>

              <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1.2fr]">
                <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-100">
                  <p className="mb-2 text-xs font-black text-[#0f2b46]">تحليل الكتب فردياً</p>
                  <div className="max-h-72 space-y-2 overflow-auto pr-1">
                    {books.length === 0 ? <p className="text-[11px] font-bold text-slate-500">لا توجد كتب بعد.</p> : books.map((b) => {
                      const countForBook = displayKnowledgeItems.filter((k) => k.bookId === b.id).length
                      return (
                        <div key={b.id} className="flex items-center justify-between gap-2 rounded-xl bg-[#f8fafc] p-2 text-[11px] font-bold text-slate-600">
                          <div className="min-w-0">
                            <p className="truncate font-black text-[#0f2b46]">{b.title}</p>
                            <p className="text-slate-400">{countForBook ? `${countForBook} عنصر معرفة` : 'غير محلل بعد'}</p>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => rebuildBookKnowledge(b.id)} disabled={rebuildingKnowledge || rebuildingBookId === b.id} className="h-8 shrink-0 px-2 text-[10px] font-black">
                            {rebuildingBookId === b.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'تحليل'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div className="rounded-2xl bg-white p-3 ring-1 ring-slate-100">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-black text-[#0f2b46]">أهم عناصر المعرفة المستخرجة ({displayKnowledgeItems.length})</p>
                    {displayKnowledgeItems.length > 0 && (
                      <Badge variant="outline" className="text-[9px] font-black text-slate-500">
                        مرتبة بالأهمية
                      </Badge>
                    )}
                  </div>
                  <div className="max-h-[34rem] space-y-2 overflow-auto pr-1">
                    {displayKnowledgeItems.length === 0 ? <p className="text-[11px] font-bold text-slate-500">سيظهر هنا ملخص المفاهيم والحالات بعد التحليل. إن كانت العناصر القديمة مشوهة فلن تُعرض؛ اضغط بناء/تحديث بنك المعرفة لإعادة استخراجها.</p> : displayKnowledgeItems.map((item) => (
                      <article key={item.id} className="rounded-xl bg-[#f8fafc] p-3 text-[11px] font-bold leading-5 text-slate-600">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[9px] font-black">{knowledgeCategoryLabel(item.category)}</Badge>
                          <Badge className="bg-[#f7edd0] text-[9px] font-black text-[#a8841a] hover:bg-[#f7edd0]">أهمية {item.importance}%</Badge>
                          {item.bookTitle && <span className="text-[10px] text-slate-400">{item.bookTitle}</span>}
                        </div>
                        <p className="font-black text-[#0f2b46]">{item.title}</p>
                        <p className="mt-1">{item.summary}</p>
                        {item.keywords?.length ? <p className="mt-1 text-[#a8841a]">{item.keywords.slice(0, 6).join(' · ')}</p> : null}
                      </article>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
          </TabsContent>

          <TabsContent value="units" className="mt-0 space-y-4">
            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5 sm:p-6">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Layers className="h-4.5 w-4.5 text-[#a8841a]" /> مراجعة وحدات المنهج</h2>
                    <p className="mt-1 text-xs font-bold text-slate-500">تعديل العناوين، الأهداف، المحتوى والترتيب مباشرة من مساحة العمل الدائمة للبرنامج.</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={unitBusyId === 'new'} onClick={addCurriculumUnit} className="border-[#c9a227] bg-white text-xs font-black text-[#a8841a]">
                    {unitBusyId === 'new' ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : null}
                    إضافة وحدة
                  </Button>
                </div>
                {curriculumUnits.length === 0 ? (
                  <div className="rounded-2xl bg-slate-50 p-6 text-center text-xs font-bold text-slate-500">لا توجد وحدات بعد. استخدم اقتراح الوحدات من الكتب في مركز الجودة أو أضف وحدة يدوياً.</div>
                ) : (
                  <div className="space-y-4">
                    {curriculumUnits.map((unit, index) => (
                      <article key={unit.id} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">وحدة {index + 1}</Badge>
                            <Badge className={unit.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : unit.status === 'NEEDS_REVISION' ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                              {unit.status === 'APPROVED' ? 'معتمدة' : unit.status === 'NEEDS_REVISION' ? 'تحتاج تعديل' : 'مسودة'}
                            </Badge>
                            <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">الفصل {unit.semester || 1}</Badge>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button size="sm" variant="outline" disabled={unitBusyId === unit.id} onClick={() => patchCurriculumUnit(unit, { status: 'APPROVED' })} className="border-emerald-200 bg-white text-xs font-bold text-emerald-700">اعتماد</Button>
                            <Button size="sm" variant="outline" disabled={unitBusyId === unit.id} onClick={() => patchCurriculumUnit(unit, { status: 'NEEDS_REVISION' })} className="border-amber-200 bg-white text-xs font-bold text-amber-700">بحاجة تعديل</Button>
                            <Button size="sm" variant="outline" disabled={unitBusyId === unit.id} onClick={() => patchCurriculumUnit(unit, { order: Math.max(1, unit.order - 1) })} className="bg-white text-xs font-bold">رفع الترتيب</Button>
                            <Button size="sm" variant="outline" disabled={unitBusyId === unit.id} onClick={() => patchCurriculumUnit(unit, { order: unit.order + 1 })} className="bg-white text-xs font-bold">خفض الترتيب</Button>
                            <Button size="sm" variant="outline" disabled={unitBusyId === unit.id} onClick={() => deleteCurriculumUnit(unit.id)} className="border-red-200 bg-white text-xs font-bold text-red-700">حذف</Button>
                          </div>
                        </div>
                        <div className="grid gap-3 md:grid-cols-3">
                          <div className="space-y-2">
                            <label className="text-xs font-black text-slate-500">الفصل</label>
                            <select defaultValue={String(unit.semester || 1)} onChange={(e) => patchCurriculumUnit(unit, { semester: Number(e.target.value) } as any)} className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm font-bold outline-none focus:border-[#c9a227]">
                              {Array.from({ length: programReadiness?.semestersCount || 2 }, (_, i) => i + 1).map((s) => <option key={s} value={s}>الفصل {s}</option>)}
                            </select>
                          </div>
                          <div className="space-y-2 md:col-span-1">
                            <label className="text-xs font-black text-slate-500">عنوان الوحدة</label>
                            <Input defaultValue={unit.title} onBlur={(e) => e.target.value !== unit.title && patchCurriculumUnit(unit, { title: e.target.value })} className="bg-white font-bold" />
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-black text-slate-500">أهداف التعلم — هدف في كل سطر</label>
                            <Textarea defaultValue={(unit.objectives || []).join('\n')} onBlur={(e) => patchCurriculumUnit(unit, { objectives: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean) as any })} className="min-h-24 bg-white text-xs leading-6" />
                          </div>
                        </div>
                        <div className="mt-3 space-y-2">
                          <label className="text-xs font-black text-slate-500">ملخص الوحدة</label>
                          <Textarea defaultValue={unit.summary || ''} onBlur={(e) => e.target.value !== (unit.summary || '') && patchCurriculumUnit(unit, { summary: e.target.value })} className="min-h-20 bg-white text-sm leading-7" />
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
                              patchCurriculumUnit(unit, { content: content as any })
                            }}
                            className="min-h-28 bg-white text-xs leading-6"
                          />
                        </div>
                        {unitBusyId === unit.id && <p className="mt-2 text-xs font-bold text-amber-700">جاري حفظ تعديلات الوحدة...</p>}
                      </article>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="guides" className="mt-0 space-y-4">
          {/* أدلة الدراسة والمحاضرات */}
          <Card className="border-[#0f2b46]/10 bg-white">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <BookMarked className="h-4.5 w-4.5 text-[#a8841a]" />
                    أدلة الدراسة والمحاضرات ({displayStudyGuides.length})
                  </h2>
                  <p className="mt-1 max-w-3xl text-[11px] font-bold leading-5 text-slate-500">
                    يولد النظام دليلاً دراسياً من بنك المعرفة: محاور مذاكرة، أهداف تعلم، مصطلحات، أنشطة قراءة، وأسئلة نقاش يستخدمها الطالب والمشرف الذكي.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[1, 2, 3].map((semester) => (
                    <Button key={semester} size="sm" variant="outline" onClick={() => generateStudyGuide(semester)} disabled={!!generatingGuideSemester || books.length === 0} className="border-[#c9a227] text-[10px] font-black text-[#a8841a]">
                      {generatingGuideSemester === String(semester) ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                      {semester === 3 ? 'دليل البحث/المشروع' : `دليل الفصل ${semester === 2 ? 'الثاني' : 'الأول'}`}
                    </Button>
                  ))}
                </div>
              </div>

              {hiddenStudyGuidesCount > 0 && (
                <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-800">
                  تم إخفاء {hiddenStudyGuidesCount} دليل دراسة يبدو مشوهاً. أعد توليد الدليل بعد تنظيف بنك المعرفة.
                </div>
              )}

              {displayStudyGuides.length === 0 ? (
                <div className="rounded-2xl bg-[#f8fafc] p-6 text-center text-xs font-bold leading-6 text-slate-500">
                  لا توجد أدلة دراسة بعد. ابنِ بنك المعرفة ثم ولّد دليل الفصل المطلوب ليظهر للطالب داخل بوابته.
                </div>
              ) : (
                <div className="space-y-3">
                  {displayStudyGuides.map((guide) => (
                    <article key={guide.id} className="rounded-2xl border border-slate-100 bg-[#f8fafc] p-4 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <Badge className="bg-[#0f2b46] text-[10px] font-black text-[#e0b83a] hover:bg-[#0f2b46]">
                              {guide.semester === 2 ? 'الفصل الثاني' : guide.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول'}
                            </Badge>
                            <Badge variant="outline" className={`text-[10px] font-black ${guide.status === 'PUBLISHED' ? 'border-emerald-200 text-emerald-700' : guide.status === 'DRAFT' ? 'border-amber-200 text-amber-700' : 'border-slate-200 text-slate-500'}`}>
                              {guide.status === 'PUBLISHED' ? 'منشور للطلاب' : guide.status === 'DRAFT' ? 'مسودة' : 'مؤرشف'}
                            </Badge>
                          </div>
                          <h3 className="text-sm font-black leading-6 text-[#0f2b46]">{guide.title}</h3>
                          <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{guide.overview}</p>
                        </div>
                        <div className="flex shrink-0 flex-wrap gap-1">
                          {guide.status !== 'PUBLISHED' && (
                            <Button size="sm" onClick={() => updateStudyGuideStatus(guide, 'PUBLISHED')} className="h-8 bg-emerald-600 px-3 text-[10px] font-black text-white hover:bg-emerald-700">
                              نشر
                            </Button>
                          )}
                          {guide.status === 'PUBLISHED' && (
                            <Button size="sm" variant="outline" onClick={() => updateStudyGuideStatus(guide, 'DRAFT')} className="h-8 px-3 text-[10px] font-black">
                              إخفاء مؤقت
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => generateStudyGuide(guide.semester)} disabled={!!generatingGuideSemester} className="h-8 px-3 text-[10px] font-black text-[#a8841a]">
                            {generatingGuideSemester === String(guide.semester) ? <Loader2 className="h-3 w-3 animate-spin" /> : 'إعادة توليد'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteStudyGuide(guide.id)} className="h-8 px-2 text-red-500 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" /></Button>
                        </div>
                      </div>

                      <div className="mt-3 grid gap-3 lg:grid-cols-3">
                        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
                          <p className="mb-2 text-[11px] font-black text-[#0f2b46]">أهداف التعلم ({guide.objectives.length})</p>
                          {guide.objectives.map((x, i) => <p key={i} className="text-[11px] font-bold leading-5 text-slate-600">• {x}</p>)}
                        </div>
                        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
                          <p className="mb-2 text-[11px] font-black text-[#0f2b46]">مصطلحات ومحاور ({guide.keyTerms.length})</p>
                          <div className="flex flex-wrap gap-1">
                            {guide.keyTerms.map((x, i) => <span key={i} className="rounded-full bg-[#f7edd0] px-2 py-1 text-[10px] font-black text-[#a8841a]">{x}</span>)}
                          </div>
                        </div>
                        <div className="rounded-xl bg-white p-3 ring-1 ring-slate-100">
                          <p className="mb-2 text-[11px] font-black text-[#0f2b46]">أسئلة نقاش للمشرف ({guide.discussionQuestions.length})</p>
                          {guide.discussionQuestions.map((x, i) => <p key={i} className="text-[11px] font-bold leading-5 text-slate-600">• {x}</p>)}
                        </div>
                      </div>

                      <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-slate-100">
                        <p className="mb-2 text-[11px] font-black text-[#0f2b46]">محاور الدليل</p>
                        <div className="grid gap-2 lg:grid-cols-2">
                          {guide.sections.map((section, i) => (
                            <div key={i} className="rounded-lg bg-slate-50 p-2 text-[11px] font-bold leading-5 text-slate-600">
                              <p className="font-black text-[#0f2b46]">{section.title}</p>
                              <p>{section.summary}</p>
                              {section.outcomes?.length ? <p className="mt-1 text-emerald-700">{section.outcomes.slice(0, 2).join(' · ')}</p> : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
          </TabsContent>

          <TabsContent value="assignments" className="mt-0 space-y-4">
          {/* الواجبات والتكليفات */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <FileCheck2 className="h-4.5 w-4.5 text-[#a8841a]" />
                    الواجبات والتكليفات الأكاديمية ({assignments.length})
                  </h2>
                  <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">هذه الواجبات تظهر للطالب، يسلّمها نصاً أو ملفاً، ثم تصححها الإدارة وتدخل في المسار الأكاديمي.</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={suggestAssignments} disabled={suggestingAssignments || books.length === 0} className="border-[#c9a227] text-xs font-bold text-[#a8841a]">
                    {suggestingAssignments ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                    اقترح واجبات من بنك المعرفة
                  </Button>
                  {assignmentForm.id && (
                    <Button size="sm" variant="outline" onClick={resetAssignmentForm} className="text-xs font-bold">إلغاء التعديل</Button>
                  )}
                </div>
              </div>

              <div className="grid gap-3 rounded-2xl bg-[#f8fafc] p-4 lg:grid-cols-6">
                <div className="lg:col-span-2">
                  <Label className="text-[10px] font-black text-slate-500">عنوان الواجب</Label>
                  <Input value={assignmentForm.title} onChange={(e) => setAssignmentForm({ ...assignmentForm, title: e.target.value })} placeholder="مثال: تحليل حالة تطبيقية" className="mt-1 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px] font-black text-slate-500">الفصل</Label>
                  <Select value={assignmentForm.semester} onValueChange={(v) => setAssignmentForm({ ...assignmentForm, semester: v })}>
                    <SelectTrigger className="mt-1 h-10 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">الفصل الأول</SelectItem>
                      <SelectItem value="2">الفصل الثاني</SelectItem>
                      <SelectItem value="3">بحث/مشروع</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[10px] font-black text-slate-500">نوع التكليف</Label>
                  <Select value={assignmentForm.type} onValueChange={(v) => setAssignmentForm({ ...assignmentForm, type: v })}>
                    <SelectTrigger className="mt-1 h-10 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="REPORT">تقرير</SelectItem>
                      <SelectItem value="CASE_STUDY">دراسة حالة</SelectItem>
                      <SelectItem value="SUMMARY">تلخيص كتاب</SelectItem>
                      <SelectItem value="PROJECT">مشروع تطبيقي</SelectItem>
                      <SelectItem value="REFLECTION">تأمل مهني</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[10px] font-black text-slate-500">النقاط</Label>
                  <Input type="number" value={assignmentForm.points} onChange={(e) => setAssignmentForm({ ...assignmentForm, points: e.target.value })} className="mt-1 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px] font-black text-slate-500">وزنه %</Label>
                  <Input type="number" value={assignmentForm.weight} onChange={(e) => setAssignmentForm({ ...assignmentForm, weight: e.target.value })} className="mt-1 text-xs" />
                </div>
                <div className="lg:col-span-4">
                  <Label className="text-[10px] font-black text-slate-500">وصف الواجب وتعليمات التسليم</Label>
                  <Textarea rows={3} value={assignmentForm.description} onChange={(e) => setAssignmentForm({ ...assignmentForm, description: e.target.value })} placeholder="اكتب المطلوب من الطالب، طريقة التحليل، وعدد الكلمات أو شكل الملف المطلوب" className="mt-1 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px] font-black text-slate-500">مدة التسليم بالأيام</Label>
                  <Input type="number" value={assignmentForm.dueDays} onChange={(e) => setAssignmentForm({ ...assignmentForm, dueDays: e.target.value })} placeholder="اختياري" className="mt-1 text-xs" />
                </div>
                <div>
                  <Label className="text-[10px] font-black text-slate-500">الحالة</Label>
                  <Select value={assignmentForm.status} onValueChange={(v) => setAssignmentForm({ ...assignmentForm, status: v })}>
                    <SelectTrigger className="mt-1 h-10 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PUBLISHED">منشور</SelectItem>
                      <SelectItem value="DRAFT">مسودة</SelectItem>
                      <SelectItem value="ARCHIVED">مؤرشف</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="lg:col-span-6">
                  <Label className="text-[10px] font-black text-slate-500">معايير التصحيح Rubric</Label>
                  <Textarea rows={2} value={assignmentForm.rubric} onChange={(e) => setAssignmentForm({ ...assignmentForm, rubric: e.target.value })} placeholder="مثال: وضوح المشكلة 20%، التحليل 40%، الأدلة 20%، جودة العرض 20%" className="mt-1 text-xs" />
                </div>
                <div className="lg:col-span-6">
                  <Button onClick={saveAssignment} disabled={savingAssignment} className="w-full bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                    {savingAssignment ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Plus className="ml-2 h-4 w-4" />}
                    {assignmentForm.id ? 'حفظ تعديل الواجب' : 'إضافة واجب للبرنامج'}
                  </Button>
                </div>
              </div>

              {assignmentSuggestions.length > 0 && (
                <div className="mt-4 rounded-2xl border border-[#c9a227]/35 bg-[#fffaf0] p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                      <Bot className="h-4 w-4 text-[#a8841a]" /> واجبات مقترحة من بنك المعرفة
                    </h3>
                    <Button size="sm" onClick={addAllAssignmentSuggestions} disabled={savingAssignment} className="bg-[#0f2b46] text-[10px] font-black text-[#e0b83a] hover:bg-[#12365c]">
                      <Plus className="ml-1 h-3 w-3" /> إضافة كل الواجبات
                    </Button>
                  </div>
                  <div className="grid gap-3 lg:grid-cols-2">
                    {assignmentSuggestions.map((s, i) => (
                      <article key={`${s.title}-${i}`} className={`rounded-xl border bg-white p-3 shadow-sm ${s.added ? 'border-emerald-200 opacity-70' : 'border-[#c9a227]/20'}`}>
                        <div className="mb-2 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[9px] font-black">{assignmentTypeLabel(s.type)}</Badge>
                          <Badge variant="outline" className="text-[9px] font-black">{s.semester === 2 ? 'الفصل الثاني' : s.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول'}</Badge>
                          <Badge className="bg-[#f7edd0] text-[9px] font-black text-[#a8841a] hover:bg-[#f7edd0]">{s.points} نقاط</Badge>
                          {s.weight > 0 && <Badge className="bg-emerald-50 text-[9px] font-black text-emerald-700 hover:bg-emerald-50">وزن {s.weight}%</Badge>}
                        </div>
                        <h4 className="text-xs font-black leading-5 text-[#0f2b46]">{s.title}</h4>
                        <p className="mt-1 line-clamp-4 text-[11px] font-bold leading-5 text-slate-600">{s.description}</p>
                        {s.sourceKnowledgeTitles?.length ? (
                          <p className="mt-2 rounded-lg bg-slate-50 p-2 text-[10px] font-bold leading-5 text-slate-500">مصادر معرفية: {s.sourceKnowledgeTitles.slice(0, 4).join('، ')}</p>
                        ) : null}
                        <p className="mt-2 text-[10px] font-bold leading-5 text-[#a8841a]">معايير التصحيح: {s.rubric}</p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {s.added ? (
                            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> أُضيف</Badge>
                          ) : (
                            <Button size="sm" onClick={() => addAssignmentSuggestion(s)} disabled={savingAssignment} className="h-8 bg-[#c9a227] px-3 text-[10px] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
                              <Plus className="ml-1 h-3 w-3" /> إضافة مباشرة
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => useAssignmentSuggestionInForm(s)} className="h-8 px-3 text-[10px] font-black">
                            فتح للتعديل قبل الإضافة
                          </Button>
                        </div>
                      </article>
                    ))}
                  </div>
                </div>
              )}

              <div className="mt-4 space-y-3">
                {assignments.length === 0 ? (
                  <div className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">لا توجد واجبات حقيقية لهذا البرنامج بعد.</div>
                ) : assignments.map((a) => (
                  <div key={a.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="font-black text-[#0f2b46]">{a.title}</h3>
                          <Badge variant="outline" className="text-[10px]">{a.semester === 2 ? 'الفصل الثاني' : a.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول'}</Badge>
                          <Badge className="bg-[#f7edd0] text-[10px] text-[#a8841a] hover:bg-[#f7edd0]">{a.points} نقاط</Badge>
                          {a.weight > 0 && <Badge className="bg-emerald-50 text-[10px] text-emerald-700 hover:bg-emerald-50">وزن {a.weight}%</Badge>}
                          <Badge variant="outline" className={`text-[10px] ${a.status === 'PUBLISHED' ? 'border-emerald-200 text-emerald-700' : a.status === 'DRAFT' ? 'border-amber-200 text-amber-700' : 'border-slate-200 text-slate-500'}`}>{a.status === 'PUBLISHED' ? 'منشور' : a.status === 'DRAFT' ? 'مسودة' : 'مؤرشف'}</Badge>
                        </div>
                        <p className="mt-1 text-xs font-bold leading-6 text-slate-600">{a.description}</p>
                        {a.rubric && <p className="mt-1 rounded-lg bg-slate-50 p-2 text-[11px] font-bold leading-5 text-slate-500">معايير التصحيح: {a.rubric}</p>}
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button size="sm" variant="outline" onClick={() => editAssignment(a)} className="text-xs font-bold">تعديل</Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteAssignment(a.id)} className="text-red-500 hover:bg-red-50"><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </div>
                    <div className="mt-3 rounded-xl bg-[#f8fafc] p-3">
                      <p className="mb-2 text-xs font-black text-[#0f2b46]">تسليمات الطلاب ({a.submissionsCount})</p>
                      {a.submissions.length === 0 ? (
                        <p className="text-[11px] font-bold text-slate-500">لا توجد تسليمات بعد.</p>
                      ) : (
                        <div className="space-y-2">
                          {a.submissions.slice(0, 3).map((s) => (
                            <div key={s.id} className="rounded-xl bg-white p-3 text-[11px] font-bold leading-5 text-slate-600 ring-1 ring-slate-100">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <p className="font-black text-[#0f2b46]">{s.studentName} <span className="font-bold text-slate-400">{s.studentEmail}</span></p>
                                <div className="flex flex-wrap items-center gap-1">
                                  <Badge variant="outline" className="text-[9px]">{s.status === 'GRADED' ? 'مصحح' : s.status === 'NEEDS_REVISION' ? 'يحتاج تعديل' : 'بانتظار التصحيح'}</Badge>
                                  {s.score != null && <Badge className="bg-emerald-50 text-[9px] text-emerald-700 hover:bg-emerald-50">{s.score}/{a.points}</Badge>}
                                </div>
                              </div>
                              {s.answerText && <p className="mt-2 rounded-lg bg-slate-50 p-2">{s.answerText.slice(0, 600)}{s.answerText.length > 600 ? '…' : ''}</p>}
                              {s.fileName && (
                                <a href={`/api/admin/assignments/file?id=${s.id}`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-[#1d4ed8] hover:bg-blue-100">
                                  <FileText className="h-3 w-3" /> ملف مرفق: {s.fileName} {s.size ? `(${Math.ceil(s.size / 1024)} ك.ب)` : ''}
                                </a>
                              )}
                              {s.feedback && <p className="mt-1 text-emerald-700">ملاحظة التصحيح: {s.feedback}</p>}
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button size="sm" onClick={() => gradeSubmission(s, a)} disabled={gradingSubmissionId === s.id} className="h-8 bg-emerald-600 px-3 text-[10px] font-black text-white hover:bg-emerald-700">
                                  {gradingSubmissionId === s.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'تصحيح'}
                                </Button>
                                <Button size="sm" variant="outline" onClick={() => requestAssignmentRevision(s)} disabled={gradingSubmissionId === s.id} className="h-8 px-3 text-[10px] font-black text-amber-700">
                                  طلب تعديل
                                </Button>
                              </div>
                            </div>
                          ))}
                          {a.submissions.length > 3 && (
                            <div className="rounded-xl border border-[#c9a227]/20 bg-[#fffaf0] p-3 text-[11px] font-bold leading-5 text-[#7a5b13]">
                              تظهر آخر 3 تسليمات فقط هنا حتى لا تتكدس الصفحة. افتح مركز التصحيح لعرض كل التسليمات وفرزها حسب الطالب والحالة.
                              <Button size="sm" variant="outline" onClick={() => { setWorkspaceTab('grading'); setGradingSearch(a.title) }} className="mt-2 h-8 border-[#c9a227] px-3 text-[10px] font-black text-[#a8841a]">
                                فتح كل التسليمات في مركز التصحيح
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
          </TabsContent>

          <TabsContent value="grading" className="mt-0 space-y-4">
            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5 sm:p-6">
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="flex items-center gap-2 text-base font-black text-[#0f2b46]">
                      <CheckCircle2 className="h-5 w-5 text-[#a8841a]" /> مركز التصحيح والمراجعة
                    </h2>
                    <p className="mt-1 text-xs font-bold leading-6 text-slate-500">
                      تخصص: {selectedProgram?.titleAr || 'اختر تخصصاً'} — هنا تُصحح تسليمات الواجبات بدل تكدسها داخل بطاقة كل واجب. الامتحانات الآلية تظهر ملخصاتها واعتراضاتها في الأسفل.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-center text-[10px] font-black sm:grid-cols-4">
                    <div className="rounded-2xl bg-amber-50 px-3 py-2 text-amber-700"><p className="text-lg">{pendingGradingCount}</p><p>بانتظار</p></div>
                    <div className="rounded-2xl bg-emerald-50 px-3 py-2 text-emerald-700"><p className="text-lg">{gradedCount}</p><p>مصحح</p></div>
                    <div className="rounded-2xl bg-orange-50 px-3 py-2 text-orange-700"><p className="text-lg">{revisionCount}</p><p>تعديل</p></div>
                    <div className="rounded-2xl bg-blue-50 px-3 py-2 text-blue-700"><p className="text-lg">{exams.reduce((sum, e) => sum + (e.attemptsCount || 0), 0)}</p><p>محاولات امتحان</p></div>
                  </div>
                </div>

                <div className="grid gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-3 sm:grid-cols-[1fr_160px_160px]">
                  <Input value={gradingSearch} onChange={(e) => setGradingSearch(e.target.value)} placeholder="ابحث باسم الطالب أو عنوان الواجب" className="bg-white" />
                  <Select value={gradingStatusFilter} onValueChange={setGradingStatusFilter}>
                    <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PENDING">بانتظار التصحيح</SelectItem>
                      <SelectItem value="SUBMITTED">مسلم فقط</SelectItem>
                      <SelectItem value="NEEDS_REVISION">يحتاج تعديل</SelectItem>
                      <SelectItem value="GRADED">مصحح</SelectItem>
                      <SelectItem value="ALL">كل الحالات</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select value={gradingSemesterFilter} onValueChange={setGradingSemesterFilter}>
                    <SelectTrigger className="bg-white"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">كل الفصول</SelectItem>
                      <SelectItem value="1">الفصل الأول</SelectItem>
                      <SelectItem value="2">الفصل الثاني</SelectItem>
                      <SelectItem value="3">بحث/مشروع</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="mt-4 space-y-3">
                  {filteredGradingQueue.length === 0 ? (
                    <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-bold text-slate-500">لا توجد تسليمات مطابقة للفلتر الحالي.</div>
                  ) : filteredGradingQueue.map(({ assignment, submission }) => (
                    <article key={submission.id} className="rounded-2xl border border-slate-100 bg-white p-4 shadow-sm">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="outline" className="text-[10px]">{assignment.semester === 2 ? 'الفصل الثاني' : assignment.semester === 3 ? 'بحث/مشروع' : 'الفصل الأول'}</Badge>
                            <Badge className={`text-[10px] ${submission.status === 'GRADED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : submission.status === 'NEEDS_REVISION' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : 'bg-red-100 text-red-700 hover:bg-red-100'}`}>{submission.status === 'GRADED' ? 'مصحح' : submission.status === 'NEEDS_REVISION' ? 'يحتاج تعديل' : 'بانتظار التصحيح'}</Badge>
                            {submission.score != null && <Badge className="bg-emerald-50 text-[10px] text-emerald-700 hover:bg-emerald-50">{submission.score}/{assignment.points}</Badge>}
                          </div>
                          <h3 className="mt-2 text-sm font-black text-[#0f2b46]">{assignment.title}</h3>
                          <p className="mt-1 text-xs font-bold text-slate-500">{submission.studentName || 'طالب'} — {submission.studentEmail || 'بريد غير متوفر'}</p>
                          {submission.answerText && <p className="mt-2 rounded-xl bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">{submission.answerText.slice(0, 900)}{submission.answerText.length > 900 ? '…' : ''}</p>}
                          {submission.fileName && (
                            <a href={`/api/admin/assignments/file?id=${submission.id}`} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-xs font-bold text-[#1d4ed8] hover:bg-blue-100">
                              <FileText className="h-3.5 w-3.5" /> ملف مرفق: {submission.fileName} {submission.size ? `(${Math.ceil(submission.size / 1024)} ك.ب)` : ''}
                            </a>
                          )}
                          {submission.feedback && <p className="mt-2 rounded-xl bg-emerald-50 p-2 text-xs font-bold leading-5 text-emerald-700">ملاحظة التصحيح: {submission.feedback}</p>}
                        </div>
                        <div className="flex shrink-0 flex-col gap-2 sm:w-36">
                          <Button size="sm" onClick={() => gradeSubmission(submission, assignment)} disabled={gradingSubmissionId === submission.id} className="h-9 bg-emerald-600 px-3 text-[11px] font-black text-white hover:bg-emerald-700">
                            {gradingSubmissionId === submission.id ? <Loader2 className="h-3 w-3 animate-spin" /> : 'تصحيح'}
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => requestAssignmentRevision(submission, assignment)} disabled={gradingSubmissionId === submission.id} className="h-9 px-3 text-[11px] font-black text-amber-700">
                            طلب تعديل
                          </Button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card className="border-[#0f2b46]/10 bg-white">
              <CardContent className="p-5 sm:p-6">
                <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><ClipboardList className="h-4 w-4 text-[#a8841a]" /> متابعة الامتحانات لهذا التخصص</h3>
                <p className="mt-1 text-xs font-bold leading-6 text-slate-500">الامتحانات الموضوعية تُصحح آلياً. راجع عدد المحاولات وحالات الأسئلة، واعتراضات النتائج من هنا.</p>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  {exams.length === 0 ? <div className="rounded-2xl bg-slate-50 p-5 text-center text-xs font-bold text-slate-500">لا توجد امتحانات لهذا التخصص بعد.</div> : exams.map((exam) => (
                    <div key={exam.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="font-black text-[#0f2b46]">{exam.title}</p>
                          <p className="mt-1 text-[11px] font-bold text-slate-500">{exam.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'} — {exam.questionCount} سؤال — {exam.attemptsCount} محاولة</p>
                        </div>
                        <Badge className={exam.status === 'READY' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : exam.status === 'REVIEW' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : 'bg-slate-100 text-slate-700 hover:bg-slate-100'}>{exam.status}</Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {exam.pendingReview > 0 && <Button size="sm" onClick={() => setReviewingExam({ id: exam.id, title: exam.title })} className="h-8 bg-[#0f2b46] px-3 text-[10px] font-black text-[#f5f0e1]">مراجعة الأسئلة ({exam.pendingReview})</Button>}
                        <Button size="sm" variant="outline" onClick={() => setWorkspaceTab('exams')} className="h-8 px-3 text-[10px] font-black">فتح تبويب الامتحانات</Button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-4 rounded-2xl border border-blue-100 bg-blue-50 p-3">
                  <AdminAppealsSection />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="books" className="mt-0 space-y-4">
          {/* الكتب المقررة */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                  <BookMarked className="h-4.5 w-4.5 text-[#a8841a]" />
                  الكتب المقررة التي يجب على الطالب قراءتها ({books.length})
                </h2>
                <Button size="sm" variant="outline" onClick={suggest} disabled={suggesting} className="border-[#c9a227] font-bold text-[#a8841a]">
                  {suggesting ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                  اقترح كتباً بالذكاء الاصطناعي
                </Button>
              </div>

              <Tabs value={booksSubTab} onValueChange={setBooksSubTab} dir="rtl" className="space-y-4">
                <TabsList className="flex h-auto w-full flex-wrap gap-1 bg-slate-50 p-1">
                  <TabsTrigger value="current" className="text-[10px] font-black sm:text-xs">الكتب الحالية ({books.length})</TabsTrigger>
                  <TabsTrigger value="add" className="text-[10px] font-black sm:text-xs">إضافة كتاب</TabsTrigger>
                  <TabsTrigger value="ai" className="text-[10px] font-black sm:text-xs">توليد/اقتراح كتب AI ({suggestions.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="current" className="mt-0">
              {loadingBooks ? (
                <div className="flex h-24 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
              ) : books.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">
                  لا توجد كتب مقررة لهذا التخصص بعد — أضفها يدوياً بالأسفل أو اطلب اقتراحات خبير الذكاء الاصطناعي
                </div>
              ) : (
                <div className="aact-scroll max-h-80 space-y-2.5 overflow-y-auto">
                  {books.map((b, i) => (
                    <div key={b.id} className="flex items-start gap-3 rounded-xl border border-slate-100 bg-white p-3.5">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0f2b46] text-[10px] font-black text-[#e0b83a]">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="text-xs font-extrabold text-[#0f2b46]">{b.title}</h3>
                          {b.source === 'AI' ? (
                            <Badge className="bg-[#f7edd0] text-[9px] text-[#a8841a] hover:bg-[#f7edd0]">اقتراح خبير AI</Badge>
                          ) : (
                            <Badge variant="outline" className="border-slate-200 px-1.5 py-0 text-[9px] text-slate-500">إدارة</Badge>
                          )}
                          {b.semester ? (
                            <Badge variant="outline" className="border-[#c9a227]/40 text-[9px] text-[#a8841a]">
                              <Layers className="ml-0.5 h-2.5 w-2.5" /> {b.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="border-slate-200 text-[9px] text-slate-400">عام للبرنامج</Badge>
                          )}
                        </div>
                        {(b.author || b.year) && (
                          <p className="mt-0.5 text-[10px] font-bold text-slate-500">{b.author}{b.year ? ` — ${b.year}` : ''}{b.titleEn ? ` · ${b.titleEn}` : ''}</p>
                        )}
                        {b.description && <p className="mt-1 text-[10px] leading-relaxed text-slate-500">{b.description}</p>}
                        {(b.levelPolicy || b.readingDepth || b.assessmentOrientation) && (
                          <div className="mt-2 rounded-xl bg-[#f8fafc] p-2 text-[10px] font-bold leading-5 text-slate-600">
                            {b.levelPolicy && <p><strong className="text-[#0f2b46]">سياسة المستوى:</strong> {b.levelPolicy}</p>}
                            {b.readingDepth && <p><strong className="text-[#0f2b46]">عمق القراءة:</strong> {b.readingDepth}</p>}
                            {b.assessmentOrientation && <p><strong className="text-[#0f2b46]">طبيعة التقييم:</strong> {b.assessmentOrientation}</p>}
                          </div>
                        )}
                        {b.linkReadStatus && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            <Badge className={`${LINK_READ_META[b.linkReadStatus]?.cls || 'bg-slate-100 text-slate-600'} text-[9px] hover:bg-inherit`}>
                              {LINK_READ_META[b.linkReadStatus]?.label || b.linkReadStatus}
                            </Badge>
                            {b.linkReadNote && <span className="text-[10px] font-bold text-slate-400">{b.linkReadNote}</span>}
                          </div>
                        )}
                        {b.hasFile && (
                          <a href={`/api/books/${b.id}/file`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700 hover:bg-emerald-100">
                            <FileText className="h-3 w-3" /> {b.fileName} ({Math.ceil((b.size || 0) / 1024)} ك.ب)
                          </a>
                        )}
                        {b.link && (
                          <a href={b.link} target="_blank" rel="noreferrer" className={`ml-1.5 mt-1.5 inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-[10px] font-black ${isCatalogLikeUiLink(b.link) || b.linkReadStatus === 'SEARCH_LINK_ONLY' ? 'bg-amber-50 text-amber-700 hover:bg-amber-100' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'}`}>
                            <Link2 className="h-3 w-3" /> {isCatalogLikeUiLink(b.link) || b.linkReadStatus === 'SEARCH_LINK_ONLY' ? 'فتح رابط تحقق فقط' : 'فتح رابط القراءة'}
                          </a>
                        )}
                        {bookNeedsReadableSource(b) && (
                          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                            <p className="text-[10px] font-black leading-5 text-amber-800">
                              هذا الكتاب يحتاج مصدر قراءة فعلي حتى يقرأه المشرف الذكي ويدخله بنك المعرفة والامتحانات. ارفع ملف الكتاب أو ضع رابطه الرسمي المباشر.
                            </p>
                            <div className="mt-2 grid gap-2 lg:grid-cols-[1fr_auto]">
                              <Input
                                value={sourceLinks[b.id] || ''}
                                onChange={(e) => setSourceLinks((prev) => ({ ...prev, [b.id]: e.target.value }))}
                                placeholder="رابط PDF/TXT/HTML رسمي مفتوح — وليس Google Books"
                                className="h-8 bg-white text-[10px]"
                                dir="ltr"
                              />
                              <Button
                                size="sm"
                                onClick={() => updateBookSource(b)}
                                disabled={updatingSourceBookId === b.id}
                                className="h-8 bg-[#0f2b46] text-[10px] font-black text-[#e0b83a] hover:bg-[#12365c]"
                              >
                                {updatingSourceBookId === b.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                                {updatingSourceBookId === b.id && bookUploadProgress !== null ? `رفع ${bookUploadProgress}%` : 'تحديث وقراءة الكتاب'}
                              </Button>
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <input
                                type="file"
                                accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
                                onChange={(e) => {
                                  const picked = e.target.files?.[0] || null
                                  if (picked && picked.size > MAX_BOOK_FILE_SIZE) {
                                    toast({ title: 'حجم الملف كبير', description: 'الحد الحالي لملف الكتاب 10 ميجابايت.', variant: 'destructive' })
                                    e.target.value = ''
                                    setSourceFiles((prev) => ({ ...prev, [b.id]: null }))
                                    return
                                  }
                                  setSourceFiles((prev) => ({ ...prev, [b.id]: picked }))
                                }}
                                className="block w-full max-w-md text-[10px] text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-[#0f2b46] file:px-3 file:py-1.5 file:text-[10px] file:font-black file:text-[#e0b83a]"
                              />
                              {sourceFiles[b.id] && (
                                <Badge className="bg-emerald-100 text-[9px] text-emerald-700 hover:bg-emerald-100">
                                  <Upload className="ml-1 h-3 w-3" /> {sourceFiles[b.id]?.name}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-2 text-[10px] font-bold leading-5 text-amber-700">
                              عند نجاح القراءة سيعيد النظام بناء بنك المعرفة تلقائياً، ثم تصبح أسئلة الامتحان والمشرف الذكي مبنية على نص الكتاب لا على عنوانه فقط.
                            </p>
                          </div>
                        )}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => deleteBook(b.id)} className="shrink-0 text-red-400 hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
                </TabsContent>

                <TabsContent value="ai" className="mt-0 space-y-4">
                  <div className="rounded-2xl border border-[#c9a227]/30 bg-[#fffaf0] p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Sparkles className="h-4 w-4 text-[#a8841a]" /> توليد/اقتراح كتب بالذكاء الاصطناعي</h3>
                        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">يقترح كتباً بحسب الدرجة والتخصص، ثم تضيف الإدارة ما يناسب المنهج. الروابط غير المباشرة تبقى مراجع فقط حتى ترفع ملف الكتاب أو رابط قراءة مباشر.</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={suggest} disabled={suggesting} className="border-[#c9a227] font-bold text-[#a8841a]">
                        {suggesting ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                        اقترح كتباً بالذكاء الاصطناعي
                      </Button>
                    </div>
                  </div>

              {/* اقتراحات خبير الذكاء الاصطناعي */}
              {suggestions.length > 0 ? (
                <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/40 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <h3 className="flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                      <Bot className="h-4 w-4 text-[#a8841a]" /> اقتراحات خبير الذكاء الاصطناعي وفق واقع التخصص عالمياً
                    </h3>
                    <Button size="sm" onClick={suggestAll} className="bg-[#0f2b46] text-[10px] font-black text-[#e0b83a] hover:bg-[#12365c]">
                      <Plus className="ml-1 h-3 w-3" /> إضافة الكل
                    </Button>
                  </div>
                  <div className="aact-scroll max-h-72 space-y-2 overflow-y-auto">
                    {suggestions.map((s, i) => (
                      <div key={i} className={`rounded-lg border bg-white p-3 ${s.added ? 'border-emerald-200 opacity-70' : 'border-[#c9a227]/20'}`}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <h4 className="text-xs font-extrabold text-[#0f2b46]">{s.title}</h4>
                            <p className="mt-0.5 text-[10px] font-bold text-slate-500" dir="auto">{s.titleEn} — {s.author} {s.year && `(${s.year})`}</p>
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {s.semester && <Badge variant="outline" className="border-[#c9a227]/40 text-[9px] text-[#a8841a]">الفصل {s.semester}</Badge>}
                              {s.levelPolicy && <Badge className="bg-[#0f2b46] text-[9px] text-[#e0b83a] hover:bg-[#0f2b46]">مخصص للدرجة</Badge>}
                              {s.assessmentOrientation && <Badge className="bg-blue-100 text-[9px] text-blue-700 hover:bg-blue-100">تقييم متخصص</Badge>}
                              {s.linkType && (
                                <Badge className={`${SUGGESTION_LINK_META[s.linkType]?.cls || 'bg-slate-100 text-slate-600'} text-[9px] hover:bg-inherit`}>
                                  {SUGGESTION_LINK_META[s.linkType]?.label || s.linkType}
                                </Badge>
                              )}
                            </div>
                            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{s.reason}</p>
                            {(s.levelPolicy || s.readingDepth || s.assessmentOrientation) && (
                              <div className="mt-1.5 rounded-lg bg-[#f8fafc] p-2 text-[10px] font-bold leading-5 text-slate-600">
                                {s.levelPolicy && <p><strong className="text-[#0f2b46]">سياسة المستوى:</strong> {s.levelPolicy}</p>}
                                {s.readingDepth && <p><strong className="text-[#0f2b46]">عمق القراءة:</strong> {s.readingDepth}</p>}
                                {s.assessmentOrientation && <p><strong className="text-[#0f2b46]">طبيعة الامتحان:</strong> {s.assessmentOrientation}</p>}
                              </div>
                            )}
                            {s.linkReadHint && (
                              <p className={`mt-1.5 rounded-lg p-2 text-[10px] font-bold leading-5 ${s.linkType === 'DIRECT_READABLE' ? 'bg-emerald-50 text-emerald-700' : s.linkType === 'UNKNOWN' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-700'}`}>
                                {s.linkReadHint}
                              </p>
                            )}
                            {s.link && (
                              <a href={s.link} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700 hover:bg-emerald-100">
                                <Link2 className="h-3 w-3" /> فتح رابط القراءة المباشر
                              </a>
                            )}
                            {!s.link && s.referenceLink && (
                              <a href={s.referenceLink} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-0.5 text-[10px] font-black text-amber-700 hover:bg-amber-100">
                                <Link2 className="h-3 w-3" /> رابط تحقق فقط — لا يقرأه النظام ككتاب
                              </a>
                            )}
                          </div>
                          {s.added ? (
                            <Badge className="shrink-0 bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><CheckCircle2 className="ml-1 h-3 w-3" /> أُضيف</Badge>
                          ) : (
                            <Button size="sm" onClick={() => addBook(s)} disabled={adding} className="shrink-0 bg-[#c9a227] text-[10px] font-black text-[#0f2b46] hover:bg-[#e0b83a]">
                              <Plus className="ml-1 h-3 w-3" /> إضافة
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl bg-slate-50 p-6 text-center text-xs font-bold leading-6 text-slate-500">
                  اضغط زر «اقترح كتباً بالذكاء الاصطناعي» لتظهر هنا الكتب المقترحة حسب الدرجة والتخصص، ثم أضف المناسب منها للمنهج.
                </div>
              )}
                </TabsContent>

                <TabsContent value="add" className="mt-0">
              {/* نموذج إضافة كتاب */}
              <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                <h3 className="mb-3 flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
                  <Plus className="h-4 w-4 text-[#a8841a]" /> إضافة كتاب مقرر جديد
                </h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">اسم الكتاب (عربي) *</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="مثال: إدارة الموارد البشرية الحديثة" className="mt-1 h-9 text-xs" />
                  </div>
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">العنوان بالإنجليزية</Label>
                    <Input value={form.titleEn} onChange={(e) => setForm({ ...form, titleEn: e.target.value })} placeholder="Original title" className="mt-1 h-9 text-xs" dir="ltr" />
                  </div>
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">المؤلف</Label>
                    <Input value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} className="mt-1 h-9 text-xs" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">رابط قراءة مباشر للكتاب (PDF / TXT / HTML نصي مفتوح)</Label>
                    <Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://example.com/book.pdf — وليس رابط Google Books أو صفحة بحث" className="mt-1 h-9 text-xs" dir="ltr" />
                    <p className="mt-1 text-[10px] font-bold leading-5 text-amber-700">
                      تنبيه: روابط Google Books وGoodreads وWorldCat وروابط البحث تُحفظ كمرجع فقط ولا يقرأها المشرف ككتاب. لبناء بنك المعرفة ارفع الملف أو ضع رابطاً مباشراً مفتوحاً.
                    </p>
                  </div>
                  <div>
                    <Label className="text-[10px] font-black text-slate-600">سنة النشر</Label>
                    <Input value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })} className="mt-1 h-9 text-xs" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">لماذا هذا الكتاب مطلوب في التخصص</Label>
                    <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="نبذة عن قيمة الكتاب ودوره في المنهج..." className="mt-1 min-h-16 text-xs" />
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">الفصل الدراسي المعتمد عليه</Label>
                    <Select value={form.semester || 'any'} onValueChange={(v) => setForm({ ...form, semester: v === 'any' ? '' : v })}>
                      <SelectTrigger className="mt-1 h-9 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="any">عام — يدخل في الفصلين</SelectItem>
                        <SelectItem value="1">الفصل الدراسي الأول</SelectItem>
                        <SelectItem value="2">الفصل الدراسي الثاني</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="sm:col-span-2">
                    <Label className="text-[10px] font-black text-slate-600">ملف الكتاب (PDF / Word / Excel / TXT — رفع آمن مجزأ حتى 10 ميجابايت)</Label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
                        onChange={(e) => {
                          const picked = e.target.files?.[0] || null
                          if (picked && picked.size > MAX_BOOK_FILE_SIZE) {
                            toast({ title: 'حجم الملف كبير', description: 'الحد الحالي لملف الكتاب 10 ميجابايت.', variant: 'destructive' })
                            e.target.value = ''
                            setFile(null)
                            return
                          }
                          setFile(picked)
                        }}
                        className="block w-full max-w-sm text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-[#0f2b46] file:px-3 file:py-1.5 file:text-[10px] file:font-black file:text-[#e0b83a]"
                      />
                      {file && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><Upload className="ml-1 h-3 w-3" /> {file.name}</Badge>}
                    </div>
                    {bookUploadProgress !== null && adding && (
                      <div className="mt-2 text-[10px] font-black text-[#0f2b46]">جاري رفع الملف: {bookUploadProgress}%</div>
                    )}
                  </div>
                </div>
                <Button onClick={() => addBook()} disabled={adding} className="mt-4 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                  {adding ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Plus className="ml-1 h-4 w-4" />}
                  {bookUploadProgress !== null ? `رفع الملف ${bookUploadProgress}%` : 'إضافة الكتاب للكتب المقررة'}
                </Button>
              </div>
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
          </TabsContent>

          <TabsContent value="exams" className="mt-0 space-y-4">
          <Card className="border-[#c9a227]/25 bg-[#fffaf0]">
            <CardContent className="p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <ClipboardList className="h-4.5 w-4.5 text-[#a8841a]" /> بنك الأسئلة المركزي لهذا البرنامج
                  </h2>
                  <p className="mt-1 text-xs font-bold text-slate-500">إدارة دائمة لبنك الأسئلة حتى بعد اعتماد المنهج وخروجه من مركز الجودة.</p>
                </div>
                <div className="grid grid-cols-4 gap-2 text-center text-[10px] font-black">
                  <div className="rounded-xl bg-white px-3 py-2 text-slate-600 ring-1 ring-[#c9a227]/20">الإجمالي<br /><span className="text-base text-[#0f2b46]">{questionBankStats?.total || 0}</span></div>
                  <div className="rounded-xl bg-white px-3 py-2 text-amber-700 ring-1 ring-[#c9a227]/20">مراجعة<br /><span className="text-base">{questionBankStats?.pending || 0}</span></div>
                  <div className="rounded-xl bg-white px-3 py-2 text-emerald-700 ring-1 ring-[#c9a227]/20">معتمد<br /><span className="text-base">{questionBankStats?.approved || 0}</span></div>
                  <div className="rounded-xl bg-white px-3 py-2 text-red-700 ring-1 ring-[#c9a227]/20">مرفوض<br /><span className="text-base">{questionBankStats?.rejected || 0}</span></div>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="bg-white text-xs font-black" onClick={() => setQuestionBankOpen(true)}>مراجعة بنك الأسئلة</Button>
                <Button size="sm" variant="outline" disabled={questionBankBusy === 'generate'} onClick={generateQuestionsForBank} className="bg-white text-xs font-black">
                  {questionBankBusy === 'generate' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                  توليد أسئلة من بنك المعرفة
                </Button>
                <Button size="sm" variant="outline" className="bg-white text-xs font-black" onClick={() => setManualQuestionOpen(true)}>إضافة سؤال يدوي</Button>
                <Button size="sm" variant="outline" className="bg-white text-xs font-black" onClick={() => setImportQuestionsOpen(true)}>استيراد أسئلة</Button>
                <Button size="sm" variant="outline" className="bg-white text-xs font-black" disabled={questionBankBusy === 'exam-load'} onClick={openExamImport}>
                  {questionBankBusy === 'exam-load' ? <Loader2 className="ml-1 h-3 w-3 animate-spin" /> : null}
                  نسخ من اختبار موجود
                </Button>
                <Button size="sm" variant="outline" disabled={questionBankBusy === 'units-load' || questionBankBusy === 'exam-1'} onClick={() => openBankExamDialog(1)} className="bg-white text-xs font-black">امتحان فصل 1 من البنك</Button>
                <Button size="sm" variant="outline" disabled={questionBankBusy === 'units-load' || questionBankBusy === 'exam-2'} onClick={() => openBankExamDialog(2)} className="bg-white text-xs font-black">امتحان فصل 2 من البنك</Button>
              </div>
            </CardContent>
          </Card>

          {/* الاختبارات الشاملة المولدة */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                  <ClipboardList className="h-4.5 w-4.5 text-[#a8841a]" />
                  امتحانات الفصول الدراسية المولدة من الكتب ({exams.length})
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={genSemester} onValueChange={setGenSemester}>
                    <SelectTrigger className="h-9 w-44 text-xs font-bold">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">امتحان الفصل الأول</SelectItem>
                      <SelectItem value="2">امتحان الفصل الثاني</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={generateExam} disabled={generating} className="bg-emerald-600 font-black text-white hover:bg-emerald-700">
                    {generating ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : hasGeneratingExam ? <RefreshCw className="ml-1 h-3.5 w-3.5" /> : <Sparkles className="ml-1 h-3.5 w-3.5" />}
                    {hasGeneratingExam ? 'تحريك التوليد' : 'توليد بالذكاء الاصطناعي'}
                  </Button>
                </div>
              </div>

              {exams.length === 0 ? (
                <div className="rounded-xl bg-slate-50 p-6 text-center text-xs leading-relaxed text-slate-500">
                  لم يولَّد امتحان لهذا التخصص بعد. كل برنامج له امتحانان: نهاية الفصل الأول ونهاية الفصل الثاني.<br />
                  عند التوليد يقرأ خبير الذكاء الاصطناعي كل الكتب المقررة ويحللها ثم يضع امتحاناً بمجموع كبير من الأسئلة المتنوعة
                  (اختيار من متعدد، صح/خطأ، إجابة قصيرة، مقالي، حالات عملية) بمدة لا تقل عن ساعتين — ثم تمرّ الأسئلة على مراجعتك واعتمادك قبل نشرها للطلاب.
                </div>
              ) : (
                <div className="space-y-3">
                  {exams.map((e) => (
                    <div key={e.id} className="rounded-xl border border-slate-100 bg-white p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-xs font-extrabold text-[#0f2b46]">{e.title}</h3>
                            <Badge variant="outline" className="border-[#0f2b46]/30 text-[9px] font-bold text-[#0f2b46]">
                              <Layers className="ml-0.5 h-2.5 w-2.5" /> {e.semester === 2 ? 'الفصل الثاني' : 'الفصل الأول'}
                            </Badge>
                            {e.status === 'GENERATING' && (
                              <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">
                                <Loader2 className="ml-1 h-3 w-3 animate-spin" /> جاري التوليد والتحليل ({e.questionCount} سؤالاً حتى الآن)...
                              </Badge>
                            )}
                            {e.status === 'REVIEW' && (
                              <Badge className="bg-[#f7edd0] text-[#a8841a] hover:bg-[#f7edd0]">
                                <FileCheck2 className="ml-1 h-3 w-3" /> بانتظار مراجعتك واعتماد الأسئلة ({e.pendingReview} سؤالاً)
                              </Badge>
                            )}
                            {e.status === 'READY' && (
                              <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                                <CheckCircle2 className="ml-1 h-3 w-3" /> منشور للطلاب
                              </Badge>
                            )}
                            {e.status === 'FAILED' && (
                              <Badge className="bg-red-100 text-red-700 hover:bg-red-100"><XCircle className="ml-1 h-3 w-3" /> فشل</Badge>
                            )}
                          </div>
                          {e.status === 'FAILED' && e.errorNote && (
                            <p className="mt-1.5 flex items-center gap-1 text-[11px] font-bold text-red-500">
                              <AlertTriangle className="h-3 w-3" /> {e.errorNote} — تم حفظ {e.questionCount} سؤالاً، اضغط زر الاستكمال الدائري لمتابعة التوليد من حيث توقف
                            </p>
                          )}
                          {e.status === 'REVIEW' && e.questionCount < FULL_EXAM_TARGET && (
                            <div className="mt-3 rounded-xl border border-orange-200 bg-orange-50/80 p-3">
                              <p className="text-[11px] font-bold leading-relaxed text-orange-800">
                                هذا امتحان جزئي فقط: {e.questionCount} من {FULL_EXAM_TARGET} سؤال. لا تنشره الآن إلا إذا كنت تريد امتحاناً مختصراً؛ اضغط استكمال التوليد ليكمل من الكتب دون تكرار.
                              </p>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => resumeExam(e)}
                                disabled={generating || hasGeneratingExam}
                                className="mt-2 h-8 border-orange-300 text-[10px] font-black text-orange-700 hover:bg-orange-100"
                              >
                                {generating ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                                استكمال بقية الامتحان من الكتب
                              </Button>
                            </div>
                          )}
                          {e.status === 'GENERATING' && (
                            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
                              <p className="text-[11px] font-bold leading-relaxed text-amber-800">
                                التوليد يعمل على دفعات. إن بقي الرقم صفراً أو أردت إيقافه، استخدم الأزرار التالية: الإيقاف يحفظ ما تم توليده ويفتح المراجعة، والتحريك ينشئ دفعة أولية فوراً إذا كان عالقاً.
                              </p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  variant="destructive"
                                  onClick={() => stopExam(e)}
                                  disabled={stoppingExamId === e.id}
                                  className="h-8 text-[10px] font-black"
                                >
                                  {stoppingExamId === e.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <StopCircle className="ml-1 h-3.5 w-3.5" />}
                                  إيقاف التوليد وفتح المراجعة
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => resumeExam(e)}
                                  disabled={generating}
                                  className="h-8 border-amber-300 text-[10px] font-black text-amber-700 hover:bg-amber-100"
                                >
                                  {generating ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                                  تحريك / استكمال الآن
                                </Button>
                                {e.questionCount > 0 && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => setReviewingExam({ id: e.id, title: e.title })}
                                    className="h-8 border-[#c9a227]/40 text-[10px] font-black text-[#a8841a] hover:bg-[#f7edd0]"
                                  >
                                    <FileCheck2 className="ml-1 h-3 w-3" /> معاينة {e.questionCount} سؤال
                                  </Button>
                                )}
                              </div>
                            </div>
                          )}
                          {e.status === 'READY' && (
                            <>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {Object.entries(e.byType).map(([t, n]) => (
                                  <Badge key={t} variant="outline" className="border-[#c9a227]/40 text-[10px] font-bold text-[#a8841a]">
                                    {n} {TYPE_AR[t] || t}
                                  </Badge>
                                ))}
                              </div>
                              <p className="mt-2 flex flex-wrap items-center gap-3 text-[11px] font-black text-[#0f2b46]">
                                <span className="flex items-center gap-1"><ClipboardList className="h-3.5 w-3.5 text-[#a8841a]" /> {e.questionCount} سؤالاً</span>
                                <span className="flex items-center gap-1"><Hourglass className="h-3.5 w-3.5 text-[#a8841a]" /> {e.durationMin} دقيقة</span>
                                <span>{e.totalPoints} نقطة</span>
                                <span>· {e.attemptsCount} محاولة طلاب</span>
                              </p>
                              {e.booksUsed && (
                                <p className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-slate-400">بُني على: {e.booksUsed}</p>
                              )}
                            </>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          {e.status === 'GENERATING' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => stopExam(e)}
                              disabled={stoppingExamId === e.id}
                              className="text-red-500 hover:bg-red-50 hover:text-red-700"
                              title="إيقاف التوليد والاحتفاظ بما تم توليده للمراجعة"
                            >
                              {stoppingExamId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <StopCircle className="h-3.5 w-3.5" />}
                            </Button>
                          )}
                          {e.status === 'GENERATING' && e.questionCount > 0 && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setReviewingExam({ id: e.id, title: e.title })}
                              className="h-8 border-[#c9a227]/40 text-[10px] font-black text-[#a8841a] hover:bg-[#f7edd0]"
                              title="معاينة الأسئلة التي تم توليدها حتى الآن"
                            >
                              <FileCheck2 className="ml-1 h-3 w-3" /> معاينة
                            </Button>
                          )}
                          {e.status === 'REVIEW' && e.questionCount < FULL_EXAM_TARGET && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => resumeExam(e)}
                              disabled={generating || hasGeneratingExam}
                              className="text-orange-600 hover:bg-orange-50 hover:text-orange-700"
                              title="استكمال بقية الامتحان من الكتب دون تكرار"
                            >
                              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            </Button>
                          )}
                          {(e.status === 'REVIEW' || e.status === 'READY') && (
                            <Button size="sm" onClick={() => setReviewingExam({ id: e.id, title: e.title })}
                              className={`h-8 text-[10px] font-black ${e.status === 'REVIEW' ? 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]' : 'border border-[#0f2b46]/20 bg-transparent text-[#0f2b46] hover:bg-slate-50'}`}>
                              <FileCheck2 className="ml-1 h-3 w-3" />
                              {e.status === 'REVIEW' ? 'مراجعة الأسئلة واعتمادها' : 'عرض الأسئلة المعتمدة'}
                            </Button>
                          )}
                          {e.status === 'FAILED' && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => resumeExam(e)}
                              disabled={generating || exams.some((x) => x.status === 'GENERATING')}
                              className="text-amber-600 hover:bg-amber-50 hover:text-amber-700"
                              title="استكمال التوليد من حيث توقف دون حذف الأسئلة السابقة"
                            >
                              {generating || exams.some((x) => x.status === 'GENERATING') ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                            </Button>
                          )}
                          {(e.status === 'FAILED' || e.status === 'REVIEW' || e.status === 'READY') && (
                            <Button size="sm" variant="ghost" onClick={() => deleteExam(e.id)} className="text-red-400 hover:bg-red-50 hover:text-red-600" title="حذف الامتحان بالكامل">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
                ملاحظة: التوليد يتم على مراحل (مفاهيم ← تطبيق ← تحليل ← مقالي ← حالات عملية) وتظهر الأسئلة تدريجياً بعد كل دفعة. يمكنك إيقاف التوليد من زر الإيقاف بجانب الامتحان، وما تم توليده ينتقل للمراجعة.
                بعد التوليد أو الإيقاف تمرّ الأسئلة على مراجعتك (تعديل/اعتماد/رفض/حذف سؤال) ولا يراها الطالب إلا بعد اعتمادها ونشرها — عندها يصل إشعار لكل الطلاب المسجلين.
              </p>
            </CardContent>
          </Card>

          {/* 12.2: الاعتراضات على النتائج */}
          <AdminAppealsSection />
          </TabsContent>
        </Tabs>
        </>
      )}

      <Dialog open={bankExamDialogOpen} onOpenChange={setBankExamDialogOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">توليد امتحان من بنك الأسئلة</DialogTitle>
            <DialogDescription>اختر إعدادات الامتحان مرة واحدة بدل النوافذ المتتالية. سيتم استخدام الأسئلة المعتمدة فقط من نفس البرنامج.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">الفصل</label>
                <select value={bankExamForm.semester} onChange={(e) => setBankExamForm((p) => ({ ...p, semester: e.target.value }))} className="h-10 w-full rounded-xl border px-3 text-sm font-bold">
                  <option value="1">الفصل الأول</option>
                  <option value="2">الفصل الثاني</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">عدد الأسئلة</label>
                <Input value={bankExamForm.count} onChange={(e) => setBankExamForm((p) => ({ ...p, count: e.target.value }))} inputMode="numeric" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-black text-slate-500">الوحدة / اختياري</label>
                <select value={bankExamForm.unitId} onChange={(e) => setBankExamForm((p) => ({ ...p, unitId: e.target.value }))} className="h-10 w-full rounded-xl border px-3 text-sm font-bold">
                  <option value="">كل أسئلة الفصل/البرنامج</option>
                  {bankExamUnits.map((u) => <option key={u.id} value={u.id}>{u.title}</option>)}
                </select>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h4 className="mb-3 text-xs font-black text-[#0f2b46]">توزيع الصعوبة</h4>
              <div className="grid gap-3 md:grid-cols-3">
                <Input value={bankExamForm.easy} onChange={(e) => setBankExamForm((p) => ({ ...p, easy: e.target.value }))} placeholder="سهل" inputMode="numeric" />
                <Input value={bankExamForm.medium} onChange={(e) => setBankExamForm((p) => ({ ...p, medium: e.target.value }))} placeholder="متوسط" inputMode="numeric" />
                <Input value={bankExamForm.advanced} onChange={(e) => setBankExamForm((p) => ({ ...p, advanced: e.target.value }))} placeholder="متقدم" inputMode="numeric" />
              </div>
              <p className="mt-2 text-[11px] font-bold text-slate-500">الأرقام تُعامل كأوزان نسبية، مثل 25 / 50 / 25.</p>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <h4 className="mb-3 text-xs font-black text-[#0f2b46]">توزيع أنواع الأسئلة</h4>
              <div className="grid gap-3 md:grid-cols-4">
                <Input value={bankExamForm.mcq} onChange={(e) => setBankExamForm((p) => ({ ...p, mcq: e.target.value }))} placeholder="اختيار متعدد" inputMode="numeric" />
                <Input value={bankExamForm.tf} onChange={(e) => setBankExamForm((p) => ({ ...p, tf: e.target.value }))} placeholder="صح/خطأ" inputMode="numeric" />
                <Input value={bankExamForm.short} onChange={(e) => setBankExamForm((p) => ({ ...p, short: e.target.value }))} placeholder="قصير" inputMode="numeric" />
                <Input value={bankExamForm.essay} onChange={(e) => setBankExamForm((p) => ({ ...p, essay: e.target.value }))} placeholder="مقالي" inputMode="numeric" />
              </div>
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setBankExamDialogOpen(false)}>إلغاء</Button>
              <Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#12365c]" disabled={questionBankBusy === `exam-${bankExamForm.semester}`} onClick={generateExamFromQuestionBank}>
                {questionBankBusy === `exam-${bankExamForm.semester}` ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                توليد الامتحان
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={questionBankOpen} onOpenChange={setQuestionBankOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">مراجعة بنك الأسئلة المركزي</DialogTitle>
            <DialogDescription>أسئلة البرنامج المحدد فقط. لا تُستخدم في توليد الامتحانات إلا الأسئلة المعتمدة.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2 rounded-2xl bg-slate-50 p-3 md:grid-cols-4">
              <Input value={questionBankFilter.search} onChange={(e) => setQuestionBankFilter((p) => ({ ...p, search: e.target.value }))} placeholder="بحث في السؤال أو الإجابة" className="bg-white text-xs" />
              <select value={questionBankFilter.status} onChange={(e) => setQuestionBankFilter((p) => ({ ...p, status: e.target.value }))} className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold">
                <option value="ALL">كل الحالات</option><option value="PENDING_REVIEW">بانتظار المراجعة</option><option value="APPROVED">معتمد</option><option value="REJECTED">مرفوض</option><option value="ARCHIVED">مؤرشف</option>
              </select>
              <select value={questionBankFilter.type} onChange={(e) => setQuestionBankFilter((p) => ({ ...p, type: e.target.value }))} className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold">
                <option value="ALL">كل الأنواع</option><option value="MCQ">اختيار متعدد</option><option value="TF">صح/خطأ</option><option value="SHORT">قصير</option><option value="ESSAY">مقالي</option>
              </select>
              <select value={questionBankFilter.difficulty} onChange={(e) => setQuestionBankFilter((p) => ({ ...p, difficulty: e.target.value }))} className="h-10 rounded-xl border border-slate-200 bg-white px-3 text-xs font-bold">
                <option value="ALL">كل الصعوبات</option><option value="EASY">سهل</option><option value="MEDIUM">متوسط</option><option value="ADVANCED">متقدم</option>
              </select>
            </div>
            <p className="text-[11px] font-bold text-slate-400">المعروض: {filteredQuestionBankItems.length} من {questionBankItems.length} سؤال</p>
            {questionBankItems.length === 0 ? <p className="rounded-xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد أسئلة في البنك بعد.</p> : filteredQuestionBankItems.length === 0 ? <p className="rounded-xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد أسئلة مطابقة للفلترة.</p> : filteredQuestionBankItems.map((q) => {
              let options: string[] = []
              try { options = q.options ? JSON.parse(q.options) : [] } catch {}
              return (
                <article key={q.id} className="rounded-2xl border border-slate-200 bg-white p-4 text-xs">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-2">
                      <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{q.type}</Badge>
                      <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">{q.difficulty || 'MEDIUM'}</Badge>
                      <Badge className={q.status === 'APPROVED' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : q.status === 'REJECTED' ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>
                        {q.status === 'APPROVED' ? 'معتمد' : q.status === 'REJECTED' ? 'مرفوض' : 'بانتظار المراجعة'}
                      </Badge>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={questionBankBusy === q.id} onClick={() => openEditBankQuestion(q)} className="text-xs font-black">تعديل</Button>
                      <Button size="sm" disabled={questionBankBusy === q.id} onClick={() => updateQuestionBankStatus(q.id, 'APPROVED')} className="bg-emerald-700 text-xs font-black text-white hover:bg-emerald-800">اعتماد</Button>
                      <Button size="sm" variant="outline" disabled={questionBankBusy === q.id} onClick={() => updateQuestionBankStatus(q.id, 'REJECTED')} className="border-red-200 text-xs font-black text-red-700">رفض</Button>
                      <Button size="sm" variant="outline" disabled={questionBankBusy === q.id} onClick={() => updateQuestionBankStatus(q.id, 'ARCHIVED')} className="text-xs font-black">أرشفة</Button>
                    </div>
                  </div>
                  <p className="rounded-xl bg-slate-50 p-3 text-sm font-bold leading-7 text-[#0f2b46]">{q.text}</p>
                  {options.length > 0 && <p className="mt-2 font-bold text-slate-500">الخيارات: {options.join(' — ')}</p>}
                  {q.modelAnswer && <p className="mt-2 rounded-xl bg-blue-50 p-3 font-bold leading-6 text-blue-700">الإجابة النموذجية: {q.modelAnswer}</p>}
                  {q.sourceEvidence && <p className="mt-2 rounded-xl bg-[#fffaf0] p-3 font-bold leading-6 text-[#8a6d16]">الدليل العلمي: {q.sourceEvidence}</p>}
                </article>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingBankQuestion} onOpenChange={(open) => !open && setEditingBankQuestion(null)}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">تعديل سؤال في بنك الأسئلة</DialogTitle>
            <DialogDescription>يمكن تعديل السؤال قبل اعتماده أو إعادة اعتماده. التعديل يبقى داخل نفس البرنامج.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <select value={editingBankQuestionForm.type} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, type: e.target.value }))} className="h-10 rounded-xl border px-3 text-sm font-bold"><option value="MCQ">اختيار متعدد</option><option value="TF">صح/خطأ</option><option value="SHORT">قصير</option><option value="ESSAY">مقالي</option></select>
              <select value={editingBankQuestionForm.difficulty} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, difficulty: e.target.value }))} className="h-10 rounded-xl border px-3 text-sm font-bold"><option value="EASY">سهل</option><option value="MEDIUM">متوسط</option><option value="ADVANCED">متقدم</option></select>
              <Input value={editingBankQuestionForm.correctAnswer} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, correctAnswer: e.target.value }))} placeholder="الإجابة الصحيحة 0" />
            </div>
            <Textarea value={editingBankQuestionForm.text} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, text: e.target.value }))} placeholder="نص السؤال" className="min-h-24" />
            {(editingBankQuestionForm.type === 'MCQ' || editingBankQuestionForm.type === 'TF') && <Textarea value={editingBankQuestionForm.options} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, options: e.target.value }))} placeholder="الخيارات — خيار في كل سطر" className="min-h-24" />}
            <Textarea value={editingBankQuestionForm.modelAnswer} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, modelAnswer: e.target.value }))} placeholder="الإجابة النموذجية / التعليل" className="min-h-20" />
            <Textarea value={editingBankQuestionForm.sourceEvidence} onChange={(e) => setEditingBankQuestionForm((p) => ({ ...p, sourceEvidence: e.target.value }))} placeholder="الدليل العلمي أو المصدر" className="min-h-16" />
            <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setEditingBankQuestion(null)}>إلغاء</Button><Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={questionBankBusy === editingBankQuestion?.id || editingBankQuestionForm.text.trim().length < 8} onClick={saveEditedBankQuestion}>{questionBankBusy === editingBankQuestion?.id ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ التعديل</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={manualQuestionOpen} onOpenChange={setManualQuestionOpen}>
        <DialogContent className="max-w-2xl" dir="rtl">
          <DialogHeader>
            <DialogTitle className="font-black text-[#0f2b46]">إضافة سؤال يدوي</DialogTitle>
            <DialogDescription>سيُحفظ السؤال في بنك الأسئلة المركزي للبرنامج الحالي.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <select value={manualQuestion.type} onChange={(e) => setManualQuestion((p) => ({ ...p, type: e.target.value }))} className="h-10 rounded-xl border px-3 text-sm font-bold"><option value="MCQ">اختيار متعدد</option><option value="TF">صح/خطأ</option><option value="SHORT">قصير</option><option value="ESSAY">مقالي</option></select>
              <select value={manualQuestion.difficulty} onChange={(e) => setManualQuestion((p) => ({ ...p, difficulty: e.target.value }))} className="h-10 rounded-xl border px-3 text-sm font-bold"><option value="EASY">سهل</option><option value="MEDIUM">متوسط</option><option value="ADVANCED">متقدم</option></select>
              <Input value={manualQuestion.correctAnswer} onChange={(e) => setManualQuestion((p) => ({ ...p, correctAnswer: e.target.value }))} placeholder="الإجابة الصحيحة 0" />
            </div>
            <Textarea value={manualQuestion.text} onChange={(e) => setManualQuestion((p) => ({ ...p, text: e.target.value }))} placeholder="نص السؤال" className="min-h-20" />
            {(manualQuestion.type === 'MCQ' || manualQuestion.type === 'TF') && <Textarea value={manualQuestion.options} onChange={(e) => setManualQuestion((p) => ({ ...p, options: e.target.value }))} placeholder="الخيارات — خيار في كل سطر" className="min-h-24" />}
            <Textarea value={manualQuestion.modelAnswer} onChange={(e) => setManualQuestion((p) => ({ ...p, modelAnswer: e.target.value }))} placeholder="الإجابة النموذجية / التعليل" className="min-h-20" />
            <Textarea value={manualQuestion.sourceEvidence} onChange={(e) => setManualQuestion((p) => ({ ...p, sourceEvidence: e.target.value }))} placeholder="الدليل العلمي أو المصدر" className="min-h-16" />
            <label className="flex items-center gap-2 text-xs font-black text-slate-600"><input type="checkbox" checked={manualQuestion.approveNow} onChange={(e) => setManualQuestion((p) => ({ ...p, approveNow: e.target.checked }))} /> اعتماد السؤال مباشرة</label>
            <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setManualQuestionOpen(false)}>إلغاء</Button><Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={questionBankBusy === 'manual' || manualQuestion.text.trim().length < 8} onClick={addManualQuestionToBank}>{questionBankBusy === 'manual' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} حفظ</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={importQuestionsOpen} onOpenChange={setImportQuestionsOpen}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto" dir="rtl">
          <DialogHeader><DialogTitle className="font-black text-[#0f2b46]">استيراد أسئلة</DialogTitle><DialogDescription>اختر ملف JSON أو CSV/TSV، أو الصق المحتوى يدويًا. الأعمدة: type, question, option1, option2, option3, option4, correctAnswer, modelAnswer, difficulty, sourceEvidence</DialogDescription></DialogHeader>
          <div className="space-y-3">
            <div className="rounded-2xl border border-dashed border-[#c9a227]/50 bg-[#fffaf0] p-3">
              <label className="block text-xs font-black text-[#0f2b46]">اختيار ملف الأسئلة من الجهاز</label>
              <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">الأفضل اختيار الملف مباشرة من الجوال بدل لصق نص طويل. يدعم JSON و CSV و TSV.</p>
              <input
                type="file"
                accept=".json,.csv,.tsv,application/json,text/csv,text/tab-separated-values,text/plain"
                className="mt-3 w-full rounded-xl border border-slate-200 bg-white p-2 text-xs font-bold"
                onChange={async (e) => {
                  const file = e.currentTarget.files?.[0]
                  if (!file) return
                  setImportQuestionsText(await file.text())
                  e.currentTarget.value = ''
                }}
              />
            </div>
            <Textarea value={importQuestionsText} onChange={(e) => setImportQuestionsText(e.target.value)} dir="ltr" className="max-h-72 min-h-40 text-xs leading-6 sm:min-h-72" placeholder='[{"type":"MCQ","text":"نص السؤال","options":["أ","ب","ج","د"],"correctAnswer":"0"}]' />
            <label className="flex items-center gap-2 text-xs font-black text-slate-600"><input type="checkbox" checked={importApproveNow} onChange={(e) => setImportApproveNow(e.target.checked)} /> اعتماد الأسئلة المستوردة مباشرة</label>
            <div className="mt-3 flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setImportQuestionsOpen(false)}>إلغاء</Button><Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={questionBankBusy === 'import' || importQuestionsText.trim().length < 10} onClick={importQuestionsToBank}>{questionBankBusy === 'import' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} استيراد</Button></div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={examImportOpen} onOpenChange={setExamImportOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto" dir="rtl">
          <DialogHeader><DialogTitle className="font-black text-[#0f2b46]">نسخ أسئلة من اختبار موجود</DialogTitle><DialogDescription>اختر أسئلة من اختبار في نفس البرنامج لنسخها إلى البنك المركزي.</DialogDescription></DialogHeader>
          {questionBankBusy === 'exam-load' ? <div className="flex h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div> : examImportItems.length === 0 ? <p className="rounded-xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد اختبارات بأسئلة لهذا البرنامج.</p> : (
            <div className="space-y-4">
              <select value={selectedImportExamId} onChange={(e) => { const id = e.target.value; const ex = examImportItems.find((x) => x.id === id); setSelectedImportExamId(id); setSelectedImportQuestionIds(ex?.questions?.map((q) => q.id) || []) }} className="h-11 w-full rounded-xl border px-3 text-sm font-bold">
                {examImportItems.map((exam) => <option key={exam.id} value={exam.id}>{exam.title} — فصل {exam.semester} — {exam.questions.length} سؤال</option>)}
              </select>
              <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setSelectedImportQuestionIds(selectedImportExam?.questions?.map((q) => q.id) || [])}>تحديد الكل</Button><Button size="sm" variant="outline" onClick={() => setSelectedImportQuestionIds([])}>إلغاء التحديد</Button><label className="flex items-center gap-2 text-xs font-black text-slate-600"><input type="checkbox" checked={examImportApproveNow} onChange={(e) => setExamImportApproveNow(e.target.checked)} /> اعتماد مباشرة</label></div>
              <div className="space-y-2">{(selectedImportExam?.questions || []).map((q) => { const checked = selectedImportQuestionIds.includes(q.id); return <label key={q.id} className={`block cursor-pointer rounded-2xl border p-3 text-xs ${checked ? 'border-[#c9a227] bg-[#fffaf0]' : 'border-slate-200 bg-white'}`}><div className="flex gap-2"><input type="checkbox" checked={checked} onChange={(e) => setSelectedImportQuestionIds((prev) => e.target.checked ? Array.from(new Set([...prev, q.id])) : prev.filter((id) => id !== q.id))} /><p className="font-black leading-7 text-[#0f2b46]">{q.text}</p></div></label> })}</div>
              <div className="flex gap-2"><Button variant="outline" className="flex-1" onClick={() => setExamImportOpen(false)}>إلغاء</Button><Button className="flex-1 bg-[#0f2b46] font-black text-[#f5f0e1]" disabled={questionBankBusy === 'exam-copy' || selectedImportQuestionIds.length === 0} onClick={copyExamQuestionsToBank}>{questionBankBusy === 'exam-copy' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} نسخ {selectedImportQuestionIds.length} سؤال</Button></div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!gradingDialog} onOpenChange={(open) => { if (!open) setGradingDialog(null) }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-3xl" dir="rtl">
          {gradingDialog && (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
                  <CheckCircle2 className="h-5 w-5 text-[#a8841a]" />
                  {gradingDialog.mode === 'GRADE' ? 'تصحيح تسليم الواجب' : 'طلب تعديل الواجب'}
                </DialogTitle>
                <DialogDescription className="font-bold leading-6">
                  {gradingDialog.assignment.title} — {gradingDialog.submission.studentName || 'طالب'}
                </DialogDescription>
              </DialogHeader>
              <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 text-xs font-bold leading-6 text-slate-600">
                {gradingDialog.submission.answerText ? gradingDialog.submission.answerText.slice(0, 1200) : 'لا يوجد نص مكتوب، راجع الملف المرفق إن وجد.'}
                {gradingDialog.submission.answerText && gradingDialog.submission.answerText.length > 1200 ? '…' : ''}
                {gradingDialog.submission.fileName && (
                  <a href={`/api/admin/assignments/file?id=${gradingDialog.submission.id}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-[#1d4ed8] hover:bg-blue-100">
                    <FileText className="h-3 w-3" /> فتح الملف المرفق: {gradingDialog.submission.fileName}
                  </a>
                )}
              </div>
              {gradingDialog.assignment.rubric && (
                <div className="rounded-2xl border border-[#c9a227]/20 bg-[#fffaf0] p-3 text-xs font-bold leading-6 text-[#7a5b13]">
                  <b>معايير التصحيح:</b> {gradingDialog.assignment.rubric}
                </div>
              )}
              {gradingDialog.mode === 'GRADE' && (
                <div className="space-y-2">
                  <Label className="text-xs font-black text-[#0f2b46]">الدرجة من {gradingDialog.assignment.points}</Label>
                  <Input
                    value={gradingDialog.score}
                    onChange={(e) => setGradingDialog((prev) => prev ? { ...prev, score: e.target.value } : prev)}
                    inputMode="decimal"
                    placeholder={`0 - ${gradingDialog.assignment.points}`}
                    className="h-12 rounded-2xl text-center text-lg font-black"
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label className="text-xs font-black text-[#0f2b46]">ملاحظة للطالب</Label>
                <Textarea
                  value={gradingDialog.feedback}
                  onChange={(e) => setGradingDialog((prev) => prev ? { ...prev, feedback: e.target.value } : prev)}
                  placeholder={gradingDialog.mode === 'GRADE' ? 'اكتب تغذية راجعة مختصرة للطالب' : 'وضح المطلوب تعديله قبل إعادة التسليم'}
                  className="min-h-28 rounded-2xl text-sm font-bold leading-7"
                />
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button variant="outline" onClick={() => setGradingDialog(null)} className="flex-1 rounded-2xl font-black">إلغاء</Button>
                <Button onClick={submitGradingDialog} disabled={gradingSubmissionId === gradingDialog.submission.id} className={gradingDialog.mode === 'GRADE' ? 'flex-1 rounded-2xl bg-emerald-600 font-black text-white hover:bg-emerald-700' : 'flex-1 rounded-2xl bg-amber-600 font-black text-white hover:bg-amber-700'}>
                  {gradingSubmissionId === gradingDialog.submission.id ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                  {gradingDialog.mode === 'GRADE' ? 'اعتماد التصحيح' : 'إرسال طلب التعديل'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* حوار مراجعة الأسئلة قبل النشر */}
      {reviewingExam && (
        <QuestionReviewDialog
          examId={reviewingExam.id}
          examTitle={reviewingExam.title}
          open={!!reviewingExam}
          onClose={() => setReviewingExam(null)}
          onPublished={() => programId && loadProgramData(programId, true)}
        />
      )}
    </div>
  )
}
