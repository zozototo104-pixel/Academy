import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { serializeRepresentative } from '@/lib/academy-representatives'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function originFrom(req: NextRequest) {
  return req.headers.get('origin') || `${req.nextUrl.protocol}//${req.nextUrl.host}`
}

export async function GET(req: NextRequest) {
  try {
    const rows = await db.academyRepresentative.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      orderBy: [{ featured: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: { files: { orderBy: [{ displayOrder: 'asc' }, { createdAt: 'desc' }] } },
    })
    const representatives = rows.map((row) => serializeRepresentative(row, originFrom(req), false))
    return NextResponse.json({ representatives: representatives.length ? representatives : DEMO_REPRESENTATIVES, demo: representatives.length === 0 })
  } catch {
    return NextResponse.json({ representatives: DEMO_REPRESENTATIVES, demo: true, note: 'تم عرض بيانات تجريبية لأن جدول ممثلي الأكاديمية غير محدث بعد.' })
  }
}
