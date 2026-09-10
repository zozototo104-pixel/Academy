'use client'

import { api } from '@/lib/store'
import { useCallback, useEffect, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Loader2, CheckCircle2, XCircle, Pencil, ShieldAlert, Camera, Bot,
  MessageSquareWarning, ClipboardCheck, AlertTriangle, Trash2, RefreshCw,
} from 'lucide-react'

const TYPE_AR: Record<string, string> = { MCQ: 'اختيار', TF: 'صح/خطأ', SHORT: 'إجابة قصيرة', ESSAY: 'مقالي' }
const SKILL_AR: Record<string, string> = { UNDERSTAND: 'فهم', APPLY: 'تطبيق', ANALYZE: 'تحليل', EVALUATE: 'تقييم' }
const DIFFICULTY_AR: Record<string, string> = { EASY: 'سهل', MEDIUM: 'متوسط', ADVANCED: 'متقدم' }
const FULL_EXAM_TARGET = 80

// ============================================================
// 12.2 — حوار المراجعة البشرية للأسئلة المولدة (Human-in-the-loop)
// ============================================================

interface DistractorRationale {
  optionIndex: number
  option: string
  reason: string
}

interface ReviewQuestion {
  id: string
  order: number
  type: string
  text: string
  options: string[] | null
  correctAnswer: string | null
  modelAnswer: string | null
  sourceEvidence?: string | null
  sourceBookTitle?: string | null
  sourceChapter?: string | null
  sourceLocator?: string | null
  cognitiveSkill?: string | null
  difficulty?: string | null
  correctRationale?: string | null
  distractorRationales?: DistractorRationale[]
  qualityFlags?: string[]
  reviewNotes?: string | null
  points: number
  status: string
}

interface QuestionDraft {
  text: string
  options: string[]
  correctAnswer: string
  modelAnswer: string
  sourceEvidence: string
  sourceBookTitle: string
  sourceChapter: string
  sourceLocator: string
  cognitiveSkill: string
  difficulty: string
  correctRationale: string
  distractorRationales: DistractorRationale[]
  qualityFlags: string[]
  reviewNotes: string
  points: number
}

export function QuestionReviewDialog({
  examId,
  examTitle,
  open,
  onClose,
  onPublished,
}: {
  examId: string
  examTitle: string
  open: boolean
  onClose: () => void
  onPublished: () => void
}) {
  const { toast } = useToast()
  const [questions, setQuestions] = useState<ReviewQuestion[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<QuestionDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'ALL' | 'PENDING_REVIEW' | 'PUBLISHED' | 'REJECTED'>('ALL')

  const load = useCallback(async () => {
    if (!examId) return
    setLoading(true)
    try {
      const d = await api<{ questions: ReviewQuestion[] }>(`/api/admin/program-exam-questions?examId=${examId}`)
      setQuestions(d.questions)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }, [examId, toast])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const startEdit = (q: ReviewQuestion) => {
    const options = q.options || (q.type === 'TF' ? ['صح', 'خطأ'] : ['', '', '', ''])
    const correctAnswer = q.correctAnswer || '0'
    const existingRationales = q.distractorRationales?.length
      ? q.distractorRationales
      : options
          .map((option, i) => String(i) === correctAnswer ? null : ({
            optionIndex: i,
            option,
            reason: q.type === 'TF'
              ? 'هذا الحكم يخالف الدليل المحدد في الكتاب.'
              : 'هذا الخيار مشتت لأنه لا يطابق الدليل أو المهارة المطلوبة في السؤال.',
          }))
          .filter(Boolean) as DistractorRationale[]
    setEditing(q.id)
    setDraft({
      text: q.text,
      options,
      correctAnswer,
      modelAnswer: q.modelAnswer || '',
      sourceEvidence: q.sourceEvidence || '',
      sourceBookTitle: q.sourceBookTitle || '',
      sourceChapter: q.sourceChapter || '',
      sourceLocator: q.sourceLocator || '',
      cognitiveSkill: q.cognitiveSkill || 'UNDERSTAND',
      difficulty: q.difficulty || 'MEDIUM',
      correctRationale: q.correctRationale || '',
      distractorRationales: existingRationales,
      qualityFlags: q.qualityFlags?.length ? q.qualityFlags : ['SOURCE_GROUNDED'],
      reviewNotes: q.reviewNotes || '',
      points: q.points,
    })
  }

  const saveEdit = async (id: string) => {
    if (!draft) return
    const current = questions.find((q) => q.id === id)
    setBusy(true)
    try {
      await api('/api/admin/program-exam-questions', {
        method: 'PATCH',
        body: JSON.stringify({
          questionId: id,
          action: 'EDIT',
          text: draft.text,
          options: current?.type === 'TF' ? ['صح', 'خطأ'] : draft.options,
          correctAnswer: draft.correctAnswer,
          modelAnswer: draft.modelAnswer,
          sourceEvidence: draft.sourceEvidence,
          sourceBookTitle: draft.sourceBookTitle,
          sourceChapter: draft.sourceChapter,
          sourceLocator: draft.sourceLocator,
          cognitiveSkill: draft.cognitiveSkill,
          difficulty: draft.difficulty,
          correctRationale: draft.correctRationale,
          distractorRationales: draft.distractorRationales,
          qualityFlags: draft.qualityFlags,
          reviewNotes: draft.reviewNotes,
          points: draft.points,
        }),
      })
      setQuestions((prev) => prev.map((q) => (q.id === id ? {
        ...q,
        text: draft.text,
        options: draft.options,
        correctAnswer: draft.correctAnswer,
        modelAnswer: draft.modelAnswer,
        sourceEvidence: draft.sourceEvidence,
        sourceBookTitle: draft.sourceBookTitle,
        sourceChapter: draft.sourceChapter,
        sourceLocator: draft.sourceLocator,
        cognitiveSkill: draft.cognitiveSkill,
        difficulty: draft.difficulty,
        correctRationale: draft.correctRationale,
        distractorRationales: draft.distractorRationales,
        qualityFlags: draft.qualityFlags,
        reviewNotes: draft.reviewNotes,
        points: draft.points,
      } : q)))
      setEditing(null)
      setDraft(null)
      toast({ title: 'تم حفظ التعديل' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const act = async (questionId: string, action: 'APPROVE' | 'REJECT') => {
    setBusy(true)
    try {
      await api('/api/admin/program-exam-questions', { method: 'PATCH', body: JSON.stringify({ questionId, action }) })
      setQuestions((prev) => prev.map((q) => (q.id === questionId ? { ...q, status: action === 'APPROVE' ? 'PUBLISHED' : 'REJECTED' } : q)))
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const deleteQuestion = async (q: ReviewQuestion) => {
    if (!confirm(`حذف السؤال رقم ${q.order} نهائياً من الامتحان؟`)) return
    setBusy(true)
    try {
      await api('/api/admin/program-exam-questions', {
        method: 'PATCH',
        body: JSON.stringify({ questionId: q.id, action: 'DELETE' }),
      })
      setQuestions((prev) => prev.filter((x) => x.id !== q.id).map((x, i) => ({ ...x, order: i + 1 })))
      toast({ title: 'تم حذف السؤال' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message || 'تعذر حذف السؤال', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const rebuildFromBooks = async () => {
    if (!confirm('سيتم حذف كل الأسئلة الحالية وإعادة بناء الامتحان من الكتب المقررة وفق المنطق الجديد المتنوع. متابعة؟')) return
    setBusy(true)
    try {
      const d = await api<{ questionCount?: number; inserted?: number; status?: string }>('/api/admin/program-exams/generate', {
        method: 'POST',
        body: JSON.stringify({ examId, action: 'rebuild' }),
      })
      toast({
        title: 'بدأت إعادة بناء الامتحان من الكتب',
        description: `تم إنشاء ${d.questionCount || d.inserted || 0} سؤالاً أولياً، وسيكمل النظام الدفعات التالية من صفحة الكتب`,
      })
      await load()
      onPublished()
      onClose()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message || 'تعذر إعادة بناء الامتحان', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const continueGeneration = async () => {
    if (!confirm(`هذا الامتحان فيه ${questions.length} سؤالاً فقط من ${FULL_EXAM_TARGET}. سيتم استكمال بقية الأسئلة من محتوى الكتب دون حذف الحالي. متابعة؟`)) return
    setBusy(true)
    try {
      const d = await api<{ questionCount?: number; inserted?: number; status?: string }>('/api/admin/program-exams/generate', {
        method: 'POST',
        body: JSON.stringify({ examId, action: 'kick' }),
      })
      toast({
        title: 'تم تحريك استكمال الامتحان',
        description: `أصبح العدد ${d.questionCount || questions.length} سؤالاً، وستكمل صفحة الكتب بقية الدفعات إذا بقيت مفتوحة`,
      })
      await load()
      onPublished()
      if (d.status === 'GENERATING') onClose()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message || 'تعذر استكمال التوليد', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const publish = async () => {
    if (questions.length < FULL_EXAM_TARGET) {
      toast({
        title: 'الامتحان غير مكتمل',
        description: `لا يمكن النشر الآن: الموجود ${questions.length} من ${FULL_EXAM_TARGET} سؤال. استخدم استكمال التوليد أو إعادة البناء أولاً.`,
        variant: 'destructive',
      })
      return
    }
    if (!confirm('سيتم اعتماد كل الأسئلة المعلّقة ونشر الامتحان للطلاب المتسجلين مع إشعارهم. متابعة؟')) return
    setBusy(true)
    try {
      const d = await api<{ published: number }>('/api/admin/program-exam-questions', {
        method: 'POST',
        body: JSON.stringify({ examId, action: 'APPROVE_ALL' }),
      })
      toast({ title: 'نُشر الامتحان', description: `${d.published} سؤالاً معتمداً — وصل إشعار للطلاب المتسجلين` })
      onPublished()
      onClose()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const pendingCount = questions.filter((q) => q.status === 'PENDING_REVIEW').length
  const shown = filter === 'ALL' ? questions : questions.filter((q) => q.status === filter)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 font-black text-[#0f2b46]">
            <ClipboardCheck className="h-5 w-5 text-[#a8841a]" /> مراجعة أسئلة الامتحان قبل النشر
            <Badge className="bg-amber-100 text-[10px] text-amber-700 hover:bg-amber-100">{pendingCount} بانتظار المراجعة</Badge>
          </DialogTitle>
          <DialogDescription>
            {examTitle} — راجع الأسئلة المولّدة بالذكاء الاصطناعي: عدّل ما يلزم، اعتمد السليم، ارفض غير الملائم، أو احذف السؤال نهائياً. لا يرى الطالب إلا الأسئلة المعتمدة.
          </DialogDescription>
          <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3">
            <p className="mb-2 text-[11px] font-bold leading-relaxed text-amber-800">
              إذا كانت الأسئلة القديمة مكررة أو خياراتها متشابهة، استخدم هذا الزر لإعادة بناء الامتحان من الكتب بالمنهجية الجديدة المتنوعة.
            </p>
            <div className="flex flex-wrap gap-2">
              {questions.length > 0 && questions.length < FULL_EXAM_TARGET && (
                <Button size="sm" variant="outline" onClick={continueGeneration} disabled={busy} className="border-orange-300 text-[10px] font-black text-orange-700 hover:bg-orange-100">
                  {busy ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                  استكمال بقية الامتحان ({questions.length}/{FULL_EXAM_TARGET})
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={rebuildFromBooks} disabled={busy} className="border-amber-300 text-[10px] font-black text-amber-700 hover:bg-amber-100">
                {busy ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="ml-1 h-3.5 w-3.5" />}
                إعادة بناء الامتحان من الكتب
              </Button>
            </div>
          </div>
        </DialogHeader>

        {loading ? (
          <div className="flex h-32 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              {(['ALL', 'PENDING_REVIEW', 'PUBLISHED', 'REJECTED'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full px-3 py-1 text-[10px] font-black transition-colors ${
                    filter === f ? 'bg-[#0f2b46] text-[#e0b83a]' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                  }`}
                >
                  {f === 'ALL' ? `الكل (${questions.length})` : f === 'PENDING_REVIEW' ? `معلّقة (${pendingCount})` : f === 'PUBLISHED' ? `معتمدة (${questions.filter((q) => q.status === 'PUBLISHED').length})` : `مرفوضة (${questions.filter((q) => q.status === 'REJECTED').length})`}
                </button>
              ))}
            </div>

            <div className="aact-scroll max-h-[52vh] space-y-3 overflow-y-auto pl-1">
              {shown.map((q) => (
                <div key={q.id} className={`rounded-xl border p-3.5 ${
                  q.status === 'PENDING_REVIEW' ? 'border-amber-200 bg-amber-50/40' :
                  q.status === 'REJECTED' ? 'border-red-100 bg-red-50/40 opacity-70' : 'border-emerald-100 bg-emerald-50/30'
                }`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#0f2b46] text-[10px] font-black text-[#e0b83a]">{q.order}</span>
                      <Badge variant="outline" className="border-[#c9a227]/40 text-[9px] font-bold text-[#a8841a]">{TYPE_AR[q.type]}</Badge>
                      <Badge variant="outline" className="border-slate-200 text-[9px] text-slate-500">{q.points} نقاط</Badge>
                      {q.cognitiveSkill && <Badge variant="outline" className="border-blue-200 text-[9px] text-blue-700">{SKILL_AR[q.cognitiveSkill] || q.cognitiveSkill}</Badge>}
                      {q.difficulty && <Badge variant="outline" className="border-purple-200 text-[9px] text-purple-700">{DIFFICULTY_AR[q.difficulty] || q.difficulty}</Badge>}
                      {q.sourceBookTitle && <Badge variant="outline" className="border-emerald-200 text-[9px] text-emerald-700">موثق بمصدر</Badge>}
                      <Badge className={`text-[9px] ${q.status === 'PENDING_REVIEW' ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : q.status === 'REJECTED' ? 'bg-red-100 text-red-600 hover:bg-red-100' : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100'}`}>
                        {q.status === 'PENDING_REVIEW' ? 'بانتظار المراجعة' : q.status === 'REJECTED' ? 'مرفوض' : 'معتمد'}
                      </Badge>
                    </div>
                    {editing !== q.id && (
                      <div className="flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => startEdit(q)} className="h-7 px-2 text-slate-500 hover:bg-white" title="تعديل">
                          <Pencil className="h-3 w-3" />
                        </Button>
                        {q.status !== 'PUBLISHED' && (
                          <Button size="sm" variant="ghost" onClick={() => act(q.id, 'APPROVE')} disabled={busy} className="h-7 px-2 text-emerald-600 hover:bg-emerald-50" title="اعتماد">
                            <CheckCircle2 className="h-3 w-3" />
                          </Button>
                        )}
                        {q.status !== 'REJECTED' && (
                          <Button size="sm" variant="ghost" onClick={() => act(q.id, 'REJECT')} disabled={busy} className="h-7 px-2 text-red-500 hover:bg-red-50" title="رفض">
                            <XCircle className="h-3 w-3" />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" onClick={() => deleteQuestion(q)} disabled={busy} className="h-7 px-2 text-red-600 hover:bg-red-50" title="حذف السؤال نهائياً">
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {editing === q.id && draft ? (
                    <div className="mt-2.5 space-y-2.5 rounded-lg bg-white p-3">
                      <div>
                        <Label className="text-[10px] font-black text-slate-600">نص السؤال</Label>
                        <Textarea value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} className="mt-1 min-h-16 text-xs" />
                      </div>
                      {q.type !== 'SHORT' && q.type !== 'ESSAY' && (
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">الخيارات + الإجابة الصحيحة</Label>
                          <div className="mt-1 space-y-1.5">
                            {draft.options.map((opt, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <input
                                  type="radio"
                                  name={`correct-${q.id}`}
                                  checked={draft.correctAnswer === String(i)}
                                  onChange={() => setDraft({ ...draft, correctAnswer: String(i) })}
                                  className="h-3.5 w-3.5 accent-emerald-600"
                                  title="الإجابة الصحيحة"
                                />
                                <Input value={opt} onChange={(e) => { const o = [...draft.options]; o[i] = e.target.value; setDraft({ ...draft, options: o }) }} className="h-8 flex-1 text-xs" />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {(q.type === 'SHORT' || q.type === 'ESSAY') && (
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">الإجابة النموذجية (تُقاس عليها إجابات الطلاب)</Label>
                          <Textarea value={draft.modelAnswer} onChange={(e) => setDraft({ ...draft, modelAnswer: e.target.value })} className="mt-1 min-h-20 text-xs" />
                        </div>
                      )}

                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">اسم الكتاب/المصدر</Label>
                          <Input value={draft.sourceBookTitle} onChange={(e) => setDraft({ ...draft, sourceBookTitle: e.target.value })} className="mt-1 h-8 text-xs" />
                        </div>
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">الفصل/المحور</Label>
                          <Input value={draft.sourceChapter} onChange={(e) => setDraft({ ...draft, sourceChapter: e.target.value })} className="mt-1 h-8 text-xs" placeholder="مثلاً: الفصل الثالث أو محور إدارة المخاطر" />
                        </div>
                      </div>
                      <div>
                        <Label className="text-[10px] font-black text-slate-600">المقطع أو موضع الدليل</Label>
                        <Textarea value={draft.sourceLocator} onChange={(e) => setDraft({ ...draft, sourceLocator: e.target.value })} className="mt-1 min-h-14 text-xs" />
                      </div>
                      <div>
                        <Label className="text-[10px] font-black text-slate-600">دليل السؤال من الكتاب</Label>
                        <Textarea value={draft.sourceEvidence} onChange={(e) => setDraft({ ...draft, sourceEvidence: e.target.value })} className="mt-1 min-h-16 text-xs" />
                      </div>
                      <div className="grid gap-2 md:grid-cols-2">
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">المهارة المقاسة</Label>
                          <Select value={draft.cognitiveSkill} onValueChange={(value) => setDraft({ ...draft, cognitiveSkill: value })}>
                            <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="UNDERSTAND">فهم</SelectItem>
                              <SelectItem value="APPLY">تطبيق</SelectItem>
                              <SelectItem value="ANALYZE">تحليل</SelectItem>
                              <SelectItem value="EVALUATE">تقييم</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">درجة الصعوبة</Label>
                          <Select value={draft.difficulty} onValueChange={(value) => setDraft({ ...draft, difficulty: value })}>
                            <SelectTrigger className="mt-1 h-8 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="EASY">سهل</SelectItem>
                              <SelectItem value="MEDIUM">متوسط</SelectItem>
                              <SelectItem value="ADVANCED">متقدم</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <div>
                        <Label className="text-[10px] font-black text-slate-600">سبب صحة الإجابة / معيار قبولها</Label>
                        <Textarea value={draft.correctRationale} onChange={(e) => setDraft({ ...draft, correctRationale: e.target.value })} className="mt-1 min-h-16 text-xs" />
                      </div>
                      {(q.type === 'MCQ' || q.type === 'TF') && draft.distractorRationales.length > 0 && (
                        <div>
                          <Label className="text-[10px] font-black text-slate-600">سبب خطأ الخيارات الأخرى</Label>
                          <div className="mt-1 space-y-1.5">
                            {draft.distractorRationales.map((r, idx) => (
                              <div key={`${r.optionIndex}-${idx}`} className="rounded-lg border border-slate-100 bg-slate-50 p-2">
                                <p className="mb-1 text-[10px] font-black text-slate-500">الخيار {r.optionIndex + 1}: {r.option}</p>
                                <Textarea
                                  value={r.reason}
                                  onChange={(e) => {
                                    const next = [...draft.distractorRationales]
                                    next[idx] = { ...next[idx], reason: e.target.value }
                                    setDraft({ ...draft, distractorRationales: next })
                                  }}
                                  className="min-h-12 text-xs"
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div>
                        <Label className="text-[10px] font-black text-slate-600">ملاحظات المراجعة البشرية</Label>
                        <Textarea value={draft.reviewNotes} onChange={(e) => setDraft({ ...draft, reviewNotes: e.target.value })} className="mt-1 min-h-14 text-xs" />
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-[10px] font-black text-slate-600">النقاط</Label>
                          <Input type="number" min="1" max="50" value={draft.points} onChange={(e) => setDraft({ ...draft, points: Number(e.target.value) })} className="h-8 w-20 text-xs" />
                        </div>
                        <div className="flex gap-1.5">
                          <Button size="sm" onClick={() => saveEdit(q.id)} disabled={busy} className="h-8 bg-emerald-600 text-[10px] font-black text-white hover:bg-emerald-700">
                            <CheckCircle2 className="ml-1 h-3 w-3" /> حفظ
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => { setEditing(null); setDraft(null) }} className="h-8 text-[10px] font-bold">إلغاء</Button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 text-xs leading-relaxed text-[#0f2b46]">
                      <p className="font-bold">{q.text}</p>
                      {q.options && (
                        <ul className="mt-1.5 space-y-0.5 text-[11px] text-slate-600">
                          {q.options.map((o, i) => (
                            <li key={i} className={String(i) === q.correctAnswer ? 'font-black text-emerald-700' : ''}>
                              {String(i) === q.correctAnswer ? '✓ ' : '· '}{o}
                            </li>
                          ))}
                        </ul>
                      )}
                      {q.sourceEvidence && (
                        <p className="mt-1.5 rounded-lg bg-[#fffaf0] p-2 text-[10px] font-bold leading-5 text-[#a8841a]"><strong>دليل السؤال من الكتاب/بنك المعرفة:</strong> {q.sourceEvidence}</p>
                      )}
                      {q.modelAnswer && (
                        <p className="mt-1.5 line-clamp-2 text-[10px] text-slate-500"><strong>نموذج الإجابة:</strong> {q.modelAnswer}</p>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {shown.length === 0 && (
                <p className="py-8 text-center text-xs font-bold text-slate-400">لا توجد أسئلة في هذا التصنيف</p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
              <p className="text-[10px] font-bold text-slate-500">
                المعتمد: {questions.filter((q) => q.status === 'PUBLISHED').length} من {questions.length} — الحد الأدنى للنشر 10 أسئلة معتمدة
              </p>
              <Button onClick={publish} disabled={busy} className="bg-emerald-600 font-extrabold text-white hover:bg-emerald-700">
                {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
                اعتماد المعلّق ونشر الامتحان للطلاب
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ============================================================
// 12.2 — لوحة الاعتراضات على النتائج (مراجعة يدوية بشرية)
// ============================================================

interface Appeal {
  id: string
  student: { id: string; name: string; email: string }
  examTitle: string
  program: string
  semester: number
  passScore: number
  score: number | null
  finalScore: number | null
  passed: boolean | null
  appealStatus: string
  appealReason: string | null
  appealResponse: string | null
  appealedAt: string | null
  proctoring: { enabled: boolean; violations: number; log: { t: number; type: string }[]; snapshot: string | null }
  answers: {
    id: string
    order: number
    type: string
    questionText: string
    points: number
    studentAnswer: string | null
    modelAnswer: string | null
    awarded: number | null
    maxPoints: number | null
    aiFeedback: string | null
  }[]
}

export function AdminAppealsSection() {
  const { toast } = useToast()
  const [appeals, setAppeals] = useState<Appeal[]>([])
  const [loading, setLoading] = useState(true)
  const [active, setActive] = useState<Appeal | null>(null)
  const [finalScore, setFinalScore] = useState('')
  const [response, setResponse] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSnapshot, setShowSnapshot] = useState(false)

  const load = useCallback(() => {
    api<{ appeals: Appeal[] }>('/api/admin/appeals')
      .then((d) => setAppeals(d.appeals))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(load, [load])

  const resolve = async () => {
    if (!active) return
    const score = Number(finalScore)
    if (isNaN(score) || score < 0 || score > 100) {
      toast({ title: 'تنبيه', description: 'أدخل درجة نهائية من 0 إلى 100', variant: 'destructive' })
      return
    }
    if (!response.trim()) {
      toast({ title: 'تنبيه', description: 'اكتب رد المراجعة للطالب', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      await api('/api/admin/appeals', {
        method: 'PATCH',
        body: JSON.stringify({ attemptId: active.id, finalScore: score, response }),
      })
      toast({ title: 'تم حسم الاعتراض', description: `الدرجة النهائية ${score}% — أُبلغ الطالب برده` })
      setActive(null)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return <div className="flex h-32 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-[#c9a227]" /></div>
  }

  const pending = appeals.filter((a) => a.appealStatus === 'PENDING')

  return (
    <Card className="border-[#0f2b46]/10">
      <CardContent className="p-5 sm:p-6">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-black text-[#0f2b46]">
          <MessageSquareWarning className="h-4.5 w-4.5 text-[#a8841a]" />
          الاعتراضات على نتائج الامتحانات ({pending.length} قيد المراجعة اليدوية)
        </h2>
        <p className="mb-4 text-[11px] font-bold text-slate-500">
          وفقاً لنظام الامتحانات الذكي: اعتراض الطالب يوقف النتيجة الآلية وينقل القرار للمشرف البشري/الإدارة
        </p>

        {appeals.length === 0 ? (
          <div className="rounded-xl bg-slate-50 p-6 text-center text-xs text-slate-500">لا توجد اعتراضات على النتائج</div>
        ) : (
          <div className="space-y-3">
            {appeals.map((a) => (
              <div key={a.id} className="rounded-xl border border-slate-100 bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-xs font-extrabold text-[#0f2b46]">{a.student.name}</h3>
                      <Badge variant="outline" className="border-slate-200 text-[9px] text-slate-500">{a.program}</Badge>
                      <Badge className={a.appealStatus === 'PENDING' ? 'bg-amber-100 text-[9px] text-amber-700 hover:bg-amber-100' : 'bg-emerald-100 text-[9px] text-emerald-700 hover:bg-emerald-100'}>
                        {a.appealStatus === 'PENDING' ? 'قيد المراجعة' : `محسوم: ${a.finalScore}%`}
                      </Badge>
                      {a.proctoring.enabled && a.proctoring.violations > 0 && (
                        <Badge className="bg-red-100 text-[9px] text-red-600 hover:bg-red-100">
                          <ShieldAlert className="ml-1 h-2.5 w-2.5" /> {a.proctoring.violations} مخالفة مراقبة
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] font-bold text-slate-600">{a.examTitle} — النتيجة الآلية: {a.score}%</p>
                    <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-slate-500">«{a.appealReason}»</p>
                  </div>
                  <Button size="sm" onClick={() => { setActive(a); setFinalScore(String(Math.round(a.score || 0))); setResponse(''); }} className="shrink-0 bg-[#0f2b46] text-[10px] font-black text-[#e0b83a] hover:bg-[#12365c]">
                    {a.appealStatus === 'PENDING' ? 'مراجعة الاعتراض' : 'عرض التفاصيل'}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* نافذة مراجعة الاعتراض */}
        <Dialog open={!!active} onOpenChange={(v) => !v && setActive(null)}>
          <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto" dir="rtl">
            <DialogHeader>
              <DialogTitle className="font-black text-[#0f2b46]">مراجعة اعتراض — {active?.student.name}</DialogTitle>
              <DialogDescription>{active?.examTitle} — النتيجة الآلية: {active?.score}% (حد النجاح {active?.passScore}%)</DialogDescription>
            </DialogHeader>

            {active && (
              <div className="space-y-4">
                {/* تقرير المراقبة الإلكترونية إن وُجد */}
                {active.proctoring.enabled && (
                  <div className={`rounded-xl p-3.5 ${active.proctoring.violations > 3 ? 'bg-red-50' : 'bg-slate-50'}`}>
                    <h4 className="flex items-center gap-1.5 text-[11px] font-black text-[#0f2b46]">
                      <ShieldAlert className={`h-4 w-4 ${active.proctoring.violations > 3 ? 'text-red-500' : 'text-slate-400'}`} />
                      تقرير المراقبة الإلكترونية — {active.proctoring.violations} مخالفة (تبديل نوافذ/خروج من الشاشة)
                    </h4>
                    {active.proctoring.log.length > 0 && (
                      <p className="mt-1.5 line-clamp-2 text-[10px] leading-relaxed text-slate-500" dir="ltr">
                        {active.proctoring.log.map((v, i) => new Date(v.t).toLocaleTimeString('en-GB') + ' ' + v.type).join(' | ')}
                      </p>
                    )}
                    {active.proctoring.snapshot && (
                      <Button size="sm" variant="outline" onClick={() => setShowSnapshot(true)} className="mt-2 h-7 border-slate-200 text-[10px] font-bold">
                        <Camera className="ml-1 h-3 w-3" /> عرض لقطة الكاميرا عند التسليم
                      </Button>
                    )}
                  </div>
                )}

                <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/40 p-3.5">
                  <h4 className="text-[11px] font-black text-[#a8841a]">سبب الاعتراض</h4>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#5c4d1a]">{active.appealReason}</p>
                </div>

                <div>
                  <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-black text-[#0f2b46]">
                    <Bot className="h-3.5 w-3.5 text-[#a8841a]" /> إجابات الطالب مقابل النموذجية ({active.answers.length} سؤالاً)
                  </h4>
                  <div className="aact-scroll max-h-64 space-y-2 overflow-y-auto pl-1">
                    {active.answers
                      .filter((ans) => (ans.studentAnswer && ans.studentAnswer.length > 2) || (ans.awarded ?? 0) < (ans.maxPoints ?? 0))
                      .slice(0, 30)
                      .map((ans) => (
                        <div key={ans.id} className="rounded-lg bg-slate-50 p-2.5 text-[10px] leading-relaxed">
                          <p className="font-extrabold text-[#0f2b46]">{ans.order}. {ans.questionText}</p>
                          <p className="mt-1 text-slate-600"><strong>إجابة الطالب:</strong> {ans.studentAnswer || '(بدون إجابة)'} — <strong>النقاط:</strong> {ans.awarded ?? 0}/{ans.maxPoints}</p>
                          {ans.modelAnswer && <p className="mt-0.5 line-clamp-2 text-slate-400"><strong>النموذجية:</strong> {ans.modelAnswer}</p>}
                        </div>
                      ))}
                  </div>
                </div>

                {active.appealStatus === 'PENDING' ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs font-black">الدرجة النهائية (0-100)</Label>
                        <Input type="number" min="0" max="100" value={finalScore} onChange={(e) => setFinalScore(e.target.value)} />
                      </div>
                      <div className="space-y-1.5 sm:col-span-2">
                        <Label className="text-xs font-black">رد المراجعة للطالب</Label>
                        <Textarea value={response} onChange={(e) => setResponse(e.target.value)} placeholder="اشرح قرارك النهائي وما تم تعديله..." className="min-h-16 text-xs" />
                      </div>
                    </div>
                    <Button onClick={resolve} disabled={busy} className="w-full bg-emerald-600 font-extrabold text-white hover:bg-emerald-700">
                      {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
                      حسم الاعتراض وإبلاغ الطالب
                    </Button>
                  </>
                ) : (
                  <div className="rounded-xl bg-emerald-50 p-3.5 text-[11px] leading-relaxed text-emerald-800">
                    <strong>تم الحسم — الدرجة النهائية: {active.finalScore}%</strong>
                    <p className="mt-1">{active.appealResponse}</p>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* لقطة الكاميرا */}
        <Dialog open={showSnapshot} onOpenChange={setShowSnapshot}>
          <DialogContent className="max-w-md" dir="rtl">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
                <Camera className="h-5 w-5 text-[#a8841a]" /> لقطة المراقبة عند التسليم
              </DialogTitle>
            </DialogHeader>
            {active?.proctoring.snapshot && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={active.proctoring.snapshot} alt="لقطة كاميرا الطالب" className="w-full rounded-xl border" />
            )}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  )
}
