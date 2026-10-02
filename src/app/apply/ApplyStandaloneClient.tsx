'use client'

import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { ApplyView } from '@/components/aact/ApplyView'

function LazyViewLoader() {
  return (
    <div className="min-h-[60vh] bg-[#eef0f5] px-4 py-20 text-center text-sm font-bold text-slate-500">
      جاري تحميل الصفحة...
    </div>
  )
}

const ProgramsView = dynamic(() => import('@/components/aact/ProgramsView').then((m) => m.ProgramsView), { ssr: false, loading: LazyViewLoader })
const ProgramDetailsView = dynamic(() => import('@/components/aact/ProgramDetailsView').then((m) => m.ProgramDetailsView), { ssr: false, loading: LazyViewLoader })
const VerifyView = dynamic(() => import('@/components/aact/VerifyView').then((m) => m.VerifyView), { ssr: false, loading: LazyViewLoader })
const AboutView = dynamic(() => import('@/components/aact/AboutView').then((m) => m.AboutView), { ssr: false, loading: LazyViewLoader })
const ContactView = dynamic(() => import('@/components/aact/ContactView').then((m) => m.ContactView), { ssr: false, loading: LazyViewLoader })
const DirectoryView = dynamic(() => import('@/components/aact/DirectoryView').then((m) => m.DirectoryView), { ssr: false, loading: LazyViewLoader })
const AuthView = dynamic(() => import('@/components/aact/AuthView').then((m) => m.AuthView), { ssr: false, loading: LazyViewLoader })

export function ApplyStandaloneClient() {
  const view = useAppStore((s) => s.view)

  useEffect(() => {
    useAppStore.setState({ view: 'apply', mobileMenuOpen: false })
  }, [])

  const effectiveView = view === 'home' ? 'apply' : view

  return (
    <div className="flex min-h-screen flex-col bg-[#eef0f5]">
      <Header />
      <main className="flex-1">
        {effectiveView === 'apply' && <ApplyView />}
        {effectiveView === 'programs' && <ProgramsView />}
        {effectiveView === 'program-detail' && <ProgramDetailsView />}
        {effectiveView === 'verify' && <VerifyView />}
        {effectiveView === 'directory' && <DirectoryView />}
        {effectiveView === 'about' && <AboutView />}
        {effectiveView === 'contact' && <ContactView />}
        {effectiveView === 'auth' && <AuthView />}
      </main>
      {effectiveView !== 'auth' && <Footer />}
      <FloatingActions />
    </div>
  )
}
