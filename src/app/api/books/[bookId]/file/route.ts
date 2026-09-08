import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

// GET /api/books/[bookId]/file — تحميل/عرض ملف الكتاب المقرر (للمستخدمين المسجلين)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ bookId: string }> }
) {
  try {
    const { bookId } = await params
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول لعرض الكتب المقررة' }, { status: 401 })

    const book = await db.book.findUnique({ where: { id: bookId } })
    if (!book || !book.data) {
      return NextResponse.json({ error: 'لا يوجد ملف مرفوع لهذا الكتاب' }, { status: 404 })
    }

    const buf = Buffer.from(book.data, 'base64')
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': book.mimeType || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${encodeURIComponent(book.fileName || book.title)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    console.error('book file GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل ملف الكتاب' }, { status: 500 })
  }
}
