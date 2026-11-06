'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useAppStore } from '@/lib/store'
import { clearPendingMeetingInvite, peekPendingMeetingInvite, setPendingMeetingInvite } from '@/lib/pending-meeting-invite'
import { AcademyLogo } from '@/components/aact/Shell'
import { Button } from '@/components/ui/button'
import {
  CalendarClock, CheckCircle2, Clock3, ExternalLink, KeyRound, Loader2, LogIn,
  MailCheck, ShieldAlert, Sparkles, User2, UserPlus, Users2, Video,
} from 'lucide-react'

const MeetingRoom = dynamic(
  () => import('@/components/aact/MeetingRoom').then((m) => m.MeetingRoom),
  { ssr: false },
)

// ===== صفحة دعوة اجتماع إداري =====
// وضعان: برمز الدعوة الخام (/meetings/<token>) أو بمعرّف دعوة
// مستلَمة من قائمة اجتماعات الحساب (/meetings/claimed/<inviteId>).
// الحالات تأتي من الخادم: NONE / تمهيد مع طلب دخول / قابل للاستلام /
// كامل. لا تُعرض أي تفاصيل قبل تحقق الخادم من الدعوة والهوية.

type MeetingInfo = {
  title: string
  startsAt: string
  endsAt: string
  timezone: string
  description?: string | null
  agenda?: string | null
  provider?: string
  hostName?: string | null
  inviteeNames?: string[]
  aiAssistantEnabled?: boolean
}

type MeetingNote = { id: string; authorName: string; text: string; createdAt: string }

type InviteState = {
  ok?: boolean
  level: 'TEASER' | 'CLAIMABLE' | 'FULL' | 'NONE'
  loginRequired?: boolean
  myInvite?: { inviteeName: string }
  meeting?: MeetingInfo
  joinOpen: boolean
  joinOpensAt: string
  effectiveStatus: string
  attendance?: { status: string } | null
  notes?: MeetingNote[]
}

const PROVIDER_LABEL: Record<string, string> = {
  ZOOM: 'Zoom',
  MEET: 'Google Meet',
  TEAMS: 'Microsoft Teams',
  OTHER: 'رابط خارجي',
  PLATFORM: 'غرفة المنصة الداخلية',
}

function fmtDateTime(iso: string, tz: string) {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      timeZone: tz || undefined,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return new Date(iso).toLocaleString('ar-EG')
  }
}

function fmtTime(iso: string, tz: string) {
  try {
    return new Intl.DateTimeFormat('ar-EG', {
      timeZone: tz || undefined,
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return new Date(iso).toLocaleTimeString('ar-EG')
  }
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  const parts: string[] = []
  if (d > 0) parts.push(`${d} يوم`)
  if (h > 0) parts.push(`${h} ساعة`)
  if (m > 0) parts.push(`${m} دقيقة`)
  parts.push(`${s} ثانية`)
  return parts.join(' و')
}

export function MeetingInviteView({ token, inviteId }: { token?: string; inviteId?: string }) {
  const segment = token || inviteId || ''
  const basePath = token
    ? `/api/meetings/${encodeURIComponent(token)}`
    : `/api/meetings/claimed/${encodeURIComponent(inviteId || '')}`
  const storeUserName = useAppStore((s) => s.user?.name)

  const [data, setData] = useState<InviteState | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState<'claim' | 'join' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [revealedPasscode, setRevealedPasscode] = useState<string | null>(null)
  const [joinedExternal, setJoinedExternal] = useState(false)
  const [inRoom, setInRoom] = useState(false)
  const [zoomConfig, setZoomConfig] = useState<null | { signature: string; sdkKey: string; meetingNumber: string; userName: string; password: string }>(null)
  const [zoomError, setZoomError] = useState<string | null>(null)
  const [zoomExternalUrl, setZoomExternalUrl] = useState<string | null>(null)
  const [showZoomAudioHint, setShowZoomAudioHint] = useState(false)
  useEffect(() => {
    if (!zoomConfig) { setShowZoomAudioHint(false); return }
    setShowZoomAudioHint(true)
    const timeout = window.setTimeout(() => setShowZoomAudioHint(false), 12_000)
    return () => window.clearTimeout(timeout)
  }, [zoomConfig])
  const zoomRootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!zoomConfig || !zoomRootRef.current) return
    let cancelled = false
    const loadScript = (src: string) => new Promise<void>((resolve, reject) => {
      if (document.querySelector('script[data-zoom-src="' + src + '"]')) { resolve(); return }
      const script = document.createElement('script')
      script.src = src
      script.dataset.zoomSrc = src
      script.onload = () => resolve()
      script.onerror = () => { script.remove(); reject(new Error('تعذّر تحميل مكتبة Zoom')) }
      document.head.appendChild(script)
    })
    const start = async () => {
      try {
        const version = '6.2.0'
        for (const name of ['react', 'react-dom', 'redux', 'redux-thunk', 'react-redux', 'lodash']) {
          await loadScript('https://source.zoom.us/' + version + '/lib/vendor/' + name + '.min.js')
        }
        await loadScript('https://source.zoom.us/zoom-meeting-embedded-' + version + '.min.js')
        if (cancelled) return
        const sdk = (window as any).ZoomMtgEmbedded
        if (!sdk?.createClient) throw new Error('مكتبة Zoom غير متاحة')
        const client = sdk.createClient()
        await client.init({ zoomAppRoot: zoomRootRef.current, language: 'en-US', patchJsMedia: true, leaveOnPageUnload: true })
        if (cancelled) return
        await client.join(zoomConfig)
      } catch (error) {
        if (!cancelled) setZoomError(error instanceof Error ? error.message : 'تعذّر تشغيل Zoom داخل القاعة')
      }
    }
    void start()
    return () => { cancelled = true }
  }, [zoomConfig])

  const [nowMs, setNowMs] = useState(() => Date.now())
  const [noteText, setNoteText] = useState('')
  const [noteBusy, setNoteBusy] = useState(false)
  const [question, setQuestion] = useState('')
  const [askBusy, setAskBusy] = useState(false)
  const [assistantAnswer, setAssistantAnswer] = useState<string | null>(null)
  const [assistantGreeting, setAssistantGreeting] = useState<string | null>(null)
  const [assistantError, setAssistantError] = useState<string | null>(null)
  // إنشاء حساب زائر من صفحة الدعوة نفسها (للضيف بلا حساب)
  const [regName, setRegName] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regWebsite, setRegWebsite] = useState('')
  const [regBusy, setRegBusy] = useState(false)
  const [regError, setRegError] = useState<string | null>(null)
  const [regDone, setRegDone] = useState(false)
  const autoClaimTried = useRef(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(basePath, { cache: 'no-store' })
      const d = await res.json().catch(() => null)
      if (d && typeof d.level === 'string') {
        setData(d as InviteState)
        setFailed(false)
      } else {
        setData({ level: 'NONE', joinOpen: false, joinOpensAt: '', effectiveStatus: '' })
      }
    } catch {
      setFailed(true)
    }
  }, [basePath])

  useEffect(() => {
    load()
  }, [load])

  // عدّاد تنازلي حي + تحديث دوري للحالة حتى ينعكس فتح الدخول تلقائياً
  useEffect(() => {
    if (!data || data.level === 'NONE') return
    const tick = setInterval(() => setNowMs(Date.now()), 1000)
    const refresh = setInterval(load, 20_000)
    return () => {
      clearInterval(tick)
      clearInterval(refresh)
    }
  }, [data, load])

  const doNote = async () => {
    const text = noteText.trim()
    if (!text) return
    setNoteBusy(true)
    setActionError(null)
    try {
      const res = await fetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'note', text }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'تعذّر حفظ الملاحظة')
      setNoteText('')
      await load()
    } catch (e: any) {
      setActionError(e?.message || 'تعذّر حفظ الملاحظة')
    } finally {
      setNoteBusy(false)
    }
  }

  // إخراج صوتي اختياري على جهاز المشارك فقط؛ لا يُبث إلى بقية الحضور.
  const readAssistantAnswer = () => {
    if (!assistantAnswer || typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setAssistantError('القراءة الصوتية غير مدعومة في هذا المتصفح')
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(assistantAnswer.slice(0, 3000))
    utterance.lang = 'ar'
    utterance.rate = 0.95
    window.speechSynthesis.speak(utterance)
  }

  const doAsk = async () => {
    const q = question.trim()
    if (!q) return
    setAskBusy(true)
    setAssistantError(null)
    try {
      const res = await fetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'ask', question: q }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'المساعد غير متاح الآن')
      if (d?.greeting) setAssistantGreeting(d.greeting)
      setAssistantAnswer(d?.answer || '')
      setQuestion('')
    } catch (e: any) {
      setAssistantError(e?.message || 'المساعد غير متاح الآن')
    } finally {
      setAskBusy(false)
    }
  }

  const doClaim = async () => {
    setBusy('claim')
    setActionError(null)
    try {
      const res = await fetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'claim' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'تعذّر تأكيد الحضور')
      clearPendingMeetingInvite()
      await load()
    } catch (e: any) {
      setActionError(e?.message || 'تعذّر تأكيد الحضور')
    } finally {
      setBusy(null)
    }
  }

  // اسم المدعو من الخادم هو قيمة النموذج الافتراضية ما لم يكتب الضيف غيره
  const effectiveRegName = regName.trim() || data?.myInvite?.inviteeName || ''

  const doRegister = async () => {
    if (!effectiveRegName || !regEmail.trim() || regPassword.length < 6) {
      setRegError('الاسم والبريد الإلكتروني وكلمة مرور من 6 أحرف على الأقل — كلها مطلوبة.')
      return
    }
    setRegBusy(true)
    setRegError(null)
    try {
      const res = await fetch('/api/auth/register-visitor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-aact-register-form': 'web' },
        body: JSON.stringify({ name: effectiveRegName, email: regEmail.trim(), password: regPassword, website: regWebsite }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(d?.error || 'تعذّر إنشاء الحساب')
      // نتذكّر هذه الدعوة في هذا المتصفح: بعد تأكيد البريد وتسجيل
      // الدخول يعود الضيف إلى هنا ويُستلم تأكيده تلقائيًا.
      if (token) setPendingMeetingInvite(token)
      setRegDone(true)
    } catch (e: any) {
      setRegError(e?.message || 'تعذّر إنشاء الحساب')
    } finally {
      setRegBusy(false)
    }
  }

  const goLogin = () => {
    if (token) setPendingMeetingInvite(token)
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- انتقال مقصود لصفحة الدخول (جذر التطبيق)
    window.location.assign('/')
  }

  // عودة تلقائية بعد الدخول: من جاء عبر مؤشر الدعوة المعلّقة
  // (سجّل من هنا أو سجّل دخوله من أجله) يُستلم تأكيده دون نقرة.
  useEffect(() => {
    if (!token || !data || data.level !== 'CLAIMABLE' || autoClaimTried.current) return
    if (peekPendingMeetingInvite() !== token) return
    autoClaimTried.current = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- استلام تلقائي مقصود لمرة واحدة عند عودة الضيف مسجّل الدخول
    void doClaim()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, data?.level])

  const doJoinExternal = async () => {
    setBusy('join')
    setActionError(null)
    try {
      const res = await fetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d?.meetingUrl) throw new Error(d?.error || 'تعذّر فتح رابط الاجتماع')
      if (d.zoomSdk) {
        setZoomExternalUrl(d.meetingUrl)
        setZoomError(null)
        setZoomConfig(d.zoomSdk)
      } else {
        window.open(d.meetingUrl, '_blank', 'noopener')
        setJoinedExternal(true)
      }
      setRevealedPasscode(d.meetingPasscode || null)
      await load()
    } catch (e: any) {
      setActionError(e?.message || 'تعذّر فتح رابط الاجتماع')
    } finally {
      setBusy(null)
    }
  }

  const doJoinRoom = async () => {
    setBusy('join')
    setActionError(null)
    try {
      const res = await fetch(basePath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'join' }),
      })
      const d = await res.json().catch(() => ({}))
      if (!res.ok || !d?.room) throw new Error(d?.error || 'تعذّر دخول الغرفة')
      setInRoom(true)
    } catch (e: any) {
      setActionError(e?.message || 'تعذّر دخول الغرفة')
    } finally {
      setBusy(null)
    }
  }

  if (inRoom) {
    return (
      <div className="mx-auto min-h-screen max-w-5xl p-3 sm:p-5" dir="rtl">
        <div className="mb-3 flex items-center gap-2.5 px-1">
          <AcademyLogo className="h-9 w-9" />
          <div>
            <div className="text-sm font-black text-[#0f2b46]">{data?.meeting?.title || 'اجتماع إداري'}</div>
            <div className="text-[11px] font-semibold text-muted-foreground">أكاديمية AACT — قاعة الاجتماعات</div>
          </div>
        </div>
        <MeetingRoom
          token={segment}
          displayName={storeUserName || undefined}
          onLeave={() => {
            setInRoom(false)
            load()
          }}
        />
      </div>
    )
  }

  const meeting = data?.meeting
  const isPlatform = meeting?.provider === 'PLATFORM'
  const cancelled = data?.effectiveStatus === 'CANCELLED'
  const ended = data?.effectiveStatus === 'ENDED'
  const opensAtMs = data?.joinOpensAt ? new Date(data.joinOpensAt).getTime() : 0
  const joinOpenNow = !!data?.joinOpen || (opensAtMs > 0 && nowMs >= opensAtMs && !cancelled && !ended)

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0b1c30] p-4" dir="rtl">
      <div className="w-full max-w-lg rounded-3xl bg-white p-6 shadow-2xl">
        <div className="mb-5 flex flex-col items-center gap-2 text-center">
          <AcademyLogo className="h-14 w-14" />
          <h1 className="text-lg font-black text-[#0f2b46]">دعوة اجتماع إداري</h1>
          <p className="text-xs text-muted-foreground">أكاديمية AACT — قاعة الاجتماعات</p>
        </div>

        {!data && !failed ? (
          <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
            <Loader2 className="h-7 w-7 animate-spin text-[#c9a227]" />
            <span className="text-sm font-bold">جارٍ التحقق من الدعوة…</span>
          </div>
        ) : failed ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <ShieldAlert className="h-9 w-9 text-red-500" />
            <p className="text-sm font-bold leading-relaxed text-[#0f2b46]">
              حدث خطأ أثناء التحقق من الدعوة — أعد تحميل الصفحة أو تواصل مع إدارة الأكاديمية.
            </p>
          </div>
        ) : data?.level === 'NONE' || !meeting ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <ShieldAlert className="h-9 w-9 text-red-500" />
            <p className="text-sm font-bold leading-relaxed text-[#0f2b46]">رابط الدعوة غير صالح أو ملغى أو منتهٍ</p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              تأكد من نسخ الرابط كاملاً كما وصلك، أو تواصل مع إدارة الأكاديمية لتجديد الدعوة.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-2xl bg-[#f7f3e8] p-4 ring-1 ring-[#e7dcba]">
              <div className="mb-1.5 text-sm font-black text-[#0f2b46]">{meeting.title}</div>
              <div className="space-y-1.5 text-xs font-semibold text-slate-600">
                <div className="flex items-center gap-1.5">
                  <CalendarClock className="h-3.5 w-3.5 shrink-0" />
                  <span>{fmtDateTime(meeting.startsAt, meeting.timezone)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Clock3 className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    من {fmtTime(meeting.startsAt, meeting.timezone)} إلى {fmtTime(meeting.endsAt, meeting.timezone)}
                    {' '}({meeting.timezone})
                  </span>
                </div>
                {meeting.hostName && (
                  <div className="flex items-center gap-1.5">
                    <User2 className="h-3.5 w-3.5 shrink-0" />
                    <span>المنظّم: {meeting.hostName}</span>
                  </div>
                )}
                {meeting.provider && (
                  <div className="flex items-center gap-1.5">
                    <Video className="h-3.5 w-3.5 shrink-0" />
                    <span>وسيلة الاجتماع: {PROVIDER_LABEL[meeting.provider] || meeting.provider}</span>
                  </div>
                )}
              </div>
            </div>

            {data?.level === 'FULL' && (
              <>
                {meeting.description && (
                  <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{meeting.description}</p>
                )}
                {meeting.agenda && (
                  <div className="rounded-2xl border border-slate-200 p-4">
                    <div className="mb-1.5 text-xs font-black text-[#0f2b46]">جدول الأعمال</div>
                    <p className="whitespace-pre-wrap text-xs leading-relaxed text-slate-600">{meeting.agenda}</p>
                  </div>
                )}
                {meeting.inviteeNames && meeting.inviteeNames.length > 0 && (
                  <div className="flex items-start gap-1.5 text-xs font-semibold text-slate-600">
                    <Users2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>المدعوون: {meeting.inviteeNames.join('، ')}</span>
                  </div>
                )}
                {data.attendance?.status && (
                  <div className="flex items-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-700 ring-1 ring-emerald-200">
                    <CheckCircle2 className="h-4 w-4" />
                    {data.attendance.status === 'PRESENT'
                      ? 'حضورك مؤكد في هذا الاجتماع'
                      : data.attendance.status === 'ABSENT'
                        ? 'سجّلت الإدارة غيابك عن هذا الاجتماع'
                        : 'تم تسجيل انضمامك إلى هذا الاجتماع'}
                  </div>
                )}
                {meeting.aiAssistantEnabled && (
                  <div className="rounded-2xl bg-violet-50 p-4 ring-1 ring-violet-200">
                    <div className="mb-2 flex items-center gap-2 text-xs font-black text-violet-900">
                      <Sparkles className="h-4 w-4 text-violet-500" />
                      المشرف الذكي — عضو الاجتماع
                    </div>
                    <p className="mb-3 text-[11px] font-semibold leading-relaxed text-violet-700">
                      يشارك بملاحظات واقتراحات مهنية عند سؤاله، اعتمادًا على جدول الأعمال والملاحظات المكتوبة. الربط بالصوت المباشر والتدخل التلقائي لم يُفعّلا بعد، ولا يتخذ قرارات نيابة عن المجتمعين.
                    </p>
                    {assistantGreeting && (
                      <p className="mb-2 rounded-xl bg-white/70 px-3 py-2 text-xs font-bold leading-relaxed text-violet-900">{assistantGreeting}</p>
                    )}
                    {assistantAnswer && (
                      <div className="mb-2 rounded-xl bg-white px-3 py-2">
                        <p className="whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-700">{assistantAnswer}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button type="button" variant="outline" onClick={readAssistantAnswer} className="text-xs">استمع للرد على جهازي</Button>
                          <Button type="button" variant="ghost" onClick={() => { if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel() }} className="text-xs">إيقاف الصوت</Button>
                        </div>
                      </div>
                    )}
                    {assistantError && (
                      <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-bold text-red-600 ring-1 ring-red-200">{assistantError}</p>
                    )}
                    <div className="flex gap-2">
                      <input
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') doAsk() }}
                        placeholder="اسأل المساعد عن جدول الأعمال…"
                        className="min-w-0 flex-1 rounded-xl border border-violet-200 bg-white px-3 py-2 text-xs font-semibold outline-none focus:border-violet-400"
                      />
                      <Button onClick={doAsk} disabled={askBusy || !question.trim()} className="shrink-0 bg-violet-600 px-4 text-xs font-black text-white hover:bg-violet-700">
                        {askBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'اسأل المساعد'}
                      </Button>
                    </div>
                  </div>
                )}
                <div className="rounded-2xl border border-slate-200 p-4">
                  <div className="mb-2 text-xs font-black text-[#0f2b46]">ملاحظات المشاركين</div>
                  <p className="mb-3 text-[11px] font-semibold leading-relaxed text-slate-500">
                    ما يُكتب هنا يُحفظ باسم كاتبه ويُستخدم — مع جدول الأعمال — مصدرًا لمحضر الاجتماع الذي تراجعه الإدارة وتُعتمده.
                  </p>
                  {data.notes && data.notes.length > 0 ? (
                    <div className="mb-3 space-y-2">
                      {data.notes.map((n) => (
                        <div key={n.id} className="rounded-xl bg-slate-50 px-3 py-2">
                          <span className="text-[11px] font-black text-[#0f2b46]">{n.authorName}: </span>
                          <span className="whitespace-pre-wrap text-xs font-semibold leading-relaxed text-slate-600">{n.text}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="mb-3 text-xs font-semibold text-slate-400">لا ملاحظات مكتوبة بعد.</p>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') doNote() }}
                      placeholder="اكتب ملاحظة أو قرارًا اتُّفق عليه…"
                      className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-xs font-semibold outline-none focus:border-[#c9a227]"
                    />
                    <Button onClick={doNote} disabled={noteBusy || !noteText.trim()} className="shrink-0 bg-[#0f2b46] px-4 text-xs font-black text-[#f5f0e1] hover:bg-[#12365c]">
                      {noteBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'إضافة'}
                    </Button>
                  </div>
                </div>
              </>
            )}

            {actionError && (
              <p className="rounded-xl bg-red-50 px-3 py-2 text-center text-xs font-bold text-red-600 ring-1 ring-red-200">
                {actionError}
              </p>
            )}

            {cancelled ? (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <ShieldAlert className="h-8 w-8 text-red-500" />
                <p className="text-sm font-bold text-[#0f2b46]">أُلغي هذا الاجتماع من الإدارة — الدخول مغلق.</p>
              </div>
            ) : ended ? (
              <div className="flex flex-col items-center gap-2 py-2 text-center">
                <Clock3 className="h-8 w-8 text-slate-400" />
                <p className="text-sm font-bold text-[#0f2b46]">انتهى هذا الاجتماع وأُغلق الدخول إليه.</p>
              </div>
            ) : data?.loginRequired ? (
              regDone ? (
                <div className="space-y-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-center">
                  <MailCheck className="mx-auto h-8 w-8 text-emerald-600" />
                  <p className="text-sm font-black text-emerald-900">تم إنشاء حسابك — بقيت خطوة واحدة</p>
                  <p className="text-xs font-semibold leading-relaxed text-emerald-800">
                    أرسلنا رابط تأكيد إلى بريدك الإلكتروني. افتح بريدك واضغط رابط التأكيد، ثم سجّل الدخول
                    بكلمة المرور التي اخترتها — وستعود إلى هذا الاجتماع مباشرة ويُؤكَّد حضورك تلقائيًا.
                  </p>
                  <Button onClick={goLogin} className="w-full bg-[#0f2b46] py-5 text-sm font-black text-[#f5f0e1] hover:bg-[#12365c]">
                    <LogIn className="ml-2 h-5 w-5" /> الذهاب لتسجيل الدخول
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <p className="text-center text-xs leading-relaxed text-muted-foreground">
                    هذه الدعوة شخصية لك. أنشئ حساب زائر سريعًا هنا — حساب ضيف للاجتماعات فقط، بلا أي حقوق أكاديمية —
                    ثم أكّد بريدك وسجّل الدخول، وستصل إلى الاجتماع مباشرة.
                  </p>
                  <input
                    value={regName || data?.myInvite?.inviteeName || ''}
                    onChange={(e) => setRegName(e.target.value)}
                    placeholder="الاسم الكامل"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-semibold outline-none focus:border-[#c9a227]"
                  />
                  <input
                    type="email"
                    dir="ltr"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-left text-sm font-semibold outline-none focus:border-[#c9a227]"
                  />
                  <input
                    type="password"
                    dir="ltr"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') doRegister() }}
                    placeholder="كلمة المرور (6 أحرف على الأقل)"
                    className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-left text-sm font-semibold outline-none focus:border-[#c9a227]"
                  />
                  <input
                    tabIndex={-1}
                    autoComplete="off"
                    value={regWebsite}
                    onChange={(e) => setRegWebsite(e.target.value)}
                    className="hidden"
                    aria-hidden="true"
                  />
                  {regError && (
                    <p className="rounded-xl bg-red-50 px-3 py-2 text-center text-xs font-bold text-red-600 ring-1 ring-red-200">{regError}</p>
                  )}
                  <Button
                    onClick={doRegister}
                    disabled={regBusy}
                    className="w-full bg-[#0f2b46] py-6 text-base font-black text-[#f5f0e1] hover:bg-[#12365c]"
                  >
                    {regBusy ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : <UserPlus className="ml-2 h-5 w-5" />}
                    إنشاء حسابي والمتابعة للاجتماع
                  </Button>
                  <p className="text-center text-xs leading-relaxed text-muted-foreground">
                    لديك حساب أصلًا؟{' '}
                    <button type="button" onClick={goLogin} className="font-black text-[#0f2b46] underline underline-offset-2">
                      سجّل الدخول
                    </button>{' '}
                    وستعود إلى هذا الاجتماع مباشرة.
                  </p>
                </div>
              )
            ) : data?.level === 'CLAIMABLE' ? (
              <div className="space-y-3">
                <p className="text-center text-xs leading-relaxed text-muted-foreground">
                  هذه الدعوة لم تُربط بحسابك بعد. أكّد حضورك لربطها بهذا الحساب وعرض تفاصيل الاجتماع كاملة.
                </p>
                <Button
                  onClick={doClaim}
                  disabled={busy === 'claim'}
                  className="w-full bg-[#0f2b46] py-6 text-base font-black text-[#f5f0e1] hover:bg-[#12365c]"
                >
                  {busy === 'claim' ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : <CheckCircle2 className="ml-2 h-5 w-5" />}
                  تأكيد حضوري بهذا الحساب
                </Button>
              </div>
            ) : data?.level === 'FULL' ? (
              joinOpenNow ? (
                <div className="space-y-3">
                  {isPlatform ? (
                    <Button
                      onClick={doJoinRoom}
                      disabled={busy === 'join'}
                      className="w-full bg-[#0f2b46] py-6 text-base font-black text-[#f5f0e1] hover:bg-[#12365c]"
                    >
                      {busy === 'join' ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : <Video className="ml-2 h-5 w-5" />}
                      دخول غرفة الاجتماع الآن
                    </Button>
                  ) : (
                    <Button
                      onClick={doJoinExternal}
                      disabled={busy === 'join'}
                      className="w-full bg-[#0f2b46] py-6 text-base font-black text-[#f5f0e1] hover:bg-[#12365c]"
                    >
                      {busy === 'join' ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : <ExternalLink className="ml-2 h-5 w-5" />}
                      فتح رابط الاجتماع
                    </Button>
                  )}
                  {zoomConfig && (
                    <div className="space-y-2">
                      {showZoomAudioHint && (
                        <div role="status" className="flex items-start justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-bold text-amber-950">
                          <span>لتسمع وتتحدث داخل اجتماع Zoom، اضغط على زر «Join Audio» أو «الانضمام للصوت» داخل القاعة واسمح للمتصفح باستخدام الميكروفون عند الحاجة.</span>
                          <button type="button" onClick={() => setShowZoomAudioHint(false)} aria-label="إغلاق تنبيه الصوت" className="shrink-0 rounded px-2 py-1 hover:bg-amber-100">إغلاق</button>
                        </div>
                      )}
                      <div ref={zoomRootRef} className="min-h-[480px] w-full overflow-hidden rounded-xl bg-slate-950" dir="ltr" />
                      {zoomError && (
                        <p role="alert" className="text-center text-sm font-bold text-red-600">{zoomError}</p>
                      )}
                      {zoomExternalUrl && (
                        <a href={zoomExternalUrl} target="_blank" rel="noopener noreferrer" className="block text-center text-sm font-bold underline">
                          {zoomError ? 'فتح الاجتماع في Zoom بدلًا من ذلك' : 'فتح Zoom في نافذة مستقلة'}
                        </a>
                      )}
                    </div>
                  )}
                  {joinedExternal && (
                    <p className="text-center text-xs font-bold text-emerald-600">
                      فُتح رابط الاجتماع في نافذة جديدة وسُجّل انضمامك.
                    </p>
                  )}
                  {revealedPasscode && (
                    <div className="flex items-center justify-center gap-1.5 rounded-xl bg-[#f7f3e8] px-3 py-2 text-xs font-bold text-[#0f2b46] ring-1 ring-[#e7dcba]">
                      <KeyRound className="h-4 w-4" /> رمز دخول الاجتماع: {revealedPasscode}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2 rounded-2xl border border-slate-200 p-4 text-center">
                  <p className="text-xs font-bold text-slate-600">يفتح الدخول قبل الموعد بـ15 دقيقة</p>
                  <p className="text-base font-black text-[#0f2b46]">{formatCountdown(opensAtMs - nowMs)}</p>
                  <p className="text-[11px] font-semibold text-muted-foreground">
                    يفتح الدخول عند {fmtTime(data.joinOpensAt, meeting.timezone)} — تبقى في هذه الصفحة وسيظهر زر الدخول تلقائياً.
                  </p>
                </div>
              )
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
