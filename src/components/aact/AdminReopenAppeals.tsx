'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { CheckCircle2, DoorOpen, Loader2, XCircle } from 'lucide-react'

// ===== قائمة بتّ التماسات إعادة الفتح (إدارة) =====
// الالتماسات كانت تصل الخادم بلا أي شاشة بتّ — هذه القائمة تعرض
// المعلّقة وتبتّ فيها: القبول منحة ترفع جدار الموعد/النافذة عن
// صاحبها وحده ضمن فترة الفصل، والرفض يُشعَر به الطالب.

type ReopenAppealRow = {
  id: string
  userId: string
  programId: string
  semester: number
  unitId: string | null
  reason: string
  status: string
  decisionDeadline: string
  createdAt: string
  studentName?: string | null
  studentEmail?: string | null
  programTitle?: string | null
  unitTitle?: string | null
}

export default function AdminReopenAppeals() {
  const { toast } = useToast()
  const [appeals, setAppeals] = useState<ReopenAppealRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notes, setNotes] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ appeals: ReopenAppealRow[] }>('/api/admin/reopen-appeals?status=PENDING')
      setAppeals(res.appeals || [])
    } catch {
      setAppeals([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let live = true
    api<{ appeals: ReopenAppealRow[] }>('/api/admin/reopen-appeals?status=PENDING')
      .then((res) => {
        if (live) setAppeals(res.appeals || [])
      })
      .catch(() => {
        if (live) setAppeals([])
      })
    return () => {
      live = false
    }
  }, [])

  const decide = async (appeal: ReopenAppealRow, approve: boolean) => {
    setBusyId(appeal.id)
    try {
      await api('/api/admin/reopen-appeals', {
        method: 'POST',
        body: JSON.stringify({ appealId: appeal.id, approve, note: notes[appeal.id]?.trim() || undefined }),
      })
      toast({
        title: approve ? 'قُبل الالتماس — فُتح التسليم للطالب' : 'رُفض الالتماس',
        description: approve ? 'يقدر الطالب يسلّم الآن رغم انتهاء الموعد، ضمن فترة الفصل.' : 'سيظهر الرفض للطالب مع إمكانية التقديم مجددًا بسبب جديد.',
      })
      await load()
    } catch (error: any) {
      toast({ title: 'تعذر البتّ في الالتماس', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  if (!loading && appeals.length === 0) return null

  return (
    <Card className="mt-4 border-amber-300" dir="rtl">
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-black text-[#0f2b46]">
            <DoorOpen className="h-4 w-4 text-amber-600" /> التماسات إعادة فتح التسليم
          </h3>
          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">{appeals.length} قيد البتّ</Badge>
        </div>
        {loading ? (
          <p className="text-sm text-slate-500">جاري التحميل...</p>
        ) : (
          <div className="space-y-2">
            {appeals.map((a) => {
              const overdue = new Date(a.decisionDeadline).getTime() < Date.now()
              return (
                <div key={a.id} className="rounded-xl border bg-white p-3 text-xs">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-black text-[#0f2b46]">{a.studentName || 'طالب'} <span className="font-bold text-slate-400">{a.studentEmail || ''}</span></p>
                      <p className="mt-0.5 font-bold text-slate-500">
                        {a.programTitle || 'برنامج'} · الفصل {a.semester}
                        {a.unitTitle ? ` · وحدة: ${a.unitTitle}` : ' · التماس فصلي'}
                      </p>
                    </div>
                    <Badge className={overdue ? 'bg-red-100 text-red-700 hover:bg-red-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-100'}>
                      {overdue ? 'تجاوز مهلة البتّ (7 أيام)' : `مهلة البتّ حتى ${new Date(a.decisionDeadline).toLocaleDateString('ar-EG')}`}
                    </Badge>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-2 font-bold leading-5 text-slate-600">سبب الطالب: {a.reason}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      value={notes[a.id] || ''}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [a.id]: e.target.value }))}
                      placeholder="ملاحظة القرار (اختيارية)"
                      className="h-8 max-w-56 text-[11px]"
                    />
                    <Button size="sm" disabled={busyId !== null} onClick={() => void decide(a, true)} className="bg-emerald-600 font-black text-white hover:bg-emerald-700">
                      {busyId === a.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="ml-1 h-3.5 w-3.5" />} قبول وفتح التسليم
                    </Button>
                    <Button size="sm" disabled={busyId !== null} onClick={() => void decide(a, false)} variant="outline" className="border-red-200 font-black text-red-600 hover:bg-red-50">
                      <XCircle className="ml-1 h-3.5 w-3.5" /> رفض
                    </Button>
                    <span className="text-[10px] font-bold text-slate-400">قُدّم {new Date(a.createdAt).toLocaleString('ar-EG')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
