'use client'

import { useAppStore, api, saveToken } from '@/lib/store'
import { AcademyLogo } from '@/components/aact/Shell'
import { useState } from 'react'
import { toast, useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Loader2, LogIn, UserPlus, ShieldCheck, GraduationCap, Bot } from 'lucide-react'

export function AuthView() {
  const { setUser, navigate } = useAppStore()
  const { toast } = useToast()
  const [loading, setLoading] = useState<'login' | 'register' | null>(null)

  const [loginData, setLoginData] = useState({ email: '', password: '' })
  const [regData, setRegData] = useState({ name: '', email: '', password: '', phone: '', country: '' })

  const doLogin = async (e?: React.FormEvent) => {
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
      navigate(d.user.role === 'ADMIN' ? 'admin' : 'dashboard')
    } catch (err: any) {
      toast({ title: 'خطأ في الدخول', description: err.message, variant: 'destructive' })
    } finally {
      setLoading(null)
    }
  }

  const doRegister = async (e?: React.FormEvent) => {
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

  return (
    <div className="aact-fade-in mx-auto max-w-5xl px-4 py-10">
      <div className="grid items-start gap-8 lg:grid-cols-[1fr_1.1fr]">
        {/* Side info */}
        <div className="hidden lg:block">
          <h1 className="text-2xl font-black leading-snug text-[#0f2b46]">
            انضم إلى طلاب الأكاديمية الأمريكية للاستشارات والتدريب
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-slate-600">
            أنشئ حسابك المجاني لتحصل على: بوابة طالب متكاملة، محتوى الوحدات التدريبية كاملاً،
            مشرف ذكي بالذكاء الاصطناعي يرافقك صوتاً وكتابة، اختبارات تفاعلية يصححها الذكاء
            الاصطناعي مع تغذية راجعة فورية، وتتبع تقدمك حتى الشهادة.
          </p>
          <div className="mt-6 space-y-3">
            {[
              { icon: GraduationCap, t: 'دبلومات ودرجات مهنية معتمدة دولياً' },
              { icon: Bot, t: 'مشرف ذكي متاح على مدار الساعة صوت وكتابة' },
              { icon: ShieldCheck, t: 'شهادات تُصدر خلال 30 يوماً وفق العقد الرسمي' },
            ].map((f) => (
              <div key={f.t} className="flex items-center gap-3 rounded-xl border border-[#0f2b46]/10 bg-white p-3.5 shadow-sm">
                <div className="rounded-lg bg-[#0f2b46] p-2 text-[#e0b83a]">
                  <f.icon className="h-5 w-5" />
                </div>
                <span className="text-sm font-bold text-[#0f2b46]">{f.t}</span>
              </div>
            ))}
          </div>
          <div className="mt-6 rounded-xl border border-[#c9a227]/40 bg-[#f7edd0]/60 p-4 text-xs leading-relaxed text-[#5c4d1a]">
            <strong>حسابات تجريبية:</strong>
            <br />طالب: student@demo.com / Demo@2026
            <br />إدارة: admin@aact.academy / Admin@2026
          </div>
        </div>

        {/* Auth card */}
        <Card className="border-[#0f2b46]/15 shadow-xl">
          <CardHeader className="pb-2 text-center">
            <div className="mb-2 flex justify-center">
              <AcademyLogo size={72} />
            </div>
            <CardTitle className="text-xl font-black text-[#0f2b46]">حسابك في الأكاديمية</CardTitle>
            <CardDescription>سجل الدخول أو أنشئ حساباً جديداً مجاناً</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="login" dir="rtl">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login" className="font-bold">تسجيل الدخول</TabsTrigger>
                <TabsTrigger value="register" className="font-bold">حساب جديد</TabsTrigger>
              </TabsList>

              <TabsContent value="login">
                <form onSubmit={doLogin} className="mt-2 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email">البريد الإلكتروني</Label>
                    <Input
                      id="login-email" type="email" required dir="ltr" placeholder="you@example.com"
                      className="text-left" value={loginData.email}
                      onChange={(e) => setLoginData({ ...loginData, email: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="login-pass">كلمة المرور</Label>
                    <Input
                      id="login-pass" type="password" required dir="ltr" placeholder="••••••••"
                      className="text-left" value={loginData.password}
                      onChange={(e) => setLoginData({ ...loginData, password: e.target.value })}
                    />
                  </div>
                  <Button type="submit" disabled={!!loading} className="w-full bg-[#0f2b46] font-extrabold text-[#f5f0e1] hover:bg-[#12365c]">
                    {loading === 'login' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <LogIn className="ml-2 h-4 w-4" />}
                    تسجيل الدخول
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="register">
                <form onSubmit={doRegister} className="mt-2 space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="reg-name">الاسم الكامل *</Label>
                    <Input id="reg-name" required placeholder="مثال: أحمد محمد"
                      value={regData.name} onChange={(e) => setRegData({ ...regData, name: e.target.value })} />
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="reg-email">البريد الإلكتروني *</Label>
                      <Input id="reg-email" type="email" required dir="ltr" className="text-left" placeholder="you@example.com"
                        value={regData.email} onChange={(e) => setRegData({ ...regData, email: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-pass">كلمة المرور *</Label>
                      <Input id="reg-pass" type="password" required minLength={6} dir="ltr" className="text-left" placeholder="6 أحرف على الأقل"
                        value={regData.password} onChange={(e) => setRegData({ ...regData, password: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="reg-phone">رقم الهاتف / واتساب</Label>
                      <Input id="reg-phone" dir="ltr" className="text-left" placeholder="+9665xxxxxxxx"
                        value={regData.phone} onChange={(e) => setRegData({ ...regData, phone: e.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-country">الدولة</Label>
                      <Input id="reg-country" placeholder="مثال: مصر"
                        value={regData.country} onChange={(e) => setRegData({ ...regData, country: e.target.value })} />
                    </div>
                  </div>
                  <Button type="submit" disabled={!!loading} className="w-full bg-[#c9a227] font-extrabold text-[#0f2b46] hover:bg-[#e0b83a]">
                    {loading === 'register' ? <Loader2 className="ml-2 h-4 w-4 animate-spin" /> : <UserPlus className="ml-2 h-4 w-4" />}
                    إنشاء الحساب والانضمام
                  </Button>
                </form>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
