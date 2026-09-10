'use client'

import { useAppStore, api } from '@/lib/store'
import { buildAcademicProgramProfile } from '@/lib/program-tracks'
import { useCallback, useEffect, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { PaymentsTab, ThesisTab, CertificatesTab, TranscriptTab } from '@/components/aact/DashboardExtras'
import {
  BookOpen, ClipboardCheck, ChevronLeft, Loader2, Lock,
  Award, Bot, CheckCircle2, CircleDashed, Trophy, Banknote, FileText,
  BookMarked, Hourglass, ScrollText,
} from 'lucide-react'

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
    books?: { id?: string; title?: string; titleEn?: string | null; semester?: number | null; source?: string | null }[]
    assignments?: { id?: string; title?: string; semester?: number | null; points?: number | null; status?: string | null }[]
    exams?: { id?: string; title?: string; semester?: number | null; status?: string | null; questionCount?: number | null }[]
    academicProfile?: any
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

interface ChatMsg { id: string; role: string; content: string; createdAt: string }

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

export function DashboardView() {
  const { user, navigate, openUnit, openExam, openProgramDetails } = useAppStore()
  const { toast } = useToast()
  const [enrollments, setEnrollments] = useState<MyEnrollment[]>([])
  const [programs, setPrograms] = useState<any[]>([])
  const [active, setActive] = useState<ProgressData | null>(null)
  const [studyGuides, setStudyGuides] = useState<StudentStudyGuide[]>([])
  const [assignments, setAssignments] = useState<StudentAssignment[]>([])
  const [assignmentDrafts, setAssignmentDrafts] = useState<Record<string, string>>({})
  const [assignmentFiles, setAssignmentFiles] = useState<Record<string, File | null>>({})
  const [submittingAssignmentId, setSubmittingAssignmentId] = useState<string | null>(null)
  const [loadingActive, setLoadingActive] = useState(false)
  const [lastChats, setLastChats] = useState<ChatMsg[]>([])
  const [academicMemory, setAcademicMemory] = useState<AcademicMemorySnapshot | null>(null)

  // Load my programs
  const loadList = useCallback(async () => {
    try {
      const [p, e, c, m] = await Promise.all([
        api<{ programs: any[] }>('/api/programs'),
        api<{ enrollments: MyEnrollment[] }>('/api/my/enrollments').catch(() => ({ enrollments: [] as any[] })),
        api<{ messages: ChatMsg[] }>('/api/chat').catch(() => ({ messages: [] as ChatMsg[] })),
        api<{ memory: AcademicMemorySnapshot | null }>('/api/my/academic-memory').catch(() => ({ memory: null })),
      ])
      setPrograms(p.programs)
      setLastChats(c.messages.slice(-2))
      setAcademicMemory(m.memory || null)
      setEnrollments(e.enrollments || [])
      return e.enrollments || []
    } catch {
      return []
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const enrolls = await loadList()
      if (cancelled) return
      // Load first enrolled program details
      const first = enrolls.find((x) => x.status !== 'PENDING_PAYMENT')
      if (first) await open(first.programId)
    })()
    return () => { cancelled = true }
  }, [loadList])

  const open = async (programId: string) => {
    setLoadingActive(true)
    try {
      const [d, a, g] = await Promise.all([
        api<ProgressData>(`/api/progress?programId=${programId}`),
        api<{ assignments: StudentAssignment[] }>(`/api/assignments?programId=${programId}`).catch(() => ({ assignments: [] as StudentAssignment[] })),
        api<{ guides: StudentStudyGuide[] }>(`/api/study-guides?programId=${programId}`).catch(() => ({ guides: [] as StudentStudyGuide[] })),
      ])
      setActive(d)
      setAssignments(a.assignments || [])
      setStudyGuides(g.guides || [])
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setLoadingActive(false)
    }
  }

  const submitAssignment = async (assignmentId: string) => {
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

  if (!user) {
    return null
  }

  const myProgramIds = new Set(enrollments.map((e) => e.programId))
  const available = programs.filter((p) => !myProgramIds.has(p.id))
  const activeAcademicProfile = active ? buildAcademicProgramProfile(active.program) : null

  return (
    <div className="aact-fade-in mx-auto max-w-7xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">بوابة الطالب</h1>
          <p className="mt-1 text-sm text-slate-500">أهلاً {user.name} — رحلتك التدريبية في مكان واحد</p>
        </div>
        <Button onClick={() => navigate('chat')} className="bg-[#0f2b46] font-extrabold text-[#e0b83a] hover:bg-[#12365c]">
          <Bot className="ml-2 h-4 w-4" /> اسأل المشرف الذكي
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* Main: tabs */}
        <div>
          <Tabs defaultValue="programs" dir="rtl">
            <TabsList className="grid w-full grid-cols-3 sm:grid-cols-5">
              <TabsTrigger value="programs" className="text-[11px] font-bold sm:text-sm">
                <BookOpen className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> برامجي
              </TabsTrigger>
              <TabsTrigger value="payments" className="text-[11px] font-bold sm:text-sm">
                <Banknote className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> الدفعات
              </TabsTrigger>
              <TabsTrigger value="thesis" className="text-[11px] font-bold sm:text-sm">
                <FileText className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> بحث التخرج
              </TabsTrigger>
              <TabsTrigger value="transcript" className="text-[11px] font-bold sm:text-sm">
                <ScrollText className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> سجلي الأكاديمي
              </TabsTrigger>
              <TabsTrigger value="certs" className="text-[11px] font-bold sm:text-sm">
                <Award className="ml-1 hidden h-3.5 w-3.5 sm:inline" /> شهاداتي
              </TabsTrigger>
            </TabsList>

            <TabsContent value="programs" className="mt-6 space-y-6">
          {/* Enrolled programs tabs */}
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
                {active.finalScore != null && (
                  <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 text-sm font-bold text-emerald-700">
                    <Award className="h-5 w-5" />
                    النتيجة النهائية: {active.finalScore}% — رقم الشهادة سيصدر تلقائياً (خلال 30 يوماً وفق اللوائح)
                  </div>
                )}

                {activeAcademicProfile && (
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

                {(activeAcademicProfile?.termPlans?.length || 0) > 0 && (
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

                {studyGuides.length > 0 && (
                  <section className="mt-4 rounded-2xl border border-[#0f2b46]/10 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="flex items-center gap-2 text-sm font-black text-[#0f2b46]"><BookMarked className="h-4 w-4 text-[#a8841a]" /> أدلة الدراسة والمحاضرات</h3>
                        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">محاور مذاكرة مولدة من كتبك وبنك المعرفة، لتجهيزك للواجبات والامتحانات والمناقشة.</p>
                      </div>
                      <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">{studyGuides.length} دليل</Badge>
                    </div>
                    <div className="space-y-3">
                      {studyGuides.map((guide) => (
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
                )}

                {assignments.length > 0 && (
                  <section className="mt-4 rounded-2xl border border-[#c9a227]/35 bg-[#fffaf0] p-4">
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
                )}

                {/* Units */}
                <div className="mt-5 space-y-3">
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
              </CardContent>
            </Card>
          ) : null}

          {/* 12.2: امتحانا الفصلين من الكتب المقررة */}
          {active?.semesterExams && active.semesterExams.length > 0 && (
            active.semesterExams.map((exam: any, idx: number) => {
              // بوابة التسلسل: امتحان الفصل الثاني يفتح بعد اجتياز الفصل الأول
              const sem1 = (active.semesterExams || []).find((e: any) => e.semester === 1)
              const locked = exam.semester === 2 && sem1 && !sem1.passed
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
                              مقفل — اجتز امتحان الفصل الأول أولاً
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
                      </div>
                      <Button
                        onClick={() => (locked ? null : openExam(exam.id, 'final'))}
                        disabled={locked}
                        className="shrink-0 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a] disabled:opacity-50"
                      >
                        <Hourglass className="ml-1 h-4 w-4" />
                        {exam.bestScore != null ? 'إعادة الامتحان' : 'ابدأ امتحان الفصل'}
                      </Button>
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

            <TabsContent value="payments" className="mt-6">
              <PaymentsTab />
            </TabsContent>

            <TabsContent value="thesis" className="mt-6">
              <ThesisTab />
            </TabsContent>

            <TabsContent value="transcript" className="mt-6">
              <TranscriptTab />
            </TabsContent>

            <TabsContent value="certs" className="mt-6">
              <CertificatesTab />
            </TabsContent>
          </Tabs>
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          {/* AI chat latest */}
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
                <Bot className="h-5 w-5 text-[#c9a227]" /> آخر رسائل المشرف الذكي
              </h2>
              {lastChats.length === 0 ? (
                <div className="rounded-xl bg-[#f7edd0]/50 p-4 text-center">
                  <p className="text-xs leading-relaxed text-slate-600">
                    لم تبدأ محادثتك مع المشرف الذكي بعد. اسأله أي سؤال عن دوراتك — صوتاً أو كتابة!
                  </p>
                  <Button size="sm" className="mt-3 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]" onClick={() => navigate('chat')}>
                    ابدأ المحادثة
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
                  <Button size="sm" variant="outline" className="w-full border-[#0f2b46]/20 text-[#0f2b46]" onClick={() => navigate('chat')}>
                    متابعة المحادثة
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
        </div>
      </div>
    </div>
  )
}
