'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { CheckCircle2, HeartHandshake, Loader2 } from 'lucide-react'

// ===== قائمة الاسترحام (إدارة) =====
// الاسترحام كان نظامًا خادميًا بلا أي شاشة: هذه القائمة هي باب
// الإدارة إليه — إسناد النشاط العلاجي لطلب قائم (عنوان ووزن
// 1–50٪ ومهلة ≤ 7 أيام)، وتصحيح التسليم عند وصوله. بعد التصحيح
// تُعاد مصادقة نتيجة الفصل من بطاقة الطالب (شروط الفصل) فيُختم
// الطلب «مكتملًا» ويُحتسب للطالب عند بوابات الانتقال.

type MercyRow = {
  id: string
  userId: string
  programId: string
  semester: number
  status: string
  initiatedBy: string
  activityTitle: string | null
  activityInstructions: string | null
  weightPercent: number | null
  dueAt: string | null
  submissionText: string | null
  submittedAt: string | null
  score: number | null
  previousAverage: number | null
  newAverage: number | null
  createdAt: string
  studentName: string | null
  studentEmail: string | null
  programTitle: string | null
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'بانتظار إسناد النشاط', cls: 'bg-amber-100 text-amber-700' },
  ACTIVITY_ASSIGNED: { label: 'بانتظار تسليم الطالب', cls: 'bg-sky-100 text-sky-700' },
  SUBMITTED: { label: 'بانتظار التصحيح', cls: 'bg-amber-100 text-amber-700' },
  GRADED: { label: 'مصحَّح — بانتظار إعادة اعتماد الفصل', cls: 'bg-violet-100 text-violet-700' },
  COMPLETED: { label: 'مكتمل — أُعيد اعتماد المعدل', cls: 'bg-emerald-100 text-emerald-700' },
  LAPSED: { label: 'انقضت المهلة دون تسليم', cls: 'bg-slate-100 text-slate-500' },
  REJECTED: { label: 'مرفوض', cls: 'bg-red-100 text-red-600' },
}

export function AdminMercyQueue() {
  const { toast } = useToast()
  const [rows, setRows] = useState<MercyRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [assign, setAssign] = useState<Record<string, { title: string; instructions: string; weight: string; dueAt: string }>>({})
  const [scores, setScores] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    try {
      const r = await api<{ requests: MercyRow[] }>('/api/admin/mercy')
      setRows(r.requests || [])
      setLoadError(null)
    } catch (error: any) {
      setLoadError(error?.message || 'تعذر تحميل طلبات الاسترحام')
    }
  }, [])

  useEffect(() => {
    let alive = true
    api<{ requests: MercyRow[] }>('/api/admin/mercy')
      .then((r) => { if (alive) { setRows(r.requests || []); setLoadError(null) } })
      .catch((error: any) => { if (alive) { setRows([]); setLoadError(error?.message || 'تعذر تحميل طلبات الاسترحام') } })
    return () => { alive = false }
  }, [])

  if (rows === null) return <p className="mt-4 text-xs font-bold text-slate-500">جاري تحميل قائمة الاسترحام...</p>

  const actionable = rows.filter((r) => r.status === 'REQUESTED' || r.status === 'SUBMITTED').length

  const doAssign = async (m: MercyRow) => {
    const f = assign[m.id] || { title: '', instructions: '', weight: '', dueAt: '' }
    const weightPercent = Number(f.weight)
    if (!f.title.trim()) { toast({ title: 'اكتب عنوان النشاط', variant: 'destructive' }); return }
    if (!Number.isFinite(weightPercent) || weightPercent < 1 || weightPercent > 50) {
      toast({ title: 'وزن النشاط بين 1 و50 بالمئة', variant: 'destructive' }); return
    }
    setBusy(`assign:${m.id}`)
    try {
      await api('/api/admin/mercy', {
        method: 'POST',
        body: JSON.stringify({
          action: 'assign', mercyId: m.id, title: f.title.trim(),
          instructions: f.instructions.trim() || null, weightPercent,
          dueAt: f.dueAt ? new Date(f.dueAt).toISOString() : null,
        }),
      })
      toast({ title: 'أُسند النشاط العلاجي', description: 'أُشعر الطالب — التسليم من بوابته قبل الموعد.' })
      await load()
    } catch (err: any) {
      toast({ title: 'تعذّر الإسناد', description: err?.message || 'حاول مجددًا', variant: 'destructive' })
    } finally { setBusy(null) }
  }

  const doGrade = async (m: MercyRow) => {
    const score = Number(scores[m.id])
    if (!Number.isFinite(score) || score < 0 || score > 100) {
      toast({ title: 'الدرجة بين 0 و100', variant: 'destructive' }); return
    }
    setBusy(`grade:${m.id}`)
    try {
      await api('/api/admin/mercy', { method: 'POST', body: JSON.stringify({ action: 'grade', mercyId: m.id, score }) })
      toast({ title: 'صُحّح النشاط', description: 'أعد اعتماد نتيجة الفصل من بطاقة الطالب ليصبح المعدل الجديد رسميًا ويُختم الاسترحام.' })
      await load()
    } catch (err: any) {
      toast({ title: 'تعذّر التصحيح', description: err?.message || 'حاول مجددًا', variant: 'destructive' })
    } finally { setBusy(null) }
  }

  return (
    <Card className="mt-4 border-rose-200">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
            <HeartHandshake className="h-5 w-5 text-rose-500" />
            الاسترحام — الأنشطة العلاجية لفصول راسبة مغلقة
          </p>
          {actionable > 0 && <Badge className="bg-rose-100 text-rose-700">{actionable} بانتظار إجراء منك</Badge>}
        </div>
        <p className="text-[11px] font-bold leading-5 text-slate-500">
          استرحام واحد لكل فصل راسب معتمد: نشاط علاجي حقيقي بوزن 1–50٪ من المعدل ومهلة لا تتجاوز 7 أيام.
          بعد تصحيح النشاط، أعد اعتماد نتيجة الفصل من بطاقة الطالب (شروط الفصل) — يُختم الطلب مكتملًا ويُفتح للطالب باب الانتقال.
        </p>

        {loadError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700">{loadError}</p>}
        {!loadError && rows.length === 0 && <p className="rounded-xl bg-slate-50 p-3 text-xs font-bold text-slate-500">لا توجد طلبات استرحام حاليًا.</p>}
        {rows.map((m) => {
          const meta = STATUS_META[m.status] || { label: m.status, cls: 'bg-slate-100 text-slate-500' }
          const f = assign[m.id] || { title: '', instructions: '', weight: '', dueAt: '' }
          const overdue = m.status === 'ACTIVITY_ASSIGNED' && m.dueAt && new Date(m.dueAt).getTime() < Date.now()
          return (
            <div key={m.id} className="space-y-2 rounded-xl border border-slate-200 p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-sm font-black text-[#0f2b46]">{m.studentName || 'طالب'}{m.programTitle ? ` — ${m.programTitle}` : ''}</p>
                  <p className="text-[11px] font-bold text-slate-500">
                    الفصل {m.semester === 1 ? 'الأول' : m.semester === 2 ? 'الثاني' : m.semester}
                    {m.initiatedBy === 'ADMIN' ? ' · بدأته الإدارة' : ' · طلبه الطالب'}
                    {m.studentEmail ? ` · ${m.studentEmail}` : ''}
                  </p>
                </div>
                <Badge className={meta.cls}>{meta.label}</Badge>
              </div>

              {m.status === 'REQUESTED' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input placeholder="عنوان النشاط العلاجي (مثال: بحث تطبيقي في…)" value={f.title}
                    onChange={(e) => setAssign((p) => ({ ...p, [m.id]: { ...f, title: e.target.value } }))} />
                  <div className="flex gap-2">
                    <Input type="number" min={1} max={50} placeholder="الوزن % (1–50)" value={f.weight}
                      onChange={(e) => setAssign((p) => ({ ...p, [m.id]: { ...f, weight: e.target.value } }))} />
                    <Input type="datetime-local" value={f.dueAt}
                      onChange={(e) => setAssign((p) => ({ ...p, [m.id]: { ...f, dueAt: e.target.value } }))} />
                  </div>
                  <Textarea placeholder="تعليمات النشاط للطالب (اختياري)" value={f.instructions}
                    onChange={(e) => setAssign((p) => ({ ...p, [m.id]: { ...f, instructions: e.target.value } }))} className="sm:col-span-2" />
                  <Button size="sm" disabled={busy === `assign:${m.id}`} onClick={() => void doAssign(m)}
                    className="bg-rose-600 font-black text-white hover:bg-rose-700 sm:col-span-2">
                    {busy === `assign:${m.id}` ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                    إسناد النشاط
                  </Button>
                </div>
              )}

              {m.status === 'ACTIVITY_ASSIGNED' && (
                <p className={`text-[11px] font-bold ${overdue ? 'text-red-600' : 'text-slate-500'}`}>
                  النشاط: {m.activityTitle || '—'} · الوزن {m.weightPercent ?? '—'}%
                  {m.dueAt ? ` · الموعد: ${new Date(m.dueAt).toLocaleString('ar-EG')}${overdue ? ' — تأخّر (سينقضي الطلب عند الفحص الدوري)' : ''}` : ''}
                </p>
              )}

              {m.status === 'SUBMITTED' && (
                <div className="space-y-2">
                  <p className="text-[11px] font-bold text-slate-500">تسليم الطالب{m.submittedAt ? ` (${new Date(m.submittedAt).toLocaleString('ar-EG')})` : ''}:</p>
                  <p className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-2 text-xs font-bold leading-6 text-slate-600">{m.submissionText || '—'}</p>
                  <div className="flex gap-2">
                    <Input type="number" min={0} max={100} placeholder="درجة النشاط (0–100)" value={scores[m.id] || ''}
                      onChange={(e) => setScores((p) => ({ ...p, [m.id]: e.target.value }))} className="max-w-44" />
                    <Button size="sm" disabled={busy === `grade:${m.id}`} onClick={() => void doGrade(m)}
                      className="bg-[#0f2b46] font-black text-white hover:bg-[#12365c]">
                      {busy === `grade:${m.id}` ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
                      تصحيح النشاط
                    </Button>
                  </div>
                </div>
              )}

              {m.status === 'GRADED' && (
                <p className="text-[11px] font-bold text-violet-600">
                  درجة النشاط: {m.score ?? '—'}% · الخطوة الأخيرة عندك: أعد اعتماد نتيجة الفصل {m.semester} من بطاقة الطالب بتبويب الشهادات (شروط الفصل) ليُختم الاسترحام مكتملًا.
                </p>
              )}

              {m.status === 'COMPLETED' && (
                <p className="text-[11px] font-bold text-emerald-600">
                  اكتمل: المعدل {m.previousAverage ?? '—'}% ← {m.newAverage ?? '—'}% بعد النشاط (درجته {m.score ?? '—'}% بوزن {m.weightPercent ?? '—'}%).
                </p>
              )}
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
