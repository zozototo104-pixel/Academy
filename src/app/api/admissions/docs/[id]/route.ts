import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

// GET /api/admissions/docs/[id] — عرض مستند طلب التحاق (للإدارة أو صاحب الطلب فقط)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })

    const doc = await db.admissionDocument.findUnique({
      where: { id },
      include: { admission: { select: { userId: true, email: true, reference: true } } },
    })
    if (!doc) return NextResponse.json({ error: 'المستند غير موجود' }, { status: 404 })

    const isOwner = doc.admission.userId === user.id || doc.admission.email === user.email
    const isAdmin = user.role === 'ADMIN'
    if (!isAdmin && !isOwner) {
      return NextResponse.json({ error: 'غير مصرح لك بعرض هذا المستند' }, { status: 403 })
    }

    const buf = Buffer.from(doc.data, 'base64')
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        'Content-Type': doc.mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.fileName)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    console.error('admission doc GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المستند' }, { status: 500 })
  }
}
