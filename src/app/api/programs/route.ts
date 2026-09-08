import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'

export async function GET() {
  try {
    const programs = await db.program.findMany({
      where: { active: true },
      orderBy: { order: 'asc' },
      include: { units: { orderBy: { order: 'asc' }, select: { id: true, order: true, title: true } } },
    })

    const user = await getCurrentUser()
    let enrolledProgramIds: string[] = []
    if (user) {
      const enrolls = await db.enrollment.findMany({
        where: { userId: user.id },
        select: { programId: true },
      })
      enrolledProgramIds = enrolls.map((e) => e.programId)
    }

    return NextResponse.json({
      programs: programs.map((p) => ({
        id: p.id,
        slug: p.slug,
        titleAr: p.titleAr,
        titleEn: p.titleEn,
        description: p.description,
        category: p.category,
        hours: p.hours,
        price: p.price,
        icon: p.icon,
        features: JSON.parse(p.features || '[]'),
        unitsCount: p.units.length,
        enrolled: enrolledProgramIds.includes(p.id),
        // قواعد قبول مخصصة يعرضها نموذج الالتحاق للمتقدم (شروط إضافية تضبطها الإدارة)
        admissionRules: p.admissionRules || null,
      })),
    })
  } catch (e) {
    console.error('Programs error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل البرامج' }, { status: 500 })
  }
}
