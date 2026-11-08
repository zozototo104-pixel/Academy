'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/hooks/use-toast'
import { HeartHandshake, Loader2 } from 'lucide-react'

// ===== الاسترحام (واجهة الطالب) =====
// لمّا يُغلق فصل بنتيجة راسب معتمدة، يحق للطالب طلب استرحام واحد
// لهذا الفصل: الإدارة تُسند نشاطًا علاجيًا مصحَّحًا بوزن من معدل
// الفصل، وإذا رفعه فوق خط النجاح تُعاد مصادقة النتيجة بالمعدل
// الجديد. النظام الخادمي كان موجودًا بلا أي شاشة — هذه اللوحة هي
// الباب: طلب، ومتابعة للحالة، وتسليم للنشاط عند إسناده.

type MercyRow = {
  id: string
  enrollmentId: string
  programId: string
  semester: number
  status: string
  initiatedBy: string
  activityTitle: string | null
  activityInstructions: string | null
  weightPercent: number | null
  dueAt: string | null
  score: number | null
  previousAverage: number | null
  newAverage: number | null
  createdAt: string
}

type Eligible = { enrollmentId: string; programId: string; semester: number }

let mercyCache: Promise<{ requests: MercyRow[]; eligible: Eligible[] }> | null = null
function loadMercy(): Promise<{ requests: MercyRow[]; eligible: Eligible[] }> {
  if (!mercyCache) {
    mercyCache = api<{ requests: MercyRow[]; eligible: Eligible[] }>('/api/mercy')
      .then((r) => ({ requests: r.requests || [], eligible: r.eligible || [] }))
      .catch(() => ({ requests: [], eligible: [] }))
  }
  return mercyCache
}
function invalidateMercyCache() { mercyCache = null }

const STATUS_TEXT: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'طلبك عند الإدارة — بانتظار إسناد النشاط العلاجي', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  ACTIVITY_ASSIGNED: { label: 'أُسند إليك نشاط علاجي — سلّمه قبل موعده', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  SUBMITTED: { label: 'سلّمت النشاط — بانتظار التصحيح', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  GRADED: { label: 'صُحّح النشاط — بانتظار إعادة اعتماد نتيجة الفصل بالمعدل الجديد', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  COMPLETED: { label: 'اكتمل الاسترحام — أُعيد اعتماد نتيجة الفصل بمعدلك الجديد', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  LAPSED: { label: 'انقضت مهلة التسليم دون تسليم — بقيت نتيجة الفصل كما اعتُمدت', cls: 'bg-slate-50 text-slate-500 border-slate-200' },
  REJECTED: { label: 'رُفض طلب الاسترحام', cls: 'bg-red-50 text-red-600 border-red-200' },
}

export function StudentMercyPanel() {
  const { toast } = useToast()
  const [data, setData] = useState<{ requests: MercyRow[]; eligible: Eligible[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [texts, setTexts] = useState<Record<string, string>>({})

  useEffect(() => {
    let alive = true
    loadMercy().then((d) => { if (alive) setData(d) })
    return () => { alive = false }
  }, [])

  if (!data) return null
  if (data.requests.length === 0 && data.eligible.length === 0) return null

  const requestMercy = async (e: Eligible) => {
    setBusy(`req:${e.enrollmentId}:${e.semester}`)
    try {
      const r = await api<{ mercy: MercyRow }>('/api/mercy', {
        method: 'POST',
        body: JSON.stringify({ programId: e.programId, semester: e.semester }),
      })
      invalidateMercyCache()
      setData((prev) => prev ? {
        requests: [r.mercy, ...prev.requests],
        eligible: prev.eligible.filter((x) => !(x.enrollmentId === e.enrollmentId && x.semester === e.semester)),
      } : prev)
      toast({ title: 'قُدّم طلب الاسترحام', description: 'ستُسند إليك الإدارة نشاطًا علاجيًا — تابع حالته هنا.' })
    } catch (err: any) {
      toast({ title: 'تعذّر تقديم الطلب', description: err?.message || 'حاول مجددًا', variant: 'destructive' })
    } finally { setBusy(null) }
  }

  const submitActivity = async (m: MercyRow) => {
    const text = (texts[m.id] || '').trim()
    if (!text) {
      toast({ title: 'اكتب تسليمك أولًا', variant: 'destructive' })
      return
    }
    setBusy(`sub:${m.id}`)
    try {
      const r = await api<{ mercy: MercyRow }>('/api/mercy/submit', {
        method: 'POST',
        body: JSON.stringify({ mercyId: m.id, text }),
      })
      invalidateMercyCache()
      setData((prev) => prev ? { ...prev, requests: prev.requests.map((x) => (x.id === m.id ? r.mercy : x)) } : prev)
      toast({ title: 'سُلّم النشاط', description: 'سيصلك إشعار عند تصحيحه وإعادة اعتماد نتيجتك.' })
    } catch (err: any) {
      toast({ title: 'تعذّر التسليم', description: err?.message || 'حاول مجددًا', variant: 'destructive' })
    } finally { setBusy(null) }
  }

  return (
    <div className="mt-3 space-y-3 rounded-xl border border-rose-200 bg-rose-50/60 p-3.5">
      <p className="flex items-center gap-2 text-sm font-black text-[#0f2b46]">
        <HeartHandshake className="h-5 w-5 text-rose-500" />
        الاسترحام — فرصة أخيرة لرفع معدل فصل راسب
      </p>
      <p className="text-[11px] font-bold leading-5 text-slate-500">
        إذا أُغلق أحد فصولك بنتيجة راسب معتمدة، يمكنك طلب استرحام واحد لهذا الفصل: تُسند إليك الإدارة نشاطًا علاجيًا
        يُصحَّح ويدخل معدلك بوزنه، فإذا رفعك فوق خط النجاح أُعيد اعتماد نتيجتك بالمعدل الجديد.
      </p>

      {data.eligible.map((e) => (
        <div key={`${e.enrollmentId}:${e.semester}`} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-3">
          <p className="text-xs font-black text-slate-700">الفصل {e.semester === 1 ? 'الأول' : e.semester === 2 ? 'الثاني' : e.semester} — أُغلق بنتيجة راسب، ولم يُطلب له استرحام بعد</p>
          <Button
            type="button" size="sm"
            disabled={busy === `req:${e.enrollmentId}:${e.semester}`}
            onClick={() => void requestMercy(e)}
            className="bg-rose-600 text-xs font-black text-white hover:bg-rose-700"
          >
            {busy === `req:${e.enrollmentId}:${e.semester}` ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
            طلب استرحام
          </Button>
        </div>
      ))}

      {data.requests.map((m) => {
        const st = STATUS_TEXT[m.status] || { label: m.status, cls: 'bg-slate-50 text-slate-500 border-slate-200' }
        return (
          <div key={m.id} className="space-y-2 rounded-xl bg-white p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-black text-slate-700">استرحام الفصل {m.semester === 1 ? 'الأول' : m.semester === 2 ? 'الثاني' : m.semester}{m.initiatedBy === 'ADMIN' ? ' — بدأته الإدارة' : ''}</p>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-black ${st.cls}`}>{st.label}</span>
            </div>
            {m.status === 'ACTIVITY_ASSIGNED' && (
              <div className="space-y-2">
                <p className="text-xs font-bold text-slate-600">
                  النشاط: <span className="font-black text-[#0f2b46]">{m.activityTitle || 'نشاط علاجي'}</span>
                  {m.weightPercent != null ? ` · الوزن ${m.weightPercent}% من معدل الفصل` : ''}
                  {m.dueAt ? ` · آخر موعد للتسليم: ${new Date(m.dueAt).toLocaleString('ar-EG')}` : ''}
                </p>
                {m.activityInstructions && <p className="rounded-xl bg-slate-50 p-2 text-[11px] font-bold leading-5 text-slate-500">{m.activityInstructions}</p>}
                <Textarea
                  value={texts[m.id] || ''}
                  onChange={(ev) => setTexts((prev) => ({ ...prev, [m.id]: ev.target.value }))}
                  placeholder="اكتب تسليمك للنشاط هنا…"
                  className="min-h-24 text-sm"
                />
                <Button
                  type="button" size="sm"
                  disabled={busy === `sub:${m.id}`}
                  onClick={() => void submitActivity(m)}
                  className="bg-[#0f2b46] text-xs font-black text-white hover:bg-[#12365c]"
                >
                  {busy === `sub:${m.id}` ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : null}
                  تسليم النشاط
                </Button>
              </div>
            )}
            {m.status === 'GRADED' && m.score != null && (
              <p className="text-[11px] font-bold text-slate-500">درجة النشاط: {m.score}% — تُعاد مصادقة نتيجة الفصل رسميًا من الإدارة بالمعدل الجديد.</p>
            )}
            {m.status === 'COMPLETED' && (
              <p className="text-[11px] font-bold text-emerald-600">
                معدلك الجديد معتمد رسميًا{m.newAverage != null ? `: ${m.newAverage}%` : ''}{m.previousAverage != null ? ` (كان ${m.previousAverage}% قبل النشاط)` : ''}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
