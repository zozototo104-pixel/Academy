'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { zonedTimeToUtc } from '@/lib/lectures/recurrence'
import { parseVideoUrl } from '@/lib/lectures/video-embed'
import {
  AlarmClock,
  CalendarPlus,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Video,
  XCircle,
} from 'lucide-react'

type ProgramOption = { id: string; titleAr: string; units?: { id: string; title: string }[] }
type SupervisorOption = { id: string; name: string; email?: string }
type SessionRow = {
  id: string
  title: string
  startsAt: string
  endsAt: string
  status: string
  provider: string
  deliveryMode: string
  meetingUrl: string | null
  meetingPasscode: string | null
  series: {
    title: string
    programId: string
    timezone: string
    supervisor: { name: string } | null
    program: { titleAr: string } | null
  }
  _count: { attendances: number }
}
type VideoRow = {
  id: string
  title: string
  source: string
  status: string
  programId: string
  sessionId: string | null
  order: number
  storageKey: string | null
  sizeBytes: number | null
  program: { titleAr: string } | null
  session: { title: string } | null
}
type AttendanceData = {
  attendances: { id: string; status: string; joinedAt: string; user: { id: string; name: string; email: string } }[]
  enrolledStudents: { id: string; name: string; email: string }[]
}

const STATUS_META: Record<string, { label: string; className: string }> = {
  SCHEDULED: { label: 'مجدولة', className: 'bg-blue-100 text-blue-800' },
  LIVE: { label: 'جارية', className: 'bg-green-100 text-green-800' },
  ENDED: { label: 'منتهية', className: 'bg-slate-100 text-slate-600' },
  CANCELLED: { label: 'ملغاة', className: 'bg-red-100 text-red-700' },
  RESCHEDULED: { label: 'مؤجلة', className: 'bg-amber-100 text-amber-800' },
}

const VIDEO_SOURCES = ['YOUTUBE', 'VIMEO', 'DRIVE', 'FACEBOOK', 'DAILYMOTION', 'LOOM', 'BUNNY', 'CLOUDFLARE', 'MP4', 'HLS', 'S3', 'EXTERNAL']

function fmtWhen(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('ar', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timeZone || undefined,
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

const selectClass = 'h-9 rounded-md border border-slate-300 bg-white px-2 text-sm'
const labelClass = 'mb-1 block text-xs font-bold text-slate-600'

export function AdminLectures() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [disabled, setDisabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [videos, setVideos] = useState<VideoRow[]>([])
  const [storageConfigured, setStorageConfigured] = useState(false)
  const [uploadMaxBytes, setUploadMaxBytes] = useState(0)
  const [programs, setPrograms] = useState<ProgramOption[]>([])
  const [supervisors, setSupervisors] = useState<SupervisorOption[]>([])
  const [filterProgram, setFilterProgram] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [videoOpen, setVideoOpen] = useState(false)
  const [editSession, setEditSession] = useState<SessionRow | null>(null)
  const [postponeSession, setPostponeSession] = useState<SessionRow | null>(null)
  const [attendanceSession, setAttendanceSession] = useState<SessionRow | null>(null)
  const [attendance, setAttendance] = useState<AttendanceData | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (filterProgram) params.set('programId', filterProgram)
      if (filterStatus) params.set('status', filterStatus)
      const [ses, vid, prog] = await Promise.all([
        api<{ sessions: SessionRow[] }>(`/api/admin/lectures/sessions/list?${params.toString()}`),
        api<{ videos: VideoRow[]; storageConfigured?: boolean; uploadMaxBytes?: number }>('/api/admin/lectures/videos/list'),
        api<{ programs: ProgramOption[] }>('/api/programs?public=1').catch(() => ({ programs: [] as ProgramOption[] })),
      ])
      setSessions(ses.sessions || [])
      setVideos(vid.videos || [])
      setStorageConfigured(Boolean(vid.storageConfigured))
      setUploadMaxBytes(vid.uploadMaxBytes ?? 0)
      setPrograms(prog.programs || [])
      setDisabled(false)
      setError(null)
    } catch (e: any) {
      if (e?.status === 404) setDisabled(true)
      else setError('تعذر تحميل بيانات المحاضرات.')
    } finally {
      setLoading(false)
    }
  }, [filterProgram, filterStatus])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    api<{ supervisors: SupervisorOption[] }>('/api/admin/supervisors')
      .then((r) => setSupervisors(r.supervisors || []))
      .catch(() => setSupervisors([]))
    return () => window.clearTimeout(timer)
  }, [load])

  const act = useCallback(
    async (fn: () => Promise<unknown>, success: string) => {
      setBusy(true)
      try {
        await fn()
        toast({ title: success })
        await load()
      } catch (e: any) {
        toast({ title: 'حدث خطأ', description: e?.message || 'حاول مجددًا', variant: 'destructive' })
      } finally {
        setBusy(false)
      }
    },
    [load, toast],
  )

  const openAttendance = useCallback(
    async (s: SessionRow) => {
      setAttendanceSession(s)
      setAttendance(null)
      try {
        const data = await api<AttendanceData>(`/api/admin/lectures/sessions/${s.id}/attendance`)
        setAttendance(data)
      } catch (e: any) {
        toast({ title: 'تعذر تحميل الحضور', description: e?.message, variant: 'destructive' })
      }
    },
    [toast],
  )

  const attendanceByUser = useMemo(() => {
    const map = new Map<string, string>()
    for (const a of attendance?.attendances || []) map.set(a.user.id, a.status)
    return map
  }, [attendance])

  if (loading && !sessions.length && !videos.length) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل المحاضرات...
      </div>
    )
  }
  if (disabled) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-slate-600">
          ميزة المحاضرات غير مفعّلة حاليًا على السيرفر. فعّل <span dir="ltr">LECTURES_ENABLED</span> لبدء استخدامها.
        </CardContent>
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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-black text-slate-800">المحاضرات واللقاءات</h2>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="ml-1 h-4 w-4" /> تحديث
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="ml-1 h-4 w-4" /> محاضرة جديدة
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <select className={selectClass} value={filterProgram} onChange={(e) => setFilterProgram(e.target.value)}>
          <option value="">كل البرامج</option>
          {programs.map((p) => (
            <option key={p.id} value={p.id}>
              {p.titleAr}
            </option>
          ))}
        </select>
        <select className={selectClass} value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)}>
          <option value="">كل الحالات</option>
          {Object.entries(STATUS_META).map(([key, meta]) => (
            <option key={key} value={key}>
              {meta.label}
            </option>
          ))}
        </select>
      </div>

      <Card>
        <CardContent className="py-3">
          {sessions.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">لا توجد لقاءات مطابقة.</p>
          ) : (
            sessions.map((s) => {
              const meta = STATUS_META[s.status] ?? STATUS_META.SCHEDULED
              return (
                <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 py-3 last:border-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-bold text-slate-800">{s.title}</span>
                      <Badge className={meta.className}>{meta.label}</Badge>
                      <span className="text-[11px] text-slate-400">محاولات دخول: {s._count.attendances}</span>
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {fmtWhen(s.startsAt, s.series.timezone)} • {s.series.program?.titleAr ?? ''} • {s.series.supervisor?.name ?? ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button variant="ghost" size="sm" onClick={() => void openAttendance(s)}>
                      <ClipboardCheck className="ml-1 h-4 w-4" /> الحضور
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditSession(s)}>
                      <Pencil className="ml-1 h-4 w-4" /> تعديل
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || s.status === 'CANCELLED' || s.status === 'RESCHEDULED'}
                      onClick={() => setPostponeSession(s)}
                    >
                      <AlarmClock className="ml-1 h-4 w-4" /> تأجيل
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy || s.status === 'CANCELLED'}
                      className="text-red-600"
                      onClick={() => {
                        if (window.confirm(`إلغاء محاضرة «${s.title}»؟ سيُشعر الطلاب فورًا.`)) {
                          void act(() => api(`/api/admin/lectures/sessions/${s.id}/cancel`, { method: 'POST' }), 'أُلغيت المحاضرة وأُشعر الطلاب')
                        }
                      }}
                    >
                      <XCircle className="ml-1 h-4 w-4" /> إلغاء
                    </Button>
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="py-3">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-black text-slate-800">التسجيلات والفيديوهات</h3>
            <Button size="sm" variant="outline" onClick={() => setVideoOpen(true)}>
              <Video className="ml-1 h-4 w-4" /> إضافة فيديو
            </Button>
          </div>
          <p className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            يفضّل استخدام فيديوهات YouTube غير المدرجة (Unlisted) بدل العامة. للمحتوى المدفوع، الرفع المباشر إلى التخزين الخاص أكثر
            ملاءمة، مع العلم أنه لا يمنع تصوير الشاشة بشكل مطلق.
          </p>
          {videos.length === 0 ? (
            <p className="py-4 text-center text-sm text-slate-500">لا توجد فيديوهات بعد.</p>
          ) : (
            videos.map((v, idx) => {
              const unconfirmedUpload =
                v.source === 'S3' && Boolean(v.storageKey?.startsWith('lectures/videos/')) && v.sizeBytes == null
              return (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 py-2.5 last:border-0">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-slate-800">{v.title}</span>
                    <Badge className={v.status === 'PUBLISHED' ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'}>
                      {v.status === 'PUBLISHED' ? 'منشور' : 'مسودة'}
                    </Badge>
                    {unconfirmedUpload && <Badge className="bg-amber-100 text-amber-800">بانتظار اكتمال الرفع</Badge>}
                    <span className="text-[11px] text-slate-400">{v.source}</span>
                  </div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    {v.program?.titleAr ?? ''}
                    {v.session ? ` • مرتبط بلقاء: ${v.session.title}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    className={selectClass}
                    value={v.sessionId ?? ''}
                    onChange={(e) => {
                      const sessionId = e.target.value || null
                      void act(
                        () => api(`/api/admin/lectures/videos/${v.id}`, { method: 'PATCH', body: JSON.stringify({ sessionId }) }),
                        'تم تحديث ربط الفيديو',
                      )
                    }}
                  >
                    <option value="">غير مرتبط بلقاء</option>
                    {sessions
                      .filter((s) => s.series.programId === v.programId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.title} — {fmtWhen(s.startsAt, s.series.timezone)}
                        </option>
                      ))}
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || idx === 0}
                    title="نقل لأعلى"
                    onClick={() => {
                      const other = videos[idx - 1]
                      if (!other) return
                      void act(async () => {
                        await api(`/api/admin/lectures/videos/${v.id}`, { method: 'PATCH', body: JSON.stringify({ order: other.order }) })
                        await api(`/api/admin/lectures/videos/${other.id}`, { method: 'PATCH', body: JSON.stringify({ order: v.order }) })
                      }, 'تمت إعادة الترتيب')
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || idx === videos.length - 1}
                    title="نقل لأسفل"
                    onClick={() => {
                      const other = videos[idx + 1]
                      if (!other) return
                      void act(async () => {
                        await api(`/api/admin/lectures/videos/${v.id}`, { method: 'PATCH', body: JSON.stringify({ order: other.order }) })
                        await api(`/api/admin/lectures/videos/${other.id}`, { method: 'PATCH', body: JSON.stringify({ order: v.order }) })
                      }, 'تمت إعادة الترتيب')
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant={v.status === 'PUBLISHED' ? 'outline' : 'default'}
                    disabled={busy || (v.status !== 'PUBLISHED' && unconfirmedUpload)}
                    onClick={() =>
                      void act(
                        () =>
                          api(`/api/admin/lectures/videos/${v.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ status: v.status === 'PUBLISHED' ? 'DRAFT' : 'PUBLISHED' }),
                          }),
                        v.status === 'PUBLISHED' ? 'أُعيد الفيديو مسودة' : 'نُشر الفيديو',
                      )
                    }
                  >
                    {v.status === 'PUBLISHED' ? 'إلغاء النشر' : 'نشر'}
                  </Button>
                </div>
              </div>
              )
            })
          )}
        </CardContent>
      </Card>

      <CreateSeriesDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        programs={programs}
        supervisors={supervisors}
        onSubmit={async (payload) => {
          await act(() => api('/api/admin/lectures/series', { method: 'POST', body: JSON.stringify(payload) }), 'أُنشئت المحاضرة')
          setCreateOpen(false)
        }}
      />
      <CreateVideoDialog
        open={videoOpen}
        onClose={() => setVideoOpen(false)}
        programs={programs}
        storageConfigured={storageConfigured}
        uploadMaxBytes={uploadMaxBytes}
        onUploaded={() => void load()}
        onSubmit={async (payload) => {
          await act(() => api('/api/admin/lectures/videos', { method: 'POST', body: JSON.stringify(payload) }), 'أُضيف الفيديو كمسودة')
          setVideoOpen(false)
        }}
      />
      {editSession && (
        <EditSessionDialog
          session={editSession}
          onClose={() => setEditSession(null)}
          onSubmit={async (payload) => {
            await act(
              () => api(`/api/admin/lectures/sessions/${editSession.id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
              'حُدّث اللقاء',
            )
            setEditSession(null)
          }}
        />
      )}
      {postponeSession && (
        <PostponeDialog
          session={postponeSession}
          onClose={() => setPostponeSession(null)}
          onSubmit={async (startsAtIso) => {
            await act(
              () => api(`/api/admin/lectures/sessions/${postponeSession.id}/postpone`, { method: 'POST', body: JSON.stringify({ startsAt: startsAtIso }) }),
              'أُجّل اللقاء وأُشعر الطلاب',
            )
            setPostponeSession(null)
          }}
        />
      )}
      <Dialog open={Boolean(attendanceSession)} onOpenChange={(o) => !o && setAttendanceSession(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>حضور: {attendanceSession?.title}</DialogTitle>
          </DialogHeader>
          {!attendance ? (
            <div className="flex items-center gap-2 py-6 text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" /> جارٍ التحميل...
            </div>
          ) : (
            <div className="max-h-[60vh] space-y-1 overflow-y-auto">
              {attendance.enrolledStudents.length === 0 && <p className="py-4 text-sm text-slate-500">لا يوجد طلاب مسجلون في البرنامج.</p>}
              {attendance.enrolledStudents.map((student) => {
                const status = attendanceByUser.get(student.id)
                return (
                  <div key={student.id} className="flex items-center justify-between gap-2 border-b border-slate-100 py-2">
                    <div>
                      <div className="text-sm font-bold text-slate-800">{student.name}</div>
                      <div className="text-[11px] text-slate-400">
                        {status === 'PRESENT' ? 'مؤكد الحضور' : status === 'ABSENT' ? 'غائب' : status === 'JOINED' ? 'دخل ولم يُؤكَّد بعد' : 'لم يدخل'}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="sm"
                        variant={status === 'PRESENT' ? 'default' : 'outline'}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`/api/admin/lectures/sessions/${attendanceSession!.id}/attendance`, {
                              method: 'PATCH',
                              body: JSON.stringify({ userId: student.id, status: 'PRESENT' }),
                            })
                            await openAttendance(attendanceSession!)
                          }, 'أُكّد الحضور')
                        }
                      >
                        <CheckCircle2 className="ml-1 h-4 w-4" /> حاضر
                      </Button>
                      <Button
                        size="sm"
                        variant={status === 'ABSENT' ? 'destructive' : 'outline'}
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(`/api/admin/lectures/sessions/${attendanceSession!.id}/attendance`, {
                              method: 'PATCH',
                              body: JSON.stringify({ userId: student.id, status: 'ABSENT' }),
                            })
                            await openAttendance(attendanceSession!)
                          }, 'سُجّل غائبًا')
                        }
                      >
                        <XCircle className="ml-1 h-4 w-4" /> غائب
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function CreateSeriesDialog({
  open,
  onClose,
  programs,
  supervisors,
  onSubmit,
}: {
  open: boolean
  onClose: () => void
  programs: ProgramOption[]
  supervisors: SupervisorOption[]
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [form, setForm] = useState({
    title: '',
    programId: '',
    unitId: '',
    supervisorId: '',
    timezone: 'Asia/Gaza',
    durationMin: 60,
    deliveryMode: 'EXTERNAL_LINK',
    provider: 'ZOOM',
    meetingUrl: '',
    meetingPasscode: '',
    recurring: false,
    startDate: '',
    timeOfDay: '18:00',
    endDate: '',
    occurrenceCount: 12,
  })
  const units = useMemo(() => programs.find((p) => p.id === form.programId)?.units ?? [], [programs, form.programId])
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }))

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>محاضرة جديدة</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto pr-1">
          <div className="col-span-2">
            <label className={labelClass}>العنوان</label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="عنوان المحاضرة" />
          </div>
          <div>
            <label className={labelClass}>البرنامج</label>
            <select className={`${selectClass} w-full`} value={form.programId} onChange={(e) => set('programId', e.target.value)}>
              <option value="">اختر البرنامج</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.titleAr}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>الوحدة (اختياري)</label>
            <select className={`${selectClass} w-full`} value={form.unitId} onChange={(e) => set('unitId', e.target.value)}>
              <option value="">بدون وحدة</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.title}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>المشرف المسؤول</label>
            <select className={`${selectClass} w-full`} value={form.supervisorId} onChange={(e) => set('supervisorId', e.target.value)}>
              <option value="">أنا (المستخدم الحالي)</option>
              {supervisors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass}>المنطقة الزمنية</label>
            <Input value={form.timezone} onChange={(e) => set('timezone', e.target.value)} dir="ltr" />
          </div>
          <div>
            <label className={labelClass}>تاريخ أول لقاء</label>
            <Input type="date" value={form.startDate} onChange={(e) => set('startDate', e.target.value)} dir="ltr" />
          </div>
          <div>
            <label className={labelClass}>الوقت</label>
            <Input type="time" value={form.timeOfDay} onChange={(e) => set('timeOfDay', e.target.value)} dir="ltr" />
          </div>
          <div>
            <label className={labelClass}>المدة (دقيقة)</label>
            <Input type="number" min={5} max={600} value={form.durationMin} onChange={(e) => set('durationMin', Number(e.target.value))} dir="ltr" />
          </div>
          <div>
            <label className={labelClass}>نوع اللقاء</label>
            <select className={`${selectClass} w-full`} value={form.deliveryMode} onChange={(e) => set('deliveryMode', e.target.value)}>
              <option value="EXTERNAL_LINK">مباشر برابط خارجي</option>
              <option value="RECORDED_ONLY">مسجل فقط</option>
            </select>
          </div>
          {form.deliveryMode === 'EXTERNAL_LINK' && (
            <>
              <div>
                <label className={labelClass}>المزود</label>
                <select className={`${selectClass} w-full`} value={form.provider} onChange={(e) => set('provider', e.target.value)}>
                  <option value="ZOOM">Zoom</option>
                  <option value="MEET">Google Meet</option>
                  <option value="TEAMS">Teams</option>
                  <option value="OTHER">رابط آخر</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>رمز الدخول (اختياري)</label>
                <Input value={form.meetingPasscode} onChange={(e) => set('meetingPasscode', e.target.value)} dir="ltr" />
              </div>
              <div className="col-span-2">
                <label className={labelClass}>رابط الاجتماع</label>
                <Input value={form.meetingUrl} onChange={(e) => set('meetingUrl', e.target.value)} dir="ltr" placeholder="https://..." />
                <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                  تنبيه: إخفاء الرابط هنا لا يكفي لحماية اللقاء — فعّل غرفة الانتظار وكلمة المرور من إعدادات مزود الاجتماع نفسه
                  (Zoom أو Meet أو Teams).
                </p>
              </div>
            </>
          )}
          <div className="col-span-2 flex items-center gap-2">
            <input type="checkbox" id="lec-recurring" checked={form.recurring} onChange={(e) => set('recurring', e.target.checked)} />
            <label htmlFor="lec-recurring" className="text-sm font-bold text-slate-700">
              تتكرر أسبوعيًا في نفس اليوم والوقت
            </label>
          </div>
          {form.recurring && (
            <>
              <div>
                <label className={labelClass}>عدد اللقاءات</label>
                <Input type="number" min={1} max={52} value={form.occurrenceCount} onChange={(e) => set('occurrenceCount', Number(e.target.value))} dir="ltr" />
              </div>
              <div>
                <label className={labelClass}>أو تاريخ الانتهاء</label>
                <Input type="date" value={form.endDate} onChange={(e) => set('endDate', e.target.value)} dir="ltr" />
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={!form.title || !form.programId || !form.startDate}
            onClick={() =>
              void onSubmit({
                title: form.title,
                programId: form.programId,
                ...(form.unitId ? { unitId: form.unitId } : {}),
                ...(form.supervisorId ? { supervisorId: form.supervisorId } : {}),
                timezone: form.timezone,
                durationMin: form.durationMin,
                deliveryMode: form.deliveryMode,
                provider: form.provider,
                ...(form.meetingUrl ? { meetingUrl: form.meetingUrl } : {}),
                ...(form.meetingPasscode ? { meetingPasscode: form.meetingPasscode } : {}),
                recurring: form.recurring,
                startDate: form.startDate,
                timeOfDay: form.timeOfDay,
                ...(form.recurring && form.endDate ? { endDate: form.endDate } : {}),
                ...(form.recurring ? { occurrenceCount: form.occurrenceCount } : {}),
              })
            }
          >
            <CalendarPlus className="ml-1 h-4 w-4" /> إنشاء
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CreateVideoDialog({
  open,
  onClose,
  programs,
  storageConfigured,
  uploadMaxBytes,
  onSubmit,
  onUploaded,
}: {
  open: boolean
  onClose: () => void
  programs: ProgramOption[]
  storageConfigured: boolean
  uploadMaxBytes: number
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
  onUploaded: () => void
}) {
  const { toast } = useToast()
  const [mode, setMode] = useState<'link' | 'upload'>('link')
  const [form, setForm] = useState({ title: '', programId: '', source: '', url: '' })
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState(0)
  const xhrRef = useRef<XMLHttpRequest | null>(null)
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }))

  const detected = useMemo(() => (form.url.trim() ? parseVideoUrl(form.url.trim()) : null), [form.url])
  const effectiveSource = form.source || detected?.source || ''

  const startUpload = async () => {
    if (!file || !form.title || !form.programId) return
    setUploading(true)
    setProgress(0)
    try {
      const init = await api<{ video: { id: string }; uploadUrl: string }>('/api/admin/lectures/videos/upload/init', {
        method: 'POST',
        body: JSON.stringify({ title: form.title, programId: form.programId, mimeType: file.type, sizeBytes: file.size }),
      })
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhrRef.current = xhr
        xhr.open('PUT', init.uploadUrl)
        xhr.setRequestHeader('Content-Type', file.type)
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100))
        }
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`HTTP ${xhr.status}`)))
        xhr.onerror = () => reject(new Error('network'))
        xhr.onabort = () => reject(new Error('aborted'))
        xhr.send(file)
      })
      await api('/api/admin/lectures/videos/upload/confirm', {
        method: 'POST',
        body: JSON.stringify({ videoId: init.video.id }),
      })
      toast({ title: 'اكتمل الرفع وتم تأكيده — الفيديو مسودة بانتظار النشر' })
      onUploaded()
      onClose()
    } catch (e: any) {
      if (e?.message !== 'aborted') {
        toast({ title: 'تعذر إكمال الرفع', description: e?.message || 'حاول مجددًا', variant: 'destructive' })
      }
    } finally {
      setUploading(false)
      xhrRef.current = null
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>إضافة فيديو (مسودة)</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className={labelClass}>العنوان</label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>البرنامج</label>
            <select className={`${selectClass} w-full`} value={form.programId} onChange={(e) => set('programId', e.target.value)}>
              <option value="">اختر البرنامج</option>
              {programs.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.titleAr}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={mode === 'link' ? 'default' : 'outline'} onClick={() => setMode('link')}>
              برابط
            </Button>
            <Button size="sm" variant={mode === 'upload' ? 'default' : 'outline'} onClick={() => setMode('upload')}>
              برفع ملف
            </Button>
          </div>

          {mode === 'link' && (
            <>
              <div>
                <label className={labelClass}>رابط الفيديو — الصقه وسيُكتشف نوعه تلقائيًا</label>
                <Input value={form.url} onChange={(e) => set('url', e.target.value)} dir="ltr" placeholder="https://..." />
                {form.url.trim() &&
                  (detected ? (
                    <p className="mt-1 text-[11px] font-bold text-green-700">
                      اكتُشف: {detected.source}
                      {detected.embedId ? ` — ${detected.embedId}` : ''}
                    </p>
                  ) : (
                    <p className="mt-1 text-[11px] font-bold text-red-600">الرابط غير آمن أو غير صالح (https فقط، بلا بيانات دخول).</p>
                  ))}
              </div>
              {detected?.thumbnailUrl && (
                <img src={detected.thumbnailUrl} alt="معاينة" className="h-24 rounded-md border border-slate-200 object-cover" />
              )}
              {detected?.embedUrl && (
                <div className="aspect-video w-full overflow-hidden rounded-md bg-black">
                  <iframe className="h-full w-full" src={detected.embedUrl} title="معاينة الفيديو" allowFullScreen />
                </div>
              )}
              <div>
                <label className={labelClass}>المصدر (يُملأ تلقائيًا، ويمكن تجاوزه)</label>
                <select className={`${selectClass} w-full`} value={effectiveSource} onChange={(e) => set('source', e.target.value)}>
                  <option value="">تلقائي</option>
                  {VIDEO_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              {effectiveSource === 'S3' && (
                <p className="rounded-md bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                  فيديوهات التخزين الخاص تُنشأ من وضع «رفع ملف» حصرًا — لا تُدخل مفاتيح تخزين يدويًا.
                </p>
              )}
              <p className="text-[11px] text-slate-500">يُحفظ الفيديو مسودة لا يراها الطلاب حتى تنشره بعد المعاينة.</p>
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={onClose}>
                  إلغاء
                </Button>
                <Button
                  disabled={
                    !form.title || !form.programId || !form.url || !detected || effectiveSource === 'S3'
                  }
                  onClick={() =>
                    void onSubmit({
                      title: form.title,
                      programId: form.programId,
                      ...(effectiveSource ? { source: effectiveSource } : {}),
                      url: form.url,
                    })
                  }
                >
                  إضافة كمسودة
                </Button>
              </div>
            </>
          )}

          {mode === 'upload' &&
            (storageConfigured ? (
              <>
                <div>
                  <label className={labelClass}>
                    ملف الفيديو (MP4 أو WebM أو MOV — حتى {Math.floor(uploadMaxBytes / (1024 * 1024))} ميغابايت)
                  </label>
                  <Input
                    type="file"
                    accept="video/mp4,video/webm,video/quicktime"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    dir="ltr"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    يذهب الملف من متصفحك مباشرة إلى التخزين الخاص، ولا يُنشر إلا بعد أن يتحقق السيرفر من وصوله وسلامته.
                  </p>
                </div>
                {uploading && (
                  <div className="space-y-1">
                    <div className="h-2 w-full overflow-hidden rounded bg-slate-200">
                      <div className="h-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
                    </div>
                    <p className="text-[11px] text-slate-500">جارٍ الرفع... {progress}%</p>
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" onClick={onClose} disabled={uploading}>
                    إغلاق
                  </Button>
                  {uploading ? (
                    <Button
                      variant="destructive"
                      onClick={() => {
                        xhrRef.current?.abort()
                      }}
                    >
                      إلغاء الرفع
                    </Button>
                  ) : (
                    <Button disabled={!file || !form.title || !form.programId} onClick={() => void startUpload()}>
                      بدء الرفع
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
                الرفع المباشر غير متاح: التخزين الخاص غير مهيأ على السيرفر. يمكنك إضافة الفيديوهات بروابط بدلًا من ذلك.
              </p>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EditSessionDialog({
  session,
  onClose,
  onSubmit,
}: {
  session: SessionRow
  onClose: () => void
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
}) {
  const [form, setForm] = useState({
    title: session.title,
    description: '',
    provider: session.provider,
    meetingUrl: session.meetingUrl ?? '',
    meetingPasscode: session.meetingPasscode ?? '',
  })
  const set = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }))
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>تعديل اللقاء</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className={labelClass}>العنوان</label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>الوصف</label>
            <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>رابط الاجتماع</label>
            <Input value={form.meetingUrl} onChange={(e) => set('meetingUrl', e.target.value)} dir="ltr" />
            <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
              إخفاء الرابط هنا لا يكفي — فعّل غرفة الانتظار وكلمة المرور من إعدادات مزود الاجتماع نفسه.
            </p>
          </div>
          <div>
            <label className={labelClass}>رمز الدخول</label>
            <Input value={form.meetingPasscode} onChange={(e) => set('meetingPasscode', e.target.value)} dir="ltr" />
          </div>
          <p className="text-[11px] text-slate-500">تغيير الموعد يتم من زر «تأجيل» حصرًا حتى يُشعر الطلاب ويبقى السجل واضحًا.</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            onClick={() =>
              void onSubmit({
                title: form.title,
                description: form.description || null,
                provider: form.provider,
                meetingUrl: form.meetingUrl || null,
                meetingPasscode: form.meetingPasscode || null,
              })
            }
          >
            حفظ
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PostponeDialog({
  session,
  onClose,
  onSubmit,
}: {
  session: SessionRow
  onClose: () => void
  onSubmit: (startsAtIso: string) => Promise<void>
}) {
  const [local, setLocal] = useState('')
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>تأجيل: {session.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-slate-600">
            الموعد الحالي: {fmtWhen(session.startsAt, session.series.timezone)}. سيبقى اللقاء الحالي موسومًا «مؤجلًا» ويُنشأ لقاء
            بديل بالموعد الجديد، ويُشعر الطلاب فورًا.
          </p>
          <div>
            <label className={labelClass}>الموعد الجديد (بتوقيت {session.series.timezone})</label>
            <Input type="datetime-local" value={local} onChange={(e) => setLocal(e.target.value)} dir="ltr" />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button
            disabled={!local}
            onClick={() => {
              // يُفسَّر الموعد المدخل بمنطقة السلسلة الزمنية نفسها (لا بتوقيت
              // جهاز المدير) حتى يطابق ما يراه الطلاب.
              const [datePart, timePart] = local.split('T')
              if (datePart && timePart) {
                void onSubmit(zonedTimeToUtc(datePart, timePart.slice(0, 5), session.series.timezone).toISOString())
              }
            }}
          >
            تأجيل وإشعار الطلاب
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
