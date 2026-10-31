'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, useAppStore } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { LecturePlayer } from '@/components/aact/LecturePlayer'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlarmClock,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  Clock,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  User,
  Video,
  XCircle,
} from 'lucide-react'

type PublicSession = {
  id: string
  title: string
  description: string | null
  programTitle: string | null
  supervisorName: string | null
  startsAt: string
  endsAt: string
  deliveryMode: string
  provider: string
  status: string
  canJoin: boolean
  joinOpensAt: string
}

type VideoItem = {
  id: string
  title: string
  description: string | null
  source: string
  embedId: string | null
  thumbnailUrl: string | null
  durationSec: number | null
  progress: { positionSec: number; watchedPercent: number; completedAt: string | null } | null
}

type WatchDescriptor = {
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

const STATUS_META: Record<string, { label: string; className: string }> = {
  SCHEDULED: { label: 'قادمة', className: 'bg-blue-100 text-blue-800' },
  LIVE: { label: 'جارية الآن', className: 'bg-green-100 text-green-800' },
  ENDED: { label: 'منتهية', className: 'bg-slate-100 text-slate-600' },
  CANCELLED: { label: 'ملغاة', className: 'bg-red-100 text-red-700' },
  RESCHEDULED: { label: 'مؤجلة', className: 'bg-amber-100 text-amber-800' },
}

function localStatus(s: PublicSession, now: number): string {
  if (s.status === 'CANCELLED' || s.status === 'RESCHEDULED') return s.status
  const start = new Date(s.startsAt).getTime()
  const end = new Date(s.endsAt).getTime()
  if (now < start) return 'SCHEDULED'
  if (now <= end) return 'LIVE'
  return 'ENDED'
}

function localCanJoin(s: PublicSession, now: number): boolean {
  if (s.deliveryMode !== 'EXTERNAL_LINK' || s.status === 'CANCELLED') return false
  return now >= new Date(s.joinOpensAt).getTime() && now <= new Date(s.endsAt).getTime()
}

function fmtWhen(iso: string): string {
  try {
    return new Intl.DateTimeFormat('ar', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

function fmtDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'الآن'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const rest = totalSec % 86400
  const clock = fmtDuration(rest)
  return days > 0 ? `${days} يوم و ${clock}` : clock
}

export function StudentLectures() {
  const { toast } = useToast()
  const user = useAppStore((s) => s.user)
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<PublicSession[]>([])
  const [videos, setVideos] = useState<VideoItem[]>([])
  const [joiningId, setJoiningId] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [activeWatch, setActiveWatch] = useState<{ video: VideoItem; watch: WatchDescriptor } | null>(null)

  const fetchAll = useCallback(async () => {
    const [lec, vid] = await Promise.all([
      api<{ sessions: PublicSession[] }>('/api/my/lectures'),
      api<{ videos: VideoItem[] }>('/api/my/lecture-videos').catch(() => ({ videos: [] as VideoItem[] })),
    ])
    return { sessions: lec.sessions || [], videos: vid.videos || [] }
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchAll()
      setSessions(data.sessions)
      setVideos(data.videos)
      setUnavailable(false)
      setError(null)
    } catch (e: any) {
      if (e?.status === 404) setUnavailable(true)
      else setError('تعذر تحميل المحاضرات. تحقق من اتصالك وحاول مجددًا.')
    } finally {
      setLoading(false)
    }
  }, [fetchAll])

  const refreshSilently = useCallback(() => {
    fetchAll()
      .then((data) => {
        setSessions(data.sessions)
        setVideos(data.videos)
      })
      .catch(() => {})
  }, [fetchAll])

  useEffect(() => {
    let cancelled = false
    fetchAll()
      .then((data) => {
        if (cancelled) return
        setSessions(data.sessions)
        setVideos(data.videos)
        setLoading(false)
      })
      .catch((e: any) => {
        if (cancelled) return
        if (e?.status === 404) setUnavailable(true)
        else setError('تعذر تحميل المحاضرات. تحقق من اتصالك وحاول مجددًا.')
        setLoading(false)
      })
    const refresh = setInterval(refreshSilently, 60_000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      cancelled = true
      clearInterval(refresh)
      clearInterval(tick)
    }
  }, [fetchAll, refreshSilently])

  const join = useCallback(
    async (s: PublicSession) => {
      setJoiningId(s.id)
      try {
        const res = await api<{ meetingUrl: string; meetingPasscode?: string | null }>(
          `/api/my/lectures/${s.id}/join`,
          { method: 'POST' },
        )
        window.open(res.meetingUrl, '_blank', 'noopener')
        toast({
          title: 'تم تسجيل دخولك إلى المحاضرة',
          description: res.meetingPasscode ? `رمز الدخول: ${res.meetingPasscode}` : 'انضممت بنجاح. المشرف يؤكد الحضور الفعلي.',
        })
      } catch (e: any) {
        toast({ title: 'تعذر الانضمام', description: e?.message || 'حاول مجددًا بعد قليل', variant: 'destructive' })
      } finally {
        setJoiningId(null)
      }
    },
    [toast],
  )

  const saveProgress = useCallback(async (videoId: string, positionSec: number, watchedPercent: number) => {
    try {
      await api(`/api/my/lecture-videos/${videoId}/progress`, {
        method: 'PUT',
        body: JSON.stringify({ positionSec: Math.floor(positionSec), watchedPercent: Math.floor(watchedPercent) }),
      })
    } catch {
      // حفظ التقدم أفضل جهد ممكن؛ فشله لا يقاطع المشاهدة
    }
  }, [])

  const openVideo = useCallback(
    async (video: VideoItem) => {
      try {
        const watch = await api<WatchDescriptor>(`/api/my/lecture-videos/${video.id}/watch`, { method: 'POST' })
        if (watch.kind === 'external') {
          if (watch.url) window.open(watch.url, '_blank', 'noopener')
          return
        }
        setActiveWatch({ video, watch })
      } catch (e: any) {
        toast({ title: 'تعذر فتح الفيديو', description: e?.message || 'حاول مجددًا', variant: 'destructive' })
      }
    },
    [toast],
  )

  const markWatched = useCallback(
    async (video: VideoItem) => {
      await saveProgress(video.id, video.durationSec ?? video.progress?.positionSec ?? 0, 100)
      toast({ title: 'تم تسجيل إتمام المشاهدة' })
      refreshSilently()
    },
    [saveProgress, toast, refreshSilently],
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل المحاضرات...
      </div>
    )
  }
  if (unavailable) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-slate-500">المحاضرات غير متاحة لبرامجك حاليًا.</CardContent>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <XCircle className="h-8 w-8 text-red-400" />
          <p className="text-slate-600">{error}</p>
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="ml-1 h-4 w-4" /> حاول مجددًا
          </Button>
        </CardContent>
      </Card>
    )
  }

  const upcoming = sessions.filter((s) => {
    const st = localStatus(s, now)
    return st === 'SCHEDULED' || st === 'LIVE' || st === 'RESCHEDULED'
  })
  const past = sessions
    .filter((s) => {
      const st = localStatus(s, now)
      return st === 'ENDED' || st === 'CANCELLED'
    })
    .reverse()
  const next = upcoming.find((s) => localStatus(s, now) !== 'RESCHEDULED') ?? upcoming[0] ?? null
  const nextStatus = next ? localStatus(next, now) : null
  const nextCanJoin = next ? localCanJoin(next, now) : false

  const joinButton = (s: PublicSession, big = false) => {
    if (s.deliveryMode !== 'EXTERNAL_LINK') {
      return <span className="text-xs text-slate-500">محاضرة مسجلة — تتوفر في التسجيلات</span>
    }
    const can = localCanJoin(s, now)
    return (
      <div className="flex flex-col items-start gap-1">
        <Button size={big ? 'default' : 'sm'} disabled={!can || joiningId === s.id} onClick={() => void join(s)}>
          {joiningId === s.id ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Video className="ml-1 h-4 w-4" />}
          انضم إلى المحاضرة
        </Button>
        {!can && localStatus(s, now) === 'SCHEDULED' && (
          <span className="flex items-center gap-1 text-[11px] text-slate-500">
            <AlarmClock className="h-3 w-3" /> يفتح الانضمام قبل الموعد بـ 15 دقيقة
          </span>
        )}
      </div>
    )
  }

  const sessionRow = (s: PublicSession) => {
    const st = localStatus(s, now)
    const meta = STATUS_META[st] ?? STATUS_META.SCHEDULED
    return (
      <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-0">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-slate-800">{s.title}</span>
            <Badge className={meta.className}>{meta.label}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span className="flex items-center gap-1">
              <CalendarDays className="h-3.5 w-3.5" /> {fmtWhen(s.startsAt)}
            </span>
            {s.supervisorName && (
              <span className="flex items-center gap-1">
                <User className="h-3.5 w-3.5" /> {s.supervisorName}
              </span>
            )}
            {s.programTitle && <span>{s.programTitle}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href={`/api/my/lectures/${s.id}/ics`} download>
            <Button variant="ghost" size="sm" title="أضف إلى تقويمك">
              <CalendarPlus className="h-4 w-4" />
            </Button>
          </a>
          {(st === 'SCHEDULED' || st === 'LIVE') && joinButton(s)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {next ? (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardContent className="space-y-3 py-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-blue-900">المحاضرة القادمة</span>
              <Badge className={(STATUS_META[nextStatus ?? 'SCHEDULED'] ?? STATUS_META.SCHEDULED).className}>
                {(STATUS_META[nextStatus ?? 'SCHEDULED'] ?? STATUS_META.SCHEDULED).label}
              </Badge>
            </div>
            <h3 className="text-xl font-black text-slate-900">{next.title}</h3>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600">
              <span className="flex items-center gap-1">
                <CalendarDays className="h-4 w-4" /> {fmtWhen(next.startsAt)}
              </span>
              {next.supervisorName && (
                <span className="flex items-center gap-1">
                  <User className="h-4 w-4" /> {next.supervisorName}
                </span>
              )}
              {next.programTitle && <span>{next.programTitle}</span>}
            </div>
            <div className="flex items-center gap-2 text-lg font-black text-blue-900" dir="rtl">
              <Clock className="h-5 w-5" />
              {nextStatus === 'LIVE' ? (
                <span>جارية الآن — تنتهي خلال {fmtCountdown(new Date(next.endsAt).getTime() - now)}</span>
              ) : (
                <span>تبدأ خلال {fmtCountdown(new Date(next.startsAt).getTime() - now)}</span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {joinButton(next, true)}
              <a href={`/api/my/lectures/${next.id}/ics`} download>
                <Button variant="outline" size="sm">
                  <CalendarPlus className="ml-1 h-4 w-4" /> أضف إلى تقويمك
                </Button>
              </a>
              {!nextCanJoin && nextStatus === 'SCHEDULED' && <span className="text-xs text-slate-500">الرابط لا يظهر قبل فتح نافذة الانضمام حمايةً للمحاضرة.</span>}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-slate-500">لا توجد محاضرات قادمة في برامجك حاليًا.</CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-4">
          <h3 className="mb-2 text-base font-black text-slate-800">جدول المحاضرات</h3>
          {upcoming.length === 0 && past.length === 0 && (
            <p className="py-4 text-center text-sm text-slate-500">لا توجد محاضرات بعد.</p>
          )}
          {upcoming.map(sessionRow)}
          {past.length > 0 && (
            <>
              <h4 className="mb-1 mt-4 text-sm font-bold text-slate-500">المحاضرات السابقة</h4>
              {past.map(sessionRow)}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-4">
          <h3 className="mb-3 text-base font-black text-slate-800">التسجيلات</h3>
          {activeWatch && (
            <div className="mb-4 space-y-2">
              <LecturePlayer
                descriptor={activeWatch.watch}
                title={activeWatch.video.title}
                watermark={
                  user?.name || user?.email
                    ? `${user?.name ?? ''}${user?.email ? ` • ${user.email}` : ''}`
                    : null
                }
                onProgress={(positionSec, watchedPercent) => {
                  void saveProgress(activeWatch.video.id, positionSec, watchedPercent)
                }}
                onEnded={() => void markWatched(activeWatch.video)}
                onRenew={async () => {
                  try {
                    return await api<WatchDescriptor>(`/api/my/lecture-videos/${activeWatch.video.id}/watch`, {
                      method: 'POST',
                    })
                  } catch {
                    return null
                  }
                }}
              />
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-700">{activeWatch.video.title}</span>
                <Button variant="outline" size="sm" onClick={() => void markWatched(activeWatch.video)}>
                  <CheckCircle2 className="ml-1 h-4 w-4" /> تمت المشاهدة
                </Button>
              </div>
            </div>
          )}
          {videos.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">لا توجد تسجيلات منشورة بعد.</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {videos.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => void openVideo(v)}
                  className="overflow-hidden rounded-lg border border-slate-200 text-right transition hover:border-blue-300 hover:shadow-sm"
                >
                  <div className="relative aspect-video bg-slate-100">
                    {v.thumbnailUrl ? (
                      <img src={v.thumbnailUrl} alt={v.title} className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-400">
                        <Play className="h-10 w-10" />
                      </div>
                    )}
                    {v.durationSec ? (
                      <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-bold text-white" dir="ltr">
                        {fmtDuration(v.durationSec)}
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-1 p-3">
                    <div className="line-clamp-2 text-sm font-bold text-slate-800">{v.title}</div>
                    {v.progress && v.progress.watchedPercent > 0 && (
                      <>
                        <div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
                          <div className="h-full bg-blue-500" style={{ width: `${Math.min(100, v.progress.watchedPercent)}%` }} />
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {v.progress.completedAt
                            ? 'اكتملت المشاهدة'
                            : `شاهدت ${Math.floor(v.progress.watchedPercent)}% — أكمل من ${fmtDuration(v.progress.positionSec)}`}
                        </div>
                      </>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
          <p className="mt-3 flex items-center gap-1 text-[11px] text-slate-400">
            <ExternalLink className="h-3 w-3" /> بعض الفيديوهات الخارجية تفتح عند مزودها الأصلي.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
