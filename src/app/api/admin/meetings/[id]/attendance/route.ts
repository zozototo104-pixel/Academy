import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const confirmSchema = z.object({
  userId: z.string().min(1),
  status: z.enum(['PRESENT', 'ABSENT']),
})

// تأكيد الحضور الفعلي بيد الإدارة — سجل JOINED وحده يعني «ضغط زر
// الدخول داخل النافذة» ولا يُحتسب حضورًا مؤكدًا (نفس قاعدة المحاضرات).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin()
    const { id } = await params
    const parsed = confirmSchema.safeParse(await req.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'بيانات التأكيد غير صالحة' }, { status: 400 })
    const existing = await (db as any).adminMeetingAttendance.findUnique({
      where: { meetingId_userId: { meetingId: id, userId: parsed.data.userId } },
    }).catch(() => null)
    if (!existing) return NextResponse.json({ error: 'لا يوجد سجل دخول لهذا المشارك', code: 'NO_JOIN_RECORD' }, { status: 404 })
    const updated = await (db as any).adminMeetingAttendance.update({
      where: { meetingId_userId: { meetingId: id, userId: parsed.data.userId } },
      data: { status: parsed.data.status, confirmedAt: new Date(), confirmedById: admin.id },
    })
    await audit({ id: admin.id, name: admin.name || 'مسؤول' }, 'ADMIN_MEETING_ATTENDANCE_CONFIRMED', 'AdminMeeting', id, `user=${parsed.data.userId} status=${parsed.data.status}`).catch(() => {})
    return NextResponse.json({ ok: true, attendance: updated })
  } catch {
    return NextResponse.json({ error: 'صلاحية إدارية مطلوبة' }, { status: 403 })
  }
}
