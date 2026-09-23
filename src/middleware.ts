import { NextResponse, type NextRequest } from 'next/server'
import { isValidAppView, pathForView } from '@/lib/app-routes'

export function middleware(req: NextRequest) {
  const url = req.nextUrl
  const view = url.searchParams.get('view')
  if (!view || !isValidAppView(view)) return NextResponse.next()

  // لا نلمس روابط OAuth أو API حتى لا نكسر تسجيل الدخول أو Webhooks.
  if (url.pathname.startsWith('/api') || url.searchParams.has('oauth') || url.searchParams.has('token') || url.searchParams.has('error')) {
    return NextResponse.next()
  }

  const params: Record<string, string | null> = {
    filter: url.searchParams.get('filter'),
    programId: url.searchParams.get('programId') || url.searchParams.get('program') || url.searchParams.get('slug'),
    program: url.searchParams.get('program') || url.searchParams.get('programId') || url.searchParams.get('slug'),
    unitId: url.searchParams.get('unitId'),
    examId: url.searchParams.get('examId'),
    kind: url.searchParams.get('kind'),
    studentId: url.searchParams.get('studentId'),
    agentId: url.searchParams.get('agentId'),
  }

  let canonical = pathForView(view, params)
  if (view === 'verify') {
    const serial = url.searchParams.get('serial')
    const token = url.searchParams.get('token')
    const qs = new URLSearchParams()
    if (serial) qs.set('serial', serial)
    if (token) qs.set('token', token)
    canonical = qs.size ? `/verify?${qs.toString()}` : '/verify'
  }

  const next = req.nextUrl.clone()
  const [pathname, search = ''] = canonical.split('?')
  next.pathname = pathname
  next.search = search ? `?${search}` : ''
  return NextResponse.redirect(next, 308)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon-192.png|icon-512.png|apple-touch-icon.png).*)'],
}
