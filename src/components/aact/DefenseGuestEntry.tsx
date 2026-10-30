'use client'

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { AcademyLogo } from '@/components/aact/Shell'
import { CalendarClock, ExternalLink, Gavel, Loader2, ShieldAlert, User2, Users2, Video } from 'lucide-react'

const DefenseRoom = dynamic(
  () => import('@/components/aact/DefenseRoom').then((mod) => mod.DefenseRoom),
  { ssr: false }
)

interface GuestInfo {
  status: string
  inviteeName?: string
  role?: string
  studentName?: string
  thesis?: {
    id: string
    title: string
    abstract: string
    defenseDate?: string | null
    committee?: string | null
    agentMember?: string | null
    defenseStatus?: string | null
    defenseMeetingUrl?: string | null
  }
}

function committeeNames(raw?: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((x) => String(x)).filter(Boolean)
  } catch {
    // ليست JSON — تُعامل كنص مفصول بفواصل في السطر التالي
  }
  return raw.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean)
}

// صفحة دخول المناقش الخارجي: يتحقق من رابط الدعوة ويعرض ملخص المناقشة ثم القاعة.
export function DefenseGuestEntry({ token }: { token: string }) {
  const [info, setInfo] = useState<GuestInfo | null>(null)
  const [failed, setFailed] = useState(false)
  const [entered, setEntered] = useState(false)

  useEffect(() => {
    fetch(`/api/defense/guest/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const d = await r.json().catch(() => ({ status: 'ERROR' }))
        setInfo(d)
      })
      .catch(() => setFailed(true))
  }, [token])

  if (entered && info?.thesis) {
    return (
      <div className="mx-auto min-h-screen max-w-5xl p-3 sm:p-5" dir="rtl">
        <DefenseRoom
          thesis={{
            id: info.thesis.id,
            title: info.thesis.title,
            abstract: info.thesis.abstract,
            defenseDate: info.thesis.defenseDate,
            committee: info.thesis.committee,
            agentMember: info.thesis.agentMember,
            defenseMeetingUrl: info.thesis.defenseMeetingUrl,
            defenseStatus: info.thesis.defenseStatus,
          }}
          mode="committee"
          guestInviteToken={token}
          onFinished={() => setEntered(false)}
        />
      </div>
    )
  }

  const problemText =
    failed || info?.status === 'ERROR'
      ? 'حدث خطأ أثناء التحقق من الدعوة — أعد تحميل الصفحة أو تواصل مع إدارة الأكاديمية.'
      : info?.status === 'NOT_FOUND'
        ? 'رابط الدعوة هذا غير صحيح. تأكد من نسخ الرابط كاملاً كما وصلك.'
        : info?.status === 'EXPIRED'
          ? 'انتهت صلاحية رابط الدعوة هذا. تواصل مع إدارة الأكاديمية لتجديد الدعوة.'
          : info?.status === 'REVOKED'
            ? 'أُلغيت هذه الدعوة من إدارة الأكاديمية. تواصل معهم إن كنت ترى أن هذا خطأ.'
            : null

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b1c30] p-4" dir="rtl">
      <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <AcademyLogo className="h-14 w-14" />
          <h1 className="text-lg font-black text-[#0f2b46]">دعوة لمناقشة بحث تخرج</h1>
          <p className="text-xs text-muted-foreground">أكاديمية AACT — قاعة المناقشة عبر الفيديو كونفرنس</p>
        </div>

        {!info && !failed ? (
          <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" />
            <span className="text-sm font-bold">جارٍ التحقق من الدعوة…</span>
          </div>
        ) : problemText ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <ShieldAlert className="h-9 w-9 text-red-500" />
            <p className="text-sm font-bold leading-relaxed text-[#0f2b46]">{problemText}</p>
          </div>
        ) : info?.thesis ? (
          <div className="space-y-4">
            <div className="rounded-2xl bg-[#f7f3e8] p-4 ring-1 ring-[#e7dcba]">
              <div className="mb-1 flex items-center gap-2 text-[#0f2b46]">
                <Gavel className="h-4 w-4 text-[#a8841a]" />
                <span className="text-sm font-black">{info.thesis.title}</span>
              </div>
              <div className="space-y-1.5 text-xs font-semibold text-slate-600">
                <div className="flex items-center gap-1.5">
                  <User2 className="h-3.5 w-3.5" /> الباحث: {info.studentName}
                </div>
                <div className="flex items-center gap-1.5">
                  <CalendarClock className="h-3.5 w-3.5" />
                  الموعد:{' '}
                  {info.thesis.defenseDate
                    ? new Date(info.thesis.defenseDate).toLocaleString('ar-EG', { dateStyle: 'full', timeStyle: 'short' })
                    : 'يُحدد قريباً'}
                </div>
                {committeeNames(info.thesis.committee).length > 0 && (
                  <div className="flex items-start gap-1.5">
                    <Users2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>اللجنة: {committeeNames(info.thesis.committee).join('، ')}</span>
                  </div>
                )}
              </div>
            </div>
            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              هذه الدعوة باسم <b className="text-[#0f2b46]">{info.inviteeName}</b> بصفة{' '}
              {info.role === 'AGENT' ? 'عضو الوكيل الدولي' : 'عضو لجنة المناقشة'}. بالدخول ستظهر للجميع بهذا الاسم،
              وستحتاج الكاميرا والمايك في متصفحك.
            </p>
            <Button onClick={() => setEntered(true)} className="w-full bg-[#0f2b46] py-6 text-base font-black text-[#f5f0e1] hover:bg-[#12365c]">
              <Video className="ml-2 h-5 w-5" /> دخول قاعة المناقشة
            </Button>
            {info.thesis.defenseMeetingUrl && (
              <a
                href={info.thesis.defenseMeetingUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-center gap-2 rounded-xl border border-[#c9a227] px-4 py-3 text-sm font-black text-[#a8841a] transition hover:bg-[#f7f3e8]">
                <ExternalLink className="h-4 w-4" /> أو الانضمام عبر الاجتماع الخارجي (Zoom)
              </a>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}
