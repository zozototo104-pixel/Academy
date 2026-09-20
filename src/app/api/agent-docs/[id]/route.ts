import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { getFileBufferFromStorageOrBase64 } from '@/lib/storage'

// GET /api/agent-docs/[id] — عرض مستند طلب وكالة/اعتماد (للإدارة أو صاحب الطلب فقط)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })

    const doc = await db.agentDocument.findUnique({
      where: { id },
      include: { agent: { select: { email: true, orgName: true } } },
    })
    if (!doc) return NextResponse.json({ error: 'المستند غير موجود' }, { status: 404 })

    // AgentApplication لا يرتبط بمستخدم دائماً — نطابق بالبريد أو نسمح للإدارة
    const isOwner = doc.agent.email === user.email
    const isAdmin = user.role === 'ADMIN'
    if (!isAdmin && !isOwner) {
      return NextResponse.json({ error: 'غير مصرح لك بعرض هذا المستند' }, { status: 403 })
    }

    const stored = await getFileBufferFromStorageOrBase64({
      provider: doc.storageProvider,
      key: doc.storageKey,
      url: doc.fileUrl,
      data: doc.data,
      mimeType: doc.mimeType,
    })
    if (!stored) return NextResponse.json({ error: 'تعذر العثور على ملف المستند في التخزين' }, { status: 404 })

    return new NextResponse(new Uint8Array(stored.buffer), {
      headers: {
        'Content-Type': stored.mimeType || doc.mimeType,
        'Content-Disposition': `inline; filename="${encodeURIComponent(doc.fileName)}"`,
        'Cache-Control': 'private, no-store',
      },
    })
  } catch (e) {
    console.error('agent doc GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المستند' }, { status: 500 })
  }
}
