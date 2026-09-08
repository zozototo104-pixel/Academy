import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

// GET /api/certificates — شهادات المستخدم الحالي
export async function GET() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ certificates: [] })
    const ownAdmissions = await db.admissionApplication.findMany({
      where: { OR: [{ userId: user.id }, { email: user.email }] },
      select: { id: true },
    })
    const certificates = await db.certificate.findMany({
      where: {
        OR: [
          { userId: user.id },
          { admissionId: { in: ownAdmissions.map((a) => a.id) } },
        ],
      },
      orderBy: { issuedAt: 'desc' },
    })
    return NextResponse.json({ certificates })
  } catch (e) {
    console.error('certificates GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الشهادات' }, { status: 500 })
  }
}
