'use client'

import { useEffect, useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { DoorOpen, Loader2 } from 'lucide-react'

// ===== التماس إعادة فتح التسليم (واجهة الطالب) =====
// يظهر على بطاقة الواجب المنتهي موعده وغير المسلَّم: الطالب يقدّم
// الالتماس من هنا (المسار الخادمي كان موجودًا بلا أي شاشة)، ويرى
// حالته: قيد البتّ، أو منحة معتمدة ترفع عنه جدار الموعد وحده.

type MyAppeal = {
  programId: string
  semester: number
  unitId: string | null
  status: string
}

const pendingReads = new Map<string, Promise<MyAppeal[]>>()
function loadMyAppeals(userId: string): Promise<MyAppeal[]> {
  const existing = pendingReads.get(userId)
  if (existing) return existing
  const pending = api<{ appeals: MyAppeal[] }>('/api/reopen-appeals?view=status')
    .then((r) => r.appeals)
    .finally(() => { if (pendingReads.get(userId) === pending) pendingReads.delete(userId) })
  pendingReads.set(userId, pending)
  return pending
}

// سياق العرض: 'assignment' = زر بطاقة الواجب (الافتراضي — نصه بلا أي
// تغيير)، 'exam' = زر شاشة امتحان الوحدة المغلق. الالتماس نفسه في
// الحالتين: على مستوى الوحدة، عبر المسار الخادمي نفسه، وبنفس المنحة.
export function ReopenAppeal({
  programId,
  semester,
  unitId,
  context = 'assignment',
}: {
  programId: string
  semester: number
  unitId?: string | null
  context?: 'assignment' | 'exam'
}) {
  const isExam = context === 'exam'
  const intro = isExam
    ? 'انتهت نافذة هذا الامتحان. إذا كان عندك سبب وجيه، قدّم التماس إعادة فتح — الإدارة تبتّ فيه خلال 7 أيام، والقبول يفتح لك الامتحان من جديد ضمن فترة الفصل.'
    : unitId != null
      ? 'انتهى موعد هذا الواجب المرتبط بوحدة. يلزم التماس إعادة فتح هذه الوحدة تحديدًا؛ الموافقة الفصلية وحدها لا تفتح الوحدات المنتهية. الإدارة تبتّ خلال 7 أيام.'
      : 'انتهى موعد هذا الواجب. إذا كان عندك سبب وجيه للتأخر، قدّم التماس إعادة فتح الفصل — الإدارة تبتّ فيه خلال 7 أيام، والقبول يفتح لك التسليم من جديد ضمن فترة الفصل.'
  const approvedText = isExam
    ? 'لديك منحة إعادة فتح معتمدة من الإدارة — يمكنك تقديم هذا الامتحان الآن رغم انتهاء نافذته، ما دامت فترة الفصل قائمة.'
    : unitId != null
      ? 'لديك منحة معتمدة لإعادة فتح هذه الوحدة — يمكنك تسليم هذا الواجب الآن رغم انتهاء موعده، ما دامت فترة الفصل قائمة.'
      : 'لديك منحة إعادة فتح الفصل معتمدة من الإدارة — يمكنك تسليم هذا الواجب الآن رغم انتهاء موعده، ما دامت فترة الفصل قائمة. تنبيه: الوحدات التي انتهت مدتها ما زالت مغلقة، ويلزم تقديم التماس مستقل لكل وحدة لإعادة فتح واجباتها وامتحانها.'
  const rejectedText = isExam
    ? 'رُفض التماس سابق لهذا الامتحان — يمكنك التقديم مجددًا إذا كان عندك سبب جديد.'
    : 'رُفض التماس سابق لهذا الواجب — يمكنك التقديم مجددًا إذا كان عندك سبب جديد.'
  const buttonText = isExam ? 'التماس إعادة فتح الامتحان' : unitId != null ? 'التماس إعادة فتح الوحدة' : 'التماس إعادة فتح التسليم'
  const { toast } = useToast()
  const userId = useAppStore((state) => state.user?.id)
  const [snapshot, setSnapshot] = useState<{ userId: string; appeals: MyAppeal[] } | null>(null)
  const appeals = snapshot?.userId === userId ? snapshot?.appeals : null
  const [formOpen, setFormOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!userId) return
    let live = true
    let version = 0
    const refresh = () => {
      const request = ++version
      loadMyAppeals(userId).then((list) => {
        if (live && request === version) setSnapshot({ userId, appeals: list })
      }).catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    window.addEventListener('aact-reopen-appeals-updated', refresh)
    return () => {
      live = false
      window.removeEventListener('focus', refresh)
      window.removeEventListener('aact-reopen-appeals-updated', refresh)
    }
  }, [userId])

  if (!userId || !appeals) return null

  const matches = (a: MyAppeal) =>
    a.programId === programId && a.semester === semester &&
    (unitId != null ? a.unitId === unitId : a.unitId == null)
  const relevant = appeals.filter(matches)
  const approved = relevant.find((a) => a.status === 'APPROVED')
  const pending = relevant.find((a) => a.status === 'PENDING')
  const wasRejected = !approved && !pending && relevant.some((a) => a.status === 'REJECTED')

  if (approved) {
    return (
      <p className="mt-3 rounded-xl bg-emerald-50 p-3 text-[11px] font-bold leading-5 text-emerald-800">
        {approvedText}
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
      pendingReads.delete(userId!)
      window.dispatchEvent(new Event('aact-reopen-appeals-updated'))
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
        {intro}
      </p>
      {wasRejected && (
        <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">{rejectedText}</p>
      )}
      {!formOpen ? (
        <Button onClick={() => setFormOpen(true)} variant="outline" className="mt-2 border-amber-400 font-black text-amber-800 hover:bg-amber-100">
          <DoorOpen className="ml-1 h-4 w-4" /> {buttonText}
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

// الاسم القديم — بطاقة الواجب تستورده كما هو، بلا أي تغيير في نصها.
export const AssignmentReopenAppeal = ReopenAppeal
