'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { CalendarClock, ExternalLink, Loader2, Video } from 'lucide-react'

// صفحة الزائر/المدعو: اجتماعاته المستلَمة فقط. لا بوابة طالب ولا أي
// سطح أكاديمي — الدخول لصفحة كل اجتماع بالحساب بعد الاستلام.
export function VisitorMeetings() {
  const [loading, setLoading] = useState(true)
  const [meetings, setMeetings] = useState<any[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    ;(async () => {
      try {
        const res = await api('/api/my/meetings')
        setMeetings(res.meetings || [])
      } catch (e: any) {
        setError(e?.message || 'تعذر تحميل الاجتماعات')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const fmt = (iso: string, tz: string) =>
    new Intl.DateTimeFormat('ar', { dateStyle: 'full', timeStyle: 'short', timeZone: tz || 'UTC' }).format(new Date(iso))

  const statusLabel: Record<string, string> = {
    SCHEDULED: 'مجدول',
    LIVE: 'جارٍ الآن',
    ENDED: 'انتهى',
    CANCELLED: 'ملغى',
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-10" dir="rtl">
      <h1 className="flex items-center gap-2 text-2xl font-black text-[#0f2b46]">
        <Video className="h-6 w-6 text-[#c9a227]" />
        اجتماعاتي
      </h1>
      <p className="mt-2 text-sm font-bold leading-7 text-slate-600">
        هذه الاجتماعات التي استلمت دعواتها بهذا الحساب. يفتح الدخول قبل موعد كل اجتماع بـ15 دقيقة.
      </p>

      {loading ? (
        <div className="mt-10 flex items-center justify-center gap-2 text-slate-500">
          <Loader2 className="h-5 w-5 animate-spin" /> جارٍ التحميل…
        </div>
      ) : error ? (
        <div className="mt-8 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm font-bold text-red-700">{error}</div>
      ) : meetings.length === 0 ? (
        <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm font-bold leading-7 text-slate-600">
          لا توجد اجتماعات مرتبطة بحسابك بعد. عندما تصلك دعوة اجتماع، افتح رابطها وسجّل الدخول بهذا الحساب ثم اضغط «تأكيد الحضور» لتظهر هنا.
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {meetings.map((m) => (
            <div key={m.inviteId} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-base font-black text-[#0f2b46]">{m.meeting.title}</div>
                  <div className="mt-1 flex items-center gap-1 text-xs font-bold text-slate-500">
                    <CalendarClock className="h-3.5 w-3.5" />
                    {fmt(m.meeting.startsAt, m.meeting.timezone)}
                    {m.meeting.hostName ? ` — المنظّم: ${m.meeting.hostName}` : ''}
                  </div>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-black ${m.meeting.effectiveStatus === 'LIVE' ? 'bg-emerald-100 text-emerald-700' : m.meeting.effectiveStatus === 'CANCELLED' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'}`}>
                  {statusLabel[m.meeting.effectiveStatus] || m.meeting.effectiveStatus}
                </span>
              </div>
              <a
                href={`/meetings/claimed/${m.inviteId}`}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-[#0f2b46] px-4 py-2.5 text-sm font-black text-[#f5f0e1] shadow hover:bg-[#12365c]"
              >
                <ExternalLink className="h-4 w-4" />
                فتح صفحة الاجتماع
              </a>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
