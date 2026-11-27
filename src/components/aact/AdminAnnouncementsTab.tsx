'use client'

import { useState } from 'react'
import { useAdminActionDialog } from '@/components/aact/AdminActionDialog'
import type { SiteAnnouncement, SiteAnnouncementDisplay } from '@/lib/site-announcements'
import { MAX_ANNOUNCEMENT_IMAGE_URLS } from '@/lib/site-announcements-core'
import { api } from '@/lib/store'
import { toast } from '@/hooks/use-toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { CheckCircle2, Globe2, Loader2, Upload, X, XCircle } from 'lucide-react'

type AnnouncementForm = {
  id?: string
  title: string
  summary: string
  body: string
  display: SiteAnnouncementDisplay
  active: boolean
  startsAt: string
  endsAt: string
  videoUrl: string
  imageUrls: string[]
}

function emptyForm(): AnnouncementForm {
  return { title: '', summary: '', body: '', display: 'TICKER', active: true, startsAt: '', endsAt: '', videoUrl: '', imageUrls: [] }
}

function toDateTimeLocal(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formFromAnnouncement(item: SiteAnnouncement): AnnouncementForm {
  return {
    id: item.id,
    title: item.title,
    summary: item.summary,
    body: item.body || '',
    display: item.display,
    active: item.active,
    startsAt: toDateTimeLocal(item.startsAt),
    endsAt: toDateTimeLocal(item.endsAt),
    videoUrl: item.videoUrl || '',
    imageUrls: item.imageUrls || [],
  }
}

function dateLabel(value?: string | null) {
  if (!value) return 'غير محدد'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'غير محدد'
  return date.toLocaleString('ar')
}

export function AdminAnnouncementsTab({ announcements, loading, onRefresh }: { announcements: SiteAnnouncement[]; loading: boolean; onRefresh: () => Promise<void> }) {
  const [form, setForm] = useState<AnnouncementForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const { confirmAction, dialog: actionDialog } = useAdminActionDialog()

  const updateForm = (patch: Partial<AnnouncementForm>) => setForm((current) => ({ ...(current || emptyForm()), ...patch }))

  // رفع فيديو أو صورة واحدة لكل ضغطة. فيديو واحد فقط لكل إعلان (الاستبدال
  // يلغي القديم)، وصور حتى حد النواة. الملف القديم المستبدَل يبقى في
  // التخزين كملف يتيم ولا يُحذف تلقائيًا.
  const uploadMedia = async (file: File) => {
    if (!form) return
    try {
      setUploading(true)
      const body = new FormData()
      body.append('file', file)
      const data = await api<{ url: string; mimeType: string }>('/api/admin/announcements/media', { method: 'POST', body })
      if (String(data.mimeType || '').startsWith('video/')) {
        updateForm({ videoUrl: data.url })
        toast({ title: 'تم رفع الفيديو' })
      } else {
        if ((form.imageUrls?.length || 0) >= MAX_ANNOUNCEMENT_IMAGE_URLS) {
          toast({ title: `عدد الصور يجب ألا يتجاوز ${MAX_ANNOUNCEMENT_IMAGE_URLS}`, variant: 'destructive' })
          return
        }
        updateForm({ imageUrls: [...(form.imageUrls || []), data.url] })
        toast({ title: 'تم رفع الصورة' })
      }
    } catch (e: any) {
      toast({ title: 'تعذر رفع الملف', description: e.message, variant: 'destructive' })
    } finally {
      setUploading(false)
    }
  }

  const save = async () => {
    if (!form) return
    try {
      setSaving(true)
      const payload = {
        id: form.id,
        title: form.title,
        summary: form.summary,
        body: form.body,
        display: form.display,
        active: form.active,
        startsAt: form.startsAt || null,
        endsAt: form.endsAt || null,
        videoUrl: form.videoUrl || null,
        imageUrls: form.imageUrls || [],
      }
      await api('/api/admin/announcements', { method: form.id ? 'PATCH' : 'POST', body: JSON.stringify(payload) })
      toast({ title: form.id ? 'تم تعديل الإعلان' : 'تم إنشاء الإعلان', description: 'سيظهر الإعلان للزوار إذا كان فعالاً وضمن التواريخ المحددة.' })
      setForm(null)
      await onRefresh()
    } catch (e: any) {
      toast({ title: 'تعذر حفظ الإعلان', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const toggleActive = async (item: SiteAnnouncement) => {
    try {
      await api('/api/admin/announcements', { method: 'PATCH', body: JSON.stringify({ id: item.id, active: !item.active }) })
      toast({ title: item.active ? 'تم إيقاف الإعلان' : 'تم تفعيل الإعلان' })
      await onRefresh()
    } catch (e: any) {
      toast({ title: 'تعذر تحديث حالة الإعلان', description: e.message, variant: 'destructive' })
    }
  }

  const remove = async (item: SiteAnnouncement) => {
    if (!(await confirmAction({ title: 'حذف الإعلان', description: `هل تريد حذف الإعلان «${item.title}» نهائيًا؟`, confirmLabel: 'حذف الإعلان', tone: 'danger' }))) return
    try {
      setDeletingId(item.id)
      await api(`/api/admin/announcements?id=${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      toast({ title: 'تم حذف الإعلان' })
      await onRefresh()
    } catch (e: any) {
      toast({ title: 'تعذر حذف الإعلان', description: e.message, variant: 'destructive' })
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="mt-4 w-full min-w-0 space-y-4">
      {actionDialog}
      <Card className="border-[#0f2b46]/10">
        <CardContent className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-black text-[#0f2b46]"><Globe2 className="h-5 w-5 text-[#c9a227]" /> الإعلانات</h2>
            <p className="mt-1 text-xs font-bold text-slate-500">إعلانات تظهر للزوار كشريط متحرك أو شارة نبضية أو بطاقة بارزة، مع فيديو أو صور، وبدون HTML.</p>
          </div>
          <Button onClick={() => setForm(emptyForm())} className="bg-[#0f2b46] font-black text-[#f5f0e1] hover:bg-[#183c5f]">إعلان جديد</Button>
        </CardContent>
      </Card>

      {form && (
        <Card className="border-[#c9a227]/40 bg-[#fffaf0]">
          <CardContent className="space-y-4 p-5">
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-black text-[#0f2b46]">العنوان ({form.title.length}/120)</Label>
                <Input value={form.title} maxLength={120} onChange={(e) => updateForm({ title: e.currentTarget.value })} className="bg-white font-bold" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-black text-[#0f2b46]">طريقة العرض</Label>
                <Select value={form.display} onValueChange={(value) => updateForm({ display: value as SiteAnnouncementDisplay })}>
                  <SelectTrigger className="bg-white font-bold"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TICKER">شريط متحرك</SelectItem>
                    <SelectItem value="PULSE">نبضي</SelectItem>
                    <SelectItem value="CARD">بطاقة بارزة</SelectItem>
                  </SelectContent>
                </Select>
                {form.display === 'CARD' && (
                  <p className="text-[11px] font-bold text-slate-500">تظهر كنافذة بارزة عند أول دخول للمستخدم للمنصة، مرة واحدة فقط لكل إعلان.</p>
                )}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-black text-[#0f2b46]">نص الشريط ({form.summary.length}/200)</Label>
              <Input value={form.summary} maxLength={200} onChange={(e) => updateForm({ summary: e.currentTarget.value })} className="bg-white font-bold" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-black text-[#0f2b46]">التفاصيل ({form.body.length}/5000)</Label>
              <Textarea value={form.body} maxLength={5000} onChange={(e) => updateForm({ body: e.currentTarget.value })} className="min-h-[150px] bg-white font-bold" />
            </div>
            <div className="space-y-3 rounded-xl border border-[#0f2b46]/10 bg-white p-4">
              <div className="space-y-1.5">
                <Label className="text-xs font-black text-[#0f2b46]">فيديو الإعلان</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[#0f2b46] px-3 py-2 text-xs font-black text-[#f5f0e1] hover:bg-[#183c5f]">
                    {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    ارفع فيديو أو صور
                    <input
                      type="file"
                      accept="video/mp4,video/webm,video/quicktime,image/jpeg,image/png,image/webp"
                      className="hidden"
                      disabled={uploading}
                      onChange={(e) => {
                        const file = e.currentTarget.files?.[0]
                        e.currentTarget.value = ''
                        if (file) void uploadMedia(file)
                      }}
                    />
                  </label>
                  <span className="text-[11px] font-bold text-slate-500">فيديو حتى 500MB، صورة حتى 10MB — فيديو واحد و{MAX_ANNOUNCEMENT_IMAGE_URLS} صور كحد أقصى.</span>
                </div>
                <Input
                  value={form.videoUrl}
                  onChange={(e) => updateForm({ videoUrl: e.currentTarget.value })}
                  placeholder="أو الصق رابط فيديو (يوتيوب أو ملف mp4 مباشر)"
                  className="bg-white font-bold"
                  dir="ltr"
                />
                {form.videoUrl && (
                  <div className="relative overflow-hidden rounded-lg border border-[#0f2b46]/10">
                    <video src={form.videoUrl} controls className="aspect-video w-full bg-black" />
                    <Button size="sm" variant="outline" onClick={() => updateForm({ videoUrl: '' })} className="absolute left-2 top-2 h-7 w-7 p-0 text-xs font-bold">
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
              </div>
              {form.imageUrls.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {form.imageUrls.map((url) => (
                    <div key={url} className="relative h-20 w-20 overflow-hidden rounded-lg border border-[#0f2b46]/10">
                      <img src={url} alt="صورة الإعلان" className="h-full w-full object-cover" />
                      <button
                        type="button"
                        aria-label="إزالة الصورة"
                        onClick={() => updateForm({ imageUrls: form.imageUrls.filter((item) => item !== url) })}
                        className="absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-white"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="flex items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white px-3 py-2 text-xs font-black text-[#0f2b46]">
                <input type="checkbox" checked={form.active} onChange={(e) => updateForm({ active: e.currentTarget.checked })} /> فعال
              </label>
              <div className="space-y-1.5">
                <Label className="text-xs font-black text-[#0f2b46]">يبدأ في</Label>
                <Input type="datetime-local" value={form.startsAt} onChange={(e) => updateForm({ startsAt: e.currentTarget.value })} className="bg-white font-bold" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-black text-[#0f2b46]">ينتهي في</Label>
                <Input type="datetime-local" value={form.endsAt} onChange={(e) => updateForm({ endsAt: e.currentTarget.value })} className="bg-white font-bold" />
              </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setForm(null)} className="font-bold text-slate-500">إلغاء</Button>
              <Button onClick={save} disabled={saving} className="bg-[#b22234] font-black text-white hover:bg-[#921b2a]">
                {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="ml-2 h-4 w-4" />}
                حفظ الإعلان
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {loading ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="flex h-36 items-center justify-center gap-2 text-sm font-black text-[#0f2b46]"><Loader2 className="h-5 w-5 animate-spin text-[#c9a227]" /> جاري تحميل الإعلانات...</CardContent></Card>
      ) : announcements.length === 0 ? (
        <Card className="border-[#0f2b46]/10"><CardContent className="p-10 text-center text-sm font-bold text-slate-400">لا توجد إعلانات محفوظة بعد.</CardContent></Card>
      ) : (
        <div className="grid gap-3">
          {announcements.map((item) => (
            <Card key={item.id} className="border-[#0f2b46]/10">
              <CardContent className="p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-black text-[#0f2b46]">{item.title}</h3>
                      <Badge className={item.active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-slate-100 text-slate-500 hover:bg-slate-100'}>{item.active ? 'فعال' : 'موقوف'}</Badge>
                      <Badge variant="outline" className="border-[#c9a227]/50 text-[#a8841a]">{item.display === 'TICKER' ? 'شريط متحرك' : item.display === 'CARD' ? 'بطاقة بارزة' : 'نبضي'}</Badge>
                      {item.videoUrl && <Badge variant="outline" className="border-[#0f2b46]/30 text-[#0f2b46]">فيديو</Badge>}
                      {(item.imageUrls?.length || 0) > 0 && <Badge variant="outline" className="border-[#0f2b46]/30 text-[#0f2b46]">{item.imageUrls?.length} صور</Badge>}
                    </div>
                    <p className="mt-2 text-xs font-bold leading-6 text-slate-600">{item.summary}</p>
                    {item.body && <p className="mt-1 line-clamp-2 text-[11px] font-medium leading-5 text-slate-500">{item.body}</p>}
                    <p className="mt-2 text-[10px] font-bold text-slate-400">من {dateLabel(item.startsAt)} — إلى {dateLabel(item.endsAt)} · آخر تعديل {dateLabel(item.updatedAt)}</p>
                  </div>
                  <div className="flex flex-wrap gap-2 sm:justify-end">
                    <Button size="sm" variant="outline" onClick={() => setForm(formFromAnnouncement(item))} className="text-xs font-bold">تعديل</Button>
                    <Button size="sm" variant="outline" onClick={() => toggleActive(item)} className="text-xs font-bold">
                      {item.active ? <XCircle className="ml-1 h-3.5 w-3.5" /> : <CheckCircle2 className="ml-1 h-3.5 w-3.5" />}
                      {item.active ? 'إيقاف' : 'تفعيل'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => remove(item)} disabled={deletingId === item.id} className="border-red-200 text-xs font-bold text-red-600 hover:bg-red-50">
                      {deletingId === item.id ? <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin" /> : <XCircle className="ml-1 h-3.5 w-3.5" />}
                      حذف
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
