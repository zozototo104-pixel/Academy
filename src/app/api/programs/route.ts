import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ensureCoreSeed } from '@/lib/bootstrap'
import { academicProfileFromRules, isGenericAllSpecializationsProgram, PROGRAM_CATEGORY_ORDER, PROGRAM_CATEGORY_AR, programSpecialtyLabel } from '@/lib/program-tracks'

export async function GET() {
  try {
    await ensureCoreSeed()
    const rows = await db.program.findMany({
      where: { active: true },
      orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
      include: {
        units: { orderBy: { order: 'asc' }, select: { id: true, order: true, title: true } },
        books: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, titleEn: true, semester: true, source: true } },
        programExams: { orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }], select: { id: true, title: true, semester: true, status: true, _count: { select: { questions: true } } } },
      },
    })

    const programs = rows
      .filter((p) => !isGenericAllSpecializationsProgram(p))
      .sort((a, b) => {
        const ca = PROGRAM_CATEGORY_ORDER.indexOf(a.category)
        const cb = PROGRAM_CATEGORY_ORDER.indexOf(b.category)
        const oa = ca === -1 ? 999 : ca
        const ob = cb === -1 ? 999 : cb
        return oa - ob || a.order - b.order || a.titleAr.localeCompare(b.titleAr, 'ar')
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
        categoryLabel: PROGRAM_CATEGORY_AR[p.category] || p.category,
        specialty: programSpecialtyLabel(p),
        hours: p.hours,
        price: p.price,
        icon: p.icon,
        features: JSON.parse(p.features || '[]'),
        unitsCount: p.units.length,
        units: p.units,
        books: p.books,
        exams: p.programExams.map((e) => ({ id: e.id, title: e.title, semester: e.semester, status: e.status, questionCount: e._count.questions })),
        enrolled: enrolledProgramIds.includes(p.id),
        // قواعد قبول مخصصة يعرضها نموذج الالتحاق للمتقدم (شروط إضافية تضبطها الإدارة)
        admissionRules: p.admissionRules || null,
        // الملف الأكاديمي المخصص الذي تضبطه الإدارة لكل برنامج، إن وجد.
        academicProfile: academicProfileFromRules(p.admissionRules),
      })),
    })
  } catch (e) {
    console.error('Programs error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل البرامج' }, { status: 500 })
  }
}
