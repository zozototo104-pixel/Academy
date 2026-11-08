'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { DoorOpen, Loader2 } from 'lucide-react'

// ===== التماس إعادة فتح التسليم (واجهة الطالب) =====
// يظهر على بطاقة الواجب المنتهي موعده وغير المسلَّم: الطالب يقدّم
// الالتماس من هنا (المسار الخادمي كان موجودًا بلا أي شاشة)، ويرى
// حالته: قيد البتّ، أو منحة معتمدة ترفع عنه جدار الموعد وحده.

type MyAppeal = {
  id: string
  programId: string
  semester: number
  unitId: string | null
  status: string
  createdAt: string
}

let appealsCache: Promise<MyAppeal[]> | null = null
function loadMyAppeals(): Promise<MyAppeal[]> {
  if (!appealsCache) {
    appealsCache = api<{ appeals: MyAppeal[] }>('/api/reopen-appeals')
      .then((r) => r.appeals || [])
      .catch(() => [])
  }
  return appealsCache
}

export function AssignmentReopenAppeal({
  programId,
  semester,
  unitId,
}: {
  programId: string
  semester: number
  unitId?: string | null
}) {
  const { toast } = useToast()
  const [appeals, setAppeals] = useState<MyAppeal[] | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    loadMyAppeals().then((list) => {
      if (live) setAppeals(list)
    })
    return () => {
      live = false
    }
  }, [])

  if (appeals === null) return null

  const matches = (a: MyAppeal) =>
    a.programId === programId &&
    ((unitId != null && a.unitId === unitId) || (a.unitId == null && a.semester === semester))
  const relevant = appeals.filter(matches)
  const approved = relevant.find((a) => a.status === 'APPROVED')
  const pending = relevant.find((a) => a.status === 'PENDING')
  const wasRejected = !approved && !pending && relevant.some((a) => a.status === 'REJECTED')

  if (approved) {
    return (
      <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-[11px] font-bold leading-5 text-emerald-800">
        لديك منحة إعادة فتح معتمدة من الإدارة — يمكنك تسليم هذا الواجب الآن رغم انتهاء موعده، ما دامت فترة الفصل قائمة.
      </p>
    )
  }
  if (pending) {
    return (
      <p className="mt-3 rounded-xl bg-amber-50 p-3 text-[11px] font-bold leading-5 text-amber-800">
        التماس إعادة فتحك قيد البتّ لدى الإدارة — مهلة القرار 7 أيام من تقديمه، والنتيجة ستظهر هنا.
      </p>
    )
  }

  const submit = async () => {
    if (!reason.trim()) {
      toast({ title: 'اكتب سبب الالتماس أولًا', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      await api('/api/reopen-appeals', {
        method: 'POST',
        body: JSON.stringify({
          ...(unitId ? { unitId } : { programId, semester }),
          reason: reason.trim(),
        }),
      })
      appealsCache = null
      const list = await loadMyAppeals()
      setAppeals(list)
      setFormOpen(false)
      setReason('')
      toast({ title: 'وصل التماسك إلى الإدارة', description: 'سيصلك القرار هنا وفي إشعاراتك.' })
    } catch (error: any) {
      toast({ title: 'تعذر تقديم الالتماس', description: String(error?.message || error), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-dashed border-amber-300 bg-amber-50/60 p-3" dir="rtl">
      <p className="text-[11px] font-bold leading-5 text-amber-800">
        انتهى موعد هذا الواجب. إذا كان عندك سبب وجيه للتأخر، قدّم التماس إعادة فتح — الإدارة تبتّ فيه خلال 7 أيام، والقبول يفتح لك التسليم من جديد ضمن فترة الفصل.
      </p>
      {wasRejected && (
        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">رُفض التماس سابق لهذا الواجب — يمكنك التقديم مجددًا إذا كان عندك سبب جديد.</p>
      )}
      {!formOpen ? (
        <Button onClick={() => setFormOpen(true)} variant="outline" className="mt-2 border-amber-400 font-black text-amber-800 hover:bg-amber-100">
          <DoorOpen className="ml-1 h-4 w-4" /> التماس إعادة فتح التسليم
        </Button>
      ) : (
        <div className="mt-2 space-y-2">
          <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="اكتب سبب التأخر باختصار ووضوح..." className="bg-white text-xs" />
          <div className="flex gap-2">
            <Button onClick={() => void submit()} disabled={busy} className="bg-amber-600 font-black text-white hover:bg-amber-700">
              {busy ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : null} تقديم الالتماس
            </Button>
            <Button onClick={() => setFormOpen(false)} variant="outline" disabled={busy}>
              إلغاء
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
