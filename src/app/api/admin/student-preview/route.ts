import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'

export const runtime = 'nodejs'

function clean(value: unknown, max = 200) {
  return String(value || '').trim().slice(0, max)
}

export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = clean(req.nextUrl.searchParams.get('programId'), 120)

    const programs = await db.program.findMany({
      where: { active: true },
      select: { id: true, titleAr: true, titleEn: true, category: true, academicReadinessStatus: true, registrationStatus: true },
      orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
    })

    const selectedProgramId = programId || programs[0]?.id
    if (!selectedProgramId) return NextResponse.json({ programs, preview: null })

    const program = await db.program.findUnique({
      where: { id: selectedProgramId },
      select: {
        id: true,
        titleAr: true,
        titleEn: true,
        category: true,
        description: true,
        semestersCount: true,
        academicReadinessStatus: true,
        registrationStatus: true,
        books: {
          select: { id: true, title: true, author: true, semester: true, fileName: true, storageProvider: true, fileUrl: true, size: true, createdAt: true },
          orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
          take: 80,
        },
        units: {
          select: { id: true, title: true, semester: true, order: true, summary: true, objectives: true },
          orderBy: [{ semester: 'asc' }, { order: 'asc' }],
          take: 80,
        },
        assignments: {
          where: { status: 'PUBLISHED' },
          select: { id: true, title: true, description: true, dueDate: true, semester: true, createdAt: true },
          orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
          take: 40,
        },
        programExams: {
          where: { status: 'READY' },
          select: { id: true, title: true, examType: true, semester: true, durationMinutes: true, _count: { select: { questions: true } } },
          orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
          take: 40,
        },
      },
    })

    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const [knowledgeItems, thesisTopics, readyUnitExams] = await Promise.all([
      db.bookKnowledgeItem.count({ where: { programId: selectedProgramId } }),
      db.thesisTopic.findMany({
        where: { programId: selectedProgramId, status: 'APPROVED' },
        select: { id: true, title: true, description: true, methodology: true, source: true },
        orderBy: [{ createdAt: 'desc' }],
        take: 40,
      }),
      db.unit.count({ where: { programId: selectedProgramId, exam: { isNot: null } } }),
    ])

    const preview = {
      program,
      counts: {
        books: program.books.length,
        units: program.units.length,
        knowledgeItems,
        publishedAssignments: program.assignments.length,
        readyProgramExams: program.programExams.length,
        unitExams: readyUnitExams,
        thesisTopics: thesisTopics.length,
      },
      thesisTopics,
      warnings: [
        program.books.length === 0 ? 'لا توجد كتب ظاهرة للطالب في هذا البرنامج.' : null,
        program.units.length === 0 ? 'لا توجد وحدات تعليمية ظاهرة للطالب.' : null,
        program.programExams.length + readyUnitExams === 0 ? 'لا توجد اختبارات جاهزة ظاهرة للطالب.' : null,
        thesisTopics.length === 0 ? 'لا توجد عناوين بحث تخرج معتمدة للطالب بعد.' : null,
        program.academicReadinessStatus !== 'APPROVED' ? 'البرنامج غير معتمد أكاديميًا بالكامل بعد.' : null,
        program.registrationStatus !== 'OPEN' ? 'التسجيل على البرنامج ليس مفتوحًا.' : null,
      ].filter(Boolean),
    }

    return NextResponse.json({ programs, preview })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('student preview GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل معاينة تجربة الطالب' }, { status: 500 })
  }
}
