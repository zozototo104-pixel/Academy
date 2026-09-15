'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Loader2, Mic, MicOff, Phone, PhoneCall, PhoneIncoming, PhoneOff, RadioTower } from 'lucide-react'

type ParticipantRole = 'STUDENT' | 'SUPERVISOR'
type Phase = 'idle' | 'incoming' | 'calling' | 'connecting' | 'connected' | 'ended'

interface VoiceCall {
  id: string
  admissionId: string
  initiatorRole: ParticipantRole | string
  status: 'RINGING' | 'ACTIVE' | 'ENDED' | 'MISSED' | 'DECLINED' | string
  startedAt?: string
  joinedAt?: string | null
  endedAt?: string | null
  endedReason?: string | null
}

interface VoiceSignal {
  id: string
  callId: string
  fromRole: ParticipantRole | string
  type: 'OFFER' | 'ANSWER' | 'ICE' | 'HANGUP' | string
  payload: string
  createdAt: string
}

interface VoicePayload {
  call: VoiceCall | null
  signals: VoiceSignal[]
  rtcConfig: RTCConfiguration
}

interface Props {
  admissionId: string
  role: ParticipantRole
  title?: string
  compact?: boolean
}

function safeParse(payload: string) {
  try { return JSON.parse(payload) } catch { return null }
}

function statusArabic(phase: Phase, call?: VoiceCall | null) {
  if (call?.status === 'DECLINED') return 'تم رفض المكالمة'
  if (call?.status === 'MISSED') return 'مكالمة فائتة'
  if (call?.status === 'ENDED') return 'انتهت المكالمة'
  if (phase === 'incoming') return 'اتصال وارد'
  if (phase === 'calling') return 'جارٍ الاتصال بالطرف الآخر'
  if (phase === 'connecting') return 'جارٍ إنشاء الاتصال الصوتي'
  if (phase === 'connected') return 'متصل الآن'
  return 'جاهز لمكالمة صوتية مباشرة'
}

export function SupervisorLiveVoiceCall({ admissionId, role, title, compact }: Props) {
  const { toast } = useToast()
  const [call, setCall] = useState<VoiceCall | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [busy, setBusy] = useState(false)
  const [muted, setMuted] = useState(false)
  const [rtcAvailable, setRtcAvailable] = useState(true)
  const [lastError, setLastError] = useState('')

  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const processedRef = useRef<Set<string>>(new Set())
  const phaseRef = useRef<Phase>('idle')
  const callIdRef = useRef<string>('')
  const initiatorRef = useRef(false)
  const acceptedRef = useRef(false)
  const postingIceRef = useRef(false)
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([])

  useEffect(() => { phaseRef.current = phase }, [phase])
  useEffect(() => { callIdRef.current = call?.id || '' }, [call?.id])

  useEffect(() => {
    setRtcAvailable(typeof window !== 'undefined' && !!window.RTCPeerConnection && !!navigator.mediaDevices?.getUserMedia)
  }, [])

  const postSignal = useCallback(async (callId: string, type: string, payload: any) => {
    try {
      await api('/api/supervisor/voice-call', {
        method: 'POST',
        body: JSON.stringify({ action: 'signal', callId, type, payload }),
      })
    } catch (e: any) {
      console.error('voice signal error', e)
      setLastError(e.message || 'تعذر إرسال إشارة الاتصال')
    }
  }, [])

  const stopLocalMedia = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
  }, [])

  const closePeer = useCallback((stopMedia = true) => {
    try { pcRef.current?.close() } catch {}
    pcRef.current = null
    if (stopMedia) stopLocalMedia()
    if (remoteAudioRef.current) {
      try { remoteAudioRef.current.pause() } catch {}
      remoteAudioRef.current.srcObject = null
    }
  }, [stopLocalMedia])

  const flushPendingIce = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || !pc.remoteDescription || pendingIceRef.current.length === 0) return
    const pending = [...pendingIceRef.current]
    pendingIceRef.current = []
    for (const candidate of pending) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch (e) { console.warn('Pending ICE candidate skipped', e) }
    }
  }, [])

  const initPeer = useCallback(async (callId: string, config?: RTCConfiguration) => {
    if (!rtcAvailable) throw new Error('المتصفح لا يدعم WebRTC أو الميكروفون')
    if (pcRef.current) return pcRef.current

    const pc = new RTCPeerConnection(config || { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })
    pcRef.current = pc

    pc.onicecandidate = async (event) => {
      if (!event.candidate || postingIceRef.current) return
      await postSignal(callId, 'ICE', event.candidate.toJSON())
    }

    pc.ontrack = (event) => {
      const stream = event.streams?.[0]
      if (stream && remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream
        remoteAudioRef.current.play().catch(() => null)
      }
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setPhase('connected')
      if (pc.connectionState === 'failed') {
        setLastError('فشل الاتصال الصوتي. جرّب مرة أخرى أو تحقق من إعدادات TURN.')
        setPhase('ended')
      }
      if (pc.connectionState === 'disconnected') {
        setLastError('انقطع الاتصال مؤقتاً. قد يكون السبب ضعف الإنترنت أو عدم توفر TURN.')
      }
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    })
    localStreamRef.current = stream
    stream.getAudioTracks().forEach((track) => pc.addTrack(track, stream))
    return pc
  }, [postSignal, rtcAvailable])

  const applySignals = useCallback(async (signals: VoiceSignal[], config?: RTCConfiguration) => {
    if (!signals?.length) return
    for (const signal of signals) {
      if (processedRef.current.has(signal.id)) continue
      processedRef.current.add(signal.id)
      if (signal.fromRole === role) continue
      const payload = safeParse(signal.payload)
      if (!payload && signal.type !== 'HANGUP') continue

      try {
        if (signal.type === 'HANGUP') {
          setPhase('ended')
          closePeer(true)
          continue
        }

        if (signal.type === 'OFFER') {
          if (!acceptedRef.current && phaseRef.current !== 'connecting') {
            setPhase('incoming')
            continue
          }
          const pc = await initPeer(signal.callId || callIdRef.current, config)
          if (!pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload))
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            await postSignal(callIdRef.current, 'ANSWER', answer)
            setPhase('connecting')
          }
        }

        if (signal.type === 'ANSWER' && initiatorRef.current) {
          const pc = pcRef.current
          if (pc && !pc.remoteDescription) {
            await pc.setRemoteDescription(new RTCSessionDescription(payload))
            setPhase('connecting')
          }
        }

        if (signal.type === 'ICE') {
          const pc = pcRef.current
          if (pc && payload?.candidate) {
            try { await pc.addIceCandidate(new RTCIceCandidate(payload)) } catch (e) { console.warn('ICE candidate skipped', e) }
          }
        }
      } catch (e: any) {
        console.error('apply voice signal error', e)
        setLastError(e.message || 'تعذر معالجة إشارة الاتصال')
      }
    }
  }, [closePeer, initPeer, postSignal, role])

  const pollCall = useCallback(async () => {
    if (!admissionId || busy) return
    try {
      const url = callIdRef.current
        ? `/api/supervisor/voice-call?callId=${encodeURIComponent(callIdRef.current)}`
        : `/api/supervisor/voice-call?admissionId=${encodeURIComponent(admissionId)}`
      const d = await api<VoicePayload>(url)
      if (!d.call) {
        if (phaseRef.current === 'incoming') setPhase('idle')
        if (phaseRef.current === 'idle') setCall(null)
        return
      }
      setCall(d.call)
      if (['ENDED', 'MISSED', 'DECLINED'].includes(d.call.status)) {
        setPhase('ended')
        closePeer(true)
        return
      }
      const incoming = d.call.status === 'RINGING' && d.call.initiatorRole !== role && !pcRef.current
      if (incoming && !acceptedRef.current) setPhase('incoming')
      if (pcRef.current || acceptedRef.current || initiatorRef.current) await applySignals(d.signals || [], d.rtcConfig)
    } catch (e: any) {
      console.error('voice poll error', e)
      setLastError(e.message || 'تعذر تحديث حالة المكالمة')
    }
  }, [admissionId, applySignals, busy, closePeer, role])

  useEffect(() => {
    pollCall()
    const timer = window.setInterval(pollCall, phase === 'connected' || phase === 'connecting' || phase === 'calling' ? 1400 : 2500)
    return () => window.clearInterval(timer)
  }, [pollCall, phase])

  useEffect(() => () => closePeer(true), [closePeer])

  const startCall = async () => {
    if (!admissionId) return
    setBusy(true)
    setLastError('')
    try {
      closePeer(true)
      processedRef.current.clear()
      initiatorRef.current = true
      acceptedRef.current = true
      setPhase('calling')
      const d = await api<VoicePayload>('/api/supervisor/voice-call', {
        method: 'POST',
        body: JSON.stringify({ action: 'create', admissionId }),
      })
      if (!d.call) throw new Error('لم يتم إنشاء المكالمة')
      setCall(d.call)
      callIdRef.current = d.call.id
      const pc = await initPeer(d.call.id, d.rtcConfig)
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await postSignal(d.call.id, 'OFFER', offer)
      setPhase('calling')
    } catch (e: any) {
      closePeer(true)
      initiatorRef.current = false
      acceptedRef.current = false
      setPhase('idle')
      toast({ title: 'تعذر بدء المكالمة', description: e.message || 'تحقق من الميكروفون والاتصال', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const acceptCall = async () => {
    if (!call?.id) return
    setBusy(true)
    setLastError('')
    try {
      acceptedRef.current = true
      initiatorRef.current = false
      setPhase('connecting')
      const d = await api<VoicePayload>('/api/supervisor/voice-call', {
        method: 'POST',
        body: JSON.stringify({ action: 'join', callId: call.id }),
      })
      setCall(d.call)
      callIdRef.current = d.call?.id || call.id
      await initPeer(call.id, d.rtcConfig)
      await applySignals(d.signals || [], d.rtcConfig)
    } catch (e: any) {
      acceptedRef.current = false
      setPhase('incoming')
      toast({ title: 'تعذر الانضمام للمكالمة', description: e.message || 'تحقق من صلاحية الميكروفون', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const endCall = async (reason = 'تم إنهاء المكالمة') => {
    const id = callIdRef.current || call?.id
    setBusy(true)
    try {
      if (id) {
        await api('/api/supervisor/voice-call', { method: 'POST', body: JSON.stringify({ action: 'end', callId: id, reason }) }).catch(() => null)
      }
    } finally {
      initiatorRef.current = false
      acceptedRef.current = false
      callIdRef.current = ''
      setCall(null)
      closePeer(true)
      setPhase('idle')
      setBusy(false)
    }
  }

  const declineCall = async () => {
    const id = callIdRef.current || call?.id
    setBusy(true)
    try {
      if (id) await api('/api/supervisor/voice-call', { method: 'POST', body: JSON.stringify({ action: 'decline', callId: id }) }).catch(() => null)
    } finally {
      acceptedRef.current = false
      callIdRef.current = ''
      setCall(null)
      setPhase('idle')
      setBusy(false)
    }
  }

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    localStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next })
  }

  const isLive = phase === 'connected' || phase === 'connecting' || phase === 'calling'
  const isIncoming = phase === 'incoming'

  return (
    <Card className="border-[#c9a227]/35 bg-gradient-to-br from-[#fffaf0] to-white shadow-sm">
      <CardContent className={compact ? 'p-3' : 'p-4'}>
        <audio ref={remoteAudioRef} autoPlay playsInline />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-[#0f2b46] text-[#e0b83a] hover:bg-[#0f2b46]"><RadioTower className="ml-1 h-3.5 w-3.5" /> صوت مباشر</Badge>
              <Badge className={phase === 'connected' ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : isIncoming ? 'bg-amber-100 text-amber-700 hover:bg-amber-100' : 'bg-slate-100 text-slate-600 hover:bg-slate-100'}>
                {statusArabic(phase, call)}
              </Badge>
            </div>
            <h4 className="mt-2 text-sm font-black text-[#0f2b46]">{title || (role === 'SUPERVISOR' ? 'مكالمة صوتية مباشرة مع الطالب' : 'مكالمة صوتية مباشرة مع المشرف')}</h4>
            <p className="mt-1 text-[11px] font-bold leading-5 text-slate-500">
              اتصال WebRTC مباشر. يعمل أفضل عند تفعيل TURN من إعدادات النظام، خصوصاً مع شبكات الجوال أو الإنترنت الضعيف.
            </p>
            {!rtcAvailable && <p className="mt-2 rounded-xl bg-red-50 p-2 text-[11px] font-bold text-red-700">متصفحك لا يدعم المكالمة الصوتية المباشرة أو لا يسمح بالميكروفون.</p>}
            {lastError && <p className="mt-2 rounded-xl bg-amber-50 p-2 text-[11px] font-bold text-amber-700">{lastError}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            {phase === 'idle' && (
              <Button onClick={startCall} disabled={busy || !rtcAvailable} className="bg-[#0f2b46] font-black text-[#e0b83a] hover:bg-[#12365c]">
                {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <PhoneCall className="ml-2 h-4 w-4" />}
                بدء مكالمة
              </Button>
            )}
            {isIncoming && (
              <>
                <Button onClick={acceptCall} disabled={busy || !rtcAvailable} className="bg-emerald-600 font-black text-white hover:bg-emerald-700">
                  {busy ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <PhoneIncoming className="ml-2 h-4 w-4" />}
                  انضمام
                </Button>
                <Button onClick={declineCall} disabled={busy} variant="outline" className="border-red-200 font-black text-red-600 hover:bg-red-50">
                  <PhoneOff className="ml-2 h-4 w-4" /> رفض
                </Button>
              </>
            )}
            {isLive && (
              <>
                <Button onClick={toggleMute} variant="outline" className="font-black">
                  {muted ? <MicOff className="ml-2 h-4 w-4" /> : <Mic className="ml-2 h-4 w-4" />}
                  {muted ? 'فتح الميكروفون' : 'كتم الميكروفون'}
                </Button>
                <Button onClick={() => endCall()} disabled={busy} variant="outline" className="border-red-200 font-black text-red-600 hover:bg-red-50">
                  <PhoneOff className="ml-2 h-4 w-4" /> إنهاء
                </Button>
              </>
            )}
            {phase === 'ended' && (
              <Button onClick={() => { setPhase('idle'); setCall(null); setLastError('') }} variant="outline" className="font-black">
                <Phone className="ml-2 h-4 w-4" /> مكالمة جديدة
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
