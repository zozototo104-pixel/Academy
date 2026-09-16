'use client'

import { useAppStore, api, saveToken } from '@/lib/store'
import { AcademyLogo } from '@/components/aact/Shell'
import { useEffect, useState, type FormEvent } from 'react'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ArrowRight, Bot, GraduationCap, Loader2, LockKeyhole, LogIn, Mail,
  MapPin, Phone, ShieldCheck, Sparkles, UserRound, UserPlus,
} from 'lucide-react'

export function AuthView() {
  const { setUser, navigate } = useAppStore()
  const { toast } = useToast()
  const [loading, setLoading] = useState<'login' | 'register' | 'google' | null>(null)

  const [loginData, setLoginData] = useState({ email: '', password: '' })
  const [regData, setRegData] = useState({ name: '', email: '', password: '', phone: '', country: '' })

  useEffect(() => {
    const error = new URLSearchParams(window.location.search).get('oauth_error')
    if (!error) return
    const message = error === 'google_not_configured'
      ? 'يجب إضافة GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET في Vercel لتفعيل الدخول عبر Google.'
      : 'تعذر تسجيل الدخول عبر Google. جرّب مرة أخرى أو استخدم البريد وكلمة المرور.'
    toast({ title: 'Google Login', description: message, variant: 'destructive' })
  }, [toast])

  const doGoogleLogin = () => {
    setLoading('google')
    window.location.href = '/api/auth/google'
  }

  const doLogin = async (e?: FormEvent) => {
    e?.preventDefault()
    setLoading('login')
    try {
      const d = await api<{ user: any; token?: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(loginData),
      })
      if (d.token) saveToken(d.token)
      setUser(d.user)
      toast({ title: `أهلاً بعودتك ${d.user.name}!`, description: 'تم تسجيل الدخول بنجاح' })
      navigate(d.user.role === 'ADMIN' ? 'admin' : d.user.role === 'SUPERVISOR' ? 'supervisor' : 'dashboard')
    } catch (err: any) {
      toast({ title: 'خطأ في الدخول', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(null)
    }
  }

  const doRegister = async (e?: FormEvent) => {
    e?.preventDefault()
    setLoading('register')
    try {
      const d = await api<{ user: any; token?: string }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(regData),
      })
      if (d.token) saveToken(d.token)
      setUser(d.user)
      toast({
        title: `مرحباً ${d.user.name}!`,
        description: 'تم إنشاء حسابك بنجاح — يمكنك الآن التسجيل في البرامج والتحدث مع المشرف الذكي',
      })
      navigate('dashboard')
    } catch (err: any) {
      toast({ title: 'خطأ في التسجيل', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(null)
    }
  }

  const features = [
    { icon: GraduationCap, t: 'بوابة طالب احترافية', d: 'برامجك، وحداتك، اختباراتك، شهاداتك في مكان واحد' },
    { icon: Bot, t: 'مشرف ذكي صوت وكتابة', d: 'مساعد تعليمي يرافق الطالب ويشرح ويصحح' },
    { icon: ShieldCheck, t: 'تحقق واعتماد رقمي', d: 'شهادات وأكواد تحقق ومسار متابعة واضح' },
  ]

  return (
    <div className="aact-auth-screen aact-fade-in relative min-h-screen overflow-hidden px-4 py-10 text-[#f8f8fb] sm:py-14">
      <div className="pointer-events-none absolute inset-0 opacity-25" aria-hidden="true">
        <div className="absolute -right-24 top-12 h-72 w-72 rounded-full bg-[#bf1646] blur-3xl" />
        <div className="absolute -left-24 bottom-8 h-80 w-80 rounded-full bg-[#b08a38] blur-3xl" />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-8 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="text-center lg:text-right">
          <button
            onClick={() => navigate('home')}
            className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs font-black text-white/85 backdrop-blur transition hover:bg-white/10"
          >
            <ArrowRight className="h-4 w-4" />
            العودة للرئيسية
          </button>
          <div className="mx-auto mb-7 flex h-32 w-32 items-center justify-center rounded-full border border-[#b08a38]/45 bg-white/5 shadow-2xl backdrop-blur lg:mx-0">
            <AcademyLogo size={112} light />
          </div>
          <p className="mb-3 text-[11px] font-black uppercase tracking-[0.45em] text-[#b08a38]">American Academy</p>
          <h1 className="text-3xl font-black leading-[1.35] sm:text-5xl">
            بوابة الدخول إلى
            <span className="block text-[#bf1646]">الأكاديمية الأمريكية</span>
          </h1>
          <p className="mt-5 max-w-xl text-sm font-bold leading-8 text-white/70 lg:max-w-none">
            نظام دخول موحد للطالب والمشرف والإدارة، مصمم بنفس هوية الموقع الجديد مع تجربة واضحة وسريعة على الجوال.
          </p>
          <div className="mt-7 grid gap-3">
            {features.map((f) => {
              const Icon = f.icon
              return (
                <div key={f.t} className="flex items-start gap-3 rounded-3xl border border-white/10 bg-white/[0.06] p-4 text-right backdrop-blur">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-[#b08a38]/40 bg-[#273452] text-[#b08a38]">
                    <Icon className="h-6 w-6" />
                  </span>
                  <span>
                    <strong className="block text-sm font-black text-white">{f.t}</strong>
                    <span className="mt-1 block text-xs font-bold leading-6 text-white/55">{f.d}</span>
                  </span>
                </div>
              )
            })}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/12 bg-white/[0.08] p-3 shadow-2xl backdrop-blur-xl sm:p-5">
          <div className="rounded-[1.5rem] bg-white p-5 text-[#1d2947] shadow-2xl sm:p-7">
            <div className="mb-6 text-center">
              <span className="mb-3 inline-flex rounded-full bg-[#f5e7cd] px-4 py-1.5 text-[11px] font-black text-[#8b6c2c]">
                <Sparkles className="ml-1 h-3.5 w-3.5" />
                نظام الدخول الأكاديمي
              </span>
              <h2 className="text-2xl font-black">حسابك في الأكاديمية</h2>
              <p className="mt-2 text-xs font-bold leading-6 text-slate-500">سجّل الدخول أو أنشئ حساباً جديداً للالتحاق والمتابعة</p>
            </div>

            <Button
              type="button"
              variant="outline"
              disabled={!!loading}
              onClick={doGoogleLogin}
              className="mb-4 h-[52px] w-full rounded-[1.35rem] border border-[#d9c38a]/45 bg-gradient-to-l from-white via-[#fffdf8] to-[#f7f2e6] text-sm font-black text-[#1d2947] shadow-[0_14px_32px_rgba(29,41,71,0.12)] transition hover:-translate-y-0.5 hover:border-[#b08a38] hover:bg-[#fffaf0] hover:text-[#10213b] disabled:opacity-70"
            >
              {loading === 'google' ? (
                <Loader2 className="ml-2 h-5 w-5 animate-spin text-[#b08a38]" />
              ) : (
                <span className="ml-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-lg font-black shadow-sm">
                  <span className="text-[#4285f4]">G</span>
                </span>
              )}
              المتابعة باستخدام Google
            </Button>
            <div className="mb-4 flex items-center gap-3 text-[11px] font-bold text-slate-400">
              <span className="h-px flex-1 bg-gradient-to-l from-transparent via-slate-200 to-slate-200" />
              أو استخدم البريد الإلكتروني
              <span className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-200 to-slate-200" />
            </div>

            <Tabs defaultValue="login" dir="rtl">
              <TabsList className="grid h-12 w-full grid-cols-2 rounded-2xl bg-[#edf0f7] p-1">
                <TabsTrigger value="login" className="rounded-xl text-sm font-black data-[state=active]:bg-[#1d2947] data-[state=active]:text-white">تسجيل الدخول</TabsTrigger>
                <TabsTrigger value="register" className="rounded-xl text-sm font-black data-[state=active]:bg-[#bf1646] data-[state=active]:text-white">حساب جديد</TabsTrigger>
              </TabsList>

              <TabsContent value="login">
                <div className="mt-5 rounded-[1.5rem] border border-[#d9c38a]/35 bg-gradient-to-l from-[#fffaf0] via-white to-[#f8fafc] p-3 shadow-[0_12px_28px_rgba(29,41,71,0.10)]">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!!loading}
                    onClick={doGoogleLogin}
                    className="h-[52px] w-full rounded-[1.25rem] border border-white bg-white/90 text-sm font-black text-[#1d2947] shadow-sm transition hover:-translate-y-0.5 hover:bg-white hover:text-[#10213b] disabled:opacity-70"
                  >
                    {loading === 'google' ? (
                      <Loader2 className="ml-2 h-5 w-5 animate-spin text-[#b08a38]" />
                    ) : (
                      <span className="ml-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-slate-200 bg-white text-lg font-black shadow-sm">
                        <span className="text-[#4285f4]">G</span>
                      </span>
                    )}
                    المتابعة باستخدام Google
                  </Button>
                </div>
                <form onSubmit={doLogin} className="mt-5 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email" className="font-black text-[#1d2947]"><Mail className="ml-1 inline h-4 w-4 text-[#bf1646]" /> البريد الإلكتروني</Label>
                    <Input
                      id="login-email" type="email" required dir="ltr" placeholder="you@example.com"
                      className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold focus-visible:ring-[#bf1646]"
                      value={loginData.email}
                      onChange={(e) => setLoginData({ ...loginData, email: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="login-pass" className="font-black text-[#1d2947]"><LockKeyhole className="ml-1 inline h-4 w-4 text-[#bf1646]" /> كلمة المرور</Label>
                    <Input
                      id="login-pass" type="password" required dir="ltr" placeholder="••••••••"
                      className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold focus-visible:ring-[#bf1646]"
                      value={loginData.password}
                      onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                    />
                  </div>
                  <Button type="submit" disabled={!!loading} className="h-12 w-full rounded-2xl bg-[#bf1646] text-base font-black text-white shadow-lg shadow-[#bf1646]/25 hover:bg-[#a61139]">
                    {loading === 'login' ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : <LogIn className="ml-2 h-5 w-5" />}
                    دخول إلى المنصة
                  </Button>
                  <p className="text-center text-[11px] font-bold leading-6 text-slate-400">
                    دخول الإدارة والمشرف والطالب من نفس البوابة، والصلاحيات تظهر تلقائياً بعد الدخول.
                  </p>
                </form>
              </TabsContent>

              <TabsContent value="register">
                <form onSubmit={doRegister} className="mt-6 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="reg-name" className="font-black text-[#1d2947]"><UserRound className="ml-1 inline h-4 w-4 text-[#bf1646]" /> الاسم الكامل *</Label>
                    <Input id="reg-name" required placeholder="مثال: أحمد محمد" className="h-12 rounded-2xl border-slate-200 bg-slate-50 font-bold focus-visible:ring-[#bf1646]"
                      value={regData.name} onChange={(e) => setRegData({ ...regData, name: e.target.value })} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="reg-email" className="font-black text-[#1d2947]"><Mail className="ml-1 inline h-4 w-4 text-[#bf1646]" /> البريد الإلكتروني *</Label>
                      <Input id="reg-email" type="email" required dir="ltr" className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold focus-visible:ring-[#bf1646]" placeholder="you@example.com"
                        value={regData.email} onChange={(e) => setRegData({ ...regData, email: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-pass" className="font-black text-[#1d2947]"><LockKeyhole className="ml-1 inline h-4 w-4 text-[#bf1646]" /> كلمة المرور *</Label>
                      <Input id="reg-pass" type="password" required minLength={6} dir="ltr" className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold focus-visible:ring-[#bf1646]" placeholder="6 أحرف على الأقل"
                        value={regData.password} onChange={(e) => setRegData({ ...regData, password: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="reg-phone" className="font-black text-[#1d2947]"><Phone className="ml-1 inline h-4 w-4 text-[#bf1646]" /> رقم الهاتف / واتساب</Label>
                      <Input id="reg-phone" dir="ltr" className="h-12 rounded-2xl border-slate-200 bg-slate-50 text-left font-bold focus-visible:ring-[#bf1646]" placeholder="+9665xxxxxxxx"
                        value={regData.phone} onChange={(e) => setRegData({ ...regData, phone: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-country" className="font-black text-[#1d2947]"><MapPin className="ml-1 inline h-4 w-4 text-[#bf1646]" /> الدولة</Label>
                      <Input id="reg-country" className="h-12 rounded-2xl border-slate-200 bg-slate-50 font-bold focus-visible:ring-[#bf1646]" placeholder="مثال: مصر"
                        value={regData.country} onChange={(e) => setRegData({ ...regData, country: e.target.value })} />
                    </div>
                  </div>
                  <Button type="submit" disabled={!!loading} className="h-12 w-full rounded-2xl bg-[#1d2947] text-base font-black text-white shadow-lg shadow-[#1d2947]/20 hover:bg-[#26375e]">
                    {loading === 'register' ? <Loader2 className="ml-2 h-5 w-5 animate-spin" /> : <UserPlus className="ml-2 h-5 w-5" />}
                    إنشاء الحساب والانضمام
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </section>
      </div>
    </div>
  )
}
