'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { BookOpen, ChevronDown, Lightbulb, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'

// المحتوى والوحدات عند المشرف: عرض كامل لبرامجه كما تراه الإدارة
// (كتب، وحدات، أسئلة بنك الوحدات، الامتحانات الفصلية بأسئلتها)، مع
// إضافة/تعديل/حذف أسئلة يدوية مباشرة (تصل الإدارة إشعارات بها)،
// واقتراحات على الوحدات فقط — بنية الوحدات نفسها لا يمسّها.

type ProgramSummary = { id: string; titleAr: string; titleEn?: string | null; _count: { books: number; units: number; programExams: number } }

type QuestionForm = {
  kind: 'BANK' | 'PROGRAM'
  questionId: string | null
  unitId?: string
  examId?: string
  contextTitle: string
  type: string
  text: string
  options: string
  correctAnswer: string
  modelAnswer: string
  rubric: string
  difficulty: string
  points: string
}

const EMPTY_FORM: QuestionForm = { kind: 'BANK', questionId: null, contextTitle: '', type: 'MCQ', text: '', options: '', correctAnswer: '0', modelAnswer: '', rubric: '', difficulty: 'MEDIUM', points: '2' }

function optionsToText(raw: string | null): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.join('\n')
  } catch { /* ignore */ }
  return raw
}

function statusChip(status: string) {
  if (status === 'APPROVED' || status === 'PUBLISHED') return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">معتمد</Badge>
  if (status === 'REJECTED') return <Badge className="bg-red-100 text-red-700 hover:bg-red-100">مرفوض</Badge>
  if (status === 'PENDING_REVIEW') return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">بانتظار المراجعة</Badge>
  return <Badge variant="outline">{status}</Badge>
}

export function SupervisorContentTab() {
  const { toast } = useToast()
  const [programs, setPrograms] = useState<ProgramSummary[]>([])
  const [programId, setProgramId] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [openUnit, setOpenUnit] = useState<string | null>(null)
  const [openExam, setOpenExam] = useState<string | null>(null)
  const [form, setForm] = useState<QuestionForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [proposal, setProposal] = useState<{ programId: string; unitId: string | null; unitTitle: string; kind: string; title: string; details: string } | null>(null)
  const [myProposals, setMyProposals] = useState<any[]>([])

  const loadDetail = useCallback(async (id: string) => {
    if (!id) { setDetail(null); return }
    setLoadingDetail(true)
    try {
      const d = await api<{ program: any }>(`/api/supervisor/content?programId=${encodeURIComponent(id)}`)
      setDetail(d.program)
    } catch (e: any) {
      toast({ title: 'تعذر تحميل محتوى البرنامج', description: e?.message || '', variant: 'destructive' })
    } finally { setLoadingDetail(false) }
  }, [toast])

  const loadProposals = useCallback(async () => {
    try {
      const d = await api<{ proposals: any[] }>('/api/supervisor/unit-proposals')
      setMyProposals(d.proposals || [])
    } catch { /* صامت */ }
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        const d = await api<{ programs: ProgramSummary[] }>('/api/supervisor/content')
        setPrograms(d.programs || [])
        if (d.programs?.length) {
          setProgramId(d.programs[0].id)
          await loadDetail(d.programs[0].id)
        }
      } catch (e: any) {
        toast({ title: 'تعذر تحميل برامجك', description: e?.message || '', variant: 'destructive' })
      } finally { setLoading(false) }
      void loadProposals()
    })()
  }, [loadDetail, loadProposals, toast])

  const openNewBankQuestion = (unit: any) => setForm({ ...EMPTY_FORM, kind: 'BANK', unitId: unit.id, contextTitle: `وحدة: ${unit.title}` })
  const openNewProgramQuestion = (exam: any) => setForm({ ...EMPTY_FORM, kind: 'PROGRAM', examId: exam.id, contextTitle: `امتحان: ${exam.title}` })
  const openEdit = (kind: 'BANK' | 'PROGRAM', q: any, contextTitle: string, unitId?: string, examId?: string) => setForm({
    kind,
    questionId: q.id,
    unitId,
    examId,
    contextTitle,
    type: q.type || 'MCQ',
    text: q.text || '',
    options: optionsToText(q.options),
    correctAnswer: q.correctAnswer ?? '0',
    modelAnswer: q.modelAnswer || '',
    rubric: q.rubric || '',
    difficulty: q.difficulty || 'MEDIUM',
    points: String(q.points ?? 2),
  })

  const submitQuestion = async () => {
    if (!form) return
    setSaving(true)
    try {
      const options = form.options.split('\n').map((x) => x.trim()).filter(Boolean)
      const payload: any = {
        kind: form.kind,
        type: form.type,
        text: form.text,
        options,
        correctAnswer: form.correctAnswer,
        modelAnswer: form.modelAnswer,
        rubric: form.rubric,
        difficulty: form.difficulty,
        points: Number(form.points) || undefined,
      }
      if (form.kind === 'BANK') payload.unitId = form.unitId
      else payload.examId = form.examId
      if (form.questionId) {
        payload.questionId = form.questionId
        await api('/api/supervisor/questions', { method: 'PATCH', body: JSON.stringify(payload) })
        toast({ title: 'عُدّل السؤال وسُجّل التعديل لدى الإدارة' })
      } else {
        await api('/api/supervisor/questions', { method: 'POST', body: JSON.stringify(payload) })
        toast({ title: 'أُضيف السؤال مباشرة وأُشعرت الإدارة' })
      }
      setForm(null)
      await loadDetail(programId)
    } catch (e: any) {
      toast({ title: 'تعذر حفظ السؤال', description: e?.message || '', variant: 'destructive' })
    } finally { setSaving(false) }
  }

  const deleteQuestion = async (kind: 'BANK' | 'PROGRAM', q: any) => {
    if (!window.confirm('حذف هذا السؤال نهائيًا؟ سيصل الإدارة إشعار بالحذف.')) return
    try {
      await api('/api/supervisor/questions', { method: 'DELETE', body: JSON.stringify({ kind, questionId: q.id }) })
      toast({ title: 'حُذف السؤال' })
      await loadDetail(programId)
    } catch (e: any) {
      toast({ title: 'تعذر حذف السؤال', description: e?.message || '', variant: 'destructive' })
    }
  }

  const submitProposal = async () => {
    if (!proposal) return
    setSaving(true)
    try {
      await api('/api/supervisor/unit-proposals', { method: 'POST', body: JSON.stringify(proposal) })
      toast({ title: 'وصل اقتراحك إلى الإدارة' })
      setProposal(null)
      await loadProposals()
    } catch (e: any) {
      toast({ title: 'تعذر إرسال الاقتراح', description: e?.message || '', variant: 'destructive' })
    } finally { setSaving(false) }
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div>
  if (!programs.length) {
    return <Card className="border-dashed"><CardContent className="p-8 text-center text-sm font-bold leading-7 text-slate-500">لا توجد برامج ضمن نطاقك بعد — النطاق يتحدد بتعيين الإدارة لك مشرفًا على طلاب أو على سلسلة محاضرات.</CardContent></Card>
  }

  const isChoice = form && (form.type === 'MCQ' || form.type === 'TF')
  const formOptions = form ? form.options.split('\n').map((x) => x.trim()).filter(Boolean) : []

  return (
    <div className="space-y-5" dir="rtl">
      <Card><CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="flex items-center gap-2 text-base font-black text-[#0f2b46]"><BookOpen className="h-5 w-5 text-[#a8841a]" /> المحتوى والوحدات — عرض كامل</h3>
          <select value={programId} onChange={(e) => { setProgramId(e.target.value); void loadDetail(e.target.value) }} className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold">
            {programs.map((p) => <option key={p.id} value={p.id}>{p.titleAr}</option>)}
          </select>
          <Button size="sm" variant="outline" className="text-[11px] font-bold" onClick={() => detail && setProposal({ programId, unitId: null, unitTitle: '', kind: 'ADD', title: '', details: '' })}>
            <Lightbulb className="ml-1 h-3.5 w-3.5" /> اقتراح وحدة جديدة
          </Button>
        </div>
        <p className="text-[11px] font-bold leading-6 text-slate-500">بتشوف كل شي متل الإدارة. الأسئلة اليدوية بتضيفها وبتعدّلها مباشرة وبتسري فورًا — وبيوصل الإدارة إشعار بكل عملية. الوحدات نفسها: اقتراح بس، والتنفيذ عند الإدارة.</p>
        {loadingDetail && <p className="text-xs font-bold text-slate-400">جارٍ تحميل المحتوى…</p>}

        {detail && (
          <div className="space-y-5">
            <div>
              <h4 className="mb-2 text-sm font-black text-[#0f2b46]">الكتب ({detail.books.length})</h4>
              <div className="flex flex-wrap gap-2">
                {detail.books.map((b: any) => <Badge key={b.id} variant="outline" className="text-[11px]">{b.title} — فصل {b.semester}</Badge>)}
                {!detail.books.length && <p className="text-xs font-bold text-slate-400">لا كتب مرتبطة بعد.</p>}
              </div>
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-black text-[#0f2b46]">الوحدات ({detail.units.length})</h4>
              {detail.units.map((u: any) => (
                <div key={u.id} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="flex items-center gap-1 text-right text-sm font-black text-[#0f2b46]" onClick={() => setOpenUnit(openUnit === u.id ? null : u.id)}>
                      <ChevronDown className={`h-4 w-4 transition-transform ${openUnit === u.id ? 'rotate-180' : ''}`} /> {u.order}. {u.title}
                    </button>
                    {statusChip(u.status)}
                    {u.exam && <Badge variant="outline" className="text-[10px]">امتحان الوحدة: {u.exam.questionsCount} سؤال — {u.exam.status}</Badge>}
                    <span className="mr-auto flex gap-1.5">
                      <Button size="sm" className="bg-[#0f2b46] text-[11px] font-bold hover:bg-[#12365c]" onClick={() => openNewBankQuestion(u)}><Plus className="ml-1 h-3.5 w-3.5" /> سؤال يدوي</Button>
                      <Button size="sm" variant="outline" className="text-[11px] font-bold" onClick={() => setProposal({ programId, unitId: u.id, unitTitle: u.title, kind: 'EDIT', title: '', details: '' })}><Lightbulb className="ml-1 h-3.5 w-3.5" /> اقتراح</Button>
                    </span>
                  </div>
                  {openUnit === u.id && (
                    <div className="mt-3 space-y-2">
                      {u.summary && <p className="text-xs font-bold leading-6 text-slate-500">{u.summary}</p>}
                      {(u.bankQuestions || []).map((q: any) => (
                        <div key={q.id} className="rounded-xl border border-slate-100 bg-white p-3 text-xs font-bold leading-6 text-slate-600">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="text-[10px]">{q.type}</Badge>
                            {statusChip(q.status)}
                            {q.generatedBy === 'MANUAL' && <Badge className="bg-[#fffaf0] text-[#8a6614] hover:bg-[#fffaf0]">يدوي</Badge>}
                            <span className="mr-auto flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => openEdit('BANK', q, `وحدة: ${u.title}`, u.id)}><Pencil className="ml-1 h-3 w-3" /> تعديل</Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-red-600" onClick={() => void deleteQuestion('BANK', q)}><Trash2 className="ml-1 h-3 w-3" /> حذف</Button>
                            </span>
                          </div>
                          <p className="mt-1 text-slate-800">{q.text}</p>
                          {q.correctAnswer != null && <p className="text-emerald-700">الإجابة الصحيحة: خيار رقم {Number(q.correctAnswer) + 1}</p>}
                          {q.modelAnswer && <p className="text-slate-500">الإجابة النموذجية: {q.modelAnswer}</p>}
                        </div>
                      ))}
                      {!(u.bankQuestions || []).length && <p className="text-xs font-bold text-slate-400">لا أسئلة في بنك هذه الوحدة بعد.</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <h4 className="text-sm font-black text-[#0f2b46]">الامتحانات الفصلية ({detail.programExams.length})</h4>
              {detail.programExams.map((exam: any) => (
                <div key={exam.id} className="rounded-2xl border border-slate-100 bg-slate-50/60 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="flex items-center gap-1 text-right text-sm font-black text-[#0f2b46]" onClick={() => setOpenExam(openExam === exam.id ? null : exam.id)}>
                      <ChevronDown className={`h-4 w-4 transition-transform ${openExam === exam.id ? 'rotate-180' : ''}`} /> {exam.title}
                    </button>
                    <Badge variant="outline" className="text-[10px]">الفصل {exam.semester} — {exam.status} — {exam.questions.length} سؤال</Badge>
                    <span className="mr-auto">
                      <Button size="sm" className="bg-[#0f2b46] text-[11px] font-bold hover:bg-[#12365c]" onClick={() => openNewProgramQuestion(exam)}><Plus className="ml-1 h-3.5 w-3.5" /> سؤال يدوي</Button>
                    </span>
                  </div>
                  {openExam === exam.id && (
                    <div className="mt-3 space-y-2">
                      {exam.questions.map((q: any) => (
                        <div key={q.id} className="rounded-xl border border-slate-100 bg-white p-3 text-xs font-bold leading-6 text-slate-600">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="text-[10px]">{q.order}. {q.type} — {q.points} درجة</Badge>
                            {statusChip(q.status)}
                            <span className="mr-auto flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => openEdit('PROGRAM', q, `امتحان: ${exam.title}`, undefined, exam.id)}><Pencil className="ml-1 h-3 w-3" /> تعديل</Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px] text-red-600" onClick={() => void deleteQuestion('PROGRAM', q)}><Trash2 className="ml-1 h-3 w-3" /> حذف</Button>
                            </span>
                          </div>
                          <p className="mt-1 text-slate-800">{q.text}</p>
                          {q.correctAnswer != null && <p className="text-emerald-700">الإجابة الصحيحة: خيار رقم {Number(q.correctAnswer) + 1}</p>}
                          {q.modelAnswer && <p className="text-slate-500">الإجابة النموذجية: {q.modelAnswer}</p>}
                        </div>
                      ))}
                      {!exam.questions.length && <p className="text-xs font-bold text-slate-400">لا أسئلة بعد في هذا الامتحان.</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent></Card>

      {myProposals.length > 0 && (
        <Card><CardContent className="space-y-2 p-5">
          <h4 className="text-sm font-black text-[#0f2b46]">اقتراحاتي على الوحدات</h4>
          {myProposals.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-600">
              <span className="text-slate-800">{p.title}</span>
              <span className="text-slate-400">{p.programTitle}</span>
              {p.status === 'PENDING' ? <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">بانتظار الإدارة</Badge> : p.status === 'APPROVED' ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">قُبل</Badge> : <Badge className="bg-red-100 text-red-700 hover:bg-red-100">رُفض</Badge>}
              {p.adminNote && <span className="w-full text-slate-500">رد الإدارة: {p.adminNote}</span>}
            </div>
          ))}
        </CardContent></Card>
      )}

      <Dialog open={!!form} onOpenChange={(open) => { if (!open) setForm(null) }}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto rounded-3xl" dir="rtl">
          {form && (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle className="font-black text-[#0f2b46]">{form.questionId ? 'تعديل سؤال' : 'إضافة سؤال يدوي'}</DialogTitle>
                <DialogDescription className="font-bold">{form.contextTitle} — يسري فورًا على البرنامج، ويصل الإدارة إشعار بالعملية.</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-xs font-black text-slate-600">النوع
                  <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold">
                    <option value="MCQ">اختيار من متعدد</option>
                    <option value="TF">صح / خطأ</option>
                    <option value="SHORT">إجابة قصيرة</option>
                    <option value="ESSAY">مقالي</option>
                  </select>
                </label>
                <label className="space-y-1 text-xs font-black text-slate-600">الصعوبة
                  <select value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value })} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold">
                    <option value="EASY">سهل</option>
                    <option value="MEDIUM">متوسط</option>
                    <option value="ADVANCED">متقدم</option>
                  </select>
                </label>
                {form.kind === 'PROGRAM' && (
                  <label className="space-y-1 text-xs font-black text-slate-600">الدرجة
                    <Input type="number" min={1} max={50} value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} />
                  </label>
                )}
              </div>
              <label className="block space-y-1 text-xs font-black text-slate-600">نص السؤال
                <Textarea rows={3} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
              </label>
              {isChoice && (
                <>
                  <label className="block space-y-1 text-xs font-black text-slate-600">الخيارات (كل خيار بسطر)
                    <Textarea rows={4} value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} />
                  </label>
                  <label className="block space-y-1 text-xs font-black text-slate-600">الإجابة الصحيحة (الذكاء والتصحيح الآلي يعتمدان عليها)
                    <select value={form.correctAnswer} onChange={(e) => setForm({ ...form, correctAnswer: e.target.value })} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold">
                      {formOptions.map((o, i) => <option key={i} value={String(i)}>خيار {i + 1}: {o}</option>)}
                      {!formOptions.length && <option value="0">اكتب الخيارات أولًا</option>}
                    </select>
                  </label>
                </>
              )}
              {!isChoice && (
                <label className="block space-y-1 text-xs font-black text-slate-600">الإجابة النموذجية (يصحّح الذكاء على أساسها — إلزامية)
                  <Textarea rows={3} value={form.modelAnswer} onChange={(e) => setForm({ ...form, modelAnswer: e.target.value })} />
                </label>
              )}
              <label className="block space-y-1 text-xs font-black text-slate-600">معايير التصحيح (اختياري)
                <Textarea rows={2} value={form.rubric} onChange={(e) => setForm({ ...form, rubric: e.target.value })} />
              </label>
              <Button onClick={() => void submitQuestion()} disabled={saving} className="w-full bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} {form.questionId ? 'حفظ التعديل' : 'إضافة السؤال'}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!proposal} onOpenChange={(open) => { if (!open) setProposal(null) }}>
        <DialogContent className="max-w-xl rounded-3xl" dir="rtl">
          {proposal && (
            <div className="space-y-3">
              <DialogHeader>
                <DialogTitle className="font-black text-[#0f2b46]">اقتراح على الوحدات</DialogTitle>
                <DialogDescription className="font-bold">{proposal.unitTitle ? `الوحدة: ${proposal.unitTitle} — ` : ''}الاقتراح يصل الإدارة وهي تقرر التنفيذ.</DialogDescription>
              </DialogHeader>
              <label className="block space-y-1 text-xs font-black text-slate-600">نوع الاقتراح
                <select value={proposal.kind} onChange={(e) => setProposal({ ...proposal, kind: e.target.value })} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-xs font-bold">
                  <option value="ADD">إضافة وحدة</option>
                  <option value="EDIT">تعديل وحدة</option>
                  <option value="REMOVE">حذف وحدة</option>
                  <option value="NOTE">ملاحظة عامة</option>
                </select>
              </label>
              <label className="block space-y-1 text-xs font-black text-slate-600">العنوان
                <Input value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} />
              </label>
              <label className="block space-y-1 text-xs font-black text-slate-600">التفاصيل
                <Textarea rows={4} value={proposal.details} onChange={(e) => setProposal({ ...proposal, details: e.target.value })} />
              </label>
              <Button onClick={() => void submitProposal()} disabled={saving} className="w-full bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} إرسال الاقتراح للإدارة
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
