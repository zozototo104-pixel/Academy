'use client'

import { useAppStore, api, getToken } from '@/lib/store'
import { getSharedAudio, playOnSharedAudio, unlockAudioOnFirstGesture } from '@/lib/audioPlayer'
import { GeminiLiveAgent as VoiceAgent } from '@/lib/voice/geminiLiveAgent'
import type { VoiceState as AgentVoiceState } from '@/lib/voice/voiceStateMachine'
import { AcademyLogo } from '@/components/aact/Shell'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Bot, Send, Mic, MicOff, Volume2, VolumeX, Loader2,
  Trash2, Sparkles, MessageCircle, User2, Phone, PhoneOff,
  ShieldCheck, FileSearch, Radio, Captions, Activity,
} from 'lucide-react'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  mode?: string // TEXT | VOICE
  kind?: string | null // THESIS_REVIEW
  time?: string
}

// ===== Web Speech API typings =====
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [i: number]: { 0: { transcript: string }; isFinal: boolean } }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: any) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}
function getRecognition(): SpeechRecognitionLike | null {
  const w = window as any
  const SR = w.SpeechRecognition || w.webkitSpeechRecognition
  if (!SR) return null
  const rec: SpeechRecognitionLike = new SR()
  rec.lang = 'ar-SA'
  // نخليه مستمر قدر الإمكان. Safari/Chrome قد يوقفه تلقائياً عند الصمت،
  // لذلك نعيد تشغيله من onend إذا لم يكن الإيقاف بطلب المستخدم.
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1
  return rec
}

const QUICK_QUESTIONS = [
  'ما الذي أنجزته حتى الآن في برنامجي وما الخطوة التالية؟',
  'اشرح لي أهم مفاهيم الكتب المقررة في تخصصي',
  'اشرح لي تحليل SWOT بمثال عملي',
  'كيف أستعد لامتحان الفصل الدراسي؟',
  'متى تصدر شهادتي بعد المناقشة؟',
  'كيف يُحسب العائد على الاستثمار ROI؟',
]

function buildSpeechText(text: string): string {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_#>\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function pickArabicBrowserVoice(): SpeechSynthesisVoice | null {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return null
  const voices = window.speechSynthesis.getVoices?.() || []
  return (
    voices.find((v) => /ar|arabic|العربية/i.test(`${v.lang} ${v.name}`)) ||
    voices.find((v) => /samantha|maged|tarik|laila|rana|zeina|google/i.test(v.name)) ||
    null
  )
}

// ===== نتائج تحليل مسودة البحث =====
interface ThesisReview {
  overallScore: number
  verdict: string
  strengths: string[]
  weaknesses: string[]
  methodology: string
  sources: string
  nextSteps: string[]
}

export function AIChatView() {
  const { user, navigate, activeUnitId } = useAppStore()
  const { toast } = useToast()
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [autoSpeak, setAutoSpeak] = useState(true)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [sttSupported, setSttSupported] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(true)

  // ===== المحادثة الصوتية الحية — VoiceAgent حقيقي ثنائي الاتجاه =====
  // المسار: مايك+AEC → VAD → STT حي → End-of-Turn ذكي → LLM streaming
  //        → Semantic Chunker → Prosody → TTS streaming → مشغل متواصل + Barge-in
  const [voiceMode, setVoiceMode] = useState(false)
  const [voiceState, setVoiceState] = useState<AgentVoiceState>('IDLE')
  const [lastReply, setLastReply] = useState('')
  const [liveCaption, setLiveCaption] = useState('')
  const [muted, setMuted] = useState(false)
  const [micLevel, setMicLevel] = useState(0) // 0..1 — من VAD الحقيقي
  const [showCaptions, setShowCaptions] = useState(true)
  const [showTimings, setShowTimings] = useState(false) // HUD زمن المراحل
  const [timings, setTimings] = useState<{ event: string; atMs: number }[]>([])
  const agentRef = useRef<VoiceAgent | null>(null)
  const mutedRef = useRef(false)
  mutedRef.current = muted

  // ===== 12.1: تحليل مسودة بحث التخرج =====
  const [reviewOpen, setReviewOpen] = useState(false)
  const [reviewTitle, setReviewTitle] = useState('')
  const [reviewText, setReviewText] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [review, setReview] = useState<ThesisReview | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speechUtteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const autoSpeakRef = useRef(autoSpeak)
  autoSpeakRef.current = autoSpeak
  const voiceModeRef = useRef(voiceMode)
  voiceModeRef.current = voiceMode
  const activeUnitRef = useRef<string | null>(null)
  activeUnitRef.current = activeUnitId ?? null
  // مسجل بديل ASR خادمي (لمتصفحات بلا Web Speech API)
  const asrRecorderRef = useRef<MediaRecorder | null>(null)
  const speechDraftRef = useRef('')
  const micManualStopRef = useRef(false)
  const micRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Load history
  useEffect(() => {
    if (!user) return
    setLoadingHistory(true)
    api<{ messages: any[] }>('/api/chat')
      .then((d) =>
        setMessages(
          d.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            mode: m.mode,
            kind: m.kind,
            time: new Date(m.createdAt).toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
          }))
        )
      )
      .catch(() => {})
      .finally(() => setLoadingHistory(false))
  }, [user])

  // Check STT support
  useEffect(() => {
    const w = window as any
    setSttSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition))
    unlockAudioOnFirstGesture() // فتح قناة الصوت بأول لمسة — ضروري لنطق الردود على iOS
    return () => {
      recognitionRef.current?.abort()
      audioRef.current?.pause()
      try { window.speechSynthesis?.cancel() } catch {}
      speechUtteranceRef.current = null
      if (micRestartTimerRef.current) clearTimeout(micRestartTimerRef.current)
    }
  }, [])

  // Auto scroll
  useEffect(() => {
    if (!voiceMode) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, interim, sending, voiceMode])

  // ===== نطق ردود الدردشة النصية عبر صوت Gemini/TTS الطبيعي فقط =====
  const fetchSpeechUrl = useCallback(async (text: string): Promise<string> => {
    const speechText = buildSpeechText(text)
    if (!speechText) throw new Error('النص المطلوب نطقه فارغ')
    const token = getToken()
    const res = await fetch('/api/ai/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text: speechText, speed: 1.12 }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err?.error || 'تعذر توليد الصوت')
    }
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }, [])

  const playSpeechUrl = useCallback(async (url: string, msgId: string) => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    try { window.speechSynthesis?.cancel() } catch {}
    speechUtteranceRef.current = null

    const audio = getSharedAudio()
    audioRef.current = audio
    setSpeakingId(msgId)
    const cleanup = () => {
      URL.revokeObjectURL(url)
      setSpeakingId(null)
    }
    audio.onended = cleanup
    audio.onerror = cleanup
    const ok = await playOnSharedAudio(url)
    if (!ok) throw new Error('autoplay blocked')
  }, [])

  const showSpeechError = useCallback((e: any) => {
    setSpeakingId(null)
    if (!voiceModeRef.current) {
      const msg = String(e?.message || '').trim()
      toast({
        title: 'تنبيه',
        description: msg && msg !== 'autoplay blocked' ? msg : 'تعذر تشغيل الصوت — اضغط زر السماعة على الرد للمحاولة مرة أخرى',
        variant: 'destructive',
      })
    }
  }, [toast])

  const speak = useCallback(
    async (text: string, msgId: string) => {
      try {
        const url = await fetchSpeechUrl(text)
        await playSpeechUrl(url, msgId)
      } catch (e: any) {
        showSpeechError(e)
      }
    },
    [fetchSpeechUrl, playSpeechUrl, showSpeechError]
  )

  // ===== إرسال الرسالة للخادم مع حفظ القناة (نص/صوت) =====
  const send = useCallback(
    async (textArg?: string, opts?: { voice?: boolean; fromVoiceLoop?: boolean }) => {
      const text = (textArg ?? input).trim()
      if (!text || (sending && !opts?.fromVoiceLoop)) return
      setInput('')
      setInterim('')
      const voice = !!opts?.voice
      if (voice) {
        setLiveCaption(text)
      }
      const userMsg: Msg = {
        id: `tmp-${Date.now()}`,
        role: 'user',
        content: text,
        mode: voice ? 'VOICE' : 'TEXT',
        time: new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
      }
      setMessages((prev) => [...prev, userMsg])
      setSending(true)
      try {
        // ربط سؤال الطالب بالوحدة الدراسية التي يقرؤها الآن (سياق حي للمشرف الذكي)
        const unitCtx = activeUnitRef.current
          ? `الطالب يقرأ الآن وحدة دراسية في منصة الأكاديمية (معرف الوحدة: ${activeUnitRef.current}) — إن كان سؤاله عن درسه الحالي فاربط إجابتك به.`
          : undefined
        const d = await api<{ reply: string; messageId: string }>('/api/chat', {
          method: 'POST',
          body: JSON.stringify({ message: text, mode: voice ? 'VOICE' : 'TEXT', context: unitCtx }),
        })
        const aiMsg: Msg = {
          id: d.messageId,
          role: 'assistant',
          content: d.reply,
          mode: voice ? 'VOICE' : 'TEXT',
          time: new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' }),
        }
        setMessages((prev) => [...prev, aiMsg])
        if (!voice && autoSpeakRef.current) {
          speak(d.reply, d.messageId)
        }
      } catch (e: any) {
        toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
        setMessages((prev) => prev.filter((m) => m.id !== userMsg.id))
        if (!voice) setInput(text)
      } finally {
        setSending(false)
      }
    },
    [input, sending, speak, toast]
  )

  // ===== الوضع الصوتي الحي — عبر VoiceAgent (VAD + End-of-Turn ذكي + بث كامل + Barge-in) =====
  const toggleVoiceMode = () => {
    if (voiceMode) {
      setVoiceMode(false)
      voiceModeRef.current = false
      agentRef.current?.stop()
      agentRef.current = null
      setSpeakingId(null)
      setListening(false)
      setInterim('')
      setLiveCaption('')
      setMicLevel(0)
      setVoiceState('IDLE')
      setMuted(false)
      return
    }
    audioRef.current?.pause()
    try { window.speechSynthesis?.cancel() } catch {}
    speechUtteranceRef.current = null
    setSpeakingId(null)
    setVoiceMode(true)
    voiceModeRef.current = true
    const agent = new VoiceAgent({
      onState: (s) => setVoiceState(s),
      onLevel: (lvl) => setMicLevel((prev) => prev * 0.5 + lvl * 0.5),
      onUserCaption: (t) => setLiveCaption(t),
      onAiCaption: (t) => setLastReply(t),
      onTimings: (rows) => setTimings(rows),
      onTurnComplete: ({ userText, aiText, messageId }) => {
        // إدراج الدور في سجل المحادثة الظاهر — يبقى متاحاً بعد إنهاء الوضع الصوتي
        const now = new Date().toLocaleTimeString('ar', { hour: '2-digit', minute: '2-digit' })
        setMessages((prev) => [
          ...prev,
          { id: `vu-${Date.now()}`, role: 'user', content: userText, mode: 'VOICE', time: now },
          { id: messageId || `va-${Date.now()}`, role: 'assistant', content: aiText, mode: 'VOICE', time: now },
        ])
        setLiveCaption('')
      },
      onInterrupted: () => {
        setLiveCaption('')
      },
      onError: (msg) => toast({ title: 'تنبيه', description: msg, variant: 'destructive' }),
    })
    agentRef.current = agent
    agent.start().catch((e: any) => {
      const msg = String(e?.message || '').trim() || 'تأكد من السماح بالمايكروفون ثم أعد المحاولة'
      toast({ title: 'تعذر بدء المحادثة الصوتية', description: msg, variant: 'destructive' })
      setVoiceMode(false)
      voiceModeRef.current = false
      agentRef.current = null
    })
  }

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    agentRef.current?.setMuted(next)
    if (next) setLiveCaption('')
  }

  // Voice input (زر المايكروفون العادي — عبارة واحدة)
  // مع بديل ASR خادمي للمتصفحات التي لا تدعم Web Speech API (تسجيل MediaRecorder → /api/ai/asr)
  const toggleMic = () => {
    if (listening) {
      micManualStopRef.current = true
      if (micRestartTimerRef.current) clearTimeout(micRestartTimerRef.current)
      recognitionRef.current?.stop()
      asrRecorderRef.current?.stop()
      setListening(false)
      return
    }
    if (speakingId) {
      audioRef.current?.pause()
      try { window.speechSynthesis?.cancel() } catch {}
      speechUtteranceRef.current = null
      setSpeakingId(null)
    }
    const rec = getRecognition()
    if (!rec) {
      startAsrFallback()
      return
    }
    micManualStopRef.current = false
    speechDraftRef.current = ''
    recognitionRef.current = rec
    rec.onresult = (e) => {
      let finalText = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += ` ${r[0].transcript}`
        else interimText += ` ${r[0].transcript}`
      }
      if (finalText.trim()) {
        speechDraftRef.current = `${speechDraftRef.current} ${finalText}`.replace(/\s+/g, ' ').trim()
        setInput(speechDraftRef.current)
      }
      setInterim((interimText || speechDraftRef.current || 'يستمع… اضغط المايك مرة أخرى للإرسال').trim())
    }
    rec.onerror = (ev: any) => {
      const err = String(ev?.error || '')
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        micManualStopRef.current = true
        setListening(false)
        setInterim('')
        speechDraftRef.current = ''
        toast({ title: 'صلاحية المايكروفون مرفوضة', description: 'اسمح بالوصول للمايكروفون من إعدادات المتصفح', variant: 'destructive' })
        return
      }
      // no-speech / aborted يحدث كثيراً في iPhone وChrome؛ لا نطفئ الزر بسببه.
      if (!micManualStopRef.current) {
        setListening(true)
        setInterim((speechDraftRef.current || 'ما زلت أستمع… اضغط المايك مرة أخرى للإرسال').trim())
      }
    }
    rec.onend = () => {
      if (micManualStopRef.current) {
        const text = speechDraftRef.current.trim()
        speechDraftRef.current = ''
        recognitionRef.current = null
        setListening(false)
        setInterim('')
        if (text) send(text)
        return
      }

      // المتصفح قد ينهي التعرف تلقائياً بعد الصمت؛ نعيد تشغيله حتى يضغط المستخدم الإيقاف.
      setListening(true)
      setInterim((speechDraftRef.current || 'ما زلت أستمع… اضغط المايك مرة أخرى للإرسال').trim())
      if (micRestartTimerRef.current) clearTimeout(micRestartTimerRef.current)
      micRestartTimerRef.current = setTimeout(() => {
        if (micManualStopRef.current || recognitionRef.current !== rec) return
        try {
          rec.start()
        } catch {
          setListening(false)
          setInterim(speechDraftRef.current || '')
        }
      }, 250)
    }
    try {
      rec.start()
      setListening(true)
      setInterim('يستمع… اضغط المايك مرة أخرى للإرسال')
    } catch {
      setListening(false)
      setInterim('')
    }
  }

  // ===== بديل التعرف الصوتي الخادمي (ASR) — لمتصفحات بلا Web Speech =====
  const startAsrFallback = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      asrRecorderRef.current = rec
      const chunks: BlobPart[] = []
      rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setInterim('يجري تحويل صوتك إلى نص…')
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
          if (blob.size < 3000) throw new Error('التسجيل قصير جداً — اضغط المايك وتحدث ثم اضغط مرة أخرى للإرسال')
          const b64 = await new Promise<string>((resolve) => {
            const fr = new FileReader()
            fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '')
            fr.readAsDataURL(blob)
          })
          const d = await api<{ text: string }>('/api/ai/asr', {
            method: 'POST',
            body: JSON.stringify({ audioBase64: b64 }),
          })
          setInterim('')
          if (d.text?.trim()) send(d.text.trim())
          else toast({ title: 'لم يُفهم الصوت', description: 'حاول مرة أخرى بنطق أوضح', variant: 'destructive' })
        } catch (e: any) {
          setInterim('')
          toast({ title: 'تعذر التعرف على الصوت', description: e.message || 'حاول مجدداً', variant: 'destructive' })
        } finally {
          asrRecorderRef.current = null
        }
      }
      rec.start()
      setListening(true)
      setInterim('يستمع… اضغط أيقونة المايك مجدداً عند انتهاء سؤالك')
    } catch {
      toast({ title: 'المايكروفون غير متاح', description: 'اسمح بالوصول للمايكروفون أو اكتب سؤالك', variant: 'destructive' })
    }
  }

  const clearChat = async () => {
    if (!confirm('هل تريد مسح المحادثة بالكامل؟')) return
    try {
      await api('/api/chat', { method: 'DELETE' })
      setMessages([])
      toast({ title: 'تم المسح', description: 'محادثتك مع المشرف الذكي فارغة الآن' })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    }
  }

  // ===== 12.1: تحليل مسودة بحث التخرج =====
  const submitReview = async () => {
    if (reviewText.trim().length < 120) {
      toast({ title: 'تنبيه', description: 'الصق مسودة أطول (120 حرفاً على الأقل)', variant: 'destructive' })
      return
    }
    setReviewBusy(true)
    setReview(null)
    try {
      const d = await api<{ review: ThesisReview }>('/api/supervisor/thesis-review', {
        method: 'POST',
        body: JSON.stringify({ title: reviewTitle, text: reviewText }),
      })
      setReview(d.review)
      toast({ title: 'اكتمل التحليل', description: `تقييم المسودة: ${d.review.overallScore}/100` })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setReviewBusy(false)
    }
  }

  if (!user) {
    navigate('auth')
    return null
  }

  const voiceStateLabel: Record<AgentVoiceState, string> = {
    IDLE: 'جاري التحضير…',
    LISTENING: 'أستمع إليك… تحدث الآن',
    USER_SPEAKING: 'أسمعك الآن…',
    THINKING: 'لحظة…',
    AI_SPEAKING: 'أتحدث — قاطعني متى شئت',
    INTERRUPTED: 'سمعتك — تفضل…',
  }
  const listeningForUI = voiceState === 'LISTENING' || voiceState === 'USER_SPEAKING' || voiceState === 'INTERRUPTED'

  return (
    <>
    {/* الشاشة الصوتية الغامرة خارج الحاوية المحوّلة حتى تملأ الشاشة فعلياً */}
    {voiceMode && (
      <div className="fixed inset-0 z-[100] flex flex-col bg-gradient-to-b from-[#0a1f36] via-[#0f2b46] to-[#12365c]" dir="rtl">
        {/* شريط علوي: شفافية إلزامية + الحالة + شعار الأكاديمية */}
        <div className="flex items-center justify-between px-5 py-4">
          <div className="flex items-center gap-2.5">
            <AcademyLogo size={34} light />
            <div className="flex items-center gap-2 text-[11px] font-black text-[#e0b83a]">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
            محادثة صوتية حية — تتحدث مع مشرف ذكاء اصطناعي
            </div>
          </div>
          <Badge className="gap-1 bg-emerald-500/15 text-[9px] font-black text-emerald-300 hover:bg-emerald-500/15">
            <ShieldCheck className="h-3 w-3" /> تُحفظ المحادثة في ملفك تلقائياً
          </Badge>
        </div>

        {/* الكرة الصوتية + التسميات */}
        <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
          <div className="relative flex items-center justify-center">
            {listeningForUI && !muted && (
              <>
                <span className="aact-orb-ring" />
                <span className="aact-orb-ring r2" />
                <span className="aact-orb-ring r3" />
              </>
            )}
            <button
              onClick={() => agentRef.current?.interrupt()}
              aria-label="اضغط لمقاطعة الرد"
              className={`aact-voice-orb flex h-44 w-44 items-center justify-center sm:h-52 sm:w-52 ${voiceState === 'AI_SPEAKING' ? 'aact-orb-speaking' : voiceState === 'THINKING' ? 'aact-orb-thinking' : ''}`}
              style={{ transform: listeningForUI ? `scale(${1 + micLevel * 0.4})` : undefined }}
            >
              <span className="aact-voice-orb-inner" />
              {listeningForUI ? (
                <Mic className="relative h-14 w-14 text-[#0f2b46]" />
              ) : voiceState === 'AI_SPEAKING' ? (
                <Volume2 className="relative h-14 w-14 text-[#0f2b46]" />
              ) : (
                <Bot className="relative h-14 w-14 text-[#0f2b46]" />
              )}
            </button>
          </div>

          <div className="min-h-8">
            <p className="text-center text-base font-black text-white">
              {muted ? 'المايك مكتوم — اضغط زر المايك للاستئناف' : voiceStateLabel[voiceState]}
            </p>
            {!muted && listeningForUI && (
              <div className="aact-mini-wave mx-auto mt-3">
                {[0, 1, 2, 3, 4, 5, 6].map((i) => (
                  <span key={i} style={{ height: `${Math.max(4, micLevel * 22 * (1 + Math.sin(Date.now() / 120 + i) * 0.4))}px` }} />
                ))}
              </div>
            )}
          </div>

          {showCaptions && (liveCaption || (voiceState === 'AI_SPEAKING' && lastReply)) && (
            <div className="w-full max-w-2xl space-y-3 rounded-2xl bg-black/25 p-5 text-center backdrop-blur">
              {liveCaption && <p className="text-lg font-bold leading-relaxed text-white">«{liveCaption}»</p>}
              {voiceState === 'AI_SPEAKING' && lastReply && (
                <p className="mx-auto max-w-xl text-sm leading-loose text-white/70">{lastReply}</p>
              )}
            </div>
          )}

          {/* HUD زمن المراحل — يعرض أزمنة آخر دور فعلياً بلا إخفاء */}
          {showTimings && timings.length > 0 && (
            <div dir="ltr" className="rounded-xl bg-black/40 px-4 py-3 font-mono text-[10px] leading-relaxed text-emerald-300">
              {timings.map((t) => (
                <div key={t.event}>
                  {t.event.padEnd(22, ' ')} +{t.atMs}ms
                </div>
              ))}
            </div>
          )}
        </div>

        {/* أدوات التحكم السفلية */}
        <div className="flex items-center justify-center gap-4 px-6 pb-10 pt-4">
          <button
            onClick={toggleMute}
            aria-label={muted ? 'إلغاء الكتم' : 'كتم المايك'}
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition-all active:scale-95 ${
              muted ? 'border-white/20 bg-white/10 text-white/60' : 'border-white/30 bg-white/15 text-white hover:bg-white/25'
            }`}
          >
            {muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </button>
          <button
            onClick={toggleVoiceMode}
            aria-label="إنهاء المحادثة الصوتية"
            className="flex h-16 w-16 items-center justify-center rounded-full bg-[#b22234] text-white shadow-2xl transition-all hover:bg-[#c9333f] active:scale-95"
          >
            <PhoneOff className="h-6 w-6" />
          </button>
          <button
            onClick={() => setShowCaptions(!showCaptions)}
            aria-label="إظهار/إخفاء التسميات"
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition-all active:scale-95 ${
              showCaptions ? 'border-white/30 bg-white/15 text-white hover:bg-white/25' : 'border-white/20 bg-transparent text-white/50'
            }`}
          >
            <Captions className="h-5 w-5" />
          </button>
          <button
            onClick={() => setShowTimings(!showTimings)}
            aria-label="إظهار/إخفاء أزمنة المراحل"
            title="أزمنة المراحل (تشخيصي)"
            className={`flex h-14 w-14 items-center justify-center rounded-full border transition-all active:scale-95 ${
              showTimings ? 'border-emerald-300/50 bg-emerald-400/20 text-emerald-200' : 'border-white/20 bg-transparent text-white/50'
            }`}
          >
            <Activity className="h-5 w-5" />
          </button>
        </div>
        {!sttSupported && (
          <p className="pb-6 text-center text-[11px] font-bold text-amber-300">متصفحك لا يدعم المحادثة الصوتية — استخدم Chrome/Edge</p>
        )}
      </div>
    )}
    <div className="aact-fade-in mx-auto flex h-[calc(100vh-4rem)] max-w-4xl flex-col px-4 py-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-[#0f2b46]/10 pb-3">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="rounded-full bg-[#0f2b46] p-2.5 text-[#e0b83a]">
              <Bot className="h-6 w-6" />
            </div>
            <span className="absolute -bottom-0.5 -left-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
          </div>
          <div>
            <h1 className="text-base font-black text-[#0f2b46] sm:text-lg">المشرف الذكي — AACT AI</h1>
            <div className="flex items-center gap-1.5">
              {/* الشفافية الإلزامية: تعريف الطالب بأنه يتحدث مع مشرف ذكاء اصطناعي */}
              <Badge className="gap-1 bg-emerald-100 text-[9px] font-black text-emerald-700 hover:bg-emerald-100">
                <ShieldCheck className="h-2.5 w-2.5" /> مشرف ذكاء اصطناعي
              </Badge>
              <span className="text-[10px] font-bold text-slate-400">مرفوق بمشرفك البشري</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setReviewOpen(true)} className="border-[#c9a227] font-bold text-[#a8841a]" title="تحليل مسودة بحث التخرج">
            <FileSearch className="h-4 w-4" />
            <span className="hidden text-[11px] font-bold sm:inline">تحليل مسودة بحثي</span>
          </Button>
          <Button
            size="sm" variant="outline"
            onClick={() => setAutoSpeak(!autoSpeak)}
            className={`border-[#c9a227] ${autoSpeak ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#a8841a]'}`}
            title={autoSpeak ? 'الردود الصوتية مفعلة' : 'الردود الصوتية معطلة'}
          >
            {autoSpeak ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="outline" onClick={clearChat} className="border-red-200 text-red-500 hover:bg-red-50" title="مسح المحادثة">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className={`aact-scroll flex-1 space-y-4 overflow-y-auto py-4 ${voiceMode ? 'hidden' : ''}`}>
        {loadingHistory ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-lg py-6 text-center">
            <div className="mx-auto mb-4 w-fit rounded-2xl bg-[#0f2b46] p-4 text-[#e0b83a]">
              <MessageCircle className="h-9 w-9" />
            </div>
            <h2 className="text-lg font-black text-[#0f2b46]">أهلاً {user.name}!</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              أنا <strong>مشرفك الذكي</strong> — مشرف ذكاء اصطناعي مخصص لك ويرافقك بالتوازي مع مشرفك الأكاديمي البشري.
              أعرف تخصصك وبرنامجك وكتبك المقررة ودرجاتك ومواعيدك، وأستطيع تحليل مسودة بحثك.
              ابدأ <strong>محادثة صوتية حية</strong> من الزر العلوي أو اسألني كتابةً.
            </p>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {QUICK_QUESTIONS.map((qq) => (
                <button
                  key={qq}
                  onClick={() => send(qq)}
                  className="rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-right text-xs font-bold text-[#0f2b46] shadow-sm transition-all hover:border-[#c9a227] hover:shadow"
                >
                  <Sparkles className="ml-1.5 inline h-3.5 w-3.5 text-[#c9a227]" />
                  {qq}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div key={m.id} className={`flex items-end gap-2 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  m.role === 'user' ? 'bg-[#c9a227] text-[#0f2b46]' : 'bg-[#0f2b46] text-[#e0b83a]'
                }`}
              >
                {m.role === 'user' ? <User2 className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </div>
              <div
                className={`group max-w-[82%] rounded-2xl px-4 py-3 text-sm leading-loose shadow-sm sm:max-w-[75%] ${
                  m.role === 'user'
                    ? 'rounded-br-sm bg-[#0f2b46] text-white'
                    : 'rounded-bl-sm bg-[#f7edd0] text-[#0f2b46]'
                }`}
              >
                {m.kind === 'THESIS_REVIEW' && (
                  <Badge className="mb-1.5 gap-1 bg-[#c9a227] text-[9px] font-black text-[#0f2b46] hover:bg-[#c9a227]">
                    <FileSearch className="h-2.5 w-2.5" /> تحليل مسودة بحث
                  </Badge>
                )}
                <div className="whitespace-pre-wrap">{m.content}</div>
                <div className={`mt-1.5 flex items-center justify-between gap-2 text-[10px] ${m.role === 'user' ? 'text-white/50' : 'text-[#a8841a]/70'}`}>
                  <span className="flex items-center gap-1.5">
                    {m.time}
                    {m.mode === 'VOICE' && <span className="flex items-center gap-0.5 font-bold"><Mic className="h-2.5 w-2.5" /> صوتي</span>}
                  </span>
                  {m.role === 'assistant' && (
                    <button
                      onClick={() => {
                        if (speakingId === m.id) {
                          audioRef.current?.pause()
                          try { window.speechSynthesis?.cancel() } catch {}
                          speechUtteranceRef.current = null
                          setSpeakingId(null)
                        } else {
                          speak(m.content, m.id)
                        }
                      }}
                      className="opacity-60 transition-opacity hover:opacity-100"
                      title="استمع للرد"
                    >
                      {speakingId === m.id ? (
                        <span className="flex items-center gap-1 font-bold">
                          <span className="aact-speak-wave">
                            <span /><span /><span /><span />
                          </span>
                          يتحدث
                        </span>
                      ) : (
                        <Volume2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))
        )}

        {sending && (
          <div className="flex items-end gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#0f2b46] text-[#e0b83a]">
              <Bot className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm bg-[#f7edd0] px-4 py-3.5">
              <span className="flex gap-1">
                <span className="aact-typing-dot h-2 w-2 rounded-full bg-[#a8841a]" />
                <span className="aact-typing-dot h-2 w-2 rounded-full bg-[#a8841a]" />
                <span className="aact-typing-dot h-2 w-2 rounded-full bg-[#a8841a]" />
              </span>
              <span className="text-[11px] font-bold text-[#a8841a]">المشرف الذكي يفكر...</span>
            </div>
          </div>
        )}

        {interim && (
          <div className="flex items-end gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#c9a227] text-[#0f2b46]">
              <Mic className="h-4 w-4" />
            </div>
            <div className="max-w-[75%] rounded-2xl rounded-br-sm border-2 border-dashed border-[#c9a227] bg-white/70 px-4 py-2.5 text-sm italic text-slate-500">
              {interim}...
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="border-t border-[#0f2b46]/10 bg-[#f5f0e1]/95 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
        <div className="grid grid-cols-[2.9rem_2.9rem_minmax(0,1fr)_2.9rem] items-end gap-2 sm:grid-cols-[3rem_3rem_minmax(0,1fr)_3rem]">
          <Button
            onClick={toggleVoiceMode}
            size="icon"
            className={`h-11 w-11 shrink-0 rounded-full sm:h-12 sm:w-12 ${
              voiceMode ? 'aact-pulse-mic bg-[#b22234] text-white hover:bg-[#b22234]' : 'bg-[#0f2b46] text-[#e0b83a] hover:bg-[#12365c]'
            }`}
            title={voiceMode ? 'إنهاء المحادثة الصوتية الحية' : 'محادثة صوتية حية — استماع مستمر ومقاطعة'}
          >
            {voiceMode ? <PhoneOff className="h-5 w-5" /> : <Phone className="h-5 w-5" />}
          </Button>
          <Button
            onClick={toggleMic}
            size="icon"
            variant="outline"
            className={`h-11 w-11 shrink-0 rounded-full border-[#0f2b46]/20 sm:h-12 sm:w-12 ${listening ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#0f2b46]'}`}
            title="سؤال صوتي واحد"
          >
            {listening ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
          </Button>
          <div className="flex-1 rounded-2xl border border-[#0f2b46]/15 bg-white px-4 py-1 shadow-sm focus-within:border-[#c9a227]">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={listening ? 'أتحدث... تفضل بالكلام' : 'اكتب سؤالك للمشرف الذكي...'}
              rows={1}
              className="max-h-28 w-full resize-none bg-transparent py-2.5 text-sm leading-relaxed outline-none"
            />
          </div>
          <Button
            onClick={() => send()}
            disabled={sending || !input.trim()}
            size="icon"
            className="h-11 w-11 shrink-0 rounded-full bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a] sm:h-12 sm:w-12"
            title="إرسال"
          >
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5 rotate-180" />}
          </Button>
        </div>
        <p className="mt-2 text-center text-[10px] leading-relaxed text-slate-400">
          {sttSupported
            ? 'زر الهاتف: محادثة صوتية حية بمقاطعة فورية — زر المايك: سؤال صوتي واحد — وتظهر كل محادثاتك (نصاً وصوتاً) في ملفك لدى المشرف البشري والإدارة'
            : 'متصفحك لا يدعم الإدخال الصوتي — استخدم Chrome للحديث الصوتي، أو اكتب سؤالك'}
        </p>
      </div>

      {/* ===== نافذة تحليل مسودة بحث التخرج ===== */}
      <Dialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-black text-[#0f2b46]">
              <FileSearch className="h-5 w-5 text-[#a8841a]" /> تحليل مسودة بحث التخرج
            </DialogTitle>
            <DialogDescription>
              المشرف الذكي يراجع مسودتك علمياً: الإشكالية والمنهجية والأدبيات والنتائج والتوثيق — ويحفظ التحليل في ملفك
            </DialogDescription>
          </DialogHeader>

          {!review ? (
            <div className="space-y-3.5">
              <div className="space-y-1.5">
                <Label className="text-xs font-black">عنوان البحث</Label>
                <Input value={reviewTitle} onChange={(e) => setReviewTitle(e.target.value)} placeholder="مثال: أثر التحول الرقمي على أداء الموظفين" className="h-10 text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-black">نص المسودة (الصق فصول بحثك — كلما زادت التفاصيل كان التحليل أدق)</Label>
                <Textarea
                  value={reviewText}
                  onChange={(e) => setReviewText(e.target.value)}
                  placeholder="الصق هنا مقدمة البحث والإشكالية والمنهجية والنتائج والتوصيات..."
                  className="min-h-44 text-sm leading-relaxed"
                />
                <p className="text-left text-[10px] font-bold text-slate-400">{reviewText.length} حرفاً {reviewText.length < 120 && '— الحد الأدنى 120'}</p>
              </div>
              <Button onClick={submitReview} disabled={reviewBusy || reviewText.trim().length < 120} className="w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                {reviewBusy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <FileSearch className="ml-2 h-4 w-4" />}
                {reviewBusy ? 'المشرف الذكي يقرأ مسودتك ويحللها...' : 'اطلب التحليل العلمي'}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className={`rounded-xl p-4 text-center ${review.overallScore >= 70 ? 'bg-emerald-50' : review.overallScore >= 50 ? 'bg-amber-50' : 'bg-red-50'}`}>
                <p className="text-3xl font-black text-[#0f2b46]">{review.overallScore}<span className="text-lg">/100</span></p>
                <p className="mt-1 text-xs font-bold text-slate-600">{review.verdict}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-emerald-50 p-3.5">
                  <h4 className="mb-1.5 text-[11px] font-black text-emerald-700">نقاط القوة</h4>
                  <ul className="space-y-1 text-[11px] leading-relaxed text-emerald-800">
                    {review.strengths.map((s, i) => <li key={i}>• {s}</li>)}
                  </ul>
                </div>
                <div className="rounded-xl bg-amber-50 p-3.5">
                  <h4 className="mb-1.5 text-[11px] font-black text-amber-700">ملاحظات جوهرية</h4>
                  <ul className="space-y-1 text-[11px] leading-relaxed text-amber-800">
                    {review.weaknesses.map((s, i) => <li key={i}>• {s}</li>)}
                  </ul>
                </div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3.5 text-[11px] leading-relaxed text-slate-700">
                <p><strong className="text-[#0f2b46]">المنهجية: </strong>{review.methodology}</p>
                <p className="mt-2"><strong className="text-[#0f2b46]">الأدبيات والتوثيق: </strong>{review.sources}</p>
              </div>
              <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/50 p-3.5">
                <h4 className="mb-1.5 text-[11px] font-black text-[#a8841a]">خطوات عملية قبل المناقشة</h4>
                <ol className="list-inside list-decimal space-y-1 text-[11px] leading-relaxed text-[#5c4d1a]">
                  {review.nextSteps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setReview(null)} className="flex-1 border-[#c9a227] font-bold text-[#a8841a]">
                  تحليل مسودة أخرى
                </Button>
                <Button onClick={() => { setReviewOpen(false); navigate('chat') }} className="flex-1 bg-[#0f2b46] font-bold text-[#f5f0e1] hover:bg-[#12365c]">
                  ناقش التحليل مع المشرف
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
    </>
  )
}
