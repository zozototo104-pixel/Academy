'use client'

import { useAppStore } from '@/lib/store'
import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { HomeView } from '@/components/aact/HomeView'
import { ProgramsView } from '@/components/aact/ProgramsView'
import { ProgramDetailsView } from '@/components/aact/ProgramDetailsView'
import { ApplyView } from '@/components/aact/ApplyView'
import { AuthView } from '@/components/aact/AuthView'
import { VerifyView } from '@/components/aact/VerifyView'
import { DirectoryView } from '@/components/aact/DirectoryView'
import { ContactView } from '@/components/aact/ContactView'
import { Loader2 } from 'lucide-react'
import { api } from '@/lib/store'
import { unlockAudioOnFirstGesture } from '@/lib/audioPlayer'

function LazyViewLoader() {
  return (
    <div className="flex h-[60vh] items-center justify-center">
      <Loader2 className="h-9 w-9 animate-spin text-[#c9a227]" />
    </div>
  )
}

const DashboardView = dynamic(() => import('@/components/aact/DashboardView').then((m) => m.DashboardView), { ssr: false, loading: LazyViewLoader })
const UnitView = dynamic(() => import('@/components/aact/UnitView').then((m) => m.UnitView), { ssr: false, loading: LazyViewLoader })
const ExamView = dynamic(() => import('@/components/aact/ExamView').then((m) => m.ExamView), { ssr: false, loading: LazyViewLoader })
const AIChatView = dynamic(() => import('@/components/aact/AIChatView').then((m) => m.AIChatView), { ssr: false, loading: LazyViewLoader })
const AgentView = dynamic(() => import('@/components/aact/AgentView').then((m) => m.AgentView), { ssr: false, loading: LazyViewLoader })
const AdminView = dynamic(() => import('@/components/aact/AdminView').then((m) => m.AdminView), { ssr: false, loading: LazyViewLoader })

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
      } else {
        useAppStore.getState().navigate(v as any)
      }
    }
  }, [])

  useEffect(() => {
    if (!authChecked || !user) return
    const q = new URLSearchParams(window.location.search)
    if (q.has('view')) return
    const state = useAppStore.getState()
    if (user.role === 'ADMIN' && (view === 'home' || view === 'auth')) {
      state.navigate('admin')
    } else if (user.role !== 'ADMIN' && view === 'auth') {
      state.navigate('dashboard')
    }
  }, [authChecked, user, view])

  const hasExplicitView = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('view')
  const effectiveView = authChecked && user?.role === 'ADMIN' && !hasExplicitView && (view === 'home' || view === 'auth') ? 'admin' : view

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
            {effectiveView === 'verify' && <VerifyView />}
            {effectiveView === 'directory' && <DirectoryView />}
            {effectiveView === 'contact' && <ContactView />}
          </>
        )}
      </main>
      {view !== 'chat' && <Footer />}
      <FloatingActions />
    </div>
  )
}
