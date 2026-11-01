'use client'

import { useEffect, useState } from 'react'
import { useAppStore, type View } from '@/lib/store'
import { Header, Footer, FloatingActions } from '@/components/aact/Shell'
import { ProgramsView } from '@/components/aact/ProgramsView'
import { ProgramDetailsView } from '@/components/aact/ProgramDetailsView'
import { ApplyView } from '@/components/aact/ApplyView'
import { VerifyView } from '@/components/aact/VerifyView'
import { AboutView } from '@/components/aact/AboutView'
import { ContactView } from '@/components/aact/ContactView'
import { DirectoryView } from '@/components/aact/DirectoryView'
import { AuthView } from '@/components/aact/AuthView'

// This route renders only the public programs family. Navigating from its
// shared Header to the dashboard/home/etc. must hand off to the actual Next
// route: updating Zustand + pushState alone leaves the wrong React tree mounted.
const supportedProgramViews: ReadonlySet<View> = new Set([
  'programs', 'program-detail', 'apply', 'verify', 'directory',
  'about', 'contact', 'auth',
])

export function ProgramsStandaloneClient() {
  const view = useAppStore((s) => s.view)
  const setUser = useAppStore((s) => s.setUser)
  const [routeReady, setRouteReady] = useState(false)
  const [sessionReady, setSessionReady] = useState(false)

  // This standalone public route does not mount the root page's /api/auth/me
  // initialization. Restore only the Header identity from the EXISTING
  // HttpOnly cookie; never prompt login or create a second login/session.
  useEffect(() => {
    let alive = true
    fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => response.ok ? (await response.json()).user ?? null : null)
      .then((user) => { if (alive) setUser(user) })
      .catch((error) => {
        // Public programs remain accessible even during a network outage.
        console.warn('Failed to restore public programs header session.', error)
      })
      .finally(() => { if (alive) setSessionReady(true) })
    return () => { alive = false }
  }, [setUser])

  useEffect(() => {
    const path = window.location.pathname
    if (path.startsWith('/programs/') && path.split('/').filter(Boolean)[1]) {
      const slug = decodeURIComponent(path.split('/').filter(Boolean)[1] || '')
      useAppStore.setState({ view: 'program-detail', programDetailsId: slug, mobileMenuOpen: false })
    } else {
      useAppStore.setState({ view: 'programs', mobileMenuOpen: false })
    }
    setRouteReady(true)
  }, [])

  useEffect(() => {
    if (!routeReady || supportedProgramViews.has(view)) return
    // navigate() already writes the correct URL with history.pushState, but
    // it cannot replace this standalone page's React tree. Reload the new
    // URL to mount the real home/student/admin route immediately.
    window.location.reload()
  }, [routeReady, view])

  const effectiveView = !routeReady && view === 'home' ? 'programs' : view

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
