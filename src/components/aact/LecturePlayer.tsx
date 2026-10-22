'use client'

import { useEffect, useRef } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type LectureWatchDescriptor = {
  kind: 'file' | 'embed' | 'external'
  url?: string | null
  source?: string
  provider?: string | null
  embedId?: string | null
  embedUrl?: string | null
  mimeType?: string | null
  expiresInSec?: number
  resumePositionSec?: number
}

type PlayerProps = {
  descriptor: LectureWatchDescriptor
  title: string
  watermark?: string | null
  onProgress?: (positionSec: number, watchedPercent: number) => void
  onEnded?: () => void
  onRenew?: () => Promise<LectureWatchDescriptor | null>
}

// ---------------------------------------------------------------- YouTube
type YTPlayerInstance = {
  getCurrentTime: () => number
  getDuration: () => number
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void
  destroy: () => void
}
type YTNamespace = {
  Player: new (
    el: HTMLElement,
    opts: {
      videoId: string
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: (e: { target: YTPlayerInstance }) => void
        onStateChange?: (e: { data: number; target: YTPlayerInstance }) => void
      }
    },
  ) => YTPlayerInstance
  PlayerState: { PLAYING: number; ENDED: number }
}

let ytApiPromise: Promise<YTNamespace> | null = null
function loadYouTubeApi(): Promise<YTNamespace> {
  if (!ytApiPromise) {
    ytApiPromise = new Promise<YTNamespace>((resolve) => {
      const w = window as unknown as { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void }
      if (w.YT?.Player) {
        resolve(w.YT)
        return
      }
      const previous = w.onYouTubeIframeAPIReady
      w.onYouTubeIframeAPIReady = () => {
        previous?.()
        if (w.YT) resolve(w.YT)
      }
      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      document.head.appendChild(script)
    })
  }
  return ytApiPromise
}

function YouTubePlayer({ videoId, descriptor, onProgress, onEnded }: { videoId: string } & PlayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const callbacks = useRef({ onProgress, onEnded })
  useEffect(() => {
    callbacks.current = { onProgress, onEnded }
  })
  const resume = Math.max(0, Math.floor(descriptor.resumePositionSec ?? 0))

  useEffect(() => {
    let player: YTPlayerInstance | null = null
    let timer: number | null = null
    let cancelled = false
    void loadYouTubeApi().then((YT) => {
      if (cancelled || !hostRef.current) return
      player = new YT.Player(hostRef.current, {
        videoId,
        playerVars: { rel: 0, start: resume },
        events: {
          onStateChange: (e) => {
            if (e.data === YT.PlayerState.ENDED) {
              callbacks.current.onEnded?.()
              return
            }
            if (e.data === YT.PlayerState.PLAYING && timer === null) {
              timer = window.setInterval(() => {
                if (!player) return
                const duration = player.getDuration()
                if (duration > 0) {
                  callbacks.current.onProgress?.(player.getCurrentTime(), (player.getCurrentTime() / duration) * 100)
                }
              }, 5000)
            }
          },
        },
      })
    })
    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
      try {
        player?.destroy()
      } catch {
        // تجاهل: التنظيف أفضل جهد
      }
    }
    // يُعاد الإنشاء عند تغيّر الفيديو فقط؛ الاستئناف يُقرأ من الواصف الأول.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId])

  return <div ref={hostRef} className="h-full w-full" />
}

// ------------------------------------------------------------------ Vimeo
function VimeoPlayer({ descriptor, onProgress, onEnded }: PlayerProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const callbacks = useRef({ onProgress, onEnded })
  useEffect(() => {
    callbacks.current = { onProgress, onEnded }
  })
  const resume = Math.max(0, Math.floor(descriptor.resumePositionSec ?? 0))
  const src = descriptor.embedUrl ?? descriptor.url ?? undefined

  useEffect(() => {
    const post = (method: string, value?: unknown) => {
      frameRef.current?.contentWindow?.postMessage(JSON.stringify({ method, value }), 'https://player.vimeo.com')
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== 'https://player.vimeo.com') return
      let data: { event?: string; data?: { seconds?: number; duration?: number } }
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      } catch {
        return
      }
      if (data.event === 'ready') {
        post('addEventListener', 'playProgress')
        post('addEventListener', 'finish')
        if (resume > 0) post('setCurrentTime', resume)
      } else if (data.event === 'playProgress' && data.data) {
        const seconds = data.data.seconds ?? 0
        const duration = data.data.duration ?? 0
        if (duration > 0) callbacks.current.onProgress?.(seconds, (seconds / duration) * 100)
      } else if (data.event === 'finish') {
        callbacks.current.onEnded?.()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [resume])

  return (
    <iframe
      ref={frameRef}
      className="h-full w-full"
      src={src}
      title="Vimeo"
      allow="autoplay; encrypted-media; picture-in-picture"
      allowFullScreen
    />
  )
}

// ------------------------------------------------------------------- File
function FilePlayer({ descriptor, onProgress, onEnded, onRenew }: PlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const callbacks = useRef({ onProgress, onEnded, onRenew })
  useEffect(() => {
    callbacks.current = { onProgress, onEnded, onRenew }
  })
  const lastReport = useRef(0)
  const srcRef = useRef(descriptor.url ?? null)
  const isHls =
    descriptor.source === 'HLS' ||
    descriptor.mimeType === 'application/x-mpegURL' ||
    Boolean(descriptor.url?.split('?')[0].endsWith('.m3u8'))

  useEffect(() => {
    const video = videoRef.current
    const src = srcRef.current
    if (!video || !src) return
    let cleanup: (() => void) | undefined
    if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
      void import('hls.js').then(({ default: Hls }) => {
        if (!Hls.isSupported()) {
          video.src = src
          return
        }
        const hls = new Hls()
        hls.loadSource(src)
        hls.attachMedia(video)
        cleanup = () => hls.destroy()
      })
    } else {
      video.src = src
    }
    return () => cleanup?.()
  }, [isHls])

  // تجديد آمن لرابط التخزين الموقّع قبل انتهائه، مع حفظ موضع التشغيل.
  useEffect(() => {
    if (!descriptor.expiresInSec || !onRenew) return
    const renewAfterMs = Math.max(60, descriptor.expiresInSec - 600) * 1000
    const timer = window.setTimeout(() => {
      void (async () => {
        const fresh = await callbacks.current.onRenew?.()
        const video = videoRef.current
        if (!fresh?.url || !video || fresh.url === srcRef.current) return
        const position = video.currentTime
        const wasPlaying = !video.paused
        srcRef.current = fresh.url
        video.src = fresh.url
        video.currentTime = position
        if (wasPlaying) void video.play().catch(() => undefined)
      })()
    }, renewAfterMs)
    return () => window.clearTimeout(timer)
  }, [descriptor.expiresInSec, onRenew])

  const report = (force = false) => {
    const video = videoRef.current
    if (!video || !(video.duration > 0)) return
    const nowMs = Date.now()
    if (!force && nowMs - lastReport.current < 5000) return
    lastReport.current = nowMs
    callbacks.current.onProgress?.(video.currentTime, (video.currentTime / video.duration) * 100)
  }

  return (
    <video
      ref={videoRef}
      className="h-full w-full"
      controls
      controlsList="nodownload"
      disablePictureInPicture
      playsInline
      onLoadedMetadata={(e) => {
        const resume = Math.max(0, Math.floor(descriptor.resumePositionSec ?? 0))
        if (resume > 0) e.currentTarget.currentTime = resume
      }}
      onTimeUpdate={() => report()}
      onPause={() => report(true)}
      onEnded={() => callbacks.current.onEnded?.()}
    />
  )
}

// ------------------------------------------------------------------ Shell
export function LecturePlayer(props: PlayerProps) {
  const { descriptor, title, watermark } = props

  if (descriptor.kind === 'external') {
    return (
      <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 rounded-lg bg-slate-900 text-white">
        <p className="px-4 text-center text-sm">هذا الفيديو يُعرض عند مزوّد خارجي.</p>
        {descriptor.url && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(descriptor.url ?? '', '_blank', 'noopener')}
          >
            <ExternalLink className="ml-1 h-4 w-4" /> افتح الفيديو
          </Button>
        )}
      </div>
    )
  }

  let inner: React.ReactNode
  if (descriptor.kind === 'embed' && descriptor.source === 'YOUTUBE' && descriptor.embedId) {
    inner = <YouTubePlayer videoId={descriptor.embedId} {...props} />
  } else if (descriptor.kind === 'embed' && descriptor.source === 'VIMEO') {
    inner = <VimeoPlayer {...props} />
  } else if (descriptor.kind === 'embed') {
    inner = (
      <iframe
        className="h-full w-full"
        src={descriptor.embedUrl ?? descriptor.url ?? undefined}
        title={title}
        allow="accelerometer; autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
      />
    )
  } else {
    inner = <FilePlayer {...props} />
  }

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
      {inner}
      {watermark && (
        <span className="pointer-events-none absolute bottom-2 left-2 z-10 rounded bg-black/40 px-2 py-0.5 text-[10px] text-white/80">
          {watermark}
        </span>
      )}
    </div>
  )
}
