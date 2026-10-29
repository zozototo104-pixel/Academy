'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ClipboardCheck, Gavel, Loader2 } from 'lucide-react'

// مراجعة الدرجات والالتماسات عند المشرف: النتيجة تصل الطالب فور
// تصحيح الذكاء كما هي اليوم — وهنا يراجع المشرف طلابه متى شاء:
// يرى تصحيح الذكاء سؤالًا سؤالًا (المقالي خاصة)، يعدّل الدرجات
// فتتحدث نتيجة الطالب، ويبتّ في التماسات المراجعة الموجهة إليه.

function aiFeedbackText(raw: string | null): string {
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      return String(parsed.feedback || parsed.summary || parsed.rationale || '').trim()
    }
  } catch { /* نص خام */ }
  return raw
}

function dateAr(value: string | null | undefined) {
  if (!value) return '—'
  try { return new Date(value).toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' }) } catch { return '—' }
}

export function SupervisorGradeReviewTab() {
  const { toast } = useToast()
  const [appeals, setAppeals] = useState<any[]>([])
  const [attempts, setAttempts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState<any>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [appealDrafts, setAppealDrafts] = useState<Record<string, { response: string; finalScore: string }>>({})

  const load = useCallback(async () => {
    try {
      const [a, t] = await Promise.all([
        api<{ appeals: any[] }>('/api/supervisor/appeals').catch(() => ({ appeals: [] })),
        api<{ attempts: any[] }>('/api/supervisor/grade-review').catch(() => ({ attempts: [] })),
      ])
      setAppeals(a.appeals || [])
      setAttempts(t.attempts || [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const openDetail = async (type: string, id: string) => {
    try {
      const d = await api<{ attempt: any }>(`/api/supervisor/grade-review?type=${type}&id=${encodeURIComponent(id)}`)
      setDetail(d.attempt)
      setEdits({})
    } catch (e: any) {
      toast({ title: 'تعذر فتح المحاولة', description: e?.message || '', variant: 'destructive' })
    }
  }

  const saveAdjustments = async () => {
    if (!detail) return
    const scores: Record<string, number> = {}
    for (const [answerId, value] of Object.entries(edits)) {
      if (value.trim() !== '') scores[answerId] = Number(value)
    }
    if (!Object.keys(scores).length) { toast({ title: 'لا تعديلات — غيّر درجة سؤال واحد على الأقل' }); return }
    setSaving(true)
    try {
      const r = await api<{ score: number; passed: boolean }>('/api/supervisor/grade-review', { method: 'PATCH', body: JSON.stringify({ type: detail.type, attemptId: detail.id, scores }) })
      toast({ title: `اعتُمدت المراجعة — النتيجة الجديدة ${r.score}%`, description: r.passed ? 'الطالب ناجح بهذه النتيجة' : 'النتيجة دون حد النجاح' })
      setDetail(null)
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر اعتماد المراجعة', description: e?.message || '', variant: 'destructive' })
    } finally { setSaving(false) }
  }

  const resolveAppeal = async (appeal: any, action: 'APPROVE' | 'REJECT') => {
    const draft = appealDrafts[appeal.id] || { response: '', finalScore: '' }
    if (action === 'APPROVE' && draft.finalScore.trim() === '') { toast({ title: 'قبول الالتماس يحتاج درجة نهائية', variant: 'destructive' }); return }
    setSaving(true)
    try {
      await api('/api/supervisor/appeals', { method: 'PATCH', body: JSON.stringify({ type: appeal.type, attemptId: appeal.id, action, response: draft.response, finalScore: draft.finalScore === '' ? undefined : Number(draft.finalScore) }) })
      toast({ title: action === 'APPROVE' ? 'قُبل الالتماس واعتُمدت الدرجة' : 'رُفض الالتماس وبقيت النتيجة' })
      await load()
    } catch (e: any) {
      toast({ title: 'تعذر البت في الالتماس', description: e?.message || '', variant: 'destructive' })
    } finally { setSaving(false) }
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" /></div>

  return (
    <div className="space-y-5" dir="rtl">
      <Card className={appeals.length ? 'border-red-200' : ''}><CardContent className="space-y-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-black text-[#0f2b46]"><Gavel className="h-5 w-5 text-[#a8841a]" /> التماسات مراجعة بانتظار بتّك ({appeals.length})</h3>
        {!appeals.length && <p className="text-xs font-bold text-slate-500">لا التماسات معلّقة من طلابك. الالتماس يصلك فقط من طالب معيّن عليك أنت.</p>}
        {appeals.map((a) => {
          const draft = appealDrafts[a.id] || { response: '', finalScore: '' }
          return (
            <div key={`${a.type}-${a.id}`} className="space-y-2 rounded-2xl border border-red-100 bg-red-50/50 p-4 text-xs font-bold leading-6 text-slate-600">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-black text-[#0f2b46]">{a.student.name}</span>
                <Badge variant="outline" className="text-[10px]">{a.type === 'UNIT' ? `امتحان وحدة: ${a.exam.unitTitle || ''}` : 'امتحان فصلي'}</Badge>
                <span>{a.exam.title} — {a.exam.programTitle}</span>
                <Badge className="bg-white text-slate-700 hover:bg-white">النتيجة الحالية: {a.finalScore ?? a.score ?? '—'}%</Badge>
                <span className="text-slate-400">{dateAr(a.appealedAt)}</span>
              </div>
              <p className="rounded-xl bg-white p-3">سبب الالتماس: {a.appealReason}</p>
              <div className="flex flex-wrap items-end gap-2">
                <Button size="sm" variant="outline" className="text-[11px] font-bold" onClick={() => void openDetail(a.type, a.id)}>مراجعة الإجابات أولًا</Button>
                <label className="space-y-1 text-[11px] font-black text-slate-500">درجة نهائية عند القبول
                  <Input type="number" min={0} max={100} value={draft.finalScore} onChange={(e) => setAppealDrafts((s) => ({ ...s, [a.id]: { ...draft, finalScore: e.target.value } }))} className="w-28 bg-white" />
                </label>
                <label className="min-w-52 flex-1 space-y-1 text-[11px] font-black text-slate-500">ردّك للطالب
                  <Input value={draft.response} onChange={(e) => setAppealDrafts((s) => ({ ...s, [a.id]: { ...draft, response: e.target.value } }))} className="bg-white" placeholder="اختياري — يصل الطالب مع القرار" />
                </label>
                <Button size="sm" disabled={saving} className="bg-emerald-600 text-[11px] font-black hover:bg-emerald-700" onClick={() => void resolveAppeal(a, 'APPROVE')}>قبول واعتماد الدرجة</Button>
                <Button size="sm" disabled={saving} variant="outline" className="text-[11px] font-black text-red-600" onClick={() => void resolveAppeal(a, 'REJECT')}>رفض الالتماس</Button>
              </div>
            </div>
          )
        })}
      </CardContent></Card>

      <Card><CardContent className="space-y-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-black text-[#0f2b46]"><ClipboardCheck className="h-5 w-5 text-[#a8841a]" /> محاولات طلابي المصححة — مراجعة وتعديل ({attempts.length})</h3>
        <p className="text-[11px] font-bold leading-6 text-slate-500">النتيجة وصلت الطالب فور تصحيح الذكاء. مراجعتك هنا لاحقة: افتح أي محاولة، شوف كيف صحّح الذكاء كل إجابة — والمقالي بالتفصيل — وعدّل ما تراه مقيّدًا؛ النتيجة عند الطالب تتحدث فورًا وتُوثَّق المراجعة باسمك.</p>
        {!attempts.length && <p className="text-xs font-bold text-slate-500">لا محاولات مصححة بعد لطلابك.</p>}
        {attempts.map((a) => (
          <div key={`${a.type}-${a.id}`} className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-100 bg-slate-50/60 p-3.5 text-xs font-bold text-slate-600">
            <span className="text-sm font-black text-[#0f2b46]">{a.student.name}</span>
            <Badge variant="outline" className="text-[10px]">{a.type === 'UNIT' ? `وحدة: ${a.exam.unitTitle || ''}` : 'فصلي'}</Badge>
            <span>{a.exam.title}</span>
            <Badge className={(a.finalScore ?? a.score ?? 0) >= 60 ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-100 text-amber-700 hover:bg-amber-100'}>{a.finalScore ?? a.score ?? '—'}%</Badge>
            {a.status === 'NEEDS_REVIEW' && <Badge className="bg-red-100 text-red-700 hover:bg-red-100">تحتاج مراجعة</Badge>}
            {a.appealStatus === 'PENDING' && <Badge className="bg-red-600 text-white hover:bg-red-600">عليها التماس</Badge>}
            {a.reviewedAt && <Badge variant="outline" className="text-[10px]">رُوجعت بشريًا</Badge>}
            <span className="text-slate-400">{dateAr(a.submittedAt)}</span>
            <span className="mr-auto"><Button size="sm" className="bg-[#0f2b46] text-[11px] font-bold hover:bg-[#12365c]" onClick={() => void openDetail(a.type, a.id)}>مراجعة التصحيح</Button></span>
          </div>
        ))}
      </CardContent></Card>

      <Dialog open={!!detail} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto rounded-3xl" dir="rtl">
          {detail && (
            <div className="space-y-4">
              <DialogHeader>
                <DialogTitle className="font-black text-[#0f2b46]">مراجعة تصحيح — {detail.student.name}</DialogTitle>
                <DialogDescription className="font-bold leading-6">
                  {detail.exam.title} ({detail.exam.programTitle}) — النتيجة الحالية: {detail.finalScore ?? detail.score ?? '—'}% — حد النجاح {detail.exam.passScore}%
                  {detail.appealStatus === 'PENDING' && <span className="text-red-600"> — على هذه المحاولة التماس معلّق: «{detail.appealReason}» (اعتماد تعديلك يقفله تلقائيًا)</span>}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                {detail.answers.map((a: any) => (
                  <div key={a.answerId} className="space-y-2 rounded-2xl border border-slate-100 bg-slate-50/70 p-4 text-xs font-bold leading-6 text-slate-600">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="text-[10px]">{a.order}. {a.questionType}</Badge>
                      {a.questionType === 'MCQ' || a.questionType === 'TF' ? (
                        a.isCorrect ? <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">صحيحة</Badge> : <Badge className="bg-red-100 text-red-700 hover:bg-red-100">خاطئة</Badge>
                      ) : null}
                      <span className="mr-auto flex items-center gap-1.5">
                        <span className="text-slate-500">درجة الذكاء: {a.points ?? '—'} / {a.maxPoints}</span>
                        <Input
                          type="number" min={0} max={a.maxPoints} step="0.5"
                          placeholder={a.points == null ? '' : String(a.points)}
                          value={edits[a.answerId] ?? ''}
                          onChange={(e) => setEdits((s) => ({ ...s, [a.answerId]: e.target.value }))}
                          className="w-24 bg-white text-center"
                        />
                      </span>
                    </div>
                    <p className="text-slate-800">{a.question}</p>
                    {a.studentAnswer ? <p className="rounded-xl bg-white p-2.5">إجابة الطالب: {a.studentAnswer}</p> : a.selectedOption != null ? <p>اختار الطالب الخيار رقم {a.selectedOption + 1}</p> : <p className="text-slate-400">لا إجابة مكتوبة.</p>}
                    {a.modelAnswer && <p className="text-slate-500">الإجابة النموذجية: {a.modelAnswer}</p>}
                    {a.correctAnswer != null && <p className="text-emerald-700">الإجابة الصحيحة: خيار رقم {Number(a.correctAnswer) + 1}</p>}
                    {aiFeedbackText(a.aiFeedback) && <p className="rounded-xl bg-[#fffaf0] p-2.5 text-[#7a5b13]">تعليل الذكاء: {aiFeedbackText(a.aiFeedback)}</p>}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={() => void saveAdjustments()} disabled={saving} className="bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                  {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null} اعتماد التعديلات وتحديث النتيجة
                </Button>
                <p className="text-[11px] font-bold text-slate-400">اترك خانة الدرجة فارغة لما لا تريد تغييره.</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
