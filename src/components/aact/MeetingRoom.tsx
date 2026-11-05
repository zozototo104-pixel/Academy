'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Loader2, Mic, MicOff, PhoneOff, ShieldAlert, Video, VideoOff, Wifi, WifiOff,
} from 'lucide-react'

// ===== غرفة فيديو الاجتماع الداخلية (WebRTC mesh) =====
// النواة الناقلة منسوخة من قاعة المناقشة المجرّبة (DefenseRoom):
// خريطة اتصالات RTCPeerConnection + إشارات عبر قاعدة البيانات
// باستطلاع كل ثانيتين + أصغر معرّف يبادر بالعرض لتفادي التضارب.
// بلا أي دلالات مناقشة: لا رسالة، لا لجنة، لا تسجيل، لا خبير ذكاء.

const ICE_SERVERS_FALLBACK: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
]

type PeerMeta = { peerId: string; name: string }
type RoomSignal = { id: string; from: string; to?: string | null; type: string; payload: any }

function RemoteVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (ref.current && stream) {
      ref.current.srcObject = stream
      ref.current.play().catch(() => {})
    }
  }, [stream])
  return <video ref={ref} autoPlay playsInline className="h-full w-full object-cover" />
}

export function MeetingRoom({
  token,
  displayName,
  onLeave,
}: {
  token: string
  displayName?: string
  onLeave?: () => void
}) {
  const [participants, setParticipants] = useState<PeerMeta[]>([])
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [peerStates, setPeerStates] = useState<Record<string, string>>({})
  const [connected, setConnected] = useState(false)
  const [joining, setJoining] = useState(true)
  const [fatalError, setFatalError] = useState<string | null>(null)
  const [mediaError, setMediaError] = useState(false)
  const [windowClosed, setWindowClosed] = useState(false)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [hasStream, setHasStream] = useState(false)

  const myName = String(displayName || 'مشارك في الاجتماع').slice(0, 80)
  const myPeerId = useRef<string>('')
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map())
  const processedSignalIdsRef = useRef<Set<string>>(new Set())
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const iceServersRef = useRef<RTCIceServer[]>(ICE_SERVERS_FALLBACK)
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const leftRef = useRef(false)

  const roomUrl = `/api/meetings/${encodeURIComponent(token)}/room`

  const roomPost = useCallback(
    async (body: Record<string, any>): Promise<any> => {
      const res = await fetch(roomUrl, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const err = new Error(data?.error || `HTTP ${res.status}`) as Error & { code?: string; status?: number }
        err.code = data?.code ? String(data.code) : undefined
        err.status = res.status
        throw err
      }
      return data
    },
    [roomUrl],
  )

  const sendSignal = useCallback(
    async (type: string, payload: any, to?: string | null) => {
      try {
        await roomPost({ action: 'signal', peerId: myPeerId.current, type, payload, toPeer: to || null })
      } catch { /* best-effort */ }
    },
    [roomPost],
  )

  const closePeer = useCallback((remotePeerId: string) => {
    const pc = peersRef.current.get(remotePeerId)
    if (pc) {
      try { pc.close() } catch { /* best-effort */ }
      peersRef.current.delete(remotePeerId)
    }
    pendingIceRef.current.delete(remotePeerId)
    setRemoteStreams((prev) => {
      if (!(remotePeerId in prev)) return prev
      const n = { ...prev }
      delete n[remotePeerId]
      return n
    })
    setPeerStates((prev) => {
      if (!(remotePeerId in prev)) return prev
      const n = { ...prev }
      delete n[remotePeerId]
      return n
    })
  }, [])

  const getOrCreatePeer = useCallback(
    async (remotePeerId: string, initiator: boolean): Promise<RTCPeerConnection> => {
      let pc = peersRef.current.get(remotePeerId)
      if (pc) return pc
      pc = new RTCPeerConnection({ iceServers: iceServersRef.current })
      peersRef.current.set(remotePeerId, pc)

      streamRef.current?.getTracks().forEach((t) => {
        try { pc!.addTrack(t, streamRef.current!) } catch { /* best-effort */ }
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
        setPeerStates((prev) => ({ ...prev, [remotePeerId]: pc!.connectionState }))
        if (['failed', 'closed'].includes(pc.connectionState)) closePeer(remotePeerId)
      }

      if (initiator) {
        try {
          const offer = await pc.createOffer()
          await pc.setLocalDescription(offer)
          sendSignal('OFFER', { sdp: pc.localDescription }, remotePeerId)
        } catch { /* best-effort */ }
      }
      return pc
    },
    [sendSignal, closePeer],
  )

  const flushIce = useCallback(async (remotePeerId: string, pc: RTCPeerConnection) => {
    const queue = pendingIceRef.current.get(remotePeerId) || []
    for (const c of queue) {
      try { await pc.addIceCandidate(c) } catch { /* best-effort */ }
    }
    pendingIceRef.current.delete(remotePeerId)
  }, [])

  const processSignals = useCallback(
    async (signals: RoomSignal[]) => {
      for (const sig of signals) {
        if (processedSignalIdsRef.current.has(sig.id)) continue
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
              try { await pc.addIceCandidate(sig.payload) } catch { /* best-effort */ }
            } else {
              const q = pendingIceRef.current.get(sig.from) || []
              q.push(sig.payload)
              pendingIceRef.current.set(sig.from, q)
            }
          } else if (sig.type === 'BYE') {
            closePeer(sig.from)
          }
          processedSignalIdsRef.current.add(sig.id)
        } catch { /* best-effort */ }
      }
    },
    [getOrCreatePeer, sendSignal, flushIce, closePeer],
  )

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollRef.current) return
    const tick = async () => {
      try {
        await roomPost({ action: 'heartbeat', peerId: myPeerId.current })
        const res = await fetch(`${roomUrl}?peerId=${encodeURIComponent(myPeerId.current)}`, { cache: 'no-store' })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (d?.code === 'JOIN_WINDOW_CLOSED') {
            setWindowClosed(true)
            stopPolling()
          }
          return
        }
        const metas: PeerMeta[] = Array.isArray(d.peersMeta)
          ? d.peersMeta
          : (d.peers || []).map((peerId: string) => ({ peerId, name: 'مشارك' }))
        setParticipants(metas)
        await processSignals(d.signals || [])
        // فتح اتصالات مع كل مشارك جديد (أصغر معرف يبادر بالعرض لتفادي التضارب)
        for (const p of metas) {
          if (p.peerId === myPeerId.current) continue
          if (!peersRef.current.has(p.peerId) && myPeerId.current < p.peerId) {
            getOrCreatePeer(p.peerId, true)
          }
        }
        // إغلاق اتصالات من غادروا
        const onlineIds = new Set(metas.map((p) => p.peerId))
        for (const pid of [...peersRef.current.keys()]) {
          if (!onlineIds.has(pid)) closePeer(pid)
        }
      } catch { /* best-effort */ }
    }
    pollRef.current = setInterval(tick, 2000)
    tick()
  }, [roomPost, roomUrl, processSignals, getOrCreatePeer, closePeer, stopPolling])

  // دخول الغرفة عند التركيب: وسائط محلية ثم انضمام ثم استطلاع
  useEffect(() => {
    let cancelled = false
    const join = async () => {
      myPeerId.current = 'p_' + Math.random().toString(36).slice(2, 10)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        setHasStream(true)
        setMicOn(stream.getAudioTracks().some((t) => t.enabled))
        setCamOn(stream.getVideoTracks().some((t) => t.enabled))
        setTimeout(() => {
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream
            localVideoRef.current.play().catch(() => {})
          }
        }, 200)
      } catch {
        if (!cancelled) setMediaError(true)
      }
      try {
        const joinRes = await roomPost({ action: 'join', peerId: myPeerId.current, name: myName })
        if (cancelled) return
        if (Array.isArray(joinRes?.iceServers) && joinRes.iceServers.length) {
          iceServersRef.current = joinRes.iceServers
        }
        setConnected(true)
        setJoining(false)
        startPolling()
      } catch (e: any) {
        if (cancelled) return
        setJoining(false)
        if (e?.code === 'JOIN_WINDOW_CLOSED') setWindowClosed(true)
        else setFatalError(e?.message || 'تعذر الانضمام إلى غرفة الاجتماع')
      }
    }
    join()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const leaveRoom = useCallback(
    async (notifyParent = true) => {
      if (leftRef.current) return
      leftRef.current = true
      stopPolling()
      peersRef.current.forEach((pc) => {
        try { pc.close() } catch { /* best-effort */ }
      })
      peersRef.current.clear()
      setRemoteStreams({})
      setPeerStates({})
      setParticipants([])
      setConnected(false)
      setHasStream(false)
      const pid = myPeerId.current
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (pid) {
        try {
          await fetch(roomUrl, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'leave', peerId: pid }),
          })
        } catch { /* best-effort */ }
        myPeerId.current = ''
      }
      if (notifyParent) onLeave?.()
    },
    [roomUrl, stopPolling, onLeave],
  )

  // تنظيف عند إزالة المكوّن (إغلاق التبويب/التنقل) — مغادرة صامتة
  useEffect(() => {
    const peersMap = peersRef.current
    return () => {
      if (leftRef.current) return
      leftRef.current = true
      if (pollRef.current) clearInterval(pollRef.current)
      peersMap.forEach((pc) => {
        try { pc.close() } catch { /* best-effort */ }
      })
      peersMap.clear()
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      if (myPeerId.current) {
        try {
          fetch(roomUrl, {
            method: 'POST',
            keepalive: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'leave', peerId: myPeerId.current }),
          }).catch(() => {})
        } catch { /* best-effort */ }
      }
    }
  }, [roomUrl])

  const toggleMic = useCallback(() => {
    const tracks = streamRef.current?.getAudioTracks() || []
    if (!tracks.length) return
    const next = !tracks[0].enabled
    tracks.forEach((t) => { t.enabled = next })
    setMicOn(next)
  }, [])

  const toggleCam = useCallback(() => {
    const tracks = streamRef.current?.getVideoTracks() || []
    if (!tracks.length) return
    const next = !tracks[0].enabled
    tracks.forEach((t) => { t.enabled = next })
    setCamOn(next)
  }, [])

  if (fatalError) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-3xl bg-[#0b1c30] p-8 text-center" dir="rtl">
        <ShieldAlert className="h-10 w-10 text-red-400" />
        <p className="text-sm font-bold leading-relaxed text-white">{fatalError}</p>
        {onLeave && (
          <Button onClick={() => onLeave()} variant="secondary" className="font-black">
            عودة إلى صفحة الاجتماع
          </Button>
        )}
      </div>
    )
  }

  if (windowClosed) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-3xl bg-[#0b1c30] p-8 text-center" dir="rtl">
        <ShieldAlert className="h-10 w-10 text-[#c9a227]" />
        <p className="text-sm font-bold leading-relaxed text-white">
          أُغلقت غرفة الاجتماع — انتهى وقت الاجتماع أو لم يبدأ بعد (الدخول يفتح قبل الموعد بـ15 دقيقة).
        </p>
        {onLeave && (
          <Button onClick={() => onLeave()} variant="secondary" className="font-black">
            عودة إلى صفحة الاجتماع
          </Button>
        )}
      </div>
    )
  }

  const tiles: { peerId: string; name: string; stream: MediaStream | null; self?: boolean; state?: string }[] = [
    { peerId: 'self', name: `${myName} (أنت)`, stream: null, self: true },
    ...participants.map((p) => ({
      peerId: p.peerId,
      name: p.name || 'مشارك',
      stream: remoteStreams[p.peerId] || null,
      state: peerStates[p.peerId],
    })),
  ]

  return (
    <div className="rounded-3xl bg-[#0b1c30] p-3 sm:p-4" dir="rtl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2 text-white">
          {connected ? <Wifi className="h-4 w-4 text-emerald-400" /> : <WifiOff className="h-4 w-4 text-red-400" />}
          <span className="text-sm font-black">غرفة الاجتماع — داخل المنصة</span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-bold text-white/80">
            {participants.length + 1} مشارك
          </span>
        </div>
        {joining && (
          <span className="flex items-center gap-1.5 text-xs font-bold text-white/70">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ الاتصال…
          </span>
        )}
      </div>

      {mediaError && (
        <div className="mb-3 rounded-2xl bg-amber-500/15 px-4 py-3 text-xs font-bold leading-relaxed text-amber-200 ring-1 ring-amber-400/30">
          تعذّر تشغيل الكاميرا أو المايك (تحقق من صلاحيات المتصفح). أنت داخل الغرفة الآن بلا صوت وصورة من جهتك —
          يمكنك مشاهدة وسماع بقية المشاركين، وأعد تحميل الصفحة بعد منح الصلاحية لتظهر صورتك.
        </div>
      )}

      <div className={`grid gap-3 ${tiles.length > 1 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        {tiles.map((tile) => (
          <div key={tile.peerId} className="relative aspect-video overflow-hidden rounded-2xl bg-black ring-1 ring-white/15">
            {tile.self ? (
              <>
                <video ref={localVideoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
                {!hasStream && (
                  <div className="absolute inset-0 flex items-center justify-center text-xs font-bold text-white/60">
                    الكاميرا غير متاحة
                  </div>
                )}
              </>
            ) : tile.stream ? (
              <RemoteVideo stream={tile.stream} />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/60">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span className="text-xs font-bold">جارٍ الاتصال بالمشارك…</span>
              </div>
            )}
            <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] font-bold text-white">
              {tile.name}
              {!tile.self && tile.state === 'connected' && <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />}
              {!tile.self && tile.state && tile.state !== 'connected' && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center justify-center gap-3">
        <Button
          onClick={toggleMic}
          variant="secondary"
          className={`h-12 w-12 rounded-full p-0 ${micOn ? '' : 'bg-red-500 text-white hover:bg-red-600'}`}
          title={micOn ? 'كتم المايك' : 'تشغيل المايك'}
        >
          {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
        </Button>
        <Button
          onClick={toggleCam}
          variant="secondary"
          className={`h-12 w-12 rounded-full p-0 ${camOn ? '' : 'bg-red-500 text-white hover:bg-red-600'}`}
          title={camOn ? 'إيقاف الكاميرا' : 'تشغيل الكاميرا'}
        >
          {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </Button>
        <Button
          onClick={() => leaveRoom(true)}
          className="h-12 rounded-full bg-red-600 px-5 font-black text-white hover:bg-red-700"
        >
          <PhoneOff className="ml-2 h-5 w-5" /> مغادرة الغرفة
        </Button>
      </div>
    </div>
  )
}
