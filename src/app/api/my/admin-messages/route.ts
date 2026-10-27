import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireUser } from '@/lib/auth'

// GET /api/my/admin-messages — محادثات رسائل الإدارة الخاصة بالطالب (نطاق ADMIN فقط).
// Only admissions that already have at least one admin-scope message are listed.
export async function GET() {
  try {
    const user = await requireUser()
    if (user.role !== 'STUDENT') {
      return NextResponse.json({ conversations: [], restricted: true })
    }
    const apps = await db.admissionApplication.findMany({
      where: { OR: [{ userId: user.id }, { email: user.email }] },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, reference: true, fullName: true, program: true, status: true, createdAt: true },
    })
    const ids = apps.map((a: any) => a.id)
    const [lastMessages, unreadNotes] = await Promise.all([
      Promise.all(ids.map((admissionId: string) =>
        db.supervisorChannelMessage.findFirst({
          where: { admissionId, scope: 'ADMIN' },
          orderBy: { createdAt: 'desc' },
          select: { id: true, senderRole: true, content: true, createdAt: true },
        })
      )),
      ids.length
        ? db.notification.findMany({
            where: { userId: user.id, type: 'ADMIN_MESSAGE', read: false, link: { in: ids.map((id: string) => `admin-messages:${id}`) } },
            select: { link: true },
          })
        : [],
    ])
    const unreadByAdmission = new Map<string, number>()
    for (const n of unreadNotes as any[]) {
      const admissionId = String(n.link || '').replace('admin-messages:', '')
      if (admissionId) unreadByAdmission.set(admissionId, (unreadByAdmission.get(admissionId) || 0) + 1)
    }
    const conversations = apps
      .map((app: any, i: number) => ({
        admission: app,
        lastMessage: lastMessages[i] || null,
        unread: unreadByAdmission.get(app.id) || 0,
      }))
      .filter((c: any) => c.lastMessage)
    return NextResponse.json({ conversations })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'يجب تسجيل الدخول' }, { status: 401 })
    console.error('my admin messages error:', e)
    return NextResponse.json({ error: 'تعذر تحميل رسائل الإدارة' }, { status: 500 })
  }
}
