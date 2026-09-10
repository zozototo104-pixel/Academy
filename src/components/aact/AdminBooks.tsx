'use client'

import { api } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  BookMarked, Loader2, Plus, Sparkles, Trash2, FileText, Bot,
  Hourglass, RefreshCw, Upload, CheckCircle2, AlertTriangle, XCircle, ClipboardList,
  Layers, FileCheck2, Link2, StopCircle,
} from 'lucide-react'
import { QuestionReviewDialog, AdminAppealsSection } from '@/components/aact/AdminExamReview'

const FULL_EXAM_TARGET = 80

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
  hasFile: boolean
}

interface Suggestion {
  title: string
  titleEn: string
  author: string
  year: string
  reason: string
  link: string
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
const CAT_AR: Record<string, string> = { DOCTORATE: 'الدكتوراه المهنية', MASTERS: 'الماجستير المهني', DIPLOMA: 'الدبلومات المهنية', INTL_CERT: 'الشهادات الدولية', ACCREDITATION: 'اعتماد' }
const CAT_ORDER = ['MASTERS', 'DOCTORATE', 'DIPLOMA', 'INTL_CERT', 'ACCREDITATION']

export function AdminBooksTab() {
  const { toast } = useToast()
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [selectedCategory, setSelectedCategory] = useState<string>('')
  const [programId, setProgramId] = useState<string>('')
  const [books, setBooks] = useState<BookRow[]>([])
  const [exams, setExams] = useState<ExamRow[]>([])
  const [assignments, setAssignments] = useState<AssignmentRow[]>([])
  const [knowledgeItems, setKnowledgeItems] = useState<KnowledgeItemRow[]>([])
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>({})
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingBooks, setLoadingBooks] = useState(false)
  const [adding, setAdding] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [stoppingExamId, setStoppingExamId] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', titleEn: '', author: '', year: '', description: '', semester: '', link: '' })
  const [assignmentForm, setAssignmentForm] = useState({ id: '', title: '', description: '', semester: '1', type: 'REPORT', points: '10', weight: '0', dueDays: '', rubric: '', status: 'PUBLISHED' })
  const [savingAssignment, setSavingAssignment] = useState(false)
  const [gradingSubmissionId, setGradingSubmissionId] = useState<string | null>(null)
  const [rebuildingKnowledge, setRebuildingKnowledge] = useState(false)
  const [rebuildingBookId, setRebuildingBookId] = useState<string | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const advanceRef = useRef(false)
  const [genSemester, setGenSemester] = useState('1')
  const [reviewingExam, setReviewingExam] = useState<{ id: string; title: string } | null>(null)

  useEffect(() => {
    api<{ programs: ProgramOption[] }>('/api/programs')
      .then((d) => setPrograms(d.programs))
      .catch(() => {})
      .finally(() => setLoading(false))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

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

  const loadProgramData = useCallback(async (pid: string, silent = false) => {
    if (!pid) return
    if (!silent) setLoadingBooks(true)
    try {
      const [b, e, a, k] = await Promise.all([
        api<{ books: BookRow[] }>(`/api/admin/books?programId=${pid}`),
        api<{ exams: ExamRow[] }>(`/api/admin/program-exams?programId=${pid}`),
        api<{ assignments: AssignmentRow[] }>(`/api/admin/assignments?programId=${pid}`),
        api<{ items: KnowledgeItemRow[]; stats: KnowledgeStats }>(`/api/admin/knowledge-bank?programId=${pid}`).catch(() => ({ items: [] as KnowledgeItemRow[], stats: {} as KnowledgeStats })),
      ])
      setBooks(b.books)
      setExams(e.exams)
      setAssignments(a.assignments)
      setKnowledgeItems(k.items || [])
      setKnowledgeStats(k.stats || {})
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
    setAdding(true)
    try {
      const fd = new FormData()
      fd.append('programId', programId)
      fd.append('title', title)
      fd.append('titleEn', payload?.titleEn ?? form.titleEn)
      fd.append('author', payload?.author ?? form.author)
      fd.append('year', payload?.year ?? form.year)
      fd.append('description', payload?.reason ?? form.description)
      fd.append('semester', payload ? '' : form.semester)
      fd.append('link', payload ? payload.link || '' : form.link)
      if (!payload && file) fd.append('file', file)
      const d = await api<{ book: BookRow; textExtracted: boolean; linkNote?: string | null; knowledgeItemsInserted?: number }>('/api/admin/books', { method: 'POST', body: fd })
      setBooks((prev) => [...prev, { ...d.book, hasFile: !!d.book.fileName, source: d.book.source || 'ADMIN' }])
      if (!payload) {
        setForm({ title: '', titleEn: '', author: '', year: '', description: '', semester: '', link: '' })
        setFile(null)
        if (fileRef.current) fileRef.current.value = ''
      }
      await loadProgramData(programId, true)
      toast({
        title: 'تمت إضافة الكتاب',
        description: d.knowledgeItemsInserted
          ? `تمت قراءة الكتاب وبناء ${d.knowledgeItemsInserted} عنصر معرفة للامتحانات والمشرف الذكي`
          : d.textExtracted
            ? 'تمت قراءة محتوى الملف/الرابط — ويمكنك تحديث بنك المعرفة عند الحاجة'
            : d.linkNote || 'أُضيف إلى الكتب المقررة للتخصص',
      })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setAdding(false)
    }
  }

  const deleteBook = async (id: string) => {
    if (!confirm('حذف هذا الكتاب من الكتب المقررة؟')) return
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
      const d = await api<{ count: number; items: KnowledgeItemRow[]; stats: KnowledgeStats; result?: { totalInserted?: number } }>('/api/admin/knowledge-bank', {
        method: 'POST',
        body: JSON.stringify({ programId, action: 'rebuild' }),
      })
      setKnowledgeItems(d.items || [])
      setKnowledgeStats(d.stats || {})
      toast({ title: 'تم بناء بنك المعرفة', description: `استخرج النظام ${d.result?.totalInserted || d.count || 0} عنصر معرفة من الكتب المقررة` })
    } catch (e: any) {
      toast({ title: 'تعذر بناء بنك المعرفة', description: e.message, variant: 'destructive' })
    } finally {
      setRebuildingKnowledge(false)
    }
  }

  const rebuildBookKnowledge = async (bookId: string) => {
    if (!programId) return
    setRebuildingBookId(bookId)
    try {
      const d = await api<{ count: number; items: KnowledgeItemRow[]; stats: KnowledgeStats; result?: { inserted?: number } }>('/api/admin/knowledge-bank', {
        method: 'POST',
        body: JSON.stringify({ bookId, action: 'rebuild-book' }),
      })
      setKnowledgeItems(d.items || [])
      setKnowledgeStats(d.stats || {})
      toast({ title: 'تم تحليل الكتاب', description: `تم استخراج ${d.result?.inserted || 0} عنصر معرفة من هذا الكتاب` })
    } catch (e: any) {
      toast({ title: 'تعذر تحليل الكتاب', description: e.message, variant: 'destructive' })
    } finally {
      setRebuildingBookId(null)
    }
  }

  const resetAssignmentForm = () => setAssignmentForm({ id: '', title: '', description: '', semester: '1', type: 'REPORT', points: '10', weight: '0', dueDays: '', rubric: '', status: 'PUBLISHED' })

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
    if (!programId || !confirm('حذف هذا الواجب وكل تسليماته؟ هذا الإجراء نهائي.')) return
    try {
      await api(`/api/admin/assignments?id=${id}`, { method: 'DELETE' })
      await loadProgramData(programId, true)
      toast({ title: 'تم حذف الواجب' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  const gradeSubmission = async (submission: AssignmentSubmissionRow, assignment: AssignmentRow) => {
    if (!programId) return
    const rawScore = window.prompt(`درجة الطالب من ${assignment.points}`, submission.score != null ? String(submission.score) : '')
    if (rawScore === null) return
    const rawFeedback = window.prompt('ملاحظة التصحيح أو التغذية الراجعة', submission.feedback || '')
    if (rawFeedback === null) return
    setGradingSubmissionId(submission.id)
    try {
      await api('/api/admin/assignments', {
        method: 'PATCH',
        body: JSON.stringify({ submissionId: submission.id, score: rawScore, feedback: rawFeedback, status: 'GRADED' }),
      })
      await loadProgramData(programId, true)
      toast({ title: 'تم تصحيح الواجب', description: `${submission.studentName || 'الطالب'} — ${rawScore}/${assignment.points}` })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setGradingSubmissionId(null)
    }
  }

  const requestAssignmentRevision = async (submission: AssignmentSubmissionRow) => {
    if (!programId) return
    const rawFeedback = window.prompt('اكتب سبب طلب التعديل للطالب', submission.feedback || '')
    if (rawFeedback === null) return
    setGradingSubmissionId(submission.id)
    try {
      await api('/api/admin/assignments', {
        method: 'PATCH',
        body: JSON.stringify({ submissionId: submission.id, feedback: rawFeedback, status: 'NEEDS_REVISION' }),
      })
      await loadProgramData(programId, true)
      toast({ title: 'تم طلب تعديل الواجب' })
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
      toast({ title: 'اقتراحات خبير الذكاء الاصطناعي جاهزة', description: `${d.suggestions.length} كتاباً مقترحاً وفق واقع التخصص عالمياً` })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSuggesting(false)
    }
  }

  const suggestAll = async () => {
    for (const s of suggestions.filter((x) => !x.added)) {
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
    if (!confirm(confirmText)) return
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
    if (!confirm(`سيستكمل خبير الذكاء الاصطناعي توليد ${semLabel} من حيث توقف، وسيحافظ على ${exam.questionCount} سؤالاً موجوداً حالياً. متابعة؟`)) return
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
                  setKnowledgeItems([])
                  setKnowledgeStats({})
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

          {/* بنك المعرفة الأكاديمي */}
          <Card className="border-[#c9a227]/35 bg-gradient-to-br from-white to-[#fffaf0]">
            <CardContent className="p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                    <Layers className="h-4.5 w-4.5 text-[#a8841a]" />
                    بنك المعرفة الأكاديمي ({knowledgeItems.length})
                  </h2>
                  <p className="mt-1 max-w-3xl text-[11px] font-bold leading-5 text-slate-500">
                    هذه هي المرحلة الثانية: تحويل الكتب إلى مفاهيم ونظريات وحالات ومنهجيات وبذور أسئلة. الامتحانات والمشرف الذكي يستخدمون هذه المعرفة بدلاً من الاعتماد على نص خام أو أسئلة عامة.
                  </p>
                </div>
                <Button onClick={rebuildKnowledge} disabled={rebuildingKnowledge || books.length === 0} className="bg-[#0f2b46] text-xs font-black text-[#e0b83a] hover:bg-[#12365c]">
                  {rebuildingKnowledge ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCw className="ml-2 h-4 w-4" />}
                  بناء/تحديث بنك المعرفة
                </Button>
              </div>

              <div className="grid gap-2 sm:grid-cols-4">
                {Object.entries(knowledgeStats).length ? Object.entries(knowledgeStats).slice(0, 8).map(([cat, stat]) => (
                  <div key={cat} className="rounded-2xl bg-white p-3 text-center ring-1 ring-[#c9a227]/20">
                    <p className="text-[10px] font-black text-[#a8841a]">{cat}</p>
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
                      const countForBook = knowledgeItems.filter((k) => k.bookId === b.id).length
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
                  <p className="mb-2 text-xs font-black text-[#0f2b46]">أهم عناصر المعرفة المستخرجة</p>
                  <div className="max-h-72 space-y-2 overflow-auto pr-1">
                    {knowledgeItems.length === 0 ? <p className="text-[11px] font-bold text-slate-500">سيظهر هنا ملخص المفاهيم والحالات بعد التحليل.</p> : knowledgeItems.slice(0, 12).map((item) => (
                      <article key={item.id} className="rounded-xl bg-[#f8fafc] p-3 text-[11px] font-bold leading-5 text-slate-600">
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[9px] font-black">{item.category}</Badge>
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
                {assignmentForm.id && (
                  <Button size="sm" variant="outline" onClick={resetAssignmentForm} className="text-xs font-bold">إلغاء التعديل</Button>
                )}
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
                          {a.submissions.map((s) => (
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
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

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
                        {b.hasFile && (
                          <a href={`/api/books/${b.id}/file`} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-emerald-50 px-2 py-0.5 text-[10px] font-black text-emerald-700 hover:bg-emerald-100">
                            <FileText className="h-3 w-3" /> {b.fileName} ({Math.ceil((b.size || 0) / 1024)} ك.ب)
                          </a>
                        )}
                        {b.link && (
                          <a href={b.link} target="_blank" rel="noreferrer" className="ml-1.5 mt-1.5 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700 hover:bg-blue-100">
                            <Link2 className="h-3 w-3" /> فتح رابط الكتاب
                          </a>
                        )}
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => deleteBook(b.id)} className="shrink-0 text-red-400 hover:bg-red-50 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {/* اقتراحات خبير الذكاء الاصطناعي */}
              {suggestions.length > 0 && (
                <div className="mt-4 rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/40 p-4">
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
                            <p className="mt-1 text-[10px] leading-relaxed text-slate-600">{s.reason}</p>
                            {s.link && (
                              <a href={s.link} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-0.5 text-[10px] font-black text-blue-700 hover:bg-blue-100">
                                <Link2 className="h-3 w-3" /> رابط الكتاب — تحقق منه قبل الإضافة
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
              )}

              {/* نموذج إضافة كتاب */}
              <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50/60 p-4">
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
                    <Label className="text-[10px] font-black text-slate-600">رابط الكتاب على الإنترنت (للقراءة أو التحميل — يقرأه خبير الذكاء الاصطناعي إن كان PDF أو صفحة نصية)</Label>
                    <Input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://example.com/book.pdf أو رابط صفحة الكتاب" className="mt-1 h-9 text-xs" dir="ltr" />
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
                    <Label className="text-[10px] font-black text-slate-600">ملف الكتاب (PDF / Word / Excel / TXT — يقرأه خبير الذكاء الاصطناعي لبناء الأسئلة، حتى 10 ميجابايت)</Label>
                    <div className="mt-1 flex items-center gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept=".pdf,.docx,.xlsx,.xls,.txt,.csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,text/csv"
                        onChange={(e) => setFile(e.target.files?.[0] || null)}
                        className="block w-full max-w-sm text-xs text-slate-600 file:mr-2 file:rounded-lg file:border-0 file:bg-[#0f2b46] file:px-3 file:py-1.5 file:text-[10px] file:font-black file:text-[#e0b83a]"
                      />
                      {file && <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100"><Upload className="ml-1 h-3 w-3" /> {file.name}</Badge>}
                    </div>
                  </div>
                </div>
                <Button onClick={() => addBook()} disabled={adding} className="mt-4 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                  {adding ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Plus className="ml-1 h-4 w-4" />}
                  إضافة الكتاب للكتب المقررة
                </Button>
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
        </>
      )}

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
