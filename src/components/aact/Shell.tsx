'use client'

import { useAppStore, api, clearToken } from '@/lib/store'
import { ACADEMY_INFO } from '@/lib/academyData'
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, ShieldCheck, Download } from 'lucide-react'

// أزرار عائمة: واتساب مباشر + العودة للأعلى — تختفي عند الطباعة
export function FloatingActions() {
  const { view } = useAppStore()
  const [showTop, setShowTop] = useState(false)
  const inChat = view === 'chat'
  const whatsappDigits = ACADEMY_INFO.whatsapp.replace(/\D/g, '')

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 420)
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className={`aact-no-print fixed left-4 z-40 flex flex-col items-center gap-2.5 transition-all duration-300 ${inChat ? 'bottom-28 sm:bottom-24' : 'bottom-4'}`}>
      {/* العودة للأعلى — يظهر بعد التمرير */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label="العودة للأعلى"
        className={`flex h-11 w-11 items-center justify-center rounded-full border border-[#c9a227]/50 bg-[#0f2b46] text-[#e0b83a] shadow-lg transition-all duration-300 hover:bg-[#12365c] ${
          showTop ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'
        }`}
      >
        <ChevronUp className="h-5 w-5" />
      </button>
      {/* واتساب — تواصل فوري مع الأكاديمية */}
      <a
        href={`https://wa.me/14748677271?text=${encodeURIComponent('مرحباً، أرغب في الاستفسار عن برامج الأكاديمية الأمريكية للاستشارات والتدريب')}`}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="تواصل معنا عبر واتساب"
        title="تواصل معنا عبر واتساب — +1 (474) 867-7271"
        className="group relative flex h-14 w-14 items-center justify-center rounded-full bg-[#25d366] text-white shadow-xl transition-transform duration-300 hover:scale-110"
      >
        <span className="absolute inset-0 animate-ping rounded-full bg-[#25d366]/40" aria-hidden="true" />
        <svg viewBox="0 0 24 24" className="relative h-7 w-7 fill-current" aria-hidden="true">
          <path d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.03c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.26 8.26 0 0 1-1.26-4.38c0-4.54 3.7-8.24 8.25-8.24 4.54 0 8.24 3.7 8.24 8.24s-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.13-.17.25-.64.81-.78.97-.15.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.17-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.41-.42-.56-.43h-.48c-.17 0-.43.06-.66.31-.22.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.67-1.18.21-.58.21-1.07.14-1.18-.06-.11-.22-.17-.47-.29z" />
        </svg>
        <span className="pointer-events-none absolute right-full ml-2 hidden whitespace-nowrap rounded-lg bg-[#0f2b46] px-3 py-1.5 text-[11px] font-bold text-white shadow-lg group-hover:block">
          استفسر عبر واتساب
        </span>
      </a>
    </div>
  )
}

// الشعار الرسمي للأكاديمية (الختم الدائري المعتمد) — صورة واحدة في كل الموقع
export function AcademyLogo({
  size = 44,
  light = false,
  className = '',
}: {
  size?: number
  light?: boolean
  className?: string
}) {
  // /logo.png الموجود في المستودع فارغ حالياً، لذلك نبدأ من أيقونة التطبيق الحقيقية حتى لا يظهر رمز الصورة المكسورة في الهيدر.
  const sources = ['/icon-192.png', '/apple-touch-icon.png']
  const [srcIndex, setSrcIndex] = useState(0)
  const [failed, setFailed] = useState(false)
  const ring = light ? 'ring-2 ring-[#c9a227]/70 ring-offset-2 ring-offset-[#0f2b46]' : ''

  if (failed) {
    return (
      <span
        aria-label="شعار الأكاديمية الأمريكية للاستشارات والتدريب — AACT"
        className={`flex shrink-0 select-none items-center justify-center rounded-full border-2 border-[#c9a227] bg-[#0f2b46] text-center font-black leading-none text-[#e0b83a] ${ring} ${className}`}
        style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.28)) }}
      >
        AACT
      </span>
    )
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={sources[srcIndex]}
      src={sources[srcIndex]}
      alt="شعار الأكاديمية الأمريكية للاستشارات والتدريب — AACT"
      width={size}
      height={size}
      className={`shrink-0 select-none rounded-full object-cover ${ring} ${className}`}
      style={{ width: size, height: size }}
      draggable={false}
      onError={() => {
        if (srcIndex < sources.length - 1) setSrcIndex((i) => i + 1)
        else setFailed(true)
      }}
    />
  )
}

interface Notif {
  id: string
  type: string
  title: string
  body: string
  read: boolean
  createdAt: string
  link?: string
}

function NotificationBell() {
  const { user, navigate } = useAppStore()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notif[]>([])
  const [unread, setUnread] = useState(0)

  const load = () => {
    if (!user) return
    api<{ notifications: Notif[]; unread: number }>('/api/notifications')
      .then((d) => {
        setItems(d.notifications)
        setUnread(d.unread)
      })
      .catch(() => {})
  }

  useEffect(() => {
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (!user) return null

  const markAll = async () => {
    await api('/api/notifications', { method: 'PATCH', body: JSON.stringify({}) }).catch(() => {})
    setUnread(0)
    setItems((prev) => prev.map((n) => ({ ...n, read: true })))
  }

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open)
          if (!open) load()
        }}
        className="relative rounded-lg p-2 text-[#f5f0e1] hover:bg-white/10"
        aria-label="الإشعارات"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {unread > 0 && (
          <span className="absolute -left-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-[#b22234] px-1 text-[10px] font-black text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-[#c9a227]/30 bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 bg-[#f7edd0]/60 px-4 py-3">
              <span className="text-sm font-black text-[#0f2b46]">الإشعارات</span>
              {unread > 0 && (
                <button onClick={markAll} className="text-[11px] font-bold text-[#a8841a] hover:underline">
                  تحديد الكل كمقروء
                </button>
              )}
            </div>
            <div className="aact-scroll max-h-80 overflow-y-auto">
              {items.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">لا توجد إشعارات بعد</div>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => {
                      setOpen(false)
                      if (n.link) navigate(n.link as any)
                      if (!n.read) api('/api/notifications', { method: 'PATCH', body: JSON.stringify({ id: n.id }) }).then(load).catch(() => {})
                    }}
                    className={`block w-full border-b border-slate-50 px-4 py-3 text-right transition-colors hover:bg-[#f7edd0]/40 ${
                      n.read ? '' : 'bg-[#c9a227]/5'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-black text-[#0f2b46]">{n.title}</span>
                      {!n.read && <span className="h-2 w-2 shrink-0 rounded-full bg-[#b22234]" />}
                    </div>
                    <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-500">{n.body}</p>
                    <span className="mt-1 block text-[10px] text-slate-300">
                      {new Date(n.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function Header() {
  const { user, setUser, navigate, view, mobileMenuOpen, setMobileMenuOpen } = useAppStore()

  // ===== التنقل العلمي: العناصر مجمعة في مجموعات وظيفية واضحة =====
  const studentItems: { label: string; target: any; desc: string }[] = [
    { label: 'بوابة الطالب', target: 'dashboard', desc: 'برامجك، دفعاتك، بحثك، شهاداتك' },
    { label: 'المشرف الذكي', target: 'chat', desc: 'محادثة نصية وصوتية حية' },
  ]
  const academyItems: { label: string; target: any; desc: string }[] = [
    { label: 'الوكالة والاعتماد', target: 'agent', desc: 'تمثيل دولي واعتماد مؤسسات' },
    { label: 'دليل المعتمدين', target: 'directory', desc: 'وكلاء ومستشارون معتمدون' },
    { label: 'التحقق من شهادة', target: 'verify', desc: 'تحقق فوري برقم الشهادة' },
    { label: 'تواصل معنا', target: 'contact', desc: 'استفسارات ودعم' },
  ]

  const isActiveGroup = (targets: any[]) => targets.includes(view)

  const GroupMenu = ({ label, items, groupTargets, gold }: { label: string; items: { label: string; target: any; desc: string }[]; groupTargets: any[]; gold?: boolean }) => {
    const [open, setOpen] = useState(false)
    const active = isActiveGroup(groupTargets)
    return (
      <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
        <button
          onClick={() => setOpen(true)}
          className={`flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
            active ? 'text-[#e0b83a]' : 'text-[#f5f0e1]/85 hover:bg-white/10 hover:text-[#f5f0e1]'
          }`}
        >
          {label}
          <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div className="absolute right-0 top-full z-50 w-72 pt-1">
            <div className="overflow-hidden rounded-xl border border-[#c9a227]/25 bg-white shadow-2xl">
              {items.map((it) => (
                <button
                  key={it.target}
                  onClick={() => { setOpen(false); navigate(it.target) }}
                  className={`block w-full border-b border-slate-100 px-4 py-3 text-right transition-colors last:border-0 hover:bg-[#f7edd0]/60 ${view === it.target ? 'bg-[#f7edd0]' : ''}`}
                >
                  <span className={`block text-sm font-black ${view === it.target || gold ? 'text-[#a8841a]' : 'text-[#0f2b46]'}`}>{it.label}</span>
                  <span className="block text-[10px] leading-relaxed text-slate-400">{it.desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <header className="sticky top-0 z-50 border-b border-[#c9a227]/30 bg-[#0f2b46]/95 backdrop-blur supports-[backdrop-filter]:bg-[#0f2b46]/85">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4">
        <button
          onClick={() => navigate('home')}
          className="flex items-center gap-2.5 text-right"
          aria-label="الصفحة الرئيسية"
        >
          <AcademyLogo size={42} />
          <div className="leading-tight">
            <div className="text-[13px] font-extrabold text-[#f5f0e1] sm:text-sm">
              الأكاديمية الأمريكية
            </div>
            <div className="text-[10px] font-semibold text-[#c9a227] sm:text-[11px]">
              للاستشارات والتدريب — EST. 2016
            </div>
          </div>
        </button>

        {/* Desktop nav — تنظيم علمي: مسار عام ← مسار الطالب ← مسار الأكاديمية */}
        <nav className="hidden items-center gap-0.5 lg:flex" aria-label="التنقل الرئيسي">
          <button
            onClick={() => navigate('home')}
            className={`rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
              view === 'home' ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#f5f0e1]/85 hover:bg-white/10 hover:text-[#f5f0e1]'
            }`}
          >
            الرئيسية
          </button>
          <button
            onClick={() => navigate('programs')}
            className={`rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
              (view === 'programs' || view === 'program-detail') ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#f5f0e1]/85 hover:bg-white/10 hover:text-[#f5f0e1]'
            }`}
          >
            البرامج
          </button>
          <button
            onClick={() => navigate('apply')}
            className={`rounded-lg px-3 py-2 text-sm font-bold transition-colors ${
              view === 'apply' ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#f5f0e1]/85 hover:bg-white/10 hover:text-[#f5f0e1]'
            }`}
          >
            طلب الالتحاق
          </button>
          {user && <GroupMenu label="بوابة الدراسة" items={studentItems} groupTargets={['dashboard', 'chat', 'unit', 'exam']} />}
          <GroupMenu label="الأكاديمية" items={academyItems} groupTargets={['agent', 'directory', 'verify', 'contact']} />
          {user?.role === 'ADMIN' && (
            <button
              onClick={() => navigate('admin')}
              className={`flex items-center gap-1.5 rounded-lg border-2 border-[#c9a227] px-3 py-1.5 text-sm font-black shadow transition-colors ${
                view === 'admin' ? 'bg-[#f5f0e1] text-[#0f2b46]' : 'bg-[#c9a227] text-[#0f2b46] hover:bg-[#e0b83a]'
              }`}
              title="إدارة طلبات الالتحاق والطلاب والمالية والامتحانات"
            >
              <ShieldCheck className="h-4 w-4" />
              لوحة الإدارة
            </button>
          )}
          {user ? (
            <div className="mr-2 flex items-center gap-2 border-r border-white/15 pr-3">
              <NotificationBell />
              <div className="text-left leading-tight">
                <div className="max-w-[120px] truncate text-xs font-bold text-[#f5f0e1]">
                  {user.name}
                </div>
                <div className="text-[10px] text-[#c9a227]">مرحباً بك مجدداً</div>
              </div>
              <button
                onClick={async () => {
                  await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
                  clearToken()
                  setUser(null)
                  navigate('home')
                }}
                className="rounded-lg border border-white/25 px-3 py-1.5 text-xs font-bold text-[#f5f0e1] hover:bg-white/10"
              >
                خروج
              </button>
            </div>
          ) : (
            <button
              onClick={() => navigate('auth')}
              className="mr-2 rounded-lg bg-[#c9a227] px-4 py-2 text-sm font-extrabold text-[#0f2b46] shadow hover:bg-[#e0b83a]"
            >
              دخول / تسجيل
            </button>
          )}
        </nav>

        {/* Mobile menu button */}
        <button
          className="rounded-lg p-2 text-[#f5f0e1] hover:bg-white/10 lg:hidden"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="القائمة"
          aria-expanded={mobileMenuOpen}
        >
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {mobileMenuOpen ? (
              <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" strokeLinecap="round" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile nav — مجمعة بعناوين أقسام واضحة */}
      {mobileMenuOpen && (
        <div className="border-t border-white/10 bg-[#0f2b46] px-4 pb-4 pt-2 lg:hidden">
          <div className="flex flex-col gap-1">
            <p className="mb-1 mt-2 text-[10px] font-black text-[#c9a227]/70">الرئيسية والبرامج</p>
            {[
              { label: 'الرئيسية', target: 'home' as const },
              { label: 'البرامج التدريبية', target: 'programs' as const },
              { label: 'طلب الالتحاق وتتبعه', target: 'apply' as const },
            ].map((n) => (
              <button
                key={n.target}
                onClick={() => navigate(n.target)}
                className={`rounded-lg px-4 py-2.5 text-right text-sm font-bold ${
                  (view === n.target || (n.target === 'programs' && view === 'program-detail')) ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#f5f0e1] hover:bg-white/10'
                }`}
              >
                {n.label}
              </button>
            ))}
            {user && (
              <>
                <p className="mb-1 mt-3 text-[10px] font-black text-[#c9a227]/70">بوابة الدراسة</p>
                {studentItems.map((n) => (
                  <button
                    key={n.target}
                    onClick={() => navigate(n.target)}
                    className={`rounded-lg px-4 py-2.5 text-right text-sm font-bold ${
                      view === n.target ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#f5f0e1] hover:bg-white/10'
                    }`}
                  >
                    {n.label}
                  </button>
                ))}
              </>
            )}
            <p className="mb-1 mt-3 text-[10px] font-black text-[#c9a227]/70">الأكاديمية والخدمات</p>
            {academyItems.map((n) => (
              <button
                key={n.target}
                onClick={() => navigate(n.target)}
                className={`rounded-lg px-4 py-2.5 text-right text-sm font-bold ${
                  view === n.target ? 'bg-[#c9a227] text-[#0f2b46]' : 'text-[#f5f0e1] hover:bg-white/10'
                }`}
              >
                {n.label}
              </button>
            ))}
            {user?.role === 'ADMIN' && (
              <button
                onClick={() => navigate('admin')}
                className={`mt-2 flex items-center gap-2 rounded-lg bg-[#c9a227] px-4 py-3 text-right text-sm font-black text-[#0f2b46] shadow ${
                  view === 'admin' ? 'bg-[#f5f0e1]' : ''
                }`}
              >
                <ShieldCheck className="h-4 w-4" />
                لوحة الإدارة — طلبات الالتحاق والطلاب والمالية
              </button>
            )}
            {user ? (
              <button
                onClick={async () => {
                  await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
                  clearToken()
                  setUser(null)
                  navigate('home')
                }}
                className="mt-2 rounded-lg border border-white/25 px-4 py-3 text-right text-sm font-bold text-[#f5f0e1] hover:bg-white/10"
              >
                تسجيل الخروج ({user.name})
              </button>
            ) : (
              <button
                onClick={() => navigate('auth')}
                className="mt-2 rounded-lg bg-[#c9a227] px-4 py-3 text-sm font-extrabold text-[#0f2b46]"
              >
                دخول / تسجيل
              </button>
            )}
            <button
              onClick={() => navigate('contact')}
              className="mt-2 rounded-lg border border-[#c9a227]/40 px-4 py-3 text-right text-sm font-bold text-[#c9a227] hover:bg-white/10"
            >
              تواصل معنا
            </button>
          </div>
        </div>
      )}
    </header>
  )
}

export function Footer() {
  const { navigate } = useAppStore()
  return (
    <footer className="mt-auto border-t border-[#c9a227]/25 bg-[#0a1f36] text-[#f5f0e1]">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="mb-3 flex items-center gap-2">
            <AcademyLogo size={38} />
            <div className="text-sm font-extrabold">الأكاديمية الأمريكية للاستشارات والتدريب</div>
          </div>
          <p className="text-xs leading-relaxed text-[#f5f0e1]/70">
            بناء القيادات، صقل المهارات. أكاديمية رائدة منذ 2016 في الدبلومات المهنية والدرجات
            المهنية واعتماد المستشارين والمدربين ومراكز التدريب.
          </p>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-extrabold text-[#c9a227]">روابط سريعة</h4>
          <ul className="space-y-2 text-xs font-semibold text-[#f5f0e1]/80">
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('programs')}>البرامج التدريبية</button></li>
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('apply')}>طلب الالتحاق وتتبعه</button></li>
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('agent')}>الوكالة الدولية والاعتمادات</button></li>
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('directory')}>دليل المعتمدين والوكلاء</button></li>
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('verify')}>التحقق من صحة الشهادات</button></li>
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('contact')}>تواصل معنا</button></li>
            <li><button className="hover:text-[#c9a227]" onClick={() => navigate('auth')}>التسجيل في الأكاديمية</button></li>
          </ul>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-extrabold text-[#c9a227]">تواصل معنا</h4>
          <ul className="space-y-2 text-xs font-semibold text-[#f5f0e1]/80">
            <li dir="ltr" className="text-right">البريد: aact.academy2@gmail.com</li>
            <li dir="ltr" className="text-right">واتساب: +1 (474) 867-7271</li>
            <li>بناء القيادات، صقل المهارات</li>
            <li>Building Leaders, Refining Skills</li>
          </ul>
        </div>
        <div>
          <h4 className="mb-3 text-sm font-extrabold text-[#c9a227]">ثقة الأكاديمية</h4>
          <p className="text-xs leading-relaxed text-[#f5f0e1]/70">
            الشهادات تُصدر خلال 30 يوماً من استلام كشوف الدرجات والرسوم المقررة. الوكلاء الدوليون
            يحصلون على 25% من إيرادات منطقة التمثيل و100$ عن كل بحث تخرج يشاركون في لجنة مناقشته.
          </p>
        </div>
      </div>
      <div className="border-t border-white/10 py-4 text-center text-[11px] text-[#f5f0e1]/60">
        © {new Date().getFullYear()} American Academy for Consulting and Training — جميع الحقوق محفوظة
        <div className="mt-2">
          <a
            href="/AACT-Platform-v1.3.zip"
            download
            className="inline-flex items-center gap-1.5 rounded-full border border-[#c9a227]/30 px-3 py-1 text-[10px] font-bold text-[#c9a227]/70 transition-colors hover:bg-[#c9a227]/10 hover:text-[#c9a227]"
            title="تحميل الكود المصدري الكامل للمنصة كملف ZIP"
          >
            <Download className="h-3 w-3" />
            تحميل كود المنصة (ZIP)
          </a>
        </div>
      </div>
    </footer>
  )
}
