'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'

type ReviewAttempt = { type: 'UNIT' | 'PROGRAM'; id: string; submittedAt: string; student: { name: string; email: string }; exam: { title: string; programTitle?: string; unitTitle?: string } }
type ReviewDetail = { type: 'UNIT' | 'PROGRAM'; id: string; answers: Array<{ answerId: string; order: number; question: string; studentAnswer: string; modelAnswer: string; source: string; points: number | null; maxPoints: number; aiFeedback: string | null }> }

export default function AdminGradingReviewTab() {
  const { toast } = useToast()
  const [attempts, setAttempts] = useState<ReviewAttempt[]>([])
  const [selected, setSelected] = useState<ReviewDetail | null>(null)
  const [scores, setScores] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const res = await api<{ attempts: ReviewAttempt[] }>('/api/admin/attempts-review')
      setAttempts(res.attempts || [])
    } finally { setLoading(false) }
  }

  const open = async (item: ReviewAttempt) => {
    const res = await api<{ attempt: ReviewDetail }>(`/api/admin/attempts-review?type=${item.type}&id=${item.id}`)
    setSelected(res.attempt)
    setScores(Object.fromEntries((res.attempt?.answers || []).map((a) => [a.answerId, String(a.points ?? '')])))
  }

  const regrade = async () => {
    if (!selected) return
    const res = await api(`/api/admin/attempts-review`, { method: 'POST', body: JSON.stringify({ type: selected.type, attemptId: selected.id }) })
    toast({ title: 'تمت إعادة التصحيح الآلي', description: `النتيجة: ${(res as any).score ?? ''}` })
    setSelected(null)
    await load()
  }

  const approve = async () => {
    if (!selected) return
    const res = await api(`/api/admin/attempts-review`, { method: 'PATCH', body: JSON.stringify({ type: selected.type, attemptId: selected.id, scores }) })
    toast({ title: 'تم اعتماد نتيجة المراجعة', description: `النتيجة: ${(res as any).score ?? ''}` })
    setSelected(null)
    await load()
  }

  useEffect(() => { void load() }, [])

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[360px_1fr]" dir="rtl">
      <Card className="border-amber-200">
        <CardContent className="p-4">
          <div className="mb-3 flex items-center justify-between"><h3 className="font-black text-[#0f2b46]">مراجعة التصحيح</h3><Badge>{attempts.length} معلقة</Badge></div>
          {loading ? <p className="text-sm text-slate-500">جاري التحميل...</p> : attempts.length === 0 ? <p className="text-sm font-bold text-emerald-700">لا توجد محاولات معلقة.</p> : <div className="space-y-2">{attempts.map((a) => <button key={`${a.type}:${a.id}`} onClick={() => open(a)} className="w-full rounded-xl border bg-white p-3 text-right text-xs hover:bg-amber-50"><p className="font-black text-[#0f2b46]">{a.student.name}</p><p className="text-slate-500">{a.exam.title}</p><p className="text-slate-400">{a.type === 'UNIT' ? 'اختبار وحدة' : 'امتحان برنامج'} · {new Date(a.submittedAt).toLocaleString('ar')}</p></button>)}</div>}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-4">
          {!selected ? <p className="text-sm font-bold text-slate-500">اختر محاولة لعرض الأسئلة المقالية وإقرار النتيجة.</p> : <div className="space-y-4">
            <div className="flex flex-wrap gap-2"><Button onClick={regrade} variant="outline">إعادة التصحيح الآلي</Button><Button onClick={approve} className="bg-[#0f2b46] text-[#f5f0e1]">اعتماد النتيجة</Button></div>
            {selected.answers.map((a) => <div key={a.answerId} className="rounded-2xl border p-3 text-sm">
              <p className="font-black text-[#0f2b46]">سؤال {a.order}: {a.question}</p>
              <p className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 p-2"><b>إجابة الطالب:</b> {a.studentAnswer || '—'}</p>
              <p className="mt-2 whitespace-pre-wrap rounded-xl bg-emerald-50 p-2"><b>الإجابة النموذجية:</b> {a.modelAnswer || '—'}</p>
              {a.source && <p className="mt-2 whitespace-pre-wrap rounded-xl bg-amber-50 p-2"><b>المصدر:</b> {a.source}</p>}
              {a.aiFeedback && <p className="mt-2 whitespace-pre-wrap rounded-xl bg-blue-50 p-2"><b>نتيجة AI:</b> {a.aiFeedback}</p>}
              <label className="mt-3 block text-xs font-black">النقاط من {a.maxPoints}</label>
              <Input value={scores[a.answerId] || ''} onChange={(e) => setScores((prev) => ({ ...prev, [a.answerId]: e.target.value }))} />
            </div>)}
          </div>}
        </CardContent>
      </Card>
    </div>
  )
}
