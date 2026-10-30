'use client'

import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Copy, Link2, Loader2, Trash2, UserPlus } from 'lucide-react'

interface DefenseInvite {
  id: string
  name: string
  role: string
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED'
  expiresAt: string
  lastJoinedAt?: string | null
}

// أدوات المناقشة الخارجية لقاعة مناقشة واحدة: رابط اجتماع خارجي (Zoom/Meet)
// يُحفظ وحده دون إعادة جدولة، ودعوات مناقشين خارجيين بروابط شخصية
// (تُعرض مرة واحدة عند الإنشاء)، انتهاء تلقائي، وإلغاء فوري.
export function DefenseInvitesManager({ thesisId, initialMeetingUrl }: { thesisId: string; initialMeetingUrl?: string | null }) {
  const { toast } = useToast()
  const [meetingUrl, setMeetingUrl] = useState(initialMeetingUrl || '')
  const [savingUrl, setSavingUrl] = useState(false)
  const [invites, setInvites] = useState<DefenseInvite[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [role, setRole] = useState<'COMMITTEE' | 'AGENT'>('COMMITTEE')
  const [busy, setBusy] = useState(false)
  const [createdUrl, setCreatedUrl] = useState('')

  const load = useCallback(() => {
    api<{ invites: DefenseInvite[] }>(`/api/admin/defense-invites?thesisId=${encodeURIComponent(thesisId)}`)
      .then((d) => setInvites(Array.isArray(d.invites) ? d.invites : []))
      .catch(() => setInvites([]))
      .finally(() => setLoading(false))
  }, [thesisId])
  useEffect(load, [load])

  const create = async () => {
    if (!name.trim()) {
      toast({ title: 'اكتب اسم المناقش أولاً', variant: 'destructive' })
      return
    }
    setBusy(true)
    try {
      const d = await api<{ url: string }>('/api/admin/defense-invites', {
        method: 'POST',
        body: JSON.stringify({ thesisId, name: name.trim(), role }),
      })
      setCreatedUrl(d.url || '')
      setName('')
      load()
      toast({ title: 'أُنشئت الدعوة', description: 'انسخ الرابط الآن وأرسله للمناقش — لن يظهر مرة أخرى' })
    } catch (e: any) {
      toast({ title: 'تعذر إنشاء الدعوة', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (invite: DefenseInvite) => {
    setBusy(true)
    try {
      await api('/api/admin/defense-invites', { method: 'DELETE', body: JSON.stringify({ id: invite.id }) })
      toast({ title: 'أُلغيت الدعوة', description: `لن يستطيع ${invite.name} دخول القاعة بهذا الرابط` })
      load()
    } catch (e: any) {
      toast({ title: 'تعذر الإلغاء', description: e.message, variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: 'نُسخ الرابط' })
    } catch {
      toast({ title: 'تعذر النسخ التلقائي', description: 'انسخ الرابط يدوياً من الحقل', variant: 'destructive' })
    }
  }

  const saveMeetingUrl = async () => {
    setSavingUrl(true)
    try {
      await api('/api/admin/thesis', {
        method: 'PATCH',
        body: JSON.stringify({ id: thesisId, action: 'SET_DEFENSE_MEETING_URL', defenseMeetingUrl: meetingUrl }),
      })
      toast({
        title: meetingUrl.trim() ? 'حُفظ رابط الاجتماع الخارجي' : 'أُزيل رابط الاجتماع الخارجي',
        description: 'يظهر للطالب واللجنة داخل المنصة — دون إعادة جدولة',
      })
    } catch (e: any) {
      toast({ title: 'تعذر حفظ الرابط', description: e.message, variant: 'destructive' })
    } finally {
      setSavingUrl(false)
    }
  }

  return (
    <div className="space-y-3 border-t border-dashed pt-3">
      <div className="space-y-1.5">
        <Label>رابط اجتماع خارجي — Zoom/Meet (اختياري)</Label>
        <div className="flex gap-2">
          <Input value={meetingUrl} onChange={(e) => setMeetingUrl(e.target.value)} placeholder="https://zoom.us/j/…" dir="ltr" className="flex-1" />
          <Button size="sm" variant="outline" onClick={saveMeetingUrl} disabled={savingUrl}>
            {savingUrl ? <Loader2 className="h-4 w-4 animate-spin" /> : 'حفظ الرابط'}
          </Button>
        </div>
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          بديل جاهز داخل المنصة: إذا تعطل اتصال القاعة الداخلية (إعدادات TURN مثلاً) تتم المناقشة عبر هذا الرابط — يصل الطالب إشعار به ويظهر للجنة في القاعة وللضيوف في صفحة الدعوة.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Link2 className="h-4 w-4 text-[#a8841a]" />
        <span className="text-sm font-black text-[#0f2b46]">دعوات مناقشين خارجيين</span>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        رابط شخصي لكل مناقش خارجي — يدخل القاعة باسمه كعضو لجنة بدون حساب بالمنصة. الرابط ينتهي تلقائياً بعد المناقشة ويمكن إلغاؤه أي وقت.
      </p>
      <div className="flex gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم المناقش الخارجي" className="flex-1" />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'COMMITTEE' | 'AGENT')}
          className="rounded-md border bg-background px-2 text-xs font-bold">
          <option value="COMMITTEE">عضو لجنة</option>
          <option value="AGENT">عضو الوكيل الدولي</option>
        </select>
        <Button size="sm" onClick={create} disabled={busy} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="ml-1 h-4 w-4" />}
          إنشاء
        </Button>
      </div>
      {createdUrl && (
        <div className="space-y-1.5 rounded-lg bg-amber-50 p-2.5 ring-1 ring-amber-200">
          <Label className="text-[11px] font-black text-amber-800">رابط الدعوة — يُعرض مرة واحدة فقط، انسخه وأرسله للمناقش:</Label>
          <div className="flex gap-2">
            <Input value={createdUrl} readOnly dir="ltr" className="flex-1 bg-white text-[11px]" onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="outline" onClick={() => copy(createdUrl)}>
              <Copy className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> جارٍ تحميل الدعوات…
        </div>
      ) : invites.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">لا دعوات بعد لهذه المناقشة.</p>
      ) : (
        <div className="space-y-1.5">
          {invites.map((inv) => (
            <div key={inv.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5 ring-1 ring-slate-200">
              <div className="min-w-0">
                <div className="truncate text-xs font-black text-[#0f2b46]">
                  {inv.name}
                  <span className="mr-1.5 font-normal text-muted-foreground">{inv.role === 'AGENT' ? '· عضو وكيل دولي' : '· عضو لجنة'}</span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  ينتهي {new Date(inv.expiresAt).toLocaleDateString('ar-EG')}
                  {inv.lastJoinedAt ? ` · دخل آخر مرة ${new Date(inv.lastJoinedAt).toLocaleString('ar-EG', { dateStyle: 'short', timeStyle: 'short' })}` : ' · لم يدخل بعد'}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge className={inv.status === 'ACTIVE' ? 'bg-emerald-100 text-[10px] text-emerald-700 hover:bg-emerald-100' : 'bg-slate-200 text-[10px] text-slate-500 hover:bg-slate-200'}>
                  {inv.status === 'ACTIVE' ? 'نشطة' : inv.status === 'EXPIRED' ? 'منتهية' : 'ملغاة'}
                </Badge>
                {inv.status === 'ACTIVE' && (
                  <Button size="sm" variant="ghost" className="h-7 px-1.5 text-red-500 hover:text-red-600" onClick={() => revoke(inv)} disabled={busy} title="إلغاء الدعوة">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
