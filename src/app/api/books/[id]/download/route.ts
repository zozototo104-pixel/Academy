import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ id: string }> | { id: string } }

function safeFileName(value: string, fallback = 'aact-book') {
  return String(value || fallback)
    .trim()
    .replace(/[\\/\u0000-\u001f\u007f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .slice(0, 140) || fallback
}

export async function GET(_req: NextRequest, context: RouteContext) {
  try {
    const user = await requireUser()
    const { id } = await Promise.resolve(context.params)
    if (!id) return NextResponse.json({ error: 'معرف الكتاب مطلوب' }, { status: 400 })

    const book = await db.book.findUnique({
      where: { id },
      include: { program: { select: { id: true, titleAr: true } } },
    })
    if (!book) return NextResponse.json({ error: 'الكتاب غير موجود' }, { status: 404 })

    if (user.role !== 'ADMIN') {
      const enrollment = await db.enrollment.findUnique({
        where: { userId_programId: { userId: user.id, programId: book.programId } },
        select: { status: true },
      })
      if (!enrollment || enrollment.status === 'PENDING_PAYMENT') {
        return NextResponse.json({ error: 'صلاحيات غير كافية لفتح هذا الكتاب' }, { status: 403 })
      }
    }

    const hasStoredFile = Boolean(book.fileName || book.storageKey || book.fileUrl || book.data)
    if (!hasStoredFile && book.link) {
      return NextResponse.redirect(book.link, { status: 302 })
    }

    const stored = await getFileBufferFromStorageOrBase64({
      provider: book.storageProvider,
      key: book.storageKey,
      url: book.fileUrl,
      data: book.data,
      mimeType: book.mimeType,
    })

    if (!stored) {
      if (book.link) return NextResponse.redirect(book.link, { status: 302 })
      return NextResponse.json({ error: 'لا يوجد ملف أو رابط متاح لهذا الكتاب' }, { status: 404 })
    }

    const filename = safeFileName(book.fileName || `${book.title || 'aact-book'}.pdf`)
    const body = new ArrayBuffer(stored.buffer.byteLength)
    new Uint8Array(body).set(stored.buffer)

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': stored.mimeType || book.mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'private, no-store, max-age=0',
        'Content-Length': String(stored.buffer.byteLength),
      },
    })
  } catch (e) {
    console.error('book download error:', e)
    if (e instanceof Error && e.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'تسجيل الدخول مطلوب لفتح الكتاب' }, { status: 401 })
    }
    return NextResponse.json({ error: 'تعذر فتح الكتاب' }, { status: 500 })
  }
}
