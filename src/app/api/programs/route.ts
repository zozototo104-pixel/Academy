import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { getCurrentUser } from '@/lib/auth'
import { ensureCoreSeed } from '@/lib/bootstrap'
import { academicProfileFromRules, isGenericAllSpecializationsProgram, PROGRAM_CATEGORY_ORDER, PROGRAM_CATEGORY_AR, programSpecialtyLabel } from '@/lib/program-tracks'

export async function GET(req: NextRequest) {
  try {
    const summaryOnly = req.nextUrl.searchParams.get('summary') === '1'
    if (!summaryOnly) await ensureCoreSeed()

    const rows: any[] = summaryOnly
      ? await db.program.findMany({
          where: { active: true },
          orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
          select: {
            id: true,
            slug: true,
            titleAr: true,
            titleEn: true,
            description: true,
            category: true,
            hours: true,
            price: true,
            icon: true,
            features: true,
            order: true,
            active: true,
            admissionRules: true,
            _count: { select: { units: true } },
          },
        })
      : await db.program.findMany({
          where: { active: true },
          orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
          include: {
            units: { orderBy: { order: 'asc' }, select: { id: true, order: true, title: true } },
            books: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, titleEn: true, semester: true, source: true } },
            assignments: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true, points: true, status: true } },
            studyGuides: { where: { status: 'PUBLISHED' }, orderBy: [{ semester: 'asc' }, { updatedAt: 'desc' }], select: { id: true, title: true, semester: true, overview: true } },
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
      programs: programs.map((p) => {
        const row = p as any
        const units = Array.isArray(row.units) ? row.units : []
        const books = Array.isArray(row.books) ? row.books : []
        const assignments = Array.isArray(row.assignments) ? row.assignments : []
        const studyGuides = Array.isArray(row.studyGuides) ? row.studyGuides : []
        const programExams = Array.isArray(row.programExams) ? row.programExams : []
        return {
          id: row.id,
          slug: row.slug,
          titleAr: row.titleAr,
          titleEn: row.titleEn,
          description: row.description,
          category: row.category,
          categoryLabel: PROGRAM_CATEGORY_AR[row.category] || row.category,
          specialty: programSpecialtyLabel(row),
          hours: row.hours,
          price: row.price,
          icon: row.icon,
          features: JSON.parse(row.features || '[]'),
          unitsCount: summaryOnly ? Number(row._count?.units || 0) : units.length,
          units,
          books,
          assignments,
          studyGuides,
          exams: programExams.map((e: any) => ({ id: e.id, title: e.title, semester: e.semester, status: e.status, questionCount: e._count?.questions || 0 })),
          enrolled: enrolledProgramIds.includes(row.id),
          // قواعد قبول مخصصة يعرضها نموذج الالتحاق للمتقدم (شروط إضافية تضبطها الإدارة)
          admissionRules: row.admissionRules || null,
          // الملف الأكاديمي المخصص الذي تضبطه الإدارة لكل برنامج، إن وجد.
          academicProfile: academicProfileFromRules(row.admissionRules),
        }
      }),
    })
  } catch (e) {
    console.error('Programs error:', e)
    return NextResponse.json({ error: 'خطأ في تحميل البرامج' }, { status: 500 })
  }
}
