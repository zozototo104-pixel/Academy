'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { zonedTimeToUtc } from '@/lib/lectures/recurrence'
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileText,
  Link2,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  UserPlus,
  Users,
  Video,
  XCircle,
} from 'lucide-react'

type Provider = 'ZOOM' | 'MEET' | 'TEAMS' | 'OTHER' | 'PLATFORM'
type EffectiveStatus = 'SCHEDULED' | 'LIVE' | 'ENDED' | 'CANCELLED'
type AttendanceStatus = 'JOINED' | 'PRESENT' | 'ABSENT'

type Meeting = {
  id: string
  title: string
  description: string | null
  agenda: string | null
  startsAt: string
  endsAt: string
  timezone: string
  provider: Provider
  meetingUrl: string | null
  meetingPasscode: string | null
  hostName: string | null
  status: string
  effectiveStatus: EffectiveStatus
  aiAssistantEnabled: boolean
  minutesEnabled: boolean
  inviteCount?: number
  attendanceCount?: number
  createdAt: string
}

type Invite = {
  id: string
  inviteeName: string
  inviteeEmail: string | null
  claimed: boolean
  claimedByName?: string | null
  opened: boolean
  revoked: boolean
  expired: boolean
  createdAt: string
}

type Attendance = {
  userId: string
  userName?: string | null
  status: AttendanceStatus
  joinedAt: string
  confirmedAt: string | null
}

type MeetingDetail = {
  meeting: Meeting
  invites: Invite[]
  attendance: Attendance[]
}

type InviteLink = { inviteeName: string; url: string }

const PROVIDER_LABELS: Record<Provider, string> = {
  ZOOM: 'Zoom',
  MEET: 'Google Meet',
  TEAMS: 'Microsoft Teams',
  OTHER: 'رابط آخر',
  PLATFORM: 'غرفة المنصة الداخلية',
}

const STATUS_META: Record<EffectiveStatus, { label: string; className: string }> = {
  SCHEDULED: { label: 'مجدول', className: 'bg-blue-100 text-blue-800' },
  LIVE: { label: 'جارٍ الآن', className: 'bg-green-100 text-green-800' },
  ENDED: { label: 'منتهٍ', className: 'bg-slate-100 text-slate-600' },
  CANCELLED: { label: 'ملغى', className: 'bg-red-100 text-red-700' },
}

const ATTENDANCE_META: Record<AttendanceStatus, { label: string; className: string }> = {
  JOINED: { label: 'انضم', className: 'bg-sky-100 text-sky-800' },
  PRESENT: { label: 'حاضر', className: 'bg-green-100 text-green-800' },
  ABSENT: { label: 'غائب', className: 'bg-red-100 text-red-700' },
}

const TIMEZONES: { value: string; label: string }[] = [
  { value: 'Asia/Gaza', label: 'غزة (Asia/Gaza)' },
  { value: 'Africa/Cairo', label: 'القاهرة (Africa/Cairo)' },
  { value: 'Asia/Riyadh', label: 'الرياض (Asia/Riyadh)' },
  { value: 'Asia/Dubai', label: 'دبي (Asia/Dubai)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'لندن (Europe/London)' },
  { value: 'America/New_York', label: 'نيويورك (America/New_York)' },
]

const FILTERS: { key: EffectiveStatus | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'الكل' },
  { key: 'SCHEDULED', label: 'مجدول' },
  { key: 'LIVE', label: 'جارٍ الآن' },
  { key: 'ENDED', label: 'منتهٍ' },
  { key: 'CANCELLED', label: 'ملغى' },
]

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

function fmtTime(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('ar', { hour: '2-digit', minute: '2-digit', timeZone: timeZone || undefined }).format(new Date(iso))
  } catch {
    return iso
  }
}

// ISO instant -> "YYYY-MM-DDTHH:mm" wall-clock value in the given timezone (for datetime-local inputs)
function toLocalInputValue(iso: string, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(iso))
    const get = (t: string) => parts.find((p) => p.type === t)?.value || ''
    const hour = get('hour') === '24' ? '00' : get('hour')
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`
  } catch {
    return ''
  }
}

// datetime-local wall-clock value in the given timezone -> UTC ISO instant
function localInputToIso(value: string, timeZone: string): string {
  const [date, time] = value.split('T')
  return zonedTimeToUtc(date, time || '00:00', timeZone).toISOString()
}

function inviteState(inv: Invite): { label: string; className: string } {
  if (inv.revoked) return { label: 'ملغاة', className: 'bg-red-100 text-red-700' }
  if (inv.expired) return { label: 'منتهية', className: 'bg-slate-100 text-slate-500' }
  if (inv.claimed) return { label: 'مستلمة', className: 'bg-green-100 text-green-800' }
  if (inv.opened) return { label: 'فُتحت', className: 'bg-amber-100 text-amber-800' }
  return { label: 'لم تُستلم', className: 'bg-blue-100 text-blue-800' }
}

const selectClass = 'h-9 rounded-md border border-slate-300 bg-white px-2 text-sm'
const labelClass = 'mb-1 block text-xs font-bold text-slate-600'

type MeetingFormValues = {
  title: string
  description: string
  agenda: string
  startLocal: string
  endLocal: string
  timezone: string
  provider: Provider
  meetingUrl: string
  meetingPasscode: string
  hostName: string
  aiAssistantEnabled: boolean
  minutesEnabled: boolean
  invitees: { name: string; email: string }[]
}

function initialFormValues(meeting: Meeting | null): MeetingFormValues {
  if (meeting) {
    return {
      title: meeting.title,
      description: meeting.description || '',
      agenda: meeting.agenda || '',
      startLocal: toLocalInputValue(meeting.startsAt, meeting.timezone),
      endLocal: toLocalInputValue(meeting.endsAt, meeting.timezone),
      timezone: meeting.timezone || 'Asia/Gaza',
      provider: meeting.provider,
      meetingUrl: meeting.meetingUrl || '',
      meetingPasscode: meeting.meetingPasscode || '',
      hostName: meeting.hostName || '',
      aiAssistantEnabled: Boolean(meeting.aiAssistantEnabled),
      minutesEnabled: Boolean(meeting.minutesEnabled),
      invitees: [],
    }
  }
  const tz = 'Asia/Gaza'
  const now = Date.now()
  return {
    title: '',
    description: '',
    agenda: '',
    startLocal: toLocalInputValue(new Date(now + 60 * 60_000).toISOString(), tz),
    endLocal: toLocalInputValue(new Date(now + 2 * 60 * 60_000).toISOString(), tz),
    timezone: tz,
    provider: 'ZOOM',
    meetingUrl: '',
    meetingPasscode: '',
    hostName: '',
    aiAssistantEnabled: false,
    minutesEnabled: false,
    invitees: [{ name: '', email: '' }],
  }
}

function MeetingFormDialog({
  meeting,
  onClose,
  onSubmit,
}: {
  meeting: Meeting | null // null = اجتماع جديد
  onClose: () => void
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
}) {
  const isEdit = Boolean(meeting)
  const [form, setForm] = useState<MeetingFormValues>(() => initialFormValues(meeting))
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof MeetingFormValues>(key: K, value: MeetingFormValues[K]) =>
    setForm((f) => ({ ...f, [key]: value }))
  const isExternal = form.provider !== 'PLATFORM'

  const setInvitee = (idx: number, key: 'name' | 'email', value: string) =>
    setForm((f) => ({ ...f, invitees: f.invitees.map((inv, i) => (i === idx ? { ...inv, [key]: value } : inv)) }))

  const submit = async () => {
    setFormError(null)
    if (!form.title.trim()) {
      setFormError('عنوان الاجتماع مطلوب.')
      return
    }
    if (!form.startLocal || !form.endLocal) {
      setFormError('حدّد وقت بداية الاجتماع ونهايته.')
      return
    }
    const startsAt = localInputToIso(form.startLocal, form.timezone)
    const endsAt = localInputToIso(form.endLocal, form.timezone)
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setFormError('وقت نهاية الاجتماع يجب أن يكون بعد وقت البداية.')
      return
    }
    const payload: Record<string, unknown> = {
      title: form.title.trim(),
      startsAt,
      endsAt,
      timezone: form.timezone,
      provider: form.provider,
      aiAssistantEnabled: form.aiAssistantEnabled,
      minutesEnabled: form.minutesEnabled,
    }
    if (form.description.trim()) payload.description = form.description.trim()
    if (form.agenda.trim()) payload.agenda = form.agenda.trim()
    if (form.hostName.trim()) payload.hostName = form.hostName.trim()
    if (isExternal) {
      if (form.meetingUrl.trim()) payload.meetingUrl = form.meetingUrl.trim()
      if (form.meetingPasscode.trim()) payload.meetingPasscode = form.meetingPasscode.trim()
    }
    if (!isEdit) {
      payload.invitees = form.invitees
        .filter((inv) => inv.name.trim())
        .map((inv) => ({ name: inv.name.trim(), ...(inv.email.trim() ? { email: inv.email.trim() } : {}) }))
    }
    setSaving(true)
    try {
      await onSubmit(payload)
    } catch (e: any) {
      setFormError(e?.message || 'تعذر حفظ الاجتماع.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'تعديل الاجتماع' : 'اجتماع جديد'}</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[70vh] grid-cols-2 gap-3 overflow-y-auto pr-1">
          <div className="col-span-2">
            <label className={labelClass}>عنوان الاجتماع *</label>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} placeholder="مثال: اجتماع مجلس الإدارة الشهري" />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>الوصف (اختياري)</label>
            <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2} placeholder="نبذة مختصرة عن الاجتماع" />
          </div>
          <div>
            <label className={labelClass}>يبدأ في *</label>
            <Input type="datetime-local" value={form.startLocal} onChange={(e) => set('startLocal', e.target.value)} dir="ltr" />
          </div>
          <div>
            <label className={labelClass}>ينتهي في *</label>
            <Input type="datetime-local" value={form.endLocal} onChange={(e) => set('endLocal', e.target.value)} dir="ltr" />
          </div>
          <div>
            <label className={labelClass}>المنطقة الزمنية</label>
            <select className={`${selectClass} w-full`} value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
              {!TIMEZONES.some((tz) => tz.value === form.timezone) && <option value={form.timezone}>{form.timezone}</option>}
            </select>
          </div>
          <div>
            <label className={labelClass}>المنظّم / المضيف</label>
            <Input value={form.hostName} onChange={(e) => set('hostName', e.target.value)} placeholder="اسم منظّم الاجتماع" />
          </div>
          <div className="col-span-2">
            <label className={labelClass}>مزود الاجتماع</label>
            <select className={`${selectClass} w-full`} value={form.provider} onChange={(e) => set('provider', e.target.value as Provider)}>
              <option value="ZOOM">Zoom</option>
              <option value="MEET">Google Meet</option>
              <option value="TEAMS">Microsoft Teams</option>
              <option value="OTHER">رابط آخر</option>
              <option value="PLATFORM">غرفة المنصة الداخلية</option>
            </select>
          </div>
          {isExternal ? (
            <>
              <div className="col-span-2">
                <label className={labelClass}>رابط الاجتماع</label>
                <Input value={form.meetingUrl} onChange={(e) => set('meetingUrl', e.target.value)} dir="ltr" placeholder="https://..." />
                <p className="mt-1 rounded-md bg-blue-50 px-2 py-1.5 text-[11px] text-blue-800">
                  يظهر هذا الرابط للمدعوين قبل بدء الاجتماع بـ15 دقيقة فقط، ولا يُعرض في صفحة الدعوة قبل ذلك.
                </p>
              </div>
              <div className="col-span-2">
                <label className={labelClass}>رمز الدخول (اختياري)</label>
                <Input value={form.meetingPasscode} onChange={(e) => set('meetingPasscode', e.target.value)} dir="ltr" />
              </div>
            </>
          ) : (
            <div className="col-span-2">
              <p className="rounded-md bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">
                سيُعقد الاجتماع داخل غرفة المنصة الداخلية — لا حاجة لرابط خارجي، ويدخل المدعوون من صفحة الدعوة مباشرة عند فتح باب الدخول.
              </p>
            </div>
          )}
          <div className="col-span-2">
            <label className={labelClass}>جدول الأعمال (اختياري)</label>
            <Textarea value={form.agenda} onChange={(e) => set('agenda', e.target.value)} rows={3} placeholder="بنود جدول الأعمال، بند في كل سطر" />
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="mtg-ai-assistant"
              checked={form.aiAssistantEnabled}
              onChange={(e) => set('aiAssistantEnabled', e.target.checked)}
            />
            <label htmlFor="mtg-ai-assistant" className="text-sm font-bold text-slate-700">
              تفعيل مساعد الاجتماع الذكي
            </label>
          </div>
          <div className="col-span-2">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="mtg-minutes"
                checked={form.minutesEnabled}
                onChange={(e) => set('minutesEnabled', e.target.checked)}
              />
              <label htmlFor="mtg-minutes" className="text-sm font-bold text-slate-700">
                تسجيل محضر الاجتماع
              </label>
            </div>
            {form.minutesEnabled && (
              <p className="mt-1 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
                تنبيه: تسجيل المحضر يتطلب إعلام المشاركين وموافقتهم قبل الاجتماع.
              </p>
            )}
          </div>
          {!isEdit && (
            <div className="col-span-2">
              <label className={labelClass}>المدعوون</label>
              <div className="space-y-2">
                {form.invitees.map((inv, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <Input
                      value={inv.name}
                      onChange={(e) => setInvitee(idx, 'name', e.target.value)}
                      placeholder="اسم المدعو"
                      className="flex-1"
                    />
                    <Input
                      value={inv.email}
                      onChange={(e) => setInvitee(idx, 'email', e.target.value)}
                      placeholder="البريد (اختياري)"
                      dir="ltr"
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setForm((f) => ({ ...f, invitees: f.invitees.filter((_, i) => i !== idx) }))}
                      disabled={form.invitees.length <= 1}
                      title="حذف المدعو"
                    >
                      <Trash2 className="h-4 w-4 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => setForm((f) => ({ ...f, invitees: [...f.invitees, { name: '', email: '' }] }))}
              >
                <UserPlus className="ml-1 h-4 w-4" /> إضافة مدعو
              </Button>
              <p className="mt-1 text-[11px] text-slate-500">
                لكل مدعو رابط دعوة خاص به يُعرض مرة واحدة فقط بعد إنشاء الاجتماع — انسخه وأرسله إليه.
              </p>
            </div>
          )}
          {formError && (
            <div className="col-span-2 rounded-md bg-red-50 px-3 py-2 text-xs font-bold text-red-700">{formError}</div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <Video className="ml-1 h-4 w-4" />}
            {isEdit ? 'حفظ التعديلات' : 'إنشاء الاجتماع'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// محضر الاجتماع: مسودة من جدول الأعمال وملاحظات المشاركين والحضور
// فقط، تُحرَّر بشريًا ثم تُقدَّم للمراجعة ثم تُعتمد — لا اعتماد آليًا.
function MeetingMinutesPanel({ meetingId }: { meetingId: string }) {
  const { toast } = useToast()
  const [minutes, setMinutes] = useState<any | null>(null)
  const [notes, setNotes] = useState<any[]>([])
  const [fields, setFields] = useState({ summary: '', decisions: '', actionItems: '', deferred: '' })
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api(`/api/admin/meetings/${meetingId}/minutes`)
        if (!alive) return
        setMinutes(res.minutes || null)
        setNotes(res.notes || [])
        if (res.minutes) {
          setFields({
            summary: res.minutes.summary || '',
            decisions: res.minutes.decisions || '',
            actionItems: res.minutes.actionItems || '',
            deferred: res.minutes.deferred || '',
          })
        }
      } catch { /* best-effort */ }
      if (alive) setLoaded(true)
    })()
    return () => {
      alive = false
    }
  }, [meetingId])

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true)
    try {
      const res = await api(`/api/admin/meetings/${meetingId}/minutes`, {
        method: 'POST',
        body: JSON.stringify({ action, ...extra }),
      })
      if (res.minutes) {
        setMinutes(res.minutes)
        setFields({
          summary: res.minutes.summary || '',
          decisions: res.minutes.decisions || '',
          actionItems: res.minutes.actionItems || '',
          deferred: res.minutes.deferred || '',
        })
      }
      toast({ title: 'تم', description: action === 'generate' ? 'وُلّدت مسودة المحضر من جدول الأعمال والملاحظات' : action === 'approve' ? 'اعتُمد المحضر' : 'حُفظ' })
    } catch (e: any) {
      toast({ title: 'تعذّر التنفيذ', description: e?.message || 'حدث خطأ', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const statusLabel: Record<string, string> = { DRAFT: 'مسودة', PENDING_REVIEW: 'بانتظار المراجعة', APPROVED: 'معتمد' }
  const locked = minutes?.status === 'APPROVED'

  return (
    <div className="rounded-md border border-teal-100 bg-teal-50 px-3 py-2.5">
      <h4 className="mb-1 flex items-center gap-1.5 text-sm font-black text-teal-900">
        <FileText className="h-4 w-4" /> محضر الاجتماع
        {minutes && <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-black text-teal-700 ring-1 ring-teal-200">{statusLabel[minutes.status] || minutes.status}</span>}
      </h4>
      <p className="mb-2 text-xs leading-6 text-teal-800">
        يُبنى من جدول الأعمال وملاحظات المشاركين المكتوبة داخل صفحة الاجتماع والحضور المسجل فقط — لا يُخترع فيه قرار أو اسم أو موعد. ملاحظات المشاركين حتى الآن: {notes.length}
      </p>
      {!loaded ? (
        <p className="text-xs text-teal-700">جارٍ التحميل…</p>
      ) : !minutes ? (
        <Button size="sm" disabled={busy} onClick={() => act('generate')} className="bg-teal-700 text-white hover:bg-teal-800">
          توليد مسودة المحضر
        </Button>
      ) : (
        <div className="space-y-2">
          {(['summary', 'decisions', 'actionItems', 'deferred'] as const).map((k) => (
            <div key={k}>
              <label className="mb-1 block text-[11px] font-black text-teal-900">
                {k === 'summary' ? 'ملخص النقاش' : k === 'decisions' ? 'القرارات المؤكدة' : k === 'actionItems' ? 'المهام (بأصحابها ومواعيدها كما وردت)' : 'النقاط المؤجلة'}
              </label>
              <textarea
                value={fields[k]}
                disabled={locked}
                onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
                rows={k === 'summary' ? 4 : 3}
                className="w-full rounded-md border border-teal-200 bg-white px-2.5 py-2 text-xs leading-6 outline-none focus:border-teal-500 disabled:bg-teal-100/50"
              />
            </div>
          ))}
          {locked ? (
            <p className="text-[11px] font-bold text-teal-700">هذا المحضر معتمد ومقفل{minutes.approvedAt ? ` — اعتُمد بتاريخ ${new Date(minutes.approvedAt).toLocaleString('ar')}` : ''}.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act('save', fields)}>حفظ التعديلات</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => act('generate')}>إعادة توليد المسودة</Button>
              {minutes.status === 'DRAFT' && (
                <Button size="sm" disabled={busy} onClick={() => act('submit')} className="bg-teal-700 text-white hover:bg-teal-800">تقديم للمراجعة</Button>
              )}
              {minutes.status === 'PENDING_REVIEW' && (
                <Button size="sm" disabled={busy} onClick={() => act('approve')} className="bg-emerald-700 text-white hover:bg-emerald-800">اعتماد المحضر نهائيًا</Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MeetingDetailsPanel({
  detail,
  busy,
  copyText,
  onRevokeInvite,
  onRotateInvite,
  onConfirmAttendance,
  onAddInvitee,
}: {
  detail: MeetingDetail
  busy: boolean
  copyText: (text: string) => Promise<void>
  onRevokeInvite: (invite: Invite) => void
  onConfirmAttendance: (userId: string, status: AttendanceStatus) => void
  onAddInvitee: (name: string, email: string) => Promise<string>
}) {
  const m = detail.meeting
  const [newName, setNewName] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [freshLink, setFreshLink] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const addInvitee = async () => {
    if (!newName.trim()) {
      setAddError('اسم المدعو مطلوب.')
      return
    }
    setAdding(true)
    setAddError(null)
    try {
      const url = await onAddInvitee(newName.trim(), newEmail.trim())
      setFreshLink(url)
      setNewName('')
      setNewEmail('')
    } catch (e: any) {
      setAddError(e?.message || 'تعذر إضافة الدعوة.')
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-4 border-t border-dashed border-slate-200 bg-slate-50/60 px-3 py-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div>
          <span className={labelClass}>الموعد</span>
          <p className="text-xs font-bold text-slate-700">
            {fmtWhen(m.startsAt, m.timezone)} ← {fmtTime(m.endsAt, m.timezone)}
          </p>
          <p className="text-[11px] text-slate-400" dir="ltr">
            {m.timezone}
          </p>
        </div>
        <div>
          <span className={labelClass}>المزود</span>
          <p className="text-xs font-bold text-slate-700">{PROVIDER_LABELS[m.provider] || m.provider}</p>
        </div>
        <div>
          <span className={labelClass}>المنظّم / المضيف</span>
          <p className="text-xs font-bold text-slate-700">{m.hostName || '—'}</p>
        </div>
        {m.description && (
          <div className="col-span-2 md:col-span-3">
            <span className={labelClass}>الوصف</span>
            <p className="whitespace-pre-wrap text-xs leading-6 text-slate-600">{m.description}</p>
          </div>
        )}
        {m.provider !== 'PLATFORM' && m.meetingUrl && (
          <div className="col-span-2 md:col-span-3">
            <span className={labelClass}>رابط الاجتماع (يظهر للمدعوين قبل البدء بـ15 دقيقة فقط)</span>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-[11px] text-slate-600">
                {m.meetingUrl}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyText(m.meetingUrl as string)}>
                <Copy className="ml-1 h-3.5 w-3.5" /> نسخ
              </Button>
            </div>
            {m.meetingPasscode && (
              <p className="mt-1 text-[11px] text-slate-500">
                رمز الدخول: <span dir="ltr" className="font-bold">{m.meetingPasscode}</span>
              </p>
            )}
          </div>
        )}
        {m.agenda && (
          <div className="col-span-2 md:col-span-3">
            <span className={labelClass}>جدول الأعمال</span>
            <p className="whitespace-pre-wrap text-xs leading-6 text-slate-600">{m.agenda}</p>
          </div>
        )}
        <div className="col-span-2 flex flex-wrap gap-2 md:col-span-3">
          <Badge className={m.aiAssistantEnabled ? 'bg-violet-100 text-violet-800' : 'bg-slate-100 text-slate-500'}>
            مساعد الاجتماع الذكي: {m.aiAssistantEnabled ? 'مفعّل' : 'غير مفعّل'}
          </Badge>
          <Badge className={m.minutesEnabled ? 'bg-teal-100 text-teal-800' : 'bg-slate-100 text-slate-500'}>
            محضر الاجتماع: {m.minutesEnabled ? 'مفعّل' : 'غير مفعّل'}
          </Badge>
        </div>
      </div>

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-black text-slate-700">
          <Users className="h-4 w-4" /> المدعوون ({detail.invites.length})
        </h4>
        {detail.invites.length === 0 ? (
          <p className="text-xs text-slate-500">لا توجد دعوات بعد — أضف أول مدعو من النموذج بالأسفل.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="px-3 py-2 font-bold">الاسم</th>
                  <th className="px-3 py-2 font-bold">البريد</th>
                  <th className="px-3 py-2 font-bold">حالة الدعوة</th>
                  <th className="px-3 py-2 font-bold">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {detail.invites.map((inv) => {
                  const st = inviteState(inv)
                  return (
                    <tr key={inv.id} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-2 font-bold text-slate-700">
                        {inv.inviteeName}
                        {inv.claimed && inv.claimedByName && inv.claimedByName !== inv.inviteeName && (
                          <span className="block text-[11px] font-normal text-slate-400">استلمها: {inv.claimedByName}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-500" dir="ltr">
                        {inv.inviteeEmail || '—'}
                      </td>
                      <td className="px-3 py-2">
                        <Badge className={st.className}>{st.label}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        {!inv.revoked && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="text-red-600 hover:text-red-700"
                            disabled={busy}
                            onClick={() => onRevokeInvite(inv)}
                          >
                            <Ban className="ml-1 h-3.5 w-3.5" /> إلغاء الدعوة
                          </Button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1">
            <label className={labelClass}>اسم مدعو جديد</label>
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="الاسم الكامل" />
          </div>
          <div className="min-w-40 flex-1">
            <label className={labelClass}>البريد (اختياري)</label>
            <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="name@mail.com" dir="ltr" />
          </div>
          <Button type="button" size="sm" disabled={adding || busy} onClick={() => void addInvitee()}>
            {adding ? <Loader2 className="ml-1 h-4 w-4 animate-spin" /> : <UserPlus className="ml-1 h-4 w-4" />} إضافة دعوة
          </Button>
        </div>
        {addError && <p className="mt-2 text-xs font-bold text-red-600">{addError}</p>}
        {freshLink && (
          <div className="mt-3 rounded-md bg-amber-50 px-3 py-2">
            <p className="mb-1 flex items-center gap-1 text-[11px] font-bold text-amber-800">
              <Link2 className="h-3.5 w-3.5" /> رابط الدعوة الجديد — يظهر مرة واحدة فقط، انسخه الآن وأرسله إلى المدعو:
            </p>
            <div className="flex items-center gap-2">
              <code dir="ltr" className="min-w-0 flex-1 truncate rounded bg-white px-2 py-1 text-[11px] text-slate-700">
                {freshLink}
              </code>
              <Button type="button" size="sm" variant="outline" onClick={() => void copyText(freshLink)}>
                <Copy className="ml-1 h-3.5 w-3.5" /> نسخ
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFreshLink(null)}>
                إخفاء
              </Button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-sm font-black text-slate-700">
          <CheckCircle2 className="h-4 w-4" /> الحضور ({detail.attendance.length})
        </h4>
        {detail.attendance.length === 0 ? (
          <p className="text-xs text-slate-500">لا توجد سجلات حضور بعد — تُسجَّل تلقائيًا عند دخول المدعوين إلى الاجتماع.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-200 bg-white">
            <table className="w-full text-right text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="px-3 py-2 font-bold">المشارك</th>
                  <th className="px-3 py-2 font-bold">الحالة</th>
                  <th className="px-3 py-2 font-bold">وقت الدخول</th>
                  <th className="px-3 py-2 font-bold">تأكيد الإدارة</th>
                </tr>
              </thead>
              <tbody>
                {detail.attendance.map((att) => {
                  const meta = ATTENDANCE_META[att.status] ?? ATTENDANCE_META.JOINED
                  return (
                    <tr key={att.userId} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-2 font-bold text-slate-700">{att.userName || att.userId}</td>
                      <td className="px-3 py-2">
                        <Badge className={meta.className}>{meta.label}</Badge>
                      </td>
                      <td className="px-3 py-2 text-slate-500">{fmtWhen(att.joinedAt, m.timezone)}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1">
                          <Button
                            type="button"
                            size="sm"
                            variant={att.status === 'PRESENT' ? 'default' : 'outline'}
                            className="h-7 text-[11px]"
                            disabled={busy}
                            onClick={() => onConfirmAttendance(att.userId, 'PRESENT')}
                          >
                            <CheckCircle2 className="ml-1 h-3.5 w-3.5" /> تأكيد حضور
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant={att.status === 'ABSENT' ? 'destructive' : 'outline'}
                            className="h-7 text-[11px]"
                            disabled={busy}
                            onClick={() => onConfirmAttendance(att.userId, 'ABSENT')}
                          >
                            <XCircle className="ml-1 h-3.5 w-3.5" /> غياب
                          </Button>
                          {att.confirmedAt && (
                            <span className="text-[10px] text-slate-400">تم التأكيد: {fmtWhen(att.confirmedAt, m.timezone)}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {m.minutesEnabled && <MeetingMinutesPanel meetingId={m.id} />}
    </div>
  )
}

type ConfirmState = { title: string; message: string; run: () => Promise<void> }

export function AdminMeetings() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [meetings, setMeetings] = useState<Meeting[]>([])
  const [filter, setFilter] = useState<EffectiveStatus | 'ALL'>('ALL')
  const [busy, setBusy] = useState(false)
  const [formTarget, setFormTarget] = useState<{ meeting: Meeting | null } | null>(null)
  const [linksToShow, setLinksToShow] = useState<InviteLink[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, MeetingDetail | null>>({})
  const [detailLoading, setDetailLoading] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api<{ ok: boolean; meetings: Meeting[] }>('/api/admin/meetings')
      setMeetings(res.meetings || [])
      setError(null)
    } catch {
      setError('تعذر تحميل الاجتماعات.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(id)
      try {
        const res = await api<{ ok: boolean; meeting: Meeting; invites: Invite[]; attendance: Attendance[] }>(
          `/api/admin/meetings/${id}`,
        )
        setDetails((d) => ({ ...d, [id]: { meeting: res.meeting, invites: res.invites || [], attendance: res.attendance || [] } }))
      } catch (e: any) {
        toast({ title: 'تعذر تحميل تفاصيل الاجتماع', description: e?.message, variant: 'destructive' })
      } finally {
        setDetailLoading(null)
      }
    },
    [toast],
  )

  const toggleDetails = (m: Meeting) => {
    if (openId === m.id) {
      setOpenId(null)
      return
    }
    setOpenId(m.id)
    if (!details[m.id]) void loadDetail(m.id)
  }

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text)
        toast({ title: 'تم النسخ' })
      } catch {
        toast({ title: 'تعذر النسخ — انسخ الرابط يدويًا', variant: 'destructive' })
      }
    },
    [toast],
  )

  const act = useCallback(
    async (fn: () => Promise<unknown>, success: string) => {
      setBusy(true)
      try {
        await fn()
        toast({ title: success })
      } catch (e: any) {
        toast({ title: 'حدث خطأ', description: e?.message || 'حاول مجددًا', variant: 'destructive' })
      } finally {
        setBusy(false)
      }
    },
    [toast],
  )

  const submitForm = async (payload: Record<string, unknown>) => {
    if (formTarget?.meeting) {
      const id = formTarget.meeting.id
      await api(`/api/admin/meetings/${id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      toast({ title: 'تم حفظ تعديلات الاجتماع' })
      setFormTarget(null)
      await load()
      if (openId === id) await loadDetail(id)
    } else {
      const res = await api<{ ok: boolean; meeting: Meeting; inviteLinks: InviteLink[] }>('/api/admin/meetings', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      toast({ title: 'تم إنشاء الاجتماع' })
      setFormTarget(null)
      await load()
      if (res.inviteLinks && res.inviteLinks.length > 0) setLinksToShow(res.inviteLinks)
    }
  }

  const askCancelMeeting = (m: Meeting) => {
    setConfirm({
      title: 'إلغاء الاجتماع',
      message: `سيتم إلغاء اجتماع «${m.title}» نهائيًا، ولن يتمكن المدعوون من دخوله. هل أنت متأكد؟`,
      run: async () => {
        await act(async () => {
          await api(`/api/admin/meetings/${m.id}`, { method: 'PATCH', body: JSON.stringify({ cancel: true }) })
          setDetails((d) => ({ ...d, [m.id]: null }))
          await load()
        }, 'تم إلغاء الاجتماع')
      },
    })
  }

  const askRevokeInvite = (meetingId: string, invite: Invite) => {
    setConfirm({
      title: 'إلغاء دعوة',
      message: `سيتم إلغاء دعوة «${invite.inviteeName}» ولن يعمل رابطها بعد الآن. هل أنت متأكد؟`,
      run: async () => {
        await act(async () => {
          await api(`/api/admin/meetings/${meetingId}/invites/${invite.id}`, {
            method: 'POST',
            body: JSON.stringify({ action: 'revoke' }),
          })
          await loadDetail(meetingId)
          await load()
        }, 'تم إلغاء الدعوة')
      },
    })
  }

  const confirmAttendance = (meetingId: string, userId: string, status: AttendanceStatus) => {
    void act(async () => {
      await api(`/api/admin/meetings/${meetingId}/attendance`, {
        method: 'POST',
        body: JSON.stringify({ userId, status }),
      })
      await loadDetail(meetingId)
      await load()
    }, status === 'PRESENT' ? 'تم تأكيد الحضور' : 'تم تسجيل الغياب')
  }

  const addInvitee = async (meetingId: string, name: string, email: string): Promise<string> => {
    const res = await api<{ ok: boolean; url: string }>(`/api/admin/meetings/${meetingId}/invites`, {
      method: 'POST',
      body: JSON.stringify({ name, ...(email ? { email } : {}) }),
    })
    await loadDetail(meetingId)
    await load()
    return res.url
  }

  const visible = filter === 'ALL' ? meetings : meetings.filter((m) => m.effectiveStatus === filter)

  if (loading && !meetings.length) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" /> جارٍ تحميل الاجتماعات...
      </div>
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-black text-slate-800">قاعة الاجتماعات</h2>
          <p className="mt-1 max-w-2xl text-xs font-bold leading-6 text-slate-500">
            اجتماعات إدارية رسمية بروابط دعوة شخصية — يظهر رابط الاجتماع الخارجي للمدعوين قبل البدء بـ15 دقيقة فقط.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RefreshCw className="ml-1 h-4 w-4" /> تحديث
          </Button>
          <Button size="sm" onClick={() => setFormTarget({ meeting: null })}>
            <Plus className="ml-1 h-4 w-4" /> اجتماع جديد
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`rounded-full border px-3 py-1 text-xs font-bold transition-colors ${
              filter === f.key
                ? 'border-[#12365c] bg-[#12365c] text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <Card>
        <CardContent className="py-3">
          {visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">لا توجد اجتماعات مطابقة.</p>
          ) : (
            visible.map((m) => {
              const meta = STATUS_META[m.effectiveStatus] ?? STATUS_META.SCHEDULED
              const isOpen = openId === m.id
              const canEdit = m.effectiveStatus === 'SCHEDULED'
              const canCancel = m.effectiveStatus === 'SCHEDULED' || m.effectiveStatus === 'LIVE'
              return (
                <div key={m.id} className="border-b border-slate-100 py-3 last:border-0">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-slate-800">{m.title}</span>
                        <Badge className={meta.className}>{meta.label}</Badge>
                        <span className="text-[11px] text-slate-400">
                          مدعوون: {m.inviteCount ?? 0} • حضور مسجل: {m.attendanceCount ?? 0}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {fmtWhen(m.startsAt, m.timezone)} ← {fmtTime(m.endsAt, m.timezone)} • {PROVIDER_LABELS[m.provider] || m.provider}
                        {m.hostName ? ` • ${m.hostName}` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <Button variant="ghost" size="sm" onClick={() => toggleDetails(m)}>
                        <ChevronDown className={`ml-1 h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} /> التفاصيل
                      </Button>
                      {canEdit && (
                        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setFormTarget({ meeting: m })}>
                          <Pencil className="ml-1 h-4 w-4" /> تعديل
                        </Button>
                      )}
                      {canCancel && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          disabled={busy}
                          onClick={() => askCancelMeeting(m)}
                        >
                          <Ban className="ml-1 h-4 w-4" /> إلغاء
                        </Button>
                      )}
                    </div>
                  </div>
                  {isOpen &&
                    (detailLoading === m.id || !details[m.id] ? (
                      <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
                        <Loader2 className="h-4 w-4 animate-spin" /> جارٍ تحميل التفاصيل...
                      </div>
                    ) : (
                      <MeetingDetailsPanel
                        detail={details[m.id] as MeetingDetail}
                        busy={busy}
                        copyText={copyText}
                        onRevokeInvite={(invite) => askRevokeInvite(m.id, invite)}
                        onConfirmAttendance={(userId, status) => confirmAttendance(m.id, userId, status)}
                        onAddInvitee={(name, email) => addInvitee(m.id, name, email)}
                      />
                    ))}
                </div>
              )
            })
          )}
        </CardContent>
      </Card>

      {formTarget && (
        <MeetingFormDialog
          key={formTarget.meeting?.id ?? 'new'}
          meeting={formTarget.meeting}
          onClose={() => setFormTarget(null)}
          onSubmit={submitForm}
        />
      )}

      {linksToShow && (
        <Dialog open onOpenChange={(o) => !o && setLinksToShow(null)}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>روابط دعوة الاجتماع</DialogTitle>
            </DialogHeader>
            <p className="rounded-md bg-amber-50 px-3 py-2 text-xs font-bold leading-6 text-amber-800">
              تظهر هذه الروابط مرة واحدة فقط — انسخها الآن وأرسلها إلى المدعوين، ولن تتمكن من عرضها مرة أخرى.
            </p>
            <div className="max-h-[50vh] space-y-2 overflow-y-auto">
              {linksToShow.map((link) => (
                <div key={link.url} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-sm font-bold text-slate-700">{link.inviteeName}</span>
                  <code dir="ltr" className="min-w-0 flex-1 truncate rounded bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
                    {link.url}
                  </code>
                  <Button type="button" size="sm" variant="outline" onClick={() => void copyText(link.url)}>
                    <Copy className="ml-1 h-3.5 w-3.5" /> نسخ
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex justify-end">
              <Button onClick={() => setLinksToShow(null)}>تم النسخ، إغلاق</Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {confirm && (
        <Dialog open onOpenChange={(o) => !o && setConfirm(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{confirm.title}</DialogTitle>
            </DialogHeader>
            <p className="text-sm leading-6 text-slate-600">{confirm.message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirm(null)}>
                تراجع
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  const run = confirm.run
                  setConfirm(null)
                  void run()
                }}
              >
                تأكيد
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
