import type { View } from './store'

const VIEW_PATHS: Partial<Record<View, string>> = {
  home: '/',
  programs: '/programs',
  apply: '/apply',
  auth: '/login',
  dashboard: '/dashboard',
  chat: '/chat',
  agent: '/agent',
  admin: '/admin',
  supervisor: '/supervisor',
  verify: '/verify',
  directory: '/directory',
  about: '/about',
  contact: '/contact',
}

export const VALID_APP_VIEWS: View[] = [
  'home',
  'programs',
  'program-detail',
  'apply',
  'auth',
  'dashboard',
  'unit',
  'exam',
  'chat',
  'agent',
  'admin',
  'supervisor',
  'student-preview',
  'agent-preview',
  'verify',
  'directory',
  'about',
  'contact',
]

export function isValidAppView(value: string | null | undefined): value is View {
  return !!value && (VALID_APP_VIEWS as string[]).includes(value)
}

function enc(value: string) {
  return encodeURIComponent(value)
}

export function pathForView(view: View, params: Record<string, string | null | undefined> = {}) {
  switch (view) {
    case 'home':
      return '/'
    case 'programs':
      return params.filter ? `/programs?filter=${enc(params.filter)}` : '/programs'
    case 'program-detail': {
      const id = params.program || params.programId || params.slug
      return id ? `/programs/${enc(id)}` : '/programs'
    }
    case 'apply':
      return '/apply'
    case 'auth':
      return '/login'
    case 'dashboard': {
      const id = params.programId || params.program
      return id ? `/dashboard/program/${enc(id)}` : '/dashboard'
    }
    case 'unit': {
      const id = params.unitId
      return id ? `/unit/${enc(id)}` : '/dashboard'
    }
    case 'exam': {
      const id = params.examId
      const suffix = params.kind ? `?kind=${enc(params.kind)}` : ''
      return id ? `/exam/${enc(id)}${suffix}` : '/dashboard'
    }
    case 'chat':
      return '/chat'
    case 'agent':
      return '/agent'
    case 'admin':
      return '/admin'
    case 'supervisor':
      return '/supervisor'
    case 'student-preview': {
      const id = params.studentId
      return id ? `/admin/students/${enc(id)}` : '/admin'
    }
    case 'agent-preview': {
      const id = params.agentId
      return id ? `/admin/agents/${enc(id)}` : '/admin'
    }
    case 'verify':
      return '/verify'
    case 'directory':
      return '/directory'
    case 'about':
      return '/about'
    case 'contact':
      return '/contact'
    default:
      return VIEW_PATHS[view] || '/'
  }
}

export interface AppRouteState {
  view: View
  programsFilter?: string | null
  programDetailsId?: string | null
  activeProgramId?: string | null
  activeUnitId?: string | null
  activeExamId?: string | null
  activeExamKind?: 'unit' | 'final'
  studentPreviewId?: string | null
  agentPreviewId?: string | null
}

export function routeStateFromLocation(pathname: string, search: string): AppRouteState {
  const q = new URLSearchParams(search || '')
  const legacy = q.get('view')
  if (isValidAppView(legacy)) {
    return {
      view: legacy,
      programsFilter: q.get('filter') || null,
      programDetailsId: legacy === 'program-detail' ? (q.get('programId') || q.get('program') || q.get('slug')) : null,
      activeProgramId: legacy === 'dashboard' ? (q.get('programId') || q.get('program') || null) : null,
      activeUnitId: legacy === 'unit' ? (q.get('unitId') || null) : null,
      activeExamId: legacy === 'exam' ? (q.get('examId') || null) : null,
      activeExamKind: q.get('kind') === 'final' ? 'final' as const : 'unit' as const,
      studentPreviewId: legacy === 'student-preview' ? (q.get('studentId') || null) : null,
      agentPreviewId: legacy === 'agent-preview' ? (q.get('agentId') || null) : null,
    }
  }

  const parts = pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
  const first = parts[0] || ''
  const second = parts[1] || ''
  const third = parts[2] || ''

  if (!first) return { view: 'home' as View }
  if (first === 'programs' && second) return { view: 'program-detail' as View, programDetailsId: second }
  if (first === 'programs') return { view: 'programs' as View, programsFilter: q.get('filter') || null }
  if (first === 'apply') return { view: 'apply' as View }
  if (first === 'login' || first === 'auth') return { view: 'auth' as View }
  if (first === 'dashboard' && second === 'program' && third) return { view: 'dashboard' as View, activeProgramId: third }
  if (first === 'dashboard') return { view: 'dashboard' as View }
  if (first === 'unit' && second) return { view: 'unit' as View, activeUnitId: second }
  if (first === 'exam' && second) return { view: 'exam' as View, activeExamId: second, activeExamKind: q.get('kind') === 'final' ? 'final' as const : 'unit' as const }
  if (first === 'chat') return { view: 'chat' as View }
  if (first === 'agent') return { view: 'agent' as View }
  if (first === 'admin' && second === 'students' && third) return { view: 'student-preview' as View, studentPreviewId: third }
  if (first === 'admin' && second === 'agents' && third) return { view: 'agent-preview' as View, agentPreviewId: third }
  if (first === 'admin') return { view: 'admin' as View }
  if (first === 'supervisor') return { view: 'supervisor' as View }
  if (first === 'verify') return { view: 'verify' as View }
  if (first === 'directory') return { view: 'directory' as View }
  if (first === 'about') return { view: 'about' as View }
  if (first === 'contact') return { view: 'contact' as View }

  return { view: 'home' as View }
}
