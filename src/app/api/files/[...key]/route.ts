import { NextRequest, NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth'
import { createSignedStorageUrlForKey, readStoredFile, signLocalStorageDownloadPath, verifyLocalStorageDownloadSignature } from '@/lib/storage'
import { isPrivateStorageKey, normalizeStorageKeyForPolicy } from '@/lib/prod-safety'
import { canAccessStorageKey } from '@/lib/file-access-policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SIGNED_URL_TTL_SECONDS = 5 * 60

type RouteContext = { params: { key?: string[] } | Promise<{ key?: string[] }> }
type FileRouteUser = Awaited<ReturnType<typeof requireUser>>
type FileRouteDeps = {
  requireUser: () => Promise<FileRouteUser>
  canAccessStorageKey: (key: string, user: FileRouteUser) => Promise<boolean>
  readStoredFile: typeof readStoredFile
  createSignedStorageUrlForKey: typeof createSignedStorageUrlForKey
  signLocalStorageDownloadPath: typeof signLocalStorageDownloadPath
  verifyLocalStorageDownloadSignature: typeof verifyLocalStorageDownloadSignature
  now: () => number
}

const productionDeps: FileRouteDeps = {
  requireUser,
  canAccessStorageKey,
  readStoredFile,
  createSignedStorageUrlForKey,
  signLocalStorageDownloadPath,
  verifyLocalStorageDownloadSignature,
  now: () => Date.now(),
}

async function handleFileGet(req: NextRequest, context: RouteContext, deps: FileRouteDeps) {
  const params = await context.params
  const key = normalizeStorageKeyForPolicy((params.key || []).join('/'))
  if (!key) return NextResponse.json({ error: 'مفتاح الملف مطلوب' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

  const search = req.nextUrl.searchParams
  if (search.get('download') === '1') {
    if (!deps.verifyLocalStorageDownloadSignature(key, search.get('expires'), search.get('signature'))) {
      return NextResponse.json({ error: 'رابط الملف منتهي أو غير صالح' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }
    const stored = await deps.readStoredFile({ provider: 'local', key })
    if (!stored) return NextResponse.json({ error: 'الملف غير موجود' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return new NextResponse(new Uint8Array(stored.buffer), {
      status: 200,
      headers: {
        'Content-Type': stored.mimeType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=0, no-store',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(key.split('/').pop() || 'file')}"`,
      },
    })
  }

  let user: FileRouteUser
  try {
    user = await deps.requireUser()
  } catch {
    return NextResponse.json({ error: 'تسجيل الدخول مطلوب للوصول إلى الملف' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }

  if (!isPrivateStorageKey(key) && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'هذا المسار مخصص للملفات الخاصة فقط' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }

  const allowed = await deps.canAccessStorageKey(key, user)
  if (!allowed) return NextResponse.json({ error: 'غير مصرح لك بالوصول إلى هذا الملف' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })

  const legacyLocal = await deps.readStoredFile({ provider: 'local', key })
  const signedUrl = legacyLocal
    ? deps.signLocalStorageDownloadPath(key, deps.now() + SIGNED_URL_TTL_SECONDS * 1000)
    : deps.createSignedStorageUrlForKey(key, SIGNED_URL_TTL_SECONDS)
  if (!signedUrl) return NextResponse.json({ error: 'تعذر إنشاء رابط تحميل آمن' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })

  const expiresAt = new Date(deps.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString()
  const wantsJson = search.get('format') === 'json' || (req.headers.get('accept') || '').includes('application/json')
  if (wantsJson) {
    return NextResponse.json({ ok: true, url: signedUrl, expiresAt }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const redirect = NextResponse.redirect(new URL(signedUrl, req.url), 302)
  redirect.headers.set('Cache-Control', 'no-store')
  return redirect
}

export async function __handleFileGetForTests(req: NextRequest, context: RouteContext, deps: Partial<FileRouteDeps>) {
  return handleFileGet(req, context, { ...productionDeps, ...deps })
}

export async function GET(req: NextRequest, context: RouteContext) {
  return handleFileGet(req, context, productionDeps)
}
