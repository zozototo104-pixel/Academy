'use client'

import { useAppStore } from '@/lib/store'
import { useEffect } from 'react'
import { Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { HomeView } from '@/components/aact/HomeView'
import { ProgramsView } from '@/components/aact/ProgramsView'
import { ProgramDetailsView } from '@/components/aact/ProgramDetailsView'
import { ApplyView } from '@/components/aact/ApplyView'
import { AuthView } from '@/components/aact/AuthView'
import { DashboardView } from '@/components/aact/DashboardView'
import { UnitView } from '@/components/aact/UnitView'
import { ExamView } from '@/components/aact/ExamView'
import { AIChatView } from '@/components/aact/AIChatView'
import { AgentView } from '@/components/aact/AgentView'
import { AdminView } from '@/components/aact/AdminView'
import { VerifyView } from '@/components/aact/VerifyView'
import { DirectoryView } from '@/components/aact/DirectoryView'
import { ContactView } from '@/components/aact/ContactView'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/store'
import { unlockAudioOnFirstGesture } from '@/lib/audioPlayer'

function PWARegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {})
    }
  }, [])
  return null
}

export default function Home() {
  const { view, user, setUser, authChecked, setAuthChecked } = useAppStore()

  // Load current user on mount
  useEffect(() => {
    api<{ user: any }>('/api/auth/me')
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true))

    // فتح قناة الصوت عالمياً بأول لمسة — يضمن عمل النطق (TTS) على iOS Safari
    unlockAudioOnFirstGesture()

    // دعم فتح الصفحات مباشرة برابط: /?view=admin أو /?view=verify&serial=...
    const q = new URLSearchParams(window.location.search)
    const v = q.get('view')
    const validViews = ['home', 'programs', 'program-detail', 'apply', 'auth', 'dashboard', 'unit', 'exam', 'chat', 'agent', 'admin', 'verify', 'directory', 'contact']
    if (v && validViews.includes(v)) {
      useAppStore.getState().navigate(v as any)
    }
  }, [])

  return (
    <div className="flex min-h-screen flex-col bg-[#faf6ea]">
      <PWARegister />
      <Header />
      <main className="flex-1">
        {!authChecked ? (
          <div className="flex h-[60vh] items-center justify-center">
            <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
          </div>
        ) : (
          <>
            {view === 'home' && <HomeView />}
            {view === 'programs' && <ProgramsView />}
            {view === 'program-detail' && <ProgramDetailsView />}
            {view === 'apply' && <ApplyView />}
            {view === 'auth' && <AuthView />}
            {view === 'dashboard' && <DashboardView />}
            {view === 'unit' && <UnitView />}
            {view === 'exam' && <ExamView />}
            {view === 'chat' && <AIChatView />}
            {view === 'agent' && <AgentView />}
            {view === 'admin' && <AdminView />}
            {view === 'verify' && <VerifyView />}
            {view === 'directory' && <DirectoryView />}
            {view === 'contact' && <ContactView />}
          </>
        )}
      </main>
      {view !== 'chat' && <Footer />}
      <FloatingActions />
    </div>
  )
}
