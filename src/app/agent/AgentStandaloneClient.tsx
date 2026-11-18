// العميل المستقل لصفحة /agent (مرحلة 2 — 2026-11-18): الصفحة كانت تعرض
// <AgentView/> مباشرة، فكان navigate('auth') يغيّر الرابط إلى /login
// بلا شاشة دخول — طريق مسدود. هنا تبديل العروض كما في /apply: نموذج
// الوكالة/الاعتماد لعرض 'agent'، وشاشة الدخول لعرض 'auth'، والترويسة
// نفسها كما كانت. والعروض التي لا تعرضها هذه الصفحة المستقلة (لوحة
// تحكم/إدارة/مشرف...) تنتقل إلى الصدفة (shell) بتنقّل كامل بدل شاشة
// رئيسية فارغة كما يحدث في /apply اليوم بعد الدخول.

'use client'

import dynamic from 'next/dynamic'
import { useEffect } from 'react'
import { useAppStore } from '@/lib/store'
import { pathForView } from '@/lib/app-routes'
import { AgentView } from '@/components/aact/AgentView'

function LazyViewLoader() {
  return (
    <div className="min-h-[60vh] bg-[#f6f0e3] px-4 py-20 text-center text-sm font-bold text-slate-500">
      جاري تحميل الصفحة...
    </div>
  )
}

const AuthView = dynamic(() => import('@/components/aact/AuthView').then((m) => m.AuthView), { ssr: false, loading: LazyViewLoader })

export function AgentStandaloneClient() {
  const view = useAppStore((s) => s.view)
  const userId = useAppStore((s) => s.user?.id)

  useEffect(() => {
    const controller = new AbortController()
    useAppStore.setState({ view: 'agent', mobileMenuOpen: false })
    if (!useAppStore.getState().user) {
      void fetch('/api/auth/me', { cache: 'no-store', signal: controller.signal })
        .then(async (response) => response.ok ? response.json() : null)
        .then((data) => {
          const state = useAppStore.getState()
          if (!controller.signal.aborted && data?.user && !state.user && state.view === 'agent') {
            state.setUser(data.user)
          }
        })
        .catch(() => { /* The public form remains available offline. */ })
    }
    return () => controller.abort()
  }, [])

  const effectiveView = view === 'home' ? 'agent' : view

  useEffect(() => {
    if (effectiveView !== 'agent' && effectiveView !== 'auth') {
      window.location.assign(pathForView(effectiveView))
    }
  }, [effectiveView])

  if (effectiveView === 'auth') return <AuthView />
  if (effectiveView !== 'agent') return null
  return <AgentView key={userId || 'guest'} />
}
