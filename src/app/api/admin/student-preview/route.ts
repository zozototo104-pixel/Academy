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
      select: {
        id: true,
        titleAr: true,
        titleEn: true,
        category: true,
        academicReadinessStatus: true,
        registrationStatus: true,
      },
      orderBy: [{ category: 'asc' }, { order: 'asc' }, { titleAr: 'asc' }],
    })

    const selectedProgramId = programId || programs[0]?.id
    if (!selectedProgramId) return NextResponse.json({ programs, preview: null })

    const programCore = await db.program.findUnique({
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
      },
    })

    if (!programCore) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const [books, units, assignments, programExams, knowledgeItems, thesisTopics, readyUnitExams] = await Promise.all([
      db.book.findMany({
        where: { programId: selectedProgramId },
        select: { id: true, title: true, author: true, semester: true, fileName: true, storageProvider: true, fileUrl: true, size: true, createdAt: true },
        orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }],
        take: 80,
      }),
      db.unit.findMany({
        where: { programId: selectedProgramId },
        select: { id: true, title: true, semester: true, order: true, summary: true, objectives: true },
        orderBy: [{ semester: 'asc' }, { order: 'asc' }],
        take: 80,
      }),
      db.programAssignment.findMany({
        where: { programId: selectedProgramId, status: 'PUBLISHED' },
        select: { id: true, title: true, description: true, dueDays: true, semester: true, createdAt: true },
        orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
        take: 40,
      }),
      db.programExam.findMany({
        where: { programId: selectedProgramId, status: 'READY' },
        select: { id: true, title: true, status: true, semester: true, durationMin: true, _count: { select: { questions: true } } },
        orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
        take: 40,
      }),
      db.bookKnowledgeItem.count({ where: { programId: selectedProgramId } }),
      db.thesisTopic.findMany({
        where: { programId: selectedProgramId, status: 'APPROVED' },
        select: { id: true, title: true, description: true, methodology: true, source: true },
        orderBy: [{ createdAt: 'desc' }],
        take: 40,
      }),
      db.unit.count({ where: { programId: selectedProgramId, exam: { isNot: null } } }),
    ])

    const program = {
      ...programCore,
      books,
      units,
      assignments,
      programExams,
    }

    const preview = {
      program,
      counts: {
        books: books.length,
        units: units.length,
        knowledgeItems,
        publishedAssignments: assignments.length,
        readyProgramExams: programExams.length,
        unitExams: readyUnitExams,
        thesisTopics: thesisTopics.length,
      },
      thesisTopics,
      warnings: [
        books.length === 0 ? 'لا توجد كتب ظاهرة للطالب في هذا البرنامج.' : null,
        units.length === 0 ? 'لا توجد وحدات تعليمية ظاهرة للطالب.' : null,
        programExams.length + readyUnitExams === 0 ? 'لا توجد اختبارات جاهزة ظاهرة للطالب.' : null,
        thesisTopics.length === 0 ? 'لا توجد عناوين بحث تخرج معتمدة للطالب بعد.' : null,
        programCore.academicReadinessStatus !== 'APPROVED' ? 'البرنامج غير معتمد أكاديميًا بالكامل بعد.' : null,
        programCore.registrationStatus !== 'OPEN' ? 'التسجيل على البرنامج ليس مفتوحًا.' : null,
      ].filter(Boolean),
    }

    return NextResponse.json({ programs, preview })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('student preview GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل معاينة تجربة الطالب' }, { status: 500 })
  }
}
