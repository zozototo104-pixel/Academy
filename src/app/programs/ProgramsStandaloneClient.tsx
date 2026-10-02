'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { ProgramsView } from '@/components/aact/ProgramsView'
import { ProgramDetailsView } from '@/components/aact/ProgramDetailsView'
import { ApplyView } from '@/components/aact/ApplyView'
import { VerifyView } from '@/components/aact/VerifyView'
import { AboutView } from '@/components/aact/AboutView'
import { ContactView } from '@/components/aact/ContactView'
import { DirectoryView } from '@/components/aact/DirectoryView'
import { AuthView } from '@/components/aact/AuthView'

export function ProgramsStandaloneClient() {
  const view = useAppStore((s) => s.view)

  useEffect(() => {
    const path = window.location.pathname
    if (path.startsWith('/programs/') && path.split('/').filter(Boolean)[1]) {
      const slug = decodeURIComponent(path.split('/').filter(Boolean)[1] || '')
      useAppStore.setState({ view: 'program-detail', programDetailsId: slug, mobileMenuOpen: false })
      return
    }
    useAppStore.setState({ view: 'programs', mobileMenuOpen: false })
  }, [])

  const effectiveView = view === 'home' ? 'programs' : view

  return (
    <div className="flex min-h-screen flex-col bg-[#eef0f5]">
      <Header />
      <main className="flex-1">
        {effectiveView === 'programs' && <ProgramsView />}
        {effectiveView === 'program-detail' && <ProgramDetailsView />}
        {effectiveView === 'apply' && <ApplyView />}
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
