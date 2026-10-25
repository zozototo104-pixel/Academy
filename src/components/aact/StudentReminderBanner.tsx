'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { toast } from '@/hooks/use-toast'
import { getSharedAudio, playOnSharedAudio } from '@/lib/audioPlayer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Volume2, VolumeX, Loader2, Clock, AlertTriangle } from 'lucide-react'

// شريط التذكير اليومي للطالب: أحمر نابض، ثابت في أعلى لوحته حتى يُنجز المطلوب.
// زر الصوت بجانبه مباشرة. عند تحميل اللوحة تُحاوَل قراءة التذكير صوتيًا مرة
// واحدة في الجلسة (القناة الصوتية المشتركة مفتوحة عادةً بعد أول لمسة، فعند
// هاريس يظهر الصوت لوحده؛ وإن منعه المتصفح يبقى الزر للتشغيل/إعادة التشغيل).
interface ReminderItem {
  enrollmentId: string
  programId: string
  programTitle: string
  status: string
  maxDays: number | null
  deadlineAt: string | null
  daysLeft: number | null
  pending: { kind: string; title: string; detail: string }[]
  finalScore?: number | null
}

interface ExtensionRequest {
  id: string
  enrollmentId: string
  status: string
  requestedDays: number
}

function fmtDate(value: string): string {
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ar-EG')
}

export default function StudentReminderBanner() {
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [requests, setRequests] = useState<ExtensionRequest[]>([])
  const [loaded, setLoaded] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [formOpen, setFormOpen] = useState<string | null>(null)
  const [formDays, setFormDays] = useState('')
  const [formReason, setFormReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const autoPlayedRef = useRef(false)

  const load = useCallback(async () => {
    try {
      const data = await api<{ reminders: ReminderItem[]; requests: ExtensionRequest[] }>('/api/student/reminders')
      setReminders(data.reminders || [])
      setRequests(data.requests || [])
    } catch {
      // بلا شريط عند فشل التحميل — لا نكسر اللوحة بتذكير.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    api<{ reminders: ReminderItem[]; requests: ExtensionRequest[] }>('/api/student/reminders')
      .then((data) => {
        if (cancelled) return
        setReminders(data.reminders || [])
        setRequests(data.requests || [])
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [])

  const speakText = useCallback(async (text: string) => {
    if (speaking && audioRef.current) {
      audioRef.current.pause()
      setSpeaking(false)
      return
    }
    try {
      setSpeaking(true)
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 950) }),
      })
      if (!res.ok) throw new Error('تعذر توليد الصوت')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const audio = getSharedAudio()
      audio.onended = () => setSpeaking(false)
      audioRef.current = audio
      const ok = await playOnSharedAudio(url)
      if (!ok) throw new Error('autoplay blocked')
    } catch {
      setSpeaking(false)
      toast({ title: 'تنبيه', description: 'تعذر تشغيل الصوت الآن — اضغط زر الصوت مرة أخرى', variant: 'destructive' })
    }
  }, [speaking])

  const visible = reminders.filter((r) => r.status === 'EXPIRED' || r.pending.length > 0 || (r.daysLeft != null && r.daysLeft <= 10))
  const voiceText = visible
    .map((r) => {
      if (r.status === 'EXPIRED') return `أُغلق برنامج ${r.programTitle} لانتهاء مدته. يمكنك طلب تمديد بأسباب مقنعة.`
      const items = r.pending.slice(0, 3).map((p) => `${p.title}`).join('، ')
      const deadline = r.daysLeft != null && r.daysLeft <= 10 ? ` باقي ${r.daysLeft} أيام على انتهاء برنامج ${r.programTitle}.` : ''
      return `${items ? `تذكير: ${items}.` : ''}${deadline}`
    })
    .join(' ')
    .trim()

  // محاولة تشغيل صوتي تلقائية مرة واحدة في الجلسة عند وجود تذكير عاجل.
  useEffect(() => {
    if (!loaded || autoPlayedRef.current || !voiceText) return
    autoPlayedRef.current = true
    try {
      if (sessionStorage.getItem('reminder-voice-played') === new Date().toISOString().slice(0, 10)) return
      sessionStorage.setItem('reminder-voice-played', new Date().toISOString().slice(0, 10))
    } catch { /* بلا تخزين = بلا منع تكرار، المحاولة نفسها آمنة */ }
    // مؤجَّلة لتفادي setState متزامن داخل الـ effect (قاعدة react-hooks).
    const timer = setTimeout(() => { void speakText(voiceText) }, 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, voiceText])

  if (!loaded || !visible.length) return null

  const submitRequest = async (enrollmentId: string) => {
    const days = Number(formDays)
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      toast({ title: 'عدد أيام التمديد يجب أن يكون بين 1 و 365', variant: 'destructive' })
      return
    }
    if (formReason.trim().length < 10) {
      toast({ title: 'اكتب سببًا مقنعًا (10 أحرف على الأقل)', variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      await api('/api/student/extension-requests', {
        method: 'POST',
        body: JSON.stringify({ enrollmentId, requestedDays: Math.floor(days), reason: formReason.trim() }),
      })
      toast({ title: 'تم إرسال طلب التمديد — بانتظار قرار الأدمن' })
      setFormOpen(null)
      setFormDays('')
      setFormReason('')
      load()
    } catch (e: any) {
      toast({ title: e?.message || 'تعذر إرسال طلب التمديد', variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mb-6 rounded-[2rem] border-2 border-red-500 bg-red-50 p-4 shadow-sm" role="alert">
      <div className="flex flex-wrap items-start gap-3">
        <span className="relative mt-1 flex h-4 w-4 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-4 w-4 rounded-full bg-red-600" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black leading-6 text-red-700">تذكير دراسي — لا تؤجله</p>
          <div className="mt-2 space-y-3">
            {visible.map((r) => {
              const pendingRequest = requests.find((q) => q.enrollmentId === r.enrollmentId && q.status === 'PENDING')
              return (
                <div key={r.enrollmentId} className="rounded-2xl border border-red-200 bg-white p-3">
                  <p className="text-xs font-black leading-6 text-[#0f2b46]">{r.programTitle}</p>
                  {r.status === 'EXPIRED' ? (
                    <p className="mt-1 text-xs font-bold leading-6 text-red-700">
                      أُغلق البرنامج لانتهاء مدته{r.finalScore != null ? ` — درجتك المرصودة: ${r.finalScore}` : ''}. اطلب تمديدًا بأسباب مقنعة وسيقرر الأدمن.
                    </p>
                  ) : (
                    <>
                      {r.deadlineAt && r.daysLeft != null && (
                        <p className="mt-1 flex items-center gap-1 text-xs font-bold leading-6 text-red-700">
                          <Clock className="h-3.5 w-3.5" />
                          {r.daysLeft <= 10 ? `تنبيه: باقي ${r.daysLeft} أيام على انتهاء المدة (${fmtDate(r.deadlineAt)})` : `آخر موعد للبرنامج: ${fmtDate(r.deadlineAt)} — باقي ${r.daysLeft} يومًا`}
                        </p>
                      )}
                      <ul className="mt-1 space-y-1">
                        {r.pending.slice(0, 5).map((p, i) => (
                          <li key={i} className="text-xs font-bold leading-6 text-slate-600">• {p.title} — {p.detail}</li>
                        ))}
                        {r.pending.length > 5 && <li className="text-xs font-bold text-slate-500">و{r.pending.length - 5} مهام أخرى بانتظارك.</li>}
                      </ul>
                    </>
                  )}
                  {pendingRequest ? (
                    <p className="mt-2 text-xs font-black text-amber-700">طلب تمديدك ({pendingRequest.requestedDays} يومًا) معلق بانتظار قرار الأدمن.</p>
                  ) : formOpen === r.enrollmentId ? (
                    <div className="mt-3 space-y-2">
                      <div className="flex flex-wrap gap-2">
                        <Input type="number" min={1} max={365} className="h-9 w-32 text-xs" placeholder="أيام التمديد" value={formDays} onChange={(e) => setFormDays(e.target.value)} />
                        <Input className="h-9 min-w-[220px] flex-1 text-xs" placeholder="سبب مقنع للتمديد..." value={formReason} onChange={(e) => setFormReason(e.target.value)} />
                      </div>
                      <div className="flex gap-2">
                        <Button type="button" size="sm" disabled={submitting} onClick={() => submitRequest(r.enrollmentId)} className="h-9 bg-red-600 text-xs font-black hover:bg-red-700">
                          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'إرسال طلب التمديد'}
                        </Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setFormOpen(null)} className="h-9 text-xs font-black">إلغاء</Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setFormOpen(r.enrollmentId)} className="mt-2 h-9 border-red-300 text-xs font-black text-red-700 hover:bg-red-50">
                      <AlertTriangle className="ml-1 h-3.5 w-3.5" /> طلب تمديد
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          onClick={() => speakText(voiceText)}
          className="h-11 shrink-0 rounded-2xl border-red-300 bg-white px-3 text-xs font-black text-red-700 hover:bg-red-100"
          title="استمع للتذكير"
        >
          {speaking ? <VolumeX className="ml-1.5 h-4 w-4" /> : <Volume2 className="ml-1.5 h-4 w-4" />}
          {speaking ? 'إيقاف الصوت' : 'استمع للتذكير'}
        </Button>
      </div>
    </div>
  )
}
