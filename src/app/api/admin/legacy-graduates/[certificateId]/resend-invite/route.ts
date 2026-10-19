import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { sendLegacyGraduatePasswordSetup } from '@/lib/legacy-graduates'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type RouteContext = { params: Promise<{ certificateId: string }> | { certificateId: string } }

// POST /api/admin/legacy-graduates/[certificateId]/resend-invite — إعادة إرسال رابط تعيين كلمة السر
export async function POST(req: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdmin()
    const { certificateId } = await Promise.resolve(context.params)
    const cert = await db.certificate.findUnique({ where: { id: certificateId }, select: { id: true, serial: true, holderName: true, legacy: true, userId: true } })
    if (!cert || !cert.legacy) return NextResponse.json({ error: 'شهادة الخريج السابق غير موجودة' }, { status: 404 })
    if (!cert.userId) return NextResponse.json({ error: 'الشهادة غير مربوطة بحساب طالب' }, { status: 400 })

    const emailStatus = await sendLegacyGraduatePasswordSetup(req, cert.userId)
    await db.auditLog.create({
      data: {
        actorId: admin.id,
        actorName: admin.name || 'Admin',
        action: 'RESEND_LEGACY_GRADUATE_INVITE',
        entity: 'Certificate',
        entityId: cert.id,
        details: `${cert.serial} — ${cert.holderName} — emailStatus=${emailStatus}`,
      },
    })
    return NextResponse.json({ ok: true, emailStatus })
  } catch (error: any) {
    if (error?.message === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 403 })
    }
    console.error('admin legacy-graduates resend-invite error:', error)
    return NextResponse.json({ error: 'تعذر إعادة إرسال رابط التفعيل' }, { status: 500 })
  }
}
