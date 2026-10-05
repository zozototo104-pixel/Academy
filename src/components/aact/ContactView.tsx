'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Mail, MessageSquareText, Loader2, Send, CheckCircle2, Phone, MapPin } from 'lucide-react'

type OfficialContactState = {
  legalEntity: string
  registrationNumber: string
  address: string
  email: string
  phone: string
  phones: string[]
  whatsapp: string
  whatsapps: string[]
  responsiblePerson: string
}

function contactList(primary?: unknown, list?: unknown): string[] {
  const values = [primary, ...(Array.isArray(list) ? list : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  return Array.from(new Set(values))
}

export function ContactView() {
  const { toast } = useToast()
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [form, setForm] = useState({ name: '', email: '', phone: '', subject: '', message: '' })
  const [officialContact, setOfficialContact] = useState<OfficialContactState>({
    legalEntity: '',
    registrationNumber: '',
    address: '',
    email: '',
    phone: '',
    phones: [],
    whatsapp: '',
    whatsapps: [],
    responsiblePerson: '',
  })

  useEffect(() => {
    let alive = true
    fetch('/api/settings', { headers: { Accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json() as Promise<{ values?: Record<string, string> }>
      })
      .then((d) => {
        if (!alive) return
        try {
          const parsed = JSON.parse(d.values?.OFFICIAL_CONTACT || '{}')
          if (parsed && typeof parsed === 'object') {
            const phones = contactList(parsed.phone, parsed.phones)
            const whatsapps = contactList(parsed.whatsapp, parsed.whatsapps)
            setOfficialContact((prev) => ({
              legalEntity: String(parsed.legalEntity || prev.legalEntity),
              registrationNumber: String(parsed.registrationNumber || prev.registrationNumber),
              address: String(parsed.address || prev.address),
              email: String(parsed.email || prev.email),
              phone: phones[0] || prev.phone,
              phones,
              whatsapp: whatsapps[0] || prev.whatsapp,
              whatsapps,
              responsiblePerson: String(parsed.responsiblePerson || prev.responsiblePerson),
            }))
          }
        } catch {}
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const d = await api<{ message: string }>('/api/contact', {
        method: 'POST',
        body: JSON.stringify(form),
      })
      setDone(true)
      toast({ title: 'تم الإرسال', description: d.message })
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="aact-fade-in mx-auto max-w-5xl px-4 py-12">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-4 w-fit rounded-2xl bg-[#0f2b46] p-4 text-[#e0b83a]">
          <MessageSquareText className="h-9 w-9" />
        </div>
        <h1 className="text-2xl font-black text-[#0f2b46] sm:text-3xl">تواصل معنا</h1>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-600">
          لأي استفسار عن البرامج أو الالتحاق أو الاعتمادات أو الوكالة الدولية — أرسل رسالتك
          وسيتواصل معك فريق الأكاديمية خلال أيام العمل. أو اسأل المشرف الذكي مباشرة إن كنت مسجلاً.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card className="border-[#0f2b46]/15 shadow-lg">
          <CardHeader>
            <CardTitle className="text-lg font-black text-[#0f2b46]">نموذج التواصل والاستفسار</CardTitle>
            <CardDescription>جميع الحقول بعلامة * إلزامية</CardDescription>
          </CardHeader>
          <CardContent>
            {done ? (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-8 text-center">
                <CheckCircle2 className="mx-auto mb-3 h-12 w-12 text-emerald-600" />
                <h3 className="text-lg font-black text-emerald-700">وصلت رسالتك!</h3>
                <p className="mt-2 text-sm text-emerald-800">
                  شكراً لتواصلك — سيرد فريق الأكاديمية على بريدك في أقرب وقت.
                </p>
                <Button
                  variant="outline"
                  className="mt-5 border-emerald-300 font-bold text-emerald-700"
                  onClick={() => {
                    setDone(false)
                    setForm({ name: '', email: '', phone: '', subject: '', message: '' })
                  }}
                >
                  إرسال رسالة أخرى
                </Button>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="c-name">الاسم الكامل *</Label>
                    <Input id="c-name" required value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="اسمك الثلاثي" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="c-email">البريد الإلكتروني *</Label>
                    <Input id="c-email" type="email" required dir="ltr" className="text-left" value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="you@example.com" />
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="c-phone">الهاتف / واتساب</Label>
                    <Input id="c-phone" dir="ltr" className="text-left" value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+201xxxxxxxxx" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="c-subject">موضوع الرسالة</Label>
                    <Input id="c-subject" value={form.subject}
                      onChange={(e) => setForm({ ...form, subject: e.target.value })}
                      placeholder="استفسار عن دبلوم / ماجستير / اعتماد..." />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="c-msg">رسالتك *</Label>
                  <Textarea id="c-msg" required className="min-h-32" value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    placeholder="اكتب استفسارك بالتفصيل وسنسعد بالرد عليك..." />
                </div>
                <Button type="submit" disabled={loading}
                  className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                  {loading ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Send className="ml-2 h-4 w-4 rotate-180" />}
                  إرسال الرسالة
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        {/* بيانات التواصل */}
        <div className="space-y-4">
          <Card className="border-[#c9a227]/40 bg-[#f7edd0]/50">
            <CardContent className="space-y-4 p-5">
              <h3 className="text-sm font-black text-[#0f2b46]">بيانات التواصل الرسمية</h3>
              {officialContact.legalEntity && (
                <div className="flex items-center gap-3 rounded-xl bg-white/70 p-3">
                  <span className="rounded-lg bg-[#0f2b46] p-2 text-[#e0b83a]"><CheckCircle2 className="h-4 w-4" /></span>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400">الكيان القانوني</p>
                    <p className="text-xs font-black text-[#0f2b46]">{officialContact.legalEntity}</p>
                    {officialContact.registrationNumber && <p className="mt-1 text-[10px] font-bold text-slate-400">رقم التسجيل: {officialContact.registrationNumber}</p>}
                  </div>
                </div>
              )}
              {officialContact.email && (
                <a href={`mailto:${officialContact.email}`} className="flex items-center gap-3 rounded-xl bg-white/70 p-3 transition-colors hover:bg-white">
                  <span className="rounded-lg bg-[#0f2b46] p-2 text-[#e0b83a]"><Mail className="h-4 w-4" /></span>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400">البريد الرسمي</p>
                    <p className="text-xs font-black text-[#0f2b46]" dir="ltr">{officialContact.email}</p>
                  </div>
                </a>
              )}
              {officialContact.phone && (
                <a href={`tel:${officialContact.phone.replace(/[^+\d]/g, '')}`} className="flex items-center gap-3 rounded-xl bg-white/70 p-3 transition-colors hover:bg-white">
                  <span className="rounded-lg bg-emerald-600 p-2 text-white"><Phone className="h-4 w-4" /></span>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400">الهاتف الرسمي</p>
                    <p className="text-xs font-black text-[#0f2b46]" dir="ltr">{officialContact.phone}</p>
                  </div>
                </a>
              )}
              {officialContact.whatsapp && (
                <a href={`https://wa.me/${officialContact.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="flex items-center gap-3 rounded-xl bg-white/70 p-3 transition-colors hover:bg-white">
                  <span className="rounded-lg bg-[#25d366] p-2 text-white"><MessageSquareText className="h-4 w-4" /></span>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400">واتساب رسمي{officialContact.responsiblePerson ? ` — ${officialContact.responsiblePerson}` : ''}</p>
                    <p className="text-xs font-black text-[#0f2b46]" dir="ltr">{officialContact.whatsapp}</p>
                  </div>
                </a>
              )}
              {officialContact.address && (
                <div className="flex items-center gap-3 rounded-xl bg-white/70 p-3">
                  <span className="rounded-lg bg-[#c9a227] p-2 text-[#0f2b46]"><MapPin className="h-4 w-4" /></span>
                  <div>
                    <p className="text-[10px] font-bold text-slate-400">العنوان الرسمي</p>
                    <p className="text-xs font-black text-[#0f2b46]">{officialContact.address}</p>
                  </div>
                </div>
              )}
              {!officialContact.email && !officialContact.phone && !officialContact.whatsapp && !officialContact.address && (
                <p className="rounded-xl bg-white/70 p-3 text-xs font-bold leading-6 text-slate-500">
                  لم تُضبط بيانات التواصل الرسمية بعد. يمكن تحديثها من صفحة الرسوم والقواعد ضمن OFFICIAL_CONTACT.
                </p>
              )}
            </CardContent>
          </Card>
          <Card className="border-[#0f2b46]/10">
            <CardContent className="p-5">
              <h3 className="mb-2 text-sm font-black text-[#0f2b46]">أوقات الرد</h3>
              <ul className="space-y-1.5 text-xs leading-relaxed text-slate-600">
                <li>• الأحد — الخميس: 9 صباحاً — 5 مساءً</li>
                <li>• استفسارات الالتحاق: خلال 24-48 ساعة</li>
                <li>• طلبات الاعتماد والوكالة: خلال 3-5 أيام عمل</li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
