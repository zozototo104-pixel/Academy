'use client'

import { create } from 'zustand'

export type View =
  | 'home'
  | 'programs'
  | 'program-detail'
  | 'apply'
  | 'auth'
  | 'dashboard'
  | 'unit'
  | 'exam'
  | 'chat'
  | 'agent'
  | 'admin'
  | 'student-preview'
  | 'agent-preview'
  | 'verify'
  | 'directory'
  | 'contact'

function updateBrowserRoute(view: View, params: Record<string, string | null | undefined> = {}) {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    url.search = ''
    if (view !== 'home') url.searchParams.set('view', view)
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value)
    }
    const next = `${url.pathname}${url.search}${url.hash}`
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`
    if (next !== current) window.history.pushState(null, '', next)
  } catch {}
}

export interface AppUser {
  id: string
  name: string
  email: string
  role: string
  country?: string | null
}

interface AppState {
  user: AppUser | null
  authChecked: boolean
  view: View
  activeProgramId: string | null
  programDetailsId: string | null
  programsFilter: string | null
  activeUnitId: string | null
  activeExamId: string | null
  activeExamKind: 'unit' | 'final'
  studentPreviewId: string | null
  agentPreviewId: string | null
  applyProgramTitle: string | null // برنامج محدد مسبقاً لنموذج طلب الالتحاق
  mobileMenuOpen: boolean
  setUser: (u: AppUser | null) => void
  setAuthChecked: (v: boolean) => void
  navigate: (view: View) => void
  openPrograms: (filter?: string) => void
  openProgram: (id: string) => void
  openProgramDetails: (id: string) => void
  openUnit: (id: string) => void
  openExam: (id: string, kind?: 'unit' | 'final') => void
  openStudentPreview: (studentId: string) => void
  openAgentPreview: (agentId: string) => void
  openApply: (programTitle?: string) => void
  setMobileMenuOpen: (v: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  user: null,
  authChecked: false,
  view: 'home',
  activeProgramId: null,
  programDetailsId: null,
  programsFilter: null,
  activeUnitId: null,
  activeExamId: null,
  activeExamKind: 'unit',
  studentPreviewId: null,
  agentPreviewId: null,
  mobileMenuOpen: false,
  applyProgramTitle: null,
  setUser: (u) => set({ user: u }),
  setAuthChecked: (v) => set({ authChecked: v }),
  navigate: (view) => {
    updateBrowserRoute(view)
    set({
      view,
      mobileMenuOpen: false,
      programsFilter: null,
      ...(view !== 'program-detail' ? { programDetailsId: null } : {}),
      ...(view !== 'student-preview' ? { studentPreviewId: null } : {}),
      ...(view !== 'agent-preview' ? { agentPreviewId: null } : {}),
    })
  },
  openPrograms: (filter) => {
    updateBrowserRoute('programs', filter ? { filter } : {})
    set({
      view: 'programs',
      programsFilter: filter || null,
      programDetailsId: null,
      activeProgramId: null,
      activeUnitId: null,
      activeExamId: null,
      mobileMenuOpen: false,
    })
  },
  openProgram: (id) => {
    updateBrowserRoute('dashboard', { programId: id })
    set({ activeProgramId: id, view: 'dashboard', mobileMenuOpen: false })
  },
  openProgramDetails: (id) => {
    updateBrowserRoute('program-detail', { program: id })
    set({
      programDetailsId: id,
      view: 'program-detail',
      programsFilter: null,
      activeProgramId: null,
      activeUnitId: null,
      activeExamId: null,
      mobileMenuOpen: false,
    })
  },
  openUnit: (id) => {
    updateBrowserRoute('unit', { unitId: id })
    set({ activeUnitId: id, view: 'unit' })
  },
  openExam: (id, kind = 'unit') => {
    updateBrowserRoute('exam', { examId: id, kind })
    set({ activeExamId: id, activeExamKind: kind, view: 'exam' })
  },
  openStudentPreview: (studentId) => {
    updateBrowserRoute('student-preview', { studentId })
    set({
      studentPreviewId: studentId,
      view: 'student-preview',
      mobileMenuOpen: false,
      programsFilter: null,
      programDetailsId: null,
      activeProgramId: null,
      activeUnitId: null,
      activeExamId: null,
    })
  },
  openApply: (programTitle) => {
    updateBrowserRoute('apply')
    set({ applyProgramTitle: programTitle || null, view: 'apply', mobileMenuOpen: false })
  },
  setMobileMenuOpen: (v) => set({ mobileMenuOpen: v }),
}))

// ---- رمز الجلسة (Bearer Token) ----
// يُخزَّن في localStorage ليعمل تسجيل الدخول حتى في البيئات التي تحجب الكوكيز
// (iframe المعاينة / حجب كوكيز الطرف الثالث / WebView أندرويد)
const TOKEN_KEY = 'aact_token'

export function getToken(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t)
  } catch {}
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {}
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isTransientFetchError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '').toLowerCase()
  return (
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('temporarily unavailable')
  )
}

export async function api<T = any>(url: string, options?: RequestInit): Promise<T> {
  const token = getToken()
  const isForm = typeof FormData !== 'undefined' && options?.body instanceof FormData
  const maxAttempts = isForm ? 1 : 3
  let lastNetworkError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        cache: 'no-store',
        headers: {
          ...(isForm ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options?.headers || {}),
        },
      })
      const data = await res.json().catch(() => ({}))
      // انتهت صلاحية الجلسة على الخادم → نظّف الرمز والمستخدم المحلي (وإلا تبقى الواجهة تعتبره مسجلاً)
      if (res.status === 401 && token) {
        clearToken()
        try { useAppStore.setState({ user: null }) } catch {}
      }
      if (!res.ok) {
        const err = new Error(data?.error || `HTTP ${res.status}`) as Error & { data?: any }
        err.data = data
        throw err
      }
      return data as T
    } catch (err) {
      if (!isTransientFetchError(err) || attempt >= maxAttempts) {
        throw err
      }
      lastNetworkError = err
      await wait(450 * attempt)
    }
  }

  throw lastNetworkError || new Error('تعذر الاتصال بالخادم')
}
