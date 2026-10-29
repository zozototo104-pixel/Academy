import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canAccessProgram, requireSupervisor, supervisorProgramIds } from '@/lib/supervisor-scope'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// GET /api/supervisor/content — محتوى برامج المشرف قراءة كاملة:
// بلا programId: قائمة برامجه. مع programId: الكتب والوحدات وأسئلة
// بنك الوحدات والامتحانات الفصلية بأسئلتها — نفس ما تراه الإدارة.
export async function GET(req: NextRequest) {
  try {
    const actor = await requireSupervisor()
    const programId = String(req.nextUrl.searchParams.get('programId') || '').trim()

    if (!programId) {
      const ids = await supervisorProgramIds(actor)
      if (!ids.length) return NextResponse.json({ programs: [] })
      const programs = await db.program.findMany({
        where: { id: { in: ids } },
        orderBy: { titleAr: 'asc' },
        select: {
          id: true, titleAr: true, titleEn: true,
          _count: { select: { books: true, units: true, programExams: true } },
        },
      })
      return NextResponse.json({ programs })
    }

    if (!(await canAccessProgram(actor, programId))) {
      return NextResponse.json({ error: 'هذا البرنامج ليس ضمن برامجك' }, { status: 403 })
    }

    const program = await db.program.findUnique({
      where: { id: programId },
      select: {
        id: true, titleAr: true, titleEn: true,
        books: { orderBy: [{ semester: 'asc' }, { createdAt: 'asc' }], select: { id: true, title: true, semester: true, source: true } },
        units: {
          orderBy: [{ semester: 'asc' }, { order: 'asc' }],
          select: {
            id: true, title: true, order: true, semester: true, status: true, summary: true,
            exam: { select: { id: true, title: true, status: true, passScore: true, _count: { select: { questions: true } } } },
          },
        },
        programExams: {
          orderBy: [{ semester: 'asc' }, { createdAt: 'desc' }],
          select: {
            id: true, title: true, semester: true, status: true, passScore: true, durationMin: true, totalPoints: true, generatedBy: true,
            questions: {
              orderBy: { order: 'asc' },
              select: {
                id: true, order: true, type: true, text: true, options: true, correctAnswer: true, modelAnswer: true,
                rubric: true, points: true, status: true, difficulty: true, cognitiveSkill: true,
                sourceBookTitle: true, sourceChapter: true, correctRationale: true,
              },
            },
          },
        },
      },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })

    const unitIds = program.units.map((u) => u.id)
    const bankItems = unitIds.length
      ? await db.questionBankItem.findMany({
          where: { unitId: { in: unitIds } },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          select: {
            id: true, unitId: true, type: true, text: true, options: true, correctAnswer: true, modelAnswer: true,
            rubric: true, difficulty: true, status: true, generatedBy: true, sourceEvidence: true, sourceBookTitle: true, createdAt: true,
          },
        })
      : []

    const bankByUnit = new Map<string, typeof bankItems>()
    for (const item of bankItems) {
      if (!item.unitId) continue
      const list = bankByUnit.get(item.unitId) || []
      list.push(item)
      bankByUnit.set(item.unitId, list)
    }

    return NextResponse.json({
      program: {
        ...program,
        units: program.units.map((u) => ({ ...u, bankQuestions: bankByUnit.get(u.id) || [] })),
      },
    })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'هذه الصفحة مخصصة للمشرفين والإدارة' }, { status: 403 })
    console.error('supervisor content GET error:', e)
    return NextResponse.json({ error: 'تعذر تحميل المحتوى' }, { status: 500 })
  }
}
