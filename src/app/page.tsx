'use client'

import { api, getToken, saveToken, useAppStore } from '@/lib/store'
import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AcademyLogo, Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { HomeView } from '@/components/aact/HomeView'
import { ProgramsView } from '@/components/aact/ProgramsView'
import { ProgramDetailsView } from '@/components/aact/ProgramDetailsView'
import { ApplyView } from '@/components/aact/ApplyView'
import { AuthView } from '@/components/aact/AuthView'
import { VerifyView } from '@/components/aact/VerifyView'
import { DirectoryView } from '@/components/aact/DirectoryView'
import { AboutView } from '@/components/aact/AboutView'
import { ContactView } from '@/components/aact/ContactView'
import { Loader2 } from 'lucide-react'
import { unlockAudioOnFirstGesture } from '@/lib/audioPlayer'

function LazyViewLoader() {
  return (
    <div className="flex h-[60vh] items-center justify-center bg-[#eef0f5]">
      <div className="rounded-[2rem] border border-[#1d2947]/10 bg-white px-7 py-6 text-center shadow-xl">
        <AcademyLogo size={64} className="mx-auto mb-3" />
        <Loader2 className="mx-auto h-7 w-7 animate-spin text-[#bf1646]" />
        <p className="mt-3 text-[11px] font-black tracking-[0.22em] text-[#1d2947]/55">LOADING MODULE</p>
      </div>
    </div>
  )
}

function AcademyStartupScreen({ label = 'SYSTEM INITIALIZATION', onDone }: { label?: string; onDone?: () => void }) {
  const [progress, setProgress] = useState(1)
  const onDoneRef = useRef(onDone)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    let value = 1
    const t = window.setInterval(() => {
      value += 1
      setProgress(Math.min(100, value))
      if (value >= 100) {
        window.clearInterval(t)
        window.setTimeout(() => onDoneRef.current?.(), 420)
      }
    }, 24)
    return () => window.clearInterval(t)
  }, [])

  return (
    <div className="aact-startup-screen flex min-h-screen items-center justify-center px-8 text-white">
      <div className="w-full max-w-xl text-center">
        <div className="mx-auto mb-12 flex h-44 w-44 items-center justify-center rounded-full bg-white/5 shadow-2xl ring-1 ring-white/10 sm:h-52 sm:w-52">
          <AcademyLogo size={150} light />
        </div>
        <div className="flex items-end justify-center gap-3 font-black leading-none">
          <span className="text-[7rem] tracking-tight sm:text-[9rem]">{String(progress).padStart(2, '0')}</span>
          <span className="mb-5 text-4xl text-[#8d1b32] sm:mb-7 sm:text-5xl">%</span>
        </div>
        <p className="mt-7 text-[11px] font-black uppercase tracking-[0.72em] text-white/42 sm:text-xs">AMERICAN ACADEMY</p>
        <p className="mt-4 text-[10px] font-black uppercase tracking-[0.48em] text-[#bf1646]/90">{label}</p>
        <div className="mx-auto mt-12 h-px w-full max-w-md overflow-hidden bg-white/18">
          <div className="h-full bg-white transition-all duration-150" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  )
}

const DashboardView = dynamic(() => import('@/components/aact/DashboardView').then((m) => m.DashboardView), { ssr: false, loading: LazyViewLoader })
const UnitView = dynamic(() => import('@/components/aact/UnitView').then((m) => m.UnitView), { ssr: false, loading: LazyViewLoader })
const ExamView = dynamic(() => import('@/components/aact/ExamView').then((m) => m.ExamView), { ssr: false, loading: LazyViewLoader })
const AIChatView = dynamic(() => import('@/components/aact/AIChatView').then((m) => m.AIChatView), { ssr: false, loading: LazyViewLoader })
const AgentView = dynamic(() => import('@/components/aact/AgentView').then((m) => m.AgentView), { ssr: false, loading: LazyViewLoader })
const AdminView = dynamic(() => import('@/components/aact/AdminView').then((m) => m.AdminView), { ssr: false, loading: LazyViewLoader })
const SupervisorView = dynamic(() => import('@/components/aact/SupervisorView').then((m) => m.SupervisorView), { ssr: false, loading: LazyViewLoader })
const AdminStudentPreview = dynamic(() => import('@/components/aact/AdminStudentPreview').then((m) => m.AdminStudentPreview), { ssr: false, loading: LazyViewLoader })
const AdminAgentPreview = dynamic(() => import('@/components/aact/AdminAgentPreview').then((m) => m.AdminAgentPreview), { ssr: false, loading: LazyViewLoader })

function PWARegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])
  return null
}

export default function Home() {
  const {
    view,
    user,
    setUser,
    authChecked,
    setAuthChecked,
    programDetailsId,
    activeProgramId,
    activeUnitId,
    activeExamId,
    programsFilter,
    studentPreviewId,
    agentPreviewId,
  } = useAppStore()
  const didAutoRouteRef = useRef(false)
  const [authRecovering, setAuthRecovering] = useState(false)
  const [startupDone, setStartupDone] = useState(false)

  // Load current user on mount
  useEffect(() => {
    let alive = true
    const q = new URLSearchParams(window.location.search)
    const oauthToken = q.get('authToken')
    if (oauthToken) {
      saveToken(oauthToken)
      q.delete('authToken')
      q.delete('oauth')
      const cleanUrl = `${window.location.pathname}${q.toString() ? `?${q.toString()}` : ''}${window.location.hash}`
      window.history.replaceState(null, '', cleanUrl)
    }
    const currentView = q.get('view') || view
    const protectedViews = ['dashboard', 'unit', 'exam', 'chat', 'admin', 'supervisor', 'student-preview', 'agent-preview']
    api<{ user: any }>('/api/auth/me')
      .then((d) => {
        if (!alive) return
        setAuthRecovering(false)
        setUser(d.user)
      })
      .catch(() => {
        if (!alive) return
        // عند رجوع Safari/Chrome من كاميرا الفيديو أو ضعف الشبكة قد يفشل فحص الجلسة لحظياً.
        // لا نرمي المستخدم للرئيسية إذا كان معه رمز جلسة ويحاول فتح صفحة محمية، بل نعرض شاشة إعادة اتصال.
        if (getToken() && protectedViews.includes(currentView)) setAuthRecovering(true)
        else setUser(null)
      })
      .finally(() => { if (alive) setAuthChecked(true) })

    // فتح قناة الصوت عالمياً بأول لمسة — يضمن عمل النطق (TTS) على iOS Safari
    unlockAudioOnFirstGesture()

    // دعم فتح الصفحات مباشرة برابط: /?view=admin أو /?view=verify&serial=...
    const v = q.get('view')
    const validViews = ['home', 'programs', 'program-detail', 'apply', 'auth', 'dashboard', 'unit', 'exam', 'chat', 'agent', 'admin', 'supervisor', 'student-preview', 'agent-preview', 'verify', 'directory', 'about', 'contact']
    if (v && validViews.includes(v)) {
      const programId = q.get('programId') || q.get('program') || q.get('slug')
      if (v === 'program-detail' && programId) {
        useAppStore.getState().openProgramDetails(programId)
      } else if (v === 'programs' && q.get('filter')) {
        useAppStore.getState().openPrograms(q.get('filter') || undefined)
      } else if (v === 'dashboard' && programId) {
        useAppStore.getState().openProgram(programId)
      } else if (v === 'unit' && q.get('unitId')) {
        useAppStore.getState().openUnit(q.get('unitId') || '')
      } else if (v === 'exam' && q.get('examId')) {
        useAppStore.getState().openExam(q.get('examId') || '', q.get('kind') === 'final' ? 'final' : 'unit')
      } else if (v === 'student-preview' && q.get('studentId')) {
        useAppStore.getState().openStudentPreview(q.get('studentId') || '')
      } else if (v === 'agent-preview' && q.get('agentId')) {
        useAppStore.getState().openAgentPreview(q.get('agentId') || '')
      } else {
        useAppStore.getState().navigate(v as any)
      }
    }
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!authChecked || didAutoRouteRef.current) return
    // بعد شاشة البداية يبقى الزائر في الصفحة الرئيسية كما في الموقع الرسمي.
    // توجيه الطالب/الإدارة يتم فقط بعد تسجيل الدخول أو عند فتح رابط مباشر فيه ?view=...
    didAutoRouteRef.current = true
  }, [authChecked])

  const studentOnlyViews = ['dashboard', 'unit', 'exam']
  const protectedViews = ['dashboard', 'unit', 'exam', 'chat', 'admin', 'supervisor', 'student-preview', 'agent-preview']
  const needsAuthRecovery = authChecked && authRecovering && protectedViews.includes(view)
  const effectiveView = needsAuthRecovery
    ? view
    : authChecked && user?.role !== 'STUDENT' && studentOnlyViews.includes(view)
      ? (user?.role === 'ADMIN' ? 'admin' : user?.role === 'SUPERVISOR' ? 'supervisor' : 'home')
      : authChecked && view === 'supervisor' && user?.role !== 'SUPERVISOR'
        ? 'home'
      : authChecked && (view === 'student-preview' || view === 'agent-preview') && user?.role !== 'ADMIN'
        ? 'home'
        : view

  const retryAuthCheck = async () => {
    setAuthRecovering(false)
    setAuthChecked(false)
    try {
      const d = await api<{ user: any }>('/api/auth/me')
      setUser(d.user)
    } catch {
      if (getToken() && protectedViews.includes(view)) setAuthRecovering(true)
      else setUser(null)
    } finally {
      setAuthChecked(true)
    }
  }

  useEffect(() => {
    if (!authChecked) return
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
      document.documentElement.scrollTop = 0
      document.body.scrollTop = 0
    })
  }, [authChecked, effectiveView, programDetailsId, activeProgramId, activeUnitId, activeExamId, programsFilter, studentPreviewId, agentPreviewId])

  const showChrome = startupDone && authChecked && !needsAuthRecovery && effectiveView !== 'auth'

  return (
    <div className="flex min-h-screen flex-col bg-[#eef0f5]">
      <PWARegister />
      {showChrome && <Header />}
      <main className="flex-1">
        {!startupDone || !authChecked ? (
          <AcademyStartupScreen onDone={() => setStartupDone(true)} />
        ) : needsAuthRecovery ? (
          <div className="mx-auto flex min-h-[60vh] max-w-xl items-center justify-center px-4">
            <div className="rounded-3xl border border-amber-200 bg-white p-6 text-center shadow-lg">
              <Loader2 className="mx-auto mb-3 h-9 w-9 animate-spin text-[#c9a227]" />
              <h1 className="text-lg font-black text-[#0f2b46]">جاري استعادة الجلسة</h1>
              <p className="mt-2 text-sm font-bold leading-7 text-slate-600">
                حدث انقطاع مؤقت أثناء فتح صفحة محمية مثل قاعة المناقشة أو بوابة الطالب. لن يتم تحويلك للرئيسية تلقائياً؛ أعد المحاولة أو انتظر ثواني حتى يعود الاتصال.
              </p>
              <button onClick={retryAuthCheck} className="mt-5 rounded-xl bg-[#0f2b46] px-5 py-3 text-sm font-black text-[#f5f0e1] shadow hover:bg-[#12365c]">
                إعادة الاتصال بالجلسة
              </button>
            </div>
          </div>
        ) : (
          <>
            {effectiveView === 'home' && <HomeView />}
            {effectiveView === 'programs' && <ProgramsView />}
            {effectiveView === 'program-detail' && <ProgramDetailsView />}
            {effectiveView === 'apply' && <ApplyView />}
            {effectiveView === 'auth' && <AuthView />}
            {effectiveView === 'dashboard' && <DashboardView />}
            {effectiveView === 'unit' && <UnitView />}
            {effectiveView === 'exam' && <ExamView />}
            {effectiveView === 'chat' && <AIChatView />}
            {effectiveView === 'agent' && <AgentView />}
            {effectiveView === 'admin' && <AdminView />}
            {effectiveView === 'supervisor' && <SupervisorView />}
            {effectiveView === 'student-preview' && <AdminStudentPreview />}
            {effectiveView === 'agent-preview' && <AdminAgentPreview />}
            {effectiveView === 'verify' && <VerifyView />}
            {effectiveView === 'directory' && <DirectoryView />}
            {effectiveView === 'about' && <AboutView />}
            {effectiveView === 'contact' && <ContactView />}
          </>
        )}
      </main>
      {showChrome && effectiveView !== 'chat' && <Footer />}
      {showChrome && <FloatingActions />}
    </div>
  )
}
