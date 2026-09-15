'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, Users2, GraduationCap, FileText, Video, RefreshCcw, MessageCircle, Send, Mic, Square, ClipboardCheck, Bot, BookOpen, AlertTriangle, CheckCircle2, Sparkles, BarChart3, Brain, Headphones } from 'lucide-react'
import { SupervisorLiveVoiceCall } from '@/components/aact/SupervisorLiveVoiceCall'

interface SupervisorMessage {
  id: string
  senderRole: string
  content: string
  mode: string
  audioData?: string | null
  audioMime?: string | null
  createdAt: string
}

interface PrivateAssessment {
  id: string
  title: string
  description?: string | null
  type: string
  semester: number
  status: string
  aiGenerated: boolean
  aiGradingEnabled: boolean
  totalPoints: number
  durationMin: number
  passScore: number
  questions?: any[]
  attempts?: any[]
  createdAt: string
}

interface SupervisedStudent {
  id: string
  reference: string
  fullName: string
  email?: string
  phone?: string
  country?: string
  status: string
  statusLabel?: string
  supervisionMode?: string
  supervisorName?: string | null
  programId?: string | null
  programTitle: string
  thesisDeadline?: string | null
  books: { id: string; title: string; semester?: number | null; linkReadStatus?: string; source?: string }[]
  knowledgeItems: { id: string; title: string; category: string; importance: number }[]
  exams: any[]
  availableProgramExams: any[]
  availableUnitExams: any[]
  availableAssignments: any[]
  attempts: any[]
  unitAttempts: any[]
  assignments: any[]
  privateAssessments: any[]
  theses: any[]
  messagesPreview: SupervisorMessage[]
  metrics: {
    avgScore?: number | null
    attemptsCount: number
    programExamAttemptsCount?: number
    unitExamAttemptsCount?: number
    availableProgramExamsCount?: number
    pendingProgramExamsCount?: number
    availableUnitExamsCount?: number
    pendingUnitExamsCount?: number
    failedCount: number
    assignmentsCount: number
    availableAssignmentsCount?: number
    pendingAssignmentsCount?: number
    assignmentsGraded: number
    privateAssessmentsCount: number
    privateAssessmentsSubmitted: number
    booksCount: number
    knowledgeCount: number
    examCoverage: number
  }
  weakSignals: any[]
}

const assessmentTypeLabels: Record<string, string> = {
  DAILY_TEST: 'اختبار يومي',
  EXAM: 'امتحان خاص',
  ORAL_PREP: 'تهيئة مناقشة',
  ASSIGNMENT: 'تكليف خاص',
}

const supervisionModeLabel: Record<string, string> = {
  AI: 'مشرف ذكي فقط',
  HUMAN: 'مشرف بشري',
  HYBRID: 'مشرف بشري + مشرف ذكي',
}

function dateAr(value?: string | null) {
  if (!value) return 'غير محدد'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? 'غير محدد' : d.toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })
}

function audioSrc(m?: SupervisorMessage) {
  if (!m?.audioData) return ''
  return `data:${m.audioMime || 'audio/webm'};base64,${m.audioData}`
}

function fileBlobToBase64(blob: Blob): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      resolve({ data: result.includes(',') ? result.split(',')[1] : result, mime: blob.type || 'audio/webm' })
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function SupervisorView() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [students, setStudents] = useState<SupervisedStudent[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SupervisorMessage[]>([])
  const [assessments, setAssessments] = useState<PrivateAssessment[]>([])
  const [loadingDetails, setLoadingDetails] = useState(false)
  const [sending, setSending] = useState(false)
  const [chatText, setChatText] = useState('')
  const [recording, setRecording] = useState(false)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const [creating, setCreating] = useState(false)
  const [assessmentForm, setAssessmentForm] = useState({
    title: '',
    description: '',
    type: 'DAILY_TEST',
    semester: 1,
    durationMin: 20,
    passScore: 60,
    questionCount: 8,
    aiGenerated: true,
    aiGradingEnabled: true,
    sourceBookIds: [] as string[],
  })

  const selected = useMemo(() => students.find((s) => s.id === selectedId) || students[0] || null, [students, selectedId])

  const load = async () => {
    setLoading(true)
    try {
      const d = await api<{ students: SupervisedStudent[] }>('/api/supervisor/students')
      const list = d.students || []
      setStudents(list)
      setSelectedId((prev) => prev && list.some((s) => s.id === prev) ? prev : list[0]?.id || null)
    } catch (e: any) {
      toast({ title: 'تعذر تحميل طلابك', description: e.message || 'حاول مرة أخرى', variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  const loadDetails = async (admissionId: string) => {
    setLoadingDetails(true)
    try {
      const [m, a] = await Promise.all([
        api<{ messages: SupervisorMessage[] }>(`/api/supervisor/messages?admissionId=${admissionId}`).catch(() => ({ messages: [] })),
        api<{ assessments: PrivateAssessment[] }>(`/api/supervisor/assessments?admissionId=${admissionId}`).catch(() => ({ assessments: [] })),
      ])
      setMessages(m.messages || [])
      setAssessments(a.assessments || [])
    } finally {
      setLoadingDetails(false)
    }
  }

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (selected?.id) loadDetails(selected.id) }, [selected?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = async (payload?: { mode?: 'TEXT' | 'VOICE'; audioData?: string; audioMime?: string; content?: string }) => {
    if (!selected) return
    const content = (payload?.content ?? chatText).trim()
    if (!content && !payload?.audioData) return
    setSending(true)
    try {
      await api('/api/supervisor/messages', {
        method: 'POST',
        body: JSON.stringify({ admissionId: selected.id, content, mode: payload?.mode || 'TEXT', audioData: payload?.audioData, audioMime: payload?.audioMime }),
      })
      setChatText('')
      await loadDetails(selected.id)
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الرسالة', description: e.message, variant: 'destructive' })
    } finally {
      setSending(false)
    }
  }

  const startRecording = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        toast({ title: 'التسجيل غير مدعوم', description: 'متصفحك لا يدعم تسجيل الصوت المباشر. استخدم الكتابة حالياً.', variant: 'destructive' })
        return
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaStreamRef.current = stream
      chunksRef.current = []
      const rec = new MediaRecorder(stream)
      mediaRecorderRef.current = rec
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = async () => {
        try {
          const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
          const { data, mime } = await fileBlobToBase64(blob)
          await sendMessage({ mode: 'VOICE', audioData: data, audioMime: mime, content: 'ملاحظة صوتية من المشرف' })
        } catch (e: any) {
          toast({ title: 'تعذر إرسال التسجيل', description: e.message, variant: 'destructive' })
        } finally {
          mediaStreamRef.current?.getTracks().forEach((t) => t.stop())
          mediaStreamRef.current = null
        }
      }
      rec.start()
      setRecording(true)
    } catch (e: any) {
      toast({ title: 'لم يتم فتح الميكروفون', description: e.message || 'تحقق من صلاحيات المتصفح', variant: 'destructive' })
    }
  }

  const stopRecording = () => {
    setRecording(false)
    try { mediaRecorderRef.current?.stop() } catch {}
  }

  const createAssessment = async () => {
    if (!selected) return
    setCreating(true)
    try {
      await api('/api/supervisor/assessments', {
        method: 'POST',
        body: JSON.stringify({ admissionId: selected.id, ...assessmentForm }),
      })
      toast({ title: 'تم نشر الاختبار للطالب', description: assessmentForm.aiGenerated ? 'تم توليد الأسئلة من كتب الطالب وبنك المعرفة.' : 'تم إنشاء الاختبار.' })
      setAssessmentForm((f) => ({ ...f, title: '', description: '' }))
      await loadDetails(selected.id)
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء الاختبار', description: e.message, variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const aiGradeAttempt = async (attemptId: string) => {
    if (!selected) return
    setCreating(true)
    try {
      await api('/api/supervisor/assessments', { method: 'POST', body: JSON.stringify({ action: 'ai-grade-attempt', attemptId }) })
      toast({ title: 'تم التصحيح بالذكاء', description: 'تم تحديث درجة الطالب وملاحظات القصور.' })
      await loadDetails(selected.id)
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر التصحيح الآلي', description: e.message, variant: 'destructive' })
    } finally {
      setCreating(false)
    }
  }

  const toggleBook = (id: string) => {
    setAssessmentForm((f) => ({
      ...f,
      sourceBookIds: f.sourceBookIds.includes(id) ? f.sourceBookIds.filter((x) => x !== id) : [...f.sourceBookIds, id],
    }))
  }

  return (
    <div className="aact-fade-in mx-auto max-w-7xl px-4 py-10">
      <div className="mb-6 rounded-3xl border border-[#c9a227]/40 bg-[#0f2b46] p-6 text-[#f5f0e1] shadow">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Badge className="mb-2 bg-[#c9a227] text-[#0f2b46] hover:bg-[#c9a227]">بوابة المشرف البشري</Badge>
            <h1 className="text-2xl font-black">مركز الإشراف الأكاديمي والمتابعة</h1>
            <p className="mt-2 text-sm font-bold leading-7 text-[#d7e0ea]">تواصل مع الطالب، راقب امتحاناته وواجباته، وأنشئ اختبارات خاصة مدعومة بالذكاء من كتب الطالب.</p>
          </div>
          <Button onClick={load} variant="outline" className="border-[#e0b83a] bg-transparent font-black text-[#e0b83a] hover:bg-white/10">
            {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <RefreshCcw className="ml-2 h-4 w-4" />} تحديث
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex h-60 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" /></div>
      ) : students.length === 0 ? (
        <Card className="border-dashed"><CardContent className="p-8 text-center text-sm font-bold leading-7 text-slate-500">لا يوجد طلاب معيّنون لك حالياً. التعيين يتم من لوحة الإدارة.</CardContent></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[310px_1fr]">
          <aside className="space-y-3">
            <Card className="border-[#0f2b46]/10"><CardContent className="p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-black text-[#0f2b46]"><Users2 className="h-4 w-4 text-[#a8841a]" /> الطلاب تحت الإشراف ({students.length})</h2>
              <div className="space-y-2">
                {students.map((s) => (
                  <button key={s.id} onClick={() => setSelectedId(s.id)} className={`w-full rounded-2xl border p-3 text-right transition ${selected?.id === s.id ? 'border-[#c9a227] bg-[#fffaf0]' : 'border-slate-100 bg-white hover:border-[#c9a227]/50'}`}>
                    <p className="text-sm font-black text-[#0f2b46]">{s.fullName}</p>
                    <p className="mt-1 line-clamp-1 text-[11px] font-bold text-slate-500">{s.programTitle}</p>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <Badge variant="outline" className="text-[9px] font-black">{s.statusLabel}</Badge>
                      <Badge className="bg-emerald-50 text-[9px] font-black text-emerald-700 hover:bg-emerald-50">{s.metrics.avgScore ?? '—'}%</Badge>
                    </div>
                  </button>
                ))}
              </div>
            </CardContent></Card>
          </aside>

          {selected && (
            <main className="space-y-5">
              <Card className="border-[#0f2b46]/10"><CardContent className="p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h2 className="text-xl font-black text-[#0f2b46]">{selected.fullName}</h2>
                    <p className="mt-1 text-xs font-bold text-slate-500">{selected.programTitle} — <span dir="ltr">{selected.reference}</span></p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{supervisionModeLabel[selected.supervisionMode || 'AI'] || selected.supervisionMode}</Badge>
                      <Badge variant="outline">{selected.statusLabel}</Badge>
                      <Badge className="bg-[#f7edd0] text-[#0f2b46] hover:bg-[#f7edd0]">مهلة البحث: {selected.thesisDeadline ? dateAr(selected.thesisDeadline) : 'غير محددة'}</Badge>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs font-bold sm:min-w-[320px]">
                    <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xl font-black text-[#0f2b46]">{selected.metrics.avgScore ?? '—'}%</p><p className="text-slate-500">متوسط الاختبارات</p></div>
                    <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xl font-black text-[#0f2b46]">{selected.metrics.booksCount}</p><p className="text-slate-500">كتب</p></div>
                    <div className="rounded-2xl bg-slate-50 p-3"><p className="text-xl font-black text-[#0f2b46]">{selected.metrics.privateAssessmentsCount}</p><p className="text-slate-500">اختبارات خاصة</p></div>
                  </div>
                </div>
              </CardContent></Card>

              <Tabs defaultValue="overview" dir="rtl" className="space-y-4">
                <TabsList className="flex h-auto flex-wrap gap-1 bg-slate-100 p-1">
                  <TabsTrigger value="overview" className="text-[11px] font-black"><BarChart3 className="ml-1 h-3.5 w-3.5" /> متابعة عامة</TabsTrigger>
                  <TabsTrigger value="chat" className="text-[11px] font-black"><MessageCircle className="ml-1 h-3.5 w-3.5" /> محادثة الطالب</TabsTrigger>
                  <TabsTrigger value="exams" className="text-[11px] font-black"><ClipboardCheck className="ml-1 h-3.5 w-3.5" /> اختبارات وواجبات</TabsTrigger>
                  <TabsTrigger value="private" className="text-[11px] font-black"><Sparkles className="ml-1 h-3.5 w-3.5" /> اختبار خاص</TabsTrigger>
                  <TabsTrigger value="thesis" className="text-[11px] font-black"><FileText className="ml-1 h-3.5 w-3.5" /> بحث ومناقشة</TabsTrigger>
                </TabsList>

                <TabsContent value="overview" className="space-y-4">
                  <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
                    <Card><CardContent className="p-4 text-center"><GraduationCap className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{selected.metrics.attemptsCount}</p><p className="text-xs font-bold text-slate-500">محاولات مسلّمة</p></CardContent></Card>
                    <Card><CardContent className="p-4 text-center"><ClipboardCheck className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{selected.metrics.pendingProgramExamsCount ?? 0}/{selected.metrics.availableProgramExamsCount ?? 0}</p><p className="text-xs font-bold text-slate-500">امتحانات غير مسلّمة</p></CardContent></Card>
                    <Card><CardContent className="p-4 text-center"><BookOpen className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{selected.metrics.pendingUnitExamsCount ?? 0}/{selected.metrics.availableUnitExamsCount ?? 0}</p><p className="text-xs font-bold text-slate-500">اختبارات يومية غير مسلّمة</p></CardContent></Card>
                    <Card><CardContent className="p-4 text-center"><AlertTriangle className="mx-auto mb-2 h-5 w-5 text-amber-600" /><p className="text-2xl font-black text-[#0f2b46]">{selected.metrics.failedCount}</p><p className="text-xs font-bold text-slate-500">محاولات ضعيفة</p></CardContent></Card>
                    <Card><CardContent className="p-4 text-center"><Brain className="mx-auto mb-2 h-5 w-5 text-[#a8841a]" /><p className="text-2xl font-black text-[#0f2b46]">{selected.metrics.knowledgeCount}</p><p className="text-xs font-bold text-slate-500">عناصر معرفة</p></CardContent></Card>
                    <Card><CardContent className="p-4 text-center"><CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-emerald-600" /><p className="text-2xl font-black text-[#0f2b46]">{selected.metrics.assignmentsGraded}/{selected.metrics.availableAssignmentsCount ?? selected.metrics.assignmentsCount}</p><p className="text-xs font-bold text-slate-500">واجبات مصححة</p></CardContent></Card>
                  </div>
                  <Card><CardContent className="p-5">
                    <h3 className="mb-3 text-base font-black text-[#0f2b46]">نقاط تحتاج متابعة</h3>
                    {selected.weakSignals.length ? (
                      <div className="grid gap-2 md:grid-cols-2">
                        {selected.weakSignals.map((w, i) => (
                          <div key={i} className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs font-bold leading-6 text-amber-900">
                            <p className="font-black text-[#0f2b46]">{w.examTitle || 'امتحان'}</p>
                            <p>{w.question}</p>
                            <p className="mt-1 text-[11px] text-slate-500">{w.sourceBookTitle || 'مصدر غير محدد'} — {w.skill || 'مهارة غير محددة'} — {w.score}/{w.max}</p>
                          </div>
                        ))}
                      </div>
                    ) : <p className="rounded-2xl bg-slate-50 p-4 text-sm font-bold text-slate-500">لا توجد إشارات ضعف واضحة من الاختبارات الحالية.</p>}
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="chat" className="space-y-3">
                  <SupervisorLiveVoiceCall admissionId={selected.id} role="SUPERVISOR" title="مكالمة صوتية حية مع الطالب" />
                  <Card><CardContent className="p-5">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="text-base font-black text-[#0f2b46]"><Headphones className="ml-1 inline h-4 w-4 text-[#a8841a]" /> محادثة مباشرة مع الطالب كتابةً وصوتاً</h3>
                      {loadingDetails && <Loader2 className="h-4 w-4 animate-spin text-[#c9a227]" />}
                    </div>
                    <div className="max-h-[430px] space-y-2 overflow-y-auto rounded-2xl bg-slate-50 p-3">
                      {messages.length ? messages.map((m) => {
                        const mine = m.senderRole === 'SUPERVISOR' || m.senderRole === 'ADMIN'
                        return (
                          <div key={m.id} className={`flex ${mine ? 'justify-start' : 'justify-end'}`}>
                            <div className={`max-w-[85%] rounded-2xl p-3 text-xs font-bold leading-6 shadow-sm ${mine ? 'bg-[#0f2b46] text-[#f5f0e1]' : 'bg-white text-[#0f2b46]'}`}>
                              <p className="mb-1 text-[10px] opacity-70">{mine ? 'أنت/المشرف' : 'الطالب'} — {dateAr(m.createdAt)}</p>
                              <p>{m.content}</p>
                              {m.audioData && <audio className="mt-2 w-full" controls src={audioSrc(m)} />}
                            </div>
                          </div>
                        )
                      }) : <p className="p-8 text-center text-sm font-bold text-slate-500">لا توجد محادثات بعد. ابدأ رسالة متابعة للطالب.</p>}
                    </div>
                    <div className="mt-3 grid gap-2 md:grid-cols-[1fr_auto]">
                      <Textarea rows={2} value={chatText} onChange={(e) => setChatText(e.target.value)} placeholder="اكتب ملاحظة للطالب: راجع السؤال الثالث، أو وضّح نقطة المنهجية..." />
                      <div className="flex gap-2 md:flex-col">
                        <Button onClick={() => sendMessage()} disabled={sending || !chatText.trim()} className="bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]"><Send className="ml-1 h-4 w-4" /> إرسال</Button>
                        <Button onClick={recording ? stopRecording : startRecording} disabled={sending} variant="outline" className={recording ? 'border-red-300 font-black text-red-600' : 'font-black'}>{recording ? <Square className="ml-1 h-4 w-4" /> : <Mic className="ml-1 h-4 w-4" />} {recording ? 'إيقاف' : 'صوت'}</Button>
                      </div>
                    </div>
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="exams" className="space-y-4">
                  <Card><CardContent className="p-5">
                    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-base font-black text-[#0f2b46]">امتحانات الطالب المولدة/المعتمدة</h3>
                      <Badge className="bg-[#fffaf0] text-[#8a6614] hover:bg-[#fffaf0]">غير مسلّمة: {selected.metrics.pendingProgramExamsCount ?? 0}</Badge>
                    </div>
                    {selected.availableProgramExams?.length ? <div className="space-y-3">{selected.availableProgramExams.map((exam) => {
                      const weak = selected.attempts.find((a) => a.examId === exam.id)?.weakAnswers || []
                      const score = exam.finalScore ?? exam.score
                      return (
                        <div key={exam.id} className={`rounded-2xl border p-4 shadow-sm ${exam.submitted ? 'border-slate-100 bg-white' : 'border-amber-200 bg-amber-50/70'}`}>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h4 className="font-black text-[#0f2b46]">{exam.title}</h4>
                            {exam.submitted ? (
                              <Badge className={(score ?? 0) >= exam.passScore ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>مسلّم — {score ?? '—'}%</Badge>
                            ) : (
                              <Badge className="bg-red-100 text-red-700 hover:bg-red-100">لم يسلّم بعد</Badge>
                            )}
                          </div>
                          <p className="mt-1 text-[11px] font-bold text-slate-500">الفصل {exam.semester} — {exam.questionsCount} سؤال — الحالة: {exam.status} — مدة {exam.durationMin || 0} دقيقة</p>
                          {exam.submitted ? <p className="mt-1 text-[11px] font-bold text-slate-500">تاريخ التسليم: {dateAr(exam.submittedAt)} — اعتراض: {exam.appealStatus || 'NONE'}</p> : <p className="mt-2 rounded-xl bg-white/70 p-2 text-xs font-bold text-amber-800">هذا الامتحان ظاهر للمتابعة لكنه غير مسلّم من الطالب حتى الآن.</p>}
                          {weak.length > 0 && <div className="mt-3 grid gap-2 md:grid-cols-2">{weak.map((w: any, i: number) => (
                            <div key={i} className="rounded-xl bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-900">
                              <p className="font-black text-[#0f2b46]">قصور في سؤال</p>
                              <p>{w.question}</p>
                              {w.aiFeedback && <p className="mt-1 text-amber-700">{w.aiFeedback}</p>}
                            </div>
                          ))}</div>}
                        </div>
                      )
                    })}</div> : <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد امتحانات برنامج منشورة أو مولدة لهذا الطالب حتى الآن.</p>}
                  </CardContent></Card>

                  <Card><CardContent className="p-5">
                    <h3 className="mb-3 text-base font-black text-[#0f2b46]">الاختبارات اليومية/اختبارات الوحدات</h3>
                    {selected.unitAttempts?.length ? <div className="space-y-3">{selected.unitAttempts.map((a) => (
                      <div key={a.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="font-black text-[#0f2b46]">{a.examTitle}</h4>
                          <Badge className={(a.score ?? 0) >= 60 ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{a.score ?? '—'}%</Badge>
                        </div>
                        <p className="mt-1 text-[11px] font-bold text-slate-500">{a.unitTitle ? `الوحدة: ${a.unitTitle}` : 'اختبار وحدة'} — {dateAr(a.submittedAt)}</p>
                        {a.weakAnswers?.length > 0 && <div className="mt-3 grid gap-2 md:grid-cols-2">{a.weakAnswers.map((w: any, i: number) => (
                          <div key={i} className="rounded-xl bg-white p-3 text-[11px] font-bold leading-5 text-slate-700 ring-1 ring-amber-100">
                            <p className="font-black text-amber-700">نقطة قصور</p>
                            <p>{w.question}</p>
                            {w.aiFeedback && <p className="mt-1 text-amber-700">{w.aiFeedback}</p>}
                          </div>
                        ))}</div>}
                      </div>
                    ))}</div> : <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد اختبارات وحدات/يومية مسلّمة بعد.</p>}
                  </CardContent></Card>

                  <Card><CardContent className="p-5">
                    <h3 className="mb-3 text-base font-black text-[#0f2b46]">الواجبات والتكليفات</h3>
                    {selected.assignments.length ? <div className="grid gap-2 md:grid-cols-2">{selected.assignments.map((a) => (
                      <div key={a.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3 text-xs font-bold leading-6 text-slate-600">
                        <p className="font-black text-[#0f2b46]">{a.title}</p>
                        <p>الحالة: {a.status} — الدرجة: {a.score ?? 'لم تصحح'}/{a.points}</p>
                        {a.feedback && <p className="text-emerald-700">ملاحظة: {a.feedback}</p>}
                      </div>
                    ))}</div> : <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لا توجد واجبات مسلّمة بعد.</p>}
                  </CardContent></Card>

                  <Card><CardContent className="p-5">
                    <h3 className="mb-3 text-base font-black text-[#0f2b46]">الاختبارات الخاصة التي أنشأها المشرف</h3>
                    {assessments.length ? <div className="space-y-3">{assessments.map((a) => (
                      <div key={a.id} className="rounded-2xl border border-[#c9a227]/20 bg-[#fffaf0] p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="font-black text-[#0f2b46]">{a.title}</h4>
                          <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]">{assessmentTypeLabels[a.type] || a.type}</Badge>
                        </div>
                        <p className="mt-1 text-xs font-bold text-slate-500">{a.questions?.length || 0} سؤال — {a.totalPoints} نقطة — تصحيح آلي: {a.aiGradingEnabled ? 'مفعل' : 'اختياري/يدوي'}</p>
                        {a.attempts?.length ? a.attempts.map((at: any) => (
                          <div key={at.id} className="mt-2 rounded-xl bg-white p-3 text-xs font-bold leading-6 text-slate-600">
                            <p>تسليم: {dateAr(at.submittedAt)} — الحالة: {at.status} — النتيجة: {at.score ?? 'لم تصحح'}%</p>
                            {at.feedback && <p className="text-[#0f2b46]">{at.feedback}</p>}
                            {at.status !== 'GRADED' && <Button size="sm" onClick={() => aiGradeAttempt(at.id)} disabled={creating} className="mt-2 bg-[#0f2b46] text-[#e0b83a]"><Bot className="ml-1 h-3.5 w-3.5" /> تصحيح آلي الآن</Button>}
                          </div>
                        )) : <p className="mt-2 rounded-xl bg-white p-3 text-xs font-bold text-slate-500">لم يسلّم الطالب هذا الاختبار بعد.</p>}
                      </div>
                    ))}</div> : <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لم تنشئ اختبارات خاصة لهذا الطالب بعد.</p>}
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="private" className="space-y-4">
                  <Card><CardContent className="p-5">
                    <h3 className="mb-3 flex items-center gap-2 text-base font-black text-[#0f2b46]"><Sparkles className="h-4 w-4 text-[#a8841a]" /> إنشاء اختبار/امتحان خاص لهذا الطالب فقط</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <Input placeholder="عنوان الاختبار" value={assessmentForm.title} onChange={(e) => setAssessmentForm({ ...assessmentForm, title: e.target.value })} />
                      <select className="rounded-md border border-input bg-background px-3 py-2 text-sm" value={assessmentForm.type} onChange={(e) => setAssessmentForm({ ...assessmentForm, type: e.target.value })}>
                        <option value="DAILY_TEST">اختبار يومي</option>
                        <option value="EXAM">امتحان خاص</option>
                        <option value="ORAL_PREP">تهيئة مناقشة</option>
                        <option value="ASSIGNMENT">تكليف خاص</option>
                      </select>
                      <Input type="number" placeholder="الفصل" value={assessmentForm.semester} onChange={(e) => setAssessmentForm({ ...assessmentForm, semester: Number(e.target.value || 1) })} />
                      <Input type="number" placeholder="عدد الأسئلة" value={assessmentForm.questionCount} onChange={(e) => setAssessmentForm({ ...assessmentForm, questionCount: Number(e.target.value || 8) })} />
                      <Input type="number" placeholder="مدة الاختبار بالدقائق" value={assessmentForm.durationMin} onChange={(e) => setAssessmentForm({ ...assessmentForm, durationMin: Number(e.target.value || 20) })} />
                      <Input type="number" placeholder="درجة النجاح %" value={assessmentForm.passScore} onChange={(e) => setAssessmentForm({ ...assessmentForm, passScore: Number(e.target.value || 60) })} />
                      <Textarea className="md:col-span-2" rows={3} placeholder="وصف أو تعليمات خاصة للطالب" value={assessmentForm.description} onChange={(e) => setAssessmentForm({ ...assessmentForm, description: e.target.value })} />
                    </div>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <label className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm font-bold text-[#0f2b46]"><input type="checkbox" checked={assessmentForm.aiGenerated} onChange={(e) => setAssessmentForm({ ...assessmentForm, aiGenerated: e.target.checked })} /> توليد الأسئلة بالذكاء من كتب الطالب</label>
                      <label className="flex items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-sm font-bold text-[#0f2b46]"><input type="checkbox" checked={assessmentForm.aiGradingEnabled} onChange={(e) => setAssessmentForm({ ...assessmentForm, aiGradingEnabled: e.target.checked })} /> تصحيح آلي اختياري عند التسليم</label>
                    </div>
                    <div className="mt-4 rounded-2xl border border-[#c9a227]/25 bg-[#fffaf0] p-3">
                      <p className="mb-2 text-xs font-black text-[#0f2b46]"><BookOpen className="ml-1 inline h-3.5 w-3.5" /> اختر الكتب التي يعتمد عليها الاختبار</p>
                      <div className="flex flex-wrap gap-2">
                        {selected.books.length ? selected.books.map((b) => (
                          <button type="button" key={b.id} onClick={() => toggleBook(b.id)} className={`rounded-full border px-3 py-1.5 text-[11px] font-black ${assessmentForm.sourceBookIds.includes(b.id) ? 'border-[#c9a227] bg-[#c9a227] text-[#0f2b46]' : 'border-slate-200 bg-white text-slate-600'}`}>{b.title}</button>
                        )) : <span className="text-xs font-bold text-slate-500">لا توجد كتب مرفوعة/مقررة بعد، سيعتمد الذكاء على بنك المعرفة العام إن وجد.</span>}
                      </div>
                    </div>
                    <Button onClick={createAssessment} disabled={creating} className="mt-4 bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                      {creating ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Sparkles className="ml-2 h-4 w-4" />} توليد ونشر الاختبار للطالب
                    </Button>
                  </CardContent></Card>
                </TabsContent>

                <TabsContent value="thesis" className="space-y-3">
                  <Card><CardContent className="p-5">
                    <h3 className="mb-3 text-base font-black text-[#0f2b46]"><Video className="ml-1 inline h-4 w-4 text-[#a8841a]" /> بحث التخرج والمناقشة</h3>
                    {selected.theses.length ? <div className="grid gap-3 md:grid-cols-2">{selected.theses.map((t: any) => (
                      <div key={t.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-4 text-xs font-bold leading-6 text-slate-600">
                        <p className="font-black text-[#0f2b46]">{t.title}</p>
                        <p>الحالة: {t.status} — آخر تحديث: {dateAr(t.updatedAt)}</p>
                        <p>تقييم الذكاء: {t.aiScore ?? '—'} — قرار اللجنة: {t.resultScore ?? '—'}</p>
                      </div>
                    ))}</div> : <p className="rounded-2xl bg-slate-50 p-5 text-center text-sm font-bold text-slate-500">لم يرفع الطالب بحث تخرج بعد.</p>}
                  </CardContent></Card>
                </TabsContent>
              </Tabs>
            </main>
          )}
        </div>
      )}
    </div>
  )
}
