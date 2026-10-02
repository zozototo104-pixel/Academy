'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { ApplyView } from '@/components/aact/ApplyView'
import { ProgramsView } from '@/components/aact/ProgramsView'
import { ProgramDetailsView } from '@/components/aact/ProgramDetailsView'
import { VerifyView } from '@/components/aact/VerifyView'
import { AboutView } from '@/components/aact/AboutView'
import { ContactView } from '@/components/aact/ContactView'
import { DirectoryView } from '@/components/aact/DirectoryView'
import { AuthView } from '@/components/aact/AuthView'

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
