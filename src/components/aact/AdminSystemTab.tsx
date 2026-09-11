'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/store'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Loader2, Mail, CreditCard, Network, SendHorizonal, ShieldCheck, Save,
  CheckCircle2, XCircle, Clock3, Info, Bot, Radio,
} from 'lucide-react'

interface EmailLog {
  id: string
  to: string
  subject: string
  event: string
  status: string
  error?: string | null
  createdAt: string
}

interface SystemData {
  values: Record<string, string>
  secretsSet: Record<string, boolean>
  smtpEnabled: boolean
  paymentMode: string
  turnConfigured: boolean
  emails: EmailLog[]
}

const GEMINI_LIVE_MODEL_CHOICES = [
  { value: 'gemini-3.1-flash-live-preview', label: 'Gemini 3.1 Flash Live Preview — افتراضي حديث' },
  { value: 'gemini-2.5-flash-native-audio-preview-12-2025', label: 'Gemini 2.5 Flash Native Audio — صوت طبيعي/احتياطي' },
  { value: 'gemini-2.5-flash-live-preview', label: 'Gemini 2.5 Flash Live Preview — توافق قديم' },
]

const GEMINI_VOICE_CHOICES = [
  'Charon', 'Aoede', 'Puck', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Zephyr', 'Achernar', 'Algenib', 'Callirrhoe', 'Despina', 'Erinome', 'Gacrux', 'Iapetus', 'Laomedeia', 'Pulcherrima', 'Rasalgethi', 'Sadachbia', 'Schedar', 'Sulafat', 'Umbriel', 'Vindemiatrix', 'Zubenelgenubi'
]

// تبويب «النظام: البريد والدفع» في لوحة الإدارة — مركز واحد لكل تكاملات المنصة الخارجية
export function AdminSystemTab() {
  const { toast } = useToast()
  const [data, setData] = useState<SystemData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})

  const load = () => {
    setLoading(true)
    api<SystemData>('/api/admin/system')
      .then((d) => {
        setData(d)
        setForm(d.values)
      })
      .catch((e) => toast({ title: 'خطأ', description: e.message, variant: 'destructive' }))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (k: string, v: string) => setForm((prev) => ({ ...prev, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      const d = await api<{ ok: boolean; values: Record<string, string> }>('/api/admin/system', {
        method: 'PATCH',
        body: JSON.stringify(form),
      })
      toast({ title: 'تم الحفظ', description: 'أُعيد تحميل الإعدادات — الأسرار المخفية بقيت كما هي', variant: 'default' as any })
      setData((prev) => (prev ? { ...prev, values: d.values } : prev))
      setForm(d.values)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setSaving(false)
    }
  }

  const testEmail = async () => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; message: string }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({ action: 'test-email' }),
      })
      toast({ title: d.ok ? 'تم الإرسال' : 'تنبيه', description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
      load()
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  const testGeminiLive = async () => {
    setTesting(true)
    try {
      const d = await api<{ ok: boolean; title?: string; message: string }>('/api/admin/system', {
        method: 'POST',
        body: JSON.stringify({ action: 'test-gemini-live', model: form.GEMINI_LIVE_MODEL, voice: form.GEMINI_TTS_VOICE }),
      })
      toast({ title: d.title || (d.ok ? 'Gemini Live يعمل' : 'فشل Gemini Live'), description: d.message, variant: d.ok ? 'default' : 'destructive' } as any)
    } catch (e: any) {
      toast({ title: 'خطأ', description: e.message, variant: 'destructive' })
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-[#c9a227]" />
      </div>
    )
  }
  if (!data) return null

  const statusBadge = (s: string) => {
    if (s === 'SENT') return { cls: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 className="h-3 w-3" />, label: 'أُرسل' }
    if (s === 'FAILED') return { cls: 'bg-red-100 text-red-600', icon: <XCircle className="h-3 w-3" />, label: 'فشل' }
    return { cls: 'bg-amber-100 text-amber-700', icon: <Clock3 className="h-3 w-3" />, label: 'تخطى (لا SMTP)' }
  }

  const F = (k: string, label: string, placeholder = '', type = 'text', hint = '') => (
    <div key={k} className="space-y-1">
      <Label className="text-[11px] font-black text-[#0f2b46]">{label}</Label>
      <Input
        type={type}
        value={form[k] ?? ''}
        onChange={(e) => set(k, e.target.value)}
        placeholder={placeholder}
        dir={type === 'password' || k.includes('KEY') || k.includes('SECRET') || k.includes('PASS') ? 'ltr' : undefined}
        className="h-9 bg-white text-sm"
      />
      {hint && <p className="text-[10px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  )

  const SelectF = (k: string, label: string, options: { value: string; label: string }[], hint = '') => (
    <div key={k} className="space-y-1">
      <Label className="text-[11px] font-black text-[#0f2b46]">{label}</Label>
      <Select value={form[k] || options[0]?.value || ''} onValueChange={(v) => set(k, v)}>
        <SelectTrigger className="h-9 bg-white text-sm" dir="ltr">
          <SelectValue placeholder="اختر" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} dir="ltr">{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-[10px] leading-relaxed text-slate-400">{hint}</p>}
    </div>
  )

  return (
    <div className="space-y-4">
      <Tabs defaultValue="mail" dir="rtl">
        <TabsList className="grid h-auto w-full grid-cols-4 gap-1 rounded-xl bg-[#f1f5f9] p-1">
          <TabsTrigger value="mail" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Mail className="h-3.5 w-3.5" /> الإشعارات البريدية
          </TabsTrigger>
          <TabsTrigger value="pay" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <CreditCard className="h-3.5 w-3.5" /> بوابات الدفع
          </TabsTrigger>
          <TabsTrigger value="gemini" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Bot className="h-3.5 w-3.5" /> Gemini Live
          </TabsTrigger>
          <TabsTrigger value="turn" className="gap-1.5 text-[11px] font-bold sm:text-xs">
            <Network className="h-3.5 w-3.5" /> TURN للفيديو
          </TabsTrigger>
        </TabsList>

        {/* ===== الإشعارات البريدية ===== */}
        <TabsContent value="mail" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold text-slate-600">
            <Info className="h-4 w-4 text-[#a8841a]" />
            اضبط خادم SMTP (مثل Gmail بعنوان تطبيق، أو خادم الاستضافة) وستُرسل المنصة إشعارات آلية عند: التسجيل، تقديم طلبات الالتحاق بكود التتبع، الإيصالات المالية، قرارات القبول، نشر الامتحانات، مواعيد المناقشات، وإصدار الشهادات.
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            {F('SMTP_HOST', 'خادم SMTP', 'smtp.gmail.com', 'text', 'مثال: smtp.gmail.com أو mail.aact.academy')}
            {F('SMTP_PORT', 'المنفذ', '587', 'text', '587 مع TLS أو 465 مع SSL')}
            {F('SMTP_USER', 'اسم المستخدم (البريد)', 'notifications@aact.academy')}
            {F('SMTP_PASS', 'كلمة المرور / كلمة تطبيق', data.secretsSet.SMTP_PASS ? 'محفوظة — اكتب جديدة للتغيير' : 'app-password', 'password')}
            {F('SMTP_FROM', 'البريد المرسل From', 'notifications@aact.academy')}
            {F('SMTP_NAME', 'اسم المرسل المعروض', 'الأكاديمية الأمريكية للاستشارات والتدريب')}
            <div className="flex items-center justify-between rounded-xl border border-[#0f2b46]/10 bg-white px-4 py-3 sm:col-span-2">
              <div>
                <p className="text-xs font-black text-[#0f2b46]">تفعيل الإرسال الفعلي</p>
                <p className="text-[10px] text-slate-500">معطلة = يُسجَّل كل بريد في السجل دون إرسال (وضع آمن للتجربة)</p>
              </div>
              <div className="flex items-center gap-2">
                <input type="hidden" value={form.SMTP_ENABLED ?? ''} />
                <Switch
                  checked={form.SMTP_ENABLED === '1'}
                  onCheckedChange={(v) => set('SMTP_ENABLED', v ? '1' : '0')}
                />
                <Badge className={data.smtpEnabled ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}>
                  {data.smtpEnabled ? 'يعمل الآن' : 'غير مهيأ'}
                </Badge>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات البريد
            </Button>
            <Button onClick={testEmail} disabled={testing} variant="outline" className="border-[#c9a227] font-extrabold text-[#a8841a] hover:bg-[#f7edd0]">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <SendHorizonal className="ml-2 h-4 w-4" />} إرسال رسالة تجريبية لبريدي
            </Button>
          </div>

          {/* سجل البريد */}
          <div className="overflow-hidden rounded-2xl border border-[#0f2b46]/10 bg-white">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h4 className="text-xs font-black text-[#0f2b46]">سجل الإشعارات البريدية (آخر 50)</h4>
            </div>
            <div className="aact-scroll max-h-72 overflow-y-auto">
              {data.emails.length === 0 ? (
                <p className="p-6 text-center text-xs font-bold text-slate-400">لا رسائل بعد — ستظهر هنا فور حدوث الأحداث</p>
              ) : (
                data.emails.map((e) => {
                  const b = statusBadge(e.status)
                  return (
                    <div key={e.id} className="flex items-start justify-between gap-3 border-b border-slate-50 px-4 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-black text-[#0f2b46]">{e.subject}</p>
                        <p dir="ltr" className="truncate text-right text-[10px] text-slate-400">{e.to} · {e.event}</p>
                        {e.error && <p className="mt-0.5 truncate text-[9px] text-red-400">{e.error}</p>}
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="text-[9px] text-slate-300">{new Date(e.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                        <Badge className={`gap-1 text-[9px] ${b.cls}`}>{b.icon} {b.label}</Badge>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </TabsContent>

        {/* ===== بوابات الدفع ===== */}
        <TabsContent value="pay" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-600">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            أدخل مفاتيح مزودي الدفع الفعليين وشغّل وضع LIVE: يُحوَّل الطالب لصفحة دفع Stripe/PayPal الرسمية ويُعتمد السداد تلقائياً عبر Webhook. بدون مفاتيح يعمل وضع SANDBOX (محاكاة آمنة) وتظل طرق فوري/تحويل بنكي متاحة للمراجعة اليدوية.
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-xl border border-[#0f2b46]/10 bg-white px-4 py-3 sm:col-span-2">
              <div>
                <p className="text-xs font-black text-[#0f2b46]">وضع الدفع العام</p>
                <p className="text-[10px] leading-relaxed text-slate-500">
                  SANDBOX = محاكاة داخل المنصة (للتجربة) · LIVE = دفع حقيقي عبر المزودين المفعّلين
                </p>
              </div>
              <div className="flex overflow-hidden rounded-lg border border-[#0f2b46]/15">
                {['SANDBOX', 'LIVE'].map((m) => (
                  <button
                    key={m}
                    onClick={() => set('PAYMENT_MODE', m)}
                    className={`px-4 py-2 text-[11px] font-black transition-colors ${form.PAYMENT_MODE === m ? 'bg-[#0f2b46] text-[#e0b83a]' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="sm:col-span-2">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]">
                <CreditCard className="h-3.5 w-3.5" /> Stripe (بطاقات دولية)
              </h4>
            </div>
            {F('STRIPE_SECRET_KEY', 'Secret Key', data.secretsSet.STRIPE_SECRET_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'sk_live_...', 'password', 'من لوحة Stripe → Developers → API keys')}
            {F('STRIPE_WEBHOOK_SECRET', 'Webhook Signing Secret', data.secretsSet.STRIPE_WEBHOOK_SECRET ? 'محفوظ — اكتب جديداً للتغيير' : 'whsec_...', 'password', 'أنشئ Webhook يشير إلى: /api/payments/webhook/stripe (حدث checkout.session.completed)')}
            <div className="sm:col-span-2">
              <h4 className="mb-2 mt-1 flex items-center gap-1.5 text-[11px] font-black text-[#a8841a]">
                <CreditCard className="h-3.5 w-3.5" /> PayPal
              </h4>
            </div>
            {F('PAYPAL_CLIENT_ID', 'Client ID', '', 'text', 'من developer.paypal.com → تطبيقك')}
            {F('PAYPAL_SECRET', 'Client Secret', data.secretsSet.PAYPAL_SECRET ? 'محفوظ — اكتب جديداً للتغيير' : '', 'password')}
            {F('PAYPAL_API_BASE', 'API Base', 'https://api-m.sandbox.paypal.com', 'text', 'اختبار: api-m.sandbox.paypal.com — حقيقي: api-m.paypal.com')}
          </div>
          <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
            {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات الدفع
          </Button>
          <div className="rounded-xl bg-[#f7edd0]/60 p-3 text-[10px] font-bold leading-relaxed text-[#5c4d1a]">
            <p className="mb-1 font-black">حالة الوضع الحالي: {data.paymentMode === 'LIVE' ? 'LIVE — دفع حقيقي عبر المزودين المهيأين' : 'SANDBOX — محاكاة آمنة داخل المنصة'}</p>
            ملاحظة: وضع LIVE يعمل فقط بعد إدخال مفتاح Stripe أو مفاتيح PayPal — وإلا تعود المنصة تلقائياً للمحاكاة الآمنة حمايةً من فقدان المدفوعات.
          </div>
        </TabsContent>

        {/* ===== Gemini Live ===== */}
        <TabsContent value="gemini" className="mt-4 space-y-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[11px] font-bold leading-relaxed text-emerald-800">
            <Radio className="ml-1 inline h-4 w-4" /> Gemini Live هنا صوت إلى صوت حقيقي عبر WebSocket، وليس Text→TTS. اختر النموذج والصوت من القوائم، ثم اضغط حفظ إعدادات Gemini واختبر الاتصال.
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            {F('GEMINI_API_KEY', 'مفتاح Gemini API', data.secretsSet.GEMINI_API_KEY ? 'محفوظ — اكتب مفتاحاً جديداً للتغيير' : 'AIza...', 'password', 'يبقى في السيرفر ولا يظهر في المتصفح')}
            {F('GEMINI_TEXT_MODEL', 'نموذج النصوص', 'gemini-3.8-flash', 'text', 'اتركه فارغاً للتلقائي؛ لا تضع نموذج Live هنا')}
            {F('GEMINI_TTS_MODEL', 'نموذج TTS', 'gemini-3.1-flash-tts-preview', 'text', 'للردود النصية فقط عند استخدام TTS')}
            {SelectF('GEMINI_TTS_VOICE', 'صوت Gemini Live / TTS', GEMINI_VOICE_CHOICES.map((v) => ({ value: v, label: v })), 'اختر الصوت من القائمة بدلاً من كتابته يدوياً. سيُستخدم في Gemini Live وفي TTS النصي.')}
            {SelectF('GEMINI_LIVE_MODEL', 'نموذج Gemini Live', GEMINI_LIVE_MODEL_CHOICES, 'اختر النموذج من القائمة. إذا لم يكن متاحاً لمشروعك فسيظهر ذلك عند اختبار Gemini Live.')}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات Gemini
            </Button>
            <Button onClick={testGeminiLive} disabled={testing} variant="outline" className="border-emerald-300 font-extrabold text-emerald-700 hover:bg-emerald-50">
              {testing ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Radio className="ml-2 h-4 w-4" />} اختبار Gemini Live
            </Button>
          </div>
          <div className="rounded-xl bg-[#f7edd0]/60 p-3 text-[10px] font-bold leading-relaxed text-[#5c4d1a]">
            إذا ظهر 429 فالمفتاح سليم لكن الحصة انتهت مؤقتاً. فعّل Billing في Google AI Studio أو انتظر إعادة ضبط الحصة. إذا ظهر خطأ نموذج، استخدم الاسم الكامل: gemini-3.1-flash-live-preview.
          </div>
        </TabsContent>

        {/* ===== TURN ===== */}
        <TabsContent value="turn" className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[#0f2b46]/10 bg-white p-3 text-[11px] font-bold leading-relaxed text-slate-600">
            <Network className="h-4 w-4 text-[#a8841a]" />
            خادم TURN يضمن اتصال الفيديو كونفرنس عبر شبكات NAT الصارمة وشركات الاتصالات وشبكات الجامعات: عندما يتعذر الاتصال المباشر (P2P) بين الطالب واللجنة تتوسط خوادمك البث بالفيديو والصوت. التوصية: نشر coturn على VPS عام (دليل جاهز في docs/turn-setup.md داخل المشروع).
          </div>
          <div className="grid gap-3 rounded-2xl border border-[#0f2b46]/10 bg-[#f8fafc] p-4 sm:grid-cols-2">
            {F('TURN_URL', 'عنوان خادم TURN (UDP)', 'turn:turn.aact.academy:3478', 'text', 'يبدأ بـ turn: ويشمل المنفذ — يُدخل تلقائياً في ICE Servers')}
            {F('TURN_TCP_URL', 'عنوان TURN احتياطي TCP/TLS', 'turns:turn.aact.academy:5349?transport=tcp', 'text', 'للشبكات التي تحجب UDP — يبدأ بـ turns: للـ TLS')}
            {F('TURN_USERNAME', 'اسم المستخدم', 'aact')}
            {F('TURN_CREDENTIAL', 'كلمة المرور', data.secretsSet.TURN_CREDENTIAL ? 'محفوظة — اكتب جديدة للتغيير' : '', 'password', 'نفس بيانات coturn (lt-cred-mech)')}
            {F('STUN_URLS', 'خوادم STUN (مفصولة بفواصل)', 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302', 'text', 'اكتشف العنوان العام — تُستخدم دائماً قبل TURN')}
          </div>
          <div className="flex items-center justify-between">
            <Badge className={data.turnConfigured ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}>
              {data.turnConfigured ? 'TURN مهيأ — اتصال مضمون عبر أي شبكة' : 'بدون TURN — الاتصال المباشر P2P عبر STUN فقط'}
            </Badge>
            <Button onClick={save} disabled={saving} className="bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
              {saving ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <Save className="ml-2 h-4 w-4" />} حفظ إعدادات TURN
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
