import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdmin } from '@/lib/auth'
import { enforceApiRateLimit } from '@/lib/rate-limit'
import { audit } from '@/lib/notify'
import { advanceProgramExamFromVerifiedBank, PROGRAM_EXAM_TARGET } from '@/lib/program-exam-assembly'

export const runtime = 'nodejs'
export const maxDuration = 300

function clean(value: unknown, max = 120) {
  return String(value || '').trim().slice(0, max)
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin()
    const body = await req.json().catch(() => ({}))
    const programId = clean(body.programId, 80)
    const examId = clean(body.examId, 80)
    const action = clean(body.action || (examId ? 'resume' : 'start'), 20)
    // Automated admin-page continuation is deliberately faster than manual starts.
    const limited = enforceApiRateLimit(req, action === 'kick' ? 'admin-program-exam-kick' : 'admin-program-exam-generate', action === 'kick' ? 40 : 8, 60_000, admin.id)
    if (limited) return limited
    if (!['start', 'resume', 'kick', 'stop', 'rebuild'].includes(action)) return NextResponse.json({ error: 'إجراء غير مدعوم' }, { status: 400 })
    if (!programId && !examId) return NextResponse.json({ error: 'معرف البرنامج أو الامتحان مطلوب' }, { status: 400 })

    const existing = examId ? await db.programExam.findUnique({ where: { id: examId }, include: { _count: { select: { attempts: true, questions: true } } } }) : null
    if (examId && !existing) return NextResponse.json({ error: 'الامتحان غير موجود' }, { status: 404 })
    if (existing && programId && existing.programId !== programId) return NextResponse.json({ error: 'الامتحان لا ينتمي إلى هذا البرنامج' }, { status: 409 })
    if (existing && (existing.status === 'READY' || existing._count.attempts > 0)) return NextResponse.json({ error: 'لا يمكن تعديل امتحان منشور أو له محاولات طلابية' }, { status: 409 })

    if (action === 'stop') {
      if (!existing) return NextResponse.json({ error: 'معرف الامتحان مطلوب للإيقاف' }, { status: 400 })
      const updated = await db.programExam.updateMany({ where: { id: existing.id, status: 'GENERATING' }, data: { status: 'PAUSED', errorNote: 'أوقف المسؤول توليد الأسئلة؛ يمكن الاستكمال لاحقًا دون حذفها.' } })
      const questionCount = await db.programQuestion.count({ where: { examId: existing.id, status: { not: 'REJECTED' } } })
      return NextResponse.json({ ok: true, examId: existing.id, status: updated.count ? 'PAUSED' : existing.status, questionCount, requiredQuestions: PROGRAM_EXAM_TARGET })
    }
    if (action === 'rebuild') {
      // Rebuild used to delete reviewed questions; preserving them is safer and intentional.
      return NextResponse.json({ ok: false, error: 'إعادة البناء الحذفية غير متاحة حفاظًا على الأسئلة والمراجعات الحالية. استخدم استكمال التوليد لإضافة الأسئلة الناقصة.' }, { status: 409 })
    }

    let exam = existing
    let resumed = Boolean(exam)
    let unitsForExam: Array<{ id: string; title: string; semester: number; order: number }> = []
    if (!exam) {
      const comprehensive = body.comprehensive === true || body.semester === 0 || body.semester === 'all'
      const semester = comprehensive ? 3 : Number(body.semester) === 2 ? 2 : 1
      const previous = await db.programExam.findFirst({ where: { programId, semester, generatedBy: 'AI', status: { in: ['GENERATING', 'PAUSED', 'FAILED'] } }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { attempts: true, questions: true } } } })
      if (previous && previous._count.attempts === 0) {
        exam = previous
        resumed = true
      } else {
        const program = await db.program.findUnique({ where: { id: programId }, select: { titleAr: true } })
        if (!program) return NextResponse.json({ error: 'البرنامج غير موجود' }, { status: 404 })
        unitsForExam = await db.unit.findMany({
          where: { programId, ...(comprehensive ? {} : { semester }) },
          orderBy: [{ semester: 'asc' }, { order: 'asc' }],
          select: { id: true, title: true, semester: true, order: true },
        })
        if (!unitsForExam.length) return NextResponse.json({ error: 'لا توجد وحدات مقررة لهذا الامتحان. أكمل الكتب والوحدات وبنك المعرفة أولًا.' }, { status: 400 })
        exam = await db.programExam.create({ data: { programId, semester, title: `${comprehensive ? 'الامتحان الشامل' : semester === 2 ? 'امتحان الفصل الثاني' : 'امتحان الفصل الأول'} — ${program.titleAr || ''}`, status: 'GENERATING', generatedBy: 'AI', durationMin: 120 } }) as typeof previous
      }
    }
    if (!exam) return NextResponse.json({ error: 'تعذر تحديد الامتحان' }, { status: 500 })
    if (!unitsForExam.length) {
      unitsForExam = await db.unit.findMany({
        where: { programId: exam.programId, ...(exam.semester === 3 ? {} : { semester: exam.semester }) },
        orderBy: [{ semester: 'asc' }, { order: 'asc' }],
        select: { id: true, title: true, semester: true, order: true },
      })
      if (!unitsForExam.length) return NextResponse.json({ error: 'لا توجد وحدات مقررة لهذا الامتحان. أكمل الكتب والوحدات وبنك المعرفة أولًا.' }, { status: 400 })
    }
    const unitBreakdown = unitsForExam.map((unit) => ({ unitId: unit.id, title: unit.title, semester: unit.semester, order: unit.order }))
    if (exam.status === 'REVIEW') {
      const count = await db.programQuestion.count({ where: { examId: exam.id, status: { not: 'REJECTED' } } })
      if (count >= PROGRAM_EXAM_TARGET) return NextResponse.json({ ok: true, done: true, examId: exam.id, status: 'REVIEW', questionCount: count, requiredQuestions: PROGRAM_EXAM_TARGET, resumed })
    }
    if (exam.status !== 'GENERATING') await db.programExam.update({ where: { id: exam.id }, data: { status: 'GENERATING', errorNote: null } })
    const result = await advanceProgramExamFromVerifiedBank(exam.id, { manual: action !== 'kick' })
    await audit({ id: admin.id, name: admin.name }, resumed ? 'RESUME_PROGRAM_EXAM_FROM_VERIFIED_BANK' : 'GENERATE_PROGRAM_EXAM_FROM_VERIFIED_BANK', 'ProgramExam', exam.id, `استكمال تراكمي من بنك المعرفة V2: ${result.questionCount}/${PROGRAM_EXAM_TARGET}`)
    return NextResponse.json({ ...result, resumed, existingQuestions: result.questionCount - result.inserted, booksCount: null })
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') return NextResponse.json({ error: 'صلاحيات الإدارة مطلوبة' }, { status: 401 })
    console.error('program-exam verified generation error:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'تعذر استكمال الامتحان' }, { status: 500 })
  }
}
