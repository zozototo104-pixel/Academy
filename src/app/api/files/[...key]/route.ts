import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { createSignedStorageUrlForKey, readStoredFile, verifyLocalStorageDownloadSignature } from '@/lib/storage'
import { isPrivateStorageKey, normalizeStorageKeyForPolicy } from '@/lib/prod-safety'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

const SIGNED_URL_TTL_SECONDS = 5 * 60

type RouteContext = { params: { key?: string[] } | Promise<{ key?: string[] }> }

function sameEmail(a: unknown, b: unknown) {
  const aa = String(a || '').trim().toLowerCase()
  const bb = String(b || '').trim().toLowerCase()
  return !!aa && !!bb && aa === bb
}

function isOwner(user: { id: string; email?: string | null; role?: string | null }, candidate?: { userId?: string | null; email?: string | null } | null) {
  return !!candidate && (candidate.userId === user.id || sameEmail(candidate.email, user.email))
}

async function canAccessStorageKey(key: string, user: { id: string; email?: string | null; role?: string | null }) {
  if (user.role === 'ADMIN') return true
  if (normalizeStorageKeyForPolicy(key).startsWith('backups/')) return false

  const admissionDocument = await db.admissionDocument.findFirst({
    where: { storageKey: key },
    select: { admission: { select: { userId: true, email: true } } },
  })
  if (isOwner(user, admissionDocument?.admission)) return true

  const deliverable = await db.serviceDeliverable.findFirst({
    where: { storageKey: key, status: 'PUBLISHED', visibleToStudent: true },
    select: { admission: { select: { userId: true, email: true } } },
  })
  if (isOwner(user, deliverable?.admission)) return true

  const proof = await db.paymentProof.findFirst({
    where: { storageKey: key },
    select: {
      uploadedById: true,
      payment: {
        select: {
          userId: true,
          payerEmail: true,
          admission: { select: { userId: true, email: true } },
        },
      },
    },
  })
  if (proof && (proof.uploadedById === user.id || proof.payment.userId === user.id || sameEmail(proof.payment.payerEmail, user.email) || isOwner(user, proof.payment.admission))) return true

  const assignment = await db.assignmentSubmission.findFirst({
    where: { fileStorageKey: key },
    select: { userId: true },
  })
  if (assignment?.userId === user.id) return true

  const thesis = await db.thesisSubmission.findFirst({
    where: { OR: [{ fileStorageKey: key }, { recordingStorageKey: key }] },
    select: { userId: true },
  })
  if (thesis?.userId === user.id) return true

  return false
}

export async function GET(req: NextRequest, context: RouteContext) {
  const params = await context.params
  const key = normalizeStorageKeyForPolicy((params.key || []).join('/'))
  if (!key) return NextResponse.json({ error: 'مفتاح الملف مطلوب' }, { status: 400, headers: { 'Cache-Control': 'no-store' } })

  const search = req.nextUrl.searchParams
  if (search.get('download') === '1') {
    if (!verifyLocalStorageDownloadSignature(key, search.get('expires'), search.get('signature'))) {
      return NextResponse.json({ error: 'رابط الملف منتهي أو غير صالح' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
    }
    const stored = await readStoredFile({ provider: 'local', key })
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

  let user: Awaited<ReturnType<typeof requireUser>>
  try {
    user = await requireUser()
  } catch {
    return NextResponse.json({ error: 'تسجيل الدخول مطلوب للوصول إلى الملف' }, { status: 401, headers: { 'Cache-Control': 'no-store' } })
  }

  if (!isPrivateStorageKey(key) && user.role !== 'ADMIN') {
    return NextResponse.json({ error: 'هذا المسار مخصص للملفات الخاصة فقط' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }

  const allowed = await canAccessStorageKey(key, user)
  if (!allowed) return NextResponse.json({ error: 'غير مصرح لك بالوصول إلى هذا الملف' }, { status: 403, headers: { 'Cache-Control': 'no-store' } })

  const signedUrl = createSignedStorageUrlForKey(key, SIGNED_URL_TTL_SECONDS)
  if (!signedUrl) return NextResponse.json({ error: 'تعذر إنشاء رابط تحميل آمن' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })

  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString()
  const wantsJson = search.get('format') === 'json' || (req.headers.get('accept') || '').includes('application/json')
  if (wantsJson) {
    return NextResponse.json({ ok: true, url: signedUrl, expiresAt }, { headers: { 'Cache-Control': 'no-store' } })
  }
  const redirect = NextResponse.redirect(new URL(signedUrl, req.url), 302)
  redirect.headers.set('Cache-Control', 'no-store')
  return redirect
}
