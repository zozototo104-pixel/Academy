import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

/** التحقق من صلاحية الإدارة أو المشرف الأكاديمي (سجل المحادثات متاح لمن له حق الاطلاع فقط) */
async function requireViewer() {
  const user = await requireUser()
  if (!['ADMIN', 'SUPERVISOR'].includes(user.role)) throw new Error('FORBIDDEN')
  return user
}

// GET /api/admin/chats — قائمة الطلاب بسجلات محادثاتهم مع المشرف الذكي
// GET /api/admin/chats?userId=xxx — المحادثة الكاملة (نصية وصوتية مع النسخ المفرّغ)
export async function GET(req: NextRequest) {
  try {
    const viewer = await requireViewer()
    const userId = req.nextUrl.searchParams.get('userId')

    if (!userId) {
      const users = await db.user.findMany({
        where: { role: { not: 'ADMIN' } },
        select: {
          id: true, name: true, email: true, country: true,
          chatMessages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true, mode: true } },
        },
      })
      const counts = await db.chatMessage.groupBy({ by: ['userId'], _count: { id: true } })
      const countMap = new Map(counts.map((c) => [c.userId, c._count.id]))
      const voiceCounts = await db.chatMessage.groupBy({ by: ['userId'], _count: { id: true }, where: { mode: 'VOICE' } })
      const voiceMap = new Map(voiceCounts.map((c) => [c.userId, c._count.id]))
      const students = users
        .filter((u) => (countMap.get(u.id) || 0) > 0)
        .map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          country: u.country,
          total: countMap.get(u.id) || 0,
          voice: voiceMap.get(u.id) || 0,
          lastAt: u.chatMessages[0]?.createdAt || null,
        }))
        .sort((a, b) => (a.lastAt && b.lastAt ? +new Date(b.lastAt) - +new Date(a.lastAt) : 0))
      return NextResponse.json({ students, viewer: { id: viewer.id, role: viewer.role } })
    }

    const messages = await db.chatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      take: 400,
      select: { id: true, role: true, content: true, mode: true, kind: true, createdAt: true },
    })
    const student = await db.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    })
    return NextResponse.json({ messages, student })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'يجب تسجيل الدخول أولاً' }, { status: 401 })
    }
    if (e?.message === 'FORBIDDEN') {
      return NextResponse.json({ error: 'هذه البيانات متاحة للإدارة والمشرفين فقط' }, { status: 403 })
    }
    console.error('admin chats error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل سجل المشرف الذكي' }, { status: 500 })
  }
}
