'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useAppStore } from '@/lib/store'
import { GeminiLiveAgent } from '@/lib/voice/geminiLiveAgent'
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
  minutesEnabled?: boolean
}

type MeetingNote = { id: string; authorName: string; text: string; createdAt: string }

type InviteState = {
  ok?: boolean
  level: 'TEASER' | 'CLAIMABLE' | 'FULL' | 'NONE'
  loginRequired?: boolean
  canOperateAi?: boolean
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

// Dedicated bot station. The machine joins Zoom through the official desktop
// client or joins the PLATFORM room as a separate peer. This panel only routes
// meeting audio to/from Gemini Live; it is NOT a Zoom Meeting SDK bot.
function MeetingAiVoiceControl({ basePath, provider }: { basePath: string; provider: string }) {
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [voiceState, setVoiceState] = useState('IDLE')
  const [heard, setHeard] = useState('')
  const [spoken, setSpoken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const agentRef = useRef<GeminiLiveAgent | null>(null)
  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])
  const [inputDeviceId, setInputDeviceId] = useState('')
  const [outputDeviceId, setOutputDeviceId] = useState('')
  const [deviceBusy, setDeviceBusy] = useState(false)
  const pendingUsageSessions = useRef(new Map<string, number>())
  const settleUsageSessions = useCallback(() => {
    const sessions = [...pendingUsageSessions.current.entries()]
    pendingUsageSessions.current.clear()
    for (const [sessionId, startedAt] of sessions) {
      void fetch('/api/ai/live-usage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          actualSeconds: Math.max(0, Math.ceil((Date.now() - startedAt) / 1000)),
        }),
        keepalive: true,
      }).then((response) => {
        if (!response.ok) {
          pendingUsageSessions.current.set(sessionId, startedAt)
          setError('تعذر تسوية جلسة المشرف الصوتي؛ حاول إيقاف وتشغيل الجلسة مجددًا.')
        }
      }).catch(() => {
        pendingUsageSessions.current.set(sessionId, startedAt)
        setError('تعذر الاتصال بخدمة تسجيل دقائق الاجتماع.')
      })
    }
  }, [])
  const checkAudioDevices = async () => {
    if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
      setError('هذا المتصفح لا يدعم اختيار أجهزة الصوت. استخدم Chrome حديثاً على الكمبيوتر.')
      return
    }
    setDeviceBusy(true)
    try {
      const test = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      test.getTracks().forEach((track) => track.stop())
      const devices = await navigator.mediaDevices.enumerateDevices()
      setAudioDevices(devices.filter((device) => device.deviceId && (device.kind === 'audioinput' || device.kind === 'audiooutput')))
      setError(null)
    } catch {
      setError('اسمح للمتصفح بالميكروفون أولًا، ثم اختر المدخل والمخرج الافتراضيين.')
    } finally {
      setDeviceBusy(false)
    }
  }

  const stop = () => {
    agentRef.current?.stop()
    agentRef.current = null
    settleUsageSessions()
    setRunning(false)
    setVoiceState('IDLE')
  }
  const start = async () => {
    if (agentRef.current || busy) return
    if (!inputDeviceId || !outputDeviceId) {
      setError('اختر مدخل صوت الاجتماع ومخرج صوت المشرف الافتراضيين قبل تشغيل المشاركة.')
      return
    }
    setBusy(true)
    setError(null)
    setHeard('')
    setSpoken('')
    const agent = new GeminiLiveAgent({
      sessionEndpoint: basePath,
      sessionAction: 'voice-session',
      meetingDataEndpoint: basePath,
      onSessionCreated: (sessionId) => pendingUsageSessions.current.set(sessionId, Date.now()),
      inputDeviceId,
      outputDeviceId,
      logEndpoint: basePath,
      logExtra: { action: 'live-turn' },
      onState: (state) => setVoiceState(state),
      onUserCaption: (text) => setHeard(text),
      onAiCaption: (text) => setSpoken(text),
      onError: (msg) => {
        setError(msg)
        // A terminated Live connection must also reset the station controls.
        if (msg.includes('انقطع اتصال Gemini Live')) {
          agentRef.current?.stop()
          agentRef.current = null
          settleUsageSessions()
          setRunning(false)
          setVoiceState('IDLE')
        }
      },
    })
    agentRef.current = agent
    try {
      await agent.start()
      setRunning(true)
    } catch (e) {
      agent.stop()
      agentRef.current = null
      setError(e instanceof Error ? e.message : 'تعذّر تشغيل المشرف الصوتي')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    const agent = agentRef
    return () => { agent.current?.stop(); agent.current = null }
  }, [])

  return (
    <section className="mt-3 rounded-2xl border border-violet-300 bg-violet-50 p-4 text-right" dir="rtl" aria-label="المشارك الصوتي المستقل">
      <p className="text-sm font-black text-violet-950">المشرف الذكي — مشارك صوتي مستقل (Gemini Live)</p>
      <p className="mt-1 text-xs leading-relaxed text-violet-900">
        {provider === 'ZOOM'
          ? 'افتح اجتماع Zoom بعميل Zoom الرسمي على هذا الجهاز كمشارك مستقل باسم «المشرف الذكي — AACT». اضبط Zoom ليستقبل صوت Gemini من منفذ صوت افتراضي ويرسل صوت بقية الأعضاء إلى مدخل Gemini منفصل.'
          : 'هذه محطة المشرف الذكي داخل غرفة WebRTC. استخدم مدخلًا افتراضيًا لصوت الأعضاء ومخرجًا افتراضيًا لصوت Gemini، واضبط الميكروفون المرسل إلى الغرفة على مخرج Gemini.'}
        {' '}المشرف يسمع ويرد مباشرة، وليس زر تشغيل تسجيل. فعّل صوت الكمبيوتر مرة واحدة بإذن صاحب الجهاز.
      </p>
      <div className="mt-3 space-y-2 rounded-xl border border-violet-200 bg-white p-3">
        <Button type="button" size="sm" variant="outline" disabled={deviceBusy || running}
          onClick={() => void checkAudioDevices()}>
          {deviceBusy ? 'جارٍ فحص أجهزة الصوت…' : 'فحص أجهزة الصوت الافتراضية'}
        </Button>
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-xs font-bold text-violet-900">
            مدخل صوت الحاضرين إلى Gemini
            <select value={inputDeviceId} disabled={running} onChange={(e) => setInputDeviceId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-violet-200 bg-white px-2 py-2 text-xs">
              <option value="">اختر مدخل الصوت</option>
              {audioDevices.filter((d) => d.kind === 'audioinput').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || 'مدخل صوت ' + d.deviceId.slice(0, 8)}</option>
              ))}
            </select>
          </label>
          <label className="block text-xs font-bold text-violet-900">
            مخرج صوت Gemini إلى الاجتماع
            <select value={outputDeviceId} disabled={running} onChange={(e) => setOutputDeviceId(e.target.value)}
              className="mt-1 w-full rounded-lg border border-violet-200 bg-white px-2 py-2 text-xs">
              <option value="">اختر مخرج الصوت</option>
              {audioDevices.filter((d) => d.kind === 'audiooutput').map((d) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || 'مخرج صوت ' + d.deviceId.slice(0, 8)}</option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-[11px] leading-relaxed text-slate-600">
          لا تختَر نفس حلقة الصوت للمدخل والمخرج. وصّل مخرج Zoom إلى المدخل الأول،
          ومخرج Gemini إلى ميكروفون Zoom عبر مسار افتراضي ثانٍ؛ وإلا قد يتكرر الصوت أو يتوقف.
        </p>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={() => void (running ? stop() : start())}
          disabled={busy} className={running ? 'bg-red-700 text-white hover:bg-red-800' : 'bg-violet-700 text-white hover:bg-violet-800'}>
          {busy ? 'جارٍ وصل الصوت الحي…' : running ? 'إيقاف مشاركة المشرف الذكي' : 'بدء مشاركة المشرف الذكي بصوته'}
        </Button>
        <span role="status" className="text-xs font-semibold text-violet-900">{running ? 'Gemini Live متصل — ' + voiceState + '؛ تحقق من مسار صوت الاجتماع' : 'غير متصل صوتياً'}</span>
      </div>
      {heard && <p className="mt-2 text-xs text-slate-700">الكلام المسموع (قد يحتاج تصحيحاً): {heard}</p>}
      {spoken && <p className="mt-2 text-xs text-violet-900">مداخلة المشرف: {spoken}</p>}
      {error && <p role="alert" className="mt-2 text-xs font-semibold text-red-700">{error}</p>}
      <p className="mt-2 text-[11px] text-slate-600">
        عند تشغيل المحضر، يُحفظ التفريغ بوسم «المتحدث غير محدد» ما لم تُثبت هويته.
        تُراجع الإدارة المحضر قبل اعتماده. لا تشارك صوت الاجتماع دون موافقة الحاضرين.
      </p>
    </section>
  )
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
  const [aiDeviceMode, setAiDeviceMode] = useState(false)
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
  // تفريغ محلي لصوت صاحب الجهاز فقط؛ لا يدّعي سماع Zoom الخارجي.
  const [transcriptOn, setTranscriptOn] = useState(false)
  const [transcriptError, setTranscriptError] = useState<string | null>(null)
  const transcriptActiveRef = useRef(false)
  const recognitionRef = useRef<any>(null)
  const recognitionRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null)
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

  const stopTranscript = () => {
    transcriptActiveRef.current = false
    if (recognitionRestartRef.current) clearTimeout(recognitionRestartRef.current)
    recognitionRestartRef.current = null
    try { recognitionRef.current?.abort() } catch { /* unavailable */ }
    recognitionRef.current = null
    setTranscriptOn(false)
  }

  const toggleTranscript = () => {
    if (transcriptActiveRef.current) { stopTranscript(); return }
    const browser = window as any
    const Recognizer = browser.SpeechRecognition || browser.webkitSpeechRecognition
    if (!Recognizer) {
      setTranscriptError('التفريغ الصوتي غير مدعوم في هذا المتصفح؛ استخدم متصفحاً يدعم SpeechRecognition.')
      return
    }
    const recognition = new Recognizer()
    recognition.lang = 'ar-SA'
    recognition.continuous = true
    recognition.interimResults = false
    recognition.maxAlternatives = 1
    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex || 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result?.isFinal) continue
        const text = String(result[0]?.transcript || '').trim().slice(0, 2200)
        if (text.length < 3 || !transcriptActiveRef.current) continue
        // Only finalized captions from the speaker's own microphone, never
        // the meeting audio of absent participants. Sender identity is server-set.
        void fetch(basePath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'transcript', text }),
        }).then(async (res) => {
          if (res.ok) return
          const error = await res.json().catch(() => ({}))
          if (res.status === 403 || res.status === 429) stopTranscript()
          setTranscriptError(error?.error || 'تعذر حفظ التفريغ الصوتي')
        }).catch(() => setTranscriptError('انقطع الاتصال أثناء حفظ التفريغ؛ تحقق من اتصالك.'))
      }
    }
    recognition.onerror = (event: any) => {
      if (event?.error === 'no-speech') return
      setTranscriptError('تعذر استقبال الكلام من الميكروفون (' + String(event?.error || 'غير معروف') + ').')
      stopTranscript()
    }
    recognition.onend = () => {
      if (!transcriptActiveRef.current) return
      recognitionRestartRef.current = setTimeout(() => {
        if (!transcriptActiveRef.current) return
        try { recognition.start() } catch {
          stopTranscript()
          setTranscriptError('توقف التعرف الصوتي. يمكن تفعيله مجددًا من القاعة.')
        }
      }, 750)
    }
    try {
      transcriptActiveRef.current = true
      recognitionRef.current = recognition
      recognition.start()
      setTranscriptOn(true)
      setTranscriptError(null)
    } catch {
      stopTranscript()
      setTranscriptError('لم يُسمح بالميكروفون أو لم يبدأ التعرف على الكلام.')
    }
  }

  // On navigation/unmount, stop browser speech capture and all scheduled restarts.
  useEffect(() => {
    const active = transcriptActiveRef
    const recognizer = recognitionRef
    const restart = recognitionRestartRef
    return () => {
      active.current = false
      if (restart.current) clearTimeout(restart.current)
      try { recognizer.current?.abort() } catch { /* unavailable */ }
      recognizer.current = null
    }
  }, [])

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
      // Zoom Meeting SDK is for human attendees. The dedicated AI station
      // instead joins via the installed Zoom client as a separate participant.
      if (d.zoomSdk && !aiDeviceMode) {
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
        {data?.meeting?.aiAssistantEnabled && data?.meeting?.minutesEnabled && (
          <div className="mb-3 rounded-xl bg-white p-3 text-xs font-semibold text-slate-700">
            <Button onClick={toggleTranscript} variant="outline" size="sm">
              {transcriptOn ? 'إيقاف تفريغ صوتي للمحضر' : 'تفعيل تفريغ صوتي للمحضر'}
            </Button>
            <p className="mt-2">التفريغ يلتقط صوت ميكروفونك فقط بعد إذنك؛ بقية المشاركين يفعّلونه من أجهزتهم. راجعوا النص قبل اعتماد المحضر.</p>
            {transcriptError && <p role="alert" className="mt-2 text-red-600">{transcriptError}</p>}
          </div>
        )}
        <MeetingRoom
          token={segment}
          displayName={data?.canOperateAi && aiDeviceMode ? 'المشرف الذكي — AACT' : storeUserName || undefined}
          onLeave={() => {
            stopTranscript()
            setInRoom(false)
            load()
          }}
        />
        {data?.canOperateAi && aiDeviceMode && <MeetingAiVoiceControl basePath={basePath} provider="PLATFORM" />}
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
                      <p className="mb-2 whitespace-pre-wrap rounded-xl bg-white px-3 py-2 text-xs font-semibold leading-relaxed text-slate-700">{assistantAnswer}</p>
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

            {data?.canOperateAi && (
              <div className="rounded-xl border border-violet-200 bg-violet-50 px-3 py-3">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-black text-violet-950">
                  <input type="checkbox" checked={aiDeviceMode} onChange={(e) => setAiDeviceMode(e.target.checked)} />
                  هذا جهاز المشرف الذكي المستقل — الانضمام كمشارك AI
                </label>
                <p className="mt-1 text-[11px] leading-relaxed text-violet-800">
                  اختر هذا على الجهاز المخصص فقط؛ الحساب الإداري مخوّل بالاستعلام عن سجلات الأكاديمية.
                  في Zoom يُفتح عميل Zoom المستقل، وليس Meeting SDK، ويحتاج ضبط مساري الصوت الافتراضيين.
                </p>
              </div>
            )}
            {data?.canOperateAi && aiDeviceMode && meeting.provider === 'ZOOM' && joinOpenNow && (
              <MeetingAiVoiceControl basePath={basePath} provider="ZOOM" />
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
                      {meeting.aiAssistantEnabled && meeting.minutesEnabled && (
                        <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs font-semibold text-slate-700">
                          <Button onClick={toggleTranscript} variant="outline" size="sm">
                            {transcriptOn ? 'إيقاف تفريغ صوتي للمحضر' : 'تفعيل تفريغ صوتي للمحضر'}
                          </Button>
                          <p className="mt-2">يلتقط التفريغ كلامك من هذا الجهاز فقط، ولا يستمع تلقائياً إلى أصوات بقية أعضاء Zoom. يجب مراجعة التفريغ قبل اعتماد المحضر.</p>
                          {transcriptError && <p role="alert" className="mt-2 text-red-600">{transcriptError}</p>}
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
                      {aiDeviceMode ? 'فُتح رابط Zoom؛ تأكد من دخول المشرف الذكي عبر عميل Zoom ومن ظهور اسمه بين المشاركين. فتح الرابط وحده ليس إثباتًا لدخول الصوت.' : 'فُتح رابط الاجتماع في نافذة جديدة وسُجّلت محاولة الدخول.'}
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
