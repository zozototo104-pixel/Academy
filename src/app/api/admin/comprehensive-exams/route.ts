import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { audit } from '@/lib/notify'
import { programSpecialtyLabel, PROGRAM_CATEGORY_AR } from '@/lib/program-tracks'
import { getServiceFlow, isCertificateEquivalencyFlow } from '@/lib/service-flows'

export const runtime = 'nodejs'

function cleanText(value: unknown, max = 200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function safePassScore(value: unknown) {
  const n = Number(value ?? 60)
  return Number.isFinite(n) ? Math.max(1, Math.min(100, Math.floor(n))) : 60
}

function safeDurationMin(value: unknown) {
  const n = Number(value ?? 120)
  return Number.isFinite(n) ? Math.max(10, Math.min(480, Math.floor(n))) : 120
}

// GET /api/admin/comprehensive-exams?programId= — قائمة امتحانات شاملة
export async function GET(req: NextRequest) {
  try {
    await requireAdmin()
    const programId = req.nextUrl.searchParams.get('programId') || undefined
    const exams = await db.comprehensiveExam.findMany({
      where: programId ? { programId } : {},
      orderBy: [{ updatedAt: 'desc' }],
      include: {
        program: { select: { id: true, titleAr: true, titleEn: true, slug: true, category: true } },
        specializationProgram: { select: { id: true, titleAr: true, titleEn: true, category: true } },
        _count: { select: { questions: true } },
      },
    })
    const withCounts = await Promise.all(
      exams.map(async (exam: any) => {
        const groups = await db.comprehensiveExamQuestion.groupBy({
          by: ['status'],
          where: { examId: exam.id },
          _count: { _all: true },
        })
        const counts = { approved: 0, pending: 0, rejected: 0 }
        for (const g of groups) {
          if (g.status === 'APPROVED') counts.approved = g._count._all
          if (g.status === 'PENDING_REVIEW') counts.pending = g._count._all
          if (g.status === 'REJECTED') counts.rejected = g._count._all
        }
        return {
          id: exam.id,
          programId: exam.programId,
          programTitleAr: exam.program.titleAr,
          programCategory: exam.program.category,
          specializationProgramId: exam.specializationProgramId || null,
          specializationTitleAr: exam.specializationProgram?.titleAr || null,
          specializationTitleEn: exam.specializationProgram?.titleEn || null,
          specializationCategory: exam.specializationProgram?.category || null,
          categoryLabel: PROGRAM_CATEGORY_AR[exam.specializationProgram?.category || exam.program.category] || exam.program.category,
          specialtyLabel: exam.specializationProgram
            ? programSpecialtyLabel({ titleAr: exam.specializationProgram.titleAr, category: exam.specializationProgram.category })
            : programSpecialtyLabel({ titleAr: exam.program.titleAr, category: exam.program.category }),
          level: exam.level,
          title: exam.title,
          status: exam.status,
          passScore: exam.passScore,
          durationMin: exam.durationMin,
          totalPoints: exam.totalPoints,
          publishedAt: exam.publishedAt,
          createdAt: exam.createdAt,
          updatedAt: exam.updatedAt,
          counts,
        }
      }),
    )
    return NextResponse.json({ ok: true, exams: withCounts })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('comprehensive exams list error:', e)
    return NextResponse.json({ error: 'تعذر تحميل الامتحانات الشاملة' }, { status: 500 })
  }
}

// POST /api/admin/comprehensive-exams — إنشاء مسودة امتحان شامل لبرنامج
// المعادلة + تخصص منظم. الامتحان لا ينشأ إلا على برنامج خدمة المعادلة
// (نوع مساره CERTIFICATE_EQUIVALENCY)، والتخصص برنامج دراسة نشط مختلف عنه.
export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json()
    const programId = cleanText(body?.programId, 80)
    if (!programId) return NextResponse.json({ error: 'معرف البرنامج مطلوب' }, { status: 400 })
    const specializationProgramId = cleanText(body?.specializationProgramId, 80)
    if (!specializationProgramId) return NextResponse.json({ error: 'اختر التخصص أولاً — الامتحان الشامل يُبنى لتخصص محدد داخل برنامج المعادلة' }, { status: 400 })
    if (specializationProgramId === programId) {
      return NextResponse.json({ error: 'التخصص يجب أن يكون برنامج دراسة مختلفاً عن برنامج المعادلة نفسه' }, { status: 400 })
    }
    const program = await db.program.findUnique({
      where: { id: programId },
      select: { id: true, titleAr: true, slug: true, category: true, active: true },
    })
    if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
    if (!program.active) return NextResponse.json({ error: 'البرنامج غير نشط' }, { status: 400 })
    if (!isCertificateEquivalencyFlow(getServiceFlow(program.slug))) {
      return NextResponse.json(
        { error: 'هذا البرنامج ليس برنامج المعادلة — الامتحان الشامل يُنشأ فقط على برنامج خدمة المعادلة' },
        { status: 409 },
      )
    }
    const specialization = await db.program.findUnique({
      where: { id: specializationProgramId },
      select: { id: true, titleAr: true, titleEn: true, category: true, active: true },
    })
    if (!specialization) return NextResponse.json({ error: 'برنامج التخصص غير موجود' }, { status: 404 })
    if (!specialization.active) return NextResponse.json({ error: 'برنامج التخصص غير نشط' }, { status: 400 })
    if (specialization.category === 'SERVICE') {
      return NextResponse.json({ error: 'التخصص يجب أن يكون برنامج دراسة — لا خدمة مهنية' }, { status: 400 })
    }
    const passScore = safePassScore(body?.passScore)
    const durationMin = safeDurationMin(body?.durationMin)
    // The live-exam predicate and creation must share one serializable
    // transaction: two admins/tabs must not create parallel DRAFT exams.
    const result = await db.$transaction(async (tx) => {
      const live = await tx.comprehensiveExam.findFirst({
        where: { programId, specializationProgramId, status: { in: ['DRAFT', 'READY'] } },
        select: { id: true, status: true },
      })
      if (live) return { live, exam: null }
      const exam = await tx.comprehensiveExam.create({
        data: {
          programId,
          specializationProgramId,
          level: specialization.category,
          title: `امتحان شامل — ${specialization.titleAr}`,
          status: 'DRAFT',
          passScore,
          durationMin,
          createdById: admin.id,
        },
      })
      return { live: null, exam }
    }, { isolationLevel: 'Serializable' })
    if (result.live) {
      return NextResponse.json(
        { error: 'يوجد امتحان شامل حي لهذا التخصص بالفعل — أكمل تجهيزه أو أرشفه قبل إنشاء واحد جديد', examId: result.live.id },
        { status: 409 },
      )
    }
    const exam = result.exam!
    await audit(
      { id: admin.id, name: admin.name },
      'CREATE_COMPREHENSIVE_EXAM',
      'ComprehensiveExam',
      exam.id,
      `إنشاء مسودة امتحان شامل لبرنامج المعادلة «${program.titleAr}» — التخصص ${specialization.titleAr} — علامة النجاح ${passScore}%، المدة ${durationMin} دقيقة`,
    )
    return NextResponse.json({ ok: true, examId: exam.id, status: exam.status }, { status: 201 })
  } catch (e: any) {
    if (e?.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    if (e?.code === 'P2034') return NextResponse.json({ error: 'تم إنشاء امتحان حي بالتزامن — حدّث القائمة', code: 'LIVE_EXAM_CONFLICT' }, { status: 409 })
    console.error('comprehensive exam create error:', e)
    return NextResponse.json({ error: 'تعذر إنشاء الامتحان الشامل' }, { status: 500 })
  }
}
