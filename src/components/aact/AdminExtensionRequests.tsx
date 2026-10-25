'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { toast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Clock } from 'lucide-react'

// طلبات تمديد البرامج (الأدمن): اعتماد بأيام يختارها الأدمن كل مرة بلا سقف
// ثابت، أو رفض مع ملاحظة. الاعتماد يعيد فتح البرنامج المغلق تلقائيًا.
interface ExtensionRequestRow {
  id: string
  requestedDays: number
  reason: string
  status: string
  createdAt: string
  user: { name: string; email: string }
  program: { titleAr: string }
  enrollment: { status: string; extensionDays: number }
}

export default function AdminExtensionRequests() {
  const [requests, setRequests] = useState<ExtensionRequestRow[]>([])
  const [loading, setLoading] = useState(true)
  const [granted, setGranted] = useState<Record<string, string>>({})
  const [note, setNote] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const data = await api<{ requests: ExtensionRequestRow[] }>('/api/admin/extension-requests?status=PENDING')
      setRequests(data.requests || [])
    } catch {
      setRequests([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api<{ requests: ExtensionRequestRow[] }>('/api/admin/extension-requests?status=PENDING')
      .then((data) => { if (!cancelled) setRequests(data.requests || []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  const decide = async (requestId: string, action: 'APPROVE' | 'REJECT') => {
    const days = Number(granted[requestId] || '')
    if (action === 'APPROVE' && (!Number.isFinite(days) || days < 1 || days > 365)) {
      toast({ title: 'اكتب عدد الأيام الممنوحة (1–365) قبل الاعتماد', variant: 'destructive' })
      return
    }
    setBusy(requestId)
    try {
      await api('/api/admin/extension-requests', {
        method: 'POST',
        body: JSON.stringify({ requestId, action, grantedDays: days, adminNote: note[requestId] || '' }),
      })
      toast({ title: action === 'APPROVE' ? `تم اعتماد التمديد (${Math.floor(days)} يومًا)` : 'تم رفض طلب التمديد' })
      load()
    } catch (e: any) {
      toast({ title: e?.message || 'تعذر تنفيذ القرار', variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  if (loading) return null
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
      <p className="flex items-center gap-1.5 text-xs font-black text-[#0f2b46]">
        <Clock className="h-4 w-4" /> طلبات تمديد البرامج {requests.length ? `(${requests.length} معلق)` : '— لا طلبات معلقة'}
      </p>
      {requests.length > 0 && (
        <div className="mt-3 space-y-3">
          {requests.map((r) => (
            <div key={r.id} className="rounded-xl border bg-white p-3">
              <p className="text-xs font-black text-[#0f2b46]">{r.user.name} — {r.program.titleAr}</p>
              <p className="mt-1 text-xs font-bold leading-6 text-slate-600">
                يطلب {r.requestedDays} يومًا — السبب: {r.reason}
                {r.enrollment.status === 'EXPIRED' ? ' (البرنامج مغلق حاليًا — الاعتماد يعيد فتحه)' : ''}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Input
                  type="number"
                  min={1}
                  max={365}
                  className="h-9 w-28 text-xs"
                  placeholder="أيام ممنوحة"
                  value={granted[r.id] || String(r.requestedDays)}
                  onChange={(e) => setGranted((prev) => ({ ...prev, [r.id]: e.target.value }))}
                />
                <Input
                  className="h-9 min-w-[180px] flex-1 text-xs"
                  placeholder="ملاحظة للأدمن (اختياري)"
                  value={note[r.id] || ''}
                  onChange={(e) => setNote((prev) => ({ ...prev, [r.id]: e.target.value }))}
                />
                <Button type="button" size="sm" disabled={busy === r.id} onClick={() => decide(r.id, 'APPROVE')} className="h-9 bg-emerald-600 text-xs font-black hover:bg-emerald-700">
                  {busy === r.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'اعتماد'}
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={busy === r.id} onClick={() => decide(r.id, 'REJECT')} className="h-9 text-xs font-black text-red-700">
                  رفض
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
