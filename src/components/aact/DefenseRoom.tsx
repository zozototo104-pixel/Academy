'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { getSharedAudio, playOnSharedAudio, unlockAudioOnFirstGesture } from '@/lib/audioPlayer'
import { GeminiLiveAgent as VoiceAgent } from '@/lib/voice/geminiLiveAgent'
import type { VoiceState as AgentVoiceState } from '@/lib/voice/voiceStateMachine'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { AcademyLogo } from '@/components/aact/Shell'
import {
  Bot, Video, VideoOff, Mic, MicOff, Send, Loader2, Gavel, Users2,
  Phone, PhoneOff, Sparkles, Volume2, Radio, CalendarClock, User2, Captions,
  Disc, FileSignature, ShieldCheck, Network, MonitorUp,
} from 'lucide-react'

// ===== أنواع Web Speech (مطابقة لنمط AIChatView) =====
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
  rec.continuous = true
  rec.interimResults = true
  rec.maxAlternatives = 1
  return rec
}

interface DefenseMsg {
  id: string
  role: string // AI_EXPERT | STUDENT | SYSTEM | TRANSCRIPT | AI_NOTE
  content: string
  score?: number | null
  createdAt: string
}

interface Participant {
  peerId: string
  name: string
  role: string
  tz?: string | null
  joinedAt?: string
}

interface DefenseThesis {
  id: string
  title: string
  abstract: string
  defenseDate?: string | null
  committee?: string | null
  agentMember?: string | null
  defenseStatus?: string | null
  aiScore?: number | null
  aiRecommendation?: string | null
  defenseMinutes?: string | null
  recordingSize?: number | null
}

const ICE_SERVERS_FALLBACK: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

// خريطة ترجمة حالة اتصال كل نظير إلى شارة واضحة داخل القاعة
const PEER_STATE_LABEL: Record<string, { label: string; cls: string }> = {
  connected: { label: 'متصل — جودة جيدة', cls: 'bg-emerald-500/25 text-emerald-200' },
  connecting: { label: 'جاري الاتصال…', cls: 'bg-amber-500/25 text-amber-200' },
  disconnected: { label: 'تعذر الاتصال — إعادة محاولة', cls: 'bg-red-500/25 text-red-200' },
  failed: { label: 'فشل الاتصال', cls: 'bg-red-500/25 text-red-200' },
}

function fmtTz(tz?: string | null): string {
  if (!tz) return ''
  try {
    const t = new Intl.DateTimeFormat('ar', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(new Date())
    return `${tz.split('/').pop() || tz} ${t}`
  } catch {
    return ''
  }
}

export function DefenseRoom({
  thesis,
  onFinished,
  mode = 'student',
}: {
  thesis: DefenseThesis
  onFinished?: () => void
  mode?: 'student' | 'committee'
}) {
  const { toast } = useToast()
  const [roomOpen, setRoomOpen] = useState(false)
  const [messages, setMessages] = useState<DefenseMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [listening, setListening] = useState(false)
  const [interim, setInterim] = useState('')
  const [camOn, setCamOn] = useState(true)
  const [speaking, setSpeaking] = useState(false)
  const [sttSupported, setSttSupported] = useState(true)
  const [lastScore, setLastScore] = useState<number | null>(null)
  const [finished, setFinished] = useState(thesis.defenseStatus === 'COMPLETED')
  const [aiScore, setAiScore] = useState<number | null>(thesis.aiScore ?? null)
  const [aiRec, setAiRec] = useState<string | null>(thesis.aiRecommendation ?? null)
  const [minutes, setMinutes] = useState<string | null>(thesis.defenseMinutes ?? null)

  // ===== 12.3: القاعة متعددة الأطراف (WebRTC) =====
  const [participants, setParticipants] = useState<Participant[]>([])
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [connected, setConnected] = useState(false)

  // ===== إتمام القاعة: خوادم ICE/TURN + شاشة تجهيز الأجهزة + كتم المايك + مشاركة الشاشة + جودة الاتصال =====
  const [preJoin, setPreJoin] = useState(false)
  const [iceServers, setIceServers] = useState<RTCIceServer[]>(ICE_SERVERS_FALLBACK)
  const [hasTurn, setHasTurn] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [sharing, setSharing] = useState(false)
  const [peerStates, setPeerStates] = useState<Record<string, string>>({})
  const [deviceReady, setDeviceReady] = useState(false)
  const iceServersRef = useRef<RTCIceServer[]>(ICE_SERVERS_FALLBACK)
  const screenStreamRef = useRef<MediaStream | null>(null)

  // ===== 12.3: التفريغ الصوتي الحي + ملاحظات المستشار الذكي =====
  const [transcriptOn, setTranscriptOn] = useState(false)
  const transcriptCountRef = useRef(0)
  const transcriptRecRef = useRef<SpeechRecognitionLike | null>(null)
  const transcriptResumeRef = useRef(false)
  const transcriptPausedForSpeechRef = useRef(false)
  const aiInterjectingRef = useRef(false)
  const lastInterjectionAtRef = useRef(0)
  const lastSpokenMessageIdRef = useRef<string | null>(null)

  // ===== مشرف صوتي متدفق داخل الفيديو كونفرنس — Gemini Live مثل زر الاتصال =====
  const [liveAdvisorOn, setLiveAdvisorOn] = useState(false)
  const [liveAdvisorState, setLiveAdvisorState] = useState<AgentVoiceState>('IDLE')
  const [liveAdvisorLevel, setLiveAdvisorLevel] = useState(0)
  const [liveUserCaption, setLiveUserCaption] = useState('')
  const [liveAiCaption, setLiveAiCaption] = useState('')
  const liveAdvisorRef = useRef<VoiceAgent | null>(null)

  // ===== 12.3: تسجيل الجلسة وأرشفتها =====
  const [recState, setRecState] = useState<'IDLE' | 'RECORDING' | 'SAVING' | 'SAVED' | 'FAILED' | 'NA'>('IDLE')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recStartRef = useRef(0)

  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const ttsSerialRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)

  const myPeerId = useRef<string>('')
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const thesisIdRef = useRef(thesis.id)

  const committee: string[] = (() => {
    try { return JSON.parse(thesis.committee || '[]') } catch { return [] }
  })()
  const isStudent = mode === 'student'

  // دعم التعرف الصوتي + جلب خوادم ICE/TURN من إعدادات المنصة (عبر NAT)
  useEffect(() => {
    const w = window as any
    setSttSupported(!!(w.SpeechRecognition || w.webkitSpeechRecognition))
    api<{ iceServers: RTCIceServer[]; hasTurn: boolean }>('/api/webrtc/config')
      .then((d) => {
        if (d.iceServers?.length) {
          iceServersRef.current = d.iceServers
          setIceServers(d.iceServers)
          setHasTurn(!!d.hasTurn)
        }
      })
      .catch(() => {})
    return () => {
      recognitionRef.current?.abort()
      transcriptRecRef.current?.abort()
      liveAdvisorRef.current?.stop()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      screenStreamRef.current?.getTracks().forEach((t) => t.stop())
      audioRef.current?.pause()
    }
  }, [])

  // فتح قناة الصوت بأول لمسة داخل القاعة — لضمان نطق الخبير على iOS
  useEffect(() => {
    unlockAudioOnFirstGesture()
  }, [])

  // تمرير تلقائي
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, interim])

  // ===== نطق رسائل خبير الذكاء الاصطناعي (مع تعليق التفريغ أثناء النطق) =====
  const speak = useCallback(async (text: string) => {
    // عند تشغيل Gemini Live داخل القاعة يجب أن يكون مصدر الصوت واحداً فقط.
    // لذلك نمنع TTS المحلي من قراءة رسائل AI_NOTE/AI_EXPERT فوق صوت البث المتدفق.
    if (liveAdvisorRef.current) return
    const ttsSerial = ++ttsSerialRef.current
    let wasTranscribing = false
    try {
      audioRef.current?.pause()
      // أثناء نطق الخبير نوقف التفريغ الحي حتى لا يلتقط صوت المكبرات ولا يعيد تشغيل نفسه قبل انتهاء الصوت.
      wasTranscribing = transcriptResumeRef.current
      if (wasTranscribing) {
        transcriptPausedForSpeechRef.current = true
        transcriptRecRef.current?.stop()
      }
      const firstBlock = text.split('\n').filter(Boolean).slice(0, 4).join(' ').slice(0, 900)
      setSpeaking(true)
      const res = await fetch('/api/ai/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: firstBlock, speed: 1.0 }),
      })
      if (!res.ok) throw new Error('TTS failed')
      if (liveAdvisorRef.current || ttsSerial !== ttsSerialRef.current) return
      const blob = await res.blob()
      if (liveAdvisorRef.current || ttsSerial !== ttsSerialRef.current) return
      const url = URL.createObjectURL(blob)
      // العنصر الصوتي الدائم المشترك — يسمح به iOS بعد فتحه بأول لمسة
      const audio = getSharedAudio()
      audioRef.current = audio
      const resume = () => {
        URL.revokeObjectURL(url)
        if (ttsSerial === ttsSerialRef.current) setSpeaking(false)
        transcriptPausedForSpeechRef.current = false
        if (wasTranscribing && !liveAdvisorRef.current) { try { transcriptRecRef.current?.start() } catch {} }
      }
      audio.onended = resume
      audio.onerror = resume
      const ok = await playOnSharedAudio(url)
      if (!ok) throw new Error('autoplay blocked')
    } catch {
      transcriptPausedForSpeechRef.current = false
      if (wasTranscribing && !liveAdvisorRef.current && ttsSerial === ttsSerialRef.current) { try { transcriptRecRef.current?.start() } catch {} }
      if (ttsSerial === ttsSerialRef.current) setSpeaking(false)
    }
  }, [])

  const buildDefenseVoiceContext = useCallback((overrideMessages?: DefenseMsg[]) => {
    const recent = (overrideMessages || messages)
      .slice(-10)
      .map((m) => `${m.role === 'AI_EXPERT' ? 'سؤال رسمي' : m.role === 'AI_NOTE' ? 'مداخلة سابقة' : m.role === 'TRANSCRIPT' ? 'كلام الطالب' : m.role === 'STUDENT' ? 'إجابة مكتوبة' : 'نظام'}: ${m.content.slice(0, 450)}`)
      .join('\n')
    return `أنت الآن داخل قاعة فيديو كونفرنس لمناقشة بحث تخرج، ولست في دردشة نصية. المطلوب صوت متدفق طبيعي مثل مكالمة مباشرة.

هويتك داخل القاعة: المستشار الذكي عضو لجنة استشاري حاضر مع الطالب واللجنة. لا تقرأ نصاً فصيحاً جامداً، ولا تنتظر دائماً نهاية إجابة رسمية. تحدث كإنسان أكاديمي: قاطع بلطف عند الحاجة، علّق على كلام الطالب، صحح له المسار، اطلب مثالاً أو دليلاً، ثم اترك له فرصة يكمل.

أسلوبك الصوتي المطلوب: عربي بسيط قريب من الشامي/الفلسطيني إن تكلم الطالب بهذه اللهجة. جملة إلى ثلاث جمل فقط. استخدم عبارات طبيعية مثل: "تمام، فهمت عليك"، "اسمح لي أوقفك هون شوي"، "النقطة جيدة بس بدها دليل". ممنوع الأسلوب الآلي، وممنوع تعداد النقاط.

موضوع المناقشة: ${thesis.title}
ملخص البحث: ${thesis.abstract.slice(0, 1200)}
اللجنة المعلنة: ${committee.join('، ') || 'لجنة الأكاديمية'}

آخر ما ظهر في القاعة:
${recent || 'بدأت الجلسة للتو.'}

قاعدة مهمة: إذا بدأ الطالب يتكلم لا تصمت طويلاً. تفاعل معه كمشرف يناقش لا كسؤال وجواب. ومع ذلك لا تعطِ قرار نجاح أو رسوب؛ القرار النهائي للجنة البشرية.`
  }, [committee, messages, thesis.abstract, thesis.title])

  const stopLiveAdvisor = useCallback(() => {
    liveAdvisorRef.current?.stop()
    liveAdvisorRef.current = null
    setLiveAdvisorOn(false)
    setLiveAdvisorState('IDLE')
    setLiveAdvisorLevel(0)
    setLiveUserCaption('')
    setLiveAiCaption('')
  }, [])

  const startLiveAdvisor = useCallback((initialMessages?: DefenseMsg[]) => {
    if (!isStudent || finished || liveAdvisorRef.current) return
    audioRef.current?.pause()
    try { window.speechSynthesis?.cancel() } catch {}
    setSpeaking(false)
    if (transcriptResumeRef.current) {
      transcriptRecRef.current?.stop()
      transcriptRecRef.current = null
      transcriptResumeRef.current = false
      setTranscriptOn(false)
    }
    const agent = new VoiceAgent({
      context: buildDefenseVoiceContext(initialMessages),
      logEndpoint: '/api/defense',
      logExtra: { action: 'live-turn' },
      onState: (s) => {
        setLiveAdvisorState(s)
        setSpeaking(s === 'AI_SPEAKING')
      },
      onLevel: (lvl) => setLiveAdvisorLevel((prev) => prev * 0.55 + lvl * 0.45),
      onUserCaption: (t) => setLiveUserCaption(t),
      onAiCaption: (t) => setLiveAiCaption(t),
      onTurnComplete: ({ userText, aiText }) => {
        const nowIso = new Date().toISOString()
        const items: DefenseMsg[] = []
        if (userText.trim()) items.push({ id: `live-u-${Date.now()}`, role: 'TRANSCRIPT', content: `محادثة صوتية مباشرة: ${userText.trim()}`, createdAt: nowIso })
        if (aiText.trim()) items.push({ id: `live-a-${Date.now()}`, role: 'AI_NOTE', content: `مداخلة صوتية مباشرة: ${aiText.trim()}`, createdAt: nowIso })
        if (items.length) setMessages((prev) => [...prev, ...items])
        setLiveUserCaption('')
        setLiveAiCaption('')
      },
      onInterrupted: () => setLiveAiCaption(''),
      onError: (msg) => toast({ title: 'تنبيه المشرف الصوتي', description: msg, variant: 'destructive' }),
    })
    liveAdvisorRef.current = agent
    setLiveAdvisorOn(true)
    setLiveAdvisorState('THINKING')
    agent.start().catch((e: any) => {
      stopLiveAdvisor()
      toast({
        title: 'تعذر تشغيل المشرف الصوتي المتدفق',
        description: String(e?.message || 'تأكد من صلاحية Gemini Live والمايكروفون ثم أعد المحاولة'),
        variant: 'destructive',
      })
    })
  }, [buildDefenseVoiceContext, finished, isStudent, stopLiveAdvisor, toast])

  const toggleLiveAdvisor = useCallback(() => {
    if (liveAdvisorRef.current || liveAdvisorOn) stopLiveAdvisor()
    else startLiveAdvisor()
  }, [liveAdvisorOn, startLiveAdvisor, stopLiveAdvisor])

  // ===== 12.3: إشارات WebRTC =====
  const sendSignal = useCallback(async (type: string, payload: any, to?: string | null) => {
    try {
      await api('/api/defense/room', {
        method: 'POST',
        body: JSON.stringify({ thesisId: thesisIdRef.current, peerId: myPeerId.current, action: 'signal', type, payload, to: to || null }),
      })
    } catch {}
  }, [])

  const getOrCreatePeer = useCallback(
    async (remotePeerId: string, initiator: boolean): Promise<RTCPeerConnection> => {
      let pc = peersRef.current.get(remotePeerId)
      if (pc) return pc
      // خوادم ICE من إعدادات المنصة (STUN + TURN عند تهيئته) — TURN يضمن الاتصال عبر NAT الصارم
      pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
      peersRef.current.set(remotePeerId, pc)

      streamRef.current?.getTracks().forEach((t) => {
        try { pc!.addTrack(t, streamRef.current!) } catch {}
      })

      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal('ICE', e.candidate.toJSON(), remotePeerId)
      }
      pc.ontrack = (e) => {
        const stream = e.streams[0]
        if (stream) setRemoteStreams((prev) => ({ ...prev, [remotePeerId]: stream }))
      }
      pc.onconnectionstatechange = () => {
        if (!pc) return
        // شارة حية لحالة كل اتصال داخل القاعة
        setPeerStates((prev) => ({ ...prev, [remotePeerId]: pc!.connectionState }))
        if (['failed', 'closed'].includes(pc.connectionState)) {
          pc.close()
          peersRef.current.delete(remotePeerId)
          setRemoteStreams((prev) => {
            const n = { ...prev }
            delete n[remotePeerId]
            return n
          })
        }
      }

      if (initiator) {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal('OFFER', { sdp: pc.localDescription }, remotePeerId)
        } catch {}
      }
      return pc
    },
    [sendSignal]
  )

  const flushIce = useCallback(async (remotePeerId: string, pc: RTCPeerConnection) => {
    const queue = pendingIceRef.current.get(remotePeerId) || []
    for (const c of queue) {
      try { await pc.addIceCandidate(c) } catch {}
    }
    pendingIceRef.current.delete(remotePeerId)
  }, [])

  const processSignals = useCallback(
    async (signals: { id: string; from: string; to?: string | null; type: string; payload: any }[]) => {
      for (const sig of signals) {
        try {
          if (sig.type === 'OFFER') {
            const pc = await getOrCreatePeer(sig.from, false)
            await pc.setRemoteDescription(new RTCSessionDescription(sig.payload.sdp))
            await flushIce(sig.from, pc)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            sendSignal('ANSWER', { sdp: pc.localDescription }, sig.from)
          } else if (sig.type === 'ANSWER') {
            const pc = peersRef.current.get(sig.from)
            if (pc && pc.signalingState !== 'stable' && sig.payload?.sdp) {
              await pc.setRemoteDescription(new RTCSessionDescription(sig.payload.sdp))
              await flushIce(sig.from, pc)
            }
          } else if (sig.type === 'ICE') {
            const pc = peersRef.current.get(sig.from)
            if (pc && pc.remoteDescription) {
              try { await pc.addIceCandidate(sig.payload) } catch {}
            } else {
              const q = pendingIceRef.current.get(sig.from) || []
              q.push(sig.payload)
              pendingIceRef.current.set(sig.from, q)
            }
          } else if (sig.type === 'BYE') {
            const pc = peersRef.current.get(sig.from)
            if (pc) pc.close()
            peersRef.current.delete(sig.from)
            setRemoteStreams((prev) => {
              const n = { ...prev }
              delete n[sig.from]
              return n
            })
          }
        } catch {}
      }
    },
    [getOrCreatePeer, sendSignal, flushIce]
  )

  // حلقة الاستطلاع: نبض + مشاركون + إشارات + رسائل
  const startPolling = useCallback(() => {
    if (pollRef.current) return
    const tick = async () => {
      try {
        await api('/api/defense/room', {
          method: 'POST',
          body: JSON.stringify({ thesisId: thesisIdRef.current, peerId: myPeerId.current, action: 'heartbeat' }),
        })
        const d = await api<{ participants: Participant[]; signals: any[]; messages: DefenseMsg[]; defenseStatus?: string }>(
          `/api/defense/room?thesisId=${thesisIdRef.current}&peerId=${myPeerId.current}`
        )
        setParticipants(d.participants || [])
        const incomingMessages = d.messages || []
        setMessages((prev) => {
          const incoming = incomingMessages
          if (incoming.length !== prev.length || (incoming.length > 0 && prev.length > 0 && incoming[incoming.length - 1].id !== prev[prev.length - 1].id)) {
            return incoming
          }
          return prev
        })
        const latestLiveInterjection = [...incomingMessages].reverse().find((m) => m.role === 'AI_NOTE')
        if (latestLiveInterjection && latestLiveInterjection.id !== lastSpokenMessageIdRef.current) {
          lastSpokenMessageIdRef.current = latestLiveInterjection.id
          speak(latestLiveInterjection.content)
        }
        await processSignals(d.signals || [])
        // فتح اتصالات WebRTC مع كل مشارك جديد (أصغر معرف يبادر بالعرض لتفادي التضارب)
        for (const p of d.participants || []) {
          if (p.peerId === myPeerId.current || p.role === 'AI') continue
          if (!peersRef.current.has(p.peerId) && myPeerId.current < p.peerId) {
            getOrCreatePeer(p.peerId, true)
          }
        }
        // إغلاق اتصالات المشاركين الذين غادروا
        const onlineIds = new Set((d.participants || []).map((p) => p.peerId))
        for (const [pid, pc] of peersRef.current) {
          if (!onlineIds.has(pid)) {
            pc.close()
            peersRef.current.delete(pid)
            setRemoteStreams((prev) => {
              const n = { ...prev }
              delete n[pid]
              return n
            })
          }
        }
      } catch {}
    }
    pollRef.current = setInterval(tick, 2000)
    tick()
  }, [processSignals, getOrCreatePeer, speak])

  // ===== دخول القاعة: كاميرا + مايك + انضمام للغرفة =====
  // ===== شاشة التجهيز (Pre-join): معاينة الكاميرا والمايك قبل الانضمام — كما في قاعات الاجتماعات الاحترافية =====
  const openPreJoin = useCallback(async () => {
    setPreJoin(true)
    if (!streamRef.current) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        streamRef.current = stream
        setCamOn(true)
        setMicOn(true)
        setDeviceReady(true)
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.srcObject = stream
            videoRef.current.play().catch(() => {})
          }
        }, 250)
      } catch {
        streamRef.current = null
        setDeviceReady(false)
        toast({
          title: 'تعذر تشغيل الكاميرا/المايك',
          description: isStudent
            ? 'تحقق من صلاحيات المتصفح — يمكنك أيضاً متابعة المناقشة نصياً دون كاميرا'
            : 'ستظهر كعضو متصل بلا كاميرا — يمكنك الاستماع والتحدث عبر المحادثة النصية',
          variant: 'destructive',
        })
      }
    }
  }, [isStudent, toast])

  // الانضمام الفعلي للقاعة بعد التجهيز
  const joinNow = useCallback(async () => {
    setPreJoin(false)
    setRoomOpen(true)
    if (streamRef.current) {
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = streamRef.current!
          videoRef.current.play().catch(() => {})
        }
      }, 250)
    }
    myPeerId.current = 'p_' + Math.random().toString(36).slice(2, 10)
    let tz = ''
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone } catch {}
    try {
      await api('/api/defense/room', {
        method: 'POST',
        body: JSON.stringify({
          thesisId: thesisIdRef.current,
          peerId: myPeerId.current,
          action: 'join',
          name: isStudent ? undefined : 'عضو لجنة — الإدارة',
          role: isStudent ? 'STUDENT' : 'COMMITTEE',
          tz,
        }),
      })
      setConnected(true)
      startPolling()
    } catch (e: any) {
      toast({ title: 'تعذر الانضمام للقاعة', description: e.message, variant: 'destructive' })
    }
  }, [isStudent, startPolling, toast])

  // مغادرة القاعة نظيفة
  const leaveRoom = useCallback(
    async (silent = false) => {
      setRoomOpen(false)
      setConnected(false)
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
      peersRef.current.forEach((pc) => pc.close())
      peersRef.current.clear()
      setRemoteStreams({})
      setPeerStates({})
      screenStreamRef.current?.getTracks().forEach((t) => t.stop())
      screenStreamRef.current = null
      setSharing(false)
      setParticipants([])
      if (myPeerId.current) {
        api('/api/defense/room', {
          method: 'POST',
          body: JSON.stringify({ thesisId: thesisIdRef.current, peerId: myPeerId.current, action: 'leave' }),
        }).catch(() => {})
        myPeerId.current = ''
      }
      // حفظ التسجيل عند الخروج إن كانت الجلسة جارية قيد التسجيل
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        await stopAndSaveRecording(isStudent && !finished)
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      transcriptRecRef.current?.abort()
      transcriptRecRef.current = null
      setTranscriptOn(false)
      transcriptResumeRef.current = false
      stopLiveAdvisor()
      recognitionRef.current?.abort()
      audioRef.current?.pause()
      setSpeaking(false)
      if (!silent) setInterim('')
    },
    [isStudent, finished] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // ===== 12.3: تسجيل الجلسة (كاميرا الطالب + صوته) وأرشفتها =====
  const startRecording = useCallback(() => {
    if (!isStudent || !streamRef.current) {
      setRecState('NA')
      return
    }
    try {
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : 'video/webm'
      const rec = new MediaRecorder(streamRef.current, { mimeType: mime, videoBitsPerSecond: 250000, audioBitsPerSecond: 64000 })
      recChunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) recChunksRef.current.push(e.data)
      }
      rec.onstop = () => {}
      rec.start(2000)
      recStartRef.current = Date.now()
      recorderRef.current = rec
      setRecState('RECORDING')
    } catch {
      setRecState('NA')
    }
  }, [isStudent])

  const stopAndSaveRecording = useCallback(
    async (showToast = true) => {
      const rec = recorderRef.current
      if (!rec || rec.state === 'inactive') return
      setRecState('SAVING')
      const durationSec = Math.round((Date.now() - recStartRef.current) / 1000)
      await new Promise<void>((resolve) => {
        rec.onstop = () => resolve()
        rec.stop()
      })
      recorderRef.current = null
      try {
        const blob = new Blob(recChunksRef.current, { type: 'video/webm' })
        if (blob.size > 20 * 1024 * 1024) {
          setRecState('FAILED')
          if (showToast) toast({ title: 'التسجيل طويل جداً', description: 'تجاوز 20 ميجابايت — سيُعتمد محضر الجلسة والتفريغ النصي بدلاً منه', variant: 'destructive' })
          return
        }
        const dataUrl = await new Promise<string>((resolve) => {
          const fr = new FileReader()
          fr.onloadend = () => resolve(String(fr.result))
          fr.readAsDataURL(blob)
        })
        await api('/api/defense', {
          method: 'POST',
          body: JSON.stringify({ action: 'save-recording', dataUrl, mime: 'video/webm', durationSec }),
        })
        setRecState('SAVED')
        if (showToast) toast({ title: 'أُرشيف تسجيل الجلسة', description: 'حُفظ فيديو وصوت الجلسة في ملف بحثك للرجوع إليه' })
      } catch (e: any) {
        setRecState('FAILED')
      }
    },
    [toast]
  )

  // ===== 12.3: التفريغ الصوتي الحي (يغذي المستشار الذكي للتحليل الفوري) =====
  const toggleTranscript = () => {
    if (transcriptOn) {
      transcriptRecRef.current?.stop()
      transcriptRecRef.current = null
      setTranscriptOn(false)
      transcriptResumeRef.current = false
      return
    }
    if (!sttSupported) {
      toast({ title: 'غير مدعوم', description: 'متصفحك لا يدعم التفريغ الصوتي — استخدم Chrome/Edge', variant: 'destructive' })
      return
    }
    const rec = getRecognition()
    if (!rec) return
    transcriptRecRef.current = rec
    transcriptResumeRef.current = true
    rec.onresult = (e) => {
      let finalText = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interimText += r[0].transcript
      }
      if (interimText) setInterim(interimText)
      if (finalText.trim()) {
        setInterim('')
        const spokenChunk = finalText.trim()
        // حفظ التفريغ + طلب مداخلة المستشار في نفس الطلب حتى لا يسكت بعد السؤال الأول.
        transcriptCountRef.current++
        const now = Date.now()
        const wantsInterjection = !aiInterjectingRef.current && now - lastInterjectionAtRef.current > 7000
        if (wantsInterjection) {
          aiInterjectingRef.current = true
          lastInterjectionAtRef.current = now
        }
        api<{ ok: boolean; note?: DefenseMsg | null }>('/api/defense', { method: 'POST', body: JSON.stringify({ action: 'transcript', text: spokenChunk }) })
          .then((d) => {
            if (!d.note) return
            setMessages((prev) => (prev.some((m) => m.id === d.note!.id) ? prev : [...prev, d.note!]))
            lastSpokenMessageIdRef.current = d.note.id
            speak(d.note.content)
          })
          .catch(() => {})
          .finally(() => {
            if (wantsInterjection) aiInterjectingRef.current = false
          })
      }
    }
    rec.onerror = () => {}
    rec.onend = () => {
      // استئناف الاستماع المستمر — إلا إذا كنا نوقفه مؤقتاً أثناء نطق الخبير
      if (transcriptPausedForSpeechRef.current) return
      if (transcriptResumeRef.current && transcriptRecRef.current) {
        setTimeout(() => { try { transcriptRecRef.current?.start() } catch {} }, 400)
      } else {
        setTranscriptOn(false)
      }
    }
    try {
      rec.start()
      setTranscriptOn(true)
    } catch {}
  }

  const start = async () => {
    setBusy(true)
    try {
      const d = await api<{ messages: DefenseMsg[] }>('/api/defense', {
        method: 'POST',
        body: JSON.stringify({ action: 'start' }),
      })
      setMessages(d.messages)
      // شغّل المشرف الصوتي المتدفق مع بداية المناقشة؛ هذا يستخدم Gemini Live صوت-إلى-صوت بدل قراءة TTS آلية.
      if (isStudent) {
        startLiveAdvisor(d.messages)
      } else {
        const lastAi = [...d.messages].reverse().find((m) => m.role === 'AI_EXPERT')
        if (lastAi) speak(lastAi.content)
      }
      startRecording() // 12.3: بدء تسجيل الجلسة مع بدء المناقشة
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const sendAnswer = async (text?: string) => {
    const answer = (text ?? input).trim()
    if (!answer || busy) return
    setBusy(true)
    setInput('')
    setInterim('')
    try {
      const d = await api<{ messages: DefenseMsg[]; completed?: boolean; aiScore?: number; aiRecommendation?: string; minutes?: string }>('/api/defense', {
        method: 'POST',
        body: JSON.stringify({ action: 'answer', text: answer }),
      })
      setMessages(d.messages)
      const studentMsg = [...d.messages].reverse().find((m) => m.role === 'STUDENT')
      if (studentMsg?.score != null) setLastScore(studentMsg.score)
      const lastAi = [...d.messages].reverse().find((m) => m.role === 'AI_EXPERT')
      if (lastAi && !liveAdvisorRef.current) speak(lastAi.content)
      if (d.completed) {
        setFinished(true)
        setAiScore(d.aiScore ?? null)
        setAiRec(d.aiRecommendation ?? null)
        setMinutes(d.minutes ?? null)
        stopAndSaveRecording()
        onFinished?.()
      }
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const endSession = async () => {
    setBusy(true)
    try {
      const d = await api<{ messages: DefenseMsg[]; aiScore?: number; aiRecommendation?: string; minutes?: string }>('/api/defense', {
        method: 'POST',
        body: JSON.stringify({ action: 'end' }),
      })
      setMessages(d.messages)
      setFinished(true)
      setAiScore(d.aiScore ?? null)
      setAiRec(d.aiRecommendation ?? null)
      setMinutes(d.minutes ?? null)
      audioRef.current?.pause()
      stopLiveAdvisor()
      setSpeaking(false)
      await stopAndSaveRecording()
      onFinished?.()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const toggleMic = () => {
    if (listening) {
      recognitionRef.current?.stop()
      setListening(false)
      return
    }
    const rec = getRecognition()
    if (!rec) {
      setSttSupported(false)
      return
    }
    recognitionRef.current = rec
    rec.continuous = false
    rec.onresult = (e) => {
      let finalText = ''
      let interimText = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) finalText += r[0].transcript
        else interimText += r[0].transcript
      }
      if (finalText) sendAnswer(finalText)
      else setInterim(interimText)
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    try {
      rec.start()
      setListening(true)
    } catch {
      setListening(false)
      toast({ title: 'تعذر بدء الاستماع', description: 'أغلق التطبيقات التي تستخدم المايكروفون وحاول مجدداً', variant: 'destructive' })
    }
  }

  const toggleCam = () => {
    const next = !camOn
    setCamOn(next)
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = next))
  }

  const toggleMicMute = () => {
    const next = !micOn
    setMicOn(next)
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = next))
  }

  // مشاركة الشاشة (عرض شرائح البحث للجنة) — استبدال مسار الفيديو مؤقتاً في كل الاتصالات
  const restoreCameraTrack = useCallback(async () => {
    if (streamRef.current) {
      const camTrack = streamRef.current.getVideoTracks()[0]
      if (camTrack) {
        for (const [, pc] of peersRef.current) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
          try { await sender?.replaceTrack(camTrack) } catch {}
        }
      }
    }
    setTimeout(() => {
      if (videoRef.current && streamRef.current) {
        videoRef.current.srcObject = streamRef.current
        videoRef.current.play().catch(() => {})
      }
    }, 150)
  }, [])

  const toggleScreenShare = useCallback(async () => {
    try {
      if (sharing) {
        // إعادة كاميرا الطالب بدل الشاشة
        screenStreamRef.current?.getTracks().forEach((t) => t.stop())
        screenStreamRef.current = null
        setSharing(false)
        await restoreCameraTrack()
        toast({ title: 'عُرضت كاميرتك مجدداً', description: 'انتهت مشاركة الشاشة' })
        return
      }
      const display = await (navigator.mediaDevices as any).getDisplayMedia({ video: true, audio: false })
      screenStreamRef.current = display
      const screenTrack = display.getVideoTracks()[0]
      if (screenTrack) {
        // إن أنهى المتصفح المشاركة من شريط المتصفح نستعيد الكاميرا تلقائياً
        screenTrack.addEventListener('ended', () => {
          screenStreamRef.current = null
          setSharing(false)
          restoreCameraTrack()
        })
        for (const [, pc] of peersRef.current) {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video')
          try { await sender?.replaceTrack(screenTrack) } catch {}
        }
      }
      setSharing(true)
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.srcObject = display
          videoRef.current.play().catch(() => {})
        }
      }, 150)
      toast({ title: 'مشاركة الشاشة تعمل', description: 'يتلقى أعضاء اللجنة والمستشار الذكي شاشتك الآن — عُرض شرائح بحثك' })
    } catch {
      toast({ title: 'تعذرت مشاركة الشاشة', description: 'اسمح بالوصول أو اختر نافذة للعرض', variant: 'destructive' })
    }
  }, [sharing, restoreCameraTrack, toast])

  const answeredCount = messages.filter((m) => m.role === 'STUDENT').length
  const inProgress = messages.length > 0 && !finished
  const others = participants.filter((p) => p.peerId !== myPeerId.current && p.role !== 'AI')
  const connectedCommitteeNames = new Set(others.map((o) => o.name))
  const liveAdvisorLabel = liveAdvisorOn
    ? liveAdvisorState === 'AI_SPEAKING'
      ? 'يتحدث معك الآن بصوت متدفق…'
      : liveAdvisorState === 'USER_SPEAKING'
        ? 'يسمعك الآن ويتابع كلامك…'
        : liveAdvisorState === 'THINKING'
          ? 'يفكر في مداخلة قصيرة…'
          : 'المشرف الصوتي المتدفق يعمل'
    : 'عضو فعلي — اضغط تشغيل الصوت المتدفق'

  // ===== شاشة التجهيز (Pre-join) =====
  if (preJoin && !roomOpen) {
    return (
      <div className="overflow-hidden rounded-2xl border-2 border-[#0f2b46]/20 bg-[#0a1f36] shadow-2xl">
        <div className="bg-[#0f2b46] px-4 py-3 text-white">
          <h3 className="flex items-center gap-2 text-sm font-black">
            <Video className="h-4 w-4 text-[#e0b83a]" /> تجهيز الأجهزة قبل دخول قاعة المناقشة
          </h3>
          <p className="mt-1 text-[11px] text-white/70">تأكد من ظهورك بوضوح وسماع المايك — ثم انضم للقاعة في الموعد</p>
        </div>
        <div className="grid gap-4 p-4 md:grid-cols-2">
          <div className="relative aspect-video overflow-hidden rounded-xl bg-black ring-2 ring-[#c9a227]/60">
            {camOn && streamRef.current && deviceReady ? (
              <video ref={videoRef} muted playsInline className="h-full w-full object-cover [transform:scaleX(-1)]" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/50">
                <AcademyLogo size={64} className="opacity-80" />
                <VideoOff className="h-8 w-8" />
                <span className="text-[11px] font-bold">
                  {deviceReady ? 'الكاميرا موقفة — اضغط زر الكاميرا لتشغيلها' : 'جاري تشغيل الكاميرا والمايك…'}
                </span>
              </div>
            )}
          </div>
          <div className="space-y-3">
            <div className="rounded-xl border border-white/10 bg-white/5 p-3.5 text-[11px] leading-relaxed text-white/80">
              <p className="mb-1.5 font-black text-[#e0b83a]">قائمة تحقق سريعة</p>
              <p>✅ مكان مضاء من الأمام وخلفية هادئة</p>
              <p>✅ سماعات بدل مكبرات الصوت (أفضل جودة ولا صدى)</p>
              <p>✅ اتصال إنترنت مستقر — يفضّل Wi-Fi قوي أو سلكي</p>
              <p className="mt-1.5 flex items-center gap-1 text-[10px] font-bold text-white/60">
                <Network className="h-3 w-3" /> حالة الشبكة: {hasTurn ? 'خادم TURN مهيأ — اتصال مضمون عبر أي شبكة (NAT/شركات)' : 'اتصال مباشر P2P عبر STUN — يُنصح بتهيئة TURN للشبكات الصارمة'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant={camOn ? 'default' : 'outline'} onClick={toggleCam}
                className={`flex-1 border-white/25 font-bold ${camOn ? 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]' : 'bg-transparent text-white hover:bg-white/10'}`}>
                {camOn ? <Video className="ml-1 h-3.5 w-3.5" /> : <VideoOff className="ml-1 h-3.5 w-3.5" />} {camOn ? 'الكاميرا تعمل' : 'الكاميرا موقفة'}
              </Button>
              <Button size="sm" variant={micOn ? 'default' : 'outline'} onClick={toggleMicMute}
                className={`flex-1 border-white/25 font-bold ${micOn ? 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]' : 'bg-transparent text-white hover:bg-white/10'}`}>
                {micOn ? <Mic className="ml-1 h-3.5 w-3.5" /> : <MicOff className="ml-1 h-3.5 w-3.5" />} {micOn ? 'المايك يعمل' : 'المايك مكتوم'}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button onClick={joinNow} className="flex-1 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                <Video className="ml-2 h-4 w-4" /> انضم إلى القاعة الآن
              </Button>
              <Button variant="outline" onClick={() => setPreJoin(false)} className="border-white/25 bg-transparent font-bold text-white hover:bg-white/10">
                رجوع
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ===== بطاقة القاعة داخل تبويب بحث التخرج =====
  if (!roomOpen) {
    return (
      <div className="rounded-2xl border border-[#0f2b46]/15 bg-gradient-to-l from-[#0f2b46] to-[#12365c] p-5 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-black">
              <Video className="h-5 w-5 text-[#e0b83a]" /> قاعة المناقشة عبر الفيديو كونفرنس
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-white/80">
              مناقشتك تتم داخل المنصة عبر قاعة فيديو كونفرنس متعددة الأطراف: أنت + أعضاء اللجنة متصلون من دول مختلفة +
              خبير ذكاء اصطناعي يشارك بالأسئلة والتحليل الحي — موعدك:{' '}
              <strong>{thesis.defenseDate ? new Date(thesis.defenseDate).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'قريباً'}</strong>
              {' '}— اللجنة: {committee.join('، ') || 'ستُعلن'}{thesis.agentMember ? ` + عضو الوكيل` : ''}
            </p>
            {finished && aiScore != null && (
              <p className="mt-1.5 text-xs font-black text-[#e0b83a]">انتهت جلستك — تقييم خبير الذكاء: {aiScore}/100 (النتيجة النهائية لدى اللجنة البشرية)</p>
            )}
          </div>
          <Button
            onClick={() => {
              if (finished) { setRoomOpen(true); setConnected(true); startPolling() }
              else openPreJoin()
            }}
            className="bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]"
          >
            <Video className="ml-2 h-4 w-4" /> {finished ? (isStudent ? 'مراجعة الجلسة والمحضر' : 'عرض سجل الجلسة') : 'الدخول إلى القاعة'}
          </Button>
        </div>
      </div>
    )
  }

  // ===== قاعة المناقشة الكاملة =====
  return (
    <div className="overflow-hidden rounded-2xl border-2 border-[#0f2b46]/20 bg-[#0a1f36] shadow-2xl">
      {/* شريط علوي */}
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[#0f2b46] px-4 py-3 text-white">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 animate-pulse text-red-400" />
          <span className="text-xs font-black">قاعة المناقشة — فيديو كونفرنس مباشر داخل المنصة</span>
          {connected && <Badge className="bg-emerald-500/20 text-[9px] font-black text-emerald-300 hover:bg-emerald-500/20">متصل</Badge>}
          <Badge className="gap-1 bg-white/10 text-[9px] font-bold text-white/70 hover:bg-white/10" title={hasTurn ? 'خادم TURN مهيأ — الاتصال مضمون عبر NAT وشبكات الشركات' : 'اتصال مباشر عبر STUN — أضف TURN من إعدادات النظام للشبكات الصارمة'}>
            <Network className="h-3 w-3" /> {hasTurn ? 'TURN مفعل' : 'P2P / STUN'}
          </Badge>
          {sharing && (
            <Badge className="gap-1 bg-emerald-500/20 text-[9px] font-black text-emerald-300 hover:bg-emerald-500/20">
              <MonitorUp className="h-3 w-3" /> شاشتك معروضة على اللجنة
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isStudent && recState === 'RECORDING' && (
            <Badge className="gap-1 bg-red-500/20 text-[9px] font-black text-red-300 hover:bg-red-500/20">
              <Disc className="h-3 w-3 animate-pulse" /> تسجيل الجلسة جارٍ — تُؤرشف تلقائياً
            </Badge>
          )}
          <Badge className="bg-white/10 text-[10px] text-white hover:bg-white/10">
            <CalendarClock className="ml-1 h-3 w-3" />
            {thesis.defenseDate ? new Date(thesis.defenseDate).toLocaleDateString('ar-EG') : '—'}
          </Badge>
        </div>
      </div>

      {/* شبكة الفيديو متعددة الأطراف */}
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-4">
        {/* بلاطتي */}
        <div className="relative aspect-video overflow-hidden rounded-xl bg-black ring-2 ring-[#c9a227]">
          {camOn && streamRef.current ? (
            <video ref={videoRef} muted playsInline className="h-full w-full object-cover [transform:scaleX(-1)]" />
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-white/60">
              <VideoOff className="h-6 w-6" />
              <span className="text-[10px] font-bold">{camOn ? 'جاري تشغيل الكاميرا…' : 'الكاميرا موقفة'}</span>
            </div>
          )}
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-black text-white">
            {isStudent ? 'أنت (الباحث)' : 'أنت (اللجنة)'}{fmtTz(Intl.DateTimeFormat().resolvedOptions().timeZone) && ` · ${fmtTz(Intl.DateTimeFormat().resolvedOptions().timeZone)}`}
          </span>
        </div>

        {/* خبير الذكاء الاصطناعي — عضو فعلي في القاعة */}
        <div className={`relative aspect-video overflow-hidden rounded-xl bg-gradient-to-bl from-[#12365c] to-[#0a1f36] ${(speaking || liveAdvisorOn) ? 'ring-2 ring-emerald-400' : 'ring-1 ring-white/20'}`}>
          <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2 text-center">
            <div className={`rounded-full bg-[#c9a227] p-3 text-[#0f2b46] ${(speaking || liveAdvisorState === 'AI_SPEAKING') ? 'animate-pulse' : ''}`}>
              <Bot className="h-6 w-6" />
            </div>
            <span className="text-[10px] font-black text-white">المستشار الذكي (AI)</span>
            <span className="text-[9px] text-[#e0b83a]">{liveAdvisorLabel}</span>
            {liveAdvisorOn && (
              <div className="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-white/10">
                <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${Math.min(100, Math.round(liveAdvisorLevel * 100))}%` }} />
              </div>
            )}
          </div>
        </div>

        {/* المشاركون المتصلون فعلياً عبر WebRTC */}
        {others.map((p) => {
          const st = peerStates[p.peerId]
          const stInfo = st ? PEER_STATE_LABEL[st] : null
          return (
            <div key={p.peerId} className="relative aspect-video overflow-hidden rounded-xl bg-black ring-2 ring-emerald-500/60">
              {remoteStreams[p.peerId] ? (
                <RemoteVideo stream={remoteStreams[p.peerId]} />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-white/60">
                  <Loader2 className="h-5 w-5 animate-spin" />
                  <span className="text-[9px] font-bold">جاري الاتصال…</span>
                </div>
              )}
              <span className="absolute bottom-1.5 right-1.5 max-w-[90%] truncate rounded-md bg-black/60 px-2 py-0.5 text-[10px] font-black text-white">
                {p.name}{p.tz ? ` · ${fmtTz(p.tz)}` : ''}
              </span>
              {stInfo && (
                <span className={`absolute top-1.5 right-1.5 rounded-md px-1.5 py-0.5 text-[8px] font-black ${stInfo.cls}`}>
                  {stInfo.label}
                </span>
              )}
            </div>
          )
        })}

        {/* أعضاء اللجنة المعلنون غير المتصلين بعد */}
        {committee.filter((n) => !connectedCommitteeNames.has(n)).slice(0, 3).map((name, i) => (
          <div key={i} className="relative aspect-video overflow-hidden rounded-xl bg-gradient-to-bl from-slate-700 to-slate-900 ring-1 ring-white/20">
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
              <div className="rounded-full bg-white/15 p-3 text-white"><Gavel className="h-5 w-5" /></div>
              <span className="max-w-[90%] truncate text-[10px] font-black text-white">{name}</span>
              <span className="text-[9px] text-white/50">عضو لجنة — يتصل من موقعه عند الموعد</span>
            </div>
          </div>
        ))}
        {thesis.agentMember && !connectedCommitteeNames.has(thesis.agentMember) && (
          <div className="relative aspect-video overflow-hidden rounded-xl bg-gradient-to-bl from-purple-800 to-slate-900 ring-1 ring-white/20">
            <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
              <div className="rounded-full bg-white/15 p-3 text-white"><Users2 className="h-5 w-5" /></div>
              <span className="max-w-[90%] truncate text-[10px] font-black text-white">{thesis.agentMember}</span>
              <span className="text-[9px] text-white/50">عضو الوكيل الدولي</span>
            </div>
          </div>
        )}
      </div>

      {/* شفافية دور المستشار الذكي + القرار للجنة البشرية */}
      <div className="mx-3 mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-[10px] font-bold leading-relaxed text-emerald-200">
        <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
        المستشار الذكي (ذكاء اصطناعي) حاضر كعضو فعلي بصفة استشارية: تفريغ حي، تحليل إجابات الطالب، وملاحظات للجنة —
        القرار والتقييم النهائي للبحث يبقى بيد أعضاء اللجنة البشرية وتُعتمد النتيجة من الإدارة.
      </div>

      {/* النتيجة + المحضر بعد الانتهاء */}
      {finished && aiScore != null && (
        <div className="mx-3 mb-3 space-y-2">
          <div className="rounded-xl border border-[#c9a227]/40 bg-[#f7edd0] p-4 text-xs leading-relaxed text-[#0f2b46]">
            <p className="flex items-center gap-1.5 font-black"><Sparkles className="h-4 w-4 text-[#a8841a]" /> انتهت جلسة المناقشة — تقييم خبير الذكاء الاصطناعي: {aiScore}/100</p>
            {aiRec && <p className="mt-1.5 whitespace-pre-line text-[11px] font-semibold text-[#5c4d1a]">{aiRec}</p>}
            <p className="mt-1.5 text-[10px] font-bold text-slate-500">تُعرض التوصية على لجنة المناقشة لاعتماد النتيجة النهائية من الإدارة.</p>
          </div>
          {minutes && (
            <div className="rounded-xl border border-white/15 bg-white/5 p-4 text-[11px] leading-relaxed text-white/90">
              <p className="mb-1.5 flex items-center gap-1.5 font-black text-[#e0b83a]"><FileSignature className="h-4 w-4" /> محضر الجلسة (توليد تلقائي مؤرشف)</p>
              <p className="whitespace-pre-line">{minutes}</p>
            </div>
          )}
        </div>
      )}

      {/* المحادثة الحية: أسئلة وإجابات + تفريغ + ملاحظات المستشار الذكي */}
      <div ref={scrollRef} className="aact-scroll max-h-64 space-y-2.5 overflow-y-auto border-t border-white/10 bg-[#0a1f36] px-4 py-3">
        {messages.length === 0 ? (
          <div className="py-8 text-center text-xs font-bold text-white/50">
            <Video className="mx-auto mb-2 h-8 w-8 text-white/30" />
            {isStudent
              ? 'اضغط «بدء الجلسة» ليفتح خبير الذكاء الاصطناعي المناقشة ويطرح السؤال الأول (5 أسئلة إجمالاً)'
              : 'انتظر بدء الجلسة من الطالب — ستظهر الأسئلة والإجابات والملاحظات الحية هنا'}
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === 'SYSTEM') {
              return (
                <div key={m.id} className="mx-auto w-fit rounded-full bg-white/10 px-3 py-1 text-center text-[10px] font-bold text-white/70">
                  {m.content}
                </div>
              )
            }
            if (m.role === 'TRANSCRIPT') {
              return (
                <div key={m.id} className="flex items-start gap-2">
                  <div className="shrink-0 rounded-full bg-emerald-500/20 p-1.5 text-emerald-300"><Captions className="h-3.5 w-3.5" /></div>
                  <div className="max-w-[85%] rounded-2xl border border-dashed border-emerald-400/40 bg-emerald-500/5 px-3.5 py-2 text-xs italic leading-relaxed text-emerald-100/90">
                    <span className="mr-1.5 rounded bg-emerald-500/20 px-1.5 py-0.5 text-[8px] font-black not-italic">تفريغ حي</span>
                    {m.content}
                  </div>
                </div>
              )
            }
            if (m.role === 'AI_NOTE') {
              return (
                <div key={m.id} className="flex items-start gap-2">
                  <div className="shrink-0 rounded-full bg-purple-500/25 p-1.5 text-purple-200"><Bot className="h-3.5 w-3.5" /></div>
                  <div className="max-w-[85%] rounded-2xl border border-purple-400/40 bg-purple-500/10 px-3.5 py-2 text-xs leading-relaxed text-purple-100">
                    <span className="mr-1.5 rounded bg-purple-500/30 px-1.5 py-0.5 text-[8px] font-black">مداخلة المستشار الذكي</span>
                    <span className="mt-1 block whitespace-pre-line">{m.content}</span>
                  </div>
                </div>
              )
            }
            const isAi = m.role === 'AI_EXPERT'
            return (
              <div key={m.id} className={`flex items-start gap-2 ${isAi ? '' : 'flex-row-reverse'}`}>
                <div className={`shrink-0 rounded-full p-1.5 ${isAi ? 'bg-[#c9a227] text-[#0f2b46]' : 'bg-white/15 text-white'}`}>
                  {isAi ? <Bot className="h-3.5 w-3.5" /> : <User2 className="h-3.5 w-3.5" />}
                </div>
                <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed ${isAi ? 'bg-white/10 text-white' : 'bg-[#c9a227]/90 text-[#0f2b46]'}`}>
                  <span className="whitespace-pre-line">{m.content}</span>
                  {m.score != null && <span className="mr-2 rounded-full bg-black/20 px-2 py-0.5 text-[9px] font-black">{m.score}/10</span>}
                </div>
              </div>
            )
          })
        )}
        {liveUserCaption && (
          <div className="flex flex-row-reverse items-start gap-2">
            <div className="max-w-[85%] rounded-2xl border border-dashed border-emerald-400/60 bg-emerald-500/10 px-3.5 py-2 text-xs italic text-emerald-100">أنت الآن: {liveUserCaption}…</div>
          </div>
        )}
        {liveAiCaption && (
          <div className="flex items-start gap-2">
            <div className="shrink-0 rounded-full bg-[#c9a227] p-1.5 text-[#0f2b46]"><Bot className="h-3.5 w-3.5" /></div>
            <div className="max-w-[85%] rounded-2xl border border-[#c9a227]/50 bg-[#c9a227]/10 px-3.5 py-2 text-xs leading-relaxed text-[#f7edd0]">المشرف يتكلم: {liveAiCaption}</div>
          </div>
        )}
        {interim && (
          <div className="flex flex-row-reverse items-start gap-2">
            <div className="max-w-[85%] rounded-2xl border border-dashed border-[#c9a227]/60 px-3.5 py-2 text-xs italic text-white/70">{interim}…</div>
          </div>
        )}
      </div>

      {/* أدوات التحكم */}
      <div className="space-y-2.5 border-t border-white/10 bg-[#0f2b46] p-3">
        {isStudent && messages.length === 0 ? (
          <Button onClick={start} disabled={busy} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
            {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Video className="ml-2 h-4 w-4" />}
            بدء الجلسة — يفتح خبير الذكاء الاصطناعي المناقشة (مع بدء التسجيل)
          </Button>
        ) : isStudent && !finished ? (
          <>
            <div className="flex gap-2">
              <Textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAnswer() } }}
                placeholder={`اكتب إجابتك على السؤال (${answeredCount + 1} من 5) أو استخدم الميكروفون…`}
                className="min-h-16 flex-1 border-white/20 bg-white/95 text-xs text-[#0f2b46] placeholder:text-slate-400"
              />
              <Button size="sm" onClick={() => sendAnswer()} disabled={busy || !input.trim()} className="h-9 flex-1 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant={listening ? 'default' : 'outline'} onClick={toggleMic} disabled={busy || !sttSupported || transcriptOn || liveAdvisorOn}
                className={`flex-1 border-white/25 font-bold ${listening ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-transparent text-white hover:bg-white/10'}`}>
                {listening ? <Mic className="ml-1 h-3.5 w-3.5 animate-pulse" /> : <MicOff className="ml-1 h-3.5 w-3.5" />}
                {listening ? 'أستمع إليك… تحدث الآن' : 'الإجابة صوتياً'}
              </Button>
              <Button size="sm" variant={liveAdvisorOn ? 'default' : 'outline'} onClick={toggleLiveAdvisor}
                className={`flex-1 border-white/25 font-black ${liveAdvisorOn ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]'}`}
                title="تشغيل مشرف Gemini Live صوت-إلى-صوت داخل قاعة المناقشة؛ يتحدث معك بصوت متدفق مثل المكالمة">
                {liveAdvisorOn ? <PhoneOff className="ml-1 h-3.5 w-3.5" /> : <Phone className="ml-1 h-3.5 w-3.5" />}
                {liveAdvisorOn ? 'إيقاف المشرف المتدفق' : 'المشرف المتدفق'}
              </Button>
              <Button size="sm" variant={transcriptOn ? 'default' : 'outline'} onClick={toggleTranscript} disabled={!sttSupported || liveAdvisorOn}
                className={`flex-1 border-white/25 font-bold ${transcriptOn ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-transparent text-white hover:bg-white/10'}`}
                title="وضع نصي احتياطي: يسمع المستشار كلامك ثم يقرأه بصوت TTS. الأفضل استخدم المشرف المتدفق.">
                <Captions className="ml-1 h-3.5 w-3.5" />
                {transcriptOn ? 'التفاعل النصي يعمل' : 'تفريغ نصي احتياطي'}
              </Button>
              <Button size="sm" variant="outline" onClick={toggleCam} className="border-white/25 bg-transparent font-bold text-white hover:bg-white/10">
                {camOn ? <Video className="ml-1 h-3.5 w-3.5" /> : <VideoOff className="ml-1 h-3.5 w-3.5" />}
                {camOn ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا'}
              </Button>
              <Button size="sm" variant={micOn ? 'default' : 'outline'} onClick={toggleMicMute}
                className={`border-white/25 font-bold ${micOn ? 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]' : 'bg-transparent text-red-300 hover:bg-white/10'}`}
                title="كتم / إلغاء كتم المايكروفون">
                {micOn ? <Mic className="ml-1 h-3.5 w-3.5" /> : <MicOff className="ml-1 h-3.5 w-3.5" />}
                {micOn ? 'المايك مفتوح' : 'المايك مكتوم'}
              </Button>
              <Button size="sm" variant={sharing ? 'default' : 'outline'} onClick={toggleScreenShare}
                className={`border-white/25 font-bold ${sharing ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-transparent text-white hover:bg-white/10'}`}
                title="شارك شاشتك لعرض شرائح البحث على اللجنة">
                <MonitorUp className="ml-1 h-3.5 w-3.5" />
                {sharing ? 'إنهاء مشاركة الشاشة' : 'مشاركة الشاشة'}
              </Button>
              <Button size="sm" onClick={() => { const lastAi = [...messages].reverse().find((m) => m.role === 'AI_EXPERT'); if (lastAi) speak(lastAi.content) }}
                className="flex-1 bg-white/10 font-bold text-white hover:bg-white/20">
                <Volume2 className="ml-1 h-3.5 w-3.5" /> إعادة سماع السؤال
              </Button>
              <Button size="sm" variant="outline" onClick={endSession} disabled={busy} className="border-red-400/40 bg-transparent font-bold text-red-300 hover:bg-red-500/10">
                <PhoneOff className="ml-1 h-3.5 w-3.5" /> إنهاء الجلسة
              </Button>
            </div>
            {lastScore != null && (
              <p className="text-center text-[10px] font-black text-[#e0b83a]">تقييم إجابتك الأخيرة: {lastScore}/10 — متابعة الأسئلة…</p>
            )}
          </>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => leaveRoom()} className="flex-1 border-white/25 bg-transparent font-bold text-white hover:bg-white/10">
              خروج من القاعة
            </Button>
            {onFinished && (
              <Button onClick={() => { leaveRoom(true); onFinished() }} className="flex-1 bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                تحديث حالة البحث
              </Button>
            )}
          </div>
        )}
        {!isStudent && !finished && messages.length > 0 && (
          <div className="space-y-2">
            <Button size="sm" onClick={() => { const lastAi = [...messages].reverse().find((m) => m.role === 'AI_EXPERT'); if (lastAi) speak(lastAi.content) }}
              className="w-full bg-white/10 font-bold text-white hover:bg-white/20">
              <Volume2 className="ml-1 h-3.5 w-3.5" /> إعادة سماع آخر سؤال من الخبير الذكي
            </Button>
            <p className="text-center text-[10px] font-bold text-white/50">
              جارٍ عرض الجلسة الحية — سجّل نتيجة اللجنة النهائية من تبويب «المناقشات» بعد اكتمال الجلسة
            </p>
          </div>
        )}
        {!sttSupported && (
          <p className="text-center text-[10px] font-bold text-amber-300">الإدخال الصوتي غير مدعوم في هذا المتصفح — استخدم الكتابة</p>
        )}
      </div>
    </div>
  )
}

// فيديو مشارك بعيد
function RemoteVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream
      ref.current.play().catch(() => {})
    }
  }, [stream])
  return <video ref={ref} autoPlay playsInline className="h-full w-full object-cover" />
}
